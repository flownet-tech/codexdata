import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // 测试里注入的假 secret；生产用 `wrangler secret put`。
        miniflare: {
          bindings: {
            REFRESH_TOKEN_KEK: "dGVzdC1rZWstMzItYnl0ZXMtdGVzdC1rZWstMzItYnk=",
            ADMIN_TOKEN: "test-admin-token",
          },
        },
      },
    },
  },
});
