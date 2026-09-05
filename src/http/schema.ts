// /v1/schema/codex-model-info/*：Codex 客户端对 GET /models 响应的拒绝规则，JSON Schema 形式。
// 单一真源是 data/codex-schema/codex-model-info.schema.json（同一份也驱动 DO 的发布校验）；
// 每个已核实的 Codex tag 一个 URL，内容相同（结构变更全部是带默认值的追加，见 tags.json）。

import modelInfoSchema from "../../data/codex-schema/codex-model-info.schema.json";
import tags from "../../data/codex-schema/tags.json";
import { sha256Hex } from "../sync/crypto";
import { CACHE_HOURLY, errorResponse, jsonResponse } from "./headers";

export const SCHEMA_PATH_PREFIX = "/v1/schema/codex-model-info/";
const TAG_RE = /^rust-v\d+\.\d+\.\d+$/;

export const VERIFIED_TAGS: readonly string[] = tags.verified_tags;
export const LATEST_TAG: string = tags.latest;

const schemaText = JSON.stringify(modelInfoSchema);
let schemaEtag: Promise<string> | null = null;

function etag(): Promise<string> {
  schemaEtag ??= sha256Hex(schemaText).then((hash) => `"schema-${hash.slice(0, 32)}"`);
  return schemaEtag;
}

export function schemaIndex(origin: string): unknown {
  const url = (tag: string) => `${origin}${SCHEMA_PATH_PREFIX}${tag}.json`;
  return {
    schema: "codex-model-info",
    latest: { tag: LATEST_TAG, url: url("latest") },
    verified_tags: VERIFIED_TAGS.map((tag) => ({ tag, url: url(tag) })),
    source_files: tags.source_files,
    notes: tags.notes,
    license: {
      schema: "CC-BY-4.0",
      derived_from:
        "openai/codex (Apache-2.0); source snapshots in the repository under data/codex-schema/sources/",
    },
  };
}

/// `latest.json` / `<tag>.json` → 同一份 schema；`index.json` → 已核实 tag 列表。
export async function serveSchema(path: string, origin: string): Promise<Response> {
  const rest = path.slice(SCHEMA_PATH_PREFIX.length);
  if (rest === "index.json") {
    return jsonResponse(schemaIndex(origin), { cacheControl: CACHE_HOURLY, etag: await etag() });
  }
  if (!rest.endsWith(".json")) return errorResponse(404, "not found", "not_found");
  const tag = rest.slice(0, -".json".length);
  if (tag !== "latest" && !(TAG_RE.test(tag) && VERIFIED_TAGS.includes(tag))) {
    return errorResponse(
      404,
      `unknown or unverified Codex tag \`${tag}\`; see ${origin}${SCHEMA_PATH_PREFIX}index.json`,
      "unknown_schema_tag",
    );
  }
  return jsonResponse(schemaText, { cacheControl: CACHE_HOURLY, etag: await etag() });
}
