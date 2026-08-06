/**
 * Phase classification and the end-to-end plan it produces.
 *
 * The wire-level proof lives in `debug-server/src/mcp-agent-guidance.test.ts`. This file pins the
 * classifier itself, where the interesting risk is OVER-triggering: promoting a narrow edit into a
 * ten-step authoring pipeline would be as wrong as dropping the authoring half was.
 */
import { describe, expect, it } from "vitest";
import { guideAction, planAction } from "./catalog.js";
import { detectMotionWorkflow } from "./catalog-workflows.js";

describe("multi-phase request detection", () => {
  it("treats a create-and-render request as the whole pipeline", () => {
    const workflow = detectMotionWorkflow("create original animated package and render mp4");

    expect(workflow?.phases.map((phase) => phase.id)).toEqual(["create", "layers", "animate", "preview", "render"]);
    // "layers" and "preview" were never typed: a keyframe needs a layer, and a render deserves a
    // frame check first. Both are declared as implied rather than passed off as requested.
    expect(workflow?.requestedPhaseIds).toEqual(["create", "animate", "render"]);
    expect(workflow?.impliedPhaseIds).toEqual(["layers", "preview"]);
  });

  it("returns a plan that starts at authoring and ends at evidence", () => {
    const plan = planAction("create original animated package and render mp4");

    expect(plan.action?.id).toBe("motion.package.create");
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.package.create",
      "motion.package.validate",
      "motion.state",
      "motion.timeline.layer.create",
      "motion.timeline.inspect",
      "motion.timeline.keyframe.upsert",
      "motion.preview.frame",
      "motion.render.final",
      "motion.render.status",
      "motion.receipts.read"
    ]);
    // Every step is a real, distinct command: a plan that repeats motion.receipts.read four times
    // reads as padding and trains an agent to skim the list.
    expect(new Set(plan.steps.map((step) => step.call)).size).toBe(plan.steps.length);
    expect(plan.steps.every((step) => step.purpose.length > 0)).toBe(true);
  });

  it("gives guide and plan the same answer for the same request", () => {
    const request = "create package with animated layers and render";

    expect(guideAction(request).steps).toEqual(planAction(request).steps);
  });

  it("states the tier span so a refusal mid-pipeline is not a surprise", () => {
    const plan = planAction("create original animated package and render mp4");

    expect(plan.cautions.some((caution) => caution.includes("write_local"))).toBe(true);
    expect(plan.cautions.some((caution) => caution.includes("cannot raise its own tier"))).toBe(true);
  });

  it.each([
    // One phase each: the single-action catalog already answers these correctly.
    ["create new empty motion package"],
    ["render this lower third as mp4"],
    ["add opacity keyframe with ease out"],
    ["preview it"],
    ["trim selected layer duration"],
    // Two signals but no ORIGIN phase: an edit plus a check, not an authoring pipeline. This exact
    // request regressed during development, which is why it is pinned.
    ["change transition easing and preview it"],
    // "create" without a subject noun is a layer edit inside a package that already exists.
    ["create text layer"],
    ["import this glb model and render it in canvas"]
  ])("leaves %j on the single-action path", (request) => {
    expect(detectMotionWorkflow(request)).toBeNull();
    expect(planAction(request).workflow).toBeUndefined();
  });

  it("routes an add-layers-and-render request through a preview", () => {
    const workflow = detectMotionWorkflow("add layers and export video");

    expect(workflow?.phases.map((phase) => phase.id)).toEqual(["layers", "preview", "render"]);
    expect(workflow?.calls.at(-1)).toBe("motion.receipts.read");
  });
});
