import { describe, expect, it } from "vitest";
import { GPU_COMPUTE_PARTICLE_MAX_COUNT, GPU_COMPUTE_PARTICLE_MIN_COUNT } from "./gpu-particle-compute";
import type { MotionParticleField } from "./particle-field-types";
import { setTimelineLayerRichControl } from "./rich-controls";
import type { MotionDocument } from "./types";

describe("particle rich-control v2 count characterization", () => {
  it("admits only the exact fixed-compute v2 interval while retaining the low-count CPU ceiling", () => {
    const floor = v2Document(GPU_COMPUTE_PARTICLE_MAX_COUNT), floorBefore = structuredClone(floor);
    expect(setTimelineLayerRichControl(floor, {
      layerId: "field", path: "emitter.count", value: GPU_COMPUTE_PARTICLE_MIN_COUNT,
    }).newValue).toBe(GPU_COMPUTE_PARTICLE_MIN_COUNT);
    expect(floor).toEqual(floorBefore);

    expect(setTimelineLayerRichControl(v2Document(GPU_COMPUTE_PARTICLE_MIN_COUNT), {
      layerId: "field", path: "emitter.count", value: GPU_COMPUTE_PARTICLE_MAX_COUNT,
    }).newValue).toBe(GPU_COMPUTE_PARTICLE_MAX_COUNT);

    for (const value of [GPU_COMPUTE_PARTICLE_MIN_COUNT - 1, GPU_COMPUTE_PARTICLE_MAX_COUNT + 1]) {
      const rejected = v2Document(), before = structuredClone(rejected);
      expect(() => setTimelineLayerRichControl(rejected, { layerId: "field", path: "emitter.count", value }))
        .toThrow(`must be between ${GPU_COMPUTE_PARTICLE_MIN_COUNT} and ${GPU_COMPUTE_PARTICLE_MAX_COUNT}`);
      expect(rejected).toEqual(before);
    }

    const v1 = v1Document();
    expect(setTimelineLayerRichControl(v1, {
      layerId: "field", path: "emitter.count", value: 1_000,
    }).newValue).toBe(1_000);
    expect(() => setTimelineLayerRichControl(v1, {
      layerId: "field", path: "emitter.count", value: 1_001,
    })).toThrow("must be between 1 and 1000");

    const noField = noFieldDocument();
    expect(setTimelineLayerRichControl(noField, {
      layerId: "field", path: "emitter.count", value: 1_000,
    }).newValue).toBe(1_000);
    expect(() => setTimelineLayerRichControl(noField, {
      layerId: "field", path: "emitter.count", value: 1_001,
    })).toThrow("must be between 1 and 1000");
  });
});

function v2Document(count = GPU_COMPUTE_PARTICLE_MAX_COUNT): MotionDocument {
  return document({
    schema: "shellx-motion/particle-field@2",
    sources: [{ kind: "flow", angleDeg: 0, strength: 0.2 }],
  }, count);
}

function v1Document(): MotionDocument {
  const defaultCount = 100;
  return document({
    schema: "shellx-motion/particle-field@1",
    sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.2, softening: 0.2 }],
  }, defaultCount);
}

function noFieldDocument(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "particle_rich_count_no_field", name: "Particle rich count no field", durationMs: 1_000, fps: 25, width: 100, height: 100,
    layers: [{ id: "field", type: "particles", startMs: 0, durationMs: 1_000, emitter: { seed: 1, count: 100, lifetimeMs: 500, shape: "circle", color: "#ffffff" } }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  };
}

function document(field: MotionParticleField, count: number): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "particle_rich_count", name: "Particle rich count", durationMs: 1_000, fps: 25, width: 100, height: 100,
    layers: [{ id: "field", type: "particles", startMs: 0, durationMs: 1_000, emitter: { seed: 1, count, lifetimeMs: 500, shape: "circle", color: "#ffffff", field } }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  };
}
