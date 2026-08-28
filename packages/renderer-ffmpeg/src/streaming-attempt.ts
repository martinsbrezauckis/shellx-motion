import {
  createStreamingFrameQualityAccumulator,
  LocalMotionJobError,
  type LocalMotionJobContext
} from "@shellx-motion/core";
import type { FfmpegProcessResult } from "./index";
import { encoderFailure, StreamingFailure, streamingProducerJobContext, toError, type StreamingEvidenceReporter } from "./streaming-foundation-helpers";
import { streamingMaxPngBytes, streamingMaxRgbaBytes } from "./streaming-foundation-validation";
import type { StreamingEncodeAttempt, StreamingFfmpegFinalInput, StreamingFrameSink } from "./streaming-foundation-types";
import type { StreamingFfmpegProcess } from "./streaming-process";

export async function runStreamingAttempt(input: {
  input: StreamingFfmpegFinalInput & { produce: NonNullable<StreamingFfmpegFinalInput["produce"]> };
  attempt: StreamingEncodeAttempt;
  process: StreamingFfmpegProcess;
  signal: AbortSignal;
  job: LocalMotionJobContext;
  maxProcessTreeRssBytes: number;
  evidenceReporter: StreamingEvidenceReporter;
  observe(event: {
    concurrentProducerWrites: number;
    writes: number;
    drainWaits: number;
    bufferedInputBytes: number;
    inputHighWaterMarkBytes: number;
  }): void;
}): Promise<{
  output: FfmpegProcessResult;
  frameSequence: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
  quality: { warnings: string[]; frameCount: number; blankFrames: number; uniqueFrameHashes: number; uniqueFrameHashesExact: boolean };
}> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", relayAbort, { once: true });
  if (input.signal.aborted) relayAbort();
  let inputEnded = false;
  let concurrentProducerWrites = 0;
  let writes = 0;
  let drainWaits = 0;
  const quality = createStreamingFrameQualityAccumulator({
    frameCount: input.input.frameCount,
    durationMs: input.input.durationMs,
    fps: input.input.fps,
    width: input.input.width,
    height: input.input.height,
    ...(input.input.quality ? { quality: input.input.quality } : {})
  });
  const closed = input.process.closed.then((result) => {
    if (!inputEnded && !controller.signal.aborted) controller.abort(encoderFailure(result));
    return result;
  });
  const throwIfStopped = () => {
    if (!controller.signal.aborted) return;
    const reason = controller.signal.reason;
    if (input.signal.aborted && !(reason instanceof LocalMotionJobError)) {
      throw new LocalMotionJobError("job_cancelled", "Streaming FFmpeg job was cancelled.");
    }
    throw reason instanceof Error ? reason : new LocalMotionJobError("job_cancelled", "Streaming FFmpeg job was cancelled.");
  };
  const sink: StreamingFrameSink = {
    async write(frame) {
      throwIfStopped();
      if (concurrentProducerWrites !== 0) {
        throw new StreamingFailure("streaming_write_concurrent", "Streaming frame producers must await sink.write before producing the next frame.");
      }
      concurrentProducerWrites = 1;
      input.observe({ concurrentProducerWrites, writes: 0, drainWaits: 0, bufferedInputBytes: 0, inputHighWaterMarkBytes: 0 });
      try {
        const expectedFormat = input.input.frameFormat ?? "png";
        const actualFormat = "png" in frame ? "png" : frame.format;
        if (actualFormat !== expectedFormat) {
          throw new StreamingFailure("invalid_frame", `Streaming producer emitted ${actualFormat}; this encoder attempt requires ${expectedFormat}.`);
        }
        const bytes = "png" in frame ? frame.png : frame.rgba;
        const maxFrameBytes = actualFormat === "rgba"
          ? streamingMaxRgbaBytes(input.input.width, input.input.height)
          : streamingMaxPngBytes(input.input.width, input.input.height);
        if (actualFormat === "rgba" ? bytes.byteLength !== maxFrameBytes : bytes.byteLength > maxFrameBytes) {
          throw new StreamingFailure(
            "invalid_frame",
            `Streaming ${actualFormat} frame ${frame.index} is ${bytes.byteLength} bytes; the declared ${input.input.width}x${input.input.height} frame ${actualFormat === "rgba" ? "size" : "limit"} is ${maxFrameBytes} bytes.`
          );
        }
        const inspected = quality.observe(frame);
        if (!inspected.ok) throw new StreamingFailure(inspected.code === "invalid_frame" ? "invalid_frame" : "frame_quality_failed", inspected.message);
        let write;
        try {
          write = await input.process.write(bytes);
        } catch (error) {
          throw new StreamingFailure("encoder_failed", toError(error).message);
        }
        writes += 1;
        if (write.backpressured) drainWaits += 1;
        input.observe({
          concurrentProducerWrites,
          writes: 1,
          drainWaits: write.backpressured ? 1 : 0,
          bufferedInputBytes: write.bufferedInputBytes,
          inputHighWaterMarkBytes: write.inputHighWaterMarkBytes
        });
        throwIfStopped();
      } finally {
        concurrentProducerWrites = 0;
      }
    }
  };
  try {
    const producerJob = streamingProducerJobContext(input.job, controller.signal, input.evidenceReporter, input.maxProcessTreeRssBytes);
    await input.input.produce(sink, {
      signal: controller.signal,
      attempt: input.attempt,
      job: producerJob,
      runAdmitted: async (operation) => {
        throwIfStopped();
        return operation(producerJob);
      }
    });
    throwIfStopped();
    const qualityResult = quality.finish();
    if (!qualityResult.ok) throw new StreamingFailure("frame_quality_failed", qualityResult.message);
    inputEnded = true;
    const output = await input.process.end();
    if (output.exitCode !== 0) throw encoderFailure(output);
    return {
      output,
      frameSequence: qualityResult.identity,
      quality: {
        warnings: qualityResult.warnings,
        frameCount: qualityResult.summary.frameCount,
        blankFrames: qualityResult.summary.blankFrames,
        uniqueFrameHashes: qualityResult.summary.uniqueFrameHashes,
        uniqueFrameHashesExact: qualityResult.summary.uniqueFrameHashesExact
      }
    };
  } catch (error) {
    await input.process.abort(toError(error));
    const output = await closed;
    if (error instanceof StreamingFailure && error.code === "encoder_failed" && !error.process && output.exitCode !== 0) {
      throw encoderFailure(output);
    }
    if (error instanceof LocalMotionJobError || error instanceof StreamingFailure) throw error;
    throw new StreamingFailure("producer_failed", toError(error).message);
  } finally {
    input.signal.removeEventListener("abort", relayAbort);
  }
}
