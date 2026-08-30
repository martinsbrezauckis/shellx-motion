import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { FfmpegCommand, FfmpegRunner } from "./index.js";
import {
  LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT,
  LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256,
  LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER,
  LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER,
  LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES,
  linearSrgbSdrFinalEncodeCommand,
  linearSrgbSdrFinalFfmpegPreflightCommand,
  linearSrgbSdrFinalInverseDecodeCommand,
  preflightLinearSrgbSdrFinalFfmpeg,
} from "./linear-srgb-sdr-final-ffmpeg-contract.js";

describe("strict linear-sRGB SDR FFmpeg contract", () => {
  it("pins one exact output-free zscale/libx264 capability exercise", () => {
    const command = linearSrgbSdrFinalFfmpegPreflightCommand();
    expect(isAbsolute(command.executable)).toBe(true);
    expect(command.executable).toMatch(/(?:^|[\\/])ffmpeg(?:\.exe)?$/iu);
    expect(command).toMatchObject({
      shell: false,
      args: [
        "-hide_banner", "-v", "error", "-nostdin",
        "-f", "lavfi", "-i", "color=c=black:s=2x2:r=1:d=1,format=rgba",
        "-frames:v", "1", "-vf", LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER,
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-f", "null", "-",
      ],
    });
    expect(command.args).not.toContain("-hwaccel");
    expect(command.args).not.toContain("-y");
    expect(command.args.at(-2)).toBe("null");
  });

  it("requires version identity and the exact exercise before emitting bounded evidence", async () => {
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return command.args[0] === "-version"
        ? { exitCode: 0, stdout: "ffmpeg version test-6.1\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    };
    const evidence = await preflightLinearSrgbSdrFinalFfmpeg({ runner });
    expect(calls.map((command) => command.args)).toEqual([
      ["-version"],
      ["-version"],
      linearSrgbSdrFinalFfmpegPreflightCommand().args,
    ]);
    expect(evidence).toMatchObject({
      schema: "shellx-motion/linear-srgb-sdr-final-ffmpeg-preflight@1",
      status: "available",
      tools: {
        ffmpeg: { tool: "ffmpeg", executable: "ffmpeg", version: "ffmpeg version test-6.1" },
        ffprobe: { tool: "ffprobe", executable: "ffprobe", version: "ffmpeg version test-6.1" },
      },
      contractSha256: LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256,
    });
    expect(evidence.commandSha256).toBe(canonicalJsonSha256(calls[2]));
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("fails closed when either FFmpeg identity or the exact transform is unavailable", async () => {
    const missing: FfmpegRunner = async () => ({ exitCode: 127, stdout: "", stderr: "unavailable" });
    await expect(preflightLinearSrgbSdrFinalFfmpeg({ runner: missing })).rejects.toThrow("working FFmpeg");

    let calls = 0;
    const missingZscale: FfmpegRunner = async () => {
      calls += 1;
      return calls <= 2
        ? { exitCode: 0, stdout: "ffmpeg version test\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "no zscale" };
    };
    await expect(preflightLinearSrgbSdrFinalFfmpeg({ runner: missingZscale })).rejects.toThrow("exact strict linear-sRGB SDR zscale");
  });

  it("builds a strict raw-RGBA software encode without the generic SDR tail", () => {
    const command = linearSrgbSdrFinalEncodeCommand({ width: 1920, height: 1080, fps: 30, frameCount: 90 }, "/private/work.mp4");
    expect(command.args).toEqual([
      "-hide_banner", "-v", "error", "-nostdin", "-n",
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "1920x1080", "-framerate", "30", "-i", "pipe:0",
      "-map", "0:v:0", "-an", "-frames:v", "90", "-vf", LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-movflags", "+faststart", "-fs", String(LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES), "/private/work.mp4",
    ]);
    expect(command.args.join(" ")).not.toContain("scale=in_range");
    expect(command.args.filter((value) => value === "pipe:0")).toHaveLength(1);
  });

  it("decodes one selected frame through the exact inverse into a private binary file", () => {
    expect(linearSrgbSdrFinalInverseDecodeCommand("/private/work.mp4", "/private/frame.rgba").args).toEqual([
      "-hide_banner", "-v", "error", "-nostdin", "-n", "-i", "/private/work.mp4",
      "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER,
      "-fps_mode", "passthrough", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "/private/frame.rgba",
    ]);
    expect(() => linearSrgbSdrFinalInverseDecodeCommand("/same.mp4", "/same.mp4")).toThrow("distinct");
    expect(() => linearSrgbSdrFinalInverseDecodeCommand("pipe:0", "/frame")).toThrow("path is invalid");
  });

  it("rejects oversized or malformed command inputs before command construction", () => {
    expect(() => linearSrgbSdrFinalEncodeCommand({ width: 1921, height: 1080, fps: 30, frameCount: 1 }, "/work.mp4")).toThrow("bounded positive");
    expect(() => linearSrgbSdrFinalEncodeCommand({ width: 1, height: 1, fps: Number.NaN, frameCount: 1 }, "/work.mp4")).toThrow("bounded positive");
    expect(() => linearSrgbSdrFinalEncodeCommand({ width: 1, height: 1, fps: 1, frameCount: 0 }, "/work.mp4")).toThrow("bounded positive");
    expect(() => linearSrgbSdrFinalEncodeCommand({ width: 1, height: 1, fps: 1, frameCount: 1 }, "-")).toThrow("path is invalid");
    expect(() => linearSrgbSdrFinalEncodeCommand({ width: 1, height: 1, fps: 1, frameCount: 1 }, "/work.mov")).toThrow(".mp4 extension");
  });

  it("binds the complete immutable transform contract", () => {
    expect(LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT).toMatchObject({
      source: { transfer: "iec61966-2-1", matrix: "gbr", range: "full" },
      encode: { codec: "libx264", hardware: "refused" },
      signal: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
      inverse: { intermediatePixelFormat: "gbrp", outputPixelFormat: "rgba" },
    });
    expect(LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256).toBe(canonicalJsonSha256(LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT));
    expect(Object.isFrozen(LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT.forward)).toBe(true);
  });
});
