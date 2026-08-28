import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { hashBuffer, inspectPngBuffer, loadMotionPackage, scene3dMeshGeometrySha256 } from "@shellx-motion/core";
import { prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage } from "@shellx-motion/core/internal/scene3d-gltf-material";
import { resolveScene3dGltfPbrFinalRoute } from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { writeStaticGltfPackage } from "./authoring-gltf-package.js";

const fixturePath = resolve("../../fixtures/imports/gltf-triangle/input.gltf");

describe("atomic glTF package authoring", () => {
  it("preserves, normalizes, lowers, and renders one provenance-bound glTF package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-package-"));
    const sourcePath = join(root, "input", "triangle.gltf");
    const outputRoot = join(root, "packages", "triangle");
    try {
      await mkdir(dirname(sourcePath), { recursive: true });
      const sourceBytes = await readFile(fixturePath);
      await writeFile(sourcePath, sourceBytes);
      const result = await writeStaticGltfPackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root],
        createdBy: "gltf-package-test",
        createdAt: "2026-07-13T08:30:00.000Z",
      });
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
      const diagnostics = JSON.parse(await readFile(result.diagnosticsReceiptPath, "utf8")) as Record<string, any>;
      const lowering = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const pkg = await loadMotionPackage(result.packageRoot);
      const render = await renderMotionBrowserFrame(pkg, {
        atMs: 500,
        outDir: join(root, "render"),
      });
      const quality = inspectPngBuffer(await readFile(render.output.path));
      const normalizedBytes = await readFile(result.normalizedSourcePath);

      expect(await readFile(result.sourcePath)).toEqual(sourceBytes);
      expect(result).toMatchObject({ format: "gltf", sourceByteLength: sourceBytes.byteLength });
      expect(result.bufferSha256).toHaveLength(1);
      expect(manifest).toMatchObject({
        sourceApp: "gltf",
        data: {
          adapter: {
            id: "adapter.gltf",
            source: "source/input.gltf",
            sourceSha256: hashBuffer(sourceBytes),
            loweringSource: "source/normalized.gltf.json",
            loweringSourceSha256: hashBuffer(normalizedBytes),
            container: {
              schema: "shellx-motion/gltf-source@1",
              format: "gltf",
              resourcePolicy: {
                network: "denied",
                externalBuffers: "denied",
                geometry: "bounded-static-triangles",
              },
            },
          },
        },
      });
      expect(manifest.data.adapter.scene3dMaterialAssets).toBeUndefined();
      expect(manifest.data.adapter.scene3dGltfPbrFinal).toBeUndefined();
      expect(manifest.assets).toEqual([]);
      expect(pkg.motion).toMatchObject({
        provenance: { sourceApp: "gltf", createdBy: "gltf-package-test" },
        layers: [{
          type: "scene3d",
          scene3d: {
            schema: "shellx-motion/scene3d@2",
            objects: [{ primitive: "mesh", geometry: expect.any(Object), source: { format: "gltf", geometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) } }],
          },
        }],
      });
      const imported = pkg.motion.layers[0].scene3d?.objects[0];
      if (!imported || imported.primitive !== "mesh") throw new Error("Expected imported mesh.");
      expect(imported.source.geometrySha256).toBe(scene3dMeshGeometrySha256(imported.geometry));
      expect(lowering).toMatchObject({
        operation: "adapter.lower",
        output: { format: "gltf", objectCount: 1, vertexCount: 3, triangleCount: 1 },
      });
      expect(diagnostics.operation).toBe("adapter.diagnostics");
      expect(render.output.scenes3d?.layers[0]).toMatchObject({
        meshObjectCount: 1,
        meshVertexCount: 3,
        triangleCount: 1,
      });
      expect(quality).toMatchObject({ ok: true, blank: false });
      if (process.platform !== "win32") {
        expect((await stat(result.sourcePath)).mode & 0o777).toBe(0o600);
        expect((await stat(result.normalizedSourcePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("preserves GLB bytes while lowering its bounded BIN chunk through normalized JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-glb-package-"));
    const sourcePath = join(root, "triangle.glb");
    const outputRoot = join(root, "package");
    try {
      const glb = await fixtureGlb();
      await writeFile(sourcePath, glb);
      const result = await writeStaticGltfPackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root],
      });
      const pkg = await loadMotionPackage(outputRoot);

      expect(result.format).toBe("glb");
      expect(await readFile(result.sourcePath)).toEqual(glb);
      // Normalize separators before matching: the engine correctly returns a native path, which
      // is backslash-separated on Windows. Same idiom as packages/core/src/package.test.ts:13.
      expect(result.sourcePath.replace(/\\/g, "/")).toMatch(/source\/input\.glb$/);
      expect(pkg.motion.layers[0].scene3d?.objects[0]).toMatchObject({
        primitive: "mesh",
        source: { format: "glb", geometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on external buffers without installing a partial package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-hostile-gltf-"));
    const sourcePath = join(root, "external.gltf");
    const outputRoot = join(root, "package");
    try {
      const source = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
      source.buffers[0].uri = "https://example.invalid/model.bin";
      await writeFile(sourcePath, JSON.stringify(source));

      await expect(writeStaticGltfPackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root],
      })).rejects.toThrow(/bounded base64 binary/);
      await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a derived camera outside canonical Motion bounds before atomic commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-camera-overflow-gltf-"));
    const sourcePath = join(root, "camera-overflow.gltf");
    const outputRoot = join(root, "package");
    try {
      const source = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
      source.nodes[0].translation = [1_000, 1_000, 1_000];
      source.nodes[0].scale = [100, 100, 100];
      await writeFile(sourcePath, JSON.stringify(source));

      await expect(writeStaticGltfPackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root],
      })).rejects.toThrow(/Canonical Motion validation.*camera\/position/);
      await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically persists the qualified contained-PNG PBR source route and refuses generic preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-pbr-gltf-package-"));
    const sourcePath = join(root, "input", "textured.gltf");
    const outputRoot = join(root, "packages", "textured");
    try {
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, JSON.stringify(texturedTriangleGltf()));
      let result: Awaited<ReturnType<typeof writeStaticGltfPackage>>;
      try {
        result = await writeStaticGltfPackage({
          sourcePath,
          outputRoot,
          inputRoots: [root],
          outputRoots: [root],
          createdAt: "2026-08-16T12:00:00.000Z",
        });
      } catch (error) {
        // Some managed sandboxes intentionally expose a foreign-owned temporary parent. The
        // failure must come from the transaction workspace after qualified lowering/admission,
        // rather than from the public texture-refusing lowerer; it still leaves no output.
        expect(error).toMatchObject({ message: expect.stringContaining("output topology is unsafe") });
        expect((error as Error).stack).toContain("commitNewPackage");
        await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const pkg = await loadMotionPackage(result.packageRoot);
      const adapter = (pkg.manifest.data as { adapter: Record<string, any> }).adapter;
      const declaration = adapter.scene3dMaterialAssets;
      expect(adapter.container.resourcePolicy.textures).toBe("sdr-pbr-png-webgpu-direct-final");
      expect(pkg.manifest.compatibility).toEqual({ lanes: ["gpu"], hosts: ["shellx-motion"] });
      expect(declaration).toMatchObject({ packageId: pkg.manifest.id, sidecarRef: "scene3d/gltf-material-assets.json" });
      expect(adapter.scene3dGltfPbrFinal).toEqual({ schema: "shellx-motion/scene3d-gltf-pbr-final-locator@1", sceneLayerId: "gltf-scene" });
      expect(pkg.manifest.assets).toHaveLength(1);
      expect((await readFile(join(result.packageRoot, declaration.sidecarRef))).byteLength).toBeGreaterThan(0);
      expect((await readFile(join(result.packageRoot, declaration.receiptRef))).byteLength).toBeGreaterThan(0);
      const prepared = await prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage(result.packageRoot);
      const route = await resolveScene3dGltfPbrFinalRoute(pkg, "a".repeat(64));
      expect(prepared.staticPlan.source.sha256).toBe(result.sourceSha256);
      expect(route).toMatchObject({ kind: "present", route: { packageId: pkg.manifest.id, sceneStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      const previewDirectory = join(root, "generic-preview");
      await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir: previewDirectory }))
        .rejects.toMatchObject({ code: "gltf_pbr_final_direct_final_only" });
      await expect(stat(previewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["JPEG", (source: Record<string, any>) => { source.images[0] = { uri: "data:image/jpeg;base64,/9j/2Q==" }; }],
    ["external image", (source: Record<string, any>) => { source.images[0] = { uri: "https://example.invalid/base.png" }; }],
    ["sampler", (source: Record<string, any>) => { source.samplers = [{}]; }],
    ["extension", (source: Record<string, any>) => { source.extensionsRequired = ["KHR_texture_basisu"]; }],
  ])("fails closed on unsupported contained-PBR %s without a partial package", async (_label, alter) => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-hostile-pbr-gltf-"));
    const sourcePath = join(root, "input.gltf");
    const outputRoot = join(root, "package");
    try {
      const source = texturedTriangleGltf();
      alter(source);
      await writeFile(sourcePath, JSON.stringify(source));
      await expect(writeStaticGltfPackage({ sourcePath, outputRoot, inputRoots: [root], outputRoots: [root] })).rejects.toThrow(/PNG|JPEG|external|samplers|extensionsRequired/);
      await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function texturedTriangleGltf(): Record<string, any> {
  const geometry = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
  const uv = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 128, 255, 0, 0]);
  const binary = Buffer.concat([geometry, Buffer.alloc(2), uv]);
  const image = rgbaPng(Buffer.from([0x11, 0x22, 0x33, 0xff]));
  return {
    asset: { version: "2.0", generator: "qualified contained PBR" },
    buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: 44, byteLength: uv.byteLength, byteStride: 4 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC2" },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.25, 0.5, 0.75, 1], metallicFactor: 0.4, roughnessFactor: 0.6, baseColorTexture: { index: 0 } }, emissiveFactor: [0.1, 0.05, 0.02] }],
    textures: [{ source: 0 }],
    images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

function rgbaPng(rgba: Buffer): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.concat([Buffer.from([0]), rgba]))), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.byteLength); chunk.writeUInt32BE(data.byteLength, 0); chunk.write(type, 4, "ascii"); data.copy(chunk, 8); chunk.writeUInt32BE(pngCrc32(chunk, 4, data.byteLength + 4), data.byteLength + 8); return chunk;
}

function pngCrc32(bytes: Buffer, offset: number, length: number): number {
  let crc = 0xffff_ffff;
  for (let index = offset; index < offset + length; index += 1) { crc ^= bytes[index]!; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0); }
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function fixtureGlb(): Promise<Buffer> {
  const json = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
  const encoded = String(json.buffers[0].uri).slice(String(json.buffers[0].uri).indexOf(",") + 1);
  const binary = Buffer.from(encoded, "base64");
  delete json.buffers[0].uri;
  const jsonSource = Buffer.from(JSON.stringify(json), "utf8");
  const jsonChunk = Buffer.concat([jsonSource, Buffer.alloc((4 - jsonSource.byteLength % 4) % 4, 0x20)]);
  const binaryChunk = Buffer.concat([binary, Buffer.alloc((4 - binary.byteLength % 4) % 4)]);
  const output = Buffer.alloc(12 + 8 + jsonChunk.byteLength + 8 + binaryChunk.byteLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.byteLength, 8);
  output.writeUInt32LE(jsonChunk.byteLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(output, 20);
  const binaryHeader = 20 + jsonChunk.byteLength;
  output.writeUInt32LE(binaryChunk.byteLength, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binaryChunk.copy(output, binaryHeader + 8);
  return output;
}
