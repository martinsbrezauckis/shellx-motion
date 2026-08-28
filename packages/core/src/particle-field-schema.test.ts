import { describe, expect, it } from "vitest";
import { loadSchema, validateDocument } from "./validate";

describe("analytic particle field schema and validator", () => {
  it("accepts 1..3 bounded sources and refuses executable or unbounded data", async () => {
    const schema = await loadSchema("motion");
    expect(await validateDocument(schema, motionWithParticleField({
      schema: "shellx-motion/particle-field@1",
      sources: [
        { kind: "radial", centerX: 0.5, centerY: 0.4, strength: 0.75, softening: 0.2 },
        { kind: "vortex", centerX: 0.5, centerY: 0.4, strength: -0.4, softening: 0.12 }
      ]
    }))).toEqual({ ok: true });

    expect(await validateDocument(schema, motionWithParticleField({
      schema: "shellx-motion/particle-field@2",
      sources: [
        { kind: "noise", centerX: -0.1, centerY: 2, strength: 2, softening: 0, formula: "Math.random()" },
        { kind: "radial", centerX: 0, centerY: 0, strength: 0, softening: 0.1 },
        { kind: "radial", centerX: 0, centerY: 0, strength: 0, softening: 0.1 },
        { kind: "radial", centerX: 0, centerY: 0, strength: 0, softening: 0.1 }
      ],
      timestep: 60
    }))).toMatchObject({ ok: false, errors: expect.arrayContaining([
      { path: "/layers/0/emitter/field/sources/0/kind", message: "must be radial, vortex, flow, turbulence, impact, or collision" },
      { path: "/layers/0/emitter/field", message: expect.stringContaining("requires the fixed 100000..131072 circular high-density route") }
    ]) });

    expect(await validateDocument(schema, motionWithParticleField({
      schema: "shellx-motion/particle-field@1",
      sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.2, softening: 0.1, formula: "Math.random()" }],
      timestep: 60
    }))).toMatchObject({ ok: false, errors: expect.arrayContaining([
      { path: "/layers/0/emitter/field/sources/0/formula", message: "is not supported on particle field sources" },
      { path: "/layers/0/emitter/field/timestep", message: "is not supported on particle fields" }
    ]) });
  });
});

function motionWithParticleField(field: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1", id: "motion_particle_field", name: "Particle Field",
    durationMs: 1_000, fps: 30, width: 1920, height: 1080, assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [{
      id: "dust", type: "particles", startMs: 0, durationMs: 1_000,
      emitter: { seed: 1, count: 1, lifetimeMs: 1, color: "#ffffff", field }
    }]
  };
}
