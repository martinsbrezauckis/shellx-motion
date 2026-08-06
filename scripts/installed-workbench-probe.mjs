/**
 * JavaScript evaluated from a freshly installed @shellx-motion/debug-server package.
 *
 * Keep this as a raw template: ordinary template-literal processing consumes the backslashes in
 * regex literals and quoted escapes before Node parses the generated module.
 */
export function installedWorkbenchProbeSource() {
  return String.raw`
    import { startMotionDebugServer } from "@shellx-motion/debug-server";
    const token = "installed-workbench-probe-token-000000000000000000";
    const server = await startMotionDebugServer({ port: 0, capabilityToken: token, grantedTier: "write_local" });
    try {
      const headers = { authorization: "Bearer " + token };
      const [page, docs, connections] = await Promise.all([
        fetch(new URL("/workbench/connections", server.url)),
        fetch(new URL("/workbench/docs/index.json", server.url), { headers }),
        fetch(new URL("/workbench/connections/state", server.url), { headers })
      ]);
      const docsBody = await docs.json();
      const connectionsBody = await connections.json();
      console.log(JSON.stringify({
        ok: page.status === 200 && docs.status === 200 && connections.status === 200,
        hasConnectionsDoc: docsBody.sections.flatMap((section) => section.pages).some((entry) => entry.id === "connections"),
        hasPortableBridgeCommand: connectionsBody.setupCommands?.generic === "shellx-motion-mcp",
        leaksBridgePath: "bridge" in connectionsBody || /shellx-motion-mcp\.mjs|[A-Za-z]:[\\/]|\/(?:home|Users|private|tmp|var|opt|usr|Applications|Volumes|mnt)\//.test(
          Object.values(connectionsBody.setupCommands || {}).join("\n")
        )
      }));
    } finally {
      await server.close();
    }
  `;
}
