// 集成测试：Miniflare 里跑真实的 Worker + Durable Object + KV；出站 fetch 由
// test/outbound-mock.ts（Miniflare outboundService）接管，通过 https://mock.local 编排。
import {
  createExecutionContext,
  createScheduledController,
  env,
  reset,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { KV_CHANGES, KV_CURRENT, KV_META, type CodexMeta } from "../src/sync/coordinator";
import { officialModel } from "./fixtures";

const mock = {
  reset: () => fetch("https://mock.local/reset", { method: "POST" }),
  oauth: (status: number, body: unknown) =>
    fetch("https://mock.local/oauth", {
      method: "POST",
      body: JSON.stringify({ status, body: JSON.stringify(body) }),
    }),
  log: async () =>
    (await (await fetch("https://mock.local/log")).json()) as Array<{
      url: string;
      method: string;
      body: string;
    }>,
  oauthRefreshTokensSeen: async () =>
    (await mock.log())
      .filter((e) => e.url.startsWith("https://auth.openai.com/oauth/token"))
      .map((e) => (JSON.parse(e.body) as { refresh_token: string }).refresh_token),
};

const ADMIN = { authorization: "Bearer test-admin-token", "content-type": "application/json" };

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(claims))}.sig`;
}

const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
const expired = () => Math.floor(Date.now() / 1000) - 60;

async function admin(path: string, body?: unknown, method = "POST"): Promise<Response> {
  return SELF.fetch(`https://codex-models.test${path}`, {
    method,
    headers: ADMIN,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function seed(overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await admin("/admin/seed", {
    refresh_token: "refresh-v1",
    access_token: jwt({ exp: inOneHour() }),
    id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
    account_id: "acct-12345678-rest",
    ...overrides,
  });
  expect(res.status, await res.text()).toBe(200);
}

function catalogBody(models = [officialModel()]): string {
  return JSON.stringify({ models });
}

async function leaseAndIngest(body: string, etag = 'W/"v1"', status = 200): Promise<Response> {
  const lease = (await (await admin("/admin/lease", { agent: "test" })).json()) as {
    ok: boolean;
    lease_id: string;
  };
  expect(lease.ok).toBe(true);
  return admin("/admin/ingest", {
    lease_id: lease.lease_id,
    client_version: "0.153.4",
    status,
    etag,
    body,
  });
}

beforeEach(async () => {
  // 0.22 不再自动隔离每个测试的存储：手动清空 KV / DO 存储与出站剧本。
  await reset();
  await mock.reset();
});

describe("admin auth", () => {
  it("rejects missing or wrong tokens without touching the coordinator", async () => {
    const none = await SELF.fetch("https://codex-models.test/admin/status");
    expect(none.status).toBe(401);
    const wrong = await SELF.fetch("https://codex-models.test/admin/status", {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await admin("/admin/status", undefined, "GET");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ seeded: false, sync_mode: "external" });
  });
});

describe("before any sync", () => {
  it("serves 503 not-synced and an unhealthy /healthz, never an empty list", async () => {
    const models = await SELF.fetch("https://codex-models.test/v1/codex/models.json");
    expect(models.status).toBe(503);
    expect(((await models.json()) as { error: { type: string } }).error.type).toBe(
      "codex_models_not_synced",
    );
    const health = await SELF.fetch("https://codex-models.test/healthz");
    expect(health.status).toBe(503);
    const index = await SELF.fetch("https://codex-models.test/v1/index.json");
    expect(index.status).toBe(200);
    expect(((await index.json()) as { codex: unknown }).codex).toBeNull();
  });
});

describe("lease / ingest / serve", () => {
  it("publishes a valid catalog and serves it verbatim with ETag, cache headers and 304", async () => {
    await seed();
    const ingest = await leaseAndIngest(catalogBody());
    expect(ingest.status, await ingest.clone().text()).toBe(200);
    expect(await ingest.json()).toMatchObject({ status: "ok", model_count: 1, changes: 1 });

    const res = await SELF.fetch("https://codex-models.test/v1/codex/models.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('W/"v1"');
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-codex-models-client-version")).toBe("0.153.4");
    expect(res.headers.get("x-codex-models-source-plan")).toBe("pro");
    const body = (await res.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.["slug"]).toBe("gpt-5.6-sol");
    expect(body.models[0]?.["base_instructions"]).toBe("You are Codex.");

    const conditional = await SELF.fetch("https://codex-models.test/v1/codex/models.json", {
      headers: { "if-none-match": 'W/"v1"' },
    });
    expect(conditional.status).toBe(304);

    const meta = (await (
      await SELF.fetch("https://codex-models.test/v1/codex/meta.json")
    ).json()) as CodexMeta;
    expect(meta.model_count).toBe(1);
    expect(meta.listed_slugs).toEqual(["gpt-5.6-sol"]);
    expect(meta.source).toMatchObject({ plan_label: "pro", account_fp: "acct-123", agent: "test" });
    expect(meta.last_run?.status).toBe("ok");

    const health = await SELF.fetch("https://codex-models.test/healthz");
    expect(health.status).toBe(200);
  });

  it("never publishes a malformed catalog and keeps the last good one", async () => {
    await seed();
    expect((await leaseAndIngest(catalogBody())).status).toBe(200);
    const before = await env.CODEX_MODELS_KV.get(KV_CURRENT);

    const broken = officialModel({ slug: "gpt-broken" });
    delete (broken as Record<string, unknown>)["shell_type"];
    const bad = await leaseAndIngest(catalogBody([officialModel(), broken]));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ status: "error" });
    expect(await env.CODEX_MODELS_KV.get(KV_CURRENT)).toBe(before);

    const html = await leaseAndIngest("<html>login</html>", null as unknown as string, 403);
    expect(html.status).toBe(422);
    expect(await env.CODEX_MODELS_KV.get(KV_CURRENT)).toBe(before);
  });

  it("reports unchanged content, appends change events, and keeps snapshots", async () => {
    await seed();
    expect(await (await leaseAndIngest(catalogBody())).json()).toMatchObject({ status: "ok" });
    const again = await leaseAndIngest(
      JSON.stringify({ models: [officialModel()], reordered: true }),
    );
    expect(await again.json()).toMatchObject({ status: "unchanged" });

    const next = await leaseAndIngest(
      catalogBody([
        officialModel({ priority: 5 }),
        officialModel({ slug: "gpt-6-astra", priority: 1 }),
      ]),
      'W/"v2"',
    );
    expect(await next.json()).toMatchObject({ status: "ok", changes: 2 });

    const changes = (await (
      await SELF.fetch("https://codex-models.test/v1/codex/changes.json")
    ).json()) as Array<{
      kind: string;
      slug: string;
    }>;
    expect(changes.map((c) => `${c.kind}:${c.slug}`)).toEqual([
      "added:gpt-6-astra",
      "changed:gpt-5.6-sol",
      "added:gpt-5.6-sol",
    ]);
    const raw = await env.CODEX_MODELS_KV.get(KV_CHANGES);
    expect(raw).not.toBeNull();

    const index = (await (
      await SELF.fetch("https://codex-models.test/v1/codex/snapshots/index.json")
    ).json()) as Array<{
      hash: string;
    }>;
    expect(index).toHaveLength(2);
    const snapshot = await SELF.fetch(
      `https://codex-models.test/v1/codex/snapshots/${index[1]!.hash}.json`,
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toContain("immutable");
    expect(((await snapshot.json()) as { models: unknown[] }).models).toHaveLength(1);
  });

  it("refuses a second lease while one is held and rejects ingest with a stale lease id", async () => {
    await seed();
    const first = await admin("/admin/lease", { agent: "a" });
    expect(first.status).toBe(200);
    const second = await admin("/admin/lease", { agent: "b" });
    expect(second.status).toBe(409);
    const bogus = await admin("/admin/ingest", {
      lease_id: "not-a-lease",
      client_version: "0.153.4",
      status: 200,
      etag: null,
      body: catalogBody(),
    });
    expect(bogus.status).toBe(422);
    const { lease_id } = (await first.json()) as { lease_id: string };
    expect(await (await admin("/admin/release", { lease_id, error: "boom" })).json()).toEqual({
      ok: true,
    });
    const third = await admin("/admin/lease", { agent: "c" });
    expect(third.status).toBe(200);
  });
});

describe("token refresh inside the coordinator", () => {
  it("refreshes only when the access token is expiring, persists the rotated refresh token before continuing", async () => {
    await seed({ access_token: jwt({ exp: expired() }) });
    // 第一次租约：access 过期 → 刷新，服务端返回轮换后的 refresh-v2（且故意给一个也过期的 access）。
    await mock.oauth(200, { access_token: jwt({ exp: expired() }), refresh_token: "refresh-v2" });
    const first = await admin("/admin/lease", { agent: "t1" });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await mock.oauthRefreshTokensSeen()).toEqual(["refresh-v1"]);
    const { lease_id } = (await first.json()) as { lease_id: string };
    await admin("/admin/release", { lease_id, error: "test" });

    // 第二次：access 仍过期 → 再刷新，必须用 refresh-v2（证明轮换已持久化）。
    await mock.oauth(200, { access_token: jwt({ exp: inOneHour() }) });
    const second = await admin("/admin/lease", { agent: "t2" });
    expect(second.status).toBe(200);
    expect(await mock.oauthRefreshTokensSeen()).toEqual(["refresh-v1", "refresh-v2"]);
    const lease2 = (await second.json()) as { lease_id: string };
    await admin("/admin/release", { lease_id: lease2.lease_id, error: "test" });

    // 第三次：access 还有一小时 → 不刷新（剧本队列已空，若出站会得到 599）。
    const third = await admin("/admin/lease", { agent: "t3" });
    expect(third.status).toBe(200);
    expect(await mock.oauthRefreshTokensSeen()).toHaveLength(2);
  });

  it("freezes on a permanent refresh failure and stays frozen without further network calls", async () => {
    await seed({ access_token: jwt({ exp: expired() }) });
    await mock.oauth(400, { error: { code: "refresh_token_reused" } });
    const res = await admin("/admin/lease", { agent: "t" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, permanent: true });

    const status = (await (await admin("/admin/status", undefined, "GET")).json()) as {
      permanent_failure: { reason: string } | null;
    };
    expect(status.permanent_failure?.reason).toContain("refresh_token_reused");

    // 冻结期：不再出站，直接拒绝。
    const again = await admin("/admin/lease", { agent: "t" });
    expect(again.status).toBe(503);
    expect((await mock.log()).filter((e) => e.url.includes("auth.openai.com"))).toHaveLength(1);
    expect((await SELF.fetch("https://codex-models.test/healthz")).status).toBe(503);

    // 重新 seed 解除冻结。
    await seed();
    const after = await admin("/admin/lease", { agent: "t" });
    expect(after.status).toBe(200);
  });

  it("treats transient refresh errors as retryable (no freeze)", async () => {
    await seed({ access_token: jwt({ exp: expired() }) });
    await mock.oauth(503, { error: "temporarily unavailable" });
    const res = await admin("/admin/lease", { agent: "t" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, permanent: false });
    await mock.oauth(200, { access_token: jwt({ exp: inOneHour() }) });
    expect((await admin("/admin/lease", { agent: "t" })).status).toBe(200);
  });
});

describe("modes", () => {
  it("runSync is a no-op in external mode (cron does not fetch from the Worker)", async () => {
    await seed();
    const res = await admin("/admin/sync", {});
    expect(await res.json()).toMatchObject({ status: "skipped" });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "7 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.CODEX_MODELS_KV.get(KV_META)).toBeNull();
  });
});
