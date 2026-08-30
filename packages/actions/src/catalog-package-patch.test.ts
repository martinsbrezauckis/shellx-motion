import { describe, expect, it } from "vitest";
import { findAction, planAction } from "./catalog";

describe("package patch action discovery", () => {
  it("routes bounded layer batches to one validated copy-on-write patch", () => {
    for (const request of ["patch package", "apply JSON patch", "bulk edit package", "add 179 layers", "bulk patch add layers", "append a batch of layers", "create 200 layers", "create many layers"]) {
      expect(findAction(request)?.id).toBe("motion.package.patch");
    }
    expect(findAction("create text layer")?.id).toBe("motion.timeline.layer.create");

    const plan = planAction("add 179 layers");
    expect(plan.steps.map((step) => step.call)).toEqual(["motion.state", "motion.package.patch", "motion.receipts.read"]);
    expect(plan.steps.map((step) => step.call)).not.toContain("motion.timeline.layer.create");
    expect(plan.examples).toEqual(expect.arrayContaining([
      expect.objectContaining({ call: "motion.package.patch", args: expect.objectContaining({ packageRoot: "<host-approved-existing-package>", outDir: "<host-approved-empty-or-absent-output>", patch: expect.any(Array) }) }),
      expect.objectContaining({
        call: "motion.package.patch",
        args: expect.objectContaining({
          patch: [expect.objectContaining({
            op: "add",
            path: "/layers/-",
            value: expect.objectContaining({ id: "caption-001", type: "text" })
          })]
        })
      })
    ]));
    expect(plan.cautions).toContain("For a large, bounded layer batch, send one motion.package.patch call with one add operation for each complete layer at /layers/-. Motion validates the copied document once; do not turn that batch into repeated motion.timeline.layer.create calls.");
    expect(plan.cautions).toContain("Requires a host-granted edit_motion tier. When Motion reports the held tier, the refusal is `motion.package.patch requires edit_motion; this session holds <granted-tier>.` A caller cannot raise that grant.");
    expect(plan.related.map((action) => action.id)).toEqual(["motion.timeline.layer.create", "motion.revision.transaction"]);
  });
});
