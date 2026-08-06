/**
 * What ShellX Cut's editable receiver actually accepts.
 *
 * Role: Motion's editable lowering used to be a **deny-list producer** — it enumerated a handful
 * of features it knew Cut could not take, and declared everything else supported. Cut's receiver
 * is an **allow-list consumer**: `exact_payload_fields` rejects any field not on a fixed list.
 * The two disagree structurally, so Motion emitted `mode: "editable_lowering"` with
 * `unsupported: []` for payloads Cut then hard-rejected. A plan that says "fully supported" and
 * fails on arrival is worse than one that admits the gap up front.
 *
 * This module inverts Motion's side: anything not named here is reported as unsupported, so a
 * new Motion feature degrades the plan to `rendered_media` instead of silently promising
 * editability that does not exist.
 *
 * These sets mirror `exact_payload_fields` / `require_identity_transform` in
 * `app/server/src/motion_editable_import.rs` of the ShellX Cut repository. They are duplicated
 * rather than imported because the two products ship independently; when Cut widens its
 * receiver, widening these sets is the deliberate follow-up, and the `receiverSlice` marker below
 * records which Cut behaviour they were verified against.
 *
 * Primary caller: `editableUnsupportedFeatures` in `packages/adapters-cut/src/index.ts`.
 */

/**
 * Identifies the Cut receiver behaviour these sets were read from.
 *
 * Bump this when re-verifying against a newer Cut build, so a stale allow-list is visible rather
 * than assumed current.
 */
export const CUT_EDITABLE_RECEIVER_SLICE = "shellx-cut/motion_editable_import.rs@1";

/** Payload keys Cut accepts per lowered layer verb. */
export const CUT_ACCEPTED_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "cut.title.create": ["text", "transform", "style", "opacity", "keyframes", "transitions"],
  "cut.shape.create": ["shape", "fill", "color", "transform", "style", "opacity", "keyframes", "transitions"],
  "cut.media.create": [
    "kind", "source", "fit", "trimStartMs", "trimDurationMs", "loop", "playbackRate",
    "includeAudio", "opacity", "keyframes", "transitions", "transform", "style"
  ],
  "cut.audio.create": [
    "source", "trimStartMs", "trimDurationMs", "loop", "playbackRate", "volume", "pan",
    "muted", "fadeInMs", "fadeOutMs", "normalizeLoudness"
  ]
});

/** Nested `transform` keys Cut accepts, per verb. */
export const CUT_ACCEPTED_TRANSFORM_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "cut.title.create": ["x", "y", "scale", "rotation"],
  "cut.shape.create": ["x", "y", "width", "height", "scale", "rotation"],
  // A Cut-origin video keeps its own framing; only the identity-checked pair is read.
  "cut.media.create": ["scale", "rotation"]
});

/** Nested `style` keys Cut accepts, per verb. An empty list means style must be absent or empty. */
export const CUT_ACCEPTED_STYLE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "cut.title.create": ["color", "fontSize"],
  "cut.shape.create": ["fill", "stroke", "strokeWidth", "radius", "opacity"],
  "cut.media.create": []
});

/** Keyframe tracks Cut can lower. */
export const CUT_ACCEPTED_KEYFRAME_TRACKS: readonly string[] = Object.freeze(["opacity", "transform.x", "transform.y"]);

/** Transition slots Cut accepts. */
export const CUT_ACCEPTED_TRANSITION_KEYS: readonly string[] = Object.freeze(["in", "out"]);

/**
 * `scale` and `rotation` are accepted as KEYS but must hold identity values.
 *
 * Cut's `require_identity_transform` rejects any scale != 1 or rotation != 0, so a plan carrying
 * a real scale or rotation is not editable even though the key is allowed.
 */
export function violatesIdentityTransform(transform: Record<string, unknown> | undefined): "scale" | "rotation" | null {
  if (!transform) return null;
  const scale = transform.scale;
  if (typeof scale === "number" && Number.isFinite(scale) && Math.abs(scale - 1) > Number.EPSILON) return "scale";
  const rotation = transform.rotation;
  if (typeof rotation === "number" && Number.isFinite(rotation) && Math.abs(rotation) > Number.EPSILON) return "rotation";
  return null;
}

/** Keys present on `record` that `accepted` does not list, in stable order. */
export function unacceptedKeys(record: Record<string, unknown> | undefined, accepted: readonly string[]): string[] {
  if (!record) return [];
  return Object.keys(record).filter((key) => !accepted.includes(key)).sort();
}
