import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashBuffer, writeReviewBundle, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand } from "./index";

describe("stable review-bundle receipt handoff", () => {
  it.runIf(process.platform === "linux")("refuses a receipt replaced after the Debug reader parsed its stable snapshot", async () => {
    const tempRoot = await reviewScratch("replacement-");
    const receiptsRoot = join(tempRoot, "input-receipts");
    const outDir = join(tempRoot, "review");
    const receiptPath = join(receiptsRoot, "render.receipt.json");
    const earlyReceipt = receiptJson(reviewReceipt({
      id: "render-final-review-replaced-after-parse",
      operation: "render.final",
      lane: "ffmpeg",
      warnings: ["parsed"]
    }));
    const lateReceipt = earlyReceipt.replace("parsed", "replacement");
    let replacedAfterParse = false;
    const originalParse = JSON.parse;
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, earlyReceipt, "utf8");
      const receiptParse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        const parsed = originalParse(text, reviver);
        const record = typeof parsed === "object" && parsed !== null ? parsed as { id?: unknown } : undefined;
        if (!replacedAfterParse && record?.id === "render-final-review-replaced-after-parse") {
          replacedAfterParse = true;
          writeFileSync(receiptPath, lateReceipt, "utf8");
        }
        return parsed;
      });
      try {
        const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () => await dispatchReviewBundle(outDir, receiptsRoot));

        expect(replacedAfterParse).toBe(true);
        expect(result).toMatchObject({ ok: false, error: { code: "review_html_bundle_failed" } });
        if (!result.ok) expect(result.error.message).toMatch(/stable review bundle receipt.*changed/i);
        await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        receiptParse.mockRestore();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("uses the persisted redacted receipt snapshot for a review bundle", async () => {
    const tempRoot = await reviewScratch("purged-");
    const receiptsRoot = join(tempRoot, "input-receipts");
    const outDir = join(tempRoot, "review");
    const receiptPath = join(receiptsRoot, "prompt.receipt.json");
    const rawRequest = "expired raw prompt must never enter review output";
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, receiptJson(reviewReceipt({
        id: "prompt-run-review-purged",
        operation: "prompt.run",
        lane: "agent",
        output: {
          rawRequest,
          promptRetention: {
            mode: "raw_request",
            rawRequestRetained: true,
            summaryRedacted: true,
            summaryMaxBytes: 512,
            deleteAfter: "2020-01-01T00:00:00.000Z",
            purpose: "debugging"
          }
        }
      })), "utf8");

      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () => await dispatchReviewBundle(outDir, receiptsRoot));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const redactedBytes = await readFile(receiptPath);
      const bundleReceipt = (result.result as { receipt: OperationReceipt }).receipt;
      expect(bundleReceipt.inputHashes["receipt:prompt.receipt.json"]).toBe(hashBuffer(redactedBytes));
      expect(redactedBytes.toString("utf8")).not.toContain(rawRequest);
      expect(await readFile(join(outDir, "review-html-bundle.html"), "utf8")).not.toContain(rawRequest);
      expect(await readFile(join(outDir, "review-html-bundle.receipt.json"), "utf8")).not.toContain(rawRequest);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("keeps nested same-basename receipt bindings distinct and matches the direct Core loader", async () => {
    const tempRoot = await reviewScratch("nested-");
    const receiptsRoot = join(tempRoot, "input-receipts");
    const directOutDir = join(tempRoot, "direct-review");
    const debugOutDir = join(tempRoot, "debug-review");
    try {
      for (const batch of ["batch-a", "batch-b"]) {
        await mkdir(join(receiptsRoot, batch), { recursive: true, mode: 0o700 });
        await writeFile(join(receiptsRoot, batch, "render.receipt.json"), receiptJson(reviewReceipt({
          id: `render-final-${batch}`,
          operation: "render.final",
          lane: "ffmpeg",
          warnings: [batch]
        })), "utf8");
      }

      const { direct, debug } = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () => ({
        direct: await writeReviewBundle({ receiptsRoot, outDir: directOutDir, copyArtifacts: false, title: "Nested receipt parity" }),
        debug: await dispatchReviewBundle(debugOutDir, receiptsRoot, "Nested receipt parity")
      }));

      expect(debug.ok).toBe(true);
      if (!debug.ok) return;
      const debugBundleReceipt = (debug.result as { receipt: OperationReceipt }).receipt;
      expect(debugBundleReceipt.inputHashes).toEqual(direct.receipt.inputHashes);
      expect(Object.keys(debugBundleReceipt.inputHashes)).toEqual(expect.arrayContaining([
        "receipt:batch-a/render.receipt.json",
        "receipt:batch-b/render.receipt.json"
      ]));
      expect(debugBundleReceipt.inputHashes["receipt:render.receipt.json"]).toBeUndefined();
      expect(debugBundleReceipt.inputHashes["receipt:batch-a/render.receipt.json"])
        .not.toBe(debugBundleReceipt.inputHashes["receipt:batch-b/render.receipt.json"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function dispatchReviewBundle(outDir: string, receiptsRoot: string, title?: string) {
  return await dispatchDebugCommand(
    "motion.review.html.bundle",
    { outDir, receiptsRoot, ...(title ? { title } : {}) },
    { tier: "write_local", callerId: "test-operator", crossCallerJobScope: true }
  );
}

async function reviewScratch(prefix: string): Promise<string> {
  const scratch = resolve("../../.scratch");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(scratch, `shellx-motion-debug-review-${prefix}`));
}

function reviewReceipt(input: {
  id: string;
  operation: string;
  lane: string;
  output?: unknown;
  warnings?: string[];
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: input.operation,
    status: "passed",
    packageId: "pkg_debug_timeline",
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: input.lane,
    output: input.output ?? {},
    warnings: input.warnings ?? []
  };
}

function receiptJson(receipt: OperationReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
