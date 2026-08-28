import { describe, expect, it } from "vitest";
import { motionCapabilityCatalog } from "@shellx-motion/core";
import { DEBUG_COMMAND_CONTRACTS, dispatchDebugCommand } from "./index";

describe("generic connector catalog Debug dispatch", () => {
  it("returns Core's exact immutable v2 catalog at read_motion with no coordinator or host authority", async () => {
    const response = await dispatchDebugCommand("motion.connector.catalog", {}, { tier: "read_motion", jobView: null });
    const coreCatalog = motionCapabilityCatalog();

    expect(response).toMatchObject({
      ok: true,
      visibleState: {
        panel: "connector",
        operation: "connector.catalog",
        catalogSchema: coreCatalog.schema,
        catalogFingerprint: coreCatalog.fingerprint,
        descriptorCount: coreCatalog.descriptors.length
      },
      result: { ok: true, catalog: coreCatalog },
      warnings: []
    });
    if (!response.ok) throw new Error("connector catalog Debug dispatch unexpectedly failed");
    expect((response.result as { catalog: unknown }).catalog).toEqual(coreCatalog);
    expect(JSON.stringify(coreCatalog)).not.toMatch(/(?:\/home\/|[A-Z]:\\\\|callerId|runtimeAuthority|connectorJobReferences|connectorJobBindingJournal)/i);
  });

  it("publishes an argumentless, read-only Debug contract", () => {
    expect(DEBUG_COMMAND_CONTRACTS.find((contract) => contract.command === "motion.connector.catalog")).toMatchObject({
      domain: "integration",
      permission: "read_motion",
      mutates: false,
      argsSchema: { type: "object", properties: {}, additionalProperties: false },
      expectedReceipts: []
    });
  });
});
