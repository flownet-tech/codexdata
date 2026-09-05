import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { outboundMock } from "./test/outbound-mock.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // 测试里注入的假 secret；生产用 `wrangler secret put`。
        bindings: {
          REFRESH_TOKEN_KEK: "dGVzdC1rZWstMzItYnl0ZXMtdGVzdC1rZWstMzItYnk=",
          ADMIN_TOKEN: "test-admin-token",
        },
        // 接管所有出站 fetch（含 DO 内的 OAuth 刷新）：测试绝不真的出网。
        outboundService: outboundMock,
        // 测试里关掉 Cache API：它由 Miniflare 内部 DO 实现，`reset()` 会把在途的
        // waitUntil(cache.put) 打断成一串无害但刺眼的 uncaught exception。
        cacheAPI: false,
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
