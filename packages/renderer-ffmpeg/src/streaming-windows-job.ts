import {
  LocalMotionJobError,
  WindowsJobObjectPlanError,
  cleanupWindowsJobObjectLaunchPlan,
  createWindowsJobObjectLaunchPlan,
  waitForWindowsJobObjectStatus,
  windowsJobObjectContainmentEvidence,
  type WindowsJobObjectLaunchPlan,
  type WindowsJobObjectStatus
} from "@shellx-motion/core";
import {
  nativeWindowsJobObjectRequired,
  unavailableWindowsContainment,
  windowsTaskkillFallbackEvidence,
  type FfmpegProcessTerminationMode
} from "./ffmpeg-process-control";
import type {
  StartStreamingFfmpegProcessInput,
  StreamingFfmpegProcess,
  TrustedStreamingFfmpegLaunch
} from "./streaming-process";

type SpawnStreamingProcess = (
  input: StartStreamingFfmpegProcessInput,
  launch: TrustedStreamingFfmpegLaunch,
  mode: FfmpegProcessTerminationMode
) => StreamingFfmpegProcess;

export interface WindowsStreamingJobServices {
  createPlan: typeof createWindowsJobObjectLaunchPlan;
  waitForStatus: typeof waitForWindowsJobObjectStatus;
  cleanup: typeof cleanupWindowsJobObjectLaunchPlan;
}

const defaultServices: WindowsStreamingJobServices = {
  createPlan: createWindowsJobObjectLaunchPlan,
  waitForStatus: waitForWindowsJobObjectStatus,
  cleanup: cleanupWindowsJobObjectLaunchPlan
};

/**
 * Put the PowerShell launcher itself behind Node's stdin/stdout pipes. Its native child inherits
 * those exact handles, while the launcher holds the kill-on-close Job Object for the full encode.
 */
export async function startWindowsJobObjectStreamingProcess(
  input: StartStreamingFfmpegProcessInput,
  launch: TrustedStreamingFfmpegLaunch,
  spawnProcess: SpawnStreamingProcess,
  services: WindowsStreamingJobServices = defaultServices
): Promise<StreamingFfmpegProcess> {
  if (input.command.shell !== false) throw new Error("Streaming FFmpeg requires shell:false.");
  const requireNative = nativeWindowsJobObjectRequired();
  let plan: WindowsJobObjectLaunchPlan;
  try {
    if (!input.scratchRoot || !input.maxProcessTreeRssBytes) {
      throw new WindowsJobObjectPlanError("native_setup_failed", "Streaming FFmpeg is missing its governed Windows launch bounds.");
    }
    plan = await services.createPlan({
      executable: launch.executable,
      args: launch.args,
      workingDirectory: process.cwd(),
      scratchRoot: input.scratchRoot,
      maxJobMemoryBytes: input.maxProcessTreeRssBytes,
      maxActiveProcesses: 4_096,
      ...(process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER?.trim()
        ? { helperPath: process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER.trim() }
        : {})
    });
  } catch (error) {
    const reasonCode = error instanceof WindowsJobObjectPlanError ? error.reasonCode : "native_setup_failed";
    if (requireNative) {
      input.reportProcessContainment(unavailableWindowsContainment(reasonCode));
      throw unavailableError(reasonCode);
    }
    input.reportProcessContainment(windowsTaskkillFallbackEvidence(reasonCode));
    return spawnProcess(input, launch, "windows-taskkill-fallback");
  }

  const contained = spawnProcess(input, {
    executable: plan.executable,
    args: plan.args,
    env: launch.env
  }, "windows-job-object");
  let status: WindowsJobObjectStatus;
  try {
    status = await services.waitForStatus(plan, { signal: input.signal });
  } catch (error) {
    await contained.abort(error instanceof Error ? error : new Error("Motion Windows Job Object status wait failed."));
    status = await services.waitForStatus(plan, { timeoutMs: 100 }).catch(() => unavailableStatus());
    if (input.signal.aborted) {
      input.reportProcessContainment(status.status === "enforced"
        ? windowsJobObjectContainmentEvidence(plan, status)
        : windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
      await services.cleanup(plan);
      throw input.signal.reason;
    }
    await services.cleanup(plan);
    if (requireNative) {
      input.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, unavailableStatus()));
      throw unavailableError("native_setup_failed");
    }
    input.reportProcessContainment(windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
    return spawnProcess(input, launch, "windows-taskkill-fallback");
  }

  if (status.status === "enforced") {
    input.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, status));
    return cleanupAfterClose(contained, plan, services.cleanup);
  }

  await contained.abort(new Error("Motion native Windows Job Object setup was unavailable."));
  await services.cleanup(plan);
  if (requireNative) {
    input.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, status));
    throw unavailableError("native_setup_failed");
  }
  input.reportProcessContainment(windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
  if (input.signal.aborted) throw input.signal.reason;
  return spawnProcess(input, launch, "windows-taskkill-fallback");
}

function cleanupAfterClose(
  process: StreamingFfmpegProcess,
  plan: WindowsJobObjectLaunchPlan,
  cleanup: (plan: WindowsJobObjectLaunchPlan) => Promise<void>
): StreamingFfmpegProcess {
  const closed = process.closed.finally(() => cleanup(plan));
  return {
    closed,
    write: (png) => process.write(png),
    end: async () => { await process.end(); return closed; },
    abort: async (reason) => { await process.abort(reason); return closed; }
  };
}

function unavailableError(reasonCode: "native_helper_missing" | "native_setup_failed"): LocalMotionJobError {
  return new LocalMotionJobError(
    "job_process_containment_unavailable",
    reasonCode === "native_helper_missing"
      ? "Streaming FFmpeg requires native Windows Job Object containment, but the trusted launcher is unavailable."
      : "Streaming FFmpeg requires native Windows Job Object containment, but launch setup failed."
  );
}

function unavailableStatus(): WindowsJobObjectStatus {
  return {
    schema: "shellx-motion/windows-job-status@1",
    status: "unavailable",
    mode: "windows-job-object",
    reasonCode: "native_setup_failed"
  };
}
