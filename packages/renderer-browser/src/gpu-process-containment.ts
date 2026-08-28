import type { LocalMotionProcessContainmentEvidence } from "@shellx-motion/core";
import type { GpuBrowserProcess, GpuBrowserProcessContainment } from "./gpu-browser-process";

/** Outer final-job facts established before the browser launcher is invoked. */
export interface GpuStreamingJobContext {
  readonly admission: "pre-acquired";
  readonly signal: AbortSignal;
  readonly scratchRoot: string;
  readonly maxProcessTreeRssBytes: number;
  readonly watchProcess: (pid: number) => void;
}

export type GpuBrowserProcessTreeContainment = GpuBrowserProcessContainment;

/**
 * Map the strict renderer-owned browser containment facts into the outer Core
 * job governor evidence. A Unix process group is bounded by the governor's
 * RSS monitor, not a Windows Job Object limit; only the latter may report its
 * native job limits. Keeping this mapping here makes every GPU-probe host use
 * the same platform-specific evidence shape.
 */
export function gpuBrowserProcessContainmentEvidence(
  containment: GpuBrowserProcessContainment
): LocalMotionProcessContainmentEvidence {
  return {
    schema: "shellx-motion/process-containment@1",
    mode: containment.mode,
    status: containment.status,
    killTree: containment.killTree,
    memoryLimit: containment.memoryLimit,
    ...(containment.mode === "windows-job-object"
      ? {
          maxJobMemoryBytes: containment.maxProcessTreeRssBytes,
          maxActiveProcesses: containment.maxActiveProcesses,
          launcher: containment.launcher
        }
      : {})
  };
}

export function isGpuFinalLaunchContext(value: GpuStreamingJobContext): boolean {
  return typeof value.scratchRoot === "string" && value.scratchRoot.trim().length > 0
    && Number.isSafeInteger(value.maxProcessTreeRssBytes)
    && value.maxProcessTreeRssBytes >= 64 * 1024 * 1024
    && value.maxProcessTreeRssBytes <= 1024 * 1024 * 1024 * 1024;
}

export function isPrecontainedGpuBrowser(value: unknown, expectedPid: number, expectedBytes: number): value is GpuBrowserProcessContainment {
  if (!value || typeof value !== "object") return false;
  const containment = value as Record<string, unknown>;
  if (containment.rootPid !== expectedPid || containment.maxProcessTreeRssBytes !== expectedBytes
    || containment.status !== "enforced" || containment.killTree !== true) return false;
  if (containment.mode === "unix-process-group") return containment.memoryLimit === "rss-monitor";
  if (containment.mode !== "windows-job-object" || containment.memoryLimit !== "job-commit"
    || !Number.isSafeInteger(containment.maxActiveProcesses) || (containment.maxActiveProcesses as number) < 1) return false;
  const launcher = containment.launcher;
  return !!launcher && typeof launcher === "object"
    && (launcher as Record<string, unknown>).kind === "powershell-csharp"
    && typeof (launcher as Record<string, unknown>).sha256 === "string"
    && /^[a-f0-9]{64}$/u.test((launcher as Record<string, unknown>).sha256 as string);
}

export function isGpuBrowserProcess(value: unknown): value is GpuBrowserProcess {
  if (!value || typeof value !== "object") return false;
  const browser = value as GpuBrowserProcess;
  return Number.isSafeInteger(browser.pid) && browser.pid > 1 && browser.launcher === "precontained-direct-chromium";
}
