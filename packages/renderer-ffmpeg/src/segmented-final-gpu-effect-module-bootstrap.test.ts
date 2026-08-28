import type { GpuEffectModuleBeginUseLease } from "@shellx-motion/renderer-browser";
import { describe, expect, it } from "vitest";
import { segmentedGpuBootstrapCleanup } from "./segmented-final-gpu-effect-module-bootstrap.js";

describe("segmented GPU module bootstrap cleanup", () => {
  it("releases the opaque lease after a host cleanup failure", async () => {
    const calls: string[] = [];
    const lease = testLease(calls, { released: true });
    const [cleanup] = segmentedGpuBootstrapCleanup({
      lease,
      releases: [async () => { calls.push("host"); throw new Error("host release failed"); }]
    });
    await expect(cleanup).rejects.toThrow("host release failed");
    expect(calls).toEqual(["host", "lease"]);
  });

  it("aggregates the host and lease causes only after attempting both in order", async () => {
    const calls: string[] = [];
    const lease = testLease(calls, { released: false });
    const [cleanup] = segmentedGpuBootstrapCleanup({
      lease,
      releases: [async () => { calls.push("host"); throw new Error("host release failed"); }]
    });
    await expect(cleanup).rejects.toMatchObject({ name: "AggregateError", errors: [expect.any(Error), expect.any(Error)] });
    expect(calls).toEqual(["host", "lease"]);
  });
});

function testLease(calls: string[], result: { released: boolean }): GpuEffectModuleBeginUseLease {
  return { async release() { calls.push("lease"); return result; } } as GpuEffectModuleBeginUseLease;
}
