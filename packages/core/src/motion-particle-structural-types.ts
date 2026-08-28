import type {
  MotionDocument,
  MotionLayer,
} from "./types";
import type {
  MotionParticleAnalyticTrail,
  MotionParticleEmitterOrigin,
  MotionParticleField,
  MotionParticleFieldSource,
  MotionParticleFieldV2Source,
  MotionParticleShading,
} from "./particle-field-types";

export interface TimelineParticleStructuralInspect {
  layerId: string;
}

/** A bounded view of only editable particle-structure records, never evaluator history or instances. */
export interface TimelineParticleStructuralInspection {
  layerId: string;
  field: MotionParticleField | null;
  origins: MotionParticleEmitterOrigin[] | null;
  trail: MotionParticleAnalyticTrail | null;
  shading: MotionParticleShading | null;
  limits: { maxSources: number | null; maxOrigins: number | null };
}

export interface TimelineParticleFieldSourceInsert {
  layerId: string;
  /** Insertion position in the ordered field source list. */
  index: number;
  /** Complete closed source record; scalar changes stay with rich controls. */
  source: MotionParticleFieldSource | MotionParticleFieldV2Source;
}

export interface TimelineParticleFieldSourceReplace {
  layerId: string;
  index: number;
  /** Complete closed source record; its kind may change only within the field schema. */
  source: MotionParticleFieldSource | MotionParticleFieldV2Source;
}

export interface TimelineParticleFieldSourceMove {
  layerId: string;
  fromIndex: number;
  toIndex: number;
}

export interface TimelineParticleFieldSourceDelete {
  layerId: string;
  index: number;
}

export interface TimelineParticleOriginInsert {
  layerId: string;
  index: number;
  /** Complete closed v2 origin record. */
  origin: MotionParticleEmitterOrigin;
}

export interface TimelineParticleOriginReplace {
  layerId: string;
  index: number;
  /** Complete closed v2 origin record. */
  origin: MotionParticleEmitterOrigin;
}

export interface TimelineParticleOriginMove {
  layerId: string;
  fromIndex: number;
  toIndex: number;
}

export interface TimelineParticleOriginDelete {
  layerId: string;
  index: number;
}

export interface TimelineParticleCollisionAxisUpdate {
  layerId: string;
  /** Existing v2 collision source index. */
  index: number;
  axis: "x" | "y";
}

export interface TimelineParticleAnalyticTrailAdd {
  layerId: string;
  trail: MotionParticleAnalyticTrail;
}

export interface TimelineParticleAnalyticTrailReplace {
  layerId: string;
  trail: MotionParticleAnalyticTrail;
}

export interface TimelineParticleAnalyticTrailRemove {
  layerId: string;
}

export interface TimelineParticleShadingAdd {
  layerId: string;
  shading: MotionParticleShading;
}

export interface TimelineParticleShadingReplace {
  layerId: string;
  shading: MotionParticleShading;
}

export interface TimelineParticleShadingRemove {
  layerId: string;
}

export type TimelineParticleStructuralAction =
  | "source-inserted"
  | "source-replaced"
  | "source-moved"
  | "source-deleted"
  | "origin-inserted"
  | "origin-replaced"
  | "origin-moved"
  | "origin-deleted"
  | "collision-axis-updated"
  | "trail-added"
  | "trail-replaced"
  | "trail-removed"
  | "shading-added"
  | "shading-replaced"
  | "shading-removed";

export interface TimelineParticleStructuralMutationResult {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: TimelineParticleStructuralAction;
  changedPaths: string[];
  /** Post-operation position for source/origin operations. */
  index?: number;
}
