/** Security regressions for persisted timeline UI state. */
import { access, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { MotionPackage, OperationReceipt } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { dispatchTimelineControlCommand, readTimelineControlState, writeTimelineControlState, type TimelineControlState } from "./timeline-controls.js";

async function clonedPackage(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "shellx-motion-timeline-controls-"));
}

function testPackage(root: string): MotionPackage {
  return { root, manifest: { id: "pkg_timeline_controls" }, motion: { id: "motion_timeline_controls", durationMs: 3_000 } } as MotionPackage;
}

async function clonedMotionPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-timeline-controls-package-"));
  await writeFile(join(root, "manifest.json"), "{\"id\":\"pkg_timeline_controls\",\"motion\":\"motion.json\"}\n");
  await writeFile(join(root, "motion.json"), "{\"id\":\"motion_timeline_controls\",\"durationMs\":3000}\n");
  return root;
}

function commandPackage(root: string): MotionPackage {
  return {
    root,
    manifest: { id: "pkg_timeline_controls", motion: "motion.json" },
    motion: { id: "motion_timeline_controls", durationMs: 3_000 }
  } as MotionPackage;
}

async function stateDirectoryExists(packageRoot: string): Promise<boolean> {
  try {
    await access(join(packageRoot, ".shellx-motion"));
    return true;
  } catch {
    return false;
  }
}

describe("safe timeline control persistence", () => {
  it("keeps missing durable state as a portable, read-only default", async () => {
    const packageRoot = await clonedPackage();
    try {
      await expect(readTimelineControlState(testPackage(packageRoot))).resolves.toMatchObject({
        state: { playheadMs: 0 },
        warnings: []
      });
      expect(await stateDirectoryExists(packageRoot)).toBe(false);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("persists a timeline command through the admitted Linux capability", async () => {
    const packageRoot = await clonedMotionPackage();
    const receiptWrites: Array<{ root: string; receipt: OperationReceipt }> = [];
    try {
      const result = await dispatchTimelineControlCommand(
        "motion.timeline.playhead.set",
        { packageRoot, playheadMs: 250 },
        {
          packageLoader: async () => commandPackage(packageRoot),
          readTimelineControls: readTimelineControlState,
          writeTimelineControls: writeTimelineControlState,
          writeReceipt: async (root, receipt) => {
            receiptWrites.push({ root, receipt });
            return join(root, `${receipt.id}.receipt.json`);
          },
          receiptsRoot: "/host/receipts"
        }
      );

      expect(result).toMatchObject({ ok: true, result: { controls: { playheadMs: 250 } } });
      await expect(readTimelineControlState(testPackage(packageRoot))).resolves.toMatchObject({
        state: { playheadMs: 250 }
      });
      expect(receiptWrites).toHaveLength(1);
      expect(receiptWrites[0]).toMatchObject({ root: "/host/receipts", receipt: { operation: "timeline.playhead.set" } });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  describe.each(["darwin", "win32"] as const)("unsupported %s durable-control host", (timelineControlPersistencePlatform) => {
    it.each([
      ["motion.timeline.playhead.set", { packageRoot: "/not-loaded", playheadMs: 250 }],
      ["motion.timeline.range.select", { packageRoot: "/not-loaded", startMs: 100, endMs: 250 }],
      ["motion.timeline.viewport.set", { packageRoot: "/not-loaded", startMs: 100, endMs: 250 }]
    ] as const)("refuses %s before any durable control side effect", async (command, args) => {
      const packageRoot = await clonedPackage();
      let packageLoads = 0;
      let controlReads = 0;
      let controlWrites = 0;
      let receiptWrites = 0;

      try {
        const result = await dispatchTimelineControlCommand(command, { ...args, packageRoot }, {
          timelineControlPersistencePlatform,
          packageLoader: async () => { packageLoads += 1; throw new Error("must not load"); },
          readTimelineControls: async () => { controlReads += 1; throw new Error("must not read"); },
          writeTimelineControls: async () => { controlWrites += 1; throw new Error("must not write"); },
          writeReceipt: async () => { receiptWrites += 1; throw new Error("must not write receipt"); },
          receiptsRoot: "/host/receipts"
        });

        expect(result).toMatchObject({
          ok: false,
          error: { code: "capability_unavailable", message: expect.stringContaining("Linux retained no-follow") }
        });
        expect({ packageLoads, controlReads, controlWrites, receiptWrites }).toEqual({
          packageLoads: 0,
          controlReads: 0,
          controlWrites: 0,
          receiptWrites: 0
        });
        expect(await stateDirectoryExists(packageRoot)).toBe(false);
      } finally {
        await rm(packageRoot, { recursive: true, force: true });
      }
    });
  });

  it("refuses durable controls before side effects on Linux without the descriptor namespace", async () => {
    const packageRoot = await clonedPackage();
    let packageLoads = 0;
    let controlReads = 0;
    let controlWrites = 0;
    let receiptWrites = 0;
    try {
      const result = await dispatchTimelineControlCommand(
        "motion.timeline.playhead.set",
        { packageRoot, playheadMs: 250 },
        {
          timelineControlPersistencePlatform: "linux",
          timelineControlPersistenceProcSelfFdUsable: () => false,
          packageLoader: async () => { packageLoads += 1; throw new Error("must not load"); },
          readTimelineControls: async () => { controlReads += 1; throw new Error("must not read"); },
          writeTimelineControls: async () => { controlWrites += 1; throw new Error("must not write"); },
          writeReceipt: async () => { receiptWrites += 1; throw new Error("must not write receipt"); },
          receiptsRoot: "/host/receipts"
        }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
      expect({ packageLoads, controlReads, controlWrites, receiptWrites }).toEqual({
        packageLoads: 0,
        controlReads: 0,
        controlWrites: 0,
        receiptWrites: 0
      });
      expect(await stateDirectoryExists(packageRoot)).toBe(false);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("atomically writes and reloads bounded control state", async () => {
    const packageRoot = await clonedPackage();
    try {
      const pkg = testPackage(packageRoot);
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
      const pkg = testPackage(packageRoot);
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
      const pkg = testPackage(packageRoot);
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

  it.skipIf(process.platform !== "linux")("retains the admitted directory through a post-recheck parent retarget", async () => {
    const packageRoot = await clonedPackage();
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-timeline-controls-outside-"));
    try {
      const pkg = testPackage(packageRoot);
      const state: TimelineControlState = {
        schema: "shellx-motion/timeline-state@1", packageId: pkg.manifest.id, motionId: pkg.motion.id,
        durationMs: pkg.motion.durationMs, playheadMs: 100, updatedAt: "2026-08-21T00:00:00.000Z"
      };
      const stateDir = join(packageRoot, ".shellx-motion");
      const heldDir = join(packageRoot, ".shellx-motion-held");
      await expect(writeTimelineControlState(pkg, state, {
        afterDirectoryRecheck: async ({ temporaryStatePath }) => {
          await rename(stateDir, heldDir);
          await symlink(outsideRoot, stateDir, "dir");
          await writeFile(join(outsideRoot, basename(temporaryStatePath)), "attacker controlled temporary state", "utf8");
        }
      })).rejects.toThrow(/state directory/);
      await expect(readFile(join(outsideRoot, "timeline-state.json"), "utf8")).rejects.toThrow(/ENOENT/);
      await expect(readFile(join(heldDir, "timeline-state.json"), "utf8")).resolves.toContain('"playheadMs": 100');
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("refuses a temporary state file whose link count changes after the final directory recheck", async () => {
    const packageRoot = await clonedPackage();
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-timeline-controls-outside-"));
    try {
      const pkg = testPackage(packageRoot);
      const state: TimelineControlState = {
        schema: "shellx-motion/timeline-state@1", packageId: pkg.manifest.id, motionId: pkg.motion.id,
        durationMs: pkg.motion.durationMs, playheadMs: 100, updatedAt: "2026-08-21T00:00:00.000Z"
      };
      await expect(writeTimelineControlState(pkg, state, {
        afterDirectoryRecheck: async ({ temporaryStatePath }) => {
          await link(temporaryStatePath, join(outsideRoot, "linked-temporary-state.json"));
        }
      })).rejects.toThrow(/temporary state changed before commit/);
      await expect(readFile(join(packageRoot, ".shellx-motion", "timeline-state.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
