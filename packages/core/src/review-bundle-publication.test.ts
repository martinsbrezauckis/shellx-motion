import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({ target: "", bytes: "", applied: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const actualWriteFile = actual.writeFile as (...args: any[]) => Promise<void>;
  return {
    ...actual,
    writeFile: async (...args: any[]) => {
      await actualWriteFile(...args);
      if (!mutation.applied && mutation.target && String(args[0]).endsWith("review-html-bundle.html")) {
        mutation.applied = true;
        await actualWriteFile(mutation.target, mutation.bytes, "utf8");
      }
    }
  };
});

import { writeReviewBundle } from "./review-bundle";
import { readReviewBundleReceiptEntries, reviewBundleInputHashes } from "./review-bundle-receipt-data";
import { hashFile } from "./receipts";

describe("review bundle publication", () => {
  it("rejects a package changed after staged HTML was rendered and leaves the public output absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-publication-"));
    const packageRoot = join(root, "package");
    const outDir = join(root, "bundle");
    try {
      await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
      const manifestPath = join(packageRoot, "manifest.json");
      mutation.target = manifestPath;
      mutation.bytes = (await readFile(manifestPath, "utf8")).replace("Lower Third Fixture", "Late mutation");
      mutation.applied = false;

      await expect(writeReviewBundle({ packageRoot, outDir, copyArtifacts: false })).rejects.toThrow(/package or receipt input changed before publication/i);
      expect(mutation.applied).toBe(true);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      mutation.target = "";
      mutation.bytes = "";
      mutation.applied = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a receipt changed after staged HTML was rendered and leaves the public output absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-publication-receipt-"));
    const receiptsRoot = join(root, "receipts");
    const outDir = join(root, "bundle");
    const receiptPath = join(receiptsRoot, "render.receipt.json");
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      const earlyReceipt = `${JSON.stringify({
        schema: "shellx-motion/receipt@1",
        id: "render-review-late-receipt",
        operation: "render.final",
        status: "passed",
        packageId: "pkg_review",
        inputHashes: {},
        createdAt: "2026-08-11T00:00:00.000Z",
        lane: "ffmpeg",
        output: {},
        warnings: ["early"]
      })}\n`;
      await writeFile(receiptPath, earlyReceipt, "utf8");
      mutation.target = receiptPath;
      mutation.bytes = earlyReceipt.replace("early", "late");
      mutation.applied = false;

      await expect(writeReviewBundle({ receiptsRoot, outDir, copyArtifacts: false })).rejects.toThrow(/stable review bundle receipt changed before publication: render\.receipt\.json/i);
      expect(mutation.applied).toBe(true);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      mutation.target = "";
      mutation.bytes = "";
      mutation.applied = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a receipt changed after parsing before the initial receipt hash and leaves the public output absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-publication-parsed-receipt-"));
    const receiptsRoot = join(root, "receipts");
    const outDir = join(root, "bundle");
    const receiptPath = join(receiptsRoot, "render.receipt.json");
    let mutatedAfterParse = false;
    const originalParse = JSON.parse;
    const receiptParse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const parsed = originalParse(text, reviver);
      const record = typeof parsed === "object" && parsed !== null ? parsed as { id?: unknown } : undefined;
      if (!mutatedAfterParse && record?.id === "render-review-parsed-receipt") {
        mutatedAfterParse = true;
        writeFileSync(receiptPath, lateReceipt, "utf8");
      }
      return parsed;
    });
    const earlyReceipt = `${JSON.stringify({
      schema: "shellx-motion/receipt@1",
      id: "render-review-parsed-receipt",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_review",
      inputHashes: {},
      createdAt: "2026-08-11T00:00:00.000Z",
      lane: "ffmpeg",
      output: {},
      warnings: ["parsed"]
    })}\n`;
    const lateReceipt = earlyReceipt.replace("parsed", "replacement");
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, earlyReceipt, "utf8");

      await expect(writeReviewBundle({ receiptsRoot, outDir, copyArtifacts: false })).rejects.toThrow(/stable review bundle receipt changed before publication: render\.receipt\.json/i);
      expect(mutatedAfterParse).toBe(true);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      receiptParse.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the selected receipts root for a filesystem snapshot live recheck", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-receipt-root-"));
    const receiptsRoot = join(root, "receipts");
    const receiptPath = join(receiptsRoot, "render.receipt.json");
    const outsidePath = join(root, "outside.receipt.json");
    const receipt = `${JSON.stringify({
      schema: "shellx-motion/receipt@1",
      id: "render-review-root-bound",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_review",
      inputHashes: {},
      createdAt: "2026-08-11T00:00:00.000Z",
      lane: "ffmpeg",
      output: {},
      warnings: []
    })}\n`;
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await Promise.all([writeFile(receiptPath, receipt, "utf8"), writeFile(outsidePath, receipt, "utf8")]);
      const [entry] = await readReviewBundleReceiptEntries(receiptsRoot);
      expect(entry).toBeDefined();
      entry.path = outsidePath;

      await expect(reviewBundleInputHashes(undefined, [entry], { useRetainedReceiptHashes: false }))
        .rejects.toThrow(/escapes its approved root/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a filesystem receipt whose public metadata and in-root path are mutated after loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-private-receipt-hash-"));
    const receiptsRoot = join(root, "receipts");
    const receiptPath = join(receiptsRoot, "render.receipt.json");
    const replacementPath = join(receiptsRoot, "replacement.receipt");
    const outDir = join(root, "bundle");
    const receipt = `${JSON.stringify({
      schema: "shellx-motion/receipt@1",
      id: "render-review-private-hash",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_review",
      inputHashes: {},
      createdAt: "2026-08-11T00:00:00.000Z",
      lane: "ffmpeg",
      output: {},
      warnings: ["parsed"]
    })}\n`;
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(receiptPath, receipt, "utf8"),
        writeFile(replacementPath, receipt.replace("parsed", "replacement"), "utf8")
      ]);
      const [entry] = await readReviewBundleReceiptEntries(receiptsRoot);
      expect(entry).toBeDefined();
      (entry as { sourceSha256?: string }).sourceSha256 = "0".repeat(64);
      entry.path = replacementPath;

      await expect(writeReviewBundle({ receipts: [entry], outDir, copyArtifacts: false }))
        .rejects.toThrow(/^Review bundle receipt input changed before publication\.$/);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps direct in-memory receipt entries on their established live-path hashing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-direct-receipt-"));
    const receiptPath = join(root, "direct.receipt.json");
    const receipt = `${JSON.stringify({ direct: "receipt bytes" })}\n`;
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(receiptPath, receipt, "utf8");
      const directReceipt = {
        path: receiptPath,
        relativePath: "direct.receipt.json",
        // This is caller-controlled metadata, not a loader-owned snapshot authority.
        sourceSha256: "0".repeat(64),
        receipt: {
          schema: "shellx-motion/receipt@1" as const,
          id: "direct-review-receipt",
          operation: "render.final",
          status: "passed" as const,
          packageId: "pkg_review",
          inputHashes: {},
          createdAt: "2026-08-11T00:00:00.000Z",
          lane: "ffmpeg",
          output: {},
          warnings: []
        }
      };

      await expect(reviewBundleInputHashes(undefined, [directReceipt])).resolves.toEqual({
        "receipt:direct.receipt.json": await hashFile(receiptPath)
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
