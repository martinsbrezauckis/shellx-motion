# Agent integration

ShellX Motion is agent-first: the first product surface is a typed action/debug
contract, not a visual-only editor. A local CLI subscription agent, the Engine
Room prompt box, Design Studio, ShellX Cut, or any agent workflow runner all drive the
**same** contracts. This page describes the transports, authentication, and
permission tiers, and points at the machine-readable schemas.

> **Invoking the CLI.** Shell commands on this page are written as `shellx-motion <command>` — the
> single `bin` the `@shellx-motion/cli` package publishes. From a ShellX Motion source checkout, run
> them as `pnpm --filter @shellx-motion/cli run cli -- <command>` instead. There is no `motion` binary
> in either form; dotted names such as `motion.render.final` are Debug API / MCP command ids, not
> shell commands. See [Quickstart](quickstart.md).

## The three transports

Every transport dispatches the same typed commands; pick the one that fits your host.

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
- **MCP transport.** Generated from the same action/debug registry over
  `POST /rpc`. Modern clients use protocol `2026-07-28`: call `server/discover`
  without an initialize handshake, send protocol version and client
  capabilities in each request's `_meta`, and mirror the version/method/tool
  name in the MCP HTTP headers. Legacy `2025-06-18` clients may continue using
  `initialize`, `tools/list`, and `tools/call`. Each debug command becomes a tool
  named by replacing the dots in the command id with underscores, so `motion.render.final` becomes
  the tool `motion_render_final`; annotations declare its
  read-only/mutating shape from the same command contract. Discovery also
  reports the engine's cached update status (`currentVersion`, `latestVersion`,
  `updateAvailable`, and `checkedAt`). That is the same startup/periodic result
  shown in About; agents read it instead of making a separate release-channel
  request.

Discover before you call. An unknown `motion.*` id returns no action; it never
falls through to a vaguely related workflow.

```bash
shellx-motion actions find "track a product and attach a callout"
shellx-motion actions guide motion.analysis.tracking.request
shellx-motion actions plan  "track a product and attach a callout"
```

## Authentication and the loopback server

For ordinary local agent use, start Motion and configure the agent from Workbench **Connections**:

```bash
pnpm start
```

Start Motion creates or reuses one private per-user access key, publishes the live loopback port,
opens an authenticated Workbench, and grants local create/edit/render access. The bundled stdio MCP
bridge reads the key and port at call time, so agent configurations contain no Bearer token. A
stopped engine produces a clear instruction to start Motion and retry. See
[Connect an agent](connections.md).

Advanced hosts can instead start the server with a narrower grant:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- \
  --tier render_motion --trusted-local-tier
```

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

## Machine-readable contracts

Prose can drift; the schemas are the source of truth. If prose and a schema
disagree, stop and repair the drift before you mutate or hand off.

- `schemas/actions.json` — discoverable workflows: ids, aliases, input schema,
  mutability, required permission tier, expected receipts, verification rule.
- `schemas/debug.json` — callable debug commands with their permission tiers and
  whether they mutate. The human-readable index is generated from it into
  `docs/public/DEBUG_API_COMMANDS.md`.
- `schemas/motion.schema.json` and `schemas/package-manifest.schema.json` —
  package data.
- `schemas/cut-import-plan.schema.json` — the Cut connector plan
  (`shellx-motion/cut-import-plan@1`).
- `schemas/canvas-frame-selection.schema.json` — the Canvas frame-selection
  connector input (`shellx-motion/canvas-frame-selection@1`).

The Canvas bridge *export* payload has no schema file. The integration protocol
advertises `shellx-motion/canvas-bridge-package@1`
(`HOST_CAPABILITIES` in `packages/core/src/integration-protocol.ts`), but its
only definition is the TypeScript type in
`packages/connectors/src/canvas-bridge.ts`. Read that source rather than looking
for a schema.

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
the caller or server supplies a `receiptsRoot`. `validate` produces none at all.
