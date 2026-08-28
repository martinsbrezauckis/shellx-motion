import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitCliBatchOutput } from "./batch-output-admission";

const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("CLI batch retained-output admission", () => {
  it.skipIf(process.platform === "win32")("refuses a sticky shared root before parsing a foreign preseeded resume receipt", async () => {
    const root = await scratch();
    const outDir = join(root, "shared-batch-output");
    const receiptPath = join(outDir, "receipts", "batch-render.receipt.json");
    const foreignReceipt = "{ this is not a Motion receipt";
    await mkdir(join(outDir, "receipts"), { recursive: true, mode: 0o700 });
    await chmod(outDir, 0o1777);
    await writeFile(receiptPath, foreignReceipt, "utf8");

    const result = await admitCliBatchOutput(outDir, true);

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/exclusive child authority/i) });
    await expect(readFile(receiptPath, "utf8")).resolves.toBe(foreignReceipt);
  });

  it.skipIf(process.platform === "win32")("admits owner-controlled 0700 and 0755 retained roots for resume", async () => {
    const root = await scratch();
    for (const mode of [0o700, 0o755]) {
      const outDir = join(root, `batch-${mode.toString(8)}`);
      await mkdir(join(outDir, "receipts"), { recursive: true, mode: 0o700 });
      await chmod(outDir, mode);
      await writeFile(join(outDir, "receipts", "batch-render.receipt.json"), JSON.stringify({
        output: { jobs: [{ idempotencyKey: `retained-${mode.toString(8)}` }] }
      }), "utf8");

      const result = await admitCliBatchOutput(outDir, true);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.previousBatchJobs.get(`retained-${mode.toString(8)}`)).toMatchObject({ idempotencyKey: `retained-${mode.toString(8)}` });
        await expect(result.batchOutput.assertCurrent()).resolves.toBeUndefined();
      }
    }
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-output-admission-"));
  roots.push(root);
  return root;
}
