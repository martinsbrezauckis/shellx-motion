/** Compose bounded feature CLI adapters without growing the legacy parser. */
import type { MotionDebugCommand } from "@shellx-motion/debug-api";
import {
  COMPOSITING_GRAPH_DEBUG_COMMANDS,
  compositingGraphDebugArgs,
} from "./compositing-graph-cli.js";
import { SPATIAL_PATH_DEBUG_COMMANDS, spatialPathDebugArgs } from "./spatial-path-cli.js";
import { gltfAuthoringRoots, gltfDebugArgs, GLTF_DEBUG_COMMANDS } from "./gltf-cli.js";
import { lottieAuthoringRoots, lottieDebugArgs, LOTTIE_DEBUG_COMMANDS } from "./lottie-cli.js";
import { PROCEDURAL_DEBUG_COMMANDS, proceduralDebugArgs } from "./procedural-cli.js";

export const MODULAR_DEBUG_COMMANDS = {
  ...SPATIAL_PATH_DEBUG_COMMANDS,
  ...COMPOSITING_GRAPH_DEBUG_COMMANDS,
  ...PROCEDURAL_DEBUG_COMMANDS,
  ...GLTF_DEBUG_COMMANDS,
  ...LOTTIE_DEBUG_COMMANDS,
} as const;

export async function modularDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
): Promise<Record<string, unknown> | null> {
  return gltfDebugArgs(command, argv)
    ?? lottieDebugArgs(command, argv)
    ?? spatialPathDebugArgs(command, argv, packageRoot)
    ?? await compositingGraphDebugArgs(command, argv, packageRoot)
    ?? await proceduralDebugArgs(command, argv, packageRoot);
}

export function modularDebugAuthoringRoots(command: MotionDebugCommand, args: unknown) {
  return gltfAuthoringRoots(command, args) ?? lottieAuthoringRoots(command, args);
}
