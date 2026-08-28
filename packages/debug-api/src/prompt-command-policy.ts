/** Commands deliberately excluded from prompt steering. */
export function promptCommandRefusal(command: string): string | null {
  return command === "motion.revision.transaction"
    ? "motion.revision.transaction is not available through motion.prompt.run; invoke the typed transaction directly."
    : null;
}
