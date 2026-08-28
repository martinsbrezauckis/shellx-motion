import { describe, expect, it } from "vitest";
import { gpuBrowserProcessContainmentEvidence, isPrecontainedGpuBrowser } from "./gpu-process-containment.js";

describe("GPU browser containment evidence", () => {
  it("reports POSIX pre-launch containment through the governor RSS monitor, not Windows Job limits", () => {
    expect(gpuBrowserProcessContainmentEvidence({
      rootPid: 4_242,
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor",
      maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024
    })).toEqual({
      schema: "shellx-motion/process-containment@1",
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor"
    });
  });

  it("retains the native limit and launcher identity required by a Windows Job Object", () => {
    expect(gpuBrowserProcessContainmentEvidence({
      rootPid: 4_242,
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024,
      maxActiveProcesses: 4_096,
      launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) }
    })).toEqual({
      schema: "shellx-motion/process-containment@1",
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxJobMemoryBytes: 8 * 1024 * 1024 * 1024,
      maxActiveProcesses: 4_096,
      launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) }
    });
  });

  it("refuses an incomplete or forged Windows Job Object containment proof", () => {
    const base = {
      rootPid: 4_242,
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024
    } as const;
    expect(isPrecontainedGpuBrowser(base, 4_242, 8 * 1024 * 1024 * 1024)).toBe(false);
    expect(isPrecontainedGpuBrowser({ ...base, maxActiveProcesses: 4_096 }, 4_242, 8 * 1024 * 1024 * 1024)).toBe(false);
    expect(isPrecontainedGpuBrowser({ ...base, maxActiveProcesses: 4_096, launcher: { kind: "powershell-csharp", sha256: "not-a-hash" } }, 4_242, 8 * 1024 * 1024 * 1024)).toBe(false);
  });

  it("accepts only the mode-specific complete containment proof", () => {
    const bytes = 8 * 1024 * 1024 * 1024;
    expect(isPrecontainedGpuBrowser({
      rootPid: 4_242,
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxProcessTreeRssBytes: bytes,
      maxActiveProcesses: 4_096,
      launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) }
    }, 4_242, bytes)).toBe(true);
    expect(isPrecontainedGpuBrowser({
      rootPid: 4_242,
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor",
      maxProcessTreeRssBytes: bytes
    }, 4_242, bytes)).toBe(true);
    expect(isPrecontainedGpuBrowser({
      rootPid: 4_242,
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxProcessTreeRssBytes: bytes
    }, 4_242, bytes)).toBe(false);
  });
});
