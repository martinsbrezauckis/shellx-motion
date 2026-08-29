import { chmod, copyFile, cp, mkdir as mkdirRaw, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashPackageFile,
  integrationCapabilitiesForHost,
  loadMotionPackage,
  MOTION_DOCUMENT_LIMITS,
  type OperationReceipt
} from "@shellx-motion/core";
import { dispatchDebugCommand, type BrowserFrameRenderer } from "@shellx-motion/debug-api";
import { clearDefaultEncodePolicyCache, resolveFfmpegExecutable, type FfmpegCommand, type FfmpegProcessResult, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import {
  normalizeWindowsExtendedPath,
  renderFrameSequenceBudgetError,
  runCli as runCliRaw,
  type RunCliOptions
} from "./main";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { withCliSourceWorkspaceAnchor } from "./debug-context-cli";
// Shared test scaffolding split out of this monolith for the module-size gate. tempDirs/execFile
// are singletons owned by main.test-support so afterEach and every fixture builder share one instance.
import {
  ALPHA_2X2_PNG,
  BLACK_2X1_PNG,
  BLACK_PNG,
  cliAgentReceipt,
  cliDebugReceipt,
  CONTRAST_PNG,
  createFakePromptRuntime,
  execFile,
  execPlatformVerifierFailure,
  importedSourceMarkdown,
  rgbaPng,
  scriptedAgentRuntime,
  scriptedVideo,
  shapeTextFrameSelection,
  staticShapeTextFrameSelection,
  storyboardPanelScriptedVideo,
  STRUCTURED_4X2_PNG,
  tempDirs,
  withEnv
} from "./main.test-support";
import { writePlatformReceipt } from "./platform-verification.test-support";
import {
  htmlSnippetImportFixture,
  rewriteTinyNativePackageTitle,
  tinyOtioTimelineFixture,
  writeTemplateMediaPackage,
  writeTinyNativePackage,
  writeTinyPackageWithAssetsAndBrand,
  writeTinyPackageWithAudioLayer,
  writeTinyPackageWithMediaLayers,
  writeTinyPackageWithTimeline,
  writeTinyPackageWithTwoAudioLayers,
  writeTinyPackageWithVideoLayer
} from "./main.fixtures-packages";
import {
  writeAudioBatchPackage,
  writeBatchPackageWithAsset,
  writeCanvasBridgeRoot,
  writeFastBatchPackage,
  writeVariantBatchPackage
} from "./main.fixtures-batch";

const fixtureRoot = resolve("../../fixtures/packages/lower-third");
const batchFixtureRoot = resolve("../../fixtures/packages/batch-card");
const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });
const HTML_TYPOGRAPHY_WARNING = "Browser HTML/web/canvas typography is unverified: font provenance and fallback coverage are not attestable.";
// These cases exercise Linux descriptor-relative receipt/state reads or the declared Linux-only
// Browser-to-FFmpeg P2B connectors. Non-Linux hosts verify their fail-closed/platform-inapplicable
// behavior in focused tests and record the corresponding platform skips in the host ladder.
const itLinux = process.platform === "linux" ? it : it.skip;

// Test-created admitted directories must not inherit the host's umask. Unsafe-parent cases opt
// out explicitly with their asserted mode, so they remain meaningful authority regressions.
const mkdir = (path: string, options: { recursive?: boolean; mode?: number } = {}) =>
  mkdirRaw(path, { mode: 0o700, ...options });

function browserColorAlphaContract() {
  return expect.objectContaining({
    sourceEncoding: "sdr-srgb-encoded",
    rasterInput: "unprofiled-srgb-assumed",
    embeddedProfiles: "unsupported-undefined",
    alphaBoundary: "browser-managed-before-png-capture",
    filterDomain: "chromium-managed",
    blendDomain: "chromium-managed",
    crossRendererConformance: false,
    unsupported: ["hdr", "wide-gamut", "icc-profile-conversion", "ocio", "user-selectable-working-space"]
  });
}

function isFfprobeCommand(command: FfmpegCommand): boolean {
  return basename(command.executable).toLowerCase().startsWith("ffprobe");
}

function isFfmpegCommand(command: FfmpegCommand): boolean {
  return basename(command.executable).toLowerCase().startsWith("ffmpeg");
}

function streamedVideoProbe(codecName = "h264", formatName = "mov,mp4"): FfmpegProcessResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      streams: [{
        codec_type: "video",
        codec_name: codecName,
        width: 640,
        height: 360,
        avg_frame_rate: "10/1",
        pix_fmt: "yuv420p",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
        color_range: "tv"
      }],
      format: { duration: "0.300000", format_name: formatName }
    }),
    stderr: ""
  };
}

/**
 * Image2pipe is a process contract, not a command-runner contract. Batch tests use this host-only
 * seam to record the real stream command and write its attested output while their FfmpegRunner
 * remains responsible only for probes and readback.
 */
function streamedBatchProcessFactory(
  commands: FfmpegCommand[],
  outputContents = "fake streamed batch"
): NonNullable<RunCliOptions["streamingProcessFactory"]> {
  return async (input) => {
    commands.push(input.command);
    input.reportProcessContainment({
      schema: "shellx-motion/process-containment@1",
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor"
    });
    const outputPath = input.command.args.at(-1);
    if (!outputPath) throw new Error("streamed batch test command has no output path");
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    let settled: FfmpegProcessResult | undefined;
    const settle = (result: FfmpegProcessResult) => {
      if (!settled) {
        settled = result;
        resolveClosed(result);
      }
      return settled;
    };
    return {
      closed,
      write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 }),
      end: async () => {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, outputContents, "utf8");
        return settle({ exitCode: 0, stdout: "", stderr: "" });
      },
      abort: async () => settle({ exitCode: 1, stdout: "", stderr: "aborted" })
    };
  };
}

function materializedBatchBrowserFrameRenderer(): BrowserFrameRenderer {
  return async (pkg, options) => {
    const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-${options.atMs}.png`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, CONTRAST_PNG);
    const output = {
      path: outputPath,
      sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
      format: "png" as const,
      width: pkg.motion.width,
      height: pkg.motion.height,
      atMs: options.atMs,
      browser: { name: "chromium", version: "test" },
      viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
    };
    return {
      ok: true,
      output,
      receipt: cliDebugReceipt({
        id: `materialized-batch-frame-${options.atMs}`,
        operation: "preview.frame",
        status: "passed",
        packageId: pkg.manifest.id,
        lane: "browser",
        output
      })
    };
  };
}

// Isolate the shared encode-policy probe cache per test so each render observes a fresh probe.
beforeEach(clearDefaultEncodePolicyCache);

describe("shellx-motion CLI", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("stamps a cli actor onto host receipts and honors --actor / SHELLX_MOTION_ACTOR", async () => {
    const packageRoot = resolve("../../fixtures/packages/editable-lower-third");

    // Helper: run template-apply into a fresh temp dir, return the persisted host receipt's actor.
    const applyAndReadActor = async (extraArgv: string[], env?: Record<string, string | undefined>) => {
      const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-actor-"));
      tempDirs.push(outDir);
      const receiptsRoot = join(outDir, "host-receipts");
      const saved = process.env.SHELLX_MOTION_ACTOR;
      if (env && "SHELLX_MOTION_ACTOR" in env) {
        if (env.SHELLX_MOTION_ACTOR === undefined) delete process.env.SHELLX_MOTION_ACTOR;
        else process.env.SHELLX_MOTION_ACTOR = env.SHELLX_MOTION_ACTOR;
      }
      try {
        const result = await runCli([
          "debug", "template-apply", "--tier", "edit_motion",
          "--package", packageRoot, "--out", outDir,
          "--receipts-root", receiptsRoot, "--set", "title=Launch Day",
          ...extraArgv
        ]);
        expect(result.ok).toBe(true);
        const receiptId = (result as { receiptId?: string }).receiptId;
        const hostReceipt = JSON.parse(await readFile(join(receiptsRoot, `${receiptId}.receipt.json`), "utf8"));
        return hostReceipt.actor;
      } finally {
        if (saved === undefined) delete process.env.SHELLX_MOTION_ACTOR;
        else process.env.SHELLX_MOTION_ACTOR = saved;
      }
    };

    // Bare CLI invocation: a human at a terminal. Observed transport + tier are recorded.
    const human = await applyAndReadActor([], { SHELLX_MOTION_ACTOR: undefined });
    expect(human.kind).toBe("human");
    expect(human.label).toBe("cli");
    expect(human.transport).toBe("cli");
    expect(human.grantedTier).toBe("edit_motion");

    // --actor names an agent framework wrapping the CLI: kind flips to agent, label is the flag.
    const flagged = await applyAndReadActor(["--actor", "release-runner"], { SHELLX_MOTION_ACTOR: undefined });
    expect(flagged.kind).toBe("agent");
    expect(flagged.label).toBe("release-runner");
    expect(flagged.transport).toBe("cli");

    // SHELLX_MOTION_ACTOR env is honored the same way for frameworks that set it.
    const fromEnv = await applyAndReadActor([], { SHELLX_MOTION_ACTOR: "env-agent" });
    expect(fromEnv.kind).toBe("agent");
    expect(fromEnv.label).toBe("env-agent");
    expect(fromEnv.transport).toBe("cli");
  });

  it("validates a Motion package fixture through the core loader", async () => {
    const result = await runCli(["validate", fixtureRoot]);

    expect(result).toMatchObject({
      ok: true,
      command: "validate",
      packageId: "pkg_lower_third",
      motionId: "motion_lower_third",
      layers: 1
    });
  });

  it("returns structured CLI help for shellx-motion users and agents", async () => {
    const result = await runCli(["--help"]);

    expect(result).toMatchObject({
      ok: true,
      command: "help",
      usage: "shellx-motion <command> [args]",
      commands: expect.arrayContaining([
        expect.objectContaining({ name: "actions", usage: "shellx-motion actions find|guide|plan <request>" }),
        expect.objectContaining({ name: "debug", usage: "shellx-motion debug <surface-command> [options]" }),
        expect.objectContaining({ name: "runtime-probe", usage: "shellx-motion runtime-probe" }),
        expect.objectContaining({ name: "connector", usage: "shellx-motion connector catalog | describe <capability-id> | canvas-bridge-export|canvas-to-cut|canvas-to-mp4|script-to-cut|source-to-cut|cut-generate-to-cut|template-to-cut <input> --out <dir>", purpose: expect.stringContaining("Canvas/Script/Source-to-Cut P2B is Linux-only") }),
        expect.objectContaining({ name: "render-batch", usage: "shellx-motion render-batch <package> --out <dir>" }),
        expect.objectContaining({ name: "package-extract", usage: "shellx-motion package-extract <archive.shellxmotion> --out <package-dir>" })
      ]),
      agentFirst: {
        defaultAgentRoute: "local-cli-subscription",
        discovery: ["actions find", "actions guide", "actions plan", "debug actions-panel"]
      },
      examples: expect.arrayContaining([
        "shellx-motion actions plan \"render this lower third as mp4\"",
        "shellx-motion debug prompt-run --tier edit_motion --trusted-local-tier --request \"edit title and preview\" --execute-agent-commands --receipts-root .scratch/receipts",
        "shellx-motion prompt run \"edit title and preview\" --tier edit_motion --trusted-local-tier --execute-agent-commands --receipts-root .scratch/receipts",
        "shellx-motion connector canvas-to-cut fixtures/canvas/shape-text-frame-selection.json --out .scratch/connectors/canvas-story-hero"
      ])
    });
  });

  it("returns a machine-readable version banner for the Canvas probe (--version/-v/version)", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const result = await runCli(argv);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("version");
      expect(result.name).toBe("@shellx-motion/cli");
      // The Canvas probe extracts a semver-ish token from stdout; keep the shape stable.
      expect(String(result.version)).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("publishes and negotiates the versioned integration capabilities contract", async () => {
    const published = await runCli(["integration-capabilities"]);
    expect(published).toMatchObject({
      ok: true,
      command: "integration-capabilities",
      capabilities: {
        schema: "shellx-motion/integration-capabilities@1",
        host: "shellx-motion",
        protocol: { min: 1, max: 1, preferred: 1 }
      }
    });

    const root = await mkdtemp(join(tmpdir(), "shellx-motion-integration-capabilities-"));
    tempDirs.push(root);
    const peerPath = join(root, "cut.json");
    await writeFile(peerPath, JSON.stringify(integrationCapabilitiesForHost("shellx-cut")));
    await expect(runCli([
      "integration-capabilities",
      "--peer",
      peerPath,
      "--require-mode",
      "cut.import.plan"
    ])).resolves.toMatchObject({
      ok: true,
      negotiation: {
        schema: "shellx-motion/integration-negotiation@1",
        selectedProtocol: 1,
        modes: ["cut.import.plan"]
      }
    });

    const future = integrationCapabilitiesForHost("shellx-cut");
    future.protocol = { min: 2, max: 2, preferred: 2 };
    await writeFile(peerPath, JSON.stringify(future));
    await expect(runCli(["integration-capabilities", "--peer", peerPath])).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported_protocol" }
    });
  });

  it("normalizes Windows extended-length paths at the CLI boundary", () => {
    expect(normalizeWindowsExtendedPath(String.raw`\\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\?\\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\\\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\?\UNC\server\share\motion\scripted-video.json`))
      .toBe(String.raw`\\server\share\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\?\\UNC\\server\share\motion\scripted-video.json`))
      .toBe(String.raw`\\server\share\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath("/tmp/motion/scripted-video.json"))
      .toBe("/tmp/motion/scripted-video.json");
  });

  it("bounds local frame sequence count and pixel output budgets", () => {
    expect(renderFrameSequenceBudgetError(1_800, 1920, 1080)).toBeUndefined();
    expect(renderFrameSequenceBudgetError(36_001, 1920, 1080)).toContain("local safety limit is 36000");
    expect(renderFrameSequenceBudgetError(20_000, 3840, 2160)).toContain("pixel-frames");
  });

  it("returns the same materialized browser preflight refusal for dry-run and execution", async () => {
    const options: RunCliOptions = {
      materializedFrameSequencePreflight: { jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 } }
    };
    const args = ["render", "../../fixtures/packages/lower-third", "--out", join(tmpdir(), "shellx-motion-preflight.mp4"), "--keep-frames"];

    const [dryRun, execution] = await Promise.all([
      runCliRaw([...args, "--dry-run"], options),
      runCliRaw(args, options)
    ]);

    expect(dryRun).toMatchObject({ ok: false, error: { code: "render_resource_preflight_exceeded", resourcePreflight: { status: "refused" } } });
    expect(execution).toMatchObject({ ok: false, error: { code: "render_resource_preflight_exceeded", resourcePreflight: { status: "refused" } } });
  });

  /**
   * The create-time bound and the render-time refusal share Core's absolute sequence budget.
   *
   * `motion.package.create` refuses a document above `MOTION_DOCUMENT_LIMITS` (core), and this
   * render delegates its static refusal to the same Core authority (`renderFrameSequenceBudgetError`,
   * above). If those ever stop meaning the same thing, the cold-start command starts authoring
   * packages the very next render rejects — the failure the command-and-creation contract was about. Behavioural rather than
   * literal on purpose: it asserts at the boundary, so it fails whichever copy moves.
   */
  it("keeps the create-time document budget equal to the render-time frame budget", () => {
    const limits = MOTION_DOCUMENT_LIMITS;

    expect(renderFrameSequenceBudgetError(limits.maxFrames, 1920, 1080)).toBeUndefined();
    expect(renderFrameSequenceBudgetError(limits.maxFrames + 1, 1920, 1080))
      .toContain(`local safety limit is ${limits.maxFrames}`);
    expect(renderFrameSequenceBudgetError(1, limits.maxDimension, limits.maxFramePixels / limits.maxDimension))
      .toBeUndefined();
    // And the largest pixel-frame load core will author is one this render still accepts.
    const framesAt4K = Math.floor(limits.maxPixelFrames / (3840 * 2160));
    expect(renderFrameSequenceBudgetError(framesAt4K, 3840, 2160)).toBeUndefined();
    expect(renderFrameSequenceBudgetError(framesAt4K + 1, 3840, 2160)).toContain("pixel-frames");
  });

  it("requires a trusted-local assertion before CLI --tier elevation", async () => {
    await expect(runCliRaw(["debug", "state", "--tier", "admin"])).resolves.toEqual({
      ok: false,
      command: "debug.state",
      error: {
        code: "invalid_args",
        message: "Unsupported CLI permission tier: admin."
      },
      warnings: []
    });

    await expect(runCliRaw(["debug", "preview-playhead", "--tier", "render_motion"])).resolves.toEqual({
      ok: false,
      command: "debug.preview-playhead",
      error: {
        code: "untrusted_tier",
        message: "CLI --tier elevation to render_motion requires a trusted local assertion.",
        suggestedAction: "Run from a trusted ShellX host context or pass --trusted-local-tier for local development."
      },
      warnings: []
    });

    await expect(runCliRaw(["prompt", "run", "make the title blue", "--tier", "edit_motion"], {
      promptRuntime: createFakePromptRuntime()
    })).resolves.toEqual({
      ok: false,
      command: "prompt.run",
      error: {
        code: "untrusted_tier",
        message: "CLI --tier elevation to edit_motion requires a trusted local assertion.",
        suggestedAction: "Run from a trusted ShellX host context or pass --trusted-local-tier for local development."
      },
      warnings: []
    });
  });

  it("accepts explicit trusted-local CLI tier assertions", async () => {
    await expect(runCliRaw(["debug", "preview-playhead", "--tier", "render_motion", "--trusted-local-tier"])).resolves.toEqual({
      ok: false,
      command: "debug.preview-playhead",
      error: {
        code: "invalid_args",
        message: "motion.preview.playhead requires packageRoot."
      },
      warnings: []
    });
  });

  it("resolves relative fixture paths from INIT_CWD when run through pnpm filters", async () => {
    const previousInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = resolve("../..");
    try {
      const result = await runCli(["validate", "fixtures/packages/lower-third"]);

      expect(result).toMatchObject({
        ok: true,
        command: "validate",
        packageId: "pkg_lower_third"
      });
    } finally {
      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }
    }
  });

  it("ignores a stale INIT_CWD inherited from the source checkout parent", async () => {
    const previousInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = resolve("../../..");
    try {
      const result = await runCli(["validate", "fixtures/packages/lower-third"]);

      expect(result).toMatchObject({
        ok: true,
        command: "validate",
        packageId: "pkg_lower_third"
      });
    } finally {
      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }
    }
  });

  it("prints action plans for natural prompt wording", async () => {
    const result = await runCli(["actions", "plan", "make the title blue and preview it"]);

    expect(result).toMatchObject({
      ok: true,
      command: "actions.plan",
      steps: [
        { call: "motion.state" },
        { call: "motion.timeline.layer.style.set" },
        { call: "motion.preview.frame" },
        { call: "motion.receipts.read" }
      ]
    });
  });

  it("inspects package timeline facts", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);

    const result = await runCli(["inspect", packageRoot]);

    expect(result).toMatchObject({
      ok: true,
      command: "inspect",
      packageId: "pkg_cli_ffmpeg_sequence",
      durationMs: 300,
      fps: 10,
      size: { width: 64, height: 36 },
      layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 300 }],
      timeline: {
        trackCount: 1,
        sceneCount: 1,
        markerCount: 2,
        tracks: [{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }],
        scenes: [{ id: "intro", name: "Intro", startMs: 0, durationMs: 300, trackIds: ["overlay"], markerIds: ["start", "outro"] }],
        markers: [
          { id: "start", atMs: 0, label: "Start", type: "cue" },
          { id: "outro", atMs: 240, durationMs: 60, label: "Outro", type: "cue" }
        ]
      }
    });
  });

  itLinux("routes timeline panel debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.safeAreas = {
      title: { top: 24, right: 32, bottom: 24, left: 32 },
      action: { top: 12, right: 16, bottom: 12, left: 16 }
    };
    motion["x-shellx-duration-policy"] = {
      schema: "shellx-motion/duration-policy@1",
      minDurationMs: 300,
      maxDurationMs: 900,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "outro-lock", role: "outro", startMs: 240, durationMs: 60 },
        { id: "intro-lock", role: "intro", startMs: 0, durationMs: 60 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    await runCli(["debug", "timeline-playhead-set", "--tier", "draft_motion", "--package", packageRoot, "--at-ms", "150"]);
    const result = await runCli(["debug", "timeline-panel", "--package", packageRoot]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.timeline-panel",
      visibleState: {
        panel: "timeline",
        operation: "timeline.panel",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        durationMs: 300,
        playheadMs: 150,
        layerCount: 1,
        trackCount: 1,
        sceneCount: 1,
        markerCount: 2,
        safeAreaCount: 2,
        protectedRegionCount: 2
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        controls: {
          playheadMs: 150
        },
        counts: {
          safeAreas: 2,
          protectedRegions: 2
        },
        durationPolicy: {
          schema: "shellx-motion/duration-policy@1",
          minDurationMs: 300,
          maxDurationMs: 900,
          resizeMode: "stretch-middle",
          protectedRegions: [
            { id: "intro-lock", role: "intro", startMs: 0, durationMs: 60, endMs: 60 },
            { id: "outro-lock", role: "outro", startMs: 240, durationMs: 60, endMs: 300 }
          ]
        },
        safeAreas: [
          { id: "action", top: 12, right: 16, bottom: 12, left: 16 },
          { id: "title", top: 24, right: 32, bottom: 24, left: 32 }
        ],
        layers: [
          expect.objectContaining({
            id: "title",
            type: "text",
            trackId: "overlay",
            activeAtPlayhead: true,
            textPreview: "A"
          })
        ],
        suggestedActions: expect.arrayContaining([
          { id: "inspect", command: "motion.timeline.inspect", args: { packageRoot } },
          { id: "preview", command: "motion.preview.playhead", args: { packageRoot } }
        ])
      }
    });
  });

  it("routes timeline keyframe panel debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 1, easing: "ease-out" },
        { atMs: 300, value: 0.7 }
      ],
      "transform.x": [
        { atMs: 0, value: -24, easing: "ease-out" },
        { atMs: 300, value: 0 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    const result = await runCli(["debug", "keyframes-panel", "--package", packageRoot, "--layer", "title"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframes-panel",
      visibleState: {
        panel: "keyframes",
        operation: "timeline.keyframes.panel",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        layerCount: 1,
        animatedLayerCount: 1,
        targetCount: 2,
        keyframeCount: 5
      },
      result: {
        ok: true,
        filter: { layerId: "title" },
        counts: {
          layers: 1,
          animatedLayers: 1,
          targets: 2,
          keyframes: 5
        },
        layers: [
          expect.objectContaining({
            id: "title",
            keyframeTargetCount: 2,
            keyframeCount: 5
          })
        ],
        targets: expect.arrayContaining([
          expect.objectContaining({ layerId: "title", target: "opacity", keyframeCount: 3 }),
          expect.objectContaining({ layerId: "title", target: "transform.x", keyframeCount: 2 })
        ]),
        suggestedActions: expect.arrayContaining([
          { id: "upsert", command: "motion.timeline.keyframe.upsert", args: { packageRoot } },
          { id: "easingPresets", command: "motion.timeline.easing.presets", args: {} }
        ])
      }
    });
  });

  it("routes timeline transition panel debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].transitions = {
      in: { type: "slide", durationMs: 80, easing: "ease-out", direction: "left", distance: 16 },
      out: { type: "fade", durationMs: 60, easing: "linear" }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    const result = await runCli(["debug", "transitions-panel", "--package", packageRoot, "--layer", "title", "--edge", "in"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.transitions-panel",
      visibleState: {
        panel: "transitions",
        operation: "timeline.transitions.panel",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        layerCount: 1,
        transitionLayerCount: 1,
        transitionCount: 1,
        enterTransitionCount: 1,
        exitTransitionCount: 0
      },
      result: {
        ok: true,
        filter: { layerId: "title", edge: "in" },
        counts: {
          layers: 1,
          transitionLayers: 1,
          transitions: 1,
          enterTransitions: 1,
          exitTransitions: 0
        },
        layers: [
          expect.objectContaining({
            id: "title",
            transitionCount: 1,
            transitions: [
              expect.objectContaining({
                edge: "in",
                type: "slide",
                durationMs: 80,
                fromMs: 0,
                toMs: 80
              })
            ]
          })
        ],
        transitions: [expect.objectContaining({ layerId: "title", edge: "in", type: "slide", key: "title:in" })],
        suggestedActions: expect.arrayContaining([
          { id: "upsert", command: "motion.timeline.transition.upsert", args: { packageRoot } },
          { id: "delete", command: "motion.timeline.transition.delete", args: { packageRoot } }
        ])
      }
    });
  });

  it("routes timeline easing panel debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 1, easing: "ease-out" },
        { atMs: 300, value: 0.7, easing: "ease-out" }
      ]
    };
    motion.layers[0].transitions = {
      in: { type: "slide", durationMs: 80, easing: "ease-out", direction: "left", distance: 16 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    const result = await runCli(["debug", "easing-panel", "--package", packageRoot, "--sample-count", "5"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.easing-panel",
      visibleState: {
        panel: "easing",
        operation: "timeline.easing.panel",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        usedPresetCount: 2,
        customEasingCount: 0,
        usageCount: 4,
        sampleCount: 5
      },
      result: {
        ok: true,
        packageRoot,
        counts: {
          usedPresets: 2,
          customEasings: 0,
          usage: 4,
          keyframeUsage: 3,
          transitionUsage: 1
        },
        usage: {
          total: 4,
          byEasing: { linear: 1, "ease-out": 3 }
        },
        presets: expect.arrayContaining([
          expect.objectContaining({
            id: "linear",
            usageCount: 1,
            samples: [
              { t: 0, value: 0 },
              { t: 0.25, value: 0.25 },
              { t: 0.5, value: 0.5 },
              { t: 0.75, value: 0.75 },
              { t: 1, value: 1 }
            ]
          }),
          expect.objectContaining({
            id: "ease-out",
            usageCount: 3,
            usedBy: expect.arrayContaining([
              { layerId: "title", target: "opacity", kind: "keyframe", atMs: 150 },
              { layerId: "title", target: "in", kind: "transition", edge: "in", type: "slide" }
            ])
          })
        ]),
        suggestedActions: expect.arrayContaining([
          { id: "keyframes", command: "motion.timeline.keyframes.panel", args: { packageRoot } },
          { id: "transitions", command: "motion.timeline.transitions.panel", args: { packageRoot } },
          { id: "presets", command: "motion.timeline.easing.presets", args: {} }
        ])
      }
    });
  });

  itLinux("routes preview panel debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);

    await runCli(["debug", "timeline-playhead-set", "--tier", "draft_motion", "--package", packageRoot, "--at-ms", "150"]);
    const result = await runCli(["debug", "preview-panel", "--package", packageRoot]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.preview-panel",
      visibleState: {
        panel: "preview",
        operation: "preview.panel",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        durationMs: 300,
        fps: 10,
        width: 64,
        height: 36,
        playheadMs: 150,
        layerCount: 1,
        sceneCount: 1,
        markerCount: 2,
        hasSelectedRange: false
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        controls: {
          playheadMs: 150
        },
        player: {
          activeLayerIds: ["title"],
          activeSceneIds: ["intro"],
          activeMarkerIds: []
        },
        previewModes: expect.arrayContaining([
          { id: "frame", label: "Frame", command: "motion.preview.frame", args: { packageRoot, atMs: 150 } },
          { id: "playhead", label: "Playhead", command: "motion.preview.playhead", args: { packageRoot } },
          { id: "strip", label: "Strip", command: "motion.preview.strip", args: { packageRoot } }
        ]),
        suggestedActions: expect.arrayContaining([
          { id: "timeline", command: "motion.timeline.panel", args: { packageRoot } },
          { id: "render", command: "motion.render.final", args: { packageRoot } },
          { id: "exportPanel", command: "motion.export.panel", args: {} }
        ])
      }
    });
  });

  it("routes timeline cleanup debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.durationMs = 300;
    motion.layers[0].durationMs = 420;
    motion.tracks[0].layerIds = ["title", "missing-layer", "title"];
    motion.scenes[0].trackIds = ["overlay", "missing-track", "overlay"];
    motion.scenes[0].markerIds = ["start", "missing-marker", "outro", "outro"];
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-timeline-cleanup-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "timeline-cleanup",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.timeline-cleanup",
      visibleState: {
        panel: "timeline",
        operation: "timeline.cleanup",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        changedPaths: ["/tracks/overlay/layerIds", "/scenes/intro/trackIds", "/scenes/intro/markerIds", "/durationMs"],
        removedRefCount: 6,
        oldDurationMs: 300,
        newDurationMs: 420
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/overlay/layerIds", "/scenes/intro/trackIds", "/scenes/intro/markerIds", "/durationMs"],
        removedTrackLayerRefs: [
          { trackId: "overlay", layerId: "missing-layer", reason: "missing" },
          { trackId: "overlay", layerId: "title", reason: "duplicate" }
        ],
        oldDurationMs: 300,
        newDurationMs: 420,
        durationChanged: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(420);
    expect(patchedMotion.tracks[0].layerIds).toEqual(["title"]);
    expect(patchedMotion.scenes[0].trackIds).toEqual(["overlay"]);
    expect(patchedMotion.scenes[0].markerIds).toEqual(["start", "outro"]);
  });

  it("supports action find and guide commands", async () => {
    await expect(runCli(["actions", "find", "render this lower third as mp4"])).resolves.toMatchObject({
      ok: true,
      command: "actions.find",
      action: { id: "motion.render.final", permission: "render_motion" }
    });

    const guide = await runCli(["actions", "guide", "make the title blue and preview it"]);
    expect(guide).toMatchObject({ ok: true, command: "actions.guide" });
    expect((guide.steps as Array<{ call: string }>).map((step) => step.call)).toEqual([
      "motion.state",
      "motion.timeline.layer.style.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
  });

  it("keeps schema-defined root alternatives visible in CLI action guides and plans", async () => {
    const guide = await runCli(["actions", "guide", "list motion templates"]);
    const plan = await runCli(["actions", "plan", "template plan"]);
    const rootRequirement = {
      requiredArgGroups: [{
        mode: "anyOf",
        alternatives: [["templateRoot"], ["packageRoot"], ["packageRoots"]]
      }]
    };

    expect(guide).toMatchObject({ ok: true, command: "actions.guide" });
    expect(plan).toMatchObject({ ok: true, command: "actions.plan" });
    const guideCatalog = (guide.steps as Array<Record<string, unknown>>).find((step) => step.call === "motion.template.catalog");
    const planCatalog = (plan.steps as Array<Record<string, unknown>>).find((step) => step.call === "motion.template.catalog");
    const templatePlan = (plan.steps as Array<Record<string, unknown>>).find((step) => step.call === "motion.template.plan");
    expect(guideCatalog).toMatchObject(rootRequirement);
    expect(guideCatalog).not.toHaveProperty("requiredArgs");
    expect(planCatalog).toMatchObject(rootRequirement);
    expect(planCatalog).not.toHaveProperty("requiredArgs");
    expect(templatePlan).toMatchObject({ requiredArgs: ["request"], ...rootRequirement });
  });

  it("returns package-patch and vector-import discovery with argument contracts and navigation", async () => {
    for (const request of ["patch package", "apply JSON patch", "bulk edit package"]) {
      await expect(runCli(["actions", "find", request])).resolves.toMatchObject({
        ok: true,
        command: "actions.find",
        matched: true,
        action: { id: "motion.package.patch", permission: "edit_motion" },
        related: expect.any(Array)
      });
    }

    const patch = await runCli(["actions", "guide", "apply JSON patch"]);
    expect(patch).toMatchObject({
      actionId: "motion.package.patch",
      examples: [expect.objectContaining({ call: "motion.package.patch" })],
      related: expect.arrayContaining([expect.objectContaining({ id: "motion.revision.transaction" })])
    });
    expect((patch.steps as Array<{ call: string; requiredArgs?: string[] }>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ call: "motion.package.patch", requiredArgs: ["packageRoot", "outDir", "patch"] })
    ]));

    const lottie = await runCli(["actions", "guide", "import Lottie"]);
    expect(lottie).toMatchObject({
      actionId: "motion.lottie.import",
      steps: [expect.objectContaining({
        call: "motion.lottie.import",
        permission: "write_local",
        requiredArgs: ["sourcePath", "outDir"]
      })],
      examples: [expect.objectContaining({ call: "motion.lottie.import" })],
      related: expect.arrayContaining([expect.objectContaining({ id: "motion.dotlottie.import" })])
    });

    await expect(runCli(["actions", "guide", "import dotLottie"])).resolves.toMatchObject({
      actionId: "motion.dotlottie.import",
      steps: [expect.objectContaining({
        call: "motion.dotlottie.import",
        permission: "write_local",
        requiredArgs: ["sourcePath", "outDir"]
      })]
    });
  });

  it("routes tracking lifecycle aliases through typed debug commands", async () => {
    const request = await runCli([
      "debug", "tracking-request", "--tier", "write_local",
      "--analysis-id", "hero-track", "--asset-id", "hero-video",
      "--mode", "point", "--model", "translation",
      "--reference-json", '{"atMs":0,"bounds":{"x":0,"y":0,"width":16,"height":16},"points":[{"x":8,"y":8}]}',
      "--settings-json", '{"startMs":0,"endMs":100,"stepMs":100,"direction":"forward","searchRadiusPx":8,"pyramidLevels":2,"maxIterations":20,"confidenceFloor":0.7,"deterministicSeed":1}'
    ]);
    const inspect = await runCli(["debug", "tracking-inspect", "--analysis-id", "hero-track"]);
    const apply = await runCli(["debug", "tracking-apply", "--tier", "edit_motion", "--analysis-id", "hero-track", "--layer", "hero"]);
    const detach = await runCli(["debug", "tracking-detach", "--tier", "edit_motion", "--layer", "hero"]);
    const verify = await runCli(["debug", "tracking-verify", "--layer", "hero", "--analysis-id", "hero-track"]);

    expect(request).toMatchObject({ ok: false, command: "debug.tracking-request", error: { code: "invalid_args", message: "motion.analysis.tracking.request requires packageRoot." } });
    expect(inspect).toMatchObject({ ok: false, command: "debug.tracking-inspect", error: { code: "invalid_args", message: "motion.analysis.tracking.inspect requires packageRoot." } });
    expect(apply).toMatchObject({ ok: false, command: "debug.tracking-apply", error: { code: "invalid_args", message: "motion.analysis.tracking.apply requires packageRoot." } });
    expect(detach).toMatchObject({ ok: false, command: "debug.tracking-detach", error: { code: "invalid_args", message: "motion.analysis.tracking.detach requires packageRoot." } });
    expect(verify).toMatchObject({ ok: false, command: "debug.tracking-verify", error: { code: "invalid_args", message: "motion.analysis.tracking.verify requires packageRoot." } });
  });

  itLinux("routes remaining registry debug aliases through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const renderOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-render-final-"));
    const scriptOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-script-compile-"));
    const canvasOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-canvas-package-"));
    const templateOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-template-apply-"));
    const qualityOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-quality-"));
    const scriptPath = join(scriptOutDir, "storyboard.json");
    const selectionPath = join(canvasOutDir, "frame-selection.json");
    const mediaPath = join(qualityOutDir, "final.mp4");
    const qualityManifestPath = join(qualityOutDir, "quality-manifest.json");
    const qualityBaselinePath = join(qualityOutDir, "baseline.png");
    tempDirs.push(packageRoot, renderOutDir, scriptOutDir, canvasOutDir, templateOutDir, qualityOutDir);
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");
    await writeFile(selectionPath, `${JSON.stringify(shapeTextFrameSelection(), null, 2)}\n`, "utf8");
    await writeFile(mediaPath, "fake mp4 bytes", "utf8");
    await writeFile(qualityBaselinePath, "fake baseline", "utf8");
    await writeFile(
      qualityManifestPath,
      `${JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        audio: { expect: true, minPeakDb: -35 },
        samples: [
          { id: "hero", atMs: 250, baseline: "baseline.png", minBrightPixels: 2, maxChangedPixels: 5, maxMeanDiff: 0.5 }
        ]
      }, null, 2)}\n`,
      "utf8"
    );

    const actionsFind = await runCli(["debug", "actions-find", "--request", "render this lower third"]);
    const actionsGuide = await runCli(["debug", "actions-guide", "--request", "preview frame"]);
    const actionsPlan = await runCli(["debug", "actions-plan", "--request", "render this lower third"]);
    const timelineInspect = await runCli(["debug", "timeline-inspect", "--package", packageRoot]);
    const renderFinal = await runCli([
      "debug",
      "render-final",
      "--tier",
      "render_motion",
      "--package",
      packageRoot,
      "--output",
      join(renderOutDir, "final.mp4"),
      "--dry-run"
    ]);
    const reuseDryRun = await runCli([
      "debug",
      "render-final",
      "--tier",
      "render_motion",
      "--package",
      packageRoot,
      "--output",
      join(renderOutDir, "reuse-dry-run.mp4"),
      "--dry-run",
      "--reuse-attested"
    ]);
    const scriptCompile = await runCli([
      "debug",
      "script-compile",
      "--tier",
      "write_local",
      "--script",
      scriptPath,
      "--out",
      join(scriptOutDir, "package")
    ]);
    const canvasPackage = await runCli([
      "debug",
      "canvas-package",
      "--tier",
      "write_local",
      "--canvas-selection",
      selectionPath,
      "--out",
      join(canvasOutDir, "package")
    ]);
    const templateControls = await runCli(["debug", "template-controls", "--package", resolve("../../fixtures/packages/editable-lower-third")]);
    const templateApply = await runCli([
      "debug",
      "template-apply",
      "--tier",
      "edit_motion",
      "--package",
      resolve("../../fixtures/packages/editable-lower-third"),
      "--out",
      templateOutDir,
      "--set",
      "title=Debug Alias"
    ]);
    const qualityRunner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "4.000000" }
            ],
            format: { duration: "4.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "{\"input_i\":\"-23.0\",\"input_tp\":\"-2.0\",\"input_lra\":\"8.0\",\"input_thresh\":\"-33.0\",\"target_offset\":\"0.0\"}"
        };
      }
      throw new Error("debug quality-check alias should not extract frames for media-fact checks");
    };
    const qualityCheck = await runCli([
      "debug",
      "quality-check",
      "--tier",
      "render_motion",
      "--input",
      mediaPath,
      "--expect-width",
      "1920",
      "--expect-height",
      "1080",
      "--min-audio-lufs",
      "-24",
      "--max-audio-lufs",
      "-18",
      "--max-audio-true-peak-dbtp",
      "-1",
      "--max-audio-lra-lu",
      "12"
    ], { ffmpegRunner: qualityRunner, scratchRoot: qualityOutDir });
    const qualityPanel = await runCli([
      "debug",
      "quality-panel",
      "--tier",
      "read_motion",
      "--quality-manifest",
      qualityManifestPath,
      "--input",
      mediaPath,
      "--package",
      packageRoot,
      "--preset",
      "mp4-h264"
    ]);

    expect(actionsFind).toMatchObject({ ok: true, command: "debug.actions-find", result: { id: "motion.render.final" } });
    expect(actionsGuide).toMatchObject({ ok: true, command: "debug.actions-guide", result: { topic: "preview frame" } });
    expect(actionsPlan).toMatchObject({ ok: true, command: "debug.actions-plan", result: { action: { id: "motion.render.final" } } });
    expect(timelineInspect).toMatchObject({
      ok: true,
      command: "debug.timeline-inspect",
      visibleState: { panel: "timeline", packageId: "pkg_cli_ffmpeg_sequence" },
      result: { ok: true, packageId: "pkg_cli_ffmpeg_sequence" }
    });
    expect(renderFinal).toMatchObject({
      ok: true,
      command: "debug.render-final",
      visibleState: { operation: "render.final", status: "planned" },
      result: { ok: true, dryRun: true, outputPath: join(renderOutDir, "final.mp4") }
    });
    expect(reuseDryRun).toMatchObject({
      ok: false,
      command: "debug.render-final",
      error: { code: "invalid_args", message: "motion.render.final reuseAttested cannot be combined with dryRun." }
    });
    expect(scriptCompile).toMatchObject({
      ok: true,
      command: "debug.script-compile",
      visibleState: { operation: "script.compile", packageDir: join(scriptOutDir, "package") },
      result: { ok: true, packageId: "pkg_script_launch_demo", packageDir: join(scriptOutDir, "package") }
    });
    expect(canvasPackage).toMatchObject({
      ok: true,
      command: "debug.canvas-package",
      visibleState: { operation: "canvas.package", packageDir: join(canvasOutDir, "package") },
      result: { ok: true, packageId: "pkg_canvas_motion_real_frame_intro", packageDir: join(canvasOutDir, "package") }
    });
    expect(templateControls).toMatchObject({
      ok: true,
      command: "debug.template-controls",
      result: { ok: true, packageId: "pkg_editable_lower_third", templateId: "template_editable_lower_third" }
    });
    expect(templateApply).toMatchObject({
      ok: true,
      command: "debug.template-apply",
      visibleState: { operation: "template.apply", packageDir: templateOutDir },
      result: { ok: true, changedParams: ["title"], packageDir: templateOutDir }
    });
    expect(qualityCheck).toMatchObject({
      ok: true,
      command: "debug.quality-check",
      visibleState: { operation: "quality.check", status: "passed", inputPath: mediaPath },
      result: { ok: true, inputPath: mediaPath, media: { width: 1920, height: 1080 } }
    });
    expect(qualityPanel).toMatchObject({
      ok: true,
      command: "debug.quality-panel",
      visibleState: {
        panel: "quality",
        operation: "quality.panel",
        packageId: "pkg_cli_ffmpeg_sequence",
        manifestPath: qualityManifestPath,
        sampleCount: 1,
        baselineCount: 1,
        hasAudioPolicy: true
      },
      result: {
        ok: true,
        manifestPath: qualityManifestPath,
        inputPath: mediaPath,
        packageRoot,
        counts: { samples: 1, baselines: 1, audioPolicies: 1 },
        samples: [
          {
            id: "hero",
            baselinePath: qualityBaselinePath,
            baselineExists: true,
            thresholds: { minBrightPixels: 2, maxChangedPixels: 5, maxMeanDiff: 0.5 }
          }
        ],
        suggestedActions: expect.arrayContaining([
          { id: "qualityCheck", command: "motion.quality.check", args: { inputPath: mediaPath, manifestPath: qualityManifestPath } }
        ])
      }
    });
  });

  it("lists export presets with host-ready metadata", async () => {
    const result = await runCli(["export-presets"]);

    expect(result).toMatchObject({
      ok: true,
      command: "export-presets",
      presets: [
        {
          preset: "mp4-h264",
          label: "MP4 H.264",
          extension: "mp4",
          mimeType: "video/mp4",
          codec: "h264",
          container: "mp4",
          audioCodec: "aac",
          supportsAudio: true,
          supportsAlpha: false
        },
        expect.objectContaining({
          preset: "mp4-hevc",
          extension: "mp4",
          mimeType: "video/mp4",
          codec: "hevc",
          audioCodec: "aac",
          supportsAudio: true,
          supportsAlpha: false,
          encoderPolicy: { family: "hevc", mode: "software-preferred", candidates: ["libx265"] }
        }),
        expect.objectContaining({
          preset: "webm-av1",
          extension: "webm",
          mimeType: "video/webm",
          codec: "av1",
          audioCodec: "libopus",
          supportsAudio: true,
          supportsAlpha: false,
          encoderPolicy: { family: "av1", mode: "software-preferred", candidates: ["libsvtav1", "libaom-av1"] }
        }),
        expect.objectContaining({
          preset: "webm-vp9",
          extension: "webm",
          mimeType: "video/webm",
          audioCodec: "libopus",
          supportsAudio: true,
          supportsAlpha: false
        }),
        expect.objectContaining({
          preset: "webm-vp9-alpha",
          extension: "webm",
          mimeType: "video/webm",
          audioCodec: "libopus",
          supportsAudio: true,
          supportsAlpha: true
        }),
        expect.objectContaining({
          preset: "gif",
          extension: "gif",
          mimeType: "image/gif",
          audioCodec: null,
          supportsAudio: false,
          supportsAlpha: false
        }),
        expect.objectContaining({
          preset: "mov-prores",
          extension: "mov",
          mimeType: "video/quicktime",
          audioCodec: "pcm_s16le",
          supportsAudio: true,
          supportsAlpha: true
        }),
        expect.objectContaining({
          preset: "png-sequence",
          extension: "png",
          mimeType: "image/png",
          audioCodec: null,
          supportsAudio: false,
          supportsAlpha: true,
          outputKind: "image_sequence"
        }),
        expect.objectContaining({
          preset: "png-frame",
          extension: "png",
          mimeType: "image/png",
          audioCodec: null,
          supportsAudio: false,
          supportsAlpha: true,
          outputKind: "still_frame"
        }),
        expect.objectContaining({
          preset: "jpeg-frame",
          extension: "jpg",
          mimeType: "image/jpeg",
          audioCodec: null,
          supportsAudio: false,
          supportsAlpha: false,
          outputKind: "still_frame"
        })
      ]
    });
  });

  it("routes debug commands through the debug API", async () => {
    await expect(runCli(["debug", "state"])).resolves.toMatchObject({
      ok: true,
      command: "debug.state",
      result: { packageOpen: false, jobs: [] }
    });

    await expect(runCli(["debug", "open", "--panel", "preview"])).resolves.toMatchObject({
      ok: true,
      command: "debug.open",
      visibleState: { panel: "preview" }
    });
  });

  it("routes actions panel debug commands through the CLI", async () => {
    const result = await runCli(["debug", "actions-panel"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.actions-panel",
      visibleState: {
        panel: "actions",
        operation: "actions.panel",
        actionCount: expect.any(Number),
        promptActionCount: expect.any(Number),
        mutatingActionCount: expect.any(Number),
        surfaceCount: expect.any(Number)
      },
      result: {
        ok: true,
        actions: expect.arrayContaining([
          expect.objectContaining({ id: "motion.actions.panel", permission: "read_motion", mutates: false }),
          expect.objectContaining({ id: "motion.template.panel", permission: "read_motion" }),
          expect.objectContaining({ id: "motion.render.final", permission: "render_motion" })
        ]),
        promptCommands: expect.arrayContaining([
          { id: "plan", command: "motion.actions.plan", args: { request: "" } },
          { id: "run", command: "motion.prompt.run", args: { request: "" } }
        ])
      }
    });
  });

  it("routes preview strip debug commands through the CLI", async () => {
    await expect(runCli(["debug", "preview-strip", "--tier", "render_motion", "--frame-count", "3"])).resolves.toEqual({
      ok: false,
      command: "debug.preview-strip",
      error: {
        code: "invalid_args",
        message: "motion.preview.strip requires packageRoot."
      },
      warnings: []
    });
  });

  it("routes preview frame debug commands with deterministic createdAt through the CLI", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-preview-frame-"));
    tempDirs.push(outDir);
    const rendererCreatedAt: Array<string | undefined> = [];

    const result = await runCli([
      "debug",
      "preview-frame",
      "--tier",
      "render_motion",
      "--package",
      fixtureRoot,
      "--out",
      outDir,
      "--at-ms",
      "125",
      "--created-at",
      "2026-07-03T12:00:00.000Z"
    ], {
      browserFrameRenderer: async (pkg, options) => {
        rendererCreatedAt.push(options.now?.());
        const output = {
          path: options.outputPath ?? join(options.outDir, "debug-frame.png"),
          sha256: "f".repeat(64),
          format: "png" as const,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        };
        return {
          ok: true,
          output,
          receipt: cliDebugReceipt({
            id: "cli-preview-frame-created-at",
            operation: "preview.frame",
            status: "passed",
            packageId: pkg.manifest.id,
            lane: "browser",
            output: { ...output, createdAt: options.now?.() }
          })
        };
      }
    });

    expect(rendererCreatedAt).toEqual(["2026-07-03T12:00:00.000Z"]);
    expect(result).toMatchObject({
      ok: true,
      command: "debug.preview-frame",
      receiptId: "cli-preview-frame-created-at",
      result: {
        ok: true,
        packageId: "pkg_lower_third",
        output: {
          atMs: 125
        }
      }
    });
  });

  it("routes playhead preview debug commands through the CLI", async () => {
    await expect(runCli(["debug", "preview-playhead", "--tier", "render_motion"])).resolves.toEqual({
      ok: false,
      command: "debug.preview-playhead",
      error: {
        code: "invalid_args",
        message: "motion.preview.playhead requires packageRoot."
      },
      warnings: []
    });
  });

  it("passes deterministic createdAt to preview playhead and strip debug CLI commands", async () => {
    const packageRoot = await writeTinyNativePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-preview-created-at-"));
    tempDirs.push(packageRoot, outDir);
    const rendererCreatedAt: Array<string | undefined> = [];

    const browserFrameRenderer: BrowserFrameRenderer = async (pkg, options) => {
      rendererCreatedAt.push(options.now?.());
      const output = {
        path: options.outputPath ?? join(options.outDir, `debug-${options.atMs}.png`),
        sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
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
          id: `cli-preview-${options.atMs}`,
          operation: "preview.frame",
          status: "passed",
          packageId: pkg.manifest.id,
          lane: "browser",
          output
        })
      };
    };

    const playhead = await runCli([
      "debug",
      "preview-playhead",
      "--tier",
      "render_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--created-at",
      "2026-07-03T12:10:00.000Z"
    ], { browserFrameRenderer });
    const strip = await runCli([
      "debug",
      "preview-strip",
      "--tier",
      "render_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--frame-count",
      "2",
      "--created-at",
      "2026-07-03T12:20:00.000Z"
    ], { browserFrameRenderer });

    expect(rendererCreatedAt).toEqual([
      "2026-07-03T12:10:00.000Z",
      "2026-07-03T12:20:00.000Z",
      "2026-07-03T12:20:00.000Z"
    ]);
    expect(playhead).toMatchObject({
      ok: true,
      command: "debug.preview-playhead",
      result: { receipt: { createdAt: "2026-07-03T12:10:00.000Z" } }
    });
    expect(strip).toMatchObject({
      ok: true,
      command: "debug.preview-strip",
      result: { receipt: { createdAt: "2026-07-03T12:20:00.000Z" } }
    });
  });

  itLinux("routes receipt list and read debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-receipts-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const receipt = cliDebugReceipt({
      id: "render-final-1",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_demo",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "final.mp4"), width: 1920, height: 1080, durationMs: 4000, codec: "h264", container: "mp4" }
    });
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

      const listed = await runCli(["debug", "receipts-list", "--receipts-root", receiptsRoot]);

      expect(listed).toMatchObject({
        ok: true,
        command: "debug.receipts-list",
        visibleState: { panel: "receipts", receiptCount: 1 },
        result: {
          ok: true,
          receiptsRoot,
          receiptCount: 1,
          receipts: [
            expect.objectContaining({
              id: "render-final-1",
              operation: "render.final",
              status: "passed",
              path: join(receiptsRoot, "render.receipt.json")
            })
          ]
        }
      });

      const panel = await runCli(["debug", "receipts-panel", "--receipts-root", receiptsRoot, "--limit", "1"]);

      expect(panel).toMatchObject({
        ok: true,
        command: "debug.receipts-panel",
        visibleState: {
          panel: "receipts",
          operation: "receipts.panel",
          receiptCount: 1,
          failedCount: 0,
          warningCount: 0
        },
        result: {
          ok: true,
          receiptsRoot,
          receiptCount: 1,
          statusCounts: { passed: 1, warning: 0, failed: 0, not_run: 0 },
          recentReceipts: [expect.objectContaining({ id: "render-final-1" })]
        }
      });

      const read = await runCli(["debug", "receipts-read", "--receipts-root", receiptsRoot, "--receipt-id", "render-final-1"]);

      expect(read).toMatchObject({
        ok: true,
        command: "debug.receipts-read",
        receiptId: "render-final-1",
        visibleState: {
          panel: "receipts",
          receiptId: "render-final-1",
          operation: "render.final",
          status: "passed"
        },
        result: {
          ok: true,
          path: join(receiptsRoot, "render.receipt.json"),
          receipt
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("routes platform verification panel debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-platform-panel-"));
    const receiptsRoot = join(tempRoot, "receipts");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writePlatformReceipt(receiptsRoot, "linux");
      await writeFile(
        join(receiptsRoot, "aggregate.platform.json"),
        `${JSON.stringify({
          schema: "shellx-motion/platform-verification-aggregate@1",
          status: "failed",
          dryRun: false,
          repoRoot: "/workspace/ShellX Motion",
          startedAt: "2026-07-03T10:30:00.000Z",
          finishedAt: "2026-07-03T10:30:00.000Z",
          requiredHosts: ["linux", "windows", "macos"],
          requiredCommands: ["typecheck"],
          summary: { requiredHostCount: 3, satisfiedHostCount: 1, missingHosts: ["windows", "macos"], failedHosts: ["windows", "macos"], invalidReceiptCount: 0 },
          receipts: [
            { path: "/tmp/linux.platform.json", hostId: "linux", schemaOk: true, status: "passed", dryRun: false, ok: true, failures: [], requiredCommands: { total: 1, passed: 1, missing: [], failed: [] } }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await runCli([
        "debug",
        "platform-verification-panel",
        "--receipts-root",
        receiptsRoot,
        "--required-hosts",
        "linux,windows,macos"
      ]);

      expect(result).toMatchObject({
        ok: true,
        command: "debug.platform-verification-panel",
        visibleState: {
          panel: "receipts",
          operation: "platform.verification.panel",
          status: "failed",
          platformReceiptCount: 2,
          hostReceiptCount: 1,
          aggregateReceiptCount: 1,
          missingHostCount: 2,
          failedHostCount: 2
        },
        result: {
          ok: true,
          receiptsRoot,
          requiredHosts: ["linux", "windows", "macos"],
          satisfiedHosts: ["linux"],
          missingHosts: ["windows", "macos"],
          failedHosts: ["windows", "macos"]
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("routes render status and export preset debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-render-status-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const receipt = cliDebugReceipt({
      id: "render-final-passed",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_demo",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "final.mp4"), width: 1280, height: 720, durationMs: 3000, codec: "h264", container: "mp4" }
    });
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

      const status = await runCli(["debug", "render-status", "--receipts-root", receiptsRoot]);

      expect(status).toMatchObject({
        ok: true,
        command: "debug.render-status",
        visibleState: {
          panel: "render",
          jobCount: 1,
          failedCount: 0,
          stateCounts: { pending: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, skipped: 0 }
        },
        result: {
          ok: true,
          receiptsRoot,
          jobCount: 1,
          failedCount: 0,
          stateCounts: { pending: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, skipped: 0 },
          jobs: [
            expect.objectContaining({
              receiptId: "render-final-passed",
              operation: "render.final",
              status: "passed",
              state: "succeeded",
              progress: { completed: 1, total: 1, percent: 100 },
              outputPath: join(tempRoot, "final.mp4")
            })
          ]
        }
      });

      const queue = await runCli(["debug", "render-queue", "--receipts-root", receiptsRoot]);

      expect(queue).toMatchObject({
        ok: true,
        command: "debug.render-queue",
        visibleState: {
          panel: "render",
          operation: "render.queue",
          jobCount: 1,
          actionableCount: 0,
          failedCount: 0,
          stateCounts: { pending: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, skipped: 0 }
        },
        result: {
          ok: true,
          receiptsRoot,
          jobCount: 1,
          actionableCount: 0,
          jobs: [
            expect.objectContaining({
              receiptId: "render-final-passed",
              state: "succeeded",
              availableActions: []
            })
          ]
        }
      });

      const presets = await runCli(["debug", "export-presets"]);

      expect(presets).toMatchObject({
        ok: true,
        command: "debug.export-presets",
        visibleState: { panel: "export", presetCount: expect.any(Number) },
        result: {
          ok: true,
          presets: expect.arrayContaining([
            expect.objectContaining({ preset: "mp4-h264", supportsAudio: true }),
            expect.objectContaining({ preset: "gif", supportsAudio: false })
          ])
        }
      });

      const panel = await runCli(["debug", "export-panel"]);

      expect(panel).toMatchObject({
        ok: true,
        command: "debug.export-panel",
        visibleState: {
          panel: "export",
          operation: "export.panel",
          presetCount: 10,
          groupCount: 4,
          defaultPreset: "mp4-h264"
        },
        result: {
          ok: true,
          defaultPreset: "mp4-h264",
          groups: expect.arrayContaining([
            expect.objectContaining({ id: "delivery", presetIds: ["mp4-h264", "mp4-hevc", "webm-av1", "webm-vp9"] }),
            expect.objectContaining({ id: "image", presetIds: ["png-sequence", "png-frame", "jpeg-frame"] })
          ]),
          cards: expect.arrayContaining([
            expect.objectContaining({ preset: "mp4-h264", groupId: "delivery", badges: ["audio"] }),
            expect.objectContaining({ preset: "webm-vp9-alpha", groupId: "transparent", badges: ["audio", "alpha"] })
          ])
        }
      });

      const audioPackageRoot = await writeTinyPackageWithAudioLayer();
      try {
        const audioPanel = await runCli(["debug", "audio-panel", "--package", audioPackageRoot, "--preset", "gif"]);

        expect(audioPanel).toMatchObject({
          ok: true,
          command: "debug.audio-panel",
          visibleState: {
            panel: "audio",
            operation: "audio.panel",
            packageId: "pkg_cli_ffmpeg_sequence",
            motionId: "motion_cli_ffmpeg_sequence",
            audioLayerCount: 1,
            resolvedInputCount: 1,
            warningCount: 1,
            preset: "gif"
          },
          result: {
            ok: true,
            packageRoot: audioPackageRoot,
            packageId: "pkg_cli_ffmpeg_sequence",
            counts: { layers: 1, resolvedInputs: 1 },
            preset: {
              preset: "gif",
              supportsAudio: false,
              willDropAudio: true
            }
          },
          warnings: ["Export preset gif does not support audio; 1 requested audio track will be ignored."]
        });
      } finally {
        await rm(audioPackageRoot, { recursive: true, force: true });
      }

      const mediaPackageRoot = await writeTinyPackageWithMediaLayers();
      try {
        const mediaPanel = await runCli(["debug", "media-panel", "--package", mediaPackageRoot, "--preset", "gif"]);

        expect(mediaPanel).toMatchObject({
          ok: true,
          command: "debug.media-panel",
          visibleState: {
            panel: "media",
            operation: "media.panel",
            packageId: "pkg_cli_media",
            motionId: "motion_cli_media",
            mediaLayerCount: 5,
            imageLayerCount: 2,
            videoLayerCount: 1,
            audioLayerCount: 1,
            webLayerCount: 1,
            missingSourceCount: 1,
            noSourceLayerCount: 1,
            warningCount: 3,
            preset: "gif"
          },
          result: {
            ok: true,
            packageRoot: mediaPackageRoot,
            packageId: "pkg_cli_media",
            counts: {
              mediaLayers: 5,
              imageLayers: 2,
              videoLayers: 1,
              audioLayers: 1,
              webLayers: 1,
              packageSources: 3,
              missingSources: 1,
              noSourceLayers: 1,
              includeAudioLayers: 1
            },
            preset: {
              preset: "gif",
              supportsAudio: false,
              warnings: ["Export preset gif does not support audio; video layer audio and audio layers will be dropped."]
            },
            layers: expect.arrayContaining([
              expect.objectContaining({ id: "clip", type: "video", includeAudio: true, readiness: "ready" }),
              expect.objectContaining({ id: "music", type: "audio", readiness: "missing" }),
              expect.objectContaining({ id: "placeholder", type: "image", sourceKind: "no-source", readiness: "missing" })
            ])
          },
          warnings: [
            "Local media source is missing: assets/missing.wav",
            "Media layer has no source reference.",
            "Export preset gif does not support audio; video layer audio and audio layers will be dropped."
          ]
        });
      } finally {
        await rm(mediaPackageRoot, { recursive: true, force: true });
      }

      const connectorPanel = await runCli(["debug", "connector-panel"]);

      expect(connectorPanel).toMatchObject({
        ok: true,
        command: "debug.connector-panel",
        visibleState: {
          panel: "connector",
          operation: "connector.panel",
          connectorCount: 6,
          canvasConnectorCount: 2,
          cutConnectorCount: 5,
          independentExportCount: 1,
          renderedMediaCount: 6,
          qualityGateCount: 1,
          warningCount: 0
        },
        result: {
          ok: true,
          counts: {
            connectors: 6,
            canvasConnectors: 2,
            cutConnectors: 5,
            independentExports: 1,
            renderedMedia: 6,
            qualityGated: 1
          },
          cards: expect.arrayContaining([
            expect.objectContaining({ id: "canvas_to_mp4", command: "motion.connector.canvas_to_mp4", outputKind: "mp4" }),
            expect.objectContaining({ id: "canvas_to_cut", command: "motion.connector.canvas_to_cut", targetProduct: "shellx-cut" }),
            expect.objectContaining({ id: "script_to_cut", command: "motion.connector.script_to_cut", targetProduct: "shellx-cut" }),
            expect.objectContaining({ id: "source_to_cut", command: "motion.connector.source_to_cut", sourceProduct: "imported-source" }),
            expect.objectContaining({ id: "cut_generate_to_cut", command: "motion.connector.cut_generate_to_cut", sourceProduct: "shellx-cut" }),
            expect.objectContaining({ id: "template_to_cut", command: "motion.connector.template_to_cut", templateDriven: true })
          ])
        },
        warnings: []
      });

      const packageRoot = await writeTinyPackageWithTimeline();
      const outputPath = join(tempRoot, "transparent.webm");
      try {
        const plan = await runCli([
          "debug",
          "export-plan",
          "--package",
          packageRoot,
          "--target",
          "transparent overlay",
          "--needs-alpha",
          "--needs-audio",
          "--out",
          outputPath,
          "--quality-manifest",
          join(packageRoot, "quality-manifest.json")
        ]);

        expect(plan).toMatchObject({
          ok: true,
          command: "debug.export-plan",
          visibleState: {
            panel: "export",
            operation: "export.plan",
            preset: "webm-vp9-alpha",
            target: "transparent overlay"
          },
          result: {
            ok: true,
            preset: "webm-vp9-alpha",
            outputPath,
            capturePlan: {
              mode: "deterministic-browser-capture",
              requirements: expect.arrayContaining(["stylesheets-and-fonts-ready-before-animation-start"])
            },
            suggestedArgs: {
              debugRender: expect.arrayContaining(["--preset", "webm-vp9-alpha"])
            }
          }
        });
      } finally {
        await rm(packageRoot, { recursive: true, force: true });
      }

      const pipelinePlan = await runCli([
        "debug",
        "export-plan",
        "--package",
        fixtureRoot,
        "--target",
        "Cut delivery",
        "--preset",
        "mp4-h264",
        "--needs-audio",
        "--out",
        join(tempRoot, "lower-third.mp4")
      ]);

      expect(pipelinePlan).toMatchObject({
        ok: true,
        command: "debug.export-plan",
        visibleState: {
          panel: "export",
          operation: "export.plan",
          packageId: "pkg_lower_third",
          preset: "mp4-h264",
          recommendedLane: "ffmpeg",
          recommendedPipeline: ["browser", "ffmpeg"]
        },
        result: {
          ok: true,
          preset: "mp4-h264",
          recommendedLane: "ffmpeg",
          recommendedPipeline: {
            lanes: ["browser", "ffmpeg"],
            frameLane: "browser",
            finalLane: "ffmpeg"
          },
          suggestedArgs: {
            render: expect.arrayContaining(["--frame-lane", "browser"]),
            debugRender: expect.arrayContaining(["--frame-lane", "browser"])
          }
        }
      });

      await writePlatformReceipt(receiptsRoot, "linux");
      const platformExportPanel = await runCli([
        "debug",
        "export-panel",
        "--receipts-root",
        receiptsRoot,
        "--required-hosts",
        "linux,windows,macos"
      ]);

      expect(platformExportPanel).toMatchObject({
        ok: true,
        command: "debug.export-panel",
        visibleState: {
          panel: "export",
          operation: "export.panel",
          platformVerificationStatus: "partial",
          verifiedAlphaPresetCount: 0
        },
        result: {
          ok: true,
          platformVerification: {
            receiptsRoot,
            requiredHosts: ["linux", "windows", "macos"],
            satisfiedHosts: ["linux"],
            missingHosts: ["windows", "macos"]
          },
          cards: expect.arrayContaining([
            expect.objectContaining({
              preset: "webm-vp9",
              verification: expect.objectContaining({
                status: "partial",
                requiredCommands: ["render-webm:smoke"],
                missingHosts: ["windows", "macos"]
              })
            }),
            expect.objectContaining({
              preset: "webm-vp9-alpha",
              verification: expect.objectContaining({
                status: "partial",
                requiredCommands: ["render-alpha:smoke"],
                missingHosts: ["windows", "macos"]
              })
            })
          ])
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes asset and brand panel debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithAssetsAndBrand();
    tempDirs.push(packageRoot);

    const assets = await runCli(["debug", "assets-panel", "--package", packageRoot]);
    const brand = await runCli(["debug", "brand-panel", "--package", packageRoot]);

    expect(assets).toMatchObject({
      ok: true,
      command: "debug.assets-panel",
      visibleState: {
        panel: "assets",
        operation: "assets.panel",
        packageId: "pkg_cli_assets",
        motionId: "motion_cli_assets",
        declaredAssetCount: 2,
        motionAssetCount: 1,
        referencedAssetCount: 2,
        missingAssetCount: 1,
        unusedDeclaredAssetCount: 1
      },
      result: {
        ok: true,
        assets: [
          { ref: "assets/logo.png", exists: true, usedByLayerIds: ["logo"], sizeBytes: 8 },
          { ref: "assets/missing.png", exists: false, usedByLayerIds: [] }
        ],
        layerRefs: [
          { layerId: "logo", field: "assetRef", ref: "assets/logo.png", declared: true, exists: true },
          { layerId: "remote", field: "src", ref: "https://cdn.example.com/remote.png", declared: false, external: true }
        ],
        missingAssets: ["assets/missing.png"]
      }
    });
    expect(brand).toMatchObject({
      ok: true,
      command: "debug.brand-panel",
      visibleState: {
        panel: "brand",
        operation: "brand.panel",
        packageId: "pkg_cli_assets",
        motionId: "motion_cli_assets",
        hasDesignTokens: true,
        tokenGroupCount: 2,
        colorTokenCount: 1,
        typographyTokenCount: 1,
        sourceApp: "shellx-canvas",
        projectId: "canvas_project",
        selectedFrameId: "frame_hero"
      },
      result: {
        ok: true,
        colorTokens: [{ path: "color.accent", value: "#ff006e" }],
        typographyTokens: [{ path: "typography.heading", value: { fontFamily: "Inter", fontWeight: 800 } }]
      }
    });
  });

  it("routes package browser debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithAssetsAndBrand();
    tempDirs.push(packageRoot);
    const templateRoot = resolve("../../fixtures/packages/editable-lower-third");

    const result = await runCli([
      "debug",
      "packages-browse",
      "--package",
      packageRoot,
      "--package",
      templateRoot
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.packages-browse",
      visibleState: {
        panel: "packages",
        operation: "packages.browse",
        rootCount: 2,
        packageCount: 2,
        warningCount: 0,
        templateCount: 1
      },
      result: {
        ok: true,
        packageCount: 2,
        templateCount: 1,
        packages: expect.arrayContaining([
          expect.objectContaining({
            packageId: "pkg_cli_assets",
            packageName: "CLI Assets",
            assetCount: 2,
            designTokenGroupCount: 2,
            hasTemplate: false,
            suggestedActions: expect.arrayContaining([
              { id: "assets", command: "motion.assets.panel", args: { packageRoot } },
              { id: "brand", command: "motion.brand.panel", args: { packageRoot } }
            ])
          }),
          expect.objectContaining({
            packageId: "pkg_editable_lower_third",
            packageName: "Editable Lower Third",
            hasTemplate: true,
            templateId: "template_editable_lower_third",
            controlCount: 4,
            suggestedActions: expect.arrayContaining([
              { id: "templateControls", command: "motion.template.controls", args: { packageRoot: templateRoot } }
            ])
          })
        ])
      }
    });
  });

  itLinux("routes product workflow debug commands through the CLI wrapper", async () => {
    const batchOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-batch-"));
    const mp4OutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-canvas-mp4-"));
    const scriptOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-cut-generate-"));
    const templateOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-template-cut-"));
    const selectionPath = join(mp4OutDir, "frame-selection.json");
    tempDirs.push(batchOutDir, mp4OutDir, scriptOutDir, templateOutDir);
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");

    const batch = await runCli([
      "debug",
      "render-batch",
      "--tier",
      "render_motion",
      "--trusted-local-tier",
      "--package",
      batchFixtureRoot,
      "--out",
      batchOutDir,
      "--dry-run"
    ]);

    expect(batch).toMatchObject({
      ok: true,
      command: "debug.render-batch",
      visibleState: {
        operation: "render.batch",
        rows: 2,
        status: "not_run"
      },
      result: {
        ok: true,
        dryRun: true,
        preset: "mp4-h264",
        rows: 2
      }
    });

    const mp4 = await runCli([
      "debug",
      "connector-canvas-to-mp4",
      "--tier",
      "write_local",
      "--trusted-local-tier",
      "--canvas-selection",
      selectionPath,
      "--out",
      mp4OutDir,
      "--preset",
      "webm-vp9",
      "--dry-run-render"
    ]);

    expect(mp4).toMatchObject({
      ok: true,
      command: "debug.connector-canvas-to-mp4",
      receiptId: expect.stringMatching(/^connector-canvas-mp4-/),
      visibleState: {
        panel: "receipts",
        operation: "connector.canvas_to_mp4",
        ok: true,
        renderPath: join(mp4OutDir, "render", "pkg_canvas_motion_real_frame_intro.webm"),
        receiptPath: join(mp4OutDir, "canvas-mp4-export.receipt.json")
      },
      result: {
        render: {
          ok: true,
          dryRun: true,
          lane: "ffmpeg",
          preset: "webm-vp9",
          outputPath: join(mp4OutDir, "render", "pkg_canvas_motion_real_frame_intro.webm")
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "rendered_media", path: join(mp4OutDir, "render", "pkg_canvas_motion_real_frame_intro.webm"), status: "planned", mediaType: "video/webm", primary: true })
        ])
      }
    });

    const cutGenerate = await runCli([
      "debug",
      "connector-cut-generate-to-cut",
      "--tier",
      "write_local",
      "--trusted-local-tier",
      "--script-json",
      JSON.stringify(scriptedVideo()),
      "--out",
      scriptOutDir,
      "--created-at",
      "2026-07-01T00:00:00.000Z",
      "--dry-run-render"
    ]);

    expect(cutGenerate).toMatchObject({
      ok: true,
      command: "debug.connector-cut-generate-to-cut",
      visibleState: {
        operation: "connector.cut_generate_to_cut",
        ok: true,
        cutPlanPath: join(scriptOutDir, "cut-import-plan.json")
      },
      result: {
        packageDir: join(scriptOutDir, "package"),
        preview: { ok: true, lane: "native" },
        render: {
          ok: true,
          required: true,
          dryRun: true,
          lane: "ffmpeg",
          outputPath: join(scriptOutDir, "render", "pkg_script_launch_demo.mp4")
        },
        cutPlanPath: join(scriptOutDir, "cut-import-plan.json"),
        receiptPath: join(scriptOutDir, "connector-run.receipt.json")
      }
    });

    const template = await runCli([
      "debug",
      "connector-template-to-cut",
      "--tier",
      "write_local",
      "--trusted-local-tier",
      "--package",
      resolve("../../fixtures/cut-native-static-package"),
      "--out",
      templateOutDir,
      "--cut-import-mode",
      "editable_lowering",
      "--values-json",
      JSON.stringify({ title: "Debug CLI Lower Third" })
    ]);

    expect(template).toMatchObject({
      ok: false,
      command: "debug.connector-template-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("only cutImportMode rendered_media") }
    });
  });

  it("routes debug render-batch real runs through the CLI wrapper", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-batch-run-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const outputPath = command.args[command.args.length - 1];
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `fake debug batch ${commands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await runCli([
      "debug",
      "render-batch",
      "--tier",
      "render_motion",
      "--package",
      sourceRoot,
      "--out",
      outDir,
      "--run"
    ], {
      ffmpegRunner: runner,
      browserFrameRenderer: materializedBatchBrowserFrameRenderer(),
      scratchRoot: join(outDir, "frames")
    });

    // `warning`, not `passed`: the injected runner writes the same fake frame every time, so the
    // delivered pixels really are static and the engine really does report it. The debug batch this
    // passthrough must not claim `passed` over that advisory. See
    // `packages/debug-api/src/batch-receipt-status.test.ts` for the cross-surface contract.
    expect(result).toMatchObject({
      ok: true,
      command: "debug.render-batch",
      visibleState: {
        operation: "render.batch",
        status: "warning"
      },
      result: {
        ok: true,
        dryRun: false,
        jobs: [
          {
            rowId: "ada",
            status: "warning",
            receiptPath: expect.any(String)
          },
          {
            rowId: "grace",
            status: "warning",
            receiptPath: expect.any(String)
          }
        ]
      }
    });
    const jobs = ((result.result as { jobs: Array<{ receiptPath: string }> }).jobs);
    const adaReceipt = JSON.parse(await readFile(jobs[0].receiptPath, "utf8")) as Record<string, any>;
    const graceReceipt = JSON.parse(await readFile(jobs[1].receiptPath, "utf8")) as Record<string, any>;
    expect(adaReceipt).toMatchObject({ output: { frameTransportPlan: { delivery: "materialized", reason: "injected_frame_renderer" } } });
    expect(graceReceipt).toMatchObject({ output: { frameTransportPlan: { delivery: "materialized", reason: "injected_frame_renderer" } } });
    expect(commands.filter((command) => command.args[0] === "-version")).toHaveLength(2);
    expect(commands.filter((command) => command.args.includes("-framerate"))).toHaveLength(2);
    await expect(readFile(join(outDir, "render", "pkg_batch_card_ada.mp4"), "utf8")).resolves.toContain("fake debug batch");
  }, 45_000);

  it("routes browser workflow capture debug commands through the CLI wrapper", async () => {
    const packageRoot = await writeTinyNativePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-browser-workflow-"));
    const workflowPath = join(outDir, "workflow.json");
    tempDirs.push(packageRoot, outDir);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      viewport: { width: 64, height: 36, deviceScaleFactor: 1 },
      networkPolicy: "blocked-unless-declared",
      steps: [{ action: "wait", ms: 5 }]
    }, null, 2));

    const result = await runCli([
      "debug",
      "browser-workflow-capture",
      "--tier",
      "render_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--workflow",
      workflowPath,
      "--at-ms",
      "100"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.browser-workflow-capture",
      visibleState: {
        operation: "browser.workflow.capture",
        packageId: "pkg_cli_ffmpeg_sequence",
        outputPath: expect.stringContaining(outDir),
        workflowTracePath: join(outDir, "pkg_cli_ffmpeg_sequence-browser-workflow.trace.json")
      },
      result: {
        command: "browser.workflow.capture",
        workflowPath,
        workflowTracePath: join(outDir, "pkg_cli_ffmpeg_sequence-browser-workflow.trace.json"),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "browser_workflow_trace", status: "available", mediaType: "application/json" })
        ])
      }
    });
  });

  itLinux("routes render cancel and retry debug commands through the CLI", async () => {
    await expect(runCli(["debug", "render-cancel", "--tier", "render_motion", "--receipt-id", "render-1"])).resolves.toEqual({
      ok: false,
      command: "debug.render-cancel",
      error: {
        code: "invalid_args",
        message: "motion.render.cancel requires receiptsRoot."
      },
      warnings: []
    });

    await expect(runCli(["debug", "render-retry", "--tier", "render_motion", "--receipt-id", "render-1"])).resolves.toEqual({
      ok: false,
      command: "debug.render-retry",
      error: {
        code: "invalid_args",
        message: "motion.render.retry requires receiptsRoot."
      },
      warnings: []
    });

    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-lifecycle-"));
    tempDirs.push(tempRoot);
    const receiptsRoot = join(tempRoot, "receipts");
    const queued = cliDebugReceipt({
      id: "render-final-queued-cli",
      operation: "render.final",
      status: "not_run",
      packageId: "pkg_cli_lifecycle",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "queued.mp4"), preset: "mp4-h264" }
    });
    const failed = cliDebugReceipt({
      id: "render-final-failed-cli",
      operation: "render.final",
      status: "failed",
      packageId: "pkg_cli_lifecycle",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "failed.mp4"), preset: "mp4-h264" }
    });
    await mkdir(receiptsRoot, { recursive: true });
    await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`, "utf8");
    await writeFile(join(receiptsRoot, "failed.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`, "utf8");

    const cancel = await runCli([
      "debug",
      "render-cancel",
      "--tier",
      "render_motion",
      "--receipts-root",
      receiptsRoot,
      "--receipt-id",
      "render-final-queued-cli",
      "--reason",
      "user cancelled queued export"
    ]);
    expect(cancel).toMatchObject({
      ok: true,
      command: "debug.render-cancel",
      visibleState: {
        operation: "render.cancel",
        targetReceiptId: "render-final-queued-cli",
        state: "cancelled"
      },
      result: {
        targetReceiptId: "render-final-queued-cli",
        targetState: "pending",
        state: "cancelled",
        receipt: expect.objectContaining({
          operation: "render.cancel",
          status: "passed",
          output: expect.objectContaining({ reason: "user cancelled queued export" })
        })
      }
    });

    const retry = await runCli([
      "debug",
      "render-retry",
      "--tier",
      "render_motion",
      "--receipts-root",
      receiptsRoot,
      "--receipt-id",
      "render-final-failed-cli",
      "--reason",
      "retry after transient failure"
    ]);
    expect(retry).toMatchObject({
      ok: true,
      command: "debug.render-retry",
      visibleState: {
        operation: "render.retry",
        sourceReceiptId: "render-final-failed-cli",
        state: "pending"
      },
      result: {
        sourceReceiptId: "render-final-failed-cli",
        state: "pending",
        retryAttempt: 1,
        receipt: expect.objectContaining({
          operation: "render.retry",
          status: "not_run",
          output: expect.objectContaining({ reason: "retry after transient failure", retryAttempt: 1 })
        })
      }
    });

    const retryReceiptId = (retry as { receiptId?: string }).receiptId;
    const queue = await runCli(["debug", "render-queue", "--receipts-root", receiptsRoot]);
    expect(queue).toMatchObject({
      ok: true,
      command: "debug.render-queue",
      visibleState: {
        operation: "render.queue",
        stateCounts: { pending: 1, running: 0, succeeded: 0, failed: 1, cancelled: 1, skipped: 0 }
      },
      result: {
        jobs: expect.arrayContaining([
          expect.objectContaining({
            receiptId: "render-final-queued-cli",
            state: "cancelled",
            control: expect.objectContaining({ reason: "user cancelled queued export" })
          }),
          expect.objectContaining({
            receiptId: "render-final-failed-cli",
            state: "failed",
            availableActions: [{ id: "retry", command: "motion.render.retry", receiptId: "render-final-failed-cli" }]
          }),
          expect.objectContaining({
            receiptId: retryReceiptId,
            state: "pending",
            handoff: expect.objectContaining({
              schema: "shellx-motion/render-job-handoff@1",
              sourceReceiptId: "render-final-failed-cli",
              retryAttempt: 1
            }),
            availableActions: [{ id: "cancel", command: "motion.render.cancel", receiptId: retryReceiptId }]
          })
        ])
      }
    });
  });

  it("routes agent transcript debug commands through the CLI", async () => {
    await expect(runCli(["debug", "agent-transcript", "--receipt-id", "prompt-1"])).resolves.toEqual({
      ok: false,
      command: "debug.agent-transcript",
      error: {
        code: "invalid_args",
        message: "motion.agent.transcript requires receiptsRoot."
      },
      warnings: []
    });
  });

  itLinux("routes prompt queue, cancel, and retry debug commands through the CLI", async () => {
    await expect(runCli(["debug", "prompt-cancel", "--tier", "draft_motion", "--receipt-id", "prompt-1"])).resolves.toEqual({
      ok: false,
      command: "debug.prompt-cancel",
      error: {
        code: "invalid_args",
        message: "motion.prompt.cancel requires receiptsRoot."
      },
      warnings: []
    });

    await expect(runCli(["debug", "prompt-retry", "--tier", "draft_motion", "--receipt-id", "prompt-1"])).resolves.toEqual({
      ok: false,
      command: "debug.prompt-retry",
      error: {
        code: "invalid_args",
        message: "motion.prompt.retry requires receiptsRoot."
      },
      warnings: []
    });

    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-lifecycle-"));
    tempDirs.push(tempRoot);
    const receiptsRoot = join(tempRoot, "receipts");
    const queued = cliDebugReceipt({
      id: "prompt-run-queued-cli",
      operation: "prompt.run",
      status: "not_run",
      packageId: "pkg_prompt_cli",
      lane: "agent",
      output: { request: "edit title and preview", agentId: "codex" }
    });
    const failed = cliDebugReceipt({
      id: "prompt-run-failed-cli",
      operation: "prompt.run",
      status: "failed",
      packageId: "pkg_prompt_cli",
      lane: "agent",
      output: { request: "render package preview", agentId: "codex" }
    });
    await mkdir(receiptsRoot, { recursive: true });
    await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`, "utf8");
    await writeFile(join(receiptsRoot, "failed.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`, "utf8");

    const cancel = await runCli([
      "debug",
      "prompt-cancel",
      "--tier",
      "draft_motion",
      "--receipts-root",
      receiptsRoot,
      "--receipt-id",
      "prompt-run-queued-cli",
      "--reason",
      "user cancelled queued prompt"
    ]);
    expect(cancel).toMatchObject({
      ok: true,
      command: "debug.prompt-cancel",
      visibleState: {
        operation: "prompt.cancel",
        targetReceiptId: "prompt-run-queued-cli",
        state: "cancelled"
      },
      result: {
        targetReceiptId: "prompt-run-queued-cli",
        targetState: "pending",
        state: "cancelled",
        receipt: expect.objectContaining({
          operation: "prompt.cancel",
          status: "passed",
          output: expect.objectContaining({ reason: "user cancelled queued prompt" })
        })
      }
    });

    const retry = await runCli([
      "debug",
      "prompt-retry",
      "--tier",
      "draft_motion",
      "--receipts-root",
      receiptsRoot,
      "--receipt-id",
      "prompt-run-failed-cli",
      "--reason",
      "retry after local agent auth"
    ]);
    expect(retry).toMatchObject({
      ok: true,
      command: "debug.prompt-retry",
      visibleState: {
        operation: "prompt.retry",
        sourceReceiptId: "prompt-run-failed-cli",
        state: "pending"
      },
      result: {
        sourceReceiptId: "prompt-run-failed-cli",
        sourceState: "failed",
        state: "pending",
        retryAttempt: 1,
        receipt: expect.objectContaining({
          operation: "prompt.retry",
          status: "not_run",
          output: expect.objectContaining({ reason: "retry after local agent auth", request: "render package preview" })
        })
      }
    });

    const retryReceiptId = (retry as { receiptId?: string }).receiptId;
    const queue = await runCli(["debug", "prompt-queue", "--receipts-root", receiptsRoot]);
    expect(queue).toMatchObject({
      ok: true,
      command: "debug.prompt-queue",
      visibleState: {
        operation: "prompt.queue",
        stateCounts: { pending: 1, running: 0, succeeded: 0, failed: 1, cancelled: 1, skipped: 0 }
      },
      result: {
        jobs: expect.arrayContaining([
          expect.objectContaining({
            receiptId: "prompt-run-queued-cli",
            state: "cancelled",
            control: expect.objectContaining({ reason: "user cancelled queued prompt" })
          }),
          expect.objectContaining({
            receiptId: "prompt-run-failed-cli",
            state: "failed",
            availableActions: [{ id: "retry", command: "motion.prompt.retry", receiptId: "prompt-run-failed-cli" }]
          }),
          expect.objectContaining({
            receiptId: retryReceiptId,
            state: "pending",
            handoff: expect.objectContaining({
              schema: "shellx-motion/prompt-job-handoff@1",
              request: "render package preview",
              sourceReceiptId: "prompt-run-failed-cli",
              retryAttempt: 1
            }),
            availableActions: [{ id: "cancel", command: "motion.prompt.cancel", receiptId: retryReceiptId }]
          })
        ])
      }
    });
  });

  itLinux("routes prompt run debug commands through the CLI with linked prompt and agent receipts", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-prompt-run-"));
    tempDirs.push(receiptsRoot);

    const result = await runCli([
      "debug",
      "prompt-run",
      "--tier",
      "render_motion",
      "--request",
      "preview current package",
      "--package-id",
      "pkg_cli_prompt",
      "--agent",
      "fake",
      "--receipts-root",
      receiptsRoot
    ], { promptRuntime: createFakePromptRuntime() });

    expect(result).toMatchObject({
      ok: true,
      command: "debug.prompt-run",
      visibleState: {
        panel: "agent",
        operation: "prompt.run",
        packageId: "pkg_cli_prompt",
        status: "passed",
        receiptPath: expect.stringContaining(receiptsRoot),
        agentReceiptPath: expect.stringContaining(receiptsRoot)
      },
      result: {
        ok: true,
        packageId: "pkg_cli_prompt",
        receipt: {
          operation: "prompt.run",
          status: "passed",
          output: {
            agentId: "fake",
            debugCommands: expect.arrayContaining(["motion.preview.frame"]),
            authoringJob: expect.objectContaining({
              schema: "shellx-motion/agent-authoring-job@1",
              brief: expect.stringContaining("Motion request classified as"),
              packageId: "pkg_cli_prompt",
              status: "succeeded",
              mutationPolicy: expect.objectContaining({ mode: "proposal_only" })
            }),
            eventCount: 3,
            lastEventSeq: 3,
            mutationPolicy: expect.objectContaining({ mode: "proposal_only" })
          }
        },
        agent: {
          receipt: {
            operation: "agent.prompt",
            status: "passed"
          }
        }
      },
      warnings: []
    });
    if (!result.ok) return;
    const visibleState = result.visibleState as { receiptPath: string; agentReceiptPath: string };
    const promptReceipt = JSON.parse(await readFile(visibleState.receiptPath, "utf8"));
    const agentReceipt = JSON.parse(await readFile(visibleState.agentReceiptPath, "utf8"));
    expect(promptReceipt.output.agentReceiptId).toBe(agentReceipt.id);
    expect(promptReceipt.output).toMatchObject({
      requestSummary: expect.stringContaining("Motion request classified as"),
      promptRetention: { mode: "summary_only", rawRequestRetained: false }
    });
    expect(JSON.stringify(promptReceipt)).not.toContain("preview current package");
    expect(promptReceipt.output).not.toHaveProperty("request");
    expect(agentReceipt.output.transcript.length).toBeGreaterThan(0);
    expect(promptReceipt.output.authoringJob.assetRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-authoring", route: "codex-subscription-cli" })
    ]));
    const queue = await runCli(["debug", "prompt-queue", "--receipts-root", receiptsRoot]);
    expect(queue).toMatchObject({
      ok: true,
      command: "debug.prompt-queue",
      result: {
        jobs: expect.arrayContaining([
          expect.objectContaining({
            receiptId: promptReceipt.id,
            request: promptReceipt.output.requestSummary,
            authoringJob: expect.objectContaining({
              brief: expect.stringContaining("Motion request classified as"),
              status: "succeeded"
            }),
            eventReplay: expect.objectContaining({
              schema: "shellx-motion/job-event-replay@1",
              eventCount: 3,
              lastSeq: 3
            })
          })
        ])
      }
    });
  });

  it("routes prompt command execution through the debug CLI with package edit and preview receipts", async () => {
    const sourcePackageRoot = await writeTinyPackageWithTimeline();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-prompt-execute-"));
    const packageRoot = join(workspaceRoot, "package");
    const outDir = join(workspaceRoot, "outputs");
    await cp(sourcePackageRoot, packageRoot, { recursive: true });
    await mkdir(outDir, { mode: 0o700 });
    tempDirs.push(sourcePackageRoot, workspaceRoot);
    const receiptsRoot = join(outDir, "receipts");
    const patchedPackageRoot = join(outDir, "patched-package");
    const previewOutDir = join(outDir, "preview");
    const previewPath = join(previewOutDir, "frame.png");

    const result = await runCli([
      "debug",
      "prompt-run",
      "--tier",
      "edit_motion",
      "--request",
      "edit title and preview",
      "--package-id",
      "pkg_cli_ffmpeg_sequence",
      "--agent",
      "fake",
      "--receipts-root",
      receiptsRoot,
      "--cwd",
      workspaceRoot,
      "--execute-agent-commands"
    ], {
      promptRuntime: {
        runPrompt: async (input) => ({
          ok: true,
          structuredOutput: {
            ok: true,
            debugCommands: [
              {
                command: "motion.package.patch",
                args: {
                  packageRoot,
                  outDir: patchedPackageRoot,
                  patch: [{ op: "replace", path: "/layers/0/text", value: "CLI Prompt Edited" }],
                  createdBy: "cli-debug-prompt"
                }
              },
              {
                command: "motion.preview.frame",
                args: {
                  packageRoot: patchedPackageRoot,
                  outDir: previewOutDir,
                  outputPath: previewPath,
                  atMs: 0
                }
              }
            ]
          },
          transcript: {
            stdout: "[structured agent response]",
            stderr: "",
            redacted: true,
            truncated: false,
            maxBytes: 65_536
          },
          receipt: cliAgentReceipt({
            id: "agent-cli-prompt-execute",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            output: {
              agentId: input.agentId ?? "fake",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            }
          })
        })
      },
      browserFrameRenderer: async (pkg, options) => {
        await mkdir(options.outDir, { recursive: true });
        await writeFile(options.outputPath ?? previewPath, BLACK_PNG);
        const output = {
          path: options.outputPath ?? previewPath,
          sha256: "d".repeat(64),
          format: "png" as const,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        };
        return {
          ok: true,
          output,
          receipt: cliDebugReceipt({
            id: "preview-frame-cli-prompt-execute",
            operation: "preview.frame",
            status: "passed",
            packageId: pkg.manifest.id,
            lane: "browser",
            output,
            artifacts: [
              { role: "preview_frame", path: output.path, status: "available", mediaType: "image/png", primary: true }
            ]
          })
        };
      }
    });

    expect(result).toMatchObject({
      ok: true,
      command: "debug.prompt-run",
      result: {
        ok: true,
        execution: {
          commandCount: 2,
          receiptIds: [expect.stringMatching(/^package-patch-pkg_cli_ffmpeg_sequence-/), "preview-frame-cli-prompt-execute"]
        }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(patchedPackageRoot, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].text).toBe("CLI Prompt Edited");
    const promptReceipt = JSON.parse(await readFile(join(receiptsRoot, `${result.receiptId}.receipt.json`), "utf8"));
    const previewReceipt = JSON.parse(await readFile(join(receiptsRoot, "preview-frame-cli-prompt-execute.receipt.json"), "utf8"));
    expect(promptReceipt.output).toMatchObject({
      agentReceiptId: "agent-cli-prompt-execute",
      executedCommands: [
        { command: "motion.package.patch", ok: true, receiptId: expect.stringMatching(/^package-patch-pkg_cli_ffmpeg_sequence-/) },
        { command: "motion.preview.frame", ok: true, receiptId: "preview-frame-cli-prompt-execute" }
      ],
      linkedReceiptIds: [expect.stringMatching(/^package-patch-pkg_cli_ffmpeg_sequence-/), "preview-frame-cli-prompt-execute"],
      mutationPolicy: expect.objectContaining({ mode: "debug_commands_allowed" }),
      authoringJob: expect.objectContaining({
        status: "succeeded",
        mutationPolicy: expect.objectContaining({ mode: "debug_commands_allowed" }),
        eventLog: expect.arrayContaining([
          expect.objectContaining({ type: "commands.completed" })
        ])
      })
    });
    expect(previewReceipt).toMatchObject({
      id: "preview-frame-cli-prompt-execute",
      operation: "preview.frame",
      status: "passed"
    });
  });

  itLinux("routes package-aware state debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-state-receipts-"));
    tempDirs.push(packageRoot, receiptsRoot);
    await writeFile(
      join(receiptsRoot, "render.receipt.json"),
      `${JSON.stringify({
        schema: "shellx-motion/receipt@1",
        id: "cli-render-state",
        operation: "render.final",
        status: "passed",
        packageId: "pkg_cli_ffmpeg_sequence",
        inputHashes: { motion: "a".repeat(64) },
        createdAt: "2026-07-01T00:00:00.000Z",
        lane: "ffmpeg",
        output: { path: "/tmp/cli-final.mp4" },
        warnings: []
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await runCli([
      "debug",
      "state",
      "--package",
      packageRoot,
      "--receipts-root",
      receiptsRoot
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.state",
      visibleState: {
        panel: "timeline",
        packageOpen: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        receiptCount: 1,
        renderJobCount: 1
      },
      result: {
        packageOpen: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        receipts: { receiptCount: 1 },
        render: {
          jobCount: 1,
          jobs: [expect.objectContaining({ receiptId: "cli-render-state", outputPath: "/tmp/cli-final.mp4" })]
        }
      }
    });
  });

  it("routes package patch debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-package-patch-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "package-patch",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--created-by",
      "cli-test",
      "--patch-json",
      JSON.stringify([{ op: "replace", path: "/layers/0/text", value: "CLI Title" }])
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.package-patch",
      visibleState: {
        panel: "templateInspector",
        operation: "package.patch",
        packageId: "pkg_cli_ffmpeg_sequence",
        packageDir: outDir,
        changedPaths: ["/layers/0/text"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/0/text"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].text).toBe("CLI Title");
  });

  it("refuses layout-gap root and nested paths through the direct CLI package-patch route before package output", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-package-patch-layout-gap-"));
    tempDirs.push(packageRoot, outDir);
    for (const patch of [
      [{ op: "add", path: "/layoutGapAnimation", value: { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } }],
      [{ op: "remove", path: "/layoutGapAnimation" }],
      [{ op: "replace", path: "/layoutGapAnimation/tracks/0", value: {} }],
    ]) {
      const result = await runCli([
        "debug",
        "package-patch",
        "--tier",
        "edit_motion",
        "--package",
        packageRoot,
        "--out",
        outDir,
        "--patch-json",
        JSON.stringify(patch),
      ]);
      expect(result).toEqual({
        ok: false,
        command: "debug.package-patch",
        error: {
          code: "invalid_args",
          message: "motion.package.patch reserves /layoutGapAnimation for the typed layout gap animation lifecycle.",
        },
        warnings: [],
      });
      expect(await readdir(outDir)).toEqual([]);
    }
  });

  it("routes one typed atomic revision transaction through the CLI without a host receipt path", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-revision-transaction-"));
    tempDirs.push(packageRoot, outDir);
    const source = await loadMotionPackage(packageRoot);
    const base = {
      packageId: source.manifest.id,
      motionId: source.motion.id,
      manifestSha256: await hashPackageFile(join(packageRoot, "manifest.json")),
      motionSha256: await hashPackageFile(join(packageRoot, "motion.json"))
    };

    const result = await runCli([
      "debug",
      "revision-transaction",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--base-json",
      JSON.stringify(base),
      "--steps-json",
      JSON.stringify([{ command: "motion.timeline.layer.text.set", layerId: "title", text: "CLI Atomic Title" }])
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.revision-transaction",
      visibleState: { panel: "timeline", operation: "revision.transaction", packageDir: outDir, stepCount: 1 },
      result: { packageId: source.manifest.id, transactionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(JSON.parse(await readFile(join(outDir, "motion.json"), "utf8")).layers[0].text).toBe("CLI Atomic Title");
    expect(await readdir(join(outDir, "receipts"))).toEqual(["revision-transaction.receipt.json"]);

    const forbidden = await runCli([
      "debug", "revision-transaction", "--tier", "edit_motion", "--package", packageRoot, "--out", outDir,
      "--receipts-root", join(outDir, "forbidden")
    ]);
    expect(forbidden).toMatchObject({
      ok: false,
      error: {
        code: "invalid_args",
        message: "motion.revision.transaction does not accept --receipts-root; pass the bounded base and typed steps inline."
      }
    });
  });

  it("routes a read-only typed revision plan through the CLI with inline base and steps only", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    tempDirs.push(packageRoot);
    const source = await loadMotionPackage(packageRoot);
    const base = {
      packageId: source.manifest.id,
      motionId: source.motion.id,
      manifestSha256: await hashPackageFile(join(packageRoot, "manifest.json")),
      motionSha256: await hashPackageFile(join(packageRoot, "motion.json"))
    };
    const original = await readFile(join(packageRoot, "motion.json"), "utf8");

    const result = await runCli([
      "debug", "revision-transaction-plan", "--package", packageRoot,
      "--base-json", JSON.stringify(base),
      "--steps-json", JSON.stringify([{ command: "motion.timeline.layer.text.set", layerId: "title", text: "CLI Planned Title" }])
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.revision-transaction-plan",
      visibleState: { panel: "timeline", operation: "motion.revision.transaction.plan", packageId: source.manifest.id, stepCount: 1 },
      result: { base, validation: { ok: true, errorCount: 0 }, warnings: [], transactionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(JSON.stringify(result)).not.toMatch(/receipt|outDir|packageRoot/i);
    expect(await readFile(join(packageRoot, "motion.json"), "utf8")).toBe(original);

    const forbidden = await runCli([
      "debug", "revision-transaction-plan", "--package", packageRoot, "--out", join(packageRoot, "forbidden")
    ]);
    expect(forbidden).toMatchObject({
      ok: false,
      error: {
        code: "invalid_args",
        message: "motion.revision.transaction.plan does not accept --out; pass the bounded base and typed steps inline."
      }
    });
  });

  it("routes timeline keyframe upsert debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "transform.x",
      "--at-ms",
      "150",
      "--value",
      "24",
      "--easing",
      "ease-in-out",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.upsert",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        target: "transform.x",
        atMs: 150,
        action: "inserted",
        changedPath: "/layers/title/keyframes/transform.x/150"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/transform.x/150",
        action: "inserted"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["transform.x"]).toEqual([
      { atMs: 150, value: 24, easing: "ease-in-out" }
    ]);
  });

  it("routes effect keyframe upserts through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-effect-keyframe-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "effects.brightness",
      "--at-ms",
      "300",
      "--value",
      "0.6",
      "--easing",
      "ease-out"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.upsert",
        layerId: "title",
        target: "effects.brightness",
        atMs: 300,
        action: "inserted",
        changedPath: "/layers/title/keyframes/effects.brightness/300"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/effects.brightness/300",
        action: "inserted"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["effects.brightness"]).toEqual([
      { atMs: 300, value: 0.6, easing: "ease-out" }
    ]);
  });

  it("routes color keyframe upserts through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-color-keyframe-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "style.color",
      "--at-ms",
      "400",
      "--value",
      "#00ff00",
      "--easing",
      "ease-in-out"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.upsert",
        layerId: "title",
        target: "style.color",
        atMs: 400,
        action: "inserted",
        changedPath: "/layers/title/keyframes/style.color/400"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/style.color/400",
        action: "inserted"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["style.color"]).toEqual([
      { atMs: 400, value: "#00ff00", easing: "ease-in-out" }
    ]);
  });

  it("routes mask inset keyframe upserts through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-mask-keyframe-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "mask.inset.left",
      "--at-ms",
      "500",
      "--value",
      "36",
      "--easing",
      "ease-in-out"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.upsert",
        layerId: "title",
        target: "mask.inset.left",
        atMs: 500,
        action: "inserted",
        changedPath: "/layers/title/keyframes/mask.inset.left/500"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/mask.inset.left/500",
        action: "inserted"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["mask.inset.left"]).toEqual([
      { atMs: 500, value: 36, easing: "ease-in-out" }
    ]);
  });

  it("routes image crop keyframe upserts through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0] = {
      id: "title",
      type: "image",
      assetRef: "assets/product.png",
      source: "assets/product.png",
      trackId: "overlay",
      startMs: 0,
      durationMs: 300,
      transform: { x: 0, y: 0, width: 64, height: 36 },
      crop: { x: 0, y: 0, width: 64, height: 36 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-crop-keyframe-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "crop.x",
      "--at-ms",
      "150",
      "--value",
      "24",
      "--easing",
      "ease-in-out"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.upsert",
        layerId: "title",
        target: "crop.x",
        atMs: 150,
        action: "inserted",
        changedPath: "/layers/title/keyframes/crop.x/150"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/crop.x/150",
        action: "inserted"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["crop.x"]).toEqual([
      { atMs: 150, value: 24, easing: "ease-in-out" }
    ]);
  });

  it("routes video crop keyframe upserts through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0] = {
      id: "title",
      type: "video",
      source: "assets/clip.mp4",
      trackId: "overlay",
      startMs: 0,
      durationMs: 300,
      transform: { x: 0, y: 0, width: 64, height: 36 },
      crop: { x: 0, y: 0, width: 64, height: 36 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-video-crop-keyframe-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "crop.x",
      "--at-ms",
      "150",
      "--value",
      "24",
      "--easing",
      "ease-in-out"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.upsert",
        layerId: "title",
        target: "crop.x",
        atMs: 150,
        action: "inserted",
        changedPath: "/layers/title/keyframes/crop.x/150"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/crop.x/150",
        action: "inserted"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["crop.x"]).toEqual([
      { atMs: 150, value: 24, easing: "ease-in-out" }
    ]);
  });

  it("routes timeline marker upsert debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-marker-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "marker-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--id",
      "middle",
      "--at-ms",
      "120",
      "--duration-ms",
      "30",
      "--label",
      "Middle",
      "--type",
      "beat",
      "--color",
      "#00ffaa",
      "--scene",
      "intro",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.marker-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.marker.upsert",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        markerId: "middle",
        action: "inserted",
        changedPath: "/markers/1"
      },
      result: {
        ok: true,
        changedPath: "/markers/1",
        changedPaths: ["/markers/1", "/scenes/0/markerIds"],
        action: "inserted",
        marker: { id: "middle", atMs: 120, durationMs: 30, label: "Middle", type: "beat", color: "#00ffaa" },
        attachedSceneId: "intro"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.markers).toEqual([
      { id: "start", atMs: 0, label: "Start", type: "cue" },
      { id: "middle", atMs: 120, durationMs: 30, label: "Middle", type: "beat", color: "#00ffaa" },
      { id: "outro", atMs: 240, durationMs: 60, label: "Outro", type: "cue" }
    ]);
    expect(patchedMotion.scenes[0].markerIds).toEqual(["start", "outro", "middle"]);
  });

  itLinux("routes timeline control debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-timeline-controls-receipts-"));
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    tempDirs.push(packageRoot, receiptsRoot);

    const playhead = await runCli([
      "debug",
      "timeline-playhead-set",
      "--tier",
      "draft_motion",
      "--package",
      packageRoot,
      "--at-ms",
      "120",
      "--receipts-root",
      receiptsRoot
    ]);
    const range = await runCli([
      "debug",
      "timeline-range-select",
      "--tier",
      "draft_motion",
      "--package",
      packageRoot,
      "--start-ms",
      "40",
      "--end-ms",
      "220",
      "--receipts-root",
      receiptsRoot
    ]);
    const viewport = await runCli([
      "debug",
      "timeline-viewport-set",
      "--tier",
      "draft_motion",
      "--package",
      packageRoot,
      "--start-ms",
      "0",
      "--end-ms",
      "300",
      "--zoom",
      "1.25",
      "--pixels-per-second",
      "90",
      "--receipts-root",
      receiptsRoot
    ]);
    const state = await runCli(["debug", "state", "--package", packageRoot]);

    expect(playhead).toMatchObject({
      ok: true,
      command: "debug.timeline-playhead-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.playhead.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        playheadMs: 120,
        statePath
      },
      result: {
        ok: true,
        playheadMs: 120,
        previousPlayheadMs: 0,
        statePath
      }
    });
    expect(range).toMatchObject({
      ok: true,
      command: "debug.timeline-range-select",
      visibleState: {
        panel: "timeline",
        operation: "timeline.range.select",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        selectedRange: { startMs: 40, endMs: 220 },
        statePath
      },
      result: {
        ok: true,
        selectedRange: { startMs: 40, endMs: 220 },
        previousRange: null,
        statePath
      }
    });
    expect(viewport).toMatchObject({
      ok: true,
      command: "debug.timeline-viewport-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.viewport.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        viewport: { startMs: 0, endMs: 300, zoom: 1.25, pixelsPerSecond: 90 },
        statePath
      },
      result: {
        ok: true,
        viewport: { startMs: 0, endMs: 300, zoom: 1.25, pixelsPerSecond: 90 },
        previousViewport: null,
        statePath
      }
    });
    expect(state).toMatchObject({
      ok: true,
      command: "debug.state",
      result: {
        ok: true,
        timeline: {
          controls: {
            statePath,
            playheadMs: 120,
            selectedRange: { startMs: 40, endMs: 220 },
            viewport: { startMs: 0, endMs: 300, zoom: 1.25, pixelsPerSecond: 90 }
          }
        }
      }
    });

    const persistedState = JSON.parse(await readFile(statePath, "utf8"));
    expect(persistedState).toMatchObject({
      packageId: "pkg_cli_ffmpeg_sequence",
      motionId: "motion_cli_ffmpeg_sequence",
      playheadMs: 120,
      selectedRange: { startMs: 40, endMs: 220 },
      viewport: { startMs: 0, endMs: 300, zoom: 1.25, pixelsPerSecond: 90 }
    });
  });

  it("routes timeline duration policy debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-duration-policy-"));
    const policy = {
      minDurationMs: 300,
      maxDurationMs: 1200,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "intro", role: "intro", startMs: 0, durationMs: 80 },
        { id: "outro", role: "outro", startMs: 240, durationMs: 60 }
      ]
    };
    tempDirs.push(packageRoot, outDir);

    const initial = await runCli([
      "debug",
      "duration-policy",
      "--package",
      packageRoot
    ]);
    const set = await runCli([
      "debug",
      "duration-policy-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--policy-json",
      JSON.stringify(policy),
      "--created-by",
      "cli-test"
    ]);
    const updated = await runCli([
      "debug",
      "duration-policy",
      "--package",
      outDir
    ]);

    expect(initial).toMatchObject({
      ok: true,
      command: "debug.duration-policy",
      visibleState: {
        panel: "timeline",
        operation: "timeline.duration.policy",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        hasPolicy: false,
        protectedRegionCount: 0,
        durationMs: 300
      },
      result: {
        ok: true,
        policy: null,
        protectedRegions: []
      }
    });
    expect(set).toMatchObject({
      ok: true,
      command: "debug.duration-policy-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.duration.policy.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        hasPolicy: true,
        protectedRegionCount: 2,
        minDurationMs: 300,
        maxDurationMs: 1200,
        resizeMode: "stretch-middle",
        changedPath: "/x-shellx-duration-policy"
      },
      result: {
        ok: true,
        changedPaths: ["/x-shellx-duration-policy"],
        previousPolicy: null,
        policy: {
          schema: "shellx-motion/duration-policy@1",
          minDurationMs: 300,
          maxDurationMs: 1200,
          resizeMode: "stretch-middle",
          protectedRegions: [
            { id: "intro", role: "intro", startMs: 0, durationMs: 80 },
            { id: "outro", role: "outro", startMs: 240, durationMs: 60 }
          ]
        },
        validation: { ok: true }
      }
    });
    expect(updated).toMatchObject({
      ok: true,
      command: "debug.duration-policy",
      visibleState: {
        hasPolicy: true,
        protectedRegionCount: 2,
        resizeMode: "stretch-middle"
      },
      result: {
        ok: true,
        policy: {
          schema: "shellx-motion/duration-policy@1",
          protectedRegions: [
            { id: "intro", role: "intro", startMs: 0, durationMs: 80 },
            { id: "outro", role: "outro", startMs: 240, durationMs: 60 }
          ]
        }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    if (typeof set.result !== "object" || set.result === null) throw new Error("duration policy result must be an object");
    expect(patchedMotion["x-shellx-duration-policy"]).toEqual(Reflect.get(set.result, "policy"));
  });

  it("routes timeline marker delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-marker-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "marker-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--id",
      "outro",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.marker-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.marker.delete",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        markerId: "outro",
        action: "deleted",
        changedPath: "/markers/1"
      },
      result: {
        ok: true,
        changedPath: "/markers/1",
        changedPaths: ["/markers/1", "/scenes/0/markerIds"],
        action: "deleted",
        removed: { id: "outro", atMs: 240, durationMs: 60, label: "Outro", type: "cue" },
        remainingCount: 1,
        removedSceneRefs: ["intro"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.markers).toEqual([{ id: "start", atMs: 0, label: "Start", type: "cue" }]);
    expect(patchedMotion.scenes[0].markerIds).toEqual(["start"]);
  });

  it("routes timeline scene resize debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.durationMs = 600;
    motion.scenes = [
      { id: "intro", name: "Intro", startMs: 0, durationMs: 300, trackIds: ["overlay"], markerIds: ["start"] },
      { id: "outro", name: "Outro", startMs: 300, durationMs: 300, trackIds: ["overlay"], markerIds: ["outro"] }
    ];
    motion.markers = [
      { id: "start", atMs: 0, label: "Start", type: "cue" },
      { id: "outro", atMs: 300, durationMs: 60, label: "Outro", type: "cue" }
    ];
    motion.layers[0].durationMs = 200;
    motion.layers.push({
      id: "outro_title",
      type: "text",
      text: "B",
      trackId: "overlay",
      startMs: 300,
      durationMs: 200,
      transform: { x: 4, y: 4, scale: 1 },
      style: { color: "#ffffff", fontSize: 14 }
    });
    motion.tracks[0].layerIds = ["title", "outro_title"];
    motion["x-shellx-duration-policy"] = {
      schema: "shellx-motion/duration-policy@1",
      minDurationMs: 500,
      maxDurationMs: 900,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "intro-lock", role: "intro", startMs: 0, durationMs: 80 },
        { id: "outro-lock", role: "outro", startMs: 300, durationMs: 300 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-resize-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-resize",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "intro",
      "--duration-ms",
      "450",
      "--ripple",
      "true",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.scene-resize",
      visibleState: {
        panel: "timeline",
        operation: "timeline.scene.resize",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        sceneId: "intro",
        oldDurationMs: 300,
        newDurationMs: 450,
        deltaMs: 150,
        ripple: true,
        changedPaths: [
          "/scenes/intro/durationMs",
          "/scenes/outro/startMs",
          "/layers/outro_title/startMs",
          "/markers/outro/atMs",
          "/x-shellx-duration-policy/protectedRegions/outro-lock/startMs",
          "/durationMs"
        ]
      },
      result: {
        ok: true,
        action: "resized",
        sceneId: "intro",
        oldDurationMs: 300,
        newDurationMs: 450,
        deltaMs: 150,
        ripple: true,
        shiftedSceneIds: ["outro"],
        shiftedLayerIds: ["outro_title"],
        shiftedMarkerIds: ["outro"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(750);
    expect(patchedMotion.scenes).toEqual([
      { id: "intro", name: "Intro", startMs: 0, durationMs: 450, trackIds: ["overlay"], markerIds: ["start"] },
      { id: "outro", name: "Outro", startMs: 450, durationMs: 300, trackIds: ["overlay"], markerIds: ["outro"] }
    ]);
    expect(patchedMotion.layers[1]).toMatchObject({ id: "outro_title", startMs: 450 });
    expect(patchedMotion.markers[1]).toMatchObject({ id: "outro", atMs: 450 });
    expect(patchedMotion["x-shellx-duration-policy"].protectedRegions).toEqual([
      { id: "intro-lock", role: "intro", startMs: 0, durationMs: 80 },
      { id: "outro-lock", role: "outro", startMs: 450, durationMs: 300 }
    ]);
  });

  it("routes timeline scene create debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-create-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-create",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "outro",
      "--name",
      "Outro",
      "--start-ms",
      "300",
      "--duration-ms",
      "120",
      "--layer",
      "title",
      "--track",
      "overlay",
      "--marker",
      "outro",
      "--index",
      "1",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.scene-create",
      visibleState: {
        panel: "timeline",
        operation: "timeline.scene.create",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        sceneId: "outro",
        index: 1,
        action: "created",
        oldSceneCount: 1,
        newSceneCount: 2,
        oldDurationMs: 300,
        newDurationMs: 420,
        durationChanged: true,
        changedPaths: ["/scenes/outro", "/durationMs"]
      },
      result: {
        ok: true,
        changedPaths: ["/scenes/outro", "/durationMs"],
        action: "created",
        sceneId: "outro",
        index: 1,
        scene: { id: "outro", name: "Outro", startMs: 300, durationMs: 120, layerIds: ["title"], trackIds: ["overlay"], markerIds: ["outro"] },
        referencedLayerIds: ["title"],
        referencedTrackIds: ["overlay"],
        referencedMarkerIds: ["outro"],
        oldSceneCount: 1,
        newSceneCount: 2,
        oldDurationMs: 300,
        newDurationMs: 420,
        durationChanged: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(420);
    expect(patchedMotion.scenes).toEqual([
      { id: "intro", name: "Intro", startMs: 0, durationMs: 300, trackIds: ["overlay"], markerIds: ["start", "outro"] },
      { id: "outro", name: "Outro", startMs: 300, durationMs: 120, layerIds: ["title"], trackIds: ["overlay"], markerIds: ["outro"] }
    ]);
  });

  it("rejects invalid timeline scene create CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-create-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-create",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "outro",
      "--start-ms",
      "300"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.scene-create",
      error: {
        code: "invalid_args",
        message: "durationMs must be a positive number."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline scene delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.scenes.push({ id: "outro", name: "Outro", startMs: 300, durationMs: 120, trackIds: ["overlay"], markerIds: ["outro"] });
    sourceMotion.durationMs = 420;
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "outro",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.scene-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.scene.delete",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        sceneId: "outro",
        action: "deleted",
        index: 1,
        oldSceneCount: 2,
        newSceneCount: 1,
        changedPaths: ["/scenes/outro"]
      },
      result: {
        ok: true,
        changedPaths: ["/scenes/outro"],
        action: "deleted",
        sceneId: "outro",
        index: 1,
        removed: { id: "outro", name: "Outro", startMs: 300, durationMs: 120, trackIds: ["overlay"], markerIds: ["outro"] },
        oldSceneCount: 2,
        newSceneCount: 1
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(420);
    expect(patchedMotion.tracks).toEqual(sourceMotion.tracks);
    expect(patchedMotion.markers).toEqual(sourceMotion.markers);
    expect(patchedMotion.layers).toEqual(sourceMotion.layers);
    expect(patchedMotion.scenes).toEqual([
      { id: "intro", name: "Intro", startMs: 0, durationMs: 300, trackIds: ["overlay"], markerIds: ["start", "outro"] }
    ]);
  });

  it("rejects invalid timeline scene delete CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-delete-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.scene-delete",
      error: {
        code: "invalid_args",
        message: "motion.timeline.scene.delete requires sceneId."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline scene reorder debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.scenes.push({ id: "outro", name: "Outro", startMs: 300, durationMs: 120, trackIds: ["overlay"], markerIds: ["outro"] });
    sourceMotion.durationMs = 420;
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-reorder-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-reorder",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "outro",
      "--index",
      "0",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.scene-reorder",
      visibleState: {
        panel: "timeline",
        operation: "timeline.scene.reorder",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        sceneId: "outro",
        action: "reordered",
        oldIndex: 1,
        newIndex: 0,
        oldSceneOrder: ["intro", "outro"],
        newSceneOrder: ["outro", "intro"],
        oldDurationMs: 420,
        newDurationMs: 420,
        durationChanged: false,
        changedPaths: ["/scenes"]
      },
      result: {
        ok: true,
        changedPaths: ["/scenes"],
        action: "reordered",
        sceneId: "outro",
        oldIndex: 1,
        newIndex: 0,
        oldSceneOrder: ["intro", "outro"],
        newSceneOrder: ["outro", "intro"],
        scene: { id: "outro", name: "Outro", startMs: 300, durationMs: 120, trackIds: ["overlay"], markerIds: ["outro"] },
        oldDurationMs: 420,
        newDurationMs: 420,
        durationChanged: false
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(420);
    expect(patchedMotion.tracks).toEqual(sourceMotion.tracks);
    expect(patchedMotion.markers).toEqual(sourceMotion.markers);
    expect(patchedMotion.layers).toEqual(sourceMotion.layers);
    expect(patchedMotion.scenes.map((scene: { id: string }) => scene.id)).toEqual(["outro", "intro"]);
    expect(patchedMotion.scenes[0]).toMatchObject({ id: "outro", startMs: 300, durationMs: 120 });
    expect(patchedMotion.scenes[1]).toMatchObject({ id: "intro", startMs: 0, durationMs: 300 });
  });

  it("rejects invalid timeline scene reorder CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-reorder-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-reorder",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "intro",
      "--index",
      "-1"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.scene-reorder",
      error: {
        code: "invalid_args",
        message: "index must be a non-negative integer."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline scene name debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-name-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-name-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "intro",
      "--name",
      "Cold Open",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.scene-name-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.scene.name.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        sceneId: "intro",
        action: "renamed",
        oldName: "Intro",
        newName: "Cold Open",
        changedPaths: ["/scenes/intro/name"]
      },
      result: {
        ok: true,
        changedPaths: ["/scenes/intro/name"],
        action: "renamed",
        sceneId: "intro",
        oldName: "Intro",
        newName: "Cold Open"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.scenes.find((scene: { id: string }) => scene.id === "intro")).toMatchObject({
      id: "intro",
      name: "Cold Open"
    });
  });

  it("rejects invalid timeline scene name CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-scene-name-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "scene-name-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--scene",
      "intro"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.scene-name-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.scene.name.set requires name."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline keyframe delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      "transform.x": [{ atMs: 0, value: 4, easing: "linear" }]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "transform.x",
      "--at-ms",
      "0",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.delete",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        target: "transform.x",
        atMs: 0,
        action: "deleted",
        changedPath: "/layers/title/keyframes/transform.x/0"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/keyframes/transform.x/0",
        action: "deleted",
        removed: { atMs: 0, value: 4, easing: "linear" },
        remainingCount: 0
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(patchedMotion.layers[0], "keyframes")).toBe(false);
  });

  it("routes timeline keyframe range delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 0.8, easing: "ease-out" },
        { atMs: 300, value: 1 }
      ],
      "transform.x": [{ atMs: 150, value: 24, easing: "linear" }]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-range-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-range-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--start-ms",
      "0",
      "--end-ms",
      "150",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-range-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.range.delete",
        layerId: "title",
        target: "opacity",
        startMs: 0,
        endMs: 150,
        action: "deleted",
        deletedCount: 2,
        remainingCount: 1,
        changedPaths: [
          "/layers/title/keyframes/opacity/0",
          "/layers/title/keyframes/opacity/150"
        ]
      },
      result: {
        ok: true,
        action: "deleted",
        removedKeyframes: [
          { target: "opacity", atMs: 0, value: 0, easing: "linear" },
          { target: "opacity", atMs: 150, value: 0.8, easing: "ease-out" }
        ],
        remainingCount: 1
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes).toEqual({
      opacity: [{ atMs: 300, value: 1 }],
      "transform.x": [{ atMs: 150, value: 24, easing: "linear" }]
    });
  });

  it("routes timeline keyframe move debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      "transform.x": [
        { atMs: 0, value: 4, easing: "linear" },
        { atMs: 150, value: 24, easing: "ease-out" }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-move-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-move",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "transform.x",
      "--from-ms",
      "150",
      "--to-ms",
      "220",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-move",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.move",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        target: "transform.x",
        fromMs: 150,
        toMs: 220,
        action: "moved",
        changedPaths: [
          "/layers/title/keyframes/transform.x/150",
          "/layers/title/keyframes/transform.x/220"
        ]
      },
      result: {
        ok: true,
        changedPaths: [
          "/layers/title/keyframes/transform.x/150",
          "/layers/title/keyframes/transform.x/220"
        ],
        action: "moved",
        target: "transform.x",
        fromMs: 150,
        toMs: 220,
        keyframe: { atMs: 220, value: 24, easing: "ease-out" }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes["transform.x"]).toEqual([
      { atMs: 0, value: 4, easing: "linear" },
      { atMs: 220, value: 24, easing: "ease-out" }
    ]);
  });

  it("routes timeline keyframe easing apply debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 0.8, easing: "ease-out" },
        { atMs: 300, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-easing-apply-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-easing-apply",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--easing",
      "ease-in-out",
      "--start-ms",
      "0",
      "--end-ms",
      "150",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-easing-apply",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.easing.apply",
        layerId: "title",
        target: "opacity",
        easing: "ease-in-out",
        startMs: 0,
        endMs: 150,
        action: "updated",
        updatedCount: 2,
        changedPaths: [
          "/layers/title/keyframes/opacity/0/easing",
          "/layers/title/keyframes/opacity/150/easing"
        ]
      },
      result: {
        ok: true,
        action: "updated",
        updatedKeyframes: [
          { atMs: 0, value: 0, oldEasing: "linear", newEasing: "ease-in-out" },
          { atMs: 150, value: 0.8, oldEasing: "ease-out", newEasing: "ease-in-out" }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 0, value: 0, easing: "ease-in-out" },
      { atMs: 150, value: 0.8, easing: "ease-in-out" },
      { atMs: 300, value: 1 }
    ]);
  });

  it("routes timeline keyframe shift debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 0.8, easing: "ease-out" },
        { atMs: 300, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-shift-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-shift",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--delta-ms",
      "75",
      "--start-ms",
      "0",
      "--end-ms",
      "150",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-shift",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.shift",
        layerId: "title",
        target: "opacity",
        deltaMs: 75,
        startMs: 0,
        endMs: 150,
        action: "shifted",
        shiftedCount: 2,
        changedPaths: [
          "/layers/title/keyframes/opacity/0",
          "/layers/title/keyframes/opacity/75",
          "/layers/title/keyframes/opacity/150",
          "/layers/title/keyframes/opacity/225"
        ]
      },
      result: {
        ok: true,
        action: "shifted",
        shiftedKeyframes: [
          { target: "opacity", fromMs: 0, toMs: 75, value: 0, easing: "linear" },
          { target: "opacity", fromMs: 150, toMs: 225, value: 0.8, easing: "ease-out" }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 75, value: 0, easing: "linear" },
      { atMs: 225, value: 0.8, easing: "ease-out" },
      { atMs: 300, value: 1 }
    ]);
  });

  it("routes timeline keyframe scale debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 100, value: 0 },
        { atMs: 200, value: 0.25, easing: "linear" },
        { atMs: 400, value: 0.75, easing: "ease-out" },
        { atMs: 900, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-scale-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-scale",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--scale",
      "2",
      "--origin-ms",
      "100",
      "--start-ms",
      "200",
      "--end-ms",
      "400",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-scale",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.scale",
        layerId: "title",
        target: "opacity",
        scale: 2,
        originMs: 100,
        startMs: 200,
        endMs: 400,
        action: "scaled",
        scaledCount: 2,
        changedPaths: [
          "/layers/title/keyframes/opacity/200",
          "/layers/title/keyframes/opacity/300",
          "/layers/title/keyframes/opacity/400",
          "/layers/title/keyframes/opacity/700"
        ]
      },
      result: {
        ok: true,
        action: "scaled",
        scaledKeyframes: [
          { target: "opacity", fromMs: 200, toMs: 300, value: 0.25, easing: "linear" },
          { target: "opacity", fromMs: 400, toMs: 700, value: 0.75, easing: "ease-out" }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 100, value: 0 },
      { atMs: 300, value: 0.25, easing: "linear" },
      { atMs: 700, value: 0.75, easing: "ease-out" },
      { atMs: 900, value: 1 }
    ]);
  });

  it("routes timeline keyframe duplicate debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 0.8, easing: "ease-out" },
        { atMs: 300, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-duplicate-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-duplicate",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--delta-ms",
      "400",
      "--start-ms",
      "0",
      "--end-ms",
      "150",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-duplicate",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.duplicate",
        layerId: "title",
        target: "opacity",
        deltaMs: 400,
        startMs: 0,
        endMs: 150,
        action: "duplicated",
        duplicatedCount: 2,
        changedPaths: [
          "/layers/title/keyframes/opacity/400",
          "/layers/title/keyframes/opacity/550"
        ]
      },
      result: {
        ok: true,
        action: "duplicated",
        duplicatedKeyframes: [
          { target: "opacity", fromMs: 0, toMs: 400, value: 0, easing: "linear" },
          { target: "opacity", fromMs: 150, toMs: 550, value: 0.8, easing: "ease-out" }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 150, value: 0.8, easing: "ease-out" },
      { atMs: 300, value: 1 },
      { atMs: 400, value: 0, easing: "linear" },
      { atMs: 550, value: 0.8, easing: "ease-out" }
    ]);
  });

  it("routes timeline keyframe distribute debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 120, value: 0.5, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-distribute-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug", "keyframe-distribute", "--tier", "edit_motion", "--package", packageRoot, "--out", outDir,
      "--layer", "title", "--target", "opacity", "--start-ms", "0", "--end-ms", "500", "--created-by", "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-distribute",
      visibleState: {
        operation: "timeline.keyframe.distribute",
        layerId: "title",
        target: "opacity",
        startMs: 0,
        endMs: 500,
        spacingMs: 250,
        action: "distributed",
        distributedCount: 1
      },
      result: {
        ok: true,
        action: "distributed",
        distributedKeyframes: [
          { target: "opacity", fromMs: 120, toMs: 250, value: 0.5, easing: "ease-out" }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity.map((keyframe: { atMs: number }) => keyframe.atMs)).toEqual([0, 250, 500]);
  });

  it("routes timeline keyframe reverse debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 150, value: 0.8, easing: "ease-out" },
        { atMs: 300, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-reverse-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-reverse",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--start-ms",
      "0",
      "--end-ms",
      "300",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-reverse",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.reverse",
        layerId: "title",
        target: "opacity",
        startMs: 0,
        endMs: 300,
        action: "reversed",
        reversedCount: 2,
        changedPaths: [
          "/layers/title/keyframes/opacity/0",
          "/layers/title/keyframes/opacity/300"
        ]
      },
      result: {
        ok: true,
        action: "reversed",
        reversedKeyframes: [
          { target: "opacity", fromMs: 0, toMs: 300, value: 0, easing: "linear" },
          { target: "opacity", fromMs: 300, toMs: 0, value: 1 }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 0, value: 1 },
      { atMs: 150, value: 0.8, easing: "ease-out" },
      { atMs: 300, value: 0, easing: "linear" }
    ]);
  });

  it("routes timeline keyframe snap debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 47, value: 0, easing: "linear" },
        { atMs: 151, value: 0.8, easing: "ease-out" },
        { atMs: 253, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-keyframe-snap-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "keyframe-snap",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--target",
      "opacity",
      "--fps",
      "10",
      "--mode",
      "nearest",
      "--start-ms",
      "0",
      "--end-ms",
      "300",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.keyframe-snap",
      visibleState: {
        panel: "timeline",
        operation: "timeline.keyframe.snap",
        layerId: "title",
        target: "opacity",
        fps: 10,
        mode: "nearest",
        startMs: 0,
        endMs: 300,
        action: "snapped",
        snappedCount: 3,
        changedPaths: [
          "/layers/title/keyframes/opacity/47",
          "/layers/title/keyframes/opacity/0",
          "/layers/title/keyframes/opacity/151",
          "/layers/title/keyframes/opacity/200",
          "/layers/title/keyframes/opacity/253",
          "/layers/title/keyframes/opacity/300"
        ]
      },
      result: {
        ok: true,
        action: "snapped",
        snappedKeyframes: [
          { target: "opacity", fromMs: 47, toMs: 0, value: 0, easing: "linear" },
          { target: "opacity", fromMs: 151, toMs: 200, value: 0.8, easing: "ease-out" },
          { target: "opacity", fromMs: 253, toMs: 300, value: 1 }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 200, value: 0.8, easing: "ease-out" },
      { atMs: 300, value: 1 }
    ]);
  });

  it("routes timeline easing preset discovery through the CLI", async () => {
    const result = await runCli(["debug", "easing-presets", "--tier", "read_motion"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.easing-presets",
      visibleState: {
        panel: "timeline",
        operation: "timeline.easing.presets",
        presetCount: expect.any(Number)
      },
      result: {
        ok: true,
        defaultPreset: "linear",
        presets: expect.arrayContaining([
          expect.objectContaining({ id: "linear", easing: "linear" }),
          expect.objectContaining({ id: "back-out", easing: "back-out" }),
          expect.objectContaining({ id: "bounce-out", easing: "bounce-out" }),
          expect.objectContaining({ id: "smooth", easing: "cubic-bezier(0.16, 1, 0.3, 1)" }),
          expect.objectContaining({ id: "steps-4-end", easing: "steps(4, end)", kind: "steps" })
        ])
      }
    });
  });

  it("routes timeline animation preset discovery through the CLI", async () => {
    const result = await runCli(["debug", "animation-presets", "--tier", "read_motion"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.animation-presets",
      visibleState: {
        panel: "timeline",
        operation: "timeline.animation.presets",
        presetCount: expect.any(Number)
      },
      result: {
        ok: true,
        defaultPreset: "fade-in",
        presets: expect.arrayContaining([
          expect.objectContaining({ id: "fade-in", targets: ["opacity"] }),
          expect.objectContaining({ id: "lower-third-in", targets: ["opacity", "transform.y"] })
        ])
      }
    });
  });

  it("routes timeline animation preset applies through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-animation-preset-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "animation-preset-apply",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--preset",
      "lower-third-in",
      "--duration-ms",
      "120",
      "--distance-px",
      "16",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.animation-preset-apply",
      visibleState: {
        panel: "timeline",
        operation: "timeline.animation.preset.apply",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        preset: "lower-third-in",
        action: "applied",
        timing: { startMs: 0, endMs: 120, durationMs: 120 },
        changedPaths: [
          "/layers/title/keyframes/opacity/0",
          "/layers/title/keyframes/opacity/120",
          "/layers/title/keyframes/transform.y/0",
          "/layers/title/keyframes/transform.y/120"
        ]
      },
      result: {
        ok: true,
        action: "applied",
        preset: "lower-third-in",
        appliedKeyframes: [
          { target: "opacity", atMs: 0, value: 0, easing: "ease-out" },
          { target: "opacity", atMs: 120, value: 1 },
          { target: "transform.y", atMs: 0, value: 20, easing: "ease-out" },
          { target: "transform.y", atMs: 120, value: 4 }
        ]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
      { atMs: 0, value: 0, easing: "ease-out" },
      { atMs: 120, value: 1 }
    ]);
    expect(patchedMotion.layers[0].keyframes["transform.y"]).toEqual([
      { atMs: 0, value: 20, easing: "ease-out" },
      { atMs: 120, value: 4 }
    ]);
  });

  it("routes staggered timeline animation preset applies across layers through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].opacity = 1;
    motion.layers.push({
      id: "subtitle",
      type: "text",
      text: "B",
      trackId: "overlay",
      startMs: 0,
      durationMs: 300,
      opacity: 0.75,
      transform: { x: 4, y: 6, scale: 1 },
      style: { color: "#d8e6ff", fontSize: 10 }
    });
    motion.tracks[0].layerIds.push("subtitle");
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-animation-preset-group-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "animation-preset-apply",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layers",
      "subtitle,title",
      "--preset",
      "lower-third-in",
      "--start-ms",
      "20",
      "--duration-ms",
      "100",
      "--stagger-ms",
      "50",
      "--distance-px",
      "12"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.animation-preset-apply",
      visibleState: {
        panel: "timeline",
        operation: "timeline.animation.preset.apply",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerIds: ["subtitle", "title"],
        preset: "lower-third-in",
        staggerMs: 50,
        action: "applied",
        applications: [
          { layerId: "subtitle", timing: { startMs: 20, endMs: 120, durationMs: 100 } },
          { layerId: "title", timing: { startMs: 70, endMs: 170, durationMs: 100 } }
        ]
      },
      result: {
        ok: true,
        action: "applied",
        preset: "lower-third-in",
        staggerMs: 50,
        layerIds: ["subtitle", "title"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    const title = patchedMotion.layers.find((layer: { id: string }) => layer.id === "title");
    const subtitle = patchedMotion.layers.find((layer: { id: string }) => layer.id === "subtitle");
    expect(subtitle.keyframes.opacity).toEqual([
      { atMs: 20, value: 0, easing: "ease-out" },
      { atMs: 120, value: 0.75 }
    ]);
    expect(subtitle.keyframes["transform.y"]).toEqual([
      { atMs: 20, value: 18, easing: "ease-out" },
      { atMs: 120, value: 6 }
    ]);
    expect(title.keyframes.opacity).toEqual([
      { atMs: 70, value: 0, easing: "ease-out" },
      { atMs: 170, value: 1 }
    ]);
    expect(title.keyframes["transform.y"]).toEqual([
      { atMs: 70, value: 16, easing: "ease-out" },
      { atMs: 170, value: 4 }
    ]);
  });

  it("resolves relative debug package paths from INIT_CWD for preset applies", async () => {
    const previousInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = resolve("../..");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-animation-preset-relative-"));
    tempDirs.push(outDir);
    try {
      const result = await runCli([
        "debug",
        "animation-preset-apply",
        "--tier",
        "edit_motion",
        "--package",
        "fixtures/packages/lower-third",
        "--out",
        outDir,
        "--layer",
        "title",
        "--preset",
        "fade-in",
        "--duration-ms",
        "200"
      ]);

      expect(result).toMatchObject({
        ok: true,
        command: "debug.animation-preset-apply",
        result: {
          ok: true,
          packageId: "pkg_lower_third",
          preset: "fade-in",
          timing: { startMs: 0, endMs: 200, durationMs: 200 }
        }
      });
    } finally {
      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }
    }
  });

  it("resolves relative Debug --out paths from the source-checkout caller directory", async () => {
    const previousInitCwd = process.env.INIT_CWD;
    const callerRoot = resolve("../..");
    const expectedOutDir = await mkdtemp(join(callerRoot, ".cli-debug-caller-"));
    const outName = relative(callerRoot, expectedOutDir);
    const unexpectedPackageDirOut = resolve(outName);
    tempDirs.push(expectedOutDir, unexpectedPackageDirOut);
    process.env.INIT_CWD = callerRoot;
    try {
      const result = await runCli([
        "debug",
        "animation-preset-apply",
        "--tier",
        "edit_motion",
        "--package",
        fixtureRoot,
        "--out",
        outName,
        "--layer",
        "title",
        "--preset",
        "fade-in",
        "--duration-ms",
        "200"
      ]);

      expect(result).toMatchObject({ ok: true, command: "debug.animation-preset-apply" });
      await expect(stat(join(expectedOutDir, "motion.json"))).resolves.toBeDefined();
      await expect(stat(unexpectedPackageDirOut)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }
    }
  });

  it("routes timeline layer trim debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-trim-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-trim",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--start-ms",
      "40",
      "--duration-ms",
      "180",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-trim",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.trim",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "updated",
        changedPaths: ["/layers/title/startMs", "/layers/title/durationMs"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/startMs", "/layers/title/durationMs"],
        action: "updated",
        oldTiming: { startMs: 0, durationMs: 300 },
        newTiming: { startMs: 40, durationMs: 180 }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0]).toMatchObject({ startMs: 40, durationMs: 180 });
  });

  it("routes timeline layer create debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-create-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-create",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer-id",
      "subtitle",
      "--type",
      "text",
      "--text",
      "Subtitle",
      "--start-ms",
      "260",
      "--duration-ms",
      "100",
      "--track",
      "overlay",
      "--index",
      "1",
      "--track-index",
      "1",
      "--color",
      "#ffffff",
      "--font-size",
      "16",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-create",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.create",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "subtitle",
        action: "created",
        index: 1,
        trackId: "overlay",
        trackIndex: 1,
        changedPaths: ["/layers/subtitle", "/tracks/0/layerIds", "/durationMs"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/subtitle", "/tracks/0/layerIds", "/durationMs"],
        action: "created",
        layerId: "subtitle",
        index: 1,
        trackId: "overlay",
        trackIndex: 1,
        oldLayerCount: 1,
        newLayerCount: 2,
        insertedTrackRefs: ["overlay"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(360);
    expect(patchedMotion.layers).toEqual([
      expect.objectContaining({ id: "title", startMs: 0, durationMs: 300, trackId: "overlay" }),
      expect.objectContaining({ id: "subtitle", type: "text", text: "Subtitle", startMs: 260, durationMs: 100, trackId: "overlay", style: { color: "#ffffff", fontSize: 16 } })
    ]);
    expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "subtitle"]);
  });

  it("authors environment layers from bounded CLI JSON for local agents", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-create-environment-"));
    tempDirs.push(packageRoot, outDir);
    const snowLayer = {
      id: "snow-stage",
      type: "environment",
      startMs: 0,
      durationMs: 300,
      transform: { x: 0, y: 0, width: 640, height: 360 },
      environment: {
        schema: "shellx-motion/environment@1", kind: "snow", seed: 20260715, quality: "cinematic", mode: "scene",
        backgroundColor: "#07111F", snowColor: "#F8FCFF", shadowColor: "#8BA7C1", lightColor: "#C7E7FF",
        fall: { intensity: 0.72, speed: 0.68, wind: 0.22, turbulence: 0.48, flakeSize: 1.15, depthLayers: 4, focusFalloff: 0.62 },
        ground: { horizon: 0.63, accumulation: 0.7, drift: 0.52, contactAmount: 0.46 },
        atmosphere: { haze: 0.3, depthFade: 0.58 }
      },
      keyframes: { "environment.fall.intensity": [{ atMs: 0, value: 0.2 }, { atMs: 300, value: 0.9 }] }
    };

    const result = await runCli([
      "debug", "layer-create", "--tier", "edit_motion", "--package", packageRoot,
      "--out", outDir, "--layer-json", JSON.stringify(snowLayer), "--created-by", "cli-agent-test"
    ]);

    expect(result).toMatchObject({ ok: true, command: "debug.layer-create", result: { action: "created", layerId: "snow-stage", validation: { ok: true } } });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id?: string }) => layer.id === "snow-stage")).toMatchObject(snowLayer);
  });

  it("routes timeline layer split debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-split-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-split",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--at-ms",
      "120",
      "--new-layer-id",
      "title_tail",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-split",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.split",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        newLayerId: "title_tail",
        atMs: 120,
        action: "split",
        changedPaths: ["/layers/title/durationMs", "/layers/title_tail", "/tracks/0/layerIds"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/durationMs", "/layers/title_tail", "/tracks/0/layerIds"],
        action: "split",
        layerId: "title",
        newLayerId: "title_tail",
        atMs: 120,
        splitOffsetMs: 120
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers).toEqual([
      expect.objectContaining({ id: "title", startMs: 0, durationMs: 120, trackId: "overlay" }),
      expect.objectContaining({ id: "title_tail", startMs: 120, durationMs: 180, trackId: "overlay" })
    ]);
    expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "title_tail"]);
  });

  it("routes timeline layer delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.delete",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "deleted",
        changedPaths: ["/layers/title", "/tracks/0/layerIds"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title", "/tracks/0/layerIds"],
        action: "deleted",
        layerId: "title",
        remainingCount: 0,
        removedTrackRefs: ["overlay"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers).toEqual([]);
    expect(patchedMotion.tracks[0].layerIds).toEqual([]);
  });

  it("routes timeline layer duplicate debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-duplicate-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-duplicate",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--new-layer-id",
      "title_copy",
      "--offset-ms",
      "25",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-duplicate",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.duplicate",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        newLayerId: "title_copy",
        offsetMs: 25,
        action: "duplicated",
        changedPaths: ["/layers/title_copy", "/tracks/0/layerIds", "/durationMs"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title_copy", "/tracks/0/layerIds", "/durationMs"],
        action: "duplicated",
        layerId: "title",
        newLayerId: "title_copy",
        offsetMs: 25,
        insertedTrackRefs: ["overlay"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.durationMs).toBe(325);
    expect(patchedMotion.layers).toEqual([
      expect.objectContaining({ id: "title", startMs: 0, durationMs: 300, trackId: "overlay" }),
      expect.objectContaining({ id: "title_copy", startMs: 25, durationMs: 300, trackId: "overlay" })
    ]);
    expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "title_copy"]);
  });

  it("routes timeline layer reorder debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({ id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 300 });
    sourceMotion.tracks[0].layerIds.push("badge");
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-reorder-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-reorder",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "badge",
      "--index",
      "0",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-reorder",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.reorder",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "badge",
        action: "reordered",
        oldIndex: 1,
        newIndex: 0,
        changedPaths: ["/layers", "/tracks/0/layerIds"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers", "/tracks/0/layerIds"],
        action: "reordered",
        layerId: "badge",
        oldIndex: 1,
        newIndex: 0,
        reorderedTrackRefs: ["overlay"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.map((layer: { id: string }) => layer.id)).toEqual(["badge", "title"]);
    expect(patchedMotion.tracks[0].layerIds).toEqual(["badge", "title"]);
  });

  it("rejects invalid timeline layer reorder CLI index args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-reorder-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-reorder",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--index",
      "back"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-reorder",
      error: {
        code: "invalid_args",
        message: "index must be a non-negative integer."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer text debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-text-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-text-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--text",
      "Updated title",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-text-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.text.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "updated",
        oldText: "A",
        newText: "Updated title",
        changedPaths: ["/layers/title/text"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/text"],
        action: "updated",
        layerId: "title",
        oldText: "A",
        newText: "Updated title"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0]).toMatchObject({ id: "title", text: "Updated title" });
  });

  it("rejects invalid timeline layer text CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-text-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-text-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-text-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.text.set requires text."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer style debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-style-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-style-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--property",
      "color",
      "--value",
      "#13d3ff",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-style-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.style.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        property: "color",
        action: "updated",
        oldValue: "#ffffff",
        newValue: "#13d3ff",
        changedPaths: ["/layers/title/style/color"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/style/color"],
        action: "updated",
        layerId: "title",
        property: "color",
        oldValue: "#ffffff",
        newValue: "#13d3ff"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0]).toMatchObject({ id: "title", style: { color: "#13d3ff", fontSize: 14 } });
  });

  it("rejects invalid timeline layer style CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-style-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-style-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--property",
      "color"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-style-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.style.set requires value."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer transform debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-transform-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-transform-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--property",
      "x",
      "--value",
      "128",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-transform-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.transform.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        property: "x",
        action: "updated",
        oldValue: 4,
        newValue: 128,
        changedPaths: ["/layers/title/transform/x"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/transform/x"],
        action: "updated",
        layerId: "title",
        property: "x",
        oldValue: 4,
        newValue: 128
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0]).toMatchObject({ id: "title", transform: { x: 128, y: 4, scale: 1 } });
  });

  it("rejects invalid timeline layer transform CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-transform-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-transform-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--property",
      "x"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-transform-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.transform.set requires value."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer effect debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-effect-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-effect-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--property",
      "blur",
      "--value",
      "4",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-effect-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.effect.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        property: "blur",
        action: "updated",
        oldValue: null,
        newValue: 4,
        changedPaths: ["/layers/title/effects/blur"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/effects/blur"],
        action: "updated",
        layerId: "title",
        property: "blur",
        oldValue: null,
        newValue: 4
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0]).toMatchObject({ id: "title", effects: { blur: 4 } });
  });

  it("rejects invalid timeline layer effect CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-effect-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-effect-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--property",
      "blur"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-effect-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.effect.set requires value."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes bounded rich environment controls through the CLI", async () => {
    const packageRoot = resolve("../../fixtures/packages/environment-snow-cinematic");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-rich-"));
    tempDirs.push(outDir);

    const result = await runCli([
      "debug",
      "layer-rich-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "snowfall-stage",
      "--path",
      "environment.fall.intensity",
      "--value",
      "0.81",
      "--created-by",
      "cli-agent-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-rich-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.rich.set",
        layerId: "snowfall-stage",
        property: "environment.fall.intensity",
        oldValue: 0.72,
        newValue: 0.81
      },
      result: {
        ok: true,
        action: "updated",
        layerId: "snowfall-stage",
        property: "environment.fall.intensity",
        oldValue: 0.72,
        newValue: 0.81
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].environment.fall.intensity).toBe(0.81);
  });

  it("routes timeline layer blend debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-blend-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-blend-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--blend-mode",
      "multiply",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-blend-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.blend.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "updated",
        oldBlendMode: null,
        newBlendMode: "multiply",
        changedPaths: ["/layers/title/blendMode"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/blendMode"],
        action: "updated",
        layerId: "title",
        oldBlendMode: null,
        newBlendMode: "multiply"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0]).toMatchObject({ id: "title", blendMode: "multiply" });
  });

  it("rejects invalid timeline layer blend CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-blend-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-blend-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-blend-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.blend.set requires blendMode."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer crop debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({
      id: "product",
      type: "image",
      source: "assets/product.png",
      startMs: 0,
      durationMs: 300,
      crop: { x: 0, y: 0, width: 32, height: 18 }
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-crop-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-crop-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "product",
      "--x",
      "4",
      "--y",
      "2",
      "--width",
      "24",
      "--height",
      "12",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-crop-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.crop.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "product",
        action: "updated",
        oldCrop: { x: 0, y: 0, width: 32, height: 18 },
        newCrop: { x: 4, y: 2, width: 24, height: 12 },
        changedPaths: ["/layers/product/crop/x", "/layers/product/crop/y", "/layers/product/crop/width", "/layers/product/crop/height"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/product/crop/x", "/layers/product/crop/y", "/layers/product/crop/width", "/layers/product/crop/height"],
        action: "updated",
        layerId: "product",
        oldCrop: { x: 0, y: 0, width: 32, height: 18 },
        newCrop: { x: 4, y: 2, width: 24, height: 12 }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "product")).toMatchObject({ id: "product", crop: { x: 4, y: 2, width: 24, height: 12 } });
  });

  it("rejects invalid timeline layer crop CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-crop-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-crop-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--x",
      "0",
      "--y",
      "0",
      "--width",
      "32"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-crop-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.crop.set requires crop.height."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer mask debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-mask-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-mask-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--type",
      "rounded-rect",
      "--top",
      "4",
      "--right",
      "8",
      "--bottom",
      "4",
      "--left",
      "8",
      "--radius",
      "12",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-mask-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.mask.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "updated",
        oldMask: null,
        newMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
        changedPaths: ["/layers/title/mask/type", "/layers/title/mask/inset/top", "/layers/title/mask/inset/right", "/layers/title/mask/inset/bottom", "/layers/title/mask/inset/left", "/layers/title/mask/radius"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/mask/type", "/layers/title/mask/inset/top", "/layers/title/mask/inset/right", "/layers/title/mask/inset/bottom", "/layers/title/mask/inset/left", "/layers/title/mask/radius"],
        action: "updated",
        layerId: "title",
        oldMask: null,
        newMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({ id: "title", mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } });
  });

  it("rejects invalid timeline layer mask CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-mask-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-mask-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--top",
      "4"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-mask-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.mask.set requires mask.type."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer fit debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({
      id: "product",
      type: "image",
      source: "assets/product.png",
      startMs: 0,
      durationMs: 300,
      fit: "cover",
      style: { objectFit: "scale-down", fit: "none", borderRadius: 8 }
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-fit-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-fit-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "product",
      "--fit",
      "contain",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-fit-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.fit.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "product",
        action: "updated",
        oldFit: "cover",
        newFit: "contain",
        changedPaths: ["/layers/product/fit", "/layers/product/style/objectFit", "/layers/product/style/fit"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/product/fit", "/layers/product/style/objectFit", "/layers/product/style/fit"],
        action: "updated",
        layerId: "product",
        oldFit: "cover",
        newFit: "contain"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "product")).toEqual({
      id: "product",
      type: "image",
      source: "assets/product.png",
      startMs: 0,
      durationMs: 300,
      fit: "contain",
      style: { borderRadius: 8 }
    });
  });

  it("rejects invalid timeline layer fit CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-fit-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-fit-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-fit-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.fit.set requires fit."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer media source debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({
      id: "product",
      type: "image",
      assetRef: "assets/product-asset-ref.png",
      source: "assets/product-old.png",
      src: "assets/product-src.png",
      assetId: "asset_product_old",
      startMs: 0,
      durationMs: 300,
      fit: "cover"
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-media-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-media-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "product",
      "--source",
      "assets/product-new.png",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-media-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.media.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "product",
        action: "updated",
        oldSource: "assets/product-asset-ref.png",
        newSource: "assets/product-new.png",
        changedPaths: ["/layers/product/source", "/layers/product/assetRef", "/layers/product/src", "/layers/product/assetId"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/product/source", "/layers/product/assetRef", "/layers/product/src", "/layers/product/assetId"],
        action: "updated",
        layerId: "product",
        oldSource: "assets/product-asset-ref.png",
        newSource: "assets/product-new.png"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "product")).toEqual({
      id: "product",
      type: "image",
      source: "assets/product-new.png",
      startMs: 0,
      durationMs: 300,
      fit: "cover"
    });
  });

  it("rejects invalid timeline layer media source CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-media-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-media-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-media-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.media.set requires source."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer name debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-name-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-name-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--name",
      "Hero Title",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-name-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.name.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "renamed",
        oldName: null,
        newName: "Hero Title",
        changedPaths: ["/layers/title/name"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/name"],
        action: "renamed",
        layerId: "title",
        oldName: null,
        newName: "Hero Title"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
      id: "title",
      name: "Hero Title"
    });
  });

  it("rejects invalid timeline layer name CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-name-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-name-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-name-set",
      error: {
        code: "invalid_args",
        message: "motion.timeline.layer.name.set requires name."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer visibility debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-visibility-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-visibility-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--visible",
      "false",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-visibility-set",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.visibility.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "hidden",
        oldVisible: true,
        newVisible: false,
        changedPaths: ["/layers/title/visible"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/visible"],
        action: "hidden",
        layerId: "title",
        oldVisible: true,
        newVisible: false
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
      id: "title",
      visible: false
    });
  });

  it("rejects invalid timeline layer visibility CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-visibility-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-visibility-set",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--visible",
      "maybe"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-visibility-set",
      error: {
        code: "invalid_args",
        message: "visible must be a boolean."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline layer lock debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-lock-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-lock",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--locked",
      "true",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-lock",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.lock",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        action: "locked",
        oldLocked: false,
        newLocked: true,
        changedPaths: ["/layers/title/locked"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/locked"],
        action: "locked",
        layerId: "title",
        oldLocked: false,
        newLocked: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
      id: "title",
      locked: true
    });
  });

  it("rejects invalid timeline layer lock CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-lock-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-lock",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--locked",
      "maybe"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-lock",
      error: {
        code: "invalid_args",
        message: "locked must be a boolean."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline track create debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    delete sourceMotion.tracks;
    delete sourceMotion.layers[0].trackId;
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-create-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-create",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--type",
      "overlay",
      "--name",
      "Overlay",
      "--order",
      "1",
      "--layer",
      "title",
      "--index",
      "0",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-create",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.create",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "overlay",
        action: "created",
        index: 0,
        attachedLayerIds: ["title"],
        changedPaths: ["/tracks/overlay", "/layers/title/trackId"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/overlay", "/layers/title/trackId"],
        action: "created",
        trackId: "overlay",
        index: 0,
        oldTrackCount: 0,
        newTrackCount: 1,
        attachedLayerIds: ["title"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks).toEqual([{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }]);
    expect(patchedMotion.layers[0]).toMatchObject({ id: "title", trackId: "overlay" });
  });

  it("routes timeline track reorder debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-reorder-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-reorder",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "music",
      "--index",
      "0",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-reorder",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.reorder",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "music",
        action: "reordered",
        oldIndex: 1,
        newIndex: 0,
        oldTrackOrder: ["overlay", "music"],
        newTrackOrder: ["music", "overlay"],
        changedPaths: ["/tracks"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks"],
        action: "reordered",
        trackId: "music",
        oldIndex: 1,
        newIndex: 0,
        oldTrackOrder: ["overlay", "music"],
        newTrackOrder: ["music", "overlay"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks.map((track: { id: string }) => track.id)).toEqual(["music", "overlay"]);
  });

  it("rejects invalid timeline track reorder CLI index args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-reorder-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-reorder",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--index",
      "back"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-reorder",
      error: {
        code: "invalid_args",
        message: "index must be a non-negative integer."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline track delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--detach-layers",
      "true",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.delete",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "overlay",
        action: "deleted",
        detachedLayerIds: ["title"],
        removedSceneRefs: ["intro"],
        oldTrackCount: 1,
        newTrackCount: 0,
        changedPaths: ["/tracks/overlay", "/layers/title/trackId", "/scenes/intro/trackIds"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/overlay", "/layers/title/trackId", "/scenes/intro/trackIds"],
        action: "deleted",
        trackId: "overlay",
        detachedLayerIds: ["title"],
        removedSceneRefs: ["intro"],
        oldTrackCount: 1,
        newTrackCount: 0
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks).toBeUndefined();
    expect(patchedMotion.layers[0].trackId).toBeUndefined();
    expect(patchedMotion.scenes[0].trackIds).toBeUndefined();
  });

  it("rejects invalid timeline track delete CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-delete-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--detach-layers",
      "true"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-delete",
      error: {
        code: "invalid_args",
        message: "motion.timeline.track.delete requires trackId."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline track rename debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-rename-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-rename",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--name",
      "Main Titles",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-rename",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.rename",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "overlay",
        action: "renamed",
        oldName: "Overlay",
        newName: "Main Titles",
        changedPaths: ["/tracks/overlay/name"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/overlay/name"],
        action: "renamed",
        trackId: "overlay",
        oldName: "Overlay",
        newName: "Main Titles"
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[0]).toMatchObject({ id: "overlay", name: "Main Titles" });
  });

  it("rejects invalid timeline track rename CLI args before package copy", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-rename-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-rename",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-rename",
      error: {
        code: "invalid_args",
        message: "motion.timeline.track.rename requires name."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
  });

  it("routes timeline track lock debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-lock-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-lock",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--locked",
      "true",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-lock",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.lock",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "overlay",
        action: "locked",
        oldLocked: false,
        newLocked: true,
        changedPaths: ["/tracks/overlay/locked"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/overlay/locked"],
        action: "locked",
        trackId: "overlay",
        oldLocked: false,
        newLocked: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[0]).toMatchObject({ id: "overlay", locked: true });
  });

  it("routes timeline track unlock debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks[0].locked = true;
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-unlock-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-lock",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--locked",
      "false",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-lock",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.lock",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "overlay",
        action: "unlocked",
        oldLocked: true,
        newLocked: false,
        changedPaths: ["/tracks/overlay/locked"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/overlay/locked"],
        action: "unlocked",
        trackId: "overlay",
        oldLocked: true,
        newLocked: false
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[0]).toMatchObject({ id: "overlay", locked: false });
  });

  it("rejects invalid track lock boolean values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-lock-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-lock",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--locked",
      "treu"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-lock",
      error: {
        code: "invalid_args",
        message: "locked must be a boolean."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline track mute debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-mute-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-mute",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "music",
      "--muted",
      "true",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-mute",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.mute",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "music",
        action: "muted",
        oldMuted: false,
        newMuted: true,
        changedPaths: ["/tracks/music/muted"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/music/muted"],
        action: "muted",
        trackId: "music",
        oldMuted: false,
        newMuted: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", muted: true });
  });

  it("rejects invalid track mute boolean values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-mute-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-mute",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--muted",
      "treu"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-mute",
      error: {
        code: "invalid_args",
        message: "muted must be a boolean."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline track solo debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-solo-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-solo",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "music",
      "--solo",
      "true",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-solo",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.solo",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "music",
        action: "soloed",
        oldSolo: false,
        newSolo: true,
        changedPaths: ["/tracks/music/solo"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/music/solo"],
        action: "soloed",
        trackId: "music",
        oldSolo: false,
        newSolo: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", solo: true });
  });

  it("rejects invalid track solo boolean values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-solo-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-solo",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--solo",
      "treu"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-solo",
      error: {
        code: "invalid_args",
        message: "solo must be a boolean."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline track volume debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-volume-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-volume",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "music",
      "--volume",
      "0.65",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-volume",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.volume",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "music",
        action: "updated",
        oldVolume: 1,
        newVolume: 0.65,
        changedPaths: ["/tracks/music/volume"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/music/volume"],
        action: "updated",
        trackId: "music",
        oldVolume: 1,
        newVolume: 0.65
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", volume: 0.65 });
  });

  it("rejects invalid track volume values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-volume-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-volume",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--volume",
      "quiet"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-volume",
      error: {
        code: "invalid_args",
        message: "volume must be a non-negative finite number."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline track fade debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-fade-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-fade",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "music",
      "--fade-in-ms",
      "120",
      "--fade-out-ms",
      "240",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-fade",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.fade",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "music",
        action: "updated",
        oldFade: { fadeInMs: 0, fadeOutMs: 0 },
        newFade: { fadeInMs: 120, fadeOutMs: 240 },
        changedPaths: ["/tracks/music/fadeInMs", "/tracks/music/fadeOutMs"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/music/fadeInMs", "/tracks/music/fadeOutMs"],
        action: "updated",
        trackId: "music",
        oldFade: { fadeInMs: 0, fadeOutMs: 0 },
        newFade: { fadeInMs: 120, fadeOutMs: 240 }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", fadeInMs: 120, fadeOutMs: 240 });
  });

  it("rejects invalid track fade values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-fade-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-fade",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--fade-in-ms",
      "slow"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-fade",
      error: {
        code: "invalid_args",
        message: "fadeInMs and fadeOutMs must be non-negative finite numbers."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline track pan debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-pan-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-pan",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "music",
      "--pan",
      "-0.5",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.track-pan",
      visibleState: {
        panel: "timeline",
        operation: "timeline.track.pan",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "music",
        action: "updated",
        oldPan: 0,
        newPan: -0.5,
        changedPaths: ["/tracks/music/pan"]
      },
      result: {
        ok: true,
        changedPaths: ["/tracks/music/pan"],
        action: "updated",
        trackId: "music",
        oldPan: 0,
        newPan: -0.5
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", pan: -0.5 });
  });

  it("rejects invalid track pan values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-track-pan-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "track-pan",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--track",
      "overlay",
      "--pan",
      "wide-left"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.track-pan",
      error: {
        code: "invalid_args",
        message: "pan must be a finite number between -1 and 1."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline layer ducking debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.layers.push(
      { id: "music", type: "audio", source: "assets/music.wav", startMs: 0, durationMs: 2000 },
      { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 500, durationMs: 800 }
    );
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-ducking-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-ducking",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "music",
      "--trigger-layer",
      "voice",
      "--duck-to-volume",
      "0.25",
      "--attack-ms",
      "100",
      "--release-ms",
      "200",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-ducking",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.ducking.set",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "music",
        action: "updated",
        oldDucking: null,
        newDucking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 },
        changedPaths: ["/layers/music/ducking"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/music/ducking"],
        action: "updated",
        layerId: "music",
        oldDucking: null,
        newDucking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "music")).toMatchObject({
      ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 }
    });
  });

  it("rejects invalid layer ducking values through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.layers.push(
      { id: "music", type: "audio", source: "assets/music.wav", startMs: 0, durationMs: 2000 },
      { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 500, durationMs: 800 }
    );
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-ducking-invalid-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-ducking",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "music",
      "--trigger-layer",
      "voice",
      "--duck-to-volume",
      "loud"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "debug.layer-ducking",
      error: {
        code: "invalid_args",
        message: "duckToVolume, attackMs, and releaseMs must be non-negative finite numbers."
      }
    });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("routes timeline layer track assignment debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "captions", type: "caption", name: "Captions", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-layer-track-assign-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "layer-track-assign",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--track",
      "captions",
      "--index",
      "0",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-track-assign",
      visibleState: {
        panel: "timeline",
        operation: "timeline.layer.track.assign",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        oldTrackId: "overlay",
        newTrackId: "captions",
        oldIndex: 0,
        newIndex: 0,
        removedFromTrackIds: ["overlay"],
        action: "assigned",
        changedPaths: ["/layers/title/trackId", "/tracks/0/layerIds", "/tracks/1/layerIds"]
      },
      result: {
        ok: true,
        changedPaths: ["/layers/title/trackId", "/tracks/0/layerIds", "/tracks/1/layerIds"],
        action: "assigned",
        oldTrackId: "overlay",
        newTrackId: "captions",
        oldIndex: 0,
        newIndex: 0,
        removedFromTrackIds: ["overlay"]
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].trackId).toBe("captions");
    expect(patchedMotion.tracks).toEqual([
      { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: [] },
      { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["title"] }
    ]);
  });

  it("routes timeline caption import debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-caption-source-"));
    const captionsPath = join(sourceRoot, "captions.srt");
    await writeFile(
      captionsPath,
      ["1", "00:00:00,000 --> 00:00:01,000", "First caption", "", "2", "00:00:01,250 --> 00:00:02,500", "Second caption"].join("\n"),
      "utf8"
    );
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-caption-import-"));
    tempDirs.push(packageRoot, sourceRoot, outDir);

    const result = await runCli([
      "debug",
      "caption-import",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--captions-file",
      captionsPath,
      "--format",
      "srt",
      "--track",
      "captions",
      "--layer-prefix",
      "cap",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.caption-import",
      visibleState: {
        panel: "timeline",
        operation: "timeline.caption.import",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        trackId: "captions",
        cueCount: 2,
        insertedLayerIds: ["cap_0001", "cap_0002"],
        replacedLayerIds: []
      },
      result: {
        ok: true,
        format: "srt",
        trackId: "captions",
        cueCount: 2,
        insertedLayerIds: ["cap_0001", "cap_0002"],
        replacedLayerIds: [],
        trackCreated: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.tracks).toEqual(expect.arrayContaining([
      { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["cap_0001", "cap_0002"] }
    ]));
    expect(patchedMotion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cap_0001", type: "caption", text: "First caption", startMs: 0, durationMs: 1000 }),
      expect.objectContaining({ id: "cap_0002", type: "caption", text: "Second caption", startMs: 1250, durationMs: 1250 })
    ]));
  });

  it("routes timeline caption upsert debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-caption-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "caption-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--id",
      "caption_001",
      "--text",
      "Edited caption",
      "--start-ms",
      "120",
      "--duration-ms",
      "900",
      "--track",
      "captions",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.caption-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.caption.upsert",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "caption_001",
        trackId: "captions",
        action: "inserted"
      },
      result: {
        ok: true,
        action: "inserted",
        layer: { id: "caption_001", text: "Edited caption", trackId: "captions" },
        trackCreated: true
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "caption_001", type: "caption", text: "Edited caption", startMs: 120, durationMs: 900 })
    ]));
  });

  it("routes timeline transition upsert debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-transition-upsert-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "transition-upsert",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--edge",
      "out",
      "--type",
      "wipe",
      "--duration-ms",
      "160",
      "--easing",
      "ease-in",
      "--direction",
      "down",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.transition-upsert",
      visibleState: {
        panel: "timeline",
        operation: "timeline.transition.upsert",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        edge: "out",
        type: "wipe",
        action: "inserted",
        changedPath: "/layers/title/transitions/out"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/transitions/out",
        action: "inserted",
        transition: {
          type: "wipe",
          durationMs: 160,
          easing: "ease-in",
          direction: "down"
        }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].transitions.out).toEqual({
      type: "wipe",
      durationMs: 160,
      easing: "ease-in",
      direction: "down"
    });
  });

  it("routes timeline transition delete debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].transitions = {
      out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-transition-delete-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "transition-delete",
      "--tier",
      "edit_motion",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--layer",
      "title",
      "--edge",
      "out",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.transition-delete",
      visibleState: {
        panel: "timeline",
        operation: "timeline.transition.delete",
        packageId: "pkg_cli_ffmpeg_sequence",
        motionId: "motion_cli_ffmpeg_sequence",
        packageDir: outDir,
        layerId: "title",
        edge: "out",
        action: "deleted",
        changedPath: "/layers/title/transitions/out"
      },
      result: {
        ok: true,
        changedPath: "/layers/title/transitions/out",
        action: "deleted",
        removed: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 },
        remainingEdges: []
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].transitions).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(patchedMotion.layers[0], "transitions")).toBe(false);
  });

  itLinux("routes support bundle debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outParent = await mkdtemp(join(tmpdir(), "shellx-motion-cli-support-bundle-"));
    const outDir = join(outParent, "bundle");
    tempDirs.push(packageRoot, outParent);

    const result = await runCli([
      "debug",
      "support-bundle",
      "--tier",
      "write_local",
      "--package",
      packageRoot,
      "--out",
      outDir
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.support-bundle",
      visibleState: {
        panel: "receipts",
        operation: "support.bundle",
        packageId: "pkg_cli_ffmpeg_sequence",
        bundlePath: join(outDir, "support-bundle.json"),
        receiptPath: join(outDir, "support-bundle.receipt.json")
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        bundlePath: join(outDir, "support-bundle.json")
      }
    });
    const bundle = JSON.parse(await readFile(join(outDir, "support-bundle.json"), "utf8"));
    expect(bundle.debug.commands).toContain("motion.support.bundle");
  });

  it("writes portable package archives through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-package-archive-"));
    const archivePath = join(outDir, "timeline.shellxmotion");
    tempDirs.push(packageRoot, outDir);

    const result = await runCli(["package-archive", packageRoot, "--out", archivePath]);

    expect(result).toMatchObject({
      ok: true,
      command: "package-archive",
      packageId: "pkg_cli_ffmpeg_sequence",
      archivePath,
      receiptPath: `${archivePath}.receipt.json`,
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileCount: 2,
      entries: [
        expect.objectContaining({ path: "manifest.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ path: "motion.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      ]
    });
    const receipt = JSON.parse(await readFile(`${archivePath}.receipt.json`, "utf8"));
    expect(receipt).toMatchObject({
      operation: "package.archive",
      status: "passed",
      packageId: "pkg_cli_ffmpeg_sequence",
      output: {
        archivePath,
        archiveFormat: "tar",
        packageExtension: ".shellxmotion",
        fileCount: 2
      }
    });
  });

  it("extracts portable package archives through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-package-extract-"));
    const archivePath = join(outDir, "timeline.shellxmotion");
    const extractedRoot = join(outDir, "extracted");
    tempDirs.push(packageRoot, outDir);
    const archived = await runCli(["package-archive", packageRoot, "--out", archivePath]);

    const result = await runCli(["package-extract", archivePath, "--out", extractedRoot]);

    expect(archived.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      command: "package-extract",
      packageId: "pkg_cli_ffmpeg_sequence",
      archivePath,
      packageRoot: extractedRoot,
      receiptPath: `${extractedRoot}.package-extract.receipt.json`,
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileCount: 2,
      entries: [
        expect.objectContaining({ path: "manifest.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ path: "motion.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      ]
    });
    const manifest = JSON.parse(await readFile(join(extractedRoot, "manifest.json"), "utf8"));
    const motion = JSON.parse(await readFile(join(extractedRoot, "motion.json"), "utf8"));
    const receipt = JSON.parse(await readFile(`${extractedRoot}.package-extract.receipt.json`, "utf8"));
    expect(manifest.id).toBe("pkg_cli_ffmpeg_sequence");
    expect(motion.id).toBe("motion_cli_ffmpeg_sequence");
    expect(receipt).toMatchObject({
      operation: "package.archive.extract",
      status: "passed",
      packageId: "pkg_cli_ffmpeg_sequence",
      output: {
        archivePath,
        packageRoot: extractedRoot,
        archiveFormat: "tar",
        packageExtension: ".shellxmotion",
        fileCount: 2
      }
    });
  });

  it("writes a review HTML bundle with copied render artifacts through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-review-bundle-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const mediaPath = join(tempRoot, "rendered.mp4");
    const outDir = join(tempRoot, "review");
    tempDirs.push(packageRoot, tempRoot);
    await mkdir(receiptsRoot, { recursive: true });
    await writeFile(mediaPath, "fake render bytes", "utf8");
    await writeFile(
      join(receiptsRoot, "render.receipt.json"),
      `${JSON.stringify({
        schema: "shellx-motion/receipt@1",
        id: "render-final-cli-review",
        operation: "render.final",
        status: "passed",
        packageId: "pkg_cli_ffmpeg_sequence",
        inputHashes: { "motion.json": "abc" },
        createdAt: "2026-07-01T13:00:00.000Z",
        lane: "ffmpeg",
        output: { path: mediaPath, width: 64, height: 36, durationMs: 300, codec: "h264", container: "mp4" },
        artifacts: [
          { role: "rendered_media", path: mediaPath, status: "available", mediaType: "video/mp4", primary: true }
        ],
        warnings: []
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await runCli([
      "review-html-bundle",
      packageRoot,
      "--receipts",
      receiptsRoot,
      // render --batch writes receipts to <outDir>/receipts and the media to <outDir>, so the media
      // is a sibling of the receipt root. A receipt can name any path, and the bundle writer copies
      // only what resolves inside an approved root -- otherwise a crafted receipt could pull any
      // readable file into a bundle that then gets shared. Approving the directory is explicit.
      "--artifact-root",
      tempRoot,
      "--out",
      outDir,
      "--title",
      "Motion Review"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "review-html-bundle",
      packageId: "pkg_cli_ffmpeg_sequence",
      htmlPath: join(outDir, "review-html-bundle.html"),
      receiptPath: join(outDir, "review-html-bundle.receipt.json"),
      receiptCount: 1,
      copiedArtifactCount: 1,
      copiedArtifacts: [
        expect.objectContaining({
          role: "rendered_media",
          relativePath: expect.stringMatching(/^artifacts\/rendered_media-[a-f0-9]{12}-rendered\.mp4$/)
        })
      ]
    });
    const html = await readFile(join(outDir, "review-html-bundle.html"), "utf8");
    expect(html).toContain("Motion Review");
    expect(html).toContain("pkg_cli_ffmpeg_sequence");
    expect(html).toContain("render.final");
    expect(html).not.toContain(tempRoot);
  });

  it("routes review HTML bundle debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-review-html-bundle-"));
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "review-html-bundle",
      "--tier",
      "write_local",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--title",
      "Agent Review"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.review-html-bundle",
      visibleState: {
        panel: "receipts",
        operation: "review.html.bundle",
        packageId: "pkg_cli_ffmpeg_sequence",
        htmlPath: join(outDir, "review-html-bundle.html"),
        receiptPath: join(outDir, "review-html-bundle.receipt.json")
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        htmlPath: join(outDir, "review-html-bundle.html")
      }
    });
    const html = await readFile(join(outDir, "review-html-bundle.html"), "utf8");
    expect(html).toContain("Agent Review");
    expect(html).toContain("pkg_cli_ffmpeg_sequence");
  });

  it("routes package archive debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-package-archive-"));
    const archivePath = join(outDir, "timeline.shellxmotion");
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "debug",
      "package-archive",
      "--tier",
      "write_local",
      "--package",
      packageRoot,
      "--out",
      archivePath
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.package-archive",
      visibleState: {
        panel: "receipts",
        operation: "package.archive",
        packageId: "pkg_cli_ffmpeg_sequence",
        archivePath,
        receiptPath: `${archivePath}.receipt.json`,
        fileCount: 2
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        archivePath,
        receiptPath: `${archivePath}.receipt.json`,
        fileCount: 2
      }
    });
  });

  it("routes package extract debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-package-extract-"));
    const archivePath = join(outDir, "timeline.shellxmotion");
    const extractedRoot = join(outDir, "extracted");
    tempDirs.push(packageRoot, outDir);
    await runCli(["package-archive", packageRoot, "--out", archivePath]);

    const result = await runCli([
      "debug",
      "package-extract",
      "--tier",
      "write_local",
      "--archive",
      archivePath,
      "--out",
      extractedRoot
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.package-extract",
      visibleState: {
        panel: "receipts",
        operation: "package.archive.extract",
        packageId: "pkg_cli_ffmpeg_sequence",
        archivePath,
        packageRoot: extractedRoot,
        receiptPath: `${extractedRoot}.package-extract.receipt.json`,
        fileCount: 2
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        archivePath,
        packageRoot: extractedRoot,
        receiptPath: `${extractedRoot}.package-extract.receipt.json`,
        fileCount: 2
      }
    });
  });

  it("exports a standalone HTML snippet through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-html-snippet-"));
    const outDir = join(outRoot, "export");
    tempDirs.push(packageRoot, outRoot);

    const result = await runCli([
      "html-snippet-export",
      packageRoot,
      "--out",
      outDir,
      "--created-at",
      "2026-07-04T08:20:00.000Z"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "html-snippet-export",
      packageId: "pkg_cli_ffmpeg_sequence",
      htmlPath: join(outDir, "index.html"),
      receiptPath: join(outDir, "html-snippet-export.receipt.json"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "html_snippet", path: join(outDir, "index.html"), status: "available", primary: true }),
        expect.objectContaining({ role: "html_snippet_receipt", path: join(outDir, "html-snippet-export.receipt.json"), status: "available" })
      ])
    });
    await expect(readFile(join(outDir, "index.html"), "utf8")).resolves.toContain('data-shellx-motion-schema="shellx-motion/html-snippet@1"');
  });

  it("routes HTML snippet export debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-html-snippet-"));
    const outDir = join(outRoot, "export");
    tempDirs.push(packageRoot, outRoot);

    const result = await runCli([
      "debug",
      "html-snippet-export",
      "--tier",
      "write_local",
      "--package",
      packageRoot,
      "--out",
      outDir,
      "--created-at",
      "2026-07-04T08:21:00.000Z"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.html-snippet-export",
      visibleState: {
        panel: "receipts",
        operation: "html.snippet.export",
        packageId: "pkg_cli_ffmpeg_sequence",
        htmlPath: join(outDir, "index.html"),
        receiptPath: join(outDir, "html-snippet-export.receipt.json")
      },
      result: {
        ok: true,
        packageId: "pkg_cli_ffmpeg_sequence",
        htmlPath: join(outDir, "index.html")
      }
    });
  });

  it("imports HTML snippets through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-html-snippet-import-"));
    const htmlPath = join(tempRoot, "incoming.html");
    const packageRoot = join(tempRoot, "package");
    tempDirs.push(tempRoot);
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    const result = await runCli([
      "html-snippet-import",
      htmlPath,
      "--out",
      packageRoot,
      "--created-at",
      "2026-07-04T08:31:00.000Z"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "html-snippet-import",
      packageId: "pkg_html_cli",
      packageRoot,
      motionPath: join(packageRoot, "motion.json"),
      receiptPath: join(packageRoot, "receipts", "html-snippet-import.receipt.json"),
      layerCount: 1,
      warningCount: 0,
      stagedAssetCount: 0,
      stagedAssets: [],
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "motion_package", path: packageRoot, status: "available", primary: true }),
        expect.objectContaining({ role: "html_snippet_import_receipt", path: join(packageRoot, "receipts", "html-snippet-import.receipt.json"), status: "available" })
      ])
    });
    const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8")) as Record<string, any>;
    expect(motion.layers[0]).toMatchObject({ id: "headline", type: "text", text: "Hello from HTML" });
  });

  it("routes HTML snippet import debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-html-snippet-import-"));
    const htmlPath = join(tempRoot, "incoming.html");
    const packageRoot = join(tempRoot, "package");
    tempDirs.push(tempRoot);
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    const result = await runCli([
      "debug",
      "html-snippet-import",
      "--tier",
      "write_local",
      "--html",
      htmlPath,
      "--out",
      packageRoot,
      "--created-at",
      "2026-07-04T08:32:00.000Z"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.html-snippet-import",
      visibleState: {
        panel: "receipts",
        operation: "html.snippet.import",
        packageId: "pkg_html_cli",
        packageRoot,
        motionPath: join(packageRoot, "motion.json"),
        receiptPath: join(packageRoot, "receipts", "html-snippet-import.receipt.json"),
        layerCount: 1,
        warningCount: 0,
        stagedAssetCount: 0
      },
      result: {
        ok: true,
        packageId: "pkg_html_cli",
        packageDir: packageRoot
      }
    });
  });

  it("exports OTIO timelines through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-otio-export-"));
    const outPath = join(outDir, "timeline.otio");
    tempDirs.push(packageRoot, outDir);

    const result = await runCli([
      "otio-export",
      packageRoot,
      "--out",
      outPath,
      "--created-at",
      "2026-07-04T09:50:00.000Z"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "otio-export",
      packageId: "pkg_cli_ffmpeg_sequence",
      otioPath: outPath,
      receiptPath: `${outPath}.receipt.json`,
      trackCount: 1,
      clipCount: 1,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "otio_timeline", path: outPath, status: "available", primary: true }),
        expect.objectContaining({ role: "otio_export_receipt", path: `${outPath}.receipt.json`, status: "available" })
      ])
    });
    await expect(readFile(outPath, "utf8")).resolves.toContain('"OTIO_SCHEMA": "Timeline.1"');
  });

  it("imports OTIO timelines through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-otio-import-"));
    const otioPath = join(tempRoot, "incoming.otio");
    const packageRoot = join(tempRoot, "package");
    tempDirs.push(tempRoot);
    await writeFile(otioPath, `${JSON.stringify(tinyOtioTimelineFixture(), null, 2)}\n`, "utf8");

    const result = await runCli([
      "otio-import",
      otioPath,
      "--out",
      packageRoot,
      "--created-at",
      "2026-07-04T09:51:00.000Z"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "otio-import",
      packageId: "pkg_otio_cli_otio",
      packageRoot,
      motionPath: join(packageRoot, "motion.json"),
      receiptPath: join(packageRoot, "receipts", "otio-import.receipt.json"),
      layerCount: 1,
      warningCount: 0,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "motion_package", path: packageRoot, status: "available", primary: true }),
        expect.objectContaining({ role: "otio_import_receipt", path: join(packageRoot, "receipts", "otio-import.receipt.json"), status: "available" })
      ])
    });
    const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
    expect(motion.layers[0]).toMatchObject({ id: "clip_01", type: "video", source: "media/clip01.mp4" });
  });

  it("refuses a direct CLI OTIO import through an existing package symlink", async ({ skip }) => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-otio-import-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "shellx-motion-cli-otio-import-outside-"));
    const otioPath = join(tempRoot, "incoming.otio");
    const packageRoot = join(tempRoot, "package");
    tempDirs.push(tempRoot, outside);
    await writeFile(otioPath, `${JSON.stringify(tinyOtioTimelineFixture(), null, 2)}\n`, "utf8");
    try {
      await symlink(outside, packageRoot, "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links.");
        return;
      }
      throw error;
    }

    const result = await runCli(["otio-import", otioPath, "--out", packageRoot]);

    expect(result).toMatchObject({
      ok: false,
      command: "otio-import",
      error: { code: "otio_import_failed" }
    });
    await expect(readFile(join(outside, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes OTIO debug commands through the CLI", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-otio-"));
    const outPath = join(tempRoot, "timeline.otio");
    const importedRoot = join(tempRoot, "imported");
    tempDirs.push(packageRoot, tempRoot);

    const exported = await runCli([
      "debug",
      "otio-export",
      "--tier",
      "write_local",
      "--package",
      packageRoot,
      "--out",
      outPath,
      "--created-at",
      "2026-07-04T09:52:00.000Z"
    ]);
    const imported = await runCli([
      "debug",
      "otio-import",
      "--tier",
      "write_local",
      "--otio",
      outPath,
      "--out",
      importedRoot,
      "--created-at",
      "2026-07-04T09:53:00.000Z"
    ]);

    expect(exported).toMatchObject({
      ok: true,
      command: "debug.otio-export",
      visibleState: {
        panel: "receipts",
        operation: "otio.export",
        packageId: "pkg_cli_ffmpeg_sequence",
        otioPath: outPath,
        receiptPath: `${outPath}.receipt.json`,
        trackCount: 1,
        clipCount: 1
      }
    });
    expect(imported).toMatchObject({
      ok: true,
      command: "debug.otio-import",
      visibleState: {
        panel: "receipts",
        operation: "otio.import",
        packageId: "pkg_otio_cli_ffmpeg_sequence",
        packageRoot: importedRoot,
        motionPath: join(importedRoot, "motion.json"),
        receiptPath: join(importedRoot, "receipts", "otio-import.receipt.json"),
        layerCount: 1
      }
    });
  });

  it("lists and applies template controls through the CLI", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-"));
    tempDirs.push(outDir);
    await expect(stat(resolve("../../fixtures/packages/editable-lower-third/receipts"))).rejects.toMatchObject({ code: "ENOENT" });

    const catalog = await runCli([
      "debug",
      "template-catalog",
      "--template-root",
      resolve("../../fixtures/packages"),
      "--host",
      "shellx-cut",
      "--lane",
      "browser",
      "--aspect-ratio",
      "16:9",
      "--duration-ms",
      "2400"
    ]);
    const templatePlan = await runCli([
      "debug",
      "template-plan",
      "--template-root",
      resolve("../../fixtures/packages"),
      "--request",
      "Create a lower third for Cut Generate",
      "--host",
      "shellx-cut",
      "--lane",
      "browser",
      "--aspect-ratio",
      "16:9",
      "--duration-ms",
      "2400"
    ]);
    const providedTemplatePlan = await runCli([
      "debug",
      "template-plan",
      "--template-root",
      resolve("../../fixtures/packages"),
      "--request",
      "Create a lower third for Cut Generate",
      "--host",
      "shellx-cut",
      "--lane",
      "browser",
      "--set",
      "title=Dr. Mira Chen",
      "--set",
      "subtitle=Launch Demo"
    ]);
    const panel = await runCli(["debug", "template-panel", "--package", resolve("../../fixtures/packages/editable-lower-third")]);
    const controls = await runCli(["template", "controls", resolve("../../fixtures/packages/editable-lower-third")]);
    const applied = await runCli([
      "template",
      "apply",
      resolve("../../fixtures/packages/editable-lower-third"),
      "--out",
      outDir,
      "--set",
      "title=Dr. Mira Chen",
      "--set",
      "accentColor=#ff006e",
      "--set",
      "titleScale=1.2"
    ]);
    const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "template-apply.receipt.json"), "utf8")) as Record<string, any>;

    expect(catalog).toMatchObject({
      ok: true,
      command: "debug.template-catalog",
      visibleState: {
        panel: "templates",
        operation: "template.catalog",
        templateCount: 2,
        packageCount: 2,
        controlCount: 6,
        compatibleTemplateCount: 2,
        targetHost: "shellx-cut",
        targetLane: "browser"
      },
      result: {
        ok: true,
        target: {
          host: "shellx-cut",
          lane: "browser",
          aspectRatio: "16:9",
          durationMs: 2400
        },
        compatibleTemplateCount: 2,
        recommendedTemplate: expect.objectContaining({
          templateId: "template_editable_lower_third",
          targetFit: expect.objectContaining({
            ok: true,
            score: 100,
            matched: ["host", "lane", "aspectRatio", "duration"],
            unmatched: []
          })
        }),
        templates: expect.arrayContaining([
          expect.objectContaining({
            packageId: "pkg_editable_lower_third",
            templateId: "template_editable_lower_third",
            metadata: expect.objectContaining({
              license: expect.objectContaining({ id: "shellx-sample", attribution: "ShellX Motion fixture" }),
              outputBounds: expect.objectContaining({ aspectRatios: ["16:9"] }),
              suitability: expect.objectContaining({
                bestFor: ["speaker IDs", "product demos", "Cut Generate intros"],
                notFor: ["full-screen scene replacements", "long-form end cards"]
              }),
              performance: expect.objectContaining({ recommendedLane: "browser", renderCost: "medium" })
            }),
            controlTypes: { text: 2, color: 1, number: 1 },
            targetFit: {
              ok: true,
              score: 100,
              matched: ["host", "lane", "aspectRatio", "duration"],
              unmatched: [],
              reasons: [
                "host shellx-cut supported",
                "lane browser supported",
                "aspect ratio 16:9 supported",
                "duration 2400ms within bounds"
              ]
            }
          })
        ])
      }
    });
    expect(templatePlan).toMatchObject({
      ok: true,
      command: "debug.template-plan",
      visibleState: {
        panel: "templates",
        operation: "template.plan",
        templateCount: 2,
        compatibleTemplateCount: 2,
        selectedTemplateId: "template_editable_lower_third",
        missingRequiredParamCount: 0,
        inputReadinessStatus: "ready-with-defaults",
        reviewRequired: true,
        targetHost: "shellx-cut",
        targetLane: "browser"
      },
      result: {
        ok: true,
        request: "Create a lower third for Cut Generate",
        selectedTemplate: expect.objectContaining({
          templateId: "template_editable_lower_third",
          targetFit: expect.objectContaining({ ok: true, score: 100 })
        }),
        values: {
          title: "Anna Valdez",
          subtitle: "Product Lead",
          accentColor: "#13d3ff",
          titleScale: 1
        },
        missingRequiredParams: [],
        inputReadiness: {
          status: "ready-with-defaults",
          reviewRequired: true,
          counts: {
            totalParams: 4,
            requiredParams: 2,
            provided: 0,
            defaulted: 4,
            missingRequired: 0,
            optionalMissing: 0
          }
        },
        suggestedActions: expect.arrayContaining([
          expect.objectContaining({ id: "reviewControls", command: "motion.template.controls" }),
          expect.objectContaining({ id: "apply", command: "motion.template.apply" }),
          expect.objectContaining({ id: "sendToCut", command: "motion.connector.template_to_cut" })
        ])
      }
    });
    expect(providedTemplatePlan).toMatchObject({
      ok: true,
      command: "debug.template-plan",
      visibleState: {
        panel: "templates",
        operation: "template.plan",
        selectedTemplateId: "template_editable_lower_third",
        missingRequiredParamCount: 0,
        inputReadinessStatus: "ready",
        reviewRequired: false
      },
      result: {
        ok: true,
        values: {
          title: "Dr. Mira Chen",
          subtitle: "Launch Demo",
          accentColor: "#13d3ff",
          titleScale: 1
        },
        providedValues: {
          title: "Dr. Mira Chen",
          subtitle: "Launch Demo"
        },
        defaultedValues: {
          accentColor: "#13d3ff",
          titleScale: 1
        },
        inputReadiness: {
          status: "ready",
          reviewRequired: false,
          counts: {
            totalParams: 4,
            requiredParams: 2,
            provided: 2,
            defaulted: 2,
            missingRequired: 0,
            optionalMissing: 0
          }
        }
      }
    });
    expect(panel).toMatchObject({
      ok: true,
      command: "debug.template-panel",
      visibleState: {
        panel: "templateInspector",
        operation: "template.panel",
        packageId: "pkg_editable_lower_third",
        templateId: "template_editable_lower_third",
        groupCount: 2,
        paramCount: 4,
        controlCount: 4,
        bindingCount: 4
      },
      result: {
        ok: true,
        metadata: expect.objectContaining({
          inputSchema: expect.objectContaining({ required: ["title", "subtitle"] }),
          suitability: expect.objectContaining({ bestFor: expect.arrayContaining(["Cut Generate intros"]) }),
          provenance: expect.objectContaining({ source: "shellx-motion-fixture" })
        }),
        controlTypes: { text: 2, color: 1, number: 1 },
        validation: expect.objectContaining({
          status: "ready",
          requiredParams: ["title", "subtitle"],
          missingRequiredParams: []
        }),
        controls: expect.arrayContaining([
          expect.objectContaining({ paramId: "title", currentValue: "Anna Valdez", bindingPaths: ["/layers/0/text"] }),
          expect.objectContaining({ paramId: "accentColor", currentValue: "#13d3ff", bindingPaths: ["/layers/2/fill"] })
        ])
      }
    });
    expect(controls).toMatchObject({
      ok: true,
      command: "template.controls",
      packageId: "pkg_editable_lower_third",
      templateId: "template_editable_lower_third",
      metadata: expect.objectContaining({
        license: expect.objectContaining({ id: "shellx-sample" }),
        outputBounds: expect.objectContaining({ minWidth: 720, maxWidth: 3840 }),
        suitability: expect.objectContaining({ notFor: expect.arrayContaining(["long-form end cards"]) })
      }),
      params: expect.arrayContaining([
        expect.objectContaining({ id: "title", type: "text" }),
        expect.objectContaining({ id: "accentColor", type: "color" })
      ])
    });
    expect(applied).toMatchObject({
      ok: true,
      command: "template.apply",
      packageDir: outDir,
      changedParams: ["title", "accentColor", "titleScale"],
      receiptPath: join(outDir, "receipts", "template-apply.receipt.json"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "motion_package", path: outDir, status: "available", primary: true }),
        expect.objectContaining({ role: "template_apply_receipt", path: join(outDir, "receipts", "template-apply.receipt.json"), status: "available" })
      ])
    });
    expect(motion.layers[0]).toMatchObject({ text: "Dr. Mira Chen", transform: { scale: 1.2 } });
    expect(motion.layers[2]).toMatchObject({ fill: "#ff006e" });
    expect(receipt).toMatchObject({
      operation: "template.apply",
      status: "passed",
      packageId: "pkg_editable_lower_third",
      output: {
        changedParams: ["title", "accentColor", "titleScale"],
        changedBindings: expect.arrayContaining([
          expect.objectContaining({ paramId: "title", path: "/layers/0/text" })
        ])
      }
    });
  });

  it("exposes template catalog filters and editor-ready panel payloads", async () => {
    const productPackRoot = resolve("../../templates/shellx-product-pack");
    const metricPackageRoot = resolve("../../templates/shellx-product-pack/product-metric-card");

    const catalog = await runCli([
      "debug",
      "template-catalog",
      "--template-root",
      productPackRoot,
      "--host",
      "shellx-motion",
      "--lane",
      "browser",
      "--aspect-ratio",
      "1:1",
      "--commercial-use",
      "--render-cost",
      "medium",
      "--design-family",
      "data-report",
      "--requires-media",
      "false",
      "--requires-audio",
      "false"
    ]);
    const panel = await runCli(["debug", "template-panel", "--package", metricPackageRoot]);

    expect(catalog).toMatchObject({
      ok: true,
      command: "debug.template-catalog",
      visibleState: {
        panel: "templates",
        operation: "template.catalog",
        filterCount: 7,
        filteredTemplateCount: expect.any(Number),
        targetHost: "shellx-motion",
        targetLane: "browser"
      },
      result: {
        ok: true,
        filters: {
          host: "shellx-motion",
          aspectRatio: "1:1",
          commercialUse: true,
          renderCost: "medium",
          designFamily: "data-report",
          requiresMedia: false,
          requiresAudio: false
        },
        templates: expect.arrayContaining([
          expect.objectContaining({
            packageId: "pkg_shellx_product_metric_card",
            templateId: "template_shellx_product_metric_card",
            preview: { poster: "preview/poster.png", thumbnail: "preview/poster.png" },
            outputTypes: expect.arrayContaining(["video/mp4"]),
            requirements: expect.objectContaining({
              media: false,
              audio: false,
              generatedAssets: false
            }),
            designFamilies: expect.arrayContaining(["data-report"]),
            filterFit: expect.objectContaining({
              ok: true,
              unmatched: [],
              matched: expect.arrayContaining(["host", "aspectRatio", "commercialUse", "renderCost", "designFamily", "requiresMedia", "requiresAudio"])
            })
          })
        ])
      }
    });
    expect(panel).toMatchObject({
      ok: true,
      command: "debug.template-panel",
      visibleState: {
        panel: "templateInspector",
        operation: "template.panel",
        packageId: "pkg_shellx_product_metric_card",
        mediaParamCount: 0
      },
      result: {
        ok: true,
        preview: { poster: "preview/poster.png", thumbnail: "preview/poster.png" },
        recommendedLane: "browser",
        mediaSlots: [],
        // : product-metric-card ships a literal motion.json, so every bound layer now
        // holds a real value instead of a `{{token}}`. `readTemplatePanelInputReadiness` only
        // reports "ready-with-defaults" when a bound current value is missing or is a template
        // token (see isTemplateTokenValue), so an instantiated template correctly reads "ready".
        validation: {
          status: "ready",
          requiredParams: ["title", "subtitle", "metricLabel", "metricValue", "metricDelta"],
          messages: expect.arrayContaining([
            expect.objectContaining({ paramId: "title", severity: "info", message: "required value is available from current binding" })
          ])
        },
        hostCompatibilityNotes: expect.arrayContaining([
          { host: "shellx-motion", status: "compatible", message: "Template declares shellx-motion compatibility." },
          { host: "shellx-cut", status: "not_advertised", message: "Template does not advertise shellx-cut compatibility yet." },
          { host: "shellx-canvas", status: "not_advertised", message: "Template does not advertise shellx-canvas compatibility yet." }
        ])
      }
    });
  });

  it("replaces template media slots through the CLI", async () => {
    const packageRoot = await writeTemplateMediaPackage();
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-media-source-"));
    const sourceAssetPath = join(sourceRoot, "headshot.png");
    await writeFile(sourceAssetPath, "replacement image", "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-media-"));
    tempDirs.push(packageRoot, sourceRoot, outDir);
    await expect(stat(join(packageRoot, "receipts"))).rejects.toMatchObject({ code: "ENOENT" });

    const result = await runCli([
      "template",
      "media-replace",
      packageRoot,
      "--out",
      outDir,
      "--param",
      "headshot",
      "--asset",
      sourceAssetPath,
      "--asset-ref",
      "assets/headshot.png"
    ]);

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8")) as Record<string, any>;
    const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "template-media-replace.receipt.json"), "utf8")) as Record<string, any>;

    expect(await readFile(join(outDir, "assets", "headshot.png"), "utf8")).toBe("replacement image");
    expect(result).toMatchObject({
      ok: true,
      command: "template.media-replace",
      packageDir: outDir,
      paramId: "headshot",
      assetRef: "assets/headshot.png",
      copiedAssetPath: join(outDir, "assets", "headshot.png"),
      changedParams: ["headshot"],
      manifestAssets: ["assets/default-headshot.png", "assets/headshot.png"],
      receiptPath: join(outDir, "receipts", "template-media-replace.receipt.json"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "motion_package", path: outDir, status: "available", primary: true }),
        expect.objectContaining({ role: "template_media_asset", path: join(outDir, "assets", "headshot.png"), status: "available", mediaType: "image/png" }),
        expect.objectContaining({ role: "template_media_replace_receipt", path: join(outDir, "receipts", "template-media-replace.receipt.json"), status: "available" })
      ])
    });
    expect(manifest.assets).toEqual(["assets/default-headshot.png", "assets/headshot.png"]);
    expect(motion.layers[0]).toMatchObject({ source: "assets/headshot.png", assetRef: "assets/headshot.png" });
    expect(receipt).toMatchObject({
      operation: "template.media.replace",
      status: "passed",
      packageId: "pkg_cli_template_media",
      output: {
        paramId: "headshot",
        assetRef: "assets/headshot.png",
        manifestAssets: ["assets/default-headshot.png", "assets/headshot.png"]
      }
    });
  });

  it("refuses template edits whose source package contains a symbolic link", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("The standard Windows test account cannot create package symbolic links.");
      return;
    }
    const fixtureRoot = await writeTemplateMediaPackage();
    const testRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-linked-"));
    const packageRoot = join(testRoot, "package");
    const outsideRoot = join(testRoot, "outside");
    const outsidePath = join(outsideRoot, "keep.txt");
    const outDir = join(testRoot, "output");
    tempDirs.push(fixtureRoot, testRoot);
    await cp(fixtureRoot, packageRoot, { recursive: true });
    await Promise.all([mkdirRaw(outsideRoot, { recursive: true }), mkdirRaw(outDir, { recursive: true })]);
    await writeFile(outsidePath, "outside bytes", "utf8");
    await symlink(outsidePath, join(packageRoot, "linked-sidecar.txt"), "file");

    await expect(withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(testRoot), async () => await runCli([
      "template", "apply", packageRoot, "--out", outDir, "--set", "title=Blocked",
    ]))).rejects.toThrow(/symbolic link/);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside bytes");
    await expect(readdir(outDir)).resolves.toEqual([]);
  });

  // Output-directory ownership regression coverage. The three directory-producing commands
  // (`render --preset png-sequence`, `template apply`, `template media-replace`) opened with
  // `rm(outDir, { recursive: true, force: true })`, so a caller-supplied `--out` that pointed at an
  // existing directory was destroyed silently while the command still reported ok:true. Each refusal
  // test below asserts BOTH halves of the fixed contract: the command fails with the typed error,
  // and the pre-existing files are still on disk and untouched.
  async function writeDecoyOutputDir(prefix: string): Promise<string> {
    const outDir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(outDir);
    await writeFile(join(outDir, "master.psd"), "irreplaceable source art", "utf8");
    await mkdir(join(outDir, "nested"), { recursive: true });
    await writeFile(join(outDir, "nested", "deep.txt"), "nested user data", "utf8");
    return outDir;
  }

  // Survival check: original bytes intact AND nothing added, which also proves the refusal path
  // performed no `mkdir` side effect.
  async function expectDecoyOutputDirIntact(outDir: string): Promise<void> {
    expect(await readFile(join(outDir, "master.psd"), "utf8")).toBe("irreplaceable source art");
    expect(await readFile(join(outDir, "nested", "deep.txt"), "utf8")).toBe("nested user data");
    expect((await readdir(outDir)).sort()).toEqual(["master.psd", "nested"]);
  }

  it("refuses a PNG sequence render into a non-empty --out directory and leaves its contents intact", async () => {
    const outDir = await writeDecoyOutputDir("shellx-motion-cli-render-outdir-guard-");
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(packageRoot);

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-sequence",
      "--frame-lane",
      "native",
      "--out",
      outDir
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "image-sequence",
      frameLane: "native",
      preset: "png-sequence",
      outputPath: outDir,
      error: {
        code: "output_dir_not_empty",
        path: outDir,
        message: expect.stringContaining(outDir)
      }
    });
    await expectDecoyOutputDirIntact(outDir);
  });

  it("refuses a PNG sequence render when --out is an existing file", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-outfile-guard-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);
    const outputPath = join(outRoot, "frames");
    await writeFile(outputPath, "not a directory", "utf8");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-sequence",
      "--frame-lane",
      "native",
      "--out",
      outputPath
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "image-sequence",
      preset: "png-sequence",
      error: { code: "output_path_not_a_directory", path: outputPath }
    });
    expect(await readFile(outputPath, "utf8")).toBe("not a directory");
  });

  it("replaces a non-empty --out directory for a PNG sequence render when --force is passed", async () => {
    const outDir = await writeDecoyOutputDir("shellx-motion-cli-render-outdir-force-");
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(packageRoot);

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-sequence",
      "--frame-lane",
      "native",
      "--out",
      outDir,
      "--force"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "image-sequence",
      frameLane: "native",
      preset: "png-sequence",
      outputPath: outDir,
      frames: { dir: outDir, count: 3 }
    });
    const entries = await readdir(outDir);
    expect(entries).toContain("000001.png");
    expect(entries).not.toContain("master.psd");
    expect(entries).not.toContain("nested");
  });

  it("renders a PNG sequence into an existing empty --out directory and into one that does not exist yet", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-outdir-empty-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);
    const emptyDir = join(outRoot, "empty");
    await mkdir(emptyDir, { recursive: true, mode: 0o700 });
    const missingDir = join(outRoot, "missing", "frames");
    const renderArgs = (out: string) => [
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--frame-lane", "native", "--out", out
    ];

    const intoEmpty = await runCli(renderArgs(emptyDir));
    const intoMissing = await runCli(renderArgs(missingDir));

    expect(intoEmpty).toMatchObject({ ok: true, command: "render", lane: "image-sequence", frames: { dir: emptyDir, count: 3 } });
    expect(intoMissing).toMatchObject({ ok: true, command: "render", lane: "image-sequence", frames: { dir: missingDir, count: 3 } });
    expect(await readdir(emptyDir)).toContain("000001.png");
    expect(await readdir(missingDir)).toContain("000001.png");
  });

  it("refuses a template apply into a non-empty --out directory and leaves its contents intact", async () => {
    const outDir = await writeDecoyOutputDir("shellx-motion-cli-template-apply-guard-");

    const result = await runCli([
      "template",
      "apply",
      resolve("../../fixtures/packages/editable-lower-third"),
      "--out",
      outDir,
      "--set",
      "title=Dr. Mira Chen"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "template.apply",
      packageDir: outDir,
      error: {
        code: "output_dir_not_empty",
        path: outDir,
        message: expect.stringContaining("Nothing was written or deleted.")
      }
    });
    await expectDecoyOutputDirIntact(outDir);
  });

  it("replaces a non-empty --out directory for a template apply when --force is passed", async () => {
    const outDir = await writeDecoyOutputDir("shellx-motion-cli-template-apply-force-");

    const result = await runCli([
      "template",
      "apply",
      resolve("../../fixtures/packages/editable-lower-third"),
      "--out",
      outDir,
      "--set",
      "title=Dr. Mira Chen",
      "--force"
    ]);

    const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8")) as Record<string, any>;
    expect(result).toMatchObject({
      ok: true,
      command: "template.apply",
      packageDir: outDir,
      changedParams: ["title"],
      receiptPath: join(outDir, "receipts", "template-apply.receipt.json")
    });
    expect(motion.layers[0]).toMatchObject({ text: "Dr. Mira Chen" });
    expect(await readdir(outDir)).not.toContain("master.psd");
  });

  it("refuses a template media-replace into a non-empty --out directory and leaves its contents intact", async () => {
    const packageRoot = await writeTemplateMediaPackage();
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-media-guard-source-"));
    const sourceAssetPath = join(sourceRoot, "headshot.png");
    await writeFile(sourceAssetPath, "replacement image", "utf8");
    const outDir = await writeDecoyOutputDir("shellx-motion-cli-template-media-guard-");
    tempDirs.push(packageRoot, sourceRoot);

    const result = await runCli([
      "template",
      "media-replace",
      packageRoot,
      "--out",
      outDir,
      "--param",
      "headshot",
      "--asset",
      sourceAssetPath,
      "--asset-ref",
      "assets/headshot.png"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "template.media-replace",
      packageDir: outDir,
      error: { code: "output_dir_not_empty", path: outDir }
    });
    await expectDecoyOutputDirIntact(outDir);
  });

  it("reports deterministic fake agent health without real CLI dependencies", async () => {
    const result = await runCli(["agent", "health"], { agentRuntime: scriptedAgentRuntime() });

    expect(result).toMatchObject({
      ok: true,
      command: "agent.health",
      agents: [{
        agentId: "fake",
        available: true,
        transport: "local-cli",
        billing: "cli-subscription",
        status: "ready",
        version: "shellx-motion-fake-agent 0.0.0",
        probe: { executable: "shellx-motion-fake-agent", args: ["--version"], shell: false },
        setup: {
          checkCommand: "shellx-motion-fake-agent --version",
          installHint: "Install Fake Agent CLI and ensure shellx-motion-fake-agent is on PATH.",
          authHint: "Authenticate Fake Agent CLI with its local login command before running Motion prompts.",
          quotaHint: "Check Fake Agent CLI subscription quota or retry after the provider limit resets."
        }
      }]
    });
  });

  it("routes agent health debug commands through the CLI", async () => {
    const result = await runCli(["debug", "agent-health"], { agentRuntime: scriptedAgentRuntime() });

    expect(result).toMatchObject({
      ok: true,
      command: "debug.agent-health",
      visibleState: {
        panel: "agent",
        operation: "agent.health",
        agentCount: 1,
        availableCount: 1
      },
      result: {
        ok: true,
        agents: [{
          agentId: "fake",
          available: true,
          transport: "local-cli",
          billing: "cli-subscription",
          status: "ready",
          setup: expect.objectContaining({ checkCommand: "shellx-motion-fake-agent --version" }),
          probe: { executable: "shellx-motion-fake-agent", args: ["--version"], shell: false }
        }]
      }
    });
  });

  it("routes agent readiness panel debug commands through the CLI", async () => {
    const result = await runCli(["debug", "agent-panel"]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.agent-panel",
      visibleState: {
        panel: "agent",
        operation: "agent.panel",
        adapterCount: 4,
        localCliCount: 4,
        cliSubscriptionCount: 4,
        defaultAgentId: "codex",
        promptFollowUpCount: 3
      },
      result: {
        ok: true,
        selectionPolicy: {
          defaultAgentId: "codex",
          selectedUnavailableFallback: "none",
          defaultMode: "auto-local-cli"
        },
        adapters: [
          expect.objectContaining({
            agentId: "codex",
            default: true,
            setup: expect.objectContaining({
              checkCommand: "codex --version",
              installHint: "Install Codex CLI and ensure codex is on PATH."
            })
          }),
          expect.objectContaining({ agentId: "claude-code" }),
          expect.objectContaining({ agentId: "grok" }),
          expect.objectContaining({
            agentId: "antigravity",
            setup: expect.objectContaining({ checkCommand: "agy --version" })
          })
        ],
        suggestedActions: [
          { id: "health", command: "motion.agent.health", args: {} },
          { id: "run", command: "motion.prompt.run", args: { request: "" } },
          { id: "transcript", command: "motion.agent.transcript", args: { receiptsRoot: "" } }
        ]
      }
    });
  });

  itLinux("routes agent revision plan debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-agent-revision-"));
    tempDirs.push(tempRoot);
    const receiptsRoot = join(tempRoot, "receipts");
    const contactSheetPath = join(tempRoot, "contact-sheet.json");
    const planPath = join(tempRoot, "revision-plan.json");
    await mkdir(receiptsRoot, { recursive: true });
    const qualityReceipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: "quality-cli-blank",
      operation: "quality.check",
      status: "failed",
      packageId: "pkg_cli_revision",
      inputHashes: { media: "a".repeat(64) },
      createdAt: "2026-07-06T12:14:00.000Z",
      lane: "quality",
      output: {
        quality: { blankFrames: 2, minEdgePixels: 0 },
        checks: [{ id: "mid", status: "failed", message: "Frame is blank." }]
      },
      warnings: ["Extracted frame is blank or visually empty."]
    };
    await writeFile(join(receiptsRoot, "quality-cli-blank.receipt.json"), `${JSON.stringify(qualityReceipt, null, 2)}\n`, "utf8");
    await writeFile(contactSheetPath, `${JSON.stringify({
      path: "/tmp/contact-sheet.png",
      status: "needs_revision",
      notes: ["Headline needs stronger contrast."]
    }, null, 2)}\n`, "utf8");

    const result = await runCli([
      "debug",
      "agent-revision-plan",
      "--tier",
      "write_local",
      "--trusted-local-tier",
      "--package-id",
      "pkg_cli_revision",
      "--template-id",
      "template_launch",
      "--source-job-id",
      "prompt-cli-001",
      "--plan-id",
      "revision-cli-001",
      "--created-at",
      "2026-07-06T12:16:00.000Z",
      "--receipts-root",
      receiptsRoot,
      "--quality-receipt-id",
      "quality-cli-blank",
      "--contact-sheet",
      contactSheetPath,
      "--plan-output",
      planPath
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.agent-revision-plan",
      visibleState: {
        panel: "agent",
        operation: "agent.revision.plan",
        packageId: "pkg_cli_revision",
        status: "needs_revision",
        findingCount: 4,
        proposedActionCount: 1,
        planPath
      },
      result: {
        ok: true,
        planPath,
        plan: {
          schema: "shellx-motion/agent-revision-plan@1",
          planId: "revision-cli-001",
          packageId: "pkg_cli_revision",
          templateId: "template_launch",
          sourceJobId: "prompt-cli-001",
          status: "needs_revision",
          evidence: {
            qualityReceiptIds: ["quality-cli-blank"],
            contactSheet: {
              path: "/tmp/contact-sheet.png",
              status: "needs_revision"
            }
          },
          proposedActions: [
            expect.objectContaining({
              command: "motion.prompt.run",
              target: { packageId: "pkg_cli_revision", templateId: "template_launch" }
            })
          ]
        }
      }
    });
    const writtenPlan = JSON.parse(await readFile(planPath, "utf8"));
    expect(writtenPlan).toMatchObject({
      planId: "revision-cli-001",
      status: "needs_revision",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "quality_failed", receiptId: "quality-cli-blank" }),
        expect.objectContaining({ code: "blank_frames", receiptId: "quality-cli-blank" }),
        expect.objectContaining({ code: "contact_sheet_needs_revision", message: "Headline needs stronger contrast." })
      ])
    });
  });

  it("routes safe source import debug commands through the CLI", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-source-import-"));
    tempDirs.push(outDir);

    const result = await runCli([
      "debug",
      "source-import",
      "--tier",
      "write_local",
      "--url",
      "https://example.com/articles/motion",
      "--out",
      outDir,
      "--title",
      "Motion Notes",
      "--kind",
      "article",
      "--markdown",
      "Alpha\n\nBeta",
      "--max-chars",
      "100",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.source-import",
      visibleState: {
        panel: "receipts",
        operation: "source.import",
        url: "https://example.com/articles/motion",
        kind: "article",
        markdownPath: join(outDir, "source.md"),
        receiptPath: join(outDir, "receipts", "source-import.receipt.json"),
        truncated: false
      },
      result: {
        ok: true,
        markdownPath: join(outDir, "source.md"),
        receiptPath: join(outDir, "receipts", "source-import.receipt.json")
      }
    });
    await expect(readFile(join(outDir, "source.md"), "utf8")).resolves.toContain("# Motion Notes");
  });

  it("routes GitHub source imports through the CLI without caller-supplied Markdown", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-source-import-repo-"));
    const outDir = join(tempRoot, "source");
    tempDirs.push(tempRoot);
    const requestedUrls: string[] = [];
    const sourceFetcher = async (url: string, init: { resolvedAddress: { address: string; family: 4 | 6 } }) => {
      requestedUrls.push(url);
      expect(init.resolvedAddress).toEqual({ address: "93.184.216.34", family: 4 });
      if (url === "https://api.github.com/repos/nexu-io/html-video") {
        return new Response(JSON.stringify({
          full_name: "nexu-io/html-video",
          description: "HTML becomes video on your laptop",
          language: "TypeScript",
          stargazers_count: 42,
          topics: ["video", "agents"],
          license: { spdx_id: "Apache-2.0" }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://api.github.com/repos/nexu-io/html-video/readme") {
        return new Response("HTML becomes video.\n\nUse local agents and MP4 export.", {
          status: 200,
          headers: { "content-type": "text/markdown" }
        });
      }
      if (url === "https://api.github.com/repos/nexu-io/html-video/contents") {
        return new Response(JSON.stringify([
          { name: "packages", type: "dir" },
          { name: "README.md", type: "file" }
        ]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("missing", { status: 404, statusText: "Not Found" });
    };

    const result = await runCli([
      "debug",
      "source-import",
      "--tier",
      "write_local",
      "--url",
      "https://github.com/nexu-io/html-video",
      "--out",
      outDir,
      "--max-chars",
      "4000",
      "--created-by",
      "cli-test"
    ], {
      sourceFetcher,
      sourceResolver: async () => [{ address: "93.184.216.34", family: 4 }]
    });

    expect(result).toMatchObject({
      ok: true,
      command: "debug.source-import",
      visibleState: {
        panel: "receipts",
        operation: "source.import",
        url: "https://github.com/nexu-io/html-video",
        kind: "repo",
        markdownPath: join(outDir, "source.md"),
        truncated: false
      },
      result: {
        ok: true,
        title: "nexu-io/html-video",
        kind: "repo"
      }
    });
    const markdown = await readFile(join(outDir, "source.md"), "utf8");
    expect(markdown).toContain("# nexu-io/html-video");
    expect(markdown).toContain("Kind: repo");
    expect(markdown).toContain("## README");
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/nexu-io/html-video",
      "https://api.github.com/repos/nexu-io/html-video/readme",
      "https://api.github.com/repos/nexu-io/html-video/contents"
    ]);
  });

  it("routes source-to-scripted-video debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-source-storyboard-"));
    tempDirs.push(tempRoot);
    const sourcePath = join(tempRoot, "source.md");
    const outDir = join(tempRoot, "storyboard");
    await writeFile(sourcePath, [
      "# Motion Launch Notes",
      "",
      "Source: https://example.com/articles/motion",
      "Kind: article",
      "",
      "## Problem",
      "Teams need deterministic video exports from promptable source material.",
      "",
      "## Cut handoff",
      "Scripted-video JSON can go directly to Cut without Canvas."
    ].join("\n"), "utf8");

    const result = await runCli([
      "debug",
      "source-storyboard",
      "--tier",
      "write_local",
      "--source",
      sourcePath,
      "--out",
      outDir,
      "--max-frames",
      "2",
      "--frame-duration-ms",
      "2200",
      "--created-by",
      "cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.source-storyboard",
      visibleState: {
        panel: "receipts",
        operation: "source.to_scripted_video",
        sourcePath,
        scriptPath: join(outDir, "scripted-video.json"),
        receiptPath: join(outDir, "receipts", "source-storyboard.receipt.json"),
        frameCount: 2,
        reviewRequired: true
      },
      result: {
        ok: true,
        scriptPath: join(outDir, "scripted-video.json"),
        receiptPath: join(outDir, "receipts", "source-storyboard.receipt.json"),
        frameCount: 2
      }
    });
    const scripted = JSON.parse(await readFile(join(outDir, "scripted-video.json"), "utf8"));
    expect(scripted.frames).toHaveLength(2);
    expect(scripted.frames[0]).toMatchObject({ title: "Problem", caption: "Source: example.com" });
  });

  it("routes storyboard panel debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-storyboard-panel-"));
    tempDirs.push(tempRoot);
    const scriptPath = join(tempRoot, "scripted-video.json");
    await writeFile(scriptPath, `${JSON.stringify(storyboardPanelScriptedVideo(), null, 2)}\n`, "utf8");

    const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () => await runCli([
      "debug",
      "storyboard-panel",
      "--script",
      scriptPath
    ]));

    expect(result).toMatchObject({
      ok: true,
      command: "debug.storyboard-panel",
      visibleState: {
        panel: "storyboard",
        operation: "storyboard.panel",
        scriptId: "source-storyboard-demo",
        name: "Source Storyboard Demo",
        frameCount: 2,
        sourceRefCount: 2,
        reviewRequired: true,
        readinessStatus: "needs-review",
        diagnosticCount: 1,
        warningCount: 1
      },
      result: {
        ok: true,
        scriptPath,
        scriptId: "source-storyboard-demo",
        readiness: {
          status: "needs-review",
          reviewRequired: true,
          counts: { errors: 0, warnings: 1, infos: 0 }
        },
        frames: [
          {
            id: "problem",
            startMs: 0,
            endMs: 2000,
            sourceRefCount: 1,
            templateId: "lower-third-source",
            engineId: "native-text"
          },
          {
            id: "handoff",
            startMs: 2000,
            endMs: 4200,
            sourceRefCount: 1
          }
        ]
      },
      warnings: ["Storyboard review is required before compile or Cut handoff."]
    });
  });

  it("routes storyboard graph debug commands through the CLI", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-debug-storyboard-graph-"));
    tempDirs.push(tempRoot);
    const scriptPath = join(tempRoot, "scripted-video.json");
    await writeFile(scriptPath, `${JSON.stringify(storyboardPanelScriptedVideo(), null, 2)}\n`, "utf8");

    const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () => await runCli([
      "debug",
      "storyboard-graph",
      "--script",
      scriptPath
    ]));

    expect(result).toMatchObject({
      ok: true,
      command: "debug.storyboard-graph",
      visibleState: {
        panel: "storyboard",
        operation: "storyboard.graph",
        scriptId: "source-storyboard-demo",
        name: "Source Storyboard Demo",
        nodeCount: 9,
        edgeCount: 9,
        frameCount: 2,
        sourceRefCount: 2,
        readinessStatus: "needs-review",
        diagnosticCount: 1,
        warningCount: 1
      },
      result: {
        ok: true,
        scriptPath,
        scriptId: "source-storyboard-demo",
        readiness: {
          status: "needs-review",
          reviewRequired: true,
          counts: { errors: 0, warnings: 1, infos: 0 }
        },
        counts: {
          nodes: 9,
          edges: 9,
          frames: 2,
          sourceRefs: 2,
          assetRefs: 1,
          templateHints: 1,
          engineHints: 1,
          reviewNodes: 1
        },
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "frame:problem", type: "frame", label: "Problem" }),
          expect.objectContaining({ id: "source:problem:0", type: "source", label: "Launch notes", url: "https://example.com/articles/motion#problem" }),
          expect.objectContaining({ id: "template:lower-third-source", type: "template", label: "lower-third-source" }),
          expect.objectContaining({ id: "engine:native-text", type: "engine", label: "native-text" })
        ]),
        edges: expect.arrayContaining([
          expect.objectContaining({ type: "sequence", from: "frame:problem", to: "frame:handoff" }),
          expect.objectContaining({ type: "references", from: "frame:problem", to: "source:problem:0" })
        ])
      },
      warnings: ["Storyboard review is required before compile or Cut handoff."]
    });
  });

  it("routes renderer capability matching through the CLI debug wrapper", async () => {
    const result = await runCli([
      "debug",
      "capabilities-match",
      "--package",
      resolve("../../fixtures/packages/web-card"),
      "--output",
      "png-frame",
      "--target",
      "preview",
      "--needs-alpha"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.capabilities-match",
      visibleState: {
        panel: "capabilities",
        packageId: "pkg_web_card",
        recommendedLane: "browser",
        output: "png-frame",
        target: "preview"
      },
      result: {
        ok: true,
        recommendedLane: "browser",
        matches: expect.arrayContaining([
          expect.objectContaining({ lane: "browser", ok: true, outputOk: true, alphaOk: true })
        ])
      }
    });
  });

  it("routes final render capability pipeline matching through the CLI debug wrapper", async () => {
    const packageRoot = resolve("../../fixtures/packages/lower-third");
    const result = await runCli([
      "debug",
      "capabilities-match",
      "--package",
      packageRoot,
      "--output",
      "mp4-h264",
      "--target",
      "final",
      "--needs-audio"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.capabilities-match",
      visibleState: {
        panel: "capabilities",
        packageId: "pkg_lower_third",
        recommendedLane: "ffmpeg",
        recommendedPipeline: ["browser", "ffmpeg"],
        output: "mp4-h264",
        target: "final"
      },
      result: {
        ok: true,
        recommendedLane: "ffmpeg",
        recommendedPipeline: {
          lanes: ["browser", "ffmpeg"],
          frameLane: "browser",
          finalLane: "ffmpeg"
        }
      }
    });
  });

  it("routes renderer capability panel cards through the CLI debug wrapper", async () => {
    const packageRoot = resolve("../../fixtures/packages/web-card");
    const result = await runCli([
      "debug",
      "capabilities-panel",
      "--package",
      packageRoot,
      "--output",
      "png-frame",
      "--target",
      "preview",
      "--needs-alpha"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.capabilities-panel",
      visibleState: {
        panel: "capabilities",
        operation: "capabilities.panel",
        cardCount: 8,
        categoryCount: 4,
        laneCount: 8,
        packageId: "pkg_web_card",
        recommendedLane: "browser",
        output: "png-frame",
        target: "preview"
      },
      result: {
        ok: true,
        packageRoot,
        packageId: "pkg_web_card",
        motionId: "motion_web_card",
        summary: {
          cardCount: 8,
          laneCount: 8,
          categoryCount: 4,
          supportedCount: 1,
          recommendedLane: "browser"
        },
        cards: expect.arrayContaining([
          expect.objectContaining({
            lane: "browser",
            supported: true,
            recommended: true,
            badges: expect.arrayContaining(["alpha", "subtitles", "stable", "medium"]),
            colorAlpha: browserColorAlphaContract(),
            // Third and last copy of this contract. `playwright-core` ships no browser, so "bundled"
            // was a claim Motion could not keep, and the `playwright --version` probe passed on a
            // machine with no browser at all. Fixed in core, then in debug-api's panel test, and the
            // CLI held a third assertion that kept the old shape alive one ladder run longer.
            runtime: {
              availability: "external-binary",
              requirement: "Chrome or Chromium browser binary (not shipped; see doctor)",
              cost: "local-cpu",
              readiness: { command: "motion.platform.requirements", tools: ["chromium"] },
              setupHint: "Install a Chrome/Chromium browser, or set SHELLX_MOTION_BROWSER to one. Run `doctor` for what this machine is missing."
            }
          }),
          expect.objectContaining({
            lane: "native",
            supported: false,
            unsupportedCount: 1
          }),
          expect.objectContaining({
            id: "adapter.svg",
            lane: "svg-adapter",
            adapter: expect.objectContaining({
              formats: ["svg"],
              previewLaneRequirement: "browser",
              finalLaneRequirement: "ffmpeg"
            })
          })
        ])
      }
    });
  });

  it("runs prompts through the deterministic fake local agent", async () => {
    const result = await runCli(["prompt", "run", "preview current package", "--package-id", "lower-third"], {
      promptRuntime: createFakePromptRuntime()
    });

    expect(result).toMatchObject({
      ok: true,
      command: "prompt.run",
      receipts: [expect.stringMatching(/^agent-/), expect.stringMatching(/^prompt-/)]
    });
  });

  it("does not let --keep-frames consume a positional or the next option while collecting prompts", async () => {
    const runtime = createFakePromptRuntime();
    let prompt = "";
    const result = await runCli([
      "prompt", "run", "preview", "--keep-frames", "current package", "--package-id", "lower-third"
    ], {
      promptRuntime: {
        runPrompt: async (input) => {
          prompt = input.prompt;
          return runtime.runPrompt(input);
        }
      }
    });

    expect(result).toMatchObject({ ok: true, command: "prompt.run" });
    expect(prompt).toContain('User request JSON: "preview current package"');
    expect(prompt).not.toContain("preview current package lower-third");
  });

  it("keeps direct summary-only prompts portable when raw retention capability is unavailable", async () => {
    let runtimeCalls = 0;
    const runtime = createFakePromptRuntime();

    const result = await runCli(["prompt", "run", "preview current package", "--package-id", "lower-third"], {
      hasStableReceiptPurgeCapability: () => false,
      promptRuntime: {
        runPrompt: async (input) => {
          runtimeCalls += 1;
          return await runtime.runPrompt(input);
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      command: "prompt.run",
      promptRetention: { mode: "summary_only", rawRequestRetained: false }
    });
    expect(runtimeCalls).toBe(1);
  });

  it("refuses direct raw retention without stable receipt purge capability before runtime or receipt writes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-raw-retention-capability-"));
    tempDirs.push(tempRoot);
    const receiptsRoot = join(tempRoot, "receipts");
    const request = "raw prompt that must not reach an unsupported receipt store";
    const runtime = createFakePromptRuntime();
    let runtimeCalls = 0;

    const result = await runCli([
      "prompt", "run", request,
      "--receipts-root", receiptsRoot,
      "--retain-raw-prompt",
      "--raw-prompt-delete-after", "2040-01-02T00:00:00.000Z",
      "--raw-prompt-purpose", "debugging"
    ], {
      hasStableReceiptPurgeCapability: () => false,
      promptRuntime: {
        runPrompt: async (input) => {
          runtimeCalls += 1;
          return await runtime.runPrompt(input);
        }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      command: "prompt.run",
      error: { code: "capability_unavailable", message: expect.stringContaining("stable receipt read-and-purge") }
    });
    expect(runtimeCalls).toBe(0);
    expect(await readdir(tempRoot)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(request);
  });

  it("refuses direct raw retention without a governed receipt root before runtime", async () => {
    const runtime = createFakePromptRuntime();
    let runtimeCalls = 0;

    const result = await runCli([
      "prompt", "run", "raw prompt that must not be returned inline",
      "--retain-raw-prompt",
      "--raw-prompt-delete-after", "2040-01-02T00:00:00.000Z",
      "--raw-prompt-purpose", "debugging"
    ], {
      hasStableReceiptPurgeCapability: () => true,
      promptRuntime: {
        runPrompt: async (input) => {
          runtimeCalls += 1;
          return await runtime.runPrompt(input);
        }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      command: "prompt.run",
      error: { code: "capability_unavailable", message: expect.stringContaining("host-configured receipt root") }
    });
    expect(runtimeCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("raw prompt that must not be returned inline");
  });

  itLinux("refuses a symlinked raw-retention receipt root before provider execution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-raw-retention-symlink-"));
    tempDirs.push(tempRoot);
    const actualRoot = join(tempRoot, "actual");
    const receiptsRoot = join(tempRoot, "receipts-link");
    await mkdirRaw(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, receiptsRoot, "dir");
    let runtimeCalls = 0;

    const result = await runCli([
      "prompt", "run", "raw prompt that cannot outlive its stable root",
      "--receipts-root", receiptsRoot,
      "--retain-raw-prompt",
      "--raw-prompt-delete-after", "2040-01-02T00:00:00.000Z",
      "--raw-prompt-purpose", "debugging"
    ], {
      hasStableReceiptPurgeCapability: () => true,
      promptNow: () => "2040-01-01T00:00:00.000Z",
      promptRuntime: { runPrompt: async () => { runtimeCalls += 1; throw new Error("must not execute"); } }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringContaining("stable receipt root") } });
    expect(runtimeCalls).toBe(0);
    expect(await readdir(actualRoot)).toEqual([]);
  });

  it("admits direct raw retention only with a supported governed receipt store", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-retention-"));
    tempDirs.push(receiptsRoot);
    const createdAt = "2040-01-01T00:00:00.000Z";
    const deleteAfter = "2040-01-08T00:00:00.000Z";
    const request = "Project Cobalt exact CLI replay";

    const result = await runCli([
      "prompt",
      "run",
      request,
      "--package-id",
      "private-package",
      "--receipts-root",
      receiptsRoot,
      "--retain-raw-prompt",
      "--raw-prompt-delete-after",
      deleteAfter,
      "--raw-prompt-purpose",
      "user_requested_replay"
    ], {
      hasStableReceiptPurgeCapability: () => true,
      promptNow: () => createdAt,
      promptRuntime: createFakePromptRuntime()
    });

    expect(result).toMatchObject({
      ok: true,
      command: "prompt.run",
      promptRetention: {
        mode: "raw_request",
        rawRequestRetained: true,
        deleteAfter,
        purpose: "user_requested_replay"
      },
      receiptPaths: [expect.any(String), expect.any(String)]
    });
    if (!result.ok) return;
    const receiptPaths = result.receiptPaths as string[];
    const promptReceipt = JSON.parse(await readFile(receiptPaths[1], "utf8"));
    expect(promptReceipt.output.rawRequest).toBe(request);
    // The warning now states what actually happens at the deadline, not just that one exists:
    // receipt reads redact the prompt and rewrite the stored receipt. It used to record a deadline
    // nothing enforced.
    expect(promptReceipt.warnings).toContain(
      `Raw prompt retained for user_requested_replay until ${deleteAfter}; receipt readers redact it after that deadline.`
    );

    await expect(runCli([
      "prompt",
      "run",
      "private request",
      "--retain-raw-prompt",
      "--raw-prompt-purpose",
      "debugging"
    ], { promptRuntime: createFakePromptRuntime() })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_prompt_retention", message: expect.stringContaining("delete-after") }
    });
  });

  itLinux("redacts a direct raw prompt before its parent receipt persists after a receipt-write deadline race", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-retention-deadline-race-"));
    tempDirs.push(receiptsRoot);
    const request = "direct CLI parent receipt deadline race";
    let now = "2040-01-01T00:00:00.000Z";
    const result = await runCli([
      "prompt", "run", request, "--receipts-root", receiptsRoot,
      "--retain-raw-prompt", "--raw-prompt-delete-after", "2040-01-01T00:00:01.000Z", "--raw-prompt-purpose", "debugging"
    ], {
      promptNow: () => now,
      promptReceiptWriteTestHook: (receipt) => { if (receipt.operation === "agent.prompt") now = "2040-01-01T00:00:02.000Z"; },
      promptRuntime: createFakePromptRuntime()
    });

    expect(result).toMatchObject({ ok: true, promptRetention: { rawRequestRetained: false, rawRequestRedactedAt: "2040-01-01T00:00:02.000Z" } });
    expect(JSON.stringify(result)).not.toContain(request);
    if (!result.ok) return;
    const receiptPaths = result.receiptPaths as string[];
    expect(await readFile(receiptPaths[1]!, "utf8")).not.toContain(request);
  });

  itLinux("carries the direct CLI clock across raw command execution before parent persistence", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-execute-deadline-race-"));
    tempDirs.push(receiptsRoot);
    const request = "direct CLI command execution deadline race";
    const fake = createFakePromptRuntime();
    let now = "2040-01-01T00:00:00.000Z";
    const result = await runCli([
      "prompt", "run", request, "--receipts-root", receiptsRoot, "--execute-agent-commands",
      "--retain-raw-prompt", "--raw-prompt-delete-after", "2040-01-01T00:00:01.000Z", "--raw-prompt-purpose", "debugging"
    ], {
      promptNow: () => now,
      promptReceiptWriteTestHook: (receipt) => { if (receipt.operation === "agent.prompt") now = "2040-01-01T00:00:02.000Z"; },
      promptRuntime: { runPrompt: async (input) => {
        const agent = await fake.runPrompt(input);
        return agent.ok ? { ...agent, structuredOutput: { debugCommands: [] } } : agent;
      } }
    });

    expect(result).toMatchObject({ ok: true, visibleState: { rawRequestRetained: false }, result: { receipt: { output: { promptRetention: { rawRequestRetained: false } } } } });
    if (!result.ok) return;
    expect(JSON.stringify((result.result as { receipt?: unknown }).receipt)).not.toContain(request);
    const { receiptPath } = result.visibleState as { receiptPath: string };
    expect(await readFile(receiptPath, "utf8")).not.toContain(request);
  });

  it("keeps past and equal direct raw-retention deadlines rejected before runtime or receipt writes", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-retention-deadline-"));
    tempDirs.push(receiptsRoot);
    const createdAt = "2040-01-01T00:00:00.000Z";
    const runtime = createFakePromptRuntime();
    let runtimeCalls = 0;

    for (const deleteAfter of ["2039-12-31T23:59:59.999Z", createdAt]) {
      const result = await runCli([
        "prompt", "run", "replay request",
        "--receipts-root", receiptsRoot,
        "--retain-raw-prompt",
        "--raw-prompt-delete-after", deleteAfter,
        "--raw-prompt-purpose", "debugging"
      ], {
        hasStableReceiptPurgeCapability: () => true,
        promptNow: () => createdAt,
        promptRuntime: {
          runPrompt: async (input) => {
            runtimeCalls += 1;
            return await runtime.runPrompt(input);
          }
        }
      });

      expect(result).toMatchObject({
        ok: false,
        command: "prompt.run",
        error: { code: "invalid_prompt_retention", message: expect.stringContaining("later") }
      });
    }

    expect(runtimeCalls).toBe(0);
    expect(await readdir(receiptsRoot)).toEqual([]);
  });

  itLinux("keeps direct CLI raw receipts inside the existing stable read-time purge lifecycle", async () => {
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-retention-purge-"));
    tempDirs.push(receiptsRoot);
    const request = "direct-cli prompt that must be purged at receipt read time";
    const result = await runCli([
      "prompt", "run", request,
      "--receipts-root", receiptsRoot,
      "--retain-raw-prompt",
      "--raw-prompt-delete-after", "2040-01-08T00:00:00.000Z",
      "--raw-prompt-purpose", "debugging"
    ], {
      promptNow: () => "2040-01-01T00:00:00.000Z",
      promptRuntime: createFakePromptRuntime()
    });

    expect(result).toMatchObject({ ok: true, receiptPaths: [expect.any(String), expect.any(String)] });
    if (!result.ok) return;
    const promptReceiptPath = (result.receiptPaths as string[])[1]!;
    const promptReceipt = JSON.parse(await readFile(promptReceiptPath, "utf8"));
    expect(promptReceipt).toMatchObject({ output: { callerId: "cli:local" } });
    promptReceipt.output.promptRetention.deleteAfter = "2000-01-01T00:00:00.000Z";
    await writeFile(promptReceiptPath, JSON.stringify(promptReceipt), "utf8");

    const read = await dispatchDebugCommand(
      "motion.receipts.read",
      { receiptsRoot, receiptPath: promptReceiptPath },
      { tier: "read_motion", receiptsRoot, callerId: "cli:local" }
    );

    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).not.toContain(request);
    expect(await readFile(promptReceiptPath, "utf8")).not.toContain(request);
  });

  it("executes prompt command proposals through the top-level prompt CLI", async () => {
    const sourcePackageRoot = await writeTinyPackageWithTimeline();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-prompt-execute-"));
    const packageRoot = join(workspaceRoot, "package");
    const outDir = join(workspaceRoot, "outputs");
    await cp(sourcePackageRoot, packageRoot, { recursive: true });
    await mkdir(outDir, { mode: 0o700 });
    tempDirs.push(sourcePackageRoot, workspaceRoot);
    const receiptsRoot = join(outDir, "receipts");
    const patchedPackageRoot = join(outDir, "patched-package");
    const previewOutDir = join(outDir, "preview");
    const previewPath = join(previewOutDir, "frame.png");

    const result = await runCli([
      "prompt",
      "run",
      "edit title and preview",
      "--tier",
      "edit_motion",
      "--package-id",
      "pkg_cli_ffmpeg_sequence",
      "--agent",
      "fake",
      "--receipts-root",
      receiptsRoot,
      "--cwd",
      workspaceRoot,
      "--execute-agent-commands"
    ], {
      promptRuntime: {
        runPrompt: async (input) => ({
          ok: true,
          structuredOutput: {
            ok: true,
            debugCommands: [
              {
                command: "motion.package.patch",
                args: {
                  packageRoot,
                  outDir: patchedPackageRoot,
                  patch: [{ op: "replace", path: "/layers/0/text", value: "Top Prompt Edited" }],
                  createdBy: "cli-prompt"
                }
              },
              {
                command: "motion.preview.frame",
                args: {
                  packageRoot: patchedPackageRoot,
                  outDir: previewOutDir,
                  outputPath: previewPath,
                  atMs: 0
                }
              }
            ]
          },
          transcript: {
            stdout: "[structured agent response]",
            stderr: "",
            redacted: true,
            truncated: false,
            maxBytes: 65_536
          },
          receipt: cliAgentReceipt({
            id: "agent-top-prompt-execute",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            output: {
              agentId: input.agentId ?? "fake",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            }
          })
        })
      },
      browserFrameRenderer: async (pkg, options) => {
        await mkdir(options.outDir, { recursive: true });
        await writeFile(options.outputPath ?? previewPath, BLACK_PNG);
        const output = {
          path: options.outputPath ?? previewPath,
          sha256: "e".repeat(64),
          format: "png" as const,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        };
        return {
          ok: true,
          output,
          receipt: cliDebugReceipt({
            id: "preview-frame-top-prompt-execute",
            operation: "preview.frame",
            status: "passed",
            packageId: pkg.manifest.id,
            lane: "browser",
            output,
            artifacts: [
              { role: "preview_frame", path: output.path, status: "available", mediaType: "image/png", primary: true }
            ]
          })
        };
      }
    });

    expect(result).toMatchObject({
      ok: true,
      command: "prompt.run",
      result: {
        ok: true,
        execution: {
          commandCount: 2,
          receiptIds: [expect.stringMatching(/^package-patch-pkg_cli_ffmpeg_sequence-/), "preview-frame-top-prompt-execute"]
        }
      }
    });
    const patchedMotion = JSON.parse(await readFile(join(patchedPackageRoot, "motion.json"), "utf8"));
    expect(patchedMotion.layers[0].text).toBe("Top Prompt Edited");
    expect(await readFile(join(receiptsRoot, "preview-frame-top-prompt-execute.receipt.json"), "utf8")).toContain("preview.frame");
  });

  it("routes title entrance animation prompts through the preset action", async () => {
    const result = await runCli(["prompt", "run", "make the title slide in and preview it", "--tier", "edit_motion", "--package-id", "lower-third"], {
      promptRuntime: createFakePromptRuntime()
    });

    expect(result).toMatchObject({
      ok: true,
      command: "prompt.run",
      actionId: "motion.timeline.animation.preset.apply",
      debugCommands: ["motion.state", "motion.timeline.animation.preset.apply", "motion.preview.frame", "motion.receipts.read"]
    });
  });

  it("creates native PNG preview smoke artifacts with a receipt", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-"));
    tempDirs.push(outDir);

    const result = await runCli(["preview", fixtureRoot, "--lane", "native", "--out", outDir]);
    const png = await readFile(join(outDir, "pkg_lower_third-native-0.png"));
    const receipt = JSON.parse(await readFile(join(outDir, "pkg_lower_third-native-preview.receipt.json"), "utf8")) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      command: "preview",
      lane: "native",
      receiptId: receipt.id
    });
    expect(result.output).not.toHaveProperty("png");
    expect(result.output).toMatchObject({
      path: join(outDir, "pkg_lower_third-native-0.png"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      width: 1920,
      height: 1080,
      atMs: 0
    });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // the text-delivery invariant: the lower-third fixture is lowercase Inter text, so the native preview receipt is
    // degraded and names the case fold + ignored font instead of reporting a clean pass.
    expect(receipt).toMatchObject({ operation: "preview.frame", status: "warning", packageId: "pkg_lower_third", lane: "native" });
  });

  it("refuses active browser previews before creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-browser-"));
    const outDir = join(root, "out");
    tempDirs.push(root);

    const result = await runCli(["preview", resolve("../../fixtures/packages/web-card"), "--lane", "browser", "--out", outDir]);

    expect(result).toMatchObject({
      ok: false,
      command: "preview",
      error: { code: "script_provenance_unresolved" }
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects misspelled preview time flags instead of silently rendering frame zero", async () => {
    const gpuOut = await mkdtemp(join(tmpdir(), "shellx-motion-cli-gpu-refusal-"));
    tempDirs.push(gpuOut);
    await expect(runCli(["preview", fixtureRoot, "--lane", "browser", "--at", "3000"])).resolves.toEqual({
      ok: false,
      command: "preview",
      error: { code: "invalid_args", message: "Unsupported preview option: --at. Use --at-ms for the capture time." }
    });
    await expect(runCli(["preview", fixtureRoot, "--lane", "gpu", "--out", gpuOut])).resolves.toMatchObject({
      ok: false,
      command: "preview",
      lane: "gpu",
      error: { code: "gpu_unsupported_feature" }
    });
    await expect(runCli(["preview", fixtureRoot, "--lane", "webgpu"])).resolves.toEqual({
      ok: false,
      command: "preview",
      error: { code: "unsupported_lane", message: "preview --lane must be native, browser, or gpu; received webgpu. gpu is the strict general hardware WebGPU PNG preview lane with no fallback; ffmpeg is a delivery lane and has no preview form; use `render --lane ffmpeg` instead." }
    });
    await expect(runCli(["preview", fixtureRoot, "--at-ms", "NaN"])).resolves.toEqual({
      ok: false,
      command: "preview",
      error: { code: "invalid_args", message: "--at-ms must be a non-negative finite number." }
    });
  });

  it("captures generated MotionIR through the deterministic browser workflow", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-browser-"));
    const outDir = join(outRoot, "capture");
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);

    const result = await runCli(["capture-browser", packageRoot, "--out", outDir, "--at-ms", "100"]);
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8")) as Record<string, any>;
    const png = await readFile(String(result.outputPath));

    expect(result).toMatchObject({
      ok: true,
      command: "capture-browser",
      lane: "browser",
      deterministic: {
        network: "blocked-unless-declared",
        animations: "disabled",
        caret: "hide",
        deviceScaleFactor: 1
      },
      output: {
        width: 64,
        height: 36,
        atMs: 100,
        viewport: { width: 64, height: 36, deviceScaleFactor: 1 }
      }
    });
    expect(receipt).toMatchObject({
      operation: "browser.workflow.capture",
      status: "passed",
      lane: "browser",
      inputHashes: { motion: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("captures browser frames with a deterministic replay workflow receipt", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-"));
    const outDir = join(outRoot, "capture");
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outRoot, "workflow.json");
    tempDirs.push(outRoot, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      viewport: { width: 64, height: 36, deviceScaleFactor: 1 },
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 5 },
        { action: "scroll", y: 10 }
      ],
      cursor: { visible: false, path: [{ x: 4, y: 4, atMs: 0 }] }
    }, null, 2));

    const result = await runCli(["capture-browser", packageRoot, "--out", outDir, "--at-ms", "100", "--workflow", workflowPath]);
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8")) as Record<string, any>;
    const workflowTrace = JSON.parse(await readFile(String(result.workflowTracePath), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "capture-browser",
      workflowPath,
      workflowTracePath: join(outDir, "pkg_cli_ffmpeg_sequence-browser-workflow.trace.json"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "preview_frame", path: result.outputPath, status: "available", mediaType: "image/png", primary: true }),
        expect.objectContaining({ role: "browser_workflow_trace", path: join(outDir, "pkg_cli_ffmpeg_sequence-browser-workflow.trace.json"), status: "available", mediaType: "application/json" }),
        expect.objectContaining({ role: "preview_receipt", path: result.receiptPath, status: "available" })
      ]),
      workflow: {
        schema: "shellx-motion/browser-workflow@1",
        stepCount: 2,
        steps: [
          { action: "wait", ms: 5 },
          { action: "scroll", x: 0, y: 10 }
        ],
        cursor: { visible: false, pointCount: 1 }
      }
    });
    expect(receipt).toMatchObject({
      operation: "browser.workflow.capture",
      inputHashes: {
        workflow: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      output: {
        workflow: {
          stepCount: 2
        },
        workflowTracePath: join(outDir, "pkg_cli_ffmpeg_sequence-browser-workflow.trace.json"),
        workflowTrace: {
          schema: "shellx-motion/browser-workflow-trace@1",
          stepCount: 2,
          steps: [
            { index: 0, action: { action: "wait", ms: 5 }, status: "passed" },
            { index: 1, action: { action: "scroll", x: 0, y: 10 }, status: "passed" }
          ]
        }
      }
    });
    expect(workflowTrace).toMatchObject({
      schema: "shellx-motion/browser-workflow-trace@1",
      workflowHash: receipt.inputHashes.workflow,
      stepCount: 2,
      steps: [
        { index: 0, action: { action: "wait", ms: 5 }, status: "passed" },
        { index: 1, action: { action: "scroll", x: 0, y: 10 }, status: "passed" }
      ]
    });
  });

  it("emits a deterministic browser recording manifest with private default frames under umask 0002", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-browser-recording-manifest-"));
    const outDir = join(outRoot, "capture");
    const packageRoot = await writeTinyNativePackage();
    const recordingManifestPath = join(outDir, "browser-recording.manifest.json");
    const renderedAtMs: number[] = [];
    const privateSampleEvidenceModes = new Map<number, number>();
    tempDirs.push(outRoot, packageRoot);

    const browserFrameRenderer: BrowserFrameRenderer = async (pkg, options) => {
      renderedAtMs.push(options.atMs);
      if (options.atMs !== 100) {
        // This runs before the injected renderer creates its output. Each sample must already
        // have the private evidence root that production renderer companions share.
        privateSampleEvidenceModes.set(options.atMs, Number((await stat(options.outDir)).mode) & 0o777);
      }
      const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-${options.atMs}.png`);
      await writeFile(outputPath, `png ${options.atMs}`, "utf8");
      return {
        ok: true,
        output: {
          path: outputPath,
          sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        },
        receipt: {
          schema: "shellx-motion/receipt@1",
          id: `browser-preview-${options.atMs}`,
          operation: "preview.frame",
          status: "passed",
          packageId: pkg.manifest.id,
          inputHashes: { motion: "b".repeat(64) },
          createdAt: "2026-07-01T00:00:00.000Z",
          lane: "browser",
          output: { path: outputPath },
          warnings: []
        }
      };
    };

    const previousUmask = process.platform === "win32" ? undefined : process.umask(0o002);
    let result: Awaited<ReturnType<typeof runCli>>;
    try {
      result = await runCli([
        "capture-browser",
        packageRoot,
        "--out",
        outDir,
        "--at-ms",
        "100",
        "--recording-manifest",
        recordingManifestPath,
        "--recording-samples",
        "3"
      ], { browserFrameRenderer });
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
    const manifest = JSON.parse(await readFile(recordingManifestPath, "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8")) as Record<string, any>;

    expect(renderedAtMs).toEqual([100, 0, 150, 300]);
    if (process.platform !== "win32") {
      expect([...privateSampleEvidenceModes.entries()]).toEqual([[0, 0o700], [150, 0o700], [300, 0o700]]);
    }
    expect(result).toMatchObject({
      ok: true,
      recordingManifestPath,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "browser_recording_manifest", path: recordingManifestPath, status: "available", mediaType: "application/json" })
      ])
    });
    expect(manifest).toMatchObject({
      schema: "shellx-motion/browser-recording-manifest@1",
      mode: "deterministic-browser-frame-samples",
      packageId: "pkg_cli_ffmpeg_sequence",
      motionId: "motion_cli_ffmpeg_sequence",
      durationMs: 300,
      fps: 10,
      sampleCount: 3,
      frames: [
        { index: 0, atMs: 0, path: join(outDir, "browser-recording-frames", "000000.png") },
        { index: 1, atMs: 150, path: join(outDir, "browser-recording-frames", "000001.png") },
        { index: 2, atMs: 300, path: join(outDir, "browser-recording-frames", "000002.png") }
      ],
      encodePlan: {
        pipeline: ["browser", "ffmpeg"],
        frameLane: "browser",
        finalLane: "ffmpeg"
      }
    });
    expect(receipt.output).toMatchObject({
      recordingManifestPath,
      recordingManifest: {
        schema: "shellx-motion/browser-recording-manifest@1",
        sampleCount: 3
      }
    });
    if (process.platform !== "win32") {
      expect(Number((await stat(join(outDir, "browser-recording-frames"))).mode) & 0o777).toBe(0o700);
    }
  });

  it("preserves an existing CLI browser recording manifest", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-browser-recording-manifest-no-clobber-"));
    const outDir = join(outRoot, "capture");
    const packageRoot = await writeTinyNativePackage();
    const recordingManifestPath = join(outDir, "browser-recording.manifest.json");
    const preserved = "retain pre-existing manifest\n";
    tempDirs.push(outRoot, packageRoot);
    await mkdir(outDir);
    await writeFile(recordingManifestPath, preserved, "utf8");

    const browserFrameRenderer: BrowserFrameRenderer = async (pkg, options) => {
      const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-${options.atMs}.png`);
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeFile(outputPath, `png ${options.atMs}`, "utf8");
      return {
        ok: true,
        output: {
          path: outputPath,
          sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        },
        receipt: {
          schema: "shellx-motion/receipt@1",
          id: `browser-manifest-no-clobber-${options.atMs}`,
          operation: "preview.frame",
          status: "passed",
          packageId: pkg.manifest.id,
          inputHashes: { motion: "b".repeat(64) },
          createdAt: "2026-08-11T00:00:00.000Z",
          lane: "browser",
          output: { path: outputPath },
          warnings: []
        }
      };
    };

    await expect(runCli([
      "capture-browser",
      packageRoot,
      "--out",
      outDir,
      "--recording-manifest",
      recordingManifestPath,
      "--recording-samples",
      "1"
    ], { browserFrameRenderer })).rejects.toMatchObject({ code: "derived_output_exists" });
    await expect(readFile(recordingManifestPath, "utf8")).resolves.toBe(preserved);
  });

  it("catalogs deterministic browser workflow captures and reports replay drift", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-catalog-"));
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outDir, "workflow.json");
    const catalogPath = join(outDir, "browser-workflows.catalog.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      viewport: { width: 64, height: 36, deviceScaleFactor: 1 },
      networkPolicy: "blocked-unless-declared",
      steps: [{ action: "wait", ms: 5 }]
    }, null, 2));

    const first = await runCli(["capture-browser", packageRoot, "--out", join(outDir, "first"), "--at-ms", "100", "--workflow", workflowPath, "--catalog", catalogPath]);
    const second = await runCli(["capture-browser", packageRoot, "--out", join(outDir, "second"), "--at-ms", "100", "--workflow", workflowPath, "--catalog", catalogPath]);
    await rewriteTinyNativePackageTitle(packageRoot, "B");
    const changed = await runCli(["capture-browser", packageRoot, "--out", join(outDir, "changed"), "--at-ms", "100", "--workflow", workflowPath, "--catalog", catalogPath]);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;
    const changedReceipt = JSON.parse(await readFile(String(changed.receiptPath), "utf8")) as Record<string, any>;
    const firstOutput = first.output as { sha256: string };
    const secondOutput = second.output as { sha256: string };
    const changedOutput = changed.output as { sha256: string };

    expect(first).toMatchObject({
      ok: true,
      command: "capture-browser",
      workflowCatalogPath: catalogPath,
      workflowDrift: { status: "new" },
      artifacts: expect.not.arrayContaining([
        expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath })
      ])
    });
    expect(second).toMatchObject({
      ok: true,
      command: "capture-browser",
      workflowCatalogPath: catalogPath,
      workflowDrift: {
        status: "matched",
        baselineOutputSha256: firstOutput.sha256,
        currentOutputSha256: secondOutput.sha256
      }
    });
    expect(changed).toMatchObject({
      ok: true,
      command: "capture-browser",
      workflowCatalogPath: catalogPath,
      workflowDrift: {
        status: "changed",
        baselineOutputSha256: firstOutput.sha256,
        previousOutputSha256: secondOutput.sha256,
        currentOutputSha256: changedOutput.sha256
      },
      warnings: expect.arrayContaining([expect.stringContaining("Browser workflow drift detected")])
    });
    expect(catalog).toMatchObject({
      schema: "shellx-motion/browser-workflow-catalog@1",
      entries: [
        {
          packageId: "pkg_cli_ffmpeg_sequence",
          atMs: 100,
          baseline: { outputSha256: firstOutput.sha256 },
          latest: { outputSha256: changedOutput.sha256 },
          drift: {
            status: "changed",
            currentOutputSha256: changedOutput.sha256
          },
          history: [
            { outputSha256: firstOutput.sha256 },
            { outputSha256: secondOutput.sha256 },
            { outputSha256: changedOutput.sha256 }
          ]
        }
      ]
    });
    expect(changedReceipt.output).not.toHaveProperty("workflowCatalogPath");
    expect(changedReceipt.artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath })
    ]));
  });

  it("can fail deterministic browser workflow captures on catalog drift", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-drift-fail-"));
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outDir, "workflow.json");
    const catalogPath = join(outDir, "browser-workflows.catalog.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      steps: [{ action: "wait", ms: 5 }]
    }, null, 2));

    const first = await runCli(["capture-browser", packageRoot, "--out", join(outDir, "first"), "--workflow", workflowPath, "--catalog", catalogPath]);
    await rewriteTinyNativePackageTitle(packageRoot, "C");
    const result = await runCli([
      "capture-browser",
      packageRoot,
      "--out",
      join(outDir, "changed"),
      "--workflow",
      workflowPath,
      "--catalog",
      catalogPath,
      "--fail-on-drift"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "capture-browser",
      workflowCatalogPath: catalogPath,
      workflowDrift: { status: "changed" },
      error: {
        code: "browser_workflow_drift_detected",
        message: expect.stringContaining("Browser workflow drift detected")
      }
    });
    await expect(stat(join(outDir, "changed", "pkg_cli_ffmpeg_sequence-browser-0.png"))).rejects.toMatchObject({ code: "ENOENT" });
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;
    expect(catalog.entries[0].history).toHaveLength(1);
    expect(catalog.entries[0].latest.outputSha256).toBe((first.output as { sha256: string }).sha256);
  });

  it("uses canonical workflow hashes for catalog baselines with equivalent default policy", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-canonical-"));
    const packageRoot = await writeTinyNativePackage();
    const explicitWorkflowPath = join(outDir, "workflow-explicit.json");
    const implicitWorkflowPath = join(outDir, "workflow-implicit.json");
    const catalogPath = join(outDir, "browser-workflows.catalog.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(explicitWorkflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 5 },
        { action: "scroll", y: 0 }
      ]
    }, null, 2));
    await writeFile(implicitWorkflowPath, JSON.stringify({
      steps: [
        { ms: 5, action: "wait" },
        { y: 0, x: 0, action: "scroll" }
      ],
      schema: "shellx-motion/browser-workflow@1"
    }, null, 2));

    const first = await runCli(["capture-browser", packageRoot, "--out", join(outDir, "first"), "--workflow", explicitWorkflowPath, "--catalog", catalogPath]);
    const second = await runCli(["capture-browser", packageRoot, "--out", join(outDir, "second"), "--workflow", implicitWorkflowPath, "--catalog", catalogPath]);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;

    expect(second).toMatchObject({
      ok: true,
      command: "capture-browser",
      workflowDrift: {
        status: "matched",
        baselineOutputSha256: (first.output as { sha256: string }).sha256,
        currentOutputSha256: (second.output as { sha256: string }).sha256
      }
    });
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      packageId: "pkg_cli_ffmpeg_sequence",
      workflowHash: (first.output as { workflowTrace: { workflowHash: string } }).workflowTrace.workflowHash,
      drift: { status: "matched" },
      history: [
        { outputSha256: (first.output as { sha256: string }).sha256 },
        { outputSha256: (second.output as { sha256: string }).sha256 }
      ]
    });
  });

  it("returns a failed replay trace artifact when browser workflow verification fails", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-failure-"));
    const outDir = join(outRoot, "capture");
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outRoot, "workflow.json");
    tempDirs.push(outRoot, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      steps: [
        { action: "wait", ms: 5 },
        { action: "verify", selector: "body", text: "Do not leak expected text" }
      ]
    }, null, 2));

    const result = await runCli(["capture-browser", packageRoot, "--out", outDir, "--workflow", workflowPath]);
    const workflowTracePath = join(outDir, "pkg_cli_ffmpeg_sequence-browser-workflow.trace.json");
    const receiptPath = join(outDir, "pkg_cli_ffmpeg_sequence-browser-capture.receipt.json");
    const trace = JSON.parse(await readFile(workflowTracePath, "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      command: "capture-browser",
      workflowPath,
      workflowTracePath,
      receiptPath,
      error: {
        code: "browser_workflow_replay_failed",
        message: expect.stringContaining("Browser workflow replay failed at step 1")
      },
      workflowTrace: {
        stepCount: 2,
        steps: [
          { index: 0, action: { action: "wait", ms: 5 }, status: "passed" },
          {
            index: 1,
            action: { action: "verify", selector: "body", hasText: true },
            status: "failed",
            error: {
              code: "text_mismatch",
              selector: "body",
              expectedTextLength: 25,
              actualTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
            }
          }
        ]
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "browser_workflow_trace", path: workflowTracePath, status: "failed" }),
        expect.objectContaining({ role: "preview_receipt", path: receiptPath, status: "available" })
      ])
    });
    expect(trace).toMatchObject(result.workflowTrace as Record<string, unknown>);
    expect(receipt).toMatchObject({
      operation: "browser.workflow.capture",
      status: "failed",
      output: {
        workflowTracePath,
        workflowTrace: result.workflowTrace
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "browser_workflow_trace", status: "failed" })
      ])
    });
    const serialized = JSON.stringify({ result, trace, receipt });
    expect(serialized).not.toContain("Do not leak expected text");
  });

  it("rejects browser workflow scroll steps with non-numeric coordinates", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-invalid-scroll-"));
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outDir, "workflow.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      steps: [
        { action: "scroll", x: "640px", y: 10 }
      ]
    }, null, 2));

    await expect(runCli(["capture-browser", packageRoot, "--out", outDir, "--workflow", workflowPath]))
      .rejects.toThrow(`Invalid browser workflow: ${workflowPath}`);
  });

  it("rejects browser workflow wait steps that can stall deterministic capture", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-capture-workflow-long-wait-"));
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outDir, "workflow.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      steps: [
        { action: "wait", ms: 30_001 }
      ]
    }, null, 2));

    await expect(runCli(["capture-browser", packageRoot, "--out", outDir, "--workflow", workflowPath]))
      .rejects.toThrow(`Invalid browser workflow: ${workflowPath}`);
  });

  it("browser preview uses the generated MotionIR capture path", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-preview-browser-generated-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outDir, packageRoot);

    const result = await runCli(["preview", packageRoot, "--lane", "browser", "--out", outDir, "--at-ms", "100"]);

    expect(result).toMatchObject({
      ok: true,
      command: "preview",
      lane: "browser",
      output: {
        width: 64,
        height: 36,
        atMs: 100
      }
    });
  });

  it("plans FFmpeg render command without requiring ffmpeg when dry-run is requested", async () => {
    const result = await runCli(["render", fixtureRoot, "--lane", "ffmpeg", "--out", "/tmp/lower-third.mp4", "--dry-run"]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      dryRun: true,
      ffmpeg: { executable: resolveFfmpegExecutable(), shell: false }
    });
  });

  it("reports configured FFmpeg executable paths in render dry-runs", async () => {
    await withEnv("SHELLX_MOTION_FFMPEG", "/opt/shellx/bin/ffmpeg-custom", async () => {
      const result = await runCli(["render", fixtureRoot, "--lane", "ffmpeg", "--out", "/tmp/lower-third.mp4", "--dry-run"]);

      expect(result).toMatchObject({
        ok: true,
        command: "render",
        lane: "ffmpeg",
        dryRun: true,
        ffmpeg: { executable: "/opt/shellx/bin/ffmpeg-custom", shell: false }
      });
    });
  });

  it("plans WebM VP9 render presets in dry-run mode", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "webm-vp9",
      "--out",
      "/tmp/lower-third.webm",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      preset: "webm-vp9",
      dryRun: true,
      ffmpeg: {
        executable: resolveFfmpegExecutable(),
        args: expect.arrayContaining(["-c:v", "libvpx-vp9", "-crf", "32", "/tmp/lower-third.webm"]),
        shell: false
      }
    });
  });

  it.each([
    ["mp4-hevc", "/tmp/lower-third-hevc.mp4", ["-c:v", "libx265", "-tag:v", "hvc1"]],
    ["webm-av1", "/tmp/lower-third-av1.webm", ["-c:v", "libsvtav1", "-crf", "30"]]
  ] as const)("plans capability-selected %s renders in dry-run mode", async (preset, outputPath, expectedArgs) => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      preset,
      "--out",
      outputPath,
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      preset,
      dryRun: true,
      ffmpeg: {
        executable: resolveFfmpegExecutable(),
        args: expect.arrayContaining([...expectedArgs, outputPath]),
        shell: false
      }
    });
  });

  it("plans PNG sequence renders without an FFmpeg encode step in dry-run mode", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-sequence",
      "--out",
      "/tmp/lower-third-frames",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "image-sequence",
      frameLane: "browser",
      preset: "png-sequence",
      outputPath: "/tmp/lower-third-frames",
      dryRun: true,
      sequence: {
        outputDir: "/tmp/lower-third-frames",
        framePattern: "%06d.png",
        frameCount: 120,
        width: 1920,
        height: 1080,
        durationMs: 4000,
        fps: 30
      }
    });
    expect(result).not.toHaveProperty("ffmpeg");
  });

  it("plans still-frame image renders at a selected timestamp without an FFmpeg encode step", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-frame",
      "--out",
      "/tmp/lower-third-frame.png",
      "--at-ms",
      "1250",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "image",
      frameLane: "browser",
      preset: "png-frame",
      outputPath: "/tmp/lower-third-frame.png",
      dryRun: true,
      stillFrame: {
        outputPath: "/tmp/lower-third-frame.png",
        atMs: 1250,
        width: 1920,
        height: 1080,
        codec: "png",
        container: "image",
        preset: "png-frame"
      }
    });
    expect(result).not.toHaveProperty("ffmpeg");
  });

  it("rejects still-frame renders when the output extension disagrees with the preset", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "jpeg-frame",
      "--out",
      "/tmp/lower-third-frame.png",
      "--at-ms",
      "1250",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      error: {
        code: "invalid_args",
        message: "jpeg-frame outputs must use a .jpg or .jpeg path."
      }
    });
  });

  it("rejects FFmpeg renders when the output extension disagrees with the preset", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "webm-vp9-alpha",
      "--out",
      "/tmp/lower-third-alpha.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      error: {
        code: "invalid_args",
        message: "webm-vp9-alpha outputs must use a .webm path."
      }
    });
  });

  it("warns in dry-run mode when a silent export preset ignores requested audio", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "gif",
      "--audio",
      "/tmp/voiceover.wav",
      "--out",
      "/tmp/lower-third.gif",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      preset: "gif",
      audioPath: "/tmp/voiceover.wav",
      warnings: ["Export preset gif does not support audio; 1 requested audio track will be ignored."],
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining(["-loop", "0", "/tmp/lower-third.gif"])
      }
    });
    expect((result.ffmpeg as FfmpegCommand).args).not.toContain("/tmp/voiceover.wav");
  });

  it("plans audio muxing in FFmpeg render dry-runs", async () => {
    const result = await runCli([
      "render",
      fixtureRoot,
      "--lane",
      "ffmpeg",
      "--audio",
      "/tmp/voiceover.wav",
      "--out",
      "/tmp/lower-third-audio.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath: "/tmp/voiceover.wav",
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          "/tmp/voiceover.wav",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:a",
          "aac",
          "-t",
          "4",
          "/tmp/lower-third-audio.mp4"
        ])
      }
    });
  });

  it("plans package audio layers as FFmpeg mux inputs when --audio is omitted", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer();
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:a",
          "aac",
          "-t",
          "0.3",
          "/tmp/package-audio.mp4"
        ])
      }
    });
  });

  it("ignores package audio layers on muted tracks when --audio is omitted", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({ trackId: "music-track" });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks = [
      { id: "music-track", type: "audio", name: "Music", muted: true, layerIds: ["music"] }
    ];
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-muted-track-audio.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      dryRun: true
    });
    expect(result).not.toHaveProperty("audioPath");
    expect((result as { ffmpeg?: { args?: string[] } }).ffmpeg?.args ?? []).not.toContain(audioPath);
    expect(result).not.toHaveProperty("warnings");
  });

  it("keeps only package audio layers on soloed tracks when --audio is omitted", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({ trackId: "music-track" });
    tempDirs.push(packageRoot);
    const musicPath = join(packageRoot, "assets", "tone.wav");
    const voicePath = join(packageRoot, "assets", "voice.wav");
    const motionPath = join(packageRoot, "motion.json");
    const manifestPath = join(packageRoot, "manifest.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    sourceMotion.tracks = [
      { id: "music-track", type: "audio", name: "Music", solo: true, layerIds: ["music"] },
      { id: "voice-track", type: "audio", name: "Voice", layerIds: ["voice"] }
    ];
    sourceMotion.layers.push({
      id: "voice",
      type: "audio",
      trackId: "voice-track",
      source: "assets/voice.wav",
      startMs: 0,
      durationMs: 300
    });
    manifest.assets = ["assets/tone.wav", "assets/voice.wav"];
    await writeFile(voicePath, "fake voice wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-solo-track-audio.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath: musicPath,
      dryRun: true
    });
    expect((result as { ffmpeg?: { args?: string[] } }).ffmpeg?.args ?? []).toContain(musicPath);
    expect((result as { ffmpeg?: { args?: string[] } }).ffmpeg?.args ?? []).not.toContain(voicePath);
  });

  it("applies track volume gain to package audio layers when --audio is omitted", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({ trackId: "music-track", volume: 0.4 });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks = [
      { id: "music-track", type: "audio", name: "Music", volume: 0.5, layerIds: ["music"] }
    ];
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-track-volume-audio.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        volume: 0.2
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining(["-filter:a", "atrim=duration=0.3,volume=0.2,apad=whole_dur=0.3"])
      }
    });
  });

  it("refuses browser video-source audio but defers it for admitted GPU PCM staging", async () => {
    const packageRoot = await writeTinyPackageWithVideoLayer({ includeAudio: true, playbackRate: 1.5 });
    tempDirs.push(packageRoot);
    const videoPath = join(packageRoot, "assets", "clip.mp4");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-video-source-audio.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      error: {
        code: "unsafe_input_path",
        message: expect.stringContaining("WAV, FLAC, MP3, Ogg, or Opus")
      }
    });

    const gpu = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--frame-lane", "gpu",
      "--out", "/tmp/package-video-source-audio-gpu.mp4", "--dry-run"
    ]);
    expect(gpu).toMatchObject({ ok: true, command: "render", lane: "ffmpeg", frameLane: "gpu", dryRun: true,
      ffmpeg: { args: expect.arrayContaining(["-f", "rawvideo", "-i", "pipe:0"]) } });
    if (gpu.ok) expect((gpu.ffmpeg as { args: string[] }).args).not.toContain(videoPath);
  });

  it("plans package audio layer trim loop and volume controls for FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({
      trimStartMs: 250,
      trimDurationMs: 500,
      loop: true,
      volume: 0.35
    });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-controls.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        trimStartMs: 250,
        trimDurationMs: 500,
        loop: true,
        volume: 0.35
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=start=0.25:duration=0.5,asetpts=PTS-STARTPTS,aresample=48000,aloop=loop=-1:size=24000,atrim=duration=0.3,volume=0.35,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-audio-controls.mp4"
        ])
      }
    });
  });

  it("plans package audio layer start offsets for FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({
      startMs: 120,
      volume: 0.5
    });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-offset.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        startMs: 120,
        volume: 0.5
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.18,volume=0.5,adelay=120:all=1,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-audio-offset.mp4"
        ])
      }
    });
  });

  it("refuses included video source audio before applying its timeline offset", async () => {
    const packageRoot = await writeTinyPackageWithVideoLayer({ includeAudio: true, startMs: 90 });
    tempDirs.push(packageRoot);
    const videoPath = join(packageRoot, "assets", "clip.mp4");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-video-source-audio-offset.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      error: {
        code: "unsafe_input_path",
        message: expect.stringContaining("WAV, FLAC, MP3, Ogg, or Opus")
      }
    });
  });

  it("plans package audio layer volume keyframes for FFmpeg renders", async () => {
    const volumeKeyframes = [
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 500, value: 0.8 },
      { atMs: 1000, value: 0.2 }
    ];
    const packageRoot = await writeTinyPackageWithAudioLayer({
      keyframes: {
        volume: volumeKeyframes
      }
    });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-volume-keyframes.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        volumeKeyframes
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.3,volume='if(lt(t,0),0,if(lt(t,0.5),0+(0.8-0)*((t-0)/(0.5-0)),if(lt(t,1),0.8+(0.2-0.8)*((t-0.5)/(1-0.5)),0.2)))':eval=frame,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-audio-volume-keyframes.mp4"
        ])
      }
    });
  });

  it("plans package audio layer mute and fade controls for FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({
      muted: true,
      fadeInMs: 100,
      fadeOutMs: 150
    });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-fades.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        durationMs: 300,
        muted: true,
        fadeInMs: 100,
        fadeOutMs: 150
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.3,afade=t=in:st=0:d=0.1,afade=t=out:st=0.15:d=0.15,volume=0,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-audio-fades.mp4"
        ])
      }
    });
  });

  it("inherits timeline track fades for package audio layers in FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({ trackId: "music-track" });
    tempDirs.push(packageRoot);
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks = [
      { id: "music-track", type: "audio", name: "Music", fadeInMs: 120, fadeOutMs: 180, layerIds: ["music"] }
    ];
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-track-fades.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        durationMs: 300,
        fadeInMs: 120,
        fadeOutMs: 180
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.3,afade=t=in:st=0:d=0.12,afade=t=out:st=0.12:d=0.18,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-track-fades.mp4"
        ])
      }
    });
  });

  it("inherits timeline track pan for package audio layers in FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({ trackId: "music-track" });
    tempDirs.push(packageRoot);
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks = [
      { id: "music-track", type: "audio", name: "Music", pan: -0.25, layerIds: ["music"] }
    ];
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-track-pan.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        pan: -0.25
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.3,pan=stereo|c0=1*c0|c1=0.75*c1,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-track-pan.mp4"
        ])
      }
    });
  });

  it("plans package audio layer pan for FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({ pan: 0.35 });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-layer-pan.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        pan: 0.35
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.3,pan=stereo|c0=0.65*c0|c1=1*c1,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-audio-layer-pan.mp4"
        ])
      }
    });
  });

  it("plans package audio loudness normalization for FFmpeg renders", async () => {
    const packageRoot = await writeTinyPackageWithAudioLayer({
      normalizeLoudness: true
    });
    tempDirs.push(packageRoot);
    const audioPath = join(packageRoot, "assets", "tone.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-loudnorm.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioPath,
      audio: {
        path: audioPath,
        durationMs: 300,
        normalizeLoudness: true
      },
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          audioPath,
          "-filter:a",
          "atrim=duration=0.3,loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=0.3",
          "-t",
          "0.3",
          "/tmp/package-audio-loudnorm.mp4"
        ])
      }
    });
  });

  it("plans multiple package audio layers as a mixed FFmpeg audio graph", async () => {
    const packageRoot = await writeTinyPackageWithTwoAudioLayers();
    tempDirs.push(packageRoot);
    const musicPath = join(packageRoot, "assets", "music.wav");
    const voicePath = join(packageRoot, "assets", "voice.wav");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      "/tmp/package-audio-mix.mp4",
      "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      audioTracks: [
        { path: musicPath, startMs: 40, trimStartMs: 100, trimDurationMs: 250, loop: true, volume: 0.4 },
        { path: voicePath, startMs: 160, volume: 0.8 }
      ],
      dryRun: true,
      ffmpeg: {
        args: expect.arrayContaining([
          "-i",
          musicPath,
          "-i",
          voicePath,
          "-filter_complex",
          "[1:a]atrim=start=0.1:duration=0.25,asetpts=PTS-STARTPTS,aresample=48000,aloop=loop=-1:size=12000,atrim=duration=0.26,volume=0.4,adelay=40:all=1[a1];[2:a]atrim=duration=0.14,volume=0.8,adelay=160:all=1[a2];[a1][a2]amix=inputs=2:duration=longest:dropout_transition=0,apad=whole_dur=0.3[mixeda]",
          "-map",
          "0:v:0",
          "-map",
          "[mixeda]",
          "-t",
          "0.3",
          "/tmp/package-audio-mix.mp4"
        ])
      }
    });
  });

  it("renders native lane output to a PNG file", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-native-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "final.png");

    const result = await runCli(["render", fixtureRoot, "--lane", "native", "--out", outputPath]);
    const png = await readFile(outputPath);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "native",
      outputPath,
      // the text-delivery invariant: native preview of lowercase Inter text stays allowed but is reported degraded.
      receipt: { operation: "preview.frame", status: "warning", lane: "native" }
    });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("runs quality manifests as part of final still-frame renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-quality-manifest-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outDir, packageRoot);
    const outputPath = join(outDir, "final.png");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "still", atMs: 0 }]
    }, null, 2));

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-frame",
      "--frame-lane",
      "native",
      "--out",
      outputPath,
      "--quality-manifest",
      manifestPath
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "image",
      frameLane: "native",
      preset: "png-frame",
      outputPath,
      qualityManifestPath: manifestPath,
      qualityCheck: {
        ok: true,
        command: "quality-check",
        manifestPath,
        samples: [{ id: "still", ok: true }]
      },
      receipt: {
        operation: "render.final",
        status: "passed",
            inputHashes: {
              qualityManifest: expect.stringMatching(/^[a-f0-9]{64}$/),
              qualityManifestMaterialized: expect.stringMatching(/^[a-f0-9]{64}$/),
              qualityBaselines: expect.stringMatching(/^[a-f0-9]{64}$/),
              qualityInputs: expect.stringMatching(/^[a-f0-9]{64}$/)
            },
        output: {
          qualityManifestPath: manifestPath,
          qualityCheck: { status: "passed" }
        }
      }
    });
  });

  it("retains an explicit --keep-frames FFmpeg render through the legacy frame sequence", async () => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const outDir = await mkdtemp(join(sourceRoot, ".shellx-motion-cli-render-ffmpeg-"));
    const temporaryPackageRoot = await writeTinyNativePackage();
    const packageRoot = join(outDir, "package");
    await cp(temporaryPackageRoot, packageRoot, { recursive: true });
    tempDirs.push(outDir, temporaryPackageRoot);
    const outputPath = join(outDir, "final.mp4");
    const scratchRoot = join(outDir, "frames");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      // Hardware-encode probe (default on): report no compiled hardware encoders -> software path.
      if (command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.args.includes("-framerate")) await writeFile(command.args.at(-1) as string, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await withCliSourceWorkspaceAnchor(
      [packageRoot, outputPath, scratchRoot],
      async () => await runCli(["render", packageRoot, "--lane", "ffmpeg", "--out", outputPath, "--keep-frames"], {
        ffmpegRunner: runner,
        scratchRoot
      })
    );
    const firstFrame = await readFile(join(scratchRoot, "pkg_cli_ffmpeg_sequence", "000001.png"));
    const lastFrame = await readFile(join(scratchRoot, "pkg_cli_ffmpeg_sequence", "000003.png"));

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      outputPath,
      frameLane: "browser",
      receipt: {
        operation: "render.final",
        // `warning`, not `passed`: this 300ms fixture is below the product-review clip length AND
        // draws identical frames, and the receipt says both. Since the  unified status
        // rule, a render receipt escalates on an actionable warning instead of asserting success
        // alongside one.
        status: "warning",
        warnings: [
          "Rendered video is 300ms; product review clips should be at least 1500ms.",
          "Rendered frame sequence is static; verify this is intentional before using it as product output.",
          expect.stringContaining("Rendered motion is static for 100.0% of its duration")
        ],
        packageId: "pkg_cli_ffmpeg_sequence",
        lane: "ffmpeg"
      }
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "rendered_media", path: outputPath, status: "available", primary: true })
    ]));
    expect(JSON.stringify(result)).not.toContain(".shellx-motion-final-");
    // Command stream: ffmpeg -version (health), ffmpeg -encoders (hardware-encode probe, no GPU on
    // WSL so software is used), the encode itself, then the encode's delivered-colour readback
    // (`verifyDeliveredColor`, default-on under the current contract) reading back the private
    // staged file before it is published at the caller-selected final path.
    expect(commands).toHaveLength(4);
    expect(commands[3].args).toEqual(expect.arrayContaining(["-show_streams", commands[2].args.at(-1)]));
    expect(commands[1].args).toEqual(["-hide_banner", "-encoders"]);
    expect(commands[2]).toEqual({
      executable: resolveFfmpegExecutable(),
      args: [
        "-y",
        "-framerate",
        "10",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(scratchRoot, "pkg_cli_ffmpeg_sequence", "%06d.png"),
        "-frames:v",
        "3",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-movflags",
        "+faststart",
        expect.stringMatching(/\/\.shellx-motion-final-[a-f0-9]{32}-[0-9a-f-]{36}\.mp4$/)
      ],
      shell: false
    });
    expect(commands[2].args).not.toContain(outputPath);
    expect(firstFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(lastFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }, 45_000);

  it("replays browser workflow evidence during ffmpeg final renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-ffmpeg-workflow-"));
    const packageRoot = await writeTinyNativePackage();
    const outputPath = join(outDir, "final.mp4");
    const scratchRoot = join(outDir, "frames");
    const workflowPath = join(outDir, "workflow.json");
    const commands: FfmpegCommand[] = [];
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 5 },
        { action: "scroll", y: 10 }
      ],
      cursor: { visible: true, path: [{ x: 8, y: 8, atMs: 0 }] }
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.args.includes("-framerate")) await writeFile(command.args.at(-1) as string, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await runCli(["render", packageRoot, "--lane", "ffmpeg", "--out", outputPath, "--workflow", workflowPath], {
      ffmpegRunner: runner,
      scratchRoot
    });

    expect(result).toMatchObject({
      ok: true,
      command: "render",
      lane: "ffmpeg",
      frameLane: "browser",
      workflowPath,
      workflow: {
        schema: "shellx-motion/browser-workflow@1",
        networkPolicy: "blocked-unless-declared",
        stepCount: 2,
        cursor: { visible: true, pointCount: 1 }
      },
      workflowTrace: {
        schema: "shellx-motion/browser-workflow-trace@1",
        workflowHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        stepCount: 2,
        steps: [
          { index: 0, action: { action: "wait", ms: 5 }, status: "passed" },
          { index: 1, action: { action: "scroll", x: 0, y: 10 }, status: "passed" }
        ]
      },
      receipt: {
        operation: "render.final",
        inputHashes: {
          workflow: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        output: {
          workflow: { stepCount: 2 },
          workflowTrace: {
            stepCount: 2,
            steps: [
              { index: 0, action: { action: "wait", ms: 5 }, status: "passed" },
              { index: 1, action: { action: "scroll", x: 0, y: 10 }, status: "passed" }
            ]
          }
        }
      }
    });
    // -version (health) + -encoders (hardware probe, no GPU) + encode + delivered-colour readback.
    expect(commands).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain('"text"');
  }, 45_000);

  it("catalogs final render browser workflow evidence and reports drift", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-workflow-catalog-"));
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outDir, "workflow.json");
    const catalogPath = join(outDir, "render-workflows.catalog.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [{ action: "wait", ms: 5 }],
      cursor: { visible: false }
    }, null, 2));
    const renderWithFrameBackedOutput = async (packageRootArg: string, outputPath: string, scratchRoot: string) => {
      const runner: FfmpegRunner = async (command) => {
        if (command.args[0] === "-version") {
          return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
        }
        if (command.args.includes("-encoders")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const inputIndex = command.args.indexOf("-i");
        const framePattern = String(command.args[inputIndex + 1]);
        const firstFrame = await readFile(join(dirname(framePattern), "000001.png"));
        if (command.args.includes("-framerate")) await writeFile(command.args.at(-1) as string, firstFrame);
        return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
      };
      return runCli([
        "render",
        packageRootArg,
        "--lane",
        "ffmpeg",
        "--out",
        outputPath,
        "--workflow",
        workflowPath,
        "--catalog",
        catalogPath,
        // All outputs in this catalog test share one package-derived receipt path. Replacement is
        // therefore explicit even though the media output filename differs for each invocation.
        "--force"
      ], {
        ffmpegRunner: runner,
        scratchRoot
      });
    };

    const first = await renderWithFrameBackedOutput(packageRoot, join(outDir, "first.mp4"), join(outDir, "frames-first"));
    const second = await renderWithFrameBackedOutput(packageRoot, join(outDir, "second.mp4"), join(outDir, "frames-second"));
    await rewriteTinyNativePackageTitle(packageRoot, "Catalog drift");
    const changed = await renderWithFrameBackedOutput(packageRoot, join(outDir, "changed.mp4"), join(outDir, "frames-changed"));
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;
    const changedReceipt = JSON.parse(await readFile(String(changed.receiptPath), "utf8")) as Record<string, any>;
    const firstOutput = first.output as { sha256: string };
    const secondOutput = second.output as { sha256: string };
    const changedOutput = changed.output as { sha256: string };

    expect(first).toMatchObject({
      ok: true,
      command: "render",
      workflowCatalogPath: catalogPath,
      workflowDrift: { status: "new" },
      receiptPath: join(outDir, "pkg_cli_ffmpeg_sequence-render.receipt.json"),
      receipt: {
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "render_receipt", path: join(outDir, "pkg_cli_ffmpeg_sequence-render.receipt.json"), status: "available", mediaType: "application/json" })
        ])
      }
    });
    expect(second).toMatchObject({
      ok: true,
      command: "render",
      workflowCatalogPath: catalogPath,
      workflowDrift: {
        status: "matched",
        baselineOutputSha256: firstOutput.sha256,
        currentOutputSha256: secondOutput.sha256
      }
    });
    expect(changed).toMatchObject({
      ok: true,
      command: "render",
      workflowCatalogPath: catalogPath,
      workflowDrift: {
        status: "changed",
        baselineOutputSha256: firstOutput.sha256,
        previousOutputSha256: secondOutput.sha256,
        currentOutputSha256: changedOutput.sha256
      },
      warnings: expect.arrayContaining([expect.stringContaining("Browser workflow drift detected")])
    });
    expect(catalog).toMatchObject({
      schema: "shellx-motion/browser-workflow-catalog@1",
      entries: [
        {
          packageId: "pkg_cli_ffmpeg_sequence",
          baseline: { outputSha256: firstOutput.sha256 },
          latest: { outputSha256: changedOutput.sha256 },
          drift: {
            status: "changed",
            currentOutputSha256: changedOutput.sha256
          },
          history: [
            { outputSha256: firstOutput.sha256 },
            { outputSha256: secondOutput.sha256 },
            { outputSha256: changedOutput.sha256 }
          ]
        }
      ]
    });
    expect(changedReceipt.output).not.toHaveProperty("workflowCatalogPath");
    expect(changedReceipt.output).not.toHaveProperty("workflowDrift");
    expect(changedReceipt.artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath })
    ]));
    expect(changedReceipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "render_receipt", path: String(changed.receiptPath) })
    ]));
  }, 45_000);

  it("can fail final renders on browser workflow catalog drift", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-workflow-drift-fail-"));
    const packageRoot = await writeTinyNativePackage();
    const workflowPath = join(outDir, "workflow.json");
    const catalogPath = join(outDir, "render-workflows.catalog.json");
    tempDirs.push(outDir, packageRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      steps: [{ action: "wait", ms: 5 }]
    }, null, 2));
    const renderWithFrameBackedOutput = async (outputPath: string, scratchRoot: string, extraArgs: string[] = []) => {
      const runner: FfmpegRunner = async (command) => {
        if (command.args[0] === "-version") {
          return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
        }
        if (command.args.includes("-encoders")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const inputIndex = command.args.indexOf("-i");
        const framePattern = String(command.args[inputIndex + 1]);
        if (command.args.includes("-framerate")) await writeFile(command.args.at(-1) as string, await readFile(join(dirname(framePattern), "000001.png")));
        return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
      };
      return runCli([
        "render",
        packageRoot,
        "--lane",
        "ffmpeg",
        "--out",
        outputPath,
        "--workflow",
        workflowPath,
        "--catalog",
        catalogPath,
        // A changed workflow records a new receipt at the package-derived sibling path only with
        // the same explicit overwrite authority as a corresponding output replacement.
        "--force",
        ...extraArgs
      ], {
        ffmpegRunner: runner,
        scratchRoot
      });
    };

    await renderWithFrameBackedOutput(join(outDir, "baseline.mp4"), join(outDir, "frames-baseline"));
    await rewriteTinyNativePackageTitle(packageRoot, "Render drift fail");
    const result = await renderWithFrameBackedOutput(join(outDir, "changed.mp4"), join(outDir, "frames-changed"), ["--fail-on-drift"]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      workflowCatalogPath: catalogPath,
      workflowDrift: { status: "changed" },
      error: {
        code: "browser_workflow_drift_detected",
        message: expect.stringContaining("Browser workflow drift detected")
      }
    });
    await expect(stat(join(outDir, "changed.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;
    expect(catalog.entries[0].history).toHaveLength(1);
  }, 45_000);

  it("fails ffmpeg renders when the requested unique-frame quality gate is not met", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-static-gate-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outDir, packageRoot);
    const outputPath = join(outDir, "final.mp4");
    const scratchRoot = join(outDir, "frames");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
    };

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      outputPath,
      "--min-unique-frames",
      "2"
    ], {
      ffmpegRunner: runner,
      scratchRoot
    });

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      frameLane: "browser",
      error: {
        code: "frame_quality_failed",
        message: "Rendered frame sequence has 1 unique frame; expected at least 2."
      },
    });
    expect(commands).toHaveLength(2);
    expect(commands[0].args).toEqual(["-version"]);
    expect(commands[1].args).toContain("-encoders");
  }, 45_000);

  it("fails PNG sequence renders when the requested unique-frame quality gate is not met", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-png-sequence-static-gate-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outDir, packageRoot);
    const outputPath = join(outDir, "frames");

    const result = await runCli([
      "render",
      packageRoot,
      "--lane",
      "ffmpeg",
      "--preset",
      "png-sequence",
      "--out",
      outputPath,
      "--min-unique-frames",
      "2"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "image-sequence",
      frameLane: "browser",
      error: {
        code: "frame_quality_failed",
        message: "Rendered frame sequence has 1 unique frame; expected at least 2."
      },
      frames: { dir: outputPath, count: 3 },
      frameReceipt: {
        output: {
          renderSession: {
            browserLaunches: 1,
            framesRendered: 3,
            contextsCreated: 2,
            pagesCreated: 2,
            activeFrames: 0,
            peakConcurrentFrames: 2,
            frameCacheHits: 0,
            frameRetries: 0
          }
        }
      }
    });
  }, 45_000);

  it("checks final MP4 media facts and extracted frame quality", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-check-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
            format: { duration: "4.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--expect-width",
      "1920",
      "--expect-height",
      "1080",
      "--min-bright-pixels",
      "1"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      inputPath,
      media: {
        path: inputPath,
        codec: "h264",
        width: 1920,
        height: 1080,
        durationMs: 4000,
        fps: 30,
        container: "mov,mp4,m4a,3gp,3g2,mj2"
      },
      quality: {
        frameCount: 1,
        blankFrames: 0,
        minBrightPixels: expect.any(Number),
        maxBrightPixels: expect.any(Number),
        minLumaRange: expect.any(Number),
        maxLumaRange: expect.any(Number)
      },
      warnings: []
    });
    expect(String(result.framePath)).toMatch(/final-frame\.png$/);
    expect(commands).toHaveLength(2);
    expect(isFfprobeCommand(commands[0])).toBe(true);
    expect(commands[1]).toMatchObject({
      executable: resolveFfmpegExecutable(),
      args: ["-y", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", inputPath, "-frames:v", "1", String(result.framePath)],
      shell: false
    });
  });

  it("checks final media audio stream presence when requested", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-audio-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-audio.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--expect-audio"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      media: {
        audio: {
          present: true,
          streamCount: 1,
          streams: [{ codec: "aac", channels: 2, sampleRate: 48000, durationMs: 1000 }]
        }
      }
    });
  });

  it("checks final media audio peak level when requested", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-audio-level-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-muted.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -91.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -91.0 dB"
          ].join("\n")
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--expect-audio",
      "--max-audio-peak-db",
      "-60"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      audioLevels: {
        sampleCount: 48128,
        meanVolumeDb: -91,
        maxVolumeDb: -91
      }
    });
  });

  it("enforces LUFS, true-peak, and loudness-range CLI policies", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-loudness-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-audio.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48000",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -20.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -2.0 dB",
            "{\"input_i\":\"-23.0\",\"input_tp\":\"-0.5\",\"input_lra\":\"14.0\",\"input_thresh\":\"-33.0\",\"target_offset\":\"0.0\"}"
          ].join("\n")
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const options = { ffmpegRunner: runner, scratchRoot: join(outDir, "scratch") };

    const passed = await runCli([
      "quality-check",
      inputPath,
      "--min-audio-lufs", "-24",
      "--max-audio-lufs", "-22",
      "--max-audio-true-peak-dbtp", "-0.1",
      "--max-audio-lra-lu", "15"
    ], options);
    expect(passed).toMatchObject({
      ok: true,
      audioLevels: {
        integratedLoudnessLufs: -23,
        truePeakDbtp: -0.5,
        loudnessRangeLu: 14,
        loudnessComplete: true
      }
    });

    const failures: Array<{ args: string[]; message: string }> = [
      { args: ["--min-audio-lufs", "-22"], message: "Integrated loudness is -23 LUFS; expected at least -22 LUFS." },
      { args: ["--max-audio-lufs", "-24"], message: "Integrated loudness is -23 LUFS; expected at most -24 LUFS." },
      { args: ["--max-audio-true-peak-dbtp", "-1"], message: "Audio true peak is -0.5 dBTP; expected at most -1 dBTP." },
      { args: ["--max-audio-lra-lu", "10"], message: "Loudness range is 14 LU; expected at most 10 LU." }
    ];
    for (const failure of failures) {
      expect(await runCli(["quality-check", inputPath, ...failure.args], options)).toMatchObject({
        ok: false,
        error: { code: "audio_quality_failed", message: failure.message }
      });
    }

    const missingLoudnessRunner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) return runner(command);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "[Parsed_volumedetect_0 @ 0x123] max_volume: -2.0 dB"
      };
    };
    expect(await runCli([
      "quality-check", inputPath, "--min-audio-lufs", "-24"
    ], { ffmpegRunner: missingLoudnessRunner, scratchRoot: join(outDir, "scratch-missing") })).toMatchObject({
      ok: false,
      error: { code: "audio_quality_failed", message: "Could not measure integrated loudness." }
    });
  });

  it("rejects contradictory and negative loudness CLI policies before probing media", async () => {
    const runner: FfmpegRunner = async () => {
      throw new Error("runner must not be called");
    };
    expect(await runCli([
      "quality-check", "/tmp/final.mp4", "--min-audio-lufs", "-16", "--max-audio-lufs", "-24"
    ], { ffmpegRunner: runner })).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "--min-audio-lufs must be less than or equal to --max-audio-lufs." }
    });
    expect(await runCli([
      "quality-check", "/tmp/final.mp4", "--max-audio-lra-lu", "-1"
    ], { ffmpegRunner: runner })).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "--max-audio-lra-lu must be a non-negative number." }
    });
  });

  it("fails quality-check when final media audio peak is too loud", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-audio-level-fail-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-loud.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -18.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -12.0 dB"
          ].join("\n")
        };
      }
      throw new Error(`unexpected command: ${command.args.join(" ")}`);
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--max-audio-peak-db",
      "-60"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      audioLevels: {
        maxVolumeDb: -12
      },
      error: {
        code: "audio_quality_failed",
        message: "Audio peak is -12 dB; expected at most -60 dB."
      }
    });
  });

  it("fails quality-check when final media audio peak is below the audible threshold", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-audio-too-quiet-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-too-quiet.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -78.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -72.0 dB"
          ].join("\n")
        };
      }
      throw new Error(`unexpected command: ${command.args.join(" ")}`);
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--expect-audio",
      "--min-audio-peak-db",
      "-50"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      audioLevels: {
        maxVolumeDb: -72
      },
      error: {
        code: "audio_quality_failed",
        message: "Audio peak is -72 dB; expected at least -50 dB."
      }
    });
  });

  it("fails quality-check when final media average audio is below the dialogue threshold", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-audio-mean-too-low-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-low-mean.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -44.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -18.0 dB"
          ].join("\n")
        };
      }
      throw new Error(`unexpected command: ${command.args.join(" ")}`);
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--expect-audio",
      "--min-audio-mean-db",
      "-30"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      audioLevels: {
        meanVolumeDb: -44
      },
      error: {
        code: "audio_quality_failed",
        message: "Audio mean is -44 dB; expected at least -30 dB."
      }
    });
  });

  it("fails quality-check when expected audio is missing", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-audio-missing-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "silent.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--expect-audio"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      media: { audio: { present: false, streamCount: 0, streams: [] } },
      error: {
        code: "audio_quality_failed",
        message: "Expected at least one audio stream, but media has none."
      }
    });
  });

  it("fails quality-check when the extracted frame has too little visible structure", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-check-edges-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "flat.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, BLACK_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--min-edge-pixels",
      "1"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      error: {
        code: "visual_quality_failed",
        message: "Extracted frame has 0 edge pixels; expected at least 1."
      },
      quality: {
        minEdgePixels: 0,
        maxEdgePixels: 0
      }
    });
  });

  it("fails quality-check when an overlay frame loses required transparency", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-check-alpha-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "overlay.webm");
    await writeFile(inputPath, "fake webm bytes", "utf8");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "vp9", pix_fmt: "yuv420p", tags: { alpha_mode: "1" }, width: 2, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "matroska,webm" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, ALPHA_2X2_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--min-transparent-pixels",
      "3",
      "--min-non-transparent-pixels",
      "2"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      error: {
        code: "visual_quality_failed",
        message: "Extracted frame has 2 transparent pixels; expected at least 3."
      },
      quality: {
        minTransparentPixels: 2,
        maxTransparentPixels: 2,
        minNonTransparentPixels: 2,
        maxNonTransparentPixels: 2
      }
    });
    expect(commands[1].args).toEqual([
      "-y",
      "-c:v",
      "libvpx-vp9",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "matroska",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      join(outDir, "scratch", "quality", "overlay-frame.png")
    ]);
  });

  it("checks final MP4 quality at a requested representative timestamp", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-check-at-ms-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "keyframed.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "30/1" }],
            format: { duration: "3.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--at-ms",
      "1500",
      "--expect-width",
      "1280",
      "--expect-height",
      "720",
      "--min-bright-pixels",
      "1"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      atMs: 1500,
      media: { width: 1280, height: 720 }
    });
    expect(commands[1]).toMatchObject({
      executable: resolveFfmpegExecutable(),
      args: ["-y", "-ss", "1.5", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", inputPath, "-frames:v", "1", String(result.framePath)],
      shell: false
    });
  });

  it("compares extracted final media frames against a visual baseline", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-baseline-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, CONTRAST_PNG);
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--baseline",
      baselinePath,
      "--max-changed-pixels",
      "0",
      "--max-mean-diff",
      "0"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      baselinePath,
      visualDiff: {
        ok: true,
        width: 2,
        height: 1,
        pixels: 2,
        changedPixels: 0,
        changedRatio: 0,
        meanAbsoluteError: 0,
        meanSquaredError: 0,
        rootMeanSquaredError: 0,
        psnrDb: null,
        ssim: 1,
        maxChannelDelta: 0
      }
    });
  });

  it("compares extracted final media frames against rendered package preview frames", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-preview-parity-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outDir, packageRoot);
    const inputPath = join(outDir, "final.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const preview = await runCli(["preview", packageRoot, "--lane", "browser", "--out", join(outDir, "baseline-preview"), "--at-ms", "100"]);
    const previewPng = await readFile(String(preview.outputPath));
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 64, height: 36, avg_frame_rate: "10/1" }],
            format: { duration: "0.300000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, previewPng);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const previousUmask = process.umask(0o002);
    let result: Awaited<ReturnType<typeof runCli>>;
    try {
      result = await runCli([
        "quality-check",
        inputPath,
        "--at-ms",
        "100",
        "--preview-package",
        packageRoot,
        "--preview-lane",
        "browser",
        "--max-changed-pixels",
        "0",
        "--max-mean-diff",
        "0"
      ], {
        ffmpegRunner: runner,
        scratchRoot: join(outDir, "scratch")
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      atMs: 100,
      preview: {
        packageRoot,
        lane: "browser",
        atMs: 100,
        framePath: expect.stringContaining("final-preview-100.png")
      },
      visualDiff: {
        ok: true,
        changedPixels: 0,
        meanAbsoluteError: 0
      }
    });
    expect(commands.filter(isFfmpegCommand)).toEqual([
      expect.objectContaining({ args: ["-y", "-ss", "0.1", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", inputPath, "-frames:v", "1", String(result.framePath)] })
    ]);
    expect((await stat(join(outDir, "scratch", "quality"))).mode & 0o777).toBe(0o700);
  });

  it("compares visual baselines by RGB only when alpha differs from encoded media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-rgb-only-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, rgbaPng(1, 1, [[16, 32, 64, 0]]));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 1, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, rgbaPng(1, 1, [[16, 32, 64, 255]]));
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--baseline",
      baselinePath,
      "--compare-rgb-only",
      "--max-changed-pixels",
      "0",
      "--max-mean-diff",
      "0"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      visualDiff: {
        ok: true,
        changedPixels: 0,
        meanAbsoluteError: 0
      }
    });
  });

  it("lets quality manifest samples compare visual baselines by RGB only", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-rgb-only-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "overlay.webm");
    const baselinePath = join(outDir, "baseline.png");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake webm bytes", "utf8");
    await writeFile(baselinePath, rgbaPng(1, 1, [[16, 32, 64, 0]]));
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        {
          id: "overlay_rgb",
          atMs: 0,
          baseline: "baseline.png",
          compareAlpha: false,
          maxChangedPixels: 0,
          maxMeanDiff: 0
        }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "vp9", width: 1, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "matroska,webm" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, rgbaPng(1, 1, [[16, 32, 64, 255]]));
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      manifestPath,
      samples: [
        {
          id: "overlay_rgb",
          ok: true,
          baselinePath,
          compareAlpha: false,
          visualDiff: {
            ok: true,
            changedPixels: 0,
            meanAbsoluteError: 0
          }
        }
      ]
    });
  });

  it("fails quality-check when final media exceeds visual baseline thresholds", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-baseline-fail-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, BLACK_2X1_PNG);
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--baseline",
      baselinePath,
      "--max-changed-pixels",
      "0",
      "--max-mean-diff",
      "0"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      baselinePath,
      error: {
        code: "visual_regression_failed",
        message: expect.stringContaining("changed pixels")
      },
      visualDiff: {
        ok: true,
        changedPixels: expect.any(Number),
        maxChannelDelta: expect.any(Number)
      }
    });
  });

  it("fails quality-check when visual PSNR is below threshold", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-psnr-fail-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, BLACK_2X1_PNG);
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--baseline",
      baselinePath,
      "--max-changed-pixels",
      "2",
      "--max-mean-diff",
      "255",
      "--min-psnr-db",
      "20"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      baselinePath,
      error: {
        code: "visual_regression_failed",
        message: expect.stringContaining("PSNR")
      },
      visualDiff: {
        ok: true,
        psnrDb: expect.any(Number)
      }
    });
  });

  it("fails quality-check when visual SSIM is below threshold", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-ssim-fail-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, BLACK_2X1_PNG);
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--baseline",
      baselinePath,
      "--max-changed-pixels",
      "2",
      "--max-mean-diff",
      "255",
      "--min-ssim",
      "0.9"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      baselinePath,
      error: {
        code: "visual_regression_failed",
        message: expect.stringContaining("SSIM")
      },
      visualDiff: {
        ok: true,
        ssim: expect.any(Number)
      }
    });
  });

  it("checks a final media visual quality manifest across representative timestamps", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, CONTRAST_PNG);
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "start", atMs: 0, baseline: "baseline.png", minBrightPixels: 1, minLumaRange: 200, maxChangedPixels: 0, maxMeanDiff: 0, minSsim: 0.99 },
        { id: "mid", atMs: 500, baseline: "baseline.png", minBrightPixels: 1, minLumaRange: 200, maxChangedPixels: 0, maxMeanDiff: 0, minSsim: 0.99 }
      ]
    }, null, 2));
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath,
      "--expect-width",
      "2",
      "--expect-height",
      "1"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      manifestPath,
      samples: [
        { id: "start", atMs: 0, ok: true, baselinePath, quality: { minLumaRange: 255 }, visualDiff: { ok: true, changedPixels: 0, ssim: 1 } },
        { id: "mid", atMs: 500, ok: true, baselinePath, quality: { minLumaRange: 255 }, visualDiff: { ok: true, changedPixels: 0, ssim: 1 } }
      ]
    });
    expect(commands.filter(isFfmpegCommand)).toEqual([
      expect.objectContaining({ args: ["-y", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", inputPath, "-frames:v", "1", expect.stringContaining("final-start-frame.png")] }),
      expect.objectContaining({ args: ["-y", "-ss", "0.5", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", inputPath, "-frames:v", "1", expect.stringContaining("final-mid-frame.png")] })
    ]);

    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "flatness-gate", atMs: 0, minLumaRange: 256 }]
    }, null, 2));
    expect(await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch-luma-failure")
    })).toMatchObject({
      ok: false,
      error: {
        code: "visual_quality_failed",
        message: "Quality manifest sample flatness-gate failed: Extracted frame has luma range 255; expected at least 256."
      }
    });
  });

  it("enforces chroma richness and visible motion between manifest samples", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-motion-manifest-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    const firstFrame = rgbaPng(2, 1, [[0, 96, 192, 255], [16, 16, 16, 255]]);
    const secondFrame = rgbaPng(2, 1, [[192, 96, 0, 255], [16, 16, 16, 255]]);
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "establish", atMs: 0, minChromaPixels: 1 },
        { id: "move", atMs: 500, minChromaPixels: 1, minChangedPixelsFromPrevious: 1, minMeanDiffFromPrevious: 1 }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, outputPath.includes("-move-frame") ? secondFrame : firstFrame);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli(["quality-check", inputPath, "--manifest", manifestPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      samples: [
        { id: "establish", ok: true, quality: { minChromaPixels: 1 } },
        {
          id: "move",
          ok: true,
          quality: { minChromaPixels: 1 },
          previousSampleId: "establish",
          motionDiff: { ok: true, changedPixels: 1, meanAbsoluteError: 48 }
        }
      ]
    });

    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "establish", atMs: 0 },
        { id: "move", atMs: 500, minChangedPixelsFromPrevious: 2 }
      ]
    }, null, 2));
    expect(await runCli(["quality-check", inputPath, "--manifest", manifestPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch-failure")
    })).toMatchObject({
      ok: false,
      error: {
        code: "motion_quality_failed",
        message: expect.stringContaining("expected at least 2")
      },
      samples: [
        { id: "establish", ok: true },
        { id: "move", ok: false, previousSampleId: "establish", motionDiff: { ok: true, changedPixels: 1 } }
      ]
    });
  });

  it("preserves CLI audio policy evidence when checking a visual quality manifest", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-cli-audio-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-with-audio.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      audio: {
        minIntegratedLoudnessLufs: -24,
        maxIntegratedLoudnessLufs: -18,
        maxTruePeakDbtp: -1,
        maxLoudnessRangeLu: 12
      },
      samples: [
        { id: "start", atMs: 0, minBrightPixels: 1 }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -20.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -12.0 dB",
            "{\"input_i\":\"-20.0\",\"input_tp\":\"-2.0\",\"input_lra\":\"8.0\",\"input_thresh\":\"-30.0\",\"target_offset\":\"0.0\"}"
          ].join("\n")
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath,
      "--expect-audio",
      "--min-audio-peak-db",
      "-50",
      "--min-audio-mean-db",
      "-40"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      manifestPath,
      audioLevels: {
        maxVolumeDb: -12,
        meanVolumeDb: -20,
        integratedLoudnessLufs: -20,
        truePeakDbtp: -2,
        loudnessRangeLu: 8
      },
      samples: [
        { id: "start", ok: true }
      ]
    });
  });

  it("fails quality-check when manifest audio policy detects inaudible final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-audio-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final-too-quiet.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      audio: { expect: true, minPeakDb: -50, minMeanDb: -40 },
      samples: [
        { id: "start", atMs: 0, minBrightPixels: 1 }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
            "[Parsed_volumedetect_0 @ 0x123] mean_volume: -78.0 dB",
            "[Parsed_volumedetect_0 @ 0x123] max_volume: -72.0 dB"
          ].join("\n")
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      manifestPath,
      audioLevels: {
        maxVolumeDb: -72,
        meanVolumeDb: -78
      },
      error: {
        code: "audio_quality_failed",
        message: "Audio peak is -72 dB; expected at least -50 dB."
      }
    });
  });

  it("checks final media samples against rendered package preview frames", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-preview-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outDir, packageRoot);
    const inputPath = join(outDir, "final.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "start", atMs: 0, maxChangedPixels: 0, maxMeanDiff: 0 },
        { id: "mid", atMs: 100, maxChangedPixels: 0, maxMeanDiff: 0 }
      ]
    }, null, 2));
    const previewStart = await runCli([
      "preview",
      packageRoot,
      "--lane",
      "browser",
      "--out",
      join(outDir, "baseline-preview-start"),
      "--at-ms",
      "0"
    ]);
    const previewMid = await runCli([
      "preview",
      packageRoot,
      "--lane",
      "browser",
      "--out",
      join(outDir, "baseline-preview-mid"),
      "--at-ms",
      "100"
    ]);
    const previewStartPng = await readFile(String(previewStart.outputPath));
    const previewMidPng = await readFile(String(previewMid.outputPath));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 64, height: 36, avg_frame_rate: "10/1" }],
            format: { duration: "0.300000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, String(command.args.at(-1)).includes("-mid-") ? previewMidPng : previewStartPng);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const previousUmask = process.umask(0o002);
    let result: Awaited<ReturnType<typeof runCli>>;
    try {
      result = await runCli([
        "quality-check",
        inputPath,
        "--manifest",
        manifestPath,
        "--preview-package",
        packageRoot,
        "--preview-lane",
        "browser"
      ], {
        ffmpegRunner: runner,
        scratchRoot: join(outDir, "scratch")
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      manifestPath,
      samples: [
        {
          id: "start",
          atMs: 0,
          ok: true,
          preview: { packageRoot, lane: "browser", atMs: 0 },
          visualDiff: { ok: true, changedPixels: 0, meanAbsoluteError: 0 }
        },
        {
          id: "mid",
          atMs: 100,
          ok: true,
          preview: { packageRoot, lane: "browser", atMs: 100 },
          visualDiff: { ok: true, changedPixels: 0, meanAbsoluteError: 0 }
        }
      ]
    });
    expect((await stat(join(outDir, "scratch", "quality"))).mode & 0o777).toBe(0o700);
  }, 45_000);

  it("checks quality manifest regions for typography/layout structure", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-region-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        {
          id: "lower_third",
          atMs: 0,
          minEdgePixels: 1,
          regions: [
            { id: "title_safe", x: 2, y: 0, width: 2, height: 2, minDarkPixels: 2, minBrightPixels: 2, minEdgePixels: 2 }
          ]
        }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 4, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, STRUCTURED_4X2_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      samples: [
        {
          id: "lower_third",
          ok: true,
          quality: { minDarkPixels: 6, minEdgePixels: 2 },
          regions: [
            { id: "title_safe", ok: true, quality: { minDarkPixels: 2, minBrightPixels: 2, minEdgePixels: 2 } }
          ]
        }
      ]
    });
  });

  it("checks quality manifest alpha coverage for transparent overlay regions", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-alpha-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "overlay.webm");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake webm bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        {
          id: "overlay",
          atMs: 0,
          minTransparentPixels: 2,
          minNonTransparentPixels: 2,
          regions: [
            { id: "full_alpha", x: 0, y: 0, width: 2, height: 2, minTransparentPixels: 2, minNonTransparentPixels: 2 }
          ]
        }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "vp9", width: 2, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "matroska,webm" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, ALPHA_2X2_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "quality-check",
      samples: [
        {
          id: "overlay",
          ok: true,
          quality: { minTransparentPixels: 2, minNonTransparentPixels: 2 },
          regions: [
            { id: "full_alpha", ok: true, quality: { minTransparentPixels: 2, minNonTransparentPixels: 2 } }
          ]
        }
      ]
    });
  });

  it("fails quality-check when a manifest region loses typography/layout structure", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-region-fail-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        {
          id: "lower_third",
          atMs: 0,
          regions: [
            { id: "title_safe", x: 2, y: 0, width: 2, height: 2, minDarkPixels: 3 }
          ]
        }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 4, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, STRUCTURED_4X2_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      error: {
        code: "visual_quality_failed",
        message: expect.stringContaining("manifest sample lower_third")
      },
      samples: [
        {
          id: "lower_third",
          ok: false,
          regions: [
            {
              id: "title_safe",
              ok: false,
              error: {
                code: "visual_quality_failed",
                message: "Region title_safe has 2 dark pixels; expected at least 3."
              }
            }
          ]
        }
      ]
    });
  });

  it("fails quality-check when any quality manifest sample regresses", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-manifest-fail-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "final.mp4");
    const baselinePath = join(outDir, "baseline.png");
    const manifestPath = join(outDir, "quality-manifest.json");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    await writeFile(baselinePath, BLACK_2X1_PNG);
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "start", atMs: 0, baseline: "baseline.png", minBrightPixels: 1, maxChangedPixels: 0, maxMeanDiff: 0 }
      ]
    }, null, 2));
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--manifest",
      manifestPath
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      manifestPath,
      samples: [
        {
          id: "start",
          ok: false,
          baselinePath,
          error: { code: "visual_regression_failed" },
          visualDiff: { ok: true, changedPixels: expect.any(Number) }
        }
      ],
      error: {
        code: "visual_regression_failed",
        message: expect.stringContaining("manifest sample start")
      }
    });
  });

  it("fails quality-check when the extracted frame is below the bright-pixel threshold", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-quality-check-dark-"));
    tempDirs.push(outDir);
    const inputPath = join(outDir, "dark.mp4");
    await writeFile(inputPath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
            format: { duration: "4.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args.at(-1) as string, BLACK_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli([
      "quality-check",
      inputPath,
      "--min-bright-pixels",
      "1100"
    ], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "scratch")
    });

    expect(result).toMatchObject({
      ok: false,
      command: "quality-check",
      error: {
        code: "visual_quality_failed",
        message: "Extracted frame has 0 bright pixels; expected at least 1100."
      },
      quality: {
        frameCount: 1,
        blankFrames: 1,
        minBrightPixels: 0,
        maxBrightPixels: 0
      }
    });
  });

  it("plans batch/data renders without invoking FFmpeg in dry-run mode", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-dry-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, unknown>;
    const adaMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_ada", "motion.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      packageId: "pkg_batch_card",
      jobs: [
        { rowId: "ada", packageId: "pkg_batch_card_ada", status: "not_run" },
        { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run" }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      packageId: "pkg_batch_card",
      lane: "batch"
    });
    expect(adaMotion.layers[1].text).toBe("Hello Ada");
  });

  it("copies the declared quality-manifest sidecar into every expanded batch package", async () => {
    // Regression: writeExpandedPackage copied manifest/motion/template/assets but NOT template
    // sidecars, so an expanded package whose template declares qualityTargets.manifest failed
    // assertTemplatePackageSemantics when loaded back. Once every promoted family declared a
    // quality manifest, that broke render-batch for the entire product pack with an uncaught
    // throw. batch-card declares no qualityTargets, which is why the existing tests missed it.
    const sourceRoot = resolve("../../templates/shellx-product-pack/product-metric-card");
    const template = JSON.parse(await readFile(join(sourceRoot, "template.json"), "utf8")) as Record<string, any>;
    const manifestRef = template.metadata?.qualityTargets?.manifest as string | undefined;
    expect(manifestRef, "source template must declare a quality manifest for this regression").toBeTruthy();

    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-sidecar-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--dry-run"]);
    expect(result).toMatchObject({ ok: true, command: "render-batch", dryRun: true });

    const jobs = (result as unknown as { jobs: Array<{ packageId: string }> }).jobs;
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      const sidecarPath = join(outDir, "packages", job.packageId, manifestRef!);
      await expect(
        readFile(sidecarPath, "utf8"),
        `expanded package ${job.packageId} must carry ${manifestRef}`
      ).resolves.toBeTruthy();
    }
  });

  it("plans selected batch/data rows in dry-run mode", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-row-filter-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--row-id", "grace", "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const graceMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_grace", "motion.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      packageId: "pkg_batch_card",
      rows: 1,
      jobs: [
        { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run" }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      packageId: "pkg_batch_card",
      output: {
        rows: 1,
        jobs: [
          { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run" }
        ]
      }
    });
    expect(graceMotion.layers[1].text).toBe("Hello Grace");
    await expect(readFile(join(outDir, "packages", "pkg_batch_card_ada", "motion.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing batch/data row selections", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-row-missing-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--row-id", "missing", "--dry-run"]);

    expect(result).toMatchObject({
      ok: false,
      command: "render-batch",
      error: {
        code: "invalid_args",
        message: "Motion data row IDs not found: missing.",
        detail: {
          requestedRowIds: ["missing"],
          missingRowIds: ["missing"]
        }
      }
    });
  });

  it("plans batch/data renders with the selected export preset", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-preset-dry-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--preset", "webm-vp9", "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "webm-vp9",
      jobs: [
        { rowId: "ada", packageId: "pkg_batch_card_ada", outputPath: join(outDir, "render", "pkg_batch_card_ada.webm"), status: "not_run" },
        { rowId: "grace", packageId: "pkg_batch_card_grace", outputPath: join(outDir, "render", "pkg_batch_card_grace.webm"), status: "not_run" }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      packageId: "pkg_batch_card",
      output: {
        preset: "webm-vp9",
        jobs: [
          { rowId: "ada", packageId: "pkg_batch_card_ada", outputPath: join(outDir, "render", "pkg_batch_card_ada.webm"), status: "not_run" },
          { rowId: "grace", packageId: "pkg_batch_card_grace", outputPath: join(outDir, "render", "pkg_batch_card_grace.webm"), status: "not_run" }
        ]
      }
    });
  });

  it("emits stable per-row idempotency keys for batch/data plans", async () => {
    const firstOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-idempotency-a-"));
    const secondOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-idempotency-b-"));
    const webmOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-idempotency-webm-"));
    tempDirs.push(firstOutDir, secondOutDir, webmOutDir);

    const first = await runCli(["render-batch", batchFixtureRoot, "--out", firstOutDir, "--dry-run"]);
    const second = await runCli(["render-batch", batchFixtureRoot, "--out", secondOutDir, "--dry-run"]);
    const webm = await runCli(["render-batch", batchFixtureRoot, "--out", webmOutDir, "--preset", "webm-vp9", "--dry-run"]);
    const firstReceipt = JSON.parse(await readFile(join(firstOutDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const firstJobs = first.jobs as Array<Record<string, string>>;
    const secondJobs = second.jobs as Array<Record<string, string>>;
    const webmJobs = webm.jobs as Array<Record<string, string>>;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(webm.ok).toBe(true);
    expect(firstJobs.map((job) => job.idempotencyKey)).toEqual(secondJobs.map((job) => job.idempotencyKey));
    expect(firstJobs[0].idempotencyKey).toMatch(/^pkg_batch_card_ada:ada:mp4-h264:[a-f0-9]{24}$/);
    expect(firstJobs[1].idempotencyKey).toMatch(/^pkg_batch_card_grace:grace:mp4-h264:[a-f0-9]{24}$/);
    expect(webmJobs[0].idempotencyKey).not.toBe(firstJobs[0].idempotencyKey);
    expect(firstReceipt.output.jobs[0].idempotencyKey).toBe(firstJobs[0].idempotencyKey);
    expect(firstReceipt.output.jobs[1].idempotencyKey).toBe(firstJobs[1].idempotencyKey);
  });

  it("writes per-row batch/data plan receipts in dry-run mode", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-row-receipts-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--dry-run"]);
    const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const jobs = result.jobs as Array<Record<string, string>>;
    const adaPlanReceiptPath = join(outDir, "receipts", "pkg_batch_card_ada.batch-row.receipt.json");
    const adaPlanReceipt = JSON.parse(await readFile(adaPlanReceiptPath, "utf8")) as Record<string, any>;

    expect(result.ok).toBe(true);
    expect(jobs[0]).toMatchObject({
      rowId: "ada",
      idempotencyKey: expect.stringMatching(/^pkg_batch_card_ada:ada:mp4-h264:[a-f0-9]{24}$/),
      planReceiptPath: adaPlanReceiptPath,
      receiptPath: adaPlanReceiptPath
    });
    expect(adaPlanReceipt).toMatchObject({
      operation: "render.batch.row",
      status: "not_run",
      packageId: "pkg_batch_card_ada",
      lane: "batch",
      inputHashes: {
        row: jobs[0].rowHash
      },
      output: {
        dryRun: true,
        rowId: "ada",
        rowKey: jobs[0].rowKey,
        idempotencyKey: jobs[0].idempotencyKey,
        packageId: "pkg_batch_card_ada",
        packageDir: join(outDir, "packages", "pkg_batch_card_ada"),
        outputPath: join(outDir, "render", "pkg_batch_card_ada.mp4"),
        preset: "mp4-h264",
        status: "not_run"
      }
    });
    expect(adaPlanReceipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "row_package", path: join(outDir, "packages", "pkg_batch_card_ada"), status: "available" }),
      expect.objectContaining({ role: "planned_output", path: join(outDir, "render", "pkg_batch_card_ada.mp4"), status: "planned" })
    ]));
    expect(batchReceipt.output.jobs[0]).toMatchObject({
      idempotencyKey: jobs[0].idempotencyKey,
      planReceiptPath: adaPlanReceiptPath,
      receiptPath: adaPlanReceiptPath
    });
  });

  it("copies template sidecars into expanded batch/data row packages", async () => {
    const sourceRoot = await writeFastBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-template-sidecar-"));
    tempDirs.push(sourceRoot, outDir);
    const manifestPath = join(sourceRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.template = "template.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(sourceRoot, "template.json"), `${JSON.stringify({
      schema: "shellx-motion/template@1",
      id: "template_batch_card",
      name: "Batch Card",
      motion: "motion.json",
      compatibleLanes: ["ffmpeg"],
      compatibleHosts: ["shellx-motion"],
      metadata: {
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
        outputBounds: { aspectRatios: ["16:9"] },
        suitability: { bestFor: ["batch rows"] },
        license: { id: "test" },
        provenance: { source: "test", sourceHash: "abc123" },
        performance: { recommendedLane: "ffmpeg" }
      },
      groups: [{ id: "content", label: "Content" }],
      params: [{ id: "name", label: "Name", type: "text", defaultValue: "Ada" }],
      controls: [{ paramId: "name", widget: "text", label: "Name" }],
      bindings: [{ paramId: "name", target: { kind: "motion_path", path: "/layers/1/text", layerId: "title" } }]
    }, null, 2)}\n`, "utf8");

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--dry-run"]);
    const expandedTemplate = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_ada", "template.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true
    });
    expect(expandedTemplate).toMatchObject({
      schema: "shellx-motion/template@1",
      id: "template_batch_card",
      bindings: [
        { paramId: "name", target: { path: "/layers/1/text", layerId: "title" } }
      ]
    });
  });

  it("uses per-row render presets for batch/data variants when no global preset is supplied", async () => {
    const sourceRoot = await writeFastBatchPackage();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-row-presets-"));
    const outDir = join(tempRoot, "out");
    const rowsPath = join(tempRoot, "rows.json");
    tempDirs.push(sourceRoot, tempRoot);
    await writeFile(rowsPath, `${JSON.stringify({
      schema: "shellx-motion/data-rows@1",
      rows: [
        { id: "webm", name: "WebM", background: "#0f172a", accent: "#38bdf8", render: { preset: "webm-vp9" } },
        { id: "still", name: "Still", background: "#111827", accent: "#22c55e", render: { preset: "png-frame" } }
      ]
    }, null, 2)}\n`, "utf8");

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--rows", rowsPath, "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      preset: "mp4-h264",
      presets: ["webm-vp9", "png-frame"],
      jobs: [
        { rowId: "webm", packageId: "pkg_batch_card_webm", preset: "webm-vp9", outputPath: join(outDir, "render", "pkg_batch_card_webm.webm"), status: "not_run" },
        { rowId: "still", packageId: "pkg_batch_card_still", preset: "png-frame", outputPath: join(outDir, "render", "pkg_batch_card_still.png"), status: "not_run" }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      output: {
        preset: "mp4-h264",
        presets: ["webm-vp9", "png-frame"],
        jobs: [
          { rowId: "webm", preset: "webm-vp9", outputPath: join(outDir, "render", "pkg_batch_card_webm.webm"), status: "not_run" },
          { rowId: "still", preset: "png-frame", outputPath: join(outDir, "render", "pkg_batch_card_still.png"), status: "not_run" }
        ]
      }
    });
  });

  it("plans batch/data PNG sequence exports as per-row frame directories", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-png-sequence-dry-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--preset", "png-sequence", "--dry-run"]);

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "png-sequence",
      jobs: [
        { rowId: "ada", packageId: "pkg_batch_card_ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: "not_run" },
        { rowId: "grace", packageId: "pkg_batch_card_grace", outputPath: join(outDir, "render", "pkg_batch_card_grace"), status: "not_run" }
      ]
    });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      packageId: "pkg_batch_card",
      output: {
        preset: "png-sequence",
        jobs: [
          { rowId: "ada", packageId: "pkg_batch_card_ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: "not_run" },
          { rowId: "grace", packageId: "pkg_batch_card_grace", outputPath: join(outDir, "render", "pkg_batch_card_grace"), status: "not_run" }
        ]
      }
    });
  });

  it.skipIf(process.platform === "win32")("creates an absent batch output tree privately under umask 0002", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-private-output-"));
    const outDir = join(root, "batch");
    tempDirs.push(root);
    const previousUmask = process.umask(0o002);
    try {
      expect(await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--dry-run"]))
        .toMatchObject({ ok: true, command: "render-batch", dryRun: true });
      for (const path of [outDir, join(outDir, "packages"), join(outDir, "render"), join(outDir, "receipts")]) {
        expect(Number((await stat(path)).mode) & 0o777, path).toBe(0o700);
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(process.platform === "win32")("refuses an unsafe batch-output parent before any output is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-unsafe-output-"));
    const unsafeParent = join(root, "unsafe");
    const outDir = join(unsafeParent, "batch");
    tempDirs.push(root);
    await mkdir(unsafeParent, { mode: 0o777 });
    await chmod(unsafeParent, 0o777);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--dry-run"]);

    expect(result).toMatchObject({
      ok: false,
      command: "render-batch",
      error: { code: "invalid_args", message: expect.stringMatching(/writable|unsafe|topology/i) }
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("plans batch/data renders from external CSV rows", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-csv-dry-"));
    const rowsDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-csv-rows-"));
    tempDirs.push(outDir, rowsDir);
    const rowsPath = join(rowsDir, "rows.csv");
    await writeFile(rowsPath, [
      "id,name,background,accent",
      "ada,Ada,#0f172a,#38bdf8",
      "grace,Grace,#111827,#22c55e"
    ].join("\n"), "utf8");

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--rows", rowsPath, "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const adaMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_ada", "motion.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      jobs: [
        { rowId: "ada", packageId: "pkg_batch_card_ada", status: "not_run" },
        { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run" }
      ]
    });
    const jobs = result.jobs as Array<Record<string, string>>;
    expect(jobs[0].rowKey).toBe(`${jobs[0].rowId}-${String(jobs[0].rowHash).slice(0, 16)}`);
    expect(receipt.output.jobs[0].rowKey).toBe(jobs[0].rowKey);
    expect(adaMotion.provenance.dataRowId).toBe("ada");
    expect(adaMotion.provenance.dataRowKey).toBe(jobs[0].rowKey);
    expect(adaMotion.provenance.dataRowHash).toBe(jobs[0].rowHash);
    expect(adaMotion.layers[1].text).toBe("Hello Ada");
  });

  it("materializes localized string rows for batch/data packages in dry-run mode", async () => {
    const sourceRoot = await writeFastBatchPackage();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-locale-"));
    const outDir = join(tempRoot, "out");
    const rowsPath = join(tempRoot, "rows.csv");
    tempDirs.push(sourceRoot, tempRoot);
    const motionPath = join(sourceRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
    motion.layers[1].text = "{{strings.greeting}} {{name}}";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    await writeFile(rowsPath, [
      "id,locale,name,background,accent,strings.greeting.en,strings.greeting.es,strings.greeting.lv,strings.cta.default,strings.cta.es",
      "spanish,es,Ada,#0f172a,#38bdf8,Hello,Hola,Sveiki,Start,Empezar",
      "latvian,lv,Grace,#111827,#22c55e,Hello,Hola,Sveiki,Start,"
    ].join("\n"), "utf8");

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--rows", rowsPath, "--dry-run"]);
    const spanishMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_spanish", "motion.json"), "utf8")) as Record<string, any>;
    const latvianMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_latvian", "motion.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      rows: 2,
      jobs: [
        { rowId: "spanish", packageId: "pkg_batch_card_spanish", status: "not_run" },
        { rowId: "latvian", packageId: "pkg_batch_card_latvian", status: "not_run" }
      ]
    });
    expect(spanishMotion.layers[1].text).toBe("Hola Ada");
    expect(latvianMotion.layers[1].text).toBe("Sveiki Grace");
  });

  it("materializes row text and media replacement maps in batch/data dry-run packages", async () => {
    const sourceRoot = await writeBatchPackageWithAsset();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-replace-"));
    const outDir = join(tempRoot, "out");
    const rowsPath = join(tempRoot, "rows.csv");
    tempDirs.push(sourceRoot, tempRoot);
    const motionPath = join(sourceRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
    motion.layers.push({
      id: "product",
      type: "image",
      source: "assets/product.txt",
      assetRef: "assets/product.txt",
      src: "assets/product.txt",
      startMs: 0,
      durationMs: 300,
      width: 32,
      height: 18
    });
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    await writeFile(join(sourceRoot, "assets", "spanish-product.png"), "spanish image", "utf8");
    await writeFile(join(sourceRoot, "assets", "latvian-product.png"), "latvian image", "utf8");
    await writeFile(rowsPath, [
      "id,name,background,accent,replace.text.title,replace.media.product",
      "spanish,Ada,#0f172a,#38bdf8,Comprar ahora,assets/spanish-product.png",
      "latvian,Grace,#111827,#22c55e,Pirkt tagad,assets/latvian-product.png"
    ].join("\n"), "utf8");

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--rows", rowsPath, "--dry-run"]);
    const spanishManifest = JSON.parse(await readFile(join(outDir, "packages", "pkg_asset_batch_spanish", "manifest.json"), "utf8")) as Record<string, any>;
    const spanishMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_asset_batch_spanish", "motion.json"), "utf8")) as Record<string, any>;
    const latvianMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_asset_batch_latvian", "motion.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      jobs: [
        { rowId: "spanish", packageId: "pkg_asset_batch_spanish", status: "not_run" },
        { rowId: "latvian", packageId: "pkg_asset_batch_latvian", status: "not_run" }
      ]
    });
    expect(spanishMotion.layers.find((layer: Record<string, unknown>) => layer.id === "title")).toMatchObject({ text: "Comprar ahora" });
    expect(spanishMotion.layers.find((layer: Record<string, unknown>) => layer.id === "product")).toMatchObject({
      source: "assets/spanish-product.png",
      assetRef: "assets/spanish-product.png",
      src: "assets/spanish-product.png"
    });
    expect(latvianMotion.layers.find((layer: Record<string, unknown>) => layer.id === "title")).toMatchObject({ text: "Pirkt tagad" });
    expect(await readFile(join(outDir, "packages", "pkg_asset_batch_spanish", "assets", "spanish-product.png"), "utf8")).toBe("spanish image");
    expect(await readFile(join(outDir, "packages", "pkg_asset_batch_latvian", "assets", "latvian-product.png"), "utf8")).toBe("latvian image");
    expect(spanishManifest.assets).toContain("assets/spanish-product.png");
  });

  it("materializes typed JSON row tokens for batch aspect-ratio variants in dry-run mode", async () => {
    const sourceRoot = await writeVariantBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-variant-dry-"));
    tempDirs.push(sourceRoot, outDir);

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--dry-run"]);
    const portraitMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_variant_card_portrait", "motion.json"), "utf8")) as Record<string, any>;
    const squareMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_variant_card_square", "motion.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: true,
      jobs: [
        { rowId: "portrait", packageId: "pkg_variant_card_portrait", outputPath: join(outDir, "render", "pkg_variant_card_portrait.mp4"), status: "not_run" },
        { rowId: "square", packageId: "pkg_variant_card_square", outputPath: join(outDir, "render", "pkg_variant_card_square.mp4"), status: "not_run" }
      ]
    });
    expect(portraitMotion).toMatchObject({
      width: 1080,
      height: 1920,
      durationMs: 1500,
      fps: 30,
      background: "#101828",
      layers: [
        { width: 960, height: 640, style: { fill: "#101828" } },
        { text: "Portrait export", style: { color: "#f97316", width: 820 } }
      ],
      provenance: { dataRowId: "portrait" }
    });
    expect(squareMotion).toMatchObject({
      width: 1080,
      height: 1080,
      durationMs: 1200,
      fps: 24,
      background: "#111827",
      layers: [
        { width: 880, height: 360, style: { fill: "#111827" } },
        { text: "Square export", style: { color: "#38bdf8", width: 720 } }
      ],
      provenance: { dataRowId: "square" }
    });
  });

  it("plans batch/data renders with a unique-frame quality policy", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-quality-dry-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--min-unique-frames", "2", "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      quality: { minUniqueFrameHashes: 2 },
      jobs: [
        { rowId: "ada", status: "not_run", quality: { minUniqueFrameHashes: 2 } },
        { rowId: "grace", status: "not_run", quality: { minUniqueFrameHashes: 2 } }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      output: {
        quality: { minUniqueFrameHashes: 2 },
        jobs: [
          { rowId: "ada", status: "not_run", quality: { minUniqueFrameHashes: 2 } },
          { rowId: "grace", status: "not_run", quality: { minUniqueFrameHashes: 2 } }
        ]
      }
    });
  });

  it("warns when batch/data dry-run uses a silent export preset with package audio", async () => {
    const sourceRoot = await writeAudioBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-gif-audio-"));
    tempDirs.push(sourceRoot, outDir);

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "gif", "--dry-run"]);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const warning = "Export preset gif does not support audio; 1 requested audio track will be ignored.";

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "gif",
      warnings: [warning],
      jobs: [
        { rowId: "ada", outputPath: join(outDir, "render", "pkg_audio_batch_ada.gif"), status: "not_run", warnings: [warning] },
        { rowId: "grace", outputPath: join(outDir, "render", "pkg_audio_batch_grace.gif"), status: "not_run", warnings: [warning] }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "not_run",
      warnings: [warning],
      output: {
        preset: "gif",
        jobs: [
          { rowId: "ada", outputPath: join(outDir, "render", "pkg_audio_batch_ada.gif"), status: "not_run", warnings: [warning] },
          { rowId: "grace", outputPath: join(outDir, "render", "pkg_audio_batch_grace.gif"), status: "not_run", warnings: [warning] }
        ]
      }
    });
  });

  it("rejects unsupported batch export presets before writing rows", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-bad-preset-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", batchFixtureRoot, "--out", outDir, "--preset", "avi-xvid", "--dry-run"]);

    expect(result).toMatchObject({
      ok: false,
      command: "render-batch",
      error: {
        code: "unsupported_preset",
        message: "Unsupported export preset: avi-xvid."
      }
    });
  });

  it("copies package assets into each expanded batch package", async () => {
    const sourceRoot = await writeBatchPackageWithAsset();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-assets-"));
    tempDirs.push(sourceRoot, outDir);

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--dry-run"]);
    const copied = await readFile(join(outDir, "packages", "pkg_asset_batch_one", "assets", "product.txt"), "utf8");

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      jobs: [{ rowId: "one", packageId: "pkg_asset_batch_one", status: "not_run" }]
    });
    expect(copied).toBe("asset payload\n");
  });

  it("renders batch/data rows through the ffmpeg lane", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-real-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const commands: FfmpegCommand[] = [];
    const streamedCommands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) return streamedVideoProbe();
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      await writeFile(command.args[command.args.length - 1], `fake ${commands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir], {
      ffmpegRunner: runner,
      streamingProcessFactory: streamedBatchProcessFactory(streamedCommands),
      scratchRoot: join(outDir, "frames")
    });
    const ada = await readFile(join(outDir, "render", "pkg_batch_card_ada.mp4"), "utf8");
    const grace = await readFile(join(outDir, "render", "pkg_batch_card_grace.mp4"), "utf8");

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: false,
      jobs: [
        {
          rowId: "ada",
          packageId: "pkg_batch_card_ada",
          status: "warning",
          render: {
            frameTransport: { delivery: "streamed", reason: "stream_default" },
            receipt: { output: { frameTransport: { delivery: "streamed", frameLane: "browser", retainedFrameCount: 0 } } }
          }
        },
        {
          rowId: "grace",
          packageId: "pkg_batch_card_grace",
          status: "warning",
          render: {
            frameTransport: { delivery: "streamed", reason: "stream_default" },
            receipt: { output: { frameTransport: { delivery: "streamed", frameLane: "browser", retainedFrameCount: 0 } } }
          }
        }
      ]
    });
    expect(commands.filter((command) => command.args[0] === "-version")).toHaveLength(2);
    expect(streamedCommands).toHaveLength(2);
    expect(streamedCommands.every((command) => command.args.includes("image2pipe") && command.args.includes("pipe:0"))).toBe(true);
    expect(ada).toContain("fake");
    expect(grace).toContain("fake");
  }, 45_000);

  it("replays browser workflow evidence for each batch/data render row", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-workflow-"));
    const outDir = join(tempRoot, "batch");
    const sourceRoot = await writeFastBatchPackage();
    const workflowPath = join(tempRoot, "workflow.json");
    tempDirs.push(tempRoot, sourceRoot);
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 5 },
        { action: "scroll", y: 12 }
      ],
      cursor: { visible: true, path: [{ x: 6, y: 9, atMs: 0 }] }
    }, null, 2));
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      await writeFile(command.args[command.args.length - 1], `fake ${commands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--workflow", workflowPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      jobs: [
        {
          rowId: "ada",
          status: "warning",
          render: {
            ok: true,
            workflowPath,
            workflow: { stepCount: 2 },
            workflowTrace: { stepCount: 2, workflowHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
            receipt: {
              inputHashes: { workflow: expect.stringMatching(/^[a-f0-9]{64}$/) },
              output: {
                workflow: { stepCount: 2 },
                workflowTrace: { stepCount: 2 }
              }
            }
          }
        },
        {
          rowId: "grace",
          status: "warning",
          render: {
            ok: true,
            workflowPath,
            workflow: { stepCount: 2 },
            workflowTrace: { stepCount: 2, workflowHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
            receipt: {
              inputHashes: { workflow: expect.stringMatching(/^[a-f0-9]{64}$/) },
              output: {
                workflow: { stepCount: 2 },
                workflowTrace: { stepCount: 2 }
              }
            }
          }
        }
      ]
    });
    expect(commands.filter((command) => command.args[0] === "-version")).toHaveLength(2);
    expect(commands.filter((command) => command.args.includes("-framerate"))).toHaveLength(2);
  }, 45_000);

  it("resumes completed batch/data rows without re-rendering matching idempotency keys", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-resume-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const firstCommands: FfmpegCommand[] = [];
    const firstStreamedCommands: FfmpegCommand[] = [];
    const firstRunner: FfmpegRunner = async (command) => {
      firstCommands.push(command);
      if (isFfprobeCommand(command)) return streamedVideoProbe();
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      await writeFile(command.args[command.args.length - 1], `fake ${firstCommands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };
    const secondCommands: FfmpegCommand[] = [];
    const failOnRender: FfmpegRunner = async (command) => {
      secondCommands.push(command);
      return { exitCode: 1, stdout: "", stderr: `unexpected resume render: ${command.args.join(" ")}` };
    };

    const first = await runCli(["render-batch", sourceRoot, "--out", outDir], {
      ffmpegRunner: firstRunner,
      streamingProcessFactory: streamedBatchProcessFactory(firstStreamedCommands),
      scratchRoot: join(outDir, "frames")
    });
    const resumed = await runCli(["render-batch", sourceRoot, "--out", outDir, "--resume"], { ffmpegRunner: failOnRender, scratchRoot: join(outDir, "resume-frames") });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const firstJobs = first.jobs as Array<Record<string, string>>;

    expect(first.ok).toBe(true);
    expect(first).toMatchObject({
      jobs: [
        { render: { receipt: { output: { frameTransport: { delivery: "streamed", retainedFrameCount: 0 } } } } },
        { render: { receipt: { output: { frameTransport: { delivery: "streamed", retainedFrameCount: 0 } } } } }
      ]
    });
    expect(resumed).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: false,
      resume: true,
      resumedRows: 2,
      renderedRows: 0,
      jobs: [
        { rowId: "ada", status: "skipped", idempotencyKey: firstJobs[0].idempotencyKey, resume: { matched: true, sourceReceiptPath: firstJobs[0].receiptPath } },
        { rowId: "grace", status: "skipped", idempotencyKey: firstJobs[1].idempotencyKey, resume: { matched: true, sourceReceiptPath: firstJobs[1].receiptPath } }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "passed",
      output: {
        resume: true,
        resumedRows: 2,
        renderedRows: 0,
        jobs: [
          { rowId: "ada", status: "skipped", idempotencyKey: firstJobs[0].idempotencyKey },
          { rowId: "grace", status: "skipped", idempotencyKey: firstJobs[1].idempotencyKey }
        ]
      }
    });
    expect(firstStreamedCommands).toHaveLength(2);
    expect(secondCommands).toHaveLength(0);
    expect(await readFile(join(outDir, "render", "pkg_batch_card_ada.mp4"), "utf8")).toContain("fake");
    expect(await readFile(join(outDir, "render", "pkg_batch_card_grace.mp4"), "utf8")).toContain("fake");
  }, 45_000);

  it("re-renders batch/data rows on resume when browser workflow evidence changes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-resume-workflow-"));
    const outDir = join(tempRoot, "batch");
    const sourceRoot = await writeFastBatchPackage();
    const firstWorkflowPath = join(tempRoot, "workflow-a.json");
    const secondWorkflowPath = join(tempRoot, "workflow-b.json");
    tempDirs.push(tempRoot, sourceRoot);
    await writeFile(firstWorkflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [{ action: "wait", ms: 5 }],
      cursor: { visible: false }
    }, null, 2));
    await writeFile(secondWorkflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [{ action: "wait", ms: 15 }],
      cursor: { visible: false }
    }, null, 2));
    const firstCommands: FfmpegCommand[] = [];
    const secondCommands: FfmpegCommand[] = [];
    const firstRunner: FfmpegRunner = async (command) => {
      firstCommands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      await writeFile(command.args[command.args.length - 1], `first ${firstCommands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };
    const secondRunner: FfmpegRunner = async (command) => {
      secondCommands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await writeFile(command.args[command.args.length - 1], `second ${secondCommands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const first = await runCli(["render-batch", sourceRoot, "--out", outDir, "--workflow", firstWorkflowPath], { ffmpegRunner: firstRunner, scratchRoot: join(outDir, "frames") });
    const resumed = await runCli(["render-batch", sourceRoot, "--out", outDir, "--resume", "--workflow", secondWorkflowPath], { ffmpegRunner: secondRunner, scratchRoot: join(outDir, "resume-frames") });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const firstJobs = first.jobs as Array<Record<string, string>>;

    expect(first.ok).toBe(true);
    expect(resumed).toMatchObject({
      ok: true,
      command: "render-batch",
      dryRun: false,
      resume: true,
      resumedRows: 0,
      renderedRows: 2,
      jobs: [
        { rowId: "ada", status: "warning", render: { workflowPath: secondWorkflowPath } },
        { rowId: "grace", status: "warning", render: { workflowPath: secondWorkflowPath } }
      ]
    });
    expect((resumed.jobs as Array<Record<string, string>>).map((job) => job.idempotencyKey)).not.toEqual(firstJobs.map((job) => job.idempotencyKey));
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "warning",
      output: {
        resume: true,
        resumedRows: 0,
        renderedRows: 2,
        jobs: [
          { rowId: "ada", status: "warning" },
          { rowId: "grace", status: "warning" }
        ]
      }
    });
    expect(secondCommands.filter((command) => command.args.includes("-framerate"))).toHaveLength(2);
    expect(await readFile(join(outDir, "render", "pkg_batch_card_ada.mp4"), "utf8")).toContain("second");
    expect(await readFile(join(outDir, "render", "pkg_batch_card_grace.mp4"), "utf8")).toContain("second");
  }, 45_000);

  it("runs quality manifests for each rendered batch/data row", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(tempRoot, sourceRoot);
    const baselinePath = join(tempRoot, "baseline.png");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    await writeFile(baselinePath, CONTRAST_PNG);
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "mid", atMs: 100, baseline: "baseline.png", minBrightPixels: 1, maxChangedPixels: 0, maxMeanDiff: 0 }
      ]
    }, null, 2)}\n`, "utf8");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 64, height: 36, avg_frame_rate: "10/1" }],
            format: { duration: "0.300000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      if (String(command.args[command.args.length - 1]).endsWith(".png")) {
        await writeFile(command.args[command.args.length - 1], CONTRAST_PNG);
      } else {
        await writeFile(command.args[command.args.length - 1], `fake ${commands.length}`, "utf8");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--quality-manifest", manifestPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    const qualityJobs = result.jobs as Array<Record<string, any>>;
    const adaAppliedPath = qualityJobs[0].qualityManifestAppliedPath as string;
    const graceAppliedPath = qualityJobs[1].qualityManifestAppliedPath as string;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      qualityManifestPath: manifestPath,
      jobs: [
        {
          rowId: "ada",
          qualityManifestPath: manifestPath,
          qualityCheck: { ok: true, command: "quality-check", manifestPath: adaAppliedPath },
          render: {
            frameTransport: { delivery: "materialized", reason: "exact_source_quality" },
            receipt: { output: { frameTransportPlan: { delivery: "materialized", reason: "exact_source_quality" }, qualityCheck: { status: "passed" } } }
          }
        },
        {
          rowId: "grace",
          qualityManifestPath: manifestPath,
          qualityCheck: { ok: true, command: "quality-check", manifestPath: graceAppliedPath },
          render: {
            frameTransport: { delivery: "materialized", reason: "exact_source_quality" },
            receipt: { output: { frameTransportPlan: { delivery: "materialized", reason: "exact_source_quality" }, qualityCheck: { status: "passed" } } }
          }
        }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "warning",
      output: {
        qualityManifestPath: manifestPath,
        jobs: [
          { rowId: "ada", qualityManifestPath: manifestPath, qualityCheck: { status: "passed" } },
          { rowId: "grace", qualityManifestPath: manifestPath, qualityCheck: { status: "passed" } }
        ]
      }
    });
    // Six FFprobe reads, three per row. The final-render door owns the delivered-colour and
    // manifest readbacks, then records the FFprobe identity that contributed to that exact-source
    // evidence. Batch does not launch a second post-render quality check.
    expect(commands.filter((command) => isFfprobeCommand(command))).toHaveLength(6);
    expect(commands.filter((command) => isFfprobeCommand(command) && command.args.includes("-show_streams"))).toHaveLength(4);
    expect(commands.filter((command) => command.args.includes(baselinePath))).toHaveLength(0);
    expect(commands.filter((command) => String(command.args[command.args.length - 1]).endsWith(".png"))).toHaveLength(2);
  }, 45_000);

  it("runs quality manifests against batch PNG still-frame outputs without invoking FFmpeg", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-png-frame-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(tempRoot, sourceRoot);
    const manifestPath = join(tempRoot, "quality-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "{{rowId}} still", atMs: 0, minBrightPixels: 0, minEdgePixels: 1, maxChangedPixels: 0, maxMeanDiff: 0 }
      ]
    }, null, 2)}\n`, "utf8");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 1, stdout: "", stderr: "ffmpeg should not be needed for PNG still-frame quality manifests" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-frame", "--quality-manifest", manifestPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });

    const adaOutputPath = join(outDir, "render", "pkg_batch_card_ada.png");
    const graceOutputPath = join(outDir, "render", "pkg_batch_card_grace.png");
    const qualityJobs = result.jobs as Array<Record<string, any>>;
    const adaManifestPath = qualityJobs[0].qualityManifestAppliedPath as string;
    const graceManifestPath = qualityJobs[1].qualityManifestAppliedPath as string;
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "png-frame",
      qualityManifestPath: manifestPath,
      jobs: [
        {
          rowId: "ada",
          outputPath: adaOutputPath,
          qualityManifestAppliedPath: adaManifestPath,
          qualityCheck: {
            ok: true,
            command: "quality-check",
            inputPath: adaOutputPath,
            manifestPath: adaManifestPath,
            samples: [{ id: "ada still", atMs: 0, framePath: adaOutputPath }]
          }
        },
        {
          rowId: "grace",
          outputPath: graceOutputPath,
          qualityManifestAppliedPath: graceManifestPath,
          qualityCheck: {
            ok: true,
            command: "quality-check",
            inputPath: graceOutputPath,
            manifestPath: graceManifestPath,
            samples: [{ id: "grace still", atMs: 0, framePath: graceOutputPath }]
          }
        }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "passed",
      output: {
        preset: "png-frame",
        qualityManifestPath: manifestPath,
        jobs: [
          { rowId: "ada", outputPath: adaOutputPath, qualityManifestAppliedPath: adaManifestPath, qualityCheck: { status: "passed" } },
          { rowId: "grace", outputPath: graceOutputPath, qualityManifestAppliedPath: graceManifestPath, qualityCheck: { status: "passed" } }
        ]
      }
    });
    expect(commands).toHaveLength(0);
  }, 45_000);

  it("runs quality manifests against batch PNG sequence sample frames without invoking FFmpeg", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-png-sequence-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(tempRoot, sourceRoot);
    const manifestPath = join(tempRoot, "quality-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "{{rowId}} mid", atMs: 100, minBrightPixels: 0, minEdgePixels: 1, maxChangedPixels: 0, maxMeanDiff: 0 }
      ]
    }, null, 2)}\n`, "utf8");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 1, stdout: "", stderr: "ffmpeg should not be needed for PNG sequence quality manifests" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-sequence", "--quality-manifest", manifestPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });

    const adaOutputPath = join(outDir, "render", "pkg_batch_card_ada");
    const graceOutputPath = join(outDir, "render", "pkg_batch_card_grace");
    const adaSampleFrame = join(adaOutputPath, "000002.png");
    const graceSampleFrame = join(graceOutputPath, "000002.png");
    const qualityJobs = result.jobs as Array<Record<string, any>>;
    const adaManifestPath = qualityJobs[0].qualityManifestAppliedPath as string;
    const graceManifestPath = qualityJobs[1].qualityManifestAppliedPath as string;
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "png-sequence",
      qualityManifestPath: manifestPath,
      jobs: [
        {
          rowId: "ada",
          outputPath: adaOutputPath,
          qualityManifestAppliedPath: adaManifestPath,
          qualityCheck: {
            ok: true,
            command: "quality-check",
            inputPath: adaOutputPath,
            manifestPath: adaManifestPath,
            samples: [{ id: "ada mid", atMs: 100, framePath: adaSampleFrame }]
          }
        },
        {
          rowId: "grace",
          outputPath: graceOutputPath,
          qualityManifestAppliedPath: graceManifestPath,
          qualityCheck: {
            ok: true,
            command: "quality-check",
            inputPath: graceOutputPath,
            manifestPath: graceManifestPath,
            samples: [{ id: "grace mid", atMs: 100, framePath: graceSampleFrame }]
          }
        }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "render.batch",
      status: "warning",
      output: {
        preset: "png-sequence",
        qualityManifestPath: manifestPath,
        jobs: [
          { rowId: "ada", outputPath: adaOutputPath, qualityManifestAppliedPath: adaManifestPath, qualityCheck: { status: "passed" } },
          { rowId: "grace", outputPath: graceOutputPath, qualityManifestAppliedPath: graceManifestPath, qualityCheck: { status: "passed" } }
        ]
      }
    });
    expect(commands).toHaveLength(0);
  }, 45_000);

  it("materializes row-token quality manifests for batch/data baselines", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-row-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(tempRoot, sourceRoot);
    await mkdir(join(tempRoot, "baselines"), { recursive: true });
    await writeFile(join(tempRoot, "baselines", "ada.png"), CONTRAST_PNG);
    await writeFile(join(tempRoot, "baselines", "grace.png"), CONTRAST_PNG);
    const manifestPath = join(tempRoot, "quality-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [
        { id: "row_mid", atMs: 100, baseline: "baselines/{{rowId}}.png", minBrightPixels: 1, maxChangedPixels: 0, maxMeanDiff: 0 }
      ]
    }, null, 2)}\n`, "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (isFfprobeCommand(command)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_name: "h264", width: 64, height: 36, avg_frame_rate: "10/1" }],
            format: { duration: "0.300000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      if (String(command.args[command.args.length - 1]).endsWith(".png")) {
        await writeFile(command.args[command.args.length - 1], CONTRAST_PNG);
      } else {
        await writeFile(command.args[command.args.length - 1], "fake mp4 bytes", "utf8");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--quality-manifest", manifestPath], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });
    const qualityJobs = result.jobs as Array<Record<string, any>>;
    const adaManifestPath = qualityJobs[0].qualityManifestAppliedPath as string;
    const graceManifestPath = qualityJobs[1].qualityManifestAppliedPath as string;
    const adaManifest = JSON.parse(await readFile(adaManifestPath, "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      qualityManifestPath: manifestPath,
      jobs: [
        {
          rowId: "ada",
          qualityManifestPath: manifestPath,
          qualityManifestAppliedPath: adaManifestPath,
          qualityCheck: { ok: true, manifestPath: adaManifestPath },
          render: {
            frameTransport: { delivery: "materialized", reason: "exact_source_quality" },
            receipt: {
              inputHashes: { qualityManifest: expect.stringMatching(/^[a-f0-9]{64}$/) },
              output: { qualityManifestPath: adaManifestPath, qualityCheck: { status: "passed" } }
            }
          }
        },
        {
          rowId: "grace",
          qualityManifestPath: manifestPath,
          qualityManifestAppliedPath: graceManifestPath,
          qualityCheck: { ok: true, manifestPath: graceManifestPath },
          render: {
            frameTransport: { delivery: "materialized", reason: "exact_source_quality" },
            receipt: {
              inputHashes: { qualityManifest: expect.stringMatching(/^[a-f0-9]{64}$/) },
              output: { qualityManifestPath: graceManifestPath, qualityCheck: { status: "passed" } }
            }
          }
        }
      ]
    });
    expect(adaManifest.samples[0].baseline).toMatch(/baseline-000-[a-f0-9]{16}\.png$/);
    expect(await readFile(adaManifest.samples[0].baseline)).toEqual(CONTRAST_PNG);
    expect(receipt).toMatchObject({
      output: {
        jobs: [
          { rowId: "ada", qualityManifestAppliedPath: adaManifestPath, qualityCheck: { status: "passed" } },
          { rowId: "grace", qualityManifestAppliedPath: graceManifestPath, qualityCheck: { status: "passed" } }
        ]
      }
    });
  }, 45_000);

  it("renders batch/data rows with non-default export presets", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-webm-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const commands: FfmpegCommand[] = [];
    const streamedCommands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isFfprobeCommand(command)) return streamedVideoProbe("vp9", "matroska,webm");
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      await mkdir(dirname(command.args[command.args.length - 1]), { recursive: true });
      await writeFile(command.args[command.args.length - 1], `fake ${commands.length}`, "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "webm-vp9"], {
      ffmpegRunner: runner,
      streamingProcessFactory: streamedBatchProcessFactory(streamedCommands),
      scratchRoot: join(outDir, "frames")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "webm-vp9",
      jobs: [
        {
          rowId: "ada",
          outputPath: join(outDir, "render", "pkg_batch_card_ada.webm"),
          render: {
            preset: "webm-vp9",
            frameTransport: { delivery: "streamed", reason: "stream_default" },
            output: { codec: "vp9", container: "webm", preset: "webm-vp9" },
            receipt: { output: { frameTransport: { delivery: "streamed", retainedFrameCount: 0 } } }
          }
        },
        {
          rowId: "grace",
          outputPath: join(outDir, "render", "pkg_batch_card_grace.webm"),
          render: {
            preset: "webm-vp9",
            frameTransport: { delivery: "streamed", reason: "stream_default" },
            output: { codec: "vp9", container: "webm", preset: "webm-vp9" },
            receipt: { output: { frameTransport: { delivery: "streamed", retainedFrameCount: 0 } } }
          }
        }
      ]
    });
    expect(streamedCommands.filter((command) => command.args.includes("libvpx-vp9"))).toHaveLength(2);
    await expect(readFile(join(outDir, "render", "pkg_batch_card_ada.webm"), "utf8")).resolves.toContain("fake");
    await expect(readFile(join(outDir, "render", "pkg_batch_card_grace.webm"), "utf8")).resolves.toContain("fake");
  }, 45_000);

  it("renders batch/data rows as PNG sequences without invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-png-sequence-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "ffmpeg should not be needed for PNG sequence batch renders", stderr: "" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-sequence"], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });

    expect(result).toMatchObject({
      ok: true,
      command: "render-batch",
      preset: "png-sequence",
      jobs: [
        {
          rowId: "ada",
          outputPath: join(outDir, "render", "pkg_batch_card_ada"),
          render: { lane: "image-sequence", preset: "png-sequence", frames: { count: 3 } }
        },
        {
          rowId: "grace",
          outputPath: join(outDir, "render", "pkg_batch_card_grace"),
          render: { lane: "image-sequence", preset: "png-sequence", frames: { count: 3 } }
        }
      ]
    });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
    expect(receipt).toMatchObject({
      status: "warning",
      output: {
        preset: "png-sequence",
        jobs: [
          { rowId: "ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: "warning" },
          { rowId: "grace", outputPath: join(outDir, "render", "pkg_batch_card_grace"), status: "warning" }
        ]
      }
    });
    expect(commands).toHaveLength(0);
    await expect(readFile(join(outDir, "render", "pkg_batch_card_ada", "000001.png"))).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(outDir, "render", "pkg_batch_card_grace", "000003.png"))).resolves.toBeInstanceOf(Buffer);
  }, 45_000);

  it("renders batch/data rows as still-frame images without invoking FFmpeg", async () => {
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(sourceRoot);
    const cases = [
      { preset: "png-frame", extension: "png", codec: "png", mimeType: "image/png", signature: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { preset: "jpeg-frame", extension: "jpg", codec: "jpeg", mimeType: "image/jpeg", signature: Buffer.from([0xff, 0xd8, 0xff]) }
    ] as const;

    for (const imageCase of cases) {
      const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-cli-render-batch-${imageCase.preset}-`));
      tempDirs.push(outDir);
      const commands: FfmpegCommand[] = [];
      const runner: FfmpegRunner = async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "ffmpeg should not be needed for still-frame batch renders", stderr: "" };
      };
      const adaOutputPath = join(outDir, "render", `pkg_batch_card_ada.${imageCase.extension}`);
      const graceOutputPath = join(outDir, "render", `pkg_batch_card_grace.${imageCase.extension}`);

      const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", imageCase.preset], {
        ffmpegRunner: runner,
        scratchRoot: join(outDir, "frames")
      });

      expect(result).toMatchObject({
        ok: true,
        command: "render-batch",
        preset: imageCase.preset,
        jobs: [
          {
            rowId: "ada",
            outputPath: adaOutputPath,
            render: {
              lane: "image",
              preset: imageCase.preset,
              output: { path: adaOutputPath, codec: imageCase.codec, container: "image", preset: imageCase.preset },
              receipt: {
                operation: "render.final",
                status: "passed",
                lane: "image",
                // Every per-row render persists its own receipt beside its own output, so the
                // artifact list carries the delivered frame AND the receipt file that attests it.
                artifacts: [
                  { role: "still_frame", path: adaOutputPath, status: "available", mediaType: imageCase.mimeType, primary: true },
                  {
                    role: "render_receipt",
                    path: join(outDir, "render", "pkg_batch_card_ada-render.receipt.json"),
                    status: "available",
                    mediaType: "application/json"
                  }
                ]
              },
              stillFrame: { outputPath: adaOutputPath, atMs: 0, codec: imageCase.codec, container: "image", preset: imageCase.preset }
            }
          },
          {
            rowId: "grace",
            outputPath: graceOutputPath,
            render: {
              lane: "image",
              preset: imageCase.preset,
              output: { path: graceOutputPath, codec: imageCase.codec, container: "image", preset: imageCase.preset },
              stillFrame: { outputPath: graceOutputPath, atMs: 0, codec: imageCase.codec, container: "image", preset: imageCase.preset }
            }
          }
        ]
      });
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
      expect(receipt).toMatchObject({
        status: "passed",
        output: {
          preset: imageCase.preset,
          jobs: [
            { rowId: "ada", outputPath: adaOutputPath, status: "passed" },
            { rowId: "grace", outputPath: graceOutputPath, status: "passed" }
          ]
        }
      });
      const rowReceipt = JSON.parse(await readFile(join(outDir, "receipts", "pkg_batch_card_ada.render.receipt.json"), "utf8")) as Record<string, any>;
      expect(rowReceipt).toMatchObject({
        operation: "render.final",
        status: "passed",
        lane: "image",
        output: { path: adaOutputPath, codec: imageCase.codec, container: "image", preset: imageCase.preset },
        artifacts: [
          { role: "still_frame", path: adaOutputPath, status: "available", mediaType: imageCase.mimeType, primary: true },
          {
            role: "render_receipt",
            path: join(outDir, "render", "pkg_batch_card_ada-render.receipt.json"),
            status: "available",
            mediaType: "application/json"
          }
        ]
      });
      // The batch row receipt under receipts/ and the render receipt beside the frame are two
      // different files describing the same render; both must exist.
      await expect(readFile(join(outDir, "render", "pkg_batch_card_ada-render.receipt.json"), "utf8")).resolves.toContain("render.final");
      expect(commands).toHaveLength(0);
      await expect(readFile(adaOutputPath)).resolves.toEqual(expect.any(Buffer));
      await expect(readFile(graceOutputPath)).resolves.toEqual(expect.any(Buffer));
      expect((await readFile(adaOutputPath)).subarray(0, imageCase.signature.length)).toEqual(imageCase.signature);
      expect((await readFile(graceOutputPath)).subarray(0, imageCase.signature.length)).toEqual(imageCase.signature);
    }
  }, 45_000);

  it("returns a batch-level error when a PNG sequence row fails the unique-frame quality gate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-png-sequence-quality-fail-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "ffmpeg should not be needed for PNG sequence batch renders", stderr: "" };
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--preset", "png-sequence", "--min-unique-frames", "2"], {
      ffmpegRunner: runner,
      scratchRoot: join(outDir, "frames")
    });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      command: "render-batch",
      preset: "png-sequence",
      quality: { minUniqueFrameHashes: 2 },
      error: {
        code: "frame_quality_failed",
        rowId: "ada",
        packageId: "pkg_batch_card_ada",
        message: "Rendered frame sequence has 1 unique frame; expected at least 2."
      },
      jobs: [
        {
          rowId: "ada",
          status: "failed",
          outputPath: join(outDir, "render", "pkg_batch_card_ada"),
          render: { ok: false, lane: "image-sequence", error: { code: "frame_quality_failed" } }
        }
      ]
    });
    expect(receipt).toMatchObject({
      status: "failed",
      output: {
        preset: "png-sequence",
        quality: { minUniqueFrameHashes: 2 },
        jobs: [
          { rowId: "ada", status: "failed", outputPath: join(outDir, "render", "pkg_batch_card_ada") }
        ]
      }
    });
    expect(commands).toHaveLength(0);
  }, 45_000);

  it("returns a batch-level error when a row fails the unique-frame quality gate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-render-batch-quality-fail-"));
    const sourceRoot = await writeFastBatchPackage();
    tempDirs.push(outDir, sourceRoot);
    const commands: FfmpegCommand[] = [];
    const streamedCommands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error("quality failure should stop image2pipe before the encoder receives end-of-input");
    };

    const result = await runCli(["render-batch", sourceRoot, "--out", outDir, "--min-unique-frames", "2"], {
      ffmpegRunner: runner,
      streamingProcessFactory: streamedBatchProcessFactory(streamedCommands),
      scratchRoot: join(outDir, "frames")
    });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      command: "render-batch",
      quality: { minUniqueFrameHashes: 2 },
      error: {
        code: "frame_quality_failed",
        rowId: "ada",
        packageId: "pkg_batch_card_ada"
      },
      jobs: [
        {
          rowId: "ada",
          status: "failed",
          quality: { minUniqueFrameHashes: 2 },
          render: {
            ok: false,
            frameTransport: { delivery: "streamed", reason: "stream_default" },
            error: { code: "frame_quality_failed", handoff: { delivery: "streamed" } }
          }
        }
      ]
    });
    expect(receipt).toMatchObject({
      status: "failed",
      output: {
        quality: { minUniqueFrameHashes: 2 },
        jobs: [
          { rowId: "ada", status: "failed", quality: { minUniqueFrameHashes: 2 } }
        ]
      }
    });
    expect(commands.filter((command) => command.args[0] === "-version")).toHaveLength(1);
    expect(commands.filter((command) => command.args.includes("-framerate"))).toHaveLength(0);
    // image2pipe opens its encoder before source production; the quality gate aborts it before
    // end-of-input, so no completed FFmpeg encode or delivered output can be claimed.
    expect(streamedCommands).toHaveLength(1);
    expect(streamedCommands[0].args).toEqual(expect.arrayContaining(["-f", "image2pipe", "-i", "pipe:0"]));
  }, 45_000);

  it("plans Cut imports from the CLI", async () => {
    const result = await runCli(["plan-import", fixtureRoot, "--target", "cut"]);

    expect(result).toMatchObject({
      ok: true,
      command: "plan-import",
      target: "cut",
      plan: {
        schema: "shellx-motion/cut-import-plan@1",
        mode: "rendered_media",
        operations: [{ verb: "cut.media.import_rendered", source: { render: "required" } }]
      }
    });
  });

  it("plans environment packages through Cut's implemented rendered-media receiver", async () => {
    const result = await runCli(["plan-import", resolve("../../fixtures/packages/environment-snow-cinematic"), "--target", "cut"]);

    expect(result).toMatchObject({
      ok: true,
      command: "plan-import",
      target: "cut",
      plan: {
        schema: "shellx-motion/cut-import-plan@1",
        targetId: "shellx-cut",
        mode: "rendered_media",
        operations: [{ verb: "cut.media.import_rendered", source: { render: "required" } }]
      }
    });
  });

  itLinux("refuses the removed Canvas-to-Cut dry-run control before host-job creation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-connector-"));
    tempDirs.push(outDir);

    const result = await runCli([
      "connector",
      "canvas-to-cut",
      resolve("../../fixtures/canvas/frame-selection.json"),
      "--out",
      outDir,
      "--dry-run-render"
    ]);
    expect(result).toMatchObject({
      ok: false,
      command: "connector.canvas-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("does not accept --dry-run-render") }
    });
    await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses editable Canvas-to-Cut mode before host-job creation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-connector-editable-cut-"));
    const inputDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-connector-editable-input-"));
    tempDirs.push(outDir, inputDir);
    const selectionPath = join(inputDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCli([
      "connector",
      "canvas-to-cut",
      selectionPath,
      "--out",
      outDir,
      "--cut-import-mode",
      "editable_lowering"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "connector.canvas-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("only --cut-import-mode rendered_media") }
    });
    await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses non-MP4 Canvas-to-Cut preset controls before host-job creation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-cut-webm-"));
    const inputDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-cut-webm-input-"));
    tempDirs.push(outDir, inputDir);
    const selectionPath = join(inputDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCli([
      "connector",
      "canvas-to-cut",
      selectionPath,
      "--out",
      outDir,
      "--preset",
      "webm-vp9",
      "--cut-import-mode",
      "rendered_media",
      "--dry-run-render"
    ]);
    expect(result).toMatchObject({
      ok: false,
      command: "connector.canvas-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("does not accept --preset") }
    });
    await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("rejects unsupported Canvas-to-Cut presets before creating connector output", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-cut-invalid-preset-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCli([
      "connector",
      "canvas-to-cut",
      selectionPath,
      "--out",
      join(outDir, "run"),
      "--preset",
      "avi-xvid"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "connector.canvas-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("does not accept --preset") }
    });
    await expect(stat(join(outDir, "run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("runs a Canvas-to-MP4 export harness from the CLI without Cut", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-mp4-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCli([
      "connector",
      "canvas-to-mp4",
      selectionPath,
      "--out",
      outDir,
      "--preset",
      "mp4-h264",
      "--dry-run-render"
    ]);
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8")) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      command: "connector.canvas-to-mp4",
      packageDir: join(outDir, "package"),
      resourceCatalogPath: join(outDir, "package", "resource-catalog.json"),
      render: {
        ok: true,
        dryRun: true,
        lane: "ffmpeg",
        preset: "mp4-h264",
        outputPath: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4"), status: "planned", primary: true })
      ]),
      warnings: []
    });
    expect(result).not.toHaveProperty("cutPlanPath");
    expect(receipt).toMatchObject({
      operation: "connector.canvas_to_mp4",
      status: "passed",
      output: {
        render: { ok: true, dryRun: true, lane: "ffmpeg", preset: "mp4-h264" },
        resourceCatalogPath: join(outDir, "package", "resource-catalog.json")
      }
    });
  });

  itLinux("runs Canvas-to-MP4 CLI exports with non-default FFmpeg presets", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-mp4-webm-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCli([
      "connector",
      "canvas-to-mp4",
      selectionPath,
      "--out",
      outDir,
      "--preset",
      "webm-vp9",
      "--dry-run-render"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "connector.canvas-to-mp4",
      render: {
        ok: true,
        dryRun: true,
        lane: "ffmpeg",
        preset: "webm-vp9",
        outputPath: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.webm")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.webm"), status: "planned", mediaType: "video/webm", primary: true })
      ])
    });
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      operation: "connector.canvas_to_mp4",
      output: {
        render: { ok: true, dryRun: true, lane: "ffmpeg", preset: "webm-vp9" }
      }
    });
  });

  it("exports a Canvas bridge frame-selection artifact from the CLI", async () => {
    const canvasRoot = await writeCanvasBridgeRoot();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-bridge-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "frame-selection.json");
    const previousTrustedRoots = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = canvasRoot;

    try {
      const result = await runCli([
        "connector",
        "canvas-bridge-export",
        canvasRoot,
        "--out",
        outPath,
        "--target",
        "cli",
        "--project-name",
        "CLI Canvas Project",
        "--frame-name",
        "CLI Hero",
        "--selected-ids",
        "rect-blue,heading",
        "--generated-at",
        "2026-07-02T12:00:00.000Z"
      ]);
      const receipt = JSON.parse(await readFile(join(outDir, "canvas-bridge-export.receipt.json"), "utf8")) as Record<string, any>;

      expect(result).toMatchObject({
        ok: true,
        command: "connector.canvas-bridge-export",
        path: outPath,
        receiptPath: join(outDir, "canvas-bridge-export.receipt.json"),
        schema: "shellx-canvas/frame-selection@1",
        selectedFrameId: "frame_cli",
        layerIds: ["rect-blue", "heading"],
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "canvas_frame_selection", path: outPath, status: "available", primary: true }),
          expect.objectContaining({ role: "connector_receipt", path: join(outDir, "canvas-bridge-export.receipt.json"), status: "available" })
        ])
      });
      expect(receipt).toMatchObject({
        operation: "canvas.bridge_export",
        status: "passed",
        output: {
          path: outPath,
          selectedFrameId: "frame_cli",
          layerIds: ["rect-blue", "heading"]
        }
      });
    } finally {
      if (previousTrustedRoots === undefined) {
        delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
      } else {
        process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = previousTrustedRoots;
      }
    }
  });

  it("uses CLI --force to replace both a Canvas selection and its fixed sibling receipt", async () => {
    const canvasRoot = await writeCanvasBridgeRoot();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-bridge-force-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "frame-selection.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    const previousTrustedRoots = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = canvasRoot;
    await writeFile(outPath, "MY SELECTION", "utf8");
    await writeFile(receiptPath, "MY RECEIPT", "utf8");

    try {
      const refused = await runCli(["connector", "canvas-bridge-export", canvasRoot, "--out", outPath]);
      expect(refused).toMatchObject({ ok: false, error: { code: "output_path_exists" } });
      expect(await readFile(outPath, "utf8")).toBe("MY SELECTION");
      expect(await readFile(receiptPath, "utf8")).toBe("MY RECEIPT");

      const result = await runCli(["connector", "canvas-bridge-export", canvasRoot, "--out", outPath, "--force"]);
      expect(result).toMatchObject({ ok: true, path: outPath, receiptPath });
      expect(await readFile(outPath, "utf8")).toContain("shellx-canvas/frame-selection@1");
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
        operation: "canvas.bridge_export",
        output: { path: outPath, receiptPath }
      });
    } finally {
      if (previousTrustedRoots === undefined) {
        delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
      } else {
        process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = previousTrustedRoots;
      }
    }
  });

  it("ignores caller-supplied Canvas bridge trust roots from the CLI", async () => {
    const canvasRoot = await writeCanvasBridgeRoot();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-bridge-arg-trust-"));
    tempDirs.push(outDir);
    const previousTrustedRoots = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;

    try {
      const result = await runCli([
        "connector",
        "canvas-bridge-export",
        canvasRoot,
        "--out",
        join(outDir, "frame-selection.json"),
        "--trusted-canvas-root",
        canvasRoot
      ]);

      expect(result).toMatchObject({
        ok: false,
        command: "connector.canvas-bridge-export",
        error: {
          code: "canvas_bridge_untrusted",
          message: expect.stringContaining("not a trusted Design Studio checkout")
        }
      });
    } finally {
      if (previousTrustedRoots === undefined) {
        delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
      } else {
        process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = previousTrustedRoots;
      }
    }
  });

  it("wires a root Canvas-to-MP4 smoke script for host verification", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve("../../scripts/connector-canvas-mp4-smoke.ts");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["connector:canvas-mp4-smoke"]).toBe("tsx scripts/connector-canvas-mp4-smoke.ts");
    expect(scriptSource).toContain("connector");
    expect(scriptSource).toContain("canvas-to-mp4");
    expect(scriptSource).toContain("fixtures/canvas/shape-text-frame-selection.json");
    expect(scriptSource).not.toContain("--dry-run-render");
    expect(scriptSource).toContain("render.frameLane");
    expect(scriptSource).toContain("status\", \"rendered_media.status\") === \"available\"");
    expect(scriptSource).toContain("video/mp4");
    expect(scriptSource).toContain("quality-check");
    expect(scriptSource).toContain("--preview-package");
  });

  it("wires a root Canvas bridge export smoke script for host verification", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve("../../scripts/connector-canvas-bridge-smoke.ts");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["connector:canvas-bridge-smoke"]).toBe("tsx scripts/connector-canvas-bridge-smoke.ts");
    expect(scriptSource).toContain("SHELLX_CANVAS_ROOT");
    expect(scriptSource).toContain("canvas-bridge-export");
    expect(scriptSource).toContain("canvas-bridge-export.receipt.json");
    expect(scriptSource).toContain("connector.canvas-bridge-smoke");
  });

  it("wires a root Canvas bridge to MP4 smoke script for real Canvas export verification", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve("../../scripts/connector-canvas-bridge-mp4-smoke.ts");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["connector:canvas-bridge-mp4-smoke"]).toBe("tsx scripts/connector-canvas-bridge-mp4-smoke.ts");
    expect(scriptSource).toContain("SHELLX_CANVAS_ROOT");
    expect(scriptSource).toContain("canvas-bridge-export");
    expect(scriptSource).toContain("canvas-to-mp4");
    expect(scriptSource).toContain("canvas-mp4-export.receipt.json");
    expect(scriptSource).toContain("--preview-package");
    expect(scriptSource).toContain("--preview-lane");
    expect(scriptSource).toContain("--compare-rgb-only");
    expect(scriptSource).toContain("--min-psnr-db");
    expect(scriptSource).toContain("connector.canvas-bridge-mp4-smoke");
  });

  it("wires a root Script-to-Cut smoke script for host verification", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve("../../scripts/connector-script-cut-smoke.ts");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["connector:script-cut-smoke"]).toBe("tsx scripts/connector-script-cut-smoke.ts");
    expect(scriptSource).toContain("scripted-video@1");
    expect(scriptSource).toContain("connector");
    expect(scriptSource).toContain("script-to-cut");
    expect(scriptSource).not.toContain("--dry-run-render");
    expect(scriptSource).toContain("render.frameLane");
    expect(scriptSource).toContain("status\", \"rendered_media.status\") === \"available\"");
    expect(scriptSource).toContain("video/mp4");
    expect(scriptSource).toContain("quality-check");
    expect(scriptSource).toContain("--preview-package");
    expect(scriptSource).toContain("assertPrivateRepoScratchPath(repoRoot, outDir)");
    expect(scriptSource).toContain("mode: 0o700");
  });

  it("wires a root Template-to-Cut rendered-media smoke script for host verification", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/connector-template-cut-render-smoke.ts");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["connector:template-cut-render-smoke"]).toBe("tsx scripts/connector-template-cut-render-smoke.ts");
    expect(scriptSource).toContain("connector");
    expect(scriptSource).toContain("template-to-cut");
    expect(scriptSource).toContain("fixtures/packages/editable-lower-third");
    expect(scriptSource).toContain("rendered_media");
    expect(scriptSource).not.toContain("--dry-run-render");
    expect(scriptSource).not.toContain("join(outDir, \"source-package\")");
    expect(scriptSource).toContain("status\", \"rendered_media.status\") === \"available\"");
    expect(scriptSource).toContain('artifact_handle.status") === "available"');
    expect(scriptSource).toContain("video/mp4");
    expect(scriptSource).toContain("quality-check");
    expect(scriptSource).toContain("--preview-package");
    expect(scriptSource).toContain("assertPrivateRepoScratchPath(repoRoot, outDir)");
    expect(scriptSource).toContain("0o700");
  });

  it("wires the real Canvas-to-Cut P2B smoke as a plan-only handoff", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve("../../scripts/connector-canvas-cut-smoke.ts");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["connector:canvas-cut-smoke"]).toBe("tsx scripts/connector-canvas-cut-smoke.ts");
    expect(scriptSource).toContain("SHELLX_CANVAS_ROOT");
    expect(scriptSource).toContain("canvas-to-cut");
    expect(scriptSource).not.toContain("--dry-run-render");
    expect(scriptSource).toContain("rendered_media.mediaType");
    expect(scriptSource).toContain("artifact_handle.status");
    expect(scriptSource).toContain("verifyAttestedArtifactHandleReference");
    expect(scriptSource).toContain("render.frameLane");
    expect(scriptSource).toContain("cutApplication");
    expect(scriptSource).not.toContain("SHELLX_CUT_ROOT");
    expect(scriptSource).not.toContain("SHELLX_MOTION_CUT_CARGO_TARGET_DIR");
    expect(scriptSource).not.toContain("--cut-root");
  });

  it("makes the fixture P2B Canvas smoke repeatable without force", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptSource = await readFile(resolve("../../scripts/connector-canvas-fixture-cut-smoke.ts"), "utf8");

    expect(packageJson.scripts["connector:smoke"]).toBe("tsx scripts/connector-canvas-fixture-cut-smoke.ts");
    expect(scriptSource).toContain("assertPrivateRepoScratchPath(repoRoot, outDir)");
    expect(scriptSource).toContain("await rm(outDir, { recursive: true, force: true })");
    expect(scriptSource).toContain("canvas-to-cut");
    expect(scriptSource).not.toContain("--force");
    expect(scriptSource).not.toContain("--dry-run-render");
  });

  it("wires a receipt-producing platform verification runner for host gates", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const scriptSource = await readFile(scriptPath, "utf8");

    expect(packageJson.scripts["platform:verify"]).toBe("node scripts/platform-verify.mjs");
    expect(scriptSource).toContain("cmd.exe");
    expect(scriptSource).toContain("WINDOWS_EXECUTABLE_SUFFIXES");
    expect(scriptSource).toContain("windowsVerbatimArguments: true");
    expect(scriptSource).toContain("\"/c\", \"pnpm\"");

    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--dry-run",
      "--json",
      "--host-id",
      "windows",
      "--required-hosts",
      "linux,windows,macos"
    ], {
      cwd: resolve("../..")
    });
    const receipt = JSON.parse(stdout) as Record<string, any>;

    expect(receipt).toMatchObject({
      schema: "shellx-motion/platform-verification@1",
      status: "planned",
      toolchain: { status: "planned", exact: false, bundledCodecs: false },
      host: {
        id: "windows",
        platform: process.platform,
        arch: process.arch
      },
      hostMatrix: {
        required: ["linux", "windows", "macos"],
        current: "windows",
        currentRequired: true,
        satisfied: ["windows"],
        missing: ["linux", "macos"],
        complete: false,
        status: "partial"
      }
    });
    const { stdout: whitespaceStdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--dry-run",
      "--json",
      "--host-id",
      "windows",
      "--required-hosts",
      "linux windows macos"
    ], {
      cwd: resolve("../..")
    });
    const whitespaceReceipt = JSON.parse(whitespaceStdout) as Record<string, any>;
    expect(whitespaceReceipt.hostMatrix).toMatchObject({
      required: ["linux", "windows", "macos"],
      current: "windows",
      currentRequired: true,
      satisfied: ["windows"],
      missing: ["linux", "macos"],
      complete: false,
      status: "partial"
    });
    // The ladder itself is NOT restated here. It used to be, and adding two commands during cross-host verification
    // broke five tests that were only ever asserting "the list equals the list I copied". What is
    // asserted instead are the invariants a correct ladder must satisfy, each checkable against a
    // source the plan does not derive from — so this cannot pass by agreeing with itself.
    const planned = receipt.commands as Array<{ id: string; command: string[]; required: boolean; requiresEnv?: string[]; category: string; platforms?: string[] }>;
    const plannedIds = planned.map((command) => command.id);
    const requiredIds = planned.filter((command) => command.required === true).map((command) => command.id);
    const optionalIds = planned.filter((command) => command.required !== true).map((command) => command.id);

    // 1. The ladder is real: non-empty, both classes populated, no duplicate ids.
    expect(planned.length).toBeGreaterThanOrEqual(30);
    expect(requiredIds.length).toBeGreaterThanOrEqual(25);
    expect(optionalIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(plannedIds).size).toBe(plannedIds.length);

    // 2. Named anchors that must never silently leave the required set. Deliberately a floor rather
    // than the whole list: these are the gates whose absence would mean the ladder stopped proving
    // something (install/typecheck/test, the codec matrix, the browser lane, the Cut handoff), and
    // the floor does not churn every time a command is added.
    for (const id of [
      "install", "typecheck", "test",
      "render-mp4:smoke", "render-webm:smoke", "render-hevc:smoke", "render-av1:smoke",
      "render-gif:smoke", "render-alpha:smoke", "render-audio:smoke",
      "ffmpeg-acceleration:smoke", "sandbox:probe", "tracking:smoke",
      "browser:capture-smoke", "connector:smoke", "connector:template-cut-render-smoke"
    ]) {
      expect(requiredIds).toContain(id);
    }
    expect(planned.find((command) => command.id === "connector:template-cut-render-smoke")).toMatchObject({
      required: true,
      platforms: ["linux"]
    });
    for (const id of [
      "agent:smoke", "debug-server-prompt:smoke", "canvas-package-preview:smoke",
      "evidence-surfaces:smoke", "source-storyboard:smoke", "render-job-lifecycle:smoke",
      "connector:smoke", "connector:canvas-mp4-smoke",
      "connector:script-cut-smoke", "connector:canvas-cut-smoke"
    ]) {
      expect(planned.find((command) => command.id === id)).toMatchObject({ platforms: ["linux"] });
    }
    // Ordering that the runner depends on: dependencies install before anything is typechecked or run.
    expect(plannedIds.slice(0, 3)).toEqual(["install", "typecheck", "test"]);

    // 3. Required/optional classification follows the ladder's own declared rule, checked as a rule
    // rather than per command: a command gated on a host checkout is optional (it must skip, not
    // fail, where the checkout is absent), and a command with no env gate is required.
    for (const command of planned) {
      const envGated = Array.isArray(command.requiresEnv) && command.requiresEnv.length > 0;
      expect({ id: command.id, required: command.required }).toEqual({ id: command.id, required: !envGated });
      if (envGated) {
        expect(command.requiresEnv?.every((name) => name === "SHELLX_CUT_ROOT" || name === "SHELLX_CANVAS_ROOT")).toBe(true);
      }
    }

    // 4. Every planned command is one this repository can actually run — checked against
    // package.json, which is an independent source the plan is not generated from. A typo'd id
    // would plan a command that fails on every host with "no such script".
    for (const command of planned) {
      expect(command.command[0]).toBe("pnpm");
      if (command.command[1] === "run") {
        expect(Object.keys(packageJson.scripts)).toContain(command.command[2]);
      } else {
        expect(Object.keys(packageJson.scripts).concat(["install", "typecheck", "test"])).toContain(command.command[1]);
      }
    }

    // 5. The extended tier is a real, separate tier: opting in adds commands and removes none.
    const { stdout: extendedStdout } = await execFile(process.execPath, [
      scriptPath, "--", "--dry-run", "--json", "--include-extended"
    ], { cwd: resolve("../..") });
    const extendedCommands = JSON.parse(extendedStdout).commands as Array<{ id: string; platforms?: string[] }>;
    const extendedIds = extendedCommands.map((command) => command.id);
    expect(extendedIds.length).toBeGreaterThan(plannedIds.length);
    for (const id of plannedIds) expect(extendedIds).toContain(id);
    expect(extendedCommands.find((command) => command.id === "template-pack:proof")).toMatchObject({ platforms: ["linux"] });

    // The doc is held to the plan mechanically by `scripts/platform-verification-doc-gate.mjs`
    // (wired into `pnpm docs:check`). Asserted here too, because this is the test that ties the
    // runner, the package scripts and the published ladder together: every required command a host
    // is told to run must appear in the document a human follows.
    const platformDocs = await readFile(resolve("../../docs/public/PLATFORM_VERIFICATION.md"), "utf8");
    for (const command of planned.filter((entry) => entry.required === true)) {
      expect(platformDocs).toContain(command.command.join(" "));
    }
    expect(platformDocs).toContain("WebSocket JSON-RPC");
  });

  it("records exact local runtime, package-manager, codec binary, and encoder identities", async () => {
    const sourceScriptPath = resolve("../../scripts/platform-verify.mjs");
    const exactRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-exact-workspace-"));
    tempDirs.push(exactRoot);
    const scriptPath = join(exactRoot, "scripts", "platform-verify.mjs");
    await mkdir(dirname(scriptPath), { recursive: true });
    await copyFile(sourceScriptPath, scriptPath);
    await copyFile(resolve("../../scripts/repo-scratch.mjs"), join(exactRoot, "scripts", "repo-scratch.mjs"));
    await copyFile(resolve("../../scripts/platform-verification-schema.mjs"), join(exactRoot, "scripts", "platform-verification-schema.mjs"));
    await mkdir(join(exactRoot, "schemas"), { recursive: true });
    await copyFile(resolve("../../schemas/platform-verification.schema.json"), join(exactRoot, "schemas", "platform-verification.schema.json"));
    await writeFile(join(exactRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await execFile("git", ["init", "--quiet", exactRoot]);
    await execFile("git", ["-C", exactRoot, "add", "scripts/platform-verify.mjs", "scripts/platform-verification-schema.mjs", "scripts/repo-scratch.mjs", "schemas/platform-verification.schema.json", "pnpm-lock.yaml"]);
    await execFile("git", ["-C", exactRoot, "-c", "user.name=ShellX Motion Test", "-c", "user.email=motion-test@localhost", "commit", "--quiet", "-m", "exact workspace fixture"]);
    const env = { ...process.env };
    delete env.SHELLX_CANVAS_ROOT;
    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--run",
      "--json",
      "--required-hosts",
      "none",
      "--only",
      "connector:canvas-cut-smoke",
      "--require-exact-toolchain"
    ], { cwd: exactRoot, env });
    const receipt = JSON.parse(stdout) as Record<string, any>;

    expect(receipt).toMatchObject({
      status: "passed",
      toolchain: {
        status: "passed",
        exact: true,
        workspace: {
          status: "passed",
          exact: true,
          commit: expect.stringMatching(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
          trackedDirty: false,
          lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        node: { status: "passed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), version: process.version },
        pnpm: { status: "passed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ffmpeg: { status: "passed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ffprobe: { status: "passed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        encoders: {
          status: "passed",
          capabilities: { h264: true, vp9: true, prores: true }
        }
      },
      commands: [expect.objectContaining({ id: "connector:canvas-cut-smoke", status: "skipped" })]
    });

    // This fixture is a BARE copy of the script in an empty git repo — no node_modules, no
    // packages/ — so Motion's TypeScript resolver cannot be reached and the run must degrade to
    // env/PATH resolution and SAY SO, rather than silently claiming Motion-resolved identity.
    expect(receipt.toolchain.codecResolution).toBe("path-fallback");
    expect(typeof receipt.toolchain.codecResolutionReason).toBe("string");

    // No absolute path reaches the receipt: it names a user's home directory and install layout and
    // is not shareable evidence. The sha256/byteLength/version/source are the identity that matters.
    for (const tool of ["node", "pnpm", "ffmpeg", "ffprobe"]) {
      expect(receipt.toolchain[tool]).not.toHaveProperty("path");
      expect(receipt.toolchain[tool]).not.toHaveProperty("resolvedPath");
      expect(["override", "shellx-family", "path"]).toContain(receipt.toolchain[tool].source);
    }
    expect(JSON.stringify(receipt.toolchain)).not.toContain(exactRoot);
  });

  it("records the codec toolchain Motion will actually spawn, not a separate PATH lookup", async () => {
    // The receipt must identify the FFmpeg binary Motion actually spawns. Recording PATH FFmpeg
    // while rendering with the ShellX-family bundled binary makes `--require-exact-toolchain` attest to a
    // binary that produced none of the media beside it. Run in the real workspace, where the
    // TypeScript resolver IS reachable.
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const { stdout } = await execFile(process.execPath, [
      scriptPath, "--", "--run", "--json", "--required-hosts", "none", "--only", "connector:canvas-cut-smoke"
    ], { cwd: resolve("../.."), maxBuffer: 32 * 1024 * 1024 });
    const receipt = JSON.parse(stdout) as Record<string, any>;

    expect(receipt.toolchain.codecResolution).toBe("motion-resolver");

    // The receipt's provenance must equal what Motion's own resolver reports for the same host —
    // asserted against the resolver rather than against a hardcoded expectation, because the whole
    // defect was these two answering differently.
    const { stdout: resolverStdout } = await execFile(process.execPath, [
      "--import", "tsx", resolve("../../scripts/motion-tool-resolution.ts")
    ], { cwd: resolve("../..") });
    const resolved = JSON.parse(resolverStdout) as Record<string, { executable: string; source: string }>;
    expect(receipt.toolchain.ffmpeg.source).toBe(resolved.ffmpeg.source);
    expect(receipt.toolchain.ffprobe.source).toBe(resolved.ffprobe.source);

    // The encoder inventory must come from that same executable, or the hevc/av1 capability gate
    // could consult a different binary than the one that encodes.
    expect(receipt.toolchain.encoders.status).toBe("passed");
    expect(receipt.toolchain.ffmpeg.version).toEqual(expect.stringContaining("ffmpeg version"));
  });

  it("enforces collected platform verification receipts for every required host", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-receipts-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux"),
      writePlatformReceipt(tempRoot, "windows"),
      writePlatformReceipt(tempRoot, "macos")
    ]);

    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--json"
    ], {
      cwd: resolve("../..")
    });
    const aggregate = JSON.parse(stdout) as Record<string, any>;

    expect(aggregate).toMatchObject({
      schema: "shellx-motion/platform-verification-aggregate@1",
      status: "passed",
      requiredHosts: ["linux", "windows", "macos"],
      summary: {
        requiredHostCount: 3,
        satisfiedHostCount: 3,
        missingHosts: [],
        failedHosts: []
      }
    });
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: "linux", status: "passed", dryRun: false }),
      expect.objectContaining({ hostId: "windows", status: "passed", dryRun: false }),
      expect.objectContaining({ hostId: "macos", status: "passed", dryRun: false })
    ]));
    expect(aggregate.summary.platformInapplicableSkips).toHaveLength(20);
    expect(aggregate.summary.platformInapplicableSkips).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: "windows", command: "connector:template-cut-render-smoke", hostPlatform: "win32", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "macos", command: "connector:template-cut-render-smoke", hostPlatform: "darwin", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "windows", command: "source-storyboard:smoke", hostPlatform: "win32", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "windows", command: "connector:script-cut-smoke", hostPlatform: "win32", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "macos", command: "connector:script-cut-smoke", hostPlatform: "darwin", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "windows", command: "connector:smoke", hostPlatform: "win32", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "macos", command: "connector:smoke", hostPlatform: "darwin", platforms: ["linux"] }),
      expect.objectContaining({ hostId: "macos", command: "source-storyboard:smoke", hostPlatform: "darwin", platforms: ["linux"] })
    ]));
  });

  it("rejects a structurally incomplete self-asserted platform receipt", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-forged-receipt-"));
    tempDirs.push(tempRoot);
    const receiptPath = await writePlatformReceipt(tempRoot, "linux");
    const forged = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
    delete forged.repoRoot;
    delete forged.commandSummary;
    delete forged.commands[0].exitCode;
    await writeFile(receiptPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");

    const aggregate = await execPlatformVerifierFailure([
      scriptPath, "--", "--verify-receipts", receiptPath, "--required-hosts", "linux", "--json",
    ]);
    expect(aggregate).toMatchObject({
      status: "failed",
      summary: { invalidReceiptCount: 1, failedHosts: ["linux"] },
      receipts: [expect.objectContaining({ schemaOk: false, ok: false })],
    });
    expect(aggregate.receipts[0].failures).toEqual(expect.arrayContaining([
      expect.stringContaining("receipt schema validation failed"),
    ]));
  });

  it("rejects duplicate command identities in a completed platform receipt", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-duplicate-command-"));
    tempDirs.push(tempRoot);
    const receiptPath = await writePlatformReceipt(tempRoot, "linux");
    const forged = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
    forged.commands[1] = { ...forged.commands[1], id: forged.commands[0].id, command: [...forged.commands[0].command] };
    await writeFile(receiptPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");

    const aggregate = await execPlatformVerifierFailure([
      scriptPath, "--", "--verify-receipts", receiptPath, "--required-hosts", "linux", "--json",
    ]);
    expect(aggregate).toMatchObject({
      status: "failed",
      summary: { invalidReceiptCount: 1, failedHosts: ["linux"] },
      receipts: [expect.objectContaining({ schemaOk: false, ok: false })],
    });
    expect(aggregate.receipts[0].failures[0]).toContain("must be unique");
  });

  it("emits an allowlisted shareable platform projection without local paths or raw output", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const { stdout } = await execFile(process.execPath, [
      scriptPath, "--", "--dry-run", "--json", "--shareable", "--required-hosts", "none",
    ], { cwd: resolve("../..") });
    const projection = JSON.parse(stdout) as Record<string, any>;
    const serialized = JSON.stringify(projection);

    expect(projection).toMatchObject({
      schema: "shellx-motion/platform-verification-shareable@1",
      source: { schema: "shellx-motion/platform-verification@1", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      status: "planned",
      evidence: { host: { id: expect.any(String), platform: expect.any(String) } },
    });
    expect(serialized).not.toContain(resolve("../.."));
    expect(serialized).not.toContain("repoRoot");
    expect(serialized).not.toContain("hostname");
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("stderrTail");
  });

  it("redacts source paths and skip reasons from a shareable platform aggregate", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-shareable-aggregate-"));
    tempDirs.push(tempRoot);
    const receiptPath = await writePlatformReceipt(tempRoot, "windows");
    const privateReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
    const skipped = privateReceipt.commands.find((entry: Record<string, any>) => entry.status === "skipped");
    expect(skipped).toBeDefined();
    skipped.skipReason = `Not applicable; private source is ${tempRoot}`;
    privateReceipt.toolchain.status = tempRoot;
    privateReceipt.toolchain.workspace = {
      status: tempRoot,
      exact: false,
      commit: tempRoot,
      trackedDirty: false,
      lockfileSha256: tempRoot,
    };
    privateReceipt.toolchain.node = { sha256: tempRoot };
    privateReceipt.toolchain.encoders = { capabilities: { h264: true, privateDiagnostic: tempRoot } };
    await writeFile(receiptPath, `${JSON.stringify(privateReceipt, null, 2)}\n`, "utf8");

    const { stdout } = await execFile(process.execPath, [
      scriptPath, "--", "--verify-receipts", receiptPath, "--required-hosts", "windows", "--json", "--shareable",
    ], { cwd: resolve("../..") });
    const projection = JSON.parse(stdout) as Record<string, any>;
    const serialized = JSON.stringify(projection);

    expect(projection).toMatchObject({
      schema: "shellx-motion/platform-verification-shareable@1",
      source: { schema: "shellx-motion/platform-verification-aggregate@1" },
      status: "passed",
    });
    expect(serialized).not.toContain(tempRoot);
    expect(serialized).not.toContain("skipReason");
    expect(serialized).not.toContain("privateDiagnostic");
    expect(serialized).not.toContain("path");
  });

  it("does not disclose an unreadable receipt path through the shareable aggregate", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-shareable-unreadable-"));
    tempDirs.push(tempRoot);
    const unreadablePath = join(tempRoot, "missing-private-receipt.json");

    const projection = await execPlatformVerifierFailure([
      scriptPath, "--", "--verify-receipts", unreadablePath, "--required-hosts", "linux", "--json", "--shareable",
    ]);
    const serialized = JSON.stringify(projection);
    expect(projection).toMatchObject({
      schema: "shellx-motion/platform-verification-shareable@1",
      source: { schema: "shellx-motion/platform-verification-aggregate@1" },
      status: "failed",
    });
    expect(serialized).not.toContain(tempRoot);
    expect(serialized).not.toContain("missing-private-receipt");
    expect(serialized).not.toContain("path");
  });

  it("rejects a forged Linux platform-inapplicable Template-to-Cut skip", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-p2a-forged-skip-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all(["linux", "windows", "macos"].map((hostId) => writePlatformReceipt(tempRoot, hostId)));
    const linuxReceipt = JSON.parse(await readFile(receiptPaths[0]!, "utf8")) as Record<string, any>;
    const p2a = linuxReceipt.commands.find((command: { id?: string }) => command.id === "connector:template-cut-render-smoke");
    p2a.status = "skipped";
    p2a.skipKind = "platform-inapplicable";
    p2a.skipReason = "forged Linux exemption";
    await writeFile(receiptPaths[0]!, `${JSON.stringify(linuxReceipt, null, 2)}\n`, "utf8");

    const aggregate = await execPlatformVerifierFailure([
      scriptPath, "--", "--verify-receipts", ...receiptPaths, "--required-hosts", "linux,windows,macos", "--json"
    ]);
    expect(aggregate).toMatchObject({ status: "failed" });
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "linux",
        ok: false,
        failures: expect.arrayContaining(["required command skipped (platform-inapplicable): connector:template-cut-render-smoke"])
      })
    ]));
  });

  it("can require exact and ShellX-bundled codec evidence from every collected host", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-toolchain-receipts-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux", { exactToolchain: true, bundledCodecs: true }),
      writePlatformReceipt(tempRoot, "windows", { exactToolchain: true, bundledCodecs: true }),
      writePlatformReceipt(tempRoot, "macos", { exactToolchain: true, bundledCodecs: true })
    ]);
    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--require-bundled-codecs",
      "--json"
    ], { cwd: resolve("../..") });
    const aggregate = JSON.parse(stdout) as Record<string, any>;

    expect(aggregate).toMatchObject({
      status: "passed",
      exactToolchainRequired: true,
      bundledCodecsRequired: true,
      summary: { satisfiedHostCount: 3, failedHosts: [] }
    });
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: "windows", toolchain: expect.objectContaining({ exact: true, bundledCodecs: true }) })
    ]));
  });

  it("rejects exact-toolchain receipts without exact clean workspace identity", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-workspace-receipts-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux", { exactToolchain: true, workspaceIdentityInvalid: true }),
      writePlatformReceipt(tempRoot, "windows", { exactToolchain: true }),
      writePlatformReceipt(tempRoot, "macos", { exactToolchain: true })
    ]);
    const aggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--require-exact-toolchain",
      "--json"
    ]);

    expect(aggregate.status).toBe("failed");
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "linux",
        ok: false,
        toolchain: expect.objectContaining({ exact: false, workspace: expect.objectContaining({ exact: false }) }),
        failures: expect.arrayContaining(["exact toolchain evidence is missing or failed"])
      })
    ]));
  });

  it("rejects exact host receipts produced from different workspace identities", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-cross-host-identity-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux", { exactToolchain: true }),
      writePlatformReceipt(tempRoot, "windows", { exactToolchain: true }),
      writePlatformReceipt(tempRoot, "macos", { exactToolchain: true, workspaceCommit: "f".repeat(40) })
    ]);
    const aggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--require-exact-toolchain",
      "--json"
    ]);

    expect(aggregate).toMatchObject({
      status: "failed",
      summary: {
        failedHosts: ["macos"],
        workspaceIdentityMismatchCount: 1,
        workspaceIdentityMismatchHosts: ["macos"]
      }
    });
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "macos",
        ok: false,
        failures: expect.arrayContaining([expect.stringContaining("workspace identity mismatch")])
      })
    ]));
  });

  it("fails platform receipt enforcement when a required host is missing", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-missing-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux"),
      writePlatformReceipt(tempRoot, "windows")
    ]);

    const aggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--json"
    ]);

    expect(aggregate).toMatchObject({
      status: "failed",
      summary: {
        missingHosts: ["macos"],
        failedHosts: ["macos"]
      }
    });
  });

  it("fails platform receipt enforcement when host ids are duplicated", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-duplicate-host-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux", { suffix: "fresh" }),
      writePlatformReceipt(tempRoot, "linux", { suffix: "stale" }),
      writePlatformReceipt(tempRoot, "windows"),
      writePlatformReceipt(tempRoot, "macos")
    ]);

    const aggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--json"
    ]);

    expect(aggregate).toMatchObject({
      status: "failed",
      summary: {
        duplicateHosts: ["linux"],
        failedHosts: ["linux"]
      }
    });
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "linux",
        ok: false,
        failures: expect.arrayContaining(["duplicate receipt host id: linux"])
      })
    ]));
  });

  it("fails platform receipt enforcement when a canonical host reports the wrong platform", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-mismatch-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux"),
      writePlatformReceipt(tempRoot, "windows", { platform: "linux" }),
      writePlatformReceipt(tempRoot, "macos")
    ]);

    const aggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--json"
    ]);

    expect(aggregate).toMatchObject({
      status: "failed",
      summary: {
        failedHosts: ["windows"]
      }
    });
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "windows",
        hostPlatform: "linux",
        expectedPlatform: "win32",
        ok: false,
        failures: expect.arrayContaining(["receipt host platform mismatch: windows requires win32, got linux"])
      })
    ]));
  });

  it("fails platform receipt enforcement for dry-run or failed host evidence", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-failed-"));
    tempDirs.push(tempRoot);
    const dryRunPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux"),
      writePlatformReceipt(tempRoot, "windows", { dryRun: true, status: "planned" }),
      writePlatformReceipt(tempRoot, "macos")
    ]);
    const failedPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux", { suffix: "failed" }),
      writePlatformReceipt(tempRoot, "windows", { suffix: "failed" }),
      writePlatformReceipt(tempRoot, "macos", { suffix: "failed", failedCommandId: "test" })
    ]);

    const dryRunAggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...dryRunPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--json"
    ]);
    const failedAggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...failedPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--json"
    ]);

    expect(dryRunAggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: "windows", status: "planned", dryRun: true, ok: false, failures: expect.arrayContaining(["receipt is dry-run/planned evidence"]) })
    ]));
    expect(failedAggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: "macos", ok: false, failures: expect.arrayContaining(["required command failed: test"]) })
    ]));
  });

  itLinux("skips optional platform connector gates when required checkout env is absent", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const env = { ...process.env };
    delete env.SHELLX_CANVAS_ROOT;

    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--run",
      "--json",
      "--required-hosts",
      "none",
      "--only",
      "connector:canvas-cut-smoke"
    ], {
      cwd: resolve("../.."),
      env
    });
    const receipt = JSON.parse(stdout) as Record<string, any>;

    expect(receipt.status).toBe("passed");
    expect(receipt.commands).toEqual([
      expect.objectContaining({
        id: "connector:canvas-cut-smoke",
        required: false,
        requiresEnv: ["SHELLX_CANVAS_ROOT"],
        status: "skipped",
        skipReason: "Missing required environment variables: SHELLX_CANVAS_ROOT."
      })
    ]);
  });

  itLinux("fails required platform connector gates when required checkout env is absent", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const env = { ...process.env };
    delete env.SHELLX_CANVAS_ROOT;

    const receipt = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--run",
      "--json",
      "--required-hosts",
      "none",
      "--only",
      "connector:canvas-cut-smoke",
      "--require-host-connectors"
    ], { env });

    expect(receipt.status).toBe("failed");
    expect(receipt.commands).toEqual([
      expect.objectContaining({
        id: "connector:canvas-cut-smoke",
        required: true,
        requiresEnv: ["SHELLX_CANVAS_ROOT"],
        status: "failed",
        skipReason: "Missing required environment variables: SHELLX_CANVAS_ROOT."
      })
    ]);
  });

  it("fails platform verification when a command cannot be spawned", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const env = { ...process.env, PATH: "/tmp/shellx-motion-missing-platform-bin" };
    const expectedSpawnFailure = process.platform === "win32" ? "spawnSync cmd.exe ENOENT" : "spawnSync pnpm ENOENT";

    const receipt = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--run",
      "--json",
      "--required-hosts",
      "none",
      "--only",
      "validate:fixtures"
    ], { env });

    expect(receipt).toMatchObject({
      schema: "shellx-motion/platform-verification@1",
      status: "failed",
      dryRun: false,
      commands: [
        expect.objectContaining({
          id: "validate:fixtures",
          status: "failed",
          exitCode: 127,
          stderrTail: expect.stringContaining(expectedSpawnFailure)
        })
      ]
    });
  });

  it("captures large platform command output without pipe deadlocks", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-large-output-"));
    tempDirs.push(tempRoot);
    const binDir = join(tempRoot, "bin");
    await mkdir(binDir, { recursive: true });
    const fakePnpm = join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    const largeOutputScript = process.platform === "win32"
      ? `@echo off\r\nfor /L %%i in (1,1,12000) do @echo shellx-motion-platform-large-output\r\nexit /b 0\r\n`
      : `#!/bin/sh\nfor i in $(seq 1 12000); do echo shellx-motion-platform-large-output; done\nexit 0\n`;
    await writeFile(fakePnpm, largeOutputScript);
    if (process.platform !== "win32") {
      await chmod(fakePnpm, 0o755);
    }

    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--",
      "--run",
      "--json",
      "--required-hosts",
      "none",
      "--only",
      "validate:fixtures"
    ], {
      cwd: resolve("../.."),
      env: { ...process.env, PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
      timeout: 10_000
    });
    const receipt = JSON.parse(stdout) as Record<string, any>;

    expect(receipt.status).toBe("passed");
    expect(receipt.commands).toEqual([
      expect.objectContaining({
        id: "validate:fixtures",
        status: "passed",
        stdoutTail: expect.stringContaining("shellx-motion-platform-large-output")
      })
    ]);
    expect(receipt.commands[0].stdoutTail.length).toBeLessThanOrEqual(4000);
  });

  it("requires host connector command receipts when aggregating phase two connector evidence", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-required-connectors-"));
    tempDirs.push(tempRoot);
    const receiptPaths = await Promise.all([
      writePlatformReceipt(tempRoot, "linux"),
      writePlatformReceipt(tempRoot, "windows"),
      writePlatformReceipt(tempRoot, "macos")
    ]);

    const aggregate = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--verify-receipts",
      ...receiptPaths,
      "--required-hosts",
      "linux,windows,macos",
      "--require-host-connectors",
      "--json"
    ]);

    expect(aggregate.status).toBe("failed");
    expect(aggregate.requiredCommands).toEqual(expect.arrayContaining([
      "connector:canvas-bridge-smoke",
      "connector:canvas-bridge-mp4-smoke",
      "connector:canvas-cut-smoke"
    ]));
    expect(aggregate.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "linux",
        ok: false,
        failures: expect.arrayContaining(["required command missing: connector:canvas-cut-smoke"])
      })
    ]));
  });

  it("fails platform verification commands that exceed the configured timeout", async () => {
    const scriptPath = resolve("../../scripts/platform-verify.mjs");

    const receipt = await execPlatformVerifierFailure([
      scriptPath,
      "--",
      "--run",
      "--json",
      "--required-hosts",
      "none",
      "--only",
      "validate:fixtures",
      "--command-timeout-ms",
      "1"
    ]);

    expect(receipt).toMatchObject({
      schema: "shellx-motion/platform-verification@1",
      status: "failed",
      dryRun: false,
      commands: [
        expect.objectContaining({
          id: "validate:fixtures",
          status: "failed",
          timedOut: true,
          timeoutMs: 1,
          stderrTail: expect.stringContaining("Platform verification command validate:fixtures timed out after 1ms.")
        })
      ]
    });
  });

  it("wires package archive, Canvas package preview, evidence surfaces, modern codecs, audio, captions, alpha, GIF, JPEG, batch, deterministic browser workflow, agent-unavailable, render job lifecycle, and debug server smoke scripts for host verification", async () => {
    const packageJson = JSON.parse(await readFile(resolve("../../package.json"), "utf8")) as Record<string, any>;
    const packageArchiveScriptPath = resolve("../../scripts/package-archive-smoke.ts");
    const canvasPackagePreviewScriptPath = resolve("../../scripts/canvas-package-preview-smoke.ts");
    const evidenceSurfacesScriptPath = resolve("../../scripts/evidence-surfaces-smoke.ts");
    const agentSmokeScriptPath = resolve("../../scripts/prompt-execution-smoke.ts");
    const agentUnavailableScriptPath = resolve("../../scripts/prompt-unavailable-smoke.ts");
    const mp4ScriptPath = resolve("../../scripts/render-mp4-smoke.ts");
    const modernCodecScriptPath = resolve("../../scripts/render-modern-codec-smoke.ts");
    const webmScriptPath = resolve("../../scripts/render-webm-smoke.ts");
    const audioScriptPath = resolve("../../scripts/render-audio-smoke.ts");
    const captionScriptPath = resolve("../../scripts/render-caption-smoke.ts");
    const alphaScriptPath = resolve("../../scripts/render-alpha-smoke.ts");
    const gifScriptPath = resolve("../../scripts/render-gif-smoke.ts");
    const jpegScriptPath = resolve("../../scripts/render-jpeg-smoke.ts");
    const batchScriptPath = resolve("../../scripts/render-batch-smoke.ts");
    const browserScriptPath = resolve("../../scripts/browser-workflow-smoke.ts");
    const lifecycleScriptPath = resolve("../../scripts/render-job-lifecycle-smoke.ts");
    const debugServerScriptPath = resolve("../../scripts/debug-server-smoke.ts");
    const debugServerPromptScriptPath = resolve("../../scripts/debug-server-prompt-smoke.ts");
    const packageArchiveScriptSource = await readFile(packageArchiveScriptPath, "utf8");
    const canvasPackagePreviewScriptSource = await readFile(canvasPackagePreviewScriptPath, "utf8");
    const evidenceSurfacesScriptSource = await readFile(evidenceSurfacesScriptPath, "utf8");
    const agentSmokeScriptSource = await readFile(agentSmokeScriptPath, "utf8");
    const agentUnavailableScriptSource = await readFile(agentUnavailableScriptPath, "utf8");
    const mp4ScriptSource = await readFile(mp4ScriptPath, "utf8");
    const modernCodecScriptSource = await readFile(modernCodecScriptPath, "utf8");
    const webmScriptSource = await readFile(webmScriptPath, "utf8");
    const audioScriptSource = await readFile(audioScriptPath, "utf8");
    const captionScriptSource = await readFile(captionScriptPath, "utf8");
    const alphaScriptSource = await readFile(alphaScriptPath, "utf8");
    const gifScriptSource = await readFile(gifScriptPath, "utf8");
    const jpegScriptSource = await readFile(jpegScriptPath, "utf8");
    const batchScriptSource = await readFile(batchScriptPath, "utf8");
    const browserScriptSource = await readFile(browserScriptPath, "utf8");
    const lifecycleScriptSource = await readFile(lifecycleScriptPath, "utf8");
    const debugServerScriptSource = await readFile(debugServerScriptPath, "utf8");
    const debugServerPromptScriptSource = await readFile(debugServerPromptScriptPath, "utf8");

    expect(packageJson.scripts["package-archive:smoke"]).toBe("tsx scripts/package-archive-smoke.ts");
    expect(packageJson.scripts["canvas-package-preview:smoke"]).toBe("tsx scripts/canvas-package-preview-smoke.ts");
    expect(packageJson.scripts["evidence-surfaces:smoke"]).toBe("tsx scripts/evidence-surfaces-smoke.ts");
    expect(packageJson.scripts["sandbox:probe"]).toBe("tsx scripts/sandbox-capability-probe.ts");
    expect(packageJson.scripts["tracking:smoke"]).toBe("tsx scripts/tracking-analysis-smoke.ts");
    expect(packageJson.scripts["agent:smoke"]).toBe("tsx scripts/prompt-execution-smoke.ts");
    expect(packageJson.scripts["agent-unavailable:smoke"]).toBe("tsx scripts/prompt-unavailable-smoke.ts");
    expect(packageJson.scripts["render-mp4:smoke"]).toBe("tsx scripts/render-mp4-smoke.ts");
    expect(packageJson.scripts["ffmpeg-acceleration:smoke"]).toBe("tsx scripts/ffmpeg-acceleration-smoke.ts");
    expect(packageJson.scripts["render-hevc:smoke"]).toBe("tsx scripts/render-modern-codec-smoke.ts mp4-hevc");
    expect(packageJson.scripts["render-av1:smoke"]).toBe("tsx scripts/render-modern-codec-smoke.ts webm-av1");
    expect(packageJson.scripts["render-webm:smoke"]).toBe("tsx scripts/render-webm-smoke.ts");
    expect(packageJson.scripts["render-audio:smoke"]).toBe("tsx scripts/render-audio-smoke.ts");
    expect(packageJson.scripts["render-caption:smoke"]).toBe("tsx scripts/render-caption-smoke.ts");
    expect(packageJson.scripts["render-alpha:smoke"]).toBe("tsx scripts/render-alpha-smoke.ts");
    expect(packageJson.scripts["render-gif:smoke"]).toBe("tsx scripts/render-gif-smoke.ts");
    expect(packageJson.scripts["render-jpeg:smoke"]).toBe("tsx scripts/render-jpeg-smoke.ts");
    expect(packageJson.scripts["render-batch:smoke"]).toBe("tsx scripts/render-batch-smoke.ts");
    expect(packageJson.scripts["browser:capture-smoke"]).toBe("tsx scripts/browser-workflow-smoke.ts");
    expect(packageJson.scripts["render-job-lifecycle:smoke"]).toBe("tsx scripts/render-job-lifecycle-smoke.ts");
    expect(packageJson.scripts["debug-server:smoke"]).toBe("tsx scripts/debug-server-smoke.ts");
    expect(packageJson.scripts["debug-server-prompt:smoke"]).toBe("tsx scripts/debug-server-prompt-smoke.ts");
    expect(packageArchiveScriptSource).toContain("package-archive");
    expect(packageArchiveScriptSource).toContain("package-extract");
    expect(packageArchiveScriptSource).toContain("roundTripPackageRoot");
    expect(packageArchiveScriptSource).toContain("package.archive.extract");
    expect(packageArchiveScriptSource).toContain("preview");
    expect(packageArchiveScriptSource).toContain(".shellxmotion");
    expect(packageArchiveScriptSource).toContain("motion_package_archive");
    expect(packageArchiveScriptSource).toContain("package_archive_receipt");
    expect(packageArchiveScriptSource).toContain("application/x-tar");
    expect(canvasPackagePreviewScriptSource).toContain("motion.canvas.package");
    expect(canvasPackagePreviewScriptSource).toContain("sourceRoot");
    expect(canvasPackagePreviewScriptSource).toContain("copiedAssetRefs");
    expect(canvasPackagePreviewScriptSource).toContain("missingAssetRefs");
    expect(canvasPackagePreviewScriptSource).toContain("resource-catalog.json");
    expect(canvasPackagePreviewScriptSource).toContain("inspectPngFile");
    expect(canvasPackagePreviewScriptSource).toContain("preview");
    expect(evidenceSurfacesScriptSource).toContain("motion.preview.frame");
    expect(evidenceSurfacesScriptSource).toContain("motion.receipts.panel");
    expect(evidenceSurfacesScriptSource).toContain("motion.platform.verification.panel");
    expect(evidenceSurfacesScriptSource).toContain("motion.export.panel");
    expect(evidenceSurfacesScriptSource).toContain("motion.packages.browse");
    expect(evidenceSurfacesScriptSource).toContain("motion.actions.panel");
    expect(evidenceSurfacesScriptSource).toContain("motion.support.bundle");
    expect(evidenceSurfacesScriptSource).toContain("motion.review.html.bundle");
    expect(evidenceSurfacesScriptSource).toContain("motion.connector.canvas_to_cut");
    expect(evidenceSurfacesScriptSource).toContain("dryRunRender: false");
    expect(evidenceSurfacesScriptSource).not.toContain("fake connector mp4 bytes");
    expect(evidenceSurfacesScriptSource).toContain("preview.frame");
    expect(evidenceSurfacesScriptSource).toContain("connector.canvas_to_cut");
    expect(evidenceSurfacesScriptSource).toContain("canvas_selection");
    expect(evidenceSurfacesScriptSource).toContain("rendered_media");
    expect(evidenceSurfacesScriptSource).toContain("cut_plan");
    expect(evidenceSurfacesScriptSource).toContain("connector_receipt");
    expect(evidenceSurfacesScriptSource).toContain("assertArtifactRoles");
    expect(evidenceSurfacesScriptSource).toContain("support-bundle.json");
    expect(evidenceSurfacesScriptSource).toContain("review-html-bundle.html");
    expect(agentSmokeScriptSource).toContain("motion.prompt.run");
    expect(agentSmokeScriptSource).toContain("motion.agent.transcript");
    expect(agentSmokeScriptSource).toContain("structuredOutput");
    expect(agentSmokeScriptSource).toContain("transcript:");
    expect(agentSmokeScriptSource).toContain("agentReceiptId");
    expect(agentSmokeScriptSource).toContain("sessionCount");
    expect(agentSmokeScriptSource).toContain("messageCount");
    expect(agentSmokeScriptSource).toContain("linkedReceiptIds");
    expect(agentUnavailableScriptSource).toContain("agent_unavailable");
    expect(agentUnavailableScriptSource).toContain("No fallback agent was executed");
    expect(agentUnavailableScriptSource).toContain("executeAgentCommands");
    expect(agentUnavailableScriptSource).toContain("operation\", \"prompt.run");
    expect(agentUnavailableScriptSource).toContain("status\", \"failed");
    expect(agentUnavailableScriptSource).toContain("linkedReceiptIds");
    expect(agentUnavailableScriptSource).toContain("assertPathMissing");
    expect(mp4ScriptSource).toContain("keyframed-lower-third");
    expect(mp4ScriptSource).toContain("h264");
    expect(mp4ScriptSource).toContain("video/mp4");
    expect(mp4ScriptSource).toContain("--min-unique-frames");
    expect(mp4ScriptSource).toContain("--preview-package");
    expect(mp4ScriptSource).toContain("--min-psnr-db");
    expect(modernCodecScriptSource).toContain("libx265");
    expect(modernCodecScriptSource).toContain("libsvtav1");
    expect(modernCodecScriptSource).toContain("encoderSource");
    expect(modernCodecScriptSource).toContain("probeMedia");
    expect(webmScriptSource).toContain("keyframed-lower-third");
    expect(webmScriptSource).toContain("webm-vp9");
    expect(webmScriptSource).toContain("video/webm");
    expect(webmScriptSource).toContain("quality-check");
    expect(webmScriptSource).toContain("--min-unique-frames");
    expect(webmScriptSource).toContain("--preview-package");
    expect(webmScriptSource).toContain("--min-psnr-db");
    expect(audioScriptSource).toContain("sine=frequency");
    expect(audioScriptSource).toContain("audio");
    expect(audioScriptSource).toContain("video/mp4");
    expect(audioScriptSource).toContain("--expect-audio");
    expect(audioScriptSource).toContain("--min-audio-peak-db");
    expect(audioScriptSource).toContain("audioLevels");
    expect(captionScriptSource).toContain("caption-import");
    expect(captionScriptSource).toContain("--trusted-local-tier");
    expect(captionScriptSource).toContain("captions.srt");
    expect(captionScriptSource).toContain("cap_0001");
    expect(captionScriptSource).toContain("video/mp4");
    expect(captionScriptSource).toContain("quality-check");
    expect(alphaScriptSource).toContain("webm-vp9-alpha");
    expect(alphaScriptSource).toContain("mov-prores");
    expect(alphaScriptSource).toContain("render.receipt.artifacts");
    expect(alphaScriptSource).toContain("video/webm");
    expect(alphaScriptSource).toContain("video/quicktime");
    expect(alphaScriptSource).toContain("minTransparentPixels");
    expect(alphaScriptSource).toContain("minNonTransparentPixels");
    expect(gifScriptSource).toContain("keyframed-lower-third");
    expect(gifScriptSource).toContain("--preset");
    expect(gifScriptSource).toContain("gif");
    expect(gifScriptSource).toContain("--min-unique-frames");
    expect(gifScriptSource).toContain("quality-check");
    expect(gifScriptSource).toContain("image/gif");
    expect(jpegScriptSource).toContain("jpeg-frame");
    expect(jpegScriptSource).toContain("image/jpeg");
    expect(jpegScriptSource).toContain("0xff");
    expect(jpegScriptSource).toContain("quality-check");
    expect(batchScriptSource).toContain("render-batch");
    expect(batchScriptSource).toContain("fixtures/packages/batch-card");
    expect(batchScriptSource).toContain("png-frame");
    expect(batchScriptSource).toContain("png-sequence");
    expect(batchScriptSource).toContain("linus");
    expect(batchScriptSource).toContain("video/mp4");
    expect(batchScriptSource).toContain("--rows");
    expect(batchScriptSource).toContain("--quality-manifest");
    expect(batchScriptSource).toContain("qualityManifestAppliedPath");
    expect(batchScriptSource).toContain("batch-row.receipt.json");
    expect(batchScriptSource).toContain("review-html-bundle");
    expect(batchScriptSource).toContain("review-html-bundle.html");
    expect(batchScriptSource).not.toContain("--dry-run");
    expect(browserScriptSource).toContain("capture-browser");
    expect(browserScriptSource).toContain("browser-workflow@1");
    expect(browserScriptSource).toContain("--workflow");
    expect(browserScriptSource).toContain("--catalog");
    expect(browserScriptSource).toContain("--fail-on-drift");
    expect(browserScriptSource).toContain("--recording-manifest");
    expect(browserScriptSource).toContain("--recording-samples");
    expect(browserScriptSource).toContain('const recordingManifestPath = join(recordingCaptureOutDir, "browser-recording.manifest.json");');
    expect(browserScriptSource).toContain("browser_workflow_trace");
    expect(browserScriptSource).toContain("catalogSecond.workflowCatalogPath");
    expect(browserScriptSource).toContain("browser_recording_manifest");
    expect(browserScriptSource).toContain("recordingManifest");
    expect(browserScriptSource).toContain("action: \"type\"");
    expect(browserScriptSource).toContain("textLength");
    expect(browserScriptSource).toContain("hasText");
    expect(browserScriptSource).toContain("includes(secretText)");
    expect(browserScriptSource).toContain("workflowDrift");
    expect(browserScriptSource).toContain("browser_workflow_drift_detected");
    expect(browserScriptSource).toContain("status\", \"matched");
    expect(browserScriptSource).toContain("status\", \"changed");
    expect(lifecycleScriptSource).toContain("render-cancel");
    expect(lifecycleScriptSource).toContain("render-retry");
    expect(lifecycleScriptSource).toContain("--trusted-local-tier");
    expect(lifecycleScriptSource).toContain("render-queue");
    expect(lifecycleScriptSource).toContain("shellx-motion/render-job-handoff@1");
    expect(lifecycleScriptSource).toContain("retryAttempt");
    expect(debugServerScriptSource).toContain("startMotionDebugServer");
    expect(debugServerScriptSource).toContain("webSocketJsonRpc");
    expect(debugServerScriptSource).toContain("websocket-json-rpc");
    expect(debugServerScriptSource).toContain("motion.debug.dispatch");
    expect(debugServerScriptSource).toContain("tools/list");
    expect(debugServerScriptSource).toContain("tools/call");
    expect(debugServerScriptSource).toContain("motion_actions_find");
    expect(debugServerScriptSource).toContain("motion_render_final");
    expect(debugServerScriptSource).toContain("permission_denied");
    expect(debugServerPromptScriptSource).toContain("startMotionDebugServer");
    expect(debugServerPromptScriptSource).toContain("tools/call");
    expect(debugServerPromptScriptSource).toContain("motion_prompt_run");
    expect(debugServerPromptScriptSource).toContain("motion_receipts_panel");
    expect(debugServerPromptScriptSource).toContain("motion_agent_transcript");
    expect(debugServerPromptScriptSource).toContain("Fake Debug Server Prompt Agent");
    expect(debugServerPromptScriptSource).toContain("executeAgentCommands");
    expect(debugServerPromptScriptSource).toContain("linkedReceiptIds");
  });

  itLinux("refuses the removed Script-to-Cut dry-run control before host-job creation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-script-connector-"));
    tempDirs.push(outDir);
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runCli([
      "connector",
      "script-to-cut",
      scriptPath,
      "--out",
      outDir,
      "--start-ms",
      "1250",
      "--duration-ms",
      "1800",
      "--track",
      "overlay-2",
      "--dry-run-render"
    ]);
    expect(result).toMatchObject({
      ok: false,
      command: "connector.script-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("does not accept --dry-run-render") }
    });
    await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses the removed Source-to-Cut dry-run control before host-job creation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-source-connector-"));
    tempDirs.push(outDir);
    const sourcePath = join(outDir, "source.md");
    await writeFile(sourcePath, importedSourceMarkdown(), "utf8");

    const result = await runCli([
      "connector",
      "source-to-cut",
      sourcePath,
      "--out",
      outDir,
      "--max-frames",
      "2",
      "--frame-duration-ms",
      "900",
      "--width",
      "640",
      "--height",
      "360",
      "--dry-run-render"
    ]);
    expect(result).toMatchObject({
      ok: false,
      command: "connector.source-to-cut",
      error: { code: "invalid_args", message: expect.stringContaining("does not accept --dry-run-render") }
    });
    await expect(stat(join(outDir, "receipts", "source-to-cut.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("runs a Cut Generate to Cut connector alias from the CLI", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-cut-generate-connector-"));
    tempDirs.push(outDir);
    const scriptPath = join(outDir, "scripted-video.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runCli([
      "connector",
      "cut-generate-to-cut",
      scriptPath,
      "--out",
      outDir,
      "--dry-run-render"
    ]);
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8")) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      command: "connector.cut-generate-to-cut",
      packageDir: join(outDir, "package"),
      cutPlanPath: join(outDir, "cut-import-plan.json"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "scripted_video", path: scriptPath, status: "available" }),
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_script_launch_demo.mp4"), status: "planned", primary: true }),
        expect.objectContaining({ role: "cut_plan", path: join(outDir, "cut-import-plan.json"), status: "available" })
      ]),
      receiptPath: join(outDir, "connector-run.receipt.json"),
      // the text-delivery invariant: native-preview case folding is reported, not swallowed.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_title: ok.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_body: howtenrkfl."
      ]
    });
    expect(receipt).toMatchObject({
      operation: "connector.cut_generate_to_cut",
      output: {
        script: { path: scriptPath },
        cut: { ok: true, mode: "rendered_media" },
        render: { ok: true, dryRun: true }
      }
    });
  });

  it("refuses non-rendered Template-to-Cut modes before creating a host job or delivery", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-cut-"));
    tempDirs.push(outDir);
    const callerId = `template-p2a-invalid-${Date.now()}`;
    const jobId = `template-p2a-invalid-${Date.now()}`;

    const result = await runCli([
      "connector",
      "template-to-cut",
      resolve("../../fixtures/cut-native-static-package"),
      "--out",
      outDir,
      "--cut-import-mode",
      "editable_lowering",
      "--set",
      "title=Dr. Mira Chen",
      "--set",
      "accentColor=#ff006e",
      "--job-id",
      jobId,
      "--caller-id",
      callerId
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "connector.template-to-cut",
      error: { code: "invalid_args", message: "connector template-to-cut accepts only --cut-import-mode rendered_media in P2A." }
    });
    expect(result.jobId).toBeUndefined();
    await expect(runCli(["job", "list", "--caller-id", callerId])).resolves.toMatchObject({ ok: true, command: "job.list", callerId, jobCount: 0 });
    await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["force", ["--force"]],
    ["dry-run render", ["--dry-run-render"]],
    ["native preview", ["--preview-lane", "native"]],
    ["auto preview", ["--preview-lane", "auto"]],
    ["GPU frame lane", ["--frame-lane", "gpu"]],
    ["alternate render lane", ["--render-lane", "ffmpeg"]],
    ["audio request", ["--needs-audio"]]
  ])("returns invalid_args for Template-to-Cut P2A %s option before delivery", async (_label, forbiddenArgs) => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-cut-invalid-"));
    tempDirs.push(outDir);

    const result = await runCli([
      "connector", "template-to-cut", resolve("../../fixtures/packages/editable-lower-third"),
      "--out", outDir, "--set", "title=No Delivery", ...forbiddenArgs
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "connector.template-to-cut",
      error: {
        code: "invalid_args",
        message: expect.stringContaining("Linux Browser-to-FFmpeg rendered_media only")
      }
    });
    expect(result.jobId).toBeUndefined();
    await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes the exact cutout rig bake alias before rejecting incomplete input", async () => {
    await expect(runCli(["debug", "cutout-rig-bake", "--tier", "edit_motion"])).resolves.toMatchObject({
      ok: false,
      command: "debug.cutout-rig-bake",
      error: { code: "invalid_args", message: expect.stringContaining("requires packageRoot") },
    });
  });

  itLinux("returns a structured pre-publication connector refusal when a Canvas asset is missing", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-connector-render-fail-"));
    tempDirs.push(outDir);

    const result = await runCli([
      "connector",
      "canvas-to-cut",
      "../../fixtures/canvas/frame-selection.json",
      "--out",
      outDir
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "connector.canvas-to-cut",
      error: {
        code: "connector_failed",
        message: "Connector job failed.",
      }
    });
    expect(result.render).toBeUndefined();
    expect(await readdir(outDir)).toEqual([]);
  }, 45_000);
});
