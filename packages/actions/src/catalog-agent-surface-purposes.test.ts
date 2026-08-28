import { describe, expect, it } from "vitest";
import { AGENT_SURFACE_PURPOSES } from "./catalog-agent-surface-purposes";

const EXPECTED_COMMANDS = [
  "motion.actions.find",
  "motion.actions.guide",
  "motion.actions.plan",
  "motion.agent.revision.plan",
  "motion.prompt.run",
  "motion.open",
  "motion.select",
  "motion.highlight",
  "motion.platform.gpu.probe",
  "motion.receipts.list",
] as const;

describe("agent and surface reviewed purpose map", () => {
  it("covers exactly the ten reviewed default-purpose commands", () => {
    expect(Object.keys(AGENT_SURFACE_PURPOSES).sort()).toEqual([...EXPECTED_COMMANDS].sort());
  });

  it("preserves the discovery, planning, execution, surface, GPU, and receipt-state boundaries", () => {
    expect(AGENT_SURFACE_PURPOSES["motion.actions.find"]).toContain("without planning or executing");
    expect(AGENT_SURFACE_PURPOSES["motion.actions.guide"]).toContain("without executing");
    expect(AGENT_SURFACE_PURPOSES["motion.actions.plan"]).toContain("without executing");
    expect(AGENT_SURFACE_PURPOSES["motion.agent.revision.plan"]).toContain("does not execute the proposed revision");
    expect(AGENT_SURFACE_PURPOSES["motion.prompt.run"]).toContain("only when explicitly requested within the caller's grant");

    for (const command of ["motion.open", "motion.select", "motion.highlight"] as const) {
      expect(AGENT_SURFACE_PURPOSES[command]).toContain("transient");
      expect(AGENT_SURFACE_PURPOSES[command]).toContain("without mutating package data");
    }

    expect(AGENT_SURFACE_PURPOSES["motion.platform.gpu.probe"]).toContain("hardware proof");
    expect(AGENT_SURFACE_PURPOSES["motion.platform.gpu.probe"]).toContain("not renderer, artifact, or release qualification");
    expect(AGENT_SURFACE_PURPOSES["motion.receipts.list"]).toContain("historical evidence");
    expect(AGENT_SURFACE_PURPOSES["motion.receipts.list"]).toContain("not live job state, queue, or progress");
  });
});
