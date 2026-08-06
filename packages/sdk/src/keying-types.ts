/** Transport-neutral keying and roto SDK contracts. */
import type { MotionChromaKey, MotionMask } from "@shellx-motion/core";
import type { MotionSdkPackageIdentity } from "./types.js";

export interface MotionSdkLayerKeyingState {
  layerId: string;
  layerType: string;
  keying: MotionChromaKey | null;
  roto: MotionMask | null;
  trackingAttached: boolean;
}

export interface MotionSdkKeyingInspectRequest { packageRoot: string; layerId: string }
export interface MotionSdkKeyingApplyRequest { packageRoot: string; outDir: string; layerId: string; keying: MotionChromaKey; receiptsRoot?: string }
export interface MotionSdkKeyingRemoveRequest { packageRoot: string; outDir: string; layerId: string; receiptsRoot?: string }
export interface MotionSdkRotoUpsertRequest { packageRoot: string; outDir: string; layerId: string; mask: MotionMask; receiptsRoot?: string }
export interface MotionSdkRotoTrackingDetachRequest { packageRoot: string; outDir: string; layerId: string; receiptsRoot?: string }
export interface MotionSdkRotoRemoveRequest { packageRoot: string; outDir: string; layerId: string; receiptsRoot?: string }

export type MotionSdkKeyingOperation = "keying.apply" | "keying.remove" | "roto.upsert" | "roto.tracking.detach" | "roto.remove";

export interface MotionSdkKeyingReceiptSummary {
  schema: "shellx-motion/receipt@1";
  id: string;
  packageId: string;
  operation: MotionSdkKeyingOperation;
  status: "passed";
  sha256: string;
}

export interface MotionSdkKeyingInspectResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  state: MotionSdkLayerKeyingState;
  warnings: string[];
}

export interface MotionSdkKeyingMutationResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  layerId: string;
  changedPaths: string[];
  state: MotionSdkLayerKeyingState;
  receipt: MotionSdkKeyingReceiptSummary;
  receiptPath: string;
  warnings: string[];
}
