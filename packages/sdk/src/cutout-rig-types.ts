/** Transport-neutral SDK types for bounded author-time cutout-rig baking. */
import type { CutoutRig, CutoutRigSourceStaticTransform } from "@shellx-motion/core";
import type { MotionSdkPackageIdentity, MotionSdkPersistedReceipt } from "./package-types.js";

export interface MotionSdkCutoutRigBakeRequest {
  packageRoot: string;
  outDir: string;
  sourceLayerId: string;
  rig: CutoutRig;
  receiptsRoot?: string;
  createdBy?: string;
}

export interface MotionSdkCutoutRigSourceIdentity {
  layerId: string;
  assetRef: string;
  width: number;
  height: number;
  sha256: string;
  staticTransform: CutoutRigSourceStaticTransform;
}

/** This proves cadence and bounded output; it deliberately does not claim live-rig equivalence between samples. */
export interface MotionSdkCutoutRigBakeCadence {
  sampleEveryFrames: number;
  observedFrameCount: number;
  bakedSampleCount: number;
  firstSampleMs: number;
  lastSampleMs: number;
  activeWindow: { startMs: number; endMsExclusive: number };
  approximation: "ordinary linear transform tracks between sampled renderer frames";
}

export interface MotionSdkCutoutRigBakeResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  source: MotionSdkCutoutRigSourceIdentity;
  outputLayerIds: string[];
  changedPaths: string[];
  cadence: MotionSdkCutoutRigBakeCadence;
  receipt: MotionSdkPersistedReceipt<"timeline.cutout.rig.bake">;
  receiptPath: string;
  warnings: string[];
}

declare module "./types.js" {
  interface MotionSdkRequestMap {
    cutoutRigBake: MotionSdkCutoutRigBakeRequest;
  }

  interface MotionSdkResponseMap {
    cutoutRigBake: MotionSdkCutoutRigBakeResponse;
  }

  interface MotionSdkClient {
    cutoutRigBake(input: MotionSdkCutoutRigBakeRequest): Promise<MotionSdkResult<MotionSdkCutoutRigBakeResponse>>;
  }
}
