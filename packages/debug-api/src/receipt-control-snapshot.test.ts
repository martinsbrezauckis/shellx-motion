/** Control receipts must bind the bytes the stable reader admitted, never a reopened path. */
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand, type MotionDebugContext } from "./index.js";

type ControlCase = {
  name: string;
  command: "motion.prompt.cancel" | "motion.prompt.retry" | "motion.render.cancel" | "motion.render.retry";
  operation: "prompt.run" | "render.final";
  status: "not_run" | "failed";
  tier: MotionDebugContext["tier"];
  inputHash: "targetReceipt" | "sourceReceipt";
  snapshot: "targetReceiptSnapshot" | "sourceReceiptSnapshot";
  receiptLabel: "Prompt" | "Render";
};

const CONTROL_CASES: ControlCase[] = [
  { name: "prompt cancel", command: "motion.prompt.cancel", operation: "prompt.run", status: "not_run", tier: "draft_motion", inputHash: "targetReceipt", snapshot: "targetReceiptSnapshot", receiptLabel: "Prompt" },
  { name: "prompt retry", command: "motion.prompt.retry", operation: "prompt.run", status: "failed", tier: "draft_motion", inputHash: "sourceReceipt", snapshot: "sourceReceiptSnapshot", receiptLabel: "Prompt" },
  { name: "render cancel", command: "motion.render.cancel", operation: "render.final", status: "not_run", tier: "render_motion", inputHash: "targetReceipt", snapshot: "targetReceiptSnapshot", receiptLabel: "Render" },
  { name: "render retry", command: "motion.render.retry", operation: "render.final", status: "failed", tier: "render_motion", inputHash: "sourceReceipt", snapshot: "sourceReceiptSnapshot", receiptLabel: "Render" }
];

describe("receipt control target snapshots", () => {
  for (const control of CONTROL_CASES) {
    it.skipIf(process.platform !== "linux")(`keeps ${control.name} bound to admitted bytes after nested-parent replacement`, async () => {
      const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-control-snapshot-"));
      const nested = join(receiptsRoot, "nested");
      const held = join(receiptsRoot, "nested-held");
      const targetPath = join(nested, "target.receipt.json");
      const receiptId = `receipt-${control.name.replace(" ", "-")}`;
      try {
        await mkdir(nested);
        const admitted = jobReceipt(receiptId, control.operation, control.status, "admitted");
        const admittedBytes = `${JSON.stringify(admitted, null, 2)}\n`;
        const forged = jobReceipt(receiptId, control.operation, control.status, "forged");
        const forgedBytes = `${JSON.stringify(forged, null, 2)}\n`;
        await writeFile(targetPath, admittedBytes, "utf8");

        const result = await dispatchDebugCommand(control.command, { receiptsRoot, receiptId }, {
          tier: control.tier,
          callerId: "snapshot-operator",
          crossCallerJobScope: true,
          receiptControlTargetTestHook: async () => {
            await rename(nested, held);
            await mkdir(nested);
            await writeFile(targetPath, forgedBytes, "utf8");
          }
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const resultRecord = result.result as { receipt: OperationReceipt; controlReceiptPath: string };
        const expectedHash = hashBuffer(Buffer.from(admittedBytes, "utf8"));
        const forgedHash = hashBuffer(Buffer.from(forgedBytes, "utf8"));
        expect(resultRecord.receipt.inputHashes[control.inputHash]).toBe(expectedHash);
        expect(resultRecord.receipt.inputHashes[control.inputHash]).not.toBe(forgedHash);
        expect((resultRecord.receipt.output as Record<string, unknown>)[control.snapshot]).toMatchObject({
          sha256: expectedHash,
          byteLength: Buffer.byteLength(admittedBytes, "utf8"),
          identity: { dev: expect.any(Number), ino: expect.any(Number) },
          postPurge: { state: "not_needed" }
        });
        const persisted = JSON.parse(await readFile(resultRecord.controlReceiptPath, "utf8")) as OperationReceipt;
        expect(persisted.inputHashes[control.inputHash]).toBe(expectedHash);
        expect(hashBuffer(await readFile(targetPath))).toBe(forgedHash);
      } finally { await rm(receiptsRoot, { recursive: true, force: true }); }
    });
  }

  for (const control of CONTROL_CASES) {
    it.skipIf(process.platform !== "linux")(`refuses ${control.name} when its receipt is not strict UTF-8`, async () => {
      const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-control-invalid-utf8-"));
      const targetPath = join(receiptsRoot, "target.receipt.json");
      const receiptId = `invalid-utf8-${control.name.replace(" ", "-")}`;
      try {
        const bytes = invalidUtf8InsideJsonString(jobReceipt(receiptId, control.operation, control.status, "receipt-utf8-sentinel"), "receipt-utf8-sentinel");
        await writeFile(targetPath, bytes);

        const result = await dispatchDebugCommand(control.command, { receiptsRoot, receiptId }, {
          tier: control.tier,
          callerId: "snapshot-operator",
          crossCallerJobScope: true
        });

        expect(result).toEqual({
          ok: false,
          error: { code: "invalid_args", message: `${control.receiptLabel} receipt not found: ${receiptId}.` },
          warnings: []
        });
        expect(await readFile(targetPath)).toEqual(bytes);
        expect(await readdir(receiptsRoot)).toEqual(["target.receipt.json"]);
      } finally { await rm(receiptsRoot, { recursive: true, force: true }); }
    });
  }

  it.skipIf(process.platform !== "linux")("does not write a control receipt or purge after a same-inode append follows stable leaf open", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-control-append-"));
    const targetPath = join(receiptsRoot, "expired.receipt.json");
    try {
      const target = jobReceipt("prompt-append-after-open", "prompt.run", "failed", "admitted");
      target.output = {
        request: "edit title", rawRequest: "expired private request",
        promptRetention: { mode: "raw_request", rawRequestRetained: true, deleteAfter: "2020-01-01T00:00:00.000Z", purpose: "debugging" }
      };
      const original = `${JSON.stringify(target, null, 2)}\n`;
      await writeFile(targetPath, original, "utf8");

      const result = await dispatchDebugCommand("motion.prompt.retry", { receiptsRoot, receiptId: target.id }, {
        tier: "draft_motion",
        callerId: "snapshot-operator",
        crossCallerJobScope: true,
        receiptControlTargetAfterLeafOpen: async () => { await appendFile(targetPath, " ", "utf8"); }
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "invalid_args", message: `Prompt receipt not found: ${target.id}.` },
        warnings: []
      });
      expect(await readFile(targetPath, "utf8")).toBe(`${original} `);
      expect(await readdir(receiptsRoot)).toEqual(["expired.receipt.json"]);
    } finally { await rm(receiptsRoot, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("records an expired prompt target's admitted and post-purge identities", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-control-purge-"));
    const targetPath = join(receiptsRoot, "expired.receipt.json");
    try {
      const target = jobReceipt("prompt-expired-control", "prompt.run", "failed", "admitted");
      target.output = {
        request: "edit title", rawRequest: "expired private request",
        promptRetention: { mode: "raw_request", rawRequestRetained: true, deleteAfter: "2020-01-01T00:00:00.000Z", purpose: "debugging" }
      };
      const admittedBytes = `${JSON.stringify(target, null, 2)}\n`;
      await writeFile(targetPath, admittedBytes, "utf8");
      const result = await dispatchDebugCommand("motion.prompt.retry", { receiptsRoot, receiptId: target.id }, {
        tier: "draft_motion",
        callerId: "snapshot-operator",
        crossCallerJobScope: true
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const receipt = (result.result as { receipt: OperationReceipt }).receipt;
      const snapshot = (receipt.output as Record<string, unknown>).sourceReceiptSnapshot as Record<string, unknown>;
      const purgedBytes = await readFile(targetPath);
      expect(receipt.inputHashes.sourceReceipt).toBe(hashBuffer(Buffer.from(admittedBytes, "utf8")));
      expect(snapshot).toMatchObject({
        sha256: hashBuffer(Buffer.from(admittedBytes, "utf8")),
        postPurge: { state: "purged", snapshot: { sha256: hashBuffer(purgedBytes), byteLength: purgedBytes.byteLength } }
      });
      expect(purgedBytes.toString("utf8")).not.toContain("expired private request");
    } finally { await rm(receiptsRoot, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("does not purge raw prompt evidence when its source bytes are not strict UTF-8", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-control-invalid-purge-"));
    const targetPath = join(receiptsRoot, "expired.receipt.json");
    try {
      const target = jobReceipt("prompt-invalid-utf8-purge", "prompt.run", "failed", "admitted");
      target.output = {
        request: "edit title", rawRequest: "expired private request",
        promptRetention: { mode: "raw_request", rawRequestRetained: true, deleteAfter: "2020-01-01T00:00:00.000Z", purpose: "debugging" }
      };
      const bytes = invalidUtf8InsideJsonString(target, "expired private request");
      await writeFile(targetPath, bytes);

      const result = await dispatchDebugCommand("motion.receipts.read", { receiptsRoot, receiptId: target.id }, { tier: "read_motion" });

      expect(result).toEqual({
        ok: false,
        error: { code: "receipt_not_found", message: `Receipt not found: ${target.id}.` },
        warnings: []
      });
      expect(await readFile(targetPath)).toEqual(bytes);
    } finally { await rm(receiptsRoot, { recursive: true, force: true }); }
  });
});

function jobReceipt(
  id: string,
  operation: ControlCase["operation"],
  status: ControlCase["status"],
  marker: string
): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id, operation, status, packageId: "pkg-control", inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-08-21T00:00:00.000Z", lane: operation === "prompt.run" ? "agent" : "ffmpeg",
    output: operation === "prompt.run"
      ? { request: "edit title", marker }
      : { path: "/tmp/output.mp4", marker },
    warnings: []
  };
}

/** Replace one byte inside a JSON string, not after parseable JSON's end. */
function invalidUtf8InsideJsonString(value: unknown, marker: string): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const offset = bytes.indexOf(Buffer.from(marker, "utf8"));
  if (offset < 0) throw new Error(`Test fixture marker is absent: ${marker}.`);
  bytes[offset] = 0xff;
  return bytes;
}
