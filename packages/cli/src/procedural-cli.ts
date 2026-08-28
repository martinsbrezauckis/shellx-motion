import type { MotionDebugCommand } from "@shellx-motion/debug-api";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const PROCEDURAL_DEBUG_COMMANDS = {
  "procedural-inspect": "motion.procedural.inspect",
  "procedural-set": "motion.procedural.relationship.set",
  "procedural-enabled-set": "motion.procedural.relationship.enabled.set",
  "procedural-bake": "motion.procedural.relationship.bake",
  "procedural-detach": "motion.procedural.relationship.detach",
} as const satisfies Record<string, MotionDebugCommand>;

/**
 * The direct CLI is its own local host. It derives the narrow package and
 * revision parents from its typed procedural arguments; Debug/MCP callers do
 * not use this helper and must still receive roots from their embedding host.
 */
export function proceduralAuthoringRoots(
  command: MotionDebugCommand,
  args: unknown,
): { inputRoots: string[]; outputRoots: string[] } | null {
  if (!Object.values(PROCEDURAL_DEBUG_COMMANDS).includes(command as never) || !isRecord(args)
    || typeof args.packageRoot !== "string" || !args.packageRoot || args.packageRoot.includes("\0")) return null;
  const inputRoot = dirname(resolve(args.packageRoot));
  if (command === "motion.procedural.inspect") {
    return { inputRoots: [inputRoot], outputRoots: [inputRoot] };
  }
  if (typeof args.outDir !== "string" || !args.outDir || args.outDir.includes("\0")) return null;
  return { inputRoots: [inputRoot], outputRoots: [dirname(resolve(args.outDir))] };
}

export async function proceduralDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!Object.values(PROCEDURAL_DEBUG_COMMANDS).includes(command as never)) return null;
  const common = {
    packageRoot,
    outDir: option(argv, "--out") ?? option(argv, "--package-dir"),
    receiptsRoot: option(argv, "--receipts-root"),
    createdBy: option(argv, "--created-by"),
  };
  if (command === "motion.procedural.inspect") {
    return { packageRoot, ...optionalNumber(argv, "--at-ms", "atMs") };
  }
  if (command === "motion.procedural.relationship.set") {
    const inline = option(argv, "--relationship-json");
    const file = option(argv, "--relationship-file");
    if (inline && file) throw new Error("Use either --relationship-json or --relationship-file, not both.");
    const relationship = inline ? JSON.parse(inline)
      : file ? JSON.parse(await readFile(resolve(file), "utf8"))
        : undefined;
    return { ...common, relationship };
  }
  const relationshipId = option(argv, "--relationship") ?? option(argv, "--relationship-id") ?? option(argv, "--id");
  if (command === "motion.procedural.relationship.enabled.set") {
    const enabled = booleanChoice(argv, "--enabled", "--disabled");
    return { ...common, relationshipId, enabled };
  }
  if (command === "motion.procedural.relationship.detach") return { ...common, relationshipId };
  return {
    ...common,
    relationshipIds: commaList(option(argv, "--relationships") ?? option(argv, "--relationship-ids")),
    ...optionalNumber(argv, "--start-ms", "startMs"),
    ...optionalNumber(argv, "--end-ms", "endMs"),
    ...optionalNumber(argv, "--sample-every-frames", "sampleEveryFrames"),
  };
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
function optionalNumber(argv: string[], flag: string, key: string): Record<string, number> {
  const value = option(argv, flag);
  if (value === undefined) return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number.`);
  return { [key]: parsed };
}
function booleanChoice(argv: string[], positive: string, negative: string): boolean | undefined {
  const hasPositive = argv.includes(positive);
  const hasNegative = argv.includes(negative);
  if (hasPositive && hasNegative) throw new Error(`Use either ${positive} or ${negative}, not both.`);
  return hasPositive ? true : hasNegative ? false : undefined;
}
function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
