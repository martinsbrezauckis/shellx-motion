import { describe, expect, it } from "vitest";
import { evaluateMotionLayoutGapAnimation } from "./motion-layout-gap-animation-evaluate";
import { inspectMotionLayoutGapAnimation, removeMotionLayoutGapAnimationTrack, upsertMotionLayoutGapAnimationKeyframe, upsertMotionLayoutGapAnimationTrack } from "./motion-layout-gap-animation-authoring";
import { readMotionLayoutGapAnimationDescriptor } from "./motion-layout-gap-animation-read";
import { MOTION_LAYOUT_GAP_ANIMATION_EASINGS } from "./motion-layout-gap-animation-types";
import { runMotionLayoutDebug } from "./motion-layout-debug";
import { mintMotionLayoutRemovalAuthorization } from "./motion-layout-removal-authority";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument, MotionLayer } from "./types";

describe("persisted layout gap animation", () => {
  it("binds one static application, samples exact microseconds, and regenerates projection from patches.before", () => {
    const source = document();
    const applied = apply(source);
    const application = applied.layoutApplications?.[0];
    if (!application) throw new Error("expected static layout application");
    const track = { id: "gap-track", applicationId: application.id, applicationFingerprint: application.fingerprint, childLayerIds: [...application.childLayerIds], keyframes: [{ atUs: 100_000, value: 4, easing: "linear" as const }, { atUs: 500_000, value: 20, easing: "linear" as const }] };
    const inserted = upsertMotionLayoutGapAnimationTrack(applied, { track });
    expect(applied).toEqual(apply(source));
    expect(inserted.action).toBe("track_inserted");
    expect(inserted.changedPaths).toEqual(["/layoutGapAnimation"]);

    const base = one(evaluateMotionLayoutGapAnimation(inserted.motion, 0));
    const atFirst = one(evaluateMotionLayoutGapAnimation(inserted.motion, 100_000));
    const middle = one(evaluateMotionLayoutGapAnimation(inserted.motion, 300_000));
    const end = one(evaluateMotionLayoutGapAnimation(inserted.motion, 500_000));
    const held = one(evaluateMotionLayoutGapAnimation(inserted.motion, 900_000));
    expect([base.gap, atFirst.gap, middle.gap, end.gap, held.gap]).toEqual([2, 4, 12, 20, 20]);
    const staticAfter = application.patches.find((patch) => patch.layerId === "b")?.after.transform.x;
    expect(base.projection.find((entry) => entry.layerId === "b")?.transform.x).toBe(staticAfter);
    expect(middle.projection.find((entry) => entry.layerId === "b")?.transform.x).toBe((staticAfter ?? 0) + 10);
    expect(Object.isFrozen(middle.projection)).toBe(true);

    const insertedKeyframe = upsertMotionLayoutGapAnimationKeyframe(inserted.motion, { trackId: track.id, keyframe: { atUs: 300_000, value: 13, easing: "ease-in" } });
    expect(inspectMotionLayoutGapAnimation(insertedKeyframe.motion).tracks[0]?.keyframeCount).toBe(3);
    expect(() => upsertMotionLayoutGapAnimationKeyframe(insertedKeyframe.motion, { trackId: track.id, keyframe: { atUs: 300_000, value: 13, easing: "ease-in" } })).toThrow(/did not change/);
  });

  it("keeps static removal dangling-track-safe and restores its exact static document when the final track is removed", () => {
    const applied = apply(document());
    const application = applied.layoutApplications?.[0];
    if (!application) throw new Error("expected static layout application");
    const active = upsertMotionLayoutGapAnimationTrack(applied, { track: binding(application) }).motion;
    const removal = runMotionLayoutDebug({ schema: "shellx-motion/debug-layout-intent@1", operation: "remove", motion: active, createdAt: "2026-08-21T00:00:00.000Z", removal: { schema: "shellx-motion/debug-layout-removal@1", applicationId: application.id, applicationFingerprint: application.fingerprint } }, { packageId: "pkg_gap", removalAuthorization: mintMotionLayoutRemovalAuthorization({ packageId: "pkg_gap", applicationId: application.id, applicationFingerprint: application.fingerprint, receiptId: "layout-receipt" }) });
    expect(removal.status === "refused" ? removal.issues.map((issue) => issue.code) : []).toContain("remove.animation_present");
    const removed = removeMotionLayoutGapAnimationTrack(active, { trackId: "gap-track" });
    expect(removed.action).toBe("track_removed");
    expect(removed.afterStoreSha256).toBeNull();
    expect(removed.motion).toEqual(applied);
  });

  it("refuses stale layout state, competing transform keyframes, and hostile descriptors before changing source", () => {
    const applied = apply(document());
    const application = applied.layoutApplications?.[0];
    if (!application) throw new Error("expected static layout application");
    const source = structuredClone(applied);
    const stale = structuredClone(applied);
    const child = stale.layers.find((layer) => layer.id === "b");
    if (!child?.transform) throw new Error("expected child");
    child.transform.x = (child.transform.x ?? 0) + 1;
    expect(() => upsertMotionLayoutGapAnimationTrack(stale, { track: binding(application) })).toThrow(/static application output is stale/);
    expect(applied).toEqual(source);

    const keyed = structuredClone(applied);
    const keyedChild = keyed.layers.find((layer) => layer.id === "a");
    if (!keyedChild) throw new Error("expected child");
    keyedChild.keyframes = { "transform.x": [{ atMs: 0, value: 0 }] };
    expect(() => upsertMotionLayoutGapAnimationTrack(keyed, { track: binding(application) })).toThrow(/animated_box|admissible/);
    expect(applied).toEqual(source);

    const hostile = structuredClone(applied) as MotionDocument & { layoutGapAnimation?: unknown };
    let reads = 0;
    Object.defineProperty(hostile, "layoutGapAnimation", { enumerable: true, get: () => { reads += 1; return undefined; } });
    expect(() => inspectMotionLayoutGapAnimation(hostile)).toThrow(/data field/);
    expect(reads).toBe(0);
    expect(applied).toEqual(source);
  });

  it("admits canonical 128-code-unit layout identifiers and refuses a second L1a application or 129 code units", () => {
    const longChildId = "😀".repeat(64);
    const applied = apply(document(["a", longChildId]));
    const application = applied.layoutApplications?.[0];
    if (!application) throw new Error("expected static layout application");
    expect(application.childLayerIds).toContain(longChildId);
    expect(upsertMotionLayoutGapAnimationTrack(applied, { track: binding(application) }).motion.layoutGapAnimation?.tracks).toHaveLength(1);

    const track = { ...binding(application), childLayerIds: [longChildId] };
    expect(readMotionLayoutGapAnimationDescriptor({ schema: "shellx-motion/layout-gap-animation@1", tracks: [track] }).tracks[0]?.childLayerIds).toEqual([longChildId]);
    expect(() => readMotionLayoutGapAnimationDescriptor({
      schema: "shellx-motion/layout-gap-animation@1",
      tracks: [track, { ...track, id: "second-track" }],
    })).toThrow(/at most 1 entries/);
    expect(() => readMotionLayoutGapAnimationDescriptor({
      schema: "shellx-motion/layout-gap-animation@1",
      tracks: [{ ...track, childLayerIds: ["😀".repeat(65)] }],
    })).toThrow(/1\.\.128 UTF-16 code units/);
  });

  it("admits only non-overshooting C2 easings, keeping a descending gap non-negative at every sample", () => {
    const applied = apply(document());
    const application = applied.layoutApplications?.[0];
    if (!application) throw new Error("expected static layout application");
    for (const easing of MOTION_LAYOUT_GAP_ANIMATION_EASINGS) {
      const candidate = {
        ...binding(application),
        keyframes: [
          { atUs: 0, value: 2, easing },
          { atUs: 500_000, value: 0, easing: "linear" as const },
        ],
      };
      const motion = upsertMotionLayoutGapAnimationTrack(applied, { track: candidate }).motion;
      expect(one(evaluateMotionLayoutGapAnimation(motion, 0)).gap).toBeGreaterThanOrEqual(0);
      expect(one(evaluateMotionLayoutGapAnimation(motion, 250_000)).gap).toBeGreaterThanOrEqual(0);
      expect(one(evaluateMotionLayoutGapAnimation(motion, 500_000)).gap).toBe(0);
      expect(one(evaluateMotionLayoutGapAnimation(motion, 900_000)).gap).toBe(0);
    }
    for (const easing of [
      "back-out",
      "bounce-out",
      "spring-gentle",
      "spring-snappy",
      "spring-bouncy",
      "cubic-bezier(0.2, 1.4, 0.2, 1)",
      "steps(4, end)",
      { type: "spring", stiffness: 100, damping: 8 },
    ]) {
      expect(() => readMotionLayoutGapAnimationDescriptor({
        schema: "shellx-motion/layout-gap-animation@1",
        tracks: [{
          ...binding(application),
          keyframes: [{ atUs: 0, value: 2, easing }],
        }],
      })).toThrow(/non-overshooting C2 layout gap easing/);
    }
  });

  it("is named-refused by GPU planning before resource admission", () => {
    const applied = apply(document());
    const application = applied.layoutApplications?.[0];
    if (!application) throw new Error("expected static layout application");
    const active = upsertMotionLayoutGapAnimationTrack(applied, { track: binding(application) }).motion;
    expect(compileGpuSceneStaticPlan(active)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU static planning does not yet support document layoutGapAnimation@1." } });
    expect(compileGpuScene2dPlan(active, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU frame planning does not yet support document layoutGapAnimation@1." } });
  });
});

function one(frame: ReturnType<typeof evaluateMotionLayoutGapAnimation>) { const track = frame?.tracks[0]; if (!track) throw new Error("expected one frame track"); return track; }
function binding(application: NonNullable<MotionDocument["layoutApplications"]>[number]) { return { id: "gap-track", applicationId: application.id, applicationFingerprint: application.fingerprint, childLayerIds: [...application.childLayerIds], keyframes: [{ atUs: 0, value: 2, easing: "linear" as const }, { atUs: 500_000, value: 20, easing: "linear" as const }] }; }
function apply(motion: MotionDocument): MotionDocument { const result = runMotionLayoutDebug({ schema: "shellx-motion/debug-layout-intent@1", operation: "apply", motion, groupId: "pack", createdAt: "2026-08-21T00:00:00.000Z", layout: layout(), repeaters: [] }); if (result.status !== "ok" || result.operation !== "apply") throw new Error(result.status === "refused" ? result.issues.map((issue) => issue.message).join("; ") : "expected apply"); return result.motion; }
function document(childIds = ["a", "b"]): MotionDocument { return { schema: "shellx-motion/motion@1", id: "motion_gap", name: "Gap", durationMs: 1_000, fps: 30, width: 100, height: 100, layers: [group("pack", childIds), ...childIds.map(child)], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }; }
function layout() { return { schema: "shellx-motion/layout@1" as const, kind: "row" as const, width: 100, height: 100, padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 2, align: { x: "start" as const, y: "center" as const }, distribution: "start" as const, overflow: "clip" as const }; }
function group(id: string, childLayerIds: string[]): MotionLayer { return { id, type: "group", startMs: 0, durationMs: 900, childLayerIds }; }
function child(id: string): MotionLayer { return { id, type: "shape", shape: "rect", startMs: 0, durationMs: 100, transform: { x: 0, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1 } }; }
