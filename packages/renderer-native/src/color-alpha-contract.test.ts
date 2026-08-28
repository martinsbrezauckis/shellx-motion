import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { decodeNativePngRgba, encodePng } from "./native-png";
import { renderNativePreviewFrame } from "./index";

const roots: string[] = [];

async function writePackage(id: string, effects: Record<string, unknown> | undefined = undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-native-colour-alpha-"));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `pkg_${id}`,
    name: id,
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native"], hosts: ["shellx-motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id,
    name: id,
    durationMs: 1000,
    fps: 30,
    width: 7,
    height: 7,
    background: "#00000000",
    layers: [{
      id: "half-red",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 3, y: 3, width: 1, height: 1 },
      style: { fill: "#ff000080" },
      ...(effects ? { effects } : {})
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "color-alpha-contract.test" }
  }, null, 2)}\n`);
  return root;
}

function pixel(png: Buffer, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const image = decodeNativePngRgba(png);
  const offset = (y * image.width + x) * 4;
  return {
    r: image.rgba[offset],
    g: image.rgba[offset + 1],
    b: image.rgba[offset + 2],
    a: image.rgba[offset + 3]
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withGammaAndProfileChunks(png: Buffer): Buffer {
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(45_455, 0);
  const profile = Buffer.concat([
    Buffer.from("unportable-profile\0\0", "binary"),
    deflateSync(Buffer.from("minimal nonportable ICC payload", "utf8"))
  ]);
  // Signature (8 bytes) + IHDR (25 bytes) is the legal insertion point for both ancillary chunks.
  return Buffer.concat([png.subarray(0, 33), pngChunk("gAMA", gamma), pngChunk("iCCP", profile), png.subarray(33)]);
}

describe("native current colour and alpha contract", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("writes straight RGBA PNG pixels while using temporary premultiplication for transparent blur", async () => {
    const direct = await renderNativePreviewFrame({ packageRoot: await writePackage("straight"), atMs: 0 });
    const blurred = await renderNativePreviewFrame({ packageRoot: await writePackage("blurred", { blur: 1 }), atMs: 0 });

    expect(direct.ok).toBe(true);
    expect(blurred.ok).toBe(true);
    if (!direct.ok || !blurred.ok) return;
    expect(pixel(direct.frame.png, 3, 3)).toEqual({ r: 255, g: 0, b: 0, a: 128 });
    const halo = pixel(blurred.frame.png, 2, 3);
    expect(halo).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(halo.a).toBeGreaterThan(0);
    expect(halo.a).toBeLessThan(128);
  });

  it("keeps raw RGBA samples unchanged when gAMA and iCCP ancillary metadata is present", () => {
    const raw = Buffer.from([17, 89, 201, 113]);
    const unprofiled = encodePng(1, 1, raw);
    const annotated = withGammaAndProfileChunks(unprofiled);

    expect(decodeNativePngRgba(unprofiled).rgba).toEqual(raw);
    expect(decodeNativePngRgba(annotated).rgba).toEqual(raw);
  });
});
