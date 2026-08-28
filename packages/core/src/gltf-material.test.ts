import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { parseGltfContainer } from "./gltf-container";
import {
  assertGltfMaterialLibraryLegacyLowerable,
  extractGltfMaterialLibrary,
  GLTF_MATERIAL_LIBRARY_SCHEMA,
  GLTF_PBR_MATERIAL_SCHEMA,
  MAX_GLTF_IMAGE_BYTES_TOTAL,
  MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES,
} from "./gltf-material";
import { lowerGltfToMotion } from "./gltf-lowering";
import { hashBuffer } from "./receipts";

describe("bounded glTF PBR material extraction", () => {
  it("extracts exact PBR factors and contained PNG identity/bytes without widening scene3d lowering", () => {
    const image = png();
    const source = triangleGltf({
      materials: [{
        pbrMetallicRoughness: {
          baseColorFactor: [0.25, 0.5, 0.75, 1],
          metallicFactor: 1,
          roughnessFactor: 1,
          baseColorTexture: { index: 0 },
        },
        emissiveFactor: [0.2, 0.2, 0.2],
      }],
      textures: [{ source: 0 }],
      images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }],
    });
    const container = parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");
    const library = extractGltfMaterialLibrary(container);

    expect(library).toMatchObject({
      schema: GLTF_MATERIAL_LIBRARY_SCHEMA,
      textureCount: 1,
      derivedRgbaByteLength: 4,
      materials: [{
        schema: GLTF_PBR_MATERIAL_SCHEMA,
        materialIndex: 0,
        baseColorFactor: [0.25, 0.5, 0.75, 1],
        metallicFactor: 1,
        roughnessFactor: 1,
        emissiveFactor: [0.2, 0.2, 0.2],
        baseColorTexture: {
          textureIndex: 0,
          imageIndex: 0,
          mimeType: "image/png",
          width: 1,
          height: 1,
          byteLength: image.byteLength,
          derivedRgbaByteLength: 4,
          sha256: hashBuffer(image),
        },
      }],
    });
    expect(library.materials[0].baseColorTexture?.bytes.equals(image)).toBe(true);
    expect(() => lower(container)).toThrow(/glTF textures are not supported by the static bounded importer/);
  });

  it("extracts a GLB bufferView JPEG with owned copied byte-snapshot identity metadata", () => {
    const image = jpeg();
    const binary = Buffer.concat([triangleBuffer(), image]);
    const source = triangleGltf({
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
        { buffer: 0, byteOffset: 42, byteLength: image.byteLength },
      ],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ bufferView: 2, mimeType: "image/jpeg" }],
    });
    const container = parseGltfContainer(makeGlb(source, binary), "glb");
    const library = extractGltfMaterialLibrary(container);
    const texture = library.materials[0].baseColorTexture;

    expect(texture).toMatchObject({
      textureIndex: 0,
      imageIndex: 0,
      mimeType: "image/jpeg",
      width: 1,
      height: 1,
      byteLength: image.byteLength,
      derivedRgbaByteLength: 4,
      sha256: hashBuffer(image),
    });
    expect(texture?.bytes.equals(image)).toBe(true);
    expect(() => lower(container)).toThrow(/glTF textures are not supported by the static bounded importer/);
  });

  it("returns frozen metadata and defensive image snapshots bound to the recorded hash", () => {
    const image = png();
    const source = triangleGltf({
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }],
    });
    const library = extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf"));
    const extracted = library.images[0];
    const texture = library.materials[0].baseColorTexture!;
    const firstCopy = extracted.bytes;
    firstCopy[0] ^= 0xff;
    const textureCopy = texture.bytes;
    textureCopy[1] ^= 0xff;

    expect(extracted.bytes.equals(image)).toBe(true);
    expect(texture.bytes.equals(image)).toBe(true);
    expect(hashBuffer(extracted.bytes)).toBe(extracted.sha256);
    expect(Object.isFrozen(library)).toBe(true);
    expect(Object.isFrozen(library.images)).toBe(true);
    expect(Object.isFrozen(extracted)).toBe(true);
    expect(Object.isFrozen(library.materials[0])).toBe(true);
    expect(Object.isFrozen(library.materials[0].baseColorFactor)).toBe(true);
    expect(Object.isFrozen(library.materials[0].legacyScene3d.losses)).toBe(true);
    expect(Object.isFrozen(texture)).toBe(true);
    expect(() => { (library.materials[0].baseColorFactor as unknown as number[])[0] = 0; }).toThrow();
    expect(() => { (library.images as unknown as unknown[]).push({}); }).toThrow();
  });

  it("keeps existing untextured/default-factor Motion and fingerprint semantics", () => {
    const baseline = triangleGltf();
    const explicitDefaults = structuredClone(baseline);
    const pbr = (explicitDefaults.materials as Array<Record<string, unknown>>)[0].pbrMetallicRoughness as Record<string, unknown>;
    pbr.metallicFactor = 1;
    pbr.roughnessFactor = 1;
    const first = lower(parseGltfContainer(Buffer.from(JSON.stringify(baseline), "utf8"), "gltf"));
    const second = lower(parseGltfContainer(Buffer.from(JSON.stringify(explicitDefaults), "utf8"), "gltf"));
    const firstOutput = first.receipt.output as Record<string, unknown>;

    expect(second.motion.layers[0].scene3d).toEqual(first.motion.layers[0].scene3d);
    expect(second.motion.id).not.toBe(first.motion.id);
    expect(firstOutput.motionSha256).not.toBe((second.receipt.output as Record<string, unknown>).motionSha256);
  });

  it("records source-default versus legacy-default base color and unqualified PBR defaults truthfully", () => {
    const sourceDefault = parseGltfContainer(Buffer.from(JSON.stringify(triangleGltf({ materials: [{}] })), "utf8"), "gltf");
    const explicitDefault = parseGltfContainer(Buffer.from(JSON.stringify(triangleGltf({
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 } }],
    })), "utf8"), "gltf");

    expect(extractGltfMaterialLibrary(sourceDefault).materials[0].legacyScene3d).toEqual({
      color: "#ccd6e0", emissive: 0, exact: false, losses: ["baseColorFactor", "metallicFactor", "roughnessFactor"],
    });
    expect(extractGltfMaterialLibrary(explicitDefault).materials[0].legacyScene3d).toEqual({
      color: "#ffffff", emissive: 0, exact: false, losses: ["metallicFactor", "roughnessFactor"],
    });
    expect(() => assertGltfMaterialLibraryLegacyLowerable(extractGltfMaterialLibrary(sourceDefault)))
      .toThrow(/baseColorFactor is not exactly representable/);
    expect(() => assertGltfMaterialLibraryLegacyLowerable(extractGltfMaterialLibrary(explicitDefault)))
      .toThrow(/metallicFactor is not representable/);
  });

  it("records non-default metallic and roughness factors as dormant legacy-lowering losses", () => {
    const source = triangleGltf({
      materials: [{ pbrMetallicRoughness: {
        baseColorFactor: [204 / 255, 214 / 255, 224 / 255, 1],
        metallicFactor: 0.2,
        roughnessFactor: 0.7,
      } }],
    });
    const container = parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");

    const material = extractGltfMaterialLibrary(container).materials[0];
    expect(material).toMatchObject({ metallicFactor: 0.2, roughnessFactor: 0.7, legacyScene3d: { exact: false, losses: ["metallicFactor", "roughnessFactor"] } });
    expect(() => assertGltfMaterialLibraryLegacyLowerable(extractGltfMaterialLibrary(container)))
      .toThrow(/metallicFactor is not representable by the current scene3d renderer/);
    expect(() => lower(container)).not.toThrow();
  });

  it("preserves colored emissive factors and records the legacy scalar loss without changing live lowering", () => {
    const source = triangleGltf({
      materials: [{
        pbrMetallicRoughness: { baseColorFactor: [204 / 255, 214 / 255, 224 / 255, 1] },
        emissiveFactor: [0.1, 0.2, 0.3],
      }],
    });
    const container = parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");

    expect(extractGltfMaterialLibrary(container).materials[0]).toMatchObject({
      emissiveFactor: [0.1, 0.2, 0.3],
      legacyScene3d: { exact: false, losses: ["metallicFactor", "roughnessFactor", "emissiveFactor"], emissive: 0.3 },
    });
    expect(lower(container).motion.layers[0].scene3d?.objects[0]).toMatchObject({ emissive: 0.3 });
  });

  it("fails closed on external/malformed/excessive images, invalid texture references, and dropped texture semantics", () => {
    const external = triangleGltf({
      images: [{ uri: "https://example.invalid/base.png" }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(external), "utf8"), "gltf")))
      .toThrow(/bounded embedded PNG or JPEG base64 data URI/);

    const compressedExtension = triangleGltf({ extensionsUsed: ["KHR_draco_mesh_compression"] });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(compressedExtension), "utf8"), "gltf")))
      .toThrow(/extensionsUsed must be empty/);

    const badFactor = triangleGltf({ materials: [{ pbrMetallicRoughness: { metallicFactor: 1.01 } }] });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(badFactor), "utf8"), "gltf")))
      .toThrow(/metallicFactor must be a finite number from 0 to 1/);

    const malformed = triangleGltf({
      images: [{ uri: "data:image/png;base64,AA==" }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(malformed), "utf8"), "gltf")))
      .toThrow(/PNG bytes are malformed/);

    const badCrc = png();
    badCrc[badCrc.byteLength - 1] ^= 0xff;
    const corrupted = triangleGltf({
      images: [{ uri: `data:image/png;base64,${badCrc.toString("base64")}` }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(corrupted), "utf8"), "gltf")))
      .toThrow(/PNG chunk CRC is invalid/);

    const apng = triangleGltf({
      images: [{ uri: `data:image/png;base64,${withApngChunk(png()).toString("base64")}` }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(apng), "utf8"), "gltf")))
      .toThrow(/APNG animation is not supported/);
    const orphanAnimationData = triangleGltf({
      images: [{ uri: `data:image/png;base64,${withPngChunk(png(), "fdAT", Buffer.alloc(4)).toString("base64")}` }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(orphanAnimationData), "utf8"), "gltf")))
      .toThrow(/APNG animation is not supported/);

    const oversized = png(4096, 4096);
    const excessive = triangleGltf({
      images: [{ uri: `data:image/png;base64,${oversized.toString("base64")}` }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(excessive), "utf8"), "gltf")))
      .toThrow(new RegExp(`derived RGBA bytes exceed ${MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES}`));

    const badTexture = triangleGltf({
      textures: [{ source: 1 }],
      images: [{ uri: `data:image/png;base64,${png().toString("base64")}` }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(badTexture), "utf8"), "gltf")))
      .toThrow(/glTF texture 0 source must be an integer/);

    const badMaterialIndex = triangleGltf({
      meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] }],
    });
    expect(() => lower(parseGltfContainer(Buffer.from(JSON.stringify(badMaterialIndex), "utf8"), "gltf")))
      .toThrow(/glTF material index must be an integer/);

    const metallicRoughnessTexture = triangleGltf({
      materials: [{ pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: `data:image/png;base64,${png().toString("base64")}` }],
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(metallicRoughnessTexture), "utf8"), "gltf")))
      .toThrow(/metallicRoughnessTexture is not supported/);
  });

  it("rejects zero-IDAT and incomplete JPEG inputs and caps aggregate snapshots before owned copies", () => {
    const zeroData = triangleGltf({ images: [{ uri: `data:image/png;base64,${pngWithIdat(Buffer.alloc(0)).toString("base64")}` }] });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(zeroData), "utf8"), "gltf")))
      .toThrow(/PNG image data must not be empty/);

    const incompleteJpeg = Buffer.concat([jpeg().subarray(0, jpeg().byteLength - 5), Buffer.from([0xff, 0xd9])]);
    const truncated = triangleGltf({ images: [{ uri: `data:image/jpeg;base64,${incompleteJpeg.toString("base64")}` }] });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(Buffer.from(JSON.stringify(truncated), "utf8"), "gltf")))
      .toThrow(/JPEG scan is incomplete/);

    const snapshots = Array.from({ length: 3 }, () => pngWithIdat(Buffer.alloc(3 * 1024 * 1024)));
    const binary = Buffer.concat([triangleBuffer(), ...snapshots]);
    let offset = triangleBuffer().byteLength;
    const imageViews = snapshots.map((snapshot) => {
      const view = { buffer: 0, byteOffset: offset, byteLength: snapshot.byteLength };
      offset += snapshot.byteLength;
      return view;
    });
    const aggregate = triangleGltf({
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
        ...imageViews,
      ],
      images: imageViews.map((_view, index) => ({ bufferView: index + 2, mimeType: "image/png" })),
    });
    expect(() => extractGltfMaterialLibrary(parseGltfContainer(makeGlb(aggregate, binary), "glb")))
      .toThrow(new RegExp(`image snapshot bytes exceed ${MAX_GLTF_IMAGE_BYTES_TOTAL}`));
  });
});

function lower(container: ReturnType<typeof parseGltfContainer>) {
  return lowerGltfToMotion({
    adapterId: "adapter.gltf",
    sourcePath: "source/normalized.gltf.json",
    sourceText: container.jsonText,
    normalizedPackagePath: "pkg_gltf_material_test",
    container,
    createdBy: "test",
    createdAt: "2026-08-16T00:00:00.000Z",
    width: 320,
    height: 180,
    durationMs: 1000,
  });
}

function triangleGltf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bytes = triangleBuffer();
  return {
    asset: { version: "2.0", generator: "PBR material test" },
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.9, 1] } }],
    meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ name: "Triangle", mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...overrides,
  };
}

function triangleBuffer(): Buffer {
  const buffer = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => buffer.writeUInt16LE(value, 36 + index * 2));
  return buffer;
}

function png(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithIdat(data: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", data),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x00,
    0xff, 0xd9,
  ]);
}

function withApngChunk(value: Buffer): Buffer {
  return withPngChunk(value, "acTL", Buffer.alloc(8));
}

function withPngChunk(value: Buffer, type: string, data: Buffer): Buffer {
  const chunk = pngChunk(type, data);
  return Buffer.concat([value.subarray(0, 33), chunk, value.subarray(33)]);
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
