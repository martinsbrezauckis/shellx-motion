# Cut ↔ Motion job integration — implementation spec

**For:** developers integrating the Motion job surface into ShellX Cut.
**Status in Motion 0.1.0:** the job-query, visibility, retention, and receipt contracts described
here are implemented and covered by the repository test suite.

This document describes the nine integration requirements and the corresponding Cut-side work.
Runtime behavior is backed by the tests named in the final section.

---

## Integration contract

| # | Cut's requirement | Status |
|---|---|---|
| 1 | Registered `motion.job.get` / `motion.job.list` actions | **Available.** In the command registry, the actions catalog, and `schemas/debug.json`. |
| 2 | CLI commands | **Available.** `shellx-motion job get <jobId>`, `shellx-motion job list`. |
| 3 | Debug API dispatch | **Available.** Both route through the `render` domain. |
| 4 | MCP tools | **Available.** `motion_job_get`, `motion_job_list`. |
| 5 | One consistent jobId across lease, handoff, evidence and receipt | **Enforced.** See "Job identity" below. |
| 6 | Non-blocking handoff returning a jobId before rendering completes | **Supported by caller-assigned identity.** Cut supplies the id before starting the render. |
| 7 | Own-caller visibility by default, operator-only cross-caller | **Enforced** in the store rather than filtered at the surface. |
| 8 | Terminal-state lookup after the lease disappears | **Available**, with a 7-day / 1000-job retention. |
| 9 | End-to-end tests with Cut and Design Studio running simultaneously | **Covered** with separate OS processes. |

### Job identity

A single job id names the live record, resource evidence, terminal record, and associated receipt.
Integrations must preserve that exact id across the whole operation.

---

## The concurrency model

Cut asked for a non-blocking submission that returns a jobId before rendering completes, **or a
clearly defined alternative**. This is the alternative, and it is strictly stronger for this case.

**Cut chooses the id.** It is an input, not a return value:

```jsonc
{ "command": "motion.render.final",
  "args": { "packageRoot": "…", "outputPath": "…", "preset": "mp4-h264",
            "jobId": "cut:render-42" } }
```

Cut holds `cut:render-42` from the moment it builds the request — **before the work starts**, which
is earlier than any asynchronous submit could return one. From that instant any process can ask
about it.

Why this rather than a background submission queue: Motion is a local-first engine with no daemon.
An async submit would mean Motion owning process supervision, orphan reaping and output streaming —
a large new surface, and a security surface, for a capability Cut can get today by naming its own
job. Cut already spawns the render and already owns that process's lifetime.

**The render call still blocks.** Run it on a background thread or child process; poll from the UI
thread. The job stores are files under the user's runtime directory, so a completely separate
process reads them — that is the whole reason they are files.

If Cut omits `jobId`, Motion mints one and returns it as `jobId` on the result envelope. That is
enough to look up afterwards but useless for live progress, because it arrives at the end. **For a
progress UI, always supply your own.**

### One render is one job

A single render performs several governed operations internally — a browser frame pass, ffmpeg
capability probes, encodes. Those take capacity but are **not** reported. Cut asked for one render
and sees one job. `motion.job.list` will never show `ffmpeg.version`.

---

## What Cut has to build

### 1. A stable caller id, one per workspace

```
--caller-id cut:workspace-7        (CLI)
context.callerId = "cut:workspace-7"   (Debug API / MCP host config)
```

Requirements:
- **Stable across processes.** A fresh Cut process must recognise work its predecessor started, so
  a pid or a per-connection session id is wrong.
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

Verified on real concurrent renders: with one slot, the second render reported `pending` for four
consecutive polls with `startedAtMs` absent, then flipped to `running`, and finished with
`queueWaitMs: 14563` against the first render's `10`.

---

## Visibility is a boundary, not a filter

Cut and Design Studio share one machine and one capacity pool. They do **not** share evidence.

- A query is answered as the caller that asked. Cut cannot name Design Studio's caller id to read
  its jobs.
- `scope: "all"` exists for an operator console and is **refused** unless the host started the
  Motion debug server with `context.crossCallerJobScope: true`. An embedded agent cannot grant
  itself this.
- Scheduling stays global: every job competes for the machine-wide cap regardless of owner.

Verified with two real OS processes, one per host, rendering simultaneously.

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
motion_render_final{ "args": { …, "jobId": "cut:render-42" } }
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
  substitute browser; and a Playwright cache that other users can write, or an entry inside it whose
  name is not `chromium-<build number>`, contributes nothing and is named in `problem`.

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
- `motion.render.status` and `motion.render.queue` still exist and still read receipt files. They
  are unchanged, and they still cannot see running work.
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
