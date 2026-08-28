/**
 * The raw-prompt deletion deadline, proved end to end through a real receipt read.
 *
 * `packages/prompt` owns the redaction transform and tests it directly. What it cannot prove from
 * there is the part that makes the promise true for a user: that Motion's actual receipt reader
 * applies it. The transform existing while no reader called it is precisely the shape of the
 * original finding -- a deadline recorded and never enforced -- so this test drives
 * `motion.receipts.read` against a receipt file on disk and checks both halves of the guarantee:
 * the caller does not receive the prompt, and the stored bytes no longer contain it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const RAW_PROMPT = "raw-prompt-text-that-must-not-outlive-its-deadline";

let receiptsRoot: string;

/**
 * These fixtures model pre-ownership host evidence.  A caller-bound client
 * must not see that evidence by default; the test exercises the explicit
 * operator migration/read path instead.
 */
function legacyReceiptOperatorContext() {
  return {
    tier: "read_motion" as const,
    receiptsRoot,
    callerId: "test-operator",
    crossCallerJobScope: true
  };
}

async function writePromptReceipt(id: string, deleteAfter: string): Promise<string> {
  const path = join(receiptsRoot, `${id}.receipt.json`);
  await writeFile(path, JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id,
    operation: "prompt.run",
    status: "passed",
    packageId: "pkg_retention_probe",
    inputHashes: {},
    createdAt: new Date(0).toISOString(),
    lane: "prompt",
    warnings: [],
    artifacts: [],
    output: {
      rawRequest: RAW_PROMPT,
      promptRetention: { mode: "raw_request", rawRequestRetained: true, purpose: "debugging", deleteAfter }
    }
  }, null, 2), "utf8");
  return path;
}

beforeEach(async () => {
  receiptsRoot = await mkdtemp(join(tmpdir(), "motion-retention-"));
});

afterEach(async () => {
  await rm(receiptsRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("raw prompt retention deadline", () => {
  it("withholds the raw prompt from a read after the deadline", async () => {
    const path = await writePromptReceipt("expired-prompt", new Date(Date.now() - 60_000).toISOString());

    const result = await dispatchDebugCommand(
      "motion.receipts.read",
      { receiptsRoot, receiptPath: path },
      legacyReceiptOperatorContext()
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW_PROMPT);
  });

  it("rewrites the stored receipt so the bytes are gone, not just the response", async () => {
    // Read-time filtering alone would leave the prompt on disk for anything that opened the file
    // directly or backed it up later. The read is what triggers the purge.
    const path = await writePromptReceipt("expired-purge", new Date(Date.now() - 60_000).toISOString());
    expect(await readFile(path, "utf8")).toContain(RAW_PROMPT);

    await dispatchDebugCommand(
      "motion.receipts.read",
      { receiptsRoot, receiptPath: path },
      legacyReceiptOperatorContext()
    );

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain(RAW_PROMPT);
    // Still a valid receipt, not a truncated or emptied file.
    expect(JSON.parse(onDisk)).toMatchObject({ schema: "shellx-motion/receipt@1", id: "expired-purge" });
  });

  it("leaves a receipt inside its retention window untouched", async () => {
    // The guarantee is a deadline, not a ban: before it passes, the retained prompt is exactly what
    // the user opted into keeping, and a reader must still get it.
    const path = await writePromptReceipt("live-prompt", new Date(Date.now() + 3_600_000).toISOString());

    const result = await dispatchDebugCommand(
      "motion.receipts.read",
      { receiptsRoot, receiptPath: path },
      legacyReceiptOperatorContext()
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain(RAW_PROMPT);
    expect(await readFile(path, "utf8")).toContain(RAW_PROMPT);
  });

  it("withholds the prompt even when the stored receipt cannot be rewritten", async () => {
    // A read-only or otherwise unwritable store is a reason to keep the bytes, never a reason to
    // hand back the prompt. Simulated by removing the directory's write permission.
    const path = await writePromptReceipt("expired-readonly", new Date(Date.now() - 60_000).toISOString());
    const { chmod } = await import("node:fs/promises");
    await chmod(receiptsRoot, 0o500);

    try {
      const result = await dispatchDebugCommand(
        "motion.receipts.read",
        { receiptsRoot, receiptPath: path },
        legacyReceiptOperatorContext()
      );

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain(RAW_PROMPT);
    } finally {
      await chmod(receiptsRoot, 0o700);
    }
  });
});
