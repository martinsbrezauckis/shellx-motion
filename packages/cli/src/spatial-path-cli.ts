import type { MotionDebugCommand } from "@shellx-motion/debug-api";

export const SPATIAL_PATH_DEBUG_COMMANDS = {
  "spatial-position-upsert": "motion.timeline.spatial.position.upsert",
  "spatial-position-move": "motion.timeline.spatial.position.move",
  "spatial-position-delete": "motion.timeline.spatial.position.delete",
} as const satisfies Record<string, MotionDebugCommand>;

export function spatialPathDebugArgs(command: MotionDebugCommand, argv: string[], packageRoot: string | undefined): Record<string, unknown> | null {
  if (command !== "motion.timeline.spatial.position.upsert"
    && command !== "motion.timeline.spatial.position.move"
    && command !== "motion.timeline.spatial.position.delete") return null;
  const common = {
    packageRoot,
    outDir: option(argv, "--out") ?? option(argv, "--package-dir"),
    receiptsRoot: option(argv, "--receipts-root"),
    createdBy: option(argv, "--created-by"),
    layerId: option(argv, "--layer") ?? option(argv, "--layer-id"),
  };
  if (command === "motion.timeline.spatial.position.move") {
    return { ...common, fromMs: numeric(argv, "--from-ms"), toMs: numeric(argv, "--to-ms") };
  }
  const atMs = numeric(argv, "--at-ms");
  if (command === "motion.timeline.spatial.position.delete") return { ...common, atMs };
  const mode = option(argv, "--mode");
  const spatial = mode ? {
    mode,
    in: { x: numeric(argv, "--in-x"), y: numeric(argv, "--in-y") },
    out: { x: numeric(argv, "--out-x"), y: numeric(argv, "--out-y") },
  } : undefined;
  return {
    ...common,
    atMs,
    x: numeric(argv, "--x"),
    y: numeric(argv, "--y"),
    easing: option(argv, "--easing"),
    ...(spatial ? { spatial } : {}),
  };
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numeric(argv: string[], name: string): number { return Number(option(argv, name)); }
