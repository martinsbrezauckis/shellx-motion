import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { dispatchDebugCommand, readMotionAgentSnapshotResource } from "./index.js";
import { receiptVisibleToCaller, stampReceiptOwner } from "./receipt-ownership.js";

function receipt(input: {
  id: string;
  operation: "render.final" | "render.retry" | "render.cancel";
  status: OperationReceipt["status"];
  callerId?: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: input.operation,
    status: input.status,
    packageId: "pkg-lifecycle",
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-08-28T00:00:00.000Z",
    lane: "ffmpeg",
    output: input.callerId ? { callerId: input.callerId } : {},
    warnings: []
  };
}

async function write(root: string, entry: OperationReceipt): Promise<void> {
  await writeFile(join(root, `${entry.id}.receipt.json`), `${JSON.stringify(entry)}\n`, "utf8");
}

describe("receipt-derived ownership", () => {
  it("stamps a host caller and fails closed for ownerless receipts outside explicit operator scope", () => {
    const final = receipt({ id: "stamped-final", operation: "render.final", status: "passed" });
    expect(stampReceiptOwner(final, "cut:workspace-a").output).toMatchObject({ callerId: "cut:workspace-a" });
    expect(receiptVisibleToCaller(final, { callerId: "cut:workspace-a" })).toBe(true);
    expect(receiptVisibleToCaller(final, { callerId: "cut:workspace-b" })).toBe(false);
    expect(receiptVisibleToCaller(final, {})).toBe(false);
    expect(receiptVisibleToCaller(receipt({ id: "legacy", operation: "render.final", status: "passed" }), { callerId: "cut:workspace-a" })).toBe(false);
    expect(receiptVisibleToCaller(receipt({ id: "legacy-operator", operation: "render.final", status: "passed" }), {
      callerId: "operator:console",
      crossCallerScopeGranted: true
    })).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("filters historical reads, prevents cross-caller annotation writes, and fails closed for legacy receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-lifecycle-owner-"));
    const receiptsRoot = join(root, "receipts");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await write(receiptsRoot, receipt({ id: "owner-a-pending", operation: "render.final", status: "not_run", callerId: "cut:workspace-a" }));
      await write(receiptsRoot, receipt({ id: "owner-a-failed", operation: "render.final", status: "failed", callerId: "cut:workspace-a" }));
      await write(receiptsRoot, receipt({ id: "legacy-pending", operation: "render.final", status: "not_run" }));

      await expect(dispatchDebugCommand(
        "motion.render.status", { receiptsRoot }, { tier: "read_motion", callerId: "cut:workspace-a" }
      )).resolves.toMatchObject({ ok: true, result: { jobCount: 2, jobs: expect.arrayContaining([
        expect.objectContaining({ receiptId: "owner-a-pending" }),
        expect.objectContaining({ receiptId: "owner-a-failed" })
      ]) } });

      await expect(dispatchDebugCommand(
        "motion.render.queue", { receiptsRoot }, { tier: "read_motion", callerId: "cut:workspace-b" }
      )).resolves.toMatchObject({ ok: true, result: { jobCount: 0, jobs: [] } });

      await expect(dispatchDebugCommand(
        "motion.receipts.list", { receiptsRoot }, { tier: "read_motion", callerId: "cut:workspace-a" }
      )).resolves.toMatchObject({ ok: true, result: { receiptCount: 2 } });
      await expect(dispatchDebugCommand(
        "motion.receipts.read", { receiptsRoot, receiptId: "owner-a-pending" }, { tier: "read_motion", callerId: "cut:workspace-b" }
      )).resolves.toMatchObject({ ok: false, error: { code: "receipt_not_found" } });
      await expect(dispatchDebugCommand(
        "motion.receipts.panel", { receiptsRoot }, { tier: "read_motion" }
      )).resolves.toMatchObject({ ok: true, result: { receiptCount: 0 } });
      await expect(readMotionAgentSnapshotResource({}, {
        tier: "read_motion",
        callerId: "cut:workspace-a",
        receiptsRoot
      })).resolves.toMatchObject({ ok: true, result: { receipts: { count: 2 } } });
      await expect(readMotionAgentSnapshotResource({}, {
        tier: "read_motion",
        callerId: "operator:console",
        crossCallerJobScope: true,
        receiptsRoot
      })).resolves.toMatchObject({ ok: true, result: { receipts: { count: 3 } } });

      const beforeDeniedControls = await readdir(receiptsRoot);
      await expect(dispatchDebugCommand(
        "motion.render.cancel", { receiptsRoot, receiptId: "owner-a-pending" }, { tier: "render_motion", callerId: "cut:workspace-b" }
      )).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
      await expect(dispatchDebugCommand(
        "motion.render.retry", { receiptsRoot, receiptId: "owner-a-failed" }, { tier: "render_motion", callerId: "cut:workspace-b" }
      )).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
      expect(await readdir(receiptsRoot)).toEqual(beforeDeniedControls);

      const cancel = await dispatchDebugCommand(
        "motion.render.cancel", { receiptsRoot, receiptId: "owner-a-pending" }, { tier: "render_motion", callerId: "cut:workspace-a" }
      );
      expect(cancel).toMatchObject({ ok: true, result: { receipt: { output: { callerId: "cut:workspace-a" } } } });
      const retry = await dispatchDebugCommand(
        "motion.render.retry", { receiptsRoot, receiptId: "owner-a-failed" }, { tier: "render_motion", callerId: "cut:workspace-a" }
      );
      expect(retry).toMatchObject({ ok: true, result: { receipt: { output: { callerId: "cut:workspace-a" } } } });

      await expect(dispatchDebugCommand(
        "motion.render.status", { receiptsRoot }, { tier: "read_motion", callerId: "cut:workspace-a" }
      )).resolves.toMatchObject({ ok: true, result: { jobCount: 3 } });
      await expect(dispatchDebugCommand(
        "motion.render.status", { receiptsRoot }, { tier: "read_motion", callerId: "operator:console", crossCallerJobScope: true }
      )).resolves.toMatchObject({ ok: true, result: { jobCount: 4 } });
      await expect(dispatchDebugCommand(
        "motion.render.status", { receiptsRoot }, { tier: "read_motion", crossCallerJobScope: true }
      )).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
