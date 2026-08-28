/** Bounded inline CLI decoder for one atomic revision transaction. */
import { dirname, resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

export function revisionTransactionDebugArgs(
  argv: string[],
  packageRoot: string | undefined,
  optionValue: (argv: string[], option: string) => string | undefined
): Record<string, unknown> {
  const forbiddenOption = ["--receipts-root", "--steps-file", "--transaction-file"].find((option) => argv.includes(option));
  if (forbiddenOption) throw new Error(`motion.revision.transaction does not accept ${forbiddenOption}; pass the bounded base and typed steps inline.`);
  const baseJson = optionValue(argv, "--base-json");
  const stepsJson = optionValue(argv, "--steps-json");
  const createdBy = optionValue(argv, "--created-by");
  return {
    packageRoot,
    outDir: optionValue(argv, "--out") ?? optionValue(argv, "--out-dir"),
    ...(baseJson ? { base: JSON.parse(baseJson) } : {}),
    ...(stepsJson ? { steps: JSON.parse(stepsJson) } : {}),
    ...(createdBy ? { createdBy } : {})
  };
}

/** Bounded inline CLI decoder for the read-only atomic revision preflight. */
export function revisionTransactionPlanDebugArgs(
  argv: string[],
  packageRoot: string | undefined,
  optionValue: (argv: string[], option: string) => string | undefined
): Record<string, unknown> {
  const forbiddenOption = ["--out", "--out-dir", "--created-by", "--actor", "--actor-kind", "--receipts-root", "--steps-file", "--transaction-file"].find((option) => argv.includes(option));
  if (forbiddenOption) throw new Error(`motion.revision.transaction.plan does not accept ${forbiddenOption}; pass the bounded base and typed steps inline.`);
  const baseJson = optionValue(argv, "--base-json");
  const stepsJson = optionValue(argv, "--steps-json");
  return { packageRoot, ...(baseJson ? { base: JSON.parse(baseJson) } : {}), ...(stepsJson ? { steps: JSON.parse(stepsJson) } : {}) };
}

/** The CLI is the local embedding host, so it derives only the plan input fence from --package. */
export function revisionTransactionPlanAuthoringRoots(command: MotionDebugCommand, args: unknown): { inputRoots: string[]; outputRoots: string[] } | null {
  if (command !== "motion.revision.transaction.plan" || !plainRecord(args)) return null;
  const packageRoot = args.packageRoot;
  if (typeof packageRoot !== "string" || !packageRoot || packageRoot.includes("\0") || Buffer.byteLength(packageRoot, "utf8") > 4096) return null;
  return { inputRoots: [dirname(resolve(packageRoot))], outputRoots: [] };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
