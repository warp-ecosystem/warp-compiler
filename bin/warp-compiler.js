#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runCli } from "../src/cli.js";

/**
 * Main entry point for the warp-compiler CLI.
 */
async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const productPath = path.join(here, "..", ".product.json");
  const product = JSON.parse(readFileSync(productPath, "utf8"));

  const args = process.argv.slice(2);
  const code = await runCli(product, args);
  process.exitCode = code;
}

main();
