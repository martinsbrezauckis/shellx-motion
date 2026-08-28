import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDerivedOutputPublication, type DerivedOutputPublication, type MotionPackage } from "@shellx-motion/core";
import { compileCheckpointStoryboardRetainedTraceProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-retained-trace-profile";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { describe, expect, it, vi } from "vitest";

const browserRuntime = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./gpu-frame-renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gpu-frame-renderer")>();
  return { ...actual, createCheckpointStoryboardRetainedTraceRenderSession: browserRuntime.open };
});
import { renderCheckpointStoryboardRetainedTracePreview, verifyCheckpointStoryboardRetainedTracePreviewEvidence } from "./gpu-checkpoint-storyboard-retained-trace-preview";
import { withRendererPrivateOutputPublication } from "./private-output-publication";

describe("private Browser C6C-B7 retained-trace preview executor", () => {
  it("draws only sealed Core samples through the bounded raster contract, closes before using its Core-bound private stage, and returns bindable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-b7-trace-preview-"));
    const pkg = packageAt(root), plan = retainedTracePlan();
    const calls: string[] = [];
    let publication: DerivedOutputPublication | undefined;
    try {
      const privatePreview = await mintPrivatePreviewOptions(root, { retainedTracePlan: plan, atUs: 4_000 });
      publication = privatePreview.publication;
      browserRuntime.open.mockResolvedValueOnce({ ok: true, session: {
          browserProcess: { pid: 71 },
          async renderCheckpointStoryboardRetainedTrace(input: { readonly width: number; readonly height: number; readonly sampleCount: number; readonly rasterVertexInvocations: number; readonly vertexBytes: Uint8Array }) {
            calls.push(`draw:${input.sampleCount}:${input.rasterVertexInvocations}:${input.vertexBytes.byteLength}`);
            expect(input).toMatchObject({ width: 1280, height: 720, sampleCount: 5, rasterVertexInvocations: 24 });
            return { ok: true as const, frame: { rgba: Buffer.alloc(1280 * 720 * 4), width: 1280, height: 720, evidence: { adapterFingerprint: "a".repeat(64) } }, cleanup: { sampleBufferDestroyed: true as const, rasterControlBufferDestroyed: true as const, targetDestroyed: true as const, readbackBufferDestroyed: true as const } } as never;
          },
          async close() { calls.push("close"); expect((await privatePreview.publication.readPrivateFile({ label: "test staged PNG", maxBytes: 64 * 1024 * 1024 })).byteLength).toBe(0); },
          async resourceMetrics() { return null; },
        } } as never);
      const result = await renderCheckpointStoryboardRetainedTracePreview(pkg, privatePreview.options);
      expect(result).toMatchObject({ ok: true, output: { width: 1280, height: 720, atUs: 4_000, background: "transparent-rgba@1" }, cleanup: { closed: true, traceBuffers: { sampleBufferDestroyed: true, rasterControlBufferDestroyed: true, targetDestroyed: true, readbackBufferDestroyed: true } }, evidence: { sampleTopology: "line-strip/sequential-sample@1", rasterPrimitive: "triangle-list", rasterMapping: "motion-top-left-pixel-xy-to-ndc@1", rasterTessellation: "square-cap-or-endpoint-width-segment-quad@1", sampleCount: 5, rasterVertexInvocations: 24, maxRasterVertexInvocations: 378 } });
      if (!result.ok) return;
      expect(calls).toEqual(["draw:5:24:100", "close"]);
      expect((await privatePreview.publication.readPrivateFile({ label: "test staged PNG", maxBytes: 64 * 1024 * 1024 })).byteLength).toBe(result.output.byteLength);
      expect(result.evidence).toMatchObject({ outputSha256: result.output.sha256, outputByteLength: result.output.byteLength });
      expect(verifyCheckpointStoryboardRetainedTracePreviewEvidence(structuredClone(result.evidence))).toEqual(result.evidence);
      const tampered = structuredClone(result.evidence) as { sampleCount: number }; tampered.sampleCount = 6;
      expect(() => verifyCheckpointStoryboardRetainedTracePreviewEvidence(tampered)).toThrow("invalid fixed B7 shape");
      const tamperedOutput = structuredClone(result.evidence) as { outputByteLength: number }; tamperedOutput.outputByteLength += 1;
      expect(() => verifyCheckpointStoryboardRetainedTracePreviewEvidence(tamperedOutput)).toThrow("fingerprint does not match");
    } finally {
      browserRuntime.open.mockReset();
      await publication?.abort();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels after its isolated draw without materializing its Core-bound private stage and closes exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-b7-trace-cancel-"));
    const controller = new AbortController(); let closes = 0;
    let publication: DerivedOutputPublication | undefined;
    try {
      const privatePreview = await mintPrivatePreviewOptions(root, { retainedTracePlan: retainedTracePlan(), atUs: 4_000, signal: controller.signal });
      publication = privatePreview.publication;
      browserRuntime.open.mockResolvedValueOnce({ ok: true, session: {
          browserProcess: { pid: 72 },
          async renderCheckpointStoryboardRetainedTrace() { controller.abort(); return { ok: true as const, frame: { rgba: Buffer.alloc(1280 * 720 * 4), width: 1280, height: 720, evidence: { adapterFingerprint: "b".repeat(64) } }, cleanup: { sampleBufferDestroyed: true as const, rasterControlBufferDestroyed: true as const, targetDestroyed: true as const, readbackBufferDestroyed: true as const } } as never; },
          async close() { closes += 1; },
          async resourceMetrics() { return null; },
        } } as never);
      const result = await renderCheckpointStoryboardRetainedTracePreview(packageAt(root), privatePreview.options);
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect(closes).toBe(1);
      expect((await privatePreview.publication.readPrivateFile({ label: "test staged PNG", maxBytes: 64 * 1024 * 1024 })).byteLength).toBe(0);
    } finally {
      browserRuntime.open.mockReset();
      await publication?.abort();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses oversized Motion dimensions before the governor can open a browser or GPU runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-b7-trace-budget-"));
    let publication: DerivedOutputPublication | undefined;
    try {
      const privatePreview = await mintPrivatePreviewOptions(root, { retainedTracePlan: retainedTracePlan(), atUs: 4_000 });
      publication = privatePreview.publication;
      const pkg = packageAt(root); pkg.motion.width = 100_000;
      const result = await renderCheckpointStoryboardRetainedTracePreview(pkg, privatePreview.options);
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_execution_refused", message: expect.stringContaining("Motion frame exceeds") } });
      expect(browserRuntime.open).not.toHaveBeenCalled();
      expect((await privatePreview.publication.readPrivateFile({ label: "test staged PNG", maxBytes: 64 * 1024 * 1024 })).byteLength).toBe(0);
    } finally {
      browserRuntime.open.mockReset();
      await publication?.abort();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses missing or structural private publication authority before reading a document or opening a runtime", async () => {
    const missing = await renderCheckpointStoryboardRetainedTracePreview({} as MotionPackage, { retainedTracePlan: null, atUs: 0 } as never);
    const structural = await renderCheckpointStoryboardRetainedTracePreview({} as MotionPackage, {
      retainedTracePlan: null,
      atUs: 0,
      privateOutputPublication: { rootPath: "/caller-controlled", writePrivateFile: async () => ({ sha256: "a".repeat(64), byteLength: 1 }) },
    } as never);
    expect(missing).toMatchObject({ ok: false, error: { code: "gpu_private_output_publication_refused" } });
    expect(structural).toMatchObject({ ok: false, error: { code: "gpu_private_output_publication_refused" } });
    expect(browserRuntime.open).not.toHaveBeenCalled();
  });

  it("keeps the executor off the public root and proves the fixed page path has no generic render or descriptor tunnel", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const executor = readFileSync(new URL("./gpu-checkpoint-storyboard-retained-trace-preview.ts", import.meta.url), "utf8");
    const page = readFileSync(new URL("./gpu-page-checkpoint-storyboard-retained-trace.ts", import.meta.url), "utf8");
    expect(packageJson.exports).toHaveProperty("./internal/checkpoint-storyboard-retained-trace-preview");
    expect(packageJson.publishConfig.exports).toHaveProperty("./internal/checkpoint-storyboard-retained-trace-preview");
    expect(index).not.toContain("retained-trace-preview");
    expect(executor).not.toMatch(/\.render\(/);
    expect(executor).not.toContain("acquireDerivedOutputPublication");
    expect(executor).not.toMatch(/descriptor\s*:/);
    expect(executor).not.toContain("node:fs");
    expect(executor).not.toContain("node:path");
    expect(executor).not.toContain("stagingPath");
    expect(executor).toContain("resolveRendererPrivateOutputPublication(options)");
    expect(executor).toContain("privateOutputPublication.rootPath");
    expect(executor).toContain("privateOutputPublication.writePrivateFile");
    expect(page).toContain('primitive: { topology: "triangle-list" }');
    expect(page).toContain("var<storage, read> samples: RawSamples");
    expect(page).toContain("motionPixelToNdc");
    expect(page).toContain("packed z word is intentionally never read");
    expect(page).toContain("vec3<f32>(grayscale * alpha)");
    expect(page).toContain("pass.draw(input.rasterVertexInvocations)");
    expect(page).not.toContain("setVertexBuffer");
    expect(page).not.toContain('topology: "line-strip"');
    expect(page).toContain("clearValue: { r: 0, g: 0, b: 0, a: 0 }");
    expect(page).not.toContain("renderWebGpuPageSessionFrame");
  });
});

async function mintPrivatePreviewOptions(root: string, options: { readonly retainedTracePlan: unknown; readonly atUs: number; readonly signal?: AbortSignal }) {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
    const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "debug-owned.png"), kind: "file" });
    return Object.freeze({ publication, options: withRendererPrivateOutputPublication(options, publication) });
  });
}

function packageAt(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "B7 retained trace fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion-1", name: "B7 retained trace fixture", durationMs: 4, fps: 30, width: 1280, height: 720, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", startMs: 0, durationMs: 4, opacity: 0.75, transform: { x: 0, y: 0, width: 100, height: 100 } }] },
  };
}

function retainedTracePlan() {
  const trace = {
    schema: "shellx-motion/private-parametric-trace@1",
    clip: { durationUs: 4_000, sampleIntervalUs: 1_000 },
    drawers: [{
      id: "line",
      driver: { kind: "parametric-graph", graph: { nodes: [{ id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.00025 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } } },
      retention: { kind: "full-clip", maxSamples: 5 },
      output: { mode: "line", width: { source: "constant", from: 1, to: 1 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 },
    }],
    caps: { perDrawer: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 131_072 }, aggregate: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 131_072 } },
  };
  const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace } });
  const storyboard = createCheckpointStoryboard({
    seed: 1,
    capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
      { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
    recipes: [recipe],
  });
  return compileCheckpointStoryboardRetainedTraceProfilePlan({
    schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-request@1",
    storyboard,
    base: { packageId: "package-1", manifest: packageAt("/").manifest, motion: packageAt("/").motion, persistedMotionSha256: "a".repeat(64) },
    objectLayerBindings: [{ objectId: "trace-anchor", layerId: "trace-anchor" }],
  });
}
