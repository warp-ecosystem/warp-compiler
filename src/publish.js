import { build, MANIFEST } from "./build.js";
import { readCredentials } from "./credentials.js";
import { resolveRegistryUrl } from "./registry-config.js";
import { success, error } from "./logger.js";

/** Default deadline for a publish request, headers and body included. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

/** Error used to route aborted requests to the timeout reporting path. */
class RegistryTimeoutError extends Error {}

/**
 * Run the publish command: build the extension, then upload that exact
 * artifact to the Warp Registry.
 * @param {object} product - Product configuration object.
 * @param {string[]} args - Arguments following the "publish" command.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export async function runPublish(product, args) {
  let registryUrl;
  try {
    registryUrl = resolveRegistryUrl(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const token = resolveToken(registryUrl);
  if (!token) {
    error(
      `No credentials found for ${registryUrl}. Set WARP_TOKEN or run '${product.bin} login' to authenticate.`,
    );
    return 1;
  }

  const result = await build(product);
  if (result === 1) return 1;

  const { controller, timeoutMs, done } = startDeadline();
  try {
    let response;
    try {
      response = await fetch(`${registryUrl}/v1/publish`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/javascript",
        },
        body: result.built,
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        reportTimeout(timeoutMs);
      } else {
        error(`Could not reach the Warp Registry at ${registryUrl}.`);
      }
      return 1;
    }

    if (response.status === 201) {
      return await handleCreated(response, controller);
    }

    const serverMessage = await readErrorMessage(response, controller);

    if (response.status === 400) {
      error(
        serverMessage ?? `The Warp Registry rejected the publish: HTTP 400.`,
      );
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

    error(
      `Unexpected response from the Warp Registry: HTTP ${response.status}.`,
    );
    return 1;
  } catch (err) {
    if (err instanceof RegistryTimeoutError) {
      reportTimeout(timeoutMs);
      return 1;
    }
    throw err;
  } finally {
    done();
  }
}

/**
 * Timeout in milliseconds for a single publish request, including reading the
 * response body. WARP_PUBLISH_TIMEOUT_MS overrides the default.
 * @returns {number} Timeout in milliseconds.
 */
function publishTimeoutMs() {
  const raw = process.env.WARP_PUBLISH_TIMEOUT_MS;
  if (/^\d+$/.test(String(raw)) && Number(raw) > 0) return Number(raw);
  return DEFAULT_PUBLISH_TIMEOUT_MS;
}

/**
 * Start a deadline for the publish request. The deadline timer aborts the
 * request signal; call done() once the request is finished to cancel it.
 * @returns {{
 *   controller: AbortController,
 *   timeoutMs: number,
 *   done: () => void,
 * }} Deadline handle.
 */
function startDeadline() {
  const controller = new AbortController();
  const timeoutMs = publishTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    timeoutMs,
    done() {
      clearTimeout(timer);
    },
  };
}

/**
 * Report a request that exceeded its deadline.
 * @param {number} timeoutMs - Configured deadline in milliseconds.
 */
function reportTimeout(timeoutMs) {
  error(`The Warp Registry request timed out after ${timeoutMs}ms.`);
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
 * @param {AbortController} controller - Deadline controller for the request.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
async function handleCreated(response, controller) {
  let data;
  try {
    data = await response.json();
  } catch {
    if (controller.signal.aborted) throw new RegistryTimeoutError();
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
 * @param {AbortController} controller - Deadline controller for the request.
 * @returns {Promise<string|null>} The error message, or null if absent.
 */
async function readErrorMessage(response, controller) {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    if (controller.signal.aborted) throw new RegistryTimeoutError();
    // ignore malformed bodies
  }
  return null;
}
