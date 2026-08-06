/**
 * The single assembled argument/receipt contract for every Motion debug command.
 *
 * Role: merge the per-area metadata modules into one `MotionDebugCommandMetadata` map and
 * derive `DEBUG_COMMAND_CONTRACTS` from it. This module is the one place a consumer needs
 * in order to answer "what arguments does command X take?".
 *
 * Dependencies: `command-registry.ts` (the command list and the merge function) plus every
 * `command-metadata-*.ts` module.
 *
 * Primary callers:
 *  - `index.ts` re-exports `DEBUG_COMMAND_CONTRACTS` as the package's public contract.
 *  - `domains/agent.ts` enriches `motion.actions.guide` / `motion.actions.plan` steps with
 *    `debugCommandArgumentContract()`. It imports here rather than from `index.ts` because
 *    `index.ts` imports the domain routers — the reverse edge would be an import cycle.
 *  - `scripts/generate-public-contracts.ts` publishes the result into `schemas/debug.json`.
 */
import {
  buildDebugCommandContracts,
  type MotionDebugArgsSchema,
  type MotionDebugCommand,
  type MotionDebugCommandContract,
  type MotionDebugCommandMetadata
} from "./command-registry.js";
import { COMPOSITING_COMMAND_METADATA } from "./command-metadata-compositing.js";
import { CORE_COMMAND_METADATA } from "./command-metadata-core.js";
import { JOB_COMMAND_METADATA } from "./command-metadata-jobs.js";
import { RENDER_COMMAND_METADATA } from "./command-metadata-render.js";
import { KEYING_COMMAND_METADATA } from "./command-metadata-keying.js";
import { SCENE3D_COMMAND_METADATA } from "./command-metadata-scene3d.js";
import { LOTTIE_COMMAND_METADATA } from "./command-metadata-lottie.js";
import { SURFACE_COMMAND_METADATA } from "./command-metadata-surfaces.js";
import { TIMELINE_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-keyframes.js";
import { TIMELINE_LAYER_COMMAND_METADATA } from "./command-metadata-timeline-layers.js";
import { TIMELINE_STRUCTURE_COMMAND_METADATA } from "./command-metadata-timeline-structure.js";
import { TIMELINE_TRACK_COMMAND_METADATA } from "./command-metadata-timeline-tracks.js";
import { TRACKING_COMMAND_METADATA } from "./command-metadata-tracking.js";

/**
 * Assembled metadata for every command that has an argument contract.
 *
 * Order is irrelevant because the modules are disjoint by command id; `command-metadata.test.ts`
 * asserts that disjointness so a command can never be silently defined twice with different
 * argument shapes.
 */
export const DEBUG_COMMAND_METADATA: MotionDebugCommandMetadata = {
  ...SCENE3D_COMMAND_METADATA,
  ...LOTTIE_COMMAND_METADATA,
  ...COMPOSITING_COMMAND_METADATA,
  ...TRACKING_COMMAND_METADATA,
  ...KEYING_COMMAND_METADATA,
  ...CORE_COMMAND_METADATA,
  ...JOB_COMMAND_METADATA,
  ...RENDER_COMMAND_METADATA,
  ...SURFACE_COMMAND_METADATA,
  ...TIMELINE_LAYER_COMMAND_METADATA,
  ...TIMELINE_KEYFRAME_COMMAND_METADATA,
  ...TIMELINE_STRUCTURE_COMMAND_METADATA,
  ...TIMELINE_TRACK_COMMAND_METADATA
};

/** The published contract for every registered command: domain, permission, mutation class, arguments, receipts. */
export const DEBUG_COMMAND_CONTRACTS: MotionDebugCommandContract[] = buildDebugCommandContracts(DEBUG_COMMAND_METADATA);

const CONTRACT_BY_COMMAND = new Map<string, MotionDebugCommandContract>(
  DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract])
);

/**
 * Look up one command's full contract.
 *
 * @param command - a debug command id; unknown ids return null rather than throwing so
 *   callers enriching a plan can pass through step names they do not recognise.
 */
export function debugCommandContract(command: string): MotionDebugCommandContract | null {
  return CONTRACT_BY_COMMAND.get(command) ?? null;
}

/**
 * Look up just the argument schema for a command.
 *
 * @returns the schema, or null when the command takes no published arguments (either it takes
 *   none at all, or its contract has not been specified yet — `debugCommandContract` tells the
 *   two apart, and `command-metadata.test.ts` gates the second case from growing).
 */
export function debugCommandArgumentContract(command: string): MotionDebugArgsSchema | null {
  return CONTRACT_BY_COMMAND.get(command)?.argsSchema ?? null;
}

/** Commands that still have no published argument schema. Empty is the goal; the test pins the count. */
export function debugCommandsWithoutArgumentContracts(): MotionDebugCommand[] {
  return DEBUG_COMMAND_CONTRACTS.filter((contract) => !contract.argsSchema).map((contract) => contract.command);
}
