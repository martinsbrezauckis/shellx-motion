import { createHash } from "node:crypto";
import { canonicalJsonSha256 } from "./canonical-json";
import {
  HDR10_DEPTH_BYTES,
  HDR10_MAX_PEAK_GPU_BYTES,
  HDR10_MAX_STATIC_GPU_BYTES,
  HDR10_RGBA16FLOAT_BYTES,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
  SCENE3D_GLTF_PBR_HDR10_STATIC_PLAN_SCHEMA,
} from "./scene-3d-gltf-pbr-hdr10-contract";
import type { Scene3dGltfPbrFinalRoute } from "./scene-3d-gltf-material-final-route";

export interface Scene3dGltfPbrHdr10StaticPlan {
  readonly schema: typeof SCENE3D_GLTF_PBR_HDR10_STATIC_PLAN_SCHEMA;
  readonly source: { readonly format: "gltf" | "glb"; readonly sha256: string };
  readonly inheritedSdr: {
    readonly routeFingerprint: string;
    readonly staticPlanFingerprint: string;
    readonly framePlanFingerprint: string;
    readonly sceneStateSha256: string;
    readonly rendererCatalogSha256: string;
  };
  readonly opaqueTextureIdentity: string;
  readonly resourceFacts: {
    readonly staticGpuBytes: number;
    readonly rgba16floatTargetBytes: typeof HDR10_RGBA16FLOAT_BYTES;
    readonly depthTargetBytes: typeof HDR10_DEPTH_BYTES;
    readonly rgba16floatReadbackBytes: typeof HDR10_RGBA16FLOAT_BYTES;
    readonly frameGpuBytes: number;
    readonly peakGpuBytes: number;
  };
  readonly admissionFingerprint: typeof SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT;
  readonly fingerprint: string;
}

/**
 * Re-validates the authenticated SDR route at the HDR boundary. This consumes no Browser resource
 * and intentionally retains neither mutable RGBA snapshots nor a generic colour fallback.
 */
export function deriveScene3dGltfPbrHdr10StaticPlan(route: Scene3dGltfPbrFinalRoute): Scene3dGltfPbrHdr10StaticPlan {
  assertSdrRoute(route);
  const staticPlan = route.renderPlan.staticPlan;
  const staticTextures = new Map(staticPlan.textures.map((texture) => [texture.resourceId, texture]));
  if (staticTextures.size !== staticPlan.textures.length) throw new Error("HDR10 route inherited SDR texture resources are not uniquely identified.");
  const opaqueTextures = route.renderPlan.textures.map((texture) => {
    const staticTexture = staticTextures.get(texture.resourceId);
    if (!Buffer.isBuffer(texture.rgba) || texture.rgba.byteLength !== texture.decodedRgbaByteLength
      || hash(texture.rgba) !== texture.decodedRgbaSha256 || texture.rgba.byteLength % 4 !== 0) {
      throw new Error("HDR10 route texture snapshot does not match its authenticated decoded identity.");
    }
    if (!staticTexture || staticTexture.decodedRgbaSha256 !== texture.decodedRgbaSha256
      || staticTexture.decodedRgbaByteLength !== texture.decodedRgbaByteLength) {
      throw new Error("HDR10 route decoded texture identity does not match its inherited SDR static plan.");
    }
    for (let offset = 3; offset < texture.rgba.byteLength; offset += 4) {
      if (texture.rgba[offset] !== 0xff) throw new Error("HDR10 route requires every contained base-color PNG texel to be opaque.");
    }
    return { resourceId: texture.resourceId, decodedRgbaSha256: texture.decodedRgbaSha256, decodedRgbaByteLength: texture.decodedRgbaByteLength };
  }).sort((left, right) => left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0);
  if (opaqueTextures.length === 0 || new Set(opaqueTextures.map((texture) => texture.resourceId)).size !== opaqueTextures.length) {
    throw new Error("HDR10 route requires one or more uniquely identified opaque base-color textures.");
  }
  const textureIds = new Set(opaqueTextures.map((texture) => texture.resourceId));
  for (const primitive of staticPlan.primitives) {
    if (primitive.material.baseColorFactor[3] !== 1 || !textureIds.has(primitive.material.textureResourceId)
      || !unitFactors([...primitive.material.baseColorFactor, primitive.material.metallicFactor, primitive.material.roughnessFactor, ...primitive.material.emissiveFactor])) {
      throw new Error("HDR10 route requires finite opaque glTF PBR factors and an authenticated base-color texture.");
    }
  }
  const staticGpuBytes = staticPlan.budget.gpuResourceBytes;
  if (!Number.isSafeInteger(staticGpuBytes) || staticGpuBytes < 0 || staticGpuBytes > HDR10_MAX_STATIC_GPU_BYTES) {
    throw new Error("HDR10 route static GPU resources exceed the admitted ceiling.");
  }
  const frameGpuBytes = staticGpuBytes + HDR10_RGBA16FLOAT_BYTES + HDR10_DEPTH_BYTES;
  const peakGpuBytes = frameGpuBytes + HDR10_RGBA16FLOAT_BYTES;
  if (!Number.isSafeInteger(peakGpuBytes) || peakGpuBytes > HDR10_MAX_PEAK_GPU_BYTES) throw new Error("HDR10 route peak GPU resources exceed the admitted ceiling.");
  const base = {
    schema: SCENE3D_GLTF_PBR_HDR10_STATIC_PLAN_SCHEMA,
    source: { format: staticPlan.source.format, sha256: staticPlan.source.sha256 },
    inheritedSdr: {
      routeFingerprint: route.fingerprint, staticPlanFingerprint: staticPlan.fingerprint, framePlanFingerprint: route.renderPlan.framePlan.fingerprint,
      sceneStateSha256: route.sceneStateSha256, rendererCatalogSha256: route.rendererCatalogSha256,
    },
    opaqueTextureIdentity: canonicalJsonSha256(opaqueTextures),
    resourceFacts: { staticGpuBytes, rgba16floatTargetBytes: HDR10_RGBA16FLOAT_BYTES, depthTargetBytes: HDR10_DEPTH_BYTES, rgba16floatReadbackBytes: HDR10_RGBA16FLOAT_BYTES, frameGpuBytes, peakGpuBytes },
    admissionFingerprint: SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
  };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Scene3dGltfPbrHdr10StaticPlan;
}

function assertSdrRoute(route: Scene3dGltfPbrFinalRoute): void {
  const staticPlan = route?.renderPlan?.staticPlan, framePlan = route?.renderPlan?.framePlan;
  if (route?.schema !== "shellx-motion/scene3d-gltf-pbr-final-route@1" || !hashValue(route.fingerprint)
    || !hashValue(route.sceneStateSha256) || !hashValue(route.rendererCatalogSha256)
    || !staticPlan || !framePlan || staticPlan.schema !== "shellx-motion/scene3d-gltf-material-render-static@1"
    || framePlan.schema !== "shellx-motion/scene3d-gltf-material-render-frame@1"
    || staticPlan.sceneStateSha256 !== route.sceneStateSha256 || framePlan.sceneStateSha256 !== route.sceneStateSha256
    || framePlan.staticFingerprint !== staticPlan.fingerprint || !hashValue(staticPlan.fingerprint)
    || !hashValue(framePlan.fingerprint) || !hashValue(staticPlan.source.sha256)
    || staticPlan.pbr.abi !== "shellx-motion/browser-scene3d-gltf-pbr-sdr@1"
    || staticPlan.pbr.baseColorTextureFormat !== "rgba8unorm-srgb"
    || staticPlan.pbr.baseColorTextureTransfer !== "srgb-to-linear-hardware"
    || staticPlan.pbr.factorSpace !== "linear-gltf" || staticPlan.pbr.brdf !== "ggx-smith-schlick-directional@1"
    || staticPlan.pbr.ambient !== "bounded-diffuse@1" || staticPlan.pbr.outputTransfer !== "linear-to-srgb-explicit"
    || framePlan.pbrAbi !== "shellx-motion/browser-scene3d-gltf-pbr-sdr@1" || staticPlan.primitives.length < 1 || staticPlan.primitives.length > 16
    || staticPlan.textures.length !== route.renderPlan.textures.length || staticPlan.textures.length > 16) {
    throw new Error("HDR10 route requires an exact authenticated SDR glTF PBR direct-final route.");
  }
}

function unitFactors(values: readonly number[]): boolean { return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function hashValue(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
