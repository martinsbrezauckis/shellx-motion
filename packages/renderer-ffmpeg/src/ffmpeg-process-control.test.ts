import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS,
  FFMPEG_TIMEOUT_EXIT_CODE,
  MAX_FFMPEG_DIAGNOSTIC_CHARS,
  MAX_FFMPEG_OUTPUT_CHARS,
  appendFfmpegProcessOutput,
  nativeWindowsJobObjectRequired,
  portableFfmpegContainmentEvidence,
  redactFfmpegDiagnostic,
  resolveFfmpegTimeoutMs,
  summarizeFfmpegDiagnostic,
  terminateFfmpegProcessTree,
  unavailableWindowsContainment,
  windowsTaskkillFallbackEvidence
} from "./ffmpeg-process-control.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("FFmpeg contained-process authority", () => {
  it("retains bounded trailing output and never exposes secret-shaped diagnostics", () => {
    const retained = appendFfmpegProcessOutput("a".repeat(MAX_FFMPEG_OUTPUT_CHARS), "tail");
    expect(retained).toHaveLength(MAX_FFMPEG_OUTPUT_CHARS);
    expect(retained.endsWith("tail")).toBe(true);

    const summary = summarizeFfmpegDiagnostic([
      "earlier diagnostic",
      `API_TOKEN=visible ${"x".repeat(MAX_FFMPEG_DIAGNOSTIC_CHARS + 100)}`,
      "PASSWORD=also-visible final diagnostic"
    ].join("\n"));
    expect(summary).toContain("API_TOKEN=[redacted]");
    expect(summary).not.toContain("visible");
    expect(summary).not.toContain("also-visible");
    expect(summary.length).toBeLessThanOrEqual(MAX_FFMPEG_DIAGNOSTIC_CHARS);
    expect(redactFfmpegDiagnostic("KEEP=this API_KEY=value")).toBe("KEEP=this API_KEY=[redacted]");
  });

  it("accepts only finite non-negative timeout overrides and makes native Windows containment explicit", () => {
    vi.stubEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", "17.6");
    expect(resolveFfmpegTimeoutMs()).toBe(18);
    vi.stubEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", "-1");
    expect(resolveFfmpegTimeoutMs()).toBe(DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS);
    vi.stubEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", "not-a-number");
    expect(resolveFfmpegTimeoutMs()).toBe(DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS);
    vi.stubEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", "yes");
    expect(nativeWindowsJobObjectRequired()).toBe(true);
    vi.stubEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", "off");
    expect(nativeWindowsJobObjectRequired()).toBe(false);

    expect(portableFfmpegContainmentEvidence("unix-process-group")).toMatchObject({
      status: "enforced", killTree: true, memoryLimit: "rss-monitor"
    });
    expect(portableFfmpegContainmentEvidence("direct-child")).toMatchObject({
      status: "unavailable", killTree: false, reasonCode: "unsupported_platform"
    });
    expect(unavailableWindowsContainment("native_helper_missing")).toMatchObject({
      mode: "direct-child", status: "unavailable", killTree: false
    });
    expect(windowsTaskkillFallbackEvidence("native_setup_failed", "a".repeat(64))).toMatchObject({
      mode: "windows-taskkill-fallback", status: "fallback", killTree: true,
      launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) }
    });
  });

  it("terminates exactly the governed Unix process group or direct child", () => {
    const groupSignal = vi.fn(() => true);
    const groupedChild = { pid: 4567, kill: vi.fn(() => true) };
    terminateFfmpegProcessTree(groupedChild, false, "unix-process-group", {
      pid: 4567,
      presence: () => "present",
      signal: groupSignal,
      waitForExit: async () => true
    });
    expect(groupSignal).toHaveBeenCalledWith("SIGTERM");
    expect(groupedChild.kill).not.toHaveBeenCalled();

    const directChild = { kill: vi.fn(() => true) };
    terminateFfmpegProcessTree(directChild, true, "direct-child");
    expect(directChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(FFMPEG_TIMEOUT_EXIT_CODE).toBe(124);
  });

  it("never negates an unsafe Unix process-group id", () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const pid of [undefined, 0, 1, 1.5, Number.NaN]) {
      const child = { pid, kill: vi.fn(() => true) };
      terminateFfmpegProcessTree(child, false, "unix-process-group");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
    expect(processKill).not.toHaveBeenCalled();

    const barePidChild = { pid: 4567, kill: vi.fn(() => true) };
    terminateFfmpegProcessTree(barePidChild, true, "unix-process-group");
    expect(processKill).not.toHaveBeenCalled();
    expect(barePidChild.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
