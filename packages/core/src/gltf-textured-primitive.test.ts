import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseGltfContainer } from "./gltf-container";
import { lowerGltfToMotion } from "./gltf-lowering";
import {
  deriveGltfTexturedPrimitiveDescriptors,
  GLTF_TEXCOORD_0_SCHEMA,
  GLTF_TEXTURED_PRIMITIVE_SCHEMA,
  type GltfTexCoord0Format,
} from "./gltf-textured-primitive";

describe("dormant glTF base-color primitive TEXCOORD_0 descriptors", () => {
  it("binds contained base-color texture identity to exact bounded FLOAT and normalized unsigned UV accessors", () => {
    const cases: Array<{ format: GltfTexCoord0Format; values: number[]; expected: number[] }> = [
      { format: "float32", values: [0, 0, 1, 0, 0.5, 1], expected: [0, 0, 1, 0, 0.5, 1] },
      { format: "unorm8", values: [0, 0, 255, 0, 128, 255], expected: [0, 0, 1, 0, 128 / 255, 1] },
      { format: "unorm16", values: [0, 0, 65535, 0, 32768, 65535], expected: [0, 0, 1, 0, 32768 / 65535, 1] },
    ];

    for (const entry of cases) {
      const container = parsed(texturedTriangle(entry.format, entry.values));
      const [first] = deriveGltfTexturedPrimitiveDescriptors(container);
      const [second] = deriveGltfTexturedPrimitiveDescriptors(container);

      expect(first).toMatchObject({
        schema: GLTF_TEXTURED_PRIMITIVE_SCHEMA,
        sourceSha256: container.sourceSha256,
        meshIndex: 0,
        primitiveIndex: 0,
        materialIndex: 0,
        positionAccessorIndex: 0,
        vertexCount: 3,
        texCoord0: { schema: GLTF_TEXCOORD_0_SCHEMA, accessorIndex: 2, format: entry.format, count: 3, values: entry.expected },
      });
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(first.texCoord0.valuesSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.material.baseColorTexture).not.toHaveProperty("bytes");
      expect(first.material.baseColorTexture).toMatchObject({ texCoord: 0, mimeType: "image/png", width: 1, height: 1 });
      expect(() => lower(container)).toThrow(/glTF textures are not supported by the static bounded importer/);
    }
  });

  it("does not require or inspect TEXCOORD_0 for an untextured primitive", () => {
    const source = texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      untextured: true,
      attributes: { POSITION: 0, TEXCOORD_0: 999 },
    });

    expect(deriveGltfTexturedPrimitiveDescriptors(parsed(source))).toEqual([]);
  });

  it("refuses a textured material with missing or count-mismatched TEXCOORD_0", () => {
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      attributes: { POSITION: 0 },
    })))).toThrow(/textured material requires TEXCOORD_0/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1, 0, 1], {
      count: 4,
    })))).toThrow(/TEXCOORD_0 count must equal POSITION vertex count/);
  });

  it("fails closed on unsupported UV formats, non-finite/out-of-range coordinates, and sparse accessors", () => {
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      accessor: { componentType: 5121, normalized: false },
    })))).toThrow(/FLOAT VEC2 or normalized UNSIGNED_BYTE\/UNSIGNED_SHORT VEC2/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      accessor: { type: "VEC3" },
    })))).toThrow(/must use VEC2 values/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, Number.NaN, 0, 0.5, 1])))).toThrow(/finite normalized coordinates/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1.01, 0, 0.5, 1])))).toThrow(/finite normalized coordinates/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      accessor: { sparse: {} },
    })))).toThrow(/sparse accessors and extensions are not supported/);
  });

  it("checks UV offsets, stride, and bufferView bounds before reading", () => {
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      view: { byteStride: 10 },
    })))).toThrow(/offsets and stride are not aligned/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      view: { byteOffset: 42 },
    })))).toThrow(/offsets and stride are not aligned/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1], {
      view: { byteLength: 16 },
    })))).toThrow(/accessor exceeds its bounded bufferView/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("unorm16", [0, 0, 65535, 0, 32768, 65535], {
      view: { byteStride: 6 },
    })))).toThrow(/vertex byteStride must be a multiple of 4/);
    expect(() => deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("unorm8", [0, 0, 255, 0, 128, 255], {
      view: { byteStride: undefined },
    })))).toThrow(/vertex byteStride must be a multiple of 4/);
  });

  it("returns deeply frozen descriptor data with no mutable texture snapshot", () => {
    const [descriptor] = deriveGltfTexturedPrimitiveDescriptors(parsed(texturedTriangle("float32", [0, 0, 1, 0, 0.5, 1])));

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.material)).toBe(true);
    expect(Object.isFrozen(descriptor.material.baseColorFactor)).toBe(true);
    expect(Object.isFrozen(descriptor.texCoord0)).toBe(true);
    expect(Object.isFrozen(descriptor.texCoord0.values)).toBe(true);
    expect(Object.isFrozen(descriptor.material.baseColorTexture)).toBe(true);
    expect(() => { (descriptor.texCoord0.values as number[])[0] = 0.25; }).toThrow();
    expect(() => { (descriptor.material.baseColorFactor as unknown as number[])[0] = 0.25; }).toThrow();
    expect(descriptor.material.baseColorTexture).not.toHaveProperty("bytes");
  });
});

function lower(container: ReturnType<typeof parseGltfContainer>) {
  return lowerGltfToMotion({
    adapterId: "adapter.gltf",
    sourcePath: "source/textured-triangle.gltf.json",
    sourceText: container.jsonText,
    normalizedPackagePath: "pkg_gltf_texcoord_test",
    container,
    createdBy: "test",
    createdAt: "2026-08-16T00:00:00.000Z",
    width: 320,
    height: 180,
    durationMs: 1000,
  });
}

function parsed(source: Record<string, unknown>) {
  return parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");
}

function texturedTriangle(
  format: GltfTexCoord0Format,
  values: number[],
  options: {
    accessor?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    count?: number;
    untextured?: boolean;
    view?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const componentBytes = format === "float32" ? 4 : format === "unorm16" ? 2 : 1;
  const itemBytes = componentBytes * 2;
  const stride = typeof options.view?.byteStride === "number" ? options.view.byteStride : format === "unorm8" ? 4 : itemBytes;
  const texcoords = encodeTexCoords(format, values, stride);
  const binary = Buffer.concat([triangleBuffer(), Buffer.alloc(2), texcoords]);
  const componentType = format === "float32" ? 5126 : format === "unorm8" ? 5121 : 5123;
  return {
    asset: { version: "2.0", generator: "TEXCOORD descriptor test" },
    buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: 44, byteLength: texcoords.byteLength, ...(format === "unorm8" ? { byteStride: 4 } : {}), ...options.view },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      {
        bufferView: 2,
        componentType,
        ...(format === "float32" ? {} : { normalized: true }),
        count: options.count ?? values.length / 2,
        type: "VEC2",
        ...options.accessor,
      },
    ],
    materials: [options.untextured
      ? { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.9, 1] } }
      : { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    ...(options.untextured ? {} : {
      textures: [{ source: 0 }],
      images: [{ uri: `data:image/png;base64,${png().toString("base64")}` }],
    }),
    meshes: [{ primitives: [{ attributes: options.attributes ?? { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

function triangleBuffer(): Buffer {
  const buffer = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => buffer.writeUInt16LE(value, 36 + index * 2));
  return buffer;
}

function encodeTexCoords(format: GltfTexCoord0Format, values: number[], stride: number): Buffer {
  const componentBytes = format === "float32" ? 4 : format === "unorm16" ? 2 : 1;
  const itemBytes = componentBytes * 2;
  const bytes = Buffer.alloc((values.length / 2 - 1) * stride + itemBytes);
  values.forEach((value, index) => {
    const offset = Math.floor(index / 2) * stride + index % 2 * componentBytes;
    if (format === "float32") bytes.writeFloatLE(value, offset);
    else if (format === "unorm16") bytes.writeUInt16LE(value, offset);
    else bytes.writeUInt8(value, offset);
  });
  return bytes;
}

function png(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk, 4, data.byteLength + 4), data.byteLength + 8);
  return chunk;
}

function pngCrc32(bytes: Buffer, offset: number, length: number): number {
  let crc = 0xffff_ffff;
  for (let index = offset; index < offset + length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
