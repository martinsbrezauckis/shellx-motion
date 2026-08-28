import { describe, expect, it } from "vitest";
import { admitInternalGpuFramePlan } from "../gpu-frame-plan-admission";

interface FixtureModule {
  generateObjectDiversityFixture(): unknown;
}
interface CorePlanModule {
  compileGpuScene2dPlan(motion: unknown, atMs: number): { ok: boolean; plan?: { frame: unknown } };
}

async function coreModules(): Promise<{ fixture: FixtureModule; planner: CorePlanModule }> {
  const fixturePath = new URL("../../../core/src/unadopted/object-diversity-fixture/generator.ts", import.meta.url).href;
  const plannerPath = new URL("../../../core/src/gpu-scene-2d-plan.ts", import.meta.url).href;
  const [fixture, planner] = await Promise.all([
    import(fixturePath) as Promise<FixtureModule>,
    import(plannerPath) as Promise<CorePlanModule>
  ]);
  return { fixture, planner };
}

describe("M260 object-diversity strict-GPU admission", () => {
  it("re-admits Core's deterministic representative plans without renderer translation", async () => {
    const { fixture, planner } = await coreModules();
    for (const atMs of [0, 500, 999]) {
      const result = planner.compileGpuScene2dPlan(fixture.generateObjectDiversityFixture(), atMs);
      expect(result.ok).toBe(true);
      if (!result.ok || !result.plan) continue;
      expect(admitInternalGpuFramePlan(result.plan.frame)).toEqual(result.plan.frame);
    }
  });
});
