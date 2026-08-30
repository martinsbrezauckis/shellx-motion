import { MAX_MOTION_COLOR_STRING_LENGTH } from "./color";

/** Closed source-schema vocabulary for manifest-bound text-runs@1. */
const COLOR = { type: "string", minLength: 1, maxLength: MAX_MOTION_COLOR_STRING_LENGTH };

export const TEXT_RUNS_LAYER_PROPERTY = { $ref: "#/$defs/textRuns" };

export function textRunsLayerTypeConstraint(): Record<string, unknown> {
  return { if: { required: ["textRuns"] }, then: { properties: { type: { enum: ["text", "caption"] } } } };
}

export function buildTextRunsDefinitions(): Record<string, unknown> {
  return {
    textRuns: {
      type: "object", required: ["schema", "runs"], additionalProperties: false,
      properties: { schema: { const: "shellx-motion/text-runs@1" }, runs: { type: "array", minItems: 1, maxItems: 32, items: { $ref: "#/$defs/textRun" } } },
      $comment: "Closed text-runs@1. Runtime additionally caps aggregate UTF-8 text at 16384 bytes, admits at most 16 distinct manifest-declared immutable font assets, and enforces legacy text/face ownership exclusivity."
    },
    textRun: {
      type: "object", required: ["text", "fontAssetId"], additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1 }, fontAssetId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }, color: COLOR,
        fontSizePx: { type: "number", exclusiveMinimum: 0, maximum: 4096 }, letterSpacingPx: { type: "number", minimum: -2048, maximum: 2048 }
      }
    }
  };
}
