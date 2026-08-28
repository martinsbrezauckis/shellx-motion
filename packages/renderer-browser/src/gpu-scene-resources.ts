import { createHash } from "node:crypto";
import {
  classifyGpuImageResource,
  decodePngRgba,
  gpuImageMimeTypeForAssetRef,
  gpuSceneImageAssetRef,
  motionScene3DAnimationStorePresent,
  readVerifiedPackageAsset,
  type GpuScene2dImageResource,
  type MotionPackage
} from "@shellx-motion/core";
import { compileGpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import type { GpuSessionImageResource } from "./gpu-runtime-types";
import { GpuSceneFontResourceError, prepareGpuSceneFontResources } from "./gpu-scene-font-resources";

const MAX_GPU_SCENE_IMAGES = 64;
const MAX_GPU_SCENE_IMAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GPU_SCENE_DECODED_BYTES = 256 * 1024 * 1024;

export interface PreparedGpuSceneResources {
  images: ReadonlyMap<string, GpuScene2dImageResource>;
  sessionImages: readonly GpuSessionImageResource[];
  fonts: Awaited<ReturnType<typeof prepareGpuSceneFontResources>>["fonts"];
  sessionFonts: Awaited<ReturnType<typeof prepareGpuSceneFontResources>>["sessionFonts"];
  inputHashes: Readonly<Record<string, string>>;
}

export class GpuSceneResourceError extends Error {
  readonly code = "gpu_scene_resource_refused";
  constructor(message: string, readonly layerId?: string) {
    super(message);
    this.name = "GpuSceneResourceError";
    Object.setPrototypeOf(this, GpuSceneResourceError.prototype);
  }
}

/** Prepares every exact package image and manifest font before hardware opens. */
export async function prepareGpuSceneResources(
  pkg: MotionPackage,
  staticResources?: readonly { kind: "image" | "video" | "font" | "browser-surface"; assetRef: string; family?: string }[]
): Promise<PreparedGpuSceneResources> {
  // This is the only permitted exception to the generic Scene3D root refusal.  The same
  // Core wrapper used by preview admission validates it before this helper can touch assets.
  if (motionScene3DAnimationStorePresent(pkg.motion)) {
    const scene3dAnimation = compileGpuScene3DAnimationStaticPlan(pkg.motion);
    if (!scene3dAnimation.ok) throw new GpuSceneResourceError(scene3dAnimation.failure.message, scene3dAnimation.failure.layerId);
  }
  let preparedFonts;
  try { preparedFonts = await prepareGpuSceneFontResources(pkg, staticResources); }
  catch (error) { throw new GpuSceneResourceError(error instanceof Error ? error.message : "GPU scene font resources could not be prepared.", error instanceof GpuSceneFontResourceError ? error.layerId : undefined); }
  const refs = new Map<string, string>();
  if (staticResources) {
    for (const resource of staticResources) if (resource.kind === "image") refs.set(resource.assetRef, resource.assetRef);
  } else for (const layer of pkg.motion.layers) {
    if (layer.type !== "image" || layer.visible === false) continue;
    const assetRef = gpuSceneImageAssetRef(pkg.motion, layer);
    if (!assetRef) throw new GpuSceneResourceError(`GPU image layer ${layer.id} has no package asset reference.`, layer.id);
    refs.set(assetRef, layer.id);
  }
  if (refs.size > MAX_GPU_SCENE_IMAGES) throw new GpuSceneResourceError(`GPU scenes accept at most ${MAX_GPU_SCENE_IMAGES} distinct image assets.`);
  const images = new Map<string, GpuScene2dImageResource>();
  const sessionImages: GpuSessionImageResource[] = [];
  const inputHashes: Record<string, string> = {};
  let decodedBytes = 0;
  for (const [assetRef, layerId] of refs) {
    let snapshot;
    try {
      snapshot = await readVerifiedPackageAsset(pkg, assetRef, { label: `GPU image asset ${assetRef}`, maxBytes: MAX_GPU_SCENE_IMAGE_FILE_BYTES });
    } catch (error) {
      throw new GpuSceneResourceError(error instanceof Error ? error.message : `GPU image asset ${assetRef} could not be read.`, layerId);
    }
    const mimeType = gpuSceneImageMimeType(pkg, assetRef);
    if (!mimeType) throw new GpuSceneResourceError(`GPU image asset ${assetRef} has no supported declared MIME type or asset suffix.`, layerId);
    let classification;
    try { classification = classifyGpuImageResource(snapshot.bytes, mimeType); }
    catch (error) { throw new GpuSceneResourceError(`GPU image asset ${assetRef} was refused before decode: ${error instanceof Error ? error.message : String(error)}`, layerId); }
    decodedBytes += classification.decodedBytes;
    if (decodedBytes > MAX_GPU_SCENE_DECODED_BYTES) throw new GpuSceneResourceError("GPU image assets exceed the 256 MiB decoded session budget.", layerId);
    const resourceId = `image-${createHash("sha256").update(assetRef).update("\0").update(snapshot.sha256).digest("hex").slice(0, 24)}`;
    images.set(assetRef, { resourceId, assetRef, width: classification.width, height: classification.height, sha256: snapshot.sha256 });
    if (classification.decodeAuthority === "safe-host-png-rgba") {
      let decoded;
      try { decoded = decodePngRgba(snapshot.bytes); }
      catch (error) { throw new GpuSceneResourceError(`GPU image asset ${assetRef} is not a supported bounded PNG: ${error instanceof Error ? error.message : String(error)}`, layerId); }
      if (decoded.width !== classification.width || decoded.height !== classification.height) throw new GpuSceneResourceError(`GPU PNG image asset ${assetRef} changed dimensions during safe decode.`, layerId);
      sessionImages.push({ id: resourceId, width: decoded.width, height: decoded.height, rgba: decoded.rgba, sha256: snapshot.sha256, decodedSha256: createHash("sha256").update(decoded.rgba).digest("hex") });
    } else {
      const mimeType = classification.mimeType;
      if (mimeType !== "image/jpeg" && mimeType !== "image/webp" && mimeType !== "image/svg+xml") throw new GpuSceneResourceError(`GPU image asset ${assetRef} reached the browser decode path with an unsupported MIME.`, layerId);
      sessionImages.push({ id: resourceId, width: classification.width, height: classification.height, bytes: snapshot.bytes, mimeType, ...(classification.staticSvg ? { staticSvg: true as const } : {}), sha256: snapshot.sha256 });
    }
    inputHashes[assetRef] = snapshot.sha256;
  }
  return { images, sessionImages, fonts: preparedFonts.fonts, sessionFonts: preparedFonts.sessionFonts, inputHashes: Object.freeze({ ...inputHashes, ...preparedFonts.inputHashes }) };
}

function gpuSceneImageMimeType(pkg: MotionPackage, assetRef: string): "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | null {
  for (const asset of pkg.motion.assets) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) continue;
    const source = (asset as { source?: unknown }).source;
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const record = source as { path?: unknown; mimeType?: unknown };
    if (record.path === assetRef && typeof record.mimeType === "string") {
      return record.mimeType === "image/png" || record.mimeType === "image/jpeg" || record.mimeType === "image/webp" || record.mimeType === "image/svg+xml" ? record.mimeType : null;
    }
  }
  return gpuImageMimeTypeForAssetRef(assetRef);
}
