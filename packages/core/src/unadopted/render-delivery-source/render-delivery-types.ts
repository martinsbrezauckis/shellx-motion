/**
 * Private, renderer-neutral receipt contract for importing completed provider frames.
 *
 * This is deliberately not part of Motion's public document schema. It describes a bounded,
 * revalidated delivery at the provider boundary; it does not express a scene editor or execute IO.
 */

export const MOTION_RENDER_DELIVERY_SCHEMA = "motion.render-delivery/v1" as const;
export const MOTION_RENDER_DELIVERY_IMPORT_PLAN_SCHEMA = "motion.render-delivery-import-plan/v1" as const;
/** Private opaque-data ABI; B1 imports this payload but deliberately does not inspect or bake it. */
export const MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA = "motion.render-provider-anchor-payload/v1" as const;
export const MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION = "screen-pixel-top-left-q1024" as const;

export const MAX_RENDER_DELIVERY_FRAMES = 600;
export const MAX_RENDER_DELIVERY_ANCHORS = 64;
export const MAX_RENDER_DELIVERY_ANCHOR_SAMPLES = MAX_RENDER_DELIVERY_ANCHORS * MAX_RENDER_DELIVERY_FRAMES;
/** Positive signed-32-bit ID keeps renderer-neutral provider anchors compact and orderable. */
export const MAX_RENDER_DELIVERY_ANCHOR_ID = 2_147_483_647;
/** Signed Q1024 screen coordinates: +/-8192 pixels, including bounded off-screen points. */
export const MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024 = 8_388_608;
export const MAX_RENDER_DELIVERY_DIMENSION = 8_192;
export const MAX_RENDER_DELIVERY_PIXELS = 33_177_600;

export interface RenderDeliveryRational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface RenderDeliveryScheduleFrame {
  readonly index: number;
  readonly presentationTime: RenderDeliveryRational;
}

export interface RenderDeliveryFrameIdentity {
  readonly index: number;
  readonly sha256: string;
}

export interface RenderDeliveryProvider {
  readonly id: string;
  readonly version: string;
  readonly capabilitySnapshotSha256: string;
}

export interface RenderDeliveryTerminal {
  readonly jobId: string;
  readonly outcome: "passed";
  readonly revalidation: "passed";
  /** A fact from the provider runtime, not permission for Motion to clean up provider state. */
  readonly cleanup: {
    readonly state: "closed" | "held-warm";
    readonly succeeded: true;
  };
}

export interface RenderDeliveryIdentity {
  readonly sceneSha256: string;
  readonly shotSha256: string;
  readonly assetManifestSha256: string;
  readonly scheduleSha256: string;
  readonly providerReceiptSha256: string;
}

export interface RenderDeliveryConventions {
  readonly timing: "frame-index-rational-seconds";
  readonly coordinates: "screen-pixel-top-left";
  readonly alpha: "straight";
  /** v1 admits no depth plane. Future depth needs an explicit convention change. */
  readonly depth: "not-provided";
}

export interface RenderDeliveryBeautyPass {
  readonly kind: "beauty";
  readonly id: "beauty";
  readonly format: "png";
  readonly alphaMode: "straight";
  readonly width: number;
  readonly height: number;
  readonly frames: readonly RenderDeliveryFrameIdentity[];
  readonly frameSequenceSha256: string;
}

/** Reserved descriptors make a provider's unsupported request legible, never importable in v1. */
export interface RenderDeliveryRefusedPass {
  readonly kind: "matte" | "depth";
  readonly id: string;
}

export type RenderDeliveryPass = RenderDeliveryBeautyPass | RenderDeliveryRefusedPass;

export interface RenderDeliveryAnchors {
  readonly schema: typeof MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA;
  readonly sha256: string;
  readonly frameCount: number;
  readonly convention: typeof MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION;
}

/**
 * A closed, renderer-neutral, numeric-only anchor payload. An anchor has one exact state for each
 * admitted schedule frame. An absent anchor ID is not delivered; `not-visible` is a delivered,
 * explicit state and never carries a held or inferred position.
 */
export interface MotionRenderDeliveryAnchorPayload {
  readonly schema: typeof MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA;
  /** Binds all delivery facts except this file's self-referential raw SHA-256. */
  readonly deliveryBindingSha256: string;
  readonly coordinateConvention: typeof MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION;
  readonly anchors: readonly RenderDeliveryAnchorTrack[];
}

export interface RenderDeliveryAnchorTrack {
  /** Provider labels resolve to one positive signed-32-bit stable numeric ID before persistence. */
  readonly id: number;
  readonly samples: readonly RenderDeliveryAnchorSample[];
}

export type RenderDeliveryAnchorSample = RenderDeliveryVisibleAnchorSample | RenderDeliveryNotVisibleAnchorSample;

export interface RenderDeliveryVisibleAnchorSample {
  readonly frameIndex: number;
  readonly state: "visible";
  readonly xQ1024: number;
  readonly yQ1024: number;
}

export interface RenderDeliveryNotVisibleAnchorSample {
  readonly frameIndex: number;
  readonly state: "not-visible";
}

export interface MotionRenderDelivery {
  readonly schema: typeof MOTION_RENDER_DELIVERY_SCHEMA;
  readonly provider: RenderDeliveryProvider;
  readonly terminal: RenderDeliveryTerminal;
  readonly identity: RenderDeliveryIdentity;
  readonly conventions: RenderDeliveryConventions;
  readonly rate: RenderDeliveryRational;
  readonly schedule: readonly RenderDeliveryScheduleFrame[];
  readonly passes: readonly RenderDeliveryPass[];
  readonly anchors?: RenderDeliveryAnchors;
}

export interface RenderDeliveryIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type RenderDeliveryDescription =
  | { readonly ok: true; readonly delivery: MotionRenderDelivery; readonly fingerprint: string }
  | { readonly ok: false; readonly issues: readonly RenderDeliveryIssue[] };

export interface RenderDeliveryBeautyStagedAsset {
  readonly role: "beauty";
  readonly packagePath: string;
  readonly sha256: string;
  readonly frameIndex: number;
}

export interface RenderDeliveryAnchorStagedAsset {
  readonly role: "anchors";
  readonly packagePath: string;
  readonly sha256: string;
  readonly schema: typeof MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA;
  readonly deliveryBindingSha256: string;
  readonly frameCount: number;
  readonly convention: typeof MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION;
}

export interface MotionRenderDeliveryImportPlan {
  readonly schema: typeof MOTION_RENDER_DELIVERY_IMPORT_PLAN_SCHEMA;
  readonly deliveryFingerprint: string;
  readonly provider: Pick<RenderDeliveryProvider, "id" | "version">;
  readonly timing: {
    readonly rate: RenderDeliveryRational;
    readonly schedule: readonly RenderDeliveryScheduleFrame[];
    readonly scheduleSha256: string;
    readonly frameCount: number;
  };
  readonly assets: {
    readonly beauty: readonly RenderDeliveryBeautyStagedAsset[];
    readonly anchors?: RenderDeliveryAnchorStagedAsset;
  };
}

export type RenderDeliveryImportPlanningResult =
  | { readonly ok: true; readonly plan: MotionRenderDeliveryImportPlan }
  | { readonly ok: false; readonly issues: readonly RenderDeliveryIssue[] };
