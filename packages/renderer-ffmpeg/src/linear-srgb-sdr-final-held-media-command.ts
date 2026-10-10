import {
  LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER,
  linearSrgbSdrFinalEncodeCommand,
  linearSrgbSdrFinalInverseDecodeCommand,
} from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import type { FfmpegCommand } from "./index.js";

const HELD_EXECUTABLE = "/proc/self/fd/3";
const HELD_SOURCE = "/proc/self/fd/4";
const HELD_DECODED = "/proc/self/fd/5";

type Timeline = Readonly<{ width: number; height: number; fps: number; frameCount: number }>;

function heldCommand(args: string[]): FfmpegCommand {
  Object.freeze(args);
  return Object.freeze({ executable: HELD_EXECUTABLE, shell: false, args });
}

/** Derive the candidate-only descriptor argv from the ordinary strict contract template. */
export function heldEncodeCommand(timeline: Timeline, expectedExecutable?: string): FfmpegCommand {
  const dummy = "/strict-sdr-held-dummy.mp4";
  const ordinary = linearSrgbSdrFinalEncodeCommand(timeline, dummy);
  const overwrite = ordinary.args.indexOf("-n");
  if (overwrite < 0 || ordinary.args.filter((value) => value === "-n").length !== 1 || ordinary.args.filter((value) => value === dummy).length !== 1 || ordinary.args.at(-1) !== dummy) {
    throw new Error("Strict SDR held-media refused a drifted ordinary encode template.");
  }
  if (expectedExecutable !== undefined && ordinary.executable !== expectedExecutable) {
    throw new Error("Strict SDR held-media FFmpeg template no longer resolves to its admitted executable.");
  }
  const args = [...ordinary.args];
  args[overwrite] = "-y";
  args.pop();
  args.push("-f", "mp4", HELD_SOURCE);
  return heldCommand(args);
}

export function heldProbeCommand(): FfmpegCommand {
  return heldCommand(["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-protocol_whitelist", "file", "-i", HELD_SOURCE]);
}

export function heldInverseCommand(expectedExecutable?: string): FfmpegCommand {
  const sourceDummy = "/strict-sdr-held-dummy.mp4";
  const decodedDummy = "/strict-sdr-held-decoded.rgba";
  const ordinary = linearSrgbSdrFinalInverseDecodeCommand(sourceDummy, decodedDummy);
  const overwrite = ordinary.args.indexOf("-n");
  if (overwrite < 0 || ordinary.args.filter((value) => value === "-n").length !== 1 || ordinary.args.filter((value) => value === sourceDummy).length !== 1 || ordinary.args.filter((value) => value === decodedDummy).length !== 1) {
    throw new Error("Strict SDR held-media refused a drifted ordinary inverse template.");
  }
  if (expectedExecutable !== undefined && ordinary.executable !== expectedExecutable) {
    throw new Error("Strict SDR held-media inverse template no longer resolves to its admitted executable.");
  }
  const args = ordinary.args.map((value) => value === "-n" ? "-y" : value === sourceDummy ? HELD_SOURCE : value === decodedDummy ? HELD_DECODED : value);
  return heldCommand(args);
}

/**
 * Same-parent-only natural-EOF inverse. It derives from the ordinary one-frame
 * template, removes only its frame-selection/output-file mechanics, and writes
 * raw RGBA to the child's fixed stdout. It has no caller-provided filter, count,
 * pathname, or descriptor selector.
 */
export function heldAllDeliveredFramesInverseCommand(expectedExecutable?: string): FfmpegCommand {
  const sourceDummy = "/strict-sdr-held-dummy.mp4";
  const decodedDummy = "/strict-sdr-held-decoded.rgba";
  const ordinary = linearSrgbSdrFinalInverseDecodeCommand(sourceDummy, decodedDummy);
  const filterIndex = ordinary.args.indexOf("-vf"), outputIndex = ordinary.args.lastIndexOf(decodedDummy);
  const frameIndex = ordinary.args.indexOf("-frames:v"), overwrite = ordinary.args.indexOf("-n");
  const select = "select=eq(n\\,0),";
  if (filterIndex < 0 || ordinary.args[filterIndex + 1] !== LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER
    || outputIndex !== ordinary.args.length - 1 || frameIndex < 0 || ordinary.args[frameIndex + 1] !== "1"
    || overwrite < 0 || ordinary.args.filter((value) => value === "-n").length !== 1
    || ordinary.args.filter((value) => value === sourceDummy).length !== 1
    || ordinary.args.filter((value) => value === decodedDummy).length !== 1
    || !LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER.startsWith(select)) {
    throw new Error("Strict SDR held-media refused a drifted ordinary all-frames inverse template.");
  }
  if (expectedExecutable !== undefined && ordinary.executable !== expectedExecutable) {
    throw new Error("Strict SDR held-media all-frames inverse template no longer resolves to its admitted executable.");
  }
  const args = ordinary.args
    .map((value, index) => index === filterIndex + 1
      ? LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER.slice(select.length)
      : value === sourceDummy ? HELD_SOURCE
        : value === decodedDummy ? "pipe:1"
          : value)
    .filter((_value, index) => index !== overwrite && index !== frameIndex && index !== frameIndex + 1);
  if (args.includes("-frames:v") || args.includes("-n") || args.at(-1) !== "pipe:1" || args[args.indexOf("-vf") + 1] === LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER) {
    throw new Error("Strict SDR held-media all-frames inverse command did not retain natural-EOF raw-video semantics.");
  }
  return heldCommand(args);
}

export function heldMediaCommands(timeline: Timeline): Readonly<{ encode: FfmpegCommand; probe: FfmpegCommand; inverse: FfmpegCommand }> {
  return Object.freeze({ encode: heldEncodeCommand(timeline), probe: heldProbeCommand(), inverse: heldInverseCommand() });
}
