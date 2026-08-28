import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand, type MotionDebugContext } from "./index.js";

const CONTRAST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC", "base64");
const BLACK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYGD4D8IABgMB/8+HxnAAAAAASUVORK5CYII=", "base64");

describe("Debug batch quality resume identity", () => {
  for (const mutation of ["baseline", "manifest"] as const) {
    it(`resumes an unchanged quality closure but refuses stale success after ${mutation} bytes change`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), `shellx-motion-debug-batch-quality-${mutation}-`));
      const outDir = join(tempRoot, "batch");
      const baselinePath = join(tempRoot, "baseline.png");
      const manifestPath = join(tempRoot, "quality-manifest.json");
      let renders = 0;
      const browserFrameRenderer: NonNullable<MotionDebugContext["browserFrameRenderer"]> = async (pkg, options) => {
        renders += 1;
        const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}.png`);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, CONTRAST_PNG);
        const output = {
          path: outputPath, sha256: "f".repeat(64), format: "png" as const,
          width: pkg.motion.width, height: pkg.motion.height, atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        };
        return { ok: true, output, receipt: {
          schema: "shellx-motion/receipt@1" as const, id: `batch-quality-${renders}`,
          operation: "preview.frame", status: "passed" as const, packageId: pkg.manifest.id,
          inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-12T00:00:00.000Z",
          lane: "browser", output, warnings: []
        } };
      };
      const writeManifest = async (id: string) => writeFile(manifestPath, `${JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        samples: [{ id, atMs: 0, baseline: "baseline.png", minBrightPixels: 0, maxChangedPixels: 2, maxMeanDiff: 255 }]
      }, null, 2)}\n`, "utf8");
      const args = { packageRoot: resolve("../../fixtures/packages/batch-card"), outDir, preset: "png-sequence" as const, dryRun: false, qualityManifestPath: manifestPath };
      const context: MotionDebugContext = { tier: "render_motion", callerId: "test:batch-quality", scratchRoot: tempRoot, browserFrameRenderer };

      try {
        await writeFile(baselinePath, CONTRAST_PNG);
        await writeManifest("frame");
        const first = await dispatchDebugCommand("motion.render.batch", args, context);
        expect(first.ok, first.ok ? "" : JSON.stringify(first.error)).toBe(true);
        const initialRenders = renders;
        expect(initialRenders).toBeGreaterThan(0);
        const firstJobs = (first.result as { jobs: Array<Record<string, string>> }).jobs;

        const unchanged = await dispatchDebugCommand("motion.render.batch", { ...args, resume: true }, {
          ...context, browserFrameRenderer: async () => { throw new Error("unchanged closure must resume"); }
        });
        expect(unchanged.ok).toBe(true);
        expect(unchanged.result).toMatchObject({ resumedRows: 2, renderedRows: 0 });

        if (mutation === "baseline") await writeFile(baselinePath, BLACK_PNG);
        else await writeManifest("frame changed");
        const changed = await dispatchDebugCommand("motion.render.batch", { ...args, resume: true }, context);
        expect(changed.ok).toBe(false);
        expect(renders).toBe(initialRenders);
        const plan = JSON.parse(await readFile(join(outDir, "receipts", "pkg_batch_card_ada.batch-row.receipt.json"), "utf8"));
        expect(plan.output.idempotencyKey).not.toBe(firstJobs[0].idempotencyKey);
        expect(plan.inputHashes.qualityClosure).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }, 45_000);
  }
});
