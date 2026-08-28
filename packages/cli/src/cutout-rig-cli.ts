import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

const MAX_RIG_FILE_BYTES = 128 * 1024;

export const CUTOUT_RIG_DEBUG_COMMANDS = {
  "cutout-rig-bake": "motion.timeline.cutout.rig.bake",
} as const satisfies Record<string, MotionDebugCommand>;

export async function cutoutRigDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (command !== "motion.timeline.cutout.rig.bake") return null;
  const rigFile = option(argv, "--rig-file");
  const resolvedRigFile = rigFile ? resolve(rigFile) : undefined;
  return {
    packageRoot,
    outDir: option(argv, "--out") ?? option(argv, "--package-dir"),
    sourceLayerId: option(argv, "--source-layer") ?? option(argv, "--source-layer-id"),
    ...(resolvedRigFile ? { rigFilePath: resolvedRigFile } : {}),
    receiptsRoot: option(argv, "--receipts-root"),
    createdBy: option(argv, "--created-by"),
  };
}

/** Read the declared local JSON input only after the CLI has attached its authoring root policy. */
export async function hydrateCutoutRigDebugArgs(
  command: MotionDebugCommand,
  args: unknown,
  authoringInputRoots: string[] | undefined,
): Promise<Record<string, unknown> | null> {
  if (command !== "motion.timeline.cutout.rig.bake" || !isRecord(args) || typeof args.rigFilePath !== "string") return null;
  const rigFilePath = resolve(args.rigFilePath);
  if (!authoringInputRoots?.some((root) => resolve(root) === dirname(rigFilePath))) {
    throw new Error("--rig-file must be inside the declared local authoring input root.");
  }
  // The path is a CLI transport detail, not part of the public Debug/MCP request.
  const { rigFilePath: _rigFilePath, ...request } = args;
  return { ...request, rig: await readGovernedRigFile(rigFilePath) };
}

/** The CLI declares both the package and bounded rig file as approved local authoring inputs. */
export function cutoutRigAuthoringRoots(command: MotionDebugCommand, args: unknown): { inputRoots: string[]; outputRoots: string[] } | null {
  if (command !== "motion.timeline.cutout.rig.bake" || !isRecord(args)) return null;
  if (typeof args.packageRoot !== "string" || typeof args.outDir !== "string" || typeof args.rigFilePath !== "string") return null;
  return {
    inputRoots: [dirname(resolve(args.packageRoot)), dirname(resolve(args.rigFilePath))],
    outputRoots: [dirname(resolve(args.outDir))],
  };
}

async function readGovernedRigFile(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_RIG_FILE_BYTES) {
    throw new Error(`--rig-file must be a regular non-symlink JSON file no larger than ${MAX_RIG_FILE_BYTES} bytes.`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("--rig-file changed before it was opened.");
    }
    const bytes = Buffer.alloc(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("--rig-file changed while it was read.");
      offset += read.bytesRead;
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new Error("--rig-file changed while it was read.");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
