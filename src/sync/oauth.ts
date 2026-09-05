// ChatGPT OAuth（Codex 客户端同款流程）：用 refresh_token 换新 access_token。
// 事实来源：openai/codex rust-v0.153.1 codex-rs/login/src/auth/manager.rs
//   - REFRESH_TOKEN_URL = https://auth.openai.com/oauth/token
//   - CLIENT_ID = app_EMoamEEZ73f0CkXaXp7hrann
//   - 请求 JSON {client_id, grant_type:"refresh_token", refresh_token}
//   - 响应 {id_token?, access_token?, refresh_token?}——refresh_token **会轮换**，
//     且服务端检测重用（refresh_token_reused → 永久失效）。调用方必须在做任何
//     别的事之前把新 refresh_token 持久化。
//   - 永久错误：HTTP 401；400 + invalid_grant；error code ∈
//     {refresh_token_expired, refresh_token_reused, refresh_token_invalidated}。

export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type RefreshOutcome =
  | { ok: true; accessToken: string; refreshToken: string | null; idToken: string | null }
  | { ok: false; permanent: boolean; reason: string };

const PERMANENT_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      redirect: "manual",
    });
  } catch (error) {
    return { ok: false, permanent: false, reason: `network: ${String(error)}` };
  }

  const text = await response.text();
  if (response.ok) {
    let parsed: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, permanent: false, reason: "refresh response is not JSON" };
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      return { ok: false, permanent: false, reason: "refresh response lacks access_token" };
    }
    return {
      ok: true,
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
      idToken: typeof parsed.id_token === "string" ? parsed.id_token : null,
    };
  }

  const code = extractErrorCode(text);
  const permanent =
    response.status === 401 ||
    (code !== null && PERMANENT_CODES.has(code)) ||
    (response.status === 400 && code === "invalid_grant");
  return {
    ok: false,
    permanent,
    reason: `HTTP ${response.status}${code ? ` ${code}` : ""}`,
  };
}

/// 与 codex 的 extract_refresh_token_error_code 同款：error.code / error（字符串）/ 顶层 code。
function extractErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed["error"];
    if (error && typeof error === "object") {
      const code = (error as Record<string, unknown>)["code"];
      if (typeof code === "string") return code;
    }
    if (typeof error === "string") return error;
    const top = parsed["code"];
    if (typeof top === "string") return top;
  } catch {
    // 非 JSON 错误体
  }
  return null;
}

export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/// JWT `exp`（秒）；解析不到返回 null。
export function jwtExpSeconds(token: string): number | null {
  const claims = jwtClaims(token);
  const exp = claims?.["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/// 套餐标签：id_token 的 `https://api.openai.com/auth` claim 里的 `chatgpt_plan_type`
/// （字段名对照 codex login/src/token_data.rs；拿不到就 null，不猜）。
export function planLabelFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const claims = jwtClaims(idToken);
  const auth = claims?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const plan = (auth as Record<string, unknown>)["chatgpt_plan_type"];
    if (typeof plan === "string" && plan.length > 0) return plan;
  }
  return null;
}
