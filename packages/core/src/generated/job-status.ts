/**
 * GENERATED FILE — do not edit.
 *
 * Source: schemas/job-status.json
 * Regenerate: pnpm docs:job-status   ·   Verify: pnpm docs:check
 *
 * The single authored definition of how Motion reports what is happening with work an agent requested. Every state vocabulary, shared core error code and agent-facing description in the CLI, SDK, Debug API, MCP transport and documentation is generated from this file. Capability-owned future error codes follow the bounded preservation policy in this contract instead of being rewritten as a shared core code.
 */

/** Answers 'can this still change on its own?'. Three values. This set is frozen: adding to it is a breaking change. */
export type JobLifecycle = "pending" | "running" | "ended";

/** Answers 'how did it end?'. Present if and only if lifecycle is 'ended', null otherwise. */
export type JobOutcome = "succeeded" | "failed" | "cancelled" | "skipped";

/** A derived projection: lifecycle === 'ended' ? outcome : lifecycle. Generated, never authored, and never accepted as an input. You cancel by jobId; you never set a state. */
export type JobState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

/** Typed failures of a status *query*, which are never job states. */
export type JobQueryErrorCode = "job_unknown" | "job_expired" | "job_not_visible";

/** Why a job failed. Retryability is a property of the code, declared once, not per throw site. */
export type JobErrorCode = "job_queue_timeout" | "job_deadline_exceeded" | "job_rss_limit_exceeded" | "job_scratch_budget_failed" | "job_queue_full" | "job_abandoned" | "job_scratch_path_unsafe" | "job_input_budget_exceeded" | "unsupported_preset" | "capability_unavailable" | "invalid_args" | "unsafe_input_path" | "derived_output_busy" | "derived_output_exists" | "derived_output_stage_invalid" | "output_dir_not_empty" | "frame_lane_refused" | "quality_gate_failed" | "cache_integrity_failed" | "cache_busy" | "segment_store_busy" | "segment_checkpoint_invalid" | "segment_source_changed" | "segmented_final_unsupported" | "segmented_final_failed";

/** What a caller should do about a non-retryable failure. */
export type JobRemedyKind = "change_input" | "free_resources" | "wait" | "grant_permission" | "none";

/** Why a unit of work was deliberately not attempted. */
export type JobSkipCode = "already_satisfied" | "precondition_unmet" | "batch_halted" | "dependency_failed";

/** Coarse phase within a running job, for progress reporting only. Never a state. */
export type JobStage = "preparing" | "encoding" | "verifying" | "writing" | "launching" | "loading" | "drawing" | "closing" | "expanding" | "rendering" | "attesting";

export const JOB_LIFECYCLES: readonly JobLifecycle[] = Object.freeze(["pending", "running", "ended"]);
export const JOB_OUTCOMES: readonly JobOutcome[] = Object.freeze(["succeeded", "failed", "cancelled", "skipped"]);
export const JOB_STATES: readonly JobState[] = Object.freeze(["pending", "running", "succeeded", "failed", "cancelled", "skipped"]);

/** The states a job still in flight can occupy. Anything else has already ended. */
export const NON_TERMINAL_JOB_STATES: readonly JobState[] = Object.freeze(["pending", "running"]);

const TERMINAL_LIFECYCLES: ReadonlySet<string> = new Set(["ended"]);
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(["job_queue_timeout", "job_deadline_exceeded", "job_rss_limit_exceeded", "job_scratch_budget_failed", "job_queue_full", "job_abandoned", "derived_output_busy", "cache_busy", "segment_store_busy", "segmented_final_failed"]);
const REMEDY_BY_ERROR_CODE: Readonly<Record<JobErrorCode, JobRemedyKind>> = Object.freeze({
  "job_queue_timeout": "wait",
  "job_deadline_exceeded": "change_input",
  "job_rss_limit_exceeded": "free_resources",
  "job_scratch_budget_failed": "free_resources",
  "job_queue_full": "wait",
  "job_abandoned": "none",
  "job_scratch_path_unsafe": "change_input",
  "job_input_budget_exceeded": "change_input",
  "unsupported_preset": "change_input",
  "capability_unavailable": "grant_permission",
  "invalid_args": "change_input",
  "unsafe_input_path": "change_input",
  "derived_output_busy": "wait",
  "derived_output_exists": "change_input",
  "derived_output_stage_invalid": "change_input",
  "output_dir_not_empty": "change_input",
  "frame_lane_refused": "change_input",
  "quality_gate_failed": "change_input",
  "cache_integrity_failed": "change_input",
  "cache_busy": "wait",
  "segment_store_busy": "wait",
  "segment_checkpoint_invalid": "change_input",
  "segment_source_changed": "change_input",
  "segmented_final_unsupported": "change_input",
  "segmented_final_failed": "wait"
});
const OUTCOME_BY_RECEIPT_STATUS: Readonly<Record<string, JobOutcome>> = Object.freeze({
  "passed": "succeeded",
  "warning": "succeeded",
  "failed": "failed",
  "not_run": "skipped"
});

/** True while the job can still change on its own; false once it has ended. */
export function isJobInFlight(state: string): state is JobState {
  return (NON_TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/** True when the job will not change again on its own. */
export function isTerminalLifecycle(lifecycle: JobLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}

/**
 * Project the two authored axes onto the single token most callers read.
 *
 * Throws when an ended job carries no outcome, because that combination has no truthful
 * projection and silently reporting "ended" would hide which of four things happened.
 */
export function projectJobState(lifecycle: JobLifecycle, outcome: JobOutcome | null): JobState {
  if (!isTerminalLifecycle(lifecycle)) return lifecycle as JobState;
  if (outcome === null) throw new Error("An ended job must carry an outcome.");
  return outcome;
}

/** Whether retrying an identical request could succeed. Decided by the code, not the call site. */
export function isRetryableJobError(code: JobErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/** What a caller should do about this failure. */
export function remedyForJobError(code: JobErrorCode): JobRemedyKind {
  return REMEDY_BY_ERROR_CODE[code];
}

/**
 * Map a receipt's status onto the job outcome it contributes to.
 *
 * Receipt status and job outcome are deliberately different axes: a receipt describes one
 * operation's evidence, a job describes the caller's request. Returns undefined for a status
 * this contract does not map, rather than guessing.
 */
export function jobOutcomeForReceiptStatus(receiptStatus: string): JobOutcome | undefined {
  return OUTCOME_BY_RECEIPT_STATUS[receiptStatus];
}

/** Words that must never appear as a job state, guarding against a re-divergence. */
export const RESERVED_NON_JOB_STATE_WORDS: readonly string[] = Object.freeze(["passed", "not_run", "ok", "planned", "complete", "done", "finished", "error", "success"]);

/** Words that must never appear as a receipt status. */
export const RESERVED_NON_RECEIPT_STATUS_WORDS: readonly string[] = Object.freeze(["succeeded", "cancelled", "skipped", "pending", "running", "ended"]);

/** The whole authored contract, frozen, for runtime checks and documentation surfaces. */
export const JOB_STATUS_CONTRACT = Object.freeze({
  "schema": "shellx-motion/job-status-contract@1",
  "title": "ShellX Motion job status contract",
  "summary": "The single authored definition of how Motion reports what is happening with work an agent requested. Every state vocabulary, shared core error code and agent-facing description in the CLI, SDK, Debug API, MCP transport and documentation is generated from this file. Capability-owned future error codes follow the bounded preservation policy in this contract instead of being rewritten as a shared core code.",
  "designPrinciple": "A state earns its existence only if it changes what the caller does next. Anything that changes only latency or detail is a field, not a state.",
  "axes": {
    "lifecycle": "Answers 'can this still change on its own?'. Three values. This set is frozen: adding to it is a breaking change.",
    "outcome": "Answers 'how did it end?'. Present if and only if lifecycle is 'ended', null otherwise.",
    "state": "A derived projection: lifecycle === 'ended' ? outcome : lifecycle. Generated, never authored, and never accepted as an input. You cancel by jobId; you never set a state."
  },
  "lifecycle": [
    {
      "name": "pending",
      "terminal": false,
      "meaning": "Motion has accepted the request, validated its arguments, minted a jobId, and is waiting for a concurrency slot. No process has been spawned and no bytes have been written.",
      "agentAction": "wait",
      "agentGuidance": "Keep waiting. To tell the user how long, read queue.position and queue.aheadEstimatedMs. A cancel here is free and immediate.",
      "guaranteed": [
        "jobId",
        "operation",
        "caller",
        "createdAt",
        "truth",
        "queue",
        "cancelRequested"
      ],
      "absent": [
        "startedAt",
        "progress",
        "error",
        "endedAt",
        "artifacts"
      ],
      "notToBeConfusedWith": [
        {
          "state": "running",
          "because": "In pending nothing is being produced, so a user-facing 'rendering...' message is a lie. Say 'waiting for a slot (3 ahead)' instead."
        }
      ]
    },
    {
      "name": "running",
      "terminal": false,
      "meaning": "The job was admitted, resources are committed, and at least one worker process has been spawned and is being monitored by the governor.",
      "agentAction": "wait",
      "agentGuidance": "Keep waiting, and answer 'how long' from progress. Poll no faster than pollAfterMs. Check progress.updatedAt for staleness: if now minus progress.updatedAt exceeds three times progress.heartbeatMs, tell the user 'no progress for N seconds' rather than 'still working'.",
      "guaranteed": [
        "jobId",
        "operation",
        "caller",
        "createdAt",
        "truth",
        "cancelRequested",
        "startedAt",
        "progress"
      ],
      "absent": [
        "outcome",
        "error",
        "endedAt"
      ],
      "notToBeConfusedWith": [
        {
          "state": "pending",
          "because": "running means bytes are being produced; pending means a slot is being waited for."
        }
      ]
    },
    {
      "name": "ended",
      "terminal": true,
      "meaning": "The job will not change again. Read outcome to learn how it ended.",
      "agentAction": "read_outcome",
      "agentGuidance": "Branch on outcome. Never infer success from the presence of an artifact path.",
      "guaranteed": [
        "jobId",
        "operation",
        "caller",
        "createdAt",
        "truth",
        "outcome",
        "endedAt"
      ],
      "absent": [
        "queue"
      ],
      "notToBeConfusedWith": []
    }
  ],
  "outcomes": [
    {
      "name": "succeeded",
      "meaning": "The work completed and every declared output was produced, hashed and attested. warnings may be non-empty: a warned success is still a success.",
      "agentAction": "report_success",
      "agentGuidance": "Stop and report success, handing back artifacts[].path. If warnings is non-empty, surface it: the artifact exists but something about it was not what was asked for.",
      "guaranteed": [
        "endedAt",
        "durationMs",
        "artifacts",
        "receipts",
        "warnings"
      ],
      "absent": [
        "error"
      ],
      "notToBeConfusedWith": [
        {
          "state": "failed",
          "because": "A non-empty artifacts array does not imply success: a failed encode can leave a truncated file behind. Switch on outcome, never on the presence of a path."
        },
        {
          "state": "receipt status 'passed'",
          "because": "Job outcome and receipt status are different axes. A job can succeed while carrying a receipt whose status is 'warning'."
        }
      ]
    },
    {
      "name": "failed",
      "meaning": "The job was admitted or started, and stopped for a reason that was neither a cancellation request nor a deliberate skip.",
      "agentAction": "branch_on_retryable",
      "agentGuidance": "Read error.retryable. When true, retry after error.retryAfterMs if present. When false, use error.remedy to change approach, or error.message to explain to the user why this cannot work.",
      "guaranteed": [
        "endedAt",
        "durationMs",
        "error"
      ],
      "absent": [],
      "notToBeConfusedWith": [
        {
          "state": "cancelled",
          "because": "failed always carries error; cancelled never does. An agent may auto-retry a failed job. Auto-retrying a cancelled one overrides a human's explicit instruction."
        }
      ]
    },
    {
      "name": "cancelled",
      "meaning": "A cancel request was accepted and the work stopped. It may have stopped from pending, in which case nothing ran, or from running, in which case partial output may exist.",
      "agentAction": "stop_and_explain",
      "agentGuidance": "Stop and explain. Do not auto-retry. Surface cancellation.reason and cancellation.requestedBy to the user, and ask before restarting.",
      "guaranteed": [
        "endedAt",
        "cancellation"
      ],
      "absent": [
        "error"
      ],
      "notToBeConfusedWith": [
        {
          "state": "failed",
          "because": "The absence of error is the load-bearing invariant of this contract. An agent whose retry policy is 'if (job.error?.retryable) retry()' must be structurally incapable of restarting something a human stopped."
        },
        {
          "state": "skipped",
          "because": "cancelled means it was going to run and was stopped. skipped means it was never going to run."
        }
      ]
    },
    {
      "name": "skipped",
      "meaning": "Motion decided this unit of work should not run, and that decision was correct.",
      "agentAction": "report_neutrally",
      "agentGuidance": "Stop and report neutrally. This is not a problem and must not be reported as one. For already_satisfied the artifact from the prior run is referenced in artifacts, so the user's request is satisfied.",
      "guaranteed": [
        "endedAt",
        "skip"
      ],
      "absent": [
        "error",
        "startedAt",
        "durationMs"
      ],
      "notToBeConfusedWith": [
        {
          "state": "failed",
          "because": "A resumed batch of 100 rows where 97 were already done reports 97 skipped and 3 succeeded. Reporting those 97 as failures is how a working resume looks broken. startedAt being absent is the machine-checkable proof that nothing ran."
        }
      ]
    }
  ],
  "queryErrors": [
    {
      "code": "job_unknown",
      "meaning": "No record, and no receipt carrying this jobId. Almost always a typo or a query against the wrong machine.",
      "agentGuidance": "Stop. Do not report this as a failed job. Ask the user, or re-read the submission response for the real jobId."
    },
    {
      "code": "job_expired",
      "meaning": "The record existed but was pruned by retention. The receipt may still resolve.",
      "agentGuidance": "Fall back to the receipt index. If that is also gone, report that the evidence is no longer retained."
    },
    {
      "code": "job_not_visible",
      "meaning": "The record exists but belongs to a different caller, and cross-caller visibility was not granted.",
      "agentGuidance": "Re-query as the owning caller, or ask the host. Deliberately distinct from job_unknown: an agent told 'unknown' for a job that exists will conclude Motion lost it."
    }
  ],
  "errorCodes": [{"code":"job_queue_timeout","retryable":true,"remedy":"wait","meaning":"The job waited for a concurrency slot longer than its queue deadline allowed."},{"code":"job_deadline_exceeded","retryable":true,"remedy":"change_input","meaning":"The job ran longer than its deadline. Retrying an unchanged job will usually hit the same deadline; a smaller job will not."},{"code":"job_rss_limit_exceeded","retryable":true,"remedy":"free_resources","meaning":"The worker's resident memory crossed the governor's ceiling and it was stopped to protect the machine."},{"code":"job_scratch_budget_failed","retryable":true,"remedy":"free_resources","meaning":"Scratch space for intermediate frames could not be reserved."},{"code":"job_queue_full","retryable":true,"remedy":"wait","meaning":"The queue was at capacity when the job was submitted, so it was never admitted."},{"code":"job_abandoned","retryable":true,"remedy":"none","meaning":"The process that owned this job disappeared without writing a terminal record. Recorded by the reaper, not by the worker."},{"code":"job_scratch_path_unsafe","retryable":false,"remedy":"change_input","meaning":"The requested scratch location resolved outside the permitted roots."},{"code":"job_input_budget_exceeded","retryable":false,"remedy":"change_input","meaning":"The declared inputs exceed what this host will admit; retrying identical inputs cannot help."},{"code":"unsupported_preset","retryable":false,"remedy":"change_input","meaning":"The requested export preset does not exist on this build."},{"code":"capability_unavailable","retryable":false,"remedy":"grant_permission","meaning":"The operation needs a capability this caller's permission tier does not carry."},{"code":"invalid_args","retryable":false,"remedy":"change_input","meaning":"The request did not satisfy the command's argument contract."},{"code":"unsafe_input_path","retryable":false,"remedy":"change_input","meaning":"A final audio input was not a regular package-local WAV, FLAC, MP3, Ogg, or Opus file; M4A/MP4/MOV/Matroska/WebM and reference-capable inputs are refused before FFmpeg starts."},{"code":"derived_output_busy","retryable":true,"remedy":"wait","meaning":"Another final render holds the exact output path's private publication reservation."},{"code":"derived_output_exists","retryable":false,"remedy":"change_input","meaning":"The requested final path already exists; it was preserved rather than overwritten."},{"code":"derived_output_stage_invalid","retryable":false,"remedy":"change_input","meaning":"Private staged output changed or contained an unexpected file before publication."},{"code":"output_dir_not_empty","retryable":false,"remedy":"change_input","meaning":"The output directory already holds files, and overwriting was not requested."},{"code":"frame_lane_refused","retryable":false,"remedy":"change_input","meaning":"The chosen frame lane cannot draw this package faithfully; a different lane can."},{"code":"quality_gate_failed","retryable":false,"remedy":"change_input","meaning":"The delivered artifact did not satisfy the quality manifest it was rendered against."},{"code":"cache_integrity_failed","retryable":false,"remedy":"change_input","meaning":"An opt-in attested-reuse output, descriptor, receipt, or current input did not prove the exact requested identity, so Motion refused to overwrite or rerender it."},{"code":"cache_busy","retryable":true,"remedy":"wait","meaning":"An exact opt-in attested-reuse fill holds its root-local exclusive lock. A stale lock needs host inspection; Motion never breaks it automatically."},{"code":"segment_store_busy","retryable":true,"remedy":"wait","meaning":"Another durable segmented render owns the checkpoint store deterministically derived from this output path. Motion never breaks this lock automatically."},{"code":"segment_checkpoint_invalid","retryable":false,"remedy":"change_input","meaning":"A retained segmented checkpoint, source fingerprint, concat proof, or no-clobber publication proof was invalid, so Motion did not publish the requested output."},{"code":"segment_source_changed","retryable":false,"remedy":"change_input","meaning":"The package changed while durable segmented checkpoints were being produced. Start a fresh render from stable package bytes."},{"code":"segmented_final_unsupported","retryable":false,"remedy":"change_input","meaning":"The selected segmented delivery mode does not support this renderer, preset, workflow, script, or quality contract."},{"code":"segmented_final_failed","retryable":true,"remedy":"wait","meaning":"Segmented delivery stopped without a completed no-clobber publication. Only verified checkpoints, if any, remain for an explicit resume."}],
  "unknownErrorCodes": {
    "policy": "preserve",
    "pattern": "^[a-z][a-z0-9_.:-]{0,95}$",
    "maxLength": 96,
    "meaning": "A newer capability may return or raise a typed code an older consumer does not enumerate. Motion preserves that bounded code, message, retryable flag, optional retryAfterMs, remedy and suggestedAction through events and terminal job state rather than collapsing it to invalid_args or connector_failed. Exception stacks, details and path-bearing text are never terminal job metadata.",
    "agentGuidance": "Treat the code as an opaque category. Branch on the explicit retryable flag and optional remedy/retryAfterMs fields; never infer policy from an unknown code name or parse its human message."
  },
  "remedyKinds": [
    {
      "kind": "change_input",
      "meaning": "Retrying the same request cannot help. Change the named field to one of the expected values."
    },
    {
      "kind": "free_resources",
      "meaning": "The host is out of a resource. Wait for other work to finish, or reduce the size of this job."
    },
    {
      "kind": "wait",
      "meaning": "The condition is transient. Retry after retryAfterMs."
    },
    {
      "kind": "grant_permission",
      "meaning": "The caller needs a higher permission tier. A human decision, not an automatic one."
    },
    {
      "kind": "none",
      "meaning": "No action recovers this specific job. Submitting a fresh one may succeed."
    }
  ],
  "skipCodes": [
    {
      "code": "already_satisfied",
      "meaning": "A resume found an attested artifact matching this exact request. The user's goal is already met."
    },
    {
      "code": "precondition_unmet",
      "meaning": "A condition this unit of work depends on was not true, so running it would have been wrong."
    },
    {
      "code": "batch_halted",
      "meaning": "An earlier row in the batch triggered a hard stop, so this row was never attempted."
    },
    {
      "code": "dependency_failed",
      "meaning": "Work this unit depends on did not succeed, so attempting this one would be pointless."
    }
  ],
  "stages": {
    "ffmpeg": [
      "preparing",
      "encoding",
      "verifying",
      "writing"
    ],
    "browser": [
      "launching",
      "loading",
      "drawing",
      "closing"
    ],
    "native": [
      "loading",
      "drawing",
      "writing"
    ],
    "batch": [
      "expanding",
      "rendering",
      "attesting"
    ]
  },
  "receiptMapping": [
    {
      "receiptStatus": "passed",
      "contributesTo": "succeeded",
      "because": "The operation produced what it declared."
    },
    {
      "receiptStatus": "warning",
      "contributesTo": "succeeded",
      "because": "A warned success is still a success. The warning travels in warnings[], not in the outcome."
    },
    {
      "receiptStatus": "failed",
      "contributesTo": "failed",
      "because": "The operation did not produce what it declared."
    },
    {
      "receiptStatus": "not_run",
      "contributesTo": "skipped",
      "because": "Nothing was attempted, which is what skipped means."
    }
  ],
  "reservedWords": {
    "neverInJobStatus": [
      "passed",
      "not_run",
      "ok",
      "planned",
      "complete",
      "done",
      "finished",
      "error",
      "success"
    ],
    "neverInReceiptStatus": [
      "succeeded",
      "cancelled",
      "skipped",
      "pending",
      "running",
      "ended"
    ]
  },
  "rulingStatuses": [
    {
      "status": "provisional-pending-maintainer",
      "meaning": "Taken to keep the contract shippable, using the reversible option, and still awaiting a maintainer's confirmation. Build against the ruling as written; do not build against the possibility of it changing. The value names a review role rather than a person, so it remains accurate when maintainership changes and describes what the status means instead of who owns the project."
    },
    {
      "status": "settled",
      "meaning": "Confirmed. Reversing it is a breaking change to this contract, handled like any other."
    }
  ],
  "rulings": [
    {
      "question": "What is Motion's shipped asynchronous render route?",
      "ruling": "The persistent local coordinator accepts `motion.job.submit` and returns a durable jobId before expensive work starts; `motion.render.final` and the CLI `render` command remain blocking compatibility calls.",
      "because": "The coordinator owns the submitted worker's AbortSignal, terminal record, and ordered event stream, so its `motion.job.get/list/events/cancel/retry` controls describe the same submitted work. Submission is intentionally limited to ordinary streamed or closed segmented final-video delivery; stills, image sequences, workflows, quality-manifest routes, retained frames, dry runs, and other materialized compatibility paths stay blocking under `motion.render.final`. This is the shipped asynchronous route, not a promise of a future `--async` flag.",
      "status": "settled"
    },
    {
      "question": "Where does the runtime job registry live?",
      "ruling": "Per-user, under the platform's runtime directory.",
      "because": "A shared machine-wide location would give true machine-wide truth but needs a permissions model and is a security-boundary decision. The accepted gap is that two different users on one machine can still overcommit it; that gap is documented rather than silently carried.",
      "status": "provisional-pending-maintainer"
    },
    {
      "question": "Does a warned success need its own outcome?",
      "ruling": "No. outcome 'succeeded' with a non-empty warnings array.",
      "because": "A fifth outcome forces every client switch to grow for something they would handle identically.",
      "status": "provisional-pending-maintainer"
    },
    {
      "question": "How long are terminal job records retained?",
      "ruling": "7 days or 1000 jobs, whichever binds first, then pruned to receipts only.",
      "because": "Retention is what makes job_expired distinguishable from job_unknown. The contract needs a number more than it needs a particular number.",
      "status": "provisional-pending-maintainer"
    }
  ]
} as const);
