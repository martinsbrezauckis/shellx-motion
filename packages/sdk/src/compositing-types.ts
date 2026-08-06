import type {
  MotionCompositingCompileMetadata,
  MotionCompositingGraph,
  MotionCompositingValidationResult,
} from "@shellx-motion/core";
import type { MotionSdkPackageIdentity, MotionSdkPersistedReceipt } from "./package-types.js";

export type MotionSdkCompositingOperation =
  | "compositing.graph.set"
  | "compositing.graph.remove";

export interface MotionSdkCompositingGraphState {
  graph: MotionCompositingGraph | null;
  compiled: boolean;
  metadata: MotionCompositingCompileMetadata | null;
  validation: MotionCompositingValidationResult | null;
  fingerprint: string | null;
}

export interface MotionSdkCompositingInspectRequest {
  packageRoot: string;
}

export interface MotionSdkCompositingSetRequest {
  packageRoot: string;
  outDir: string;
  graph: MotionCompositingGraph;
  receiptsRoot?: string;
  createdBy?: string;
}

export interface MotionSdkCompositingRemoveRequest {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
}

export interface MotionSdkCompositingInspectResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  state: MotionSdkCompositingGraphState;
  warnings: string[];
}

export interface MotionSdkCompositingMutationResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  changedPaths: string[];
  state: MotionSdkCompositingGraphState;
  receipt: MotionSdkPersistedReceipt<MotionSdkCompositingOperation>;
  receiptPath: string;
  warnings: string[];
}
