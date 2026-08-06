/**
 * Keyframes that carry fields the evaluator ignores must be REPORTED, and only those.
 *
 * The engine reads `atMs`, `value` and an optional `easing`. A keyframe written as
 * `{ atMs, value, t, v }` reads correctly, so it earns no refusal — but the author also wrote `t`
 * and `v`, and nothing told them those were ignored. This suite pins both halves: the warning fires
 * on ignored fields, and it stays silent on every well-formed keyframe, including ones using
 * `easing`.
 *
 * The silent half matters most. A warning that fires on good content is noise, and noise is how a
 * real warning gets ignored later.
 *
 * Dependencies: `./keyframe-readability`, `./types`. Primary caller: vitest.
 */
import { describe, expect, it } from "vitest";
import { ignoredKeyframeFields, ignoredKeyframeFieldsWarning } from "./keyframe-readability";
import type { MotionDocument } from "./types";

/** A minimal one-layer document whose single track carries `entries`. */
function documentWithKeyframes(entries: unknown[]): MotionDocument {
  return {
    id: "motion_probe",
    name: "probe",
    width: 320,
    height: 180,
    fps: 30,
    durationMs: 1000,
    layers: [
      {
        id: "panel",
        type: "shape",
        shape: "rect",
        startMs: 0,
        durationMs: 1000,
        keyframes: { opacity: entries }
      }
    ]
  } as unknown as MotionDocument;
}

describe("ignoredKeyframeFields", () => {
  it("says nothing about keyframes using only the fields the evaluator reads", () => {
    const motion = documentWithKeyframes([
      { atMs: 0, value: 0 },
      { atMs: 500, value: 1, easing: "easeInOut" }
    ]);

    expect(ignoredKeyframeFields(motion)).toEqual([]);
    expect(ignoredKeyframeFieldsWarning(motion)).toBeNull();
  });

  it("reports the ignored field names and where the first one is", () => {
    // Reads correctly - atMs/value are present and well formed - so this earns no refusal, which is
    // exactly why the ignored fields would otherwise pass unmentioned.
    const motion = documentWithKeyframes([{ atMs: 0, value: 0, t: 0, v: 0 }]);

    const ignored = ignoredKeyframeFields(motion);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({
      layerId: "panel",
      target: "opacity",
      index: 0,
      path: "/layers/0/keyframes/opacity/0",
      fields: ["t", "v"]
    });

    const warning = ignoredKeyframeFieldsWarning(motion);
    expect(warning).toContain('"t"');
    expect(warning).toContain('"v"');
    expect(warning).toContain("/layers/0/keyframes/opacity/0");
  });

  it("names every distinct ignored field across the document, once each", () => {
    const motion = documentWithKeyframes([
      { atMs: 0, value: 0, t: 0 },
      { atMs: 500, value: 1, t: 500, comment: "why" }
    ]);

    expect(ignoredKeyframeFields(motion)).toHaveLength(2);
    const warning = ignoredKeyframeFieldsWarning(motion) ?? "";
    expect(warning).toContain('"comment"');
    // "t" appears on both keyframes but is named once, so the line stays readable.
    expect(warning.split('"t"').length - 1).toBe(1);
  });

  it("leaves unreadable keyframes to the refusal rather than double-reporting them", () => {
    // { t, v } with no atMs/value is UNREADABLE - unreadableKeyframesRefusal owns that verdict. This
    // function still names the ignored fields, but the two must not be confused: one blocks, one
    // informs. Asserted here so a later change cannot quietly turn this into a second refusal.
    const motion = documentWithKeyframes([{ t: 0, v: 0 }]);

    const ignored = ignoredKeyframeFields(motion);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].fields).toEqual(["t", "v"]);
  });

  it("ignores tracks that are not arrays and entries that are not objects", () => {
    // Both are the validator's own structural errors; reporting them here would double-count them
    // under a misleading name.
    const motion = documentWithKeyframes([null, 42, "nope"]);
    expect(ignoredKeyframeFields(motion)).toEqual([]);

    const oddTrack = documentWithKeyframes([]);
    (oddTrack.layers[0] as unknown as { keyframes: Record<string, unknown> }).keyframes = {
      opacity: { "0": 1 }
    };
    expect(ignoredKeyframeFields(oddTrack)).toEqual([]);
  });
});
