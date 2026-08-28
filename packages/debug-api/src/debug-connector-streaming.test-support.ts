import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect } from "vitest";
import {
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  type FfmpegCommand,
  type FfmpegRunner,
  type RenderStreamingFinalInput,
  type RenderStreamingFinalResult
} from "@shellx-motion/renderer-ffmpeg";
import {
  createDebugConnectorStreamedReceipt,
  createDebugConnectorStreamedTransport,
  fakeMp4Bytes
} from "./debug-connector-streaming-evidence.test-support.js";

export {
  expectDebugConnectorStreamedReceipt,
  fakeMp4Bytes
} from "./debug-connector-streaming-evidence.test-support.js";

export interface DebugConnectorStreamingCall {
  outputPath: string;
  frameLane: "browser" | "native";
  quality: { minUniqueFrameHashes?: number } | undefined;
  transport: unknown;
}

/**
 * Test-only host image2pipe seam. It completes a streamed render and delegates
 * delivered-media colour readback to the supplied tool runner; it never
 * pretends the runner can encode stdin PNGs.
 */
export function debugConnectorStreamingRenderer(label: string): {
  calls: DebugConnectorStreamingCall[];
  render: (input: RenderStreamingFinalInput) => Promise<RenderStreamingFinalResult>;
} {
  const calls: DebugConnectorStreamingCall[] = [];
  const render = async (
    input: RenderStreamingFinalInput
  ): Promise<RenderStreamingFinalResult> => {
    if (input.frameLane === "gpu") throw new Error("Debug connector test seam does not adopt the GPU final lane.");
    calls.push({
      outputPath: input.outputPath,
      frameLane: input.frameLane,
      quality: input.quality,
      transport: input.transport
    });
    const bytes = fakeMp4Bytes(label);
    await mkdir(dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, bytes);
    const readback = await input.toolPolicy?.runner?.({
      executable: resolveFfprobeExecutable(),
      args: [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        input.outputPath
      ],
      shell: false
    });
    if (readback && readback.exitCode !== 0) {
      return {
        ok: false,
        transport: input.transport ?? {
          delivery: "streamed",
          reason: "stream_default"
        },
        error: {
          code: "ffprobe_failed",
          message: readback.stderr || "Delivered-colour readback failed."
        }
      };
    }
    const frameTransport = createDebugConnectorStreamedTransport(
      input.frameLane,
      input.pkg.motion.durationMs,
      input.pkg.motion.fps
    );
    return {
      ok: true,
      command: {
        executable: resolveFfmpegExecutable(),
        args: ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", input.outputPath],
        shell: false
      },
      receipt: createDebugConnectorStreamedReceipt(input, bytes, frameTransport),
      transport: frameTransport
    };
  };
  return { calls, render };
}

/** A typed host-streamed failure that proves connector error propagation. */
export function debugConnectorStreamingFailureRenderer(
  code: string,
  message: string
): (input: RenderStreamingFinalInput) => Promise<RenderStreamingFinalResult> {
  return async () => ({
    ok: false,
    transport: { delivery: "streamed", reason: "stream_default" },
    error: { code, message }
  });
}

/** A probe-only runner for staged media; an image2pipe encode command fails the test. */
export function debugConnectorDeliveredColorRunner(): {
  commands: FfmpegCommand[];
  runner: FfmpegRunner;
} {
  const commands: FfmpegCommand[] = [];
  return {
    commands,
    runner: async (command) => {
      commands.push(command);
      if (
        command.executable !== resolveFfprobeExecutable() ||
        !command.args.includes("-show_streams")
      ) {
        throw new Error(
          "The legacy FFmpeg runner may serve only delivered-colour FFprobe readback in streamed connector tests."
        );
      }
      return {
        exitCode: 0,
        stdout: deliveredColorReadbackStdout(),
        stderr: ""
      };
    }
  };
}

export function expectDebugConnectorDeliveredColorReadback(
  commands: FfmpegCommand[],
  outputPath: string
): void {
  expect(commands).toEqual([
    expect.objectContaining({
      executable: resolveFfprobeExecutable(),
      shell: false,
      args: expect.arrayContaining(["-show_streams", "-show_format", outputPath])
    })
  ]);
}

function deliveredColorReadbackStdout(): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: "video",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
        color_range: "tv"
      }
    ]
  });
}
