export interface DotLottieLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxManifestBytes: number;
  maxEntries: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxCompressionRatio: number;
}

export const DEFAULT_DOTLOTTIE_LIMITS: DotLottieLimits = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxEntries: 256,
  maxPathBytes: 512,
  maxPathDepth: 4,
  maxCompressionRatio: 200
});

export interface DotLottieManifestAnimation {
  id: string;
  initialTheme?: string;
  background?: number;
  themes?: string[];
}

export interface DotLottieManifestResource {
  id: string;
  name?: string;
}

export interface DotLottieManifestInventory {
  animations: DotLottieManifestAnimation[];
  themes: DotLottieManifestResource[];
  stateMachines: DotLottieManifestResource[];
  initial?: { animation?: string; stateMachine?: string };
}

export interface DotLottieBundledImage {
  assetId: string;
  archivePath: string;
  bytes: Uint8Array;
  sha256: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

export interface DotLottieBundledFont {
  fontName: string;
  fontFamily: string;
  archivePath: string;
  bytes: Uint8Array;
  sha256: string;
  mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf";
  weight?: number;
  style?: "normal" | "italic" | "oblique";
}

export interface DotLottieBundledJsonResource {
  kind: "theme" | "state-machine";
  id: string;
  name?: string;
  archivePath: string;
  text: string;
  sha256: string;
}

export interface DotLottieSelection {
  schema: "shellx-motion/dotlottie-selection@1";
  version: "1" | "2";
  animationId: string;
  animationPath: string;
  animationText: string;
  archiveSha256: string;
  manifestSha256: string;
  animationSha256: string;
  entryCount: number;
  expandedBytes: number;
  selectionSource: "explicit" | "manifest-default" | "manifest-first" | "single-animation";
  bundledImages: DotLottieBundledImage[];
  bundledFonts: DotLottieBundledFont[];
  bundledResources: DotLottieBundledJsonResource[];
  inventory: DotLottieManifestInventory;
  manifest: Record<string, unknown>;
}
