/**
 * One-frame-at-a-time native PNG producer for a future bounded encoder handoff.
 *
 * The package root exports this structural match for the FFmpeg streaming callback: the encoder owns
 * admission and backpressure; the native lane owns only its loaded render session and emits one
 * ephemeral PNG at a time.
 */
import {
  LocalMotionJobError,
  streamingFrameTimestampMs,
  type OperationReceipt,
} from "@shellx-motion/core";
import {
  createNativeRenderSession,
  INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
  type CreateNativeRenderSessionInput,
  type NativePreviewError,
  type NativeRenderSession,
} from "./index";
import {
  assertNativeFrameProducerTimeline,
  resolveNativeFrameProducerRange,
  type NativeFrameProducerRange,
  type NativeFrameProducerRangeEvidence
} from "./native-frame-range";
export type { NativeFrameProducerRange, NativeFrameProducerRangeEvidence } from "./native-frame-range";

/** The bounded encoder callback shape; `write` must resolve before the next frame is rendered. */
export interface NativeStreamingFrameSink {
  write(frame: { index: number; atMs: number; png: Buffer }): Promise<void>;
}

/**
 * Minimal structural view of an already-admitted Core job. It intentionally has no governor or
 * scheduling method: this producer cannot acquire a nested slot or lease.
 */
export interface NativeStreamingJobContext {
  readonly admission: "pre-acquired";
  readonly jobId: string;
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
}

/** A future streaming encoder can pass its existing producer context directly; extra fields are ignored. */
export interface NativeFrameProducerContext {
  readonly signal: AbortSignal;
  readonly job: NativeStreamingJobContext;
}

export interface NativeFrameProducerInput {
  packageRoot: string;
  /**
   * The canonical full-timeline count. This legacy field remains required and must equal
   * `ceil(durationMs / 1000 * fps)`; `range` only selects a closed-open interval within it.
   */
  frameCount: number;
  fps: number;
  durationMs: number;
  range?: NativeFrameProducerRange;
  /** Testable receipt clock forwarded to the loaded native session. */
  now?: () => string;
}

/**
 * Bounded producer evidence for a future encoder receipt. Decoded package assets are session-owned
 * render inputs, not frame retention, so they are described separately from the zero-entry frame
 * caches below.
 */
export interface NativeFrameProducerEvidence {
  schema: "shellx-motion/native-frame-producer-evidence@1";
  producer: {
    timelineFrameCount: number;
    range: NativeFrameProducerRangeEvidence;
    frameCacheEntries: 0;
    emittedFrameCount: number;
    inFlightPngHandoffs: number;
    peakInFlightPngHandoffs: number;
  };
  session: {
    cleanupState: "not_opened" | "open" | "closed" | "close_failed";
    frameCacheEntries: 0;
    assetCache: {
      scope: "native-render-session-decoded-assets";
      includedInFrameRetention: false;
    };
  };
  terminal: {
    /** One receipt only: the latest successfully rendered or native-refused frame. */
    lastFrameReceipt: OperationReceipt | null;
    laneWarnings: string[];
    /** Bounded layer metadata a future delivery adapter may resolve without retaining frames. */
    downstreamAudioHandoffLayers: Array<{ id: string; type: string }>;
  };
}

type NativeFrameProducerTerminalResult =
  | { ok: true; emittedFrameCount: number }
  | {
      ok: false;
      emittedFrameCount: number;
      error: NativePreviewError;
      receipt: OperationReceipt;
      warnings: string[];
    };

/** Small terminal result only; no frame paths, PNGs, results, or sequence arrays are retained. */
export type NativeFrameProducerResult =
  | { ok: true; emittedFrameCount: number; evidence: NativeFrameProducerEvidence }
  | {
      ok: false;
      emittedFrameCount: number;
      error: NativePreviewError;
      receipt: OperationReceipt;
      warnings: string[];
      evidence: NativeFrameProducerEvidence;
    };

type OpenNativeRenderSession = (input: CreateNativeRenderSessionInput) => Promise<NativeRenderSession>;

/** Internal test seam; production always opens the real, load-once native session. */
export interface NativeFrameProducerServices {
  openSession?: OpenNativeRenderSession;
  /** Test-only observation point for backpressure and retention invariants. */
  observeRetention?: (evidence: NativeFrameProducerEvidence) => void;
}

const failureEvidence = new WeakMap<object, NativeFrameProducerEvidence>();

/**
 * Bounded wrapper used only when a sink throws a primitive. Object failures keep their original
 * identity (including frozen Error instances) and are associated with evidence in a WeakMap.
 */
export class NativeFrameProducerFailure extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(`Native frame production failed: ${String(cause)}`);
    this.name = "NativeFrameProducerFailure";
    this.cause = cause;
  }
}

/** Preserves both an operation failure and a later close failure without discarding either cause. */
export class NativeFrameProducerCleanupFailure extends Error {
  readonly cause: unknown;

  constructor(readonly primaryFailure: unknown, readonly cleanupFailure: unknown, readonly hadPrimaryFailure: boolean) {
    super(
      !hadPrimaryFailure
        ? `Native frame session cleanup failed: ${String(cleanupFailure)}`
        : `Native frame session cleanup failed after ${String(primaryFailure)}: ${String(cleanupFailure)}`,
    );
    this.name = "NativeFrameProducerCleanupFailure";
    this.cause = hadPrimaryFailure ? primaryFailure : cleanupFailure;
  }
}

/**
 * Produce canonical native delivery frames through a backpressured sink.
 *
 * The session is opened once and always closed. A frame's PNG remains reachable only while the
 * caller awaits `sink.write`; the next frame is not rendered until that write resolves. Existing
 * capability and text-delivery refusals are returned unchanged from the native session.
 */
export async function produceNativeFrameStream(
  input: NativeFrameProducerInput,
  sink: NativeStreamingFrameSink,
  context: NativeFrameProducerContext,
  services: NativeFrameProducerServices = {},
): Promise<NativeFrameProducerResult> {
  assertNativeFrameProducerTimeline(input);
  const range = Object.freeze(resolveNativeFrameProducerRange(input.range, input.frameCount));
  if (context.job.admission !== "pre-acquired") {
    throw new Error("Native frame production requires a pre-acquired job admission.");
  }
  throwIfStopped(context);

  const metrics = {
    emittedFrameCount: 0,
    inFlightPngHandoffs: 0,
    peakInFlightPngHandoffs: 0,
  };
  let cleanupState: NativeFrameProducerEvidence["session"]["cleanupState"] = "not_opened";
  let lastFrameReceipt: OperationReceipt | null = null;
  const laneWarnings: string[] = [];
  const seenWarnings = new Set<string>();
  const downstreamAudioHandoffLayers: Array<{ id: string; type: string }> = [];
  const observeFrame = (receipt: OperationReceipt): void => {
    lastFrameReceipt = receipt;
    for (const warning of receipt.warnings) {
      if (seenWarnings.has(warning)) continue;
      seenWarnings.add(warning);
      laneWarnings.push(warning);
    }
    const layers = record(receipt.output)?.audioHandoff;
    const audioHandoff = record(layers);
    if (!audioHandoff || audioHandoff.status !== "handled_downstream") return;
    for (const layer of Array.isArray(audioHandoff.layers) ? audioHandoff.layers : []) {
      const entry = record(layer);
      if (!entry || typeof entry.id !== "string" || typeof entry.type !== "string"
        || downstreamAudioHandoffLayers.some((known) => known.id === entry.id)) continue;
      downstreamAudioHandoffLayers.push({ id: entry.id, type: entry.type });
    }
  };
  const evidence = (): NativeFrameProducerEvidence => ({
    schema: "shellx-motion/native-frame-producer-evidence@1",
    producer: {
      timelineFrameCount: input.frameCount,
      range: { ...range },
      frameCacheEntries: 0,
      emittedFrameCount: metrics.emittedFrameCount,
      inFlightPngHandoffs: metrics.inFlightPngHandoffs,
      peakInFlightPngHandoffs: metrics.peakInFlightPngHandoffs,
    },
    session: {
      cleanupState,
      frameCacheEntries: 0,
      assetCache: {
        scope: "native-render-session-decoded-assets",
        includedInFrameRetention: false,
      },
    },
    terminal: {
      lastFrameReceipt,
      laneWarnings: [...laneWarnings],
      downstreamAudioHandoffLayers: downstreamAudioHandoffLayers.map((layer) => ({ ...layer })),
    },
  });
  const observe = (): void => services.observeRetention?.(evidence());
  observe();

  let session: NativeRenderSession | undefined;
  let terminalResult: NativeFrameProducerTerminalResult | undefined;
  let terminalFailure: unknown;
  let failed = false;
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    session = await (services.openSession ?? createNativeRenderSession)({
      packageRoot: input.packageRoot,
      renderTarget: "delivery",
      pngCompressionLevel: INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
      ...(input.now ? { now: input.now } : {}),
    });
    cleanupState = "open";
    for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
      throwIfStopped(context);
      const atMs = streamingFrameTimestampMs(index, input.fps, input.durationMs);
      const rendered = await session.renderFrameAtMs(atMs);
      observeFrame(rendered.receipt);
      throwIfStopped(context);
      if (!rendered.ok) {
        terminalResult = {
          ok: false,
          emittedFrameCount: metrics.emittedFrameCount,
          error: rendered.error,
          receipt: rendered.receipt,
          warnings: [...laneWarnings],
        };
        break;
      }
      // Awaiting the sink is the producer's backpressure boundary. Do not collect an output list:
      // this scope owns one PNG only, and it ends before the next render begins.
      metrics.inFlightPngHandoffs += 1;
      metrics.peakInFlightPngHandoffs = Math.max(
        metrics.peakInFlightPngHandoffs,
        metrics.inFlightPngHandoffs,
      );
      observe();
      try {
        await sink.write({ index, atMs, png: rendered.frame.png });
        metrics.emittedFrameCount += 1;
      } finally {
        metrics.inFlightPngHandoffs -= 1;
        observe();
      }
      throwIfStopped(context);
    }
    terminalResult ??= { ok: true, emittedFrameCount: metrics.emittedFrameCount };
  } catch (error) {
    failed = true;
    terminalFailure = error;
  } finally {
    try {
      if (session) {
        session.close();
        cleanupState = "closed";
      }
    } catch (error) {
      cleanupState = "close_failed";
      cleanupFailure = error;
      cleanupFailed = true;
    } finally {
      observe();
    }
  }
  const terminalEvidence = evidence();
  if (failed || cleanupFailed) {
    const failure = cleanupFailed
      ? new NativeFrameProducerCleanupFailure(terminalFailure, cleanupFailure, failed)
      : terminalFailure;
    throw associateFailureEvidence(failure, terminalEvidence);
  }
  if (!terminalResult) throw new Error("Native frame production ended without a terminal result.");
  return { ...terminalResult, evidence: terminalEvidence };
}

function throwIfStopped(context: NativeFrameProducerContext): void {
  if (context.signal.aborted) throw abortReason(context.signal);
  if (context.job.signal.aborted) throw abortReason(context.job.signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new LocalMotionJobError("job_cancelled", "Native frame production was cancelled.");
}

/** Lets a later encoder adapter include terminal evidence for rejected cancellation or sink failures. */
export function getNativeFrameProducerFailureEvidence(error: unknown): NativeFrameProducerEvidence | undefined {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    return failureEvidence.get(error);
  }
  return undefined;
}

function associateFailureEvidence(error: unknown, evidence: NativeFrameProducerEvidence): unknown {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    failureEvidence.set(error, evidence);
    return error;
  }
  const wrapped = new NativeFrameProducerFailure(error);
  failureEvidence.set(wrapped, evidence);
  return wrapped;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
