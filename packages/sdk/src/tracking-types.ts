/** Transport-neutral tracking and stabilization SDK contracts. */
import type { MotionSdkPackageIdentity } from "./types.js";

export interface MotionSdkTrackingReference {
  atMs: number;
  bounds: { x: number; y: number; width: number; height: number };
  points: Array<{ x: number; y: number }>;
}

export interface MotionSdkTrackingSettings {
  startMs: number;
  endMs: number;
  stepMs: number;
  direction: "forward" | "backward" | "both";
  searchRadiusPx: number;
  pyramidLevels: number;
  maxIterations: number;
  confidenceFloor: number;
  deterministicSeed: number;
}

export interface MotionSdkTrackingRequestRequest {
  packageRoot: string;
  outDir: string;
  analysisId: string;
  assetId: string;
  mode: "point" | "planar";
  model: "translation" | "similarity" | "homography";
  reference: MotionSdkTrackingReference;
  settings: MotionSdkTrackingSettings;
  receiptsRoot?: string;
  createdAt?: string;
}

export interface MotionSdkTrackingInspectRequest { packageRoot: string; analysisId: string }
export interface MotionSdkTrackingApplyRequest {
  packageRoot: string;
  outDir: string;
  analysisId: string;
  layerId: string;
  segmentIndex?: number;
  includeLowConfidence?: boolean;
  receiptsRoot?: string;
}
export interface MotionSdkTrackingDetachRequest { packageRoot: string; outDir: string; layerId: string; receiptsRoot?: string }
export interface MotionSdkTrackingVerifyRequest { packageRoot: string; layerId: string; analysisId?: string }

export interface MotionSdkTrackingSourceSummary {
  assetId: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  durationMs: number;
}

export interface MotionSdkTrackingSegmentSummary { index: number; startMs: number; endMs: number; keyframeCount: number }

export interface MotionSdkTrackingLifecycleSummary {
  schema: "shellx-motion/tracking-lifecycle-summary@1";
  analysisId: string;
  state: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "stale";
  attempt: number;
  updatedAt: string;
  source: MotionSdkTrackingSourceSummary;
  failure?: { code: string; message: string };
  lastGood?: {
    status: "succeeded" | "partial";
    mode: "point" | "planar";
    model: "translation" | "similarity" | "homography";
    reference: MotionSdkTrackingReference;
    settings: MotionSdkTrackingSettings;
    samples: { total: number; tracked: number; lowConfidence: number; lost: number; recovered: number; minConfidence: number; meanConfidence: number };
    spanCount: number;
    planStatus: "ready" | "partial" | "unavailable";
    fidelity: "exact-similarity" | "approximated-homography";
    segments: MotionSdkTrackingSegmentSummary[];
    warnings: string[];
  };
}

export interface MotionSdkTrackingReceiptSummary {
  schema: "shellx-motion/receipt@1";
  id: string;
  packageId: string;
  operation: "analysis.tracking.request" | "analysis.tracking.inspect" | "analysis.tracking.apply" | "analysis.tracking.detach" | "analysis.tracking.verify";
  status: "passed" | "warning" | "failed" | "not_run";
  sha256?: string;
}

export interface MotionSdkTrackingSourceInspection { assetId: string; assetRef: string; sha256: string | null; byteLength: number; current: boolean }

export interface MotionSdkTrackingRequestResponse {
  packageRoot: string; package: MotionSdkPackageIdentity; lifecyclePath: string;
  lifecycle: MotionSdkTrackingLifecycleSummary; receipt: MotionSdkTrackingReceiptSummary; receiptPath: string; warnings: string[];
}
export interface MotionSdkTrackingInspectResponse {
  packageRoot: string; package: MotionSdkPackageIdentity; lifecyclePath: string; lifecycle: MotionSdkTrackingLifecycleSummary;
  source: MotionSdkTrackingSourceInspection; current: boolean; receipt: MotionSdkTrackingReceiptSummary; warnings: string[];
}
export interface MotionSdkTrackingApplyResponse {
  packageRoot: string; package: MotionSdkPackageIdentity; layerId: string; analysisId: string; segment: MotionSdkTrackingSegmentSummary;
  fidelity: "exact-similarity" | "approximated-homography"; changedPaths: string[]; receipt: MotionSdkTrackingReceiptSummary; receiptPath: string; warnings: string[];
}
export interface MotionSdkTrackingDetachResponse {
  packageRoot: string; package: MotionSdkPackageIdentity; layerId: string; analysisId: string; restoredPreviousKeyframes: true;
  changedPaths: string[]; receipt: MotionSdkTrackingReceiptSummary; receiptPath: string; warnings: string[];
}
export interface MotionSdkTrackingVerifyResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  verification: { attached: boolean; current: boolean; layerId: string; analysisId?: string; sourceSha256?: string; segmentIndex?: number; mismatchedTargets: string[]; reasons: string[] };
  lifecycle?: MotionSdkTrackingLifecycleSummary;
  source?: MotionSdkTrackingSourceInspection;
  receipt?: MotionSdkTrackingReceiptSummary;
  warnings: string[];
}
