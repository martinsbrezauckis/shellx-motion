import {
  defaultMotionHostRenderCapacity,
  motionPointCapacityEvidence,
  type MotionPointCapacityEvidence,
} from "@shellx-motion/core";

export interface MotionHostCapacityView {
  hostCapacity: typeof defaultMotionHostRenderCapacity;
  resourceFit: boolean;
  pointCapacity?: MotionPointCapacityEvidence;
}

/** Shared read-only projection for capability discovery; never accepts caller-selected limits. */
export function hostCapacityView(layers?: readonly unknown[]): MotionHostCapacityView {
  const pointCapacity = layers ? motionPointCapacityEvidence(layers) : undefined;
  return {
    hostCapacity: defaultMotionHostRenderCapacity,
    resourceFit: pointCapacity?.status !== "refused",
    ...(pointCapacity ? { pointCapacity } : {}),
  };
}
