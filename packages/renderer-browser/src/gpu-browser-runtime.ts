import type { ChildProcess } from "node:child_process";
import { chromium, type Browser, type BrowserServer } from "playwright-core";
import { hashFile, motionBrowserExecutableVerificationProblem, resolveMotionBrowserExecutable, type MotionBrowserExecutableLocation } from "@shellx-motion/core";
import { GPU_BROWSER_HARDWARE_ARGS, gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
import { browserServerProcessPid, GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE, GPU_BROWSER_SANDBOX } from "./gpu-browser-session-identity";
import { launchPrecontainedGpuBrowser, type GpuPrecontainedBrowser } from "./gpu-final-browser-launch";
import type { GpuBrowserProcess, GpuFinalBrowserLaunchContext } from "./gpu-browser-process";
import { establishGpuRuntimeSession, type GpuRuntimeOpenResult } from "./gpu-browser-session-establishment";

export { GPU_BROWSER_HARDWARE_ARGS, gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
export { gpuFinalBrowserArgs, gpuFinalPosixSpawnOptions, launchPrecontainedGpuBrowser, parseGpuDevToolsActivePort, waitForGpuDevToolsActivePort, type GpuPrecontainedBrowserLaunchServices } from "./gpu-final-browser-launch";
export type { GpuBrowserProcess, GpuBrowserProcessContainment, GpuFinalBrowserLaunchContext } from "./gpu-browser-process";
export {
  GPU_ADAPTER_REQUEST_OPTIONS,
  GPU_LOOPBACK_CONTENT_SECURITY_POLICY,
  probeWebGpuPage
} from "./gpu-browser-session-establishment";
export type { GpuRuntimeOpenResult, GpuRuntimeSession } from "./gpu-browser-session-establishment";

export interface GpuRuntimeOpenOptions {
  readonly finalBrowser?: GpuFinalBrowserLaunchContext;
  /**
   * A host-resolved executable identity for an operation that must bind its
   * evidence to that exact browser. It is still revalidated immediately before
   * process creation; package data can never provide this value.
   */
  readonly browserLocation?: MotionBrowserExecutableLocation;
}

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

async function closeQuietly(browser?: Browser, browserServer?: BrowserServer): Promise<void> {
  const child = browserServer?.process() ?? null;
  // Closing the connected Browser lets Chromium flush its controlled shutdown;
  // BrowserServer.close is the authoritative owner teardown. Run both because
  // a failed CDP transport must not leave the owned server alive.
  await Promise.allSettled([
    browser?.close(),
    browserServer?.close()
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
