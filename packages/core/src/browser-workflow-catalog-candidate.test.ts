import { describe, expect, it } from "vitest";
import { prepareBrowserWorkflowCatalogUpdate, type BrowserWorkflowCatalog, type BrowserWorkflowCatalogCapture } from "./browser-workflow-catalog";

const workflowHash = "a".repeat(64);
const base: BrowserWorkflowCatalog = { schema: "shellx-motion/browser-workflow-catalog@1", entries: [] };

function capture(outputSha256: string): BrowserWorkflowCatalogCapture {
  return {
    packageId: "pkg", workflowHash, atMs: 100, outputSha256,
    outputPath: "/capture/primary.png", receiptPath: "/capture/receipt.json", createdAt: "2026-08-21T00:00:00.000Z"
  };
}

describe("browser workflow catalog candidate planner", () => {
  it("plans new, matched, and changed states without mutating baseline/history", () => {
    const first = prepareBrowserWorkflowCatalogUpdate(base, capture("1".repeat(64)));
    expect(first.entry.drift.status).toBe("new");
    expect(base.entries).toEqual([]);

    const matched = prepareBrowserWorkflowCatalogUpdate(first.catalog, capture("1".repeat(64)));
    expect(matched.entry.drift).toMatchObject({ status: "matched", baselineOutputSha256: "1".repeat(64) });
    expect(first.catalog.entries[0]!.history).toHaveLength(1);

    const changed = prepareBrowserWorkflowCatalogUpdate(first.catalog, capture("2".repeat(64)));
    expect(changed.entry.drift).toMatchObject({ status: "changed", baselineOutputSha256: "1".repeat(64), currentOutputSha256: "2".repeat(64) });
    expect(first.catalog.entries[0]!.history).toHaveLength(1);
    expect(changed.catalog.entries[0]!.history).toHaveLength(2);
  });

  it("rejects an absent or non-canonical workflow identity before a candidate exists", () => {
    expect(() => prepareBrowserWorkflowCatalogUpdate(base, { ...capture("1".repeat(64)), workflowHash: "" })).toThrow(/canonical SHA-256/i);
    expect(() => prepareBrowserWorkflowCatalogUpdate(base, { ...capture("1".repeat(64)), workflowHash: "not-a-hash" })).toThrow(/canonical SHA-256/i);
  });
});
