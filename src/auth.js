import readline from "node:readline";

import { resolveRegistryUrl } from "./registry-config.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { error, success, warn } from "./logger.js";

/**
 * Authenticate with the registry and save the returned credentials.
 * @param {string[]} args - Arguments following the `login` command.
 * @param {{ inputLines?: string[] }} [options] - Optional input lines used instead of interactive input.
 * @return {Promise<number>} `0` on success, `1` on failure.
 */
export async function runLogin(args, { inputLines } = {}) {
  let registryUrl;
  try {
    registryUrl = resolveRegistryUrl(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const namespace = (await promptLine("Namespace: ", { inputLines })).trim();
  if (!namespace) {
    error("No namespace entered; nothing was saved.");
    return 1;
  }

  const password = await promptLine("Password: ", { mask: true, inputLines });
  if (!password) {
    error("No password entered; nothing was saved.");
    return 1;
  }

  let response;
  try {
    response = await fetch(`${registryUrl}/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace, password }),
    });
  } catch {
    error(`Could not reach the Warp Registry at ${registryUrl}.`);
    return 1;
  }

  if (response.status === 200) {
    let data;
    try {
      data = await response.json();
    } catch {
      error(
        "The Warp Registry returned an unexpected response for a successful login.",
      );
      return 1;
    }
    if (typeof data.token !== "string" || !data.token) {
      error(
        "The Warp Registry returned an unexpected response for a successful login.",
      );
      return 1;
    }
    const credentials = readCredentials();
    credentials[registryUrl] = data.token;
    try {
      writeCredentials(credentials);
    } catch (err) {
      error(
        `Failed to save credentials for ${registryUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 1;
    }
    success(`Saved credentials for ${registryUrl}.`);
    return 0;
  }

  const serverMessage = await readErrorMessage(response);
  if (response.status === 401) {
    error(
      `${serverMessage ?? "Invalid credentials."} — check your namespace and password.`,
    );
    return 1;
  }
  error(`Unexpected response from the Warp Registry: HTTP ${response.status}.`);
  return 1;
}

/**
 * Run the signup command: prompt for namespace, display name, and password,
 * then create an account via POST /v2/auth/signup.
 * @param {string[]} args - Arguments following the "signup" command.
 * @param {{ inputLines?: string[] }} [options] - Internal options (e.g. pre-read lines for testing).
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export async function runSignup(args, { inputLines } = {}) {
  let registryUrl;
  try {
    registryUrl = resolveRegistryUrl(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const namespace = (await promptLine("Namespace: ", { inputLines })).trim();
  if (!namespace) {
    error("No namespace entered; nothing was saved.");
    return 1;
  }

  const displayName = (
    await promptLine("Display name (optional): ", { inputLines })
  ).trim();

  const password = await promptLine("Password: ", { mask: true, inputLines });
  if (!password) {
    error("No password entered; nothing was saved.");
    return 1;
  }

  const body = { namespace, password };
  if (displayName) body.displayName = displayName;

  let response;
  try {
    response = await fetch(`${registryUrl}/v2/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    error(`Could not reach the Warp Registry at ${registryUrl}.`);
    return 1;
  }

  if (response.status === 201) {
    let data;
    try {
      data = await response.json();
    } catch {
      error(
        "The Warp Registry returned an unexpected response for a successful signup.",
      );
      return 1;
    }
    if (typeof data.token !== "string" || !data.token) {
      error(
        "The Warp Registry returned an unexpected response for a successful signup.",
      );
      return 1;
    }
    const credentials = readCredentials();
    credentials[registryUrl] = data.token;
    try {
      writeCredentials(credentials);
    } catch (err) {
      error(
        `Failed to save credentials for ${registryUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 1;
    }
    success(`Saved credentials for ${registryUrl}.`);
    return 0;
  }

  const serverMessage = await readErrorMessage(response);
  if (response.status === 409) {
    error(`${serverMessage ?? "Namespace already taken."}`);
    return 1;
  }
  if (response.status === 400) {
    error(`${serverMessage ?? "Validation failed."}`);
    return 1;
  }
  error(`Unexpected response from the Warp Registry: HTTP ${response.status}.`);
  return 1;
}

/**
 * Revokes the stored registry token and removes the local credentials.
 * @param {string[]} args - Arguments following the `logout` command.
 * @return {number} `0` if credentials are removed or none exist, `1` if removal fails.
 */
export async function runLogout(args) {
  let registryUrl;
  try {
    registryUrl = resolveRegistryUrl(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const credentials = readCredentials();
  const token = credentials[registryUrl];
  if (!token) {
    warn(`No credentials were stored for ${registryUrl}.`);
    return 0;
  }

  try {
    const response = await fetch(`${registryUrl}/v2/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) {
      warn(
        `Could not revoke token on the server (HTTP ${response.status}); removing local credentials anyway.`,
      );
    }
  } catch {
    warn(
      `Could not reach the Warp Registry at ${registryUrl}; removing local credentials anyway.`,
    );
  }

  delete credentials[registryUrl];
  try {
    writeCredentials(credentials);
  } catch (err) {
    error(
      `Failed to remove credentials for ${registryUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }
  success(`Removed credentials for ${registryUrl}.`);
  return 0;
}

/**
 * Extract the server-provided error message from a non-success response.
 * @param {Response} response - Fetch response.
 * @returns {Promise<string|null>} The error message, or null if absent.
 */
async function readErrorMessage(response) {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // ignore malformed bodies
  }
  return null;
}

/**
 * Reads a line of input from supplied lines, standard input, or an interactive terminal.
 * @param {string} question - Prompt text.
 * @param {{ mask?: boolean, inputLines?: string[] }} [options] - Input options.
 * @returns {Promise<string>} The entered line.
 */
function promptLine(question, { mask = false, inputLines } = {}) {
  return new Promise((resolve) => {
    if (inputLines && inputLines.length > 0) {
      resolve(inputLines.shift());
      return;
    }

    const stdin = process.stdin;

    if (!stdin.isTTY) {
      const rl = readline.createInterface({
        input: stdin,
        output: process.stdout,
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(question);

    let value = "";

    const finish = () => {
      stdin.removeListener("keypress", onKeypress);
      stdin.removeListener("end", finish);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    stdin.on("end", finish);

    const onKeypress = (str, key) => {
      if (key && (key.name === "return" || key.name === "enter")) {
        finish();
        return;
      }
      if (key && key.ctrl && key.name === "c") {
        stdin.removeListener("keypress", onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("^C\n");
        process.exit(130);
      }
      if ((key && key.name === "backspace") || str === "\x7f" || str === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (!str || str.includes("\x1b") || (key && (key.ctrl || key.meta))) {
        return;
      }
      const accepted = [...str]
        .filter((c) => {
          const code = c.codePointAt(0);
          return code >= 0x20 && code !== 0x7f;
        })
        .join("");
      if (!accepted) return;
      value += accepted;
      process.stdout.write(mask ? "*".repeat([...accepted].length) : accepted);
    };
    stdin.on("keypress", onKeypress);
  });
}
