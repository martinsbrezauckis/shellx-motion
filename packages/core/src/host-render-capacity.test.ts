import { describe, expect, it } from "vitest";
import { resolveMotionHostRenderCapacity } from "./host-render-capacity";
import { localMotionJobPolicyFromEnvironment } from "./job-governor";

const GIB = 1024 ** 3;

describe("adaptive host render capacity", () => {
  it("turns a free 64 GiB workstation into a maximum-density point host", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 64 * GIB, freeMemoryBytes: 48 * GIB, logicalCpuCount: 16 },
    });
    expect(capacity).toMatchObject({
      source: "host-adaptive",
      jobs: { maxConcurrentJobs: 2 },
      points: { tier: "maximum", maxPointsPerLayer: 65_536 },
    });
    expect(capacity.jobs.maxProcessTreeRssBytes).toBeGreaterThan(16 * GIB);
    expect(capacity.jobs.maxProcessTreeRssBytes).toBeLessThan(20 * GIB);
    expect(localMotionJobPolicyFromEnvironment({}, capacity)).toMatchObject({
      maxConcurrentJobs: 2,
      maxProcessTreeRssBytes: capacity.jobs.maxProcessTreeRssBytes,
    });
  });

  it("divides safe memory across configured concurrent jobs", () => {
    const facts = { totalMemoryBytes: 64 * GIB, freeMemoryBytes: 48 * GIB, logicalCpuCount: 16 };
    const two = resolveMotionHostRenderCapacity({ env: {}, facts });
    const four = resolveMotionHostRenderCapacity({ env: { SHELLX_MOTION_MAX_CONCURRENT_JOBS: "4" }, facts });
    expect(four.jobs.maxProcessTreeRssBytes).toBe(two.jobs.maxProcessTreeRssBytes / 2);
    expect(four.points.tier).toBe("elevated");
  });

  it("keeps a memory-constrained host at the portable point floor", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 16 * GIB, freeMemoryBytes: 7 * GIB, logicalCpuCount: 8 },
    });
    expect(capacity.jobs.maxProcessTreeRssBytes).toBe(6 * GIB);
    expect(capacity.points).toMatchObject({ tier: "portable", maxPointsPerLayer: 8_192 });
  });

  it("preserves the calibrated rich-render floor when free memory excludes reclaimable cache", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 16 * GIB, freeMemoryBytes: 4 * GIB, logicalCpuCount: 10 },
    });
    expect(capacity).toMatchObject({
      source: "host-adaptive",
      memory: { reserveBytes: 4 * GIB, availableForMotionBytes: 12 * GIB },
      jobs: { maxConcurrentJobs: 2, maxProcessTreeRssBytes: 6 * GIB },
      points: { tier: "portable", maxPointsPerLayer: 8_192 },
    });
  });

  it("keeps the trusted explicit RSS override authoritative", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: { SHELLX_MOTION_MAX_JOB_RSS_BYTES: String(24 * GIB) },
      facts: { totalMemoryBytes: 8 * GIB, freeMemoryBytes: 2 * GIB, logicalCpuCount: 8 },
    });
    expect(capacity).toMatchObject({
      source: "operator-override",
      jobs: { maxProcessTreeRssBytes: 24 * GIB },
      points: { tier: "maximum", maxPointsPerLayer: 65_536 },
    });
  });

  it("falls back safely when host facts are invalid", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: Number.NaN, freeMemoryBytes: -1, logicalCpuCount: 0 },
    });
    expect(capacity).toMatchObject({
      source: "fallback",
      memory: { totalBytes: null, freeBytesAtResolution: null },
      jobs: { maxProcessTreeRssBytes: 6 * GIB },
      points: { tier: "portable", maxPointsPerLayer: 8_192 },
    });
  });

  it("never derives a negative reserve on a very small constrained host", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 256 * 1024 ** 2, freeMemoryBytes: 128 * 1024 ** 2, logicalCpuCount: 1 },
    });
    expect(capacity.memory.reserveBytes).toBe(0);
    expect(capacity.jobs.maxProcessTreeRssBytes).toBe(512 * 1024 ** 2);
  });
});
