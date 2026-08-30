import { spawn } from "node:child_process";
import readline from "node:readline";

import { resolveRegistryUrl } from "./registry-config.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { error, success, warn } from "./logger.js";

/**
 * Run the login command: print the login URL, offer to open it, then prompt
 * for a token to store in ~/.warp/credentials.json.
 * @param {string[]} args - Arguments following the "login" command.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export async function runLogin(args) {
  const registryUrl = resolveRegistryUrl(args);
  const loginUrl = `${registryUrl}/login`;

  console.log(`Visit ${loginUrl} to get your API token, then paste it below.`);
  openInBrowser(loginUrl);

  const pasted = await promptForToken("Paste your API token: ");
  const token = pasted.trim();
  if (!token) {
    error("No token entered; nothing was saved.");
    return 1;
  }

  const credentials = readCredentials();
  credentials[registryUrl] = token;
  writeCredentials(credentials);
  success(`Saved credentials for ${registryUrl}.`);
  return 0;
}

/**
 * Run the logout command: remove the stored credential for the resolved
 * registry URL, if any.
 * @param {string[]} args - Arguments following the "logout" command.
 * @returns {Promise<number>} Exit code (0 always; logout is informational).
 */
export async function runLogout(args) {
  const registryUrl = resolveRegistryUrl(args);
  const credentials = readCredentials();
  if (Object.hasOwn(credentials, registryUrl)) {
    delete credentials[registryUrl];
    writeCredentials(credentials);
    success(`Removed credentials for ${registryUrl}.`);
  } else {
    warn(`No credentials were stored for ${registryUrl}.`);
  }
  return 0;
}

/**
 * Prompt the user for a token. On a TTY the input is read with local echo
 * disabled and masked with asterisks; paste frames and terminal escape
 * sequences are never accepted into the value, so the token is stored exactly
 * as typed. On piped (non-TTY) input a plain readline prompt is used.
 * @param {string} question - Prompt text.
 * @returns {Promise<string>} The entered line.
 */
function promptForToken(question) {
  return new Promise((resolve) => {
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
      process.stdout.write("*".repeat([...accepted].length));
    };
    stdin.on("keypress", onKeypress);
  });
}

/**
 * Best-effort attempt to open a URL in the user's default browser. Failure is
 * fine: the URL was already printed for the user to visit manually.
 * @param {string} url - URL to open.
 */
function openInBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // opening a browser is a convenience, not a requirement
  }
}
