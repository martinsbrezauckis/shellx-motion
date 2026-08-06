import type { MotionFontAsset } from "./types";

export interface LottieBundledImageAsset {
  assetId: string;
  packagePath: string;
  sha256: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

export interface LottieBundledFontAsset {
  assetId: string;
  family: string;
  packagePath: string;
  sha256: string;
  mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf";
  weight?: number;
  style?: "normal" | "italic" | "oblique";
}

export function prepareLottieLoweringAssets(
  images: LottieBundledImageAsset[] = [],
  fonts: LottieBundledFontAsset[] = []
): {
  images: Map<string, LottieBundledImageAsset>;
  motionAssets: unknown[];
} {
  const imageMap = new Map(images.map((asset) => [asset.assetId, asset]));
  if (imageMap.size !== images.length) throw new Error("Lottie lowering bundled image asset ids must be unique.");
  if (new Set(fonts.map((asset) => asset.assetId)).size !== fonts.length) throw new Error("Lottie lowering bundled font asset ids must be unique.");
  const faceKeys = fonts.map((asset) => `${asset.family.toLowerCase()}\0${asset.weight ?? 400}\0${asset.style ?? "normal"}`);
  if (new Set(faceKeys).size !== faceKeys.length) throw new Error("Lottie lowering bundled font faces must be unique.");
  const imageAssets = images.map((asset) => ({
    schema: "shellx-motion/asset@1",
    id: asset.assetId,
    kind: "image",
    source: { path: asset.packagePath, mimeType: asset.mimeType },
    hash: { sha256: asset.sha256 },
    size: { width: asset.width, height: asset.height }
  }));
  const fontAssets: MotionFontAsset[] = fonts.map((asset) => ({
    id: asset.assetId,
    type: "font",
    family: asset.family,
    source: { path: asset.packagePath, mimeType: asset.mimeType },
    ...(asset.weight !== undefined ? { weight: asset.weight } : {}),
    ...(asset.style !== undefined ? { style: asset.style } : {})
  }));
  return { images: imageMap, motionAssets: [...imageAssets, ...fontAssets] };
}
