import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJsonSha256, hashBuffer, type FrameSequenceQualityPolicy, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import {
  planStreamingFinalCommand,
  preliminaryGpuAudio,
  renderStreamingFinal,
  gpuFinalReceiptInputHashes,
  type FinalVideoFrameTransportPlan,
  type FfmpegExportPreset,
  type FfmpegRunner,
  type PlanStreamingFinalCommandInput,
  type RenderStreamingFinalInput,
  type StreamingFinalFrameTransportEvidence
} from "@shellx-motion/renderer-ffmpeg";
import {
  captureConnectorArtifactStagingTopology,
  connectorArtifactStagingPath,
  discardConnectorArtifactStaging,
  publishConnectorArtifact
} from "./artifact-handle";
import { readBoundedDataRecord } from "./bounded-data-snapshot";
import { throwIfConnectorAborted } from "./connector-cancellation";
import { packageAudioEncodeInput } from "./package-audio";

/**
 * High-level test seam for a streamed final render. The legacy FFmpeg runner cannot represent
 * image2pipe stdin, so it remains probe-only and cannot stand in for a video render.
 */
/** Connector final delivery is browser-compatible by default; GPU is an explicit final-video lane. */
export type ConnectorFinalFrameLane = "browser" | "native" | "gpu";
export type ConnectorRequestedFinalFrameLane = Exclude<ConnectorFinalFrameLane, "native">;
export interface ConnectorGpuFinalEvidence {
  schema: "shellx-motion/connector-gpu-final-evidence@1";
  receiptId: string;
  receiptSha256: string;
  /** The complete bounded GPU producer/handoff evidence emitted by the final renderer. */
  frameTransport: StreamingFinalFrameTransportEvidence;
  /** The renderer's mandatory GPU provenance binding, copied by value into this connector receipt. */
  provenance: Record<string, string>;
}
export type ConnectorStreamingFinalRenderer = (
  input: RenderStreamingFinalInput & { frameLane: ConnectorFinalFrameLane }
) => Promise<
  | { ok: true; receipt: OperationReceipt }
  | {
      ok: false;
      transport: FinalVideoFrameTransportPlan;
      error: ConnectorStreamingFailure;
    }
>;
export interface ConnectorStreamingFailure {
  code: string;
  message: string;
  resources?: unknown;
  handoff?: unknown;
  producer?: unknown;
  partialOutput?: Record<string, unknown>;
}
export interface ConnectorStreamingRenderInput {
  pkg: MotionPackage;
  frameLane: ConnectorFinalFrameLane;
  outputPath: string;
  preset?: FfmpegExportPreset;
  quality?: FrameSequenceQualityPolicy;
  /** Coordinator-owned cancellation; never selected by package data. */
  signal?: AbortSignal;
  runner?: FfmpegRunner;
  streamingRenderer?: ConnectorStreamingFinalRenderer;
  now: () => string;
}
export async function renderConnectorStreamingArtifact<TFrameLane extends ConnectorFinalFrameLane>(
  input: ConnectorStreamingRenderInput & { frameLane: TFrameLane }
): Promise<{
  receipt: OperationReceipt;
  frameLane: TFrameLane;
}> {
  throwIfConnectorAborted(input.signal, "before final-render planning");
  const stagingOutputPath = connectorArtifactStagingPath(input.outputPath);
  const renderer: ConnectorStreamingFinalRenderer = input.streamingRenderer ?? renderStreamingFinal;
  const commandPlan = planStreamingFinalCommand(streamingFinalPlanInput(input, stagingOutputPath));
  if (!commandPlan.ok) {
    return {
      receipt: createStreamingFailureReceipt({
        pkg: input.pkg,
        outputPath: input.outputPath,
        preset: input.preset,
        frameLane: input.frameLane,
        createdAt: input.now(),
        transport: commandPlan.transport,
        error: commandPlan.error
      }),
      frameLane: input.frameLane
    };
  }
  await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
  throwIfConnectorAborted(input.signal, "after final-render output preparation");
  const stagingTopology = await captureConnectorArtifactStagingTopology(stagingOutputPath, input.outputPath);
  let result: Awaited<ReturnType<ConnectorStreamingFinalRenderer>>;
  try {
    result = await renderer({
      pkg: input.pkg,
      frameLane: input.frameLane,
      outputPath: stagingOutputPath,
      ...(input.preset ? { preset: input.preset } : {}),
      ...packageAudioEncodeInput(input.pkg),
      inputRoots: [input.pkg.root],
      outputRoots: [dirname(input.outputPath)],
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      // The executing adapter validates this planner decision again before starting work.
      transport: commandPlan.transport,
      now: input.now,
      ...(input.runner ? { toolPolicy: { runner: input.runner } } : {})
    });
    throwIfConnectorAborted(input.signal, "after final rendering and before artifact publication");
  } catch (error) {
    await discardConnectorArtifactStaging(stagingOutputPath, stagingTopology);
    throw error;
  }
  if (!result.ok) {
    // A failed renderer has no attestable output identity. Cleanup therefore uses the parent
    // captured before producer handoff and leaves an orphan if that parent was retargeted.
    const stagingOutputRemoved = await discardConnectorArtifactStaging(stagingOutputPath, stagingTopology);
    return {
      receipt: createStreamingFailureReceipt({
        pkg: input.pkg,
        outputPath: input.outputPath,
        preset: input.preset,
        frameLane: input.frameLane,
        createdAt: input.now(),
        transport: result.transport,
        error: result.error,
        ...(stagingOutputRemoved ? { stagingOutputRemoved: true } : { stagingOutputRetained: true })
      }),
      frameLane: input.frameLane
    };
  }
  if (input.frameLane === "gpu" && !connectorGpuFinalEvidence(result.receipt)) {
    const stagingOutputRemoved = await discardConnectorArtifactStaging(stagingOutputPath, stagingTopology);
    return {
      receipt: createStreamingFailureReceipt({
        pkg: input.pkg,
        outputPath: input.outputPath,
        preset: input.preset,
        frameLane: input.frameLane,
        createdAt: input.now(),
        transport: commandPlan.transport,
        error: {
          code: "gpu_producer_evidence_missing",
          message: "GPU connector delivery was refused because the final renderer returned no complete GPU frame transport and provenance evidence."
        },
        ...(stagingOutputRemoved ? { stagingOutputRemoved: true } : { stagingOutputRetained: true })
      }),
      frameLane: input.frameLane
    };
  }
  throwIfConnectorAborted(input.signal, "before final artifact publication");
  await publishConnectorArtifact(stagingOutputPath, input.outputPath);
  result.receipt.output = {
    ...(readRecord(result.receipt.output) ?? {}),
    path: input.outputPath,
    frameLane: input.frameLane
  };
  result.receipt.artifacts = result.receipt.artifacts?.map((artifact) => artifact.role === "rendered_media"
    ? { ...artifact, path: input.outputPath }
    : artifact);
  return { receipt: result.receipt, frameLane: input.frameLane };
}
export function createStreamingDryRunRenderReceipt(input: {
  pkg: MotionPackage;
  outputPath: string;
  preset?: FfmpegExportPreset;
  frameLane: ConnectorFinalFrameLane;
  createdAt: string;
  quality?: FrameSequenceQualityPolicy;
}): OperationReceipt {
  const commandPlan = planStreamingFinalCommand(streamingFinalPlanInput(input, input.outputPath));
  if (!commandPlan.ok) {
    return createStreamingFailureReceipt({
      pkg: input.pkg,
      outputPath: input.outputPath,
      preset: input.preset,
      frameLane: input.frameLane,
      createdAt: input.createdAt,
      transport: commandPlan.transport,
      error: commandPlan.error,
      status: "not_run"
    });
  }
  return {
    schema: "shellx-motion/receipt@1",
    id: `render-dry-run-${hashBuffer(Buffer.from(`${input.pkg.manifest.id}:${input.outputPath}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "not_run",
    packageId: input.pkg.manifest.id,
    inputHashes: { motion: canonicalJsonSha256(input.pkg.motion) },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      dryRun: true,
      path: input.outputPath,
      frameLane: input.frameLane,
      ...(input.preset ? { preset: input.preset } : {}),
      frameTransportPlan: commandPlan.transport,
      command: commandPlan.command,
      ...(input.frameLane === "gpu" ? { gpu: { status: "planned_not_executed", hardwareEvidence: "not_collected" } } : {})
    },
    warnings: []
  };
}
function createStreamingFailureReceipt(input: {
  pkg: MotionPackage;
  outputPath: string;
  preset?: FfmpegExportPreset;
  frameLane: ConnectorFinalFrameLane;
  createdAt: string;
  transport: FinalVideoFrameTransportPlan;
  error: ConnectorStreamingFailure;
  status?: "failed" | "not_run";
  stagingOutputRemoved?: true;
  stagingOutputRetained?: true;
}): OperationReceipt {
  const status = input.status ?? "failed";
  return {
    schema: "shellx-motion/receipt@1",
    id: `streaming-final-${status}-${hashBuffer(Buffer.from(`${input.pkg.manifest.id}:${input.outputPath}:${input.error.code}:${input.error.message}`)).slice(0, 16)}`,
    operation: "render.final",
    status,
    packageId: input.pkg.manifest.id,
    inputHashes: { motion: canonicalJsonSha256(input.pkg.motion) },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      path: input.outputPath,
      frameLane: input.frameLane,
      ...(input.preset ? { preset: input.preset } : {}),
      frameTransportPlan: input.transport,
      error: {
        code: input.error.code,
        message: input.error.message,
        ...(input.error.resources !== undefined ? { resources: input.error.resources } : {}),
        ...(input.error.handoff !== undefined ? { handoff: input.error.handoff } : {}),
        ...(input.error.producer !== undefined ? { producer: input.error.producer } : {}),
        ...(input.error.partialOutput !== undefined ? { partialOutput: input.error.partialOutput } : {}),
        ...(input.stagingOutputRemoved ? { stagingOutputRemoved: true } : {}),
        ...(input.stagingOutputRetained ? { stagingOutputRetained: true } : {})
      }
    },
    warnings: [input.error.message]
  };
}

/**
 * Binds the actual GPU renderer receipt to a connector receipt. This is deliberately stricter
 * than a lane label: a caller cannot publish a browser/native receipt while calling it GPU.
 */
export function connectorGpuFinalEvidence(receipt: unknown): ConnectorGpuFinalEvidence | undefined {
  try {
    return connectorGpuFinalEvidenceFromRecord(receipt);
  } catch {
    return undefined;
  }
}

function connectorGpuFinalEvidenceFromRecord(receipt: unknown): ConnectorGpuFinalEvidence | undefined {
  const receiptRecord = readBoundedDataRecord(receipt);
  if (!receiptRecord
    || receiptRecord.schema !== "shellx-motion/receipt@1" || receiptRecord.operation !== "render.final" || receiptRecord.status !== "passed" || receiptRecord.lane !== "ffmpeg"
    || typeof receiptRecord.id !== "string") return undefined;
  const output = readBoundedDataRecord(receiptRecord.output);
  const frameTransport = readBoundedDataRecord(output?.frameTransport);
  const producer = readBoundedDataRecord(frameTransport?.producer);
  if (!frameTransport || frameTransport.delivery !== "streamed" || frameTransport.frameLane !== "gpu"
    || !Number.isSafeInteger(frameTransport.frameCount) || frameTransport.retainedFrameCount !== 0
    || producer?.frameLane !== "gpu") return undefined;
  const evidence = readBoundedDataRecord(producer.evidence);
  const provenanceRecord = evidence ? readBoundedDataRecord(evidence.provenance) : undefined;
  const staticPlan = provenanceRecord ? readBoundedDataRecord(provenanceRecord.staticPlan) : undefined;
  const canonicalFrameCount = staticPlan?.canonicalFrameCount;
  if (!evidence || frameTransport.frameCount !== canonicalFrameCount) return undefined;
  const expected = gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence });
  const provenance = expected ? gpuProvenance(receiptRecord.inputHashes, expected) : undefined;
  if (!provenance) return undefined;
  return {
    schema: "shellx-motion/connector-gpu-final-evidence@1",
    receiptId: receiptRecord.id,
    receiptSha256: canonicalJsonSha256(receiptRecord),
    frameTransport: frameTransport as unknown as StreamingFinalFrameTransportEvidence,
    provenance
  };
}

/** Receipt field shared by Canvas/Cut/template/script connectors after their operation hash is bound. */
export function connectorGpuFinalReceiptBinding(input: {
  frameLane: ConnectorRequestedFinalFrameLane | undefined;
  dryRun: boolean;
  receipt: OperationReceipt;
}): { gpu: { execution: "not_run"; hardwareEvidence: "not_collected" } | { execution: "completed"; evidence: ConnectorGpuFinalEvidence } | { execution: "no_successful_hardware_claim" } } | undefined {
  if (input.frameLane !== "gpu") return undefined;
  if (input.dryRun) return { gpu: { execution: "not_run", hardwareEvidence: "not_collected" } };
  const evidence = connectorGpuFinalEvidence(input.receipt);
  return evidence ? { gpu: { execution: "completed", evidence } } : { gpu: { execution: "no_successful_hardware_claim" } };
}

/** GPU raw-frame final delivery has no GIF transport contract; every other FFmpeg video preset stays renderer-owned. */
export function assertConnectorGpuFinalPreset(frameLane: ConnectorRequestedFinalFrameLane, preset: FfmpegExportPreset): void {
  if (frameLane === "gpu" && preset === "gif") {
    throw new Error("GPU connector frame lane supports streamed final-video presets only; gif is refused.");
  }
}

/** Runtime guard for JS/host callers; connector requests intentionally do not expose the native frame lane. */
export function resolveConnectorFinalFrameLane(value: unknown): ConnectorRequestedFinalFrameLane {
  if (value === undefined || value === "browser") return "browser";
  if (value === "gpu") return "gpu";
  throw new Error(`Unsupported connector frame lane: ${String(value)}`);
}

function streamingFinalPlanInput(input: Pick<ConnectorStreamingRenderInput, "pkg" | "preset" | "quality" | "frameLane">, outputPath: string): PlanStreamingFinalCommandInput {
  const packageAudio = packageAudioEncodeInput(input.pkg);
  const plannedAudio = input.frameLane === "gpu" ? preliminaryGpuAudio({ pkg: input.pkg, ...packageAudio }) : packageAudio;
  return {
    fps: input.pkg.motion.fps,
    width: input.pkg.motion.width,
    height: input.pkg.motion.height,
    durationMs: input.pkg.motion.durationMs,
    ...(input.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
    outputPath,
    ...(input.preset ? { preset: input.preset } : {}),
    ...plannedAudio,
    inputRoots: [input.pkg.root],
    outputRoots: [dirname(outputPath)],
    ...(input.quality ? { quality: input.quality } : {})
  };
}

function gpuProvenance(value: unknown, expected: Record<string, string>): Record<string, string> | undefined {
  const hashes = readBoundedDataRecord(value);
  if (!hashes
    || !Object.entries(expected).every(([key, digest]) => hashes[key] === digest)
    || Object.entries(hashes).some(([key, digest]) => key.startsWith("gpu-") && (!(key in expected) || digest !== expected[key]))) return undefined;
  return Object.freeze({ ...expected });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
