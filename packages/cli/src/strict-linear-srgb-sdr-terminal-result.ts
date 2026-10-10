import type {
  MotionPackage,
  OperationReceipt,
  PackageRenderLineage,
} from "@shellx-motion/core";
import type { StrictSdrCandidateHeldPair } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type {
  FfmpegCommand,
  FfmpegExportPreset,
  FfmpegRunner,
  RenderStreamingFinalInput,
} from "@shellx-motion/renderer-ffmpeg";
import type { RenderReceiptFinalizeResult } from "./render-receipt-file";
import { workflowCatalogFields } from "./render-delivery-publication-support";

export type StrictLinearSrgbSdrTerminalCliResult = Record<string, unknown> & { ok: boolean; command?: string };

export type StrictLinearSrgbSdrQualityCheck = (inputPath: string) => Promise<StrictLinearSrgbSdrTerminalCliResult>;

/** Retain the strict preparation's opaque public input slot without widening renderer exports. */
type StrictLinearSrgbSdrPreparation = NonNullable<RenderStreamingFinalInput["linearSrgbSdrFinalPreparation"]>;

export interface StrictLinearSrgbSdrTerminalInput {
  readonly pkg: MotionPackage;
  readonly lineage: PackageRenderLineage;
  readonly frameLane: RenderStreamingFinalInput["frameLane"];
  readonly frameTransport: NonNullable<RenderStreamingFinalInput["transport"]>;
  readonly preset: FfmpegExportPreset;
  /** Current ordinary projection, retained for stable public CLI result fields. */
  readonly ffmpegPlan: FfmpegCommand;
  readonly outputPath: string;
  readonly audioPath: string | undefined;
  readonly audio: RenderStreamingFinalInput["audio"] | undefined;
  readonly audioTracks: RenderStreamingFinalInput["audioTracks"] | undefined;
  readonly qualityManifestPath: string | undefined;
  readonly workflowCatalogPath: string | undefined;
  readonly failOnDrift: boolean;
  readonly force: boolean;
  readonly signal: AbortSignal | undefined;
  readonly ffmpegRunner: FfmpegRunner | undefined;
  readonly renderInput: RenderStreamingFinalInput;
  /** Present only for the strict route; legacy streaming stays in this shared terminal unchanged. */
  readonly preparation: StrictLinearSrgbSdrPreparation | undefined;
  /** Absent for the private one-slot route, where quality is deliberately not an evaluator. */
  readonly qualityCheck?: StrictLinearSrgbSdrQualityCheck;
}

/** The opaque pair never crosses the ordinary CLI result boundary. */
export interface StrictLinearSrgbSdrTerminalResult {
  readonly result: StrictLinearSrgbSdrTerminalCliResult;
  readonly committedHeldPair?: StrictSdrCandidateHeldPair;
}

export function completed(
  pair: StrictSdrCandidateHeldPair | undefined,
  result: StrictLinearSrgbSdrTerminalCliResult,
): StrictLinearSrgbSdrTerminalResult {
  return pair ? { result, committedHeldPair: pair } : { result };
}

export async function requiredQualityCheck(
  qualityCheck: StrictLinearSrgbSdrQualityCheck | undefined,
  inputPath: string,
): Promise<StrictLinearSrgbSdrTerminalCliResult> {
  if (!qualityCheck) throw new Error("Strict render quality-manifest handler is absent.");
  return await qualityCheck(inputPath);
}

export function failure(
  input: StrictLinearSrgbSdrTerminalInput,
  error: unknown,
): StrictLinearSrgbSdrTerminalCliResult {
  return {
    ok: false,
    command: "render",
    lane: "ffmpeg",
    frameLane: input.frameLane,
    frameTransport: input.frameTransport,
    ffmpegPlan: input.ffmpegPlan,
    error,
  };
}

export function combinedFailure(message: string, primary: unknown, cleanup: unknown): Error {
  return new Error(`${message}: ${errorText(primary)}; workspace cleanup: ${errorText(cleanup)}`, { cause: primary });
}

export function preparedCatalogFailure(
  input: StrictLinearSrgbSdrTerminalInput,
  receipt: OperationReceipt,
  prepared: RenderReceiptFinalizeResult,
  qualityCheck: StrictLinearSrgbSdrTerminalCliResult | undefined,
  finalCommand: FfmpegCommand,
): StrictLinearSrgbSdrTerminalCliResult {
  return {
    ok: false,
    command: "render",
    lane: "ffmpeg",
    frameLane: input.frameLane,
    preset: input.preset,
    ...workflowCatalogFields(prepared),
    ...(input.audioPath ? { audioPath: input.audioPath } : {}),
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
    outputPath: input.outputPath,
    output: receipt.output,
    receipt,
    ...(qualityCheck ? { qualityCheck } : {}),
    warnings: receipt.warnings,
    frameTransport: input.frameTransport,
    ffmpeg: finalCommand,
    error: prepared.error,
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
