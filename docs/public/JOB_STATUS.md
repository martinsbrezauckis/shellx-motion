<!-- GENERATED FILE — do not edit. Source: schemas/job-status.json. Regenerate: pnpm docs:job-status -->

# Job status — what Motion tells you about work you asked for

The single authored definition of how Motion reports what is happening with work an agent requested. Every state vocabulary, error code and agent-facing description in the CLI, SDK, Debug API, MCP transport and documentation is generated from this file. Nothing else states the contract.

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

Motion has accepted the request, validated its arguments, minted a jobId, and is waiting for a concurrency slot. No process has been spawned and no bytes have been written.

- **Terminal:** no
- **You should:** Keep waiting. To tell the user how long, read queue.position and queue.aheadEstimatedMs. A cancel here is free and immediate.
- **Always carries:** `jobId`, `operation`, `caller`, `createdAt`, `truth`, `queue`, `cancelRequested`
- **Never carries:** `startedAt`, `progress`, `error`, `endedAt`, `artifacts`
- **Not to be confused with running:** In pending nothing is being produced, so a user-facing 'rendering...' message is a lie. Say 'waiting for a slot (3 ahead)' instead.

### lifecycle: `running`

The job was admitted, resources are committed, and at least one worker process has been spawned and is being monitored by the governor.

- **Terminal:** no
- **You should:** Keep waiting, and answer 'how long' from progress. Poll no faster than pollAfterMs. Check progress.updatedAt for staleness: if now minus progress.updatedAt exceeds three times progress.heartbeatMs, tell the user 'no progress for N seconds' rather than 'still working'.
- **Always carries:** `jobId`, `operation`, `caller`, `createdAt`, `truth`, `cancelRequested`, `startedAt`, `progress`
- **Never carries:** `outcome`, `error`, `endedAt`
- **Not to be confused with pending:** running means bytes are being produced; pending means a slot is being waited for.

### lifecycle: `ended`

The job will not change again. Read outcome to learn how it ended.

- **Terminal:** yes
- **You should:** Branch on outcome. Never infer success from the presence of an artifact path.
- **Always carries:** `jobId`, `operation`, `caller`, `createdAt`, `truth`, `outcome`, `endedAt`
- **Never carries:** `queue`

### ended + outcome: `succeeded`

The work completed and every declared output was produced, hashed and attested. warnings may be non-empty: a warned success is still a success.

- **Terminal:** yes
- **You should:** Stop and report success, handing back artifacts[].path. If warnings is non-empty, surface it: the artifact exists but something about it was not what was asked for.
- **Always carries:** `endedAt`, `durationMs`, `artifacts`, `receipts`, `warnings`
- **Never carries:** `error`
- **Not to be confused with failed:** A non-empty artifacts array does not imply success: a failed encode can leave a truncated file behind. Switch on outcome, never on the presence of a path.
- **Not to be confused with receipt status 'passed':** Job outcome and receipt status are different axes. A job can succeed while carrying a receipt whose status is 'warning'.

### ended + outcome: `failed`

The job was admitted or started, and stopped for a reason that was neither a cancellation request nor a deliberate skip.

- **Terminal:** yes
- **You should:** Read error.retryable. When true, retry after error.retryAfterMs if present. When false, use error.remedy to change approach, or error.message to explain to the user why this cannot work.
- **Always carries:** `endedAt`, `durationMs`, `error`
- **Never carries:** —
- **Not to be confused with cancelled:** failed always carries error; cancelled never does. An agent may auto-retry a failed job. Auto-retrying a cancelled one overrides a human's explicit instruction.

### ended + outcome: `cancelled`

A cancel request was accepted and the work stopped. It may have stopped from pending, in which case nothing ran, or from running, in which case partial output may exist.

- **Terminal:** yes
- **You should:** Stop and explain. Do not auto-retry. Surface cancellation.reason and cancellation.requestedBy to the user, and ask before restarting.
- **Always carries:** `endedAt`, `cancellation`
- **Never carries:** `error`
- **Not to be confused with failed:** The absence of error is the load-bearing invariant of this contract. An agent whose retry policy is 'if (job.error?.retryable) retry()' must be structurally incapable of restarting something a human stopped.
- **Not to be confused with skipped:** cancelled means it was going to run and was stopped. skipped means it was never going to run.

### ended + outcome: `skipped`

Motion decided this unit of work should not run, and that decision was correct.

- **Terminal:** yes
- **You should:** Stop and report neutrally. This is not a problem and must not be reported as one. For already_satisfied the artifact from the prior run is referenced in artifacts, so the user's request is satisfied.
- **Always carries:** `endedAt`, `skip`
- **Never carries:** `error`, `startedAt`, `durationMs`
- **Not to be confused with failed:** A resumed batch of 100 rows where 97 were already done reports 97 skipped and 3 succeeded. Reporting those 97 as failures is how a working resume looks broken. startedAt being absent is the machine-checkable proof that nothing ran.

## Query errors — asking about a job Motion cannot show you

These are typed errors from the *query*, never job states. A job that does not exist
has no state; saying it "failed" would be a lie about work that never ran.

| code | means | what you should do |
|---|---|---|
| `job_unknown` | No record, and no receipt carrying this jobId. Almost always a typo or a query against the wrong machine. | Stop. Do not report this as a failed job. Ask the user, or re-read the submission response for the real jobId. |
| `job_expired` | The record existed but was pruned by retention. The receipt may still resolve. | Fall back to the receipt index. If that is also gone, report that the evidence is no longer retained. |
| `job_not_visible` | The record exists but belongs to a different caller, and cross-caller visibility was not granted. | Re-query as the owning caller, or ask the host. Deliberately distinct from job_unknown: an agent told 'unknown' for a job that exists will conclude Motion lost it. |

## Failure codes

`retryable` is what separates "try again" from "change approach". It is a property of
the code, declared once here, never decided per throw site. Never parse `message` — it
is for humans.

| code | retryable | remedy | means |
|---|---|---|---|
| `job_queue_timeout` | yes | `wait` | The job waited for a concurrency slot longer than its queue deadline allowed. |
| `job_deadline_exceeded` | yes | `change_input` | The job ran longer than its deadline. Retrying an unchanged job will usually hit the same deadline; a smaller job will not. |
| `job_rss_limit_exceeded` | yes | `free_resources` | The worker's resident memory crossed the governor's ceiling and it was stopped to protect the machine. |
| `job_scratch_budget_failed` | yes | `free_resources` | Scratch space for intermediate frames could not be reserved. |
| `job_queue_full` | yes | `wait` | The queue was at capacity when the job was submitted, so it was never admitted. |
| `job_abandoned` | yes | `none` | The process that owned this job disappeared without writing a terminal record. Recorded by the reaper, not by the worker. |
| `job_scratch_path_unsafe` | no | `change_input` | The requested scratch location resolved outside the permitted roots. |
| `job_input_budget_exceeded` | no | `change_input` | The declared inputs exceed what this host will admit; retrying identical inputs cannot help. |
| `unsupported_preset` | no | `change_input` | The requested export preset does not exist on this build. |
| `capability_unavailable` | no | `grant_permission` | The operation needs a capability this caller's permission tier does not carry. |
| `invalid_args` | no | `change_input` | The request did not satisfy the command's argument contract. |
| `output_dir_not_empty` | no | `change_input` | The output directory already holds files, and overwriting was not requested. |
| `frame_lane_refused` | no | `change_input` | The chosen frame lane cannot draw this package faithfully; a different lane can. |
| `quality_gate_failed` | no | `change_input` | The delivered artifact did not satisfy the quality manifest it was rendered against. |

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

## Progress stages

A stage is progress detail, never a state: it answers "how long", not "what should I do".

| lane | stages |
|---|---|
| `ffmpeg` | `preparing` → `encoding` → `verifying` → `writing` |
| `browser` | `launching` → `loading` → `drawing` → `closing` |
| `native` | `loading` → `drawing` → `writing` |
| `batch` | `expanding` → `rendering` → `attesting` |

## Job status is not receipt status

A receipt attests one operation's evidence. A job describes the caller's request.
They are kept as separate axes on purpose, and this is the only sanctioned mapping:

| receipt `status` | contributes to outcome | why |
|---|---|---|
| `passed` | `succeeded` | The operation produced what it declared. |
| `warning` | `succeeded` | A warned success is still a success. The warning travels in warnings[], not in the outcome. |
| `failed` | `failed` | The operation did not produce what it declared. |
| `not_run` | `skipped` | Nothing was attempted, which is what skipped means. |

Words that must never appear as a job state: `passed`, `not_run`, `ok`, `planned`, `complete`, `done`, `finished`, `error`, `success`.

Words that must never appear as a receipt status: `succeeded`, `cancelled`, `skipped`, `pending`, `running`, `ended`.

## Standing rulings

Decisions this contract depends on. Any marked provisional were taken to keep the
contract shippable and use the reversible option; they are awaiting confirmation.

- **Should render ever gain an opt-in asynchronous mode?** Open. Render blocks, and there is no --async flag to opt out of that. *(provisional)*
  Blocking is what ships, and it keeps every existing script and connector working. The cost is real: a caller that wants to start a render and return immediately cannot, and a render in flight is observable only from a second process, through the job registry. An opt-in flag is the reversible way to close that gap if it ever needs closing, which is why the option is recorded here instead of dropped. Treat it as an open question, not a commitment: do not build against a flag that does not exist.
- **Where does the runtime job registry live?** Per-user, under the platform's runtime directory. *(provisional)*
  A shared machine-wide location would give true machine-wide truth but needs a permissions model and is a security-boundary decision. The accepted gap is that two different users on one machine can still overcommit it; that gap is documented rather than silently carried.
- **Does a warned success need its own outcome?** No. outcome 'succeeded' with a non-empty warnings array. *(provisional)*
  A fifth outcome forces every client switch to grow for something they would handle identically.
- **How long are terminal job records retained?** 7 days or 1000 jobs, whichever binds first, then pruned to receipts only. *(provisional)*
  Retention is what makes job_expired distinguishable from job_unknown. The contract needs a number more than it needs a particular number.
