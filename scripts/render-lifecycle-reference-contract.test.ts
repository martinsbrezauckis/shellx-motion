/**
 * Keep the small R3 lifecycle-purpose slice mechanically tied to its one source authority.
 *
 * Why this is a separate test: `motion.render.*` names resemble `motion.job.*`, but the former
 * reads or annotates finished receipt evidence while the latter is the persistent coordinator's
 * live-work surface. A generic docs drift check proves files were generated, not that this
 * distinction survived the generated contract.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_REFERENCE_PURPOSE_COMMANDS, DEBUG_COMMAND_CONTRACTS, purposeForDebugContract } from "../packages/debug-api/src/command-metadata.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HISTORICAL_RECEIPT_COMMANDS = [
  "motion.render.cancel",
  "motion.render.retry",
  "motion.render.status",
  "motion.render.queue"
] as const;

const LIVE_COORDINATOR_COMMANDS = [
  "motion.job.get",
  "motion.job.list",
  "motion.job.events",
  "motion.job.submit",
  "motion.job.cancel",
  "motion.job.retry"
] as const;

const LIFECYCLE_COMMANDS = [...HISTORICAL_RECEIPT_COMMANDS, ...LIVE_COORDINATOR_COMMANDS];
const contractsByCommand = new Map(DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]));

describe("generated render lifecycle command reference", () => {
  it("publishes every reviewed purpose from the shared action-purpose authority", () => {
    const published = DEBUG_COMMAND_CONTRACTS
      .filter((contract) => contract.purpose)
      .map((contract) => contract.command);

    expect(published).toEqual(AGENT_REFERENCE_PURPOSE_COMMANDS);
    for (const command of AGENT_REFERENCE_PURPOSE_COMMANDS) {
      const contract = contractsByCommand.get(command)!;
      expect(contract.purpose, command).toBe(purposeForDebugContract(contract));
    }
  });

  it("makes receipt annotations and live coordinator controls mutually unambiguous", () => {
    expect(contractsByCommand.get("motion.render.cancel")?.purpose).toContain("historical render-cancellation annotation");
    expect(contractsByCommand.get("motion.render.cancel")?.purpose).toContain("never signals a running worker");
    expect(contractsByCommand.get("motion.render.retry")?.purpose).toContain("historical render-retry annotation");
    expect(contractsByCommand.get("motion.render.retry")?.purpose).toContain("does not create a new render");
    expect(contractsByCommand.get("motion.render.status")?.purpose).toContain("only describe work that has finished writing evidence");
    expect(contractsByCommand.get("motion.render.queue")?.purpose).toContain("never observes or queues a live worker");

    expect(contractsByCommand.get("motion.job.submit")?.purpose).toContain("durable job id before expensive work starts");
    expect(contractsByCommand.get("motion.job.get")?.purpose).toContain("live work the receipt views cannot see");
    expect(contractsByCommand.get("motion.job.list")?.purpose).toContain("live work first");
    expect(contractsByCommand.get("motion.job.events")?.purpose).toContain("durable ordered event stream");
    expect(contractsByCommand.get("motion.job.cancel")?.purpose).toContain("coordinator that owns the live worker");
    expect(contractsByCommand.get("motion.job.retry")?.purpose).toContain("new coordinator job");
  });

  it("carries the same purposes through the public schema and generated Debug reference", () => {
    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/debug.json"), "utf8")) as {
      contracts: Array<{ command: string; purpose?: string }>;
    };
    const reference = readFileSync(resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md"), "utf8");
    const schemaPurposes = new Map(schema.contracts.map((contract) => [contract.command, contract.purpose]));

    for (const command of LIFECYCLE_COMMANDS) {
      const purpose = contractsByCommand.get(command)!.purpose!;
      expect(schemaPurposes.get(command), `${command} schema purpose`).toBe(purpose);
      expect(reference, `${command} generated reference purpose`).toContain(`### \`${command}\`\n\n`);
      expect(reference, `${command} generated reference purpose`).toContain(`**Purpose:** ${purpose}`);
    }
  });
});
