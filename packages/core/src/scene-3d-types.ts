export type MotionVec3 = [number, number, number];

interface MotionScene3DObjectBase {
  id: string;
  position: MotionVec3;
  rotationDeg: MotionVec3;
  scale: number;
  spinDegPerSecond?: MotionVec3;
  color: string;
  emissive?: number;
}

export interface MotionScene3DFixedObject extends MotionScene3DObjectBase {
  primitive: "box" | "pyramid" | "plane";
}

export interface MotionScene3DMeshGeometry {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface MotionScene3DMeshObject extends MotionScene3DObjectBase {
  primitive: "mesh";
  geometry: MotionScene3DMeshGeometry;
  source: {
    format: "gltf" | "glb";
    meshIndex: number;
    primitiveIndex: number;
    materialIndex?: number;
    /** Exact canonical vertex/index bytes produced by the bounded glTF lowering. */
    geometrySha256: string;
  };
}

export type MotionScene3DObject = MotionScene3DFixedObject | MotionScene3DMeshObject;

export interface MotionScene3D {
  schema: "shellx-motion/scene3d@1" | "shellx-motion/scene3d@2";
  camera: {
    position: MotionVec3;
    target: MotionVec3;
    fovDeg: number;
    near: number;
    far: number;
    orbitDegPerSecond?: number;
  };
  lighting: {
    ambient: number;
    direction: MotionVec3;
    intensity: number;
    color: string;
  };
  backgroundColor: string;
  objects: MotionScene3DObject[];
}
