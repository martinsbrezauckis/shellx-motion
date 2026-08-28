import { inflateSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage, matchRendererCapability, resolveMotionHostRenderCapacity } from "@shellx-motion/core";
import { createNativeRenderSession, NATIVE_CAPABILITY } from "./index";

const tempDirs: string[] = [];
const DENSE_HOST = resolveMotionHostRenderCapacity({
  env: {}, facts: { totalMemoryBytes: 64 * 1024 ** 3, freeMemoryBytes: 48 * 1024 ** 3, logicalCpuCount: 16 },
});

describe("native points renderer", () => {
  afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("draws ordered point coverage and sampled geometry deterministically", async () => {
    const root = await writePointsPackage();
    const pkg = await loadMotionPackage(root);
    const session = await createNativeRenderSession({ packageRoot: root, hostCapacity: DENSE_HOST });
    const first = await session.renderFrameAtMs(0);
    const firstAgain = await session.renderFrameAtMs(0);
    const middle = await session.renderFrameAtMs(500);
    session.close();

    expect(first.ok).toBe(true);
    expect(firstAgain.ok).toBe(true);
    expect(middle.ok).toBe(true);
    if (!first.ok || !firstAgain.ok || !middle.ok) return;
    expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
    expect(NATIVE_CAPABILITY.layerTypes).toContain("points");
    expect(NATIVE_CAPABILITY.features).toContain("points.viewport-batched");
    expect(first.frame.sha256).toBe(firstAgain.frame.sha256);
    expect(first.frame.sha256).not.toBe(middle.frame.sha256);
    expect(readPngPixel(first.frame.png, 32, 32)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(first.frame.png, 26, 32)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(middle.frame.png, 44, 32)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(middle.frame.png, 33, 39)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(middle.frame.png, 33, 32)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });
});

async function writePointsPackage(): Promise<string> {
  const root = await makeTempDir();
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_native_points", name: "Native Points", motion: "motion.json", assets: [],
    sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_native_points", name: "Native Points", durationMs: 1_000, fps: 30, width: 64, height: 64, background: "#00000000",
    layers: [{
      id: "swarm", type: "points", startMs: 0, durationMs: 1_000,
      effects: { trail: { durationMs: 500, samples: 2 } },
      pointCloud: {
        points: [{ x: 32, y: 32, color: "#ff0000", size: 18 }, { x: 32, y: 32, color: "#00ff00", size: 8 },
          ...Array.from({ length: 19_998 }, () => ({ x: 0, y: 0, color: "#000000", size: 1 }))],
        samples: [
          { atMs: 0, positions: [{ x: 32, y: 32 }, { x: 32, y: 32 }, ...Array.from({ length: 19_998 }, () => ({ x: 0, y: 0 }))] },
          { atMs: 1_000, positions: [{ x: 56, y: 32 }, { x: 56, y: 32 }, ...Array.from({ length: 19_998 }, () => ({ x: 0, y: 0 }))] },
        ],
      },
    }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }, null, 2)}\n`);
  return root;
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-native-points-"));
  tempDirs.push(dir);
  return dir;
}

function readPngPixel(png: Buffer, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const width = png.readUInt32BE(16);
  const rowStride = 1 + width * 4;
  const data = inflateSync(readPngChunkData(png, "IDAT"));
  const offset = y * rowStride + 1 + x * 4;
  if (data[y * rowStride] !== 0) throw new Error("Native point fixture expects unfiltered RGBA scanlines.");
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
}

function readPngChunkData(png: Buffer, wantedType: string): Buffer {
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === wantedType) return data;
  }
  throw new Error(`PNG chunk not found: ${wantedType}`);
}
