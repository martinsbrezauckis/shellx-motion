import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashBuffer } from "./native-png.js";

const race = vi.hoisted(() => ({
  target: "",
  outsidePath: "",
  restore: null as Buffer | null
}));

/**
 * This is a deterministic representation of the old check-then-reopen race: the attacker swaps
 * the package path for an external symlink at the exact readFile boundary, then restores the
 * package file before the later pathname-based receipt hash.  Before the fix the frame uses the
 * external pixels while the receipt attests the restored bytes.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: any[]) => {
      if (race.target && String(args[0]) === race.target) {
        const target = race.target;
        race.target = "";
        const restore = race.restore;
        if (!restore) throw new Error("native TOCTOU test did not configure replacement bytes");
        await actual.rm(target);
        await actual.symlink(race.outsidePath, target);
        const escaped = await (actual.readFile as (...readArgs: any[]) => Promise<any>)(...args);
        await actual.rm(target);
        await actual.writeFile(target, restore);
        return escaped;
      }
      return await (actual.readFile as (...readArgs: any[]) => Promise<any>)(...args);
    }
  };
});

import { renderNativePreviewFrame } from "./index.js";
import { decodeNativePngRgba } from "./native-png.js";

const tempDirs: string[] = [];

describe("native renderer asset snapshot", () => {
  afterEach(async () => {
    race.target = "";
    race.outsidePath = "";
    race.restore = null;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(process.platform === "win32")("renders and hashes one verified in-package image snapshot when its pathname is swapped", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-native-toctou-package-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-native-toctou-outside-"));
    tempDirs.push(packageRoot, outsideRoot);
    const sourcePath = join(packageRoot, "assets", "logo.png");
    const outsidePath = join(outsideRoot, "logo.png");
    const verified = solidPng(2, 2, { r: 34, g: 197, b: 94, a: 255 });
    const escaped = solidPng(2, 2, { r: 239, g: 68, b: 68, a: 255 });
    await mkdir(join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(sourcePath, verified);
    await writeFile(outsidePath, escaped);
    await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_native_toctou", name: "TOCTOU",
      motion: "motion.json", assets: [], sourceApp: "shellx-motion",
      compatibility: { lanes: ["native"], hosts: ["motion"] }
    })}\n`);
    await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
      schema: "shellx-motion/motion@1", id: "motion_native_toctou", name: "TOCTOU", durationMs: 1000,
      fps: 30, width: 2, height: 2, background: "#000000", assets: [], designTokens: {},
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [{ id: "logo", type: "image", source: "assets/logo.png", assetRef: "assets/logo.png",
        startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 2, height: 2 }, fit: "fill" }]
    })}\n`);

    race.target = sourcePath;
    race.outsidePath = outsidePath;
    race.restore = verified;
    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pixel(result.frame.png, 0, 0)).toEqual([34, 197, 94, 255]);
    expect(result.receipt.inputHashes["assets/logo.png"]).toBe(hashBuffer(verified));
  });

  it.skipIf(process.platform === "win32")("keeps structural receipt hashes bound to the manifest and motion snapshots parsed before a pathname swap", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-native-structural-snapshot-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-native-structural-outside-"));
    tempDirs.push(packageRoot, outsideRoot);
    const manifestPath = join(packageRoot, "manifest.json");
    const motionPath = join(packageRoot, "motion.json");
    const manifest = Buffer.from(`${JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_native_structural", name: "Structural snapshot",
      motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] }
    })}\n`);
    const motion = Buffer.from(`${JSON.stringify({
      schema: "shellx-motion/motion@1", id: "motion_native_structural", name: "Structural snapshot", durationMs: 1000,
      fps: 30, width: 2, height: 2, background: "#000000", assets: [], designTokens: {},
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [{ id: "panel", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 2, height: 2 }, style: { fill: "#22c55e" } }]
    })}\n`);
    await writeFile(manifestPath, manifest);
    await writeFile(motionPath, motion);

    for (const [target, original] of [[manifestPath, manifest], [motionPath, motion]] as const) {
      const outsidePath = join(outsideRoot, `${target.endsWith("manifest.json") ? "manifest" : "motion"}.json`);
      await writeFile(outsidePath, "attacker bytes");
      race.target = target;
      race.outsidePath = outsidePath;
      race.restore = original;

      const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(race.target, "the old pathname re-hash must trigger this post-load swap").toBe(target);
      expect(result.receipt.inputHashes["manifest.json"]).toBe(hashBuffer(manifest));
      expect(result.receipt.inputHashes["motion.json"]).toBe(hashBuffer(motion));
    }
  });
});

function pixel(png: Buffer, x: number, y: number): number[] {
  const image = decodeNativePngRgba(png);
  const offset = (y * image.width + x) * 4;
  return [...image.rgba.subarray(offset, offset + 4)];
}

function solidPng(width: number, height: number, color: { r: number; g: number; b: number; a: number }): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      scanlines[offset] = color.r;
      scanlines[offset + 1] = color.g;
      scanlines[offset + 2] = color.b;
      scanlines[offset + 3] = color.a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
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

const CRC_TABLE = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
