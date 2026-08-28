import type { MotionPointCloud } from "@shellx-motion/core";
import { objectArg } from "./args.js";

/**
 * Data-only bridge for the generic layer-create command. Core remains the
 * authority for point counts, sample timing, sizes, and aggregate budgets.
 */
export function timelinePointCloudArg(source: Record<string, unknown>): MotionPointCloud | false | null {
  const pointCloud = objectArg(source.pointCloud);
  if (source.pointCloud !== undefined && !pointCloud) return false;
  return pointCloud ? structuredClone(pointCloud) as unknown as MotionPointCloud : null;
}
