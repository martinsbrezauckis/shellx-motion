import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { dispatchDebugCommand } from "./index.js";

function promptReceipt(id: string, status: OperationReceipt["status"], callerId?: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id,
    operation: "prompt.run",
    status,
    packageId: "pkg-prompt-owner",
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-08-28T00:00:00.000Z",
    lane: "agent",
    output: {
      ...(callerId ? { callerId } : {}),
      request: "edit the title",
      agentId: "codex"
    },
    warnings: []
  };
}

async function writeReceipt(root: string, receipt: OperationReceipt): Promise<void> {
  await writeFile(join(root, `${receipt.id}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

describe("prompt receipt ownership", () => {
  it.skipIf(process.platform !== "linux")("requires a principal, hides foreign targets, and retains the target owner on controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-prompt-receipt-owner-"));
    const receiptsRoot = join(root, "receipts");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeReceipt(receiptsRoot, promptReceipt("alice-pending", "not_run", "cut:workspace-a"));
      await writeReceipt(receiptsRoot, promptReceipt("alice-failed", "failed", "cut:workspace-a"));
      await writeReceipt(receiptsRoot, promptReceipt("legacy-pending", "not_run"));

      await expect(dispatchDebugCommand(
        "motion.prompt.queue", { receiptsRoot }, { tier: "read_motion" }
      )).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
      await expect(dispatchDebugCommand(
        "motion.prompt.queue", { receiptsRoot }, { tier: "read_motion", callerId: "cut:workspace-b" }
      )).resolves.toMatchObject({ ok: true, result: { jobCount: 0 } });

      const beforeForeignControl = await readdir(receiptsRoot);
      await expect(dispatchDebugCommand(
        "motion.prompt.cancel", { receiptsRoot, receiptId: "alice-pending" }, { tier: "draft_motion", callerId: "cut:workspace-b" }
      )).resolves.toMatchObject({ ok: false, error: { code: "invalid_args", message: "Prompt receipt not found: alice-pending." } });
      expect(await readdir(receiptsRoot)).toEqual(beforeForeignControl);

      const ownCancel = await dispatchDebugCommand(
        "motion.prompt.cancel", { receiptsRoot, receiptId: "alice-pending" }, { tier: "draft_motion", callerId: "cut:workspace-a" }
      );
      expect(ownCancel).toMatchObject({ ok: true, result: { receipt: { output: { callerId: "cut:workspace-a" } } } });

      const operatorRetry = await dispatchDebugCommand(
        "motion.prompt.retry", { receiptsRoot, receiptId: "alice-failed" }, {
          tier: "draft_motion",
          callerId: "operator:console",
          crossCallerJobScope: true
        }
      );
      expect(operatorRetry).toMatchObject({ ok: true, result: { receipt: { output: { callerId: "cut:workspace-a" } } } });
      if (!operatorRetry.ok) return;
      const retry = operatorRetry.result as { controlReceiptPath: string };
      expect(JSON.parse(await readFile(retry.controlReceiptPath, "utf8"))).toMatchObject({
        output: { callerId: "cut:workspace-a" }
      });

      await expect(dispatchDebugCommand(
        "motion.prompt.cancel", { receiptsRoot, receiptId: "legacy-pending" }, { tier: "draft_motion", callerId: "cut:workspace-a" }
      )).resolves.toMatchObject({ ok: false, error: { code: "invalid_args", message: "Prompt receipt not found: legacy-pending." } });
      await expect(dispatchDebugCommand(
        "motion.prompt.cancel", { receiptsRoot, receiptId: "legacy-pending" }, {
          tier: "draft_motion",
          callerId: "operator:console",
          crossCallerJobScope: true
        }
      )).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
