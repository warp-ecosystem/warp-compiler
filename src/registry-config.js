/**
 * Default Warp Registry base URL, used when neither the --registry CLI flag
 * nor the WARP_REGISTRY_URL environment variable is provided.
 * @type {string}
 */
export const DEFAULT_REGISTRY_URL = "https://warp.sdisk.us";

/**
 * Resolve the registry URL: --registry flag, then WARP_REGISTRY_URL, then the
 * compiled-in default.
 * @param {string[]} args - Command arguments following the subcommand.
 * @returns {string} Resolved registry base URL.
 */
export function resolveRegistryUrl(args) {
  const flagIndex = args.indexOf("--registry");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    return args[flagIndex + 1];
  }
  return process.env.WARP_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}
