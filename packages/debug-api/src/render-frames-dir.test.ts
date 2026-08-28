/**
 * The frames-directory guard on `motion.render.final`.
 *
 * Extracted from index.test.ts rather than appended to it: that file sits on a 24,200-line
 * non-growth cap, and raising legacy caps is not the normal path.
 *
 * What these guard: a caller-supplied non-empty frames directory is unowned input. Filenames and
 * PNG signatures are not proof that Motion created its contents, so the Debug API must preserve
 * every existing entry and refuse before browser frame rendering. A caller can explicitly choose a
 * new or empty directory instead; this wire surface deliberately has no destructive force option.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("motion.render.final frames directory", () => {
  it("refuses FFmpeg renders with non-empty frame directories", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-ffmpeg-frames-non-empty-"));
    const outputPath = join(outDir, "final.mp4");
    const framesDir = join(outDir, "frames");
    const sentinelPath = join(framesDir, "keep.txt");
    try {
      await mkdir(framesDir, { recursive: true, mode: 0o700 });
      await writeFile(sentinelPath, "do not delete", "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir,
          keepFrames: true,
          preset: "mp4-h264"
        },
        {
          tier: "render_motion",
          ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version test", stderr: "" })
        }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_args");
        expect(result.error.message).toContain("(1 existing entry)");
        // The refusal communicates the safe next action without disclosing caller-owned names.
        expect(result.error.message).not.toContain("keep.txt");
        expect(result.error.message).toContain("Nothing was written or deleted");
        // This surface has no --force, so the suggestion must not name one.
        expect(result.error.message).not.toContain("--force");
        expect(result.error.suggestedAction).toContain("no force argument");
      }
      expect(await readFile(sentinelPath, "utf8")).toBe("do not delete");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses and preserves PNG-shaped caller content instead of treating it as Motion-owned", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-ffmpeg-frames-owned-"));
    const outputPath = join(outDir, "final.mp4");
    const framesDir = join(outDir, "frames");
    const framePath = join(framesDir, "000001.png");
    const frameBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let browserCalls = 0;
    try {
      await mkdir(framesDir, { recursive: true });
      await writeFile(framePath, frameBytes);

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir,
          keepFrames: true,
          preset: "mp4-h264"
        },
        {
          tier: "render_motion",
          ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version test", stderr: "" }),
          browserFrameRenderer: async (pkg, options) => {
            browserCalls += 1;
            await mkdir(options.outDir, { recursive: true });
            const renderedFramePath = options.outputPath ?? join(options.outDir, "frame.png");
            await writeFile(renderedFramePath, frameBytes);
            return {
              ok: true as const,
              output: {
                path: renderedFramePath,
                sha256: "a".repeat(64),
                format: "png" as const,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }
              },
              receipt: { schema: "shellx-motion/browser-frame-receipt@1" }
            } as never;
          }
        }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      expect(browserCalls).toBe(0);
      expect(await readFile(framePath)).toEqual(frameBytes);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
