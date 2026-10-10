<!-- GENERATED FILE — do not edit. Source: schemas/job-status.json. Regenerate: pnpm docs:job-status -->

# Job status — what Motion tells you about work you asked for

The single authored definition of how Motion reports observable job state. The V1 status view carries the callerId, lifecycle/outcome projection, timestamps, warnings, and only fields that the live lease or terminal record actually retains; it never exposes host process identity or invents queue position, ETA, progress, workers, bytes, artifact lists, or receipt lists. Every state vocabulary, shared core error code and agent-facing description in the CLI, SDK, Debug API, MCP transport and documentation is generated from this file. Capability-owned future error codes follow the bounded preservation policy in this contract instead of being rewritten as a shared core code.

**Design principle.** A state earns its existence only if it changes what the caller does next. Anything that changes only latency or detail is a field, not a state.

## The two axes and the one projection

- **`lifecycle`** — Answers 'can this still change on its own?'. Three values. This set is frozen: adding to it is a breaking change.
- **`outcome`** — Answers 'how did it end?'. Present if and only if lifecycle is 'ended', null otherwise.
- **`state`** — A derived projection: lifecycle === 'ended' ? outcome : lifecycle. Generated, never authored, and never accepted as an input. You cancel by jobId; you never set a state.

An agent that only ever reads `state` is correct. An agent that wants a stable
terminality test without enumerating outcomes reads `lifecycle`. They cannot disagree,
because one is computed from the other.

| `state` | terminal | what you should do |
|---|---|---|
| `pending` | no | wait |
| `running` | no | wait |
| `succeeded` | yes | report success |
| `failed` | yes | branch on retryable |
| `cancelled` | yes | stop and explain |
| `skipped` | yes | report neutrally |

## States in full

### lifecycle: `pending`

Motion accepted the request and is waiting for a concurrency slot. No governed operation belonging to this job has been admitted. This state makes no claim about a worker process, produced bytes, queue position, queue ETA, or progress.

- **Terminal:** no
- **You should:** Keep waiting and poll no faster than pollAfterMs. Do not estimate a queue position or completion time. cancelRequested may report accepted cancellation intent, but outcome remains null until a terminal record is written.
- **Always carries:** `schema`, `jobId`, `callerId`, `lane`, `operation`, `lifecycle`, `outcome`, `state`, `createdAtMs`, `cancelRequested`, `warnings`, `pollAfterMs`
- **Never carries:** `startedAtMs`, `queueWaitMs`, `endedAtMs`, `durationMs`, `error`, `committed`, `cancellation`, `skip`, `receiptPath`, `receiptId`, `producerEvidence`, `evidence`, `lineage`, `pid`
- **Not to be confused with running:** pending means no governed operation has been admitted. It is truthful to say the request is waiting, but not to claim rendering, a worker, bytes, a position, or an ETA.

### lifecycle: `running`

At least one governed operation belonging to the job was admitted. startedAtMs records that admission; queueWaitMs is the observed wait from acceptance to admission. This state does not expose a worker, byte count, stage, percentage, or ETA.

- **Terminal:** no
- **You should:** Keep waiting and poll no faster than pollAfterMs. Report only that an admitted governed operation is running; do not derive progress, an ETA, or producer activity from repeated status reads.
- **Always carries:** `schema`, `jobId`, `callerId`, `lane`, `operation`, `lifecycle`, `outcome`, `state`, `createdAtMs`, `startedAtMs`, `queueWaitMs`, `cancelRequested`, `warnings`, `pollAfterMs`
- **Never carries:** `endedAtMs`, `durationMs`, `error`, `committed`, `cancellation`, `skip`, `receiptPath`, `receiptId`, `producerEvidence`, `evidence`, `lineage`, `pid`
- **Not to be confused with pending:** running means a governed operation was admitted; pending means the request is still waiting for one. Neither state promises a worker, bytes, progress, or an ETA.

### lifecycle: `ended`

The terminal lifecycle and outcome will not change again. A later layer may attach receipt linkage without reopening the job. A retained V1 evidence envelope fixes its warnings; only a terminal record without V1 evidence may retain a later warning attachment. Read outcome to learn how the coordinator execution settled. endedAtMs, durationMs, and queueWaitMs are retained status timing, not progress evidence.

- **Terminal:** yes
- **You should:** Stop polling for lifecycle progress because pollAfterMs is absent, not because every status field is frozen. Branch on outcome. A later read may attach receipt linkage without changing lifecycle or outcome. A retained V1 evidence envelope fixes its terminal warnings; warning attachment is only possible when V1 evidence is absent. planFingerprint is optional and identifies the V1 plan only when retained; evidence is optional and returned only from a validated terminal V1 record. Their absence, including on historical records, is unavailable data, not a failure.
- **Always carries:** `schema`, `jobId`, `callerId`, `lane`, `operation`, `lifecycle`, `outcome`, `state`, `createdAtMs`, `endedAtMs`, `durationMs`, `queueWaitMs`, `cancelRequested`, `warnings`
- **Never carries:** `pollAfterMs`, `pid`

### ended + outcome: `succeeded`

The coordinator execution settled successfully. warnings may be non-empty: a warned success is still a success. This outcome is not a universal claim that every declared output was produced, hashed, or attested.

- **Terminal:** yes
- **You should:** Stop and report the settled outcome and any warnings. Do not infer a root-level artifact or receipt collection from status. If optional terminal evidence is present, treat it as the bounded V1 evidence envelope, not as a generic output authority.
- **Always carries:** `endedAtMs`, `durationMs`, `queueWaitMs`, `warnings`
- **Never carries:** —
- **Not to be confused with failed:** failed is a different terminal outcome. Switch on outcome; neither status surface invents a root-level artifact or receipt collection.
- **Not to be confused with receipt status 'passed':** The historical receipt-status compatibility mapping is a different axis. It does not make succeeded a universal artifact-attestation claim.

### ended + outcome: `failed`

The coordinator execution settled unsuccessfully for a reason that was neither a cancellation request nor a deliberate skip.

- **Terminal:** yes
- **You should:** If committed is true, stop and reconcile before any retry even when error.retryable is true; it means publication occurred or may have occurred, not that an artifact succeeded, and grants no deletion authority. Otherwise, if error is present, branch on error.retryable and optional retryAfterMs; otherwise report only the settled failed outcome. Status never manufactures either field for historical records.
- **Always carries:** `endedAtMs`, `durationMs`, `queueWaitMs`, `warnings`
- **Never carries:** —
- **Not to be confused with cancelled:** A host-produced failed record carries failure detail when available; a cancelled record represents accepted cancellation. Do not auto-retry a cancelled outcome.

### ended + outcome: `cancelled`

A cancel request was accepted and the coordinator execution settled cancelled. It may have settled before admission or after a governed operation had been admitted.

- **Terminal:** yes
- **You should:** Stop and explain. Do not auto-retry. If cancellation is present, surface cancellation.reason and cancellation.requestedBy; ask before starting a new job.
- **Always carries:** `endedAtMs`, `durationMs`, `queueWaitMs`, `warnings`
- **Never carries:** —
- **Not to be confused with failed:** cancelled is an explicit terminal outcome. A retry policy must branch on outcome and never restart it automatically.
- **Not to be confused with skipped:** cancelled means it was going to run and was stopped. skipped means it was never going to run.

### ended + outcome: `skipped`

Motion decided this unit of work should not run, and that decision was correct. If startedAtMs is absent, it is the machine-checkable proof that no governed operation was admitted.

- **Terminal:** yes
- **You should:** Stop and report neutrally. This is not a problem and must not be reported as one. Do not infer prior output authority from status.
- **Always carries:** `endedAtMs`, `durationMs`, `queueWaitMs`, `warnings`
- **Never carries:** —
- **Not to be confused with failed:** skipped is a neutral terminal outcome, not a failure. When startedAtMs is absent, it proves that no governed operation was admitted.

## Optional fields and host-local compatibility

These fields appear only when the live lease or terminal record actually retained them. Their absence, including on historical records, means unavailable data; do not synthesize a value from state, timing, or local files.

| field | may appear while | what it truthfully says |
|---|---|---|
| `frameLane` | `pending`, `running`, `ended` | The selected final-video rasterizer, when this route retained one. It is absent for non-final and historical records that did not store a frame lane. |
| `planFingerprint` | `pending`, `running`, `ended` | The immutable V1 render-plan fingerprint, when this job was preflighted and retained with one. Its absence, including on historical records, means unavailable plan identity. |
| `startedAtMs` | `ended` | The first governed-operation admission time on a terminal record. It is absent when the terminal job never reached admission. It is always present while lifecycle is running. |
| `error` | `ended`; only outcome `failed` | Typed failure detail when the terminal failed record retained it. Historical failed records may lack it; status never manufactures an error object. |
| `committed` | `ended`; only outcome `failed` | Literal true only when irreversible publication occurred or may have occurred. It is failure uncertainty, not successful artifact evidence and never deletion authority; it overrides retryable as a stop-and-reconcile fact. Historical omission remains unavailable data. |
| `cancellation` | `ended`; only outcome `cancelled` | Accepted cancellation detail from a cancelled terminal record, when retained. It is distinct from live cancelRequested intent. |
| `skip` | `ended`; only outcome `skipped` | The reason a terminal record was deliberately skipped, when retained. |
| `receiptPath` | `ended` | Deprecated host-local compatibility linkage: a non-empty string of at most 4096 Unicode code points with no C0 or DEL control character. It may be amended after terminal settlement, is not portable receipt or artifact authority, and must never be used to infer success or to open a local path on another host. **Deprecated.** |
| `receiptId` | `ended` | An exact final receipt id when the terminal operation retained one, including when no host-local receiptPath exists. |
| `producerEvidence` | `ended` | The compact frame-lane and optional producer-schema link retained from an exact final receipt, when present. It is not an artifact list or generic output authority. |
| `evidence` | `ended` | The optional path-free, validated V1 terminal evidence envelope. It is unavailable for live jobs and historical terminal records that did not retain one. |
| `lineage` | `ended` | The immutable prior-job/prior-receipt retry lineage when this terminal run was explicitly created as a retry. It is absent for ordinary and historical jobs. |

## Internal-only fields

| field | why it is not public job status |
|---|---|
| `pid` | A live lease's host process identity is internal admission and liveness state. Public job status never exposes it; callers use jobId and callerId across processes. |

## Query errors — asking about a job Motion cannot show you

These are typed errors from the *query*, never job states. A job that does not exist
has no state; saying it "failed" would be a lie about work that never ran.

| code | means | what you should do |
|---|---|---|
| `job_unknown` | No visible live lease or readable terminal record matches this jobId. It is commonly a typo, a wrong caller, or a query against the wrong machine. | Stop. Do not report this as a failed job. Ask the user, or re-read the submission response for the real jobId. |
| `job_expired` | A Motion-minted jobId is older than terminal-record retention and no record is readable. This is an age-based retained-state classification, not proof that a particular record once existed. | Stop polling this status route. Ask the owning host for any separately retained evidence rather than claiming the job record is available. |
| `job_not_visible` | The record exists but belongs to a different caller, and cross-caller visibility was not granted. | Re-query as the owning caller, or ask the host. Deliberately distinct from job_unknown: an agent told 'unknown' for a job that exists will conclude Motion lost it. |

## Failure codes

`retryable` is what separates "try again" from "change approach". For the shared core
codes below it is declared once here, never decided per throw site. Never parse `message`
— it is for humans.

| code | retryable | remedy | means |
|---|---|---|---|
| `job_queue_timeout` | yes | `wait` | The job waited for a concurrency slot longer than its queue deadline allowed. |
| `job_deadline_exceeded` | yes | `change_input` | The job ran longer than its deadline. Retrying an unchanged job will usually hit the same deadline; a smaller job will not. |
| `job_rss_limit_exceeded` | yes | `free_resources` | The worker's resident memory crossed the governor's ceiling and it was stopped to protect the machine. |
| `job_scratch_budget_failed` | yes | `free_resources` | Scratch space for intermediate frames could not be reserved. |
| `job_queue_full` | yes | `wait` | The queue was at capacity when the job was submitted, so it was never admitted. |
| `job_scratch_path_unsafe` | no | `change_input` | The requested scratch location resolved outside the permitted roots. |
| `job_input_budget_exceeded` | no | `change_input` | The declared inputs exceed what this host will admit; retrying identical inputs cannot help. |
| `unsupported_preset` | no | `change_input` | The requested export preset does not exist on this build. |
| `capability_unavailable` | no | `grant_permission` | The operation needs a capability this caller's permission tier does not carry. |
| `invalid_args` | no | `change_input` | The request did not satisfy the command's argument contract. |
| `unsafe_input_path` | no | `change_input` | A final audio input was not a regular package-local WAV, FLAC, MP3, Ogg, or Opus file; M4A/MP4/MOV/Matroska/WebM and reference-capable inputs are refused before FFmpeg starts. |
| `derived_output_busy` | yes | `wait` | Another final render holds the exact output path's private publication reservation. |
| `derived_output_exists` | no | `change_input` | The requested final path already exists; it was preserved rather than overwritten. |
| `derived_output_stage_invalid` | no | `change_input` | Private staged output changed or contained an unexpected file before publication. |
| `output_dir_not_empty` | no | `change_input` | The output directory already holds files, and overwriting was not requested. |
| `frame_lane_refused` | no | `change_input` | The chosen frame lane cannot draw this package faithfully; a different lane can. |
| `quality_gate_failed` | no | `change_input` | The delivered artifact did not satisfy the quality manifest it was rendered against. |
| `cache_integrity_failed` | no | `change_input` | An opt-in attested-reuse output, descriptor, receipt, or current input did not prove the exact requested identity, so Motion refused to overwrite or rerender it. |
| `cache_busy` | yes | `wait` | An exact opt-in attested-reuse fill holds its root-local exclusive lock. A stale lock needs host inspection; Motion never breaks it automatically. |
| `segment_store_busy` | yes | `wait` | Another durable segmented render owns the checkpoint store deterministically derived from this output path. Motion never breaks this lock automatically. |
| `segment_checkpoint_invalid` | no | `change_input` | A retained segmented checkpoint, source fingerprint, concat proof, or no-clobber publication proof was invalid, so Motion did not publish the requested output. |
| `segment_source_changed` | no | `change_input` | The package changed while durable segmented checkpoints were being produced. Start a fresh render from stable package bytes. |
| `segmented_final_unsupported` | no | `change_input` | The selected segmented delivery mode does not support this renderer, preset, workflow, script, or quality contract. |
| `segmented_final_failed` | yes | `wait` | Segmented delivery stopped without a completed no-clobber publication. Only verified checkpoints, if any, remain for an explicit resume. |

### Future capability-owned codes

A newer capability may return or raise a typed code an older consumer does not enumerate. Motion preserves that bounded code, message, retryable flag, optional retryAfterMs, remedy and suggestedAction through events and terminal job state rather than collapsing it to invalid_args or connector_failed. Exception stacks, details and path-bearing text are never terminal job metadata.

- **Bound:** 96 characters matching `^[a-z][a-z0-9_.:-]{0,95}$`.
- **Consumer rule:** Treat the code as an opaque category. Branch on the explicit retryable flag and optional remedy/retryAfterMs fields; never infer policy from an unknown code name or parse its human message.

### Remedies

| kind | means |
|---|---|
| `change_input` | Retrying the same request cannot help. Change the named field to one of the expected values. |
| `free_resources` | The host is out of a resource. Wait for other work to finish, or reduce the size of this job. |
| `wait` | The condition is transient. Retry after retryAfterMs. |
| `grant_permission` | The caller needs a higher permission tier. A human decision, not an automatic one. |
| `none` | No action recovers this specific job. Submitting a fresh one may succeed. |

## Skip codes

| code | means |
|---|---|
| `already_satisfied` | A resume found an attested artifact matching this exact request. The user's goal is already met. |
| `precondition_unmet` | A condition this unit of work depends on was not true, so running it would have been wrong. |
| `batch_halted` | An earlier row in the batch triggered a hard stop, so this row was never attempted. |
| `dependency_failed` | Work this unit depends on did not succeed, so attempting this one would be pointless. |

## Historical receipt-status compatibility

This mapping supports legacy receipt consumers. It does not create a current job-status response,
a root-level receipt collection, a V1 evidence envelope, or universal output attestation.

| receipt `status` | contributes to outcome | why |
|---|---|---|
| `passed` | `succeeded` | A historical passed receipt maps to the compatible successful outcome; it does not create a current job-status record or universally attest every output. |
| `warning` | `succeeded` | A historical warned receipt maps to the compatible successful outcome; warnings remain explicit and this mapping does not create current status evidence. |
| `failed` | `failed` | The operation did not produce what it declared. |
| `not_run` | `skipped` | Nothing was attempted, which is what skipped means. |

Words that must never appear as a job state: `passed`, `not_run`, `ok`, `planned`, `complete`, `done`, `finished`, `error`, `success`.

Words that must never appear as a receipt status: `succeeded`, `cancelled`, `skipped`, `pending`, `running`, `ended`.

## Standing rulings

Decisions this contract depends on. Any marked provisional were taken to keep the
contract shippable and use the reversible option; they are awaiting confirmation.

- **What is Motion's shipped asynchronous render route?** The persistent local coordinator accepts `motion.job.submit` and returns a durable jobId before expensive work starts; `motion.render.final` and the CLI `render` command remain blocking compatibility calls.
  The coordinator owns the submitted worker's AbortSignal, terminal record, and ordered event stream, so its `motion.job.get/list/events/cancel/retry` controls describe the same submitted work. Submission is intentionally limited to ordinary streamed or closed segmented final-video delivery; stills, image sequences, workflows, quality-manifest routes, retained frames, dry runs, and other materialized compatibility paths stay blocking under `motion.render.final`. This is the shipped asynchronous route, not a promise of a future `--async` flag.
- **Where does the runtime job registry live?** Per-user, under the platform's runtime directory. *(provisional)*
  A shared machine-wide location would give true machine-wide truth but needs a permissions model and is a security-boundary decision. The accepted gap is that two different users on one machine can still overcommit it; that gap is documented rather than silently carried.
- **Does a warned success need its own outcome?** No. outcome 'succeeded' with a non-empty warnings array. *(provisional)*
  A fifth outcome forces every client switch to grow for something they would handle identically.
- **How long are terminal job records retained?** 7 days or 1000 jobs, whichever binds first, then no longer returned by the terminal job-record status route. *(provisional)*
  Retention bounds the terminal record store and makes job_expired distinguishable from job_unknown. Separately retained evidence is outside this status contract.
