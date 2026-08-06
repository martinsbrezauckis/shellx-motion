# ShellX Motion Debug API

ShellX Motion exposes the same typed command contracts to its CLI wrapper, local loopback debug
server, standalone workbench, Design Studio host, and Cut integration. The machine source of truth is
`schemas/debug.json`; the complete generated command index is
[`DEBUG_API_COMMANDS.md`](DEBUG_API_COMMANDS.md). Agent-oriented argument examples live in
[`../../skill/shellx-motion/references/cli.md`](../../skill/shellx-motion/references/cli.md).

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
still matches the schema. `pnpm debug:coverage` proves that registered debug commands remain covered
by the action/debug implementation.

## Start the local server

For normal local use, start Motion with one persistent key and an already-unlocked Workbench:

```bash
pnpm start
```

Use Workbench **Connections** for one-click supported-agent setup, a generic stdio MCP command, and
the direct API address/key. The normal launcher grants local create/edit/render work and does not
enable remote publishing.

For advanced host integration, read-only is the default and a higher grant must be deliberate:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- \
  --tier render_motion --trusted-local-tier
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

## Routes and transports

| Route | Purpose |
|---|---|
| `GET /health` | Minimal unauthenticated liveness and contract count. |
| `GET /debug/contracts` | Authenticated command/domain/tier/mutation registry. |
| `POST /debug` | Native `{command,args,requestedTier?}` dispatch. |
| `POST /rpc` | Authenticated JSON-RPC discovery and MCP-compatible tool dispatch. |
| `WS /ws` | Authenticated persistent JSON-RPC transport. |
| `POST /sdk` | Typed local SDK operation dispatch for trusted hosts. |
| `GET /workbench` | Standalone local Motion editor shell; Start Motion authenticates its first tab automatically. |
| `POST /workbench/bootstrap` | One-use exchange used only by the locally opened Start Motion tab. |
| `GET /workbench/connections` | Human agent/API connection and local-key configuration surface. |
| `GET /workbench/artifact?path=` | Authenticated, allowlisted preview artifact serving. |
| `GET /workbench/update-state` | Authenticated cached startup/periodic update status shared with agent discovery. |
| `POST /workbench/select-path` | Authenticated native file/folder chooser for human Browse actions. |

`POST /rpc` supports modern MCP `2026-07-28` (`server/discover`, per-request `_meta`, mirrored MCP
HTTP headers, annotated tools, and `resultType: "complete"`) alongside the legacy `2025-06-18`
initialize/list/call flow. Both modes enforce the same authenticated server grant and command
argument contracts. `server/discover`, `rpc.discover`, and legacy `serverInfo.update` report the
same cached update status shown on the Workbench About page; agents should not query the release
feed separately.

The debug server binds loopback by default, rejects forged Host and unapproved Origin values, bounds
request and WebSocket concurrency/size, and requires authentication for everything except health and
static workbench files. Direct non-loopback binding is disabled. If a trusted tunnel or reverse
proxy is ever added, it must provide its own authentication and explicit host/origin policy.

## Command families

The generated index currently groups the surface into `surface`, `workspace`, `timeline`, `render`,
`authoring`, `integration`, and `agent` domains. The important ownership split is:

- `motion.timeline.*` edits packages, keyframes, curves, ranges, layers, tracks, captions, and
  transitions through validated revisions.
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
