import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBuild } from "../src/build.js";
import { initProject } from "../src/init.js";

const PRODUCT = { bin: "warp-compiler", runtimeGlobal: "Warp" };
const ORIG_CWD = process.cwd();

const EXPECTED_FILES = [
  path.join("src", "99-manifest.json"),
  path.join("src", "00-index.js"),
  path.join("src", "01-hello-world.js"),
  path.join("assets", "hello-icon.svg"),
];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-test-"));
  process.chdir(dir);
  t.after(() => {
    process.chdir(ORIG_CWD);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const ESCAPE = String.fromCharCode(27);

function stripAnsi(s) {
  return s.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");
}

function withConsole(level) {
  const original = console[level];
  const lines = [];
  console[level] = (...args) => lines.push(args.map(String).join(" "));
  return function finish() {
    console[level] = original;
    return lines.map(stripAnsi);
  };
}

function fileContents() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(process.cwd(), full));
    }
  };
  for (const root of ["src", "assets"]) {
    if (fs.existsSync(root)) walk(root);
  }
  return files.sort();
}

test("fresh init creates exactly the expected files", (t) => {
  tempDir(t);

  const result = initProject("src");

  assert.equal(result, true);
  for (const f of EXPECTED_FILES) {
    assert.equal(fs.existsSync(f), true, `expected ${f} to exist`);
  }
  assert.deepEqual(
    fileContents(),
    [...EXPECTED_FILES].sort(),
    "should contain only the scaffolded files",
  );
});

test("a second init skips all files without error", (t) => {
  tempDir(t);

  assert.equal(initProject("src"), true);

  const finish = withConsole("log");
  const result = initProject("src");
  const lines = finish();

  assert.equal(result, true, "a second init should not report an error");

  const skippedLines = lines.filter((l) => l.startsWith("- "));
  const createdLines = lines.filter((l) => l.startsWith("✓ "));

  assert.equal(lines.length, EXPECTED_FILES.length);
  assert.equal(createdLines.length, 0);
  assert.equal(skippedLines.length, EXPECTED_FILES.length);
});

test("build succeeds immediately after a fresh init", async (t) => {
  tempDir(t);

  assert.equal(initProject("src"), true);

  const code = await runBuild(PRODUCT);

  assert.equal(code, 0);

  const out = path.join("dist", "helloworld@0.1.0.js");
  assert.equal(fs.existsSync(out), true, `expected ${out} to exist`);
  assert.ok(fs.readFileSync(out, "utf8").includes("new HelloWorld()"));
});

test("unusedFunction is removed from the compiled output", async (t) => {
  tempDir(t);

  initProject("src");
  await runBuild(PRODUCT);

  const out = fs.readFileSync(path.join("dist", "helloworld@0.1.0.js"), "utf8");
  assert.equal(out.includes("unusedFunction"), false);
});

test("an asset never referenced in source is excluded from Warp.assets", async (t) => {
  tempDir(t);

  initProject("src");
  fs.writeFileSync(path.join("assets", "extra.svg"), "<svg></svg>");
  await runBuild(PRODUCT);

  const out = fs.readFileSync(path.join("dist", "helloworld@0.1.0.js"), "utf8");
  assert.equal(out.includes("hello-icon.svg"), true);
  assert.equal(out.includes("extra.svg"), false);
});

test("a dynamic Warp.assets key throws the expected build error", async (t) => {
  tempDir(t);

  initProject("src");
  const entry = path.join("src", "00-index.js");
  let src = fs.readFileSync(entry, "utf8");
  src = src.replace('Warp.assets["hello-icon.svg"]', "Warp.assets[key]");
  fs.writeFileSync(entry, src);

  const finish = withConsole("error");
  const code = await runBuild(PRODUCT);
  const errors = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("Asset keys must be static string literals")),
    "expected a message about non-static asset keys",
  );
});

test("hardcoded id/name literals differing from the manifest warn", async (t) => {
  tempDir(t);

  initProject("src");
  const entry = path.join("src", "00-index.js");
  let src = fs.readFileSync(entry, "utf8");
  src = src.replace("id: Warp.meta.id,", 'id: "custom-id",');
  src = src.replace("name: Warp.meta.name,", 'name: "custom-name",');
  fs.writeFileSync(entry, src);

  const finish = withConsole("log");
  const code = await runBuild(PRODUCT);
  const warns = finish().filter((l) => l.startsWith("! "));

  assert.equal(code, 0);
  assert.ok(
    warns.some((l) => l.includes("does not match the manifest id")),
    "expected a manifest id mismatch warning",
  );
  assert.ok(
    warns.some((l) => l.includes("does not match the manifest name")),
    "expected a manifest name mismatch warning",
  );
});

test("a mismatched package.json warns per field but never for name", async (t) => {
  tempDir(t);

  initProject("src");
  fs.writeFileSync(
    "package.json",
    JSON.stringify({
      name: "a-completely-different-name",
      version: "9.9.9",
      license: "MIT",
      description: "A totally different description.",
    }),
  );

  const finish = withConsole("log");
  const code = await runBuild(PRODUCT);
  const warns = finish().filter((l) => l.startsWith("! "));

  assert.equal(code, 0);
  assert.ok(
    warns.some((l) => l.includes('package.json version ("9.9.9")')),
    "expected a version mismatch warning",
  );
  assert.ok(
    warns.some((l) => l.includes('package.json license ("MIT")')),
    "expected a license mismatch warning",
  );
  assert.ok(
    warns.some((l) => l.includes("package.json description")),
    "expected a description mismatch warning",
  );
  assert.equal(
    warns.some((l) => l.includes("package.json name")),
    false,
    "name is out of scope and should never warn",
  );
});
