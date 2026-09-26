import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateProduct, buildHooks } from "./hooks.mjs";
const example = () =>
  JSON.parse(readFileSync(new URL("../data/codex-hooks/products/herdr.json", import.meta.url)));
test("registry includes three independently documented products", () => {
  const registry = buildHooks();
  assert.equal(registry.schema_version, 1);
  assert.deepEqual(
    registry.products.map((p) => p.id),
    ["herdr", "orca", "xirp"],
  );
});
test("rejects dangerous links, generic paths, personal paths and executable matching", () => {
  for (const mutate of [
    (p) => (p.references[0].url = "javascript:alert(1)"),
    (p) => (p.path_suffixes = ["/hook.sh"]),
    (p) => (p.examples.match = ["/Users/lucheng/hook.sh"]),
    (p) => (p.regex = ".*"),
    (p) => delete p.i18n.en,
    (p) => (p.id = "other"),
  ]) {
    const product = example();
    mutate(product);
    assert.throws(() => validateProduct(product, "herdr.json"));
  }
});
test("rejects conflicting suffixes across products", () => {
  const product = example();
  assert.throws(() => validateProduct(product, "herdr.json", new Set(product.path_suffixes)));
});
