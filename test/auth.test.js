import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runLogin,
  runSignup,
  runLogout,
  REQUEST_TIMEOUT_MS,
} from "../src/auth.js";

const ORIG_HOME = process.env.HOME;

const ESCAPE = String.fromCharCode(27);

function stripAnsi(s) {
  return s.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");
}

function withShortenedTimeout() {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, delay, ...args) => {
    if (delay === REQUEST_TIMEOUT_MS) delay = 50;
    return realSetTimeout(fn, delay, ...args);
  };
  return () => {
    global.setTimeout = realSetTimeout;
  };
}

function abortError() {
  return (err) => err instanceof DOMException && err.name === "AbortError";
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

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

test("login stores the token from a successful API response", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    jsonResponse(res, 200, {
      user: { namespace: "testuser", displayName: "Test User" },
      token: "api-token-abc",
    });
  });

  const code = await runLogin(["--registry", server.url], {
    inputLines: ["testuser", "secret123"],
  });
  const { log } = finish();

  assert.equal(code, 0);
  assert.deepEqual(readCredentialsFile(), { [server.url]: "api-token-abc" });

  const all = [...log].join("\n");
  assert.equal(
    all.includes("api-token-abc"),
    false,
    "the token must never be printed in output",
  );
  assert.ok(
    log.some((l) => l.includes(server.url)),
    "success should name the registry URL it saved credentials for",
  );
  assert.equal(server.requests.length, 1);
  const [request] = server.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v2/auth/login");
  const parsed = JSON.parse(request.body.toString("utf8"));
  assert.equal(parsed.namespace, "testuser");
  assert.equal(parsed.password, "secret123");
});

test("login aborts a stalled success response body instead of hanging", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);
  const restore = withShortenedTimeout();
  t.after(restore);

  const server = await startServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
  });

  await assert.rejects(
    runLogin(["--registry", server.url], {
      inputLines: ["testuser", "secret123"],
    }),
    abortError(),
  );
});

test("login with wrong password reports 401", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (req, res) => {
    jsonResponse(res, 401, { error: "invalid credentials" });
  });

  const code = await runLogin(["--registry", server.url], {
    inputLines: ["testuser", "wrongpass"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("invalid credentials")),
    "expected the server error in output",
  );
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written on failure",
  );
});

test("login normalizes a trailing slash on the resolved registry URL", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (req, res) => {
    jsonResponse(res, 200, { user: {}, token: "tok-123" });
  });

  const code = await runLogin(["--registry", `${server.url}/`], {
    inputLines: ["user", "pass1234"],
  });
  const { log } = finish();

  assert.equal(code, 0);
  const normalizedUrl = server.url;
  assert.deepEqual(readCredentialsFile(), { [normalizedUrl]: "tok-123" });
  assert.ok(
    log.some((l) => l.includes(normalizedUrl)),
    "success should name the normalized registry URL",
  );
});

test("login for a second registry adds a key without disturbing the first", async (t) => {
  prepareHome(t);

  const serverA = await startServer(t, (req, res) => {
    jsonResponse(res, 200, { user: {}, token: "token-a" });
  });
  assert.equal(
    await runLogin(["--registry", serverA.url], {
      inputLines: ["usera", "passa1234"],
    }),
    0,
  );

  const serverB = await startServer(t, (req, res) => {
    jsonResponse(res, 200, { user: {}, token: "token-b" });
  });
  assert.equal(
    await runLogin(["--registry", serverB.url], {
      inputLines: ["userb", "passb1234"],
    }),
    0,
  );

  assert.deepEqual(readCredentialsFile(), {
    [serverA.url]: "token-a",
    [serverB.url]: "token-b",
  });
});

test("an empty namespace during login writes nothing and exits 1", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const code = await runLogin(["--registry", "https://registry.example"], {
    inputLines: ["", "password123"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written",
  );
  assert.ok(
    errors.some((l) => l.includes("No namespace entered")),
    "expected an error about the empty namespace",
  );
});

test("login with a non-JSON body exits 1 and does not create credentials", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("not json");
  });

  const code = await runLogin(["--registry", server.url], {
    inputLines: ["user", "pass1234"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written",
  );
  assert.ok(
    errors.some((l) => l.includes("unexpected response")),
    "expected the unexpected response error",
  );
});

test("login with a JSON body missing a token exits 1 and does not create credentials", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    jsonResponse(res, 200, { user: { namespace: "user" } });
  });

  const code = await runLogin(["--registry", server.url], {
    inputLines: ["user", "pass1234"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written",
  );
  assert.ok(
    errors.some((l) => l.includes("unexpected response")),
    "expected the unexpected response error",
  );
});

test("signup stores the token from a successful 201 response", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    jsonResponse(res, 201, {
      user: { namespace: "newuser", displayName: "New User" },
      token: "signup-token-xyz",
    });
  });

  const code = await runSignup(["--registry", server.url], {
    inputLines: ["newuser", "New User", "password123"],
  });
  const { log } = finish();

  assert.equal(code, 0);
  assert.deepEqual(readCredentialsFile(), { [server.url]: "signup-token-xyz" });
  assert.ok(
    log.some((l) => l.includes(server.url)),
    "success should name the registry URL it saved credentials for",
  );
  assert.equal(server.requests.length, 1);
  const [request] = server.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v2/auth/signup");
  const body = JSON.parse(request.body.toString("utf8"));
  assert.equal(body.namespace, "newuser");
  assert.equal(body.displayName, "New User");
  assert.equal(body.password, "password123");
});

test("signup aborts a stalled error response body instead of hanging", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);
  const restore = withShortenedTimeout();
  t.after(restore);

  const server = await startServer(t, (_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.flushHeaders();
  });

  await assert.rejects(
    runSignup(["--registry", server.url], {
      inputLines: ["newuser", "", "password123"],
    }),
    abortError(),
  );
});

test("signup with taken namespace reports 409", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (req, res) => {
    jsonResponse(res, 409, { error: "namespace already taken" });
  });

  const code = await runSignup(["--registry", server.url], {
    inputLines: ["takenuser", "", "password123"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("namespace already taken")),
    "expected the server error about taken namespace",
  );
});

test("signup with short password reports 400", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    jsonResponse(res, 400, { error: "password must be at least 8 characters" });
  });

  const code = await runSignup(["--registry", server.url], {
    inputLines: ["newuser", "", "short"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.ok(
    errors.some((l) => l.includes("password must be at least 8 characters")),
    "expected the server validation error",
  );
});

test("signup with a non-JSON body exits 1 and does not create credentials", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    res.writeHead(201, { "Content-Type": "text/plain" });
    res.end("not json");
  });

  const code = await runSignup(["--registry", server.url], {
    inputLines: ["newuser", "", "password123"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written",
  );
  assert.ok(
    errors.some((l) => l.includes("unexpected response")),
    "expected the unexpected response error",
  );
});

test("signup with a JSON body missing a token exits 1 and does not create credentials", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    jsonResponse(res, 201, { user: { namespace: "newuser" } });
  });

  const code = await runSignup(["--registry", server.url], {
    inputLines: ["newuser", "", "password123"],
  });
  const { error: errors } = finish();

  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(credentialsFile()),
    false,
    "no credentials file should be written",
  );
  assert.ok(
    errors.some((l) => l.includes("unexpected response")),
    "expected the unexpected response error",
  );
});

test("signup with empty display name omits it from the request body", async (t) => {
  prepareHome(t);
  const finish = withConsole();
  t.after(finish);

  const server = await startServer(t, (_req, res) => {
    jsonResponse(res, 201, {
      user: { namespace: "newuser" },
      token: "tok-nodisplay",
    });
  });

  const code = await runSignup(["--registry", server.url], {
    inputLines: ["newuser", "", "password123"],
  });
  finish();

  assert.equal(code, 0);
  assert.deepEqual(readCredentialsFile(), { [server.url]: "tok-nodisplay" });
  const [request] = server.requests;
  const body = JSON.parse(request.body.toString("utf8"));
  assert.equal(
    body.displayName,
    undefined,
    "displayName should be omitted when empty",
  );
});

test("logout calls the server before removing credentials", async (t) => {
  prepareHome(t);

  let logoutRequest = null;
  const server = await startServer(t, (req, res) => {
    logoutRequest = { method: req.method, url: req.url, headers: req.headers };
    jsonResponse(res, 200, {});
  });
  writeCredentialsFile({
    [server.url]: "token-a",
    "https://registry-b.example": "token-b",
  });

  const finish = withConsole();
  t.after(finish);
  const code = await runLogout(["--registry", server.url]);
  const { log, error: errors } = finish();

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.ok(logoutRequest, "the server should have received a logout request");
  assert.equal(logoutRequest.method, "POST");
  assert.equal(logoutRequest.url, "/v2/auth/logout");
  assert.equal(logoutRequest.headers.authorization, "Bearer token-a");
  assert.deepEqual(readCredentialsFile(), {
    "https://registry-b.example": "token-b",
  });
  assert.ok(
    log.some((l) => l.includes("Removed credentials")),
    "expected a success message confirming removal",
  );
});

test("logout removes credentials even if server call fails", async (t) => {
  prepareHome(t);

  const server = await startServer(t, (req, _res) => {
    req.socket.destroy();
  });
  writeCredentialsFile({ [server.url]: "some-token" });

  const finish = withConsole();
  t.after(finish);
  const code = await runLogout(["--registry", server.url]);
  const { log, error: errors } = finish();

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.deepEqual(readCredentialsFile(), {});
  const warnLine = log.find((l) => l.startsWith("! "));
  assert.ok(warnLine, "expected a warn-level message about server failure");
  assert.ok(
    warnLine.includes("removing local credentials"),
    "warn should mention that local credentials are still being removed",
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

test("logout reports server error but still removes local credentials", async (t) => {
  prepareHome(t);

  const server = await startServer(t, (req, res) => {
    jsonResponse(res, 500, { error: "internal server error" });
  });

  writeCredentialsFile({ [server.url]: "token-a" });

  const finish = withConsole();
  t.after(finish);
  const code = await runLogout(["--registry", server.url]);
  const { log, error: errors } = finish();

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.deepEqual(readCredentialsFile(), {});
  assert.ok(
    log.some((l) => l.includes("HTTP 500")),
    "warn should mention the HTTP status code",
  );
  assert.ok(
    log.some((l) => l.includes("removing local credentials")),
    "warn should mention that local credentials are still being removed",
  );
});
