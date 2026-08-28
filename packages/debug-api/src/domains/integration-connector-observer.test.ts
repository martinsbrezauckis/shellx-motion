import { describe, expect, it } from "vitest";
import { PublicationCommitUncertainError } from "@shellx-motion/core";
import { connectorException, connectorResult } from "./integration-connector-observer.js";

const receipt = { id: "receipt-committed" } as any;
const result = { ok: true, receiptPath: "/delivery/connector.receipt.json", warnings: [] };

describe("atomic connector receipt observation", () => {
  it("keeps a committed success when host receipt mirroring fails after delivery", async () => {
    const observed = await connectorResult("motion.connector.canvas_to_cut", result, {
      receiptsRoot: "/host-receipts",
      readReceipt: async () => receipt,
      writeReceipt: async () => { throw new Error("mirror offline"); }
    }, { operation: "connector.canvas_to_cut" }, {}, { atomic: true });

    expect(observed).toMatchObject({
      ok: true,
      receiptId: "receipt-committed",
      warnings: ["Connector delivery committed, but host receipt observation failed: mirror offline"]
    });
  });

  it("keeps a committed success when receipt read observation is unavailable or fails", async () => {
    const unavailable = await connectorResult("motion.connector.script_to_cut", result, {}, { operation: "connector.script_to_cut" }, {}, { atomic: true });
    expect(unavailable).toMatchObject({
      ok: true,
      warnings: ["Connector delivery committed, but host receipt observation is unavailable."]
    });

    const failedRead = await connectorResult("motion.connector.source_to_cut", result, {
      readReceipt: async () => { throw new Error("receipt read offline"); }
    }, { operation: "connector.source_to_cut" }, {}, { atomic: true });
    expect(failedRead).toMatchObject({
      ok: true,
      warnings: ["Connector delivery committed, but host receipt observation failed: receipt read offline"]
    });
  });

  it("preserves typed publication-commit uncertainty before a connector succeeds", () => {
    const uncertainty = new PublicationCommitUncertainError({
      publicPath: "/delivery",
      kind: "directory",
      expectedIdentity: { dev: 1, ino: 2 },
      expected: { sha256: "a".repeat(64), entryCount: 1, entries: ["connector.receipt.json"] }
    }, new Error("post-rename observation failed"));

    expect(connectorException(uncertainty)).toMatchObject({
      ok: false,
      error: { code: "publication_commit_uncertain", detail: { possiblyCommitted: true, publicPaths: ["/delivery"] } },
      result: { possiblyCommitted: true, publicPaths: ["/delivery"] }
    });
  });
});
