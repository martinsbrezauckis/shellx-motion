/** Exact read-only examples that the documentation gate may execute. */
const READ_ONLY_COMMANDS = [
  ["pnpm", "--filter", "@shellx-motion/cli", "run", "cli", "--", "doctor"],
  ["pnpm", "--filter", "@shellx-motion/cli", "run", "cli", "--", "validate", "fixtures/packages/lower-third"]
];

/**
 * Manifest membership proves a script exists, not that executing it is safe.
 * Return trusted argv only for a complete approved example; extra arguments,
 * aliases, other scripts and other paths require their own policy review.
 *
 * @param {string[]} argv
 * @returns {{file: string, args: string[]} | null}
 */
export function readOnlyReadmeExecution(argv) {
  const approved = READ_ONLY_COMMANDS.find((command) =>
    command.length === argv.length && command.every((token, index) => token === argv[index]));
  return approved ? { file: approved[0], args: approved.slice(1) } : null;
}
