import { describe, expect, it } from "vitest";
import { findAction, planAction } from "./catalog.js";

describe("transition preset action discovery", () => {
  it("finds discovery and apply routes from user wording", () => {
    expect(findAction("show transition presets")?.id).toBe("motion.timeline.transition.presets");
    expect(findAction("apply scan sweep")?.id).toBe("motion.timeline.transition.preset.apply");
    expect(planAction("apply card stack transition").steps.map((step) => step.call)).toEqual([
      "motion.state", "motion.timeline.transition.preset.apply", "motion.preview.frame", "motion.receipts.read",
    ]);
  });
});
