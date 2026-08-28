import {
  completeTrackingAnalysis,
  createTrackingAnalysisLifecycle,
  createTrackingOperationReceipt,
  invalidateTrackingAnalysis,
  assertTrackingAnalysisLifecycle,
  assertTrackingAnalysisRequest,
  retryTrackingAnalysis,
  solveFixedTrackingAnalysis,
  startTrackingAnalysis,
  stopTrackingAnalysis,
  type LocalMotionJobEvidence,
  type OperationReceipt,
  type TrackingAnalysis,
  type TrackingAnalysisLifecycle,
  type TrackingAnalysisSettings,
  type TrackingSourceIdentity,
  type TrackingTransformModel,
} from "@shellx-motion/core";
import {
  decodeTrackingLumaSnapshot,
  inspectTrackingMediaSnapshot,
  retainTrackingMediaInput,
  type TrackingMediaCommandRunner,
} from "./tracking-media-input.js";
export {
  decodeTrackingLumaFrames,
  inspectTrackingMediaSource,
  MAX_TRACKING_MEDIA_BYTES,
} from "./tracking-media-input.js";
export type { TrackingMediaCommandContext, TrackingMediaCommandRunner } from "./tracking-media-input.js";

export interface AnalyzeTrackingMediaInput {
  id: string;
  assetId: string;
  sourcePath: string;
  /** Host-admitted package root that contains sourcePath. */
  inputRoot: string;
  mode: "point" | "planar";
  model: TrackingTransformModel;
  reference: TrackingAnalysis["reference"];
  settings: TrackingAnalysisSettings;
  scratchRoot: string;
  packageId: string;
  createdAt?: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  /** A persisted final lifecycle enables explicit retries without discarding lastGood. */
  existingLifecycle?: TrackingAnalysisLifecycle;
}

export type AnalyzeTrackingMediaResult =
  | {
      ok: true;
      source: TrackingSourceIdentity;
      analysis: TrackingAnalysis;
      lifecycle: TrackingAnalysisLifecycle;
      receipt: OperationReceipt;
      resources: LocalMotionJobEvidence[];
    }
  | {
      ok: false;
      source?: TrackingSourceIdentity;
      lifecycle?: TrackingAnalysisLifecycle;
      receipt?: OperationReceipt;
      error: { code: "tracking_cancelled" | "tracking_probe_failed" | "tracking_request_invalid" | "tracking_decode_failed" | "tracking_solve_failed"; message: string };
      resources: LocalMotionJobEvidence[];
    };

/** Probe, decode, and solve package-local media without exposing executable media data to packages. */
export async function analyzeTrackingMedia(input: AnalyzeTrackingMediaInput): Promise<AnalyzeTrackingMediaResult> {
  const resources: LocalMotionJobEvidence[] = [];
  let source: TrackingSourceIdentity | undefined;
  let lifecycle: TrackingAnalysisLifecycle | undefined;
  let snapshot: Awaited<ReturnType<typeof retainTrackingMediaInput>> | undefined;
  let phase: "probe" | "validate" | "decode" | "solve" = "probe";
  try {
    snapshot = await retainTrackingMediaInput(input.sourcePath, input.inputRoot);
    source = await inspectTrackingMediaSnapshot({
      assetId: input.assetId,
      snapshot,
      scratchRoot: input.scratchRoot,
      signal: input.signal,
      ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      resources,
    });
    phase = "validate";
    assertTrackingAnalysisRequest({
      id: input.id,
      source,
      mode: input.mode,
      model: input.model,
      reference: input.reference,
      settings: input.settings,
    });
    if (input.existingLifecycle) {
      assertTrackingAnalysisLifecycle(input.existingLifecycle);
      if (input.existingLifecycle.id !== input.id) throw new Error("Existing tracking lifecycle id does not match the request.");
      const current = invalidateTrackingAnalysis(input.existingLifecycle, source, input.createdAt);
      lifecycle = startTrackingAnalysis(retryTrackingAnalysis(current, { source, now: input.createdAt }), input.createdAt);
    } else {
      lifecycle = startTrackingAnalysis(createTrackingAnalysisLifecycle({
        id: input.id,
        source,
        now: input.createdAt,
      }), input.createdAt);
    }
    phase = "decode";
    const frames = await decodeTrackingLumaSnapshot({
      source,
      snapshot,
      settings: input.settings,
      referenceAtMs: input.reference.atMs,
      scratchRoot: input.scratchRoot,
      signal: input.signal,
      ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      resources,
    });
    phase = "solve";
    const analysis = solveFixedTrackingAnalysis({
      id: input.id,
      source,
      mode: input.mode,
      model: input.model,
      reference: input.reference,
      settings: input.settings,
      frames,
      createdAt: input.createdAt,
      signal: input.signal,
    });
    lifecycle = completeTrackingAnalysis(lifecycle, analysis, input.createdAt);
    const receipt = createTrackingOperationReceipt({
      operation: "analysis.tracking.request",
      packageId: input.packageId,
      lifecycle,
      output: {
        analysis,
        resources,
        media: { path: "package-local-redacted", sourceSha256: source.sha256 },
      },
      now: input.createdAt,
    });
    return { ok: true, source, analysis, lifecycle, receipt, resources };
  } catch (error) {
    const cancelled = input.signal?.aborted === true;
    if (lifecycle?.state === "running") {
      lifecycle = stopTrackingAnalysis(lifecycle, {
        state: cancelled ? "cancelled" : "failed",
        code: cancelled ? "tracking_cancelled" : source ? "tracking_analysis_failed" : "tracking_probe_failed",
        message: safeMessage(error),
        now: input.createdAt,
      });
    }
    const code = cancelled
      ? "tracking_cancelled"
      : phase === "probe"
        ? "tracking_probe_failed"
        : phase === "validate"
          ? "tracking_request_invalid"
        : phase === "decode"
          ? "tracking_decode_failed"
          : "tracking_solve_failed";
    const receipt = lifecycle ? createTrackingOperationReceipt({
      operation: "analysis.tracking.request",
      packageId: input.packageId,
      lifecycle,
      output: { error: { code, message: safeMessage(error) }, resources },
      now: input.createdAt,
    }) : undefined;
    return {
      ok: false,
      ...(source ? { source } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(receipt ? { receipt } : {}),
      error: { code, message: safeMessage(error) },
      resources,
    };
  } finally {
    await snapshot?.release().catch(() => undefined);
  }
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || "unknown error";
}
