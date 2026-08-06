/**
 * Persisting a render receipt to disk.
 *
 * Role: every `render` invocation leaves a verifiable receipt file beside the artifact it
 * produced. This is the on-disk half of the product's central claim — an agent that renders
 * and exits must be able to come back later and verify what was produced, without having
 * captured stdout at the time.
 *
 * History: receipt persistence used to be reachable only through the browser-workflow catalog
 * path (`--catalog`). Every ordinary render therefore produced only its media file, and the
 * receipt existed solely as transient stdout JSON. The catalog upsert is now one optional step
 * inside a finalizer that always writes.
 *
 * Dependencies: `@shellx-motion/core` for the browser-workflow catalog and receipt types.
 * Primary caller: `renderCommand` in `packages/cli/src/main.ts`, once per delivery lane
 * (`image`, `image-sequence`, `ffmpeg`), plus the render failure paths in the same file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  upsertBrowserWorkflowCatalog,
  type BrowserWorkflowDriftSummary,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";

/** Delivery lanes that produce a render artifact, and so a render receipt beside it. */
export type RenderReceiptLane = "ffmpeg" | "image" | "image-sequence";

export interface BrowserWorkflowRenderEvidence {
  workflow?: unknown;
  workflowTrace?: unknown;
  workflowHash?: string;
}

export interface RenderReceiptFinalizeInput {
  packageId: string;
  /** Mutated in place: the catalog step appends output fields, warnings and artifacts. */
  receipt: OperationReceipt;
  outputPath: string;
  receiptPath: string;
  atMs: number;
  workflowEvidence?: BrowserWorkflowRenderEvidence;
  /** Only set by `--catalog`; without it the catalog step is skipped but the receipt still lands. */
  workflowCatalogPath?: string;
  failOnDrift: boolean;
}

export interface RenderReceiptFinalizeResult {
  workflowCatalogPath?: string;
  workflowDrift?: BrowserWorkflowDriftSummary;
  /** Always set once the receipt file has been written. */
  receiptPath?: string;
  artifacts?: ReceiptArtifact[];
  error?: { code: string; message: string };
}

/**
 * Where a render receipt lands for a given lane.
 *
 * `image-sequence` delivers into a directory, so the receipt goes inside it. The other lanes
 * deliver a file, so the receipt is a sibling of that file.
 */
export function renderReceiptPathForOutput(packageId: string, outputPath: string, lane: RenderReceiptLane): string {
  const root = lane === "image-sequence" ? outputPath : dirname(outputPath);
  return join(root, `${packageId}-render.receipt.json`);
}

export function browserWorkflowDriftWarning(drift: BrowserWorkflowDriftSummary): string {
  return `Browser workflow drift detected for ${drift.key}: baseline ${drift.baselineOutputSha256} != current ${drift.currentOutputSha256}.`;
}

/**
 * Write `receipt` to `receiptPath`, first recording the receipt file itself as an artifact.
 *
 * Self-reference is deliberate: a reader that holds only the receipt can still confirm which
 * path it was meant to occupy, which is what makes a moved or copied receipt detectable.
 *
 * @returns the path written.
 */
export async function writeRenderReceiptFile(receipt: OperationReceipt, receiptPath: string): Promise<string> {
  receipt.artifacts = dedupeReceiptArtifacts([
    ...(receipt.artifacts ?? []),
    { role: "render_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ]);
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receiptPath;
}

/**
 * Finish a render: optionally upsert the browser-workflow catalog, then always persist the receipt.
 *
 * Drift handling is unchanged — a changed baseline adds a warning, and `failOnDrift` turns that
 * into an error. The error is returned rather than thrown so the caller can still emit the full
 * result envelope; the receipt is on disk either way, because a drifted render is exactly the
 * case where the evidence matters most.
 */
export async function finalizeRenderReceipt(input: RenderReceiptFinalizeInput): Promise<RenderReceiptFinalizeResult> {
  const catalog = input.workflowCatalogPath ? await upsertRenderWorkflowCatalog(input) : undefined;
  const receiptPath = await writeRenderReceiptFile(input.receipt, input.receiptPath);
  const error = catalog && catalog.drift.status === "changed" && input.failOnDrift
    ? { code: "browser_workflow_drift_detected", message: browserWorkflowDriftWarning(catalog.drift) }
    : undefined;
  return {
    ...(catalog ? { workflowCatalogPath: catalog.catalogPath, workflowDrift: catalog.drift } : {}),
    receiptPath,
    artifacts: input.receipt.artifacts ?? [],
    ...(error ? { error } : {})
  };
}

/**
 * Record this render in the browser-workflow catalog and fold the result into the receipt.
 *
 * Returns `undefined` when the render lacks the identity the catalog is keyed on — a workflow
 * hash and an output hash. That is not an error: a non-workflow render simply has nothing to
 * compare against a baseline.
 */
async function upsertRenderWorkflowCatalog(
  input: RenderReceiptFinalizeInput
): Promise<{ catalogPath: string; drift: BrowserWorkflowDriftSummary } | undefined> {
  const output = readRecord(input.receipt.output) ?? {};
  const inputHashes = readRecord(input.receipt.inputHashes) ?? {};
  const workflowHash = typeof inputHashes.workflow === "string"
    ? inputHashes.workflow
    : input.workflowEvidence?.workflowHash;
  const outputSha256 = typeof output.sha256 === "string" ? output.sha256 : undefined;
  if (!workflowHash || !outputSha256 || !input.workflowCatalogPath) return undefined;
  const workflow = readRecord(input.workflowEvidence?.workflow);
  const workflowTrace = readRecord(input.workflowEvidence?.workflowTrace);
  const catalog = await upsertBrowserWorkflowCatalog({
    catalogPath: input.workflowCatalogPath,
    capture: {
      packageId: input.packageId,
      workflowHash,
      atMs: input.atMs,
      outputSha256,
      outputPath: input.outputPath,
      receiptPath: input.receiptPath,
      createdAt: input.receipt.createdAt,
      workflow: {
        stepCount: typeof workflow?.stepCount === "number"
          ? workflow.stepCount
          : typeof workflowTrace?.stepCount === "number" ? workflowTrace.stepCount : 0,
        networkPolicy: typeof workflow?.networkPolicy === "string"
          ? workflow.networkPolicy
          : "blocked-unless-declared"
      }
    }
  });
  input.receipt.output = { ...output, workflowCatalogPath: catalog.catalogPath, workflowDrift: catalog.drift };
  if (catalog.drift.status === "changed") {
    input.receipt.warnings = dedupeStrings([...input.receipt.warnings, browserWorkflowDriftWarning(catalog.drift)]);
  }
  input.receipt.artifacts = dedupeReceiptArtifacts([
    ...(input.receipt.artifacts ?? []),
    { role: "browser_workflow_catalog", path: catalog.catalogPath, status: "available", mediaType: "application/json" }
  ]);
  return { catalogPath: catalog.catalogPath, drift: catalog.drift };
}

/** Artifacts are identified by role AND path — the same file can legitimately fill two roles. */
export function dedupeReceiptArtifacts(artifacts: ReceiptArtifact[]): ReceiptArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.role}\0${artifact.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
