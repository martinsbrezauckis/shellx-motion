import { describe, expect, it } from "vitest";
import { GpuFinalAdmittedCleanupError, releaseAdmittedGpuFinalDelivery } from "./gpu-final-admitted-cleanup.js";

describe("admitted GPU final cleanup", () => {
  it("does not suppress a legacy no-module delivery release failure", async () => {
    await expect(releaseAdmittedGpuFinalDelivery(async () => { throw new Error("delivery failed"); })).rejects.toMatchObject({
      code: "gpu_final_cleanup_failed", failures: [expect.objectContaining({ scope: "delivery" })]
    });
  });

  it("settles and reports both module cleanup failures in one typed outcome", async () => {
    let leaseReleased = false;
    const failure = await releaseAdmittedGpuFinalDelivery(
      async () => { throw new Error("delivery failed"); },
      { async release() { leaseReleased = true; throw new Error("lease failed"); } } as never
    ).then(() => undefined, (error: unknown) => error);
    expect(leaseReleased).toBe(true);
    expect(failure).toBeInstanceOf(GpuFinalAdmittedCleanupError);
    expect(failure).toMatchObject({ failures: [
      expect.objectContaining({ scope: "delivery" }),
      expect.objectContaining({ scope: "effect-module-lease" })
    ] });
  });

  it("still releases the opaque lease when a delivery seam throws synchronously", async () => {
    let leaseReleased = false;
    const failure = await releaseAdmittedGpuFinalDelivery(
      (() => { throw new Error("synchronous delivery failure"); }) as never,
      { async release() { leaseReleased = true; return { released: true }; } } as never
    ).then(() => undefined, (error: unknown) => error);
    expect(leaseReleased).toBe(true);
    expect(failure).toMatchObject({ code: "gpu_final_cleanup_failed", failures: [expect.objectContaining({ scope: "delivery" })] });
  });

  it("treats a non-owned lease release as a cleanup failure", async () => {
    await expect(releaseAdmittedGpuFinalDelivery(
      async () => {}, { async release() { return { released: false }; } } as never
    )).rejects.toMatchObject({ code: "gpu_final_cleanup_failed", failures: [expect.objectContaining({ scope: "effect-module-lease" })] });
  });

  it("closes delivery before it starts an opaque lease release", async () => {
    const events: string[] = [];
    await expect(releaseAdmittedGpuFinalDelivery(
      async () => { events.push("delivery:start"); await Promise.resolve(); events.push("delivery:end"); },
      { async release() { events.push("lease"); return { released: true }; } } as never
    )).resolves.toEqual({ effectModuleLease: "released" });
    expect(events).toEqual(["delivery:start", "delivery:end", "lease"]);
  });
});
