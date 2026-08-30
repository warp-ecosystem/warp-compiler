import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Directory name for storing Warp credentials in the user's home directory.
 * @type {string}
 */
export const CREDENTIALS_DIR = ".warp";

/**
 * Filename for the credentials JSON file within the credentials directory.
 * @type {string}
 */
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
 * access to the owner only since it contains bearer tokens. The directory is
 * confined to 0o700 (also when it already exists), the JSON is first written
 * to a unique exclusive temp file in the same directory (mode 0o600) and then
 * renamed over the target; any temp file left behind by a failure is removed.
 * @param {object} credentials - Map of registry URL to token.
 */
export function writeCredentials(credentials) {
  const filePath = credentialsPath();
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const tempPath = uniqueTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
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

/**
 * A unique temp file path next to the target so the rename stays on the same
 * filesystem. The random suffix plus exclusive open avoids clobbering any file
 * left behind by a previous failed write.
 * @param {string} filePath - Target credentials file path.
 * @returns {string} Unique temp file path in the same directory.
 */
function uniqueTempPath(filePath) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`,
  );
}
