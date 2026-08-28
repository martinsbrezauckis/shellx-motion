import type { MotionSdkPackageIdentity, MotionSdkPersistedReceipt } from "./package-types.js";

export interface MotionSdkRevisionBase {
  packageId: string;
  motionId: string;
  manifestSha256: string;
  motionSha256: string;
}

export type MotionSdkRevisionTransactionStep =
  | { command: "motion.timeline.layer.text.set"; layerId: string; text: string }
  | { command: "motion.timeline.layer.name.set"; layerId: string; name: string }
  | { command: "motion.timeline.layer.visibility.set"; layerId: string; visible: boolean }
  | { command: "motion.timeline.layer.lock"; layerId: string; locked: boolean }
  | { command: "motion.timeline.keyframe.upsert"; layerId: string; target: string; atMs: number; value: string | number; easing?: string }
  | { command: "motion.timeline.keyframe.delete"; layerId: string; target: string; atMs: number }
  | { command: "motion.timeline.keyframe.move"; layerId: string; target: string; fromMs: number; toMs: number }
  | { command: "motion.timeline.spatial.position.upsert"; layerId: string; atMs: number; x: number; y: number; easing?: string }
  | { command: "motion.timeline.spatial.position.move"; layerId: string; fromMs: number; toMs: number }
  | { command: "motion.timeline.spatial.position.delete"; layerId: string; atMs: number };

export interface MotionSdkRevisionTransactionRequest {
  packageRoot: string;
  outDir: string;
  base: MotionSdkRevisionBase;
  steps: MotionSdkRevisionTransactionStep[];
  createdBy?: string;
}

export interface MotionSdkRevisionTransactionPlanRequest {
  packageRoot: string;
  base: MotionSdkRevisionBase;
  steps: MotionSdkRevisionTransactionStep[];
}

export interface MotionSdkRevisionTransactionStepSummary {
  index: number;
  command: MotionSdkRevisionTransactionStep["command"];
  stepSha256: string;
  changedPaths: string[];
}

export interface MotionSdkRevisionTransactionResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  base: MotionSdkRevisionBase;
  final: { manifestSha256: string; motionSha256: string };
  transactionSha256: string;
  steps: MotionSdkRevisionTransactionStepSummary[];
  receipt: MotionSdkPersistedReceipt<"revision.transaction">;
  warnings: string[];
}

export interface MotionSdkRevisionTransactionPlanResponse {
  packageId: string;
  motionId: string;
  base: MotionSdkRevisionBase;
  final: { manifestSha256: string; motionSha256: string };
  transactionSha256: string;
  steps: MotionSdkRevisionTransactionStepSummary[];
  validation: { ok: true; errorCount: 0 };
  warnings: string[];
}
