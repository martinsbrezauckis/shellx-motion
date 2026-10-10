import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "node:http";

const hashFile = vi.hoisted(() => vi.fn());
const motionBrowserExecutableVerificationProblem = vi.hoisted(() => vi.fn());

vi.mock("@shellx-motion/core", () => ({
  hashFile,
  motionBrowserExecutableVerificationProblem
}));

import { openStrictSdrCandidateHeldGpuRuntime } from "./gpu-browser-session-establishment";

const SOURCE_HASH = "a".repeat(64);
const REPLACED_HASH = "b".repeat(64);
const originalLocation = { executable: "/trusted/chrome", source: "path" as const };
const pageProbe = {
  secureContext: true,
  gpuApi: true,
  adapter: true,
  adapterInfo: { vendor: "NVIDIA", device: "NVIDIA GeForce RTX 5080", architecture: "Blackwell", description: null },
  device: true,
  limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
};
const systemInfo = {
  gpu: {
    featureStatus: { webgpu: "enabled" },
    devices: [{ active: true, vendorId: 0x10de, deviceId: 0x2b85, vendorString: "NVIDIA", deviceString: "NVIDIA GeForce RTX 5080", softwareRendering: false }]
  }
};

beforeEach(() => {
  hashFile.mockReset();
  motionBrowserExecutableVerificationProblem.mockReset();
  motionBrowserExecutableVerificationProblem.mockReturnValue(null);
});

function heldBrowser() {
  const close = vi.fn(async () => undefined);
  const page = {
    goto: vi.fn(async (_url: string, _options: { waitUntil: "load" }) => undefined),
    evaluate: vi.fn(async (callback: unknown) => typeof callback === "function" && callback.name === "probeWebGpuPage" ? pageProbe : "Mozilla/5.0 strict-sdr-test")
  };
  const cdp = {
    send: vi.fn(async (method: string) => {
      if (method === "SystemInfo.getInfo") return systemInfo;
      if (method === "Browser.getVersion") return { product: "Chrome/149.0.0.0" };
      throw new Error(`unexpected CDP method ${method}`);
    })
  };
  const browser = {
    newPage: vi.fn(async () => page),
    newBrowserCDPSession: vi.fn(async () => cdp),
    version: vi.fn(() => "149.0.0.0")
  };
  return {
    held: {
      browser: browser as never,
      browserProcess: {
        pid: 4242,
        launcher: "precontained-direct-chromium" as const,
        containment: {
          rootPid: 4242,
          mode: "unix-process-group" as const,
          status: "enforced" as const,
          killTree: true as const,
          memoryLimit: "rss-monitor" as const,
          maxProcessTreeRssBytes: 64 * 1024 * 1024
        }
      },
      close
    },
    close,
    browser,
    page,
    cdp
  };
}

async function assertLoopbackRefuses(url: string): Promise<void> {
  await new Promise<void>((resolveRequest, rejectRequest) => {
    const request = get(url, (response) => {
      response.resume();
      rejectRequest(new Error("GPU loopback listener remained reachable during held browser cleanup."));
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      // Closing an accepted, still-queued socket can reset it; neither result serves the probe.
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") resolveRequest(); else rejectRequest(error);
    });
  });
}

describe("strict SDR held GPU session establishment", () => {
  it("measures the original normal browser before page access and retains the post-session hash", async () => {
    const fixture = heldBrowser();
    hashFile.mockResolvedValueOnce(SOURCE_HASH).mockResolvedValueOnce(SOURCE_HASH);

    const opened = await openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH);

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.failure.message);
    expect(hashFile).toHaveBeenNthCalledWith(1, originalLocation.executable);
    expect(hashFile).toHaveBeenNthCalledWith(2, originalLocation.executable);
    expect(fixture.browser.newPage).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/), { waitUntil: "load" });
    expect(fixture.cdp.send).toHaveBeenCalledWith("SystemInfo.getInfo");
    expect(fixture.cdp.send).toHaveBeenCalledWith("Browser.getVersion");
    expect(opened.session.browserIdentity.executableSha256).toBe(SOURCE_HASH);

    await opened.session.close();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("closes the loopback listener before invoking held browser cleanup", async () => {
    const fixture = heldBrowser();
    hashFile.mockResolvedValueOnce(SOURCE_HASH).mockResolvedValueOnce(SOURCE_HASH);
    fixture.close.mockImplementation(async () => {
      const [url] = fixture.page.goto.mock.calls[0] ?? [];
      if (typeof url !== "string") throw new Error("GPU probe did not navigate to its loopback listener.");
      await assertLoopbackRefuses(url);
    });

    const opened = await openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH);
    if (!opened.ok) throw new Error(opened.failure.message);
    await opened.session.close();

    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a replaced original executable before creating a page and closes the held browser", async () => {
    const fixture = heldBrowser();
    hashFile.mockResolvedValueOnce(REPLACED_HASH);

    await expect(openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH)).resolves.toEqual({
      ok: false,
      failure: {
        code: "gpu_browser_launch_failed",
        message: "The trusted browser executable changed before strict SDR candidate GPU-session establishment."
      }
    });
    expect(fixture.browser.newPage).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("refuses an invalid normal location before reading it and closes the held browser", async () => {
    const fixture = heldBrowser();
    motionBrowserExecutableVerificationProblem.mockReturnValue("broken pinned browser");

    await expect(openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH)).resolves.toEqual({
      ok: false,
      failure: {
        code: "gpu_browser_unavailable",
        message: "No trusted Motion browser executable is available for strict SDR candidate GPU probing."
      }
    });
    expect(hashFile).not.toHaveBeenCalled();
    expect(fixture.browser.newPage).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a pre-session refusal with held-browser cleanup uncertainty", async () => {
    const fixture = heldBrowser();
    const closeFailure = new Error("terminal group uncertain");
    fixture.close.mockRejectedValueOnce(closeFailure);
    hashFile.mockResolvedValueOnce(REPLACED_HASH);

    await expect(openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH)).rejects.toSatisfy((error: unknown) => {
      return error instanceof AggregateError
        && error.message === "Strict SDR candidate GPU admission and cleanup failed."
        && error.errors.some((entry) => entry === closeFailure)
        && error.errors.some((entry) => entry !== null && typeof entry === "object"
          && "code" in entry && entry.code === "gpu_browser_launch_failed"
          && "message" in entry && typeof entry.message === "string" && entry.message.includes("changed before strict SDR candidate"));
    });
    expect(fixture.browser.newPage).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing post-session hash refusal after creating the actual session", async () => {
    const fixture = heldBrowser();
    hashFile.mockResolvedValueOnce(SOURCE_HASH).mockResolvedValueOnce(REPLACED_HASH);

    await expect(openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH)).resolves.toEqual({
      ok: false,
      failure: {
        code: "gpu_browser_launch_failed",
        message: "The trusted browser executable changed between launch admission and GPU-session identity capture."
      }
    });
    expect(fixture.browser.newPage).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("preserves page-establishment failure with cleanup uncertainty and closes once", async () => {
    const fixture = heldBrowser();
    const pageFailure = new Error("new page failed");
    const closeFailure = new Error("group did not settle");
    fixture.browser.newPage.mockRejectedValueOnce(pageFailure);
    fixture.close.mockRejectedValueOnce(closeFailure);
    hashFile.mockResolvedValueOnce(SOURCE_HASH);

    await expect(openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH)).rejects.toSatisfy((error: unknown) => {
      return error instanceof AggregateError
        && error.message === "GPU runtime session establishment and cleanup failed."
        && error.errors.includes(pageFailure)
        && error.errors.includes(closeFailure);
    });
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("does not turn a refused assessment with cleanup uncertainty into a false success", async () => {
    const fixture = heldBrowser();
    const closeFailure = new Error("group did not settle");
    fixture.page.evaluate.mockImplementation(async (callback: unknown) => {
      return typeof callback === "function" && callback.name === "probeWebGpuPage"
        ? { ...pageProbe, secureContext: false }
        : "Mozilla/5.0 strict-sdr-test";
    });
    fixture.close.mockRejectedValueOnce(closeFailure);
    hashFile.mockResolvedValueOnce(SOURCE_HASH);

    await expect(openStrictSdrCandidateHeldGpuRuntime(fixture.held, originalLocation, SOURCE_HASH)).rejects.toSatisfy((error: unknown) => {
      return error instanceof AggregateError
        && error.message === "GPU runtime refusal and cleanup failed."
        && error.errors.includes(closeFailure)
        && error.errors.some((entry) => entry !== null && typeof entry === "object"
          && "code" in entry && entry.code === "gpu_secure_context_unavailable");
    });
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });
});
