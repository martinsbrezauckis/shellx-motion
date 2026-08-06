/** Atomic dotLottie wrapper preserving the archive and selected animation. */
import {
  applyStaticDotLottieTheme,
  flattenStaticLottiePrecomps,
  hashBuffer,
  lowerSelectedDotLottieToMotion,
  selectDotLottieAnimation,
  type AppliedDotLottieTheme,
  type DotLottieBundledFont,
  type DotLottieBundledImage,
  type DotLottieBundledJsonResource,
  type DotLottieSelection,
  type FlattenedLottiePrecomps,
  type LottieBundledFontAsset,
  type LottieBundledImageAsset
} from "@shellx-motion/core";
import { join } from "node:path";
import {
  writeStaticVectorPackage,
  type StaticVectorPackageOptions,
  type WrittenStaticVectorPackage
} from "./authoring-vector-package.js";

export interface WriteStaticDotLottiePackageOptions extends StaticVectorPackageOptions {
  animationId?: string;
  themeId?: string;
}

export interface WrittenStaticDotLottiePackage extends WrittenStaticVectorPackage {
  selectedAnimationPath: string;
  bundledImagePaths: string[];
  bundledFontPaths: string[];
  bundledResourcePaths: string[];
  loweringAnimationPath: string;
  appliedTheme?: Omit<AppliedDotLottieTheme, "animationText">;
  precomposition: Omit<FlattenedLottiePrecomps, "animationText">;
  selection: Omit<DotLottieSelection, "animationText" | "manifest" | "bundledImages" | "bundledFonts" | "bundledResources"> & {
    bundledImages: Array<Omit<DotLottieBundledImage, "bytes"> & { packagePath: string }>;
    bundledFonts: Array<Omit<DotLottieBundledFont, "bytes"> & { packagePath: string }>;
    bundledResources: Array<Omit<DotLottieBundledJsonResource, "text"> & { packagePath: string }>;
  };
}

/** Selects, lowers, and atomically installs one bounded dotLottie animation. */
export async function writeStaticDotLottiePackage(options: WriteStaticDotLottiePackageOptions): Promise<WrittenStaticDotLottiePackage> {
  let selected: DotLottieSelection | undefined;
  let preparedImages: LottieBundledImageAsset[] = [];
  let preparedFonts: LottieBundledFontAsset[] = [];
  let resourcePaths: string[] = [];
  let appliedTheme: AppliedDotLottieTheme | undefined;
  let precomposition: FlattenedLottiePrecomps | undefined;
  let loweringPath = "source/selected-animation.json";
  const written = await writeStaticVectorPackage({
    adapterId: "adapter.lottie",
    formatLabel: "dotLottie",
    sourceApp: "dotlottie",
    sourceFileName: "input.lottie",
    packagePrefix: "pkg_dotlottie",
    maxSourceBytes: 32 * 1024 * 1024,
    prepareSource: (archiveBytes) => {
      selected = selectDotLottieAnimation(archiveBytes, { ...(options.animationId !== undefined ? { animationId: options.animationId } : {}) });
      appliedTheme = applySelectedTheme(selected, options.themeId);
      preparedImages = selected.bundledImages.map((image) => ({
        assetId: image.assetId,
        packagePath: dotLottieImagePackagePath(image),
        sha256: image.sha256,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height
      }));
      preparedFonts = selected.bundledFonts.map((font) => ({
        assetId: `dotlottie-font-${hashBuffer(Buffer.from(font.fontName, "utf8")).slice(0, 16)}`,
        family: font.fontName,
        packagePath: dotLottieFontPackagePath(font),
        sha256: font.sha256,
        mimeType: font.mimeType,
        ...(font.weight !== undefined ? { weight: font.weight } : {}),
        ...(font.style !== undefined ? { style: font.style } : {})
      }));
      resourcePaths = selected.bundledResources.map(dotLottieResourcePackagePath);
      const selectedBytes = Buffer.from(selected.animationText, "utf8");
      const selectedPath = "source/selected-animation.json";
      precomposition = flattenStaticLottiePrecomps(appliedTheme?.animationText ?? selected.animationText);
      const loweringText = precomposition.animationText;
      loweringPath = appliedTheme && precomposition.changed
        ? "source/selected-animation-themed-flattened.json"
        : appliedTheme
          ? "source/selected-animation-themed.json"
          : precomposition.changed
            ? "source/selected-animation-flattened.json"
            : selectedPath;
      const loweringBytes = Buffer.from(loweringText, "utf8");
      return {
        primaryPath: "source/input.lottie",
        primarySha256: selected.archiveSha256,
        loweringPath,
        loweringText,
        files: [
          { path: "source/input.lottie", bytes: archiveBytes, sha256: selected.archiveSha256 },
          { path: selectedPath, bytes: selectedBytes, sha256: hashBuffer(selectedBytes) },
          ...(loweringPath !== selectedPath ? [{ path: loweringPath, bytes: loweringBytes, sha256: hashBuffer(loweringBytes) }] : []),
          ...selected.bundledImages.map((image, index) => ({
            path: preparedImages[index].packagePath,
            bytes: image.bytes,
            sha256: image.sha256
          })),
          ...selected.bundledFonts.map((font, index) => ({
            path: preparedFonts[index].packagePath,
            bytes: font.bytes,
            sha256: font.sha256
          })),
          ...selected.bundledResources.map((resource, index) => ({
            path: resourcePaths[index],
            bytes: Buffer.from(resource.text, "utf8"),
            sha256: resource.sha256
          }))
        ],
        manifestAssets: [
          ...preparedImages.map((image) => image.packagePath),
          ...preparedFonts.map((font) => font.packagePath)
        ],
        manifestData: {
          container: {
            schema: "shellx-motion/dotlottie-source@1",
            version: selected.version,
            animationId: selected.animationId,
            animationPath: selected.animationPath,
            selectionSource: selected.selectionSource,
            archiveSha256: selected.archiveSha256,
            manifestSha256: selected.manifestSha256,
            animationSha256: selected.animationSha256,
            entryCount: selected.entryCount,
            expandedBytes: selected.expandedBytes,
            inventory: selected.inventory,
            resources: selected.bundledResources.map((resource, index) => ({
              kind: resource.kind,
              id: resource.id,
              path: resourcePaths[index],
              sha256: resource.sha256
            })),
            resourcePolicy: {
              themes: appliedTheme ? "static-subset-applied" : "preserved-not-applied",
              stateMachines: "preserved-not-executed",
              background: "lowered-to-motion-background"
            },
            ...(appliedTheme ? { appliedTheme: publicAppliedTheme(appliedTheme) } : {}),
            precomposition: publicPrecomposition(precomposition)
          }
        }
      };
    },
    lower: (input) => {
      if (!selected) throw new Error("dotLottie package selection did not complete before lowering.");
      const selectedAnimationId = selected.animationId;
      const animation = selected.inventory.animations.find((item) => item.id === selectedAnimationId);
      if (!animation) throw new Error("dotLottie selected animation metadata is missing.");
      return lowerSelectedDotLottieToMotion({
        ...input,
        animation,
        ...(appliedTheme ? { appliedTheme: publicAppliedTheme(appliedTheme) } : {}),
        bundledImages: preparedImages,
        bundledFonts: preparedFonts
      });
    }
  }, options);
  if (!selected || !precomposition) throw new Error("dotLottie package preparation did not complete.");
  const {
    animationText: _animationText,
    manifest: _manifest,
    bundledImages,
    bundledFonts,
    bundledResources,
    ...selectionBase
  } = selected;
  const publicImages = bundledImages.map((image, index) => {
    const { bytes: _bytes, ...publicImage } = image;
    return { ...publicImage, packagePath: preparedImages[index].packagePath };
  });
  const publicFonts = bundledFonts.map((font, index) => {
    const { bytes: _bytes, ...publicFont } = font;
    return { ...publicFont, packagePath: preparedFonts[index].packagePath };
  });
  const publicResources = bundledResources.map((resource, index) => {
    const { text: _text, ...publicResource } = resource;
    return { ...publicResource, packagePath: resourcePaths[index] };
  });
  return {
    ...written,
    selectedAnimationPath: join(written.packageRoot, "source", "selected-animation.json"),
    loweringAnimationPath: join(written.packageRoot, loweringPath),
    bundledImagePaths: preparedImages.map((image) => join(written.packageRoot, image.packagePath)),
    bundledFontPaths: preparedFonts.map((font) => join(written.packageRoot, font.packagePath)),
    bundledResourcePaths: resourcePaths.map((path) => join(written.packageRoot, path)),
    ...(appliedTheme ? { appliedTheme: publicAppliedTheme(appliedTheme) } : {}),
    precomposition: publicPrecomposition(precomposition),
    selection: {
      ...selectionBase,
      bundledImages: publicImages,
      bundledFonts: publicFonts,
      bundledResources: publicResources
    }
  };
}

function dotLottieImagePackagePath(image: DotLottieBundledImage): string {
  const extension = image.archivePath.slice(image.archivePath.lastIndexOf(".")).toLowerCase();
  return `assets/dotlottie/${image.assetId}-${image.sha256.slice(0, 16)}${extension}`;
}

function dotLottieFontPackagePath(font: DotLottieBundledFont): string {
  const extension = font.archivePath.slice(font.archivePath.lastIndexOf(".")).toLowerCase();
  const nameHash = hashBuffer(Buffer.from(font.fontName, "utf8")).slice(0, 8);
  return `assets/dotlottie/font-${nameHash}-${font.sha256.slice(0, 16)}${extension}`;
}

function dotLottieResourcePackagePath(resource: DotLottieBundledJsonResource): string {
  const idHash = hashBuffer(Buffer.from(resource.id, "utf8")).slice(0, 8);
  return `source/dotlottie-resources/${resource.kind}-${idHash}-${resource.sha256.slice(0, 16)}.json`;
}

function applySelectedTheme(selection: DotLottieSelection, explicitThemeId: string | undefined): AppliedDotLottieTheme | undefined {
  const animation = selection.inventory.animations.find((item) => item.id === selection.animationId);
  if (!animation) throw new Error("dotLottie selected animation metadata is missing.");
  if (explicitThemeId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(explicitThemeId)) {
    throw new Error("dotLottie explicit themeId is invalid.");
  }
  const themeId = explicitThemeId ?? animation.initialTheme;
  if (!themeId) return undefined;
  if (animation.themes && !animation.themes.includes(themeId)) {
    throw new Error(`dotLottie theme ${themeId} is not scoped to animation ${selection.animationId}.`);
  }
  const theme = selection.bundledResources.find((resource) => resource.kind === "theme" && resource.id === themeId);
  if (!theme) throw new Error(`dotLottie theme ${themeId} is not declared in the selected archive.`);
  return applyStaticDotLottieTheme({ animationText: selection.animationText, animationId: selection.animationId, theme });
}

function publicAppliedTheme(theme: AppliedDotLottieTheme): Omit<AppliedDotLottieTheme, "animationText"> {
  const { animationText: _animationText, ...evidence } = theme;
  return evidence;
}

function publicPrecomposition(value: FlattenedLottiePrecomps): Omit<FlattenedLottiePrecomps, "animationText"> {
  const { animationText: _animationText, ...evidence } = value;
  return evidence;
}
