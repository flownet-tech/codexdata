// Secrets 不在 wrangler.jsonc 里声明（`wrangler secret put`），`wrangler types`
// 生成的 Env 不含它们；在这里以声明合并补上。生成文件同时定义了
// `Cloudflare.Env` 与全局 `Env`（后者继承前者的基类），两处都要合并，
// `cloudflare:test` 的 `env` 用的是 `Cloudflare.Env`。
interface ModeldexSecrets {
  REFRESH_TOKEN_KEK: string;
  ADMIN_TOKEN: string;
  SYNC_MODE?: string;
}

declare namespace Cloudflare {
  interface Env extends ModeldexSecrets {}
}

interface Env extends ModeldexSecrets {}
