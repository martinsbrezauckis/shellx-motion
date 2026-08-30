/**
 * Declarative argument contracts for the timeline keyframe, spatial-path, and animation-preset commands.
 *
 * Role: publish exactly what `domains/timeline-keyframes-basic.ts`,
 * `domains/timeline-keyframes-bulk.ts`, and `domains/timeline-spatial-path.ts` read.
 * Every one of these commands is a mutation behind the copy-on-write package-edit boundary.
 *
 * Dependencies: `command-metadata-shared.ts` fragments; enum values by `enumRef`.
 * Primary caller: `command-metadata.ts`.
 *
 * Note on ranges: the bulk commands take an optional `startMs`/`endMs` window. Omitting both
 * means "every keyframe on this target", which is why they are optional rather than required.
 */
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, KEYFRAME_TARGET, LAYER_ID, MOTION_EASING, PACKAGE_EDIT } from "./command-metadata-shared.js";

const EDIT_LAYER_TARGET = ["packageRoot", "outDir", "layerId", "target"];

const BASE = { ...PACKAGE_EDIT, ...LAYER_ID, ...KEYFRAME_TARGET };

/** Optional keyframe-selection window shared by every bulk keyframe command. */
const RANGE = {
  startMs: { type: "number" as const, minimum: 0, description: "Window start in milliseconds; unbounded when omitted." },
  endMs: { type: "number" as const, minimum: 0, description: "Window end in milliseconds; unbounded when omitted." }
};

const EASING = MOTION_EASING;

export const TIMELINE_KEYFRAME_COMMAND_METADATA = {
  "motion.timeline.keyframe.upsert": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "atMs", "value"], {
      ...BASE,
      atMs: { type: "number", minimum: 0, description: "Keyframe time in milliseconds. An existing keyframe at this time is replaced." },
      value: { type: ["number", "string"], description: "Keyframe value: a finite NUMBER for numeric targets (transform.*, opacity), or a CSS colour string for colour targets (fill, stroke). Numeric targets reject a numeric string such as \"0\"." },
      easing: EASING
    }),
    expectedReceipts: editReceipt("timeline.keyframe.upsert")
  },
  "motion.timeline.keyframe.delete": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "atMs"], {
      ...BASE,
      atMs: { type: "number", minimum: 0, description: "Time of the keyframe to remove, in milliseconds." }
    }),
    expectedReceipts: editReceipt("timeline.keyframe.delete")
  },
  "motion.timeline.keyframe.range.delete": {
    argsSchema: argsSchema(EDIT_LAYER_TARGET, { ...BASE, ...RANGE }),
    expectedReceipts: editReceipt("timeline.keyframe.range.delete")
  },
  "motion.timeline.keyframe.move": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "fromMs", "toMs"], {
      ...BASE,
      fromMs: { type: "number", minimum: 0, description: "Current time of the keyframe, in milliseconds." },
      toMs: { type: "number", minimum: 0, description: "New time for the keyframe, in milliseconds." }
    }),
    expectedReceipts: editReceipt("timeline.keyframe.move")
  },
  "motion.timeline.keyframe.easing.apply": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "easing"], {
      ...BASE,
      easing: EASING,
      atMs: { type: "number", minimum: 0, description: "Apply to the single keyframe at this time; use startMs/endMs for a window instead." },
      ...RANGE
    }),
    expectedReceipts: editReceipt("timeline.keyframe.easing.apply")
  },
  "motion.timeline.keyframe.shift": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "deltaMs"], {
      ...BASE,
      deltaMs: { type: "number", description: "Milliseconds to move the selected keyframes; must be finite and non-zero." },
      ...RANGE
    }),
    expectedReceipts: editReceipt("timeline.keyframe.shift")
  },
  "motion.timeline.keyframe.scale": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "scale", "originMs"], {
      ...BASE,
      scale: { type: "number", description: "Time-scale factor; must be positive and not 1." },
      originMs: { type: "number", minimum: 0, description: "Fixed point the scaling pivots around, in milliseconds." },
      ...RANGE
    }),
    expectedReceipts: editReceipt("timeline.keyframe.scale")
  },
  "motion.timeline.keyframe.duplicate": {
    argsSchema: argsSchema([...EDIT_LAYER_TARGET, "deltaMs"], {
      ...BASE,
      deltaMs: { type: "number", description: "Offset for the duplicated keyframes; must be finite and non-zero." },
      ...RANGE
    }),
    expectedReceipts: editReceipt("timeline.keyframe.duplicate")
  },
  "motion.timeline.keyframe.distribute": {
    argsSchema: argsSchema(EDIT_LAYER_TARGET, { ...BASE, ...RANGE }),
    expectedReceipts: editReceipt("timeline.keyframe.distribute")
  },
  "motion.timeline.keyframe.reverse": {
    argsSchema: argsSchema(EDIT_LAYER_TARGET, { ...BASE, ...RANGE }),
    expectedReceipts: editReceipt("timeline.keyframe.reverse")
  },
  "motion.timeline.keyframe.snap": {
    argsSchema: argsSchema(EDIT_LAYER_TARGET, {
      ...BASE,
      fps: { type: "number", minimum: 0, description: "Frame rate to snap to; must be positive. Defaults to the motion document fps." },
      mode: { type: "string", enumRef: "keyframeSnapMode", description: "Rounding direction; nearest when omitted." },
      ...RANGE
    }),
    expectedReceipts: editReceipt("timeline.keyframe.snap")
  },
  "motion.timeline.animation.preset.apply": {
    argsSchema: argsSchema(["packageRoot", "outDir", "preset"], {
      ...PACKAGE_EDIT,
      layerId: { type: "string", aliases: ["layer"], description: "Single target layer. Supply this or layerIds." },
      layerIds: { type: "array", aliases: ["layers"], description: "Target layer ids as a string array; enables staggering across the group." },
      preset: { type: "string", enumRef: "animationPreset", description: "Animation preset to apply." },
      startMs: { type: "number", minimum: 0, description: "Preset start time in milliseconds; the layer start when omitted." },
      durationMs: { type: "number", description: "Preset duration in milliseconds; the preset default when omitted." },
      distancePx: { type: "number", description: "Travel distance for slide-style presets, in pixels." },
      staggerMs: { type: "number", minimum: 0, description: "Delay added per layer when layerIds is used." },
      easing: EASING
    }),
    expectedReceipts: editReceipt("timeline.animation.preset.apply")
  },
  "motion.timeline.spatial.position.upsert": {
    argsSchema: argsSchema(["packageRoot", "outDir", "layerId", "atMs", "x", "y"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      atMs: { type: "number", minimum: 0, description: "Position time in milliseconds." },
      x: { type: "number", description: "Horizontal position in pixels." },
      y: { type: "number", description: "Vertical position in pixels." },
      easing: EASING,
      spatial: {
        type: "object",
        description:
          "Optional tangent control { mode, in: { x, y }, out: { x, y } }. mode must be one of the spatialTangentMode "
          + "values and all four handle numbers must be finite."
      }
    }),
    expectedReceipts: editReceipt("timeline.spatial.position.upsert")
  },
  "motion.timeline.spatial.position.move": {
    argsSchema: argsSchema(["packageRoot", "outDir", "layerId", "fromMs", "toMs"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      fromMs: { type: "number", minimum: 0, description: "Current time of the spatial position, in milliseconds." },
      toMs: { type: "number", minimum: 0, description: "New time for the spatial position, in milliseconds." }
    }),
    expectedReceipts: editReceipt("timeline.spatial.position.move")
  },
  "motion.timeline.spatial.position.delete": {
    argsSchema: argsSchema(["packageRoot", "outDir", "layerId", "atMs"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      atMs: { type: "number", minimum: 0, description: "Time of the spatial position to remove, in milliseconds." }
    }),
    expectedReceipts: editReceipt("timeline.spatial.position.delete")
  }
} satisfies MotionDebugCommandMetadata;
