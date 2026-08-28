/** Bounded document-audio vocabulary shared by Core, renderers, and receipts. */

/** Curve shared by bounded audio fades and a two-layer crossfade. */
export type MotionAudioFadeCurve = "linear" | "equal-power";

/** A realized single-pass final-program loudnorm target plus delivered readback constraints. */
export interface MotionAudioLoudnessTarget {
  integratedLufs: number;
  toleranceLufs: number;
  maxTruePeakDbtp: number;
  maxLoudnessRangeLu?: number;
}

/**
 * Document-level output-stage controls. It can gain/fade the resolved program
 * and realize a fixed single-pass EBU R128 loudnorm target; it cannot name
 * plugins, scripts, filters, or external sources.
 */
export interface MotionAudioMasterBus {
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeCurve?: MotionAudioFadeCurve;
  loudness?: MotionAudioLoudnessTarget;
}

export interface MotionAudioDocument {
  master?: MotionAudioMasterBus;
}

/** Delivered program-loudness observation made after the final mux. */
export interface RenderAudioMasterReadback {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  loudnessRangeLu: number | null;
}

/** What Motion actually inserted for a declared document loudness target. */
export interface RenderAudioMasterLoudnessRealization {
  mode: "single-pass-loudnorm";
  integratedLufs: number;
  truePeakDbtp: number;
  /** loudnorm needs a target LRA; a declared maximum is used, otherwise 11 LU. */
  loudnessRangeLu: number;
}

/** Receipt evidence for the document master bus; absent when no master is configured. */
export interface RenderAudioMasterEvidence {
  controls: MotionAudioMasterBus;
  /** Present when final-program loudness analysis was requested or performed. */
  readback?: RenderAudioMasterReadback | null;
  /** The fixed post-mix realization, present only when master.loudness was declared. */
  loudnessRealization?: RenderAudioMasterLoudnessRealization;
  /** Present only when a declared loudness target was independently read back. */
  loudnessConformance?: "passed" | "failed";
  /** Bounded reason for a delivered-program target failure; no success receipt carries this field. */
  loudnessFailure?: string;
}
