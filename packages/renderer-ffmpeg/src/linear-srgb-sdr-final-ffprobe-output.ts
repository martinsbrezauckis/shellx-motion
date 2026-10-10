import type { ProbeMediaResult } from "./index.js";

type FfprobeOutput = {
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

/**
 * Parse the one JSON shape requested by Motion's FFprobe command. The caller retains responsibility
 * for admitted input transport and a zero-exit tool result; this parser never opens a path.
 */
export function parseFfprobeOutput(path: string, stdout: string): ProbeMediaResult {
  const parsed = JSON.parse(stdout) as FfprobeOutput;
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
    audio: { present: audioStreams.length > 0, streamCount: audioStreams.length, streams: audioStreams }
  };
}

function parseFps(value: string): number {
  const parts = value.split("/").map(Number);
  const fps = parts.length === 2 ? (parts[1] > 0 ? parts[0] / parts[1] : 0) : parts[0];
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function deliveredFps(stream: { avg_frame_rate?: string; nb_frames?: string | number }, durationMs: number): number {
  const frameCount = parseOptionalNumber(stream.nb_frames);
  if (frameCount !== null && Number.isSafeInteger(frameCount) && frameCount > 0 && durationMs > 0) return frameCount / (durationMs / 1_000);
  return parseFps(stream.avg_frame_rate ?? "0/1");
}

function parseOptionalNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseOptionalDurationMs(value: string | number | undefined): number | null {
  const number = parseOptionalNumber(value);
  return number === null || number < 0 ? null : Math.round(number * 1_000);
}

function alphaMediaFacts(stream: { codec_name?: string; pix_fmt?: string; tags?: Record<string, string | number> }): ProbeMediaResult["alpha"] {
  const pixelFormat = typeof stream.pix_fmt === "string" ? stream.pix_fmt : null;
  const rawMode = stream.tags?.alpha_mode;
  const mode = rawMode === undefined ? null : String(rawMode);
  const hasAlphaPixelFormat = pixelFormat !== null && /(?:^|[^a-z])(?:yuva|rgba|bgra|argb|abgr)/i.test(pixelFormat);
  const hasVp9AlphaMode = stream.codec_name === "vp9" && mode === "1";
  return { present: hasAlphaPixelFormat || hasVp9AlphaMode, mode, pixelFormat, decoder: hasVp9AlphaMode ? "libvpx-vp9" : null };
}
