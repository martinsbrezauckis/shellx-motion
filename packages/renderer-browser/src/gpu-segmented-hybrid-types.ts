import type {
  GpuHybridTextureRequest,
  GpuHybridTextureResourceBinding,
  GpuHybridTextureSourceSnapshot,
  GpuHybridTextureStaticDescriptor,
  GpuSceneStaticPlan,
  MotionPackage
} from "@shellx-motion/core";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import type { GpuSessionDynamicImageReservation } from "./gpu-runtime-types";

export const GPU_SEGMENTED_HYBRID_ADMISSION_SCHEMA = "shellx-motion/gpu-segmented-hybrid-admission@1" as const;
export const GPU_SEGMENTED_HYBRID_RANGE_LEDGER_SCHEMA = "shellx-motion/gpu-segmented-hybrid-range-ledger@1" as const;

/** Path-free browser facts captured by the host before durable-store opening. */
export interface GpuSegmentedHybridBrowserPreparation {
  readonly name: "chromium";
  /** Host-computed immutable executable identity; source paths never enter receipts. */
  readonly executableSha256: string;
  readonly runtimePolicy: "borrowed-precontained-chromium-data-only-no-network";
}

export interface GpuSegmentedHybridBrowserIdentity extends GpuSegmentedHybridBrowserPreparation {
  readonly version: string;
}

export interface GpuSegmentedHybridAdmissionIdentity {
  readonly schema: typeof GPU_SEGMENTED_HYBRID_ADMISSION_SCHEMA;
  readonly staticPlanFingerprint: string;
  readonly descriptor: GpuHybridTextureStaticDescriptor;
  readonly sourceSnapshot: GpuHybridTextureSourceSnapshot;
  readonly captureContractSha256: string;
  readonly browser: GpuSegmentedHybridBrowserIdentity;
  readonly dynamicTexture: {
    readonly id: string;
    readonly width: number;
    readonly height: number;
    readonly sourceSha256: string;
    readonly bytes: number;
  };
  readonly policy: {
    readonly scripts: "data-only-none";
    readonly network: "no-egress";
    readonly htmlClosure: "primary-self-contained" | "not-applicable-restricted-glsl";
    readonly capture: "one-borrowed-browser-context-per-bootstrap-or-range";
  };
  readonly bootstrap: {
    readonly index: number;
    readonly atMs: number;
    readonly atUs: number;
    readonly requestFingerprint: string;
    readonly resourceId: string;
    readonly width: number;
    readonly height: number;
    readonly pngSha256: string;
    readonly decodedRgbaSha256: string;
    readonly cleanup: GpuSegmentedHybridRangeCleanupEvidence;
  };
}

export interface GpuSegmentedHybridPreparationIdentity {
  readonly schema: "shellx-motion/gpu-segmented-hybrid-preparation@1";
  readonly staticPlanFingerprint: string;
  readonly descriptor: GpuHybridTextureStaticDescriptor;
  readonly sourceSnapshot: GpuHybridTextureSourceSnapshot;
  readonly captureContractSha256: string;
  readonly browser: GpuSegmentedHybridBrowserPreparation;
  readonly dynamicTexture: GpuSegmentedHybridAdmissionIdentity["dynamicTexture"];
  readonly policy: GpuSegmentedHybridAdmissionIdentity["policy"];
}

/** The pre-store host input. It carries no scratch path or package-selected authority. */
export interface GpuSegmentedHybridAdmissionInput {
  readonly pkg: MotionPackage;
  readonly staticPlan: Pick<GpuSceneStaticPlan, "fingerprint" | "hybridTextures">;
  readonly browser: GpuSegmentedHybridBrowserPreparation;
}

export interface GpuSegmentedHybridRangeCaptureInput {
  readonly admission: GpuSegmentedHybridAdmission;
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
  /** The durable host's canonical global interval; it is never inferred from capture order. */
  readonly range: { readonly index: number; readonly startFrameIndex: number; readonly endFrameIndexExclusive: number };
  /** Exact active Core requests in canonical frame order; inactive frames are absent. */
  readonly schedule: readonly GpuSegmentedHybridRangeScheduleEntry[];
}

export interface GpuSegmentedHybridRangeScheduleEntry {
  readonly index: number;
  readonly atMs: number;
  readonly request: GpuHybridTextureRequest;
}

export interface GpuSegmentedHybridRangeCapture {
  readonly identity: GpuSegmentedHybridAdmissionIdentity;
  capture(input: {
    readonly index: number;
    readonly atMs: number;
    readonly request: GpuHybridTextureRequest;
    readonly signal?: AbortSignal;
  }): Promise<GpuHybridTextureResourceBinding>;
  finish(): GpuSegmentedHybridRangeLedger;
  close(): Promise<GpuSegmentedHybridRangeCleanupEvidence>;
}

export interface GpuSegmentedHybridLedgerEntry {
  readonly index: number;
  readonly atMs: number;
  readonly atUs: number;
  readonly requestFingerprint: string;
  readonly resourceId: string;
  readonly width: number;
  readonly height: number;
  readonly pngSha256: string;
  readonly decodedRgbaSha256: string;
}

export interface GpuSegmentedHybridRangeLedger {
  readonly schema: typeof GPU_SEGMENTED_HYBRID_RANGE_LEDGER_SCHEMA;
  readonly rangeIndex: number;
  readonly startFrameIndex: number;
  readonly endFrameIndexExclusive: number;
  readonly expectedCaptureCount: number;
  readonly captureCount: number;
  readonly entries: readonly GpuSegmentedHybridLedgerEntry[];
  readonly sequenceSha256: string;
}

export interface GpuSegmentedHybridRangeCleanupEvidence {
  readonly captureContext: "not-opened" | "closed";
  readonly scratch: "not-opened" | "released";
  readonly dynamicTexture: GpuSessionDynamicImageReservation;
}

/** Opaque pre-store source preparation; it cannot be used for a range until bootstrapped. */
export class GpuSegmentedHybridPreparation {
  readonly identity: GpuSegmentedHybridPreparationIdentity;
  readonly dynamicTexture: GpuSessionDynamicImageReservation;
  /** @internal Constructed only by prepareGpuSegmentedHybridAdmission. */
  constructor(identity: GpuSegmentedHybridPreparationIdentity, dynamicTexture: GpuSessionDynamicImageReservation) {
    this.identity = identity;
    this.dynamicTexture = dynamicTexture;
    Object.freeze(this);
  }
}

/** Opaque handle: source bytes and package-root authority never leave Browser. */
export class GpuSegmentedHybridAdmission {
  readonly identity: GpuSegmentedHybridAdmissionIdentity;
  readonly dynamicTexture: GpuSessionDynamicImageReservation;

  /** @internal Constructed only by prepareGpuSegmentedHybridAdmission. */
  constructor(identity: GpuSegmentedHybridAdmissionIdentity, dynamicTexture: GpuSessionDynamicImageReservation) {
    this.identity = identity;
    this.dynamicTexture = dynamicTexture;
    Object.freeze(this);
  }
}
