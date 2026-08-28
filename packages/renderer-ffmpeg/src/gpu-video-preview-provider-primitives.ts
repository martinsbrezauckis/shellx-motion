import { createHash } from "node:crypto";
import { extname, relative, resolve, sep } from "node:path";
import { canonicalJsonSha256, type GpuVideoFrameRequest } from "@shellx-motion/core";
import type { GpuPreviewVideoTextureSlot } from "@shellx-motion/renderer-browser";
import type { FfmpegMediaInputInspection, FfmpegMediaInputSnapshot } from "./ffmpeg-media-input-fence.js";
import { trackingFfmpegMediaInputArgs } from "./ffmpeg-media-input-fence.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable, type FfmpegCommand, type FfmpegProcessResult } from "./index.js";

export const MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES = 512 * 1024 * 1024;
export const MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT = 8;
export const MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES = 32;
export const MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES = 128 * 1024 * 1024;
export const MAX_GPU_PREVIEW_VIDEO_IN_FLIGHT_RGBA_BYTES = 64 * 1024 * 1024;
export const MAX_GPU_PREVIEW_VIDEO_DIMENSION = 4_096;
export const MAX_GPU_PREVIEW_VIDEO_DURATION_US = 24 * 60 * 60 * 1_000_000;
export const MAX_GPU_PREVIEW_VIDEO_RECENT_FRAME_EVIDENCE = 64;

export type GpuPreviewFfmpegRunner = (command: FfmpegCommand, signal: AbortSignal) => Promise<FfmpegProcessResult>;
export type Rational = { numerator: bigint; denominator: bigint };
export interface PreviewToolIdentity { ffmpeg: string; ffprobe: string; }
export interface PreviewSource {
  assetRef: string;
  inspection: FfmpegMediaInputInspection;
  snapshot: FfmpegMediaInputSnapshot;
  width: number;
  height: number;
  durationUs: number;
  frameCount: bigint;
  fps: Rational;
  timeBase: Rational;
  frameDurationPts: bigint;
  decodeContractSha256: string;
  slots: GpuPreviewVideoTextureSlot[];
}

interface ProbeStream { codec_type?: unknown; width?: unknown; height?: unknown; avg_frame_rate?: unknown; r_frame_rate?: unknown; time_base?: unknown; duration_ts?: unknown; nb_frames?: unknown; start_pts?: unknown; start_time?: unknown; disposition?: { attached_pic?: unknown }; }

export async function probePreviewSource(snapshot: FfmpegMediaInputSnapshot, runner: GpuPreviewFfmpegRunner, signal: AbortSignal): Promise<{ width: number; height: number; durationUs: number; frameCount: bigint; fps: Rational; timeBase: Rational; frameDurationPts: bigint }> {
  const result = await runner({ executable: resolveFfprobeExecutable(), shell: false, args: ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...trackingFfmpegMediaInputArgs(snapshot.path)] }, signal);
  throwIfAborted(signal);
  if (result.exitCode !== 0) throw new Error("GPU preview immutable-source probe failed.");
  if (Buffer.byteLength(result.stdout, "utf8") > 512 * 1024) throw new Error("GPU preview immutable-source probe returned too much JSON.");
  let parsed: { streams?: unknown };
  try { parsed = JSON.parse(result.stdout) as { streams?: unknown }; } catch { throw new Error("GPU preview immutable-source probe returned invalid JSON."); }
  if (!Array.isArray(parsed.streams)) throw new Error("GPU preview immutable-source probe did not report streams.");
  const streams = parsed.streams as ProbeStream[], videos = streams.filter((stream) => stream.codec_type === "video");
  if (videos.length !== 1 || videos[0]?.disposition?.attached_pic === 1) throw new Error("GPU preview accepts exactly one non-attached video stream.");
  if (streams.some((stream) => stream.codec_type === "data")) throw new Error("GPU preview refuses media data streams and reference-capable source metadata.");
  const stream = videos[0]!, width = boundedDimension(stream.width, "width"), height = boundedDimension(stream.height, "height");
  const fps = parsePositiveRational(stream.avg_frame_rate, "avg_frame_rate"), nominalFps = parsePositiveRational(stream.r_frame_rate, "r_frame_rate"), timeBase = parsePositiveRational(stream.time_base, "time_base");
  if (!sameRational(fps, nominalFps)) throw new Error("GPU preview refuses VFR or ambiguous video cadence (avg_frame_rate differs from r_frame_rate).");
  const frameDurationNumerator = fps.denominator * timeBase.denominator, frameDurationDenominator = fps.numerator * timeBase.numerator;
  if (frameDurationDenominator === 0n || frameDurationNumerator % frameDurationDenominator !== 0n) throw new Error("GPU preview refuses CFR sources whose frame duration cannot be represented exactly in their stream PTS time base.");
  const frameDurationPts = frameDurationNumerator / frameDurationDenominator, frameCount = parsePositiveInteger(stream.nb_frames, "nb_frames"), durationPts = parsePositiveInteger(stream.duration_ts, "duration_ts");
  if (durationPts !== frameCount * frameDurationPts) throw new Error("GPU preview refuses VFR or ambiguous source duration/frame-count cadence.");
  if (stream.start_pts !== undefined && parseInteger(stream.start_pts, "start_pts") !== 0n) throw new Error("GPU preview requires a zero-origin video PTS timeline.");
  if (stream.start_time !== undefined && !parseZeroSeconds(stream.start_time)) throw new Error("GPU preview requires a zero-origin video start_time.");
  const durationUsValue = durationPts * timeBase.numerator * 1_000_000n;
  // Valid CFR stream ends are often fractional microseconds (for example 145 frames at 24 fps).
  // Core needs an integer-us half-open bound, while exact selection remains rational stream PTS.
  const durationUsBig = (durationUsValue + timeBase.denominator - 1n) / timeBase.denominator;
  if (durationUsBig < 1n || durationUsBig > BigInt(MAX_GPU_PREVIEW_VIDEO_DURATION_US)) throw new Error(`GPU preview immutable-source duration must be within 0..${MAX_GPU_PREVIEW_VIDEO_DURATION_US} microseconds.`);
  return { width, height, durationUs: Number(durationUsBig), frameCount, fps, timeBase, frameDurationPts };
}

export function makePreviewSource(assetRef: string, inspection: FfmpegMediaInputInspection, snapshot: FfmpegMediaInputSnapshot, facts: Awaited<ReturnType<typeof probePreviewSource>>, layerIds: readonly string[], tooling: PreviewToolIdentity): PreviewSource {
  const extension = extname(snapshot.path).toLowerCase();
  const contract = { schema: "shellx-motion/gpu-preview-video-decode-contract@1", surface: "preview-visual-only", tools: { ffmpeg: { executable: resolveFfmpegExecutable(), identity: tooling.ffmpeg }, ffprobe: { executable: resolveFfprobeExecutable(), identity: tooling.ffprobe } }, input: { protocolWhitelist: ["file"], extension, immutableSnapshotSha256: snapshot.sha256, dataReferences: "refused", fixedDemuxer: demuxerForExtension(extension) }, stream: { videoStreams: 1, dataStreams: 0, fps: rationalText(facts.fps), timeBase: rationalText(facts.timeBase), frameDurationPts: facts.frameDurationPts.toString(), frameCount: facts.frameCount.toString(), durationUs: facts.durationUs }, selection: "cfr-floor-request-sourceAtUs-to-stream-pts", output: { argv: ["-v", "error", "-nostdin", "-n", "{fixed-file-input}", "-ss", "{selected-cfr-pts-seconds}", "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "{private-no-clobber-rgba}"], map: "0:v:0", audio: "disabled", subtitles: "disabled", data: "disabled", frames: 1, pixelFormat: "rgba", container: "rawvideo" } };
  const decodeContractSha256 = canonicalJsonSha256(contract);
  const slots = layerIds.map((layerId) => Object.freeze({ layerId, assetRef, resourceId: `preview-video-${hashText(`${layerId}\0${snapshot.sha256}`).slice(0, 24)}`, width: facts.width, height: facts.height, sourceSnapshotSha256: snapshot.sha256, decodeContractSha256 }));
  return { assetRef, inspection, snapshot, width: facts.width, height: facts.height, durationUs: facts.durationUs, frameCount: facts.frameCount, fps: facts.fps, timeBase: facts.timeBase, frameDurationPts: facts.frameDurationPts, decodeContractSha256, slots };
}

export async function probePreviewToolIdentity(runner: GpuPreviewFfmpegRunner, signal: AbortSignal): Promise<PreviewToolIdentity> {
  const read = async (executable: string, label: "ffmpeg" | "ffprobe") => { const result = await runner({ executable, shell: false, args: ["-version"] }, signal); throwIfAborted(signal); if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > 16 * 1024) throw new Error(`GPU preview ${label} version probe failed.`); const identity = result.stdout.split(/\r?\n/, 1)[0]?.trim(); if (!identity || identity.length > 512) throw new Error(`GPU preview ${label} version probe did not return one bounded identity line.`); return identity; };
  return { ffmpeg: await read(resolveFfmpegExecutable(), "ffmpeg"), ffprobe: await read(resolveFfprobeExecutable(), "ffprobe") };
}

export function assertRequestMatchesSource(request: GpuVideoFrameRequest, source: PreviewSource, slot: GpuPreviewVideoTextureSlot): void { if (request.sourceSnapshotSha256 !== source.snapshot.sha256 || request.decodeContractSha256 !== source.decodeContractSha256 || request.width !== source.width || request.height !== source.height || slot.assetRef !== request.assetRef || slot.decodeContractSha256 !== request.decodeContractSha256) throw new Error(`GPU preview video request ${request.layerId} does not bind this immutable source, decode contract, dimensions, and texture slot.`); if (!Number.isSafeInteger(request.sourceAtUs) || request.sourceAtUs < 0 || request.sourceAtUs >= source.durationUs) throw new Error(`GPU preview video request ${request.layerId} sourceAtUs is outside its immutable source duration.`); }
export function selectCfrFrame(source: PreviewSource, sourceAtUs: number): bigint { const index = (BigInt(sourceAtUs) * source.fps.numerator) / (source.fps.denominator * 1_000_000n); if (index < 0n || index >= source.frameCount) throw new Error("GPU preview video exact-time selection exceeds the admitted CFR frame count."); return index * source.frameDurationPts; }
/** Immutable raw RGBA identity: a CFR display interval shares one selected stream PTS. */
export function frameKey(source: PreviewSource, decodedPts: bigint): string { return `${source.snapshot.sha256}\0${decodedPts.toString()}\0${source.width}x${source.height}\0${source.decodeContractSha256}`; }
export function rgbaBytes(width: number, height: number): number { const bytes = width * height * 4; if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("GPU preview video RGBA frame size exceeds safe integer precision."); return bytes; }
export function privateChildPath(root: string | undefined, name: string): string { if (!root) throw new Error("GPU preview video private scratch root is unavailable."); const path = resolve(root, name), relation = relative(root, path); if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error("GPU preview video private temporary path escaped its scratch child."); return path; }
export function rationalText(value: Rational): string { return `${value.numerator.toString()}/${value.denominator.toString()}`; }
export function rationalSeconds(numerator: bigint, denominator: bigint): string { return rationalDecimal(numerator, denominator, 12); }
export function rationalDecimal(numerator: bigint, denominator: bigint, digits = 6): string { const whole = numerator / denominator, remainder = numerator % denominator; if (remainder === 0n) return whole.toString(); let fraction = "", value = remainder; for (let index = 0; index < digits; index += 1) { value *= 10n; fraction += (value / denominator).toString(); value %= denominator; } return `${whole.toString()}.${fraction.replace(/0+$/, "") || "0"}`; }
export function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortReason(signal); }
export function abortReason(signal: AbortSignal): unknown { return signal.reason ?? new Error("GPU preview video operation was cancelled."); }
function demuxerForExtension(extension: string): string { if (extension === ".mp4" || extension === ".mov") return "mov"; if (extension === ".mkv" || extension === ".webm") return "matroska"; throw new Error("GPU preview video source has no fixed self-contained demuxer."); }
function boundedDimension(value: unknown, label: "width" | "height"): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_GPU_PREVIEW_VIDEO_DIMENSION) throw new Error(`GPU preview immutable-source probe ${label} must be an integer within 1..${MAX_GPU_PREVIEW_VIDEO_DIMENSION}.`); return value; }
function parsePositiveRational(value: unknown, label: string): Rational { if (typeof value !== "string" || !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(value)) throw new Error(`GPU preview immutable-source probe ${label} must be a positive rational.`); return normalize({ numerator: BigInt(value.slice(0, value.indexOf("/"))), denominator: BigInt(value.slice(value.indexOf("/") + 1)) }); }
function parsePositiveInteger(value: unknown, label: string): bigint { const parsed = parseInteger(value, label); if (parsed < 1n) throw new Error(`GPU preview immutable-source probe ${label} must be a positive integer.`); return parsed; }
function parseInteger(value: unknown, label: string): bigint { const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value; if (typeof text !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(`GPU preview immutable-source probe ${label} must be an integer.`); return BigInt(text); }
function parseZeroSeconds(value: unknown): boolean { return value === 0 || value === "0" || value === "0.0" || value === "0.000000"; }
function normalize(value: Rational): Rational { const divisor = gcd(value.numerator, value.denominator); return { numerator: value.numerator / divisor, denominator: value.denominator / divisor }; }
function gcd(left: bigint, right: bigint): bigint { let a = left, b = right; while (b) [a, b] = [b, a % b]; return a; }
function sameRational(left: Rational, right: Rational): boolean { return left.numerator === right.numerator && left.denominator === right.denominator; }
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
