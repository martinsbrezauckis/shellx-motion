import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeRgbaPng,
  LocalMotionJobError,
  LocalMotionJobGovernor,
  streamingFrameTimestampMs,
  type LocalMotionJobContext,
  type LocalMotionJobPolicy
} from "@shellx-motion/core";
import { buildEncodeImageSequenceCommand } from "./index.js";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import { renderSegmentedFinal } from "./segmented-final-internal/segmented-final-adapter.js";
import { acquireSegmentedFinalLock, deriveSegmentedFinalPaths } from "./segmented-final-internal/segmented-final-adapter-store.js";
import { image2PipeCommandFromImageSequence, runStreamingFfmpegFinal } from "./streaming-foundation.js";
import {
  startStreamingFfmpegProcess,
  type StreamingFfmpegProcess,
  type StreamingFfmpegProcessFactory
} from "./streaming-process.js";

const roots: string[] = [];
const SHA = "a".repeat(64);
const WIDTH = 4;
const HEIGHT = 2;
const FPS = 2;
const DURATION_MS = 1_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("internal segmented final adapter", () => {
  it("atomically reserves only the deterministic sibling lock and never breaks an existing reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-segmented-lock-"));
    roots.push(root);
    const paths = deriveSegmentedFinalPaths(join(root, "out.mp4"), join(root, "package"));
    const release = await acquireSegmentedFinalLock(paths);
    await expect(acquireSegmentedFinalLock(paths)).rejects.toMatchObject({ code: "segment_store_busy" });
    await release();
    const reacquired = await acquireSegmentedFinalLock(paths);
    await reacquired();
  });

  it("proves real FFV1 checkpoints and decoded parity with ordinary image2pipe delivery", async () => {
    for (const preset of ["mp4-h264", "webm-vp9-alpha"] as const) {
      const root = await fixture(preset);
      const outputPath = join(root, preset === "mp4-h264" ? "segmented.mp4" : "segmented.webm");
      const ordinaryPath = join(root, preset === "mp4-h264" ? "ordinary.mp4" : "ordinary.webm");
      const packageRoot = join(root, "package");
      const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
      const observedSegments: number[] = [];
      let admissions = 0;
      const segmented = await renderSegmentedFinal({
        package: { rootPath: packageRoot, id: "segmented-proof", manifestSha256: SHA },
        timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
        frameLane: "native",
        producer: { frameLane: "native" },
        plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
        outputPath,
        store: { intent: "create" },
        preset,
        inputRoots: [root],
        outputRoots: [root],
        forceSoftwareEncode: true,
        verifyDeliveredColor: false,
        quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
        createRangeProducer: producerFactory(frameBuffers(preset)),
        processFactory: async (processInput) => {
          if (processInput.command.args.includes("concat")) {
            for (const name of await readdir(paths.segmentsDirectory)) {
              if (name.endsWith(".mkv")) observedSegments.push((await stat(join(paths.segmentsDirectory, name))).size);
            }
          }
          return await startStreamingFfmpegProcess(processInput);
        },
        governor: singleGovernor(() => { admissions += 1; }, root),
        scratchRoot: root
      });

      if (!segmented.ok) throw segmented.error;
      expect(segmented).toMatchObject({ ok: true, transport: {
        delivery: "resumable-ffv1-segments",
        resume: { verifiedPrefixSegments: 0, newlyCompletedSegments: 2 },
        retention: { verifiedSegments: "cleaned", cleanup: "complete", removedSegmentCount: 2 }
      } });
      expect(admissions).toBe(1);
      expect(observedSegments).toHaveLength(2);
      expect(observedSegments.every((size) => size > 0)).toBe(true);
      await expect(readdir(paths.storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).some((name) => name.endsWith(".png"))).toBe(false);

      const ordinary = await runStreamingFfmpegFinal({
        frameCount: 2,
        durationMs: DURATION_MS,
        fps: FPS,
        width: WIDTH,
        height: HEIGHT,
        quality: { minDurationMs: 0 },
        attempts: [{
          source: "software",
          command: image2PipeCommandFromImageSequence(buildEncodeImageSequenceCommand({
            framesDir: root,
            fps: FPS,
            durationMs: DURATION_MS,
            outputPath: ordinaryPath,
            preset,
            inputRoots: [root],
            outputRoots: [root]
          }))
        }],
        produce: async (sink) => {
          for (const [index, png] of frameBuffers(preset).entries()) {
            await sink.write({ index, atMs: streamingFrameTimestampMs(index, FPS, DURATION_MS), png });
          }
        },
        scratchRoot: root
      });
      expect(ordinary).toMatchObject({ ok: true });
      const segmentedPixels = await decodeRgba(outputPath);
      const ordinaryPixels = await decodeRgba(ordinaryPath);
      expect(segmentedPixels).toHaveLength(2 * WIDTH * HEIGHT * 4);
      expect(ordinaryPixels).toHaveLength(2 * WIDTH * HEIGHT * 4);
      expect(segmentedPixels).toEqual(ordinaryPixels);
    }
  }, 60_000);

  it("resumes an exact verified prefix without replaying its producer ranges", async () => {
    const root = await fixture("resume");
    const outputPath = join(root, "resumed.mp4");
    const packageRoot = join(root, "package");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    const initialRanges: number[] = [];
    const initial = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-resume", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "create" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: producerFactory(frameBuffers("mp4-h264"), {
        rangeStarts: initialRanges,
        failAtStartFrame: 1
      }),
      governor: singleGovernor(() => {}, root),
      scratchRoot: root
    });

    expect(initial).toMatchObject({ ok: false, error: { code: "segment_producer_failed", evidence: { phase: "spool" } } });
    expect(initialRanges).toEqual([0, 1]);
    expect((await stat(join(paths.segmentsDirectory, "segment-000001.mkv"))).size).toBeGreaterThan(0);
    await expect(stat(join(paths.segmentsDirectory, ".segment-000002.mkv.partial"))).rejects.toMatchObject({ code: "ENOENT" });

    const resumedRanges: number[] = [];
    const resumed = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-resume", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "resume" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: producerFactory(frameBuffers("mp4-h264"), { rangeStarts: resumedRanges }),
      governor: singleGovernor(() => {}, root),
      scratchRoot: root
    });

    if (!resumed.ok) throw resumed.error;
    expect(resumedRanges).toEqual([1]);
    expect(resumed.transport).toMatchObject({
      resume: { verifiedPrefixSegments: 1, newlyCompletedSegments: 1 },
      producerWarnings: { coverage: "complete" },
      retention: {
        verifiedSegments: "cleaned",
        cleanup: "complete",
        removedSegmentCount: 2,
        missingSegmentCount: 0,
        retainedSegmentCount: 0
      }
    });
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
    await expect(readdir(paths.storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("revalidates the retained private store topology immediately before an FFmpeg process starts", async () => {
    const root = await fixture("topology-race");
    const outputPath = join(root, "topology-race.mp4");
    const packageRoot = join(root, "package");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    let rawProcessCalls = 0;
    const result = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-topology-race", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "create" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: ({ range }) => {
        const normal = producerFactory(frameBuffers("mp4-h264"))({ range });
        return {
          produce: async (...args: Parameters<typeof normal.produce>) => {
            rawProcessCalls = 0;
            const moved = `${paths.storeRoot}.moved`;
            await rename(paths.storeRoot, moved);
            await mkdir(paths.storeRoot, { mode: 0o700 });
            await normal.produce(...args);
          }
        };
      },
      processFactory: async (processInput) => {
        rawProcessCalls += 1;
        return await startStreamingFfmpegProcess(processInput);
      },
      governor: singleGovernor(() => {}, root),
      scratchRoot: root
    });

    expect(result).toMatchObject({ ok: false, error: { evidence: { phase: "spool" } } });
    expect(rawProcessCalls).toBe(0);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a staging substitution after FFprobe and preserves the verified checkpoint for resume", async () => {
    const root = await fixture("staging-substitution");
    const outputPath = join(root, "staging-substitution.mp4");
    const packageRoot = join(root, "package");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    let substituted = false;
    const result = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-staging-substitution", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "create" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: producerFactory(frameBuffers("mp4-h264")),
      processFactory: async (processInput) => {
        const process = await startStreamingFfmpegProcess(processInput);
        if (!processInput.command.args.includes(paths.stagingPath) || !processInput.command.args.includes("-show_streams")) return process;
        return {
          ...process,
          end: async () => {
            const result = await process.end();
            if (!substituted) {
              substituted = true;
              await writeFile(paths.stagingPath, "substituted after final FFprobe", "utf8");
            }
            return result;
          }
        };
      },
      governor: singleGovernor(() => {}, root),
      scratchRoot: root
    });

    expect(substituted).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: "segmented_final_publish_failed", evidence: { phase: "publish" } } });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(paths.segmentsDirectory)).sort()).toEqual([
      "segment-000001.mkv",
      "segment-000002.mkv",
      "segments.ffconcat"
    ]);

    const resumedRanges: number[] = [];
    const resumed = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-staging-substitution", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "resume" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: producerFactory(frameBuffers("mp4-h264"), { rangeStarts: resumedRanges }),
      governor: singleGovernor(() => {}, root),
      scratchRoot: root
    });

    if (!resumed.ok) throw resumed.error;
    expect(resumedRanges).toEqual([]);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  }, 60_000);

  it("retains verified segments but removes only owned staging after final encoder failure", async () => {
    const root = await fixture("concat-failure");
    const outputPath = join(root, "failed.mp4");
    const packageRoot = join(root, "package");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    const result = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-concat-failure", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "create" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: producerFactory(frameBuffers("mp4-h264")),
      processFactory: failingConcatFactory(),
      governor: singleGovernor(() => {}, root),
      scratchRoot: root
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "segment_concat_failed",
        evidence: {
          phase: "concat",
          partialOutput: { status: "unverified", sha256: expect.any(String) },
          publication: "not_published",
          resources: { state: "passed" },
          transport: {
            delivery: "resumable-ffv1-segments",
            segments: [{ index: 0 }, { index: 1 }],
            resume: { verifiedPrefixSegments: 0, newlyCompletedSegments: 2 },
            concat: { state: "created", sha256: expect.any(String) },
            attempts: [{ source: "software", outcome: "failed", failure: { code: "encoder_failed" } }],
            retention: {
              verifiedPrefixSegments: 0,
              verifiedSegments: "preserved",
              stagingCleanup: "removed"
            },
            publication: "not_published"
          }
        }
      }
    });
    if (result.ok) throw new Error("Expected controlled concat failure.");
    expect(JSON.stringify(result.error.evidence)).not.toContain(root);
    expect((await readdir(paths.segmentsDirectory)).sort()).toEqual([
      "segment-000001.mkv",
      "segment-000002.mkv",
      "segments.ffconcat"
    ]);
    await expect(stat(paths.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("returns the caller cancellation code only after cleaning the current checkpoint with governor evidence", async () => {
    const root = await fixture("cancellation");
    const outputPath = join(root, "cancelled.mp4");
    const packageRoot = join(root, "package");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    const controller = new AbortController();
    const renderedRanges: number[] = [];
    const result = await renderSegmentedFinal({
      package: { rootPath: packageRoot, id: "segmented-cancellation", manifestSha256: SHA },
      timeline: { motionSha256: SHA, frameCount: 2, durationMs: DURATION_MS, fps: FPS, width: WIDTH, height: HEIGHT },
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
      outputPath,
      store: { intent: "create" },
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      verifyDeliveredColor: false,
      quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      createRangeProducer: producerFactory(frameBuffers("mp4-h264"), {
        rangeStarts: renderedRanges,
        cancelAtStartFrame: 1,
        controller
      }),
      signal: controller.signal,
      governor: governedGovernor(),
      scratchRoot: root
    });

    expect(renderedRanges).toEqual([0, 1]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "job_cancelled",
        evidence: {
          phase: "cancelled",
          spool: {
            phase: "cancelled",
            verifiedPrefixSegments: 1,
            retention: { verifiedPrefixPreserved: true },
            cleanup: { attempted: true },
            resourceCode: "job_cancelled"
          },
          resources: { state: "cancelled" }
        }
      }
    });
    if (result.ok) throw new Error("Expected caller cancellation.");
    expect(result.error.primaryCause).toBeInstanceOf(LocalMotionJobError);
    expect((result.error.primaryCause as LocalMotionJobError).code).toBe("job_cancelled");
    expect(result.error.evidence.spool?.cleanup.outcome).not.toBe("retained");
    await expect(stat(join(paths.segmentsDirectory, ".segment-000002.mkv.partial"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.segmentsDirectory, "segment-000001.mkv"))).resolves.toBeDefined();
  }, 60_000);
});

async function fixture(preset: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-segmented-final-${preset}-`));
  roots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "manifest.json"), "{\"id\":\"segmented-proof\"}\n");
  await writeFile(join(packageRoot, "motion.json"), "{\"fps\":2}\n");
  return root;
}

function frameBuffers(preset: "mp4-h264" | "webm-vp9-alpha"): Buffer[] {
  return [0, 1].map((index) => {
    const alpha = preset === "webm-vp9-alpha" ? (index === 0 ? 80 : 210) : 255;
    const rgba = Buffer.from(Array.from({ length: WIDTH * HEIGHT }, (_, pixel) => [
      20 + (index * 80) + (pixel * 3),
      40 + (pixel * 9),
      220 - (index * 60) - (pixel * 4),
      alpha
    ]).flat());
    return encodeRgbaPng(WIDTH, HEIGHT, rgba);
  });
}

function producerFactory(
  frames: Buffer[],
  options: {
    rangeStarts?: number[];
    failAtStartFrame?: number;
    cancelAtStartFrame?: number;
    controller?: AbortController;
  } = {}
) {
  return ({ range }: { range: { startFrameIndex: number; endFrameIndexExclusive: number } }) => ({
    evidence: { schema: "shellx-motion/segment-range-producer@1" as const, frameLane: "native" as const, warningUnion: [], warningsOmitted: 0 },
    produce: async (
      sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> },
      job: { signal: AbortSignal }
    ) => {
      options.rangeStarts?.push(range.startFrameIndex);
      if (range.startFrameIndex === options.failAtStartFrame) {
        throw new Error("Controlled producer interruption after a verified prefix.");
      }
      if (range.startFrameIndex === options.cancelAtStartFrame) {
        options.controller?.abort();
        throw job.signal.reason;
      }
      for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
        await sink.write({ index, atMs: streamingFrameTimestampMs(index, FPS, DURATION_MS), png: frames[index]! });
      }
    }
  });
}

function failingConcatFactory(): StreamingFfmpegProcessFactory {
  return async (input) => {
    if (!input.command.args.includes("concat")) return await startStreamingFfmpegProcess(input);
    const outputPath = input.command.args.at(-1)!;
    await writeFile(outputPath, "controlled unverified final staging bytes");
    const result = { exitCode: 47, stdout: "", stderr: "controlled final encoder failure" };
    return failedProcess(result);
  };
}

function failedProcess(result: { exitCode: number; stdout: string; stderr: string }): StreamingFfmpegProcess {
  return {
    closed: Promise.resolve(result),
    write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 1 }),
    end: async () => result,
    abort: async () => result
  };
}

function singleGovernor(onRun: () => void, scratchRoot: string): LocalMotionJobGovernor {
  return {
    policy: { maxProcessTreeRssBytes: 1_000_000_000 },
    run: async (_request: unknown, operation: (job: LocalMotionJobContext) => Promise<unknown>) => {
      onRun();
      const job: LocalMotionJobContext = {
        jobId: "segmented-final-test",
        scratchRoot,
        signal: new AbortController().signal,
        watchProcess() {},
        reportProcessContainment() {},
        reportSandbox() {}
      };
      return { value: await operation(job), evidence: { state: "passed" } };
    }
  } as unknown as LocalMotionJobGovernor;
}

function governedGovernor(): LocalMotionJobGovernor {
  const policy: LocalMotionJobPolicy = {
    maxConcurrentJobs: 1,
    maxQueueDepth: 1,
    maxQueueWaitMs: 1_000,
    maxWallClockMs: 5_000,
    minFreeScratchBytes: 0,
    scratchReservationBytes: 0,
    maxProcessTreeRssBytes: 1_000_000_000,
    rssPollIntervalMs: 1_000
  };
  return new LocalMotionJobGovernor(policy, {
    leases: null,
    prepareScratchRoot: async (path) => {
      await mkdir(path, { recursive: true });
      return path;
    },
    freeScratchBytes: async () => 1_000_000_000
  });
}

async function decodeRgba(path: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks));
      else reject(new Error(`FFmpeg decode failed with ${code}: ${stderr}`));
    });
  });
}
