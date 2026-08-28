import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMotionPackage, type MotionPackage } from "../packages/core/src/index";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";
import {
  createBrowserStreamingFrameProducer,
  createMotionBrowserRenderSession
} from "../packages/renderer-browser/src/index";
import { produceNativeFrameStream } from "../packages/renderer-native/src/index";
import {
  createMediaHeavyBenchmarkPackage,
  createNativeBenchmarkPackage
} from "./renderer-workload-fixtures";

type SessionWorkloadKind = "cold-still" | "warm-still" | "preview-strip" | "generated" | "alpha" | "media-heavy" | "browser";

interface Workload {
  id: string;
  kind: SessionWorkloadKind | "native";
  transport: "session" | "streamed" | "debug-api";
  lane: "browser" | "native";
  fixture?: string;
  durationMs?: number;
  fps?: number;
  frameCount: number;
  /** Optional canonical subrange used to prove producer resume prerequisites without segment storage. */
  range?: { startFrameIndex: number; endFrameIndexExclusive: number };
  maxElapsedMs: number;
  minFramesPerSecond?: number;
  minCacheHits?: number;
  extended?: boolean;
}

interface MatrixResult {
  readonly id: string;
  readonly ok: boolean;
  readonly transport: Workload["transport"];
  readonly lane: Workload["lane"];
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly rangeFrameCount: number;
  readonly emittedFrames: number;
  readonly elapsedMs: number;
  readonly framesPerSecond: number;
  readonly frameDigest: string;
  readonly peakProcessRssBytes: number;
  readonly metrics: Record<string, unknown>;
  readonly failures: string[];
}

const matrix = JSON.parse(
  await readFile(resolve("fixtures/benchmarks/renderer-workload-matrix.json"), "utf8")
) as { schema: string; workloads: Workload[] };
const extended = process.argv.includes("--extended") || process.env.SHELLX_MOTION_EXTENDED_BENCHMARK === "1";
const requestedWorkload = optionValue("--workload");
const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-renderer-matrix-"));
const results: MatrixResult[] = [];
const selectedWorkloads = matrix.workloads.filter((entry) =>
  (extended || !entry.extended) && (requestedWorkload === undefined || entry.id === requestedWorkload)
);
if (requestedWorkload !== undefined && selectedWorkloads.length === 0) {
  throw new Error(`Unknown or disabled matrix workload: ${requestedWorkload}`);
}

try {
  for (const workload of selectedWorkloads) {
    const result = await runWorkload(workload, tempRoot);
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`${JSON.stringify({
  schema: "renderer-workload-matrix-result@2",
  extended,
  ok: failed.length === 0,
  workloadCount: results.length,
  failed: failed.map((result) => result.id)
}, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;

async function runWorkload(workload: Workload, scratchRoot: string): Promise<MatrixResult> {
  const pkg = await packageForWorkload(workload, scratchRoot);
  const evidence = createFrameEvidence(workload.range?.startFrameIndex ?? 0);
  const startedAt = performance.now();
  const metrics = workload.transport === "streamed"
    ? await runStreamedProducer(workload, pkg, scratchRoot, evidence)
    : await runBrowserSession(workload, pkg, scratchRoot, evidence);
  const elapsedMs = performance.now() - startedAt;
  const framesPerSecond = evidence.emittedFrames / (elapsedMs / 1_000);
  const failures = workloadFailures(workload, evidence, metrics, elapsedMs, framesPerSecond);
  return {
    id: workload.id,
    ok: failures.length === 0,
    transport: workload.transport,
    lane: workload.lane,
    width: pkg.motion.width,
    height: pkg.motion.height,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    frameCount: workload.frameCount,
    rangeFrameCount: selectedFrameCount(workload),
    emittedFrames: evidence.emittedFrames,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    framesPerSecond: Number(framesPerSecond.toFixed(3)),
    frameDigest: evidence.digest.digest("hex"),
    peakProcessRssBytes: evidence.peakProcessRssBytes,
    metrics,
    failures
  };
}

async function packageForWorkload(workload: Workload, scratchRoot: string): Promise<MotionPackage> {
  if (workload.kind === "media-heavy") return createMediaHeavyBenchmarkPackage(join(scratchRoot, workload.id), workload);
  if (workload.kind === "native") return createNativeBenchmarkPackage(join(scratchRoot, workload.id), workload);
  return loadAndAdaptPackage(workload);
}

async function runBrowserSession(
  workload: Workload,
  pkg: MotionPackage,
  scratchRoot: string,
  evidence: FrameEvidence
): Promise<Record<string, unknown>> {
  if (workload.lane !== "browser") throw new Error(`${workload.id}: session workloads require the browser lane.`);
  const outDir = join(scratchRoot, workload.id, "frames");
  await mkdir(outDir, { recursive: true });
  if (workload.kind === "preview-strip") {
    const preview = await dispatchDebugCommand(
      "motion.preview.strip",
      {
        packageRoot: pkg.root,
        outDir,
        frameCount: workload.frameCount,
        startMs: 0,
        endMs: pkg.motion.durationMs,
        createdAt: "2026-08-09T00:00:00.000Z"
      },
      { tier: "render_motion" }
    );
    if (!preview.ok) throw new Error(`${workload.id}: preview strip refused ${preview.error.code}.`);
    const frames = (preview.result as { frames?: Array<{ index: number; atMs: number; sha256: string }> }).frames;
    if (!frames || frames.length !== workload.frameCount) {
      throw new Error(`${workload.id}: preview strip returned an invalid frame list.`);
    }
    for (const frame of frames) {
      observeFrame(evidence, frame.index, frame.atMs, Buffer.from(frame.sha256, "hex"));
    }
    return { command: "motion.preview.strip", frameCount: frames.length };
  }
  const session = await createMotionBrowserRenderSession(pkg);
  try {
    const renderCount = workload.kind === "warm-still" ? 2 : workload.frameCount;
    for (let index = 0; index < renderCount; index += 1) {
      const atMs = workload.kind === "warm-still" ? 0 : timestampFor(index, pkg, workload.frameCount);
      const frame = await session.renderFrame({
        atMs,
        outDir,
        outputPath: join(outDir, `${String(index).padStart(6, "0")}.png`)
      });
      observeFrame(evidence, index, atMs, Buffer.from(frame.output.sha256, "hex"));
    }
    return { ...session.metrics };
  } finally {
    await session.close();
  }
}

async function runStreamedProducer(
  workload: Workload,
  pkg: MotionPackage,
  scratchRoot: string,
  evidence: FrameEvidence
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const sink = { write: async (frame: { index: number; atMs: number; png: Buffer }) => {
    observeFrame(evidence, frame.index, frame.atMs, frame.png);
  } };
  if (workload.lane === "browser") {
    const producer = createBrowserStreamingFrameProducer({ pkg, ...(workload.range ? { range: workload.range } : {}) });
    await producer.produce(sink, {
      admission: "pre-acquired",
      jobId: workload.id,
      scratchRoot,
      signal: controller.signal,
      watchProcess: () => undefined,
      reportSandbox: () => undefined
    });
    return { ...producer.metrics };
  }
  const result = await produceNativeFrameStream({
    packageRoot: pkg.root,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    frameCount: workload.frameCount,
    ...(workload.range ? { range: workload.range } : {})
  }, sink, {
    signal: controller.signal,
    job: { admission: "pre-acquired", jobId: workload.id, scratchRoot, signal: controller.signal }
  });
  if (!result.ok) throw new Error(`${workload.id}: native producer refused ${result.error.code}.`);
  return { ...result.evidence.producer, cleanupState: result.evidence.session.cleanupState };
}

interface FrameEvidence {
  expectedIndex: number;
  emittedFrames: number;
  peakProcessRssBytes: number;
  digest: ReturnType<typeof createHash>;
}

function createFrameEvidence(expectedIndex: number): FrameEvidence {
  return { expectedIndex, emittedFrames: 0, peakProcessRssBytes: process.memoryUsage().rss, digest: createHash("sha256") };
}

function observeFrame(evidence: FrameEvidence, index: number, atMs: number, png: Buffer): void {
  if (index !== evidence.expectedIndex) throw new Error(`Expected frame ${evidence.expectedIndex}, received ${index}.`);
  evidence.digest.update(`${index}:${atMs}:`);
  evidence.digest.update(createHash("sha256").update(png).digest());
  evidence.expectedIndex += 1;
  evidence.emittedFrames += 1;
  evidence.peakProcessRssBytes = Math.max(evidence.peakProcessRssBytes, process.memoryUsage().rss);
}

function workloadFailures(
  workload: Workload,
  evidence: FrameEvidence,
  metrics: Record<string, unknown>,
  elapsedMs: number,
  framesPerSecond: number
): string[] {
  const failures = [
    ...(evidence.emittedFrames !== selectedFrameCount(workload) ? [`emitted ${evidence.emittedFrames} frames, expected ${selectedFrameCount(workload)}`] : []),
    ...(elapsedMs > workload.maxElapsedMs ? [`elapsed ${elapsedMs.toFixed(2)}ms > ${workload.maxElapsedMs}ms`] : []),
    ...(workload.minFramesPerSecond && framesPerSecond < workload.minFramesPerSecond
      ? [`throughput ${framesPerSecond.toFixed(3)}fps < ${workload.minFramesPerSecond}fps`] : []),
    ...(workload.kind === "warm-still" && Number(metrics.frameCacheHits) < (workload.minCacheHits ?? 0)
      ? [`cache hits ${metrics.frameCacheHits} < ${workload.minCacheHits}`] : []),
    ...(workload.transport === "streamed" && Number(metrics.peakInFlightPngHandoffs ?? metrics.peakConcurrentFrameHandoffs) > 1
      ? ["streamed producer retained more than one active PNG handoff"] : [])
  ];
  return failures;
}

function selectedFrameCount(workload: Workload): number {
  return workload.range
    ? workload.range.endFrameIndexExclusive - workload.range.startFrameIndex
    : workload.frameCount;
}

function timestampFor(index: number, pkg: MotionPackage, frameCount: number): number {
  return Math.min(pkg.motion.durationMs - 1, Math.floor(index * pkg.motion.durationMs / frameCount));
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a workload id.`);
  return value;
}

async function loadAndAdaptPackage(workload: Workload): Promise<MotionPackage> {
  const loaded = await loadMotionPackage(resolve(workload.fixture!));
  const motion = structuredClone(loaded.motion);
  motion.width = 1920;
  motion.height = 1080;
  motion.durationMs = workload.durationMs ?? loaded.motion.durationMs;
  motion.fps = workload.fps ?? loaded.motion.fps;
  motion.layers = motion.layers.map((layer) => ({ ...layer, durationMs: motion.durationMs }));
  if (workload.kind === "alpha") delete motion.background;
  return { ...loaded, motion };
}
