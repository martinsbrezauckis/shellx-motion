/**
 * The one place a Motion permission refusal is worded.
 *
 * Role: a `suggestedAction` is a promise that the receiving caller can act on it. Every tier
 * refusal in the engine used to break that promise the same way — "Retry with write_local
 * permission." — for a caller that has no way to obtain write_local:
 *   - Motion publishes no elevation command (`motion.actions.find("permission elevation")` is empty);
 *   - the debug server caps `requestedTier` at the tier granted when the process started, so asking
 *     for more over MCP is rejected with -32001;
 *   - nothing in the refusal named the process, the flag, or the person who could change it.
 * An agent reading "retry with X" retries, is refused identically, and burns the loop. That is
 * worse than no suggestion at all, which is why this is a defect and not a wording preference.
 *
 * Mechanism: one builder, used by every refusal site, that states (a) what was required, (b) what
 * this session actually holds, (c) that the caller cannot change it, and (d) the concrete change
 * the HOST OPERATOR makes. The audience of the suggestedAction is switched from the agent — which
 * is powerless here — to the human or host process that is not.
 *
 * Dependencies: the tier vocabulary from `./catalog.js` (type-only; erased at runtime).
 *
 * Primary callers: `debug-api/src/index.ts` (the dispatch tier gate), `prompt/src/index.ts`
 * (the prompt plan tier gate), `debug-server/src/index.ts` (requestedTier and SDK gates).
 */
import type { MotionPermissionTier } from "./catalog.js";

/**
 * How the shipped `shellx-motion-debug-server` grant is changed.
 *
 * Named concretely rather than abstractly because "ask for more permission" is the non-answer this
 * module exists to delete. An embedding host that grants tiers some other way passes its own
 * sentence as `hostGrantHint` — the wording is a default, not an assumption about every host.
 */
export function debugServerGrantHint(requiredTier: MotionPermissionTier): string {
  const flags = [`--tier ${requiredTier}`, "--trusted-local-tier"];
  // push_remote carries a second, separate switch: the trusted-local flag alone does not unlock it.
  if (requiredTier === "push_remote") flags.push("--allow-push-remote");
  return `restart the Motion debug server with \`${flags.join(" ")}\``;
}

/** The machine-readable half of a tier refusal, for a caller that would rather branch than parse. */
export interface MotionTierRefusalDetail {
  requiredTier: MotionPermissionTier;
  grantedTier?: MotionPermissionTier;
  /** Always "unavailable": Motion ships no command that raises a caller's own tier. */
  selfElevation: "unavailable";
  /** Who has to act for this call to become possible. */
  resolvedBy: "host_operator";
  hostAction: string;
}

/** A refusal shaped like every other Motion error, plus the detail block. */
export interface MotionTierRefusal {
  code: "permission_denied";
  message: string;
  suggestedAction: string;
  detail: MotionTierRefusalDetail;
}

export interface TierRefusalInput {
  /** What was refused, in the caller's own vocabulary: a command id, or "Prompt plan". */
  subject: string;
  requiredTier: MotionPermissionTier;
  /** The tier this session actually holds, when the refusing layer knows it. */
  grantedTier?: MotionPermissionTier;
  /** Host-specific replacement for {@link debugServerGrantHint}. */
  hostGrantHint?: string;
}

/**
 * Build a tier refusal whose suggestedAction is addressed to someone who can perform it.
 *
 * @param input.subject - the refused command id or plan, used verbatim in the message.
 * @param input.requiredTier - the tier the operation needs.
 * @param input.grantedTier - the tier the session holds; omitted only when the layer cannot know it.
 * @returns the error body to place under `error` in a `MotionDebugResult`.
 *
 * Edge case: `grantedTier` equal to or above `requiredTier` is not expected here — callers only
 * build a refusal after the check failed — and the wording does not special-case it, because a
 * refusal that claims the tier is sufficient would be a lie about a state that cannot occur.
 */
export function tierRefusal(input: TierRefusalInput): MotionTierRefusal {
  const hostAction = input.hostGrantHint ?? debugServerGrantHint(input.requiredTier);
  const held = input.grantedTier ? `; this session holds ${input.grantedTier}` : "";
  return {
    code: "permission_denied",
    message: `${input.subject} requires ${input.requiredTier}${held}.`,
    suggestedAction:
      `This caller cannot raise its own permission tier: Motion publishes no elevation command, and requestedTier is capped at the tier the host granted when it started. ` +
      `To allow this call the host operator must ${hostAction}, then reconnect. ` +
      `Without that change, use motion.actions.panel to list the actions available at${input.grantedTier ? ` ${input.grantedTier}` : " the granted tier"}.`,
    detail: {
      requiredTier: input.requiredTier,
      ...(input.grantedTier ? { grantedTier: input.grantedTier } : {}),
      selfElevation: "unavailable",
      resolvedBy: "host_operator",
      hostAction
    }
  };
}

/**
 * The same refusal for a tier the caller ASKED for over the wire, rather than one a command needed.
 *
 * Split from {@link tierRefusal} because the fix differs: there is no command to drop down to, the
 * request itself is the thing that cannot be granted, and the honest instruction is to stop sending
 * requestedTier above the grant.
 */
export function requestedTierRefusal(input: {
  requestedTier: MotionPermissionTier;
  grantedTier: MotionPermissionTier;
  hostGrantHint?: string;
}): MotionTierRefusal {
  const hostAction = input.hostGrantHint ?? debugServerGrantHint(input.requestedTier);
  return {
    code: "permission_denied",
    // First sentence preserved verbatim: hosts and tests match on it, and it is already accurate.
    message:
      `Requested Motion permission tier ${input.requestedTier} exceeds the authenticated server grant ${input.grantedTier}. ` +
      `A caller cannot raise the grant; the host operator must ${hostAction}.`,
    suggestedAction:
      `Omit requestedTier, or send a tier at or below ${input.grantedTier} — the server grant is fixed for the life of the process and no Motion command changes it. ` +
      `To raise it, the host operator must ${hostAction}, then reconnect.`,
    detail: {
      requiredTier: input.requestedTier,
      grantedTier: input.grantedTier,
      selfElevation: "unavailable",
      resolvedBy: "host_operator",
      hostAction
    }
  };
}

/**
 * A refusal for a path outside every trusted root.
 *
 * Same class as a tier refusal: the old message named the rule and neither the roots in force nor
 * who sets them, so an agent could only guess paths. Listing the roots makes the retry mechanical.
 *
 * @param roots - the absolute roots in force for this session; may be empty when the host
 *   configured none, which is itself the answer the caller needs.
 */
export function trustedRootRefusal(input: {
  subject: string;
  argument: string;
  roots: string[];
  hostGrantHint?: string;
}): { code: "invalid_args"; message: string; suggestedAction: string; detail: { argument: string; trustedRoots: string[]; resolvedBy: "host_operator"; hostAction: string } } {
  const hostAction = input.hostGrantHint
    ?? "start the Motion debug server from the directory that should be trusted, or pass promptCwdRoots in the embedding host's debug context";
  const roots = input.roots.length > 0
    ? `Trusted roots for this session: ${input.roots.join(", ")}.`
    : "This session has no trusted prompt working roots configured.";
  return {
    code: "invalid_args",
    message: `${input.subject} ${input.argument} must be inside a trusted prompt working root. ${roots}`,
    suggestedAction: input.roots.length > 0
      ? `Pass ${input.argument} as a path inside one of the listed roots, or omit ${input.argument} to use the host default. A caller cannot add a root: the host operator must ${hostAction}.`
      : `Omit ${input.argument}. A caller cannot add a root: the host operator must ${hostAction}.`,
    detail: { argument: input.argument, trustedRoots: [...input.roots], resolvedBy: "host_operator", hostAction }
  };
}
