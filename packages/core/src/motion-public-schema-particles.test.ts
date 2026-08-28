import { describe, expect, it } from "vitest";
import { buildMotionPublicSchema, MOTION_DOCUMENT_SCHEMA } from "./motion-public-schema";
import { validateAgainstPublishedSchema } from "./published-schema-check";

const field = { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.4, softening: 0.2 }] };
const v2Field = { schema: "shellx-motion/particle-field@2", sources: [{ kind: "flow", angleDeg: 15, strength: 0.4 }] };

describe("source-owned high-density particle schema", () => {
  it("admits only the fixed analytic 100k..131072 circle route above the CPU cap", () => {
    expect(errors({ count: 100_000, shape: "circle", field })).toEqual([]);
    expect(errors({ count: 131_072, shape: "circle", field })).toEqual([]);
    expect(errors({ count: 1_001 })).not.toEqual([]);
    expect(errors({ count: 99_999, shape: "circle", field })).not.toEqual([]);
    expect(errors({ count: 100_000, shape: "square", field })).not.toEqual([]);
    expect(errors({ count: 100_000, shape: "circle" })).not.toEqual([]);
    expect(errors({ count: 131_073, shape: "circle", field })).not.toEqual([]);
  });

  it("admits v2 only on its fixed high-density circle route and binds v2-only emitter controls to it", () => {
    expect(errors({ count: 100_000, shape: "circle", field: v2Field, origins: [{ x: 0.2, y: 0.8, weight: 1 }], trail: { durationMs: 300, samples: 3 }, shading: { mode: "soft" } })).toEqual([]);
    expect(errors({ count: 100_000, shape: "circle", field: v2Field, packageExtension: { future: true } })).toEqual([]);
    expect(errors({ count: 100_000, shape: "circle", field: { ...field, v1Extension: true, sources: [{ ...field.sources[0], sourceExtension: true }] } })).toEqual([]);
    expect(errors({ count: 100_000, shape: "circle", field: { ...v2Field, v2Extension: true } })).not.toEqual([]);
    expect(errors({ count: 100_000, shape: "circle", field: { ...v2Field, sources: [{ ...v2Field.sources[0], formula: "arbitrary" }] } })).not.toEqual([]);
    expect(errors({ count: 1_000, field: v2Field })).not.toEqual([]);
    expect(errors({ count: 1_000, field, origins: [{ x: 0.2, y: 0.8, weight: 1 }] })).not.toEqual([]);
  });
});

function errors(emitter: Record<string, unknown>) {
  return validateAgainstPublishedSchema(buildMotionPublicSchema(), {
    schema: MOTION_DOCUMENT_SCHEMA, id: "particle_schema", name: "Particle schema", durationMs: 1_000, fps: 30, width: 100, height: 100, assets: [], provenance: {},
    layers: [{ id: "particles", type: "particles", startMs: 0, durationMs: 1_000, emitter: { seed: 1, lifetimeMs: 1_000, color: "#ffffff", ...emitter } }]
  });
}
