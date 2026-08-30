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
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  acquireDerivedOutputPublication,
  prepareBrowserWorkflowCatalogUpsert,
  type BrowserWorkflowDriftSummary,
  type PreparedBrowserWorkflowCatalogUpsert,
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
  /** Mutated in place only for a drift warning; catalog state is an external post-delivery observer. */
  receipt: OperationReceipt;
  outputPath: string;
  receiptPath: string;
  atMs: number;
  workflowEvidence?: BrowserWorkflowRenderEvidence;
  /** Only set by `--catalog`; without it the catalog step is skipped but the receipt still lands. */
  workflowCatalogPath?: string;
  failOnDrift: boolean;
  /** Mirrors the render output's explicit `--force` authority; never inferred from a receipt path. */
  force?: boolean;
}

export interface RenderReceiptFinalizeResult {
  workflowCatalogPath?: string;
  workflowDrift?: BrowserWorkflowDriftSummary;
  /** Always set once the receipt file has been written. */
  receiptPath?: string;
  artifacts?: ReceiptArtifact[];
  error?: { code: string; message: string };
  /** Held privately until the primary render delivery is accepted; never receipt evidence itself. */
  preparedCatalog?: PreparedBrowserWorkflowCatalogUpsert;
}

/**
 * Prepare optional catalog observation while the delivery remains private. The receipt never
 * claims catalog availability: the retained candidate is committed only after primary acceptance.
 */
export async function prepareRenderReceipt(input: RenderReceiptFinalizeInput): Promise<RenderReceiptFinalizeResult> {
  const preparedCatalog = input.workflowCatalogPath ? await prepareRenderWorkflowCatalog(input) : undefined;
  return decidePreparedRenderCatalog(input.receipt, preparedCatalog, input.failOnDrift);
}

/** Pure decision boundary: planning never commits a catalog before its render delivery. */
export function decidePreparedRenderCatalog(
  receipt: OperationReceipt,
  preparedCatalog: PreparedBrowserWorkflowCatalogUpsert | undefined,
  failOnDrift: boolean
): RenderReceiptFinalizeResult {
  const catalog = preparedCatalog?.result;
  const error = catalog && catalog.drift.status === "changed" && failOnDrift
    ? { code: "browser_workflow_drift_detected", message: browserWorkflowDriftWarning(catalog.drift) }
    : undefined;
  if (catalog?.drift.status === "changed") {
    receipt.warnings = dedupeStrings([...receipt.warnings, browserWorkflowDriftWarning(catalog.drift)]);
  }
  return {
    ...(catalog ? { workflowCatalogPath: catalog.catalogPath, workflowDrift: catalog.drift } : {}),
    artifacts: receipt.artifacts ?? [],
    ...(error ? { error } : {}),
    ...(preparedCatalog ? { preparedCatalog } : {})
  };
}

/** Commit the catalog only after the render receipt and its primary delivery have been accepted. */
export async function commitPreparedRenderCatalog(
  prepared: RenderReceiptFinalizeResult,
  receipt?: OperationReceipt
): Promise<RenderReceiptFinalizeResult> {
  // The paired delivery publication rebinds receipt artifacts from its private staging path to
  // the delivered path. Stdout is projected after that commit, so it must use the live receipt,
  // never the pre-publication catalog snapshot.
  const artifacts = receipt?.artifacts ?? prepared.artifacts;
  if (!prepared.preparedCatalog) return { ...withoutPreparedCatalog(prepared), artifacts };
  const catalog = await prepared.preparedCatalog.commit();
  return {
    workflowCatalogPath: catalog.catalogPath,
    workflowDrift: catalog.drift,
    artifacts
  };
}

/** Release a candidate when delivery failed or a fail-on-drift outcome intentionally withholds it. */
export async function abortPreparedRenderCatalog(prepared: RenderReceiptFinalizeResult | undefined): Promise<void> {
  await prepared?.preparedCatalog?.abort();
}

/**
 * Where a render receipt lands for a given lane.
 *
 * `image-sequence` delivers into a directory, so the receipt goes inside it. The other lanes
 * deliver a file, so the receipt is a sibling of that file.
 */
export function renderReceiptPathForOutput(_packageId: string, outputPath: string, lane: RenderReceiptLane): string {
  const root = lane === "image-sequence" ? outputPath : dirname(outputPath);
  return join(root, `${basename(outputPath)}.receipt.json`);
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
export interface RenderReceiptWriteOptions {
  /** The caller explicitly authorized replacing the corresponding rendered output. */
  force?: boolean;
  /** Internal deterministic-test seam for proving a receipt swap cannot be published. */
  afterStageVerified?: () => Promise<void> | void;
}

export async function writeRenderReceiptFile(
  receipt: OperationReceipt,
  receiptPath: string,
  options: RenderReceiptWriteOptions = {}
): Promise<string> {
  receipt.artifacts = dedupeReceiptArtifacts([
    ...(receipt.artifacts ?? []),
    { role: "render_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ]);
  const publication = await acquireDerivedOutputPublication({ outputPath: receiptPath, kind: "file", force: options.force });
  try {
    await writeFile(publication.stagingPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const evidence = await publication.verifyFile();
    await options.afterStageVerified?.();
    await publication.publishFile(evidence);
    return receiptPath;
  } catch (error) {
    await publication.abort();
    throw error;
  }
}

/**
 * Legacy helper for callers that already own their delivery boundary: write the receipt, then
 * commit the optional browser-workflow catalog observer.
 *
 * Drift handling is unchanged — a changed baseline adds a warning, and `failOnDrift` turns that
 * into an error. The error is returned rather than thrown so the caller can still emit the full
 * result envelope; the receipt is on disk either way, because a drifted render is exactly the
 * case where the evidence matters most.
 */
export async function finalizeRenderReceipt(input: RenderReceiptFinalizeInput): Promise<RenderReceiptFinalizeResult> {
  const prepared = await prepareRenderReceipt(input);
  if (prepared.error) await abortPreparedRenderCatalog(prepared);
  const receiptPath = await writeRenderReceiptFile(input.receipt, input.receiptPath, { force: input.force });
  const catalog = prepared.error ? withoutPreparedCatalog(prepared) : await commitPreparedRenderCatalog(prepared, input.receipt);
  return {
    ...(catalog.workflowCatalogPath ? { workflowCatalogPath: catalog.workflowCatalogPath } : {}),
    ...(catalog.workflowDrift ? { workflowDrift: catalog.workflowDrift } : {}),
    receiptPath,
    artifacts: input.receipt.artifacts ?? [],
    ...(prepared.error ? { error: prepared.error } : {})
  };
}

/**
 * Prepare this render's browser-workflow catalog observation without changing public history.
 *
 * Returns `undefined` when the render lacks the identity the catalog is keyed on — a workflow
 * hash and an output hash. That is not an error: a non-workflow render simply has nothing to
 * compare against a baseline.
 */
async function prepareRenderWorkflowCatalog(
  input: RenderReceiptFinalizeInput
): Promise<PreparedBrowserWorkflowCatalogUpsert | undefined> {
  const output = readRecord(input.receipt.output) ?? {};
  const inputHashes = readRecord(input.receipt.inputHashes) ?? {};
  const workflowHash = typeof inputHashes.workflow === "string"
    ? inputHashes.workflow
    : input.workflowEvidence?.workflowHash;
  const outputSha256 = typeof output.sha256 === "string" ? output.sha256 : undefined;
  if (!workflowHash || !outputSha256 || !input.workflowCatalogPath) return undefined;
  const workflow = readRecord(input.workflowEvidence?.workflow);
  const workflowTrace = readRecord(input.workflowEvidence?.workflowTrace);
  return await prepareBrowserWorkflowCatalogUpsert({
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
}

function withoutPreparedCatalog(prepared: RenderReceiptFinalizeResult): RenderReceiptFinalizeResult {
  const { preparedCatalog: _preparedCatalog, ...result } = prepared;
  return result;
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
