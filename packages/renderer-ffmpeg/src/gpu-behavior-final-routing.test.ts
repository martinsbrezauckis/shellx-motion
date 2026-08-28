import { compileGpuSceneBehaviorStaticPlan, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { preflightGpuDelivery, prepareAdmittedGpuDelivery } from "./streaming-final-gpu";

describe("GPU behavior final routing", () => {
  it("keeps legacy preflight refusing while admitted direct preparation carries the parallel Core behavior plan", async () => {
    const pkg = behaviorPackage();
    const input = { pkg, frameLane: "gpu" as const, outputPath: "/unused/behavior.mp4" };
    expect(preflightGpuDelivery(input)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("does not yet support document behaviors@1") } });
    const behavior = compileGpuSceneBehaviorStaticPlan(pkg.motion);
    expect(behavior.ok).toBe(true); if (!behavior.ok) return;
    const admitted = preflightGpuDelivery(input, behavior.plan.basePlan, behavior.plan);
    expect(admitted).toMatchObject({ ok: true, staticPlan: { fingerprint: behavior.plan.baseStaticFingerprint }, behaviorStaticPlan: { fingerprint: behavior.plan.fingerprint } });
    if (!admitted.ok) return;
    const prepared = await prepareAdmittedGpuDelivery(input, admitted.staticPlan, jobContext(), admitted.behaviorStaticPlan);
    expect(prepared).toMatchObject({ ok: true, delivery: { staticPlan: { fingerprint: behavior.plan.baseStaticFingerprint }, behaviorStaticPlan: { fingerprint: behavior.plan.fingerprint } } });
    if (prepared.ok) await prepared.delivery.release();
  });

  it("refuses motion-blur behavior targets before FFmpeg resource work", () => {
    const pkg = behaviorPackage();
    pkg.motion.layers[0]!.effects = { motionBlur: { samples: 2, shutterAngle: 180 } };
    expect(compileGpuSceneBehaviorStaticPlan(pkg.motion)).toMatchObject({ ok: false, failure: { message: expect.stringContaining("shutter samples evaluate behaviors") } });
  });

  it("refuses a stale admitted wrapper when the retained behavior document gains an active video", () => {
    const pkg = behaviorPackage();
    const behavior = compileGpuSceneBehaviorStaticPlan(pkg.motion);
    expect(behavior.ok).toBe(true); if (!behavior.ok) return;
    pkg.motion.layers.push({ id: "video", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 });
    pkg.manifest.assets.push("assets/clip.mp4");
    expect(preflightGpuDelivery({ pkg, frameLane: "gpu", outputPath: "/unused/stale.mp4" }, behavior.plan.basePlan, behavior.plan)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("video sources") } });
  });
});

function jobContext() {
  return {
    job: { admission: "pre-acquired" as const, jobId: "behavior-final", scratchRoot: "/tmp", maxProcessTreeRssBytes: 512 * 1024 * 1024, signal: new AbortController().signal, watchProcess() {}, reportSandbox() {} },
    runner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
  };
}

function behaviorPackage(): MotionPackage {
  return {
    root: "/behavior-final-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "behavior-final", name: "Behavior final", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "behavior-final-motion", name: "Behavior final", durationMs: 1_000, fps: 2, width: 32, height: 32,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#fff", transform: { x: 1, y: 1 }, width: 8, height: 8, startMs: 0, durationMs: 1_000 }],
      behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] }
    }
  };
}
