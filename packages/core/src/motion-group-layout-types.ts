import type { MotionDocument } from "./types";
import type {
  MotionLayoutBudget,
  MotionLayoutCompiledInstance,
  MotionLayoutOwnershipInput,
  MotionLayout,
  MotionLayoutRepeater,
} from "./motion-layout";

export const MOTION_GROUP_LAYOUT_COMPILE_SCHEMA = "shellx-motion/group-layout-compile@1";
export const MOTION_GROUP_LAYOUT_PLAN_SCHEMA = "shellx-motion/group-layout-plan@1";
export const MOTION_GROUP_LAYOUT_SOURCE_SCHEMA = "shellx-motion/group-layout-source@1";

/** Input stays data-only: it references an already validated in-memory Motion document. */
export interface MotionGroupLayoutCompileRequest {
  schema: "shellx-motion/group-layout-compile@1";
  motion: MotionDocument;
  groupId: string;
  layout: MotionLayout;
  repeaters: MotionLayoutRepeater[];
}

export interface MotionGroupLayoutIssue { path: string; code: string; message: string }

/** Identity and local-time ownership are explicit; no tree is returned or created. */
export interface MotionGroupLayoutSource {
  schema: "shellx-motion/group-layout-source@1";
  motionId: string;
  groupId: string;
  groupStartMs: number;
  groupDurationMs: number;
  childLayerIds: string[];
}

export interface MotionGroupLayoutPlan {
  schema: "shellx-motion/group-layout-plan@1";
  source: MotionGroupLayoutSource;
  ownership: MotionLayoutOwnershipInput;
  instances: MotionLayoutCompiledInstance[];
  budget: MotionLayoutBudget;
  layoutFingerprintInput: string;
  layoutFingerprint: string;
  fingerprintInput: string;
  fingerprint: string;
}

export type MotionGroupLayoutCompileResult =
  | { status: "ok"; plan: MotionGroupLayoutPlan }
  | { status: "refused"; issues: MotionGroupLayoutIssue[] };
