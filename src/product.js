import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

/**
 * Load the product configuration from .product.json.
 * @returns {object} Product configuration object.
 */
export function loadProduct() {
  const raw = readFileSync(path.join(packageRoot, ".product.json"), "utf8");
  return JSON.parse(raw);
}
