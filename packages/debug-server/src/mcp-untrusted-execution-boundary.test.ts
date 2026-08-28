import { describe, expect, it } from "vitest";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { mcpToolForDebugContract } from "./mcp-tool-shape";

describe("MCP enforced-untrusted renderer boundary", () => {
  it("does not publish the trusted renderer-host policy in any tool argument schema", () => {
    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      const tool = mcpToolForDebugContract(contract) as {
        inputSchema?: { properties?: { args?: { properties?: Record<string, unknown> } } };
      };
      expect(tool.inputSchema?.properties?.args?.properties ?? {}, contract.command)
        .not.toHaveProperty("untrustedExecution");
    }
  });
});
