/**
 * Reusable argument-property fragments for the debug command contracts.
 *
 * Role: the copy-on-write package edit boundary (`packageRoot` + `outDir` + optional
 * `receiptsRoot`/`createdBy`) and the layer/track selectors repeat across ~70 commands.
 * Defining them once keeps the published contract internally consistent — a description
 * fix lands everywhere at once instead of in one command's schema.
 *
 * Dependencies: `command-registry.ts` types only. No runtime behavior.
 * Primary callers: every `command-metadata-timeline-*.ts` and `command-metadata-surfaces.ts`.
 *
 * The alias lists are not decoration: the handlers really do accept them
 * (`stringArg(args, "layerId") ?? stringArg(args, "layer")`), and `additionalProperties: false`
 * in the published schema would be a lie if they were omitted.
 */
import type { MotionDebugArgPropertySchema, MotionDebugExpectedReceipt } from "./command-registry.js";

type Properties = Record<string, MotionDebugArgPropertySchema>;

/** Source package root. Every package-reading command takes this. */
export const PACKAGE_ROOT: Properties = {
  packageRoot: { type: "string", description: "Motion package root directory to read." }
};

/**
 * The copy-on-write edit boundary. `outDir` must be empty or absent and must sit outside
 * `packageRoot`; the command copies the package there and writes the mutation into the copy,
 * so the source package is never modified in place.
 */
export const PACKAGE_EDIT: Properties = {
  packageRoot: { type: "string", description: "Source Motion package root; never modified in place." },
  outDir: {
    type: "string",
    aliases: ["packageDir"],
    description: "Empty or absent output directory, outside packageRoot, that receives the edited package copy."
  },
  receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror; the receipt is also written into outDir/receipts." },
  createdBy: { type: "string", description: "Optional attribution recorded in the emitted receipt." }
};

/** Layer selector shared by every layer-scoped command. */
export const LAYER_ID: Properties = {
  layerId: { type: "string", aliases: ["layer"], description: "Target layer id." }
};

/** Track selector shared by every track-scoped command. */
export const TRACK_ID: Properties = {
  trackId: { type: "string", aliases: ["track"], description: "Target track id." }
};

/** Keyframe channel selector shared by every keyframe command. */
export const KEYFRAME_TARGET: Properties = {
  target: { type: "string", enumRef: "keyframeTarget", description: "Animated property path the keyframes belong to." }
};

/** Receipt store selector shared by receipt-reading and job-lifecycle commands. */
export const RECEIPTS_ROOT: Properties = {
  receiptsRoot: { type: "string", description: "Trusted host receipt root to read." }
};

/**
 * Compose an args schema from property fragments.
 *
 * @param required - argument names that must be present; every name must exist in `properties`.
 * @param properties - merged property fragments, in the order they should be published.
 * @returns a closed object schema (`additionalProperties: false`).
 */
export function argsSchema(required: string[], properties: Properties) {
  return {
    type: "object" as const,
    ...(required.length > 0 ? { required } : {}),
    properties,
    additionalProperties: false
  };
}

/**
 * Receipt expectation for a package mutation that emits an edited package plus a receipt.
 *
 * @param operation - receipt `operation` value, i.e. the command id without the `motion.` prefix.
 */
export function editReceipt(operation: string): MotionDebugExpectedReceipt[] {
  return [{ operation, mode: "emits", required: true, artifactRoles: ["motion_package", "timeline_receipt"] }];
}

/** Receipt expectation for a read-only command that emits an evidence receipt but changes nothing. */
export function readReceipt(operation: string): MotionDebugExpectedReceipt[] {
  return [{ operation, mode: "reads", required: false }];
}
