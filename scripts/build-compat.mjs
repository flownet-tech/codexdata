#!/usr/bin/env node
// 把 data/codex-compat/ 的三类事实合成对外的兼容情报 JSON：
//   tracked.json（托管键清单+人工裁定） + probes/<version>.json（探针硬事实） + advisories/*.json（人工通告）
//   → public/v1/compat/codex/latest.json
// 键状态推导：statusOverride 优先；否则 probe=none → unprobed；最新稳定版探到 → active；
// 早期版本探到、最新版消失 → missing（附 firstMissingIn，等人工确认成 removed）；从未探到 → missing。
// 产物是确定性的（无时间戳），--check 逐字节比对防漂移；发布时间由 KV 发布端点记录。
//
// 用法：node scripts/build-compat.mjs          重新生成
//       node scripts/build-compat.mjs --check  只校验（与已提交文件不一致 → exit 1）

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compatDir = join(root, "data", "codex-compat");
const outPath = join(root, "public", "v1", "compat", "codex", "latest.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function versionCore(version) {
  const parts = version
    .split(/[-+]/)[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10));
  return parts.length === 3 && parts.every((p) => Number.isFinite(p) && p >= 0) ? parts : null;
}
const compareCore = (a, b) => {
  const ca = versionCore(a);
  const cb = versionCore(b);
  for (let i = 0; i < 3; i += 1) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  return 0;
};

const tracked = readJson(join(compatDir, "tracked.json"));
const probes = readdirSync(join(compatDir, "probes"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => readJson(join(compatDir, "probes", name)))
  .sort((a, b) => compareCore(a.version, b.version) || a.version.localeCompare(b.version));
const advisories = readdirSync(join(compatDir, "advisories"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    const advisory = readJson(join(compatDir, "advisories", name));
    if (`${advisory.id}.json` !== name)
      throw new Error(`advisories/${name}: id \`${advisory.id}\` 与文件名不一致`);
    return advisory;
  });

const stable = probes.filter((p) => p.channel === "stable");
if (stable.length === 0) throw new Error("没有任何稳定版探针数据");
const latestStable = stable.at(-1);
const alphas = probes.filter((p) => p.channel === "alpha");
const latestAlpha = alphas.at(-1) ?? null;

const keys = tracked.keys.map((entry) => {
  const out = { key: entry.key, table: entry.table };
  if (entry.risk) out.risk = entry.risk;
  if (entry.note) out.note = entry.note;
  if (entry.statusOverride) {
    out.status = entry.statusOverride;
    out.removedIn = entry.removedIn ?? null;
  } else if (entry.probe === "none") {
    out.status = "unprobed";
  } else if (latestStable.keyPresence[entry.key] === true) {
    out.status = "active";
  } else {
    out.status = "missing";
    const lastPresent = stable.filter((p) => p.keyPresence[entry.key] === true).at(-1);
    const firstMissing = stable.find(
      (p) =>
        p.keyPresence[entry.key] === false &&
        (!lastPresent || compareCore(p.version, lastPresent.version) > 0),
    );
    out.firstMissingIn = firstMissing?.version ?? null;
  }
  if (entry.action) out.action = entry.action;
  return out;
});

const payload = {
  schemaVersion: 1,
  dataset: "codex-compat",
  codex: {
    latestStable: latestStable.version,
    latestAlpha: latestAlpha?.version ?? null,
    maxProbedStable: latestStable.version,
  },
  keys,
  advisories: advisories.map((a) => ({
    id: a.id,
    severity: a.severity,
    kind: a.kind,
    status: a.status,
    clientAction: a.clientAction,
    affects: a.affects,
    ...(a.keys?.length ? { keys: a.keys } : {}),
    ...(a.codexPassFixedIn ? { codexPassFixedIn: a.codexPassFixedIn } : {}),
    ...(a.links?.length ? { links: a.links } : {}),
    i18n: Object.fromEntries(Object.entries(a.i18n).sort(([x], [y]) => (x < y ? -1 : 1))),
  })),
  versions: probes.map((p) => ({
    version: p.version,
    channel: p.channel,
    publishedAt: p.publishedAt ?? null,
    probedAt: p.probedAt,
    platform: p.platform,
    configLoad: p.configLoad,
    regressions: p.regressions,
    deprecations: p.deprecationDiff ?? [],
    releaseNotesUrl: p.releaseNotesUrl ?? null,
  })),
};

const schema = readJson(join(compatDir, "compat.schema.json"));
const result = new Validator(schema, "2020-12", false).validate(payload);
if (!result.valid) {
  console.error(JSON.stringify(result.errors, null, 2));
  throw new Error("生成的 compat payload 未通过自身 schema");
}

const text = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = null;
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    /* missing = drift */
  }
  if (current !== text) {
    console.error(`✗ ${outPath} 与数据源不一致，请重跑 node scripts/build-compat.mjs`);
    process.exit(1);
  }
  console.log("✓ compat 产物与数据源一致");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath}`);
}
