#!/usr/bin/env node
// 校验 data/codex-schema：schema 本身可编译；tags.json 里每个 tag 的源码快照存在；
// 快照里的 bundled models.json（Codex 二进制自带目录）必须通过 schema。
// 另校验 data/codex-features：源码快照齐全；registry.json 与提取脚本输出一致（确定性）；
// annotations.json 过自身 schema 且每个键都真实存在于注册表。
// Node ≥ 22，与 Worker 用同一个校验器（@cfworker/json-schema），保证两边对"合法"的定义一致。

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "data", "codex-schema");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

const tags = readJson(join(schemaDir, "tags.json"));
const schemaPath = join(schemaDir, tags.schema);
const schema = readJson(schemaPath);
const validator = new Validator(schema, "2020-12", false);
ok(`schema compiled: ${tags.schema}`);

if (!tags.verified_tags.includes(tags.latest))
  fail(`latest tag ${tags.latest} not in verified_tags`);

for (const tag of tags.verified_tags) {
  const dir = join(schemaDir, "sources", tag);
  // 0.153.1 与 0.153.4 的源码逐字节相同，只保留 0.153.4 的快照。
  if (tag === "rust-v0.153.1") continue;
  for (const file of tags.source_files) {
    const name = file.split("/").pop();
    if (!existsSync(join(dir, name))) fail(`${tag}: missing source snapshot ${name}`);
  }
  const bundled = join(dir, "models.json");
  if (existsSync(bundled)) {
    const result = validator.validate(readJson(bundled));
    if (result.valid)
      ok(`${tag}/models.json validates (${readJson(bundled).models.length} models)`);
    else {
      const first = result.errors
        .slice()
        .sort((a, b) => b.instanceLocation.length - a.instanceLocation.length)[0];
      fail(`${tag}/models.json rejected: ${first.instanceLocation} ${first.error}`);
    }
  }
}

// 反例：任一封闭枚举拼错必须被拒（否则 schema 退化成"存在性检查"）。
const sample = readJson(join(schemaDir, "sources", tags.latest, "models.json")).models[0];
const negatives = {
  "shell_type typo": { ...sample, shell_type: "shell" },
  "empty effort": { ...sample, supported_reasoning_levels: [{ effort: "", description: "x" }] },
  "no prompt": { ...sample, base_instructions: undefined, model_messages: null },
};
for (const [label, model] of Object.entries(negatives)) {
  const result = validator.validate({ models: [JSON.parse(JSON.stringify(model))] });
  if (result.valid) fail(`negative case accepted: ${label}`);
  else ok(`negative case rejected: ${label}`);
}

// ── data/codex-features ──────────────────────────────────────────────────────
const featuresDir = join(root, "data", "codex-features");
const ftags = readJson(join(featuresDir, "tags.json"));

if (!ftags.verified_tags.includes(ftags.latest))
  fail(`features: latest tag ${ftags.latest} not in verified_tags`);
for (const [alias, target] of Object.entries(ftags.snapshot_aliases)) {
  if (!ftags.verified_tags.includes(alias) || !ftags.verified_tags.includes(target))
    fail(`features: snapshot alias ${alias} -> ${target} references unverified tag`);
}
if (!existsSync(join(featuresDir, "sources", "legacy.rs")))
  fail("features: missing source snapshot sources/legacy.rs");
for (const tag of ftags.verified_tags) {
  if (tag in ftags.snapshot_aliases) continue; // 与快照 tag 逐字节相同，不单独存
  if (!existsSync(join(featuresDir, "sources", tag, "lib.rs")))
    fail(`features: missing source snapshot sources/${tag}/lib.rs`);
}

// registry.json 必须与提取脚本对源码快照的输出逐字节一致（防手改/防漂移）。
const extract = spawnSync(
  process.execPath,
  [join(root, "scripts", "extract-features.mjs"), "--check"],
  { encoding: "utf8" },
);
if (extract.status === 0) ok("features: registry.json matches extractor output");
else fail(`features: registry.json out of date\n${extract.stderr || extract.stdout}`.trim());

const registry = readJson(join(featuresDir, ftags.registry));
const annotations = readJson(join(featuresDir, ftags.annotations));
const annotationsSchema = readJson(join(featuresDir, "annotations.schema.json"));
const annValidator = new Validator(annotationsSchema, "2020-12", false);
const annResult = annValidator.validate(annotations);
if (annResult.valid) ok("features: annotations.json validates against its schema");
else {
  const first = annResult.errors
    .slice()
    .sort((a, b) => b.instanceLocation.length - a.instanceLocation.length)[0];
  fail(`features: annotations.json rejected: ${first.instanceLocation} ${first.error}`);
}

const knownKeys = new Set(Object.keys(registry.history));
const phantom = Object.keys(annotations).filter((key) => !knownKeys.has(key));
if (phantom.length > 0) fail(`features: annotations for unknown flags: ${phantom.join(", ")}`);
else ok(`features: all ${Object.keys(annotations).length} annotation keys exist in the registry`);

const latestSnapshot = ftags.snapshot_aliases[ftags.latest] ?? ftags.latest;
const latestFlags = registry.tags[latestSnapshot].flags;
const unannotated = latestFlags.filter((flag) => !(flag.key in annotations)).map((f) => f.key);
// 新 tag 引入新旗标时注释会暂缺：只提示不失败（缺口是常态，UI 侧按未收录降级）。
if (unannotated.length > 0)
  console.log(
    `⚠ features: ${unannotated.length} flag(s) at ${ftags.latest} not yet annotated: ${unannotated.join(", ")}`,
  );
else ok(`features: every flag at ${ftags.latest} annotated (${latestFlags.length} flags)`);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
