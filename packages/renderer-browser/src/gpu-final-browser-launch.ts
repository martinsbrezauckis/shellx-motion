import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import {
  cleanupWindowsJobObjectLaunchPlan,
  createOwnedUnixProcessGroup,
  createWindowsJobObjectLaunchPlan,
  waitForWindowsJobObjectStatus,
  type OwnedUnixProcessGroup,
  type WindowsJobObjectLaunchPlan
} from "@shellx-motion/core";
import { gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
import type { GpuBrowserProcess, GpuFinalBrowserLaunchContext } from "./gpu-browser-process";

const startupTimeoutMs = 15_000;
const shutdownTimeoutMs = 1_500;
const windowsMaxActiveProcesses = 4_096;

export interface GpuPrecontainedBrowser {
  browser: Browser;
  browserProcess: GpuBrowserProcess;
  close(): Promise<void>;
}

/** Internal test seam; package data can never select a launcher or endpoint. */
export interface GpuPrecontainedBrowserLaunchServices {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly createWindowsPlan?: typeof createWindowsJobObjectLaunchPlan;
  readonly waitForWindowsStatus?: typeof waitForWindowsJobObjectStatus;
  readonly cleanupWindowsPlan?: typeof cleanupWindowsJobObjectLaunchPlan;
  readonly connectOverCDP?: (endpoint: string) => Promise<Browser>;
  readonly waitForDevTools?: (profileRoot: string, child: ChildProcess, signal?: AbortSignal) => Promise<string>;
  /** Test seam only; production uses `process.kill` against the validated negative PGID. */
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export function gpuFinalBrowserArgs(profileRoot: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (!isSafeProfilePath(profileRoot)) throw new Error("GPU final requires a private absolute Chromium profile path.");
  return ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profileRoot}`, "--no-first-run", "--no-default-browser-check", ...gpuBrowserHardwareArgs(platform)];
}

/** `detached` creates a new POSIX session/group in the spawn syscall, before Chrome executes. */
export function gpuFinalPosixSpawnOptions(scratchRoot: string): { cwd: string; detached: true; stdio: "ignore"; windowsHide: true } {
  return { cwd: scratchRoot, detached: true, stdio: "ignore", windowsHide: true };
}

export function parseGpuDevToolsActivePort(raw: string): string | null {
  const [portText, path = ""] = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const port = Number(portText);
  return Number.isInteger(port) && port > 0 && port <= 65_535 && /^\/devtools\/browser\/[A-Za-z0-9._-]{1,512}$/.test(path)
    ? `ws://127.0.0.1:${port}${path}` : null;
}

/** Establish OS containment before launching Chrome, then attach over its private loopback CDP. */
export async function launchPrecontainedGpuBrowser(executable: string, context: GpuFinalBrowserLaunchContext, services: GpuPrecontainedBrowserLaunchServices = {}): Promise<GpuPrecontainedBrowser> {
  assertFinalContext(context);
  const platform = services.platform ?? process.platform;
  const profileRoot = await createProfileRoot(context.scratchRoot);
  const spawnProcess = services.spawnProcess ?? spawn;
  const cleanupPlan = services.cleanupWindowsPlan ?? cleanupWindowsJobObjectLaunchPlan;
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let plan: WindowsJobObjectLaunchPlan | undefined;
  let processInfo: GpuBrowserProcess | undefined;
  let ownedUnixProcessGroup: OwnedUnixProcessGroup | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    let containedTreeTerminated = true;
    try { await browser?.close(); } catch (error) { errors.push(error); }
    try { if (child && processInfo) await terminateContainedBrowser(child, processInfo, platform, services.killProcessGroup, ownedUnixProcessGroup); } catch (error) { containedTreeTerminated = false; errors.push(error); }
    try { if (plan) await cleanupPlan(plan); } catch (error) { errors.push(error); }
    // A survivor can still own files in this profile. Retain it rather than
    // reporting cleanup while its process group remains unconfirmed.
    if (containedTreeTerminated) try { await removeProfileRoot(profileRoot); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "GPU final browser cleanup failed.");
  };
  try {
    const args = gpuFinalBrowserArgs(profileRoot, platform);
    if (platform === "win32") {
      plan = await (services.createWindowsPlan ?? createWindowsJobObjectLaunchPlan)({ executable, args: [...args], workingDirectory: context.scratchRoot, scratchRoot: context.scratchRoot, maxJobMemoryBytes: context.maxProcessTreeRssBytes, maxActiveProcesses: windowsMaxActiveProcesses });
      child = spawnProcess(plan.executable, plan.args, { cwd: context.scratchRoot, stdio: "ignore", windowsHide: true });
      const status = await (services.waitForWindowsStatus ?? waitForWindowsJobObjectStatus)(plan, { timeoutMs: startupTimeoutMs, signal: context.signal });
      if (status.status !== "enforced") throw new Error("Windows Job Object containment was unavailable before Chromium could resume.");
      processInfo = { pid: status.childPid, launcher: "precontained-direct-chromium", containment: { rootPid: status.childPid, mode: "windows-job-object", status: "enforced", killTree: true, memoryLimit: "job-commit", maxProcessTreeRssBytes: context.maxProcessTreeRssBytes, maxActiveProcesses: status.maxActiveProcesses, launcher: { kind: "powershell-csharp", sha256: plan.helperSha256 } } };
    } else if (platform === "linux" || platform === "darwin") {
      child = spawnProcess(executable, [...args], gpuFinalPosixSpawnOptions(context.scratchRoot));
      const pid = child.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) throw new Error("GPU final Chromium did not expose a safe process-group root PID.");
      ownedUnixProcessGroup = createOwnedUnixProcessGroup(pid, (groupPid, signal) => {
        (services.killProcessGroup ?? ((target, sentSignal) => { process.kill(target, sentSignal); }))(groupPid, signal);
      });
      if (!ownedUnixProcessGroup || ownedUnixProcessGroup.presence() !== "present") {
        throw new Error("GPU final Chromium did not establish its owned process group before launch admission.");
      }
      processInfo = { pid, launcher: "precontained-direct-chromium", containment: { rootPid: pid, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: context.maxProcessTreeRssBytes } };
    } else throw new Error("GPU final browser containment is unavailable on this platform.");
    if (!child || !processInfo) throw new Error("GPU final Chromium launch did not establish an owned root process.");
    const endpoint = services.waitForDevTools ? await services.waitForDevTools(profileRoot, child, context.signal) : await waitForGpuDevToolsActivePort(profileRoot, child, context.signal);
    browser = await (services.connectOverCDP ?? ((url) => chromium.connectOverCDP(url)))(endpoint);
    return { browser, browserProcess: processInfo, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export async function waitForGpuDevToolsActivePort(profileRoot: string, child: ChildProcess, signal?: AbortSignal): Promise<string> {
  const path = join(profileRoot, "DevToolsActivePort");
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("GPU final browser launch was cancelled.");
    if (exited(child)) throw new Error("GPU final Chromium exited before publishing DevToolsActivePort.");
    const endpoint = parseGpuDevToolsActivePort(await readFile(path, "utf8").catch(() => ""));
    if (endpoint) return endpoint;
    await delay(10, signal);
  }
  throw new Error("GPU final Chromium did not publish a valid loopback DevTools endpoint before its startup deadline.");
}

function assertFinalContext(context: GpuFinalBrowserLaunchContext): void {
  if (!context || !Number.isSafeInteger(context.maxProcessTreeRssBytes) || context.maxProcessTreeRssBytes < 64 * 1024 * 1024 || context.maxProcessTreeRssBytes > 1024 * 1024 * 1024 * 1024) throw new Error("GPU final requires an admitted process-tree memory limit in 64 MiB..1 TiB.");
  if (typeof context.scratchRoot !== "string" || !context.scratchRoot.trim()) throw new Error("GPU final requires an admitted scratch root.");
}

async function createProfileRoot(scratchRoot: string): Promise<string> {
  const root = await realpath(scratchRoot), facts = await lstat(root);
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("GPU final scratch root is not a canonical directory.");
  const profile = join(root, `gpu-final-chromium-${randomUUID()}`);
  await mkdir(profile, { mode: 0o700 });
  const profileFacts = await lstat(profile), canonicalProfile = await realpath(profile);
  if (!profileFacts.isDirectory() || profileFacts.isSymbolicLink() || !inside(root, canonicalProfile)) {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("GPU final browser profile could not be established under the admitted scratch root.");
  }
  return profile;
}

async function removeProfileRoot(profile: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) try { await rm(profile, { recursive: true, force: true, maxRetries: 0 }); return; } catch (error) { last = error; await delay(50); }
  throw last instanceof Error ? last : new Error("GPU final browser profile cleanup failed.");
}

/** Terminate only the exact pre-contained tree; POSIX receives a negative PGID, never a broad signal. */
export async function terminateContainedBrowser(
  child: ChildProcess,
  browser: GpuBrowserProcess,
  platform: NodeJS.Platform,
  killProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => void = (pid, signal) => { process.kill(pid, signal); },
  ownedUnixProcessGroup?: OwnedUnixProcessGroup
): Promise<void> {
  if (browser.containment?.mode === "unix-process-group" && (platform === "linux" || platform === "darwin")) {
    // Production captures this handle immediately after spawn. Never reconstruct numeric PGID
    // ownership after the direct leader has exited.
    const group = ownedUnixProcessGroup ?? (exited(child)
      ? undefined
      : createOwnedUnixProcessGroup(browser.pid, (pid, signal) => { killProcessGroup(pid, signal); }));
    if (!group) throw new Error("GPU final refused an unsafe process-group termination target.");
    if (group.presence() === "gone") return;
    if (exited(child)) {
      group.signal("SIGKILL");
      if (await group.waitForExit(shutdownTimeoutMs)) return;
      throw new Error("GPU final could not confirm orphaned Unix process-group cleanup.");
    }
    group.signal("SIGTERM");
    if (await group.waitForExit(shutdownTimeoutMs)) return;
    group.signal("SIGKILL");
    if (await group.waitForExit(shutdownTimeoutMs)) return;
    throw new Error("GPU final could not confirm contained Unix process-group cleanup.");
  }
  // The trusted PowerShell helper owns KILL_ON_JOB_CLOSE and waits for the
  // exact Chrome child. After a normal CDP close, give it a bounded chance to
  // observe Chrome exit and release the Job itself before escalating.
  await waitForExit(child, shutdownTimeoutMs);
  if (exited(child)) return;
  try { child.kill(); } catch { /* The Job launcher may already have exited. */ }
  await waitForExit(child, shutdownTimeoutMs);
  if (!exited(child)) { try { child.kill("SIGKILL"); } catch { /* Exit checked below. */ } await waitForExit(child, shutdownTimeoutMs); }
}

function isSafeProfilePath(value: string): boolean { return typeof value === "string" && value.length > 1 && resolve(value) === value; }
function inside(root: string, target: string): boolean { return target.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`); }
function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (exited(child)) return;
  await new Promise<void>((done) => { const timer = setTimeout(finish, timeoutMs); timer.unref?.(); function finish() { clearTimeout(timer); child.removeListener("exit", finish); done(); } child.once("exit", finish); });
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => { const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); rejectDelay(signal?.reason ?? new Error("GPU final browser operation was cancelled.")); }; const done = () => { signal?.removeEventListener("abort", abort); resolveDelay(); }; const timer = setTimeout(done, ms); timer.unref?.(); if (signal) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); } });
}
