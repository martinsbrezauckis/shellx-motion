import {
  defaultMotionHostRenderCapacity,
  resolveMotionHostRenderCapacity,
  type MotionHostRenderCapacity,
} from "./host-render-capacity";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface LocalMotionJobPolicy {
  maxConcurrentJobs: number;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  maxWallClockMs: number;
  minFreeScratchBytes: number;
  scratchReservationBytes: number;
  maxProcessTreeRssBytes: number;
  rssPollIntervalMs: number;
}

export function localMotionJobPolicyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  hostCapacity: MotionHostRenderCapacity = env === process.env
    ? defaultMotionHostRenderCapacity
    : resolveMotionHostRenderCapacity({ env }),
): LocalMotionJobPolicy {
  return {
    maxConcurrentJobs: hostCapacity.jobs.maxConcurrentJobs,
    maxQueueDepth: boundedEnvInteger(env.SHELLX_MOTION_MAX_QUEUE_DEPTH, 64, 0, 1_024),
    maxQueueWaitMs: boundedEnvInteger(env.SHELLX_MOTION_MAX_QUEUE_WAIT_MS, 5 * 60_000, 100, 60 * 60_000),
    maxWallClockMs: boundedEnvInteger(env.SHELLX_MOTION_MAX_JOB_MS, 30 * 60_000, 100, 24 * 60 * 60_000),
    minFreeScratchBytes: boundedEnvInteger(env.SHELLX_MOTION_MIN_FREE_SCRATCH_BYTES, 256 * MIB, 0, 16 * 1024 * GIB),
    scratchReservationBytes: boundedEnvInteger(env.SHELLX_MOTION_SCRATCH_RESERVATION_BYTES, 64 * MIB, 0, 16 * 1024 * GIB),
    maxProcessTreeRssBytes: hostCapacity.jobs.maxProcessTreeRssBytes,
    rssPollIntervalMs: boundedEnvInteger(env.SHELLX_MOTION_RSS_POLL_MS, 1_000, 25, 60_000),
  };
}

function boundedEnvInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}
