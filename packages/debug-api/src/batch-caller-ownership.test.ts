import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand, type MotionDebugContext } from "./index.js";

const FRAME = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC", "base64");

describe("Debug batch caller ownership", () => {
  it("persists one authenticated owner and refuses missing or cross-caller resume before output writes", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-batch-owner-"));
    const outDir = join(root, "batch");
    const owner = "cut:workspace-a";
    const browserFrameRenderer: NonNullable<MotionDebugContext["browserFrameRenderer"]> = async (pkg, options) => {
      const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}.png`);
      await mkdir(dirname(outputPath), { recursive: true });
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
          id: `batch-owner-${options.atMs}`,
          operation: "preview.frame",
          status: "passed" as const,
          packageId: pkg.manifest.id,
          inputHashes: { motion: "b".repeat(64) },
          createdAt: "2026-08-28T00:00:00.000Z",
          lane: "browser",
          output,
          warnings: []
        }
      };
    };
    const args = {
      packageRoot: resolve("../../fixtures/packages/batch-card"),
      outDir,
      preset: "png-sequence" as const,
      dryRun: false
    };

    const verifyOwnership = async () => {
      const first = await dispatchDebugCommand("motion.render.batch", args, {
        tier: "render_motion",
        callerId: owner,
        browserFrameRenderer
      });
      expect(first.ok, first.ok ? "" : JSON.stringify(first.error)).toBe(true);

      const aggregatePath = join(outDir, "receipts", "batch-render.receipt.json");
      const aggregateBefore = await readFile(aggregatePath, "utf8");
      const aggregate = JSON.parse(aggregateBefore) as { output: { callerId?: string; jobs: Array<{ callerId?: string; packageId: string }> } };
      expect(aggregate.output.callerId).toBe(owner);
      expect(aggregate.output.jobs).toHaveLength(2);
      for (const job of aggregate.output.jobs) {
        expect(job.callerId).toBe(owner);
        const row = JSON.parse(await readFile(join(outDir, "receipts", `${job.packageId}.batch-row.receipt.json`), "utf8")) as { output: { callerId?: string } };
        expect(row.output.callerId).toBe(owner);
      }

      const crossCaller = await dispatchDebugCommand("motion.render.batch", { ...args, resume: true }, {
        tier: "render_motion",
        callerId: "design-studio:workspace-b",
        browserFrameRenderer: async () => { throw new Error("foreign resume must not render"); }
      });
      expect(crossCaller).toMatchObject({ ok: false, error: { code: "job_not_visible" } });
      await expect(readFile(aggregatePath, "utf8")).resolves.toBe(aggregateBefore);

      const missingPrincipal = await dispatchDebugCommand("motion.render.batch", { ...args, resume: true }, {
        tier: "render_motion",
        browserFrameRenderer: async () => { throw new Error("anonymous resume must not render"); }
      });
      expect(missingPrincipal).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
      await expect(readFile(aggregatePath, "utf8")).resolves.toBe(aggregateBefore);
    };

    try {
      if (process.platform === "win32") await verifyOwnership();
      else {
        const anchor = await createTrustedWorkspaceAnchor(resolve("../.."));
        await withTrustedWorkspaceAnchor(anchor, verifyOwnership);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
