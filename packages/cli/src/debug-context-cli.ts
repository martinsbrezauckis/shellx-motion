import { dirname, resolve } from "node:path";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

export function debugScratchRoot(
  debugName: MotionDebugCommand,
  args: unknown,
  explicitScratchRoot?: string,
): string | undefined {
  if (explicitScratchRoot) return explicitScratchRoot;
  const record = readRecord(args);
  if (!record) return undefined;
  if (debugName === "motion.support.bundle") {
    return typeof record.outDir === "string" ? dirname(resolve(record.outDir)) : undefined;
  }
  if (debugName === "motion.quality.panel") {
    return typeof record.qualityManifestPath === "string"
      ? dirname(resolve(record.qualityManifestPath))
      : undefined;
  }
  if (debugName === "motion.agent.revision.plan") {
    if (typeof record.planPath === "string") return dirname(resolve(record.planPath));
    return typeof record.receiptsRoot === "string" ? resolve(record.receiptsRoot) : undefined;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
