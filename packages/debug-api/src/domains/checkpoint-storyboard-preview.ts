/** C6C B1b: one host-owned Browser frame from a sealed B1a/C6B output binding. */
import { randomBytes, createHmac } from "node:crypto";
import { join } from "node:path";
import {
  BoundedResourceBudget,
  compareCodeUnits,
  DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS,
  acquireDerivedOutputPublication,
  canonicalJson,
  hashBuffer,
  isPublicationCommitUncertain,
  loadMotionPackageFromAdmittedFiles,
  readBudgetedStableFile,
} from "@shellx-motion/core";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import { withCheckpointStoryboardTerminalBoundaryMode, type CheckpointStoryboardTerminalBoundaryEvidence } from "@shellx-motion/renderer-browser/internal/checkpoint-storyboard-terminal-boundary";
import { withCheckpointStoryboardMaterializationOutputAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { verifyCheckpointStoryboardStoredBindingUnlocked } from "./checkpoint-storyboard-materialization.js";
import { readMaterializationBinding, readMaterializationBindingState } from "./checkpoint-storyboard-materialization-bindings.js";
import { lineagePreviewsDirectory, checkedAuthority, withCheckpointStoryboardPreviewPublicationAuthority, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "./package-edit-tree-snapshot.js";
import { C6B1B_RECEIPT_PATH, type CheckpointStoryboardScalarSpatialMaterializationReceipt } from "./checkpoint-storyboard-scalar-spatial-materialize-receipt-private.js";
import {
  preflightCheckpointStoryboardPreviewAttempt,
  previewOutputNames,
  publishPreviewPreparing,
  reconcilePreviewUncertainty,
  replacePreviewState,
  type CheckpointStoryboardPreviewSampling,
  type CheckpointStoryboardPreviewTarget,
} from "./checkpoint-storyboard-preview-state.js";
import { invokeCheckpointStoryboardPreviewFaultHookForTest, withCheckpointStoryboardPreviewAuthority, type CheckpointStoryboardPreviewAuthority } from "./checkpoint-storyboard-preview-authority.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardMaterializationBindingFile } from "./checkpoint-storyboard-record-store-types.js";
import { assertSamplingFrameEvidence, normalizedTerminalBackground, previewSampling } from "./checkpoint-storyboard-preview-sampling.js";

export type CheckpointStoryboardPreviewRequestTarget =
  | Readonly<{ kind: "checkpoint"; checkpointId: string }>
  | Readonly<{ kind: "time"; atMs: number }>;

export type CheckpointStoryboardPreviewResult = Readonly<{
  identity: CheckpointStoryboardRecordIdentity;
  previewHandle: string;
  receiptHandle: string;
  target: CheckpointStoryboardPreviewTarget;
  resolvedAtMs: number;
  sampling: CheckpointStoryboardPreviewSampling;
  output: Readonly<{ sha256: string; width: number; height: number; format: "png" }>;
  browser: Readonly<{
    runtimeEvidence: "host-browser" | "source-test";
    engine: "browser";
    session: Readonly<{ browserLaunches: number; framesRendered: number; frameRetries: number }>;
    network: Readonly<{ policy: "no-approved-origins"; approvedOrigins: 0; allowPrivateNetwork: false }>;
  }>;
  evidence: Readonly<{ snapshotSha256: string; bindingId: string; receiptFingerprint: string }>;
}>;

/** The only B1b execution route: no package/output/network/workflow fields are accepted here. */
export async function previewCheckpointStoryboardStoredRecord(
  authority: CheckpointStoryboardPreviewAuthority,
  identity: CheckpointStoryboardRecordIdentity,
  requestedTarget: CheckpointStoryboardPreviewRequestTarget,
  executionSignal?: AbortSignal,
): Promise<CheckpointStoryboardPreviewResult> {
  try {
    return await withCheckpointStoryboardPreviewAuthority(authority, async (preview) => {
      // Validate the B1a output authority first, but do not keep its workspace-anchor execution
      // context around Core's separate host-private evidence directory.
      await withCheckpointStoryboardMaterializationOutputAuthority(preview.materialization, async () => undefined);
      const store = checkedAuthority(preview.store);
        const root = await readImmutableRecordRoot(store, identity);
        return await withLineageLock(store, root.id, async () => {
          // This is intentionally the one root lock. All operations below use unlocked state
          // readers, the output-only B1a authority, and the exact C6B reopen primitive.
          const record = await readStoredRecordUnlocked(store, identity);
          assertPreviewableRecord(record);
          const state = await readMaterializationBindingState(store, identity, root);
          if (state.state !== "bound" || state.active !== 1 || !state.bindingId) {
            throw storeError("preview_binding_not_active", "Checkpoint storyboard Browser preview requires one active sealed materialization binding.");
          }
          const binding = await readMaterializationBinding(store, identity);
          if (!binding || binding.id !== state.bindingId || !sameIdentity(binding.root, root)) {
            throw storeError("preview_binding_not_active", "Checkpoint storyboard Browser preview binding no longer matches the active state.");
          }
          const opened = await withCheckpointStoryboardMaterializationOutputAuthority(preview.materialization, async (current) => {
            const c6bHost = {
              sourcePackageRoot: current.sourcePackageRoot,
              outputPackageRoot: current.outputPackageRoot,
              packageWorkspaceRoot: current.packageWorkspaceRoot,
              packageWorkspaceAuthority: current.packageWorkspaceAuthority,
            };
            const verifiedReceipt = await verifyCheckpointStoryboardStoredBindingUnlocked(c6bHost, binding);
            return Object.freeze({ verifiedReceipt, admitted: await admittedVerifiedOutput(c6bHost.outputPackageRoot, verifiedReceipt, binding.id) });
          });
          const { verifiedReceipt, admitted } = opened;
          const target = resolvePreviewTarget(record.storyboard.checkpoints, admitted.pkg.motion.durationMs, requestedTarget);
          const sampling = previewSampling(target, admitted.pkg.motion.durationMs);
          if (executionSignal?.aborted) throw storeError("preview_cancelled", "Checkpoint storyboard Browser preview was cancelled before private preview preparation.");
          // Do not create a preview journal or reservation for a malformed/end-exclusive target.
          await preflightCheckpointStoryboardPreviewAttempt(store, root);
          return await withCheckpointStoryboardPreviewPublicationAuthority(store, async () => {
            const previewId = `checkpoint_storyboard_preview_${randomBytes(16).toString("hex")}`;
            let previewState = await publishPreviewPreparing(store, {
            id: previewId,
            identity,
            root,
            binding: Object.freeze({ id: binding.id, sha256: binding.sha256 }),
            target,
            sampling,
            runtimeEvidence: preview.runtimeEvidence,
            });
            await invokeCheckpointStoryboardPreviewFaultHookForTest(authority, "afterPreparing");
            const directory = await lineagePreviewsDirectory(store, root.id);
            const names = previewOutputNames(previewId);
            let receiptPublication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
            let pngPublication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
            let session: Awaited<ReturnType<typeof preview.createSession>> | undefined;
            let renderStarted = false;
            let receiptPublicationAttempted = false;
            let pngPublicationAttempted = false;
            try {
            receiptPublication = await acquireDerivedOutputPublication({ outputPath: join(directory.path, names.receipt), kind: "file" });
            pngPublication = await acquireDerivedOutputPublication({ outputPath: join(directory.path, names.png), kind: "file" });
            if (executionSignal?.aborted) throw storeError("preview_cancelled", "Checkpoint storyboard Browser preview was cancelled before Browser execution.");
            session = await preview.createSession(admitted.pkg, sampling.mode === "terminal-boundary"
              ? withCheckpointStoryboardTerminalBoundaryMode({})
              : { networkAccess: {} });
            renderStarted = true;
            const [frame] = await session.renderFrames([
              withRendererPrivateOutputPublication({ atMs: target.resolvedAtMs, outDir: directory.path, outputPath: pngPublication.stagingPath, format: "png" as const }, pngPublication),
            ], { signal: executionSignal, maxConcurrency: 1, maxFrameAttempts: 1 });
            if (!frame) throw new Error("Browser preview did not return its singleton frame.");
            await session.close(); session = undefined;
            if (executionSignal?.aborted) throw storeError("preview_cancelled", "Checkpoint storyboard Browser preview was cancelled before private publication.");
            const terminalBoundary = assertSamplingFrameEvidence(
              frame.output,
              sampling,
              admitted.pkg.motion.width,
              admitted.pkg.motion.height,
              sampling.mode === "terminal-boundary" ? normalizedTerminalBackground(admitted.pkg.motion.background) : undefined,
            );
            if (sampling.mode === "interior" && preview.runtimeEvidence === "host-browser" && (!frame.output.network || frame.output.network.approvedOrigins.length !== 0 || frame.output.network.allowPrivateNetwork !== false)) {
              throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview did not retain the required no-approved-origins network evidence.");
            }
            await withCheckpointStoryboardMaterializationOutputAuthority(preview.materialization, async (current) => await revalidateBoundOutput(store, root, identity, binding, {
              sourcePackageRoot: current.sourcePackageRoot,
              outputPackageRoot: current.outputPackageRoot,
              packageWorkspaceRoot: current.packageWorkspaceRoot,
              packageWorkspaceAuthority: current.packageWorkspaceAuthority,
            }));
            const png = await pngPublication.verifyFile();
            if (png.sha256 !== frame.output.sha256 || png.byteLength <= 0 || frame.output.format !== "png" || frame.output.atMs !== target.resolvedAtMs || frame.output.width !== admitted.pkg.motion.width || frame.output.height !== admitted.pkg.motion.height || !Number.isSafeInteger(frame.output.width) || frame.output.width < 1 || !Number.isSafeInteger(frame.output.height) || frame.output.height < 1) {
              throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview PNG could not be verified exactly.");
            }
            const pngEvidence = Object.freeze({ sha256: png.sha256, byteLength: png.byteLength, width: frame.output.width, height: frame.output.height });
            const receiptBytes = Buffer.from(canonicalJson(privateReceipt({ previewId, identity, root, binding, target, sampling, runtimeEvidence: preview.runtimeEvidence, png: pngEvidence, frame, terminalBoundary, snapshotSha256: admitted.snapshotSha256 })), "utf8");
            const receipt = await receiptPublication.writePrivateFile(receiptBytes, { label: "Checkpoint storyboard Browser preview receipt", maxBytes: 256 * 1024 });
            receiptPublicationAttempted = true;
            await receiptPublication.publishFile(receipt, { retainReservation: true });
            await receiptPublication.verifyPublishedFile(receipt);
            previewState = await replacePreviewState(store, previewState, "receipt-published", { receipt });
            await invokeCheckpointStoryboardPreviewFaultHookForTest(authority, "afterReceiptPublished");
            if (executionSignal?.aborted) {
              try {
                await receiptPublication.revokePublishedFile(receipt);
                await pngPublication.abort();
                previewState = await replacePreviewState(store, previewState, "receipt-revoked");
              } catch {
                await reconcilePreviewUncertainty(store, previewState);
                throw storeError("preview_publication_uncertain", "Checkpoint storyboard cancelled Browser preview could not revoke its receipt-only evidence exactly.");
              }
              throw storeError("preview_cancelled", "Checkpoint storyboard Browser preview was cancelled before PNG publication.");
            }
            pngPublicationAttempted = true;
            await pngPublication.publishFile(png);
            previewState = await replacePreviewState(store, previewState, "complete", { png: pngEvidence });
            await receiptPublication.abort();
            return publicResult(store, previewState, binding, verifiedReceipt.fingerprint, admitted.snapshotSha256, frame.output.renderSession);
            } catch (error) {
            await session?.close().catch(() => undefined);
            if (!renderStarted && previewState.phase === "preparing") {
              await Promise.allSettled([receiptPublication?.abort(), pngPublication?.abort()].filter(Boolean) as Promise<unknown>[]);
              try { await replacePreviewState(store, previewState, "abandoned"); }
              catch { throw storeError("preview_publication_uncertain", "Checkpoint storyboard cancelled Browser preview could not establish private cleanup."); }
              if (error instanceof CheckpointStoryboardRecordStoreError && error.code === "preview_cancelled") throw error;
            } else if (error instanceof CheckpointStoryboardRecordStoreError && error.code === "preview_cancelled" && previewState.phase === "receipt-revoked") {
              throw error;
            } else if (renderStarted && !receiptPublicationAttempted && !pngPublicationAttempted && previewState.phase === "preparing") {
              await Promise.allSettled([receiptPublication?.abort(), pngPublication?.abort()].filter(Boolean) as Promise<unknown>[]);
              try { await replacePreviewState(store, previewState, "abandoned"); }
              catch { await reconcilePreviewUncertainty(store, previewState); }
            } else {
              // Once Browser work began or a receipt link was attempted, an unrecognised residue is
              // preserved/refused. Never delete/retry a possible private evidence pair.
              try { await reconcilePreviewUncertainty(store, previewState); }
              catch { /* The existing preparing/receipt-published state is itself conservative. */ }
              // A Core abort removes only the transaction's staged file/reservation. It never
              // removes a final linked name, so it is safe even when either link is uncertain.
              await Promise.allSettled([receiptPublication?.abort(), pngPublication?.abort()].filter(Boolean) as Promise<unknown>[]);
            }
            throw error;
            } finally {
            await session?.close().catch(() => undefined);
            }
          });
        });
    });
  } catch (error) { throw sanitizedPreviewError(error); }
}

function assertPreviewableRecord(record: Awaited<ReturnType<typeof readStoredRecordUnlocked>>): void {
  if (record.admission.profile !== undefined) throw storeError("materialization_profile_refused", "C6C B1b preview refuses sealed non-B1 records before private journal or renderer work.");
  if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (record.target.state === "tombstoned") throw storeError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot be previewed.");
}

async function revalidateBoundOutput(
  store: ReturnType<typeof checkedAuthority>,
  root: CheckpointStoryboardRecordIdentity,
  identity: CheckpointStoryboardRecordIdentity,
  original: CheckpointStoryboardMaterializationBindingFile,
  c6bHost: Parameters<typeof verifyCheckpointStoryboardStoredBindingUnlocked>[0],
): Promise<void> {
  const record = await readStoredRecordUnlocked(store, identity);
  assertPreviewableRecord(record);
  const state = await readMaterializationBindingState(store, identity, root);
  const binding = await readMaterializationBinding(store, identity);
  if (state.state !== "bound" || state.active !== 1 || !binding || binding.id !== original.id || binding.sha256 !== original.sha256) {
    throw storeError("preview_binding_not_active", "Checkpoint storyboard Browser preview binding changed before private publication.");
  }
  await verifyCheckpointStoryboardStoredBindingUnlocked(c6bHost, binding);
}

async function admittedVerifiedOutput(outputRoot: string, receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt, bindingId: string): Promise<{ readonly pkg: ReturnType<typeof loadMotionPackageFromAdmittedFiles>; readonly snapshotSha256: string }> {
  const before = await snapshotPackageEditTree(outputRoot);
  const files = new Map<string, Readonly<{ bytes: Buffer; sha256: string }>>();
  const expected = nonReceiptInventory(before, receipt);
  const budget = new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, "Checkpoint storyboard Browser preview admitted output");
  for (const entry of expected.entries) {
    const read = await readBudgetedStableFile(join(outputRoot, entry.path), { label: "Checkpoint storyboard Browser preview output leaf", budget, withinRoot: outputRoot, requireSingleLink: true });
    if (read.sha256 !== entry.sha256 || read.byteLength !== entry.byteLength) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview output changed while being admitted.");
    files.set(entry.path, Object.freeze({ bytes: read.bytes, sha256: read.sha256 }));
  }
  const after = await snapshotPackageEditTree(outputRoot);
  if (!samePackageEditTreeSnapshot(before, after) || canonicalJson(nonReceiptInventory(after, receipt)) !== canonicalJson(expected)) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview output changed during admitted snapshot capture.");
  }
  try {
    return Object.freeze({
      pkg: loadMotionPackageFromAdmittedFiles(`/shellx-motion-c6c-admitted/${bindingId}`, files),
      snapshotSha256: expected.sha256,
    });
  } catch {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview admitted package could not be reconstructed exactly.");
  }
}

function nonReceiptInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt): Readonly<{ sha256: string; entries: readonly Readonly<{ path: string; byteLength: number; sha256: string }>[] }> {
  const entries = [...snapshot.entries]
    .filter(([path, value]) => path !== C6B1B_RECEIPT_PATH && value.startsWith("file:"))
    .map(([path, value]) => {
      const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value);
      if (!match) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview output inventory is malformed.");
      return Object.freeze({ path, byteLength: Number(match[1]), sha256: match[2]! });
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const inventory = Object.freeze({ sha256: hashBuffer(Buffer.from(entries.map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join(""), "utf8")), entries: Object.freeze(entries) });
  if (inventory.sha256 !== receipt.output.nonReceiptInventory.sha256 || entries.length !== receipt.output.nonReceiptInventory.entryCount || entries.length !== receipt.output.nonReceiptInventory.leafCount) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview output no longer matches its verified C6B inventory.");
  }
  return inventory;
}

function resolvePreviewTarget(
  checkpoints: readonly Readonly<{ id: string; atUs: number }>[],
  durationMs: number,
  target: CheckpointStoryboardPreviewRequestTarget,
): CheckpointStoryboardPreviewTarget {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw storeError("preview_target_invalid", "Checkpoint storyboard Browser preview package duration is not a safe whole millisecond.");
  if (target.kind === "checkpoint") {
    const checkpoint = checkpoints.find((candidate) => candidate.id === target.checkpointId);
    if (!checkpoint || !Number.isSafeInteger(checkpoint.atUs) || checkpoint.atUs % 1_000 !== 0) throw storeError("preview_target_invalid", "Checkpoint storyboard checkpoint preview time is not a whole millisecond.");
    const resolvedAtMs = checkpoint.atUs / 1_000;
    if (resolvedAtMs < 0 || resolvedAtMs > durationMs) throw storeError("preview_target_invalid", "Checkpoint storyboard checkpoint is outside the reopened package duration.");
    if (resolvedAtMs === durationMs && checkpoints[checkpoints.length - 1]?.id !== checkpoint.id) {
      throw storeError("preview_target_invalid", "Checkpoint storyboard terminal boundary accepts only the final sealed checkpoint.");
    }
    return Object.freeze({ kind: "checkpoint", checkpointId: checkpoint.id, resolvedAtMs });
  }
  if (!Number.isSafeInteger(target.atMs) || target.atMs < 0 || target.atMs > durationMs) throw storeError("preview_target_invalid", "Checkpoint storyboard preview time must be a safe integer within the reopened package duration.");
  return Object.freeze({ kind: "time", atMs: target.atMs, resolvedAtMs: target.atMs });
}

function privateReceipt(input: {
  previewId: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  binding: CheckpointStoryboardMaterializationBindingFile;
  target: CheckpointStoryboardPreviewTarget;
  sampling: CheckpointStoryboardPreviewSampling;
  runtimeEvidence: "host-browser" | "source-test";
  png: { sha256: string; byteLength: number; width: number; height: number };
  terminalBoundary?: CheckpointStoryboardTerminalBoundaryEvidence;
  frame: { output: { browser: { name: string; version: string }; renderSession?: { browserLaunches: number; framesRendered: number; frameRetries: number } } };
  snapshotSha256: string;
}) {
  return Object.freeze({
    schema: "shellx-motion/private-checkpoint-storyboard-preview-receipt@2" as const,
    previewId: input.previewId,
    identity: input.identity,
    root: input.root,
    binding: Object.freeze({ id: input.binding.id, sha256: input.binding.sha256 }),
    target: input.target,
    sampling: input.sampling,
    ...(input.terminalBoundary ? { terminalBoundary: input.terminalBoundary } : {}),
    runtimeEvidence: input.runtimeEvidence,
    png: Object.freeze(input.png),
    browser: Object.freeze({ engine: "browser" as const, ...(input.runtimeEvidence === "host-browser" ? { name: input.frame.output.browser.name, version: input.frame.output.browser.version } : { name: "source-test", version: "source-test" }), session: Object.freeze({ browserLaunches: input.frame.output.renderSession?.browserLaunches ?? 0, framesRendered: input.frame.output.renderSession?.framesRendered ?? 0, frameRetries: input.frame.output.renderSession?.frameRetries ?? 0 }), network: Object.freeze({ policy: "no-approved-origins" as const, approvedOrigins: 0, allowPrivateNetwork: false }) }),
    snapshot: Object.freeze({ nonReceiptInventorySha256: input.snapshotSha256 }),
  });
}

function publicResult(
  store: ReturnType<typeof checkedAuthority>,
  state: Awaited<ReturnType<typeof publishPreviewPreparing>>,
  binding: CheckpointStoryboardMaterializationBindingFile,
  receiptFingerprint: string,
  snapshotSha256: string,
  metrics: { browserLaunches: number; framesRendered: number; frameRetries: number } | undefined,
): CheckpointStoryboardPreviewResult {
  if (state.phase !== "complete" || !state.png || !state.receipt || !state.sampling) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview did not reach a verified paired state.");
  const handle = (kind: "preview" | "receipt") => `${kind === "preview" ? "checkpoint_storyboard_preview" : "checkpoint_storyboard_preview_receipt"}_${createHmac("sha256", store.integrityKey).update(canonicalJson({ storeBinding: store.storeBinding, kind, id: state.id, png: state.png!.sha256, receipt: state.receipt!.sha256 })).digest("hex").slice(0, 32)}`;
  return Object.freeze({
    identity: state.identity,
    previewHandle: handle("preview"),
    receiptHandle: handle("receipt"),
    target: state.target,
    resolvedAtMs: state.target.resolvedAtMs,
    sampling: state.sampling,
    output: Object.freeze({ sha256: state.png.sha256, width: state.png.width, height: state.png.height, format: "png" as const }),
    browser: Object.freeze({ runtimeEvidence: state.runtimeEvidence, engine: "browser" as const, session: Object.freeze({ browserLaunches: metrics?.browserLaunches ?? 0, framesRendered: metrics?.framesRendered ?? 0, frameRetries: metrics?.frameRetries ?? 0 }), network: Object.freeze({ policy: "no-approved-origins" as const, approvedOrigins: 0 as const, allowPrivateNetwork: false as const }) }),
    evidence: Object.freeze({ snapshotSha256, bindingId: binding.id, receiptFingerprint }),
  });
}

function sanitizedPreviewError(error: unknown): never {
  if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
  if (isPublicationCommitUncertain(error)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview publication may have committed private evidence; it was retained for host reconciliation.");
  throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview did not complete exact private evidence publication.");
}
