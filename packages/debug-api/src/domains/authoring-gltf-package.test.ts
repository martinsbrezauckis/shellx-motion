import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashBuffer, inspectPngBuffer, loadMotionPackage } from "@shellx-motion/core";
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
      expect(pkg.motion).toMatchObject({
        provenance: { sourceApp: "gltf", createdBy: "gltf-package-test" },
        layers: [{
          type: "scene3d",
          scene3d: {
            schema: "shellx-motion/scene3d@2",
            objects: [{ primitive: "mesh", source: { format: "gltf" } }],
          },
        }],
      });
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
        source: { format: "glb" },
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
});

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
