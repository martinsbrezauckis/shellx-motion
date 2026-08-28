/** Closed commands for complete root adjustment-layer authoring. */
import type { MotionDebugArgPropertySchema } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

/**
 * The fixed-adjustment authoring route accepts host-configured receipt
 * persistence only.  Its data contract must not inherit the generic caller
 * receiptsRoot selector from PACKAGE_EDIT.
 */
const FIXED_ADJUSTMENT_PACKAGE_EDIT = {
  packageRoot: {
    ...PACKAGE_EDIT.packageRoot,
    description: "Source Motion package root; never modified in place. Any host receipt mirror is configured by the trusted Debug host; callers must not supply receiptsRoot.",
  },
  outDir: PACKAGE_EDIT.outDir,
  createdBy: PACKAGE_EDIT.createdBy,
};

const UNIT = { type: "number" as const, minimum: 0, maximum: 1, description: "Finite normalized unit value; Core is the final validator." };
const VIGNETTE: MotionDebugArgPropertySchema = {
  type: "object", required: ["amount", "softness", "color"], additionalProperties: false,
  properties: { amount: UNIT, softness: UNIT, color: { type: "string", description: "Supported static Motion color string." } },
};
const FILM_GRAIN: MotionDebugArgPropertySchema = {
  type: "object", required: ["amount", "size", "seed"], additionalProperties: false,
  properties: {
    amount: UNIT,
    size: { type: "number", minimum: 1, maximum: 8, description: "Safe integer film-grain cell size." },
    seed: { type: "number", minimum: 0, maximum: 0xffff_ffff, description: "Unsigned 32-bit deterministic film-grain seed." },
  },
};
const EFFECTS: MotionDebugArgPropertySchema = {
  type: "object", additionalProperties: false,
  properties: { vignette: VIGNETTE, filmGrain: FILM_GRAIN },
  oneOf: [
    { type: "object", required: ["vignette"], additionalProperties: false, properties: { vignette: VIGNETTE } },
    { type: "object", required: ["filmGrain"], additionalProperties: false, properties: { filmGrain: FILM_GRAIN } },
    { type: "object", required: ["vignette", "filmGrain"], additionalProperties: false, properties: { vignette: VIGNETTE, filmGrain: FILM_GRAIN } },
  ],
  description: "One or both fixed full-frame effects, evaluated in canonical vignette-then-filmGrain order.",
};
const ADJUSTMENT: MotionDebugArgPropertySchema = {
  type: "object", required: ["id", "startMs", "durationMs", "effects"], additionalProperties: false,
  properties: {
    id: { type: "string", description: "Stable root adjustment id." },
    name: { type: "string", description: "Optional display name." },
    startMs: { type: "number", minimum: 0, description: "Finite root timeline start in milliseconds." },
    durationMs: { type: "number", exclusiveMinimum: 0, description: "Finite positive root timeline duration in milliseconds." },
    visible: { type: "boolean", description: "Optional adjustment visibility." },
    effects: EFFECTS,
  },
  description: "Complete closed adjustment record. Set replaces an existing exact id or appends a new root stack entry; it accepts no index, track, transform, module, or extension fields.",
};

export const TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA = {
  "motion.timeline.adjustment.fixed.inspect": { argsSchema: argsSchema(["packageRoot", "layerId"], { ...PACKAGE_ROOT, ...LAYER_ID }) },
  "motion.timeline.adjustment.fixed.set": mutation("timeline.adjustment.fixed.set", ["adjustment"], { adjustment: ADJUSTMENT }),
  "motion.timeline.adjustment.fixed.remove": mutation("timeline.adjustment.fixed.remove", ["layerId"], { ...LAYER_ID }),
} satisfies Record<string, FixedAdjustmentCommandMetadata>;

interface FixedAdjustmentCommandMetadata {
  argsSchema: ReturnType<typeof argsSchema>;
  expectedReceipts?: ReturnType<typeof editReceipt>;
}
function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(["packageRoot", "outDir", ...required], { ...FIXED_ADJUSTMENT_PACKAGE_EDIT, ...properties }), expectedReceipts: editReceipt(operation) };
}
