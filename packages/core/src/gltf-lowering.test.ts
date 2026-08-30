import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_GLTF_JSON_BYTES, parseGltfContainer } from "./gltf-container";
import { lowerGltfToMotion } from "./gltf-lowering";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import { loadSchema, validateDocument } from "./validate";

describe("bounded glTF and GLB lowering", () => {
  it("lowers embedded glTF triangles, generated normals, TRS, and material color", async () => {
    const source = triangleGltf(true);
    const bytes = Buffer.from(JSON.stringify(source), "utf8");
    const container = parseGltfContainer(bytes, "gltf");
    const result = lower(container, "source/normalized.gltf.json");
    const scene = result.motion.layers[0].scene3d;
    const object = scene?.objects[0];

    expect(container).toMatchObject({ format: "gltf", byteLength: bytes.byteLength });
    expect(object).toMatchObject({
      id: "Triangle-0",
      primitive: "mesh",
      position: [1, 2, 3],
      rotationDeg: [0, 0, 0],
      scale: 2,
      color: "#3380e6",
      source: { format: "gltf", meshIndex: 0, primitiveIndex: 0, materialIndex: 0, geometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    if (object?.primitive !== "mesh") throw new Error("Expected imported mesh object.");
    expect(object.geometry).toMatchObject({ indices: [0, 1, 2] });
    expect(object.geometry.normals).toHaveLength(9);
    expect(object.source.geometrySha256).toBe(scene3dMeshGeometrySha256(object.geometry));
    expect(result.diagnostics.receipt.operation).toBe("adapter.diagnostics");
    expect(result.receipt).toMatchObject({ status: "warning", output: { objectCount: 1, vertexCount: 3, triangleCount: 1 } });
    expect(await validateDocument(await loadSchema("motion"), result.motion)).toEqual({ ok: true });
  });

  it("parses the equivalent GLB BIN chunk and preserves render semantics", () => {
    const gltf = triangleGltf(false);
    const glb = makeGlb(gltf, triangleBuffer());
    const container = parseGltfContainer(glb, "glb");
    const result = lower(container, "source/normalized.glb.json");
    const object = result.motion.layers[0].scene3d?.objects[0];

    expect(container).toMatchObject({ format: "glb", buffers: [expect.any(Buffer)] });
    expect(object).toMatchObject({
      primitive: "mesh",
      color: "#3380e6",
      source: { format: "glb", meshIndex: 0, primitiveIndex: 0, geometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it("fails closed on external buffers, extensions, non-uniform scale, and accessor escapes", () => {
    const external = triangleGltf(false);
    (external.buffers as Array<Record<string, unknown>>)[0].uri = "https://evil.example/model.bin";
    expect(() => parseGltfContainer(Buffer.from(JSON.stringify(external)), "gltf")).toThrow(/bounded base64 binary/);

    const extended = triangleGltf(true);
    extended.extensionsRequired = ["KHR_draco_mesh_compression"];
    const extendedContainer = parseGltfContainer(Buffer.from(JSON.stringify(extended)), "gltf");
    expect(() => lower(extendedContainer, "source/extended.json")).toThrow(/extensionsRequired must be empty/);

    const scaled = triangleGltf(true);
    (scaled.nodes as Array<Record<string, unknown>>)[0].scale = [1, 2, 1];
    const scaledContainer = parseGltfContainer(Buffer.from(JSON.stringify(scaled)), "gltf");
    expect(() => lower(scaledContainer, "source/scaled.json")).toThrow(/uniform scale/);

    const escaped = triangleGltf(true);
    (escaped.bufferViews as Array<Record<string, unknown>>)[0].byteLength = 32;
    const escapedContainer = parseGltfContainer(Buffer.from(JSON.stringify(escaped)), "gltf");
    expect(() => lower(escapedContainer, "source/escaped.json")).toThrow(/exceeds its bounded bufferView/);
  });

  it("matches legacy glTF padding handling while retaining the exact raw-source identity", () => {
    const json = Buffer.from(JSON.stringify(triangleGltf(true)), "utf8");
    const raw = Buffer.concat([json, Buffer.from("\u0000 \t\r\n", "utf8")]);
    const before = Buffer.from(raw);
    const expectedSourceSha256 = createHash("sha256").update(raw).digest("hex");
    const legacyTrimmed = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/[\u0000\u0020\t\r\n]+$/g, "");

    const parsed = parseGltfContainer(raw, "gltf");

    expect(parsed.sourceSha256).toBe(expectedSourceSha256);
    expect(parsed.json).toEqual(JSON.parse(legacyTrimmed));
    expect(raw.equals(before)).toBe(true);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(expectedSourceSha256);
  });

  it("keeps terminal glTF padding growth near-linear at the 2 MiB JSON ceiling", () => {
    const json = Buffer.from(JSON.stringify(triangleGltf(true)), "utf8");
    const smallPadding = 480 * 1024;
    const largePadding = smallPadding * 4;
    expect(json.byteLength + largePadding).toBeLessThanOrEqual(MAX_GLTF_JSON_BYTES);
    const timeFor = (paddingBytes: number): number => {
      const source = Buffer.concat([json, Buffer.alloc(paddingBytes)]);
      const started = performance.now();
      for (let run = 0; run < 8; run += 1) {
        expect(parseGltfContainer(source, "gltf").json.asset).toMatchObject({ version: "2.0" });
      }
      return performance.now() - started;
    };

    timeFor(smallPadding);
    timeFor(largePadding);
    const small = Math.max(timeFor(smallPadding), 1);
    const large = timeFor(largePadding);
    // Four times the bounded input should remain far from the ~16x signature of rescanning.
    expect(large).toBeLessThan(small * 9);
  });

  it("lexically bounds JSON depth and structure before parsing while ignoring quoted punctuation", () => {
    const atDepthLimit = triangleGltf(true);
    atDepthLimit.extras = nestedRecord(31);
    expect(() => parseGltfContainer(Buffer.from(JSON.stringify(atDepthLimit)), "gltf")).not.toThrow();

    const overDepthLimit = triangleGltf(true);
    overDepthLimit.extras = nestedRecord(32);
    expect(() => parseGltfContainer(Buffer.from(JSON.stringify(overDepthLimit)), "gltf"))
      .toThrow(/32-level pre-parse nesting limit/);

    const quotedPunctuation = triangleGltf(true);
    quotedPunctuation.extras = { punctuation: "[{,:}]\\\"".repeat(20_000) };
    expect(() => parseGltfContainer(Buffer.from(JSON.stringify(quotedPunctuation)), "gltf")).not.toThrow();

    const structuralOverflow = triangleGltf(true);
    structuralOverflow.extras = Array.from({ length: 50_001 }, () => 0);
    expect(() => parseGltfContainer(Buffer.from(JSON.stringify(structuralOverflow)), "gltf"))
      .toThrow(/50000-token pre-parse structural limit/);
  });

  it("preflights primitive, per-object, and cumulative geometry budgets before accessor materialization", () => {
    const primitiveHeavy = meshBudgetGltf(17, 3);
    const primitiveContainer = parseGltfContainer(Buffer.from(JSON.stringify(primitiveHeavy)), "gltf");
    expect(() => lower(primitiveContainer, "source/primitive-heavy.json")).toThrow(/exceeds 16 mesh primitives/);

    const objectHeavy = meshBudgetGltf(1, 4_098);
    const objectContainer = parseGltfContainer(Buffer.from(JSON.stringify(objectHeavy)), "gltf");
    expect(() => lower(objectContainer, "source/object-heavy.json")).toThrow(/POSITION accessor count.*4096/);

    const cumulativeHeavy = meshBudgetGltf(3, 4_095);
    const cumulativeContainer = parseGltfContainer(Buffer.from(JSON.stringify(cumulativeHeavy)), "gltf");
    expect(() => lower(cumulativeContainer, "source/cumulative-heavy.json")).toThrow(/composition mesh geometry budget/);

    const multiRootHeavy = meshBudgetGltf(1, 4_095);
    multiRootHeavy.nodes = [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }];
    multiRootHeavy.scenes = [{ nodes: [0, 1, 2] }];
    const multiRootContainer = parseGltfContainer(Buffer.from(JSON.stringify(multiRootHeavy)), "gltf");
    expect(() => lower(multiRootContainer, "source/multi-root-heavy.json")).toThrow(/composition mesh geometry budget/);
  });

  it("rejects cumulative world transforms before accessor materialization", () => {
    const source = triangleGltf(true);
    const hostileBytes = triangleBuffer();
    hostileBytes.writeFloatLE(20_000, 0);
    (source.buffers as Array<Record<string, unknown>>)[0].uri = `data:application/octet-stream;base64,${hostileBytes.toString("base64")}`;
    source.nodes = [
      { name: "Parent", translation: [1_000, 0, 0], children: [1] },
      { name: "Triangle", mesh: 0, translation: [1_000, 0, 0] },
    ];
    const container = parseGltfContainer(Buffer.from(JSON.stringify(source)), "gltf");

    expect(() => lower(container, "source/world-overflow.json")).toThrow(/world translation must remain between -1000 and 1000/);
  });
});

function lower(container: ReturnType<typeof parseGltfContainer>, sourcePath: string) {
  return lowerGltfToMotion({
    adapterId: "adapter.gltf",
    sourcePath,
    sourceText: container.jsonText,
    normalizedPackagePath: "pkg_gltf_test",
    container,
    createdBy: "test",
    createdAt: "2026-07-13T00:00:00.000Z",
    width: 320,
    height: 180,
    durationMs: 1000,
  });
}

function triangleGltf(embedded: boolean): Record<string, unknown> {
  const bytes = triangleBuffer();
  return {
    asset: { version: "2.0", generator: "Triangle" },
    buffers: [{
      byteLength: bytes.byteLength,
      ...(embedded ? { uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` } : {}),
    }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.9, 1] },
      emissiveFactor: [0.1, 0.05, 0],
    }],
    meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ name: "Triangle", mesh: 0, translation: [1, 2, 3], scale: [2, 2, 2] }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

function triangleBuffer(): Buffer {
  const buffer = Buffer.alloc(42);
  const positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0];
  positions.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => buffer.writeUInt16LE(value, 36 + index * 2));
  return buffer;
}

function nestedRecord(depth: number): Record<string, unknown> {
  let nested: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) nested = { nested };
  return nested;
}

function meshBudgetGltf(primitiveCount: number, vertexCount: number): Record<string, unknown> {
  const bytes = Buffer.alloc(vertexCount * 12);
  // Any attempt to materialize before the document-wide preflight would fail on this sentinel first.
  bytes.writeFloatLE(20_000, 0);
  return {
    asset: { version: "2.0", generator: "Budget preflight" },
    buffers: [{
      byteLength: bytes.byteLength,
      uri: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3" }],
    meshes: [{
      primitives: Array.from({ length: primitiveCount }, () => ({ attributes: { POSITION: 0 } })),
    }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

function makeGlb(json: Record<string, unknown>, binary: Buffer): Buffer {
  const jsonSource = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadding = Buffer.alloc((4 - jsonSource.byteLength % 4) % 4, 0x20);
  const binaryPadding = Buffer.alloc((4 - binary.byteLength % 4) % 4);
  const jsonChunk = Buffer.concat([jsonSource, jsonPadding]);
  const binaryChunk = Buffer.concat([binary, binaryPadding]);
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
