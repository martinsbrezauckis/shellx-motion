import type { MotionJobFrameLane } from "./job-frame-lane";

export interface MotionJobLeaseRecord {
  schema: "shellx-motion/job-lease@1";
  jobId: string;
  runNonce?: string;
  pid: number;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  /** Host-derived immutable V1 render-plan identity, when this job was preflighted with one. */
  planFingerprint?: string;
  callerId: string;
  visibility?: "host" | "internal";
  startedAtMs: number;
  admittedAtMs?: number;
  heartbeatAtMs: number;
  cancelRequested?: { requestedBy: string; reason?: string; requestedAtMs: number };
  admitted: boolean;
}
