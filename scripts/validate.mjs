#!/usr/bin/env node
// 校验 data/codex-schema：schema 本身可编译；tags.json 里每个 tag 的源码快照存在；
// 快照里的 bundled models.json（Codex 二进制自带目录）必须通过 schema。
// Node ≥ 22，与 Worker 用同一个校验器（@cfworker/json-schema），保证两边对"合法"的定义一致。

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

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
