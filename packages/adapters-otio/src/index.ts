import { dirname, extname, join, resolve } from "node:path";
import {
  compareCodeUnits,
  type MotionDocument,
  type MotionLayer,
  type MotionPackage,
  type MotionTrack,
  type OperationReceipt,
  type PackageManifest,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { publishOtioExportOutputs, publishOtioImportPackage, readOtioInterchangeInput, serializeBoundedOtioTimeline } from "./otio-interchange";
import { loadOtioExportInput } from "./otio-export-input.js";
import { addBoundedOtioTimelineTime, assertDistinctOtioLayerId, assertGeneratedOtioPackage, deriveOtioMilliseconds, requireOtioTimeRange, requirePositiveOtioDuration } from "./otio-import-admission.js";

export interface OtioExportOptions {
  packageRoot: string;
  outPath: string;
  createdAt?: string;
}

export interface OtioExportResult {
  ok: true;
  packageId: string;
  otioPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
  otioSha256: string;
  trackCount: number;
  clipCount: number;
  gapCount: number;
  warningCount: number;
  artifacts: ReceiptArtifact[];
  warnings: string[];
}

export interface OtioImportOptions {
  otioPath: string;
  packageDir: string;
  createdAt?: string;
  createdBy?: string;
}

export interface OtioImportResult {
  ok: true;
  packageDir: string;
  packageId: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
  layerCount: number;
  warningCount: number;
  artifacts: ReceiptArtifact[];
  warnings: string[];
}

interface OtioLossinessFinding {
  path: string;
  feature: string;
  reason: string;
}

type JsonRecord = Record<string, unknown>;

const OTIO_MEDIA_TYPE = "application/vnd.opentimelineio+json";
const MOTION_PACKAGE_MEDIA_TYPE = "application/vnd.shellx.motion.package";

export async function exportMotionPackageToOtio(options: OtioExportOptions): Promise<OtioExportResult> {
  const { pkg, inputHashes } = await loadOtioExportInput(options.packageRoot);
  const otioPath = resolve(options.outPath);
  const { timeline, warnings, clipCount, gapCount } = buildOtioTimeline(pkg);
  const { timelineJson, otioSha256 } = serializeBoundedOtioTimeline(timeline);

  const receiptPath = `${otioPath}.receipt.json`;
  const artifacts: ReceiptArtifact[] = [
    { role: "otio_timeline", path: otioPath, status: "available", mediaType: OTIO_MEDIA_TYPE, primary: true },
    { role: "otio_export_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `otio-export-${pkg.manifest.id}-${otioSha256.slice(0, 16)}`,
    operation: "otio.export",
    status: warnings.length > 0 ? "warning" : "passed",
    packageId: pkg.manifest.id,
    inputHashes: {
      "manifest.json": inputHashes["manifest.json"],
      [pkg.manifest.motion]: inputHashes[pkg.manifest.motion]
    },
    createdAt: options.createdAt ?? new Date().toISOString(),
    lane: "otio",
    output: {
      otioPath,
      otioSha256,
      trackCount: timeline.tracks.children.length,
      clipCount,
      gapCount,
      warningCount: warnings.length,
      lossiness: { unsupported: warnings }
    },
    artifacts,
    warnings: warnings.map((warning) => `${warning.path}: ${warning.reason}`)
  };
  await publishOtioExportOutputs({ otioPath, receiptPath, timelineJson, receiptJson: serializeJson(receipt) });

  return {
    ok: true,
    packageId: pkg.manifest.id,
    otioPath,
    receiptPath,
    receipt,
    otioSha256,
    trackCount: timeline.tracks.children.length,
    clipCount,
    gapCount,
    warningCount: warnings.length,
    artifacts,
    warnings: receipt.warnings
  };
}

export async function importOtioTimelineToMotionPackage(options: OtioImportOptions): Promise<OtioImportResult> {
  const otioPath = resolve(options.otioPath);
  const packageDir = resolve(options.packageDir);
  const otioInput = await readOtioInterchangeInput(otioPath);
  const timeline = parseOtioTimeline(JSON.parse(otioInput.bytes.toString("utf8")));
  const imported = convertOtioTimelineToMotionPackage(timeline, {
    createdBy: options.createdBy ?? "otio-adapter"
  });
  await assertGeneratedOtioPackage(imported.manifest, imported.motion);

  const manifestPath = join(packageDir, "manifest.json");
  const motionPath = join(packageDir, imported.manifest.motion);
  const receiptPath = join(packageDir, "receipts", "otio-import.receipt.json");
  const artifacts: ReceiptArtifact[] = [
    { role: "motion_package", path: packageDir, status: "available", mediaType: MOTION_PACKAGE_MEDIA_TYPE, primary: true },
    { role: "otio_import_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `otio-import-${imported.manifest.id}`,
    operation: "otio.import",
    status: imported.lossiness.length > 0 ? "warning" : "passed",
    packageId: imported.manifest.id,
    inputHashes: {
      [otioPath]: otioInput.sha256
    },
    createdAt: options.createdAt ?? new Date().toISOString(),
    lane: "otio",
    output: {
      otioPath,
      motionPath,
      trackCount: imported.motion.tracks?.length ?? 0,
      layerCount: imported.motion.layers.length,
      warningCount: imported.lossiness.length,
      lossiness: { unsupported: imported.lossiness }
    },
    artifacts,
    warnings: imported.lossiness.map((warning) => `${warning.path}: ${warning.reason}`)
  };

  await publishOtioImportPackage({
    packageDir,
    manifestJson: serializeJson(imported.manifest),
    motionFileName: imported.manifest.motion,
    motionJson: serializeJson(imported.motion),
    receiptJson: serializeJson(receipt)
  });

  return {
    ok: true,
    packageDir,
    packageId: imported.manifest.id,
    manifestPath,
    motionPath,
    receiptPath,
    receipt,
    layerCount: imported.motion.layers.length,
    warningCount: imported.lossiness.length,
    artifacts,
    warnings: receipt.warnings
  };
}

function buildOtioTimeline(pkg: MotionPackage): {
  timeline: OtioTimeline;
  warnings: OtioLossinessFinding[];
  clipCount: number;
  gapCount: number;
} {
  const warnings: OtioLossinessFinding[] = [];
  let clipCount = 0;
  let gapCount = 0;
  const rate = pkg.motion.fps;
  const trackGroups = motionTrackGroups(pkg.motion);
  const tracks: OtioTrack[] = trackGroups.map((track): OtioTrack => {
    let cursorMs = 0;
    const children: OtioTrackChild[] = [];
    // Code-unit order, not localeCompare: this tie-break decides clip order INSIDE the emitted
    // OTIO JSON, so it is written into the file bytes that otioSha256 hashes and that the receipt
    // id embeds. Layer ids are ASCII by schema, which is not enough — tr-TR collates "I" and "i"
    // differently from every other locale, and a live probe moved the export hash because of it.
    for (const layer of track.layers.sort((left, right) => left.startMs - right.startMs || compareCodeUnits(left.id, right.id))) {
      if (layer.startMs > cursorMs) {
        children.push(otioGap(layer.startMs - cursorMs, rate));
        gapCount += 1;
      }
      const clip = motionLayerToOtioClip(layer, rate);
      if (!clip) {
        warnings.push({
          path: `motion.layers.${layer.id}`,
          feature: `layer.type.${layer.type}`,
          reason: "Motion layer type is not mapped to OTIO yet."
        });
      } else {
        children.push(clip);
        clipCount += 1;
      }
      cursorMs = Math.max(cursorMs, layer.startMs + layer.durationMs);
    }
    return {
      OTIO_SCHEMA: "Track.1",
      name: track.name,
      kind: track.kind,
      metadata: {
        shellx_motion: {
          trackId: track.id,
          trackType: track.type
        }
      },
      children
    };
  });

  return {
    timeline: {
      OTIO_SCHEMA: "Timeline.1",
      name: pkg.motion.name,
      metadata: {
        shellx_motion: {
          schema: "shellx-motion/otio-export@1",
          packageId: pkg.manifest.id,
          motionId: pkg.motion.id,
          width: pkg.motion.width,
          height: pkg.motion.height,
          fps: pkg.motion.fps,
          durationMs: pkg.motion.durationMs
        }
      },
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: tracks
      }
    },
    warnings,
    clipCount,
    gapCount
  };
}

function motionTrackGroups(motion: MotionDocument): Array<{ id: string; name: string; type: string; kind: "Video" | "Audio"; layers: MotionLayer[] }> {
  const byTrackId = new Map<string, MotionLayer[]>();
  for (const layer of motion.layers) {
    const trackId = layer.trackId ?? (layer.type === "audio" ? "audio" : "video");
    const layers = byTrackId.get(trackId) ?? [];
    layers.push(layer);
    byTrackId.set(trackId, layers);
  }
  const declared = (motion.tracks ?? [])
    .slice()
    // Code-unit order, not localeCompare: same contract as the clip sort above, one level up —
    // this fixes TRACK order in the emitted OTIO. Track ids are not restricted to ASCII, so this
    // site diverged between en-US and sv-SE on ordinary data (a live probe: 155cf43c… vs ca39d05f…).
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || compareCodeUnits(left.id, right.id))
    .flatMap((track) => {
      const layers = layersForDeclaredTrack(track, motion.layers, byTrackId);
      if (layers.length === 0) return [];
      return [trackGroup(track, layers)];
    });
  const declaredIds = new Set(declared.map((track) => track.id));
  const generated = [...byTrackId.entries()]
    .filter(([trackId]) => !declaredIds.has(trackId))
    .map(([trackId, layers]) => trackGroup({ id: trackId, type: trackId === "audio" ? "audio" : "video", name: titleCase(trackId) }, layers));
  return [...declared, ...generated];
}

function layersForDeclaredTrack(track: MotionTrack, layers: MotionLayer[], byTrackId: Map<string, MotionLayer[]>): MotionLayer[] {
  if (track.layerIds?.length) {
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    return track.layerIds.flatMap((id) => {
      const layer = byId.get(id);
      return layer ? [layer] : [];
    });
  }
  return byTrackId.get(track.id) ?? [];
}

function trackGroup(track: Pick<MotionTrack, "id" | "type" | "name">, layers: MotionLayer[]): { id: string; name: string; type: string; kind: "Video" | "Audio"; layers: MotionLayer[] } {
  const type = track.type ?? "video";
  const kind = type === "audio" || layers.every((layer) => layer.type === "audio") ? "Audio" : "Video";
  return {
    id: track.id,
    name: track.name ?? titleCase(track.id),
    type,
    kind,
    layers
  };
}

function motionLayerToOtioClip(layer: MotionLayer, rate: number): OtioClip | null {
  const mediaReference = mediaReferenceForLayer(layer);
  if (!mediaReference) return null;
  return {
    OTIO_SCHEMA: "Clip.2",
    name: layer.name ?? layer.id,
    media_reference: mediaReference,
    source_range: {
      OTIO_SCHEMA: "TimeRange.1",
      start_time: rationalTime(layer.trimStartMs ?? 0, rate),
      duration: rationalTime(layer.trimDurationMs ?? layer.durationMs, rate)
    },
    metadata: {
      shellx_motion: cleanJson({
        layerId: layer.id,
        layerType: layer.type,
        startMs: layer.startMs,
        durationMs: layer.durationMs,
        text: layer.text,
        shape: layer.shape,
        source: layer.source ?? layer.src ?? layer.assetRef,
        transform: layer.transform,
        style: layer.style,
        opacity: layer.opacity,
        volume: layer.volume,
        pan: layer.pan,
        muted: layer.muted,
        playbackRate: layer.playbackRate,
        trimStartMs: layer.trimStartMs,
        trimDurationMs: layer.trimDurationMs
      })
    }
  };
}

function mediaReferenceForLayer(layer: MotionLayer): OtioMediaReference | null {
  const source = layer.source ?? layer.src ?? layer.assetRef;
  if (layer.type === "image" || layer.type === "video" || layer.type === "audio") {
    return {
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: source ?? "",
      available_range: null,
      metadata: {
        shellx_motion: {
          layerType: layer.type
        }
      }
    };
  }
  if (layer.type === "text" || layer.type === "caption" || layer.type === "shape") {
    return {
      OTIO_SCHEMA: "GeneratorReference.1",
      generator_kind: `shellx-motion-${layer.type}`,
      parameters: cleanJson({
        text: layer.text,
        shape: layer.shape,
        fill: layer.fill,
        color: layer.color,
        style: layer.style
      }),
      metadata: {
        shellx_motion: {
          layerType: layer.type
        }
      }
    };
  }
  return null;
}

function convertOtioTimelineToMotionPackage(timeline: OtioTimeline, options: { createdBy: string }): {
  manifest: PackageManifest;
  motion: MotionDocument;
  lossiness: OtioLossinessFinding[];
} {
  const timelineMeta = readRecord(timeline.metadata?.shellx_motion);
  const fps = readPositiveNumber(timelineMeta?.fps) ?? firstTimelineRate(timeline) ?? 24;
  const width = readPositiveNumber(timelineMeta?.width) ?? 1920;
  const height = readPositiveNumber(timelineMeta?.height) ?? 1080;
  const slug = slugId(timeline.name);
  const packageId = `pkg_otio_${slug}`;
  const motionId = `motion_otio_${slug}`;
  const layers: MotionLayer[] = [];
  const tracks: MotionTrack[] = [];
  const lossiness: OtioLossinessFinding[] = [];
  const trackKindCounts: Record<"audio" | "video", number> = { audio: 0, video: 0 };
  const seenLayerIds = new Set<string>();

  for (const [trackIndex, track] of timeline.tracks.children.entries()) {
    const trackKind = track.kind === "Audio" ? "audio" : "video";
    trackKindCounts[trackKind] += 1;
    const trackId = `track_${trackKind}_${trackKindCounts[trackKind]}`;
    let cursorMs = 0;
    const layerIds: string[] = [];
    for (const [itemIndex, item] of track.children.entries()) {
      const path = `tracks.children[${trackIndex}].children[${itemIndex}]`;
      const schema = readString(item.OTIO_SCHEMA);
      if (schema === "Gap.1") {
        const gap = parseOtioGap(item, path);
        cursorMs = addBoundedOtioTimelineTime(cursorMs, requirePositiveOtioDuration(gap.source_range.duration, `${path}.source_range.duration`), path);
        continue;
      }
      if (schema !== "Clip.2") {
        lossiness.push({
          path,
          feature: readString(item.OTIO_SCHEMA) ?? "unknown",
          reason: "OTIO item type is not mapped to MotionIR yet."
        });
        continue;
      }
      const clip = parseOtioClip(item, path);
      const layer = otioClipToMotionLayer(clip, {
        trackId,
        trackKind,
        startMs: cursorMs,
        fallbackIndex: layers.length,
        path
      });
      assertDistinctOtioLayerId(seenLayerIds, layer.id, path);
      seenLayerIds.add(layer.id);
      layers.push(layer);
      layerIds.push(layer.id);
      cursorMs = addBoundedOtioTimelineTime(cursorMs, layer.durationMs, path);
    }
    tracks.push({
      id: trackId,
      type: trackKind,
      name: track.name || `${titleCase(trackKind)} ${trackIndex + 1}`,
      order: trackIndex,
      layerIds
    });
  }

  const durationMs = Math.max(0, ...layers.map((layer) => layer.startMs + layer.durationMs));
  const assets = uniqueStrings(layers.flatMap((layer) => {
    const source = layer.source ?? layer.src ?? layer.assetRef;
    return source && isPackageAssetRef(source) ? [source] : [];
  }));
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: motionId,
    name: timeline.name,
    durationMs,
    fps,
    width,
    height,
    tracks,
    layers,
    assets: [],
    provenance: {
      sourceApp: "opentimelineio",
      createdBy: options.createdBy,
      workflow: "otio-import",
      sourceSchema: timeline.OTIO_SCHEMA
    }
  };
  const manifest: PackageManifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name: timeline.name,
    motion: "motion.json",
    assets,
    sourceApp: "opentimelineio",
    compatibility: {
      lanes: ["otio", "browser", "ffmpeg"],
      hosts: ["shellx-motion", "shellx-cut"]
    },
    workflow: "otio-import"
  };
  return { manifest, motion, lossiness };
}

function otioClipToMotionLayer(clip: OtioClip, options: { trackId: string; trackKind: "audio" | "video"; startMs: number; fallbackIndex: number; path: string }): MotionLayer {
  const meta = readRecord(clip.metadata?.shellx_motion);
  const media = readRecord(clip.media_reference);
  const targetUrl = readString(media?.target_url);
  const layerType = readString(meta?.layerType) ?? inferLayerType(options.trackKind, media, targetUrl);
  const id = readString(meta?.layerId) ?? slugId(clip.name || `clip_${options.fallbackIndex + 1}`);
  const sourceRange = clip.source_range;
  const trimStartMs = deriveOtioMilliseconds(sourceRange.start_time, `${options.path}.source_range.start_time`);
  const durationMs = requirePositiveOtioDuration(sourceRange.duration, `${options.path}.source_range.duration`);
  const transform = readMotionTransform(meta?.transform);
  const style = readRecord(meta?.style) ?? undefined;
  const layer: MotionLayer = {
    id,
    name: clip.name || id,
    type: layerType,
    trackId: options.trackId,
    startMs: options.startMs,
    durationMs,
    ...(targetUrl ? { source: targetUrl } : {}),
    ...(trimStartMs > 0 ? { trimStartMs } : {}),
    ...(transform ? { transform } : {}),
    ...(style ? { style } : {}),
    ...(readString(meta?.text) ? { text: readString(meta?.text) } : {}),
    ...(readString(meta?.shape) ? { shape: readString(meta?.shape) } : {}),
    ...(readNumber(meta?.volume) !== undefined ? { volume: readNumber(meta?.volume) } : {}),
    ...(readNumber(meta?.pan) !== undefined ? { pan: readNumber(meta?.pan) } : {}),
    ...(typeof meta?.muted === "boolean" ? { muted: meta.muted } : {})
  };
  return layer;
}

function parseOtioTimeline(input: unknown): OtioTimeline {
  const root = expectRecord(input, "OTIO timeline");
  const schema = expectString(root, "OTIO_SCHEMA", "OTIO timeline");
  if (schema !== "Timeline.1") throw new Error(`Unsupported OTIO timeline schema: ${schema}`);
  const tracks = expectRecord(root.tracks, "OTIO timeline.tracks");
  const children = expectArray(tracks, "children", "OTIO timeline.tracks").map((track, index) => parseOtioTrack(track, `tracks.children[${index}]`));
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: readString(root.name) ?? "Untitled Timeline",
    metadata: readRecord(root.metadata) ?? {},
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children
    }
  };
}

function parseOtioTrack(input: unknown, path: string): OtioTrack {
  const track = expectRecord(input, path);
  const children = expectArray(track, "children", path).map((item, index) => parseOtioTrackChild(item, `${path}.children[${index}]`));
  return {
    OTIO_SCHEMA: "Track.1",
    name: readString(track.name) ?? "",
    kind: readString(track.kind) === "Audio" ? "Audio" : "Video",
    metadata: readRecord(track.metadata) ?? {},
    children
  };
}

function parseOtioTrackChild(input: unknown, path: string): OtioTrackChild {
  const item = expectRecord(input, path);
  const schema = readString(item.OTIO_SCHEMA);
  if (schema === "Gap.1") return parseOtioGap(item, path);
  if (schema === "Clip.2") return parseOtioClip(item, path);
  return item;
}

function parseOtioGap(input: JsonRecord, path: string): OtioGap {
  return {
    OTIO_SCHEMA: "Gap.1",
    source_range: parseOtioTimeRange(input.source_range, `${path}.source_range`)
  };
}

function parseOtioClip(input: JsonRecord, path: string): OtioClip {
  return {
    OTIO_SCHEMA: "Clip.2",
    name: readString(input.name) ?? "",
    media_reference: parseOtioMediaReference(input.media_reference, `${path}.media_reference`),
    source_range: parseOtioTimeRange(input.source_range, `${path}.source_range`),
    metadata: readRecord(input.metadata) ?? {}
  };
}

function parseOtioMediaReference(input: unknown, path: string): OtioMediaReference {
  const record = expectRecord(input, path);
  const schema = expectString(record, "OTIO_SCHEMA", path);
  if (schema === "ExternalReference.1") {
    return { ...record, OTIO_SCHEMA: "ExternalReference.1" };
  }
  if (schema === "GeneratorReference.1") {
    return { ...record, OTIO_SCHEMA: "GeneratorReference.1" };
  }
  throw new Error(`Unsupported OTIO media reference schema at ${path}: ${schema}`);
}

function parseOtioTimeRange(input: unknown, path: string): OtioTimeRange {
  const range = requireOtioTimeRange(input, path);
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: { OTIO_SCHEMA: "RationalTime.1", ...range.start_time },
    duration: { OTIO_SCHEMA: "RationalTime.1", ...range.duration }
  };
}

function otioGap(durationMs: number, rate: number): OtioGap {
  return {
    OTIO_SCHEMA: "Gap.1",
    source_range: {
      OTIO_SCHEMA: "TimeRange.1",
      start_time: rationalTime(0, rate),
      duration: rationalTime(durationMs, rate)
    }
  };
}

function rationalTime(ms: number, rate: number): OtioRationalTime {
  return {
    OTIO_SCHEMA: "RationalTime.1",
    value: Math.round((ms / 1000) * rate * 1000) / 1000,
    rate
  };
}


function firstTimelineRate(timeline: OtioTimeline): number | undefined {
  for (const track of timeline.tracks.children) {
    for (const child of track.children) {
      const range = readRecord(child.source_range);
      const duration = readRecord(range?.duration);
      const rate = readPositiveNumber(duration?.rate);
      if (rate) return rate;
    }
  }
  return undefined;
}

function inferLayerType(trackKind: "audio" | "video", media: JsonRecord | null, targetUrl: string | undefined): string {
  if (trackKind === "audio") return "audio";
  const generatorKind = readString(media?.generator_kind);
  if (generatorKind?.startsWith("shellx-motion-")) return generatorKind.replace("shellx-motion-", "");
  const ext = targetUrl ? extname(targetUrl).toLowerCase() : "";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "image";
  if ([".wav", ".mp3", ".aac", ".m4a", ".flac", ".ogg"].includes(ext)) return "audio";
  return "video";
}

function readMotionTransform(value: unknown): MotionLayer["transform"] | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const parsed: NonNullable<MotionLayer["transform"]> = {};
  for (const key of ["x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"] as const) {
    const number = readNumber(record[key]);
    if (number !== undefined) parsed[key] = number;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function cleanJson(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isPackageAssetRef(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("..")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function slugId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "untitled";
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function expectRecord(input: unknown, path: string): JsonRecord {
  const record = readRecord(input);
  if (record) return record;
  throw new Error(`${path} must be an object.`);
}

function expectArray(input: JsonRecord, key: string, path: string): unknown[] {
  const value = input[key];
  if (Array.isArray(value)) return value;
  throw new Error(`${path}.${key} must be an array.`);
}

function expectString(input: JsonRecord, key: string, path: string): string {
  const value = input[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${path}.${key} must be a non-empty string.`);
}

function readRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  const number = readNumber(value);
  return number && number > 0 ? number : undefined;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface OtioTimeline {
  OTIO_SCHEMA: "Timeline.1";
  name: string;
  metadata: JsonRecord;
  tracks: {
    OTIO_SCHEMA: "Stack.1";
    children: OtioTrack[];
  };
}

interface OtioTrack {
  OTIO_SCHEMA: "Track.1";
  name: string;
  kind: "Video" | "Audio";
  metadata?: JsonRecord;
  children: OtioTrackChild[];
}

type OtioTrackChild = OtioClip | OtioGap | JsonRecord;

interface OtioClip extends JsonRecord {
  OTIO_SCHEMA: "Clip.2";
  name: string;
  media_reference: OtioMediaReference;
  source_range: OtioTimeRange;
  metadata: JsonRecord;
}

interface OtioGap extends JsonRecord {
  OTIO_SCHEMA: "Gap.1";
  source_range: OtioTimeRange;
}

interface OtioTimeRange extends JsonRecord {
  OTIO_SCHEMA: "TimeRange.1";
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

interface OtioRationalTime extends JsonRecord {
  OTIO_SCHEMA: "RationalTime.1";
  value: number;
  rate: number;
}

type OtioMediaReference = JsonRecord & {
  OTIO_SCHEMA: "ExternalReference.1" | "GeneratorReference.1";
};
