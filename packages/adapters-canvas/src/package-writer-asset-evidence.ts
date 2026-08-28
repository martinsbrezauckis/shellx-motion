import type { CanvasMotionExport } from "./index";
import type { AdmittedCanvasAsset, CanvasPackageAssetEvidence } from "./package-writer";

/** Keep layer-only package assets hash-bound even when Canvas did not emit image-editor metadata. */
export function canvasPackageAssetEvidence(
  canvasExport: CanvasMotionExport,
  assets: readonly AdmittedCanvasAsset[]
): CanvasPackageAssetEvidence[] {
  const imageEditorRefs = new Set<string>();
  for (const assetValue of canvasExport.motion.assets ?? []) {
    const source = readRecord(readRecord(assetValue)?.source);
    if (typeof source?.path === "string") imageEditorRefs.add(source.path);
  }
  return assets.map((asset) => ({
    assetRef: asset.assetRef,
    sha256: asset.sha256,
    byteLength: asset.bytes.byteLength,
    role: imageEditorRefs.has(asset.assetRef) ? "canvas_image_editor_asset" : "canvas_package_layer_asset"
  }));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
