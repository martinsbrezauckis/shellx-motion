/**
 * The JSON envelope for anything that escapes `runCli`.
 *
 * Extracted from main.ts rather than left inline: that file sits at a 7427-line non-growth cap.
 * Raising legacy caps is not the normal path, and this is a self-contained concern with no other dependency on
 * the command dispatcher.
 *
 * Dependencies: `@shellx-motion/core` for the job error's machine-readable code.
 * Primary caller: `main()` in ./main.ts.
 */
import { LocalMotionJobError, sanitizeUntrustedDiagnostic } from "@shellx-motion/core";
import type { CliResult } from "./main.js";

/** Escaped throws are untrusted process/provider text even in the CLI's final envelope. */
export const MAX_CLI_UNHANDLED_FAILURE_RAW_BYTES = 64 * 1024;
export const MAX_CLI_UNHANDLED_FAILURE_PUBLIC_BYTES = 4 * 1024;

/**
 * Turn anything thrown out of `runCli` into the JSON envelope every other outcome uses.
 *
 * Every command in this CLI answers with `{ ok, command, ... }` on stdout, and an agent's whole
 * loop is built on parsing that. A thrown error broke the contract completely: Node printed an
 * unhandled-rejection stack trace to stderr and the agent's parser got nothing at all — not a
 * failure it could read, just silence where the answer should be.
 *
 * Found via a real authoring session: `job_rss_limit_exceeded` is raised by the job governor when a
 * render's process tree crosses the memory ceiling, and it escaped `renderCommand` unhandled. That
 * is the single most likely error for an agent rendering something ambitious, and it was the one
 * error it could not read. Handled generically rather than for that one code, because the defect is
 * "an escaped throw is invisible", not "this particular throw is invisible".
 *
 * `LocalMotionJobError` carries a machine-readable `code`; anything else becomes `internal_error`
 * so the shape is still parseable and the message still says what happened.
 *
 * @param error whatever was thrown.
 * @returns a CLI-shaped failure.
 */
export function unhandledFailure(error: unknown): CliResult {
  const code = error instanceof LocalMotionJobError ? error.code : "internal_error";
  return {
    ok: false,
    command: process.argv[2] ?? "shellx-motion",
    error: {
      code,
      message: unhandledDiagnostic(error),
      suggestedAction: code === "job_rss_limit_exceeded"
        ? "The render exceeded Motion's process-tree memory ceiling. Reduce frame count, resolution, motion-blur samples or environment layers, or raise SHELLX_MOTION_MAX_JOB_RSS_BYTES. See skill/shellx-motion/references/environments-depth-and-budget.md."
        : code === "job_input_budget_exceeded"
          ? "The render exceeds this host's bounded input capacity. Run doctor and motion.capabilities.match, then reduce the stated workload or use a host with a larger admitted tier."
        : "This is an unhandled Motion error. Re-run with the same arguments to confirm it reproduces, and report the code and message."
    }
  };
}

function unhandledDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = sanitizeUntrustedDiagnostic(message, {
    rawMaxBytes: MAX_CLI_UNHANDLED_FAILURE_RAW_BYTES,
    publicMaxBytes: MAX_CLI_UNHANDLED_FAILURE_PUBLIC_BYTES,
    collapseWhitespace: true
  });
  return safe || "Unhandled Motion error.";
}
