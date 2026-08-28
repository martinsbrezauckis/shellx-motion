/**
 * Keep the public particle-structural Debug/MCP purposes exact, generated, and surface-honest.
 *
 * The family already has direct CLI routes but no Action-surface coverage. Publishing semantic
 * purposes must not turn this review into a route-creation change.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { purposeForCall } from "../packages/actions/src/catalog.js";
import { SURFACE_COMMANDS } from "../packages/actions/src/catalog-surface-commands.js";
import { CLI_DIRECT_DEBUG_COMMANDS } from "../packages/cli/src/debug-subcommands.js";
import { AGENT_REFERENCE_PURPOSE_COMMANDS, DEBUG_COMMAND_CONTRACTS } from "../packages/debug-api/src/command-metadata.js";
import { TIMELINE_PARTICLE_STRUCTURAL_COMMANDS } from "../packages/debug-api/src/domains/timeline-particle-structural.js";
import { mcpToolForDebugContract } from "../packages/debug-server/src/mcp-tool-shape.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const particleCommands = Object.values(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS);
const contractsByCommand = new Map(DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]));

describe("particle-structural published-purpose contract", () => {
  it("adds reviewed purposes for exactly the existing Debug/MCP family while preserving its route boundary", () => {
    const auditedFamily = AGENT_REFERENCE_PURPOSE_COMMANDS
      .filter((command) => command.startsWith("motion.timeline.particles."));
    const cliFamily = Object.values(CLI_DIRECT_DEBUG_COMMANDS)
      .filter((command) => command.startsWith("motion.timeline.particles."));
    const actionFamily = Object.values(SURFACE_COMMANDS).flat()
      .filter((command) => command.startsWith("motion.timeline.particles."));

    expect(particleCommands).toHaveLength(16);
    expect(new Set(particleCommands)).toHaveLength(16);
    expect(auditedFamily).toEqual(particleCommands);
    expect(cliFamily).toEqual(particleCommands);
    expect(actionFamily).toEqual([]);

    for (const command of particleCommands) {
      const purpose = purposeForCall(command);
      const contract = contractsByCommand.get(command);

      expect(purpose, command).not.toBe(`Run ${command}.`);
      expect(contract?.purpose, command).toMatch(new RegExp(`^${escapeRegExp(purpose)}`));
      expect((mcpToolForDebugContract(contract!).description as string).startsWith(purpose), command).toBe(true);
    }
  });

  it("carries the same purposes to the generated public schema and Debug reference", () => {
    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/debug.json"), "utf8")) as {
      contracts: Array<{ command: string; purpose?: string }>;
    };
    const reference = readFileSync(resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md"), "utf8");
    const schemaPurposes = new Map(schema.contracts.map((contract) => [contract.command, contract.purpose]));

    for (const command of particleCommands) {
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
