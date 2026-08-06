/**
 * The Debug-API batch reports receipt status under the SAME rule as every other receipt surface.
 *
 * Role: pins `motion.render.batch` — the batch surface an AGENT drives — to
 * `receiptStatusForWarnings` in `@shellx-motion/core`, at both levels it publishes a status:
 * `output.jobs[].status` per row, and the aggregate `status` on `batch-render.receipt.json`.
 *
 * Why this file exists rather than an assertion bolted onto an existing batch test: the
 * The CLI batch, connectors, and core use the unified rule. This surface must use it too.
 * `scripts/render-batch-smoke.ts` drives
 * `runCli`, so the debug batch had no status coverage at all — a gate measuring less than its name
 * implies. The regression is demonstrated by rendering
 * `fixtures/packages/batch-card` at `mp4-h264` through both surfaces:
 *
 *     CLI batch        aggregate=warning   ada=warning   grace=warning
 *     Debug-API batch  aggregate=passed    ada=passed    grace=passed
 *
 * on the byte-identical `Rendered motion is static for 100.0% of its duration` advisory. Both
 * receipts shipped that warning in `warnings`; only one let it reach `status`.
 *
 * The fixture is chosen for that property: batch-card is a still card, so the motion-density
 * advisory fires deterministically on any machine with FFmpeg, with no dependence on encoder
 * chatter (which the rule deliberately does not escalate on).
 *
 * Dependencies: `dispatchDebugCommand` from this package; `@shellx-motion/core` for the rule under
 * test. Primary caller: `pnpm test` in `packages/debug-api`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptStatusForWarnings } from "@shellx-motion/core";
import { dispatchDebugCommand } from "./index";
import { BATCH_STATIC_FIXTURE_STATUS } from "./batch-receipt-status.test-support";

/** Only the fields these assertions read out of `batch-render.receipt.json`. */
interface BatchReceiptFacts {
  status: string;
  warnings?: string[];
  output?: { jobs?: Array<{ rowId?: string; status?: string; warnings?: string[] }> };
}

/** The advisory batch-card is guaranteed to produce: it is a still card by design. */
const MOTION_DENSITY_ADVISORY = /^Rendered motion is static for /;

describe("debug batch receipt status", () => {
  it("derives row AND aggregate status from the shared rule, so neither can claim passed while carrying an actionable warning", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-status-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        { packageRoot: "../../fixtures/packages/batch-card", outDir, preset: "mp4-h264", dryRun: false },
        { tier: "render_motion" }
      );
      expect(result.ok, `batch render failed: ${JSON.stringify(result, null, 2)}`).toBe(true);

      const receipt = JSON.parse(
        await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")
      ) as BatchReceiptFacts;

      // Guard the guard: if this fixture ever stops producing the advisory, the assertions below
      // would pass vacuously on a `passed`/no-warnings batch and this file would silently stop
      // testing anything.
      const aggregateWarnings = receipt.warnings ?? [];
      expect(
        aggregateWarnings.some((warning) => MOTION_DENSITY_ADVISORY.test(warning)),
        `batch-card no longer emits the motion-density advisory, so this test proves nothing. Warnings: ${JSON.stringify(aggregateWarnings)}`
      ).toBe(true);

      const rows = receipt.output?.jobs ?? [];
      expect(rows.length, "expected batch-card to expand to at least one row").toBeGreaterThan(0);

      // Each row answers the rule applied to its OWN warnings.
      for (const row of rows) {
        expect(row.status, `row ${row.rowId} status must follow the shared rule`).toBe(
          receiptStatusForWarnings({ warnings: row.warnings ?? [] })
        );
      }

      // The aggregate answers the rule applied to the set it publishes -- it cannot be quieter than
      // the rows it aggregates.
      expect(receipt.status, "aggregate status must follow the shared rule").toBe(
        receiptStatusForWarnings({ warnings: aggregateWarnings })
      );
      expect(receipt.status, "an aggregate carrying the motion-density advisory cannot be `passed`").toBe(BATCH_STATIC_FIXTURE_STATUS);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 600_000);

  it("resumes rows that succeeded with a warning instead of re-rendering them", async () => {
    // The half of the change that has no other coverage. `index.test.ts` exercises resume through an
    // INJECTED FFmpeg runner, so its rows carry no warnings and report `passed` — meaning it would
    // stay green whether resume matched on the literal `passed` or on the job outcome. That is the
    // precise blind spot that let the identical regression ship in the CLI: resume kept matching on
    // `!== "passed"`, and the moment successful rows began reporting `warning` it silently
    // re-rendered every row it should have reused. Nothing failed; the work was just done twice.
    //
    // So this drives the REAL renderer, where batch-card's rows do report `warning`, and asserts the
    // second pass reused them.
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-resume-warning-"));
    try {
      const args = { packageRoot: "../../fixtures/packages/batch-card", outDir, preset: "mp4-h264" as const, dryRun: false };
      const first = await dispatchDebugCommand("motion.render.batch", args, { tier: "render_motion" });
      expect(first.ok, `first batch failed: ${JSON.stringify(first, null, 2)}`).toBe(true);

      const firstReceipt = JSON.parse(
        await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")
      ) as BatchReceiptFacts;
      const rowCount = (firstReceipt.output?.jobs ?? []).length;
      // Guard the guard: if the rows are not `warning`, this test is not covering the regression.
      expect(
        (firstReceipt.output?.jobs ?? []).every((row) => row.status === BATCH_STATIC_FIXTURE_STATUS),
        `expected every row to succeed WITH a warning, got ${JSON.stringify((firstReceipt.output?.jobs ?? []).map((row) => row.status))}`
      ).toBe(true);

      const second = await dispatchDebugCommand(
        "motion.render.batch",
        { ...args, resume: true },
        { tier: "render_motion" }
      );
      expect(second.ok, `resume batch failed: ${JSON.stringify(second, null, 2)}`).toBe(true);

      const resumed = JSON.parse(
        await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")
      ) as BatchReceiptFacts & { output?: { resumedRows?: number; renderedRows?: number } };
      expect(resumed.output?.resumedRows, "every warned row should have been reused, not re-rendered").toBe(rowCount);
      expect(resumed.output?.renderedRows, "resume re-rendered rows it already had").toBe(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 900_000);
});
