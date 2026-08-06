/**
 * Turning an operator's interrupt into a cancellation the engine can act on.
 *
 * Role: the render path has always carried abort plumbing — the job governor accepts a signal,
 * relays it to queued waiters, and the FFmpeg runner forwards it to the child process — but no
 * caller ever supplied one. Ctrl-C therefore killed the CLI and left the ffmpeg child and the
 * Chromium session running, with no receipt written and no record of what happened.
 *
 * Policy encoded here:
 * - The **first** interrupt cancels the work and lets the command report a structured result,
 *   so the caller learns what was produced and what was not.
 * - The **second** interrupt exits immediately. A user pressing Ctrl-C twice means "stop asking
 *   nicely", and honouring that matters more than a tidy result envelope.
 * - Exit status 130 is the conventional "terminated by SIGINT", so a wrapping script can tell a
 *   cancellation apart from a genuine failure.
 *
 * Dependencies: none beyond node:process. Primary caller: the CLI entry point in main.ts.
 */

/** Conventional shell status for a process terminated by SIGINT. */
export const SIGINT_EXIT_CODE = 130;

export interface InterruptScope {
  signal: AbortSignal;
  /** True once an interrupt has been observed, so the caller can adjust its exit status. */
  interrupted: () => boolean;
}

/**
 * Run `body` with an AbortSignal wired to SIGINT and SIGTERM.
 *
 * Handlers are always removed afterwards; a long-lived host that calls this repeatedly must not
 * accumulate listeners.
 *
 * @param body receives the scope; its return value is passed through unchanged.
 * @param exit escape hatch for the hard second-interrupt exit, injectable for tests.
 */
export async function withInterruptSignal<T>(
  body: (scope: InterruptScope) => Promise<T>,
  exit: (code: number) => never = (code) => process.exit(code) as never
): Promise<T> {
  const controller = new AbortController();
  let seen = false;
  const onInterrupt = (signalName: NodeJS.Signals): void => {
    if (seen) exit(SIGINT_EXIT_CODE);
    seen = true;
    controller.abort(new Error(`Cancelled by ${signalName}.`));
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  try {
    return await body({ signal: controller.signal, interrupted: () => seen });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}
