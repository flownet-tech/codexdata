// 官方目录必须用**最新**客户端版本号拉（服务端可能按 client_version 门控）。
// 版本来自 npm registry；拿不到时调用方回退到上次记录的版本。

export const CODEX_NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";

const SEMVER = /^\d+\.\d+\.\d+$/;

export async function latestCodexClientVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(CODEX_NPM_LATEST_URL, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { version?: unknown };
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    return SEMVER.test(version) ? version : null;
  } catch {
    return null;
  }
}
