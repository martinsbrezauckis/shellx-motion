import { describe, expect, it } from "vitest";
import { findAction, planAction, purposeForCall } from "./catalog";

describe("package asset import action discovery", () => {
  it("discovers ordinary non-template asset import with its package-validation follow-up", () => {
    expect(findAction("copy external file into package")?.id).toBe("motion.package.asset.import");
    const plan = planAction("import package asset");
    expect(plan.action).toMatchObject({ id: "motion.package.asset.import", permission: "edit_motion", mutates: true });
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.state", "motion.package.asset.import", "motion.package.validate", "motion.receipts.read",
    ]);
    expect(plan.examples).toEqual([expect.objectContaining({
      call: "motion.package.asset.import",
      args: expect.objectContaining({ assetRef: "assets/imports/hero.png" }),
    })]);
    expect(purposeForCall("motion.package.asset.import")).toContain("without a template-specific binding");
  });
});
