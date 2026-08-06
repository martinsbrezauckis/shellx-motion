/**
 * encode-policy.test.ts — coverage for the centralized hardware-encode policy and probe cache.
 *
 * Proves the acceptance criteria: the same eligible host selects the same encoder across all five call
 * paths (mock probe) through the shared cache; a cache hit avoids re-probing; a hardware encode that
 * fails at render time falls back to software exactly once, is receipted, and invalidates the cache;
 * the SHELLX_MOTION_FORCE_SOFTWARE_ENCODE override forces software everywhere with no probe; and the
 * receipt records fresh-probe vs cached provenance. No GPU is required — the ffmpeg runner is mocked.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDefaultEncodePolicyCache,
  createEncodePolicyCache,
  encodeImageSequenceWithPolicy,
  encodePolicyCacheKey,
  resolveCachedHardwareProbe,
  type EncodePolicyCache,
  type FfmpegCommand,
  type FfmpegRunner
} from "./index";

// 2x1 contrast PNG (reused frame image); identical frames are fine — encodeImageSequence's default gate
// does not require frame uniqueness here.
const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

const NVENC_ENCODERS_STDOUT = " V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)";

interface MockRunnerOptions {
  commands: FfmpegCommand[];
  /** `-encoders` stdout advertising a compiled hardware encoder; empty => none compiled. */
  encodersStdout?: string;
  /** Fail the hardware init probe (`-f null -`) so no hardware is usable. */
  initFails?: boolean;
  /** Fail the real hardware encode (the h264_nvenc output command) so it falls back to software. */
  hwEncodeFails?: boolean;
}

/**
 * A mocked ffmpeg runner distinguishing the three command shapes: `-encoders` discovery, the single-frame
 * init probe (ends with `-f null -`), and the real encode (ends with an output path).
 */
function makeRunner(options: MockRunnerOptions): FfmpegRunner {
  return async (command) => {
    options.commands.push(command);
    if (command.args.includes("-encoders")) {
      return { exitCode: 0, stdout: options.encodersStdout ?? "", stderr: "" };
    }
    if (command.args.at(-1) === "-") {
      // Hardware usability init probe.
      return { exitCode: options.initFails ? 1 : 0, stdout: "", stderr: options.initFails ? "init failed" : "" };
    }
    // Real encode: last arg is the output path.
    const isHardwareEncode = command.args.includes("h264_nvenc");
    if (isHardwareEncode && options.hwEncodeFails) {
      return { exitCode: 1, stdout: "", stderr: "h264_nvenc failed to initialize at encode time" };
    }
    await writeFile(command.args.at(-1) as string, "encoded-bytes", "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("encode policy service", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    delete process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE;
    clearDefaultEncodePolicyCache();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratchFrames(prefix: string): Promise<{ framesDir: string; outputPath: string }> {
    const framesDir = await mkdtemp(join(tmpdir(), `shellx-motion-encpol-${prefix}-`));
    tempDirs.push(framesDir);
    await mkdir(framesDir, { recursive: true });
    for (let index = 0; index < 2; index += 1) {
      await writeFile(join(framesDir, `${String(index + 1).padStart(6, "0")}.png`), CONTRAST_PNG);
    }
    return { framesDir, outputPath: join(framesDir, "out.mp4") };
  }

  function encodeInput(framesDir: string, outputPath: string, packageId: string): Parameters<typeof encodeImageSequenceWithPolicy>[0] {
    return {
      packageId,
      framesDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath,
      preset: "mp4-h264"
    };
  }

  const hwOutput = (result: Awaited<ReturnType<typeof encodeImageSequenceWithPolicy>>): Record<string, unknown> => {
    if (!result.ok) throw new Error("expected a successful encode");
    return result.receipt.output as Record<string, unknown>;
  };

  it("forces software everywhere via the env override, with no probe", async () => {
    process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE = "1";
    const { framesDir, outputPath } = await scratchFrames("override");
    const commands: FfmpegCommand[] = [];
    const cache = createEncodePolicyCache();
    const result = await encodeImageSequenceWithPolicy({
      ...encodeInput(framesDir, outputPath, "pkg_override"),
      runner: makeRunner({ commands, encodersStdout: NVENC_ENCODERS_STDOUT }),
      cache
    });
    expect(result.ok).toBe(true);
    // No probe of any kind ran; the override short-circuits before the resolver.
    expect(commands.some((command) => command.args.includes("-encoders"))).toBe(false);
    expect(commands.some((command) => command.args.at(-1) === "-")).toBe(false);
    expect(hwOutput(result)).toMatchObject({ encoderSource: "software", encoderReason: "forced-software" });
    expect(hwOutput(result).encoderProbe).toBeUndefined();
  });

  it("probes fresh, selects hardware, and records fresh-probe provenance in the receipt", async () => {
    const { framesDir, outputPath } = await scratchFrames("fresh");
    const commands: FfmpegCommand[] = [];
    const cache = createEncodePolicyCache();
    const result = await encodeImageSequenceWithPolicy({
      ...encodeInput(framesDir, outputPath, "pkg_fresh"),
      runner: makeRunner({ commands, encodersStdout: NVENC_ENCODERS_STDOUT }),
      cache
    });
    expect(commands.some((command) => command.args.includes("-encoders"))).toBe(true);
    expect(hwOutput(result)).toMatchObject({
      encoder: "h264_nvenc",
      encoderSource: "hardware",
      encoderReason: "probe-selected-hardware",
      encoderProbe: { usableHardwareEncoders: ["h264_nvenc"], selectedHardwareEncoder: "h264_nvenc", provenance: "fresh-probe" }
    });
  });

  it("reuses a cached probe on the next render without re-probing (cached provenance)", async () => {
    const cache = createEncodePolicyCache();
    const firstFrames = await scratchFrames("cache-a");
    const secondFrames = await scratchFrames("cache-b");
    const firstCommands: FfmpegCommand[] = [];
    const secondCommands: FfmpegCommand[] = [];

    await encodeImageSequenceWithPolicy({
      ...encodeInput(firstFrames.framesDir, firstFrames.outputPath, "pkg_cache_a"),
      runner: makeRunner({ commands: firstCommands, encodersStdout: NVENC_ENCODERS_STDOUT }),
      cache
    });
    const second = await encodeImageSequenceWithPolicy({
      ...encodeInput(secondFrames.framesDir, secondFrames.outputPath, "pkg_cache_b"),
      runner: makeRunner({ commands: secondCommands, encodersStdout: NVENC_ENCODERS_STDOUT }),
      cache
    });

    expect(firstCommands.some((command) => command.args.includes("-encoders"))).toBe(true);
    // The cache hit runs neither the -encoders discovery nor the init probe.
    expect(secondCommands.some((command) => command.args.includes("-encoders"))).toBe(false);
    expect(secondCommands.some((command) => command.args.at(-1) === "-")).toBe(false);
    expect(hwOutput(second)).toMatchObject({
      encoder: "h264_nvenc",
      encoderProbe: { selectedHardwareEncoder: "h264_nvenc", provenance: "cached" }
    });
  });

  it("selects the same encoder across five call paths through the shared cache, probing once", async () => {
    const cache = createEncodePolicyCache();
    const selectedEncoders: unknown[] = [];
    const pathsThatProbed: number[] = [];
    // Simulate the five product render call paths (CLI, debug-api, canvas-to-mp4, canvas-to-cut,
    // template-to-cut, script-to-cut all funnel through encodeImageSequenceWithPolicy).
    for (let index = 0; index < 5; index += 1) {
      const { framesDir, outputPath } = await scratchFrames(`path-${index}`);
      const commands: FfmpegCommand[] = [];
      const result = await encodeImageSequenceWithPolicy({
        ...encodeInput(framesDir, outputPath, `pkg_path_${index}`),
        runner: makeRunner({ commands, encodersStdout: NVENC_ENCODERS_STDOUT }),
        cache
      });
      selectedEncoders.push(hwOutput(result).encoder);
      if (commands.some((command) => command.args.includes("-encoders"))) pathsThatProbed.push(index);
    }
    expect(selectedEncoders).toEqual(["h264_nvenc", "h264_nvenc", "h264_nvenc", "h264_nvenc", "h264_nvenc"]);
    // Only the first path ran the probe; the other four reused the shared cache.
    expect(pathsThatProbed).toEqual([0]);
  });

  it("falls back to software once when the hardware encode fails, receipts it, and invalidates the cache", async () => {
    const cache = createEncodePolicyCache();
    const first = await scratchFrames("fallback-a");
    const firstCommands: FfmpegCommand[] = [];
    const result = await encodeImageSequenceWithPolicy({
      ...encodeInput(first.framesDir, first.outputPath, "pkg_fallback"),
      runner: makeRunner({ commands: firstCommands, encodersStdout: NVENC_ENCODERS_STDOUT, hwEncodeFails: true }),
      cache
    });
    // Hardware was selected (probe passed) but the encode failed -> exactly one software fallback, receipted.
    expect(hwOutput(result)).toMatchObject({
      encoder: "libx264",
      encoderSource: "software",
      encoderReason: "hardware-fallback",
      encoderFallback: { attemptedEncoder: "h264_nvenc" }
    });
    const hardwareEncodeAttempts = firstCommands.filter((command) => command.args.includes("h264_nvenc") && command.args.at(-1) !== "-");
    expect(hardwareEncodeAttempts).toHaveLength(1);
    // The stale "usable" verdict is dropped from the cache.
    expect(cache.get(encodePolicyCacheKey("h264"))).toBeUndefined();

    // The next render re-probes rather than trusting the invalidated entry.
    const second = await scratchFrames("fallback-b");
    const secondCommands: FfmpegCommand[] = [];
    await encodeImageSequenceWithPolicy({
      ...encodeInput(second.framesDir, second.outputPath, "pkg_fallback_2"),
      runner: makeRunner({ commands: secondCommands, encodersStdout: NVENC_ENCODERS_STDOUT }),
      cache
    });
    expect(secondCommands.some((command) => command.args.includes("-encoders"))).toBe(true);
  });

  it("resolveCachedHardwareProbe caches within TTL and re-probes after expiry", async () => {
    const cache: EncodePolicyCache = createEncodePolicyCache();
    let clock = 1000;
    const now = (): number => clock;

    const c1: FfmpegCommand[] = [];
    const r1 = await resolveCachedHardwareProbe({ family: "h264", encoders: ["h264_nvenc"], runner: makeRunner({ commands: c1, encodersStdout: NVENC_ENCODERS_STDOUT }), cache, now, ttlMs: 5000, version: "ffmpeg 7.1" });
    expect(r1.provenance).toBe("fresh-probe");
    expect(r1.version).toBe("ffmpeg 7.1");
    expect(c1.length).toBeGreaterThan(0);

    const c2: FfmpegCommand[] = [];
    const r2 = await resolveCachedHardwareProbe({ family: "h264", encoders: ["h264_nvenc"], runner: makeRunner({ commands: c2, encodersStdout: NVENC_ENCODERS_STDOUT }), cache, now, ttlMs: 5000 });
    expect(r2.provenance).toBe("cached");
    expect(r2.version).toBe("ffmpeg 7.1");
    expect(c2.length).toBe(0);

    clock = 7000; // past the 5s TTL
    const c3: FfmpegCommand[] = [];
    const r3 = await resolveCachedHardwareProbe({ family: "h264", encoders: ["h264_nvenc"], runner: makeRunner({ commands: c3, encodersStdout: NVENC_ENCODERS_STDOUT }), cache, now, ttlMs: 5000 });
    expect(r3.provenance).toBe("fresh-probe");
    expect(c3.length).toBeGreaterThan(0);
  });
});
