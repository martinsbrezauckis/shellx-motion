import type { GpuPageSessionOpenOutput } from "./gpu-page-session-types";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";

/** Opens only the fixed PBR page state; it does not install or mutate the legacy page catalog. */
export async function openWebGpuPageSessionScene3dGltfPbr(options: { powerPreference: "high-performance" }): Promise<GpuPageSessionOpenOutput> {
  type Device = { destroy?(): void; limits?: { maxTextureDimension2D?: number; maxBufferSize?: number; maxStorageBufferBindingSize?: number }; lost?: Promise<unknown> };
  const browserGlobal = globalThis as unknown as { isSecureContext?: boolean; navigator?: { gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } }; __shellxMotionGpuSessionV1?: unknown };
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageSessionOpenOutput => ({ ok: false, failure: { code, message } });
  if (browserGlobal.__shellxMotionGpuSessionV1) return fail("gpu_render_failed", "A GPU page session is already open.");
  const gpu = browserGlobal.navigator?.gpu; if (!gpu) return fail("gpu_api_unavailable", "WebGPU is unavailable in the isolated PBR page.");
  const adapter = await gpu.requestAdapter(options) ?? await gpu.requestAdapter(options);
  if (!adapter || typeof adapter !== "object") return fail("gpu_adapter_unavailable", "WebGPU did not provide an isolated PBR adapter.");
  try {
    const rawInfo = (adapter as { info?: unknown; requestAdapterInfo?(): Promise<unknown> }).info ?? await (adapter as { requestAdapterInfo?(): Promise<unknown> }).requestAdapterInfo?.();
    const info = rawInfo && typeof rawInfo === "object" ? rawInfo as Record<string, unknown> : undefined;
    const vendor = typeof info?.vendor === "string" ? info.vendor : "", deviceName = typeof info?.device === "string" ? info.device : "";
    const architecture = typeof info?.architecture === "string" && info.architecture.trim() ? info.architecture : null, description = typeof info?.description === "string" && info.description.trim() ? info.description : null;
    if (!vendor.trim() || (!deviceName.trim() && !architecture && !description)) return fail("gpu_adapter_identity_unavailable", "The isolated PBR adapter did not expose a correlatable identity.");
    const requestDevice = (adapter as { requestDevice?(): Promise<unknown> }).requestDevice, device = requestDevice ? await requestDevice.call(adapter).catch(() => null) : null;
    if (!device || typeof device !== "object") return fail("gpu_device_unavailable", "WebGPU did not provide an isolated PBR device.");
    const persistent = device as Device, maxTextureDimension2D = persistent.limits?.maxTextureDimension2D, maxBufferSize = persistent.limits?.maxBufferSize, maxStorageBufferBindingSize = persistent.limits?.maxStorageBufferBindingSize;
    if (![maxTextureDimension2D, maxBufferSize, maxStorageBufferBindingSize].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) { persistent.destroy?.(); return fail("gpu_limits_exceeded", "The isolated PBR device did not expose bounded integer limits."); }
    const state = { device: persistent, limits: { maxTextureDimension2D: maxTextureDimension2D as number, maxBufferSize: maxBufferSize as number, maxStorageBufferBindingSize: maxStorageBufferBindingSize as number }, lost: false };
    persistent.lost?.then(() => { state.lost = true; }).catch(() => { state.lost = true; }); browserGlobal.__shellxMotionGpuSessionV1 = state;
    return { ok: true, runtime: { secureContext: browserGlobal.isSecureContext === true, gpuApi: true, adapter: true, adapterInfo: { vendor, device: deviceName, architecture, description }, device: true, limits: state.limits } };
  } catch { return fail("gpu_render_failed", "The isolated PBR page could not initialize its fixed WebGPU device."); }
}

/** Final isolated PBR page cleanup. Successful routes release the exact PBR resources first. */
export function closeWebGpuPageSessionScene3dGltfPbr(): { readonly deviceDestroyed: boolean; readonly forcedResourceRelease: boolean } {
  type Resource = { textures?: Array<{ destroy?(): void }>; primitives?: Array<{ vertex?: { destroy?(): void }; index?: { destroy?(): void }; uniform?: { destroy?(): void } }>; target?: { destroy?(): void }; depth?: { destroy?(): void } };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: { device?: { destroy?(): void }; gltfPbrResources?: Resource; gltfPbrStreamingReadback?: { buffer?: { destroy?(): void } } } };
  const state = browserGlobal.__shellxMotionGpuSessionV1; delete browserGlobal.__shellxMotionGpuSessionV1;
  let forcedResourceRelease = false, deviceDestroyed = false;
  try { const resources = state?.gltfPbrResources; if (resources) { forcedResourceRelease = true; for (const texture of resources.textures ?? []) texture.destroy?.(); for (const primitive of resources.primitives ?? []) { primitive.vertex?.destroy?.(); primitive.index?.destroy?.(); primitive.uniform?.destroy?.(); } resources.target?.destroy?.(); resources.depth?.destroy?.(); } if (state?.gltfPbrStreamingReadback) { forcedResourceRelease = true; state.gltfPbrStreamingReadback.buffer?.destroy?.(); } state?.device?.destroy?.(); deviceDestroyed = !!state?.device; } catch { /* outer Browser close is the final containment boundary */ }
  return { deviceDestroyed, forcedResourceRelease };
}
