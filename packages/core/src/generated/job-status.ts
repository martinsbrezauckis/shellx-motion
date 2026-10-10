/**
 * GENERATED FILE — do not edit.
 *
 * Source: schemas/job-status.json
 * Regenerate: pnpm docs:job-status   ·   Verify: pnpm docs:check
 *
 * The single authored definition of how Motion reports observable job state. The V1 status view carries the callerId, lifecycle/outcome projection, timestamps, warnings, and only fields that the live lease or terminal record actually retains; it never exposes host process identity or invents queue position, ETA, progress, workers, bytes, artifact lists, or receipt lists. Every state vocabulary, shared core error code and agent-facing description in the CLI, SDK, Debug API, MCP transport and documentation is generated from this file. Capability-owned future error codes follow the bounded preservation policy in this contract instead of being rewritten as a shared core code.
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
export type JobErrorCode = "job_queue_timeout" | "job_deadline_exceeded" | "job_rss_limit_exceeded" | "job_scratch_budget_failed" | "job_queue_full" | "job_scratch_path_unsafe" | "job_input_budget_exceeded" | "unsupported_preset" | "capability_unavailable" | "invalid_args" | "unsafe_input_path" | "derived_output_busy" | "derived_output_exists" | "derived_output_stage_invalid" | "output_dir_not_empty" | "frame_lane_refused" | "quality_gate_failed" | "cache_integrity_failed" | "cache_busy" | "segment_store_busy" | "segment_checkpoint_invalid" | "segment_source_changed" | "segmented_final_unsupported" | "segmented_final_failed";

/** What a caller should do about a non-retryable failure. */
export type JobRemedyKind = "change_input" | "free_resources" | "wait" | "grant_permission" | "none";

/** Why a unit of work was deliberately not attempted. */
export type JobSkipCode = "already_satisfied" | "precondition_unmet" | "batch_halted" | "dependency_failed";


export const JOB_LIFECYCLES: readonly JobLifecycle[] = Object.freeze(["pending", "running", "ended"]);
export const JOB_OUTCOMES: readonly JobOutcome[] = Object.freeze(["succeeded", "failed", "cancelled", "skipped"]);
export const JOB_STATES: readonly JobState[] = Object.freeze(["pending", "running", "succeeded", "failed", "cancelled", "skipped"]);

/** The states a job still in flight can occupy. Anything else has already ended. */
export const NON_TERMINAL_JOB_STATES: readonly JobState[] = Object.freeze(["pending", "running"]);

const TERMINAL_LIFECYCLES: ReadonlySet<string> = new Set(["ended"]);
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(["job_queue_timeout", "job_deadline_exceeded", "job_rss_limit_exceeded", "job_scratch_budget_failed", "job_queue_full", "derived_output_busy", "cache_busy", "segment_store_busy", "segmented_final_failed"]);
const REMEDY_BY_ERROR_CODE: Readonly<Record<JobErrorCode, JobRemedyKind>> = Object.freeze({
  "job_queue_timeout": "wait",
  "job_deadline_exceeded": "change_input",
  "job_rss_limit_exceeded": "free_resources",
  "job_scratch_budget_failed": "free_resources",
  "job_queue_full": "wait",
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

/** True while the lifecycle can still transition; false once it has ended. */
export function isJobInFlight(state: string): state is JobState {
  return (NON_TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/** True when lifecycle and outcome are terminal; permitted terminal metadata may still be amended. */
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
  "summary": "The single authored definition of how Motion reports observable job state. The V1 status view carries the callerId, lifecycle/outcome projection, timestamps, warnings, and only fields that the live lease or terminal record actually retains; it never exposes host process identity or invents queue position, ETA, progress, workers, bytes, artifact lists, or receipt lists. Every state vocabulary, shared core error code and agent-facing description in the CLI, SDK, Debug API, MCP transport and documentation is generated from this file. Capability-owned future error codes follow the bounded preservation policy in this contract instead of being rewritten as a shared core code.",
  "designPrinciple": "A state earns its existence only if it changes what the caller does next. Anything that changes only latency or detail is a field, not a state.",
  "axes": {
    "lifecycle": "Answers 'can this still change on its own?'. Three values. This set is frozen: adding to it is a breaking change.",
    "outcome": "Answers 'how did it end?'. Present if and only if lifecycle is 'ended', null otherwise.",
    "state": "A derived projection: lifecycle === 'ended' ? outcome : lifecycle. Generated, never authored, and never accepted as an input. You cancel by jobId; you never set a state."
  },
  "optionalFields": [{"name":"frameLane","lifecycle":["pending","running","ended"],"meaning":"The selected final-video rasterizer, when this route retained one. It is absent for non-final and historical records that did not store a frame lane."},{"name":"planFingerprint","lifecycle":["pending","running","ended"],"meaning":"The immutable V1 render-plan fingerprint, when this job was preflighted and retained with one. Its absence, including on historical records, means unavailable plan identity."},{"name":"startedAtMs","lifecycle":["ended"],"meaning":"The first governed-operation admission time on a terminal record. It is absent when the terminal job never reached admission. It is always present while lifecycle is running."},{"name":"error","lifecycle":["ended"],"outcomes":["failed"],"meaning":"Typed failure detail when the terminal failed record retained it. Historical failed records may lack it; status never manufactures an error object."},{"name":"committed","lifecycle":["ended"],"outcomes":["failed"],"meaning":"Literal true only when irreversible publication occurred or may have occurred. It is failure uncertainty, not successful artifact evidence and never deletion authority; it overrides retryable as a stop-and-reconcile fact. Historical omission remains unavailable data."},{"name":"cancellation","lifecycle":["ended"],"outcomes":["cancelled"],"meaning":"Accepted cancellation detail from a cancelled terminal record, when retained. It is distinct from live cancelRequested intent."},{"name":"skip","lifecycle":["ended"],"outcomes":["skipped"],"meaning":"The reason a terminal record was deliberately skipped, when retained."},{"name":"receiptPath","lifecycle":["ended"],"deprecated":true,"meaning":"Deprecated host-local compatibility linkage: a non-empty string of at most 4096 Unicode code points with no C0 or DEL control character. It may be amended after terminal settlement, is not portable receipt or artifact authority, and must never be used to infer success or to open a local path on another host."},{"name":"receiptId","lifecycle":["ended"],"meaning":"An exact final receipt id when the terminal operation retained one, including when no host-local receiptPath exists."},{"name":"producerEvidence","lifecycle":["ended"],"meaning":"The compact frame-lane and optional producer-schema link retained from an exact final receipt, when present. It is not an artifact list or generic output authority."},{"name":"evidence","lifecycle":["ended"],"meaning":"The optional path-free, validated V1 terminal evidence envelope. It is unavailable for live jobs and historical terminal records that did not retain one."},{"name":"lineage","lifecycle":["ended"],"meaning":"The immutable prior-job/prior-receipt retry lineage when this terminal run was explicitly created as a retry. It is absent for ordinary and historical jobs."}],
  "notPublicFields": [{"name":"pid","meaning":"A live lease's host process identity is internal admission and liveness state. Public job status never exposes it; callers use jobId and callerId across processes."}],
  "lifecycle": [
    {
      "name": "pending",
      "terminal": false,
      "meaning": "Motion accepted the request and is waiting for a concurrency slot. No governed operation belonging to this job has been admitted. This state makes no claim about a worker process, produced bytes, queue position, queue ETA, or progress.",
      "agentAction": "wait",
      "agentGuidance": "Keep waiting and poll no faster than pollAfterMs. Do not estimate a queue position or completion time. cancelRequested may report accepted cancellation intent, but outcome remains null until a terminal record is written.",
      "guaranteed": [
        "schema",
        "jobId",
        "callerId",
        "lane",
        "operation",
        "lifecycle",
        "outcome",
        "state",
        "createdAtMs",
        "cancelRequested",
        "warnings",
        "pollAfterMs"
      ],
      "absent": [
        "startedAtMs",
        "queueWaitMs",
        "endedAtMs",
        "durationMs",
        "error",
        "committed",
        "cancellation",
        "skip",
        "receiptPath",
        "receiptId",
        "producerEvidence",
        "evidence",
        "lineage",
        "pid"
      ],
      "notToBeConfusedWith": [
        {
          "state": "running",
          "because": "pending means no governed operation has been admitted. It is truthful to say the request is waiting, but not to claim rendering, a worker, bytes, a position, or an ETA."
        }
      ]
    },
    {
      "name": "running",
      "terminal": false,
      "meaning": "At least one governed operation belonging to the job was admitted. startedAtMs records that admission; queueWaitMs is the observed wait from acceptance to admission. This state does not expose a worker, byte count, stage, percentage, or ETA.",
      "agentAction": "wait",
      "agentGuidance": "Keep waiting and poll no faster than pollAfterMs. Report only that an admitted governed operation is running; do not derive progress, an ETA, or producer activity from repeated status reads.",
      "guaranteed": [
        "schema",
        "jobId",
        "callerId",
        "lane",
        "operation",
        "lifecycle",
        "outcome",
        "state",
        "createdAtMs",
        "startedAtMs",
        "queueWaitMs",
        "cancelRequested",
        "warnings",
        "pollAfterMs"
      ],
      "absent": [
        "endedAtMs",
        "durationMs",
        "error",
        "committed",
        "cancellation",
        "skip",
        "receiptPath",
        "receiptId",
        "producerEvidence",
        "evidence",
        "lineage",
        "pid"
      ],
      "notToBeConfusedWith": [
        {
          "state": "pending",
          "because": "running means a governed operation was admitted; pending means the request is still waiting for one. Neither state promises a worker, bytes, progress, or an ETA."
        }
      ]
    },
    {
      "name": "ended",
      "terminal": true,
      "meaning": "The terminal lifecycle and outcome will not change again. A later layer may attach receipt linkage without reopening the job. A retained V1 evidence envelope fixes its warnings; only a terminal record without V1 evidence may retain a later warning attachment. Read outcome to learn how the coordinator execution settled. endedAtMs, durationMs, and queueWaitMs are retained status timing, not progress evidence.",
      "agentAction": "read_outcome",
      "agentGuidance": "Stop polling for lifecycle progress because pollAfterMs is absent, not because every status field is frozen. Branch on outcome. A later read may attach receipt linkage without changing lifecycle or outcome. A retained V1 evidence envelope fixes its terminal warnings; warning attachment is only possible when V1 evidence is absent. planFingerprint is optional and identifies the V1 plan only when retained; evidence is optional and returned only from a validated terminal V1 record. Their absence, including on historical records, is unavailable data, not a failure.",
      "guaranteed": [
        "schema",
        "jobId",
        "callerId",
        "lane",
        "operation",
        "lifecycle",
        "outcome",
        "state",
        "createdAtMs",
        "endedAtMs",
        "durationMs",
        "queueWaitMs",
        "cancelRequested",
        "warnings"
      ],
      "absent": [
        "pollAfterMs",
        "pid"
      ],
      "notToBeConfusedWith": []
    }
  ],
  "outcomes": [
    {
      "name": "succeeded",
      "meaning": "The coordinator execution settled successfully. warnings may be non-empty: a warned success is still a success. This outcome is not a universal claim that every declared output was produced, hashed, or attested.",
      "agentAction": "report_success",
      "agentGuidance": "Stop and report the settled outcome and any warnings. Do not infer a root-level artifact or receipt collection from status. If optional terminal evidence is present, treat it as the bounded V1 evidence envelope, not as a generic output authority.",
      "guaranteed": [
        "endedAtMs",
        "durationMs",
        "queueWaitMs",
        "warnings"
      ],
      "absent": [],
      "notToBeConfusedWith": [
        {
          "state": "failed",
          "because": "failed is a different terminal outcome. Switch on outcome; neither status surface invents a root-level artifact or receipt collection."
        },
        {
          "state": "receipt status 'passed'",
          "because": "The historical receipt-status compatibility mapping is a different axis. It does not make succeeded a universal artifact-attestation claim."
        }
      ]
    },
    {
      "name": "failed",
      "meaning": "The coordinator execution settled unsuccessfully for a reason that was neither a cancellation request nor a deliberate skip.",
      "agentAction": "branch_on_retryable",
      "agentGuidance": "If committed is true, stop and reconcile before any retry even when error.retryable is true; it means publication occurred or may have occurred, not that an artifact succeeded, and grants no deletion authority. Otherwise, if error is present, branch on error.retryable and optional retryAfterMs; otherwise report only the settled failed outcome. Status never manufactures either field for historical records.",
      "guaranteed": [
        "endedAtMs",
        "durationMs",
        "queueWaitMs",
        "warnings"
      ],
      "absent": [],
      "notToBeConfusedWith": [
        {
          "state": "cancelled",
          "because": "A host-produced failed record carries failure detail when available; a cancelled record represents accepted cancellation. Do not auto-retry a cancelled outcome."
        }
      ]
    },
    {
      "name": "cancelled",
      "meaning": "A cancel request was accepted and the coordinator execution settled cancelled. It may have settled before admission or after a governed operation had been admitted.",
      "agentAction": "stop_and_explain",
      "agentGuidance": "Stop and explain. Do not auto-retry. If cancellation is present, surface cancellation.reason and cancellation.requestedBy; ask before starting a new job.",
      "guaranteed": [
        "endedAtMs",
        "durationMs",
        "queueWaitMs",
        "warnings"
      ],
      "absent": [],
      "notToBeConfusedWith": [
        {
          "state": "failed",
          "because": "cancelled is an explicit terminal outcome. A retry policy must branch on outcome and never restart it automatically."
        },
        {
          "state": "skipped",
          "because": "cancelled means it was going to run and was stopped. skipped means it was never going to run."
        }
      ]
    },
    {
      "name": "skipped",
      "meaning": "Motion decided this unit of work should not run, and that decision was correct. If startedAtMs is absent, it is the machine-checkable proof that no governed operation was admitted.",
      "agentAction": "report_neutrally",
      "agentGuidance": "Stop and report neutrally. This is not a problem and must not be reported as one. Do not infer prior output authority from status.",
      "guaranteed": [
        "endedAtMs",
        "durationMs",
        "queueWaitMs",
        "warnings"
      ],
      "absent": [],
      "notToBeConfusedWith": [
        {
          "state": "failed",
          "because": "skipped is a neutral terminal outcome, not a failure. When startedAtMs is absent, it proves that no governed operation was admitted."
        }
      ]
    }
  ],
  "queryErrors": [
    {
      "code": "job_unknown",
      "meaning": "No visible live lease or readable terminal record matches this jobId. It is commonly a typo, a wrong caller, or a query against the wrong machine.",
      "agentGuidance": "Stop. Do not report this as a failed job. Ask the user, or re-read the submission response for the real jobId."
    },
    {
      "code": "job_expired",
      "meaning": "A Motion-minted jobId is older than terminal-record retention and no record is readable. This is an age-based retained-state classification, not proof that a particular record once existed.",
      "agentGuidance": "Stop polling this status route. Ask the owning host for any separately retained evidence rather than claiming the job record is available."
    },
    {
      "code": "job_not_visible",
      "meaning": "The record exists but belongs to a different caller, and cross-caller visibility was not granted.",
      "agentGuidance": "Re-query as the owning caller, or ask the host. Deliberately distinct from job_unknown: an agent told 'unknown' for a job that exists will conclude Motion lost it."
    }
  ],
  "errorCodes": [{"code":"job_queue_timeout","retryable":true,"remedy":"wait","meaning":"The job waited for a concurrency slot longer than its queue deadline allowed."},{"code":"job_deadline_exceeded","retryable":true,"remedy":"change_input","meaning":"The job ran longer than its deadline. Retrying an unchanged job will usually hit the same deadline; a smaller job will not."},{"code":"job_rss_limit_exceeded","retryable":true,"remedy":"free_resources","meaning":"The worker's resident memory crossed the governor's ceiling and it was stopped to protect the machine."},{"code":"job_scratch_budget_failed","retryable":true,"remedy":"free_resources","meaning":"Scratch space for intermediate frames could not be reserved."},{"code":"job_queue_full","retryable":true,"remedy":"wait","meaning":"The queue was at capacity when the job was submitted, so it was never admitted."},{"code":"job_scratch_path_unsafe","retryable":false,"remedy":"change_input","meaning":"The requested scratch location resolved outside the permitted roots."},{"code":"job_input_budget_exceeded","retryable":false,"remedy":"change_input","meaning":"The declared inputs exceed what this host will admit; retrying identical inputs cannot help."},{"code":"unsupported_preset","retryable":false,"remedy":"change_input","meaning":"The requested export preset does not exist on this build."},{"code":"capability_unavailable","retryable":false,"remedy":"grant_permission","meaning":"The operation needs a capability this caller's permission tier does not carry."},{"code":"invalid_args","retryable":false,"remedy":"change_input","meaning":"The request did not satisfy the command's argument contract."},{"code":"unsafe_input_path","retryable":false,"remedy":"change_input","meaning":"A final audio input was not a regular package-local WAV, FLAC, MP3, Ogg, or Opus file; M4A/MP4/MOV/Matroska/WebM and reference-capable inputs are refused before FFmpeg starts."},{"code":"derived_output_busy","retryable":true,"remedy":"wait","meaning":"Another final render holds the exact output path's private publication reservation."},{"code":"derived_output_exists","retryable":false,"remedy":"change_input","meaning":"The requested final path already exists; it was preserved rather than overwritten."},{"code":"derived_output_stage_invalid","retryable":false,"remedy":"change_input","meaning":"Private staged output changed or contained an unexpected file before publication."},{"code":"output_dir_not_empty","retryable":false,"remedy":"change_input","meaning":"The output directory already holds files, and overwriting was not requested."},{"code":"frame_lane_refused","retryable":false,"remedy":"change_input","meaning":"The chosen frame lane cannot draw this package faithfully; a different lane can."},{"code":"quality_gate_failed","retryable":false,"remedy":"change_input","meaning":"The delivered artifact did not satisfy the quality manifest it was rendered against."},{"code":"cache_integrity_failed","retryable":false,"remedy":"change_input","meaning":"An opt-in attested-reuse output, descriptor, receipt, or current input did not prove the exact requested identity, so Motion refused to overwrite or rerender it."},{"code":"cache_busy","retryable":true,"remedy":"wait","meaning":"An exact opt-in attested-reuse fill holds its root-local exclusive lock. A stale lock needs host inspection; Motion never breaks it automatically."},{"code":"segment_store_busy","retryable":true,"remedy":"wait","meaning":"Another durable segmented render owns the checkpoint store deterministically derived from this output path. Motion never breaks this lock automatically."},{"code":"segment_checkpoint_invalid","retryable":false,"remedy":"change_input","meaning":"A retained segmented checkpoint, source fingerprint, concat proof, or no-clobber publication proof was invalid, so Motion did not publish the requested output."},{"code":"segment_source_changed","retryable":false,"remedy":"change_input","meaning":"The package changed while durable segmented checkpoints were being produced. Start a fresh render from stable package bytes."},{"code":"segmented_final_unsupported","retryable":false,"remedy":"change_input","meaning":"The selected segmented delivery mode does not support this renderer, preset, workflow, script, or quality contract."},{"code":"segmented_final_failed","retryable":true,"remedy":"wait","meaning":"Segmented delivery stopped without a completed no-clobber publication. Only verified checkpoints, if any, remain for an explicit resume."}],
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
  "receiptMapping": [
    {
      "receiptStatus": "passed",
      "contributesTo": "succeeded",
      "because": "A historical passed receipt maps to the compatible successful outcome; it does not create a current job-status record or universally attest every output."
    },
    {
      "receiptStatus": "warning",
      "contributesTo": "succeeded",
      "because": "A historical warned receipt maps to the compatible successful outcome; warnings remain explicit and this mapping does not create current status evidence."
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
      "ruling": "7 days or 1000 jobs, whichever binds first, then no longer returned by the terminal job-record status route.",
      "because": "Retention bounds the terminal record store and makes job_expired distinguishable from job_unknown. Separately retained evidence is outside this status contract.",
      "status": "provisional-pending-maintainer"
    }
  ]
} as const);
