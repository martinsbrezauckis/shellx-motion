import { WindowsJobObjectPlanError, type WindowsJobObjectLaunchPlan } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FfmpegProcessResult } from "./index.js";
import type {
  StartStreamingFfmpegProcessInput,
  StreamingFfmpegProcess,
  TrustedStreamingFfmpegLaunch
} from "./streaming-process.js";
import { startWindowsJobObjectStreamingProcess } from "./streaming-windows-job.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("streaming Windows Job Object launch", () => {
  it("pipes through the trusted launcher and receipts enforced native limits", async () => {
    const plan = launchPlan();
    const cleanup = vi.fn(async () => undefined);
    const spawnProcess = vi.fn(() => closedTransport());
    const containment: unknown[] = [];
    const input = processInput((evidence) => containment.push(evidence));
    const launch = trustedLaunch();

    const process = await startWindowsJobObjectStreamingProcess(input, launch, spawnProcess, {
      createPlan: vi.fn(async () => plan),
      waitForStatus: vi.fn(async () => ({
        schema: "shellx-motion/windows-job-status@1",
        status: "enforced",
        mode: "windows-job-object",
        childPid: 5001,
        maxJobMemoryBytes: plan.maxJobMemoryBytes,
        maxActiveProcesses: plan.maxActiveProcesses
      } as const)),
      cleanup
    });

    expect(spawnProcess).toHaveBeenCalledWith(input, {
      executable: "powershell.exe",
      args: plan.args,
      env: launch.env
    }, "windows-job-object");
    expect(containment).toEqual([expect.objectContaining({
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxJobMemoryBytes: plan.maxJobMemoryBytes,
      launcher: { kind: "powershell-csharp", sha256: plan.helperSha256 }
    })]);
    await expect(process.end()).resolves.toMatchObject({ exitCode: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("uses the bounded taskkill fallback only when native planning is unavailable and not required", async () => {
    vi.stubEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", "");
    const spawnProcess = vi.fn(() => closedTransport());
    const containment: unknown[] = [];
    const input = processInput((evidence) => containment.push(evidence));
    const launch = trustedLaunch();

    await startWindowsJobObjectStreamingProcess(input, launch, spawnProcess, {
      createPlan: vi.fn(async () => { throw new WindowsJobObjectPlanError("native_helper_missing", "missing"); }),
      waitForStatus: vi.fn(),
      cleanup: vi.fn()
    });

    expect(spawnProcess).toHaveBeenCalledWith(input, launch, "windows-taskkill-fallback");
    expect(containment).toEqual([expect.objectContaining({
      mode: "windows-taskkill-fallback",
      status: "fallback",
      reasonCode: "native_helper_missing"
    })]);
  });

  it("stops and cleans an unavailable native launcher before starting the fallback", async () => {
    vi.stubEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", "");
    const plan = launchPlan();
    const native = closedTransport();
    const fallback = closedTransport();
    const abort = vi.spyOn(native, "abort");
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(native)
      .mockReturnValueOnce(fallback);
    const cleanup = vi.fn(async () => undefined);
    const containment: unknown[] = [];
    const input = processInput((evidence) => containment.push(evidence));
    const launch = trustedLaunch();

    const process = await startWindowsJobObjectStreamingProcess(input, launch, spawnProcess, {
      createPlan: vi.fn(async () => plan),
      waitForStatus: vi.fn(async () => ({
        schema: "shellx-motion/windows-job-status@1",
        status: "unavailable",
        mode: "windows-job-object",
        reasonCode: "native_setup_failed"
      } as const)),
      cleanup
    });

    expect(abort).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(plan);
    expect(spawnProcess).toHaveBeenNthCalledWith(2, input, launch, "windows-taskkill-fallback");
    expect(containment).toEqual([expect.objectContaining({
      mode: "windows-taskkill-fallback",
      status: "fallback",
      reasonCode: "native_setup_failed",
      launcher: { kind: "powershell-csharp", sha256: plan.helperSha256 }
    })]);
    await expect(process.closed).resolves.toMatchObject({ exitCode: 0 });
  });

  it("fails closed before spawning when native containment is required", async () => {
    vi.stubEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", "1");
    const spawnProcess = vi.fn(() => closedTransport());
    const containment: unknown[] = [];

    await expect(startWindowsJobObjectStreamingProcess(
      processInput((evidence) => containment.push(evidence)),
      trustedLaunch(),
      spawnProcess,
      {
        createPlan: vi.fn(async () => { throw new WindowsJobObjectPlanError("native_helper_missing", "missing"); }),
        waitForStatus: vi.fn(),
        cleanup: vi.fn()
      }
    )).rejects.toMatchObject({ code: "job_process_containment_unavailable" });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(containment).toEqual([expect.objectContaining({
      mode: "direct-child",
      status: "unavailable",
      reasonCode: "native_helper_missing"
    })]);
  });
});

function processInput(reportProcessContainment: StartStreamingFfmpegProcessInput["reportProcessContainment"]): StartStreamingFfmpegProcessInput {
  return {
    command: { executable: "C:\\trusted\\ffmpeg.exe", args: ["-i", "pipe:0"], shell: false },
    signal: new AbortController().signal,
    watchProcess: () => undefined,
    reportProcessContainment,
    scratchRoot: "C:\\trusted\\scratch",
    maxProcessTreeRssBytes: 6 * 1024 * 1024 * 1024
  };
}

function trustedLaunch(): TrustedStreamingFfmpegLaunch {
  return {
    executable: "C:\\trusted\\ffmpeg.exe",
    args: ["-i", "pipe:0"],
    env: { SYSTEMROOT: "C:\\Windows" }
  };
}

function launchPlan(): WindowsJobObjectLaunchPlan {
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-File", "C:\\trusted\\launcher.ps1"],
    requestPath: "C:\\trusted\\scratch\\request.json",
    statusPath: "C:\\trusted\\scratch\\status.json",
    helperPath: "C:\\trusted\\launcher.ps1",
    helperSha256: "a".repeat(64),
    maxJobMemoryBytes: 6 * 1024 * 1024 * 1024,
    maxActiveProcesses: 4_096
  };
}

function closedTransport(): StreamingFfmpegProcess {
  const result: FfmpegProcessResult = { exitCode: 0, stdout: "", stderr: "" };
  return {
    closed: Promise.resolve(result),
    write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }),
    end: async () => result,
    abort: async () => result
  };
}
