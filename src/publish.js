import { build, MANIFEST } from "./build.js";
import { DEFAULT_REGISTRY_URL } from "./registry-config.js";
import { success, error } from "./logger.js";

/**
 * Run the publish command: build the extension, then upload that exact
 * artifact to the Warp Registry.
 * @param {object} product - Product configuration object.
 * @param {string[]} args - Arguments following the "publish" command.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export async function runPublish(product, args) {
  const result = await build(product);
  if (result === 1) return 1;

  const registryUrl = resolveRegistryUrl(args);

  const token = process.env.WARP_TOKEN;
  if (!token) {
    error(
      "WARP_TOKEN is not set. Set the WARP_TOKEN environment variable and try again.",
    );
    return 1;
  }

  let response;
  try {
    response = await fetch(`${registryUrl}/v1/publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/javascript",
      },
      body: result.built,
    });
  } catch {
    error(`Could not reach the Warp Registry at ${registryUrl}.`);
    return 1;
  }

  if (response.status === 201) {
    return handleCreated(response);
  }

  const serverMessage = await readErrorMessage(response);

  if (response.status === 400) {
    error(serverMessage ?? `The Warp Registry rejected the publish: HTTP 400.`);
    return 1;
  }

  if (response.status === 401) {
    error(
      `${serverMessage ?? `The Warp Registry rejected the token: HTTP 401.`} — WARP_TOKEN may be missing, expired, or incorrect.`,
    );
    return 1;
  }

  if (response.status === 409) {
    error(
      `${serverMessage ?? `The Warp Registry reports a conflict: HTTP 409.`} — this version was already published; bumping the version in ${MANIFEST} is likely the fix.`,
    );
    return 1;
  }

  error(`Unexpected response from the Warp Registry: HTTP ${response.status}.`);
  return 1;
}

/**
 * Resolve the registry URL: --registry flag, then WARP_REGISTRY_URL, then the
 * compiled-in default.
 * @param {string[]} args - Arguments following the "publish" command.
 * @returns {string} Resolved registry base URL.
 */
function resolveRegistryUrl(args) {
  const flagIndex = args.indexOf("--registry");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    return args[flagIndex + 1];
  }
  return process.env.WARP_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

/**
 * Handle a 201 Created response from the registry.
 * @param {Response} response - Fetch response.
 * @returns {Promise<number>} Exit code (0 for success).
 */
async function handleCreated(response) {
  const data = await response.json().catch(() => ({}));
  const { owner, id, version, status } = data;
  const label = `@${owner}/${id}@${version}`;
  if (status === "published") {
    success(`Published ${label}`);
  } else {
    success(`Published ${label} (pending review — this is your first publish)`);
  }
  return 0;
}

/**
 * Extract the server-provided error message from a non-201 response.
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
