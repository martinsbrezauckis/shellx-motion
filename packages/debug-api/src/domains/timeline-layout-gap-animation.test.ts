import { describe, expect, it } from "vitest";
import { dispatchTimelineLayoutGapAnimationAuthoringCommand } from "./timeline-layout-gap-animation-authoring.js";
import { readTimelineLayoutGapAnimationIntent, TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS } from "./timeline-layout-gap-animation.js";

describe("timeline layout-gap animation transport", () => {
  it("keeps all six commands closed and rejects hostile input before package loading", async () => {
    const track = binding();
    expect(readTimelineLayoutGapAnimationIntent(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.inspect, { packageRoot: "/package" })).toMatchObject({ ok: true, intent: { kind: "inspect" } });
    expect(readTimelineLayoutGapAnimationIntent(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert, { packageRoot: "/package", outDir: "/out", track })).toMatchObject({ ok: true, intent: { kind: "track.upsert", track: { id: "gap" } } });
    const keyframe = readTimelineLayoutGapAnimationIntent(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeUpsert, { packageRoot: "/package", outDir: "/out", trackId: "gap", keyframe: { atUs: 10, value: 3, easing: "linear" } });
    expect(keyframe).toMatchObject({ ok: true, intent: { kind: "keyframe.upsert", keyframe: { atUs: 10, value: 3, easing: "linear" } } });
    if (!keyframe?.ok || keyframe.intent.kind !== "keyframe.upsert") throw new Error("Expected a parsed keyframe upsert intent.");
    expect(Object.getPrototypeOf(keyframe.intent.keyframe)).toBe(Object.prototype);
    expect(readTimelineLayoutGapAnimationIntent(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeMove, { packageRoot: "/package", outDir: "/out", trackId: "gap", fromAtUs: 1, toAtUs: 2 })).toMatchObject({ ok: true, intent: { kind: "keyframe.move" } });

    let loads = 0;
    const rejected = await dispatchTimelineLayoutGapAnimationAuthoringCommand(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert, { packageRoot: "/package", outDir: "/out", track, accidental: true }, { packageLoader: async () => { loads += 1; throw new Error("must not load"); } });
    expect(rejected).toEqual({ ok: false, error: { code: "invalid_args", message: "Unknown argument: accidental." }, warnings: [] });
    expect(loads).toBe(0);

    const hostile = { packageRoot: "/package", outDir: "/out", track: binding() } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(hostile, "track", { enumerable: true, get: () => { reads += 1; return binding(); } });
    expect(readTimelineLayoutGapAnimationIntent(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert, hostile)).toEqual({ ok: false, problem: "Arguments.track must be an enumerable data field." });
    expect(reads).toBe(0);
    expect(readTimelineLayoutGapAnimationIntent(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeMove, { packageRoot: "/package", outDir: "/out", trackId: "gap", fromAtUs: 1, toAtUs: 1 })).toEqual({ ok: false, problem: "fromAtUs and toAtUs must differ for an exact layout gap keyframe move." });
  });
});

function binding() { return { id: "gap", applicationId: "layout-aaaaaaaaaaaaaaaaaaaaaaaa", applicationFingerprint: "a".repeat(64), childLayerIds: ["a", "b"], keyframes: [{ atUs: 0, value: 2, easing: "linear" }] }; }
