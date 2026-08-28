import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import {
  SCENE_3D_GLTF_MATERIAL_RENDER_CLEANUP_SCHEMA,
  type Scene3dGltfMaterialBrowserRefusal,
  type Scene3dGltfMaterialRenderCleanupEvidence,
  type Scene3dGltfMaterialRenderPlan,
} from "./scene-3d-gltf-material-render-types";

/**
 * Validates renderer-produced terminal cleanup evidence. No current Browser renderer can produce
 * this evidence: the package-internal Browser route supplies it; this function never substitutes
 * a claim for a public importer or renderer.
 */
export function validateScene3dGltfMaterialRenderCleanup(
  plan: Scene3dGltfMaterialRenderPlan,
  value: unknown,
): Scene3dGltfMaterialRenderCleanupEvidence {
  const evidence = record(value, "scene3d glTF material render cleanup evidence");
  const allowed = ["schema", "frameFingerprint", "destroyedTextureResourceIds", "destroyedVertexBufferPrimitiveIds", "destroyedIndexBufferPrimitiveIds", "destroyedUniformBufferPrimitiveIds", "destroyedRenderTargetIds", "releasedCpuSnapshotBytes", "remainingGpuResourceBytes", "fingerprint"];
  if (Object.keys(evidence).some((key) => !allowed.includes(key)) || evidence.schema !== SCENE_3D_GLTF_MATERIAL_RENDER_CLEANUP_SCHEMA || evidence.frameFingerprint !== plan.framePlan.fingerprint
    || !sameIds(evidence.destroyedTextureResourceIds, plan.framePlan.cleanup.textureResourceIds)
    || !sameIds(evidence.destroyedVertexBufferPrimitiveIds, plan.framePlan.cleanup.primitiveIds)
    || !sameIds(evidence.destroyedIndexBufferPrimitiveIds, plan.framePlan.cleanup.primitiveIds)
    || !sameIds(evidence.destroyedUniformBufferPrimitiveIds, plan.framePlan.cleanup.primitiveIds)
    || !sameIds(evidence.destroyedRenderTargetIds, plan.framePlan.cleanup.renderTargetIds)
    || evidence.releasedCpuSnapshotBytes !== plan.framePlan.cleanup.cpuSnapshotBytes || evidence.remainingGpuResourceBytes !== 0) {
    throw new Error("scene3d glTF material render cleanup evidence does not release every planned resource.");
  }
  const { fingerprint, ...base } = evidence;
  if (typeof fingerprint !== "string" || canonicalJsonSha256(base) !== fingerprint) throw new Error("scene3d glTF material render cleanup evidence fingerprint is invalid.");
  return freezeJson(evidence) as unknown as Scene3dGltfMaterialRenderCleanupEvidence;
}

/** Public Browser frame APIs remain closed to this package-internal PBR route. */
export function refuseBrowserScene3dGltfMaterialRender(plan: Scene3dGltfMaterialRenderPlan): Scene3dGltfMaterialBrowserRefusal {
  if (plan.framePlan.renderer.status !== "package-internal" || plan.framePlan.renderer.route !== "browser.scene3d-gltf-pbr-package-internal@1") {
    throw new Error("scene3d glTF material render plan has an invalid renderer admission state.");
  }
  return Object.freeze({
    ok: false,
    code: "browser_scene3d_gltf_material_package_internal_only",
    message: "The verified glTF PBR plan is available only to the package-internal Browser route; public Browser and Debug import paths remain closed.",
  });
}

function sameIds(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return false;
  const actual = [...value].sort(compareCodeUnits); const wanted = [...expected].sort(compareCodeUnits);
  return actual.length === wanted.length && actual.every((id, index) => id === wanted[index]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
