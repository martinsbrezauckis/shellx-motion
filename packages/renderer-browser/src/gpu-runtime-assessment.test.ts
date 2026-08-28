import { describe, expect, it } from "vitest";
import { assessGpuRuntime } from "./gpu-runtime-assessment";

const page = {
  secureContext: true, gpuApi: true, adapter: true, device: true,
  adapterInfo: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080", architecture: null, description: "NVIDIA GeForce RTX 5080" },
  limits: { maxTextureDimension2D: 8192, maxBufferSize: 1024 * 1024, maxStorageBufferBindingSize: 1024 * 1024 }
};
const selectedDevice = { active: true, softwareRendering: false, vendorId: 4318, deviceId: 11266, vendorString: "NVIDIA", deviceString: "NVIDIA GeForce RTX 5080" };

describe("assessGpuRuntime", () => {
  it("refuses software WebGPU even when a page exposes an adapter", () => {
    const result = assessGpuRuntime({ browserSource: "path", featureStatus: "unavailable_software", page, devices: [{ active: true, softwareRendering: true, deviceString: "SwiftShader" }] });
    expect(result).toEqual({ ok: false, failure: { code: "gpu_hardware_unavailable", message: "The selected browser did not report hardware-accelerated WebGPU." } });
  });

  it("binds receipt evidence to the exact render-selected hardware adapter", () => {
    const result = assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page, devices: [selectedDevice] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({
      backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      adapter: { cdpVendorId: 4318, cdpDeviceId: 11266, vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080" },
      limits: page.limits
    });
  });

  it("correlates privacy-reduced Windows page identity to the one hardware adapter", () => {
    const windowsPage = {
      ...page,
      adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }
    };
    const rtx5080 = {
      active: true,
      softwareRendering: false,
      vendorId: 4318,
      deviceId: 11266,
      vendorString: "",
      deviceString: "NVIDIA GeForce RTX 5080",
      driverVendor: "NVIDIA"
    };
    const basicRenderer = {
      active: true,
      softwareRendering: false,
      vendorId: 5140,
      deviceId: 140,
      vendorString: "",
      deviceString: "Microsoft Basic Render Driver",
      driverVendor: "Microsoft"
    };
    const result = assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page: windowsPage, devices: [rtx5080, basicRenderer] });
    expect(result).toMatchObject({
      ok: true,
      evidence: { adapter: { cdpVendorId: 4318, cdpDeviceId: 11266, cdpVendor: "NVIDIA", cdpDevice: "NVIDIA GeForce RTX 5080", vendor: "nvidia", device: "" } }
    });
  });

  it("refuses privacy-reduced vendor-only identity when same-vendor hardware is ambiguous", () => {
    const windowsPage = {
      ...page,
      adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }
    };
    const first = { active: true, softwareRendering: false, vendorId: 4318, deviceId: 11266, vendorString: "", deviceString: "NVIDIA GeForce RTX 5080", driverVendor: "NVIDIA" };
    const second = { ...first, deviceId: 11267, deviceString: "NVIDIA GeForce RTX 5090" };
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page: windowsPage, devices: [first, second] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_adapter_identity_unavailable" } });
  });

  it("refuses unrelated or ambiguous inventory rather than fingerprinting all devices", () => {
    const unrelated = { ...selectedDevice, deviceId: 9999, deviceString: "NVIDIA GeForce RTX 5090" };
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page, devices: [unrelated] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_adapter_identity_unavailable" } });
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page, devices: [selectedDevice, { ...selectedDevice, deviceId: 11267 }] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_adapter_identity_unavailable" } });
  });

  it("refuses absent page identity, reserved software identifiers, and inactive devices", () => {
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page: { ...page, adapterInfo: null }, devices: [selectedDevice] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_adapter_identity_unavailable" } });
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page, devices: [{ vendorId: 65535, deviceId: 65535, deviceString: "SwiftShader Device" }] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_hardware_unavailable" } });
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page, devices: [{ ...selectedDevice, active: false }] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_hardware_unavailable" } });
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page: { ...page, adapterInfo: { vendor: "", device: "", architecture: null, description: null } }, devices: [selectedDevice] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_adapter_identity_unavailable" } });
    expect(assessGpuRuntime({ browserSource: "path", featureStatus: "enabled", page, devices: [{ active: true, softwareRendering: false, vendorId: 5140, deviceId: 140, deviceString: "Microsoft Basic Render Driver", driverVendor: "Microsoft" }] }))
      .toMatchObject({ ok: false, failure: { code: "gpu_hardware_unavailable" } });
  });
});
