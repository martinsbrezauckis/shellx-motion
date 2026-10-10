import { describe, expect, it } from "vitest";
import { createCoordinatorTerminalEvidence } from "./job-coordinator-terminal-evidence";
import { createMotionRenderPlan } from "./render-plan";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

describe("coordinator terminal evidence", () => {
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "binds a planned %s outcome to exact compact evidence without an artifact claim",
    (outcome) => {
      const evidence = createCoordinatorTerminalEvidence(plannedJob(), outcome, {
        receiptId: "receipt-final-1",
        producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" },
        warnings: ["bounded warning"]
      });

      expect(evidence).toMatchObject({
        schema: "shellx-motion/job-evidence@1",
        jobId: "cut:planned-final",
        callerId: "cut:workspace",
        operation: "render.final",
        planFingerprint: plannedJob().renderPlan.fingerprint,
        outcome,
        warnings: ["bounded warning"],
        receiptIds: ["receipt-final-1"],
        producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" },
        artifacts: [],
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(Object.isFrozen(evidence)).toBe(true);
    }
  );

  it("represents a caught terminal outcome without inventing receipt, producer, or artifact evidence", () => {
    expect(createCoordinatorTerminalEvidence(plannedJob(), "failed")).toMatchObject({
      outcome: "failed", warnings: [], receiptIds: [], producerEvidence: null, artifacts: []
    });
  });

  it("retains all warnings admitted by the streamed-final adapter", () => {
    const warnings = Array.from({ length: 64 }, (_, index) => `renderer warning ${index}`);
    expect(createCoordinatorTerminalEvidence(plannedJob(), "succeeded", { warnings }))
      .toMatchObject({ warnings });
  });

  it("omits only the optional envelope when exact terminal mirrors are not path-free", () => {
    for (const unsafe of [
      { warnings: ["failed near /tmp/output.mp4"] },
      { warnings: ["authorization bearer value"] },
      { receiptId: "receipt/unsafe" },
      { producerEvidence: { frameLane: "gpu" as const, schema: "not a schema" } }
    ]) {
      expect(createCoordinatorTerminalEvidence(plannedJob(), "failed", unsafe)).toBeUndefined();
    }
  });

  it("does not add V1 evidence to legacy or non-final jobs", () => {
    expect(createCoordinatorTerminalEvidence({
      ...plannedJob(), renderPlan: undefined
    }, "succeeded")).toBeUndefined();
    expect(createCoordinatorTerminalEvidence({
      ...plannedJob(), operation: "preview.frame"
    }, "succeeded")).toBeUndefined();
  });
});

function plannedJob() {
  return {
    jobId: "cut:planned-final",
    callerId: "cut:workspace",
    operation: "render.final",
    renderPlan: createMotionRenderPlan({
      package: { id: "package-demo", manifestSha256: HASH_A },
      motion: { id: "motion-demo", documentSha256: HASH_B },
      lineage: {
        schema: "shellx-motion/package-render-lineage@1",
        manifestSha256: HASH_A,
        motionSha256: HASH_B
      },
      output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: HASH_C },
      quality: { mode: "none" },
      requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
      runtime: {
        engine: "shellx-motion@0.2.66",
        routeFingerprint: HASH_D,
        presetFingerprint: HASH_E,
        capabilityFingerprint: HASH_F
      },
      compatibility: { version: 1, state: "current" }
    })
  } as const;
}
