import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMotionPackage, type MotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createHostBoundBrowserFrameRenderer, createMotionBrowserRenderSession } from "./index";
import { withCheckpointStoryboardTerminalBoundaryMode } from "./checkpoint-storyboard-terminal-boundary";
import { TEST_APPROVED_AGENT_SCRIPT_AUTHORITY } from "./test-support/approved-agent-script-authority";
import { makeRgbaPngFixture } from "./test-support/png-fixture";

const temporaryDirectories: string[] = [];
const worktreeRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function inTestWorkspace<T>(operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(worktreeRoot), operation);
}

function terminalFixture(): MotionPackage {
  return {
    root: "/never-read-checkpoint-storyboard-terminal-fixture",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "checkpoint-terminal-fixture",
      name: "Checkpoint terminal fixture",
      motion: "motion.json",
      assets: ["must-not-load.png", "must-not-load.html", "must-not-load.js"],
      sourceApp: "test",
      compatibility: { lanes: ["browser"], hosts: ["motion"] },
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "checkpoint-terminal-motion",
      name: "Checkpoint terminal motion",
      durationMs: 900,
      fps: 30,
      width: 1,
      height: 1,
      background: "#123456",
      // Deliberately hostile-to-generic package content. Terminal mode must neither resolve nor
      // render these layer sources at exact D.
      layers: [
        { id: "web", type: "web", startMs: 0, durationMs: 900, source: "must-not-load.html", keyframes: {} },
        { id: "html", type: "html", startMs: 0, durationMs: 900, source: "must-not-load.html", keyframes: {} },
        { id: "canvas", type: "canvas", startMs: 0, durationMs: 900, source: "must-not-load.js", keyframes: {} },
      ],
      assets: [{ id: "poison", source: { path: "must-not-load.png" } }],
      provenance: { sourceApp: "test", createdBy: "test" },
    },
  } as MotionPackage;
}

function terminalBrowser(log: { html?: string }) {
  const png = makeRgbaPngFixture(1, 1, [{ r: 18, g: 52, b: 86, a: 255 }]);
  const page = {
    setContent: vi.fn(async (html: string) => { log.html = html; }),
    screenshot: vi.fn(async () => png),
  };
  const context = {
    routeWebSocket: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return {
    browser: {
      version: () => "terminal-test-browser",
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    },
    page,
    context,
  };
}

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(worktreeRoot, ".shellx-motion-c6c-b1d-terminal-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function terminalSession(log: { html?: string } = {}) {
  const fake = terminalBrowser(log);
  const session = await createMotionBrowserRenderSession(
    terminalFixture(),
    withCheckpointStoryboardTerminalBoundaryMode({ launchBrowser: async () => fake.browser as never }),
  );
  return { session, fake, log };
}

describe("C6C checkpoint-storyboard exact-duration terminal Browser boundary", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("uses only a static document at exact D and records explicit endpoint evidence", async () => {
    const log: { html?: string } = {};
    const { session, fake } = await terminalSession(log);
    const outDir = await outputDirectory();

    const [result] = await inTestWorkspace(async () => await session.renderFrames([{ atMs: 900, outDir }], { maxConcurrency: 1, maxFrameAttempts: 1 }));

    expect(log.html).toBe('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1px;height:1px;overflow:hidden;background:#123456}</style></head><body></body></html>');
    expect(log.html).not.toMatch(/must-not-load|<(?:img|link|script|canvas|video|audio|svg|iframe|object)\b/i);
    expect(fake.context.route).toHaveBeenCalledTimes(1);
    expect(fake.context.routeWebSocket).toHaveBeenCalledTimes(1);
    expect(fake.page.screenshot).toHaveBeenCalledTimes(1);
    expect(result.output.terminalBoundary).toEqual({
      schema: "shellx-motion/checkpoint-storyboard-terminal-boundary@1",
      mode: "exact-duration-static-background",
      endpoint: { requestedAtMs: 900, durationMs: 900, exactDuration: true },
      execution: { renderFramesCalls: 1, requestedFrames: 1, capturedFrames: 1, maxConcurrency: 1, maxFrameAttempts: 1, retries: 0, cacheHits: 0, reused: false },
      document: { width: 1, height: 1, background: "#123456", layersLoaded: 0, sourceLoads: 0, fontLoads: 0, assetLoads: 0, scriptLoads: 0, mediaLoads: 0, webglContexts: 0 },
      network: { policy: "deny-all", approvedOrigins: [], requestsAllowed: 0, webSocketsAllowed: 0 },
    });
    expect(result.output.renderSession).toMatchObject({ browserLaunches: 1, framesRendered: 1, frameCacheHits: 0, frameRetries: 0 });
  });

  it("refuses a forged structural capability before launch", async () => {
    let launches = 0;
    const forged = Object.assign(Object.create({ checkpointStoryboardTerminalBoundary: {} }), {
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
    });

    await expect(createMotionBrowserRenderSession(terminalFixture(), forged as never))
      .rejects.toThrow("renderer-minted capability");
    expect(launches).toBe(0);
  });

  it("requires the exact one-element renderFrames shape and permanently refuses reuse", async () => {
    const wrongTime = await terminalSession();
    await expect(wrongTime.session.renderFrames([{ atMs: 899, outDir: await outputDirectory() }], { maxConcurrency: 1, maxFrameAttempts: 1 }))
      .rejects.toThrow("exact duration 900ms");

    const multiFrame = await terminalSession();
    await expect(multiFrame.session.renderFrames([
      { atMs: 900, outDir: await outputDirectory() },
      { atMs: 900, outDir: await outputDirectory() },
    ], { maxConcurrency: 1, maxFrameAttempts: 1 })).rejects.toThrow("exactly one frame");

    const retry = await terminalSession();
    await expect(retry.session.renderFrames([{ atMs: 900, outDir: await outputDirectory() }], { maxConcurrency: 1, maxFrameAttempts: 2 }))
      .rejects.toThrow("maxConcurrency=1 and maxFrameAttempts=1");

    const oneShot = await terminalSession();
    const outDir = await outputDirectory();
    await expect(oneShot.session.renderFrame({ atMs: 900, outDir })).rejects.toThrow("requires one renderFrames request");
    await expect(oneShot.session.renderFrames([{ atMs: 900, outDir }], { maxConcurrency: 1, maxFrameAttempts: 1 }))
      .rejects.toThrow("cannot be reused");

    const rendered = await terminalSession();
    await inTestWorkspace(async () => await rendered.session.renderFrames([{ atMs: 900, outDir: await outputDirectory() }], { maxConcurrency: 1, maxFrameAttempts: 1 }));
    await expect(rendered.session.renderFrames([{ atMs: 900, outDir: await outputDirectory() }], { maxConcurrency: 1, maxFrameAttempts: 1 }))
      .rejects.toThrow("cannot be reused");
  });

  it("terminates the owned Browser and context when cancellation reaches a stalled screenshot", async () => {
    const outDir = await outputDirectory();
    const controller = new AbortController();
    const cancellation = new Error("terminal screenshot cancelled");
    let screenshotStarted!: () => void;
    let rejectScreenshot!: (error: Error) => void;
    const screenshotStartedPromise = new Promise<void>((resolveStarted) => { screenshotStarted = resolveStarted; });
    const screenshot = new Promise<Buffer>((_resolveScreenshot, reject) => { rejectScreenshot = reject; });
    const page = {
      setContent: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => {
        screenshotStarted();
        return await screenshot;
      }),
    };
    const context = {
      routeWebSocket: vi.fn(async () => undefined), route: vi.fn(async () => undefined),
      newPage: vi.fn(async () => page), close: vi.fn(async () => undefined),
    };
    const browser = {
      version: () => "terminal-cancellation-browser",
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => { rejectScreenshot(cancellation); }),
    };
    const session = await createMotionBrowserRenderSession(
      terminalFixture(),
      withCheckpointStoryboardTerminalBoundaryMode({ launchBrowser: async () => browser as never }),
    );

    const render = inTestWorkspace(async () => await session.renderFrames(
      [{ atMs: 900, outDir }],
      { maxConcurrency: 1, maxFrameAttempts: 1, signal: controller.signal },
    ));
    await screenshotStartedPromise;
    controller.abort(cancellation);

    await expect(render).rejects.toThrow("terminal screenshot cancelled");
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(session.metrics.framesRendered).toBe(0);
    expect(await readdir(outDir)).toEqual([]);
  });

  it("freezes terminal duration, package identity, document, and receipt evidence before launch yields", async () => {
    const pkg = terminalFixture();
    const log: { html?: string } = {};
    const fake = terminalBrowser(log);
    const session = await createMotionBrowserRenderSession(
      pkg,
      withCheckpointStoryboardTerminalBoundaryMode({
        launchBrowser: async () => {
          pkg.manifest.id = "mutated-after-terminal-snapshot";
          pkg.motion.durationMs = 0;
          pkg.motion.width = 2;
          pkg.motion.height = 2;
          pkg.motion.background = "#abcdef";
          return fake.browser as never;
        },
      }),
    );
    const outDir = await outputDirectory();

    const [result] = await inTestWorkspace(async () => await session.renderFrames(
      [{ atMs: 900, outDir }], { maxConcurrency: 1, maxFrameAttempts: 1 },
    ));

    expect(result.output.path).toContain("checkpoint-terminal-fixture-browser-900.png");
    expect(result.output.terminalBoundary?.endpoint).toEqual({ requestedAtMs: 900, durationMs: 900, exactDuration: true });
    expect(result.output.terminalBoundary?.document).toMatchObject({ width: 1, height: 1, background: "#123456" });
    expect(result.receipt.packageId).toBe("checkpoint-terminal-fixture");
    expect(result.receipt.inputHashes).toHaveProperty("terminal-static-document");
    expect(log.html).toContain("width:1px;height:1px");
    expect(log.html).toContain("background:#123456");
  });

  it("leaves ordinary interior Browser rendering on the existing generic path", async () => {
    await inTestWorkspace(async () => {
      const pkg = await loadMotionPackage(fileURLToPath(new URL("../../../fixtures/packages/web-card", import.meta.url)));
      const outDir = await outputDirectory();
      const render = createHostBoundBrowserFrameRenderer({ agentScriptAuthority: TEST_APPROVED_AGENT_SCRIPT_AUTHORITY });
      const result = await render(pkg, { atMs: 500, outDir });
      expect(result.output.atMs).toBe(500);
      expect(result.output.terminalBoundary).toBeUndefined();
      expect(result.output.network?.approvedOrigins).toEqual([]);
    });
  }, 45_000);
});
