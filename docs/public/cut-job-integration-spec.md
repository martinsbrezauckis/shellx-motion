# Cut ↔ Motion job integration — implementation spec

**For:** developers integrating the Motion job surface into ShellX Cut.
**Current source status:** the persistent local coordinator, render and generic connector
submit/control/event surfaces, visibility, retention, connector binding journal and receipt-lineage
contracts described here are implemented. Focused source contract tests cover the Motion side;
Cut/Design Studio process-pair and packed/native acceptance remain host work.

This document describes the nine integration requirements and the corresponding Cut-side work.
Runtime behavior is backed by the tests named in the final section.

---

## Integration contract

| # | Cut's requirement | Status |
|---|---|---|
| 1 | Registered discovery/submit/query/control/event actions | **Available.** `motion.connector.catalog`, `motion.job.submit`, `motion.connector.submit`, and `motion.job.get/list/events/cancel/retry` share the command registry and generated schema. |
| 2 | CLI commands | **Query available.** One-shot CLI renders remain signal-owned by their process; asynchronous control requires the persistent local coordinator. |
| 3 | Debug API dispatch | **Available for streamed final-video and admitted generic connector jobs.** Submit, query, control and events share one coordinator; materialized compatibility renders use blocking `motion.render.final`. |
| 4 | MCP tools | **Discoverable.** `motion_connector_catalog`, `motion_job_submit`, `motion_connector_submit`, and `motion_job_get/list/events/cancel/retry`; generic connector submit refuses with `capability_unavailable` until its resolver and journal are configured. |
| 5 | One consistent jobId across lease, handoff, evidence and receipt | **Enforced.** See "Job identity" below. |
| 6 | Non-blocking handoff returning a jobId before rendering completes | **Available.** `motion.job.submit` returns the persisted id before expensive work starts. |
| 7 | Own-caller visibility by default, operator-only cross-caller | **Enforced** in the store rather than filtered at the surface. |
| 8 | Terminal-state lookup after the lease disappears | **Available**, with a 7-day / 1000-job retention. |
| 9 | End-to-end tests with Cut and Design Studio running simultaneously | **Pending host acceptance.** Motion has focused coordinator and MCP contract coverage, not a Cut/Design Studio process-pair run. |

### Job identity

A single job id names the live record, resource evidence, terminal record, and associated receipt.
Integrations must preserve that exact id across the whole operation.

---

## The concurrency model

**Cut submits to the persistent local coordinator.** It can supply a stable id or use the returned
Motion-minted id:

```jsonc
{ "command": "motion.job.submit",
  "args": { "packageRoot": "…", "outputPath": "…", "preset": "mp4-h264",
            "jobId": "cut:render-42" } }
```

The response contains `cut:render-42` before the coordinator starts expensive work. From that
instant same-owner processes can query events, request cancellation, or observe the terminal result.

The coordinator is the supervised local owner for this explicit API. It persists state/events and
holds the real AbortSignal for its streamed producer/FFmpeg worker. Render submission rejects
workflow, quality-manifest, retained-frame, dry-run, still, image-sequence, and other materialized
routes, which remain blocking compatibility renders. It does not resurrect an interrupted worker
after a server restart. Ordinary render replay callbacks remain process/session-owned, so their
`motion.job.retry` returns `job_not_retryable` after restart and Cut must submit a new linked run
explicitly. Admitted connector jobs have the narrower durable-binding exception described below:
only an explicit retry of a terminal retryable failure may reconstruct execution.

If Cut omits `jobId`, Motion mints one and returns it before expensive work starts. A Cut-supplied
id is still recommended when the host must correlate UI state before the submit response or recover
that correlation after its own process interruption. `jobId` is caller-facing rather than globally
unique: durable records, events, retry state and connector bindings are keyed by the authenticated
caller plus that id. Two callers may therefore use the same text without replacing or blocking each
other, while same-caller reuse retains the existing terminal-replacement semantics.

### Generic connector jobs: one Cut adapter, not one adapter per feature

Cut implements this sequence once:

1. Call `runtime-probe`, negotiate catalog/job protocol v2, then read and validate CLI
   `connector catalog` or the equivalent Debug/MCP `motion.connector.catalog`. CLI
   `connector describe <id>` remains a convenience projection; a pure Debug/MCP client needs no
   capability-specific route because the catalog contains every descriptor.
2. Select only a descriptor whose invocation is `admitted`; generate its closed request from the
   advertised field types. Branch on request-field and output-role classes, never the capability id.
3. Mint caller-scoped opaque handles for host-selected input and output locations. Keep the handle
   mapping in trusted Cut host state; never send a path or URL in the connector request.
4. Submit the exact discovered capability id, descriptor revision/fingerprint, request-schema id
   and request to `motion.connector.submit`.
5. Drive progress, cancellation and explicit retry through the descriptor's advertised
   `motion.job.*` controls and validate terminal artifacts by their advertised roles/schemas.

The Motion host context must be configured once with a stable authenticated `callerId`, a
`connectorJobReferences` resolver scoped to that caller, and a
`MotionConnectorJobBindingJournal` stored beside the coordinator. The MCP tool stays discoverable
without those authorities but fails closed before queueing. The journal contains the exact
descriptor and opaque/scalar request, never resolved paths, executors or callbacks. The resolver
receives the authenticated caller id on every handle resolution; an explicit retry uses the owner
retained in its journal binding rather than a caller-nominated substitute.

This is the zero-feature-patch boundary: if a later Motion render or scene-orchestration capability
uses the same catalog major, safe request-field subset, caller/reference authority, job controls and
artifact/receipt/import-plan roles, Motion adds its descriptor and executor and Cut code stays
unchanged. Cut changes only for a protocol major or a new interaction, trust, permission,
editor-operation or artifact class.

Descriptor drift is a refusal, not an implicit upgrade. Cut should rediscover and submit a new job.
`motion.job.retry` is an explicit new run with lineage. Following a host restart it can reconstruct
only a terminal retryable failed connector binding and re-resolve the opaque handles; it never
automatically re-executes an interrupted pending/running job, and cancellation is never retryable.

### One render is one job

A single render performs several governed operations internally — a browser frame pass, ffmpeg
capability probes, encodes. Those take capacity but are **not** reported. Cut asked for one render
and sees one job. `motion.job.list` will never show `ffmpeg.version`.

---

## What Cut has to build

### 1. A stable caller id, one per workspace (CLI/direct hosts)

```
--caller-id cut:workspace-7        (CLI)
context.callerId = "cut:workspace-7"   (trusted direct SDK / HTTP host config)
```

MCP and WebSocket clients do not nominate that value: the authenticated server mints their
connection principal. Direct coordinator integration must configure the trusted `callerId` before
submission; putting one in a request object is not an ownership mechanism.

Requirements:
- **Stable across processes for CLI/direct hosts.** A fresh Cut process must recognise work its
  predecessor started, so a pid or a per-connection session id is wrong. MCP/WebSocket ownership
  is instead bound to the server-minted connection principal.
- **One per workspace**, because that is the granularity at which Cut's own agents should see each
  other's work.

The caller id used for the query **must match** the one used for the render, or Cut will correctly
get `job_not_visible`. This is the single most likely integration bug; the CLI's `suggestedAction`
names the id it queried with, precisely so it is diagnosable.

### 2. A job id per render

Any string of 1–128 characters from `[A-Za-z0-9._:-]`. `cut:render-<uuid>` is a good shape.

Rejected — not sanitised — if it contains anything else, because two ids that differed only in
rejected characters would collapse onto one record file and overwrite each other's evidence.

### 3. A poll loop

```jsonc
{ "command": "motion.job.get", "args": { "jobId": "cut:render-42" } }
```

Success shape:

```jsonc
{ "ok": true,
  "result": { "ok": true, "job": {
    "jobId": "cut:render-42",
    "callerId": "cut:workspace-7",
    "lifecycle": "running",          // pending | running | ended
    "outcome": null,                  // null until ended
    "state": "running",               // the token to switch on
    "lane": "ffmpeg",
    "operation": "render.final",
    "createdAtMs": 1785681391000,
    "startedAtMs": 1785681391004,
    "queueWaitMs": 0,
    "pid": 48122,
    "warnings": [],
    "pollAfterMs": 2000               // absent once ended — stop polling
  } } }
```

Rules:
- **Switch on `state`.** Six values: `pending`, `running`, `succeeded`, `failed`, `cancelled`,
  `skipped`. It is `outcome` once ended and `lifecycle` before that.
- **Never send `state` as an input.** You cancel by id; you never set a state.
- **Stop when `pollAfterMs` is absent.** That is the machine-readable "this will not change again".
- **Poll no faster than `pollAfterMs`** (2000 ms by default).
- **`cancelled` never carries `error`; `failed` always does.** So a retry policy shaped like
  `if (job.error?.retryable) retry()` is structurally incapable of restarting work a human stopped.
  Please keep that shape.
- **Preserve unknown typed failure codes.** Shared Core codes have the retry/remedy policy documented
  in `JOB_STATUS.md`. A newer capability may return or raise a bounded code an older Cut build has never
  enumerated; keep its `code`, `message`, `retryable`, optional `remedy`, `retryAfterMs`, and
  `suggestedAction` unchanged. Motion never includes exception stacks, detail objects, or
  path-bearing text in that metadata. Branch on the metadata, not on a feature-specific code switch,
  and never rewrite an unknown code to `invalid_args` or `connector_failed`.
- **Never infer success from an artifact path.** A failed encode can leave a truncated file.

### 4. Handle the three query errors distinctly

They describe the *query*, never the job. Collapsing them into "not found" is what makes an agent
conclude Motion lost the work.

| code | means | Cut should |
|---|---|---|
| `job_unknown` | No such id here. | Stop. Re-read the id. **Do not** report a failed render. |
| `job_expired` | It ran; the record aged out (7 days / 1000 jobs). | Fall back to the receipt index. |
| `job_not_visible` | Exists, belongs to another caller. | Re-query with the caller id that started it. |

### 5. Render `pending` distinctly from `running`

A job is `pending` from submission until the machine admits its first unit of work. On a busy
machine — Cut and Design Studio both rendering, default cap of 2 — that is a real and visible
period during which **nothing is being produced**.

- `pending` → "waiting for a slot". Do **not** say "rendering…".
- `running` → work is actually happening.
- `startedAtMs` is **absent while pending**. If you want one test rather than a state comparison,
  use that: its absence means nothing has begun.
- After the job ends, `queueWaitMs` is how much of the total was queueing, so Cut can report
  "queued 14s, rendered 42s".
- A job that failed while still queued carries **no** `startedAtMs`. It never ran — reporting it as
  a failed render would be wrong; it is a capacity problem.

The coordinator test covers cancellation and retry lineage; a Cut/Design Studio concurrent-render
acceptance run remains required before making a measured cross-host performance claim.

---

## Visibility is a boundary, not a filter

Cut and Design Studio share one machine and one capacity pool. They do **not** share evidence.

- A query is answered as the caller that asked. Cut cannot name Design Studio's caller id to read
  its jobs.
- `scope: "all"` exists for an operator console and is **refused** unless the host started the
  Motion debug server with `context.crossCallerJobScope: true`. An embedded agent cannot grant
  itself this.
- Scheduling stays global: every job competes for the machine-wide cap regardless of owner.

The Motion-side visibility tests cover caller separation. A two-host process-pair acceptance run is
still required for Cut and Design Studio integration sign-off.

---

## Worked example — the CLI path

This is the exact sequence, run against a real engine:

```bash
# 1. Cut starts a render in a child process; it already knows the handle.
shellx-motion render ./pkg --out out.mp4 --lane ffmpeg --frame-lane browser \
  --job-id cut:render-42 --caller-id cut:workspace-7 &

# 2. From any other process, while it runs:
shellx-motion job get cut:render-42 --caller-id cut:workspace-7
# → { "ok": true, "command": "job.get", "job": {
#       "state": "running", "lifecycle": "running", "lane": "browser",
#       "operation": "render.final", "callerId": "cut:workspace-7", "pollAfterMs": 2000 } }

# 3. Another host asking for the same id:
shellx-motion job get cut:render-42 --caller-id design-studio:main
# → { "ok": false, "error": { "code": "job_not_visible",
#       "suggestedAction": "This job belongs to another caller. Re-run with the --caller-id
#                           the render used; this query used \"design-studio:main\"." } }

# 4. After the render process has exited — the lease is gone, the record is not:
shellx-motion job get cut:render-42 --caller-id cut:workspace-7
# → { "job": { "state": "succeeded", "lifecycle": "ended", "outcome": "succeeded",
#              "durationMs": 114328, "queueWaitMs": 1 } }

# 5. Listing:
shellx-motion job list --caller-id cut:workspace-7 --limit 20
# → { "jobCount": 1, "inFlightCount": 0,
#     "stateCounts": { "pending": 0, "running": 0, "succeeded": 1, "failed": 0,
#                      "cancelled": 0, "skipped": 0 }, "jobs": [ … ] }
```

## Worked example — MCP

Tool names are the command with dots replaced by underscores:

```
motion_job_get     { "args": { "jobId": "cut:render-42" } }
motion_job_list    { "args": { "limit": 20 } }
motion_job_events  { "args": { "jobId": "cut:render-42" } }
motion_job_cancel  { "args": { "jobId": "cut:render-42", "reason": "operator stopped export" } }
motion_job_retry   { "args": { "jobId": "cut:failed-42" } }
motion_job_submit  { "args": { …, "jobId": "cut:render-42" } }
```

The caller id comes from the server's context (`context.callerId`), or is derived from the observed
transport as `${transport}:${label}` when the host supplies none. **Set it explicitly** — the
derived value is stable but not meaningful to Cut.

---

## When rendering fails because FFmpeg is missing

Motion shells out to FFmpeg for every final encode and does not ship it. When it is absent, Cut
gets `ffmpeg_not_configured`. That error now carries everything needed to fix it rather than a raw
`spawn ffmpeg ENOENT`:

```jsonc
{ "ok": false,
  "error": {
    "code": "ffmpeg_not_configured",
    "message": "FFmpeg is not installed, or is not on this machine's PATH. Motion needs it to encode video (it was looking for \"ffmpeg\").",
    "suggestedAction": "Install FFmpeg (winget: winget install --id Gyan.FFmpeg -e), or set SHELLX_MOTION_FFMPEG to an existing ffmpeg binary…",
    "detail": "spawn ffmpeg ENOENT",
    "requirement": {
      "tool": "ffmpeg", "present": false,
      "requiredFor": "Encoding final video (`--lane ffmpeg`). Preview frames and the native lane work without it.",
      "installOptions": [ { "via": "winget", "command": "winget install --id Gyan.FFmpeg -e" }, … ],
      "downloadUrl": "https://ffmpeg.org/download.html",
      "overrideEnvVar": "SHELLX_MOTION_FFMPEG"
    } } }
```

**Ask before you render, not after.** `motion.platform.requirements` (MCP: `motion_platform_requirements`,
CLI: `shellx-motion doctor --json`) is ONE shared result — the two surfaces return the same object, not two
descriptions of it — so Cut can check once at startup and offer the install command as a button
rather than surfacing a failed render.

```jsonc
{ "ok": true,                       // the PROBE ran. Not "the machine is ready".
  "result": {
    "satisfied": false,             // the CAPABILITY answer Cut branches on.
    "missingCount": 1,
    "requirements": [ /* tools, unchanged field name */ ],
    "platform": {
      "schema": "shellx-motion/platform-requirements@1",
      "ok": true, "satisfied": false, "missingCount": 1,
      "capacity": {
        "source": "host-adaptive",
        "jobs": { "maxConcurrentJobs": 2, "maxProcessTreeRssBytes": 18790481920 },
        "points": { "tier": "maximum", "portablePointsPerLayer": 8192, "maxPointsPerLayer": 65536 }
      },
      "tools": [
        { "tool": "ffmpeg", "status": "ready", "present": true,
          "source": "path", "executable": "ffmpeg",
          "version": "ffmpeg version 6.1.1 …",
          "requiredFor": "Encoding final video (`--lane ffmpeg`). Preview frames and the native lane work without it.",
          "requiredForOperations": ["render.final"],
          "installOptions": [ … ], "downloadUrl": "…", "overrideEnvVar": "SHELLX_MOTION_FFMPEG" },
        { "tool": "ffprobe", "status": "missing", "present": false,
          "source": "path", "executable": "ffprobe",
          "problem": "FFprobe is not installed, or is not on this machine's PATH. …",
          "detail": "spawn ffprobe ENOENT",
          "requiredForOperations": ["quality.check"], "overrideEnvVar": "SHELLX_MOTION_FFPROBE", … },
        { "tool": "chromium", "status": "ready", "present": true,
          "source": "path", "executable": "chrome",
          "version": "Google Chrome for Testing 141.0.7390.54",
          "requiredFor": "Rasterizing frames for the DEFAULT frame lane (`render --frame-lane browser`) …",
          "requiredForOperations": ["render.final"], "overrideEnvVar": "SHELLX_MOTION_BROWSER", … }
      ],
      "operations": [
        { "operation": "preview.frame", "satisfied": true,  "blockedBy": [], "possible": true },
        { "operation": "render.final",  "satisfied": true,  "blockedBy": [], "possible": true },
        { "operation": "quality.check", "satisfied": false, "blockedBy": ["ffprobe"], "possible": false }
      ] } } }
```

On the same machine with no browser installed, `render.final` reports the lane-dependent shape
instead — blocked for the default invocation, still possible by a named route:

```jsonc
{ "operation": "render.final",
  "satisfied": false,             // a plain `render` WILL fail here
  "blockedBy": ["chromium"],
  "possible": true,               // but the machine can still produce final media
  "alternative": {
    "flag": "--frame-lane native",
    "avoids": ["chromium"],
    "packageDependent": true,     // may still refuse for a given document
    "tradeoff": "…" } }
```

Read it this way:

- **`ok` vs `satisfied` are different questions.** `ok` says the probe ran; `satisfied` says the
  machine is ready. A missing binary is a successful report, not a failed command.
- **`status` distinguishes `ready` / `missing` / `broken` / `unverified`.** Offer an install command
  for `missing`; for `broken` the binary exists and reinstalling is usually the wrong advice —
  `detail` carries the raw error.
- **Ask about the operation you are about to attempt.** Pass `{ "operation": "render.final" }`
  (CLI: `shellx-motion doctor --operation render.final`) and `satisfied` is scoped to it, so a missing
  FFprobe does not read as "cannot render" when it only means the quality check will not run.
- **FFprobe is modelled separately from FFmpeg.** Encoding needs FFmpeg; reading the encode back —
  container facts, stream inventory, durations — needs FFprobe. A machine can do the first and not
  the second, and Cut should say so rather than showing one red light.
- **`satisfied` is about the DEFAULT invocation; `possible` is about the machine.** `render.final`
  needs FFmpeg by every route and Chromium only for the default browser frame lane, so a browser-less
  machine is `satisfied: false` — a plain `render` there really does fail — with `possible: true` and
  an `alternative` naming `--frame-lane native`. Branch on `satisfied` to decide whether to offer the
  render; read `alternative` to offer the other route. `packageDependent: true` means that route can
  still refuse for a given document (the native lane has no font rasterizer and rejects lowercase or
  font-family text with `native_text_not_deliverable`), so present it as a thing to try, not a fix.
  `possible: false` is the only state that means "nothing can run this until something is installed".
- **Chromium is never resolved from `PATH`**, unlike the codec tools: Motion checks
  `SHELLX_MOTION_BROWSER`, then Playwright's browser cache, then well-known system installs, because
  those are the paths the renderer itself will launch from. Two of those steps can REFUSE rather
  than fall through, and a host surfacing this result should pass the wording on rather than
  flattening it to "not found": a `SHELLX_MOTION_BROWSER` that is relative or names nothing comes
  back as `status: "broken"`, `source: "override"` with a `problem` naming the rejected value and no
  substitute browser; and a Playwright cache whose root, build/layout components, or executable leaf
  is non-canonical, not user/root-owned, or group/world-writable (or whose entry name is not
  `chromium-<build number>`) contributes nothing and is named in `problem`.

`detail` keeps the probe error, which distinguishes *missing* from *installed but broken* — the
message only claims "not installed" when the underlying error actually looks like an absent binary
(a present binary whose shared libraries are absent is `broken`, not `missing`, even though its
error says "No such file or directory"). Absolute paths in `detail` are replaced with `<path>` and
control characters are stripped, for the same reason `executable` is a basename: this object is
shared evidence. The one field that may name a path is `problem`, and only when the path is a value
the operator themselves set.

---

## Where the state lives

Per-user, under the platform runtime directory:

- Live jobs — `$XDG_RUNTIME_DIR/shellx-motion/job-leases` (or `%LOCALAPPDATA%`, or a per-user temp
  path). Overridable with `SHELLX_MOTION_LEASE_ROOT`.
- Finished jobs — `.../job-records`. Overridable with `SHELLX_MOTION_JOB_RECORD_ROOT`.

Both are best-effort: if the directory cannot be written, rendering still works and reporting
degrades. A host with a read-only runtime directory renders fine and answers `job_unknown`.

**Known scope limit:** per-user, not per-machine. Two different OS users can each get the full
concurrency allowance. Closing that needs a shared location with a permissions model, which is a
security decision, so it is documented rather than silently carried.

---

## Retention

7 days or 1000 jobs, whichever binds first. After that a job answers `job_expired` rather than
`job_unknown`, so Cut can tell "aged out, look at receipts" from "never existed".

That distinction works exactly when Motion minted the id, because Motion-minted ids embed their
mint time. **A Cut-supplied id carries no timestamp**, so an expired Cut-named job answers
`job_unknown`. If that distinction matters to Cut, include a sortable timestamp in the id and
compare it against the retention window yourself.

---

## What has NOT changed

- Receipt ids are formed exactly as before. Cut derives and validates
  `expected_cut_plan_receipt_id`, and nothing here touches that.
- On Linux, `motion.render.status` and `motion.render.queue` still read receipt files through the
  stable-reader capability, and they still cannot see running work. macOS and Windows return
  `capability_unavailable` before receipt-state access; `motion.job.*` is the portable live route.
- The editable-import receiver contract is unchanged.

---

## Tests Motion runs for this, so Cut can rely on it

- `packages/core/src/job-registry.test.ts` — 21 tests: id unification, terminal lookup, expiry vs
  unknown, the owner boundary, retention bounds, and that a host job never consumes capacity.
- `packages/debug-server/src/mcp-job-query.test.ts` — 9 tests over a real HTTP server: tool
  presence, cross-caller refusal, typed query errors, natural-language routing.
- `packages/cli/src/job-two-hosts.test.ts` — 3 tests with **two real OS processes** standing in for
  Cut and Design Studio: each watches its own render, neither sees the other's, the outcome survives
  process exit, and the cap holds across both.
