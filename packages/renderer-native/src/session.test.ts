// Session parity, load-once, and snapshot-semantics tests for the native render session. Proves
// createNativeRenderSession renders byte-for-byte the same frames and receipts as
// per-frame renderNativePreviewFrame, that it loads/decodes once, and that it snapshots image assets at
// first use (the documented mutation-safety contract).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeRenderSession, renderNativePreviewFrame } from "./index";

const tempDirs: string[] = [];

describe("native render session", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders a frame sequence byte-identically to per-frame renderNativePreviewFrame", async () => {
    const packageRoot = await writeImagePackage();
    const atMsSequence = [0, 100, 250, 500, 999];
    const now = (): string => "2026-07-22T00:00:00.000Z";

    // Baseline: a fresh single-frame call per frame (reloads the package + re-decodes assets each time).
    const perFrame = [] as Array<Awaited<ReturnType<typeof renderNativePreviewFrame>>>;
    for (const atMs of atMsSequence) {
      perFrame.push(await renderNativePreviewFrame({ packageRoot, atMs, now }));
    }

    // Session: one load, N frames from in-memory state.
    const session = await createNativeRenderSession({ packageRoot, now });
    const sessionFrames = [] as Array<Awaited<ReturnType<typeof session.renderFrameAtMs>>>;
    try {
      for (const atMs of atMsSequence) {
        sessionFrames.push(await session.renderFrameAtMs(atMs));
      }
    } finally {
      session.close();
    }

    // The keyframed box moves, so distinct times must yield distinct frames (interpolation really ran).
    expect(sessionFrames[0].ok && sessionFrames[4].ok).toBe(true);
    if (sessionFrames[0].ok && sessionFrames[4].ok) {
      expect(sessionFrames[0].frame.sha256).not.toBe(sessionFrames[4].frame.sha256);
    }

    for (let index = 0; index < atMsSequence.length; index += 1) {
      const single = perFrame[index];
      const fromSession = sessionFrames[index];
      expect(single.ok).toBe(true);
      expect(fromSession.ok).toBe(true);
      if (!single.ok || !fromSession.ok) return;
      // Byte-identical frame PNG (implies identical decoded pixels) and identical sha256.
      expect(fromSession.frame.png.equals(single.frame.png)).toBe(true);
      expect(fromSession.frame.sha256).toBe(single.frame.sha256);
      // Equal receipt input evidence and content-addressed id.
      expect(fromSession.receipt.inputHashes).toEqual(single.receipt.inputHashes);
      expect(fromSession.receipt.id).toBe(single.receipt.id);
      // The composited image asset is attested in both paths.
      expect(single.receipt.inputHashes["assets/logo.png"]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("writes the frame PNG to disk identically to the single-frame path", async () => {
    const packageRoot = await writeImagePackage();
    const wrapperDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const wrapperPath = join(wrapperDir, "frame.png");
    const sessionPath = join(sessionDir, "frame.png");

    const wrapper = await renderNativePreviewFrame({ packageRoot, atMs: 0, outputPath: wrapperPath, outputRoots: [wrapperDir] });
    const session = await createNativeRenderSession({ packageRoot, outputRoots: [sessionDir] });
    let sessionResult: Awaited<ReturnType<typeof session.renderFrameAtMs>>;
    try {
      sessionResult = await session.renderFrameAtMs(0, sessionPath);
    } finally {
      session.close();
    }

    expect(wrapper.ok).toBe(true);
    expect(sessionResult.ok).toBe(true);
    const wrapperBytes = await readFile(wrapperPath);
    const sessionBytes = await readFile(sessionPath);
    expect(sessionBytes.equals(wrapperBytes)).toBe(true);
  });

  it("enforces the configured output roots on every rendered frame", async () => {
    const packageRoot = await writeImagePackage();
    const outDir = await makeTempDir();
    const session = await createNativeRenderSession({ packageRoot, outputRoots: [outDir] });
    try {
      await expect(session.renderFrameAtMs(0, join(outDir, "..", "escaped.png")))
        .rejects.toThrow(/Native output path must be inside a configured output root/);
    } finally {
      session.close();
    }
  });

  it("snapshots decoded assets: a mid-session swap does not change later frames, unlike a fresh render", async () => {
    const packageRoot = await writeImagePackage();
    const assetPath = join(packageRoot, "assets", "logo.png");
    const key = "assets/logo.png";
    const swappedAsset = makeRgbaPngFixture(2, 2, [
      { r: 10, g: 20, b: 30, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ]);

    const session = await createNativeRenderSession({ packageRoot });
    let before: Awaited<ReturnType<typeof session.renderFrameAtMs>>;
    let afterSwapSameSession: Awaited<ReturnType<typeof session.renderFrameAtMs>>;
    try {
      before = await session.renderFrameAtMs(0);
      // Swap the asset bytes underneath the still-open session.
      await writeFile(assetPath, swappedAsset);
      afterSwapSameSession = await session.renderFrameAtMs(200);
    } finally {
      session.close();
    }
    // A new single-frame render re-reads the mutated asset from disk.
    const freshAfterSwap = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

    expect(before.ok).toBe(true);
    expect(afterSwapSameSession.ok).toBe(true);
    expect(freshAfterSwap.ok).toBe(true);
    if (!before.ok || !afterSwapSameSession.ok || !freshAfterSwap.ok) return;
    // Snapshot: the open session keeps the first-decoded bytes, so the attested hash is unchanged.
    expect(afterSwapSameSession.receipt.inputHashes[key]).toBe(before.receipt.inputHashes[key]);
    // Re-read: a fresh render observes the on-disk mutation, so its attested hash differs.
    expect(freshAfterSwap.receipt.inputHashes[key]).not.toBe(before.receipt.inputHashes[key]);
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-renderer-native-session-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write a minimal native package with a keyframed shape (so frames differ over time) and a static PNG
 * image layer (so both structural and image-asset input hashes are exercised).
 */
async function writeImagePackage(): Promise<string> {
  const root = await makeTempDir();
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(
      {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_session_parity",
        name: "Session Parity",
        motion: "motion.json",
        assets: [],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["native"], hosts: ["motion"] }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify(
      {
        schema: "shellx-motion/motion@1",
        id: "motion_session_parity",
        name: "motion_session_parity",
        durationMs: 1000,
        fps: 30,
        width: 320,
        height: 180,
        background: "#000000",
        layers: [
          {
            id: "box",
            type: "shape",
            shape: "rect",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 10, y: 12, width: 40, height: 40 },
            style: { fill: "#ff0000" },
            keyframes: {
              "transform.x": [
                { atMs: 0, value: 10, easing: "linear" },
                { atMs: 1000, value: 120 }
              ]
            }
          },
          {
            id: "logo",
            type: "image",
            source: "assets/logo.png",
            assetRef: "assets/logo.png",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 200, y: 24, width: 4, height: 4 },
            fit: "fill"
          }
        ],
        assets: [],
        designTokens: {},
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      },
      null,
      2
    )}\n`
  );
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "assets", "logo.png"),
    makeRgbaPngFixture(2, 2, [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ])
  );
  return resolve(root);
}

function makeRgbaPngFixture(width: number, height: number, pixels: Array<{ r: number; g: number; b: number; a: number }>): Buffer {
  expect(pixels).toHaveLength(width * height);
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x];
      const offset = rowStart + 1 + x * 4;
      scanlines[offset] = pixel.r;
      scanlines[offset + 1] = pixel.g;
      scanlines[offset + 2] = pixel.b;
      scanlines[offset + 3] = pixel.a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngFixtureChunk("IHDR", ihdr),
    pngFixtureChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngFixtureChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngFixtureChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32Fixture(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

const CRC_FIXTURE_TABLE = createCrcFixtureTable();

function createCrcFixtureTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32Fixture(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_FIXTURE_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
