/** Closed CLI projection for exact-time persisted shape geometry snapshots. */
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

type OptionReader = (argv: string[], option: string) => string | undefined;

const INSPECT = "motion.timeline.shape.geometry-keyframes.inspect";
const UPSERT = "motion.timeline.shape.geometry-keyframes.upsert";
const DELETE = "motion.timeline.shape.geometry-keyframes.delete";
const MOVE = "motion.timeline.shape.geometry-keyframes.move";

export function isShapeGeometryKeyframeDebugCommand(command: MotionDebugCommand): boolean {
  return command === INSPECT || command === UPSERT || command === DELETE || command === MOVE;
}

/** The CLI configures this family's host receipt store; callers cannot choose it. */
export function shapeGeometryKeyframeDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
  optionValue: OptionReader,
): Record<string, unknown> | null {
  if (!isShapeGeometryKeyframeDebugCommand(command)) return null;
  if (argv.includes("--receipts-root") || argv.includes("--receipts")) {
    throw new Error(`${command} does not accept caller-selected receipts roots; the CLI configures its host receipt store internally.`);
  }
  const layerId = optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id");
  const target = { ...(packageRoot === undefined ? {} : { packageRoot }), ...(layerId === undefined ? {} : { layerId }) };
  if (command === INSPECT) return target;
  const outDir = optionValue(argv, "--out") ?? optionValue(argv, "--package-dir");
  const createdBy = optionValue(argv, "--created-by");
  const common = {
    ...target,
    ...(outDir === undefined ? {} : { outDir }),
    ...(createdBy === undefined ? {} : { createdBy }),
  };
  if (command === UPSERT) {
    const snapshotJson = optionValue(argv, "--snapshot-json");
    return { ...common, ...(snapshotJson === undefined ? {} : { snapshot: JSON.parse(snapshotJson) }) };
  }
  const atUs = optionValue(argv, "--at-us");
  if (command === DELETE) return { ...common, ...(atUs === undefined ? {} : { atUs: Number(atUs) }) };
  const fromAtUs = optionValue(argv, "--from-at-us"), toAtUs = optionValue(argv, "--to-at-us");
  return {
    ...common,
    ...(fromAtUs === undefined ? {} : { fromAtUs: Number(fromAtUs) }),
    ...(toAtUs === undefined ? {} : { toAtUs: Number(toAtUs) }),
  };
}
