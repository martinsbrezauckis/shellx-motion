import { describe, expect, it } from "vitest";
import { COMPOSITING_ACTIONS } from "./catalog-compositing.js";

describe("compositing action catalog", () => {
  it("exposes inspect, set, and remove with mutation and verification truth", () => {
    expect(COMPOSITING_ACTIONS.map((action) => action.id)).toEqual([
      "motion.compositing.graph.inspect",
      "motion.compositing.graph.set",
      "motion.compositing.graph.remove",
    ]);
    expect(COMPOSITING_ACTIONS[0]).toMatchObject({
      permission: "read_motion",
      mutates: false,
      calls: ["motion.compositing.graph.inspect"],
    });
    expect(COMPOSITING_ACTIONS.slice(1).every((action) => (
      action.permission === "edit_motion"
      && action.mutates
      && action.calls.includes("motion.preview.frame")
      && action.calls.includes("motion.receipts.read")
    ))).toBe(true);
  });
});
