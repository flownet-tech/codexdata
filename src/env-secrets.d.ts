// Secrets 不在 wrangler.jsonc 里声明（`wrangler secret put`），`wrangler types`
// 生成的 Env 不含它们；在这里以声明合并补上。
interface Env {
  REFRESH_TOKEN_KEK: string;
  ADMIN_TOKEN: string;
}
