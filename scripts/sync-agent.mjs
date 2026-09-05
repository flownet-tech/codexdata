#!/usr/bin/env node
// ModelDex 外部同步 agent（Node ≥ 20，零依赖）。
//
// 用途：Cloudflare Workers 的出口打不到 chatgpt.com（Phase 0 探针 403），所以由能到达的
// 机器（GitHub Actions runner / 任意主机）代为拉取官方目录，再推回 Worker 发布。
// 凭据边界：agent 只拿到一个 10 分钟内有效的 access token（Worker 租出），refresh token
// 永远不出 Worker；拉取结果原样推回，校验与发布都在 Worker 内。
//
// 环境变量：
//   MODELDEX_ORIGIN       Worker 地址（默认 https://api.codexpass.com）
//   MODELDEX_ADMIN_TOKEN  /admin/* 的 Bearer token（必填）
//   MODELDEX_AGENT        本 agent 的名字（默认 hostname 或 GITHUB_RUN_ID）

const origin = (process.env.MODELDEX_ORIGIN ?? "https://api.codexpass.com").replace(/\/+$/, "");
const adminToken = process.env.MODELDEX_ADMIN_TOKEN ?? "";
const agent =
  process.env.MODELDEX_AGENT ??
  (process.env.GITHUB_RUN_ID
    ? `github-actions#${process.env.GITHUB_RUN_ID}`
    : `host:${process.env.HOSTNAME ?? "unknown"}`);

const NPM_LATEST = "https://registry.npmjs.org/@openai/codex/latest";
const CODEX_MODELS = "https://chatgpt.com/backend-api/codex/models";
const MAX_BODY = 8 * 1024 * 1024;

function log(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

async function admin(path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function withRetry(label, fn, attempts = 4) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      log("retry", { label, attempt: i, error: String(error) });
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastError;
}

async function latestClientVersion(hint) {
  try {
    const res = await fetch(NPM_LATEST, { headers: { accept: "application/json" } });
    if (res.ok) {
      const { version } = await res.json();
      if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) return version;
    }
  } catch (error) {
    log("npm_failed", { error: String(error) });
  }
  return hint;
}

async function main() {
  if (!adminToken) throw new Error("MODELDEX_ADMIN_TOKEN is required");

  const lease = await withRetry(
    "lease",
    async () => {
      const { status, json } = await admin("/admin/lease", { agent });
      if (status === 409) throw new Error(`lease busy: ${json.reason}`);
      if (status === 503) {
        // 永久失败（token 失效等）：不重试，需人工重新 seed。
        const err = new Error(`permanent: ${json.reason}`);
        err.permanent = true;
        throw err;
      }
      if (!json.ok)
        throw new Error(`lease failed (${status}): ${json.reason ?? JSON.stringify(json)}`);
      return json;
    },
    3,
  ).catch((error) => {
    if (error?.permanent) {
      log("permanent_failure", { reason: error.message });
      process.exit(2);
    }
    throw error;
  });
  log("leased", {
    lease_id: lease.lease_id,
    expires_at: lease.expires_at,
    account_id_fp: (lease.account_id ?? "").slice(0, 8),
  });

  let ingestResult;
  try {
    const clientVersion = await latestClientVersion(lease.client_version_hint ?? "0.153.4");
    const headers = {
      authorization: `Bearer ${lease.access_token}`,
      originator: "codex-tui",
      "user-agent": `codex-tui/${clientVersion} (Linux 6.8.0; x86_64) (codex-tui; ${clientVersion})`,
      accept: "application/json",
    };
    if (lease.account_id) headers["chatgpt-account-id"] = lease.account_id;

    const res = await fetch(`${CODEX_MODELS}?client_version=${encodeURIComponent(clientVersion)}`, {
      headers,
      redirect: "manual",
    });
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY) throw new Error(`catalog too large: content-length ${declared}`);
    const body = await res.text();
    if (body.length > MAX_BODY) throw new Error(`catalog too large: ${body.length} bytes`);
    log("fetched", {
      status: res.status,
      bytes: body.length,
      etag: res.headers.get("etag"),
      client_version: clientVersion,
    });

    ingestResult = await withRetry("ingest", async () => {
      const { status, json } = await admin("/admin/ingest", {
        lease_id: lease.lease_id,
        client_version: clientVersion,
        status: res.status,
        etag: res.headers.get("etag"),
        body,
      });
      if (status >= 500) throw new Error(`ingest ${status}: ${JSON.stringify(json).slice(0, 200)}`);
      return json;
    });
  } catch (error) {
    await admin("/admin/release", { lease_id: lease.lease_id, error: String(error) }).catch(
      () => {},
    );
    throw error;
  }

  log("ingested", ingestResult);
  if (ingestResult.status === "error") process.exit(1);
}

main().catch((error) => {
  log("failed", { error: String(error) });
  process.exit(1);
});
