import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "../src/build.js";
import { initProject } from "../src/init.js";
import { runPublish } from "../src/publish.js";
import {
  DEFAULT_REGISTRY_URL,
  resolveRegistryUrl,
} from "../src/registry-config.js";

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
  const originals = new Map();
  for (const [key, value] of Object.entries(vars)) {
    originals.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, original] of originals) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  };
}

function prepareProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-publish-"));
  const projectDir = path.join(dir, "project");
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  process.chdir(projectDir);
  initProject("src");
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => {
    process.chdir(ORIG_CWD);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function credsFilePath() {
  return path.join(process.env.HOME, ".warp", "credentials.json");
}

function writeCredentialsFile(creds) {
  fs.mkdirSync(path.dirname(credsFilePath()), { recursive: true });
  fs.writeFileSync(credsFilePath(), JSON.stringify(creds, null, 2));
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

function createdResponse(approved) {
  return (req, res) =>
    jsonResponse(res, 201, {
      extension: {
        owner: "testowner",
        id: "helloworld",
        meta: {
          id: "helloworld",
          version: "0.1.0",
          name: "Hello World",
          license: "MIT",
          description: "A test extension",
        },
        versions: approved ? ["0.1.0"] : [],
        approved,
      },
      publishedUrl: "/v2/@testowner/helloworld",
    });
}

function errorResponse(status, message) {
  return (req, res) => jsonResponse(res, status, { error: message });
}

test("missing credentials fail before any build or network activity", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(true));
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
  assert.equal(
    fs.existsSync(path.join("dist")),
    false,
    "no build output should be written",
  );
  const message = errors.find((l) => l.includes("No credentials"));
  assert.ok(message, "expected a message about missing credentials");
  assert.ok(
    message.includes("WARP_TOKEN"),
    "message should mention WARP_TOKEN",
  );
  assert.ok(
    message.includes("login"),
    "message should suggest run <bin> login",
  );
});

test("201 with status published exits 0 and reports the publish", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(true));
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

test("201 with approved false exits 0 with a distinct message", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(false));
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
  [403, "a prior publish is still awaiting review"],
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

  const server = await startServer(t, createdResponse(true));
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
  assert.equal(request.url, "/v2/publish");
  assert.equal(request.headers.authorization, "Bearer tok");
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(request.body.toString("utf8"));
  assert.equal(body.id, "helloworld");
  assert.ok(body.meta && typeof body.meta === "object", "body.meta must be an object");
  assert.equal(body.meta.id, "helloworld");
  assert.equal(
    body.extensionBlob,
    direct.built,
    "extensionBlob must equal the build output",
  );
});

test("registry URL falls back to the compiled-in default", (t) => {
  prepareProject(t);
  const restoreEnv = setEnv({ WARP_REGISTRY_URL: undefined });
  try {
    assert.equal(resolveRegistryUrl([]), DEFAULT_REGISTRY_URL);
    assert.equal(DEFAULT_REGISTRY_URL, "https://warp.sdisk.us");
  } finally {
    restoreEnv();
  }
});

test("a trailing slash on the registry URL is normalized away", () => {
  const restoreEnv = setEnv({ WARP_REGISTRY_URL: undefined });
  try {
    assert.equal(
      resolveRegistryUrl(["--registry", "https://warp.example/"]),
      "https://warp.example",
    );
  } finally {
    restoreEnv();
  }
});

test("WARP_REGISTRY_URL overrides the compiled-in default", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(true));
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
  assert.equal(server.requests[0].url, "/v2/publish");
});

test("--registry overrides WARP_REGISTRY_URL", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const flagServer = await startServer(t, createdResponse(true));
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

test("a bare --registry flag is rejected instead of falling back", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const restoreEnv = setEnv({ WARP_TOKEN: "tok" });

  let code;
  try {
    code = await runPublish(PRODUCT, ["--registry"]);
  } finally {
    restoreEnv();
  }
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("--registry")),
    "expected an error about the missing --registry value",
  );
});

test("an http registry URL is rejected for non-loopback hosts", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const restoreEnv = setEnv({ WARP_TOKEN: "tok" });

  let code;
  try {
    code = await runPublish(PRODUCT, ["--registry", "http://warp.example"]);
  } finally {
    restoreEnv();
  }
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("must use https")),
    "expected the insecure URL to be rejected in favor of https",
  );
});

test("a registry URL with a query is rejected", () => {
  const restoreEnv = setEnv({ WARP_REGISTRY_URL: undefined });
  try {
    assert.throws(
      () =>
        resolveRegistryUrl(["--registry", "https://warp.example?token=abc"]),
      /must not contain a query or fragment/,
    );
  } finally {
    restoreEnv();
  }
});

test("a registry URL with a fragment is rejected", () => {
  const restoreEnv = setEnv({ WARP_REGISTRY_URL: undefined });
  try {
    assert.throws(
      () => resolveRegistryUrl(["--registry", "https://warp.example#frag"]),
      /must not contain a query or fragment/,
    );
  } finally {
    restoreEnv();
  }
});

test("a registry URL ending in an empty query delimiter is rejected", () => {
  const restoreEnv = setEnv({ WARP_REGISTRY_URL: undefined });
  try {
    assert.throws(
      () => resolveRegistryUrl(["--registry", "https://warp.example?"]),
      /must not contain a query or fragment/,
    );
  } finally {
    restoreEnv();
  }
});

test("a registry URL ending in an empty fragment delimiter is rejected", () => {
  const restoreEnv = setEnv({ WARP_REGISTRY_URL: undefined });
  try {
    assert.throws(
      () => resolveRegistryUrl(["--registry", "https://warp.example#"]),
      /must not contain a query or fragment/,
    );
  } finally {
    restoreEnv();
  }
});

test("publish rejects an empty query delimiter without reaching the registry", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(true));
  const restoreEnv = setEnv({ WARP_TOKEN: "tok" });

  let code;
  try {
    code = await runPublish(PRODUCT, ["--registry", `${server.url}?`]);
  } finally {
    restoreEnv();
  }
  finish();

  assert.equal(code, 1);
  assert.equal(
    server.requests.length,
    0,
    "no malformed request should be sent",
  );
});

test("a stalled registry request is aborted and reported as a timeout", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, () => {});
  const restoreEnv = setEnv({
    WARP_TOKEN: "tok",
    WARP_REGISTRY_URL: server.url,
    WARP_PUBLISH_TIMEOUT_MS: "100",
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
    errors.some((l) => l.includes("timed out")),
    "expected the stalled request to be reported as a timeout",
  );
});

test("publish uses the stored credential when WARP_TOKEN is unset", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(true));
  writeCredentialsFile({ [server.url]: "stored-token" });
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
  finish();

  assert.equal(code, 0);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.authorization, "Bearer stored-token");
});

test("WARP_TOKEN takes precedence over the stored credential", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, createdResponse(true));
  writeCredentialsFile({ [server.url]: "stored-token" });
  const restoreEnv = setEnv({
    WARP_TOKEN: "env-token",
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
  assert.equal(server.requests[0].headers.authorization, "Bearer env-token");
});

test("a 201 response missing both extension and flat owner fields exits 1", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, (req, res) =>
    jsonResponse(res, 201, { foo: "bar" }),
  );
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
  const { log, error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("unexpected response shape")),
    "expected the unexpected response shape error",
  );
  assert.equal(
    log.some((l) => l.includes("Published @")),
    false,
    "a broken 201 must not be reported as successful",
  );
});

test("a v1-format 201 with status published is accepted", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, (req, res) =>
    jsonResponse(res, 201, {
      owner: "testowner",
      id: "helloworld",
      version: "0.1.0",
      status: "published",
    }),
  );
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

test("a v1-format 201 with status pending is accepted with a distinct message", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, (req, res) =>
    jsonResponse(res, 201, {
      owner: "testowner",
      id: "helloworld",
      version: "0.1.0",
      status: "pending",
    }),
  );
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

test("a 201 response with a non-JSON body exits 1 with an unexpected shape error", async (t) => {
  prepareProject(t);
  const finish = withConsole();

  const server = await startServer(t, (req, res) => {
    res.writeHead(201, { "Content-Type": "text/plain" });
    res.end("not json");
  });
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
  const { log, error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("unexpected response shape")),
    "expected the unexpected response shape error",
  );
  assert.equal(
    log.some((l) => l.includes("Published @")),
    false,
    "a broken 201 must not be reported as successful",
  );
});
