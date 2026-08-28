/** Debug-only bridge for one original, Core-admitted provider delivery. */
export {
  admitMotionRenderDeliverySources,
  MAX_RENDER_DELIVERY_ANCHOR_BYTES,
  MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES,
  MAX_RENDER_DELIVERY_SEQUENCE_BYTES,
  renderDeliverySourceManifestFingerprint,
  revalidateMotionRenderDeliverySources,
  withRenderDeliveryEphemeralSourceAuthority,
} from "./render-delivery-source-manifest";
export {
  renderDeliveryAnchorDeliveryBindingSha256,
  renderDeliveryFingerprint,
} from "./render-delivery-identity";
export { describeMotionRenderDelivery } from "./render-delivery-validate";
export { deriveMotionRenderDeliveryImportPlan } from "./render-delivery-import-plan";
export { parseMotionRenderDeliveryAnchorPayload } from "./render-delivery-anchor-payload";
export { MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024 } from "./render-delivery-types";
export { assertMotionRelationTargetsEditable } from "../../motion-relation-authoring-guards";
export { validateMotionBehaviors } from "../../motion-behavior-validate";
export type {
  MotionRenderDeliverySourceAdmissionOptions,
  MotionRenderDeliverySourceManifest,
} from "./render-delivery-source-manifest";
export type { EphemeralSourceLocations } from "./render-delivery-source-support";
