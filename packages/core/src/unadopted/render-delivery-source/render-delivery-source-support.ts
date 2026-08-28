import type {
  RenderDeliveryEphemeralAnchorSource,
  RenderDeliveryEphemeralFrameSource,
} from "./render-delivery-import-plan";
import {
  MAX_RENDER_DELIVERY_FRAMES,
  type MotionRenderDeliveryAnchorPayload,
} from "./render-delivery-types";
import type { StableFileIdentity } from "../../stable-file-read";

/** The encoded ceiling is separate from PNG's decoded-RGBA limit and is reserved before reads. */
export const MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_RENDER_DELIVERY_SEQUENCE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_RENDER_DELIVERY_ANCHOR_BYTES = 4 * 1024 * 1024;

export const RENDER_DELIVERY_SOURCE_LIMITS = Object.freeze({
  maxFileBytes: MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES,
  /** Up to 600 beauty frames plus exactly one closed anchor payload. */
  maxFiles: MAX_RENDER_DELIVERY_FRAMES + 1,
  maxPathDepth: 16,
  maxAggregateBytes: MAX_RENDER_DELIVERY_SEQUENCE_BYTES,
  maxConcurrentReads: 1,
});

export type RenderDeliverySourceAdmissionErrorCode =
  | "delivery_not_admitted"
  | "source_bounds"
  | "source_identity"
  | "source_hash"
  | "source_png"
  | "source_anchor_payload";

/** Deliberately path-free failure: provider source locations are never safe diagnostic text. */
export class RenderDeliverySourceAdmissionError extends Error {
  constructor(readonly code: RenderDeliverySourceAdmissionErrorCode) {
    super(messageFor(code));
    this.name = "RenderDeliverySourceAdmissionError";
    Object.setPrototypeOf(this, RenderDeliverySourceAdmissionError.prototype);
  }
}

export interface RenderDeliveryBeautySourceFileFact {
  readonly role: "beauty";
  readonly frameIndex: number;
  readonly packagePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface RenderDeliveryAnchorSourceFileFact {
  readonly role: "anchors";
  readonly packagePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly schema: MotionRenderDeliveryAnchorPayload["schema"];
  readonly deliveryBindingSha256: string;
  readonly frameCount: number;
  readonly convention: MotionRenderDeliveryAnchorPayload["coordinateConvention"];
}

export type RenderDeliverySourceFileFact = RenderDeliveryBeautySourceFileFact | RenderDeliveryAnchorSourceFileFact;

export interface EphemeralSourceLocations {
  readonly providerInputRoot: string;
  readonly beauty: readonly (RenderDeliveryEphemeralFrameSource & { readonly identity: StableFileIdentity })[];
  readonly anchors?: RenderDeliveryEphemeralAnchorSource & { readonly identity: StableFileIdentity };
}

export interface VerifiedBeautySource {
  readonly fact: RenderDeliveryBeautySourceFileFact;
  readonly identity: StableFileIdentity;
}

export interface VerifiedAnchorSource {
  readonly fact: RenderDeliveryAnchorSourceFileFact;
  readonly identity: StableFileIdentity;
}

function messageFor(code: RenderDeliverySourceAdmissionErrorCode): string {
  switch (code) {
    case "delivery_not_admitted": return "Provider delivery is not admitted for C5A source import.";
    case "source_bounds": return "Provider delivery source exceeds the C5A byte or count bounds.";
    case "source_identity": return "Provider delivery source identity is not safe or changed during admission.";
    case "source_hash": return "Provider delivery source bytes do not match the delivered frame hash.";
    case "source_png": return "Provider delivery beauty source is not an admitted C5A PNG frame.";
    case "source_anchor_payload": return "Provider delivery anchor source is not an admitted closed C5B1 payload.";
  }
}
