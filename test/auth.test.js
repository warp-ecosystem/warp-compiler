import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runLogin, runLogout } from "../src/auth.js";

const ORIG_HOME = process.env.HOME;

const ESCAPE = String.fromCharCode(27);

function stripAnsi(s) {
  return s.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");
}

function withConsole() {
  const captured = { log: [], error: [] };
  const original = { log: console.log, error: console.error };
  console.log = (...args) => captured.log.push(args.map(String).join(" "));
  console.error = (...args) => captured.error.push(args.map(String).join(" "));
  return function finish() {
    console.log = original.log;
    console.error = original.error;
    return {
      log: captured.log.map(stripAnsi),
      error: captured.error.map(stripAnsi),
    };
  };
}

function prepareHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-auth-"));
  process.env.HOME = dir;
  t.after(() => {
    if (ORIG_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIG_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

let originalStdinDescriptor;

function mockStdin(text) {
  if (originalStdinDescriptor === undefined) {
    originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  }
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: Readable.from([text]),
  });
  return () => {
    if (originalStdinDescriptor) {
      Object.defineProperty(process, "stdin", originalStdinDescriptor);
    } else {
      delete process.stdin;
    }
  };
}

function credentialsFile() {
  return path.join(process.env.HOME, ".warp", "credentials.json");
}

function readCredentialsFile() {
  return JSON.parse(fs.readFileSync(credentialsFile(), "utf8"));
}

function writeCredentialsFile(creds) {
  fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
  fs.writeFileSync(credentialsFile(), JSON.stringify(creds, null, 2));
}

test("login stores the pasted token under the resolved registry URL", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);
  const restoreStdin = mockStdin("secret-token\n");
  t.after(restoreStdin);

  const code = await runLogin(["--registry", "https://registry.one.example"]);
  const { log, error: errors } = finish();

  assert.equal(code, 0);
  assert.deepEqual(readCredentialsFile(), {
    "https://registry.one.example": "secret-token",
  });

  const all = [...log, ...errors].join("\n");
  assert.equal(
    all.includes("secret-token"),
    false,
    "the token must never be printed in output",
  );
  assert.ok(
    log.some((l) => l.includes("https://registry.one.example")),
    "success should name the registry URL it saved credentials for",
  );
});

test("login for a second registry adds a key without disturbing the first", async (t) => {
  prepareHome(t);

  const restoreStdinA = mockStdin("token-a\n");
  t.after(restoreStdinA);
  assert.equal(await runLogin(["--registry", "https://registry-a.example"]), 0);

  const restoreStdinB = mockStdin("token-b\n");
  t.after(restoreStdinB);
  assert.equal(await runLogin(["--registry", "https://registry-b.example"]), 0);

  assert.deepEqual(readCredentialsFile(), {
    "https://registry-a.example": "token-a",
    "https://registry-b.example": "token-b",
  });
});

test("an empty paste during login writes nothing and exits 1", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);
  const restoreStdin = mockStdin("   \n");
  t.after(restoreStdin);

  const code = await runLogin(["--registry", "https://registry.example"]);
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written",
  );
  assert.ok(
    errors.some((l) => l.includes("No token entered")),
    "expected an error about the empty paste",
  );
});

test("logout removes only the matching URL's entry", async (t) => {
  prepareHome(t);
  writeCredentialsFile({
    "https://registry-a.example": "token-a",
    "https://registry-b.example": "token-b",
  });

  const finish = withConsole();
  t.after(finish);
  const code = await runLogout(["--registry", "https://registry-a.example"]);
  const { log, error: errors } = finish();

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.deepEqual(readCredentialsFile(), {
    "https://registry-b.example": "token-b",
  });
  assert.ok(
    log.some((l) => l.includes("Removed credentials")),
    "expected a success message confirming removal",
  );
  assert.ok(
    log.some((l) => l.includes("https://registry-a.example")),
    "success should name the removed registry URL",
  );
});

test("logout for a URL with no stored entry warns and exits 0", async (t) => {
  prepareHome(t);
  writeCredentialsFile({ "https://registry-a.example": "token-a" });

  const finish = withConsole();
  t.after(finish);
  const code = await runLogout([
    "--registry",
    "https://registry-other.example",
  ]);
  const { log, error: errors } = finish();

  assert.equal(code, 0);
  assert.equal(errors.length, 0, "logout must not be an error");
  assert.deepEqual(readCredentialsFile(), {
    "https://registry-a.example": "token-a",
  });
  const warnLine = log.find((l) => l.startsWith("! "));
  assert.ok(warnLine, "expected a warn-level message");
  assert.ok(warnLine.includes("https://registry-other.example"));
});
