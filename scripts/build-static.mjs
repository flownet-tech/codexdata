#!/usr/bin/env node
// 把纯静态数据集预生成为 public/ 下的真实文件，交给 Workers 静态资源层直出：
// 静态资源请求不计 Worker 调用（零请求费），Worker 代码只留真正动态的镜像端点。
//   public/v1/features/codex/{latest,<tag>,index}.json   功能旗标注册表（机器层+注释合并）
//   public/v1/schema/codex-model-info/{latest,<tag>,index}.json   ModelInfo JSON Schema
//   public/_headers   /v1/* 资产的 CORS + 缓存头（平台在资产响应上应用；Worker 路由不受影响）
// 产物是提交进 git 的确定性文件；validate.mjs 用 --check 逐字节比对防漂移。
// index.json 里的绝对链接按 wrangler.jsonc 的 CODEX_MODELS_PUBLIC_ORIGIN 烘焙：
// 换域名（如 codex.help）后改该变量 → 重跑本脚本 → 重新部署。
//
// 用法：node scripts/build-static.mjs          重新生成
//       node scripts/build-static.mjs --check  只校验（与已提交文件不一致 → exit 1）

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** wrangler.jsonc 是带注释的 JSONC，只抠这一个变量，避免引解析依赖。 */
function publicOrigin() {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const m = text.match(/"CODEX_MODELS_PUBLIC_ORIGIN":\s*"(https:\/\/[^"]+)"/);
  if (!m) throw new Error("wrangler.jsonc 里找不到 CODEX_MODELS_PUBLIC_ORIGIN");
  return m[1];
}

const origin = publicOrigin();
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
/** path（相对 public/）→ 文件内容。最后统一写盘或比对。 */
const files = new Map();

// ── 功能旗标注册表（与原 src/http/features.ts 的运行时输出同构） ───────────────
{
  const dir = "v1/features/codex";
  const featuresDir = join(root, "data", "codex-features");
  const tags = readJson(join(featuresDir, "tags.json"));
  const registry = readJson(join(featuresDir, tags.registry));
  // 人工注释：每旗标一个独立文件（annotations/<key>.json，社区可贡献翻译），构建时汇总。
  const annotations = {};
  const annDir = join(featuresDir, tags.annotations);
  for (const name of readdirSync(annDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const entry = readJson(join(annDir, name));
    if (`${entry.key}.json` !== name)
      throw new Error(`annotations/${name}: key \`${entry.key}\` 与文件名不一致`);
    annotations[entry.key] = {
      ...(entry.aka ? { aka: entry.aka } : {}),
      i18n: Object.fromEntries(Object.entries(entry.i18n).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
  }
  const snapshotOf = (tag) => tags.snapshot_aliases[tag] ?? tag;

  const payloadBySnapshot = new Map();
  for (const snapshotTag of Object.keys(registry.tags)) {
    const data = registry.tags[snapshotTag];
    const aliasesByCanonical = new Map();
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
    const localeCounts = {};
    for (const flag of flags) {
      for (const locale of Object.keys(flag.annotation?.i18n ?? {})) {
        localeCounts[locale] = (localeCounts[locale] ?? 0) + 1;
      }
    }
    payloadBySnapshot.set(
      snapshotTag,
      pretty({
        dataset: "codex-feature-flags",
        snapshot_tag: snapshotTag,
        applies_to: tags.verified_tags.filter((tag) => snapshotOf(tag) === snapshotTag),
        counts: {
          total: flags.length,
          annotated: flags.filter((flag) => flag.annotation !== null).length,
          locales: Object.fromEntries(
            Object.entries(localeCounts).sort(([a], [b]) => (a < b ? -1 : 1)),
          ),
        },
        flags,
        source: {
          files: registry.source_files,
          license: "CC-BY-4.0 (registry + annotations); derived from openai/codex (Apache-2.0)",
          not_affiliated_with_openai: true,
        },
      }),
    );
  }
  for (const tag of tags.verified_tags)
    files.set(`${dir}/${tag}.json`, payloadBySnapshot.get(snapshotOf(tag)));
  files.set(`${dir}/latest.json`, payloadBySnapshot.get(snapshotOf(tags.latest)));

  const url = (tag) => `${origin}/${dir}/${tag}.json`;
  files.set(
    `${dir}/index.json`,
    pretty({
      dataset: "codex-feature-flags",
      latest: { tag: tags.latest, url: url("latest") },
      verified_tags: tags.verified_tags.map((tag) => ({
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
    }),
  );
}

// ── ModelInfo JSON Schema（与原 src/http/schema.ts 同构：所有 tag 同一份） ────
{
  const dir = "v1/schema/codex-model-info";
  const schemaDir = join(root, "data", "codex-schema");
  const tags = readJson(join(schemaDir, "tags.json"));
  const schemaText = pretty(readJson(join(schemaDir, tags.schema)));
  for (const tag of tags.verified_tags) files.set(`${dir}/${tag}.json`, schemaText);
  files.set(`${dir}/latest.json`, schemaText);

  const url = (tag) => `${origin}/${dir}/${tag}.json`;
  files.set(
    `${dir}/index.json`,
    pretty({
      schema: "codex-model-info",
      latest: { tag: tags.latest, url: url("latest") },
      verified_tags: tags.verified_tags.map((tag) => ({ tag, url: url(tag) })),
      source_files: tags.source_files,
      notes: tags.notes,
      license: {
        schema: "CC-BY-4.0",
        derived_from:
          "openai/codex (Apache-2.0); source snapshots in the repository under data/codex-schema/sources/",
      },
    }),
  );
}

// ── /v1/* 资产响应头（只作用于静态资源层；Worker 动态路由的头在代码里） ────────
files.set(
  "_headers",
  `/v1/*
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Access-Control-Allow-Headers: If-None-Match, Content-Type
  Access-Control-Expose-Headers: ETag
  Cache-Control: public, max-age=3600, stale-while-revalidate=86400, stale-if-error=86400
`,
);

// ── 写盘 / 校验（管理的目录内多出来的文件也算漂移，防止旧 tag 残留） ──────────
const managedDirs = ["v1/features/codex", "v1/schema/codex-model-info"];
const problems = [];
for (const [rel, content] of files) {
  const path = join(publicDir, rel);
  let existing = null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* 缺文件按不一致处理 */
  }
  if (existing !== content) problems.push(`stale or missing: public/${rel}`);
}
for (const dir of managedDirs) {
  let names = [];
  try {
    names = readdirSync(join(publicDir, dir));
  } catch {
    continue;
  }
  for (const name of names) {
    const rel = `${dir}/${name}`;
    if (!files.has(rel)) problems.push(`unmanaged extra file: public/${rel}`);
  }
}

if (process.argv.includes("--check")) {
  if (problems.length > 0) {
    console.error(
      `✗ public/ 静态产物与数据源不一致；运行 scripts/build-static.mjs 重新生成\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`✓ public/ 静态产物与数据源一致（${files.size} 个文件）`);
} else {
  for (const [rel, content] of files) {
    const path = join(publicDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`written: ${files.size} files under ${relative(root, publicDir)}/`);
}
