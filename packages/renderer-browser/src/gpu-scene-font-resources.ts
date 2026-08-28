import { createHash } from "node:crypto";
import {
  gpuSceneTextPrimaryFontFamily,
  compareCodeUnits,
  readVerifiedPackageAsset,
  type GpuScene2dFontResource,
  type GpuScene2dFontResources,
  type MotionFontAsset,
  type MotionPackage
} from "@shellx-motion/core";
import type { GpuSessionFontResource } from "./gpu-runtime-types";

const MAX_FONT_FACES = 32;
const MAX_FONT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_FONT_BYTES = 64 * 1024 * 1024;

export interface PreparedGpuSceneFontResources {
  fonts: GpuScene2dFontResources;
  sessionFonts: readonly GpuSessionFontResource[];
  inputHashes: Readonly<Record<string, string>>;
}

export class GpuSceneFontResourceError extends Error {
  constructor(message: string, readonly layerId?: string) { super(message); this.name = "GpuSceneFontResourceError"; Object.setPrototypeOf(this, GpuSceneFontResourceError.prototype); }
}

/** Reads exact manifest font faces needed by visible text and refuses host-font fallback. */
export async function prepareGpuSceneFontResources(
  pkg: MotionPackage,
  staticResources?: readonly { kind: "image" | "video" | "font" | "browser-surface"; assetRef: string; family?: string }[]
): Promise<PreparedGpuSceneFontResources> {
  const required = new Map<string, string>();
  if (staticResources) {
    for (const resource of staticResources) if (resource.kind === "font") {
      if (!resource.family) throw new GpuSceneFontResourceError(`GPU static font resource ${resource.assetRef} has no font family.`);
      required.set(resource.family.toLowerCase(), resource.assetRef);
    }
  } else for (const layer of pkg.motion.layers) {
    if ((layer.type !== "text" && layer.type !== "caption") || layer.visible === false) continue;
    const family = gpuSceneTextPrimaryFontFamily(pkg.motion, layer);
    if (!family) throw new GpuSceneFontResourceError(`GPU text layer ${layer.id} requires a safe manifest-bound fontFamily.`, layer.id);
    required.set(family.toLowerCase(), layer.id);
  }
  if (required.size === 0) return { fonts: new Map(), sessionFonts: [], inputHashes: Object.freeze({}) };
  const faces = pkg.motion.assets.map(readFontAsset).filter((face): face is MotionFontAsset => face !== null && required.has(face.family.toLowerCase()));
  if (faces.length > MAX_FONT_FACES) throw new Error(`GPU scenes accept at most ${MAX_FONT_FACES} font faces.`);
  const found = new Set(faces.map((face) => face.family.toLowerCase()));
  for (const [family, layerId] of required) if (!found.has(family)) throw new GpuSceneFontResourceError(`GPU text layer ${layerId} font family '${family}' is not backed by a manifest font asset.`, layerId);
  const seenFaces = new Set<string>(); const fonts = new Map<string, GpuScene2dFontResource[]>();
  const sessionFonts: GpuSessionFontResource[] = []; const inputHashes: Record<string, string> = {}; let totalBytes = 0;
  for (const face of faces) {
    const layerId = required.get(face.family.toLowerCase());
    try {
      validateFace(face, pkg);
      const faceKey = `${face.family.toLowerCase()}\0${face.weight ?? 400}\0${face.style ?? "normal"}`;
      if (seenFaces.has(faceKey)) throw new Error(`GPU font face ${face.family} ${face.weight ?? 400} ${face.style ?? "normal"} is duplicated.`);
      seenFaces.add(faceKey);
      const snapshot = await readVerifiedPackageAsset(pkg, face.source.path, { label: `GPU font asset ${face.id}`, maxBytes: MAX_FONT_BYTES });
      if (snapshot.byteLength < 1) throw new Error(`GPU font asset ${face.id} is empty.`);
      totalBytes += snapshot.byteLength; if (totalBytes > MAX_TOTAL_FONT_BYTES) throw new Error("GPU font assets exceed the 64 MiB session budget.");
      const resourceId = `font-${createHash("sha256").update(face.source.path).update("\0").update(snapshot.sha256).digest("hex").slice(0, 24)}`;
      const metadata: GpuScene2dFontResource = { resourceId, assetRef: face.source.path, family: face.family, weight: face.weight ?? 400, style: face.style ?? "normal", mimeType: face.source.mimeType, sha256: snapshot.sha256 };
      const key = face.family.toLowerCase(); fonts.set(key, [...(fonts.get(key) ?? []), metadata]);
      sessionFonts.push({ id: face.id, ...metadata, bytes: snapshot.bytes }); inputHashes[face.source.path] = snapshot.sha256;
    } catch (error) { throw new GpuSceneFontResourceError(error instanceof Error ? error.message : `GPU font asset ${face.id} could not be prepared.`, layerId); }
  }
  for (const [family, values] of fonts) fonts.set(family, values.sort((left, right) => left.weight - right.weight || compareCodeUnits(left.style, right.style) || compareCodeUnits(left.resourceId, right.resourceId)));
  return { fonts, sessionFonts, inputHashes: Object.freeze({ ...inputHashes }) };
}

function readFontAsset(value: unknown): MotionFontAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>; const source = record.source;
  if (record.type !== "font" || !source || typeof source !== "object" || Array.isArray(source)) return null;
  const sourceRecord = source as Record<string, unknown>; const mimeType = sourceRecord.mimeType;
  if (typeof record.id !== "string" || typeof record.family !== "string" || typeof sourceRecord.path !== "string" || (mimeType !== "font/woff2" && mimeType !== "font/woff" && mimeType !== "font/ttf" && mimeType !== "font/otf")) return null;
  return { id: record.id, type: "font", family: record.family, source: { path: sourceRecord.path, mimeType }, ...(typeof record.weight === "number" ? { weight: record.weight } : {}), ...(record.style === "italic" || record.style === "oblique" || record.style === "normal" ? { style: record.style } : {}) };
}

function validateFace(face: MotionFontAsset, pkg: MotionPackage): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(face.id) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(face.family)) throw new Error("GPU font asset identity is invalid.");
  if (!pkg.manifest.assets.includes(face.source.path)) throw new Error(`GPU font asset ${face.id} is not declared in manifest.assets.`);
  if (face.weight !== undefined && (!Number.isInteger(face.weight) || face.weight < 1 || face.weight > 1_000)) throw new Error(`GPU font asset ${face.id} weight is invalid.`);
  const extension = face.source.mimeType === "font/woff2" ? ".woff2" : face.source.mimeType === "font/woff" ? ".woff" : face.source.mimeType === "font/ttf" ? ".ttf" : ".otf";
  if (!face.source.path.toLowerCase().endsWith(extension)) throw new Error(`GPU font asset ${face.id} extension does not match ${face.source.mimeType}.`);
}
