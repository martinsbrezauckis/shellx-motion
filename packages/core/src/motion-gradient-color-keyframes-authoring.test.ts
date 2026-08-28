import { describe, expect, it } from "vitest";
import {
  deleteMotionGradientColorKeyframe,
  inspectMotionGradientColorKeyframes,
  moveMotionGradientColorKeyframe,
  upsertMotionGradientColorKeyframe,
} from "./motion-gradient-color-keyframes-authoring";
import { MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA } from "./motion-gradient-color-keyframes";
import type { MotionDocument, MotionLayer } from "./types";
import { loadSchema, validateDocument } from "./validate";

function layer(): MotionLayer {
  return {
    id: "field", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
    gradient: {
      type: "linear", angle: 45,
      stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }],
    },
  };
}

function motion(value: MotionLayer = layer()): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gradient-keys", name: "Gradient keys", durationMs: 1_000, fps: 25, width: 100, height: 100,
    layers: [value, { id: "other", type: "text", text: "original", startMs: 0, durationMs: 1_000 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  };
}

function snapshot(atUs: number, colors = ["#ff0000", "#0000ff"], easing?: unknown): Record<string, unknown> {
  return { atUs, colors, ...(easing === undefined ? {} : { easing }) };
}

describe("gradient color keyframe COW authoring", () => {
  it("inspects absent records, then upserts complete vectors without changing the source", () => {
    const source = motion();
    const before = structuredClone(source);
    expect(inspectMotionGradientColorKeyframes(source, { layerId: "field" })).toMatchObject({
      topology: { type: "linear", stopCount: 2, offsets: [0, 1] }, colorKeyframes: null, evaluation: null,
    });
    const inserted = upsertMotionGradientColorKeyframe(source, { layerId: "field", snapshot: snapshot(0) as never });
    expect(inserted).toMatchObject({ action: "inserted", index: 0, changedPaths: ["/layers/field/gradient/colorKeyframes/keyframes"] });
    expect(inserted.layer.gradient?.colorKeyframes).toEqual({ schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(0)] });
    expect(inserted.evaluation.colors).toEqual(["#ff0000", "#0000ff"]);
    expect(source).toEqual(before);
    expect(inserted.motion.layers[1]).not.toBe(source.layers[1]);
  });

  it("replaces, reorders by exact time, and deletes only while preserving the one-snapshot floor", () => {
    const inserted = upsertMotionGradientColorKeyframe(motion(), { layerId: "field", snapshot: snapshot(1_000, ["#000", "#fff"], "ease-in") as never });
    const replaced = upsertMotionGradientColorKeyframe(inserted.motion, { layerId: "field", snapshot: snapshot(1_000, ["#111", "#eee"], "ease-out") as never });
    expect(replaced).toMatchObject({ action: "replaced", index: 0 });
    const second = upsertMotionGradientColorKeyframe(replaced.motion, { layerId: "field", snapshot: snapshot(2_000) as never });
    const moved = moveMotionGradientColorKeyframe(second.motion, { layerId: "field", fromAtUs: 2_000, toAtUs: 500 });
    expect(moved).toMatchObject({ action: "moved", previousIndex: 1, index: 0 });
    expect(moved.layer.gradient?.colorKeyframes?.keyframes.map((entry) => entry.atUs)).toEqual([500, 1_000]);
    const deleted = deleteMotionGradientColorKeyframe(moved.motion, { layerId: "field", atUs: 500 });
    expect(deleted).toMatchObject({ action: "deleted", index: 0 });
    expect(() => deleteMotionGradientColorKeyframe(deleted.motion, { layerId: "field", atUs: 1_000 })).toThrow("retain at least one");
  });

  it("refuses no-op, hostile input, bad topology, locked ownership, and missing records atomically", () => {
    const withKey = upsertMotionGradientColorKeyframe(motion(), { layerId: "field", snapshot: snapshot(0) as never }).motion;
    const before = structuredClone(withKey);
    expect(() => upsertMotionGradientColorKeyframe(withKey, { layerId: "field", snapshot: snapshot(0) as never })).toThrow("did not change");
    expect(() => upsertMotionGradientColorKeyframe(withKey, { layerId: "field", snapshot: snapshot(1, ["#000"]) as never })).toThrow("exactly the existing 2 stops");
    const hostile = { layerId: "field", snapshot: snapshot(1) };
    Object.defineProperty(hostile.snapshot, "colors", { configurable: true, enumerable: true, get: () => ["#000", "#fff"] });
    expect(() => upsertMotionGradientColorKeyframe(withKey, hostile as never)).toThrow("enumerable data field");
    expect(withKey).toEqual(before);

    let colorLengthReads = 0, colorElementReads = 0;
    const excessiveColors = new Proxy(new Array(100_000), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") colorLengthReads += 1; else colorElementReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(() => upsertMotionGradientColorKeyframe(withKey, { layerId: "field", snapshot: { atUs: 1, colors: excessiveColors } } as never)).toThrow("16-item payload");
    expect(colorLengthReads).toBeLessThanOrEqual(1);
    expect(colorElementReads).toBe(0);
    expect(withKey).toEqual(before);

    const mutatingSnapshot = snapshot(1);
    let getterCalls = 0;
    Object.defineProperty(mutatingSnapshot, "colors", {
      configurable: true, enumerable: true,
      get: () => { getterCalls += 1; withKey.layers[0]!.gradient!.stops[0]!.color = "#ffffff"; return ["#000", "#fff"]; },
    });
    expect(() => upsertMotionGradientColorKeyframe(withKey, { layerId: "field", snapshot: mutatingSnapshot } as never)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);
    expect(withKey).toEqual(before);

    expect(() => upsertMotionGradientColorKeyframe(motion({ ...layer(), locked: true }), { layerId: "field", snapshot: snapshot(0) as never })).toThrow("locked layer");
    const tracked = motion(); tracked.tracks = [{ id: "locked", type: "overlay", locked: true, layerIds: ["field"] }];
    expect(() => upsertMotionGradientColorKeyframe(tracked, { layerId: "field", snapshot: snapshot(0) as never })).toThrow("locked track");
    expect(() => deleteMotionGradientColorKeyframe(motion(), { layerId: "field", atUs: 0 })).toThrow("absent");
  });

  it("binds the exact bounded record into full Motion validation", async () => {
    const valid = upsertMotionGradientColorKeyframe(motion(), { layerId: "field", snapshot: snapshot(0) as never }).motion;
    expect(await validateDocument(await loadSchema("motion"), valid)).toEqual({ ok: true });
    const invalid = structuredClone(valid);
    invalid.layers[0].gradient!.colorKeyframes!.keyframes[0]!.colors = ["#000"];
    await expect(validateDocument(await loadSchema("motion"), invalid)).resolves.toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: "/layers/0/gradient/colorKeyframes", message: expect.stringContaining("exactly 2 entries") })],
    });
  });
});
