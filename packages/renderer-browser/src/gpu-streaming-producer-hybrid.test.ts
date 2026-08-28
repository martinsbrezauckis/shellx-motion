import { createHash } from "node:crypto";
import { agentScriptExecutionEvidenceForDataOnly, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import type { GpuHybridCaptureBinding } from "./gpu-browser-hybrid";
import { DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, type GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import type { GpuSessionImageResource } from "./gpu-runtime-types";
import { emptyGpuStreamingEvidence } from "./gpu-streaming-producer-state";
import { openGpuStreamingHybridSource } from "./gpu-streaming-producer-hybrid";
import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";

describe("GPU streaming hybrid source", () => {
  it("uses the shared bounded default for a valid hybrid texture upload", async () => {
    const pkg = hybridPackage();
    const rgba = Buffer.alloc(16, 0x2a);
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");
    const observedTimeouts: Array<number | undefined> = [];
    const source = await openGpuStreamingHybridSource({
      producer: {
        openHybridCapture: async () => ({
          sourceSnapshot: { sourceSnapshotSha256: bindingFor(pkg).sourceDocument.sourceSha256, sourceByteLength: bindingFor(pkg).sourceDocument.byteLength },
          get binding() { return bindingFor(pkg); },
          async capture(atMs: number) {
            return {
              atMs,
              pngSha256: "a".repeat(64),
              binding: bindingFor(pkg),
              texture: { id: "browser-surface-card", width: 2, height: 2, rgba, sha256: "a".repeat(64), decodedSha256 }
            };
          },
          async close() {}
        })
      } as unknown as GpuStreamingFrameProducerInput,
      pkg,
      runtime: {
        async uploadImages(_images: readonly GpuSessionImageResource[], options?: { timeoutMs?: number; signal?: AbortSignal }) {
          observedTimeouts.push(options?.timeoutMs);
          return { ok: true as const, uploaded: 1 };
        }
      } as unknown as GpuFrameRenderSession,
      job: { admission: "pre-acquired", scratchRoot: "/test", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as GpuStreamingJobContext,
      loadedInputHashes: { "motion.json": "c".repeat(64) }, resourceInputHashes: {}
    });

    await expect(source?.capture({ index: 0, atMs: 0, evidence: emptyGpuStreamingEvidence({}) })).resolves.toMatchObject({ ok: true });
    expect(observedTimeouts).toEqual([DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS]);
    await source?.close();
  });

  it("refuses a tampered raw browser capture before it reaches the GPU uploader", async () => {
    const pkg = hybridPackage(); const rgba = Buffer.alloc(16, 0x2a); let uploads = 0;
    const source = await openGpuStreamingHybridSource({
      producer: { openHybridCapture: async () => ({ sourceSnapshot: { sourceSnapshotSha256: bindingFor(pkg).sourceDocument.sourceSha256, sourceByteLength: bindingFor(pkg).sourceDocument.byteLength }, get binding() { return bindingFor(pkg); }, async capture(atMs: number) { return { atMs, pngSha256: "a".repeat(64), binding: bindingFor(pkg), texture: { id: "browser-surface-card", width: 2, height: 2, rgba, sha256: "a".repeat(64), decodedSha256: "b".repeat(64) } }; }, async close() {} }) } as unknown as GpuStreamingFrameProducerInput,
      pkg,
      runtime: { async uploadImages() { uploads += 1; return { ok: true as const, uploaded: 1 }; } } as unknown as GpuFrameRenderSession,
      job: { admission: "pre-acquired", scratchRoot: "/test", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as GpuStreamingJobContext,
      loadedInputHashes: { "motion.json": "c".repeat(64) }, resourceInputHashes: {}
    });
    const captured = await source?.capture({ index: 0, atMs: 0, evidence: emptyGpuStreamingEvidence({}) });
    expect(captured).toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded", message: expect.stringContaining("decoded identity") } });
    expect(uploads).toBe(0);
  });

  it("refuses a custom capture binding or observed geometry that is not the exact Core descriptor before upload", async () => {
    const pkg = hybridPackage();
    const rgba = Buffer.alloc(16, 0x2a);
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");
    const binding = bindingFor(pkg);
    const forged = [
      { name: "layer", binding: { ...binding, layerId: "other-layer" }, width: 2, height: 2, message: /layer and source/i },
      { name: "source", binding: { ...binding, source: "other.html" }, width: 2, height: 2, message: /layer and source/i },
      { name: "producer", binding: { ...binding, schema: "shellx-motion/gpu-restricted-shader-hybrid@1", producer: "governed-restricted-glsl-webgl" }, width: 2, height: 2, message: /strict data-only html/i },
      { name: "geometry", binding, width: 1, height: 2, message: /texture geometry/i },
    ];
    for (const candidate of forged) {
      let uploads = 0;
      const source = await openGpuStreamingHybridSource({
        producer: {
          openHybridCapture: async () => ({
            sourceSnapshot: { sourceSnapshotSha256: binding.sourceDocument.sourceSha256, sourceByteLength: binding.sourceDocument.byteLength },
            get binding() { return candidate.binding as never; },
            async capture(atMs: number) {
              return {
                atMs,
                pngSha256: "a".repeat(64),
                binding: candidate.binding as never,
                texture: { id: `browser-surface-${candidate.name}`, width: candidate.width, height: candidate.height, rgba, sha256: "a".repeat(64), decodedSha256 }
              };
            },
            async close() {}
          })
        } as unknown as GpuStreamingFrameProducerInput,
        pkg,
        runtime: { async uploadImages() { uploads += 1; return { ok: true as const, uploaded: 1 }; } } as unknown as GpuFrameRenderSession,
        job: job(), loadedInputHashes: {}, resourceInputHashes: {},
      });
      const result = await source?.capture({ index: 0, atMs: 0, evidence: emptyGpuStreamingEvidence({}) });
      expect(result).toMatchObject({ ok: false, failure: { message: expect.stringMatching(candidate.message) } });
      expect(uploads).toBe(0);
      await source?.close();
    }
  });

  it("refuses custom HTML and GLSL binding source facts that differ from their opened immutable snapshots", async () => {
    const rgba = Buffer.alloc(16, 0x2a);
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");
    const cases = [
      { name: "html", pkg: hybridPackage(), binding: bindingFor(hybridPackage()), sourceSnapshotSha256: "b".repeat(64), sourceByteLength: 4, textureId: "browser-surface-card" },
      { name: "glsl", pkg: shaderPackage(), binding: shaderBindingFor(), sourceSnapshotSha256: "b".repeat(64), sourceByteLength: 4, textureId: "restricted-shader-legacy" },
    ];
    for (const candidate of cases) {
      let uploads = 0;
      const source = await openGpuStreamingHybridSource({
        producer: {
          openHybridCapture: async () => ({
            sourceSnapshot: { sourceSnapshotSha256: candidate.sourceSnapshotSha256, sourceByteLength: candidate.sourceByteLength },
            get binding() { return candidate.binding as never; },
            async capture(atMs: number) {
              return {
                atMs,
                pngSha256: "a".repeat(64),
                binding: candidate.binding as never,
                texture: { id: candidate.textureId, width: 2, height: 2, rgba, sha256: "a".repeat(64), decodedSha256 }
              };
            },
            async close() {}
          })
        } as unknown as GpuStreamingFrameProducerInput,
        pkg: candidate.pkg,
        runtime: { async uploadImages() { uploads += 1; return { ok: true as const, uploaded: 1 }; } } as unknown as GpuFrameRenderSession,
        job: job(), loadedInputHashes: {}, resourceInputHashes: {},
      });
      const result = await source?.capture({ index: 0, atMs: 0, evidence: emptyGpuStreamingEvidence({}) });
      expect(result).toMatchObject({ ok: false, failure: { message: expect.stringMatching(/immutable source snapshot/i) } });
      expect(uploads).toBe(0);
      await source?.close();
    }
  });

  it("refuses a tampered isolated restricted-shader texture before it reaches the GPU uploader", async () => {
    const pkg = shaderPackage(); const rgba = Buffer.alloc(16, 0x2a); let uploads = 0;
    const source = await openGpuStreamingHybridSource({
      producer: { openHybridCapture: async () => ({ sourceSnapshot: { sourceSnapshotSha256: shaderBindingFor().shader.sourceSha256, sourceByteLength: shaderBindingFor().shader.byteLength }, get binding() { return shaderBindingFor(); }, async capture(atMs: number) { return { atMs, pngSha256: "a".repeat(64), binding: shaderBindingFor(), texture: { id: "restricted-shader-legacy", width: 2, height: 2, rgba, sha256: "a".repeat(64), decodedSha256: "b".repeat(64) } }; }, async close() {} }) } as unknown as GpuStreamingFrameProducerInput,
      pkg,
      runtime: { async uploadImages() { uploads += 1; return { ok: true as const, uploaded: 1 }; } } as unknown as GpuFrameRenderSession,
      job: { admission: "pre-acquired", scratchRoot: "/test", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as GpuStreamingJobContext,
      loadedInputHashes: { "motion.json": "c".repeat(64) }, resourceInputHashes: {}
    });
    const captured = await source?.capture({ index: 0, atMs: 0, evidence: emptyGpuStreamingEvidence({}) });
    expect(captured).toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded", message: expect.stringContaining("decoded identity") } });
    expect(uploads).toBe(0);
  });

  it("validates the one Core descriptor before opening a direct capture, then closes a malformed opened capture exactly once", async () => {
    const malformed = hybridPackage();
    malformed.motion.layers.push({ id: "second", type: "html", source: "second.html", startMs: 0, durationMs: 1_000 });
    let opens = 0;
    await expect(openGpuStreamingHybridSource({
      producer: { openHybridCapture: async () => { opens += 1; throw new Error("must not open"); } } as unknown as GpuStreamingFrameProducerInput,
      pkg: malformed, runtime: {} as GpuFrameRenderSession, job: job(), loadedInputHashes: {}, resourceInputHashes: {},
    })).rejects.toThrow(/exactly one Core governed hybrid texture descriptor/);
    expect(opens).toBe(0);

    let closes = 0;
    await expect(openGpuStreamingHybridSource({
      producer: { openHybridCapture: async () => ({ sourceSnapshot: { sourceSnapshotSha256: "a".repeat(64), sourceByteLength: 0 }, get binding() { return bindingFor(hybridPackage()); }, async capture() { throw new Error("not reached"); }, async close() { closes += 1; } }) } as unknown as GpuStreamingFrameProducerInput,
      pkg: hybridPackage(), runtime: {} as GpuFrameRenderSession, job: job(), loadedInputHashes: {}, resourceInputHashes: {},
    })).rejects.toThrow(/source snapshot/i);
    expect(closes).toBe(1);
  });

  it("does not activate a hybrid child hidden by an invisible parent group", async () => {
    const pkg = hybridPackage();
    pkg.motion.layers = [
      { id: "hidden-parent", type: "group", visible: false, startMs: 0, durationMs: 1_000, childLayerIds: ["card"] },
      pkg.motion.layers[0]!,
    ];
    let opens = 0;
    const source = await openGpuStreamingHybridSource({
      producer: { openHybridCapture: async () => { opens += 1; throw new Error("must not open"); } } as unknown as GpuStreamingFrameProducerInput,
      pkg, runtime: {} as GpuFrameRenderSession, job: job(), loadedInputHashes: {}, resourceInputHashes: {},
    });
    expect(source).toBeNull();
    expect(opens).toBe(0);
  });
});

function job(): GpuStreamingJobContext { return { admission: "pre-acquired", scratchRoot: "/test", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} }; }

function hybridPackage(): MotionPackage {
  return { root: "/test", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_hybrid", name: "Hybrid", motion: "motion.json", assets: ["card.html"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: { schema: "shellx-motion/motion@1", id: "motion_hybrid", name: "Hybrid", durationMs: 1_000, fps: 1, width: 2, height: 2, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "card", type: "html", source: "card.html", startMs: 0, durationMs: 1_000 }] } };
}

function bindingFor(pkg: MotionPackage): GpuHybridCaptureBinding {
  return { schema: "shellx-motion/gpu-hybrid-capture@1", classification: "gpu-hybrid", producer: "governed-browser-surface", browserOwnership: "borrowed-gpu-runtime", captureScope: "declared-browser-source-document", layerId: "card", source: "card.html", sourceDocument: { schema: "shellx-motion/gpu-hybrid-html-policy@1", policy: "strict-data-only-html", source: "card.html", sourceSha256: createHash("sha256").update("card").digest("hex"), byteLength: 4 }, browser: { name: "chromium", version: "test" }, scriptExecution: agentScriptExecutionEvidenceForDataOnly(pkg.motion), network: { policy: "host-approved-origins", allowPrivateNetwork: false, resolutionTimeoutMs: 1, approvedOrigins: [], pins: [], responsePolicy: { maxResponseBytes: 1, maxAggregateBytes: 1, maxConcurrentResponses: 1, contentTypes: "bounded-render-media" } }, inputHashes: { "card.html": createHash("sha256").update("card").digest("hex") }, typography: "browser-html-canvas-unverified" };
}

function shaderPackage(): MotionPackage { return { root: "/test", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_shader", name: "Shader", motion: "motion.json", assets: ["legacy.glsl"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: { schema: "shellx-motion/motion@1", id: "motion_shader", name: "Shader", durationMs: 1_000, fps: 1, width: 2, height: 2, assets: [{ id: "legacy", type: "shader", source: { path: "legacy.glsl", mimeType: "text/x-shellx-motion-glsl" } }], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "legacy", type: "shader", startMs: 0, durationMs: 1_000, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "legacy", seed: 1, fallbackColor: "#000000" } }] } }; }
function shaderBindingFor() { return { schema: "shellx-motion/gpu-restricted-shader-hybrid@1" as const, classification: "gpu-restricted-shader-hybrid" as const, producer: "governed-restricted-glsl-webgl" as const, browserOwnership: "borrowed-gpu-runtime" as const, captureScope: "isolated-shader-layer-texture" as const, layerId: "legacy", source: "legacy.glsl", shader: { schema: "shellx-motion/shader-plugin@1" as const, language: "glsl-es-100-expression" as const, assetRef: "legacy.glsl", sourceSha256: "a".repeat(64), byteLength: 4, seed: 1, uniformNames: [], validation: "restricted-expression-only" as const }, texture: { width: 2, height: 2, encoding: "png" as const, alpha: "straight-rgba" as const }, browser: { name: "chromium" as const, version: "test" }, scriptExecution: agentScriptExecutionEvidenceForDataOnly(shaderPackage().motion), network: bindingFor(hybridPackage()).network, inputHashes: { "legacy.glsl": "a".repeat(64) }, typography: "not-applicable-isolated-webgl" as const }; }
