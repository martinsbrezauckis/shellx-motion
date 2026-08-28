/** Document-master readback and receipt proof for the streamed final-video path. */
import {
  assertMotionAudioMasterDuration,
  evaluateMotionAudioMasterLoudness,
  normalizeMotionAudioMaster,
  type MotionAudioMasterBus,
  type RenderAudioMasterEvidence,
  type RenderLoudnessSummary,
} from "@shellx-motion/core";

/** Strictly accept the document-master controls before streamed planning can construct a command. */
export function normalizeStreamingAudioMaster(
  value: unknown,
  durationMs: number,
): { master?: MotionAudioMasterBus } | { error: string } {
  try {
    const master = normalizeMotionAudioMaster(value) ?? undefined;
    if (master) assertMotionAudioMasterDuration(master, durationMs);
    return master ? { master } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function finalStreamingAudioMasterEvidence(
  master: MotionAudioMasterBus | undefined,
  programLoudness: RenderLoudnessSummary["output"] | undefined,
): { evidence?: RenderAudioMasterEvidence; failure?: string } {
  if (!master) return {};
  const readback = master.loudness
    ? (programLoudness === undefined || programLoudness === null
      ? null
      : {
          integratedLufs: programLoudness.integratedLufs,
          truePeakDbtp: programLoudness.truePeakDbtp,
          loudnessRangeLu: programLoudness.lra,
        })
    : undefined;
  const evaluation = evaluateMotionAudioMasterLoudness(master, readback ?? null);
  const evidence: RenderAudioMasterEvidence = {
    controls: structuredClone(master),
    ...(master.loudness ? {
      readback: readback ?? null,
      loudnessRealization: {
        mode: "single-pass-loudnorm" as const,
        integratedLufs: master.loudness.integratedLufs,
        truePeakDbtp: master.loudness.maxTruePeakDbtp,
        loudnessRangeLu: master.loudness.maxLoudnessRangeLu ?? 11,
      },
      ...(evaluation.ok
        ? { loudnessConformance: "passed" as const }
        : { loudnessConformance: "failed" as const, loudnessFailure: evaluation.message }),
    } : {}),
  };
  return evaluation.ok ? { evidence } : { evidence, failure: evaluation.message };
}
