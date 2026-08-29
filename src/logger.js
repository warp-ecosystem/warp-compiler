import pc from "picocolors";

/**
 * Log a success message to the console.
 * @param {string} message - Message to log.
 */
export function success(message) {
  console.log(pc.green(`✓ ${message}`));
}

/**
 * Log a skipped message to the console.
 * @param {string} message - Message to log.
 */
export function skipped(message) {
  console.log(pc.dim(`- ${message}`));
}

/**
 * Log a warning message to the console.
 * @param {string} message - Message to log.
 */
export function warn(message) {
  console.log(pc.yellow(`! ${message}`));
}

/**
 * Log an error message to the console.
 * @param {string} message - Message to log.
 */
export function error(message) {
  console.error(pc.red(`✗ ${message}`));
}
