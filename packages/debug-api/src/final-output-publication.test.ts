import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeRgbaPng } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("debug final-output publication", () => {
  it("removes an unapproved still stage when its quality manifest fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-final-publication-"));
    roots.push(root);
    const outputPath = join(root, "final.png");
    const qualityManifestPath = join(root, "quality.json");
    await writeFile(qualityManifestPath, JSON.stringify({ schema: "shellx-motion/quality-manifest@1", samples: [{ id: "fail", atMs: 0, minBrightPixels: 2 }] }));
    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: "../../fixtures/packages/keyframed-lower-third", outputPath, preset: "png-frame", qualityManifestPath
    }, {
      tier: "render_motion",
      scratchRoot: root,
      browserFrameRenderer: async (pkg, options) => {
        const path = options.outputPath ?? join(options.outDir, "frame.png");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, encodeRgbaPng(1, 1, Buffer.from([255, 255, 255, 255])));
        return {
          ok: true,
          output: { path, sha256: "a".repeat(64), width: pkg.motion.width, height: pkg.motion.height, atMs: options.atMs, browser: { name: "test", version: "1" }, viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 } },
          receipt: { schema: "shellx-motion/receipt@1", id: "staged-still", operation: "preview.frame", status: "passed", packageId: pkg.manifest.id, inputHashes: { motion: "b".repeat(64) }, createdAt: "2026-08-10T00:00:00.000Z", lane: "browser", output: { path }, warnings: [] }
        };
      }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "visual_quality_failed" } });
    if (!result.ok) {
      const detail = result.error.detail as Record<string, any>;
      expect(detail.receipt).toMatchObject({ output: { publication: "aborted" } });
      expect(detail.frameReceipt).toMatchObject({ output: { publication: "aborted" } });
      expect(JSON.stringify(detail.receipt)).not.toContain(outputPath);
      expect(JSON.stringify(detail.frameReceipt)).not.toContain(outputPath);
    }
    await expect(readdir(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
