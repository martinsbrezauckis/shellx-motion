/** Closed Debug/MCP contract for one B7 arbitrary-time review association. */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";

const IDENTITY: MotionDebugArgPropertySchema = { type: "object", required: ["id", "sha256", "revision"], additionalProperties: false, properties: { id: { type: "string", pattern: "^checkpoint_storyboard_[a-f0-9]{32}$" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, revision: { type: "number", minimum: 1, maximum: 1_000_000, multipleOf: 1 } } };
const PREVIEW: MotionDebugArgPropertySchema = { type: "object", required: ["previewHandle", "receiptHandle"], additionalProperties: false, properties: {
  previewHandle: { type: "string", pattern: "^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$", description: "Opaque handle for one complete B7 exact-time PNG." },
  receiptHandle: { type: "string", pattern: "^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$", description: "Opaque handle for the matching private B7 preview receipt." },
} };

export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_REVIEW_COMMAND_METADATA = {
  "motion.timeline.checkpoint-storyboard.retained-trace.review.bind": {
    argsSchema: { type: "object", required: ["identity", "preview", "reviewHandle"], additionalProperties: false, properties: {
      identity: { ...IDENTITY, description: "Exact active nonarchived C6B7 record identity." },
      preview: { ...PREVIEW, description: "Exact paired opaque handles for one complete arbitrary-time B7 preview." },
      reviewHandle: { type: "string", pattern: "^checkpoint_storyboard_retained_trace_review_handle_[a-f0-9]{32}$", description: "Host-minted opaque decision handle. The command accepts no reviewer, decision, storyboard, recipe, package, frame, receipt, path, renderer, or authority data." },
    } },
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.retained-trace.review.bind", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_retained_trace_review_association", "checkpoint_storyboard_exact_storyboard_recipe_package_frame_receipt_binding"] }],
  },
} satisfies MotionDebugCommandMetadata;
