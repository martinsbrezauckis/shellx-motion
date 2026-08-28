import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli as runCliRaw, type RunCliOptions } from "./main.js";
import { writeFastBatchPackage } from "./main.fixtures-batch.js";
import { BLACK_2X1_PNG, cliDebugReceipt, CONTRAST_PNG } from "./main.test-support.js";

const runCli = (argv: string[], options: RunCliOptions) => runCliRaw(argv, { trustedLocalTier: true, ...options });

describe("CLI batch quality resume identity", () => {
  it("resumes an unchanged quality closure but renders again when manifest or baseline bytes change in place", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-quality-resume-"));
    const sourceRoot = await writeFastBatchPackage();
    const outDir = join(tempRoot, "batch");
    const baselinePath = join(tempRoot, "baseline.png");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    let renders = 0;
    const browserFrameRenderer: NonNullable<RunCliOptions["browserFrameRenderer"]> = async (pkg, options) => {
      renders += 1;
      const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}.png`);
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeFile(outputPath, CONTRAST_PNG);
      const output = {
        path: outputPath, sha256: "f".repeat(64), format: "png" as const,
        width: pkg.motion.width, height: pkg.motion.height, atMs: options.atMs,
        browser: { name: "chromium", version: "test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
      };
      return { ok: true, output, receipt: cliDebugReceipt({
        id: `batch-quality-${renders}`, operation: "preview.frame", status: "passed",
        packageId: pkg.manifest.id, lane: "browser", output
      }) };
    };
    const writeManifest = async (sampleId: string) => writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: sampleId, atMs: 0, baseline: "baseline.png", minBrightPixels: 0, maxChangedPixels: 2, maxMeanDiff: 255 }]
    }, null, 2)}\n`, "utf8");
    const args = ["render-batch", sourceRoot, "--out", outDir, "--preset", "png-sequence", "--quality-manifest", manifestPath];

    try {
      await writeFile(baselinePath, CONTRAST_PNG);
      await writeManifest("frame");
      const first = await runCli(args, { browserFrameRenderer });
      expect(first).toMatchObject({ ok: true, jobs: [{ rowId: "ada" }, { rowId: "grace" }] });
      const firstKeys = (first.jobs as Array<Record<string, string>>).map((job) => job.idempotencyKey);
      expect(renders).toBe(6);

      const unchanged = await runCli([...args, "--resume"], { browserFrameRenderer: async () => { throw new Error("unchanged closure must resume"); } });
      expect(unchanged).toMatchObject({ ok: true, resumedRows: 2, renderedRows: 0 });
      expect((unchanged.jobs as Array<Record<string, string>>).map((job) => job.idempotencyKey)).toEqual(firstKeys);

      await writeFile(baselinePath, BLACK_2X1_PNG);
      const changedBaseline = await runCli([...args, "--resume"], { browserFrameRenderer });
      expect(changedBaseline, JSON.stringify(changedBaseline.error)).toMatchObject({ ok: true, resumedRows: 0, renderedRows: 2 });
      const baselineKeys = (changedBaseline.jobs as Array<Record<string, string>>).map((job) => job.idempotencyKey);
      expect(baselineKeys).not.toEqual(firstKeys);
      expect(renders).toBe(12);

      await writeManifest("frame changed");
      const changedManifest = await runCli([...args, "--resume"], { browserFrameRenderer });
      expect(changedManifest).toMatchObject({ ok: true, resumedRows: 0, renderedRows: 2 });
      expect((changedManifest.jobs as Array<Record<string, string>>).map((job) => job.idempotencyKey)).not.toEqual(baselineKeys);
      expect(renders).toBe(18);
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8"));
      expect(receipt.inputHashes.qualityInputs).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
