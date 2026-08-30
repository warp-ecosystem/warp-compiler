import { build, MANIFEST } from "./build.js";
import { readCredentials } from "./credentials.js";
import { resolveRegistryUrl } from "./registry-config.js";
import { success, error } from "./logger.js";

/**
 * Run the publish command: build the extension, then upload that exact
 * artifact to the Warp Registry.
 * @param {object} product - Product configuration object.
 * @param {string[]} args - Arguments following the "publish" command.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export async function runPublish(product, args) {
  const registryUrl = resolveRegistryUrl(args);

  const token = resolveToken(registryUrl);
  if (!token) {
    error(
      `No credentials found for ${registryUrl}. Set WARP_TOKEN or run '${product.bin} login' to authenticate.`,
    );
    return 1;
  }

  const result = await build(product);
  if (result === 1) return 1;

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
 * Resolve the authentication token: WARP_TOKEN first, then the stored
 * credential for the registry URL.
 * @param {string} registryUrl - Resolved registry base URL.
 * @returns {string|undefined} Token, or undefined if none is available.
 */
function resolveToken(registryUrl) {
  return process.env.WARP_TOKEN || readCredentials()[registryUrl];
}

/**
 * Handle a 201 Created response from the registry.
 * @param {Response} response - Fetch response.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
async function handleCreated(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    error(
      "The Warp Registry returned an unexpected response shape for a successful publish.",
    );
    return 1;
  }

  const { owner, id, version, status } = data || {};
  if (
    typeof owner !== "string" ||
    owner.length === 0 ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    (status !== "published" && status !== "pending")
  ) {
    error(
      "The Warp Registry returned an unexpected response shape for a successful publish.",
    );
    return 1;
  }

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
