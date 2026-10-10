import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";
import { withLocalTrackingScratch } from "./local-tracking-scratch";

describe("local SDK tracking scratch authority", () => {
  it("allocates distinct owned directories for concurrent requests and cleans only those leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-sdk-tracking-concurrent-"));
    try {
      const paths: string[] = [];
      let release!: () => void;
      const ready = new Promise<void>((done) => { release = done; });
      await Promise.all([1, 2].map(() => withLocalTrackingScratch(root, async (scratch) => {
        paths.push(scratch);
        if (paths.length === 2) release();
        await ready;
      })));
      expect(new Set(paths).size).toBe(2);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a replacement scratch directory untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-sdk-tracking-replaced-"));
    let replacement = "";
    try {
      await expect(withLocalTrackingScratch(root, async (scratch) => {
        replacement = scratch;
        await rename(scratch, join(root, "retained-original"));
        await mkdir(scratch, { mode: 0o700 });
        await writeFile(join(scratch, "keep.txt"), "replacement content");
      })).rejects.toThrow(/changed/);
      expect(await readFile(join(replacement, "keep.txt"), "utf8")).toBe("replacement content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("preserves output siblings when a refused request has configured scratch: %s", async (configuredScratch) => {
    const root = await mkdtemp(join(tmpdir(), "motion-sdk-tracking-authority-"));
    try {
      const packageRoot = join(root, "package");
      const outDir = join(root, "granted-output");
      const analysisId = "tracking_scratch_guard";
      const siblingScratch = join(root, ".shellx-motion-sdk", "tracking-scratch", analysisId);
      const hostScratch = join(root, "host-scratch");
      await cp(resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
      await mkdir(siblingScratch, { recursive: true });
      await writeFile(join(siblingScratch, "keep.txt"), "outside the output grant");
      await mkdir(hostScratch);
      await writeFile(join(hostScratch, "keep.txt"), "host-owned scratch content");
      const sdk = createLocalMotionSdk({
        authoringInputRoots: [packageRoot],
        authoringOutputRoots: [outDir],
        ...(configuredScratch ? { scratchRoot: hostScratch } : {}),
      });
      const result = await sdk.trackingRequest({
        packageRoot, outDir, analysisId, assetId: "missing_asset", mode: "point", model: "translation",
        reference: { atMs: 0, bounds: { x: 6, y: 6, width: 12, height: 12 }, points: [{ x: 11, y: 11 }] },
        settings: {
          startMs: 0, endMs: 200, stepMs: 100, direction: "forward", searchRadiusPx: 10,
          pyramidLevels: 2, maxIterations: 20, confidenceFloor: 0.55, deterministicSeed: 20260714,
        },
      });
      expect(result.ok).toBe(false);
      expect(await readFile(join(siblingScratch, "keep.txt"), "utf8")).toBe("outside the output grant");
      expect(await readdir(hostScratch)).toEqual(["keep.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
