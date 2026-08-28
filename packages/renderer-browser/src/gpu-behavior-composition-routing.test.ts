import { compileGpuSceneBehaviorStaticPlan, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { createGpuStreamingFrameProducer } from "./gpu-streaming-producer";
import { containedGpuJob, fakeGpuRuntime } from "./gpu-streaming-producer.test-support";

describe("GPU behavior composition routing", () => {
  it("renders Core-composed behavior frames and binds the static, source, ordered-frame, and budget identities", async () => {
    const pkg = behaviorPackage();
    const compiled = compileGpuSceneBehaviorStaticPlan(pkg.motion);
    expect(compiled.ok).toBe(true); if (!compiled.ok) return;
    const frames: string[] = [];
    const producer = createGpuStreamingFrameProducer({
      pkg,
      staticPlan: compiled.plan.basePlan,
      behaviorStaticPlan: compiled.plan,
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => {}); if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        opened.session.render = async (plan, options) => {
          frames.push(JSON.stringify(plan));
          return await render(plan, options);
        };
        return opened;
      }
    });
    await producer.produce({ async write() {} }, containedGpuJob());
    expect(frames).toHaveLength(2);
    expect(frames[0]).not.toEqual(frames[1]);
    expect(producer.evidence.behaviors).toMatchObject({
      schema: "shellx-motion/gpu-scene-behavior-streaming@1",
      staticFingerprint: compiled.plan.fingerprint,
      behaviorSourceSha256: compiled.plan.behaviorSourceSha256,
      targetLayerIds: ["shape"],
      frames: [expect.objectContaining({ index: 0, atUs: 0 }), expect.objectContaining({ index: 1, atUs: 500_000 })],
      framePlanSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      frameBudgetSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("refuses a substituted behavior wrapper before Chromium opens and never falls back to legacy frames", async () => {
    const pkg = behaviorPackage();
    const compiled = compileGpuSceneBehaviorStaticPlan(pkg.motion);
    expect(compiled.ok).toBe(true); if (!compiled.ok) return;
    let opens = 0;
    const forged = { ...compiled.plan, fingerprint: "0".repeat(64) };
    const producer = createGpuStreamingFrameProducer({
      pkg,
      staticPlan: compiled.plan.basePlan,
      behaviorStaticPlan: forged,
      openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); }
    });
    await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_static_plan_invalid" });
    expect(opens).toBe(0);
  });

  it("honors cancellation before any behavior resource or runtime output", async () => {
    const pkg = behaviorPackage();
    const compiled = compileGpuSceneBehaviorStaticPlan(pkg.motion);
    expect(compiled.ok).toBe(true); if (!compiled.ok) return;
    const controller = new AbortController(); controller.abort(new Error("stop behavior"));
    let opens = 0, writes = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      staticPlan: compiled.plan.basePlan,
      behaviorStaticPlan: compiled.plan,
      openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); }
    });
    await expect(producer.produce({ async write() { writes += 1; } }, containedGpuJob(controller.signal))).rejects.toThrow("stop behavior");
    expect({ opens, writes }).toEqual({ opens: 0, writes: 0 });
  });
});

function behaviorPackage(): MotionPackage {
  return {
    root: "/behavior-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "gpu-behavior", name: "GPU behavior", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "gpu-behavior-motion", name: "GPU behavior", durationMs: 1_000, fps: 2, width: 32, height: 32,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", width: 8, height: 8, transform: { x: 2, y: 2 }, startMs: 0, durationMs: 1_000 }],
      behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 10, velocityY: 0, gravityY: 0 } }] }
    }
  };
}
