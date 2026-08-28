import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage, resolveMotionHostRenderCapacity } from "@shellx-motion/core";
import { createMotionBrowserRenderSession } from "./index";

const roots: string[] = [];
const GIB = 1024 ** 3;

describe("browser point capacity admission", () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("refuses dense points before launching Chromium on a portable host", async () => {
    const pkg = await loadMotionPackage(await writeDensePackage());
    const hostCapacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 16 * GIB, freeMemoryBytes: 7 * GIB, logicalCpuCount: 8 },
    });
    let launched = false;
    await expect(createMotionBrowserRenderSession(pkg, {
      hostCapacity,
      launchBrowser: async () => {
        launched = true;
        throw new Error("browser launch must not run");
      },
    })).rejects.toMatchObject({ code: "job_input_budget_exceeded", capacityCode: "point_capacity_exceeded" });
    expect(launched).toBe(false);
  });
});

async function writeDensePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "motion-browser-point-capacity-"));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_dense_browser", name: "Dense", motion: "motion.json", assets: [],
    sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] },
  }));
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_dense_browser", name: "Dense", durationMs: 1_000,
    fps: 30, width: 64, height: 64, layers: [{ id: "dense", type: "points", startMs: 0, durationMs: 1_000,
      pointCloud: { points: Array.from({ length: 9_000 }, (_entry, index) => ({ x: index % 64, y: 1 })) } }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }));
  return root;
}
