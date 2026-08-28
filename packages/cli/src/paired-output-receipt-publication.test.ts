import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { PairedOutputReceiptPublication, verifyPairedReceiptOutput, type PairedOutputReceiptPublicationOptions } from "./paired-output-receipt-publication.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

// This suite deliberately exercises the real governed filesystem boundary. It is not WSL source
// evidence: run it only on the exact Node 24 qualified Linux GPU-host checkout with the explicit fixture admission.
const publicationFixtureRoot = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_ROOT;
const describeQualifiedLinuxGpuPublication = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_FIXTURE === "1" && process.versions.node.startsWith("24.") && publicationFixtureRoot ? describe : describe.skip;

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(resolve(publicationFixtureRoot!), "paired-output-receipt-"));
  roots.push(root);
  return root;
}

function sha256(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }

async function stagedPair(root: string, faults?: PairedOutputReceiptPublicationOptions["faults"]) {
  const outputPath = join(root, "preview.png");
  const receiptPath = join(root, "preview.receipt.json");
  const pair = await PairedOutputReceiptPublication.acquire({
    outputPath,
    receiptPath,
    outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
    receiptArtifact: { role: "preview_receipt", mediaType: "application/json" },
    ...(faults ? { faults: faults as never } : {})
  });
  const bytes = "staged preview bytes";
  await writeFile(pair.outputPublication.stagingPath, bytes, "utf8");
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1", id: "paired-preview", operation: "preview.frame", status: "passed",
    packageId: "pkg", inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "native",
    output: { path: pair.outputPublication.stagingPath, sha256: sha256(bytes) }, warnings: []
  };
  await pair.stageReceipt(receipt);
  return { pair, receipt, outputPath, receiptPath };
}

describeQualifiedLinuxGpuPublication("paired CLI output and receipt publication", () => {
  it("publishes a verified receipt first and returns only with its matching output", async () => {
    const root = await scratch();
    const { pair, receipt, outputPath, receiptPath } = await stagedPair(root);

    await pair.commit();

    await expect(readFile(outputPath, "utf8")).resolves.toBe("staged preview bytes");
    await expect(readFile(receiptPath, "utf8")).resolves.toContain("paired-preview");
    await expect(verifyPairedReceiptOutput(receiptPath, receipt)).resolves.toBeUndefined();
  });

  it("releases retained receipt state so a sequential forced same-receipt retry can acquire", async () => {
    const root = await scratch();
    const first = await stagedPair(root);
    await first.pair.commit();

    const outputPath = join(root, "retry.png");
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath,
      receiptPath: first.receiptPath,
      outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
      receiptArtifact: { role: "preview_receipt", mediaType: "application/json" },
      forceReceipt: true
    });
    await writeFile(pair.outputPublication.stagingPath, "retry preview bytes", "utf8");
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1", id: "paired-preview-retry", operation: "preview.frame", status: "passed",
      packageId: "pkg", inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "native",
      output: { path: pair.outputPublication.stagingPath, sha256: sha256("retry preview bytes") }, warnings: []
    };
    await pair.stageReceipt(receipt);
    await pair.commit();

    await expect(readFile(outputPath, "utf8")).resolves.toBe("retry preview bytes");
    await expect(verifyPairedReceiptOutput(first.receiptPath, receipt)).resolves.toBeUndefined();
  });

  it("treats a crash-equivalent receipt-only state as invalid", async () => {
    const root = await scratch();
    const { pair, receipt, receiptPath } = await stagedPair(root, {
      beforeOutputCommit: () => { throw new Error("interrupted before output commit"); }
    });

    await expect(pair.commit()).rejects.toThrow("interrupted before output commit");
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Simulate a process death after its receipt link but before its output link: consumers must
    // not promote the durable sidecar alone to success.
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await expect(verifyPairedReceiptOutput(receiptPath, receipt)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it.each([
    ["receipt preflight", { afterReceiptPreflight: () => { throw new Error("receipt preflight failed"); } }],
    ["receipt staging", { afterReceiptStaged: () => { throw new Error("receipt staging failed"); } }]
  ])("cleans both private stages when %s fails", async (_label, faults) => {
    const root = await scratch();
    const outputPath = join(root, "preview.png");
    const receiptPath = join(root, "preview.receipt.json");
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath, receiptPath,
      outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
      receiptArtifact: { role: "preview_receipt", mediaType: "application/json" }, faults
    });
    await writeFile(pair.outputPublication.stagingPath, "staged preview bytes", "utf8");
    const receipt: OperationReceipt = { schema: "shellx-motion/receipt@1", id: "paired-preview", operation: "preview.frame", status: "passed", packageId: "pkg", inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "native", output: { path: pair.outputPublication.stagingPath, sha256: sha256("staged preview bytes") }, warnings: [] };

    await expect(pair.stageReceipt(receipt)).rejects.toThrow(/receipt (preflight|staging) failed/);
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans both private stages when receipt commit fails", async () => {
    const root = await scratch();
    const { pair, outputPath, receiptPath } = await stagedPair(root, {
      beforeReceiptCommit: () => { throw new Error("receipt commit failed"); }
    });

    await expect(pair.commit()).rejects.toThrow("receipt commit failed");
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a durable receipt when output commit is uncertain, but does not recognize it without the output", async () => {
    const root = await scratch();
    const { pair, receipt, receiptPath } = await stagedPair(root, {
      afterOutputCommitAttempt: () => { throw new Error("injected post-link output verification failure"); }
    });

    await expect(pair.commit()).rejects.toMatchObject({ code: "paired_output_commit_uncertain" });
    await expect(readFile(receiptPath, "utf8")).resolves.toContain("paired-preview");
    await expect(verifyPairedReceiptOutput(receiptPath, receipt)).resolves.toBeUndefined();
  });

  it("refuses existing and symlinked receipt destinations without touching output", async ({ skip }) => {
    const root = await scratch();
    const outside = await scratch();
    const outputPath = join(root, "preview.png");
    const receiptPath = join(root, "preview.receipt.json");
    await writeFile(receiptPath, "caller receipt", "utf8");
    await expect(PairedOutputReceiptPublication.acquire({ outputPath, receiptPath, outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" } })).rejects.toMatchObject({ code: "derived_output_exists" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(receiptPath);
    try { await symlink(outside, receiptPath, "file"); }
    catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { skip("symlink creation is unavailable"); return; } throw error; }
    await expect(PairedOutputReceiptPublication.acquire({ outputPath, receiptPath, outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" } })).rejects.toMatchObject({ code: "derived_output_exists" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow a retargeted parent during output commit", async () => {
    const root = await scratch();
    const parent = join(root, "out");
    const outside = await scratch();
    await mkdir(parent, { mode: 0o700 });
    const { pair } = await stagedPair(parent, {
      beforeOutputCommit: async () => {
        await rename(parent, join(root, "out-moved"));
        await symlink(outside, parent, "dir");
      }
    });

    await expect(pair.commit()).rejects.toMatchObject({ code: "derived_output_unsafe_parent" });
    await expect(lstat(join(outside, "preview.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
