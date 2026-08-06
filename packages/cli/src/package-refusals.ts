/**
 * The refusals `shellx-motion validate` answers with, taken from core rather than restated here.
 *
 * Role: the CLI's `validate` is one of three doors onto the same question ("is this package sound?"),
 * beside the Debug API/MCP `motion.package.validate` and the SDK's `validate`. It had drifted from
 * both — it ran neither the renderability check nor any keyframe check, so `shellx-motion validate` printed
 * `ok: true` for a package the MCP surface refuses and the render lanes reject. One product must not
 * give three answers about one directory depending on which door the caller knocks on.
 *
 * Every door must also run the schema validator. The mutation paths (`workspace-package-patch`,
 * `timeline-package-edit`, `authoring-procedural`) had always validated; only the command whose entire
 * purpose is validation must do the same. A validator that is not run is worse than no validator:
 * it converts "unchecked" into "checked
 * and sound", which is what an agent acts on.
 *
 * All three verdicts are core's (`validateDocument`, `unrenderablePackageRefusal`,
 * `unreadableKeyframesRefusal`), so the code, message and correction are identical across all three
 * surfaces by construction.
 *
 * Dependencies: `@shellx-motion/core`. Primary caller: `validateCommand` in `packages/cli/src/main.ts`.
 */
import {
  ignoredKeyframeFieldsWarning,
  loadSchema,
  unreadableKeyframesRefusal,
  unrenderablePackageRefusal,
  validateDocument,
  type MotionDocument,
  type MotionPackage
} from "@shellx-motion/core";

/** Structured schema errors are truncated in the answer so one malformed document cannot flood a terminal. */
const MAX_REPORTED_SCHEMA_ERRORS = 50;

/**
 * The refusal this package would earn at validate time, or `null` when it is sound.
 *
 * Order matters, and the SPECIALISED verdicts come first; the schema check is the catch-all behind
 * them. An unrenderable layer type is reported before keyframes, because a layer nothing can draw
 * makes its keyframes moot. Both are reported before the schema verdict.
 *
 * That ordering was arrived at the wrong way round and is worth recording. The first version ran the
 * schema check first, reasoning that the other two read fields by name and a malformed document gives
 * them nothing trustworthy to read. Running it proved the opposite: `unreadableKeyframesRefusal`
 * EXISTS to diagnose malformed keyframes, so it is precisely the case it handles best. Schema-first
 * replaced "4 of 4 keyframes cannot be read by the timeline evaluator" plus the exact JSON pointers
 * with "2 error(s)" — a strictly worse answer about the same defect. A general checker must not
 * shadow a specific one; it must cover what the specific ones do not.
 *
 * @param motion the loaded motion document.
 * @param command the CLI command name to echo back in the result.
 * @returns a CLI-shaped failure carrying the structured offenders, or `null`.
 */
export async function packageValidationRefusal(
  motion: MotionDocument,
  command: string
): Promise<(Record<string, unknown> & { ok: false; command: string }) | null> {
  const unrenderable = unrenderablePackageRefusal(motion);
  if (unrenderable) {
    return {
      ok: false,
      command,
      error: {
        code: unrenderable.code,
        message: unrenderable.message,
        suggestedAction: unrenderable.suggestedAction
      },
      unrenderableLayers: unrenderable.layers
    };
  }
  const keyframes = unreadableKeyframesRefusal(motion);
  if (keyframes) {
    return {
      ok: false,
      command,
      error: {
        code: keyframes.code,
        message: keyframes.message,
        suggestedAction: keyframes.suggestedAction
      },
      unreadableKeyframeCount: keyframes.keyframeCount,
      totalKeyframeCount: keyframes.totalKeyframeCount,
      unreadableKeyframeTargetCount: keyframes.targetCount,
      unreadableKeyframes: keyframes.keyframes,
      unreadableKeyframesTruncated: keyframes.truncated
    };
  }
  // The catch-all. Everything the two specialised verdicts do not cover — colours, ranges, enums,
  // environment structure, timing — reaches the caller here instead of passing as sound and then
  // being refused at preview or render, which is what happened before this ran at all.
  const schema = await validateDocument(await loadSchema("motion"), motion);
  if (!schema.ok) {
    return {
      ok: false,
      command,
      error: {
        code: "invalid_motion_document",
        message: `Motion document does not satisfy shellx-motion/motion@1: ${schema.errors.length} error(s).`,
        suggestedAction: "Correct the paths listed in schemaErrors. Each path is a JSON pointer into motion.json."
      },
      schemaErrorCount: schema.errors.length,
      schemaErrors: schema.errors.slice(0, MAX_REPORTED_SCHEMA_ERRORS),
      schemaErrorsTruncated: schema.errors.length > MAX_REPORTED_SCHEMA_ERRORS
    };
  }
  return null;
}

/**
 * Non-blocking observations about a package that is otherwise sound.
 *
 * Separate from {@link packageValidationRefusal} on purpose: a refusal says the package cannot be
 * used, a warning says it will be used in a way the author may not have intended. Collapsing the two
 * would either block documents that render correctly or bury the observation inside a pass.
 *
 * @param motion the loaded motion document.
 * @returns author-facing lines, empty when there is nothing to say.
 */
export function packageValidationWarnings(motion: MotionDocument): string[] {
  const ignoredFields = ignoredKeyframeFieldsWarning(motion);
  return ignoredFields ? [ignoredFields] : [];
}

/**
 * The complete answer `shellx-motion validate` gives about a package — refusal or pass, warnings included.
 *
 * Lives here rather than in `main.ts` so the CLI's answer is assembled beside the verdicts it shares
 * with the Debug API and SDK. The three doors onto "is this package sound?" have drifted apart once
 * already; keeping the whole answer in one module is what stops it happening again.
 *
 * @param pkg the loaded package.
 * @param command the CLI command name to echo back in the result.
 * @returns the CLI-shaped result, ready to print.
 */
export async function packageValidationResult(
  pkg: MotionPackage,
  command: string
): Promise<Record<string, unknown> & { ok: boolean; command: string }> {
  const refusal = await packageValidationRefusal(pkg.motion, command);
  if (refusal) return refusal;
  const warnings = packageValidationWarnings(pkg.motion);
  return {
    ok: true,
    command,
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    name: pkg.manifest.name,
    layers: pkg.motion.layers.length,
    hosts: pkg.manifest.compatibility.hosts,
    lanes: pkg.manifest.compatibility.lanes,
    // Omitted entirely when empty, so a clean package's output is byte-identical to before.
    ...(warnings.length > 0 ? { warnings } : {})
  };
}
