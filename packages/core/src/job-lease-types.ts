import type { MotionJobFrameLane } from "./job-frame-lane";

export interface MotionJobLeaseRecord {
  schema: "shellx-motion/job-lease@1";
  jobId: string;
  runNonce?: string;
  pid: number;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  callerId: string;
  visibility?: "host" | "internal";
  startedAtMs: number;
  admittedAtMs?: number;
  heartbeatAtMs: number;
  cancelRequested?: { requestedBy: string; reason?: string; requestedAtMs: number };
  admitted: boolean;
}
