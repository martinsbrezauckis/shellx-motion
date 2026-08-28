/**
 * Declarative argument contracts for timeline reads, UI controls, scenes, markers, duration
 * policy, and reference cleanup.
 *
 * Role: publish what `domains/timeline.ts`, `domains/timeline-controls.ts`,
 * `domains/timeline-scenes-markers.ts`, `domains/timeline-duration-policy.ts`, and
 * `domains/timeline-cleanup.ts` read.
 *
 * Dependencies: `command-metadata-shared.ts` fragments. Primary caller: `command-metadata.ts`.
 *
 * Note on the two write boundaries: playhead/range/viewport persist UI state *inside* the
 * package's trusted state directory and therefore take no `outDir`, while every content
 * mutation goes through the copy-on-write `packageRoot` + `outDir` boundary.
 */
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT, readReceipt } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir"];

/** UI-control writes persist into the package's own trusted state directory, not a copy. */
const CONTROL_STATE = {
  ...PACKAGE_ROOT,
  receiptsRoot: { type: "string" as const, description: "Optional trusted host receipt mirror for the control-state receipt. Durable playhead, range, and viewport persistence currently requires Linux; macOS and Windows return capability_unavailable before creating package state or a receipt." }
};

const SCENE_ID = {
  sceneId: { type: "string" as const, aliases: ["scene", "id"], description: "Target scene id." }
};

export const TIMELINE_STRUCTURE_COMMAND_METADATA = {
  "motion.timeline.panel": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("timeline.panel")
  },
  "motion.timeline.inspect": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("timeline.inspect")
  },
  "motion.timeline.easing.presets": {
    argsSchema: argsSchema([], {}),
    expectedReceipts: readReceipt("timeline.easing.presets")
  },
  "motion.timeline.animation.presets": {
    argsSchema: argsSchema([], {}),
    expectedReceipts: readReceipt("timeline.animation.presets")
  },
  "motion.timeline.playhead.set": {
    argsSchema: argsSchema(["packageRoot"], {
      ...CONTROL_STATE,
      atMs: { type: "number", minimum: 0, description: "New playhead time in milliseconds. Required unless playheadMs is given; must be within the motion duration." },
      playheadMs: { type: "number", minimum: 0, description: "Alternate name for atMs." }
    }),
    expectedReceipts: editReceipt("timeline.playhead.set")
  },
  "motion.timeline.range.select": {
    argsSchema: argsSchema(["packageRoot", "startMs", "endMs"], {
      ...CONTROL_STATE,
      startMs: { type: "number", minimum: 0, description: "Selection start in milliseconds." },
      endMs: { type: "number", minimum: 0, description: "Selection end in milliseconds; must be at or after startMs and within the motion duration." }
    }),
    expectedReceipts: editReceipt("timeline.range.select")
  },
  "motion.timeline.viewport.set": {
    argsSchema: argsSchema(["packageRoot", "startMs", "endMs"], {
      ...CONTROL_STATE,
      startMs: { type: "number", minimum: 0, description: "Visible window start in milliseconds." },
      endMs: { type: "number", minimum: 0, description: "Visible window end in milliseconds; must be greater than startMs and within the motion duration." },
      zoom: { type: "number", minimum: 0, description: "Optional zoom factor; must be positive." },
      pixelsPerSecond: { type: "number", minimum: 0, description: "Optional horizontal scale; must be positive." }
    }),
    expectedReceipts: editReceipt("timeline.viewport.set")
  },
  "motion.timeline.duration.policy": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("timeline.duration.policy")
  },
  "motion.timeline.duration.policy.set": {
    argsSchema: argsSchema([...EDIT, "policy"], {
      ...PACKAGE_EDIT,
      policy: {
        type: "object",
        description:
          "Duration policy { minDurationMs?, maxDurationMs?, resizeMode?, protectedRegions? }. resizeMode is one of the "
          + "durationResizeMode values; protectedRegions is an array of { id, startMs, durationMs } with unique ids."
      }
    }),
    expectedReceipts: editReceipt("timeline.duration.policy.set")
  },
  "motion.timeline.scene.create": {
    argsSchema: argsSchema([...EDIT, "sceneId", "startMs", "durationMs"], {
      ...PACKAGE_EDIT,
      ...SCENE_ID,
      name: { type: "string", aliases: ["sceneName"], description: "Optional display name for the scene." },
      startMs: { type: "number", minimum: 0, description: "Scene start in milliseconds." },
      durationMs: { type: "number", minimum: 0, description: "Scene duration in milliseconds; must be positive." },
      index: { type: "number", minimum: 0, description: "Insertion index in the scene list; appended when omitted." },
      layerIds: { type: "array", description: "Layer ids to attach, as a string array." },
      trackIds: { type: "array", description: "Track ids to attach, as a string array." },
      markerIds: { type: "array", description: "Marker ids to attach, as a string array." },
      layerId: { type: "string", aliases: ["layer"], description: "Single layer id to attach, in place of layerIds." },
      trackId: { type: "string", aliases: ["track"], description: "Single track id to attach, in place of trackIds." },
      markerId: { type: "string", aliases: ["marker"], description: "Single marker id to attach, in place of markerIds." }
    }),
    expectedReceipts: editReceipt("timeline.scene.create")
  },
  "motion.timeline.scene.delete": {
    argsSchema: argsSchema([...EDIT, "sceneId"], { ...PACKAGE_EDIT, ...SCENE_ID }),
    expectedReceipts: editReceipt("timeline.scene.delete")
  },
  "motion.timeline.scene.reorder": {
    argsSchema: argsSchema([...EDIT, "sceneId", "index"], {
      ...PACKAGE_EDIT,
      ...SCENE_ID,
      index: { type: "number", minimum: 0, description: "New position in the scene list." }
    }),
    expectedReceipts: editReceipt("timeline.scene.reorder")
  },
  "motion.timeline.scene.resize": {
    argsSchema: argsSchema([...EDIT, "sceneId", "durationMs"], {
      ...PACKAGE_EDIT,
      sceneId: { type: "string", aliases: ["scene"], description: "Target scene id." },
      durationMs: { type: "number", minimum: 0, description: "New scene duration in milliseconds; must be positive." },
      ripple: { type: "boolean", default: false, description: "Shift later scenes by the same delta instead of leaving a gap or overlap." }
    }),
    expectedReceipts: editReceipt("timeline.scene.resize")
  },
  "motion.timeline.scene.name.set": {
    argsSchema: argsSchema([...EDIT, "sceneId", "name"], {
      ...PACKAGE_EDIT,
      sceneId: { type: "string", aliases: ["scene"], description: "Target scene id." },
      name: { type: "string", aliases: ["sceneName", "value"], description: "New scene name; must not be blank." }
    }),
    expectedReceipts: editReceipt("timeline.scene.name.set")
  },
  "motion.timeline.marker.upsert": {
    argsSchema: argsSchema([...EDIT, "id", "atMs"], {
      ...PACKAGE_EDIT,
      id: { type: "string", aliases: ["markerId"], description: "Marker id; an existing marker with this id is replaced." },
      atMs: { type: "number", minimum: 0, description: "Marker time in milliseconds." },
      durationMs: { type: "number", minimum: 0, description: "Optional marker span in milliseconds; a point marker when omitted." },
      label: { type: "string", description: "Optional marker label." },
      type: { type: "string", description: "Optional marker classification such as chapter or note." },
      color: { type: "string", description: "Optional marker color." },
      sceneId: { type: "string", aliases: ["scene"], description: "Optional scene to attach the marker to." }
    }),
    expectedReceipts: editReceipt("timeline.marker.upsert")
  },
  "motion.timeline.marker.delete": {
    argsSchema: argsSchema([...EDIT, "id"], {
      ...PACKAGE_EDIT,
      id: { type: "string", aliases: ["markerId"], description: "Marker id to remove." }
    }),
    expectedReceipts: editReceipt("timeline.marker.delete")
  },
  "motion.timeline.cleanup": {
    argsSchema: argsSchema(EDIT, { ...PACKAGE_EDIT }),
    expectedReceipts: editReceipt("timeline.cleanup")
  }
} satisfies MotionDebugCommandMetadata;
