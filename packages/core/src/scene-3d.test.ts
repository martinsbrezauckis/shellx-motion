import { describe, expect, it } from "vitest";
import { requiredLayerFeatures } from "./capabilities";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionLayer, MotionScene3DObject } from "./types";

describe("bounded scene3d contract", () => {
  it("validates fixed primitive scenes and advertises the renderer feature", async () => {
    const layer = validSceneLayer();
    const document = motionWithLayers([layer]);

    expect(await validateDocument(await loadSchema("motion"), document)).toEqual({ ok: true });
    expect(requiredLayerFeatures(layer)).toContain("scene3d.fixed-primitives");
  });

  it("rejects external-model shapes, unsafe ranges, duplicate ids, and zero lighting vectors", async () => {
    const layer = validSceneLayer();
    (layer as unknown as { scene3d: Record<string, unknown> }).scene3d = {
      schema: "scene3d@latest",
      backgroundColor: "transparent",
      camera: {
        position: [0, 0, 0],
        target: [0, 0, 0],
        fovDeg: 0,
        near: 0,
        far: 0,
        orbitDegPerSecond: 721
      },
      lighting: {
        ambient: 2,
        direction: [0, 0, 0],
        intensity: 5,
        color: "white"
      },
      objects: [
        {
          id: "duplicate",
          primitive: "gltf-model",
          position: [1001, 0, 0],
          rotationDeg: [0, 0, 0],
          scale: 0,
          spinDegPerSecond: [0, 0, 721],
          color: "rgba(0,0,0,1)",
          emissive: 2
        },
        {
          id: "duplicate",
          primitive: "box",
          position: [0, 0, 0],
          rotationDeg: [0, 0, 0],
          scale: 1,
          color: "#ffffff"
        }
      ]
    };

    const result = await validateDocument(await loadSchema("motion"), motionWithLayers([layer]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      { path: "/layers/0/scene3d/schema", message: "must be shellx-motion/scene3d@1 or shellx-motion/scene3d@2" },
      { path: "/layers/0/scene3d/camera/position", message: "must define a non-vertical view distinct from target" },
      { path: "/layers/0/scene3d/lighting/direction", message: "must not be the zero vector" },
      { path: "/layers/0/scene3d/objects/0/primitive", message: "must be box, pyramid, plane" },
      { path: "/layers/0/scene3d/objects/1/id", message: "must be unique within the scene" }
    ]));
  });

  it("caps fixed geometry draw calls per layer and across a composition", async () => {
    const objects = Array.from({ length: 17 }, (_, index) => validObject(`box-${index}`));
    const first = validSceneLayer("first");
    const second = validSceneLayer("second");
    first.scene3d!.objects = objects;
    second.scene3d!.objects = objects.map((object, index) => ({ ...object, id: `other-${index}` }));

    const result = await validateDocument(await loadSchema("motion"), motionWithLayers([first, second]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      { path: "/layers/0/scene3d/objects", message: "must contain at most 16 objects" },
      { path: "/layers/1/scene3d/objects", message: "must contain at most 16 objects" },
      { path: "/layers", message: "scene3d layers may contain at most 32 objects in total" }
    ]));
  });
});

function validSceneLayer(id = "scene"): MotionLayer {
  return {
    id,
    type: "scene3d",
    startMs: 0,
    durationMs: 1000,
    transform: { x: 0, y: 0, width: 320, height: 180 },
    scene3d: {
      schema: "shellx-motion/scene3d@1",
      camera: {
        position: [4, 3, 6],
        target: [0, 0, 0],
        fovDeg: 45,
        near: 0.1,
        far: 100,
        orbitDegPerSecond: 20
      },
      lighting: {
        ambient: 0.25,
        direction: [-0.4, -0.8, -0.5],
        intensity: 1.2,
        color: "#ffffff"
      },
      backgroundColor: "#020617",
      objects: [validObject("hero")]
    }
  };
}

function validObject(id: string): MotionScene3DObject {
  return {
    id,
    primitive: "box",
    position: [0, 0, 0],
    rotationDeg: [15, 25, 0],
    scale: 1,
    spinDegPerSecond: [0, 45, 0],
    color: "#22d3ee",
    emissive: 0.1
  };
}

function motionWithLayers(layers: MotionLayer[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "scene3d_motion",
    name: "Scene 3D",
    durationMs: 1000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#020617",
    layers,
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  };
}
