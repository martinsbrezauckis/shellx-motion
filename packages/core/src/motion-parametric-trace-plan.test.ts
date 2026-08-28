import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { compileMotionParametricTracePlan } from "./motion-parametric-trace-plan";
import { readMotionParametricTraceDescriptor } from "./motion-parametric-trace-read";
import type { MotionDocument } from "./types";

describe("private C4C parametric trace plans", () => {
  it("is exact-time deterministic, immutable, source-preserving, and trig-config-bound", () => {
    const source = descriptor([graphDrawer("orbit", lissajousGraph(), "ribbon", { kind: "full-clip", maxSamples: 8 })]);
    const before = canonicalJson(source), first = compileMotionParametricTracePlan(source), cold = compileMotionParametricTracePlan(structuredClone(source));
    expect(first).toMatchObject({ ok: true }); expect(cold).toEqual(first); expect(canonicalJson(source)).toBe(before);
    if (!first.ok) return;
    expect(first.plan.schedule).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(first.plan.evidence).toMatchObject({ trigonometry: "quantized-radians@1", noRenderer: true, noPixelClaim: true });
    expect(Object.isFrozen(first.plan)).toBe(true); expect(Object.isFrozen(first.plan.drawers[0]!.samples)).toBe(true);
    const changed = structuredClone(source); changed.drawers[0]!.driver.graph.nodes[1]!.value = 0.002;
    const revised = compileMotionParametricTracePlan(changed);
    expect(revised).toMatchObject({ ok: true }); if (revised.ok) expect(revised.plan.fingerprint).not.toBe(first.plan.fingerprint);
  });

  it("evaluates the closed integer-turn Lissajous axis and refuses widened axis parameters", () => {
    const graph: any = { nodes: [{ id: "time", kind: "time-us" }, { id: "x", kind: "lissajous-axis-q1024", time: "time", durationUs: 4_000, frequency: 1, phaseTurnsQ1024: 0, center: 0, amplitude: 1 }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } };
    const accepted = compileMotionParametricTracePlan(descriptor([graphDrawer("lissajous", graph, "line", { kind: "full-clip", maxSamples: 8 })]));
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) expect(accepted.plan.drawers[0]!.samples.map((sample) => sample.position.x)).toEqual([0, 1, 0, -1, 0]);
    graph.nodes[1]!.frequency = 17;
    expect(compileMotionParametricTracePlan(descriptor([graphDrawer("lissajous", graph, "line", { kind: "full-clip", maxSamples: 8 })]))).toMatchObject({ ok: false, message: expect.stringContaining("frequency") });
  });

  it("covers nested orbit, Lissajous, spiral, existing path-follow, and bounded 3D bounce", () => {
    const source = descriptor([
      bounceDrawer("bounce", "points", { kind: "full-clip", maxSamples: 8 }),
      graphDrawer("lissajous", lissajousGraph(), "line", { kind: "last-samples", samples: 3 }),
      graphDrawer("nested", nestedOrbitGraph(), "ribbon", { kind: "last-us", durationUs: 1_000 }),
      pathDrawer("path", "tube", { kind: "age-fade", durationUs: 1_000 }),
      graphDrawer("spiral", spiralGraph(), "line", { kind: "distance", distance: 2 }),
    ]);
    const result = compileMotionParametricTracePlan(source);
    expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    expect(result.plan.drawers.map((drawer) => drawer.driver.kind)).toEqual(["bounded-bounce", "parametric-graph", "parametric-graph", "path-follow", "parametric-graph"]);
    expect(result.plan.drawers.map((drawer) => drawer.output.mode)).toEqual(["points", "line", "ribbon", "tube", "line"]);
    expect(result.plan.drawers[0]!.samples.at(-1)!.position.z).toBeGreaterThan(0);
    expect(result.plan.drawers[3]!.samples.at(-1)!.position).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it("models full finite clip, bounded sample/us tails, distance, and age-fade without retained histories", () => {
    const age = graphDrawer("age", movingGraph(), "line", { kind: "age-fade", durationUs: 1_000 }); age.output = output("line", true);
    const source = descriptor([
      age,
      graphDrawer("distance", movingGraph(), "line", { kind: "distance", distance: 1.5 }),
      graphDrawer("full", movingGraph(), "line", { kind: "full-clip", maxSamples: 5 }),
      graphDrawer("samples", movingGraph(), "line", { kind: "last-samples", samples: 2 }),
      graphDrawer("us", movingGraph(), "line", { kind: "last-us", durationUs: 1_000 }),
    ]);
    const result = compileMotionParametricTracePlan(source);
    expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    const count = (id: string) => result.plan.drawers.find((drawer) => drawer.id === id)!.windows.at(-1)!.sampleCount;
    expect({ full: count("full"), samples: count("samples"), us: count("us"), distance: count("distance"), age: count("age") }).toEqual({ full: 5, samples: 2, us: 2, distance: 2, age: 2 });
    expect(result.plan.drawers.every((drawer) => drawer.windows.length === result.plan.schedule.length)).toBe(true);
    expect(result.plan.drawers.every((drawer) => drawer.windows.every((window) => window.sampleCount <= result.plan.schedule.length))).toBe(true);
  });

  it("labels generic radians, exact modular turns, and mixed graphs without conflating their evaluator rails", () => {
    const generic = compileMotionParametricTracePlan(descriptor([graphDrawer("generic", lissajousGraph(), "line", { kind: "full-clip", maxSamples: 8 })]));
    expect(generic).toMatchObject({ ok: true, plan: { evidence: { trigonometry: "quantized-radians@1" } } });
    const modular = compileMotionParametricTracePlan(descriptor([graphDrawer("modular", modularTurnsGraph(), "line", { kind: "full-clip", maxSamples: 8 })]));
    expect(modular).toMatchObject({ ok: true, plan: { evidence: { trigonometry: "exact-modular-turns@1" } } });
    const mixed = compileMotionParametricTracePlan(descriptor([
      graphDrawer("generic", lissajousGraph(), "line", { kind: "full-clip", maxSamples: 8 }),
      graphDrawer("modular", modularTurnsGraph(), "line", { kind: "full-clip", maxSamples: 8 }),
    ]));
    expect(mixed).toMatchObject({ ok: true, plan: { evidence: { trigonometry: "mixed-quantized-radians-and-exact-modular-turns@1" } } });
  });

  it("refuses per-drawer full-clip and aggregate multi-drawer caps before a plan is returned", () => {
    const full = descriptor([graphDrawer("full", movingGraph(), "line", { kind: "full-clip", maxSamples: 4 })]);
    expect(compileMotionParametricTracePlan(full)).toMatchObject({ ok: false, message: expect.stringContaining("full-clip retention") });
    const aggregate = descriptor([graphDrawer("a", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 }), graphDrawer("b", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    aggregate.caps.aggregate.maxVertices = 6;
    expect(compileMotionParametricTracePlan(aggregate)).toMatchObject({ ok: false, message: expect.stringContaining("aggregate vertices") });
  });

  it("keeps width, opacity, colour, constant, and age-fade signals in their closed semantics", () => {
    const source = descriptor([graphDrawer("signal", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    source.drawers[0]!.output.width.from = -1;
    expect(compileMotionParametricTracePlan(source)).toMatchObject({ ok: false, message: expect.stringContaining("width") });
    const opacity = descriptor([graphDrawer("signal", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    opacity.drawers[0]!.output.opacity.to = 1.1;
    expect(compileMotionParametricTracePlan(opacity)).toMatchObject({ ok: false, message: expect.stringContaining("opacity") });
    const colour = descriptor([graphDrawer("signal", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    colour.drawers[0]!.output.colour.to = 2;
    expect(compileMotionParametricTracePlan(colour)).toMatchObject({ ok: false, message: expect.stringContaining("colour") });
    const constant = descriptor([graphDrawer("signal", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    constant.drawers[0]!.output.width = { source: "constant", from: 1, to: 2 };
    expect(compileMotionParametricTracePlan(constant)).toMatchObject({ ok: false, message: expect.stringContaining("constant") });
    const fade = graphDrawer("signal", movingGraph(), "line", { kind: "age-fade", durationUs: 1_000 });
    fade.output = output("line", true); fade.output.opacity.to = 0.5;
    const accepted = compileMotionParametricTracePlan(descriptor([fade]));
    expect(accepted).toMatchObject({ ok: true }); if (accepted.ok) expect(accepted.plan.drawers[0]!.output.opacity).toEqual({ source: "age", from: 1, to: 0.5 });
  });

  it("caps total compile work and binds truthful serialized storage into the fingerprinted plan", () => {
    const perDrawer = descriptor([graphDrawer("work", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    perDrawer.caps.perDrawer.maxWorkUnits = 20;
    expect(compileMotionParametricTracePlan(perDrawer)).toMatchObject({ ok: false, message: expect.stringContaining("total compile work") });
    const aggregate = descriptor([graphDrawer("a", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 }), graphDrawer("b", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    aggregate.caps.aggregate.maxWorkUnits = 60;
    expect(compileMotionParametricTracePlan(aggregate)).toMatchObject({ ok: false, message: expect.stringContaining("aggregate total compile work") });
    const result = compileMotionParametricTracePlan(descriptor([graphDrawer("storage", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]));
    expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    expect(Buffer.byteLength(canonicalJson(result.plan), "utf8")).toBe(result.plan.budget.storageBytes);
    expect(result.plan.budget.peakBytes).toBe(result.plan.budget.storageBytes + result.plan.budget.maxFrameBytes);
    expect(result.plan.budget.storageBytes).toBeGreaterThan(result.plan.budget.maxFrameBytes);
    const combined = structuredClone(descriptor([graphDrawer("storage", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]));
    combined.caps.perDrawer.maxBytes = result.plan.drawers[0]!.budget.peakBytes - 1;
    combined.caps.aggregate.maxBytes = result.plan.budget.peakBytes - 1;
    expect(compileMotionParametricTracePlan(combined)).toMatchObject({ ok: false, message: expect.stringContaining("peak bytes") });
  });

  it("uses existing behavior/relation authorities without mutation and refuses fractional-ms relation samples", () => {
    const motion = deepFreeze(authorityMotion()), before = canonicalJson(motion);
    const result = compileMotionParametricTracePlan(descriptor([
      { id: "behavior", driver: { kind: "behavior", targetLayerId: "behavior" }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") },
      { id: "relation", driver: { kind: "relation", targetLayerId: "related" }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") },
    ]), { motion });
    expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    expect(result.plan.drawers.every((drawer) => /^[a-f0-9]{64}$/.test(drawer.driver.authorityFingerprint ?? ""))).toBe(true);
    expect(canonicalJson(motion)).toBe(before); expect(isDeeplyFrozen(motion)).toBe(true);
    const fractional = descriptor([{ id: "relation", driver: { kind: "relation", targetLayerId: "related" }, retention: { kind: "full-clip", maxSamples: 9 }, output: output("line") }]);
    fractional.clip.sampleIntervalUs = 500; fractional.caps.perDrawer.maxSamples = 9;
    expect(compileMotionParametricTracePlan(fractional, { motion })).toMatchObject({ ok: false, message: expect.stringContaining("whole-millisecond exact samples") });
    expect(canonicalJson(motion)).toBe(before); expect(isDeeplyFrozen(motion)).toBe(true);
  });

  it("preflights aggregate samples before any behavior or relation authority access", () => {
    const source = descriptor([
      { id: "a", driver: { kind: "behavior", targetLayerId: "behavior" }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") },
      { id: "b", driver: { kind: "relation", targetLayerId: "related" }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") },
    ]);
    source.caps.aggregate.maxSamples = 9;
    let authorityGets = 0;
    const authority = new Proxy({}, { get() { authorityGets += 1; throw new Error("authority must not be evaluated"); } });
    expect(compileMotionParametricTracePlan(source, authority)).toMatchObject({ ok: false, message: expect.stringContaining("aggregate samples") });
    expect(authorityGets).toBe(0);
  });

  it("keeps collision closed to box, sphere, and plane with explicit bounded collision work", () => {
    for (const collision of [
      { kind: "box", min: vector(-2, -2, -2), max: vector(2, 2, 2) },
      { kind: "sphere", center: vector(0, 0, 0), radius: 2 },
      { kind: "plane", normal: vector(0, 1, 0), offset: -1 },
    ]) {
      const source = descriptor([{ id: "bounce", driver: { kind: "bounded-bounce", initial: vector(0, 0, 0), velocity: vector(1, 0.5, 0.25), collision, maxCollisions: 8 }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") }]);
      expect(compileMotionParametricTracePlan(source)).toMatchObject({ ok: true });
    }
    const capped = descriptor([{ id: "bounce", driver: { kind: "bounded-bounce", initial: vector(0, 0, 0), velocity: vector(1_000, 0, 0), collision: { kind: "box", min: vector(-1, -1, -1), max: vector(1, 1, 1) }, maxCollisions: 1 }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") }]);
    expect(compileMotionParametricTracePlan(capped)).toMatchObject({ ok: false, message: expect.stringContaining("collision cap") });
    const sphere = descriptor([{ id: "sphere", driver: { kind: "bounded-bounce", initial: vector(0, 0, 0), velocity: vector(1_000, 0, 0), collision: { kind: "sphere", center: vector(0, 0, 0), radius: 1 }, maxCollisions: 2 }, retention: { kind: "full-clip", maxSamples: 8 }, output: output("line") }]);
    const solved = compileMotionParametricTracePlan(sphere);
    expect(solved).toMatchObject({ ok: true }); if (!solved.ok) return;
    expect(solved.plan.drawers[0]!.samples.map((sample) => sample.position.x)).toEqual([0, 1, 0, -1, 0]);
    expect(solved.plan.drawers[0]!.samples.every((sample) => Math.hypot(sample.position.x, sample.position.y, sample.position.z) <= 1)).toBe(true);
    const sphereCapped = structuredClone(sphere); sphereCapped.drawers[0]!.driver.maxCollisions = 1;
    expect(compileMotionParametricTracePlan(sphereCapped)).toMatchObject({ ok: false, message: expect.stringContaining("sphere bounce exceeds its explicit 1-collision cap") });
    const boundary = structuredClone(sphere); boundary.drawers[0]!.driver.initial = vector(1, 0, 0);
    expect(compileMotionParametricTracePlan(boundary)).toMatchObject({ ok: false, message: expect.stringContaining("strictly inside") });
  });

  it("refuses getters, cycles, sparse arrays, and oversized drawer/node arrays before hostile field reflection", () => {
    let ownKeys = 0, gets = 0;
    const drawers = new Proxy(new Array(17), { ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); }, get(target, key, receiver) { gets += 1; return Reflect.get(target, key, receiver); } });
    expect(() => readMotionParametricTraceDescriptor({ ...descriptor([]), drawers })).toThrow("at most 16");
    expect({ ownKeys, gets }).toEqual({ ownKeys: 0, gets: 0 });
    ownKeys = 0; gets = 0;
    const huge = new Proxy(new Array(100_000), { ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); }, get(target, key, receiver) { gets += 1; return Reflect.get(target, key, receiver); } });
    expect(() => readMotionParametricTraceDescriptor({ ...descriptor([]), drawers: huge })).toThrow("at most 16");
    expect({ ownKeys, gets }).toEqual({ ownKeys: 0, gets: 0 });
    const hostileNodes = new Proxy(new Array(65), { ownKeys() { throw new Error("must not enumerate nodes"); } });
    const graph = lissajousGraph(); graph.nodes = hostileNodes as unknown as typeof graph.nodes;
    expect(() => readMotionParametricTraceDescriptor(descriptor([graphDrawer("node", graph, "line", { kind: "full-clip", maxSamples: 8 })]))).toThrow("at most 64");
    const sparse: unknown[] = []; sparse.length = 1;
    expect(() => readMotionParametricTraceDescriptor({ ...descriptor([]), drawers: sparse })).toThrow("dense");
    const cyclic = graphDrawer("cycle", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 }); cyclic.driver.graph = cyclic.driver;
    expect(() => readMotionParametricTraceDescriptor(descriptor([cyclic]))).toThrow("cycles");
    const getter = descriptor([graphDrawer("getter", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]);
    Object.defineProperty(getter, "drawers", { enumerable: true, get: () => { throw new Error("getter ran"); } });
    expect(() => readMotionParametricTraceDescriptor(getter)).toThrow("enumerable data field");
    const geometryTraps = { ownKeys: 0, descriptors: 0 };
    const geometry = new Proxy({ schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 1, height: 1 }, data: "M 0 0 Z", extra: true }, { ownKeys(target) { geometryTraps.ownKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { geometryTraps.descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    const geometryPath = pathDrawer("path", "line", { kind: "full-clip", maxSamples: 8 }); geometryPath.driver.geometry = geometry;
    expect(() => readMotionParametricTraceDescriptor(descriptor([geometryPath]))).toThrow("geometry field limit");
    expect(geometryTraps).toEqual({ ownKeys: 1, descriptors: 0 });
    const easingTraps = { ownKeys: 0, descriptors: 0 };
    const easing = new Proxy({ type: "spring", stiffness: 10, damping: 2, mass: 1, initialVelocity: 0, extra: true }, { ownKeys(target) { easingTraps.ownKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { easingTraps.descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    expect(() => readMotionParametricTraceDescriptor(descriptor([pathDrawer("path", "line", { kind: "full-clip", maxSamples: 8 }, easing)]))).toThrow("easing field limit");
    expect(easingTraps).toEqual({ ownKeys: 1, descriptors: 0 });
  });

  it("has no renderer or public Core index export", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("motion-parametric-trace");
    expect(compileMotionParametricTracePlan(descriptor([graphDrawer("private", movingGraph(), "line", { kind: "full-clip", maxSamples: 8 })]))).toMatchObject({ ok: true, plan: { evidence: { noRenderer: true, noPixelClaim: true } } });
  });
});

function descriptor(drawers: any[]) { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers, caps: { perDrawer: { maxSamples: 8, maxVertices: 2_000, maxWorkUnits: 20_000, maxBytes: 1_000_000 }, aggregate: { maxSamples: 64, maxVertices: 8_000, maxWorkUnits: 80_000, maxBytes: 4_000_000 } } }; }
function output(mode: "line" | "ribbon" | "tube" | "points", ageFade = false) { return { mode, width: { source: "age", from: 1, to: 4 }, colour: { source: "drawer", from: 0, to: 1 }, opacity: ageFade ? { source: "age", from: 1, to: 0 } : { source: "speed", from: 0.2, to: 1 }, speedLimit: 100 }; }
function graphDrawer(id: string, graph: any, mode: "line" | "ribbon" | "tube" | "points", retention: any) { return { id, driver: { kind: "parametric-graph", graph }, retention, output: output(mode) }; }
function pathDrawer(id: string, mode: "line" | "ribbon" | "tube" | "points", retention: any, easing?: unknown) { return { id, driver: { kind: "path-follow", startUs: 0, durationUs: 4_000, geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 10, height: 10 }, data: "M 0 0 L 10 0 L 10 10 Z" }, ...(easing === undefined ? {} : { easing }) }, retention, output: output(mode, retention.kind === "age-fade") }; }
function bounceDrawer(id: string, mode: "line" | "ribbon" | "tube" | "points", retention: any) { return { id, driver: { kind: "bounded-bounce", initial: vector(0, 0, 0), velocity: vector(2, 1, 3), collision: { kind: "box", min: vector(-4, -4, -4), max: vector(4, 4, 4) }, maxCollisions: 8 }, retention, output: output(mode) }; }
function vector(x: number, y: number, z: number) { return { x, y, z }; }
function movingGraph() { return { nodes: [{ id: "t", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "t", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } }; }
function lissajousGraph() { return { nodes: [{ id: "t", kind: "time-us" }, { id: "a", kind: "constant", value: 0.001 }, { id: "xIn", kind: "multiply", left: "t", right: "a" }, { id: "x", kind: "sin", input: "xIn" }, { id: "b", kind: "constant", value: 0.002 }, { id: "yIn", kind: "multiply", left: "t", right: "b" }, { id: "y", kind: "sin", input: "yIn" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "y", z: "zero" } }; }
function modularTurnsGraph() { return { nodes: [{ id: "t", kind: "time-us" }, { id: "x", kind: "lissajous-axis-q1024", time: "t", durationUs: 4_000, frequency: 3, phaseTurnsQ1024: 256, center: 4, amplitude: 2 }, { id: "y", kind: "lissajous-axis-q1024", time: "t", durationUs: 4_000, frequency: 2, phaseTurnsQ1024: 0, center: 3, amplitude: 1 }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "y", z: "zero" } }; }
function nestedOrbitGraph() { return { nodes: [{ id: "t", kind: "time-us" }, { id: "a", kind: "constant", value: 0.001 }, { id: "aIn", kind: "multiply", left: "t", right: "a" }, { id: "aCos", kind: "cos", input: "aIn" }, { id: "aSin", kind: "sin", input: "aIn" }, { id: "b", kind: "constant", value: 0.002 }, { id: "bIn", kind: "multiply", left: "t", right: "b" }, { id: "bCos", kind: "cos", input: "bIn" }, { id: "bSin", kind: "sin", input: "bIn" }, { id: "r1", kind: "constant", value: 5 }, { id: "r2", kind: "constant", value: 2 }, { id: "x1", kind: "multiply", left: "aCos", right: "r1" }, { id: "x2", kind: "multiply", left: "bCos", right: "r2" }, { id: "x", kind: "add", left: "x1", right: "x2" }, { id: "y1", kind: "multiply", left: "aSin", right: "r1" }, { id: "y2", kind: "multiply", left: "bSin", right: "r2" }, { id: "y", kind: "add", left: "y1", right: "y2" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "y", z: "zero" } }; }
function spiralGraph() { return { nodes: [{ id: "t", kind: "time-us" }, { id: "radiusRate", kind: "constant", value: 0.001 }, { id: "radius", kind: "multiply", left: "t", right: "radiusRate" }, { id: "angleRate", kind: "constant", value: 0.002 }, { id: "angle", kind: "multiply", left: "t", right: "angleRate" }, { id: "cos", kind: "cos", input: "angle" }, { id: "sin", kind: "sin", input: "angle" }, { id: "x", kind: "multiply", left: "radius", right: "cos" }, { id: "y", kind: "multiply", left: "radius", right: "sin" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "y", z: "zero" } }; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function isDeeplyFrozen(value: unknown): boolean { return typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen)); }
function authorityMotion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "trace-authority", name: "Trace authority", durationMs: 4, fps: 30, width: 64, height: 64, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "behavior", type: "shape", shape: "rect", startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 1, height: 1 } }, { id: "source", type: "shape", shape: "rect", startMs: 0, durationMs: 4, transform: { x: 5, y: 5, width: 1, height: 1 } }, { id: "related", type: "shape", shape: "rect", startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 1, height: 1 } }], behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "behavior", enabled: true, kind: "transform", startUs: 0, durationUs: 4_000, motion: { kind: "gravity", velocityX: 10, velocityY: 0, gravityY: 0 } }] }, relations: { schema: "shellx-motion/relations@1", bindings: [{ id: "follow", enabled: true, kind: "attach", source: { layerId: "source", anchor: { x: 0, y: 0 } }, target: { layerId: "related", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 4_000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } }] } }; }
