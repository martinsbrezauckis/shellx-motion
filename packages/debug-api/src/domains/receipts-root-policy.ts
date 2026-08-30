/**
 * Containment policy for a caller-supplied `receiptsRoot`.
 *
 * Role: decide whether a debug command may use a receipt root the CALLER named rather than one the
 * host operator configured.
 *
 * WHERE IT IS ENFORCED: at the privilege boundary, not in `dispatchDebugCommand`. Every transport of
 * the loopback debug server applies it once, above the command — `caller-boundary.ts` in this
 * package records who counts as a caller and why the dispatcher itself cannot be the choke point
 * (Motion re-enters it with its own derived paths). An earlier revision of this comment said
 * "enforced centrally, in dispatchDebugCommand", which stopped being true when the check moved to
 * the transport and was worth correcting: a reader who believes the dispatcher enforces it will add
 * a transport and assume it inherited something it did not.
 *
 * It was not always central, and the reason it is now is worth keeping. The policy originally
 * guarded only the four `draft_motion` WRITE commands that reach the host receipt writer
 * (`motion.prompt.run`, `motion.timeline.playhead.set` / `range.select` / `viewport.set`), on the
 * theory that the risk was Motion writing somewhere it should not. That missed the read direction: a
 * security review found `motion.agent.transcript` — permission `read_motion`, the LOWEST tier —
 * accepting the same argument and using it to discover and return prompt transcripts from any
 * process-readable directory holding receipt-shaped JSON. Reading someone else's evidence needs no
 * write at all, and 30-odd commands across a dozen domains take this argument, so a per-command
 * check was always one new command away from being wrong again.
 *
 * Hence: one policy, applied once, above dispatch. A command cannot forget to call it, and a command
 * added tomorrow inherits it without its author knowing this file exists.
 *
 * The trusted set mirrors `qualityOutputRoots` in `index.ts` (`scratchRoot` + `receiptsRoot`),
 * which is what `motion.quality.check` already fences `receiptsRoot` against — this finding is that
 * the other four commands never adopted it. One deliberate difference: `qualityOutputRoots`
 * substitutes a literal `".scratch"` when the host configured no scratch root, and this module does
 * not. A defaulted relative path is a root nobody chose, and the whole point here is that only a
 * root the host named counts, so an unconfigured host fails closed instead of trusting `./.scratch`.
 */
import type { MotionDebugResult } from "../command-registry.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ExistingDirectoryAuthority, type RetainedDirectoryAuthority } from "@shellx-motion/core";

export interface ReceiptsRootPolicyServices {
  /** Host-configured receipts root. Trusted by construction: the host operator, not a caller, sets it. */
  receiptsRoot?: string;
  /** Host-configured scratch root, trusted for the same reason. */
  scratchRoot?: string;
  /**
   * Roots a human at the machine granted during this session, via the Workbench's native folder
   * chooser. Trusted for the same reason as the two above and for one more: the chooser is an OS
   * dialog on the host, so the path is whatever a person physically selected. A Debug API caller can
   * ask for the dialog to open, but cannot decide what comes back, which is what keeps "a caller
   * cannot add a root" true on a surface that must still let an operator point Motion at a folder.
   *
   * Session-scoped on purpose: a grant dies with the server it was made to, so a folder opened once
   * does not silently stay readable to every later process.
   */
  operatorReceiptRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
}

/**
 * Refuse a caller-nominated receipts root that is not inside a host-nominated one, and refuse it
 * outright when the host nominated none.
 *
 * The only form. There used to be a second, looser one — `dispatchReceiptsRootRefusal` — that
 * admitted a caller-named root whenever the host had declared none, justified by "a host that
 * declares nothing is one where caller and host are the same party". That is true of the CLI and of
 * in-process embedders, and they never reach this function: they call `dispatchDebugCommand`, which
 * carries no fence at all. It was false of the one place the loose form was actually wired, the
 * transport boundary, where `startMotionDebugServer` defaults its context to `{}` — so a library
 * embedder's server handed a `read_motion` bearer client any receipt-shaped JSON it could name. The
 * loose form was deleted rather than fixed, because the case it existed for does not pass through
 * here.
 *
 * Used by the boundary (`caller-boundary.ts`) and, underneath it, by the `draft_motion` commands
 * that reach the host receipt WRITER — which is where it started.
 *
 * @param subject - the command name, so the refusal names what the caller actually called.
 * @param requestedReceiptsRoot - the value read from `args`, NOT the resolved
 *   `args.receiptsRoot ?? services.receiptsRoot`. Passing the resolved value would put the host's
 *   own root through a containment check against itself, and — worse — would make the refusal
 *   depend on host configuration in the case where the caller asked for nothing at all.
 * @returns the refusal to return from the dispatcher, or `null` when the write may proceed.
 */
export async function callerReceiptsRootRefusal(
  subject: string,
  requestedReceiptsRoot: string | undefined,
  services: ReceiptsRootPolicyServices
): Promise<MotionDebugResult | null> {
  // The caller named nothing, so the host's own root (or no receipt at all) is what will be used.
  if (!requestedReceiptsRoot) return null;

  const roots = [
    services.receiptsRoot,
    services.scratchRoot,
    ...(services.operatorReceiptRoots ?? [])
  ].filter((root): root is string => Boolean(root));
  if (roots.length === 0 || !services.isPathInsideTrustedRoot) {
    // Same dead end as a tier refusal if it only stated the rule: a caller cannot configure a root,
    // so the message has to route to the person who can and say what to do meanwhile.
    return {
      ok: false,
      error: {
        code: "capability_unavailable",
        message: `This host did not configure a receipts root, so ${subject} cannot validate a caller-supplied receiptsRoot.`,
        suggestedAction: "Omit receiptsRoot to let the host decide where the receipt lands. A caller cannot add a root: the host operator sets receiptsRoot on the Motion debug context, and the shipped debug server derives it from its --receipts-root option.",
        detail: { argument: "receiptsRoot", trustedRoots: [], resolvedBy: "host_operator" }
      },
      warnings: []
    };
  }

  for (const root of roots) {
    if (await services.isPathInsideTrustedRoot(root, requestedReceiptsRoot)) return null;
  }

  return {
    ok: false,
    error: {
      code: "invalid_args",
      message: `${subject} receiptsRoot must be inside a trusted host receipts root. Trusted roots for this session: ${roots.join(", ")}.`,
      suggestedAction: "Pass receiptsRoot as a path inside one of the listed roots, or omit it to use the host default. A caller cannot add a root: the host operator must set receiptsRoot or scratchRoot on the Motion debug context.",
      detail: { argument: "receiptsRoot", trustedRoots: [...roots], resolvedBy: "host_operator" }
    },
    warnings: []
  };
}

/** Revalidate one caller-selected receipt root, then retain its exact directory identity. */
export async function acquireTrustedReceiptsRootAuthority(
  subject: string,
  requestedReceiptsRoot: string,
  services: ReceiptsRootPolicyServices
): Promise<RetainedDirectoryAuthority> {
  const first = await callerReceiptsRootRefusal(subject, requestedReceiptsRoot, services);
  if (first && !first.ok) throw new Error(first.error.message);
  const lexical = resolve(requestedReceiptsRoot);
  const authority = await ExistingDirectoryAuthority.acquire(await realpath(lexical));
  const second = await callerReceiptsRootRefusal(subject, requestedReceiptsRoot, services);
  if (second && !second.ok) throw new Error(second.error.message);
  if (resolve(await realpath(lexical)) !== resolve(authority.path)) {
    throw new Error(`${subject} receiptsRoot changed after admission.`);
  }
  await authority.assertCurrent();
  return authority;
}
