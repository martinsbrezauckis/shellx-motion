import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildBrowserRecordingManifest,
  browserRecordingSampleTimes,
  canonicalJsonSha256,
  hashFile,
  OutputDirectoryReservation,
  type BrowserRecordingManifest,
  type BrowserRecordingManifestFrame,
  type BrowserWorkflowDriftSummary,
  type DerivedOutputPublication,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import { throwIfCancelled } from "./render-cancelled";
import { DirectoryBundleCommitUncertainError, publishGovernedDirectoryBundle } from "./governed-directory-delivery";

export type CaptureCliResult = Record<string, unknown> & { ok: boolean; command?: string };

export interface BrowserRecordingCapture {
  manifest: BrowserRecordingManifest;
  /** Every available renderer companion returned by a recording sample, still at its private path. */
  rendererArtifacts: ReceiptArtifact[];
}

export async function assertCaptureBundleOutput(actualPath: string, expectedPath: string, label: string): Promise<void> {
  if (resolve(actualPath) !== resolve(expectedPath)) throw new Error(`Browser ${label} escaped its governed capture bundle stage.`);
  await hashFile(expectedPath);
}

export function readPositiveCaptureInteger(
  raw: string | undefined,
  option: string,
  defaultValue: number
): { ok: true; value: number } | { ok: false; result: CaptureCliResult } {
  if (raw === undefined) return { ok: true, value: defaultValue };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, result: { ok: false, command: "capture-browser", error: { code: "invalid_args", message: `${option} must be a positive integer.` } } };
  }
  return { ok: true, value };
}

export interface BrowserCaptureFailureBundleInput {
  publication: DerivedOutputPublication;
  pkg: MotionPackage;
  workflowPath?: string;
  trace?: unknown;
  workflowTracePath?: string;
  receipt: OperationReceipt;
  error: { code: string; message: string };
  workflowCatalogPath?: string;
  workflowDrift?: BrowserWorkflowDriftSummary;
}

/** Publish only redacted failure evidence in the governed directory bundle. */
export async function publishBrowserCaptureFailureBundle(input: BrowserCaptureFailureBundleInput): Promise<CaptureCliResult> {
  const plan = redactedBrowserCaptureFailureBundle(input);
  // The only renderer-generated evidence roots are private to this bundle stage. A failed replay
  // or drift report deliberately publishes a redacted trace+receipt only, never an HTML capture
  // companion or per-sample evidence left by a renderer before the failure became known.
  await Promise.all([
    rm(join(input.publication.stagingPath, "browser-capture-html"), { recursive: true, force: true }),
    rm(join(input.publication.stagingPath, ".browser-capture-samples"), { recursive: true, force: true })
  ]);
  if (input.trace && input.workflowTracePath) await writeFile(join(input.publication.stagingPath, plan.traceRelativePath), `${JSON.stringify(input.trace, null, 2)}\n`, "utf8");
  await writeFile(join(input.publication.stagingPath, plan.receiptRelativePath), `${JSON.stringify(plan.receipt, null, 2)}\n`, "utf8");
  try {
    await publishGovernedDirectoryBundle(input.publication, plan.inventory);
  } catch (error) {
    if (!(error instanceof DirectoryBundleCommitUncertainError)) throw error;
    return {
      ok: false, command: "capture-browser", lane: "browser",
      captureCommitUncertain: true,
      possiblyCommitted: true,
      publicationCommitPhase: "output",
      publicPaths: [error.outputPath],
      expectedPublications: [error.expectedPublication],
      outputPath: input.publication.outputPath,
      receiptId: plan.receipt.id,
      receiptPath: plan.receiptPath,
      artifacts: plan.artifacts,
      warnings: plan.receipt.warnings,
      error: { code: error.code, message: error.message },
      captureFailure: input.error
    };
  }
  return {
    ok: false, command: "capture-browser", lane: "browser",
    ...(input.workflowPath ? { workflowPath: input.workflowPath } : {}),
    ...(input.workflowTracePath ? { workflowTracePath: input.workflowTracePath } : {}),
    ...(input.trace ? { workflowTrace: input.trace } : {}),
    ...(input.workflowCatalogPath ? { workflowCatalogPath: input.workflowCatalogPath } : {}),
    ...(input.workflowDrift ? { workflowDrift: input.workflowDrift } : {}),
    receiptId: plan.receipt.id, receiptPath: plan.receiptPath, artifacts: plan.artifacts, warnings: plan.receipt.warnings, error: input.error
  };
}

/**
 * The failure-bundle manifest is pure so replay and drift callers can prove that no successful
 * renderer evidence is accepted after the capture switches to a failed outcome. Filesystem
 * cleanup above is still required: an exact directory inventory then refuses any leftover leaf.
 */
export function redactedBrowserCaptureFailureBundle(input: Pick<
  BrowserCaptureFailureBundleInput,
  "publication" | "pkg" | "trace" | "workflowTracePath" | "receipt"
>): {
  receipt: OperationReceipt;
  receiptPath: string;
  traceRelativePath: string;
  receiptRelativePath: string;
  inventory: string[];
  artifacts: ReceiptArtifact[];
} {
  const outputDir = input.publication.outputPath;
  const traceRelativePath = `${input.pkg.manifest.id}-browser-workflow.trace.json`;
  const receiptRelativePath = `${input.pkg.manifest.id}-browser-capture.receipt.json`;
  const receiptPath = join(outputDir, receiptRelativePath);
  const artifacts: ReceiptArtifact[] = [
    ...(input.trace && input.workflowTracePath ? [{ role: "browser_workflow_trace" as const, path: input.workflowTracePath, status: "failed" as const, mediaType: "application/json" }] : []),
    { role: "preview_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const sourceOutput = input.receipt.output;
  const output = sourceOutput && typeof sourceOutput === "object" && !Array.isArray(sourceOutput)
    ? Object.fromEntries(Object.entries(sourceOutput).filter(([key]) => key === "workflowTracePath" || key === "workflowTrace" || key === "workflowDrift"))
    : {};
  const receipt: OperationReceipt = {
    ...input.receipt,
    inputHashes: Object.fromEntries(Object.entries(input.receipt.inputHashes).filter(([key]) => key !== "browser-capture-html" && !key.startsWith("capture-artifact:"))),
    output,
    artifacts
  };
  return {
    receipt,
    receiptPath,
    traceRelativePath,
    receiptRelativePath,
    inventory: [...(input.trace && input.workflowTracePath ? [traceRelativePath] : []), receiptRelativePath],
    artifacts
  };
}

export async function writeBrowserRecordingManifest(input: {
  pkg: MotionPackage;
  renderer: BrowserFrameRenderer;
  workflow?: BrowserCaptureWorkflow;
  framesDir: string;
  publicFramesDir: string;
  manifestPath: string;
  sampleCount: number;
  primaryCapture: Awaited<ReturnType<BrowserFrameRenderer>>;
  privateArtifactPublication?: DerivedOutputPublication;
  workflowTracePath?: string;
  signal?: AbortSignal;
}): Promise<BrowserRecordingManifest> {
  return (await captureBrowserRecording(input)).manifest;
}

/** Render each recording sample in a unique private evidence root before moving its primary PNG into the manifest frame leaf. */
export async function captureBrowserRecording(input: {
  pkg: MotionPackage;
  renderer: BrowserFrameRenderer;
  workflow?: BrowserCaptureWorkflow;
  framesDir: string;
  publicFramesDir: string;
  manifestPath: string;
  sampleCount: number;
  primaryCapture: Awaited<ReturnType<BrowserFrameRenderer>>;
  privateArtifactPublication?: DerivedOutputPublication;
  workflowTracePath?: string;
  signal?: AbortSignal;
}): Promise<BrowserRecordingCapture> {
  await mkdir(input.framesDir, { recursive: true, mode: 0o700 });
  const sampleTimes = browserRecordingSampleTimes({ durationMs: input.pkg.motion.durationMs, sampleCount: input.sampleCount });
  const frames: BrowserRecordingManifestFrame[] = [];
  const rendererArtifacts: ReceiptArtifact[] = [];
  for (const [index, atMs] of sampleTimes.entries()) {
    throwIfCancelled(input.signal, "browser capture recording sample");
    const fileName = `${String(index).padStart(6, "0")}.png`;
    const evidenceRoot = join(input.framesDir, ".browser-capture-samples", String(index).padStart(6, "0"));
    const stagedOutputPath = join(evidenceRoot, "frame.png");
    // This root is intentionally created before either an injected or production renderer sees
    // it. Renderer companions inherit one private evidence boundary instead of creating their
    // own first parent under a caller-visible recording tree.
    const evidenceRootReservation = await OutputDirectoryReservation.acquire(evidenceRoot, {
      requireAbsent: true,
      requirePrivate: true
    });
    await evidenceRootReservation.assertCurrent();
    const frame = await input.renderer(input.pkg, input.privateArtifactPublication
      ? withRendererPrivateOutputPublication({
      atMs,
      outDir: evidenceRoot,
      outputPath: stagedOutputPath,
      ...(input.workflow ? { workflow: input.workflow } : {})
      }, input.privateArtifactPublication)
      : {
        atMs,
        outDir: evidenceRoot,
        outputPath: stagedOutputPath,
        ...(input.workflow ? { workflow: input.workflow } : {})
      });
    await evidenceRootReservation.assertCurrent();
    await assertCaptureBundleOutput(frame.output.path, stagedOutputPath, "recording frame");
    const outputPath = join(input.framesDir, fileName);
    await rename(stagedOutputPath, outputPath);
    await assertCaptureBundleOutput(outputPath, outputPath, "recording frame after private evidence remap");
    rendererArtifacts.push(...rendererAvailableArtifacts(frame));
    frames.push({ index, atMs: frame.output.atMs, path: join(input.publicFramesDir, fileName), sha256: await hashFile(outputPath), width: frame.output.width, height: frame.output.height, format: frame.output.format ?? "png" });
  }
  const workflowHash = typeof input.primaryCapture.output.workflowTrace?.workflowHash === "string"
    ? input.primaryCapture.output.workflowTrace.workflowHash
    : typeof input.primaryCapture.receipt.inputHashes.workflow === "string" ? input.primaryCapture.receipt.inputHashes.workflow : undefined;
  const workflow = workflowHash || input.workflowTracePath ? { ...(workflowHash ? { hash: workflowHash } : {}), ...(input.workflowTracePath ? { tracePath: input.workflowTracePath } : {}) } : undefined;
  const manifest = buildBrowserRecordingManifest({
    packageId: input.pkg.manifest.id, motionId: input.pkg.motion.id, width: input.pkg.motion.width, height: input.pkg.motion.height,
    durationMs: input.pkg.motion.durationMs, fps: input.pkg.motion.fps, frames, browser: input.primaryCapture.output.browser, viewport: input.primaryCapture.output.viewport,
    deterministic: { network: input.workflow?.networkPolicy ?? "blocked-unless-declared", animations: "disabled", caret: "hide", deviceScaleFactor: input.primaryCapture.output.viewport.deviceScaleFactor },
    ...(workflow ? { workflow } : {})
  });
  throwIfCancelled(input.signal, "browser capture recording manifest");
  await writeFile(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, rendererArtifacts: dedupeRendererArtifacts(rendererArtifacts) };
}

/** Close browser state before a capture bundle becomes public. A close error is a pre-publication failure. */
export async function publishAfterBrowserCaptureSessionClose<T>(close: () => Promise<void>, publish: () => Promise<T>): Promise<T> {
  await close();
  return await publish();
}

function rendererAvailableArtifacts(frame: Awaited<ReturnType<BrowserFrameRenderer>>): ReceiptArtifact[] {
  const artifacts = [...(frame.output.artifacts ?? []), ...(frame.receipt.artifacts ?? [])];
  if (artifacts.some((artifact) => artifact.status !== "available")) {
    throw new Error("Browser recording renderer returned a non-available companion artifact for a successful sample.");
  }
  return artifacts;
}

function dedupeRendererArtifacts(artifacts: readonly ReceiptArtifact[]): ReceiptArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.role}\0${resolve(artifact.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function replayFailureReceipt(input: { pkg: MotionPackage; trace: { workflowHash: string }; message: string }): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: `browser-workflow-failed-${canonicalJsonSha256(input.trace).slice(0, 16)}`,
    operation: "browser.workflow.capture", status: "failed", packageId: input.pkg.manifest.id,
    inputHashes: { motion: canonicalJsonSha256(input.pkg.motion), workflow: input.trace.workflowHash },
    createdAt: new Date().toISOString(), lane: "browser", output: {}, artifacts: [], warnings: [input.message]
  };
}
