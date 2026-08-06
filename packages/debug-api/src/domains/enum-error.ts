/**
 * Typed errors for rejected enumerated argument values.
 *
 * Role: an error that says only "unsupported X" tells the caller what failed and not what to
 * do instead, which forces an agent to go read engine source to recover. Every error built
 * here carries the valid alternatives in `suggestedAction`, resolved from the same published
 * enum dictionary that `schemas/debug.json` advertises — so the runtime error and the
 * published contract cannot disagree.
 *
 * Dependencies: `../command-metadata-enums.js`. Primary callers: the domain handlers that
 * validate enumerated arguments (transitions, keyframe snap, captions, ducking, screenshot,
 * render frame lane).
 */
import { debugArgEnum } from "../command-metadata-enums.js";
import type { MotionDebugResult } from "../command-registry.js";

/**
 * Build an `invalid_args` failure that names the accepted values.
 *
 * @param argument - the argument name as the caller passed it.
 * @param value - the rejected value, echoed so the caller can see what was read.
 * @param allowed - either a published `argEnums` key, or an explicit value list when the
 *   accepted set is narrower than the published enum (for example the Debug API accepts only
 *   the browser frame lane even though the CLI knows two).
 * @param extra - optional sentence appended to `suggestedAction` for cross-surface hints.
 * @returns a failing `MotionDebugResult`; the message keeps the existing wording so callers
 *   matching on it keep working, and the fix lands in `suggestedAction`.
 */
export function unsupportedEnumValue(
  argument: string,
  value: unknown,
  allowed: string | readonly string[],
  extra?: string
): MotionDebugResult {
  const values = typeof allowed === "string" ? debugArgEnum(allowed)?.values ?? [] : [...allowed];
  const list = values.join(", ");
  return {
    ok: false,
    error: {
      code: "invalid_args",
      message: `Unsupported ${argument}: ${String(value)}.`,
      suggestedAction: `${argument} must be one of: ${list}.${extra ? ` ${extra}` : ""}`,
      detail: { argument, value, allowedValues: values }
    },
    warnings: []
  };
}

/**
 * Build an `invalid_args` failure for a required enumerated argument that was missing.
 *
 * @param command - the debug command id, used verbatim in the message.
 * @param argument - the missing argument name.
 * @param allowed - a published `argEnums` key or an explicit value list.
 */
export function missingEnumValue(command: string, argument: string, allowed: string | readonly string[]): MotionDebugResult {
  const values = typeof allowed === "string" ? debugArgEnum(allowed)?.values ?? [] : [...allowed];
  return {
    ok: false,
    error: {
      code: "invalid_args",
      message: `${command} requires ${argument}.`,
      suggestedAction: `${argument} must be one of: ${values.join(", ")}.`,
      detail: { argument, allowedValues: values }
    },
    warnings: []
  };
}
