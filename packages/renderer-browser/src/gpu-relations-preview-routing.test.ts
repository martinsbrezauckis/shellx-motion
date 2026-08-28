import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@shellx-motion/core";
import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { createGpuPreviewSession, renderMotionGpuPreview } from "./gpu-points-preview";
import { GPU_RELATIONS_PREVIEW_RECEIPT_SCHEMA, verifyGpuRelationsPreviewReceiptEvidence } from "./gpu-preview-output";
import { fakeGpuRuntime } from "./gpu-streaming-producer.test-support";

describe("strict Browser GPU relation preview routing", () => {
  it("uses Core's opaque relation frame wrapper before rendering and closes its selected runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-relations-route-"));
    const publication = mockPublication();
    let opens = 0, closes = 0;
    const plans: Array<{ draws?: Array<{ id?: string; x?: number; y?: number }> }> = [];
    const session = createGpuPreviewSession(packageAt(root), {
      openRuntime: async () => {
        opens += 1;
        const opened = fakeGpuRuntime(() => { closes += 1; });
        if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        return { ok: true, session: { ...opened.session, async render(plan, options) { plans.push(plan as typeof plans[number]); return await render(plan, options); } } };
      },
    });
    try {
      const result = await session.renderFrame({ atMs: 500, outDir: root, outputPath: join(root, "relations.png") });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(result.receipt.inputHashes["gpu-frame-plan"]).toMatch(/^[a-f0-9]{64}$/);
      expect(plans[0]?.draws?.find((draw) => draw.id === "follower")).toMatchObject({ x: 30, y: 8 });
      expect(opens).toBe(1);
    } finally {
      await expect(session.close()).resolves.toMatchObject({ closed: true });
      expect(closes).toBe(1);
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels or refuses before runtime allocation or output publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-relations-refusal-"));
    const outDir = join(root, "must-not-exist");
    const outputPath = join(outDir, "relations.png");
    const controller = new AbortController(); controller.abort(new Error("stop relations"));
    let opens = 0, preparations = 0;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    const session = createGpuPreviewSession(packageAt(root), {
      openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); },
      async prepareResourcesForTest() { preparations += 1; throw new Error("resource preparation must not run"); },
    });
    try {
      await expect(session.renderFrame({ atMs: 500, outDir, outputPath, signal: controller.signal })).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect({ opens, preparations, outputPublications: publication.mock.calls.length }).toEqual({ opens: 0, preparations: 0, outputPublications: 0 });
    } finally {
      await session.close();
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }

    const raceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-relations-cancel-race-"));
    const raceOutDir = join(raceRoot, "must-not-exist");
    const raceController = new AbortController();
    let raceOpens = 0, racePreparations = 0;
    const racePublication = vi.spyOn(core, "acquireDerivedOutputPublication");
    const raceSession = createGpuPreviewSession(packageAt(raceRoot), {
      openRuntime: async () => { raceOpens += 1; return fakeGpuRuntime(() => {}); },
      async prepareResourcesForTest() { racePreparations += 1; throw new Error("resource preparation must not run"); },
    });
    try {
      const pending = raceSession.renderFrame({ atMs: 500, outDir: raceOutDir, outputPath: join(raceOutDir, "relations.png"), signal: raceController.signal });
      queueMicrotask(() => raceController.abort(new Error("stop after static resolution")));
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      await expect(stat(raceOutDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect({ raceOpens, racePreparations, outputPublications: racePublication.mock.calls.length }).toEqual({ raceOpens: 0, racePreparations: 0, outputPublications: 0 });
    } finally {
      await raceSession.close();
      racePublication.mockRestore();
      await rm(raceRoot, { recursive: true, force: true });
    }

    const refusalRoot = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-relations-resource-"));
    const refusalOutput = join(refusalRoot, "resource.png");
    const resource = packageAt(refusalRoot);
    resource.motion.assets.push({ id: "font", path: "fonts/ui.ttf" });
    let refusalOpens = 0;
    const refusalSession = createGpuPreviewSession(resource, { openRuntime: async () => { refusalOpens += 1; return fakeGpuRuntime(() => {}); } });
    try {
      await expect(refusalSession.renderFrame({ atMs: 500, outDir: refusalRoot, outputPath: refusalOutput })).resolves.toMatchObject({
        ok: false,
        error: { code: "gpu_resource_refused", message: expect.stringContaining("declared resources") },
      });
      await expect(stat(refusalOutput)).rejects.toMatchObject({ code: "ENOENT" });
      expect(refusalOpens).toBe(0);
    } finally {
      await refusalSession.close();
      await rm(refusalRoot, { recursive: true, force: true });
    }
  });

  it("binds relation evidence and one-shot cleanup to the actual GPU preview receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-relations-receipt-"));
    const publication = mockPublication();
    let closes = 0;
    const options = { openRuntime: async () => fakeGpuRuntime(() => { closes += 1; }) };
    try {
      const result = await renderMotionGpuPreview(packageAt(root), { atMs: 500, outDir: root, outputPath: join(root, "relations.png"), sessionOptions: options });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      const output = result.receipt.output as { gpuRelations?: unknown; sessionCleanup?: unknown };
      expect(output).toMatchObject({
        gpuRelations: {
          schema: GPU_RELATIONS_PREVIEW_RECEIPT_SCHEMA,
          atUs: 500_000,
          staticWrapperFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceStaticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          frameWrapperFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceFrameFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          evaluatedLayerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        sessionCleanup: { closed: true },
      });
      expect(verifyGpuRelationsPreviewReceiptEvidence(output.gpuRelations)).toEqual(output.gpuRelations);
      const tampered = { ...(output.gpuRelations as Record<string, unknown>), atUs: 1 };
      expect(() => verifyGpuRelationsPreviewReceiptEvidence(tampered)).toThrow("fingerprint does not match");
      expect(closes).toBe(1);

      const plain = packageAt(root); delete plain.motion.relations;
      const noRelation = await renderMotionGpuPreview(plain, { atMs: 500, outDir: root, outputPath: join(root, "plain.png"), sessionOptions: options });
      expect(noRelation.ok, noRelation.ok ? undefined : noRelation.error.message).toBe(true);
      if (noRelation.ok) expect(noRelation.receipt.output).not.toHaveProperty("gpuRelations");
      expect(closes).toBe(2);
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels after asynchronous output-path setup before runtime or publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-relations-path-cancel-"));
    const controller = new AbortController();
    let opens = 0, preparations = 0, pathResolutions = 0, releasePath: (() => void) | undefined;
    let pathStarted: (() => void) | undefined;
    const pathReady = new Promise<void>((resolve) => { pathStarted = resolve; });
    const pathYield = new Promise<void>((resolve) => { releasePath = resolve; });
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    const session = createGpuPreviewSession(packageAt(root), {
      openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); },
      async prepareResourcesForTest() { preparations += 1; return {} as never; },
      async resolveOutputPathForTest() { pathResolutions += 1; pathStarted!(); await pathYield; return join(root, "after-path-setup.png"); },
    });
    try {
      const pending = session.renderFrame({ atMs: 500, outDir: root, signal: controller.signal });
      await pathReady;
      controller.abort(new Error("stop after path setup")); releasePath!();
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      await expect(stat(join(root, "after-path-setup.png"))).rejects.toMatchObject({ code: "ENOENT" });
      expect({ opens, preparations, pathResolutions, outputPublications: publication.mock.calls.length }).toEqual({ opens: 0, preparations: 1, pathResolutions: 1, outputPublications: 0 });
    } finally {
      await session.close();
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function packageAt(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "gpu-relations-route", name: "GPU relations route", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "gpu-relations-route-motion", name: "GPU relations route", durationMs: 1_000, fps: 30, width: 64, height: 64,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [
        { id: "leader", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 30, y: 8, width: 10, height: 10 } },
        { id: "follower", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      relations: {
        schema: "shellx-motion/relations@1",
        bindings: [{
          id: "follow", enabled: true, kind: "attach", mode: "follow", startUs: 0, durationUs: 1_000_000,
          source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: "follower", anchor: { x: 0, y: 0 } },
          offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 },
        }],
      },
    },
  };
}

function mockPublication() {
  return vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
    stagingPath: `${outputPath}.staging`,
    async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
    async publishFile() {},
    async abort() {},
  } as never));
}
