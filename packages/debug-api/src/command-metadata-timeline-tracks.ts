/**
 * Declarative argument contracts for track lifecycle, the track mixer, layer transitions,
 * and caption import.
 *
 * Role: publish what `domains/timeline-tracks.ts`, `domains/timeline-transitions.ts`, and
 * `domains/timeline-captions.ts` read. Every command here mutates through the copy-on-write
 * `packageRoot` + `outDir` boundary.
 *
 * Dependencies: `command-metadata-shared.ts` fragments; enum values by `enumRef`.
 * Primary caller: `command-metadata.ts`.
 */
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, PACKAGE_EDIT, readReceipt, TRACK_ID } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir"];
const EDIT_TRACK = [...EDIT, "trackId"];
const TRACK_BASE = { ...PACKAGE_EDIT, ...TRACK_ID };

/** Caption layers can be placed on an existing track or on a track created by name. */
const CAPTION_PLACEMENT = {
  trackId: { type: "string" as const, aliases: ["track"], description: "Existing track to place caption layers on." },
  trackName: { type: "string" as const, description: "Name for a caption track created when trackId is omitted." },
  transform: { type: "object" as const, description: "Transform applied to every caption layer, for example { y: 900 }." },
  style: { type: "object" as const, description: "Style applied to every caption layer, for example { fontSize: 42, color: \"#fff\" }." }
};

export const TIMELINE_TRACK_COMMAND_METADATA = {
  "motion.timeline.track.create": {
    argsSchema: argsSchema(EDIT, {
      ...PACKAGE_EDIT,
      track: { type: "object", description: "Full track object (id, type, plus optional name/layerIds/order/volume/pan/fade/locked/muted/solo). Supply this or the shorthand fields." },
      trackId: { type: "string", aliases: ["track"], description: "Id for the new track. Required unless track.id is set." },
      type: { type: "string", description: "Track type such as video, audio, or caption. Required unless track.type is set." },
      name: { type: "string", description: "Optional display name." },
      layerIds: { type: "array", aliases: ["layers"], description: "Layer ids to attach, as a string array." },
      index: { type: "number", minimum: 0, description: "Insertion index in the track list; appended when omitted." },
      order: { type: "number", description: "Explicit sort order value; must be finite." },
      volume: { type: "number", minimum: 0, description: "Initial track volume; must be non-negative." },
      pan: { type: "number", description: "Initial stereo pan between -1 and 1." },
      fadeInMs: { type: "number", minimum: 0, description: "Initial fade-in length in milliseconds." },
      fadeOutMs: { type: "number", minimum: 0, description: "Initial fade-out length in milliseconds." },
      locked: { type: "boolean", description: "Whether the track starts locked." },
      muted: { type: "boolean", description: "Whether the track starts muted." },
      solo: { type: "boolean", description: "Whether the track starts soloed." }
    }),
    expectedReceipts: editReceipt("timeline.track.create")
  },
  "motion.timeline.track.reorder": {
    argsSchema: argsSchema([...EDIT_TRACK, "index"], {
      ...TRACK_BASE,
      index: { type: "number", minimum: 0, description: "New position in the track list." }
    }),
    expectedReceipts: editReceipt("timeline.track.reorder")
  },
  "motion.timeline.track.delete": {
    argsSchema: argsSchema(EDIT_TRACK, {
      ...TRACK_BASE,
      detachLayers: { type: "boolean", description: "Detach the track's layers instead of leaving them referenced." }
    }),
    expectedReceipts: editReceipt("timeline.track.delete")
  },
  "motion.timeline.track.rename": {
    argsSchema: argsSchema([...EDIT_TRACK, "name"], {
      ...TRACK_BASE,
      name: { type: "string", aliases: ["trackName"], description: "New track name; must not be blank." }
    }),
    expectedReceipts: editReceipt("timeline.track.rename")
  },
  "motion.timeline.track.lock": {
    argsSchema: argsSchema([...EDIT_TRACK, "locked"], {
      ...TRACK_BASE,
      locked: { type: "boolean", description: "Whether edits to layers on this track are refused." }
    }),
    expectedReceipts: editReceipt("timeline.track.lock")
  },
  "motion.timeline.track.mute": {
    argsSchema: argsSchema([...EDIT_TRACK, "muted"], {
      ...TRACK_BASE,
      muted: { type: "boolean", description: "Whether the track is silenced." }
    }),
    expectedReceipts: editReceipt("timeline.track.mute")
  },
  "motion.timeline.track.solo": {
    argsSchema: argsSchema([...EDIT_TRACK, "solo"], {
      ...TRACK_BASE,
      solo: { type: "boolean", description: "Whether only soloed tracks are audible." }
    }),
    expectedReceipts: editReceipt("timeline.track.solo")
  },
  "motion.timeline.track.volume": {
    argsSchema: argsSchema([...EDIT_TRACK, "volume"], {
      ...TRACK_BASE,
      volume: { type: "number", minimum: 0, description: "Track volume; must be a non-negative finite number." }
    }),
    expectedReceipts: editReceipt("timeline.track.volume")
  },
  "motion.timeline.track.pan": {
    argsSchema: argsSchema([...EDIT_TRACK, "pan"], {
      ...TRACK_BASE,
      pan: { type: "number", description: "Stereo pan; must be a finite number between -1 and 1." }
    }),
    expectedReceipts: editReceipt("timeline.track.pan")
  },
  "motion.timeline.track.fade": {
    argsSchema: argsSchema(EDIT_TRACK, {
      ...TRACK_BASE,
      fadeInMs: { type: "number", minimum: 0, description: "Fade-in length in milliseconds. At least one of fadeInMs or fadeOutMs is required." },
      fadeOutMs: { type: "number", minimum: 0, description: "Fade-out length in milliseconds." }
    }),
    expectedReceipts: editReceipt("timeline.track.fade")
  },
  "motion.timeline.transition.upsert": {
    argsSchema: argsSchema([...EDIT, "layerId", "edge", "type", "durationMs"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      edge: { type: "string", enumRef: "transitionEdge", description: "Which end of the layer the transition applies to." },
      type: { type: "string", enumRef: "transitionType", description: "Transition kind." },
      durationMs: { type: "number", minimum: 0, description: "Transition length in milliseconds; must be positive." },
      easing: { type: "string", enumRef: "easing", description: "Optional easing for the transition." },
      direction: { type: "string", enumRef: "transitionDirection", description: "Optional direction for slide and wipe transitions." },
      distance: { type: "number", minimum: 0, description: "Optional travel distance in pixels for slide transitions." }
    }),
    expectedReceipts: editReceipt("timeline.transition.upsert")
  },
  "motion.timeline.transition.presets": {
    argsSchema: argsSchema([], {}),
    expectedReceipts: readReceipt("timeline.transition.presets")
  },
  "motion.timeline.transition.preset.apply": {
    argsSchema: argsSchema([...EDIT, "layerId", "preset"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      preset: { type: "string", enumRef: "transitionPreset", description: "Named transition preset to apply." },
      durationMs: { type: "number", minimum: 0, description: "Preset duration in milliseconds; must be positive when supplied." },
      direction: { type: "string", enumRef: "transitionDirection", description: "Optional direction override for directional presets." },
      distance: { type: "number", minimum: 0, description: "Optional non-negative travel distance override in pixels." },
      easing: { type: "string", enumRef: "easing", description: "Optional easing override for the preset." }
    }),
    expectedReceipts: editReceipt("timeline.transition.preset.apply")
  },
  "motion.timeline.transition.delete": {
    argsSchema: argsSchema([...EDIT, "layerId", "edge"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      edge: { type: "string", enumRef: "transitionEdge", description: "Which end of the layer to clear." }
    }),
    expectedReceipts: editReceipt("timeline.transition.delete")
  },
  "motion.timeline.caption.import": {
    argsSchema: argsSchema(EDIT, {
      ...PACKAGE_EDIT,
      captionsPath: { type: "string", aliases: ["captionsFile", "path"], description: "Caption file inside a host-approved authoring input root. Required unless captionsText is given." },
      captionsText: { type: "string", aliases: ["source"], description: "Inline caption text, in place of captionsPath." },
      format: { type: "string", enumRef: "captionFormat", description: "Caption source format; inferred from the file extension when omitted." },
      layerPrefix: { type: "string", description: "Prefix for generated caption layer ids." },
      ...CAPTION_PLACEMENT
    }),
    expectedReceipts: editReceipt("timeline.caption.import")
  },
  "motion.timeline.caption.upsert": {
    argsSchema: argsSchema([...EDIT, "id", "text", "startMs", "durationMs"], {
      ...PACKAGE_EDIT,
      id: { type: "string", aliases: ["layerId", "layer"], description: "Caption layer id; an existing caption with this id is replaced." },
      text: { type: "string", description: "Caption text; must not be empty." },
      startMs: { type: "number", minimum: 0, description: "Caption start in milliseconds." },
      durationMs: { type: "number", minimum: 0, description: "Caption duration in milliseconds; must be positive." },
      ...CAPTION_PLACEMENT
    }),
    expectedReceipts: editReceipt("timeline.caption.upsert")
  }
} satisfies MotionDebugCommandMetadata;
