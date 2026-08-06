/** Security regressions for persisted timeline UI state. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { readTimelineControlState, writeTimelineControlState, type TimelineControlState } from "./timeline-controls.js";

async function clonedPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-timeline-controls-"));
  await cp("../../fixtures/packages/keyframed-lower-third", root, { recursive: true });
  return root;
}

describe("safe timeline control persistence", () => {
  it("atomically writes and reloads bounded control state", async () => {
    const packageRoot = await clonedPackage();
    try {
      const pkg = await loadMotionPackage(packageRoot);
      const initial = await readTimelineControlState(pkg);
      const state: TimelineControlState = {
        ...initial.state,
        playheadMs: 250,
        selectedRange: { startMs: 100, endMs: 350 },
        updatedAt: "2026-07-11T00:00:00.000Z"
      };
      expect(await writeTimelineControlState(pkg, state)).toBe(join(packageRoot, ".shellx-motion", "timeline-state.json"));
      await expect(readTimelineControlState(pkg)).resolves.toMatchObject({ state, warnings: [] });
      expect((await readdir(join(packageRoot, ".shellx-motion"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a package-controlled state-directory symlink", async () => {
    const packageRoot = await clonedPackage();
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-timeline-controls-outside-"));
    try {
      const pkg = await loadMotionPackage(packageRoot);
      await symlink(outsideRoot, join(packageRoot, ".shellx-motion"), "dir");
      const state: TimelineControlState = {
        schema: "shellx-motion/timeline-state@1",
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        durationMs: pkg.motion.durationMs,
        playheadMs: 100,
        updatedAt: "2026-07-11T00:00:00.000Z"
      };
      await expect(writeTimelineControlState(pkg, state)).rejects.toThrow(/real directory/);
      await expect(readFile(join(outsideRoot, "timeline-state.json"), "utf8")).rejects.toThrow(/ENOENT/);
      await expect(readTimelineControlState(pkg)).resolves.toMatchObject({
        state: { playheadMs: 0 },
        warnings: [expect.stringContaining("Ignored unreadable timeline control state")]
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("ignores state files above the one-megabyte read limit", async () => {
    const packageRoot = await clonedPackage();
    try {
      const pkg = await loadMotionPackage(packageRoot);
      const stateDir = join(packageRoot, ".shellx-motion");
      await mkdir(stateDir);
      await writeFile(join(stateDir, "timeline-state.json"), Buffer.alloc(1024 * 1024 + 1, 0x20));
      await expect(readTimelineControlState(pkg)).resolves.toMatchObject({
        state: { playheadMs: 0 },
        warnings: [expect.stringContaining("Ignored unreadable timeline control state")]
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });
});
