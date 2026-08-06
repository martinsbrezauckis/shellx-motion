/**
 * The frame-hash pass must stay bounded no matter how long the render is (the bounded-frame-hash invariant).
 *
 * The defect: `Promise.all(framePaths.map(hashFile))` opened one descriptor and one 64 KiB read
 * stream PER FRAME simultaneously. The local render guard admits up to 36,000 frames, so the peak
 * was a property of the render rather than of the machine — 36,000 descriptors is two orders of
 * magnitude past macOS's default 256 soft limit, and the failure landed as a late `EMFILE` after
 * the expensive render had already been paid for.
 *
 * Two kinds of proof here, deliberately:
 *   - a MAXIMUM-SIZE synthetic test that drives the full 36,000-frame guard ceiling through a
 *     counting seam, asserting peak in-flight work without creating 36,000 files;
 *   - a REAL-FILE test that counts actual open descriptors in `/proc/self/fd` while hashing, so the
 *     bound is proven against the operating system and not only against the seam.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FRAME_HASH_CONCURRENCY, hashFramePaths } from "./receipts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A hash seam that records how many calls were in flight at once. */
function countingHash(delayTicks = 1): { hash: (path: string) => Promise<string>; peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    hash: async (path: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      for (let tick = 0; tick < delayTicks; tick += 1) await Promise.resolve();
      inFlight -= 1;
      return `hash-${path}`;
    }
  };
}

describe("hashFramePaths keeps frame hashing bounded", () => {
  it("never exceeds the concurrency ceiling at the render guard's maximum frame count", async () => {
    // 36,000 is `assertLocalMotionFrameCountBudget`'s ceiling — the largest sequence a render can
    // legally reach this pass with. No files are created: the seam proves the scheduling shape.
    const framePaths = Array.from({ length: 36_000 }, (_value, index) => `/frames/${index}.png`);
    const counting = countingHash();

    const hashes = await hashFramePaths(framePaths, { hash: counting.hash });

    expect(hashes).toHaveLength(36_000);
    expect(counting.peak()).toBe(FRAME_HASH_CONCURRENCY);
    expect(counting.peak()).toBeLessThanOrEqual(FRAME_HASH_CONCURRENCY);
  });

  it("returns hashes in input order even when frames finish out of order", async () => {
    const framePaths = ["a", "b", "c", "d", "e", "f", "g", "h"];
    // Later frames resolve sooner, so completion order is the reverse of input order.
    const hash = async (path: string): Promise<string> => {
      const ticks = framePaths.length - framePaths.indexOf(path);
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      return `hash-${path}`;
    };

    expect(await hashFramePaths(framePaths, { hash })).toEqual(framePaths.map((path) => `hash-${path}`));
  });

  it("lets every worker settle before a failure propagates, so no descriptor is stranded", async () => {
    let open = 0;
    let leaked = 0;
    const hash = async (path: string): Promise<string> => {
      open += 1;
      try {
        await Promise.resolve();
        if (path === "frame-3") throw new Error("frame 3 is unreadable");
        return `hash-${path}`;
      } finally {
        open -= 1;
        if (open < 0) leaked += 1;
      }
    };

    await expect(hashFramePaths(Array.from({ length: 64 }, (_v, i) => `frame-${i}`), { hash, concurrency: 4 }))
      .rejects.toThrow("frame 3 is unreadable");
    expect(open).toBe(0);
    expect(leaked).toBe(0);
  });

  it("holds the bound against real open file descriptors", async () => {
    // The seam above proves the scheduling; this proves the operating-system consequence, which is
    // the thing that actually broke. Linux-only, because that is where /proc/self/fd exists.
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-frame-hash-bound-"));
    roots.push(root);
    const framePaths: string[] = [];
    for (let index = 0; index < 512; index += 1) {
      const path = join(root, `frame-${String(index).padStart(4, "0")}.bin`);
      await writeFile(path, Buffer.alloc(4096, index % 251));
      framePaths.push(path);
    }

    const baseline = readdirSync("/proc/self/fd").length;
    let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak, readdirSync("/proc/self/fd").length); }, 1);
    try {
      const hashes = await hashFramePaths(framePaths);
      expect(hashes).toHaveLength(512);
      expect(new Set(hashes).size).toBeGreaterThan(1);
    } finally {
      clearInterval(sampler);
    }

    // Slack covers descriptors the test process opens for unrelated reasons while sampling. The
    // pre-fix shape peaked at 512 here (one per frame), so this fails loudly if the bound is lost.
    expect(peak - baseline).toBeLessThanOrEqual(FRAME_HASH_CONCURRENCY + 8);
  }, 45_000);
});
