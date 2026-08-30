# ShellX Motion Debug API

ShellX Motion's typed command authority is the local Debug API and its HTTP, WebSocket, and MCP
transports. The CLI and local SDK are deliberately bounded projections, not universal command
mirrors. The machine source of truth is `schemas/debug.json`; the complete generated command index is
[`DEBUG_API_COMMANDS.md`](DEBUG_API_COMMANDS.md). Agent-oriented argument examples live in
[`../../skill/shellx-motion/references/cli.md`](../../skill/shellx-motion/references/cli.md), with
render path and retention rules in
[`output-ownership.md`](../../skill/shellx-motion/references/output-ownership.md).

## Surface matrix

| Surface | Current callable inventory |
|---|---|
| Debug API / HTTP / WebSocket / MCP | **300** typed commands; MCP publishes the full registry. |
| CLI | **234 direct** `debug` routes, **7 semantic equivalents** (`connector catalog`, `package-create`, `validate`, `doctor`, `doctor --probe-gpu`, `job get`, `job list`), and **59 named no-route** Debug/MCP commands: `motion.agent.snapshot`, `motion.connector.submit`, `motion.job.submit/events/cancel/retry`, `motion.keying.inspect/apply/remove`, `motion.roto.upsert/tracking.detach/remove`, `motion.package.script.author`, `motion.timeline.checkpoint-storyboard.create/inspect/revise/remove/archive/materialize/detach/behavior.resolve/behavior.detach/relation.resolve/relation.detach/relation-action.resolve/relation-action.detach/lifecycle.resolve/lifecycle.detach/geometry-morph.resolve/geometry-morph.detach/retained-trace.resolve/retained-trace.detach/retained-trace.preview/retained-trace.review.bind/preview/creative-review.bind/preview-quality.review`, `motion.timeline.relations.inspect/upsert/enabled.set/remove/detach/bake`, `motion.timeline.relation-actions.inspect/upsert/remove/apply`, `motion.timeline.scene3d-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`, and `motion.timeline.layout-gap-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`. |
| Local SDK | **35 dedicated local-SDK operations**. It is a typed host API, not a generic command dispatcher. |
| Action discovery | **174 discoverable actions**. |

The static surface-parity regression reads the live registries and these named CLI exceptions; a
new command must therefore be classified before these counts can change.

## Discover before calling

Do not guess a command or mutation sequence:

```bash
shellx-motion actions find "track a product and attach a callout"
shellx-motion actions guide motion.analysis.tracking.request
shellx-motion actions plan "track a product and attach a callout"
shellx-motion debug actions-panel
```

Use `actions guide` for the selected workflow, then use the exact `motion.*` command and verify the
returned artifact, identity, receipt, and hash. `pnpm docs:check` proves that the human command index
still matches the schema. `pnpm debug:coverage` checks only its fixture-defined named-surface command
subset; it is not all-command execution or test coverage. Its generated numerator, denominator, and
limits are in [`DEBUG_API_COMMANDS.md`](DEBUG_API_COMMANDS.md#debug-coverage-gate-scope).

## Start the local server

For normal local use, start Motion with one persistent key and an already-unlocked Workbench:

```bash
pnpm start -- \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

Use Workbench **Connections** for one-click supported-agent setup, a generic stdio MCP command, and
the direct API address/key. The normal launcher grants a local `write_local` ceiling and does not
enable remote publishing. Package creation, caller-steered copy-on-write edits, and legacy connector
filesystem routes stay unavailable until the host configures their required authoring roots at
server launch. Caller-steered server package reads and preview/cache/final/batch work similarly
require the relevant host-owned render package, external-input, and output roots; request arguments
cannot mint them.

For advanced host integration, read-only is the default and a higher grant must be deliberate:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- \
  --tier render_motion --trusted-local-tier \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

Advanced startup prints one JSON manifest containing `url`, `workbenchUrl`, granted tier,
transports, and an `auth.tokenFile` path. Without `--persistent-access` or
`SHELLX_MOTION_DEBUG_TOKEN`, the capability is stored in a private ephemeral file and removed when
the server stops. Paste it into the Workbench Connect field or send it as a Bearer token; do not place
it in project files, shell history, logs, or URLs.

```bash
TOKEN="$(tr -d '\r\n' < /path/from-startup-manifest)"

curl -sS http://127.0.0.1:PORT/health

curl -sS http://127.0.0.1:PORT/debug/contracts \
  -H "authorization: Bearer $TOKEN"

curl -sS http://127.0.0.1:PORT/debug \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"command":"motion.state","args":{"packageRoot":"/path/to/package"}}'
```

The server grant is a ceiling. A request cannot elevate above it. There are six tiers, ranked
lowest to highest:

```text
read_motion < draft_motion < render_motion < edit_motion < write_local < push_remote
```

`write_local` ranks **above** `edit_motion`: `edit_motion` mutates a package that already exists,
while `write_local` creates files outside one — so `motion.package.create`, the importers, the
exporters, the connectors and archive/extract all need `write_local`, and a server granted
`edit_motion` refuses them. `push_remote` additionally requires an explicit server opt-in and is not
implied by local editing. The `permission` of every individual command is in `schemas/debug.json`
and the generated [`DEBUG_API_COMMANDS.md`](DEBUG_API_COMMANDS.md).

`motion.package.create`, caller-steered package edits, `motion.script.compile`, HTML snippet
import/export, and OTIO import/export require more than a `write_local` grant: the embedding host
must configure both `authoringInputRoots` and `authoringOutputRoots`. The retained legacy connector
routes use the same host authority with route-specific requirements: Canvas-to-MP4 and
Template-to-Cut require approved input and output roots; Canvas bridge export requires an approved
output root; and the Linux-only Cut Generate-to-Cut route requires an approved output root plus an
input root when it reads `scriptPath` rather than an inline script. On the bundled server those grants come only from
repeated `--authoring-input-root` and `--authoring-output-root` flags. Call arguments, including raw
HTTP, RPC, and MCP requests, cannot add or widen them. Motion checks canonical, non-symlink
containment immediately before it opens an adapter input or writes an adapter output; a missing
required root class fails closed before connector execution or destination creation.

The same path-role rule covers package archive/extract, review/support bundles and tracking
requests. Existing packages and archives are input authority; new packages, archives, review
directories and explicit receipt files are output authority; support output remains host-owned
scratch. Every accepted alias and array element is checked before a package loader, analyzer or
publication adapter runs. The authenticated server SDK uses the same tracking input/output rule.

Complete package and support-directory publications through `motion.canvas.package`,
`motion.script.compile`, `motion.support.bundle`, Canvas-to-MP4, and Cut Generate-to-Cut are
currently Linux-only because these operations require Motion's descriptor-relative exact
closed-tree primitive. macOS and Windows refuse before creating output state until an equivalent
native proof is implemented. The connector capability catalog reports only `linux` for
Canvas-to-MP4 and Cut Generate-to-Cut; each Debug command's generated argument contract states the
same restriction.

Retained receipt reads and receipt-derived controls currently use a separate Linux-only
descriptor-relative stable-reader capability. `motion.receipts.*`, receipt-backed prompt and render
queue/control commands, agent transcripts, receipt-backed support bundles, and
platform-verification summaries return
`capability_unavailable` on macOS and Windows before reading or writing receipt state; package-only
panels remain portable when no receipt evidence is requested. The playhead, range, and viewport
setters have the same boundary and refuse before creating `.shellx-motion` state. `motion.prompt.run`
remains portable, but `retainRawRequest: true` requires the Linux stable-reader/purge capability and
governed receipt persistence, and is refused before prompt execution or receipt writing on
unsupported hosts through both Debug and the direct CLI. Linux hosts must expose a usable
`/proc/self/fd` descriptor namespace; without it these operations return the same capability refusal.
Both Debug and the direct CLI retain that exact no-follow root through provider execution, persist
through the held descriptor, and recheck the deadline before returning or persisting a raw receipt.
This preserves the deletion deadline as a guarantee rather than silently retaining bytes a host
cannot safely purge.

Caller-steered read, draft, and render operations use a separate render-root policy. The bundled
server always enforces it: any such `packageRoot` must be inside a repeated
`--render-package-root`; external cache-plan/final/batch workflow, quality, or row files must be
inside a repeated `--render-input-root`; and caller-named `motion.preview.*`, SDK preview,
render-cache, final, or batch destinations must be inside a repeated `--render-output-root`.
An omitted preview destination remains under host-owned scratch. Missing root classes fail closed
before a package/data read or destination reservation. A completed native Workbench Browse
selection can add only that human-selected package/input/output location for the current server
session. Raw HTTP, RPC, MCP, and SDK fields cannot add or widen these roots. Standalone CLI commands
and a direct in-process SDK are their own local host and derive narrow authority from the current
operation; they do not require the server flags.

## Approved local script entry

[`motion.package.script.author`](DEBUG_API_COMMANDS.md#motionpackagescriptauthor) is the only
script-writing command. It is deliberately stricter than its `write_local` contract alone: the
dispatch must carry a server-established observed MCP session, and the trusted host must already
have injected an approved-agent-entry authority plus input/output roots. The server creates that
non-serializable authorization fact only after the first valid `2025-06-18` legacy MCP `initialize`
exchange (protocol version, capabilities, and named client info) on a persistent WebSocket connection.
The fact is connection-local, cleared on close, and never appears in a receipt or result. Stateless
`POST /rpc` (legacy or modern), a first WebSocket `tools/call`, malformed or duplicate initialize,
raw Debug/HTTP/WS, CLI, and SDK callers cannot self-declare the actor, metadata, session, or authority.
Those stateless MCP calls remain compatible for every other non-session-gated tool; this sensitive
route refuses them. Coordinator submission, query, and control also require either a trusted
server-configured `callerId` or a persistent WebSocket connection, as described below.
The command accepts one bounded inline local entry in a
copy-on-write data-only package; its closed input has no path/origin/style escape hatch, it never
imports or loads secondary script/module/worker/frame code, and it exposes no marketplace toggle. Its
host receipt records requested/active mode, resolver version, source hashes, and non-secret
attestation evidence without revealing the private receipt-store path. See [the security model](security-model.md#approved-agent-entry-provenance).

## Enforced-untrusted browser mode is not a Debug API command

Neither the Debug API nor MCP exposes `untrustedExecution`. A package, prompt, CLI request, SDK
request, or Debug/MCP caller therefore cannot nominate itself for the Linux-only
`enforced-untrusted` browser profile. It is an explicit direct renderer-host decision through
`BrowserRenderSessionOptions`, after that trusted host has independently classified a package as
untrusted. The profile accepts data-only packages, refuses approved network access and Chromium's
`--no-sandbox` opt-out, and requires verified Bubblewrap plus Motion's fixed launcher. It does not
provide FFmpeg/FFprobe containment, seccomp, or Windows/macOS equivalence. See [the host
integration boundary](host-integration.md#enforced-untrusted-browser-renderer-trusted-host-configuration-only)
before embedding it.

## Routes and transports

| Route | Purpose |
|---|---|
| `GET /health` | Minimal unauthenticated liveness and contract count. |
| `GET /debug/contracts` | Authenticated command/domain/tier/mutation registry. |
| `POST /debug` | Native `{command,args,requestedTier?}` dispatch. |
| `POST /rpc` | Authenticated JSON-RPC discovery and MCP-compatible tool dispatch. The bundled local MCP bridge uses a private per-start listener credential instead of forwarding the durable Bearer capability. |
| `WS /ws` | Authenticated persistent JSON-RPC transport. The bundled local MCP bridge uses the same private per-start listener credential. |
| `POST /sdk` | Typed local SDK operation dispatch for trusted hosts. |
| `GET /workbench` | Standalone local Motion editor shell; Start Motion authenticates its first tab automatically. |
| `POST /workbench/bootstrap` | One-use exchange used only by the locally opened Start Motion tab. |
| `GET /workbench/connections` | Human agent/API connection and local-key configuration surface. |
| `POST /workbench/artifact-session` | Authenticated Workbench browser-session exchange for opaque preview handles. |
| `GET /workbench/artifact?handle=` | Authenticated, browser-session-bound preview artifact serving; raw paths are never accepted. |
| `GET /workbench/poster?handle=` | Authenticated, browser-session-bound serving for poster handles returned with that session's `motion.template.catalog` result; raw paths are never accepted. |
| `GET /workbench/update-state` | Authenticated cached startup/periodic update status shared with agent discovery. |
| `POST /workbench/select-path` | Authenticated native file/folder chooser for human Browse actions. |

Raw `POST /debug` keeps the typed Debug result body and uses the outer HTTP status only as an
additional transport signal. Its bounded policy is:

| Status | Raw Debug meaning |
|---|---|
| `200` | The typed result has `ok: true`. |
| `400` | Invalid command arguments or a malformed bounded request. |
| `403` | The authenticated caller lacks the required permission or host-configured authority. |
| `404` | The command/resource is unknown, including privacy-preserving job lookup. |
| `409` | An immutable output, lock, cache, or streaming state conflicts with this request. |
| `410` | A known job record expired; follow the receipt fallback in [Job status](JOB_STATUS.md). |
| `413` | The request body exceeded the server's fixed byte limit. |
| `422` | The request is understood but its path topology, feature, or deterministic resource/refusal contract is not admissible. |
| `429` | The bounded queue or request capacity is full. Motion does not emit `Retry-After` because it has no truthful delay estimate. |
| `503` | A required host runtime, encoder, sandbox, GPU service, or containment capability is unavailable. |
| `500` | The typed error remains opaque or represents an otherwise unclassified engine failure. |

Always branch on the typed `error.code` and use `suggestedAction` when present; the status class does
not replace either field. `POST /rpc`, WebSocket JSON-RPC, and MCP keep their protocol-defined HTTP
status/envelope behavior and do not adopt this raw-route status table.

`POST /rpc` supports modern MCP `2026-07-28` (`server/discover`, per-request `_meta`, mirrored MCP
HTTP headers, annotated tools, and `resultType: "complete"`) alongside the legacy `2025-06-18`
initialize/list/call flow. Both modes enforce the same authenticated server grant and command
argument contracts. `server/discover`, `rpc.discover`, and legacy `serverInfo.update` report the
same cached update status shown on the Workbench About page; agents should not query the release
feed separately.

### Coordinator ownership across transports

`motion.connector.submit` and `motion.job.submit`, `.get`, `.list`, `.events`, `.cancel`, and
`.retry` are owner-scoped. Stateless `POST /debug` and `POST /rpc` calls require a trusted `callerId`
configured by the server host; a Bearer token or request argument never becomes an owner. `WS /ws`
receives an opaque server-minted owner for its connection lifetime. The bundled
`shellx-motion-mcp` bridge uses one such WebSocket for coordinator tools in one stdio process, so a
submit and later query/control calls from that same process see the same jobs. A reconnect or a
separate bridge process receives another owner and cannot retrieve the prior process's jobs. Use a
trusted direct host with a stable configured `callerId` when an asynchronous workflow must survive
independent client processes.

For context-constrained agents, `motion.agent.snapshot` returns the compact read-only
`shellx-motion/agent-snapshot@1` contract. It is path-free, has no cache or receipt side effect,
caps final UTF-8 output at 12,288 bytes, and uses a stable content `snapshotId`. The hash excludes
the top-level and per-source observation clocks, while `freshness.package`, `.timeline`, `.receipts`,
and `.jobs` retain honest `observedAt`/`complete` facts. Its compact package fingerprint, persisted
timeline controls and counts, receipt status/count exactness plus recent `createdAt`, and own-job
outcome/creation/poll/warning-count facts let an agent decide the next typed call without a broad
state read. Job facts are complete only when the host has an authenticated owner principal; without
one the job projection is empty and inexact with an explicit warning. Caller-supplied `packageRoot`
and `receiptsRoot` require host-governed roots and
symlink-safe containment checks. The request is never echoed; projected text is bounded and
sanitized. `schemas/agent-snapshot.schema.json` defines every nested output shape and maximum.

Hosts that explicitly set `agentSnapshotSource` also advertise one MCP resource:
`motion://shellx-motion/agent/snapshot`. Modern `server/discover` and legacy `initialize` then add
`resources: { listChanged: false }`; `resources/list` has one entry and `resources/read` accepts
only that exact URI. The resource invokes the shared snapshot projector with host-owned roots, uses
the authenticated caller's own-job scope, and is absent altogether when unconfigured. It supports
no URI query, path selection, template, subscription, cache, generic command dispatch, receipt
write, or receipt-selected read.

The debug server binds loopback by default, rejects forged Host and unapproved Origin values, bounds
request and WebSocket concurrency/size, and requires authentication for everything except health and
static workbench files. The installed MCP bridge reads only a private, per-server-start discovery
record after the listener binds; it never forwards the durable Bearer capability to the discovered
port. A stale record rebound after a crash can therefore receive only a credential that died with
the prior listener, while a restart publishes a new one. The record is owner-private on supported
hosts; this boundary does not make a same-user process a distinct trusted principal. Direct
non-loopback binding is disabled. If a trusted tunnel or reverse proxy is ever added, it must provide
its own authentication and explicit host/origin policy.

## Agent-runtime prerequisite

`motion.prompt.run` and `motion.agent.health` are host capabilities, not process-discovery
shortcuts. A Debug API, debug-server, or MCP host must explicitly inject the respective prompt or
agent runtime into its Motion debug context. Without it, the command returns
`capability_unavailable` before any agent command runs. Command discovery remains stable, so an
agent can discover the command and receive that truthful host-capability refusal.

The source CLI is the intentional local-host exception: `shellx-motion prompt run`, `agent health`,
`debug prompt-run`, and `debug agent-health` inject `buildAgentRuntime()` unless an embedding caller
provides a runtime through `RunCliOptions`. This is not a simulated mode; the retired `--fake`
options remain refused.

## Command families

The generated index currently groups the surface into `surface`, `workspace`, `timeline`, `render`,
`authoring`, `integration`, and `agent` domains. The important ownership split is:

- `motion.timeline.*` edits packages, keyframes, curves, ranges, layers, tracks, captions, and
  transitions through validated revisions.
- `motion.timeline.layer.rich.set` owns bounded scalar rich controls, including browser path
  reveal `pathReveal.start` and `pathReveal.end`; generic `motion.timeline.keyframe.upsert` animates
  either target after the path owner has been declared. See [path-reveals.md](path-reveals.md).
- The same existing rich setter edits declared particles/points `effects.trail.durationMs` and
  `effects.trail.samples`. These are static bounded CPU-lookback settings, not keyframe targets and
  not a new command. See [trails.md](trails.md).
- `motion.timeline.cutout.rig.bake` is the bounded author-time character/illustration cutout
  route: it accepts a data-only rig and emits ordinary cropped image layers plus sampled transform
  tracks through a copy-on-write revision. See [cutout-rigging.md](cutout-rigging.md); this is not
  a live hierarchy or automatic segmentation API.
- `motion.preview.*`, `motion.render.*`, and `motion.quality.*` produce evidence and receipts; an
  envelope alone is not proof of a valid artifact.
- `motion.analysis.tracking.*`, `motion.keying.*`, `motion.roto.*`, `motion.compositing.*`, and
  `motion.procedural.*` keep advanced effect ownership in Motion.
- `motion.connector.*`, `motion.canvas.*`, `motion.cut.*`, package/import/export commands, and
  integration capability queries perform bounded host interchange with explicit lossiness or
  rendered fallback.
- `motion.prompt.*` and `motion.agent.*` plan or execute only within the granted tier; package data
  and prompts cannot elevate permissions.

Use [`FEATURES.md`](FEATURES.md) for the implemented capability boundary and the Design Studio/Cut
ownership rules.
