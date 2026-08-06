/**
 * Resolving who is asking.
 *
 * Role: every expensive job records the caller that created it, and visibility is per-owner while
 * scheduling stays global. This module decides the identity a single CLI invocation runs under.
 *
 * Precedence is `--caller-id` over the programmatic option on purpose: an operator running one
 * command is the most specific statement of who is asking, and a host that sets a default should
 * not override the person in front of the terminal.
 *
 * Choose something stable across a host's processes — `"cut:workspace-7"`, not a pid and not a
 * per-connection session id — because a fresh process must be able to recognise work its
 * predecessor started. See docs/public/host-integration.md.
 *
 * Primary caller: the render, preview and capture commands in `packages/cli/src/main.ts`.
 */

/** The owner identity for this invocation: the flag if given, else the host's option. */
export function resolveCallerId(
  argv: string[],
  options: { callerId?: string }
): string | undefined {
  const index = argv.indexOf("--caller-id");
  const flag = index >= 0 ? argv[index + 1]?.trim() : undefined;
  return flag || options.callerId;
}
