export const SCENE_3D_SCHEMA = "shellx-motion/scene3d@1" as const;
export const SCENE_3D_MESH_SCHEMA = "shellx-motion/scene3d@2" as const;
export const SCENE_3D_SCHEMAS = [SCENE_3D_SCHEMA, SCENE_3D_MESH_SCHEMA] as const;
export const MAX_SCENE_3D_LAYERS = 4;
export const MAX_SCENE_3D_OBJECTS_PER_LAYER = 16;
export const MAX_SCENE_3D_OBJECTS_TOTAL = 32;
export const MAX_SCENE_3D_VERTICES_PER_OBJECT = 36;
export const MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT = 4_096;
export const MAX_SCENE_3D_MESH_VERTICES_TOTAL = 8_192;
export const MAX_SCENE_3D_MESH_INDICES_PER_OBJECT = 24_576;
export const MAX_SCENE_3D_MESH_INDICES_TOTAL = 49_152;
export const SCENE_3D_PRIMITIVES = ["box", "pyramid", "plane"] as const;
export const SCENE_3D_CONTROL_BOUNDS = {
  position: [-1_000, 1_000],
  rotationDeg: [-36_000, 36_000],
  angularVelocity: [-720, 720],
  scale: [0.001, 100],
  cameraFovDeg: [10, 120],
  cameraNear: [0.01, 100],
  cameraFar: [0.01, 10_000],
  lightingDirection: [-1, 1],
  lightingAmbient: [0, 1],
  lightingIntensity: [0, 4],
  emissive: [0, 1],
} as const;

export type MotionScene3DPrimitive = typeof SCENE_3D_PRIMITIVES[number];
