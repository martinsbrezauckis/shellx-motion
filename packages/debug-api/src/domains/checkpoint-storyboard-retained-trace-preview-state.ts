/**
 * Private C6C B7 retained-trace preview evidence state.
 *
 * This deliberately owns only receipt-first PNG-pair publication state. It does not reopen the
 * resolved package, invoke a renderer, or parse a renderer receipt: the renderer/orchestrator
 * supplies already-verified file facts and this module binds them to one active B7 resolution.
 */
import { createHmac } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import {
  findLineageRetainedTracePreviewsDirectory,
  lineageRetainedTracePreviewsDirectory,
  withCheckpointStoryboardRetainedTracePreviewPublicationAuthority,
} from "./checkpoint-storyboard-retained-trace-preview-store.js";
import { readSignedFile, replaceSignedFile, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { exact, readIdentity, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";
import { readRetainedTraceBinding, readRetainedTraceResolutionState } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import { MAX_RETAINED_TRACE_PREVIEW_DIMENSION, MAX_RETAINED_TRACE_PREVIEW_PIXELS, MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES, MAX_RETAINED_TRACE_PREVIEW_RECEIPT_BYTES, readPrivateRetainedTracePreviewEvidence, retainedTracePreviewPngDimensions } from "./checkpoint-storyboard-retained-trace-preview-evidence.js";

const PREVIEW_ID = /^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u;
const BINDING_ID = /^checkpoint_storyboard_retained_trace_resolution_binding_[a-f0-9]{32}$/u;
export const RETAINED_TRACE_PREVIEW_STATE_FILE = /^(checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32})\.state\.json$/u;
const PNG_FILE = /^(checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32})\.png$/u;
const RECEIPT_FILE = /^(checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32})\.receipt\.json$/u;
const CORE_LOCK = /^\.shellx-motion-final-[a-f0-9]{32}\.lock$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_STATE_BYTES = 16 * 1024;
export const MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE = 128;

export type CheckpointStoryboardRetainedTracePreviewReceiptEvidence = Readonly<{ sha256: string; byteLength: number }>;
export type CheckpointStoryboardRetainedTracePreviewPngEvidence = CheckpointStoryboardRetainedTracePreviewReceiptEvidence & Readonly<{ width: number; height: number }>;
export type CheckpointStoryboardRetainedTracePreviewState = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-state@1";
  id: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  /** Exact signed B7 resolution binding that was active before renderer work began. */
  binding: Readonly<{ id: string; sha256: string }>;
  /** Exact safe-integer microsecond time; no millisecond projection is stored here. */
  atUs: number;
  runtimeEvidence: "host-gpu" | "source-test";
  phase: "preparing" | "receipt-published" | "receipt-revoked" | "complete" | "uncertain" | "abandoned";
  receipt?: CheckpointStoryboardRetainedTracePreviewReceiptEvidence;
  png?: CheckpointStoryboardRetainedTracePreviewPngEvidence;
}>;
export type CheckpointStoryboardRetainedTracePreviewPreparingInput = Readonly<{
  id: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  binding: Readonly<{ id: string; sha256: string }>;
  atUs: number;
  runtimeEvidence: "host-gpu" | "source-test";
}>;
export type CheckpointStoryboardRetainedTracePreviewPair = Readonly<{
  state: CheckpointStoryboardRetainedTracePreviewState;
  handles: Readonly<{ preview: string; receipt: string }>;
}>;

/**
 * The caller holds the lineage lock for the entire render/publication operation. This validates
 * that the state is anchored to the currently active, exact B7 binding before it writes anything.
 */
export async function publishCheckpointStoryboardRetainedTracePreviewPreparing(
  facts: AuthorityFacts,
  input: CheckpointStoryboardRetainedTracePreviewPreparingInput,
): Promise<CheckpointStoryboardRetainedTracePreviewState> {
  const prepared = freezeState({ ...input, schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-state@1", phase: "preparing" });
  await assertActiveB7Binding(facts, prepared);
  const directory = await lineageRetainedTracePreviewsDirectory(facts, prepared.root.id);
  await writeExclusiveSignedFile(previewStatePath(directory.path, prepared.id), prepared, facts, MAX_STATE_BYTES);
  return prepared;
}

/** Only receipt-first monotonic transitions can add evidence to a retained-trace preview state. */
export async function replaceCheckpointStoryboardRetainedTracePreviewState(
  facts: AuthorityFacts,
  state: CheckpointStoryboardRetainedTracePreviewState,
  phase: CheckpointStoryboardRetainedTracePreviewState["phase"],
  extra: Readonly<{ receipt?: CheckpointStoryboardRetainedTracePreviewReceiptEvidence; png?: CheckpointStoryboardRetainedTracePreviewPngEvidence }> = {},
): Promise<CheckpointStoryboardRetainedTracePreviewState> {
  const directory = await lineageRetainedTracePreviewsDirectory(facts, state.root.id);
  const current = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory.path, state.id);
  if (canonicalJson(current) !== canonicalJson(state)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview state changed before its private transition.");
  const receipt = extra.receipt ?? state.receipt;
  const png = extra.png ?? state.png;
  assertTransition(state, phase, receipt, png);
  const next = freezeState({ ...state, phase, ...(receipt ? { receipt } : {}), ...(png ? { png } : {}) });
  await replaceSignedFile(previewStatePath(directory.path, state.id), next, facts, MAX_STATE_BYTES);
  const reopened = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory.path, state.id);
  if (canonicalJson(reopened) !== canonicalJson(next)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview state did not reopen after private transition.");
  return reopened;
}

/** Preserve an unknown final link/pair as uncertainty. Normal retries must never clear it. */
export async function reconcileCheckpointStoryboardRetainedTracePreviewUncertainty(
  facts: AuthorityFacts,
  state: CheckpointStoryboardRetainedTracePreviewState,
): Promise<CheckpointStoryboardRetainedTracePreviewState> {
  const directory = await lineageRetainedTracePreviewsDirectory(facts, state.root.id);
  const current = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory.path, state.id);
  if (current.phase === "complete" || current.phase === "uncertain" || current.phase === "receipt-revoked" || current.phase === "abandoned") return current;
  try { return await replaceCheckpointStoryboardRetainedTracePreviewState(facts, current, "uncertain"); }
  catch { return current; }
}

/** Bounded root-scoped preflight; it does not inspect B1 Browser preview evidence. */
export async function preflightCheckpointStoryboardRetainedTracePreviewAttempt(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
): Promise<void> {
  if (await assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, root) >= MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE) {
    throw storeError("lineage_limit_exceeded", "Checkpoint storyboard lineage reached its bounded retained-trace preview evidence limit.");
  }
}

/**
 * Lifecycle quiescence and completeness check. It streams only one B7 lineage directory, refuses
 * reservations/foreign residue, and verifies complete pairs by exact state/file identity only.
 */
export async function assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
): Promise<number> {
  const directory = await findLineageRetainedTracePreviewsDirectory(facts, root.id);
  if (!directory) return 0;
  return await withCheckpointStoryboardRetainedTracePreviewPublicationAuthority(facts, async () => await scanLineage(facts, directory.path, root));
}

/** Names are relative filenames only; callers obtain the private directory through host authority. */
export function retainedTracePreviewOutputNames(id: string): Readonly<{ png: string; receipt: string }> {
  if (!PREVIEW_ID.test(id)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state identity is invalid.");
  return Object.freeze({ png: `${id}.png`, receipt: `${id}.receipt.json` });
}

/** Opaque HMAC handles disclose no host path, renderer receipt, package, or output authority. */
export function retainedTracePreviewHandles(
  facts: AuthorityFacts,
  state: CheckpointStoryboardRetainedTracePreviewState,
): Readonly<{ preview: string; receipt: string }> {
  if (state.phase !== "complete" || !state.receipt || !state.png) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview does not retain a complete paired state.");
  const handle = (kind: "preview" | "receipt") => `${kind === "preview" ? "checkpoint_storyboard_retained_trace_preview" : "checkpoint_storyboard_retained_trace_preview_receipt"}_${createHmac("sha256", facts.integrityKey).update(canonicalJson({ storeBinding: facts.storeBinding, kind, id: state.id, identity: state.identity, root: state.root, binding: state.binding, atUs: state.atUs, runtimeEvidence: state.runtimeEvidence, receipt: state.receipt!.sha256, png: state.png!.sha256 })).digest("hex").slice(0, 32)}`;
  return Object.freeze({ preview: handle("preview"), receipt: handle("receipt") });
}

/** Reopens a complete pair without decoding/interpreting any renderer-specific receipt content. */
export async function reopenCompleteCheckpointStoryboardRetainedTracePreviewPair(
  facts: AuthorityFacts,
  directory: string,
  state: CheckpointStoryboardRetainedTracePreviewState,
  finalNames: ReadonlySet<string>,
): Promise<CheckpointStoryboardRetainedTracePreviewPair> {
  if (state.phase !== "complete" || !state.receipt || !state.png || !finalNames.has(`${state.id}.receipt.json`) || !finalNames.has(`${state.id}.png`)) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview does not retain an exact receipt-first PNG pair.");
  }
  try {
    const [receipt, png] = await Promise.all([
      readPrivateRetainedTracePreviewEvidence(join(directory, `${state.id}.receipt.json`), facts, MAX_RETAINED_TRACE_PREVIEW_RECEIPT_BYTES, "Checkpoint storyboard retained-trace preview receipt"),
      readPrivateRetainedTracePreviewEvidence(join(directory, `${state.id}.png`), facts, MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES, "Checkpoint storyboard retained-trace preview PNG"),
    ]);
    if (receipt.sha256 !== state.receipt.sha256 || receipt.byteLength !== state.receipt.byteLength || png.sha256 !== state.png.sha256 || png.byteLength !== state.png.byteLength) throw new Error("pair hash mismatch");
    const dimensions = retainedTracePreviewPngDimensions(png.bytes);
    if (dimensions.width !== state.png.width || dimensions.height !== state.png.height) throw new Error("PNG dimensions mismatch");
    return Object.freeze({ state, handles: retainedTracePreviewHandles(facts, state) });
  } catch (error) {
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview pair could not be reopened exactly.");
  }
}

/** Supervisor-quiescent recovery may abandon only a no-evidence preparing state. */
export async function recoverCheckpointStoryboardRetainedTracePreparingPreviewsForQuiescentHost(
  facts: AuthorityFacts,
  rootId: string,
): Promise<void> {
  const directory = await lineageRetainedTracePreviewsDirectory(facts, rootId);
  const entries = await opendir(directory.path);
  const states: CheckpointStoryboardRetainedTracePreviewState[] = [];
  const finalNames = new Set<string>();
  let uncertainResidue = false;
  try {
    for await (const entry of entries) {
      if (states.length + finalNames.size >= MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE * 3) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage exceeds its bounded private evidence limit.");
      if (entry.isDirectory()) { uncertainResidue = true; continue; }
      if (!entry.isFile()) { uncertainResidue = true; continue; }
      const id = RETAINED_TRACE_PREVIEW_STATE_FILE.exec(entry.name)?.[1];
      if (id) {
        const state = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory.path, id);
        if (state.root.id !== rootId) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state escaped its root-scoped evidence directory.");
        states.push(state);
        continue;
      }
      if (PNG_FILE.test(entry.name) || RECEIPT_FILE.test(entry.name)) { finalNames.add(entry.name); continue; }
      uncertainResidue = true;
    }
  } finally { await entries.close().catch(() => undefined); }
  if (states.length > MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage exceeds its bounded state limit.");
  if (uncertainResidue) return;
  for (const state of states) {
    if (state.phase === "preparing" && !finalNames.has(`${state.id}.png`) && !finalNames.has(`${state.id}.receipt.json`)) {
      await replaceCheckpointStoryboardRetainedTracePreviewState(facts, state, "abandoned");
    }
  }
}

export async function readCheckpointStoryboardRetainedTracePreviewState(
  facts: AuthorityFacts,
  directory: string,
  id: string,
): Promise<CheckpointStoryboardRetainedTracePreviewState> {
  const record = exact(await readSignedFile(previewStatePath(directory, id), facts, MAX_STATE_BYTES, "record_not_found"), ["schema", "id", "identity", "root", "binding", "atUs", "runtimeEvidence", "phase"], ["receipt", "png"], "Checkpoint storyboard retained-trace preview state");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-state@1" || record.id !== id) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state schema is invalid.");
  const binding = exact(record.binding, ["id", "sha256"], "Checkpoint storyboard retained-trace preview binding");
  const receipt = record.receipt === undefined ? undefined : readFileEvidence(record.receipt, false);
  const png = record.png === undefined ? undefined : readFileEvidence(record.png, true);
  return freezeState({
    schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-state@1",
    id,
    identity: readIdentity(record.identity, "Checkpoint storyboard retained-trace preview identity"),
    root: readIdentity(record.root, "Checkpoint storyboard retained-trace preview root"),
    binding: Object.freeze({ id: binding.id as string, sha256: binding.sha256 as string }),
    atUs: record.atUs as number,
    runtimeEvidence: record.runtimeEvidence as CheckpointStoryboardRetainedTracePreviewState["runtimeEvidence"],
    phase: record.phase as CheckpointStoryboardRetainedTracePreviewState["phase"],
    ...(receipt ? { receipt } : {}),
    ...(png ? { png } : {}),
  });
}

function previewStatePath(directory: string, id: string): string { return join(directory, `${retainedTracePreviewOutputNames(id).png.slice(0, -4)}.state.json`); }

async function assertActiveB7Binding(facts: AuthorityFacts, state: CheckpointStoryboardRetainedTracePreviewState): Promise<void> {
  const record = await readStoredRecordUnlocked(facts, state.identity);
  if (!sameIdentity(record.identity, state.identity) || !sameIdentity(record.lineage.root, state.root) || record.admission.profile !== "c6b7-retained-trace@1" || record.target.state !== "active" || record.archive.terminal) {
    throw storeError("preview_binding_not_active", "Checkpoint storyboard retained-trace preview requires an active C6C B7 record binding.");
  }
  const [resolution, binding] = await Promise.all([
    readRetainedTraceResolutionState(facts, state.identity, state.root, { requireHead: true }),
    readRetainedTraceBinding(facts, state.identity),
  ]);
  if (resolution.state !== "bound" || resolution.active !== 1 || !binding || resolution.bindingId !== binding.id || binding.id !== state.binding.id || binding.sha256 !== state.binding.sha256) {
    throw storeError("preview_binding_not_active", "Checkpoint storyboard retained-trace preview binding is no longer active or exact.");
  }
}

async function scanLineage(facts: AuthorityFacts, directory: string, root: CheckpointStoryboardRecordIdentity): Promise<number> {
  const stateIds = new Set<string>();
  const finalNames = new Set<string>();
  const states: CheckpointStoryboardRetainedTracePreviewState[] = [];
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (states.length + finalNames.size >= MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE * 3) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage exceeds its bounded private evidence limit.");
      if (entry.isDirectory() && CORE_LOCK.test(entry.name)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview has an unresolved private publication reservation.");
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview directory contains an unsupported private entry.");
      const id = RETAINED_TRACE_PREVIEW_STATE_FILE.exec(entry.name)?.[1];
      if (id) {
        if (stateIds.has(id)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state names are duplicated.");
        stateIds.add(id);
        const state = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory, id);
        const record = await readStoredRecordUnlocked(facts, state.identity);
        if (!sameIdentity(state.root, root) || !sameIdentity(record.identity, state.identity) || !sameIdentity(record.lineage.root, root) || record.admission.profile !== "c6b7-retained-trace@1") {
          throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state does not bind a sealed B7 lineage member.");
        }
        states.push(state);
        continue;
      }
      if (PNG_FILE.test(entry.name) || RECEIPT_FILE.test(entry.name)) { finalNames.add(entry.name); continue; }
      throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview directory contains an unrecognized private entry.");
    }
  } finally { await entries.close().catch(() => undefined); }
  if (states.length > MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage exceeds its bounded state limit.");
  for (const name of finalNames) {
    const id = PNG_FILE.exec(name)?.[1] ?? RECEIPT_FILE.exec(name)?.[1];
    if (!id || !stateIds.has(id)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview evidence has no signed state record.");
  }
  for (const state of states) {
    if (state.phase === "preparing" || state.phase === "receipt-published" || state.phase === "uncertain") {
      throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview evidence is not in a terminal paired state.");
    }
    if (state.phase === "abandoned" || state.phase === "receipt-revoked") {
      if (finalNames.has(`${state.id}.png`) || finalNames.has(`${state.id}.receipt.json`)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview terminal cleanup retains private evidence.");
      continue;
    }
    await reopenCompleteCheckpointStoryboardRetainedTracePreviewPair(facts, directory, state, finalNames);
  }
  return states.length;
}

function assertTransition(
  state: CheckpointStoryboardRetainedTracePreviewState,
  phase: CheckpointStoryboardRetainedTracePreviewState["phase"],
  receipt: CheckpointStoryboardRetainedTracePreviewReceiptEvidence | undefined,
  png: CheckpointStoryboardRetainedTracePreviewPngEvidence | undefined,
): void {
  if (!preservesOrAddsEvidence(state.receipt, receipt) || !preservesOrAddsEvidence(state.png, png)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state cannot replace immutable evidence.");
  const allowed = (state.phase === "preparing" && (phase === "receipt-published" || phase === "abandoned" || phase === "uncertain"))
    || (state.phase === "receipt-published" && (phase === "complete" || phase === "receipt-revoked" || phase === "uncertain"));
  if (!allowed || (phase === "receipt-published" && (!receipt || png)) || (phase === "complete" && (!receipt || !png)) || (phase === "receipt-revoked" && (!receipt || png)) || (phase === "abandoned" && (receipt || png))) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state transition is not monotonic.");
  }
}

function preservesOrAddsEvidence<T extends CheckpointStoryboardRetainedTracePreviewReceiptEvidence>(left: T | undefined, right: T | undefined): boolean {
  return left === undefined || (right !== undefined && left.sha256 === right.sha256 && left.byteLength === right.byteLength);
}

function freezeState(value: CheckpointStoryboardRetainedTracePreviewState): CheckpointStoryboardRetainedTracePreviewState {
  const identity = readIdentity(value.identity, "Checkpoint storyboard retained-trace preview identity");
  const root = readIdentity(value.root, "Checkpoint storyboard retained-trace preview root");
  if (!PREVIEW_ID.test(value.id) || !BINDING_ID.test(value.binding.id) || !SHA256.test(value.binding.sha256) || !Number.isSafeInteger(value.atUs) || value.atUs < 0 || (value.runtimeEvidence !== "host-gpu" && value.runtimeEvidence !== "source-test") || !isPhase(value.phase)) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview state is invalid.");
  }
  if ((value.png && !value.receipt) || (value.phase === "preparing" && (value.receipt || value.png)) || ((value.phase === "receipt-published" || value.phase === "receipt-revoked") && (!value.receipt || value.png)) || (value.phase === "complete" && (!value.receipt || !value.png)) || (value.phase === "abandoned" && (value.receipt || value.png))) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview evidence does not match its sealed phase.");
  }
  return Object.freeze({
    ...value,
    identity,
    root,
    binding: Object.freeze({ ...value.binding }),
    ...(value.receipt ? { receipt: Object.freeze({ ...value.receipt }) } : {}),
    ...(value.png ? { png: Object.freeze({ ...value.png }) } : {}),
  });
}

function isPhase(value: unknown): value is CheckpointStoryboardRetainedTracePreviewState["phase"] {
  return value === "preparing" || value === "receipt-published" || value === "receipt-revoked" || value === "complete" || value === "uncertain" || value === "abandoned";
}

function readFileEvidence(value: unknown, png: true): CheckpointStoryboardRetainedTracePreviewPngEvidence;
function readFileEvidence(value: unknown, png: false): CheckpointStoryboardRetainedTracePreviewReceiptEvidence;
function readFileEvidence(value: unknown, png: boolean): CheckpointStoryboardRetainedTracePreviewReceiptEvidence | CheckpointStoryboardRetainedTracePreviewPngEvidence {
  const record = exact(value, png ? ["sha256", "byteLength", "width", "height"] : ["sha256", "byteLength"], "Checkpoint storyboard retained-trace preview file evidence");
  const maximumBytes = png ? MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES : MAX_RETAINED_TRACE_PREVIEW_RECEIPT_BYTES;
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0 || (record.byteLength as number) > maximumBytes) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview file evidence is invalid.");
  if (!png) return Object.freeze({ sha256: record.sha256, byteLength: record.byteLength as number });
  if (!Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height) || (record.width as number) < 1 || (record.height as number) < 1 || (record.width as number) > MAX_RETAINED_TRACE_PREVIEW_DIMENSION || (record.height as number) > MAX_RETAINED_TRACE_PREVIEW_DIMENSION || (record.width as number) * (record.height as number) > MAX_RETAINED_TRACE_PREVIEW_PIXELS) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview PNG dimensions are invalid.");
  }
  return Object.freeze({ sha256: record.sha256, byteLength: record.byteLength as number, width: record.width as number, height: record.height as number });
}
