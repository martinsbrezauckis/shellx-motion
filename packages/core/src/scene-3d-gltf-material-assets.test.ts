import { deflateSync } from "node:zlib";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { canonicalJsonSha256 } from "./canonical-json";
import { parseGltfContainer } from "./gltf-container";
import { lowerGltfToMotion } from "./gltf-lowering";
import { hashBuffer } from "./receipts";
import { buildScene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-build";
import {
  publishScene3dGltfMaterialAssets,
  scene3dGltfMaterialAssetManifestData,
  verifyScene3dGltfMaterialAssets,
} from "./scene-3d-gltf-material-assets-package";
import { refuseBrowserScene3dGltfMaterialRender, validateScene3dGltfMaterialRenderCleanup } from "./scene-3d-gltf-material-render-cleanup";
import { bindScene3dGltfMaterialRenderPlanSceneState, prepareScene3dGltfMaterialRenderPlan } from "./scene-3d-gltf-material-render-plan";
import { SCENE_3D_GLTF_MATERIAL_RENDER_CLEANUP_SCHEMA, SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI, SCENE_3D_GLTF_MATERIAL_RENDER_VERTEX_ABI, type Scene3dGltfMaterialRenderPlan } from "./scene-3d-gltf-material-render-types";
import { SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS, SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION } from "./scene-3d-gltf-material-assets-types";

const storage = vi.hoisted(() => ({ files: new Map<string, { bytes: Buffer; sha256: string }>() }));

vi.mock("./package-asset-read", () => ({
  readVerifiedPackageAsset: async (pkg: { root: string }, assetRef: string) => {
    if (!assetRef || assetRef.includes("\\") || assetRef.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Asset path escapes package root: ${assetRef}`);
    const entry = storage.files.get(`${pkg.root}/${assetRef}`);
    if (!entry) throw new Error(`Missing package asset: ${assetRef}`);
    return { bytes: Buffer.from(entry.bytes), byteLength: entry.bytes.byteLength, canonicalPath: `${pkg.root}/${assetRef}`, sha256: entry.sha256 };
  },
}));

vi.mock("./stable-file-read", () => ({
  writeVerifiedBoundedFile: async (path: string, bytes: Buffer, options: { expectedSha256?: string }) => {
    if (storage.files.has(path)) { const error = Object.assign(new Error("exists"), { code: "EEXIST" }); throw error; }
    storage.files.set(path, { bytes: Buffer.from(bytes), sha256: options.expectedSha256! });
    return { bytes: Buffer.from(bytes), byteLength: bytes.byteLength, canonicalPath: path, sha256: options.expectedSha256! };
  },
  readBoundedStableFile: async (path: string) => {
    const entry = storage.files.get(path); if (!entry) throw new Error(`Missing package asset: ${path}`);
    return { bytes: Buffer.from(entry.bytes), byteLength: entry.bytes.byteLength, canonicalPath: path, sha256: entry.sha256 };
  },
}));

describe("admitted scene3d glTF PBR material package sidecar", () => {
  beforeEach(() => storage.files.clear());

  it("persists exact PBR, decoded PNG and UV identities, then resumes and reopens without a renderer fallback", async () => {
    const container = parsed(texturedTriangle());
    const plan = buildScene3dGltfMaterialAssetPlan({ container, packageId: "pkg_scene3d_material", createdAt: "2026-08-16T00:00:00.000Z" });
    const [texture] = plan.document.textures;
    const [material] = plan.document.materials;
    const assetCopy = plan.files.find((file) => file.path === texture.assetRef)!.bytes;
    assetCopy[0] ^= 0xff;

    expect(plan.document).toMatchObject({
      packageId: "pkg_scene3d_material",
      rendererStatus: SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS,
      admission: SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION,
      source: { format: "gltf", sha256: container.sourceSha256 },
      materials: [{
        materialIndex: 0, baseColorFactor: [0.2, 0.5, 1, 1], metallicFactor: 0.37, roughnessFactor: 0.68,
        emissiveFactor: [0.1, 0.1, 0.1], legacyScene3d: { exact: false, losses: ["baseColorFactor", "metallicFactor", "roughnessFactor", "baseColorTexture"] },
      }],
      textures: [{ mimeType: "image/png", encodedSha256: hashBuffer(png()), decodedRgbaByteLength: 4 }],
      texturedPrimitives: [{ materialIndex: 0, texCoord0: { format: "unorm8", count: 3, values: [0, 0, 1, 0, 128 / 255, 1] } }],
    });
    expect(plan.files.find((file) => file.path === texture.assetRef)!.bytes.equals(png())).toBe(true);
    expect(plan.declaration.admissionFingerprint).toBe(canonicalJsonSha256(SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION));
    expect(plan.receipt).toMatchObject({
      operation: "adapter.gltf.scene3d-material-assets.direct-final", status: "passed", lane: "gpu", warnings: [],
      output: {
        rendererStatus: SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS,
        admission: SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION,
        admissionFingerprint: plan.declaration.admissionFingerprint,
        legacyProjectionLosses: plan.document.legacyProjectionLosses,
      },
    });
    expect(Object.isFrozen(plan.document)).toBe(true);
    expect(Object.isFrozen(material.baseColorFactor)).toBe(true);
    expect(Object.isFrozen(plan.document.texturedPrimitives[0].texCoord0.values)).toBe(true);
    expect(scene3dGltfMaterialAssetManifestData(plan).scene3dMaterialAssets).toEqual(plan.declaration);
    expect(() => lower(container)).toThrow(/glTF textures are not supported by the static bounded importer/);

    const root = packageRoot();
    const published = await publishScene3dGltfMaterialAssets(root, plan);
    const resumed = await publishScene3dGltfMaterialAssets(root, plan);
    const reopened = await verifyScene3dGltfMaterialAssets(root, plan.declaration, plan.declaration.packageId);

    expect(published.document.fingerprint).toBe(plan.document.fingerprint);
    expect(resumed).toEqual(published);
    expect(reopened.document).toEqual(plan.document);
  });

  it("binds verified mesh, UV, decoded PNG, exact PBR and required cleanup into the package-internal Browser plan", async () => {
    const container = parsed(texturedTriangle());
    const sidecar = buildScene3dGltfMaterialAssetPlan({ container, packageId: "pkg_render_plan", createdAt: "2026-08-16T00:00:00.000Z" });
    const root = packageRoot();
    const published = await publishScene3dGltfMaterialAssets(root, sidecar);
    const prepared = await prepareScene3dGltfMaterialRenderPlan({ packageRoot: root, packageId: sidecar.declaration.packageId, declaration: sidecar.declaration, container });
    const repeated = await prepareScene3dGltfMaterialRenderPlan({ packageRoot: root, packageId: sidecar.declaration.packageId, declaration: sidecar.declaration, container });
    const [texture] = prepared.textures; const [primitive] = prepared.staticPlan.primitives;
    const mutatedCopy = texture.rgba; mutatedCopy[0] ^= 0xff;

    expect(prepared.staticPlan).toMatchObject({
      vertexAbi: SCENE_3D_GLTF_MATERIAL_RENDER_VERTEX_ABI,
      pbr: { abi: SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI, baseColorTextureFormat: "rgba8unorm-srgb", baseColorTextureTransfer: "srgb-to-linear-hardware", factorSpace: "linear-gltf", brdf: "ggx-smith-schlick-directional@1", ambient: "bounded-diffuse@1", directionalLight: { direction: [-0.4, -0.8, -0.4], color: [1, 1, 1], intensity: 1, ambientDiffuse: 0.15 }, outputTransfer: "linear-to-srgb-explicit" },
      sampler: { addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", mipmaps: "required-generated" },
      budget: { primitiveCount: 1, textureCount: 1, vertexBufferBytes: 96, indexBufferBytes: 12, uniformBufferBytes: 256, decodedTextureBytes: 4, mipmappedTextureBytes: 4, gpuResourceBytes: 368, renderTargetBytes: 3_686_400, depthTargetBytes: 3_686_400, readbackBufferBytes: 3_686_400, frameGpuResourceBytes: 7_373_168, peakGpuResourceBytes: 11_059_568, preparationPeakRgbaSnapshotBytes: 4, cpuSnapshotBytes: 4 },
    });
    expect(primitive).toMatchObject({
      source: { sha256: container.sourceSha256, meshIndex: 0, primitiveIndex: 0, materialIndex: 0, positionAccessorIndex: 0, texCoord0AccessorIndex: 2 },
      vertexCount: 3, indexCount: 3, vertexBufferByteLength: 96, indexBufferByteLength: 12,
      material: { baseColorFactor: [0.2, 0.5, 1, 1], metallicFactor: 0.37, roughnessFactor: 0.68, emissiveFactor: [0.1, 0.1, 0.1], textureIndex: 0, textureResourceId: texture.resourceId },
    });
    expect(primitive.vertices).toEqual([-0.5, -0.5, 0, 0, 0, 1, 0, 0, 0.5, -0.5, 0, 0, 0, 1, 1, 0, 0, 0.5, 0, 0, 0, 1, 128 / 255, 1]);
    expect(texture.rgba.equals(Buffer.from([0x11, 0x22, 0x33, 0xff]))).toBe(true);
    const verifierCopy = published.textureSnapshots[0].rgba; verifierCopy[0] ^= 0xff;
    expect(texture.rgba.equals(Buffer.from([0x11, 0x22, 0x33, 0xff]))).toBe(true);
    expect(prepared.staticPlan.fingerprint).toBe(repeated.staticPlan.fingerprint);
    const sceneStateBound = bindScene3dGltfMaterialRenderPlanSceneState(prepared, "a".repeat(64));
    expect(sceneStateBound.staticPlan).toMatchObject({ sceneStateSha256: "a".repeat(64) });
    expect(sceneStateBound.framePlan).toMatchObject({ sceneStateSha256: "a".repeat(64), staticFingerprint: sceneStateBound.staticPlan.fingerprint });
    expect(sceneStateBound.staticPlan.fingerprint).not.toBe(prepared.staticPlan.fingerprint);
    expect(() => bindScene3dGltfMaterialRenderPlanSceneState(sceneStateBound, "b".repeat(64))).toThrow(/conflicting canonical scene state/);
    expect(refuseBrowserScene3dGltfMaterialRender(prepared)).toMatchObject({ ok: false, code: "browser_scene3d_gltf_material_package_internal_only" });

    const cleanup = cleanupEvidence(prepared);
    expect(validateScene3dGltfMaterialRenderCleanup(prepared, cleanup)).toEqual(cleanup);
    expect(() => validateScene3dGltfMaterialRenderCleanup(prepared, { ...cleanup, releasedCpuSnapshotBytes: 0 }))
      .toThrow(/does not release every planned resource/);
    const altered = texturedTriangle(); (altered.asset as Record<string, unknown>).generator = "different source";
    await expect(prepareScene3dGltfMaterialRenderPlan({ packageRoot: root, packageId: sidecar.declaration.packageId, declaration: sidecar.declaration, container: parsed(altered) }))
      .rejects.toThrow(/does not match the verified sidecar source identity/);
  });

  it("seals selected-scene world transforms and a finite derived camera into the material-only frame", async () => {
    const source = texturedTriangle(); (source.nodes as Record<string, unknown>[])[0]!.translation = [3, -2, 1];
    const container = parsed(source), sidecar = buildScene3dGltfMaterialAssetPlan({ container, packageId: "pkg_render_transform", createdAt: "2026-08-16T00:00:00.000Z" }), root = packageRoot();
    const prepared = await prepareScene3dGltfMaterialRenderPlan({ packageRoot: root, packageId: sidecar.declaration.packageId, declaration: (await publishScene3dGltfMaterialAssets(root, sidecar)).declaration, container });
    expect(prepared.framePlan).toMatchObject({ camera: { viewport: { width: 1280, height: 720 }, projection: "perspective@1", fovDeg: 42, viewProjection: expect.any(Array) }, primitiveBindings: [expect.objectContaining({ modelMatrix: expect.arrayContaining([3]) })] });
    expect(prepared.framePlan.primitiveBindings[0]!.modelMatrix.slice(12, 15)).toEqual([3, -2, 1]);
    expect(prepared.framePlan.camera.viewProjection).not.toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("refuses a selected-scene shared mesh before one primitive identity can overwrite another transform", async () => {
    const source = texturedTriangle();
    source.nodes = [{ mesh: 0, translation: [0, 0, 0] }, { mesh: 0, translation: [4, 0, 0] }];
    (source.scenes as Record<string, unknown>[])[0]!.nodes = [0, 1];
    const container = parsed(source);
    const sidecar = buildScene3dGltfMaterialAssetPlan({ container, packageId: "pkg_shared_mesh", createdAt: "2026-08-16T00:00:00.000Z" });
    const root = packageRoot();
    const declaration = (await publishScene3dGltfMaterialAssets(root, sidecar)).declaration;
    await expect(prepareScene3dGltfMaterialRenderPlan({ packageRoot: root, packageId: declaration.packageId, declaration, container }))
      .rejects.toThrow(/instanced by multiple selected nodes; the material-only PBR frame ABI does not support mesh reuse/);
  });

  it("refuses JPEG until an exact bounded decoder exists, never using header-only image identity", () => {
    const source = texturedTriangle({ imageMimeType: "image/jpeg", imageBytes: jpeg() });
    expect(() => buildScene3dGltfMaterialAssetPlan({ container: parsed(source), packageId: "pkg_jpeg" }))
      .toThrow(/requires PNG; JPEG has no bounded decoded-RGBA ABI yet/);
  });

  it("refuses short and oversized inflated PNG payloads before binding a decoded identity", () => {
    const short = texturedTriangle({ imageBytes: png(Buffer.from([0])) });
    expect(() => buildScene3dGltfMaterialAssetPlan({ container: parsed(short), packageId: "pkg_short_png" }))
      .toThrow(/must inflate to exactly 4 bytes.*received 1/);

    const oversized = texturedTriangle({ imageBytes: png(Buffer.from([0, 0x11, 0x22, 0x33, 0x44])) });
    expect(() => buildScene3dGltfMaterialAssetPlan({ container: parsed(oversized), packageId: "pkg_oversized_png" }))
      .toThrow(/inflates past the 4 bytes/);
  });

  it("fails closed on declaration path traversal, sidecar tamper, and encoded asset tamper", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_tamper", createdAt: "2026-08-16T00:00:00.000Z" });
    const root = packageRoot();
    await publishScene3dGltfMaterialAssets(root, plan);
    await expect(verifyScene3dGltfMaterialAssets(root, { ...plan.declaration, sidecarRef: "../outside.json" } as never, plan.declaration.packageId))
      .rejects.toThrow(/declaration is invalid/);
    storage.files.set(`${root}/${plan.declaration.sidecarRef}`, { bytes: Buffer.from("{}\n"), sha256: hashBuffer(Buffer.from("{}\n")) });
    await expect(verifyScene3dGltfMaterialAssets(root, plan.declaration, plan.declaration.packageId)).rejects.toThrow(/sidecar hash does not match/);

    const secondRoot = packageRoot();
    await publishScene3dGltfMaterialAssets(secondRoot, plan);
    storage.files.set(`${secondRoot}/${plan.document.textures[0].assetRef}`, { bytes: Buffer.from("tampered"), sha256: hashBuffer(Buffer.from("tampered")) });
    await expect(verifyScene3dGltfMaterialAssets(secondRoot, plan.declaration, plan.declaration.packageId)).rejects.toThrow(/encoded identity mismatch/);
  });

  it("rejects a pre-existing different asset snapshot rather than accepting a substituted destination", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_link", createdAt: "2026-08-16T00:00:00.000Z" });
    const root = packageRoot();
    const assetPath = `${root}/${plan.document.textures[0].assetRef}`;
    storage.files.set(assetPath, { bytes: Buffer.from("forged"), sha256: hashBuffer(Buffer.from("forged")) });

    await expect(publishScene3dGltfMaterialAssets(root, plan)).rejects.toThrow(/already exists with different bytes/);
  });

  it("cross-binds every primitive source and repeated texture asset record to the sidecar", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_cross_bind", createdAt: "2026-08-16T00:00:00.000Z" });
    const sourceRoot = packageRoot();
    await publishScene3dGltfMaterialAssets(sourceRoot, plan);
    const wrongSource = replaceSidecar(sourceRoot, plan, (document) => {
      const primitive = (document.texturedPrimitives as Record<string, unknown>[])[0];
      primitive.sourceSha256 = "f".repeat(64);
      reseal(primitive);
    });
    await expect(verifyScene3dGltfMaterialAssets(sourceRoot, wrongSource, plan.declaration.packageId)).rejects.toThrow(/primitive 0 source identity does not match/);

    const textureRoot = packageRoot();
    await publishScene3dGltfMaterialAssets(textureRoot, plan);
    const contradictoryDuplicate = replaceSidecar(textureRoot, plan, (document) => {
      const original = (document.textures as Record<string, unknown>[])[0];
      (document.textures as Record<string, unknown>[]).push({ ...original, textureIndex: 1, width: 2, decodedRgbaByteLength: 8 });
    });
    await expect(verifyScene3dGltfMaterialAssets(textureRoot, contradictoryDuplicate, plan.declaration.packageId)).rejects.toThrow(/texture 1 decoded RGBA identity mismatch/);
  });

  it("enforces the package RGBA ceiling from the actual PNG IHDR before reopen inflation", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_actual_png_ceiling", createdAt: "2026-08-16T00:00:00.000Z" });
    const root = packageRoot();
    await publishScene3dGltfMaterialAssets(root, plan);
    const actual = png(Buffer.from([0]), 3_840, 2_160); const encodedSha256 = hashBuffer(actual);
    const declaration = replaceSidecar(root, plan, (document) => {
      const texture = (document.textures as Record<string, unknown>[])[0]; const assetRef = `assets/scene3d/gltf-textures/${encodedSha256}.png`;
      texture.assetRef = assetRef; texture.encodedSha256 = encodedSha256; texture.encodedByteLength = actual.byteLength;
      const materialTexture = ((document.materials as Record<string, unknown>[])[0].baseColorTexture as Record<string, unknown>);
      materialTexture.assetRef = assetRef;
      const primitive = (document.texturedPrimitives as Record<string, unknown>[])[0];
      const primitiveTexture = ((primitive.material as Record<string, unknown>).baseColorTexture as Record<string, unknown>);
      primitiveTexture.sha256 = encodedSha256; primitiveTexture.byteLength = actual.byteLength;
      reseal(primitive);
    });
    const assetRef = `assets/scene3d/gltf-textures/${encodedSha256}.png`;
    storage.files.set(`${root}/${assetRef}`, { bytes: actual, sha256: encodedSha256 });
    await expect(verifyScene3dGltfMaterialAssets(root, declaration, plan.declaration.packageId))
      .rejects.toThrow(/decoded RGBA byte ceiling 16777216.*refusing before IDAT inflation or pixel allocation/);
  });

  it("requires receipt schema, adapter lane, and exact source and texture input hashes", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_receipt", createdAt: "2026-08-16T00:00:00.000Z" });
    const cases: readonly [string, (receipt: Record<string, unknown>) => void][] = [
      ["schema", (receipt) => { receipt.schema = "shellx-motion/receipt@999"; }],
      ["lane", (receipt) => { receipt.lane = "renderer"; }],
      ["input hashes", (receipt) => { receipt.inputHashes = { source: "0".repeat(64) }; }],
    ];
    for (const [, mutate] of cases) {
      const root = packageRoot();
      await publishScene3dGltfMaterialAssets(root, plan);
      const declaration = replaceReceipt(root, plan.declaration, mutate);
      await expect(verifyScene3dGltfMaterialAssets(root, declaration, plan.declaration.packageId)).rejects.toThrow(/receipt does not bind the admitted direct-final sidecar identity/);
    }
  });

  it("does not admit legacy pending receipts or sidecars as GPU direct-final evidence", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_old_pending", createdAt: "2026-08-16T00:00:00.000Z" });
    const sidecarRoot = packageRoot();
    await publishScene3dGltfMaterialAssets(sidecarRoot, plan);
    const staleSidecar = replaceSidecar(sidecarRoot, plan, (document) => {
      document.schema = "shellx-motion/scene3d-gltf-material-assets@1";
      document.rendererStatus = "pending";
      delete document.admission;
      document.legacyLosses = document.legacyProjectionLosses;
      delete document.legacyProjectionLosses;
    });
    await expect(verifyScene3dGltfMaterialAssets(sidecarRoot, staleSidecar, plan.declaration.packageId))
      .rejects.toThrow(/sidecar schema or renderer status is invalid/);

    const receiptRoot = packageRoot();
    await publishScene3dGltfMaterialAssets(receiptRoot, plan);
    const staleReceipt = replaceReceipt(receiptRoot, plan.declaration, (receipt) => {
      receipt.operation = "adapter.gltf.scene3d-material-assets";
      receipt.status = "warning";
      receipt.lane = "adapter";
      receipt.warnings = ["live textured import remains refused"];
      (receipt.output as Record<string, unknown>).rendererStatus = "pending";
    });
    await expect(verifyScene3dGltfMaterialAssets(receiptRoot, staleReceipt, plan.declaration.packageId))
      .rejects.toThrow(/receipt does not bind the admitted direct-final sidecar identity/);
  });

  it("requires package-root callers to name the identity bound by declaration, sidecar, and receipt", async () => {
    const plan = buildScene3dGltfMaterialAssetPlan({ container: parsed(texturedTriangle()), packageId: "pkg_original", createdAt: "2026-08-16T00:00:00.000Z" });
    const originalRoot = packageRoot();
    const copiedRoot = packageRoot();
    await publishScene3dGltfMaterialAssets(originalRoot, plan);
    await publishScene3dGltfMaterialAssets(copiedRoot, plan);
    await expect(verifyScene3dGltfMaterialAssets(copiedRoot, plan.declaration, "pkg_other"))
      .rejects.toThrow(/declaration does not match the expected package identity/);
    await expect(verifyScene3dGltfMaterialAssets(originalRoot, { ...plan.declaration, packageId: "pkg_other" }, "pkg_other"))
      .rejects.toThrow(/sidecar does not match the expected package identity/);

    const receiptMismatch = replaceReceipt(originalRoot, plan.declaration, (receipt) => { receipt.packageId = "pkg_other"; });
    await expect(verifyScene3dGltfMaterialAssets(originalRoot, receiptMismatch, plan.declaration.packageId))
      .rejects.toThrow(/receipt does not bind the admitted direct-final sidecar identity/);
  });
});

let packageRootIndex = 0;
function packageRoot(): string { packageRootIndex += 1; return `package-${packageRootIndex}`; }

function lower(container: ReturnType<typeof parseGltfContainer>) {
  return lowerGltfToMotion({ adapterId: "adapter.gltf", sourcePath: "source/normalized.gltf.json", sourceText: container.jsonText, normalizedPackagePath: "pkg_live", container, createdBy: "test", createdAt: "2026-08-16T00:00:00.000Z" });
}

function parsed(source: Record<string, unknown>) { return parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf"); }

function replaceSidecar(
  root: string,
  plan: ReturnType<typeof buildScene3dGltfMaterialAssetPlan>,
  mutate: (document: Record<string, unknown>) => void,
) {
  const document = JSON.parse(JSON.stringify(plan.document)) as Record<string, unknown>;
  mutate(document); reseal(document);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"); const sidecarSha256 = hashBuffer(bytes);
  storage.files.set(`${root}/${plan.declaration.sidecarRef}`, { bytes, sha256: sidecarSha256 });
  return { ...plan.declaration, sidecarSha256, fingerprint: document.fingerprint as string };
}

function replaceReceipt(
  root: string,
  declaration: ReturnType<typeof buildScene3dGltfMaterialAssetPlan>["declaration"],
  mutate: (receipt: Record<string, unknown>) => void,
) {
  const entry = storage.files.get(`${root}/${declaration.receiptRef}`)!;
  const receipt = JSON.parse(entry.bytes.toString("utf8")) as Record<string, unknown>;
  mutate(receipt);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"); const receiptSha256 = hashBuffer(bytes);
  storage.files.set(`${root}/${declaration.receiptRef}`, { bytes, sha256: receiptSha256 });
  return { ...declaration, receiptSha256 };
}

function reseal(value: Record<string, unknown>): void {
  const { fingerprint: _fingerprint, ...base } = value;
  value.fingerprint = canonicalJsonSha256(base);
}

function cleanupEvidence(plan: Scene3dGltfMaterialRenderPlan): Record<string, unknown> {
  const cleanup = {
    schema: SCENE_3D_GLTF_MATERIAL_RENDER_CLEANUP_SCHEMA,
    frameFingerprint: plan.framePlan.fingerprint,
    destroyedTextureResourceIds: [...plan.framePlan.cleanup.textureResourceIds],
    destroyedVertexBufferPrimitiveIds: [...plan.framePlan.cleanup.primitiveIds],
    destroyedIndexBufferPrimitiveIds: [...plan.framePlan.cleanup.primitiveIds],
    destroyedUniformBufferPrimitiveIds: [...plan.framePlan.cleanup.primitiveIds],
    destroyedRenderTargetIds: [...plan.framePlan.cleanup.renderTargetIds],
    releasedCpuSnapshotBytes: plan.framePlan.cleanup.cpuSnapshotBytes,
    remainingGpuResourceBytes: 0,
  };
  return { ...cleanup, fingerprint: canonicalJsonSha256(cleanup) };
}

function texturedTriangle(options: { imageMimeType?: "image/png" | "image/jpeg"; imageBytes?: Buffer } = {}): Record<string, unknown> {
  const geometry = Buffer.alloc(42); [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4)); [0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
  const uv = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 128, 255, 0, 0]); const binary = Buffer.concat([geometry, Buffer.alloc(2), uv]);
  const imageMimeType = options.imageMimeType ?? "image/png"; const imageBytes = options.imageBytes ?? png();
  return {
    asset: { version: "2.0", generator: "PBR package material test" },
    buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: uv.byteLength, byteStride: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC2" }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 1, 1], metallicFactor: 0.37, roughnessFactor: 0.68, baseColorTexture: { index: 0 } }, emissiveFactor: [0.1, 0.1, 0.1] }],
    textures: [{ source: 0 }], images: [{ uri: `data:${imageMimeType};base64,${imageBytes.toString("base64")}` }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
}

function png(inflated = Buffer.from([0, 0x11, 0x22, 0x33]), width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(inflated)), pngChunk("IEND", Buffer.alloc(0))]);
}

function jpeg(): Buffer { return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9]); }
function pngChunk(type: string, data: Buffer): Buffer { const chunk = Buffer.alloc(12 + data.byteLength); chunk.writeUInt32BE(data.byteLength, 0); chunk.write(type, 4, "ascii"); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk, 4, data.byteLength + 4), data.byteLength + 8); return chunk; }
function crc32(bytes: Buffer, offset: number, length: number): number { let crc = 0xffff_ffff; for (let index = offset; index < offset + length; index += 1) { crc ^= bytes[index]; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0); } return (crc ^ 0xffff_ffff) >>> 0; }
