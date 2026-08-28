import type { MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import { renderBatchBookkeepingDeliveryFields } from "./render-batch-delivery-uncertainty.js";

export function batchRenderCounts(jobs: readonly Record<string, unknown>[], dryRun: boolean): { resumedRows: number; renderedRows: number } {
  const resumedRows = jobs.filter((job) => job.status === "skipped").length;
  return { resumedRows, renderedRows: dryRun ? 0 : jobs.length - resumedRows };
}

/** Reconciliation envelope for a failure after a child renderer returned. */
export type RenderBatchBookkeepingFailure = Record<string, unknown> & { ok: false; command: "render-batch" };

export function renderBatchBookkeepingFailure(input: {
  error: unknown;
  jobs: Array<Record<string, unknown>>;
  dryRun: boolean;
  resume: boolean;
  preset: MotionExportPreset;
  presetSummary: { presets?: MotionExportPreset[] };
  quality?: { minUniqueFrameHashes: number };
  qualityManifestPath?: string;
  packageId: string;
  rows: number;
  phase: "row_bookkeeping" | "aggregate_receipt";
}): RenderBatchBookkeepingFailure {
  const batchCounts = batchRenderCounts(input.jobs, input.dryRun);
  const delivery = renderBatchBookkeepingDeliveryFields(input.jobs);
  return {
    ok: false,
    command: "render-batch",
    dryRun: input.dryRun,
    ...(input.resume ? { resume: input.resume, ...batchCounts } : {}),
    preset: input.preset,
    ...input.presetSummary,
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
    packageId: input.packageId,
    rows: input.rows,
    jobs: input.jobs,
    ...delivery,
    error: {
      code: "render_batch_bookkeeping_failed",
      message: input.error instanceof Error ? input.error.message : String(input.error),
      phase: input.phase,
      ...delivery
    }
  };
}
