import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pc from "picocolors";

import { initProject } from "./init.js";
import { runBuild } from "./build.js";
import { runPublish } from "./publish.js";
import { runLogin, runLogout, runSignup } from "./auth.js";
import { error } from "./logger.js";

/**
 * Dispatch a CLI command using the provided product configuration.
 * @param {object} product - Product metadata and CLI configuration.
 * @param {string[]} argv - Command-line arguments, including the command.
 * @return {number} The exit code: `0` for successful commands and `1` for unknown commands or failed operations.
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

  if (command === "publish") {
    return runPublish(product, argv.slice(1));
  }

  if (command === "login") {
    return runLogin(argv.slice(1));
  }

  if (command === "signup") {
    return runSignup(argv.slice(1));
  }

  if (command === "logout") {
    return runLogout(argv.slice(1));
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
    `  ${pc.bold("publish")}  Build and upload the extension to the Warp Registry`,
    `  ${pc.bold("login")}   Save credentials for the Warp Registry`,
    `  ${pc.bold("signup")}  Create a Warp Registry account`,
    `  ${pc.bold("logout")}  Remove saved credentials for the Warp Registry`,
  ];
  console.log(lines.join("\n"));
}
