import { describe, expect, it } from "vitest";
import { PROCEDURAL_ACTIONS } from "./catalog-procedural.js";
import { findAction } from "./catalog.js";

describe("procedural relationship action catalog", () => {
  it("exposes readable inspection and explicit reversible mutations", () => {
    expect(PROCEDURAL_ACTIONS.map((action) => action.id)).toEqual([
      "motion.procedural.inspect",
      "motion.procedural.relationship.set",
      "motion.procedural.relationship.enabled.set",
      "motion.procedural.relationship.bake",
      "motion.procedural.relationship.detach",
    ]);
    expect(PROCEDURAL_ACTIONS[0]).toMatchObject({
      permission: "read_motion",
      mutates: false,
      calls: ["motion.procedural.inspect"],
    });
    expect(PROCEDURAL_ACTIONS.slice(1).every((action) => (
      action.permission === "edit_motion"
      && action.mutates
      && action.calls.includes("motion.procedural.inspect")
      && action.calls.includes("motion.preview.frame")
      && action.calls.includes("motion.receipts.read")
    ))).toBe(true);
    expect(PROCEDURAL_ACTIONS.find((action) => action.id.endsWith(".bake"))?.calls)
      .toContain("motion.timeline.keyframes.panel");
  });

  it("routes common relationship requests to their exact safe actions", () => {
    expect(findAction("show linked animation properties")?.id).toBe("motion.procedural.inspect");
    expect(findAction("drive animation from audio")?.id).toBe("motion.procedural.relationship.set");
    expect(findAction("disable procedural relationship")?.id).toBe("motion.procedural.relationship.enabled.set");
    expect(findAction("bake expressions to keyframes")?.id).toBe("motion.procedural.relationship.bake");
    expect(findAction("delete relationship without baking")?.id).toBe("motion.procedural.relationship.detach");
  });
});
