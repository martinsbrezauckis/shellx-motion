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

## Self-describing connector discovery and generic jobs

Motion now publishes a closed, read-only discovery foundation for hosts that need to understand
what Motion can describe without starting a render or connector. From source, use the source-checkout
prefix; installed packages use the same commands through `shellx-motion`.

```bash
pnpm --filter @shellx-motion/cli run cli -- runtime-probe
pnpm --filter @shellx-motion/cli run cli -- connector catalog
pnpm --filter @shellx-motion/cli run cli -- connector describe connector.template-to-cut@1
```

A pure Debug/MCP host reads the same object through the argumentless, `read_motion`
`motion.connector.catalog` command (MCP tool: `motion_connector_catalog`). There is no separate
Debug/MCP `describe` route: the canonical catalog already contains every immutable descriptor,
including the exact revision, fingerprint, request-schema id, and closed field definitions needed
to prepare `motion.connector.submit`.

`runtime-probe` is project-free, provider-free, network-free, and read-only. It reports engine,
CLI, Node, platform, protocol, and catalog identity, but a source checkout or ordinary packed npm
installation remains `unmanaged`, distribution-`unverified`, and clean-host-`unverified`. It never
creates a distribution id or claims managed-runtime qualification.

`connector catalog` and `motion.connector.catalog` return the same deterministic, canonical v2
object with bounded documentation resource
references. The catalog embeds the existing `integration-capabilities@1` object unchanged; hosts
must continue to negotiate that existing contract. Catalog entries contain no executable, argv,
path, provider, URL, code, callback, or submit authority.

The current catalog is `capability-catalog@2` and uses `connector-job@2`. The runtime probe reports
catalog/job protocol range 1 through 2 with preferred version 2; Motion still parses the closed
historical `capability-catalog@1`, but generic preparation is available only for an admitted v2
descriptor. Never reinterpret an old `not-admitted` v1 descriptor as executable.

Four existing Linux delivery descriptors are admitted through the generic lifecycle: P2A
Template-to-Cut and P2B Canvas/Script/Source-to-Cut. They retain their real Browser-to-FFmpeg H.264
`rendered_media`, no-clobber and input restrictions. Legacy Canvas bridge, Canvas-to-MP4 and Cut
Generate-to-Cut descriptors remain named-CLI compatibility routes; Canvas-to-MP4 and Cut
Generate-to-Cut are Linux-only because their package publication requires exact descriptor-relative
closed-tree proof. Scene3D, C6 physics and C7 scene orchestration remain explicitly refused for Cut.

An admitted host calls the single `motion.connector.submit` Debug/MCP operation with the exact
capability id, descriptor revision/fingerprint, request-schema id and closed request it discovered.
Request reference fields contain only caller-scoped opaque handles—never filesystem paths or URLs.
The host must configure three one-time authorities before the generic submit tool will admit work:
an authenticated stable caller identity, an opaque-reference resolver, and an immutable
`MotionConnectorJobBindingJournal` beside the persistent coordinator. The tool remains discoverable
without those services and returns a typed `capability_unavailable` refusal. Motion validates and
journals the descriptor-bound request before queueing or resolving a handle.

The returned id is controlled through the existing `motion.job.get/list/events/cancel/retry`
operations. Cancellation reaches the same connector execution and cannot publish a terminal
`cancelled` result after the connector has atomically committed delivery. A retry is always an
explicit new job. After a host restart Motion may reconstruct a retryable failed connector from its
immutable path-free binding and re-resolve its opaque handles, but it never auto-resurrects an
interrupted pending/running job.

Consumers must branch on protocol, request-field type, lifecycle control and output role—not on a
capability-id switch. A future descriptor using the same negotiated request, trust, artifact,
receipt and import-plan classes is discoverable and callable without a Cut source change. Motion
adds the descriptor and executor; Cut's generic adapter does not change. A new protocol major,
interaction class, authority, permission or artifact/editor-operation class still requires a
consumer update.

```jsonc
{
  "command": "motion.connector.submit",
  "args": {
    "jobId": "cut:motion-42",
    "capabilityId": "connector.template-to-cut@1",
    "descriptorRevision": 2,
    "descriptorFingerprint": "<from connector catalog>",
    "requestSchemaId": "shellx-motion/connector-request/template-to-cut@1",
    "request": { "input": "cut_input_42", "output": "cut_output_42" }
  }
}
```

The example fingerprints are deliberately not copied into prose: read them from the current
catalog and bind the exact values you submit.

---

## What you must change

Ordered by what breaks if you do nothing.

| # | Change | If you skip it |
|---|---|---|
| 1 | Stop sending `state: "queued"`; the value is now `"pending"`. | Your handoff documents fail validation with `must be pending or running`. |
| 2 | Treat `cancelRequested` as a live stop request, not terminal `cancelled`, and **never auto-retry** a cancelled run. | You claim a worker stopped while it still runs, or restart work a human deliberately stopped. |
| 3 | Read `receiptPath` from the render envelope instead of capturing stdout. | You keep a fragile path that now has a supported alternative. |
| 4 | Expect `job_queue_timeout` from a render that never started. | You report "render failed" for "the machine was busy", and retry the wrong way. |
| 5 | Configure a trusted `callerId` for a direct coordinator host. | `motion.job.*` fails closed without an authenticated owner principal. |
| 6 | Expect `editable_lowering` to be chosen **less often**, and read `unsupported`. | You are surprised by a `rendered_media` plan you used to get as editable. |
| 7 | Drop `motion.screenshot`. It no longer exists. | `unknown_command`. |
| 8 | Submit long-lived work through `motion.job.submit` (or `submitRender()`), then poll `motion.job.get` / `.events`. | You cannot control or show progress for a coordinator-owned render while it runs. |
| 9 | Preserve a future typed job error and its explicit retry metadata even when you do not recognize the code. | A new same-class Motion capability becomes an `invalid_args` lie or loses a valid retry path until the host is patched. |

Everything below is the detail behind those nine.

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

> **Available: `motion.job.submit`, `motion.job.get`, `motion.job.list`, `motion.job.events`,
> `motion.job.cancel`, and `motion.job.retry`.** An earlier version of this
> document said no live job-query command existed and told you not to build a polling UI. That is
> no longer true — see [§1a](#1a-asking-what-a-job-is-doing-right-now) below, which is the section
> to read if you are building progress reporting.
>
> `motion.render.status` and `motion.render.queue` still exist and are still **views over receipt
> files**. They can only describe work that has finished writing evidence, so they cannot see a
> render that is queued or running. Use `motion.job.*` for anything live.

Receipt-root render status, queue, cancel, and retry currently require Motion's Linux-only
stable-reader capability. macOS and Windows return `capability_unavailable` before receipt-state
access; hosts on those platforms should use the portable `motion.job.*` lifecycle for live work.

---

## 1a. Asking what a job is doing, right now

This is the section to read if you are building a progress display. A persistent local host submits
an ordinary streamed final-video render through `motion.job.submit`, receives a durable id before
rendering starts, and may call `motion.job.cancel` from another authenticated request. Cancellation
is an accepted request, not a premature terminal claim: live status carries `cancelRequested` until
the worker and its process tree have stopped, then reports `cancelled` with no error. Workflow,
quality-manifest, retained-frame, dry-run, still, and image-sequence compatibility renders are
refused by submit and must use blocking `motion.render.final` instead.

**Coordinator ownership is authenticated, not supplied by the request.** A direct local SDK or
direct HTTP host must configure a trusted `callerId` in its host context before it can submit,
inspect, cancel, or retry a coordinator job. MCP and WebSocket clients use a server-minted
connection principal instead. A non-coordinator compatibility render may be unattributed when no
caller identity is configured, but it has no coordinator lifecycle controls.

### The problem it solves

`motion.render.status` and `motion.render.queue` read **receipt files**. A receipt is written when
an operation finishes, so those commands are structurally unable to see a render that is queued or
running — the exact window a progress UI cares about. Their receipt-root path is currently
Linux-only; macOS and Windows refuse it as `capability_unavailable`.

`motion.job.get` and `motion.job.list` read the live lease directory and the terminal record store
instead. They answer during the render, and they keep answering after it.

### The concurrency model, stated plainly

**Choose a stable id when you need one, or use the coordinator-minted id.** Compatibility calls can
still name a job before starting. Long-lived hosts instead receive an id immediately from
`motion.job.submit`:

```jsonc
// Cut → Motion
{ "command": "motion.job.submit",
  "args": { "packageRoot": "…", "outputPath": "…", "preset": "mp4-h264",
            "jobId": "cut:render-42" } }
```

You hold `cut:render-42` from the moment you build the compatibility request. A coordinator submit
returns the equivalent durable id before expensive work begins. From either point, same-owner
processes may ask about it.

If you omit `jobId`, coordinator submit returns Motion's minted id before work begins. A blocking
compatibility render only exposes its minted id in the final envelope, so **for a blocking progress
UI, always supply your own.** The local SDK's streamed-only `submitRender()` accepts the same
optional `jobId`; supply it for reconnecting progress clients.

The host may set `MotionDebugContext.jobView` to `null` to disable the entire coordinator surface.
In that mode submit, query, events, cancellation, and retry return `capability_unavailable`; Motion
does not allocate or advertise a default coordinator for that dispatch.

Terminal records and valid event snapshots survive a server restart when their configured stores
remain available, but the live worker callback and AbortController do not. A restarted host cannot
replay a prior callback through `motion.job.retry`; it returns `job_not_retryable` until that host
submits a new run.

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
- **Keep unknown typed failures opaque.** Known shared Core error codes use the policy generated in
  `JOB_STATUS.md`. For an unknown future capability code, preserve `code`, `message`, `retryable`,
  optional `remedy`, `retryAfterMs`, and `suggestedAction`; branch on those explicit fields rather
  than translating the code or adding a capability-specific consumer switch.

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
  evidence matters most. The receipt marks primary publication `aborted` and does not advertise a
  deleted still or video stage as an available artifact; retained receipt and quality evidence must
  refer to material that actually exists.

Prefer `receiptPath` over reconstructing the path. See
[receipts-and-trust.md](receipts-and-trust.md) for the full destination table.

Two related fixes you will notice in receipt content:

- **Frame-lane warnings and typography evidence now reach the final receipt.** A font fallback
  during drawing used to vanish once frames were encoded away; the receipt said `passed` with no
  warnings. It now escalates to `warning` and carries bounded typography evidence. Generated
  MotionIR text can be attested only when manifest-bound font bytes were loaded and probe-visible;
  HTML/web/canvas text remains `unverified`, including dynamic canvas text a host cannot inspect.
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

For compatibility renders, set a stable identity so their records are not `unattributed`. For
coordinator submit, status, events, cancellation, and retry, an authenticated owner principal is
mandatory and missing identity fails closed.

| Surface | How |
|---|---|
| CLI | `--caller-id cut:workspace-7` |
| `runCli` in-process | `RunCliOptions.callerId` |
| Direct local SDK | `createLocalMotionSdk({ callerId: "cut:workspace-7" })` |
| Direct HTTP Debug API | trusted server `MotionDebugContext.callerId`, never a request argument |
| MCP / WebSocket | server-minted connection principal; clients do not provide an owner id |
| Renderers directly | `callerId` on the governed ffmpeg runner options and browser session options |

MCP and WebSocket ownership is derived only by the server from the authenticated connection. A
direct HTTP or SDK caller cannot name an arbitrary owner in a submitted JSON request.

### Enforced-untrusted browser renderer (trusted host configuration only)

A direct browser-renderer embedding may choose
`untrustedExecution: ENFORCED_UNTRUSTED_BROWSER_EXECUTION` in
`BrowserRenderSessionOptions` when its **own trusted local configuration** has
classified a package as untrusted. This is a renderer-host integration, not an
agent command or a property of a Motion package.

| Selection surface | Can select enforced-untrusted browser mode? |
|---|---|
| Direct trusted renderer host | Yes, through `BrowserRenderSessionOptions` |
| CLI | No |
| Debug API / MCP | No |
| Motion SDK request | No |
| Package manifest, motion document, data rows, or agent prompt | No |

On Linux this requires a verified Bubblewrap executable. It refuses active
`web`, `html`, and `canvas` content, approved browser network origins, and any
Chromium `--no-sandbox` opt-out before it starts a browser. The profile is not
available on Windows or macOS, and it does not yet contain FFmpeg/FFprobe; do
not treat it as a general untrusted-parser solution or as cross-host proof. See
[Security model](security-model.md#enforced-untrusted-browser-host-mode-linux-renderer-host-integration)
for the mount/evidence boundary.

The mount plan has a writable in-namespace tmpfs root and a separate tmpfs
`/tmp`; the private browser profile is its only host-backed writable bind. All
other filesystem writes are ephemeral inside that namespace. The implementation
starts with a `requested` launch plan and may emit enforced evidence only after
Motion's default Playwright launch succeeds; the current independent host-runtime
mount proof remains outstanding. A generic injected `launchBrowser` override is
therefore refused for this mode.

The renderer does not accept a package executable, a Node `--eval` payload, or
a page argument for this mode. It starts Motion's fixed package-local launcher
and passes only Chromium argv to it. Its complete launcher environment contains
exactly a `PATH` pinned to the canonical, hash-recorded Node interpreter directory
and one bounded configuration variable—there is no inherited `PATH`,
`NODE_OPTIONS`, or dynamic-loader environment. The launcher verifies the Node and
its own identity, consumes/deletes the configuration, and Bubblewrap uses
`--clearenv` before Chromium starts. Enforced receipts record the Node interpreter,
launcher, and Bubblewrap identities.

### Approved-agent-entry browser scripts (trusted host configuration only)

The separate `createApprovedAgentScriptProvenanceAuthority({ stateRoot })` factory
is for an operator-controlled renderer/debug host. `stateRoot` must be a
pre-created absolute private host directory, outside package roots; the authority manages its
own bounded, atomic attestations, host receipts, revocations, and temporary
verified snapshots. An unexpected or stale state-root entry is a fail-closed
operator-recovery condition; Motion never deletes it automatically. Inject it as `MotionDebugContext.agentScriptAuthority` (or
into a direct `BrowserRenderSessionOptions`) only after the host has made its own
local policy decision.

| Surface | Can request or create the authority? | Can receive host-injected authority? |
|---|---:|---:|
| Direct trusted renderer/debug host | No request field; constructs it from host configuration | Yes |
| MCP agent session | No; can call the narrow authoring command only when the host injected it and granted `write_local` | Indirectly, for the resulting render |
| Raw Debug, HTTP/WS | No | May use the host's ambient render policy for an already-approved package, but has no self-declaration or minting route |
| CLI, SDK | No | No |
| Package, archive, manifest, motion document, receipt, prompt | No | No |

`motion.package.script.author` additionally requires an observed MCP agent actor
with a host-granted `write_local` tier and approved input/output roots. It accepts
one bounded inline local entry only; it cannot import or copy a script, select
network origins, mint an id, set a timestamp, revoke evidence, or enable a
marketplace. Browser rendering otherwise refuses active `web`, `html`, and
`canvas` entries. See [Security model](security-model.md#approved-agent-entry-provenance)
for identity, move/copy, TOCTOU, and authorship limitations.

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

For a render-capable server, add `--trusted-local-tier`, a render tier, and repeated
`--render-package-root`, `--render-input-root`, and `--render-output-root` flags. They are three
separate host authorities: caller-steered read/draft/render package paths; external
cache/final/batch rows, workflow, or quality files; and caller-named preview, cache-plan, final, or
batch destinations. An omitted preview destination remains host-owned scratch. Every server
transport fails closed when a required class is absent; request and SDK payloads cannot widen it.
Native Workbench Browse results may add only the exact human-selected location for that server
session. A direct in-process SDK or standalone CLI is itself the embedding host and derives only
the narrow roots for its current local operation.

- Direct transport is **HTTP with `Authorization: Bearer <token>`**. The bundled stdio bridge
  forwards MCP JSON-RPC to that authenticated loopback endpoint.
- Binding is **loopback only** by design; a non-loopback bind is refused. Reach it from elsewhere
  through an authenticated reverse proxy or an SSH tunnel.
- Tiers above `read_motion` require `--trusted-local-tier`; `push_remote` also requires
  `--allow-push-remote`. Grant the lowest tier that does the job — `read_motion` cannot render.
- The human launcher reuses a private per-user key. An advanced direct launch without
  `--persistent-access` or `SHELLX_MOTION_DEBUG_TOKEN` mints an ephemeral key, writes it to a
  private file, and reports that path in its startup JSON.
- The installed launcher also retains a separate private producer key for attested-render-reuse
  HMAC proofs. `startMotionDebugServer` creates an opaque process-lifetime producer authority when
  a custom host does not inject one; this is safe but entries will not survive a host restart as
  authenticated hits. Long-lived in-process SDK hosts may retain and reuse the opaque authority
  from `LocalMotionSdkOptions.attestedRenderReuseProducerAuthority`; key bytes are never request data.
- `serverInfo.version` reports `0.2.65` — the same string as the CLI banner (`shellx-motion
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
