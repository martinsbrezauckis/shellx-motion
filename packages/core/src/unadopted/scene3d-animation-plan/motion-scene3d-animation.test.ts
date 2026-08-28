import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { compileMotionScene3DAnimationPlan, evaluateMotionScene3DAnimationPlan } from "./motion-scene3d-animation";
import { readMotionScene3DAnimationSource } from "../../motion-scene3d-animation-source";

describe("C5C1A sampled scene3d animation authority", () => {
  it("samples generic camera, light, object, and background properties at exact microseconds", () => {
    const input = request([
      track("camera-position", camera("position"), [key(1_000, [2, 4, 8]), key(2_000, [4, 6, 10])]),
      track("camera-target", camera("target"), [key(1_000, [1, 0, 0])]),
      track("camera-fov", camera("fovDeg"), [key(1_000, 50), key(2_000, 60)]),
      track("ambient", light("ambient"), [key(1_000, 0.4)]),
      track("direction", light("direction"), [key(1_000, [0, -1, -1])]),
      track("intensity", light("intensity"), [key(1_000, 2)]),
      track("light-color", light("color"), [key(1_000, "#000000"), key(2_000, "#ffffff")]),
      track("position", object("beacon", "position"), [key(1_000, [1, 2, 3])]),
      track("rotation", object("beacon", "rotationDeg"), [key(1_000, [20, 30, 40])]),
      track("scale", object("beacon", "scale"), [key(1_000, 2)]),
      track("object-color", object("beacon", "color"), [key(1_000, "#ff0000"), key(2_000, "#0000ff")]),
      track("emissive", object("beacon", "emissive"), [key(1_000, 0.8)]),
      track("background", background(), [key(1_000, "#000000"), key(2_000, "#ffffff")]),
    ]);
    const compiled = compileMotionScene3DAnimationPlan(input);
    expect(compiled).toMatchObject({ ok: true, plan: { evidence: { noRenderer: true, noPixelClaim: true, staticTopology: true }, budget: { trackCount: 13, frameWorkUnits: 32 } } });
    if (!compiled.ok) return;
    const frame = evaluateMotionScene3DAnimationPlan(compiled.plan, 1_500);
    expect(frame).toMatchObject({ ok: true, plan: { atUs: 1_500, budget: { activeTrackCount: 13 } } });
    if (!frame.ok) return;
    expect(value(frame.plan, "camera-position")).toEqual([3, 5, 9]);
    expect(value(frame.plan, "camera-target")).toEqual([1, 0, 0]);
    expect(value(frame.plan, "camera-fov")).toBe(55);
    expect(value(frame.plan, "ambient")).toBe(0.4);
    expect(value(frame.plan, "direction")).toEqual([0, -1, -1]);
    expect(value(frame.plan, "intensity")).toBe(2);
    expect(value(frame.plan, "light-color")).toBe("#808080");
    expect(value(frame.plan, "position")).toEqual([1, 2, 3]);
    expect(value(frame.plan, "rotation")).toEqual([20, 30, 40]);
    expect(value(frame.plan, "scale")).toBe(2);
    expect(value(frame.plan, "object-color")).toBe("#800080");
    expect(value(frame.plan, "emissive")).toBe(0.8);
    expect(value(frame.plan, "background")).toBe("#808080");
  });

  it("keeps the existing base before a delayed track, holds after the last key, and uses canonical easing", () => {
    const compiled = compileMotionScene3DAnimationPlan(request([track("fov", camera("fovDeg"), [key(1_000, 50, "ease-in"), key(2_000, 60)])]));
    expect(compiled).toMatchObject({ ok: true }); if (!compiled.ok) return;
    const before = evaluateMotionScene3DAnimationPlan(compiled.plan, 999);
    const exact = evaluateMotionScene3DAnimationPlan(compiled.plan, 1_000);
    const middle = evaluateMotionScene3DAnimationPlan(compiled.plan, 1_500);
    const after = evaluateMotionScene3DAnimationPlan(compiled.plan, 20_000);
    expect([before, exact, middle, after].every((result) => result.ok)).toBe(true);
    if (!before.ok || !exact.ok || !middle.ok || !after.ok) return;
    expect(value(before.plan, "fov")).toBe(45);
    expect(value(exact.plan, "fov")).toBe(50);
    expect(value(middle.plan, "fov")).toBe(52.5);
    expect(value(after.plan, "fov")).toBe(60);
  });

  it("is deterministic, detached, frozen, and preserves the caller source exactly", () => {
    const input = request([track("hero", object("beacon", "position"), [key(1_000, [4, 5, 6])])]);
    const before = canonicalJson(input), frozen = deepFreeze(structuredClone(input));
    const first = compileMotionScene3DAnimationPlan(frozen), cold = compileMotionScene3DAnimationPlan(structuredClone(input));
    expect(first).toEqual(cold); expect(canonicalJson(frozen)).toBe(before);
    expect(first).toMatchObject({ ok: true }); if (!first.ok) return;
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.plan.tracks[0]!.keyframes)).toBe(true);
    const frame = evaluateMotionScene3DAnimationPlan(first.plan, 1_000);
    expect(frame).toMatchObject({ ok: true }); if (frame.ok) expect(Object.isFrozen(frame.plan.samples)).toBe(true);
    const changed = structuredClone(input); changed.source.layers[0]!.scene3d.objects[0]!.primitive = "mesh";
    expect(compileMotionScene3DAnimationPlan(changed)).toMatchObject({ ok: false, message: expect.stringContaining("box, pyramid, plane") });
  });

  it("deeply freezes detached source snapshots and canonicalizes source/key/held colors", () => {
    const source = sourceForTests();
    source.layers[0]!.scene3d.backgroundColor = "#AABBCC";
    source.layers[0]!.scene3d.objects[0]!.color = "#DDEEFF";
    const detached = readMotionScene3DAnimationSource(source);
    expect(Object.isFrozen(detached.source)).toBe(true);
    expect(Object.isFrozen(detached.source.layers)).toBe(true);
    expect(Object.isFrozen(detached.source.layers[0]!.scene3d)).toBe(true);
    expect(Object.isFrozen(detached.source.layers[0]!.scene3d.camera.position)).toBe(true);
    expect(Object.isFrozen(detached.source.layers[0]!.scene3d.objects[0]!)).toBe(true);
    const compiled = compileMotionScene3DAnimationPlan({ animation: { schema: "shellx-motion/scene3d-animation@1", tracks: [track("background", background(), [key(1_000, "#ABCDEF")]), track("object", object("beacon", "color"), [key(1_000, "#FEDCBA")])] }, source });
    expect(compiled).toMatchObject({ ok: true }); if (!compiled.ok) return;
    const before = evaluateMotionScene3DAnimationPlan(compiled.plan, 999), held = evaluateMotionScene3DAnimationPlan(compiled.plan, 2_000);
    expect(before).toMatchObject({ ok: true }); expect(held).toMatchObject({ ok: true });
    if (!before.ok || !held.ok) return;
    expect(value(before.plan, "background")).toBe("#aabbcc");
    expect(value(before.plan, "object")).toBe("#ddeeff");
    expect(value(held.plan, "background")).toBe("#abcdef");
    expect(value(held.plan, "object")).toBe("#fedcba");
  });

  it("resolves layers and objects by stable ids, while refusing duplicate property authority and static fields", () => {
    const reordered = request([track("beacon", object("beacon", "color"), [key(1_000, "#00ff00")])]);
    reordered.source.layers[0]!.scene3d.objects = [...reordered.source.layers[0]!.scene3d.objects].reverse();
    const compiled = compileMotionScene3DAnimationPlan(reordered);
    expect(compiled).toMatchObject({ ok: true }); if (compiled.ok) expect(evaluateMotionScene3DAnimationPlan(compiled.plan, 1_000)).toMatchObject({ ok: true, plan: { samples: [expect.objectContaining({ value: "#00ff00" })] } });
    const duplicate = request([track("a", camera("fovDeg"), [key(1_000, 50)]), track("b", camera("fovDeg"), [key(1_000, 60)])]);
    expect(compileMotionScene3DAnimationPlan(duplicate)).toMatchObject({ ok: false, message: expect.stringContaining("one track authority") });
    const topology = request([track("bad", { layerId: "world", scope: "object", objectId: "beacon", property: "primitive" }, [key(1_000, "box")])]);
    expect(compileMotionScene3DAnimationPlan(topology)).toMatchObject({ ok: false, message: expect.stringContaining("not an admitted object property") });
  });

  it("refuses legacy spin/orbit transform drivers and invalid exact-time sampling", () => {
    const orbit = request([track("fov", camera("fovDeg"), [key(1_000, 50)])]); (orbit.source.layers[0]!.scene3d.camera as any).orbitDegPerSecond = 0;
    expect(compileMotionScene3DAnimationPlan(orbit)).toMatchObject({ ok: false, message: expect.stringContaining("orbitDegPerSecond") });
    const spin = request([track("rotation", object("beacon", "rotationDeg"), [key(1_000, [0, 90, 0])])]); (spin.source.layers[0]!.scene3d.objects[0] as any).spinDegPerSecond = [0, 0, 0];
    expect(compileMotionScene3DAnimationPlan(spin)).toMatchObject({ ok: false, message: expect.stringContaining("spinDegPerSecond") });
    const compiled = compileMotionScene3DAnimationPlan(request([track("fov", camera("fovDeg"), [key(1_000, 50)])]));
    expect(compiled).toMatchObject({ ok: true }); if (compiled.ok) expect(evaluateMotionScene3DAnimationPlan(compiled.plan, 1.5)).toMatchObject({ ok: false, message: expect.stringContaining("safe integer") });
  });

  it("refuses invalid combined camera position and target after exact sampling", () => {
    const oneTrack = compileMotionScene3DAnimationPlan(request([track("position", camera("position"), [key(1_000, [0, 0, 0])])]));
    expect(oneTrack).toMatchObject({ ok: true }); if (oneTrack.ok) expect(evaluateMotionScene3DAnimationPlan(oneTrack.plan, 1_000)).toMatchObject({ ok: false, message: expect.stringContaining("invalid camera position/target") });
    const crossing = compileMotionScene3DAnimationPlan(request([track("position", camera("position"), [key(1_000, [1, 2, 3])]), track("target", camera("target"), [key(1_000, [1, 2, 3])])]));
    expect(crossing).toMatchObject({ ok: true }); if (crossing.ok) expect(evaluateMotionScene3DAnimationPlan(crossing.plan, 1_000)).toMatchObject({ ok: false, message: expect.stringContaining("invalid camera position/target") });
  });

  it("enforces descriptor caps before source traversal and rejects hostile arrays without enumeration", () => {
    let sourceOwnKeys = 0;
    const source = new Proxy({}, { ownKeys() { sourceOwnKeys += 1; throw new Error("source must remain untouched"); } });
    const tooMany = { schema: "shellx-motion/scene3d-animation@1", tracks: Array.from({ length: 64 }, (_, index) => track(`track-${index}`, camera("fovDeg"), Array.from({ length: 64 }, (_, atUs) => key(atUs, 50)))) };
    expect(compileMotionScene3DAnimationPlan({ animation: tooMany, source })).toMatchObject({ ok: false, message: expect.stringContaining("aggregate limit before keyframe traversal") });
    expect(sourceOwnKeys).toBe(0);
    let keyframeOwnKeys = 0;
    const oversized = new Proxy(new Array(65), { ownKeys(target) { keyframeOwnKeys += 1; return Reflect.ownKeys(target); } });
    expect(compileMotionScene3DAnimationPlan({ animation: { schema: "shellx-motion/scene3d-animation@1", tracks: [{ id: "bad", locator: camera("fovDeg"), keyframes: oversized }] }, source: sourceForTests() })).toMatchObject({ ok: false, message: expect.stringContaining("at most 64") });
    expect(keyframeOwnKeys).toBe(0);
  });

  it("requires a compiler-minted plan before inspecting forged roots or track arrays", () => {
    let trackReads = 0;
    const millionTracks = new Proxy(new Array(1_000_000), { get(target, key, receiver) { trackReads += 1; return Reflect.get(target, key, receiver); }, ownKeys(target) { trackReads += 1; return Reflect.ownKeys(target); } });
    const forged = Object.freeze({ schema: "shellx-motion/private-scene3d-animation-plan@1", fingerprint: "0".repeat(64), tracks: millionTracks, budget: {}, evidence: {} });
    expect(evaluateMotionScene3DAnimationPlan(forged as any, 0)).toMatchObject({ ok: false, message: expect.stringContaining("compiler-minted") });
    expect(trackReads).toBe(0);
  });

  it("charges hostile source keys and structural JSON before nested descriptor reads", () => {
    let descriptors = 0;
    const keys = Array.from({ length: 12 }, (_, index) => `${index}-${"x".repeat(200_000)}`);
    const keyHeavyScene = new Proxy({}, { ownKeys() { return keys; }, getOwnPropertyDescriptor() { descriptors += 1; return undefined; } });
    const source = { layers: [{ id: "world", type: "scene3d", scene3d: keyHeavyScene }] };
    expect(compileMotionScene3DAnimationPlan({ animation: { schema: "shellx-motion/scene3d-animation@1", tracks: [track("fov", camera("fovDeg"), [key(1_000, 50)])] }, source })).toMatchObject({ ok: false, message: expect.stringContaining("2097152-byte") });
    expect(descriptors).toBe(0);
  });

  it("does not expose a renderer evaluator or lowering implication", () => {
    const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(index).toContain("motion-scene3d-animation-lane-refusal");
    expect(index).not.toContain("motion-scene3d-animation-plan");
    expect(index).not.toContain("motion-scene3d-animation-evaluate");
    expect(readFileSync(new URL("../../gpu-scene-3d.ts", import.meta.url), "utf8")).not.toContain("motion-scene3d-animation");
  });
});

function request(tracks: any[]) { return { animation: { schema: "shellx-motion/scene3d-animation@1", tracks }, source: sourceForTests() }; }
function sourceForTests() { return { layers: [{ id: "world", type: "scene3d", scene3d: { schema: "shellx-motion/scene3d@1", camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 }, lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" }, backgroundColor: "#101820", objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }, { id: "floor", primitive: "plane", position: [0, -1, 0], rotationDeg: [0, 0, 0], scale: 4, color: "#111111" }] } }] }; }
function track(id: string, locator: any, keyframes: any[]) { return { id, locator, keyframes }; }
function key(atUs: number, value: any, easing?: any) { return { atUs, value, ...(easing === undefined ? {} : { easing }) }; }
function camera(property: "position" | "target" | "fovDeg") { return { layerId: "world", scope: "camera", property }; }
function light(property: "ambient" | "direction" | "intensity" | "color") { return { layerId: "world", scope: "lighting", property }; }
function object(objectId: string, property: "position" | "rotationDeg" | "scale" | "emissive" | "color") { return { layerId: "world", scope: "object", objectId, property }; }
function background() { return { layerId: "world", scope: "background", property: "color" }; }
function value(plan: { samples: readonly { id: string; value: unknown }[] }, id: string): unknown { return plan.samples.find((sample) => sample.id === id)?.value; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
