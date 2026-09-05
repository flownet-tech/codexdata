// 测试用出站桩：vitest-pool-workers 0.22 不再提供 fetchMock，改用 Miniflare 的
// `outboundService` 接管测试 Worker（含 Durable Object）的全部出站 fetch。
// 这个函数跑在 Node 进程里；测试代码通过 `https://mock.local/*` 控制剧本、读日志。
//
//   POST https://mock.local/reset                      清空剧本与日志
//   POST https://mock.local/oauth  {status, body}      压入一条 auth.openai.com/oauth/token 的应答（队列）
//   POST https://mock.local/npm    {version}           设置 registry.npmjs.org 的应答
//   GET  https://mock.local/log                        已收到的出站请求 [{url, method, body}]
//
// 未编排的主机 → 502 JSON `{error:"unmocked"}`（并记日志），保证测试不会真的出网。

interface Scripted {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface LogEntry {
  url: string;
  method: string;
  body: string;
}

const state = {
  oauth: [] as Scripted[],
  npm: { status: 200, body: JSON.stringify({ version: "0.153.4" }) } as Scripted,
  log: [] as LogEntry[],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scripted(reply: Scripted): Response {
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
  });
}

export async function outboundMock(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === "mock.local") {
    switch (`${request.method} ${url.pathname}`) {
      case "POST /reset":
        state.oauth = [];
        state.npm = { status: 200, body: JSON.stringify({ version: "0.153.4" }) };
        state.log = [];
        return json({ ok: true });
      case "POST /oauth":
        state.oauth.push((await request.json()) as Scripted);
        return json({ ok: true, queued: state.oauth.length });
      case "POST /npm": {
        const { version } = (await request.json()) as { version: string };
        state.npm = { status: 200, body: JSON.stringify({ version }) };
        return json({ ok: true });
      }
      case "GET /log":
        return json(state.log);
      default:
        return json({ error: "unknown control route" }, 404);
    }
  }

  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  state.log.push({ url: request.url, method: request.method, body });

  if (url.hostname === "auth.openai.com" && url.pathname === "/oauth/token") {
    const reply = state.oauth.shift();
    if (!reply) return json({ error: "no scripted oauth reply" }, 599);
    return scripted(reply);
  }
  if (url.hostname === "registry.npmjs.org") {
    return scripted(state.npm);
  }
  return json({ error: "unmocked", url: request.url }, 502);
}
