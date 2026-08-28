/**
 * Final encode accepts only one self-contained package-local media file per audio input.
 *
 * FFmpeg's file protocol does not make a playlist safe: a trusted outer `.m3u`/concat file can
 * name another absolute or parent-relative file after FFmpeg has crossed our path guard.  v0.2
 * intentionally does not implement every playlist grammar. v0.2 admits only data-only audio
 * formats whose fixed demuxers cannot carry nested source references. It refuses every
 * reference-capable container before an FFmpeg command is started.
 */
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FfmpegMediaInputInspection } from "./ffmpeg-media-input-snapshot-types.js";
const SELF_CONTAINED_MEDIA_EXTENSIONS = new Set([
  ".flac", ".mp3", ".oga", ".ogg", ".opus", ".wav"
]);

export class FfmpegMediaInputRefusal extends Error {
  readonly code = "unsafe_input_path";
  constructor(message: string) {
    super(message);
    this.name = "FfmpegMediaInputRefusal";
    Object.setPrototypeOf(this, FfmpegMediaInputRefusal.prototype);
  }
}

const SELF_CONTAINED_FFMPEG_DEMUXERS: Readonly<Record<string, string>> = {
  ".flac": "flac", ".mp3": "mp3", ".oga": "ogg", ".ogg": "ogg", ".opus": "ogg", ".wav": "wav"
};

/**
 * The exact FFmpeg-generated delivery containers which the quality reader can inspect.
 *
 * This is deliberately an allow-list derived from the renderer's delivery presets plus WAV for
 * standalone audio quality checks. It is not a media-sniffing parser: FFmpeg receives one fixed
 * demuxer for the selected suffix. MOV/MP4 additionally disable their explicit data-reference
 * feature. This v0.2 WebM decision is bound to FFmpeg n6.1 and current upstream: their Matroska
 * demuxer does not perform a secondary open for linked segments or ordered chapters.
 */
const QUALITY_FFMPEG_DEMUXERS: Readonly<Record<string, string>> = {
  ".gif": "gif", ".jpeg": "image2", ".jpg": "image2", ".mov": "mov", ".mp4": "mov", ".wav": "wav", ".webm": "matroska"
};

const QUALITY_DELIVERY_FORMATS = "MP4, WebM, MOV, GIF, JPEG, or WAV";

/** Self-contained video containers accepted by tracking analysis. */
const TRACKING_FFMPEG_DEMUXERS: Readonly<Record<string, string>> = {
  ".mkv": "matroska", ".mov": "mov", ".mp4": "mov", ".webm": "matroska"
};

/**
 * A process-private FFmpeg input copy. The caller must retain it until every FFmpeg/FFprobe
 * read and receipt hash that belongs to the operation has completed, then call {@link release}.
 *
 * Media admission used to prove a live path and release it to a later subprocess open. A private
 * content-addressed copy makes the bytes handed to every subprocess and the receipt hash one
 * immutable artifact instead. This is intentionally bounded: final render sources and quality
 * inputs are local, single-file media, not a general-purpose file-copy channel.
 */
/**
 * Matches the product's default 16 GiB attested-artifact bound: private snapshots must accept
 * every supported final delivery that Motion can attest, while still bounding copy work and disk.
 */
export const MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES = 64 * 1024 * 1024 * 1024;

/** Structural media admission for aggregate callers; this does not copy bytes or invoke FFmpeg. */
export async function inspectSelfContainedFfmpegMediaInput(
  input: string,
  inputRoots: readonly string[],
  kind: "final-audio" | "quality" | "tracking-video"
): Promise<FfmpegMediaInputInspection> {
  const roots = await canonicalMediaRoots(inputRoots, kind);
  const admitted = await assertCanonicalRegularMediaInput(input, roots,
    kind === "quality" ? "FFmpeg quality input" : kind === "tracking-video" ? "FFmpeg tracking input" : "FFmpeg media input");
  if (kind === "final-audio") {
    const extension = extname(input).toLowerCase();
    if (!SELF_CONTAINED_MEDIA_EXTENSIONS.has(extension)) {
      throw new FfmpegMediaInputRefusal("FFmpeg v0.2 final audio accepts only WAV, FLAC, MP3, Ogg, or Opus package files; M4A/MP4/MOV/Matroska/WebM, playlists, manifests, and reference-bearing formats are refused.");
    }
  } else if (kind === "quality" && !QUALITY_FFMPEG_DEMUXERS[extname(input).toLowerCase()]) {
    throw new FfmpegMediaInputRefusal(`FFmpeg quality checks accept only ${QUALITY_DELIVERY_FORMATS} delivery files.`);
  } else if (kind === "tracking-video" && !TRACKING_FFMPEG_DEMUXERS[extname(input).toLowerCase()]) {
    throw new FfmpegMediaInputRefusal("FFmpeg tracking accepts only self-contained MP4, MOV, Matroska, or WebM package video files.");
  }

  const source = await open(admitted.path, "r");
  try {
    const before = await source.stat();
    const limit = kind === "tracking-video" ? MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES : MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES;
    if (!before.isFile() || before.dev !== admitted.dev || before.ino !== admitted.ino || before.size < 1 || before.size > limit) {
      throw new FfmpegMediaInputRefusal(`FFmpeg ${kind === "quality" ? "quality input" : kind === "tracking-video" ? "tracking input" : "media input"} must contain 1..${limit} bytes.`);
    }
    return { sourcePath: input, path: admitted.path, byteLength: before.size, device: before.dev, inode: before.ino };
  } finally {
    await source.close().catch(() => undefined);
  }
}

export { snapshotSelfContainedFfmpegMediaInput } from "./ffmpeg-media-input-snapshot.js";
export type { FfmpegMediaInputInspection, FfmpegMediaInputSnapshot, FfmpegMediaInputSnapshotOptions } from "./ffmpeg-media-input-snapshot-types.js";

/** Prove every FFmpeg media input is a canonical regular file inside a configured input root. */
export async function assertSelfContainedFfmpegMediaInputs(
  paths: readonly string[],
  inputRoots: readonly string[]
): Promise<void> {
  if (paths.length === 0) return;
  const roots = await canonicalMediaRoots(inputRoots, "final-audio");
  for (const path of paths) await assertSelfContainedMediaInput(path, roots);
}

/** Prove a quality-check delivery input is a stable, package-local regular file of an expected format. */
export async function assertQualityFfmpegMediaInput(input: string, inputRoots: readonly string[]): Promise<void> {
  const roots = await canonicalMediaRoots(inputRoots, "quality");
  const extension = extname(input).toLowerCase();
  if (!QUALITY_FFMPEG_DEMUXERS[extension]) {
    throw new FfmpegMediaInputRefusal(`FFmpeg quality checks accept only ${QUALITY_DELIVERY_FORMATS} delivery files.`);
  }
  await assertCanonicalRegularMediaInput(input, roots, "FFmpeg quality input");
}

async function assertSelfContainedMediaInput(input: string, roots: readonly string[]): Promise<void> {
  if (!input || input.trim() !== input || input.startsWith("-") || hasProtocolScheme(input)) {
    throw new FfmpegMediaInputRefusal("Unsafe FFmpeg media input path.");
  }
  const extension = extname(input).toLowerCase();
  if (!SELF_CONTAINED_MEDIA_EXTENSIONS.has(extension)) {
    throw new FfmpegMediaInputRefusal("FFmpeg v0.2 final audio accepts only WAV, FLAC, MP3, Ogg, or Opus package files; M4A/MP4/MOV/Matroska/WebM, playlists, manifests, and reference-bearing formats are refused.");
  }
  await assertCanonicalRegularMediaInput(input, roots, "FFmpeg media input");
  // The command fixes both the protocol and the one data-only demuxer for this suffix. A later
  // replacement of this pathname cannot acquire a playlist, concat, ISO-BMFF, or EBML grammar:
  // FFmpeg will either parse the same reference-free format or fail. Reference-capable formats
  // are deliberately refused above, avoiding a scan-then-reopen content TOCTOU entirely.
}

/** Fixed FFmpeg input options: the admitted suffix selects one data-only demuxer family. */
export function selfContainedFfmpegMediaInputArgs(path: string): string[] {
  const demuxers = SELF_CONTAINED_FFMPEG_DEMUXERS[extname(path).toLowerCase()];
  if (!demuxers) throw new FfmpegMediaInputRefusal("FFmpeg v0.2 final audio accepts only WAV, FLAC, MP3, Ogg, or Opus package files; M4A/MP4/MOV/Matroska/WebM and reference-bearing formats are refused.");
  return ["-protocol_whitelist", "file", "-format_whitelist", demuxers, "-i", path];
}

/**
 * Fixed FFmpeg/FFprobe options for one admitted delivery input.
 *
 * `-protocol_whitelist file` rejects network, concat, and pipe protocols. The exact demuxer avoids
 * parser auto-selection. JPEG uses image2 with pattern matching disabled so the admitted pathname
 * remains the only input. MOV/MP4 expose explicit data-reference controls, which are disabled here
 * (including absolute paths). WebM admission is intentionally pinned to FFmpeg n6.1/current
 * upstream's non-link-opening Matroska demuxer rather than an in-project partial EBML parser.
 */
export function qualityFfmpegMediaInputArgs(path: string): string[] {
  const extension = extname(path).toLowerCase();
  const demuxer = QUALITY_FFMPEG_DEMUXERS[extension];
  if (!demuxer) throw new FfmpegMediaInputRefusal(`FFmpeg quality checks accept only ${QUALITY_DELIVERY_FORMATS} delivery files.`);
  return [
    "-protocol_whitelist", "file",
    "-format_whitelist", demuxer,
    ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    ...(demuxer === "image2" ? ["-f", "image2", "-pattern_type", "none"] : []),
    "-i", path
  ];
}

/** Fixed file-only FFmpeg/FFprobe options for one immutable tracking-video snapshot. */
export function trackingFfmpegMediaInputArgs(path: string): string[] {
  const demuxer = TRACKING_FFMPEG_DEMUXERS[extname(path).toLowerCase()];
  if (!demuxer) throw new FfmpegMediaInputRefusal("FFmpeg tracking accepts only self-contained MP4, MOV, Matroska, or WebM package video files.");
  return [
    "-protocol_whitelist", "file",
    "-format_whitelist", demuxer,
    ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-i", path
  ];
}

async function assertCanonicalRegularMediaInput(
  input: string,
  roots: readonly string[],
  label: string
): Promise<{ path: string; dev: number; ino: number }> {
  if (!input || input.trim() !== input || input.startsWith("-") || hasProtocolScheme(input)) {
    throw new FfmpegMediaInputRefusal(`Unsafe ${label.toLowerCase()} path.`);
  }
  const lexical = resolve(input);
  const before = await lstat(lexical).catch(() => {
    throw new FfmpegMediaInputRefusal(`${label} must be an existing regular non-symlink file.`);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new FfmpegMediaInputRefusal(`${label} must be an existing regular non-symlink file.`);
  }
  const canonical = await realpath(lexical).catch(() => {
    throw new FfmpegMediaInputRefusal(`${label} could not be canonicalized safely.`);
  });
  const after = await lstat(canonical).catch(() => {
    throw new FfmpegMediaInputRefusal(`${label} changed while it was being admitted.`);
  });
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || !roots.some((root) => inside(root, canonical))) {
    throw new FfmpegMediaInputRefusal(`${label} must remain a canonical regular file inside a configured input root.`);
  }
  return { path: canonical, dev: after.dev, ino: after.ino };
}

async function canonicalMediaRoots(inputRoots: readonly string[], kind: "final-audio" | "quality" | "tracking-video"): Promise<string[]> {
  const roots = await Promise.all(inputRoots.map(async (root) => await canonicalDirectory(root,
    kind === "quality" ? "FFmpeg quality input root" : kind === "tracking-video" ? "FFmpeg tracking input root" : "FFmpeg media input root")));
  if (roots.length === 0) {
    throw new FfmpegMediaInputRefusal(kind === "quality"
      ? "FFmpeg quality input requires an explicit canonical input root."
      : kind === "tracking-video"
        ? "FFmpeg tracking input requires an explicit canonical package input root."
      : "FFmpeg media inputs require an explicit canonical package input root.");
  }
  return roots;
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  const lexical = resolve(input);
  if (!isAbsolute(input)) throw new FfmpegMediaInputRefusal(`${label} must be absolute.`);
  const before = await lstat(lexical).catch(() => {
    throw new FfmpegMediaInputRefusal(`${label} must be an existing non-symlink directory.`);
  });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new FfmpegMediaInputRefusal(`${label} must be an existing non-symlink directory.`);
  const canonical = await realpath(lexical);
  const after = await lstat(canonical);
  if (canonical !== lexical || !after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new FfmpegMediaInputRefusal(`${label} must remain canonical and non-symlinked.`);
  }
  return canonical;
}

function hasProtocolScheme(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path);
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}
