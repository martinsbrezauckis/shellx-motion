import { createHash } from "node:crypto";
import { cp, mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@shellx-motion/core";
import { encodeRgbaPng, loadedPackageInputHashes, loadMotionPackage, type GpuVideoFrameRequest, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { createGpuPreviewSession, createGpuPointsPreviewSession, renderMotionGpuPreview } from "./gpu-points-preview";
import { createGpuFrameRenderSession, DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, type GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import type { GpuPreviewVideoFrameProvider } from "./gpu-preview-video-frame-provider";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/gpu-points-preview", import.meta.url));

describe("GPU preview output and input snapshot", () => {
  it("passes the bounded first-frame default to the strict GPU preview runtime", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-preview-timeout-"));
    const pkg: MotionPackage = {
      root: outDir,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_timeout", name: "GPU timeout", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_timeout", name: "GPU timeout", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] }
    };
    const observedTimeouts: Array<number | undefined> = [];
    const acquirePublication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => {
      const stagingPath = `${outputPath}.staging`;
      return {
        stagingPath,
        async verifyFile() {
          const bytes = await readFile(stagingPath);
          return { sha256: createHash("sha256").update(bytes).digest("hex") };
        },
        async publishFile() {},
        async abort() {}
      } as never;
    });
    const session = createGpuPreviewSession(pkg, {
      openRuntime: async () => {
        const opened = await fakeGpuRuntime();
        if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        return {
          ok: true,
          session: {
            ...opened.session,
            async render(plan, options) {
              observedTimeouts.push(options?.timeoutMs);
              return await render(plan, options);
            }
          }
        };
      }
    });
    try {
      const result = await session.renderFrame({ atMs: 0, outDir, outputPath: join(outDir, "default-timeout.png") });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      expect(observedTimeouts).toEqual([DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS]);
    } finally {
      await session.close();
      acquirePublication.mockRestore();
      await rm(outDir, { recursive: true, force: true });
    }
  });
  it("receipts the loader snapshot after package paths change during a GPU session", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-package-snapshot-"));
    await cp(fixtureRoot, packageRoot, { recursive: true });
    const pkg = await loadMotionPackage(packageRoot);
    const expected = loadedPackageInputHashes(pkg);
    expect(expected).toBeTruthy();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-snapshot-"));
    try {
      // The session must receipt the package object it lowers, not these later pathname bytes.
      await writeFile(join(packageRoot, "manifest.json"), "{\"id\":\"mutated-after-load\"}\n");
      await writeFile(join(packageRoot, pkg.manifest.motion), "{\"id\":\"mutated-after-load\"}\n");
      const session = createGpuPointsPreviewSession(pkg, { openRuntime: fakeGpuRuntime });
      try {
        const result = await session.renderFrame({ atMs: 500, outDir, outputPath: join(outDir, "frame.png") });
        expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
        if (!result.ok || !expected) return;
        expect(result.receipt.inputHashes).toMatchObject({
          "manifest.json": expected["manifest.json"],
          [pkg.manifest.motion]: expected[pkg.manifest.motion],
          "gpu-frame-plan": expect.stringMatching(/^[a-f0-9]{64}$/)
        });
        expect(result.receipt.operation).toBe("preview.gpu.frame");
      } finally {
        await session.close();
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });
  it("does not overwrite a caller-owned GPU output", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-output-"));
    const outputPath = join(outDir, "existing.png");
    await writeFile(outputPath, "caller-owned-output", "utf8");
    const session = createGpuPointsPreviewSession(pkg, { openRuntime: fakeGpuRuntime });
    try {
      const result = await session.renderFrame({ atMs: 0, outDir, outputPath });
      expect(result).toMatchObject({ ok: false, error: { code: "derived_output_exists" } });
      await expect(readFile(outputPath, "utf8")).resolves.toBe("caller-owned-output");
    } finally {
      await session.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });
  it("lowers a general shape/image/text/material scene, uploads exact resources, and receipts every bound hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-general-gpu-preview-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-general-gpu-preview-out-"));
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "hero.png"), encodeRgbaPng(2, 1, Buffer.from([255, 64, 32, 255, 24, 180, 255, 128])), { mode: 0o600 });
    await writeFile(join(root, "assets", "Display.ttf"), Buffer.from([0, 1, 2, 3]), { mode: 0o600 });
    const pkg = generalScenePackage(root);
    let openedImages = 0;
    let openedFonts = 0;
    let renderedPlan: { draws?: Array<{ kind: string; id: string }> } | undefined;
    const openRuntime: typeof createGpuFrameRenderSession = async (images, fonts) => {
      openedImages = images?.length ?? 0;
      openedFonts = fonts?.length ?? 0;
      const opened = await fakeGpuRuntime();
      if (!opened.ok) return opened;
      return {
        ok: true,
        session: {
          ...opened.session,
          async render(plan) {
            renderedPlan = plan as { draws?: Array<{ kind: string; id: string }> };
            return await opened.session.render(plan);
          }
        }
      };
    };
    const session = createGpuPreviewSession(pkg, { openRuntime });
    try {
      const result = await session.renderFrame({ atMs: 250, outDir, outputPath: join(outDir, "general.png") });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(openedImages).toBe(1);
      expect(openedFonts).toBe(1);
      expect(renderedPlan?.draws?.map((draw) => `${draw.kind}:${draw.id}`)).toEqual([
        "rect:plate", "image:hero", "text:title", "material:energy"
      ]);
      expect(result.receipt).toMatchObject({
        operation: "preview.gpu.frame",
        inputHashes: {
          "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
          "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/),
          "assets/hero.png": expect.stringMatching(/^[a-f0-9]{64}$/),
          "assets/Display.ttf": expect.stringMatching(/^[a-f0-9]{64}$/),
          "gpu-frame-plan": expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        output: {
          framePlanFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          resourceInputHashes: {
            "assets/hero.png": expect.stringMatching(/^[a-f0-9]{64}$/),
            "assets/Display.ttf": expect.stringMatching(/^[a-f0-9]{64}$/)
          }
        }
      });
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });
  it("refuses a video package without a host provider before a WebGPU runtime can open", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-video-preview-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    let opened = false;
    const session = createGpuPreviewSession(pkg, { openRuntime: async () => { opened = true; return await fakeGpuRuntime(); } });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(root, "out") })).resolves.toMatchObject({
        ok: false,
        error: { code: "gpu_preview_video_provider_required" }
      });
      expect(opened).toBe(false);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Core request batches for forward/backward/random scrubs without growing a reserved video texture", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-video-exact-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-video-exact-out-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, loop: true }]);
    const requests: GpuVideoFrameRequest[][] = [];
    const replacementIds: string[][] = [];
    const reserved: unknown[] = [];
    const events: string[] = [];
    const provider = exactPreviewProvider(requests, (batch) => events.push(`decode:${batch[0]?.atUs}`));
    const openRuntime: typeof createGpuFrameRenderSession = async (_images, _fonts, options) => {
      reserved.push(...(options?.dynamicImages ?? []));
      const opened = await fakeGpuRuntime(); if (!opened.ok) return opened;
      let closed = false;
      return {
        ok: true,
        session: {
          ...opened.session,
          async replaceDynamicImages(images) { replacementIds.push(images.map((image) => image.id)); events.push("replace"); return { ok: true, replaced: images.length }; },
          async render(plan, renderOptions) { events.push("render"); return await opened.session.render(plan, renderOptions); },
          async resourceMetrics() { return dynamicVideoMetrics(1, replacementIds.length, closed ? 1 : 0); },
          async close() { closed = true; }
        }
      };
    };
    const acquirePublication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
      stagingPath: `${outputPath}.staging`,
      async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
      async publishFile() {}, async abort() {}
    } as never));
    const session = createGpuPreviewSession(pkg, { openRuntime, openVideoProvider: async () => provider });
    try {
      const results = await Promise.all([0, 700, 100, 700].map((atMs) => session.renderFrame({ atMs, outDir, outputPath: join(outDir, `frame-${atMs}.png`) })));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(requests).toHaveLength(4);
      expect(requests[1]?.[0]?.requestFingerprint).toBe(requests[3]?.[0]?.requestFingerprint);
      expect(reserved).toHaveLength(1);
      expect(replacementIds).toEqual([["video-clip"], ["video-clip"], ["video-clip"], ["video-clip"]]);
      expect(events).toEqual(["decode:0", "replace", "render", "decode:700000", "replace", "render", "decode:100000", "replace", "render", "decode:700000", "replace", "render"]);
      const last = results[3]; if (!last?.ok) return;
      const output = last.receipt.output as Record<string, unknown>;
      expect(output.gpuVideoPreview).toMatchObject({ scope: "preview-visual-only", limitations: ["audio-not-rasterized", "final-not-attested"], texture: { dynamicImageTextureSlots: 1, dynamicImageTextureBytes: 16, dynamicImageTextureWrites: 4, dynamicImageTextureReplacements: 4, dynamicImageTextureLateRefusals: 0 } });
      expect(output).not.toHaveProperty("audio");
      expect(output).not.toHaveProperty("final");
    } finally {
      await session.close(); acquirePublication.mockRestore();
      await rm(root, { recursive: true, force: true }); await rm(outDir, { recursive: true, force: true });
    }
  });

  it("does not open a preview provider for a static-plan-hidden video layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-hidden-video-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, visible: false }]);
    let providerOpened = false;
    const publication = mockGpuPreviewPublication();
    const session = createGpuPreviewSession(pkg, { openRuntime: fakeGpuRuntime, openVideoProvider: async () => { providerOpened = true; throw new Error("must not open"); } });
    try {
      await expect(session.renderFrame({ atMs: 500, outDir: join(root, "out") })).resolves.toMatchObject({ ok: true });
      expect(providerOpened).toBe(false);
    } finally {
      await session.close();
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps probe evidence and pre-reserved slots at inactive nonzero time without asking the provider for an empty batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-zero-active-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 100 }]);
    const requests: GpuVideoFrameRequest[][] = [];
    const provider = exactPreviewProvider(requests);
    const framesFor = vi.fn(provider.framesFor.bind(provider));
    provider.framesFor = framesFor;
    const publication = mockGpuPreviewPublication();
    const session = createGpuPreviewSession(pkg, {
      openVideoProvider: async () => provider,
      openRuntime: async (_images, _fonts, options) => await fakeDynamicVideoGpuRuntime(options?.dynamicImages ?? [])
    });
    try {
      const result = await session.renderFrame({ atMs: 500, outDir: join(root, "out") });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      expect(framesFor).not.toHaveBeenCalled();
      if (!result.ok) return;
      expect(result.receipt.output).toMatchObject({ gpuVideoPreview: { atUs: 500_000, sources: [{ layerId: "clip" }], frames: [], texture: { dynamicImageTextureSlots: 1, dynamicImageTextureWrites: 0, dynamicImageTextureReplacements: 0 } } });
    } finally {
      await session.close();
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses forged extra or mismatched provider slots before runtime allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-forged-video-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    const kinds = ["extra", "mismatched", "source-count"] as const;
    try {
      for (const kind of kinds) {
        const provider = exactPreviewProvider([]);
        const probe = await provider.probe(new AbortController().signal);
        if (kind === "source-count") (provider.evidence as { sourceCount: number }).sourceCount = 2;
        provider.probe = async () => kind === "extra"
          ? { snapshots: new Map([...probe.snapshots, ["forged", { ...probe.snapshots.get("clip")!, assetRef: "assets/forged.mp4" }]]), slots: [...probe.slots, { ...probe.slots[0]!, layerId: "forged", assetRef: "assets/forged.mp4", resourceId: "video-forged" }] }
          : kind === "mismatched" ? { snapshots: probe.snapshots, slots: [{ ...probe.slots[0]!, assetRef: "assets/forged.mp4" }] }
          : probe;
        let opened = false;
        const session = createGpuPreviewSession(pkg, { openVideoProvider: async () => provider, openRuntime: async () => { opened = true; return await fakeGpuRuntime(); } });
        try {
          await expect(session.renderFrame({ atMs: 0, outDir: join(root, kind) })).resolves.toMatchObject({ ok: false, error: { code: "gpu_preview_video_provider_refused" } });
          expect(opened).toBe(false);
        } finally { await session.close(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a frame whose resource binding no longer matches Core before runtime allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-wrong-binding-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    const provider = exactPreviewProvider([]);
    const framesFor = provider.framesFor.bind(provider);
    const closeProvider = provider.close.bind(provider);
    let closeCalls = 0;
    provider.close = async () => { closeCalls += 1; return await closeProvider(); };
    provider.framesFor = async (requests, signal) => {
      const batch = await framesFor(requests, signal);
      return { ...batch, frames: batch.frames.map((frame) => ({ ...frame, resource: { ...frame.resource, resourceId: "forged-resource" } })) };
    };
    let opened = false;
    const session = createGpuPreviewSession(pkg, { openVideoProvider: async () => provider, openRuntime: async () => { opened = true; return await fakeGpuRuntime(); } });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(root, "out") })).resolves.toMatchObject({ ok: false, error: { code: "gpu_preview_video_provider_refused" } });
      await vi.waitFor(() => expect(closeCalls).toBe(1));
      await expect(session.close()).resolves.toMatchObject({ closed: true, provider: { releasedFrames: 1 } });
      expect(opened).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("aborts a delayed provider frame operation, reaps it, and closes the provider without a receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-delayed-video-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    const provider = exactPreviewProvider([]);
    let entered: (() => void) | undefined;
    let providerClosed = 0;
    provider.framesFor = async (_requests, signal) => await new Promise((_, reject) => {
      entered = () => undefined;
      signal.addEventListener("abort", () => reject(new Error("provider cancelled")), { once: true });
    });
    provider.close = async () => { providerClosed += 1; return { closed: true, releasedFrames: 0, releasedSources: 1, privateScratchReleased: true }; };
    let runtimeOpened = false;
    const session = createGpuPreviewSession(pkg, { openVideoProvider: async () => provider, openRuntime: async () => { runtimeOpened = true; return await fakeGpuRuntime(); } });
    try {
      const pending = session.renderFrame({ atMs: 0, outDir: join(root, "out") });
      await vi.waitFor(() => expect(entered).toBeTypeOf("function"));
      const cleanup = await session.close();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("gpu_cancelled");
      expect(result).not.toHaveProperty("receipt");
      expect(cleanup).toMatchObject({ closed: true, provider: { closed: true } });
      expect(providerClosed).toBe(1);
      expect(runtimeOpened).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("completes host decode before acquiring a one-slot GPU governor", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-single-slot-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    const events: string[] = [];
    const governor = new core.LocalMotionJobGovernor({ maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 1_000, maxWallClockMs: 1_000, minFreeScratchBytes: 1, scratchReservationBytes: 1, maxProcessTreeRssBytes: 64 * 1024 * 1024, rssPollIntervalMs: 25 }, { freeScratchBytes: async () => 1_000_000, prepareScratchRoot: async (scratchRoot) => scratchRoot, leases: null });
    const provider = exactPreviewProvider([]);
    const framesFor = provider.framesFor.bind(provider);
    provider.framesFor = async (requests, signal) => (await governor.run({ lane: "ffmpeg", operation: "gpu.preview.decode", scratchRoot: root, signal }, async () => {
      events.push("decode"); return await framesFor(requests, signal);
    })).value;
    const publication = mockGpuPreviewPublication();
    const session = createGpuPreviewSession(pkg, {
      governor,
      openVideoProvider: async () => provider,
      openRuntime: async (_images, _fonts, options) => { events.push("gpu"); return await fakeDynamicVideoGpuRuntime(options?.dynamicImages ?? []); }
    });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(root, "out") })).resolves.toMatchObject({ ok: true });
      expect(events).toEqual(["decode", "gpu"]);
    } finally { await session.close(); publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("surfaces provider teardown failure and never retries cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-provider-close-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    const provider = exactPreviewProvider([]);
    let closeCalls = 0;
    provider.close = async () => { closeCalls += 1; throw new Error("provider close failed"); };
    const publication = mockGpuPreviewPublication();
    const session = createGpuPreviewSession(pkg, { openVideoProvider: async () => provider, openRuntime: async (_images, _fonts, options) => await fakeDynamicVideoGpuRuntime(options?.dynamicImages ?? []) });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(root, "out") })).resolves.toMatchObject({ ok: true });
      await expect(session.close()).rejects.toThrow("provider close failed");
      await expect(session.close()).rejects.toThrow("provider close failed");
      expect(closeCalls).toBe(1);
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("one-shot video receipts attach closed cleanup without audio or final claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-one-shot-video-"));
    const pkg = generalScenePackage(root, [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 }]);
    const publication = mockGpuPreviewPublication();
    try {
      const result = await renderMotionGpuPreview(pkg, { atMs: 0, outDir: join(root, "out"), sessionOptions: { openVideoProvider: async () => exactPreviewProvider([]), openRuntime: async (_images, _fonts, options) => await fakeDynamicVideoGpuRuntime(options?.dynamicImages ?? []) } });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(result.receipt.output).toMatchObject({ gpuVideoPreview: { scope: "preview-visual-only" }, sessionCleanup: { closed: true, provider: { releasedSources: 1, privateScratchReleased: true }, runtimeResources: { dynamicImageTextureDestructions: 1 } } });
      expect(result.receipt.output).not.toHaveProperty("audio");
      expect(result.receipt.output).not.toHaveProperty("final");
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("refuses changing retained compute capacity before resources or runtime open", async () => {
    const root = "/not-opened/gpu-compute-preview";
    const first = computeParticleLayer("first", 0, 100_000);
    const pkg = generalScenePackage(root, [first, computeParticleLayer("second", 1_000, 131_072)]);
    pkg.motion.durationMs = 2_000;
    let opened = false;
    const session = createGpuPreviewSession(pkg, { openRuntime: async () => { opened = true; return await fakeGpuRuntime(); } });
    try {
      await expect(session.renderFrame({ atMs: 1_500, outDir: "/not-opened/output" })).resolves.toMatchObject({
        ok: false,
        error: { code: "gpu_resource_refused", message: expect.stringContaining("one retained particle capacity") }
      });
      expect(opened).toBe(false);
    } finally {
      await session.close();
    }
  });
});

function computeParticleLayer(id: string, startMs: number, count: number): MotionPackage["motion"]["layers"][number] {
  return {
    id, type: "particles", startMs, durationMs: 1_000, transform: { width: 48, height: 32 },
    emitter: { seed: 7, count, lifetimeMs: 1_000, shape: "circle", color: "#ff8040", field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.3, softening: 0.2 }] } }
  };
}

function generalScenePackage(root: string, layers?: MotionPackage["motion"]["layers"]): MotionPackage {
  return {
    root,
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_general_gpu_preview",
      name: "General GPU preview",
      motion: "motion.json",
      assets: ["assets/hero.png", "assets/Display.ttf"],
      sourceApp: "test",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_general_gpu_preview",
      name: "General GPU preview",
      durationMs: 1_000,
      fps: 30,
      width: 48,
      height: 32,
      background: "#08111f",
      assets: [{ id: "font-display", type: "font", family: "Display", source: { path: "assets/Display.ttf", mimeType: "font/ttf" }, weight: 500 }],
      provenance: { sourceApp: "test", createdBy: "test" },
      layers: layers ?? [
        { id: "plate", type: "shape", shape: "rect", fill: "#19345e", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 48, height: 32 } },
        { id: "hero", type: "image", assetRef: "assets/hero.png", startMs: 0, durationMs: 1_000, transform: { x: 2, y: 3, width: 12, height: 8 }, fit: "fill" },
        { id: "title", type: "text", text: "GPU", startMs: 0, durationMs: 1_000, style: { fontFamily: "Display", fontSize: 10, fontWeight: 500, color: "#ffffff", width: 22, height: 12 } },
        {
          id: "energy",
          type: "shader",
          startMs: 0,
          durationMs: 1_000,
          transform: { x: 26, y: 4, width: 18, height: 18 },
          shader: {
            schema: "shellx-motion/shader-plugin@1",
            language: "glsl-es-100-expression",
            fragmentAssetId: "legacy-shader-is-not-executed",
            seed: 7,
            fallbackColor: "#000000",
            uniforms: { u_speed: 1, u_glow: 1 },
            gpuMaterial: { preset: "energy", colors: ["#ff4060", "#5ad4ff", "transparent"] }
          }
        }
      ]
    }
  };
}

async function fakeGpuRuntime(): Promise<GpuFrameRenderSessionOpenResult> {
  return {
    ok: true,
    session: {
      browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null },
      async uploadImages(images) { return { ok: true, uploaded: images.length }; },
      async replaceDynamicImages(images) { return { ok: true, replaced: images.length }; },
      async render(plan) {
        const frame = plan as { width: number; height: number };
        const rgba = Buffer.alloc(frame.width * frame.height * 4);
        for (let index = 0; index < rgba.length; index += 4) {
          rgba[index] = 48;
          rgba[index + 1] = 160;
          rgba[index + 2] = 224;
          rgba[index + 3] = 255;
        }
        return {
          ok: true,
          frame: {
            rgba,
            sha256: createHash("sha256").update(rgba).digest("hex"),
            width: frame.width,
            height: frame.height,
            evidence: fakeGpuEvidence()
          }
        };
      },
      async close() {}
    }
  };
}

function exactPreviewProvider(requests: GpuVideoFrameRequest[][], onFrames?: (requests: readonly GpuVideoFrameRequest[]) => void): GpuPreviewVideoFrameProvider {
  const sourceSnapshotSha256 = "a".repeat(64), decodeContractSha256 = "b".repeat(64);
  const evidence = {
    schema: "shellx-motion/gpu-preview-video-frame-provider@1" as const, surface: "preview-visual-only" as const, sourceCount: 1, decodedFrameCount: 0,
    cache: { hits: 0, misses: 0, evictions: 0, deduplicated: 0, entries: 0, bytes: 0, highWaterEntries: 0, highWaterBytes: 0, capacityEntries: 32, capacityBytes: 128 * 1024 * 1024, inFlightBytes: 0, inFlightHighWaterBytes: 0 }
  };
  return {
    inputHashes: { "assets/clip.mp4": sourceSnapshotSha256 },
    evidence,
    async probe() {
      return {
        snapshots: new Map([["clip", { assetRef: "assets/clip.mp4", sourceSnapshotSha256, durationUs: 1_000_000, width: 2, height: 2, decodeContractSha256 }]]),
        slots: [{ layerId: "clip", assetRef: "assets/clip.mp4", resourceId: "video-clip", width: 2, height: 2, sourceSnapshotSha256, decodeContractSha256 }]
      };
    },
    async framesFor(batch) {
      requests.push([...batch]);
      onFrames?.(batch);
      evidence.decodedFrameCount += batch.length;
      evidence.cache.misses += batch.length;
      evidence.cache.entries = 1;
      evidence.cache.bytes = 16;
      evidence.cache.highWaterEntries = 1;
      evidence.cache.highWaterBytes = 16;
      const frames = batch.map((request) => {
        const rgba = Buffer.from([request.sourceAtUs & 0xff, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
        const decodedRgbaSha256 = createHash("sha256").update(rgba).digest("hex");
        return {
          request,
          resource: { layerId: request.layerId, assetRef: request.assetRef, resourceId: "video-clip", width: 2, height: 2, sha256: decodedRgbaSha256, sourceAtUs: request.sourceAtUs, sourceAtMs: request.sourceAtMs, sourceSnapshotSha256, decodedRgbaSha256, decodeContractSha256, requestFingerprint: request.requestFingerprint },
          selection: { policy: "cfr-floor-request-sourceAtUs-to-stream-pts" as const, decodedPts: String(Math.floor(request.sourceAtUs / 1_000)), timeBase: "1/1000", frameDurationPts: "1", decodedPtsUs: String(Math.floor(request.sourceAtUs / 1_000) * 1_000) },
          upload: { id: "video-clip", width: 2, height: 2, rgba, sha256: sourceSnapshotSha256, decodedSha256: decodedRgbaSha256 }
        };
      });
      return { atUs: batch[0]?.atUs ?? 0, frames };
    },
    async close() { return { closed: true, releasedFrames: evidence.cache.entries, releasedSources: 1, privateScratchReleased: true }; }
  };
}

function dynamicVideoMetrics(slots: number, writes: number, destructions: number, bytes: number = slots * 16) {
  return {
    schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 0,
    dynamicImageTextureSlots: slots, dynamicImageTextureBytes: bytes,
    dynamicImageTextureHighWaterSlots: slots, dynamicImageTextureHighWaterBytes: bytes,
    dynamicImageTextureWrites: writes, dynamicImageTextureReplacements: writes,
    dynamicImageTextureLateRefusals: 0, dynamicImageTextureDestructions: destructions
  } as never;
}

function mockGpuPreviewPublication() {
  return vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
    stagingPath: `${outputPath}.staging`,
    async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
    async publishFile() {}, async abort() {}
  } as never));
}

async function fakeDynamicVideoGpuRuntime(slots: readonly { width: number; height: number }[]): Promise<GpuFrameRenderSessionOpenResult> {
  const opened = await fakeGpuRuntime();
  if (!opened.ok) return opened;
  let writes = 0;
  let closed = false;
  const bytes = slots.reduce((total, slot) => total + slot.width * slot.height * 4, 0);
  return {
    ok: true,
    session: {
      ...opened.session,
      async replaceDynamicImages(images) { writes += images.length; return { ok: true, replaced: images.length }; },
      async resourceMetrics() { return dynamicVideoMetrics(slots.length, writes, closed ? slots.length : 0, bytes); },
      async close() { closed = true; }
    }
  };
}

function fakeGpuEvidence(): GpuRuntimeEvidence {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1",
    backend: "webgpu-browser",
    browserSource: "test",
    webgpuFeatureStatus: "enabled",
    adapterFingerprint: "0".repeat(64),
    adapter: {
      cdpVendorId: 1,
      cdpDeviceId: 2,
      cdpVendor: "test",
      cdpDevice: "test",
      vendor: "test",
      device: "test",
      architecture: null,
      description: null
    },
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }
  };
}
