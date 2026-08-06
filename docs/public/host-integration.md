# Integrating a host with ShellX Motion

For an agent or engineer working on **ShellX Cut**, **Design Studio**, or any other host that
drives Motion. It states what changed on Motion's side, and **what you have to change on yours**.

Read it top to bottom once. The first section is the part that breaks things if you skip it.

> Implementing the **job/progress surface** specifically? Read
> **[cut-job-integration-spec.md](cut-job-integration-spec.md)** instead — it is the precise
> implementation spec for that one area, with worked request/response pairs.

**Invoking the CLI.** Shell commands here are written as `shellx-motion <command>` — the single `bin`
the `@shellx-motion/cli` package publishes, on `PATH` in an installed build. From a ShellX Motion
**source checkout** the equivalent is `pnpm --filter @shellx-motion/cli run cli -- <command>`; nothing
puts `shellx-motion` on `PATH` there. There is no `motion` binary in either form, and dotted names
like `motion.job.get` are Debug API / MCP command ids rather than shell commands.

---

## What you must change

Ordered by what breaks if you do nothing.

| # | Change | If you skip it |
|---|---|---|
| 1 | Stop sending `state: "queued"`; the value is now `"pending"`. | Your handoff documents fail validation with `must be pending or running`. |
| 2 | Handle `cancelled: true` on a render result, and **never auto-retry it**. | You restart work a human deliberately stopped. |
| 3 | Read `receiptPath` from the render envelope instead of capturing stdout. | You keep a fragile path that now has a supported alternative. |
| 4 | Expect `job_queue_timeout` from a render that never started. | You report "render failed" for "the machine was busy", and retry the wrong way. |
| 5 | Send a `callerId`. | Every job you start is recorded as `unattributed`, in one shared bucket with every other host. |
| 6 | Expect `editable_lowering` to be chosen **less often**, and read `unsupported`. | You are surprised by a `rendered_media` plan you used to get as editable. |
| 7 | Drop `motion.screenshot`. It no longer exists. | `unknown_command`. |
| 8 | Name your jobs with `jobId`, and poll `motion.job.get`. | You cannot show progress, because nothing else can see a render while it runs. |

Everything below is the detail behind those eight.

---

## 1. Job state vocabulary

Motion had **seven** different vocabularies for "what is happening with this job", with three
different words for success. There is now exactly one, defined in `schemas/job-status.json` and
generated into **[JOB_STATUS.md](JOB_STATUS.md)** — read that file for the full state table.

The short version. Two authored axes plus one derived projection:

- `lifecycle` — `pending` · `running` · `ended`. Answers *"can this still change on its own?"*
- `outcome` — `succeeded` · `failed` · `cancelled` · `skipped`. Present **iff** `ended`.
- `state` — the projection: `ended ? outcome : lifecycle`. Six observable values. **Generated,
  never accepted as an input** — you cancel by id, you never set a state.

**The rename that affects you: `queued` → `pending`.** A caller in that state is waiting for a
slot, not being worked on, and telling a user "rendering…" while nothing is being produced is a
lie. The job handoff validators reject `queued` now.

Two rules worth putting in your code review checklist:

- **Switch on `outcome`, never on whether an artifact path is present.** A failed encode can leave
  a truncated file behind.
- **`cancelled` never carries `error`; `failed` always does.** That is deliberate, so a retry
  policy shaped like `if (job.error?.retryable) retry()` is *structurally incapable* of restarting
  something a human stopped.

> **Available: `motion.job.get` and `motion.job.list`.** An earlier version of this
> document said no live job-query command existed and told you not to build a polling UI. That is
> no longer true — see [§1a](#1a-asking-what-a-job-is-doing-right-now) below, which is the section
> to read if you are building progress reporting.
>
> `motion.render.status` and `motion.render.queue` still exist and are still **views over receipt
> files**. They can only describe work that has finished writing evidence, so they cannot see a
> render that is queued or running. Use `motion.job.*` for anything live.

---

## 1a. Asking what a job is doing, right now

This is the section to read if you are building a progress display. It is also the section that
tells you a cancel button has no verb behind it: Motion exposes no cross-process cancel for a render
already in flight, so the only way to stop one is for the caller that launched it to abort or kill
its own process.

### The problem it solves

`motion.render.status` and `motion.render.queue` read **receipt files**. A receipt is written when
an operation finishes, so those commands are structurally unable to see a render that is queued or
running — the exact window a progress UI cares about.

`motion.job.get` and `motion.job.list` read the live lease directory and the terminal record store
instead. They answer during the render, and they keep answering after it.

### The concurrency model, stated plainly

**You name the job.** Motion does not need to hand you an id asynchronously, because you supply one
before the work starts:

```jsonc
// Cut → Motion
{ "command": "motion.render.final",
  "args": { "packageRoot": "…", "outputPath": "…", "preset": "mp4-h264",
            "jobId": "cut:render-42" } }
```

You hold `cut:render-42` from the moment you build the request — earlier than any non-blocking
submit could return one. From that instant, any process may ask about it.

If you omit `jobId`, Motion mints one and returns it as `jobId` on the result envelope. That is
enough to look the job up afterwards, but not to watch it while it runs, because you only learn it
at the end. **For a progress UI, always supply your own.**

The render call itself still blocks until the render finishes. That is deliberate — it keeps every
existing script and connector working. Run it on a background thread or a child process and poll
from your UI thread; the job stores are files, so a completely separate process can read them.

### One render is one job

Under the hood a single render performs several governed operations — a browser frame pass, ffmpeg
capability probes, encodes. Those hold capacity but are **not** reported as jobs. You asked for one
render; you see one job. A `motion.job.list` will never show you `ffmpeg.version`.

### Polling

```jsonc
// Cut → Motion, from any process, while the render runs
{ "command": "motion.job.get", "args": { "jobId": "cut:render-42" } }
```

```jsonc
// running
{ "ok": true,
  "result": { "ok": true, "job": {
    "jobId": "cut:render-42", "callerId": "cut:workspace-7",
    "lifecycle": "running", "outcome": null, "state": "running",
    "lane": "browser", "operation": "render.final",
    "createdAtMs": 1785681391000, "startedAtMs": 1785681391004,
    "queueWaitMs": 4, "pid": 48122,
    "warnings": [], "pollAfterMs": 2000 } } }
```

```jsonc
// ended — same id, after the rendering process has exited
{ "ok": true,
  "result": { "ok": true, "job": {
    "jobId": "cut:render-42", "lifecycle": "ended",
    "outcome": "succeeded", "state": "succeeded",
    "durationMs": 114328, "queueWaitMs": 1,
    "receiptPath": "…/receipts/render-final-…json", "warnings": [] } } }
```

Rules for reading this:

- **Switch on `state`.** It is `lifecycle` when in flight and `outcome` once ended, which is the one
  token you actually branch on. Never accept it as an *input* — you cancel by id, you never set a
  state.
- **`pending` is real, and you should render it.** A job is `pending` from the moment you submit it
  until the machine actually admits its first unit of work. On a busy machine that can be many
  seconds. Show "waiting for a slot", not "rendering…" — nothing is being produced yet.

  `startedAtMs` is **absent** while pending. That is the machine-checkable proof, and it is a
  better test than the state string if you only want one branch.

  Once ended, `queueWaitMs` tells you how much of the total was spent waiting, so you can show
  "queued 14s, rendered 42s". A job that failed while still queued reports **no** `startedAtMs` at
  all — it genuinely never ran, and reporting it as a failed render would be wrong.
- **Stop polling when `pollAfterMs` is absent.** Its absence means the job has ended, so there is
  nothing further to wait for.
- **Poll no faster than `pollAfterMs`** (currently 2000).

### Listing

```jsonc
{ "command": "motion.job.list", "args": { "limit": 20 } }
// → { jobCount, inFlightCount, stateCounts: { pending, running, succeeded, failed, cancelled, skipped }, jobs: [...] }
```

Live work comes first, then finished work newest first.

### The three ways a lookup comes up empty

These describe the *query*, never the job, and each demands a different response. Do not collapse
them into "not found":

| code | means | what you should do |
|---|---|---|
| `job_unknown` | No such id here. Almost always a typo or the wrong machine. | Stop. Re-read the id from the submission response. Do **not** report a failed render. |
| `job_expired` | It ran, but its record aged out (7 days / 1000 jobs). | Fall back to the receipt index. |
| `job_not_visible` | It exists and belongs to a different caller. | Re-query with the `callerId` that started it. |

`job_not_visible` is overwhelmingly caused by querying with a different `callerId` than the render
used. The CLI says so in `suggestedAction`, naming the id it queried with.

### Visibility is a boundary, not a filter

A job is answered **as the caller that asked**. Cut cannot see Design Studio's jobs, even though
both compete for the same machine-wide capacity — scheduling is shared, evidence is not.

`scope: "all"` exists for an operator console and is **refused** unless the host started the Motion
debug server with `context.crossCallerJobScope: true`. An embedded agent cannot grant itself this.

### From the CLI

Everything above is available without the Debug API, which is what you want if you spawn Motion as
a child process:

```bash
shellx-motion render <pkg> --out out.mp4 --job-id cut:render-42 --caller-id cut:workspace-7
shellx-motion job get cut:render-42 --caller-id cut:workspace-7     # from any other process
shellx-motion job list --caller-id cut:workspace-7 --limit 20
```

`--caller-id` must match between the render and the query, or you will correctly get
`job_not_visible`. Use one stable value per workspace — `cut:workspace-7`, never a pid.

---

## 2. Cancellation is real now

Previously the abort plumbing existed and nothing supplied a signal, so Ctrl-C killed the CLI and
left ffmpeg and Chromium running.

A cancelled render now returns:

```jsonc
{ "ok": false, "command": "render", "cancelled": true,
  "error": { "code": "render_cancelled", "message": "..." } }
```

`ok` is false because the artifact was not produced; `cancelled: true` says why. **Branch on it.**
Cancelled is not failed — auto-retrying it overrides whoever stopped the work. The CLI exits `130`,
the conventional SIGINT status, so a wrapping script can make the same distinction.

If you drive `runCli` in-process, pass your own `signal` in `RunCliOptions`.

One host-visible side effect: Motion now launches Chromium with Playwright's signal handling
disabled. Playwright's defaults call `process.exit(130)` on any signal, which killed the host
before a cancelled render could report anything. If you embed Motion and rely on Playwright's
handlers, own that policy yourself.

---

## 3. Receipts are on disk

`render` used to return its receipt only as transient stdout JSON — it wrote **no file**. It now
always writes one beside the delivered artifact, and returns the path:

```jsonc
{ "ok": true, "receiptPath": "/out/<packageId>-render.receipt.json", "receipt": { … } }
```

- `--out` is a file (`mp4-h264`, `png-frame`) → the receipt is a **sibling**.
- `--out` is a directory (`png-sequence`) → the receipt goes **inside** it.
- A render that fails its quality manifest **still writes its receipt**, because that is when the
  evidence matters most.

Prefer `receiptPath` over reconstructing the path. See
[receipts-and-trust.md](receipts-and-trust.md) for the full destination table.

Two related fixes you will notice in receipt content:

- **Frame-lane warnings now reach the final receipt.** A font fallback during drawing used to
  vanish once frames were encoded away; the receipt said `passed` with no warnings. It now escalates
  to `warning` and carries them.
- **Routine ffmpeg output is no longer recorded as a warning.** Every successful encode used to
  carry the muxing-overhead summary in `warnings`, so `warnings.length > 0` told you nothing.
  It is a real signal now.

> **Cross-repo constraint, important for Cut:** Cut *derives and validates* Motion receipt ids
> (`expected_cut_plan_receipt_id`). **Changing how Motion forms receipt ids breaks Cut's import.**
> Treat receipt-id formation as a shared contract, not an internal detail.

---

## 4. Concurrency is machine-wide now

Motion's concurrency cap used to live in one process, so every caller got the full cap: three hosts
under a cap of two ran six renders and the memory ceiling multiplied by the number of callers.

Admission now takes a lease from a shared **per-user** directory, so the cap holds across every
Motion process belonging to one user.

What this means for you:

- **A render may wait for capacity another process holds.** That wait counts against the same queue
  deadline; exhausting it reports `job_queue_timeout`, which is **retryable**. Surface it as "the
  machine is busy", not "your render failed".
- `SHELLX_MOTION_LEASE_ROOT` overrides the lease location. Default is
  `$XDG_RUNTIME_DIR/shellx-motion/job-leases` (`%LOCALAPPDATA%` on Windows).
- Leases are reclaimed when a holder dies or stops heartbeating for 30s, so a crashed render cannot
  permanently consume capacity.
- **It degrades rather than failing.** If the lease directory is unusable Motion still renders,
  bounded per-process, and says so — the governor snapshot reports `machineWide: false`.
- Scope is per-user. Two OS users on one machine do not see each other's leases.

---

## 5. Tell Motion who you are

Every job records the caller that created it. Visibility is **per-owner** while scheduling stays
global: capacity is a property of the machine, evidence is a property of the requester.

**Set it.** Without it your jobs are recorded as `unattributed` and share one bucket with every
other host that also said nothing.

| Surface | How |
|---|---|
| CLI | `--caller-id cut:workspace-7` |
| `runCli` in-process | `RunCliOptions.callerId` |
| Debug API / MCP | `MotionDebugContext.callerId` |
| Renderers directly | `callerId` on the governed ffmpeg runner options and browser session options |

If you do not supply one, Motion derives `${transport}:${label}` from the actor the transport
observed. That is a reasonable default but a coarse one.

**Choose a value that is stable across your processes** — `"cut:workspace-7"`, not a pid and not a
per-connection session id. A fresh process must be able to recognise work its predecessor started.
If your host runs several independent workspaces, make the workspace part of the id: that is the
granularity at which your own agents will or will not see each other's jobs.

---

## 6. Editable lowering got stricter, and honest

Motion was a **deny-list producer** against Cut's **allow-list consumer**: it named a few features
it knew Cut refused and declared everything else supported. So it emitted
`mode: "editable_lowering"` with `unsupported: []` for payloads Cut then hard-rejected.

Motion now validates every lowered payload against the exact field set Cut's receiver accepts,
before claiming editable. **You will see `editable_lowering` chosen less often, and a populated
`unsupported` array explaining why**, each entry naming the offending field.

This is not a regression. Those plans previously failed on arrival; now they degrade to
`rendered_media` up front.

Two things were fixed rather than reported, so they cost you nothing:

- `blendMode: "normal"` is the identity blend — no longer emitted at all.
- `transform.opacity` is lifted to payload level, where Cut accepts it.

The accepted field sets live in `packages/adapters-cut/src/editable-receiver-allowlist.ts`, mirrored
from Cut's `motion_editable_import.rs` and marked with the receiver slice they were verified
against. **If Cut widens its receiver, widen those sets in the same change** — otherwise Motion will
keep declining to lower things Cut has learned to accept.

A Cut target declares which receiver it runs via `editableReceiver` in its capabilities. Targets
that declare none are not subject to these limits.

---

## 7. Commands: one removed, two added

**Removed — `motion.screenshot`.** It returned `{"ok":true,"captureRequested":true}` and produced
no file, path, hash or receipt. Motion is a headless engine with no panel of its own, so it could
only relay a request to a host and report success for something it could not verify. Use
`motion.preview.frame` (CLI `debug preview-frame`), which writes a real PNG and a receipt.

**Added — Lottie and dotLottie import.** ~2,800 lines of tested lowering were previously reachable
from no surface at all.

```bash
shellx-motion debug lottie-import    --source ./brand.json   --out ./pkg --tier write_local
shellx-motion debug dotlottie-import --source ./brand.lottie --out ./pkg --tier write_local \
  --animation hero --theme dark
```

Both need `write_local` and host-approved input/output roots, like `motion.scene3d.gltf.import`.
Each writes a **lowering receipt** and an **adapter-diagnostics receipt** into the package: read
them, because a successful import is not the same as one that represented everything. dotLottie
state machines are preserved and **never executed** — do not promise interactive behaviour.

Every registered command has a published argument contract in `schemas/debug.json`, which is the
authority for the count — it changes as commands are added, so do not hardcode it.

---

## Connecting over MCP

Motion's loopback debug server speaks MCP over HTTP JSON-RPC at `/rpc` in two compatible modes:

- Modern protocol `2026-07-28` uses `server/discover` with no initialize handshake. Every request
  carries `io.modelcontextprotocol/protocolVersion` and client capabilities in `params._meta`, plus
  matching `MCP-Protocol-Version` and `Mcp-Method` HTTP headers (`Mcp-Name` for `tools/call`). Modern
  list/call results carry `resultType: "complete"` and server identity metadata.
- Legacy protocol `2025-06-18` retains `initialize`, `tools/list`, and `tools/call` for existing
  clients.

In both modes, `tools/list` returns every registered command as
`motion_<command_with_dots_as_underscores>`, with contract-derived tool annotations, and
`tools/call` returns both `content` and `structuredContent`.

For normal local use, run `pnpm start` and configure the client from Workbench **Connections**. The
bundled stdio bridge reads the live port and private key outside project configuration. A custom
host may instead start the advanced server directly:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- --port 9977 --tier read_motion
```

- Direct transport is **HTTP with `Authorization: Bearer <token>`**. The bundled stdio bridge
  forwards MCP JSON-RPC to that authenticated loopback endpoint.
- Binding is **loopback only** by design; a non-loopback bind is refused. Reach it from elsewhere
  through an authenticated reverse proxy or an SSH tunnel.
- Tiers above `read_motion` require `--trusted-local-tier`; `push_remote` also requires
  `--allow-push-remote`. Grant the lowest tier that does the job — `read_motion` cannot render.
- The human launcher reuses a private per-user key. An advanced direct launch without
  `--persistent-access` or `SHELLX_MOTION_DEBUG_TOKEN` mints an ephemeral key, writes it to a
  private file, and reports that path in its startup JSON.
- `serverInfo.version` reports `0.1.0` — the same string as the CLI banner (`shellx-motion
  --version`), `GET /health` (`engineVersion`), `GET /debug/contracts`, and the local SDK
  capability contract (`sdkVersion`). One engine build reports one version on every surface; that
  is what the Engine Room update check compares against the GitHub release feed.
- `server/discover`, `rpc.discover`, and legacy `serverInfo.update` expose the same cached startup
  update result as the About page. Read `status`, `checkedAt`, `latestVersion`, and
  `updateAvailable`; do not create a second release-feed check in the host.

---

## Checklist before you call your integration done

- [ ] No `"queued"` anywhere in job handoffs.
- [ ] A `cancelled: true` result is surfaced as stopped, and is never auto-retried.
- [ ] `receiptPath` is read from the envelope and persisted with your own record.
- [ ] `job_queue_timeout` is presented as busy-and-retryable, not as a failure.
- [ ] A stable `callerId` is sent on every entry point you use.
- [ ] A `rendered_media` plan with a populated `unsupported` array renders and reports reasons,
      rather than being treated as an error.
- [ ] No call sites remain for `motion.screenshot`.
- [ ] Receipt-id expectations still match if you validate them (Cut does).
