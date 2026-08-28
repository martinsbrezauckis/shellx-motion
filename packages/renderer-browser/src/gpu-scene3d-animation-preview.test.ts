import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@shellx-motion/core";
import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { createGpuPointsPreviewSession, createGpuPreviewSession, renderMotionGpuPointsPreview, renderMotionGpuPreview } from "./gpu-points-preview";
import { verifyGpuScene3dAnimationPreviewReceiptEvidence } from "./gpu-preview-output";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

describe("O6 Browser GPU scene3d animation preview", () => {
  it("renders through the Core wrapper and receipts exact limits plus terminal cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-preview-"));
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
      stagingPath: `${outputPath}.staging`,
      async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
      async publishFile() {},
      async abort() {},
    } as never));
    let closed = 0;
    let rendered: unknown;
    try {
      const result = await renderMotionGpuPreview(scenePackage(root), {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: {
          openRuntime: async () => fakeRuntime((plan) => { rendered = plan; }, () => { closed += 1; }),
        },
      });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(rendered).toMatchObject({ draws: [expect.objectContaining({ kind: "scene3d", id: "world", intensity: 1.5 })] });
      expect(result.receipt).toMatchObject({
        operation: "preview.gpu.frame",
        output: {
          gpuScene3dAnimation: {
            schema: "shellx-motion/gpu-scene3d-animation-preview-receipt@1",
            atUs: 500_000,
            targetLayerIds: ["world"],
            limits: { target: "preview", output: "png-frame", maxSceneLayers: 4, maxSceneObjects: 32, maxTracks: 64, maxKeyframes: 2048, maxFrameWorkUnits: 256 },
          },
          sessionCleanup: { closed: true, runtimeResources: null, provider: null },
        },
      });
      expect(result.receipt.output).not.toHaveProperty("audio");
      expect(result.receipt.output).not.toHaveProperty("final");
      expect(result.receipt.inputHashes).toMatchObject({
        "gpu-scene3d-animation-static-plan": expect.stringMatching(/^[a-f0-9]{64}$/),
        "gpu-scene3d-animation-source": expect.stringMatching(/^[a-f0-9]{64}$/),
        "gpu-scene3d-animation-frame-plan": expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const sceneEvidence = (result.receipt.output as { gpuScene3dAnimation: unknown }).gpuScene3dAnimation;
      expect(verifyGpuScene3dAnimationPreviewReceiptEvidence(sceneEvidence)).toEqual(sceneEvidence);
      expect(closed).toBe(1);
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds cancellation before resource preparation, runtime open, output, or receipt publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-cancel-"));
    const controller = new AbortController();
    controller.abort();
    let resources = 0, opened = 0;
    try {
      await expect(renderMotionGpuPreview(scenePackage(root), {
        atMs: 500, outDir: join(root, "out"), signal: controller.signal,
        sessionOptions: {
          async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        },
      })).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect({ resources, opened }).toEqual({ resources: 0, opened: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses O6 from the public reusable-session factory before resources, runtime, or output work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-reusable-refusal-"));
    let resources = 0, opened = 0;
    try {
      for (const createSession of [createGpuPreviewSession, createGpuPointsPreviewSession]) {
        const session = createSession(scenePackage(root), {
          async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        });
        await expect(session.renderFrame({ atMs: 500, outDir: join(root, "out") })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: expect.stringContaining("direct @shellx-motion/renderer-browser renderMotionGpuPreview API") } });
        await expect(session.close()).resolves.toEqual({ closed: true, runtimeResources: null, provider: null });
      }
      expect({ resources, opened }).toEqual({ resources: 0, opened: 0 });
      await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the historical points one-shot alias outside the O6 authority before any observable work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-points-alias-refusal-"));
    const pkg = scenePackage(root);
    let descriptorReads = 0, manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
    const manifest = pkg.manifest, packageRoot = pkg.root;
    Object.defineProperty(pkg.motion, "scene3dAnimation", {
      configurable: true,
      enumerable: true,
      get() { descriptorReads += 1; return { schema: "shellx-motion/scene3d-animation@1", tracks: [] }; },
    });
    Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } });
    Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
    try {
      await expect(renderMotionGpuPointsPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: {
          async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        },
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "gpu_unsupported_feature",
          message: expect.stringContaining("historical renderMotionGpuPointsPreview compatibility alias"),
        },
      });
      expect({ descriptorReads, manifestReads, rootReads, resources, opened }).toEqual({ descriptorReads: 0, manifestReads: 0, rootReads: 0, resources: 0, opened: 0 });
      await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an accessor package motion field through the points alias before O6 detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-points-alias-motion-accessor-"));
    const pkg = scenePackage(root);
    const motion = pkg.motion;
    let motionReads = 0, resources = 0, opened = 0;
    Object.defineProperty(pkg, "motion", {
      configurable: true,
      enumerable: true,
      get() { motionReads += 1; return motion; },
    });
    try {
      await expect(renderMotionGpuPointsPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: {
          async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        },
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "gpu_unsupported_feature",
          message: expect.stringContaining("historical renderMotionGpuPointsPreview compatibility alias"),
        },
      });
      expect({ motionReads, resources, opened }).toEqual({ motionReads: 0, resources: 0, opened: 0 });
      await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ordinary non-O6 points alias output and plan parity with the direct entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-points-alias-parity-"));
    const pkg = scenePackage(root);
    delete pkg.motion.scene3dAnimation;
    let directPlan: unknown, aliasPlan: unknown;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
      stagingPath: `${outputPath}.staging`,
      async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
      async publishFile() {},
      async abort() {},
    } as never));
    try {
      const direct = await renderMotionGpuPreview(pkg, {
        atMs: 500,
        outDir: join(root, "direct"),
        sessionOptions: { openRuntime: async () => fakeRuntime((plan) => { directPlan = plan; }) },
      });
      const alias = await renderMotionGpuPointsPreview(pkg, {
        atMs: 500,
        outDir: join(root, "alias"),
        sessionOptions: { openRuntime: async () => fakeRuntime((plan) => { aliasPlan = plan; }) },
      });
      expect(direct.ok, direct.ok ? undefined : direct.error.message).toBe(true);
      expect(alias.ok, alias.ok ? undefined : alias.error.message).toBe(true);
      if (!direct.ok || !alias.ok) return;
      expect(aliasPlan).toEqual(directPlan);
      expect(alias.frame).toMatchObject({ width: direct.frame.width, height: direct.frame.height, atMs: direct.frame.atMs });
      expect(alias.receipt.operation).toBe(direct.receipt.operation);
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses non-empty O6 package manifest assets before hashing, resources, runtime, or output work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-manifest-assets-refusal-"));
    const pkg = scenePackage(root);
    pkg.manifest.assets.push("unexpected.png");
    let rootReads = 0, resources = 0, opened = 0;
    const packageRoot = pkg.root;
    Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
    try {
      await expect(renderMotionGpuPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: {
          async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        },
      })).resolves.toMatchObject({
        ok: false,
        error: { code: "gpu_unsupported_feature", message: expect.stringContaining("empty package manifest.assets array") },
      });
      expect({ rootReads, resources, opened }).toEqual({ rootReads: 0, resources: 0, opened: 0 });
      await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats hostile O6 manifest and manifest-assets accessors as asset-bearing without evaluating either", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-hostile-manifest-assets-"));
    try {
      for (const kind of ["manifest", "assets"] as const) {
        const pkg = scenePackage(root);
        let manifestReads = 0, assetReads = 0, rootReads = 0, resources = 0, opened = 0;
        const manifest = pkg.manifest, packageRoot = pkg.root;
        if (kind === "manifest") {
          Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } });
        } else {
          Object.defineProperty(manifest, "assets", { configurable: true, enumerable: true, get() { assetReads += 1; return []; } });
        }
        Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
        await expect(renderMotionGpuPreview(pkg, {
          atMs: 500,
          outDir: join(root, `out-${kind}`),
          sessionOptions: {
            async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
            async openRuntime() { opened += 1; return await fakeRuntime(); },
          },
        })).resolves.toMatchObject({
          ok: false,
          error: { code: "gpu_unsupported_feature", message: expect.stringContaining("empty package manifest.assets array") },
        });
        expect({ manifestReads, assetReads, rootReads, resources, opened }).toEqual({ manifestReads: 0, assetReads: 0, rootReads: 0, resources: 0, opened: 0 });
        await expect(stat(join(root, `out-${kind}`))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses hostile O6 PBR marker paths without evaluating manifest.data, adapter, or marker accessors", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-hostile-pbr-marker-"));
    try {
      for (const kind of ["data", "adapter", "marker"] as const) {
        const pkg = scenePackage(root);
        const manifest = pkg.manifest, packageRoot = pkg.root;
        let dataReads = 0, adapterReads = 0, markerReads = 0, rootReads = 0, resources = 0, opened = 0;
        if (kind === "data") {
          Object.defineProperty(manifest, "data", { configurable: true, enumerable: true, get() { dataReads += 1; return { adapter: {} }; } });
        } else {
          const data: Record<string, unknown> = {};
          Object.defineProperty(manifest, "data", { configurable: true, enumerable: true, value: data });
          if (kind === "adapter") {
            Object.defineProperty(data, "adapter", { configurable: true, enumerable: true, get() { adapterReads += 1; return {}; } });
          } else {
            const adapter: Record<string, unknown> = {};
            Object.defineProperty(data, "adapter", { configurable: true, enumerable: true, value: adapter });
            Object.defineProperty(adapter, "scene3dGltfPbrFinal", { configurable: true, enumerable: true, get() { markerReads += 1; return { schema: "untrusted", sceneLayerId: "world" }; } });
          }
        }
        Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
        await expect(renderMotionGpuPreview(pkg, {
          atMs: 500,
          outDir: join(root, `out-${kind}`),
          sessionOptions: {
            async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
            async openRuntime() { opened += 1; return await fakeRuntime(); },
          },
        })).resolves.toMatchObject(kind === "marker" ? {
          ok: false,
          error: { code: "gltf_pbr_final_direct_final_only" },
        } : {
          ok: false,
          error: { code: "gpu_unsupported_feature", message: expect.stringContaining("descriptor-safe package manifest.data") },
        });
        expect({ dataReads, adapterReads, markerReads, rootReads, resources, opened }).toEqual({ dataReads: 0, adapterReads: 0, markerReads: 0, rootReads: 0, resources: 0, opened: 0 });
        await expect(stat(join(root, `out-${kind}`))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses O6 procedural and compositing root authority before document assets, layers, package work, or output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-root-authority-refusal-"));
    try {
      for (const authority of ["relationships", "compositing"] as const) {
        const pkg = scenePackage(root);
        let authorityReads = 0, assetsReads = 0, layersReads = 0, manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
        const motionAssets = pkg.motion.assets, motionLayers = pkg.motion.layers, manifest = pkg.manifest, packageRoot = pkg.root;
        Object.defineProperty(pkg.motion, authority, { configurable: true, enumerable: true, get() { authorityReads += 1; throw new Error(`${authority} must remain unread`); } });
        Object.defineProperty(pkg.motion, "assets", { configurable: true, enumerable: true, get() { assetsReads += 1; return motionAssets; } });
        Object.defineProperty(pkg.motion, "layers", { configurable: true, enumerable: true, get() { layersReads += 1; return motionLayers; } });
        Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } });
        Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
        await expect(renderMotionGpuPreview(pkg, {
          atMs: 500,
          outDir: join(root, `out-${authority}`),
          sessionOptions: {
            async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); },
            async openRuntime() { opened += 1; return await fakeRuntime(); },
          },
        })).resolves.toMatchObject({
          ok: false,
          error: { code: "gpu_unsupported_feature", message: expect.stringContaining(`document ${authority} authority`) },
        });
        expect({ authorityReads, assetsReads, layersReads, manifestReads, rootReads, resources, opened }).toEqual({ authorityReads: 0, assetsReads: 0, layersReads: 0, manifestReads: 0, rootReads: 0, resources: 0, opened: 0 });
        await expect(stat(join(root, `out-${authority}`))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses cancellation delivered by the completed draw before it can stage or publish output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-post-render-cancel-"));
    const controller = new AbortController();
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    let closed = 0;
    try {
      const result = await renderMotionGpuPreview(scenePackage(root), {
        atMs: 500,
        outDir: join(root, "out"),
        signal: controller.signal,
        sessionOptions: {
          openRuntime: async () => fakeRuntime(() => { controller.abort(); }, () => { closed += 1; }),
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect(publication).not.toHaveBeenCalled();
      expect(closed).toBe(1);
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a package mutation during draw before output publication or receipt construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-stale-draw-"));
    const pkg = scenePackage(root);
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    let closed = 0;
    try {
      const result = await renderMotionGpuPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: {
          openRuntime: async () => fakeRuntime(() => { pkg.manifest.name = "mutated during draw"; }, () => { closed += 1; }),
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("snapshot is stale") } });
      expect(publication).not.toHaveBeenCalled();
      expect(closed).toBe(1);
      await expect(stat(join(root, "out", "pkg_o6_scene-gpu-500.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a manifest mutation between static wrapper resolution and loaded-input hashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-stale-prehash-"));
    const pkg = scenePackage(root);
    let resources = 0, opened = 0;
    try {
      // The strict Core wrapper and manifest identity capture run synchronously before its
      // awaited resolver continuation. A queued mutation must make input hashing refuse.
      const pending = renderMotionGpuPreview(pkg, {
        atMs: 500, outDir: join(root, "out"),
        sessionOptions: {
          async prepareResourcesForTest() { resources += 1; throw new Error("resources must remain unopened"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        },
      });
      queueMicrotask(() => { pkg.manifest.name = "mutated after static wrapper"; });
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "gpu_input_hash_refused", message: expect.stringContaining("manifest identity changed before loaded-input hashing") }
      });
      expect({ resources, opened }).toEqual({ resources: 0, opened: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts verified staging when the package changes before the irreversible publish commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-stale-staging-"));
    const stagingPath = join(root, "frame.staging");
    const outputPath = join(root, "out", "frame.png");
    const pkg = scenePackage(root);
    let verifyStarted: (() => void) | undefined, releaseVerify: (() => void) | undefined, aborts = 0, publishes = 0;
    const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const verifyReady = new Promise<void>((resolve) => { verifyStarted = resolve; });
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { verifyStarted!(); await verifyGate; return { sha256: "b".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; },
      async abort() { aborts += 1; await rm(stagingPath, { force: true }); },
    } as never));
    try {
      const pending = renderMotionGpuPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        outputPath,
        sessionOptions: { openRuntime: async () => fakeRuntime() },
      });
      await verifyReady;
      pkg.manifest.name = "mutated while staging verified output";
      releaseVerify!();
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("snapshot is stale") } });
      expect({ aborts, publishes }).toEqual({ aborts: 1, publishes: 0 });
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts staged output and returns no success when one-shot cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-cleanup-failure-"));
    const stagingPath = join(root, "frame.staging");
    const outputPath = join(root, "out", "frame.png");
    let aborts = 0, publishes = 0, closes = 0;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { return { sha256: "c".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; await writeFile(outputPath, "published"); },
      async abort() { aborts += 1; await rm(stagingPath, { force: true }); },
    } as never));
    try {
      const result = await renderMotionGpuPreview(scenePackage(root), {
        atMs: 500,
        outDir: join(root, "out"),
        outputPath,
        sessionOptions: {
          openRuntime: async () => {
            const opened = await fakeRuntime();
            if (opened.ok) opened.session.close = async () => { closes += 1; throw new Error("cleanup refused"); };
            return opened;
          },
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_execution_refused", message: expect.stringContaining("cleanup refused") } });
      expect({ aborts, publishes, closes }).toEqual({ aborts: 1, publishes: 0, closes: 1 });
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts staged output when receipt construction fails before the terminal publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-receipt-failure-"));
    const stagingPath = join(root, "frame.staging"), outputPath = join(root, "out", "frame.png");
    let aborts = 0, publishes = 0;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { return { sha256: "d".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; await writeFile(outputPath, "published"); },
      async abort() { aborts += 1; await rm(stagingPath, { force: true }); },
    } as never));
    try {
      const result = await renderMotionGpuPreview(scenePackage(root), {
        atMs: 500, outDir: join(root, "out"), outputPath, now: () => { throw new Error("receipt clock refused"); },
        sessionOptions: { openRuntime: async () => fakeRuntime() },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_execution_refused", message: expect.stringContaining("receipt clock refused") } });
      expect({ aborts, publishes }).toEqual({ aborts: 1, publishes: 0 });
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("constructs and verifies a reusable-session receipt before its immediate publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-reusable-receipt-failure-"));
    const stagingPath = join(root, "frame.staging"), outputPath = join(root, "out", "frame.png");
    const pkg = scenePackage(root);
    delete pkg.motion.scene3dAnimation;
    let aborts = 0, publishes = 0;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { return { sha256: "e".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; await writeFile(outputPath, "published"); },
      async abort() { aborts += 1; await rm(stagingPath, { force: true }); },
    } as never));
    const session = createGpuPreviewSession(pkg, { openRuntime: async () => fakeRuntime() });
    try {
      const result = await session.renderFrame({ atMs: 500, outDir: join(root, "out"), outputPath, now: () => { throw new Error("reusable receipt clock refused"); } });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_execution_refused", message: expect.stringContaining("reusable receipt clock refused") } });
      expect({ aborts, publishes }).toEqual({ aborts: 1, publishes: 0 });
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.close();
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function scenePackage(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_o6_scene", name: "O6 scene", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_o6_scene", name: "O6 scene", durationMs: 1_000, fps: 30, width: 16, height: 8,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{
        id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
        scene3d: {
          schema: "shellx-motion/scene3d@1", camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
          lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" }, backgroundColor: "#101820",
          objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }],
        },
      }],
      scene3dAnimation: {
        schema: "shellx-motion/scene3d-animation@1",
        tracks: [
          { id: "background", locator: { layerId: "world", scope: "background", property: "color" }, keyframes: [{ atUs: 0, value: "#000000" }] },
          { id: "intensity", locator: { layerId: "world", scope: "lighting", property: "intensity" }, keyframes: [{ atUs: 500_000, value: 1.5 }] },
        ],
      },
    },
  };
}

async function fakeRuntime(onRender?: (plan: unknown) => void, onClose?: () => void): Promise<GpuFrameRenderSessionOpenResult> {
  return {
    ok: true,
    session: {
      browserProcess: { pid: 6_006, launcher: "playwright-launch-server", containment: null },
      async uploadImages(images) { return { ok: true, uploaded: images.length }; },
      async replaceDynamicImages(images) { return { ok: true, replaced: images.length }; },
      async render(plan) {
        onRender?.(plan);
        const frame = plan as { width: number; height: number };
        const rgba = Buffer.alloc(frame.width * frame.height * 4, 255);
        return { ok: true, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: frame.width, height: frame.height, evidence: evidence() } };
      },
      async close() { onClose?.(); },
    },
  };
}

function evidence(): GpuRuntimeEvidence {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "available", adapterFingerprint: "a".repeat(64),
    adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 64 * 1024 * 1024, maxStorageBufferBindingSize: 64 * 1024 * 1024 },
  };
}
