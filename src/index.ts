// Codex Models Worker 入口：读路径（KV → 边缘缓存）、管理路径、定时同步。
// 纯静态数据集（/v1/features/*、/v1/schema/*）不在这里：它们由 scripts/build-static.mjs
// 预生成进 public/，走 Workers 静态资源层直出（资产请求不计 Worker 调用，零请求费）；
// 只有资产未命中（未知 tag / 打错路径）才会落到本 Worker，返回 JSON 404 指路。

import { handleAdmin } from "./http/admin";
import {
  serveChanges,
  serveCodexMeta,
  serveCodexModels,
  serveHealth,
  serveIndex,
  serveSnapshot,
  serveSnapshotsIndex,
} from "./http/codex";
import { errorResponse, headOf, notModifiedIfMatches, preflight } from "./http/headers";

export { SyncCoordinator } from "./sync/coordinator";

const SNAPSHOT_RE = /^\/v1\/codex\/snapshots\/([0-9a-f]{64})\.json$/;
// 静态数据集前缀（资产层已直出正常请求；到达 Worker = 未命中）。
const STATIC_DATASET_PREFIXES = ["/v1/features/codex/", "/v1/schema/codex-model-info/"];

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return preflight();

    if (path.startsWith("/admin/")) {
      return handleAdmin(request, env, path);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "method not allowed", "method_not_allowed");
    }

    if (path === "/healthz") {
      const status = await env.SYNC.getByName("primary").status();
      return serveHealth(env, status.permanent_failure !== null);
    }

    const api = await routeApi(env, path, url.origin);
    if (api) {
      // Worker 响应不会自动进 CDN 缓存；显式走 Cache API，按 Cache-Control 存。
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cache = caches.default;
      let response = await cache.match(cacheKey);
      if (!response) {
        const fresh = await api();
        if (fresh.ok && fresh.headers.get("cache-control")?.startsWith("public")) {
          ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
        }
        response = fresh;
      }
      const conditional = notModifiedIfMatches(request, response);
      return request.method === "HEAD" ? headOf(conditional) : conditional;
    }

    // 其余交给静态资源（文档页、预生成数据集）。生产上资产命中根本到不了 Worker
    // （资产层前置、零计费）；到达这里 = 资产未命中或本地模拟环境，问一次 binding，
    // 数据集前缀下的未命中回 JSON 404 指路。
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 404) {
      const dataset = STATIC_DATASET_PREFIXES.find((prefix) => path.startsWith(prefix));
      if (dataset) {
        return errorResponse(
          404,
          `unknown or unverified path under ${dataset}; see ${publicOrigin(env, url.origin)}${dataset}index.json`,
          "unknown_dataset_path",
        );
      }
    }
    return assetResponse;
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      env.SYNC.getByName("primary")
        .runSync("cron")
        .then((result) => console.log(JSON.stringify({ event: "sync", result })))
        .catch((error: unknown) =>
          console.error(JSON.stringify({ event: "sync_failed", error: String(error) })),
        ),
    );
  },
} satisfies ExportedHandler<Env>;

function routeApi(env: Env, path: string, origin: string): (() => Promise<Response>) | null {
  switch (path) {
    case "/v1/index.json":
      return () => serveIndex(env, publicOrigin(env, origin));
    case "/v1/codex/models.json":
      return () => serveCodexModels(env);
    case "/v1/codex/meta.json":
      return () => serveCodexMeta(env);
    case "/v1/codex/snapshots/index.json":
      return () => serveSnapshotsIndex(env);
    case "/v1/codex/changes.json":
      return () => serveChanges(env);
    default: {
      const snapshot = SNAPSHOT_RE.exec(path);
      if (snapshot) {
        const hash = snapshot[1]!;
        return () => serveSnapshot(env, hash);
      }
      return null;
    }
  }
}

function publicOrigin(env: Env, fallback: string): string {
  const configured = env.CODEX_MODELS_PUBLIC_ORIGIN;
  return typeof configured === "string" && configured.startsWith("https://")
    ? configured
    : fallback;
}
