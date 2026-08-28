import { dirname, join } from "node:path";
import { assertMotionAudioMasterDuration, normalizeMotionAudioMaster, type MotionAudioMasterBus } from "@shellx-motion/core";
import { buildEncodeImageSequenceCommand, resolveExportPreset, type FfmpegCommand } from "./index.js";
import { resolveFinalAudioInputs } from "./final-encode-shared.js";
import {
  isFinalVideoFrameTransportPlan,
  planFinalVideoFrameTransport,
  type FinalVideoFrameTransportPlan
} from "./final-video-frame-transport.js";
import { FfmpegMediaInputRefusal } from "./ffmpeg-media-input-fence.js";
import { image2PipeCommandFromImageSequence, rawVideoCommandFromImageSequence } from "./streaming-command-input.js";
import { streamingMetadataError } from "./streaming-foundation-validation.js";
import type { PlanStreamingFinalCommandInput, StreamingFinalCommandPlanResult } from "./streaming-final-adapter-types.js";

/**
 * Plan the canonical image2pipe command without probing tools, admitting a job, creating a producer,
 * or touching the filesystem. It is the dry-run companion to {@link renderStreamingFinal}.
 */
export function planStreamingFinalCommand(input: PlanStreamingFinalCommandInput): StreamingFinalCommandPlanResult {
  const transport = resolveStreamingFinalTransport(input);
  if (!transport.ok) return transport;
  if (transport.plan.delivery === "materialized") {
    return {
      ok: false,
      transport: transport.plan,
      error: {
        code: "frame_transport_materialized_required",
        message: materializedTransportMessage(transport.plan)
      }
    };
  }
  const frameCount = Math.ceil((input.durationMs / 1_000) * input.fps);
  const metadataError = streamingMetadataError({ frameCount, ...input });
  if (metadataError) return { ok: false, transport: transport.plan, error: metadataError };
  let audioMaster: MotionAudioMasterBus | undefined;
  try {
    audioMaster = normalizeMotionAudioMaster(input.audioMaster) ?? undefined;
    if (audioMaster) assertMotionAudioMasterDuration(audioMaster, input.durationMs);
  } catch (error) {
    return {
      ok: false,
      transport: transport.plan,
      error: { code: "audio_master_invalid", message: safeStaticMessage(error) }
    };
  }
  const audioInputs = resolveFinalAudioInputs(input);
  const preset = resolveExportPreset(input.preset);
  if (audioMaster && (audioInputs.length === 0 || !preset.audioCodec)) {
    return {
      ok: false,
      transport: transport.plan,
      error: {
        code: "audio_master_unavailable",
        message: "Document audio master requires a final-video preset and at least one resolved audio input."
      }
    };
  }
  const framesDir = join(dirname(input.outputPath), ".shellx-motion-streaming-command-input");
  try {
    const materializedCommand = buildEncodeImageSequenceCommand({
      framesDir,
      fps: input.fps,
      durationMs: input.durationMs,
      outputPath: input.outputPath,
      ...(input.preset ? { preset: input.preset } : {}),
      ...(input.audioPath ? { audioPath: input.audioPath } : {}),
      ...(audioInputs.length === 1 ? { audio: audioInputs[0] } : {}),
      ...(audioInputs.length > 1 ? { audioTracks: audioInputs } : {}),
      ...(audioMaster ? { audioMaster } : {}),
      inputRoots: [framesDir, ...(input.inputRoots ?? [])],
      ...(input.outputRoots ? { outputRoots: input.outputRoots } : {})
    });
    const command = input.frameFormat === "rgba"
      ? rawVideoCommandFromImageSequence(materializedCommand, input)
      : image2PipeCommandFromImageSequence(materializedCommand);
    return { ok: true, transport: transport.plan, command };
  } catch (error) {
    return {
      ok: false,
      transport: transport.plan,
      error: {
        code: error instanceof FfmpegMediaInputRefusal ? error.code : "streaming_command_invalid",
        message: safeStaticMessage(error)
      }
    };
  }
}

/** Resolve caller-supplied plans against authoritative capability facts before any effectful work. */
export function resolveStreamingFinalTransport(input: Pick<PlanStreamingFinalCommandInput,
  "transport" | "keepFrames" | "capturedBrowserWorkflow" | "qualityManifest" | "quality" | "injectedFrameRenderer"
>): { ok: true; plan: FinalVideoFrameTransportPlan } | { ok: false; transport: FinalVideoFrameTransportPlan; error: { code: string; message: string } } {
  const planned = planFinalVideoFrameTransport({
    keepFrames: input.keepFrames,
    capturedBrowserWorkflow: input.capturedBrowserWorkflow,
    exactSourceQuality: input.qualityManifest?.exactSourceComparison === "required",
    minUniqueFrameHashes: input.quality?.minUniqueFrameHashes,
    injectedFrameRenderer: input.injectedFrameRenderer
  });
  if (input.transport === undefined) return { ok: true, plan: planned };
  if (!isFinalVideoFrameTransportPlan(input.transport)) {
    return {
      ok: false,
      transport: planned,
      error: { code: "frame_transport_plan_invalid", message: "Final-video frame transport must be a closed planner result." }
    };
  }
  if (input.transport.delivery !== planned.delivery || input.transport.reason !== planned.reason) {
    return {
      ok: false,
      transport: planned,
      error: {
        code: "frame_transport_plan_conflict",
        message: `The supplied frame transport plan conflicts with authoritative ${planned.reason} transport facts.`
      }
    };
  }
  return { ok: true, plan: planned };
}

export function materializedTransportMessage(plan: Extract<FinalVideoFrameTransportPlan, { delivery: "materialized" }>): string {
  return `Final-video transport requires materialization before execution (${plan.reason}).`;
}

function safeStaticMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/g, "<path>")
    .replace(/\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=\S+/g, (match) => `${match.split("=")[0]}=[redacted]`)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length > 400 ? `${safe.slice(0, 399)}…` : safe || "Streaming command validation failed.";
}
