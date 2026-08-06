/**
 * The falsifier for the silent-keyframe-drop defect, kept permanently.
 *
 * The failure this covers, measured: an external agent authored a 15-second piece with 309 keyframes
 * written as `{ t, v }` instead of `{ atMs, value }`. The evaluator dropped all 309 without a word,
 * `motion.package.validate` answered `valid: true`, the render reported success, and the delivered
 * MP4 was frozen for ~90% of its duration.
 *
 * Two directions are pinned here, and both matter:
 *   - a document the evaluator cannot animate is REFUSED, by a message that names the correct form;
 *   - a correctly authored document is untouched — no refusal, no new warning, no changed reading.
 *
 * Plus the invariant that makes the fix stick: the evaluator's gate and `validateDocument` cannot
 * disagree. Anything `isReadableMotionKeyframe` rejects must produce at least one validation error at
 * that keyframe's path, so a future edit cannot quietly reopen the gap by loosening one side.
 *
 * These fixtures reproduce the measured 309-keyframe failure shape inline so the suite remains
 * self-contained and does not depend on non-shipping evidence.
 */
import { describe, expect, it } from "vitest";
import {
  assertReadableMotionKeyframes,
  isReadableMotionKeyframe,
  motionKeyframeCount,
  motionKeyframeReadFailure,
  readNumericKeyframes,
  readStringKeyframes,
  unreadableKeyframesRefusal,
  unreadableMotionKeyframes
} from "./keyframe-readability";
import { interpolateColor, interpolateNumber } from "./timeline";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument } from "./types";

/** A document whose single shape layer carries exactly the supplied keyframe map, valid or not. */
function documentWithKeyframes(keyframes: Record<string, unknown>): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_keyframe_readability",
    name: "Keyframe Readability Probe",
    durationMs: 2000,
    fps: 30,
    width: 640,
    height: 360,
    background: "#101820",
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    assets: [],
    layers: [{
      id: "panel",
      type: "shape",
      shape: "rectangle",
      fill: "#172033",
      startMs: 0,
      durationMs: 2000,
      width: 320,
      height: 120,
      transform: { x: 40, y: 100, scale: 1, rotation: 0 },
      keyframes
    }]
  } as unknown as MotionDocument;
}

/** The shape the external agent actually produced, at the scale it produced it. */
const GROK_SHAPED_KEYFRAMES = {
  opacity: [{ t: 0, v: 0 }, { t: 600, v: 0.92, easing: "ease-out" }],
  "transform.x": [{ t: 0, v: -80 }, { t: 700, v: 40, easing: "back-out" }]
};

const HEALTHY_KEYFRAMES = {
  opacity: [{ atMs: 0, value: 0 }, { atMs: 600, value: 0.92, easing: "ease-out" }],
  "transform.x": [{ atMs: 0, value: -80 }, { atMs: 700, value: 40, easing: "back-out" }]
};

describe("keyframe readability — the one rule", () => {
  it("accepts the documented form and nothing that only looks like it", () => {
    expect(isReadableMotionKeyframe({ atMs: 0, value: 1 })).toBe(true);
    expect(isReadableMotionKeyframe({ atMs: 500, value: "#13d3ff", easing: "ease-out" })).toBe(true);
    expect(isReadableMotionKeyframe({ t: 0, v: 1 })).toBe(false);
    expect(isReadableMotionKeyframe({ atMs: "0", value: 1 })).toBe(false);
    expect(isReadableMotionKeyframe({ atMs: Number.NaN, value: 1 })).toBe(false);
    expect(isReadableMotionKeyframe({ atMs: 0, value: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isReadableMotionKeyframe({ atMs: 0, value: "   " })).toBe(false);
    expect(isReadableMotionKeyframe({ atMs: 0 })).toBe(false);
    expect(isReadableMotionKeyframe(null)).toBe(false);
    expect(isReadableMotionKeyframe([0, 1])).toBe(false);
  });

  it("names the wrong field rather than only the missing one", () => {
    expect(motionKeyframeReadFailure({ t: 0, v: 1 }))
      .toBe('keyframe time is written as "t"; the engine reads "atMs" (milliseconds);'
        + ' keyframe value is written as "v"; the engine reads "value"');
    expect(motionKeyframeReadFailure({ time: 0, value: 1 })).toContain('written as "time"');
    expect(motionKeyframeReadFailure({ frame: 3, value: 1 })).toContain('written as "frame"');
    // No recognisable alias: fall back to stating the requirement.
    expect(motionKeyframeReadFailure({ zz: 1, value: 1 })).toBe('keyframe "atMs" must be a finite number of milliseconds');
    expect(motionKeyframeReadFailure({ atMs: 0, value: 1 })).toBeNull();
  });

  it("requires a finite atMs, which the evaluator's reader previously never checked", () => {
    // `{ atMs: "0", value: 5 }` used to pass readNumericKeyframes, then poison the sort comparator
    // with NaN and interpolate to NaN — a wrong number rather than a clean refusal.
    expect(readNumericKeyframes([{ atMs: "0", value: 5 }, { atMs: 100, value: 9 }] as never)).toBeNull();
    expect(interpolateNumber([{ atMs: "0", value: 5 }, { atMs: 100, value: 9 }] as never, 50)).toBeNull();
    expect(readNumericKeyframes([{ atMs: 0, value: 5 }, { atMs: 100, value: 9 }] as never))
      .toEqual([{ atMs: 0, value: 5 }, { atMs: 100, value: 9 }]);
  });

  it("refuses a colour track it cannot read instead of guessing an order", () => {
    // interpolateColor had no reader at all: an unreadable atMs made its comparator return NaN.
    expect(interpolateColor([{ t: 0, v: "#000000" }, { t: 500, v: "#ffffff" }] as never, 250)).toBeNull();
    expect(interpolateColor([{ atMs: 0, value: "#000000" }, { atMs: 500, value: "#ffffff" }] as never, 250))
      .toBe("#808080");
    expect(readStringKeyframes([{ atMs: 0, value: "#000000" }, { t: 5, v: "#fff" }] as never)).toBeNull();
  });
});

describe("keyframe readability — the refusal", () => {
  it("refuses the real document's keyframe shape, locating every offender", () => {
    const motion = documentWithKeyframes(GROK_SHAPED_KEYFRAMES);
    const refusal = unreadableKeyframesRefusal(motion);

    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe("keyframes_unreadable");
    expect(refusal!.keyframeCount).toBe(4);
    expect(refusal!.totalKeyframeCount).toBe(4);
    expect(refusal!.targetCount).toBe(2);
    expect(refusal!.truncated).toBe(false);
    expect(refusal!.message).toContain("4 of 4 keyframes cannot be read by the timeline evaluator");
    expect(refusal!.message).toContain("/layers/0/keyframes/opacity/0");
    // The correct form must be named, or the author cannot act on the refusal.
    expect(refusal!.suggestedAction).toContain('{ "atMs": <milliseconds>, "value": <number or string> }');
    expect(refusal!.keyframes.map((entry) => entry.path)).toEqual([
      "/layers/0/keyframes/opacity/0",
      "/layers/0/keyframes/opacity/1",
      "/layers/0/keyframes/transform.x/0",
      "/layers/0/keyframes/transform.x/1"
    ]);
  });

  it("refuses a partly broken track — one discarded keyframe is still discarded work", () => {
    const motion = documentWithKeyframes({
      "transform.x": [{ atMs: 0, value: 40 }, { t: 350, v: 65 }, { atMs: 700, value: 90 }]
    });
    const refusal = unreadableKeyframesRefusal(motion)!;

    expect(refusal.keyframeCount).toBe(1);
    expect(refusal.totalKeyframeCount).toBe(3);
    expect(refusal.keyframes[0]!.path).toBe("/layers/0/keyframes/transform.x/1");
  });

  it("caps the reported list but never the counts", () => {
    const many = Array.from({ length: 260 }, (_, index) => ({ t: index * 10, v: index }));
    const refusal = unreadableKeyframesRefusal(documentWithKeyframes({ opacity: many }))!;

    expect(refusal.keyframeCount).toBe(260);
    expect(refusal.keyframes).toHaveLength(200);
    expect(refusal.truncated).toBe(true);
  });

  it("throws at render entry with the same message the refusal carries", () => {
    expect(() => assertReadableMotionKeyframes(documentWithKeyframes(GROK_SHAPED_KEYFRAMES)))
      .toThrow(/cannot be read by the timeline evaluator/);
    expect(() => assertReadableMotionKeyframes(documentWithKeyframes(GROK_SHAPED_KEYFRAMES)))
      .toThrow(/"atMs": <milliseconds>/);
  });
});

describe("keyframe readability — the healthy path is untouched", () => {
  it("says nothing at all about a correctly authored document", () => {
    const motion = documentWithKeyframes(HEALTHY_KEYFRAMES);

    expect(unreadableMotionKeyframes(motion)).toEqual([]);
    expect(unreadableKeyframesRefusal(motion)).toBeNull();
    expect(motionKeyframeCount(motion)).toBe(4);
    expect(() => assertReadableMotionKeyframes(motion)).not.toThrow();
  });

  it("still animates the healthy document, values unchanged", () => {
    expect(interpolateNumber(HEALTHY_KEYFRAMES["transform.x"] as never, 0)).toBe(-80);
    expect(interpolateNumber(HEALTHY_KEYFRAMES["transform.x"] as never, 700)).toBe(40);
    expect(interpolateNumber(HEALTHY_KEYFRAMES.opacity as never, 300)).toBeGreaterThan(0);
  });

  it("says nothing about a document with no keyframes at all", () => {
    expect(unreadableKeyframesRefusal(documentWithKeyframes({}))).toBeNull();
    expect(motionKeyframeCount(documentWithKeyframes({}))).toBe(0);
  });

  it("leaves structural malformations to the validator rather than double-reporting them", () => {
    // "keyframes must be an object" and "must be an array" are validate's own errors; reporting
    // them here as unreadable keyframes would count one mistake twice under a misleading name.
    expect(unreadableKeyframesRefusal(documentWithKeyframes({ opacity: { atMs: 0, value: 1 } }))).toBeNull();
  });
});

describe("the evaluator and the validator cannot drift", () => {
  const cases: Array<{ name: string; keyframes: Record<string, unknown> }> = [
    { name: "the real {t,v} shape", keyframes: GROK_SHAPED_KEYFRAMES },
    { name: "a string atMs", keyframes: { opacity: [{ atMs: "0", value: 0.5 }] } },
    { name: "a NaN atMs", keyframes: { opacity: [{ atMs: Number.NaN, value: 0.5 }] } },
    { name: "a missing value", keyframes: { opacity: [{ atMs: 0 }] } },
    { name: "an infinite value", keyframes: { "transform.x": [{ atMs: 0, value: Number.POSITIVE_INFINITY }] } },
    { name: "an empty-string colour", keyframes: { fill: [{ atMs: 0, value: "  " }] } },
    { name: "a mixed track", keyframes: { "transform.x": [{ atMs: 0, value: 1 }, { t: 5, v: 2 }] } }
  ];

  for (const { name, keyframes } of cases) {
    it(`reports a validation error for every keyframe the evaluator would drop: ${name}`, async () => {
      const motion = documentWithKeyframes(keyframes);
      const unreadable = unreadableMotionKeyframes(motion);
      expect(unreadable.length).toBeGreaterThan(0);

      const result = await validateDocument(await loadSchema("motion"), JSON.parse(JSON.stringify(motion)));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Every dropped keyframe must be named by the validator at its own path — otherwise validate
      // would pass something the evaluator discards, which is the whole defect.
      for (const entry of unreadable) {
        expect(result.errors.some((error) => error.path.startsWith(entry.path)), `${entry.path} unreported`).toBe(true);
      }
    });
  }

  it("raises no keyframe validation error for a document the evaluator reads fully", async () => {
    const motion = documentWithKeyframes(HEALTHY_KEYFRAMES);
    const result = await validateDocument(await loadSchema("motion"), JSON.parse(JSON.stringify(motion)));

    expect(unreadableMotionKeyframes(motion)).toEqual([]);
    expect(result).toEqual({ ok: true });
  });

  it("names the wrong field in the validator's own error messages too", async () => {
    const motion = documentWithKeyframes(GROK_SHAPED_KEYFRAMES);
    const result = await validateDocument(await loadSchema("motion"), JSON.parse(JSON.stringify(motion)));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "/layers/0/keyframes/opacity/0/atMs",
      message: 'must be a finite number; this keyframe writes its time as "t"'
    });
    expect(result.errors).toContainEqual({
      path: "/layers/0/keyframes/opacity/0/value",
      message: 'must be a finite number; this keyframe writes its value as "v"'
    });
  });
});
