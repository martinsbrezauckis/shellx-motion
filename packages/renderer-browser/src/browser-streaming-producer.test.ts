import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { LocalMotionJobGovernor, describeActiveScriptSources, loadMotionPackage, streamingFrameTimestampMs, type AgentScriptProvenanceAuthority, type MotionPackage } from "@shellx-motion/core";
import {
  createHostBoundBrowserRenderSessionFactory,
  createMotionBrowserRenderSession
} from "./index";
import {
  BrowserStreamingProducerCapabilityError,
  BrowserStreamingProducerCleanupError,
  createBrowserStreamingFrameProducer
} from "./browser-streaming-producer";
import {
  BrowserStreamingInputMutationError,
  emptyStreamingEvidence,
  observeFrameEvidence
} from "./browser-streaming-producer-evidence";

const tempDirs: string[] = [];

describe("browser streamed frame producer", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("streams canonical MotionIR environment/motion-blur PNGs in order without retaining a frame cache", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const materializedDir = await temporaryDirectory("shellx-motion-browser-stream-materialized-");
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-scratch-");
    const expected: Array<{ index: number; atMs: number; sha256: string }> = [];
    const session = await createMotionBrowserRenderSession(pkg);
    try {
      for (let index = 0; index < 3; index += 1) {
        const atMs = streamingFrameTimestampMs(index, pkg.motion.fps, pkg.motion.durationMs);
        const result = await session.renderFrame({
          atMs,
          outDir: materializedDir,
          outputPath: join(materializedDir, `${index}.png`)
        });
        expect(existsSync(result.output.path)).toBe(true);
        expected.push({ index, atMs, sha256: result.output.sha256 });
      }
    } finally {
      await session.close();
    }

    const producer = createBrowserStreamingFrameProducer({ pkg });
    const received: Array<{ index: number; atMs: number; sha256: string }> = [];
    const sandbox: unknown[] = [];
    const watched: number[] = [];
    await producer.produce({
      async write(frame) {
        expect(producer.metrics.activeFrameHandoffs).toBe(1);
        expect(producer.metrics.activePngBuffers).toBe(1);
        received.push({ index: frame.index, atMs: frame.atMs, sha256: sha256(frame.png) });
      }
    }, admittedJob(scratchRoot, sandbox, watched));

    expect(received).toEqual(expected);
    expect(producer.metrics).toMatchObject({
      delivery: "streamed",
      ordering: "canonical-index-timestamp",
      frameCount: 3,
      timelineFrameCount: 3,
      range: { timelineFrameCount: 3, startFrameIndex: 0, endFrameIndexExclusive: 3, frameCount: 3 },
      emittedFrames: 3,
      activeFrameHandoffs: 0,
      peakConcurrentFrameHandoffs: 1,
      activePngBuffers: 0,
      peakPngBuffers: 1,
      retainedFrameCount: 0,
      sourcePngsRetained: 0,
      sessionFrameCacheEntries: 0
    });
    expect(sandbox).toEqual([{
      schema: "shellx-motion/runtime-sandbox@1",
      provider: "chromium",
      status: "disabled",
      scope: "browser-process",
      reasonCode: "playwright_default_no_sandbox"
    }]);
    expect(watched).toHaveLength(1);
    expect(producer.evidence.processMonitoring).toEqual({
      mode: "cooperative-browser-session",
      chromiumPid: "unavailable",
      watchedRoot: "host-node-process",
      rssScope: "host-node-process-tree",
      measurement: "conservative-fallback-not-exact-per-job",
      encoderRssOverlap: "possible",
      encoderContainmentCoversChromium: false,
      reasonCode: "worker_process_unavailable"
    });
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("browser-stream-"))).toEqual([]);
  }, 45_000);

  it("selects first, middle, and final canonical ranges without rendering or emitting prior frames", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-ranges-");
    const cases = [
      { range: { startFrameIndex: 0, endFrameIndexExclusive: 1 }, expectedIndex: 0 },
      { range: { startFrameIndex: 1, endFrameIndexExclusive: 2 }, expectedIndex: 1 },
      { range: { startFrameIndex: 2, endFrameIndexExclusive: 3 }, expectedIndex: 2 }
    ];

    for (const testCase of cases) {
      const producer = createBrowserStreamingFrameProducer({ pkg, range: testCase.range });
      const received: Array<{ index: number; atMs: number }> = [];
      await producer.produce({
        async write(frame) {
          received.push({ index: frame.index, atMs: frame.atMs });
        }
      }, admittedJob(scratchRoot));

      const atMs = streamingFrameTimestampMs(testCase.expectedIndex, pkg.motion.fps, pkg.motion.durationMs);
      // A middle/final range has exactly one render/handoff, so it cannot have rendered a prior
      // canonical frame merely to arrive at its requested point.
      expect(received).toEqual([{ index: testCase.expectedIndex, atMs }]);
      expect(producer).toMatchObject({
        frameCount: 1,
        timelineFrameCount: 3,
        range: { timelineFrameCount: 3, ...testCase.range, frameCount: 1 }
      });
      expect(producer.metrics).toMatchObject({
        emittedFrames: 1,
        peakConcurrentFrameHandoffs: 1,
        peakPngBuffers: 1,
        range: { timelineFrameCount: 3, ...testCase.range, frameCount: 1 }
      });
      expect(producer.evidence).toMatchObject({
        range: { timelineFrameCount: 3, ...testCase.range, frameCount: 1 },
        terminalFrame: { index: testCase.expectedIndex, atMs },
        session: { state: "closed", cleanup: "complete" }
      });
    }
  }, 45_000);

  it("rejects invalid streamed ranges before opening Chromium or allocating producer scratch", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-invalid-range-");
    let launches = 0;
    const launchBrowser = async () => {
      launches += 1;
      throw new Error("must not launch");
    };

    for (const range of [
      { startFrameIndex: -1, endFrameIndexExclusive: 1 },
      { startFrameIndex: 1.5, endFrameIndexExclusive: 2 },
      { startFrameIndex: 2, endFrameIndexExclusive: 2 },
      { startFrameIndex: 0, endFrameIndexExclusive: 4 }
    ]) {
      expect(() => createBrowserStreamingFrameProducer({ pkg, range, launchBrowser })).toThrow(
        /range must be nonempty safe integers/
      );
    }
    expect(launches).toBe(0);
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("browser-stream-"))).toEqual([]);
  });

  it("contains no batch request/result path or new renderer-browser public session API", async () => {
    const [producerSource, indexSource, registrySource] = await Promise.all([
      readFile(new URL("./browser-streaming-producer.ts", import.meta.url), "utf8"),
      readFile(new URL("./index.ts", import.meta.url), "utf8"),
      readFile(new URL("./browser-streaming-session-registry.ts", import.meta.url), "utf8")
    ]);
    expect(producerSource).not.toContain("frameRequests");
    expect(producerSource).not.toContain("renderFrames(");
    expect(producerSource).not.toContain("new Array<");
    expect(indexSource).not.toContain("BrowserAdmitted");
    expect(indexSource).not.toContain("renderFrameUnderAdmission");
    expect(indexSource).not.toContain('frameCache?: "materialized" | "disabled"');
    expect(registrySource).toContain("new WeakSet");
    expect(registrySource).toContain("new WeakMap");
  });

  it("retains bounded warning/input evidence and one path-sanitized terminal frame", async () => {
    const pkg = await warningAndHandoffFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-evidence-");
    const producer = createBrowserStreamingFrameProducer({ pkg });
    await producer.produce({ async write() {} }, admittedJob(scratchRoot));

    expect(producer.evidence.warningUnion).toContain(
      "Browser renderer used a font fallback for text layer title."
    );
    expect(producer.evidence.stableInputHashUnion.motion).toMatch(/^[a-f0-9]{64}$/);
    expect(producer.evidence.terminalFrame).toMatchObject({
      index: 0,
      atMs: 0,
      output: {
        audioHandoff: {
          status: "handled_downstream",
          handledBy: "ffmpeg",
          layers: [{ id: "delivery-audio", type: "audio" }]
        },
        typography: { fallbackLayerIds: ["title"] }
      },
      receipt: {
        operation: "preview.frame",
        lane: "browser"
      }
    });
    expect(producer.evidence.terminalFrame?.output).not.toHaveProperty("path");
    expect(producer.evidence.terminalFrame?.receipt).not.toHaveProperty("output");
    expect(producer.evidence.terminalFrame?.receipt).not.toHaveProperty("warnings");
    expect(producer.evidence.terminalFrame?.receipt).not.toHaveProperty("inputHashes");
    expect(JSON.stringify(producer.evidence.terminalFrame)).not.toContain(scratchRoot);
    expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
  }, 45_000);

  it("streams time-varying browser-layer HTML frames without treating derived html hashes as source mutation", async () => {
    const pkg = await animatedBrowserLayerFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-html-derived-");
    const authorityCalls = { resolves: 0, releases: 0 };
    const producer = createBrowserStreamingFrameProducer({
      pkg,
      sessionFactory: createHostBoundBrowserRenderSessionFactory({ agentScriptAuthority: testAuthority(authorityCalls) })
    });
    const received: string[] = [];

    await producer.produce({
      async write(frame) {
        received.push(sha256(frame.png));
      }
    }, admittedJob(scratchRoot));

    expect(received).toHaveLength(3);
    expect(authorityCalls).toEqual({ resolves: 1, releases: 1 });
    expect(new Set(received).size).toBeGreaterThan(1);
    expect(producer.evidence.stableInputHashUnion).toHaveProperty("motion");
    expect(producer.evidence.stableInputHashUnion).not.toHaveProperty("html");
  }, 45_000);

  it("ignores derived html hashes but refuses a conflicting stable input before a second sink handoff", () => {
    const evidence = emptyStreamingEvidence();
    observeFrameEvidence(evidence, frameEvidenceResult("first", "derived-first"), 0, 0);
    expect(() => observeFrameEvidence(evidence, frameEvidenceResult("first", "derived-second"), 1, 42)).not.toThrow();
    expect(() => observeFrameEvidence(evidence, frameEvidenceResult("second", "derived-third"), 2, 84)).toThrow(
      BrowserStreamingInputMutationError
    );
    expect(evidence.stableInputHashUnion).toEqual({ motion: "first" });
    expect(evidence.stableInputHashConflictKeys).toEqual(["motion"]);
    expect(evidence.stableInputHashKeysOmitted).toBe(0);
    expect(evidence.stableInputHashConflictKeysOmitted).toBe(0);
    expect(evidence.terminalFrame).toMatchObject({ index: 2, atMs: 84 });
  });

  it("uses the already-held job slot when maxConcurrentJobs is one", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-governor-");
    const governor = new LocalMotionJobGovernor({
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 500,
      maxWallClockMs: 30_000,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 6 * 1024 * 1024 * 1024,
      rssPollIntervalMs: 25
    }, { freeScratchBytes: async () => 1_000_000_000 });
    const producer = createBrowserStreamingFrameProducer({ pkg });

    const result = await governor.run({
      lane: "ffmpeg",
      operation: "test.browser.streamed-producer",
      scratchRoot
    }, async (job) => {
      await producer.produce({ async write() {} }, {
        admission: "pre-acquired",
        jobId: job.jobId,
        scratchRoot: job.scratchRoot,
        signal: job.signal,
        watchProcess: (pid) => job.watchProcess(pid),
        reportSandbox: (evidence) => job.reportSandbox(evidence)
      });
      return "completed-under-one-slot";
    });

    expect(result.value).toBe("completed-under-one-slot");
    expect(result.evidence.state).toBe("passed");
    expect(producer.metrics.peakConcurrentFrameHandoffs).toBe(1);
  }, 45_000);

  it("closes the session and releases the ephemeral source buffer on cancellation or sink failure", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const cancellationRoot = await temporaryDirectory("shellx-motion-browser-stream-cancel-");
    const controller = new AbortController();
    const producer = createBrowserStreamingFrameProducer({ pkg });
    const cancellation = new Error("encoder cancelled");

    await expect(producer.produce({
      async write() {
        controller.abort(cancellation);
      }
    }, admittedJob(cancellationRoot, [], [], controller.signal))).rejects.toBe(cancellation);
    expect(producer.metrics.activeFrameHandoffs).toBe(0);
    expect(producer.metrics.activePngBuffers).toBe(0);
    expect((await readdir(cancellationRoot)).filter((entry) => entry.startsWith("browser-stream-"))).toEqual([]);

    const failureRoot = await temporaryDirectory("shellx-motion-browser-stream-sink-failure-");
    const failedProducer = createBrowserStreamingFrameProducer({ pkg });
    await expect(failedProducer.produce({
      async write() {
        throw new Error("encoder stdin closed");
      }
    }, admittedJob(failureRoot))).rejects.toThrow("encoder stdin closed");
    expect(failedProducer.metrics.activeFrameHandoffs).toBe(0);
    expect(failedProducer.metrics.activePngBuffers).toBe(0);
    expect((await readdir(failureRoot)).filter((entry) => entry.startsWith("browser-stream-"))).toEqual([]);
  }, 45_000);

  it("preserves both sink and close failures in bounded cleanup evidence", async () => {
    const pkg = await warningAndHandoffFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-cleanup-failure-");
    const sinkFailure = new Error("encoder stdin closed");
    const closeFailure = new Error("browser close failed");
    const producer = createBrowserStreamingFrameProducer({
      pkg,
      launchBrowser: async (options) => {
        const browser = await chromium.launch(options);
        return new Proxy(browser, {
          get(target, property, receiver) {
            if (property === "close") {
              return async () => {
                await target.close();
                throw closeFailure;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    });

    const error = await producer.produce({
      async write() {
        throw sinkFailure;
      }
    }, admittedJob(scratchRoot)).catch((failure) => failure);
    expect(error).toBeInstanceOf(BrowserStreamingProducerCleanupError);
    expect(error).toMatchObject({ primaryCause: sinkFailure, closeCause: closeFailure });
    expect(producer.evidence.session).toEqual({ state: "cleanup_failed", cleanup: "failed" });
  }, 45_000);

  it("records open failure honestly and resets metrics for a fresh producer attempt", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const openRoot = await temporaryDirectory("shellx-motion-browser-stream-open-failure-");
    const openFailure = new Error("Chromium unavailable");
    const failed = createBrowserStreamingFrameProducer({
      pkg,
      launchBrowser: async () => { throw openFailure; }
    });
    await expect(failed.produce({ async write() {} }, admittedJob(openRoot))).rejects.toBe(openFailure);
    expect(failed.evidence.session).toEqual({ state: "open_failed", cleanup: "complete" });

    const retryRoot = await temporaryDirectory("shellx-motion-browser-stream-retry-");
    const producer = createBrowserStreamingFrameProducer({ pkg });
    await producer.produce({ async write() {} }, admittedJob(retryRoot));
    expect(producer.metrics.emittedFrames).toBe(3);
    await producer.produce({ async write() {} }, admittedJob(retryRoot));
    expect(producer.metrics.emittedFrames).toBe(3);
    expect(producer.metrics.peakConcurrentFrameHandoffs).toBe(1);
  }, 45_000);

  it("isolates concurrent admitted producers that share one logical job id", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    const scratchRoot = await temporaryDirectory("shellx-motion-browser-stream-duplicate-job-");
    const first = createBrowserStreamingFrameProducer({ pkg });
    const second = createBrowserStreamingFrameProducer({ pkg });
    let started = 0;
    let reportBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolveStarted) => { reportBothStarted = resolveStarted; });
    let releaseSinks: (() => void) | undefined;
    const sinksReleased = new Promise<void>((resolveRelease) => { releaseSinks = resolveRelease; });
    const sink = async () => {
      started += 1;
      if (started === 2) reportBothStarted?.();
      await sinksReleased;
    };

    const firstRun = first.produce({ write: sink }, admittedJob(scratchRoot));
    const secondRun = second.produce({ write: sink }, admittedJob(scratchRoot));
    await bothStarted;
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("browser-stream-")).length).toBe(2);
    releaseSinks?.();
    await Promise.all([firstRun, secondRun]);
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("browser-stream-"))).toEqual([]);
  }, 45_000);

  it("refuses captured browser workflows rather than silently changing their state semantics", async () => {
    const pkg = await compactEnvironmentMotionBlurFixture();
    expect(() => createBrowserStreamingFrameProducer({
      pkg,
      workflow: { schema: "shellx-motion/browser-workflow@1", steps: [{ action: "click", selector: "#buy" }] }
    })).toThrow(BrowserStreamingProducerCapabilityError);
  });
});

async function compactEnvironmentMotionBlurFixture(): Promise<MotionPackage> {
  const pkg = await loadMotionPackage(resolve("../../fixtures/packages/environment-rain-cinematic"));
  const compact = structuredClone(pkg);
  compact.motion.durationMs = 100;
  compact.motion.width = 320;
  compact.motion.height = 180;
  for (const layer of compact.motion.layers) {
    if (layer.transform && "width" in layer.transform && "height" in layer.transform) {
      layer.transform.width = 320;
      layer.transform.height = 180;
    }
  }
  return compact;
}

async function warningAndHandoffFixture(): Promise<MotionPackage> {
  const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
  const compact = structuredClone(pkg);
  compact.motion.durationMs = 1;
  compact.motion.width = 320;
  compact.motion.height = 180;
  const title = compact.motion.layers.find((layer) => layer.id === "title");
  if (!title || title.type !== "text") throw new Error("Lower-third fixture is missing its text title.");
  title.transform = { x: 20, y: 40, width: 280, height: 64 };
  title.style = {
    ...title.style,
    fontFamily: "ShellXDefinitelyMissingArabicFont, sans-serif"
  };
  compact.motion.layers.push({
    id: "delivery-audio",
    type: "audio",
    startMs: 0,
    durationMs: 1,
    source: "audio/delivery.mp3"
  });
  return compact;
}

async function animatedBrowserLayerFixture(): Promise<MotionPackage> {
  const root = await temporaryDirectory("shellx-motion-browser-stream-animated-html-");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_streaming_animated_html",
    name: "Streaming animated HTML",
    motion: "motion.json",
    assets: ["card.html"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_streaming_animated_html",
    name: "Streaming animated HTML",
    durationMs: 100,
    fps: 30,
    width: 320,
    height: 180,
    background: "#ffffff",
    layers: [{ id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 100, allowedOrigins: [] }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  await writeFile(join(root, "card.html"), `<!doctype html>
<html><head><style>
main { position: absolute; top: 52px; font: 700 44px sans-serif; color: #075985; }
html[data-shellx-motion-time="0"] main { left: 12px; color: #075985; }
html[data-shellx-motion-time="33"] main { left: 88px; color: #b45309; }
html[data-shellx-motion-time="67"] main { left: 164px; color: #9f1239; }
</style></head><body data-composition-id="streaming-animated" data-start="0" data-duration="100">
<main data-layer-id="title" data-start="0" data-duration="100">Motion</main>
</body></html>\n`);
  return loadMotionPackage(root);
}

function admittedJob(
  scratchRoot: string,
  sandbox: unknown[] = [],
  watched: number[] = [],
  signal: AbortSignal = new AbortController().signal
) {
  return {
    admission: "pre-acquired" as const,
    jobId: "browser-streaming-producer-test",
    scratchRoot,
    signal,
    watchProcess: (pid: number) => watched.push(pid),
    reportSandbox: (evidence: unknown) => sandbox.push(evidence)
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function frameEvidenceResult(motionHash: string, htmlHash: string) {
  const scriptExecution = {
    schema: "shellx-motion/script-execution@1" as const,
    detectedClass: "data-only" as const,
    requestedMode: "none" as const,
    activeMode: "data-only" as const,
    resolverVersion: 1,
    sources: []
  };
  return {
    ok: true as const,
    output: {
      path: "/private/frame.png",
      sha256: "f".repeat(64),
      format: "png" as const,
      width: 320,
      height: 180,
      atMs: 0,
      browser: { name: "chromium", version: "test" },
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      scriptExecution
    },
    receipt: {
      schema: "shellx-motion/receipt@1" as const,
      id: "browser-test",
      operation: "preview.frame",
      status: "passed" as const,
      packageId: "pkg_test",
      inputHashes: { motion: motionHash, html: htmlHash },
      createdAt: "2026-08-08T00:00:00.000Z",
      lane: "browser",
      output: { scriptExecution },
      warnings: []
    }
  };
}

function testAuthority(calls?: { resolves: number; releases: number }): AgentScriptProvenanceAuthority {
  return {
    resolverVersion: 1,
    mint: async () => { throw new Error("not used"); },
    resolve: async (pkg) => {
      if (calls) calls.resolves += 1;
      return {
        package: pkg,
        evidence: {
          schema: "shellx-motion/script-execution@1", detectedClass: "active-content",
          requestedMode: "trusted-local-agent-authored", activeMode: "trusted-local-agent-authored",
          resolverVersion: 1, packageSnapshotSha256: "a".repeat(64), attestationId: "test-attestation", sources: await describeActiveScriptSources(pkg)
        },
        release: async () => { if (calls) calls.releases += 1; }
      };
    },
    revoke: async () => undefined,
    writeReceipt: async () => "/private/receipt.json"
  };
}
