import { canonicalJsonSha256 } from "@shellx-motion/core";
import { HDR10_PQ_CONVERSION_CONTRACT } from "./hdr10-pq-conversion-contract.js";
import { createHdr10PqFfmpegCommand, type Hdr10PqFfmpegCommandContract } from "./hdr10-pq-ffmpeg-command.js";

export const HDR10_PQ_FFPROBE_QUERY_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-ffprobe-query@2" as const;
export const HDR10_PQ_FFPROBE_RECEIPT_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-ffprobe-receipt@2" as const;
export const HDR10_PQ_FFPROBE_OBSERVATION_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-ffprobe-observation@1" as const;
export const HDR10_PQ_FFPROBE_QUERY = Object.freeze({
  schema: HDR10_PQ_FFPROBE_QUERY_SCHEMA, executable: "ffprobe", shell: false, launch: "forbidden-no-c2-durable-pipe",
  args: Object.freeze(["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,profile,codec_tag_string,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,chroma_location,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames:stream_side_data=side_data_type,red_x,red_y,green_x,green_y,blue_x,blue_y,white_point_x,white_point_y,min_luminance,max_luminance:format=format_name", "-of", "json", "__shellx_motion_managed_hdr10_output__.mp4"]),
} as const);
export const HDR10_PQ_FFPROBE_PIPE_ARGS = Object.freeze(HDR10_PQ_FFPROBE_QUERY.args.map((arg) => arg === "__shellx_motion_managed_hdr10_output__.mp4" ? "pipe:0" : arg));

export interface Hdr10PqFfprobeReceipt {
  readonly schema: typeof HDR10_PQ_FFPROBE_RECEIPT_SCHEMA;
  readonly commandFingerprint: string;
  readonly conversionSequenceFingerprint: string;
  readonly querySha256: string;
  readonly streamSha256: string;
  readonly fileExistence: "not-established-in-c1";
  readonly launchAuthority: "absent";
  readonly fingerprint: string;
}
export interface Hdr10PqFfprobeObservation { readonly schema: typeof HDR10_PQ_FFPROBE_OBSERVATION_SCHEMA; readonly streamSha256: string; readonly fingerprint: string; }

/** Validates a claimed future C2 result against the inert C1 plan; this neither launches nor proves a file exists. */
export function verifyHdr10PqFfprobeReadback(command: unknown, value: unknown): Hdr10PqFfprobeReceipt | undefined {
  if (!isCommand(command)) return undefined; const observation = verifyHdr10PqFfprobeObservation(value); if (!observation) return undefined;
  const commandValue = command as Hdr10PqFfmpegCommandContract, base = { schema: HDR10_PQ_FFPROBE_RECEIPT_SCHEMA, commandFingerprint: commandValue.fingerprint, conversionSequenceFingerprint: commandValue.receipt.generatedInput.fingerprint, querySha256: canonicalJsonSha256(HDR10_PQ_FFPROBE_QUERY), streamSha256: observation.streamSha256, fileExistence: "not-established-in-c1" as const, launchAuthority: "absent" as const };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Hdr10PqFfprobeReceipt;
}

/** Strictly validates an actual C2 FFprobe observation without claiming file authority. */
export function verifyHdr10PqFfprobeObservation(value: unknown): Hdr10PqFfprobeObservation | undefined {
  if (!record(value) || !keys(value, ["streams", "format"])) return undefined;
  const streams = value.streams, format = value.format;
  if (!Array.isArray(streams) || streams.length !== 1 || !record(streams[0]) || !record(format) || !keys(format, ["format_name"]) || format.format_name !== "mov,mp4,m4a,3gp,3g2,mj2") return undefined;
  const stream = streams[0]!, expected = {
    codec_name: "hevc", profile: "Main 10", codec_tag_string: "hvc1", pix_fmt: "yuv420p10le",
    width: HDR10_PQ_CONVERSION_CONTRACT.source.width, height: HDR10_PQ_CONVERSION_CONTRACT.source.height,
    color_range: "tv", color_space: "bt2020nc", color_transfer: "smpte2084", color_primaries: "bt2020", chroma_location: HDR10_PQ_CONVERSION_CONTRACT.signaling.chromaLocation,
    r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: String(HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount), nb_frames: String(HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount),
  };
  const sideData = stream.side_data_list;
  if (!keys(stream, [...Object.keys(expected), "side_data_list"]) || !Object.entries(expected).every(([key, entry]) => stream[key] === entry) || !Array.isArray(sideData) || sideData.length !== 1 || !record(sideData[0]) || !keys(sideData[0], Object.keys(HDR10_PQ_CONVERSION_CONTRACT.signaling.masteringDisplayFfprobe)) || !Object.entries(HDR10_PQ_CONVERSION_CONTRACT.signaling.masteringDisplayFfprobe).every(([key, entry]) => sideData[0]![key] === entry)) return undefined;
  const base = { schema: HDR10_PQ_FFPROBE_OBSERVATION_SCHEMA, streamSha256: canonicalJsonSha256({ format, stream }) };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Hdr10PqFfprobeObservation;
}

function isCommand(value: unknown): value is Hdr10PqFfmpegCommandContract {
  if (!record(value) || !keys(value, ["schema", "command", "receipt", "fingerprint"]) || typeof value.fingerprint !== "string" || !record(value.receipt)) return false;
  try { const expected = createHdr10PqFfmpegCommand(value.receipt.generatedInput); return value.fingerprint === expected.fingerprint && canonicalJsonSha256({ schema: value.schema, command: value.command, receipt: value.receipt }) === expected.fingerprint; } catch { return false; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
