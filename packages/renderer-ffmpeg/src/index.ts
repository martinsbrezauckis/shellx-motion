import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { ffmpegLooksAbsent, ffmpegMissingMessage, ffmpegRequirement, ffmpegSuggestedAction, type MotionToolRequirement } from "./tool-requirements.js";
import {
  FFMPEG_TIMEOUT_EXIT_CODE,
  appendFfmpegProcessOutput,
  nativeWindowsJobObjectRequired,
  portableFfmpegContainmentEvidence,
  redactFfmpegDiagnostic,
  summarizeFfmpegDiagnostic,
  unavailableWindowsContainment,
  windowsTaskkillFallbackEvidence,
  type FfmpegProcessTerminationMode
} from "./ffmpeg-process-control.js";
import { runSpawnedFfmpegChild } from "./ffmpeg-process-lifecycle.js";
import {
  motionPlatformRequirements,
  motionToolIdentity,
  motionToolReport,
  type MotionPlatformRequirements,
  type MotionToolIdentity,
  type MotionToolName,
  type MotionToolProbeResult,
  type MotionToolReport,
  type MotionToolSource
} from "./platform-requirements.js";
import {
  assertLocalMotionFrameCountBudget,
  assertMotionAudioMasterDuration,
  createRenderReceipt,
  evaluateMotionAudioMasterLoudness,
  normalizeMotionAudioMaster,
  defaultLocalMotionJobGovernor,
  FFMPEG_EXPORT_PRESETS,
  hashBuffer,
  hashFile,
  hashFramePaths,
  inspectFrameSequence,
  MOTION_EXPORT_PRESETS,
  LocalMotionJobError,
  cleanupWindowsJobObjectLaunchPlan,
  createWindowsJobObjectLaunchPlan,
  waitForWindowsJobObjectStatus,
  windowsJobObjectContainmentEvidence,
  WindowsJobObjectPlanError,
  isSpringEasing,
  parseCubicBezierEasing,
  // Audio automation used a private, byte-identical copy of the timeline evaluator's keyframe
  // reader — so a fix to core would have left the audio lane reading a stale rule. One reader now.
  readNumericKeyframes,
  type NumericMotionKeyframe,
  resolveEasing,
  // The Chrome/Chromium resolver the browser renderer launches through. Shared so the readiness
  // probe answers about the exact executable a render would use.
  resolveMotionBrowserExecutable,
  motionBrowserExecutableVerificationProblem,
  // Browser caches the resolver refused to execute out of, so a failed probe can say WHY instead of
  // reporting a bare "no browser found" on a machine that has one.
  untrustedMotionBrowserCaches,
  springPresetEasing,
  type FrameSequenceQualityPolicy,
  type LocalMotionJobErrorCode,
  type LocalMotionJobEvidence,
  type LocalMotionJobGovernor,
  type LocalMotionJobLane,
  type LocalMotionProcessContainmentEvidence,
  type WindowsJobObjectLaunchPlan,
  type WindowsJobObjectStatus,
  type MotionAudioDucking,
  type MotionAudioFadeCurve,
  type MotionAudioMasterBus,
  type MotionKeyframe,
  type OperationReceipt,
  type RenderEncoderReason,
  type RenderEncoderProbeEvidence,
  type RenderAudioMasterEvidence,
  type RenderLoudnessSummary,
  type RenderLoudnessTrack,
  acquireDerivedOutputPublication,
  DerivedOutputPublication,
  DerivedOutputPublicationError,
  isPublicationCommitUncertain,
  type PublicationCommitUncertainEvidence
} from "@shellx-motion/core";
import { probeMotionBrowserVersion } from "@shellx-motion/renderer-browser";
export type { CreateImageSequenceReceiptInput } from "./render-resource-preflight";
import type { CreateImageSequenceReceiptInput, RenderResourcePreflightInput } from "./render-resource-preflight";
import {
  buildFinalLoudnessSummary,
  collectFinalRenderInputHashes,
  finalReceiptAudioOutput,
  gradeFinalDeliveredColor,
  measureFinalLoudnessInputs,
  measureFinalProgramLoudness,
  resolveFinalAudioInputs
} from "./final-encode-shared.js";
import {
  assertQualityFfmpegMediaInput,
  assertSelfContainedFfmpegMediaInputs,
  qualityFfmpegMediaInputArgs,
  selfContainedFfmpegMediaInputArgs,
  snapshotSelfContainedFfmpegMediaInput,
  type FfmpegMediaInputSnapshot
} from "./ffmpeg-media-input-fence.js";
import {
  assertSafeFfmpegInputPath,
  assertSafeFfmpegOutputPath,
  effectiveEncodeInputRoots,
  encodePathSafetyError,
  localFileInputArgs
} from "./ffmpeg-path-safety.js";

// Centralized hardware-encode policy and probe cache. Re-exported so all five product render paths
// (CLI, debug-api, and the four Canvas/Cut connectors) import `encodeImageSequenceWithPolicy` and the
// cache helpers from the same renderer-ffmpeg entry that owns `encodeImageSequence` and the probes.
export * from "./encode-policy.js";
export { redactAbortedFinalOutputEvidence } from "./final-receipt-failure.js";
export {
  assertQualityFfmpegMediaInput,
  assertSelfContainedFfmpegMediaInputs,
  FfmpegMediaInputRefusal,
  MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES,
  MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES,
  qualityFfmpegMediaInputArgs,
  selfContainedFfmpegMediaInputArgs,
  trackingFfmpegMediaInputArgs
} from "./ffmpeg-media-input-fence.js";
export { snapshotSelfContainedFfmpegMediaInput } from "./ffmpeg-media-input-fence.js";
export type { FfmpegMediaInputSnapshot } from "./ffmpeg-media-input-fence.js";
/** Host-owned, visual-only exact-time video preview provider. Final staging and PCM remain separate. */
export { createGpuPreviewVideoFrameProvider } from "./gpu-video-preview-provider.js";
export type {
  CreateGpuPreviewVideoFrameProviderOptions,
  FfmpegGpuPreviewVideoFrameProvider,
  GpuPreviewFfmpegRunner,
  GpuPreviewVideoDecodedFrameEvidence,
  GpuPreviewVideoProviderDetailedEvidence
} from "./gpu-video-preview-provider.js";
// The sole public streamed-final adapter and its pure pre-execution planners. The lower-level
// streaming foundation and encode policy remain package-private implementation details.
export { planFinalVideoFrameTransport } from "./final-video-frame-transport.js";
export type {
  FinalVideoFrameTransportPlan,
  FinalVideoFrameTransportPlanInput,
  FinalVideoFrameTransportReason
} from "./final-video-frame-transport.js";
export { planStreamingFinalCommand } from "./streaming-final-command-plan.js";
export { renderStreamingFinal } from "./streaming-final-adapter.js";
/** Recompute strict GPU receipt bindings before a connector projects renderer evidence. */
export { gpuFinalReceiptInputHashes } from "./gpu-final-receipt-provenance.js";
export { preliminaryGpuAudio } from "./streaming-final-gpu-audio.js";
export type {
  PlanStreamingFinalCommandInput,
  RenderStreamingFinalInput,
  RenderStreamingFinalResult,
  StreamingFinalCommandPlanResult,
  StreamingFinalEncoderHandoffEvidence,
  StreamingFinalFrameTransportEvidence,
  StreamingFinalNativeProducerEvidence,
  StreamingFinalProducerEvidence,
  StreamingFinalToolPolicy
} from "./streaming-final-adapter-types.js";
/** Closed public durable-segment final delivery; raw segment stores and concat controls stay private. */
export { renderSegmentedFinal } from "./segmented-final.js";
export type {
  RenderSegmentedFinalInput,
  RenderSegmentedFinalResult,
  SegmentedFinalErrorCode,
  SegmentedFinalFrameTransportEvidence,
  SegmentedGpuToolPolicy,
  SegmentedFinalOptions,
  SegmentedFinalPublicFailure,
  SegmentedFinalToolPolicy
} from "./segmented-final.js";

/**
 * Budget for a tool IDENTITY probe (`-version` / `--version`), as opposed to an encode.
 *
 * Fifteen seconds, not the encode's ten minutes. A program printing one line and exiting needs
 * milliseconds; the headroom is for a cold first launch of a several-hundred-megabyte browser
 * behind an on-access virus scanner. Past that it is not slow, it is not answering — and "found but
 * did not answer a version probe" is precisely the `broken` verdict the report should give. See
 * {@link createToolIdentityProbeRunner}.
 */
const DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS = 15 * 1000;
const AUDIO_CUBIC_BEZIER_SAMPLE_SEGMENTS = 8;
// EBU R128 loudness normalization targets applied by loudnorm (both passes).
const LOUDNORM_TARGET_I = -16;
const LOUDNORM_TARGET_TP = -1.5;
const LOUDNORM_TARGET_LRA = 11;
// Springs oscillate, so their volume-automation curve needs finer piecewise
// sampling than a monotone cubic-bezier to keep the ffmpeg expression faithful.
const AUDIO_SPRING_SAMPLE_SEGMENTS = 48;

export interface FfmpegCommand {
  executable: string;
  args: string[];
  shell: false;
}

export interface FfmpegProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  resources?: LocalMotionJobEvidence;
  resourceErrorCode?: LocalMotionJobErrorCode;
}

export type FfmpegRunner = (command: FfmpegCommand) => Promise<FfmpegProcessResult>;

export interface GovernedFfmpegRunnerOptions {
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  /** Trusted host override used by contained analysis jobs that use FFmpeg only as a decoder. */
  lane?: LocalMotionJobLane;
  operation?: string;
  signal?: AbortSignal;
  /**
   * Stable owner identity for the work, used for visibility and never for scheduling.
   *
   * Supplied by the host through the CLI, the Debug API, or the SDK. Without it the job is
   * recorded as unattributed, which means every caller shares one visibility bucket.
   */
  callerId?: string;
  /**
   * The id this job will be known by.
   *
   * Supplied by a host that wants to address the job before it finishes: it can query
   * `motion.job.get` with this id while the encode is still running. Omitted, Motion mints one and
   * returns it in the job evidence.
   */
  jobId?: string;
}

export type FfmpegHealth =
  | { ok: true; command: "ffmpeg"; version: string }
  | {
      ok: false;
      command: "ffmpeg";
      error: {
        code: "ffmpeg_not_configured" | LocalMotionJobErrorCode;
        message: string;
        /** One line naming the fix. Present when the failure is a missing or unusable FFmpeg. */
        suggestedAction?: string;
        /** Structured install guidance, so a host UI can offer the command as a button. */
        requirement?: MotionToolRequirement;
        /** The raw underlying error, kept for diagnosing a broken install rather than a missing one. */
        detail?: string;
      };
    };

export type FfmpegVideoCodecFamily = "h264" | "hevc" | "av1" | "vp9" | "prores";

/**
 * FFmpeg hardware (GPU/fixed-function) video encoders this renderer can probe and select.
 *
 * Membership here does NOT imply the encoder is usable on the current machine — usability is
 * proved per-machine by `probeFfmpegHardwareEncoderUsability`, which runs a real 1-frame encode
 * and only reports an encoder as usable when it initializes. Selection is always gated on that
 * probe result, never on platform guessing (a Linux box may have `hevc_nvenc` compiled but no GPU).
 *
 * `h264_vaapi` is retained for the usability probe as evidence only; it is deliberately NOT wired
 * as a selectable encode candidate because VAAPI requires a `format=nv12,hwupload` filter graph
 * that is incompatible with the colour-managed software `-vf scale=...` chain used by every preset.
 * Wiring VAAPI cleanly needs its own filter-graph design and a VAAPI rig to verify — deferred.
 */
export type FfmpegHardwareEncoder =
  | "h264_nvenc"
  | "hevc_nvenc"
  | "av1_nvenc"
  | "h264_videotoolbox"
  | "hevc_videotoolbox"
  | "h264_qsv"
  | "hevc_qsv"
  | "av1_qsv"
  | "h264_amf"
  | "hevc_amf"
  | "av1_amf"
  | "h264_vaapi";

export type FfmpegEncoderCapabilities =
  | {
      ok: true;
      command: "ffmpeg";
      compiledEncoders: string[];
      codecs: Record<FfmpegVideoCodecFamily, string[]>;
      softwarePreferred: Record<FfmpegVideoCodecFamily, string | null>;
    }
  | {
      ok: false;
      command: "ffmpeg";
      error: { code: "ffmpeg_encoder_probe_failed" | LocalMotionJobErrorCode; message: string };
    };

/**
 * Result of proving, per-machine, which hardware encoders actually initialize.
 *
 * `usableEncoders` is the authoritative gate for hardware selection: an encoder appears here only
 * after a real 1-frame encode succeeded on this machine, in probe order (most-preferred first).
 * `probes` carries the full per-encoder evidence (compiled? usable? why it failed) for receipts.
 */
export type FfmpegHardwareEncoderUsability =
  | {
      ok: true;
      command: "ffmpeg";
      selection: "first-usable";
      /** Encoders that initialized successfully on this machine, in probe order. */
      usableEncoders: FfmpegHardwareEncoder[];
      probes: Array<{
        encoder: FfmpegHardwareEncoder;
        compiled: boolean;
        usable: boolean;
        status: "not_compiled" | "usable" | "initialization_failed";
        exitCode?: number;
        message?: string;
      }>;
    }
  | {
      ok: false;
      command: "ffmpeg";
      error: { code: "ffmpeg_encoder_probe_failed" | LocalMotionJobErrorCode; message: string };
    };

export interface FfmpegColorProfile {
  profile: "sdr-bt709";
  primaries: "bt709";
  transfer: "bt709";
  matrix: "bt709";
  range: "tv";
  conversion: "rgb-full-to-yuv-limited";
}

/** The four colour tags a delivered file can carry, named as the declared profile names them. */
export type FfmpegColorTag = "primaries" | "transfer" | "matrix" | "range";

/**
 * Colour tags the DELIVERED file was measured to carry, read back with ffprobe after the encode.
 *
 * `null` means the container/bitstream does not carry that tag at all — ffprobe omits the key
 * rather than reporting "unknown", so absence here is a real observation, not a parse gap.
 *
 * This exists because the declared `FfmpegColorProfile` is a restatement of INTENT: it is what the
 * preset asked FFmpeg for. A Windows FFmpeg 8.x build was measured delivering HEVC and AV1 with
 * `transfer` and `primaries` missing while the receipt asserted bt709 for both, which took a second
 * machine to notice. `observed` is what the file actually says, so the receipt can be checked
 * against reality on the host that produced it.
 */
export interface FfmpegObservedColor {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  range: string | null;
}

export type FfmpegExportPreset = "mp4-h264" | "mp4-hevc" | "webm-av1" | "webm-vp9" | "webm-vp9-alpha" | "gif" | "mov-prores";
export type ImageSequenceExportPreset = "png-sequence";
export type StillFrameExportPreset = "png-frame" | "jpeg-frame";
export type MotionExportPreset = FfmpegExportPreset | ImageSequenceExportPreset | StillFrameExportPreset;

/**
 * A single hardware-encoder candidate for a preset.
 *
 * Hardware rate control (NVENC `-rc vbr -cq`, VideoToolbox `-q:v`, QSV `-global_quality`, AMF
 * `-rc cqp`) differs fundamentally from libx264/libx265 CRF, so a candidate cannot be produced by
 * swapping `-c:v` inside the software preset template. Each candidate therefore carries its own
 * COMPLETE output-arg set (from `-c:v` through the shared SDR-BT.709 colour tagging and any
 * container flags). Frame pixels are identical regardless of which candidate runs — only the
 * compressed bitstream and its size differ — so the frame-sequence input hash is unaffected.
 */
export interface FfmpegHardwareEncodeCandidate {
  /** Hardware encoder name passed to `-c:v` (e.g. "h264_nvenc"). */
  encoder: FfmpegHardwareEncoder;
  /** Complete FFmpeg output args for this candidate (deliberate, researched rate control). */
  outputArgs: string[];
  /** Human-auditable one-line summary of the rate-control choice, recorded in the receipt. */
  rateControl: string;
}

/**
 * Preset-level hardware-encode policy, parallel to (and independent of) the software `encoderPolicy`.
 * The software `encoderPolicy` disambiguates BETWEEN software encoders (libx265 vs libaom-av1 …);
 * this policy adds the optional GPU upgrade. When a hardware candidate is probe-verified and not
 * overridden it runs by default; on any hardware-encode failure the encode automatically retries
 * the `softwareFallback` (or the software `encoderPolicy` selection) and records the fallback.
 */
export interface FfmpegHardwareEncodePolicy {
  family: FfmpegVideoCodecFamily;
  /** Software encoder used when no hardware candidate is usable, forced off, or a hw encode fails. */
  softwareFallback: string;
  /** Ordered hardware candidates, most-preferred first; each gated on the usability probe. */
  candidates: FfmpegHardwareEncodeCandidate[];
}

export interface FfmpegExportPresetSpec {
  preset: FfmpegExportPreset;
  label: string;
  codec: string;
  container: string;
  extension: string;
  mimeType: string;
  outputArgs: string[];
  audioCodec: string | null;
  supportsAudio: boolean;
  supportsAlpha: boolean;
  color: FfmpegColorProfile | null;
  /**
   * Colour tags this preset's CONTAINER cannot signal, so their absence is expected rather than a
   * defect. Kept per-preset (not on the shared colour profile) because it is a container property:
   * the same BT.709 profile is fully signalled in MP4/WebM and partly signalled in MOV.
   *
   * Measured, not assumed — see the colour-readback grading below.
   */
  colorTagsNotSignaled?: readonly FfmpegColorTag[];
  encoderPolicy?: {
    family: "hevc" | "av1";
    mode: "software-preferred";
    candidates: string[];
  };
  /**
   * Optional hardware-encode upgrade for this preset. Gated on the per-machine usability probe;
   * default-on for the product render paths (CLI / debug-api) unless a software override is set.
   */
  hardwareEncode?: FfmpegHardwareEncodePolicy;
}

export type FfmpegPresetEncoderSelection =
  | { ok: true; preset: FfmpegExportPreset; family: "hevc" | "av1" | null; encoder: string | null; mode: "static" | "software-preferred" }
  | { ok: false; preset: FfmpegExportPreset; error: { code: "ffmpeg_encoder_probe_failed" | "encoder_unavailable" | LocalMotionJobErrorCode; message: string } };

export interface ImageSequenceExportPresetSpec {
  preset: ImageSequenceExportPreset;
  label: string;
  codec: string;
  container: "image-sequence";
  extension: string;
  mimeType: string;
  outputArgs: [];
  audioCodec: null;
  supportsAudio: false;
  supportsAlpha: true;
  outputKind: "image_sequence";
}

export interface StillFrameExportPresetSpec {
  preset: StillFrameExportPreset;
  label: string;
  codec: "png" | "jpeg";
  container: "image";
  extension: "png" | "jpg";
  mimeType: "image/png" | "image/jpeg";
  outputArgs: [];
  audioCodec: null;
  supportsAudio: false;
  supportsAlpha: boolean;
  outputKind: "still_frame";
}

export type MotionExportPresetSpec = FfmpegExportPresetSpec | ImageSequenceExportPresetSpec | StillFrameExportPresetSpec;

export type EncodeResult =
  | { ok: true; receipt: OperationReceipt; command: FfmpegCommand }
  | {
      ok: false;
      error: { code: "ffmpeg_failed" | "ffmpeg_encoder_probe_failed" | "encoder_unavailable" | "frame_quality_failed" | "audio_master_quality_failed" | "audio_master_unavailable" | "audio_master_invalid" | "invalid_output_path" | "unsafe_input_path" | "derived_output_busy" | "derived_output_exists" | "derived_output_unsafe_parent" | "derived_output_stage_invalid" | "derived_output_publish_failed" | "publication_commit_uncertain" | LocalMotionJobErrorCode; message: string; possiblyCommitted?: true; publicPaths?: readonly string[]; expectedPublication?: PublicationCommitUncertainEvidence };
      command: FfmpegCommand;
      /** Present when encoding produced a nonconforming final file that must remain receipted. */
      receipt?: OperationReceipt;
    };

/**
 * First-pass EBU R128 measurement of a source track, used to drive the second
 * (apply) pass of two-pass loudness normalization. All values are finite (an
 * incomplete/non-finite measurement is discarded and the track falls back to
 * single-pass loudnorm rather than carrying this object).
 */
export interface LoudnormMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
  thresholdLufs: number;
  offsetLu: number;
}

export interface FfmpegAudioInput {
  path: string;
  /** Original caller-visible path retained when `path` is a private admitted snapshot. */
  receiptPath?: string;
  /** Hash of the private admitted bytes; this, never a later live-path read, binds the receipt. */
  snapshotSha256?: string;
  /**
   * Source motion layer id (when known). Used only to resolve a sidechain
   * ducking track's triggerLayerIds to concrete FFmpeg input indices; it does
   * not affect the per-input audio filter chain.
   */
  layerId?: string;
  /**
   * Measured first-pass loudness of this track. When present (and the track sets
   * `normalizeLoudness`), the encode applies two-pass loudnorm with these
   * measured_* values; when absent it falls back to single-pass loudnorm.
   */
  loudnormMeasured?: LoudnormMeasurement;
  startMs?: number;
  durationMs?: number;
  trimStartMs?: number;
  trimDurationMs?: number;
  loop?: boolean;
  volume?: number;
  pan?: number;
  muted?: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeCurve?: MotionAudioFadeCurve;
  normalizeLoudness?: boolean;
  playbackRate?: number;
  ducking?: MotionAudioDucking;
  volumeKeyframes?: MotionKeyframe[];
  panKeyframes?: MotionKeyframe[];
}

export interface EncodeImageSequenceInput extends RenderResourcePreflightInput {
  packageId: string;
  framesDir: string;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  outputPath: string;
  /** Existing identity-bound publication for an outer quality/publish transaction. */
  outputPublication?: DerivedOutputPublication;
  preset?: FfmpegExportPreset;
  audioPath?: string;
  audio?: FfmpegAudioInput;
  audioTracks?: FfmpegAudioInput[];
  audioMaster?: MotionAudioMasterBus;
  inputRoots?: string[];
  outputRoots?: string[];
  quality?: FrameSequenceQualityPolicy;
  runner?: FfmpegRunner;
  now?: () => string;
  /**
   * FFmpeg's own version line, as already probed by the caller (`checkFfmpeg`). Recorded on the
   * receipt as encoder provenance (the tool-identity invariant): "libx264" alone does not identify an
   * encode, because two FFmpeg builds select different filters, muxers and defaults and emit
   * different warnings. Omitted rather than guessed when the caller did not probe.
   */
  ffmpegVersion?: string | null;
  /**
   * Force the software encoder even when a hardware candidate is probe-verified. Defaults to the
   * `SHELLX_MOTION_FORCE_SOFTWARE_ENCODE` env flag (1/true/yes). Use for reproducibility-critical
   * contexts where the exact libx264/libx265 bitstream matters. The receipt records the reason
   * as `forced-software`.
   */
  forceSoftwareEncode?: boolean;
  /**
   * Run the hardware usability probe (when the preset has hardware candidates and software is not
   * forced) and prefer a probe-verified hardware encoder. The product render paths (CLI / debug-api)
   * set this true so GPU encoding is the default when the machine proves it; library callers that
   * omit it get the software-only behaviour with no probe subprocesses.
   */
  probeHardwareEncode?: boolean;
  /**
   * Read the delivered file's colour tags back with ffprobe and grade them against the preset's
   * declared profile, recording the reading as `output.color.observed` and warning when the file
   * does not carry what the preset promised.
   *
   * ON BY DEFAULT . Pass `false` only where the extra ffprobe subprocess itself is the
   * thing under test. It costs one ffprobe per encode, on a preset that declares a colour profile.
   *
   * The reason it is default-on rather than an opt-in the product paths remember to set: without it
   * `output.color` is a restatement of the preset's INTENT, never an observation, and an intent is
   * not evidence. A Windows FFmpeg 8.x build was measured during cross-host verification delivering HEVC and AV1
   * files with `transfer` and `primaries` absent while the receipt asserted bt709 for both; nothing
   * in Motion noticed, and it took a second machine and a hand-run ffprobe to find. A check that is
   * off unless a caller opts in would have stayed off on exactly that machine. See
   * `gradeDeliveredColor` for the failure direction (inert when the readback cannot be trusted).
   */
  verifyDeliveredColor?: boolean;
  /**
   * Pre-computed hardware usability probe result to reuse instead of running the probe here (tests,
   * or a caller that probes once per session). Takes precedence over `probeHardwareEncode`.
   */
  hardwareProbe?: FfmpegHardwareEncoderUsability;
  /**
   * Provenance of an injected {@link hardwareProbe}, recorded in the receipt's `encoderProbe` so the
   * render receipt shows whether the hardware decision came from a fresh probe or a cached one. Set by
   * the centralized encode-policy service; library callers that inject a probe directly may omit it.
   */
  encoderProbeProvenance?: "fresh-probe" | "cached";
  /**
   * Lazy, cache-aware hardware-probe resolver. When set (and software is not forced and the preset
   * has hardware candidates), it is called INSTEAD of the direct probe — but only AFTER the frame quality
   * gate, so a doomed sequence never triggers a probe. The centralized encode-policy service supplies a
   * resolver that reuses a cached probe when available; its returned provenance is recorded in the receipt.
   */
  hardwareProbeResolver?: HardwareProbeResolver;
  /** Stable owner identity threaded to the job governor for per-owner visibility. */
  callerId?: string;
}

/** Inputs handed to a {@link HardwareProbeResolver}: the preset family and its candidate encoders. */
export interface HardwareProbeResolverInput {
  family: FfmpegVideoCodecFamily;
  encoders: FfmpegHardwareEncoder[];
  runner: FfmpegRunner;
}

/** A cache-aware hardware usability probe: returns the probe plus whether it was fresh or cached. */
export interface ResolvedHardwareProbe {
  probe: FfmpegHardwareEncoderUsability;
  provenance: "fresh-probe" | "cached";
}

/** Resolves the hardware usability probe for a render, potentially from a shared cache. */
export type HardwareProbeResolver = (input: HardwareProbeResolverInput) => Promise<ResolvedHardwareProbe>;

export interface CreateStillFrameReceiptInput {
  packageId: string;
  outputPath: string;
  preset: StillFrameExportPreset;
  width: number;
  height: number;
  atMs: number;
  warnings?: string[];
  now?: () => string;
}

export interface ProbeMediaResult {
  ok: true;
  path: string;
  codec: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  container: string;
  color: {
    pixelFormat: string | null;
    space: string | null;
    transfer: string | null;
    primaries: string | null;
    range: string | null;
  };
  alpha: {
    present: boolean;
    mode: string | null;
    pixelFormat: string | null;
    decoder: string | null;
  };
  audio: {
    present: boolean;
    streamCount: number;
    streams: Array<{
      codec: string;
      channels: number | null;
      channelLayout: string | null;
      sampleRate: number | null;
      sampleFormat: string | null;
      bitRate: number | null;
      durationMs: number | null;
    }>;
  };
}

export interface AudioLevelResult {
  ok: true;
  path: string;
  sampleCount: number | null;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  meanVolumeDbfs: number | null;
  samplePeakDbfs: number | null;
  integratedLoudnessLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  loudnessThresholdLufs: number | null;
  targetOffsetLu: number | null;
  loudnessMeasurement: "ebu-r128-loudnorm";
  loudnessComplete: boolean;
}

export async function checkFfmpeg(options: { runner?: FfmpegRunner } = {}): Promise<FfmpegHealth> {
  const runner = options.runner ?? spawnRunner;
  const executable = resolveFfmpegExecutable();
  const result = await runner({ executable, args: ["-version"], shell: false });
  if (result.exitCode !== 0) {
    const raw = summarizeStderr(result.stderr || result.stdout || "ffmpeg is not available");
    // Install guidance is attached ONLY when the binary is genuinely absent. A timeout, a governor
    // rejection or a broken install are different problems, and telling that user to install FFmpeg
    // would send them to repair something that is not wrong.
    //
    // When it IS absent: `spawn ffmpeg ENOENT` is the truth and tells a newcomer nothing, because
    // they do not know FFmpeg is a separate program Motion depends on. ShellX Cut hit exactly this —
    // users concluded "nothing works" over one missing binary. The raw error stays in `detail`.
    if (!ffmpegLooksAbsent(raw)) {
      return {
        ok: false,
        command: "ffmpeg",
        error: { code: result.resourceErrorCode ?? "ffmpeg_not_configured", message: raw }
      };
    }
    return {
      ok: false,
      command: "ffmpeg",
      error: {
        code: result.resourceErrorCode ?? "ffmpeg_not_configured",
        message: ffmpegMissingMessage(raw, executable),
        suggestedAction: ffmpegSuggestedAction(),
        requirement: ffmpegRequirement({ present: false, resolvedFrom: executable, rawError: raw }),
        detail: raw
      }
    };
  }

  return { ok: true, command: "ffmpeg", version: firstLine(result.stdout) };
}

export async function probeFfmpegEncoderCapabilities(options: { runner?: FfmpegRunner } = {}): Promise<FfmpegEncoderCapabilities> {
  const runner = options.runner ?? spawnRunner;
  const result = await runner({ executable: resolveFfmpegExecutable(), args: ["-hide_banner", "-encoders"], shell: false });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      command: "ffmpeg",
      error: {
        code: result.resourceErrorCode ?? "ffmpeg_encoder_probe_failed",
        message: summarizeStderr(result.stderr || result.stdout || "FFmpeg encoder discovery failed")
      }
    };
  }
  const compiledEncoders = parseFfmpegVideoEncoders(`${result.stdout}\n${result.stderr}`);
  const codecs: Record<FfmpegVideoCodecFamily, string[]> = {
    h264: encodersMatching(compiledEncoders, /^(?:libx264|h264_)/),
    hevc: encodersMatching(compiledEncoders, /^(?:libx265|hevc_)/),
    av1: encodersMatching(compiledEncoders, /^(?:libaom-av1|libsvtav1|librav1e|av1_)/),
    vp9: encodersMatching(compiledEncoders, /^(?:libvpx-vp9|vp9_)/),
    prores: encodersMatching(compiledEncoders, /^prores_/)
  };
  return {
    ok: true,
    command: "ffmpeg",
    compiledEncoders,
    codecs,
    softwarePreferred: {
      h264: firstAvailable(codecs.h264, ["libx264"]),
      hevc: firstAvailable(codecs.hevc, ["libx265"]),
      av1: firstAvailable(codecs.av1, ["libsvtav1", "libaom-av1", "librav1e"]),
      vp9: firstAvailable(codecs.vp9, ["libvpx-vp9"]),
      prores: firstAvailable(codecs.prores, ["prores_ks", "prores_aw"])
    }
  };
}

/**
 * Full hardware-encoder probe order, grouped so the most-preferred vendor per codec is tried first.
 * Order within a codec: NVENC -> VideoToolbox (macOS) -> QSV -> AMF. Only
 * one vendor's GPU can pass the init probe on a given machine, so cross-vendor order rarely matters;
 * `h264_vaapi` stays last for evidence only (never selected — see `FfmpegHardwareEncoder`).
 */
const HARDWARE_ENCODER_PROBE_ORDER: FfmpegHardwareEncoder[] = [
  "h264_nvenc",
  "hevc_nvenc",
  "av1_nvenc",
  "h264_videotoolbox",
  "hevc_videotoolbox",
  "h264_qsv",
  "hevc_qsv",
  "av1_qsv",
  "h264_amf",
  "hevc_amf",
  "av1_amf",
  "h264_vaapi"
];

/**
 * Prove, per-machine, which hardware encoders actually initialize by running a real 1-frame encode
 * for each compiled candidate. This is the SOLE gate for hardware selection — an encoder that is
 * merely compiled into FFmpeg (but whose GPU/driver is absent) reports `initialization_failed` and
 * is never offered. The probe is deliberately kept to a tiny single-frame encode (256x256 — above
 * the NVENC minimum frame dimension) so it is cheap enough to run once per render.
 *
 * @param options.encoders     Subset of hardware encoders to probe (default: all). Callers pass just
 *                             the target preset's family candidates to avoid spawning irrelevant probes.
 * @param options.capabilities Already-computed `-encoders` capabilities to reuse (avoids a redundant
 *                             `ffmpeg -encoders` call when the caller has one in hand).
 */
export async function probeFfmpegHardwareEncoderUsability(options: {
  runner?: FfmpegRunner;
  vaapiDevice?: string;
  encoders?: FfmpegHardwareEncoder[];
  capabilities?: FfmpegEncoderCapabilities;
} = {}): Promise<FfmpegHardwareEncoderUsability> {
  const runner = options.runner ?? spawnRunner;
  const capabilities = options.capabilities ?? await probeFfmpegEncoderCapabilities({ runner });
  if (!capabilities.ok) return capabilities;

  const requested = options.encoders ?? HARDWARE_ENCODER_PROBE_ORDER;
  // Preserve the canonical probe order regardless of the caller's list ordering.
  const encoders = HARDWARE_ENCODER_PROBE_ORDER.filter((encoder) => requested.includes(encoder));
  const compiled = new Set(capabilities.compiledEncoders);
  const vaapiDevice = options.vaapiDevice ?? (existsSync("/dev/dri/renderD128") ? "/dev/dri/renderD128" : undefined);
  const probes: Extract<FfmpegHardwareEncoderUsability, { ok: true }>["probes"] = [];
  for (const encoder of encoders) {
    if (!compiled.has(encoder)) {
      probes.push({ encoder, compiled: false, usable: false, status: "not_compiled" });
      continue;
    }
    const result = await runner(buildHardwareEncoderProbeCommand(encoder, vaapiDevice));
    if (result.resourceErrorCode) {
      return {
        ok: false,
        command: "ffmpeg",
        error: {
          code: result.resourceErrorCode,
          message: summarizeStderr(result.stderr || result.stdout || `${encoder} probe was stopped by the resource governor`)
        }
      };
    }
    if (result.exitCode === 0) {
      probes.push({ encoder, compiled: true, usable: true, status: "usable", exitCode: 0 });
    } else {
      probes.push({
        encoder,
        compiled: true,
        usable: false,
        status: "initialization_failed",
        exitCode: result.exitCode,
        message: summarizeHardwareProbeFailure(result.stderr || result.stdout || `${encoder} initialization failed`)
      });
    }
  }
  const usableEncoders = probes
    .filter((probe): probe is typeof probe & { encoder: FfmpegHardwareEncoder; usable: true } => probe.usable)
    .map((probe) => probe.encoder);
  return {
    ok: true,
    command: "ffmpeg",
    selection: "first-usable",
    usableEncoders,
    probes
  };
}

function summarizeHardwareProbeFailure(value: string): string {
  return summarizeStderr(value).replace(/\b0x[0-9a-f]+\b/gi, "[address]");
}

function buildHardwareEncoderProbeCommand(encoder: FfmpegHardwareEncoder, vaapiDevice?: string): FfmpegCommand {
  const inputArgs = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-f", "lavfi",
    // 256x256: NVENC (and other fixed-function encoders) reject frames below a hardware minimum with
    // "Frame Dimension less than the minimum supported value" — a too-small probe frame would report
    // a working GPU encoder as unusable. 256x256 clears the minimum for h264/hevc/av1 NVENC (verified
    // on an RTX 5080) while staying a tiny single-frame encode. Verified: 128x128 fails, 256x256 passes.
    "-i", "color=c=black:s=256x256:r=1:d=1",
    "-frames:v", "1"
  ];
  // Vendor-specific init requirements. VAAPI needs an explicit device + hwupload; VideoToolbox is
  // forced to true hardware with `-allow_sw 0` so the probe cannot pass on a software fallback;
  // NVENC/QSV/AMF accept plain nv12 CPU frames. Format is keyed on the vendor suffix, not the codec,
  // so hevc_/av1_ variants reuse the same rule as their h264_ sibling.
  const hardwareArgs = encoder.endsWith("_vaapi")
    ? [...(vaapiDevice ? ["-vaapi_device", vaapiDevice] : []), "-vf", "format=nv12,hwupload"]
    : encoder.endsWith("_videotoolbox")
      ? ["-vf", "format=nv12", "-allow_sw", "0"]
      : ["-vf", "format=nv12"];
  return {
    executable: resolveFfmpegExecutable(),
    args: [...inputArgs, ...hardwareArgs, "-c:v", encoder, "-f", "null", "-"],
    shell: false
  };
}

export function parseFfmpegVideoEncoders(output: string): string[] {
  const encoders = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*V[VAS\.FSDXBT]{5}\s+([^\s=]+)\s+/.exec(line);
    if (match) encoders.add(match[1]);
  }
  return [...encoders].sort();
}

export function selectFfmpegPresetEncoder(
  presetValue: FfmpegExportPreset,
  capabilities: FfmpegEncoderCapabilities
): FfmpegPresetEncoderSelection {
  const preset = resolveExportPreset(presetValue);
  if (!preset.encoderPolicy) {
    return { ok: true, preset: preset.preset, family: null, encoder: null, mode: "static" };
  }
  if (!capabilities.ok) {
    return {
      ok: false,
      preset: preset.preset,
      error: { code: capabilities.error.code, message: capabilities.error.message }
    };
  }
  const encoder = firstAvailable(capabilities.codecs[preset.encoderPolicy.family], preset.encoderPolicy.candidates);
  if (encoder) {
    return {
      ok: true,
      preset: preset.preset,
      family: preset.encoderPolicy.family,
      encoder,
      mode: preset.encoderPolicy.mode
    };
  }
  const compiled = capabilities.codecs[preset.encoderPolicy.family];
  return {
    ok: false,
    preset: preset.preset,
    error: {
      code: "encoder_unavailable",
      message: `Export preset ${preset.preset} requires a supported software ${preset.encoderPolicy.family.toUpperCase()} encoder (${preset.encoderPolicy.candidates.join(", ")}); compiled ${preset.encoderPolicy.family.toUpperCase()} encoders: ${compiled.length > 0 ? compiled.join(", ") : "none"}.`
    }
  };
}

function encodersMatching(encoders: string[], pattern: RegExp): string[] {
  return encoders.filter((encoder) => pattern.test(encoder));
}

function firstAvailable(available: string[], preferred: string[]): string | null {
  return preferred.find((encoder) => available.includes(encoder)) ?? null;
}

export async function encodeImageSequence(input: EncodeImageSequenceInput): Promise<EncodeResult> {
  const outputPathError = ffmpegPresetOutputPathError(resolveExportPreset(input.preset).preset, input.outputPath);
  if (outputPathError) {
    return { ok: false, command: { executable: resolveFfmpegExecutable(), args: [], shell: false }, error: { code: "invalid_output_path", message: outputPathError } };
  }
  const rawAudioInputs = resolveFinalAudioInputs(input);
  const pathSafetyError = encodePathSafetyError(input, rawAudioInputs);
  if (pathSafetyError) {
    return { ok: false, command: { executable: resolveFfmpegExecutable(), args: [], shell: false }, error: { code: "unsafe_input_path", message: pathSafetyError } };
  }
  let publication = input.outputPublication;
  const ownsPublication = publication === undefined;
  if (publication !== undefined && (!(publication instanceof DerivedOutputPublication)
    || publication.kind !== "file"
    || publication.outputPath !== resolve(input.outputPath))) {
    return { ok: false, command: { executable: resolveFfmpegExecutable(), args: [], shell: false }, error: { code: "derived_output_stage_invalid", message: "Final output publication must be an identity-bound Motion reservation." } };
  }
  if (!publication) {
    try {
      publication = await acquireDerivedOutputPublication({ outputPath: input.outputPath, kind: "file" });
    } catch (error) {
      const code = error instanceof DerivedOutputPublicationError ? error.code : "derived_output_publish_failed";
      return { ok: false, command: { executable: resolveFfmpegExecutable(), args: [], shell: false }, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  }
  let snapshots: FfmpegMediaInputSnapshot[] = [];
  let published = false;
  try {
    snapshots = await Promise.all(rawAudioInputs.map(async (audio) =>
      await snapshotSelfContainedFfmpegMediaInput(audio.path, effectiveEncodeInputRoots(input), "final-audio")
    ));
    const admittedAudioInputs = rawAudioInputs.map((audio, index) => ({
      ...audio,
      path: snapshots[index]!.path,
      receiptPath: audio.receiptPath ?? audio.path,
      snapshotSha256: snapshots[index]!.sha256
    }));
    const result = await encodeImageSequenceFromAdmitted({
      ...input,
      outputPath: publication.stagingPath,
      outputRoots: [publication.rootPath],
      outputPublication: undefined,
      audioPath: undefined,
      audio: undefined,
      audioTracks: admittedAudioInputs,
      // The frame sequence and each private copy are the only FFmpeg inputs for the encode.
      inputRoots: [input.framesDir, ...(input.inputRoots ?? []), ...snapshots.map((snapshot) => snapshot.root)]
    });
    if (!ownsPublication) return result;
    if (result.ok) {
      await publication.publishFile(await publication.verifyFile());
      published = true;
    }
    remapEncodedPublicationPaths(result, publication.stagingPath, input.outputPath);
    return result;
  } catch (error) {
    const uncertainty = isPublicationCommitUncertain(error) ? error : undefined;
    const code = uncertainty?.code ?? (error instanceof DerivedOutputPublicationError ? error.code : "unsafe_input_path");
    return { ok: false, command: { executable: resolveFfmpegExecutable(), args: [], shell: false }, error: {
      code, message: error instanceof Error ? error.message : String(error),
      ...(uncertainty ? { possiblyCommitted: true as const, publicPaths: [uncertainty.evidence.publicPath], expectedPublication: uncertainty.evidence } : {})
    } };
  } finally {
    await Promise.all(snapshots.map(async (snapshot) => await snapshot.release()));
    if (ownsPublication && !published) await publication.abort();
  }
}

function remapEncodedPublicationPaths(result: EncodeResult, stagingPath: string, outputPath: string): void {
  result.command.args = result.command.args.map((arg) => arg === stagingPath ? outputPath : arg);
  if (!result.receipt) return;
  const receiptOutput = result.receipt.output;
  if (receiptOutput && typeof receiptOutput === "object" && !Array.isArray(receiptOutput)) {
    result.receipt.output = Object.fromEntries([...Object.entries(receiptOutput), ["path", outputPath]]);
  }
  result.receipt.artifacts = result.receipt.artifacts?.map((artifact) => artifact.path === stagingPath ? { ...artifact, path: outputPath } : artifact);
}

async function encodeImageSequenceFromAdmitted(input: EncodeImageSequenceInput): Promise<EncodeResult> {
  const runner = input.runner ?? spawnRunner;
  const frameCount = frameCountFor(input.durationMs, input.fps);
  try {
    assertLocalMotionFrameCountBudget(frameCount);
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      return {
        ok: false,
        command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
        error: { code: error.code, message: error.message },
      };
    }
    throw error;
  }
  const framePaths = Array.from({ length: frameCount }, (_, index) =>
    join(input.framesDir, `${String(index + 1).padStart(6, "0")}.png`)
  );
  const preset = resolveExportPreset(input.preset);
  let audioMaster: MotionAudioMasterBus | undefined;
  try {
    audioMaster = normalizeRendererAudioMaster(input.audioMaster);
    if (audioMaster) assertMotionAudioMasterDuration(audioMaster, input.durationMs);
  } catch (error) {
    return {
      ok: false,
      command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
      error: { code: "audio_master_invalid", message: error instanceof Error ? error.message : String(error) }
    };
  }
  const audioInputs = resolveFinalAudioInputs(input);
  if (audioMaster && (audioInputs.length === 0 || !preset.audioCodec)) {
    return {
      ok: false,
      command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
      error: {
        code: "audio_master_unavailable",
        message: "Document audio master requires a final-video preset and at least one resolved audio input."
      }
    };
  }
  const compatibilityWarnings = audioWarningsForExportPreset(preset.preset, audioInputs.length);
  const pathSafetyError = encodePathSafetyError(input, audioInputs);
  if (pathSafetyError) {
    return {
      ok: false,
      command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
      error: {
        code: "unsafe_input_path",
        message: pathSafetyError
      }
    };
  }
  const outputPathError = ffmpegPresetOutputPathError(preset.preset, input.outputPath);
  if (outputPathError) {
    return {
      ok: false,
      command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
      error: {
        code: "invalid_output_path",
        message: outputPathError
      }
    };
  }
  // ---------------------------------------------------------------------------------------------
  // Encoder resolution has two independent layers:
  //   Layer 1 (software): the existing `encoderPolicy` disambiguation (libx265 vs libaom-av1 …),
  //     unchanged. mp4-h264 has no policy -> static libx264, no `-encoders` probe.
  //   Layer 2 (hardware upgrade): when the preset has hardware candidates, software is not forced,
  //     and the caller opted into probing (or injected a probe), select the FIRST probe-verified
  //     hardware candidate. Hardware is the default in the product render paths. On any hardware
  //     encode failure the encode automatically retries software and records the fallback honestly.
  // Frame pixels are identical regardless of encoder, so the frame-sequence input hash and the
  // decoded-quality gates below are unaffected by this choice.
  // ---------------------------------------------------------------------------------------------

  // Layer 1 — software encoder selection (unchanged behaviour).
  let encoderSelection: FfmpegPresetEncoderSelection = {
    ok: true,
    preset: preset.preset,
    family: null,
    encoder: null,
    mode: "static"
  };
  let capabilities: FfmpegEncoderCapabilities | undefined;
  if (preset.encoderPolicy) {
    capabilities = await probeFfmpegEncoderCapabilities({ runner });
    encoderSelection = selectFfmpegPresetEncoder(preset.preset, capabilities);
    if (!encoderSelection.ok) {
      return {
        ok: false,
        command: { executable: resolveFfmpegExecutable(), args: ["-hide_banner", "-encoders"], shell: false },
        error: encoderSelection.error
      };
    }
  }
  const softwareEncoder = encoderSelection.ok ? encoderSelection.encoder ?? undefined : undefined;

  // Frame quality gate + input hash run BEFORE any encoder probe or encode. This is deliberate:
  // there is no point spawning a GPU usability probe (or measuring loudness) for a frame sequence
  // that is about to be rejected. The gate is encoder-independent.
  const quality = await inspectFrameSequence({
    framePaths,
    durationMs: input.durationMs,
    // fps places each frame on the timeline so the motion measurement can report frozen ranges in
    // real seconds rather than frame indices.
    fps: input.fps,
    ...input.quality
  });
  if (!quality.ok) {
    return {
      ok: false,
      command: buildEncodeImageSequenceCommand({ ...input, ...(softwareEncoder ? { videoEncoder: softwareEncoder } : {}) }),
      error: {
        code: "frame_quality_failed",
        message: quality.message
      }
    };
  }
  const frameSequenceHash = await hashFrameSequence({
    framesDir: input.framesDir,
    framePattern: "%06d.png",
    framePaths,
    frameCount,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  });

  // Layer 2 — hardware upgrade decision, gated on the per-machine usability probe.
  const forceSoftwareEncode = input.forceSoftwareEncode ?? envForceSoftwareEncode();
  // The hardware system is "engaged" whenever the caller opts in (product paths do). This is what
  // makes encoder evidence appear in the receipt even for a forced-software or software-default run.
  const hardwareSystemEngaged = Boolean(preset.hardwareEncode)
    && (input.probeHardwareEncode === true || input.hardwareProbe !== undefined || input.hardwareProbeResolver !== undefined);
  let hardwareProbe: FfmpegHardwareEncoderUsability | undefined;
  let hardwareCandidate: FfmpegHardwareEncodeCandidate | undefined;
  // Provenance of the probe evidence for the receipt: an injected probe carries the caller's provenance;
  // a cache-aware resolver reports its own (fresh vs cached); a direct probe has none.
  let probeProvenance: "fresh-probe" | "cached" | undefined = input.encoderProbeProvenance;
  const probeWarnings: string[] = [];
  if (preset.hardwareEncode && !forceSoftwareEncode && hardwareSystemEngaged) {
    if (input.hardwareProbe !== undefined) {
      hardwareProbe = input.hardwareProbe;
    } else if (input.hardwareProbeResolver) {
      // Resolver runs here — AFTER the quality gate above — so a doomed sequence never triggers a probe.
      const resolved = await input.hardwareProbeResolver({
        family: preset.hardwareEncode.family,
        encoders: preset.hardwareEncode.candidates.map((candidate) => candidate.encoder),
        runner
      });
      hardwareProbe = resolved.probe;
      probeProvenance = resolved.provenance;
    } else {
      hardwareProbe = await probeFfmpegHardwareEncoderUsability({
        runner,
        ...(capabilities ? { capabilities } : {}),
        encoders: preset.hardwareEncode.candidates.map((candidate) => candidate.encoder)
      });
    }
    if (hardwareProbe.ok) {
      const usable = hardwareProbe;
      hardwareCandidate = preset.hardwareEncode.candidates.find((candidate) => usable.usableEncoders.includes(candidate.encoder));
    } else {
      // A failed probe (governor/discovery error) is non-fatal: treat as "no hardware" and record
      // why in the receipt so the software fallback is auditable rather than silent.
      probeWarnings.push(`Hardware encoder probe failed (${hardwareProbe.error.code}); using software encoder. ${hardwareProbe.error.message}`);
    }
  }

  // The software encoder identity used for the fallback attempt and (when appropriate) the receipt.
  const softwareFallbackEncoder = softwareEncoder
    ?? preset.hardwareEncode?.softwareFallback
    ?? staticPresetVideoEncoder(preset);

  // Two-pass EBU R128 loudness (quality path): measure every track that requests
  // normalization so the encode's loudnorm applies measured_* values; tracks that
  // cannot be measured fall back to single-pass loudnorm with a receipt note.
  const loudnessNormalizationRequested = Boolean(preset.audioCodec)
    && audioInputs.some((audio) => audio.normalizeLoudness === true);
  const loudness = loudnessNormalizationRequested
    ? await measureFinalLoudnessInputs(audioInputs, {
        measure: (path) => measureAudioLevels(path, { runner, inputRoots: effectiveEncodeInputRoots(input), admittedFinalAudio: true })
      })
    : { inputs: audioInputs, tracks: [] as RenderLoudnessTrack[] };
  const renderAudioInputs = loudness.inputs;

  // Build the ordered encode attempts. Hardware first (when selected), software as the automatic
  // fallback. Frame input / audio / output path are identical across attempts.
  const buildAttemptCommand = (opts: { videoEncoder?: string; hardwareOutputArgs?: string[] }): FfmpegCommand =>
    buildEncodeImageSequenceCommand({
      ...input,
      ...(audioMaster ? { audioMaster } : {}),
      // Feed the measured inputs back through the encode (audioTracks takes precedence over
      // audio/audioPath in resolveAudioInputs, so this is safe for every input shape).
      ...(renderAudioInputs.length > 0 ? { audioTracks: renderAudioInputs } : {}),
      ...(opts.videoEncoder ? { videoEncoder: opts.videoEncoder } : {}),
      ...(opts.hardwareOutputArgs ? { hardwareOutputArgs: opts.hardwareOutputArgs } : {})
    });

  const attempts: Array<{ source: "hardware" | "software"; encoder: string | undefined; command: FfmpegCommand }> = [];
  if (hardwareCandidate) {
    attempts.push({ source: "hardware", encoder: hardwareCandidate.encoder, command: buildAttemptCommand({ hardwareOutputArgs: hardwareCandidate.outputArgs }) });
  }
  attempts.push({ source: "software", encoder: softwareFallbackEncoder, command: buildAttemptCommand({ videoEncoder: softwareEncoder }) });

  // Run attempts in order, falling back hardware -> software on ffmpeg failure (never on a resource
  // governor kill, which is propagated unchanged). Quality gate + frame hash already ran once above.
  let ranAttempt: { source: "hardware" | "software"; encoder: string | undefined; command: FfmpegCommand } | undefined;
  let runResult: FfmpegProcessResult | undefined;
  let fallback: { attemptedEncoder: string; reason: string } | undefined;
  const encodeWarnings: string[] = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const result = await runner(attempt.command);
    if (result.exitCode === 0) {
      ranAttempt = attempt;
      runResult = result;
      break;
    }
    if (result.resourceErrorCode) {
      return {
        ok: false,
        command: attempt.command,
        error: {
          code: result.resourceErrorCode,
          message: summarizeStderr(result.stderr) || `${attempt.encoder ?? "encoder"} was stopped by the resource governor`
        }
      };
    }
    const failureMessage = summarizeStderr(result.stderr) || `ffmpeg exited with code ${result.exitCode}`;
    // Hardware attempt failed and a software fallback follows -> record the fallback and retry.
    if (attempt.source === "hardware" && index + 1 < attempts.length) {
      fallback = { attemptedEncoder: attempt.encoder ?? "hardware", reason: failureMessage };
      encodeWarnings.push(`Hardware encoder ${attempt.encoder} failed; retried with software ${attempts[index + 1].encoder ?? "encoder"}. ${failureMessage}`);
      continue;
    }
    // Software attempt failed (or a hardware attempt with no fallback): surface the error.
    return {
      ok: false,
      command: attempt.command,
      error: { code: "ffmpeg_failed", message: failureMessage }
    };
  }
  if (!ranAttempt || !runResult) {
    // Defensive: the loop always returns or sets a result; this keeps the types honest.
    return {
      ok: false,
      command: attempts[attempts.length - 1].command,
      error: { code: "ffmpeg_failed", message: "no encode attempt produced output" }
    };
  }
  const command = ranAttempt.command;
  const result = runResult;
  // Successful encodes are graded by what ffmpeg flagged, not by its routine chatter.
  const stderr = summarizeSuccessfulEncodeStderr(result.stderr);

  // Reason the final encoder ran, for the receipt.
  const encoderReason: RenderEncoderReason = ranAttempt.source === "hardware"
    ? "probe-selected-hardware"
    : forceSoftwareEncode
      ? "forced-software"
      : fallback
        ? "hardware-fallback"
        : "software-default";
  // Emit encoder evidence when there is a resolved software encoder (existing encoderPolicy presets)
  // or the caller engaged the hardware system. Presets without either (mp4-h264 with no opt-in) keep
  // their existing receipt shape with no encoder fields.
  const emitEncoderEvidence = Boolean(preset.encoderPolicy) || hardwareSystemEngaged;

  // Measure the delivered program whenever either per-track normalization or a
  // document master is configured. A master loudness target is verified here,
  // after the exact muxed file exists; source-track measurements cannot prove
  // the final program.
  const programLoudness = (loudnessNormalizationRequested || audioMaster?.loudness)
    ? await measureFinalProgramLoudness(input.outputPath, {
        measure: (path) => measureAudioLevels(path, { runner, inputRoots: [dirname(input.outputPath)] })
      })
    : undefined;
  const loudnessSummary = loudnessNormalizationRequested
    ? buildFinalLoudnessSummary(loudness.tracks, programLoudness ?? null)
    : undefined;
  const masterReadback = audioMaster?.loudness
    ? (programLoudness === undefined || programLoudness === null
      ? null
      : {
          integratedLufs: programLoudness.integratedLufs,
          truePeakDbtp: programLoudness.truePeakDbtp,
          loudnessRangeLu: programLoudness.lra
        })
    : undefined;
  const masterEvaluation = audioMaster
    ? evaluateMotionAudioMasterLoudness(audioMaster, masterReadback ?? null)
    : { ok: true as const };
  const masterEvidence: RenderAudioMasterEvidence | undefined = audioMaster
    ? {
      controls: structuredClone(audioMaster),
      ...(audioMaster.loudness ? { readback: masterReadback ?? null, loudnessRealization: masterLoudnessRealization(audioMaster) } : {}),
      ...(audioMaster.loudness
        ? masterEvaluation.ok
          ? { loudnessConformance: "passed" as const }
          : { loudnessConformance: "failed" as const, loudnessFailure: masterEvaluation.message }
        : {})
      }
    : undefined;
  if (!masterEvaluation.ok) {
    const failedOutputHash = await hashFile(input.outputPath);
    const failedReceipt = createRenderReceipt({
      id: `ffmpeg-render-${failedOutputHash.slice(0, 16)}`,
      packageId: input.packageId,
      lane: "ffmpeg",
      status: "failed",
      inputHashes: await collectFinalRenderInputHashes(frameSequenceHash, preset.audioCodec ? audioInputs : []),
      output: {
        path: input.outputPath,
        sha256: failedOutputHash,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        codec: preset.codec,
        container: preset.container,
        preset: preset.preset,
        ...(renderAudioInputs.length > 0 && preset.audioCodec
          ? { audio: finalReceiptAudioOutput(renderAudioInputs, preset.audioCodec, loudnessSummary, masterEvidence) }
          : {}),
        ...(result.resources ? { resources: result.resources } : {}),
        ...(input.resourcePreflight ? { resourcePreflight: input.resourcePreflight } : {}),
        tools: { ffmpeg: motionToolIdentityFor("ffmpeg", input.ffmpegVersion ?? undefined) }
      },
      warnings: [
        ...quality.warnings,
        ...compatibilityWarnings,
        ...probeWarnings,
        ...encodeWarnings,
        masterEvaluation.message,
        ...(stderr ? [stderr] : [])
      ]
    });
    failedReceipt.createdAt = input.now?.() ?? failedReceipt.createdAt;
    failedReceipt.artifacts = [
      { role: "rendered_media", path: input.outputPath, status: "failed", mediaType: preset.mimeType, primary: true }
    ];
    return {
      ok: false,
      command,
      error: { code: "audio_master_quality_failed", message: masterEvaluation.message },
      receipt: failedReceipt
    };
  }

  // Read the colour tags the delivered file actually carries, so the receipt reports observation
  // rather than only intent. See `gradeDeliveredColor`.
  const colorGrade = preset.color && input.verifyDeliveredColor !== false
    ? await gradeFinalDeliveredColor(input.outputPath, preset, {
        probe: (path) => probeMedia(path, { runner, inputRoots: [dirname(input.outputPath)] })
      })
    : null;

  const receipt = createRenderReceipt({
    id: `ffmpeg-render-${(await hashFile(input.outputPath)).slice(0, 16)}`,
    packageId: input.packageId,
    lane: "ffmpeg",
    status: "passed",
    inputHashes: await collectFinalRenderInputHashes(frameSequenceHash, preset.audioCodec ? audioInputs : []),
    output: {
      path: input.outputPath,
      sha256: await hashFile(input.outputPath),
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      codec: preset.codec,
      container: preset.container,
      preset: preset.preset,
      ...(emitEncoderEvidence && ranAttempt.encoder
        ? {
            encoder: ranAttempt.encoder,
            encoderSource: ranAttempt.source,
            encoderReason,
            ...(hardwareProbe && hardwareProbe.ok
              ? { encoderProbe: {
                  ...summarizeEncoderProbeEvidence(hardwareProbe, hardwareCandidate?.encoder ?? null),
                  ...(probeProvenance ? { provenance: probeProvenance } : {})
                } }
              : {}),
            ...(fallback ? { encoderFallback: fallback } : {})
          }
        : {}),
      // `color` stays exactly what it always was — the DECLARED profile — because ShellX Cut reads
      // it and the receipt shape is frozen. `color.observed` is purely additive: what ffprobe read
      // back off the delivered file. Absent when the readback could not be performed, so a caller
      // can tell "not measured" from "measured and missing".
      ...(preset.color
        ? { color: { ...preset.color, ...(colorGrade ? { observed: colorGrade.observed } : {}) } }
        : {}),
      ...(renderAudioInputs.length > 0 && preset.audioCodec
        ? { audio: finalReceiptAudioOutput(renderAudioInputs, preset.audioCodec, loudnessSummary, masterEvidence) }
        : {}),
      ...(result.resources ? { resources: result.resources } : {}),
      ...(input.resourcePreflight ? { resourcePreflight: input.resourcePreflight } : {}),
      // WHICH FFmpeg produced this file (the tool-identity invariant). A receipt that attests to an encode
      // has to name the encoder build, or it cannot be reproduced: two FFmpeg versions pick
      // different filters, muxers and defaults from the same command line. Redacted by
      // construction — the executable is reduced to a basename and the location is reported as
      // override/bundled/PATH, so a shared receipt never carries a machine-private path.
      tools: { ffmpeg: motionToolIdentityFor("ffmpeg", input.ffmpegVersion ?? undefined) }
    },
    warnings: [
      ...quality.warnings,
      ...compatibilityWarnings,
      ...probeWarnings,
      ...encodeWarnings,
      ...(colorGrade?.warning ? [colorGrade.warning] : []),
      ...(stderr ? [stderr] : [])
    ]
  });
  receipt.createdAt = input.now?.() ?? receipt.createdAt;
  receipt.artifacts = [
    { role: "rendered_media", path: input.outputPath, status: "available", mediaType: preset.mimeType, primary: true }
  ];

  return { ok: true, command, receipt };
}

/**
 * Build the bounded, redacted hardware-encode probe summary persisted in an ordinary render
 * receipt's `encoderProbe`. Beyond the usable/selected encoders it records `hardwareAvailable` and,
 * from the per-candidate probe evidence, which encoders were compiled and which failed to
 * initialize (with a short, path-stripped reason). This makes the render receipt self-describing for
 * trust — the promise documented in receipts-and-trust.md — instead of the failure detail living
 * only in the separate acceleration-smoke evidence. The candidate set is inherently small (a handful
 * of vendor encoders per codec), so the summary stays bounded.
 */
function summarizeEncoderProbeEvidence(
  probe: Extract<FfmpegHardwareEncoderUsability, { ok: true }>,
  selectedEncoder: string | null
): RenderEncoderProbeEvidence {
  return {
    hardwareAvailable: probe.usableEncoders.length > 0,
    usableHardwareEncoders: probe.usableEncoders,
    selectedHardwareEncoder: selectedEncoder,
    compiledHardwareEncoders: probe.probes.filter((entry) => entry.compiled).map((entry) => entry.encoder),
    failedHardwareEncoders: probe.probes
      .filter((entry) => entry.status === "initialization_failed")
      .map((entry) => ({ encoder: entry.encoder, reason: redactProbeReason(entry.message, entry.exitCode) }))
  };
}

/** Reduce an ffmpeg init-failure message to a short, host-path-free reason for receipts. */
function redactProbeReason(message: string | undefined, exitCode: number | undefined): string {
  const firstLine = (message ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  // Strip absolute filesystem paths (they leak host layout and are not diagnostically useful here).
  const withoutPaths = firstLine.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/g, "<path>").replace(/\s+/g, " ").trim();
  const bounded = withoutPaths.length > 160 ? `${withoutPaths.slice(0, 157)}...` : withoutPaths;
  if (bounded) return bounded;
  return exitCode !== undefined ? `initialization failed (exit ${exitCode})` : "initialization failed";
}

/** The static `-c:v` encoder baked into a preset's software output args (e.g. "libx264"). */
function staticPresetVideoEncoder(preset: FfmpegExportPresetSpec): string | undefined {
  const index = preset.outputArgs.indexOf("-c:v");
  return index >= 0 && index + 1 < preset.outputArgs.length ? preset.outputArgs[index + 1] : undefined;
}

export function buildEncodeImageSequenceCommand(input: {
  framesDir: string;
  fps: number;
  durationMs: number;
  outputPath: string;
  preset?: FfmpegExportPreset;
  audioPath?: string;
  audio?: FfmpegAudioInput;
  audioTracks?: FfmpegAudioInput[];
  /** Document-level, post-mix controls. It is ignored nowhere: an audio-less output refuses it. */
  audioMaster?: MotionAudioMasterBus;
  /** Software encoder to swap into the preset template (software `encoderPolicy` selection). */
  videoEncoder?: string;
  /**
   * Complete video output args for a probe-selected hardware encoder. When present these REPLACE
   * the software preset's video output args entirely (hardware rate control differs from CRF), so
   * `videoEncoder` is ignored. Everything else (frame input, audio, output path) is unchanged.
   */
  hardwareOutputArgs?: string[];
  inputRoots?: string[];
  outputRoots?: string[];
}): FfmpegCommand {
  const frameCount = frameCountFor(input.durationMs, input.fps);
  const preset = resolveExportPreset(input.preset);
  const audioInputs = resolveFinalAudioInputs(input);
  const audioEnabled = audioInputs.length > 0 && Boolean(preset.audioCodec);
  const audioMaster = normalizeRendererAudioMaster(input.audioMaster);
  if (audioMaster && !audioEnabled) {
    throw new Error("Document audio master requires a final-video preset and at least one resolved audio input.");
  }
  if (audioMaster) assertMotionAudioMasterDuration(audioMaster, input.durationMs);
  const audioArgs = audioEnabled && preset.audioCodec
    ? audioOutputArgs(audioInputs, preset.audioCodec, input.durationMs, audioMaster)
    : [];
  const inputRoots = effectiveEncodeInputRoots(input);
  assertSafeFfmpegInputPath(join(input.framesDir, "%06d.png"), inputRoots);
  for (const audio of audioInputs) {
    assertSafeFfmpegInputPath(audio.path, inputRoots);
  }
  assertSafeFfmpegOutputPath(input.outputPath, input.outputRoots);
  const outputPathError = ffmpegPresetOutputPathError(preset.preset, input.outputPath);
  if (outputPathError) throw new Error(outputPathError);
  return {
    executable: resolveFfmpegExecutable(),
    args: [
      "-y",
      "-framerate",
      String(input.fps),
      "-start_number",
      "1",
      ...localFileInputArgs(join(input.framesDir, "%06d.png")),
      ...(audioEnabled ? audioInputs.flatMap((audio) => audioInputArgs(audio)) : []),
      "-frames:v",
      String(frameCount),
      ...(input.hardwareOutputArgs ?? presetOutputArgs(preset, input.videoEncoder)),
      ...audioArgs,
      input.outputPath
    ],
    shell: false
  };
}

export function readFfmpegExportPreset(value: string): FfmpegExportPreset | null {
	switch (value) {
		case "mp4-h264":
		case "mp4-hevc":
		case "webm-av1":
		case "webm-vp9":
		case "webm-vp9-alpha":
		case "gif":
		case "mov-prores":
			return value;
    default:
      return null;
  }
}

export function isFfmpegExportPreset(value: string): boolean {
  return readFfmpegExportPreset(value) !== null;
}

export function readImageSequenceExportPreset(value: string): ImageSequenceExportPreset | null {
  return value === "png-sequence" ? "png-sequence" : null;
}

export function isImageSequenceExportPreset(value: string): boolean {
  return readImageSequenceExportPreset(value) !== null;
}

export function readStillFrameExportPreset(value: string): StillFrameExportPreset | null {
  switch (value) {
    case "png-frame":
    case "jpeg-frame":
      return value;
    default:
      return null;
  }
}

export function isStillFrameExportPreset(value: string): boolean {
  return readStillFrameExportPreset(value) !== null;
}

export function stillFrameOutputPathError(preset: StillFrameExportPreset, outputPath: string): string | null {
  const lowerPath = outputPath.toLowerCase();
  if (preset === "png-frame" && !lowerPath.endsWith(".png")) {
    return "png-frame outputs must use a .png path.";
  }
  if (preset === "jpeg-frame" && !lowerPath.endsWith(".jpg") && !lowerPath.endsWith(".jpeg")) {
    return "jpeg-frame outputs must use a .jpg or .jpeg path.";
  }
  return null;
}

export function ffmpegPresetOutputPathError(preset: FfmpegExportPreset, outputPath: string): string | null {
  const extension = resolveExportPreset(preset).extension;
  if (!outputPath.toLowerCase().endsWith(`.${extension}`)) {
    return `${preset} outputs must use a .${extension} path.`;
  }
  return null;
}

export function readMotionExportPreset(value: string): MotionExportPreset | null {
  return readFfmpegExportPreset(value) ?? readImageSequenceExportPreset(value) ?? readStillFrameExportPreset(value);
}

export function isMotionExportPreset(value: string): boolean {
  return readMotionExportPreset(value) !== null;
}

// Preset ordering is derived from the single-source list in @shellx-motion/core rather than a local
// literal, so this renderer's preset set and the integration-protocol advertisement cannot drift.
// The EXPORT_PRESETS / IMAGE_SEQUENCE_EXPORT_PRESETS / STILL_FRAME_EXPORT_PRESETS spec tables below
// are asserted to cover exactly these ids by the preset-source consistency test.
const EXPORT_PRESET_ORDER: FfmpegExportPreset[] = [...FFMPEG_EXPORT_PRESETS];
const MOTION_EXPORT_PRESET_ORDER: MotionExportPreset[] = [...MOTION_EXPORT_PRESETS];

const SDR_BT709_COLOR: FfmpegColorProfile = {
  profile: "sdr-bt709",
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  range: "tv",
  conversion: "rgb-full-to-yuv-limited"
};

// The colour chain, in the order it has to be applied.
//
// `scale=in_range=full:out_range=tv:out_color_matrix=bt709` does the actual CONVERSION: full-range
// renderer RGB -> limited-range BT.709 YUV. `setparams` then TAGS the converted frame, and the
// `-color*` output options tag the encoder/muxer. All three are kept because they act at different
// layers and different FFmpeg builds honour different ones.
//
// Why `setparams` is not redundant across supported FFmpeg builds:
//   Linux    ffmpeg 6.1.1                       -> HEVC and AV1 both carry space/transfer/primaries/range.
//   Windows  ffmpeg N-125773-g7002e01c19 (8.x)  -> HEVC and AV1 carry ONLY color_space and
//                                                  color_range. transfer and primaries are ABSENT.
// The surviving pair is exactly the pair the filter chain's colour-negotiation API carries on the
// frame (matrix + range, which `scale` sets); the missing pair is exactly the pair it does not.
// Newer FFmpeg takes the encoder's colour properties from the filtergraph OUTPUT FRAME, so on those
// builds an unset frame primaries/transfer wins over `-color_primaries` / `-color_trc` and the
// delivered file silently loses two of the four tags Motion's receipt declares.
//
// `setparams` sets all four ON THE FRAME, which is the input to both the negotiation and the
// encoder, so it is version-independent. It is metadata only: verified locally that adding it leaves
// decoded pixels bit-identical (PSNR inf against the same encode without it) while producing the
// same four tags on ffmpeg 6.1.1.
//
// NOT yet verified on the Windows 8.x build — this is the mechanism-level fix for the AV1 half of
// the defect and needs a rig re-run to confirm. The HEVC half additionally carries a rig-PROVEN
// encoder-level fix; see `-x265-params` on the `mp4-hevc` preset.
const SDR_BT709_OUTPUT_ARGS = [
  "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-color_range", "tv"
];

/*
 * There is deliberately NO encoder-level colour signalling here.
 *
 * An earlier implementation also passed
 * `-x265-params colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited`, on the belief that
 * container-level flags could not reach the HEVC SPS VUI on newer FFmpeg. With `setparams` in
 * the filter chain and NO x265 params, the delivered HEVC carries all four tags. The encoder-level
 * argument was redundant.
 *
 * Removing it is not just tidying. `-x265-params` is rejected by every other encoder, so it could
 * never be applied to the hardware HEVC candidates — which meant software and hardware HEVC were
 * signalling colour by two different mechanisms, and only one of them was exercised by the smokes.
 * `setparams` acts on the frame, so it applies identically to libx265, SVT-AV1, libvpx and every
 * hardware candidate, and the "same colour chain as the software preset" invariant is true for real
 * rather than true at the layer where it happened to be expressible.
 */

// Decode-side inverse of SDR_BT709_OUTPUT_ARGS. Every Motion preset encodes full-range renderer RGB
// into limited-range ("tv") BT.709 YUV (`conversion: "rgb-full-to-yuv-limited"`). When we later
// extract a delivered frame back to PNG for a quality comparison, the baseline it is measured
// against is a full-range renderer PNG, so the decoded YUV must be expanded back to full range in
// the SAME colour matrix. Forcing `in_range=tv:out_range=full` makes that expansion explicit and
// deterministic rather than depending on swscale's default range interpretation of the container
// tags. Kept beside the encode contract so the round-trip cannot silently drift.
const SDR_BT709_EXTRACTION_COLOR_FILTER = "scale=in_range=tv:out_range=full";

// ---------------------------------------------------------------------------------------------
// Hardware-encode candidates. Each candidate carries the complete output-argument set for its
// encoder. Every candidate
// keeps the SAME colour-managed `-vf scale=... + bt709 tagging` chain as its software preset, so:
//   * decoded-quality parity / PSNR gates apply unchanged (they run on decoded pixels, and the
//     colour path is identical — only the compressed bitstream differs from libx264/libx265),
//   * the software `-vf` scale runs on CPU, feeding CPU frames to the GPU encoder (no full-hwaccel
//     decode path is used, which keeps the deterministic PNG-frame input pipeline intact).
//
// Rate control is chosen deliberately per vendor (training knowledge cross-checked against current
// FFmpeg/NVENC guidance, 2026-07):
//   * NVENC: `-rc vbr -cq N -b:v 0` is true constant-quality VBR — the closest analogue to
//     libx264/libx265 CRF (OBS/StreamFX consensus). `-preset p6 -tune hq -multipass fullres` is
//     the NVIDIA "high quality / archival" recommendation (P5–P6 + HQ tuning + VBR + multipass),
//     not the low-latency streaming path. CQ targets are mapped slightly conservatively from each
//     preset's CRF so quality is not silently degraded; the quality gates + the receipt's size note
//     are the real guards.
//   * VideoToolbox / QSV / AMF: reasonable quality-based settings, but NOT rig-verified in this
//     change (only NVENC was verified on the RTX 5080 rig). They are probe-gated, so a wrong arg on
//     an absent GPU can never be selected, and any real-encode failure auto-falls-back to software.
// ---------------------------------------------------------------------------------------------

/** MP4 container tail shared by hardware MP4 candidates: SDR-BT.709 tagging + faststart. */
function mp4HardwareTail(): string[] {
  return [...SDR_BT709_OUTPUT_ARGS, "-movflags", "+faststart"];
}

/** WebM container tail shared by hardware WebM candidates: SDR-BT.709 tagging (WebM has no faststart). */
function webmHardwareTail(): string[] {
  return [...SDR_BT709_OUTPUT_ARGS];
}

/** Ordered H.264 hardware candidates for mp4-h264 (software fallback: libx264 crf 18). */
const H264_HARDWARE_CANDIDATES: FfmpegHardwareEncodeCandidate[] = [
  {
    encoder: "h264_nvenc",
    outputArgs: ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-multipass", "fullres", "-pix_fmt", "yuv420p", ...mp4HardwareTail()],
    rateControl: "NVENC VBR constant-quality cq=19 (~libx264 crf 18), preset p6, tune hq, fullres multipass"
  },
  {
    encoder: "h264_videotoolbox",
    outputArgs: ["-c:v", "h264_videotoolbox", "-q:v", "65", "-pix_fmt", "yuv420p", ...mp4HardwareTail()],
    rateControl: "VideoToolbox constant quality q:v=65 (Apple-Silicon CQ); not rig-verified"
  },
  {
    encoder: "h264_qsv",
    outputArgs: ["-c:v", "h264_qsv", "-global_quality", "23", "-preset", "veryslow", "-pix_fmt", "nv12", ...mp4HardwareTail()],
    rateControl: "QSV ICQ global_quality=23, preset veryslow; not rig-verified"
  },
  {
    encoder: "h264_amf",
    outputArgs: ["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "20", "-qp_p", "20", "-quality", "quality", "-pix_fmt", "yuv420p", ...mp4HardwareTail()],
    rateControl: "AMF CQP qp=20, quality preset; not rig-verified"
  }
];

/** Ordered HEVC hardware candidates for mp4-hevc (software fallback: libx265 crf 20, 10-bit). */
const HEVC_HARDWARE_CANDIDATES: FfmpegHardwareEncodeCandidate[] = [
  {
    encoder: "hevc_nvenc",
    // 10-bit (p010le/main10) preserves the software preset's yuv420p10le intent; input PNGs are
    // 8-bit so this is a lossless widening, not a quality change.
    outputArgs: ["-c:v", "hevc_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-multipass", "fullres", "-profile:v", "main10", "-pix_fmt", "p010le", "-tag:v", "hvc1", ...mp4HardwareTail()],
    rateControl: "NVENC VBR cq=21 (~libx265 crf 20), 10-bit main10, preset p6, tune hq, fullres multipass"
  },
  {
    encoder: "hevc_videotoolbox",
    outputArgs: ["-c:v", "hevc_videotoolbox", "-q:v", "65", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", ...mp4HardwareTail()],
    rateControl: "VideoToolbox constant quality q:v=65 (Apple-Silicon CQ), 8-bit; not rig-verified"
  },
  {
    encoder: "hevc_qsv",
    outputArgs: ["-c:v", "hevc_qsv", "-global_quality", "25", "-preset", "veryslow", "-tag:v", "hvc1", "-pix_fmt", "nv12", ...mp4HardwareTail()],
    rateControl: "QSV ICQ global_quality=25, preset veryslow, 8-bit; not rig-verified"
  },
  {
    encoder: "hevc_amf",
    outputArgs: ["-c:v", "hevc_amf", "-rc", "cqp", "-qp_i", "22", "-qp_p", "22", "-quality", "quality", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", ...mp4HardwareTail()],
    rateControl: "AMF CQP qp=22, quality preset, 8-bit; not rig-verified"
  }
];

/**
 * Ordered AV1 hardware candidates for webm-av1 (software fallback: libsvtav1 crf 30).
 *
 * VideoToolbox has no AV1 encoder, so it is absent here. av1_nvenc is muxed into WebM to match the
 * software preset's container: FFmpeg's WebM muxer accepts AV1 (libsvtav1 already muxes there in
 * this codebase), and the av1_nvenc bitstream is the same AV1 elementary stream — so no container
 * change is expected. This is VERIFIED on the RTX 5080 rig; if a given FFmpeg build's WebM muxer
 * rejected av1_nvenc, the automatic software fallback (libsvtav1) would catch it and record why.
 */
const AV1_HARDWARE_CANDIDATES: FfmpegHardwareEncodeCandidate[] = [
  {
    encoder: "av1_nvenc",
    // NVENC `-cq` is a 0–51 scale for every codec (unlike AV1 CRF's 0–63); cq=32 leans toward
    // quality relative to a naive rescale of libsvtav1 crf 30, with the quality gate as the guard.
    outputArgs: ["-c:v", "av1_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "32", "-b:v", "0", "-multipass", "fullres", "-pix_fmt", "yuv420p", ...webmHardwareTail()],
    rateControl: "NVENC AV1 VBR cq=32 (cq scale 0-51; ~libsvtav1 crf 30 equiv), preset p6, tune hq, fullres multipass"
  },
  {
    encoder: "av1_qsv",
    outputArgs: ["-c:v", "av1_qsv", "-global_quality", "28", "-preset", "veryslow", "-pix_fmt", "nv12", ...webmHardwareTail()],
    rateControl: "QSV AV1 ICQ global_quality=28, preset veryslow; not rig-verified"
  },
  {
    encoder: "av1_amf",
    outputArgs: ["-c:v", "av1_amf", "-rc", "cqp", "-qp_i", "26", "-qp_p", "26", "-quality", "quality", "-pix_fmt", "yuv420p", ...webmHardwareTail()],
    rateControl: "AMF AV1 CQP qp=26, quality preset; not rig-verified"
  }
];

const EXPORT_PRESETS: Record<FfmpegExportPreset, FfmpegExportPresetSpec> = {
  "mp4-h264": {
    preset: "mp4-h264",
    label: "MP4 H.264",
    codec: "h264",
    container: "mp4",
    extension: "mp4",
    mimeType: "video/mp4",
    outputArgs: ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", ...SDR_BT709_OUTPUT_ARGS, "-movflags", "+faststart"],
    audioCodec: "aac",
    supportsAudio: true,
    supportsAlpha: false,
    color: SDR_BT709_COLOR,
    // mp4-h264 keeps NO software encoderPolicy: libx264 is THE software H.264 encoder (no
    // disambiguation needed), so software selection stays static and probe-free unless hardware is
    // opted in. The hardware upgrade is additive and gated on the usability probe.
    hardwareEncode: { family: "h264", softwareFallback: "libx264", candidates: H264_HARDWARE_CANDIDATES }
  },
  "mp4-hevc": {
    preset: "mp4-hevc",
    label: "MP4 HEVC",
    codec: "hevc",
    container: "mp4",
    extension: "mp4",
    mimeType: "video/mp4",
    // `encoderPolicy.candidates` is exactly ["libx265"], so the `-c:v` swap in `presetOutputArgs`
    // can never put a non-x265 encoder in front of these `-x265-params`.
    outputArgs: ["-c:v", "libx265", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", ...SDR_BT709_OUTPUT_ARGS, "-movflags", "+faststart"],
    audioCodec: "aac",
    supportsAudio: true,
    supportsAlpha: false,
    color: SDR_BT709_COLOR,
    encoderPolicy: { family: "hevc", mode: "software-preferred", candidates: ["libx265"] },
    hardwareEncode: { family: "hevc", softwareFallback: "libx265", candidates: HEVC_HARDWARE_CANDIDATES }
  },
  "webm-av1": {
    preset: "webm-av1",
    label: "WebM AV1",
    codec: "av1",
    container: "webm",
    extension: "webm",
    mimeType: "video/webm",
    outputArgs: ["-c:v", "libsvtav1", "-crf", "30", "-preset", "6", "-pix_fmt", "yuv420p", ...SDR_BT709_OUTPUT_ARGS],
    audioCodec: "libopus",
    supportsAudio: true,
    supportsAlpha: false,
    color: SDR_BT709_COLOR,
    encoderPolicy: { family: "av1", mode: "software-preferred", candidates: ["libsvtav1", "libaom-av1"] },
    hardwareEncode: { family: "av1", softwareFallback: "libsvtav1", candidates: AV1_HARDWARE_CANDIDATES }
  },
  "webm-vp9": {
    preset: "webm-vp9",
    label: "WebM VP9",
    codec: "vp9",
    container: "webm",
    extension: "webm",
    mimeType: "video/webm",
    outputArgs: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-pix_fmt", "yuv420p", ...SDR_BT709_OUTPUT_ARGS],
    audioCodec: "libopus",
    supportsAudio: true,
    supportsAlpha: false,
    color: SDR_BT709_COLOR
  },
  "webm-vp9-alpha": {
    preset: "webm-vp9-alpha",
    label: "WebM VP9 Alpha",
    codec: "vp9",
    container: "webm",
    extension: "webm",
    mimeType: "video/webm",
    outputArgs: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", ...SDR_BT709_OUTPUT_ARGS],
    audioCodec: "libopus",
    supportsAudio: true,
    supportsAlpha: true,
    color: SDR_BT709_COLOR
  },
  gif: {
    preset: "gif",
    label: "Animated GIF",
    codec: "gif",
    container: "gif",
    extension: "gif",
    mimeType: "image/gif",
    // Two-pass palettegen -> paletteuse (single-command split form) instead of
    // FFmpeg's default 256-colour quantiser, which produces visibly banded GIFs.
    // Deliberate choices for animated motion output:
    //  * palettegen stats_mode=full (default): the per-file palette is computed
    //    from every pixel of every frame. `diff` biases the palette toward the
    //    moving region and starves large static gradient backgrounds (common in
    //    motion graphics) of colours, causing visible banding -- so `full` wins.
    //  * paletteuse dither=bayer:bayer_scale=3: ordered dither is deterministic
    //    per pixel position, so it does not "crawl" frame-to-frame the way the
    //    default error-diffusion sierra2_4a does on animation, and it compresses
    //    far better (a shifting noise pattern defeats GIF inter-frame delta).
    //    bayer_scale=3 balances visible crosshatch against banding.
    //  * paletteuse diff_mode=rectangle: re-dithers only the changed bounding
    //    rectangle between frames -> less moving noise and smaller files.
    outputArgs: [
      "-filter_complex",
      "[0:v]split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
      "-loop",
      "0"
    ],
    audioCodec: null,
    supportsAudio: false,
    supportsAlpha: false,
    color: null
  },
  "mov-prores": {
    preset: "mov-prores",
    label: "MOV ProRes 4444",
    codec: "prores",
    container: "mov",
    extension: "mov",
    mimeType: "video/quicktime",
    outputArgs: ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", ...SDR_BT709_OUTPUT_ARGS],
    audioCodec: "pcm_s16le",
    supportsAudio: true,
    supportsAlpha: true,
    color: SDR_BT709_COLOR,
    // MOV signals colour through the `colr` atom's nclc triplet — primaries, transfer and matrix
    // only. There is no range field, so a ProRes deliverable never reports `color_range` however it
    // is encoded (measured on ffmpeg 6.1.1: primaries/transfer/matrix present, range key absent).
    // Declared here so the colour readback does not raise a permanent, unfixable warning on every
    // ProRes render — the exact warning-fatigue failure the routine-stderr classifier exists to stop.
    colorTagsNotSignaled: ["range"]
  }
};

const IMAGE_SEQUENCE_EXPORT_PRESETS: Record<ImageSequenceExportPreset, ImageSequenceExportPresetSpec> = {
  "png-sequence": {
    preset: "png-sequence",
    label: "PNG Sequence",
    codec: "png",
    container: "image-sequence",
    extension: "png",
    mimeType: "image/png",
    outputArgs: [],
    audioCodec: null,
    supportsAudio: false,
    supportsAlpha: true,
    outputKind: "image_sequence"
  }
};

const STILL_FRAME_EXPORT_PRESETS: Record<StillFrameExportPreset, StillFrameExportPresetSpec> = {
  "png-frame": {
    preset: "png-frame",
    label: "PNG Frame",
    codec: "png",
    container: "image",
    extension: "png",
    mimeType: "image/png",
    outputArgs: [],
    audioCodec: null,
    supportsAudio: false,
    supportsAlpha: true,
    outputKind: "still_frame"
  },
  "jpeg-frame": {
    preset: "jpeg-frame",
    label: "JPEG Frame",
    codec: "jpeg",
    container: "image",
    extension: "jpg",
    mimeType: "image/jpeg",
    outputArgs: [],
    audioCodec: null,
    supportsAudio: false,
    supportsAlpha: false,
    outputKind: "still_frame"
  }
};

export function listFfmpegExportPresets(): FfmpegExportPresetSpec[] {
  return EXPORT_PRESET_ORDER.map((preset) => cloneExportPreset(EXPORT_PRESETS[preset]));
}

export function listMotionExportPresets(): MotionExportPresetSpec[] {
  return MOTION_EXPORT_PRESET_ORDER.map(resolveMotionExportPreset);
}

export function resolveExportPreset(preset: FfmpegExportPreset | undefined): FfmpegExportPresetSpec {
  return cloneExportPreset(EXPORT_PRESETS[preset ?? "mp4-h264"]);
}

export function resolveMotionExportPreset(preset: MotionExportPreset | undefined): MotionExportPresetSpec {
  const value = preset ?? "mp4-h264";
  const imageSequencePreset = readImageSequenceExportPreset(value);
  if (imageSequencePreset) return cloneImageSequenceExportPreset(IMAGE_SEQUENCE_EXPORT_PRESETS[imageSequencePreset]);
  const stillFramePreset = readStillFrameExportPreset(value);
  if (stillFramePreset) return cloneStillFrameExportPreset(STILL_FRAME_EXPORT_PRESETS[stillFramePreset]);
  return resolveExportPreset(readFfmpegExportPreset(value) ?? "mp4-h264");
}

function cloneExportPreset(preset: FfmpegExportPresetSpec): FfmpegExportPresetSpec {
  return {
    ...preset,
    outputArgs: [...preset.outputArgs],
    color: preset.color ? { ...preset.color } : null,
    ...(preset.encoderPolicy
      ? { encoderPolicy: { ...preset.encoderPolicy, candidates: [...preset.encoderPolicy.candidates] } }
      : {}),
    ...(preset.hardwareEncode
      ? {
          hardwareEncode: {
            ...preset.hardwareEncode,
            candidates: preset.hardwareEncode.candidates.map((candidate) => ({
              ...candidate,
              outputArgs: [...candidate.outputArgs]
            }))
          }
        }
      : {})
  };
}

function presetOutputArgs(preset: FfmpegExportPresetSpec, selectedEncoder?: string): string[] {
  if (!preset.encoderPolicy) return [...preset.outputArgs];
  const encoder = selectedEncoder ?? preset.encoderPolicy.candidates[0];
  if (!preset.encoderPolicy.candidates.includes(encoder)) {
    throw new Error(`Unsupported ${preset.preset} software encoder selection: ${encoder}.`);
  }
  if (preset.preset === "webm-av1" && encoder === "libaom-av1") {
    return ["-c:v", encoder, "-b:v", "0", "-crf", "30", "-cpu-used", "6", "-pix_fmt", "yuv420p", ...SDR_BT709_OUTPUT_ARGS];
  }
  const outputArgs = [...preset.outputArgs];
  const codecIndex = outputArgs.indexOf("-c:v");
  if (codecIndex < 0 || codecIndex + 1 >= outputArgs.length) {
    throw new Error(`Export preset ${preset.preset} has no video encoder argument.`);
  }
  outputArgs[codecIndex + 1] = encoder;
  return outputArgs;
}

function cloneImageSequenceExportPreset(preset: ImageSequenceExportPresetSpec): ImageSequenceExportPresetSpec {
  return {
    ...preset,
    outputArgs: []
  };
}

function cloneStillFrameExportPreset(preset: StillFrameExportPresetSpec): StillFrameExportPresetSpec {
  return {
    ...preset,
    outputArgs: []
  };
}

export function audioWarningsForExportPreset(preset: FfmpegExportPreset | undefined, audioInputCount: number): string[] {
  const spec = resolveExportPreset(preset);
  if (audioInputCount <= 0 || spec.audioCodec) return [];
  const noun = audioInputCount === 1 ? "track" : "tracks";
  return [`Export preset ${spec.preset} does not support audio; ${audioInputCount} requested audio ${noun} will be ignored.`];
}

export async function createImageSequenceReceipt(input: CreateImageSequenceReceiptInput): Promise<OperationReceipt> {
  const framePattern = input.framePattern ?? "%06d.png";
  const framePaths = input.framePaths ?? Array.from({ length: input.frameCount }, (_, index) =>
    join(input.framesDir, framePattern.replace("%06d", String(index + 1).padStart(6, "0")))
  );
  const sequenceHash = await hashFrameSequence({
    framesDir: input.framesDir,
    framePattern,
    frameCount: input.frameCount,
    framePaths,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  });
  const output = {
    path: input.framesDir,
    sha256: sequenceHash,
    framePattern,
    frameCount: input.frameCount,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    fps: input.fps,
    codec: "png",
    container: "image-sequence",
    preset: "png-sequence",
    ...(input.resourcePreflight ? { resourcePreflight: input.resourcePreflight } : {})
  };
  const receipt = createRenderReceipt({
    id: `png-sequence-render-${sequenceHash.slice(0, 16)}`,
    packageId: input.packageId,
    lane: "image-sequence",
    status: "passed",
    inputHashes: {
      frames: sequenceHash
    },
    output,
    warnings: input.warnings ?? []
  });
  receipt.createdAt = input.now?.() ?? receipt.createdAt;
  receipt.artifacts = [
    { role: "frame_sequence", path: input.framesDir, status: "available", mediaType: "image/png", primary: true }
  ];
  return receipt;
}

export async function createStillFrameReceipt(input: CreateStillFrameReceiptInput): Promise<OperationReceipt> {
  const preset = resolveMotionExportPreset(input.preset);
  if (!isStillFrameExportPreset(preset.preset)) {
    throw new Error(`Unsupported still-frame export preset: ${input.preset}`);
  }
  const frameBuffer = await readFile(input.outputPath);
  assertStillFrameBytes(input.preset, frameBuffer);
  const frameHash = hashBuffer(frameBuffer);
  const output = {
    path: input.outputPath,
    sha256: frameHash,
    width: input.width,
    height: input.height,
    durationMs: 0,
    atMs: input.atMs,
    codec: preset.codec,
    container: preset.container,
    preset: input.preset
  };
  const receipt = createRenderReceipt({
    id: `still-frame-render-${frameHash.slice(0, 16)}`,
    packageId: input.packageId,
    lane: "image",
    status: "passed",
    inputHashes: {
      frame: frameHash
    },
    output,
    warnings: input.warnings ?? []
  });
  receipt.createdAt = input.now?.() ?? receipt.createdAt;
  receipt.artifacts = [
    { role: "still_frame", path: input.outputPath, status: "available", mediaType: preset.mimeType, primary: true }
  ];
  return receipt;
}

function assertStillFrameBytes(preset: StillFrameExportPreset, buffer: Buffer): void {
  if (preset === "png-frame" && isPngBuffer(buffer)) return;
  if (preset === "jpeg-frame" && isJpegBuffer(buffer)) return;
  throw new Error(`Still-frame output ${preset} does not match ${preset} image bytes.`);
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpegBuffer(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function audioInputArgs(audio: FfmpegAudioInput): string[] {
  return [
    ...(audio.loop && audio.trimDurationMs === undefined ? ["-stream_loop", "-1"] : []),
    ...selfContainedFfmpegMediaInputArgs(audio.path)
  ];
}

/** Renderer entry points are public JavaScript boundaries, not TypeScript-only trust boundaries. */
function normalizeRendererAudioMaster(value: unknown): MotionAudioMasterBus | undefined {
  return normalizeMotionAudioMaster(value) ?? undefined;
}

function audioFilterArgs(audio: FfmpegAudioInput | undefined, master: MotionAudioMasterBus | undefined, durationMs: number): string[] {
  if (!audio) return [];
  const filter = [audioFilterChain(audio), masterAudioFilterChain(master, durationMs), `apad=whole_dur=${formatSeconds(durationMs / 1000)}`].filter(Boolean).join(",");
  return filter ? ["-filter:a", filter] : [];
}

function audioOutputArgs(audioInputs: FfmpegAudioInput[], audioCodec: string, durationMs: number, master?: MotionAudioMasterBus): string[] {
  if (audioInputs.length === 1) {
    return [
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:a",
      audioCodec,
      ...audioFilterArgs(audioInputs[0], master, durationMs),
      "-t",
      formatSeconds(durationMs / 1000)
    ];
  }

  return [
    "-filter_complex",
    buildAudioMixFilter(audioInputs, master, durationMs),
    "-map",
    "0:v:0",
    "-map",
    "[mixeda]",
    "-c:a",
    audioCodec,
    "-t",
    formatSeconds(durationMs / 1000)
  ];
}

// Default sidechaincompress parameters for level-dependent ("sidechain") ducking.
// Tuned for the voice-over-under-music case: engage on moderate speech (low
// threshold), duck firmly (ratio 8), react quickly, and recover musically.
// attack/release are taken from the ducking attackMs/releaseMs when supplied.
const SIDECHAIN_DEFAULT_THRESHOLD = 0.05; // linear amplitude, in (0, 1]
const SIDECHAIN_DEFAULT_RATIO = 8;
const SIDECHAIN_DEFAULT_ATTACK_MS = 20;
const SIDECHAIN_DEFAULT_RELEASE_MS = 250;
// FFmpeg sidechaincompress accepted ranges (guarded so a bad value never
// reaches the encoder): threshold 0.000976563..1, ratio 1..20, attack/release
// 0.01..(2000|9000) ms.
const SIDECHAIN_MIN_THRESHOLD = 0.000976563;
const SIDECHAIN_MIN_RATIO = 1;
const SIDECHAIN_MAX_RATIO = 20;
const SIDECHAIN_MIN_TIME_MS = 0.01;
const SIDECHAIN_MAX_ATTACK_MS = 2000;
const SIDECHAIN_MAX_RELEASE_MS = 9000;

interface SidechainTarget {
  /** 1-based FFmpeg input index of the music track being ducked. */
  index: number;
  ducking: MotionAudioDucking;
  /** 1-based FFmpeg input indices of the resolved trigger tracks. */
  triggerIndices: number[];
}

interface SidechainResolution {
  targets: SidechainTarget[];
  /** trigger input index -> the target indices that key off it. */
  triggerKeyConsumers: Map<number, number[]>;
  /** Final filtergraph pad label for a given 1-based input index. */
  finalLabelFor(index: number): string;
}

/**
 * Resolve which audio inputs participate in level-dependent ("sidechain")
 * ducking. A music input opts in via `ducking.mode === "sidechain"`, and its
 * `triggerLayerIds` are matched against the `layerId` carried on the other
 * audio inputs. Inputs that are themselves sidechain targets are not eligible
 * as triggers, which prevents one track's base label from being consumed by
 * both a compressor main input and an asplit key tap.
 */
function resolveSidechainDucking(audioInputs: FfmpegAudioInput[]): SidechainResolution {
  const layerIdToIndex = new Map<string, number>();
  audioInputs.forEach((audio, index) => {
    if (typeof audio.layerId === "string" && audio.layerId.length > 0 && !layerIdToIndex.has(audio.layerId)) {
      layerIdToIndex.set(audio.layerId, index + 1);
    }
  });

  const targetIndices = new Set<number>();
  audioInputs.forEach((audio, index) => {
    if (audio.ducking?.mode === "sidechain") targetIndices.add(index + 1);
  });

  const targets: SidechainTarget[] = [];
  const triggerKeyConsumers = new Map<number, number[]>();
  audioInputs.forEach((audio, index) => {
    const musicIndex = index + 1;
    if (audio.ducking?.mode !== "sidechain") return;
    const triggerIndices: number[] = [];
    for (const layerId of audio.ducking.triggerLayerIds) {
      const triggerIndex = layerIdToIndex.get(layerId);
      if (triggerIndex === undefined || triggerIndex === musicIndex) continue;
      if (targetIndices.has(triggerIndex)) continue; // do not key off another ducked track
      if (!triggerIndices.includes(triggerIndex)) triggerIndices.push(triggerIndex);
    }
    // No resolvable trigger present in this render -> the music simply plays at
    // its normal level (there is nothing to duck against).
    if (triggerIndices.length === 0) return;
    targets.push({ index: musicIndex, ducking: audio.ducking, triggerIndices });
    for (const triggerIndex of triggerIndices) {
      const consumers = triggerKeyConsumers.get(triggerIndex) ?? [];
      consumers.push(musicIndex);
      triggerKeyConsumers.set(triggerIndex, consumers);
    }
  });

  const duckedIndices = new Set(targets.map((target) => target.index));
  return {
    targets,
    triggerKeyConsumers,
    finalLabelFor(index: number): string {
      if (duckedIndices.has(index)) return `a${index}_ducked`;
      if (triggerKeyConsumers.has(index)) return `a${index}_main`;
      return `a${index}`;
    }
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Build a `sidechaincompress` invocation from a resolved sidechain ducking control. */
function sidechainCompressFilter(ducking: MotionAudioDucking): string {
  const threshold = clampNumber(
    typeof ducking.threshold === "number" && Number.isFinite(ducking.threshold) ? ducking.threshold : SIDECHAIN_DEFAULT_THRESHOLD,
    SIDECHAIN_MIN_THRESHOLD,
    1
  );
  const ratio = clampNumber(
    typeof ducking.ratio === "number" && Number.isFinite(ducking.ratio) ? ducking.ratio : SIDECHAIN_DEFAULT_RATIO,
    SIDECHAIN_MIN_RATIO,
    SIDECHAIN_MAX_RATIO
  );
  const attack = clampNumber(
    typeof ducking.attackMs === "number" && Number.isFinite(ducking.attackMs) ? ducking.attackMs : SIDECHAIN_DEFAULT_ATTACK_MS,
    SIDECHAIN_MIN_TIME_MS,
    SIDECHAIN_MAX_ATTACK_MS
  );
  const release = clampNumber(
    typeof ducking.releaseMs === "number" && Number.isFinite(ducking.releaseMs) ? ducking.releaseMs : SIDECHAIN_DEFAULT_RELEASE_MS,
    SIDECHAIN_MIN_TIME_MS,
    SIDECHAIN_MAX_RELEASE_MS
  );
  return `sidechaincompress=threshold=${formatNumber(threshold)}:ratio=${formatNumber(ratio)}:attack=${formatNumber(attack)}:release=${formatNumber(release)}`;
}

/**
 * Compose the multi-track audio filter_complex. Each input first runs its own
 * per-input chain into a base label [a{n}]. When any input requests
 * level-dependent ("sidechain") ducking, the trigger tracks are split so they
 * still reach the mix while a copy keys a `sidechaincompress` on the music; the
 * default "timed" ducking mode never reaches here (it is pre-lowered into
 * volume keyframes by the connector). Everything then feeds a single amix.
 */
function buildAudioMixFilter(audioInputs: FfmpegAudioInput[], master: MotionAudioMasterBus | undefined, durationMs: number): string {
  const segments: string[] = audioInputs.map((audio, index) => {
    const inputIndex = index + 1;
    return `[${inputIndex}:a]${audioFilterChain(audio, { labelPrefix: `mix${inputIndex}_pan` }) || "anull"}[a${inputIndex}]`;
  });

  const sidechain = resolveSidechainDucking(audioInputs);

  // Split every trigger's base signal into a main tap (still heard) plus one key
  // tap per target that keys off it.
  for (const [triggerIndex, consumers] of sidechain.triggerKeyConsumers) {
    const keyLabels = consumers.map((targetIndex) => `a${triggerIndex}_key_${targetIndex}`);
    segments.push(
      `[a${triggerIndex}]asplit=${keyLabels.length + 1}[a${triggerIndex}_main]${keyLabels.map((label) => `[${label}]`).join("")}`
    );
  }

  // Compress each ducked music track against its (possibly combined) trigger key.
  for (const target of sidechain.targets) {
    const keyLabels = target.triggerIndices.map((triggerIndex) => `a${triggerIndex}_key_${target.index}`);
    let keyLabel = keyLabels[0];
    if (keyLabels.length > 1) {
      keyLabel = `a${target.index}_keymix`;
      segments.push(
        `${keyLabels.map((label) => `[${label}]`).join("")}amix=inputs=${keyLabels.length}:duration=longest:dropout_transition=0[${keyLabel}]`
      );
    }
    segments.push(`[a${target.index}][${keyLabel}]${sidechainCompressFilter(target.ducking)}[a${target.index}_ducked]`);
  }

  const finalLabels = audioInputs.map((_, index) => `[${sidechain.finalLabelFor(index + 1)}]`).join("");
  const masterFilter = masterAudioFilterChain(master, durationMs);
  const padFilter = `apad=whole_dur=${formatSeconds(durationMs / 1000)}`;
  segments.push(`${finalLabels}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0${masterFilter ? "[mixedraw]" : `,${padFilter}[mixeda]`}`);
  if (masterFilter) segments.push(`[mixedraw]${masterFilter},${padFilter}[mixeda]`);
  return segments.join(";");
}

function audioFilterChain(audio: FfmpegAudioInput, options: { labelPrefix?: string } = {}): string {
  const filters: string[] = [];
  const trimParts = [
    ...(audio.trimStartMs !== undefined && audio.trimStartMs > 0 ? [`start=${formatSeconds(audio.trimStartMs / 1000)}`] : []),
    ...(audio.trimDurationMs !== undefined ? [`duration=${formatSeconds(audio.trimDurationMs / 1000)}`] : [])
  ];
  if (trimParts.length > 0) {
    filters.push(`atrim=${trimParts.join(":")}`);
    filters.push("asetpts=PTS-STARTPTS");
  }
  if (audio.loop && audio.trimDurationMs !== undefined) {
    filters.push("aresample=48000");
    filters.push(`aloop=loop=-1:size=${audioLoopSampleSize(audio.trimDurationMs)}`);
  }
  const playbackRate = readUsablePlaybackRate(audio.playbackRate);
  if (playbackRate !== null && playbackRate !== 1) {
    filters.push(...audioTempoFilters(playbackRate));
  }
  if (audio.durationMs !== undefined && Number.isFinite(audio.durationMs) && audio.durationMs > 0) {
    filters.push(`atrim=duration=${formatSeconds(audio.durationMs / 1000)}`);
  }
  if (audio.normalizeLoudness) {
    filters.push(loudnormFilter(audio.loudnormMeasured));
  }
  if (audio.volume !== undefined) {
    filters.push(`volume=${formatNumber(audio.volume)}`);
  }
  const panAutomation = audioPanAutomationFilter(audio.panKeyframes, options.labelPrefix ?? "pan");
  if (panAutomation) {
    filters.push(panAutomation);
  } else if (!audio.panKeyframes || audio.panKeyframes.length === 0) {
    const pan = audioPanFilter(audio.pan);
    if (pan) {
      filters.push(pan);
    }
  }
  const volumeAutomation = audioVolumeAutomationFilter(audio.volumeKeyframes);
  if (volumeAutomation) {
    filters.push(volumeAutomation);
  }
  if (audio.fadeInMs !== undefined && audio.fadeInMs > 0) {
    filters.push(audioFadeFilter("in", 0, audio.fadeInMs, audio.fadeCurve));
  }
  const fadeOut = audioFadeOutFilter(audio);
  if (fadeOut) {
    filters.push(fadeOut);
  }
  if (audio.muted) {
    filters.push("volume=0");
  }
  const delay = audioDelayFilter(audio);
  if (delay) {
    filters.push(delay);
  }
  return filters.join(",");
}

/**
 * Build the loudnorm filter. With a first-pass measurement present this is the
 * *apply* pass of the standard two-pass EBU R128 flow (`measured_*` + linear
 * gain); without one it is the historical single-pass loudnorm (used as the
 * fallback when measurement was unavailable). The single-pass form is emitted
 * byte-for-byte as before to keep it stable.
 */
function loudnormFilter(measured: LoudnormMeasurement | undefined): string {
  const target = `loudnorm=I=${LOUDNORM_TARGET_I}:TP=${LOUDNORM_TARGET_TP}:LRA=${LOUDNORM_TARGET_LRA}`;
  if (!measured) return target;
  return `${target}:measured_I=${formatNumber(measured.integratedLufs)}`
    + `:measured_TP=${formatNumber(measured.truePeakDbtp)}`
    + `:measured_LRA=${formatNumber(measured.lra)}`
    + `:measured_thresh=${formatNumber(measured.thresholdLufs)}`
    + `:offset=${formatNumber(measured.offsetLu)}`
    + `:linear=true:print_format=summary`;
}

function audioDelayFilter(audio: FfmpegAudioInput): string | null {
  const startMs = typeof audio.startMs === "number" && Number.isFinite(audio.startMs)
    ? Math.max(0, Math.round(audio.startMs))
    : 0;
  return startMs > 0 ? `adelay=${startMs}:all=1` : null;
}

function audioTempoFilters(playbackRate: number): string[] {
  const filters: string[] = [];
  let remaining = playbackRate;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${formatNumber(remaining)}`);
  return filters;
}

function readUsablePlaybackRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function audioFadeOutFilter(audio: FfmpegAudioInput): string | null {
  if (audio.fadeOutMs === undefined || audio.fadeOutMs <= 0) return null;
  const durationMs = audio.durationMs ?? audio.trimDurationMs;
  if (durationMs === undefined || durationMs <= 0) return null;
  const fadeDurationMs = Math.min(audio.fadeOutMs, durationMs);
  const startMs = Math.max(0, durationMs - fadeDurationMs);
  return audioFadeFilter("out", startMs, fadeDurationMs, audio.fadeCurve);
}

/** Apply the document-owned post-mix controls once, after all source audio is resolved. */
function masterAudioFilterChain(master: MotionAudioMasterBus | undefined, durationMs: number): string {
  if (!master) return "";
  const filters: string[] = [];
  if (master.volume !== undefined && master.volume !== 1) filters.push(`volume=${formatNumber(master.volume)}`);
  if (master.fadeInMs !== undefined && master.fadeInMs > 0) {
    filters.push(audioFadeFilter("in", 0, master.fadeInMs, master.fadeCurve));
  }
  if (master.fadeOutMs !== undefined && master.fadeOutMs > 0) {
    const length = master.fadeOutMs;
    filters.push(audioFadeFilter("out", Math.max(0, durationMs - length), length, master.fadeCurve));
  }
  if (master.loudness) {
    const lra = master.loudness.maxLoudnessRangeLu ?? LOUDNORM_TARGET_LRA;
    filters.push(`loudnorm=I=${formatNumber(master.loudness.integratedLufs)}:TP=${formatNumber(master.loudness.maxTruePeakDbtp)}:LRA=${formatNumber(lra)}:print_format=summary`);
  }
  return filters.join(",");
}

function masterLoudnessRealization(master: MotionAudioMasterBus): {
  mode: "single-pass-loudnorm";
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
} {
  const target = master.loudness;
  if (!target) throw new Error("Audio master has no loudness target to realize.");
  return {
    mode: "single-pass-loudnorm",
    integratedLufs: target.integratedLufs,
    truePeakDbtp: target.maxTruePeakDbtp,
    loudnessRangeLu: target.maxLoudnessRangeLu ?? LOUDNORM_TARGET_LRA,
  };
}

function audioFadeFilter(
  direction: "in" | "out",
  startMs: number,
  durationMs: number,
  curve: MotionAudioFadeCurve | undefined
): string {
  return `afade=t=${direction}:st=${formatSeconds(startMs / 1000)}:d=${formatSeconds(durationMs / 1000)}`
    + (curve === "equal-power" ? ":curve=qsin" : "");
}

function audioPanFilter(pan: number | undefined): string | null {
  if (pan === undefined || pan === 0) return null;
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) return null;
  if (pan < 0) {
    return `pan=stereo|c0=1*c0|c1=${formatNumber(1 + pan)}*c1`;
  }
  return `pan=stereo|c0=${formatNumber(1 - pan)}*c0|c1=1*c1`;
}

function audioPanAutomationFilter(keyframes: MotionKeyframe[] | undefined, labelPrefix: string): string | null {
  if (!keyframes || keyframes.length === 0) return null;
  const numericKeyframes = readNumericKeyframes(keyframes);
  if (!numericKeyframes || numericKeyframes.some((keyframe) => keyframe.value < -1 || keyframe.value > 1)) return null;
  const sorted = [...numericKeyframes].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 1) return audioPanFilter(sorted[0].value);
  const leftKeyframes = sorted.map((keyframe) => ({
    ...keyframe,
    value: panGains(keyframe.value).left
  }));
  const rightKeyframes = sorted.map((keyframe) => ({
    ...keyframe,
    value: panGains(keyframe.value).right
  }));
  const label = sanitizeFilterLabel(labelPrefix);
  return [
    `aformat=channel_layouts=stereo,channelsplit=channel_layout=stereo[${label}_l][${label}_r]`,
    `[${label}_l]volume='${volumeAutomationExpression(leftKeyframes)}':eval=frame[${label}_lv]`,
    `[${label}_r]volume='${volumeAutomationExpression(rightKeyframes)}':eval=frame[${label}_rv]`,
    `[${label}_lv][${label}_rv]join=inputs=2:channel_layout=stereo`
  ].join(";");
}

function panGains(pan: number): { left: number; right: number } {
  return pan < 0
    ? { left: 1, right: 1 + pan }
    : { left: 1 - pan, right: 1 };
}

function sanitizeFilterLabel(value: string): string {
  const label = value.replace(/[^A-Za-z0-9_]/g, "_");
  return label.length > 0 ? label : "pan";
}

function audioVolumeAutomationFilter(keyframes: MotionKeyframe[] | undefined): string | null {
  if (!keyframes || keyframes.length === 0) return null;
  const numericKeyframes = readNumericKeyframes(keyframes);
  if (!numericKeyframes) return null;
  const sorted = [...numericKeyframes].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 1) {
    return `volume=${formatNumber(sorted[0].value)}`;
  }
  return `volume='${volumeAutomationExpression(sorted)}':eval=frame`;
}

function volumeAutomationExpression(sorted: NumericMotionKeyframe[]): string {
  const first = sorted[0];
  let expression = formatNumber(sorted[sorted.length - 1].value);
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    expression = `if(lt(t,${formatSeconds(next.atMs / 1000)}),${volumeSegmentExpression(current, next)},${expression})`;
  }
  return `if(lt(t,${formatSeconds(first.atMs / 1000)}),${formatNumber(first.value)},${expression})`;
}

function volumeSegmentExpression(current: NumericMotionKeyframe, next: NumericMotionKeyframe): string {
  const start = formatSeconds(current.atMs / 1000);
  const end = formatSeconds(next.atMs / 1000);
  if (start === end || current.easing === "hold") {
    return formatNumber(current.value);
  }
  const progress = `((t-${start})/(${end}-${start}))`;
  return `${formatNumber(current.value)}+(${formatNumber(next.value)}-${formatNumber(current.value)})*${volumeEasingExpression(current.easing, progress)}`;
}

function volumeEasingExpression(easing: MotionKeyframe["easing"], progress: string): string {
  if (easing === "ease-in") return `${progress}*${progress}`;
  if (easing === "ease-out") return `1-(1-${progress})*(1-${progress})`;
  if (easing === "ease-in-out") {
    return `if(lt(${progress},0.5),2*${progress}*${progress},1-pow(-2*${progress}+2,2)/2)`;
  }
  // Spring easings (object form or preset alias) have no closed-form ffmpeg
  // expression; sample the core resolver into a piecewise-linear expression so
  // spring math stays defined solely in core and is not duplicated here.
  if (isSpringEasing(easing) || (typeof easing === "string" && springPresetEasing(easing) !== null)) {
    return sampledEasingExpression(resolveEasing(easing), progress, AUDIO_SPRING_SAMPLE_SEGMENTS);
  }
  if (typeof easing === "string" && parseCubicBezierEasing(easing)) {
    return sampledEasingExpression(resolveEasing(easing), progress, AUDIO_CUBIC_BEZIER_SAMPLE_SEGMENTS);
  }
  return progress;
}

function sampledEasingExpression(ease: (progress: number) => number, progress: string, segments: number): string {
  let expression = formatNumber(ease(1));
  for (let index = segments - 1; index >= 0; index -= 1) {
    const start = index / segments;
    const end = (index + 1) / segments;
    const formattedStart = formatNumber(start);
    const formattedEnd = formatNumber(end);
    const startValue = formatNumber(ease(start));
    const endValue = formatNumber(ease(end));
    const segmentProgress = `((${progress}-${formattedStart})/(${formattedEnd}-${formattedStart}))`;
    const segmentExpression = `${startValue}+(${endValue}-${startValue})*${segmentProgress}`;
    expression = `if(lt(${progress},${formattedEnd}),${segmentExpression},${expression})`;
  }
  return expression;
}

function audioLoopSampleSize(durationMs: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * 48000));
}

export async function probeMedia(path: string, options: { runner?: FfmpegRunner; inputRoots?: string[]; admittedQualityInput?: boolean } = {}): Promise<ProbeMediaResult> {
  const runner = options.runner ?? spawnRunner;
  if (options.admittedQualityInput) await assertQualityFfmpegMediaInput(path, options.inputRoots ?? []);
  else assertSafeFfmpegInputPath(path, options.inputRoots);
  const command: FfmpegCommand = {
    executable: resolveFfprobeExecutable(),
    args: ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...(options.admittedQualityInput ? qualityFfmpegMediaInputArgs(path) : localFileInputArgs(path))],
    shell: false
  };
  const result = await runner(command);
  if (result.exitCode !== 0) {
    throw new Error(summarizeStderr(result.stderr || result.stdout || "ffprobe failed"));
  }

  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      color_space?: string;
      color_transfer?: string;
      color_primaries?: string;
      color_range?: string;
      tags?: Record<string, string | number>;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_frames?: string | number;
      channels?: number;
      channel_layout?: string;
      sample_rate?: string | number;
      sample_fmt?: string;
      bit_rate?: string | number;
      duration?: string | number;
    }>;
    format?: { duration?: string; format_name?: string };
  };
  const streams = parsed.streams ?? [];
  const stream = streams.find((candidate) => candidate.codec_type === "video")
    ?? streams.find((candidate) => typeof candidate.width === "number" || typeof candidate.height === "number")
    ?? streams[0]
    ?? {};
  const audioStreams = streams
    .filter((candidate) => candidate.codec_type === "audio" || typeof candidate.channels === "number" || candidate.sample_rate !== undefined)
    .map((candidate) => ({
      codec: candidate.codec_name ?? "unknown",
      channels: typeof candidate.channels === "number" ? candidate.channels : null,
      channelLayout: typeof candidate.channel_layout === "string" ? candidate.channel_layout : null,
      sampleRate: parseOptionalNumber(candidate.sample_rate),
      sampleFormat: typeof candidate.sample_fmt === "string" ? candidate.sample_fmt : null,
      bitRate: parseOptionalNumber(candidate.bit_rate),
      durationMs: parseOptionalDurationMs(candidate.duration ?? parsed.format?.duration)
    }));
  const durationMs = parseOptionalDurationMs(stream.duration ?? parsed.format?.duration) ?? 0;
  return {
    ok: true,
    path,
    codec: stream.codec_name ?? "unknown",
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    durationMs,
    fps: deliveredFps(stream, durationMs),
    container: parsed.format?.format_name ?? "unknown",
    color: {
      pixelFormat: stream.pix_fmt ?? null,
      space: stream.color_space ?? null,
      transfer: stream.color_transfer ?? null,
      primaries: stream.color_primaries ?? null,
      range: stream.color_range ?? null
    },
    alpha: alphaMediaFacts(stream),
    audio: {
      present: audioStreams.length > 0,
      streamCount: audioStreams.length,
      streams: audioStreams
    }
  };
}

export function frameExtractionInputArgs(
  media: Pick<ProbeMediaResult, "codec" | "alpha">,
  path: string,
  options: { admittedQualityInput?: boolean } = {}
): string[] {
  const inputArgs = options.admittedQualityInput ? qualityFfmpegMediaInputArgs(path) : ["-i", path];
  return media.codec === "vp9" && media.alpha.present && media.alpha.decoder === "libvpx-vp9"
    ? ["-c:v", "libvpx-vp9", ...inputArgs]
    : inputArgs;
}

export function frameExtractionPngOutputArgs(media: Pick<ProbeMediaResult, "alpha">, path: string): string[] {
  return media.alpha.present
    ? ["-frames:v", "1", "-pix_fmt", "rgba", path]
    : ["-frames:v", "1", path];
}

/**
 * Build a complete ffmpeg argument list that extracts ONE delivered frame to a full-range PNG, in
 * the same colour domain as the pre-encode renderer baseline it will be compared against.
 *
 * Two correctness properties over the raw `frameExtractionInputArgs`/`frameExtractionPngOutputArgs`
 * pair:
 *   1. Colour-domain normalization — always applies {@link SDR_BT709_EXTRACTION_COLOR_FILTER} so the
 *      decoded limited-range YUV is expanded to full-range RGB (the domain of renderer PNGs).
 *   2. Frame-accurate selection — when `frameIndex` is supplied, selects exactly the Nth delivered
 *      frame (display order, 0-based) via `select=eq(n,N)` instead of a wall-clock `-ss` seek.
 *      Input `-ss` seeking lands on a neighbouring frame (it snaps to the next frame at/after the
 *      seek target), which at low delivery frame rates can be a different composition instant than
 *      the baseline. Selecting by the encoder's own frame index makes the delivered frame and the
 *      indexed pre-encode baseline the SAME rendered frame, so the comparison measures encode
 *      fidelity rather than cross-frame animation delta.
 *
 * @param media       Probed media facts (codec/alpha drive decoder + pixel-format choices).
 * @param inputPath   Path to the delivered media container.
 * @param outputPath  Destination PNG path (single frame).
 * @param options.frameIndex 0-based delivered-frame index to select; omit for a first-frame extract.
 */
export function frameExtractionArgs(
  media: Pick<ProbeMediaResult, "codec" | "alpha">,
  inputPath: string,
  outputPath: string,
  options: { frameIndex?: number; admittedQualityInput?: boolean } = {}
): string[] {
  const filters: string[] = [];
  if (options.frameIndex !== undefined && Number.isFinite(options.frameIndex) && options.frameIndex >= 0) {
    filters.push(`select=eq(n\\,${Math.trunc(options.frameIndex)})`);
  }
  filters.push(SDR_BT709_EXTRACTION_COLOR_FILTER);
  const pixelFormatArgs = media.alpha.present ? ["-pix_fmt", "rgba"] : [];
  // `-fps_mode passthrough` keeps the single selected frame from being duplicated/dropped by the
  // output frame-rate logic when a select filter is present.
  const frameGate = filters.length > 1 ? ["-fps_mode", "passthrough"] : [];
  return [
    ...frameExtractionInputArgs(media, inputPath, options),
    "-vf",
    filters.join(","),
    ...frameGate,
    "-frames:v",
    "1",
    ...pixelFormatArgs,
    outputPath
  ];
}

export async function measureAudioLevels(path: string, options: { runner?: FfmpegRunner; inputRoots?: string[]; admittedFinalAudio?: boolean; admittedQualityInput?: boolean } = {}): Promise<AudioLevelResult> {
  const runner = options.runner ?? spawnRunner;
  if (options.admittedFinalAudio) await assertSelfContainedFfmpegMediaInputs([path], options.inputRoots ?? []);
  else if (options.admittedQualityInput) await assertQualityFfmpegMediaInput(path, options.inputRoots ?? []);
  else assertSafeFfmpegInputPath(path, options.inputRoots);
  const command: FfmpegCommand = {
    executable: resolveFfmpegExecutable(),
    args: [
      "-hide_banner",
      "-nostats",
      ...(options.admittedFinalAudio
        ? selfContainedFfmpegMediaInputArgs(path)
        : options.admittedQualityInput ? qualityFfmpegMediaInputArgs(path) : localFileInputArgs(path)),
      "-vn",
      "-sn",
      "-dn",
      "-af",
      "volumedetect,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f",
      "null",
      "-"
    ],
    shell: false
  };
  const result = await runner(command);
  if (result.exitCode !== 0) {
    throw new Error(summarizeStderr(result.stderr || result.stdout || "ffmpeg volumedetect failed"));
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const meanVolumeDb = parseLastDb(output, /mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/g);
  const maxVolumeDb = parseLastDb(output, /max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/g);
  const loudness = parseLoudnormSummary(output);
  return {
    ok: true,
    path,
    sampleCount: parseLastInteger(output, /n_samples:\s*(\d+)/g),
    meanVolumeDb,
    maxVolumeDb,
    meanVolumeDbfs: meanVolumeDb,
    samplePeakDbfs: maxVolumeDb,
    integratedLoudnessLufs: loudness.integrated,
    loudnessRangeLu: loudness.range,
    truePeakDbtp: loudness.truePeak,
    loudnessThresholdLufs: loudness.threshold,
    targetOffsetLu: loudness.targetOffset,
    loudnessMeasurement: "ebu-r128-loudnorm",
    loudnessComplete: loudness.integrated !== null
      && loudness.range !== null
      && loudness.truePeak !== null
      && loudness.threshold !== null
  };
}

/** A bounded decoded-RMS envelope for data-only procedural relationships.
 *
 * This deliberately runs a fixed FFmpeg filter graph rather than accepting a
 * caller supplied filter, script, or importer.  The returned samples are
 * source-local; the authoring layer is responsible for mapping them into the
 * document timeline and for refusing retimed sources it cannot prove.
 */
export async function sampleAudioEnvelope(
  path: string,
  options: { sampleEveryMs: number; durationMs: number; runner: FfmpegRunner; inputRoots?: string[] }
): Promise<{ samples: Array<{ atMs: number; value: number }>; input: Pick<FfmpegMediaInputSnapshot, "sha256" | "byteLength">; resources?: LocalMotionJobEvidence }> {
  const { sampleEveryMs, durationMs } = options;
  if (!Number.isFinite(sampleEveryMs) || sampleEveryMs < 16 || sampleEveryMs > 1_000) {
    throw new Error("Audio envelope sampleEveryMs must be a finite number from 16 to 1000.");
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Audio envelope durationMs must be a positive finite number.");
  }
  // This is also a decode-time budget: `-t` below is derived only from this
  // validated duration, and no call can ask FFmpeg to scan an unbounded source.
  const sampleCount = Math.ceil(durationMs / sampleEveryMs);
  if (sampleCount > 4_096) {
    throw new Error("Audio envelope would exceed 4096 samples; increase sampleEveryMs or use a shorter source layer.");
  }
  const snapshot = await snapshotSelfContainedFfmpegMediaInput(path, options.inputRoots ?? [], "final-audio");
  try {
    const samplesPerWindow = Math.max(1, Math.round(sampleEveryMs * 48));
    const command: FfmpegCommand = {
      executable: resolveFfmpegExecutable(),
      args: [
        "-hide_banner",
        "-nostats",
        ...selfContainedFfmpegMediaInputArgs(snapshot.path),
        "-t",
        formatSeconds(durationMs / 1000),
        "-vn",
        "-sn",
        "-dn",
        "-af",
        `aresample=48000,asetnsamples=n=${samplesPerWindow}:p=1,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level`,
        "-f",
        "null",
        "-"
      ],
      shell: false
    };
    const result = await options.runner(command);
    if (result.exitCode !== 0) {
      throw new Error(summarizeStderr(result.stderr || result.stdout || "ffmpeg audio envelope sampling failed"));
    }
    const values = parseAudioEnvelopeRms(`${result.stdout}\n${result.stderr}`);
    if (values.length === 0) throw new Error("FFmpeg did not emit usable RMS envelope samples.");
    return {
      samples: values.slice(0, sampleCount).map((value, index) => ({
        atMs: Math.min(durationMs, index * sampleEveryMs),
        value
      })),
      input: { sha256: snapshot.sha256, byteLength: snapshot.byteLength },
      ...(result.resources ? { resources: result.resources } : {})
    };
  } finally {
    await snapshot.release();
  }
}

function parseAudioEnvelopeRms(output: string): number[] {
  const values: number[] = [];
  for (const match of output.matchAll(/lavfi\.astats\.Overall\.RMS_level\s*=\s*(-?(?:\d+(?:\.\d+)?|inf))/gi)) {
    const token = match[1].toLowerCase();
    const value = token === "-inf" ? 0 : Number(token);
    if (!Number.isFinite(value)) continue;
    // RMS dBFS to an amplitude scalar. The core graph accepts only finite
    // bounded numbers; clamp floating-point overrun instead of leaking it.
    values.push(Math.min(1, Math.max(0, Math.pow(10, value / 20))));
  }
  return values;
}

function parseLoudnormSummary(output: string): {
  integrated: number | null;
  range: number | null;
  truePeak: number | null;
  threshold: number | null;
  targetOffset: number | null;
} {
  let summary: Record<string, unknown> | null = null;
  for (const match of output.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gs)) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) summary = parsed as Record<string, unknown>;
    } catch {
      // FFmpeg logs can contain unrelated brace-delimited diagnostics.
    }
  }
  return {
    integrated: parseLoudnessNumber(summary?.input_i),
    range: parseLoudnessNumber(summary?.input_lra),
    truePeak: parseLoudnessNumber(summary?.input_tp),
    threshold: parseLoudnessNumber(summary?.input_thresh),
    targetOffset: parseLoudnessNumber(summary?.target_offset)
  };
}

function parseLoudnessNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "-inf") return Number.NEGATIVE_INFINITY;
  if (normalized === "inf" || normalized === "+inf") return Number.POSITIVE_INFINITY;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseLastInteger(output: string, pattern: RegExp): number | null {
  let parsed: number | null = null;
  for (const match of output.matchAll(pattern)) {
    parsed = Number(match[1]);
  }
  return parsed;
}

function parseLastDb(output: string, pattern: RegExp): number | null {
  let parsed: number | null = null;
  for (const match of output.matchAll(pattern)) {
    const raw = match[1];
    parsed = raw === "-inf" ? Number.NEGATIVE_INFINITY : Number(raw);
  }
  return parsed;
}

export {
  chromiumInstallOptions,
  ffmpegInstallOptions,
  ffmpegLooksAbsent,
  // Exported alongside it because the two are one decision: a loader failure is `broken`, and it
  // has to be ruled out before the ENOENT-shaped `missing` test can be trusted.
  ffmpegLooksLikeBrokenLoad,
  ffmpegMissingMessage,
  ffmpegRequirement,
  ffmpegSuggestedAction,
  motionToolDownloadUrl,
  motionToolInstallOptions,
  MOTION_TOOL_OVERRIDE_ENV_VAR,
  type MotionToolInstallOption,
  type MotionToolRequirement
} from "./tool-requirements.js";

export {
  MOTION_PLATFORM_REQUIREMENTS_SCHEMA,
  MOTION_REQUIREMENT_OPERATIONS,
  MOTION_TOOL_VERSION_MAX_CHARS,
  motionOperationReadiness,
  motionPlatformRequirements,
  motionRequirementsReport,
  motionToolIdentity,
  motionToolReport,
  type MotionOperationAlternative,
  type MotionOperationReadiness,
  type MotionPlatformRequirements,
  type MotionRequirementOperation,
  type MotionToolIdentity,
  type MotionToolName,
  type MotionToolProbeResult,
  type MotionToolReport,
  type MotionToolSource,
  type MotionToolStatus
} from "./platform-requirements.js";

/**
 * Where a tool executable came from, alongside the path itself.
 *
 * One resolver so "which ffmpeg is this" and "how did we find it" can never disagree — the string
 * resolvers below are thin wrappers over it. `source` is what reaches a receipt: an absolute path
 * names a user's home directory and install layout, and is not shareable
 * evidence, while "override / bundled / PATH" is exactly the fact needed to reproduce a render.
 *
 * Chromium is delegated to `@shellx-motion/core`, which is also where the browser renderer's
 * launcher gets its answer. That is the whole point: a readiness probe resolving the browser
 * separately from the code that launches it is how a green pre-flight and a failing render coexist.
 *
 * @param tool Which program to locate.
 * @returns The executable Motion will spawn and how it was found. `problem` is set only when an
 *   explicit override is set to something unusable, in which case there is NOTHING to spawn: the
 *   answer is already final and negative, and a caller must report it rather than resolving on to
 *   a different binary.
 */
export function resolveMotionToolLocation(tool: MotionToolName): {
  executable: string;
  source: MotionToolSource;
  problem?: string;
  autoDiscoveredCache?: true;
} {
  if (tool === "chromium") return resolveMotionBrowserExecutable();
  const override = readExecutableEnv(tool === "ffmpeg" ? "SHELLX_MOTION_FFMPEG" : "SHELLX_MOTION_FFPROBE");
  if (override) {
    if (process.platform !== "win32" || isAbsolute(override)) return { executable: override, source: "override" };
    return {
      executable: missingWindowsToolCandidate(tool),
      source: "override",
      problem: `${tool} override must be an absolute Windows executable path.`
    };
  }
  const bundled = discoverShellxFamilyFfmpegTool(tool === "ffmpeg" ? "ffmpeg.exe" : "ffprobe.exe");
  if (bundled) return { executable: bundled, source: "shellx-family" };
  if (process.platform === "win32") {
    const resolved = resolveWindowsPathTool(tool);
    return resolved
      ? { executable: resolved, source: "path" }
      : { executable: missingWindowsToolCandidate(tool), source: "path", problem: `No trusted ${tool}.exe was found on the absolute Windows PATH entries.` };
  }
  return { executable: tool, source: "path" };
}

/**
 * The argument that makes each tool print its version and exit.
 *
 * Chromium's spelling is its own. `-version` is not a switch Chrome documents, and a browser handed
 * an argument it does not recognise LAUNCHES instead of printing a banner — which in a doctor run
 * would be a stray browser window and a probe that never returns.
 */
const TOOL_VERSION_ARGS: Record<MotionToolName, string[]> = {
  ffmpeg: ["-version"],
  ffprobe: ["-version"],
  chromium: ["--version"]
};

/**
 * Redacted identity of a resolved tool, for a receipt.
 *
 * @param tool Which program to identify.
 * @param version The version line the caller already probed, when it has one. Never probed here:
 *   a render must not spawn an extra process to describe itself, and a receipt that omits the
 *   version is honest while one that invents it is not.
 */
export function motionToolIdentityFor(tool: MotionToolName, version?: string): MotionToolIdentity {
  const { executable, source } = resolveMotionToolLocation(tool);
  return motionToolIdentity({ tool, source, resolvedFrom: executable, ...(version ? { version } : {}) });
}

export function resolveFfmpegExecutable(): string {
  return resolveMotionToolLocation("ffmpeg").executable;
}

export function resolveFfprobeExecutable(): string {
  return resolveMotionToolLocation("ffprobe").executable;
}

/**
 * Probe one external tool for {@link checkMotionPlatformRequirements}.
 *
 * Separates `missing` from `broken` using the same ENOENT-shaped test the FFmpeg error path already
 * uses, because the two need opposite advice: one user must install the program, the other must
 * repair or unblock an install they already have.
 *
 * Chromium goes through the SAME spawn rather than settling for "does the file exist". Two reasons:
 * a Chromium present on disk but unable to start — the usual shape on a minimal Linux container, a
 * binary whose shared libraries are absent — would otherwise be reported ready and discovered by
 * the render, which is the very failure this probe exists to prevent; and routing it through the
 * runner keeps that seam the single place a host or a test defines what this machine has.
 *
 * An unusable explicit override short-circuits the spawn entirely: `resolveMotionToolLocation`
 * already decided, and running SOMETHING ELSE to fill in a status would report on a binary the
 * operator did not ask about — the silent substitution this pin exists to prevent.
 *
 * @param tool Which program to probe.
 * @param runner Test/host seam; production spawns the resolved binary with its version flag under
 *   the short identity-probe timeout, OUTSIDE the render governor. See
 *   {@link createToolIdentityProbeRunner} for why it is not the encode runner.
 */
export async function probeMotionTool(tool: MotionToolName, runner?: FfmpegRunner): Promise<MotionToolProbeResult> {
  const location = resolveMotionToolLocation(tool);
  const { executable, source, problem } = location;
  const base = { tool, source, resolvedFrom: executable } as const;
  // No `detail`: it exists to carry the RAW error a spawn produced, and no spawn happened. Copying
  // the problem sentence into it would only republish the same text with its path redacted out.
  if (problem) return { ...base, status: "broken", problem };
  if (tool === "chromium") {
    const verificationProblem = motionBrowserExecutableVerificationProblem(location);
    // A cache can change after resolution and before the process boundary revalidation. Preserve
    // both facts in the shared doctor/requirements result: the exact selected candidate failed its
    // second trust check, and any cache component the fresh scan refused. Without the notes this
    // early return silently contradicts the documented diagnostic path and sends an operator back
    // to the cache Motion is deliberately declining to execute from.
    if (verificationProblem) {
      return {
        ...base,
        status: "broken",
        problem: verificationProblem,
        ...browserCacheRefusalNotes(tool)
      };
    }
  }
  const probe = runner ?? createToolIdentityProbeRunner(tool);
  const failure = (raw: string): MotionToolProbeResult => ({
    ...base,
    status: ffmpegLooksAbsent(raw) ? "missing" : "broken",
    detail: raw,
    ...browserCacheRefusalNotes(tool)
  });
  if (!runner && tool === "chromium" && process.platform === "win32") {
    const browser = await probeMotionBrowserVersion(executable, { timeoutMs: resolveToolIdentityProbeTimeoutMs() });
    if (browser.ok) return { ...base, status: "ready", version: `Chromium ${browser.version}` };
    if (browser.reason === "timed_out") {
      return failure(`chromium identity probe timed out after ${resolveToolIdentityProbeTimeoutMs()}ms.`);
    }
    if (browser.reason === "cleanup_failed") {
      return failure("chromium identity probe could not close its headless browser process.");
    }
    return failure("chromium headless identity probe failed to return a version.");
  }
  try {
    const result = await probe({ executable, args: TOOL_VERSION_ARGS[tool], shell: false });
    if (result.exitCode === 0) return { ...base, status: "ready", version: firstLine(result.stdout) };
    if (!runner && result.exitCode === FFMPEG_TIMEOUT_EXIT_CODE) {
      return failure(`${tool} identity probe timed out after ${resolveToolIdentityProbeTimeoutMs()}ms.`);
    }
    return failure(summarizeStderr(result.stderr || result.stdout || `${tool} is not available`));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Say which browser caches the trust rule declined, when a Chromium probe has already failed.
 *
 * A silent refusal is a support incident: the CI user HAS a browser, Motion simply will not execute
 * one out of a directory other people can write, and without this line nothing on the machine says
 * so — the install command in the same report would put another copy in the same rejected cache.
 * Only consulted on failure, so a healthy machine pays nothing.
 *
 * The refusal's redaction-safe `label` is used rather than its path: these sentences end up in
 * `problem`, which is printed verbatim by `doctor` and returned to `read_motion` callers.
 */
function browserCacheRefusalNotes(tool: MotionToolName): { notes?: string[] } {
  if (tool !== "chromium") return {};
  const refused = untrustedMotionBrowserCaches();
  if (refused.length === 0) return {};
  return {
    notes: refused.map((entry) => `Motion did not use ${entry.label} because ${entry.reason}.`)
  };
}

/**
 * THE readiness answer. Every Motion surface — CLI `doctor`, the `motion.platform.requirements`
 * debug/MCP command, the SDK platform client, the workbench render dialog — calls this and returns
 * its result unchanged, so a fresh agent asking "can this machine render?" gets one truth
 * (the readiness-parity invariant).
 *
 * The runner is the ONLY seam. A host that wants to fake a probe injects one here rather than
 * supplying a differently-shaped pre-built answer — a per-host probe with its own shape is exactly
 * what let the CLI and MCP report different things before the readiness-parity invariant.
 *
 * Chromium is probed by default alongside the codec tools. It has to be: `render` rasterizes in a
 * browser unless told otherwise, so a readiness answer that omits it is a readiness answer about a
 * command nobody ran. A caller that narrows `tools` gets `unverified` for whatever it left out —
 * which is why the default is every tool rather than a per-caller list each surface maintains.
 *
 * @param options.runner Seam applied to every tool probe. Omitted, each tool is probed by its own
 *   ungoverned, short-timeout identity runner ({@link createToolIdentityProbeRunner}) rather than
 *   the encode runner — a read-only pre-flight must neither hang for the encode timeout nor take a
 *   slot from the renders it is gating.
 * @param options.tools Which tools to probe. Defaults to all of them.
 */
export async function checkMotionPlatformRequirements(options: {
  runner?: FfmpegRunner;
  tools?: ReadonlyArray<MotionToolName>;
} = {}): Promise<MotionPlatformRequirements> {
  const wanted = options.tools ?? (["ffmpeg", "ffprobe", "chromium"] as const);
  const reports: MotionToolReport[] = [];
  for (const tool of wanted) {
    reports.push(motionToolReport(await probeMotionTool(tool, options.runner)));
  }
  return motionPlatformRequirements(reports);
}

async function spawnRunner(command: FfmpegCommand): Promise<FfmpegProcessResult> {
  return createGovernedFfmpegRunner()(command);
}

/**
 * The runner behind a tool IDENTITY probe — `ffmpeg -version`, `chrome --version`.
 *
 * Deliberately NOT the governed encode runner, for two measured reasons.
 *
 * TIMEOUT. The governed runner applies `DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS`, ten minutes, which is
 * the right budget for an encode and absurd for a program printing one line. A browser that blocks
 * instead of answering — a GUI shim, an EDR prompt, a snap wrapper waiting on a confirmation — made
 * `shellx-motion doctor` look frozen for ten minutes. Seconds is the honest budget: a `--version`
 * that has not answered in {@link DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS} is a broken install, which
 * is exactly what the report then says.
 *
 * GOVERNOR. `LocalMotionJobGovernor.acquireSlot` is global and operation-blind — it does not read
 * the operation label at all — so a probe that went through it took one of the machine's two job
 * slots. Two concurrent `read_motion` pre-flights therefore held BOTH slots, and renders queued
 * behind them failed with `job_queue_timeout`. A read-only pre-flight must not be able to starve
 * the work it is a pre-flight for. Nothing is lost by leaving: the governor's other services are
 * scratch budgeting, RSS capping and job visibility, and a version banner needs no scratch, cannot
 * grow, and is not a job a host tracks.
 *
 * Process containment is kept: still `shell: false`, still its own process group (or taskkill /T on
 * Windows), so a hung probe's whole tree is killed rather than leaked.
 *
 * @param tool Named only so the timeout message says which program stopped answering.
 */
export function createToolIdentityProbeRunner(tool: MotionToolName): FfmpegRunner {
  return (command) => runSpawnedFfmpegChild(
    command,
    // No caller-side cancellation: the timeout below is the only stop condition, and the identity
    // probe has no host-visible job to cancel.
    new AbortController().signal,
    () => {},
    identityProbeTerminationMode,
    { timeoutMs: resolveToolIdentityProbeTimeoutMs(), label: `${tool} identity probe` }
  );
}

/** Kill-the-tree mode for an ungoverned probe: the same one `runFfmpegChild` picks per platform. */
function identityProbeTerminationMode(): FfmpegProcessTerminationMode {
  if (process.platform === "win32") return "windows-taskkill-fallback";
  return process.platform === "linux" || process.platform === "darwin" ? "unix-process-group" : "direct-child";
}

/**
 * How long a tool may take to print its version before Motion calls the install broken.
 *
 * `SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS` overrides it, and is deliberately NOT
 * `SHELLX_MOTION_FFMPEG_TIMEOUT_MS`: a host that raises the encode budget for a long render must
 * not thereby re-lengthen the pre-flight that render is waiting on.
 */
function resolveToolIdentityProbeTimeoutMs(): number {
  const raw = process.env.SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS;
}

/** Host/test seam that retains the exact shell-free command while injecting one resource policy. */
export function createGovernedFfmpegRunner(options: GovernedFfmpegRunnerOptions = {}): FfmpegRunner {
  return (command) => runGovernedFfmpegCommand(command, options);
}

async function runGovernedFfmpegCommand(command: FfmpegCommand, options: GovernedFfmpegRunnerOptions): Promise<FfmpegProcessResult> {
  try {
    const governor = options.governor ?? defaultLocalMotionJobGovernor;
    const execution = await governor.run({
      lane: options.lane ?? "ffmpeg",
      operation: options.operation ?? ffmpegJobOperation(command.args),
      scratchRoot: options.scratchRoot ?? (process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || resolve(".scratch")),
      signal: options.signal,
      ...(options.callerId ? { callerId: options.callerId } : {}),
      ...(options.jobId ? { jobId: options.jobId } : {}),
    }, async ({ signal, watchProcess, scratchRoot, reportProcessContainment }) => runFfmpegChild(command, {
      signal,
      watchProcess,
      scratchRoot,
      reportProcessContainment,
      maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes,
    }));
    return { ...execution.value, resources: execution.evidence };
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      return {
        exitCode: FFMPEG_RESOURCE_LIMIT_EXIT_CODE,
        stdout: "",
        stderr: error.message,
        resourceErrorCode: error.code,
        ...(error.evidence ? { resources: error.evidence } : {}),
      };
    }
    throw error;
  }
}

interface RunFfmpegChildOptions {
  signal: AbortSignal;
  watchProcess: (pid: number) => void;
  scratchRoot: string;
  reportProcessContainment: (evidence: LocalMotionProcessContainmentEvidence) => void;
  maxProcessTreeRssBytes: number;
}

async function runFfmpegChild(command: FfmpegCommand, options: RunFfmpegChildOptions): Promise<FfmpegProcessResult> {
  if (process.platform === "win32") return runWindowsContainedFfmpegChild(command, options);
  const mode: FfmpegProcessTerminationMode = process.platform === "linux" || process.platform === "darwin"
    ? "unix-process-group"
    : "direct-child";
  options.reportProcessContainment(portableFfmpegContainmentEvidence(mode));
  return runSpawnedFfmpegChild(command, options.signal, options.watchProcess, () => mode);
}

async function runWindowsContainedFfmpegChild(command: FfmpegCommand, options: RunFfmpegChildOptions): Promise<FfmpegProcessResult> {
  const requireNative = nativeWindowsJobObjectRequired();
  let plan: WindowsJobObjectLaunchPlan;
  try {
    plan = await createWindowsJobObjectLaunchPlan({
      executable: command.executable,
      args: command.args,
      workingDirectory: process.cwd(),
      scratchRoot: options.scratchRoot,
      maxJobMemoryBytes: options.maxProcessTreeRssBytes,
      maxActiveProcesses: 4_096,
      ...(process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER?.trim()
        ? { helperPath: process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER.trim() }
        : {}),
    });
  } catch (error) {
    const reasonCode = error instanceof WindowsJobObjectPlanError
      ? error.reasonCode
      : "native_setup_failed";
    const unavailable = unavailableWindowsContainment(reasonCode);
    if (requireNative) {
      options.reportProcessContainment(unavailable);
      throw new LocalMotionJobError(
        "job_process_containment_unavailable",
        reasonCode === "native_helper_missing"
          ? "Motion requires native Windows Job Object containment, but the trusted launcher is unavailable."
          : "Motion requires native Windows Job Object containment, but launch planning failed."
      );
    }
    options.reportProcessContainment(windowsTaskkillFallbackEvidence(reasonCode));
    return runSpawnedFfmpegChild(command, options.signal, options.watchProcess, () => "windows-taskkill-fallback");
  }

  let terminationMode: FfmpegProcessTerminationMode = "windows-taskkill-fallback";
  const nativeController = new AbortController();
  const relayAbort = () => nativeController.abort(options.signal.reason);
  options.signal.addEventListener("abort", relayAbort, { once: true });
  if (options.signal.aborted) relayAbort();
  const nativeAttempt = runSpawnedFfmpegChild({
    executable: plan.executable,
    args: plan.args,
    shell: false,
  }, nativeController.signal, options.watchProcess, () => terminationMode);
  let status: WindowsJobObjectStatus;
  try {
    status = await waitForWindowsJobObjectStatus(plan, { signal: nativeController.signal });
  } catch (error) {
    if (!options.signal.aborted) {
      nativeController.abort(error instanceof Error
        ? error
        : new Error("Motion Windows Job Object helper returned invalid status evidence."));
    }
    await nativeAttempt.catch(() => undefined);
    const finalStatus = await waitForWindowsJobObjectStatus(plan, { timeoutMs: 100 }).catch(() => ({
      schema: "shellx-motion/windows-job-status@1" as const,
      status: "unavailable" as const,
      mode: "windows-job-object" as const,
      reasonCode: "native_setup_failed" as const,
    }));
    if (options.signal.aborted) {
      options.reportProcessContainment(finalStatus.status === "enforced"
        ? windowsJobObjectContainmentEvidence(plan, finalStatus)
        : windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
      await cleanupWindowsJobObjectLaunchPlan(plan);
      options.signal.removeEventListener("abort", relayAbort);
      throw options.signal.reason;
    }
    status = finalStatus;
  }

  if (status.status === "enforced") {
    terminationMode = "windows-job-object";
    options.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, status));
    try {
      return await nativeAttempt;
    } finally {
      options.signal.removeEventListener("abort", relayAbort);
      await cleanupWindowsJobObjectLaunchPlan(plan);
    }
  }

  nativeController.abort(new Error("Motion native Windows Job Object setup was unavailable."));
  await nativeAttempt.catch(() => undefined);
  options.signal.removeEventListener("abort", relayAbort);
  await cleanupWindowsJobObjectLaunchPlan(plan);
  if (requireNative) {
    options.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, status));
    throw new LocalMotionJobError(
      "job_process_containment_unavailable",
      "Motion requires native Windows Job Object containment, but native setup failed."
    );
  }
  options.reportProcessContainment(windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
  if (options.signal.aborted) throw options.signal.reason;
  return runSpawnedFfmpegChild(command, options.signal, options.watchProcess, () => "windows-taskkill-fallback");
}

/**
 * Software-encode override. When set (1/true/yes) the final render always
 * uses the software encoder even if a hardware candidate is probe-verified — for reproducibility
 * contexts where the exact libx264/libx265 bitstream matters. An explicit `forceSoftwareEncode`
 * option on the encode input takes precedence over this env flag.
 */
function envForceSoftwareEncode(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE?.trim() ?? "");
}

const FFMPEG_RESOURCE_LIMIT_EXIT_CODE = 125;

function ffmpegJobOperation(args: string[]): string {
  if (args.includes("-encoders")) return "ffmpeg.encoders";
  // A VISIBILITY label, and nothing more. This once claimed that classifying a version probe kept
  // a doctor run from queueing behind renders; that was false. `acquireSlot` is global and
  // operation-blind — it never reads this string — so a governed probe competed for the same two
  // slots an encode does. The fix is upstream: `probeMotionTool` no longer uses the governed
  // runner at all (see `createToolIdentityProbeRunner`). This label still applies to the version
  // probe `checkFfmpeg` runs on the render path, which IS governed work and belongs in the queue.
  // `--version` is Chromium's spelling of the same probe.
  if (args.includes("-version") || args.includes("--version")) return "ffmpeg.version";
  if (args.includes("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json")) return "ffmpeg.audio.measure";
  if (args.includes("-show_streams") || args.includes("-show_format")) return "ffmpeg.probe";
  return "ffmpeg.render";
}

function readExecutableEnv(name: "SHELLX_MOTION_FFMPEG" | "SHELLX_MOTION_FFPROBE"): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Resolve a fixed FFmpeg tool through absolute PATH entries without Windows' cwd-first search. */
function resolveWindowsPathTool(tool: "ffmpeg" | "ffprobe"): string | null {
  for (const rawEntry of process.env.PATH?.split(win32.delimiter) ?? []) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (!entry || !win32.isAbsolute(entry)) continue;
    const candidate = win32.join(entry, `${tool}.exe`);
    try {
      const original = lstatSync(candidate);
      if (!original.isFile() || original.isSymbolicLink()) continue;
      const canonical = realpathSync(candidate);
      if (!win32.isAbsolute(canonical) || !lstatSync(canonical).isFile()) continue;
      return canonical;
    } catch {
      // Continue through the explicit absolute PATH entries only.
    }
  }
  return null;
}

/** Absolute non-existent refusal target; never allows CreateProcess to search the current directory. */
function missingWindowsToolCandidate(tool: "ffmpeg" | "ffprobe"): string {
  return win32.join(String.raw`\\?\GLOBALROOT\SystemRoot`, "System32", `${tool}.exe`);
}

function discoverShellxFamilyFfmpegTool(fileName: "ffmpeg.exe" | "ffprobe.exe"): string | null {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const candidates = ["ShellX Motion", "ShellX Cut", "ShellX Canvas"].flatMap((productDir) => {
    const toolRoot = join(localAppData, productDir, "tools", "ffmpeg");
    return [
      join(toolRoot, "bin", fileName),
      ...readDirectoryNames(toolRoot).map((entry) => join(toolRoot, entry, "bin", fileName))
    ];
  });
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Routine lines ffmpeg prints on every successful encode.
 *
 * Deliberately a denylist rather than an allowlist of "real" warnings: an unrecognised line
 * survives into the receipt, so the failure direction is an extra line rather than a hidden
 * problem. ffmpeg's diagnostic vocabulary varies by version and codec; its banner, stream
 * mapping and statistics blocks do not.
 */
const ROUTINE_ENCODE_STDERR = [
  /^ffmpeg version /,
  /^\s*built with /,
  /^\s*configuration:/,
  /^\s*lib[a-z]+\s+\d+\./,
  /^(Input|Output) #\d/,
  /^Stream mapping:/,
  /^\s*Stream #\d/,
  // The filtergraph half of the stream-mapping block, e.g. "  loudnorm:default (graph 0) ->
  // Stream #0:1 (aac)" and "  paletteuse:default -> Stream #0:0 (gif)". Printed whenever a filter
  // feeds an output, which every normalized audio render and every GIF render does; the
  // `Stream #\d` pattern above only catches mappings that START with a stream.
  //
  // ` (graph N)` is OPTIONAL because ffmpeg only prints it when the run has more than one
  // filtergraph: the audio path (two graphs) shows it, the GIF path (`-filter_complex` alone,
  // one graph) does not, so the graph-only spelling left every GIF render leaking its own
  // stream-mapping line into `warnings`. Both spellings are the same block of the same banner.
  /^\s+\S+(?: \(graph \d+\))? -> Stream #\d/,
  // FFmpeg's Matroska stream metadata uses uppercase tag names on some builds, e.g.
  // `DURATION : 00:00:01.500000000` and `ENCODER : Lavc60.31.102 ffv1`. They describe a
  // successfully discovered stream; they are not encoder diagnostics. Keep these label matches
  // case-insensitive so the same clean segmented final is not receipt-warning only on that host.
  /^\s*Duration\s*:/i,
  /^\s*Metadata:/,
  /^\s*Side data:/,
  /^\s*cpb:/,
  // The same HRD/CPB side-data line under its NEWER spelling. FFmpeg 6.1.1 prints it as
  // "  cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A"; FFmpeg 8.x prints the
  // side-data type's own description instead — "  CPB properties: bitrate max/min/avg: ...".
  // Real captured output from a Windows ffmpeg N-125773 connector run, where the rename meant a
  // routine line stopped matching `cpb:` and turned four connector smokes into `warning` on
  // Windows while the identical package stayed `passed` on Linux. Same block, same encode, one
  // renamed label — so it is filtered under both spellings.
  //
  // The captured line keeps its leading indentation (it is nested under "Side data:"), hence the
  // leading `\s*`; the rest is anchored to the exact HRD field sequence so a genuine bitrate or
  // buffering diagnostic, which is prose, cannot match.
  /^\s*CPB properties: bitrate max\/min\/avg: [\d/]+ buffer size: \d+ vbv_delay: \S+$/,
  /^\s*encoder\s*:/i,
  /^Press \[q\]/,
  // Progress and the muxing-overhead summary. ffmpeg merges these onto one line when the
  // terminal is not a TTY, which is exactly how they reach us.
  /^frame=\s*\d/,
  /muxing overhead:/,
  // Per-codec statistics blocks, e.g. "[libx264 @ 0x..] frame I:1  Avg QP:25.83".
  /^\[lib[a-z0-9_]+ @ [^\]]+\]\s+(frame [IPB]:|mb [IPB] |8x8 transform|coded y,|i\d+[a-z]* [vhdc,]|Weighted P-Frames:|kb\/s:|using (SAR|cpu capabilities)|profile |\d+ - core |consecutive B-frames:|ref [PB] L\d:|(SSIM|PSNR) Mean)/,
  // The rest of the x264/aac summary that the pattern above does not name, plus the encoder-agnostic
  // per-encoder average quality line. Same block, same run, printed after the muxing summary.
  /^\[(aac|ac3|libmp3lame|libopus|libvorbis) @ [^\]]+\]\s+Qavg:/,
  // libvpx's version banner, e.g. "[libvpx-vp9 @ 0x5b15e8932f00] v1.14.0" (VP8 prints the same
  // line as "[libvpx @ ...]"). ffmpeg's libvpx wrapper logs `vpx_codec_version_str()` at INFO on
  // every single libvpx encode, so a perfectly clean WebM render was being downgraded to
  // `warning` by an encoder stating its own version — the success-status invariant. On an agent-first
  // product that is worse than noise: it makes every other warning less trustworthy.
  //
  // Anchored across the WHOLE line, not just its prefix, so it cannot swallow a real diagnostic:
  // the tag must be a libvpx encoder instance, and everything after `]` must be exactly one
  // version token (`v<major>.<minor>.<patch>` plus libvpx's optional `-rc1` / `-172-gabc1234`
  // build suffix) with nothing following it. Real libvpx diagnostics are prose with spaces —
  // "Neither bitrate nor constrained quality specified, using default CRF of 32", "CQ level 32
  // must be between minimum and maximum quantizer value (40-20)" — and cannot match.
  /^\[libvpx(?:-vp\d)? @ [^\]]+\] v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*$/,
  // Channel layout inference. ffmpeg prints this for raw PCM/WAV input, which carries no layout
  // metadata — Motion's own audio staging produces exactly that input, so it is unconditional on
  // every audio render. It reports a successful inference, not a problem with the media.
  /^\[[^\]]+\]\s+Guessed Channel Layout: /,
  // Image-sequence + audio muxing back-pressure notice. Emitted whenever a demuxer thread waits on
  // a full queue, which is the normal shape of "read PNGs as fast as the encoder consumes them".
  // Nothing is dropped and the encode is unaffected; it is a tuning suggestion, not a defect.
  /^\[[^\]]+\]\s+Thread message queue blocking; consider raising the thread_queue_size option/,
  // EBU R128 loudnorm's measurement summary (`print_format=summary`). These are MEASUREMENTS, not
  // diagnostics: Motion asks for them deliberately, parses them, and records the achieved program
  // loudness on the receipt as `output.audio.loudness`. Leaving them in `warnings` made every
  // normalized audio render look like it had complained about something (the success-status invariant). The
  // labels are matched exactly so an actual loudnorm error, which does not use this vocabulary,
  // still survives into the receipt.
  /^\[Parsed_loudnorm_\d+ @ [^\]]+\]\s*$/,
  /^(Input|Output) (Integrated|True Peak|LRA|Threshold):\s+[-+]?[\d.]+ (LUFS|dBTP|LU)$/,
  /^Normalization Type:\s+\S+$/,
  /^Target Offset:\s+[-+]?[\d.]+ LU$/,
  // palettegen's palette-size report, e.g. "[Parsed_palettegen_1 @ 0x5a5ce1edee80] 255(+1) colors
  // generated out of 19505 colors; ratio=0.013074". libavfilter logs it at AV_LOG_INFO on every
  // single palettegen run — verified empirically, not assumed: re-running the same encode with
  // `-loglevel warning` drops this line and keeps `Duped color`, so ffmpeg itself grades this one
  // as routine. Motion's `gif` preset is a two-pass palettegen -> paletteuse filtergraph, so every
  // GIF render printed it and every GIF receipt carried it as a "warning".
  //
  // Worse than noise, and the reason it is filtered rather than tolerated: the `@ 0x...` tag is a
  // heap pointer, so two renders of the SAME package produced different receipt text and no
  // receipt could be compared byte for byte.
  //
  // Anchored across the whole line — the tag must be a palettegen instance, and the body must be
  // exactly ffmpeg's `%d%s colors generated out of %d colors; ratio=%f` format string
  // (`(+1)` present only when a transparent slot is reserved, which is palettegen's default and
  // Motion's configuration). Every other thing palettegen says is prose that cannot match:
  // "Duped color: FFDCDDE0" (a real AV_LOG_WARNING) and "max_colors=2 is only allowed without
  // reserving a transparent color slot" (a real AV_LOG_ERROR) both survive into the receipt.
  /^\[Parsed_palettegen_\d+ @ [^\]]+\] \d+(?:\(\+\d+\))? colors generated out of \d+ colors; ratio=[\d.]+$/,
  // `-movflags +faststart` progress. Every Motion MP4 preset asks for faststart, so the MP4 muxer
  // ALWAYS rewrites the file to move `moov` to the front and always says so. It reports work the
  // caller requested, on a successful encode, and there is nothing to act on.
  //
  // Why it only leaked on some hosts: FFmpeg 6.1.1 merges this line onto the trailing `frame=`
  // progress line when stderr is not a TTY, where `/^frame=\s*\d/` already swallowed it. On the
  // Windows FFmpeg N-125773 build it arrives on its own line — so the SAME package produced a
  // `passed` receipt on Linux and a `warning` on Windows, failing four connector smokes on nothing
  // but chatter. It also carries a run-varying instance pointer (printed WITHOUT the `0x` prefix on
  // Windows, which is why the tag is matched as `[^\]]+` rather than a hex literal).
  //
  // Scoped to the ISOBMFF muxer family that implements faststart, and anchored across the whole
  // line, so a genuine mp4-muxer diagnostic from the same instance still reaches the receipt.
  /^\[(?:mp4|mov|ipod) @ [^\]]+\] Starting second pass: moving the moov atom to the beginning of the file$/
] as const;

/**
 * Reduce a successful encode's stderr to whatever ffmpeg actually flagged.
 *
 * The previous behaviour took the last two lines unconditionally, which on a clean encode are
 * always the progress and muxing-overhead summary. Those were recorded as receipt warnings, so
 * every successful render looked like it had warned about something and a caller filtering on
 * `warnings.length > 0` could not distinguish a real problem from routine output.
 */
export function summarizeSuccessfulEncodeStderr(stderr: string): string {
  const flagged = stderr
    // FFmpeg updates progress with a bare carriage return. Treat it as a record boundary too, or
    // a genuine diagnostic following the progress entry remains on the same string and is dropped
    // by the anchored routine-progress filter.
    .split(/\r\n?|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !ROUTINE_ENCODE_STDERR.some((pattern) => pattern.test(line)))
    // FFmpeg prefixes component messages with the instance pointer, e.g.
    // `[Parsed_palettegen_1 @ 0x641500efbe80] Duped color: FFDCDDE0`. That address changes every run,
    // so two renders of the SAME package produced receipts that differed only in noise — which
    // defeats byte-comparison of receipts, and byte-comparison is how a caller proves a re-render is
    // identical. Filtering the line is not an option here: this one is a genuine AV_LOG_WARNING and
    // must survive. Normalising the address keeps the warning and removes the only unstable part.
    // Same treatment `summarizeHardwareProbeFailure` already applies for the same reason.
    .map((line) => line.replace(/\b0x[0-9a-f]+\b/gi, "[address]"));
  // Bounded: a pathological encode can emit thousands of identical complaints. Deduplicated AFTER
  // normalisation, so the same warning from two component instances collapses to one entry.
  return redact([...new Set(flagged)].slice(0, 5).join(" "));
}

function summarizeStderr(stderr: string): string {
  return summarizeFfmpegDiagnostic(stderr);
}

function redact(value: string): string {
  return redactFfmpegDiagnostic(value);
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function parseFps(value: string): number {
  const parts = value.split("/").map(Number);
  const fps = parts.length === 2 ? (parts[1] > 0 ? parts[0] / parts[1] : 0) : parts[0];
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function deliveredFps(stream: { avg_frame_rate?: string; nb_frames?: string | number }, durationMs: number): number {
  const frameCount = parseOptionalNumber(stream.nb_frames);
  if (frameCount !== null && Number.isSafeInteger(frameCount) && frameCount > 0 && durationMs > 0) {
    return frameCount / (durationMs / 1_000);
  }
  return parseFps(stream.avg_frame_rate ?? "0/1");
}

function parseOptionalNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseOptionalDurationMs(value: string | number | undefined): number | null {
  const number = parseOptionalNumber(value);
  return number === null || number < 0 ? null : Math.round(number * 1000);
}

function alphaMediaFacts(stream: { codec_name?: string; pix_fmt?: string; tags?: Record<string, string | number> }): ProbeMediaResult["alpha"] {
  const pixelFormat = typeof stream.pix_fmt === "string" ? stream.pix_fmt : null;
  const rawMode = stream.tags?.alpha_mode;
  const mode = rawMode === undefined ? null : String(rawMode);
  const hasAlphaPixelFormat = pixelFormat !== null && /(?:^|[^a-z])(?:yuva|rgba|bgra|argb|abgr)/i.test(pixelFormat);
  const hasVp9AlphaMode = stream.codec_name === "vp9" && mode === "1";
  const present = hasAlphaPixelFormat || hasVp9AlphaMode;
  return {
    present,
    mode,
    pixelFormat,
    decoder: hasVp9AlphaMode ? "libvpx-vp9" : null
  };
}

function formatSeconds(seconds: number): string {
  return formatNumber(seconds);
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function frameCountFor(durationMs: number, fps: number): number {
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

async function hashFrameSequence(input: {
  framesDir: string;
  framePattern: string;
  framePaths: string[];
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
}): Promise<string> {
  // Bounded rather than `Promise.all(framePaths.map(hashFile))`: this runs AFTER an expensive
  // render, over as many as 36,000 frames (the local render guard's ceiling), and the naive shape
  // held one descriptor and one 64 KiB read stream per frame at once. Measured on 12,000 frames:
  // 12,000 concurrent descriptors / 521 MB RSS before, 16 / 148 MB after (the bounded-frame-hash invariant).
  const frameHashes = await hashFramePaths(input.framePaths);
  return hashBuffer(Buffer.from(JSON.stringify({
    framesDir: input.framesDir,
    framePattern: input.framePattern,
    frameCount: input.frameCount,
    frameHashes,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  }), "utf8"));
}
