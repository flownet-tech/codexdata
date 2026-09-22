// 旧公共域名（codexdata.0xinf.net / codex-models.flownet.workers.dev）的退役入口。
//
// 生产实例 2026-09 已迁到 data.cp.dev（另一个 Cloudflare 账号），同步 agent 只往新实例推，
// 旧实例的镜像数据从此不再更新。为了不让仍指向旧地址的消费者拿到陈旧目录，旧账号里的
// codex-models Worker 用这份入口重新部署：所有路径 301 到新域名的同路径。
//
// 部署用 wrangler.legacy.jsonc（不带 assets——静态资源层会在 Worker 之前直出，
// 那样 /v1/features/* 之类的路径就绕过了重定向）。旧实例的 KV 快照与 SyncCoordinator
// （存着旧账号那条会话的加密 refresh token）已于 2026-09-22 清理，所以这里不再导出
// 任何 Durable Object，配置里也没有 KV/DO 绑定。

import { CORS_HEADERS, preflight } from "./http/headers";

const TARGET_ORIGIN = "https://data.cp.dev";

export default {
  fetch(request: Request): Response {
    if (request.method === "OPTIONS") return preflight();

    const url = new URL(request.url);
    return new Response(null, {
      status: 301,
      headers: {
        ...CORS_HEADERS,
        location: `${TARGET_ORIGIN}${url.pathname}${url.search}`,
        "cache-control": "public, max-age=3600",
      },
    });
  },
} satisfies ExportedHandler<Env>;
