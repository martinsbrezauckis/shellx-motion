/** Truthful batch envelopes for a delegated render whose final link may already exist. */
export interface RenderCommitUncertainDelivery {
  outputPath: string;
  receiptPath: string;
  expectedPublications?: unknown[];
}

/** One child delivery observed before batch bookkeeping begins. */
export type RenderBatchChildDelivery =
  | { kind: "committed"; outputPath: string; receiptPath: string }
  | { kind: "primary_uncertain"; outputPath: string; receiptPath: string; expectedPublications?: unknown[] }
  | { kind: "evidence_uncertain"; phase: string; publicPaths: string[]; expectedPublications?: unknown[] };

const uncertainWarning = "Render delivery evidence may have committed; inspect the reported public paths before retrying.";

export function readRenderCommitUncertainDelivery(result: unknown): RenderCommitUncertainDelivery | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  return record.renderCommitUncertain === true
    && typeof record.outputPath === "string"
    && typeof record.receiptPath === "string"
    ? { outputPath: record.outputPath, receiptPath: record.receiptPath, ...expectedPublicationFields(record) }
    : undefined;
}

/**
 * Capture delivery truth directly from the child envelope, before a batch assertion or receipt
 * write can fail.  `renderCommitUncertain` is intentionally reserved for the primary artifact;
 * receipt/secondary Core uncertainty remains an evidence-only possibly-committed outcome.
 */
export function readRenderBatchChildDelivery(result: unknown): RenderBatchChildDelivery | undefined {
  const record = ownRecord(result);
  const primary = readRenderCommitUncertainDelivery(result);
  if (primary) return { kind: "primary_uncertain", ...primary };
  if (record?.possiblyCommitted === true) {
    const publicPaths = Array.isArray(record.publicPaths)
      ? record.publicPaths.filter((path): path is string => typeof path === "string")
      : [];
    const phase = typeof record.publicationCommitPhase === "string" ? record.publicationCommitPhase : "unknown";
    return publicPaths.length > 0 ? { kind: "evidence_uncertain", phase, publicPaths, ...expectedPublicationFields(record) } : undefined;
  }
  return record?.ok === true && typeof record.outputPath === "string" && typeof record.receiptPath === "string"
    ? { kind: "committed", outputPath: record.outputPath, receiptPath: record.receiptPath }
    : undefined;
}

export function renderBatchChildDeliveryJobFields(delivery: RenderBatchChildDelivery | undefined): Record<string, unknown> {
  if (!delivery) return {};
  if (delivery.kind === "committed") return {
    renderCommitted: true,
    renderOutputPath: delivery.outputPath,
    renderReceiptPath: delivery.receiptPath
  };
  if (delivery.kind === "primary_uncertain") return renderCommitUncertainJobFields(delivery);
  return {
    possiblyCommitted: true,
    publicationCommitPhase: delivery.phase,
    publicPaths: delivery.publicPaths,
    ...expectedPublicationFields(delivery)
  };
}

/** Compact, complete reconciliation facts for a batch bookkeeping failure. */
export function renderBatchBookkeepingDeliveryFields(jobs: readonly Record<string, unknown>[]): Record<string, unknown> {
  const committedDeliveries = jobs
    .filter((job) => job.renderCommitted === true && typeof job.renderOutputPath === "string" && typeof job.renderReceiptPath === "string")
    .map((job) => ({ outputPath: job.renderOutputPath, receiptPath: job.renderReceiptPath }));
  const uncertainDeliveries: Array<{ phase: string; outputPath?: string; receiptPath?: string; publicPaths?: string[]; expectedPublications?: unknown[] }> = [];
  for (const job of jobs) {
    if (job.renderCommitUncertain === true && typeof job.renderOutputPath === "string" && typeof job.renderReceiptPath === "string") {
      uncertainDeliveries.push({ phase: "output", outputPath: job.renderOutputPath, receiptPath: job.renderReceiptPath, ...expectedPublicationFields(job) });
      continue;
    }
    if (job.possiblyCommitted === true && Array.isArray(job.publicPaths)) {
      uncertainDeliveries.push({
        phase: typeof job.publicationCommitPhase === "string" ? job.publicationCommitPhase : "unknown",
        publicPaths: job.publicPaths.filter((path): path is string => typeof path === "string"),
        ...expectedPublicationFields(job)
      });
    }
  }
  return {
    ...(committedDeliveries.length > 0 ? { batchCommitted: true, committedDeliveries } : {}),
    ...(uncertainDeliveries.length > 0 ? { possiblyCommitted: true, uncertainDeliveries } : {})
  };
}

export function renderBatchFailureReceipt(input: {
  packageId: string;
  rowHash: string;
  preset: string;
  delivery: RenderBatchChildDelivery | RenderCommitUncertainDelivery | undefined;
}): Record<string, unknown> {
  const delivery = input.delivery && "kind" in input.delivery
    ? input.delivery
    : input.delivery ? { kind: "primary_uncertain" as const, ...input.delivery } : undefined;
  const uncertain = delivery?.kind === "primary_uncertain" || delivery?.kind === "evidence_uncertain";
  return {
    schema: "shellx-motion/receipt@1",
    id: uncertain ? `render-commit-uncertain-${input.packageId}` : `render-failed-${input.packageId}`,
    operation: "render.final",
    status: uncertain ? "warning" : "failed",
    packageId: input.packageId,
    inputHashes: { row: input.rowHash },
    createdAt: new Date().toISOString(),
    lane: "ffmpeg",
    output: delivery?.kind === "primary_uncertain"
      ? { preset: input.preset, renderCommitUncertain: true, outputPath: delivery.outputPath, receiptPath: delivery.receiptPath, ...expectedPublicationFields(delivery) }
      : delivery?.kind === "evidence_uncertain"
        ? { preset: input.preset, possiblyCommitted: true, publicationCommitPhase: delivery.phase, publicPaths: delivery.publicPaths, ...expectedPublicationFields(delivery) }
        : { preset: input.preset },
    warnings: uncertain ? [uncertainWarning] : []
  };
}

export function renderCommitUncertainWarnings(delivery: RenderCommitUncertainDelivery | undefined): string[] {
  return delivery ? [uncertainWarning] : [];
}

export function renderCommitUncertainJobFields(delivery: RenderCommitUncertainDelivery | undefined): Record<string, unknown> {
  return delivery ? {
    renderCommitUncertain: true,
    renderOutputPath: delivery.outputPath,
    renderReceiptPath: delivery.receiptPath,
    ...expectedPublicationFields(delivery)
  } : {};
}

export function renderCommitUncertainResponseFields(delivery: RenderCommitUncertainDelivery | undefined): Record<string, unknown> {
  return delivery ? {
    renderCommitUncertain: true,
    outputPath: delivery.outputPath,
    renderReceiptPath: delivery.receiptPath,
    ...expectedPublicationFields(delivery)
  } : {};
}

export function renderCommitUncertainErrorFields(delivery: RenderCommitUncertainDelivery | undefined): Record<string, unknown> {
  return delivery ? {
    renderCommitUncertain: true,
    outputPath: delivery.outputPath,
    receiptPath: delivery.receiptPath,
    ...expectedPublicationFields(delivery)
  } : {};
}

export function batchRenderErrorEnvelope(input: { result: unknown; rowId: string; packageId: string }): Record<string, unknown> {
  const record = ownRecord(input.result);
  const error = ownRecord(record?.error) ?? { code: "render_failed", message: "Batch row render failed." };
  return {
    ...error,
    rowId: input.rowId,
    packageId: input.packageId,
    ...renderCommitUncertainErrorFields(readRenderCommitUncertainDelivery(input.result))
  };
}

export function renderCommitUncertainReceiptJobFields(job: Record<string, unknown>): Record<string, unknown> {
  return job.renderCommitUncertain === true ? {
    renderCommitUncertain: true,
    renderOutputPath: job.renderOutputPath,
    renderReceiptPath: job.renderReceiptPath,
    ...expectedPublicationFields(job)
  } : job.possiblyCommitted === true && Array.isArray(job.publicPaths) ? {
    possiblyCommitted: true,
    publicationCommitPhase: typeof job.publicationCommitPhase === "string" ? job.publicationCommitPhase : "unknown",
    publicPaths: job.publicPaths.filter((path): path is string => typeof path === "string"),
    ...expectedPublicationFields(job)
  } : {};
}

function expectedPublicationFields(value: { expectedPublications?: unknown }): { expectedPublications?: unknown[] } {
  return Array.isArray(value.expectedPublications) && value.expectedPublications.length > 0
    ? { expectedPublications: [...value.expectedPublications] }
    : {};
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
