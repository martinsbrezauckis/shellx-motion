import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultLocalMotionJobGovernor,
  integrationCapabilitiesForHost,
  LocalMotionJobGovernor,
  MOTION_EXPORT_PRESETS,
  type LocalMotionJobPolicy
} from "@shellx-motion/core";
import {
  buildEncodeImageSequenceCommand,
  checkFfmpeg,
  createImageSequenceReceipt,
  createGovernedFfmpegRunner,
  createStillFrameReceipt,
  encodeImageSequence,
  ffmpegPresetOutputPathError,
  frameExtractionArgs,
  frameExtractionInputArgs,
  frameExtractionPngOutputArgs,
  isMotionExportPreset,
  isStillFrameExportPreset,
  listMotionExportPresets,
  measureAudioLevels,
  parseFfmpegVideoEncoders,
  probeMedia,
  probeMotionTool,
  probeFfmpegEncoderCapabilities,
  probeFfmpegHardwareEncoderUsability,
  resolveMotionExportPreset,
  resolveExportPreset,
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  selectFfmpegPresetEncoder,
  type FfmpegCommand,
  type FfmpegHardwareEncoder,
  type FfmpegHardwareEncoderUsability,
  type FfmpegRunner
} from "./index";

const tempDirs: string[] = [];
const H264_SDR_OUTPUT_ARGS = [
  "-c:v", "libx264",
  "-crf", "18",
  "-preset", "medium",
  "-pix_fmt", "yuv420p",
  "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-color_range", "tv",
  "-movflags", "+faststart"
];

/**
 * The runner calls that ENCODED, with the post-encode delivered-colour readback filtered out.
 *
 * under the current contract a successful encode reads the delivered file's colour tags back with ffprobe
 * (`verifyDeliveredColor`, default-on), so a test about encoder SELECTION or fallback now sees one
 * extra call per successful encode. Those tests assert on the encode sequence, so they filter here
 * rather than re-index around a command they are not about; the readback has its own coverage in
 * the "delivered colour readback" suite, and is asserted explicitly at the two sites where the
 * readback itself is the subject (the configured-executable test and the nvenc default test).
 */
function commandsWithoutColorReadback(commands: FfmpegCommand[]): FfmpegCommand[] {
  return commands.filter((command) => !command.args.includes("-show_streams"));
}

describe("ffmpeg finalization lane", () => {
  beforeEach(() => {
    applyEnv("LOCALAPPDATA", undefined);
    applyEnv("SHELLX_MOTION_FFMPEG", undefined);
    applyEnv("SHELLX_MOTION_FFPROBE", undefined);
    applyEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", undefined);
    applyEnv("SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS", undefined);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("tells the user FFmpeg is missing and how to install it, not just the spawn error", async () => {
    // `ffmpeg: command not found` is accurate and useless to someone who does not know FFmpeg is a
    // separate program Motion depends on. ShellX Cut hit exactly this with new users, who concluded
    // the product was broken. The raw error stays in `detail` for diagnosing a BROKEN install.
    const runner: FfmpegRunner = async () => ({ exitCode: 127, stdout: "", stderr: "ffmpeg: command not found" });

    const health = await checkFfmpeg({ runner });

    expect(health.ok).toBe(false);
    if (health.ok) throw new Error("unreachable");
    expect(health.error.code).toBe("ffmpeg_not_configured");
    expect(health.error.message).toMatch(/FFmpeg is not installed/);
    expect(health.error.detail).toBe("ffmpeg: command not found");
    expect(health.error.suggestedAction).toMatch(/Install FFmpeg/);
    expect(health.error.requirement?.installOptions.length).toBeGreaterThan(0);
    expect(health.error.requirement?.overrideEnvVar).toBe("SHELLX_MOTION_FFMPEG");
  });

  it("does not claim FFmpeg is missing when it is present but unusable", async () => {
    // A broken install, a permissions problem or a bad architecture is a different fix. Telling
    // that user to install FFmpeg sends them to repair something that is not the problem.
    const runner: FfmpegRunner = async () => ({ exitCode: 1, stdout: "", stderr: "Illegal instruction (core dumped)" });

    const health = await checkFfmpeg({ runner });

    expect(health.ok).toBe(false);
    if (health.ok) throw new Error("unreachable");
    // Raw message preserved, and crucially NO install guidance — the binary is there.
    expect(health.error.message).toBe("Illegal instruction (core dumped)");
    expect(health.error.suggestedAction).toBeUndefined();
    expect(health.error.requirement).toBeUndefined();
  });

  it("preserves governor failures during FFmpeg health and encoder discovery", async () => {
    const runner: FfmpegRunner = async () => ({
      exitCode: 125,
      stdout: "",
      stderr: "Motion job queue is full (1).",
      resourceErrorCode: "job_queue_full",
    });

    await expect(checkFfmpeg({ runner })).resolves.toMatchObject({
      ok: false,
      error: { code: "job_queue_full" },
    });
    await expect(probeFfmpegEncoderCapabilities({ runner })).resolves.toMatchObject({
      ok: false,
      error: { code: "job_queue_full" },
    });
  });

  it("discovers compiled H.264, HEVC, AV1, VP9, and ProRes encoders without claiming hardware usability", async () => {
    const encoderOutput = [
      "Encoders:",
      " V..... libx264              libx264 H.264 encoder (codec h264)",
      " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
      " V....D libx265              libx265 H.265 encoder (codec hevc)",
      " V..... libsvtav1            SVT-AV1 encoder (codec av1)",
      " V....D libaom-av1           libaom AV1 encoder (codec av1)",
      " V....D av1_nvenc            NVIDIA NVENC AV1 encoder (codec av1)",
      " V....D libvpx-vp9           libvpx VP9 encoder (codec vp9)",
      " VF...D prores_ks            Apple ProRes encoder (codec prores)",
      " A..... aac                  AAC encoder"
    ].join("\n");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: encoderOutput, stderr: "" };
    };

    const capabilities = await probeFfmpegEncoderCapabilities({ runner });
    expect(capabilities).toEqual({
      ok: true,
      command: "ffmpeg",
      compiledEncoders: ["av1_nvenc", "h264_nvenc", "libaom-av1", "libsvtav1", "libvpx-vp9", "libx264", "libx265", "prores_ks"],
      codecs: {
        h264: ["h264_nvenc", "libx264"],
        hevc: ["libx265"],
        av1: ["av1_nvenc", "libaom-av1", "libsvtav1"],
        vp9: ["libvpx-vp9"],
        prores: ["prores_ks"]
      },
      softwarePreferred: {
        h264: "libx264",
        hevc: "libx265",
        av1: "libsvtav1",
        vp9: "libvpx-vp9",
        prores: "prores_ks"
      }
    });
    expect(selectFfmpegPresetEncoder("mp4-hevc", capabilities)).toEqual({
      ok: true,
      preset: "mp4-hevc",
      family: "hevc",
      encoder: "libx265",
      mode: "software-preferred"
    });
    expect(selectFfmpegPresetEncoder("webm-av1", capabilities)).toEqual({
      ok: true,
      preset: "webm-av1",
      family: "av1",
      encoder: "libsvtav1",
      mode: "software-preferred"
    });
    expect(commands).toEqual([
      { executable: "ffmpeg", args: ["-hide_banner", "-encoders"], shell: false }
    ]);
    expect(parseFfmpegVideoEncoders(" V..... libx264 x\n A..... aac y\n V..... libx264 duplicate")).toEqual(["libx264"]);
  });

  it("initializes compiled hardware encoders before reporting them usable", async () => {
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("-encoders")) {
        return {
          exitCode: 0,
          stdout: [
            " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
            " V....D h264_qsv             Intel QSV H.264 encoder (codec h264)",
            " V....D h264_vaapi           VAAPI H.264 encoder (codec h264)"
          ].join("\n"),
          stderr: ""
        };
      }
      const encoder = command.args[command.args.indexOf("-c:v") + 1];
      if (encoder === "h264_qsv") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: `${encoder} failed SECRET_TOKEN=hidden` };
    };

    await expect(probeFfmpegHardwareEncoderUsability({
      runner,
      vaapiDevice: "/dev/dri/renderD128",
      encoders: ["h264_nvenc", "h264_videotoolbox", "h264_qsv", "h264_amf", "h264_vaapi"]
    })).resolves.toEqual({
      ok: true,
      command: "ffmpeg",
      selection: "first-usable",
      usableEncoders: ["h264_qsv"],
      probes: [
        { encoder: "h264_nvenc", compiled: true, usable: false, status: "initialization_failed", exitCode: 1, message: "h264_nvenc failed SECRET_TOKEN=[redacted]" },
        { encoder: "h264_videotoolbox", compiled: false, usable: false, status: "not_compiled" },
        { encoder: "h264_qsv", compiled: true, usable: true, status: "usable", exitCode: 0 },
        { encoder: "h264_amf", compiled: false, usable: false, status: "not_compiled" },
        { encoder: "h264_vaapi", compiled: true, usable: false, status: "initialization_failed", exitCode: 1, message: "h264_vaapi failed SECRET_TOKEN=[redacted]" }
      ]
    });
    expect(commands).toHaveLength(4);
    expect(commands[1]).toMatchObject({ shell: false, args: expect.arrayContaining(["-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"]) });
    expect(commands[3].args).toEqual(expect.arrayContaining(["-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi"]));
  });

  it("reports a successful empty hardware probe when no candidate is compiled", async () => {
    await expect(probeFfmpegHardwareEncoderUsability({
      runner: async () => ({ exitCode: 0, stdout: " V..... libx264              libx264 H.264 encoder (codec h264)", stderr: "" })
    })).resolves.toMatchObject({
      ok: true,
      usableEncoders: [],
      probes: expect.arrayContaining([
        { encoder: "h264_nvenc", compiled: false, usable: false, status: "not_compiled" }
      ])
    });
  });

  it("preserves resource-governor failures during hardware initialization", async () => {
    let calls = 0;
    await expect(probeFfmpegHardwareEncoderUsability({
      runner: async (command) => {
        calls += 1;
        if (command.args.includes("-encoders")) {
          return { exitCode: 0, stdout: " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)", stderr: "" };
        }
        return { exitCode: 125, stdout: "", stderr: "Motion job queue is full.", resourceErrorCode: "job_queue_full" };
      }
    })).resolves.toEqual({
      ok: false,
      command: "ffmpeg",
      error: { code: "job_queue_full", message: "Motion job queue is full." }
    });
    expect(calls).toBe(2);
  });

  it("returns a bounded encoder-discovery failure instead of an empty capability claim", async () => {
    const runner: FfmpegRunner = async () => ({ exitCode: 1, stdout: "", stderr: "encoder probe failed SECRET_TOKEN=hidden" });

    await expect(probeFfmpegEncoderCapabilities({ runner })).resolves.toEqual({
      ok: false,
      command: "ffmpeg",
      error: { code: "ffmpeg_encoder_probe_failed", message: "encoder probe failed SECRET_TOKEN=[redacted]" }
    });
  });

  it("falls back between supported AV1 software encoders and refuses compiled hardware-only HEVC", async () => {
    const capabilities = await probeFfmpegEncoderCapabilities({
      runner: async () => ({
        exitCode: 0,
        stdout: [
          " V....D libaom-av1           libaom AV1 encoder (codec av1)",
          " V....D av1_nvenc            NVIDIA NVENC AV1 encoder (codec av1)",
          " V....D hevc_nvenc           NVIDIA NVENC HEVC encoder (codec hevc)"
        ].join("\n"),
        stderr: ""
      })
    });

    expect(selectFfmpegPresetEncoder("webm-av1", capabilities)).toMatchObject({
      ok: true,
      family: "av1",
      encoder: "libaom-av1",
      mode: "software-preferred"
    });
    expect(selectFfmpegPresetEncoder("mp4-hevc", capabilities)).toEqual({
      ok: false,
      preset: "mp4-hevc",
      error: {
        code: "encoder_unavailable",
        message: "Export preset mp4-hevc requires a supported software HEVC encoder (libx265); compiled HEVC encoders: hevc_nvenc."
      }
    });
  });

  it("fails an actual modern-codec render before encoding when no supported software encoder is compiled", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-encoder-unavailable-"));
    tempDirs.push(outDir);
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "unavailable.mp4");
    const commands: FfmpegCommand[] = [];
    const result = await encodeImageSequence({
      packageId: "pkg_unavailable_hevc",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath,
      preset: "mp4-hevc",
      runner: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: " V....D hevc_nvenc           NVIDIA NVENC HEVC encoder (codec hevc)",
          stderr: ""
        };
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "encoder_unavailable",
        message: "Export preset mp4-hevc requires a supported software HEVC encoder (libx265); compiled HEVC encoders: hevc_nvenc."
      }
    });
    expect(commands).toEqual([{ executable: "ffmpeg", args: ["-hide_banner", "-encoders"], shell: false }]);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects hostile frame counts before allocating a frame-path list or invoking FFmpeg", async () => {
    let invoked = false;
    const result = await encodeImageSequence({
      packageId: "pkg_oversized_frame_count",
      framesDir: ".scratch/frames",
      fps: 120,
      width: 1_920,
      height: 1_080,
      durationMs: 10_000_000,
      outputPath: ".scratch/oversized.mp4",
      runner: async () => {
        invoked = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "job_input_budget_exceeded" } });
    expect(invoked).toBe(false);
  });

  it("uses configured ffmpeg and ffprobe executable paths without a shell", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-configured-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    await writeContrastFrames(outDir, 2);

    await withExecutableEnv(
      {
        SHELLX_MOTION_FFMPEG: "/opt/shellx/bin/ffmpeg-custom",
        SHELLX_MOTION_FFPROBE: "/opt/shellx/bin/ffprobe-custom"
      },
      async () => {
        const commands: FfmpegCommand[] = [];
        const runner: FfmpegRunner = async (command) => {
          commands.push(command);
          if (command.args[0] !== "-version" && command.executable.includes("ffmpeg")) {
            await writeFile(outputPath, "fake mp4 bytes", "utf8");
          }
          return {
            exitCode: 0,
            stdout: command.executable.includes("ffprobe")
              ? JSON.stringify({ streams: [{}], format: { duration: "1.000000" } })
              : "ffmpeg version custom",
            stderr: ""
          };
        };

        await expect(checkFfmpeg({ runner })).resolves.toMatchObject({ ok: true, command: "ffmpeg" });
        await expect(
          encodeImageSequence({
            packageId: "pkg_lower_third",
            framesDir: outDir,
            fps: 2,
            width: 2,
            height: 1,
            durationMs: 1000,
            outputPath,
            runner
          })
        ).resolves.toMatchObject({ ok: true });
        await expect(probeMedia(outputPath, { runner })).resolves.toMatchObject({ ok: true, path: outputPath });

        // Four calls, not three: `checkFfmpeg`, the encode, the encode's own delivered-colour
        // readback (`verifyDeliveredColor`, default-on under the current contract), then the explicit
        // `probeMedia` above. The readback is the third entry, and it is what proves the readback
        // resolves the CONFIGURED ffprobe rather than a bare `ffprobe` off PATH.
        expect(commands.map((command) => ({ executable: command.executable, shell: command.shell }))).toEqual([
          { executable: "/opt/shellx/bin/ffmpeg-custom", shell: false },
          { executable: "/opt/shellx/bin/ffmpeg-custom", shell: false },
          { executable: "/opt/shellx/bin/ffprobe-custom", shell: false },
          { executable: "/opt/shellx/bin/ffprobe-custom", shell: false }
        ]);
      }
    );
  });

  it("rejects FFmpeg outputs outside configured output roots before invoking the runner", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-output-root-"));
    tempDirs.push(outDir);
    await writeContrastFrames(outDir, 2);

    const result = await encodeImageSequence({
      packageId: "pkg_output_root",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath: join(outDir, "..", "escaped.mp4"),
      outputRoots: [outDir],
      runner: async () => {
        throw new Error("FFmpeg runner should not be invoked for unsafe output paths");
      }
    });

    expect(result).toEqual({
      ok: false,
      command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
      error: {
        code: "unsafe_input_path",
        message: "Unsafe FFmpeg output path: path must be inside a trusted output root."
      }
    });
  });

  it.skipIf(process.platform === "win32")("kills FFmpeg commands that exceed the configured timeout", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-timeout-"));
    tempDirs.push(outDir);
    const hangingFfmpeg = join(outDir, "ffmpeg-hang.js");
    await writeFile(
      hangingFfmpeg,
      "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 500);\n",
      "utf8"
    );
    await chmod(hangingFfmpeg, 0o755);

    await withExecutableEnv(
      {
        SHELLX_MOTION_FFMPEG: hangingFfmpeg,
        SHELLX_MOTION_FFMPEG_TIMEOUT_MS: "50"
      },
      async () => {
        const result = await checkFfmpeg();

        expect(result).toEqual({
          ok: false,
          command: "ffmpeg",
          error: {
            code: "ffmpeg_not_configured",
            message: "FFmpeg command timed out after 50ms."
          }
        });
      }
    );
  });

  it("terminates a shell-free renderer child when the shared wall-clock governor expires", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-governor-"));
    tempDirs.push(outDir);
    const policy: LocalMotionJobPolicy = {
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 1_000,
      maxWallClockMs: 100,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 512 * 1024 * 1024,
      rssPollIntervalMs: 25,
    };
    const runner = createGovernedFfmpegRunner({
      scratchRoot: outDir,
      governor: new LocalMotionJobGovernor(policy, { freeScratchBytes: async () => 1_000_000_000 }),
    });

    const result = await runner({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 5000)"],
      shell: false,
    });

    expect(result).toMatchObject({
      exitCode: 125,
      resourceErrorCode: "job_deadline_exceeded",
      resources: {
        schema: "shellx-motion/local-job-resources@1",
        lane: "ffmpeg",
        operation: "ffmpeg.render",
        state: "deadline_exceeded",
        watchedProcessCount: 1,
      },
    });
    if (process.platform === "win32") {
      expect(result.resources?.processContainment).toMatchObject({ killTree: true });
      expect(["windows-job-object", "windows-taskkill-fallback"]).toContain(result.resources?.processContainment?.mode);
    } else {
      expect(result.resources?.processContainment).toMatchObject({ mode: "unix-process-group", status: "enforced", killTree: true });
    }
    expect(result.stderr).toContain("wall-clock budget");
  });

  it.skipIf(process.platform === "win32")("terminates encoder descendants with the governed Unix process group", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-process-tree-"));
    tempDirs.push(outDir);
    const grandchildPidPath = join(outDir, "grandchild.pid");
    const policy: LocalMotionJobPolicy = {
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 1_000,
      maxWallClockMs: 300,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 512 * 1024 * 1024,
      rssPollIntervalMs: 25,
    };
    const runner = createGovernedFfmpegRunner({
      scratchRoot: outDir,
      governor: new LocalMotionJobGovernor(policy, { freeScratchBytes: async () => 1_000_000_000 }),
    });
    const parentCode = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])",
      "writeFileSync(process.argv[1], String(child.pid))",
      "setInterval(() => {}, 1000)"
    ].join("; ");

    const result = await runner({
      executable: process.execPath,
      args: ["-e", parentCode, grandchildPidPath],
      shell: false,
    });

    expect(result).toMatchObject({ exitCode: 125, resourceErrorCode: "job_deadline_exceeded" });
    const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    await expectProcessToExit(grandchildPid);
  });

  it.skipIf(process.platform !== "win32")("terminates encoder descendants through an enforced Windows Job Object", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-windows-job-object-"));
    tempDirs.push(outDir);
    const grandchildPidPath = join(outDir, "grandchild.pid");
    const policy: LocalMotionJobPolicy = {
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 1_000,
      // Leave room for a cold PowerShell Add-Type compile before proving descendant teardown.
      maxWallClockMs: 2_000,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 768 * 1024 * 1024,
      rssPollIntervalMs: 25,
    };
    const runner = createGovernedFfmpegRunner({
      scratchRoot: outDir,
      governor: new LocalMotionJobGovernor(policy, { freeScratchBytes: async () => 1_000_000_000 }),
    });
    const parentCode = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])",
      "writeFileSync(process.argv[1], String(child.pid))",
      "setInterval(() => {}, 1000)"
    ].join("; ");

    const result = await runner({
      executable: process.execPath,
      args: ["-e", parentCode, grandchildPidPath],
      shell: false,
    });

    expect(result).toMatchObject({
      exitCode: 125,
      resourceErrorCode: "job_deadline_exceeded",
      resources: {
        processContainment: {
          schema: "shellx-motion/process-containment@1",
          mode: "windows-job-object",
          status: "enforced",
          killTree: true,
          memoryLimit: "job-commit",
          maxJobMemoryBytes: policy.maxProcessTreeRssBytes,
          maxActiveProcesses: 4_096,
          launcher: { kind: "powershell-csharp", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
      },
    });
    const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    await expectProcessToExit(grandchildPid);
  });

  it.skipIf(process.platform !== "win32")("fails closed when strict native Windows containment cannot load its trusted helper", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-windows-job-strict-"));
    tempDirs.push(outDir);
    const runner = createGovernedFfmpegRunner({
      scratchRoot: outDir,
      governor: new LocalMotionJobGovernor({
        maxConcurrentJobs: 1,
        maxQueueDepth: 1,
        maxQueueWaitMs: 1_000,
        maxWallClockMs: 5_000,
        minFreeScratchBytes: 0,
        scratchReservationBytes: 0,
        maxProcessTreeRssBytes: 512 * 1024 * 1024,
        rssPollIntervalMs: 25,
      }, { freeScratchBytes: async () => 1_000_000_000 }),
    });

    await withExecutableEnv({
      SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT: "1",
      SHELLX_MOTION_WINDOWS_JOB_HELPER: join(outDir, "missing-helper.ps1"),
    }, async () => {
      const result = await runner({ executable: process.execPath, args: ["--version"], shell: false });
      expect(result).toMatchObject({
        exitCode: 125,
        resourceErrorCode: "job_process_containment_unavailable",
        resources: {
          state: "failed",
          watchedProcessCount: 0,
          processContainment: {
            mode: "direct-child",
            status: "unavailable",
            killTree: false,
            reasonCode: "native_helper_missing",
          },
        },
      });
      expect(result.stderr).toContain("requires native Windows Job Object containment");
    });
  });

  it("discovers user-local ShellX family FFmpeg tools on Windows hosts", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "shellx-motion-localappdata-"));
    tempDirs.push(localAppData);
    const shellxCutFfmpegDir = join(localAppData, "ShellX Cut", "tools", "ffmpeg", "bin");
    await mkdir(shellxCutFfmpegDir, { recursive: true });
    await writeFile(join(shellxCutFfmpegDir, "ffmpeg.exe"), "", "utf8");
    await writeFile(join(shellxCutFfmpegDir, "ffprobe.exe"), "", "utf8");

    await withExecutableEnv(
      {
        LOCALAPPDATA: localAppData,
        SHELLX_MOTION_FFMPEG: undefined,
        SHELLX_MOTION_FFPROBE: undefined
      },
      async () => {
        expect(resolveFfmpegExecutable()).toBe(join(shellxCutFfmpegDir, "ffmpeg.exe"));
        expect(resolveFfprobeExecutable()).toBe(join(shellxCutFfmpegDir, "ffprobe.exe"));
      }
    );
  });

  it("discovers nested portable FFmpeg installs in ShellX family tool folders", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "shellx-motion-localappdata-nested-"));
    tempDirs.push(localAppData);
    const shellxMotionFfmpegDir = join(localAppData, "ShellX Motion", "tools", "ffmpeg", "ffmpeg-8.1.1-essentials_build", "bin");
    await mkdir(shellxMotionFfmpegDir, { recursive: true });
    await writeFile(join(shellxMotionFfmpegDir, "ffmpeg.exe"), "", "utf8");
    await writeFile(join(shellxMotionFfmpegDir, "ffprobe.exe"), "", "utf8");

    await withExecutableEnv(
      {
        LOCALAPPDATA: localAppData,
        SHELLX_MOTION_FFMPEG: undefined,
        SHELLX_MOTION_FFPROBE: undefined
      },
      async () => {
        expect(resolveFfmpegExecutable()).toBe(join(shellxMotionFfmpegDir, "ffmpeg.exe"));
        expect(resolveFfprobeExecutable()).toBe(join(shellxMotionFfmpegDir, "ffprobe.exe"));
      }
    );
  });

  it("describes export preset metadata for host inspectors and agents", () => {
    expect(resolveExportPreset("mp4-h264")).toMatchObject({
      preset: "mp4-h264",
      label: "MP4 H.264",
      codec: "h264",
      container: "mp4",
      extension: "mp4",
      mimeType: "video/mp4",
      audioCodec: "aac",
      supportsAudio: true,
      supportsAlpha: false,
      color: {
        profile: "sdr-bt709",
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        range: "tv",
        conversion: "rgb-full-to-yuv-limited"
      }
    });
    expect(resolveExportPreset("gif")).toMatchObject({
      preset: "gif",
      label: "Animated GIF",
      extension: "gif",
      mimeType: "image/gif",
      audioCodec: null,
      supportsAudio: false,
      supportsAlpha: false,
      color: null
    });
    expect(resolveExportPreset("mp4-hevc")).toMatchObject({
      preset: "mp4-hevc",
      label: "MP4 HEVC",
      codec: "hevc",
      container: "mp4",
      extension: "mp4",
      mimeType: "video/mp4",
      audioCodec: "aac",
      supportsAudio: true,
      supportsAlpha: false,
      encoderPolicy: { family: "hevc", mode: "software-preferred", candidates: ["libx265"] }
    });
    expect(resolveExportPreset("webm-av1")).toMatchObject({
      preset: "webm-av1",
      label: "WebM AV1",
      codec: "av1",
      container: "webm",
      extension: "webm",
      mimeType: "video/webm",
      audioCodec: "libopus",
      supportsAudio: true,
      supportsAlpha: false,
      encoderPolicy: { family: "av1", mode: "software-preferred", candidates: ["libsvtav1", "libaom-av1"] }
    });
    expect(resolveExportPreset("mov-prores")).toMatchObject({
      preset: "mov-prores",
      label: "MOV ProRes 4444",
      extension: "mov",
      mimeType: "video/quicktime",
      audioCodec: "pcm_s16le",
      supportsAudio: true,
      supportsAlpha: true
    });
    expect(resolveExportPreset("webm-vp9-alpha")).toMatchObject({
      preset: "webm-vp9-alpha",
      label: "WebM VP9 Alpha",
      codec: "vp9",
      container: "webm",
      extension: "webm",
      mimeType: "video/webm",
      audioCodec: "libopus",
      supportsAudio: true,
      supportsAlpha: true
    });
  });

  it("describes PNG sequence exports as a Motion preset without widening FFmpeg video presets", () => {
    expect(isMotionExportPreset("png-sequence")).toBe(true);
    expect(resolveMotionExportPreset("png-sequence")).toMatchObject({
      preset: "png-sequence",
      label: "PNG Sequence",
      codec: "png",
      container: "image-sequence",
      extension: "png",
      mimeType: "image/png",
      audioCodec: null,
      supportsAudio: false,
      supportsAlpha: true,
      outputKind: "image_sequence"
    });
    expect(isStillFrameExportPreset("png-frame")).toBe(true);
    expect(resolveMotionExportPreset("png-frame")).toMatchObject({
      preset: "png-frame",
      label: "PNG Frame",
      codec: "png",
      container: "image",
      extension: "png",
      mimeType: "image/png",
      audioCodec: null,
      supportsAudio: false,
      supportsAlpha: true,
      outputKind: "still_frame"
    });
    expect(resolveMotionExportPreset("jpeg-frame")).toMatchObject({
      preset: "jpeg-frame",
      label: "JPEG Frame",
      codec: "jpeg",
      container: "image",
      extension: "jpg",
      mimeType: "image/jpeg",
      audioCodec: null,
      supportsAudio: false,
      supportsAlpha: false,
      outputKind: "still_frame"
    });
    expect(listMotionExportPresets().map((preset) => preset.preset)).toEqual([
      "mp4-h264",
      "mp4-hevc",
      "webm-av1",
      "webm-vp9",
      "webm-vp9-alpha",
      "gif",
      "mov-prores",
      "png-sequence",
      "png-frame",
      "jpeg-frame"
    ]);
  });

  it("rejects FFmpeg output paths whose extension disagrees with the preset container", () => {
    expect(ffmpegPresetOutputPathError("webm-vp9-alpha", "/tmp/render.mp4")).toBe(
      "webm-vp9-alpha outputs must use a .webm path."
    );
    expect(ffmpegPresetOutputPathError("mov-prores", "/tmp/render.webm")).toBe(
      "mov-prores outputs must use a .mov path."
    );
    expect(ffmpegPresetOutputPathError("mp4-h264", "/tmp/render.MP4")).toBeNull();
  });

  it("selects supported HEVC and AV1 encoders before final encode and receipts the choice", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-modern-codecs-"));
    tempDirs.push(outDir);
    await writeContrastFrames(outDir, 2);
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("-encoders")) {
        return {
          exitCode: 0,
          stdout: [
            " V....D libx265              libx265 H.265 encoder (codec hevc)",
            " V..... libsvtav1            SVT-AV1 encoder (codec av1)",
            " V....D libaom-av1           libaom AV1 encoder (codec av1)"
          ].join("\n"),
          stderr: ""
        };
      }
      await writeFile(command.args.at(-1) as string, "encoded bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const hevc = await encodeImageSequence({
      packageId: "pkg_hevc",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath: join(outDir, "render-hevc.mp4"),
      preset: "mp4-hevc",
      runner
    });
    const av1 = await encodeImageSequence({
      packageId: "pkg_av1",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath: join(outDir, "render-av1.webm"),
      preset: "webm-av1",
      runner
    });

    // No hardware opt-in here, so software runs by default; the receipt records the software encoder
    // identity and reason (encoderSelection field was replaced by encoderSource + encoderReason).
    expect(hevc).toMatchObject({
      ok: true,
      receipt: { output: { preset: "mp4-hevc", codec: "hevc", encoder: "libx265", encoderSource: "software", encoderReason: "software-default" } }
    });
    expect(av1).toMatchObject({
      ok: true,
      receipt: { output: { preset: "webm-av1", codec: "av1", encoder: "libsvtav1", encoderSource: "software", encoderReason: "software-default" } }
    });
    // This test is about ENCODER SELECTION, so it counts the commands that encode. Each successful
    // encode is now followed by a delivered-colour readback (`verifyDeliveredColor`, default-on
    // under the current contract); that readback has its own coverage in "delivered colour readback" below,
    // and folding it into these indices here would only make the selection assertions fragile.
    const selectionCommands = commandsWithoutColorReadback(commands);
    expect(commands).toHaveLength(6);
    expect(selectionCommands).toHaveLength(4);
    expect(selectionCommands[1].args).toEqual(expect.arrayContaining(["-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p10le"]));
    expect(selectionCommands[3].args).toEqual(expect.arrayContaining(["-c:v", "libsvtav1", "-crf", "30", "-preset", "6", "-pix_fmt", "yuv420p"]));
    expect(buildEncodeImageSequenceCommand({
      framesDir: outDir,
      fps: 2,
      durationMs: 1000,
      outputPath: join(outDir, "fallback.webm"),
      preset: "webm-av1",
      videoEncoder: "libaom-av1"
    }).args).toEqual(expect.arrayContaining(["-c:v", "libaom-av1", "-b:v", "0", "-cpu-used", "6"]));
  });

  it("rejects direct FFmpeg encodes whose output extension disagrees with the preset container before invoking the runner", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-extension-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    await writeContrastFrames(outDir, 2);
    let invoked = false;
    const runner: FfmpegRunner = async () => {
      invoked = true;
      await writeFile(outputPath, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_extension",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath,
      preset: "webm-vp9-alpha",
      runner
    });

    expect(result).toEqual({
      ok: false,
      command: { executable: resolveFfmpegExecutable(), args: [], shell: false },
      error: {
        code: "invalid_output_path",
        message: "webm-vp9-alpha outputs must use a .webm path."
      }
    });
    expect(invoked).toBe(false);
    expect(() => buildEncodeImageSequenceCommand({
      framesDir: outDir,
      fps: 2,
      durationMs: 1000,
      outputPath,
      preset: "mov-prores"
    })).toThrow("mov-prores outputs must use a .mov path.");
  });

  it("emits a render receipt for PNG sequence outputs without invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-png-sequence-receipt-"));
    tempDirs.push(outDir);
    await writeContrastFrames(outDir, 3);

    const receipt = await createImageSequenceReceipt({
      packageId: "pkg_sequence",
      framesDir: outDir,
      fps: 3,
      width: 2,
      height: 1,
      durationMs: 1000,
      frameCount: 3,
      now: () => "2026-07-01T02:00:00.000Z"
    });

    expect(receipt).toMatchObject({
      operation: "render.final",
      status: "passed",
      packageId: "pkg_sequence",
      lane: "image-sequence",
      createdAt: "2026-07-01T02:00:00.000Z",
      output: {
        path: outDir,
        framePattern: "%06d.png",
        frameCount: 3,
        width: 2,
        height: 1,
        durationMs: 1000,
        fps: 3,
        codec: "png",
        container: "image-sequence",
        preset: "png-sequence"
      },
      artifacts: [
        { role: "frame_sequence", path: outDir, status: "available", mediaType: "image/png", primary: true }
      ],
      warnings: []
    });
    expect(receipt.id).toMatch(/^png-sequence-render-/);
    expect(receipt.inputHashes.frames).toMatch(/^[a-f0-9]{64}$/);
    expect((receipt.output as { sha256?: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits a render receipt for still-frame image outputs without invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-still-frame-receipt-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "frame.png");
    await writeFile(outputPath, CONTRAST_PNG);

    const receipt = await createStillFrameReceipt({
      packageId: "pkg_frame",
      outputPath,
      preset: "png-frame",
      width: 2,
      height: 1,
      atMs: 500,
      now: () => "2026-07-01T02:30:00.000Z"
    });

    expect(receipt).toMatchObject({
      operation: "render.final",
      status: "passed",
      packageId: "pkg_frame",
      lane: "image",
      createdAt: "2026-07-01T02:30:00.000Z",
      output: {
        path: outputPath,
        width: 2,
        height: 1,
        atMs: 500,
        codec: "png",
        container: "image",
        preset: "png-frame"
      },
      artifacts: [
        { role: "still_frame", path: outputPath, status: "available", mediaType: "image/png", primary: true }
      ],
      warnings: []
    });
    expect(receipt.id).toMatch(/^still-frame-render-/);
    expect(receipt.inputHashes.frame).toMatch(/^[a-f0-9]{64}$/);
    expect((receipt.output as { sha256?: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates still-frame receipt bytes against the claimed image preset", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-still-frame-codec-"));
    tempDirs.push(outDir);
    const jpegPath = join(outDir, "frame.jpg");
    const mismatchedPath = join(outDir, "mismatch.jpg");
    await writeFile(jpegPath, JPEG_BYTES);
    await writeFile(mismatchedPath, CONTRAST_PNG);

    await expect(createStillFrameReceipt({
      packageId: "pkg_jpeg_frame",
      outputPath: jpegPath,
      preset: "jpeg-frame",
      width: 2,
      height: 1,
      atMs: 250
    })).resolves.toMatchObject({
      lane: "image",
      output: {
        path: jpegPath,
        codec: "jpeg",
        container: "image",
        preset: "jpeg-frame"
      },
      artifacts: [
        { role: "still_frame", path: jpegPath, status: "available", mediaType: "image/jpeg", primary: true }
      ]
    });

    await expect(createStillFrameReceipt({
      packageId: "pkg_jpeg_frame",
      outputPath: mismatchedPath,
      preset: "jpeg-frame",
      width: 2,
      height: 1,
      atMs: 250
    })).rejects.toThrow(/does not match jpeg-frame/);
  });

  it("encodes a PNG sequence through shell-free ffmpeg argv and emits a render receipt", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 30);
    await withExecutableEnv(
      {
        LOCALAPPDATA: undefined,
        SHELLX_MOTION_FFMPEG: undefined,
        SHELLX_MOTION_FFPROBE: undefined
      },
      async () => {
        const runner: FfmpegRunner = async (command) => {
          commands.push(command);
          await writeFile(outputPath, "fake mp4 bytes", "utf8");
          // Routine progress output plus one genuine diagnostic carrying a secret: the receipt
          // must drop the former and keep the latter, redacted.
          return { exitCode: 0, stdout: "", stderr: "frame=30 speed=1x\n[mp4 @ 0x1] Past duration too large SECRET_TOKEN=hidden" };
        };

        const result = await encodeImageSequence({
          packageId: "pkg_lower_third",
          framesDir: outDir,
          fps: 30,
          width: 1920,
          height: 1080,
          durationMs: 1000,
          outputPath,
          runner,
          now: () => "2026-06-29T21:46:00.000Z"
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(commands[0]).toEqual({
          executable: "ffmpeg",
          args: [
            "-y",
            "-framerate",
            "30",
            "-start_number",
            "1",
            "-protocol_whitelist",
            "file",
            "-i",
            join(outDir, "%06d.png"),
            "-frames:v",
            "30",
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
            outputPath
          ],
          shell: false
        });
        expect(result.receipt).toMatchObject({
          operation: "render.final",
          // `warning`, not `passed`: 30 identical frames at 1000ms, so the receipt already carried
          // the static-sequence, motion-density and review-length advisories. under the current contract a
          // render receipt escalates on an actionable warning under the shared rule in
          // `@shellx-motion/core` — it can no longer assert success while telling the reader the
          // output never moves. Routine encoder chatter still does not
          // escalate, which the redaction assertions below still prove.
          status: "warning",
          packageId: "pkg_lower_third",
          lane: "ffmpeg",
          createdAt: "2026-06-29T21:46:00.000Z",
          output: {
            path: outputPath,
            width: 1920,
            height: 1080,
            durationMs: 1000,
            codec: "h264",
            container: "mp4",
            color: {
              profile: "sdr-bt709",
              primaries: "bt709",
              transfer: "bt709",
              matrix: "bt709",
              range: "tv",
              conversion: "rgb-full-to-yuv-limited"
            }
          },
          artifacts: [
            { role: "rendered_media", path: outputPath, status: "available", mediaType: "video/mp4", primary: true }
          ]
        });
        // This fixture sequence is identical frame to frame, so the freeze measurement folded into
        // the frame-quality pass reports it on the render receipt alongside the coarse
        // all-frames-identical warning: the percentage and the frozen range are what tell an author
        // WHERE a partially-static piece stops moving.
        expect(result.receipt.warnings).toEqual([
          "Rendered video is 1000ms; product review clips should be at least 1500ms.",
          "Rendered frame sequence is static; verify this is intentional before using it as product output.",
          "Rendered motion is static for 100.0% of its duration (1.000s of 1.000s across 1 frozen run,"
          + " longest 1.000s). Frozen (s): 0.000-1.000. Verify this is intentional; measured as mean"
          + " absolute frame difference <= 0.003000 over runs of at least 0.300s.",
          "[mp4 @ [address]] Past duration too large SECRET_TOKEN=[redacted]"
        ]);
        // under the current contract a freeze observation DOES move the receipt to `warning`, under the one
        // rule every receipt surface now shares (`receiptStatusForWarnings` in
        // `@shellx-motion/core`). A static title card is still a legitimate deliverable and the
        // encode still succeeded — `warning` says exactly that, and `failed` would not.
        //
        // This does not reopen the success-status invariant, which was about NOISE: routine encoder output
        // recorded as warnings, so `warnings.length > 0` told a caller nothing. That half is still
        // enforced below and by the chatter carve-out — the redacted `[mp4 @ [address]]` diagnostic
        // sits on this receipt without being what escalated it. What escalated it is Motion's own
        // statement that the output never moves, which is precisely the kind of thing a status is
        // supposed to be about.
        expect(result.receipt.status).toBe("warning");
        // Routine progress output is not a warning: recording it made every clean encode look
        // like it had flagged something.
        expect(result.receipt.warnings.join(" ")).not.toContain("frame=30");
        expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN=hidden");
        expect(result.receipt.output).toHaveProperty("sha256");
      }
    );
  });

  it("encodes a PNG sequence with the WebM VP9 export preset", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-webm-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.webm");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake webm bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_webm",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      preset: "webm-vp9",
      runner,
      now: () => "2026-06-30T05:30:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toEqual({
      executable: "ffmpeg",
      args: [
        "-y",
        "-framerate",
        "2",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "%06d.png"),
        "-frames:v",
        "2",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "32",
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
        outputPath
      ],
      shell: false
    });
    expect(result.receipt).toMatchObject({
      operation: "render.final",
      // Same reason as the H.264 case above: a static, sub-review-length fixture warns, so the
      // receipt reporting it warns too.
      status: "warning",
      packageId: "pkg_webm",
      output: {
        path: outputPath,
        width: 640,
        height: 360,
        durationMs: 1000,
        codec: "vp9",
        container: "webm",
        preset: "webm-vp9"
      }
    });
  });

  it("encodes transparent WebM outputs with VP9 alpha pixel format", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-webm-alpha-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render-alpha.webm");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake webm alpha bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_webm_alpha",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      preset: "webm-vp9-alpha",
      runner,
      now: () => "2026-07-02T07:10:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0].args).toEqual([
      "-y",
      "-framerate",
      "2",
      "-start_number",
      "1",
      "-protocol_whitelist",
      "file",
      "-i",
      join(outDir, "%06d.png"),
      "-frames:v",
      "2",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "32",
      "-pix_fmt",
      "yuva420p",
      "-auto-alt-ref",
      "0",
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
      outputPath
    ]);
    expect(result.receipt).toMatchObject({
      operation: "render.final",
      // Same reason as the other two encode cases: a static, sub-review-length fixture warns.
      status: "warning",
      packageId: "pkg_webm_alpha",
      output: {
        path: outputPath,
        width: 640,
        height: 360,
        durationMs: 1000,
        codec: "vp9",
        container: "webm",
        preset: "webm-vp9-alpha"
      }
    });
  });

  it("warns when an audio track is requested for a silent export preset", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-gif-audio-warning-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.gif");
    const audioPath = join(outDir, "voiceover.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake gif bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_gif_audio_warning",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      preset: "gif",
      audioPath,
      runner,
      now: () => "2026-06-30T06:05:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0].args).not.toContain(audioPath);
    expect(result.receipt.output).toMatchObject({
      path: outputPath,
      codec: "gif",
      container: "gif",
      preset: "gif"
    });
    expect(result.receipt.output).not.toHaveProperty("audio");
    expect(result.receipt.warnings).toContain("Export preset gif does not support audio; 1 requested audio track will be ignored.");
  });

  it("builds the GIF preset with a two-pass palettegen -> paletteuse filtergraph", () => {
    const command = buildEncodeImageSequenceCommand({
      framesDir: "/tmp/frames",
      fps: 12,
      durationMs: 1000,
      outputPath: "/tmp/frames/out.gif",
      preset: "gif"
    });
    const filterIndex = command.args.indexOf("-filter_complex");
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    const filterGraph = command.args[filterIndex + 1];
    // Per-file palette: split feeds palettegen (global palette) and paletteuse.
    expect(filterGraph).toBe(
      "[0:v]split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
    );
    // GIF still loops forever and never falls back to the default quantiser.
    expect(command.args).toEqual(expect.arrayContaining(["-loop", "0"]));
    expect(command.args).not.toContain("-pix_fmt");
  });

  it("muxes an external audio track into MP4 renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "voiceover.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audioPath,
      runner,
      now: () => "2026-06-30T06:30:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toEqual({
      executable: "ffmpeg",
      args: [
        "-y",
        "-framerate",
        "2",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "%06d.png"),
        "-protocol_whitelist",
        "file",
        "-i",
        audioPath,
        "-frames:v",
        "2",
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
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-t",
        "1",
        outputPath
      ],
      shell: false
    });
    expect(result.receipt.output).toMatchObject({
      path: outputPath,
      codec: "h264",
      container: "mp4",
      audio: {
        path: audioPath,
        codec: "aac"
      }
    });
  });

  it("hashes muxed audio inputs into the render receipt and detects a swapped audio file", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-hash-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "voiceover.wav");
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "original voiceover bytes", "utf8");
    const runner: FfmpegRunner = async () => {
      await writeFile(outputPath, "fake mp4 bytes with audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const encode = (): ReturnType<typeof encodeImageSequence> =>
      encodeImageSequence({
        packageId: "pkg_audio_hash",
        framesDir: outDir,
        fps: 2,
        width: 640,
        height: 360,
        durationMs: 1000,
        outputPath,
        audioPath,
        runner
      });

    const first = await encode();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The muxed audio bytes are now attested alongside the frame sequence.
    expect(first.receipt.inputHashes.frames).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receipt.inputHashes["audio:0"]).toMatch(/^[a-f0-9]{64}$/);

    // Change only the audio file; the rendered frames are untouched.
    await writeFile(audioPath, "different voiceover bytes entirely", "utf8");
    const second = await encode();
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // A swapped audio file changes the receipt's input side; the frame hash does not.
    expect(second.receipt.inputHashes["audio:0"]).not.toBe(first.receipt.inputHashes["audio:0"]);
    expect(second.receipt.inputHashes.frames).toBe(first.receipt.inputHashes.frames);
  });

  it("attests one hash per muxed track and never attests audio a preset ignores", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-multi-"));
    tempDirs.push(outDir);
    const mp4Path = join(outDir, "render.mp4");
    const gifPath = join(outDir, "render.gif");
    const musicPath = join(outDir, "music.wav");
    const voicePath = join(outDir, "voice.wav");
    await writeContrastFrames(outDir, 2);
    await writeFile(musicPath, "music bytes", "utf8");
    await writeFile(voicePath, "voice bytes", "utf8");
    const mp4Runner: FfmpegRunner = async () => {
      await writeFile(mp4Path, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const gifRunner: FfmpegRunner = async () => {
      await writeFile(gifPath, "fake gif bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const mp4 = await encodeImageSequence({
      packageId: "pkg_audio_multi",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath: mp4Path,
      audioTracks: [{ path: musicPath }, { path: voicePath }],
      runner: mp4Runner
    });
    expect(mp4.ok).toBe(true);
    if (!mp4.ok) return;
    // One hash per muxed track, keyed by ordinal role, deterministically ordered.
    expect(Object.keys(mp4.receipt.inputHashes)).toEqual(["audio:0", "audio:1", "frames"]);
    expect(mp4.receipt.inputHashes["audio:0"]).not.toBe(mp4.receipt.inputHashes["audio:1"]);

    const gif = await encodeImageSequence({
      packageId: "pkg_audio_multi",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath: gifPath,
      preset: "gif",
      audioTracks: [{ path: musicPath }, { path: voicePath }],
      runner: gifRunner
    });
    expect(gif.ok).toBe(true);
    if (!gif.ok) return;
    // GIF cannot mux audio; the receipt must not falsely attest the ignored tracks.
    expect(Object.keys(gif.receipt.inputHashes)).toEqual(["frames"]);
    expect(gif.receipt.output).not.toHaveProperty("audio");
  });

  it("bounds audio mux output to Motion duration instead of shortest stream", () => {
    const command = buildEncodeImageSequenceCommand({
      framesDir: "/tmp/shellx-motion-frames",
      fps: 30,
      durationMs: 2500,
      outputPath: "/tmp/shellx-motion-render.mp4",
      audioPath: "/tmp/shellx-motion-frames/audio.wav"
    });

    expect(command.args).not.toContain("-shortest");
    expect(command.args).toEqual(expect.arrayContaining(["-t", "2.5"]));
  });

  it("defaults FFmpeg audio inputs to the frame directory trust root", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-default-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-default-outside-"));
    tempDirs.push(outDir, outsideDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outsideDir, "voiceover.wav");
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    let invoked = false;
    const runner: FfmpegRunner = async () => {
      invoked = true;
      await writeFile(outputPath, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_default_root",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audioPath,
      runner
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_input_path",
        message: "Unsafe FFmpeg input path: path must be inside a trusted input root."
      }
    });
    expect(invoked).toBe(false);
    expect(() => buildEncodeImageSequenceCommand({
      framesDir: outDir,
      fps: 2,
      durationMs: 1000,
      outputPath,
      audioPath
    })).toThrow("Unsafe FFmpeg input path: path must be inside a trusted input root.");
  });

  it("rejects protocol-based audio inputs before invoking ffmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-protocol-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    await writeContrastFrames(outDir, 2);
    let invoked = false;
    const runner: FfmpegRunner = async () => {
      invoked = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_protocol",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audioPath: "http://169.254.169.254/latest/meta-data",
      runner
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_input_path",
        message: "Unsafe FFmpeg input path: protocol URLs are not allowed."
      }
    });
    expect(invoked).toBe(false);
  });

  it("rejects audio inputs outside trusted roots before invoking ffmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-outside-"));
    tempDirs.push(outDir, outsideDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outsideDir, "voiceover.wav");
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    let invoked = false;
    const runner: FfmpegRunner = async () => {
      invoked = true;
      await writeFile(outputPath, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_outside_root",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audioPath,
      inputRoots: [outDir],
      runner
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_input_path",
        message: "Unsafe FFmpeg input path: path must be inside a trusted input root."
      }
    });
    expect(invoked).toBe(false);
  });

  it("rejects dash-prefixed ffmpeg input and output paths", () => {
    expect(() => buildEncodeImageSequenceCommand({
      framesDir: "-frames",
      fps: 2,
      durationMs: 1000,
      outputPath: "/tmp/render.mp4"
    })).toThrow("Unsafe FFmpeg input path: path operands must not start with '-'.");

    expect(() => buildEncodeImageSequenceCommand({
      framesDir: "/tmp/frames",
      fps: 2,
      durationMs: 1000,
      outputPath: "-y"
    })).toThrow("Unsafe FFmpeg output path: path operands must not start with '-'.");
  });

  it("limits FFmpeg input protocols to local files for encode, probe, and audio checks", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-protocol-whitelist-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "voice.wav");
    const framePattern = join(outDir, "%06d.png");
    const encodeCommand = buildEncodeImageSequenceCommand({
      framesDir: outDir,
      fps: 2,
      durationMs: 1000,
      outputPath,
      audioPath
    });
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: command.executable === "ffprobe"
          ? JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" }], format: { duration: "1.000000", format_name: "mov,mp4" } })
          : "[Parsed_volumedetect_0 @ 0x1] n_samples: 48000\n[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.0 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -3.0 dB",
        stderr: ""
      };
    };

    expect(encodeCommand.args.slice(encodeCommand.args.indexOf(framePattern) - 3, encodeCommand.args.indexOf(framePattern) + 1)).toEqual([
      "-protocol_whitelist",
      "file",
      "-i",
      framePattern
    ]);
    expect(encodeCommand.args.slice(encodeCommand.args.indexOf(audioPath) - 3, encodeCommand.args.indexOf(audioPath) + 1)).toEqual([
      "-protocol_whitelist",
      "file",
      "-i",
      audioPath
    ]);

    await probeMedia(outputPath, { runner });
    await measureAudioLevels(audioPath, { runner });

    expect(commands[0].args).toContain("-protocol_whitelist");
    expect(commands[1].args.slice(commands[1].args.indexOf(audioPath) - 3, commands[1].args.indexOf(audioPath) + 1)).toEqual([
      "-protocol_whitelist",
      "file",
      "-i",
      audioPath
    ]);
  });

  it("applies audio trim loop and volume controls when encoding final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-controls-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 3);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with controlled audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_controls",
      framesDir: outDir,
      fps: 3,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        trimStartMs: 250,
        trimDurationMs: 500,
        loop: true,
        volume: 0.35
      },
      runner,
      now: () => "2026-06-30T08:20:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toEqual({
      executable: "ffmpeg",
      args: [
        "-y",
        "-framerate",
        "3",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "%06d.png"),
        "-protocol_whitelist",
        "file",
        "-i",
        audioPath,
        "-frames:v",
        "3",
        ...H264_SDR_OUTPUT_ARGS,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-filter:a",
        "atrim=start=0.25:duration=0.5,asetpts=PTS-STARTPTS,aresample=48000,aloop=loop=-1:size=24000,volume=0.35",
        "-t",
        "1",
        outputPath
      ],
      shell: false
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        trimStartMs: 250,
        trimDurationMs: 500,
        loop: true,
        volume: 0.35
      }
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("ignores invalid audio playback rates without hanging command planning: %s", (playbackRate) => {
    const command = buildEncodeImageSequenceCommand({
      framesDir: "/tmp/shellx-motion-frames",
      fps: 2,
      durationMs: 1000,
      outputPath: "/tmp/shellx-motion-render.mp4",
      audio: {
        path: "/tmp/shellx-motion-frames/audio.wav",
        playbackRate
      }
    });

    expect(command.args.join(" ")).not.toContain("atempo=");
  });

  it("applies audio pan balance when encoding final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-pan-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with panned audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_pan",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        pan: 0.5
      },
      runner,
      now: () => "2026-07-01T12:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toMatchObject({
      args: expect.arrayContaining([
        "-filter:a",
        "pan=stereo|c0=0.5*c0|c1=1*c1"
      ])
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        pan: 0.5
      }
    });
  });

  it("delays a single audio track to its timeline start offset", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-offset-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with delayed audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_offset",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        startMs: 750,
        volume: 0.5
      },
      runner,
      now: () => "2026-06-30T12:25:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toMatchObject({
      args: expect.arrayContaining([
        "-filter:a",
        "volume=0.5,adelay=750:all=1"
      ])
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        startMs: 750,
        volume: 0.5
      }
    });
  });

  it("applies audio mute and fade controls when encoding final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-fades-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with faded muted audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_fades",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        durationMs: 1000,
        muted: true,
        fadeInMs: 200,
        fadeOutMs: 300
      },
      runner,
      now: () => "2026-06-30T11:20:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toEqual({
      executable: "ffmpeg",
      args: [
        "-y",
        "-framerate",
        "2",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "%06d.png"),
        "-protocol_whitelist",
        "file",
        "-i",
        audioPath,
        "-frames:v",
        "2",
        ...H264_SDR_OUTPUT_ARGS,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-filter:a",
        "afade=t=in:st=0:d=0.2,afade=t=out:st=0.7:d=0.3,volume=0",
        "-t",
        "1",
        outputPath
      ],
      shell: false
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        durationMs: 1000,
        muted: true,
        fadeInMs: 200,
        fadeOutMs: 300
      }
    });
  });

  it("falls back to single-pass loudnorm when the measurement pass yields no values", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-loudnorm-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    // Runner returns no loudnorm JSON, so the first-pass measurement is empty
    // and the encode must fall back to single-pass loudnorm.
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with normalized audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_loudnorm",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        normalizeLoudness: true
      },
      runner,
      now: () => "2026-06-30T11:45:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The encode command (the one that writes frames) still applies single-pass
    // loudnorm; a separate measurement command now precedes it.
    const encodeCommand = commands.find((command) => command.args.includes("-frames:v"));
    expect(encodeCommand?.args).toEqual(expect.arrayContaining([
      "-filter:a",
      "loudnorm=I=-16:TP=-1.5:LRA=11"
    ]));
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        normalizeLoudness: true,
        loudness: {
          measurement: "ebu-r128",
          mode: "single-pass-fallback",
          target: { integratedLufs: -16, truePeakDbtp: -1.5, lra: 11 },
          tracks: [
            { path: audioPath, integratedLufs: null, mode: "single-pass-fallback" }
          ]
        }
      }
    });
  });

  it("applies two-pass loudnorm with measured values when the measurement pass succeeds", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-loudnorm-2pass-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    // The measurement command (-f null) returns a loudnorm JSON summary; the
    // input-measure and output-measure passes are told apart by their path.
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("-f") && command.args.includes("null")) {
        const measuringOutput = command.args.includes(outputPath);
        const summary = measuringOutput
          ? { input_i: "-16.1", input_tp: "-1.7", input_lra: "9.4", input_thresh: "-26.2", target_offset: "0.1" }
          : { input_i: "-23.5", input_tp: "-5.2", input_lra: "7.3", input_thresh: "-33.9", target_offset: "0.4" };
        return { exitCode: 0, stdout: "", stderr: JSON.stringify(summary) };
      }
      await writeFile(outputPath, "fake mp4 bytes with normalized audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_loudnorm_2pass",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        normalizeLoudness: true
      },
      runner,
      now: () => "2026-06-30T11:50:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const encodeCommand = commands.find((command) => command.args.includes("-frames:v"));
    const filterIndex = encodeCommand?.args.indexOf("-filter:a") ?? -1;
    const audioFilter = filterIndex >= 0 ? encodeCommand?.args[filterIndex + 1] ?? "" : "";
    // The apply pass carries the measured source values + linear normalization.
    expect(audioFilter).toContain("loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-23.5:measured_TP=-5.2:measured_LRA=7.3:measured_thresh=-33.9:offset=0.4:linear=true");
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        loudness: {
          measurement: "ebu-r128",
          mode: "two-pass",
          target: { integratedLufs: -16, truePeakDbtp: -1.5, lra: 11 },
          tracks: [
            { path: audioPath, integratedLufs: -23.5, truePeakDbtp: -5.2, lra: 7.3, thresholdLufs: -33.9, offsetLu: 0.4, mode: "two-pass" }
          ],
          // Program output measured from the final mixed file.
          output: { integratedLufs: -16.1, truePeakDbtp: -1.7, lra: 9.4 }
        }
      }
    });
  });

  it("applies keyframed audio volume automation when encoding final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-volume-keyframes-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with automated audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const volumeKeyframes = [
      { atMs: 0, value: 0, easing: "linear" as const },
      { atMs: 500, value: 0.8 },
      { atMs: 1000, value: 0.2 }
    ];
    const result = await encodeImageSequence({
      packageId: "pkg_audio_volume_keyframes",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        volumeKeyframes
      },
      runner,
      now: () => "2026-06-30T10:15:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toEqual({
      executable: "ffmpeg",
      args: [
        "-y",
        "-framerate",
        "2",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "%06d.png"),
        "-protocol_whitelist",
        "file",
        "-i",
        audioPath,
        "-frames:v",
        "2",
        ...H264_SDR_OUTPUT_ARGS,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-filter:a",
        "volume='if(lt(t,0),0,if(lt(t,0.5),0+(0.8-0)*((t-0)/(0.5-0)),if(lt(t,1),0.8+(0.2-0.8)*((t-0.5)/(1-0.5)),0.2)))':eval=frame",
        "-t",
        "1",
        outputPath
      ],
      shell: false
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        volumeKeyframes
      }
    });
  });

  it("applies keyframed audio pan automation when encoding final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-pan-keyframes-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with automated pan", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const panKeyframes = [
      { atMs: 0, value: -1, easing: "linear" as const },
      { atMs: 500, value: 0.5 }
    ];
    const result = await encodeImageSequence({
      packageId: "pkg_audio_pan_keyframes",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        panKeyframes
      },
      runner,
      now: () => "2026-06-30T10:20:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toMatchObject({
      args: expect.arrayContaining([
        "-filter:a",
        "aformat=channel_layouts=stereo,channelsplit=channel_layout=stereo[pan_l][pan_r];[pan_l]volume='if(lt(t,0),1,if(lt(t,0.5),1+(0.5-1)*((t-0)/(0.5-0)),0.5))':eval=frame[pan_lv];[pan_r]volume='if(lt(t,0),0,if(lt(t,0.5),0+(1-0)*((t-0)/(0.5-0)),1))':eval=frame[pan_rv];[pan_lv][pan_rv]join=inputs=2:channel_layout=stereo"
      ])
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        panKeyframes
      }
    });
  });

  it("records audio ducking metadata with generated volume automation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-ducking-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with ducked audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const volumeKeyframes = [
      { atMs: 0, value: 1, easing: "ease-out" as const },
      { atMs: 120, value: 0.3 },
      { atMs: 600, value: 0.3, easing: "ease-in" as const },
      { atMs: 840, value: 1 }
    ];

    const result = await encodeImageSequence({
      packageId: "pkg_audio_ducking_receipt",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        ducking: {
          triggerLayerIds: ["voice"],
          duckToVolume: 0.3,
          attackMs: 120,
          releaseMs: 240
        },
        volumeKeyframes
      } as any,
      runner,
      now: () => "2026-07-02T07:25:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0].args).toEqual(expect.arrayContaining([
      "-filter:a",
      expect.stringContaining("volume='")
    ]));
    expect(result.receipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        ducking: {
          triggerLayerIds: ["voice"],
          duckToVolume: 0.3,
          attackMs: 120,
          releaseMs: 240
        },
        volumeKeyframes
      }
    });
  });

  it("preserves cubic-bezier easing in keyframed audio volume automation", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-volume-bezier-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const audioPath = join(outDir, "music.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(audioPath, "fake wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with eased audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_volume_bezier",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audio: {
        path: audioPath,
        volumeKeyframes: [
          { atMs: 0, value: 0, easing: "cubic-bezier(0.42, 0, 1, 1)" },
          { atMs: 1000, value: 1 }
        ]
      },
      runner,
      now: () => "2026-07-01T13:20:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const filterIndex = commands[0].args.indexOf("-filter:a");
    expect(commands[0].args[filterIndex + 1]).toContain("if(lt(((t-0)/(1-0)),0.125)");
    expect(commands[0].args[filterIndex + 1]).toContain("0.026");
    expect(commands[0].args[filterIndex + 1]).not.toContain("0+(1-0)*((t-0)/(1-0))");
  });

  it("mixes multiple audio tracks with per-track trim loop and volume controls", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-mix-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const musicPath = join(outDir, "music.wav");
    const voicePath = join(outDir, "voice.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(musicPath, "fake music wav bytes", "utf8");
    await writeFile(voicePath, "fake voice wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with mixed audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_audio_mix",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audioTracks: [
        { path: musicPath, startMs: 250, trimStartMs: 100, trimDurationMs: 250, loop: true, volume: 0.4, pan: -0.25 },
        { path: voicePath, startMs: 500, volume: 0.8 }
      ],
      runner,
      now: () => "2026-06-30T09:05:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commands[0]).toEqual({
      executable: "ffmpeg",
      args: [
        "-y",
        "-framerate",
        "2",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "%06d.png"),
        "-protocol_whitelist",
        "file",
        "-i",
        musicPath,
        "-protocol_whitelist",
        "file",
        "-i",
        voicePath,
        "-frames:v",
        "2",
        ...H264_SDR_OUTPUT_ARGS,
        "-filter_complex",
        "[1:a]atrim=start=0.1:duration=0.25,asetpts=PTS-STARTPTS,aresample=48000,aloop=loop=-1:size=12000,volume=0.4,pan=stereo|c0=1*c0|c1=0.75*c1,adelay=250:all=1[a1];[2:a]volume=0.8,adelay=500:all=1[a2];[a1][a2]amix=inputs=2:duration=longest:dropout_transition=0[mixeda]",
        "-map",
        "0:v:0",
        "-map",
        "[mixeda]",
        "-c:a",
        "aac",
        "-t",
        "1",
        outputPath
      ],
      shell: false
    });
    expect(result.receipt.output).toMatchObject({
      audio: {
        codec: "aac",
        mix: "amix",
        tracks: [
          { path: musicPath, startMs: 250, trimStartMs: 100, trimDurationMs: 250, loop: true, volume: 0.4, pan: -0.25 },
          { path: voicePath, startMs: 500, volume: 0.8 }
        ]
      }
    });
  });

  it("wires true sidechaincompress ducking and records the mode + params in the receipt", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-audio-sidechain-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    const musicPath = join(outDir, "music.wav");
    const voicePath = join(outDir, "voice.wav");
    const commands: FfmpegCommand[] = [];
    await writeContrastFrames(outDir, 2);
    await writeFile(musicPath, "fake music wav bytes", "utf8");
    await writeFile(voicePath, "fake voice wav bytes", "utf8");
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(outputPath, "fake mp4 bytes with sidechain audio", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const ducking = {
      mode: "sidechain" as const,
      triggerLayerIds: ["voice"],
      threshold: 0.04,
      ratio: 10,
      attackMs: 15,
      releaseMs: 220
    };
    const result = await encodeImageSequence({
      packageId: "pkg_audio_sidechain",
      framesDir: outDir,
      fps: 2,
      width: 640,
      height: 360,
      durationMs: 1000,
      outputPath,
      audioTracks: [
        { path: musicPath, layerId: "music", volume: 0.5, ducking },
        { path: voicePath, layerId: "voice", volume: 0.9 }
      ],
      runner,
      now: () => "2026-06-30T12:30:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const filterIndex = commands[0].args.indexOf("-filter_complex");
    const filterGraph = commands[0].args[filterIndex + 1];
    // The voice trigger is split so it still reaches the mix while a copy keys
    // the compressor on the music, which is then heard as [a1_ducked].
    expect(filterGraph).toContain("[a2]asplit=2[a2_main][a2_key_1]");
    expect(filterGraph).toContain("[a1][a2_key_1]sidechaincompress=threshold=0.04:ratio=10:attack=15:release=220[a1_ducked]");
    expect(filterGraph).toContain("[a1_ducked][a2_main]amix=inputs=2:duration=longest:dropout_transition=0[mixeda]");
    // Receipt evidence: the ducking mode + compressor params are preserved.
    expect(result.receipt.output).toMatchObject({
      audio: {
        codec: "aac",
        mix: "amix",
        tracks: [
          { path: musicPath, ducking },
          { path: voicePath }
        ]
      }
    });
  });

  it("parses ffprobe json into media facts", async () => {
    const runner: FfmpegRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            pix_fmt: "yuv420p",
            color_space: "bt709",
            color_transfer: "bt709",
            color_primaries: "bt709",
            color_range: "tv",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30/1"
          },
          { codec_type: "audio", codec_name: "aac", channels: 2, channel_layout: "stereo", sample_rate: "48000", sample_fmt: "fltp", bit_rate: "192000", duration: "4.000000" }
        ],
        format: { duration: "4.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
      }),
      stderr: ""
    });

    await expect(probeMedia("/tmp/render.mp4", { runner })).resolves.toEqual({
      ok: true,
      path: "/tmp/render.mp4",
      codec: "h264",
      width: 1920,
      height: 1080,
      durationMs: 4000,
      fps: 30,
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      color: {
        pixelFormat: "yuv420p",
        space: "bt709",
        transfer: "bt709",
        primaries: "bt709",
        range: "tv"
      },
      alpha: {
        present: false,
        mode: null,
        pixelFormat: "yuv420p",
        decoder: null
      },
      audio: {
        present: true,
        streamCount: 1,
        streams: [
          { codec: "aac", channels: 2, channelLayout: "stereo", sampleRate: 48000, sampleFormat: "fltp", bitRate: 192000, durationMs: 4000 }
        ]
      }
    });
  });

  it("reports VP9 alpha metadata and decoder requirements from ffprobe", async () => {
    const runner: FfmpegRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "vp9",
            pix_fmt: "yuv420p",
            tags: { alpha_mode: "1" },
            width: 320,
            height: 180,
            avg_frame_rate: "12/1"
          }
        ],
        format: { duration: "1.000000", format_name: "matroska,webm" }
      }),
      stderr: ""
    });

    const media = await probeMedia("/tmp/overlay.webm", { runner });

    expect(media.alpha).toEqual({
      present: true,
      mode: "1",
      pixelFormat: "yuv420p",
      decoder: "libvpx-vp9"
    });
    expect(frameExtractionInputArgs(media, "/tmp/overlay.webm")).toEqual(["-c:v", "libvpx-vp9", "-i", "/tmp/overlay.webm"]);
    expect(frameExtractionPngOutputArgs(media, "/tmp/overlay.png")).toEqual(["-frames:v", "1", "-pix_fmt", "rgba", "/tmp/overlay.png"]);
  });

  it("builds frame-accurate, colour-normalized extraction args for a delivered frame index", () => {
    const media = { codec: "h264" as const, alpha: { present: false, mode: null, pixelFormat: null, decoder: null } };
    // With a frame index: select the exact delivered frame, then expand tv-range YUV to full-range RGB.
    expect(frameExtractionArgs(media, "/tmp/clip.mp4", "/tmp/frame.png", { frameIndex: 42 })).toEqual([
      "-i",
      "/tmp/clip.mp4",
      "-vf",
      "select=eq(n\\,42),scale=in_range=tv:out_range=full",
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "/tmp/frame.png"
    ]);
    // Without an index: colour-normalize only, no select filter (and no frame-rate gate needed).
    expect(frameExtractionArgs(media, "/tmp/clip.mp4", "/tmp/frame.png")).toEqual([
      "-i",
      "/tmp/clip.mp4",
      "-vf",
      "scale=in_range=tv:out_range=full",
      "-frames:v",
      "1",
      "/tmp/frame.png"
    ]);
  });

  it("carries alpha decoder + pixel-format facts through frame-accurate extraction", () => {
    const media = {
      codec: "vp9" as const,
      alpha: { present: true, mode: "1", pixelFormat: "yuv420p", decoder: "libvpx-vp9" as const }
    };
    expect(frameExtractionArgs(media, "/tmp/overlay.webm", "/tmp/overlay.png", { frameIndex: 3 })).toEqual([
      "-c:v",
      "libvpx-vp9",
      "-i",
      "/tmp/overlay.webm",
      "-vf",
      "select=eq(n\\,3),scale=in_range=tv:out_range=full",
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "/tmp/overlay.png"
    ]);
  });

  it("normalizes invalid probe timing and audio scalar facts instead of returning NaN", async () => {
    const runner: FfmpegRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "h264", width: 10, height: 10, avg_frame_rate: "1/0", duration: "-1" },
          { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "NaN", bit_rate: "Infinity" }
        ],
        format: { duration: "NaN", format_name: "mov,mp4" }
      }),
      stderr: ""
    });

    const media = await probeMedia("/tmp/invalid-facts.mp4", { runner });
    expect(media.durationMs).toBe(0);
    expect(media.fps).toBe(0);
    expect(media.audio.streams[0]).toMatchObject({ sampleRate: null, bitRate: null, channelLayout: null, sampleFormat: null });
  });

  it("measures sample levels, integrated loudness, range, and true peak in one pass", async () => {
    const inputPath = "/tmp/final-muted.mp4";
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: "",
        stderr: [
          "[Parsed_volumedetect_0 @ 0x123] n_samples: 48128",
          "[Parsed_volumedetect_0 @ 0x123] mean_volume: -91.0 dB",
          "[Parsed_volumedetect_0 @ 0x123] max_volume: -64.2 dB",
          "{",
          "  \"input_i\" : \"-23.4\",",
          "  \"input_tp\" : \"-1.2\",",
          "  \"input_lra\" : \"5.6\",",
          "  \"input_thresh\" : \"-34.1\",",
          "  \"target_offset\" : \"0.3\"",
          "}"
        ].join("\n")
      };
    };

    await expect(measureAudioLevels(inputPath, { runner })).resolves.toEqual({
      ok: true,
      path: inputPath,
      sampleCount: 48128,
      meanVolumeDb: -91,
      maxVolumeDb: -64.2,
      meanVolumeDbfs: -91,
      samplePeakDbfs: -64.2,
      integratedLoudnessLufs: -23.4,
      loudnessRangeLu: 5.6,
      truePeakDbtp: -1.2,
      loudnessThresholdLufs: -34.1,
      targetOffsetLu: 0.3,
      loudnessMeasurement: "ebu-r128-loudnorm",
      loudnessComplete: true
    });
    expect(commands).toEqual([
      {
        executable: "ffmpeg",
        args: [
          "-hide_banner",
          "-nostats",
          "-protocol_whitelist",
          "file",
          "-i",
          inputPath,
          "-vn",
          "-sn",
          "-dn",
          "-af",
          "volumedetect,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
          "-f",
          "null",
          "-"
        ],
        shell: false
      }
    ]);
  });

  it("preserves negative infinity for silent EBU R128 measurements", async () => {
    const runner: FfmpegRunner = async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "{\n\"input_i\":\"-inf\",\"input_tp\":\"-inf\",\"input_lra\":\"0.0\",\"input_thresh\":\"-70.0\",\"target_offset\":\"inf\"\n}"
    });

    const levels = await measureAudioLevels("/tmp/silence.wav", { runner });
    expect(levels).toMatchObject({
      integratedLoudnessLufs: Number.NEGATIVE_INFINITY,
      truePeakDbtp: Number.NEGATIVE_INFINITY,
      loudnessRangeLu: 0,
      loudnessThresholdLufs: -70,
      targetOffsetLu: Number.POSITIVE_INFINITY,
      loudnessComplete: true
    });
  });

  it("confines media probing and audio level checks to trusted input roots when provided", async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-trusted-input-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-untrusted-input-"));
    tempDirs.push(trustedRoot, outsideRoot);
    const outsidePath = join(outsideRoot, "final.mp4");
    await writeFile(outsidePath, "fake mp4 bytes", "utf8");
    const runner: FfmpegRunner = async () => {
      throw new Error("ffmpeg must not run for untrusted input paths");
    };

    await expect(probeMedia(outsidePath, { runner, inputRoots: [trustedRoot] })).rejects.toThrow(
      "Unsafe FFmpeg input path: path must be inside a trusted input root."
    );
    await expect(measureAudioLevels(outsidePath, { runner, inputRoots: [trustedRoot] })).rejects.toThrow(
      "Unsafe FFmpeg input path: path must be inside a trusted input root."
    );
  });

  it("captures stderr summaries without leaking environment-looking values", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-fail-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    await writeContrastFrames(outDir, 30);
    const runner: FfmpegRunner = async () => ({ exitCode: 1, stdout: "", stderr: "AWS_SECRET_ACCESS_KEY=abc123 failed" });

    const result = await encodeImageSequence({
      packageId: "pkg_lower_third",
      framesDir: outDir,
      fps: 30,
      width: 1920,
      height: 1080,
      durationMs: 1000,
      outputPath,
      runner
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ffmpeg_failed",
        message: "AWS_SECRET_ACCESS_KEY=[redacted] failed"
      }
    });
  });

  it("hashes final-render frame receipt inputs from frame bytes", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-frame-hash-"));
    tempDirs.push(outDir);
    const outputPath = join(outDir, "render.mp4");
    await writeMixedFrames(outDir);
    const runner: FfmpegRunner = async () => {
      await writeFile(outputPath, "fake mp4 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const first = await encodeImageSequence({
      packageId: "pkg_frame_hash",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1000,
      outputPath,
      runner
    });
    await writeFile(join(outDir, "000002.png"), CONTRAST_PNG);
    const second = await encodeImageSequence({
      packageId: "pkg_frame_hash",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1000,
      outputPath,
      runner
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.receipt.inputHashes.frames).toMatch(/^[a-f0-9]{64}$/);
    expect(second.receipt.inputHashes.frames).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receipt.inputHashes.frames).not.toBe(second.receipt.inputHashes.frames);
  });

  it("rejects blank frame sequences before invoking ffmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-blank-"));
    tempDirs.push(outDir);
    await writeBlankFrames(outDir, 2);
    const calls: FfmpegCommand[] = [];

    const result = await encodeImageSequence({
      packageId: "pkg_blank",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1000,
      outputPath: join(outDir, "blank.mp4"),
      runner: async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "frame_quality_failed",
        message: "Rendered frame sequence is blank or visually empty."
      }
    });
    expect(calls).toEqual([]);
  });

  it("returns a structured frame quality failure when expected frames are missing", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-missing-frame-"));
    tempDirs.push(outDir);
    await writeContrastFrames(outDir, 1);
    const calls: FfmpegCommand[] = [];

    const result = await encodeImageSequence({
      packageId: "pkg_missing_frame",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath: join(outDir, "missing.mp4"),
      runner: async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "frame_quality_failed",
        message: expect.stringContaining("Unable to read frame")
      }
    });
    expect(calls).toEqual([]);
  });

  it("rejects static frame sequences when product motion is required", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-static-"));
    tempDirs.push(outDir);
    await writeContrastFrames(outDir, 2);
    const calls: FfmpegCommand[] = [];

    const result = await encodeImageSequence({
      packageId: "pkg_static",
      framesDir: outDir,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1000,
      outputPath: join(outDir, "static.mp4"),
      quality: { minUniqueFrameHashes: 2 },
      runner: async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "frame_quality_failed",
        message: "Rendered frame sequence has 1 unique frame; expected at least 2."
      }
    });
    expect(calls).toEqual([]);
  });
});

/**
 * A read-only pre-flight must not inherit the encode's budget or compete for its capacity.
 *
 * `probeMotionTool` ran through the governed encode runner, which meant two things a
 * `read_motion`, `mutates:false` command has no business doing.
 *
 *   - It applied `DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS` — ten minutes. A browser that blocks instead
 *     of printing a version (a GUI shim, an EDR prompt, a snap wrapper) made `shellx-motion doctor`
 *     look frozen for the full ten.
 *   - It took one of the machine's two job slots. `acquireSlot` is global and operation-blind, so
 *     the comment claiming a doctor run is never queued behind renders was simply false; two
 *     concurrent pre-flights held both slots and queued renders died on `job_queue_timeout`.
 */
describe("tool identity probe", () => {
  /** A program that never answers, which is the shape both defects were measured with. */
  async function writeHangingTool(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-probe-"));
    tempDirs.push(dir);
    const script = join(dir, "hangs.js");
    await writeFile(script, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 60_000);\n", "utf8");
    await chmod(script, 0o755);
    return script;
  }

  it.skipIf(process.platform === "win32")("bounds itself in seconds even when the ENCODE timeout is ten minutes", async () => {
    const hanging = await writeHangingTool();

    await withExecutableEnv(
      {
        SHELLX_MOTION_FFMPEG: hanging,
        // Explicitly the encode budget. Before the fix the probe used exactly this value, so this
        // test hung until vitest gave up rather than failing an assertion.
        SHELLX_MOTION_FFMPEG_TIMEOUT_MS: "600000",
        SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS: "300"
      },
      async () => {
        const startedAt = Date.now();
        const probe = await probeMotionTool("ffmpeg");

        expect(Date.now() - startedAt).toBeLessThan(20_000);
        // Not `missing`: the binary is right there, it just did not answer. Opposite advice.
        expect(probe.status).toBe("broken");
        expect(probe.detail).toContain("ffmpeg identity probe timed out after 300ms");
      }
    );
  });

  it.skipIf(process.platform === "win32")("kills the tool it gave up on rather than leaking it", async () => {
    const hanging = await writeHangingTool();

    await withExecutableEnv(
      { SHELLX_MOTION_FFMPEG: hanging, SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS: "300" },
      async () => {
        // Leaving the governor does not mean leaving containment: the probe still spawns into its
        // own process group and terminates the tree on timeout.
        const before = new Set(await listNodeProcessArgs(hanging));
        await probeMotionTool("ffmpeg");
        await new Promise((settle) => setTimeout(settle, 500));

        expect(before.size).toBeLessThanOrEqual(1);
        expect(await listNodeProcessArgs(hanging)).toEqual([]);
      }
    );
  });

  it.skipIf(process.platform === "win32")("holds no slot in the render governor while it runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-probe-slot-"));
    tempDirs.push(dir);
    const slow = join(dir, "slow.js");
    await writeFile(slow, "#!/usr/bin/env node\nsetTimeout(() => { console.log('ffmpeg version 9.9-fixture'); }, 1_500);\n", "utf8");
    await chmod(slow, 0o755);

    await withExecutableEnv({ SHELLX_MOTION_FFMPEG: slow }, async () => {
      const idle = defaultLocalMotionJobGovernor.snapshot();
      const inFlight = probeMotionTool("ffmpeg");
      await new Promise((settle) => setTimeout(settle, 600));
      // Sampled while the probe is definitely still running.
      const during = defaultLocalMotionJobGovernor.snapshot();
      const probe = await inFlight;

      expect(probe.status).toBe("ready");
      expect(probe.version).toBe("ffmpeg version 9.9-fixture");
      // Before the fix this was `idle.activeJobs + 1`: one of the machine's two render slots, held
      // by a command documented as a safe read-only pre-flight.
      expect(during.activeJobs).toBe(idle.activeJobs);
      expect(during.queuedJobs).toBe(idle.queuedJobs);
    });
  });

  it("still lets a host inject its own runner, which is the readiness-parity seam", async () => {
    const commands: FfmpegCommand[] = [];
    const probe = await probeMotionTool("ffmpeg", async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "ffmpeg version 7.1-host\n", stderr: "" };
    });

    expect(probe).toMatchObject({ status: "ready", version: "ffmpeg version 7.1-host" });
    expect(commands).toEqual([{ executable: expect.any(String), args: ["-version"], shell: false }]);
  });
});

/** Command lines of live `node` processes running `script`, for a leak assertion. */
async function listNodeProcessArgs(script: string): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("ps", ["-eo", "args"]);
    return stdout.split("\n").filter((line) => line.includes(script));
  } catch {
    return [];
  }
}

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive after governed cancellation.`);
}

async function withExecutableEnv(
  env: Partial<Record<ExecutableEnvName, string | undefined>>,
  run: () => Promise<void>
): Promise<void> {
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    SHELLX_MOTION_FFMPEG: process.env.SHELLX_MOTION_FFMPEG,
    SHELLX_MOTION_FFPROBE: process.env.SHELLX_MOTION_FFPROBE,
    SHELLX_MOTION_FFMPEG_TIMEOUT_MS: process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS,
    SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS: process.env.SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS,
    SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT: process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT,
    SHELLX_MOTION_WINDOWS_JOB_HELPER: process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER,
  };
  applyEnv("LOCALAPPDATA", env.LOCALAPPDATA);
  applyEnv("SHELLX_MOTION_FFMPEG", env.SHELLX_MOTION_FFMPEG);
  applyEnv("SHELLX_MOTION_FFPROBE", env.SHELLX_MOTION_FFPROBE);
  applyEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS);
  applyEnv("SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS", env.SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS);
  applyEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT);
  applyEnv("SHELLX_MOTION_WINDOWS_JOB_HELPER", env.SHELLX_MOTION_WINDOWS_JOB_HELPER);
  try {
    await run();
  } finally {
    restoreEnv("LOCALAPPDATA", previous.LOCALAPPDATA);
    restoreEnv("SHELLX_MOTION_FFMPEG", previous.SHELLX_MOTION_FFMPEG);
    restoreEnv("SHELLX_MOTION_FFPROBE", previous.SHELLX_MOTION_FFPROBE);
    restoreEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", previous.SHELLX_MOTION_FFMPEG_TIMEOUT_MS);
    restoreEnv("SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS", previous.SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS);
    restoreEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", previous.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT);
    restoreEnv("SHELLX_MOTION_WINDOWS_JOB_HELPER", previous.SHELLX_MOTION_WINDOWS_JOB_HELPER);
  }
}

type ExecutableEnvName = "LOCALAPPDATA" | "SHELLX_MOTION_FFMPEG" | "SHELLX_MOTION_FFPROBE" | "SHELLX_MOTION_FFMPEG_TIMEOUT_MS"
  | "SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS"
  | "SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT" | "SHELLX_MOTION_WINDOWS_JOB_HELPER" | "SHELLX_MOTION_FORCE_SOFTWARE_ENCODE";

function applyEnv(name: ExecutableEnvName, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function restoreEnv(name: ExecutableEnvName, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeContrastFrames(dir: string, count: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(dir, `${String(index + 1).padStart(6, "0")}.png`), CONTRAST_PNG);
  }
}

async function writeBlankFrames(dir: string, count: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(dir, `${String(index + 1).padStart(6, "0")}.png`), BLACK_PNG);
  }
}

async function writeMixedFrames(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "000001.png"), CONTRAST_PNG);
  await writeFile(join(dir, "000002.png"), BLACK_PNG);
}

const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const BLACK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAFElEQVQI12NkYGD4z8DAwMDEAAUADigBA29NMG0AAAAASUVORK5CYII=",
  "base64"
);

describe("export preset single-source consistency", () => {
  it("advertises exactly the renderer's real preset table (connector-review D6)", () => {
    // The renderer's spec tables (EXPORT_PRESETS / IMAGE_SEQUENCE_EXPORT_PRESETS /
    // STILL_FRAME_EXPORT_PRESETS) are the authority for which presets can actually be encoded.
    // listMotionExportPresets walks them; its preset ids must equal the single-source list that
    // integration-protocol advertises, so the connector manifest cannot omit a supported preset.
    const rendererPresetIds = listMotionExportPresets().map((spec) => spec.preset);
    expect(rendererPresetIds).toEqual([...MOTION_EXPORT_PRESETS]);
  });

  it("resolves a real encoder spec for every advertised preset (no fallback)", () => {
    // Guards that every id in the shared list is backed by a genuine spec entry rather than the
    // resolveMotionExportPreset fallback, i.e. the list never advertises a preset the renderer lacks.
    for (const preset of MOTION_EXPORT_PRESETS) {
      expect(resolveMotionExportPreset(preset).preset).toBe(preset);
    }
  });

  it("keeps the shellx-motion integration preset advertisement in sync (includes mov-prores)", () => {
    const advertised = integrationCapabilitiesForHost("shellx-motion").presets;
    expect(advertised).toEqual([...MOTION_EXPORT_PRESETS]);
    // Explicit D6 regression guard: mov-prores is renderer-supported and must be advertised.
    expect(advertised).toContain("mov-prores");
  });
});

// Probed hardware encoders become real, probe-gated
// candidates with a deliberate rate-control mapping, a software override, and automatic
// software fallback. These tests mock the probe / runner so no GPU is required (WSL has none).
describe("hardware encode selection, override and fallback", () => {
  const hwTempDirs: string[] = [];
  afterEach(async () => {
    delete process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE;
    await Promise.all(hwTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // The shared SDR-BT.709 colour tail every candidate keeps (parity with the software presets).
  const SDR_TAIL = [
    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"
  ];
  // The exact, deliberate hardware output args asserted per encoder path.
  const H264_NVENC_ARGS = ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-multipass", "fullres", "-pix_fmt", "yuv420p", ...SDR_TAIL, "-movflags", "+faststart"];
  const HEVC_NVENC_ARGS = ["-c:v", "hevc_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-multipass", "fullres", "-profile:v", "main10", "-pix_fmt", "p010le", "-tag:v", "hvc1", ...SDR_TAIL, "-movflags", "+faststart"];
  const AV1_NVENC_ARGS = ["-c:v", "av1_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "32", "-b:v", "0", "-multipass", "fullres", "-pix_fmt", "yuv420p", ...SDR_TAIL];
  const H264_QSV_ARGS = ["-c:v", "h264_qsv", "-global_quality", "23", "-preset", "veryslow", "-pix_fmt", "nv12", ...SDR_TAIL, "-movflags", "+faststart"];

  // Build an injectable "usable" probe result (bypasses the real per-machine probe subprocess).
  function usabilityProbe(usableEncoders: FfmpegHardwareEncoder[]): FfmpegHardwareEncoderUsability {
    return {
      ok: true,
      command: "ffmpeg",
      selection: "first-usable",
      usableEncoders,
      probes: usableEncoders.map((encoder) => ({ encoder, compiled: true, usable: true, status: "usable" as const, exitCode: 0 }))
    };
  }

  // The encode's video output args (from "-frames:v" through the output path) for exact assertions.
  function encodeTail(command: FfmpegCommand): string[] {
    return command.args.slice(command.args.indexOf("-frames:v"));
  }

  async function scratch(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `shellx-motion-hwenc-${prefix}-`));
    hwTempDirs.push(dir);
    return dir;
  }

  it("selects h264_nvenc by default when the probe verifies it and records hardware evidence", async () => {
    const outDir = await scratch("h264");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "hw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(command.args.at(-1) as string, "nvenc bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      packageId: "pkg_h264_hw", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, hardwareProbe: usabilityProbe(["h264_nvenc"])
    });
    expect(result.ok).toBe(true);
    // With an injected probe there is exactly one ENCODE: no probe subprocess, just the encode.
    // The second runner call is the encode's delivered-colour readback (`verifyDeliveredColor`,
    // default-on under the current contract), asserted here once so this file records that the pair is the
    // expected shape; the remaining hardware cases count encodes only.
    expect(commands).toHaveLength(2);
    expect(commands[1].args).toEqual(expect.arrayContaining(["-show_streams", outputPath]));
    const encodes = commandsWithoutColorReadback(commands);
    expect(encodes).toHaveLength(1);
    expect(encodeTail(encodes[0])).toEqual(["-frames:v", "2", ...H264_NVENC_ARGS, outputPath]);
    expect(result.ok && result.receipt.output).toMatchObject({
      preset: "mp4-h264", codec: "h264", encoder: "h264_nvenc", encoderSource: "hardware",
      encoderReason: "probe-selected-hardware",
      encoderProbe: { usableHardwareEncoders: ["h264_nvenc"], selectedHardwareEncoder: "h264_nvenc" }
    });
  });

  it("builds the exact deliberate args for hevc_nvenc (10-bit) and av1_nvenc (webm)", async () => {
    const hevcDir = await scratch("hevc");
    await writeContrastFrames(hevcDir, 2);
    const hevcOut = join(hevcDir, "hw.mp4");
    const av1Dir = await scratch("av1");
    await writeContrastFrames(av1Dir, 2);
    const av1Out = join(av1Dir, "hw.webm");
    const commands: FfmpegCommand[] = [];
    // These presets have a software encoderPolicy, so the encode first runs `-encoders` to pick the
    // software fallback; the injected probe then supplies the hardware choice.
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: [" V....D libx265 x (codec hevc)", " V..... libsvtav1 y (codec av1)"].join("\n"), stderr: "" };
      }
      await writeFile(command.args.at(-1) as string, "hw bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const hevc = await encodeImageSequence({
      packageId: "pkg_hevc_hw", framesDir: hevcDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath: hevcOut, preset: "mp4-hevc", runner, hardwareProbe: usabilityProbe(["hevc_nvenc"])
    });
    const av1 = await encodeImageSequence({
      packageId: "pkg_av1_hw", framesDir: av1Dir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath: av1Out, preset: "webm-av1", runner, hardwareProbe: usabilityProbe(["av1_nvenc"])
    });
    const hevcEncode = commands.find((command) => command.args.includes("hevc_nvenc"));
    const av1Encode = commands.find((command) => command.args.includes("av1_nvenc"));
    expect(hevcEncode && encodeTail(hevcEncode)).toEqual(["-frames:v", "2", ...HEVC_NVENC_ARGS, hevcOut]);
    expect(av1Encode && encodeTail(av1Encode)).toEqual(["-frames:v", "2", ...AV1_NVENC_ARGS, av1Out]);
    expect(hevc.ok && hevc.receipt.output).toMatchObject({ encoder: "hevc_nvenc", encoderSource: "hardware" });
    expect(av1.ok && av1.receipt.output).toMatchObject({ encoder: "av1_nvenc", encoderSource: "hardware", container: "webm" });
  });

  it("prefers the first preset candidate that the probe proves usable (ordering)", async () => {
    const outDir = await scratch("order");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "hw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(command.args.at(-1) as string, "bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // Probe order lists qsv first, but the preset candidate order is nvenc > videotoolbox > qsv, so
    // nvenc wins because it is the first PRESET candidate that is also usable.
    const both = await encodeImageSequence({
      packageId: "pkg_order_both", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, hardwareProbe: usabilityProbe(["h264_qsv", "h264_nvenc"])
    });
    expect(both.ok && both.receipt.output).toMatchObject({ encoder: "h264_nvenc", encoderSource: "hardware" });

    // When only qsv is usable, qsv is selected with its own deliberate args.
    const qsvDir = await scratch("qsv");
    await writeContrastFrames(qsvDir, 2);
    const qsvOut = join(qsvDir, "hw.mp4");
    const qsvCommands: FfmpegCommand[] = [];
    const qsv = await encodeImageSequence({
      packageId: "pkg_order_qsv", framesDir: qsvDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath: qsvOut, preset: "mp4-h264",
      runner: async (command) => { qsvCommands.push(command); await writeFile(command.args.at(-1) as string, "b", "utf8"); return { exitCode: 0, stdout: "", stderr: "" }; },
      hardwareProbe: usabilityProbe(["h264_qsv"])
    });
    expect(qsv.ok && qsv.receipt.output).toMatchObject({ encoder: "h264_qsv", encoderSource: "hardware" });
    expect(encodeTail(qsvCommands[0])).toEqual(["-frames:v", "2", ...H264_QSV_ARGS, qsvOut]);
  });

  it("falls back to software automatically when a hardware encode fails, and records the fallback", async () => {
    const outDir = await scratch("fallback");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "hw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("h264_nvenc")) {
        return { exitCode: 1, stdout: "", stderr: "nvenc: no capable devices SECRET_TOKEN=hidden" };
      }
      await writeFile(command.args.at(-1) as string, "libx264 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      packageId: "pkg_fallback", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, hardwareProbe: usabilityProbe(["h264_nvenc"])
    });
    expect(result.ok).toBe(true);
    // Two encode attempts: hardware (failed), then software libx264 (succeeded).
    const encodes = commandsWithoutColorReadback(commands);
    expect(encodes).toHaveLength(2);
    expect(encodes[0].args).toContain("h264_nvenc");
    expect(encodes[1].args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "18"]));
    expect(result.ok && result.receipt.output).toMatchObject({
      encoder: "libx264", encoderSource: "software", encoderReason: "hardware-fallback",
      encoderFallback: { attemptedEncoder: "h264_nvenc" }
    });
    // The fallback reason is recorded and stderr redaction still holds.
    expect(result.ok && result.receipt.warnings.some((warning) => warning.includes("Hardware encoder h264_nvenc failed"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN=hidden");
  });

  it("does not retry software when a hardware encode is stopped by the resource governor", async () => {
    const outDir = await scratch("governor");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "hw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 125, stdout: "", stderr: "Motion job queue is full.", resourceErrorCode: "job_queue_full" };
    };
    const result = await encodeImageSequence({
      packageId: "pkg_gov", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, hardwareProbe: usabilityProbe(["h264_nvenc"])
    });
    expect(result).toMatchObject({ ok: false, error: { code: "job_queue_full" } });
    expect(commands).toHaveLength(1);
  });

  it("uses the software encoder (software-default) when the probe finds no usable hardware", async () => {
    const outDir = await scratch("nohw");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "sw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(command.args.at(-1) as string, "libx264 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      packageId: "pkg_nohw", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, hardwareProbe: usabilityProbe([])
    });
    const encodes = commandsWithoutColorReadback(commands);
    expect(encodes).toHaveLength(1);
    expect(encodes[0].args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "18"]));
    expect(result.ok && result.receipt.output).toMatchObject({
      encoder: "libx264", encoderSource: "software", encoderReason: "software-default",
      encoderProbe: { usableHardwareEncoders: [], selectedHardwareEncoder: null }
    });
  });

  it("records compiled + redacted failed hardware candidates and hardwareAvailable in the receipt", async () => {
    const outDir = await scratch("probeevidence");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "sw.mp4");
    const runner: FfmpegRunner = async (command) => {
      await writeFile(command.args.at(-1) as string, "libx264 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // A compiled-but-unusable candidate whose failure message carries a host path that must be redacted.
    const probe: FfmpegHardwareEncoderUsability = {
      ok: true,
      command: "ffmpeg",
      selection: "first-usable",
      usableEncoders: [],
      probes: [{
        encoder: "h264_nvenc",
        compiled: true,
        usable: false,
        status: "initialization_failed",
        exitCode: 1,
        message: "Cannot load /usr/lib/x86_64-linux-gnu/libnvcuvid.so.1\nOpenEncodeSessionEx failed"
      }]
    };
    const result = await encodeImageSequence({
      packageId: "pkg_probe", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, hardwareProbe: probe
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.receipt.output).toMatchObject({
      encoder: "libx264", encoderSource: "software",
      encoderProbe: {
        hardwareAvailable: false,
        usableHardwareEncoders: [],
        selectedHardwareEncoder: null,
        compiledHardwareEncoders: ["h264_nvenc"],
        failedHardwareEncoders: [{ encoder: "h264_nvenc", reason: "Cannot load <path>" }]
      }
    });
  });

  it("forces software via the option even when a hardware candidate is usable", async () => {
    const outDir = await scratch("forceopt");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "sw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(command.args.at(-1) as string, "libx264 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      packageId: "pkg_force_opt", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner,
      hardwareProbe: usabilityProbe(["h264_nvenc"]), forceSoftwareEncode: true
    });
    // The hardware candidate is never attempted; only libx264 runs.
    const encodes = commandsWithoutColorReadback(commands);
    expect(encodes).toHaveLength(1);
    expect(encodes[0].args).toContain("libx264");
    expect(encodes[0].args).not.toContain("h264_nvenc");
    expect(result.ok && result.receipt.output).toMatchObject({
      encoder: "libx264", encoderSource: "software", encoderReason: "forced-software"
    });
  });

  it("forces software via SHELLX_MOTION_FORCE_SOFTWARE_ENCODE with no probe subprocesses", async () => {
    process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE = "1";
    const outDir = await scratch("forceenv");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "sw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      await writeFile(command.args.at(-1) as string, "libx264 bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // probeHardwareEncode is on, but the env override wins: no `-encoders`, no init probe — just encode.
    const result = await encodeImageSequence({
      packageId: "pkg_force_env", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, probeHardwareEncode: true
    });
    const encodes = commandsWithoutColorReadback(commands);
    expect(encodes).toHaveLength(1);
    expect(encodes[0].args).not.toContain("-encoders");
    expect(encodes[0].args).toContain("libx264");
    expect(result.ok && result.receipt.output).toMatchObject({ encoderSource: "software", encoderReason: "forced-software" });
  });

  it("runs the real usability probe (reusing capabilities) and selects hardware when enabled", async () => {
    const outDir = await scratch("realprobe");
    await writeContrastFrames(outDir, 2);
    const outputPath = join(outDir, "hw.mp4");
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: " V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)", stderr: "" };
      }
      if (command.args.includes("-f") && command.args.includes("null")) {
        return { exitCode: 0, stdout: "", stderr: "" }; // init probe success
      }
      await writeFile(command.args.at(-1) as string, "nvenc bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      packageId: "pkg_realprobe", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-h264", runner, probeHardwareEncode: true
    });
    // mp4-h264 has no software encoderPolicy, so the only `-encoders` call comes from the hardware
    // probe: capabilities discovery, one nvenc init probe, then the encode = 3 commands.
    const encodes = commandsWithoutColorReadback(commands);
    expect(encodes).toHaveLength(3);
    expect(encodes[0].args).toContain("-encoders");
    expect(encodes[1].args).toEqual(expect.arrayContaining(["-c:v", "h264_nvenc", "-f", "null", "-"]));
    expect(result.ok && result.receipt.output).toMatchObject({ encoder: "h264_nvenc", encoderSource: "hardware", encoderReason: "probe-selected-hardware" });
  });
});

/**
 * Coverage for the delivered-colour readback (`output.color.observed` + its honest warning).
 *
 * The defect this closes was measured during cross-host verification: a Windows FFmpeg 8.x build delivered HEVC and
 * AV1 files carrying only `color_space` and `color_range`, while Motion's receipt asserted the full
 * `sdr-bt709` profile — primaries and transfer included. Nothing in Motion noticed, because the
 * receipt's colour block was a copy of the preset's intent rather than an observation of the file.
 *
 * The stubs below reproduce that exact ffprobe shape, which is the point: the Linux host these tests
 * run on cannot produce the broken file, so the grading logic is proven against the real reading
 * taken off the Windows rig instead of against a host accident.
 */
describe("delivered colour readback", () => {
  const colourTempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(colourTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function colourScratch(label: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `shellx-motion-colour-${label}-`));
    colourTempDirs.push(dir);
    // Real PNG bytes: the pre-encode frame-quality gate rejects a placeholder sequence outright.
    await writeContrastFrames(dir, 2);
    return dir;
  }

  /** ffprobe OMITS a colour key entirely when the tag is absent — verified against ffprobe 6.1.1. */
  function probeStdout(colour: Record<string, string>): string {
    return JSON.stringify({
      streams: [{
        codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le",
        width: 2, height: 1, avg_frame_rate: "2/1", duration: "1.0",
        ...colour
      }],
      format: { duration: "1.0", format_name: "mov,mp4,m4a" }
    });
  }

  /**
   * Runner that encodes into a real file and answers the post-encode readback with a chosen shape.
   * `probeStdoutValue === null` makes the readback fail the way a broken/absent ffprobe would.
   */
  function runnerWithProbe(outputPath: string, probeStdoutValue: string | null): { runner: FfmpegRunner; commands: FfmpegCommand[] } {
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: [" V....D libx265 x (codec hevc)", " V..... libsvtav1 y (codec av1)"].join("\n"), stderr: "" };
      }
      if (command.args.includes("-show_streams")) {
        return probeStdoutValue === null
          ? { exitCode: 1, stdout: "", stderr: "ffprobe: could not read file" }
          : { exitCode: 0, stdout: probeStdoutValue, stderr: "" };
      }
      await writeFile(command.args.at(-1) as string, "encoded bytes", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { runner, commands };
  }

  function colourWarnings(warnings: string[]): string[] {
    return warnings.filter((warning) => warning.startsWith("Delivered "));
  }

  it("records the observed colour of a fully tagged delivery and does not warn", async () => {
    const outDir = await colourScratch("ok");
    const outputPath = join(outDir, "ok.mp4");
    const { runner } = runnerWithProbe(outputPath, probeStdout({
      color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv"
    }));

    const result = await encodeImageSequence({
      packageId: "pkg_colour_ok", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-hevc", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The DECLARED block is untouched — ShellX Cut reads it and the receipt shape is frozen.
    expect(result.receipt.output).toMatchObject({
      color: {
        profile: "sdr-bt709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv",
        conversion: "rgb-full-to-yuv-limited",
        observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
      }
    });
    expect(colourWarnings(result.receipt.warnings)).toEqual([]);
  });

  it("warns, and says exactly what is missing, for the Windows FFmpeg 8.x shape", async () => {
    const outDir = await colourScratch("windows");
    const outputPath = join(outDir, "windows.mp4");
    // Verbatim shape measured on the Windows rig: matrix and range survive, primaries and transfer
    // do not. Those are exactly the two the filter chain's colour negotiation does NOT carry.
    const { runner } = runnerWithProbe(outputPath, probeStdout({ color_space: "bt709", color_range: "tv" }));

    const result = await encodeImageSequence({
      packageId: "pkg_colour_windows", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-hevc", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.output).toMatchObject({
      color: { primaries: "bt709", transfer: "bt709", observed: { primaries: null, transfer: null, matrix: "bt709", range: "tv" } }
    });
    const warnings = colourWarnings(result.receipt.warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mp4-hevc");
    expect(warnings[0]).toContain("missing primaries, transfer");
    // The encode still succeeded and still delivered a file, so this is not a FAILURE — but it is
    // not an unqualified success either, and under the current contract the receipt says so. A colour warning
    // is an actionable warning under the shared rule in `@shellx-motion/core`
    // (`receiptStatusForWarnings`), so a delivery that lacks the colour its preset promised cannot
    // ride out on `passed`. This supersedes the earlier note that a colour warning never moved
    // status: under one rule for every receipt surface, it does.
    expect(result.receipt.status).toBe("warning");
  });

  it("reports a tag that is present but wrong rather than only a missing one", async () => {
    const outDir = await colourScratch("mismatch");
    const outputPath = join(outDir, "mismatch.mp4");
    const { runner } = runnerWithProbe(outputPath, probeStdout({
      color_space: "bt709", color_transfer: "smpte170m", color_primaries: "bt709", color_range: "pc"
    }));

    const result = await encodeImageSequence({
      packageId: "pkg_colour_mismatch", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-hevc", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = colourWarnings(result.receipt.warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("transfer is smpte170m, declared bt709");
    expect(warnings[0]).toContain("range is pc, declared tv");
  });

  it("tolerates a tag the container cannot signal at all (MOV/ProRes has no colour range)", async () => {
    const outDir = await colourScratch("prores");
    const outputPath = join(outDir, "prores.mov");
    // Real reading from ffmpeg 6.1.1: the MOV `colr` atom carries the nclc triplet and nothing else,
    // so `color_range` is absent on EVERY ProRes deliverable. Warning about it forever would be the
    // warning-fatigue failure the routine-stderr classifier exists to prevent.
    const { runner } = runnerWithProbe(outputPath, probeStdout({
      color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709"
    }));

    const result = await encodeImageSequence({
      packageId: "pkg_colour_prores", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mov-prores", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The absence is still REPORTED — it is just not graded as a defect.
    expect(result.receipt.output).toMatchObject({ color: { observed: { range: null, primaries: "bt709" } } });
    expect(colourWarnings(result.receipt.warnings)).toEqual([]);
  });

  it("stays silent when the readback itself failed, instead of inventing a colour claim", async () => {
    const outDir = await colourScratch("probefail");
    const outputPath = join(outDir, "probefail.mp4");
    const { runner } = runnerWithProbe(outputPath, null);

    const result = await encodeImageSequence({
      packageId: "pkg_colour_probefail", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-hevc", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No `observed` key at all, so a reader can tell "not measured" from "measured and missing".
    expect((result.receipt.output as { color?: unknown }).color).toEqual({
      profile: "sdr-bt709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv",
      conversion: "rgb-full-to-yuv-limited"
    });
    expect(colourWarnings(result.receipt.warnings)).toEqual([]);
  });

  it("reports and warns when a successful probe finds NO colour tag at all", async () => {
    // A completely untagged delivery must not stay silent on the reasoning that it is
    // "indistinguishable from the probe having nothing to say".
    // It is distinguishable, and treating it as unmeasured would be backwards. A probe
    // that THREW is the unmeasured case (covered separately below); a probe that succeeded and found
    // nothing has measured a file carrying no colour signalling at all, which is strictly worse for a
    // consumer than the partly tagged file that already warned. The delivery is playable but nothing
    // tells a player how to interpret its pixels.
    const outDir = await colourScratch("notags");
    const outputPath = join(outDir, "notags.mp4");
    const { runner } = runnerWithProbe(outputPath, probeStdout({}));

    const result = await encodeImageSequence({
      packageId: "pkg_colour_notags", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "mp4-hevc", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Measured, and every field absent: `observed` IS present, with null fields. That is the contract
    // documented for ShellX Cut -- null field means measured-and-absent, absent block means unmeasured.
    expect((result.receipt.output as { color?: { observed?: unknown } }).color?.observed).toEqual({
      primaries: null, transfer: null, matrix: null, range: null
    });
    const warnings = colourWarnings(result.receipt.warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/missing primaries, transfer, matrix, range/);
    // And under the unified rule the receipt must carry that, not claim a clean pass.
    expect(result.receipt.status).toBe("warning");
  });

  it("skips the readback entirely for a preset that declares no colour profile", async () => {
    const outDir = await colourScratch("gif");
    const outputPath = join(outDir, "out.gif");
    const { runner, commands } = runnerWithProbe(outputPath, probeStdout({ color_space: "bt709" }));

    const result = await encodeImageSequence({
      packageId: "pkg_colour_gif", framesDir: outDir, fps: 2, width: 2, height: 1, durationMs: 1000,
      outputPath, preset: "gif", runner, verifyDeliveredColor: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // GIF has no colour profile to check, so it must not pay for an extra subprocess.
    expect(commands.some((command) => command.args.includes("-show_streams"))).toBe(false);
    expect(result.receipt.output).not.toHaveProperty("color");
  });

  it("tags colour on the FRAME, identically for every encoder, with no encoder-specific arguments", () => {
    // The defect: on newer FFmpeg the encoder takes its colour properties from the filtergraph
    // output frame, so `-color_primaries` / `-color_trc` are ignored and the delivered HEVC and AV1
    // lost transfer and primaries while the receipt still declared sdr-bt709. Rig-measured on
    // Windows / ffmpeg N-125773: `scale` alone carried only matrix and range.
    //
    // `setparams` fixes it on the frame, so it applies to every codec at once. An earlier version
    // also passed `-x265-params`; re-measuring on the same rig showed `setparams` alone produces all
    // four tags, so the encoder-specific argument was removed. This test asserts the property that
    // removal bought: ONE mechanism, applied uniformly. `-x265-params` cannot be passed to nvenc or
    // SVT-AV1, so its presence had made software and hardware HEVC signal colour differently.
    const FRAME_TAGGING = "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

    for (const [preset, outputPath] of [
      ["mp4-h264", "/tmp/out.mp4"],
      ["mp4-hevc", "/tmp/out.mp4"],
      ["webm-av1", "/tmp/out.webm"],
      ["webm-vp9", "/tmp/out.webm"]
    ] as const) {
      const command = buildEncodeImageSequenceCommand({
        framesDir: "/tmp/frames", fps: 2, durationMs: 1000, outputPath, preset
      });
      expect(command.args, `${preset} must tag colour on the frame`).toContain(FRAME_TAGGING);
      // No encoder-specific colour signalling on any preset — that is what keeps the software and
      // hardware candidates on one chain.
      expect(command.args, `${preset} must not carry encoder-specific colour arguments`)
        .not.toContain("-x265-params");
      expect(command.args.join(" "), `${preset} must not carry SVT-AV1 colour arguments`)
        .not.toContain("color-primaries=");
    }
  });
});
