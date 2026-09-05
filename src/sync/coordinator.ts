// 同步协调器（Durable Object，单例 "primary"）。
//
// 它是系统里唯一会拿着 OAuth token 出站、唯一会写 KV 的角色：
//   - Cloudflare 不承诺 cron 互斥且会重试；两次并发刷新会触发 refresh_token_reused，
//     账号永久锁死。DO 单线程 + 事务存储是唯一安全的单写者。
//   - refresh token 会轮换：拿到新 token **先写存储**，再做任何别的网络调用。
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

export interface LastRun {
  at: string;
  reason: "cron" | "manual";
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
  source: { plan_label: string | null; account_fp: string | null };
  model_count: number;
  listed_slugs: string[];
  last_run: LastRun | null;
  snapshot_id: string;
}

export interface SyncStatus {
  seeded: boolean;
  account_fp: string | null;
  plan_label: string | null;
  last_refresh_at: string | null;
  access_expires_at: string | null;
  permanent_failure: PermanentFailure | null;
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

  /// bootstrap：写入专用账号的 token（来自一次性 `codex login` 的 auth.json）。
  async seed(input: SeedInput): Promise<{ ok: true; account_fp: string | null; plan_label: string | null }> {
    if (typeof input.refresh_token !== "string" || input.refresh_token.trim().length === 0) {
      throw new Error("refresh_token is required");
    }
    const kek = await importKek(this.env.REFRESH_TOKEN_KEK);
    const accessToken = typeof input.access_token === "string" ? input.access_token : null;
    const auth: StoredAuth = {
      refresh_ct: await seal(kek, input.refresh_token.trim()),
      access_ct: accessToken ? await seal(kek, accessToken) : null,
      access_exp: accessToken ? jwtExpSeconds(accessToken) : null,
      account_id: typeof input.account_id === "string" && input.account_id ? input.account_id : null,
      plan_label: planLabelFromIdToken(typeof input.id_token === "string" ? input.id_token : null),
      last_refresh_at: null,
      seeded_at: new Date().toISOString(),
    };
    await this.ctx.storage.put("auth", auth);
    await this.ctx.storage.delete("permanent_failure");
    return { ok: true, account_fp: accountFingerprint(auth.account_id), plan_label: auth.plan_label };
  }

  async runSync(reason: "cron" | "manual"): Promise<SyncResult> {
    // 同一 DO 内串行：并发触发只等同一次运行。
    if (this.running) return this.running;
    this.running = this.runSyncInner(reason).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async status(): Promise<SyncStatus> {
    const auth = await this.ctx.storage.get<StoredAuth>("auth");
    const failure = (await this.ctx.storage.get<PermanentFailure>("permanent_failure")) ?? null;
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
      }>("SELECT at, reason, status, error, hash, client_version, duration_ms FROM runs ORDER BY id DESC LIMIT 20")
      .toArray();
    return {
      seeded: auth !== undefined,
      account_fp: accountFingerprint(auth?.account_id ?? null),
      plan_label: auth?.plan_label ?? null,
      last_refresh_at: auth?.last_refresh_at ?? null,
      access_expires_at: auth?.access_exp ? new Date(auth.access_exp * 1000).toISOString() : null,
      permanent_failure: failure,
      current_hash: meta?.content_hash ?? null,
      last_run: meta?.last_run ?? null,
      recent_runs: rows,
    };
  }

  private async runSyncInner(reason: "cron" | "manual"): Promise<SyncResult> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const record = async (
      status: LastRun["status"],
      error: string | null,
      hash: string | null,
      clientVersion: string | null,
    ): Promise<void> => {
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
      await this.updateMetaLastRun({ at, reason, status, error, duration_ms: duration });
    };

    const failure = await this.ctx.storage.get<PermanentFailure>("permanent_failure");
    if (failure) {
      await record("skipped", `permanent_failure since ${failure.at}: ${failure.reason}`, null, null);
      return { status: "skipped", reason: `permanent_failure: ${failure.reason}` };
    }
    const auth = await this.ctx.storage.get<StoredAuth>("auth");
    if (!auth) {
      await record("skipped", "not seeded", null, null);
      return { status: "skipped", reason: "not seeded" };
    }

    // ① 凭据：临过期才刷新；新 refresh token 先落盘再往下走。
    const kek = await importKek(this.env.REFRESH_TOKEN_KEK);
    const nowSeconds = Math.floor(Date.now() / 1000);
    let accessToken = auth.access_ct ? await open(kek, auth.access_ct) : null;
    const needsRefresh =
      !accessToken || auth.access_exp === null || auth.access_exp - nowSeconds < REFRESH_WINDOW_SECONDS;
    if (needsRefresh) {
      const refreshToken = await open(kek, auth.refresh_ct);
      const outcome = await refreshAccessToken(refreshToken);
      if (!outcome.ok) {
        if (outcome.permanent) {
          const failure: PermanentFailure = { at, reason: outcome.reason };
          await this.ctx.storage.put("permanent_failure", failure);
        }
        await record("error", `refresh: ${outcome.reason}`, null, null);
        return { status: "error", reason: `refresh: ${outcome.reason}`, permanent: outcome.permanent };
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
      accessToken = outcome.accessToken;
    }

    // ② 客户端版本：跟 npm 走；拿不到用上次的。
    const previousMeta = await this.readMeta();
    const clientVersion =
      (await latestCodexClientVersion()) ?? previousMeta?.client_version ?? null;
    if (!clientVersion) {
      await record("error", "client_version unavailable (npm unreachable, no previous)", null, null);
      return { status: "error", reason: "client_version unavailable", permanent: false };
    }

    // ③ 拉取 + 校验。
    let fetched;
    try {
      fetched = await fetchOfficialCatalog({
        accessToken: accessToken!,
        accountId: auth.account_id,
        clientVersion,
      });
    } catch (error) {
      await record("error", `fetch: ${String(error)}`, null, clientVersion);
      return { status: "error", reason: `fetch: ${String(error)}`, permanent: false };
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      const reason = `catalog HTTP ${fetched.status}`;
      await record("error", reason, null, clientVersion);
      return { status: "error", reason, permanent: false };
    }
    const validated = validateCatalog(fetched.text);
    if (!validated.ok) {
      await record("error", `invalid catalog: ${validated.error}`, null, clientVersion);
      return { status: "error", reason: `invalid catalog: ${validated.error}`, permanent: false };
    }

    // ④ 规范化 + 哈希；未变只刷 checked_at。
    const canonical = canonicalCatalogText(validated.models);
    const hash = await catalogHash(canonical);
    const etag = fetched.etag ?? `"sha256-${hash.slice(0, 32)}"`;
    if (previousMeta && previousMeta.content_hash === hash) {
      const meta: CodexMeta = { ...previousMeta, checked_at: at, client_version: clientVersion, etag };
      await this.env.MODELDEX_KV.put(KV_META, JSON.stringify(meta));
      await record("unchanged", null, hash, clientVersion);
      return { status: "unchanged", hash, client_version: clientVersion };
    }

    // ⑤ 变了：快照、当前、变更事件、meta。
    const previousModels = await this.readCurrentModels();
    const previousChanges = (await this.readJson<ChangeEvent[]>(KV_CHANGES)) ?? [];
    const seqStart = (previousChanges[0]?.seq ?? 0) + 1;
    const events = diffCatalogs(previousModels, validated.models, {
      at,
      fromHash: previousMeta?.content_hash ?? null,
      toHash: hash,
      clientVersion,
      seqStart,
    });
    const changes = [...events.reverse(), ...previousChanges].slice(0, CHANGES_LIMIT);
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
      source: { plan_label: auth.plan_label, account_fp: accountFingerprint(auth.account_id) },
      model_count: validated.models.length,
      listed_slugs: validated.models
        .filter((m) => m["visibility"] === "list")
        .map((m) => m.slug),
      last_run: null,
      snapshot_id: hash,
    };

    await this.env.MODELDEX_KV.put(kvSnapshotKey(hash), canonical, { expirationTtl: SNAPSHOT_TTL_SECONDS });
    await this.env.MODELDEX_KV.put(KV_CURRENT, canonical);
    await this.env.MODELDEX_KV.put(KV_CHANGES, JSON.stringify(changes));
    await this.env.MODELDEX_KV.put(KV_SNAPSHOTS_INDEX, JSON.stringify(index));
    await this.env.MODELDEX_KV.put(KV_META, JSON.stringify(meta));
    await record("ok", null, hash, clientVersion);
    return {
      status: "ok",
      hash,
      model_count: validated.models.length,
      changes: events.length,
      client_version: clientVersion,
    };
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

  private async updateMetaLastRun(lastRun: LastRun): Promise<void> {
    const meta = await this.readMeta();
    if (!meta) return;
    await this.env.MODELDEX_KV.put(KV_META, JSON.stringify({ ...meta, last_run: lastRun }));
  }
}

/// 账号指纹：只暴露 account_id 前 8 位，够对照、不够反查。
function accountFingerprint(accountId: string | null): string | null {
  return accountId ? accountId.slice(0, 8) : null;
}
