import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedResourceBudget, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { readSourceImportReceiptEvidence } from "./source-import-receipt-evidence";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("source import receipt evidence", () => {
  it("returns no evidence when the exact adjacent receipt is absent", async () => {
    const { sourcePath, sourceRoot, markdownHash } = await fixture();
    await expect(readEvidence(sourcePath, sourceRoot, markdownHash)).resolves.toBeUndefined();
  });

  it("admits a valid adjacent receipt only when its source path and hashes bind the exact Markdown", async () => {
    const { sourcePath, sourceRoot, markdownHash } = await fixture();
    const receiptPath = join(dirname(sourcePath), "receipts", "source-import.receipt.json");
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    await writeFile(receiptPath, `${JSON.stringify(receipt(sourcePath, markdownHash), null, 2)}\n`, "utf8");
    const result = await readEvidence(sourcePath, sourceRoot, markdownHash);
    expect(result).toEqual({ path: receiptPath, sha256: digest(await readFile(receiptPath)), byteLength: (await readFile(receiptPath)).byteLength });
  });

  it.each([
    ["wrong schema", (value: any) => { value.schema = "shellx-motion/receipt@0"; }],
    ["wrong operation", (value: any) => { value.operation = "source.to_scripted_video"; }],
    ["wrong input hash", (value: any) => { value.inputHashes.source = "0".repeat(64); }],
    ["wrong output hash", (value: any) => { value.output.sourceHash = "0".repeat(64); }],
    ["non-adjacent Markdown path", (value: any) => { value.output.markdownPath = "/unrelated/source.md"; }]
  ])("refuses %s before Source delivery starts", async (_label, mutate) => {
    const { sourcePath, sourceRoot, markdownHash } = await fixture();
    const receiptPath = join(dirname(sourcePath), "receipts", "source-import.receipt.json");
    const value = receipt(sourcePath, markdownHash);
    mutate(value);
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    await writeFile(receiptPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await expect(readEvidence(sourcePath, sourceRoot, markdownHash)).rejects.toThrow(/does not attest these exact source Markdown bytes/i);
  });
});

async function fixture(): Promise<{ sourcePath: string; sourceRoot: string; markdownHash: string }> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-source-receipt-"));
  roots.push(root);
  const sourceRoot = join(root, "input"), sourcePath = join(sourceRoot, "source.md"), markdown = "# Source\nImmutable evidence\n";
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await writeFile(sourcePath, markdown, "utf8");
  return { sourcePath, sourceRoot, markdownHash: digest(Buffer.from(markdown, "utf8")) };
}

async function readEvidence(sourcePath: string, sourceInputRoot: string, sourceMarkdownHash: string) {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(sourceInputRoot), async () => await readSourceImportReceiptEvidence({
    sourcePath, sourceInputRoot, sourceMarkdownHash, budget: new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, "source receipt test")
  }));
}

function receipt(sourcePath: string, sourceHash: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "source-import-test", operation: "source.import", status: "passed", packageId: "source_import",
    inputHashes: { source: sourceHash }, createdAt: "2026-08-22T00:00:00.000Z", lane: "connector-test",
    output: { markdownPath: sourcePath, sourceHash }, warnings: []
  };
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
