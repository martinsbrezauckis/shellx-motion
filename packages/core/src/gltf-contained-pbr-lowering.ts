import { buildScene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-build";
import { assertGltfContainedPbrStaticFeatureSubset } from "./gltf-contained-pbr-validation";
import { lowerGltfToMotion, preflightGltfCanonicalScene, type GltfLoweringInput, type GltfLoweringResult } from "./gltf-lowering";
import type { ParsedGltfContainer } from "./gltf-types";
import type { Scene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-types";

/** Opaque internal capability minted only alongside a freshly validated contained-PNG PBR plan. */
export interface GltfContainedPbrLoweringAuthority { readonly __opaqueContainedPbrLoweringAuthority: unique symbol }

export interface GltfContainedPbrLoweringAdmission {
  readonly plan: Scene3dGltfMaterialAssetPlan;
  readonly authority: GltfContainedPbrLoweringAuthority;
}

interface AdmissionFacts {
  readonly packageId: string;
  readonly sourceSha256: string;
  readonly fingerprint: string;
  readonly sidecarSha256: string;
  readonly declarationFingerprint: string;
  readonly receiptSha256: string;
  readonly jsonSha256: string;
  readonly materialReceiptCreatedAt: string;
}

const admissions = new WeakMap<object, AdmissionFacts>();

/**
 * Builds the exact contained-PNG material plan and mints an unforgeable lowering authority for
 * this source/package pair. The public glTF lowerer is deliberately not widened.
 */
export function admitGltfContainedPbrLowering(input: {
  readonly container: ParsedGltfContainer;
  readonly packageId: string;
  readonly createdAt?: string;
}): GltfContainedPbrLoweringAdmission {
  // Keep the established contained-PBR feature refusal ahead of scene-specific errors while still
  // running the allocation-free scene preflight before material descriptor construction.
  assertGltfContainedPbrStaticFeatureSubset(input.container);
  const projectedObjects = preflightGltfCanonicalScene(input.container).plans.length;
  const plan = buildScene3dGltfMaterialAssetPlan(input);
  if (plan.document.textures.length === 0 || plan.document.texturedPrimitives.length === 0) {
    throw new Error("Contained glTF PBR lowering requires a base-color PNG texture bound to at least one scene primitive.");
  }
  if (plan.document.texturedPrimitives.length !== projectedObjects) {
    throw new Error("Contained glTF PBR lowering requires every canonical scene primitive to carry the verified base-color material route.");
  }
  const authority = Object.freeze({}) as GltfContainedPbrLoweringAuthority;
  admissions.set(authority, facts(plan, input.container));
  return Object.freeze({ plan, authority });
}

/**
 * Rebuilds and cross-checks the original material plan before projecting its legacy scene3d view.
 * It bypasses only the public lowerer's top-level texture/image refusal; all other feature checks
 * still run in `lowerGltfToMotion` and the original source identity is retained in the authority.
 */
export function lowerAdmittedGltfContainedPbrToMotion(
  input: GltfLoweringInput,
  authority: GltfContainedPbrLoweringAuthority,
): GltfLoweringResult {
  const admitted = admissions.get(authority as unknown as object);
  if (!admitted) throw new Error("Contained glTF PBR lowering requires an opaque authority minted by exact material-plan admission.");
  if (input.normalizedPackagePath !== admitted.packageId || input.container.sourceSha256 !== admitted.sourceSha256) {
    throw new Error("Contained glTF PBR lowering authority does not match the package or source identity.");
  }
  if (input.sourceText !== input.container.jsonText) {
    throw new Error("Contained glTF PBR lowering input text does not match its admitted normalized source.");
  }
  const rebuilt = buildScene3dGltfMaterialAssetPlan({
    container: input.container,
    packageId: input.normalizedPackagePath,
    createdAt: admitted.materialReceiptCreatedAt,
  });
  const actual = facts(rebuilt, input.container);
  if (actual.fingerprint !== admitted.fingerprint
    || actual.sidecarSha256 !== admitted.sidecarSha256
    || actual.declarationFingerprint !== admitted.declarationFingerprint
    || actual.receiptSha256 !== admitted.receiptSha256
    || actual.jsonSha256 !== admitted.jsonSha256) {
    throw new Error("Contained glTF PBR lowering source no longer matches its admitted material plan.");
  }
  return lowerGltfToMotion({ ...input, container: legacyProjectionContainer(input.container) });
}

function facts(plan: Scene3dGltfMaterialAssetPlan, container: ParsedGltfContainer): AdmissionFacts {
  return Object.freeze({
    packageId: plan.declaration.packageId,
    sourceSha256: plan.document.source.sha256,
    fingerprint: plan.document.fingerprint,
    sidecarSha256: plan.declaration.sidecarSha256,
    declarationFingerprint: plan.declaration.fingerprint,
    receiptSha256: plan.declaration.receiptSha256,
    jsonSha256: canonicalJsonSha256(container.json),
    materialReceiptCreatedAt: plan.receipt.createdAt,
  });
}

function legacyProjectionContainer(container: ParsedGltfContainer): ParsedGltfContainer {
  return { ...container, json: { ...container.json, textures: [], images: [] } };
}
import { canonicalJsonSha256 } from "./canonical-json";
