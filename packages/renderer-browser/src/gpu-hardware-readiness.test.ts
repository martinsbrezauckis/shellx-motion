import { describe, expect, it, vi } from "vitest";
import { GPU_ACTIVE_HOST_PROOF_SCHEMA, assessGpuHardwareReadiness, type GpuActiveHostProof } from "./gpu-hardware-readiness";

const now = () => new Date("2026-08-13T12:00:00.000Z");
const sha = "a".repeat(64);

function chromium(status: "ready" | "missing" | "broken" | "unverified" = "ready") {
  return { status, source: "path" as const, version: "Chromium 140.0.0.0" };
}

function activeProof(platform: "linux" | "darwin" | "win32" = "linux"): GpuActiveHostProof {
  const hardwareArgs = platform === "linux"
    ? ["--enable-gpu", "--force-high-performance-gpu", "--use-webgpu-power-preference=default-high-performance", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface"]
    : ["--enable-gpu", "--force-high-performance-gpu", "--use-webgpu-power-preference=default-high-performance"];
  return {
    schema: GPU_ACTIVE_HOST_PROOF_SCHEMA,
    capturedAt: "2026-08-13T11:55:00.000Z",
    validForMs: 600_000,
    platform,
    browser: { source: "path", executableSha256: sha, version: "Chromium 140.0.0.0" },
    launch: {
      hardwareArgs,
      chromiumSandbox: true,
      ignoredDefaultArgs: ["--enable-unsafe-swiftshader"],
      finalContainment: "precontained-direct-chromium"
    },
    runtime: {
      schema: "shellx-motion/gpu-runtime-evidence@1",
      backend: "webgpu-browser",
      browserSource: "path",
      webgpuFeatureStatus: "enabled",
      adapterFingerprint: "b".repeat(64),
      adapter: {
        cdpVendorId: 4318, cdpDeviceId: 11266, cdpVendor: "NVIDIA", cdpDevice: "NVIDIA GeForce RTX 5080",
        vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080", architecture: null, description: "NVIDIA GeForce RTX 5080"
      },
      limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
    },
    receipt: { operation: "gpu.hardware.probe", lane: "gpu", status: "passed" }
  };
}

describe("GPU hardware readiness", () => {
  it("does not resolve, hash, or launch a browser during a normal source-only doctor assessment", async () => {
    const resolveBrowser = vi.fn();
    const hashExecutable = vi.fn();
    const result = await assessGpuHardwareReadiness({ chromium: chromium(), platform: "linux", now, resolveBrowser, hashExecutable });

    expect(result).toMatchObject({
      status: "requires-hardware-proof",
      trustedChromium: { status: "present", version: "Chromium 140.0.0.0" },
      adapterDeviceProof: { status: "not-tested", requiredCommand: "host-owned motion.platform.gpu.probe" },
      fixedLaunchProfile: { chromiumSandbox: true, finalContainment: "precontained-direct-chromium" },
      sandbox: { browser: "required", gpu: "no-disable-flags-in-motion-profile" },
      audio: { gpuRaster: "none", finalVideo: "ffmpeg" },
      refusals: [{ code: "gpu_hardware_proof_required" }]
    });
    expect(resolveBrowser).not.toHaveBeenCalled();
    expect(hashExecutable).not.toHaveBeenCalled();
  });

  it("distinguishes a missing Chromium identity from a missing hardware proof", async () => {
    const result = await assessGpuHardwareReadiness({ chromium: chromium("missing"), platform: "linux", now });
    expect(result).toMatchObject({
      status: "requires-hardware-proof",
      trustedChromium: { status: "missing" },
      adapterDeviceProof: { status: "not-tested" },
      refusals: [{ code: "gpu_trusted_chromium_missing" }]
    });
  });

  it("refuses platforms without final GPU containment before touching browser state", async () => {
    const resolveBrowser = vi.fn();
    const result = await assessGpuHardwareReadiness({ chromium: chromium(), platform: "aix", now, resolveBrowser });
    expect(result).toMatchObject({ status: "unsupported", platform: { id: "aix", supported: false }, refusals: [{ code: "gpu_platform_unsupported" }] });
    expect(resolveBrowser).not.toHaveBeenCalled();
  });

  it("does not let an old GPU preview receipt stand in for live adapter/device proof", async () => {
    const result = await assessGpuHardwareReadiness({
      chromium: chromium(), platform: "linux", now,
      activeHostProof: { operation: "preview.gpu.frame", lane: "gpu", status: "passed" }
    });
    expect(result).toMatchObject({
      status: "requires-hardware-proof",
      adapterDeviceProof: { status: "not-tested" },
      refusals: [{ code: "gpu_prior_receipt_not_live_proof" }]
    });
  });

  it("accepts only a fresh proof bound to the current browser hash, version, platform, profile and adapter correlation", async () => {
    const proof = activeProof();
    const result = await assessGpuHardwareReadiness({
      chromium: chromium(), platform: "linux", now, activeHostProof: proof,
      resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => sha
    });
    expect(result).toMatchObject({
      status: "available",
      adapterDeviceProof: {
        status: "active-host-proof",
        capturedAt: proof.capturedAt,
        adapterFingerprint: proof.runtime.adapterFingerprint
      },
      audio: { gpuRaster: "none", finalVideo: "ffmpeg" }
    });
  });

  it("accepts the exact protocol version from an active browser when the platform identity adds a Chromium label", async () => {
    const proof = activeProof();
    proof.browser.version = "140.0.0.0";
    await expect(assessGpuHardwareReadiness({
      chromium: chromium(), platform: "linux", now, activeHostProof: proof,
      resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => sha
    })).resolves.toMatchObject({ status: "available", adapterDeviceProof: { status: "active-host-proof" } });
  });

  it("rejects stale or browser-mismatched active evidence rather than reporting available", async () => {
    const stale = { ...activeProof(), capturedAt: "2026-08-13T11:00:00.000Z" };
    await expect(assessGpuHardwareReadiness({ chromium: chromium(), platform: "linux", now, activeHostProof: stale }))
      .resolves.toMatchObject({ status: "requires-hardware-proof", refusals: [{ code: "gpu_active_proof_stale" }] });

    await expect(assessGpuHardwareReadiness({
      chromium: chromium(), platform: "linux", now, activeHostProof: activeProof(),
      resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => "c".repeat(64)
    })).resolves.toMatchObject({ status: "requires-hardware-proof", refusals: [{ code: "gpu_active_proof_browser_changed" }] });
  });

  it("accepts privacy-reduced Windows adapter identity only through the validated runtime-evidence contract", async () => {
    const proof = activeProof("win32");
    proof.runtime.adapter = {
      ...proof.runtime.adapter,
      vendor: "nvidia",
      device: "",
      architecture: "blackwell",
      description: null
    };
    await expect(assessGpuHardwareReadiness({
      chromium: chromium(), platform: "win32", now, activeHostProof: proof,
      resolveBrowser: () => ({ executable: "C:\\trusted\\chrome.exe", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => sha
    })).resolves.toMatchObject({ status: "available", adapterDeviceProof: { status: "active-host-proof" } });
  });
});
