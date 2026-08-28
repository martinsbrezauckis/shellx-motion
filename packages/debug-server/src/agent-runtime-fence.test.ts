import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startMotionDebugServer, type MotionDebugServerHandle, type MotionDebugServerOptions } from "./index";

const TEST_CAPABILITY_TOKEN = "test-capability-token-000000000000000000000000";

function startTestServer({ context, ...options }: MotionDebugServerOptions = {}): Promise<MotionDebugServerHandle> {
  return startMotionDebugServer({
    ...options,
    capabilityToken: TEST_CAPABILITY_TOKEN,
    useDefaultTemplateRoots: false,
    context: { scratchRoot: join(process.cwd(), ".scratch", "agent-runtime-fence-uncreated"), ...context }
  });
}

function fetch(url: URL, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${TEST_CAPABILITY_TOKEN}`
    }
  });
}

describe("debug server agent runtime fence", () => {
  it("requires host-injected runtimes across HTTP and MCP dispatch", async () => {
    const noRuntimeServer = await startTestServer({ port: 0, grantedTier: "draft_motion" });
    try {
      const health = await fetch(new URL("/debug", noRuntimeServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.agent.health", args: {} })
      });
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({
        ok: false,
        command: "motion.agent.health",
        error: { code: "capability_unavailable", message: expect.stringContaining("did not inject an agent runtime") }
      });

      const prompt = await fetch(new URL("/rpc", noRuntimeServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "no-prompt-runtime",
          method: "tools/call",
          params: {
            name: "motion_prompt_run",
            arguments: { requestedTier: "draft_motion", args: { request: "inspect the package" } }
          }
        })
      });
      expect(prompt.status).toBe(200);
      expect(await prompt.json()).toMatchObject({
        jsonrpc: "2.0",
        id: "no-prompt-runtime",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            command: "motion.prompt.run",
            error: { code: "capability_unavailable", message: expect.stringContaining("did not inject a prompt runtime") }
          }
        }
      });
    } finally {
      await noRuntimeServer.close();
    }

    let healthCalls = 0;
    const injectedServer = await startTestServer({
      port: 0,
      context: {
        agentRuntime: {
          health: async () => {
            healthCalls += 1;
            return [{
              agentId: "injected",
              available: true,
              command: "shellx-motion-injected-agent",
              transport: "local-cli",
              billing: "cli-subscription",
              detail: "injected agent 0.0.0",
              status: "ready",
              version: "injected agent 0.0.0",
              setup: {
                checkCommand: "shellx-motion-injected-agent --version",
                installHint: "Install the injected agent.",
                authHint: "Authenticate the injected agent.",
                quotaHint: "Check the injected agent quota."
              },
              probe: { executable: "shellx-motion-injected-agent", args: ["--version"], shell: false }
            }];
          }
        }
      }
    });
    try {
      const health = await fetch(new URL("/debug", injectedServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.agent.health", args: {} })
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, result: { ok: true, agents: [{ agentId: "injected" }] } });

      const mcpHealth = await fetch(new URL("/rpc", injectedServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "injected-agent-runtime",
          method: "tools/call",
          params: { name: "motion_agent_health", arguments: { args: {} } }
        })
      });
      expect(mcpHealth.status).toBe(200);
      expect(await mcpHealth.json()).toMatchObject({
        jsonrpc: "2.0",
        id: "injected-agent-runtime",
        result: { isError: false, structuredContent: { ok: true, command: "motion.agent.health", result: { agents: [{ agentId: "injected" }] } } }
      });
      expect(healthCalls).toBe(2);
    } finally {
      await injectedServer.close();
    }
  });
});
