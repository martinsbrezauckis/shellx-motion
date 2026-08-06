/** Bounded, non-extracting dotLottie selection with explicit provenance. */
import { hashBuffer } from "./receipts";
import { readSelectedDotLottieAssets } from "./dotlottie-assets";
import { decodeDotLottieUtf8 } from "./dotlottie-json";
import { parseBoundedLottieJson } from "./lottie-json";
import { parseDotLottieManifest, selectDotLottieAnimationId } from "./dotlottie-manifest";
import { readDeclaredDotLottieResources } from "./dotlottie-resources";
import {
  DEFAULT_DOTLOTTIE_LIMITS,
  type DotLottieLimits,
  type DotLottieSelection
} from "./dotlottie-types";
import { findDotLottieFile, readDotLottieZipDirectory, readDotLottieZipEntry } from "./dotlottie-zip";

export * from "./dotlottie-types";

/** Inventories the full ZIP but reads only declared metadata and selected-animation assets. */
export function selectDotLottieAnimation(
  archive: Uint8Array,
  options: { animationId?: string; limits?: Partial<DotLottieLimits> } = {}
): DotLottieSelection {
  const bytes = Buffer.from(archive);
  const limits = resolveDotLottieLimits(options.limits);
  if (bytes.byteLength > limits.maxArchiveBytes) throw new Error(`dotLottie archive exceeds the ${limits.maxArchiveBytes}-byte limit.`);
  const entries = readDotLottieZipDirectory(bytes, limits);
  const manifestEntry = findDotLottieFile(entries, "manifest.json");
  if (!manifestEntry) throw new Error("dotLottie archive requires one root manifest.json file.");
  if (manifestEntry.uncompressedSize > limits.maxManifestBytes) throw new Error("dotLottie manifest exceeds the manifest limit.");
  const manifestBytes = readDotLottieZipEntry(bytes, manifestEntry, limits);
  const manifest = parseDotLottieManifest(decodeDotLottieUtf8(manifestBytes, "dotLottie manifest"));
  const selection = selectDotLottieAnimationId(manifest, options.animationId);
  const prefix = manifest.version === "2" ? "a" : "animations";
  verifyDeclaredAnimations(manifest.inventory.animations.map((item) => item.id), prefix, entries);
  const animationPath = `${prefix}/${selection.id}.json`;
  const animationEntry = findDotLottieFile(entries, animationPath)!;
  const animationBytes = readDotLottieZipEntry(bytes, animationEntry, limits);
  const animationText = decodeDotLottieUtf8(animationBytes, `dotLottie animation ${selection.id}`);
  parseBoundedLottieJson(animationText);
  const assets = readSelectedDotLottieAssets({
    animationText,
    version: manifest.version,
    entries,
    archive: bytes,
    limits
  });
  const bundledResources = readDeclaredDotLottieResources({ manifest, entries, archive: bytes, limits });
  return {
    schema: "shellx-motion/dotlottie-selection@1",
    version: manifest.version,
    animationId: selection.id,
    animationPath,
    animationText,
    archiveSha256: hashBuffer(bytes),
    manifestSha256: hashBuffer(manifestBytes),
    animationSha256: hashBuffer(animationBytes),
    entryCount: entries.length,
    expandedBytes: entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
    selectionSource: selection.source,
    bundledImages: assets.images,
    bundledFonts: assets.fonts,
    bundledResources,
    inventory: manifest.inventory,
    manifest: manifest.raw
  };
}

function verifyDeclaredAnimations(
  animationIds: string[],
  prefix: "a" | "animations",
  entries: ReturnType<typeof readDotLottieZipDirectory>
): void {
  for (const animationId of animationIds) {
    const expected = `${prefix}/${animationId}.json`;
    if (!findDotLottieFile(entries, expected)) throw new Error(`dotLottie manifest animation ${animationId} is missing ${expected}.`);
  }
}

function resolveDotLottieLimits(overrides: Partial<DotLottieLimits> | undefined): DotLottieLimits {
  const limits = { ...DEFAULT_DOTLOTTIE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dotLottie limit ${key} must be a positive safe integer.`);
  }
  return limits;
}
