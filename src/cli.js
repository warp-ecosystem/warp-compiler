import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pc from "picocolors";

import { initProject } from "./init.js";
import { runBuild } from "./build.js";
import { error } from "./logger.js";

/**
 * Run the CLI with the given product configuration and command-line arguments.
 * @param {object} product - Product configuration object.
 * @param {string[]} argv - Command-line arguments.
 * @returns {Promise<number>} Exit code.
 */
export async function runCli(product, argv) {
  const command = argv[0];

  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    printHelp(product);
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(version());
    return 0;
  }

  if (command === "init") {
    return initProject("src") ? 0 : 1;
  }

  if (command === "build") {
    return runBuild(product);
  }

  error(`Unknown command: ${command}`);
  console.log(`Run '${product.bin} --help' for usage.`);
  return 1;
}

/**
 * Get the package version from package.json.
 * @returns {string} Version string.
 */
function version() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(path.join(here, "..", "package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Print help message showing available commands.
 * @param {object} product - Product configuration object.
 */
function printHelp(product) {
  const cmd = product.bin;
  const lines = [
    `${pc.bold(product.name)} — ${product.description}`,
    "",
    `Usage: ${cmd} <command>`,
    "",
    "Commands:",
    `  ${pc.bold("init")}   Scaffold a new extension project`,
    `  ${pc.bold("build")}  Compile the extension into a single file`,
  ];
  console.log(lines.join("\n"));
}
