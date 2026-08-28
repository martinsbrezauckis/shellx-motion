import type { GpuRuntimeFailure } from "./gpu-runtime-types";
import type { GpuPageScene3dGltfPbrResourceMetrics } from "./gpu-page-scene3d-gltf-pbr-resources";

export interface GpuPageScene3dGltfPbrFrameInput {
  readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-frame@1";
  readonly staticFingerprint: string;
  readonly frameFingerprint: string;
}
export type GpuPageScene3dGltfPbrFrameOutput = { readonly ok: true; readonly drawCount: number; readonly metrics: GpuPageScene3dGltfPbrResourceMetrics } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Executes only the exact preprepared material frame; it never allocates a per-frame buffer or texture. */
export async function renderWebGpuPageSessionScene3dGltfPbrFrame(input: GpuPageScene3dGltfPbrFrameInput): Promise<GpuPageScene3dGltfPbrFrameOutput> {
  type BufferFacade = unknown;
  type TextureFacade = { createView(): unknown };
  type Pipeline = unknown;
  type Primitive = { vertex: BufferFacade; index: BufferFacade; bindGroup: unknown; indexCount: number };
  type Resources = { staticFingerprint: string; frameFingerprint: string; renderedFrames: number; metrics: GpuPageScene3dGltfPbrResourceMetrics; target: TextureFacade; depth: TextureFacade; primitives: Primitive[] };
  type Device = { createCommandEncoder(): { beginRenderPass(value: unknown): { setPipeline(value: Pipeline): void; setVertexBuffer(index: number, buffer: BufferFacade): void; setIndexBuffer(buffer: BufferFacade, format: "uint32"): void; setBindGroup(index: number, value: unknown): void; drawIndexed(count: number): void; end(): void }; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } };
  const state = (globalThis as unknown as { __shellxMotionGpuSessionV1?: { device?: Device; gltfPbrPipeline?: Pipeline; gltfPbrResources?: Resources; lost?: boolean } }).__shellxMotionGpuSessionV1;
  const resources = state?.gltfPbrResources;
  if (!state?.device || !state.gltfPbrPipeline || !resources) return fail("gpu_device_unavailable", "The fixed glTF PBR frame has no prepared page resources.");
  if (!input || typeof input !== "object" || !exactKeys(input, ["schema", "staticFingerprint", "frameFingerprint"]) || input.schema !== "shellx-motion/gpu-page-scene3d-gltf-pbr-frame@1" || !hash(input.staticFingerprint) || !hash(input.frameFingerprint) || input.staticFingerprint !== resources.staticFingerprint || input.frameFingerprint !== resources.frameFingerprint) return fail("gpu_resource_refused", "The fixed glTF PBR frame identity does not match its prepared resources.");
  if (state.lost) return fail("gpu_device_lost", "The fixed glTF PBR page device was lost before rendering.");
  try {
    const encoder = state.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: resources.target.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: resources.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    pass.setPipeline(state.gltfPbrPipeline);
    for (const primitive of resources.primitives) { pass.setVertexBuffer(0, primitive.vertex); pass.setIndexBuffer(primitive.index, "uint32"); pass.setBindGroup(0, primitive.bindGroup); pass.drawIndexed(primitive.indexCount); }
    pass.end(); state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone(); resources.renderedFrames += 1;
    return { ok: true, drawCount: resources.primitives.length, metrics: Object.freeze({ ...resources.metrics, renderedFrames: resources.renderedFrames }) };
  } catch { return fail("gpu_render_failed", "The fixed glTF PBR frame failed; its material-only page session must terminal-close."); }

  function fail(code: GpuRuntimeFailure["code"], message: string): GpuPageScene3dGltfPbrFrameOutput { return { ok: false, failure: { code, message } }; }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function exactKeys(value: object, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
}
