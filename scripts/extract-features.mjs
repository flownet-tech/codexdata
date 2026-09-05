#!/usr/bin/env node
// 从 data/codex-features/sources/ 的客户端源码快照提取功能旗标注册表 → registry.json。
// 解析目标（见 tags.json.notes）：`pub enum Feature` 的 rustdoc、`pub const FEATURES` 表
// （key / stage / default_enabled / Experimental 的官方菜单文案）、legacy.rs 的旧键别名。
// 解析是逐块严格校验的：任何一个 FeatureSpec 块缺字段、或与 `FeatureSpec {` 计数对不上，
// 直接报错退出——上游改了写法时宁可失败也不产出错数据。
//
// 用法：node scripts/extract-features.mjs        重新生成 registry.json
//       node scripts/extract-features.mjs --check 只校验（生成结果与已提交文件不一致 → exit 1）

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = join(root, "data", "codex-features");
const tags = JSON.parse(readFileSync(join(featuresDir, "tags.json"), "utf8"));

const STAGE_NAMES = {
  UnderDevelopment: "under development",
  Stable: "stable",
  Experimental: "experimental",
  Deprecated: "deprecated",
  Removed: "removed",
};

/** Rust 字符串字面量 → JS 字符串（只处理源码里实际出现的常见转义）。 */
function unescapeRust(raw) {
  return raw.replace(/\\(["'\\nrt0])/g, (_, c) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c === "0" ? "\0" : c,
  );
}

/** 取单个字符串字段：`name: "..."`（必须单行；捕获组处理 \" 转义）。 */
function stringField(block, field, context) {
  const m = block.match(new RegExp(`${field}: "((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) throw new Error(`${context}: 缺少字符串字段 ${field}`);
  return unescapeRust(m[1]);
}

/** 解析 `pub enum Feature { ... }`：变体名 → rustdoc（多行合并为一段）。 */
function parseEnumDocs(text) {
  const start = text.indexOf("pub enum Feature {");
  if (start < 0) throw new Error("找不到 `pub enum Feature {`");
  const end = text.indexOf("\n}", start);
  const body = text.slice(start, end);
  const docs = new Map();
  let buf = [];
  for (const line of body.split("\n")) {
    const doc = line.match(/^\s*\/\/\/ ?(.*)$/);
    if (doc) {
      buf.push(doc[1]);
      continue;
    }
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (variant) {
      docs.set(variant[1], buf.length > 0 ? buf.join(" ").replace(/\s+/g, " ").trim() : null);
      buf = [];
    }
    // 普通 `//` 分组注释、空行：忽略（rustdoc 与变体之间不允许隔空行，无脏挂载风险）。
  }
  if (docs.size === 0) throw new Error("enum Feature 未解析出任何变体");
  return docs;
}

/** 解析 `pub const FEATURES: &[FeatureSpec] = &[ ... ];` 表。 */
function parseFeaturesTable(text, docs) {
  const start = text.indexOf("pub const FEATURES: &[FeatureSpec] = &[");
  if (start < 0) throw new Error("找不到 `pub const FEATURES`");
  const end = text.indexOf("\n];", start);
  const body = text.slice(start, end);
  const expected = (body.match(/FeatureSpec \{/g) ?? []).length;

  const flags = [];
  // 条目边界：4 空格缩进的 `    FeatureSpec {` 到 4 空格缩进的 `    },`（嵌套的
  // Stage::Experimental { ... } 收在 8 空格缩进，不会误切）。
  const entryRe = /^ {4}FeatureSpec \{\n([\s\S]*?)^ {4}\},$/gm;
  for (const [, block] of body.matchAll(entryRe)) {
    const context = block.trim().split("\n")[0];
    const id = block.match(/id: Feature::([A-Za-z0-9]+),/);
    const key = block.match(/key: "([a-z0-9_]+)",/);
    const def = block.match(/default_enabled: (true|false|[a-z_!()"= ]+),/);
    if (!id || !key || !def) throw new Error(`FeatureSpec 块缺字段: ${context}`);
    if (!docs.has(id[1])) throw new Error(`FEATURES 引用了 enum 里不存在的变体 ${id[1]}`);

    let stage;
    let experimental = null;
    let stageCondition = null;
    let stageFallback = null;
    const stageOf = (body, allowExperimental) => {
      const plain = body.match(/Stage::(UnderDevelopment|Stable|Deprecated|Removed)/);
      if (plain) return { stage: STAGE_NAMES[plain[1]], experimental: null };
      if (allowExperimental && body.includes("Stage::Experimental {")) {
        return {
          stage: STAGE_NAMES.Experimental,
          experimental: {
            name: stringField(body, "name", context),
            menu_description: stringField(body, "menu_description", context),
            announcement: stringField(body, "announcement", context) || null,
          },
        };
      }
      throw new Error(`无法识别 stage: ${context}`);
    };
    if (block.includes("stage: if cfg!(")) {
      // 平台条件 stage（如 prevent_idle_sleep）：stage 取 cfg 为真分支（列出的桌面平台），
      // 条件原文与 else 分支如实保留在 stage_condition / stage_fallback。
      const ifStart = block.indexOf("stage: if ");
      const condEnd = block.indexOf(") {", ifStart) + 1;
      const elseStart = block.indexOf("} else {", condEnd);
      const stageEnd = block.indexOf("\n        },", elseStart);
      if (condEnd === 0 || elseStart < 0 || stageEnd < 0)
        throw new Error(`条件 stage 结构不符合预期: ${context}`);
      stageCondition = block
        .slice(ifStart + "stage: if ".length, condEnd)
        .replace(/\s+/g, " ")
        .trim();
      const ifBranch = stageOf(block.slice(condEnd, elseStart), true);
      stage = ifBranch.stage;
      experimental = ifBranch.experimental;
      stageFallback = stageOf(block.slice(elseStart, stageEnd), false).stage;
    } else {
      const plain = block.match(/stage: Stage::(UnderDevelopment|Stable|Deprecated|Removed),/);
      if (plain) {
        stage = STAGE_NAMES[plain[1]];
      } else if (block.includes("stage: Stage::Experimental {")) {
        const parsed = stageOf(block, true);
        stage = parsed.stage;
        experimental = parsed.experimental;
      } else {
        throw new Error(`无法识别 stage: ${context}`);
      }
    }

    const flag = {
      key: key[1],
      variant: id[1],
      stage,
      default_enabled: def[1] === "true" ? true : def[1] === "false" ? false : null,
      doc: docs.get(id[1]),
      experimental,
    };
    if (flag.default_enabled === null) flag.default_expr = def[1];
    if (stageCondition) {
      flag.stage_condition = stageCondition;
      flag.stage_fallback = stageFallback;
    }
    flags.push(flag);
  }
  if (flags.length !== expected)
    throw new Error(`FEATURES 表解析不完整: 预期 ${expected} 条, 实得 ${flags.length}`);
  const dup = flags.map((f) => f.key).find((k, i, all) => all.indexOf(k) !== i);
  if (dup) throw new Error(`旗标键重复: ${dup}`);
  flags.sort((a, b) => (a.key < b.key ? -1 : 1));
  return flags;
}

/** legacy.rs 的 `ALIASES`：旧配置键 → Feature 变体名。 */
function parseLegacyAliases(text) {
  const aliases = [];
  for (const [, legacyKey, variant] of text.matchAll(
    /legacy_key: "([a-z0-9_]+)",\s*feature: Feature::([A-Za-z0-9]+),/g,
  )) {
    aliases.push({ legacyKey, variant });
  }
  const expected = (text.match(/legacy_key: "/g) ?? []).length;
  if (aliases.length !== expected)
    throw new Error(`legacy ALIASES 解析不完整: 预期 ${expected}, 实得 ${aliases.length}`);
  return aliases;
}

// ── 提取每个快照 tag ─────────────────────────────────────────────────────────
const legacyAliases = parseLegacyAliases(
  readFileSync(join(featuresDir, "sources", "legacy.rs"), "utf8"),
);
const snapshotTags = tags.verified_tags.filter((tag) => !(tag in tags.snapshot_aliases));
const byTag = {};
for (const tag of snapshotTags) {
  const text = readFileSync(join(featuresDir, "sources", tag, "lib.rs"), "utf8");
  const flags = parseFeaturesTable(text, parseEnumDocs(text));
  const variantToKey = new Map(flags.map((f) => [f.variant, f.key]));
  const legacy = {};
  for (const { legacyKey, variant } of legacyAliases) {
    // 该 tag 没有对应变体（旧别名指向后来才出现/已删除的旗标）→ null，保留事实。
    legacy[legacyKey] = variantToKey.get(variant) ?? null;
  }
  byTag[tag] = {
    flags,
    legacy_aliases: Object.fromEntries(Object.entries(legacy).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

// ── 跨 tag 历史（按 verified_tags 顺序；别名 tag 视同其快照） ─────────────────
const orderedTags = tags.verified_tags;
const snapshotOf = (tag) => tags.snapshot_aliases[tag] ?? tag;
const history = {};
for (const tag of orderedTags) {
  for (const flag of byTag[snapshotOf(tag)].flags) {
    const entry = (history[flag.key] ??= {
      first_seen: tag,
      last_seen: tag,
      stages: [{ at: tag, stage: flag.stage }],
    });
    entry.last_seen = tag;
    if (entry.stages.at(-1).stage !== flag.stage) entry.stages.push({ at: tag, stage: flag.stage });
  }
}
for (const [key, entry] of Object.entries(history)) {
  // 从表里整个消失（不是标 removed，是键被删）也是事实：记 delisted_after。
  if (entry.last_seen !== orderedTags.at(-1)) entry.delisted_after = entry.last_seen;
  history[key] = entry;
}

const registry = {
  generated_by: "scripts/extract-features.mjs",
  source_files: tags.source_files,
  tags: Object.fromEntries(snapshotTags.map((tag) => [tag, byTag[tag]])),
  history: Object.fromEntries(Object.entries(history).sort(([a], [b]) => (a < b ? -1 : 1))),
};
const output = `${JSON.stringify(registry, null, 2)}\n`;

const registryPath = join(featuresDir, tags.registry);
if (process.argv.includes("--check")) {
  let committed = null;
  try {
    committed = readFileSync(registryPath, "utf8");
  } catch {
    /* 缺文件按不一致处理 */
  }
  if (committed !== output) {
    console.error(
      "✗ registry.json 与源码快照的提取结果不一致；运行 scripts/extract-features.mjs 重新生成",
    );
    process.exit(1);
  }
  console.log(`✓ registry.json 与提取结果一致（${snapshotTags.length} 个快照 tag）`);
} else {
  writeFileSync(registryPath, output);
  for (const tag of snapshotTags) {
    const { flags } = byTag[tag];
    const stages = flags.reduce((acc, f) => ((acc[f.stage] = (acc[f.stage] ?? 0) + 1), acc), {});
    console.log(`${tag}: ${flags.length} flags ${JSON.stringify(stages)}`);
  }
  console.log(`written: ${registryPath}`);
}
