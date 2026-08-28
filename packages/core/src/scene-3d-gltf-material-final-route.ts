import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { projectGltfCanonicalScene3d } from "./gltf-lowering";
import { requiredLoadedPackageDocumentHashes } from "./package-loaded-inputs";
import { loadMotionPackage } from "./package";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import {
  openScene3dGltfMaterialAuthenticatedSource,
} from "./scene-3d-gltf-material-package-route";
import {
  bindScene3dGltfMaterialRenderPlanSceneState,
  prepareScene3dGltfMaterialRenderPlan,
} from "./scene-3d-gltf-material-render-plan";
import type { Scene3dGltfMaterialRenderPlan } from "./scene-3d-gltf-material-render-types";
import type { MotionPackage } from "./types";

export const SCENE3D_GLTF_PBR_FINAL_LOCATOR_SCHEMA = "shellx-motion/scene3d-gltf-pbr-final-locator@1" as const;
export const SCENE3D_GLTF_PBR_FINAL_ROUTE_SCHEMA = "shellx-motion/scene3d-gltf-pbr-final-route@1" as const;

/** A manifest locator only. Every identity used by the renderer is re-read and recomputed. */
export interface Scene3dGltfPbrFinalLocator {
  readonly schema: typeof SCENE3D_GLTF_PBR_FINAL_LOCATOR_SCHEMA;
  readonly sceneLayerId: string;
}

export interface Scene3dGltfPbrFinalRoute {
  readonly schema: typeof SCENE3D_GLTF_PBR_FINAL_ROUTE_SCHEMA;
  readonly packageId: string;
  readonly locator: Scene3dGltfPbrFinalLocator;
  /** Canonical hash of the immutable source-lowered scene3d state selected by this marker. */
  readonly sceneStateSha256: string;
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly renderPlan: Scene3dGltfMaterialRenderPlan;
  readonly rendererCatalogSha256: string;
  readonly fingerprint: string;
}

export type Scene3dGltfPbrFinalRouteResolution =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "present"; readonly route: Scene3dGltfPbrFinalRoute }>;

/** A presence check only: callers must invoke the resolver when this is true. */
export function hasScene3dGltfPbrFinalLocator(value: unknown): boolean {
  return isRecord(value) && isRecord(value.adapter) && Object.hasOwn(value.adapter, "scene3dGltfPbrFinal");
}

/**
 * Reopens the authenticated package before interpreting a present marker. The marker supplies
 * only the selected layer id; all motion, sidecar, receipt, source and renderer identities are
 * reconstructed from loader-owned bytes.
 */
export async function resolveScene3dGltfPbrFinalRoute(
  pkg: MotionPackage,
  rendererCatalogSha256: string,
): Promise<Scene3dGltfPbrFinalRouteResolution> {
  assertHash(rendererCatalogSha256, "PBR renderer catalog identity");
  const callerHashes = requiredLoadedPackageDocumentHashes(pkg, "glTF PBR final route");
  const reopened = await loadMotionPackage(pkg.root);
  const reopenedHashes = requiredLoadedPackageDocumentHashes(reopened, "glTF PBR final route reopen");
  if (pkg.manifest.id !== reopened.manifest.id
    || callerHashes["manifest.json"] !== reopenedHashes["manifest.json"]
    || callerHashes[pkg.manifest.motion] !== reopenedHashes[reopened.manifest.motion]) {
    throw new Error("glTF PBR final route package bytes changed before authenticated reopen.");
  }
  if (!hasScene3dGltfPbrFinalLocator(reopened.manifest.data)) return Object.freeze({ kind: "absent" });
  const locator = parseLocator(reopened.manifest.data);
  const source = await openScene3dGltfMaterialAuthenticatedSource(reopened.root);
  const sourceHashes = requiredLoadedPackageDocumentHashes(source.pkg, "glTF PBR final source reopen");
  if (source.pkg.manifest.id !== reopened.manifest.id
    || sourceHashes["manifest.json"] !== reopenedHashes["manifest.json"]
    || sourceHashes[source.pkg.manifest.motion] !== reopenedHashes[reopened.manifest.motion]) {
    throw new Error("glTF PBR final route package bytes changed before source projection.");
  }
  const sceneStateSha256 = assertScene3dGltfPbrFinalCanonicalSourceSceneState(reopened, locator, source.container);
  const unboundPlan = await prepareScene3dGltfMaterialRenderPlan({
    packageRoot: source.pkg.root,
    packageId: source.pkg.manifest.id,
    declaration: source.declaration,
    container: source.container,
  });
  const renderPlan = bindScene3dGltfMaterialRenderPlanSceneState(unboundPlan, sceneStateSha256);
  assertPlanMatchesScene(reopened, locator, renderPlan);
  const declaration = renderPlan.staticPlan.sidecar.declaration;
  const inputHashes = Object.freeze({
    "scene3d-gltf-pbr-manifest": reopenedHashes["manifest.json"]!,
    "scene3d-gltf-pbr-motion": reopenedHashes[reopened.manifest.motion]!,
    "scene3d-gltf-pbr-source": renderPlan.staticPlan.source.sha256,
    "scene3d-gltf-pbr-sidecar": declaration.sidecarSha256,
    "scene3d-gltf-pbr-sidecar-receipt": declaration.receiptSha256,
    "scene3d-gltf-pbr-declaration": canonicalJsonSha256(declaration),
    "scene3d-gltf-pbr-static-plan": renderPlan.staticPlan.fingerprint,
    "scene3d-gltf-pbr-frame-plan": renderPlan.framePlan.fingerprint,
    "scene3d-gltf-pbr-catalog": rendererCatalogSha256,
    "scene3d-gltf-pbr-scene-state": sceneStateSha256,
  });
  const base = {
    schema: SCENE3D_GLTF_PBR_FINAL_ROUTE_SCHEMA,
    packageId: reopened.manifest.id,
    locator,
    sceneStateSha256,
    inputHashes,
    rendererCatalogSha256,
  };
  return Object.freeze({ kind: "present", route: freezeJson({ ...base, renderPlan, fingerprint: canonicalJsonSha256(base) }) as Scene3dGltfPbrFinalRoute });
}

export function scene3dGltfPbrFinalLocatorManifestData(sceneLayerId: string): Readonly<{ scene3dGltfPbrFinal: Scene3dGltfPbrFinalLocator }> {
  const locator = parseLocator({ adapter: { scene3dGltfPbrFinal: { schema: SCENE3D_GLTF_PBR_FINAL_LOCATOR_SCHEMA, sceneLayerId } } });
  return Object.freeze({ scene3dGltfPbrFinal: locator });
}

function parseLocator(value: unknown): Scene3dGltfPbrFinalLocator {
  const root = exactRecord(value, "Motion package data");
  const adapter = exactRecord(root.adapter, "Motion package glTF adapter metadata");
  const locator = exactRecord(adapter.scene3dGltfPbrFinal, "Motion package glTF PBR final locator");
  if (!sameKeys(locator, ["schema", "sceneLayerId"])
    || locator.schema !== SCENE3D_GLTF_PBR_FINAL_LOCATOR_SCHEMA
    || !identifier(locator.sceneLayerId)) {
    throw new Error("Motion package glTF PBR final locator is invalid.");
  }
  return Object.freeze({ schema: SCENE3D_GLTF_PBR_FINAL_LOCATOR_SCHEMA, sceneLayerId: locator.sceneLayerId });
}

/** The marker route deliberately has no editable scene state until a versioned scene/material ABI does. */
export function assertScene3dGltfPbrFinalCanonicalSourceSceneState(pkg: MotionPackage, locator: Scene3dGltfPbrFinalLocator, container: Parameters<typeof projectGltfCanonicalScene3d>[0]): string {
  const motion = pkg.motion;
  if (motion.width !== 1280 || motion.height !== 720 || motion.fps !== 30 || motion.durationMs !== 3_000
    || !Array.isArray(motion.layers) || motion.layers.length !== 1) {
    throw new Error("glTF PBR final route requires the exact immutable canonical source-lowered scene state (1280x720, 30fps, 3000ms).");
  }
  const layer = motion.layers[0];
  if (!layer || !layer.scene3d) throw new Error("glTF PBR final route requires one immutable material-only scene3d layer.");
  const expected = {
    schema: "shellx-motion/scene3d-gltf-pbr-source-scene@1",
    motion: { width: 1280, height: 720, fps: 30, durationMs: 3_000, background: "#020617" },
    layer: {
      id: "gltf-scene", type: "scene3d", startMs: 0, durationMs: 3_000,
      transform: { x: 0, y: 0, width: 1280, height: 720 },
      scene3d: projectGltfCanonicalScene3d(container).scene3d,
    },
  };
  const actual = {
    schema: "shellx-motion/scene3d-gltf-pbr-source-scene@1",
    motion: { width: motion.width, height: motion.height, fps: motion.fps, durationMs: motion.durationMs, background: motion.background },
    layer,
  };
  if (locator.sceneLayerId !== expected.layer.id || canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("glTF PBR final route requires the exact immutable canonical source-lowered scene state.");
  }
  return canonicalJsonSha256(expected);
}

function assertPlanMatchesScene(pkg: MotionPackage, locator: Scene3dGltfPbrFinalLocator, plan: Scene3dGltfMaterialRenderPlan): void {
  const layer = pkg.motion.layers[0];
  if (!layer?.scene3d || layer.id !== locator.sceneLayerId || plan.staticPlan.primitives.length < 1
    || plan.staticPlan.primitives.length !== layer.scene3d.objects.length) {
    throw new Error("glTF PBR final route scene objects do not match its verified material plan.");
  }
  const expected = new Map(plan.staticPlan.primitives.map((primitive) => [
    `${primitive.source.meshIndex}:${primitive.source.primitiveIndex}`,
    primitive,
  ]));
  if (expected.size !== plan.staticPlan.primitives.length) throw new Error("glTF PBR final route material plan has duplicate primitive identities.");
  const seen = new Set<string>();
  for (const object of layer.scene3d.objects) {
    if (object.primitive !== "mesh" || !object.source || !object.geometry) {
      throw new Error("glTF PBR final route accepts mesh objects only.");
    }
    const key = `${object.source.meshIndex}:${object.source.primitiveIndex}`;
    const primitive = expected.get(key);
    if (!primitive || seen.has(key) || object.source.format !== plan.staticPlan.source.format
      || object.source.materialIndex !== primitive.source.materialIndex
      || object.source.geometrySha256 !== primitive.geometrySha256
      || scene3dMeshGeometrySha256(object.geometry) !== primitive.geometrySha256) {
      throw new Error("glTF PBR final route scene geometry does not match its verified material primitive.");
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) throw new Error("glTF PBR final route did not bind every verified material primitive.");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a plain object.`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(value); }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256.`); }
function freezeJson<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child); Object.freeze(value); } return value; }
