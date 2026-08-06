/**
 * The falsifier for keyframe tracks destroyed or overwritten by a MUTATION, kept permanently.
 *
 * ca8ee4c gated the READ path: `motion.package.validate`, the CLI `validate` and both render lanes
 * now refuse a document whose keyframes the evaluator cannot read. It did not touch the mutation
 * commands, and the mutation commands turned out to be where the same defect is worst — because a
 * mutation can DELETE the evidence the read gate exists to find:
 *
 *   - `motion.timeline.layer.split` visited a static list of keyframe targets, so a
 *     `shader.uniforms.*` track (schema-valid, engine-readable, shipped in
 *     fixtures/packages/restricted-shader) appeared in neither half. Measured on that fixture:
 *     `ok: true`, `warnings: []`, and `keyframes` simply gone from both layers.
 *   - the same split dropped every keyframe whose `atMs` is not a number, because a keyframe is
 *     assigned to a half by comparing `atMs` against the split point and `undefined < n`,
 *     `undefined > n` and `undefined === n` are all false. Measured on the ca8ee4c `{ t, v }`
 *     document: four authored keyframes became one synthesized `{ atMs, value: 0 }` per half, and
 *     the result then VALIDATED CLEAN — the split laundered a document validate would have refused
 *     into one it accepts, with the author's work gone and no trace of it.
 *   - `applyTransitionPresetToLayer` replaced whole existing tracks through a target-level spread
 *     while returning a hard-coded empty warnings array.
 *   - `applyLayerAnimationPreset` threw away each upsert's `inserted` / `replaced` verdict, so an
 *     author overwriting existing keyframes was told only "applied".
 *   - a data row's `layers.<id>.keyframes.<target>` patch replaced a track with an unchecked array,
 *     so a row could author `{ t, v }` into a batch job that no read gate sees until render.
 *
 * Both directions are pinned for every case: the broken input is refused or reported, and a healthy
 * input is byte-for-byte unaffected — no refusal, no new warning, identical output.
 */
import { describe, expect, it } from "vitest";
import { expandMotionPackageRows, parseMotionDataRows } from "./data";
import { applyLayerAnimationPreset, splitLayerAtMs } from "./timeline";
import { applyTransitionPresetToLayer } from "./transition-presets";
import { applyTypographyPresetToLayer } from "./typography-presets";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionLayer, MotionPackage } from "./types";

/** Narrows a preset-apply result to its success branch so a failure reads as a test failure. */
function mustApply<T extends { ok: boolean; warnings?: string[] }>(result: T): T & { warnings: string[] } {
  expect(result.ok).toBe(true);
  return result as T & { warnings: string[] };
}

/** A two-second document holding exactly the supplied layers. */
function documentWithLayers(layers: unknown[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_keyframe_mutation_safety",
    name: "Keyframe Mutation Safety Probe",
    durationMs: 2000,
    fps: 30,
    width: 640,
    height: 360,
    background: "#101820",
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "keyframe-mutation-safety.test", createdAt: "2026-08-03T00:00:00.000Z" },
    layers
  } as unknown as MotionDocument;
}

/** A shape layer carrying exactly the supplied keyframe map, valid or not. */
function shapeLayerWithKeyframes(keyframes: Record<string, unknown>): unknown {
  return {
    id: "panel",
    type: "shape",
    shape: "rectangle",
    fill: "#172033",
    startMs: 0,
    durationMs: 2000,
    width: 200,
    height: 80,
    transform: { x: 40, y: 40, scale: 1, rotation: 0 },
    keyframes
  };
}

/** A shader layer declaring `u_speed` and animating it on the dynamic `shader.uniforms.*` target. */
function shaderLayerWithUniformTrack(): unknown {
  return {
    id: "plasma",
    type: "shader",
    startMs: 0,
    durationMs: 2000,
    transform: { x: 0, y: 0, width: 640, height: 360 },
    shader: {
      schema: "shellx-motion/shader-plugin@1",
      language: "glsl-es-100-expression",
      fragmentAssetId: "shader_plasma",
      seed: 42,
      uniforms: { u_speed: 0.25 },
      fallbackColor: "#111827"
    },
    keyframes: {
      "shader.uniforms.u_speed": [
        { atMs: 0, value: 0.25, easing: "linear" },
        { atMs: 2000, value: 1.25 }
      ]
    }
  };
}

describe("splitLayerAtMs keyframe survival", () => {
  it("carries a dynamic shader.uniforms.* track into both halves", () => {
    const motion = documentWithLayers([shaderLayerWithUniformTrack()]);

    const result = splitLayerAtMs(motion, { layerId: "plasma", atMs: 1000 });

    // Before the fix both of these were `undefined`: the track was in neither half, and the command
    // still answered ok with no warning.
    expect(Object.keys(result.originalLayer.keyframes ?? {})).toEqual(["shader.uniforms.u_speed"]);
    expect(Object.keys(result.newLayer.keyframes ?? {})).toEqual(["shader.uniforms.u_speed"]);
    expect(result.originalLayer.keyframes?.["shader.uniforms.u_speed"]).toEqual([
      { atMs: 0, value: 0.25, easing: "linear" },
      { atMs: 1000, value: 0.75, easing: "linear" }
    ]);
    expect(result.newLayer.keyframes?.["shader.uniforms.u_speed"]).toEqual([
      { atMs: 1000, value: 0.75, easing: "linear" },
      { atMs: 2000, value: 1.25 }
    ]);
  });

  it("keeps a healthy static-target track exactly as before", () => {
    const motion = documentWithLayers([shapeLayerWithKeyframes({
      opacity: [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 2000, value: 1 }],
      "transform.x": [{ atMs: 0, value: 40 }, { atMs: 2000, value: 100 }]
    })]);

    const result = splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 });

    expect(result.originalLayer.keyframes).toEqual({
      opacity: [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 1000, value: 0.5, easing: "linear" }],
      "transform.x": [{ atMs: 0, value: 40 }, { atMs: 1000, value: 70 }]
    });
    expect(result.newLayer.keyframes).toEqual({
      opacity: [{ atMs: 1000, value: 0.5, easing: "linear" }, { atMs: 2000, value: 1 }],
      "transform.x": [{ atMs: 1000, value: 70 }, { atMs: 2000, value: 100 }]
    });
  });

  it("refuses to split a layer whose keyframes the evaluator cannot read, naming the wrong field", () => {
    const motion = documentWithLayers([shapeLayerWithKeyframes({
      opacity: [{ t: 0, v: 0 }, { t: 2000, v: 1 }],
      "transform.x": [{ t: 0, v: 40 }, { t: 2000, v: 100 }]
    })]);

    expect(() => splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 }))
      .toThrow(/keyframe time is written as "t"; the engine reads "atMs"/);
    expect(() => splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 }))
      .toThrow(/\/layers\/0\/keyframes\/opacity\/0/);
  });

  it("does not launder an unreadable document into one that validates clean", async () => {
    const motion = documentWithLayers([shapeLayerWithKeyframes({
      opacity: [{ t: 0, v: 0 }, { t: 2000, v: 1 }]
    })]);
    const schema = await loadSchema("motion");
    const before = await validateDocument(schema, motion);
    expect(before.ok).toBe(false);

    // The whole point: whatever the split does, it may not turn a document validate refuses into one
    // validate accepts by deleting the offending keyframes. Refusing is how that is achieved here.
    let split: { motion: MotionDocument } | null = null;
    try {
      split = splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 });
    } catch {
      split = null;
    }
    if (split) expect((await validateDocument(schema, split.motion)).ok).toBe(false);
  });

  it("refuses a keyframe whose atMs is a non-numeric string rather than dropping it", () => {
    const motion = documentWithLayers([shapeLayerWithKeyframes({
      opacity: [{ atMs: "abc", value: 5 }, { atMs: 0, value: 0 }, { atMs: 2000, value: 1 }]
    })]);

    expect(() => splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 }))
      .toThrow(/keyframe "atMs" must be a finite number of milliseconds/);
  });

  it("refuses a keyframe track that is not an array rather than deleting it", async () => {
    // `MotionLayer["keyframes"]` types this as impossible; the shallow package loader makes it
    // reachable from a hand-written motion.json. The split used to drop the whole track and leave a
    // document that validated clean, i.e. it deleted the validator's error along with the data.
    const motion = documentWithLayers([shapeLayerWithKeyframes({ opacity: { "0": 0, "2000": 1 } })]);
    const schema = await loadSchema("motion");
    expect((await validateDocument(schema, motion)).ok).toBe(false);

    expect(() => splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 }))
      .toThrow(/\/layers\/0\/keyframes\/opacity is not an array/);
  });

  it("leaves a layer with no keyframes alone", () => {
    const motion = documentWithLayers([{
      id: "panel",
      type: "shape",
      shape: "rectangle",
      fill: "#172033",
      startMs: 0,
      durationMs: 2000,
      width: 200,
      height: 80,
      transform: { x: 40, y: 40, scale: 1, rotation: 0 }
    }]);

    const result = splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 });

    expect(result.originalLayer.keyframes).toBeUndefined();
    expect(result.newLayer.keyframes).toBeUndefined();
  });

  it("refuses a track whose values are the wrong type for its target instead of inventing one", () => {
    const motion = documentWithLayers([shapeLayerWithKeyframes({
      // Both entries are READABLE by the shared predicate (finite atMs, non-empty string value) yet
      // `opacity` is a numeric target, so there is no boundary value to compute. The old code
      // answered with `keyframes[0].value` — the string "half" — on a numeric track.
      opacity: [{ atMs: 0, value: "half" }, { atMs: 2000, value: "full" }]
    })]);

    expect(() => splitLayerAtMs(motion, { layerId: "panel", atMs: 1000 })).toThrow(/opacity/);
  });
});

describe("preset track replacement is announced", () => {
  /** `push-zoom` is one of the two transition presets that emit keyframes; it writes transform.scale. */
  const layerWithScaleTrack: MotionLayer = {
    id: "title",
    type: "text",
    text: "Hello",
    startMs: 0,
    durationMs: 2000,
    keyframes: {
      "transform.scale": [{ atMs: 0, value: 1.2 }, { atMs: 900, value: 1.05 }, { atMs: 2000, value: 1 }]
    }
  } as unknown as MotionLayer;

  it("tells the author which existing track a transition preset replaced", () => {
    const result = applyTransitionPresetToLayer(layerWithScaleTrack, "push-zoom", { durationMs: 400 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The preset's track wins — a preset is a coherent curve, and interleaving it with the author's
    // produces one neither of them wrote. What was missing is the author being told.
    expect(result.layer.keyframes?.["transform.scale"]?.[0]).toEqual({ atMs: 0, value: 0.96, easing: "ease-out" });
    expect(result.warnings.join(" ")).toMatch(/transform\.scale/);
    expect(result.warnings.join(" ")).toMatch(/replaced/i);
    expect(result.warnings.join(" ")).toMatch(/3 authored keyframes were discarded/);
  });

  it("tells the author which existing track a typography preset replaced", () => {
    const titled: MotionLayer = {
      id: "title",
      type: "text",
      text: "Hello",
      startMs: 0,
      durationMs: 2000,
      keyframes: { opacity: [{ atMs: 0, value: 0.2 }, { atMs: 2000, value: 0.4 }] }
    } as unknown as MotionLayer;

    const result = applyTypographyPresetToLayer(titled, "title-entrance", { durationMs: 400 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toMatch(/opacity/);
    expect(result.warnings.join(" ")).toMatch(/replaced/i);
  });

  it("says nothing when the layer had no keyframes at all", () => {
    const bare: MotionLayer = {
      id: "title",
      type: "text",
      text: "Hello",
      startMs: 0,
      durationMs: 2000
    } as unknown as MotionLayer;

    expect(mustApply(applyTransitionPresetToLayer(bare, "push-zoom", { durationMs: 400 })).warnings).toEqual([]);
    expect(mustApply(applyTypographyPresetToLayer(bare, "title-entrance", { durationMs: 400 })).warnings).toEqual([]);
  });

  it("says nothing about tracks the preset does not touch", () => {
    const untouched: MotionLayer = {
      id: "title",
      type: "text",
      text: "Hello",
      startMs: 0,
      durationMs: 2000,
      keyframes: { "transform.x": [{ atMs: 0, value: 10 }, { atMs: 2000, value: 20 }] }
    } as unknown as MotionLayer;

    const result = applyTransitionPresetToLayer(untouched, "push-zoom", { durationMs: 400 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.layer.keyframes?.["transform.x"]).toEqual([{ atMs: 0, value: 10 }, { atMs: 2000, value: 20 }]);
  });
});

describe("applyLayerAnimationPreset overwrite reporting", () => {
  const base: MotionLayer = {
    id: "title",
    type: "text",
    text: "Hello",
    startMs: 0,
    durationMs: 2000,
    opacity: 1,
    transform: { x: 0, y: 100, scale: 1, rotation: 0 }
  } as unknown as MotionLayer;

  it("reports the keyframes it overwrote", () => {
    const layer: MotionLayer = {
      ...base,
      keyframes: { opacity: [{ atMs: 0, value: 0.75 }, { atMs: 400, value: 0.5 }] }
    } as unknown as MotionLayer;

    const result = applyLayerAnimationPreset(layer, { preset: "fade-in", startMs: 0, durationMs: 400 });

    expect(result.replacedKeyframes).toEqual([
      { target: "opacity", atMs: 0, oldValue: 0.75, newValue: 0 },
      { target: "opacity", atMs: 400, oldValue: 0.5, newValue: 1 }
    ]);
  });

  it("reports nothing when the preset only inserts", () => {
    const result = applyLayerAnimationPreset(base, { preset: "fade-in", startMs: 0, durationMs: 400 });

    expect(result.replacedKeyframes).toEqual([]);
    expect(result.appliedKeyframes).toHaveLength(2);
  });
});

describe("data row layer patches", () => {
  function packageWithLayer(keyframes: Record<string, unknown>): MotionPackage {
    return {
      root: "/probe",
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_probe",
        name: "Probe",
        motion: "motion.json",
        assets: [],
        sourceApp: "shellx-motion"
      },
      motion: documentWithLayers([shapeLayerWithKeyframes(keyframes)])
    } as unknown as MotionPackage;
  }

  it("refuses a row that patches a keyframe track the engine cannot read", () => {
    const pkg = packageWithLayer({ opacity: [{ atMs: 0, value: 0 }, { atMs: 2000, value: 1 }] });
    const rows = parseMotionDataRows([{ id: "row-a", layers: { panel: { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 2000, v: 1 }] } } } }]);

    expect(() => expandMotionPackageRows(pkg, rows))
      .toThrow(/keyframe time is written as "t"; the engine reads "atMs"/);
    // Row ids are slugged on parse, so the refusal names the id the expansion actually uses.
    expect(() => expandMotionPackageRows(pkg, rows)).toThrow(/Motion data row row_a layer patch for panel/);
  });

  it("accepts a row that patches a keyframe track correctly", () => {
    const pkg = packageWithLayer({ opacity: [{ atMs: 0, value: 0 }, { atMs: 2000, value: 1 }] });
    const rows = parseMotionDataRows([{ id: "row-a", layers: { panel: { keyframes: { opacity: [{ atMs: 0, value: 0.2 }, { atMs: 2000, value: 0.8 }] } } } }]);

    const [job] = expandMotionPackageRows(pkg, rows);

    expect(job.motion.layers[0].keyframes?.opacity).toEqual([{ atMs: 0, value: 0.2 }, { atMs: 2000, value: 0.8 }]);
  });

  it("does not refuse a good row for a defect it did not write", () => {
    // The base document is already broken on transform.x. That is the READ gate's business
    // (validate and both render lanes refuse it); refusing the row here would be a check firing on
    // an input the row author got right.
    const pkg = packageWithLayer({
      opacity: [{ atMs: 0, value: 0 }, { atMs: 2000, value: 1 }],
      "transform.x": [{ t: 0, v: 40 }]
    });
    const rows = parseMotionDataRows([{ id: "row-a", layers: { panel: { keyframes: { opacity: [{ atMs: 0, value: 0.5 }] } } } }]);

    const [job] = expandMotionPackageRows(pkg, rows);

    expect(job.motion.layers[0].keyframes?.opacity).toEqual([{ atMs: 0, value: 0.5 }]);
  });

  it("leaves a row with no layer patches alone", () => {
    const pkg = packageWithLayer({ opacity: [{ atMs: 0, value: 0 }, { atMs: 2000, value: 1 }] });
    const rows = parseMotionDataRows([{ id: "row-a", headline: "Hello" }]);

    const [job] = expandMotionPackageRows(pkg, rows);

    expect(job.motion.layers[0].keyframes?.opacity).toEqual([{ atMs: 0, value: 0 }, { atMs: 2000, value: 1 }]);
  });
});
