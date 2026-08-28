import type { GpuPageScene3dGltfPbrHdr10ResourceMetrics } from "./gpu-page-scene3d-gltf-pbr-hdr10-resources";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuPageScene3dGltfPbrHdr10FrameInput { readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-frame@1"; readonly staticFingerprint: string; readonly sdrStaticFingerprint: string; readonly frameFingerprint: string; }
export type GpuPageScene3dGltfPbrHdr10FrameOutput = { readonly ok: true; readonly drawCount: number; readonly metrics: GpuPageScene3dGltfPbrHdr10ResourceMetrics } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Renders only fully preallocated opaque HDR resources; no frame-local texture or buffer exists. */
export async function renderWebGpuPageSessionScene3dGltfPbrHdr10Frame(input: GpuPageScene3dGltfPbrHdr10FrameInput): Promise<GpuPageScene3dGltfPbrHdr10FrameOutput> {
  type Resources = { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string; target: { createView(): unknown }; depth: { createView(): unknown }; primitives: Array<{ vertex: unknown; index: unknown; bindGroup: unknown; indexCount: number }>; metrics: GpuPageScene3dGltfPbrHdr10ResourceMetrics; renderedFrames: number };
  type Device = { createCommandEncoder(): { beginRenderPass(value: unknown): { setPipeline(value: unknown): void; setVertexBuffer(index: number, value: unknown): void; setIndexBuffer(value: unknown, format: "uint32"): void; setBindGroup(index: number, value: unknown): void; drawIndexed(count: number): void; end(): void }; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } };
  const state = (globalThis as unknown as { __shellxMotionGpuHdr10PbrSessionV1?: { device?: Device; hdr10PbrPipeline?: unknown; resources?: Resources; lost?: boolean } }).__shellxMotionGpuHdr10PbrSessionV1, resources = state?.resources;
  if (!state?.device || !state.hdr10PbrPipeline || !resources) return fail("gpu_device_unavailable", "The HDR10 PBR frame has no prepared page resources.");
  if (!valid(input, resources)) return fail("gpu_resource_refused", "The HDR10 PBR frame identity does not match prepared resources.");
  if (state.lost) return fail("gpu_device_lost", "The HDR10 PBR device was lost before rendering.");
  try {
    const encoder = state.device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: resources.target.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: resources.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    pass.setPipeline(state.hdr10PbrPipeline); for (const primitive of resources.primitives) { pass.setVertexBuffer(0, primitive.vertex); pass.setIndexBuffer(primitive.index, "uint32"); pass.setBindGroup(0, primitive.bindGroup); pass.drawIndexed(primitive.indexCount); } pass.end(); state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone(); resources.renderedFrames += 1;
    return { ok: true, drawCount: resources.primitives.length, metrics: Object.freeze({ ...resources.metrics, renderedFrames: resources.renderedFrames }) };
  } catch { return fail("gpu_render_failed", "The HDR10 PBR frame failed; terminal cleanup is required."); }
  function fail(code: GpuRuntimeFailure["code"], message: string): GpuPageScene3dGltfPbrHdr10FrameOutput { return { ok: false, failure: { code, message } }; }
  function valid(value: unknown, current: Resources): value is GpuPageScene3dGltfPbrHdr10FrameInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "frameFingerprint,schema,sdrStaticFingerprint,staticFingerprint" && (value as GpuPageScene3dGltfPbrHdr10FrameInput).schema === "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-frame@1" && hashes(value as GpuPageScene3dGltfPbrHdr10FrameInput) && (value as GpuPageScene3dGltfPbrHdr10FrameInput).staticFingerprint === current.staticFingerprint && (value as GpuPageScene3dGltfPbrHdr10FrameInput).sdrStaticFingerprint === current.sdrStaticFingerprint && (value as GpuPageScene3dGltfPbrHdr10FrameInput).frameFingerprint === current.frameFingerprint; }
  function hashes(value: GpuPageScene3dGltfPbrHdr10FrameInput): boolean { return [value.staticFingerprint, value.sdrStaticFingerprint, value.frameFingerprint].every((entry) => /^[a-f0-9]{64}$/.test(entry)); }
}
