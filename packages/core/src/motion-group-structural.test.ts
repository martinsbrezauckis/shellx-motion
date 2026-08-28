import { describe, expect, it } from "vitest";
import type { MotionDocument, MotionLayer, MotionTrack } from "./types";
import { loadSchema, validateDocument } from "./validate";
import { readMotionGroupGraph } from "./motion-group-structural-support";
import { splitLayerAtMs } from "./timeline";
import {
  addMotionGroupChild,
  createMotionGroup,
  moveMotionGroupChild,
  removeMotionGroupChild,
  reorderMotionGroupChild,
  wrapMotionGroupSelection
} from "./motion-group-structural";
import {
  deleteMotionGroup,
  deleteMotionGroupSubtree,
  duplicateMotionGroupSubtree,
  unwrapMotionGroup
} from "./motion-group-structural-lifecycle";
import { MOTION_GROUP_OWNED_LAYER_TIMELINE_INTEGRATION } from "./motion-group-structural-types";

const leaf = (id: string, startMs = 0, durationMs = 100): MotionLayer => ({ id, type: "shape", shape: "rect", startMs, durationMs });
const group = (id: string, children: string[], startMs = 0, durationMs = 100): MotionLayer => ({ id, type: "group", startMs, durationMs, childLayerIds: children });

function document(layers: MotionLayer[], tracks?: MotionTrack[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "groups", name: "Groups", durationMs: 1_000, fps: 30, width: 100, height: 60,
    layers, assets: [], ...(tracks ? { tracks } : {}), provenance: { sourceApp: "test", createdBy: "test" }
  };
}

describe("Motion group structural mutations", () => {
  it("creates a typed group only from unowned local-timeline children, with exact paths", async () => {
    const source = document([leaf("a", 0, 80), leaf("b", 20, 80)]);
    const result = createMotionGroup(source, { group: group("pack", ["a", "b"], 100, 100), layerIndex: 1 });
    expect(result.changedPaths).toEqual(["/layers/pack"]);
    expect(result.motion.layers.map((layer) => layer.id)).toEqual(["a", "pack", "b"]);
    expect(result.group.childLayerIds).toEqual(["a", "b"]);
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("a")).toBe("pack");
    expect(await validateDocument(await loadSchema("motion"), result.motion)).toEqual({ ok: true });
    expect(() => createMotionGroup(result.motion, { group: group("second", ["a"], 0, 100) })).toThrow(/already has a group owner/);
    expect(() => createMotionGroup(source, { group: group("late", ["a"], 0, 40) })).toThrow(/does not fit/);
  });

  it("refuses group creation or membership changes through locked layers and tracks", () => {
    const lockedLayer = document([{ ...leaf("a"), locked: true }, leaf("b")]);
    expect(() => createMotionGroup(lockedLayer, { group: group("pack", ["a", "b"]) })).toThrow(/locked layer/);
    const lockedTrack = document([group("pack", ["a"], 0, 100), leaf("a"), leaf("b")], [{ id: "t", type: "overlay", locked: true, layerIds: ["b"] }]);
    expect(() => addMotionGroupChild(lockedTrack, { groupId: "pack", childLayerId: "b" })).toThrow(/locked track/);
  });

  it("wraps root siblings in their existing order, derives local time, and reports only changed fields", () => {
    const source = document([leaf("late", 300, 200), leaf("early", 100, 100), leaf("other", 0, 50)]);
    const result = wrapMotionGroupSelection(source, { group: { id: "wrapped", name: "Wrapped" }, childLayerIds: ["early", "late"] });
    expect(result.group).toMatchObject({ id: "wrapped", type: "group", startMs: 100, durationMs: 400, childLayerIds: ["late", "early"] });
    expect(result.motion.layers.find((layer) => layer.id === "late")?.startMs).toBe(200);
    expect(result.motion.layers.find((layer) => layer.id === "early")?.startMs).toBe(0);
    expect(result.changedPaths).toEqual(["/layers/wrapped", "/layers/late/startMs", "/layers/early/startMs"]);
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("early")).toBe("wrapped");
  });

  it("refuses to wrap non-contiguous root siblings rather than changing their z-order", () => {
    const source = document([leaf("a"), leaf("between"), leaf("c")]);
    expect(() => wrapMotionGroupSelection(source, { group: { id: "wrapped" }, childLayerIds: ["a", "c"] }))
      .toThrow(/contiguous range/);
    expect(source.layers.map((layer) => layer.id)).toEqual(["a", "between", "c"]);
  });

  it("refuses to wrap non-contiguous nested siblings rather than moving an intervening child", () => {
    const source = document([group("outer", ["a", "between", "c"], 0, 100), leaf("a"), leaf("between"), leaf("c")]);
    expect(() => wrapMotionGroupSelection(source, { group: { id: "wrapped" }, childLayerIds: ["a", "c"] }))
      .toThrow(/contiguous range/);
    expect(source.layers.find((layer) => layer.id === "outer")?.childLayerIds).toEqual(["a", "between", "c"]);
  });

  it("moves and removes children only through explicit parents while preserving absolute time", () => {
    const source = document([group("outer", ["inner", "spare"], 100, 600), group("inner", ["leaf", "inner-spare"], 50, 400), leaf("leaf", 20, 100), leaf("inner-spare", 0, 400), leaf("spare", 0, 400), group("target", ["target-leaf"], 300, 500), leaf("target-leaf", 0, 500), leaf("root", 320, 30)]);
    const removed = removeMotionGroupChild(source, { groupId: "inner", childLayerId: "leaf" });
    expect(removed.newRootStartMs).toBe(170);
    expect(removed.motion.layers.find((layer) => layer.id === "leaf")?.startMs).toBe(170);
    expect(readMotionGroupGraph(removed.motion).parentByChildId.has("leaf")).toBe(false);
    const moved = moveMotionGroupChild(source, { sourceGroupId: null, destinationGroupId: "target", childLayerId: "root", index: 1 });
    expect(moved).toMatchObject({ oldLocalStartMs: 320, newLocalStartMs: 20, index: 1 });
    expect(moved.changedPaths).toEqual(["/layers/target/childLayerIds", "/layers/root/startMs"]);
    expect(() => moveMotionGroupChild(source, { sourceGroupId: "outer", destinationGroupId: "target", childLayerId: "root" })).toThrow(/not directly owned/);
  });

  it("rejects cycles, removing a final child, and meaningless local reorder", () => {
    const source = document([group("outer", ["inner", "spare"], 0, 500), group("inner", ["leaf"], 0, 400), leaf("leaf", 0, 100), leaf("spare", 0, 400)]);
    expect(() => moveMotionGroupChild(source, { sourceGroupId: null, destinationGroupId: "inner", childLayerId: "outer" })).toThrow(/create a cycle/);
    expect(() => removeMotionGroupChild(source, { groupId: "inner", childLayerId: "leaf" })).toThrow(/final child/);
    expect(() => reorderMotionGroupChild(source, { groupId: "outer", childLayerId: "inner", index: 0 })).toThrow(/did not change/);
    const reordered = reorderMotionGroupChild(source, { groupId: "outer", childLayerId: "spare", index: 0 });
    expect(reordered.changedPaths).toEqual(["/layers/outer/childLayerIds"]);
    expect(reordered.motion.layers.find((layer) => layer.id === "outer")?.childLayerIds).toEqual(["spare", "inner"]);
  });

  it("unwraps only a visually neutral group, replaces its parent slot, and clears stale group track refs", () => {
    const source = document([group("outer", ["pack", "spare"], 0, 500), group("pack", ["a", "b"], 100, 200), leaf("a", 10, 50), leaf("b", 80, 70), leaf("spare", 0, 500)], [{ id: "t", type: "overlay", layerIds: ["pack", "a"] }]);
    const result = unwrapMotionGroup(source, { groupId: "pack" });
    expect(result.changedPaths).toEqual(["/layers/pack", "/layers/a/startMs", "/layers/b/startMs", "/layers/outer/childLayerIds", "/tracks/0/layerIds"]);
    expect(result.motion.layers.find((layer) => layer.id === "outer")?.childLayerIds).toEqual(["a", "b", "spare"]);
    expect(result.motion.layers.find((layer) => layer.id === "a")?.startMs).toBe(110);
    expect(result.motion.tracks?.[0].layerIds).toEqual(["a"]);
    expect(() => unwrapMotionGroup(document([{ ...group("bad", ["a"]), opacity: 0.5 }, leaf("a")]), { groupId: "bad" })).toThrow(/non-neutral/);
    expect(() => unwrapMotionGroup(document([{ ...group("bad", ["a"]), transform: { x: 1 } }, leaf("a")]), { groupId: "bad" })).toThrow(/visual or animated/);
    for (const state of [{ blendMode: "screen" }, { effects: { brightness: 1.1 } }, { mask: { type: "shape" } }, { matte: { layerId: "a" } }, { keyframes: { opacity: [] } }, { transitions: { in: { type: "fade" } } }]) {
      expect(() => unwrapMotionGroup(document([{ ...group("bad", ["a"]), ...state } as MotionLayer, leaf("a")]), { groupId: "bad" })).toThrow(/group-level|non-normal/);
    }
  });

  it("makes delete disposition explicit and cascade-removes the full subtree without dangling track refs", () => {
    const source = document([group("outer", ["pack", "spare"], 0, 500), group("pack", ["inner"], 20, 200), group("inner", ["a"], 0, 100), leaf("a", 0, 100), leaf("spare", 0, 500)], [{ id: "t", type: "overlay", layerIds: ["pack", "inner", "a", "spare"] }]);
    const result = deleteMotionGroup(source, { groupId: "pack", disposition: "cascade" });
    expect(result).toMatchObject({ action: "deleted-subtree", deletedLayerIds: ["pack", "inner", "a"], removedTrackRefs: ["t"] });
    expect(result.motion.layers.map((layer) => layer.id)).toEqual(["outer", "spare"]);
    expect(result.motion.layers[0].childLayerIds).toEqual(["spare"]);
    expect(result.motion.tracks?.[0].layerIds).toEqual(["spare"]);
    expect(() => deleteMotionGroupSubtree(document([group("only", ["a"]), leaf("a")]), { groupId: "only" })).not.toThrow();
  });

  it("refuses a cascade delete before mutation when an external typed reference targets its subtree", () => {
    const externalReferences: Array<[string, MotionLayer]> = [
      ["matte.sourceLayerId", { ...leaf("consumer"), matte: { type: "alpha", sourceLayerId: "a" } }],
      ["ducking.triggerLayerIds", { ...leaf("duck"), type: "audio", ducking: { triggerLayerIds: ["a"] } }],
      ["environment.sceneSourceLayerId", { ...leaf("weather"), type: "environment", environment: { sceneSourceLayerId: "a" } } as MotionLayer],
      ["environment.effectMaskLayerId", { ...leaf("weather"), type: "environment", environment: { effectMaskLayerId: "a" } } as MotionLayer]
    ];
    for (const [path, consumer] of externalReferences) {
      const source = document([group("pack", ["a"]), leaf("a"), consumer]);
      const original = structuredClone(source);
      expect(() => deleteMotionGroupSubtree(source, { groupId: "pack" })).toThrow(new RegExp(path.replaceAll(".", "\\.")));
      expect(source).toEqual(original);
    }
  });

  it("refuses unwrap dispositions before mutation when an external typed reference targets the removed group", () => {
    const externalReferences: Array<[string, MotionLayer]> = [
      ["matte.sourceLayerId", { ...leaf("consumer"), matte: { type: "alpha", sourceLayerId: "pack" } }],
      ["ducking.triggerLayerIds", { ...leaf("duck"), type: "audio", ducking: { triggerLayerIds: ["pack"] } }],
      ["environment.sceneSourceLayerId", { ...leaf("weather"), type: "environment", environment: { sceneSourceLayerId: "pack" } } as MotionLayer],
      ["environment.effectMaskLayerId", { ...leaf("weather"), type: "environment", environment: { effectMaskLayerId: "pack" } } as MotionLayer]
    ];
    for (const [path, consumer] of externalReferences) {
      const source = document([group("pack", ["a"]), leaf("a"), consumer]);
      const original = structuredClone(source);
      expect(() => unwrapMotionGroup(source, { groupId: "pack" })).toThrow(path);
      expect(source).toEqual(original);
      expect(() => deleteMotionGroup(source, { groupId: "pack", disposition: "unwrap" })).toThrow(path);
      expect(source).toEqual(original);
    }
  });

  it("refuses external opaque nested payloads before cascade or unwrap can remove an ambiguous target", async () => {
    const schema = await loadSchema("motion");
    for (const [path, fields] of [
      ["transform", { transform: { pluginData: { targetLayerId: "a" } } }],
      ["style", { style: { pluginData: { targetLayerId: "a" } } }],
      ["effects", { effects: { pluginData: { targetLayerId: "a" } } }]
    ] as const) {
      const source = document([group("pack", ["a"]), leaf("a"), { ...leaf("consumer"), ...fields } as unknown as MotionLayer]);
      const original = structuredClone(source);
      expect(await validateDocument(schema, source)).toEqual({ ok: true });
      expect(() => deleteMotionGroupSubtree(source, { groupId: "pack" })).toThrow(new RegExp(`extension field /${path}/pluginData`));
      expect(source).toEqual(original);
      expect(() => unwrapMotionGroup(source, { groupId: "pack" })).toThrow(new RegExp(`extension field /${path}/pluginData`));
      expect(source).toEqual(original);
    }
  });

  it("refuses recognized fields whose discriminator makes them invalid before removing a group", () => {
    const source = document([group("pack", ["a"]), leaf("a"), { ...leaf("consumer"), childLayerIds: ["a"] } as unknown as MotionLayer]);
    const original = structuredClone(source);
    expect(() => deleteMotionGroupSubtree(source, { groupId: "pack" })).toThrow(/childLayerIds is only valid for group layers/);
    expect(source).toEqual(original);
    expect(() => unwrapMotionGroup(source, { groupId: "pack" })).toThrow(/childLayerIds is only valid for group layers/);
    expect(source).toEqual(original);
  });

  it("deep-clones a group subtree with deterministic ids and no duplicate owner", () => {
    const source = document([group("pack", ["inner", "a"], 100, 300), group("inner", ["b"], 20, 120), leaf("b", 0, 100), leaf("a", 0, 300)], [{ id: "t", type: "overlay", layerIds: ["pack", "inner", "b", "a"] }]);
    source.durationMs = 400;
    const result = duplicateMotionGroupSubtree(source, { groupId: "pack", offsetMs: 350 });
    expect(result.cloneIdMap).toEqual({ pack: "pack_copy", inner: "inner_copy", b: "b_copy", a: "a_copy" });
    expect(result.motion.layers.find((layer) => layer.id === "pack_copy")).toMatchObject({ startMs: 450, childLayerIds: ["inner_copy", "a_copy"] });
    expect(result.motion.layers.find((layer) => layer.id === "inner_copy")?.childLayerIds).toEqual(["b_copy"]);
    expect(result.motion.tracks?.[0].layerIds).toEqual(["pack", "pack_copy", "inner", "inner_copy", "b", "b_copy", "a", "a_copy"]);
    expect(readMotionGroupGraph(result.motion).parentByChildId.get("a_copy")).toBe("pack_copy");
    expect(result.changedPaths).toContain("/durationMs");
  });

  it("rewires typed internal layer references and keeps external targets unchanged during a deep clone", () => {
    const source = document([
      group("pack", ["matte", "consumer", "voice", "music", "weather"], 0, 100),
      leaf("matte"),
      { ...leaf("consumer"), matte: { type: "alpha", sourceLayerId: "matte" } },
      { ...leaf("voice"), type: "audio" },
      { ...leaf("music"), type: "audio", ducking: { triggerLayerIds: ["voice", "external"] } },
      {
        ...leaf("weather"), type: "environment", environment: {
          schema: "shellx-motion/environment@1", kind: "fog", seed: 1, quality: "balanced", mode: "scene",
          sceneSourceLayerId: "matte", effectMaskLayerId: "external", backgroundColor: "#000000", fogColor: "#808080", lightColor: "#ffffff",
          fog: { density: 0.1, speed: 1, scale: 1, turbulence: 0, height: 0, depthLayers: 1, lightStrength: 1 }
        }
      },
      leaf("external")
    ]);
    const result = duplicateMotionGroupSubtree(source, { groupId: "pack" });
    expect(result.motion.layers.find((layer) => layer.id === "consumer_copy")?.matte?.sourceLayerId).toBe("matte_copy");
    expect(result.motion.layers.find((layer) => layer.id === "music_copy")?.ducking?.triggerLayerIds).toEqual(["voice_copy", "external"]);
    expect(result.motion.layers.find((layer) => layer.id === "weather_copy")?.environment).toMatchObject({ sceneSourceLayerId: "matte_copy", effectMaskLayerId: "external" });
    expect(source.layers.find((layer) => layer.id === "consumer")?.matte?.sourceLayerId).toBe("matte");
  });

  it("refuses a deep clone before mutation when an extension could hide a layer reference", () => {
    const source = document([{ ...group("pack", ["a"]), "x-plugin-data": { targetLayerId: "a" } }, leaf("a")]);
    expect(() => duplicateMotionGroupSubtree(source, { groupId: "pack" })).toThrow(/extension field/);
    expect(source.layers.map((layer) => layer.id)).toEqual(["pack", "a"]);
  });

  it("refuses a deep clone before mutation for open-schema non-Core fields that could hide a layer reference", () => {
    const source = document([{ ...group("pack", ["a"]), pluginData: { targetLayerId: "a" } } as unknown as MotionLayer, leaf("a")]);
    const original = structuredClone(source);
    expect(() => duplicateMotionGroupSubtree(source, { groupId: "pack" })).toThrow(/extension field \/pluginData/);
    expect(source).toEqual(original);
  });

  it("recursively refuses opaque transform and style fields before a deep clone", async () => {
    const schema = await loadSchema("motion");
    for (const [path, fields] of [
      ["transform", { transform: { pluginData: { targetLayerId: "a" } } }],
      ["style", { style: { pluginData: { targetLayerId: "a" } } }]
    ] as const) {
      const source = document([{ ...group("pack", ["a"]), ...fields } as unknown as MotionLayer, leaf("a")]);
      const original = structuredClone(source);
      expect(await validateDocument(schema, source)).toEqual({ ok: true });
      expect(() => duplicateMotionGroupSubtree(source, { groupId: "pack" })).toThrow(new RegExp(`extension field /${path}/pluginData`));
      expect(source).toEqual(original);
    }
  });

  it("duplicates a grouped legacy path while preserving its validated path extensions", () => {
    const source = document([
      group("pack", ["path", "a"]),
      { id: "path", type: "shape", shape: "path", startMs: 0, durationMs: 100, "x-path": "M 0 0 L 100 100", "x-path-viewBox": "0 0 100 100", "x-path-fillRule": "nonzero" },
      leaf("a")
    ]);
    const result = duplicateMotionGroupSubtree(source, { groupId: "pack" });
    expect(result.motion.layers.find((layer) => layer.id === "path_copy")).toMatchObject({
      shape: "path", "x-path": "M 0 0 L 100 100", "x-path-viewBox": "0 0 100 100", "x-path-fillRule": "nonzero"
    });
  });

  it("keeps group-owned split explicitly mapped to the keyframe/media-aware timeline join", () => {
    expect(MOTION_GROUP_OWNED_LAYER_TIMELINE_INTEGRATION).toMatchObject({ delete: "deleteMotionGroupSubtree", duplicate: "duplicateMotionGroupSubtree" });
    expect(MOTION_GROUP_OWNED_LAYER_TIMELINE_INTEGRATION.split).toContain("splitLayerAtMs");
    expect(() => splitLayerAtMs(document([group("pack", ["a"]), leaf("a")]), { layerId: "pack", atMs: 50 }))
      .toThrow(/generic layer operation; use splitMotionGroupAtMs/);
  });
});
