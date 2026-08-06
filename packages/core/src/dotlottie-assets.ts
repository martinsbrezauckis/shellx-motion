import { compareCodeUnits } from "./canonical-json";
import { hashBuffer } from "./receipts";
import { readDotLottieRecord } from "./dotlottie-json";
import { parseBoundedLottieJson } from "./lottie-json";
import type { DotLottieBundledFont, DotLottieBundledImage, DotLottieLimits } from "./dotlottie-types";
import { findDotLottieFile, readDotLottieZipEntry, type DotLottieZipEntry } from "./dotlottie-zip";

export function readSelectedDotLottieAssets(input: {
  animationText: string;
  version: "1" | "2";
  entries: DotLottieZipEntry[];
  archive: Buffer;
  limits: DotLottieLimits;
}): { images: DotLottieBundledImage[]; fonts: DotLottieBundledFont[] } {
  const animation = parseBoundedLottieJson(input.animationText);
  return {
    images: readImages(animation, input),
    fonts: input.version === "2" ? readFonts(animation, input) : []
  };
}

function readImages(animation: Record<string, unknown>, input: Omit<Parameters<typeof readSelectedDotLottieAssets>[0], "animationText">): DotLottieBundledImage[] {
  const assets = Array.isArray(animation.assets) ? animation.assets.map(readDotLottieRecord).filter(nonNull) : [];
  const referencedIds = new Set<string>();
  for (const layer of selectedCompositionLayers(animation)) {
    if (layer?.ty !== 2) continue;
    const refId = typeof layer.refId === "string" ? layer.refId : null;
    if (!refId) throw new Error("dotLottie image layers require a non-empty string refId.");
    referencedIds.add(refId);
  }
  const prefix = input.version === "2" ? "i" : "images";
  const images: DotLottieBundledImage[] = [];
  const seenPaths = new Set<string>();
  for (const assetId of referencedIds) {
    const matches = assets.filter((candidate) => candidate.id === assetId);
    if (matches.length === 0) throw new Error(`dotLottie image layer references missing asset ${assetId}.`);
    if (matches.length > 1) throw new Error(`dotLottie animation contains duplicate image asset id ${assetId}.`);
    if (!isSafeAssetId(assetId)) throw new Error(`dotLottie image asset id ${assetId} is unsafe.`);
    const asset = matches[0];
    if (asset.e !== undefined && asset.e !== 0) throw new Error(`dotLottie image asset ${assetId} must use an extracted archive file.`);
    const fileName = typeof asset.p === "string" ? asset.p : "";
    const directory = typeof asset.u === "string" ? asset.u : "";
    const width = positiveImageDimension(asset.w, assetId, "width");
    const height = positiveImageDimension(asset.h, assetId, "height");
    const archivePath = normalizeArchiveAssetPath(prefix, `${directory}${fileName}`, `image asset ${assetId}`);
    if (seenPaths.has(archivePath)) throw new Error(`dotLottie selected animation references image ${archivePath} more than once.`);
    seenPaths.add(archivePath);
    const entry = findDotLottieFile(input.entries, archivePath);
    if (!entry) throw new Error(`dotLottie image asset ${assetId} is missing ${archivePath}.`);
    const bytes = readDotLottieZipEntry(input.archive, entry, input.limits);
    images.push({ assetId, archivePath, bytes, sha256: hashBuffer(bytes), mimeType: verifiedImageMimeType(archivePath, bytes), width, height });
  }
  // Code-unit order, not localeCompare: bundled-asset order is carried into the lowered motion
  // document and into the receipt asset arrays that the import hashes.
  return images.sort((left, right) => compareCodeUnits(left.assetId, right.assetId));
}

function readFonts(animation: Record<string, unknown>, input: Omit<Parameters<typeof readSelectedDotLottieAssets>[0], "animationText">): DotLottieBundledFont[] {
  const fontList = readDotLottieRecord(animation.fonts)?.list;
  const referencedNames = referencedFontNames(animation);
  if (referencedNames.size === 0) return [];
  if (fontList === undefined) return [];
  if (!Array.isArray(fontList) || fontList.length > 32) throw new Error("dotLottie selected animation supports at most 32 bundled fonts.");
  const fonts: DotLottieBundledFont[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (const [index, value] of fontList.entries()) {
    const font = readDotLottieRecord(value);
    if (!font) throw new Error(`dotLottie font ${index} must be an object.`);
    const fontName = readSafeFontString(font.fName, `font ${index} name`);
    if (!referencedNames.has(fontName)) continue;
    const fontFamily = readSafeFontString(font.fFamily, `font ${fontName} family`);
    if (seenNames.has(fontName)) throw new Error(`dotLottie selected animation contains duplicate font name ${fontName}.`);
    seenNames.add(fontName);
    const fontPath = typeof font?.fPath === "string" ? font.fPath : "";
    const archivePath = normalizeArchiveAssetPath("f", fontPath, `font ${fontName}`);
    if (seenPaths.has(archivePath)) throw new Error(`dotLottie selected animation references font ${archivePath} more than once.`);
    seenPaths.add(archivePath);
    const entry = findDotLottieFile(input.entries, archivePath);
    if (!entry) throw new Error(`dotLottie font ${fontName} is missing ${archivePath}.`);
    const bytes = readDotLottieZipEntry(input.archive, entry, input.limits);
    const styleText = typeof font.fStyle === "string" ? font.fStyle.toLowerCase() : "";
    const weight = parseFontWeight(font.fWeight, styleText);
    const style = styleText.includes("italic") ? "italic" as const : styleText.includes("oblique") ? "oblique" as const : "normal" as const;
    fonts.push({
      fontName,
      fontFamily,
      archivePath,
      bytes,
      sha256: hashBuffer(bytes),
      mimeType: verifiedFontMimeType(archivePath, bytes),
      ...(weight !== undefined ? { weight } : {}),
      style
    });
  }
  // Code-unit order, not localeCompare: see readImages above — same persisted-order contract,
  // and font names are exactly the non-ASCII-prone strings that made locales disagree.
  return fonts.sort((left, right) => compareCodeUnits(left.fontName, right.fontName));
}

function referencedFontNames(animation: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const layer of selectedCompositionLayers(animation)) {
    if (layer?.ty !== 5) continue;
    const documentData = readDotLottieRecord(readDotLottieRecord(layer.t)?.d);
    const keyframes = Array.isArray(documentData?.k) ? documentData.k : [];
    for (const keyframe of keyframes) {
      const fontName = readDotLottieRecord(readDotLottieRecord(keyframe)?.s)?.f;
      if (typeof fontName === "string") names.add(readSafeFontString(fontName, "text layer font name"));
    }
  }
  return names;
}

function selectedCompositionLayers(animation: Record<string, unknown>): Record<string, unknown>[] {
  const assets = Array.isArray(animation.assets) ? animation.assets.map(readDotLottieRecord).filter(nonNull) : [];
  const precomps = new Map<string, Record<string, unknown>>();
  for (const asset of assets) {
    if (!Array.isArray(asset.layers)) continue;
    const id = typeof asset.id === "string" ? asset.id : "";
    if (!id) throw new Error("dotLottie precomposition assets require a string id.");
    if (precomps.has(id)) throw new Error(`dotLottie precomposition asset id ${id} is duplicated.`);
    precomps.set(id, asset);
  }
  const collected: Record<string, unknown>[] = [];
  const visit = (values: unknown[], depth: number, ancestry: string[]): void => {
    if (depth > 4) throw new Error("dotLottie selected animation precomposition nesting exceeds the depth-4 limit.");
    for (const value of values) {
      const layer = readDotLottieRecord(value);
      if (!layer) throw new Error("dotLottie selected animation layers must be objects.");
      collected.push(layer);
      if (layer.ty !== 0) continue;
      const refId = typeof layer.refId === "string" ? layer.refId : "";
      const asset = precomps.get(refId);
      if (!refId || !asset || !Array.isArray(asset.layers)) throw new Error("dotLottie precomposition layer requires a resolvable asset.");
      if (ancestry.includes(refId)) throw new Error(`dotLottie precomposition cycle detected at ${refId}.`);
      visit(asset.layers, depth + 1, [...ancestry, refId]);
    }
  };
  visit(Array.isArray(animation.layers) ? animation.layers : [], 0, []);
  return collected;
}

function normalizeArchiveAssetPath(prefix: string, value: string, label: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`dotLottie ${label} has an unsafe file path.`);
  }
  const combined = value.replace(/^\.\//, "");
  const normalized = combined.startsWith(`${prefix}/`) ? combined : `${prefix}/${combined}`;
  if (!normalized.startsWith(`${prefix}/`) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`dotLottie ${label} must resolve beneath ${prefix}/.`);
  }
  return normalized;
}

function verifiedImageMimeType(path: string, bytes: Uint8Array): DotLottieBundledImage["mimeType"] {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".png" && bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if ((extension === ".jpg" || extension === ".jpeg") && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (extension === ".gif" && bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))) return "image/gif";
  if (extension === ".webp" && bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  throw new Error(`dotLottie image ${path} must be a signature-matched PNG, JPEG, GIF, or WebP file.`);
}

function verifiedFontMimeType(path: string, bytes: Uint8Array): DotLottieBundledFont["mimeType"] {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const signature = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
  if (extension === ".woff2" && signature === "wOF2") return "font/woff2";
  if (extension === ".woff" && signature === "wOFF") return "font/woff";
  if (extension === ".otf" && signature === "OTTO") return "font/otf";
  if (extension === ".ttf" && bytes.length >= 4 && (Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from([0, 1, 0, 0])) || signature === "true")) return "font/ttf";
  throw new Error(`dotLottie font ${path} must be a signature-matched TTF, OTF, WOFF, or WOFF2 file.`);
}

function parseFontWeight(value: unknown, style: string): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
  if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000)) throw new Error("dotLottie font weight must be an integer from 1 to 1000.");
  return parsed ?? (style.includes("bold") ? 700 : 400);
}

function readSafeFontString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(value)) throw new Error(`dotLottie ${label} is invalid.`);
  return value;
}

function positiveImageDimension(value: unknown, assetId: string, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 32768) {
    throw new Error(`dotLottie image asset ${assetId} ${label} must be a positive number no greater than 32768.`);
  }
  return value;
}

function isSafeAssetId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}
