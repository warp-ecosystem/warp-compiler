import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "../src/build.js";
import { initProject } from "../src/init.js";
import { runPublish } from "../src/publish.js";
import { DEFAULT_REGISTRY_URL } from "../src/registry-config.js";

const PRODUCT = { bin: "warp-compiler", runtimeGlobal: "Warp" };
const ORIG_CWD = process.cwd();

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

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const key of Object.keys(vars)) delete process.env[key];
  };
}

function prepareProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-publish-"));
  process.chdir(dir);
  initProject("src");
  t.after(() => {
    process.chdir(ORIG_CWD);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

async function startServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${port}`, requests };
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function createdResponse(status) {
  return (req, res) =>
    jsonResponse(res, 201, {
      owner: "testowner",
      id: "helloworld",
      version: "0.1.0",
      status,
      url: "https://example.invalid/extensions/helloworld/0.1.0",
    });
}

function errorResponse(status, message) {
  return (req, res) => jsonResponse(res, status, { error: message });
}

test("missing WARP_TOKEN fails before any network request", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse("published"));
  const restoreEnv = setEnv({
    WARP_REGISTRY_URL: server.url,
    WARP_TOKEN: undefined,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, []);
  } finally {
    restoreEnv();
  }
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(server.requests.length, 0, "no request should be attempted");
  assert.ok(
    errors.some((l) => l.includes("WARP_TOKEN is not set")),
    "expected a message telling the user to set WARP_TOKEN",
  );
});

test("201 with status published exits 0 and reports the publish", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse("published"));
  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: server.url,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, []);
  } finally {
    restoreEnv();
  }
  const { log } = finish();

  assert.equal(code, 0);
  const successLine = log.find((l) => l.startsWith("✓ "));
  assert.ok(successLine, "expected a success message");
  assert.ok(
    successLine.includes("Published @testowner/helloworld@0.1.0"),
    "expected the published artifact in the success message",
  );
  assert.equal(successLine.includes("pending review"), false);
});

test("201 with status pending exits 0 with a distinct message", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse("pending"));
  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: server.url,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, []);
  } finally {
    restoreEnv();
  }
  const { log } = finish();

  assert.equal(code, 0);
  const successLine = log.find((l) => l.startsWith("✓ "));
  assert.ok(successLine, "expected a success message");
  assert.ok(
    successLine.includes("Published @testowner/helloworld@0.1.0"),
    "expected the published artifact in the success message",
  );
  assert.ok(
    successLine.includes("pending review"),
    "expected a message distinguishing the pending publish",
  );
});

for (const [status, message] of [
  [400, "manifest version is not a valid semver string"],
  [401, "invalid bearer token"],
  [409, "version 0.1.0 already exists"],
]) {
  test(`HTTP ${status} exits 1 and prints the server error`, async (t) => {
    prepareProject(t);
    const finish = withConsole();

    const server = await startServer(t, errorResponse(status, message));
    const restoreEnv = setEnv({
      WARP_TOKEN: "tok",
      WARP_REGISTRY_URL: server.url,
    });

    let code;
    try {
      code = await runPublish(PRODUCT, []);
    } finally {
      restoreEnv();
    }
    const { error: errors } = finish();

    assert.equal(code, 1);
    assert.ok(
      errors.some((l) => l.includes(message)),
      `expected the server error "${message}" in output`,
    );
  });
}

test("the published body bytes match what build() produced", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const direct = await build(PRODUCT);
  assert.notEqual(direct, 1);
  const expectedBytes = fs.readFileSync(direct.outputPath);

  const server = await startServer(t, createdResponse("published"));
  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: server.url,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, []);
  } finally {
    restoreEnv();
  }
  finish();

  assert.equal(code, 0);
  assert.equal(server.requests.length, 1);
  const [request] = server.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/publish");
  assert.equal(request.headers.authorization, "Bearer tok");
  assert.equal(request.headers["content-type"], "application/javascript");
  assert.ok(
    request.body.equals(expectedBytes),
    "published body must exactly equal the build output bytes",
  );
  assert.ok(
    request.body.equals(Buffer.from(direct.built, "utf8")),
    "published body must equal the directly returned build bytes",
  );
});

test("registry URL falls back to the compiled-in default", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: undefined,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, []);
  } finally {
    restoreEnv();
  }
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes(DEFAULT_REGISTRY_URL)),
    "expected the default registry URL in the failure output",
  );
});

test("WARP_REGISTRY_URL overrides the compiled-in default", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse("published"));
  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: server.url,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, []);
  } finally {
    restoreEnv();
  }
  finish();

  assert.equal(code, 0, "the env-configured registry should be reached");
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/v1/publish");
});

test("--registry overrides WARP_REGISTRY_URL", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const flagServer = await startServer(t, createdResponse("published"));
  const envServer = await startServer(t, () => {
    throw new Error("WARP_REGISTRY_URL must be overridden by --registry");
  });
  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: envServer.url,
  });

  let code;
  try {
    code = await runPublish(PRODUCT, ["--registry", flagServer.url]);
  } finally {
    restoreEnv();
  }
  finish();

  assert.equal(code, 0);
  assert.equal(
    flagServer.requests.length,
    1,
    "--registry target should be hit",
  );
  assert.equal(envServer.requests.length, 0, "env target should not be hit");
});

test("an unreachable registry exits 1 with the attempted URL", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const unreachableUrl = `http://127.0.0.1:${port}`;

  const restoreEnv = setEnv({ WARP_TOKEN: "tok" });

  let code;
  try {
    code = await runPublish(PRODUCT, ["--registry", unreachableUrl]);
  } finally {
    restoreEnv();
  }
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes(unreachableUrl)),
    "expected the attempted registry URL in the failure output",
  );
});
