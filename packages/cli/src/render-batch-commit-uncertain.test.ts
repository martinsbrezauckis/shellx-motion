import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairedOutputReceiptPublication, PairedOutputReceiptPublicationOptions } from "./paired-output-receipt-publication.js";
import { CONTRAST_PNG } from "./main.test-support.js";

const browser = vi.hoisted(() => ({ frame: vi.fn() }));
const frameBytes = CONTRAST_PNG;
const frameSha256 = createHash("sha256").update(frameBytes).digest("hex");
const paired = vi.hoisted(() => {
  return {
    acquire: vi.fn(),
    realAcquire: undefined as undefined | ((options: PairedOutputReceiptPublicationOptions) => Promise<PairedOutputReceiptPublication>)
  };
});

vi.mock("@shellx-motion/renderer-browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/renderer-browser")>(),
  renderMotionBrowserFrame: browser.frame
}));
vi.mock("./paired-output-receipt-publication.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paired-output-receipt-publication.js")>();
  paired.realAcquire = actual.PairedOutputReceiptPublication.acquire;
  return { ...actual, PairedOutputReceiptPublication: { acquire: paired.acquire } };
});

import { runCli } from "./main.js";

const roots: string[] = [];
// This exercises real package/output admission, so it is valid only under the same Node 24
// governed fixture root as the other filesystem publication suites. Pure ordering is covered by
// paired-output-receipt-publication.pure.test.ts on every host.
const publicationFixtureRoot = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_ROOT;
const describeQualifiedLinuxGpuPublication = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_FIXTURE === "1" && process.versions.node.startsWith("24.") && publicationFixtureRoot ? describe : describe.skip;

afterEach(async () => {
  browser.frame.mockReset();
  paired.acquire.mockReset();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describeQualifiedLinuxGpuPublication("render-batch delegated publication uncertainty", () => {
  it("retains the delegated post-link paths in the row, batch receipt, and response", async () => {
    const root = await mkdtemp(join(resolve(publicationFixtureRoot!), "batch-uncertain-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const outDir = join(root, "out");
    await writeSingleRowPackage(sourceRoot);
    let delegatedReceiptPath = "";
    paired.acquire.mockImplementation(async (options: PairedOutputReceiptPublicationOptions) => {
      delegatedReceiptPath = options.receiptPath;
      return await acquireActualPair({
        ...options,
        faults: { afterOutputCommitAttempt: () => { throw new Error("injected post-link output verification failure"); } }
      });
    });
    browser.frame.mockImplementation(async (_pkg, options) => {
      await writeFile(options.outputPath, frameBytes);
      const output = {
        path: options.outputPath,
        sha256: frameSha256, format: "png", width: 16, height: 16, atMs: options.atMs,
        browser: { name: "chromium", version: "test" }, viewport: { width: 16, height: 16, deviceScaleFactor: 1 }
      };
      return {
        ok: true,
        output,
        receipt: {
          schema: "shellx-motion/receipt@1", id: "batch-uncertain-frame", operation: "preview.frame", status: "passed",
          packageId: "batch-uncertain", inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "browser", output, warnings: []
        }
      };
    });

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-frame"], { trustedLocalTier: true });
    const outputPath = join(outDir, "render", "batch-uncertain_one.png");

    expect(result).toMatchObject({
      ok: false,
      renderCommitUncertain: true,
      outputPath,
      renderReceiptPath: delegatedReceiptPath,
      error: { code: "paired_output_commit_uncertain", publicationCommitPhase: "output", publicPaths: [outputPath] },
      jobs: [{ status: "warning", renderCommitUncertain: true, renderOutputPath: outputPath, renderReceiptPath: delegatedReceiptPath }],
      receipt: {
        status: "warning",
        output: { jobs: [{ renderCommitUncertain: true, renderOutputPath: outputPath, renderReceiptPath: delegatedReceiptPath }] }
      }
    });
    await expectCommittedDelivery(outputPath, delegatedReceiptPath);
  });

  it.each([
    ["post-render assertion", "beforePostRenderAssert", "row_bookkeeping"],
    ["row receipt", "beforeRowReceiptWrite", "row_bookkeeping"],
    ["aggregate receipt", "beforeAggregateReceiptWrite", "aggregate_receipt"]
  ] as const)("retains a committed child when %s bookkeeping fails", async (_label, hook, phase) => {
    const root = await mkdtemp(join(resolve(publicationFixtureRoot!), "batch-bookkeeping-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const outDir = join(root, "out");
    await writeRowsPackage(sourceRoot, 1);
    installSuccessfulBrowserPair();

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-frame"], {
      trustedLocalTier: true,
      batchTestHooks: { [hook]: () => { throw new Error(`injected ${hook}`); } }
    });
    const outputPath = join(outDir, "render", "batch-uncertain_one.png");
    const receiptPath = join(outDir, "render", "batch-uncertain_one-render.receipt.json");

    expect(result).toMatchObject({
      ok: false,
      batchCommitted: true,
      committedDeliveries: [{ outputPath, receiptPath }],
      jobs: [{ renderCommitted: true, renderOutputPath: outputPath, renderReceiptPath: receiptPath }],
      error: { code: "render_batch_bookkeeping_failed", phase }
    });
    await expectCommittedDelivery(outputPath, receiptPath);
  });

  it("retains the first committed child when the next-row boundary fails", async () => {
    const root = await mkdtemp(join(resolve(publicationFixtureRoot!), "batch-next-row-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const outDir = join(root, "out");
    await writeRowsPackage(sourceRoot, 2);
    installSuccessfulBrowserPair();

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-frame"], {
      trustedLocalTier: true,
      batchTestHooks: { beforeNextRow: () => { throw new Error("injected next-row boundary"); } }
    });
    const outputPath = join(outDir, "render", "batch-uncertain_one.png");
    const receiptPath = join(outDir, "render", "batch-uncertain_one-render.receipt.json");

    expect(result).toMatchObject({
      ok: false,
      batchCommitted: true,
      committedDeliveries: [{ outputPath, receiptPath }],
      jobs: [{ renderCommitted: true, renderOutputPath: outputPath, renderReceiptPath: receiptPath }],
      error: { code: "render_batch_bookkeeping_failed", phase: "row_bookkeeping" }
    });
    await expectCommittedDelivery(outputPath, receiptPath);
  });
});

async function writeSingleRowPackage(root: string): Promise<void> {
  await writeRowsPackage(root, 1);
}

function installSuccessfulBrowserPair(): void {
  paired.acquire.mockImplementation(async (options: PairedOutputReceiptPublicationOptions) => await acquireActualPair(options));
  browser.frame.mockImplementation(async (_pkg, options) => {
    await writeFile(options.outputPath, frameBytes);
    const output = {
      path: options.outputPath,
      sha256: frameSha256, format: "png", width: 16, height: 16, atMs: options.atMs,
      browser: { name: "chromium", version: "test" }, viewport: { width: 16, height: 16, deviceScaleFactor: 1 }
    };
    return {
      ok: true,
      output,
      receipt: {
        schema: "shellx-motion/receipt@1", id: "batch-committed-frame", operation: "preview.frame", status: "passed",
        packageId: "batch-uncertain", inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "browser", output, warnings: []
      }
    };
  });
}

/** Delegating through the actual pair acquires Core-minted private publications for the renderer. */
async function acquireActualPair(options: PairedOutputReceiptPublicationOptions): Promise<PairedOutputReceiptPublication> {
  if (!paired.realAcquire) throw new Error("Actual paired publication acquire was not initialized.");
  return await paired.realAcquire(options);
}

async function expectCommittedDelivery(outputPath: string, receiptPath: string): Promise<void> {
  await expect(readFile(outputPath)).resolves.toEqual(frameBytes);
  await expect(readFile(receiptPath, "utf8")).resolves.toContain('"schema": "shellx-motion/receipt@1"');
}

async function writeRowsPackage(root: string, count: number): Promise<void> {
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "data", "rows.json"), JSON.stringify({
    schema: "shellx-motion/data-rows@1", rows: Array.from({ length: count }, (_, index) => ({ id: index === 0 ? "one" : `row-${index + 1}`, name: `Row ${index + 1}` }))
  }));
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "batch-uncertain", name: "Batch uncertainty", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }, data: { rows: "data/rows.json" }
  }));
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1", id: "batch-uncertain-motion", name: "Batch uncertainty", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "background", type: "shape", shape: "rect", fill: "#102030", startMs: 0, durationMs: 1_000 }]
  }));
}
