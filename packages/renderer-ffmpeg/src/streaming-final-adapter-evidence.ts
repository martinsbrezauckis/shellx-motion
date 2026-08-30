import { sanitizeUntrustedDiagnostic, type OperationReceipt } from "@shellx-motion/core";
import type { NativeFrameProducerEvidence } from "@shellx-motion/renderer-native";
import type {
  StreamingFinalEncoderHandoffEvidence,
  StreamingFinalNativeProducerEvidence,
  StreamingFinalProducerEvidence
} from "./streaming-final-adapter-types.js";

const MAX_WARNINGS = 64;
const MAX_AUDIO_HANDOFF_LAYERS = 64;
const MAX_ERROR_MESSAGE_CHARS = 400;
const MAX_STREAMING_DIAGNOSTIC_RAW_BYTES = 4 * 1024;

/** Copy the internal handoff into the stable public shape without retaining mutable attempt state. */
export function publicEncoderHandoff(value: StreamingFinalEncoderHandoffEvidence): StreamingFinalEncoderHandoffEvidence {
  return {
    delivery: "streamed",
    ...(value.frameFormat ? { frameFormat: value.frameFormat } : {}),
    maxConcurrentProducerWrites: 1,
    observedMaxConcurrentProducerWrites: value.observedMaxConcurrentProducerWrites,
    maxBufferedInputBytes: value.maxBufferedInputBytes,
    inputHighWaterMarkBytes: value.inputHighWaterMarkBytes,
    ...(value.maxFrameBytesPerFrame !== undefined ? { maxFrameBytesPerFrame: value.maxFrameBytesPerFrame } : {}),
    ...(value.maxPngBytesPerFrame !== undefined ? { maxPngBytesPerFrame: value.maxPngBytesPerFrame } : {}),
    ...(value.maxRgbaBytesPerFrame !== undefined ? { maxRgbaBytesPerFrame: value.maxRgbaBytesPerFrame } : {}),
    backpressure: { writes: value.backpressure.writes, drainWaits: value.backpressure.drainWaits },
    encoderHandoffSourceFramesRetained: 0,
    qualityPlaneSetCapacity: 2,
    uniqueHashCapacity: value.uniqueHashCapacity,
    attempts: value.attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.failure ? { failure: { ...attempt.failure, ...(attempt.failure.process ? { process: { ...attempt.failure.process } } : {}) } } : {})
    })),
    ...(value.frameSequence ? { frameSequence: { ...value.frameSequence } } : {}),
    ...(value.quality ? { quality: { ...value.quality, warnings: [...value.quality.warnings] } } : {})
  };
}

/** Remove terminal output paths and bound terminal collections before publishing native producer evidence. */
export function publicNativeProducerEvidence(value: NativeFrameProducerEvidence): StreamingFinalNativeProducerEvidence {
  const warnings = boundedStrings(value.terminal.laneWarnings, MAX_WARNINGS);
  const handoffLayers = value.terminal.downstreamAudioHandoffLayers.slice(0, MAX_AUDIO_HANDOFF_LAYERS)
    .map((layer) => ({ id: boundedText(layer.id, 160), type: boundedText(layer.type, 80) }));
  return {
    schema: value.schema,
    producer: { ...value.producer },
    session: { ...value.session, assetCache: { ...value.session.assetCache } },
    terminal: {
      lastFrameReceipt: receiptIdentity(value.terminal.lastFrameReceipt),
      laneWarnings: warnings.values,
      warningsOmitted: warnings.omitted,
      downstreamAudioHandoffLayers: handoffLayers,
      audioHandoffLayersOmitted: Math.max(0, value.terminal.downstreamAudioHandoffLayers.length - handoffLayers.length)
    }
  };
}

/** Preserve typed producer refusals while bounding and redacting all text returned to a caller. */
export function knownProducerFailure(error: unknown): { code: string; message: string } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== "string" || !candidate.code || typeof candidate.message !== "string") return undefined;
  return { code: boundedDiagnostic(candidate.code, 120), message: boundedDiagnostic(candidate.message, MAX_ERROR_MESSAGE_CHARS) };
}

export function safeProducerMessage(error: unknown): string {
  return boundedDiagnostic(error instanceof Error ? error.message : String(error), MAX_ERROR_MESSAGE_CHARS);
}

export function mergedProducerWarnings(base: readonly string[], producer: StreamingFinalProducerEvidence): string[] {
  const producerWarnings = producer.frameLane === "browser"
    ? producer.evidence.warningUnion
    : producer.frameLane === "native"
      ? producer.evidence.terminal.laneWarnings
      : [];
  return boundedStrings([...base, ...producerWarnings], MAX_WARNINGS).values;
}

function receiptIdentity(receipt: OperationReceipt | null): StreamingFinalNativeProducerEvidence["terminal"]["lastFrameReceipt"] {
  if (!receipt) return null;
  const { schema, id, operation, status, packageId, createdAt, lane } = receipt;
  return { schema, id, operation, status, packageId, createdAt, lane };
}

function boundedStrings(values: readonly string[], capacity: number): { values: string[]; omitted: number } {
  const result: string[] = [];
  let omitted = 0;
  for (const value of values) {
    const safe = boundedDiagnostic(value, MAX_ERROR_MESSAGE_CHARS);
    if (result.includes(safe)) continue;
    if (result.length >= capacity) {
      omitted += 1;
      continue;
    }
    result.push(safe);
  }
  return { values: result, omitted };
}

function boundedDiagnostic(value: string, maximum: number): string {
  const safe = sanitizeUntrustedDiagnostic(value, {
    rawMaxBytes: MAX_STREAMING_DIAGNOSTIC_RAW_BYTES,
    publicMaxBytes: maximum,
    collapseWhitespace: true
  });
  if (!safe) return "producer operation failed";
  return safe;
}

function boundedText(value: string, maximum: number): string {
  return boundedDiagnostic(value, maximum);
}
