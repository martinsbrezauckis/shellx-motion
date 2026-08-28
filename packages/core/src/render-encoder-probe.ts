/**
 * Bounded hardware-encoder probe facts recorded on final-render receipts.
 *
 * The renderer redacts every failure reason before constructing this vocabulary; the candidate
 * sets are codec-bounded rather than process output collections.
 */
export interface RenderEncoderProbeEvidence {
  hardwareAvailable: boolean;
  usableHardwareEncoders: string[];
  selectedHardwareEncoder: string | null;
  compiledHardwareEncoders: string[];
  failedHardwareEncoders: Array<{ encoder: string; reason: string }>;
  provenance?: "fresh-probe" | "cached";
}

/**
 * Why a particular video encoder ran for a final render. It lets a verifier distinguish a proved
 * hardware choice, a hardware fallback, an explicit reproducibility choice, and a software default.
 */
export type RenderEncoderReason =
  | "probe-selected-hardware"
  | "hardware-fallback"
  | "forced-software"
  | "software-default";
