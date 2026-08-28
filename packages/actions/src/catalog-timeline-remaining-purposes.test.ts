import { describe, expect, it } from "vitest";
import { TIMELINE_REMAINING_PURPOSES } from "./catalog-timeline-remaining-purposes.js";

const EXPECTED_DEFAULT_PURPOSE_TIMELINE_COMMANDS = [
  "motion.timeline.spatial.position.upsert",
  "motion.timeline.spatial.position.move",
  "motion.timeline.spatial.position.delete",
  "motion.timeline.relations.inspect",
  "motion.timeline.relations.upsert",
  "motion.timeline.relations.enabled.set",
  "motion.timeline.relations.remove",
  "motion.timeline.relations.detach",
  "motion.timeline.relations.bake",
  "motion.timeline.relation-actions.inspect",
  "motion.timeline.relation-actions.upsert",
  "motion.timeline.relation-actions.remove",
  "motion.timeline.relation-actions.apply",
  "motion.timeline.scene3d-animation.inspect",
  "motion.timeline.scene3d-animation.track.upsert",
  "motion.timeline.scene3d-animation.track.remove",
  "motion.timeline.scene3d-animation.keyframe.upsert",
  "motion.timeline.scene3d-animation.keyframe.delete",
  "motion.timeline.scene3d-animation.keyframe.move",
  "motion.timeline.layout-gap-animation.inspect",
  "motion.timeline.layout-gap-animation.track.upsert",
  "motion.timeline.layout-gap-animation.track.remove",
  "motion.timeline.layout-gap-animation.keyframe.upsert",
  "motion.timeline.layout-gap-animation.keyframe.delete",
  "motion.timeline.layout-gap-animation.keyframe.move",
  "motion.timeline.behaviors.inspect",
  "motion.timeline.behaviors.upsert",
  "motion.timeline.behaviors.remove",
  "motion.timeline.layer.text-runs.inspect",
  "motion.timeline.layer.text-runs.replace",
  "motion.timeline.layer.text-runs.remove",
  "motion.timeline.group.create",
  "motion.timeline.group.child.add",
  "motion.timeline.group.child.remove",
  "motion.timeline.group.child.move",
  "motion.timeline.group.child.reorder",
  "motion.timeline.group.wrap",
  "motion.timeline.group.unwrap",
  "motion.timeline.group.delete",
  "motion.timeline.group.duplicate",
  "motion.timeline.group.trim",
  "motion.timeline.group.root.reorder",
  "motion.timeline.group.split",
  "motion.timeline.layout.inspect",
  "motion.timeline.layout.compile",
  "motion.timeline.layout.apply",
  "motion.timeline.layout.remove",
  "motion.timeline.adjustment.fixed.inspect",
  "motion.timeline.adjustment.fixed.set",
  "motion.timeline.adjustment.fixed.remove",
  "motion.timeline.gradient.color-keyframes.inspect",
  "motion.timeline.gradient.color-keyframes.upsert",
  "motion.timeline.gradient.color-keyframes.delete",
  "motion.timeline.gradient.color-keyframes.move",
  "motion.timeline.points.range.inspect",
  "motion.timeline.points.trajectory.inspect",
  "motion.timeline.points.point.upsert",
  "motion.timeline.points.point.move",
  "motion.timeline.points.point.delete",
  "motion.timeline.points.point.range.delete",
] as const;

describe("remaining timeline purpose map", () => {
  it("covers exactly the 60 R3-audited timeline fallback commands", () => {
    expect(Object.keys(TIMELINE_REMAINING_PURPOSES).sort()).toEqual([...EXPECTED_DEFAULT_PURPOSE_TIMELINE_COMMANDS].sort());
    expect(Object.keys(TIMELINE_REMAINING_PURPOSES)).toHaveLength(60);
  });

  it("has a unique, non-empty reviewed purpose for every command", () => {
    const purposes = Object.values(TIMELINE_REMAINING_PURPOSES);

    expect(purposes).toHaveLength(60);
    expect(new Set(purposes).size).toBe(60);
    for (const purpose of purposes) {
      expect(purpose.trim()).not.toBe("");
      expect(purpose).not.toMatch(/^Run motion\./);
    }
  });

  it("keeps family-specific operational boundaries visible", () => {
    const purpose = (command: keyof typeof TIMELINE_REMAINING_PURPOSES) => TIMELINE_REMAINING_PURPOSES[command];

    expect(purpose("motion.timeline.spatial.position.upsert")).toMatch(/aligned transform\.x\/transform\.y.*copy-on-write/i);
    expect(purpose("motion.timeline.relations.bake")).toMatch(/full-document.*3,600.*not equivalent/i);
    expect(purpose("motion.timeline.relation-actions.apply")).toMatch(/exact-package-base.*32 created layers.*128 generated keyframe/i);
    expect(purpose("motion.timeline.scene3d-animation.track.upsert")).toMatch(/64 tracks.*64 exact-microsecond.*never a generic property path/i);
    expect(purpose("motion.timeline.layout-gap-animation.track.remove")).toMatch(/restores static-layout removal authority.*no renderer route/i);
    expect(purpose("motion.timeline.behaviors.upsert")).toMatch(/closed path-follow or analytic transform.*one-hour/i);
    expect(purpose("motion.timeline.layer.text-runs.replace")).toMatch(/32 runs.*16 distinct font assets.*16 KiB/i);
    expect(purpose("motion.timeline.group.wrap")).toMatch(/1 through 256 direct siblings/i);
    expect(purpose("motion.timeline.layout.remove")).toMatch(/fingerprint-bound.*trusted authority.*C2 gap track refuses/i);
    expect(purpose("motion.timeline.adjustment.fixed.set")).toMatch(/vignette.*film grain.*vignette-then-filmGrain/i);
    expect(purpose("motion.timeline.gradient.color-keyframes.inspect")).toMatch(/fixed-topology/i);
    expect(purpose("motion.timeline.gradient.color-keyframes.upsert")).toMatch(/at most 32 snapshots.*at most 16 colors/i);
    expect(purpose("motion.timeline.points.range.inspect")).toMatch(/without mutation, interpolation, or history.*256 points and 12 samples/i);
  });
});
