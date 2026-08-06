import type { MotionDebugCommand } from "@shellx-motion/debug-api";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const COMPOSITING_GRAPH_DEBUG_COMMANDS = {
  "compositing-graph-inspect": "motion.compositing.graph.inspect",
  "compositing-graph-set": "motion.compositing.graph.set",
  "compositing-graph-remove": "motion.compositing.graph.remove",
} as const satisfies Record<string, MotionDebugCommand>;

export async function compositingGraphDebugArgs(
  command: MotionDebugCommand,
  argv: string[],
  packageRoot: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (command !== "motion.compositing.graph.inspect"
    && command !== "motion.compositing.graph.set"
    && command !== "motion.compositing.graph.remove") return null;
  const common = {
    packageRoot,
    outDir: option(argv, "--out") ?? option(argv, "--package-dir"),
    receiptsRoot: option(argv, "--receipts-root"),
    createdBy: option(argv, "--created-by"),
  };
  if (command === "motion.compositing.graph.inspect") return { packageRoot };
  if (command === "motion.compositing.graph.remove") return common;
  const inline = option(argv, "--graph-json");
  const file = option(argv, "--graph-file");
  if (inline && file) throw new Error("Use either --graph-json or --graph-file, not both.");
  const graph = inline ? JSON.parse(inline)
    : file ? JSON.parse(await readFile(resolve(file), "utf8"))
      : undefined;
  return { ...common, graph };
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
