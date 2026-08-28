import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareDebugBatchOutput } from "./batch-output-admission";
import { dispatchDebugCommand } from "./index";

describe("Debug batch output topology", () => {
  it.skipIf(process.platform === "win32")("admits owner-controlled 0700 and 0755 roots for debug resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-retained-resume-"));
    try {
      for (const mode of [0o700, 0o755]) {
        const outDir = join(root, `batch-${mode.toString(8)}`);
        await mkdir(outDir, { mode });
        await chmod(outDir, mode);

        const prepared = await prepareDebugBatchOutput(outDir, { resume: true });

        expect(prepared).not.toBeNull();
        await expect(prepared?.batchOutput.assertCurrent()).resolves.toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a sticky shared root before debug resume can parse a foreign receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-sticky-resume-"));
    const outDir = join(root, "shared-batch-output");
    const receiptPath = join(outDir, "receipts", "batch-render.receipt.json");
    const foreignReceipt = "{ this is not a Motion receipt";
    try {
      await mkdir(join(outDir, "receipts"), { recursive: true, mode: 0o700 });
      await chmod(outDir, 0o1777);
      await writeFile(receiptPath, foreignReceipt, "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        { packageRoot: resolve("../../fixtures/packages/batch-card"), outDir, preset: "mp4-h264", dryRun: false, resume: true },
        { tier: "render_motion" }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/exclusive child authority/i) } });
      await expect(readFile(receiptPath, "utf8")).resolves.toBe(foreignReceipt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses an unsafe parent before creating a batch output tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-unsafe-output-"));
    const unsafeParent = join(root, "unsafe");
    const outDir = join(unsafeParent, "batch");
    try {
      await mkdir(unsafeParent, { mode: 0o777 });
      await chmod(unsafeParent, 0o777);
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        { packageRoot: resolve("../../fixtures/packages/batch-card"), outDir, preset: "mp4-h264", dryRun: true },
        { tier: "render_motion" }
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/writable|unsafe|topology/i) } });
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
