/** Internal preparation/readback stages shared by streamed and future admitted final encoders. */
import { dirname, join } from "node:path";
import {
  hashFile,
  streamingFrameQualityPolicyRefusal,
  type LocalMotionJobEvidence,
} from "@shellx-motion/core";
import {
  audioWarningsForExportPreset,
  buildEncodeImageSequenceCommand,
  measureAudioLevels,
  probeFfmpegEncoderCapabilities,
  probeMedia,
  resolveExportPreset,
  selectFfmpegPresetEncoder,
  summarizeSuccessfulEncodeStderr,
  type FfmpegRunner,
  type ProbeMediaResult
} from "./index.js";
import {
  buildFinalLoudnessSummary,
  collectFinalRenderInputHashes,
  finalReceiptAudioOutput,
  gradeFinalDeliveredColor,
  measureFinalProgramLoudness,
  resolveFinalAudioInputs
} from "./final-encode-shared.js";
import { defaultEncodePolicyCache } from "./encode-policy.js";
import {
  assertSelfContainedFfmpegMediaInputs,
  FfmpegMediaInputRefusal
} from "./ffmpeg-media-input-fence.js";
import {
  releaseStreamingFinalMediaSnapshots,
  snapshotStreamingFinalAudio
} from "./streaming-final-media-snapshots.js";
export { releaseStreamingFinalMediaSnapshots } from "./streaming-final-media-snapshots.js";
import { streamingQualityManifestCapability } from "./streaming-foundation.js";
import { streamingMetadataError } from "./streaming-foundation-validation.js";
import { finalStreamingAudioMasterEvidence, normalizeStreamingAudioMaster } from "./streaming-final-audio-master.js";
import type {
  StreamingFinalEncodeFinalizationInput,
  StreamingFinalEncodeFinalizationResult,
  StreamingFinalEncodePreparationInput,
  StreamingFinalEncodePreparationResult,
  StreamingFinalReceiptEvidence,
  StreamingFinalUnboundReceiptEvidence,
  StreamingFinalPolicyAttempt
} from "./streaming-final-encode-policy-types.js";
import {
  buildStreamingAttempts,
  envForceSoftwareEncode,
  finalizationFailure,
  invalidateFailedHardwareAttempt,
  outputPathPresence,
  policyToolEvidence,
  postEncodeFailure,
  preparationFailure,
  qualityPolicyRefusal,
  resolveHardwareDecision,
  safePolicyDiagnostic,
  staticEncoder,
  streamingFinalExecutionEvidenceError,
  summarizeEncoderProbe,
  validateDeliveredOutput
} from "./streaming-final-encode-policy-helpers.js";
/**
 * Resolve final-video policy facts without creating an FFmpeg governor job or producing frames.
 * The supplied runner is explicit so callers that already hold an admission choose its tool runner.
 */
export async function prepareStreamingFinalEncodePolicy(input: {
  input: StreamingFinalEncodePreparationInput;
  runner: FfmpegRunner;
}): Promise<StreamingFinalEncodePreparationResult> {
  const { runner } = input;
  const { qualityCapability, audioMaster: rawAudioMaster, ...policyWithoutMaster } = input.input;
  const normalizedMaster = normalizeStreamingAudioMaster(rawAudioMaster, policyWithoutMaster.durationMs);
  if ("error" in normalizedMaster) return preparationFailure("audio_master_invalid", normalizedMaster.error);
  const policyInput = { ...policyWithoutMaster, ...(normalizedMaster.master ? { audioMaster: normalizedMaster.master } : {}) };
  const frameCount = Math.ceil((policyInput.durationMs / 1_000) * policyInput.fps);
  const metadataError = streamingMetadataError({
    frameCount,
    durationMs: policyInput.durationMs,
    fps: policyInput.fps,
    width: policyInput.width,
    height: policyInput.height,
    frameFormat: policyInput.frameFormat
  });
  if (metadataError) return preparationFailure(metadataError.code, metadataError.message);
  if (policyInput.qualityManifest?.exactSourceComparison === "required") {
    const boundary = streamingQualityManifestCapability().exactSourceComparison;
    return preparationFailure(boundary.code, boundary.message);
  }
  const qualityRefusal = qualityCapability
    ? qualityPolicyRefusal(policyInput.quality, qualityCapability.uniqueFrameHashCapacity)
    : streamingFrameQualityPolicyRefusal(policyInput.quality);
  if (qualityRefusal) return preparationFailure(qualityRefusal.code, qualityRefusal.message);

  const preset = resolveExportPreset(policyInput.preset);
  const audioInputs = resolveFinalAudioInputs(policyInput);
  if (policyInput.audioMaster && (audioInputs.length === 0 || !preset.audioCodec)) {
    return preparationFailure(
      "audio_master_unavailable",
      "Document audio master requires a final-video preset and at least one resolved audio input."
    );
  }
  const compatibilityWarnings = audioWarningsForExportPreset(preset.preset, audioInputs.length);
  const commandFramesDir = join(dirname(policyInput.outputPath), ".shellx-motion-streaming-command-input");
  const commandInputRoots = [commandFramesDir, ...(policyInput.inputRoots ?? [])];
  const baseCommandInput = { ...policyInput, framesDir: commandFramesDir, inputRoots: commandInputRoots };
  try {
    await assertSelfContainedFfmpegMediaInputs(audioInputs.map((audio) => audio.path), policyInput.inputRoots ?? []);
    buildEncodeImageSequenceCommand({ ...baseCommandInput, audioTracks: audioInputs });
  } catch (error) {
    return preparationFailure(error instanceof FfmpegMediaInputRefusal ? error.code : "streaming_command_invalid", error instanceof Error ? error.message : String(error));
  }

  let encoderSelection;
  if (preset.encoderPolicy) {
    const capabilities = await probeFfmpegEncoderCapabilities({ runner });
    encoderSelection = selectFfmpegPresetEncoder(preset.preset, capabilities);
    if (!encoderSelection.ok) return preparationFailure(encoderSelection.error.code, encoderSelection.error.message);
  }
  const softwareEncoder = encoderSelection?.ok ? encoderSelection.encoder ?? undefined : undefined;
  const forceSoftwareEncode = policyInput.forceSoftwareEncode ?? envForceSoftwareEncode();
  const cache = policyInput.cache ?? defaultEncodePolicyCache;
  const hardwareDecision = await resolveHardwareDecision({
    input: policyInput,
    preset,
    runner,
    cache,
    forceSoftwareEncode
  });
  const softwareFallbackEncoder = softwareEncoder ?? preset.hardwareEncode?.softwareFallback ?? staticEncoder(preset.outputArgs);
  const loudnessNormalizationRequested = Boolean(preset.audioCodec)
    && audioInputs.some((audio) => audio.normalizeLoudness === true);
  let mediaSnapshots: Awaited<ReturnType<typeof snapshotStreamingFinalAudio>>["mediaSnapshots"] = [];
  try {
    const admitted = await snapshotStreamingFinalAudio({
      audioInputs,
      inputRoots: policyInput.inputRoots ?? [],
      runner,
      loudnessNormalizationRequested,
      ...(policyInput.finalAudioSnapshotStaging ? { staging: policyInput.finalAudioSnapshotStaging } : {})
    });
    mediaSnapshots = admitted.mediaSnapshots;
    const admittedCommandInput = {
      ...baseCommandInput,
      inputRoots: [...commandInputRoots, ...mediaSnapshots.map((snapshot) => snapshot.root)]
    };

    const plannedAttempts = buildStreamingAttempts({
      input: admittedCommandInput,
      audioInputs: admitted.loudness.inputs,
      hardwareCandidate: hardwareDecision.candidate,
      softwareEncoder,
      softwareFallbackEncoder
    });
    return {
      ok: true,
      prepared: {
        input: policyInput,
        frameCount,
        preset,
        audioInputs: admitted.audioInputs,
        renderAudioInputs: admitted.loudness.inputs,
        compatibilityWarnings,
        plannedAttempts,
        cache,
        forceSoftwareEncode,
        hardwareDecision,
        loudness: admitted.loudness,
        loudnessNormalizationRequested,
        mediaSnapshots
      }
    };
  } catch (error) {
    await releaseStreamingFinalMediaSnapshots(mediaSnapshots);
    return preparationFailure(error instanceof FfmpegMediaInputRefusal ? error.code : "streaming_command_invalid", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Read back and attest a successful final encode. It never admits a job or starts an encoder; the
 * caller supplies both actual attempt history and the runner used for documented FFprobe/loudness reads.
 */
export async function finalizeStreamingFinalEncodePolicy(
  input: StreamingFinalEncodeFinalizationInput
): Promise<StreamingFinalEncodeFinalizationResult> {
  const { prepared, runner, execution, frameSequence } = input;
  const policyInput = prepared.input;
  const { preset } = prepared;
  const executionEvidenceError = streamingFinalExecutionEvidenceError({
    plannedAttempts: prepared.plannedAttempts,
    execution
  });
  if (executionEvidenceError) return finalizationFailure("streaming_execution_evidence_invalid", executionEvidenceError);
  invalidateFailedHardwareAttempt(prepared.cache, preset.hardwareEncode?.family, execution.attempts);

  const encodeTools = policyToolEvidence(policyInput);
  const outputPresence = await outputPathPresence(policyInput.outputPath);
  if (outputPresence === "missing") {
    return postEncodeFailure("output_evidence_failed", "FFmpeg reported success but no output file exists.", {
      path: policyInput.outputPath,
      status: "missing",
      tools: encodeTools
    });
  }
  let outputHash: string;
  try {
    outputHash = await hashFile(policyInput.outputPath);
  } catch (error) {
    return postEncodeFailure("output_evidence_failed", error, {
      path: policyInput.outputPath,
      status: "unverified",
      tools: encodeTools
    });
  }
  const readbackTools = policyToolEvidence(policyInput, true);
  let observedMedia: ProbeMediaResult;
  try {
    observedMedia = await probeMedia(policyInput.outputPath, { runner, inputRoots: [dirname(policyInput.outputPath)] });
  } catch (error) {
    return postEncodeFailure("output_evidence_failed", error, {
      path: policyInput.outputPath,
      status: "unverified",
      sha256: outputHash,
      tools: readbackTools
    });
  }
  const outputValidation = validateDeliveredOutput(observedMedia, policyInput, preset, prepared.renderAudioInputs.length);
  if (outputValidation) {
    return postEncodeFailure("output_validation_failed", outputValidation, {
      path: policyInput.outputPath,
      status: "nonconforming",
      sha256: outputHash,
      observedMedia,
      validationFailure: outputValidation,
      tools: readbackTools
    });
  }

  const colorGrade = preset.color && policyInput.verifyDeliveredColor !== false
    ? await gradeFinalDeliveredColor(policyInput.outputPath, preset, { probe: async () => observedMedia })
    : null;
  const programLoudness = (prepared.loudnessNormalizationRequested || policyInput.audioMaster?.loudness)
    ? await measureFinalProgramLoudness(policyInput.outputPath, {
        measure: (path) => measureAudioLevels(path, { runner, inputRoots: [dirname(policyInput.outputPath)] })
      })
    : undefined;
  const loudnessSummary = prepared.loudnessNormalizationRequested
    ? buildFinalLoudnessSummary(prepared.loudness.tracks, programLoudness ?? null)
    : undefined;
  const master = finalStreamingAudioMasterEvidence(policyInput.audioMaster, programLoudness);
  if (master.failure) {
    return postEncodeFailure("audio_master_quality_failed", master.failure, {
      path: policyInput.outputPath,
      status: "nonconforming",
      sha256: outputHash,
      observedMedia,
      validationFailure: master.failure,
      ...(master.evidence ? { audioMaster: master.evidence } : {}),
      tools: readbackTools
    });
  }
  let inputHashes: Record<string, string>;
  try {
    inputHashes = await collectFinalRenderInputHashes(frameSequence.sha256, preset.audioCodec ? prepared.audioInputs : []);
  } catch (error) {
    return postEncodeFailure("input_hash_failed", error, {
      path: policyInput.outputPath,
      status: "available",
      sha256: outputHash,
      observedMedia,
      tools: readbackTools
    });
  }

  const finalAttempt = [...execution.attempts].reverse().find((attempt) => attempt.outcome === "succeeded");
  const fallbackAttempt = execution.attempts.find((attempt) => attempt.source === "hardware" && attempt.outcome === "failed");
  const encoderReason = finalAttempt?.source === "hardware"
    ? "probe-selected-hardware"
    : prepared.forceSoftwareEncode
      ? "forced-software"
      : fallbackAttempt
        ? "hardware-fallback"
        : "software-default";
  const emitEncoderEvidence = Boolean(preset.encoderPolicy) || Boolean(preset.hardwareEncode);
  const encoderProbe = prepared.hardwareDecision.probe?.ok
    ? summarizeEncoderProbe(prepared.hardwareDecision.probe, prepared.hardwareDecision.candidate?.encoder ?? null, prepared.hardwareDecision.provenance)
    : undefined;
  const encodeWarning = summarizeSuccessfulEncodeStderr(execution.output.stderr);
  const warnings = [
    ...frameSequence.quality.warnings,
    ...prepared.compatibilityWarnings,
    ...prepared.hardwareDecision.warnings,
    ...(colorGrade?.warning ? [colorGrade.warning] : []),
    ...(encodeWarning ? [encodeWarning] : [])
  ];
  return {
    ok: true,
    command: execution.command,
    receiptEvidence: {
      inputHashes,
      output: {
        path: policyInput.outputPath,
        sha256: outputHash,
        width: policyInput.width,
        height: policyInput.height,
        durationMs: policyInput.durationMs,
        codec: preset.codec,
        container: preset.container,
        preset: preset.preset,
        ...(emitEncoderEvidence && finalAttempt?.encoder
          ? {
              encoder: finalAttempt.encoder,
              encoderSource: finalAttempt.source,
              encoderReason,
              ...(encoderProbe ? { encoderProbe } : {}),
              ...(fallbackAttempt ? {
                encoderFallback: {
                  attemptedEncoder: fallbackAttempt.encoder ?? "hardware",
                  reason: fallbackAttempt.failure?.message ?? "hardware attempt failed"
                }
              } : {})
            }
          : {}),
        ...(preset.color ? { color: { ...preset.color, ...(colorGrade ? { observed: colorGrade.observed } : {}) } } : {}),
        ...(prepared.renderAudioInputs.length > 0 && preset.audioCodec
          ? { audio: finalReceiptAudioOutput(prepared.renderAudioInputs, preset.audioCodec, loudnessSummary, master.evidence) }
          : {}),
        observedMedia,
        tools: readbackTools
      },
      artifacts: [{ role: "rendered_media", path: policyInput.outputPath, status: "available", mediaType: preset.mimeType, primary: true }],
      warnings,
      ...(loudnessSummary ? { loudness: loudnessSummary } : {})
    }
  };
}
/** Attach caller-owned governor evidence after finalization, without any tool or filesystem work. */
export function bindStreamingFinalResourceEvidence(
  evidence: StreamingFinalUnboundReceiptEvidence,
  resources: LocalMotionJobEvidence
): StreamingFinalReceiptEvidence {
  return { ...evidence, output: { ...evidence.output, resources } };
}
