/**
 * Keep the public Debug/MCP checkpoint-storyboard wording deliberate without fabricating an
 * action-surface or CLI route. The command family remains version-unassigned and host-owned;
 * this only guarantees that callers of its existing published contract receive useful purposes.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { purposeForCall } from "../packages/actions/src/catalog.js";
import { SURFACE_COMMANDS } from "../packages/actions/src/catalog-surface-commands.js";
import { AGENT_REFERENCE_PURPOSE_COMMANDS, DEBUG_COMMAND_CONTRACTS } from "../packages/debug-api/src/command-metadata.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "../packages/debug-api/src/domains/checkpoint-storyboard-record-lifecycle.js";
import { mcpToolForDebugContract } from "../packages/debug-server/src/mcp-tool-shape.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkpointCommands = Object.values(CHECKPOINT_STORYBOARD_RECORD_COMMANDS);
const contractsByCommand = new Map(DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]));
const surfaceCommands = new Set(Object.values(SURFACE_COMMANDS).flat());

describe("checkpoint-storyboard published-purpose contract", () => {
  it("adds reviewed purposes for exactly the existing Debug/MCP family without action-surface coverage", () => {
    const auditedFamily = AGENT_REFERENCE_PURPOSE_COMMANDS
      .filter((command) => command.startsWith("motion.timeline.checkpoint-storyboard."));

    expect(auditedFamily).toEqual(checkpointCommands);
    for (const command of checkpointCommands) {
      expect(purposeForCall(command), command).not.toBe(`Run ${command}.`);
      const contract = contractsByCommand.get(command);
      expect(contract?.purpose, command).toMatch(new RegExp(`^${escapeRegExp(purposeForCall(command))}`));
      expect((mcpToolForDebugContract(contract!).description as string).startsWith(purposeForCall(command)), command).toBe(true);
      expect(surfaceCommands.has(command), command).toBe(false);
    }
  });

  it("carries the same purpose text to the generated public schema and reference", () => {
    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/debug.json"), "utf8")) as {
      contracts: Array<{ command: string; purpose?: string }>;
    };
    const reference = readFileSync(resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md"), "utf8");
    const schemaPurposes = new Map(schema.contracts.map((contract) => [contract.command, contract.purpose]));

    for (const command of checkpointCommands) {
      const purpose = contractsByCommand.get(command)!.purpose!;
      expect(schemaPurposes.get(command), `${command} schema purpose`).toBe(purpose);
      expect(reference, `${command} generated reference heading`).toContain(`### \`${command}\`\n\n`);
      expect(reference, `${command} generated reference purpose`).toContain(`**Purpose:** ${purpose}`);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
