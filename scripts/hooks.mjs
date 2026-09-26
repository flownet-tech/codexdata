import { readFileSync, readdirSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
const directory = new URL("../data/codex-hooks/", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("product.schema.json", directory)));
const validator = new Validator(schema, "2020-12", false);
export function validateProduct(product, filename, suffixes = new Set()) {
  const result = validator.validate(product);
  if (!result.valid) throw new Error(`${filename}: ${JSON.stringify(result.errors)}`);
  if (`${product.id}.json` !== filename) throw new Error(`${filename}: id mismatch`);
  for (const suffix of product.path_suffixes) {
    if (!suffix.toLowerCase().includes(product.id) || suffix.includes("..") || suffixes.has(suffix))
      throw new Error(`${filename}: generic, conflicting or invalid suffix ${suffix}`);
    suffixes.add(suffix);
  }
  if (
    product.evidence === "documented" &&
    !product.references.some((ref) => ref.kind === "official" && ref.url)
  )
    throw new Error(`${filename}: documented purpose requires an official reference`);
  for (const ref of product.references) {
    if (
      ref.url &&
      (new URL(ref.url).protocol !== "https:" ||
        new URL(ref.url).username ||
        new URL(ref.url).password)
    )
      throw new Error(`${filename}: references must be public HTTPS URLs`);
  }
  for (const command of [...product.examples.match, ...product.examples.no_match]) {
    if (
      /\/(?:Users|home)\/(?!demo(?:\/|$)|example(?:\/|$))[^/]+/i.test(command) ||
      /[A-Z]:\\Users\\(?!demo\\|example\\)/i.test(command)
    )
      throw new Error(`${filename}: redact personal paths in examples`);
  }
  for (const command of product.examples.match) {
    if (!matches(command, product)) throw new Error(`${filename}: positive example does not match`);
  }
  for (const command of product.examples.no_match) {
    if (matches(command, product)) throw new Error(`${filename}: negative example matches`);
  }
  return product;
}
export function buildHooks() {
  const suffixes = new Set();
  const products = readdirSync(new URL("products/", directory))
    .sort()
    .map((filename) =>
      validateProduct(
        JSON.parse(readFileSync(new URL(`products/${filename}`, directory))),
        filename,
        suffixes,
      ),
    );
  return { dataset: "codex-hook-products", schema_version: 1, products };
}

function matches(command, product) {
  const normalized = command.replace(/\\/g, "/");
  return product.path_suffixes.some((suffix) => {
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(suffix, from);
      if (index < 0) return false;
      const end = index + suffix.length;
      if (end === normalized.length || /[\s'";()|&<>]/.test(normalized[end])) return true;
      from = end;
    }
    return false;
  });
}
