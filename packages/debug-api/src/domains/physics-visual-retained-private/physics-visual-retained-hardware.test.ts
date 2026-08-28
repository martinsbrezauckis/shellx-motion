import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, encodeRgbaPng } from "@shellx-motion/core";
import { createGpuGltfObjectRetainedRenderSession } from "@shellx-motion/renderer-browser/internal/gltf-object-retained-render";
import { afterEach, describe, expect, it } from "vitest";
import { compilePhysicsVisualRetainedFramePlan, compilePhysicsVisualRetainedStaticPlan, readPhysicsVisualRetainedFrameUpload, readPhysicsVisualRetainedStaticUpload } from "./physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "./physics-visual-retained.test-support.js";

const outputRoot = process.env.MOTION_GPU_C7B4B_OUTPUT_ROOT?.trim(), runner = { enabled: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1", platform: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]) };
const describeQualifiedLinuxGpu = runner.enabled && runner.platform === "linux" && runner.arch === "x64" && runner.node === 24 ? describe : describe.skip;
const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describeQualifiedLinuxGpu("qualified Linux GPU host C7B4B retained physics-visual WebGPU pixels", () => {
  it("renders distinct Bingo and wall frames with retained geometry/uniform slots and terminal zero-byte cleanup", async () => {
    expect(runner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    const proofs = [];
    for (const kind of ["bingo", "wall"] as const) {
      const fixture = await physicsVisualFixture(kind); roots.push(fixture.root); const staticPlan = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, kind)), opened = await createGpuGltfObjectRetainedRenderSession(readPhysicsVisualRetainedStaticUpload(staticPlan));
      expect(opened.ok, opened.ok ? undefined : opened.failure.message).toBe(true); if (!opened.ok) return;
      const frames: Array<{ frameIndex: number; planFingerprint: string; rawRgbaSha256: string; visiblePixels: number; adapterFingerprint: string; rgba: Uint8Array }> = []; let release: Awaited<ReturnType<typeof opened.session.close>> | null = null;
      try {
        for (const frameIndex of [0, 60, 150, 300]) {
          const framePlan = compilePhysicsVisualRetainedFramePlan(staticPlan, frameIndex), result = await opened.session.render(readPhysicsVisualRetainedFrameUpload(staticPlan, framePlan), { timeoutMs: 30_000 });
          expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true); if (!result.ok) return;
          expect(result.metrics).toMatchObject({ geometryResourceCount: kind === "bingo" ? 1 : 2, instanceSlotCount: kind === "bingo" ? 10 : 46, sharedGeometryReuseCount: kind === "bingo" ? 9 : 44, preparationOperations: 1, renderedFrames: frames.length + 1, perFrameGpuAllocations: 0 });
          const visiblePixels = nonBackground(result.frame.rgba, [7, 17, 31]); expect(visiblePixels).toBeGreaterThan(100);
          frames.push({ frameIndex, planFingerprint: framePlan.fingerprint, rawRgbaSha256: createHash("sha256").update(result.frame.rgba).digest("hex"), visiblePixels, adapterFingerprint: result.frame.evidence.adapterFingerprint, rgba: result.frame.rgba });
        }
        expect(new Set(frames.map((frame) => frame.rawRgbaSha256)).size).toBeGreaterThan(1);
      } finally { release = await opened.session.close(); }
      expect(release).toEqual({ schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: kind === "bingo" ? 1 : 2, destroyedIndexBuffers: kind === "bingo" ? 1 : 2, destroyedUniformBuffers: kind === "bingo" ? 10 : 46, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: staticPlan.budget.retainedGpuBytes, remainingGpuBytes: 0 });
      proofs.push({ kind, root: fixture.root, staticPlan, frames, release });
    }
    if (outputRoot) {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      for (const proof of proofs) for (const frame of proof.frames) await writeFile(join(outputRoot, `${proof.kind}-${String(frame.frameIndex).padStart(3, "0")}.png`), encodeRgbaPng(640, 360, Buffer.from(frame.rgba)), { flag: "wx", mode: 0o600 });
      const receipt = { schema: "shellx-motion/physics-visual-retained-hardware-proof@1", runner, scenarios: proofs.map(({ root: _root, staticPlan, frames, ...proof }) => ({ ...proof, staticFingerprint: staticPlan.fingerprint, budget: staticPlan.budget, frames: frames.map(({ rgba: _rgba, ...frame }) => frame) })) };
      await writeFile(join(outputRoot, "receipt.json"), `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  }, 240_000);
});

function nonBackground(rgba: Uint8Array, background: readonly [number, number, number]): number { let count = 0; for (let index = 0; index < rgba.length; index += 4) if (rgba[index] !== background[0] || rgba[index + 1] !== background[1] || rgba[index + 2] !== background[2]) count += 1; return count; }
