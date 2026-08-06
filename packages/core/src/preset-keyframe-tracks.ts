/**
 * How a preset's keyframe tracks land on a layer that already has keyframes — and what the author
 * is told about it.
 *
 * WHY THIS MODULE EXISTS
 *
 * `applyTransitionPresetToLayer` and `applyTypographyPresetToLayer` each merged a preset's tracks
 * into a layer with a spread at the TARGET level:
 *
 *     keyframes: { ...(layer.keyframes ?? {}), ...compiled.keyframes }
 *
 * That is a whole-track REPLACE, not a merge — every keyframe the author had written on a target the
 * preset also writes is dropped. The transition version was even named `mergeKeyframes` and
 * documented as a merge. Both then returned `warnings: compiled.warnings`, and both compilers
 * hard-code `warnings: []`, so the return value could not carry the news. A typography preset always
 * writes `opacity`, so "apply a title entrance to a layer I had already animated" silently discarded
 * the author's opacity curve and reported success.
 *
 * REPLACE IS KEPT; THE SILENCE IS NOT
 *
 * Replacing is the right semantics and this module does not change it. A preset is a designed curve
 * — `title-entrance` is a fade and a rise timed against each other — and interleaving its keyframes
 * with the author's by timestamp yields a curve neither of them wrote, which is a worse answer than
 * either. What was wrong is that the author could not tell it had happened. So the operation now
 * reports which targets it replaced and how many keyframes went with each, and the two preset
 * families ask the same function, so they cannot word it differently or drift apart.
 *
 * Dependencies: `./types` only (type-level). Primary callers: `./transition-presets`,
 * `./typography-presets`.
 */
import type { MotionKeyframe, MotionKeyframeTarget, MotionLayer } from "./types";

/** One authored track a preset overwrote. */
export interface ReplacedKeyframeTrack {
  target: string;
  /** How many authored keyframes the preset's track displaced. */
  replacedKeyframeCount: number;
  /** How many keyframes the preset wrote in their place. */
  presetKeyframeCount: number;
}

/**
 * Lay a preset's tracks over a layer's, target by target, and record every track that was displaced.
 *
 * @param existing the layer's stored keyframe map, possibly absent.
 * @param next the preset's compiled tracks.
 * @returns the resulting map and one {@link ReplacedKeyframeTrack} per overwritten target, in the
 *          preset's own target order so the report is deterministic.
 */
export function replaceKeyframeTracks(
  existing: MotionLayer["keyframes"] | undefined,
  next: Partial<Record<MotionKeyframeTarget, MotionKeyframe[]>>
): { keyframes: MotionLayer["keyframes"]; replaced: ReplacedKeyframeTrack[] } {
  const replaced: ReplacedKeyframeTrack[] = [];
  for (const [target, presetTrack] of Object.entries(next)) {
    const authored = existing?.[target as MotionKeyframeTarget];
    // An empty authored track is not work the author will miss, so it is not reported.
    if (!Array.isArray(authored) || authored.length === 0) continue;
    replaced.push({
      target,
      replacedKeyframeCount: authored.length,
      presetKeyframeCount: Array.isArray(presetTrack) ? presetTrack.length : 0
    });
  }
  return {
    keyframes: { ...(existing ?? {}), ...next },
    replaced
  };
}

/**
 * One warning line per displaced track, naming the target, the loss and the command that undoes it.
 *
 * @param presetId the preset that was applied.
 * @param layerId the layer it was applied to.
 * @param replaced the tracks {@link replaceKeyframeTracks} displaced.
 * @returns author-facing warnings, empty when nothing was displaced — a layer with no prior
 *          keyframes on the preset's targets is completely unaffected.
 */
export function replacedTrackWarnings(presetId: string, layerId: string, replaced: ReplacedKeyframeTrack[]): string[] {
  return replaced.map((track) =>
    `Preset ${presetId} replaced the existing ${track.target} keyframes on layer ${layerId}:`
    + ` ${track.replacedKeyframeCount} authored ${track.replacedKeyframeCount === 1 ? "keyframe" : "keyframes"}`
    + ` were discarded and ${track.presetKeyframeCount} from the preset written in their place.`
    + ` A preset owns the whole track, so its curve stays coherent; re-author the values you need with`
    + ` motion.timeline.keyframe.upsert after applying it.`
  );
}
