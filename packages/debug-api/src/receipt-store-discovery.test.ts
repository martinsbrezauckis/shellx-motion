/** Host receipt evidence is bounded, no-follow, identity-stable, and schema-valid. */
import { appendFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { enforceRawPromptExpiry } from "./receipt-raw-prompt-purge.js";
import { MAX_DEBUG_RECEIPT_BYTES, readPlatformReceiptEntries, readPlatformReceiptFile, readVerifiedJsonReceipt } from "./receipt-store-discovery.js";
import { readStableReceiptEntries, readStableReceiptEntry, unchangedStableReceipt } from "./receipt-store-stable-reader.js";

function platformReceipt(status: "passed" | "failed" = "passed"): Record<string, unknown> {
  return {
    schema: "shellx-motion/platform-verification@1",
    status,
    dryRun: false,
    host: { id: "linux", hostname: "linux.example.test", platform: "linux", arch: "x64", release: "test", node: process.version },
    toolchain: { status: "missing", exact: false, bundledCodecs: false },
    repoRoot: "/workspace/ShellX Motion",
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:01:00.000Z",
    commandSummary: { total: 1, passed: 1, failed: 0, skipped: 0, skippedByKind: {} },
    commands: [{ id: "typecheck", command: ["pnpm", "typecheck"], required: true, status: "passed" }]
  };
}

describe("platform receipt discovery", () => {
  it.runIf(process.platform === "linux")("ignores forged, oversized, and symbolic-link platform evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-platform-receipt-reader-"));
    try {
      const validPath = join(root, "valid.platform.json");
      const validBytes = `${JSON.stringify(platformReceipt())}\n`;
      await writeFile(validPath, validBytes, "utf8");
      await writeFile(join(root, "forged.platform.json"), `${JSON.stringify({ schema: "shellx-motion/platform-verification@1", status: "passed" })}\n`, "utf8");
      await writeFile(join(root, "oversized.platform.json"), Buffer.alloc(MAX_DEBUG_RECEIPT_BYTES + 1, 0x20));
      await symlink(validPath, join(root, "linked.platform.json"), "file");

      const entries = await readPlatformReceiptEntries(root);
      expect(entries).toMatchObject([{ path: validPath, receipt: platformReceipt(), snapshot: {
        sha256: hashBuffer(Buffer.from(validBytes, "utf8")),
        byteLength: Buffer.byteLength(validBytes, "utf8"),
        identity: { dev: expect.any(Number), ino: expect.any(Number) },
        postPurge: { state: "not_needed" }
      } }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a platform receipt path is retargeted after no-follow open", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-platform-receipt-retarget-"));
    try {
      const path = join(root, "linux.platform.json");
      const moved = join(root, "linux.platform.original.json");
      await writeFile(path, `${JSON.stringify(platformReceipt())}\n`, "utf8");

      await expect(readPlatformReceiptFile(root, path, {
        afterLeafOpen: async () => {
          await rename(path, moved);
          await writeFile(path, `${JSON.stringify(platformReceipt("failed"))}\n`, "utf8");
        }
      })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("fails closed when the admitted receipt root is retargeted before its entries are read", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-platform-root-retarget-"));
    const outside = await mkdtemp(join(tmpdir(), "shellx-motion-platform-root-retarget-outside-"));
    try {
      const receiptsRoot = join(root, "receipts");
      const heldRoot = join(root, "receipts-held");
      await mkdir(receiptsRoot);
      await writeFile(join(receiptsRoot, "linux.platform.json"), `${JSON.stringify(platformReceipt())}\n`, "utf8");
      await writeFile(join(outside, "foreign.platform.json"), `${JSON.stringify(platformReceipt("failed"))}\n`, "utf8");

      await expect(readPlatformReceiptEntries(receiptsRoot, {
        afterReaddir: async () => {
          await rename(receiptsRoot, heldRoot);
          await symlink(outside, receiptsRoot, "dir");
        }
      })).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("proves configured-root ancestors even when a retarget preserves the root inode", async () => {
    const parent = await mkdtemp(join(tmpdir(), "shellx-motion-platform-parent-retarget-"));
    const hostRoot = join(parent, "host");
    const receiptsRoot = join(hostRoot, "receipts");
    const heldHostRoot = join(parent, "host-held");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "linux.platform.json"), `${JSON.stringify(platformReceipt())}\n`, "utf8");
      await expect(readPlatformReceiptEntries(receiptsRoot, {
        afterReaddir: async () => { await rename(hostRoot, heldHostRoot); await symlink(heldHostRoot, hostRoot, "dir"); }
      })).resolves.toEqual([]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "linux")("refuses a classified nested directory replaced by another regular directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-platform-directory-replacement-"));
    const nested = join(root, "nested");
    const held = join(root, "nested-held");
    try {
      await mkdir(nested);
      await writeFile(join(nested, "linux.platform.json"), `${JSON.stringify(platformReceipt())}\n`, "utf8");
      await expect(readPlatformReceiptEntries(root, {
        afterReaddir: async () => {
          await rename(nested, held);
          await mkdir(nested);
          await writeFile(join(nested, "linux.platform.json"), `${JSON.stringify(platformReceipt("failed"))}\n`, "utf8");
        }
      })).resolves.toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "linux")("rechecks the configured-root lineage after an ID leaf is open", async () => {
    const parent = await mkdtemp(join(tmpdir(), "shellx-motion-platform-post-open-root-lineage-"));
    const hostRoot = join(parent, "host");
    const receiptsRoot = join(hostRoot, "receipts");
    const heldHostRoot = join(parent, "host-held");
    const receiptPath = join(receiptsRoot, "linux.platform.json");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(platformReceipt())}\n`, "utf8");
      await expect(readStableReceiptEntry(receiptsRoot, receiptPath, (value) => value as Record<string, unknown>, async (_path, receipt) => unchangedStableReceipt(receipt), {
        afterLeafOpen: async () => { await rename(hostRoot, heldHostRoot); await symlink(heldHostRoot, hostRoot, "dir"); }
      })).resolves.toMatchObject({ insideRoot: true, entry: null });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "linux")("keeps list and id reads out of a post-readdir ancestor symlink, including raw-prompt purge", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-ancestor-race-"));
    const outside = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-ancestor-race-outside-"));
    try {
      const nested = join(root, "nested");
      const held = join(root, "nested-held");
      const receiptPath = join(nested, "prompt.receipt.json");
      await mkdir(nested);
      await writeFile(receiptPath, `${JSON.stringify(expiredPromptReceipt())}\n`, "utf8");
      await writeFile(join(outside, "prompt.receipt.json"), `${JSON.stringify({ ...expiredPromptReceipt(), id: "foreign-receipt" })}\n`, "utf8");
      const retarget = async () => {
        await rename(nested, held);
        await symlink(outside, nested, "dir");
      };
      const normalize = (value: unknown) => value as OperationReceipt;

      await expect(readStableReceiptEntries(root, normalize, enforceRawPromptExpiry, { afterReaddir: retarget })).resolves.toMatchObject({ entries: [] });
      await expect(readStableReceiptEntry(root, receiptPath, normalize, enforceRawPromptExpiry)).resolves.toMatchObject({ insideRoot: true, entry: null });
      await rm(nested, { force: true });
      await rename(held, nested);
      await expect(readStableReceiptEntry(root, receiptPath, normalize, enforceRawPromptExpiry, { afterLeafOpen: retarget }))
        .resolves.toMatchObject({ insideRoot: true, entry: null });
      // The post-readdir refusal must never purge or overwrite through the new pathname.
      expect(await readFile(join(held, "prompt.receipt.json"), "utf8")).toContain("private prompt bytes");
      expect(await readFile(join(outside, "prompt.receipt.json"), "utf8")).toContain("foreign-receipt");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("returns the admitted bytes and the exact post-purge replacement outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-receipt-snapshot-purge-"));
    const receiptPath = join(root, "prompt.receipt.json");
    try {
      const originalBytes = `${JSON.stringify(expiredPromptReceipt())}\n`;
      await writeFile(receiptPath, originalBytes, "utf8");
      const read = await readStableReceiptEntry(root, receiptPath, (value) => value as OperationReceipt, enforceRawPromptExpiry);
      expect(read.entry).not.toBeNull();
      const snapshot = read.entry?.snapshot;
      const onDisk = await readFile(receiptPath);
      const facts = await lstat(receiptPath);
      expect(snapshot).toMatchObject({
        sha256: hashBuffer(Buffer.from(originalBytes, "utf8")),
        byteLength: Buffer.byteLength(originalBytes, "utf8"),
        identity: { dev: expect.any(Number), ino: expect.any(Number) },
        postPurge: { state: "purged", snapshot: {
          sha256: hashBuffer(onDisk),
          byteLength: onDisk.byteLength,
          identity: { dev: expect.any(Number), ino: expect.any(Number) }
        } }
      });
      expect(snapshot?.postPurge.state).toBe("purged");
      if (snapshot?.postPurge.state === "purged") {
        expect(snapshot.postPurge.snapshot).toEqual({
          sha256: hashBuffer(onDisk), byteLength: onDisk.byteLength, identity: { dev: facts.dev, ino: facts.ino }
        });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("does not parse or enforce after a same-inode direct-reader append", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-direct-receipt-append-"));
    const receiptPath = join(root, "prompt.receipt.json");
    try {
      const original = `${JSON.stringify(expiredPromptReceipt())}\n`;
      await writeFile(receiptPath, original, "utf8");
      let enforced = false;

      const read = await readVerifiedJsonReceipt(
        receiptPath,
        (value) => value as OperationReceipt,
        async (path, receipt, source, verifiedFile) => {
          enforced = true;
          return await enforceRawPromptExpiry(path, receipt, source, verifiedFile);
        },
        { afterOpen: async () => { await appendFile(receiptPath, " ", "utf8"); } }
      );

      expect(read).toBeNull();
      expect(enforced).toBe(false);
      expect(await readFile(receiptPath, "utf8")).toBe(`${original} `);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function expiredPromptReceipt(): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "expired-prompt", operation: "prompt.run", status: "failed", packageId: "pkg",
    inputHashes: { request: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "agent",
    output: {
      rawRequest: "private prompt bytes",
      promptRetention: { mode: "raw_request", rawRequestRetained: true, deleteAfter: "2020-01-01T00:00:00.000Z", purpose: "debugging" }
    },
    warnings: []
  };
}
