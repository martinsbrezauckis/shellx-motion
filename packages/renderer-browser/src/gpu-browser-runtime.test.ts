import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  GPU_ADAPTER_REQUEST_OPTIONS,
  GPU_BROWSER_HARDWARE_ARGS,
  GPU_LOOPBACK_CONTENT_SECURITY_POLICY,
  gpuBrowserHardwareArgs,
  probeWebGpuPage
} from "./gpu-browser-runtime";
import {
  GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE,
  GPU_BROWSER_SANDBOX,
  browserServerProcessPid,
  createGpuBrowserSessionIdentity,
  sameGpuBrowserExecutableSha256
} from "./gpu-browser-session-identity";

describe("GPU browser hardware launch contract", () => {
  const sharedArgs = [
    "--enable-gpu",
    "--force-high-performance-gpu",
    "--use-webgpu-power-preference=default-high-performance"
  ];
  const forbiddenArgs = [
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--disable-dawn-features=adapter_blocklist"
  ];

  it("uses Windows' D3D-backed hardware profile without Linux Vulkan forcing", () => {
    const args = gpuBrowserHardwareArgs("win32");
    expect(args).toEqual(sharedArgs);
    expect(args).not.toContain("--use-angle=vulkan");
    expect(args).not.toContain("--enable-features=Vulkan");
    expect(args).not.toContain("--disable-vulkan-surface");
    for (const forbidden of forbiddenArgs) expect(args).not.toContain(forbidden);
  });

  it("keeps the explicit Vulkan hardware profile on Linux", () => {
    const args = gpuBrowserHardwareArgs("linux");
    expect(args).toEqual([
      "--enable-gpu",
      "--force-high-performance-gpu",
      "--use-webgpu-power-preference=default-high-performance",
      "--use-angle=vulkan",
      "--enable-features=Vulkan",
      "--disable-vulkan-surface"
    ]);
    for (const forbidden of forbiddenArgs) expect(args).not.toContain(forbidden);
  });

  it("exposes the selected platform profile without unsafe or sandbox-disabling flags", () => {
    expect(GPU_BROWSER_HARDWARE_ARGS).toEqual(gpuBrowserHardwareArgs());
    expect(GPU_BROWSER_SANDBOX).toBe(true);
    expect(GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE).toEqual(["--enable-unsafe-swiftshader"]);
    expect(GPU_ADAPTER_REQUEST_OPTIONS).toEqual({ powerPreference: "high-performance" });
    for (const forbidden of forbiddenArgs) expect(GPU_BROWSER_HARDWARE_ARGS).not.toContain(forbidden);
  });

  it("permits only page-owned Blob images beyond the deny-all loopback policy", () => {
    expect(GPU_LOOPBACK_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; img-src blob:");
    expect(GPU_LOOPBACK_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|data:|script-src|frame-src|connect-src/);
  });
});

describe("GPU BrowserServer process ownership", () => {
  it("accepts only a concrete non-sentinel BrowserServer root PID", () => {
    expect(browserServerProcessPid({ pid: 4_242 } as never)).toBe(4_242);
    expect(browserServerProcessPid({ pid: 1 } as never)).toBeNull();
    expect(browserServerProcessPid({ pid: 0 } as never)).toBeNull();
    expect(browserServerProcessPid({ pid: undefined } as never)).toBeNull();
    expect(browserServerProcessPid(null)).toBeNull();
  });
});

describe("GPU browser session identity", () => {
  it("binds qualification evidence to CDP product/page facts and the pre-launch executable hash", () => {
    expect(createGpuBrowserSessionIdentity({
      source: "path",
      executableSha256: "a".repeat(64),
      version: "149.0.7827.55",
      product: "Chrome/149.0.7827.55",
      userAgent: "Mozilla/5.0 test"
    })).toEqual({
      name: "Chrome",
      version: "149.0.7827.55",
      userAgent: "Mozilla/5.0 test",
      executableSha256: "a".repeat(64),
      source: "path",
      args: GPU_BROWSER_HARDWARE_ARGS,
      ignoredDefaultArgs: ["--enable-unsafe-swiftshader"],
      sandbox: { enabled: true, status: "enabled" }
    });
  });

  it("refuses incomplete browser identity facts rather than synthesizing a release claim", () => {
    expect(createGpuBrowserSessionIdentity({ source: "path", executableSha256: "not-a-hash", version: "149", product: "Chrome/149", userAgent: "agent" })).toBeNull();
    expect(createGpuBrowserSessionIdentity({ source: "path", executableSha256: "a".repeat(64), version: "149", product: "", userAgent: "agent" })).toBeNull();
    expect(createGpuBrowserSessionIdentity({ source: "path", executableSha256: "a".repeat(64), version: "149", product: "Chrome/149", userAgent: "" })).toBeNull();
  });

  it("requires the post-session executable hash to equal the admitted launch hash", () => {
    expect(sameGpuBrowserExecutableSha256("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(sameGpuBrowserExecutableSha256("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(sameGpuBrowserExecutableSha256("not-a-hash", "not-a-hash")).toBe(false);
  });
});

describe("probeWebGpuPage", () => {
  it("runs as an isolated serialized page function", async () => {
    const destroy = vi.fn();
    const prototypeLimits = { maxBufferSize: 1_048_576 };
    const exoticLimits = Object.create(prototypeLimits) as Record<string, unknown>;
    Object.defineProperties(exoticLimits, {
      maxTextureDimension2D: { enumerable: false, get: () => 8_192 },
      maxStorageBufferBindingSize: { enumerable: false, get: () => 1_048_576 }
    });
    const serializedSource = probeWebGpuPage.toString();
    expect(serializedSource).not.toContain("__name");
    const serializedProbe = runInNewContext(`(${serializedSource})`, {
      isSecureContext: true,
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: "nvidia", device: "", architecture: "blackwell", description: "" },
            requestDevice: async () => ({ destroy, limits: exoticLimits })
          })
        }
      }
    }) as typeof probeWebGpuPage;

    await expect(serializedProbe(GPU_ADAPTER_REQUEST_OPTIONS)).resolves.toEqual({
      secureContext: true,
      gpuApi: true,
      adapter: true,
      adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null },
      device: true,
      limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("snapshots limits and destroys its temporary probe device", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    const destroy = vi.fn();
    const requestAdapter = vi.fn(async () => ({
      info: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080", architecture: "Ada", description: "RTX 5080" },
      requestDevice: vi.fn(async () => ({
        destroy,
        limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
      }))
    }));
    try {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          gpu: {
            requestAdapter
          }
        }
      });
      await expect(probeWebGpuPage(GPU_ADAPTER_REQUEST_OPTIONS)).resolves.toEqual({
        secureContext: true,
        gpuApi: true,
        adapter: true,
        adapterInfo: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080", architecture: "Ada", description: "RTX 5080" },
        device: true,
        limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
      });
      expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      restoreGlobal("navigator", navigatorDescriptor);
      restoreGlobal("isSecureContext", secureContextDescriptor);
    }
  });

  it("destroys its probe device on an invalid-limit return path", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    const destroy = vi.fn();
    try {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { gpu: { requestAdapter: vi.fn(async () => ({ info: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080" }, requestDevice: vi.fn(async () => ({ destroy, limits: {} })) })) } }
      });
      await expect(probeWebGpuPage(GPU_ADAPTER_REQUEST_OPTIONS)).resolves.toMatchObject({ secureContext: true, gpuApi: true, adapter: true, device: false, limits: null });
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      restoreGlobal("navigator", navigatorDescriptor);
      restoreGlobal("isSecureContext", secureContextDescriptor);
    }
  });

  it("retains a privacy-reduced adapter identity when architecture identifies the page adapter", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    try {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { gpu: { requestAdapter: vi.fn(async () => ({ info: { vendor: "nvidia", device: "", architecture: "blackwell", description: "" }, requestDevice: vi.fn(async () => ({ destroy: vi.fn(), limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } })) })) } }
      });
      await expect(probeWebGpuPage(GPU_ADAPTER_REQUEST_OPTIONS)).resolves.toMatchObject({
        adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null },
        device: true
      });
    } finally {
      restoreGlobal("navigator", navigatorDescriptor);
      restoreGlobal("isSecureContext", secureContextDescriptor);
    }
  });

  it("refuses page adapter info with no identifying detail beyond its vendor", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    try {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { gpu: { requestAdapter: vi.fn(async () => ({ info: { vendor: "nvidia", device: "", architecture: "", description: "" }, requestDevice: vi.fn(async () => ({ destroy: vi.fn(), limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } })) })) } }
      });
      await expect(probeWebGpuPage(GPU_ADAPTER_REQUEST_OPTIONS)).resolves.toMatchObject({ adapterInfo: null, device: true });
    } finally {
      restoreGlobal("navigator", navigatorDescriptor);
      restoreGlobal("isSecureContext", secureContextDescriptor);
    }
  });

  it("copies exotic supported limits into enumerable page-result data", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    const prototypeLimits = { maxBufferSize: 1_048_576 };
    const exoticLimits = Object.create(prototypeLimits) as Record<string, unknown>;
    Object.defineProperties(exoticLimits, {
      maxTextureDimension2D: { enumerable: false, get: () => 8_192 },
      maxStorageBufferBindingSize: { enumerable: false, get: () => 1_048_576 }
    });
    const destroy = vi.fn();
    try {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { gpu: { requestAdapter: vi.fn(async () => ({ info: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080" }, requestDevice: vi.fn(async () => ({ destroy, limits: exoticLimits })) })) } }
      });
      const result = await probeWebGpuPage(GPU_ADAPTER_REQUEST_OPTIONS);
      expect(result).toMatchObject({ device: true, limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } });
      expect(result.limits).not.toBe(exoticLimits);
      expect(Object.keys(result.limits ?? {})).toEqual(["maxTextureDimension2D", "maxBufferSize", "maxStorageBufferBindingSize"]);
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      restoreGlobal("navigator", navigatorDescriptor);
      restoreGlobal("isSecureContext", secureContextDescriptor);
    }
  });

  it("retries one null initialization result with the same hardware preference", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    const requestAdapter = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ info: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080" }, requestDevice: vi.fn(async () => ({ destroy: vi.fn(), limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } })) });
    try {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: { requestAdapter } } });
      await expect(probeWebGpuPage(GPU_ADAPTER_REQUEST_OPTIONS)).resolves.toMatchObject({ adapter: true, device: true });
      expect(requestAdapter).toHaveBeenNthCalledWith(1, GPU_ADAPTER_REQUEST_OPTIONS);
      expect(requestAdapter).toHaveBeenNthCalledWith(2, GPU_ADAPTER_REQUEST_OPTIONS);
    } finally {
      restoreGlobal("navigator", navigatorDescriptor);
      restoreGlobal("isSecureContext", secureContextDescriptor);
    }
  });
});

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
