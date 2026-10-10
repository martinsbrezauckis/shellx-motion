/** Internal canonical bytes for one durable render-plan binding. */
import { canonicalJson } from "./canonical-json";
import { assertMotionJobId } from "./job-registry";
import { closedRecord, opaqueText } from "./lifecycle-envelope-validation";
import { MOTION_RENDER_PLAN_MAX_BYTES, parseMotionRenderPlan, type MotionRenderPlan } from "./render-plan";

export const MOTION_RENDER_PLAN_STORE_MAX_BYTES = MOTION_RENDER_PLAN_MAX_BYTES + 1024;

const STORE_SCHEMA = "shellx-motion/render-plan-binding@1";
const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type StoredMotionRenderPlanBinding = Readonly<{
  callerId: string;
  jobId: string;
  plan: MotionRenderPlan;
}>;

/** Parse exactly the binding that the durable plan writer accepts. */
export function parseStoredMotionRenderPlanBinding(value: unknown): StoredMotionRenderPlanBinding {
  const record = closedRecord(value, ["schema", "callerId", "jobId", "plan"], "Render plan binding");
  if (record.schema !== STORE_SCHEMA) throw new Error("Unsupported render plan binding schema.");
  return Object.freeze({
    callerId: assertCallerId(record.callerId),
    jobId: assertMotionJobId(record.jobId as string),
    plan: parseMotionRenderPlan(record.plan)
  });
}

/** Canonical private bytes emitted by the durable plan writer. */
export function serializeStoredMotionRenderPlanBinding(value: StoredMotionRenderPlanBinding): string {
  const serialized = canonicalJson({ schema: STORE_SCHEMA, callerId: value.callerId, jobId: value.jobId, plan: value.plan });
  if (Buffer.byteLength(serialized, "utf8") > MOTION_RENDER_PLAN_STORE_MAX_BYTES) {
    throw new Error(`Render plan binding exceeds its ${MOTION_RENDER_PLAN_STORE_MAX_BYTES}-byte limit.`);
  }
  return serialized;
}

function assertCallerId(value: unknown): string {
  return opaqueText(value, "Render plan callerId", 1, 256, CALLER_ID);
}
