import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { reopenPhysicsVisualPackageFinalVideoInput, renderPhysicsVisualInstalledFinalVideo } from "@shellx-motion/debug-api/internal/physics-visual-installed-final-video";
import { probeMedia } from "@shellx-motion/renderer-ffmpeg";
import { describe, expect, it } from "vitest";
import { bakePhysicsToDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import { compilePhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { materializePhysicsVisualPackage, preparePhysicsVisualPackageMaterialization } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";
import { compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { compilePhysicsShowcaseScenario, createPhysicsShowcasePresentationRecipe, createPhysicsShowcaseRetainedRenderRecipe, createPhysicsShowcaseScenario, createPhysicsShowcaseVisualBindingRecipe } from "./unadopted/physics-showcase-scenario-private.js";

const outputRoot = process.env.MOTION_GPU_C7B6E_OUTPUT_ROOT?.trim();
const candidateRevision = process.env.MOTION_C7B6E_CANDIDATE_REVISION?.trim();
const runner = Object.freeze({
  enabled: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1",
  platform: process.platform,
  arch: process.arch,
  node: Number(process.versions.node.split(".")[0]),
});
const describeQualifiedLinuxGpu = runner.enabled && runner.platform === "linux" && runner.arch === "x64" && runner.node === 24 ? describe : describe.skip;

const BINGO_LONGER_C7_CHAIN = {
  compilation: "fe71cff3cc34534328f5fcd779a832ee4a7f28e272a2e851f2c406e3ab6c973b",
  physicsPlan: "443333a946b49d4533fe1238a2d809f447ad4134c13a17585106ffe6d6c752d1",
  provider: "383afd854dd21ad10a8f004cb21ff91ce8b06935311f748818828527b0f229e2",
  durableManifest: "009b47f1e90b2470f32d84a6030ffb10b7254103b9c4dec4257e6d3780647a95",
  durableReceipt: "8b485bbf1408ecb7a278ed49ec5f3816cd80753a2c234d0980d5ae616f0b06e6",
  visual: "57c9f23a1f5d183cbdaa923b64ea8df1ba3ceddfd25faab0a9519fa7e14b4815",
  retained: "9a1a170de344dbf5a4b146a954ca3d1e8c851d031970fa94bb451e879254a1ed",
  presentation: "3905249ae6a673bf28057de9389229aae45cea5e9359e75a33843a80d0409369",
  outputReceipt: "cc6ffcfe45e0562d5dfa51af8ca9ddad0632d6283e970fcfe0782db7c9bbd1a4",
  recipeBundle: "8733882908d2eaa01c8a4001a4e3d7660075d7b45c14dca8928dbf25957bbfaa",
} as const;

describeQualifiedLinuxGpu("qualified Linux GPU host C7B6E scenario-driven Bingo-longer final-video proof", () => {
  it("reopens only deleted-source C7B4D output, renders its complete 451-frame schedule once, and ffprobes the published H.264", async () => {
    expect(runner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    if (!outputRoot) throw new Error("MOTION_GPU_C7B6E_OUTPUT_ROOT is required for the private C7B6E native proof.");
    if (!candidateRevision || !/^[a-f0-9]{40}$/u.test(candidateRevision)) throw new Error("MOTION_C7B6E_CANDIDATE_REVISION must be the exact 40-hex source revision under test.");
    const root = resolve(outputRoot);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("MOTION_GPU_C7B6E_OUTPUT_ROOT must be an absent fresh proof root.");
      throw error;
    });

    const prepared = await materializeBingoLonger(root);
    await rm(prepared.sourcePackageRoot, { recursive: true, force: true });
    await rm(prepared.physicsWorkspaceRoot, { recursive: true, force: true });
    expect(await exists(prepared.sourcePackageRoot)).toBe(false);
    expect(await exists(prepared.physicsWorkspaceRoot)).toBe(false);

    const input = await reopenPhysicsVisualPackageFinalVideoInput(prepared.packageHost);
    expect(input.schedule).toEqual({
      startUs: 0,
      endUs: 7_500_000,
      stepsPerSecond: 120,
      stepCount: 900,
      sampleEverySteps: 2,
      frameRate: 60,
      renderFrameCount: 450,
      terminalFrameIndex: 450,
      displayedFrameCount: 451,
      durationMs: 7_516.666666666667,
    });
    expect({
      compilation: prepared.compilation.fingerprint,
      physicsPlan: prepared.compilation.physicsPlan.fingerprint,
      provider: prepared.durable.manifest.source.resultFingerprint,
      durableManifest: prepared.durable.manifest.fingerprint,
      durableReceipt: prepared.durable.receipt.fingerprint,
      visual: prepared.visual.fingerprint,
      retained: prepared.retained.fingerprint,
      presentation: prepared.presentation.fingerprint,
      outputReceipt: input.installed.receiptFingerprint,
      recipeBundle: input.installed.recipeBundleFingerprint,
    }).toEqual(BINGO_LONGER_C7_CHAIN);
    expect(input.installed.plans).toMatchObject({
      physicsPlanFingerprint: BINGO_LONGER_C7_CHAIN.physicsPlan,
      visualBindingFingerprint: BINGO_LONGER_C7_CHAIN.visual,
      retainedStaticFingerprint: BINGO_LONGER_C7_CHAIN.retained,
      presentationStaticFingerprint: BINGO_LONGER_C7_CHAIN.presentation,
    });

    const host = {
      ...prepared.packageHost,
      finalOutputPath: join(prepared.packageWorkspaceRoot, "bingo-longer.c7b6e-final.mp4"),
      finalReceiptPath: join(prepared.packageWorkspaceRoot, "bingo-longer.c7b6e-final.receipt.json"),
      scratchRoot: join(prepared.packageWorkspaceRoot, "c7b6e-scratch"),
      callerId: "linux-gpu-c7b6e-native-proof",
      jobId: "linux-gpu-c7b6e-bingo-longer",
    } as const;
    const result = await renderPhysicsVisualInstalledFinalVideo(host);
    const ffprobe = await probeMedia(result.outputPath, { inputRoots: [prepared.packageWorkspaceRoot] });
    expect(ffprobe).toMatchObject({
      path: result.outputPath,
      codec: "h264",
      width: 640,
      height: 360,
      color: { pixelFormat: "yuv420p", space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" },
    });
    // probeMedia derives delivered cadence from frame count over the container duration, whose
    // FFprobe value is millisecond-quantized. Bound the resulting error to one duration tick.
    expect(Math.abs(ffprobe.fps - 60)).toBeLessThanOrEqual(60 / ffprobe.durationMs);
    expect(ffprobe.durationMs).toBeCloseTo(7_516.666666666667, 0);
    expect(mediaFacts(result.receipt.encoder.output.observedMedia)).toEqual(mediaFacts(ffprobe));
    expect(result.receipt).toMatchObject({
      schedule: { ...input.schedule, sha256: input.scheduleSha256, terminalDisplay: "one-frame-hold" },
      frames: { frameCount: 451, terminalFrameIndex: 450 },
      gpu: {
        adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        containment: { status: "enforced" },
        retainedMetrics: { preparationOperations: 1, renderedFrames: 451, perFrameGpuAllocations: 0 },
        cleanup: { remainingGpuBytes: 0 },
      },
      encoder: { preset: "mp4-h264", output: { path: result.outputPath, frameCount: 451 } },
      terminal: { retainedSessionClosed: true, outputPublication: "verified-stage-then-no-clobber-link" },
    });
    expect(result.receipt.encoder.plannedAttempts).toEqual([expect.objectContaining({ source: "software" })]);
    expect(result.receipt.gpu.cleanup).toEqual({
      schema: "shellx-motion/gltf-object-retained-page-release@1",
      hadResources: true,
      destroyedVertexBuffers: 2,
      destroyedIndexBuffers: 2,
      destroyedUniformBuffers: 17,
      destroyedRenderTargets: 2,
      destroyedReadbackBuffers: 1,
      releasedGpuBytes: 2_848_736,
      remainingGpuBytes: 0,
    });

    await writeFile(join(root, "c7b6e-final-video-proof.json"), `${canonicalJson({
      schema: "shellx-motion/private-c7b6e-bingo-longer-final-video-proof@1",
      runner: { ...runner, candidateRevision },
      scenario: "bingo-longer",
      c7Chain: BINGO_LONGER_C7_CHAIN,
      installed: input.installed,
      schedule: input.schedule,
      finalVideo: {
        outputPath: result.outputPath,
        sha256: result.receipt.encoder.output.sha256,
        byteLength: result.receipt.encoder.output.byteLength,
        receiptPath: result.receiptPath,
        receiptFingerprint: result.receipt.fingerprint,
        ffprobe,
      },
      retained: result.receipt.gpu,
      encoder: {
        preset: result.receipt.encoder.preset,
        plannedAttempts: result.receipt.encoder.plannedAttempts,
        terminal: result.receipt.terminal,
      },
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }, 480_000);
});

async function materializeBingoLonger(root: string) {
  const compilation = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo-longer"));
  const physicsWorkspaceRoot = join(root, "physics-workspace");
  await mkdir(physicsWorkspaceRoot, { recursive: true, mode: 0o700 });
  await chmod(physicsWorkspaceRoot, 0o700);
  const physicsHost = {
    outputRoot: join(physicsWorkspaceRoot, "artifact"),
    workspaceRoot: physicsWorkspaceRoot,
    workspaceAuthority: await createTrustedWorkspaceAnchor(physicsWorkspaceRoot),
    requireAbsentOutput: true as const,
  };
  const durable = await bakePhysicsToDurableArtifact(compilation.physicsPlan, physicsHost);
  const visual = await compilePhysicsVisualBindingPlan(compilation.physicsPlan, physicsHost, createPhysicsShowcaseVisualBindingRecipe(compilation, compilation.physicsPlan));
  const retained = compilePhysicsVisualRetainedStaticPlan(visual, createPhysicsShowcaseRetainedRenderRecipe(compilation, visual.fingerprint));
  const presentation = compilePhysicsVisualPresentationStaticPlan(retained, compilation.physicsPlan, createPhysicsShowcasePresentationRecipe(compilation, retained.fingerprint, compilation.physicsPlan));
  const packageWorkspaceRoot = join(root, "package-workspace");
  const sourcePackageRoot = join(packageWorkspaceRoot, "source");
  const outputPackageRoot = join(packageWorkspaceRoot, "installed");
  await mkdir(join(sourcePackageRoot, "assets", "empty"), { recursive: true, mode: 0o700 });
  await chmod(packageWorkspaceRoot, 0o700);
  await chmod(sourcePackageRoot, 0o700);
  // This is byte-identical C7B6B source-package data so its C7B4D receipt and recipe-bundle
  // identities remain an exact chain pin, not an adjacent fixture with merely similar physics.
  await writePackageSource(sourcePackageRoot);
  const packageHost = {
    outputPackageRoot,
    packageWorkspaceRoot,
    packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(packageWorkspaceRoot),
  };
  const materializationHost = {
    sourcePackageRoot,
    ...packageHost,
    physicsBakeArtifactRoot: physicsHost.outputRoot,
    physicsWorkspaceRoot,
    physicsWorkspaceAuthority: physicsHost.workspaceAuthority,
    requireAbsentOutput: true as const,
  };
  const recipes = {
    physicsBake: compilation.physicsPlan.recipe,
    visualBinding: visual.recipe,
    retainedRender: retained.recipe,
    presentation: presentation.recipe,
  };
  const prepared = await preparePhysicsVisualPackageMaterialization(materializationHost, presentation, recipes);
  await materializePhysicsVisualPackage(materializationHost, prepared.approval, {
    schema: "shellx-motion/private-physics-visual-package-materialization-request@1",
    expected: prepared.expected,
  });
  return { compilation, durable, visual, retained, presentation, sourcePackageRoot, physicsWorkspaceRoot, packageWorkspaceRoot, packageHost };
}

async function writePackageSource(root: string): Promise<void> {
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "c7b6b-bingo-longer",
    name: "C7B6B bingo-longer",
    motion: "motion.json",
    assets: [],
    sourceApp: "private-test",
    compatibility: { lanes: [], hosts: [] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "c7b6b-bingo-longer-motion",
    name: "C7B6B bingo-longer",
    durationMs: 7_500,
    fps: 60,
    width: 640,
    height: 360,
    assets: [],
    provenance: { sourceApp: "private-test", createdBy: "private-test" },
    layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs: 7_500, transform: { x: 0, y: 0, width: 640, height: 360 } }],
  });
  await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
}

function mediaFacts(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("C7B6E requires a concrete FFprobe media observation.");
  const { path: _path, ...facts } = value as Record<string, unknown>;
  return facts;
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, "utf8");
}
