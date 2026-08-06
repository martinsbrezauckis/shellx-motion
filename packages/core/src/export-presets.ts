/**
 * Canonical Motion render/export preset identifiers.
 *
 * Role: single source of truth for the set of delivery presets a full Motion render can target.
 * `@shellx-motion/renderer-ffmpeg` owns the concrete encoder specs (codec/container/args) for these
 * ids, but because `@shellx-motion/core` cannot depend on the renderer package (that would be a
 * dependency cycle), the id list lives here and both sides consume it:
 *   - renderer-ffmpeg derives its preset ordering from this list and a consistency test asserts its
 *     real spec tables cover exactly these ids (so a preset added/removed there without updating this
 *     list fails CI);
 *   - `integration-protocol.ts` advertises {@link MOTION_EXPORT_PRESETS} as the shellx-motion host's
 *     producible preset set, so the connector capability manifest can no longer omit a real preset
 *     (this closed connector-review D6, where `mov-prores` was supported by the renderer but missing
 *     from the advertised preset list).
 *
 * Order is the canonical render/enumeration order (video/animation containers, then image sequence,
 * then still frames) and is deliberately mirrored by renderer-ffmpeg's ordering constants.
 */

/** FFmpeg-encoded delivery presets (video / animation containers), in canonical order. */
export const FFMPEG_EXPORT_PRESETS = [
  "mp4-h264",
  "mp4-hevc",
  "webm-av1",
  "webm-vp9",
  "webm-vp9-alpha",
  "gif",
  "mov-prores"
] as const;

/** Image-sequence delivery presets (numbered frame directories). */
export const IMAGE_SEQUENCE_EXPORT_PRESETS = ["png-sequence"] as const;

/** Single still-frame delivery presets. */
export const STILL_FRAME_EXPORT_PRESETS = ["png-frame", "jpeg-frame"] as const;

/**
 * Every preset id a Motion render can produce, in canonical order. This is the exact set the
 * shellx-motion integration host advertises and the exact union of renderer-ffmpeg's preset tables.
 */
export const MOTION_EXPORT_PRESETS = [
  ...FFMPEG_EXPORT_PRESETS,
  ...IMAGE_SEQUENCE_EXPORT_PRESETS,
  ...STILL_FRAME_EXPORT_PRESETS
] as const;

/** Union of the FFmpeg-encoded delivery preset ids. */
export type FfmpegExportPresetId = (typeof FFMPEG_EXPORT_PRESETS)[number];
/** Union of the image-sequence delivery preset ids. */
export type ImageSequenceExportPresetId = (typeof IMAGE_SEQUENCE_EXPORT_PRESETS)[number];
/** Union of the still-frame delivery preset ids. */
export type StillFrameExportPresetId = (typeof STILL_FRAME_EXPORT_PRESETS)[number];
/** Union of every Motion export preset id. */
export type MotionExportPresetId = (typeof MOTION_EXPORT_PRESETS)[number];
