import { describe, expect, it } from "vitest";
import { readMotionBehaviorStore } from "./motion-behavior-read";
import { validateMotionBehaviors } from "./motion-behavior-validate";
import { validateMotionDocumentGraphs } from "./motion-document-graphs";
import type { MotionDocument } from "./types";

describe("behavior store hostile admission", () => {
  it("rejects a 10k-key Proxy before descriptor or value reads", () => {
    let descriptors = 0, gets = 0, ownKeys = 0;
    const hostile = new Proxy({}, { ownKeys: () => { ownKeys += 1; return Array.from({ length: 10_000 }, (_, index) => `bad${index}`); }, getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; }, get: () => { gets += 1; return undefined; } });
    expect(() => readMotionBehaviorStore(hostile)).toThrow("12-field record limit");
    expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 1, descriptors: 0, gets: 0 });
  });

  it("refuses reflection failures, accessors, symbols, sparse arrays, cycles, unknowns, and open paths without mutation", () => {
    expect(() => readMotionBehaviorStore(new Proxy({}, { ownKeys: () => { throw new Error("trap"); } }))).toThrow("reflection failed");
    let reads = 0;
    const accessor = { schema: "shellx-motion/behaviors@1", bindings: [] as unknown[] };
    Object.defineProperty(accessor, "bindings", { enumerable: true, get() { reads += 1; return []; } });
    expect(() => readMotionBehaviorStore(accessor)).toThrow("enumerable data field"); expect(reads).toBe(0);
    expect(() => readMotionBehaviorStore({ schema: "shellx-motion/behaviors@1", bindings: Array(1) })).toThrow("dense");
    const symbol = { schema: "shellx-motion/behaviors@1", bindings: [] as unknown[] }; Object.defineProperty(symbol, Symbol("hostile"), { enumerable: true, value: true });
    expect(() => readMotionBehaviorStore(symbol)).toThrow("symbol");
    const cyclic: Record<string, unknown> = { schema: "shellx-motion/behaviors@1", bindings: [] }; cyclic.loop = cyclic;
    expect(() => readMotionBehaviorStore(cyclic)).toThrow("cycles");
    expect(() => readMotionBehaviorStore({ schema: "shellx-motion/behaviors@1", bindings: [path("M 0 0 L 100 0")] })).toThrow(/closed v1 path|one closed contour|closure/);
  });

  it("caps binding count, duration, exact keys, and preserves the caller source", () => {
    const source = { schema: "shellx-motion/behaviors@1", bindings: Array.from({ length: 33 }, (_, index) => transform(`s${index}`)) };
    const before = structuredClone(source);
    expect(() => readMotionBehaviorStore(source)).toThrow("array limit");
    expect(source).toEqual(before);
    expect(() => readMotionBehaviorStore({ schema: "shellx-motion/behaviors@1", bindings: [{ ...transform("s"), durationUs: 3_600_000_001 }] })).toThrow("durationUs");
    expect(() => readMotionBehaviorStore({ schema: "shellx-motion/behaviors@1", bindings: [{ ...transform("s"), ignored: true }] })).toThrow("unknown field");
  });

  it("keeps disabled authorities validated and reserved", () => {
    const document = motion();
    document.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ ...transform("s"), enabled: false }] };
    document.layers[0]!.keyframes = { "transform.y": [{ atMs: 0, value: 1 }] };
    expect(validateMotionBehaviors(document.behaviors, document)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("keyframes") })] });
  });

  it("refuses malformed relationship records without throwing during document validation", () => {
    const document = motion() as unknown as Record<string, unknown>;
    document.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ ...transform("s"), enabled: false }] };
    document.relationships = { schema: "shellx-motion/relationships@1", relationships: [{}] };
    const errors: Array<{ path: string; message: string }> = [];
    expect(() => validateMotionDocumentGraphs(document, errors)).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});

function motion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "h", name: "h", durationMs: 1_000, fps: 30, width: 100, height: 100, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "s", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } }] }; }
function transform(targetLayerId: string) { return { targetLayerId, enabled: true, kind: "transform" as const, startUs: 0, durationUs: 1, motion: { kind: "gravity" as const, velocityX: 1, velocityY: 0, gravityY: 0 } }; }
function path(data: string) { return { targetLayerId: "s", enabled: true, kind: "path-follow" as const, startUs: 0, durationUs: 1, geometry: { schema: "shellx-motion/shape-geometry@1" as const, kind: "path" as const, viewBox: { x: 0, y: 0, width: 100, height: 100 }, data } }; }
