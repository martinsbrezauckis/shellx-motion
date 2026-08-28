import type {
  MotionDocument,
  MotionLayer,
  MotionShapeGeometry,
  MotionShapeGeometryPoint,
} from "./types";
import type { ResolvedMotionShapeGeometry } from "./motion-shape-geometry";
import type { GpuSceneStrokeDash } from "./gpu-scene-stroke-dash";

export interface TimelineShapeGeometryInspect {
  layerId: string;
}

export interface TimelineShapeGeometryReplace {
  layerId: string;
  /** Complete exact-key v1 record. This operation never merges partial geometry. */
  geometry: MotionShapeGeometry;
}

export interface TimelineShapeGeometryPointUpdate {
  layerId: string;
  /** Stable existing point index. */
  index: number;
  point: MotionShapeGeometryPoint;
}

export interface TimelineShapeGeometryPointInsert {
  layerId: string;
  /** Insertion index in the current ordered point list. */
  index: number;
  point: MotionShapeGeometryPoint;
}

export interface TimelineShapeGeometryPointMove {
  layerId: string;
  /** Stable existing point index to remove before reinserting at `toIndex`. */
  fromIndex: number;
  /** Final stable index after the removal/reinsert operation. */
  toIndex: number;
}

export interface TimelineShapeGeometryPointRangeDelete {
  layerId: string;
  /** Inclusive first stable point index. */
  startIndex: number;
  /** Exclusive endpoint: exactly `[startIndex, endIndexExclusive)` is removed. */
  endIndexExclusive: number;
}

export interface TimelineShapeGeometryArcUpdate {
  layerId: string;
  /** Required as a whole pair when present. */
  center?: MotionShapeGeometryPoint;
  radius?: number;
  /** Sector-only; use zero to close the inner ring rather than an implicit deletion. */
  innerRadius?: number;
  startAngleDeg?: number;
  sweepAngleDeg?: number;
}

export interface TimelineShapeGeometryPathDataReplace {
  layerId: string;
  data: string;
}

export interface TimelineShapeGeometryMigrateLegacy {
  layerId: string;
}

export interface TimelineShapeGeometryMutationResult {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "replaced" | "updated" | "inserted" | "moved" | "deleted" | "migrated";
  changedPaths: string[];
  index?: number;
  range?: { startIndex: number; endIndexExclusive: number };
  migration?: {
    from: "legacy-path";
    legacyShape: "path" | "freeform";
    to: "path";
    /** Exact resolved contour proved equal before and after the one-way migration. */
    resolvedContour: Pick<ResolvedMotionShapeGeometry, "viewBox" | "closed" | "vertices">;
  };
}

export interface TimelineShapeGeometryInspection {
  layerId: string;
  source: "v1" | "legacy";
  geometry: MotionShapeGeometry | null;
  strokeDash: GpuSceneStrokeDash | null;
  /** Bounded canonical geometry used by renderer lowering, returned as immutable copies. */
  resolved: ResolvedMotionShapeGeometry;
}
