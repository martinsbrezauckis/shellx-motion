import { createServer, type Server } from "node:http";
import type { Browser, Page } from "playwright-core";
import { hashFile, motionBrowserExecutableVerificationProblem, type MotionBrowserExecutableLocation } from "@shellx-motion/core";
import { assessGpuRuntime, type GpuBrowserDeviceObservation, type GpuPageAdapterInfo, type GpuPageObservation, type GpuRuntimeAssessment } from "./gpu-runtime-assessment";
import type { GpuRuntimeEvidence, GpuRuntimeFailure } from "./gpu-runtime-types";
import { createGpuBrowserSessionIdentity, sameGpuBrowserExecutableSha256, type GpuBrowserSessionIdentity } from "./gpu-browser-session-identity";
import type { GpuPrecontainedBrowser } from "./gpu-final-browser-launch";
import type { GpuBrowserProcess } from "./gpu-browser-process";

export type GpuRuntimeOpenResult =
  | { ok: true; session: GpuRuntimeSession }
  | { ok: false; failure: GpuRuntimeFailure };

export interface GpuRuntimeSession {
  page: Page;
  /** Version reported by the exact browser process that opened this GPU session. */
  browserVersion: string;
  /** Immutable browser identity measured from this exact GPU-session process/page. */
  browserIdentity: GpuBrowserSessionIdentity;
  /**
   * The exact Chromium browser-server root launched by this runtime. It is
   * intentionally a PID-bearing contract rather than a Node fallback: final
   * GPU delivery must bind this root to the admitted job's tree controller.
   */
  browserProcess: GpuBrowserProcess;
  /**
   * Host-internal capability for a governed surface producer. It is the exact
   * Browser attached to this runtime's already-launched BrowserServer; callers
   * may create a context but must never close the Browser itself.
   */
  borrowGpuBrowser(): Browser;
  assessRender(page: GpuPageObservation): Promise<GpuRuntimeAssessment>;
  close(): Promise<void>;
}

export const GPU_ADAPTER_REQUEST_OPTIONS = { powerPreference: "high-performance" } as const;
/** Only page-owned, Core-admitted static SVG Blob URLs may enter the isolated image decoder. */
export const GPU_LOOPBACK_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src blob:";
const GPU_RUNTIME_LOOPBACK_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Candidate-only bridge for an already contained browser whose direct executable
 * intentionally differs from the normal Core-resolved source executable. The
 * normal source location and its hash must be measured before the first page or
 * CDP operation, then the common establishment path rechecks the same source
 * after the session exists.
 */
export async function openStrictSdrCandidateHeldGpuRuntime(
  launched: GpuPrecontainedBrowser,
  originalLocation: MotionBrowserExecutableLocation,
  sourceExecutableSha256: string
): Promise<GpuRuntimeOpenResult> {
  if (motionBrowserExecutableVerificationProblem(originalLocation)) {
    return refuseHeldGpuRuntime(launched, {
      code: "gpu_browser_unavailable",
      message: "No trusted Motion browser executable is available for strict SDR candidate GPU probing."
    });
  }
  let preSessionExecutableSha256: string;
  try {
    preSessionExecutableSha256 = await hashFile(originalLocation.executable);
  } catch {
    return refuseHeldGpuRuntime(launched, {
      code: "gpu_browser_launch_failed",
      message: "The trusted browser executable could not be measured before strict SDR candidate GPU probing."
    });
  }
  if (!sameGpuBrowserExecutableSha256(sourceExecutableSha256, preSessionExecutableSha256)) {
    return refuseHeldGpuRuntime(launched, {
      code: "gpu_browser_launch_failed",
      message: "The trusted browser executable changed before strict SDR candidate GPU-session establishment."
    });
  }
  return establishGpuRuntimeSession({
    browser: launched.browser,
    browserProcess: launched.browserProcess,
    browserLocation: originalLocation,
    executableSha256: sourceExecutableSha256,
    close: launched.close
  });
}

async function refuseHeldGpuRuntime(launched: GpuPrecontainedBrowser, failure: GpuRuntimeFailure): Promise<GpuRuntimeOpenResult> {
  try {
    await launched.close();
  } catch (closeError) {
    throw new AggregateError([failure, closeError], "Strict SDR candidate GPU admission and cleanup failed.");
  }
  return { ok: false, failure };
}
export async function establishGpuRuntimeSession(input: {
  browser: Browser;
  browserProcess: GpuBrowserProcess;
  browserLocation: MotionBrowserExecutableLocation;
  executableSha256: string;
  close: () => Promise<void>;
}): Promise<GpuRuntimeOpenResult> {
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= closeGpuRuntime(input.close, server);
  try {
    server = await createLoopbackProbeServer();
    const page = await input.browser.newPage();
    await page.goto(loopbackUrl(server), { waitUntil: "load" });
    const cdp = await input.browser.newBrowserCDPSession();
    const [pageProbe, system, browserVersionInfo, pageUserAgent] = await Promise.all([
      page.evaluate(probeWebGpuPage, GPU_ADAPTER_REQUEST_OPTIONS),
      cdp.send("SystemInfo.getInfo"),
      cdp.send("Browser.getVersion"),
      page.evaluate(() => navigator.userAgent)
    ]);
    const assessment = assessGpuRuntime({ browserSource: input.browserLocation.source, featureStatus: readFeatureStatus(system), devices: readDevices(system), page: pageProbe });
    if (!assessment.ok) {
      return closeRefusedGpuRuntime(assessment, close);
    }
    const browserVersion = input.browser.version().trim();
    if (!browserVersion) {
      return closeRefusedGpuRuntime({ ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser did not report a version for its GPU probe session." } }, close);
    }
    // The launch-path hash is only an admission fact. Re-hash after this exact
    // browser session exists so a replacement cannot become qualification
    // evidence for a process that was launched from different bytes.
    const sessionExecutableSha256 = await hashFile(input.browserLocation.executable);
    if (!sameGpuBrowserExecutableSha256(input.executableSha256, sessionExecutableSha256)) {
      return closeRefusedGpuRuntime({ ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser executable changed between launch admission and GPU-session identity capture." } }, close);
    }
    const browserIdentity = createGpuBrowserSessionIdentity({
      source: input.browserLocation.source,
      executableSha256: sessionExecutableSha256,
      version: browserVersion,
      product: browserVersionInfo?.product,
      userAgent: pageUserAgent
    });
    if (!browserIdentity) {
      return closeRefusedGpuRuntime({ ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser did not report a usable product name and user agent for its GPU probe session." } }, close);
    }
    const assessRender = async (renderPage: GpuPageObservation): Promise<GpuRuntimeAssessment> => {
      try {
        const freshSystem = await cdp.send("SystemInfo.getInfo");
        return assessGpuRuntime({ browserSource: input.browserLocation.source, featureStatus: readFeatureStatus(freshSystem), devices: readDevices(freshSystem), page: renderPage });
      } catch {
        return { ok: false, failure: { code: "gpu_adapter_identity_unavailable", message: "Chromium device identity could not be collected for the render-selected WebGPU adapter." } };
      }
    };
    return {
      ok: true,
      session: {
        page,
        browserVersion,
        browserIdentity,
        browserProcess: input.browserProcess,
        borrowGpuBrowser: () => input.browser,
        assessRender,
        close
      }
    };
  } catch (error) {
    return failGpuRuntimeEstablishment(error, close);
  }
}

async function closeRefusedGpuRuntime(
  result: Extract<GpuRuntimeOpenResult, { ok: false }>,
  close: () => Promise<void>
): Promise<GpuRuntimeOpenResult> {
  try {
    await close();
  } catch (cleanupError) {
    throw new AggregateError([result.failure, cleanupError], "GPU runtime refusal and cleanup failed.");
  }
  return result;
}

async function failGpuRuntimeEstablishment(error: unknown, close: () => Promise<void>): Promise<GpuRuntimeOpenResult> {
  try {
    await close();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "GPU runtime session establishment and cleanup failed.");
  }
  return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser could not establish its GPU probe session." } };
}

async function closeGpuRuntime(closeBrowser: () => Promise<void>, server?: Server): Promise<void> {
  const failures: unknown[] = [];
  if (server) {
    try {
      await closeLoopbackProbeServer(server);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await closeBrowser();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0]; if (failures.length > 1) throw new AggregateError(failures, "GPU runtime cleanup failed.");
}

async function closeLoopbackProbeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections();
  });
  await deadline(closed, GPU_RUNTIME_LOOPBACK_CLOSE_TIMEOUT_MS, "GPU probe loopback listener did not close before browser teardown.");
}

async function deadline(operation: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeWebGpuPage(options: { powerPreference: "high-performance" }): Promise<GpuPageObservation> {
  // `page.evaluate` serializes this function, not this module. Keep every page
  // helper in its closure so the browser probe never depends on an unavailable
  // Node-side module binding. Keep the body free of nested named functions too:
  // TSX/esbuild otherwise inserts its Node-only `__name` helper into the
  // serialized function and the real browser evaluation fails before WebGPU.
  const browserGlobal = globalThis as unknown as { isSecureContext?: boolean; navigator?: { gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } } };
  const gpu = browserGlobal.navigator?.gpu;
  const secureContext = browserGlobal.isSecureContext === true;
  if (!gpu) return { secureContext, gpuApi: false, adapter: false, adapterInfo: null, device: false, limits: null };
  // Chrome for Testing on headless Linux may initialize Dawn on the first
  // hardware request and return null once. Retry exactly once with the same
  // hardware-only preference; this is not a software or backend fallback.
  const firstAdapter = await gpu.requestAdapter(options);
  const adapter = firstAdapter ?? await gpu.requestAdapter(options);
  if (!adapter || typeof adapter !== "object") return { secureContext, gpuApi: true, adapter: false, adapterInfo: null, device: false, limits: null };
  let adapterInfo: GpuPageAdapterInfo | null = null;
  try {
    const candidate = (adapter as { info?: unknown; requestAdapterInfo?: () => Promise<unknown> }).info
      ?? await (adapter as { requestAdapterInfo?: () => Promise<unknown> }).requestAdapterInfo?.();
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      const vendor = typeof record.vendor === "string" ? record.vendor : "";
      const adapterDevice = typeof record.device === "string" ? record.device : "";
      const architecture = typeof record.architecture === "string" && record.architecture.trim() ? record.architecture : null;
      const description = typeof record.description === "string" && record.description.trim() ? record.description : null;
      if (vendor.trim() && (adapterDevice.trim() || architecture || description)) {
        adapterInfo = { vendor, device: adapterDevice, architecture, description };
      }
    }
  } catch {
    adapterInfo = null;
  }
  const requestDevice = (adapter as { requestDevice?: () => Promise<unknown> }).requestDevice;
  const device = requestDevice ? await requestDevice.call(adapter).catch(() => null) : null;
  if (!device || typeof device !== "object") return { secureContext, gpuApi: true, adapter: true, adapterInfo, device: false, limits: null };
  const probeDevice = device as { destroy?: () => void; limits?: Partial<GpuRuntimeEvidence["limits"]> };
  try {
    const limits = probeDevice.limits;
    const limitSnapshot = limits && {
      maxTextureDimension2D: limits.maxTextureDimension2D,
      maxBufferSize: limits.maxBufferSize,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize
    };
    if (!limitSnapshot || !Number.isInteger(limitSnapshot.maxTextureDimension2D) || !Number.isInteger(limitSnapshot.maxBufferSize) || !Number.isInteger(limitSnapshot.maxStorageBufferBindingSize)) {
      return { secureContext, gpuApi: true, adapter: true, adapterInfo, device: false, limits: null };
    }
    // GPUSupportedLimits is an exotic browser object whose values do not
    // survive Playwright structured cloning when returned directly.
    return { secureContext, gpuApi: true, adapter: true, adapterInfo, device: true, limits: limitSnapshot as GpuRuntimeEvidence["limits"] };
  } finally {
    try { probeDevice.destroy?.(); } catch { /* probe evidence remains valid if cleanup races browser teardown */ }
  }
}

function readFeatureStatus(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.gpu) || !isRecord(value.gpu.featureStatus)) return null;
  return typeof value.gpu.featureStatus.webgpu === "string" ? value.gpu.featureStatus.webgpu : null;
}

function readDevices(value: unknown): GpuBrowserDeviceObservation[] {
  if (!isRecord(value) || !isRecord(value.gpu) || !Array.isArray(value.gpu.devices)) return [];
  return value.gpu.devices.filter(isRecord).map((device) => ({
    ...(typeof device.active === "boolean" ? { active: device.active } : {}),
    ...(Number.isInteger(device.deviceId) ? { deviceId: device.deviceId as number } : {}),
    ...(typeof device.deviceString === "string" ? { deviceString: device.deviceString } : {}),
    ...(typeof device.driverVendor === "string" ? { driverVendor: device.driverVendor } : {}),
    ...(typeof device.softwareRendering === "boolean" ? { softwareRendering: device.softwareRendering } : {}),
    ...(Number.isInteger(device.vendorId) ? { vendorId: device.vendorId as number } : {}),
    ...(typeof device.vendorString === "string" ? { vendorString: device.vendorString } : {})
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function createLoopbackProbeServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url !== "/") return response.writeHead(404).end();
    response.writeHead(200, { "cache-control": "no-store", "content-security-policy": GPU_LOOPBACK_CONTENT_SECURITY_POLICY, "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><title>ShellX Motion GPU probe</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

function loopbackUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("GPU probe loopback listener has no TCP address.");
  return `http://127.0.0.1:${address.port}/`;
}
