/** Closed transport contracts for deterministic group layouts and repeaters. */
import {
  MAX_MOTION_LAYOUT_DIMENSION,
  MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH,
  MAX_MOTION_LAYOUT_REPEATER_INSTANCES,
  MAX_MOTION_LAYOUT_REPEATERS,
  MAX_MOTION_LAYOUT_ROTATION,
  MAX_MOTION_LAYOUT_SCALE,
  MAX_MOTION_LAYOUT_TIME_MS,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir"];
/**
 * Layout apply/remove use the host-configured immutable authority store, so
 * unlike ordinary package edits they deliberately do not accept receiptsRoot
 * from command data.
 */
const LAYOUT_PACKAGE_EDIT = {
  packageRoot: {
    ...PACKAGE_EDIT.packageRoot,
    description: "Source Motion package root; never modified in place. Layout apply/remove require an immutable receipt-authority root configured by the trusted Debug host; callers must not supply receiptsRoot."
  },
  outDir: PACKAGE_EDIT.outDir,
  createdBy: PACKAGE_EDIT.createdBy,
};
const IDENTIFIER = { type: "string" as const, maxLength: MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH, description: "Bounded Motion layer identifier." };
const DIMENSION = { type: "number" as const, minimum: 0, maximum: MAX_MOTION_LAYOUT_DIMENSION };
const SIGNED_DIMENSION = { type: "number" as const, minimum: -MAX_MOTION_LAYOUT_DIMENSION, maximum: MAX_MOTION_LAYOUT_DIMENSION };
const PADDING: MotionDebugArgPropertySchema = {
  type: "object", required: ["top", "right", "bottom", "left"], additionalProperties: false,
  properties: { top: DIMENSION, right: DIMENSION, bottom: DIMENSION, left: DIMENSION },
  description: "Exact non-negative layout padding; Core requires a positive remaining content box."
};
const ALIGN: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y"], additionalProperties: false,
  properties: { x: { type: "string", enum: ["start", "center", "end", "stretch"] }, y: { type: "string", enum: ["start", "center", "end", "stretch"] } },
  description: "Closed x/y alignment pair; kind-specific restrictions remain Core-validated."
};
const LAYOUT: MotionDebugArgPropertySchema = {
  type: "object", oneOf: [layoutVariant("row"), layoutVariant("column"), layoutVariant("stack"), layoutVariant("grid", {
    columns: { type: "number", minimum: 1, maximum: 64, description: "Exact positive grid column count." }
  }), layoutVariant("radial", {
    radius: DIMENSION,
    startAngleDeg: { type: "number", minimum: -MAX_MOTION_LAYOUT_ROTATION, maximum: MAX_MOTION_LAYOUT_ROTATION },
    sweepAngleDeg: { type: "number", minimum: -MAX_MOTION_LAYOUT_ROTATION, maximum: MAX_MOTION_LAYOUT_ROTATION }
  })],
  description: "One exact shellx-motion/layout@1 variant; no expression, custom solver, or code is accepted."
};
const REPEATER_DELTA: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y", "scale", "rotation"], additionalProperties: false,
  properties: {
    x: SIGNED_DIMENSION, y: SIGNED_DIMENSION,
    scale: { type: "number", minimum: -MAX_MOTION_LAYOUT_SCALE, maximum: MAX_MOTION_LAYOUT_SCALE },
    rotation: { type: "number", minimum: -MAX_MOTION_LAYOUT_ROTATION, maximum: MAX_MOTION_LAYOUT_ROTATION }
  }, description: "Exact per-index transform delta; Core checks every derived instance."
};
const REPEATER: MotionDebugArgPropertySchema = {
  type: "object", required: ["schema", "sourceId", "count", "transformDelta", "opacityDelta", "indexTimeStaggerMs"], additionalProperties: false,
  properties: {
    schema: { type: "string", enum: ["shellx-motion/repeater@1"] }, sourceId: IDENTIFIER,
    count: { type: "number", minimum: 1, maximum: MAX_MOTION_LAYOUT_REPEATER_INSTANCES }, transformDelta: REPEATER_DELTA,
    opacityDelta: { type: "number", minimum: -1, maximum: 1 }, indexTimeStaggerMs: { type: "number", minimum: 0, maximum: MAX_MOTION_LAYOUT_TIME_MS }
  }, description: "One bounded deterministic repeater; no runtime expression or generated layer is accepted."
};
const REPEATERS: MotionDebugArgPropertySchema = {
  type: "array", items: REPEATER, maxItems: MAX_MOTION_LAYOUT_REPEATERS,
  description: "Sorted unique source repeaters; Core checks source ownership, derived bounds, and compile budget."
};
const REMOVAL: MotionDebugArgPropertySchema = {
  type: "object", required: ["schema", "applicationId", "applicationFingerprint"], additionalProperties: false,
  properties: {
    schema: { type: "string", enum: ["shellx-motion/debug-layout-removal@1"] },
    applicationId: { ...IDENTIFIER, description: "Document-resident layout application id emitted by layout apply." },
    applicationFingerprint: { type: "string", maxLength: 64, description: "Exact SHA-256 fingerprint binding that application record; no caller-held inverse patches are accepted." },
  }, description: "Exact stable marker for a document-resident layout application. The trusted Debug host verifies immutable apply authority before Core permits removal."
};

export const TIMELINE_LAYOUT_COMMAND_METADATA = {
  "motion.timeline.layout.inspect": readOnly("Inspect deterministic layout ownership, slots, budgets, overflow facts, and fingerprint without a receipt."),
  "motion.timeline.layout.compile": readOnly("Compile deterministic layout slots, repeaters, budgets, overflow facts, and fingerprint without a receipt."),
  "motion.timeline.layout.apply": {
    argsSchema: argsSchema([...EDIT, "groupId", "layout", "repeaters"], { ...LAYOUT_PACKAGE_EDIT, groupId: IDENTIFIER, layout: LAYOUT, repeaters: REPEATERS }),
    expectedReceipts: editReceipt("timeline.layout.apply")
  },
  "motion.timeline.layout.remove": {
    argsSchema: argsSchema([...EDIT, "removal"], { ...LAYOUT_PACKAGE_EDIT, removal: REMOVAL }),
    expectedReceipts: editReceipt("timeline.layout.remove")
  }
} satisfies MotionDebugCommandMetadata;

function readOnly(description: string) {
  return { argsSchema: argsSchema(["packageRoot", "groupId", "layout", "repeaters"], { ...PACKAGE_ROOT, groupId: IDENTIFIER, layout: { ...LAYOUT, description }, repeaters: REPEATERS }) };
}
function layoutVariant(kind: "row" | "column" | "stack" | "grid" | "radial", additions: Record<string, MotionDebugArgPropertySchema> = {}): MotionDebugArgPropertySchema {
  return {
    type: "object", required: ["schema", "kind", "width", "height", "padding", "gap", "align", "distribution", "overflow", ...Object.keys(additions)], additionalProperties: false,
    properties: {
      schema: { type: "string", enum: ["shellx-motion/layout@1"] }, kind: { type: "string", enum: [kind] },
      width: { type: "number", minimum: 1, maximum: MAX_MOTION_LAYOUT_DIMENSION }, height: { type: "number", minimum: 1, maximum: MAX_MOTION_LAYOUT_DIMENSION },
      padding: PADDING, gap: DIMENSION, align: ALIGN, distribution: { type: "string", enum: ["start", "center", "end", "space-between", "space-around", "space-evenly"] }, overflow: { type: "string", enum: ["clip", "allow"] }, ...additions
    }
  };
}
