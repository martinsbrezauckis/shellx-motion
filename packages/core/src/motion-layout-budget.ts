import {
  MAX_MOTION_LAYOUT_CHILDREN,
  MAX_MOTION_LAYOUT_COMPILED_INSTANCES,
  MAX_MOTION_LAYOUT_COMPILED_MEMORY_BYTES,
  MAX_MOTION_LAYOUT_COMPILED_WORK,
  MAX_MOTION_LAYOUT_PLAN_BYTES,
  MAX_MOTION_LAYOUT_REPEATER_INSTANCES,
  MAX_MOTION_LAYOUT_REPEATERS,
  type MotionLayoutBudget,
  type MotionLayoutBudgetLimits,
  type MotionLayoutCompileRequest,
  type MotionLayoutIssue,
} from "./motion-layout-types";
import { issueAt, utf8Bytes } from "./motion-layout-safety";

const ESTIMATED_INSTANCE_BYTES = 256;
const ESTIMATED_PLAN_INSTANCE_BYTES = 128;

export function estimateMotionLayoutBudget(request: MotionLayoutCompileRequest, inputBytes: number): MotionLayoutBudget {
  const repeaters = new Map(request.repeaters.map((repeater) => [repeater.sourceId, repeater]));
  const compiledInstances = request.children.reduce((total, child) => total + (repeaters.get(child.id)?.count ?? 1), 0);
  const workPerInstance = request.layout.kind === "radial" ? 16 : request.layout.kind === "grid" ? 14 : 10;
  const identifierBytes = request.children.reduce((total, child) => total + utf8Bytes(child.id) * (repeaters.get(child.id)?.count ?? 1), 0);
  return {
    usage: {
      inputChildren: request.children.length,
      repeaterCount: request.repeaters.length,
      compiledInstances,
      estimatedWork: compiledInstances * workPerInstance + request.repeaters.length * 4,
      estimatedMemoryBytes: inputBytes + compiledInstances * ESTIMATED_INSTANCE_BYTES,
      estimatedPlanBytes: inputBytes + compiledInstances * ESTIMATED_PLAN_INSTANCE_BYTES + identifierBytes,
    },
    limits: motionLayoutBudgetLimits(),
  };
}

export function motionLayoutBudgetLimits(): MotionLayoutBudgetLimits {
  return {
    maxChildren: MAX_MOTION_LAYOUT_CHILDREN,
    maxRepeaters: MAX_MOTION_LAYOUT_REPEATERS,
    maxInstancesPerRepeater: MAX_MOTION_LAYOUT_REPEATER_INSTANCES,
    maxCompiledInstances: MAX_MOTION_LAYOUT_COMPILED_INSTANCES,
    maxWork: MAX_MOTION_LAYOUT_COMPILED_WORK,
    maxMemoryBytes: MAX_MOTION_LAYOUT_COMPILED_MEMORY_BYTES,
    maxPlanBytes: MAX_MOTION_LAYOUT_PLAN_BYTES,
  };
}

export function validateMotionLayoutBudget(budget: MotionLayoutBudget, issues: MotionLayoutIssue[]): void {
  const { usage, limits } = budget;
  if (usage.compiledInstances > limits.maxCompiledInstances) issueAt(issues, "/repeaters", "budget.instances", `would compile ${usage.compiledInstances} instances; limit is ${limits.maxCompiledInstances}`);
  if (usage.estimatedWork > limits.maxWork) issueAt(issues, "/", "budget.work", `estimated work ${usage.estimatedWork} exceeds ${limits.maxWork}`);
  if (usage.estimatedMemoryBytes > limits.maxMemoryBytes) issueAt(issues, "/", "budget.memory", `estimated memory ${usage.estimatedMemoryBytes} exceeds ${limits.maxMemoryBytes} bytes`);
  if (usage.estimatedPlanBytes > limits.maxPlanBytes) issueAt(issues, "/", "budget.plan_bytes", `estimated plan ${usage.estimatedPlanBytes} exceeds ${limits.maxPlanBytes} bytes`);
}
