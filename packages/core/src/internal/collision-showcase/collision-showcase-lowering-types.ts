import type { MotionDocument } from "../../types";
import type { CollisionShowcaseKind } from "./collision-showcase-types";

export const COLLISION_SHOWCASE_LOWERING_SCHEMA = "shellx-motion/private-collision-showcase-lowering@2" as const;

export interface CollisionShowcaseGeometryEvidence {
  id: "unit-sphere" | "brick-cuboid" | "wrecking-ball-tether";
  geometrySha256: string;
  vertexCount: number;
  indexCount: number;
}

export interface CollisionShowcaseLowering {
  schema: typeof COLLISION_SHOWCASE_LOWERING_SCHEMA;
  kind: CollisionShowcaseKind;
  planFingerprint: string;
  motion: MotionDocument;
  motionSha256: string;
  geometry: readonly CollisionShowcaseGeometryEvidence[];
  budget: Readonly<{
    sceneLayerCount: number;
    sceneObjectCount: number;
    meshVertexCount: number;
    meshIndexCount: number;
    trackCount: number;
    keyframeCount: number;
    planWorkUnits: number;
    frameWorkUnits: number;
  }>;
  evidence: Readonly<{
    planRecompiled: true;
    ordinaryScene3d: true;
    ordinaryScene3dAnimation: true;
    fixedHashedGeometry: true;
    fusedTetherRotationDerived: boolean;
    strictPreviewAdmitted: true;
    rendererInvoked: false;
    packageWritten: false;
  }>;
  strictPreviewStaticFingerprint: string;
  fingerprint: string;
}
