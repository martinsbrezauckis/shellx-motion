import { describe, expect, it } from "vitest";
import type { MotionDocument, MotionLayer, MotionTrack } from "./types";
import {
  createTimelineLayer,
  deleteTimelineLayer,
  duplicateTimelineLayer,
  reorderTimelineLayer,
  splitLayerAtMs,
  trimLayerTiming,
  trimTimelineLayer
} from "./timeline";
import { readMotionGroupGraph } from "./motion-group-structural-support";
import { reorderMotionGroupRoot, trimMotionGroup } from "./motion-group-timeline";
import { splitMotionGroupAtMs } from "./motion-group-timeline-split";
import { loadSchema, validateDocument } from "./validate";

const leaf = (id: string, startMs = 0, durationMs = 100): MotionLayer => ({ id, type: "shape", shape: "rect", startMs, durationMs });
const group = (id: string, children: string[], startMs = 0, durationMs = 100): MotionLayer => ({ id, type: "group", startMs, durationMs, childLayerIds: children });
function document(layers: MotionLayer[], tracks?: MotionTrack[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "group-timeline", name: "Group timeline", durationMs: 1_000, fps: 30, width: 100, height: 60,
    layers, assets: [], ...(tracks ? { tracks } : {}), provenance: { sourceApp: "test", createdBy: "test" }
  };
}

describe("group local-timeline operations", () => {
  it("fails generic Core structural operations for group containers and owned children before they can flatten ownership", () => {
    const source = document([group("pack", ["a", "b"], 100, 200), leaf("a", 0, 100), leaf("b", 100, 100), leaf("root", 0, 100)]);
    const original = structuredClone(source);
    expect(() => createTimelineLayer(source, { layer: group("other", ["root"], 0, 100) })).toThrow(/create a group.*createMotionGroup/i);
    expect(() => trimLayerTiming(source.layers[0], { trimStartMs: 5 })).toThrow(/trimMotionGroup/);
    expect(() => trimTimelineLayer(source, { layerId: "pack", durationMs: 150 })).toThrow(/generic layer operation/);
    expect(() => trimTimelineLayer(source, { layerId: "a", durationMs: 80 })).toThrow(/group-owned layer/);
    for (const layerId of ["pack", "a"]) {
      expect(() => deleteTimelineLayer(source, { layerId })).toThrow(/generic layer operation|group-owned layer/);
      expect(() => duplicateTimelineLayer(source, { layerId })).toThrow(/generic layer operation|group-owned layer/);
      expect(() => reorderTimelineLayer(source, { layerId, index: 0 })).toThrow(/generic layer operation|group-owned layer/);
      expect(() => splitLayerAtMs(source, { layerId, atMs: layerId === "pack" ? 200 : 50 })).toThrow(/generic layer operation|group-owned layer/);
    }
    expect(source).toEqual(original);
  });

  it("trims group timing only through the local-timeline operation, preserving containment and locks", () => {
    const source = document([group("outer", ["pack", "spare"], 0, 500), group("pack", ["a", "b"], 100, 250), leaf("a", 0, 100), leaf("b", 120, 100), leaf("spare", 0, 500)]);
    const result = trimMotionGroup(source, { groupId: "pack", startMs: 140, durationMs: 240 });
    expect(result.changedPaths).toEqual(["/layers/pack/startMs", "/layers/pack/durationMs"]);
    expect(result.newTiming).toEqual({ startMs: 140, durationMs: 240 });
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("a")).toBe("pack");
    expect(() => trimMotionGroup(source, { groupId: "pack", durationMs: 200 })).toThrow(/does not fit/);
    expect(() => trimMotionGroup(document([group("locked", ["a"], 0, 100), { ...leaf("a"), locked: true }]), { groupId: "locked", startMs: 1 }))
      .toThrow(/locked layer/);
  });

  it("uses root sibling order rather than flat child storage order for group root reordering", () => {
    const source = document([group("pack", ["a"], 0, 100), leaf("a"), leaf("root", 0, 100)]);
    const result = reorderMotionGroupRoot(source, { groupId: "pack", index: 1 });
    expect(result.rootLayerIds).toEqual(["root", "pack"]);
    expect(result.motion.layers.map((layer) => layer.id)).toEqual(["root", "a", "pack"]);
    expect(result.changedPaths).toEqual(["/layers"]);
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("a")).toBe("pack");
    expect(() => reorderMotionGroupRoot(document([group("outer", ["pack"], 0, 100), group("pack", ["a"], 0, 100), leaf("a")]), { groupId: "pack", index: 0 }))
      .toThrow(/reorderMotionGroupChild/);
  });

  it("recursively splits groups with local rebasing, keyframe/media-aware leaf halves, and internal reference rebinding", () => {
    const source = document([
      group("pack", ["inner", "consumer", "late"], 100, 200),
      group("inner", ["matte"], 0, 200),
      { ...leaf("matte", 0, 200), type: "video", source: "media.mp4", trimStartMs: 10, trimDurationMs: 200, keyframes: { opacity: [{ atMs: 0, value: 0 }, { atMs: 200, value: 1 }] } },
      { ...leaf("consumer", 0, 200), matte: { type: "alpha", sourceLayerId: "matte" } },
      leaf("late", 150, 50)
    ], [{ id: "stack", type: "overlay", layerIds: ["pack", "inner", "matte", "consumer", "late"] }]);
    const result = splitMotionGroupAtMs(source, { groupId: "pack", atMs: 200 });
    expect(result.splitIdMap).toEqual({ pack: "pack_split_200", inner: "inner_split_100", matte: "matte_split_100", consumer: "consumer_split_100" });
    expect(result.originalGroup).toMatchObject({ startMs: 100, durationMs: 100, childLayerIds: ["inner", "consumer"] });
    expect(result.newGroup).toMatchObject({ startMs: 200, durationMs: 100, childLayerIds: ["inner_split_100", "consumer_split_100", "late"] });
    expect(result.motion.layers.find((layer) => layer.id === "inner_split_100")).toMatchObject({ startMs: 0, durationMs: 100, childLayerIds: ["matte_split_100"] });
    expect(result.motion.layers.find((layer) => layer.id === "matte_split_100")).toMatchObject({ startMs: 0, durationMs: 100, trimStartMs: 110, trimDurationMs: 100 });
    expect(result.motion.layers.find((layer) => layer.id === "matte")?.keyframes?.opacity?.at(-1)).toMatchObject({ atMs: 100, value: 0.5 });
    expect(result.motion.layers.find((layer) => layer.id === "consumer_split_100")).toMatchObject({ startMs: 0, matte: { sourceLayerId: "matte_split_100" } });
    expect(result.motion.layers.find((layer) => layer.id === "late")?.startMs).toBe(50);
    expect(result.changedPaths).toContain("/layers/pack/childLayerIds");
    expect(result.motion.tracks?.[0].layerIds).toEqual(["pack", "pack_split_200", "inner", "inner_split_100", "matte", "matte_split_100", "consumer", "consumer_split_100", "late"]);
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("matte_split_100")).toBe("inner_split_100");
  });

  it("inserts a directly split nested group beside its head in the direct owner order", () => {
    const source = document([group("outer", ["inner", "spare"], 0, 300), group("inner", ["a"], 50, 200), leaf("a", 0, 200), leaf("spare", 0, 300)]);
    const result = splitMotionGroupAtMs(source, { groupId: "inner", atMs: 150 });
    expect(result.motion.layers.find((layer) => layer.id === "outer")?.childLayerIds).toEqual(["inner", "inner_split_150", "spare"]);
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("inner_split_150")).toBe("outer");
    expect(result.changedPaths).toContain("/layers/outer/childLayerIds");
  });

  it("refuses empty group halves and opaque extension references without returning a partial split", () => {
    const emptyTail = document([group("pack", ["a"], 0, 100), leaf("a", 0, 20)]);
    expect(() => splitMotionGroupAtMs(emptyTail, { groupId: "pack", atMs: 50 })).toThrow(/at least one direct child/);
    const opaque = document([{ ...group("pack", ["a"], 0, 100), "x-plugin-data": { targetLayerId: "a" } }, leaf("a", 0, 100)]);
    const original = structuredClone(opaque);
    expect(() => splitMotionGroupAtMs(opaque, { groupId: "pack", atMs: 50 })).toThrow(/extension field/);
    expect(opaque).toEqual(original);
  });

  it("refuses open-schema non-Core fields before split because their layer references cannot be rebound", () => {
    const source = document([{ ...group("pack", ["a"], 0, 100), pluginData: { targetLayerId: "a" } } as unknown as MotionLayer, leaf("a", 0, 100)]);
    const original = structuredClone(source);
    expect(() => splitMotionGroupAtMs(source, { groupId: "pack", atMs: 50 })).toThrow(/extension field \/pluginData/);
    expect(source).toEqual(original);
  });

  it("recursively refuses opaque transform and effects fields before split", async () => {
    const schema = await loadSchema("motion");
    for (const [path, fields] of [
      ["transform", { transform: { pluginData: { targetLayerId: "a" } } }],
      ["effects", { effects: { pluginData: { targetLayerId: "a" } } }]
    ] as const) {
      const source = document([{ ...group("pack", ["a"], 0, 100), ...fields } as unknown as MotionLayer, leaf("a", 0, 100)]);
      const original = structuredClone(source);
      expect(await validateDocument(schema, source)).toEqual({ ok: true });
      expect(() => splitMotionGroupAtMs(source, { groupId: "pack", atMs: 50 })).toThrow(new RegExp(`extension field /${path}/pluginData`));
      expect(source).toEqual(original);
    }
  });

  it("refuses a tail clone whose typed reference would cross into a head-only owned layer", () => {
    const source = document([
      group("pack", ["matte", "consumer"], 0, 100),
      leaf("matte", 0, 30),
      { ...leaf("consumer", 0, 100), matte: { type: "alpha", sourceLayerId: "matte" } }
    ]);
    expect(() => splitMotionGroupAtMs(source, { groupId: "pack", atMs: 50 })).toThrow(/head-only layer matte/);
  });

  it("refuses an external typed consumer of a split subtree before mutation", () => {
    const externalReferences: Array<[string, MotionLayer]> = [
      ["matte", { ...leaf("consumer"), matte: { type: "alpha", sourceLayerId: "a" } }],
      ["ducking", { ...leaf("duck"), type: "audio", ducking: { triggerLayerIds: ["a"] } }],
      ["scene", { ...leaf("weather"), type: "environment", environment: { sceneSourceLayerId: "a" } } as MotionLayer],
      ["mask", { ...leaf("weather"), type: "environment", environment: { effectMaskLayerId: "a" } } as MotionLayer]
    ];
    for (const [label, consumer] of externalReferences) {
      const source = document([group("pack", ["a"], 0, 100), leaf("a", 0, 100), consumer]);
      const original = structuredClone(source);
      expect(() => splitMotionGroupAtMs(source, { groupId: "pack", atMs: 50 })).toThrow(/external layer .* references split-subtree layer a/);
      expect({ label, source }).toEqual({ label, source: original });
    }
  });

  it("refuses external opaque nested payloads and invalid conditional fields before a split", async () => {
    const schema = await loadSchema("motion");
    for (const [path, fields] of [
      ["transform", { transform: { pluginData: { targetLayerId: "a" } } }],
      ["style", { style: { pluginData: { targetLayerId: "a" } } }],
      ["effects", { effects: { pluginData: { targetLayerId: "a" } } }]
    ] as const) {
      const source = document([group("pack", ["a"], 0, 100), leaf("a", 0, 100), { ...leaf("consumer"), ...fields } as unknown as MotionLayer]);
      const original = structuredClone(source);
      expect(await validateDocument(schema, source)).toEqual({ ok: true });
      expect(() => splitMotionGroupAtMs(source, { groupId: "pack", atMs: 50 })).toThrow(new RegExp(`extension field /${path}/pluginData`));
      expect(source).toEqual(original);
    }
    const invalid = document([group("pack", ["a"], 0, 100), leaf("a", 0, 100), { ...leaf("consumer"), childLayerIds: ["a"] } as unknown as MotionLayer]);
    const original = structuredClone(invalid);
    expect(() => splitMotionGroupAtMs(invalid, { groupId: "pack", atMs: 50 })).toThrow(/childLayerIds is only valid for group layers/);
    expect(invalid).toEqual(original);
  });
});
