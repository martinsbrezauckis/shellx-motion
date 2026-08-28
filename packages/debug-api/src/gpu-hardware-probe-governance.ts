/** Host-side scratch/governor boundary for `motion.platform.gpu.probe`. */
import { randomUUID } from "node:crypto";
import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultLocalMotionJobGovernor,
  localMotionJobPolicyFromEnvironment,
  OutputDirectoryReservation,
  type LocalMotionJobContext
} from "@shellx-motion/core";
import {
  gpuBrowserProcessContainmentEvidence,
  isGpuBrowserProcess,
  isPrecontainedGpuBrowser,
  runGpuActiveHardwareProbe,
  type GpuActiveHardwareProbeResult,
  type GpuBrowserProcessTreeContainment
} from "@shellx-motion/renderer-browser";

/**
 * Debug owns the parent scratch root through MotionDebugContext. It reserves an
 * exact private child, reports the browser tree to the common governor, then
 * removes only that empty child after the renderer has closed Chrome.
 */
export async function runGovernedDebugGpuHardwareProbe(scratchRoot: string): Promise<GpuActiveHardwareProbeResult> {
  try {
    const policy = localMotionJobPolicyFromEnvironment();
    const execution = await defaultLocalMotionJobGovernor.run({
      lane: "gpu",
      operation: "gpu.hardware.probe",
      scratchRoot,
      policy: { maxProcessTreeRssBytes: policy.maxProcessTreeRssBytes }
    }, async (job) => {
      const authority = await OutputDirectoryReservation.acquire(join(job.scratchRoot, `gpu-hardware-probe-${randomUUID()}`), { requireAbsent: true });
      try {
        return await runGpuActiveHardwareProbe({
          scratchRoot: authority.path,
          scratchAuthority: authority,
          maxProcessTreeRssBytes: policy.maxProcessTreeRssBytes,
          signal: job.signal,
          onBrowserProcess: (browser) => reportGpuProbeBrowser(job, browser, policy.maxProcessTreeRssBytes)
        });
      } finally {
        await removeOwnedEmptyProbeScratch(authority);
      }
    });
    return execution.value;
  } catch {
    return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "Motion could not establish an admitted host-owned scratch child for the GPU hardware probe." } };
  }
}

function reportGpuProbeBrowser(
  job: LocalMotionJobContext,
  browser: {
    pid: number;
    launcher: "playwright-launch-server" | "precontained-direct-chromium";
    containment: GpuBrowserProcessTreeContainment | null;
  },
  maxProcessTreeRssBytes: number
): void {
  const containment = browser.containment;
  if (!isGpuBrowserProcess(browser)
    || !isPrecontainedGpuBrowser(containment, browser.pid, maxProcessTreeRssBytes)) {
    throw new Error("GPU hardware probe did not expose enforced pre-launch containment.");
  }
  job.watchProcess(browser.pid);
  job.reportProcessContainment(gpuBrowserProcessContainmentEvidence(containment));
}

async function removeOwnedEmptyProbeScratch(authority: OutputDirectoryReservation): Promise<void> {
  await authority.assertCurrent();
  if ((await readdir(authority.path)).length !== 0) {
    throw new Error("GPU hardware probe scratch still contains files; Motion will not remove it recursively.");
  }
  await rmdir(authority.path);
}
