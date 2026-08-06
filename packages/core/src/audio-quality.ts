/** Pure, transport-neutral final-audio quality policy evaluation. */

export interface AudioQualityMeasurements {
  maxVolumeDb: number | null;
  meanVolumeDb?: number | null;
  integratedLoudnessLufs?: number | null;
  truePeakDbtp?: number | null;
  loudnessRangeLu?: number | null;
}

export interface AudioQualityThresholds {
  maxPeakDb?: number;
  minPeakDb?: number;
  minMeanDb?: number;
  minIntegratedLoudnessLufs?: number;
  maxIntegratedLoudnessLufs?: number;
  maxTruePeakDbtp?: number;
  maxLoudnessRangeLu?: number;
}

export type AudioQualityEvaluation = { ok: true } | { ok: false; message: string };

export function audioQualityMeasurementRequired(policy: AudioQualityThresholds): boolean {
  return Object.values(policy).some((value) => value !== undefined);
}

export function evaluateAudioQuality(
  measurements: AudioQualityMeasurements,
  policy: AudioQualityThresholds
): AudioQualityEvaluation {
  if ((policy.maxPeakDb !== undefined || policy.minPeakDb !== undefined) && measurements.maxVolumeDb === null) {
    return failure("Could not measure audio peak level.");
  }
  if (policy.minMeanDb !== undefined && measurements.meanVolumeDb == null) {
    return failure("Could not measure audio mean level.");
  }
  if ((policy.minIntegratedLoudnessLufs !== undefined || policy.maxIntegratedLoudnessLufs !== undefined)
    && measurements.integratedLoudnessLufs == null) {
    return failure("Could not measure integrated loudness.");
  }
  if (policy.maxTruePeakDbtp !== undefined && measurements.truePeakDbtp == null) {
    return failure("Could not measure audio true peak.");
  }
  if (policy.maxLoudnessRangeLu !== undefined && measurements.loudnessRangeLu == null) {
    return failure("Could not measure loudness range.");
  }
  if (policy.maxPeakDb !== undefined && measurements.maxVolumeDb !== null && measurements.maxVolumeDb > policy.maxPeakDb) {
    return failure(`Audio peak is ${formatAudioMetric(measurements.maxVolumeDb)} dB; expected at most ${formatAudioMetric(policy.maxPeakDb)} dB.`);
  }
  if (policy.minPeakDb !== undefined && measurements.maxVolumeDb !== null && measurements.maxVolumeDb < policy.minPeakDb) {
    return failure(`Audio peak is ${formatAudioMetric(measurements.maxVolumeDb)} dB; expected at least ${formatAudioMetric(policy.minPeakDb)} dB.`);
  }
  if (policy.minMeanDb !== undefined && measurements.meanVolumeDb != null && measurements.meanVolumeDb < policy.minMeanDb) {
    return failure(`Audio mean is ${formatAudioMetric(measurements.meanVolumeDb)} dB; expected at least ${formatAudioMetric(policy.minMeanDb)} dB.`);
  }
  if (policy.minIntegratedLoudnessLufs !== undefined
    && measurements.integratedLoudnessLufs != null
    && measurements.integratedLoudnessLufs < policy.minIntegratedLoudnessLufs) {
    return failure(`Integrated loudness is ${formatAudioMetric(measurements.integratedLoudnessLufs)} LUFS; expected at least ${formatAudioMetric(policy.minIntegratedLoudnessLufs)} LUFS.`);
  }
  if (policy.maxIntegratedLoudnessLufs !== undefined
    && measurements.integratedLoudnessLufs != null
    && measurements.integratedLoudnessLufs > policy.maxIntegratedLoudnessLufs) {
    return failure(`Integrated loudness is ${formatAudioMetric(measurements.integratedLoudnessLufs)} LUFS; expected at most ${formatAudioMetric(policy.maxIntegratedLoudnessLufs)} LUFS.`);
  }
  if (policy.maxTruePeakDbtp !== undefined && measurements.truePeakDbtp != null && measurements.truePeakDbtp > policy.maxTruePeakDbtp) {
    return failure(`Audio true peak is ${formatAudioMetric(measurements.truePeakDbtp)} dBTP; expected at most ${formatAudioMetric(policy.maxTruePeakDbtp)} dBTP.`);
  }
  if (policy.maxLoudnessRangeLu !== undefined && measurements.loudnessRangeLu != null && measurements.loudnessRangeLu > policy.maxLoudnessRangeLu) {
    return failure(`Loudness range is ${formatAudioMetric(measurements.loudnessRangeLu)} LU; expected at most ${formatAudioMetric(policy.maxLoudnessRangeLu)} LU.`);
  }
  return { ok: true };
}

function failure(message: string): AudioQualityEvaluation {
  return { ok: false, message };
}

function formatAudioMetric(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "+inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
