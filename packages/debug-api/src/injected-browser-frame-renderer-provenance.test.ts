import { describe, expect, it, vi } from "vitest";
import {
  APPROVED_AGENT_SCRIPT_MODE,
  type AgentScriptExecutionEvidence,
  type AgentScriptProvenanceAuthority,
  type MotionPackage,
} from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "./domains/integration-browser-workflow.js";
import { provenanceBoundInjectedBrowserFrameRenderer } from "./injected-browser-frame-renderer-provenance";

const activePackage = {
  root: "/untrusted/live-package",
  manifest: { id: "active", motion: "motion.json" },
  motion: { layers: [{ id: "entry", type: "html", source: "entry.html" }] }
} as unknown as MotionPackage;
const dataOnlyPackage = {
  root: "/data-only-package",
  manifest: { id: "data", motion: "motion.json" },
  motion: { layers: [{ id: "shape", type: "shape" }] }
} as unknown as MotionPackage;
const snapshotPackage = { ...activePackage, root: "/host-private/snapshot/package" } as MotionPackage;
const evidence: AgentScriptExecutionEvidence = {
  schema: "shellx-motion/script-execution@1",
  detectedClass: "active-content",
  requestedMode: APPROVED_AGENT_SCRIPT_MODE,
  activeMode: APPROVED_AGENT_SCRIPT_MODE,
  resolverVersion: 1,
  packageSnapshotSha256: "a".repeat(64),
  attestationId: "evidence-only-not-a-capability",
  sources: [{ layerId: "entry", layerType: "html", path: "entry.html", sha256: "b".repeat(64), bytes: 12 }]
};

function renderer(result?: unknown): BrowserFrameRenderer {
  return vi.fn(async () => result ?? {
    output: { scriptExecution: { activeMode: "forged" } },
    receipt: { output: { scriptExecution: { activeMode: "forged" } } }
  }) as unknown as BrowserFrameRenderer;
}

function authority(release: () => Promise<void>): AgentScriptProvenanceAuthority {
  return {
    resolverVersion: 1,
    async mint() { throw new Error("not used"); },
    async resolve() { return { package: snapshotPackage, evidence, release }; },
    async revoke() { throw new Error("not used"); },
    async writeReceipt() { throw new Error("not used"); }
  };
}

describe("injected browser renderer provenance wrapper", () => {
  it("refuses active content before an injected renderer is called without authority", async () => {
    const injected = renderer();
    const wrapped = provenanceBoundInjectedBrowserFrameRenderer(injected, undefined);

    await expect(wrapped(activePackage, {} as never)).rejects.toMatchObject({ code: "script_provenance_unresolved" });
    expect(injected).not.toHaveBeenCalled();
  });

  it("passes only the resolved snapshot and overwrites result and receipt script evidence", async () => {
    let releases = 0;
    const injected = renderer();
    const wrapped = provenanceBoundInjectedBrowserFrameRenderer(injected, authority(async () => { releases += 1; }));

    const result = await wrapped(activePackage, {} as never);

    expect(injected).toHaveBeenCalledWith(snapshotPackage, expect.anything());
    expect(result.output.scriptExecution).toEqual(evidence);
    expect((result.receipt.output as { scriptExecution?: AgentScriptExecutionEvidence }).scriptExecution).toEqual(evidence);
    expect(releases).toBe(1);
  });

  it("releases the resolved snapshot when the injected renderer throws", async () => {
    let releases = 0;
    const injected = vi.fn(async () => { throw new Error("fake renderer failure"); }) as unknown as BrowserFrameRenderer;
    const wrapped = provenanceBoundInjectedBrowserFrameRenderer(injected, authority(async () => { releases += 1; }));

    await expect(wrapped(activePackage, {} as never)).rejects.toThrow("fake renderer failure");
    expect(releases).toBe(1);
  });

  it("delegates data-only packages unchanged without resolving authority", async () => {
    const sentinel = { output: {}, receipt: { output: {} } };
    const injected = renderer(sentinel);
    const resolve = vi.fn();
    const wrapped = provenanceBoundInjectedBrowserFrameRenderer(injected, { ...authority(async () => undefined), resolve });

    const result = await wrapped(dataOnlyPackage, {} as never);

    expect(injected).toHaveBeenCalledWith(dataOnlyPackage, expect.anything());
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toBe(sentinel);
  });
});
