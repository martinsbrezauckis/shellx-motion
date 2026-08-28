/** One-shot implementation behind the private C6C terminal-boundary capability. */
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  defaultLocalMotionJobGovernor,
  previewReceiptStatus,
  type LocalMotionRuntimeSandboxEvidence,
} from "@shellx-motion/core";
import { browserOutputPathFor } from "./browser-output-path";
import { publishBrowserOutput } from "./browser-output-publication";
import { captureSingleDeterministicScreenshotBuffer } from "./browser-screenshot-integrity";
import { assertNoStructuralPrivatePublication, resolveRendererPrivateOutputPublication } from "./private-output-publication";
import {
  CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA,
  type CheckpointStoryboardTerminalBoundaryEvidence,
  type TerminalBoundaryDescriptor,
  type TerminalStaticDocument,
} from "./checkpoint-storyboard-terminal-boundary-contract";
import type {
  BrowserFrameBatchOptions,
  BrowserFrameOptions,
  BrowserFrameResult,
  BrowserRenderSessionMetrics,
  BrowserRenderSessionOptions,
  MotionBrowserRenderSession,
} from "./index";

interface TerminalBoundarySessionMode {
  readonly durationMs: number;
  attempted: boolean;
  closed: boolean;
}

const terminalSessionModes = new WeakMap<object, TerminalBoundarySessionMode>();

export function createTerminalBoundaryBrowserRenderSession(
  descriptor: TerminalBoundaryDescriptor,
  options: BrowserRenderSessionOptions,
  browser: Browser,
  sandboxEvidence: LocalMotionRuntimeSandboxEvidence,
): MotionBrowserRenderSession {
  const metrics: BrowserRenderSessionMetrics = {
    browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0,
    activeFrames: 0, peakConcurrentFrames: 0, frameCacheHits: 0, frameRetries: 0,
  };
  const { document } = descriptor;
  const scriptExecution = descriptor.scriptExecution;
  let browserClose: Promise<void> | undefined;
  let session!: MotionBrowserRenderSession;
  const closeBrowser = () => browserClose ??= browser.close();
  const close = async () => {
    const mode = terminalSessionModes.get(session);
    if (!mode) throw new Error("Checkpoint storyboard terminal-boundary session is invalid.");
    mode.closed = true;
    await closeBrowser();
  };
  session = {
    browserVersion: browser.version(), metrics, scriptExecution,
    async renderFrame() {
      await close();
      throw new Error("Checkpoint storyboard terminal-boundary mode requires one renderFrames request with one frame.");
    },
    async renderFrames(frames, batchOptions = {}) {
      const mode = terminalSessionModes.get(session);
      if (!mode || mode.closed || mode.attempted) throw new Error("Checkpoint storyboard terminal-boundary session cannot be reused.");
      try {
        assertExactTerminalBoundaryBatch(frames, batchOptions, mode.durationMs);
      } catch (error) {
        await close();
        throw error;
      }
      mode.attempted = true;
      try {
        const governed = await (options.governor ?? defaultLocalMotionJobGovernor).run({
          lane: "browser", operation: "browser.preview.frames", scratchRoot: frames[0].outDir,
          signal: batchOptions.signal,
          ...(options.callerId ? { callerId: options.callerId } : {}),
          ...(options.jobId ? { jobId: options.jobId } : {}),
        }, async ({ signal, watchProcess, reportProcessContainment, reportSandbox }) => {
          reportProcessContainment({
            schema: "shellx-motion/process-containment@1", mode: "cooperative-browser-session",
            status: "fallback", killTree: false, memoryLimit: "rss-monitor", reasonCode: "worker_process_unavailable",
          });
          reportSandbox(sandboxEvidence);
          watchProcess(process.pid);
          const abortTerminalBoundary = () => {
            mode.closed = true;
            void closeBrowser().catch(() => undefined);
          };
          signal.addEventListener("abort", abortTerminalBoundary, { once: true });
          if (signal.aborted) abortTerminalBoundary();
          try {
            return await renderExactTerminalBoundaryFrame(descriptor, browser, frames[0], metrics, signal);
          } finally {
            signal.removeEventListener("abort", abortTerminalBoundary);
          }
        });
        governed.value.output.resources = governed.evidence;
        governed.value.receipt.output = governed.value.output;
        batchOptions.onProgress?.({ completed: 1, total: 1, index: 0, atMs: frames[0].atMs });
        return [governed.value];
      } finally {
        await close();
      }
    },
    close,
  };
  terminalSessionModes.set(session, { durationMs: descriptor.durationMs, attempted: false, closed: false });
  return session;
}

function assertExactTerminalBoundaryBatch(
  frames: Array<Omit<BrowserFrameOptions, "networkAccess">>, batchOptions: BrowserFrameBatchOptions, durationMs: number,
): void {
  if (frames.length !== 1) throw new Error("Checkpoint storyboard terminal-boundary mode accepts exactly one frame, not a batch.");
  if (batchOptions.maxConcurrency !== 1 || batchOptions.maxFrameAttempts !== 1) {
    throw new Error("Checkpoint storyboard terminal-boundary mode requires maxConcurrency=1 and maxFrameAttempts=1.");
  }
  const frame = frames[0] as BrowserFrameOptions;
  assertNoStructuralPrivatePublication(frame);
  if ("networkAccess" in frame || frame.workflow !== undefined || (frame.format !== undefined && frame.format !== "png")) {
    throw new Error("Checkpoint storyboard terminal-boundary frame refuses network access, workflows, and non-PNG formats.");
  }
  if (frame.atMs !== durationMs) throw new Error(`Checkpoint storyboard terminal-boundary frame must be requested at exact duration ${durationMs}ms.`);
  if (typeof frame.outDir !== "string" || frame.outDir.length === 0) throw new Error("Checkpoint storyboard terminal-boundary frame requires an output directory.");
}

async function renderExactTerminalBoundaryFrame(
  descriptor: TerminalBoundaryDescriptor, browser: Browser,
  frame: Omit<BrowserFrameOptions, "networkAccess">, metrics: BrowserRenderSessionMetrics, signal: AbortSignal,
): Promise<BrowserFrameResult> {
  if (signal.aborted) throw abortReason(signal);
  const { document } = descriptor;
  const privateOutputPublication = resolveRendererPrivateOutputPublication(frame);
  const outputPath = browserOutputPathFor({ manifest: { id: descriptor.packageId } }, frame, privateOutputPublication?.stagingPath);
  metrics.activeFrames = 1;
  metrics.peakConcurrentFrames = 1;
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ viewport: { width: document.width, height: document.height }, deviceScaleFactor: 1, serviceWorkers: "block" });
    metrics.contextsCreated += 1;
    await context.routeWebSocket("**/*", async (webSocket) => {
      await webSocket.close({ code: 1008, reason: "Checkpoint storyboard terminal-boundary network is disabled." });
    });
    await context.route("**/*", async (route) => { await route.abort("blockedbyclient"); });
    const page: Page = await context.newPage();
    metrics.pagesCreated += 1;
    await page.setContent(terminalDocumentHtml(document), { waitUntil: "load" });
    if (signal.aborted) throw abortReason(signal);
    const png = await captureSingleDeterministicScreenshotBuffer(page, {
      path: outputPath, type: "png", animations: "disabled", caret: "hide", omitBackground: true,
    });
    if (signal.aborted) throw abortReason(signal);
    const outputHash = await publishBrowserOutput(outputPath, png, privateOutputPublication);
    metrics.framesRendered += 1;
    const evidence: CheckpointStoryboardTerminalBoundaryEvidence = Object.freeze({
      schema: CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA, mode: "exact-duration-static-background",
      endpoint: Object.freeze({ requestedAtMs: frame.atMs, durationMs: descriptor.durationMs, exactDuration: true }),
      execution: Object.freeze({ renderFramesCalls: 1, requestedFrames: 1, capturedFrames: 1, maxConcurrency: 1, maxFrameAttempts: 1, retries: 0, cacheHits: 0, reused: false }),
      document: Object.freeze({ width: document.width, height: document.height, background: document.background, layersLoaded: 0, sourceLoads: 0, fontLoads: 0, assetLoads: 0, scriptLoads: 0, mediaLoads: 0, webglContexts: 0 }),
      network: Object.freeze({ policy: "deny-all", approvedOrigins: Object.freeze([]) as readonly [], requestsAllowed: 0, webSocketsAllowed: 0 }),
    });
    const output: BrowserFrameResult["output"] = {
      path: outputPath, sha256: outputHash, format: "png", width: document.width, height: document.height,
      atMs: frame.atMs, browser: { name: "chromium", version: browser.version() },
      viewport: { width: document.width, height: document.height, deviceScaleFactor: 1 },
      renderSession: { ...metrics, activeFrames: 0 }, terminalBoundary: evidence,
    };
    return {
      ok: true, output,
      receipt: {
        schema: "shellx-motion/receipt@1", id: `checkpoint-storyboard-terminal-${outputHash.slice(0, 16)}`,
        operation: "preview.frame", status: previewReceiptStatus({ warnings: [] }), packageId: descriptor.packageId,
        inputHashes: { "terminal-static-document": descriptor.staticFingerprint },
        createdAt: frame.now?.() ?? new Date().toISOString(), lane: "browser", output, warnings: [],
      },
    };
  } finally {
    metrics.activeFrames = 0;
    await context?.close();
  }
}

function terminalDocumentHtml(document: TerminalStaticDocument): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${document.width}px;height:${document.height}px;overflow:hidden;background:${document.background}}</style></head><body></body></html>`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Checkpoint storyboard terminal-boundary frame was cancelled.");
}
