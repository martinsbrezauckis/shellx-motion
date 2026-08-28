# Agent integration

ShellX Motion is agent-first: the first product surface is a typed action/debug
contract, not a visual-only editor. A local CLI subscription agent, the Engine
Room prompt box, Design Studio, ShellX Cut, or any agent workflow runner uses the
documented surface that fits its host. This page describes those bounded transports,
authentication, permission tiers, and the machine-readable schemas.

> **Invoking the CLI.** Shell commands on this page are written as `shellx-motion <command>` — the
> single `bin` the `@shellx-motion/cli` package publishes. From a ShellX Motion source checkout, run
> them as `pnpm --filter @shellx-motion/cli run cli -- <command>` instead. There is no `motion` binary
> in either form; dotted names such as `motion.render.final` are Debug API / MCP command ids, not
> shell commands. See [Quickstart](quickstart.md).

## Invocation surface matrix

The Debug/MCP command registry is complete on its own transports; the CLI and SDK are useful but
smaller typed surfaces. Pick the one that fits your host without assuming universal parity.

| Surface | Current callable inventory |
|---|---|
| Debug API / HTTP / WebSocket / MCP | **300** typed commands; MCP publishes all 300. |
| CLI | **234 direct** `debug` routes plus **7 semantic equivalents** (`connector catalog`, `package-create`, `validate`, `doctor`, `doctor --probe-gpu`, `job get`, `job list`). The **59 named no-route** commands are `motion.agent.snapshot`, `motion.connector.submit`, `motion.job.submit/events/cancel/retry`, `motion.keying.inspect/apply/remove`, `motion.roto.upsert/tracking.detach/remove`, `motion.package.script.author`, `motion.timeline.checkpoint-storyboard.create/inspect/revise/remove/archive/materialize/detach/behavior.resolve/behavior.detach/relation.resolve/relation.detach/relation-action.resolve/relation-action.detach/lifecycle.resolve/lifecycle.detach/geometry-morph.resolve/geometry-morph.detach/retained-trace.resolve/retained-trace.detach/retained-trace.preview/retained-trace.review.bind/preview/creative-review.bind/preview-quality.review`, `motion.timeline.relations.inspect/upsert/enabled.set/remove/detach/bake`, `motion.timeline.relation-actions.inspect/upsert/remove/apply`, `motion.timeline.scene3d-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`, and `motion.timeline.layout-gap-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`. |
| Local SDK | **35 dedicated local-SDK operations**; it is not a generic Debug dispatcher. |
| Action discovery | **174 discoverable actions**. |

- **CLI JSON transport.** `shellx-motion actions find|guide|plan`, `agent health`,
  `prompt run`, `debug state`, `debug preview-frame`, `preview`, and `render`. Each
  command returns a structured JSON envelope. This is the default path for
  configured local CLI agents.

  There is no `motion.screenshot`. It was removed: Motion is a headless engine
  with no panel of its own, so the command could only relay a request to the host
  and report `ok: true` for something it had no way to verify. For an image on
  disk, call `motion.preview.frame` (CLI `debug preview-frame`, or `preview`),
  which writes a real PNG and a receipt.
- **Loopback HTTP / WebSocket.** A capability-authenticated server on
  `127.0.0.1`. `POST /debug` takes `{command, args, requestedTier?}`. `POST /rpc`
  is JSON-RPC discovery plus MCP-compatible tool dispatch. `WS /ws` is a
  persistent JSON-RPC transport. `GET /debug/contracts` returns the full
  command/domain/tier/mutation registry and the running engine version.
- **MCP transport.** Generated from the same action/debug registry over `POST /rpc`.
  Modern clients use protocol `2026-07-28`: call `server/discover` without an initialize
  handshake, send protocol version and client capabilities in each request's `_meta`, and
  mirror the version/method/tool name in MCP HTTP headers. Legacy `2025-06-18` clients may
  continue using `initialize`, `tools/list`, and `tools/call`. The bundled stdio bridge uses
  its authenticated persistent `WS /ws` connection only for owner-scoped coordinator tools.
  Each debug command becomes a tool
  named by replacing the dots in the command id with underscores, so `motion.render.final` becomes
  the tool `motion_render_final`; annotations declare its
  read-only/mutating shape from the same command contract. Discovery also
  reports the engine's cached update status (`currentVersion`, `latestVersion`,
  `updateAvailable`, and `checkedAt`). That is the same startup/periodic result
  shown in About; agents read it instead of making a separate release-channel
  request.

## Compact agent snapshot

`motion.agent.snapshot` is the small read-only starting point for an agent that needs package
identity plus a derived package fingerprint, motion and persisted timeline-control/count facts,
action guidance, receipt status counts and recent receipt timestamps, sanitized warnings, and its
own live jobs without loading the larger state, panel, plan, or receipt payloads. Job completeness
requires the host's authenticated owner principal; without it the job projection is empty and
inexact and carries an explicit warning rather than reading a shared `unattributed` bucket. Recent jobs carry
only outcome (when ended), creation time, polling advice (when live), and warning count. It creates
no receipt and never mutates a package. Its result is `shellx-motion/agent-snapshot@1`, has a fixed
12,288-byte UTF-8 ceiling and no cache. The top-level `observedAt` and each source freshness record
(`package`, `timeline`, `receipts`, `jobs`) honestly state when that source was observed and whether
the bounded read completed. `snapshotId` hashes an explicit canonical content projection that
excludes every observation clock, so unchanged content has a stable identity.

`packageRoot` and `receiptsRoot` are the only optional caller paths. A host must preconfigure
snapshot package roots and governed receipt roots; path containment and symlink checks fail closed.
The snapshot never returns package, receipt, artifact, or process paths. It does not echo the
caller’s action request: that text only selects compact `find`/`guide`/`plan` facts. Warning and
projected label text is Unicode-scalar bounded, stripped of terminal controls, and redacts absolute
paths. Selection is explicitly reported as unavailable because Motion does not persist
`motion.select`/`motion.highlight` state. Receipt counts and omitted receipt rows carry an explicit
exactness bit: an incomplete traversal reports lower bounds, never an invented total.

An embedding host may additionally configure exactly one MCP resource,
`motion://shellx-motion/agent/snapshot`. When configured, it is listed by `resources/list` and read
with that exact URI only. It has no query parameters, templates, subscriptions, caller-selected
paths, command dispatch, cache, receipt writes, or receipt-selected reads. The resource uses only host-configured roots,
requires the authenticated server's `read_motion` scope, and returns only the requesting caller's
jobs. When a host has not configured it, the MCP `resources` capability and both resource methods
are absent.

## Coordinator owner principals

The persistent coordinator's `motion.connector.submit` and `motion.job.submit`, `.get`, `.list`,
`.events`, `.cancel`, and `.retry` routes require an owner principal for submission, control, and
visibility. A direct local SDK or direct HTTP host must configure a trusted `callerId` in its host
context; it is not a request argument an SDK/HTTP caller can nominate. Stateless `POST /rpc` MCP
likewise has no owner and those routes refuse unless the server host configured that trusted
`callerId`. The bundled
`shellx-motion-mcp` stdio bridge opens one `WS /ws` connection for its coordinator tools, which
receives an opaque server-minted connection principal. Submit and later query/control calls in that
same bridge process share an owner. A reconnect or separately started bridge receives a new owner
and cannot see the earlier process's jobs; use an explicitly configured direct host for a
cross-process workflow.
Non-coordinator compatibility renders may still run without an owner and are then recorded as
`unattributed`, but they do not gain coordinator submission or control authority.

Discover before you call. An unknown `motion.*` id returns no action; it never
falls through to a vaguely related workflow.

For moving sparks, drones, light accents, or a short laser head, create a normal `particles` or
`points` layer with its static `effects.trail` record, then use the existing
`motion.timeline.layer.rich.set` fields `effects.trail.durationMs` (1..2000) and
`effects.trail.samples` (integer 2..8). This adds no verb or arbitrary code surface; discovery,
MCP, Debug API, and SDK all expose the same layer-create/rich-set route. The bounded contract and
lane/refusal facts are in [trails.md](trails.md).

```bash
shellx-motion actions find "track a product and attach a callout"
shellx-motion actions guide motion.analysis.tracking.request
shellx-motion actions plan  "track a product and attach a callout"
```

## Authentication and the loopback server

For ordinary local agent use, start Motion and configure the agent from Workbench **Connections**:

```bash
pnpm start -- \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

Start Motion creates or reuses one private per-user access key, publishes the live loopback port,
opens an authenticated Workbench, and grants a local `write_local` ceiling. The paired roots are
required for `motion.package.create` and caller-steered copy-on-write edits: existing package inputs
must be under the input root and new packages/revisions under the output root. The bundled stdio MCP
bridge reads the key and port at call time, so agent configurations contain no Bearer token and do
not configure roots. A stopped engine produces a clear instruction to start Motion and retry. See
[Connect an agent](connections.md).

Advanced hosts can instead start the server with a narrower grant:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- \
  --tier write_local --trusted-local-tier \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

The paired authoring roots are server-launch policy. The input root contains existing packages the
agent may copy and edit, and the output root receives newly created packages or revisions. Omit
either root to make package creation and caller-steered package edits fail closed. Raw HTTP, MCP,
and MCP stdio configuration cannot add or widen the roots; restart Motion with a changed pair.

Caller-steered package reads and render work have a distinct three-part root policy. Read, draft,
and render package paths must be under a host-owned `--render-package-root`; external
cache/final/batch rows, workflow, or quality files under `--render-input-root`; and caller-named
preview, cache-plan, final, or batch destinations under `--render-output-root`. An omitted preview
destination remains host-owned scratch. The loopback server fails closed when a required class is
absent. A native Workbench chooser can grant the exact human-selected location for that session,
but raw Debug/MCP/SDK arguments cannot grant themselves. A headless agent therefore needs the
launch flags above.

Archive/extract, review/support bundle and tracking-request commands use host authority by concrete
path role too: package/archive sources are inputs, created package/archive/review destinations and
explicit receipt files are outputs, and support delivery remains host-owned scratch. The check is
performed before package loading, media analysis or destination creation, including through the
server SDK. Package-browser and template-catalog aliases and root arrays are checked entry by entry;
a template-root grant is catalog/plan authority, not a general package or render grant.

- The server binds loopback only. Direct non-loopback binding is disabled; a
  tunnel or reverse proxy would have to supply its own authentication and host/
  origin policy.
- The advanced launch prints a JSON manifest with `url`, `workbenchUrl`, the granted tier, the
  transports, and an `auth.tokenFile`. Without `--persistent-access` or
  `SHELLX_MOTION_DEBUG_TOKEN`, it uses a private ephemeral key file and removes it when the server
  stops. Never place a key in project files, shell history, logs, or URLs.
- HTTP and RPC clients send the capability as `Authorization: Bearer <token>`.
  WebSocket clients offer both the `shellx-motion-debug-v1` and
  `shellx-motion-token.<token>` subprotocols.
- Everything except `GET /health` and the static workbench shell requires
  authentication. The server also rejects forged `Host` and unapproved `Origin`
  values and bounds request/WebSocket size and concurrency.

```bash
TOKEN="$(tr -d '\r\n' < /path/from-startup-manifest)"

curl -sS http://127.0.0.1:PORT/health

curl -sS http://127.0.0.1:PORT/debug \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"command":"motion.state","args":{"packageRoot":"/path/to/package"}}'
```

## Permission tiers

Tiers are ordered, and the tier the server is launched with is a **ceiling**: a
request may ask for a lower or equal tier, never a higher one. Packages and
prompts cannot grant themselves a higher tier.

```text
read_motion < draft_motion < render_motion < edit_motion < write_local < push_remote
```

- `read_motion` — inspect state, timelines, panels, and receipts.
- `draft_motion` — prompt runs plus playhead, range and viewport changes. These look like reads
  and are not: they move what the host is showing, so they sit one tier above `read_motion`.
- `render_motion` — preview or render local outputs.
- `edit_motion` — mutate a Motion package that already exists, into a new revision.
- `write_local` — create files outside an existing package. That includes **creating
  a new package** (`motion.package.create`), every importer and exporter, the
  connectors, and archive/extract.
- `push_remote` — **reserved and never automatic.** It exists only so a future
  hosted or repository-handoff surface can refuse it explicitly. The server
  requires a separate `--allow-push-remote` opt-in on top of a `push_remote` grant.

**`write_local` ranks above `edit_motion`.** The intuitive reading is the opposite
one, and acting on it fails: a server started at `--tier edit_motion` correctly
refuses `motion.package.create`, so an agent that has to author a package from
nothing needs a `write_local` grant, not an `edit_motion` one. The per-command tier
is contract data — `schemas/debug.json` carries the `permission` of every command
and `docs/public/DEBUG_API_COMMANDS.md` is generated from it. Read those, not this list,
when the answer has to be exact.

CLI elevation above a command's default requires `--trusted-local-tier`.

## Approved local script entries

`motion.package.script.author` is an MCP-only, host-gated authoring route for one
bounded inline `web`, `html`, or `canvas` entry in a copy-on-write **data-only**
package. A `write_local` tier alone is insufficient: the Debug host must have
injected its private approved-agent-entry authority and must observe this session
as an MCP agent. Do not try to pass an authority, attestation id, timestamp,
origin, package claim, CLI flag, or SDK option — none is accepted. Imports and
copies stay unapproved; secondary script/module/worker/frame loads are denied at render
time. The resulting receipt attests a host-approved local entry
and exact bytes, not semantic or human authorship. See [Security model](security-model.md#approved-agent-entry-provenance).
Active-content batch expansion is deliberately unavailable: copying a package does not copy its
host attestation. Render the attested package through a host-bound browser session instead.

## Machine-readable contracts

Prose can drift; the schemas are the source of truth. If prose and a schema
disagree, stop and repair the drift before you mutate or hand off.

- `schemas/actions.json` — discoverable workflows: ids, aliases, input schema,
  mutability, required permission tier, expected receipts, verification rule.
- `schemas/debug.json` — callable debug commands with their permission tiers and
  whether they mutate. The human-readable index is generated from it into
  `docs/public/DEBUG_API_COMMANDS.md`.
- `schemas/agent-snapshot.schema.json` — bounded `shellx-motion/agent-snapshot@1` output for the
  read-only compact command and optional fixed MCP resource.
- `schemas/motion.schema.json` and `schemas/package-manifest.schema.json` —
  package data.
- `schemas/cut-import-plan.schema.json` — the Cut connector plan
  (`shellx-motion/cut-import-plan@1`).
- `schemas/canvas-frame-selection.schema.json` — the Canvas frame-selection
  connector input (`shellx-motion/canvas-frame-selection@1`).
- `schemas/canvas-bridge-package.schema.json` — the Canvas-to-Motion package export
  (`shellx-motion/canvas-bridge-package@1`): manifest, Motion document, receipt, and
  verified integration evidence. It references the existing package, motion, and receipt schemas
  so those contracts remain single-sourced.

For a character or illustration whose pieces are already manually described, use the
data-only [`motion.timeline.cutout.rig.bake`](cutout-rigging.md) route at `edit_motion`.
It performs a copy-on-write sampled bake with a manifest-declared local PNG, never grants an
agent segmentation, a live parent graph, arbitrary code, or renderer-specific rig state.

`motion.canvas.bridge_export` produces a frame-selection artifact, whose schema is the
frame-selection contract above. `convertCanvasFrameToMotionPackage` then produces the canonical
bridge-package envelope. `writeCanvasMotionPackage` accepts id-less in-process exports made before
this schema as a narrow compatibility path; hosts exchanging JSON must use the versioned envelope.

For agent workflow rules and exact call examples, use the ShellX Motion agent
skill (`skill/shellx-motion/SKILL.md`) and its
`skill/shellx-motion/references/cli.md`.

## The evidence rule

Agent claims never satisfy a gate by themselves. Package diffs, preview/render
outputs, host-captured screenshots, and receipts are host-owned evidence. A
command that returns `ok: true` without an observable state change, output file,
screenshot difference, or receipt is a bug. See
[Receipts and trust](receipts-and-trust.md) for where each command's receipt
actually lands. CLI `render` returns its receipt inline and writes the same
receipt beside its output; `motion.render.final` persists its inline receipt when
the caller or server supplies a `receiptsRoot`. `validate` persists a typed passed
or failed receipt when a governed `receiptsRoot` is available, while keeping the
source package read-only.
