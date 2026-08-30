/**
 * Default Warp Registry base URL, used when neither the --registry CLI flag
 * nor the WARP_REGISTRY_URL environment variable is provided.
 * @type {string}
 */
export const DEFAULT_REGISTRY_URL = "https://warp.sdisk.us";

/**
 * Hosts on which http is permitted even though the registry receives bearer
 * tokens; anything else must use https.
 * @type {Set<string>}
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Resolve the registry URL: --registry flag, then WARP_REGISTRY_URL, then the
 * compiled-in default. Flag and environment values are validated before use:
 * https is required except for loopback development hosts, which may use http.
 * @param {string[]} args - Command arguments following the subcommand.
 * @returns {string} Resolved registry base URL.
 * @throws {Error} When --registry is used without a value or the selected URL
 *   is invalid or insecure.
 */
export function resolveRegistryUrl(args) {
  const flagIndex = args.indexOf("--registry");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    if (!value) {
      throw new Error("The --registry flag requires a URL value.");
    }
    return validateRegistryUrl(value);
  }
  const envValue = process.env.WARP_REGISTRY_URL;
  if (envValue) return validateRegistryUrl(envValue);
  return DEFAULT_REGISTRY_URL;
}

/**
 * Validate a registry URL before any token is sent to it. Rejects values that
 * are not parseable http(s) URLs, and rejects plain http for anything other
 * than loopback development hosts.
 * @param {string} value - URL from the --registry flag or WARP_REGISTRY_URL.
 * @returns {string} The original value when valid.
 * @throws {Error} When the URL is invalid or insecure.
 */
function validateRegistryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid registry URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Registry URL must use http or https: ${value}`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(
      `Registry URL must use https for non-loopback hosts: ${value}`,
    );
  }
  return value;
}
