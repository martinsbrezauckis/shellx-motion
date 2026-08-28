/** C6C B7: one exact-schedule private GPU PNG from one active resolved retained trace. */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { acquireDerivedOutputPublication, canonicalJson, canonicalJsonSha256, isPublicationCommitUncertain } from "@shellx-motion/core";
import { verifyCheckpointStoryboardRetainedTracePreviewEvidence, type CheckpointStoryboardRetainedTracePreviewEvidence } from "@shellx-motion/renderer-browser/internal/checkpoint-storyboard-retained-trace-preview";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import {
  lineageRetainedTracePreviewsDirectory,
  withCheckpointStoryboardRetainedTracePreviewPublicationAuthority,
} from "./checkpoint-storyboard-retained-trace-preview-store.js";
import {
  preflightCheckpointStoryboardRetainedTracePreviewAttempt,
  publishCheckpointStoryboardRetainedTracePreviewPreparing,
  reconcileCheckpointStoryboardRetainedTracePreviewUncertainty,
  replaceCheckpointStoryboardRetainedTracePreviewState,
  retainedTracePreviewHandles,
  retainedTracePreviewOutputNames,
} from "./checkpoint-storyboard-retained-trace-preview-state.js";
import {
  withCheckpointStoryboardRetainedTracePreviewAuthority,
  type CheckpointStoryboardRetainedTracePreviewAuthority,
  type CheckpointStoryboardRetainedTracePreviewRendererResult,
} from "./checkpoint-storyboard-retained-trace-preview-authority.js";
import { withCheckpointStoryboardRetainedTraceActivePreviewInput } from "./checkpoint-storyboard-retained-trace-resolution.js";
import type { CheckpointStoryboardRetainedTracePreviewInput } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-output-private.js";
import {
  CheckpointStoryboardRecordStoreError,
  storeError,
  type CheckpointStoryboardRecordIdentity,
} from "./checkpoint-storyboard-record-store-types.js";
import {
  MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES,
  MAX_RETAINED_TRACE_PREVIEW_RECEIPT_BYTES,
  readPrivateRetainedTracePreviewEvidence,
  retainedTracePreviewPngDimensions,
} from "./checkpoint-storyboard-retained-trace-preview-evidence.js";

export interface CheckpointStoryboardRetainedTracePreviewResult {
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly previewHandle: string;
  readonly receiptHandle: string;
  readonly atUs: number;
  readonly output: Readonly<{ sha256: string; width: number; height: number; format: "png"; background: "transparent-rgba@1" }>;
  readonly gpu: Readonly<{ runtimeEvidence: "host-gpu" | "source-test"; evidenceFingerprint: string; cleanupFingerprint: string }>;
  readonly evidence: Readonly<{
    bindingId: string;
    materializationReceiptFingerprint: string;
    sidecarRawSha256: string;
    sidecarCanonicalSha256: string;
    planFingerprint: string;
    profileFingerprint: string;
    tracePlanFingerprint: string;
    scheduleSha256: string;
  }>;
}

export async function previewCheckpointStoryboardRetainedTraceStoredRecord(
  authority: CheckpointStoryboardRetainedTracePreviewAuthority,
  identity: CheckpointStoryboardRecordIdentity,
  atUs: number,
  executionSignal?: AbortSignal,
): Promise<CheckpointStoryboardRetainedTracePreviewResult> {
  let failurePhase = "authority-preflight";
  try {
    return await withCheckpointStoryboardRetainedTracePreviewAuthority(authority, async (preview) =>
      await withCheckpointStoryboardRetainedTraceActivePreviewInput(preview.resolution, identity, async (active) => {
        assertExactSchedulePoint(active.input.plan.projection.trace.schedule, atUs);
        if (executionSignal?.aborted) throw cancelled("before private preview preparation");
        failurePhase = "initial-binding-revalidation";
        await active.revalidate();
        await preflightCheckpointStoryboardRetainedTracePreviewAttempt(active.store, active.root);
        return await withCheckpointStoryboardRetainedTracePreviewPublicationAuthority(active.store, async () => {
          const previewId = `checkpoint_storyboard_retained_trace_preview_${randomBytes(16).toString("hex")}`;
          let state = await publishCheckpointStoryboardRetainedTracePreviewPreparing(active.store, {
            id: previewId,
            identity,
            root: active.root,
            binding: Object.freeze({ id: active.binding.id, sha256: active.binding.sha256 }),
            atUs,
            runtimeEvidence: preview.runtimeEvidence,
          });
          const directory = await lineageRetainedTracePreviewsDirectory(active.store, active.root.id);
          const names = retainedTracePreviewOutputNames(previewId);
          let receiptPublication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
          let pngPublication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
          let renderStarted = false;
          let receiptPublicationAttempted = false;
          let pngPublicationAttempted = false;
          try {
            receiptPublication = await acquireDerivedOutputPublication({ outputPath: join(directory.path, names.receipt), kind: "file" });
            pngPublication = await acquireDerivedOutputPublication({ outputPath: join(directory.path, names.png), kind: "file" });
            if (!pngPublication) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview did not reserve its private PNG publication.");
            const reservedPngPublication = pngPublication;
            if (executionSignal?.aborted) throw cancelled("before GPU execution");
            failurePhase = "post-reservation-binding-revalidation";
            await active.revalidate();
            renderStarted = true;
            failurePhase = "renderer-execution";
            let rendered: CheckpointStoryboardRetainedTracePreviewRendererResult;
            try {
              rendered = await preview.render(active.input.package, withRendererPrivateOutputPublication({
                retainedTracePlan: active.input.plan,
                atUs,
                ...(executionSignal ? { signal: executionSignal } : {}),
              }, reservedPngPublication));
            } catch (error) {
              throw storeError("preview_publication_uncertain", `Checkpoint storyboard retained-trace renderer threw before returning bounded evidence (${safeThrownCode(error)}).`);
            }
            if (!rendered.ok) throw rendererFailure(rendered);
            failurePhase = "renderer-evidence";
            const rendererEvidence = verifyRendererEvidence(rendered.evidence);
            assertRendererEvidence(rendered, rendererEvidence, active.input, atUs);
            failurePhase = "post-render-binding-revalidation";
            await active.revalidate();
            if (executionSignal?.aborted) throw cancelled("before private receipt publication");
            failurePhase = "staged-png-reopen";
            const png = await pngPublication.verifyFile();
            const stablePng = await readStagedPng(pngPublication);
            const pngDimensions = readPngDimensions(stablePng.bytes, "staged");
            if (stablePng.sha256 !== png.sha256 || stablePng.byteLength !== png.byteLength) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace staged PNG changed during exact validation.");
            assertRendererOutput(rendered, png, pngDimensions, active.input.package.motion.width, active.input.package.motion.height, atUs);
            const pngEvidence = Object.freeze({ sha256: png.sha256, byteLength: png.byteLength, width: rendered.output.width, height: rendered.output.height });
            failurePhase = "private-receipt-write";
            const receiptBytes = Buffer.from(`${canonicalJson(privateReceipt({ previewId, identity, root: active.root, binding: active.binding, input: active.input, atUs, runtimeEvidence: preview.runtimeEvidence, rendered, png: pngEvidence }))}\n`, "utf8");
            const receipt = await receiptPublication.writePrivateFile(receiptBytes, { label: "Checkpoint storyboard retained-trace GPU preview receipt", maxBytes: MAX_RETAINED_TRACE_PREVIEW_RECEIPT_BYTES });
            failurePhase = "pre-publication-binding-revalidation";
            await active.revalidate();
            failurePhase = "receipt-publication";
            receiptPublicationAttempted = true;
            await receiptPublication.publishFile(receipt, { retainReservation: true });
            await receiptPublication.verifyPublishedFile(receipt);
            state = await replaceCheckpointStoryboardRetainedTracePreviewState(active.store, state, "receipt-published", { receipt });
            if (executionSignal?.aborted) {
              try {
                await receiptPublication.revokePublishedFile(receipt);
                await pngPublication.abort();
                state = await replaceCheckpointStoryboardRetainedTracePreviewState(active.store, state, "receipt-revoked");
              } catch {
                await reconcileCheckpointStoryboardRetainedTracePreviewUncertainty(active.store, state);
                throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace cancelled preview could not revoke receipt-only evidence exactly.");
              }
              throw cancelled("before PNG publication");
            }
            await active.revalidate();
            pngPublicationAttempted = true;
            failurePhase = "png-publication";
            await pngPublication.publishFile(png);
            failurePhase = "published-png-reopen";
            const publishedPng = await readPublishedPng(join(directory.path, names.png), active.store);
            const publishedDimensions = readPngDimensions(publishedPng.bytes, "published");
            if (publishedPng.sha256 !== png.sha256 || publishedPng.byteLength !== png.byteLength || publishedDimensions.width !== pngDimensions.width || publishedDimensions.height !== pngDimensions.height) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace published PNG did not reopen exactly before completion.");
            state = await replaceCheckpointStoryboardRetainedTracePreviewState(active.store, state, "complete", { png: pngEvidence });
            await receiptPublication.abort();
            return publicResult(active.store, state, active.binding, active.input, rendered);
          } catch (error) {
            if (!renderStarted && state.phase === "preparing") {
              await Promise.allSettled([receiptPublication?.abort(), pngPublication?.abort()].filter(Boolean) as Promise<unknown>[]);
              try { await replaceCheckpointStoryboardRetainedTracePreviewState(active.store, state, "abandoned"); }
              catch { throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview could not establish private pre-render cleanup."); }
            } else if (error instanceof CheckpointStoryboardRecordStoreError && error.code === "preview_cancelled" && state.phase === "receipt-revoked") {
              throw error;
            } else if (renderStarted && !receiptPublicationAttempted && !pngPublicationAttempted && state.phase === "preparing") {
              await Promise.allSettled([receiptPublication?.abort(), pngPublication?.abort()].filter(Boolean) as Promise<unknown>[]);
              try { await replaceCheckpointStoryboardRetainedTracePreviewState(active.store, state, "abandoned"); }
              catch { await reconcileCheckpointStoryboardRetainedTracePreviewUncertainty(active.store, state); }
            } else {
              try { await reconcileCheckpointStoryboardRetainedTracePreviewUncertainty(active.store, state); }
              catch { /* Existing signed state remains the conservative recovery authority. */ }
              await Promise.allSettled([receiptPublication?.abort(), pngPublication?.abort()].filter(Boolean) as Promise<unknown>[]);
            }
            throw error;
          }
        });
      }),
    );
  } catch (error) {
    if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
    if (isPublicationCommitUncertain(error)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview publication may have committed private evidence; it was retained for reconciliation.");
    throw storeError("preview_publication_uncertain", `Checkpoint storyboard retained-trace GPU preview did not complete exact private evidence publication during ${failurePhase}.`);
  }
}

function assertExactSchedulePoint(schedule: readonly number[], atUs: number): void {
  if (!Number.isSafeInteger(atUs) || atUs < 0 || !schedule.includes(atUs)) {
    throw storeError("preview_target_invalid", "Checkpoint storyboard retained-trace preview atUs must be one exact safe integer in the sealed C4C schedule.");
  }
}

function assertRendererOutput(
  rendered: Extract<CheckpointStoryboardRetainedTracePreviewRendererResult, { ok: true }>,
  png: { readonly sha256: string; readonly byteLength: number },
  pngDimensions: { readonly width: number; readonly height: number },
  width: number,
  height: number,
  atUs: number,
): void {
  if (rendered.output.sha256 !== png.sha256
    || rendered.output.byteLength !== png.byteLength
    || rendered.output.width !== width
    || rendered.output.height !== height
    || pngDimensions.width !== width
    || pngDimensions.height !== height
    || rendered.output.atUs !== atUs
    || rendered.output.background !== "transparent-rgba@1"
    || png.byteLength < 1) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace renderer output did not match its exact private staging file.");
  }
}

function assertRendererEvidence(
  rendered: Extract<CheckpointStoryboardRetainedTracePreviewRendererResult, { ok: true }>,
  evidence: CheckpointStoryboardRetainedTracePreviewEvidence,
  input: CheckpointStoryboardRetainedTracePreviewInput,
  atUs: number,
): void {
  const cleanup = rendered.cleanup;
  const cleanupPayload = { closed: cleanup.closed, traceBuffers: cleanup.traceBuffers, runtimeResources: cleanup.runtimeResources };
  if (cleanup.closed !== true
    || cleanup.traceBuffers.sampleBufferDestroyed !== true
    || cleanup.traceBuffers.rasterControlBufferDestroyed !== true
    || cleanup.traceBuffers.targetDestroyed !== true
    || cleanup.traceBuffers.readbackBufferDestroyed !== true
    || cleanup.fingerprint !== canonicalJsonSha256(cleanupPayload)
    || evidence.retainedTracePlanFingerprint !== input.plan.fingerprint
    || evidence.atUs !== atUs
    || evidence.outputSha256 !== rendered.output.sha256
    || evidence.outputByteLength !== rendered.output.byteLength
    || evidence.background !== rendered.output.background
    || evidence.cleanupFingerprint !== cleanup.fingerprint) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace renderer evidence did not bind the active plan, exact time, staged PNG, and terminal cleanup.");
  }
}

function verifyRendererEvidence(value: unknown): CheckpointStoryboardRetainedTracePreviewEvidence {
  try { return verifyCheckpointStoryboardRetainedTracePreviewEvidence(value); }
  catch { throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace renderer evidence failed its exact self-verification."); }
}

async function readStagedPng(publication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>>) {
  try { return await publication.readPrivateFile({ label: "Checkpoint storyboard retained-trace staged preview PNG", maxBytes: MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES }); }
  catch { throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace staged PNG could not be reopened as one bounded private file."); }
}

async function readPublishedPng(path: string, store: Parameters<typeof readPrivateRetainedTracePreviewEvidence>[1]) {
  try { return await readPrivateRetainedTracePreviewEvidence(path, store, MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES, "Checkpoint storyboard retained-trace published preview PNG"); }
  catch { throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace published PNG could not be reopened as one bounded private file."); }
}

function readPngDimensions(bytes: Buffer, phase: "staged" | "published") {
  try { return retainedTracePreviewPngDimensions(bytes); }
  catch { throw storeError("preview_publication_uncertain", `Checkpoint storyboard retained-trace ${phase} PNG failed its exact RGBA framing validation.`); }
}

function privateReceipt(input: {
  readonly previewId: string;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly binding: { readonly id: string; readonly sha256: string; readonly outputHandle: string; readonly receiptFingerprint: string };
  readonly input: CheckpointStoryboardRetainedTracePreviewInput;
  readonly atUs: number;
  readonly runtimeEvidence: "host-gpu" | "source-test";
  readonly rendered: Extract<CheckpointStoryboardRetainedTracePreviewRendererResult, { ok: true }>;
  readonly png: { readonly sha256: string; readonly byteLength: number; readonly width: number; readonly height: number };
}) {
  const plan = input.input.plan;
  return Object.freeze({
    schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-receipt@1" as const,
    previewId: input.previewId,
    identity: input.identity,
    root: input.root,
    binding: Object.freeze({ id: input.binding.id, sha256: input.binding.sha256, outputHandle: input.binding.outputHandle }),
    materialization: Object.freeze({ receiptFingerprint: input.binding.receiptFingerprint, installed: input.input.installed }),
    plan: Object.freeze({
      fingerprint: plan.fingerprint,
      profileFingerprint: plan.lowererProfile.fingerprint,
      storyboard: plan.storyboard,
      layer: plan.objectLayerBinding,
      traceSourceSha256: plan.projection.trace.sourceSha256,
      tracePlanFingerprint: plan.projection.trace.fingerprint,
      scheduleSha256: plan.projection.trace.evidence.scheduleSha256,
    }),
    atUs: input.atUs,
    runtimeEvidence: input.runtimeEvidence,
    png: input.png,
    renderer: Object.freeze({
      background: input.rendered.output.background,
      gpu: input.rendered.gpu,
      resources: input.rendered.resources,
      cleanup: input.rendered.cleanup,
      evidence: input.rendered.evidence,
    }),
  });
}

function publicResult(
  store: Parameters<typeof retainedTracePreviewHandles>[0],
  state: Parameters<typeof retainedTracePreviewHandles>[1],
  binding: { readonly id: string; readonly receiptFingerprint: string },
  input: CheckpointStoryboardRetainedTracePreviewInput,
  rendered: Extract<CheckpointStoryboardRetainedTracePreviewRendererResult, { ok: true }>,
): CheckpointStoryboardRetainedTracePreviewResult {
  if (state.phase !== "complete" || !state.png || !state.receipt) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview did not reach a complete paired state.");
  const handles = retainedTracePreviewHandles(store, state);
  const plan = input.plan;
  return Object.freeze({
    identity: state.identity,
    previewHandle: handles.preview,
    receiptHandle: handles.receipt,
    atUs: state.atUs,
    output: Object.freeze({ sha256: state.png.sha256, width: state.png.width, height: state.png.height, format: "png" as const, background: rendered.output.background }),
    gpu: Object.freeze({ runtimeEvidence: state.runtimeEvidence, evidenceFingerprint: rendered.evidence.fingerprint, cleanupFingerprint: rendered.cleanup.fingerprint }),
    evidence: Object.freeze({
      bindingId: binding.id,
      materializationReceiptFingerprint: binding.receiptFingerprint,
      sidecarRawSha256: input.installed.sidecar.rawSha256,
      sidecarCanonicalSha256: input.installed.sidecar.canonicalSha256,
      planFingerprint: plan.fingerprint,
      profileFingerprint: plan.lowererProfile.fingerprint,
      tracePlanFingerprint: plan.projection.trace.fingerprint,
      scheduleSha256: plan.projection.trace.evidence.scheduleSha256,
    }),
  });
}

function rendererFailure(result: Extract<CheckpointStoryboardRetainedTracePreviewRendererResult, { ok: false }>): CheckpointStoryboardRecordStoreError {
  if (result.error.code === "gpu_cancelled") return cancelled("during GPU execution");
  return storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace GPU executor refused or failed before private publication.");
}

function cancelled(phase: string): CheckpointStoryboardRecordStoreError {
  return storeError("preview_cancelled", `Checkpoint storyboard retained-trace preview was cancelled ${phase}.`);
}
function safeThrownCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "unknown";
}
