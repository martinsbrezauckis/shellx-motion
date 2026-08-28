import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeRgbaPng,
  hashFile,
  LocalMotionJobError,
  LocalMotionJobGovernor,
  streamingFrameTimestampMs,
  type LocalMotionJobContext,
  type LocalMotionJobPolicy,
  type LocalMotionProcessContainmentEvidence
} from "@shellx-motion/core";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import { verifyPreAdmittedLosslessSegment } from "./segmented-final-internal/segment-ffprobe-readback.js";
import { spoolRenderSegments, spoolRenderSegmentsAdmitted } from "./segmented-final-internal/render-segment-spool.js";
import type { RenderSegmentRangeProducerFactory, RenderSegmentSpoolInput } from "./segmented-final-internal/render-segment-spool-types.js";
import { createStreamingEvidenceReporter } from "./streaming-foundation-helpers.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";

const roots: string[] = [];
const SHA = "a".repeat(64);
const CONTAINMENT = {
  schema: "shellx-motion/process-containment@1" as const,
  mode: "direct-child" as const,
  status: "unavailable" as const,
  killTree: false,
  memoryLimit: "none" as const,
  reasonCode: "unsupported_platform" as const
};
const SANDBOX = {
  schema: "shellx-motion/runtime-sandbox@1" as const,
  provider: "chromium" as const,
  status: "requested" as const,
  scope: "browser-process" as const
};
const hostFfmpegAndFfprobeAvailable = ["ffmpeg", "ffprobe"].every((tool) =>
  spawnSync(tool, ["-version"], { stdio: "ignore", shell: false }).status === 0
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("internal resumable FFV1 segment spool", () => {
  it("creates ordered multi-segment checkpoints under one admitted sequential handoff", async () => {
    const fixture = await newFixture(5, 2);
    const started: string[] = [];
    const reports: unknown[] = [];
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      processFactory: fakeEncoder({ started }),
      job: testJob(reports)
    }));

    expect(result).toMatchObject({ ok: true, handoff: { sequential: true, maxConcurrentPngHandoffs: 1, observedMaxConcurrentPngHandoffs: 1 } });
    if (!result.ok) return;
    expect(result.manifest.completed.map((entry) => entry.range.index)).toEqual([0, 1, 2]);
    expect(result.manifest.completed.map((entry) => entry.frameHashes.length)).toEqual([2, 2, 1]);
    expect(started).toHaveLength(3);
    expect(started.every((path) => path.endsWith(".mkv.partial"))).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it("forwards repeated identical containment once and refuses a conflicting later attempt", async () => {
    const fixture = await newFixture(4, 2);
    const reports: unknown[] = [];
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      job: testJob(reports),
      processFactory: fakeEncoder({ containment: (attempt) => attempt === 1 ? CONTAINMENT : { ...CONTAINMENT, mode: "unix-process-group", status: "enforced" } })
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "segment_encoder_failed", evidence: { verifiedPrefixSegments: 1 } } });
    expect(reports).toEqual([CONTAINMENT]);
  });

  it("uses one supplied reporter for every spool containment and producer sandbox assignment", async () => {
    const fixture = await newFixture(4, 2);
    const containments: unknown[] = [];
    const sandboxes: unknown[] = [];
    const job: LocalMotionJobContext = {
      ...testJob(containments),
      reportSandbox: (evidence) => sandboxes.push(evidence)
    };
    const reporter = createStreamingEvidenceReporter(job);
    const sharedProducer: RenderSegmentRangeProducerFactory = ({ range }) => ({
      evidence: { schema: "shellx-motion/segment-range-producer@1", frameLane: "native", warningUnion: [], warningsOmitted: 0 },
      produce: async (sink, producerJob) => {
        producerJob.reportSandbox(SANDBOX);
        for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
          await sink.write({
            index,
            atMs: streamingFrameTimestampMs(index, fixture.timeline.fps, fixture.timeline.durationMs),
            png: png(2, 2, index + 1)
          });
        }
      }
    });
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      job,
      evidenceReporter: reporter,
      createRangeProducer: sharedProducer
    }));

    expect(result).toMatchObject({ ok: true });
    expect(containments).toEqual([CONTAINMENT]);
    expect(sandboxes).toEqual([SANDBOX]);
  });

  it("resumes exactly the verified prefix and never recreates its producer ranges", async () => {
    const fixture = await newFixture(6, 2);
    const first = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      createRangeProducer: producerFactory(fixture, (range) => range.startFrameIndex === 4 ? new Error("interrupt") : undefined)
    }));
    expect(first).toMatchObject({ ok: false, error: { evidence: { verifiedPrefixSegments: 2 } } });
    const rendered: number[] = [];
    const resumed = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      intent: "resume",
      createRangeProducer: producerFactory(fixture, undefined, rendered)
    }));
    expect(resumed).toMatchObject({ ok: true });
    expect(rendered).toEqual([4, 5]);
  });

  it("binds browser script evidence across ranges and refuses a conflicting later verdict", async () => {
    const fixture = await newFixture(4, 2);
    const expected = scriptEvidence("attestation-a");
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      frameLane: "browser",
      producer: { frameLane: "browser", scriptExecution: expected },
      createRangeProducer: ({ range }: { range: { startFrameIndex: number; endFrameIndexExclusive: number } }) => ({
        evidence: {
          schema: "shellx-motion/segment-range-producer@1",
          frameLane: "browser",
          scriptExecution: range.startFrameIndex === 0 ? expected : scriptEvidence("attestation-b"),
          warningUnion: [],
          warningsOmitted: 0
        },
        produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }) => {
          for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
            await sink.write({ index, atMs: streamingFrameTimestampMs(index, fixture.timeline.fps, fixture.timeline.durationMs), png: png(2, 2, index + 1) });
          }
        }
      })
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "segment_producer_failed", evidence: { verifiedPrefixSegments: 1 } } });
  });

  it("refuses a successfully produced browser range when its session evidence is missing", async () => {
    const fixture = await newFixture(2, 2);
    const expected = scriptEvidence("attestation-a");
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      frameLane: "browser",
      producer: { frameLane: "browser", scriptExecution: expected },
      createRangeProducer: ({ range }: { range: { startFrameIndex: number; endFrameIndexExclusive: number } }) => ({
        produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }) => {
          for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
            await sink.write({ index, atMs: streamingFrameTimestampMs(index, fixture.timeline.fps, fixture.timeline.durationMs), png: png(2, 2, index + 1) });
          }
        }
      })
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "segment_producer_failed", evidence: { verifiedPrefixSegments: 0 } } });
  });

  it("refuses a complete resumed prefix when the current host script verdict changed", async () => {
    const fixture = await newFixture(2, 2);
    const expected = scriptEvidence("attestation-a");
    const initial = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      frameLane: "browser",
      producer: { frameLane: "browser", scriptExecution: expected },
      createRangeProducer: browserProducerFactory(fixture, expected)
    }));
    expect(initial).toMatchObject({ ok: true });
    let producerCalls = 0;
    const resumed = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      intent: "resume",
      frameLane: "browser",
      producer: { frameLane: "browser", scriptExecution: scriptEvidence("attestation-b") },
      createRangeProducer: () => { producerCalls += 1; return browserProducerFactory(fixture, expected)({ range: { startFrameIndex: 0, endFrameIndexExclusive: 2 } }); }
    }));
    expect(resumed).toMatchObject({ ok: false, error: { code: "segment_store_failed" } });
    expect(producerCalls).toBe(0);
  });

  it("delegates plan, package-content, and artifact-tamper refusal to the durable store before producers run", async () => {
    for (const mutation of ["plan", "content", "tamper"] as const) {
      const fixture = await newFixture(4, 2);
      expect((await spoolRenderSegmentsAdmitted(admitted(fixture))).ok).toBe(true);
      if (mutation === "content") await writeFile(join(fixture.packageRoot, "extra.txt"), "changed");
      if (mutation === "tamper") await writeFile(join(fixture.storeRoot, "segments", "segment-000001.mkv"), "tampered");
      let producers = 0;
      const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
        intent: "resume",
        ...(mutation === "plan" ? { plan: planRenderSegments({ frameCount: 4, segmentFrames: 1 }) } : {}),
        createRangeProducer: () => { producers += 1; return { produce: async () => undefined }; }
      }));
      expect(result).toMatchObject({ ok: false, error: { code: "segment_store_failed" } });
      expect(producers).toBe(0);
    }
  });

  it("refuses loaded package bytes replaced before checkpoint admission", async () => {
    const fixture = await newFixture(2, 2);
    await writeFile(join(fixture.packageRoot, "motion.json"), "{\"fps\":24}\n");
    let producers = 0;
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      createRangeProducer: () => {
        producers += 1;
        return { produce: async () => undefined };
      }
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "segment_source_fingerprint_failed", evidence: { phase: "source_fingerprint" } }
    });
    expect(producers).toBe(0);
  });

  it("refuses producer order, timestamp, and dimensions before a checkpoint can be committed", async () => {
    for (const invalid of ["index", "timestamp", "dimensions"] as const) {
      const fixture = await newFixture(2, 2);
      const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
        createRangeProducer: () => ({
          produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }) => await sink.write({
            index: invalid === "index" ? 1 : 0,
            atMs: invalid === "timestamp" ? 1 : 0,
            png: invalid === "dimensions" ? png(3, 2, 1) : png(2, 2, 1)
          })
        })
      }));
      expect(result).toMatchObject({ ok: false, error: { code: "segment_frame_invalid", evidence: { verifiedPrefixSegments: 0 } } });
      expect(existsSync(join(fixture.storeRoot, "segments", ".segment-000001.mkv.partial"))).toBe(false);
    }
  });

  it("holds one PNG through a paused sink and one governor slot through the standalone wrapper", async () => {
    const fixture = await newFixture(2, 2);
    let release!: () => void;
    const paused = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    let writes = 0;
    const processFactory = fakeEncoder({ onWrite: async () => { writes += 1; if (writes === 1) await paused; } });
    const pending = spoolRenderSegmentsAdmitted(admitted(fixture, { processFactory }));
    await waitFor(() => writes === 1);
    expect(writes).toBe(1);
    release();
    expect(await pending).toMatchObject({ ok: true, handoff: { observedMaxConcurrentPngHandoffs: 1 } });

    let admissions = 0;
    const governor = {
      run: async (_request: unknown, operation: (job: LocalMotionJobContext) => Promise<unknown>) => {
        admissions += 1;
        return { value: await operation(testJob([])), evidence: { state: "passed" } };
      }
    } as unknown as LocalMotionJobGovernor;
    const wrapped = await spoolRenderSegments({ ...baseInput(fixture), governor, store: { intent: "create", rootPath: await siblingStore(fixture) } });
    expect(wrapped).toMatchObject({ ok: true });
    expect(admissions).toBe(1);
  });

  it("preserves frozen primary and cleanup causes, removes only the current partial, and keeps a verified prefix", async () => {
    const fixture = await newFixture(4, 2);
    expect((await spoolRenderSegmentsAdmitted(admitted(fixture))).ok).toBe(true);
    const frozen = Object.freeze(new Error("frozen producer failure"));
    const cleanup = new Error("abort cleanup failure");
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      intent: "resume",
      plan: planRenderSegments({ frameCount: 6, segmentFrames: 2 }),
      timeline: { ...fixture.timeline, frameCount: 6, durationMs: 600 },
      createRangeProducer: producerFactory({ ...fixture, timeline: { ...fixture.timeline, frameCount: 6, durationMs: 600 } }, () => frozen),
      processFactory: fakeEncoder({ abortError: cleanup })
    }));
    // The forged resume plan is rejected before a new range; use an independently interrupted store
    // for the precise current-partial cleanup assertion below.
    expect(result).toMatchObject({ ok: false, error: { code: "segment_store_failed" } });

    const interrupted = await newFixture(4, 2);
    const first = await spoolRenderSegmentsAdmitted(admitted(interrupted, {
      createRangeProducer: producerFactory(interrupted, (range) => range.startFrameIndex === 2 ? frozen : undefined),
      processFactory: fakeEncoder({ abortError: cleanup })
    }));
    expect(first).toMatchObject({ ok: false, error: { evidence: { verifiedPrefixSegments: 1, cleanup: { outcome: "removed" } } } });
    if (first.ok) return;
    expect(first.error.primaryCause).toBe(frozen);
    expect(first.error.cleanupCauses).toContain(cleanup);
    expect(await readFile(join(interrupted.storeRoot, "segments", "segment-000001.mkv"), "utf8")).toBeTruthy();
    await expect(readFile(join(interrupted.storeRoot, "segments", ".segment-000002.mkv.partial"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps governor evidence truthful for cancellation, deadline, and resource failure", async () => {
    for (const [kind, expected] of [["cancel", "cancelled"], ["deadline", "deadline_exceeded"], ["resource", "rss_limit_exceeded"]] as const) {
      const fixture = await newFixture(2, 2);
      const controller = new AbortController();
      const result = await spoolRenderSegments({
        ...baseInput(fixture),
        governor: testGovernor(),
        scratchRoot: fixture.root,
        ...(kind === "cancel" ? { signal: controller.signal, processFactory: fakeEncoder({ onWrite: async () => controller.abort() }) } : {}),
        ...(kind === "deadline" ? { deadlineAtMs: Date.now() - 1 } : {}),
        ...(kind === "resource" ? { createRangeProducer: producerFactory(fixture, () => new LocalMotionJobError("job_rss_limit_exceeded", "rss")) } : {})
      });
      expect(result).toMatchObject({ ok: false, error: { evidence: { resourceCode: kind === "resource" ? "job_rss_limit_exceeded" : expect.any(String) } }, resources: { state: expected } });
      if (!result.ok) expect(result.resources?.state).not.toBe("passed");
    }
  });

  it("returns bounded encoder failures for launch, stdin, and nonzero process exits", async () => {
    for (const options of [
      { startError: new Error("launch") },
      { writeError: new Error("stdin") },
      { endExitCode: 21 }
    ]) {
      const fixture = await newFixture(2, 2);
      const result = await spoolRenderSegmentsAdmitted(admitted(fixture, { processFactory: fakeEncoder(options) }));
      expect(result).toMatchObject({ ok: false, error: { code: "segment_encoder_failed", evidence: { cleanup: { outcome: "removed" }, verifiedPrefixSegments: 0 } } });
    }
  });

  it("refuses failed verification without disturbing the verified prefix", async () => {
    const fixture = await newFixture(4, 2);
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      verifyReadback: async (input: Parameters<NonNullable<RenderSegmentSpoolInput["verifyReadback"]>>[0]) => input.range.index === 0
        ? verifiedReadback(input)
        : { ok: false as const, message: "readback refused" }
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "segment_checkpoint_failed", evidence: { verifiedPrefixSegments: 1, cleanup: { outcome: "missing" } } } });
    await expect(readFile(join(fixture.storeRoot, "segments", "segment-000001.mkv"))).resolves.toBeTruthy();
    await expect(readFile(join(fixture.storeRoot, "segments", ".segment-000002.mkv.partial"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a bounded refusal for structurally invalid FFprobe JSON", async () => {
    for (const stdout of ["null", '{"streams":{}}']) {
      const result = await verifyPreAdmittedLosslessSegment({
        artifactPath: "/not-opened-by-the-fake/segment.mkv",
        range: { index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 },
        expected: {
          timeline: { motionSha256: SHA, durationMs: 100, fps: 10, width: 2, height: 2 },
          intermediate: { container: "matroska", codec: "ffv1", extension: ".mkv" }
        },
        job: testJob([]),
        processFactory: async () => completedProcess({ exitCode: 0, stdout, stderr: "" }),
        reportProcessContainment() {}
      });
      expect(result).toEqual({ ok: false, message: "FFprobe returned invalid segment readback data." });
    }
  });

  it("prioritizes lifecycle cancellation over a concurrent verifier refusal", async () => {
    const fixture = await newFixture(2, 2);
    const controller = new AbortController();
    const result = await spoolRenderSegments({
      ...baseInput(fixture),
      signal: controller.signal,
      governor: testGovernor(),
      scratchRoot: fixture.root,
      verifyReadback: async () => {
        controller.abort();
        return { ok: false as const, message: "probe raced with cancellation" };
      }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "segment_cancelled", evidence: { resourceCode: "job_cancelled", cleanup: { outcome: "missing" } }, primaryCause: expect.any(LocalMotionJobError) }, resources: { state: "cancelled" } });
    if (!result.ok) expect(result.error.cleanupCauses).toHaveLength(1);
  });

  it("rechecks complete package content after the final checkpoint", async () => {
    const fixture = await newFixture(2, 2);
    const result = await spoolRenderSegmentsAdmitted(admitted(fixture, {
      verifyReadback: async (input: Parameters<NonNullable<RenderSegmentSpoolInput["verifyReadback"]>>[0]) => {
        const result = await verifiedReadback(input);
        await writeFile(join(fixture.packageRoot, "changed-during-spool.txt"), "changed");
        return result;
      }
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "segment_source_changed", evidence: { verifiedPrefixSegments: 1, cleanup: { outcome: "not_needed" } } } });
    await expect(readFile(join(fixture.storeRoot, "segments", "segment-000001.mkv"))).resolves.toBeTruthy();
  });

  it("rejects invalid deadlines before scheduling or starting a process", async () => {
    for (const deadlineAtMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const fixture = await newFixture(2, 2);
      const started: string[] = [];
      const result = await spoolRenderSegmentsAdmitted(admitted(fixture, { deadlineAtMs, processFactory: fakeEncoder({ started }) }));
      expect(result).toMatchObject({ ok: false, error: { code: "segment_store_failed" } });
      expect(started).toEqual([]);
    }
  });

  it("refuses equal and nested package/store roots while accepting sibling roots", async () => {
    const fixture = await newFixture(2, 2);
    for (const storeRoot of [fixture.packageRoot, join(fixture.packageRoot, "store"), resolve(fixture.root)]) {
      const result = await spoolRenderSegmentsAdmitted(admitted(fixture, { storeRoot }));
      expect(result).toMatchObject({ ok: false, error: { code: "segment_store_failed" } });
    }
    expect((await spoolRenderSegmentsAdmitted(admitted(fixture, { storeRoot: await siblingStore(fixture) }))).ok).toBe(true);
  });

  it.skipIf(!hostFfmpegAndFfprobeAvailable)("proves a real contained FFmpeg plus FFprobe range checkpoint when installed", async () => {
    const fixture = await newFixture(2, 2);
    const result = await spoolRenderSegments({
      package: { rootPath: fixture.packageRoot, id: "spool-test", manifestSha256: SHA },
      timeline: fixture.timeline,
      frameLane: "native",
      producer: { frameLane: "native" },
      plan: planRenderSegments({ frameCount: 2, segmentFrames: 2 }),
      store: { intent: "create", rootPath: fixture.storeRoot },
      createRangeProducer: producerFactory(fixture),
      scratchRoot: fixture.root
    });
    expect(result).toMatchObject({ ok: true, manifest: { completed: [{ readback: { frameCount: 2, width: 2, height: 2, fps: 10 } }] } });
    if (!result.ok) return;
    expect((await readFile(join(fixture.storeRoot, "segments", "segment-000001.mkv"))).byteLength).toBeGreaterThan(0);
    expect(result.resources).toMatchObject({ watchedProcessCount: 2, processContainment: expect.any(Object) });
  });
});

async function newFixture(frameCount: number, segmentFrames: number) {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-segment-spool-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const storeRoot = join(root, "store");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "manifest.json"), "{\"id\":\"spool-test\"}\n");
  await writeFile(join(packageRoot, "motion.json"), "{\"fps\":10}\n");
  const inputHashes = {
    "manifest.json": await hashFile(join(packageRoot, "manifest.json")),
    "motion.json": await hashFile(join(packageRoot, "motion.json"))
  };
  return {
    root,
    packageRoot,
    storeRoot,
    segmentFrames,
    inputHashes,
    timeline: { motionSha256: SHA, frameCount, durationMs: frameCount * 100, fps: 10, width: 2, height: 2 }
  };
}

function baseInput(fixture: Awaited<ReturnType<typeof newFixture>>): RenderSegmentSpoolInput {
  return {
    package: { rootPath: fixture.packageRoot, id: "spool-test", manifestSha256: SHA, inputHashes: fixture.inputHashes },
    timeline: fixture.timeline,
    frameLane: "native",
    producer: { frameLane: "native" },
    plan: planRenderSegments({ frameCount: fixture.timeline.frameCount, segmentFrames: fixture.segmentFrames }),
    store: { intent: "create", rootPath: fixture.storeRoot },
    createRangeProducer: producerFactory(fixture),
    processFactory: fakeEncoder(),
    verifyReadback: verifiedReadback
  };
}

function admitted(fixture: Awaited<ReturnType<typeof newFixture>>, overrides: Record<string, unknown> = {}) {
  const base = baseInput(fixture);
  return {
    ...base,
    ...overrides,
    store: { intent: (overrides.intent as "create" | "resume" | undefined) ?? base.store.intent, rootPath: (overrides.storeRoot as string | undefined) ?? base.store.rootPath },
    job: (overrides.job as LocalMotionJobContext | undefined) ?? testJob([])
  };
}

function producerFactory(
  fixture: Awaited<ReturnType<typeof newFixture>>,
  failure?: (range: { startFrameIndex: number }) => unknown,
  rendered: number[] = []
) {
  return ({ range }: { range: { startFrameIndex: number; endFrameIndexExclusive: number } }) => ({
    evidence: { schema: "shellx-motion/segment-range-producer@1" as const, frameLane: "native" as const, warningUnion: [], warningsOmitted: 0 },
    produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }) => {
      const problem = failure?.(range);
      if (problem) throw problem;
      for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
        rendered.push(index);
        await sink.write({ index, atMs: streamingFrameTimestampMs(index, fixture.timeline.fps, fixture.timeline.durationMs), png: png(2, 2, index + 1) });
      }
    }
  });
}

function browserProducerFactory(fixture: Awaited<ReturnType<typeof newFixture>>, scriptExecution: ReturnType<typeof scriptEvidence>) {
  return ({ range }: { range: { startFrameIndex: number; endFrameIndexExclusive: number } }) => ({
    evidence: { schema: "shellx-motion/segment-range-producer@1" as const, frameLane: "browser" as const, scriptExecution, warningUnion: [], warningsOmitted: 0 },
    produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }) => {
      for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
        await sink.write({ index, atMs: streamingFrameTimestampMs(index, fixture.timeline.fps, fixture.timeline.durationMs), png: png(2, 2, index + 1) });
      }
    }
  });
}

function scriptEvidence(attestationId: string) {
  const source = { layerId: "agent-entry", layerType: "html" as const, path: "agent-entry.html", sha256: "f".repeat(64), bytes: 128 };
  return {
    schema: "shellx-motion/script-execution@1" as const,
    detectedClass: "active-content" as const,
    requestedMode: "trusted-local-agent-authored" as const,
    activeMode: "trusted-local-agent-authored" as const,
    resolverVersion: 1,
    packageSnapshotSha256: "e".repeat(64),
    attestationId,
    sources: [source],
    entry: source
  };
}

function fakeEncoder(options: {
  started?: string[];
  onWrite?: (png: Buffer) => Promise<void>;
  abortError?: unknown;
  startError?: unknown;
  writeError?: unknown;
  endExitCode?: number;
  containment?: (attempt: number) => LocalMotionProcessContainmentEvidence;
} = {}): StreamingFfmpegProcessFactory {
  let attempts = 0;
  return async ({ command, reportProcessContainment }) => {
    attempts += 1;
    reportProcessContainment(options.containment?.(attempts) ?? CONTAINMENT);
    const outputPath = command.args.at(-1)!;
    options.started?.push(outputPath);
    await writeFile(outputPath, Buffer.alloc(0));
    if (options.startError !== undefined) throw options.startError;
    const frames: Buffer[] = [];
    let settled = false;
    let resolveClosed!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const closed = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolvePromise) => { resolveClosed = resolvePromise; });
    const finish = (exitCode: number) => {
      if (!settled) { settled = true; resolveClosed({ exitCode, stdout: "", stderr: "" }); }
      return { exitCode, stdout: "", stderr: "" };
    };
    return {
      closed,
      write: async (frame) => {
        if (options.writeError !== undefined) throw options.writeError;
        frames.push(Buffer.from(frame));
        await options.onWrite?.(frame);
        return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 1 };
      },
      end: async () => { await writeFile(outputPath, Buffer.concat(frames)); return finish(options.endExitCode ?? 0); },
      abort: async () => { finish(1); if (options.abortError) throw options.abortError; return { exitCode: 1, stdout: "", stderr: "" }; }
    };
  };
}

function completedProcess(result: { exitCode: number; stdout: string; stderr: string }) {
  return {
    closed: Promise.resolve(result),
    write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 1 }),
    end: async () => result,
    abort: async () => result
  };
}

async function verifiedReadback(input: { range: { frameCount: number }; expected: { timeline: { width: number; height: number; fps: number } } }) {
  return { ok: true as const, readback: { verified: true as const, frameCount: input.range.frameCount, width: input.expected.timeline.width, height: input.expected.timeline.height, fps: input.expected.timeline.fps, durationMs: input.range.frameCount * (1000 / input.expected.timeline.fps) } };
}

function png(width: number, height: number, value: number): Buffer {
  return encodeRgbaPng(width, height, Buffer.from(Array.from({ length: width * height }, () => [value, value + 1, value + 2, 255]).flat()));
}

function testJob(reports: unknown[]): LocalMotionJobContext {
  return { jobId: "segment-spool-test", scratchRoot: resolve(tmpdir()), signal: new AbortController().signal, watchProcess() {}, reportProcessContainment: (evidence) => reports.push(evidence), reportSandbox() {} };
}

function testGovernor() {
  const policy: LocalMotionJobPolicy = { maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 1000, maxWallClockMs: 5000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 1_000_000_000, rssPollIntervalMs: 1000 };
  return new LocalMotionJobGovernor(policy, { leases: null, prepareScratchRoot: async (path) => { await mkdir(path, { recursive: true }); return path; }, freeScratchBytes: async () => 1_000_000_000 });
}

async function siblingStore(fixture: Awaited<ReturnType<typeof newFixture>>): Promise<string> {
  return join(fixture.root, `store-${Math.random().toString(16).slice(2)}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100 && !predicate(); attempts += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  expect(predicate()).toBe(true);
}
