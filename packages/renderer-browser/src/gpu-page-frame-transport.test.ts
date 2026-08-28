import { canonicalJsonSha256, compileGpuFramePlan, gpuEffectModuleResourceCeilingFingerprint } from "@shellx-motion/core";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createGpuPageFrameTransport, installGpuPageFrameTransport, type GpuPageFrameTransport } from "./gpu-page-frame-transport";

describe("GPU page frame transport", () => {
  it("round-trips an admitted plan through bounded gzip and exact SHA-256", async () => {
    const plan = compileGpuFramePlan({
      schema: "shellx-motion/gpu-frame-intent@1",
      width: 64,
      height: 64,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: [{ kind: "points", id: "field", seed: 1, instanceBufferMode: "dynamic", points: Array.from({ length: 1_000 }, (_, index) => ({ x: index % 64, y: Math.floor(index / 64), size: 2, color: { r: 0.1, g: 0.5, b: 1, a: 1 } })) }]
    });
    const transport = createGpuPageFrameTransport(plan);
    expect(transport).toMatchObject({ schema: "shellx-motion/gpu-page-frame-transport@1", codec: "gzip-json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(transport.gzipBase64.length).toBeLessThan(JSON.stringify(plan).length);
    const context = { atob, btoa, crypto, DecompressionStream, Response, TextDecoder, TransformStream, Uint8Array, ArrayBuffer, Array, Object, JSON, Math, Number, Error };
    const isolatedInstall = runInNewContext(`(${installGpuPageFrameTransport.toString()})`, context) as typeof installGpuPageFrameTransport;
    expect(isolatedInstall()).toEqual({ ok: true });
    const decoder = (context as unknown as { __shellxMotionDecodeGpuFrameTransportV1(input: unknown): Promise<unknown> }).__shellxMotionDecodeGpuFrameTransportV1;
    await expect(decoder(transport)).resolves.toEqual(plan);
    await expect(decoder({ ...transport, sha256: "0".repeat(64) } satisfies GpuPageFrameTransport)).rejects.toThrow(/hash/);
  });

  it("transports Core's closed effect-module record but leaves all execution to the later C2 page admission", async () => {
    const plan = compileGpuFramePlan({
      schema: "shellx-motion/gpu-frame-intent@1",
      width: 64,
      height: 64,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: [
        { kind: "groupStart", id: "subject-group.group", drawCount: 1, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 32, pivotY: 32, opacity: 1, blendMode: "normal", effects: null },
        effectModuleDraw(),
        { kind: "groupEnd", id: "subject-group.group.end", groupId: "subject-group.group" }
      ]
    });
    expect(plan.draws).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "effectModule", id: "effect-module-draw-2", layerId: "afterimage" })]));
    expect(plan.budget).toMatchObject({ effectModuleCount: 1, effectModuleUniformBytes: 160, effectModuleTextureLoadCount: 2, effectModulePassCount: 1 });
    const transport = createGpuPageFrameTransport(plan);
    const context = { atob, btoa, crypto, DecompressionStream, Response, TextDecoder, TransformStream, Uint8Array, ArrayBuffer, Array, Object, JSON, Math, Number, Error };
    const install = runInNewContext(`(${installGpuPageFrameTransport.toString()})`, context) as typeof installGpuPageFrameTransport;
    expect(install()).toEqual({ ok: true });
    const decoder = (context as unknown as { __shellxMotionDecodeGpuFrameTransportV1(input: unknown): Promise<unknown> }).__shellxMotionDecodeGpuFrameTransportV1;
    await expect(decoder(transport)).resolves.toEqual(plan);
  });
});

function effectModuleDraw(): Record<string, unknown> {
  const descriptor = {
    layerId: "afterimage",
    drawId: "effect-module-draw-2",
    scopeGroupId: "subject-group",
    scopeGroupDrawId: "subject-group.group",
    moduleId: "motion.afterimage-stack",
    version: "1.0.0",
    manifestSha256: "a".repeat(64),
    manifestByteLength: 512,
    registryEntrySha256: "b".repeat(64),
    installationProvenanceSha256: "c".repeat(64),
    pipelineImplementationSha256: "d".repeat(64),
    resourceCeilingSha256: gpuEffectModuleResourceCeilingFingerprint(),
    intrinsic: "motion.afterimage-stack.v1",
    rendererAbi: "shellx-motion/gpu-effect-module@1",
    parameterSchema: "motion.afterimage-stack.parameters@1",
    referenceFingerprint: "e".repeat(64),
    echoes: [{ dxPx: 1, dyPx: 0, rgba8: [255, 128, 0, 255], opacityQ16: 32_768 }],
    amountQ16: 32_768,
    uniformBytes: 160,
    textureLoadCount: 2,
    passCount: 1,
    retainedTextureCount: 0
  };
  const descriptorFingerprint = canonicalJsonSha256(descriptor);
  const binding = { ...descriptor, descriptorFingerprint };
  return { kind: "effectModule", id: descriptor.drawId, blendMode: "normal", effects: null, ...binding, bindingFingerprint: canonicalJsonSha256(binding) };
}
