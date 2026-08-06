/**
 * The one rule for "can the timeline evaluator read this keyframe", and the refusal built from it.
 *
 * WHY THIS MODULE EXISTS
 *
 * An external agent authored a 15-second piece with 309 keyframes written as `{ t, v }` instead of
 * the schema's `{ atMs, value }`. The evaluator's `readNumericKeyframes` returns null the moment a
 * value is not a finite number, so every one of those keyframes was discarded — and nothing said so.
 * The render succeeded, `motion.package.validate` answered `valid: true`, and the delivered MP4 was
 * frozen for ~90% of its duration. The author did the work; the engine threw it away in silence.
 *
 * Before this module the rule was written three times, in three files, by hand:
 *   - `readNumericKeyframes` / `readStringKeyframes` (timeline.ts) — the runtime, which checked
 *     `value` but never `atMs`, so `{ atMs: "0", value: 5 }` produced a NaN sort comparator and NaN
 *     interpolation rather than a clean rejection;
 *   - a byte-identical copy of the same reader in renderer-ffmpeg, for audio automation;
 *   - `isReadableKeyframe` in the debug API's keyframe panel, whose own docstring said it "mirrors
 *     what the timeline evaluator demands" — a hand-kept mirror, i.e. the drift this repo's
 *     one-check pattern (see `unrenderablePackageRefusal` in capabilities.ts) exists to remove.
 *
 * Now there is one predicate. The evaluator consumes it as its gate, the panel consumes it to split
 * readable from unreadable, and `unreadableKeyframesRefusal` consumes it to refuse a package at
 * validate time. They cannot disagree about a keyframe, because they ask the same function.
 *
 * WHY `{ t, v }` IS REFUSED RATHER THAN ACCEPTED AS AN ALIAS
 *
 * Accepting it would mean guessing units. Every real producer that names a keyframe time `t` —
 * Lottie above all — means FRAMES, not milliseconds, and Lottie's `v` is not a keyframe value at all
 * (`s`/`e` carry values; `v` is a property-level flag). Reading `{ t, v }` as `{ atMs, value }` would
 * therefore turn a silent drop into a silent MIS-timing for any document that genuinely came from
 * such a producer, which is the same defect wearing a different hat. Foreign formats already have
 * real doors (`motion.lottie.import`, `motion.dotlottie.import`, `motion.svg.import`), and those
 * lower time explicitly. So the answer names the correct form instead of guessing at the wrong one.
 *
 * Dependencies: `./types` only (type-level). Primary callers: `./timeline` (the evaluator),
 * `./validate` (message wording), `@shellx-motion/debug-api` (panels + `motion.package.validate`),
 * `@shellx-motion/renderer-ffmpeg` (audio automation), `@shellx-motion/cli` (`validate`).
 */
import type { MotionDocument, MotionKeyframe, MotionLayer } from "./types";

/** A keyframe the evaluator can interpolate as a number. */
export type NumericMotionKeyframe = MotionKeyframe & { value: number };

/** A keyframe the evaluator can read as a string (text, colour, enum-valued targets). */
export type StringMotionKeyframe = MotionKeyframe & { value: string };

/**
 * Field names an author plausibly reaches for instead of `atMs`, so a refusal can say which wrong
 * name was used rather than only which right one was missing. Naming the mistake is the difference
 * between "must be a finite number" (true, and useless if the field is not there at all) and "time
 * is written as `t`". Not an accept-list: these are diagnosed, never read.
 */
const KEYFRAME_TIME_ALIASES = ["t", "time", "ms", "at", "atMS", "frame", "frameNumber", "offset", "startMs", "timeMs"];

/** The same, for `value`. See {@link KEYFRAME_TIME_ALIASES}. */
const KEYFRAME_VALUE_ALIASES = ["v", "val", "values", "to", "amount", "s", "e"];

/** How many offenders a refusal carries in full. Beyond this the counts still tell the whole story. */
const MAX_REPORTED_KEYFRAMES = 200;

/** One keyframe the evaluator cannot read, located the way the validator locates its errors. */
export interface UnreadableMotionKeyframe {
  layerId: string;
  target: string;
  index: number;
  /** JSON pointer into the motion document, identical in form to `validateDocument` error paths. */
  path: string;
  /** Author-facing reason, naming the wrong field name when one is recognisable. */
  reason: string;
}

/** A refusal describing keyframes that would be discarded. See {@link unreadableKeyframesRefusal}. */
export interface UnreadableKeyframesRefusal {
  code: "keyframes_unreadable";
  message: string;
  suggestedAction: string;
  /** Total unreadable keyframes in the document, whether or not each one is listed below. */
  keyframeCount: number;
  /** Total keyframes in the document, so a caller can see how much of the animation is affected. */
  totalKeyframeCount: number;
  /** Distinct layer+target tracks holding at least one unreadable keyframe. */
  targetCount: number;
  /** The offenders, capped at {@link MAX_REPORTED_KEYFRAMES}; `truncated` says when the list is short. */
  keyframes: UnreadableMotionKeyframe[];
  truncated: boolean;
}

/**
 * Why the evaluator cannot read `entry`, or `null` when it can.
 *
 * The single authored rule: a finite `atMs` in milliseconds, and a `value` that is either a finite
 * number or a non-empty string. Everything downstream — the numeric reader, the string reader, the
 * panel split, the validate refusal — is this function or a narrowing of it.
 *
 * @param entry a stored keyframe, from JSON and therefore of genuinely unknown shape.
 * @returns a one-line author-facing reason, or `null` if the keyframe is readable.
 */
export function motionKeyframeReadFailure(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "keyframe must be an object of the form { atMs, value }";
  }
  const record = entry as Record<string, unknown>;
  const reasons: string[] = [];
  if (typeof record.atMs !== "number" || !Number.isFinite(record.atMs)) {
    const alias = presentAlias(record, KEYFRAME_TIME_ALIASES);
    reasons.push(alias
      ? `keyframe time is written as "${alias}"; the engine reads "atMs" (milliseconds)`
      : `keyframe "atMs" must be a finite number of milliseconds`);
  }
  if (!isReadableKeyframeValue(record.value)) {
    const alias = presentAlias(record, KEYFRAME_VALUE_ALIASES);
    reasons.push(alias
      ? `keyframe value is written as "${alias}"; the engine reads "value"`
      : `keyframe "value" must be a finite number or a non-empty string`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

/**
 * The wrong field name this keyframe used for its time, when one is recognisable.
 *
 * Exists so `validateDocument` can say "keyframe time is written as `t`" at the `/atMs` path instead
 * of only "must be a finite number", which is true but unhelpful when the field is simply not there.
 * Same authored alias list the refusal uses, so validate and the refusal name the same mistake.
 *
 * @param entry a stored keyframe.
 * @returns the offending field name, or `null` when none of the known aliases is present.
 */
export function motionKeyframeTimeAlias(entry: unknown): string | null {
  return keyframeAlias(entry, KEYFRAME_TIME_ALIASES);
}

/** The wrong field name this keyframe used for its value. See {@link motionKeyframeTimeAlias}. */
export function motionKeyframeValueAlias(entry: unknown): string | null {
  return keyframeAlias(entry, KEYFRAME_VALUE_ALIASES);
}

/**
 * The only fields the evaluator reads off a keyframe. Anything else present is ignored silently.
 */
const KEYFRAME_READ_FIELDS = new Set(["atMs", "value", "easing"]);

/** One keyframe carrying fields the evaluator ignores. See {@link ignoredKeyframeFields}. */
export interface IgnoredKeyframeFields {
  layerId: string;
  target: string;
  index: number;
  /** JSON pointer into the motion document, same form as `validateDocument` error paths. */
  path: string;
  /** The field names present on this keyframe that nothing reads, sorted. */
  fields: string[];
}

/**
 * Keyframes carrying fields the evaluator ignores.
 *
 * `{ atMs: 0, value: 1, t: 0, v: 1 }` reads correctly — `atMs`/`value` are present and well-formed,
 * so the animation runs and {@link unreadableKeyframesRefusal} rightly says nothing. But the author
 * also wrote `t` and `v`, and the engine ignored them without a word. That is this repo's most
 * expensive defect class in miniature: a declaration accepted and not honoured teaches the author
 * something false about their own document.
 *
 * The realistic way it bites is a half-finished migration — a converter that emits both the old and
 * the new spelling, where the OLD pair got updated and the new pair went stale. The engine then times
 * the animation from fields the author no longer considers authoritative, and no surface says which
 * pair won.
 *
 * Reported as a WARNING and never a refusal, deliberately: the document animates correctly, and
 * refusing a package that renders exactly as intended would trade a silent-ignore bug for a
 * cannot-render bug, which is worse for someone mid-project. verified across all 25
 * fixture and template packages carrying keyframes: the only field names in real content are `atMs`,
 * `value` and `easing`, so this warns on nothing that ships today.
 *
 * @param motion document to inspect.
 * @returns one entry per keyframe carrying ignored fields, in document order; empty when none do.
 */
export function ignoredKeyframeFields(motion: MotionDocument): IgnoredKeyframeFields[] {
  const ignored: IgnoredKeyframeFields[] = [];
  motion.layers.forEach((layer, layerIndex) => {
    for (const [target, entries] of Object.entries(layer.keyframes ?? {})) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
        const fields = Object.keys(entry).filter((key) => !KEYFRAME_READ_FIELDS.has(key)).sort();
        if (fields.length === 0) return;
        ignored.push({
          layerId: layer.id,
          target,
          index,
          path: `/layers/${layerIndex}/keyframes/${target}/${index}`,
          fields
        });
      });
    }
  });
  return ignored;
}

/**
 * One author-facing line naming the ignored keyframe fields, or `null` when every field is read.
 *
 * @param motion document to inspect.
 * @returns a warning suitable for a `warnings` array, or `null`.
 */
export function ignoredKeyframeFieldsWarning(motion: MotionDocument): string | null {
  const ignored = ignoredKeyframeFields(motion);
  if (ignored.length === 0) return null;
  const names = [...new Set(ignored.flatMap((entry) => entry.fields))].sort();
  const first = ignored[0];
  return (
    `${ignored.length} keyframe(s) carry field(s) the timeline evaluator never reads: ` +
    `${names.map((name) => `"${name}"`).join(", ")}. First: ${first.path}. ` +
    `A keyframe is read as { atMs, value } with an optional "easing"; anything else is ignored, so ` +
    `timing and values come from "atMs"/"value" even when another field disagrees with them.`
  );
}

/**
 * Whether the timeline evaluator can use this keyframe at all.
 *
 * @param entry a stored keyframe.
 * @returns true when {@link motionKeyframeReadFailure} finds nothing wrong.
 */
export function isReadableMotionKeyframe(entry: unknown): boolean {
  return motionKeyframeReadFailure(entry) === null;
}

/**
 * Every keyframe in `motion` the evaluator would discard, in document order.
 *
 * Tracks that are not arrays are skipped rather than reported: "keyframes must be an object" and
 * "must be an array" are the validator's own structural errors and reporting them here as unreadable
 * keyframes would double-count them under a misleading name.
 *
 * @param motion document to inspect.
 * @returns one entry per unreadable keyframe, empty when every stored keyframe is readable.
 */
export function unreadableMotionKeyframes(motion: MotionDocument): UnreadableMotionKeyframe[] {
  return motion.layers.flatMap((layer, layerIndex) => unreadableLayerKeyframes(layer, layerIndex));
}

/**
 * Every keyframe on ONE layer the evaluator would discard, located as `validateDocument` locates it.
 *
 * Split out from {@link unreadableMotionKeyframes} for the mutation commands: a command that rewrites
 * a single layer's keyframe tracks needs to refuse on THAT layer without dragging an unrelated
 * layer's defects into its message. Same predicate, same path form, so a layer-scoped refusal and
 * the document-wide one can never disagree about a keyframe.
 *
 * @param layer the layer to inspect.
 * @param layerIndex the layer's index in `motion.layers`, so the paths match the validator's.
 * @returns one entry per unreadable keyframe on this layer, empty when every stored keyframe reads.
 */
export function unreadableLayerKeyframes(layer: MotionLayer, layerIndex: number): UnreadableMotionKeyframe[] {
  const unreadable: UnreadableMotionKeyframe[] = [];
  for (const [target, entries] of Object.entries(layer.keyframes ?? {})) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      const reason = motionKeyframeReadFailure(entry);
      if (reason === null) return;
      unreadable.push({
        layerId: layer.id,
        target,
        index,
        path: `/layers/${layerIndex}/keyframes/${target}/${index}`,
        reason
      });
    });
  }
  return unreadable;
}

/**
 * Refuse a mutation that would rewrite keyframe tracks the evaluator cannot read.
 *
 * WHY A MUTATION NEEDS ITS OWN GATE, ON TOP OF THE READ GATE
 *
 * ca8ee4c put the refusal on the READ path — validate and both render lanes. That is where a
 * finished package is judged. It is not where an IN-PROGRESS package lives, and a mutation reaches
 * an in-progress package: the author writes `motion.json` by hand, gets the field names wrong, and
 * runs an editing command before ever running validate.
 *
 * A rewriting mutation then does something the read gate cannot undo. `motion.timeline.layer.split`
 * assigns each keyframe to a half by comparing `atMs` against the split point; a keyframe whose
 * `atMs` is not a number satisfies none of `<`, `>` or `===`, so it lands in NEITHER half and is
 * gone. Measured on the ca8ee4c `{ t, v }` document: four authored keyframes became one synthesized
 * boundary keyframe per half, and the patched document then passed `validateDocument` — the command
 * had deleted every error. The author's work and the evidence of it disappeared in the same step,
 * and the command answered `ok: true` with no warnings.
 *
 * So a mutation that rewrites a track must refuse the tracks it cannot read, before it rewrites
 * them. Read-only introspection is deliberately excluded: the keyframe and easing panels are how an
 * author diagnoses exactly this, and they report rather than refuse.
 *
 * @param layer the layer about to be rewritten.
 * @param layerIndex the layer's index in `motion.layers`.
 * @param operation author-facing name of the mutation, e.g. `"Layer split"`.
 * @throws Error naming the totals, the first offender's path and the correct `{ atMs, value }` form.
 */
export function assertReadableLayerKeyframes(layer: MotionLayer, layerIndex: number, operation: string): void {
  const unreadable = unreadableLayerKeyframes(layer, layerIndex);
  if (unreadable.length === 0) return;
  const total = layerKeyframeCount(layer);
  const first = unreadable[0]!;
  throw new Error(
    `${operation} would rewrite this layer's keyframes, and ${unreadable.length} of ${total} of them`
    + ` cannot be read by the timeline evaluator. First: ${first.path} — ${first.reason}.`
    + ` Write every keyframe as { "atMs": <milliseconds>, "value": <number or string> };`
    + ` motion.timeline.keyframes.panel lists every offender by layer and target.`
    + ` Nothing downstream can recover a keyframe the evaluator cannot read, so this refuses`
    + ` rather than proceeding and losing it.`
  );
}

/** Total stored keyframes on one layer, readable or not. See {@link motionKeyframeCount}. */
export function layerKeyframeCount(layer: MotionLayer): number {
  let total = 0;
  for (const entries of Object.values(layer.keyframes ?? {})) {
    if (Array.isArray(entries)) total += entries.length;
  }
  return total;
}

/**
 * Total stored keyframes in `motion`, readable or not — the denominator a refusal quotes.
 *
 * @param motion document to inspect.
 * @returns the count across every layer and target.
 */
export function motionKeyframeCount(motion: MotionDocument): number {
  return motion.layers.reduce((total, layer) => total + layerKeyframeCount(layer), 0);
}

/**
 * The one verdict every surface answers with when a package's animation cannot run.
 *
 * A package whose keyframes the evaluator cannot read is not a valid package: answering "valid" and
 * then rendering a motionless video is the worst answer the engine can give, because the author is
 * told the work landed and is left with nothing to act on. `motion.package.validate`, the CLI's
 * `validate`, and the render lanes all call this function, so no surface can accept what another
 * refuses — there is one check, not copies that drift.
 *
 * Deliberately NOT gated on a threshold: one discarded keyframe is still work the author did and the
 * engine threw away, and "mostly animates" is not a verdict this command is able to justify.
 *
 * @param motion document to inspect.
 * @returns the refusal (code, message, correction, located offenders) or `null` when every stored
 *          keyframe is readable.
 */
export function unreadableKeyframesRefusal(motion: MotionDocument): UnreadableKeyframesRefusal | null {
  const unreadable = unreadableMotionKeyframes(motion);
  if (unreadable.length === 0) return null;
  const totalKeyframeCount = motionKeyframeCount(motion);
  const targetCount = new Set(unreadable.map((entry) => JSON.stringify([entry.layerId, entry.target]))).size;
  const first = unreadable[0]!;
  return {
    code: "keyframes_unreadable",
    message: `${unreadable.length} of ${totalKeyframeCount} keyframes cannot be read by the timeline`
      + ` evaluator and would not animate, across ${targetCount} ${targetCount === 1 ? "target" : "targets"}.`
      + ` First: ${first.path} — ${first.reason}.`,
    suggestedAction: "Write every keyframe as { \"atMs\": <milliseconds>, \"value\": <number or string> };"
      + " `easing` is the only other field the engine reads. The `keyframes` list on this refusal gives"
      + " the exact JSON path of each offender, and motion.timeline.keyframes.panel groups them by layer"
      + " and target. To bring animation in from Lottie, dotLottie or SVG, use the import commands rather"
      + " than hand-writing their field names — those lower time to milliseconds for you.",
    keyframeCount: unreadable.length,
    totalKeyframeCount,
    targetCount,
    keyframes: unreadable.slice(0, MAX_REPORTED_KEYFRAMES),
    truncated: unreadable.length > MAX_REPORTED_KEYFRAMES
  };
}

/**
 * Fail a render before it starts when the document's animation cannot run.
 *
 * The render lanes need the same verdict validate gives, and they need it as a throw, because a
 * render that proceeds is a render that produces a motionless file and a `passed` receipt. Both
 * frame lanes call this at session open — beside their existing capability gate — so preview and
 * final, browser and native, refuse identically. Message and correction come from
 * {@link unreadableKeyframesRefusal}, so a lane cannot word this differently from `motion.package.validate`.
 *
 * @param motion document about to be rendered.
 * @throws Error naming the totals, the first offender and the correct `{ atMs, value }` form.
 */
export function assertReadableMotionKeyframes(motion: MotionDocument): void {
  const refusal = unreadableKeyframesRefusal(motion);
  if (refusal) throw new Error(`${refusal.message} ${refusal.suggestedAction}`);
}

/**
 * Read a track as all-numeric keyframes, or refuse the track.
 *
 * All-or-nothing by design: interpolating across a track where some entries are unreadable would
 * invent a curve the author never wrote. The refusal is silent HERE on purpose — this runs per
 * property per frame, thousands of times per render, and is far too hot to report from. Reporting is
 * the gate's job (`unreadableKeyframesRefusal` at validate and render entry), which is why both are
 * built on the same predicate: what this drops is exactly what the gate names.
 *
 * @param keyframes stored track.
 * @returns the numeric keyframes, or `null` when any entry is unreadable or non-numeric.
 */
export function readNumericKeyframes(keyframes: MotionKeyframe[]): NumericMotionKeyframe[] | null {
  const numericKeyframes: NumericMotionKeyframe[] = [];
  for (const keyframe of keyframes) {
    if (!isReadableMotionKeyframe(keyframe) || typeof keyframe.value !== "number") return null;
    numericKeyframes.push({
      atMs: keyframe.atMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    });
  }
  return numericKeyframes;
}

/**
 * Read a track as all-string keyframes, or refuse the track. See {@link readNumericKeyframes} for
 * why this is all-or-nothing and why it does not report.
 *
 * @param keyframes stored track.
 * @returns the trimmed string keyframes, or `null` when any entry is unreadable or non-string.
 */
export function readStringKeyframes(keyframes: MotionKeyframe[]): StringMotionKeyframe[] | null {
  const stringKeyframes: StringMotionKeyframe[] = [];
  for (const keyframe of keyframes) {
    if (!isReadableMotionKeyframe(keyframe) || typeof keyframe.value !== "string") return null;
    stringKeyframes.push({
      atMs: keyframe.atMs,
      value: keyframe.value.trim(),
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    });
  }
  return stringKeyframes;
}

function isReadableKeyframeValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim().length > 0;
}

function presentAlias(record: Record<string, unknown>, aliases: readonly string[]): string | null {
  return aliases.find((alias) => alias in record && record[alias] !== undefined) ?? null;
}

function keyframeAlias(entry: unknown, aliases: readonly string[]): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  return presentAlias(entry as Record<string, unknown>, aliases);
}
