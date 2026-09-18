#!/usr/bin/env node
// 把 public/v1/compat/codex/latest.json POST 到 Worker 的 /admin/compat/publish（KV 热更新，
// 不需要重新部署）。由 compat-watch workflow 在探针产出变化后调用；也可本地手动执行。
// 环境：CODEX_MODELS_ORIGIN（默认 https://data.cp.dev）、CODEX_MODELS_ADMIN_TOKEN（必填）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.CODEX_MODELS_ORIGIN ?? "https://data.cp.dev";
const token = process.env.CODEX_MODELS_ADMIN_TOKEN;
if (!token) {
  console.error("CODEX_MODELS_ADMIN_TOKEN is required");
  process.exit(1);
}

const payload = readFileSync(join(root, "public", "v1", "compat", "codex", "latest.json"), "utf8");
const response = await fetch(`${origin}/admin/compat/publish`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: payload,
});
const body = await response.text();
console.log(`POST /admin/compat/publish -> HTTP ${response.status}`);
console.log(body.slice(0, 500));
if (!response.ok) process.exit(1);
