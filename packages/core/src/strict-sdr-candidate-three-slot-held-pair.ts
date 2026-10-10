/** Closed renderer-binding adapters for the private three-slot strict-SDR diagnostic. */
import type { DerivedFilePublicationEvidence, DerivedOutputPublication } from "./derived-output-publication";
import type { StrictSdrCandidateHeldPair, StrictSdrCandidateHeldPairRendererBinding } from "./strict-sdr-candidate-held-pair";
import {
  activeStrictSdrCandidateHeldPairRendererScope,
  assertStrictSdrCandidateHeldPairOpen,
  assertStrictSdrCandidatePreparationFingerprint,
  strictSdrCandidateHeldPairState,
  STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES,
  type StrictSdrCandidateHeldPairFinalizerKind,
} from "./strict-sdr-candidate-held-workspace";

type RendererBindingState = Readonly<{
  pair: StrictSdrCandidateHeldPair;
  consumed: boolean;
  resolved: boolean;
  token: object;
}>;

const rendererBindings = new WeakMap<object, RendererBindingState>();
const recordingStages = new WeakSet<object>();

/** Normal rendering gets undefined; candidate claims must match the live Core renderer scope. */
export function claimCurrentStrictSdrCandidateHeldPairRendererBinding(
  outputPublication: DerivedOutputPublication,
  actualPreparation: string,
  actualOutputPath: string,
): StrictSdrCandidateHeldPairRendererBinding | undefined {
  const scope = activeStrictSdrCandidateHeldPairRendererScope();
  if (!scope) return undefined;
  if (!scope.token.active) throw new Error("Strict-SDR candidate renderer scope expired before its binding claim.");
  assertStrictSdrCandidatePreparationFingerprint(actualPreparation);
  const state = strictSdrCandidateHeldPairState(scope.pair);
  if (
    state.closed || state.committed || state.consuming || state.outputPublication !== outputPublication
    || scope.expectedPreparation !== actualPreparation || state.binding.outputPath !== actualOutputPath || state.rendererClaimed
  ) {
    throw new Error("Strict-SDR candidate renderer claim does not match its Core-held pair, preparation, and logical output path.");
  }
  state.rendererClaimed = true;
  const binding = Object.freeze({}) as StrictSdrCandidateHeldPairRendererBinding;
  rendererBindings.set(binding as object, Object.freeze({ pair: scope.pair, consumed: false, resolved: false, token: scope.token }));
  return binding;
}

/** Record only the exact Core private stage copied by the consumed renderer operation. */
export async function recordStrictSdrCandidateHeldMediaStage(
  binding: StrictSdrCandidateHeldPairRendererBinding,
  publication: DerivedOutputPublication,
): Promise<DerivedFilePublicationEvidence> {
  const scope = activeStrictSdrCandidateHeldPairRendererScope();
  const bound = rendererBindings.get(binding as object);
  if (!scope?.token.active || !bound || bound.pair !== scope.pair || bound.token !== scope.token || !bound.consumed) {
    throw new Error("Strict-SDR held-media stage binding is forged, expired, mismatched, or unconsumed.");
  }
  const state = strictSdrCandidateHeldPairState(bound.pair);
  assertStrictSdrCandidateHeldPairOpen(state);
  if (state.outputPublication !== publication || !state.rendererClaimed || state.adoptedStage || state.stage || recordingStages.has(bound.pair)) {
    throw new Error("Strict-SDR held-media stage does not match one unrecorded Core pair publication.");
  }
  recordingStages.add(bound.pair);
  try {
    const verified = await publication.verifyPrivateFile({
      label: "Strict-SDR renderer-adopted Core media stage",
      maxBytes: STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES,
    });
    if (!scope.token.active || activeStrictSdrCandidateHeldPairRendererScope()?.token !== scope.token || state.stage) {
      throw new Error("Strict-SDR held-media stage verification outlived its renderer scope or pair stage.");
    }
    assertStrictSdrCandidateHeldPairOpen(state);
    state.adoptedStage = Object.freeze({ ...verified });
    return state.adoptedStage;
  } finally {
    recordingStages.delete(bound.pair);
  }
}

/** Candidate-only equivalence check for preflight and plan; it mints no capability. */
export function matchesCurrentStrictSdrCandidateHeldPairRendererInput(
  outputPublication: DerivedOutputPublication | undefined,
  actualPreparation: string | undefined,
  actualOutputPath: string,
): boolean {
  const scope = activeStrictSdrCandidateHeldPairRendererScope();
  if (!scope || !scope.token.active || typeof actualPreparation !== "string") return false;
  const state = strictSdrCandidateHeldPairState(scope.pair);
  return !state.closed && !state.committed && !state.consuming && !state.rendererClaimed
    && state.outputPublication === outputPublication && scope.expectedPreparation === actualPreparation && state.binding.outputPath === actualOutputPath;
}

/** Renderer can reject forged, expired, or already consumed bindings without pair/path authority. */
export function isStrictSdrCandidateHeldPairRendererBinding(binding: unknown): binding is StrictSdrCandidateHeldPairRendererBinding {
  if (!binding || typeof binding !== "object") return false;
  const bindingState = rendererBindings.get(binding as object), scope = activeStrictSdrCandidateHeldPairRendererScope();
  if (!bindingState || !scope || !scope.token.active || bindingState.pair !== scope.pair || bindingState.consumed) return false;
  const state = strictSdrCandidateHeldPairState(scope.pair);
  return !state.closed && !state.committed && !state.consuming;
}

/** Consume the renderer selector exactly once while its matching Core renderer scope remains live. */
export function consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding: StrictSdrCandidateHeldPairRendererBinding): void {
  if (!isStrictSdrCandidateHeldPairRendererBinding(binding)) {
    throw new Error("Strict-SDR candidate renderer binding is forged, expired, mismatched, or already consumed.");
  }
  const bindingState = rendererBindings.get(binding as object)!;
  rendererBindings.set(binding as object, Object.freeze({ ...bindingState, consumed: true }));
}

/** Existing one-slot F2a adapter; its name and lifecycle remain unchanged. */
export function strictSdrCandidateHeldPairForConsumedRendererBinding(binding: StrictSdrCandidateHeldPairRendererBinding): StrictSdrCandidateHeldPair {
  return resolveConsumedRendererBinding(binding, "F2a");
}

/** Existing one-slot F2a finalizer adapter; its name and lifecycle remain unchanged. */
export function registerStrictSdrCandidateF2aFinalizer(pair: StrictSdrCandidateHeldPair, finalizer: () => Promise<void>): void {
  registerNamedFinalizer(pair, "F2a", finalizer);
}

export function strictSdrCandidateHeldPairForConsumedThreeSlotF2aRendererBinding(binding: StrictSdrCandidateHeldPairRendererBinding): StrictSdrCandidateHeldPair {
  return resolveConsumedRendererBinding(binding, "three-slot F2a");
}

export function registerStrictSdrCandidateThreeSlotF2aFinalizer(pair: StrictSdrCandidateHeldPair, finalizer: () => Promise<void>): void {
  registerNamedFinalizer(pair, "three-slot F2a", finalizer);
}

export function strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding(binding: StrictSdrCandidateHeldPairRendererBinding): StrictSdrCandidateHeldPair {
  return resolveConsumedRendererBinding(binding, "F2b screen");
}

export function registerStrictSdrCandidateF2bScreenFinalizer(pair: StrictSdrCandidateHeldPair, finalizer: () => Promise<void>): void {
  registerNamedFinalizer(pair, "F2b screen", finalizer);
}

export function strictSdrCandidateHeldPairForConsumedF2bScreenControlsRendererBinding(binding: StrictSdrCandidateHeldPairRendererBinding): StrictSdrCandidateHeldPair {
  return resolveConsumedRendererBinding(binding, "F2b screen controls");
}

export function registerStrictSdrCandidateF2bScreenControlsFinalizer(pair: StrictSdrCandidateHeldPair, finalizer: () => Promise<void>): void {
  registerNamedFinalizer(pair, "F2b screen controls", finalizer);
}

function resolveConsumedRendererBinding(binding: StrictSdrCandidateHeldPairRendererBinding, kind: StrictSdrCandidateHeldPairFinalizerKind): StrictSdrCandidateHeldPair {
  const scope = activeStrictSdrCandidateHeldPairRendererScope(), bindingState = rendererBindings.get(binding as object);
  if (!scope?.token.active || !bindingState || bindingState.pair !== scope.pair || !bindingState.consumed || bindingState.resolved) {
    throw new Error(`Strict-SDR candidate ${kind} renderer binding is forged, expired, unconsumed, mismatched, or already resolved.`);
  }
  const state = strictSdrCandidateHeldPairState(scope.pair);
  assertStrictSdrCandidateHeldPairOpen(state);
  if (state.finalizerKind) throw new Error(`Strict-SDR candidate ${kind} pair was already resolved from its renderer binding.`);
  state.finalizerKind = kind;
  rendererBindings.set(binding as object, Object.freeze({ ...bindingState, resolved: true }));
  return scope.pair;
}

function registerNamedFinalizer(pair: StrictSdrCandidateHeldPair, kind: StrictSdrCandidateHeldPairFinalizerKind, finalizer: () => Promise<void>): void {
  const scope = activeStrictSdrCandidateHeldPairRendererScope(), state = strictSdrCandidateHeldPairState(pair);
  if (!scope?.token.active || scope.pair !== pair || state.finalizerKind !== kind || state.finalizer || state.finalizerRan || typeof finalizer !== "function") {
    throw new Error(`Strict-SDR candidate ${kind} finalizer does not match one live resolved renderer pair.`);
  }
  assertStrictSdrCandidateHeldPairOpen(state);
  state.finalizer = finalizer;
}
