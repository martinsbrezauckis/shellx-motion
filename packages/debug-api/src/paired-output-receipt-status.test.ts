import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

// This exercises a real receipt/output pair and is intentionally confined to the exact qualified Linux GPU-host
// Node 24 fixture. WSL source checks retain only the injected pure publication proofs.
const publicationFixtureRoot = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_ROOT;
const describeQualifiedLinuxGpuPublication = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_FIXTURE === "1" && process.versions.node.startsWith("24.") && publicationFixtureRoot ? describe : describe.skip;

describeQualifiedLinuxGpuPublication("paired delivery receipt status", () => {
  it("does not report a marked receipt-only crash state as a completed render", async () => {
    const root = await mkdtemp(join(resolve(publicationFixtureRoot!), "paired-status-"));
    roots.push(root);
    const outputPath = join(root, "final.mp4");
    const receiptPath = join(root, "pkg-render.receipt.json");
    const bytes = "final media";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const receipt = {
      schema: "shellx-motion/receipt@1", id: "paired-status", operation: "render.final", status: "passed", packageId: "pkg",
      inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "ffmpeg",
      output: {
        path: outputPath, sha256,
        pairedOutputReceiptPublication: { schema: "shellx-motion/paired-output-receipt@1", receiptPath }
      },
      artifacts: [
        { role: "rendered_media", path: outputPath, status: "available", primary: true },
        { role: "render_receipt", path: receiptPath, status: "available" }
      ],
      warnings: []
    };
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");

    await expect(dispatchDebugCommand("motion.render.status", { receiptsRoot: root }, { tier: "read_motion" }))
      .resolves.toMatchObject({ ok: true, result: { jobCount: 0 } });

    await writeFile(outputPath, bytes, "utf8");
    await expect(dispatchDebugCommand("motion.render.status", { receiptsRoot: root }, { tier: "read_motion" }))
      .resolves.toMatchObject({ ok: true, result: { jobCount: 1, jobs: [expect.objectContaining({ receiptId: "paired-status" })] } });
  });
});
