/** Keep every public Debug/MCP command useful, exact, and boundary-aware for an agent. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { purposeForCall } from "../packages/actions/src/catalog.js";
import {
  AGENT_REFERENCE_PURPOSE_COMMANDS,
  DEBUG_COMMAND_CONTRACTS,
  purposeForDebugContract,
} from "../packages/debug-api/src/command-metadata.js";
import { mcpToolForDebugContract } from "../packages/debug-server/src/mcp-tool-shape.js";

const repoRoot = resolve(import.meta.dirname, "..");
const COPY_ON_WRITE_BOUNDARY = "Reads the source and writes the separate revision only within host-approved authoring roots; outDir must be outside the source and empty or absent, and the source package remains unchanged.";

describe("all-command published-purpose contract", () => {
  it("publishes one reviewed purpose for every registered Debug/MCP command", () => {
    expect(DEBUG_COMMAND_CONTRACTS).toHaveLength(300);
    expect(AGENT_REFERENCE_PURPOSE_COMMANDS).toEqual(DEBUG_COMMAND_CONTRACTS.map((contract) => contract.command));
    expect(new Set(AGENT_REFERENCE_PURPOSE_COMMANDS).size).toBe(300);

    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      const basePurpose = purposeForCall(contract.command);
      expect(basePurpose, contract.command).not.toBe(`Run ${contract.command}.`);
      expect(contract.purpose, contract.command).toBe(purposeForDebugContract(contract));
      expect((mcpToolForDebugContract(contract).description as string).startsWith(contract.purpose!), contract.command)
        .toBe(true);
    }
  });

  it("derives the common copy-on-write host-root boundary from typed edit contracts", () => {
    const copyOnWriteContracts = DEBUG_COMMAND_CONTRACTS.filter((contract) => contract.permission === "edit_motion"
      && contract.mutates
      && contract.argsSchema?.properties?.packageRoot !== undefined
      && contract.argsSchema?.properties?.outDir !== undefined);

    expect(copyOnWriteContracts).toHaveLength(155);
    for (const contract of copyOnWriteContracts) {
      expect(contract.purpose, contract.command).toContain(COPY_ON_WRITE_BOUNDARY);
    }
  });

  it("carries the exact complete purposes to the generated schema and reference", () => {
    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/debug.json"), "utf8")) as {
      contracts: Array<{ command: string; purpose?: string }>;
    };
    const schemaPurposes = new Map(schema.contracts.map((contract) => [contract.command, contract.purpose]));
    const reference = readFileSync(resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md"), "utf8");

    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      expect(schemaPurposes.get(contract.command), `${contract.command} schema`).toBe(contract.purpose);
      expect(reference, `${contract.command} reference`).toContain(`### \`${contract.command}\`\n\n`);
      expect(reference, `${contract.command} reference`).toContain(`**Purpose:** ${contract.purpose}`);
    }
  });
});
