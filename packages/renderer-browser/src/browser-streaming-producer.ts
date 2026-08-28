import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { streamingFrameTimestampMs, type MotionPackage } from "@shellx-motion/core";
import {
  createMotionBrowserRenderSession,
  type BrowserCaptureWorkflow,
  type BrowserNetworkAccessOptions,
  type BrowserRenderSessionOptions,
  type MotionBrowserRenderSessionFactory
} from "./index";
import {
  markBrowserStreamingSessionOptions,
  renderBrowserStreamingFrame,
  type InternalBrowserStreamingFrame,
  type InternalBrowserStreamingJobContext
} from "./browser-streaming-session-registry";
import {
  emptyStreamingEvidence,
  observeFrameEvidence,
  type BrowserStreamingFrameProducerEvidence
} from "./browser-streaming-producer-evidence";
import {
  resolveBrowserStreamingFrameRange,
  type BrowserStreamingFrameRange,
  type BrowserStreamingFrameRangeEvidence
} from "./browser-streaming-frame-range";
export type {
  BrowserStreamingFrameProducerEvidence,
  BrowserStreamingProcessMonitoringEvidence,
  BrowserStreamingSessionEvidence,
  BrowserStreamingTerminalFrameEvidence
} from "./browser-streaming-producer-evidence";
export type { BrowserStreamingFrameRange, BrowserStreamingFrameRangeEvidence } from "./browser-streaming-frame-range";

/** FFmpeg-compatible one-frame handoff. The sink owns a PNG only until `write` resolves. */
export interface BrowserStreamingFrameSink {
  write(frame: { index: number; atMs: number; png: Buffer }): Promise<void>;
}

export interface BrowserStreamingFrameProducerInput {
  pkg: MotionPackage;
  /** Optional closed-open selection over the package's canonical full timeline. */
  range?: BrowserStreamingFrameRange;
  /** Captured workflows are refused until their state can be replayed in one bounded session. */
  workflow?: BrowserCaptureWorkflow;
  networkAccess?: BrowserNetworkAccessOptions;
  /** Host/test seam for the one Chromium process owned by one producer attempt. */
  launchBrowser?: BrowserRenderSessionOptions["launchBrowser"];
  /** Internal host binding for the one session; never populated from a wire request. */
  sessionFactory?: MotionBrowserRenderSessionFactory;
}

export interface BrowserStreamingFrameProducerMetrics {
  readonly delivery: "streamed";
  readonly ordering: "canonical-index-timestamp";
  readonly frameCount: number;
  /** Full canonical package timeline count, retained even when this attempt selects a range. */
  readonly timelineFrameCount: number;
  /** The selected canonical interval; `frameCount` is this interval's length. */
  readonly range: Readonly<BrowserStreamingFrameRangeEvidence>;
  readonly emittedFrames: number;
  readonly activeFrameHandoffs: number;
  readonly peakConcurrentFrameHandoffs: number;
  readonly activePngBuffers: number;
  readonly peakPngBuffers: number;
  /** No source PNG is materialized; the producer releases its one buffer after the awaited handoff. */
  readonly retainedFrameCount: 0;
  readonly sourcePngsRetained: 0;
  /** The producer session creates no materialized-frame cache. */
  readonly sessionFrameCacheEntries: 0;
}

/** A reusable callback object for a pre-acquired FFmpeg/governor job. */
export interface BrowserStreamingFrameProducer {
  /** Selected range length; without `range`, this remains the complete timeline count. */
  readonly frameCount: number;
  readonly timelineFrameCount: number;
  readonly range: Readonly<BrowserStreamingFrameRangeEvidence>;
  readonly durationMs: number;
  readonly fps: number;
  readonly metrics: Readonly<BrowserStreamingFrameProducerMetrics>;
  readonly evidence: Readonly<BrowserStreamingFrameProducerEvidence>;
  produce(sink: BrowserStreamingFrameSink, job: InternalBrowserStreamingJobContext): Promise<void>;
}

export class BrowserStreamingProducerCapabilityError extends Error {
  readonly code = "browser_streaming_workflow_unsupported";
  readonly evidence = {
    capability: "captured-browser-workflow",
    supported: false as const,
    reason: "A streamed browser producer cannot lower captured workflow state to independent frames."
  };

  constructor() {
    super("Browser streamed final rendering does not yet support captured browser workflows; use the materialized browser sequence path.");
    this.name = "BrowserStreamingProducerCapabilityError";
    Object.setPrototypeOf(this, BrowserStreamingProducerCapabilityError.prototype);
  }
}

export class BrowserStreamingProducerBusyError extends Error {
  readonly code = "browser_streaming_producer_busy";

  constructor() {
    super("Browser streamed frame producer is already active; one producer instance has exactly one frame handoff at a time.");
    this.name = "BrowserStreamingProducerBusyError";
    Object.setPrototypeOf(this, BrowserStreamingProducerBusyError.prototype);
  }
}

export class BrowserStreamingProducerCleanupError extends Error {
  readonly code = "browser_streaming_cleanup_failed";

  constructor(
    readonly primaryCause: unknown | undefined,
    readonly closeCause: unknown | undefined,
    readonly scratchCleanupCause: unknown | undefined
  ) {
    super("Browser streamed producer cleanup failed.", { cause: primaryCause ?? closeCause ?? scratchCleanupCause });
    this.name = "BrowserStreamingProducerCleanupError";
    Object.setPrototypeOf(this, BrowserStreamingProducerCleanupError.prototype);
  }
}

/**
 * Creates a renderer-owned source callback for `runStreamingFfmpegFinal`. The encoder already owns
 * the governor lease, so this function deliberately has no governor option and never calls
 * `governor.run`. Materialized `renderFrame` and `renderFrames` retain their existing cache/list
 * behavior; this path receives one validated PNG buffer, awaits the sink, and releases its buffer
 * reference before rendering the next canonical timestamp.
 */
export function createBrowserStreamingFrameProducer(
  input: BrowserStreamingFrameProducerInput
): BrowserStreamingFrameProducer {
  if (input.workflow) throw new BrowserStreamingProducerCapabilityError();
  const { durationMs, fps } = input.pkg.motion;
  const timelineFrameCount = canonicalFrameCount(durationMs, fps);
  const range = Object.freeze(resolveBrowserStreamingFrameRange(input.range, timelineFrameCount));
  const frameCount = range.frameCount;
  const metrics: {
    delivery: "streamed";
    ordering: "canonical-index-timestamp";
    frameCount: number;
    timelineFrameCount: number;
    range: BrowserStreamingFrameRangeEvidence;
    emittedFrames: number;
    activeFrameHandoffs: number;
    peakConcurrentFrameHandoffs: number;
    activePngBuffers: number;
    peakPngBuffers: number;
    retainedFrameCount: 0;
    sourcePngsRetained: 0;
    sessionFrameCacheEntries: 0;
  } = {
    delivery: "streamed",
    ordering: "canonical-index-timestamp",
    frameCount,
    timelineFrameCount,
    range,
    emittedFrames: 0,
    activeFrameHandoffs: 0,
    peakConcurrentFrameHandoffs: 0,
    activePngBuffers: 0,
    peakPngBuffers: 0,
    retainedFrameCount: 0,
    sourcePngsRetained: 0,
    sessionFrameCacheEntries: 0
  };
  let evidence = emptyStreamingEvidence(range);
  let active = false;

  return {
    frameCount,
    timelineFrameCount,
    range,
    durationMs,
    fps,
    metrics,
    get evidence() {
      return evidence;
    },
    async produce(sink, job) {
      if (job.admission !== "pre-acquired") {
        throw new Error("Browser streamed frame producer requires a pre-acquired job context.");
      }
      if (active) throw new BrowserStreamingProducerBusyError();
      active = true;
      resetAttemptMetrics(metrics);
      evidence = emptyStreamingEvidence(range);
      evidence.session.state = "opening";
      evidence.session.cleanup = "pending";
      let session: Awaited<ReturnType<typeof createMotionBrowserRenderSession>> | undefined;
      let streamRoot: string | undefined;
      let operationError: unknown | undefined;
      let sessionOpenFailed = false;
      try {
        throwIfAborted(job.signal);
        // Logical job ids may deliberately be duplicated across isolated runs. A fresh directory
        // prevents one admitted producer from deleting another producer's private scratch.
        streamRoot = await mkdtemp(join(job.scratchRoot, "browser-stream-"));
        const framePath = join(streamRoot, "frame.png");
        throwIfAborted(job.signal);
        const sessionOptions: BrowserRenderSessionOptions = {
          networkAccess: input.networkAccess,
          ...(input.launchBrowser ? { launchBrowser: input.launchBrowser } : {})
        };
        markBrowserStreamingSessionOptions(sessionOptions);
        try {
          session = await (input.sessionFactory ?? createMotionBrowserRenderSession)(input.pkg, sessionOptions);
        } catch (error) {
          sessionOpenFailed = true;
          throw error;
        }
        evidence.session.state = "rendering";
        for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
          throwIfAborted(job.signal);
          const atMs = streamingFrameTimestampMs(index, fps, durationMs);
          let captured: InternalBrowserStreamingFrame | undefined = await renderBrowserStreamingFrame(
            session,
            { atMs, outDir: streamRoot, outputPath: framePath },
            job
          );
          let png: Buffer | undefined = captured.png;
          observeFrameEvidence(evidence, captured.result, index, atMs);
          captured = undefined;
          if (!png) throw new Error("Browser streamed frame did not provide a validated PNG buffer.");
          metrics.activePngBuffers += 1;
          metrics.peakPngBuffers = Math.max(metrics.peakPngBuffers, metrics.activePngBuffers);
          metrics.activeFrameHandoffs += 1;
          metrics.peakConcurrentFrameHandoffs = Math.max(
            metrics.peakConcurrentFrameHandoffs,
            metrics.activeFrameHandoffs
          );
          try {
            throwIfAborted(job.signal);
            await sink.write({ index, atMs, png });
            metrics.emittedFrames += 1;
            throwIfAborted(job.signal);
          } finally {
            // The awaited sink is the final consumer. Release this producer's only reference
            // before reporting zero active buffers; no scratch PNG was created for the handoff.
            png = undefined;
            metrics.activeFrameHandoffs -= 1;
            metrics.activePngBuffers -= 1;
          }
        }
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        if (session) evidence.session.state = "closing";
        else evidence.session.state = sessionOpenFailed ? "open_failed" : "not_opened";
        let closeCause: unknown | undefined;
        let scratchCleanupCause: unknown | undefined;
        try {
          await session?.close();
        } catch (error) {
          closeCause = error;
        } finally {
          try {
            // The exact per-job producer directory is private scratch, not caller output. It also
            // clears capture preparation artifacts if a browser-layer render failed before screenshot.
            if (streamRoot) await rm(streamRoot, { recursive: true, force: true });
          } catch (error) {
            scratchCleanupCause = error;
          }
          const cleanupFailed = closeCause !== undefined || scratchCleanupCause !== undefined;
          if (cleanupFailed) evidence.session.state = "cleanup_failed";
          else if (session) evidence.session.state = "closed";
          evidence.session.cleanup = cleanupFailed ? "failed" : "complete";
          active = false;
        }
        if (closeCause !== undefined || scratchCleanupCause !== undefined) {
          throw new BrowserStreamingProducerCleanupError(operationError, closeCause, scratchCleanupCause);
        }
      }
    }
  };
}

function canonicalFrameCount(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

function resetAttemptMetrics(metrics: {
  emittedFrames: number;
  activeFrameHandoffs: number;
  peakConcurrentFrameHandoffs: number;
  activePngBuffers: number;
  peakPngBuffers: number;
}): void {
  metrics.emittedFrames = 0;
  metrics.activeFrameHandoffs = 0;
  metrics.peakConcurrentFrameHandoffs = 0;
  metrics.activePngBuffers = 0;
  metrics.peakPngBuffers = 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Browser streamed frame producer was cancelled.");
}
