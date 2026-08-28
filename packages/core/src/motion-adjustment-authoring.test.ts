import { describe, expect, it } from "vitest";
import {
  createOrReplaceMotionFixedAdjustment,
  inspectMotionFixedAdjustment,
  removeMotionFixedAdjustment,
} from "./motion-adjustment-authoring";
import { setTimelineLayerEffect } from "./timeline";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument, MotionLayer, MotionTrack } from "./types";

describe("fixed adjustment lifecycle", () => {
  it("creates at the root document stack end, then inspects and replaces in its exact slot", () => {
    const source = document([shape("base"), group("pack", ["child"]), shape("child")]);
    const created = createOrReplaceMotionFixedAdjustment(source, { adjustment: definition("finish") });

    expect(created).toMatchObject({ action: "created", layerId: "finish", index: 3, changedPaths: ["/layers/finish"] });
    expect(created.motion.layers.map((layer) => layer.id)).toEqual(["base", "pack", "child", "finish"]);
    expect(created.layer).toEqual({ id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: effects() });
    expect(created.inputFingerprint).toBeTruthy();
    expect(created.outputFingerprint).toBeTruthy();
    expect(created.adjustmentFingerprint).toBeTruthy();
    expect(validateDocumentSync(loadSchemaSync("motion"), created.motion)).toEqual({ ok: true });

    const inspected = inspectMotionFixedAdjustment(created.motion, { layerId: "finish" });
    expect(inspected).toMatchObject({ layerId: "finish", index: 3, adjustmentFingerprint: created.adjustmentFingerprint, documentFingerprint: created.outputFingerprint });

    const replaced = createOrReplaceMotionFixedAdjustment(created.motion, {
      adjustment: definition("finish", { startMs: 100, durationMs: 1_100, visible: false, effects: { filmGrain: { amount: 0.4, size: 3, seed: 7 } } }),
    });
    expect(replaced).toMatchObject({ action: "replaced", index: 3, changedPaths: ["/layers/finish", "/durationMs"] });
    expect(replaced.motion.layers.map((layer) => layer.id)).toEqual(["base", "pack", "child", "finish"]);
    expect(replaced.motion.layers[3]).toMatchObject({ type: "adjustment", startMs: 100, durationMs: 1_100, visible: false, effects: { filmGrain: { amount: 0.4, size: 3, seed: 7 } } });
    expect(replaced.motion.durationMs).toBe(1_200);
  });

  it("preserves an unlocked tracked layer representation on replace and cleans refs on removal", () => {
    const adjustment: MotionLayer = { ...adjustmentLayer("finish"), trackId: "fx", locked: false };
    const source = document([shape("base"), adjustment], [{ id: "fx", type: "effect", layerIds: ["finish"] }]);
    const replaced = createOrReplaceMotionFixedAdjustment(source, { adjustment: definition("finish", { effects: { vignette: { amount: 0.8, softness: 0.5, color: "#112233" } } }) });
    expect(replaced.layer).toMatchObject({ trackId: "fx", locked: false, effects: { vignette: { amount: 0.8, softness: 0.5, color: "#112233" } } });
    expect(replaced.motion.tracks?.[0]?.layerIds).toEqual(["finish"]);

    const removed = removeMotionFixedAdjustment(replaced.motion, { layerId: "finish" });
    expect(removed).toMatchObject({ action: "removed", index: 1, removedTrackRefs: ["fx"] });
    expect(removed.changedPaths).toEqual(["/layers/finish", "/tracks/0/layerIds"]);
    expect(removed.motion.layers.map((layer) => layer.id)).toEqual(["base"]);
    expect(removed.motion.tracks?.[0]?.layerIds).toEqual([]);
    expect(validateDocumentSync(loadSchemaSync("motion"), removed.motion)).toEqual({ ok: true });
  });

  it("uses the full document validator for the existing eighth/ninth adjustment boundary", () => {
    const source = document(Array.from({ length: 8 }, (_unused, index) => adjustmentLayer(`finish-${index}`)));
    const before = structuredClone(source);
    expect(() => createOrReplaceMotionFixedAdjustment(source, { adjustment: definition("finish-8") })).toThrow("at most 8 adjustment layers");
    expect(source).toStrictEqual(before);
  });

  it("refuses every non-fixed field and nested opaque payload before source mutation", () => {
    const source = document([shape("base")]);
    Object.freeze(source.layers[0]!); Object.freeze(source.layers); Object.freeze(source);
    const hostile = [
      { ...definition("finish"), effectModule: { id: "afterimage" } },
      { ...definition("finish"), opacity: 0.5 },
      { ...definition("finish"), transform: { x: 1 } },
      { ...definition("finish"), "x-plugin": { targetLayerId: "base" } },
      { ...definition("finish"), effects: { vignette: { amount: 0.2, softness: 0.6, color: "#000000", pluginData: { targetLayerId: "base" } } } },
      { ...definition("finish"), effects: { blur: 2 } },
    ];
    for (const adjustment of hostile) {
      expect(() => createOrReplaceMotionFixedAdjustment(source, { adjustment } as never)).toThrow(/(forbidden field|field record limit)/);
      expect(source.layers.map((layer) => layer.id)).toEqual(["base"]);
    }

    const persistedExtension = document([{ ...adjustmentLayer("finish"), "x-plugin": { targetLayerId: "base" } } as MotionLayer]);
    const before = structuredClone(persistedExtension);
    expect(validateDocumentSync(loadSchemaSync("motion"), persistedExtension)).toEqual({ ok: true });
    expect(() => createOrReplaceMotionFixedAdjustment(persistedExtension, { adjustment: definition("finish", { effects: { vignette: { amount: 0.7, softness: 0.3, color: "#000000" } } }) })).toThrow("forbidden field 'x-plugin'");
    expect(persistedExtension).toStrictEqual(before);

    let getterCalls = 0;
    const accessor = { id: "finish", startMs: 0, durationMs: 1_000 } as Record<string, unknown>;
    Object.defineProperty(accessor, "effects", { enumerable: true, get: () => { getterCalls += 1; return effects(); } });
    expect(() => createOrReplaceMotionFixedAdjustment(source, { adjustment: accessor } as never)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);
  });

  it("snapshots the complete tiny request graph from bounded descriptors before any semantic read", () => {
    const source = document([shape("base")]);
    const before = structuredClone(source);
    Object.freeze(source.layers[0]!);
    Object.freeze(source.layers);
    Object.freeze(source);
    let mutatingGetterCalls = 0;
    const mutatingEnvelope = {} as Record<string, unknown>;
    Object.defineProperty(mutatingEnvelope, "adjustment", {
      enumerable: true,
      get: () => {
        mutatingGetterCalls += 1;
        source.layers.push(shape("must-not-appear"));
        return definition("finish");
      },
    });
    let nestedGetterCalls = 0;
    const nestedGetterEffects = {} as Record<string, unknown>;
    Object.defineProperty(nestedGetterEffects, "vignette", {
      enumerable: true,
      get: () => {
        nestedGetterCalls += 1;
        source.layers.push(shape("must-not-appear-nested"));
        return effects().vignette;
      },
    });

    const descriptorReadCount = { count: 0 };
    const oversizedProxy = new Proxy({}, {
      ownKeys: () => Array.from({ length: 100_000 }, (_unused, index) => `field-${index}`),
      getOwnPropertyDescriptor: () => { descriptorReadCount.count += 1; return undefined; },
    });
    const throwingOwnKeys = new Proxy({}, { ownKeys: () => { throw new Error("must stay contained"); } });
    const throwingPrototype = new Proxy({}, { getPrototypeOf: () => { throw new Error("must stay contained"); } });
    const throwingDescriptor = new Proxy({ adjustment: definition("finish") }, { getOwnPropertyDescriptor: () => { throw new Error("must stay contained"); } });
    const transparentProxy = new Proxy({ adjustment: definition("finish") }, {});
    const symbol = Symbol("hidden");
    const symbolEnvelope: Record<PropertyKey, unknown> = { adjustment: definition("finish") };
    symbolEnvelope[symbol] = true;
    const nonEnumerableEnvelope = {} as Record<string, unknown>;
    Object.defineProperty(nonEnumerableEnvelope, "adjustment", { enumerable: false, value: definition("finish") });
    const cyclicEffects = effects() as Record<string, unknown>;
    cyclicEffects.vignette = cyclicEffects;

    const hostile: Array<[unknown, RegExp]> = [
      [mutatingEnvelope, /enumerable data field/],
      [{ adjustment: { ...definition("finish"), effects: nestedGetterEffects } }, /enumerable data field/],
      [oversizedProxy, /field record limit/],
      [throwingOwnKeys, /(proxy objects|data reflection failed)/],
      [throwingPrototype, /(proxy objects|data reflection failed)/],
      [throwingDescriptor, /(proxy objects|data reflection failed)/],
      [transparentProxy, /proxy objects/],
      [symbolEnvelope, /symbol keys/],
      [nonEnumerableEnvelope, /enumerable data field/],
      [{ adjustment: { ...definition("finish"), effects: cyclicEffects } }, /cycles/],
    ];
    for (const [input, expected] of hostile) {
      expect(() => createOrReplaceMotionFixedAdjustment(source, input as never)).toThrow(expected);
    }
    expect(mutatingGetterCalls).toBe(0);
    expect(nestedGetterCalls).toBe(0);
    expect(descriptorReadCount.count).toBe(0);
    expect(source).toStrictEqual(before);
  });

  it("refuses effect bounds through the canonical validator without copied numeric limits", () => {
    const source = document([shape("base")]);
    const invalid = definition("finish", { effects: { vignette: { amount: 1.1, softness: 0.5, color: "#000000" }, filmGrain: { amount: 0.5, size: 9, seed: 0xffff_ffff + 1 } } });
    expect(() => createOrReplaceMotionFixedAdjustment(source, { adjustment: invalid })).toThrow("finite number between 0 and 1");
    expect(source.layers.map((layer) => layer.id)).toEqual(["base"]);
  });

  it("refuses locked, locked-track, group-owned, and no-op adjustments without changing the source", () => {
    const locked = document([{ ...adjustmentLayer("finish"), locked: true }]);
    expect(() => createOrReplaceMotionFixedAdjustment(locked, { adjustment: definition("finish", { effects: { vignette: { amount: 0.7, softness: 0.4, color: "#000000" } } }) })).toThrow("locked layer");

    const trackLocked = document([adjustmentLayer("finish")], [{ id: "fx", type: "effect", locked: true, layerIds: ["finish"] }]);
    expect(() => removeMotionFixedAdjustment(trackLocked, { layerId: "finish" })).toThrow("locked track");

    const owned = document([group("pack", ["finish"]), adjustmentLayer("finish")]);
    expect(() => removeMotionFixedAdjustment(owned, { layerId: "finish" })).toThrow("root-owned");

    const exact = document([adjustmentLayer("finish")]);
    const before = structuredClone(exact);
    expect(() => createOrReplaceMotionFixedAdjustment(exact, { adjustment: definition("finish") })).toThrow("did not change");
    expect(exact).toStrictEqual(before);
  });

  it("refuses generic scalar effect edits on adjustments before constructing a partial invalid layer", () => {
    const source = document([adjustmentLayer("finish")]);
    const before = structuredClone(source);
    expect(() => setTimelineLayerEffect(source, { layerId: "finish", property: "blur", value: 3 })).toThrow("createOrReplaceMotionFixedAdjustment");
    expect(source).toStrictEqual(before);
  });
});

function document(layers: MotionLayer[], tracks?: MotionTrack[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "motion", name: "Motion", durationMs: 1_000, fps: 30, width: 320, height: 180,
    layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, ...(tracks ? { tracks } : {}),
  };
}

function shape(id: string): MotionLayer { return { id, type: "shape", startMs: 0, durationMs: 1_000, shape: "rect", fill: "#ffffff" }; }
function group(id: string, childLayerIds: string[]): MotionLayer { return { id, type: "group", startMs: 0, durationMs: 1_000, childLayerIds }; }
function adjustmentLayer(id: string): MotionLayer { return { id, type: "adjustment", startMs: 0, durationMs: 1_000, effects: effects() }; }
function effects() { return { vignette: { amount: 0.5, softness: 0.6, color: "#000000" }, filmGrain: { amount: 0.25, size: 2, seed: 42 } }; }
function definition(id: string, override: Partial<{ startMs: number; durationMs: number; visible: boolean; effects: ReturnType<typeof effects> | { vignette?: { amount: number; softness: number; color: string }; filmGrain?: { amount: number; size: number; seed: number } } }> = {}) {
  return { id, startMs: override.startMs ?? 0, durationMs: override.durationMs ?? 1_000, ...(override.visible === undefined ? {} : { visible: override.visible }), effects: override.effects ?? effects() };
}
