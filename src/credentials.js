import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDENTIALS_DIR = ".warp";
export const CREDENTIALS_FILE = "credentials.json";

/**
 * Path to the credentials file, keyed by registry URL.
 * @returns {string} Absolute path to ~/.warp/credentials.json.
 */
export function credentialsPath() {
  const home = process.env.HOME || os.homedir();
  return path.join(home, CREDENTIALS_DIR, CREDENTIALS_FILE);
}

/**
 * Read the stored credentials as a map of registry URL to token. Missing or
 * malformed files are treated as an empty set of credentials.
 * @returns {object} Map of registry URL to token.
 */
export function readCredentials() {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // missing or unreadable credentials file
  }
  return {};
}

/**
 * Write the credentials file atomically, creating ~/.warp and restricting
 * access to the owner only since it contains bearer tokens. The JSON is first
 * written to a temp file in the same directory (mode 0o600) and then renamed
 * over the target; any temp file left behind by a failure is removed.
 * @param {object} credentials - Map of registry URL to token.
 */
export function writeCredentials(credentials) {
  const filePath = credentialsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}
