import { readFile } from "node:fs/promises";
import { UNATTRIBUTED_CALLER_ID } from "./job-lease";
import { isMotionJobFrameLane } from "./job-frame-lane";
import { parseMotionJobFailure } from "./job-failure";
import type { MotionJobRecord } from "./job-registry";

/** Read a terminal record only after its optional v0.2 GPU fields pass the durable boundary. */
export async function readStoredMotionJobRecord(path: string): Promise<MotionJobRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MotionJobRecord>;
    if (parsed?.schema !== "shellx-motion/job-record@1") return null;
    if (typeof parsed.jobId !== "string" || typeof parsed.endedAtMs !== "number" || typeof parsed.outcome !== "string") return null;
    if (typeof parsed.callerId !== "string") parsed.callerId = UNATTRIBUTED_CALLER_ID;
    if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
    if (parsed.frameLane !== undefined && !isMotionJobFrameLane(parsed.frameLane)) return null;
    if (parsed.receiptId !== undefined && (typeof parsed.receiptId !== "string" || !parsed.receiptId)) return null;
    if (parsed.error !== undefined) {
      const error = parseMotionJobFailure(parsed.error);
      if (!error) return null;
      parsed.error = error;
    }
    if (parsed.producerEvidence !== undefined) {
      const evidence = parsed.producerEvidence;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
        || !isMotionJobFrameLane((evidence as { frameLane?: unknown }).frameLane)
        || ((evidence as { schema?: unknown }).schema !== undefined && typeof (evidence as { schema?: unknown }).schema !== "string")) return null;
    }
    return parsed as MotionJobRecord;
  } catch {
    return null;
  }
}
