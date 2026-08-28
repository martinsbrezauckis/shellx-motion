import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import {
  deleteMotionScene3DAnimationKeyframe,
  inspectMotionScene3DAnimation,
  moveMotionScene3DAnimationKeyframe,
  removeMotionScene3DAnimationTrack,
  upsertMotionScene3DAnimationKeyframe,
  upsertMotionScene3DAnimationTrack,
} from "./motion-scene3d-animation-authoring";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument } from "./types";

describe("C5C1C scene3d animation authoring", () => {
  it("inspects absent/present stores without mutating frozen source data", () => {
    const source = deepFreeze(document());
    const before = canonicalJson(source);
    expect(inspectMotionScene3DAnimation(source)).toEqual({ store: null, storeSha256: null, tracks: [] });
    expect(canonicalJson(source)).toBe(before);

    const output = upsertMotionScene3DAnimationTrack(source, { track: track("camera-fov", camera("fovDeg"), [key(100, 50)]) });
    expect(output.action).toBe("track_inserted");
    expect(output.beforeStoreSha256).toBeNull();
    expect(output.afterStoreSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.motion).not.toBe(source);
    expect(Object.isFrozen(source)).toBe(true);
    expect(canonicalJson(source)).toBe(before);
    expect(inspectMotionScene3DAnimation(output.motion)).toMatchObject({
      store: { tracks: [{ id: "camera-fov", locator: camera("fovDeg"), keyframes: [{ atUs: 100, value: 50 }] }] },
      tracks: [{ id: "camera-fov", keyframes: [{ atUs: 100, sha256: expect.any(String) }] }],
    });
    expect(validateDocumentSync(loadSchemaSync("motion"), output.motion)).toMatchObject({ ok: true });
  });

  it("uses C5C1A typed values/easing and performs exact keyframe COW lifecycle", () => {
    const first = upsertMotionScene3DAnimationTrack(document(), {
      track: track("beacon-color", object("beacon", "color"), [key(100, "#AABBCC", "ease-in")]),
    });
    const second = upsertMotionScene3DAnimationKeyframe(first.motion, {
      trackId: "beacon-color", keyframe: key(300, "#DDEEFF", { type: "spring", stiffness: 100, damping: 10 }),
    });
    expect(second).toMatchObject({ action: "keyframe_inserted", index: 1, beforeKeyframeSha256: null, afterKeyframeSha256: expect.any(String) });
    expect(second.motion.scene3dAnimation!.tracks[0]!.keyframes).toEqual([
      { atUs: 100, value: "#aabbcc", easing: "ease-in" },
      { atUs: 300, value: "#ddeeff", easing: { type: "spring", stiffness: 100, damping: 10 } },
    ]);

    const moved = moveMotionScene3DAnimationKeyframe(second.motion, { trackId: "beacon-color", fromAtUs: 300, toAtUs: 200 });
    expect(moved).toMatchObject({ action: "keyframe_moved", index: 1, previousIndex: 1 });
    const deleted = deleteMotionScene3DAnimationKeyframe(moved.motion, { trackId: "beacon-color", atUs: 200 });
    expect(deleted).toMatchObject({ action: "keyframe_deleted", beforeKeyframeSha256: expect.any(String), afterKeyframeSha256: null });
    expect(deleted.motion.scene3dAnimation!.tracks[0]!.keyframes).toEqual([{ atUs: 100, value: "#aabbcc", easing: "ease-in" }]);
  });

  it("replaces one complete track only at the same stable locator and removes the final root", () => {
    const first = upsertMotionScene3DAnimationTrack(document(), { track: track("fov", camera("fovDeg"), [key(100, 50)]) });
    const replaced = upsertMotionScene3DAnimationTrack(first.motion, { track: track("fov", camera("fovDeg"), [key(100, 55), key(200, 60)]) });
    expect(replaced).toMatchObject({ action: "track_replaced", beforeTrackSha256: expect.any(String), afterTrackSha256: expect.any(String) });
    expect(() => upsertMotionScene3DAnimationTrack(replaced.motion, { track: track("fov", camera("target"), [key(100, [0, 0, 0])]) }))
      .toThrow("old/new locator identity mismatch");
    expect(() => upsertMotionScene3DAnimationTrack(replaced.motion, { track: track("other", camera("fovDeg"), [key(100, 55)]) }))
      .toThrow("already belongs");

    const removed = removeMotionScene3DAnimationTrack(replaced.motion, { trackId: "fov" });
    expect(removed).toMatchObject({ action: "track_removed", afterStoreSha256: null, afterTrackSha256: null });
    expect(removed.motion.scene3dAnimation).toBeUndefined();
    expect(validateDocumentSync(loadSchemaSync("motion"), removed.motion)).toMatchObject({ ok: true });
  });

  it("refuses no-op, collisions, missing items, exact-time violations, locks, and legacy transform authority", () => {
    const first = upsertMotionScene3DAnimationTrack(document(), { track: track("fov", camera("fovDeg"), [key(100, 50)]) });
    expect(() => upsertMotionScene3DAnimationTrack(first.motion, { track: track("fov", camera("fovDeg"), [key(100, 50)]) })).toThrow("did not change");
    expect(() => upsertMotionScene3DAnimationKeyframe(first.motion, { trackId: "fov", keyframe: key(100, 50) })).toThrow("did not change");
    expect(() => deleteMotionScene3DAnimationKeyframe(first.motion, { trackId: "fov", atUs: 100 })).toThrow("retain one keyframe");
    expect(() => moveMotionScene3DAnimationKeyframe(first.motion, { trackId: "fov", fromAtUs: 100, toAtUs: 100 })).toThrow("identity mismatch");
    expect(() => moveMotionScene3DAnimationKeyframe(first.motion, { trackId: "fov", fromAtUs: 101, toAtUs: 200 })).toThrow("is absent");
    expect(() => upsertMotionScene3DAnimationKeyframe(first.motion, { trackId: "fov", keyframe: key(1.5, 50) })).toThrow("safe integer");
    expect(() => upsertMotionScene3DAnimationKeyframe(first.motion, { trackId: "fov", keyframe: key(200, 999) })).toThrow("within");
    expect(() => removeMotionScene3DAnimationTrack(first.motion, { trackId: "missing" })).toThrow("is absent");

    const locked = { ...document(), layers: document().layers.map((layer) => ({ ...layer, locked: true })) };
    expect(() => upsertMotionScene3DAnimationTrack(locked, { track: track("fov", camera("fovDeg"), [key(100, 50)]) })).toThrow("locked layer");
    const trackLocked = document();
    trackLocked.tracks = [{ id: "world-track", type: "overlay", locked: true, layerIds: ["world"] }];
    expect(() => upsertMotionScene3DAnimationTrack(trackLocked, { track: track("fov", camera("fovDeg"), [key(100, 50)]) })).toThrow("locked track");

    const legacy = document();
    (legacy.layers[0]!.scene3d!.camera as Record<string, unknown>).orbitDegPerSecond = 0;
    expect(() => upsertMotionScene3DAnimationTrack(legacy, { track: track("fov", camera("fovDeg"), [key(100, 50)]) })).toThrow("orbitDegPerSecond");
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "scene3d-authoring", name: "Scene3d authoring", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
      scene3d: {
        schema: "shellx-motion/scene3d@1",
        camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
        lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
        backgroundColor: "#101820",
        objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }],
      },
    }],
  };
}
function track(id: string, locator: unknown, keyframes: unknown[]) { return { id, locator, keyframes }; }
function key(atUs: number, value: unknown, easing?: unknown) { return { atUs, value, ...(easing === undefined ? {} : { easing }) }; }
function camera(property: "position" | "target" | "fovDeg") { return { layerId: "world", scope: "camera", property }; }
function object(objectId: string, property: "position" | "rotationDeg" | "scale" | "emissive" | "color") { return { layerId: "world", scope: "object", objectId, property }; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
