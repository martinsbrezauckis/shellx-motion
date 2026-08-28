import { describe, expect, it } from "vitest";
import { listRendererCapabilityCards, requiredLayerFeatures } from "./capabilities";
import type { MotionLayer } from "./types";

describe("analytic particle field capability propagation", () => {
  it("requires and advertises the concrete seeded analytic-field feature", () => {
    const layer: MotionLayer = {
      id: "dust", type: "particles", startMs: 0, durationMs: 1_000,
      emitter: {
        seed: 1, count: 16, lifetimeMs: 900, color: "#ffffff",
        field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.3, softening: 0.2 }] }
      }
    };
    expect(requiredLayerFeatures(layer)).toEqual(expect.arrayContaining(["particles.seeded", "particles.analytic-field"]));
    for (const lane of ["native", "browser"] as const) {
      const card = listRendererCapabilityCards().find((candidate) => candidate.lane === lane);
      expect(card).toMatchObject({
        layerTypes: expect.arrayContaining(["particles"]),
        features: expect.arrayContaining(["particles.seeded", "particles.analytic-field"])
      });
    }
  });
});
