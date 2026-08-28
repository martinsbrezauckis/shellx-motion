import type { GpuPageSessionOpenOutput } from "./gpu-page-session-types";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";

/** Opens a wholly separate page-global state so SDR PBR/global sessions cannot share HDR resources. */
export async function openWebGpuPageSessionScene3dGltfPbrHdr10(options: { powerPreference: "high-performance" }): Promise<GpuPageSessionOpenOutput> {
  type Device = { destroy?(): void; limits?: { maxTextureDimension2D?: number; maxBufferSize?: number; maxStorageBufferBindingSize?: number }; lost?: Promise<unknown> };
  const global = globalThis as unknown as { isSecureContext?: boolean; navigator?: { gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } }; __shellxMotionGpuHdr10PbrSessionV1?: unknown };
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageSessionOpenOutput => ({ ok: false, failure: { code, message } });
  if (global.__shellxMotionGpuHdr10PbrSessionV1) return fail("gpu_render_failed", "An HDR10 PBR page session is already open.");
  const gpu = global.navigator?.gpu; if (!gpu) return fail("gpu_api_unavailable", "WebGPU is unavailable for the isolated HDR10 PBR page.");
  const adapter = await gpu.requestAdapter(options) ?? await gpu.requestAdapter(options);
  if (!adapter || typeof adapter !== "object") return fail("gpu_adapter_unavailable", "WebGPU did not provide an HDR10 PBR adapter.");
  try {
    const raw = (adapter as { info?: unknown; requestAdapterInfo?(): Promise<unknown> }).info ?? await (adapter as { requestAdapterInfo?(): Promise<unknown> }).requestAdapterInfo?.();
    const info = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined, vendor = typeof info?.vendor === "string" ? info.vendor : "", deviceName = typeof info?.device === "string" ? info.device : "";
    const architecture = typeof info?.architecture === "string" && info.architecture.trim() ? info.architecture : null, description = typeof info?.description === "string" && info.description.trim() ? info.description : null;
    if (!vendor.trim() || (!deviceName.trim() && !architecture && !description)) return fail("gpu_adapter_identity_unavailable", "The HDR10 PBR adapter did not expose a correlatable identity.");
    const requestDevice = (adapter as { requestDevice?(): Promise<unknown> }).requestDevice, device = requestDevice ? await requestDevice.call(adapter).catch(() => null) : null;
    if (!device || typeof device !== "object") return fail("gpu_device_unavailable", "WebGPU did not provide an HDR10 PBR device.");
    const persistent = device as Device, limits = persistent.limits;
    if (![limits?.maxTextureDimension2D, limits?.maxBufferSize, limits?.maxStorageBufferBindingSize].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) { persistent.destroy?.(); return fail("gpu_limits_exceeded", "The HDR10 PBR device did not expose bounded integer limits."); }
    const state = { device: persistent, limits: { maxTextureDimension2D: limits!.maxTextureDimension2D!, maxBufferSize: limits!.maxBufferSize!, maxStorageBufferBindingSize: limits!.maxStorageBufferBindingSize! }, lost: false };
    persistent.lost?.then(() => { state.lost = true; }).catch(() => { state.lost = true; }); global.__shellxMotionGpuHdr10PbrSessionV1 = state;
    return { ok: true, runtime: { secureContext: global.isSecureContext === true, gpuApi: true, adapter: true, adapterInfo: { vendor, device: deviceName, architecture, description }, device: true, limits: state.limits } };
  } catch { return fail("gpu_render_failed", "The HDR10 PBR page could not initialize its fixed WebGPU device."); }
}

/** Final containment boundary; no success path claims cleanup until this destroys resources and device. */
export function closeWebGpuPageSessionScene3dGltfPbrHdr10(): { readonly deviceDestroyed: boolean; readonly forcedResourceRelease: boolean } {
  type Resource = { textures?: Array<{ destroy?(): void }>; primitives?: Array<{ vertex?: { destroy?(): void }; index?: { destroy?(): void }; uniform?: { destroy?(): void } }>; target?: { destroy?(): void }; depth?: { destroy?(): void } };
  const global = globalThis as unknown as { __shellxMotionGpuHdr10PbrSessionV1?: { device?: { destroy?(): void }; resources?: Resource } }, state = global.__shellxMotionGpuHdr10PbrSessionV1; delete global.__shellxMotionGpuHdr10PbrSessionV1;
  let forcedResourceRelease = false, deviceDestroyed = false;
  try { const resources = state?.resources; if (resources) { forcedResourceRelease = true; for (const texture of resources.textures ?? []) texture.destroy?.(); for (const primitive of resources.primitives ?? []) { primitive.vertex?.destroy?.(); primitive.index?.destroy?.(); primitive.uniform?.destroy?.(); } resources.target?.destroy?.(); resources.depth?.destroy?.(); } state?.device?.destroy?.(); deviceDestroyed = !!state?.device; } catch { /* terminal outer close remains the only containment boundary */ }
  return { deviceDestroyed, forcedResourceRelease };
}
