import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGltfContainer } from "./gltf-container";
import { encodeRgbaPng } from "./quality";
import { buildScene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-build";
import { prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage } from "./scene-3d-gltf-material-package-route";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("authenticated glTF material package reopen", () => {
  const reopenFixtureIt = process.env.MOTION_GLTF_PACKAGE_REOPEN_FIXTURE === "1" ? it : it.skip;
  reopenFixtureIt("derives the render-plan package identity from the loaded manifest and refuses a copied declaration", async () => {
    const fixture = await packageFixture();
    const reopened = await prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage(fixture.root);
    expect(reopened.staticPlan.sidecar.declaration.packageId).toBe(fixture.packageId);
    expect(reopened.framePlan.renderer).toEqual({ target: "browser-webgpu", status: "package-internal", route: "browser.scene3d-gltf-pbr-package-internal@1" });
    const manifest = JSON.parse(await readFile(join(fixture.root, "manifest.json"), "utf8")) as { data: { adapter: { scene3dMaterialAssets: Record<string, unknown> } } };
    manifest.data.adapter.scene3dMaterialAssets = { ...manifest.data.adapter.scene3dMaterialAssets, packageId: "copied-package" };
    await writeFile(join(fixture.root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage(fixture.root)).rejects.toThrow(/does not match the expected package identity/);
  });
});

async function packageFixture(): Promise<{ root: string; packageId: string }> {
  const root = join(process.cwd(), `.shellx-motion-gltf-pbr-package-${process.pid}-${Date.now()}`); roots.push(root); const packageId = "pkg_pbr_fixture";
  const source = gltf(); const bytes = Buffer.from(JSON.stringify(source), "utf8"), container = parseGltfContainer(bytes, "gltf");
  const plan = buildScene3dGltfMaterialAssetPlan({ container, packageId, createdAt: "2026-08-16T00:00:00.000Z" });
  const sourceRef = "source/normalized.gltf.json";
  await write(root, sourceRef, bytes);
  for (const file of plan.files) await write(root, file.path, file.bytes);
  const manifest: Record<string, unknown> = { schema: "shellx-motion/package-manifest@1", id: packageId, name: "PBR Fixture", motion: "motion.json", assets: [sourceRef, ...plan.manifestAssets], sourceApp: "shellx-motion", compatibility: { lanes: ["browser"], hosts: ["motion"] }, data: { adapter: { id: "adapter.gltf", source: sourceRef, sourceSha256: container.sourceSha256, container: { schema: "shellx-motion/gltf-source@1", format: "gltf" }, scene3dMaterialAssets: plan.declaration } } };
  await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion_pbr_fixture", name: "PBR Fixture", durationMs: 1000, fps: 30, width: 1280, height: 720, background: "#000000", layers: [], assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" } }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { root, packageId };
}

async function write(root: string, ref: string, bytes: Buffer): Promise<void> { const path = join(root, ref); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); }

function gltf(): Record<string, unknown> {
  const geometry = Buffer.alloc(42); [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4)); [0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
  const uv = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 128, 255, 0, 0]), binary = Buffer.concat([geometry, Buffer.alloc(2), uv]), image = encodeRgbaPng(1, 1, Buffer.from([0x11, 0x22, 0x33, 0xff]));
  return { asset: { version: "2.0" }, buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: uv.byteLength, byteStride: 4 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC2" }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.5, roughnessFactor: 0.5 } }], textures: [{ source: 0 }], images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }], meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
}
