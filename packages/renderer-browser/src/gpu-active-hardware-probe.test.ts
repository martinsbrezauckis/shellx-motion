import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assessGpuHardwareReadiness } from "./gpu-hardware-readiness";
import { runGpuActiveHardwareProbe } from "./gpu-active-hardware-probe";
import { gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
import type { GpuBrowserProcess } from "./gpu-browser-process";

const executableSha256 = "a".repeat(64);
const frameSha256 = createHash("sha256").update(probeReadback()).digest("hex");
const adapterFingerprint = "c".repeat(64);

describe("runGpuActiveHardwareProbe", () => {
  it("uses the pre-contained final route and emits only after an actual bounded frame readback", async () => {
    let closed = 0;
    let received: unknown;
    const result = await runGpuActiveHardwareProbe(probeOptions(), {
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => executableSha256,
      openFrameSession: async (input) => {
        received = input;
        return {
          ok: true,
          session: {
            browserVersion: "Chromium 140.0.0.0",
            browserProcess: {
              pid: 42,
              launcher: "precontained-direct-chromium",
              containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 }
            },
            uploadImages: async () => ({ ok: true, uploaded: 0 }),
            render: async () => ({
              ok: true,
              frame: {
                width: 4,
                height: 4,
                rgba: probeReadback(),
                sha256: frameSha256,
                evidence: runtimeEvidence()
              }
            }),
            close: async () => { closed += 1; }
          }
        };
      }
    });

    expect(result).toMatchObject({
      ok: true,
      proof: {
        capturedAt: "2026-08-13T12:00:00.000Z",
        browser: { source: "path", executableSha256, version: "Chromium 140.0.0.0" },
        launch: { hardwareArgs: gpuBrowserHardwareArgs(), chromiumSandbox: true, ignoredDefaultArgs: ["--enable-unsafe-swiftshader"], finalContainment: "precontained-direct-chromium" },
        receipt: { operation: "gpu.hardware.probe", lane: "gpu", status: "passed" },
        runtime: { adapterFingerprint }
      },
      frame: { width: 4, height: 4, sha256: frameSha256 }
    });
    expect(received).toMatchObject({
      finalBrowser: { scratchRoot: "/host-owned/private-probe-scratch", maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 },
      browserLocation: { executable: "/trusted/chromium", source: "path" }
    });
    expect(closed).toBe(1);
  });

  it("fails closed when the frame path does not produce the full readback", async () => {
    const result = await runGpuActiveHardwareProbe(probeOptions(), {
      resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => executableSha256,
      openFrameSession: async () => ({
        ok: true,
        session: {
          browserVersion: "Chromium 140.0.0.0",
          browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 } },
          uploadImages: async () => ({ ok: true, uploaded: 0 }),
          render: async () => ({ ok: true, frame: { width: 4, height: 4, rgba: Buffer.alloc(3), sha256: frameSha256, evidence: runtimeEvidence() } }),
          close: async () => undefined
        }
      })
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
  });

  it("creates the exact proof format the source-only readiness gate accepts", async () => {
    const result = await runGpuActiveHardwareProbe(probeOptions(), successfulServices());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(assessGpuHardwareReadiness({
      chromium: { status: "ready", source: "path", version: "Chromium 140.0.0.0" },
      activeHostProof: result.proof,
      resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" }),
      verifyBrowser: () => null,
      hashExecutable: async () => executableSha256,
      now: () => new Date("2026-08-13T12:00:00.000Z")
    })).resolves.toMatchObject({ status: "available", adapterDeviceProof: { status: "active-host-proof", adapterFingerprint } });
  });

  it("refuses forged Windows Job Object evidence before rendering the hardware frame", async () => {
    let rendered = false;
    let closed = false;
    const result = await runGpuActiveHardwareProbe(probeOptions(), {
      ...successfulServices(),
      openFrameSession: async () => ({
        ok: true,
        session: {
          browserVersion: "Chromium 140.0.0.0",
          browserProcess: {
            pid: 42,
            launcher: "precontained-direct-chromium",
            // This was previously accepted by the local duplicate check even
            // though no Windows Job Object process count or launcher proof exists.
            containment: {
              rootPid: 42,
              mode: "windows-job-object",
              status: "enforced",
              killTree: true,
              memoryLimit: "job-commit",
              maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024
            } as unknown as GpuBrowserProcess["containment"]
          },
          uploadImages: async () => ({ ok: true as const, uploaded: 0 }),
          render: async () => {
            rendered = true;
            return { ok: true as const, frame: { width: 4, height: 4, rgba: probeReadback(), sha256: frameSha256, evidence: runtimeEvidence() } };
          },
          close: async () => { closed = true; }
        }
      })
    });

    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_browser_launch_failed" } });
    expect(rendered).toBe(false);
    expect(closed).toBe(true);
  });

  it.each([
    ["all-zero", Buffer.alloc(64)],
    ["opaque all-clear", opaqueBlackReadback()]
  ])("refuses a full-size %s readback rather than minting GPU proof", async (_kind, rgba) => {
    const result = await runGpuActiveHardwareProbe(probeOptions(), {
      ...successfulServices(),
      openFrameSession: async () => ({
        ok: true,
        session: {
          browserVersion: "Chromium 140.0.0.0",
          browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 } },
          uploadImages: async () => ({ ok: true, uploaded: 0 }),
          render: async () => ({ ok: true as const, frame: { width: 4, height: 4, rgba, sha256: createHash("sha256").update(rgba).digest("hex"), evidence: runtimeEvidence() } }),
          close: async () => undefined
        }
      })
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
  });
});

function successfulServices() {
  return {
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    resolveBrowser: () => ({ executable: "/trusted/chromium", source: "path" as const }),
    verifyBrowser: () => null,
    hashExecutable: async () => executableSha256,
    openFrameSession: async () => ({
      ok: true as const,
      session: {
        browserVersion: "Chromium 140.0.0.0",
        browserProcess: {
          pid: 42,
          launcher: "precontained-direct-chromium" as const,
          containment: { rootPid: 42, mode: "unix-process-group" as const, status: "enforced" as const, killTree: true as const, memoryLimit: "rss-monitor" as const, maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 }
        },
        uploadImages: async () => ({ ok: true as const, uploaded: 0 }),
        render: async () => ({ ok: true as const, frame: { width: 4, height: 4, rgba: probeReadback(), sha256: frameSha256, evidence: runtimeEvidence() } }),
        close: async () => undefined
      }
    })
  };
}

function probeOptions() {
  return {
    scratchRoot: "/host-owned/private-probe-scratch",
    scratchAuthority: {
      path: "/host-owned/private-probe-scratch",
      assertCurrent: async () => undefined
    },
    maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024
  };
}

function runtimeEvidence() {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1" as const,
    backend: "webgpu-browser" as const,
    browserSource: "path",
    webgpuFeatureStatus: "enabled",
    adapterFingerprint,
    adapter: {
      cdpVendorId: 4318,
      cdpDeviceId: 11266,
      cdpVendor: "NVIDIA",
      cdpDevice: "NVIDIA GeForce RTX 5080",
      vendor: "NVIDIA",
      device: "NVIDIA GeForce RTX 5080",
      architecture: null,
      description: "NVIDIA GeForce RTX 5080"
    },
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
  };
}

function probeReadback(): Buffer {
  const rgba = Buffer.alloc(64, 0);
  // Pixel (1,1): fixed opaque orange rect. A broken all-clear/readback path cannot satisfy it.
  rgba.set([255, 128, 0, 255], (1 * 4 + 1) * 4);
  return rgba;
}

function opaqueBlackReadback(): Buffer {
  const rgba = Buffer.alloc(64, 0);
  for (let offset = 3; offset < rgba.byteLength; offset += 4) rgba[offset] = 255;
  return rgba;
}
