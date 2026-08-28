import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { reopenPhysicsVisualPackageFinalVideoInput, renderPhysicsVisualInstalledFinalVideo } from "@shellx-motion/debug-api/internal/physics-visual-installed-final-video";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "../physics-visual-retained-private/physics-visual-retained.test-support.js";
import { compilePhysicsVisualPresentationFramePlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { PHYSICS_VISUAL_PRESENTATION_SCHEMA } from "../physics-visual-presentation-private/physics-visual-presentation-types-private.js";
import { materializePhysicsVisualPackage, preparePhysicsVisualPackageMaterialization } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";

const outputRoot = process.env.MOTION_GPU_C7B5_OUTPUT_ROOT?.trim();
const runner = { enabled: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1", platform: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]) };
const describeQualifiedLinuxGpu = runner.enabled && runner.platform === "linux" && runner.arch === "x64" && runner.node === 24 ? describe : describe.skip;

describeQualifiedLinuxGpu("qualified Linux GPU host C7B5 installed physics WebGPU to H.264 proof", () => {
  it("prepares fresh Bingo and wall C7B4D installed packages, deletes their source/provider roots, and reopens output-only", async () => {
    expect(runner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    if (!outputRoot) throw new Error("MOTION_GPU_C7B5_OUTPUT_ROOT is required for durable C7B5 native proof outputs.");
    const root = resolve(outputRoot);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") throw new Error("MOTION_GPU_C7B5_OUTPUT_ROOT must be absent for a fresh no-clobber C7B5 native fixture."); throw error; });
    for (const kind of ["bingo", "wall"] as const) {
      const prepared = await materializedFixture(root, kind);
      await rm(prepared.source, { recursive: true, force: true });
      await rm(prepared.physics.root, { recursive: true, force: true });
      expect(await pathExists(prepared.source)).toBe(false);
      expect(await pathExists(prepared.physics.root)).toBe(false);
      await expect(reopenPhysicsVisualPackageFinalVideoInput(prepared.outputHost)).resolves.toMatchObject({ schedule: { frameRate: 60, displayedFrameCount: 301 } });
    }
  }, 240_000);

  it("renders deleted-source Bingo and wall C7B4D packages through the host-internal workspace entry", async () => {
    if (!outputRoot) throw new Error("MOTION_GPU_C7B5_OUTPUT_ROOT is required for durable C7B5 native proof outputs.");
    const root = resolve(outputRoot);
    const proofs = [];
    for (const kind of ["bingo", "wall"] as const) {
      const packageWorkspaceRoot = join(root, kind), outputPackageRoot = join(packageWorkspaceRoot, "installed");
      if (!inside(root, packageWorkspaceRoot)) throw new Error(`${kind} installed package workspace must be a strict descendant of MOTION_GPU_C7B5_OUTPUT_ROOT.`);
      const packageWorkspaceAuthority = await createTrustedWorkspaceAnchor(packageWorkspaceRoot);
      const host = {
        outputPackageRoot,
        packageWorkspaceRoot,
        packageWorkspaceAuthority,
        finalOutputPath: join(packageWorkspaceRoot, `${kind}.c7b5-final.mp4`),
        finalReceiptPath: join(packageWorkspaceRoot, `${kind}.c7b5-final.receipt.json`),
        scratchRoot: join(packageWorkspaceRoot, "c7b5-scratch"),
        callerId: "linux-gpu-c7b5-native-proof",
        jobId: `linux-gpu-c7b5-${kind}`,
      } as const;
      const reopened = await reopenPhysicsVisualPackageFinalVideoInput(host);
      expect(reopened.schedule).toMatchObject({ frameRate: 60, renderFrameCount: 300, terminalFrameIndex: 300, displayedFrameCount: 301, durationMs: 301_000 / 60 });
      const checkpoints = [0, 1, 299, 300].map((frameIndex) => {
        const frame = compilePhysicsVisualPresentationFramePlan(reopened.preview.presentationStaticPlan, frameIndex);
        return { frameIndex, terminal: frame.terminal, fingerprint: frame.fingerprint, sourceTime: frame.time };
      });
      expect(checkpoints.map((checkpoint) => checkpoint.terminal)).toEqual([false, false, false, true]);
      const result = await renderPhysicsVisualInstalledFinalVideo(host);
      const observed = result.receipt.encoder.output.observedMedia as { codec: string; width: number; height: number; fps: number; durationMs: number; color: { pixelFormat: string | null; space: string | null; transfer: string | null; primaries: string | null; range: string | null } };
      expect(observed).toMatchObject({ codec: "h264", width: 640, height: 360 });
      expect(observed.fps).toBeCloseTo(60, 2);
      expect(observed.durationMs).toBeCloseTo(301_000 / 60, 0);
      expect(observed.color.pixelFormat).toBeTruthy();
      expect(result.receipt).toMatchObject({
        schedule: { displayedFrameCount: 301, terminalFrameIndex: 300, terminalDisplay: "one-frame-hold" },
        frames: { frameCount: 301 },
        gpu: {
          adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          runtime: { backend: "webgpu-browser", adapter: { cdpVendorId: expect.any(Number), cdpDeviceId: expect.any(Number), vendor: expect.any(String), device: expect.any(String) } },
          containment: { status: "enforced" }, cleanup: { remainingGpuBytes: 0 },
        },
        encoder: { preset: "mp4-h264", output: { path: host.finalOutputPath, frameCount: 301 } },
        terminal: { retainedSessionClosed: true, outputPublication: "verified-stage-then-no-clobber-link" },
      });
      const checkpointPath = join(packageWorkspaceRoot, `${kind}.c7b5-checkpoints.json`);
      await writeFile(checkpointPath, `${canonicalJson({ schema: "shellx-motion/private-c7b5-installed-final-video-checkpoints@1", runner, kind, installed: { receiptFingerprint: reopened.installed.receiptFingerprint, scheduleSha256: reopened.scheduleSha256 }, checkpoints, video: { path: result.outputPath, sha256: result.receipt.encoder.output.sha256, observed }, receipt: { path: result.receiptPath, fingerprint: result.receipt.fingerprint } })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      proofs.push({ kind, outputPath: result.outputPath, receiptPath: result.receiptPath, checkpointPath, receiptFingerprint: result.receipt.fingerprint });
    }
    await writeFile(join(root, "c7b5-native-proof.json"), `${canonicalJson({ schema: "shellx-motion/private-c7b5-installed-final-video-native-proof@1", runner, proofs, contactSheetEvidence: "checkpoint-identities-only; no second renderer session" })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }, 480_000);
});

function inside(parent: string, target: string): boolean {
  const value = relative(parent, target);
  return value !== "" && !value.startsWith("../") && value !== "..";
}

async function materializedFixture(root: string, kind: "bingo" | "wall") {
  const physics = await physicsVisualFixture(kind, 60), workspace = join(root, kind), source = join(workspace, "source"), output = join(workspace, "installed");
  await mkdir(join(source, "assets", "empty"), { recursive: true, mode: 0o700 }); await chmod(workspace, 0o700); await chmod(source, 0o700);
  await json(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: `c7b5-${kind}`, name: `C7B5 ${kind}`, motion: "motion.json", assets: [], sourceApp: "native-proof", compatibility: { lanes: [], hosts: [] } });
  await json(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: `c7b5-${kind}-motion`, name: `C7B5 ${kind}`, durationMs: 1000, fps: 30, width: 640, height: 360, assets: [], provenance: { sourceApp: "native-proof", createdBy: "native-proof" }, layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 640, height: 360 } }] });
  const retained = compilePhysicsVisualRetainedStaticPlan(physics.visualPlan, retainedRecipe(physics.visualPlan.fingerprint, kind)), presentation = compilePhysicsVisualPresentationStaticPlan(retained, physics.physicsPlan, presentationRecipe(kind, retained.fingerprint, physics.physicsPlan.fingerprint));
  const host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(workspace), physicsBakeArtifactRoot: physics.host.outputRoot, physicsWorkspaceRoot: physics.host.workspaceRoot, physicsWorkspaceAuthority: physics.host.workspaceAuthority, requireAbsentOutput: true as const };
  const recipes = { physicsBake: physics.physicsPlan.recipe, visualBinding: physics.visualPlan.recipe, retainedRender: retained.recipe, presentation: presentation.recipe }, prepared = await preparePhysicsVisualPackageMaterialization(host, presentation, recipes);
  await materializePhysicsVisualPackage(host, prepared.approval, { schema: "shellx-motion/private-physics-visual-package-materialization-request@1", expected: prepared.expected });
  return { physics, source, outputHost: { outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: host.packageWorkspaceAuthority } };
}

function presentationRecipe(kind: "bingo" | "wall", retainedStaticFingerprint: string, physicsPlanFingerprint: string) {
  if (kind === "bingo") return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-cage-sphere", kind: "sphere", radius: 2.7, quality: "cinematic" }], materials: [{ id: "z-cage-ice", kind: "basic", baseColor: "#8fdcff", emissive: 0.08 }] }, staticCollisionBindings: [], constraintBindings: [], presentationBindings: [{ id: "cage", geometryRef: "z-cage-sphere", materialRef: "z-cage-ice", opacity: 0.18, position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] };
  return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-ground-visual", kind: "box", size: [20, 0.2, 8] }, { id: "z-tether-visual", kind: "box", size: [0.08, 1, 0.08] }], materials: [{ id: "z-ground-matte", kind: "basic", baseColor: "#26364a", emissive: 0 }, { id: "z-tether-steel", kind: "basic", baseColor: "#d9e2ec", emissive: 0.04 }] }, staticCollisionBindings: [{ bodyId: "ground", geometryRef: "z-ground-visual", materialRef: "z-ground-matte" }], constraintBindings: [{ constraintId: "tether", geometryRef: "z-tether-visual", materialRef: "z-tether-steel" }], presentationBindings: [] };
}

async function json(path: string, value: unknown): Promise<void> { await writeFile(path, `${canonicalJson(value)}\n`, "utf8"); }

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
