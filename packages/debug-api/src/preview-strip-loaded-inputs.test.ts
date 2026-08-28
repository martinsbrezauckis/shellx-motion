import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeRgbaPng, hashFile, type OperationReceipt } from "@shellx-motion/core";
import { dispatchDebugCommand } from "./index.js";

describe("preview strip loaded-input provenance", () => {
  it("keeps package evidence bound to the bytes loaded before rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-strip-loaded-"));
    const packageRoot = join(root, "package");
    const outDir = join(root, "preview");
    await cp(resolve("../../fixtures/packages/keyframed-lower-third"), packageRoot, { recursive: true });
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")) as { motion: string };
    const motionPath = join(packageRoot, manifest.motion);
    const loadedMotionSha256 = await hashFile(motionPath);
    let replaced = false;
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.strip",
        { packageRoot, outDir, frameCount: 1, startMs: 0, endMs: 0 },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => {
            if (!replaced) {
              replaced = true;
              await writeFile(motionPath, "{\"schema\":\"replaced-after-load\"}\n", "utf8");
            }
            const outputPath = options.outputPath ?? join(options.outDir, "frame.png");
            await writeFile(outputPath, "placeholder png", "utf8");
            return {
              ok: true,
              output: {
                path: outputPath, sha256: "a".repeat(64), width: pkg.motion.width,
                height: pkg.motion.height, atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1", id: "preview-loaded-inputs",
                operation: "preview.frame", status: "passed", packageId: pkg.manifest.id,
                inputHashes: {
                  html: "c".repeat(64),
                  "assets/logo.png": "d".repeat(64)
                },
                createdAt: "2026-08-12T00:00:00.000Z", lane: "browser",
                output: { path: outputPath }, warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receipt = (result.result as { receipt: OperationReceipt }).receipt;
        expect(receipt.inputHashes[manifest.motion]).toBe(loadedMotionSha256);
        expect(receipt.inputHashes[manifest.motion]).not.toBe(await hashFile(motionPath));
        expect(receipt.inputHashes.html).toBe("c".repeat(64));
        expect(receipt.inputHashes["assets/logo.png"]).toBe("d".repeat(64));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses conflicting child-frame hashes instead of attesting a mixed strip", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-strip-conflict-"));
    const outDir = join(root, "preview");
    let frame = 0;
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.strip",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          frameCount: 2,
          startMs: 0,
          endMs: 100
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => {
            const outputPath = options.outputPath ?? join(options.outDir, "frame.png");
            const png = encodeRgbaPng(1, 1, Buffer.from([frame, 20, 40, 255]));
            await writeFile(outputPath, png);
            frame += 1;
            return {
              ok: true,
              output: {
                path: outputPath, sha256: "a".repeat(64), width: 1, height: 1,
                atMs: options.atMs, browser: { name: "chromium", version: "test" },
                viewport: { width: 1, height: 1, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1", id: `preview-conflict-${frame}`,
                operation: "preview.frame", status: "passed", packageId: pkg.manifest.id,
                inputHashes: { "assets/logo.png": (frame === 1 ? "b" : "c").repeat(64) },
                createdAt: "2026-08-12T00:00:00.000Z", lane: "browser",
                output: { path: outputPath }, warnings: []
              }
            };
          }
        }
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "preview_strip_failed", message: "Preview strip input hash changed between frames: assets/logo.png" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of truncating oversized child input evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-strip-hash-limit-"));
    const outDir = join(root, "preview");
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.strip",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          frameCount: 1,
          startMs: 0,
          endMs: 0
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => {
            const outputPath = options.outputPath ?? join(options.outDir, "frame.png");
            await writeFile(outputPath, encodeRgbaPng(1, 1, Buffer.from([10, 20, 40, 255])));
            const inputHashes = Object.fromEntries(
              Array.from({ length: 4_129 }, (_, index) => [`asset-${index}`, "b".repeat(64)])
            );
            return {
              ok: true,
              output: {
                path: outputPath, sha256: "a".repeat(64), width: 1, height: 1,
                atMs: options.atMs, browser: { name: "chromium", version: "test" },
                viewport: { width: 1, height: 1, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1", id: "preview-hash-limit",
                operation: "preview.frame", status: "passed", packageId: pkg.manifest.id,
                inputHashes, createdAt: "2026-08-12T00:00:00.000Z", lane: "browser",
                output: { path: outputPath }, warnings: []
              }
            };
          }
        }
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "preview_strip_failed", message: "Preview strip input hash evidence exceeds the 4128-entry limit." }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
