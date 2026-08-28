import { createHash } from "node:crypto";
import type { GpuRuntimeEvidence, GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuBrowserDeviceObservation {
  active?: boolean;
  deviceId?: number;
  deviceString?: string;
  driverVendor?: string;
  softwareRendering?: boolean;
  vendorId?: number;
  vendorString?: string;
}

export interface GpuPageObservation {
  adapter: boolean;
  adapterInfo: GpuPageAdapterInfo | null;
  device: boolean;
  gpuApi: boolean;
  limits: GpuRuntimeEvidence["limits"] | null;
  secureContext: boolean;
}

/** Browser-provided identity of the adapter the page actually selected. */
export interface GpuPageAdapterInfo {
  vendor: string;
  device: string;
  architecture: string | null;
  description: string | null;
}

export interface GpuRuntimeObservation {
  browserSource: string;
  devices: GpuBrowserDeviceObservation[];
  featureStatus: string | null;
  page: GpuPageObservation;
}

export type GpuRuntimeAssessment =
  | { ok: true; evidence: GpuRuntimeEvidence }
  | { ok: false; failure: GpuRuntimeFailure };

/**
 * The GPU points lane requires WebGPU in a secure page and an active, non-software
 * Chromium device. A SwiftShader/llvmpipe adapter is an explicit refusal, never
 * a GPU success or browser/CPU fallback.
 */
export function assessGpuRuntime(observation: GpuRuntimeObservation): GpuRuntimeAssessment {
  if (!observation.page.secureContext) return failure("gpu_secure_context_unavailable", "GPU probe did not obtain a secure local context.");
  if (!observation.page.gpuApi) return failure("gpu_api_unavailable", "The selected browser does not expose navigator.gpu.");
  if (!isHardwareWebGpu(observation.featureStatus, observation.devices)) {
    return failure("gpu_hardware_unavailable", "The selected browser did not report hardware-accelerated WebGPU.");
  }
  if (!observation.page.adapter) return failure("gpu_adapter_unavailable", "Hardware WebGPU did not provide an adapter.");
  if (!observation.page.device || !observation.page.limits) return failure("gpu_device_unavailable", "The selected WebGPU adapter did not provide a device.");
  if (!observation.page.adapterInfo) return failure("gpu_adapter_identity_unavailable", "The render-selected WebGPU adapter did not expose a correlatable identity.");
  const selected = selectedHardwareDevice(observation.page.adapterInfo, observation.devices);
  if (!selected) return failure("gpu_adapter_identity_unavailable", "The render-selected WebGPU adapter did not uniquely correlate with a hardware Chromium device.");
  return {
    ok: true,
    evidence: {
      schema: "shellx-motion/gpu-runtime-evidence@1",
      backend: "webgpu-browser",
      browserSource: observation.browserSource,
      webgpuFeatureStatus: observation.featureStatus,
      adapterFingerprint: adapterFingerprint(observation.page.adapterInfo, selected),
      adapter: {
        cdpVendorId: selected.device.vendorId, cdpDeviceId: selected.device.deviceId,
        cdpVendor: selected.cdpVendor, cdpDevice: selected.device.deviceString,
        vendor: observation.page.adapterInfo.vendor, device: observation.page.adapterInfo.device,
        architecture: observation.page.adapterInfo.architecture, description: observation.page.adapterInfo.description
      },
      limits: observation.page.limits
    }
  };
}

interface SelectedHardwareDevice {
  cdpVendor: string;
  device: GpuBrowserDeviceObservation & Required<Pick<GpuBrowserDeviceObservation, "vendorId" | "deviceId" | "deviceString">>;
}

function selectedHardwareDevice(info: GpuPageAdapterInfo, devices: GpuBrowserDeviceObservation[]): SelectedHardwareDevice | undefined {
  if (!hasIdentifiablePageAdapterInfo(info)) return undefined;
  const pageVendor = normalizedIdentity(info.vendor);
  const pageDevice = normalizedIdentity(info.device);
  const matching = devices.flatMap((device): SelectedHardwareDevice[] => {
    if (!hasStableIdentity(device)) return [];
    const cdpVendor = effectiveCdpVendorLabel(pageVendor, device);
    if (!cdpVendor || !identityOverlaps(pageVendor, normalizedIdentity(cdpVendor))) return [];
    if (pageDevice && !identityOverlaps(pageDevice, normalizedIdentity(device.deviceString))) return [];
    return [{ cdpVendor, device }];
  });
  return matching.length === 1 ? matching[0] : undefined;
}

function hasIdentifiablePageAdapterInfo(info: GpuPageAdapterInfo): boolean {
  return nonEmptyText(info.vendor) && [info.device, info.architecture, info.description].some(nonEmptyText);
}

function hasStableIdentity(device: GpuBrowserDeviceObservation): device is GpuBrowserDeviceObservation & Required<Pick<GpuBrowserDeviceObservation, "vendorId" | "deviceId" | "deviceString">> {
  return isHardwareIdentifier(device.vendorId) && isHardwareIdentifier(device.deviceId)
    && nonEmptyText(device.deviceString) && isHardwareDevice(device);
}

function effectiveCdpVendorLabel(pageVendor: string, device: GpuBrowserDeviceObservation): string | undefined {
  if (nonEmptyText(device.vendorString)) return device.vendorString;
  if (nonEmptyText(device.driverVendor)) return device.driverVendor;
  // A device label is only a vendor label when it independently contains the
  // page-reported vendor. Never infer a vendor from an arbitrary GPU name.
  if (nonEmptyText(device.deviceString) && identityOverlaps(pageVendor, normalizedIdentity(device.deviceString))) return device.deviceString;
  return undefined;
}

function identityOverlaps(left: string, right: string): boolean {
  return left.length >= 3 && right.length >= 3 && (left.includes(right) || right.includes(left));
}

function normalizedIdentity(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function nonEmptyText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function isHardwareWebGpu(featureStatus: string | null, devices: GpuBrowserDeviceObservation[]): boolean {
  if (featureStatus !== "enabled" && featureStatus !== "enabled_on" && featureStatus !== "enabled_readback") return false;
  return devices.some(isHardwareDevice);
}

function isHardwareDevice(device: GpuBrowserDeviceObservation): boolean {
  if (device.active === false || isSoftwareDevice(device)) return false;
  return isHardwareIdentifier(device.vendorId) && isHardwareIdentifier(device.deviceId);
}

function isHardwareIdentifier(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value > 0 && value < 0xffff;
}

function isSoftwareDevice(device: GpuBrowserDeviceObservation): boolean {
  if (device.softwareRendering === true) return true;
  return /swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i.test(`${device.vendorString ?? ""} ${device.driverVendor ?? ""} ${device.deviceString ?? ""}`);
}

function adapterFingerprint(page: GpuPageAdapterInfo, selected: SelectedHardwareDevice): string {
  return createHash("sha256").update(JSON.stringify({
    page,
    cdp: {
      vendorId: selected.device.vendorId,
      deviceId: selected.device.deviceId,
      vendor: selected.cdpVendor,
      device: selected.device.deviceString
    }
  })).digest("hex");
}

function failure(code: GpuRuntimeFailure["code"], message: string): GpuRuntimeAssessment {
  return { ok: false, failure: { code, message } };
}
