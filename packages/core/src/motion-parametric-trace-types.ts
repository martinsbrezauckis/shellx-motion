import type { MotionShapeGeometry } from "./motion-shape-geometry-types";
import type { MotionEasing } from "./types";

/** Private, direct-import-only C4C descriptor. It never becomes a MotionDocument root. */
export const MOTION_PARAMETRIC_TRACE_SCHEMA = "shellx-motion/private-parametric-trace@1" as const;
export const MOTION_PARAMETRIC_TRACE_PLAN_SCHEMA = "shellx-motion/private-parametric-trace-plan@1" as const;

export const MAX_MOTION_PARAMETRIC_TRACE_DRAWERS = 16;
export const MAX_MOTION_PARAMETRIC_TRACE_NODES = 64;
export const MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES = 256 * 1024;
export const MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES = 8_192;
export const MAX_MOTION_PARAMETRIC_TRACE_AGGREGATE_SAMPLES = 65_536;
export const MAX_MOTION_PARAMETRIC_TRACE_VERTICES = 262_144;
export const MAX_MOTION_PARAMETRIC_TRACE_WORK_UNITS = 1_000_000;
export const MAX_MOTION_PARAMETRIC_TRACE_BYTES = 8 * 1024 * 1024;
export const MAX_MOTION_PARAMETRIC_TRACE_DURATION_US = 3_600_000_000;
export const MAX_MOTION_PARAMETRIC_TRACE_COORDINATE = 1_000_000;
export const MAX_MOTION_PARAMETRIC_TRACE_SPEED = 100_000;
export const MAX_MOTION_PARAMETRIC_TRACE_COLLISIONS = 32;

export interface MotionParametricTraceVector { x: number; y: number; z: number }

export type MotionParametricTraceGraphNode =
  | { id: string; kind: "time-us" }
  | { id: string; kind: "constant"; value: number }
  | { id: string; kind: "add" | "multiply"; left: string; right: string }
  | { id: string; kind: "sin" | "cos"; input: string }
  | { id: string; kind: "clamp"; input: string; min: string; max: string }
  | { id: string; kind: "lissajous-axis-q1024"; time: string; durationUs: number; frequency: number; phaseTurnsQ1024: number; center: number; amplitude: number };

/** The closed data-only scalar graph used for analytic 2D/3D drivers. */
export interface MotionParametricTraceGraph {
  nodes: MotionParametricTraceGraphNode[];
  output: { x: string; y: string; z: string };
}

export interface MotionParametricTracePathFollowDriver {
  kind: "path-follow";
  startUs: number;
  durationUs: number;
  geometry: Extract<MotionShapeGeometry, { kind: "path" }>;
  offsetUs?: number;
  direction?: "forward" | "reverse";
  orientToPath?: boolean;
  easing?: MotionEasing;
}

export interface MotionParametricTraceGraphDriver { kind: "parametric-graph"; graph: MotionParametricTraceGraph }
export interface MotionParametricTraceBehaviorDriver { kind: "behavior"; targetLayerId: string }
export interface MotionParametricTraceRelationDriver { kind: "relation"; targetLayerId: string }

export type MotionParametricTraceCollision =
  | { kind: "box"; min: MotionParametricTraceVector; max: MotionParametricTraceVector }
  | { kind: "sphere"; center: MotionParametricTraceVector; radius: number }
  | { kind: "plane"; normal: MotionParametricTraceVector; offset: number };

/** Constant-velocity, exact-time collision sample with an explicit solver cap. */
export interface MotionParametricTraceBounceDriver {
  kind: "bounded-bounce";
  initial: MotionParametricTraceVector;
  velocity: MotionParametricTraceVector;
  collision: MotionParametricTraceCollision;
  maxCollisions: number;
}

export type MotionParametricTraceDriver =
  | MotionParametricTraceGraphDriver
  | MotionParametricTracePathFollowDriver
  | MotionParametricTraceBehaviorDriver
  | MotionParametricTraceRelationDriver
  | MotionParametricTraceBounceDriver;

export type MotionParametricTraceRetention =
  | { kind: "full-clip"; maxSamples: number }
  | { kind: "last-samples"; samples: number }
  | { kind: "last-us"; durationUs: number }
  | { kind: "distance"; distance: number }
  | { kind: "age-fade"; durationUs: number };

export interface MotionParametricTraceSignal {
  /** `constant` requires from === to; other sources map the closed 0..1 source domain. */
  source: "constant" | "age" | "speed" | "drawer";
  from: number;
  to: number;
}

export interface MotionParametricTraceOutput {
  mode: "line" | "ribbon" | "tube" | "points";
  width: MotionParametricTraceSignal;
  colour: MotionParametricTraceSignal;
  opacity: MotionParametricTraceSignal;
  speedLimit: number;
}

export interface MotionParametricTraceDrawer {
  id: string;
  driver: MotionParametricTraceDriver;
  retention: MotionParametricTraceRetention;
  output: MotionParametricTraceOutput;
}

export interface MotionParametricTraceLimit {
  maxSamples: number;
  maxVertices: number;
  maxWorkUnits: number;
  maxBytes: number;
}

export interface MotionParametricTraceDescriptor {
  schema: typeof MOTION_PARAMETRIC_TRACE_SCHEMA;
  clip: { durationUs: number; sampleIntervalUs: number };
  drawers: MotionParametricTraceDrawer[];
  caps: { perDrawer: MotionParametricTraceLimit; aggregate: MotionParametricTraceLimit };
}

export interface MotionParametricTraceSample {
  atUs: number;
  position: MotionParametricTraceVector;
  /** Speed is normalized to the declared bounded output speedLimit. */
  speed: number;
}

export interface MotionParametricTraceRetentionWindow {
  atUs: number;
  firstSampleIndex: number;
  sampleCount: number;
  vertexCount: number;
  workUnits: number;
  bytes: number;
}

/** Closed evidence of the admitted trigonometric evaluator rail(s). */
export type MotionParametricTraceTrigonometry =
  | "none"
  | "quantized-radians@1"
  | "exact-modular-turns@1"
  | "mixed-quantized-radians-and-exact-modular-turns@1";

export interface MotionParametricTracePlan {
  schema: typeof MOTION_PARAMETRIC_TRACE_PLAN_SCHEMA;
  sourceSha256: string;
  schedule: readonly number[];
  drawers: readonly {
    id: string;
    driver: { kind: MotionParametricTraceDriver["kind"]; sourceSha256: string; authorityFingerprint?: string };
    output: MotionParametricTraceOutput;
    retention: MotionParametricTraceRetention;
    signalDomain: { age: readonly [0, 1]; speed: readonly [0, 1]; drawer: number };
    samples: readonly MotionParametricTraceSample[];
    windows: readonly MotionParametricTraceRetentionWindow[];
    budget: { samples: number; maxVertices: number; maxWorkUnits: number; compileWorkUnits: number; maxFrameBytes: number; dataBytes: number; peakBytes: number };
  }[];
  budget: { samples: number; maxVertices: number; maxWorkUnits: number; compileWorkUnits: number; maxFrameBytes: number; storageBytes: number; peakBytes: number; limits: MotionParametricTraceDescriptor["caps"] };
  evidence: { scheduleSha256: string; trigonometry: MotionParametricTraceTrigonometry; noRenderer: true; noPixelClaim: true };
  fingerprint: string;
}
