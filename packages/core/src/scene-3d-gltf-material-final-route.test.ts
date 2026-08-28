import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { parseGltfContainer } from "./gltf-container";
import { lowerGltfToMotion, projectGltfCanonicalScene3d } from "./gltf-lowering";
import { loadMotionPackage } from "./package";
import { encodeRgbaPng } from "./quality";
import { buildScene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-build";
import { assertScene3dGltfPbrFinalCanonicalSourceSceneState, scene3dGltfPbrFinalLocatorManifestData, hasScene3dGltfPbrFinalLocator, resolveScene3dGltfPbrFinalRoute } from "./scene-3d-gltf-material-final-route";
import type { MotionPackage } from "./types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("authenticated glTF PBR final marker route", () => {
  const packageFixtureIt = process.env.MOTION_GLTF_PACKAGE_REOPEN_FIXTURE === "1" ? it : it.skip;
  it("keeps the persisted marker declarative and detects only its own adapter key", () => {
    const data = scene3dGltfPbrFinalLocatorManifestData("gltf-scene");
    expect(data).toEqual({ scene3dGltfPbrFinal: { schema: "shellx-motion/scene3d-gltf-pbr-final-locator@1", sceneLayerId: "gltf-scene" } });
    expect(Object.isFrozen(data.scene3dGltfPbrFinal)).toBe(true);
    expect(hasScene3dGltfPbrFinalLocator({ adapter: data })).toBe(true);
    expect(hasScene3dGltfPbrFinalLocator({ adapter: { scene3dGltfPbrFinal: undefined } })).toBe(true);
    expect(hasScene3dGltfPbrFinalLocator({ adapter: {} })).toBe(false);
  });

  it("requires every material-only scene field to equal the canonical source-lowered projection", () => {
    const source = gltf(); ((source.meshes as Record<string, unknown>[])[0]!.primitives as unknown[]).push({ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 });
    const container = parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");
    const locator = scene3dGltfPbrFinalLocatorManifestData("gltf-scene").scene3dGltfPbrFinal;
    const base = { root: "/canonical-source-scene", manifest: {}, motion: motion(container) } as unknown as MotionPackage;
    const stateSha256 = assertScene3dGltfPbrFinalCanonicalSourceSceneState(base, locator, container);
    expect(stateSha256).toMatch(/^[a-f0-9]{64}$/);
    const cases: readonly [string, (pkg: MotionPackage) => void][] = [
      ["object identity", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects[0]!.id = "edited-object"; }],
      ["object order", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects.reverse(); }],
      ["object geometry", (pkg) => { const object = pkg.motion.layers[0]!.scene3d!.objects[0]!; if (object.primitive === "mesh") object.geometry.positions[0] = 0.25; }],
      ["object position", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects[0]!.position[0] = 2; }],
      ["object rotation", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects[0]!.rotationDeg[1] = 3; }],
      ["object scale", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects[0]!.scale = 2; }],
      ["legacy color", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects[0]!.color = "#ffffff"; }],
      ["legacy emissive", (pkg) => { pkg.motion.layers[0]!.scene3d!.objects[0]!.emissive = 1; }],
      ["legacy material projection", (pkg) => { const object = pkg.motion.layers[0]!.scene3d!.objects[0]!; if (object.primitive === "mesh") object.source.materialIndex = 99; }],
      ["scene camera", (pkg) => { pkg.motion.layers[0]!.scene3d!.camera.fovDeg = 41; }],
      ["scene lighting", (pkg) => { pkg.motion.layers[0]!.scene3d!.lighting.intensity = 1; }],
      ["scene background", (pkg) => { pkg.motion.layers[0]!.scene3d!.backgroundColor = "#000000"; }],
      ["layer transform", (pkg) => { pkg.motion.layers[0]!.transform!.x = 1; }],
      ["motion background", (pkg) => { pkg.motion.background = "#000000"; }],
      ["motion frame rate", (pkg) => { pkg.motion.fps = 24; }],
      ["motion duration", (pkg) => { pkg.motion.durationMs = 1_000; }],
    ];
    for (const [field, mutate] of cases) {
      const altered = structuredClone(base) as MotionPackage;
      mutate(altered);
      expect(() => assertScene3dGltfPbrFinalCanonicalSourceSceneState(altered, locator, container), field)
        .toThrow(/exact immutable canonical source-lowered scene state/);
    }
  });

  it("keeps the no-marker legacy lowering scene payload byte-identical to its canonical projection", () => {
    const source = gltf();
    delete source.textures; delete source.images;
    const material = (source.materials as Record<string, unknown>[])[0]!;
    material.pbrMetallicRoughness = { metallicFactor: 0.5, roughnessFactor: 0.5 };
    const primitive = ((source.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!;
    delete (primitive.attributes as Record<string, unknown>).TEXCOORD_0;
    const container = parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");
    const lowered = lowerGltfToMotion({ adapterId: "adapter.gltf", sourcePath: "source/normalized.gltf.json", sourceText: container.jsonText, normalizedPackagePath: "pkg_legacy", container, createdAt: "2026-08-16T00:00:00.000Z" });
    expect(hasScene3dGltfPbrFinalLocator({ adapter: {} })).toBe(false);
    expect(canonicalJson(lowered.motion.layers[0]!.scene3d)).toBe(canonicalJson(projectGltfCanonicalScene3d(container).scene3d));
  });

  packageFixtureIt("uses the marker only as a locator and cross-binds reopened package and renderer identities", async () => {
    const built = await fixture(true), pkg = await loadMotionPackage(built.root);
    const resolved = await resolveScene3dGltfPbrFinalRoute(pkg, "a".repeat(64));
    expect(resolved.kind).toBe("present");
    if (resolved.kind !== "present") throw new Error("expected material route");
    expect(resolved.route.packageId).toBe(built.packageId);
    expect(resolved.route.locator.sceneLayerId).toBe("gltf-scene");
    expect(resolved.route.inputHashes["scene3d-gltf-pbr-catalog"]).toBe("a".repeat(64));
    expect(resolved.route.inputHashes["scene3d-gltf-pbr-scene-state"]).toBe(resolved.route.sceneStateSha256);
    expect(resolved.route.inputHashes["scene3d-gltf-pbr-static-plan"]).toBe(resolved.route.renderPlan.staticPlan.fingerprint);
    expect(resolved.route.renderPlan.staticPlan.sceneStateSha256).toBe(resolved.route.sceneStateSha256);
    expect(resolved.route.renderPlan.framePlan.sceneStateSha256).toBe(resolved.route.sceneStateSha256);
    expect(Object.isFrozen(resolved.route)).toBe(true);
  });

  packageFixtureIt("leaves no-marker packages on the legacy branch and refuses a marker after package bytes change", async () => {
    const legacy = await fixture(false), legacyPkg = await loadMotionPackage(legacy.root);
    expect(hasScene3dGltfPbrFinalLocator(legacyPkg.manifest.data)).toBe(false);
    await expect(resolveScene3dGltfPbrFinalRoute(legacyPkg, "b".repeat(64))).resolves.toEqual({ kind: "absent" });

    const marked = await fixture(true), stale = await loadMotionPackage(marked.root);
    await writeFile(join(marked.root, "manifest.json"), `${JSON.stringify({ ...marked.manifest, name: "changed" })}\n`, "utf8");
    await expect(resolveScene3dGltfPbrFinalRoute(stale, "b".repeat(64))).rejects.toThrow(/package bytes changed/);
  });

  packageFixtureIt("fails closed on a present malformed marker", async () => {
    const built = await fixture(true);
    const manifest = { ...built.manifest, data: { adapter: { ...((built.manifest.data as { adapter: Record<string, unknown> }).adapter), scene3dGltfPbrFinal: { schema: "wrong", sceneLayerId: "gltf-scene" } } } };
    await writeFile(join(built.root, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const pkg = await loadMotionPackage(built.root);
    await expect(resolveScene3dGltfPbrFinalRoute(pkg, "c".repeat(64))).rejects.toThrow(/locator is invalid/);
  });
});

async function fixture(marked: boolean): Promise<{ root: string; packageId: string; manifest: Record<string, unknown> }> {
  const root = join(process.cwd(), `.shellx-motion-gltf-pbr-final-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`); roots.push(root);
  const packageId = "pkg_pbr_final";
  const bytes = Buffer.from(JSON.stringify(gltf()), "utf8"), container = parseGltfContainer(bytes, "gltf");
  const assets = buildScene3dGltfMaterialAssetPlan({ container, packageId, createdAt: "2026-08-16T00:00:00.000Z" });
  const sourceRef = "source/normalized.gltf.json";
  await write(root, sourceRef, bytes); for (const file of assets.files) await write(root, file.path, file.bytes);
  const adapter = {
    id: "adapter.gltf", source: sourceRef, sourceSha256: container.sourceSha256,
    container: { schema: "shellx-motion/gltf-source@1", format: "gltf" }, scene3dMaterialAssets: assets.declaration,
    ...(marked ? scene3dGltfPbrFinalLocatorManifestData("gltf-scene") : {}),
  };
  const manifest: Record<string, unknown> = { schema: "shellx-motion/package-manifest@1", id: packageId, name: "PBR final", motion: "motion.json", assets: [sourceRef, ...assets.manifestAssets], sourceApp: "shellx-motion", compatibility: { lanes: ["browser"], hosts: ["motion"] }, data: { adapter } };
  await writeFile(join(root, "motion.json"), `${JSON.stringify(motion(container))}\n`, "utf8");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  return { root, packageId, manifest };
}

function motion(container: ReturnType<typeof parseGltfContainer>): Record<string, unknown> {
  return { schema: "shellx-motion/motion@1", id: "motion_pbr_final", name: "PBR final", durationMs: 3000, fps: 30, width: 1280, height: 720, background: "#020617", layers: [{ id: "gltf-scene", type: "scene3d", startMs: 0, durationMs: 3000, transform: { x: 0, y: 0, width: 1280, height: 720 }, scene3d: projectGltfCanonicalScene3d(container).scene3d }], assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" } };
}
async function write(root: string, ref: string, bytes: Buffer): Promise<void> { const path = join(root, ref); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); }
function gltf(): Record<string, unknown> {
  const geometry = Buffer.alloc(42); [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4)); [0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
  const uv = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 128, 255, 0, 0]), binary = Buffer.concat([geometry, Buffer.alloc(2), uv]), image = encodeRgbaPng(1, 1, Buffer.from([0x11, 0x22, 0x33, 0xff]));
  return { asset: { version: "2.0" }, buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: uv.byteLength, byteStride: 4 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC2" }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.5, roughnessFactor: 0.5 } }], textures: [{ source: 0 }], images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }], meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
}
