/**
 * CLI verbs for importing Lottie and dotLottie sources.
 *
 * Modelled directly on `gltf-cli.ts` — same flags, same root derivation — so an operator who has
 * used one Motion import verb already knows the others. The dotLottie verb adds the two selectors
 * a `.lottie` container needs, because a container can hold several animations and several themes.
 *
 * Primary caller: the modular debug CLI router in `modular-debug-cli.ts`.
 */
import { dirname, resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";
import { resolveCliInputPath, resolveCliOutputPath } from "./cli-path-resolution";

export const LOTTIE_DEBUG_COMMANDS = {
  "lottie-import": "motion.lottie.import",
  "dotlottie-import": "motion.dotlottie.import",
} as const satisfies Record<string, MotionDebugCommand>;

function isLottieImport(command: MotionDebugCommand): boolean {
  return command === "motion.lottie.import" || command === "motion.dotlottie.import";
}

export function lottieDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
): Record<string, unknown> | null {
  if (!isLottieImport(command)) return null;
  const sourcePath = option(argv, "--source") ?? option(argv, "--in");
  const outDir = option(argv, "--out") ?? option(argv, "--package-dir");
  const animationId = option(argv, "--animation");
  const themeId = option(argv, "--theme");
  return {
    ...(sourcePath ? { sourcePath: resolveCliInputPath(sourcePath) } : {}),
    ...(outDir ? { outDir: resolveCliOutputPath(outDir) } : {}),
    // Only the container format accepts a selection; passing them to plain Lottie would be
    // rejected by its argument contract, which is the behaviour we want.
    ...(command === "motion.dotlottie.import" && animationId ? { animationId } : {}),
    ...(command === "motion.dotlottie.import" && themeId ? { themeId } : {}),
    createdBy: option(argv, "--created-by"),
    createdAt: option(argv, "--created-at"),
  };
}

export function lottieAuthoringRoots(
  command: MotionDebugCommand,
  args: unknown,
): { inputRoots: string[]; outputRoots: string[] } | null {
  if (!isLottieImport(command) || !isRecord(args)) return null;
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
