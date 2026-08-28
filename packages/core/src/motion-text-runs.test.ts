import { describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY,
  GPU_CAPABILITY,
  NATIVE_CAPABILITY,
  compileGpuSceneText,
  fingerprintMotionTextRuns,
  inspectMotionTextRuns,
  matchRendererCapability,
  readMotionTextRuns,
  removeMotionTextRuns,
  replaceMotionTextRuns,
  requiredLayerFeatures,
  setTimelineLayerText,
  validateDocumentSync,
  loadSchemaSync,
  type MotionDocument,
} from "./index";

describe("closed manifest-bound text-runs@1", () => {
  it("validates exact runs, asset ownership, content limits, and sole face authority", () => {
    const motion = styledMotion();
    expect(validateDocumentSync(loadSchemaSync("motion"), motion)).toEqual({ ok: true });
    const conflict = styledMotion(); conflict.layers[0]!.text = "legacy";
    expect(validateDocumentSync(loadSchemaSync("motion"), conflict)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ path: "/layers/0/text", message: expect.stringContaining("must be absent") })]) });
    const face = styledMotion(); face.layers[0]!.style = { fontFamily: "Brand" };
    expect(validateDocumentSync(loadSchemaSync("motion"), face)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ path: "/layers/0/style/fontFamily", message: expect.stringContaining("sole face authority") })]) });
    const unknown = { schema: "shellx-motion/text-runs@1", runs: [{ text: "A", fontAssetId: "brand-regular", accidental: true }] };
    expect(() => readMotionTextRuns(unknown)).toThrow("does not support accidental");
    const oversized = { schema: "shellx-motion/text-runs@1", runs: [{ text: "x".repeat(16_385), fontAssetId: "brand-regular" }] };
    expect(() => readMotionTextRuns(oversized)).toThrow("exceeds 16384 bytes");
  });

  it("replaces and removes copy-on-write without changing content during style removal", () => {
    const source = plainMotion();
    source.layers[0]!.style = { ...source.layers[0]!.style, fontFamily: "Legacy Brand", fontWeight: 700, fontStyle: "italic" };
    source.layers[0]!.keyframes = {
      "style.fontWeight": [{ atMs: 0, value: 500 }, { atMs: 1_000, value: 800 }],
      "style.fontSize": [{ atMs: 0, value: 24 }, { atMs: 1_000, value: 28 }],
    };
    Object.freeze(source.layers[0]!); Object.freeze(source.layers); Object.freeze(source);
    const textRuns = runs();
    const replacement = replaceMotionTextRuns(source, { layerId: "title", textRuns });
    expect(source.layers[0]).toMatchObject({ text: "Hello world", style: { fontFamily: "Legacy Brand", fontWeight: 700, fontStyle: "italic" } });
    expect(replacement.motion).not.toBe(source);
    expect(replacement.layer).toMatchObject({ textRuns });
    expect(replacement.layer).not.toHaveProperty("text");
    expect(replacement.layer.style).toEqual({ color: "#ffffff", fontSize: 24 });
    expect(replacement.layer.keyframes).toEqual({ "style.fontSize": source.layers[0]!.keyframes!["style.fontSize"] });
    expect(replacement.changedPaths).toEqual([
      "/layers/title/text",
      "/layers/title/textRuns",
      "/layers/title/style/fontFamily",
      "/layers/title/style/fontWeight",
      "/layers/title/style/fontStyle",
      "/layers/title/keyframes/style.fontWeight",
    ]);
    expect(validateDocumentSync(loadSchemaSync("motion"), replacement.motion)).toEqual({ ok: true });
    expect(inspectMotionTextRuns(replacement.motion, { layerId: "title" })).toMatchObject({ plainText: "Hello world", fontAssetIds: ["brand-bold", "brand-regular"] });
    expect(() => replaceMotionTextRuns(replacement.motion, { layerId: "title", textRuns })).toThrow("did not change");
    expect(() => removeMotionTextRuns(replacement.motion, { layerId: "title", expectedPlainText: "changed" })).toThrow("must exactly equal");
    const removal = removeMotionTextRuns(replacement.motion, { layerId: "title", expectedPlainText: "Hello world" });
    expect(removal.layer).toMatchObject({ text: "Hello world" });
    expect(removal.layer).not.toHaveProperty("textRuns");
    expect(removal.fingerprint).toBeNull();
    expect(validateDocumentSync(loadSchemaSync("motion"), removal.motion)).toEqual({ ok: true });
  });

  it("rejects authored text runs with animated legacy font weight authority", () => {
    const motion = styledMotion();
    motion.layers[0]!.keyframes = { "style.fontWeight": [{ atMs: 0, value: 700 }] };
    expect(validateDocumentSync(loadSchemaSync("motion"), motion)).toEqual({
      ok: false,
      errors: expect.arrayContaining([{
        path: "/layers/0/keyframes/style.fontWeight",
        message: "must be absent when textRuns uses manifest font assets as its sole face authority",
      }]),
    });
  });

  it("refuses hostile data, locked targets, generic flattening, and unsupported lanes before lowering", () => {
    const hostile = runs() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile.runs as object, "0", { enumerable: true, get: () => ({}) });
    expect(() => readMotionTextRuns(hostile)).toThrow("data value");
    const locked = styledMotion(); locked.layers[0]!.locked = true;
    expect(() => removeMotionTextRuns(locked, { layerId: "title", expectedPlainText: "Hello world" })).toThrow("locked layer");
    expect(() => setTimelineLayerText(styledMotion(), { layerId: "title", text: "flatten" })).toThrow("owns text content through text-runs@1");
    const layer = styledMotion().layers[0]!;
    expect(requiredLayerFeatures(layer)).toContain("text.runs.v1");
    expect(matchRendererCapability(styledMotion(), BROWSER_CAPABILITY)).toMatchObject({ ok: true });
    expect(matchRendererCapability(styledMotion(), NATIVE_CAPABILITY)).toMatchObject({ ok: false, unsupported: expect.arrayContaining([expect.objectContaining({ feature: "text.runs.v1" })]) });
    expect(matchRendererCapability(styledMotion(), GPU_CAPABILITY)).toMatchObject({ ok: false, unsupported: expect.arrayContaining([expect.objectContaining({ feature: "text.runs.v1" })]) });
    expect(compileGpuSceneText(styledMotion(), layer, new Map())).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("text.runs.v1") } });
  });

  it("keeps fingerprints deterministic and accepts the declared 16-asset boundary only", () => {
    const first = runs();
    expect(fingerprintMotionTextRuns(first)).toBe(fingerprintMotionTextRuns(structuredClone(first)));
    const atLimit = { schema: "shellx-motion/text-runs@1", runs: Array.from({ length: 16 }, (_unused, index) => ({ text: String(index), fontAssetId: `font-${index}` })) } as const;
    expect(readMotionTextRuns(atLimit).runs).toHaveLength(16);
    const tooMany = { schema: "shellx-motion/text-runs@1", runs: Array.from({ length: 17 }, (_unused, index) => ({ text: String(index), fontAssetId: `font-${index}` })) };
    expect(() => readMotionTextRuns(tooMany)).toThrow("more than 16 distinct");
  });

  it("caps hostile run arrays before ownKeys or element descriptors across direct Core replacement", () => {
    for (const count of [33, 100_000]) {
      let lengthDescriptors = 0, elementDescriptors = 0, ownKeys = 0;
      const runs = new Proxy(Array.from({ length: count }, () => ({ text: "x", fontAssetId: "brand-regular" })), {
        ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) {
          if (key === "length") lengthDescriptors += 1;
          if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) elementDescriptors += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
      });
      const value = { schema: "shellx-motion/text-runs@1", runs };
      expect(() => readMotionTextRuns(value)).toThrow("must contain 1..32");
      expect({ lengthDescriptors, elementDescriptors, ownKeys }).toEqual({ lengthDescriptors: 1, elementDescriptors: 0, ownKeys: 0 });
      const source = plainMotion(); const before = structuredClone(source);
      expect(() => replaceMotionTextRuns(source, { layerId: "title", textRuns: value as never })).toThrow("must contain 1..32");
      expect(source).toStrictEqual(before);
    }
  });

  it("refuses accessor, cyclic/reflection-controlled run data without executing it or mutating a frozen source", () => {
    let getterCalls = 0;
    const accessorRun = { fontAssetId: "brand-regular" } as Record<string, unknown>;
    Object.defineProperty(accessorRun, "text", { enumerable: true, get: () => { getterCalls += 1; return "never"; } });
    expect(() => readMotionTextRuns({ schema: "shellx-motion/text-runs@1", runs: [accessorRun] })).toThrow("enumerable data value");
    expect(getterCalls).toBe(0);
    const reflectiveRuns = new Proxy([{ text: "x", fontAssetId: "brand-regular" }], { ownKeys: () => { throw new Error("caller reflection trap"); } });
    expect(() => readMotionTextRuns({ schema: "shellx-motion/text-runs@1", runs: reflectiveRuns })).toThrow("plain JSON data");
    const source = plainMotion(); Object.freeze(source.layers[0]!); Object.freeze(source.layers); Object.freeze(source);
    expect(() => replaceMotionTextRuns(source, { layerId: "title", textRuns: { schema: "shellx-motion/text-runs@1", runs: [accessorRun] } as never })).toThrow("enumerable data value");
    expect(source.layers[0]).toMatchObject({ text: "Hello world" });
  });
});

function runs() { return { schema: "shellx-motion/text-runs@1" as const, runs: [{ text: "Hello ", fontAssetId: "brand-regular", color: "#ffffff", fontSizePx: 32 }, { text: "world", fontAssetId: "brand-bold", letterSpacingPx: 1.5 }] }; }
function plainMotion(): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "motion_text_runs", name: "Text runs", durationMs: 1_000, fps: 30, width: 640, height: 360, layers: [{ id: "title", type: "text", startMs: 0, durationMs: 1_000, text: "Hello world", style: { color: "#ffffff", fontSize: 24 } }], assets: fonts(), provenance: { sourceApp: "test", createdBy: "test" } };
}
function styledMotion(): MotionDocument { const motion = plainMotion(); const layer = motion.layers[0]!; delete layer.text; layer.textRuns = runs(); return motion; }
function fonts() { return [{ id: "brand-regular", type: "font" as const, family: "Brand Regular", source: { path: "assets/brand-regular.woff2", mimeType: "font/woff2" as const }, weight: 400 }, { id: "brand-bold", type: "font" as const, family: "Brand Bold", source: { path: "assets/brand-bold.woff2", mimeType: "font/woff2" as const }, weight: 700 }]; }
