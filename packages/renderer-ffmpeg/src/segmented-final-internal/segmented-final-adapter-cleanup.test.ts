import { LocalMotionJobError } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { SegmentedFinalAdapterFailure } from "./segmented-final-adapter-types.js";
import { segmentedFinalCleanupCauses, settleSegmentedFinalAdmittedCleanup } from "./segmented-final-adapter-cleanup.js";

describe("segmented admitted cleanup", () => {
  it("reaps media and host after the first release fails while preserving a governor cancellation", async () => {
    const primary = new LocalMotionJobError("job_cancelled", "controlled cancellation");
    const first = new Error("media release failed"), second = new Error("host release failed");
    const released: string[] = [];
    await expect(settleSegmentedFinalAdmittedCleanup({
      result: undefined,
      thrown: primary,
      releases: [
        Promise.resolve().then(() => { released.push("media"); throw first; }),
        Promise.resolve().then(() => { released.push("host"); throw second; })
      ]
    })).rejects.toBe(primary);
    expect(released).toEqual(["media", "host"]);
    expect(segmentedFinalCleanupCauses(primary)).toEqual([first, second]);
  });

  it("retains every release error alongside a non-governor operation failure", async () => {
    const first = new Error("media release failed"), second = new Error("host release failed");
    const failure = new SegmentedFinalAdapterFailure(
      "controlled_failure",
      { phase: "spool", publication: "not_published" },
      new Error("controlled operation failure")
    );
    const settled = await settleSegmentedFinalAdmittedCleanup({
      result: { ok: false, failure },
      thrown: undefined,
      releases: [Promise.reject(first), Promise.reject(second)]
    });
    expect(settled).toMatchObject({ ok: false, failure: { primaryCause: expect.objectContaining({ message: "controlled operation failure" }), cleanupCauses: [first, second] } });
  });
});
