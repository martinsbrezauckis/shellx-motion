import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, encodeRgbaPng } from "@shellx-motion/core";
import { createGpuGltfObjectRetainedRenderSession } from "@shellx-motion/renderer-browser/internal/gltf-object-retained-render";
import { afterEach, describe, expect, it } from "vitest";
import { compilePhysicsVisualRetainedFramePlan, compilePhysicsVisualRetainedStaticPlan, readPhysicsVisualRetainedFrameUpload, readPhysicsVisualRetainedStaticUpload } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "../physics-visual-retained-private/physics-visual-retained.test-support.js";
import { compilePhysicsVisualPresentationFramePlan, compilePhysicsVisualPresentationStaticPlan, readPhysicsVisualPresentationFrameUpload, readPhysicsVisualPresentationStaticUpload } from "./physics-visual-presentation-private.js";
import { PHYSICS_VISUAL_PRESENTATION_SCHEMA } from "./physics-visual-presentation-types-private.js";

const outputRoot = process.env.MOTION_GPU_C7B4C_OUTPUT_ROOT?.trim(), runner = { enabled: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1", platform: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]) };
const describeQualifiedLinuxGpu = runner.enabled && runner.platform === "linux" && runner.arch === "x64" && runner.node === 24 ? describe : describe.skip;
const roots: string[] = [];
const acceptedC7b4bHashes = {
  bingo: ["92d3e2a2a4666b6cf04fa26057b6d4511e635bee4116f726b2fe7d0e1395b5cc", "a37e7597289c2c904e848c4059d840fefe3a3b39f9b1545620d2ac9b036635ef", "4bed653e160da5b4c9fe7668d7a1299a54b194f16ffcf7227a12ea702abf11fa", "5b71c6b1733c95835f6ed8debceeb470881821082111b9314ba23cd1832839eb"],
  wall: ["596a2e49719f1d9f4e6cf6b89e83107687fef9ef37621e2589817785044dbe26", "425f525f7ec54ffd0ea567dd9c97b2267045c573832809929a7c37af12b21f56", "0a885613b583f5de1176ece114b03defdefff1bdbbe6e0964ce56c4423cc95b7", "135d408af2ebd4b8aef55c83a15da878fa8d73e4e432e8ef9c0581ba39ac1e95"],
} as const;
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describeQualifiedLinuxGpu("qualified Linux GPU host C7B4C retained presentation WebGPU pixels", () => {
  it("renders the translucent Bingo cage and wall ground/tether with retained cleanup", async () => {
    expect(runner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    const proofs = [];
    for (const kind of ["bingo", "wall"] as const) {
      const fixture = await physicsVisualFixture(kind); roots.push(fixture.root);
      const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, kind)), baselineOpened = await createGpuGltfObjectRetainedRenderSession(readPhysicsVisualRetainedStaticUpload(retained));
      expect(baselineOpened.ok, baselineOpened.ok ? undefined : baselineOpened.failure.message).toBe(true); if (!baselineOpened.ok) return;
      const baselineFrames: Uint8Array[] = [], frameIndexes = [0, 60, 150, 300] as const;
      try {
        for (const frameIndex of frameIndexes) { const frame = compilePhysicsVisualRetainedFramePlan(retained, frameIndex), result = await baselineOpened.session.render(readPhysicsVisualRetainedFrameUpload(retained, frame), { timeoutMs: 30_000 }); expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true); if (!result.ok) return; baselineFrames.push(result.frame.rgba); }
      } finally { await baselineOpened.session.close(); }
      expect(baselineFrames.map((rgba) => createHash("sha256").update(rgba).digest("hex"))).toEqual(acceptedC7b4bHashes[kind]);
      const staticPlan = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, presentationRecipe(kind, retained.fingerprint, fixture.physicsPlan.fingerprint)), opened = await createGpuGltfObjectRetainedRenderSession(readPhysicsVisualPresentationStaticUpload(staticPlan));
      expect(opened.ok, opened.ok ? undefined : opened.failure.message).toBe(true); if (!opened.ok) return;
      const expected = kind === "bingo" ? { geometryResourceCount: 2, instanceSlotCount: 11, sharedGeometryReuseCount: 9 } : { geometryResourceCount: 4, instanceSlotCount: 48, sharedGeometryReuseCount: 44 };
      const frames: Array<{ frameIndex: number; planFingerprint: string; baselineRawRgbaSha256: string; rawRgbaSha256: string; changedPixels: number; visiblePixels: number; adapterFingerprint: string; rgba: Uint8Array }> = []; let release: Awaited<ReturnType<typeof opened.session.close>> | null = null;
      try {
        for (const [proofIndex, frameIndex] of frameIndexes.entries()) {
          const framePlan = compilePhysicsVisualPresentationFramePlan(staticPlan, frameIndex), result = await opened.session.render(readPhysicsVisualPresentationFrameUpload(staticPlan, framePlan), { timeoutMs: 30_000 });
          expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true); if (!result.ok) return;
          expect(result.metrics).toMatchObject({ ...expected, preparationOperations: 1, renderedFrames: frames.length + 1, perFrameGpuAllocations: 0 });
          const visiblePixels = nonBackground(result.frame.rgba, [7, 17, 31]), changedPixels = differentPixels(result.frame.rgba, baselineFrames[proofIndex]!); expect(visiblePixels).toBeGreaterThan(kind === "bingo" ? 5_000 : 1_000); expect(changedPixels).toBeGreaterThan(kind === "bingo" ? 1_000 : 100);
          frames.push({ frameIndex, planFingerprint: framePlan.fingerprint, baselineRawRgbaSha256: acceptedC7b4bHashes[kind][proofIndex]!, rawRgbaSha256: createHash("sha256").update(result.frame.rgba).digest("hex"), changedPixels, visiblePixels, adapterFingerprint: result.frame.evidence.adapterFingerprint, rgba: result.frame.rgba });
        }
        expect(new Set(frames.map((frame) => frame.rawRgbaSha256)).size).toBeGreaterThan(1);
      } finally { release = await opened.session.close(); }
      expect(release).toEqual({ schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: expected.geometryResourceCount, destroyedIndexBuffers: expected.geometryResourceCount, destroyedUniformBuffers: expected.instanceSlotCount, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: staticPlan.budget.retainedGpuBytes, remainingGpuBytes: 0 });
      proofs.push({ kind, root: fixture.root, staticPlan, frames, release });
    }
    if (outputRoot) {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      for (const proof of proofs) for (const frame of proof.frames) await writeFile(join(outputRoot, `${proof.kind}-${String(frame.frameIndex).padStart(3, "0")}.png`), encodeRgbaPng(640, 360, Buffer.from(frame.rgba)), { flag: "wx", mode: 0o600 });
      const receipt = { schema: "shellx-motion/physics-visual-presentation-hardware-proof@1", runner, scenarios: proofs.map(({ root: _root, staticPlan, frames, ...proof }) => ({ ...proof, staticFingerprint: staticPlan.fingerprint, budget: staticPlan.budget, frames: frames.map(({ rgba: _rgba, ...frame }) => frame) })) };
      await writeFile(join(outputRoot, "receipt.json"), `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  }, 240_000);
});

function presentationRecipe(kind: "bingo" | "wall", retainedStaticFingerprint: string, physicsPlanFingerprint: string): any {
  if (kind === "bingo") return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-cage-sphere", kind: "sphere", radius: 2.7, quality: "cinematic" }], materials: [{ id: "z-cage-ice", kind: "basic", baseColor: "#8fdcff", emissive: 0.08 }] }, staticCollisionBindings: [], constraintBindings: [], presentationBindings: [{ id: "cage", geometryRef: "z-cage-sphere", materialRef: "z-cage-ice", opacity: 0.18, position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] };
  return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-ground-visual", kind: "box", size: [20, 0.2, 8] }, { id: "z-tether-visual", kind: "box", size: [0.08, 1, 0.08] }], materials: [{ id: "z-ground-matte", kind: "basic", baseColor: "#26364a", emissive: 0 }, { id: "z-tether-steel", kind: "basic", baseColor: "#d9e2ec", emissive: 0.04 }] }, staticCollisionBindings: [{ bodyId: "ground", geometryRef: "z-ground-visual", materialRef: "z-ground-matte" }], constraintBindings: [{ constraintId: "tether", geometryRef: "z-tether-visual", materialRef: "z-tether-steel" }], presentationBindings: [] };
}

function nonBackground(rgba: Uint8Array, background: readonly [number, number, number]): number { let count = 0; for (let index = 0; index < rgba.length; index += 4) if (rgba[index] !== background[0] || rgba[index + 1] !== background[1] || rgba[index + 2] !== background[2]) count += 1; return count; }
function differentPixels(left: Uint8Array, right: Uint8Array): number { let count = 0; for (let index = 0; index < left.length; index += 4) if (left[index] !== right[index] || left[index + 1] !== right[index + 1] || left[index + 2] !== right[index + 2] || left[index + 3] !== right[index + 3]) count += 1; return count; }
