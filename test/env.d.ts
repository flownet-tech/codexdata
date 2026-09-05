declare module "cloudflare:test" {
  // 让 `env` 在测试里带上 wrangler 生成的 Env 类型（含 secrets 声明合并）。
  interface ProvidedEnv extends Env {}
}
