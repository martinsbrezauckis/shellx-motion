import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { dispatchDebugCommand } from "./index.js";
import { enforceReceiptReadAcceptance } from "./receipt-raw-prompt-purge.js";
import { readStableReceiptEntries } from "./receipt-store-stable-reader.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe.skipIf(process.platform !== "linux")("stable paired-receipt admission", () => {
  it("verifies the marker against the logical receipt path while retaining capability-backed reads", async () => {
    const scratchRoot = resolve(".scratch");
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(join(scratchRoot, "paired-stable-reader-"));
    roots.push(root);
    const outputPath = join(root, "final.mp4");
    const receiptPath = join(root, "render.receipt.json");
    const bytes = "final media";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(outputPath, bytes, "utf8");
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: "paired-stable-reader",
      operation: "render.final",
      status: "passed",
      packageId: "pkg",
      inputHashes: { motion: "a".repeat(64) },
      createdAt: "2026-08-21T00:00:00.000Z",
      lane: "ffmpeg",
      output: {
        path: outputPath,
        sha256,
        callerId: "paired-reader",
        pairedOutputReceiptPublication: { schema: "shellx-motion/paired-output-receipt@1", receiptPath }
      },
      artifacts: [
        { role: "rendered_media", path: outputPath, status: "available", primary: true },
        { role: "render_receipt", path: receiptPath, status: "available" }
      ],
      warnings: []
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    const read = await readStableReceiptEntries(
      root,
      (value) => value as OperationReceipt,
      enforceReceiptReadAcceptance
    );

    expect(read).toMatchObject({ complete: true, entries: [{ path: receiptPath, receipt: { id: receipt.id } }] });

    await expect(dispatchDebugCommand("motion.receipts.list", { receiptsRoot: root }, { tier: "read_motion", callerId: "paired-reader" }))
      .resolves.toMatchObject({ ok: true, result: { receiptCount: 1, receipts: [{ id: receipt.id, path: receiptPath }] } });
    await expect(dispatchDebugCommand("motion.receipts.read", { receiptsRoot: root, receiptId: receipt.id }, { tier: "read_motion", callerId: "paired-reader" }))
      .resolves.toMatchObject({ ok: true, receiptId: receipt.id, result: { path: receiptPath, receipt: { id: receipt.id } } });
    await expect(dispatchDebugCommand("motion.render.status", { receiptsRoot: root }, { tier: "read_motion", callerId: "paired-reader" }))
      .resolves.toMatchObject({ ok: true, result: { jobCount: 1, jobs: [{ receiptId: receipt.id }] } });
  });
});
