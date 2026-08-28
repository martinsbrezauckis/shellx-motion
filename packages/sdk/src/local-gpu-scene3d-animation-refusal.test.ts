import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ loadPackage: vi.fn(), dispatch: vi.fn() }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/core")>()),
  loadMotionPackage: seams.loadPackage,
}));
vi.mock("@shellx-motion/debug-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/debug-api")>()),
  dispatchDebugCommand: seams.dispatch,
}));
import { createLocalMotionSdk } from "./local.js";

const roots: string[] = [];
afterEach(async () => {
  seams.loadPackage.mockReset();
  seams.dispatch.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local SDK O6 GPU preview boundary", () => {
  it("refuses scene3dAnimation before Debug dispatch or output work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-o6-refusal-"));
    roots.push(root);
    const output = join(root, "must-not-exist");
    seams.loadPackage.mockResolvedValue(scenePackage());

    await expect(createLocalMotionSdk().preview({ packageRoot: "/trusted/package", outDir: output, lane: "gpu" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "motion_scene3d_animation_unavailable",
        message: expect.stringContaining("direct @shellx-motion/renderer-browser renderMotionGpuPreview API")
      }
    });
    expect(seams.dispatch).not.toHaveBeenCalled();
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function scenePackage(): MotionPackage {
  return {
    root: "/trusted/package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_o6_sdk", name: "O6 SDK", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_o6_sdk", name: "O6 SDK", durationMs: 100, fps: 30, width: 16, height: 8,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [],
      scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] },
    }
  } as MotionPackage;
}
