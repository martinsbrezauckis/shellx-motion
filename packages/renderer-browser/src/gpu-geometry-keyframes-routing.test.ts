import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@shellx-motion/core";
import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { createGpuPreviewSession } from "./gpu-points-preview";
import { fakeGpuRuntime } from "./gpu-streaming-producer.test-support";

describe("strict GPU preview shape geometry-keyframe routing", () => {
  it("renders Core's interpolated geometry wrapper and closes the selected GPU runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-geometry-route-"));
    const publication = mockPublication();
    let opens = 0, closes = 0;
    const plans: Array<{ draws?: Array<{ id?: string; kind?: string; vertices?: Array<{ x: number }> }> }> = [];
    const session = createGpuPreviewSession(packageAt(root), {
      openRuntime: async () => {
        opens += 1;
        const opened = fakeGpuRuntime(() => { closes += 1; });
        if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        return { ok: true, session: { ...opened.session, async render(plan, options) { plans.push(plan as typeof plans[number]); return await render(plan, options); } } };
      }
    });
    try {
      const result = await session.renderFrame({ atMs: 500, outDir: root, outputPath: join(root, "geometry.png") });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(result.receipt.inputHashes["gpu-frame-plan"]).toMatch(/^[a-f0-9]{64}$/);
      expect(opens).toBe(1);
      const draw = plans[0]?.draws?.find((candidate) => candidate.id === "contour");
      expect(draw).toMatchObject({ kind: "coloredTriangles" });
      expect(draw?.vertices?.some((vertex) => vertex.x === 10)).toBe(true);
    } finally {
      const cleanup = await session.close();
      expect(cleanup).toMatchObject({ closed: true });
      expect(closes).toBe(1);
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels before source resources, runtime allocation, or output publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-geometry-cancel-"));
    const outputPath = join(root, "cancelled.png");
    const controller = new AbortController(); controller.abort(new Error("stop geometry"));
    let opens = 0;
    const session = createGpuPreviewSession(packageAt(root), {
      openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); }
    });
    try {
      const result = await session.renderFrame({ atMs: 500, outDir: root, outputPath, signal: controller.signal });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(opens).toBe(0);
      await expect(session.close()).resolves.toMatchObject({ closed: true, runtimeResources: null });
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a resource-bearing geometry package before runtime allocation or output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-geometry-resource-"));
    const outputPath = join(root, "resource.png");
    const pkg = packageAt(root);
    pkg.motion.layers.push({ id: "image", type: "image", assetRef: "assets/subject.png", startMs: 0, durationMs: 1_000, transform: { width: 10, height: 10 } });
    pkg.manifest.assets = ["assets/subject.png"];
    let opens = 0;
    const session = createGpuPreviewSession(pkg, { openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); } });
    try {
      await expect(session.renderFrame({ atMs: 500, outDir: root, outputPath })).resolves.toMatchObject({
        ok: false,
        error: { code: "gpu_resource_refused", message: expect.stringContaining("refuses static resources") }
      });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(opens).toBe(0);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function packageAt(root: string): MotionPackage {
  const polygon = (offset: number) => ({
    schema: "shellx-motion/shape-geometry@1" as const,
    kind: "polygon" as const,
    viewBox: { x: 0, y: 0, width: 64, height: 64 },
    points: [{ x: offset, y: 0 }, { x: offset + 24, y: 0 }, { x: offset + 12, y: 24 }]
  });
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "gpu-geometry-route", name: "GPU geometry route", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "gpu-geometry-route-motion", name: "GPU geometry route", durationMs: 1_000, fps: 30, width: 64, height: 64,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{
        id: "contour", type: "shape", startMs: 0, durationMs: 1_000, transform: { width: 64, height: 64 }, fill: "#ff8040", geometry: polygon(0),
        geometryKeyframes: { schema: "shellx-motion/shape-geometry-keyframes@1", keyframes: [{ atUs: 0, geometry: polygon(0) }, { atUs: 1_000_000, geometry: polygon(20) }] }
      }]
    }
  };
}

function mockPublication() {
  return vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
    stagingPath: `${outputPath}.staging`,
    async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
    async publishFile() {},
    async abort() {}
  } as never));
}
