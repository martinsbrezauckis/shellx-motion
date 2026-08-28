/**
 * receipt-tool-provenance.test.ts — the FFprobe provenance rule, and its parity across surfaces.
 *
 * Covers the tool-provenance invariant ("FFprobe provenance is not equivalent across CLI and agent surfaces")
 * and the readiness-parity invariant that lives in this package (an embedded host's render runner must be the runner
 * `motion.platform.requirements` answers about).
 *
 * Two layers, deliberately:
 *
 *   1. Unit tests of {@link recordReceiptFfprobeProvenance} — the honesty rule itself. A receipt may
 *      name FFprobe only when it contributed AND its identity probe answered.
 *   2. An END-TO-END `motion.render.final` on the FFmpeg lane with a quality manifest, driven by a
 *      fake runner. This is the actual regression: the same render through the CLI recorded
 *      `output.tools.ffprobe` and through the debug/MCP transport did not. The assertion is on the
 *      delivered receipt, not on a call count.
 *
 * Dependencies: `./receipt-tool-provenance.js`, `./index.js` (dispatch). No real FFmpeg is spawned.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OperationReceipt } from "@shellx-motion/core";
import type { FfmpegCommand, FfmpegRunner, MotionToolProbeResult } from "@shellx-motion/renderer-ffmpeg";
import { applyReceiptToolIdentity, recordReceiptFfprobeProvenance } from "./receipt-tool-provenance.js";
import { dispatchDebugCommand } from "./index.js";

/** A 2×1 PNG with one bright and one dark pixel — enough for a `minBrightPixels` sample. */
const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

/** A minimal FFmpeg-lane render receipt: the encoder identity is already present, FFprobe is not. */
function encodedReceipt(): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "render-provenance-1",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_provenance",
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-08-03T00:00:00.000Z",
    lane: "ffmpeg",
    output: {
      path: "/tmp/out.mp4",
      tools: { ffmpeg: { tool: "ffmpeg", source: "path", executable: "ffmpeg", version: "ffmpeg version 7.1" } }
    },
    warnings: []
  } as unknown as OperationReceipt;
}

function probeReturning(result: Partial<MotionToolProbeResult>): () => Promise<MotionToolProbeResult> {
  return async () => ({
    tool: "ffprobe",
    source: "path",
    resolvedFrom: "ffprobe",
    status: "ready",
    ...result
  } as MotionToolProbeResult);
}

describe("recordReceiptFfprobeProvenance — a receipt names FFprobe only when FFprobe earned it", () => {
  it("records the identity when FFprobe contributed and its probe answered", async () => {
    const receipt = encodedReceipt();
    const outcome = await recordReceiptFfprobeProvenance(receipt, {
      contributed: true,
      probe: probeReturning({ status: "ready", version: "ffprobe version 7.1" })
    });

    expect(outcome.recorded).toBe(true);
    const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;
    expect(tools.ffprobe).toEqual({ tool: "ffprobe", source: "path", executable: "ffprobe", version: "ffprobe version 7.1" });
    // Additive: the encoder entry the ffmpeg lane wrote must survive untouched.
    expect(tools.ffmpeg).toEqual({ tool: "ffmpeg", source: "path", executable: "ffmpeg", version: "ffmpeg version 7.1" });
  });

  it("records nothing when FFprobe did not contribute, even if it is installed", async () => {
    const receipt = encodedReceipt();
    const outcome = await recordReceiptFfprobeProvenance(receipt, {
      contributed: false,
      probe: probeReturning({ status: "ready", version: "ffprobe version 7.1" })
    });

    expect(outcome).toEqual({ recorded: false, reason: "not_contributed" });
    expect(((receipt.output as Record<string, unknown>).tools as Record<string, unknown>).ffprobe).toBeUndefined();
  });

  // `unverified` is not a probe outcome — a probe either answers or reports missing/broken — so the
  // two states a probe can actually report are the two that must leave the receipt silent.
  it.each(["missing", "broken"] as const)(
    "leaves the receipt silent rather than naming an FFprobe whose probe reported %s",
    async (status) => {
      const receipt = encodedReceipt();
      const outcome = await recordReceiptFfprobeProvenance(receipt, {
        contributed: true,
        probe: probeReturning({ status })
      });

      // A provenance entry with no verified build reads as evidence while carrying none.
      expect(outcome).toEqual({ recorded: false, reason: "probe_unavailable" });
      expect(((receipt.output as Record<string, unknown>).tools as Record<string, unknown>).ffprobe).toBeUndefined();
    }
  );

  it("is a quiet no-op on a receipt that carries no tools block", async () => {
    const receipt = { ...encodedReceipt(), output: { path: "/tmp/frame.png" } } as unknown as OperationReceipt;
    const outcome = await recordReceiptFfprobeProvenance(receipt, {
      contributed: true,
      probe: probeReturning({ status: "ready", version: "ffprobe version 7.1" })
    });

    expect(outcome).toEqual({ recorded: false, reason: "no_tools_block" });
    expect(receipt.output).toEqual({ path: "/tmp/frame.png" });
  });

  it("passes the caller's runner to the probe, so an injected executable is the one identified", async () => {
    const receipt = encodedReceipt();
    const seen: Array<FfmpegRunner | undefined> = [];
    const runner: FfmpegRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await recordReceiptFfprobeProvenance(receipt, {
      contributed: true,
      runner,
      probe: async (_tool, given) => {
        seen.push(given);
        return { tool: "ffprobe", source: "override", resolvedFrom: "ffprobe", status: "ready", version: "bundled ffprobe 7.1" };
      }
    });

    expect(seen).toEqual([runner]);
    expect(((receipt.output as Record<string, unknown>).tools as Record<string, unknown>).ffprobe)
      .toMatchObject({ source: "override", version: "bundled ffprobe 7.1" });
  });
});

describe("applyReceiptToolIdentity", () => {
  it("merges into output.tools without disturbing any other output field", () => {
    const receipt = encodedReceipt();
    const before = { ...(receipt.output as Record<string, unknown>) };
    const applied = applyReceiptToolIdentity(receipt, "ffprobe", {
      tool: "ffprobe", source: "path", executable: "ffprobe", version: "v"
    });

    expect(applied).toBe(true);
    const output = receipt.output as Record<string, unknown>;
    expect(output.path).toBe(before.path);
    expect(Object.keys(output)).toEqual(Object.keys(before));
  });
});

/**
 * Fake FFmpeg/FFprobe for a full render + quality manifest. Answers the four commands the lane
 * issues: an ffmpeg version probe, an encode, an ffprobe media probe, an ffprobe identity probe, and
 * a frame extraction for the manifest's visual sample.
 */
function renderRunner(calls: FfmpegCommand[]): FfmpegRunner {
  return async (command) => {
    calls.push(command);
    if (command.executable.includes("ffprobe")) {
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffprobe version 7.1-test\nbuilt with gcc", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540, avg_frame_rate: "24/1" }],
          format: { duration: "2.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
        }),
        stderr: ""
      };
    }
    if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version 7.1-test", stderr: "" };
    if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
    const outputPath = command.args.at(-1) as string;
    await mkdir(dirname(outputPath), { recursive: true });
    // Keyed on the OUTPUT EXTENSION, not on `-frames:v`: the image-sequence encode carries that flag
    // too, so the flag cannot tell a frame extraction from the encode itself.
    if (outputPath.endsWith(".png")) await writeFile(outputPath, CONTRAST_PNG);
    else await writeFile(outputPath, "fake mp4", "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function browserFrames(framePaths: string[]) {
  return async (pkg: { motion: { width: number; height: number }; manifest: { id: string } }, options: { outDir: string; outputPath?: string; atMs: number }) => {
    const framePath = options.outputPath ?? join(options.outDir, "frame.png");
    framePaths.push(framePath);
    await mkdir(dirname(framePath), { recursive: true });
    await writeFile(framePath, CONTRAST_PNG);
    return {
      ok: true as const,
      output: {
        path: framePath,
        sha256: String(framePaths.length).padStart(64, "0"),
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
      },
      receipt: {
        schema: "shellx-motion/receipt@1",
        id: `browser-preview-${framePaths.length}`,
        operation: "preview.frame",
        status: "passed",
        packageId: pkg.manifest.id,
        inputHashes: { motion: "d".repeat(64) },
        createdAt: "2026-07-01T00:00:00.000Z",
        lane: "browser",
        output: { path: framePath },
        warnings: []
      }
    };
  };
}

describe("motion.render.final — FFprobe provenance parity with the CLI", () => {
  it("records output.tools.ffprobe after a quality manifest reads back a relative package-root render", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffprobe-provenance-"));
    const outputPath = join(outDir, "out.mp4");
    const manifestPath = join(outDir, "quality-manifest.json");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];

    try {
      await writeFile(manifestPath, `${JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        samples: [{ id: "sample", atMs: 0, minBrightPixels: 1, minEdgePixels: 0, maxChangedPixels: 0, maxMeanDiff: 0 }]
      }, null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          minUniqueFrameHashes: 1,
          qualityManifestPath: manifestPath
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          ffmpegRunner: renderRunner(calls),
          browserFrameRenderer: browserFrames(framePaths) as never
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const receipt = (result.result as Record<string, unknown>).receipt as Record<string, unknown>;
      const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;

      // THE regression: this field existed on the CLI's receipt and was absent here.
      expect(tools.ffprobe).toMatchObject({ tool: "ffprobe", version: "ffprobe version 7.1-test" });
      // Additive: the pre-existing encoder provenance is untouched.
      expect(tools.ffmpeg).toMatchObject({ tool: "ffmpeg" });
      // And the identity came from the injected runner, not from the machine's PATH.
      expect(calls.some((call) => call.executable.includes("ffprobe") && call.args[0] === "-version")).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60000);

  it("does not name FFprobe on a render with no quality manifest", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffprobe-absent-"));
    const outputPath = join(outDir, "out.mp4");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          minUniqueFrameHashes: 1
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          ffmpegRunner: renderRunner(calls),
          browserFrameRenderer: browserFrames(framePaths) as never
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const receipt = (result.result as Record<string, unknown>).receipt as Record<string, unknown>;
      const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;
      expect(tools.ffmpeg).toBeDefined();
      // Nothing read this file back, so nothing may claim to have.
      expect(tools.ffprobe).toBeUndefined();
      expect(calls.some((call) => call.executable.includes("ffprobe") && call.args[0] === "-version")).toBe(false);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("motion.platform.requirements — answers about the host's own render runner", () => {
  /** A runner that reports a working FFmpeg and an absent FFprobe, whatever this machine has. */
  const injectedRunner: FfmpegRunner = async (command) => {
    if (command.executable.includes("ffprobe")) {
      throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
    }
    return { exitCode: 0, stdout: "ffmpeg version host-bundled-9.9", stderr: "" };
  };

  it("probes through MotionDebugContext.ffmpegRunner rather than the machine's PATH", async () => {
    const result = await dispatchDebugCommand(
      "motion.platform.requirements",
      { operation: "render.final" },
      { tier: "read_motion", ffmpegRunner: injectedRunner }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const platform = (result.result as Record<string, unknown>).platform as { tools: Array<Record<string, unknown>> };
    const ffmpeg = platform.tools.find((tool) => tool.tool === "ffmpeg");
    const ffprobe = platform.tools.find((tool) => tool.tool === "ffprobe");

    // The version string proves the answer came from the injected runner: no real FFmpeg on any
    // machine reports "host-bundled-9.9".
    expect(ffmpeg).toMatchObject({ status: "ready", version: "ffmpeg version host-bundled-9.9" });
    expect(ffprobe).toMatchObject({ status: "missing" });
    // Scoped: a missing FFprobe does not block a final encode.
    expect((result.result as Record<string, unknown>).operation).toMatchObject({
      operation: "render.final",
      satisfied: true,
      blockedBy: []
    });
    // The platform command exposes GPU policy without opening a browser or
    // accepting the old render receipts this suite happens to inspect.
    expect((result.result as Record<string, unknown>).gpu).toMatchObject({
      status: "requires-hardware-proof",
      trustedChromium: { status: "present" },
      adapterDeviceProof: { status: "not-tested", requiredCommand: "host-owned motion.platform.gpu.probe" },
      audio: { gpuRaster: "none", finalVideo: "ffmpeg" }
    });
  }, 45_000);

  it("reports the injected runner's broken FFmpeg as blocking render.final", async () => {
    // Only FFmpeg is broken. Breaking every tool would also break Chromium — a real `render.final`
    // blocker since this command rasterizes through the browser lane — and this test is about the
    // encoder, so it varies the encoder alone.
    const brokenRunner: FfmpegRunner = async (command) => (/ffmpeg(\.exe)?$/i.test(command.executable)
      ? { exitCode: 1, stdout: "", stderr: "permission denied" }
      : { exitCode: 0, stdout: "version 9.9-fixture", stderr: "" });
    const result = await dispatchDebugCommand(
      "motion.platform.requirements",
      { operation: "render.final" },
      { tier: "read_motion", ffmpegRunner: brokenRunner }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.result as Record<string, unknown>).operation).toMatchObject({
      operation: "render.final",
      satisfied: false,
      blockedBy: ["ffmpeg"]
    });
  }, 45_000);
});
