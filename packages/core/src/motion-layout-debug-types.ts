import type {
  MotionDocument,
  MotionLayoutApplicationPatch,
  MotionLayoutApplicationSnapshot,
  MotionTransform,
  OperationReceipt
} from "./types";
import type {
  MotionLayout,
  MotionLayoutBudget,
  MotionLayoutCompiledInstance,
  MotionLayoutOwnershipInput,
  MotionLayoutRepeater,
} from "./motion-layout";
import type { MotionGroupLayoutSource } from "./motion-group-layout";
import type { MotionLayoutRemovalAuthorization } from "./motion-layout-removal-authority";

export const MOTION_LAYOUT_DEBUG_INTENT_SCHEMA = "shellx-motion/debug-layout-intent@1" as const;
export const MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA = "shellx-motion/debug-layout-removal@1" as const;
export const MOTION_LAYOUT_DEBUG_APPLIED_SCHEMA = "shellx-motion/debug-layout-applied@1" as const;

export type MotionLayoutDebugOperation = "inspect" | "compile" | "apply" | "remove";

export interface MotionLayoutDebugBaseIntent {
  schema: typeof MOTION_LAYOUT_DEBUG_INTENT_SCHEMA;
  operation: MotionLayoutDebugOperation;
  motion: MotionDocument;
  createdAt: string;
}

export interface MotionLayoutDebugInspectIntent extends MotionLayoutDebugBaseIntent {
  operation: "inspect";
  groupId: string;
  layout: MotionLayout;
  repeaters: MotionLayoutRepeater[];
}
export interface MotionLayoutDebugCompileIntent extends MotionLayoutDebugBaseIntent {
  operation: "compile";
  groupId: string;
  layout: MotionLayout;
  repeaters: MotionLayoutRepeater[];
}
export interface MotionLayoutDebugApplyIntent extends MotionLayoutDebugBaseIntent {
  operation: "apply";
  groupId: string;
  layout: MotionLayout;
  repeaters: MotionLayoutRepeater[];
}
export interface MotionLayoutDebugRemoveIntent extends MotionLayoutDebugBaseIntent {
  operation: "remove";
  removal: MotionLayoutDebugRemoval;
}
export type MotionLayoutDebugIntent = MotionLayoutDebugInspectIntent | MotionLayoutDebugCompileIntent | MotionLayoutDebugApplyIntent | MotionLayoutDebugRemoveIntent;

/** Slot facts only; `physicalClipping` deliberately makes no renderer/painted-pixel claim. */
export interface MotionLayoutDebugOverflowFacts {
  basis: "unscaled-unrotated-layout-slot";
  policy: "clip" | "allow";
  outsideSlotCount: number;
  clippedSlotCount: number;
  visibleOutsideSlotCount: number;
  physicalClipping: "refused";
}
export interface MotionLayoutDebugRepeaterFact { sourceId: string; count: number; instanceCount: number }

export interface MotionLayoutDebugCompilation {
  source: MotionGroupLayoutSource;
  ownership: MotionLayoutOwnershipInput;
  instances: MotionLayoutCompiledInstance[];
  budget: MotionLayoutBudget;
  layoutFingerprintInput: string;
  layoutFingerprint: string;
  overflow: MotionLayoutDebugOverflowFacts;
  repeaters: MotionLayoutDebugRepeaterFact[];
}

export type MotionLayoutDebugLayerSnapshot = MotionLayoutApplicationSnapshot;
export type MotionLayoutDebugPatch = MotionLayoutApplicationPatch;

/**
 * Package-backed hosts provide this only after validating the deterministic
 * apply receipt. It is opaque to normal Core consumers and required for
 * removal; document-resident application records remain declarative data.
 */
export interface MotionLayoutDebugRunOptions {
  packageId?: string;
  removalAuthorization?: MotionLayoutRemovalAuthorization;
}

/** A caller may name a document-resident application but cannot provide inverse state. */
export interface MotionLayoutDebugRemoval {
  schema: typeof MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA;
  applicationId: string;
  applicationFingerprint: string;
}
export interface MotionLayoutDebugApplied {
  schema: typeof MOTION_LAYOUT_DEBUG_APPLIED_SCHEMA;
  removal: MotionLayoutDebugRemoval;
}

export interface MotionLayoutDebugIssue { path: string; code: string; message: string }
export type MotionLayoutDebugResult =
  | { status: "ok"; operation: "inspect" | "compile"; compilation: MotionLayoutDebugCompilation; receipt: OperationReceipt }
  | { status: "ok"; operation: "apply"; motion: MotionDocument; compilation: MotionLayoutDebugCompilation; applied: MotionLayoutDebugApplied; receipt: OperationReceipt }
  | { status: "ok"; operation: "remove"; motion: MotionDocument; compilation: MotionLayoutDebugCompilation; receipt: OperationReceipt }
  | { status: "refused"; issues: MotionLayoutDebugIssue[] };
