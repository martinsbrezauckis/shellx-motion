/**
 * Exact README commands whose documented contract is platform-specific.
 *
 * The README labels the containing setup block "POSIX checkout authority". Keeping the complete
 * command string here means any documentation edit must make an explicit applicability decision;
 * this must never become a prefix match or a general missing-program exemption.
 */
const POSIX_ONLY_COMMANDS = new Map([
  ["umask 0077", "POSIX-only checkout umask; Windows applies its own filesystem authority model"],
  [
    "chmod go-w shellx-motion",
    "POSIX-only mode-bit repair; Windows applies its own filesystem authority model"
  ]
]);

/**
 * Return why an exact README command does not apply to `platform`, or null when it must still be
 * resolved and checked there.
 *
 * @param {string} command
 * @param {NodeJS.Platform | string} [platform]
 * @returns {string | null}
 */
export function platformInapplicableReason(command, platform = process.platform) {
  if (platform !== "win32") return null;
  return POSIX_ONLY_COMMANDS.get(command) ?? null;
}
