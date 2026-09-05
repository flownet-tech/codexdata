// /v1/features/codex/*：Codex 功能旗标注册表（代号 → 官方事实 + 人工中文注释）。
// 机器层从客户端源码快照逐 tag 提取（data/codex-features/registry.json，见
// scripts/extract-features.mjs）：key / 生命周期阶段 / 默认值 / 官方 rustdoc /
// 实验菜单文案 / 旧键别名 / 跨版本历史。人工层是 data/codex-features/annotations.json
// 的中文注释（CC-BY-4.0），两层在此合并出每个 tag 的完整视图。
// 消费方（如 codex-pass）只应把这份数据当注释增强：本机清单永远以
// `codex features list` 为准，拉不到本服务时 UI 退回纯代号展示。

import annotationsJson from "../../data/codex-features/annotations.json";
import registryJson from "../../data/codex-features/registry.json";
import tagsJson from "../../data/codex-features/tags.json";
import { sha256Hex } from "../sync/crypto";
import { CACHE_HOURLY, errorResponse, jsonResponse } from "./headers";

export const FEATURES_PATH_PREFIX = "/v1/features/codex/";
const TAG_RE = /^rust-v\d+\.\d+\.\d+$/;

interface ExperimentalCopy {
  name: string;
  menu_description: string;
  announcement: string | null;
}

interface RegistryFlag {
  key: string;
  variant: string;
  stage: string;
  default_enabled: boolean | null;
  default_expr?: string;
  doc: string | null;
  experimental: ExperimentalCopy | null;
  stage_condition?: string;
  stage_fallback?: string;
}

interface FlagHistory {
  first_seen: string;
  last_seen: string;
  stages: { at: string; stage: string }[];
  delisted_after?: string;
}

interface Annotation {
  title_zh: string;
  summary_zh: string;
  aka?: string;
  note_zh?: string;
  risk_zh?: string;
}

interface Registry {
  generated_by: string;
  source_files: string[];
  tags: Record<string, { flags: RegistryFlag[]; legacy_aliases: Record<string, string | null> }>;
  history: Record<string, FlagHistory>;
}

interface FeatureTags {
  latest: string;
  verified_tags: string[];
  snapshot_aliases: Record<string, string>;
  source_files: string[];
  notes: string[];
}

const registry = registryJson as unknown as Registry;
const annotations = annotationsJson as unknown as Record<string, Annotation>;
const tags = tagsJson as unknown as FeatureTags;

export const FEATURES_VERIFIED_TAGS: readonly string[] = tags.verified_tags;
export const FEATURES_LATEST_TAG: string = tags.latest;

const snapshotOf = (tag: string): string => tags.snapshot_aliases[tag] ?? tag;

/// 每个快照 tag 的响应体（请求别名 tag 时返回其快照的同一份内容，ETag 一致）。
function buildPayload(snapshotTag: string): string {
  const data = registry.tags[snapshotTag];
  if (!data) throw new Error(`registry missing snapshot tag ${snapshotTag}`);
  const aliasesByCanonical = new Map<string, string[]>();
  for (const [legacy, canonical] of Object.entries(data.legacy_aliases)) {
    if (!canonical) continue;
    aliasesByCanonical.set(canonical, [...(aliasesByCanonical.get(canonical) ?? []), legacy]);
  }
  const flags = data.flags.map((flag) => ({
    ...flag,
    legacy_aliases: aliasesByCanonical.get(flag.key) ?? [],
    history: registry.history[flag.key] ?? null,
    annotation: annotations[flag.key] ?? null,
  }));
  return JSON.stringify({
    dataset: "codex-feature-flags",
    snapshot_tag: snapshotTag,
    applies_to: tags.verified_tags.filter((tag) => snapshotOf(tag) === snapshotTag),
    counts: {
      total: flags.length,
      annotated: flags.filter((flag) => flag.annotation !== null).length,
    },
    flags,
    source: {
      files: registry.source_files,
      license: "CC-BY-4.0 (registry + annotations); derived from openai/codex (Apache-2.0)",
      not_affiliated_with_openai: true,
    },
  });
}

const payloads = new Map<string, { body: string; etag: Promise<string> }>();

function payloadFor(tag: string): { body: string; etag: Promise<string> } {
  const snapshotTag = snapshotOf(tag);
  let entry = payloads.get(snapshotTag);
  if (!entry) {
    const body = buildPayload(snapshotTag);
    entry = { body, etag: sha256Hex(body).then((hash) => `"features-${hash.slice(0, 32)}"`) };
    payloads.set(snapshotTag, entry);
  }
  return entry;
}

export function featuresIndex(origin: string): unknown {
  const url = (tag: string) => `${origin}${FEATURES_PATH_PREFIX}${tag}.json`;
  return {
    dataset: "codex-feature-flags",
    latest: { tag: FEATURES_LATEST_TAG, url: url("latest") },
    verified_tags: FEATURES_VERIFIED_TAGS.map((tag) => ({
      tag,
      snapshot_tag: snapshotOf(tag),
      url: url(tag),
    })),
    source_files: tags.source_files,
    notes: tags.notes,
    license: {
      registry_and_annotations: "CC-BY-4.0",
      derived_from:
        "openai/codex (Apache-2.0); source snapshots in the repository under data/codex-features/sources/",
    },
  };
}

/// `latest.json` / `<tag>.json` → 该 tag（或其快照别名）的合并注册表；`index.json` → tag 列表。
export async function serveFeatures(path: string, origin: string): Promise<Response> {
  const rest = path.slice(FEATURES_PATH_PREFIX.length);
  if (rest === "index.json") {
    const body = JSON.stringify(featuresIndex(origin));
    const etag = `"features-index-${(await sha256Hex(body)).slice(0, 32)}"`;
    return jsonResponse(body, { cacheControl: CACHE_HOURLY, etag });
  }
  if (!rest.endsWith(".json")) return errorResponse(404, "not found", "not_found");
  const tag = rest.slice(0, -".json".length);
  const resolved = tag === "latest" ? FEATURES_LATEST_TAG : tag;
  if (!(TAG_RE.test(resolved) && FEATURES_VERIFIED_TAGS.includes(resolved))) {
    return errorResponse(
      404,
      `unknown or unverified Codex tag \`${tag}\`; see ${origin}${FEATURES_PATH_PREFIX}index.json`,
      "unknown_features_tag",
    );
  }
  const { body, etag } = payloadFor(resolved);
  return jsonResponse(body, { cacheControl: CACHE_HOURLY, etag: await etag });
}
