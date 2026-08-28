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
import { purposeForCall } from "@shellx-motion/actions";
import { COMPOSITING_COMMAND_METADATA } from "./command-metadata-compositing.js";
import { CUTOUT_RIG_COMMAND_METADATA } from "./command-metadata-cutout-rig.js";
import { CORE_COMMAND_METADATA } from "./command-metadata-core.js";
import { AUDIO_COMMAND_METADATA } from "./command-metadata-audio.js";
import { JOB_COMMAND_METADATA } from "./command-metadata-jobs.js";
import { RENDER_COMMAND_METADATA } from "./command-metadata-render.js";
import { REVISION_COMMAND_METADATA } from "./command-metadata-revision.js";
import { KEYING_COMMAND_METADATA } from "./command-metadata-keying.js";
import { SCENE3D_COMMAND_METADATA } from "./command-metadata-scene3d.js";
import { LOTTIE_COMMAND_METADATA } from "./command-metadata-lottie.js";
import { SURFACE_COMMAND_METADATA } from "./command-metadata-surfaces.js";
import { TIMELINE_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-keyframes.js";
import { TIMELINE_LAYER_COMMAND_METADATA } from "./command-metadata-timeline-layers.js";
import { TIMELINE_GROUP_COMMAND_METADATA } from "./command-metadata-timeline-groups.js";
import { TIMELINE_LAYOUT_COMMAND_METADATA } from "./command-metadata-timeline-layout.js";
import { TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA } from "./command-metadata-timeline-adjustments.js";
import { TIMELINE_BEHAVIOR_COMMAND_METADATA } from "./command-metadata-timeline-behaviors.js";
import { TIMELINE_RELATION_COMMAND_METADATA } from "./command-metadata-timeline-relations.js";
import { TIMELINE_RELATION_ACTION_COMMAND_METADATA } from "./command-metadata-timeline-relation-actions.js";
import { TIMELINE_SCENE3D_ANIMATION_COMMAND_METADATA } from "./command-metadata-timeline-scene3d-animation.js";
import { TIMELINE_LAYOUT_GAP_ANIMATION_COMMAND_METADATA } from "./command-metadata-timeline-layout-gap-animation.js";
import { TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-gradient-color-keyframes.js";
import { TIMELINE_POINT_COMMAND_METADATA } from "./command-metadata-timeline-points.js";
import { TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA } from "./command-metadata-timeline-particle-structural.js";
import { TIMELINE_SHAPE_GEOMETRY_COMMAND_METADATA } from "./command-metadata-timeline-shape-geometry.js";
import { TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-shape-geometry-keyframes.js";
import { TIMELINE_TEXT_RUNS_COMMAND_METADATA } from "./command-metadata-timeline-text-runs.js";
import { TIMELINE_STRUCTURE_COMMAND_METADATA } from "./command-metadata-timeline-structure.js";
import { TIMELINE_TRACK_COMMAND_METADATA } from "./command-metadata-timeline-tracks.js";
import { TRACKING_COMMAND_METADATA } from "./command-metadata-tracking.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA } from "./command-metadata-checkpoint-storyboard.js";

/**
 * Assembled metadata for every command that has an argument contract.
 *
 * Order is irrelevant because the modules are disjoint by command id; `command-metadata.test.ts`
 * asserts that disjointness so a command can never be silently defined twice with different
 * argument shapes.
 */
export const DEBUG_COMMAND_METADATA: MotionDebugCommandMetadata = {
  ...CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA,
  ...SCENE3D_COMMAND_METADATA,
  ...LOTTIE_COMMAND_METADATA,
  ...COMPOSITING_COMMAND_METADATA,
  ...CUTOUT_RIG_COMMAND_METADATA,
  ...TRACKING_COMMAND_METADATA,
  ...KEYING_COMMAND_METADATA,
  ...CORE_COMMAND_METADATA,
  ...AUDIO_COMMAND_METADATA,
  ...JOB_COMMAND_METADATA,
  ...RENDER_COMMAND_METADATA,
  ...SURFACE_COMMAND_METADATA,
  ...REVISION_COMMAND_METADATA,
  ...TIMELINE_LAYER_COMMAND_METADATA,
  ...TIMELINE_GROUP_COMMAND_METADATA,
  ...TIMELINE_LAYOUT_COMMAND_METADATA,
  ...TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA,
  ...TIMELINE_BEHAVIOR_COMMAND_METADATA,
  ...TIMELINE_RELATION_COMMAND_METADATA,
  ...TIMELINE_RELATION_ACTION_COMMAND_METADATA,
  ...TIMELINE_SCENE3D_ANIMATION_COMMAND_METADATA,
  ...TIMELINE_LAYOUT_GAP_ANIMATION_COMMAND_METADATA,
  ...TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMAND_METADATA,
  ...TIMELINE_POINT_COMMAND_METADATA,
  ...TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA,
  ...TIMELINE_SHAPE_GEOMETRY_COMMAND_METADATA,
  ...TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA,
  ...TIMELINE_TEXT_RUNS_COMMAND_METADATA,
  ...TIMELINE_KEYFRAME_COMMAND_METADATA,
  ...TIMELINE_STRUCTURE_COMMAND_METADATA,
  ...TIMELINE_TRACK_COMMAND_METADATA
};

const BASE_DEBUG_COMMAND_CONTRACTS = buildDebugCommandContracts(DEBUG_COMMAND_METADATA);

/** Every registered command has passed the R3 purpose review and is published to Debug/MCP. */
export const AGENT_REFERENCE_PURPOSE_COMMANDS: readonly MotionDebugCommand[] = BASE_DEBUG_COMMAND_CONTRACTS
  .map((contract) => contract.command);

const COPY_ON_WRITE_EDIT_PURPOSE_SUFFIX = " Reads the source and writes the separate revision only within host-approved authoring roots; outDir must be outside the source and empty or absent, and the source package remains unchanged.";

function hasCopyOnWriteEditBoundary(contract: MotionDebugCommandContract): boolean {
  const properties = contract.argsSchema?.properties;
  return contract.permission === "edit_motion"
    && contract.mutates
    && properties?.packageRoot !== undefined
    && properties?.outDir !== undefined;
}

/** Derive one complete Debug/MCP purpose from the Actions authority plus typed edit boundaries. */
export function purposeForDebugContract(contract: MotionDebugCommandContract): string {
  const purpose = purposeForCall(contract.command);
  if (purpose === `Run ${contract.command}.`) {
    throw new Error(`Missing reviewed agent purpose for ${contract.command}.`);
  }
  return hasCopyOnWriteEditBoundary(contract)
    ? `${purpose}${COPY_ON_WRITE_EDIT_PURPOSE_SUFFIX}`
    : purpose;
}

/** The published contract for every registered command, including its reviewed agent purpose. */
export const DEBUG_COMMAND_CONTRACTS: MotionDebugCommandContract[] = BASE_DEBUG_COMMAND_CONTRACTS
  .map((contract) => ({ ...contract, purpose: purposeForDebugContract(contract) }));

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
