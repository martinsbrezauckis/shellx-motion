/**
 * The raw-prompt purge must delete a key, not rewrite the receipt.
 *
 * Read-time enforcement of `rawRequestDeleteAfter` persists the redacted receipt back over the
 * stored one -- that write IS the purge. The defect this suite guards is what got written: the
 * persist-back serialised `readOperationReceipt`'s PROJECTION, a normalized view that models only
 * the fields the debug API happens to consume. Everything else in the file was silently dropped, and
 * one field was invented: `output.artifacts` is merged into a new top-level `artifacts` array.
 *
 * That turns a privacy feature into an integrity bug. A detached signature, a `parentReceiptId`, any
 * field a future writer adds -- all destroyed by a `read_motion` READ, the lowest tier there is. And
 * Prompt/render controls record the stable reader's admitted-byte snapshot, so a read that rewrites
 * the bytes must retain an explicit post-purge outcome rather than silently changing that evidence.
 *
 * The correct purge deletes `output.rawRequest` from the PARSED ORIGINAL and re-serialises that, so
 * every field the normalizer does not model survives. These cases pin that, plus the four properties
 * the previous fix got right and must keep: the temp file holds redacted content, a failed rename
 * cannot leak, a failed persist still returns a redacted read, and a malformed retention record
 * fails closed.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const RAW_PROMPT = "raw-prompt-body-past-its-deletion-deadline";
const RECEIPT_ID = "prompt-expired-1";
const LEGACY_RECEIPT_OPERATOR = "test-operator";

let receiptsRoot: string;
let receiptPath: string;

/**
 * A persisted prompt receipt carrying fields the debug API's normalizer does not model.
 *
 * `signature`, `parentReceiptId` and `output.artifacts` are the three shapes the finding named:
 * an unmodeled top-level object, an unmodeled top-level scalar, and a nested array the normalizer
 * relocates. `retention` is expired, so any read triggers the purge.
 */
function storedReceipt(retention: unknown): Record<string, unknown> {
  return {
    schema: "shellx-motion/receipt@1",
    id: RECEIPT_ID,
    operation: "prompt.run",
    status: "passed",
    packageId: "pkg_expiry",
    inputHashes: { prompt: "c".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: "prompt",
    parentReceiptId: "prompt-parent-0",
    signature: { alg: "ed25519", value: "d".repeat(128), signedAt: "2026-07-01T00:00:01.000Z" },
    output: {
      rawRequest: RAW_PROMPT,
      requestSummary: "summary that survives",
      promptRetention: retention,
      artifacts: [{ role: "prompt_transcript", path: "/tmp/transcript.txt", status: "available" }]
    },
    warnings: [],
    // A field no code in this repository reads. It is here precisely because nothing models it.
    vendorExtensions: { shellx: { channel: "beta" } }
  };
}

function expiredRetention(): Record<string, unknown> {
  return {
    mode: "raw_request",
    rawRequestRetained: true,
    summaryRedacted: true,
    summaryMaxBytes: 4096,
    deleteAfter: "2020-01-01T00:00:00.000Z",
    purpose: "debugging"
  };
}

async function writeStored(retention: unknown): Promise<void> {
  await writeFile(receiptPath, `${JSON.stringify(storedReceipt(retention), null, 2)}\n`, "utf8");
}

async function readStored(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
}

async function readViaDebugApi(): Promise<{ ok: boolean; body: string }> {
  const result = await dispatchDebugCommand(
    "motion.receipts.read",
    { receiptsRoot, receiptId: RECEIPT_ID },
    {
      tier: "read_motion",
      receiptsRoot,
      callerId: LEGACY_RECEIPT_OPERATOR,
      crossCallerJobScope: true
    }
  );
  return { ok: result.ok, body: JSON.stringify(result) };
}

beforeEach(async () => {
  receiptsRoot = await mkdtemp(join(tmpdir(), "motion-expiry-purge-"));
  receiptPath = join(receiptsRoot, `${RECEIPT_ID}.receipt.json`);
});

afterEach(async () => {
  await chmod(receiptsRoot, 0o700).catch(() => {});
  await rm(receiptsRoot, { recursive: true, force: true });
});

describe("expired raw-prompt purge preserves the receipt it purges", () => {
  it.runIf(process.platform === "linux")("removes only output.rawRequest and keeps every unmodeled field", async () => {
    await writeStored(expiredRetention());

    const read = await readViaDebugApi();
    const after = await readStored();

    expect(read.ok).toBe(true);
    expect(read.body).not.toContain(RAW_PROMPT);
    expect(after.parentReceiptId).toBe("prompt-parent-0");
    expect(after.signature).toEqual({ alg: "ed25519", value: "d".repeat(128), signedAt: "2026-07-01T00:00:01.000Z" });
    expect(after.vendorExtensions).toEqual({ shellx: { channel: "beta" } });
    const output = after.output as Record<string, unknown>;
    expect("rawRequest" in output).toBe(false);
    expect(output.requestSummary).toBe("summary that survives");
    expect(output.artifacts).toEqual([{ role: "prompt_transcript", path: "/tmp/transcript.txt", status: "available" }]);
  });

  it.runIf(process.platform === "linux")("does not invent a top-level artifacts array by hoisting output.artifacts", async () => {
    // The normalizer merges `artifacts` and `output.artifacts` into one top-level list for its own
    // callers. Persisting that view writes a field the author never stored.
    await writeStored(expiredRetention());

    await readViaDebugApi();
    const after = await readStored();

    expect("artifacts" in after).toBe(false);
  });

  it.runIf(process.platform === "linux")("adds nothing beyond the purge itself to the stored key set", async () => {
    // Stated as a key-set property rather than a field list so a normalizer that starts modelling
    // some new field cannot quietly begin writing it back into everyone's receipts.
    await writeStored(expiredRetention());
    const before = Object.keys(await readStored()).sort();

    await readViaDebugApi();
    const after = Object.keys(await readStored()).sort();

    expect(after).toEqual(before);
  });

  it.runIf(process.platform === "linux")("rewrites the retention record to its redacted state and says so in warnings", async () => {
    await writeStored(expiredRetention());

    await readViaDebugApi();
    const after = await readStored();

    const output = after.output as Record<string, unknown>;
    expect(output.promptRetention).toMatchObject({
      mode: "raw_request",
      rawRequestRetained: false,
      deleteAfter: "2020-01-01T00:00:00.000Z",
      purpose: "debugging",
      rawRequestRedactedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
    expect(after.warnings).toEqual([expect.stringContaining("Raw prompt redacted:")]);
  });

  it.runIf(process.platform === "linux")("is idempotent: a second read leaves the bytes untouched", async () => {
    await writeStored(expiredRetention());

    await readViaDebugApi();
    const firstBytes = await readFile(receiptPath, "utf8");
    await readViaDebugApi();
    const secondBytes = await readFile(receiptPath, "utf8");

    expect(secondBytes).toBe(firstBytes);
  });

  it.runIf(process.platform === "linux")("fails closed on a malformed retention record without rewriting the evidence of it", async () => {
    // A record that cannot prove a live window loses the raw content anyway, and the record itself
    // is left exactly as stored, because a malformed record IS the evidence.
    await writeStored({ mode: "raw_request", rawRequestRetained: true, deleteAfter: "not-a-timestamp", purpose: "debugging" });

    const read = await readViaDebugApi();
    const after = await readStored();

    expect(read.body).not.toContain(RAW_PROMPT);
    const output = after.output as Record<string, unknown>;
    expect("rawRequest" in output).toBe(false);
    expect(output.promptRetention).toEqual({
      mode: "raw_request",
      rawRequestRetained: true,
      deleteAfter: "not-a-timestamp",
      purpose: "debugging"
    });
    expect(after.signature).toBeTruthy();
  });

  it.runIf(process.platform === "linux")("keeps a live raw prompt exactly as stored", async () => {
    await writeStored({
      mode: "raw_request",
      rawRequestRetained: true,
      summaryRedacted: true,
      summaryMaxBytes: 4096,
      deleteAfter: "2099-01-01T00:00:00.000Z",
      purpose: "debugging"
    });
    const before = await readFile(receiptPath, "utf8");

    await readViaDebugApi();

    expect(await readFile(receiptPath, "utf8")).toBe(before);
  });

  // chmod mode bits do not establish a deny-write ACL on Windows, so these two failure fixtures
  // are Linux-only alongside the stable-reader/purge capability they exercise.
  it.runIf(process.platform === "linux")("still returns a redacted read when the store cannot be rewritten", async () => {
    if (process.getuid?.() === 0) return;
    await writeStored(expiredRetention());
    await chmod(receiptsRoot, 0o500);

    const read = await readViaDebugApi();

    expect(read.ok).toBe(true);
    expect(read.body).not.toContain(RAW_PROMPT);
    // Failing to purge is a reason to keep the bytes on disk, never a reason to hand back the prompt.
    expect(await readFile(receiptPath, "utf8")).toContain(RAW_PROMPT);
  });

  it.runIf(process.platform === "linux")("leaves no temp file behind when the persist-back cannot complete", async () => {
    if (process.getuid?.() === 0) return;
    await writeStored(expiredRetention());
    await chmod(receiptsRoot, 0o500);

    await readViaDebugApi();

    await chmod(receiptsRoot, 0o700);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(receiptsRoot)).filter((name) => name.includes(".redacting-"))).toEqual([]);
  });
});
