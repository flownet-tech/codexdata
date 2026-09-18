#!/usr/bin/env node
// Codex 兼容探针：对一个 Codex CLI 版本下载官方 npm 平台包，提取硬事实：
//   1. tracked.json 里每个 probe=binary-string 键名是否仍存在于二进制（serde 字段名字符串）；
//      从有到无 = 该键极可能已被上游移除（disable_response_storage 实证过这条推理）。
//   2. 二进制里面向用户的废弃/迁移提示（"no longer supported" / "is deprecated"）。
//   3. 配置可加载性：用 Codex Pass 托管的全部形状拼一份 config.toml，跑 `codex features list`
//      —— 0.148/0.149 那类"整份拒载"会在这里翻车。
//   4. GitHub release notes（rust-v<version> tag）。
// 结果写入 data/codex-compat/probes/<version>.json（每版本一次，幂等）。
//
// 用法：node scripts/compat-probe.mjs                 探测 npm dist-tags 里 latest 与 alpha 中未探测过的版本
//       node scripts/compat-probe.mjs --version 0.155.1 [--force]
// 退出码：0 = 无新版本或探测通过；20 = 发现回归（键消失 / 配置拒载），供 workflow 开 issue；1 = 脚本失败。

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compatDir = join(root, "data", "codex-compat");
const probesDir = join(compatDir, "probes");
const tracked = JSON.parse(readFileSync(join(compatDir, "tracked.json"), "utf8"));

const NPM_PACKAGE = "@openai/codex";
const REGISTRY = "https://registry.npmjs.org";
// 面向用户的废弃提示;排除 Rust 生态噪音（Error::description、依赖源码路径等）。
const DEPRECATION_RE = /no longer supported|is deprecated/;
const DEPRECATION_NOISE =
  /description\(\) is deprecated|cargo\/registry|serde_yaml|deprecated_time_unit|\\b\(\{\{attributes\}\}/;

function platformSuffix() {
  const os = { darwin: "darwin", linux: "linux", win32: "win32" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** 版本三元组（忽略 prerelease，与客户端 codex_client_gate 的约定一致）。 */
function versionCore(version) {
  const core = version.split(/[-+]/)[0];
  const parts = core.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts;
}

function compareCore(a, b) {
  const ca = versionCore(a);
  const cb = versionCore(b);
  for (let i = 0; i < 3; i += 1) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  return 0;
}

function isStable(version) {
  return !version.includes("-");
}

/** 下载平台包并解出 codex 二进制路径；返回 { binary, cleanup }。 */
function downloadBinary(version, suffix) {
  const workDir = mkdtempSync(join(tmpdir(), "codex-compat-"));
  const tarball = `${REGISTRY}/${NPM_PACKAGE}/-/codex-${version}-${suffix}.tgz`;
  const tgzPath = join(workDir, "pkg.tgz");
  execFileSync("curl", ["-fsSL", "--max-time", "300", "-o", tgzPath, tarball], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  execFileSync("tar", ["-xzf", tgzPath, "-C", workDir], { stdio: "inherit" });
  const vendor = join(workDir, "package", "vendor");
  const target = readdirSync(vendor).find((name) => existsSync(join(vendor, name, "bin", "codex")));
  if (!target) throw new Error(`no codex binary found under ${vendor}`);
  return {
    binary: join(vendor, target, "bin", "codex"),
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}

/** 从符号表大字符串里把废弃提示还原成稳定、可读的句子：
 *  向后扫描只允许小写/数字/snake_case/引号等消息字符（遇大写字母或反引号即止——
 *  反引号几乎总是消息开头的 token 定界），向前扫描到句号或「小写+大写+小写」的
 *  字符串粘连边界。跨版本符号表重排时同一条消息仍归一到同一文本。 */
function normalizeDeprecation(text, at) {
  const headChars = /[a-z0-9_ ."'=,;:()[\]-]/;
  let start = at;
  while (start > 0 && at - start < 120) {
    const ch = text[start - 1];
    if (ch === "`") {
      start -= 1;
      break;
    }
    if (!headChars.test(ch)) break;
    start -= 1;
  }
  let end = at;
  const max = Math.min(text.length, at + 160);
  while (end < max) {
    const ch = text[end];
    if (ch === ".") {
      end += 1;
      break;
    }
    if (
      /[A-Z]/.test(ch) &&
      end > start &&
      /[a-z]/.test(text[end - 1]) &&
      end + 1 < text.length &&
      /[a-z]/.test(text[end + 1]) &&
      end - at > 40
    )
      break;
    if (!/[a-zA-Z0-9_ ."'`=,;:()[\]-]/.test(ch)) break;
    end += 1;
  }
  return text.slice(start, end).trim();
}

/** 提取二进制里的 ASCII 字符串（≥ minLen），归一化后只保留匹配 pattern 的消息。 */
function scanStrings(buffer, minLen, pattern, noise) {
  const found = new Set();
  let start = -1;
  for (let i = 0; i <= buffer.length; i += 1) {
    const byte = i < buffer.length ? buffer[i] : 0;
    const printable = byte >= 0x20 && byte < 0x7f;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= minLen) {
        const text = buffer.toString("latin1", start, i);
        if (!noise.test(text)) {
          const globalPattern = new RegExp(pattern.source, "g");
          for (const match of text.matchAll(globalPattern)) {
            found.add(normalizeDeprecation(text, match.index));
          }
        }
      }
      start = -1;
    }
  }
  return [...found].sort().slice(0, 60);
}

/** 用托管形状拼 config.toml，跑 `codex features list` 验证整份配置仍可加载。 */
function probeConfigLoad(binary) {
  const home = mkdtempSync(join(tmpdir(), "codex-compat-home-"));
  const config = `
model_provider = "codex-pass"
chatgpt_base_url = "https://chatgpt.com/backend-api/"
web_search = "cached"
check_for_update_on_startup = false
approval_policy = "on-request"
sandbox_mode = "workspace-write"
hide_agent_reasoning = false
project_doc_max_bytes = 32768

[model_providers.codex-pass]
name = "Codex Pass"
base_url = "http://127.0.0.1:11433/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "probe-token"

[model_providers.codex-pass.http_headers]
x-codex-pass = "probe"

[features]

[analytics]
enabled = false

[desktop]
composerEnterBehavior = "send"
`;
  writeFileSync(join(home, "config.toml"), config);
  try {
    const result = spawnSync(binary, ["features", "list"], {
      env: { ...process.env, CODEX_HOME: home, RUST_LOG: "error" },
      timeout: 30_000,
      encoding: "utf8",
    });
    return {
      configLoad: result.status === 0 ? "ok" : "fail",
      exitCode: result.status,
      stderrExcerpt: (result.stderr ?? "").trim().slice(0, 800) || null,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function releaseNotes(version) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "codexdata-compat-probe" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const release = await fetchJson(
      `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`,
      headers,
    );
    return { url: release.html_url ?? null, publishedAt: release.published_at ?? null };
  } catch {
    return { url: null, publishedAt: null };
  }
}

/** 已探测的稳定版里，小于 version 的最大者（回归对比基线）。 */
function previousStableProbe(version) {
  if (!existsSync(probesDir)) return null;
  const candidates = readdirSync(probesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .filter((v) => isStable(v) && compareCore(v, version) < 0)
    .sort(compareCore);
  const prev = candidates.at(-1);
  return prev ? JSON.parse(readFileSync(join(probesDir, `${prev}.json`), "utf8")) : null;
}

async function probeVersion(version) {
  const suffix = platformSuffix();
  console.log(`probing ${NPM_PACKAGE}@${version} (${suffix})`);
  const { binary, cleanup } = downloadBinary(version, suffix);
  try {
    const versionOut = spawnSync(binary, ["--version"], { timeout: 15_000, encoding: "utf8" });
    if (versionOut.status !== 0) throw new Error(`codex --version failed: ${versionOut.stderr}`);
    const buffer = readFileSync(binary);
    const keyPresence = {};
    for (const entry of tracked.keys) {
      if (entry.probe === "none") continue;
      const needle = entry.needle ?? entry.key;
      keyPresence[entry.key] = buffer.includes(Buffer.from(needle, "latin1"));
    }
    const deprecations = scanStrings(buffer, 12, DEPRECATION_RE, DEPRECATION_NOISE);
    const load = probeConfigLoad(binary);
    const notes = await releaseNotes(version);

    const regressions = [];
    if (load.configLoad !== "ok")
      regressions.push(`config-load: ${load.configLoad} (exit ${load.exitCode})`);
    const baseline = previousStableProbe(version);
    let deprecationDiff = [];
    if (baseline) {
      for (const [key, present] of Object.entries(keyPresence)) {
        if (!present && baseline.keyPresence?.[key] === true)
          regressions.push(`key-missing: ${key}`);
      }
      // 废弃提示 diff 只作情报，不算回归。符号表里 token 边界已丢失，展示文本首尾会随
      // 相邻字符串漂移；比对时锚定「废弃短语 ± 24 字符」的核心，跨版本才稳定。
      const coreOf = (line) => {
        const at = line.search(DEPRECATION_RE);
        return at < 0 ? line : line.slice(Math.max(0, at - 24), at + 40);
      };
      const known = new Set((baseline.deprecations ?? []).map(coreOf));
      deprecationDiff = deprecations.filter((line) => !known.has(coreOf(line)));
    }

    return {
      version,
      channel: isStable(version) ? "stable" : "alpha",
      platform: suffix,
      probedAt: new Date().toISOString(),
      publishedAt: notes.publishedAt,
      releaseNotesUrl: notes.url,
      reportedVersion: versionOut.stdout.trim(),
      keyPresence,
      deprecations,
      deprecationDiff,
      configLoad: load.configLoad,
      configLoadExit: load.exitCode,
      configLoadStderr: load.stderrExcerpt,
      regressions,
    };
  } finally {
    cleanup();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const versionArg = args.includes("--version") ? args[args.indexOf("--version") + 1] : null;
  const force = args.includes("--force");

  let targets = [];
  if (versionArg) {
    targets = [versionArg];
  } else {
    const meta = await fetchJson(`${REGISTRY}/${NPM_PACKAGE}`, {
      accept: "application/vnd.npm.install-v1+json",
    });
    targets = [meta["dist-tags"].latest, meta["dist-tags"].alpha].filter(Boolean);
  }

  mkdirSync(probesDir, { recursive: true });
  let sawRegression = false;
  let probedAny = false;
  for (const version of targets) {
    if (!versionCore(version)) {
      console.warn(`skip ${version}: unparsable version`);
      continue;
    }
    const outPath = join(probesDir, `${version}.json`);
    if (existsSync(outPath) && !force) {
      console.log(`skip ${version}: already probed`);
      continue;
    }
    const probe = await probeVersion(version);
    writeFileSync(outPath, `${JSON.stringify(probe, null, 2)}\n`);
    probedAny = true;
    console.log(
      `wrote probes/${version}.json (configLoad=${probe.configLoad}, regressions=${probe.regressions.length})`,
    );
    for (const regression of probe.regressions) console.warn(`  !! ${regression}`);
    if (probe.channel === "stable" && probe.regressions.length > 0) sawRegression = true;
  }
  if (!probedAny) console.log("nothing new to probe");
  process.exit(sawRegression ? 20 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
