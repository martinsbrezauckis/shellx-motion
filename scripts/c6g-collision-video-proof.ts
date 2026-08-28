/** Native C6G-D video qualification; proof-only, never a public final-render surface. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  canonicalJson,
  canonicalJsonSha256,
  comparePngFiles,
  inspectPngFile,
  type LocalMotionJobEvidence,
  type OperationReceipt,
  type PngVisualDiffResult,
} from "../packages/core/src/index";
import { createGpuCollisionShowcasePreviewSession } from "../packages/renderer-browser/src/unadopted/gpu-collision-showcase-preview-session";
import { runStreamingFinalEncodePolicy } from "../packages/renderer-ffmpeg/src/streaming-final-encode-policy";
import {
  startStreamingFfmpegProcess,
  type StreamingFfmpegProcessFactory,
} from "../packages/renderer-ffmpeg/src/streaming-process";
import type { FfmpegCommand } from "../packages/renderer-ffmpeg/src/index";
import type { CollisionCheckpointProofCase } from "./c6g-collision-checkpoint-proof-contract";
import {
  C6G_COLLISION_VIDEO_CHECKPOINTS,
  C6G_COLLISION_ACCEPTED_ADAPTER_FINGERPRINT,
  C6G_COLLISION_ACCEPTED_SEQUENCES,
  C6G_COLLISION_VIDEO_DURATION_MS,
  C6G_COLLISION_VIDEO_FPS,
  C6G_COLLISION_VIDEO_FRAME_COUNT,
  C6G_COLLISION_VIDEO_MIN_UNIQUE_FRAMES,
  C6G_COLLISION_VIDEO_PRESET,
  C6G_COLLISION_VIDEO_REVIEW_FRAMES,
  C6G_COLLISION_VIDEO_STREAMING_MIN_UNIQUE_FRAMES,
  assertCollisionVideoCommand,
  buildCollisionVideoProofCases,
  collisionVideoCommandIdentity,
  collisionVideoFrameAtMs,
  collisionVideoFrameAtUs,
  parseCollisionVideoProofArguments,
  planCollisionVideoCommand,
} from "./c6g-collision-video-proof-contract";

const PROOF_SCHEMA = "shellx-motion/c6g-collision-video-proof@2" as const;
const scriptPath = fileURLToPath(import.meta.url), repoRoot = resolve(dirname(scriptPath), "..");
const runFile = promisify(execFile), HASH = /^[a-f0-9]{64}$/;
const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i;
const operationTimeoutMs = 45_000, toolTimeoutMs = 120_000;
const minDecodedSsim = 0.94, minDecodedPsnrDb = 30;
type Json = Record<string, unknown>;

interface SourceFrame {
  frameIndex: number;
  atUs: number;
  encoderAtMs: number;
  path: string;
  pngSha256: string;
  stateSha256: string;
  phase: string;
  bakeFrameBeforeIndex: number;
  bakeFrameAfterIndex: number;
}

interface RenderedSourceStory {
  adapter: Json;
  frames: SourceFrame[];
  cleanup: Json;
  evidence: Json;
}

interface TrackedProcessFactory {
  factory: StreamingFfmpegProcessFactory;
  pids: number[];
}

export async function runCollisionVideoProof(args: string[]): Promise<void> {
  let outputRoot: string | undefined, ownsOutputRoot = false;
  try {
    const parsed = parseCollisionVideoProofArguments(args);
    outputRoot = parsed.outputRoot;
    const source = await sourceEvidence(parsed.expectedCommit);
    await createFreshPrivateRoot(outputRoot); ownsOutputRoot = true;
    const roots = await prepareRoots(outputRoot);
    const tools = { ffmpeg: await executableEvidence("ffmpeg"), ffprobe: await executableEvidence("ffprobe") };
    const stories: Json[] = [];
    let adapter: Json | undefined, cancellationFrames: SourceFrame[] | undefined;
    for (const proofCase of buildCollisionVideoProofCases()) {
      const rendered = await renderSourceStory(proofCase, roots.source, outputRoot, adapter);
      adapter ??= rendered.adapter;
      assert.deepEqual(rendered.adapter, adapter, "C6G video stories must use one exact hardware adapter identity.");
      const encoded = await encodeStory(proofCase.slug, rendered.frames, roots, outputRoot);
      const decoded = await decodeAndCompare(proofCase.slug, rendered.frames, encoded.outputPath, roots, outputRoot, tools);
      stories.push({ slug: proofCase.slug, source: rendered.evidence, encode: encoded.evidence, decoded });
      if (proofCase.slug === "bingo") cancellationFrames = rendered.frames;
    }
    assert(adapter && cancellationFrames, "C6G video proof omitted adapter or cancellation source evidence.");
    const cancellation = await proveCancellation(cancellationFrames, roots, outputRoot);
    const payload = {
      schema: PROOF_SCHEMA,
      status: "passed" as const,
      source,
      runtime: { node: process.version, platform: process.platform, arch: process.arch, operationTimeoutMs, toolTimeoutMs, adapter, tools },
      timing: {
        authorTimelineDurationMs: 5_000,
        presentationDurationMs: C6G_COLLISION_VIDEO_DURATION_MS,
        fps: C6G_COLLISION_VIDEO_FPS,
        frameCount: C6G_COLLISION_VIDEO_FRAME_COUNT,
        terminalAuthorSampleAtMs: 5_000,
        terminalSampleDisplay: "one-frame-hold",
      },
      stories,
      cancellation,
      evidence: {
        storyCount: 2,
        sourcePreviewFrames: 302,
        encodedFrames: 302,
        decodedFrames: 302,
        productionPolicy: "package-private-streaming-final-encode-policy",
        productionTransport: "png-image2pipe",
        productionPreset: C6G_COLLISION_VIDEO_PRESET,
        exactSoftwareEncoder: "libx264",
        terminalCleanupComplete: true,
        cancellationProved: true,
        publicFinalLaneWidened: false,
        artifactStatus: "private-test-artifact-only",
      },
      paths: { root: outputRoot, videos: relative(outputRoot, roots.videos), review: relative(outputRoot, roots.review) },
    };
    const proof = Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
    const proofPath = join(outputRoot, "collision-video-proof.json");
    await writeCanonicalExclusive(proofPath, proof);
    process.stdout.write(`${JSON.stringify({ ok: true, proofPath, fingerprint: proof.fingerprint, videos: stories.map((story) => mustObject(story.encode, "encode evidence").outputPath) }, null, 2)}\n`);
  } catch (error) {
    if (ownsOutputRoot && outputRoot) await writeCanonicalExclusive(join(outputRoot, "collision-video-proof.failed.json"), { schema: PROOF_SCHEMA, status: "failed", error: safeError(error) }).catch(() => undefined);
    process.stderr.write(`${JSON.stringify({ ok: false, outputRoot: outputRoot ?? null, error: safeError(error) }, null, 2)}\n`);
    throw error;
  }
}

async function prepareRoots(outputRoot: string) {
  const roots = {
    source: join(outputRoot, "source-frames"), videos: join(outputRoot, "videos"), decoded: join(outputRoot, "decoded-frames"),
    review: join(outputRoot, "review"), jobs: join(outputRoot, "jobs"), cancellation: join(outputRoot, "cancellation"),
  };
  await Promise.all(Object.values(roots).map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })));
  return roots;
}

async function renderSourceStory(proofCase: CollisionCheckpointProofCase, sourceRoot: string, outputRoot: string, expectedAdapter?: Json): Promise<RenderedSourceStory> {
  assert(C6G_COLLISION_ACCEPTED_SEQUENCES, "C6G-E video proof is blocked until native retained-preview sequence hashes are reviewed and pinned.");
  const storyRoot = join(sourceRoot, proofCase.slug); await mkdir(storyRoot, { mode: 0o700 });
  const session = createGpuCollisionShowcasePreviewSession(proofCase.plan.recipe, { packageRoot: repoRoot });
  assert.equal(session.identity.frameCount, C6G_COLLISION_VIDEO_FRAME_COUNT);
  assert.equal(session.identity.planFingerprint, proofCase.plan.fingerprint);
  assert.equal(session.identity.loweringFingerprint, proofCase.lowering.fingerprint);
  assert.equal(session.identity.motionSha256, proofCase.lowering.motionSha256);
  assert.equal(session.identity.strictPreviewStaticFingerprint, proofCase.lowering.strictPreviewStaticFingerprint);
  const frames: SourceFrame[] = [], pngHashes: string[] = [], framePlanHashes: string[] = [];
  const frameResources: LocalMotionJobEvidence[] = [];
  let adapter: Json | undefined, cleanup: Json | undefined;
  try {
    for (let frameIndex = 0; frameIndex < C6G_COLLISION_VIDEO_FRAME_COUNT; frameIndex += 1) {
      const outputPath = join(storyRoot, `frame-${String(frameIndex).padStart(3, "0")}.png`);
      assert.equal(await exists(outputPath), false, `C6G source frame already exists: ${outputPath}`);
      const result = await session.renderNext({ outDir: storyRoot, outputPath, timeoutMs: operationTimeoutMs, callerId: "c6g-collision-video-proof" });
      assert(result.ok, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
      if (!result.ok) throw new Error("Unreachable C6G retained preview failure.");
      assert.equal(result.schedule.frameIndex, frameIndex); assert.equal(result.schedule.atUs, collisionVideoFrameAtUs(frameIndex));
      assert(HASH.test(result.schedule.stateSha256));
      assert.equal(result.schedule.final, frameIndex === C6G_COLLISION_VIDEO_FRAME_COUNT - 1);
      assert.equal(result.frame.width, 1_280); assert.equal(result.frame.height, 720); assert.equal(result.frame.atMs, result.schedule.atUs / 1_000);
      assert.equal(result.frame.resources.state, "passed"); frameResources.push(result.frame.resources);
      assert.equal(result.frame.gpu.backend, "webgpu-browser"); assert.equal(result.frame.gpu.adapterFingerprint, C6G_COLLISION_ACCEPTED_ADAPTER_FINGERPRINT);
      assert(!SOFTWARE_ADAPTER.test(JSON.stringify(result.frame.gpu.adapter)), "Software GPU adapter evidence is refused.");
      const currentAdapter = result.frame.gpu as unknown as Json; adapter ??= currentAdapter; assert.deepEqual(currentAdapter, adapter); if (expectedAdapter) assert.deepEqual(currentAdapter, expectedAdapter);
      const quality = await inspectPngFile(outputPath); assert(quality.ok, quality.ok ? undefined : quality.message); if (!quality.ok) throw new Error("Unreachable invalid C6G source PNG.");
      assert.equal(quality.blank, false); assert.equal(quality.opaqueRatio, 1, "C6G MP4 proof requires an already-composited opaque source frame.");
      assert.equal(quality.sha256, result.frame.sha256); assert.equal(await sha256File(outputPath), result.frame.sha256);
      const framePlanSha256 = receiptHash(result.receipt, "gpu-scene3d-animation-frame-plan");
      pngHashes.push(quality.sha256); framePlanHashes.push(framePlanSha256);
      frames.push({
        frameIndex, atUs: result.schedule.atUs, encoderAtMs: collisionVideoFrameAtMs(frameIndex), path: outputPath,
        pngSha256: quality.sha256, stateSha256: result.schedule.stateSha256, phase: result.schedule.phase,
        bakeFrameBeforeIndex: result.schedule.bakeFrameBeforeIndex, bakeFrameAfterIndex: result.schedule.bakeFrameAfterIndex,
      });
      if (result.schedule.cleanup) cleanup = result.schedule.cleanup as unknown as Json;
    }
  } finally {
    cleanup ??= await session.close() as unknown as Json;
  }
  assert(adapter && cleanup, `${proofCase.slug} source schedule omitted adapter or cleanup evidence.`);
  assert.deepEqual(cleanup, await session.close(), `${proofCase.slug} retained source cleanup is not idempotent.`);
  assert.equal(cleanup.scheduleComplete, true); assert.equal(cleanup.completedFrames, C6G_COLLISION_VIDEO_FRAME_COUNT);
  assert.deepEqual(mustObject(cleanup.gpu, "C6G source cleanup").scene3dAnimation, { staticWrapperCompilations: 1, framePlanCompilations: C6G_COLLISION_VIDEO_FRAME_COUNT });
  assert.equal(new Set(framePlanHashes).size, C6G_COLLISION_VIDEO_FRAME_COUNT);
  assert(new Set(pngHashes).size >= C6G_COLLISION_VIDEO_MIN_UNIQUE_FRAMES, `${proofCase.slug} source schedule has insufficient visual variation.`);
  assert.equal(canonicalJsonSha256(pngHashes), C6G_COLLISION_ACCEPTED_SEQUENCES[proofCase.slug].png, `${proofCase.slug} source pixels differ from the accepted C6G-E sequence.`);
  assert.equal(canonicalJsonSha256(framePlanHashes), C6G_COLLISION_ACCEPTED_SEQUENCES[proofCase.slug].framePlan, `${proofCase.slug} frame plans differ from the accepted C6G-E sequence.`);
  return { adapter, frames, cleanup, evidence: {
    identity: session.identity,
    frameCount: frames.length,
    frameTimes: frames.map((frame) => ({ frameIndex: frame.frameIndex, atUs: frame.atUs, encoderAtMs: frame.encoderAtMs, phase: frame.phase, stateSha256: frame.stateSha256 })),
    pngSequenceSha256: canonicalJsonSha256(pngHashes), framePlanSequenceSha256: canonicalJsonSha256(framePlanHashes), uniquePngHashes: new Set(pngHashes).size,
    alpha: { source: "straight-rgba-png", compositedOpaqueBeforeEncode: true },
    resources: summarizeFrameResources(frameResources), cleanup,
    framePaths: frames.map((frame) => relative(outputRoot, frame.path)),
  } };
}

async function encodeStory(slug: "bingo" | "wrecking", frames: SourceFrame[], roots: Awaited<ReturnType<typeof prepareRoots>>, outputRoot: string) {
  const outputPath = join(roots.videos, `${slug}.mp4`); assert.equal(await exists(outputPath), false);
  const planned = planCollisionVideoCommand(outputPath), processes = trackedProductionProcessFactory();
  const result = await runStreamingFinalEncodePolicy({
    fps: C6G_COLLISION_VIDEO_FPS, width: 1_280, height: 720, durationMs: C6G_COLLISION_VIDEO_DURATION_MS,
    outputPath, outputRoots: [roots.videos], preset: C6G_COLLISION_VIDEO_PRESET, forceSoftwareEncode: true, verifyDeliveredColor: true,
    quality: { minDurationMs: 5_000, minUniqueFrameHashes: C6G_COLLISION_VIDEO_STREAMING_MIN_UNIQUE_FRAMES },
    scratchRoot: join(roots.jobs, `encode-${slug}`), operation: "c6g.collision-video.encode", callerId: "c6g-collision-video-proof", jobId: `c6g-video:${slug}`,
    processFactory: processes.factory,
    produce: async (sink, context) => {
      for (const frame of frames) {
        if (context.signal.aborted) throw context.signal.reason;
        assert.equal(frame.encoderAtMs, collisionVideoFrameAtMs(frame.frameIndex));
        await sink.write({ index: frame.frameIndex, atMs: frame.encoderAtMs, png: await readFile(frame.path) });
      }
    },
  });
  assert(result.ok, result.ok ? undefined : `${result.error.code}: ${result.error.message}`); if (!result.ok) throw new Error("Unreachable C6G video encode failure.");
  assert.deepEqual(result.command, planned, "C6G proof execution command differs from the retained production command plan.");
  assertCollisionVideoCommand(result.command, outputPath);
  assert.deepEqual(result.handoff.attempts, [{ source: "software", encoder: "libx264", outcome: "succeeded" }]);
  assert.equal(result.handoff.quality.frameCount, C6G_COLLISION_VIDEO_FRAME_COUNT); assert.equal(result.handoff.quality.blankFrames, 0);
  assert(result.handoff.quality.uniqueFrameHashes >= C6G_COLLISION_VIDEO_STREAMING_MIN_UNIQUE_FRAMES);
  assert.equal(result.handoff.resources.state, "passed"); assert.equal(result.handoff.resources.watchedProcessCount, 1);
  assert.equal(result.handoff.encoderHandoffSourceFramesRetained, 0); assert.equal(result.handoff.backpressure.writes, C6G_COLLISION_VIDEO_FRAME_COUNT);
  const terminalPids = await terminalProcessEvidence(processes.pids); assert.equal(terminalPids.allTerminal, true);
  const facts = await stat(outputPath); assert(facts.isFile() && facts.size > 0);
  assert.equal(await sha256File(outputPath), result.receiptEvidence.output.sha256);
  return { outputPath, evidence: {
    outputPath: relative(outputRoot, outputPath), sha256: result.receiptEvidence.output.sha256, bytes: facts.size,
    commandIdentity: collisionVideoCommandIdentity(result.command, outputPath), command: normalizedCommand(result.command, outputPath),
    productionArgsBound: true, plannedAttempts: result.plannedAttempts.map((attempt) => ({ ...attempt, command: normalizedCommand(attempt.command, outputPath) })),
    handoff: result.handoff, receiptEvidence: relativeReceiptEvidence(result.receiptEvidence, outputRoot), encoderProcesses: terminalPids,
  } };
}

async function decodeAndCompare(slug: "bingo" | "wrecking", frames: SourceFrame[], videoPath: string, roots: Awaited<ReturnType<typeof prepareRoots>>, outputRoot: string, tools: { ffmpeg: Json; ffprobe: Json }): Promise<Json> {
  const probe = await probeVideo(videoPath, String(tools.ffprobe.path));
  const decodedRoot = join(roots.decoded, slug); await mkdir(decodedRoot, { mode: 0o700 });
  const decodedPattern = join(decodedRoot, "frame-%03d.png");
  await runTool(String(tools.ffmpeg.path), ["-v", "error", "-i", videoPath, "-map", "0:v:0", "-fps_mode", "passthrough", "-start_number", "0", decodedPattern]);
  const decodedPaths = (await readdir(decodedRoot)).filter((name) => /^frame-\d{3}\.png$/.test(name)).sort().map((name) => join(decodedRoot, name));
  assert.equal(decodedPaths.length, C6G_COLLISION_VIDEO_FRAME_COUNT, `${slug} decoded frame count mismatch.`);
  const comparisons: Json[] = [], decodedHashes: string[] = [];
  let minSsim = 1, totalSsim = 0, minPsnr = Number.POSITIVE_INFINITY, totalPsnr = 0;
  for (const [index, decodedPath] of decodedPaths.entries()) {
    const comparison = await comparePngFiles(decodedPath, frames[index]!.path, { compareAlpha: false });
    assert(comparison.ok, comparison.ok ? undefined : comparison.message); if (!comparison.ok) throw new Error("Unreachable invalid decoded comparison.");
    const psnr = comparison.psnrDb ?? 99;
    minSsim = Math.min(minSsim, comparison.ssim); totalSsim += comparison.ssim; minPsnr = Math.min(minPsnr, psnr); totalPsnr += psnr;
    const quality = await inspectPngFile(decodedPath); assert(quality.ok, quality.ok ? undefined : quality.message); if (!quality.ok) throw new Error("Unreachable invalid decoded PNG.");
    assert.equal(quality.blank, false); assert.equal(quality.opaqueRatio, 1);
    decodedHashes.push(quality.sha256);
    comparisons.push(comparisonProjection(frames[index]!, comparison, quality.sha256, relative(outputRoot, decodedPath)));
  }
  assert(minSsim >= minDecodedSsim, `${slug} decoded minimum SSIM ${minSsim} is below ${minDecodedSsim}.`);
  assert(minPsnr >= minDecodedPsnrDb, `${slug} decoded minimum PSNR ${minPsnr}dB is below ${minDecodedPsnrDb}dB.`);
  assert(new Set(decodedHashes).size >= C6G_COLLISION_VIDEO_MIN_UNIQUE_FRAMES, `${slug} decoded schedule has insufficient visual variation.`);
  const reviewPath = join(roots.review, `${slug}-contact-sheet.png`);
  const expression = C6G_COLLISION_VIDEO_REVIEW_FRAMES.map((index) => `eq(n\\,${index})`).join("+");
  await runTool(String(tools.ffmpeg.path), ["-v", "error", "-i", videoPath, "-vf", `select=${expression},scale=320:180:flags=lanczos,tile=4x2`, "-frames:v", "1", reviewPath]);
  const reviewQuality = await inspectPngFile(reviewPath); assert(reviewQuality.ok && !reviewQuality.blank, "C6G contact sheet is blank or invalid.");
  const checkpoints = C6G_COLLISION_VIDEO_CHECKPOINTS[slug].map((index) => comparisons[index]);
  return {
    probe,
    frameCount: decodedPaths.length,
    decodedSequenceSha256: canonicalJsonSha256(decodedHashes), uniqueDecodedHashes: new Set(decodedHashes).size,
    quality: { thresholds: { minSsim: minDecodedSsim, minPsnrDb: minDecodedPsnrDb }, minSsim, averageSsim: totalSsim / comparisons.length, minPsnrDb: minPsnr, averagePsnrDb: totalPsnr / comparisons.length },
    alpha: { codecSupportsAlpha: false, decodedOpaque: true, expectedFlattening: "source-was-already-composited-opaque" },
    comparisons, checkpoints,
    contactSheet: { path: relative(outputRoot, reviewPath), sha256: await sha256File(reviewPath), reviewFrames: C6G_COLLISION_VIDEO_REVIEW_FRAMES },
  };
}

async function proveCancellation(frames: SourceFrame[], roots: Awaited<ReturnType<typeof prepareRoots>>, outputRoot: string): Promise<Json> {
  const outputPath = join(roots.cancellation, "cancelled-after-one-frame.mp4"), controller = new AbortController(), processes = trackedProductionProcessFactory();
  const planned = planCollisionVideoCommand(outputPath);
  let producerReads = 0;
  const result = await runStreamingFinalEncodePolicy({
    fps: C6G_COLLISION_VIDEO_FPS, width: 1_280, height: 720, durationMs: C6G_COLLISION_VIDEO_DURATION_MS,
    outputPath, outputRoots: [roots.cancellation], preset: C6G_COLLISION_VIDEO_PRESET, forceSoftwareEncode: true,
    quality: { minDurationMs: 5_000, minUniqueFrameHashes: C6G_COLLISION_VIDEO_STREAMING_MIN_UNIQUE_FRAMES },
    scratchRoot: join(roots.jobs, "cancellation"), operation: "c6g.collision-video.cancel", callerId: "c6g-collision-video-proof", jobId: "c6g-video:cancel",
    signal: controller.signal, processFactory: processes.factory,
    produce: async (sink) => {
      const frame = frames[0]!; producerReads += 1;
      await sink.write({ index: frame.frameIndex, atMs: frame.encoderAtMs, png: await readFile(frame.path) });
      controller.abort(new Error("C6G proof cancellation after one accepted frame."));
    },
  });
  assert.equal(result.ok, false, "C6G cancellation probe unexpectedly completed."); if (result.ok) throw new Error("Unreachable C6G cancellation success.");
  assert.equal(result.error.code, "job_cancelled"); assert.equal(result.error.resources?.state, "cancelled"); assert.equal(producerReads, 1);
  assert.deepEqual(result.plannedAttempts[0]?.command, planned);
  assert.equal(result.error.handoff?.backpressure.writes, 1);
  assert.deepEqual(result.error.handoff?.attempts, [{ source: "software", encoder: "libx264", outcome: "failed", failure: { code: "job_cancelled", message: "Streaming FFmpeg job was cancelled." } }]);
  const terminalPids = await terminalProcessEvidence(processes.pids); assert.equal(terminalPids.allTerminal, true);
  const partial = await fileEvidence(outputPath, outputRoot);
  return {
    requestedAfterAcceptedFrame: 0, producerReads, code: result.error.code, resources: result.error.resources, handoff: result.error.handoff,
    plannedCommandIdentity: collisionVideoCommandIdentity(planned, outputPath), encoderProcesses: terminalPids, partialOutput: partial,
    terminal: true, noFinalReceiptCreated: true,
  };
}

function trackedProductionProcessFactory(): TrackedProcessFactory {
  const pids: number[] = [];
  return {
    pids,
    factory: async (input) => await startStreamingFfmpegProcess({
      ...input,
      watchProcess(pid) { pids.push(pid); input.watchProcess(pid); },
    }),
  };
}

async function terminalProcessEvidence(pids: number[]): Promise<{ pids: number[]; allTerminal: boolean }> {
  assert(pids.length > 0, "C6G encoder launched no watched process.");
  for (let attempt = 0; attempt < 20 && pids.some(pidAlive); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  return { pids: [...pids], allTerminal: pids.every((pid) => !pidAlive(pid)) };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function probeVideo(path: string, ffprobe: string): Promise<Json> {
  const result = await runTool(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path]);
  const parsed = mustObject(JSON.parse(result.stdout), "C6G FFprobe JSON"), streams = mustArray(parsed.streams, "C6G FFprobe streams").map((value) => mustObject(value, "C6G FFprobe stream"));
  const video = streams.filter((stream) => stream.codec_type === "video"), audio = streams.filter((stream) => stream.codec_type === "audio");
  assert.equal(video.length, 1); assert.equal(audio.length, 0); const stream = video[0]!;
  assert.equal(stream.codec_name, "h264"); assert.equal(stream.width, 1_280); assert.equal(stream.height, 720); assert.equal(stream.pix_fmt, "yuv420p");
  assert.equal(rational(stream.avg_frame_rate), C6G_COLLISION_VIDEO_FPS); assert.equal(Number(stream.nb_read_frames), C6G_COLLISION_VIDEO_FRAME_COUNT);
  assert.equal(stream.color_range, "tv"); assert.equal(stream.color_space, "bt709"); assert.equal(stream.color_transfer, "bt709"); assert.equal(stream.color_primaries, "bt709");
  const format = mustObject(parsed.format, "C6G FFprobe format"); assert(String(format.format_name).split(",").includes("mp4"));
  const durationMs = Number(stream.duration ?? format.duration) * 1_000; assert(Math.abs(durationMs - C6G_COLLISION_VIDEO_DURATION_MS) <= 2);
  return {
    observedJsonSha256: canonicalJsonSha256(parsed), codec: stream.codec_name, profile: stream.profile, pixelFormat: stream.pix_fmt,
    width: stream.width, height: stream.height, fps: rational(stream.avg_frame_rate), frameCount: Number(stream.nb_read_frames), durationMs,
    color: { range: stream.color_range, space: stream.color_space, transfer: stream.color_transfer, primaries: stream.color_primaries },
    alphaPresent: false, audioStreamCount: audio.length, container: format.format_name,
  };
}

function comparisonProjection(frame: SourceFrame, comparison: Extract<PngVisualDiffResult, { ok: true }>, sha256: string, path: string): Json {
  return {
    frameIndex: frame.frameIndex, sourceAtUs: frame.atUs, encoderAtMs: frame.encoderAtMs, path, sha256,
    ssim: comparison.ssim, psnrDb: comparison.psnrDb, meanAbsoluteError: comparison.meanAbsoluteError, meanSquaredError: comparison.meanSquaredError, maxChannelDelta: comparison.maxChannelDelta,
  };
}

function summarizeFrameResources(resources: LocalMotionJobEvidence[]): Json {
  assert.equal(resources.length, C6G_COLLISION_VIDEO_FRAME_COUNT); assert(resources.every((entry) => entry.state === "passed"));
  return {
    operations: resources.length, allPassed: true, maxQueueWaitMs: Math.max(...resources.map((entry) => entry.queueWaitMs)),
    maxDurationMs: Math.max(...resources.map((entry) => entry.durationMs)), maxPeakProcessTreeRssBytes: Math.max(...resources.map((entry) => entry.peakProcessTreeRssBytes)),
    watchedBrowserOperations: resources.filter((entry) => entry.watchedProcessCount > 0).length,
  };
}

function relativeReceiptEvidence(evidence: unknown, outputRoot: string): Json {
  return mustObject(JSON.parse(JSON.stringify(evidence, (_key, value) => typeof value === "string" && value.startsWith(`${outputRoot}/`) ? relative(outputRoot, value) : value)), "relative receipt evidence");
}

function normalizedCommand(command: FfmpegCommand, outputPath: string): Json {
  return { executable: command.executable.split(/[\\/]/).at(-1), args: command.args.map((value) => value === outputPath ? "<proof-output>.mp4" : value), shell: command.shell };
}

async function sourceEvidence(expectedCommit: string): Promise<Json> {
  const sourceFiles = [
    scriptPath,
    join(repoRoot, "scripts", "c6g-collision-video-proof-contract.ts"),
    join(repoRoot, "scripts", "c6g-collision-video-proof.test.ts"),
    join(repoRoot, "scripts", "c6g-collision-checkpoint-proof-contract.ts"),
    join(repoRoot, "package.json"),
    join(repoRoot, "packages", "renderer-browser", "src", "unadopted", "gpu-collision-showcase-preview-session.ts"),
    join(repoRoot, "packages", "renderer-ffmpeg", "src", "streaming-final-command-plan.ts"),
    join(repoRoot, "packages", "renderer-ffmpeg", "src", "streaming-final-encode-policy.ts"),
    join(repoRoot, "packages", "renderer-ffmpeg", "src", "streaming-foundation.ts"),
    join(repoRoot, "packages", "renderer-ffmpeg", "src", "streaming-process.ts"),
  ];
  const [head, expected, tree, status] = await Promise.all([git("rev-parse", "HEAD"), git("rev-parse", `${expectedCommit}^{commit}`), git("rev-parse", "HEAD^{tree}"), git("status", "--porcelain", "--untracked-files=no")]);
  assert.equal(head, expected, `Harness requires checkout ${expectedCommit}, found ${head}.`); assert.equal(status, "", "Harness requires a clean tracked working tree.");
  for (const path of sourceFiles) assert.equal(await git("ls-files", "--error-unmatch", relative(repoRoot, path)), relative(repoRoot, path));
  return { commit: head, tree, expectedCommit, files: Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [relative(repoRoot, path), await sha256File(path)]))) };
}

async function executableEvidence(command: string): Promise<Json> {
  const path = await resolveExecutable(command), result = await runTool(path, ["-version"]);
  return { path, sha256: await sha256File(path), version: result.stdout.split("\n")[0] ?? "" };
}

async function resolveExecutable(command: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command), facts = await lstat(candidate).catch(() => null); if (!facts || (!facts.isFile() && !facts.isSymbolicLink())) continue;
    const resolved = await realpath(candidate), target = await lstat(resolved); if (target.isFile() && (target.mode & 0o111) !== 0) return resolved;
  }
  throw new Error(`${command} was not a regular executable on PATH.`);
}

async function runTool(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await runFile(executable, args, { encoding: "utf8", timeout: toolTimeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function createFreshPrivateRoot(path: string): Promise<void> {
  assert.equal(await exists(path), false, `Output root already exists: ${path}`); await mkdir(path, { mode: 0o700 });
  const facts = await lstat(path); assert(facts.isDirectory() && !facts.isSymbolicLink()); if (process.platform !== "win32") assert.equal(facts.mode & 0o077, 0);
}

async function fileEvidence(path: string, outputRoot: string): Promise<Json> {
  const facts = await stat(path).catch(() => null); return !facts ? { present: false } : { present: true, path: relative(outputRoot, path), bytes: facts.size, sha256: await sha256File(path) };
}

function receiptHash(receipt: OperationReceipt, key: string): string { const value = receipt.inputHashes[key]; assert(typeof value === "string" && HASH.test(value), `Receipt omitted ${key}.`); return value; }
async function git(...args: string[]): Promise<string> { return (await runFile("git", args, { cwd: repoRoot })).stdout.trim(); }
async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function writeCanonicalExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
async function exists(path: string): Promise<boolean> { return Boolean(await lstat(path).catch(() => null)); }
function rational(value: unknown): number { const match = typeof value === "string" ? value.match(/^(\d+)\/(\d+)$/) : null; assert(match && Number(match[2]) > 0, "FFprobe reported an invalid frame rate."); return Number(match[1]) / Number(match[2]); }
function mustObject(value: unknown, label: string): Json { assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`); return value as Json; }
function mustArray(value: unknown, label: string): unknown[] { assert(Array.isArray(value), `${label} must be an array.`); return value; }
function safeError(error: unknown): Json { return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) }; }

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) { try { await runCollisionVideoProof(process.argv.slice(2)); } catch { process.exitCode = 1; } }
