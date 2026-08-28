import { availableParallelism, freemem, totalmem } from "node:os";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const RSS_QUANTUM_BYTES = 256 * MIB;
const MIN_ADAPTIVE_RSS_BYTES = 512 * MIB;
const CALIBRATED_RICH_RENDER_RSS_BYTES = 6 * GIB;
const MAX_ADAPTIVE_RSS_BYTES = 64 * GIB;
const FALLBACK_RSS_BYTES = 6 * GIB;

export const PORTABLE_POINTS_PER_LAYER = 8_192;
export const ABSOLUTE_POINTS_PER_LAYER = 65_536;
export const PORTABLE_POINT_STATE_RECORDS_PER_LAYER = 65_536;
export const PORTABLE_POINT_CLOUD_BYTES_PER_LAYER = 8 * MIB;

export interface MotionHostCapacityFacts {
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  logicalCpuCount: number;
}

export interface MotionHostRenderCapacity {
  schema: "shellx-motion/host-render-capacity@1";
  source: "host-adaptive" | "operator-override" | "fallback";
  memory: {
    totalBytes: number | null;
    freeBytesAtResolution: number | null;
    reserveBytes: number | null;
    availableForMotionBytes: number | null;
  };
  jobs: {
    maxConcurrentJobs: number;
    maxProcessTreeRssBytes: number;
  };
  points: {
    tier: "portable" | "elevated" | "dense" | "maximum";
    logicalCpuCount: number;
    portablePointsPerLayer: typeof PORTABLE_POINTS_PER_LAYER;
    maxPointsPerLayer: number;
    maxStateRecordsPerLayer: number;
    maxPayloadBytesPerLayer: number;
    maxLayersPerDocument: 4;
  };
}

export interface ResolveMotionHostCapacityOptions {
  env?: NodeJS.ProcessEnv;
  facts?: MotionHostCapacityFacts;
}

/** Resolve the stable per-process resource ceiling used by governors, renderers, and `doctor`. */
export function resolveMotionHostRenderCapacity(
  options: ResolveMotionHostCapacityOptions = {},
): MotionHostRenderCapacity {
  const env = options.env ?? process.env;
  const facts = sanitizeFacts(options.facts ?? readMotionHostCapacityFacts());
  const maxConcurrentJobs = boundedInteger(env.SHELLX_MOTION_MAX_CONCURRENT_JOBS, 2, 1, 16);
  const override = optionalBoundedInteger(env.SHELLX_MOTION_MAX_JOB_RSS_BYTES, 64 * MIB, 1024 * GIB);
  const adaptive = facts ? adaptiveRssBudget(facts, maxConcurrentJobs) : null;
  const maxProcessTreeRssBytes = override ?? adaptive?.maxProcessTreeRssBytes ?? FALLBACK_RSS_BYTES;
  const source = override !== null ? "operator-override" : adaptive ? "host-adaptive" : "fallback";
  const logicalCpuCount = facts?.logicalCpuCount ?? 1;
  const pointTier = pointCapacityTier(maxProcessTreeRssBytes, logicalCpuCount);
  const factor = pointTier.maxPointsPerLayer / PORTABLE_POINTS_PER_LAYER;
  return {
    schema: "shellx-motion/host-render-capacity@1",
    source,
    memory: {
      totalBytes: facts?.totalMemoryBytes ?? null,
      freeBytesAtResolution: facts?.freeMemoryBytes ?? null,
      reserveBytes: adaptive?.reserveBytes ?? null,
      availableForMotionBytes: adaptive?.availableForMotionBytes ?? null,
    },
    jobs: { maxConcurrentJobs, maxProcessTreeRssBytes },
    points: {
      tier: pointTier.tier,
      logicalCpuCount,
      portablePointsPerLayer: PORTABLE_POINTS_PER_LAYER,
      maxPointsPerLayer: pointTier.maxPointsPerLayer,
      maxStateRecordsPerLayer: PORTABLE_POINT_STATE_RECORDS_PER_LAYER * factor,
      maxPayloadBytesPerLayer: PORTABLE_POINT_CLOUD_BYTES_PER_LAYER * factor,
      maxLayersPerDocument: 4,
    },
  };
}

/** One process-wide snapshot prevents `doctor`, render admission, and the governor from drifting. */
export const defaultMotionHostRenderCapacity = resolveMotionHostRenderCapacity();

export function readMotionHostCapacityFacts(): MotionHostCapacityFacts {
  return {
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    logicalCpuCount: availableParallelism(),
  };
}

function adaptiveRssBudget(facts: MotionHostCapacityFacts, concurrentJobs: number): {
  reserveBytes: number;
  availableForMotionBytes: number;
  maxProcessTreeRssBytes: number;
} {
  const reserveBytes = Math.max(0, Math.min(
    facts.totalMemoryBytes - MIN_ADAPTIVE_RSS_BYTES,
    Math.max(4 * GIB, Math.ceil(facts.totalMemoryBytes / 5)),
  ));
  // Darwin's `freemem()` excludes reclaimable file cache and can report only ~4 GiB free on an
  // otherwise healthy 16 GiB host. Treating that number as the whole admissible pool collapses the
  // governor to 512 MiB and kills ordinary Chromium renders. Preserve the calibrated 6 GiB/job
  // envelope whenever physical RAM can still leave the declared reserve across all admitted jobs;
  // genuinely free memory may raise the ceiling above that floor, while total RAM remains the cap.
  const calibratedPoolFloorBytes = Math.min(
    facts.totalMemoryBytes - reserveBytes,
    CALIBRATED_RICH_RENDER_RSS_BYTES * concurrentJobs,
  );
  const availableForMotionBytes = Math.max(
    0,
    Math.min(
      facts.totalMemoryBytes - reserveBytes,
      Math.max(facts.freeMemoryBytes - reserveBytes, calibratedPoolFloorBytes),
    ),
  );
  const rawPerJob = Math.floor(availableForMotionBytes / concurrentJobs);
  const rounded = Math.floor(rawPerJob / RSS_QUANTUM_BYTES) * RSS_QUANTUM_BYTES;
  return {
    reserveBytes,
    availableForMotionBytes,
    maxProcessTreeRssBytes: clamp(rounded, MIN_ADAPTIVE_RSS_BYTES, MAX_ADAPTIVE_RSS_BYTES),
  };
}

function pointCapacityTier(maxRssBytes: number, logicalCpuCount: number): {
  tier: MotionHostRenderCapacity["points"]["tier"];
  maxPointsPerLayer: number;
} {
  if (maxRssBytes >= 16 * GIB && logicalCpuCount >= 8) return { tier: "maximum", maxPointsPerLayer: 65_536 };
  if (maxRssBytes >= 12 * GIB && logicalCpuCount >= 4) return { tier: "dense", maxPointsPerLayer: 32_768 };
  if (maxRssBytes >= 8 * GIB && logicalCpuCount >= 2) return { tier: "elevated", maxPointsPerLayer: 16_384 };
  return { tier: "portable", maxPointsPerLayer: PORTABLE_POINTS_PER_LAYER };
}

function sanitizeFacts(facts: MotionHostCapacityFacts): MotionHostCapacityFacts | null {
  if (!safePositive(facts.totalMemoryBytes) || !safeNonNegative(facts.freeMemoryBytes)) return null;
  if (!Number.isSafeInteger(facts.logicalCpuCount) || facts.logicalCpuCount < 1 || facts.logicalCpuCount > 4_096) return null;
  return {
    totalMemoryBytes: facts.totalMemoryBytes,
    freeMemoryBytes: Math.min(facts.freeMemoryBytes, facts.totalMemoryBytes),
    logicalCpuCount: facts.logicalCpuCount,
  };
}

function optionalBoundedInteger(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  return optionalBoundedInteger(raw, min, max) ?? fallback;
}

function safePositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function safeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
