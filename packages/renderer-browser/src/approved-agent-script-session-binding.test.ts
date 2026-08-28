import { describe, expect, it } from "vitest";
import { APPROVED_AGENT_SCRIPT_MODE, type AgentScriptExecutionEvidence } from "@shellx-motion/core";
import { approvedAgentEntryInitGuard, bindApprovedAgentScriptEntry } from "./approved-agent-script-session-binding";

const source = { layerId: "entry", layerType: "html" as const, path: "entry.html", sha256: "a".repeat(64), bytes: 12 };
const active: AgentScriptExecutionEvidence = {
  schema: "shellx-motion/script-execution@1", detectedClass: "active-content", requestedMode: APPROVED_AGENT_SCRIPT_MODE,
  activeMode: APPROVED_AGENT_SCRIPT_MODE, resolverVersion: 1, packageSnapshotSha256: "b".repeat(64), attestationId: "attestation", sources: [source]
};

describe("approved-agent-entry session binding", () => {
  it("binds the attested executable source and leaves data-only evidence unchanged", () => {
    expect(bindApprovedAgentScriptEntry(active, "entry.html").entry).toEqual(source);
    const dataOnly = { ...active, detectedClass: "data-only" as const, activeMode: "data-only" as const, sources: [] };
    expect(bindApprovedAgentScriptEntry(dataOnly, "entry.html")).toBe(dataOnly);
  });

  it("installs document-start defenses for navigation, generated-code, and DOM-insertion bypass classes", () => {
    const guard = approvedAgentEntryInitGuard("file:///private/session/package/entry.html");
    for (const token of ["Location.prototype", "meta[http-equiv]", "HTMLFormElement.prototype", "replaceState", "Worker", "appendChild", "replaceChildren", "innerHTML", "insertAdjacentHTML"]) expect(guard).toContain(token);
    expect(guard).toContain("file:///private/session/package/entry.html");
  });
});
