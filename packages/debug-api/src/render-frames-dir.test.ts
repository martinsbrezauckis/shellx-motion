/**
 * The frames-directory guard on `motion.render.final`.
 *
 * Extracted from index.test.ts rather than appended to it: that file sits on a 24,200-line
 * non-growth cap, and raising legacy caps is not the normal path.
 *
 * What these guard: the Debug API kept its own frames-directory policy,
 * `readdir(path).length === 0`, while the CLI used core's ownership-aware `prepareFramesDir`. Two
 * guards for one job, and the stricter one refused the exact directory state MOTION ITSELF produces
 * when a render dies — so an agent whose render was killed by the RSS ceiling could not retry at the
 * same `framesDir`, which is precisely when it needs to retry with a cheaper package. It also
 * deleted that directory two lines later, so it never protected anything.
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
      await mkdir(framesDir, { recursive: true });
      await writeFile(sentinelPath, "do not delete", "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir,
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
        // The refusal NAMES the offending entry, so a caller can act without listing the directory
        // itself. It previously said only "framesDir must be empty or absent before render", which
        // was also the message a caller got for a directory holding nothing but Motion's own frames.
        expect(result.error.message).toContain("keep.txt");
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

  it("accepts a frames directory holding only frames Motion itself wrote", async () => {
    // The defect this guards: the old guard was an emptiness test, so a
    // render killed by the RSS ceiling left its own frames behind and every retry at the same
    // framesDir was refused — exactly when an agent most needs to retry with a cheaper package.
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-ffmpeg-frames-owned-"));
    const outputPath = join(outDir, "final.mp4");
    const framesDir = join(outDir, "frames");
    try {
      await mkdir(framesDir, { recursive: true });
      // A PNG-signature file named the way Motion names frames: the evidence the guard reads.
      await writeFile(join(framesDir, "000001.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir,
          preset: "mp4-h264"
        },
        {
          tier: "render_motion",
          ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version test", stderr: "" }),
          // Stubbed so the test exercises the GUARD, not a real 120-frame browser render.
          browserFrameRenderer: async (pkg, options) => {
            await mkdir(options.outDir, { recursive: true });
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            await writeFile(framePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
            return {
              ok: true as const,
              output: {
                path: framePath,
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

      // Whatever else the fake runner does, it must NOT be refused for the directory's contents.
      if (!result.ok) {
        expect(result.error.code).not.toBe("invalid_args");
        expect(JSON.stringify(result.error)).not.toContain("did not write");
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
