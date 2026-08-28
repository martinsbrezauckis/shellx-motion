/** Closed command contracts for manifest-bound styled text runs. */
import { MAX_MOTION_TEXT_RUNS, MAX_MOTION_TEXT_RUN_FONT_ASSETS, MAX_MOTION_TEXT_RUNS_UTF8_BYTES } from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const LAYER_ID = { type: "string" as const, description: "Target text or caption layer identifier." };
const RUN: MotionDebugArgPropertySchema = {
  type: "object", required: ["text", "fontAssetId"], additionalProperties: false,
  properties: {
    text: { type: "string", description: "Non-empty text fragment; complete concatenated UTF-8 text is capped by Core." },
    fontAssetId: { type: "string", description: "Required immutable Motion font asset id; family, weight, and style derive only from that asset." },
    color: { type: "string", description: "Optional static Motion color override; otherwise inherits the layer style." },
    fontSizePx: { type: "number", exclusiveMinimum: 0, maximum: 4096, description: "Optional pixel font size override; otherwise inherits the layer style." },
    letterSpacingPx: { type: "number", minimum: -2048, maximum: 2048, description: "Optional pixel letter-spacing override; otherwise inherits the layer style." },
  },
};
const TEXT_RUNS: MotionDebugArgPropertySchema = {
  type: "object", required: ["schema", "runs"], additionalProperties: false,
  properties: {
    schema: { type: "string", enum: ["shellx-motion/text-runs@1"] },
    runs: { type: "array", minItems: 1, maxItems: MAX_MOTION_TEXT_RUNS, items: RUN, description: `Ordered non-empty runs; at most ${MAX_MOTION_TEXT_RUN_FONT_ASSETS} distinct font assets and ${MAX_MOTION_TEXT_RUNS_UTF8_BYTES} concatenated UTF-8 bytes.` },
  },
  description: "Closed text-runs@1 record. The run fontAssetId is the sole family, weight, and style authority.",
};

export const TIMELINE_TEXT_RUNS_COMMAND_METADATA = {
  "motion.timeline.layer.text-runs.inspect": {
    argsSchema: argsSchema(["packageRoot", "layerId"], { ...PACKAGE_ROOT, layerId: LAYER_ID }),
  },
  "motion.timeline.layer.text-runs.replace": {
    argsSchema: argsSchema(["packageRoot", "outDir", "layerId", "textRuns"], { ...PACKAGE_EDIT, layerId: LAYER_ID, textRuns: TEXT_RUNS }),
    expectedReceipts: editReceipt("timeline.layer.text-runs.replace"),
  },
  "motion.timeline.layer.text-runs.remove": {
    argsSchema: argsSchema(["packageRoot", "outDir", "layerId", "expectedPlainText"], { ...PACKAGE_EDIT, layerId: LAYER_ID, expectedPlainText: { type: "string", description: "Must exactly equal the concatenated run text. Removal derives that same plain text and cannot change content." } }),
    expectedReceipts: editReceipt("timeline.layer.text-runs.remove"),
  },
} satisfies MotionDebugCommandMetadata;
