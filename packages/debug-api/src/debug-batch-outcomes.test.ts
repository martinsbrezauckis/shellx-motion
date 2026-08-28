import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDebugBatchResumeMatch } from "./debug-batch-outcomes.js";

describe("debug batch resume ownership", () => {
  it("reuses a completed row only for the caller that owns its retained idempotency evidence", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-batch-resume-match-"));
    const outputPath = join(root, "row.mp4");
    const receiptPath = join(root, "row.receipt.json");
    await writeFile(outputPath, "rendered", "utf8");
    await writeFile(receiptPath, "{}\n", "utf8");
    const idempotencyKey = "pkg:row:mp4:owner-qualified";
    const previous = new Map([[idempotencyKey, {
      idempotencyKey,
      callerId: "cut:workspace-a",
      outputPath,
      receiptPath,
      status: "passed"
    }]]);

    try {
      expect(readDebugBatchResumeMatch(previous, idempotencyKey, outputPath, "cut:workspace-a")).toMatchObject({ callerId: "cut:workspace-a" });
      expect(readDebugBatchResumeMatch(previous, idempotencyKey, outputPath, "design-studio:workspace-b")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
