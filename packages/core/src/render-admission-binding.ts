/** Internal canonical bytes for one durable render-admission binding. */
import { canonicalJson } from "./canonical-json";
import { assertMotionJobId } from "./job-registry";
import { closedRecordWithOptional, opaqueText, sha256 } from "./lifecycle-envelope-validation";

export const MOTION_RENDER_ADMISSION_STORE_MAX_BYTES = 1024;

const STORE_SCHEMA = "shellx-motion/render-admission@1";
const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type StoredMotionRenderAdmission =
  | Readonly<{ mode: "legacy-planless" }>
  | Readonly<{ mode: "planned"; planFingerprint: string }>;

export type StoredMotionRenderAdmissionBinding = Readonly<{
  callerId: string;
  jobId: string;
  admission: StoredMotionRenderAdmission;
}>;

/** Parse exactly the binding that the durable admission writer accepts. */
export function parseStoredMotionRenderAdmissionBinding(value: unknown): StoredMotionRenderAdmissionBinding {
  const record = closedRecordWithOptional(value, ["schema", "callerId", "jobId", "mode"], ["planFingerprint"], "Render admission binding");
  if (record.schema !== STORE_SCHEMA) throw new Error("Unsupported render admission binding schema.");
  return Object.freeze({
    callerId: assertCallerId(record.callerId),
    jobId: assertMotionJobId(record.jobId as string),
    admission: parseStoredMotionRenderAdmission({ mode: record.mode, ...(record.planFingerprint === undefined ? {} : { planFingerprint: record.planFingerprint }) })
  });
}

/** Parse the one immutable admission class retained with a durable binding. */
export function parseStoredMotionRenderAdmission(value: unknown): StoredMotionRenderAdmission {
  const record = closedRecordWithOptional(value, ["mode"], ["planFingerprint"], "Render admission");
  if (record.mode === "legacy-planless" && record.planFingerprint === undefined) return Object.freeze({ mode: "legacy-planless" });
  if (record.mode === "planned" && record.planFingerprint !== undefined) {
    return Object.freeze({ mode: "planned", planFingerprint: sha256(record.planFingerprint, "Render admission planFingerprint") });
  }
  throw new Error("Render admission mode and planFingerprint do not agree.");
}

/** Canonical private bytes emitted by the durable admission writer. */
export function serializeStoredMotionRenderAdmissionBinding(value: StoredMotionRenderAdmissionBinding): string {
  const serialized = canonicalJson({ schema: STORE_SCHEMA, callerId: value.callerId, jobId: value.jobId, ...value.admission });
  if (Buffer.byteLength(serialized, "utf8") > MOTION_RENDER_ADMISSION_STORE_MAX_BYTES) throw new Error("Render admission binding exceeds its byte limit.");
  return serialized;
}

function assertCallerId(value: unknown): string {
  return opaqueText(value, "Render admission callerId", 1, 256, CALLER_ID);
}
