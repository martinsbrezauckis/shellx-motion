import type { MotionDocument } from "@shellx-motion/core";
import type { GpuStreamingFrameProducerInput, GpuStreamingStaticPlan } from "./gpu-streaming-producer-types";
import { validateGpuStreamingBehaviorStaticPlan, validateGpuStreamingStaticPlan, type GpuStaticPlanFailure } from "./gpu-streaming-static-plan";

export function admitGpuStreamingStaticPlan(input: GpuStreamingFrameProducerInput, motion: MotionDocument, frameCount: number, assets: readonly string[]): { behaviorStaticPlan: GpuStreamingFrameProducerInput["behaviorStaticPlan"]; staticPlan: GpuStreamingStaticPlan; failure: GpuStaticPlanFailure | null } {
  const behaviorStaticPlan = input.behaviorStaticPlan, staticPlan = behaviorStaticPlan?.basePlan ?? input.staticPlan;
  const failure = behaviorStaticPlan
    ? validateGpuStreamingBehaviorStaticPlan(behaviorStaticPlan, motion, frameCount, assets)
    : validateGpuStreamingStaticPlan(staticPlan, motion, frameCount, assets);
  return { behaviorStaticPlan, staticPlan, failure };
}
