/**
 * Coverage for render cancellation actually reaching the work.
 *
 * The defect these guard: the abort plumbing was ~90% built and 0% wired. The job governor
 * accepted `request.signal`, aborted queued waiters and relayed to children, and the FFmpeg
 * runner forwarded it to the child process — but no caller in the CLI, the debug API or the SDK
 * ever supplied one, so Ctrl-C killed the CLI and left ffmpeg and Chromium running with no
 * receipt and no record of what happened.
 *
 * These drive the signal directly rather than through a real SIGINT, because a process killed by
 * SIGINT exits 130 whether or not anything handled it — an ambiguity that makes a process-level
 * probe unable to prove the wiring works.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import type { FfmpegCommand, FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { writeTinyNativePackage } from "./main.fixtures-packages";
import { cliDebugReceipt, rgbaPng } from "./main.test-support";
import { SIGINT_EXIT_CODE, withInterruptSignal } from "./interrupt";
import { runCli as runCliRaw, type RunCliOptions } from "./main";

const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("render cancellation", () => {
  it("stops drawing frames once the caller aborts", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cancel-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);
    const controller = new AbortController();
    let framesDrawn = 0;

    // A deliberately slow frame renderer, so the abort lands mid-batch rather than after it.
    const browserFrameRenderer: BrowserFrameRenderer = async (pkg, options) => {
      framesDrawn += 1;
      if (framesDrawn === 1) controller.abort(new Error("Cancelled by test."));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const framePath = options.outputPath ?? join(options.outDir, `frame-${options.atMs}.png`);
      await mkdir(options.outDir, { recursive: true });
      await writeFile(framePath, rgbaPng(2, 1, [[framesDrawn * 30, 10, 20, 255], [5, framesDrawn * 20, 40, 255]]));
      const output = {
        path: framePath,
        sha256: `${String(options.atMs).padStart(4, "0")}${"c".repeat(60)}`.slice(0, 64),
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
        receipt: cliDebugReceipt({
          id: `frame-${options.atMs}`,
          operation: "preview.frame",
          status: "passed",
          packageId: pkg.manifest.id,
          lane: "browser",
          output
        })
      };
    };
    const commands: FfmpegCommand[] = [];
    const ffmpegRunner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli(
      ["render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--frame-lane", "browser", "--out", join(outRoot, "frames")],
      { browserFrameRenderer, ffmpegRunner, signal: controller.signal }
    );

    // The render must not report success for work it did not finish.
    expect(result.ok).toBe(false);
    // And it must stop rather than draw every remaining frame after the abort.
    expect(framesDrawn).toBeLessThan(3);
  });

  it("passes the caller's signal to the governed ffmpeg runner", async () => {
    // The seam that made this defect invisible: createGovernedFfmpegRunner has always accepted a
    // signal, and the CLI simply never gave it one.
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cancel-ffmpeg-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before start."));

    const result = await runCli(
      ["render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--frame-lane", "native", "--out", join(outRoot, "frames")],
      { signal: controller.signal }
    );

    // An already-aborted signal must surface as a failure, never as a completed render.
    expect(result.ok).toBe(false);
  });
});

describe("interrupt scope", () => {
  it("cancels on the first interrupt and exits hard on the second", async () => {
    const exits: number[] = [];
    let observedAborted = false;

    await withInterruptSignal(async ({ signal, interrupted }) => {
      expect(interrupted()).toBe(false);
      process.emit("SIGINT", "SIGINT");
      observedAborted = signal.aborted;
      expect(interrupted()).toBe(true);
      // A user pressing Ctrl-C twice means "stop asking nicely".
      process.emit("SIGINT", "SIGINT");
    }, ((code: number) => { exits.push(code); }) as unknown as (code: number) => never);

    expect(observedAborted).toBe(true);
    expect(exits).toEqual([SIGINT_EXIT_CODE]);
  });

  it("removes its handlers so a repeated caller does not accumulate listeners", async () => {
    const before = process.listenerCount("SIGINT");

    await withInterruptSignal(async () => undefined);
    await withInterruptSignal(async () => undefined);

    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
