/** Compose bounded feature CLI adapters without growing the legacy parser. */
import { dirname, resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";
import {
  COMPOSITING_GRAPH_DEBUG_COMMANDS,
  compositingGraphDebugArgs,
} from "./compositing-graph-cli.js";
import { SPATIAL_PATH_DEBUG_COMMANDS, spatialPathDebugArgs } from "./spatial-path-cli.js";
import { gltfAuthoringRoots, gltfDebugArgs, GLTF_DEBUG_COMMANDS } from "./gltf-cli.js";
import { lottieAuthoringRoots, lottieDebugArgs, LOTTIE_DEBUG_COMMANDS } from "./lottie-cli.js";
import { PROCEDURAL_DEBUG_COMMANDS, proceduralAuthoringRoots, proceduralDebugArgs } from "./procedural-cli.js";
import { cutoutRigAuthoringRoots, cutoutRigDebugArgs, CUTOUT_RIG_DEBUG_COMMANDS, hydrateCutoutRigDebugArgs } from "./cutout-rig-cli.js";
import { shapeGeometryKeyframeDebugArgs } from "./shape-geometry-keyframes-cli.js";
import { timelineBehaviorDebugArgs } from "./timeline-behaviors-cli.js";

export const MODULAR_DEBUG_COMMANDS = {
  ...SPATIAL_PATH_DEBUG_COMMANDS,
  ...COMPOSITING_GRAPH_DEBUG_COMMANDS,
  ...PROCEDURAL_DEBUG_COMMANDS,
  ...CUTOUT_RIG_DEBUG_COMMANDS,
  ...GLTF_DEBUG_COMMANDS,
  ...LOTTIE_DEBUG_COMMANDS,
} as const;

export async function modularDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
): Promise<Record<string, unknown> | null> {
  return timelineBehaviorDebugArgs(command, argv, packageRoot, option)
    ?? shapeGeometryKeyframeDebugArgs(command, argv, packageRoot, option)
    ?? gltfDebugArgs(command, argv)
    ?? lottieDebugArgs(command, argv)
    ?? await cutoutRigDebugArgs(command, argv, packageRoot)
    ?? spatialPathDebugArgs(command, argv, packageRoot)
    ?? await compositingGraphDebugArgs(command, argv, packageRoot)
    ?? await proceduralDebugArgs(command, argv, packageRoot);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function modularDebugAuthoringRoots(command: MotionDebugCommand, args: unknown) {
  const modular = cutoutRigAuthoringRoots(command, args)
    ?? gltfAuthoringRoots(command, args)
    ?? lottieAuthoringRoots(command, args)
    ?? proceduralAuthoringRoots(command, args);
  if (modular || command !== "motion.canvas.package" || !isRecord(args)) return modular;
  const selectionPath = typeof args.canvasSelectionPath === "string" ? resolve(args.canvasSelectionPath) : undefined;
  const sourceRoot = typeof args.sourceRoot === "string" ? resolve(args.sourceRoot) : selectionPath ? dirname(selectionPath) : undefined;
  const packageDir = typeof args.packageDir === "string" ? resolve(args.packageDir) : undefined;
  if (!packageDir) return null;
  return {
    inputRoots: sourceRoot ? [sourceRoot] : [],
    outputRoots: [dirname(packageDir)],
  };
}

export async function hydrateModularDebugArgs(
  command: MotionDebugCommand,
  args: unknown,
  authoringInputRoots: string[] | undefined,
): Promise<unknown> {
  return await hydrateCutoutRigDebugArgs(command, args, authoringInputRoots) ?? args;
}

export function invalidModularDebugArgs(subcommand: string | undefined, error: unknown) {
  return {
    ok: false as const,
    command: `debug.${subcommand}`,
    error: { code: "invalid_args", message: error instanceof Error ? error.message : String(error) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
