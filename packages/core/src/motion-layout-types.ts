/** Pure Core contract only: a group owner must supply this list through its own adapter. */
export const MOTION_LAYOUT_OWNERSHIP_SCHEMA = "shellx-motion/layout-ownership-input@1";
export const MOTION_LAYOUT_COMPILE_SCHEMA = "shellx-motion/layout-compile@1";
export const MOTION_LAYOUT_PLAN_SCHEMA = "shellx-motion/layout-plan@1";
export const MOTION_LAYOUT_GROUP_OWNERSHIP_BLOCKER = "Group ownership is deliberately external to the layout compiler; M260-2 must adapt a group's resolved child list into MotionLayoutOwnershipInput.";

export const MAX_MOTION_LAYOUT_CHILDREN = 256;
export const MAX_MOTION_LAYOUT_REPEATERS = 16;
export const MAX_MOTION_LAYOUT_REPEATER_INSTANCES = 128;
export const MAX_MOTION_LAYOUT_COMPILED_INSTANCES = 512;
export const MAX_MOTION_LAYOUT_COMPILED_WORK = 7_000;
export const MAX_MOTION_LAYOUT_COMPILED_MEMORY_BYTES = 192 * 1024;
export const MAX_MOTION_LAYOUT_PLAN_BYTES = 128 * 1024;
export const MAX_MOTION_LAYOUT_GRID_COLUMNS = 64;
export const MAX_MOTION_LAYOUT_DIMENSION = 1_000_000;
export const MAX_MOTION_LAYOUT_TIME_MS = 3_600_000;
export const MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH = 128;
export const MAX_MOTION_LAYOUT_ROTATION = 360_000;
export const MAX_MOTION_LAYOUT_SCALE = 1_000;
export const MOTION_LAYOUT_VALUE_DECIMALS = 6;

export type MotionLayoutKind = "row" | "column" | "stack" | "grid" | "radial";
export type MotionLayoutOverflowPolicy = "clip" | "allow";
/** `stretch` resolves the relevant layout slot axis to its full available content/cell extent. */
export type MotionLayoutAlignment = "start" | "center" | "end" | "stretch";
export type MotionLayoutDistribution = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";

export interface MotionLayoutPadding { top: number; right: number; bottom: number; left: number }
export interface MotionLayoutAlign { x: MotionLayoutAlignment; y: MotionLayoutAlignment }
export interface MotionLayoutFixedSize { mode: "fixed"; value: number }
export interface MotionLayoutFillSize { mode: "fill"; min: number; max: number }
export type MotionLayoutSize = MotionLayoutFixedSize | MotionLayoutFillSize;

interface MotionLayoutBase {
  schema: "shellx-motion/layout@1";
  kind: MotionLayoutKind;
  width: number;
  height: number;
  padding: MotionLayoutPadding;
  gap: number;
  align: MotionLayoutAlign;
  distribution: MotionLayoutDistribution;
  overflow: MotionLayoutOverflowPolicy;
}

export interface MotionRowLayout extends MotionLayoutBase { kind: "row" }
export interface MotionColumnLayout extends MotionLayoutBase { kind: "column" }
export interface MotionStackLayout extends MotionLayoutBase { kind: "stack" }
export interface MotionGridLayout extends MotionLayoutBase { kind: "grid"; columns: number }
export interface MotionRadialLayout extends MotionLayoutBase {
  kind: "radial";
  radius: number;
  startAngleDeg: number;
  sweepAngleDeg: number;
}
export type MotionLayout = MotionRowLayout | MotionColumnLayout | MotionStackLayout | MotionGridLayout | MotionRadialLayout;

export interface MotionLayoutChildSizing { width: MotionLayoutSize; height: MotionLayoutSize }
export interface MotionLayoutChildTransform { x: number; y: number; scale: number; rotation: number; opacity: number }
export interface MotionLayoutChildTiming { startMs: number; durationMs: number }
export interface MotionLayoutChild {
  id: string;
  sizing: MotionLayoutChildSizing;
  transform: MotionLayoutChildTransform;
  timing: MotionLayoutChildTiming;
}

export interface MotionLayoutRepeaterTransformDelta { x: number; y: number; scale: number; rotation: number }
export interface MotionLayoutRepeater {
  schema: "shellx-motion/repeater@1";
  sourceId: string;
  count: number;
  transformDelta: MotionLayoutRepeaterTransformDelta;
  opacityDelta: number;
  indexTimeStaggerMs: number;
}

/** The pure leaf accepts an already-resolved child list, never a document or group tree. */
export interface MotionLayoutOwnershipInput {
  schema: "shellx-motion/layout-ownership-input@1";
  ownerId: string;
  childIds: string[];
}

export interface MotionLayoutCompileRequest {
  schema: "shellx-motion/layout-compile@1";
  ownership: MotionLayoutOwnershipInput;
  layout: MotionLayout;
  children: MotionLayoutChild[];
  repeaters: MotionLayoutRepeater[];
}

export interface MotionLayoutIssue { path: string; code: string; message: string }
export interface MotionLayoutBudgetUsage {
  inputChildren: number;
  repeaterCount: number;
  compiledInstances: number;
  estimatedWork: number;
  estimatedMemoryBytes: number;
  estimatedPlanBytes: number;
}
export interface MotionLayoutBudgetLimits {
  maxChildren: number;
  maxRepeaters: number;
  maxInstancesPerRepeater: number;
  maxCompiledInstances: number;
  maxWork: number;
  maxMemoryBytes: number;
  maxPlanBytes: number;
}
export interface MotionLayoutBudget { usage: MotionLayoutBudgetUsage; limits: MotionLayoutBudgetLimits }

export interface MotionLayoutCompiledTransform extends MotionLayoutChildTransform { width: number; height: number }
export interface MotionLayoutCompiledInstance {
  sourceId: string;
  instanceIndex: number;
  transform: MotionLayoutCompiledTransform;
  timing: MotionLayoutChildTiming;
  /**
   * Layout-slot containment only: compares the unscaled, unrotated resolved top-left box after
   * x/y intent. It is not a painted-pixel claim and deliberately ignores scale/rotation/origin.
   */
  outsideBounds: boolean;
  overflow: "visible" | "clipped";
}
export interface MotionLayoutCompiledPlan {
  schema: "shellx-motion/layout-plan@1";
  ownership: MotionLayoutOwnershipInput;
  ownershipJoin: "external-adapter-required";
  instances: MotionLayoutCompiledInstance[];
  budget: MotionLayoutBudget;
  /** Canonical JSON text, with object keys in UTF-16 code-unit order. */
  fingerprintInput: string;
  fingerprint: string;
}
export type MotionLayoutCompileResult =
  | { status: "ok"; plan: MotionLayoutCompiledPlan }
  | { status: "refused"; issues: MotionLayoutIssue[] };
export type MotionLayoutValidationResult =
  | { ok: true; request: MotionLayoutCompileRequest; budget: MotionLayoutBudget; fingerprintInput: string }
  | { ok: false; issues: MotionLayoutIssue[] };
