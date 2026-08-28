import { describe, expect, it } from "vitest";
import { requiredLayerFeatures } from "./capabilities";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import { SCENE_3D_MESH_SCHEMA, SCENE_3D_SCHEMA } from "./scene-3d";
import type { MotionLayer, MotionScene3DObject } from "./types";

describe("scene3d capability requirements", () => {
  it("distinguishes fixed primitives from imported glTF meshes", () => {
    expect(requiredLayerFeatures(sceneLayer(SCENE_3D_SCHEMA, [{
      id: "box",
      primitive: "box",
      position: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      scale: 1,
      color: "#ffffff",
    }]))).toContain("scene3d.fixed-primitives");

    expect(requiredLayerFeatures(sceneLayer(SCENE_3D_MESH_SCHEMA, [{
      id: "mesh",
      primitive: "mesh",
      geometry: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2],
      },
      position: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      scale: 1,
      color: "#ffffff",
      source: { format: "gltf", meshIndex: 0, primitiveIndex: 0, geometrySha256: scene3dMeshGeometrySha256({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }) },
    }]))).toContain("scene3d.gltf-mesh");
  });
});

function sceneLayer(
  schema: "shellx-motion/scene3d@1" | "shellx-motion/scene3d@2",
  objects: MotionScene3DObject[],
): MotionLayer {
  return {
    id: "scene",
    type: "scene3d",
    startMs: 0,
    durationMs: 1_000,
    scene3d: {
      schema,
      camera: { position: [2, 2, 4], target: [0, 0, 0], fovDeg: 42, near: 0.1, far: 100 },
      lighting: { ambient: 0.3, direction: [-0.4, -0.8, -0.5], intensity: 1.2, color: "#ffffff" },
      backgroundColor: "#020617",
      objects,
    },
  };
}
