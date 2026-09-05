// ModelDex Worker 入口：读路径（KV → 边缘缓存）、管理路径、定时同步。

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
        response = api();
        const fresh = await response;
        if (fresh.ok && fresh.headers.get("cache-control")?.startsWith("public")) {
          ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
        }
        response = fresh;
      }
      const conditional = notModifiedIfMatches(request, response);
      return request.method === "HEAD" ? headOf(conditional) : conditional;
    }

    // 其余交给静态资源（文档页、schema、openapi）。
    return env.ASSETS.fetch(request);
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
  const configured = env.MODELDEX_PUBLIC_ORIGIN;
  return typeof configured === "string" && configured.startsWith("https://") ? configured : fallback;
}
