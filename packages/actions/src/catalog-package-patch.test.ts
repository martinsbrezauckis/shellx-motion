import { describe, expect, it } from "vitest";
import { findAction, planAction } from "./catalog";

describe("package patch action discovery", () => {
  it("discovers natural bulk-edit wording and keeps authority boundaries visible", () => {
    for (const request of ["patch package", "apply JSON patch", "bulk edit package"]) expect(findAction(request)?.id).toBe("motion.package.patch");
    const plan = planAction("apply JSON patch");
    expect(plan.steps.map((step) => step.call)).toEqual(["motion.state", "motion.package.patch", "motion.receipts.read"]);
    expect(plan.examples).toEqual([expect.objectContaining({ call: "motion.package.patch", args: expect.objectContaining({ packageRoot: "<host-approved-existing-package>", outDir: "<host-approved-empty-or-absent-output>", patch: expect.any(Array) }) })]);
    expect(plan.cautions).toContain("Requires a host-granted edit_motion tier. When Motion reports the held tier, the refusal is `motion.package.patch requires edit_motion; this session holds <granted-tier>.` A caller cannot raise that grant.");
    expect(plan.related.map((action) => action.id)).toEqual(["motion.template.controls", "motion.template.apply", "motion.revision.transaction"]);
  });
});
