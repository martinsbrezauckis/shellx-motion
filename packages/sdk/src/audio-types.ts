/** Transport-neutral SDK contracts for bounded document audio edits. */
import type { MotionAudioFadeCurve, MotionAudioMasterBus } from "@shellx-motion/core";
import type { MotionSdkPackageIdentity, MotionSdkPersistedReceipt } from "./package-types.js";

export type MotionSdkAudioOperation = "audio.master.set" | "audio.crossfade.set";

interface MotionSdkAudioMutationRequest {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
}

/** Pass null to clear the document master; otherwise only bounded data controls are accepted. */
export interface MotionSdkAudioMasterSetRequest extends MotionSdkAudioMutationRequest {
  master: MotionAudioMasterBus | null;
}

export interface MotionSdkAudioCrossfadeSetRequest extends MotionSdkAudioMutationRequest {
  fromLayerId: string;
  toLayerId: string;
  durationMs: number;
  curve?: MotionAudioFadeCurve;
}

export interface MotionSdkAudioMutationResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  operation: MotionSdkAudioOperation;
  changedPaths: string[];
  /** Present for audio.master.set and equals the persisted document master. */
  master?: MotionAudioMasterBus | null;
  /** Present for audio.crossfade.set and describes the two persisted matched fades. */
  crossfade?: {
    fromLayerId: string;
    toLayerId: string;
    durationMs: number;
    curve: MotionAudioFadeCurve;
  };
  receipt: MotionSdkPersistedReceipt<MotionSdkAudioOperation>;
  receiptPath: string;
  warnings: string[];
}

declare module "./types.js" {
  interface MotionSdkRequestMap {
    audioMasterSet: MotionSdkAudioMasterSetRequest;
    audioCrossfadeSet: MotionSdkAudioCrossfadeSetRequest;
  }

  interface MotionSdkResponseMap {
    audioMasterSet: MotionSdkAudioMutationResponse;
    audioCrossfadeSet: MotionSdkAudioMutationResponse;
  }

  interface MotionSdkClient {
    audioMasterSet(input: MotionSdkAudioMasterSetRequest): Promise<MotionSdkResult<MotionSdkAudioMutationResponse>>;
    audioCrossfadeSet(input: MotionSdkAudioCrossfadeSetRequest): Promise<MotionSdkResult<MotionSdkAudioMutationResponse>>;
  }
}
