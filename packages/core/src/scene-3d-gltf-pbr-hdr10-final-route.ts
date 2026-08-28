import { canonicalJsonSha256 } from "./canonical-json";
import { requiredLoadedPackageDocumentHashes } from "./package-loaded-inputs";
import { loadMotionPackage } from "./package";
import {
  SCENE3D_GLTF_PBR_HDR10_ABI,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
} from "./scene-3d-gltf-pbr-hdr10-contract";
import { deriveScene3dGltfPbrHdr10StaticPlan, type Scene3dGltfPbrHdr10StaticPlan } from "./scene-3d-gltf-pbr-hdr10-plan";
import { resolveScene3dGltfPbrFinalRoute } from "./scene-3d-gltf-material-final-route";
import type { MotionPackage } from "./types";

export {
  HDR10_DEPTH_BYTES,
  HDR10_MAX_PEAK_GPU_BYTES,
  HDR10_MAX_READBACK_CHUNK_BYTES,
  HDR10_MAX_STATIC_GPU_BYTES,
  HDR10_RGBA16FLOAT_BYTES,
  HDR10_RGBA16FLOAT_BYTES_PER_ROW,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
} from "./scene-3d-gltf-pbr-hdr10-contract";

export const SCENE3D_GLTF_PBR_HDR10_FINAL_LOCATOR_SCHEMA = "shellx-motion/scene3d-gltf-pbr-hdr10-final-locator@1" as const;
export const SCENE3D_GLTF_PBR_HDR10_FINAL_ROUTE_SCHEMA = "shellx-motion/scene3d-gltf-pbr-hdr10-final-route@1" as const;
export const SCENE3D_GLTF_PBR_HDR10_DIRECT_FINAL_RECEIPT_INTENT_SCHEMA = "shellx-motion/scene3d-gltf-pbr-hdr10-direct-final-receipt-intent@1" as const;

/** A declarative opt-in only; package bytes and the authenticated SDR route remain authority. */
export interface Scene3dGltfPbrHdr10FinalLocator {
  readonly schema: typeof SCENE3D_GLTF_PBR_HDR10_FINAL_LOCATOR_SCHEMA;
  readonly sceneLayerId: string;
}

export interface Scene3dGltfPbrHdr10FinalRoute {
  readonly schema: typeof SCENE3D_GLTF_PBR_HDR10_FINAL_ROUTE_SCHEMA;
  readonly packageId: string;
  readonly locator: Scene3dGltfPbrHdr10FinalLocator;
  readonly staticPlan: Scene3dGltfPbrHdr10StaticPlan;
  readonly receiptIntent: {
    readonly schema: typeof SCENE3D_GLTF_PBR_HDR10_DIRECT_FINAL_RECEIPT_INTENT_SCHEMA;
    readonly lane: "gpu-to-ffmpeg-direct-final";
    readonly pbrAbi: typeof SCENE3D_GLTF_PBR_HDR10_ABI;
    readonly admissionFingerprint: typeof SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT;
    readonly fingerprint: string;
  };
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}

export type Scene3dGltfPbrHdr10FinalRouteResolution =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "present"; readonly route: Scene3dGltfPbrHdr10FinalRoute }>;

export interface Scene3dGltfPbrHdr10ResolverCatalogs {
  readonly sdrRendererCatalogSha256: string;
  readonly hdr10RendererCatalogSha256: string;
}

/** Presence is deliberately not an admission: a present marker must resolve exactly or refuse. */
export function hasScene3dGltfPbrHdr10FinalLocator(value: unknown): boolean {
  const root = record(value), adapter = root && record(root.adapter);
  return !!adapter && Object.hasOwn(adapter, "scene3dGltfPbrHdr10Final");
}

/** Returns the namespaced manifest data to merge with the pre-existing authenticated SDR marker. */
export function scene3dGltfPbrHdr10FinalLocatorManifestData(sceneLayerId: string): Readonly<{ scene3dGltfPbrHdr10Final: Scene3dGltfPbrHdr10FinalLocator }> {
  return Object.freeze({ scene3dGltfPbrHdr10Final: parseLocator({ schema: SCENE3D_GLTF_PBR_HDR10_FINAL_LOCATOR_SCHEMA, sceneLayerId }) });
}

/**
 * Resolves the HDR overlay only after an authenticated package reopen and the complete SDR M4
 * resolver. It produces no Browser or FFmpeg work; absence intentionally leaves legacy routing alone.
 */
export async function resolveScene3dGltfPbrHdr10FinalRoute(
  pkg: MotionPackage,
  catalogs: Scene3dGltfPbrHdr10ResolverCatalogs,
): Promise<Scene3dGltfPbrHdr10FinalRouteResolution> {
  const callerHasMarker = hasScene3dGltfPbrHdr10FinalLocator(pkg.manifest.data);
  const callerHashes = requiredLoadedPackageDocumentHashes(pkg, "glTF PBR HDR10 final route");
  const reopened = await loadMotionPackage(pkg.root);
  const reopenedHashes = requiredLoadedPackageDocumentHashes(reopened, "glTF PBR HDR10 final route reopen");
  if (pkg.manifest.id !== reopened.manifest.id || callerHashes["manifest.json"] !== reopenedHashes["manifest.json"]
    || callerHashes[pkg.manifest.motion] !== reopenedHashes[reopened.manifest.motion]) {
    throw new Error("glTF PBR HDR10 final route package bytes changed before authenticated reopen.");
  }
  const reopenedHasMarker = hasScene3dGltfPbrHdr10FinalLocator(reopened.manifest.data);
  if (!callerHasMarker && !reopenedHasMarker) return Object.freeze({ kind: "absent" });
  if (!callerHasMarker || !reopenedHasMarker) throw new Error("glTF PBR HDR10 final marker changed before authenticated reopen.");
  assertHash(catalogs.sdrRendererCatalogSha256, "SDR PBR renderer catalog identity");
  assertHash(catalogs.hdr10RendererCatalogSha256, "HDR10 PBR renderer catalog identity");
  const locator = parseManifestLocator(reopened.manifest.data);
  const sdr = await resolveScene3dGltfPbrFinalRoute(reopened, catalogs.sdrRendererCatalogSha256);
  if (sdr.kind !== "present" || sdr.route.packageId !== reopened.manifest.id || sdr.route.locator.sceneLayerId !== locator.sceneLayerId) {
    throw new Error("glTF PBR HDR10 final route requires its exact authenticated SDR direct-final route.");
  }
  const staticPlan = deriveScene3dGltfPbrHdr10StaticPlan(sdr.route);
  const receiptIntentBase = {
    schema: SCENE3D_GLTF_PBR_HDR10_DIRECT_FINAL_RECEIPT_INTENT_SCHEMA,
    lane: "gpu-to-ffmpeg-direct-final" as const,
    pbrAbi: SCENE3D_GLTF_PBR_HDR10_ABI,
    admissionFingerprint: SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
  };
  const receiptIntent = freeze({ ...receiptIntentBase, fingerprint: canonicalJsonSha256(receiptIntentBase) });
  const inputHashes = Object.freeze({
    "scene3d-gltf-pbr-hdr10-manifest": reopenedHashes["manifest.json"]!,
    "scene3d-gltf-pbr-hdr10-motion": reopenedHashes[reopened.manifest.motion]!,
    "scene3d-gltf-pbr-hdr10-inherited-sdr-route": sdr.route.fingerprint,
    "scene3d-gltf-pbr-hdr10-sdr-catalog": catalogs.sdrRendererCatalogSha256,
    "scene3d-gltf-pbr-hdr10-catalog": catalogs.hdr10RendererCatalogSha256,
    "scene3d-gltf-pbr-hdr10-admission": SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
    "scene3d-gltf-pbr-hdr10-static-plan": staticPlan.fingerprint,
    "scene3d-gltf-pbr-hdr10-scene-state": staticPlan.inheritedSdr.sceneStateSha256,
    "scene3d-gltf-pbr-hdr10-source": staticPlan.source.sha256,
  });
  const base = { schema: SCENE3D_GLTF_PBR_HDR10_FINAL_ROUTE_SCHEMA, packageId: reopened.manifest.id, locator, staticPlan, receiptIntent, inputHashes };
  return Object.freeze({ kind: "present", route: freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Scene3dGltfPbrHdr10FinalRoute });
}

function parseManifestLocator(value: unknown): Scene3dGltfPbrHdr10FinalLocator {
  const root = record(value), adapter = root && record(root.adapter);
  if (!adapter) throw new Error("Motion package HDR10 adapter metadata is invalid.");
  return parseLocator(adapter.scene3dGltfPbrHdr10Final);
}
function parseLocator(value: unknown): Scene3dGltfPbrHdr10FinalLocator {
  const locator = record(value);
  if (!locator || !sameKeys(locator, ["schema", "sceneLayerId"])
    || locator.schema !== SCENE3D_GLTF_PBR_HDR10_FINAL_LOCATOR_SCHEMA || !identifier(locator.sceneLayerId)) {
    throw new Error("Motion package glTF PBR HDR10 final locator is invalid.");
  }
  return Object.freeze({ schema: SCENE3D_GLTF_PBR_HDR10_FINAL_LOCATOR_SCHEMA, sceneLayerId: locator.sceneLayerId });
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined; }
function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(value); }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256.`); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
