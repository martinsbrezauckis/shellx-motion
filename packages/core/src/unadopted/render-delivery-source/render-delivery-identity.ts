/** Deterministic identity helpers for the private provider-delivery boundary. */

import { canonicalJsonSha256 } from "../../canonical-json";
import type { MotionRenderDelivery, RenderDeliveryFrameIdentity, RenderDeliveryRational, RenderDeliveryScheduleFrame } from "./render-delivery-types";

/** Hash the exact rational frame schedule; rate is included because frame indices alone are insufficient. */
export function renderDeliveryScheduleSha256(
  rate: RenderDeliveryRational,
  schedule: readonly RenderDeliveryScheduleFrame[],
): string {
  return canonicalJsonSha256({ rate, schedule });
}

/** Hash the ordered per-frame content identities, rather than any provider-local locations. */
export function renderDeliveryFrameSequenceSha256(frames: readonly RenderDeliveryFrameIdentity[]): string {
  return canonicalJsonSha256({ frames });
}

/**
 * A provider delivery's canonical identity. The data contract intentionally has no provider-local
 * path fields, so this hash cannot become a machine-specific package identity.
 */
export function renderDeliveryFingerprint(delivery: MotionRenderDelivery): string {
  return canonicalJsonSha256(delivery);
}

/**
 * Bind anchor coordinates to every delivery fact without asking a file to contain a SHA-256 that
 * is itself calculated from that file. The full delivery fingerprint still includes the raw anchor
 * SHA-256; this projection omits only that one self-referential descriptor field.
 */
export function renderDeliveryAnchorDeliveryBindingSha256(delivery: MotionRenderDelivery): string {
  if (!delivery.anchors) throw new Error("A provider anchor delivery binding requires an anchor descriptor.");
  const { sha256: _anchorPayloadSha256, ...anchorDescriptor } = delivery.anchors;
  return canonicalJsonSha256({ ...delivery, anchors: anchorDescriptor });
}
