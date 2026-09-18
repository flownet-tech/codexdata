// /v1/compat/codex/latest.json 读路径 + /admin/compat/publish 发布路径。
// 数据面：GitHub Actions 的 compat-watch workflow 探测新 Codex 版本后，把
// scripts/build-compat.mjs 的产物 POST 到 publish 端点 → KV；读路径 KV 优先、
// 静态资产（git 里最后一次构建的同名文件）兜底。这样紧急兼容情报不需要重新部署 Worker。

import { Validator } from "@cfworker/json-schema";
import compatSchema from "../../data/codex-compat/compat.schema.json";
import { CACHE_LIVE, errorResponse, jsonResponse } from "./headers";

export const KV_COMPAT = "compat:codex:latest";
export const COMPAT_PATH = "/v1/compat/codex/latest.json";
const MAX_COMPAT_BYTES = 512 * 1024;

const validator = new Validator(compatSchema as object, "2020-12", false);

interface CompatKvMetadata {
  etag: string;
  published_at: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function serveCompat(env: Env, origin: string): Promise<Response> {
  const entry = await env.CODEX_MODELS_KV.getWithMetadata<CompatKvMetadata>(KV_COMPAT, {
    cacheTtl: 300,
  });
  if (entry.value) {
    return jsonResponse(entry.value, {
      cacheControl: CACHE_LIVE,
      ...(entry.metadata?.etag ? { etag: entry.metadata.etag } : {}),
      headers: entry.metadata?.published_at
        ? { "x-codex-compat-published-at": entry.metadata.published_at }
        : {},
    });
  }
  // KV 还没发布过：回落到部署时打包的静态产物（与 git 提交一致）。
  return env.ASSETS.fetch(new Request(`${origin}${COMPAT_PATH}`));
}

export async function publishCompat(env: Env, body: unknown): Promise<Response> {
  const result = validator.validate(body);
  if (!result.valid) {
    const first = result.errors[0];
    return errorResponse(
      422,
      `compat payload rejected: ${first ? `${first.instanceLocation} ${first.error}` : "schema"}`,
      "invalid_compat_payload",
    );
  }
  const text = JSON.stringify(body);
  if (text.length > MAX_COMPAT_BYTES)
    return errorResponse(413, "compat payload too large", "too_large");
  const metadata: CompatKvMetadata = {
    etag: `"compat-${(await sha256Hex(text)).slice(0, 16)}"`,
    published_at: new Date().toISOString(),
  };
  await env.CODEX_MODELS_KV.put(KV_COMPAT, text, { metadata });
  return jsonResponse({ ok: true, etag: metadata.etag, published_at: metadata.published_at });
}
