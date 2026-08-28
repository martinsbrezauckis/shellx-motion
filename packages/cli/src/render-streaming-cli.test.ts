import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import type { FfmpegCommand, FfmpegProcessResult, FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { runCli, type RunCliOptions } from "./main";
import { writeTinyNativePackage } from "./main.fixtures-packages";
import { rgbaPng } from "./main.test-support";

const roots: string[] = [];
const fixtureRoot = resolve("../../fixtures/packages/lower-third");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI streamed final video", () => {
  it("refuses --keep-frames outside final-video FFmpeg delivery", async () => {
    const root = await scratch();
    const cases: Array<[string, string[]]> = [
      ["native", ["render", fixtureRoot, "--lane", "native", "--keep-frames", "--out", join(root, "native.png")]],
      ["still", ["render", fixtureRoot, "--lane", "ffmpeg", "--preset", "png-frame", "--keep-frames", "--out", join(root, "still.png"), "--dry-run"]],
      ["sequence", ["render", fixtureRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--keep-frames", "--out", join(root, "sequence"), "--dry-run"]]
    ];

    for (const [, argv] of cases) {
      const result = await runCli(argv);
      expect(result).toMatchObject({
        ok: false,
        command: "render",
        error: {
          code: "invalid_args",
          message: "--keep-frames is only supported for final-video FFmpeg renders."
        }
      });
      expect(result).not.toHaveProperty("frames");
    }
    expect(existsSync(join(root, "native.png"))).toBe(false);
    expect(existsSync(join(root, "still.png"))).toBe(false);
    expect(existsSync(join(root, "sequence"))).toBe(false);

    const outputPath = join(root, "explicit-sequence");
    const sequence = await runCli([
      "render", fixtureRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--out", outputPath, "--dry-run"
    ]);
    expect(sequence).toMatchObject({ ok: true, lane: "image-sequence", sequence: { outputDir: outputPath } });
    expect(sequence).not.toHaveProperty("frameTransport");
  });

  it("plans image2pipe by default and materializes only planner-required cases", async () => {
    const root = await scratch();
    const workflowPath = join(root, "workflow.json");
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: []
    }));
    const injected: BrowserFrameRenderer = async () => {
      throw new Error("Dry runs must not invoke an injected renderer.");
    };
    const plan = async (name: string, args: string[] = [], options: RunCliOptions = {}) => await runCli([
      "render", fixtureRoot, "--out", join(root, `${name}.mp4`), "--dry-run", ...args
    ], options);

    const streamed = await plan("streamed", ["--frames-dir", join(root, "caller-frames")]);
    expect(streamed).toMatchObject({
      ok: true,
      dryRun: true,
      frameTransport: { delivery: "streamed", reason: "stream_default" },
      ffmpeg: { shell: false, args: expect.arrayContaining(["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]) }
    });
    expect(streamed).not.toHaveProperty("resourcePreflight");
    expect(existsSync(join(root, "caller-frames"))).toBe(false);

    await expect(plan("retained", ["--keep-frames"])).resolves.toMatchObject({
      frameTransport: { delivery: "materialized", reason: "explicit_frame_retention" },
      resourcePreflight: { status: "admitted" }
    });
    await expect(plan("workflow", ["--workflow", workflowPath])).resolves.toMatchObject({
      frameTransport: { delivery: "materialized", reason: "captured_browser_workflow" },
      resourcePreflight: { status: "admitted" }
    });
    await expect(plan("quality", ["--quality-manifest", join(root, "quality.json")])).resolves.toMatchObject({
      frameTransport: { delivery: "materialized", reason: "exact_source_quality" },
      resourcePreflight: { status: "admitted" }
    });
    await expect(plan("capacity", ["--min-unique-frames", "65"])).resolves.toMatchObject({
      frameTransport: { delivery: "materialized", reason: "streaming_quality_capacity" },
      resourcePreflight: { status: "admitted" }
    });
    await expect(plan("injected", [], { browserFrameRenderer: injected })).resolves.toMatchObject({
      frameTransport: { delivery: "materialized", reason: "injected_frame_renderer" },
      resourcePreflight: { status: "admitted" }
    });
  });

  it("refuses an unverified browser HTML font-fallback attestation in the CLI dry run", async () => {
    const root = await scratch();
    const packageRoot = await writeUnverifiedHtmlTypographyPackage(root);

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--out", join(root, "out.mp4"), "--dry-run"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      frameLane: "browser",
      error: {
        code: "browser_html_typography_unverified",
        detail: { attestation: "font-fallback", scope: "html-web-canvas", layerIds: ["interactive"] }
      }
    });
  });

  it("delivers a native final video through one stream without creating a frame directory", async () => {
    const root = await scratch();
    const packageRoot = await writeTinyNativePackage();
    roots.push(packageRoot);
    const outputPath = join(root, "final.mp4");
    const framesRoot = join(root, "caller-frames");
    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--frame-lane", "native",
      "--out", outputPath, "--frames-dir", framesRoot
    ], {
      ffmpegRunner: probeRunner(),
      streamingProcessFactory: processFactory(outputPath)
    });

    expect(result).toMatchObject({
      ok: true,
      lane: "ffmpeg",
      frameLane: "native",
      frameTransport: { delivery: "streamed", reason: "stream_default" },
      receipt: { output: { frameTransport: { delivery: "streamed", frameLane: "native", retainedFrameCount: 0 } } },
      ffmpeg: { shell: false, args: expect.arrayContaining(["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]) }
    });
    expect(result).not.toHaveProperty("frames");
    expect(result).not.toHaveProperty("resourcePreflight");
    expect(existsSync(framesRoot)).toBe(false);
    expect(existsSync(outputPath)).toBe(true);
  });

  it("keeps streamed failure evidence and never falls back to materialized frames", async () => {
    const root = await scratch();
    const packageRoot = await writeTinyNativePackage();
    roots.push(packageRoot);
    const framesRoot = join(root, "caller-frames");
    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--frame-lane", "native",
      "--out", join(root, "failed.mp4"), "--frames-dir", framesRoot
    ], {
      ffmpegRunner: probeRunner(),
      streamingProcessFactory: processFactory(join(root, "failed.mp4"), 1)
    });

    expect(result).toMatchObject({
      ok: false,
      lane: "ffmpeg",
      frameTransport: { delivery: "streamed", reason: "stream_default" },
      error: { code: "encoder_failed", handoff: { attempts: [{ source: "software", outcome: "failed" }] } }
    });
    expect(result).not.toHaveProperty("frames");
    expect(existsSync(framesRoot)).toBe(false);
  });

  it("cleans planner-required scratch frames and does not advertise them without --keep-frames", async () => {
    const root = await scratch();
    const packageRoot = await writeTinyNativePackage();
    roots.push(packageRoot);
    const outputPath = join(root, "materialized.mp4");
    const framesRoot = join(root, "caller-frames");
    const framesDir = join(framesRoot, "pkg_cli_ffmpeg_sequence");
    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--out", outputPath, "--frames-dir", framesRoot
    ], {
      browserFrameRenderer: injectedRenderer(),
      ffmpegRunner: encodeRunner(outputPath)
    });
    expect(result).toMatchObject({
      ok: true,
      frameTransport: { delivery: "materialized", reason: "injected_frame_renderer" },
      receipt: { output: { frameTransportPlan: { delivery: "materialized", reason: "injected_frame_renderer" } } }
    });
    expect(result).not.toHaveProperty("frames");
    expect(result).not.toHaveProperty("frameReceipt");
    expect(existsSync(framesDir)).toBe(false);
    expect(existsSync(outputPath)).toBe(true);
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-streaming-cli-"));
  roots.push(root);
  return root;
}

async function writeUnverifiedHtmlTypographyPackage(root: string): Promise<string> {
  const packageRoot = join(root, "package");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_unverified_html_typography",
    name: "Unverified HTML typography",
    motion: "motion.json",
    assets: ["card.html"],
    sourceApp: "test",
    compatibility: { lanes: ["browser"], hosts: ["motion"] },
    quality: { maxFontFallbacks: 0 }
  })}\n`);
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_unverified_html_typography",
    name: "Unverified HTML typography",
    durationMs: 1_000,
    fps: 1,
    width: 64,
    height: 36,
    layers: [{ id: "interactive", type: "web", source: "card.html", startMs: 0, durationMs: 1_000 }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  })}\n`);
  await writeFile(join(packageRoot, "card.html"), "<canvas id=\"dynamic\"></canvas>");
  return packageRoot;
}

function probeRunner(): FfmpegRunner {
  return async (command) => command.args.includes("-show_streams")
    ? {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: 64, height: 36, avg_frame_rate: "10/1", duration: "0.3", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }],
          format: { duration: "0.3", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
        }),
        stderr: ""
      }
    : { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
}

function encodeRunner(outputPath: string): FfmpegRunner {
  return async (command) => {
    if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
    if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
    await writeFile(command.args.at(-1) ?? outputPath, "encoded-media");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function injectedRenderer(): BrowserFrameRenderer {
  return async (pkg, options) => {
    const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-${options.atMs}.png`);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, rgbaPng(
      pkg.motion.width,
      pkg.motion.height,
      Array.from({ length: pkg.motion.width * pkg.motion.height }, (_, index): [number, number, number, number] =>
        index % pkg.motion.width < pkg.motion.width / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])
    ));
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
        id: `streaming-cli-frame-${options.atMs}`,
        operation: "preview.frame",
        status: "passed",
        packageId: pkg.manifest.id,
        inputHashes: { motion: "a".repeat(64) },
        createdAt: "2026-08-08T00:00:00.000Z",
        lane: "browser",
        output: { path: outputPath },
        warnings: []
      }
    };
  };
}

function processFactory(outputPath: string, exitCode = 0): NonNullable<RunCliOptions["streamingProcessFactory"]> {
  return async (input) => {
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
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
        if (exitCode === 0) await writeFile(input.command.args.at(-1) ?? outputPath, "encoded-media");
        return settle({ exitCode, stdout: "", stderr: exitCode === 0 ? "" : "encoder failed" });
      },
      abort: async () => settle({ exitCode: 1, stdout: "", stderr: "aborted" })
    };
  };
}
