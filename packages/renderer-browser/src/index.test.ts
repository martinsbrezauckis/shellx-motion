import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { comparePngBuffers, inspectPngBuffer, inspectPngRegionBuffer, LocalMotionJobGovernor, loadMotionPackage, lowerStaticLottieToMotion, lowerStaticSvgToMotion, matchRendererCapability, type LocalMotionJobPolicy, type MotionDocument } from "@shellx-motion/core";
import {
  BROWSER_CAPABILITY,
  browserExecutableCandidates,
  captureDeterministicScreenshot,
  classifyBrowserFrameFailure,
  createHostBoundBrowserFrameRenderer,
  createMotionBrowserRenderSession as createMotionBrowserRenderSessionUnbound,
  chromiumRuntimeSandboxEvidence,
  hashBrowserCaptureWorkflow,
  loadHtmlComposition,
  preflightBrowserPackage,
  BrowserFrameCancelledError,
  BrowserFrameTimeoutError,
  BrowserWorkflowReplayError,
  resolveBrowserFrameTimeoutMs,
  resolveChromiumLaunchArgs,
  videoMediaTimeMsForLayer
} from "./index";
import { makeRgbaPngFixture } from "./test-support/png-fixture";
import { TEST_APPROVED_AGENT_SCRIPT_AUTHORITY } from "./test-support/approved-agent-script-authority";
// Generated text-layer fixture builders split out for the module-size gate.
import {
  writeGeneratedTextAlignmentKeyframePackage,
  writeGeneratedTextAlignPackage,
  writeGeneratedTextBackgroundPackage,
  writeGeneratedTextBorderPackage,
  writeGeneratedTextBoxPackage,
  writeGeneratedTextLetterSpacingPackage,
  writeGeneratedTextPaddingPackage,
  writeGeneratedTextVerticalAlignPackage
} from "./index.fixtures-text";

const tempDirs: string[] = [];
let implicitOutputSequence = 0;
const execFileAsync = promisify(execFile);
const HTML_TYPOGRAPHY_WARNING = "Browser HTML/web/canvas typography is unverified: font provenance and fallback coverage are not attestable.";
const TEXT_RUNS_HOST_FIXTURE = process.env.MOTION_BROWSER_TEXT_RUNS_HOST_FIXTURE === "1";
const hostBoundBrowserFrameRenderer = createHostBoundBrowserFrameRenderer({ agentScriptAuthority: TEST_APPROVED_AGENT_SCRIPT_AUTHORITY });

function createMotionBrowserRenderSession(
  pkg: Parameters<typeof createMotionBrowserRenderSessionUnbound>[0],
  options: Parameters<typeof createMotionBrowserRenderSessionUnbound>[1] = {},
) {
  return createMotionBrowserRenderSessionUnbound(pkg, { ...options, agentScriptAuthority: TEST_APPROVED_AGENT_SCRIPT_AUTHORITY });
}

function renderBrowserFrame(pkg: Parameters<typeof hostBoundBrowserFrameRenderer>[0], options: Parameters<typeof hostBoundBrowserFrameRenderer>[1]) {
  return hostBoundBrowserFrameRenderer(pkg, withUniqueImplicitTestOutput(options));
}

function renderMotionBrowserFrame(pkg: Parameters<typeof hostBoundBrowserFrameRenderer>[0], options: Parameters<typeof hostBoundBrowserFrameRenderer>[1]) {
  return hostBoundBrowserFrameRenderer(pkg, withUniqueImplicitTestOutput(options));
}

// The production default pathname deliberately stays stable. Tests that compare several frames
// from the same package instead ask the no-clobber public API for distinct caller-owned targets.
function withUniqueImplicitTestOutput<T extends { outDir: string; outputPath?: string; format?: "png" | "jpeg" }>(options: T): T {
  if (options.outputPath) return options;
  const extension = options.format === "jpeg" ? "jpg" : "png";
  return { ...options, outputPath: join(options.outDir, `test-frame-${++implicitOutputSequence}.${extension}`) };
}

describe("browser renderer lane", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("preflights a local web layer and blocks undeclared network origins", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));

    const result = await preflightBrowserPackage(pkg);

    expect(result).toEqual({
      ok: true,
      htmlEntries: ["card.html"],
      blockedOrigins: [],
      warnings: []
    });
  });

  it("records unverified typography for browser HTML without inferring whether its code draws text", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-html-typography-"));
    tempDirs.push(outDir);

    const result = await renderBrowserFrame(pkg, { atMs: 0, outDir });

    expect(result.output.typography).toEqual({
      schema: "shellx-motion/browser-typography@1",
      authority: "chromium",
      attestation: "unverified",
      fontProbe: "canvas-metric",
      scopes: [{
        kind: "html-web-canvas",
        attestation: "unverified",
        layerIds: ["web-card"],
        reason: "arbitrary_html_web_canvas_text_unobservable"
      }],
      layers: [],
      fontAssets: [],
      fallbackLayerIds: []
    });
    expect(result.receipt).toMatchObject({
      status: "warning",
      warnings: [HTML_TYPOGRAPHY_WARNING]
    });
  }, 45_000);

  it("rejects browser frame output paths outside the requested output directory", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-output-root-"));
    tempDirs.push(outDir);

    await expect(
      renderMotionBrowserFrame(pkg, {
        atMs: 0,
        outDir,
        outputPath: join(outDir, "..", "escaped.png")
      })
    ).rejects.toThrow(/Browser output path must be inside outDir/);
  });

  it("does not clobber an existing direct browser frame output", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-existing-output-"));
    const outputPath = join(outDir, "existing-frame.png");
    tempDirs.push(outDir);
    await writeFile(outputPath, "caller-owned-frame", "utf8");

    await expect(renderBrowserFrame(pkg, { atMs: 0, outDir, outputPath })).rejects.toMatchObject({
      code: "derived_output_exists"
    });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("caller-owned-frame");
  }, 45_000);

  it("fails closed before launching the browser when a layer type is unsupported", async () => {
    // A1 runtime gate: the browser lane now calls matchRendererCapability at render entry (like the
    // native lane). A genuinely-unsupported layer type must be rejected deterministically instead of
    // silently rendering a frame that drops the layer.
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    const withUnsupported = {
      ...pkg,
      motion: {
        ...pkg.motion,
        layers: [
          ...pkg.motion.layers,
          { id: "unsupported-group", type: "group", startMs: 0, durationMs: 1000 }
        ]
      }
    };

    await expect(createMotionBrowserRenderSession(withUnsupported)).rejects.toThrow(
      /Browser lane cannot render .* does not support group layers/
    );
  });

  it("tolerates audio layers at the capability gate (audio is muxed by the final ffmpeg lane)", async () => {
    // The browser lane is the frame lane feeding ffmpeg; an audio layer is not a blocking failure.
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    const withAudio = {
      ...pkg,
      motion: {
        ...pkg.motion,
        layers: [
          ...pkg.motion.layers,
          { id: "score", type: "audio", startMs: 0, durationMs: 1000, source: "audio/score.mp3" }
        ]
      }
    };
    // The gate must not reject; the session opens (and is immediately closed) without a capability error.
    const session = await createMotionBrowserRenderSession(withAudio);
    await session.close();
  });

  it("extracts HyperFrames-style timing metadata from data attributes", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/hyperframes-card"));

    const composition = await loadHtmlComposition(pkg);

    expect(composition).toEqual({
      compositionId: "hyper-card",
      source: "index.html",
      sourceLayerId: "html-composition",
      startMs: 0,
      durationMs: 3000,
      layers: [{ id: "title", startMs: 250, durationMs: 2200 }]
    });
  });

  it("extracts HTML timing metadata from reordered and single-quoted data attributes", async () => {
    const packageRoot = await writeBrowserPackage("HTML Attrs");
    tempDirs.push(packageRoot);
    await writeFile(join(packageRoot, "card.html"), [
      "<!doctype html><html>",
      "<body data-duration='2400' data-composition-id='html-attrs' data-start='100'>",
      "<section data-duration='900' class='hero' data-layer-id='headline' data-start='250'></section>",
      "<section data-start=\"1200\" data-duration=\"600\" data-layer-id=\"cta\"></section>",
      "</body></html>"
    ].join(""), "utf8");
    const pkg = await loadMotionPackage(packageRoot);

    const composition = await loadHtmlComposition(pkg);

    expect(composition).toMatchObject({
      compositionId: "html-attrs",
      startMs: 100,
      durationMs: 2400,
      layers: [
        { id: "headline", startMs: 250, durationMs: 900 },
        { id: "cta", startMs: 1200, durationMs: 600 }
      ]
    });
  });

  it("receipts Playwright's default Chromium sandbox opt-out distinctly from an explicit host opt-out", () => {
    expect(resolveChromiumLaunchArgs({})).toEqual(["--disable-gpu"]);
    expect(resolveChromiumLaunchArgs({ SHELLX_MOTION_CHROMIUM_NO_SANDBOX: "1" })).toEqual(["--disable-gpu", "--no-sandbox"]);
    expect(resolveChromiumLaunchArgs({ SHELLX_MOTION_CHROMIUM_NO_SANDBOX: "true" })).toEqual(["--disable-gpu", "--no-sandbox"]);
    expect(chromiumRuntimeSandboxEvidence(resolveChromiumLaunchArgs({}))).toEqual({
      schema: "shellx-motion/runtime-sandbox@1",
      provider: "chromium",
      status: "disabled",
      scope: "browser-process",
      reasonCode: "playwright_default_no_sandbox",
    });
    expect(chromiumRuntimeSandboxEvidence(resolveChromiumLaunchArgs({}), true)).toEqual({
      schema: "shellx-motion/runtime-sandbox@1",
      provider: "chromium",
      status: "requested",
      scope: "browser-process",
    });
    expect(chromiumRuntimeSandboxEvidence(resolveChromiumLaunchArgs({ SHELLX_MOTION_CHROMIUM_NO_SANDBOX: "yes" }))).toEqual({
      schema: "shellx-motion/runtime-sandbox@1",
      provider: "chromium",
      status: "disabled",
      scope: "browser-process",
      reasonCode: "trusted_host_opt_out",
    });
  });

  it("rejects oversized Chromium viewports before launching a browser", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.width = 100_000;
    pkg.motion.height = 100_000;
    let launched = false;

    await expect(createMotionBrowserRenderSession(pkg, {
      launchBrowser: async () => {
        launched = true;
        throw new Error("must not launch");
      },
    })).rejects.toMatchObject({ code: "job_input_budget_exceeded" });
    expect(launched).toBe(false);
  });

  it("captures a deterministic browser frame artifact and receipt", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-"));
    tempDirs.push(outDir);

    const result = await renderBrowserFrame(pkg, { atMs: 500, outDir, now: () => "2026-07-01T20:15:00.000Z" });
    const bytes = await readFile(result.output.path);

    expect(result.ok).toBe(true);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "warning",
      warnings: [HTML_TYPOGRAPHY_WARNING],
      packageId: "pkg_web_card",
      lane: "browser",
      createdAt: "2026-07-01T20:15:00.000Z",
      output: {
        width: 1280,
        height: 720,
        atMs: 500,
        browser: { name: "chromium", version: expect.not.stringMatching(/^0$/) },
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        captureReadiness: {
          schema: "shellx-motion/browser-capture-readiness@1",
          page: "loaded",
          stylesheets: "settled",
          fonts: expect.stringMatching(/^(ready|unsupported)$/),
          animationPolicy: "screenshot-disabled",
          media: "settled-after-time-seek",
          waitMs: expect.any(Number)
        },
        resources: {
          schema: "shellx-motion/local-job-resources@1",
          lane: "browser",
          operation: "browser.preview.frame",
          state: "passed",
          watchedProcessCount: 1,
          peakProcessTreeRssBytes: expect.any(Number),
          processContainment: {
            schema: "shellx-motion/process-containment@1",
            mode: "cooperative-browser-session",
            status: "fallback",
            killTree: false,
            memoryLimit: "rss-monitor",
            reasonCode: "worker_process_unavailable",
          },
          sandbox: {
            schema: "shellx-motion/runtime-sandbox@1",
            provider: "chromium",
            status: "disabled",
            scope: "browser-process",
            reasonCode: "playwright_default_no_sandbox",
          },
        }
      }
    });
  });

  it("reuses one Chromium process across a render session", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-session-"));
    tempDirs.push(outDir);
    let launchCount = 0;
    const session = await createMotionBrowserRenderSession(pkg, {
      launchBrowser: async (options) => {
        launchCount += 1;
        return chromium.launch(options);
      }
    });
    try {
      const first = await session.renderFrame({
        atMs: 500,
        outDir,
        outputPath: join(outDir, "first.png")
      });
      const second = await session.renderFrame({
        atMs: 500,
        outDir,
        outputPath: join(outDir, "second.png")
      });

      expect(first.output.sha256).toBe(second.output.sha256);
      expect(first.output.renderSession).toEqual({
        browserLaunches: 1,
        framesRendered: 1,
        contextsCreated: 1,
        pagesCreated: 1,
        activeFrames: 0,
        peakConcurrentFrames: 1,
        frameCacheHits: 0,
        frameRetries: 0
      });
      expect(second.output.renderSession).toEqual({
        browserLaunches: 1,
        framesRendered: 2,
        contextsCreated: 1,
        pagesCreated: 1,
        activeFrames: 0,
        peakConcurrentFrames: 1,
        frameCacheHits: 1,
        frameRetries: 0
      });
      expect(session.metrics).toEqual({
        browserLaunches: 1,
        framesRendered: 2,
        contextsCreated: 1,
        pagesCreated: 1,
        activeFrames: 0,
        peakConcurrentFrames: 1,
        frameCacheHits: 1,
        frameRetries: 0
      });
      expect(launchCount).toBe(1);
    } finally {
      await session.close();
    }
    await expect(session.renderFrame({ atMs: 0, outDir })).rejects.toThrow("session is closed");
  });

  it("refuses a cached frame after package source bytes change", async () => {
    const packageRoot = await writeBrowserPackage("Cache mutation");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-cache-mutation-"));
    tempDirs.push(packageRoot, outDir);
    const pkg = await loadMotionPackage(packageRoot);
    const session = await createMotionBrowserRenderSession(pkg);
    try {
      await session.renderFrame({ atMs: 0, outDir, outputPath: join(outDir, "first.png") });
      await writeFile(join(packageRoot, "card.html"), "<!doctype html><title>changed</title>");
      await expect(session.renderFrame({
        atMs: 0,
        outDir,
        outputPath: join(outDir, "cached.png")
      })).rejects.toThrow("package changed during the active session");
    } finally {
      await session.close();
    }
  });

  it("schedules frame batches with bounded concurrency and ordered results", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-batch-"));
    tempDirs.push(outDir);
    const progress: number[] = [];
    const session = await createMotionBrowserRenderSession(pkg);
    try {
      const frames = await session.renderFrames(
        [0, 250, 500, 750].map((atMs, index) => ({
          atMs,
          outDir,
          outputPath: join(outDir, `${index}.png`)
        })),
        {
          maxConcurrency: 2,
          onProgress: ({ completed }) => progress.push(completed)
        }
      );

      expect(frames.map((frame) => frame.output.atMs)).toEqual([0, 250, 500, 750]);
      expect(new Set(frames.map((frame) => frame.output.resources?.jobId)).size).toBe(1);
      expect(frames[0].output.resources).toMatchObject({ operation: "browser.preview.frames", state: "passed" });
      expect(progress).toEqual([1, 2, 3, 4]);
      expect(session.metrics).toEqual({
        browserLaunches: 1,
        framesRendered: 4,
        contextsCreated: 2,
        pagesCreated: 2,
        activeFrames: 0,
        peakConcurrentFrames: 2,
        frameCacheHits: 0,
        frameRetries: 0
      });
      expect(frames.at(-1)?.output.renderSession).toEqual(session.metrics);
    } finally {
      await session.close();
    }
  });

  it("cancels an in-flight frame batch and closes active contexts", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-cancel-"));
    tempDirs.push(outDir);
    const controller = new AbortController();
    const session = await createMotionBrowserRenderSession(pkg);
    const cancel = setTimeout(() => controller.abort(new BrowserFrameCancelledError()), 50);
    try {
      await expect(session.renderFrames(
        [0, 250].map((atMs, index) => ({
          atMs,
          outDir,
          outputPath: join(outDir, `${index}.png`),
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            steps: [{ action: "wait", ms: 1_000 }]
          }
        })),
        { maxConcurrency: 2, signal: controller.signal }
      )).rejects.toBeInstanceOf(BrowserFrameCancelledError);
    } finally {
      clearTimeout(cancel);
      await session.close();
    }
    expect(session.metrics.activeFrames).toBe(0);
    expect(session.metrics.framesRendered).toBe(0);
  });

  it("fails a stalled frame with a bounded timeout", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-timeout-"));
    tempDirs.push(outDir);
    const session = await createMotionBrowserRenderSession(pkg);
    try {
      await expect(session.renderFrames([{
        atMs: 0,
        outDir,
        workflow: {
          schema: "shellx-motion/browser-workflow@1",
          steps: [{ action: "wait", ms: 1_000 }]
        }
      }], { perFrameTimeoutMs: 100 })).rejects.toMatchObject({
        code: "browser_frame_timeout",
        timeoutMs: 100
      });
    } finally {
      await session.close();
    }
  });

  it("derives each default batch-frame deadline from declared pixels while retaining a hard cap", () => {
    // Control: a compact preview retains the historic 30s base plus its exact pixel allowance.
    expect(resolveBrowserFrameTimeoutMs({ width: 1_280, height: 720 })).toBe(43_824);
    // The 1080p product-pack proof workload receives 30s plus 15s per declared output megapixel.
    expect(resolveBrowserFrameTimeoutMs({ width: 1_920, height: 1_080 })).toBe(61_104);
    // Device scale is part of the declared raster work, and even adversarially large input is
    // bounded by the source policy rather than permitting an unbounded wait.
    expect(resolveBrowserFrameTimeoutMs({ width: 7_680, height: 4_320, deviceScaleFactor: 4 })).toBe(120_000);
    // A caller can still demand a deliberately stricter bounded control timeout.
    expect(resolveBrowserFrameTimeoutMs({ width: 1_920, height: 1_080 }, 100)).toBe(100);
    expect(() => resolveBrowserFrameTimeoutMs({ width: 1_920, height: 1_080 }, 120_001))
      .toThrow("Browser per-frame timeout must be an integer from 100 to 120000ms.");
  });

  it("closes Chromium when a single-frame render exceeds the shared governor deadline", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-governor-"));
    tempDirs.push(outDir);
    const policy: LocalMotionJobPolicy = {
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 1_000,
      maxWallClockMs: 100,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 6 * 1024 * 1024 * 1024,
      rssPollIntervalMs: 25,
    };
    const session = await createMotionBrowserRenderSession(pkg, {
      governor: new LocalMotionJobGovernor(policy, { freeScratchBytes: async () => 1_000_000_000 }),
    });
    try {
      await expect(session.renderFrame({
        atMs: 0,
        outDir,
        workflow: {
          schema: "shellx-motion/browser-workflow@1",
          steps: [{ action: "wait", ms: 5_000 }],
        },
      })).rejects.toMatchObject({
        code: "job_deadline_exceeded",
        evidence: {
          lane: "browser",
          state: "deadline_exceeded",
          processContainment: {
            mode: "cooperative-browser-session",
            status: "fallback",
            killTree: false,
            reasonCode: "worker_process_unavailable",
          },
        },
      });
    } finally {
      await session.close();
    }
    expect(session.metrics.framesRendered).toBe(0);
  });

  it("classifies retryable browser crashes separately from terminal failures", () => {
    expect(classifyBrowserFrameFailure(new BrowserFrameCancelledError())).toBe("cancelled");
    expect(classifyBrowserFrameFailure(new BrowserFrameTimeoutError(500))).toBe("timeout");
    expect(classifyBrowserFrameFailure(new Error("Target page crashed"))).toBe("transient");
    expect(classifyBrowserFrameFailure(new Error("invalid package geometry"))).toBe("deterministic");
  });

  it("retries one classified transient whole-frame failure", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-retry-"));
    tempDirs.push(outDir);
    let contextAttempts = 0;
    const session = await createMotionBrowserRenderSession(pkg, {
      launchBrowser: async (options) => {
        const browser = await chromium.launch(options);
        return new Proxy(browser, {
          get(target, property, receiver) {
            if (property === "newContext") {
              return async (...args: Parameters<typeof browser.newContext>) => {
                contextAttempts += 1;
                if (contextAttempts === 1) throw new Error("Target page crashed");
                return browser.newContext(...args);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    });
    try {
      const [frame] = await session.renderFrames([{ atMs: 0, outDir }]);
      expect(frame.ok).toBe(true);
      expect(contextAttempts).toBe(2);
      expect(session.metrics.frameRetries).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("records browser capture readiness diagnostics for stylesheet and finite CSS animation probes", async () => {
    const root = await writeBrowserReadinessPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-readiness-"));
    tempDirs.push(root, outDir);

    const result = await renderBrowserFrame(pkg, { atMs: 300, outDir });

    expect(result.receipt.output).toMatchObject({
      captureReadiness: {
        schema: "shellx-motion/browser-capture-readiness@1",
        page: "loaded",
        stylesheets: "settled",
        fonts: expect.stringMatching(/^(ready|unsupported)$/),
        animationPolicy: "screenshot-disabled",
        diagnostics: {
          stylesheetLinkCount: 1,
          finiteAnimationCount: 1,
          finiteAnimationMaxMs: 1200,
          finiteTransitionCount: 1,
          finiteTransitionMaxMs: 650
        }
      }
    });
  });

  it("renders the keyframed lower-third fixture with a nonblank first frame", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/keyframed-lower-third"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-keyframed-lower-third-"));
    tempDirs.push(outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(result.receipt.output).toMatchObject({
      captureReadiness: {
        schema: "shellx-motion/browser-capture-readiness@1",
        page: "loaded",
        stylesheets: "settled",
        fonts: expect.stringMatching(/^(ready|unsupported)$/),
        animationPolicy: "screenshot-disabled",
        media: "settled-after-time-seek",
        waitMs: expect.any(Number)
      }
    });
    expect(quality.blank).toBe(false);
    expect(quality.luma.brightPixels).toBeGreaterThan(500);
    expect(quality.edges.pixels).toBeGreaterThan(1000);
  });

  it("refuses secondary package compositions for an approved active entry before Chromium loads it", async () => {
    const root = await writeMultiCompositionBrowserPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-multi-composition-"));
    tempDirs.push(root, outDir);

    await expect(renderBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-05T00:00:00.000Z" }))
      .rejects.toThrow("Approved-agent-entry script sources cannot inline secondary package compositions.");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("blocks browser file requests outside the Motion package root", async () => {
    const root = await writeBrowserPackageWithExternalFileRequest();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-external-file-"));
    tempDirs.push(root, outDir);

    const result = await renderBrowserFrame(pkg, { atMs: 0, outDir });

    expect(result.ok).toBe(true);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "warning",
      lane: "browser",
      warnings: expect.arrayContaining(["Blocked external browser file request."])
    });
  });

  it("blocks browser WebSocket egress and records only the attempted authority", async () => {
    const root = await writeBrowserPackage("WebSocket policy");
    await writeFile(
      join(root, "card.html"),
      `<!doctype html><html><body data-composition-id="websocket-policy" data-start="0" data-duration="1000"><main id="peer-status">pending</main><script>document.querySelector("#peer-status").textContent = typeof RTCPeerConnection; new WebSocket("ws://127.0.0.1:9/private?pin=0000")</script></body></html>\n`
    );
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-websocket-"));
    tempDirs.push(root, outDir);

    const result = await renderBrowserFrame(pkg, {
      atMs: 0,
      outDir,
      workflow: {
        schema: "shellx-motion/browser-workflow@1",
        steps: [{ action: "verify", selector: "#peer-status", text: "undefined" }]
      }
    });

    expect(result.receipt.status).toBe("warning");
    const receiptWarnings = result.receipt.warnings.join("\n");
    expect(receiptWarnings).toContain("Blocked browser WebSocket request: ws://127.0.0.1:9");
    expect(receiptWarnings).not.toContain("/private");
    expect(receiptWarnings).not.toContain("?pin=0000");
    expect(receiptWarnings).not.toContain("#fragment");
  });

  it("allows runtime browser requests declared by any browser layer", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#22c55e"/></svg>`);
    });
    const origin = await listen(server);
    const root = await writeMultiLayerRuntimeRequestPackage(origin);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-layer-origin-"));
    tempDirs.push(root, outDir);

    try {
      const result = await renderBrowserFrame(pkg, {
        atMs: 0,
        outDir,
        networkAccess: {
          approvedOrigins: [origin],
          allowPrivateNetwork: true
        }
      });

      expect(result.ok).toBe(true);
      expect(result.receipt.status).toBe("warning");
      expect(result.receipt.warnings).toEqual([HTML_TYPOGRAPHY_WARNING]);
      expect(result.receipt.warnings).not.toContain(`Blocked undeclared browser request: ${origin}`);
      expect(result.output.network).toEqual({
        policy: "host-approved-origins",
        allowPrivateNetwork: true,
        resolutionTimeoutMs: 5000,
        approvedOrigins: [origin],
        pins: [{ hostname: "127.0.0.1", address: "127.0.0.1", family: 4 }],
        responsePolicy: {
          maxResponseBytes: 64 * 1024 * 1024,
          maxAggregateBytes: 256 * 1024 * 1024,
          maxConcurrentResponses: 8,
          contentTypes: "bounded-render-media"
        }
      });
      expect(result.receipt.output).toMatchObject({ network: result.output.network });
    } finally {
      await closeServer(server);
    }
  });

  it("changes the frame hash when HTML content changes", async () => {
    const firstRoot = await writeBrowserPackage("First title");
    const secondRoot = await writeBrowserPackage("Second title");
    const first = await loadMotionPackage(firstRoot);
    const second = await loadMotionPackage(secondRoot);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-diff-"));
    tempDirs.push(firstRoot, secondRoot, outDir);

    const firstFrame = await renderBrowserFrame(first, { atMs: 0, outDir });
    const secondFrame = await renderBrowserFrame(second, { atMs: 0, outDir });

    expect(firstFrame.output.sha256).not.toBe(secondFrame.output.sha256);
  });

  it("replays deterministic browser workflow steps before capture", async () => {
    const root = await writeInteractiveBrowserPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-workflow-"));
    tempDirs.push(root, outDir);

    const before = await renderBrowserFrame(pkg, { atMs: 0, outDir });
    const after = await renderBrowserFrame(pkg, {
      atMs: 0,
      outDir,
      workflow: {
        schema: "shellx-motion/browser-workflow@1",
        viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
        networkPolicy: "blocked-unless-declared",
        steps: [
          { action: "click", selector: "#swap" },
          { action: "verify", selector: "#state", text: "Clicked" }
        ],
        cursor: { visible: true, path: [{ x: 120, y: 96, atMs: 0 }] }
      }
    });

    expect(before.output.sha256).not.toBe(after.output.sha256);
    expect(after.receipt).toMatchObject({
      inputHashes: {
        workflow: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      output: {
        workflow: {
          schema: "shellx-motion/browser-workflow@1",
          networkPolicy: "blocked-unless-declared",
          stepCount: 2,
          steps: [
            { action: "click", selector: "#swap" },
            { action: "verify", selector: "#state", hasText: true }
          ],
          cursor: { visible: true, pointCount: 1 }
        },
        workflowTrace: {
          schema: "shellx-motion/browser-workflow-trace@1",
          workflowHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          stepCount: 2,
          steps: [
            { index: 0, action: { action: "click", selector: "#swap" }, status: "passed" },
            { index: 1, action: { action: "verify", selector: "#state", hasText: true }, status: "passed" }
          ],
          cursor: { visible: true, pointCount: 1 },
          captureReadiness: {
            schema: "shellx-motion/browser-capture-readiness@1",
            page: "loaded",
            stylesheets: "settled",
            fonts: expect.stringMatching(/^(ready|unsupported)$/),
            animationPolicy: "screenshot-disabled",
            media: "settled-after-time-seek",
            waitMs: expect.any(Number)
          }
        }
      }
    });
    expect(JSON.stringify(after.receipt.output)).not.toContain("Clicked");
  });

  it("hashes equivalent browser workflow JSON canonically", () => {
    const explicit = hashBrowserCaptureWorkflow({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      viewport: { height: 360, deviceScaleFactor: 1, width: 640 },
      steps: [
        { selector: "#prompt", text: "launch", action: "type" },
        { y: 0, action: "scroll" }
      ],
      cursor: { path: [{ y: 20, atMs: 0, x: 10 }], visible: true }
    });
    const equivalent = hashBrowserCaptureWorkflow({
      schema: "shellx-motion/browser-workflow@1",
      viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
      steps: [
        { action: "type", selector: "#prompt", text: "launch" },
        { action: "scroll", x: 0, y: 0 }
      ],
      cursor: { visible: true, path: [{ x: 10, y: 20, atMs: 0 }] }
    });
    const different = hashBrowserCaptureWorkflow({
      schema: "shellx-motion/browser-workflow@1",
      viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
      steps: [
        { action: "type", selector: "#prompt", text: "different" },
        { action: "scroll", x: 0, y: 0 }
      ],
      cursor: { visible: true, path: [{ x: 10, y: 20, atMs: 0 }] }
    });

    expect(explicit).toMatch(/^[a-f0-9]{64}$/);
    expect(explicit).toBe(equivalent);
    expect(different).not.toBe(equivalent);
  });

  it("throws a redacted failed workflow trace when replay verification fails", async () => {
    const root = await writeInteractiveBrowserPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-workflow-failure-"));
    tempDirs.push(root, outDir);

    let error: unknown;
    try {
      await renderBrowserFrame(pkg, {
        atMs: 0,
        outDir,
        workflow: {
          schema: "shellx-motion/browser-workflow@1",
          steps: [
            { action: "click", selector: "#swap" },
            { action: "verify", selector: "#state", text: "Super secret expected text" }
          ]
        }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BrowserWorkflowReplayError);
    if (!(error instanceof BrowserWorkflowReplayError)) return;
    expect(error).toMatchObject({
      code: "browser_workflow_replay_failed",
      failedStep: {
        index: 1,
        action: { action: "verify", selector: "#state", hasText: true },
        status: "failed",
        error: {
          code: "text_mismatch",
          selector: "#state",
          expectedTextLength: 26,
          actualTextLength: 7,
          actualTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      },
      trace: {
        schema: "shellx-motion/browser-workflow-trace@1",
        stepCount: 2,
        steps: [
          { index: 0, action: { action: "click", selector: "#swap" }, status: "passed" },
          { index: 1, action: { action: "verify", selector: "#state", hasText: true }, status: "failed" }
        ]
      }
    });
    const serializedTrace = JSON.stringify(error.trace);
    expect(serializedTrace).not.toContain("Super secret expected text");
    expect(serializedTrace).not.toContain("Clicked");
  });

  it("draws visible browser workflow cursor metadata into deterministic captures", async () => {
    const root = await writeBrowserPackage("Cursor Target");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-cursor-"));
    tempDirs.push(root, outDir);

    const withoutCursor = await renderBrowserFrame(pkg, { atMs: 250, outDir });
    const withCursor = await renderBrowserFrame(pkg, {
      atMs: 250,
      outDir,
      workflow: {
        schema: "shellx-motion/browser-workflow@1",
        viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
        networkPolicy: "blocked-unless-declared",
        steps: [],
        cursor: { visible: true, path: [{ x: 300, y: 220, atMs: 250 }] }
      }
    });
    const cursorRegion = inspectPngRegionBuffer(await readFile(withCursor.output.path), { x: 296, y: 216, width: 24, height: 28 });

    expect(withoutCursor.output.sha256).not.toBe(withCursor.output.sha256);
    expect(cursorRegion.ok).toBe(true);
    if (!cursorRegion.ok) return;
    expect(cursorRegion.luma.darkPixels).toBeGreaterThan(20);
    expect(cursorRegion.edges.pixels).toBeGreaterThan(10);
    expect(withCursor.output.workflow).toMatchObject({
      cursor: { visible: true, pointCount: 1 }
    });
  });

  it("captures generated MotionIR image/text/shape layers without a web layer", async () => {
    const root = await writeGeneratedMotionPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-browser-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-01T20:16:00.000Z" });
    const bytes = await readFile(result.output.path);

    expect(result.ok).toBe(true);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      packageId: "pkg_generated_motion",
      lane: "browser",
      createdAt: "2026-07-01T20:16:00.000Z",
      inputHashes: {
        motion: expect.stringMatching(/^[a-f0-9]{64}$/),
        "assets/product.png": expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      output: {
        width: 320,
        height: 180,
        atMs: 0
      }
    });
  });

  it("renders RTL text in Chromium and records sanitized direction, language, and font fallback evidence", async () => {
    const root = await writeGeneratedTypographyEvidencePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-typography-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(result.ok).toBe(true);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.brightPixels).toBeGreaterThan(50);
    expect(result.output.typography).toEqual({
      schema: "shellx-motion/browser-typography@1",
      authority: "chromium",
      attestation: "unverified",
      fontProbe: "canvas-metric",
      scopes: [{
        kind: "motion-ir",
        attestation: "unverified",
        layerIds: ["arabic-title", "sanitized-title"],
        reason: "requested_font_not_manifest_bound"
      }],
      layers: [
        {
          layerId: "arabic-title",
          direction: "rtl",
          lang: "ar",
          requestedFontFamily: "'ShellXDefinitelyMissingArabicFont',sans-serif",
          resolvedFontFamily: "ShellXDefinitelyMissingArabicFont, sans-serif",
          primaryFontAvailable: false,
          fontProvenance: "unverified"
        },
        {
          layerId: "sanitized-title",
          direction: "ltr",
          lang: null,
          requestedFontFamily: null,
          resolvedFontFamily: "Inter, Arial, sans-serif",
          primaryFontAvailable: null,
          fontProvenance: "unverified"
        }
      ],
      fontAssets: [],
      fallbackLayerIds: ["arabic-title"]
    });
    expect(result.receipt.status).toBe("warning");
    expect(result.receipt.warnings).toContain("Browser renderer used a font fallback for text layer arabic-title.");
  });

  it("refuses browser rendering when a fallback attestation requests an unbound generated family", async () => {
    const root = await writeGeneratedTypographyEvidencePackage();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.quality = { maxFontFallbacks: 0 };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-typography-policy-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir })).rejects.toMatchObject({
      code: "browser_motion_typography_unverified",
      refusal: {
        detail: { attestation: "font-fallback", scope: "motion-ir", layerIds: ["arabic-title", "sanitized-title"] }
      }
    });
  });

  it("measures readable generated text against its declared safe area", async () => {
    const root = await writeGeneratedTextFitPackage({
      text: "Readable title",
      transform: { x: 30, y: 54, width: 260, height: 60 },
      style: { fontFamily: "sans-serif", fontSize: 32, lineHeight: 1, color: "#ffffff" },
      textFit: { policy: "safe", safeAreaId: "title" }
    });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-fit-safe-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });

    expect(result.output.textFit).toMatchObject({
      policy: "rendered-glyph-bounds",
      atMs: 0,
      checkedLayerCount: 1,
      failedLayerIds: [],
      layers: [{
        layerId: "title",
        policy: "safe",
        safeAreaId: "title",
        status: "passed",
        visibleSampleCount: 1
      }]
    });
  });

  it("requires explicit allow-crop intent for visible off-canvas text", async () => {
    const rejectedRoot = await writeGeneratedTextFitPackage({
      text: "CROPPED",
      transform: { x: -90, y: 52, width: 300, height: 70 },
      style: { fontFamily: "sans-serif", fontSize: 56, lineHeight: 1, color: "#ffffff" },
      textFit: { policy: "safe", safeAreaId: "title" }
    });
    const rejected = await loadMotionPackage(rejectedRoot);
    const rejectedOut = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-fit-rejected-"));
    tempDirs.push(rejectedRoot, rejectedOut);

    await expect(renderMotionBrowserFrame(rejected, { atMs: 0, outDir: rejectedOut })).rejects.toThrow(
      /Browser text-fit check failed at 0ms: title/
    );

    const allowedRoot = await writeGeneratedTextFitPackage({
      text: "CROPPED",
      transform: { x: -90, y: 52, width: 300, height: 70 },
      style: { fontFamily: "sans-serif", fontSize: 56, lineHeight: 1, color: "#ffffff" },
      textFit: { policy: "allow-crop", safeAreaId: "title" }
    });
    const allowed = await loadMotionPackage(allowedRoot);
    const allowedOut = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-fit-allowed-"));
    tempDirs.push(allowedRoot, allowedOut);

    const result = await renderMotionBrowserFrame(allowed, { atMs: 0, outDir: allowedOut });
    expect(result.output.textFit).toMatchObject({
      allowedCropLayerIds: ["title"],
      failedLayerIds: [],
      layers: [{ layerId: "title", safeAreaId: "title", status: "allowed-crop" }]
    });
    expect(result.output.textFit?.layers[0]?.safeAreaOverflowPx.left).toBeGreaterThan(0);
  });

  it("auto-fits generated text down to its declared minimum and records the applied size", async () => {
    const root = await writeGeneratedTextFitPackage({
      text: "A much longer localized title",
      transform: { x: 24, y: 44, width: 272, height: 92 },
      style: { fontFamily: "sans-serif", fontSize: 64, lineHeight: 1, color: "#ffffff", whiteSpace: "nowrap" },
      textFit: { policy: "auto-fit", safeAreaId: "title", minFontSize: 16 }
    });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-fit-auto-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const layer = result.output.textFit?.layers[0];

    expect(layer).toMatchObject({
      layerId: "title",
      policy: "auto-fit",
      status: "auto-fitted",
      requestedFontSize: 64,
      minFontSize: 16
    });
    expect(layer?.appliedFontSize).toBeLessThan(64);
    expect(layer?.appliedFontSize).toBeGreaterThanOrEqual(16);
    // The new text-runs field must stay absent, byte-for-byte, for legacy text.
    expect(layer).not.toHaveProperty("textRuns");
  });

  it.skipIf(!TEXT_RUNS_HOST_FIXTURE)("refuses constrained styled text under safe policy instead of pretending its inline run override fitted", async () => {
    const root = await writeGeneratedStyledTextFitPackage("safe");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-styled-text-fit-safe-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir })).rejects.toMatchObject({
      code: "text_fit_failed",
      evidence: { failedLayerIds: ["title"], layers: [expect.objectContaining({ policy: "safe", status: "failed", textRuns: expect.objectContaining({ runs: expect.any(Array) }) })] }
    });
  });

  it.skipIf(!TEXT_RUNS_HOST_FIXTURE)("auto-fits mixed overridden and inherited text-runs at one coherent scale", async () => {
    const root = await writeGeneratedStyledTextFitPackage("auto-fit");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-styled-text-fit-auto-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const layer = result.output.textFit?.layers[0];
    expect(layer).toMatchObject({ layerId: "title", policy: "auto-fit", status: "auto-fitted", textRuns: { scale: expect.any(Number), runs: [{ fontAssetId: "font-codicon", inheritsLayerFontSize: false, requestedFontSizePx: 160 }, { fontAssetId: "font-codicon", inheritsLayerFontSize: true, requestedFontSizePx: null }] } });
    const textRuns = layer?.textRuns;
    if (!layer || !textRuns) throw new Error("expected styled text-fit evidence");
    expect(textRuns.scale).toBeGreaterThan(0);
    expect(textRuns.scale).toBeLessThan(1);
    expect(textRuns.runs[0]!.effectiveFontSizePx).toBeCloseTo(160 * textRuns.scale, 2);
    expect(textRuns.runs[1]!.effectiveFontSizePx).toBeCloseTo(layer.appliedFontSize, 2);
    expect(textRuns.runs[0]!.effectiveFontSizePx).toBeGreaterThan(textRuns.runs[1]!.effectiveFontSizePx);
  });

  it("embeds a manifest-declared package font face and records it in render evidence", async () => {
    const root = await writeGeneratedEmbeddedFontPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-font-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });

    expect(result.ok).toBe(true);
    expect(result.receipt.inputHashes["assets/fonts/codicon.ttf"]).toMatch(/^[a-f0-9]{64}$/);
    expect(result.output.captureReadiness).toMatchObject({
      fonts: "ready",
      diagnostics: {
        fontFaceCount: 1,
        fontFaceLoadAttemptCount: 1,
        fontFaceLoadedCount: 1,
      },
    });
    expect(result.output.typography).toBeDefined();
    expect(result.output.typography?.layers[0]).toMatchObject({
      layerId: "icon-title",
      requestedFontFamily: "'ShellXCodicon'",
      resolvedFontFamily: "ShellXCodicon",
      fontProvenance: "manifest-bound",
    });
    expect(result.output.typography?.fontAssets).toEqual([{
      id: "font-codicon",
      family: "ShellXCodicon",
      sha256: result.receipt.inputHashes["assets/fonts/codicon.ttf"]
    }]);
    expect(result.output.typography).toMatchObject({ attestation: "verified" });
  });

  it("rejects undeclared or extension-mismatched package font faces before browser launch", async () => {
    const undeclaredRoot = await writeGeneratedEmbeddedFontPackage();
    const undeclaredManifest = JSON.parse(await readFile(join(undeclaredRoot, "manifest.json"), "utf8"));
    undeclaredManifest.assets = [];
    await writeFile(join(undeclaredRoot, "manifest.json"), `${JSON.stringify(undeclaredManifest, null, 2)}\n`, "utf8");
    const undeclared = await loadMotionPackage(undeclaredRoot);
    const undeclaredOut = await mkdtemp(join(tmpdir(), "shellx-motion-undeclared-font-"));
    tempDirs.push(undeclaredRoot, undeclaredOut);
    await expect(renderMotionBrowserFrame(undeclared, { atMs: 0, outDir: undeclaredOut })).rejects.toThrow(/not declared in manifest\.assets/);

    const mismatchRoot = await writeGeneratedEmbeddedFontPackage();
    const mismatchMotion = JSON.parse(await readFile(join(mismatchRoot, "motion.json"), "utf8"));
    mismatchMotion.assets[0].source.mimeType = "font/woff2";
    await writeFile(join(mismatchRoot, "motion.json"), `${JSON.stringify(mismatchMotion, null, 2)}\n`, "utf8");
    const mismatch = await loadMotionPackage(mismatchRoot);
    const mismatchOut = await mkdtemp(join(tmpdir(), "shellx-motion-mismatched-font-"));
    tempDirs.push(mismatchRoot, mismatchOut);
    await expect(renderMotionBrowserFrame(mismatch, { atMs: 0, outDir: mismatchOut })).rejects.toThrow(/extension does not match font\/woff2/);
  });

  it("renders the validated static Lottie lowering with source viewBox geometry and Chromium text shaping", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-static-shape/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-static-shape",
      createdBy: "browser-renderer-test"
    });
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-lowering-package-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-lowering-render-"));
    tempDirs.push(root, outDir);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_lottie_static_shape",
      name: lowered.motion.name,
      motion: "motion.json",
      assets: [],
      sourceApp: "lottie",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2));
    await writeFile(join(root, "motion.json"), JSON.stringify(lowered.motion, null, 2));
    const pkg = await loadMotionPackage(root);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const quality = inspectPngBuffer(png);
    const pathRegion = inspectPngRegionBuffer(png, { x: 180, y: 120, width: 300, height: 100 });

    expect(result.ok).toBe(true);
    expect(quality.ok).toBe(true);
    expect(pathRegion.ok).toBe(true);
    if (!quality.ok || !pathRegion.ok) return;
    expect(quality.blank).toBe(false);
    expect(pathRegion.edges.pixels).toBeGreaterThan(50);
    expect(result.output.typography?.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ layerId: "arabic-title", direction: "rtl" })
    ]));
  });

  it("renders imported Lottie blend modes differently from normal compositing", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-blend-modes/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-blend-modes",
      createdBy: "browser-renderer-test"
    });
    const blendRoot = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-blend-package-"));
    const normalRoot = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-normal-package-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-blend-render-"));
    tempDirs.push(blendRoot, normalRoot, outDir);
    const manifest = {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_lottie_blend_modes",
      name: lowered.motion.name,
      motion: "motion.json",
      assets: [],
      sourceApp: "lottie",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas", "cut"] }
    };
    await writeFile(join(blendRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
    await writeFile(join(blendRoot, "motion.json"), JSON.stringify(lowered.motion, null, 2));
    await writeFile(join(normalRoot, "manifest.json"), JSON.stringify({ ...manifest, id: "pkg_lottie_normal_modes" }, null, 2));
    await writeFile(join(normalRoot, "motion.json"), JSON.stringify({
      ...lowered.motion,
      id: `${lowered.motion.id}_normal`,
      layers: lowered.motion.layers.map(({ blendMode: _blendMode, ...layer }) => layer)
    }, null, 2));
    const [blendPackage, normalPackage] = await Promise.all([loadMotionPackage(blendRoot), loadMotionPackage(normalRoot)]);

    const blended = await renderMotionBrowserFrame(blendPackage, { atMs: 0, outDir, outputPath: join(outDir, "blended.png") });
    const normal = await renderMotionBrowserFrame(normalPackage, { atMs: 0, outDir, outputPath: join(outDir, "normal.png") });
    const blendedPng = await readFile(blended.output.path);
    const quality = inspectPngBuffer(blendedPng);
    const difference = comparePngBuffers(blendedPng, await readFile(normal.output.path));

    expect(blended.output.sha256).not.toBe(normal.output.sha256);
    expect(blended.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(difference.changedPixels).toBeGreaterThan(2_000);
  }, 45_000);

  it("renders an imported Lottie linear gradient as a non-flat editable Motion rectangle", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-linear-gradient/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-linear-gradient",
      createdBy: "browser-renderer-test"
    });
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-gradient-package-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-gradient-render-"));
    tempDirs.push(root, outDir);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_lottie_linear_gradient",
      name: lowered.motion.name,
      motion: "motion.json",
      assets: [],
      sourceApp: "lottie",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2));
    await writeFile(join(root, "motion.json"), JSON.stringify(lowered.motion, null, 2));
    const pkg = await loadMotionPackage(root);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const region = inspectPngRegionBuffer(await readFile(result.output.path), { x: 30, y: 35, width: 260, height: 110 });

    expect(result.ok).toBe(true);
    expect(result.receipt.warnings).toEqual([]);
    expect(region.ok).toBe(true);
    if (!region.ok) return;
    expect(region.blank).toBe(false);
    expect(region.rgbRange.r).toBeGreaterThan(180);
    expect(region.rgbRange.b).toBeGreaterThan(90);
    expect(region.luma.range).toBeGreaterThan(45);
  }, 45_000);

  it("renders strict static SVG lowering with original viewBox geometry and stroke styling", async () => {
    const sourcePath = resolve("../../fixtures/imports/svg-static-path/input.svg");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticSvgToMotion({
      adapterId: "adapter.svg",
      sourcePath,
      sourceText,
      normalizedPackagePath: "pkg_svg_static_path",
      createdBy: "browser-renderer-test"
    });
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-svg-lowering-package-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-svg-lowering-render-"));
    tempDirs.push(root, outDir);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_svg_static_path",
      name: lowered.motion.name,
      motion: "motion.json",
      assets: [],
      sourceApp: "svg",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2));
    await writeFile(join(root, "motion.json"), JSON.stringify(lowered.motion, null, 2));
    const pkg = await loadMotionPackage(root);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(result.ok).toBe(true);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.edges.pixels).toBeGreaterThan(500);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("declares generated curved SVG path support", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "browser_capability_curve_path",
      name: "Browser Capability Curve Path",
      durationMs: 1000,
      fps: 30,
      width: 320,
      height: 180,
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [
        {
          id: "curve",
          type: "shape",
          shape: "path",
          "x-path": "M 10 80 C 30 10 70 10 90 80 Z",
          startMs: 0,
          durationMs: 1000
        }
      ]
    };

    expect(matchRendererCapability(motion, BROWSER_CAPABILITY)).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });
    expect(BROWSER_CAPABILITY.features).toContain("mask.path");
  });

  it("declares generated video timing support without browser audio extraction support", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "browser_capability_video",
      name: "Browser Capability Video",
      durationMs: 1000,
      fps: 30,
      width: 320,
      height: 180,
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 1000,
          trimStartMs: 120,
          trimDurationMs: 500,
          loop: true,
          playbackRate: 1.5
        }
      ]
    };

    expect(matchRendererCapability(motion, BROWSER_CAPABILITY)).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });
    expect(matchRendererCapability({
      ...motion,
      layers: [{ ...motion.layers[0], includeAudio: true, volume: 0.5 }]
    }, BROWSER_CAPABILITY)).toEqual({
      ok: false,
      lane: "browser",
      unsupported: [
        { layerId: "clip", feature: "video.includeAudio", reason: "Lane browser does not support video.includeAudio on layer clip." },
        { layerId: "clip", feature: "audio.trim", reason: "Lane browser does not support audio.trim on layer clip." },
        { layerId: "clip", feature: "audio.loop", reason: "Lane browser does not support audio.loop on layer clip." },
        { layerId: "clip", feature: "audio.playbackRate", reason: "Lane browser does not support audio.playbackRate on layer clip." },
        { layerId: "clip", feature: "audio.volume", reason: "Lane browser does not support audio.volume on layer clip." }
      ]
    });
  });

  it("skips invisible generated MotionIR layers in browser frames", async () => {
    const root = await writeGeneratedVisibilityPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-visibility-browser-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-03T00:00:00.000Z" });
    const png = await readFile(result.output.path);
    const hiddenRegion = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 32, height: 32 });
    const visibleRegion = inspectPngRegionBuffer(png, { x: 84, y: 20, width: 32, height: 32 });

    expect(result.ok).toBe(true);
    expect(hiddenRegion.ok).toBe(true);
    expect(visibleRegion.ok).toBe(true);
    if (!hiddenRegion.ok || !visibleRegion.ok) return;
    expect(hiddenRegion.luma.brightPixels).toBe(0);
    expect(visibleRegion.luma.brightPixels).toBeGreaterThan(900);
  });

  it("preserves transparent generated MotionIR backgrounds in PNG frames", async () => {
    const root = await writeGeneratedTransparentOverlayPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-transparent-browser-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(result.ok).toBe(true);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.transparentPixels).toBeGreaterThan(0);
    expect(quality.nonTransparentPixels).toBeGreaterThan(0);
  });

  it("renders generated MotionIR image source crop rectangles", async () => {
    const root = await writeGeneratedImageCropPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-02T16:45:00.000Z" });
    const cropRegion = inspectPngRegionBuffer(await readFile(result.output.path), { x: 24, y: 24, width: 48, height: 40 });

    expect(result.ok).toBe(true);
    expect(cropRegion.ok).toBe(true);
    if (!cropRegion.ok) return;
    expect(cropRegion.luma.brightPixels).toBeGreaterThan(1800);
    expect(cropRegion.luma.darkPixels).toBe(0);
  });

  it("renders generated MotionIR cropped image style objectFit none without stretching", async () => {
    const root = await writeGeneratedImageCropFitPackage({ style: { objectFit: "none" } });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-fit-none-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-02T18:55:00.000Z" });
    const png = await readFile(result.output.path);
    const layerCorner = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 2, height: 2 });
    const naturalCrop = inspectPngRegionBuffer(png, { x: 23, y: 23, width: 2, height: 2 });

    expect(result.ok).toBe(true);
    expect(layerCorner.ok).toBe(true);
    expect(naturalCrop.ok).toBe(true);
    if (!layerCorner.ok || !naturalCrop.ok) return;
    expect(layerCorner.luma.brightPixels).toBe(0);
    expect(naturalCrop.luma.brightPixels).toBeGreaterThan(3);
  });

  it("renders generated MotionIR cropped image style fit scale-down without stretching when source fits", async () => {
    const root = await writeGeneratedImageCropFitPackage({ style: { fit: "scale-down" } });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-fit-scale-down-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-02T19:00:00.000Z" });
    const png = await readFile(result.output.path);
    const layerCorner = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 2, height: 2 });
    const naturalCrop = inspectPngRegionBuffer(png, { x: 23, y: 23, width: 2, height: 2 });

    expect(result.ok).toBe(true);
    expect(layerCorner.ok).toBe(true);
    expect(naturalCrop.ok).toBe(true);
    if (!layerCorner.ok || !naturalCrop.ok) return;
    expect(layerCorner.luma.brightPixels).toBe(0);
    expect(naturalCrop.luma.brightPixels).toBeGreaterThan(3);
  });

  it("renders generated MotionIR cropped image style fit scale-down as contain when source is larger", async () => {
    const imageWidth = 8;
    const imageHeight = 4;
    const root = await writeGeneratedImageCropFitPackage({
      style: { fit: "scale-down" },
      transform: { x: 20, y: 20, width: 4, height: 4 },
      crop: { x: 0, y: 0, width: imageWidth, height: imageHeight },
      imageWidth,
      imageHeight,
      pixels: Array.from({ length: imageWidth * imageHeight }, () => {
        return { r: 255, g: 255, b: 255, a: 255 };
      })
    });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-fit-scale-down-large-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-02T19:05:00.000Z" });
    const png = await readFile(result.output.path);
    const topLetterbox = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 4, height: 1 });
    const containedCrop = inspectPngRegionBuffer(png, { x: 20, y: 21, width: 4, height: 2 });
    const bottomLetterbox = inspectPngRegionBuffer(png, { x: 20, y: 23, width: 4, height: 1 });

    expect(result.ok).toBe(true);
    expect(topLetterbox.ok).toBe(true);
    expect(containedCrop.ok).toBe(true);
    expect(bottomLetterbox.ok).toBe(true);
    if (!topLetterbox.ok || !containedCrop.ok || !bottomLetterbox.ok) return;
    expect(topLetterbox.luma.brightPixels).toBe(0);
    expect(containedCrop.luma.brightPixels).toBeGreaterThan(7);
    expect(bottomLetterbox.luma.brightPixels).toBe(0);
  });

  it("renders generated MotionIR image crop keyframes at capture time", async () => {
    const root = await writeGeneratedImageCropKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, now: () => "2026-07-02T16:55:00.000Z" });
    const mid = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir, now: () => "2026-07-02T16:55:00.000Z" });
    const startRegion = inspectPngRegionBuffer(await readFile(start.output.path), { x: 24, y: 24, width: 48, height: 40 });
    const midRegion = inspectPngRegionBuffer(await readFile(mid.output.path), { x: 24, y: 24, width: 48, height: 40 });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    expect(start.output.sha256).not.toBe(mid.output.sha256);
    expect(startRegion.ok).toBe(true);
    expect(midRegion.ok).toBe(true);
    if (!startRegion.ok || !midRegion.ok) return;
    expect(startRegion.luma.brightPixels).toBe(0);
    expect(startRegion.luma.darkPixels).toBeGreaterThan(1800);
    expect(midRegion.luma.brightPixels).toBeGreaterThan(1800);
    expect(midRegion.luma.darkPixels).toBe(0);
  });

  it("renders generated MotionIR image borderRadius styles", async () => {
    const root = await writeGeneratedImageBorderRadiusPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-border-radius-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const clippedCorner = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 8, height: 8 });
    const centerFill = inspectPngRegionBuffer(png, { x: 54, y: 54, width: 12, height: 12 });

    expect(result.ok).toBe(true);
    expect(clippedCorner.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!clippedCorner.ok || !centerFill.ok) return;
    expect(clippedCorner.luma.brightPixels).toBe(0);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(100);
  });

  it.each(["assetRef", "source", "src"] as const)("renders generated MotionIR image layers referenced by %s", async (field) => {
    const root = await writeGeneratedImageAliasPackage(field);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-generated-image-${field}-`));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const imageRegion = inspectPngRegionBuffer(await readFile(result.output.path), { x: 20, y: 20, width: 40, height: 40 });

    expect(result.ok).toBe(true);
    expect(result.receipt.inputHashes["assets/white.png"]).toMatch(/^[a-f0-9]{64}$/);
    expect(imageRegion.ok).toBe(true);
    if (!imageRegion.ok) return;
    expect(imageRegion.luma.brightPixels).toBeGreaterThan(1500);
    expect(imageRegion.luma.darkPixels).toBe(0);
  });

  it("renders generated MotionIR image style objectFit aliases", async () => {
    const root = await writeGeneratedImageObjectFitPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-object-fit-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const topLetterbox = inspectPngRegionBuffer(png, { x: 24, y: 24, width: 72, height: 10 });
    const imageBody = inspectPngRegionBuffer(png, { x: 24, y: 52, width: 72, height: 20 });

    expect(result.ok).toBe(true);
    expect(topLetterbox.ok).toBe(true);
    expect(imageBody.ok).toBe(true);
    if (!topLetterbox.ok || !imageBody.ok) return;
    expect(topLetterbox.luma.brightPixels).toBe(0);
    expect(imageBody.luma.brightPixels).toBeGreaterThan(1200);
  });

  it("renders animated structured gradients as deterministic rich-output frames", async () => {
    const root = await writeGeneratedGradientPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-gradient-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const rotated = await renderMotionBrowserFrame(pkg, { atMs: 900, outDir });
    const startQuality = inspectPngRegionBuffer(await readFile(start.output.path), { x: 24, y: 24, width: 272, height: 132 });
    const rotatedQuality = inspectPngRegionBuffer(await readFile(rotated.output.path), { x: 24, y: 24, width: 272, height: 132 });

    expect(start.output.sha256).not.toBe(rotated.output.sha256);
    expect(start.receipt.warnings).toEqual([]);
    expect(rotated.receipt.warnings).toEqual([]);
    expect(startQuality.ok).toBe(true);
    expect(rotatedQuality.ok).toBe(true);
    if (!startQuality.ok || !rotatedQuality.ok) return;
    expect(startQuality.blank).toBe(false);
    expect(startQuality.luma.range).toBeGreaterThan(100);
    expect(rotatedQuality.luma.range).toBeGreaterThan(100);
  });

  it("renders seeded bounded particles deterministically across animated frames", async () => {
    const root = await writeGeneratedParticlePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-particles-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const startQuality = inspectPngBuffer(await readFile(start.output.path));
    const laterQuality = inspectPngBuffer(await readFile(later.output.path));

    expect(BROWSER_CAPABILITY.features).toContain("particles.analytic-field");
    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.receipt.warnings).toEqual([]);
    expect(later.receipt.warnings).toEqual([]);
    expect(startQuality.ok).toBe(true);
    expect(laterQuality.ok).toBe(true);
    if (!startQuality.ok || !laterQuality.ok) return;
    expect(startQuality.blank).toBe(false);
    expect(laterQuality.blank).toBe(false);
    expect(startQuality.luma.range).toBeGreaterThan(100);
    expect(laterQuality.luma.range).toBeGreaterThan(100);
    expect(startQuality.edges.pixels).toBeGreaterThan(100);
    expect(laterQuality.edges.pixels).toBeGreaterThan(100);
  });

  it("renders keyframed 2D camera pushes deterministically across the full composition", async () => {
    const root = await writeGeneratedCameraPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-camera-"));
    tempDirs.push(root, outDir);

    expect(BROWSER_CAPABILITY.layerTypes).toContain("camera");
    expect(BROWSER_CAPABILITY.features).toContain("camera.2d");
    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const pushed = await renderMotionBrowserFrame(pkg, { atMs: 900, outDir });
    const startQuality = inspectPngBuffer(await readFile(start.output.path));
    const pushedQuality = inspectPngBuffer(await readFile(pushed.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(pushed.output.sha256);
    expect(start.receipt.warnings).toEqual([]);
    expect(pushed.receipt.warnings).toEqual([]);
    expect(startQuality.ok).toBe(true);
    expect(pushedQuality.ok).toBe(true);
    if (!startQuality.ok || !pushedQuality.ok) return;
    expect(startQuality.blank).toBe(false);
    expect(pushedQuality.blank).toBe(false);
    expect(startQuality.edges.pixels).toBeGreaterThan(500);
    expect(pushedQuality.edges.pixels).toBeGreaterThan(500);
  });

  it("renders bounded depth planes with visibly different camera parallax", async () => {
    const depthRoot = await writeGeneratedCameraPackage(true);
    const flatRoot = await writeGeneratedCameraPackage(false);
    const [depthPackage, flatPackage] = await Promise.all([
      loadMotionPackage(depthRoot),
      loadMotionPackage(flatRoot)
    ]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-camera-depth-"));
    tempDirs.push(depthRoot, flatRoot, outDir);

    const depth = await renderMotionBrowserFrame(depthPackage, { atMs: 900, outDir });
    const depthAgain = await renderMotionBrowserFrame(depthPackage, { atMs: 900, outDir });
    const flat = await renderMotionBrowserFrame(flatPackage, { atMs: 900, outDir });
    const depthPng = await readFile(depth.output.path);
    const flatPng = await readFile(flat.output.path);
    const quality = inspectPngBuffer(depthPng);
    const difference = comparePngBuffers(depthPng, flatPng);

    expect(depth.output.sha256).toBe(depthAgain.output.sha256);
    expect(depth.output.sha256).not.toBe(flat.output.sha256);
    expect(depth.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(difference.changedPixels).toBeGreaterThan(2_000);
  }, 45_000);

  it("renders bounded temporal motion blur with receipt-visible sample cost", async () => {
    const blurredRoot = await writeGeneratedMotionBlurPackage(true);
    const sharpRoot = await writeGeneratedMotionBlurPackage(false);
    const [blurredPackage, sharpPackage] = await Promise.all([
      loadMotionPackage(blurredRoot),
      loadMotionPackage(sharpRoot)
    ]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-motion-blur-"));
    tempDirs.push(blurredRoot, sharpRoot, outDir);

    expect(matchRendererCapability(blurredPackage.motion, BROWSER_CAPABILITY)).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });

    const blurred = await renderMotionBrowserFrame(blurredPackage, { atMs: 500, outDir });
    const blurredAgain = await renderMotionBrowserFrame(blurredPackage, { atMs: 500, outDir });
    const sharp = await renderMotionBrowserFrame(sharpPackage, { atMs: 500, outDir });
    const blurredPng = await readFile(blurred.output.path);
    const sharpPng = await readFile(sharp.output.path);
    const quality = inspectPngBuffer(blurredPng);
    const difference = comparePngBuffers(blurredPng, sharpPng);

    expect(blurred.output.sha256).toBe(blurredAgain.output.sha256);
    expect(blurred.output.sha256).not.toBe(sharp.output.sha256);
    expect(blurred.output.temporalSampling).toMatchObject({
      policy: "layer-temporal-supersampling",
      maxSamplesPerLayer: 8,
      maxVideoSamplesPerLayer: 4,
      maxTotalSamples: 64,
      maxTotalVideoSamples: 16,
      totalSamples: 8,
      totalVideoSamples: 0,
      layers: [{ layerId: "runner", layerType: "text", samples: 8, shutterAngle: 360 }]
    });
    expect(blurred.output.temporalSampling?.layers[0]?.shutterDurationMs).toBeCloseTo(1000 / 24, 6);
    expect(blurred.output.typography?.layers.filter((layer) => layer.layerId === "runner")).toHaveLength(1);
    expect(blurred.receipt.output).toMatchObject({ temporalSampling: blurred.output.temporalSampling });
    expect(blurred.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.edges.pixels).toBeGreaterThan(300);
    expect(difference.changedPixels).toBeGreaterThan(100);
  }, 45_000);

  it("renders deterministic animated film grain and vignette adjustment layers", async () => {
    const treatedRoot = await writeGeneratedFilmAdjustmentPackage(true);
    const cleanRoot = await writeGeneratedFilmAdjustmentPackage(false);
    const [treatedPackage, cleanPackage] = await Promise.all([
      loadMotionPackage(treatedRoot),
      loadMotionPackage(cleanRoot)
    ]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-film-adjustment-"));
    tempDirs.push(treatedRoot, cleanRoot, outDir);

    expect(matchRendererCapability(treatedPackage.motion, BROWSER_CAPABILITY)).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });
    const treated = await renderMotionBrowserFrame(treatedPackage, { atMs: 0, outDir });
    const treatedAgain = await renderMotionBrowserFrame(treatedPackage, { atMs: 0, outDir });
    const animatedGrain = await renderMotionBrowserFrame(treatedPackage, { atMs: 500, outDir });
    const clean = await renderMotionBrowserFrame(cleanPackage, { atMs: 0, outDir });
    const treatedPng = await readFile(treated.output.path);
    const cleanPng = await readFile(clean.output.path);
    const quality = inspectPngBuffer(treatedPng);
    const difference = comparePngBuffers(treatedPng, cleanPng);

    expect(treated.output.sha256).toBe(treatedAgain.output.sha256);
    expect(treated.output.sha256).not.toBe(animatedGrain.output.sha256);
    expect(treated.output.sha256).not.toBe(clean.output.sha256);
    expect(treated.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(100);
    expect(difference.changedPixels).toBeGreaterThan(10_000);
  }, 45_000);

  it("renders package-local restricted GLSL deterministically with receipt diagnostics", async () => {
    const root = await writeGeneratedShaderPackage("vec4 motionMain(vec2 uv) { return vec4(0.5 + 0.5 * sin((uv.x + u_time * u_speed) * 12.0), uv.y, 0.5 + 0.5 * cos((uv.y - u_time) * 10.0 + u_seed), 1.0); }");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-"));
    tempDirs.push(root, outDir);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const quality = inspectPngBuffer(await readFile(start.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.shaders).toMatchObject({
      policy: "restricted-package-glsl",
      maxLayers: 4,
      maxSourceBytes: 16384,
      maxUniformsPerLayer: 16,
      network: "denied",
      clock: "frame-time",
      random: "declared-seed",
      layers: [{ layerId: "plasma", assetRef: "assets/plasma.glsl", seed: 42, uniformCount: 1 }]
    });
    expect(start.output.shaders?.layers[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(start.output.webglResources).toEqual({
      policy: "snapshot-then-explicit-context-release",
      surfaceCount: 1,
      frozenSurfaceCount: 1,
      contextReleaseRequestedCount: 1,
      layerIds: ["plasma"]
    });
    expect(start.receipt.output).toMatchObject({ shaders: start.output.shaders });
    expect(start.receipt.output).toMatchObject({ webglResources: start.output.webglResources });
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(100);
    expect(quality.rgbRange.r).toBeGreaterThan(200);
    expect(quality.rgbRange.g).toBeGreaterThan(200);
  }, 45_000);

  it("releases WebGL contexts across a reused multi-frame shader session", async () => {
    const root = await writeGeneratedShaderPackage("vec4 motionMain(vec2 uv) { return vec4(uv, 0.5 + 0.5 * sin(u_time), 1.0); }");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-release-"));
    tempDirs.push(root, outDir);
    const session = await createMotionBrowserRenderSession(pkg);
    try {
      const frames = await session.renderFrames(Array.from({ length: 24 }, (_value, index) => ({
        atMs: index * 25,
        outDir,
        outputPath: join(outDir, `${index}.png`)
      })), { maxConcurrency: 2 });

      expect(frames).toHaveLength(24);
      expect(frames.every((frame) => frame.output.webglResources?.contextReleaseRequestedCount === 1)).toBe(true);
      expect(frames.flatMap((frame) => frame.receipt.warnings ?? []).join("\n")).not.toContain("Too many active WebGL contexts");
    } finally {
      await session.close();
    }
  }, 45_000);

  it("rejects hostile package shader source before Chromium execution", async () => {
    const root = await writeGeneratedShaderPackage("vec4 motionMain(vec2 uv) { for (;;) {} return vec4(uv, 0.0, 1.0); }");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-hostile-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir })).rejects.toThrow("Restricted shader validation failed");
  });

  it("reports bounded runtime compiler failures without exposing executable host access", async () => {
    const root = await writeGeneratedShaderPackage("vec4 motionMain(vec2 uv) { return vec4(normalize(uv), normalize(uv), 1.0); }");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-compile-failure-"));
    tempDirs.push(root, outDir);

    const failure = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Restricted shader render failed: plasma:/);
    expect((failure as Error).message).not.toContain("vec4 motionMain");
  });

  it("rejects shader assets omitted from the package manifest", async () => {
    const root = await writeGeneratedShaderPackage("vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); }");
    await writeFile(join(root, "manifest.json"), `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_shader",
      name: "Generated Shader",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2)}\n`);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-undeclared-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir })).rejects.toThrow("not declared in manifest.assets");
  });

  it("rejects oversized shader canvases before WebGL allocation", async () => {
    const root = await writeGeneratedShaderPackage("vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); }");
    const motionPath = join(root, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8")) as MotionDocument;
    motion.layers[0].transform = { ...motion.layers[0].transform, width: 100_000, height: 100_000 };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-oversized-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir })).rejects.toThrow("Motion frame exceeds the local");
  });

  it("renders bounded fixed-primitive scene3d layers deterministically with visible motion", async () => {
    const root = await writeGeneratedScene3DPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-scene3d-"));
    tempDirs.push(root, outDir);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const quality = inspectPngBuffer(await readFile(start.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.scenes3d).toMatchObject({
      policy: "fixed-data-webgl",
      maxLayers: 4,
      maxObjectsPerLayer: 16,
      maxVerticesPerObject: 36,
      network: "denied",
      clock: "frame-time",
      code: "host-fixed",
      layers: [{ layerId: "stage", objectCount: 3, primitives: ["box", "plane", "pyramid"], orbitDegPerSecond: 24 }]
    });
    expect(start.output.webglResources).toEqual({
      policy: "snapshot-then-explicit-context-release",
      surfaceCount: 1,
      frozenSurfaceCount: 1,
      contextReleaseRequestedCount: 1,
      layerIds: ["stage"]
    });
    expect(start.receipt.output).toMatchObject({ scenes3d: start.output.scenes3d });
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(80);
    expect(quality.rgbRange.b).toBeGreaterThan(120);
  }, 45_000);

  it("renders deterministic cinematic rain with wet-ground interaction and receipt evidence", async () => {
    const root = await writeGeneratedRainEnvironmentPackage();
    const differentSeedRoot = await writeGeneratedRainEnvironmentPackage(20260714);
    const [pkg, differentSeedPackage] = await Promise.all([loadMotionPackage(root), loadMotionPackage(differentSeedRoot)]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-rain-environment-"));
    tempDirs.push(root, differentSeedRoot, outDir);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 650, outDir });
    const differentSeed = await renderMotionBrowserFrame(differentSeedPackage, { atMs: 0, outDir, outputPath: join(outDir, "different-seed.png") });
    const startPng = await readFile(start.output.path);
    const quality = inspectPngBuffer(startPng);
    const difference = comparePngBuffers(startPng, await readFile(later.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.sha256).not.toBe(differentSeed.output.sha256);
    expect(start.output.environments).toEqual({
      policy: "fixed-data-environment-webgl",
      schema: "shellx-motion/environment@1",
      maxLayers: 4,
      maxRainDepthLayers: 4,
      maxSnowDepthLayers: 4,
      maxFogDepthLayers: 4,
      maxWaterWaveOctaves: 4,
      network: "denied",
      clock: "frame-time",
      random: "declared-seed",
      code: "host-fixed",
      layers: [{
        layerId: "rain-stage",
        kind: "rain",
        seed: 20260713,
        quality: "cinematic",
        mode: "scene",
        depthLayers: 4,
        effectiveDepthLayers: 4
      }]
    });
    expect(start.output.webglResources).toMatchObject({
      policy: "snapshot-then-explicit-context-release",
      surfaceCount: 1,
      frozenSurfaceCount: 1,
      contextReleaseRequestedCount: 1,
      layerIds: ["rain-stage"]
    });
    expect(start.receipt.output).toMatchObject({ environments: start.output.environments });
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(45);
    expect(quality.edges.pixels).toBeGreaterThan(500);
    expect(difference.changedPixels).toBeGreaterThan(2_000);
  }, 45_000);

  it("samples declared package footage into deterministic rain reflections", async () => {
    const sourceRoot = await writeGeneratedFootageRainEnvironmentPackage(true);
    const syntheticRoot = await writeGeneratedFootageRainEnvironmentPackage(false);
    const [sourcePackage, syntheticPackage] = await Promise.all([
      loadMotionPackage(sourceRoot),
      loadMotionPackage(syntheticRoot)
    ]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-footage-rain-environment-"));
    tempDirs.push(sourceRoot, syntheticRoot, outDir);

    const start = await renderMotionBrowserFrame(sourcePackage, { atMs: 0, outDir, outputPath: join(outDir, "source-start.png") });
    const startAgain = await renderMotionBrowserFrame(sourcePackage, { atMs: 0, outDir, outputPath: join(outDir, "source-start-again.png") });
    const later = await renderMotionBrowserFrame(sourcePackage, { atMs: 650, outDir, outputPath: join(outDir, "source-later.png") });
    const synthetic = await renderMotionBrowserFrame(syntheticPackage, { atMs: 0, outDir, outputPath: join(outDir, "synthetic-start.png") });
    const startPng = await readFile(start.output.path);
    const quality = inspectPngBuffer(startPng);
    const sourceDifference = comparePngBuffers(startPng, await readFile(synthetic.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.sha256).not.toBe(synthetic.output.sha256);
    expect(start.output.environments?.layers).toEqual([expect.objectContaining({
      layerId: "rain-stage",
      kind: "rain",
      sceneSourceLayerId: "footage",
      sceneSourceAssetRef: "assets/scene.png"
    })]);
    expect(start.receipt.inputHashes["assets/scene.png"]).toMatch(/^[a-f0-9]{64}$/);
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(sourceDifference.ok).toBe(true);
    if (!quality.ok || !sourceDifference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.rgbRange.r).toBeGreaterThan(80);
    expect(quality.rgbRange.b).toBeGreaterThan(80);
    expect(sourceDifference.changedPixels).toBeGreaterThan(10_000);
  }, 45_000);

  it("uses a hidden package mask for deterministic rain occlusion", async () => {
    const maskedRoot = await writeGeneratedFootageRainEnvironmentPackage(true, true);
    const unmaskedRoot = await writeGeneratedFootageRainEnvironmentPackage(true, false);
    const [maskedPackage, unmaskedPackage] = await Promise.all([
      loadMotionPackage(maskedRoot),
      loadMotionPackage(unmaskedRoot)
    ]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-masked-rain-environment-"));
    tempDirs.push(maskedRoot, unmaskedRoot, outDir);

    const masked = await renderMotionBrowserFrame(maskedPackage, { atMs: 650, outDir, outputPath: join(outDir, "masked.png") });
    const maskedAgain = await renderMotionBrowserFrame(maskedPackage, { atMs: 650, outDir, outputPath: join(outDir, "masked-again.png") });
    const unmasked = await renderMotionBrowserFrame(unmaskedPackage, { atMs: 650, outDir, outputPath: join(outDir, "unmasked.png") });
    const maskedPng = await readFile(masked.output.path);
    const difference = comparePngBuffers(maskedPng, await readFile(unmasked.output.path));

    expect(masked.output.sha256).toBe(maskedAgain.output.sha256);
    expect(masked.output.sha256).not.toBe(unmasked.output.sha256);
    expect(masked.output.environments?.layers).toEqual([expect.objectContaining({
      layerId: "rain-stage",
      effectMaskLayerId: "effect-mask",
      effectMaskAssetRef: "assets/effect-mask.png"
    })]);
    expect(masked.receipt.inputHashes["assets/effect-mask.png"]).toMatch(/^[a-f0-9]{64}$/);
    expect(masked.receipt.warnings).toEqual([]);
    expect(difference.ok).toBe(true);
    if (!difference.ok) return;
    expect(difference.changedPixels).toBeGreaterThan(10_000);
  }, 45_000);

  it("renders deterministic water normals, optics, caustics, and foam", async () => {
    const root = await writeGeneratedWaterEnvironmentPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-water-environment-"));
    tempDirs.push(root, outDir);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 700, outDir });
    const startPng = await readFile(start.output.path);
    const quality = inspectPngBuffer(startPng);
    const difference = comparePngBuffers(startPng, await readFile(later.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.environments?.layers).toEqual([{
      layerId: "water-stage",
      kind: "water",
      seed: 20260714,
      quality: "cinematic",
      mode: "scene",
      waveOctaves: 4,
      effectiveWaveOctaves: 4
    }]);
    expect(start.output.webglResources).toMatchObject({ surfaceCount: 1, frozenSurfaceCount: 1, contextReleaseRequestedCount: 1 });
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(45);
    expect(quality.edges.pixels).toBeGreaterThan(300);
    expect(difference.changedPixels).toBeGreaterThan(2_000);
  }, 45_000);

  it("renders deterministic layered snow with depth blur, drift, accumulation, and haze", async () => {
    const root = await writeGeneratedSnowEnvironmentPackage();
    const differentSeedRoot = await writeGeneratedSnowEnvironmentPackage(20260716);
    const [pkg, differentSeedPackage] = await Promise.all([loadMotionPackage(root), loadMotionPackage(differentSeedRoot)]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-snow-environment-"));
    tempDirs.push(root, differentSeedRoot, outDir);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 700, outDir });
    const differentSeed = await renderMotionBrowserFrame(differentSeedPackage, { atMs: 0, outDir, outputPath: join(outDir, "different-seed.png") });
    const startPng = await readFile(start.output.path);
    const quality = inspectPngBuffer(startPng);
    const difference = comparePngBuffers(startPng, await readFile(later.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.sha256).not.toBe(differentSeed.output.sha256);
    expect(start.output.environments?.layers).toEqual([{
      layerId: "snow-stage",
      kind: "snow",
      seed: 20260715,
      quality: "cinematic",
      mode: "scene",
      snowDepthLayers: 4,
      effectiveSnowDepthLayers: 4
    }]);
    expect(start.output.webglResources).toMatchObject({ surfaceCount: 1, frozenSurfaceCount: 1, contextReleaseRequestedCount: 1 });
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(45);
    expect(quality.edges.pixels).toBeGreaterThan(300);
    expect(difference.changedPixels).toBeGreaterThan(1_000);
  }, 45_000);

  it("renders deterministic layered fog over package footage with bounded light volumes", async () => {
    const root = await writeGeneratedFogEnvironmentPackage();
    const differentSeedRoot = await writeGeneratedFogEnvironmentPackage(20260718);
    const [pkg, differentSeedPackage] = await Promise.all([loadMotionPackage(root), loadMotionPackage(differentSeedRoot)]);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-fog-environment-"));
    tempDirs.push(root, differentSeedRoot, outDir);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, outputPath: join(outDir, "start.png") });
    const startAgain = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, outputPath: join(outDir, "start-again.png") });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 700, outDir, outputPath: join(outDir, "later.png") });
    const differentSeed = await renderMotionBrowserFrame(differentSeedPackage, { atMs: 0, outDir, outputPath: join(outDir, "different-seed.png") });
    const startPng = await readFile(start.output.path);
    const quality = inspectPngBuffer(startPng);
    const difference = comparePngBuffers(startPng, await readFile(later.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.sha256).not.toBe(differentSeed.output.sha256);
    expect(start.output.environments?.layers).toEqual([{
      layerId: "fog-stage",
      kind: "fog",
      seed: 20260717,
      quality: "cinematic",
      mode: "scene",
      sceneSourceLayerId: "footage",
      sceneSourceAssetRef: "assets/scene.png",
      fogDepthLayers: 4,
      effectiveFogDepthLayers: 4
    }]);
    expect(start.receipt.inputHashes["assets/scene.png"]).toMatch(/^[a-f0-9]{64}$/);
    expect(start.receipt.warnings).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(difference.ok).toBe(true);
    if (!quality.ok || !difference.ok) return;
    expect(quality.blank).toBe(false);
    expect(quality.luma.range).toBeGreaterThan(60);
    expect(difference.changedPixels).toBeGreaterThan(2_000);
  }, 45_000);

  it("rejects external-model scene3d primitives before WebGL allocation", async () => {
    const root = await writeGeneratedScene3DPackage();
    const motionPath = join(root, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8")) as MotionDocument;
    const scene = motion.layers[0].scene3d;
    if (!scene) throw new Error("Expected scene3d test layer.");
    (scene.objects[0] as unknown as { primitive: string }).primitive = "gltf-model";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-scene3d-hostile-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 0, outDir })).rejects.toThrow("unsupported primitive");
  });

  it("renders generated MotionIR shape strokes", async () => {
    const root = await writeGeneratedShapeStrokePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-stroke-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const bytes = await readFile(result.output.path);
    const topStroke = inspectPngRegionBuffer(bytes, { x: 30, y: 22, width: 60, height: 4 });
    const centerFill = inspectPngRegionBuffer(bytes, { x: 52, y: 52, width: 16, height: 16 });

    expect(topStroke.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!topStroke.ok || !centerFill.ok) return;
    expect(topStroke.luma.darkPixels).toBeGreaterThan(0);
    expect(topStroke.luma.brightPixels).toBe(0);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(0);
    expect(centerFill.luma.darkPixels).toBe(0);
  });

  it("renders generated MotionIR shape borderRadius styles", async () => {
    const root = await writeGeneratedShapeBorderRadiusPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-border-radius-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const clippedCorner = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 8, height: 8 });
    const centerFill = inspectPngRegionBuffer(png, { x: 54, y: 54, width: 12, height: 12 });

    expect(result.ok).toBe(true);
    expect(clippedCorner.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!clippedCorner.ok || !centerFill.ok) return;
    expect(clippedCorner.luma.brightPixels).toBe(0);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(100);
  });

  it("renders generated MotionIR path shapes without filling their full layer box", async () => {
    const root = await writeGeneratedPathShapePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-path-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const outsidePath = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 12, height: 12 });
    const centerFill = inspectPngRegionBuffer(png, { x: 58, y: 68, width: 24, height: 18 });

    expect(result.ok).toBe(true);
    expect(outsidePath.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!outsidePath.ok || !centerFill.ok) return;
    expect(outsidePath.luma.brightPixels).toBe(0);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(180);
  });

  it("renders generated MotionIR freeform shapes with x-path geometry as paths", async () => {
    const root = await writeGeneratedPathShapePackage("freeform");
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-freeform-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const outsidePath = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 12, height: 12 });
    const centerFill = inspectPngRegionBuffer(png, { x: 58, y: 68, width: 24, height: 18 });

    expect(result.ok).toBe(true);
    expect(outsidePath.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!outsidePath.ok || !centerFill.ok) return;
    expect(outsidePath.luma.brightPixels).toBe(0);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(180);
  });

  it.each([
    ["ellipse", { outside: { x: 20, y: 20, width: 12, height: 12 }, inside: { x: 58, y: 50, width: 24, height: 20 } }],
    ["triangle", { outside: { x: 20, y: 20, width: 16, height: 16 }, inside: { x: 58, y: 72, width: 24, height: 24 } }],
    ["star", { outside: { x: 20, y: 20, width: 14, height: 14 }, inside: { x: 58, y: 58, width: 24, height: 24 } }]
  ] as const)("renders generated MotionIR %s shapes without filling their full layer box", async (shape, regions) => {
    const root = await writeGeneratedNonRectShapePackage(shape);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-generated-shape-${shape}-`));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const outsideShape = inspectPngRegionBuffer(png, regions.outside);
    const insideShape = inspectPngRegionBuffer(png, regions.inside);

    expect(result.ok).toBe(true);
    expect(outsideShape.ok).toBe(true);
    expect(insideShape.ok).toBe(true);
    if (!outsideShape.ok || !insideShape.ok) return;
    expect(outsideShape.luma.brightPixels).toBe(0);
    expect(insideShape.luma.brightPixels).toBeGreaterThan(180);
  });

  it("renders generated MotionIR shape shadows", async () => {
    const root = await writeGeneratedShapeShadowPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-shadow-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const bytes = await readFile(result.output.path);
    const shapeFill = inspectPngRegionBuffer(bytes, { x: 40, y: 38, width: 24, height: 24 });
    const shadow = inspectPngRegionBuffer(bytes, { x: 103, y: 36, width: 12, height: 40 });

    expect(result.ok).toBe(true);
    expect(shapeFill.ok).toBe(true);
    expect(shadow.ok).toBe(true);
    if (!shapeFill.ok || !shadow.ok) return;
    expect(shapeFill.luma.brightPixels).toBeGreaterThan(500);
    expect(shapeFill.luma.darkPixels).toBe(0);
    expect(shadow.luma.darkPixels).toBeGreaterThan(300);
    expect(shadow.luma.brightPixels).toBe(0);
  });

  it("renders generated MotionIR shadow component keyframes at capture time", async () => {
    const root = await writeGeneratedShapeShadowKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-shadow-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 1000, outDir });
    const startShadow = inspectPngRegionBuffer(await readFile(start.output.path), { x: 103, y: 36, width: 12, height: 40 });
    const endShadow = inspectPngRegionBuffer(await readFile(end.output.path), { x: 103, y: 36, width: 12, height: 40 });

    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startShadow.ok).toBe(true);
    expect(endShadow.ok).toBe(true);
    if (!startShadow.ok || !endShadow.ok) return;
    expect(startShadow.luma.darkPixels).toBe(0);
    expect(startShadow.luma.brightPixels).toBeGreaterThan(300);
    expect(endShadow.luma.darkPixels).toBeGreaterThan(300);
    expect(endShadow.luma.brightPixels).toBe(0);
  });

  it("captures generated MotionIR still frames in an explicit JPEG format", async () => {
    const root = await writeGeneratedMotionPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-browser-jpeg-"));
    const outputPath = join(outDir, "forced-format.png");
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, outputPath, format: "jpeg" });
    const bytes = await readFile(result.output.path);

    expect(result.ok).toBe(true);
    expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(result.output).toMatchObject({
      path: outputPath,
      format: "jpeg"
    });
  });

  it("captures generated MotionIR video layers as package media assets", async () => {
    const root = await writeGeneratedVideoPackage({ validVideo: true });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-video-browser-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 250, outDir });
    const bytes = await readFile(result.output.path);

    expect(result.ok).toBe(true);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      packageId: "pkg_generated_video_motion",
      lane: "browser",
      inputHashes: {
        motion: expect.stringMatching(/^[a-f0-9]{64}$/),
        "assets/clip.mp4": expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      output: {
        width: 320,
        height: 180,
        atMs: 250
      },
      warnings: []
    });
  });

  it("temporally samples real video frames within the stricter decoder budget", async () => {
    const root = await writeGeneratedVideoPackage({ validVideo: true, motionBlur: true });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-video-motion-blur-browser-"));
    tempDirs.push(root, outDir);

    const first = await renderMotionBrowserFrame(pkg, { atMs: 250, outDir });
    const repeated = await renderMotionBrowserFrame(pkg, { atMs: 250, outDir });

    expect(first.output.sha256).toBe(repeated.output.sha256);
    expect(first.output.temporalSampling).toMatchObject({
      totalSamples: 4,
      totalVideoSamples: 4,
      layers: [{ layerId: "clip", layerType: "video", samples: 4, shutterAngle: 180 }]
    });
    expect(first.receipt.warnings).toEqual([]);
  }, 45_000);

  it("renders generated MotionIR video source crop rectangles", async () => {
    const baselineRoot = await writeGeneratedVideoPackage({ validVideo: true });
    const croppedRoot = await writeGeneratedVideoPackage({
      validVideo: true,
      crop: { x: 16, y: 0, width: 16, height: 32 }
    });
    const baselinePkg = await loadMotionPackage(baselineRoot);
    const croppedPkg = await loadMotionPackage(croppedRoot);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-video-crop-browser-"));
    tempDirs.push(baselineRoot, croppedRoot, outDir);

    const baseline = await renderMotionBrowserFrame(baselinePkg, { atMs: 250, outDir });
    const cropped = await renderMotionBrowserFrame(croppedPkg, { atMs: 250, outDir });

    expect(cropped.ok).toBe(true);
    expect(cropped.output.sha256).not.toBe(baseline.output.sha256);
    expect(cropped.receipt.inputHashes).toMatchObject({
      "assets/clip.mp4": expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("rejects generated MotionIR video captures when media cannot settle deterministically", async () => {
    const root = await writeGeneratedVideoPackage({ validVideo: false });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-video-invalid-browser-"));
    tempDirs.push(root, outDir);

    await expect(renderMotionBrowserFrame(pkg, { atMs: 250, outDir })).rejects.toThrow(
      "Generated video layer clip failed to load metadata before deterministic capture."
    );
  });

  it("maps video playback-rate controls into deterministic media seek time", () => {
    expect(videoMediaTimeMsForLayer({
      startMs: 100,
      trimStartMs: 200,
      trimDurationMs: 300,
      playbackRate: 2,
      loop: true
    }, 225)).toBe(450);

    expect(videoMediaTimeMsForLayer({
      startMs: 100,
      trimStartMs: 200,
      playbackRate: 0.5
    }, 500)).toBe(400);

    expect(videoMediaTimeMsForLayer({
      startMs: 0,
      trimStartMs: 100,
      playbackRate: 1,
      keyframes: {
        playbackRate: [
          { atMs: 0, value: 1, easing: "linear" },
          { atMs: 1000, value: 3 }
        ]
      }
    }, 1000)).toBeCloseTo(2100, 6);

    expect(videoMediaTimeMsForLayer({
      startMs: 0,
      trimStartMs: 50,
      trimDurationMs: 500,
      loop: true,
      keyframes: {
        playbackRate: [
          { atMs: 0, value: 1, easing: "linear" },
          { atMs: 1000, value: 3 }
        ]
      }
    }, 1000)).toBeCloseTo(50, 6);
  });

  it("uses style width and height for generated text boxes", async () => {
    const root = await writeGeneratedTextBoxPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-box-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const bytes = await readFile(result.output.path);

    expect(result.ok).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(2500);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("renders generated MotionIR letter spacing keyframes at capture time", async () => {
    const root = await writeGeneratedTextLetterSpacingPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-letter-spacing-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 1000, outDir });
    const startFarGlyph = inspectPngRegionBuffer(await readFile(start.output.path), { x: 108, y: 20, width: 70, height: 58 });
    const endFarGlyph = inspectPngRegionBuffer(await readFile(end.output.path), { x: 108, y: 20, width: 70, height: 58 });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startFarGlyph.ok).toBe(true);
    expect(endFarGlyph.ok).toBe(true);
    if (!startFarGlyph.ok || !endFarGlyph.ok) return;
    expect(startFarGlyph.luma.brightPixels).toBe(0);
    expect(endFarGlyph.luma.brightPixels).toBeGreaterThan(10);
    expect(end.receipt.warnings).toEqual([]);
  });

  it("aligns generated MotionIR text inside explicit text boxes", async () => {
    const root = await writeGeneratedTextAlignPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-align-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const leftEdge = inspectPngRegionBuffer(await readFile(result.output.path), { x: 20, y: 20, width: 60, height: 50 });
    const rightEdge = inspectPngRegionBuffer(await readFile(result.output.path), { x: 150, y: 20, width: 70, height: 50 });

    expect(result.ok).toBe(true);
    expect(leftEdge.ok).toBe(true);
    expect(rightEdge.ok).toBe(true);
    if (!leftEdge.ok || !rightEdge.ok) return;
    expect(leftEdge.luma.brightPixels).toBe(0);
    expect(rightEdge.luma.brightPixels).toBeGreaterThan(10);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("vertically aligns generated MotionIR text inside explicit text boxes", async () => {
    const root = await writeGeneratedTextVerticalAlignPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-vertical-align-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const topEdge = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 200, height: 40 });
    const bottomEdge = inspectPngRegionBuffer(png, { x: 20, y: 74, width: 200, height: 34 });

    expect(result.ok).toBe(true);
    expect(topEdge.ok).toBe(true);
    expect(bottomEdge.ok).toBe(true);
    if (!topEdge.ok || !bottomEdge.ok) return;
    expect(topEdge.luma.brightPixels).toBe(0);
    expect(bottomEdge.luma.brightPixels).toBeGreaterThan(10);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("renders generated MotionIR text alignment keyframes at capture time", async () => {
    const root = await writeGeneratedTextAlignmentKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-alignment-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 1000, outDir });
    const startPng = await readFile(start.output.path);
    const endPng = await readFile(end.output.path);
    const startTopLeft = inspectPngRegionBuffer(startPng, { x: 20, y: 20, width: 60, height: 40 });
    const startBottomRight = inspectPngRegionBuffer(startPng, { x: 150, y: 74, width: 70, height: 34 });
    const endTopLeft = inspectPngRegionBuffer(endPng, { x: 20, y: 20, width: 60, height: 40 });
    const endBottomRight = inspectPngRegionBuffer(endPng, { x: 150, y: 74, width: 70, height: 34 });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startTopLeft.ok).toBe(true);
    expect(startBottomRight.ok).toBe(true);
    expect(endTopLeft.ok).toBe(true);
    expect(endBottomRight.ok).toBe(true);
    if (!startTopLeft.ok || !startBottomRight.ok || !endTopLeft.ok || !endBottomRight.ok) return;
    expect(startTopLeft.luma.brightPixels).toBeGreaterThan(10);
    expect(startBottomRight.luma.brightPixels).toBe(0);
    expect(endTopLeft.luma.brightPixels).toBe(0);
    expect(endBottomRight.luma.brightPixels).toBeGreaterThan(10);
    expect(end.receipt.warnings).toEqual([]);
  });

  it("renders generated MotionIR text box backgrounds", async () => {
    const root = await writeGeneratedTextBackgroundPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-background-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngRegionBuffer(await readFile(result.output.path), { x: 22, y: 22, width: 160, height: 56 });

    expect(result.ok).toBe(true);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.luma.brightPixels).toBeGreaterThan(6000);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("applies generated MotionIR text box padding before drawing text", async () => {
    const root = await writeGeneratedTextPaddingPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-padding-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const inset = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 18, height: 58 });
    const paddedText = inspectPngRegionBuffer(png, { x: 42, y: 42, width: 80, height: 42 });

    expect(result.ok).toBe(true);
    expect(inset.ok).toBe(true);
    expect(paddedText.ok).toBe(true);
    if (!inset.ok || !paddedText.ok) return;
    expect(inset.luma.darkPixels).toBe(0);
    expect(paddedText.luma.darkPixels).toBeGreaterThan(10);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("renders generated MotionIR text box borders with rounded corners", async () => {
    const root = await writeGeneratedTextBorderPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-border-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const topBorder = inspectPngRegionBuffer(png, { x: 50, y: 20, width: 90, height: 6 });
    const roundedCorner = inspectPngRegionBuffer(png, { x: 20, y: 20, width: 8, height: 8 });
    const innerFill = inspectPngRegionBuffer(png, { x: 44, y: 44, width: 90, height: 24 });

    expect(result.ok).toBe(true);
    expect(topBorder.ok).toBe(true);
    expect(roundedCorner.ok).toBe(true);
    expect(innerFill.ok).toBe(true);
    if (!topBorder.ok || !roundedCorner.ok || !innerFill.ok) return;
    expect(topBorder.luma.darkPixels).toBeGreaterThan(400);
    expect(topBorder.luma.brightPixels).toBeLessThan(20);
    expect(roundedCorner.luma.darkPixels).toBeGreaterThan(40);
    expect(roundedCorner.luma.brightPixels).toBe(0);
    expect(innerFill.luma.brightPixels).toBeGreaterThan(1000);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("renders generated MotionIR rectangular masks", async () => {
    const root = await writeGeneratedMaskedShapePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-mask-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.luma.brightPixels).toBeGreaterThan(7000);
    expect(quality.luma.brightPixels).toBeLessThan(10000);
  });

  it("renders bounded local-coordinate path masks through SVG clipping", async () => {
    const root = await writeGeneratedPathMaskedShapePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-path-mask-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const clippedLeft = inspectPngRegionBuffer(png, { x: 5, y: 65, width: 25, height: 25 });
    const visibleCenter = inspectPngRegionBuffer(png, { x: 70, y: 65, width: 20, height: 25 });

    expect(result.ok).toBe(true);
    expect(clippedLeft.ok).toBe(true);
    expect(visibleCenter.ok).toBe(true);
    if (!clippedLeft.ok || !visibleCenter.ok) return;
    expect(clippedLeft.luma.brightPixels).toBe(0);
    expect(clippedLeft.luma.darkPixels).toBeGreaterThan(500);
    expect(visibleCenter.luma.brightPixels).toBeGreaterThan(400);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("renders evenodd path-mask holes", async () => {
    const root = await writeGeneratedPathMaskedShapePackage({
      id: "evenodd",
      path: "M 10 20 H 170 V 120 H 10 Z M 60 45 H 120 V 95 H 60 Z",
      fillRule: "evenodd"
    });
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-evenodd-mask-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const outer = inspectPngRegionBuffer(png, { x: 15, y: 45, width: 20, height: 20 });
    const hole = inspectPngRegionBuffer(png, { x: 70, y: 45, width: 20, height: 20 });

    expect(outer.ok).toBe(true);
    expect(hole.ok).toBe(true);
    if (!outer.ok || !hole.ok) return;
    expect(outer.luma.brightPixels).toBeGreaterThan(350);
    expect(hole.luma.brightPixels).toBe(0);
    expect(hole.luma.darkPixels).toBeGreaterThan(350);
  });

  it.each(["alpha", "alpha-inverted", "luma", "luma-inverted"] as const)("renders explicit %s shape mattes without drawing the source layer", async (type) => {
    const root = await writeGeneratedShapeMattePackage(type);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-generated-${type}-matte-`));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const matteCenter = inspectPngRegionBuffer(png, { x: 25, y: 35, width: 30, height: 30 });
    const outsideMatte = inspectPngRegionBuffer(png, { x: 115, y: 35, width: 30, height: 30 });

    expect(matteCenter.ok).toBe(true);
    expect(outsideMatte.ok).toBe(true);
    if (!matteCenter.ok || !outsideMatte.ok) return;
    if (type === "alpha") {
      expect(matteCenter.luma.brightPixels).toBeGreaterThan(850);
      expect(outsideMatte.luma.brightPixels).toBe(0);
    } else if (type === "alpha-inverted") {
      expect(matteCenter.luma.brightPixels).toBe(0);
      expect(outsideMatte.luma.brightPixels).toBeGreaterThan(850);
    } else if (type === "luma") {
      expect(matteCenter.luma.avg).toBeGreaterThan(80);
      expect(matteCenter.luma.avg).toBeLessThan(180);
      expect(outsideMatte.luma.avg).toBe(0);
    } else {
      expect(matteCenter.luma.avg).toBeGreaterThan(80);
      expect(matteCenter.luma.avg).toBeLessThan(180);
      expect(outsideMatte.luma.avg).toBeGreaterThan(240);
    }
    expect(result.receipt.warnings).toEqual([]);
  });

  it("renders a non-zero-viewBox path as an alpha matte source", async () => {
    const root = await writeGeneratedShapeMattePackage("alpha", true);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-path-matte-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const png = await readFile(result.output.path);
    const center = inspectPngRegionBuffer(png, { x: 25, y: 15, width: 30, height: 25 });
    const lowerLeft = inspectPngRegionBuffer(png, { x: 5, y: 70, width: 25, height: 20 });

    expect(center.ok).toBe(true);
    expect(lowerLeft.ok).toBe(true);
    if (!center.ok || !lowerLeft.ok) return;
    expect(center.luma.brightPixels).toBeGreaterThan(700);
    expect(lowerLeft.luma.brightPixels).toBeLessThan(10);
  });

  it("renders generated MotionIR rectangular mask inset keyframes at capture time", async () => {
    const root = await writeGeneratedMaskInsetKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-mask-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const mid = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    expect(start.output.sha256).not.toBe(mid.output.sha256);
    const startLeft = inspectPngRegionBuffer(await readFile(start.output.path), { x: 45, y: 20, width: 25, height: 40 });
    const midLeft = inspectPngRegionBuffer(await readFile(mid.output.path), { x: 45, y: 20, width: 25, height: 40 });
    expect(startLeft.ok).toBe(true);
    expect(midLeft.ok).toBe(true);
    if (!startLeft.ok || !midLeft.ok) return;
    expect(startLeft.luma.brightPixels).toBe(0);
    expect(startLeft.luma.darkPixels).toBeGreaterThan(900);
    expect(midLeft.luma.brightPixels).toBeGreaterThan(900);
    expect(midLeft.luma.darkPixels).toBe(0);
  });

  it("renders generated MotionIR visual effects", async () => {
    const root = await writeGeneratedEffectShapePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-effect-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.luma.brightPixels).toBeLessThan(100);
    expect(quality.luma.range).toBeGreaterThan(100);
    expect(quality.edges.pixels).toBeGreaterThan(100);
  });

  it("renders generated MotionIR effect keyframes at capture time", async () => {
    const root = await writeGeneratedEffectKeyframeShapePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-effect-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const mid = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const startQuality = inspectPngBuffer(await readFile(start.output.path));
    const midQuality = inspectPngBuffer(await readFile(mid.output.path));

    expect(start.output.sha256).not.toBe(mid.output.sha256);
    expect(startQuality.ok).toBe(true);
    expect(midQuality.ok).toBe(true);
    if (!startQuality.ok || !midQuality.ok) return;
    expect(startQuality.luma.max).toBeGreaterThan(240);
    expect(midQuality.luma.max).toBeLessThan(180);
  });

  it("renders generated MotionIR wipe transitions", async () => {
    const root = await writeGeneratedWipeShapePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-wipe-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const mid = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const startQuality = inspectPngBuffer(await readFile(start.output.path));
    const midQuality = inspectPngBuffer(await readFile(mid.output.path));

    expect(startQuality.ok).toBe(true);
    expect(midQuality.ok).toBe(true);
    if (!startQuality.ok || !midQuality.ok) return;
    expect(startQuality.luma.brightPixels).toBeLessThan(100);
    expect(midQuality.luma.brightPixels).toBeGreaterThan(7000);
    expect(midQuality.luma.brightPixels).toBeLessThan(9000);
  });

  it("renders generated MotionIR blend modes for compositing parity", async () => {
    const root = await writeGeneratedBlendModePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-blend-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const overlap = inspectPngRegionBuffer(await readFile(result.output.path), { x: 48, y: 36, width: 80, height: 48 });

    expect(result.ok).toBe(true);
    expect(overlap.ok).toBe(true);
    if (!overlap.ok) return;
    expect(overlap.luma.max).toBeLessThan(190);
    expect(overlap.luma.brightPixels).toBe(0);
  });

  it("renders generated MotionIR blend mode keyframes at capture time", async () => {
    const root = await writeGeneratedBlendModeKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-blend-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 250, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 750, outDir });
    const startOverlap = inspectPngRegionBuffer(await readFile(start.output.path), { x: 48, y: 36, width: 80, height: 48 });
    const endOverlap = inspectPngRegionBuffer(await readFile(end.output.path), { x: 48, y: 36, width: 80, height: 48 });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startOverlap.ok).toBe(true);
    expect(endOverlap.ok).toBe(true);
    if (!startOverlap.ok || !endOverlap.ok) return;
    expect(startOverlap.luma.max).toBeGreaterThan(230);
    expect(endOverlap.luma.max).toBeLessThan(190);
    expect(endOverlap.luma.brightPixels).toBe(0);
  });

  it("renders generated MotionIR transform origins as layer-local anchors", async () => {
    const root = await writeGeneratedTransformOriginPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-origin-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const bytes = await readFile(result.output.path);
    const leftExpansion = inspectPngRegionBuffer(bytes, { x: 60, y: 42, width: 12, height: 12 });
    const rightExpansion = inspectPngRegionBuffer(bytes, { x: 145, y: 56, width: 10, height: 10 });

    expect(result.ok).toBe(true);
    expect(leftExpansion.ok).toBe(true);
    expect(rightExpansion.ok).toBe(true);
    if (!leftExpansion.ok || !rightExpansion.ok) return;
    expect(leftExpansion.luma.brightPixels).toBe(0);
    expect(rightExpansion.luma.brightPixels).toBeGreaterThan(0);
  });

  it("renders generated MotionIR transform-origin keyframes at capture time", async () => {
    const root = await writeGeneratedTransformOriginKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-origin-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 1000, outDir });
    const startLeft = inspectPngRegionBuffer(await readFile(start.output.path), { x: 60, y: 42, width: 12, height: 12 });
    const endLeft = inspectPngRegionBuffer(await readFile(end.output.path), { x: 60, y: 42, width: 12, height: 12 });
    const endRight = inspectPngRegionBuffer(await readFile(end.output.path), { x: 145, y: 56, width: 10, height: 10 });

    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startLeft.ok).toBe(true);
    expect(endLeft.ok).toBe(true);
    expect(endRight.ok).toBe(true);
    if (!startLeft.ok || !endLeft.ok || !endRight.ok) return;
    expect(startLeft.luma.brightPixels).toBeGreaterThan(0);
    expect(endLeft.luma.brightPixels).toBe(0);
    expect(endRight.luma.brightPixels).toBeGreaterThan(0);
  });

  it("renders generated MotionIR style radius keyframes at capture time", async () => {
    const root = await writeGeneratedStyleRadiusKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-style-radius-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 1000, outDir });
    const startCorner = inspectPngRegionBuffer(await readFile(start.output.path), { x: 20, y: 20, width: 5, height: 5 });
    const endCorner = inspectPngRegionBuffer(await readFile(end.output.path), { x: 20, y: 20, width: 5, height: 5 });
    const endCenter = inspectPngRegionBuffer(await readFile(end.output.path), { x: 58, y: 58, width: 8, height: 8 });

    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startCorner.ok).toBe(true);
    expect(endCorner.ok).toBe(true);
    expect(endCenter.ok).toBe(true);
    if (!startCorner.ok || !endCorner.ok || !endCenter.ok) return;
    expect(startCorner.luma.brightPixels).toBeGreaterThan(0);
    expect(endCorner.luma.brightPixels).toBe(0);
    expect(endCenter.luma.brightPixels).toBeGreaterThan(0);
  }, 45_000);

  it("renders generated MotionIR fill color keyframes at capture time", async () => {
    const root = await writeGeneratedFillColorKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-fill-color-keyframes-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 1000, outDir });
    const startCenter = inspectPngRegionBuffer(await readFile(start.output.path), { x: 48, y: 48, width: 24, height: 24 });
    const endCenter = inspectPngRegionBuffer(await readFile(end.output.path), { x: 48, y: 48, width: 24, height: 24 });

    expect(start.output.sha256).not.toBe(end.output.sha256);
    expect(startCenter.ok).toBe(true);
    expect(endCenter.ok).toBe(true);
    if (!startCenter.ok || !endCenter.ok) return;
    expect(startCenter.luma.brightPixels).toBe(0);
    expect(endCenter.luma.brightPixels).toBeGreaterThan(0);
    expect(endCenter.luma.max).toBeGreaterThan(startCenter.luma.max);
  }, 45_000);

  it("renders fixture text styles visibly in generated browser frames", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-lower-third-browser-visible-"));
    tempDirs.push(outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const quality = inspectPngBuffer(await readFile(result.output.path));

    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.luma.max).toBeGreaterThan(200);
    expect(quality.luma.brightPixels).toBeGreaterThan(1100);
  });

  it("treats generated MotionIR HTML and CSS strings as inert values", async () => {
    const root = await writeGeneratedCssInjectionPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-css-inert-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });

    expect(result.ok).toBe(true);
    expect(result.receipt.status).toBe("passed");
    expect(result.receipt.warnings).toEqual([]);
  });

  it("falls back instead of emitting invalid generated CSS hex colors", async () => {
    const root = await writeGeneratedInvalidHexColorPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-generated-invalid-hex-"));
    tempDirs.push(root, outDir);

    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const fill = inspectPngRegionBuffer(await readFile(result.output.path), { x: 20, y: 20, width: 40, height: 40 });

    expect(result.ok).toBe(true);
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    expect(fill.luma.brightPixels).toBeGreaterThan(1000);
  });

  it("renders generated MotionIR transform and opacity keyframes at capture time", async () => {
    const root = await writeGeneratedTransformOpacityKeyframePackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-keyframed-browser-"));
    tempDirs.push(root, outDir);

    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const mid = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const end = await renderMotionBrowserFrame(pkg, { atMs: 900, outDir });
    const startQuality = inspectPngBuffer(await readFile(start.output.path));
    const midQuality = inspectPngBuffer(await readFile(mid.output.path));
    const endQuality = inspectPngBuffer(await readFile(end.output.path));

    expect(start.output.sha256).not.toBe(mid.output.sha256);
    expect(mid.output.sha256).not.toBe(end.output.sha256);
    expect(startQuality.ok).toBe(true);
    expect(midQuality.ok).toBe(true);
    expect(endQuality.ok).toBe(true);
    if (!startQuality.ok || !midQuality.ok || !endQuality.ok) return;
    expect(startQuality.luma.brightPixels).toBeLessThan(100);
    expect(midQuality.luma.brightPixels).toBeGreaterThan(1100);
    expect(endQuality.luma.brightPixels).toBeLessThan(midQuality.luma.brightPixels);
  });

  it("retries transient Chromium screenshot readiness failures", async () => {
    const calls: string[] = [];
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-capture-retry-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "frame.png");
    const validPng = makeRgbaPngFixture(1, 1, [{ r: 12, g: 34, b: 56, a: 255 }]);
    const page = {
      async screenshot() {
        calls.push("screenshot");
        if (calls.length === 1) {
          throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
        }
        return validPng;
      },
      async waitForTimeout(ms: number) {
        calls.push(`wait:${ms}`);
      }
    };

    await captureDeterministicScreenshot(page, {
      path: outputPath,
      animations: "disabled",
      caret: "hide"
    });

    expect(calls).toEqual(["screenshot", "wait:50", "screenshot"]);
    expect(await readFile(outputPath)).toEqual(validPng);
  });

  it("retries an incomplete Chromium image before publishing the final pathname", async () => {
    const calls: string[] = [];
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-integrity-retry-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "frame.png");
    const validPng = makeRgbaPngFixture(1, 1, [{ r: 90, g: 80, b: 70, a: 255 }]);
    const page = {
      async screenshot() {
        calls.push("screenshot");
        return calls.length === 1 ? validPng.subarray(0, validPng.length - 6) : validPng;
      },
      async waitForTimeout(ms: number) {
        calls.push(`wait:${ms}`);
      }
    };

    await captureDeterministicScreenshot(page, {
      path: outputPath,
      animations: "disabled",
      caret: "hide"
    });

    expect(calls).toEqual(["screenshot", "wait:50", "screenshot"]);
    expect(await readFile(outputPath)).toEqual(validPng);
  });

  it("does not let the public screenshot API overwrite a caller-owned path", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-capture-existing-"));
    const outputPath = join(outDir, "frame.png");
    tempDirs.push(outDir);
    await writeFile(outputPath, "caller-owned-frame", "utf8");
    let captures = 0;

    await expect(captureDeterministicScreenshot({
      async screenshot() { captures += 1; return makeRgbaPngFixture(1, 1, [{ r: 1, g: 2, b: 3, a: 255 }]); },
      async waitForTimeout() {}
    }, { path: outputPath, animations: "disabled", caret: "hide" })).rejects.toMatchObject({ code: "derived_output_exists" });

    expect(captures).toBe(0);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("caller-owned-frame");
  });

  it("prefers explicit and Playwright Chromium executables before system browsers", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "shellx-motion-browser-cache-"));
    tempDirs.push(cacheRoot);
    await mkdir(join(cacheRoot, "chromium-999", "chrome-linux64"), {
      recursive: true,
      mode: 0o700,
    });
    const cachedChromium = join(cacheRoot, "chromium-999", "chrome-linux64", "chrome");
    await writeFile(cachedChromium, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(cachedChromium, 0o755);
    // The pin has to be a file that EXISTS. A pin naming a path with nothing at it is no longer a
    // first candidate followed by a fall-through — it fails closed, which the next test covers.
    const pinned = join(cacheRoot, "pinned-chrome");
    await writeFile(pinned, "#!/bin/sh\nexit 0\n", "utf8");

    await withBrowserEnv(
      {
        playwrightBrowsersPath: cacheRoot,
        browserPath: pinned
      },
      async () => {
        const candidates = browserExecutableCandidates();

        expect(candidates[0]).toBe(pinned);
        if (process.platform === "win32") {
          // A caller-created cache has no authoritative Windows ACL evidence, so discovery must
          // reject it while still honoring the explicit executable pin above.
          expect(candidates).not.toContain(join(cacheRoot, "chromium-999", "chrome-linux", "chrome"));
          expect(candidates).not.toContain(join(cacheRoot, "chromium-999", "chrome-linux64", "chrome"));
          return;
        }
        expect(candidates[1]).toBe(cachedChromium);
        expect(candidates.indexOf("/usr/bin/google-chrome")).toBeGreaterThan(1);
      }
    );
  });

  /**
   * A pin that cannot be honoured must stop the search, not slide to the next candidate.
   *
   * The launcher is the second half of the fix — reporting `broken` to `doctor` while the renderer
   * quietly launched something else would leave the substitution in place on the path that matters.
   * The error has to name the rejected value, because "set SHELLX_MOTION_BROWSER" is useless advice
   * to someone who just did.
   */
  it("refuses to launch a substitute browser when the pin names a path with no file at it", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "shellx-motion-browser-badpin-"));
    tempDirs.push(cacheRoot);
    await mkdir(join(cacheRoot, "chromium-999", "chrome-linux64"), { recursive: true, mode: 0o700 });
    await writeFile(join(cacheRoot, "chromium-999", "chrome-linux64", "chrome"), "#!/bin/sh\nexit 0\n", "utf8");

    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));

    await withBrowserEnv(
      { playwrightBrowsersPath: cacheRoot, browserPath: join(cacheRoot, "no-such-chrome") },
      async () => {
        // The cache entry is real and would have been launched by the old fall-through.
        expect(browserExecutableCandidates()).toEqual([]);
        await expect(createMotionBrowserRenderSession(pkg))
          .rejects.toThrow(/SHELLX_MOTION_BROWSER is set to .*no-such-chrome.*no file exists there/s);
      }
    );
  });

  it("fails honestly when a web layer references a blocked origin", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      source: "https://example.com/card.html",
      allowedOrigins: []
    };

    const result = await preflightBrowserPackage(pkg);

    expect(result).toMatchObject({
      ok: false,
      blockedOrigins: ["https://example.com"],
      warnings: ["Blocked undeclared browser origin: https://example.com"]
    });
  });

  it("treats package origin declarations as requests rather than network authority", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      source: "https://example.com/card.html",
      allowedOrigins: ["https://example.com"]
    };

    const result = await preflightBrowserPackage(pkg);

    expect(result).toMatchObject({
      ok: false,
      blockedOrigins: ["https://example.com"],
      warnings: ["Blocked host-unapproved browser origin: https://example.com"]
    });
  });

  it("accepts a host-approved public origin after resolving every address", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      source: "https://assets.example/card.html",
      allowedOrigins: ["https://assets.example"]
    };

    const result = await preflightBrowserPackage(pkg, {
      approvedOrigins: ["https://assets.example"],
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
      ]
    });

    expect(result).toEqual({
      ok: true,
      htmlEntries: [],
      blockedOrigins: [],
      warnings: []
    });
  });

  it("rejects a host-approved origin when any DNS answer is private", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      source: "https://mixed.example/card.html",
      allowedOrigins: ["https://mixed.example"]
    };

    const result = await preflightBrowserPackage(pkg, {
      approvedOrigins: ["https://mixed.example"],
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ]
    });

    expect(result).toMatchObject({
      ok: false,
      blockedOrigins: ["https://mixed.example"]
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("Blocked unsafe browser origin https://mixed.example: refusing to fetch private IP: 127.0.0.1")
    ]);
  });

  it("bounds host-approved browser DNS resolution", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      source: "https://slow.example/card.html",
      allowedOrigins: ["https://slow.example"]
    };

    const result = await preflightBrowserPackage(pkg, {
      approvedOrigins: ["https://slow.example"],
      resolutionTimeoutMs: 10,
      resolver: async () => new Promise(() => undefined)
    });

    expect(result).toMatchObject({
      ok: false,
      blockedOrigins: ["https://slow.example"]
    });
    expect(result.warnings[0]).toContain("Blocked unsafe browser origin https://slow.example:");
  });

  it("does not let workflow networkPolicy=allow bypass host approval", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      source: "https://example.com/card.html",
      allowedOrigins: ["https://example.com"]
    };
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-host-policy-"));
    tempDirs.push(outDir);

    await expect(renderBrowserFrame(pkg, {
      atMs: 0,
      outDir,
      workflow: {
        schema: "shellx-motion/browser-workflow@1",
        networkPolicy: "allow",
        steps: []
      }
    })).rejects.toThrow("Blocked host-unapproved browser origin: https://example.com");
  });
});

async function withBrowserEnv(
  env: { playwrightBrowsersPath: string; browserPath: string },
  run: () => Promise<void>
): Promise<void> {
  const playwrightKey = "PLAYWRIGHT" + "_BROWSERS_PATH";
  const browserKey = "SHELLX" + "_MOTION_BROWSER";
  const previous = {
    playwrightBrowsersPath: process.env[playwrightKey],
    browserPath: process.env[browserKey]
  };
  process.env[playwrightKey] = env.playwrightBrowsersPath;
  process.env[browserKey] = env.browserPath;
  try {
    await run();
  } finally {
    restoreEnv(playwrightKey, previous.playwrightBrowsersPath);
    restoreEnv(browserKey, previous.browserPath);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local test server address.");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function writeBrowserPackageWithExternalFileRequest(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-file-package-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "shellx-motion-browser-secret-"));
  tempDirs.push(externalRoot);
  const externalImagePath = join(externalRoot, "secret.svg");
  await mkdir(root, { recursive: true });
  await writeFile(externalImagePath, `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>`, "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_external_file_request",
      name: "External File Request",
      motion: "motion.json",
      assets: ["card.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_external_file_request",
      name: "External File Request",
      durationMs: 1000,
      fps: 30,
      width: 320,
      height: 180,
      background: "#ffffff",
      layers: [{ id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1000, allowedOrigins: [] }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "card.html"),
    `<!doctype html><html><body data-composition-id="external-file" data-start="0" data-duration="1000"><main data-layer-id="title" data-start="0" data-duration="1000" style="font: 32px sans-serif">Safe<img src="${pathToFileURL(externalImagePath).href}" width="32" height="32"></main></body></html>\n`
  );
  return root;
}

async function writeMultiLayerRuntimeRequestPackage(origin: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-multi-origin-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_multi_origin",
      name: "Browser Multi Origin",
      motion: "motion.json",
      assets: ["card.html", "data.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_browser_multi_origin",
      name: "Browser Multi Origin",
      durationMs: 1000,
      fps: 30,
      width: 320,
      height: 180,
      background: "#ffffff",
      layers: [
        { id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1000, allowedOrigins: [] },
        { id: "web-data", type: "web", source: "data.html", startMs: 0, durationMs: 1000, allowedOrigins: [origin] }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "card.html"),
    `<!doctype html><html><body data-composition-id="multi-origin" data-start="0" data-duration="1000"><main data-layer-id="title" data-start="0" data-duration="1000" style="font: 32px sans-serif">Runtime origin</main><script>const img = new Image(); img.src = ${JSON.stringify(`${origin}/pixel.svg`)}; document.body.appendChild(img);</script></body></html>\n`
  );
  await writeFile(
    join(root, "data.html"),
    `<!doctype html><html><body data-composition-id="declared-origin" data-start="0" data-duration="1000"></body></html>\n`
  );
  return root;
}

async function writeBrowserPackage(title: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_${title.toLowerCase().replace(/[^a-z]+/g, "_")}`,
      name: title,
      motion: "motion.json",
      assets: ["card.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_${title.toLowerCase().replace(/[^a-z]+/g, "_")}`,
      name: title,
      durationMs: 1000,
      fps: 30,
      width: 640,
      height: 360,
      background: "#ffffff",
      layers: [{ id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1000, allowedOrigins: [] }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "card.html"),
    `<!doctype html><html><body data-composition-id="diff" data-start="0" data-duration="1000"><main data-layer-id="title" data-start="0" data-duration="1000" style="font: 64px sans-serif">${title}</main></body></html>\n`
  );
  return root;
}

async function writeMultiCompositionBrowserPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-multi-composition-package-"));
  await mkdir(join(root, "compositions"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_multi_composition",
      name: "Browser Multi Composition",
      motion: "motion.json",
      assets: ["shell.html", "compositions/title.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_browser_multi_composition",
      name: "Browser Multi Composition",
      durationMs: 1000,
      fps: 30,
      width: 240,
      height: 160,
      background: "#000000",
      layers: [{ id: "web-card", type: "web", source: "shell.html", startMs: 0, durationMs: 1000, allowedOrigins: [] }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "shell.html"),
    [
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Multi Composition</title></head>",
      "<body data-composition-id=\"multi-composition\" data-start=\"0\" data-duration=\"1000\" style=\"margin:0;background:#000\">",
      "<main data-layer-id=\"slot\" data-start=\"0\" data-duration=\"1000\" data-composition-src=\"compositions/title.html\"></main>",
      "</body></html>"
    ].join(""),
    "utf8"
  );
  await writeFile(
    join(root, "compositions", "title.html"),
    [
      "<style>.mounted-title{position:absolute;left:24px;top:24px;width:180px;height:90px;background:#fff;color:#000;font:24px sans-serif;}</style>",
      "<div class=\"mounted-title\" data-layer-id=\"title-card\" data-start=\"0\" data-duration=\"1000\">Mounted</div>"
    ].join(""),
    "utf8"
  );
  return root;
}

async function writeBrowserReadinessPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-readiness-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_readiness",
      name: "Browser Readiness",
      motion: "motion.json",
      assets: ["card.html", "style.css"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_browser_readiness",
      name: "Browser Readiness",
      durationMs: 1200,
      fps: 30,
      width: 640,
      height: 360,
      background: "#ffffff",
      layers: [{ id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1200, allowedOrigins: [] }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "style.css"),
    [
      "@keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }",
      ".card { animation: slideIn 1.2s ease-out forwards; transition: opacity 500ms ease 150ms; opacity: 1; }"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(root, "card.html"),
    [
      "<!doctype html><html><head>",
      "<link rel=\"stylesheet\" href=\"style.css\">",
      "</head><body data-composition-id=\"readiness\" data-start=\"0\" data-duration=\"1200\">",
      "<main class=\"card\" data-layer-id=\"title\" data-start=\"0\" data-duration=\"1200\" style=\"font: 64px sans-serif\">Ready</main>",
      "</body></html>"
    ].join("")
  );
  return root;
}

async function writeInteractiveBrowserPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-interactive-browser-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_interactive_browser",
      name: "Interactive Browser",
      motion: "motion.json",
      assets: ["card.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_interactive_browser",
      name: "Interactive Browser",
      durationMs: 1000,
      fps: 30,
      width: 640,
      height: 360,
      background: "#ffffff",
      layers: [{ id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1000, allowedOrigins: [] }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "card.html"),
    `<!doctype html><html><body data-composition-id="interactive" data-start="0" data-duration="1000"><main style="width:640px;height:360px;background:#0f172a;color:white;font:48px sans-serif"><button id="swap" style="font:24px sans-serif;margin:40px">Swap</button><div id="state">Ready</div><script>document.querySelector("#swap").addEventListener("click",()=>{document.querySelector("#state").textContent="Clicked";document.body.style.background="#22c55e";});</script></main></body></html>\n`
  );
  return root;
}

async function writeGeneratedMotionPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_motion",
      name: "Generated Motion",
      motion: "motion.json",
      assets: ["assets/product.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated",
      name: "Generated Motion",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#f8fafc",
      layers: [
        {
          id: "product",
          type: "image",
          assetId: "asset_product",
          fit: "cover",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 24, width: 96, height: 96, opacity: 1 },
          style: { radius: "{radius.image}" }
        },
        {
          id: "title",
          type: "text",
          text: "Generated",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 140, y: 48, width: 150, height: 40, opacity: 1 },
          style: { fontSize: 24, color: "{color.ink}", fontWeight: 800 }
        },
        {
          id: "badge",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 140, y: 104, width: 112, height: 32, opacity: 1 },
          style: { fill: "{color.accent}", radius: 16 },
          label: { text: "Motion", style: { fontSize: 14, color: "#ffffff", fontWeight: 700 } }
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_product",
          kind: "image",
          source: { path: "assets/product.png", mimeType: "image/png" },
          hash: { sha256: "sample" },
          size: { width: 1, height: 1 }
        }
      ],
      designTokens: { color: { ink: "#111827", accent: "#f97316" }, radius: { image: 12 } },
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "product.png"), SAMPLE_PNG);
  return root;
}

async function writeGeneratedTransformOpacityKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-transform-opacity-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_transform_opacity",
      name: "Generated Transform Opacity",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_transform_opacity",
      name: "Generated Transform Opacity",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#101820",
      layers: [
        {
          id: "animated_panel",
          type: "shape",
          shape: "rectangle",
          fill: "#ffffff",
          startMs: 0,
          durationMs: 1000,
          width: 160,
          height: 60,
          transform: { x: 40, y: 60, scale: 1, rotation: 0 },
          keyframes: {
            "transform.x": [
              { atMs: 0, value: 20, easing: "ease-out" },
              { atMs: 500, value: 80 },
              { atMs: 1000, value: 120 }
            ],
            opacity: [
              { atMs: 0, value: 0, easing: "ease-out" },
              { atMs: 500, value: 1 },
              { atMs: 1000, value: 0.25 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedVisibilityPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-visibility-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_visibility",
      name: "Generated Visibility",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_visibility",
      name: "Generated Visibility",
      durationMs: 1000,
      fps: 24,
      width: 160,
      height: 90,
      background: "#000000",
      layers: [
        {
          id: "hidden-box",
          type: "shape",
          visible: false,
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 32, height: 32 },
          style: { fill: "#ffffff" }
        },
        {
          id: "visible-box",
          type: "shape",
          visible: true,
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 84, y: 20, width: 32, height: 32 },
          style: { fill: "#ffffff" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedTransparentOverlayPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-transparent-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_transparent",
      name: "Generated Transparent Overlay",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_transparent",
      name: "Generated Transparent Overlay",
      durationMs: 1000,
      fps: 24,
      width: 96,
      height: 64,
      layers: [
        {
          id: "pill",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 18, width: 48, height: 24 },
          style: { fill: "#ffffff", radius: 12 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedImageCropPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_image_crop_motion",
      name: "Generated Image Crop Motion",
      motion: "motion.json",
      assets: ["assets/stripe.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_image_crop",
      name: "Generated Image Crop Motion",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 88,
      background: "#000000",
      layers: [
        {
          id: "cropped",
          type: "image",
          assetId: "asset_stripe",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 24, width: 48, height: 40, opacity: 1 },
          fit: "fill",
          crop: { x: 1, y: 0, width: 1, height: 1 }
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_stripe",
          kind: "image",
          source: { path: "assets/stripe.png", mimeType: "image/png" },
          hash: { sha256: "sample" },
          size: { width: 3, height: 1 }
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "stripe.png"), makeRgbaPngFixture(3, 1, [
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 }
  ]));
  return root;
}

async function writeGeneratedImageCropFitPackage(input: {
  style: Record<string, unknown>;
  transform?: { x: number; y: number; width: number; height: number };
  crop?: { x: number; y: number; width: number; height: number };
  imageWidth?: number;
  imageHeight?: number;
  pixels?: Array<{ r: number; g: number; b: number; a: number }>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-fit-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  const transform = input.transform ?? { x: 20, y: 20, width: 8, height: 8 };
  const crop = input.crop ?? { x: 1, y: 1, width: 2, height: 2 };
  const imageWidth = input.imageWidth ?? 4;
  const imageHeight = input.imageHeight ?? 4;
  const pixels = input.pixels ?? [
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 }
  ];
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_image_crop_fit_motion",
      name: "Generated Image Crop Fit Motion",
      motion: "motion.json",
      assets: ["assets/checker.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_image_crop_fit",
      name: "Generated Image Crop Fit Motion",
      durationMs: 1000,
      fps: 24,
      width: 80,
      height: 80,
      background: "#000000",
      layers: [
        {
          id: "cropped-fit",
          type: "image",
          assetId: "asset_checker",
          startMs: 0,
          durationMs: 1000,
          transform,
          crop,
          style: input.style
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_checker",
          kind: "image",
          source: { path: "assets/checker.png", mimeType: "image/png" },
          hash: { sha256: "sample" },
          size: { width: imageWidth, height: imageHeight }
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "checker.png"), makeRgbaPngFixture(imageWidth, imageHeight, pixels));
  return root;
}

async function writeGeneratedImageCropKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-crop-keyframe-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_image_crop_keyframe_motion",
      name: "Generated Image Crop Keyframe Motion",
      motion: "motion.json",
      assets: ["assets/stripe.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_image_crop_keyframe",
      name: "Generated Image Crop Keyframe Motion",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 88,
      background: "#000000",
      layers: [
        {
          id: "cropped",
          type: "image",
          assetId: "asset_stripe",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 24, width: 48, height: 40, opacity: 1 },
          fit: "fill",
          crop: { x: 0, y: 0, width: 1, height: 1 },
          keyframes: {
            "crop.x": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 500, value: 1 }
            ]
          }
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_stripe",
          kind: "image",
          source: { path: "assets/stripe.png", mimeType: "image/png" },
          hash: { sha256: "sample" },
          size: { width: 2, height: 1 }
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "stripe.png"), makeRgbaPngFixture(2, 1, [
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 }
  ]));
  return root;
}

async function writeGeneratedImageBorderRadiusPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-border-radius-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_image_border_radius_motion",
      name: "Generated Image Border Radius Motion",
      motion: "motion.json",
      assets: ["assets/white.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_image_border_radius",
      name: "Generated Image Border Radius Motion",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "rounded-image",
          type: "image",
          assetId: "asset_white",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          fit: "fill",
          style: { borderRadius: 40 }
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_white",
          kind: "image",
          source: { path: "assets/white.png", mimeType: "image/png" },
          hash: { sha256: "sample" },
          size: { width: 2, height: 2 }
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "white.png"), makeRgbaPngFixture(2, 2, [
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 }
  ]));
  return root;
}

async function writeGeneratedImageAliasPackage(field: "assetRef" | "source" | "src"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-generated-image-${field}-package-`));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_image_${field}_motion`,
      name: `Generated Image ${field} Motion`,
      motion: "motion.json",
      assets: ["assets/white.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_image_${field}`,
      name: `Generated Image ${field} Motion`,
      durationMs: 1000,
      fps: 24,
      width: 100,
      height: 80,
      background: "#000000",
      layers: [
        {
          id: `${field}-image`,
          type: "image",
          [field]: "assets/white.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 40, height: 40 },
          fit: "fill"
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "white.png"), makeRgbaPngFixture(2, 2, [
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 }
  ]));
  return root;
}

async function writeGeneratedImageObjectFitPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-image-object-fit-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_image_object_fit_motion",
      name: "Generated Image Object Fit Motion",
      motion: "motion.json",
      assets: ["assets/wide.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_image_object_fit",
      name: "Generated Image Object Fit Motion",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "object-fit-image",
          type: "image",
          assetId: "asset_wide",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          style: { objectFit: "contain" }
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_wide",
          kind: "image",
          source: { path: "assets/wide.png", mimeType: "image/png" },
          hash: { sha256: "sample" },
          size: { width: 2, height: 1 }
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(join(root, "assets", "wide.png"), makeRgbaPngFixture(2, 1, [
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 }
  ]));
  return root;
}

async function writeGeneratedParticlePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-particle-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_particles",
      name: "Generated Particles",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_particles",
      name: "Generated Particles",
      durationMs: 2000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#030712",
      layers: [
        {
          id: "spark-field",
          type: "particles",
          startMs: 0,
          durationMs: 2000,
          transform: { x: 0, y: 0, width: 320, height: 180, opacity: 1 },
          emitter: {
            seed: 424242,
            count: 160,
            lifetimeMs: 1800,
            shape: "circle",
            color: "#ff006e",
            secondaryColor: "#00d4ff",
            minSize: 2,
            maxSize: 8,
            minSpeed: 25,
            maxSpeed: 150,
            direction: -90,
            spread: 110,
            gravity: 140,
            fadeOut: true,
            field: {
              schema: "shellx-motion/particle-field@1",
              sources: [
                { kind: "radial", centerX: 0.5, centerY: 0.42, strength: 0.45, softening: 0.2 },
                { kind: "vortex", centerX: 0.5, centerY: 0.42, strength: 0.25, softening: 0.14 }
              ]
            }
          },
          effects: { glow: { radius: 5, color: "#00d4ff" } },
          blendMode: "screen"
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedCameraPackage(depthEnabled = false): Promise<string> {
  const suffix = depthEnabled ? "_depth" : "";
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-camera-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_camera${suffix}`,
      name: "Generated Camera",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_camera${suffix}`,
      name: "Generated Camera",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#030712",
      layers: [
        {
          id: "camera-main",
          type: "camera",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, originX: 160, originY: 90 },
          keyframes: {
            "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 40, easing: "ease-in-out" }],
            "transform.y": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 15, easing: "ease-in-out" }],
            "transform.scale": [{ atMs: 0, value: 1 }, { atMs: 1000, value: 1.35, easing: "ease-in-out" }],
            "transform.rotation": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 5, easing: "ease-in-out" }]
          }
        },
        {
          id: "gradient-field",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: -80, y: -45, width: 480, height: 270 },
          ...(depthEnabled ? { depth: -0.75 } : {}),
          gradient: {
            type: "linear",
            angle: 35,
            stops: [
              { offset: 0, color: "#0f172a" },
              { offset: 0.5, color: "#7c3aed" },
              { offset: 1, color: "#00d4ff" }
            ]
          }
        },
        {
          id: "orb-left",
          type: "shape",
          shape: "ellipse",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 28, y: 34, width: 72, height: 72 },
          fill: "#ff006e",
          effects: { glow: { radius: 14, color: "#ff006e" } },
          ...(depthEnabled ? { depth: 1.5 } : { blendMode: "screen" })
        },
        {
          id: "title",
          type: "text",
          text: "CAMERA PUSH",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 112, y: 74, width: 180, height: 42 },
          ...(depthEnabled ? { depth: 0.2 } : {}),
          style: { color: "#ffffff", fontFamily: "sans-serif", fontSize: 22, fontWeight: 800 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedMotionBlurPackage(enabled: boolean): Promise<string> {
  const suffix = enabled ? "blurred" : "sharp";
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-generated-motion-blur-${suffix}-package-`));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_motion_blur_${suffix}`,
      name: `Generated Motion Blur ${suffix}`,
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_motion_blur_${suffix}`,
      name: `Generated Motion Blur ${suffix}`,
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#030712",
      layers: [
        {
          id: "backdrop",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 320, height: 180 },
          gradient: {
            type: "linear",
            angle: 120,
            stops: [{ offset: 0, color: "#030712" }, { offset: 1, color: "#172554" }]
          }
        },
        {
          id: "runner",
          type: "text",
          text: "●",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 62, width: 48, height: 48 },
          style: { color: "#ffffff", fontFamily: "sans-serif", fontSize: 48, fontWeight: 700 },
          effects: {
            glow: { radius: 12, color: "#00d4ff" },
            ...(enabled ? { motionBlur: { samples: 8, shutterAngle: 360 } } : {})
          },
          keyframes: {
            "transform.x": [{ atMs: 0, value: 24 }, { atMs: 1000, value: 264, easing: "linear" }],
            "transform.rotation": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 360, easing: "linear" }]
          }
        },
        {
          id: "caption",
          type: "text",
          text: "TEMPORAL / 8 SAMPLES / 360°",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 132, width: 272, height: 28 },
          style: { color: "#ffffff", fontFamily: "sans-serif", fontSize: 14, fontWeight: 700, letterSpacing: 1 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedFilmAdjustmentPackage(enabled: boolean): Promise<string> {
  const suffix = enabled ? "treated" : "clean";
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-generated-film-adjustment-${suffix}-package-`));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_film_adjustment_${suffix}`,
      name: `Generated Film Adjustment ${suffix}`,
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_film_adjustment_${suffix}`,
      name: `Generated Film Adjustment ${suffix}`,
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#030712",
      layers: [
        {
          id: "color-field",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 320, height: 180 },
          gradient: {
            type: "linear",
            angle: 125,
            stops: [
              { offset: 0, color: "#f97316" },
              { offset: 0.45, color: "#7c3aed" },
              { offset: 1, color: "#0369a1" }
            ]
          }
        },
        {
          id: "title",
          type: "text",
          text: "FILM / GRAIN",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 56, y: 70, width: 208, height: 42 },
          style: { color: "#ffffff", fontFamily: "sans-serif", fontSize: 28, fontWeight: 900, letterSpacing: 2 }
        },
        ...(enabled ? [{
          id: "film-look",
          type: "adjustment",
          startMs: 0,
          durationMs: 1000,
          effects: {
            vignette: { amount: 0.85, softness: 0.7, color: "#000000" },
            filmGrain: { amount: 0.65, size: 2, seed: 8675309 }
          }
        }] : [])
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedShaderPackage(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shader-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_generated_shader",
    name: "Generated Shader",
    motion: "motion.json",
    assets: ["assets/plasma.glsl"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_generated_shader",
    name: "Generated Shader",
    durationMs: 1000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#020617",
    layers: [{
      id: "plasma",
      type: "shader",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      shader: {
        schema: "shellx-motion/shader-plugin@1",
        language: "glsl-es-100-expression",
        fragmentAssetId: "shader_plasma",
        seed: 42,
        uniforms: { u_speed: 0.75 },
        fallbackColor: "#111827"
      },
      keyframes: {
        "shader.uniforms.u_speed": [
          { atMs: 0, value: 0.25, easing: "linear" },
          { atMs: 1000, value: 1.5 }
        ]
      }
    }],
    assets: [{
      id: "shader_plasma",
      type: "shader",
      source: { path: "assets/plasma.glsl", mimeType: "text/x-shellx-motion-glsl" }
    }],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  await writeFile(join(root, "assets", "plasma.glsl"), source);
  return root;
}

async function writeGeneratedScene3DPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-scene3d-package-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_generated_scene3d",
    name: "Generated Scene 3D",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_generated_scene3d",
    name: "Generated Scene 3D",
    durationMs: 1000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#020617",
    layers: [{
      id: "stage",
      type: "scene3d",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      scene3d: {
        schema: "shellx-motion/scene3d@1",
        camera: { position: [4.5, 3.2, 6.5], target: [0, 0, 0], fovDeg: 42, near: 0.1, far: 100, orbitDegPerSecond: 24 },
        lighting: { ambient: 0.24, direction: [-0.4, -0.9, -0.5], intensity: 1.4, color: "#dbeafe" },
        backgroundColor: "#020617",
        objects: [
          { id: "floor", primitive: "plane", position: [0, -1.15, 0], rotationDeg: [0, 0, 0], scale: 5.5, color: "#172554", emissive: 0.08 },
          { id: "cube", primitive: "box", position: [-1.05, 0, 0], rotationDeg: [18, 24, 0], scale: 1.25, spinDegPerSecond: [16, 55, 0], color: "#22d3ee", emissive: 0.12 },
          { id: "spire", primitive: "pyramid", position: [1.2, -0.05, 0.1], rotationDeg: [0, -18, 0], scale: 1.45, spinDegPerSecond: [0, -38, 0], color: "#f472b6", emissive: 0.18 }
        ]
      }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}

async function writeGeneratedRainEnvironmentPackage(seed = 20260713): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-rain-environment-package-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_generated_rain_environment",
    name: "Generated Rain Environment",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_generated_rain_environment",
    name: "Generated Rain Environment",
    durationMs: 2000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#050A12",
    layers: [{
      id: "rain-stage",
      type: "environment",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      environment: {
        schema: "shellx-motion/environment@1",
        kind: "rain",
        seed,
        quality: "cinematic",
        mode: "scene",
        intensity: 0.86,
        wind: 0.22,
        dropSpeed: 1.45,
        dropLength: 1.18,
        depthLayers: 4,
        color: "#C8F1FF",
        backgroundColor: "#050A12",
        lightColor: "#67E8F9",
        accentColor: "#FB7185",
        ground: {
          horizon: 0.43,
          wetness: 0.94,
          roughness: 0.22,
          rippleAmount: 0.82,
          splashAmount: 0.68,
          reflectionStrength: 0.9
        },
        atmosphere: { mist: 0.48, lensDroplets: 0.36 }
      }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}

async function writeGeneratedFootageRainEnvironmentPackage(sourceAware: boolean, effectMasked = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-footage-rain-environment-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `pkg_generated_${sourceAware ? "footage" : "synthetic"}_rain_environment`,
    name: "Generated Footage Rain Environment",
    motion: "motion.json",
    assets: ["assets/scene.png", ...(effectMasked ? ["assets/effect-mask.png"] : [])],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: `motion_generated_${sourceAware ? "footage" : "synthetic"}_rain_environment`,
    name: "Generated Footage Rain Environment",
    durationMs: 2000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#050A12",
    layers: [{
      id: "footage",
      type: "image",
      assetId: "scene",
      fit: "fill",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 }
    }, ...(effectMasked ? [{
      id: "effect-mask",
      type: "image",
      assetId: "effect-mask",
      fit: "fill",
      opacity: 0,
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 }
    }] : []), {
      id: "rain-stage",
      type: "environment",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 },
      environment: {
        schema: "shellx-motion/environment@1",
        kind: "rain",
        seed: 20260713,
        quality: "cinematic",
        mode: "scene",
        ...(sourceAware ? { sceneSourceLayerId: "footage" } : {}),
        ...(effectMasked ? { effectMaskLayerId: "effect-mask" } : {}),
        intensity: 0.86,
        wind: 0.22,
        dropSpeed: 1.45,
        dropLength: 1.18,
        depthLayers: 4,
        color: "#C8F1FF",
        backgroundColor: "#050A12",
        lightColor: "#67E8F9",
        accentColor: "#FB7185",
        ground: { horizon: 0.43, wetness: 0.94, roughness: 0.22, rippleAmount: 0.82, splashAmount: 0.68, reflectionStrength: 0.9 },
        atmosphere: { mist: 0.48, lensDroplets: 0.36 }
      }
    }],
    assets: [{
      schema: "shellx-motion/asset@1",
      id: "scene",
      kind: "image",
      source: { path: "assets/scene.png", mimeType: "image/png" },
      hash: { sha256: "generated-test-scene" },
      size: { width: 320, height: 180 }
    }, ...(effectMasked ? [{
      schema: "shellx-motion/asset@1",
      id: "effect-mask",
      kind: "image",
      source: { path: "assets/effect-mask.png", mimeType: "image/png" },
      hash: { sha256: "generated-test-effect-mask" },
      size: { width: 320, height: 180 }
    }] : [])],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  await writeFile(join(root, "assets", "scene.png"), makeRgbaPngFixture(320, 180,
    Array.from({ length: 320 * 180 }, (_, index) => {
      const x = index % 320;
      const y = Math.floor(index / 320);
      const horizon = y < 92;
      const glow = Math.max(0, 1 - Math.abs(x - 226) / 82);
      return horizon
        ? { r: Math.round(18 + glow * 178), g: Math.round(34 + glow * 96), b: Math.round(74 + glow * 62), a: 255 }
        : { r: Math.round(9 + glow * 72), g: Math.round(20 + glow * 46), b: Math.round(31 + glow * 38), a: 255 };
    })
  ));
  if (effectMasked) {
    await writeFile(join(root, "assets", "effect-mask.png"), makeRgbaPngFixture(320, 180,
      Array.from({ length: 320 * 180 }, (_, index) => {
        const x = index % 320;
        const permitted = x >= 160 ? 255 : 0;
        return { r: permitted, g: permitted, b: permitted, a: 255 };
      })
    ));
  }
  return root;
}

async function writeGeneratedWaterEnvironmentPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-water-environment-package-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_generated_water_environment",
    name: "Generated Water Environment",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_generated_water_environment",
    name: "Generated Water Environment",
    durationMs: 2000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#07111F",
    layers: [{
      id: "water-stage",
      type: "environment",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      environment: {
        schema: "shellx-motion/environment@1",
        kind: "water",
        seed: 20260714,
        quality: "cinematic",
        mode: "scene",
        backgroundColor: "#07111F",
        shallowColor: "#16B8C8",
        deepColor: "#03294A",
        reflectionColor: "#BDEBFF",
        foamColor: "#ECFEFF",
        surface: { horizon: 0.58, waveScale: 4.6, waveHeight: 0.48, waveSpeed: 0.72, direction: 18, choppiness: 0.42, waveOctaves: 4 },
        optics: { reflectionStrength: 0.78, refractionStrength: 0.66, fresnel: 0.72, caustics: 0.58, clarity: 0.7, foam: 0.26 }
      }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}

async function writeGeneratedSnowEnvironmentPackage(seed = 20260715): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-snow-environment-package-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_generated_snow_environment",
    name: "Generated Snow Environment",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_generated_snow_environment",
    name: "Generated Snow Environment",
    durationMs: 2000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#07111F",
    layers: [{
      id: "snow-stage",
      type: "environment",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      environment: {
        schema: "shellx-motion/environment@1",
        kind: "snow",
        seed,
        quality: "cinematic",
        mode: "scene",
        backgroundColor: "#07111F",
        snowColor: "#F8FCFF",
        shadowColor: "#8BA7C1",
        lightColor: "#C7E7FF",
        fall: { intensity: 0.78, speed: 0.72, wind: 0.24, turbulence: 0.56, flakeSize: 1.18, depthLayers: 4, focusFalloff: 0.68 },
        ground: { horizon: 0.62, accumulation: 0.76, drift: 0.58, contactAmount: 0.52 },
        atmosphere: { haze: 0.34, depthFade: 0.62 }
      }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}

async function writeGeneratedFogEnvironmentPackage(seed = 20260717): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-fog-environment-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `pkg_generated_fog_environment_${seed}`,
    name: "Generated Fog Environment",
    motion: "motion.json",
    assets: ["assets/scene.png"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: `motion_generated_fog_environment_${seed}`,
    name: "Generated Fog Environment",
    durationMs: 2000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#07111F",
    layers: [{
      id: "footage",
      type: "image",
      assetId: "scene",
      fit: "fill",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 }
    }, {
      id: "fog-stage",
      type: "environment",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 },
      environment: {
        schema: "shellx-motion/environment@1",
        kind: "fog",
        seed,
        quality: "cinematic",
        mode: "scene",
        sceneSourceLayerId: "footage",
        backgroundColor: "#07111F",
        fogColor: "#AFC8D4",
        lightColor: "#DDF7FF",
        fog: { density: 0.68, speed: 0.38, scale: 5.2, turbulence: 0.64, height: 0.82, depthLayers: 4, lightStrength: 0.54 }
      }
    }],
    assets: [{
      schema: "shellx-motion/asset@1",
      id: "scene",
      kind: "image",
      source: { path: "assets/scene.png", mimeType: "image/png" },
      hash: { sha256: "generated-fog-scene" },
      size: { width: 320, height: 180 }
    }],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  await writeFile(join(root, "assets", "scene.png"), makeRgbaPngFixture(320, 180,
    Array.from({ length: 320 * 180 }, (_, index) => {
      const x = index % 320;
      const y = Math.floor(index / 320);
      const vertical = y / 179;
      const lamp = Math.max(0, 1 - Math.abs(x - 214) / 72);
      return {
        r: Math.round(8 + lamp * 128 + vertical * 16),
        g: Math.round(18 + lamp * 112 + vertical * 22),
        b: Math.round(35 + lamp * 92 + vertical * 30),
        a: 255
      };
    })
  ));
  return root;
}

async function writeGeneratedGradientPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-gradient-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_gradient",
      name: "Generated Gradient",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion", "canvas", "cut"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_gradient",
      name: "Generated Gradient",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#05010c",
      layers: [
        {
          id: "gradient-field",
          type: "shape",
          shape: "rounded-rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 280, height: 140, opacity: 1 },
          style: { radius: 24 },
          gradient: {
            type: "linear",
            angle: 25,
            stops: [
              { offset: 0, color: "#14002f" },
              { offset: 0.45, color: "#ff006e" },
              { offset: 1, color: "#00d4ff" }
            ]
          },
          effects: { glow: { radius: 4, color: "#ff006e" } },
          keyframes: {
            "gradient.angle": [
              { atMs: 0, value: 25, easing: "ease-in-out" },
              { atMs: 1000, value: 205 }
            ],
            "effects.glow.radius": [
              { atMs: 0, value: 4, easing: "ease-out" },
              { atMs: 1000, value: 24 }
            ],
            "effects.glow.color": [
              { atMs: 0, value: "#ff006e", easing: "linear" },
              { atMs: 1000, value: "#00d4ff" }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedShapeStrokePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-stroke-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_shape_stroke_motion",
      name: "Generated Shape Stroke Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_shape_stroke",
      name: "Generated Shape Stroke Motion",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "outlined-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          style: { fill: "#ffffff", stroke: "#ff0000", width: 8 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedShapeBorderRadiusPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-border-radius-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_shape_border_radius_motion",
      name: "Generated Shape Border Radius Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_shape_border_radius",
      name: "Generated Shape Border Radius Motion",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "rounded-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          style: { fill: "#ffffff", borderRadius: 40 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedPathShapePackage(shape: "path" | "freeform" = "path"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-generated-shape-${shape}-package-`));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_shape_${shape}_motion`,
      name: `Generated Shape ${shape} Motion`,
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_shape_${shape}`,
      name: `Generated Shape ${shape} Motion`,
      durationMs: 1000,
      fps: 24,
      width: 150,
      height: 140,
      background: "#000000",
      layers: [
        {
          id: "route-badge",
          type: "shape",
          shape,
          "x-path": "M 10 50 L 50 10 L 90 50 L 70 90 L 30 90 Z",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 100, height: 100 },
          style: { fill: "#ffffff", stroke: "#00aaff", width: 6 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedNonRectShapePackage(shape: "ellipse" | "triangle" | "star"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-generated-shape-${shape}-package-`));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_shape_${shape}_motion`,
      name: `Generated ${shape} Shape Motion`,
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_shape_${shape}`,
      name: `Generated ${shape} Shape Motion`,
      durationMs: 1000,
      fps: 24,
      width: 150,
      height: 140,
      background: "#000000",
      layers: [
        {
          id: `${shape}-badge`,
          type: "shape",
          shape,
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 100, height: 100 },
          style: { fill: "#ffffff" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedShapeShadowPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-shadow-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_shape_shadow_motion",
      name: "Generated Shape Shadow Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_shape_shadow",
      name: "Generated Shape Shadow Motion",
      durationMs: 1000,
      fps: 24,
      width: 140,
      height: 110,
      background: "#ffffff",
      layers: [
        {
          id: "shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 80, height: 60 },
          style: { fill: "#ffffff", shadow: { x: 16, y: 0, blur: 0, spread: 0, color: "#000000" } }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedShapeShadowKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-shadow-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_shape_shadow_keyframe_motion",
      name: "Generated Shape Shadow Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_shape_shadow_keyframe",
      name: "Generated Shape Shadow Keyframe Motion",
      durationMs: 1100,
      fps: 24,
      width: 140,
      height: 110,
      background: "#ffffff",
      layers: [
        {
          id: "shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 24, width: 80, height: 60 },
          style: { fill: "#ffffff", shadow: { x: 0, y: 0, blur: 0, spread: 0, color: "#000000" } },
          keyframes: {
            "style.shadow.x": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedVideoPackage(options: { validVideo: boolean; crop?: { x: number; y: number; width: number; height: number }; motionBlur?: boolean }): Promise<string> {
  const suffix = options.motionBlur ? "_motion_blur" : "";
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-video-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_video_motion${suffix}`,
      name: "Generated Video Motion",
      motion: "motion.json",
      assets: ["assets/clip.mp4"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_video${suffix}`,
      name: "Generated Video Motion",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#0f172a",
      layers: [
        {
          id: "clip",
          type: "video",
          assetId: "asset_clip",
          fit: "cover",
          startMs: 0,
          durationMs: 1000,
          trimStartMs: 100,
          ...(options.crop ? { crop: options.crop } : {}),
          transform: { x: 24, y: 24, width: 160, height: 96, opacity: 1 },
          style: { radius: 8 },
          ...(options.motionBlur ? {
            effects: { motionBlur: { samples: 4, shutterAngle: 180 } },
            keyframes: { "transform.x": [{ atMs: 0, value: 24 }, { atMs: 1000, value: 120 }] }
          } : {})
        },
        {
          id: "title",
          type: "text",
          text: "Video",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 200, y: 64, width: 92, height: 40, opacity: 1 },
          style: { fontSize: 24, color: "#ffffff", fontWeight: 800 }
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_clip",
          kind: "video",
          source: { path: "assets/clip.mp4", mimeType: "video/mp4" },
          hash: { sha256: "sample" },
          size: { width: 160, height: 96 }
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  if (options.validVideo) {
    await writeTinyMp4(join(root, "assets", "clip.mp4"));
  } else {
    await writeFile(join(root, "assets", "clip.mp4"), Buffer.from("fake mp4 bytes", "utf8"));
  }
  return root;
}

async function writeTinyMp4(path: string): Promise<void> {
  await execFileAsync(resolveTestFfmpegExecutable(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=32x32:rate=24:duration=0.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    path
  ]);
}

function resolveTestFfmpegExecutable(): string {
  return process.env.SHELLX_MOTION_FFMPEG?.trim() || discoverShellxFamilyFfmpegTool("ffmpeg.exe") || "ffmpeg";
}

function discoverShellxFamilyFfmpegTool(fileName: "ffmpeg.exe"): string | null {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const candidates = ["ShellX Motion", "ShellX Cut", "ShellX Canvas"].flatMap((productDir) => {
    const toolRoot = join(localAppData, productDir, "tools", "ffmpeg");
    return [
      join(toolRoot, "bin", fileName),
      ...readDirectoryNames(toolRoot).map((entry) => join(toolRoot, entry, "bin", fileName))
    ];
  });
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function writeGeneratedCssInjectionPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-css-injection-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_css_injection",
      name: "Generated CSS Injection",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_css_injection",
      name: "Generated CSS Injection",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#ffffff;background-image:url(https://evil.example/bg.png)",
      layers: [
        {
          id: "shape",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 80, opacity: 1 },
          style: {
            fill: "#ffffff;background-image:url(https://evil.example/fill.png)",
            radius: "8px;background-image:url(https://evil.example/radius.png)"
          }
        },
        {
          id: "title",
          type: "text",
          text: "Safe </div><img src=\"https://evil.example/text.png\"><script>document.body.dataset.injected='true'</script>",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 150, y: 32, width: 150, height: 96, opacity: 1 },
          style: {
            fontFamily: "Inter, Arial;background-image:url(https://evil.example/font.png)",
            fontSize: "24px;background-image:url(https://evil.example/size.png)",
            color: "#111827;background-image:url(https://evil.example/color.png)"
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedInvalidHexColorPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-invalid-hex-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_invalid_hex",
      name: "Generated Invalid Hex",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_invalid_hex",
      name: "Generated Invalid Hex",
      durationMs: 1000,
      fps: 24,
      width: 120,
      height: 80,
      background: "#000000",
      layers: [
        {
          id: "shape",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 16, y: 16, width: 48, height: 48, opacity: 1 },
          style: { fill: "#12345" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedMaskedShapePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-mask-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_mask_motion",
      name: "Generated Mask Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_mask",
      name: "Generated Mask Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "masked_panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 160, height: 100, opacity: 1 },
          style: { fill: "#ffffff" },
          mask: {
            type: "rect",
            inset: { top: 0, right: 80, bottom: 0, left: 0 }
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedPathMaskedShapePackage(options: {
  id?: string;
  path?: string;
  fillRule?: "nonzero" | "evenodd";
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-path-mask-package-"));
  const suffix = options.id ?? "triangle";
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_path_mask_${suffix}_motion`,
      name: "Generated Path Mask Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_path_mask_${suffix}`,
      name: "Generated Path Mask Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "path_masked_panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 160, height: 100, opacity: 1 },
          style: { fill: "#ffffff" },
          mask: {
            type: "path",
            path: options.path ?? "M 10 20 L 170 20 L 90 120 Z",
            viewBox: "10 20 160 100",
            fillRule: options.fillRule ?? "nonzero"
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedShapeMattePackage(type: "alpha" | "alpha-inverted" | "luma" | "luma-inverted", pathSource = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-shape-matte-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: `pkg_generated_${pathSource ? "path_" : ""}${type}_matte_motion`,
      name: "Generated Shape Matte Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_generated_${pathSource ? "path_" : ""}${type}_matte`,
      name: "Generated Shape Matte Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "matte_source",
          type: "shape",
          shape: pathSource ? "path" : "ellipse",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 80, height: 100 },
          style: { fill: "#808080" },
          ...(pathSource ? { "x-path": "M 10 20 L 170 20 L 90 120 Z", "x-path-viewBox": "10 20 160 100" } : {})
        },
        {
          id: "matte_consumer",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 160, height: 100 },
          style: { fill: "#ffffff" },
          matte: { type, sourceLayerId: "matte_source" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedMaskInsetKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-mask-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_mask_keyframe_motion",
      name: "Generated Mask Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_mask_keyframe",
      name: "Generated Mask Keyframe Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "masked_panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 160, height: 100, opacity: 1 },
          style: { fill: "#ffffff" },
          mask: {
            type: "rect",
            inset: { top: 0, right: 0, bottom: 0, left: 80 }
          },
          keyframes: {
            "mask.inset.left": [
              { atMs: 0, value: 80, easing: "linear" },
              { atMs: 1000, value: 0 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedEffectShapePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-effect-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_effect_motion",
      name: "Generated Effect Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_effect",
      name: "Generated Effect Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "dim_panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 10, width: 160, height: 100, opacity: 1 },
          style: { fill: "#ffffff" },
          effects: { brightness: 0.5 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedEffectKeyframeShapePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-effect-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_effect_keyframe_motion",
      name: "Generated Effect Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_effect_keyframe",
      name: "Generated Effect Keyframe Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "effect_panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 10, width: 160, height: 100, opacity: 1 },
          style: { fill: "#ffffff" },
          keyframes: {
            "effects.brightness": [
              { atMs: 0, value: 1, easing: "linear" },
              { atMs: 1000, value: 0.25 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedWipeShapePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-wipe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_wipe_motion",
      name: "Generated Wipe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_wipe",
      name: "Generated Wipe Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "wipe_panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 10, width: 160, height: 100, opacity: 1 },
          style: { fill: "#ffffff" },
          transitions: {
            in: { type: "wipe", direction: "left", durationMs: 1000, easing: "linear" }
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedBlendModePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-blend-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_blend_motion",
      name: "Generated Blend Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_blend",
      name: "Generated Blend Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#ffffff",
      layers: [
        {
          id: "cyan-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 24, width: 128, height: 72, opacity: 1 },
          style: { fill: "#00ffff" }
        },
        {
          id: "yellow-multiply",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 48, y: 36, width: 104, height: 48, opacity: 1 },
          style: { fill: "#ffff00" },
          blendMode: "multiply"
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedBlendModeKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-blend-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_blend_keyframe_motion",
      name: "Generated Blend Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_blend_keyframe",
      name: "Generated Blend Keyframe Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#ffffff",
      layers: [
        {
          id: "cyan-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 24, width: 128, height: 72, opacity: 1 },
          style: { fill: "#00ffff" }
        },
        {
          id: "yellow-keyed-blend",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 48, y: 36, width: 104, height: 48, opacity: 1 },
          style: { fill: "#ffff00" },
          blendMode: "normal",
          keyframes: {
            blendMode: [
              { atMs: 0, value: "normal", easing: "hold" },
              { atMs: 500, value: "multiply" }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedTransformOriginPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-origin-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_origin_motion",
      name: "Generated Transform Origin Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_origin",
      name: "Generated Transform Origin Motion",
      durationMs: 1000,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "anchored-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2, originX: 0, originY: 0 },
          style: { fill: "#ffffff" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedTransformOriginKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-origin-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_origin_keyframe_motion",
      name: "Generated Transform Origin Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_origin_keyframe",
      name: "Generated Transform Origin Keyframe Motion",
      durationMs: 1100,
      fps: 24,
      width: 200,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "anchored-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2, originX: 20, originY: 10 },
          style: { fill: "#ffffff" },
          keyframes: {
            "transform.originX": [
              { atMs: 0, value: 20, easing: "linear" },
              { atMs: 1000, value: 0 }
            ],
            "transform.originY": [
              { atMs: 0, value: 10, easing: "linear" },
              { atMs: 1000, value: 0 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedStyleRadiusKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-style-radius-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_style_radius_keyframe_motion",
      name: "Generated Style Radius Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_style_radius_keyframe",
      name: "Generated Style Radius Keyframe Motion",
      durationMs: 1100,
      fps: 24,
      width: 120,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "rounded-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          style: { fill: "#ffffff", radius: 0 },
          keyframes: {
            "style.radius": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 40 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedFillColorKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-fill-color-keyframe-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_fill_color_keyframe_motion",
      name: "Generated Fill Color Keyframe Motion",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_fill_color_keyframe",
      name: "Generated Fill Color Keyframe Motion",
      durationMs: 1100,
      fps: 24,
      width: 120,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "color-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          fill: "#000040",
          keyframes: {
            fill: [
              { atMs: 0, value: "#000040", easing: "linear" },
              { atMs: 1000, value: "#ffffff" }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedTypographyEvidencePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-typography-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_typography_evidence",
      name: "Generated Typography Evidence",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_typography_evidence",
      name: "Generated Typography Evidence",
      durationMs: 1000,
      fps: 24,
      width: 640,
      height: 240,
      background: "#020617",
      layers: [
        {
          id: "arabic-title",
          type: "text",
          text: "مرحبا بالعالم",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 32, width: 560, height: 80, opacity: 1 },
          style: {
            direction: "rtl",
            lang: "ar",
            textAlign: "start",
            fontFamily: "ShellXDefinitelyMissingArabicFont, sans-serif",
            fontSize: 48,
            color: "#ffffff"
          }
        },
        {
          id: "sanitized-title",
          type: "text",
          text: "Safe language metadata",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 132, width: 560, height: 60, opacity: 1 },
          style: {
            direction: "rtl; background:url(https://evil.example/direction)",
            lang: "en\" onmouseover=\"alert(1)",
            unicodeBidi: "isolate; background:url(https://evil.example/bidi)",
            fontSize: 30,
            color: "#ffffff"
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedTextFitPackage(layer: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-fit-package-"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_fit",
      name: "Generated Text Fit",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_fit",
      name: "Generated Text Fit",
      durationMs: 1000,
      fps: 24,
      width: 320,
      height: 180,
      background: "#020617",
      safeAreas: { title: { top: 20, right: 20, bottom: 20, left: 20 } },
      layers: [{
        id: "title",
        type: "text",
        startMs: 0,
        durationMs: 1000,
        ...layer
      }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedStyledTextFitPackage(policy: "safe" | "auto-fit"): Promise<string> {
  const root = await writeGeneratedEmbeddedFontPackage();
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1", id: "motion_generated_styled_text_fit", name: "Styled text fit", durationMs: 1_000, fps: 24, width: 240, height: 120,
      background: "#020617", safeAreas: { title: { top: 16, right: 16, bottom: 16, left: 16 } },
      layers: [{
        id: "title", type: "text", startMs: 0, durationMs: 1_000,
        transform: { x: 20, y: 20, width: 200, height: 80 },
        style: { fontSize: 64, lineHeight: 1, color: "#ffffff" },
        textFit: { policy, safeAreaId: "title", ...(policy === "auto-fit" ? { minFontSize: 24 } : {}) },
        textRuns: { schema: "shellx-motion/text-runs@1", runs: [
          { text: "\uea60\uea60\uea60", fontAssetId: "font-codicon", fontSizePx: 160, letterSpacingPx: 4 },
          { text: "\uea60", fontAssetId: "font-codicon" }
        ] }
      }],
      assets: [{ id: "font-codicon", type: "font", family: "ShellXCodicon", source: { path: "assets/fonts/codicon.ttf", mimeType: "font/ttf" }, weight: 400, style: "normal" }],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeGeneratedEmbeddedFontPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-embedded-font-package-"));
  const fontDir = join(root, "assets", "fonts");
  await mkdir(fontDir, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const playwrightRoot = dirname(require.resolve("playwright-core"));
  const playwrightFontDir = join(playwrightRoot, "lib", "vite", "dashboard", "assets");
  const fontName = readdirSync(playwrightFontDir).find((name) => name.endsWith(".ttf"));
  if (!fontName) throw new Error("Playwright test font fixture is unavailable.");
  await copyFile(join(playwrightFontDir, fontName), join(fontDir, "codicon.ttf"));
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_embedded_font",
      name: "Generated Embedded Font",
      motion: "motion.json",
      assets: ["assets/fonts/codicon.ttf"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_embedded_font",
      name: "Generated Embedded Font",
      durationMs: 1000,
      fps: 24,
      width: 240,
      height: 120,
      background: "#020617",
      layers: [{
        id: "icon-title",
        type: "text",
        text: "\uea60",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 20, y: 20, width: 200, height: 80 },
        style: { fontFamily: "ShellXCodicon", fontSize: 64, color: "#ffffff" },
      }],
      assets: [{
        id: "font-codicon",
        type: "font",
        family: "ShellXCodicon",
        source: { path: "assets/fonts/codicon.ttf", mimeType: "font/ttf" },
        weight: 400,
        style: "normal",
      }],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    }, null, 2)}\n`,
  );
  return root;
}

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
