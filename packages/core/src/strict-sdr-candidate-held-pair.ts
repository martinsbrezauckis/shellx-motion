/**
 * Private Core storage for one nonqualifying strict-SDR candidate render.
 *
 * Candidate admission belongs to the private child. This module only retains a workspace already
 * anchored by the host, owns its fixed media/receipt pair, and transports that pair through a
 * callback-scoped context. It is intentionally absent from the public Core barrel.
 */
import { resolve } from "node:path";
import type { DerivedFilePublicationEvidence, DerivedOutputPublication } from "./derived-output-publication";
import { assertPairedReceiptAcceptance } from "./paired-output-receipt-publication";
import { withRetainedPairedPublishedPairReadCapture, type RetainedPairedPublishedPairReadCapability } from "./paired-output-receipt-held-capture";
import { assertStrictSdrCandidateHeldPairRegistration, unregisterStrictSdrCandidateHeldPair } from "./strict-sdr-candidate-held-pair-registry";
import {
  activeStrictSdrCandidateHeldWorkspaceScope,
  assertStrictSdrCandidateHeldPairOpen,
  assertStrictSdrCandidateHeldWorkspaceCurrent,
  assertStrictSdrCandidatePreparationFingerprint,
  closeStrictSdrCandidateHeldPairAfterTerminal,
  openStrictSdrCandidateHeldPair,
  STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES,
  STRICT_SDR_CANDIDATE_RECEIPT_MAX_BYTES,
  strictSdrCandidateHeldPairState,
  strictSdrCandidateHeldWorkspaceState,
  withStrictSdrCandidateHeldPairRendererScope,
  type StrictSdrCandidateHeldPairFinalizerKind,
  type StrictSdrCandidateHeldPairState,
  type StrictSdrCandidateHeldWorkspace,
} from "./strict-sdr-candidate-held-workspace";
import type { OperationReceipt } from "./types";

export {
  closeStrictSdrCandidateHeldWorkspace,
  createStrictSdrCandidateHeldWorkspace,
  currentStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES,
  STRICT_SDR_CANDIDATE_RECEIPT_MAX_BYTES,
  withStrictSdrCandidateHeldWorkspace,
} from "./strict-sdr-candidate-held-workspace";
export type { StrictSdrCandidateHeldWorkspace } from "./strict-sdr-candidate-held-workspace";
export {
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  isStrictSdrCandidateHeldPairRendererBinding,
  matchesCurrentStrictSdrCandidateHeldPairRendererInput,
  registerStrictSdrCandidateF2aFinalizer,
  recordStrictSdrCandidateHeldMediaStage,
  registerStrictSdrCandidateF2bScreenControlsFinalizer,
  registerStrictSdrCandidateF2bScreenFinalizer,
  registerStrictSdrCandidateThreeSlotF2aFinalizer,
  strictSdrCandidateHeldPairForConsumedF2bScreenControlsRendererBinding,
  strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding,
  strictSdrCandidateHeldPairForConsumedRendererBinding,
  strictSdrCandidateHeldPairForConsumedThreeSlotF2aRendererBinding,
} from "./strict-sdr-candidate-three-slot-held-pair";

declare const pairBrand: unique symbol;
declare const rendererBindingBrand: unique symbol;
declare const completionBrand: unique symbol;
/** Opaque Core-held pair; only the private terminal and child receive it. */
export interface StrictSdrCandidateHeldPair { readonly [pairBrand]: never; }
/** Opaque one-use selector for the renderer's private held-media executor. */
export interface StrictSdrCandidateHeldPairRendererBinding { readonly [rendererBindingBrand]: never; }
/** Opaque, pair-bound proof that Core's evaluator, retained byte checks and cleanup all resolved. */
export interface StrictSdrCandidateHeldPairCompletion { readonly [completionBrand]: never; }

export type StrictSdrCandidateTerminalBinding = Readonly<{ outputPath: string; receiptPath: string }>;

export type StrictSdrCandidateHeldPairObservation = Readonly<{
  media: Readonly<{ sha256: string; byteLength: number }>;
  receipt: Readonly<{ sha256: string; byteLength: number }>;
  /** One callback-scoped inherited descriptor for the strict-SDR inverse only. */
  withF2aCommittedMediaDescriptor<T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T>;
  withThreeSlotF2aCommittedMediaDescriptor<T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T>;
  withF2bScreenCommittedMediaDescriptor<T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T>;
  withF2bScreenControlsCommittedMediaDescriptor<T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T>;
  /** Returns Core's already bounded 64 KiB descriptor hash, without exposing the descriptor. */
  hashMedia(): Promise<Readonly<{ sha256: string; byteLength: number }>>;
  /** The bounded JSON bytes are copied before return and never expose Core's retained descriptor. */
  readReceipt(): Promise<Buffer>;
  /**
   * One active-scope, fresh retained-descriptor pair verification. It returns no media, receipt,
   * or descriptor facts: Core compares both fresh reads to its staged pair and rebinds the receipt.
   */
  verifyCurrentPair(): Promise<void>;
}>;

const pairObservations = new WeakMap<object, StrictSdrCandidateHeldPair>();
const completedPairs = new WeakSet<object>();
const completionTokens = new WeakMap<object, StrictSdrCandidateHeldPair>();

/** Take Core's successful post-callback completion once, after the whole consume promise resolves. */
export function takeStrictSdrCandidateHeldPairCompletion(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateHeldPairCompletion {
  if (!completedPairs.delete(pair as object)) throw new Error("Strict-SDR candidate pair has no unclaimed Core completion.");
  const token = Object.freeze({}) as StrictSdrCandidateHeldPairCompletion;
  completionTokens.set(token as object, pair);
  return token;
}

/** Consume only the original opaque completion for this exact pair, once. */
export function consumeStrictSdrCandidateHeldPairCompletion(pair: StrictSdrCandidateHeldPair, token: StrictSdrCandidateHeldPairCompletion): void {
  if (typeof token !== "object" || token === null || completionTokens.get(token as object) !== pair) {
    throw new Error("Strict-SDR candidate Core completion is forged, mismatched or already consumed.");
  }
  completionTokens.delete(token as object);
}

/** Matches only Core's exact active observation for the pair being consumed. */
export function matchesCurrentStrictSdrCandidateHeldPairObservation(pair: StrictSdrCandidateHeldPair, observation: unknown): boolean {
  return typeof observation === "object" && observation !== null && pairObservations.get(observation) === pair;
}

export function strictSdrCandidateOutputPublication(pair: StrictSdrCandidateHeldPair): DerivedOutputPublication {
  return strictSdrCandidateHeldPairState(pair).outputPublication;
}

export function strictSdrCandidateTerminalBinding(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateTerminalBinding {
  const state = strictSdrCandidateHeldPairState(pair);
  assertStrictSdrCandidateHeldPairOpen(state);
  return state.binding;
}

export async function withStrictSdrCandidateHeldPairRendering<T>(
  pair: StrictSdrCandidateHeldPair,
  expectedPreparation: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const state = strictSdrCandidateHeldPairState(pair);
  const workspace = strictSdrCandidateHeldWorkspaceState(state.workspace);
  assertStrictSdrCandidateHeldPairOpen(state);
  assertStrictSdrCandidatePreparationFingerprint(expectedPreparation);
  const active = activeStrictSdrCandidateHeldWorkspaceScope();
  if (!active || active.workspace !== state.workspace || active.expectedPreparation !== expectedPreparation) {
    throw new Error("Strict-SDR candidate renderer scope does not match its active Core workspace preparation.");
  }
  await assertStrictSdrCandidateHeldWorkspaceCurrent(workspace);
  return await withStrictSdrCandidateHeldPairRendererScope(pair, expectedPreparation, operation);
}

/** Stage a final receipt through the existing Core pair, then require its private observer fact. */
export async function stageStrictSdrCandidateFinalReceipt(
  pair: StrictSdrCandidateHeldPair,
  receipt: OperationReceipt,
  knownOutputEvidence?: DerivedFilePublicationEvidence
): Promise<void> {
  const state = strictSdrCandidateHeldPairState(pair);
  assertStrictSdrCandidateHeldPairOpen(state);
  await assertStrictSdrCandidateHeldWorkspaceCurrent(strictSdrCandidateHeldWorkspaceState(state.workspace));
  assertStrictSdrCandidateHeldPairRegistration(
    state.publication,
    strictSdrCandidateHeldWorkspaceState(state.workspace).authority,
    state.outputPublication
  );
  if (state.rendererClaimed && !state.adoptedStage) throw new Error("Strict-SDR candidate final receipt lacks its renderer-owned Core stage adoption.");
  await state.publication.stageReceipt(receipt, knownOutputEvidence);
  if (!state.stage) throw new Error("Strict-SDR candidate final receipt was staged without a Core-owned observer fact.");
  assertRendererAdoption(state, state.stage.output);
}

/** Commit only after the registered final receipt observer has recorded its exact bounded evidence. */
export async function commitStrictSdrCandidateHeldPair(
  pair: StrictSdrCandidateHeldPair,
  options: { cancelled?: () => boolean } = {}
): Promise<void> {
  const state = strictSdrCandidateHeldPairState(pair);
  assertStrictSdrCandidateHeldPairOpen(state);
  if (!state.stage) throw new Error("Strict-SDR candidate final receipt must be recorded before pair commit.");
  assertRendererAdoption(state, state.stage.output);
  const workspace = strictSdrCandidateHeldWorkspaceState(state.workspace);
  await assertStrictSdrCandidateHeldWorkspaceCurrent(workspace);
  assertStrictSdrCandidateHeldPairRegistration(state.publication, workspace.authority, state.outputPublication);
  const identity = await state.publication.commit(options);
  if (!identity) throw new Error("Strict-SDR candidate held pair did not retain its committed descriptor identity.");
  state.identity = identity;
  state.committed = true;
}

/**
 * Consume the retained pair once. Core validates the fixed receipt/output binding from retained
 * descriptors before exposing bounded media hash and receipt-read callbacks to the private child.
 */
export async function consumeStrictSdrCandidateHeldPair<T>(
  pair: StrictSdrCandidateHeldPair,
  evaluator: (observation: StrictSdrCandidateHeldPairObservation) => Promise<T> | T
): Promise<T> {
  const state = strictSdrCandidateHeldPairState(pair);
  if (!state.committed || !state.identity || !state.stage || state.consuming || state.closed) {
    throw new Error("Strict-SDR candidate held pair is not available for one-shot final receipt consumption.");
  }
  assertRendererAdoption(state, state.stage.output);
  state.consuming = true;
  let primary: unknown;
  let hasPrimary = false;
  let result!: T;
  try {
    result = await withRetainedPairedPublishedPairReadCapture(
      state.identity,
      { outputMaxBytes: STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES, receiptMaxBytes: STRICT_SDR_CANDIDATE_RECEIPT_MAX_BYTES },
      async (capture) => await consumeBoundCandidatePair(pair, state, capture, evaluator)
    );
  } catch (error) {
    primary = error;
    hasPrimary = true;
    throw error;
  } finally {
    state.closed = true;
    unregisterStrictSdrCandidateHeldPair(state.publication);
    await closeStrictSdrCandidateHeldPairAfterTerminal(state, primary, hasPrimary);
  }
  completedPairs.add(pair as object);
  return result;
}

/** Abort only an uncommitted candidate pair; failed workspaces are retained for forensic recovery. */
export async function abortStrictSdrCandidateHeldPair(pair: StrictSdrCandidateHeldPair): Promise<void> {
  const state = strictSdrCandidateHeldPairState(pair);
  if (state.committed) throw new Error("Committed strict-SDR candidate held pairs must be consumed, not aborted.");
  if (state.closed) return;
  state.closed = true;
  unregisterStrictSdrCandidateHeldPair(state.publication);
  let primary: unknown;
  let hasPrimary = false;
  try {
    await state.publication.abort();
  } catch (error) {
    primary = error;
    hasPrimary = true;
    throw error;
  } finally {
    await closeStrictSdrCandidateHeldPairAfterTerminal(state, primary, hasPrimary);
  }
}

async function consumeBoundCandidatePair<T>(
  pair: StrictSdrCandidateHeldPair,
  state: StrictSdrCandidateHeldPairState,
  capture: RetainedPairedPublishedPairReadCapability,
  evaluator: (observation: StrictSdrCandidateHeldPairObservation) => Promise<T> | T
): Promise<T> {
  const [media, receipt] = await Promise.all([capture.hashOutput(), capture.readReceipt()]);
  assertBoundCandidatePair(state, media, receipt);
  let observationActive = true;
  const mediaFacts = Object.freeze({ sha256: media.sha256, byteLength: media.byteLength });
  const observation = Object.freeze({
    media: mediaFacts,
    receipt: Object.freeze({ sha256: receipt.sha256, byteLength: receipt.byteLength }),
    withF2aCommittedMediaDescriptor: <T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T> => {
      return withCommittedMediaDescriptor(observationActive, state, "F2a", capture.withF2aCommittedOutputDescriptor, operation, mediaFacts);
    },
    withThreeSlotF2aCommittedMediaDescriptor: <T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T> =>
      withCommittedMediaDescriptor(observationActive, state, "three-slot F2a", capture.withThreeSlotF2aCommittedOutputDescriptor, operation, mediaFacts),
    withF2bScreenCommittedMediaDescriptor: <T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T> =>
      withCommittedMediaDescriptor(observationActive, state, "F2b screen", capture.withF2bScreenCommittedOutputDescriptor, operation, mediaFacts),
    withF2bScreenControlsCommittedMediaDescriptor: <T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T): Promise<T> =>
      withCommittedMediaDescriptor(observationActive, state, "F2b screen controls", capture.withF2bScreenControlsCommittedOutputDescriptor, operation, mediaFacts),
    hashMedia: async () => {
      if (!observationActive) throw new Error("Strict-SDR candidate final-pair observation expired after evaluator return.");
      return Object.freeze({ sha256: media.sha256, byteLength: media.byteLength });
    },
    readReceipt: async () => {
      if (!observationActive) throw new Error("Strict-SDR candidate final-pair observation expired after evaluator return.");
      return Buffer.from(receipt.bytes);
    },
    verifyCurrentPair: (): Promise<void> => {
      if (!observationActive) return Promise.reject(new Error("Strict-SDR candidate final-pair observation expired after evaluator return."));
      return capture.verifyCurrentPair((fresh) => {
        assertBoundCandidatePair(state, fresh.output, fresh.receipt);
      });
    },
  });
  pairObservations.set(observation, pair);
  try {
    return await evaluator(observation);
  } finally {
    observationActive = false;
    pairObservations.delete(observation);
  }
}

function assertBoundCandidatePair(
  state: StrictSdrCandidateHeldPairState,
  media: Readonly<{ sha256: string; byteLength: number }>,
  receipt: Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>
): void {
  assertRendererAdoption(state, media);
  if (
    media.sha256 !== state.stage!.output.sha256
    || media.byteLength !== state.stage!.output.byteLength
    || receipt.sha256 !== state.stage!.receipt.sha256
    || receipt.byteLength !== state.stage!.receipt.byteLength
  ) {
    throw new Error("Strict-SDR candidate retained pair changed after Core final receipt staging.");
  }
  const parsed = parseOperationReceipt(receipt.bytes);
  const accepted = assertPairedReceiptAcceptance(state.binding.receiptPath, parsed);
  if (
    accepted.outputPath !== resolve(state.binding.outputPath)
    || accepted.sha256 !== media.sha256
    || accepted.byteLength !== media.byteLength
    || Object.keys(accepted.secondaryArtifactHashes).length !== 0
  ) {
    throw new Error("Strict-SDR candidate final receipt does not bind the fixed held output pair.");
  }
}

function assertRendererAdoption(state: StrictSdrCandidateHeldPairState, output: Readonly<{ sha256: string; byteLength: number }>): void {
  if (!state.rendererClaimed) return;
  if (!state.adoptedStage || state.adoptedStage.sha256 !== output.sha256 || state.adoptedStage.byteLength !== output.byteLength) {
    throw new Error("Strict-SDR candidate final pair lacks its matching renderer-owned Core stage adoption.");
  }
}

function withCommittedMediaDescriptor<T>(
  active: boolean,
  state: StrictSdrCandidateHeldPairState,
  kind: StrictSdrCandidateHeldPairFinalizerKind,
  descriptor: <TValue>(operation: (fd: number) => Promise<TValue> | TValue) => Promise<TValue>,
  operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T,
  media: Readonly<{ sha256: string; byteLength: number }>,
): Promise<T> {
  if (!active) return Promise.reject(new Error("Strict-SDR candidate final-pair observation expired after evaluator return."));
  if (state.finalizerKind !== kind || !state.finalizer) {
    return Promise.reject(new Error("Strict-SDR candidate final-pair descriptor does not match its active resolved named finalizer."));
  }
  return descriptor((fd) => operation(Object.freeze({ fd, media })));
}

function parseOperationReceipt(bytes: Buffer): OperationReceipt {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Strict-SDR candidate retained receipt is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Strict-SDR candidate retained receipt is not an object.");
  }
  return value as OperationReceipt;
}
