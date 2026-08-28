/**
 * Declarative argument contracts for the timeline layer commands.
 *
 * Role: publish, per command, exactly which arguments the handlers in
 * `domains/timeline-layers-structural.ts`, `domains/timeline-layer-properties.ts`, and
 * `domains/timeline-layer-relations.ts` read — names, types, aliases, required set, and
 * allowed values — so an agent can call them from the published contract alone.
 *
 * Dependencies: `command-metadata-shared.ts` (edit-boundary and selector fragments),
 * `command-metadata-enums.ts` via `enumRef` names.
 * Primary caller: `command-metadata.ts`, which merges every metadata module into
 * `DEBUG_COMMAND_METADATA` and from there into `schemas/debug.json`.
 *
 * Invariant: `additionalProperties: false` here means the handler ignores anything else, so
 * every alias the handler falls back to (`layerId` <- `layer`, `outDir` <- `packageDir`, ...)
 * must appear. `command-metadata.test.ts` re-checks the required lists against the handlers.
 */
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, PACKAGE_EDIT, TRACK_ID } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir"];

/** Shorthand string fields that `timelineLayerCreateArg` folds into the created layer. */
const CREATE_SHORTHAND = {
  type: { type: "string" as const, description: "Layer type such as text, shape, image, video, audio, or environment." },
  text: { type: "string" as const, description: "Text content for text layers." },
  shape: { type: "string" as const, description: "Shape kind for shape layers such as rect or ellipse." },
  fill: { type: "string" as const, description: "Fill color for shape layers." },
  source: { type: "string" as const, description: "Media source path relative to the package for image, video, and audio layers." },
  src: { type: "string" as const, description: "Alternate media source field written straight onto the layer." },
  assetId: { type: "string" as const, description: "Package asset id to bind the layer to." },
  assetRef: { type: "string" as const, description: "Package asset reference to bind the layer to." },
  color: { type: "string" as const, description: "Text color; folded into layer.style.color." },
  fontSize: { type: "number" as const, minimum: 0, description: "Text size in pixels; folded into layer.style.fontSize. Must be positive." },
  width: { type: "number" as const, minimum: 0, description: "Layer width in pixels. Must be positive." },
  height: { type: "number" as const, minimum: 0, description: "Layer height in pixels. Must be positive." }
};

/** `property`/`value` setters share one shape; only the alias names differ per command. */
function propertySetter(propertyAlias: string, valueAlias: string, propertyDescription: string) {
  return argsSchema([...EDIT, "layerId", "property", "value"], {
    ...PACKAGE_EDIT,
    ...LAYER_ID,
    property: { type: "string", aliases: ["property", propertyAlias], description: propertyDescription },
    value: {
      type: "string",
      aliases: [valueAlias],
      description: "New value. Strings, numbers, and booleans are all accepted; the type is validated against the target property."
    }
  });
}

export const TIMELINE_LAYER_COMMAND_METADATA = {
  "motion.timeline.layer.create": {
    argsSchema: argsSchema(EDIT, {
      ...PACKAGE_EDIT,
      layer: {
        type: "object",
        description:
          "Full layer object (id, type, startMs, durationMs, plus optional name/opacity/transform/keyframes/transitions/"
          + "mask/effects/environment/emitter/pointCloud/blendMode/crop/ducking/style). A points layer carries bounded declarative data, never code; particles and points may declare static effects.trail lookback strokes (durationMs 1..2000, samples 2..8), not physics, history, formulas, or GPU work. A particles emitter may carry one to three bounded analytic radial/vortex field sources. Supply this, or the shorthand fields below."
      },
      layerId: { type: "string", aliases: ["layer"], description: "Id for the new layer. Required unless layer.id is set." },
      trackId: { type: "string", aliases: ["track"], description: "Track to attach the new layer to." },
      startMs: { type: "number", minimum: 0, description: "Layer start time in milliseconds. Required unless layer.startMs is set." },
      durationMs: { type: "number", minimum: 0, description: "Layer duration in milliseconds; must be positive. Required unless layer.durationMs is set." },
      index: { type: "number", minimum: 0, description: "Insertion index in the layer stack; appended when omitted." },
      trackIndex: { type: "number", minimum: 0, description: "Insertion index inside the target track's layer list." },
      ...CREATE_SHORTHAND
    }),
    expectedReceipts: editReceipt("timeline.layer.create")
  },
  "motion.timeline.layer.trim": {
    argsSchema: argsSchema([...EDIT, "layerId"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      startMs: { type: "number", minimum: 0, description: "New timeline start in milliseconds." },
      durationMs: { type: "number", minimum: 0, description: "New timeline duration in milliseconds; must be positive." },
      trimStartMs: { type: "number", minimum: 0, description: "New in-point inside the source media, in milliseconds." },
      trimDurationMs: { type: "number", minimum: 0, description: "New length of the used source span; must be positive." }
    }),
    expectedReceipts: editReceipt("timeline.layer.trim")
  },
  "motion.timeline.layer.split": {
    argsSchema: argsSchema([...EDIT, "layerId", "atMs"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      atMs: { type: "number", minimum: 0, description: "Absolute timeline position of the cut, in milliseconds." },
      newLayerId: { type: "string", aliases: ["newLayer"], description: "Id for the layer created after the cut; derived when omitted." }
    }),
    expectedReceipts: editReceipt("timeline.layer.split")
  },
  "motion.timeline.layer.delete": {
    argsSchema: argsSchema([...EDIT, "layerId"], { ...PACKAGE_EDIT, ...LAYER_ID }),
    expectedReceipts: editReceipt("timeline.layer.delete")
  },
  "motion.timeline.layer.duplicate": {
    argsSchema: argsSchema([...EDIT, "layerId"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      newLayerId: { type: "string", aliases: ["newLayer"], description: "Id for the duplicate; derived when omitted." },
      offsetMs: { type: "number", minimum: 0, description: "Milliseconds to shift the duplicate later on the timeline." }
    }),
    expectedReceipts: editReceipt("timeline.layer.duplicate")
  },
  "motion.timeline.layer.reorder": {
    argsSchema: argsSchema([...EDIT, "layerId", "index"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      index: { type: "number", minimum: 0, description: "New position in the layer stack." }
    }),
    expectedReceipts: editReceipt("timeline.layer.reorder")
  },
  "motion.timeline.layer.text.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "text"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      text: { type: "string", aliases: ["value"], description: "New text content. An empty string is accepted." }
    }),
    expectedReceipts: editReceipt("timeline.layer.text.set")
  },
  "motion.timeline.layer.style.set": {
    argsSchema: propertySetter("styleProperty", "styleValue", "Style property name such as color, fontSize, backgroundColor, or letterSpacing."),
    expectedReceipts: editReceipt("timeline.layer.style.set")
  },
  "motion.timeline.layer.transform.set": {
    argsSchema: propertySetter("transformProperty", "transformValue", "Transform property name: x, y, width, height, opacity, scale, rotation, originX, or originY."),
    expectedReceipts: editReceipt("timeline.layer.transform.set")
  },
  "motion.timeline.layer.effect.set": {
    argsSchema: propertySetter("effectProperty", "effectValue", "Effect property name: blur, brightness, contrast, saturate, or grayscale."),
    expectedReceipts: editReceipt("timeline.layer.effect.set")
  },
  "motion.timeline.layer.rich.set": {
    argsSchema: propertySetter("richPath", "richValue", "Dotted path into the layer's rich controls, for example pathReveal.start, pathReveal.end, effects.trail.durationMs, effects.trail.samples, environment.intensity, or emitter.field.sources.0.strength. Trails are static particles/points fields, not keyframe targets."),
    expectedReceipts: editReceipt("timeline.layer.rich.set")
  },
  "motion.timeline.layer.blend.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "blendMode"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      blendMode: { type: "string", enumRef: "blendMode", aliases: ["mode", "value"], description: "New compositing blend mode." }
    }),
    expectedReceipts: editReceipt("timeline.layer.blend.set")
  },
  "motion.timeline.layer.crop.set": {
    argsSchema: argsSchema([...EDIT, "layerId"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      crop: { type: "object", description: "Crop rectangle { x, y, width, height }. All four fields are required when this object is used." },
      x: { type: "number", description: "Crop left edge; used when crop is not supplied. Required with y, width, and height." },
      y: { type: "number", description: "Crop top edge; used when crop is not supplied." },
      width: { type: "number", description: "Crop width; used when crop is not supplied." },
      height: { type: "number", description: "Crop height; used when crop is not supplied." }
    }),
    expectedReceipts: editReceipt("timeline.layer.crop.set")
  },
  "motion.timeline.layer.mask.set": {
    argsSchema: argsSchema([...EDIT, "layerId"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      mask: { type: "object", description: "Mask object { type, inset?: { top, right, bottom, left }, radius? }. type is required." },
      type: { type: "string", aliases: ["maskType"], description: "Mask type; used when mask is not supplied. Required in that form." },
      radius: { type: "number", aliases: ["maskRadius"], description: "Corner radius; used when mask is not supplied." },
      top: { type: "number", description: "Mask inset from the top; used when mask is not supplied." },
      right: { type: "number", description: "Mask inset from the right; used when mask is not supplied." },
      bottom: { type: "number", description: "Mask inset from the bottom; used when mask is not supplied." },
      left: { type: "number", description: "Mask inset from the left; used when mask is not supplied." }
    }),
    expectedReceipts: editReceipt("timeline.layer.mask.set")
  },
  "motion.timeline.layer.fit.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "fit"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      fit: { type: "string", enumRef: "mediaFit", aliases: ["value", "mode"], description: "How the media fills the layer box. Image and video layers only." }
    }),
    expectedReceipts: editReceipt("timeline.layer.fit.set")
  },
  "motion.timeline.layer.media.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "source"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      source: { type: "string", aliases: ["assetRef", "src", "ref"], description: "New media source path or asset reference." }
    }),
    expectedReceipts: editReceipt("timeline.layer.media.set")
  },
  "motion.timeline.layer.name.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "name"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      name: { type: "string", aliases: ["layerName", "value"], description: "New display name; must not be blank." }
    }),
    expectedReceipts: editReceipt("timeline.layer.name.set")
  },
  "motion.timeline.layer.visibility.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "visible"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      visible: { type: "boolean", description: "Whether the layer renders." }
    }),
    expectedReceipts: editReceipt("timeline.layer.visibility.set")
  },
  "motion.timeline.layer.lock": {
    argsSchema: argsSchema([...EDIT, "layerId", "locked"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      locked: { type: "boolean", description: "Whether further edits to this layer are refused." }
    }),
    expectedReceipts: editReceipt("timeline.layer.lock")
  },
  "motion.timeline.layer.ducking.set": {
    argsSchema: argsSchema([...EDIT, "layerId", "triggerLayerIds"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      triggerLayerIds: { type: "array", aliases: ["triggers"], description: "Layer ids whose audio ducks this layer. Must be a non-empty array of strings." },
      mode: { type: "string", enumRef: "duckingMode", description: "Ducking mode; timed when omitted." },
      duckToVolume: { type: "number", minimum: 0, description: "Volume held while ducking." },
      attackMs: { type: "number", minimum: 0, description: "Milliseconds to reach the ducked volume." },
      releaseMs: { type: "number", minimum: 0, description: "Milliseconds to return to full volume." },
      threshold: { type: "number", minimum: 0, description: "Sidechain compressor threshold. Only meaningful with mode sidechain." },
      ratio: { type: "number", minimum: 0, description: "Sidechain compressor ratio. Only meaningful with mode sidechain." }
    }),
    expectedReceipts: editReceipt("timeline.layer.ducking.set")
  },
  "motion.timeline.layer.track.assign": {
    argsSchema: argsSchema([...EDIT, "layerId", "trackId"], {
      ...PACKAGE_EDIT,
      ...LAYER_ID,
      ...TRACK_ID,
      index: { type: "number", minimum: 0, description: "Position inside the destination track's layer list; appended when omitted." }
    }),
    expectedReceipts: editReceipt("timeline.layer.track.assign")
  }
} satisfies MotionDebugCommandMetadata;
