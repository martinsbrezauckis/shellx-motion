import { describe, expect, it } from "vitest";
import { resolveMotionHostRenderCapacity } from "./host-render-capacity";
import { localMotionJobPolicyFromEnvironment } from "./local-motion-job-policy";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("local Motion job policy", () => {
  it("derives every bounded environment policy field from an explicit capacity", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: { SHELLX_MOTION_MAX_CONCURRENT_JOBS: "4" },
      facts: { totalMemoryBytes: 64 * GIB, freeMemoryBytes: 48 * GIB, logicalCpuCount: 16 },
    });
    const policy = localMotionJobPolicyFromEnvironment({
      SHELLX_MOTION_MAX_QUEUE_DEPTH: "7",
      SHELLX_MOTION_MAX_QUEUE_WAIT_MS: "900",
      SHELLX_MOTION_MAX_JOB_MS: "1200",
      SHELLX_MOTION_MIN_FREE_SCRATCH_BYTES: String(3 * MIB),
      SHELLX_MOTION_SCRATCH_RESERVATION_BYTES: String(5 * MIB),
      SHELLX_MOTION_RSS_POLL_MS: "50",
    }, capacity);

    expect(policy).toEqual({
      maxConcurrentJobs: capacity.jobs.maxConcurrentJobs,
      maxQueueDepth: 7,
      maxQueueWaitMs: 900,
      maxWallClockMs: 1_200,
      minFreeScratchBytes: 3 * MIB,
      scratchReservationBytes: 5 * MIB,
      maxProcessTreeRssBytes: capacity.jobs.maxProcessTreeRssBytes,
      rssPollIntervalMs: 50,
    });
  });

  it("retains the existing fallbacks for absent and invalid policy values", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 16 * GIB, freeMemoryBytes: 7 * GIB, logicalCpuCount: 8 },
    });
    expect(localMotionJobPolicyFromEnvironment({
      SHELLX_MOTION_MAX_QUEUE_DEPTH: "-1",
      SHELLX_MOTION_MAX_QUEUE_WAIT_MS: "99",
      SHELLX_MOTION_MAX_JOB_MS: "not-a-number",
      SHELLX_MOTION_MIN_FREE_SCRATCH_BYTES: "-1",
      SHELLX_MOTION_SCRATCH_RESERVATION_BYTES: String(16 * 1024 * GIB + 1),
      SHELLX_MOTION_RSS_POLL_MS: "24",
    }, capacity)).toEqual({
      maxConcurrentJobs: capacity.jobs.maxConcurrentJobs,
      maxQueueDepth: 64,
      maxQueueWaitMs: 5 * 60_000,
      maxWallClockMs: 30 * 60_000,
      minFreeScratchBytes: 256 * MIB,
      scratchReservationBytes: 64 * MIB,
      maxProcessTreeRssBytes: capacity.jobs.maxProcessTreeRssBytes,
      rssPollIntervalMs: 1_000,
    });
  });
});
