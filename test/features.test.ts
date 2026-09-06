import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import annotations from "../data/codex-features/annotations.json";
import registry from "../data/codex-features/registry.json";
import tags from "../data/codex-features/tags.json";

// 这些端点是 build-static.mjs 预生成的静态资产（资产请求不计 Worker 调用）；
// 只有未命中（未知 tag / 打错路径）才落到 Worker 的 JSON 404 兜底。
const BASE = "https://codex-models.test/v1/features/codex";
// 链接按 wrangler var CODEX_MODELS_PUBLIC_ORIGIN 拼（与 /v1/index.json 一致），不是请求的 host。
const PUBLIC = `${env.CODEX_MODELS_PUBLIC_ORIGIN}/v1/features/codex`;

interface Flag {
  key: string;
  stage: string;
  default_enabled: boolean | null;
  default_expr?: string;
  doc: string | null;
  experimental: { name: string; menu_description: string; announcement: string | null } | null;
  legacy_aliases: string[];
  history: { first_seen: string; last_seen: string } | null;
  annotation: { title_zh: string; summary_zh: string; aka?: string } | null;
}

interface Payload {
  dataset: string;
  snapshot_tag: string;
  applies_to: string[];
  counts: { total: number; annotated: number };
  flags: Flag[];
}

const latestSnapshot: string =
  (tags.snapshot_aliases as Record<string, string>)[tags.latest] ?? tags.latest;

describe("/v1/features/codex (static assets)", () => {
  it("serves the merged registry at latest.json with ETag + 304", async () => {
    const res = await SELF.fetch(`${BASE}/latest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    const body = (await res.json()) as Payload;
    expect(body.dataset).toBe("codex-feature-flags");
    expect(body.snapshot_tag).toBe(latestSnapshot);
    const expected = (registry.tags as Record<string, { flags: unknown[] }>)[latestSnapshot]!;
    expect(body.counts.total).toBe(expected.flags.length);
    expect(body.counts.annotated).toBe(
      body.flags.filter((flag) => flag.annotation !== null).length,
    );

    const conditional = await SELF.fetch(`${BASE}/latest.json`, {
      headers: { "if-none-match": etag! },
    });
    expect(conditional.status).toBe(304);
  });

  it("applies the /v1/* _headers rules (CORS + cache) to asset responses", async () => {
    const res = await SELF.fetch(`${BASE}/latest.json`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("public");
  });

  it("merges machine facts, legacy aliases, history, and annotations per flag", async () => {
    const body = (await (await SELF.fetch(`${BASE}/latest.json`)).json()) as Payload;
    const byKey = new Map(body.flags.map((flag) => [flag.key, flag]));

    // chronicle：官方 doc + 旧代号 telepathy + 人工注释（Computer History）。
    const chronicle = byKey.get("chronicle")!;
    expect(chronicle.stage).toBe("under development");
    expect(chronicle.doc).toContain("Chronicle sidecar");
    expect(chronicle.legacy_aliases).toContain("telepathy");
    expect(chronicle.annotation?.aka).toBe("Computer History");
    expect(chronicle.annotation?.title_zh).toBeTruthy();
    expect(chronicle.history?.first_seen).toBe("rust-v0.148.0");

    // network_proxy：实验菜单官方文案来自机器层。
    const proxy = byKey.get("network_proxy")!;
    expect(proxy.stage).toBe("experimental");
    expect(proxy.experimental?.name).toBe("Network proxy");

    // secret_auth_storage：平台相关默认值必须显式表达，不得拍成布尔。
    const secret = byKey.get("secret_auth_storage")!;
    expect(secret.default_enabled).toBeNull();
    expect(secret.default_expr).toBe("cfg!(windows)");

    // stage 字符串与 `codex features list` 输出一致。
    const stages = new Set(body.flags.map((flag) => flag.stage));
    for (const stage of stages)
      expect(["stable", "experimental", "under development", "deprecated", "removed"]).toContain(
        stage,
      );
    // 每个旗标都有中文注释（当前全覆盖；将来允许缺口，见 validate.mjs）。
    expect(body.counts.annotated).toBe(body.counts.total);
    expect(Object.keys(annotations).length).toBeGreaterThanOrEqual(body.counts.annotated);
  });

  it("serves every verified tag; alias tags share the snapshot body", async () => {
    for (const tag of tags.verified_tags) {
      const res = await SELF.fetch(`${BASE}/${tag}.json`);
      expect(res.status, tag).toBe(200);
    }
    const alias = (await (await SELF.fetch(`${BASE}/rust-v0.153.1.json`)).json()) as Payload;
    const snapshot = (await (await SELF.fetch(`${BASE}/rust-v0.153.4.json`)).json()) as Payload;
    expect(alias).toEqual(snapshot);
    expect(alias.snapshot_tag).toBe("rust-v0.153.4");
    expect(alias.applies_to).toContain("rust-v0.153.1");
    expect(alias.applies_to).toContain("rust-v0.153.4");
  });

  it("lists verified tags at index.json; unknown tags fall through to the Worker's JSON 404", async () => {
    const index = await SELF.fetch(`${BASE}/index.json`);
    expect(index.status).toBe(200);
    const body = (await index.json()) as {
      latest: { tag: string; url: string };
      verified_tags: { tag: string; snapshot_tag: string; url: string }[];
    };
    expect(body.latest.tag).toBe(tags.latest);
    expect(body.latest.url).toBe(`${PUBLIC}/latest.json`);
    expect(body.verified_tags.map((t) => t.tag)).toEqual(tags.verified_tags);

    const unknown = await SELF.fetch(`${BASE}/rust-v0.1.0.json`);
    expect(unknown.status).toBe(404);
    const error = (await unknown.json()) as { error: { type: string } };
    expect(error.error.type).toBe("unknown_dataset_path");

    for (const bad of ["v0.153.4.json", "latest", "../x.json"]) {
      const res = await SELF.fetch(`${BASE}/${bad}`);
      expect(res.status, bad).toBe(404);
    }
  });

  it("is discoverable from /v1/index.json", async () => {
    const index = (await (await SELF.fetch("https://codex-models.test/v1/index.json")).json()) as {
      endpoints: Record<string, string>;
      licenses: Record<string, string>;
    };
    expect(index.endpoints["codex_feature_flags"]).toBe(`${PUBLIC}/latest.json`);
    expect(index.endpoints["codex_feature_flags_index"]).toBe(`${PUBLIC}/index.json`);
    expect(index.licenses["codex_feature_flags"]).toContain("CC-BY-4.0");
  });
});
