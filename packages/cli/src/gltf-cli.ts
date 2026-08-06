import { dirname, resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

export const GLTF_DEBUG_COMMANDS = {
  "gltf-import": "motion.scene3d.gltf.import",
} as const satisfies Record<string, MotionDebugCommand>;

export function gltfDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
): Record<string, unknown> | null {
  if (command !== "motion.scene3d.gltf.import") return null;
  const sourcePath = option(argv, "--source") ?? option(argv, "--in");
  const outDir = option(argv, "--out") ?? option(argv, "--package-dir");
  return {
    ...(sourcePath ? { sourcePath: resolve(sourcePath) } : {}),
    ...(outDir ? { outDir: resolve(outDir) } : {}),
    createdBy: option(argv, "--created-by"),
    createdAt: option(argv, "--created-at"),
  };
}

export function gltfAuthoringRoots(
  command: MotionDebugCommand,
  args: unknown,
): { inputRoots: string[]; outputRoots: string[] } | null {
  if (command !== "motion.scene3d.gltf.import" || !isRecord(args)) return null;
  const sourcePath = args.sourcePath;
  const outDir = args.outDir;
  if (typeof sourcePath !== "string" || typeof outDir !== "string") return null;
  return {
    inputRoots: [dirname(resolve(sourcePath))],
    outputRoots: [dirname(resolve(outDir))],
  };
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
