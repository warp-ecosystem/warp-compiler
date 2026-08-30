#!/usr/bin/env node
import { spawnSync } from "node:child_process";

/**
 * Run the test suite with the test runner's isolation set to "none" when the
 * running Node supports it. Colorless/single-process isolation avoids a
 * runner bug where test files that replace process.stdin (the auth tests)
 * produce reports the parent process cannot deserialize. Node 18 and 20 have
 * no isolation flag at all, so they run the default process isolation.
 */
function main() {
  const help =
    spawnSync(process.execPath, ["--help"], { encoding: "utf8" }).stdout ?? "";

  let isolationFlag = null;
  if (/(^|\s)--test-isolation\b/.test(help)) {
    isolationFlag = "--test-isolation=none";
  } else if (/(^|\s)--experimental-test-isolation\b/.test(help)) {
    isolationFlag = "--experimental-test-isolation=none";
  }

  const args = ["--test", ...(isolationFlag ? [isolationFlag] : [])];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

main();
