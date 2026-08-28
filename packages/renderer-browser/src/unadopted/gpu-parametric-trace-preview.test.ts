import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as core from "@shellx-motion/core";
import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { fakeGpuRuntime } from "../gpu-streaming-producer.test-support";
import { renderGpuParametricTracePreview, verifyGpuParametricTracePreviewEvidence } from "./gpu-parametric-trace-preview";

describe("private Browser GPU parametric trace preview source seam", () => {
  it("passes only the Core-issued retained upload/topology to the draw seam and binds output plus cleanup evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-")), publication = mockPublication();
    let closes = 0; const uploads: unknown[] = [];
    try {
      const result = await renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 4_000, outDir: root, outputPath: join(root, "trace.png") }, {
        openRuntime: async () => fakeGpuRuntime(() => { closes += 1; }),
        prepareResourcesForTest: async () => prepared(),
        async drawTraceForTest({ runtime, upload }) { uploads.push(upload); return await runtime.render({ width: 64, height: 64 } as never); },
      });
      expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({ frame: { atUs: 4_000, vertexAbi: "shellx-motion/gpu-parametric-trace-vertices@2", topologyAbi: "fixed-vertex-fetch-topology@1" }, drawers: [{ drawerId: "line", vertexBytes: expect.any(Uint8Array) }, { drawerId: "tube", vertexBytes: expect.any(Uint8Array) }] });
      const upload = uploads[0] as { frame: { drawers: Array<{ drawerId: string; topology: { primitive: string; fetch: string; drawVertexInvocations: number } }> }; drawers: Array<{ drawerId: string }> };
      expect(upload.frame.drawers.map((item) => [item.topology.primitive, item.topology.fetch, item.topology.drawVertexInvocations])).toEqual([["line-strip", "sequential-sample@1", 5], ["triangle-list", "ring8-segment-vertex-fetch@1", 192]]);
      const output = result.receipt.output as { gpuParametricTrace: unknown; gpuParametricTraceCleanup: { closed: boolean; fingerprint: string } };
      const serialized = structuredClone(output.gpuParametricTrace);
      expect(verifyGpuParametricTracePreviewEvidence(serialized)).toEqual(output.gpuParametricTrace);
      (serialized as { atUs: number }).atUs = 0;
      expect(() => verifyGpuParametricTracePreviewEvidence(serialized)).toThrow("fingerprint");
      expect(output.gpuParametricTraceCleanup).toMatchObject({ closed: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(closes).toBe(1);
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("refuses without the private draw seam and keeps the module out of Browser public exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-refuse-")); let preparedCalls = 0;
    try {
      await expect(renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: join(root, "no-output") }, { async prepareResourcesForTest() { preparedCalls += 1; return prepared(); } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_trace_runtime_unavailable" } });
      expect(preparedCalls).toBe(0);
      await expect(stat(join(root, "no-output"))).rejects.toMatchObject({ code: "ENOENT" });
      const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8"), manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
      expect(index).not.toContain("parametric-trace"); expect(manifest.exports).not.toHaveProperty("./internal/parametric-trace-preview"); expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/parametric-trace-preview");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses the one-unit-under fixed tube topology cap before Browser preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-cap-")); let preparedCalls = 0, openCalls = 0;
    try {
      await expect(renderGpuParametricTracePreview(packageAt(root), { descriptor: cappedTubeDescriptor(74), atUs: 1_000, outDir: join(root, "cap") }, {
        async prepareResourcesForTest() { preparedCalls += 1; return prepared(); },
        async openRuntime() { openCalls += 1; return fakeGpuRuntime(() => {}); },
        async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); },
      })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: expect.stringContaining("topology work") } });
      expect({ preparedCalls, openCalls }).toEqual({ preparedCalls: 0, openCalls: 0 });
      await expect(stat(join(root, "cap", "gpu-trace-route-gpu-1.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cancels before resource preparation, after resource await, after output-path await, and after runtime draw without publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-cancel-")), publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    try {
      const pre = new AbortController(); pre.abort(); let preResources = 0, preOpens = 0;
      await expect(renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: join(root, "pre"), signal: pre.signal }, { async prepareResourcesForTest() { preResources += 1; return prepared(); }, openRuntime: async () => { preOpens += 1; return fakeGpuRuntime(() => {}); }, async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect({ preResources, preOpens, publications: publication.mock.calls.length }).toEqual({ preResources: 0, preOpens: 0, publications: 0 });

      const afterResources = new AbortController(); let resourceStarted: (() => void) | undefined, releaseResource: (() => void) | undefined, resourceOpens = 0;
      const resourceReady = new Promise<void>((resolve) => { resourceStarted = resolve; }), resourceGate = new Promise<void>((resolve) => { releaseResource = resolve; });
      const resourcePending = renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: join(root, "resource"), signal: afterResources.signal }, { async prepareResourcesForTest() { resourceStarted!(); await resourceGate; return prepared(); }, openRuntime: async () => { resourceOpens += 1; return fakeGpuRuntime(() => {}); }, async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      await resourceReady; afterResources.abort(); releaseResource!(); await expect(resourcePending).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect(resourceOpens).toBe(0);
      await expect(stat(join(root, "resource", "trace.png"))).rejects.toMatchObject({ code: "ENOENT" });

      const afterPath = new AbortController(); let pathStarted: (() => void) | undefined, releasePath: (() => void) | undefined, pathOpens = 0;
      const pathReady = new Promise<void>((resolve) => { pathStarted = resolve; }), pathGate = new Promise<void>((resolve) => { releasePath = resolve; });
      const pathPending = renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: join(root, "path"), signal: afterPath.signal }, { prepareResourcesForTest: async () => prepared(), async resolveOutputPathForTest() { pathStarted!(); await pathGate; return join(root, "path", "trace.png"); }, openRuntime: async () => { pathOpens += 1; return fakeGpuRuntime(() => {}); }, async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      await pathReady; afterPath.abort(); releasePath!(); await expect(pathPending).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect(pathOpens).toBe(0);
      await expect(stat(join(root, "path", "trace.png"))).rejects.toMatchObject({ code: "ENOENT" });

      const afterDraw = new AbortController(); let drawOpens = 0, drawCloses = 0;
      await expect(renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: join(root, "draw"), signal: afterDraw.signal }, { prepareResourcesForTest: async () => prepared(), resolveOutputPathForTest: async () => join(root, "draw", "trace.png"), openRuntime: async () => { drawOpens += 1; return fakeGpuRuntime(() => { drawCloses += 1; }); }, async drawTraceForTest({ runtime }) { afterDraw.abort(); return await runtime.render({ width: 64, height: 64 } as never); } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect({ drawOpens, drawCloses, publications: publication.mock.calls.length }).toEqual({ drawOpens: 1, drawCloses: 1, publications: 0 });
      await expect(stat(join(root, "draw", "trace.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("closes successfully drawn runtime before publication and refuses a close failure without output or receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-close-")), publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    let closes = 0;
    try {
      const result = await renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: root, outputPath: join(root, "close.png") }, {
        prepareResourcesForTest: async () => prepared(),
        openRuntime: async () => {
          const opened = fakeGpuRuntime(() => { closes += 1; });
          if (opened.ok) opened.session.close = async () => { closes += 1; throw new Error("close refused"); };
          return opened;
        },
        async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_execution_refused", message: expect.stringContaining("close refused") } });
      expect({ closes, publications: publication.mock.calls.length }).toEqual({ closes: 1, publications: 0 });
      await expect(stat(join(root, "close.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("refuses Motion and manifest mutations after gated resource preparation before opening runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-stale-resource-")), publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    try {
      const motionPkg = packageAt(root); let motionReady: (() => void) | undefined, releaseMotion: (() => void) | undefined, motionOpens = 0;
      const motionGate = new Promise<void>((resolve) => { releaseMotion = resolve; }), motionStarted = new Promise<void>((resolve) => { motionReady = resolve; });
      const motionPending = renderGpuParametricTracePreview(motionPkg, { descriptor: descriptor(), atUs: 0, outDir: root, outputPath: join(root, "motion-stale.png") }, { async prepareResourcesForTest() { motionReady!(); await motionGate; return prepared(); }, openRuntime: async () => { motionOpens += 1; return fakeGpuRuntime(() => {}); }, async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      await motionStarted; motionPkg.motion.name = "mutated Motion"; releaseMotion!();
      await expect(motionPending).resolves.toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("stale") } });
      expect(motionOpens).toBe(0);

      const manifestPkg = packageAt(root); let manifestReady: (() => void) | undefined, releaseManifest: (() => void) | undefined, manifestOpens = 0;
      const manifestGate = new Promise<void>((resolve) => { releaseManifest = resolve; }), manifestStarted = new Promise<void>((resolve) => { manifestReady = resolve; });
      const manifestPending = renderGpuParametricTracePreview(manifestPkg, { descriptor: descriptor(), atUs: 0, outDir: root, outputPath: join(root, "manifest-stale.png") }, { async prepareResourcesForTest() { manifestReady!(); await manifestGate; return prepared(); }, openRuntime: async () => { manifestOpens += 1; return fakeGpuRuntime(() => {}); }, async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      await manifestStarted; manifestPkg.manifest.name = "mutated manifest"; releaseManifest!();
      await expect(manifestPending).resolves.toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("snapshot") } });
      expect({ manifestOpens, publications: publication.mock.calls.length }).toEqual({ manifestOpens: 0, publications: 0 });
      await expect(stat(join(root, "motion-stale.png"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "manifest-stale.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a Motion mutation during draw after closing runtime but before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-stale-draw-")), publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    const pkg = packageAt(root); let opens = 0, closes = 0;
    try {
      const result = await renderGpuParametricTracePreview(pkg, { descriptor: descriptor(), atUs: 0, outDir: root, outputPath: join(root, "draw-stale.png") }, { prepareResourcesForTest: async () => prepared(), resolveOutputPathForTest: async () => join(root, "draw-stale.png"), openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => { closes += 1; }); }, async drawTraceForTest({ runtime }) { pkg.motion.name = "mutated during draw"; return await runtime.render({ width: 64, height: 64 } as never); } });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("stale") } });
      expect({ opens, closes, publications: publication.mock.calls.length }).toEqual({ opens: 1, closes: 1, publications: 0 });
      await expect(stat(join(root, "draw-stale.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("aborts a verified staging file when cancellation arrives before the irreversible publish commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-precommit-")), signal = new AbortController(), stagingPath = join(root, "trace.stage");
    let aborts = 0, publishes = 0;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { signal.abort(); return { sha256: "a".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; },
      async abort() { aborts += 1; await rm(stagingPath, { force: true }); },
    } as never));
    try {
      const result = await renderGpuParametricTracePreview(packageAt(root), { descriptor: descriptor(), atUs: 0, outDir: root, outputPath: join(root, "precommit.png"), signal: signal.signal }, { prepareResourcesForTest: async () => prepared(), openRuntime: async () => fakeGpuRuntime(() => {}), async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_cancelled" } });
      expect({ aborts, publishes }).toEqual({ aborts: 1, publishes: 0 });
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "precommit.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("aborts staged output when the package becomes stale while verification is gated", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-stale-verify-")), stagingPath = join(root, "trace.stage"), outputPath = join(root, "stale-verify.png");
    let verifyStarted: (() => void) | undefined, releaseVerify: (() => void) | undefined, aborts = 0, publishes = 0;
    const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; }), verifyReady = new Promise<void>((resolve) => { verifyStarted = resolve; });
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { verifyStarted!(); await verifyGate; return { sha256: "c".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; },
      async abort() { aborts += 1; await rm(stagingPath, { force: true }); },
    } as never));
    try {
      const pkg = packageAt(root);
      const pending = renderGpuParametricTracePreview(pkg, { descriptor: descriptor(), atUs: 0, outDir: root, outputPath }, { prepareResourcesForTest: async () => prepared(), openRuntime: async () => fakeGpuRuntime(() => {}), async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      await verifyReady; pkg.manifest.name = "mutated while verifying"; releaseVerify!();
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("snapshot") } });
      expect({ aborts, publishes }).toEqual({ aborts: 1, publishes: 0 });
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it("treats a cancellation racing the irreversible publish commit as a completed output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trace-commit-")), signal = new AbortController(), outputPath = join(root, "commit.png"), stagingPath = join(root, "commit.stage");
    let publishStarted: (() => void) | undefined, releasePublish: (() => void) | undefined, publishes = 0;
    const commitStarted = new Promise<void>((resolve) => { publishStarted = resolve; }), publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async () => ({
      stagingPath,
      async verifyFile() { return { sha256: "b".repeat(64), byteLength: 1 }; },
      async publishFile() { publishes += 1; publishStarted!(); await publishGate; await writeFile(outputPath, "committed"); },
      async abort() { await rm(stagingPath, { force: true }); },
    } as never));
    try {
      const pkg = packageAt(root);
      const pending = renderGpuParametricTracePreview(pkg, { descriptor: descriptor(), atUs: 0, outDir: root, outputPath, signal: signal.signal }, { prepareResourcesForTest: async () => prepared(), openRuntime: async () => fakeGpuRuntime(() => {}), async drawTraceForTest({ runtime }) { return await runtime.render({ width: 64, height: 64 } as never); } });
      await commitStarted; pkg.manifest.id = "mutated-after-commit"; signal.abort(); releasePublish!();
      await expect(pending).resolves.toMatchObject({ ok: true, receipt: { packageId: "gpu-trace-route" }, frame: { path: outputPath, sha256: "b".repeat(64) } });
      expect(publishes).toBe(1);
      await expect(stat(outputPath)).resolves.toBeDefined();
    } finally { publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

function prepared() { return { sessionImages: [], sessionFonts: [], inputHashes: {} } as never; }
function packageAt(root: string): MotionPackage { return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "gpu-trace-route", name: "GPU trace route", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: { schema: "shellx-motion/motion@1", id: "gpu-trace-motion", name: "GPU trace motion", durationMs: 4, fps: 30, width: 64, height: 64, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 1, height: 1 } }] } }; }
function descriptor() { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers: [traceDrawer("line", "line"), traceDrawer("tube", "tube")], caps: { perDrawer: { maxSamples: 8, maxVertices: 128, maxWorkUnits: 1_000, maxBytes: 100_000 }, aggregate: { maxSamples: 64, maxVertices: 512, maxWorkUnits: 4_000, maxBytes: 1_000_000 } } }; }
function cappedTubeDescriptor(maxWorkUnits: number) { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 1_000, sampleIntervalUs: 1_000 }, drawers: [traceDrawer("tube", "tube")], caps: { perDrawer: { maxSamples: 8, maxVertices: 128, maxWorkUnits, maxBytes: 100_000 }, aggregate: { maxSamples: 64, maxVertices: 512, maxWorkUnits, maxBytes: 1_000_000 } } }; }
function traceDrawer(id: string, mode: "line" | "tube") { return { id, driver: { kind: "parametric-graph", graph: { nodes: [{ id: "t", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "t", right: "scale" }, { id: "z", kind: "constant", value: 1 }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "z" } } }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode, width: { source: "constant", from: 1, to: 1 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 1, to: 1 }, speedLimit: 100 } }; }
function mockPublication() { return vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({ stagingPath: `${outputPath}.staging`, async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; }, async publishFile() {}, async abort() {} } as never)); }
