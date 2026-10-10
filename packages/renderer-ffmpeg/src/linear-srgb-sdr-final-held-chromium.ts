import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLinearSrgbSdrFinalWebGpuProducer,
  type LinearSrgbSdrFinalWebGpuProducerResolution,
} from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import type { GpuStreamingJobContext } from "@shellx-motion/renderer-browser";
import {
  isStrictSdrCandidateHeldPairRendererBinding,
  type StrictSdrCandidateHeldPairRendererBinding,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";

type OpenRuntime = NonNullable<NonNullable<Parameters<typeof createLinearSrgbSdrFinalWebGpuProducer>[1]>["openRuntime"]>;
type RuntimeJob = Parameters<OpenRuntime>[0];
type HeldJob = Readonly<Pick<GpuStreamingJobContext, "signal" | "scratchRoot" | "maxProcessTreeRssBytes" | "watchProcess">>;

declare const executorBrand: unique symbol;

/** Candidate-child capability: it exposes only one exact runtime opener for one governed job. */
export interface StrictSdrCandidateHeldChromiumHost {
  open(job: HeldJob): ReturnType<OpenRuntime>;
}

/** Opaque single-use renderer capability; only the candidate holder scope can mint it. */
export interface StrictSdrCandidateHeldChromiumExecutor { readonly [executorBrand]: never; }

type Scope = {
  readonly open: StrictSdrCandidateHeldChromiumHost["open"];
  readonly preparationFingerprint: string;
  active: boolean;
  claimed: boolean;
};
type PinnedJob = Readonly<{
  readonly signal: AbortSignal;
  readonly scratchRoot: string;
  readonly maxProcessTreeRssBytes: number;
}>;
type ExecutorState = {
  readonly scope: Scope;
  readonly inputJob: HeldJob;
  readonly pinnedJob: PinnedJob;
  factoryCreated: boolean;
  opened: boolean;
};

const scopes = new AsyncLocalStorage<Scope>();
const executors = new WeakMap<object, ExecutorState>();

/**
 * Install one private child-owned Chromium opener for the dynamic candidate operation only.
 * The host method is captured once, so later host mutation cannot select another runtime.
 */
export async function withStrictSdrCandidateHeldChromium<T>(
  host: StrictSdrCandidateHeldChromiumHost,
  preparationFingerprint: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!validFingerprint(preparationFingerprint)) throw new Error("Strict SDR candidate Chromium scope requires one preparation fingerprint.");
  if (scopes.getStore()) throw new Error("Strict SDR candidate Chromium scopes cannot nest.");
  const capturedOpen = host && host.open;
  if (typeof capturedOpen !== "function") throw new Error("Strict SDR candidate Chromium scope requires its trusted holder opener.");
  const scope: Scope = {
    open: (job) => Reflect.apply(capturedOpen, host, [job]) as ReturnType<OpenRuntime>,
    preparationFingerprint,
    active: true,
    claimed: false,
  };
  try {
    return await scopes.run(scope, operation);
  } finally {
    scope.active = false;
  }
}

/**
 * Bind one live Core-held pair selector to the current holder and exact execution job before
 * Core consumes that selector. A missing, expired, mismatched, or duplicate holder always refuses.
 */
export function claimStrictSdrCandidateHeldChromium(
  binding: StrictSdrCandidateHeldPairRendererBinding,
  preparationFingerprint: string,
  inputJob: HeldJob,
): StrictSdrCandidateHeldChromiumExecutor {
  const scope = scopes.getStore();
  if (!scope?.active) throw new Error("Strict SDR candidate held Chromium is unavailable for this Core-held render.");
  if (!validFingerprint(preparationFingerprint) || scope.preparationFingerprint !== preparationFingerprint) {
    throw new Error("Strict SDR candidate held Chromium preparation does not match its active holder scope.");
  }
  if (!validHeldJob(inputJob)) throw new Error("Strict SDR candidate held Chromium requires one exact governed job.");
  if (!isStrictSdrCandidateHeldPairRendererBinding(binding)) {
    throw new Error("Strict SDR candidate held Chromium binding is absent, expired, or mismatched.");
  }
  if (scope.claimed) throw new Error("Strict SDR candidate held Chromium holder was already claimed.");
  scope.claimed = true;
  const executor = Object.freeze({}) as StrictSdrCandidateHeldChromiumExecutor;
  executors.set(executor as object, {
    scope,
    inputJob,
    pinnedJob: Object.freeze({
      signal: inputJob.signal,
      scratchRoot: inputJob.scratchRoot,
      maxProcessTreeRssBytes: inputJob.maxProcessTreeRssBytes,
    }),
    factoryCreated: false,
    opened: false,
  });
  return executor;
}

/**
 * Construct the existing canonical producer with the holder's single permitted openRuntime hook.
 * This accepts no page, Browser, FFmpeg, request, or generic producer authority.
 */
export function createStrictSdrCandidateHeldChromiumProducer(
  executor: StrictSdrCandidateHeldChromiumExecutor,
  inputJob: HeldJob,
  route: LinearSrgbSdrFinalRoute,
): LinearSrgbSdrFinalWebGpuProducerResolution {
  const state = executors.get(executor as object);
  if (!state || !state.scope.active) throw new Error("Strict SDR candidate held Chromium executor is absent or expired.");
  if (state.inputJob !== inputJob) throw new Error("Strict SDR candidate held Chromium executor does not match its claimed execution job.");
  if (state.factoryCreated) throw new Error("Strict SDR candidate held Chromium executor cannot create another producer.");
  state.factoryCreated = true;
  return createLinearSrgbSdrFinalWebGpuProducer(route, {
    openRuntime: async (processJob) => {
      if (!state.scope.active) throw new Error("Strict SDR candidate held Chromium scope expired before runtime opening.");
      if (state.opened) throw new Error("Strict SDR candidate held Chromium runtime was already opened.");
      if (!sameHeldJob(state.pinnedJob, processJob)) {
        throw new Error("Strict SDR candidate held Chromium runtime job does not match its admitted candidate job.");
      }
      state.opened = true;
      return await state.scope.open(processJob);
    },
  });
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validHeldJob(value: HeldJob): boolean {
  return !!value && typeof value.watchProcess === "function" && !!value.signal
    && typeof value.signal.aborted === "boolean" && typeof value.scratchRoot === "string"
    && value.scratchRoot.trim().length > 0 && Number.isSafeInteger(value.maxProcessTreeRssBytes)
    && value.maxProcessTreeRssBytes >= 64 * 1024 * 1024;
}

function sameHeldJob(expected: PinnedJob, actual: RuntimeJob): boolean {
  return actual.signal === expected.signal
    && actual.scratchRoot === expected.scratchRoot
    && actual.maxProcessTreeRssBytes === expected.maxProcessTreeRssBytes;
}
