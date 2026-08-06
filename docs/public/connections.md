# Connect an agent

Start Motion from the source checkout:

```bash
pnpm start
```

Motion opens the local Workbench already unlocked. Choose **Connections** in the top navigation.
That page is the setup surface for people who do not want to edit configuration files:

1. Choose a supported agent and select **Configure**, or copy its displayed setup command.
2. Open a new agent session.
3. Keep Motion running while the agent uses Motion tools.

The page also shows a copyable stdio command for other MCP clients. Use that command as the MCP
server command in the client's local configuration. The bridge reads Motion's live loopback port
and private access key at call time, so the key is not embedded in the agent configuration. If
Motion is stopped, the bridge tells the agent to start Motion and retry.

Connections never exposes Motion's installation folder, Node executable, or internal bridge file.
The displayed commands use the installed `shellx-motion-mcp` entry point. One-click configuration
resolves the current source checkout or installed build privately inside Motion.

## Headless setup (no browser)

The flow above opens a browser, which a server, a container, or an agent-only machine may not have.
Nothing about Motion requires the Workbench — it is one client of the same Debug API — so start the
server directly instead:

```bash
pnpm --filter @shellx-motion/debug-server run serve -- \
  --persistent-access --tier render_motion --trusted-local-tier
```

That prints a JSON startup manifest with the bound URL, the granted tier, and every endpoint. It
opens no browser: `--open-workbench` is opt-in and absent here.

`--persistent-access` is what makes an MCP client work without the Connections page. It creates a
reusable per-user key and publishes the live port, both 0700 under `~/.shellx-motion/`:

```text
~/.shellx-motion/access.token   the key
~/.shellx-motion/server.port    the port the server actually bound
```

Point any MCP client at the bundled stdio bridge:

```json
{
  "mcpServers": {
    "shellx-motion": { "command": "shellx-motion-mcp", "args": [] }
  }
}
```

The bridge reads those two files at call time, which is why no key appears in the configuration
above. Set `SHELLX_MOTION_ACCESS_ROOT` if you need that state somewhere other than the home
directory — in a container, for instance. If Motion is not running, the bridge tells the agent to
start it and retry rather than failing silently.

Tier note: the server's `--tier` is a ceiling, and `--trusted-local-tier` is required for anything
above the `read_motion` default. Use `--tier write_local` if the agent has to CREATE packages, since
`write_local` outranks `edit_motion`.

## One local access key

Start Motion creates one private per-user key and reuses it across restarts. The same key protects:

- the Workbench;
- the MCP endpoint and bundled stdio bridge;
- the loopback Debug API.

The key is stored outside projects under the current user's Motion state directory with user-only
permissions. It is masked by default on the Connections page and can be revealed or copied when a
generic local API client needs it. Motion never asks for OAuth, certificates, or per-operation
approval prompts for ordinary local package creation, editing, and rendering.

## Direct Debug API access

Connections shows the current Debug API address. Direct clients send the displayed key as a Bearer
token:

```text
Authorization: Bearer <local-access-key>
```

The server is loopback-only. Its normal Start Motion grant allows local create/edit/render work but
does not enable remote publishing. Advanced hosts can still launch the server directly with a
narrower tier; see [Agent integration](agent-integration.md).
