import { hashBuffer, inspectPngBuffer, streamingFrameTimestampMs } from "@shellx-motion/core";
import type { StreamingFfmpegProcess } from "../streaming-process.js";
import { SegmentSpoolOperationError } from "./render-segment-spool-helpers.js";
import type { RenderSegmentRange } from "./render-segment-store-types.js";
import type { RenderSegmentSpoolFrame, RenderSegmentSpoolTimelineFacts } from "./render-segment-spool-types.js";

/** Validate and stream one canonical GPU/raw or legacy/PNG checkpoint range under backpressure. */
export function createRenderSegmentSpoolFrameSink(input: {
  process: StreamingFfmpegProcess;
  range: RenderSegmentRange;
  timeline: RenderSegmentSpoolTimelineFacts;
  frameLane: "browser" | "native" | "gpu";
  signal: AbortSignal;
}) {
  let expectedIndex = input.range.startFrame;
  let writing = 0;
  let observedMaxConcurrentPngHandoffs = 0;
  let blankFrameCount = 0;
  const frameHashes: string[] = [];
  return {
    frameHashes,
    get blankFrameCount() { return blankFrameCount; },
    get observedMaxConcurrentPngHandoffs() { return observedMaxConcurrentPngHandoffs; },
    sink: {
      async write(frame: RenderSegmentSpoolFrame): Promise<void> {
        throwIfStopped(input.signal);
        if (writing !== 0) throw new SegmentSpoolOperationError("frame_validation", "Segment producer wrote frames concurrently.");
        if (frame.index !== expectedIndex || frame.atMs !== streamingFrameTimestampMs(expectedIndex, input.timeline.fps, input.timeline.durationMs)) {
          throw new SegmentSpoolOperationError("frame_validation", "Segment producer emitted a non-canonical frame index or timestamp.");
        }
        const checked = input.frameLane === "gpu"
          ? inspectGpuRgbaFrame(frame, input.timeline.width, input.timeline.height)
          : inspectPngFrame(frame, input.timeline.width, input.timeline.height);
        if (!checked.ok) throw new SegmentSpoolOperationError("frame_validation", checked.message);
        writing = 1;
        observedMaxConcurrentPngHandoffs = Math.max(observedMaxConcurrentPngHandoffs, writing);
        try {
          try { await input.process.write(checked.bytes); }
          catch (error) { throw new SegmentSpoolOperationError("encoder", error); }
          frameHashes.push(checked.sha256);
          if (checked.blank) blankFrameCount += 1;
          expectedIndex += 1;
          throwIfStopped(input.signal);
        } finally { writing = 0; }
      }
    },
    assertComplete() {
      if (expectedIndex !== input.range.endFrameExclusive || frameHashes.length !== input.range.frameCount) {
        throw new SegmentSpoolOperationError("producer", "Segment producer did not emit its complete canonical range.");
      }
    }
  };
}

function inspectPngFrame(frame: RenderSegmentSpoolFrame, width: number, height: number): CheckedFrame | InvalidFrame {
  if (!("png" in frame)) return { ok: false, message: "Non-GPU segment producers must emit PNG frames." };
  const quality = inspectPngBuffer(frame.png);
  if (!quality.ok || quality.width !== width || quality.height !== height) {
    return { ok: false, message: "Segment producer emitted an invalid or incorrectly sized PNG frame." };
  }
  return { ok: true, bytes: frame.png, sha256: quality.sha256, blank: quality.blank };
}

function inspectGpuRgbaFrame(frame: RenderSegmentSpoolFrame, width: number, height: number): CheckedFrame | InvalidFrame {
  if (!("rgba" in frame) || frame.format !== "rgba" || !Buffer.isBuffer(frame.rgba)
    || frame.width !== width || frame.height !== height || frame.strideBytes !== width * 4
    || frame.rgba.byteLength !== frame.strideBytes * height || frame.colorSpace !== "srgb" || frame.alphaMode !== "straight") {
    return { ok: false, message: "GPU segment producer must emit tightly packed straight-alpha sRGB RGBA matching the canonical dimensions." };
  }
  let visible = 0; let minLuma = 255; let maxLuma = 0; let minRgb = 255; let maxRgb = 0;
  for (let offset = 0; offset < frame.rgba.length; offset += 4) {
    if (frame.rgba[offset + 3] === 0) continue;
    visible += 1;
    const red = frame.rgba[offset]!; const green = frame.rgba[offset + 1]!; const blue = frame.rgba[offset + 2]!;
    const luma = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
    minLuma = Math.min(minLuma, luma); maxLuma = Math.max(maxLuma, luma);
    minRgb = Math.min(minRgb, red, green, blue); maxRgb = Math.max(maxRgb, red, green, blue);
  }
  const blank = visible < Math.ceil((width * height) * 0.01) || (maxLuma - minLuma <= 2 && maxRgb - minRgb <= 2);
  return { ok: true, bytes: frame.rgba, sha256: hashBuffer(frame.rgba), blank };
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Segment spool was cancelled.");
}

type CheckedFrame = { ok: true; bytes: Buffer; sha256: string; blank: boolean };
type InvalidFrame = { ok: false; message: string };
