import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand, type MotionDebugContext } from "./index.js";

const FRAME = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC", "base64");
const OWNER = "cut:resume-descendant-authority";

describe("Debug batch resume descendant authority", () => {
  it("resumes an unchanged owner-controlled batch without rendering again", async () => {
    await withBatchWorkspace(async ({ args, resume, seed }) => {
      const first = await seed();
      expect(first.ok).toBe(true);

      const resumed = await resume();
      expect(resumed).toMatchObject({ ok: true, result: { resume: true, resumedRows: 2, renderedRows: 0 } });
    });
  }, 120_000);

  it.skipIf(process.platform === "win32")("refuses a linked render descendant before retained rows can be skipped", async () => {
    await withBatchWorkspace(async ({ args, resume, seed, root }) => {
      const first = await seed();
      expect(first.ok).toBe(true);

      const retainedRender = join(root, "retained-render");
      await rename(join(args.outDir, "render"), retainedRender);
      await symlink(retainedRender, join(args.outDir, "render"), "dir");

      await expectRetainedRefusal(resume);
    });
  }, 120_000);

  it.skipIf(process.platform === "win32")("refuses a linked retained row receipt before it is used as resume evidence", async () => {
    await withBatchWorkspace(async ({ args, resume, seed, root }) => {
      const first = await seed();
      expect(first.ok).toBe(true);
      const firstJob = batchJobs(first)[0]!;
      const sourceReceiptPath = String(firstJob.receiptPath);
      const movedReceipt = join(root, "retained-row-receipt.json");
      await rename(sourceReceiptPath, movedReceipt);
      await symlink(movedReceipt, sourceReceiptPath, "file");

      await expectRetainedRefusal(resume);
    });
  }, 120_000);

  it.skipIf(process.platform === "win32")("rechecks a row output leaf after preflight before it can be recorded as resumed", async () => {
    await withBatchWorkspace(async ({ resume, seed, root }) => {
      const first = await seed();
      expect(first.ok).toBe(true);
      const outputPath = String(batchJobs(first)[1]!.outputPath);
      let replaced = false;

      const resumed = await resume({
        batchTestHooks: {
          beforeNextRow: async () => {
            if (replaced) return;
            replaced = true;
            const movedOutput = join(root, "retained-output");
            await rename(outputPath, movedOutput);
            await symlink(movedOutput, outputPath, "dir");
          }
        }
      });
      expect(resumed).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/linked|artifact/i) } });
    });
  }, 120_000);

  it("refuses a retained row whose receipt escapes the exact receipts descendant", async () => {
    await withBatchWorkspace(async ({ args, resume, seed, root }) => {
      const first = await seed();
      expect(first.ok).toBe(true);
      const aggregatePath = join(args.outDir, "receipts", "batch-render.receipt.json");
      const aggregate = JSON.parse(await readFile(aggregatePath, "utf8")) as { output: { jobs: Array<Record<string, unknown>> } };
      const escapedReceipt = join(root, "escaped-row-receipt.json");
      await writeFile(escapedReceipt, "{}\n", "utf8");
      aggregate.output.jobs[0]!.receiptPath = escapedReceipt;
      await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");

      await expectRetainedRefusal(resume);
    });
  }, 120_000);

  it.skipIf(process.platform === "win32")("refuses a descendant directory replacement after resume admission and before a row is skipped", async () => {
    await withBatchWorkspace(async ({ args, resume, seed }) => {
      const first = await seed();
      expect(first.ok).toBe(true);

      const resumed = await resume({
        batchTestHooks: {
          beforeNextRow: async () => {
            const movedRender = join(args.outDir, "render-retained");
            await rename(join(args.outDir, "render"), movedRender);
            await mkdir(join(args.outDir, "render"), { mode: 0o700 });
          }
        }
      });
      expect(resumed).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/changed|identity/i) } });
    });
  }, 120_000);
});

async function withBatchWorkspace(
  test: (workspace: {
    root: string;
    args: { packageRoot: string; outDir: string; preset: "png-sequence"; dryRun: false };
    seed: () => ReturnType<typeof dispatchDebugCommand>;
    resume: (extra?: Partial<MotionDebugContext>) => ReturnType<typeof dispatchDebugCommand>;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), ".scratch-batch-resume-descendant-"));
  const args = {
    packageRoot: resolve("../../fixtures/packages/batch-card"),
    outDir: join(root, "batch"),
    preset: "png-sequence" as const,
    dryRun: false as const
  };
  const browserFrameRenderer: NonNullable<MotionDebugContext["browserFrameRenderer"]> = async (pkg, options) => {
    const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}.png`);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, FRAME);
    const output = {
      path: outputPath,
      sha256: "a".repeat(64),
      format: "png" as const,
      width: pkg.motion.width,
      height: pkg.motion.height,
      atMs: options.atMs,
      browser: { name: "chromium", version: "test" },
      viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
    };
    return {
      ok: true as const,
      output,
      receipt: {
        schema: "shellx-motion/receipt@1" as const,
        id: `batch-resume-descendant-${options.atMs}`,
        operation: "preview.frame",
        status: "passed" as const,
        packageId: pkg.manifest.id,
        inputHashes: { motion: "b".repeat(64) },
        createdAt: "2026-08-29T00:00:00.000Z",
        lane: "browser",
        output,
        warnings: []
      }
    };
  };
  const seed = async () => await dispatchDebugCommand("motion.render.batch", args, {
    tier: "render_motion",
    callerId: OWNER,
    browserFrameRenderer
  });
  const resume = async (extra: Partial<MotionDebugContext> = {}) => await dispatchDebugCommand("motion.render.batch", { ...args, resume: true }, {
    tier: "render_motion",
    callerId: OWNER,
    browserFrameRenderer: async () => { throw new Error("retained rows must not render again"); },
    ...extra
  });
  const run = async () => await test({ root, args, seed, resume });
  try {
    if (process.platform === "win32") await run();
    else {
      const anchor = await createTrustedWorkspaceAnchor(resolve("../.."));
      await withTrustedWorkspaceAnchor(anchor, run);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function batchJobs(result: Awaited<ReturnType<typeof dispatchDebugCommand>>): Array<Record<string, unknown>> {
  if (!result.ok) throw new Error(`Expected a seeded batch, received ${result.error.code}.`);
  const output = result.result as { jobs?: Array<Record<string, unknown>> };
  if (!Array.isArray(output.jobs)) throw new Error("Seeded batch did not return rows.");
  return output.jobs;
}

async function expectRetainedRefusal(resume: () => ReturnType<typeof dispatchDebugCommand>): Promise<void> {
  const resumed = await resume();
  expect(resumed).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/exact|linked|retained|private/i) } });
}
