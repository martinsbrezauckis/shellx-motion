import { lstat } from "node:fs/promises";
import type { RenderEncoderProbeEvidence } from "@shellx-motion/core";
import {
  buildEncodeImageSequenceCommand,
  motionToolIdentityFor,
  resolveExportPreset,
  type FfmpegCommand,
  type FfmpegExportPresetSpec,
  type FfmpegHardwareEncodeCandidate,
  type FfmpegHardwareEncoderUsability,
  type FfmpegRunner,
  type FfmpegVideoCodecFamily,
  type ProbeMediaResult
} from "./index.js";
import {
  encodePolicyCacheKey,
  resolveCachedHardwareProbe,
  type EncodePolicyCache
} from "./encode-policy.js";
import { image2PipeCommandFromImageSequence, rawVideoCommandFromImageSequence } from "./streaming-command-input.js";
import { summarizeFfmpegDiagnostic } from "./ffmpeg-process-control.js";
import type {
  StreamingFinalEncodeFinalizationResult,
  StreamingFinalEncodeExecutionEvidence,
  StreamingFinalEncodePreparationInput,
  StreamingFinalEncodePreparationResult,
  StreamingFinalPartialOutputEvidence,
  StreamingFinalPolicyAttempt,
  StreamingPolicyBaseInput
} from "./streaming-final-encode-policy-types.js";
import type { resolveFinalAudioInputs } from "./final-encode-shared.js";

export function buildStreamingAttempts(input: {
  input: StreamingPolicyBaseInput & { framesDir: string; inputRoots: string[]; frameFormat?: "png" | "rgba" };
  audioInputs: ReturnType<typeof resolveFinalAudioInputs>;
  hardwareCandidate?: FfmpegHardwareEncodeCandidate;
  softwareEncoder?: string;
  softwareFallbackEncoder?: string;
}): StreamingFinalPolicyAttempt[] {
  const command = (options: { videoEncoder?: string; hardwareOutputArgs?: string[] }): FfmpegCommand => {
    const { frameFormat, ...materializedInput } = input.input;
    const materialized = buildEncodeImageSequenceCommand({
      ...materializedInput,
      audioTracks: input.audioInputs,
      ...(options.videoEncoder ? { videoEncoder: options.videoEncoder } : {}),
      ...(options.hardwareOutputArgs ? { hardwareOutputArgs: options.hardwareOutputArgs } : {})
    });
    return frameFormat === "rgba"
      ? rawVideoCommandFromImageSequence(materialized, input.input)
      : image2PipeCommandFromImageSequence(materialized);
  };
  const attempts: StreamingFinalPolicyAttempt[] = [];
  if (input.hardwareCandidate) {
    attempts.push({
      source: "hardware",
      encoder: input.hardwareCandidate.encoder,
      command: command({ hardwareOutputArgs: input.hardwareCandidate.outputArgs })
    });
  }
  attempts.push({
    source: "software",
    ...(input.softwareFallbackEncoder ? { encoder: input.softwareFallbackEncoder } : {}),
    command: command({ videoEncoder: input.softwareEncoder })
  });
  return attempts;
}

export async function resolveHardwareDecision(input: {
  input: StreamingFinalEncodePreparationInput;
  preset: ReturnType<typeof resolveExportPreset>;
  runner: FfmpegRunner;
  cache: EncodePolicyCache;
  /** Resolved once by the policy; explicit false overrides an environment true. */
  forceSoftwareEncode: boolean;
}): Promise<{
  candidate?: FfmpegHardwareEncodeCandidate;
  probe?: FfmpegHardwareEncoderUsability;
  provenance?: "fresh-probe" | "cached";
  warnings: string[];
}> {
  const policy = input.preset.hardwareEncode;
  if (!policy || input.forceSoftwareEncode) return { warnings: [] };
  let probe: FfmpegHardwareEncoderUsability;
  let provenance = input.input.encoderProbeProvenance;
  if (input.input.hardwareProbe) {
    probe = input.input.hardwareProbe;
  } else {
    const resolved = await resolveCachedHardwareProbe({
      family: policy.family,
      encoders: policy.candidates.map((candidate) => candidate.encoder),
      runner: input.runner,
      cache: input.cache,
      version: input.input.ffmpegVersion ?? null,
      ...(input.input.ttlMs !== undefined ? { ttlMs: input.input.ttlMs } : {}),
      now: input.input.policyNow ?? Date.now
    });
    probe = resolved.probe;
    provenance = resolved.provenance;
  }
  if (!probe.ok) {
    return {
      probe,
      ...(provenance ? { provenance } : {}),
      warnings: [`Hardware encoder probe failed (${probe.error.code}); using software encoder. ${safePolicyDiagnostic(probe.error.message)}`]
    };
  }
  return {
    probe,
    ...(provenance ? { provenance } : {}),
    candidate: policy.candidates.find((candidate) => probe.usableEncoders.includes(candidate.encoder)),
    warnings: []
  };
}

export function validateDeliveredOutput(
  media: ProbeMediaResult,
  input: Pick<StreamingFinalEncodePreparationInput, "width" | "height" | "durationMs" | "fps">,
  preset: FfmpegExportPresetSpec,
  requestedAudioInputCount: number
): string | undefined {
  if (media.width !== input.width || media.height !== input.height) {
    return `Delivered media dimensions ${media.width}x${media.height} do not match requested ${input.width}x${input.height}.`;
  }
  if (media.codec !== preset.codec) return `Delivered media codec ${media.codec} does not match requested ${preset.codec}.`;
  if (!media.container.split(",").map((entry) => entry.trim()).includes(preset.container)) {
    return `Delivered media container ${media.container} does not include requested ${preset.container}.`;
  }
  const fpsTolerance = Math.max(0.01, input.fps * 0.001);
  if (!Number.isFinite(media.fps) || Math.abs(media.fps - input.fps) > fpsTolerance) {
    return `Delivered media fps ${media.fps} is outside tolerance of requested ${input.fps}.`;
  }
  const frameDurationMs = 1_000 / input.fps;
  if (Math.abs(media.durationMs - input.durationMs) > frameDurationMs + 10) {
    return `Delivered media duration ${media.durationMs}ms is outside one frame of requested ${input.durationMs}ms.`;
  }
  if (requestedAudioInputCount > 0 && preset.audioCodec) {
    if (!media.audio.present) return "Delivered media is missing the requested audio stream.";
    const expectedAudioCodec = receiptCodecName(preset.audioCodec);
    for (const stream of media.audio.streams) {
      if (stream.codec !== expectedAudioCodec) return `Delivered audio codec ${stream.codec} does not match requested ${expectedAudioCodec}.`;
      if (stream.durationMs !== null && Math.abs(stream.durationMs - input.durationMs) > frameDurationMs + 10) {
        return `Delivered audio duration ${stream.durationMs}ms is outside one frame of requested ${input.durationMs}ms.`;
      }
    }
  }
  if (preset.supportsAlpha && !media.alpha.present) return `Delivered ${preset.preset} output is missing its required alpha channel.`;
  return undefined;
}

export function invalidateFailedHardwareAttempt(
  cache: EncodePolicyCache,
  family: FfmpegVideoCodecFamily | undefined,
  attempts: ReadonlyArray<{ source: "hardware" | "software"; outcome: "succeeded" | "failed"; failure?: unknown }> | undefined
): void {
  if (!family || !attempts?.some((attempt) => attempt.source === "hardware" && attempt.outcome === "failed")) return;
  cache.delete(encodePolicyCacheKey(family));
}

export function summarizeEncoderProbe(
  probe: Extract<FfmpegHardwareEncoderUsability, { ok: true }>,
  selectedEncoder: string | null,
  provenance?: "fresh-probe" | "cached"
): RenderEncoderProbeEvidence {
  return {
    hardwareAvailable: probe.usableEncoders.length > 0,
    usableHardwareEncoders: probe.usableEncoders,
    selectedHardwareEncoder: selectedEncoder,
    compiledHardwareEncoders: probe.probes.filter((entry) => entry.compiled).map((entry) => entry.encoder),
    failedHardwareEncoders: probe.probes
      .filter((entry) => entry.status === "initialization_failed")
      .map((entry) => ({ encoder: entry.encoder, reason: boundedProbeReason(entry.message, entry.exitCode) })),
    ...(provenance ? { provenance } : {})
  };
}

export function staticEncoder(outputArgs: string[]): string | undefined {
  const index = outputArgs.indexOf("-c:v");
  return index >= 0 ? outputArgs[index + 1] : undefined;
}

export function postEncodeFailure(
  code: string,
  error: unknown,
  partialOutput: StreamingFinalPartialOutputEvidence
): StreamingFinalEncodeFinalizationResult {
  return {
    ok: false,
    error: {
      code,
      message: safePolicyDiagnostic(error instanceof Error ? error.message : String(error)),
      partialOutput
    }
  };
}

/** Refuse forged or internally inconsistent success facts before final readback or cache effects. */
export function streamingFinalExecutionEvidenceError(input: {
  plannedAttempts: readonly StreamingFinalPolicyAttempt[];
  execution: StreamingFinalEncodeExecutionEvidence;
}): string | undefined {
  const { attempts, command, output } = input.execution;
  if (output.exitCode !== 0) return "Finalization requires a successful FFmpeg process exit.";
  if (attempts.length === 0) return "Finalization requires one successful executed FFmpeg attempt.";
  if (attempts.length > input.plannedAttempts.length) return "Executed FFmpeg attempts exceed the prepared policy.";
  for (const [index, attempt] of attempts.entries()) {
    const planned = input.plannedAttempts[index];
    if (!planned || attempt.source !== planned.source || attempt.encoder !== planned.encoder) {
      return "Executed FFmpeg attempts do not match the prepared policy prefix.";
    }
    if (index + 1 === attempts.length) {
      if (attempt.outcome !== "succeeded") return "Finalization requires the final executed FFmpeg attempt to succeed.";
    } else if (attempt.outcome !== "failed") {
      return "Finalization permits failed attempts only before one final successful FFmpeg attempt.";
    }
  }
  const successfulPlan = input.plannedAttempts[attempts.length - 1];
  return successfulPlan && sameFfmpegCommand(command, successfulPlan.command)
    ? undefined
    : "Final FFmpeg command does not match the successful prepared attempt.";
}

export function finalizationFailure(code: string, message: string): StreamingFinalEncodeFinalizationResult {
  return { ok: false, error: { code, message: safePolicyDiagnostic(message) } };
}

export function preparationFailure(code: string, message: string): StreamingFinalEncodePreparationResult {
  return { ok: false, error: { code, message: safePolicyDiagnostic(message) } };
}

/** Durable segment manifests retain every bounded frame hash; streamed callers keep Core's 64 cap. */
export function qualityPolicyRefusal(
  quality: StreamingFinalEncodePreparationInput["quality"],
  capacity: number
): { code: "streaming_quality_policy_unsupported"; message: string } | undefined {
  const requested = quality?.minUniqueFrameHashes ?? 0;
  if (
    Number.isSafeInteger(capacity)
    && capacity >= 1
    && Number.isSafeInteger(requested)
    && requested >= 0
    && requested <= capacity
  ) return undefined;
  return {
    code: "streaming_quality_policy_unsupported",
    message: `This internal final transport supports minUniqueFrameHashes through ${capacity}; requested ${requested}.`
  };
}

export function policyToolEvidence(
  input: Pick<StreamingFinalEncodePreparationInput, "ffmpegVersion" | "ffprobeVersion">,
  includeFfprobe: true
): StreamingFinalPartialOutputEvidence["tools"] & { ffprobe: NonNullable<StreamingFinalPartialOutputEvidence["tools"]["ffprobe"]> };
export function policyToolEvidence(
  input: Pick<StreamingFinalEncodePreparationInput, "ffmpegVersion" | "ffprobeVersion">,
  includeFfprobe?: false
): StreamingFinalPartialOutputEvidence["tools"];
export function policyToolEvidence(
  input: Pick<StreamingFinalEncodePreparationInput, "ffmpegVersion" | "ffprobeVersion">,
  includeFfprobe = false
): StreamingFinalPartialOutputEvidence["tools"] {
  return {
    ffmpeg: motionToolIdentityFor("ffmpeg", input.ffmpegVersion ?? undefined),
    ...(includeFfprobe ? { ffprobe: motionToolIdentityFor("ffprobe", input.ffprobeVersion ?? undefined) } : {})
  };
}

export async function outputPathPresence(path: string): Promise<"exists" | "missing" | "unknown"> {
  try {
    await lstat(path);
    return "exists";
  } catch (error) {
    return isErrnoWithCode(error, "ENOENT") ? "missing" : "unknown";
  }
}

export function safePolicyDiagnostic(value: string): string {
  return summarizeFfmpegDiagnostic(value) || "FFmpeg policy operation failed without a diagnostic.";
}

export function envForceSoftwareEncode(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE?.trim() ?? "");
}

function receiptCodecName(codec: string): string {
  return codec.startsWith("lib") ? codec.slice(3) : codec;
}

function boundedProbeReason(message: string | undefined, exitCode: number | undefined): string {
  const firstLine = (message ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const withoutPaths = firstLine.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/g, "<path>").replace(/\s+/g, " ").trim();
  if (withoutPaths) {
    const safe = safePolicyDiagnostic(withoutPaths);
    return safe.length > 160 ? `${safe.slice(0, 157)}...` : safe;
  }
  return exitCode === undefined ? "initialization failed" : `initialization failed (exit ${exitCode})`;
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameFfmpegCommand(left: FfmpegCommand, right: FfmpegCommand): boolean {
  return left.executable === right.executable
    && left.shell === right.shell
    && left.args.length === right.args.length
    && left.args.every((argument, index) => argument === right.args[index]);
}
