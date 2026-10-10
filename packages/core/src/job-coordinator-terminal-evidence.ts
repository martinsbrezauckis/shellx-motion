/** Best-effort path-free terminal evidence for one immutable coordinated final render. */
import type { MotionJobCoordinatorExecution } from "./job-coordinator-execution";
import type { MotionJobFrameLane } from "./job-frame-lane";
import { createMotionJobEvidence, type MotionJobEvidence } from "./job-evidence";
import { canonicalMotionJobRecordWarnings } from "./job-record-contract";
import type { MotionRenderPlan } from "./render-plan";

export type MotionCoordinatorTerminalOutcome = "succeeded" | "failed" | "cancelled";

export interface MotionCoordinatorTerminalEvidenceJob {
  readonly jobId: string;
  readonly callerId: string;
  readonly operation: string;
  readonly renderPlan?: MotionRenderPlan;
}

export interface MotionCoordinatorTerminalEvidenceExecution {
  readonly receiptId?: string;
  readonly producerEvidence?: { readonly frameLane: MotionJobFrameLane; readonly schema?: string };
  readonly warnings?: readonly string[];
}

/**
 * Build the optional evidence mirror without changing the authoritative terminal result.
 *
 * Ordinary coordinated final-video routes do not currently produce a verified attested artifact
 * handle, so V1 truthfully carries an empty artifact list. If any compact field cannot enter the
 * path-free envelope, the terminal record keeps its original details and omits this optional
 * envelope rather than redacting or inventing evidence.
 */
export function createCoordinatorTerminalEvidence(
  job: MotionCoordinatorTerminalEvidenceJob,
  outcome: MotionCoordinatorTerminalOutcome,
  execution?: MotionCoordinatorTerminalEvidenceExecution
): MotionJobEvidence | undefined {
  if (!job.renderPlan || job.operation !== "render.final") return undefined;
  try {
    return createMotionJobEvidence({
      jobId: job.jobId,
      callerId: job.callerId,
      operation: "render.final",
      planFingerprint: job.renderPlan.fingerprint,
      outcome,
      warnings: canonicalMotionJobRecordWarnings(execution?.warnings),
      receiptIds: execution?.receiptId ? [execution.receiptId] : [],
      producerEvidence: execution?.producerEvidence ?? null,
      artifacts: []
    });
  } catch {
    return undefined;
  }
}

/** Keep the coordinator-facing structural subset explicit when its execution type grows. */
export function coordinatorTerminalExecutionEvidence(
  execution: MotionJobCoordinatorExecution
): MotionCoordinatorTerminalEvidenceExecution {
  return {
    ...(execution.receiptId ? { receiptId: execution.receiptId } : {}),
    ...(execution.producerEvidence ? { producerEvidence: execution.producerEvidence } : {}),
    ...(execution.warnings ? { warnings: execution.warnings } : {})
  };
}

/** Ready-to-spread terminal detail for the coordinator's existing host-job transition. */
export function coordinatorTerminalEvidenceDetail(
  job: MotionCoordinatorTerminalEvidenceJob,
  outcome: MotionCoordinatorTerminalOutcome,
  execution?: MotionJobCoordinatorExecution
): Readonly<{ evidence?: MotionJobEvidence }> {
  const evidence = createCoordinatorTerminalEvidence(job, outcome, execution ? coordinatorTerminalExecutionEvidence(execution) : undefined);
  return evidence ? { evidence } : {};
}
