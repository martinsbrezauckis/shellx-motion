/** The fixed local coordinate system shared by one v1 authored shape geometry. */
export interface MotionShapeGeometryViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One authored local-coordinate point. Point order is significant. */
export interface MotionShapeGeometryPoint {
  x: number;
  y: number;
}

interface MotionShapeGeometryBase {
  schema: "shellx-motion/shape-geometry@1";
  viewBox: MotionShapeGeometryViewBox;
}

/** Closed v1 geometry records. Legacy `shape` and `x-path` remain compatibility input. */
export type MotionShapeGeometry =
  | (MotionShapeGeometryBase & { kind: "line"; points: [MotionShapeGeometryPoint, MotionShapeGeometryPoint] })
  | (MotionShapeGeometryBase & { kind: "polyline"; points: MotionShapeGeometryPoint[] })
  | (MotionShapeGeometryBase & { kind: "polygon"; points: MotionShapeGeometryPoint[] })
  | (MotionShapeGeometryBase & { kind: "arc"; center: MotionShapeGeometryPoint; radius: number; startAngleDeg: number; sweepAngleDeg: number })
  | (MotionShapeGeometryBase & { kind: "sector"; center: MotionShapeGeometryPoint; radius: number; innerRadius?: number; startAngleDeg: number; sweepAngleDeg: number })
  | (MotionShapeGeometryBase & { kind: "path"; data: string });
