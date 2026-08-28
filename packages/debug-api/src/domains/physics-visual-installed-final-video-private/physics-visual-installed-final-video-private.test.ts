import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDerivedOutputPublication, canonicalJson, hashFile, PublicationCommitUncertainError, streamingFrameTimestampMs } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "../physics-visual-retained-private/physics-visual-retained.test-support.js";
import { createPhysicsShowcasePresentationRecipe } from "../physics-showcase-scenario-private/unadopted/physics-showcase-scenario-private.js";
import { compilePhysicsVisualPresentationFramePlan, compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { PHYSICS_VISUAL_PRESENTATION_SCHEMA } from "../physics-visual-presentation-private/physics-visual-presentation-types-private.js";
import { materializePhysicsVisualPackage, preparePhysicsVisualPackageMaterialization } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";
import { reopenPhysicsVisualPackageMaterializationOutput } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";
import { reopenPhysicsVisualPackageFinalVideoInput, renderPhysicsVisualInstalledFinalVideo } from "./physics-visual-installed-final-video-private.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe.skipIf(process.platform !== "linux")("private C7B5 installed-output physics final video", () => {
  it("rederives the authoritative full schedule from only deleted-source C7B4D Bingo and wall outputs", async () => {
    for (const kind of ["bingo", "wall"] as const) {
      const value = await fixture(kind);
      await install(value);
      await rm(value.source, { recursive: true, force: true });
      await rm(value.physics.host.outputRoot, { recursive: true, force: true });
      const reopened = await reopenPhysicsVisualPackageFinalVideoInput(outputHost(value));
      expect(reopened.schedule).toMatchObject({ frameRate: 2, renderFrameCount: 10, terminalFrameIndex: 10, displayedFrameCount: 11, durationMs: 5_500 });
      expect(reopened.scheduleSha256).toBe(value.prepared.expected.plans.scheduleSha256);
      await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(value))).resolves.toMatchObject({ plans: value.prepared.expected.plans });
    }
  });

  it("keeps the 60 fps C7B4A terminal sample as displayed frame 301 rather than dropping it", async () => {
    const value = await fixture("bingo", 60);
    await install(value);
    await rm(value.source, { recursive: true, force: true });
    await rm(value.physics.host.outputRoot, { recursive: true, force: true });
    const reopened = await reopenPhysicsVisualPackageFinalVideoInput(outputHost(value));
    expect(reopened.schedule).toMatchObject({ frameRate: 60, renderFrameCount: 300, terminalFrameIndex: 300, displayedFrameCount: 301, durationMs: 301_000 / 60 });
    expect(reopened.scheduleSha256).toBe(value.prepared.expected.plans.scheduleSha256);
    const frames = [0, 1, 299, 300].map((index) => compilePhysicsVisualPresentationFramePlan(reopened.preview.presentationStaticPlan, index));
    expect(frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 299, 300]);
    expect(frames.map((frame) => frame.time)).toEqual([
      { startUs: 0, offsetNumeratorUs: 0, denominator: 60 },
      { startUs: 0, offsetNumeratorUs: 1_000_000, denominator: 60 },
      { startUs: 0, offsetNumeratorUs: 299_000_000, denominator: 60 },
      { startUs: 0, offsetNumeratorUs: 300_000_000, denominator: 60 },
    ]);
    expect(frames.map((frame) => frame.terminal)).toEqual([false, false, false, true]);
    expect([0, 1, 299, 300].map((index) => streamingFrameTimestampMs(index, 60, 301_000 / 60))).toEqual([0, 17, 4_983, 5_000]);
  });

  it("streams each complete installed schedule once through a contained retained session and seals receipt identities", async () => {
    for (const kind of ["bingo", "wall"] as const) {
      const value = await fixture(kind);
      await install(value);
      await rm(value.source, { recursive: true, force: true });
      await rm(value.physics.host.outputRoot, { recursive: true, force: true });
      const fake = fakeFinalLane();
      const result = await renderPhysicsVisualInstalledFinalVideo({ ...outputHost(value), finalOutputPath: join(value.workspace, `${kind}.mp4`), finalReceiptPath: join(value.workspace, `${kind}.receipt.json`), scratchRoot: join(value.workspace, "scratch") }, fake.dependencies);
      expect(fake.opens).toMatchObject([{ scratchRoot: join(value.workspace, "scratch"), maxProcessTreeRssBytes: 64 * 1024 * 1024 }]);
      expect(fake.watched).toEqual([4242]);
      expect(fake.closed).toBe(1);
      expect(fake.rendered).toEqual([...Array(11).keys()]);
      expect(result.receipt).toMatchObject({
        schedule: { sha256: value.prepared.expected.plans.scheduleSha256, displayedFrameCount: 11, terminalDisplay: "one-frame-hold" },
        frames: { frameCount: 11, terminalFrameIndex: 10, timing: { first: { encoderAtMs: 0 }, terminal: { encoderAtMs: 5_000 } } },
        gpu: { adapterFingerprint: "a".repeat(64), retainedMetrics: { preparationOperations: 1, renderedFrames: 11, perFrameGpuAllocations: 0 }, containment: { rootPid: 4242, status: "enforced" }, watchedRoot: { pid: 4242, registered: true } },
        encoder: { preset: "mp4-h264", output: { frameCount: 11 } },
        terminal: { retainedSessionClosed: true, browserProcess: { launcher: "precontained-direct-chromium" }, outputPublication: "verified-stage-then-no-clobber-link" },
      });
      expect(result.receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      await expect(readFile(result.outputPath, "utf8")).resolves.toBe("fake h264\n");
      await expect(readFile(result.receiptPath, "utf8")).resolves.toContain(result.receipt.fingerprint);
    }
  });

  it("refuses an occupied final before reopen, Chromium, or FFmpeg work", async () => {
    const value = await fixture();
    await install(value);
    const fake = fakeFinalLane(), finalOutputPath = join(value.workspace, "occupied.mp4");
    await writeFile(finalOutputPath, "occupied\n", "utf8");
    await expect(renderPhysicsVisualInstalledFinalVideo({ ...outputHost(value), finalOutputPath, finalReceiptPath: join(value.workspace, "occupied.receipt.json"), scratchRoot: join(value.workspace, "scratch") }, fake.dependencies)).rejects.toMatchObject({ code: "derived_output_exists" });
    expect(fake.opens).toEqual([]);
    expect(fake.rendered).toEqual([]);
  });

  it("refuses an occupied receipt before reserving or rendering final media", async () => {
    const value = await fixture();
    await install(value);
    const fake = fakeFinalLane(), finalOutputPath = join(value.workspace, "receipt-occupied.mp4"), finalReceiptPath = join(value.workspace, "receipt-occupied.json");
    await writeFile(finalReceiptPath, "occupied\n", "utf8");
    await expect(renderPhysicsVisualInstalledFinalVideo({ ...outputHost(value), finalOutputPath, finalReceiptPath, scratchRoot: join(value.workspace, "scratch") }, fake.dependencies)).rejects.toMatchObject({ code: "derived_output_exists" });
    expect(fake.opens).toEqual([]);
    expect(fake.rendered).toEqual([]);
    await expect(readFile(finalOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels after a rendered frame, closes the retained child, and leaves no final publication", async () => {
    const value = await fixture();
    await install(value);
    const fake = fakeFinalLane({ failAfterFrames: 1 }), finalOutputPath = join(value.workspace, "cancelled.mp4");
    const finalReceiptPath = join(value.workspace, "cancelled.receipt.json");
    await expect(renderPhysicsVisualInstalledFinalVideo({ ...outputHost(value), finalOutputPath, finalReceiptPath, scratchRoot: join(value.workspace, "scratch") }, fake.dependencies)).rejects.toThrow(/cancelled final encoder/i);
    expect(fake.closed).toBe(1);
    expect(fake.rendered).toEqual([0]);
    await expect(readFile(finalOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(finalReceiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a retained GPU leak as cleanup failure and leaves both paired outputs absent", async () => {
    const value = await fixture();
    await install(value);
    const fake = fakeFinalLane({ remainingGpuBytes: 1 }), finalOutputPath = join(value.workspace, "leaked.mp4"), finalReceiptPath = join(value.workspace, "leaked.receipt.json");
    const error = await renderPhysicsVisualInstalledFinalVideo({ ...outputHost(value), finalOutputPath, finalReceiptPath, scratchRoot: join(value.workspace, "scratch") }, fake.dependencies).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((entry) => entry instanceof Error ? entry.message : String(entry))).toContain("C7B5 retained WebGPU cleanup left GPU bytes allocated.");
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    await expect(readFile(finalOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(finalReceiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the receipt on an uncertain media link, releases private stages, and never retries media publication", async () => {
    const value = await fixture();
    await install(value);
    const fake = fakeFinalLane(), finalOutputPath = join(value.workspace, "uncertain.mp4"), finalReceiptPath = join(value.workspace, "uncertain.receipt.json");
    const publishes: string[] = [], aborts: string[] = [];
    const acquirePublication: typeof acquireDerivedOutputPublication = async (input) => {
      const publication = await acquireDerivedOutputPublication(input), publish = publication.publishFile.bind(publication), abort = publication.abort.bind(publication);
      publication.abort = async () => { aborts.push(input.outputPath); await abort(); };
      if (input.outputPath === finalOutputPath) {
        publication.publishFile = async (evidence, options) => {
          publishes.push(input.outputPath);
          await publish(evidence, options);
          throw new PublicationCommitUncertainError({ publicPath: finalOutputPath, kind: "file", expectedIdentity: { dev: 1, ino: 1 }, expected: evidence }, new Error("injected post-link media observation failure"));
        };
      }
      return publication;
    };
    const error = await renderPhysicsVisualInstalledFinalVideo({ ...outputHost(value), finalOutputPath, finalReceiptPath, scratchRoot: join(value.workspace, "scratch") }, { ...fake.dependencies, acquirePublication }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: finalOutputPath } });
    expect(publishes).toEqual([finalOutputPath]);
    expect(aborts).toContain(finalOutputPath);
    expect(aborts).toContain(finalReceiptPath);
    await expect(readFile(finalReceiptPath, "utf8")).resolves.toContain("private-physics-visual-installed-final-video-receipt@1");
    await expect(readFile(finalOutputPath, "utf8")).resolves.toBe("fake h264\n");
    await rm(finalOutputPath); await rm(finalReceiptPath);
    await withTrustedWorkspaceAnchor(value.host.packageWorkspaceAuthority, async () => {
      const mediaRetry = await acquireDerivedOutputPublication({ outputPath: finalOutputPath, kind: "file" });
      const receiptRetry = await acquireDerivedOutputPublication({ outputPath: finalReceiptPath, kind: "file" });
      await mediaRetry.abort(); await receiptRetry.abort();
    });
  });
});

describe("private C7B5 surface hygiene", () => {
  it("admits only packed host-internal entries and no public physics route", async () => {
    const [publicIndex, packageJson, internal, ffmpegPublic, ...surfaces] = await Promise.all([
      readFile(new URL("../../index.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../internal/physics-visual-installed-final-video.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../renderer-ffmpeg/src/index.ts", import.meta.url), "utf8"),
      ...["../../../../actions/src/catalog.ts", "../../../../cli/src/main.ts", "../../../../connectors/src/index.ts", "../../../../sdk/src/index.ts"].map(async (path) => await readFile(new URL(path, import.meta.url), "utf8")),
    ]);
    expect(publicIndex).not.toMatch(/installed-final-video|physicsVisualInstalledFinalVideo/u);
    expect(internal).toMatch(/renderPhysicsVisualInstalledFinalVideo/u);
    expect(ffmpegPublic).not.toMatch(/physics-visual-installed-final-video/u);
    expect(surfaces.join("\n")).not.toMatch(/installed-final-video|physicsVisualInstalledFinalVideo|motion\.physics/u);
    const manifest = JSON.parse(packageJson) as { exports: Record<string, unknown>; shellxMotion: { hostInternalExports: string[] } };
    expect(manifest.exports).toHaveProperty("./internal/physics-visual-installed-final-video");
    expect(manifest.shellxMotion.hostInternalExports).toContain("./internal/physics-visual-installed-final-video");
  });
});

function fakeFinalLane(options: { failAfterFrames?: number; remainingGpuBytes?: number } = {}) {
  const opens: Array<{ scratchRoot: string; maxProcessTreeRssBytes: number }> = [], rendered: number[] = [], watched: number[] = [];
  let closed = 0;
  const dependencies = {
    openSession: async (_staticUpload: unknown, open: { finalBrowser?: { scratchRoot: string; maxProcessTreeRssBytes: number } }) => {
      if (!open.finalBrowser) throw new Error("missing final browser");
      opens.push(open.finalBrowser);
      return {
        ok: true as const,
        session: {
          browserProcess: { pid: 4242, launcher: "precontained-direct-chromium" as const, containment: { rootPid: 4242, mode: "unix-process-group" as const, status: "enforced" as const, killTree: true as const, memoryLimit: "rss-monitor" as const, maxProcessTreeRssBytes: open.finalBrowser.maxProcessTreeRssBytes } },
          browserVersion: "Chromium test",
          runtimeEvidence: {} as never,
          async render(frame: { evaluationFingerprint: string }) {
            const index = rendered.length; rendered.push(index);
            return { ok: true as const, frame: { rgba: Buffer.alloc(640 * 360 * 4, index), evidence: { adapterFingerprint: "a".repeat(64) } }, metrics: { schema: "shellx-motion/gltf-object-retained-page-metrics@1", staticFingerprint: "b".repeat(64), geometryResourceCount: 2, instanceSlotCount: 2, sharedGeometryReuseCount: 0, vertexBufferBytes: 20, indexBufferBytes: 20, uniformBufferBytes: 512, retainedGpuBytes: 2_000, preparationOperations: 1 as const, renderedFrames: index + 1, perFrameGpuAllocations: 0 as const } } as never;
          },
          async resourceMetrics() { return null; },
          async close() { closed += 1; return { schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: 2, destroyedIndexBuffers: 2, destroyedUniformBuffers: 2, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: 2_000, remainingGpuBytes: options.remainingGpuBytes ?? 0 }; },
        },
      } as never;
    },
    encode: async (input: any) => {
      const signal = new AbortController().signal;
      const job = { admission: "pre-acquired" as const, jobId: "c7b5-test", scratchRoot: input.scratchRoot, maxProcessTreeRssBytes: 64 * 1024 * 1024, signal, watchProcess: (pid: number) => watched.push(pid), reportProcessContainment() {}, reportSandbox() {} };
      const admitted = await input.admittedPreflight({ job, runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
      const frames: unknown[] = [];
      try {
        await admitted.produce({ write: async (frame: unknown) => { frames.push(frame); if (options.failAfterFrames && frames.length >= options.failAfterFrames) throw new Error("cancelled final encoder"); } }, { signal, job, runAdmitted: async (operation: any) => await operation(job), attempt: { source: "software" } });
      } finally { await admitted.release?.(); }
      await writeFile(input.outputPath, "fake h264\n", "utf8");
      const output = { sha256: await hashFile(input.outputPath), durationMs: input.durationMs, observedMedia: { codec: "h264", container: "mov,mp4,m4a,3gp,3g2,mj2" } };
      return { ok: true, command: { executable: "ffmpeg", args: ["-i", input.outputPath], shell: false }, plannedAttempts: [{ source: "software" }], handoff: { attempts: [{ source: "software", outcome: "succeeded" }], quality: { frameCount: frames.length }, backpressure: { writes: frames.length }, resources: { state: "passed", watchedProcessCount: watched.length } }, receiptEvidence: { output } } as never;
    },
  };
  return { dependencies, opens, rendered, watched, get closed() { return closed; } };
}

async function fixture(kind: "bingo" | "wall" = "bingo", frameRate = 2) {
  const physics = await physicsVisualFixture(kind, frameRate), root = await mkdtemp("/dev/shm/shellx-motion-c7b5-");
  roots.push(physics.root, root);
  const workspace = join(root, "packages"), source = join(workspace, "source"), output = join(workspace, "installed");
  await mkdir(join(source, "assets", "empty"), { recursive: true, mode: 0o700 }); await chmod(workspace, 0o700); await chmod(source, 0o700);
  await json(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "c7b5-package", name: "C7B5 package", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } });
  await json(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "c7b5-motion", name: "C7B5 package", durationMs: 1000, fps: 30, width: 640, height: 360, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 640, height: 360 } }] });
  const retained = compilePhysicsVisualRetainedStaticPlan(physics.visualPlan, retainedRecipe(physics.visualPlan.fingerprint, kind));
  const presentation = compilePhysicsVisualPresentationStaticPlan(retained, physics.physicsPlan, kind === "bingo" ? createPhysicsShowcasePresentationRecipe(physics.compilation, retained.fingerprint, physics.physicsPlan) : wallPresentation(retained.fingerprint, physics.physicsPlan.fingerprint));
  const host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(workspace), physicsBakeArtifactRoot: physics.host.outputRoot, physicsWorkspaceRoot: physics.host.workspaceRoot, physicsWorkspaceAuthority: physics.host.workspaceAuthority, requireAbsentOutput: true as const };
  const recipes = { physicsBake: physics.physicsPlan.recipe, visualBinding: physics.visualPlan.recipe, retainedRender: retained.recipe, presentation: presentation.recipe };
  const prepared = await preparePhysicsVisualPackageMaterialization(host, presentation, recipes);
  return { root, physics, workspace, source, output, host, prepared, request: { schema: "shellx-motion/private-physics-visual-package-materialization-request@1", expected: prepared.expected } };
}
async function install(value: Awaited<ReturnType<typeof fixture>>) { await materializePhysicsVisualPackage(value.host, value.prepared.approval, value.request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.host.packageWorkspaceAuthority }; }
function wallPresentation(retainedStaticFingerprint: string, physicsPlanFingerprint: string) { return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-ground-visual", kind: "box", size: [20, 0.2, 8] }, { id: "z-tether-visual", kind: "box", size: [0.08, 1, 0.08] }], materials: [{ id: "z-ground-matte", kind: "basic", baseColor: "#26364a", emissive: 0 }, { id: "z-tether-steel", kind: "basic", baseColor: "#d9e2ec", emissive: 0.04 }] }, staticCollisionBindings: [{ bodyId: "ground", geometryRef: "z-ground-visual", materialRef: "z-ground-matte" }], constraintBindings: [{ constraintId: "tether", geometryRef: "z-tether-visual", materialRef: "z-tether-steel" }], presentationBindings: [] }; }
async function json(path: string, value: unknown): Promise<void> { await writeFile(path, `${canonicalJson(value)}\n`, "utf8"); }
