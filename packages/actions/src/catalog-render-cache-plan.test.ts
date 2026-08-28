import { describe, expect, it } from "vitest";
import { actionCoverage, findAction, planAction, purposeForCall } from "./catalog";

describe("render-cache-plan action catalog", () => {
  it("describes the non-mutating render-tier observation without a receipt or render follow-up", () => {
    const action = findAction("plan attested render reuse");
    const plan = planAction("check exact render cache hit");

    expect(action).toMatchObject({
      id: "motion.render.cache.plan", permission: "render_motion", mutates: false,
      calls: ["motion.render.cache.plan"], surfaces: ["preview", "prompt"],
    });
    expect(action?.verify.join(" ")).toContain("creates no root, lock, descriptor, receipt, artifact, or render authorization");
    expect(plan.steps).toEqual([{ order: 1, call: "motion.render.cache.plan", purpose: purposeForCall("motion.render.cache.plan") }]);
    expect(actionCoverage(["preview", "prompt"]).commands).toContain("motion.render.cache.plan");
  });
});
