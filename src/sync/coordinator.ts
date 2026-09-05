// 同步协调器（Durable Object，单例 "primary"）。
//
// 它是系统里唯一持有 OAuth token、唯一写 KV 的角色：
//   - refresh token 会轮换且服务端检测重用（refresh_token_reused → 永久失效）。
//     刷新只在这里做（auth.openai.com 从 Workers 可达），拿到新 token **先写存储**
//     再做别的；DO 单线程 + 事务存储保证不会并发刷新。refresh token 永远不出 DO。
//   - 目录拉取有两种模式（wrangler var `SYNC_MODE`）：
//       "worker"   — DO 自己拉 chatgpt.com（Phase 0 探针：Workers 出口被 403，暂不可用）；
//       "external" — 外部 agent（GitHub Actions / 任意能到 chatgpt.com 的机器）先
//                    `lease()` 租一个短命 access token，拉完 `ingest()` 推回来发布。
//     两种模式共用校验 / 规范化 / 发布逻辑。
//   - token 用 KEK（Workers Secret）AES-GCM 加密后存 DO storage；KV 里只有目录。
//
// KV 键：
//   codex:current          最近一次成功的官方信封（规范化 JSON 文本）
//   codex:meta             CodexMeta（JSON）
//   codex:snapshot:<hash>  历史快照（TTL 180 天）
//   codex:snapshots:index  最近 50 份快照索引
//   codex:changes          变更事件（新在前，≤500）

import { DurableObject } from "cloudflare:workers";
import { importKek, open, seal } from "./crypto";
import {
  canonicalCatalogText,
  catalogHash,
  diffCatalogs,
  fetchOfficialCatalog,
  validateCatalog,
  type CatalogModel,
  type ChangeEvent,
  type FetchedCatalog,
} from "./catalog";
import { latestCodexClientVersion } from "./npm";
import { jwtExpSeconds, planLabelFromIdToken, refreshAccessToken } from "./oauth";

export const KV_CURRENT = "codex:current";
export const KV_META = "codex:meta";
export const KV_CHANGES = "codex:changes";
export const KV_SNAPSHOTS_INDEX = "codex:snapshots:index";
export const kvSnapshotKey = (hash: string): string => `codex:snapshot:${hash}`;

const SNAPSHOT_TTL_SECONDS = 180 * 24 * 60 * 60;
const SNAPSHOT_INDEX_LIMIT = 50;
const CHANGES_LIMIT = 500;
const RUNS_LIMIT = 500;
/// access token 剩余有效期低于此值才刷新（少轮换 = 少一次 reuse 风险）。
const REFRESH_WINDOW_SECONDS = 15 * 60;
/// 外部 agent 的租约时长：拉一次目录足够；过期后别的 agent 才能再租。
const LEASE_TTL_MS = 10 * 60 * 1000;

interface StoredAuth {
  refresh_ct: string;
  access_ct: string | null;
  access_exp: number | null;
  account_id: string | null;
  plan_label: string | null;
  last_refresh_at: string | null;
  seeded_at: string;
}

interface PermanentFailure {
  at: string;
  reason: string;
}

interface Lease {
  id: string;
  agent: string;
  at: string;
  expires_at: number;
}

export type RunReason = "cron" | "manual" | "external";

export interface LastRun {
  at: string;
  reason: RunReason;
  status: "ok" | "unchanged" | "error" | "skipped";
  error: string | null;
  duration_ms: number;
}

export interface CodexMeta {
  fetched_at: string;
  checked_at: string;
  upstream_etag: string | null;
  etag: string;
  content_hash: string;
  client_version: string;
  source: { plan_label: string | null; account_fp: string | null; agent: string | null };
  model_count: number;
  listed_slugs: string[];
  last_run: LastRun | null;
  snapshot_id: string;
}

export interface SyncStatus {
  sync_mode: string;
  seeded: boolean;
  account_fp: string | null;
  plan_label: string | null;
  last_refresh_at: string | null;
  access_expires_at: string | null;
  permanent_failure: PermanentFailure | null;
  lease: { agent: string; at: string; expires_at: string } | null;
  current_hash: string | null;
  last_run: LastRun | null;
  recent_runs: Array<{
    at: string;
    reason: string;
    status: string;
    error: string | null;
    hash: string | null;
    client_version: string | null;
    duration_ms: number;
  }>;
}

export interface SeedInput {
  refresh_token: string;
  access_token?: string;
  id_token?: string;
  account_id?: string;
}

export type SyncResult =
  | { status: "ok"; hash: string; model_count: number; changes: number; client_version: string }
  | { status: "unchanged"; hash: string; client_version: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string; permanent: boolean };

export type LeaseResult =
  | {
      ok: true;
      lease_id: string;
      access_token: string;
      account_id: string | null;
      client_version_hint: string | null;
      expires_at: string;
    }
  | { ok: false; reason: string; permanent: boolean };

export interface IngestInput {
  lease_id: string;
  client_version: string;
  status: number;
  etag: string | null;
  body: string;
}

export class SyncCoordinator extends DurableObject<Env> {
  private running: Promise<SyncResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          hash TEXT,
          client_version TEXT,
          duration_ms INTEGER NOT NULL
        )
      `);
    });
  }

  // ------------------------------------------------------------------
  // bootstrap / 状态
  // ------------------------------------------------------------------

  /// 写入专用账号的 token（来自一次性 `codex login` 的 auth.json）。
  async seed(
    input: SeedInput,
  ): Promise<{ ok: true; account_fp: string | null; plan_label: string | null }> {
    if (typeof input.refresh_token !== "string" || input.refresh_token.trim().length === 0) {
      throw new Error("refresh_token is required");
    }
    const kek = await importKek(this.env.REFRESH_TOKEN_KEK);
    const accessToken = typeof input.access_token === "string" ? input.access_token : null;
    const auth: StoredAuth = {
      refresh_ct: await seal(kek, input.refresh_token.trim()),
      access_ct: accessToken ? await seal(kek, accessToken) : null,
      access_exp: accessToken ? jwtExpSeconds(accessToken) : null,
      account_id:
        typeof input.account_id === "string" && input.account_id ? input.account_id : null,
      plan_label: planLabelFromIdToken(typeof input.id_token === "string" ? input.id_token : null),
      last_refresh_at: null,
      seeded_at: new Date().toISOString(),
    };
    await this.ctx.storage.put("auth", auth);
    await this.ctx.storage.delete("permanent_failure");
    await this.ctx.storage.delete("lease");
    return {
      ok: true,
      account_fp: accountFingerprint(auth.account_id),
      plan_label: auth.plan_label,
    };
  }

  async status(): Promise<SyncStatus> {
    const auth = await this.ctx.storage.get<StoredAuth>("auth");
    const failure = (await this.ctx.storage.get<PermanentFailure>("permanent_failure")) ?? null;
    const lease = await this.activeLease();
    const meta = await this.readMeta();
    const rows = this.ctx.storage.sql
      .exec<{
        at: string;
        reason: string;
        status: string;
        error: string | null;
        hash: string | null;
        client_version: string | null;
        duration_ms: number;
      }>(
        "SELECT at, reason, status, error, hash, client_version, duration_ms FROM runs ORDER BY id DESC LIMIT 20",
      )
      .toArray();
    return {
      sync_mode: this.syncMode(),
      seeded: auth !== undefined,
      account_fp: accountFingerprint(auth?.account_id ?? null),
      plan_label: auth?.plan_label ?? null,
      last_refresh_at: auth?.last_refresh_at ?? null,
      access_expires_at: auth?.access_exp ? new Date(auth.access_exp * 1000).toISOString() : null,
      permanent_failure: failure,
      lease: lease
        ? { agent: lease.agent, at: lease.at, expires_at: new Date(lease.expires_at).toISOString() }
        : null,
      current_hash: meta?.content_hash ?? null,
      last_run: meta?.last_run ?? null,
      recent_runs: rows,
    };
  }

  // ------------------------------------------------------------------
  // 模式 A：DO 自己拉（SYNC_MODE=worker）
  // ------------------------------------------------------------------

  async runSync(reason: "cron" | "manual"): Promise<SyncResult> {
    if (this.syncMode() !== "worker") {
      return {
        status: "skipped",
        reason: `SYNC_MODE=${this.syncMode()} (catalog fetched by external agent)`,
      };
    }
    // 同一 DO 内串行：并发触发只等同一次运行。
    if (this.running) return this.running;
    this.running = this.runSyncInner(reason).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSyncInner(reason: "cron" | "manual"): Promise<SyncResult> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const gate = await this.gate(at, reason, started);
    if ("skip" in gate) return gate.skip;

    const token = await this.ensureAccessToken(at);
    if (!token.ok) {
      await this.record(at, reason, "error", `refresh: ${token.reason}`, null, null, started);
      return { status: "error", reason: `refresh: ${token.reason}`, permanent: token.permanent };
    }

    const previousMeta = await this.readMeta();
    const clientVersion =
      (await latestCodexClientVersion()) ?? previousMeta?.client_version ?? null;
    if (!clientVersion) {
      await this.record(at, reason, "error", "client_version unavailable", null, null, started);
      return { status: "error", reason: "client_version unavailable", permanent: false };
    }

    let fetched: FetchedCatalog;
    try {
      fetched = await fetchOfficialCatalog({
        accessToken: token.accessToken,
        accountId: token.accountId,
        clientVersion,
      });
    } catch (error) {
      await this.record(
        at,
        reason,
        "error",
        `fetch: ${String(error)}`,
        null,
        clientVersion,
        started,
      );
      return { status: "error", reason: `fetch: ${String(error)}`, permanent: false };
    }
    return this.publish(fetched, clientVersion, at, reason, "worker", started);
  }

  // ------------------------------------------------------------------
  // 模式 B：外部 agent（SYNC_MODE=external）
  // ------------------------------------------------------------------

  /// 外部 agent 租一个短命 access token（10 分钟租约，同一时间只允许一个 agent）。
  /// 刷新仍在 DO 内完成，refresh token 不出去。
  async lease(input: { agent: string }): Promise<LeaseResult> {
    const agent =
      typeof input.agent === "string" && input.agent.trim() ? input.agent.trim() : "unknown";
    const now = Date.now();
    const at = new Date(now).toISOString();
    const failure = await this.ctx.storage.get<PermanentFailure>("permanent_failure");
    if (failure) {
      return {
        ok: false,
        permanent: true,
        reason: `permanent_failure since ${failure.at}: ${failure.reason}`,
      };
    }
    const existing = await this.activeLease();
    if (existing) {
      return {
        ok: false,
        permanent: false,
        reason: `lease held by ${existing.agent} until ${new Date(existing.expires_at).toISOString()}`,
      };
    }
    const token = await this.ensureAccessToken(at);
    if (!token.ok) {
      await this.record(at, "external", "error", `refresh: ${token.reason}`, null, null, now);
      return { ok: false, permanent: token.permanent, reason: `refresh: ${token.reason}` };
    }
    const lease: Lease = { id: crypto.randomUUID(), agent, at, expires_at: now + LEASE_TTL_MS };
    await this.ctx.storage.put("lease", lease);
    const meta = await this.readMeta();
    return {
      ok: true,
      lease_id: lease.id,
      access_token: token.accessToken,
      account_id: token.accountId,
      client_version_hint: meta?.client_version ?? null,
      expires_at: new Date(lease.expires_at).toISOString(),
    };
  }

  /// 外部 agent 推回拉取结果；校验、规范化、发布，并释放租约。
  async ingest(input: IngestInput): Promise<SyncResult> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const lease = await this.activeLease();
    if (!lease || lease.id !== input.lease_id) {
      return { status: "error", reason: "invalid or expired lease", permanent: false };
    }
    await this.ctx.storage.delete("lease");
    if (typeof input.client_version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.client_version)) {
      await this.record(at, "external", "error", "ingest: bad client_version", null, null, started);
      return { status: "error", reason: "ingest: bad client_version", permanent: false };
    }
    const fetched: FetchedCatalog = {
      status: Number(input.status),
      etag: typeof input.etag === "string" && input.etag ? input.etag : null,
      text: typeof input.body === "string" ? input.body : "",
    };
    return this.publish(fetched, input.client_version, at, "external", lease.agent, started);
  }

  /// 外部 agent 拉取失败：释放租约并记录原因。
  async release(input: { lease_id: string; error: string }): Promise<{ ok: boolean }> {
    const lease = await this.activeLease();
    if (!lease || lease.id !== input.lease_id) return { ok: false };
    await this.ctx.storage.delete("lease");
    const now = Date.now();
    await this.record(
      new Date(now).toISOString(),
      "external",
      "error",
      `agent ${lease.agent}: ${String(input.error).slice(0, 500)}`,
      null,
      null,
      now,
    );
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // 共用：凭据、发布、记录
  // ------------------------------------------------------------------

  private syncMode(): string {
    const mode = this.env.SYNC_MODE;
    return typeof mode === "string" && mode.trim() ? mode.trim() : "external";
  }

  private async gate(
    at: string,
    reason: RunReason,
    started: number,
  ): Promise<{ skip: SyncResult } | { ok: true }> {
    const failure = await this.ctx.storage.get<PermanentFailure>("permanent_failure");
    if (failure) {
      await this.record(
        at,
        reason,
        "skipped",
        `permanent_failure since ${failure.at}: ${failure.reason}`,
        null,
        null,
        started,
      );
      return { skip: { status: "skipped", reason: `permanent_failure: ${failure.reason}` } };
    }
    if (!(await this.ctx.storage.get<StoredAuth>("auth"))) {
      await this.record(at, reason, "skipped", "not seeded", null, null, started);
      return { skip: { status: "skipped", reason: "not seeded" } };
    }
    return { ok: true };
  }

  /// 取可用的 access token：临过期才刷新；新 refresh token 先落盘再返回。
  private async ensureAccessToken(
    at: string,
  ): Promise<
    | { ok: true; accessToken: string; accountId: string | null }
    | { ok: false; reason: string; permanent: boolean }
  > {
    const auth = await this.ctx.storage.get<StoredAuth>("auth");
    if (!auth) return { ok: false, reason: "not seeded", permanent: false };
    const kek = await importKek(this.env.REFRESH_TOKEN_KEK);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const current = auth.access_ct ? await open(kek, auth.access_ct) : null;
    const fresh =
      current !== null &&
      auth.access_exp !== null &&
      auth.access_exp - nowSeconds >= REFRESH_WINDOW_SECONDS;
    if (fresh) return { ok: true, accessToken: current, accountId: auth.account_id };

    const outcome = await refreshAccessToken(await open(kek, auth.refresh_ct));
    if (!outcome.ok) {
      if (outcome.permanent) {
        await this.ctx.storage.put("permanent_failure", {
          at,
          reason: outcome.reason,
        } satisfies PermanentFailure);
      }
      return { ok: false, reason: outcome.reason, permanent: outcome.permanent };
    }
    const updated: StoredAuth = {
      ...auth,
      refresh_ct: outcome.refreshToken ? await seal(kek, outcome.refreshToken) : auth.refresh_ct,
      access_ct: await seal(kek, outcome.accessToken),
      access_exp: jwtExpSeconds(outcome.accessToken),
      plan_label: planLabelFromIdToken(outcome.idToken) ?? auth.plan_label,
      last_refresh_at: at,
    };
    await this.ctx.storage.put("auth", updated);
    return { ok: true, accessToken: outcome.accessToken, accountId: updated.account_id };
  }

  private async publish(
    fetched: FetchedCatalog,
    clientVersion: string,
    at: string,
    reason: RunReason,
    agent: string | null,
    started: number,
  ): Promise<SyncResult> {
    if (fetched.status < 200 || fetched.status >= 300) {
      const detail = `catalog HTTP ${fetched.status}`;
      await this.record(at, reason, "error", detail, null, clientVersion, started);
      return { status: "error", reason: detail, permanent: false };
    }
    const validated = validateCatalog(fetched.text);
    if (!validated.ok) {
      const detail = `invalid catalog: ${validated.error}`;
      await this.record(at, reason, "error", detail, null, clientVersion, started);
      return { status: "error", reason: detail, permanent: false };
    }

    const canonical = canonicalCatalogText(validated.models);
    const hash = await catalogHash(canonical);
    const etag = fetched.etag ?? `"sha256-${hash.slice(0, 32)}"`;
    const previousMeta = await this.readMeta();
    const auth = await this.ctx.storage.get<StoredAuth>("auth");

    if (previousMeta && previousMeta.content_hash === hash) {
      const meta: CodexMeta = {
        ...previousMeta,
        checked_at: at,
        client_version: clientVersion,
        etag,
      };
      await this.env.MODELDEX_KV.put(KV_META, JSON.stringify(meta));
      await this.record(at, reason, "unchanged", null, hash, clientVersion, started);
      return { status: "unchanged", hash, client_version: clientVersion };
    }

    const previousModels = await this.readCurrentModels();
    const previousChanges = (await this.readJson<ChangeEvent[]>(KV_CHANGES)) ?? [];
    const events = diffCatalogs(previousModels, validated.models, {
      at,
      fromHash: previousMeta?.content_hash ?? null,
      toHash: hash,
      clientVersion,
      seqStart: (previousChanges[0]?.seq ?? 0) + 1,
    });
    const changes = [...events].reverse().concat(previousChanges).slice(0, CHANGES_LIMIT);
    const index = [
      { hash, fetched_at: at, client_version: clientVersion, model_count: validated.models.length },
      ...((await this.readJson<Array<Record<string, unknown>>>(KV_SNAPSHOTS_INDEX)) ?? []).filter(
        (entry) => entry["hash"] !== hash,
      ),
    ].slice(0, SNAPSHOT_INDEX_LIMIT);
    const meta: CodexMeta = {
      fetched_at: at,
      checked_at: at,
      upstream_etag: fetched.etag,
      etag,
      content_hash: hash,
      client_version: clientVersion,
      source: {
        plan_label: auth?.plan_label ?? null,
        account_fp: accountFingerprint(auth?.account_id ?? null),
        agent,
      },
      model_count: validated.models.length,
      listed_slugs: validated.models.filter((m) => m["visibility"] === "list").map((m) => m.slug),
      last_run: null,
      snapshot_id: hash,
    };

    await this.env.MODELDEX_KV.put(kvSnapshotKey(hash), canonical, {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    });
    await this.env.MODELDEX_KV.put(KV_CURRENT, canonical);
    await this.env.MODELDEX_KV.put(KV_CHANGES, JSON.stringify(changes));
    await this.env.MODELDEX_KV.put(KV_SNAPSHOTS_INDEX, JSON.stringify(index));
    await this.env.MODELDEX_KV.put(KV_META, JSON.stringify(meta));
    await this.record(at, reason, "ok", null, hash, clientVersion, started);
    return {
      status: "ok",
      hash,
      model_count: validated.models.length,
      changes: events.length,
      client_version: clientVersion,
    };
  }

  private async record(
    at: string,
    reason: RunReason,
    status: LastRun["status"],
    error: string | null,
    hash: string | null,
    clientVersion: string | null,
    started: number,
  ): Promise<void> {
    const duration = Date.now() - started;
    this.ctx.storage.sql.exec(
      "INSERT INTO runs (at, reason, status, error, hash, client_version, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      at,
      reason,
      status,
      error,
      hash,
      clientVersion,
      duration,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ${RUNS_LIMIT})`,
    );
    const meta = await this.readMeta();
    if (meta) {
      const lastRun: LastRun = { at, reason, status, error, duration_ms: duration };
      await this.env.MODELDEX_KV.put(KV_META, JSON.stringify({ ...meta, last_run: lastRun }));
    }
  }

  private async activeLease(): Promise<Lease | null> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease) return null;
    if (lease.expires_at <= Date.now()) {
      await this.ctx.storage.delete("lease");
      return null;
    }
    return lease;
  }

  private async readMeta(): Promise<CodexMeta | null> {
    return this.readJson<CodexMeta>(KV_META);
  }

  private async readCurrentModels(): Promise<CatalogModel[] | null> {
    const text = await this.env.MODELDEX_KV.get(KV_CURRENT);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { models?: unknown };
      return Array.isArray(parsed.models) ? (parsed.models as CatalogModel[]) : null;
    } catch {
      return null;
    }
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const text = await this.env.MODELDEX_KV.get(key);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}

/// 账号指纹：只暴露 account_id 前 8 位，够对照、不够反查。
function accountFingerprint(accountId: string | null): string | null {
  return accountId ? accountId.slice(0, 8) : null;
}
