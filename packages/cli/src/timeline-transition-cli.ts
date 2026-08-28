/** Closed CLI projection for transition CRUD and named transition presets. */
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

type OptionReader = (argv: string[], option: string) => string | undefined;
type PackageRootReader = (argv: string[]) => string | undefined;

export function timelineTransitionDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  optionValue: OptionReader,
  packageRoot: PackageRootReader,
): Record<string, unknown> | null {
  if (command === "motion.timeline.transition.presets") return {};
  if (command !== "motion.timeline.transition.upsert"
    && command !== "motion.timeline.transition.delete"
    && command !== "motion.timeline.transition.preset.apply") return null;
  const common = {
    packageRoot: packageRoot(argv),
    outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
    receiptsRoot: optionValue(argv, "--receipts-root"),
    createdBy: optionValue(argv, "--created-by"),
    layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
  };
  if (command === "motion.timeline.transition.delete") return { ...common, edge: optionValue(argv, "--edge") };
  const durationMs = optionValue(argv, "--duration-ms");
  const distance = optionValue(argv, "--distance");
  if (command === "motion.timeline.transition.preset.apply") return {
    ...common,
    preset: optionValue(argv, "--preset"),
    ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
    direction: optionValue(argv, "--direction"),
    ...(distance !== undefined ? { distance: Number(distance) } : {}),
    easing: optionValue(argv, "--easing"),
  };
  return {
    ...common,
    edge: optionValue(argv, "--edge"),
    type: optionValue(argv, "--type"),
    ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
    easing: optionValue(argv, "--easing"),
    direction: optionValue(argv, "--direction"),
    ...(distance !== undefined ? { distance: Number(distance) } : {}),
  };
}
