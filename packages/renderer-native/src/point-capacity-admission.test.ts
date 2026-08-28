import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMotionHostRenderCapacity } from "@shellx-motion/core";
import { createNativeRenderSession } from "./index";

const roots: string[] = [];
const GIB = 1024 ** 3;

describe("native point capacity admission", () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("refuses dense points before hashing or raster allocation on a portable host", async () => {
    const packageRoot = await writeDensePackage();
    const hostCapacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 16 * GIB, freeMemoryBytes: 7 * GIB, logicalCpuCount: 8 },
    });
    await expect(createNativeRenderSession({ packageRoot, hostCapacity }))
      .rejects.toMatchObject({ code: "job_input_budget_exceeded", capacityCode: "point_capacity_exceeded" });
  });
});

async function writeDensePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "motion-native-point-capacity-"));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_dense_native", name: "Dense", motion: "motion.json", assets: [],
    sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] },
  }));
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_dense_native", name: "Dense", durationMs: 1_000,
    fps: 30, width: 64, height: 64, layers: [{ id: "dense", type: "points", startMs: 0, durationMs: 1_000,
      pointCloud: { points: Array.from({ length: 9_000 }, (_entry, index) => ({ x: index % 64, y: 1 })) } }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }));
  return root;
}
