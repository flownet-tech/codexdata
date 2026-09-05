// 官方 Codex 目录：拉取、校验、规范化、比对。
//
// Codex 0.153.x 反序列化事实（openai/codex protocol/src/openai_models.rs）：
//   - 顶层必须有 `models` 数组；未知顶层键忽略。
//   - 每条必填：slug, display_name, supported_reasoning_levels, shell_type, visibility,
//     supported_in_api, priority, support_verbosity, truncation_policy,
//     experimental_supported_tools，以及 base_instructions 或
//     model_messages.instructions_template 二选一。
//   - **一条不合格整份拒**，客户端当作拉取失败。所以镜像绝不发布不合格的目录。

import { sha256Hex } from "./crypto";

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/// 官方目录含整段系统提示词，单条几十 KB；8 MiB 对合法目录绰绰有余。
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export type CatalogModel = Record<string, unknown> & { slug: string };

export interface FetchedCatalog {
  status: number;
  etag: string | null;
  text: string;
}

export async function fetchOfficialCatalog(
  input: {
    accessToken: string;
    accountId: string | null;
    clientVersion: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedCatalog> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    originator: "codex-tui",
    "user-agent": `codex-tui/${input.clientVersion} (Cloudflare Workers; modeldex) (codex-tui; ${input.clientVersion})`,
    accept: "application/json",
  };
  if (input.accountId) headers["chatgpt-account-id"] = input.accountId;

  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(input.clientVersion)}`;
  const response = await fetchImpl(url, { headers, redirect: "manual" });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    throw new Error(`catalog response too large (content-length ${declared})`);
  }
  const text = await readBounded(response, MAX_CATALOG_BYTES);
  return { status: response.status, etag: response.headers.get("etag"), text };
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`catalog response too large (> ${limit} bytes)`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

const REQUIRED_FIELDS = [
  "slug",
  "display_name",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "support_verbosity",
  "truncation_policy",
  "experimental_supported_tools",
] as const;

export type ValidationResult = { ok: true; models: CatalogModel[] } | { ok: false; error: string };

export function validateCatalog(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top level is not an object" };
  }
  const models = (parsed as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return { ok: false, error: "missing `models` array" };
  if (models.length === 0) return { ok: false, error: "`models` is empty" };

  const seen = new Set<string>();
  for (const [index, entry] of models.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `models[${index}] is not an object` };
    }
    const record = entry as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in record) || record[field] === undefined) {
        return { ok: false, error: `models[${index}] missing required field \`${field}\`` };
      }
    }
    const slug = record["slug"];
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return { ok: false, error: `models[${index}].slug is not a non-empty string` };
    }
    if (seen.has(slug)) return { ok: false, error: `duplicate slug \`${slug}\`` };
    seen.add(slug);
    const messages = record["model_messages"];
    const hasTemplate =
      messages !== null &&
      typeof messages === "object" &&
      typeof (messages as Record<string, unknown>)["instructions_template"] === "string";
    if (typeof record["base_instructions"] !== "string" && !hasTemplate) {
      return {
        ok: false,
        error: `model \`${slug}\` is missing both base_instructions and model_messages.instructions_template`,
      };
    }
  }
  return { ok: true, models: models as CatalogModel[] };
}

/// 规范化：对象键排序（递归），数组保序。同一份目录无论上游键序如何都得到同一哈希。
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalCatalogText(models: CatalogModel[]): string {
  return JSON.stringify(canonicalize({ models }));
}

export async function catalogHash(canonicalText: string): Promise<string> {
  return sha256Hex(canonicalText);
}

export interface ChangeEvent {
  seq: number;
  at: string;
  kind: "added" | "removed" | "changed";
  slug: string;
  fields_changed: string[];
  from_hash: string | null;
  to_hash: string;
  client_version: string;
}

/// 按 slug 比对两份目录，产出变更事件（字段级只看顶层键）。
export function diffCatalogs(
  previous: CatalogModel[] | null,
  next: CatalogModel[],
  meta: {
    at: string;
    fromHash: string | null;
    toHash: string;
    clientVersion: string;
    seqStart: number;
  },
): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  let seq = meta.seqStart;
  const base = {
    at: meta.at,
    from_hash: meta.fromHash,
    to_hash: meta.toHash,
    client_version: meta.clientVersion,
  };
  const prevBySlug = new Map((previous ?? []).map((m) => [m.slug, m]));
  const nextBySlug = new Map(next.map((m) => [m.slug, m]));

  for (const [slug, model] of nextBySlug) {
    const before = prevBySlug.get(slug);
    if (!before) {
      events.push({ seq: seq++, kind: "added", slug, fields_changed: [], ...base });
      continue;
    }
    const changed = topLevelFieldDiff(before, model);
    if (changed.length > 0) {
      events.push({ seq: seq++, kind: "changed", slug, fields_changed: changed, ...base });
    }
  }
  for (const slug of prevBySlug.keys()) {
    if (!nextBySlug.has(slug)) {
      events.push({ seq: seq++, kind: "removed", slug, fields_changed: [], ...base });
    }
  }
  return events;
}

function topLevelFieldDiff(a: CatalogModel, b: CatalogModel): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (JSON.stringify(canonicalize(a[key])) !== JSON.stringify(canonicalize(b[key]))) {
      changed.push(key);
    }
  }
  return changed;
}
