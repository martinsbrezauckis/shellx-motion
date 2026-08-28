/** Closed CLI projection for document-root behavior authoring. */
import { resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

type OptionReader = (argv: string[], option: string) => string | undefined;

const INSPECT = "motion.timeline.behaviors.inspect";
const UPSERT = "motion.timeline.behaviors.upsert";
const REMOVE = "motion.timeline.behaviors.remove";

export function timelineBehaviorDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
  optionValue: OptionReader,
): Record<string, unknown> | null {
  if (command !== INSPECT && command !== UPSERT && command !== REMOVE) return null;
  if (argv.includes("--receipts-root") || argv.includes("--receipts")) {
    throw new Error(`${command} does not accept caller-selected receipts roots; the CLI configures its host receipt store internally.`);
  }
  const common = { ...(packageRoot === undefined ? {} : { packageRoot }) };
  if (command === INSPECT) return common;
  const outDir = equivalentOutputDirectory(command, argv, optionValue);
  const createdBy = optionValue(argv, "--created-by");
  const edit = {
    ...common,
    ...(outDir === undefined ? {} : { outDir }),
    ...(createdBy === undefined ? {} : { createdBy }),
  };
  if (command === UPSERT) {
    const bindingJson = optionValue(argv, "--binding-json");
    return { ...edit, ...(bindingJson === undefined ? {} : { binding: JSON.parse(bindingJson) }) };
  }
  const targetLayerId = optionValue(argv, "--target-layer-id")
    ?? optionValue(argv, "--target-layer")
    ?? optionValue(argv, "--layer-id")
    ?? optionValue(argv, "--layer");
  return { ...edit, ...(targetLayerId === undefined ? {} : { targetLayerId }) };
}

function equivalentOutputDirectory(
  command: MotionDebugCommand,
  argv: string[],
  optionValue: OptionReader,
): string | undefined {
  const outDir = optionValue(argv, "--out");
  const packageDir = optionValue(argv, "--package-dir");
  if (outDir !== undefined && packageDir !== undefined && resolve(outDir) !== resolve(packageDir)) {
    throw new Error(`${command} requires --out and --package-dir to resolve to the same directory when both are supplied.`);
  }
  return outDir ?? packageDir;
}
