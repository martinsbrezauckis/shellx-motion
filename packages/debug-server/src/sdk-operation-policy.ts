/** Complete SDK operation admission policy for the authenticated local server. */
import type { MotionDebugContext } from "@shellx-motion/debug-api";
import type { MotionSdkOperation } from "@shellx-motion/sdk";

type MotionPermissionTier = MotionDebugContext["tier"];

export const SDK_OPERATION_TIER: Readonly<Record<MotionSdkOperation, MotionPermissionTier>> = {
  validate: "read_motion",
  compile: "write_local",
  preview: "render_motion",
  render: "render_motion",
  status: "read_motion",
  cancel: "render_motion",
  timelineEdit: "edit_motion",
  trackingRequest: "write_local",
  trackingInspect: "read_motion",
  trackingApply: "edit_motion",
  trackingDetach: "edit_motion",
  trackingVerify: "read_motion",
  keyingInspect: "read_motion",
  keyingApply: "edit_motion",
  keyingRemove: "edit_motion",
  rotoUpsert: "edit_motion",
  rotoTrackingDetach: "edit_motion",
  rotoRemove: "edit_motion",
  compositingInspect: "read_motion",
  compositingSet: "edit_motion",
  compositingRemove: "edit_motion",
  gltfImport: "write_local",
  proceduralInspect: "read_motion",
  proceduralSet: "edit_motion",
  proceduralSetEnabled: "edit_motion",
  proceduralBake: "edit_motion",
  proceduralDetach: "edit_motion",
};

const SDK_OPERATIONS = new Set<MotionSdkOperation>(Object.keys(SDK_OPERATION_TIER) as MotionSdkOperation[]);

export function readSdkOperation(value: unknown): MotionSdkOperation | null {
  return typeof value === "string" && SDK_OPERATIONS.has(value as MotionSdkOperation)
    ? value as MotionSdkOperation
    : null;
}
