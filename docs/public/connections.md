# Connect an agent

Start Motion from the source checkout:

```bash
pnpm start -- \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

Motion opens the local Workbench already unlocked. Choose **Connections** in the top navigation.
That page is the setup surface for people who do not want to edit configuration files:

1. Choose a supported agent and select **Configure**, or copy its displayed setup command.
2. Open a new agent session.
3. Keep Motion running while the agent uses Motion tools.

The page also shows a copyable stdio command for other MCP clients. Use that command as the MCP
server command in the client's local configuration. The bridge reads Motion's private live
per-start discovery record at call time, so no durable access key is embedded in the agent
configuration or forwarded to the discovered port. When it first calls a coordinator job tool, the
bridge opens an authenticated persistent WebSocket and keeps
that connection for the stdio process. It uses the roots fixed when Motion started; MCP configuration
and tool arguments cannot add or widen them. Keep one configured bridge process alive for a
coordinator job's submit/query/control sequence: that process has one opaque server-minted owner.
A new bridge process or reconnect has a different owner and cannot see the prior process's jobs.
If Motion is stopped, the bridge tells the agent to start Motion and retry.

Connections never exposes Motion's installation folder, Node executable, or internal bridge file.
The displayed commands use the installed `shellx-motion-mcp` entry point. One-click configuration
resolves the current source checkout or installed build privately inside Motion.

## Headless setup (no browser)

The flow above opens a browser, which a server, a container, or an agent-only machine may not have.
Nothing about Motion requires the Workbench — it is one client of the same Debug API — so start the
server directly instead:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- \
  --persistent-access --tier write_local --trusted-local-tier \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

That prints a JSON startup manifest with the bound URL, the granted tier, and every endpoint. It
opens no browser: `--open-workbench` is opt-in and absent here.

`--persistent-access` is what makes an MCP client work without the Connections page. It creates a
reusable per-user key plus a fresh private discovery record for each running listener, all
owner-private under `~/.shellx-motion/`:

```text
~/.shellx-motion/access.token                 durable key for direct clients
~/.shellx-motion/mcp-bridge.discovery.json   live port and per-start bridge credential
```

Point any MCP client at the bundled stdio bridge:

```json
{
  "mcpServers": {
    "shellx-motion": { "command": "shellx-motion-mcp", "args": [] }
  }
}
```

The bridge reads only the per-start discovery record at call time, which is why no durable key
appears in the configuration above or reaches a stale/rebound listener after a crash. Coordinator
tools open or reuse a persistent connection after that read. Set
`SHELLX_MOTION_ACCESS_ROOT` if you need that state somewhere other than the home directory — in a
container, for instance. If Motion is not running, the bridge tells the agent to start it and retry
rather than failing silently.

For `motion.connector.submit` and `motion.job.submit`, `.get`, `.list`, `.events`, `.cancel`, and
`.retry`, keep the same stdio bridge process alive. It holds one opaque owner principal for its
WebSocket lifetime, so its later tool calls can see only the jobs it submitted. Do not launch a fresh
`shellx-motion-mcp` process for each poll or control call: it receives a new owner and cannot recover
the earlier process's jobs. For a workflow that must continue across independent processes, use a
trusted direct host configured with a stable server-side `callerId`; callers cannot pass or choose
that value in MCP arguments.

Tier note: the server's `--tier` is a ceiling, and `--trusted-local-tier` is required for anything
above the `read_motion` default. Use `--tier write_local` if the agent has to CREATE packages, since
`write_local` outranks `edit_motion`.

The paired authoring roots are also required for package authoring: the input root contains existing
packages the agent may copy and edit, while the output root receives a new package or revision.
Omit either root to make `motion.package.create` and caller-steered package edits refuse. They are
server-launch policy, not MCP client settings; restart Motion with a changed pair rather than placing
paths in an MCP configuration or tool call.

The paired authoring roots do not authorize caller-steered package reads or rendering. Server/MCP/
SDK read, draft, and render operations separately require the relevant host-owned render package,
external-input, and output roots shown above. `packageRoot`, external cache/final/batch input paths,
and caller-named preview/cache/final/batch destinations are checked against those launch grants;
they never create grants. An omitted preview destination stays in host-owned scratch. A human
Workbench Browse result can add only the selected location for the current session. Headless MCP
clients must use launch flags because no person is present to complete that chooser.

## One local access key

Start Motion creates one private per-user key and reuses it across restarts. The key protects:

- the Workbench;
- direct MCP endpoint clients;
- the loopback Debug API.

The bundled stdio bridge instead uses an owner-private credential that is random for each bound
listener and valid only for that listener; it never reads or forwards the durable key. The key and
bridge record are stored outside projects under the current user's Motion state directory with
user-only permissions. This is not a shared-user isolation claim: another process running as the
same OS user is outside this boundary. The durable key is masked by default on the Connections page
and can be revealed or copied when a generic local API client needs it. Motion never asks for OAuth, certificates, or per-operation
approval prompts for ordinary local rendering. Package creation and edits additionally require the
host to have supplied the paired authoring roots at Motion startup. Caller-steered package reads and
render work require the relevant separate render roots or a human-completed session Browse grant.
Archive/extract, review/support bundle and tracking-request paths are checked against their host
input/output/scratch roles before work starts; root aliases and arrays do not create authority.

## Direct Debug API access

Connections shows the current Debug API address. Direct clients send the displayed key as a Bearer
token:

```text
Authorization: Bearer <local-access-key>
```

The server is loopback-only. Its normal Start Motion grant allows local render work but does not
enable remote publishing. Package creation and copy-on-write editing are available only with both
authoring roots set at server launch. Advanced hosts can still launch the server directly with a
narrower tier; see [Agent integration](agent-integration.md).
