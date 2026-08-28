/** Discovery and permission proof for the bounded author-time cutout rig bake. */
import { describe, expect, it } from "vitest";
import { findAction } from "./catalog.js";

describe("cutout rig action catalog", () => {
  it("discovers the bake from agent wording without promising a live rig", () => {
    const action = findAction("split illustration into animated parts");

    expect(action).toMatchObject({
      id: "motion.timeline.cutout.rig.bake",
      permission: "edit_motion",
      mutates: true,
      calls: [
        "motion.timeline.cutout.rig.bake",
        "motion.timeline.keyframes.panel",
        "motion.preview.frame",
        "motion.receipts.read",
      ],
    });
    expect(action?.verify.join(" ")).toContain("does not claim live parent-child equivalence between samples");
  });
});
