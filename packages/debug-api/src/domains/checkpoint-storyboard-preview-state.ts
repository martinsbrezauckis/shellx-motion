/** Private B1b preview state. A receipt, PNG, or Core lock is never success without this state. */
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, hashBuffer } from "@shellx-motion/core";
import { lineagePreviewsDirectory, withCheckpointStoryboardPreviewPublicationAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { readSignedFile, replaceSignedFile, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { exact, readIdentity, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";
import { checkpointStoryboardPreviewSamplingSha256, readCheckpointStoryboardTerminalBoundaryEvidence } from "./checkpoint-storyboard-preview-sampling.js";

const PREVIEW_ID = /^checkpoint_storyboard_preview_[a-f0-9]{32}$/u;
export const STATE_FILE = /^(checkpoint_storyboard_preview_[a-f0-9]{32})\.state\.json$/u;
const PNG_FILE = /^(checkpoint_storyboard_preview_[a-f0-9]{32})\.png$/u;
const RECEIPT_FILE = /^(checkpoint_storyboard_preview_[a-f0-9]{32})\.receipt\.json$/u;
const CORE_LOCK = /^\.shellx-motion-final-[a-f0-9]{32}\.lock$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PREVIEW_STATE_BYTES = 16 * 1024;
const MAX_PREVIEW_RECEIPT_BYTES = 256 * 1024;
const MAX_PREVIEW_PNG_BYTES = 64 * 1024 * 1024;
export const MAX_PREVIEWS_PER_LINEAGE = 128;

export type CheckpointStoryboardPreviewTarget =
  | Readonly<{ kind: "checkpoint"; checkpointId: string; resolvedAtMs: number }>
  | Readonly<{ kind: "time"; atMs: number; resolvedAtMs: number }>;
/** Server-derived sampling facts. They describe the sampling contract, never visual quality or a final state. */
export type CheckpointStoryboardPreviewSampling =
  | Readonly<{ mode: "interior"; renderedAtMs: number; documentDurationMs: number; interval: "[0,D)"; layerContent: "included" }>
  | Readonly<{ mode: "terminal-boundary"; renderedAtMs: number; documentDurationMs: number; interval: "[0,D)"; layerContent: "excluded-no-hold" }>;
export type CheckpointStoryboardPreviewState = Readonly<{
  /** @1 remains reopenable for completed B1b evidence; new B1d attempts always mint @2. */
  schema: "shellx-motion/private-checkpoint-storyboard-preview-state@1" | "shellx-motion/private-checkpoint-storyboard-preview-state@2";
  id: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  binding: Readonly<{ id: string; sha256: string }>;
  target: CheckpointStoryboardPreviewTarget;
  sampling?: CheckpointStoryboardPreviewSampling;
  runtimeEvidence: "host-browser" | "source-test";
  phase: "preparing" | "receipt-published" | "receipt-revoked" | "complete" | "uncertain" | "abandoned";
  receipt?: Readonly<{ sha256: string; byteLength: number }>;
  png?: Readonly<{ sha256: string; byteLength: number; width: number; height: number }>;
}>;
export type CheckpointStoryboardReopenedPreviewEvidence = Readonly<{
  snapshotSha256: string;
  samplingSha256: string;
  terminalBoundarySha256?: string;
}>;
export type CheckpointStoryboardReopenedPreviewPair = Readonly<{
  state: CheckpointStoryboardPreviewState;
}> & CheckpointStoryboardReopenedPreviewEvidence;
/** B1e-private authenticated bytes, never exported from the Debug package root. */ export type CheckpointStoryboardReopenedPreviewQualityPair = CheckpointStoryboardReopenedPreviewEvidence & Readonly<{ png: Buffer }>;

export async function publishPreviewPreparing(
  facts: AuthorityFacts,
  state: Omit<CheckpointStoryboardPreviewState, "schema" | "phase" | "sampling"> & Readonly<{ sampling: CheckpointStoryboardPreviewSampling }>,
): Promise<CheckpointStoryboardPreviewState> {
  const prepared = freezeState({ ...state, schema: "shellx-motion/private-checkpoint-storyboard-preview-state@2", phase: "preparing" });
  const directory = await lineagePreviewsDirectory(facts, prepared.root.id);
  await writeExclusiveSignedFile(previewStatePath(directory.path, prepared.id), prepared, facts, MAX_PREVIEW_STATE_BYTES);
  return prepared;
}

/** Only monotonic preview transitions are legal; evidence may be added, never dropped or replaced. */
export async function replacePreviewState(
  facts: AuthorityFacts,
  state: CheckpointStoryboardPreviewState,
  phase: CheckpointStoryboardPreviewState["phase"],
  extra: Pick<CheckpointStoryboardPreviewState, "receipt" | "png"> = {},
): Promise<CheckpointStoryboardPreviewState> {
  const directory = await lineagePreviewsDirectory(facts, state.root.id);
  const current = await readPreviewState(facts, directory.path, state.id);
  if (canonicalJson(current) !== canonicalJson(state)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard preview state changed before its private transition.");
  const receipt = extra.receipt ?? state.receipt;
  const png = extra.png ?? state.png;
  assertTransition(state, phase, receipt, png);
  const next = freezeState({ ...state, phase, ...(receipt ? { receipt } : {}), ...(png ? { png } : {}) });
  await replaceSignedFile(previewStatePath(directory.path, state.id), next, facts, MAX_PREVIEW_STATE_BYTES);
  const reopened = await readPreviewState(facts, directory.path, state.id);
  if (canonicalJson(reopened) !== canonicalJson(next)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard preview state did not reopen after private transition.");
  return reopened;
}

/** Best-effort conservative reconcile after an error whose last private rename/link may have won. */
export async function reconcilePreviewUncertainty(
  facts: AuthorityFacts,
  state: CheckpointStoryboardPreviewState,
): Promise<CheckpointStoryboardPreviewState> {
  const directory = await lineagePreviewsDirectory(facts, state.root.id);
  const current = await readPreviewState(facts, directory.path, state.id);
  if (current.phase === "complete" || current.phase === "uncertain" || current.phase === "receipt-revoked" || current.phase === "abandoned") return current;
  try { return await replacePreviewState(facts, current, "uncertain"); }
  catch { return current; }
}

/**
 * Root-lock-only destructive-transition guard. The root directory is bounded and streamed; global
 * preview roots are intentionally never listed during normal command execution.
 */
export async function assertLineageHasNoUnsettledCheckpointStoryboardPreviews(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
): Promise<number> {
  return await withCheckpointStoryboardPreviewPublicationAuthority(facts, async () => await assertLineageHasNoUnsettledCheckpointStoryboardPreviewsUnlocked(facts, root));
}

async function assertLineageHasNoUnsettledCheckpointStoryboardPreviewsUnlocked(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
): Promise<number> {
  const directory = await lineagePreviewsDirectory(facts, root.id);
  const stateIds = new Set<string>();
  const finalNames = new Set<string>();
  const states: CheckpointStoryboardPreviewState[] = [];
  const entries = await opendir(directory.path);
  try {
    for await (const entry of entries) {
      if (states.length + finalNames.size >= MAX_PREVIEWS_PER_LINEAGE * 3) throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage exceeds its bounded private evidence limit.");
      if (entry.isDirectory() && CORE_LOCK.test(entry.name)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview has an unresolved private publication reservation.");
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard preview directory contains an unsupported private entry.");
      const state = STATE_FILE.exec(entry.name)?.[1];
      if (state) {
        if (stateIds.has(state)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state names are duplicated.");
        stateIds.add(state);
        const reopened = await readPreviewState(facts, directory.path, state);
        if (!sameIdentity(reopened.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state escaped its root-scoped evidence directory.");
        states.push(reopened);
        continue;
      }
      if (PNG_FILE.test(entry.name) || RECEIPT_FILE.test(entry.name)) { finalNames.add(entry.name); continue; }
      throw storeError("store_integrity_failed", "Checkpoint storyboard preview directory contains an unrecognized private entry.");
    }
  } finally { await entries.close().catch(() => undefined); }
  if (states.length > MAX_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage exceeds its bounded state limit.");
  for (const name of finalNames) {
    const id = PNG_FILE.exec(name)?.[1] ?? RECEIPT_FILE.exec(name)?.[1];
    if (!id || !stateIds.has(id)) throw storeError("store_integrity_failed", "Checkpoint storyboard Browser preview evidence has no signed state record.");
  }
  for (const state of states) {
    if (state.phase === "preparing" || state.phase === "receipt-published" || state.phase === "uncertain") {
      throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview evidence is not in a terminal paired state.");
    }
    if (state.phase === "abandoned" || state.phase === "receipt-revoked") {
      if (finalNames.has(`${state.id}.png`) || finalNames.has(`${state.id}.receipt.json`)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard abandoned Browser preview retains private evidence.");
      continue;
    }
    await reopenCompletePreviewPair(facts, directory.path, state, finalNames);
  }
  return states.length;
}

/** Refuse a new evidence attempt at the same bounded lineage ceiling; nothing is compacted here. */
export async function preflightCheckpointStoryboardPreviewAttempt(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
): Promise<void> {
  if (await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root) >= MAX_PREVIEWS_PER_LINEAGE) {
    throw storeError("lineage_limit_exceeded", "Checkpoint storyboard lineage reached its bounded Browser preview evidence limit.");
  }
}
/**
 * Supervisor-quiescent recovery only. A signed preparing head is abandoned only when its exact
 * bounded root has no final evidence, Core reservation, or unsupported residue. Normal command
 * retries never call this and therefore cannot turn a post-link uncertainty into a new render.
 */
export async function recoverCheckpointStoryboardPreparingPreviewsForQuiescentHost(
  facts: AuthorityFacts,
  rootId: string,
): Promise<void> {
  const directory = await lineagePreviewsDirectory(facts, rootId);
  const entries = await opendir(directory.path);
  const states: CheckpointStoryboardPreviewState[] = [];
  const finalNames = new Set<string>();
  let uncertainResidue = false;
  try {
    for await (const entry of entries) {
      if (states.length + finalNames.size >= MAX_PREVIEWS_PER_LINEAGE * 3) throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage exceeds its bounded private evidence limit.");
      if (entry.isDirectory()) {
        if (CORE_LOCK.test(entry.name)) uncertainResidue = true;
        else uncertainResidue = true;
        continue;
      }
      if (!entry.isFile()) { uncertainResidue = true; continue; }
      const id = STATE_FILE.exec(entry.name)?.[1];
      if (id) {
        const state = await readPreviewState(facts, directory.path, id);
        if (state.root.id !== rootId) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state escaped its root-scoped evidence directory.");
        states.push(state);
        continue;
      }
      if (PNG_FILE.test(entry.name) || RECEIPT_FILE.test(entry.name)) { finalNames.add(entry.name); continue; }
      uncertainResidue = true;
    }
  } finally { await entries.close().catch(() => undefined); }
  if (states.length > MAX_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage exceeds its bounded state limit.");
  if (uncertainResidue) return;
  for (const state of states) {
    if (state.phase !== "preparing") continue;
    if (finalNames.has(`${state.id}.png`) || finalNames.has(`${state.id}.receipt.json`)) continue;
    await replacePreviewState(facts, state, "abandoned");
  }
}

export function previewOutputNames(id: string): Readonly<{ png: string; receipt: string }> {
  if (!PREVIEW_ID.test(id)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state identity is invalid.");
  return Object.freeze({ png: `${id}.png`, receipt: `${id}.receipt.json` });
}

function previewStatePath(directory: string, id: string): string { return join(directory, `${previewOutputNames(id).png.slice(0, -4)}.state.json`); }

function assertTransition(
  state: CheckpointStoryboardPreviewState,
  phase: CheckpointStoryboardPreviewState["phase"],
  receipt: CheckpointStoryboardPreviewState["receipt"],
  png: CheckpointStoryboardPreviewState["png"],
): void {
  if (!preservesOrAddsEvidence(state.receipt, receipt) || !preservesOrAddsEvidence(state.png, png)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state cannot replace immutable evidence.");
  const allowed = (state.phase === "preparing" && (phase === "receipt-published" || phase === "abandoned" || phase === "uncertain"))
    || (state.phase === "receipt-published" && (phase === "complete" || phase === "receipt-revoked" || phase === "uncertain"));
  if (!allowed || (phase === "receipt-published" && (!receipt || png)) || (phase === "complete" && (!receipt || !png)) || (phase === "receipt-revoked" && (!receipt || png)) || (phase === "abandoned" && (receipt || png))) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard preview state transition is not monotonic.");
  }
}

function preservesOrAddsEvidence<T extends { sha256: string; byteLength: number }>(left: T | undefined, right: T | undefined): boolean {
  return left === undefined || (right !== undefined && left.sha256 === right.sha256 && left.byteLength === right.byteLength);
}

function freezeState(value: CheckpointStoryboardPreviewState): CheckpointStoryboardPreviewState {
  if (!PREVIEW_ID.test(value.id)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state identity is invalid.");
  if ((value.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@1" && value.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@2")
    || (value.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@1" && value.sampling !== undefined)
    || (value.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@2" && value.sampling === undefined)) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard preview state sampling schema is invalid.");
  }
  if (value.sampling && (value.sampling.renderedAtMs !== value.target.resolvedAtMs
    || (value.sampling.mode === "terminal-boundary") !== (value.sampling.renderedAtMs === value.sampling.documentDurationMs))) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard preview sampling does not match its sealed target.");
  }
  if (!value.receipt && (value.phase === "receipt-published" || value.phase === "receipt-revoked" || value.phase === "complete")) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state is missing receipt evidence.");
  if (!value.png && value.phase === "complete") throw storeError("store_integrity_failed", "Checkpoint storyboard preview state is missing PNG evidence.");
  if (value.runtimeEvidence !== "host-browser" && value.runtimeEvidence !== "source-test") throw storeError("store_integrity_failed", "Checkpoint storyboard preview runtime evidence is invalid.");
  return Object.freeze({ ...value, binding: Object.freeze({ ...value.binding }), target: Object.freeze({ ...value.target }) as CheckpointStoryboardPreviewTarget, ...(value.sampling ? { sampling: Object.freeze({ ...value.sampling }) as CheckpointStoryboardPreviewSampling } : {}), ...(value.receipt ? { receipt: Object.freeze({ ...value.receipt }) } : {}), ...(value.png ? { png: Object.freeze({ ...value.png }) } : {}) });
}

export async function readPreviewState(facts: AuthorityFacts, directory: string, id: string): Promise<CheckpointStoryboardPreviewState> {
  const raw = await readSignedFile(previewStatePath(directory, id), facts, MAX_PREVIEW_STATE_BYTES, "record_not_found");
  const isV2 = !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).schema === "shellx-motion/private-checkpoint-storyboard-preview-state@2";
  const record = exact(raw, isV2
    ? ["schema", "id", "identity", "root", "binding", "target", "sampling", "runtimeEvidence", "phase"]
    : ["schema", "id", "identity", "root", "binding", "target", "runtimeEvidence", "phase"], ["receipt", "png"], "Checkpoint storyboard preview state");
  if ((record.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@1" && record.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@2") || record.id !== id) throw storeError("store_integrity_failed", "Checkpoint storyboard preview state schema is invalid.");
  const binding = exact(record.binding, ["id", "sha256"], "Checkpoint storyboard preview binding");
  if (typeof binding.id !== "string" || !/^checkpoint_storyboard_materialization_binding_[a-f0-9]{32}$/u.test(binding.id) || typeof binding.sha256 !== "string" || !SHA256.test(binding.sha256)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview binding is invalid.");
  const phase = record.phase;
  if (phase !== "preparing" && phase !== "receipt-published" && phase !== "receipt-revoked" && phase !== "complete" && phase !== "uncertain" && phase !== "abandoned") throw storeError("store_integrity_failed", "Checkpoint storyboard preview phase is invalid.");
  const receipt = record.receipt === undefined ? undefined : readFileEvidence(record.receipt, false);
  const png = record.png === undefined ? undefined : readFileEvidence(record.png, true);
  const sampling = record.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@2" ? readSampling(record.sampling) : undefined;
  return freezeState({ schema: record.schema, id, identity: readIdentity(record.identity, "Checkpoint storyboard preview identity"), root: readIdentity(record.root, "Checkpoint storyboard preview root"), binding: Object.freeze({ id: binding.id, sha256: binding.sha256 }), target: readTarget(record.target), ...(sampling ? { sampling } : {}), runtimeEvidence: record.runtimeEvidence as CheckpointStoryboardPreviewState["runtimeEvidence"], phase, ...(receipt ? { receipt } : {}), ...(png ? { png } : {}) });
}

function readTarget(value: unknown): CheckpointStoryboardPreviewTarget {
  const record = exact(value, ["kind", "resolvedAtMs"], ["checkpointId", "atMs"], "Checkpoint storyboard preview target");
  if (!Number.isSafeInteger(record.resolvedAtMs) || (record.resolvedAtMs as number) < 0) throw storeError("store_integrity_failed", "Checkpoint storyboard preview resolved time is invalid.");
  if (record.kind === "checkpoint" && typeof record.checkpointId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.checkpointId) && !Object.hasOwn(record, "atMs")) return Object.freeze({ kind: "checkpoint", checkpointId: record.checkpointId, resolvedAtMs: record.resolvedAtMs as number });
  if (record.kind === "time" && Number.isSafeInteger(record.atMs) && (record.atMs as number) >= 0 && !Object.hasOwn(record, "checkpointId")) return Object.freeze({ kind: "time", atMs: record.atMs as number, resolvedAtMs: record.resolvedAtMs as number });
  throw storeError("store_integrity_failed", "Checkpoint storyboard preview target is invalid.");
}

function readSampling(value: unknown): CheckpointStoryboardPreviewSampling {
  const record = exact(value, ["mode", "renderedAtMs", "documentDurationMs", "interval", "layerContent"], "Checkpoint storyboard preview sampling");
  if (!Number.isSafeInteger(record.renderedAtMs) || (record.renderedAtMs as number) < 0 || !Number.isSafeInteger(record.documentDurationMs) || (record.documentDurationMs as number) < 1 || record.interval !== "[0,D)") {
    throw storeError("store_integrity_failed", "Checkpoint storyboard preview sampling range is invalid.");
  }
  if (record.mode === "interior" && record.layerContent === "included" && (record.renderedAtMs as number) < (record.documentDurationMs as number)) {
    return Object.freeze({ mode: "interior", renderedAtMs: record.renderedAtMs as number, documentDurationMs: record.documentDurationMs as number, interval: "[0,D)", layerContent: "included" });
  }
  if (record.mode === "terminal-boundary" && record.layerContent === "excluded-no-hold" && record.renderedAtMs === record.documentDurationMs) {
    return Object.freeze({ mode: "terminal-boundary", renderedAtMs: record.renderedAtMs as number, documentDurationMs: record.documentDurationMs as number, interval: "[0,D)", layerContent: "excluded-no-hold" });
  }
  throw storeError("store_integrity_failed", "Checkpoint storyboard preview sampling mode is invalid.");
}

function readFileEvidence(value: unknown, png: true): Readonly<{ sha256: string; byteLength: number; width: number; height: number }>;
function readFileEvidence(value: unknown, png: false): Readonly<{ sha256: string; byteLength: number }>;
function readFileEvidence(value: unknown, png: boolean): Readonly<{ sha256: string; byteLength: number; width?: number; height?: number }> {
  const record = exact(value, png ? ["sha256", "byteLength", "width", "height"] : ["sha256", "byteLength"], "Checkpoint storyboard preview file evidence");
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0) throw storeError("store_integrity_failed", "Checkpoint storyboard preview file evidence is invalid.");
  if (!png) return Object.freeze({ sha256: record.sha256, byteLength: record.byteLength as number });
  if (!Number.isSafeInteger(record.width) || (record.width as number) < 1 || !Number.isSafeInteger(record.height) || (record.height as number) < 1) throw storeError("store_integrity_failed", "Checkpoint storyboard preview PNG dimensions are invalid.");
  return Object.freeze({ sha256: record.sha256, byteLength: record.byteLength as number, width: record.width as number, height: record.height as number });
}

export function previewHandles(facts: AuthorityFacts, state: CheckpointStoryboardPreviewState): Readonly<{ preview: string; receipt: string }> {
  if (!state.receipt || !state.png) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview does not retain a paired state.");
  const handle = (kind: "preview" | "receipt") => `${kind === "preview" ? "checkpoint_storyboard_preview" : "checkpoint_storyboard_preview_receipt"}_${createHmac("sha256", facts.integrityKey).update(canonicalJson({ storeBinding: facts.storeBinding, kind, id: state.id, png: state.png!.sha256, receipt: state.receipt!.sha256 })).digest("hex").slice(0, 32)}`;
  return Object.freeze({ preview: handle("preview"), receipt: handle("receipt") });
}
export async function reopenCompletePreviewPair(facts: AuthorityFacts, directory: string, state: CheckpointStoryboardPreviewState, finalNames: ReadonlySet<string>): Promise<CheckpointStoryboardReopenedPreviewEvidence> {
  const reopened = await reopenCompletePreviewPairForQuality(facts, directory, state, finalNames);
  return Object.freeze({ snapshotSha256: reopened.snapshotSha256, samplingSha256: reopened.samplingSha256, ...(reopened.terminalBoundarySha256 ? { terminalBoundarySha256: reopened.terminalBoundarySha256 } : {}) });
}
/** B1e-only bounded authenticated PNG bytes; no path or bytes cross any command/result surface. */
export async function reopenCompletePreviewPairForQuality(facts: AuthorityFacts, directory: string, state: CheckpointStoryboardPreviewState, finalNames: ReadonlySet<string>): Promise<CheckpointStoryboardReopenedPreviewQualityPair> {
  if (!state.receipt || !state.png || !finalNames.has(`${state.id}.png`) || !finalNames.has(`${state.id}.receipt.json`)) throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview does not retain an exact receipt-first PNG pair.");
  try {
    const [receipt, png] = await Promise.all([
      readPrivatePreviewFile(join(directory, `${state.id}.receipt.json`), facts, MAX_PREVIEW_RECEIPT_BYTES, "Checkpoint storyboard Browser preview receipt"),
      readPrivatePreviewFile(join(directory, `${state.id}.png`), facts, MAX_PREVIEW_PNG_BYTES, "Checkpoint storyboard Browser preview PNG"),
    ]);
    if (receipt.sha256 !== state.receipt.sha256 || receipt.byteLength !== state.receipt.byteLength || png.sha256 !== state.png.sha256 || png.byteLength !== state.png.byteLength) throw new Error("pair mismatch");
    const value: unknown = JSON.parse(receipt.bytes.toString("utf8"));
    const isV2 = !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).schema === "shellx-motion/private-checkpoint-storyboard-preview-receipt@2";
    const record = exact(value, isV2
      ? ["schema", "previewId", "identity", "root", "binding", "target", "sampling", "runtimeEvidence", "png", "browser", "snapshot"]
      : ["schema", "previewId", "identity", "root", "binding", "target", "runtimeEvidence", "png", "browser", "snapshot"], isV2 ? ["terminalBoundary"] : [], "Checkpoint storyboard Browser preview receipt");
    const receiptSampling = isV2 ? readSampling(record.sampling) : undefined;
    if ((record.schema !== "shellx-motion/private-checkpoint-storyboard-preview-receipt@1" && record.schema !== "shellx-motion/private-checkpoint-storyboard-preview-receipt@2") || (state.schema.endsWith("@2") !== isV2) || record.previewId !== state.id || canonicalJson(readIdentity(record.identity, "Checkpoint storyboard Browser preview receipt identity")) !== canonicalJson(state.identity) || canonicalJson(readIdentity(record.root, "Checkpoint storyboard Browser preview receipt root")) !== canonicalJson(state.root) || canonicalJson(record.binding) !== canonicalJson(state.binding) || canonicalJson(readTarget(record.target)) !== canonicalJson(state.target) || (receiptSampling && canonicalJson(receiptSampling) !== canonicalJson(state.sampling)) || record.runtimeEvidence !== state.runtimeEvidence) throw new Error("receipt state mismatch");
    const receiptPng = readFileEvidence(record.png, true);
    const snapshot = exact(record.snapshot, ["nonReceiptInventorySha256"], "Checkpoint storyboard Browser preview snapshot");
    if (typeof snapshot.nonReceiptInventorySha256 !== "string" || !SHA256.test(snapshot.nonReceiptInventorySha256) || receiptPng.sha256 !== state.png.sha256 || receiptPng.byteLength !== state.png.byteLength || receiptPng.width !== state.png.width || receiptPng.height !== state.png.height || !record.browser || typeof record.browser !== "object" || Array.isArray(record.browser)) throw new Error("receipt evidence mismatch");
    let terminalBoundarySha256: string | undefined;
    if (receiptSampling?.mode === "terminal-boundary") {
      const terminalBoundary = readCheckpointStoryboardTerminalBoundaryEvidence(record.terminalBoundary, receiptSampling, receiptPng.width, receiptPng.height);
      terminalBoundarySha256 = hashBuffer(Buffer.from(canonicalJson(terminalBoundary), "utf8"));
    } else if (record.terminalBoundary !== undefined) {
      throw new Error("interior receipt retained terminal evidence");
    }
    return Object.freeze({
      snapshotSha256: snapshot.nonReceiptInventorySha256,
      samplingSha256: checkpointStoryboardPreviewSamplingSha256(state),
      ...(terminalBoundarySha256 ? { terminalBoundarySha256 } : {}),
      png: Buffer.from(png.bytes),
    });
  } catch { throw storeError("preview_publication_uncertain", "Checkpoint storyboard Browser preview pair could not be reopened exactly."); }
}
async function readPrivatePreviewFile(path: string, facts: AuthorityFacts, maxBytes: number, label: string): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> {
  const privateFile = (stat: Awaited<ReturnType<typeof lstat>>) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === facts.ownerUid && (Number(stat.mode) & 0o077) === 0 && stat.size >= 0 && stat.size <= maxBytes;
  const before = await lstat(path); if (!privateFile(before)) throw new Error(`${label} is not a bounded private file.`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); if (!privateFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed before opening.`);
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.byteLength) { const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset); if (read.bytesRead === 0) throw new Error(`${label} ended before its stable size.`); offset += read.bytesRead; }
    const after = await handle.stat(), pathAfter = await lstat(path);
    if (!privateFile(after) || !privateFile(pathAfter) || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) throw new Error(`${label} changed while reading.`);
    return Object.freeze({ bytes, byteLength: bytes.byteLength, sha256: hashBuffer(bytes) });
  } finally { await handle.close(); }
}
