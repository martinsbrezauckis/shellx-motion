import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
import { hashFile, motionBrowserExecutableVerificationProblem, resolveMotionBrowserExecutable, type MotionBrowserExecutableLocation } from "@shellx-motion/core";
import { assessGpuRuntime, type GpuBrowserDeviceObservation, type GpuPageAdapterInfo, type GpuPageObservation, type GpuRuntimeAssessment } from "./gpu-runtime-assessment";
import type { GpuRuntimeEvidence, GpuRuntimeFailure } from "./gpu-runtime-types";
import { GPU_BROWSER_HARDWARE_ARGS, gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
import { browserServerProcessPid, createGpuBrowserSessionIdentity, GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE, GPU_BROWSER_SANDBOX, sameGpuBrowserExecutableSha256, type GpuBrowserSessionIdentity } from "./gpu-browser-session-identity";
import { launchPrecontainedGpuBrowser, type GpuPrecontainedBrowser } from "./gpu-final-browser-launch";
import type { GpuBrowserProcess, GpuFinalBrowserLaunchContext } from "./gpu-browser-process";

export { GPU_BROWSER_HARDWARE_ARGS, gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
export { gpuFinalBrowserArgs, gpuFinalPosixSpawnOptions, launchPrecontainedGpuBrowser, parseGpuDevToolsActivePort, waitForGpuDevToolsActivePort, type GpuPrecontainedBrowserLaunchServices } from "./gpu-final-browser-launch";
export type { GpuBrowserProcess, GpuBrowserProcessContainment, GpuFinalBrowserLaunchContext } from "./gpu-browser-process";
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
   * Host-internal capability for a governed surface producer.  It is the
   * exact Browser attached to this runtime's already-launched BrowserServer;
   * callers may create a context but must never close the Browser itself.
   */
  borrowGpuBrowser(): Browser;
  assessRender(page: GpuPageObservation): Promise<GpuRuntimeAssessment>;
  close(): Promise<void>;
}

export interface GpuRuntimeOpenOptions {
  readonly finalBrowser?: GpuFinalBrowserLaunchContext;
  /**
   * A host-resolved executable identity for an operation that must bind its
   * evidence to that exact browser. It is still revalidated immediately before
   * process creation; package data can never provide this value.
   */
  readonly browserLocation?: MotionBrowserExecutableLocation;
}

export const GPU_ADAPTER_REQUEST_OPTIONS = { powerPreference: "high-performance" } as const;
/** Only page-owned, Core-admitted static SVG Blob URLs may enter the isolated image decoder. */
export const GPU_LOOPBACK_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src blob:";

/**
 * Opens a trusted browser session. Ordinary preview keeps Playwright's normal
 * launchServer lifecycle; final delivery must opt into the pre-contained path
 * before the first Chromium instruction can run.
 */
export async function openGpuRuntime(options: GpuRuntimeOpenOptions = {}): Promise<GpuRuntimeOpenResult> {
  const location = options.browserLocation ?? resolveMotionBrowserExecutable();
  if (motionBrowserExecutableVerificationProblem(location)) {
    return { ok: false, failure: { code: "gpu_browser_unavailable", message: "No trusted Motion browser executable is available for GPU probing." } };
  }
  if (options.finalBrowser) return openPrecontainedGpuFinalRuntime(location, options.finalBrowser);
  return openGpuPreviewRuntime(location);
}

/** Preview-only compatibility path: Playwright owns this browser server. */
async function openGpuPreviewRuntime(location: ReturnType<typeof resolveMotionBrowserExecutable>): Promise<GpuRuntimeOpenResult> {
  let browser: Browser | undefined;
  let browserServer: BrowserServer | undefined;
  try {
    // The selected cache entry is rechecked at the process boundary, rather than relying on the
    // earlier resolver result while any caller work was in flight.
    if (motionBrowserExecutableVerificationProblem(location)) {
      return { ok: false, failure: { code: "gpu_browser_unavailable", message: "No trusted Motion browser executable is available for GPU probing." } };
    }
    const executableSha256 = await hashFile(location.executable);
    // `launch()` deliberately hides Chromium's root process. GPU final jobs
    // need a root PID that their owner can monitor and bind to enforced tree
    // containment, so retain Playwright's trusted BrowserServer boundary and
    // connect to it rather than launching an opaque Browser instance.
    browserServer = await chromium.launchServer({
      executablePath: location.executable,
      headless: true,
      chromiumSandbox: GPU_BROWSER_SANDBOX,
      ignoreDefaultArgs: [...GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE],
      args: [...gpuBrowserHardwareArgs()]
    });
    const pid = browserServerProcessPid(browserServer.process());
    if (pid === null) {
      await closeQuietly(browser, browserServer);
      return { ok: false, failure: { code: "gpu_browser_pid_unavailable", message: "The trusted Chromium browser server did not expose an owned root PID." } };
    }
    const browserProcess: GpuBrowserProcess = { pid, launcher: "playwright-launch-server", containment: null };
    browser = await chromium.connect(browserServer.wsEndpoint());
    return await establishGpuRuntimeSession({
      browser,
      browserProcess,
      browserLocation: location,
      executableSha256,
      close: async () => closeQuietly(browser, browserServer)
    });
  } catch {
    await closeQuietly(browser, browserServer);
    return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser could not open a GPU probe session." } };
  }
}

/**
 * Final-only browser lifecycle. The Chrome root is placed in an enforced
 * process group or Windows Job Object before it resumes, then Playwright only
 * attaches to its loopback CDP endpoint. There is deliberately no post-launch
 * "bind this PID" window.
 */
async function openPrecontainedGpuFinalRuntime(
  location: ReturnType<typeof resolveMotionBrowserExecutable>,
  context: GpuFinalBrowserLaunchContext
): Promise<GpuRuntimeOpenResult> {
  let launched: GpuPrecontainedBrowser | undefined;
  try {
    if (motionBrowserExecutableVerificationProblem(location)) {
      return { ok: false, failure: { code: "gpu_browser_unavailable", message: "No trusted Motion browser executable is available for GPU final rendering." } };
    }
    const executableSha256 = await hashFile(location.executable);
    launched = await launchPrecontainedGpuBrowser(location.executable, context);
    return await establishGpuRuntimeSession({
      browser: launched.browser,
      browserProcess: launched.browserProcess,
      browserLocation: location,
      executableSha256,
      close: launched.close
    });
  } catch {
    await launched?.close().catch(() => undefined);
    return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser could not open a pre-contained GPU final session." } };
  }
}

async function establishGpuRuntimeSession(input: {
  browser: Browser;
  browserProcess: GpuBrowserProcess;
  browserLocation: MotionBrowserExecutableLocation;
  executableSha256: string;
  close: () => Promise<void>;
}): Promise<GpuRuntimeOpenResult> {
  let server: Server | undefined;
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
      await closeGpuRuntime(input.close, server);
      return assessment;
    }
    const browserVersion = input.browser.version().trim();
    if (!browserVersion) {
      await closeGpuRuntime(input.close, server);
      return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser did not report a version for its GPU probe session." } };
    }
    // The launch-path hash is only an admission fact. Re-hash after this exact
    // browser session exists so a replacement cannot become qualification
    // evidence for a process that was launched from different bytes.
    const sessionExecutableSha256 = await hashFile(input.browserLocation.executable);
    if (!sameGpuBrowserExecutableSha256(input.executableSha256, sessionExecutableSha256)) {
      await closeGpuRuntime(input.close, server);
      return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser executable changed between launch admission and GPU-session identity capture." } };
    }
    const browserIdentity = createGpuBrowserSessionIdentity({
      source: input.browserLocation.source,
      executableSha256: sessionExecutableSha256,
      version: browserVersion,
      product: browserVersionInfo?.product,
      userAgent: pageUserAgent
    });
    if (!browserIdentity) {
      await closeGpuRuntime(input.close, server);
      return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser did not report a usable product name and user agent for its GPU probe session." } };
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
        close: async () => closeGpuRuntime(input.close, server)
      }
    };
  } catch {
    await closeGpuRuntime(input.close, server);
    return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "The trusted browser could not establish its GPU probe session." } };
  }
}

async function closeGpuRuntime(closeBrowser: () => Promise<void>, server?: Server): Promise<void> {
  const results = await Promise.allSettled([closeBrowser(), server ? new Promise<void>((resolveClose) => server.close(() => resolveClose())) : undefined]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  if (failures.length === 1) throw failures[0]; if (failures.length > 1) throw new AggregateError(failures, "GPU runtime cleanup failed.");
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
async function closeQuietly(browser?: Browser, browserServer?: BrowserServer, server?: Server): Promise<void> {
  const child = browserServer?.process() ?? null;
  // Closing the connected Browser lets Chromium flush its controlled shutdown;
  // BrowserServer.close is the authoritative owner teardown. Run both because
  // a failed CDP transport must not leave the owned server alive.
  await Promise.allSettled([
    browser?.close(),
    browserServer?.close(),
    server ? new Promise<void>((resolve) => server.close(() => resolve())) : undefined
  ]);
  if (!child || browserServerProcessPid(child) === null) return;
  await waitForBrowserServerExit(child, 1_500);
  if (browserProcessExited(child)) return;
  try { child.kill("SIGKILL"); } catch { /* BrowserServer close is still the primary tree teardown. */ }
  await waitForBrowserServerExit(child, 1_500);
}

function browserProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForBrowserServerExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (browserProcessExited(child)) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    child.once("exit", done);
  });
}
