import { createHash } from "node:crypto";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, encodeRgbaPng } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { reopenPhysicsVisualPackageFinalVideoInput } from "@shellx-motion/debug-api/internal/physics-visual-installed-final-video";
import { createGpuGltfObjectRetainedRenderSession } from "@shellx-motion/renderer-browser/internal/gltf-object-retained-render";
import { describe, expect, it } from "vitest";
import { bakePhysicsToDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import { compilePhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { materializePhysicsVisualPackage, preparePhysicsVisualPackageMaterialization } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";
import { compilePhysicsVisualPresentationFramePlan, compilePhysicsVisualPresentationStaticPlan, readPhysicsVisualPresentationFrameUpload, readPhysicsVisualPresentationStaticUpload } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { compilePhysicsShowcaseScenario, createPhysicsShowcasePresentationRecipe, createPhysicsShowcaseRetainedRenderRecipe, createPhysicsShowcaseScenario, createPhysicsShowcaseVisualBindingRecipe } from "./unadopted/physics-showcase-scenario-private.js";

const outputRoot = process.env.MOTION_GPU_C7B6D_OUTPUT_ROOT?.trim();
const candidateRevision = process.env.MOTION_C7B6D_CANDIDATE_REVISION?.trim();
const runner = Object.freeze({
  enabled: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1",
  platform: process.platform,
  arch: process.arch,
  node: Number(process.versions.node.split(".")[0]),
});
const describeQualifiedLinuxGpu = runner.enabled && runner.platform === "linux" && runner.arch === "x64" && runner.node === 24 ? describe : describe.skip;
const frameIndexes = [0, 1, 225, 449, 450] as const;
const finalC7b6cBingoLonger = {
  compilation: "fe71cff3cc34534328f5fcd779a832ee4a7f28e272a2e851f2c406e3ab6c973b",
  physicsPlan: "443333a946b49d4533fe1238a2d809f447ad4134c13a17585106ffe6d6c752d1",
  visualBinding: "57c9f23a1f5d183cbdaa923b64ea8df1ba3ceddfd25faab0a9519fa7e14b4815",
  retainedStatic: "9a1a170de344dbf5a4b146a954ca3d1e8c851d031970fa94bb451e879254a1ed",
  presentationStatic: "3905249ae6a673bf28057de9389229aae45cea5e9359e75a33843a80d0409369",
} as const;

describeQualifiedLinuxGpu("qualified Linux GPU host C7B6D output-only Bingo-longer retained WebGPU pixels", () => {
  it("derives C7B2-C7B4D, deletes inputs, then pixel-proves five compiler-minted output-only frames", async () => {
    expect(runner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    if (!outputRoot) throw new Error("MOTION_GPU_C7B6D_OUTPUT_ROOT is required for the private C7B6D native proof.");
    if (!candidateRevision || !/^[a-f0-9]{40}$/u.test(candidateRevision)) throw new Error("MOTION_C7B6D_CANDIDATE_REVISION must be the exact 40-hex source revision under test.");
    const root = resolve(outputRoot);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("MOTION_GPU_C7B6D_OUTPUT_ROOT must be an absent fresh proof root.");
      throw error;
    });

    const prepared = await materializeBingoLonger(root);
    await rm(prepared.sourcePackageRoot, { recursive: true, force: true });
    await rm(prepared.physicsWorkspaceRoot, { recursive: true, force: true });
    expect(await exists(prepared.sourcePackageRoot)).toBe(false);
    expect(await exists(prepared.physicsWorkspaceRoot)).toBe(false);

    const input = await reopenPhysicsVisualPackageFinalVideoInput(prepared.packageHost);
    expect(input.schedule).toEqual({ startUs: 0, endUs: 7_500_000, stepsPerSecond: 120, stepCount: 900, sampleEverySteps: 2, frameRate: 60, renderFrameCount: 450, terminalFrameIndex: 450, displayedFrameCount: 451, durationMs: 7_516.666666666667 });
    expect({ compilation: prepared.compilation.fingerprint, physicsPlan: prepared.compilation.physicsPlan.fingerprint, visualBinding: prepared.visual.fingerprint, retainedStatic: prepared.retained.fingerprint, presentationStatic: prepared.presentation.fingerprint }).toEqual(finalC7b6cBingoLonger);
    expect(input.installed.plans).toMatchObject({ physicsPlanFingerprint: finalC7b6cBingoLonger.physicsPlan, visualBindingFingerprint: finalC7b6cBingoLonger.visualBinding, retainedStaticFingerprint: finalC7b6cBingoLonger.retainedStatic, presentationStaticFingerprint: finalC7b6cBingoLonger.presentationStatic });
    expect(input.installed.presentationStaticFingerprint).toBe(input.preview.presentationStaticPlan.fingerprint);
    expect(input.preview.presentationStaticPlan.recipe).toEqual(prepared.presentation.recipe);

    const enclosure = prepared.compilation.enclosure!;
    expect([...enclosure.record.center, enclosure.record.visibleRadius, enclosure.record.surfaceMargin, prepared.ballRadius].every(isF32)).toBe(true);
    const cage = input.preview.presentationStaticPlan.recipe.presentationBindings[0];
    expect(cage).toEqual({ id: "cage", geometryRef: "z-cage-sphere", materialRef: "z-cage-ice", opacity: Math.fround(0.16), position: enclosure.record.center, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(input.preview.presentationStaticPlan.recipe.additionalResources.geometry).toEqual([{ id: "z-cage-sphere", kind: "sphere", radius: enclosure.record.visibleRadius, quality: "cinematic" }]);
    const staticPlan = input.preview.presentationStaticPlan;
    expect(staticPlan.budget).toMatchObject({ geometryResourceCount: 2, instanceSlotCount: 17, presentationBindingCount: 1, reusedInstanceCount: 15, transparentPresentationCount: 1 });
    expect(staticPlan.instanceSlots.slice(0, 16).map((slot) => slot.sourceId)).toEqual(Array.from({ length: 16 }, (_entry, index) => `ball-${String(index).padStart(2, "0")}`));
    expect(staticPlan.instanceSlots.at(-1)).toMatchObject({ instanceId: "c7b4c-fixed-cage", kind: "presentation", sourceId: "cage", renderMode: "alpha" });

    const opened = await createGpuGltfObjectRetainedRenderSession(readPhysicsVisualPresentationStaticUpload(staticPlan));
    expect(opened.ok, opened.ok ? undefined : opened.failure.message).toBe(true);
    if (!opened.ok) return;
    const frames: Array<RenderedFrame> = [];
    let release: Awaited<ReturnType<typeof opened.session.close>> | undefined;
    try {
      for (const frameIndex of frameIndexes) {
        const plan = compilePhysicsVisualPresentationFramePlan(staticPlan, frameIndex);
        const containment = boundContainment(plan, enclosure.record.center, prepared.ballRadius, enclosure.record.visibleRadius - enclosure.record.surfaceMargin);
        expect(containment.maxSurfaceDistance).toBeLessThanOrEqual(containment.limit);
        expect(plan.bindings.slice(0, 16).flatMap((binding) => binding.modelMatrix.slice(12, 15)).every(isF32)).toBe(true);
        const result = await opened.session.render(readPhysicsVisualPresentationFrameUpload(staticPlan, plan), { timeoutMs: 30_000 });
        expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true);
        if (!result.ok) return;
        expect(result.metrics).toMatchObject({ geometryResourceCount: 2, instanceSlotCount: 17, sharedGeometryReuseCount: 15, preparationOperations: 1, renderedFrames: frames.length + 1, perFrameGpuAllocations: 0 });
        const rgba = result.frame.rgba, visiblePixels = nonBackground(rgba, [7, 17, 31]);
        expect(visiblePixels).toBeGreaterThan(5_000);
        frames.push({ frameIndex, planFingerprint: plan.fingerprint, terminal: plan.terminal, rawRgbaSha256: createHash("sha256").update(rgba).digest("hex"), visiblePixels, containment, adapterFingerprint: result.frame.evidence.adapterFingerprint, viewport: plan.viewport, viewProjection: plan.viewProjection, rgba, ballCenters: trackedBallCenters(plan) });
      }
    } finally {
      release = await opened.session.close();
    }
    expect(frames.map((frame) => frame.frameIndex)).toEqual(frameIndexes);
    expect(frames.map((frame) => frame.terminal)).toEqual([false, false, false, false, true]);
    expect(new Set(frames.map((frame) => frame.rawRgbaSha256)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(frames.map((frame) => frame.adapterFingerprint)).size).toBe(1);
    expect(release).toEqual({ schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: 2, destroyedIndexBuffers: 2, destroyedUniformBuffers: 17, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: staticPlan.budget.retainedGpuBytes, remainingGpuBytes: 0 });

    const bodyMotionPixelWindows = bodyMotionPixelWindowsFor(frames);
    expect(bodyMotionPixelWindows.filter((entry) => entry.positionDelta <= 0 || entry.changedPixelsAtProjectedCenter <= 0)).toEqual([]);
    for (const frame of frames) await writeFile(join(root, `bingo-longer-${String(frame.frameIndex).padStart(3, "0")}.png`), encodeRgbaPng(frame.viewport.width, frame.viewport.height, Buffer.from(frame.rgba)), { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "c7b6d-native-pixel-proof.json"), `${canonicalJson({
      schema: "shellx-motion/private-c7b6d-bingo-longer-native-pixel-proof@1",
      runner: { ...runner, candidateRevision },
      installed: input.installed,
      schedule: input.schedule,
      enclosure: { record: enclosure.record, ballRadius: prepared.ballRadius, panelCount: enclosure.panels.length, f32: true },
      retained: { staticFingerprint: staticPlan.fingerprint, budget: staticPlan.budget, adapterFingerprint: frames[0]!.adapterFingerprint, browserVersion: opened.session.browserVersion, runtime: opened.session.runtimeEvidence, cleanup: release },
      frames: frames.map(({ rgba: _rgba, ballCenters: _centers, ...frame }) => frame),
      bodyMotionPixelWindows,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }, 240_000);
});

interface RenderedFrame {
  readonly frameIndex: number;
  readonly planFingerprint: string;
  readonly terminal: boolean;
  readonly rawRgbaSha256: string;
  readonly visiblePixels: number;
  readonly containment: Readonly<{ limit: number; maxSurfaceDistance: number }>;
  readonly adapterFingerprint: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly viewProjection: readonly number[];
  readonly rgba: Uint8Array;
  readonly ballCenters: ReadonlyMap<string, readonly [number, number, number]>;
}

async function materializeBingoLonger(root: string) {
  const compilation = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo-longer"));
  const physicsWorkspaceRoot = join(root, "physics-workspace");
  await mkdir(physicsWorkspaceRoot, { recursive: true, mode: 0o700 });
  await chmod(physicsWorkspaceRoot, 0o700);
  const physicsHost = { outputRoot: join(physicsWorkspaceRoot, "artifact"), workspaceRoot: physicsWorkspaceRoot, workspaceAuthority: await createTrustedWorkspaceAnchor(physicsWorkspaceRoot), requireAbsentOutput: true as const };
  await bakePhysicsToDurableArtifact(compilation.physicsPlan, physicsHost);
  const visual = await compilePhysicsVisualBindingPlan(compilation.physicsPlan, physicsHost, createPhysicsShowcaseVisualBindingRecipe(compilation, compilation.physicsPlan));
  const retained = compilePhysicsVisualRetainedStaticPlan(visual, createPhysicsShowcaseRetainedRenderRecipe(compilation, visual.fingerprint));
  const presentation = compilePhysicsVisualPresentationStaticPlan(retained, compilation.physicsPlan, createPhysicsShowcasePresentationRecipe(compilation, retained.fingerprint, compilation.physicsPlan));
  const packageWorkspaceRoot = join(root, "package-workspace"), sourcePackageRoot = join(packageWorkspaceRoot, "source"), outputPackageRoot = join(packageWorkspaceRoot, "installed");
  await mkdir(join(sourcePackageRoot, "assets", "empty"), { recursive: true, mode: 0o700 });
  await chmod(packageWorkspaceRoot, 0o700); await chmod(sourcePackageRoot, 0o700);
  await writeSourcePackage(sourcePackageRoot);
  const packageHost = { outputPackageRoot, packageWorkspaceRoot, packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(packageWorkspaceRoot) };
  const materializationHost = { sourcePackageRoot, ...packageHost, physicsBakeArtifactRoot: physicsHost.outputRoot, physicsWorkspaceRoot, physicsWorkspaceAuthority: physicsHost.workspaceAuthority, requireAbsentOutput: true as const };
  const recipes = { physicsBake: compilation.physicsPlan.recipe, visualBinding: visual.recipe, retainedRender: retained.recipe, presentation: presentation.recipe };
  const prepared = await preparePhysicsVisualPackageMaterialization(materializationHost, presentation, recipes);
  await materializePhysicsVisualPackage(materializationHost, prepared.approval, { schema: "shellx-motion/private-physics-visual-package-materialization-request@1", expected: prepared.expected });
  return { compilation, visual, retained, presentation, sourcePackageRoot, physicsWorkspaceRoot, packageHost, ballRadius: Math.fround((compilation.scenario.geometry as { ballRadius: number }).ballRadius) };
}

async function writeSourcePackage(root: string): Promise<void> {
  await writeJson(join(root, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "c7b6d-bingo-longer", name: "C7B6D Bingo Longer", motion: "motion.json", assets: [], sourceApp: "private-native-proof", compatibility: { lanes: [], hosts: [] } });
  await writeJson(join(root, "motion.json"), { schema: "shellx-motion/motion@1", id: "c7b6d-bingo-longer-motion", name: "C7B6D Bingo Longer", durationMs: 7_500, fps: 60, width: 640, height: 360, assets: [], provenance: { sourceApp: "private-native-proof", createdBy: "private-native-proof" }, layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs: 7_500, transform: { x: 0, y: 0, width: 640, height: 360 } }] });
}

function boundContainment(frame: { readonly bindings: readonly { readonly modelMatrix: readonly number[] }[] }, center: readonly number[], ballRadius: number, limit: number) {
  const distances = frame.bindings.slice(0, 16).map((binding) => Math.hypot(binding.modelMatrix[12]! - center[0]!, binding.modelMatrix[13]! - center[1]!, binding.modelMatrix[14]! - center[2]!) + ballRadius);
  return { limit, maxSurfaceDistance: Math.max(...distances) };
}

function trackedBallCenters(frame: { readonly bindings: readonly { readonly instanceId: string; readonly modelMatrix: readonly number[] }[] }): ReadonlyMap<string, readonly [number, number, number]> {
  return new Map(frame.bindings.slice(0, 16).map((binding) => [binding.instanceId, [binding.modelMatrix[12]!, binding.modelMatrix[13]!, binding.modelMatrix[14]!] as const]));
}

function bodyMotionPixelWindowsFor(frames: readonly RenderedFrame[]) {
  return ["ball-00", "ball-01"].flatMap((bodyId) => [[0, 2], [2, 3]].map(([from, to]) => {
    const before = frames[from]!, after = frames[to]!, previous = before.ballCenters.get(bodyId)!, current = after.ballCenters.get(bodyId)!;
    const projected = project(current, after.viewProjection, after.viewport);
    return { bodyId, fromFrameIndex: before.frameIndex, toFrameIndex: after.frameIndex, positionDelta: Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]), projected, changedPixelsAtProjectedCenter: windowDifference(before.rgba, after.rgba, after.viewport.width, after.viewport.height, projected.x, projected.y, 20) };
  }));
}

function project(position: readonly [number, number, number], matrix: readonly number[], viewport: { readonly width: number; readonly height: number }) {
  const x = matrix[0]! * position[0]! + matrix[4]! * position[1]! + matrix[8]! * position[2]! + matrix[12]!;
  const y = matrix[1]! * position[0]! + matrix[5]! * position[1]! + matrix[9]! * position[2]! + matrix[13]!;
  const w = matrix[3]! * position[0]! + matrix[7]! * position[1]! + matrix[11]! * position[2]! + matrix[15]!;
  if (!Number.isFinite(w) || w <= 0) throw new Error("tracked Bingo ball is not in front of the C7B4C camera.");
  const normalizedX = x / w, normalizedY = y / w;
  if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) throw new Error("tracked Bingo ball is outside the C7B4C viewport.");
  return { x: Math.round((normalizedX + 1) * 0.5 * (viewport.width - 1)), y: Math.round((1 - normalizedY) * 0.5 * (viewport.height - 1)) };
}

function windowDifference(before: Uint8Array, after: Uint8Array, width: number, height: number, x: number, y: number, radius: number): number {
  let changed = 0;
  for (let row = Math.max(0, y - radius); row <= Math.min(height - 1, y + radius); row += 1) for (let column = Math.max(0, x - radius); column <= Math.min(width - 1, x + radius); column += 1) {
    const index = (row * width + column) * 4;
    if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2] || before[index + 3] !== after[index + 3]) changed += 1;
  }
  return changed;
}

function nonBackground(rgba: Uint8Array, background: readonly [number, number, number]): number { let count = 0; for (let index = 0; index < rgba.length; index += 4) if (rgba[index] !== background[0] || rgba[index + 1] !== background[1] || rgba[index + 2] !== background[2]) count += 1; return count; }
function isF32(value: number): boolean { return Object.is(value, Math.fround(value)); }
async function exists(path: string): Promise<boolean> { return await stat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${canonicalJson(value)}\n`, "utf8"); }
