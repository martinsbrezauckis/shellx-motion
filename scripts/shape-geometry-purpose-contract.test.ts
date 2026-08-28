/**
 * Keep the published shape-geometry Debug/MCP purposes exact, generated, and surface-honest.
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
import { TIMELINE_SHAPE_GEOMETRY_COMMANDS } from "../packages/debug-api/src/domains/timeline-shape-geometry.js";
import { TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS } from "../packages/debug-api/src/domains/timeline-shape-geometry-keyframes.js";
import { mcpToolForDebugContract } from "../packages/debug-server/src/mcp-tool-shape.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shapeGeometryCommands = [
  ...Object.values(TIMELINE_SHAPE_GEOMETRY_COMMANDS),
  ...Object.values(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS),
];
const contractsByCommand = new Map(DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]));
const isShapeGeometryCommand = (command: string) => command.startsWith("motion.timeline.shape.geometry.")
  || command.startsWith("motion.timeline.shape.geometry-keyframes.");

describe("shape-geometry published-purpose contract", () => {
  it("adds reviewed purposes for exactly the existing Debug/MCP family while preserving its route boundary", () => {
    const auditedFamily = AGENT_REFERENCE_PURPOSE_COMMANDS.filter(isShapeGeometryCommand);
    const cliFamily = Object.values(CLI_DIRECT_DEBUG_COMMANDS).filter(isShapeGeometryCommand);
    const actionFamily = Object.values(SURFACE_COMMANDS).flat().filter(isShapeGeometryCommand);

    expect(shapeGeometryCommands).toHaveLength(15);
    expect(new Set(shapeGeometryCommands)).toHaveLength(15);
    expect(auditedFamily).toEqual(shapeGeometryCommands);
    expect([...cliFamily].sort()).toEqual([...shapeGeometryCommands].sort());
    expect(actionFamily).toEqual([]);

    for (const command of shapeGeometryCommands) {
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

    for (const command of shapeGeometryCommands) {
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
