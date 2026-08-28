import { canonicalJsonSha256 } from "@shellx-motion/core";
import { SCENE3D_GLTF_PBR_HDR10_ADMISSION } from "@shellx-motion/core/internal/scene3d-gltf-pbr-hdr10-final";
import { HDR10_PQ_CONVERSION_CONTRACT, type Hdr10PqConversionSequence } from "./hdr10-pq-conversion-contract.js";
import { hasHdr10PqConversionExecutionProof } from "./hdr10-pq-conversion.js";

export const HDR10_PQ_FFMPEG_COMMAND_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-inert-plan@2" as const;
export const HDR10_PQ_FFMPEG_RECEIPT_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-inert-plan-receipt@2" as const;
export const HDR10_PQ_FFMPEG_OUTPUT_TOKEN = "__shellx_motion_managed_hdr10_output__.mp4" as const;
const HDR10_SIGNAL = SCENE3D_GLTF_PBR_HDR10_ADMISSION.output.ffmpegSignal;
export const HDR10_PQ_C1_FFMPEG_ARGS = Object.freeze([
  "-hide_banner", "-nostdin", "-f", "rawvideo", "-pixel_format", "yuv420p10le", "-video_size", "1280x720", "-framerate", "30", "-i", "pipe:0", "-map", "0:v:0", "-an", "-frames:v", String(HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount), "-c:v", "libx265", "-profile:v", "main10", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-color_primaries", HDR10_SIGNAL.colorPrimaries, "-color_trc", HDR10_SIGNAL.colorTransfer, "-colorspace", HDR10_SIGNAL.colorSpace, "-color_range", HDR10_SIGNAL.colorRange, "-chroma_sample_location", HDR10_PQ_CONVERSION_CONTRACT.signaling.chromaLocation, "-x265-params", HDR10_SIGNAL.x265Params, "-movflags", "+faststart", HDR10_PQ_FFMPEG_OUTPUT_TOKEN,
]);

export interface Hdr10PqFfmpegCommandContract {
  readonly schema: typeof HDR10_PQ_FFMPEG_COMMAND_SCHEMA;
  readonly command: { readonly executable: "ffmpeg"; readonly shell: false; readonly args: readonly string[]; readonly deferredOutputToken: typeof HDR10_PQ_FFMPEG_OUTPUT_TOKEN; readonly launch: "forbidden-no-c2-durable-pipe"; };
  readonly receipt: { readonly schema: typeof HDR10_PQ_FFMPEG_RECEIPT_SCHEMA; readonly lane: "software-libx265-main10-hvc1-mp4-c1-inert-plan@2"; readonly generatedInput: Hdr10PqConversionSequence; readonly durablePipe: "not-established-in-c1"; readonly launchAuthority: "absent"; readonly plannedOutput: { readonly codec: "hevc"; readonly encoder: "libx265"; readonly profile: "main10"; readonly codecTag: "hvc1"; readonly container: "mp4"; readonly pixelFormat: "yuv420p10le"; readonly color: { readonly primaries: "bt2020"; readonly transfer: "smpte2084"; readonly matrix: "bt2020nc"; readonly range: "tv"; readonly chromaLocation: "topleft"; }; readonly masteringDisplay: string; readonly hardware: "refused"; readonly segmentedOrResume: "refused"; }; readonly fingerprint: string; };
  readonly fingerprint: string;
}

/** Builds an immutable C1 plan only; generated-frame proof never proves durable input or authorizes launch. */
export function createHdr10PqFfmpegCommand(value: unknown): Hdr10PqFfmpegCommandContract {
  if (!hasHdr10PqConversionExecutionProof(value)) throw new Error("HDR10 FFmpeg plan requires private proof that deterministic conversion ran.");
  const input = value, args = HDR10_PQ_C1_FFMPEG_ARGS;
  const command = Object.freeze({ executable: "ffmpeg" as const, shell: false as const, args, deferredOutputToken: HDR10_PQ_FFMPEG_OUTPUT_TOKEN, launch: "forbidden-no-c2-durable-pipe" as const });
  const receiptBase = { schema: HDR10_PQ_FFMPEG_RECEIPT_SCHEMA, lane: "software-libx265-main10-hvc1-mp4-c1-inert-plan@2" as const, generatedInput: input, durablePipe: "not-established-in-c1" as const, launchAuthority: "absent" as const, plannedOutput: { codec: "hevc" as const, encoder: "libx265" as const, profile: "main10" as const, codecTag: "hvc1" as const, container: "mp4" as const, pixelFormat: "yuv420p10le" as const, color: { primaries: "bt2020" as const, transfer: "smpte2084" as const, matrix: "bt2020nc" as const, range: "tv" as const, chromaLocation: HDR10_PQ_CONVERSION_CONTRACT.signaling.chromaLocation }, masteringDisplay: HDR10_PQ_CONVERSION_CONTRACT.signaling.masteringDisplay, hardware: "refused" as const, segmentedOrResume: "refused" as const } };
  const receipt = freeze({ ...receiptBase, fingerprint: canonicalJsonSha256(receiptBase) });
  const base = { schema: HDR10_PQ_FFMPEG_COMMAND_SCHEMA, command, receipt };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Hdr10PqFfmpegCommandContract;
}

function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
