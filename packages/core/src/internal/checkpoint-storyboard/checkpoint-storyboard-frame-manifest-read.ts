import { compareCodeUnits } from "../../canonical-json";
import { exactArray, exactRecord, freeze, safeId, safeUs, sha256, snapshotCheckpointStoryboardData, strictIds } from "./checkpoint-storyboard-data";
import {
  FRAME_CHECKPOINT_EVALUATOR_VERSION,
  FRAME_CHECKPOINT_MANIFEST_LIMITS,
  FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA,
  FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA,
  type FrameCheckpointManifestRequest,
  type FrameCheckpointOutputAppend,
} from "./checkpoint-storyboard-frame-manifest-types";

/** Snapshot and admit one data-only deterministic frame/checkpoint request. */
export function readFrameCheckpointManifestRequest(value: unknown): FrameCheckpointManifestRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "evaluatorVersion", "seed", "rate", "totalFrameCount", "frameRange", "inputs", "checkpoints"], [], "Frame/checkpoint manifest request");
  if (root.schema !== FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA) throw new Error(`Frame/checkpoint manifest request.schema must equal ${FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA}.`);
  if (root.evaluatorVersion !== FRAME_CHECKPOINT_EVALUATOR_VERSION) throw new Error(`Frame/checkpoint manifest request.evaluatorVersion must equal ${FRAME_CHECKPOINT_EVALUATOR_VERSION}.`);
  const rate = readRate(root.rate);
  const totalFrameCount = integer(root.totalFrameCount, "Frame/checkpoint manifest request.totalFrameCount", 1, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxTotalFrames);
  const frameRange = readFrameRange(root.frameRange, totalFrameCount);
  const inputs = readInputs(root.inputs);
  const checkpoints = readCheckpoints(root.checkpoints, frameTimeUs(totalFrameCount - 1, rate));
  return freeze({
    schema: FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA,
    evaluatorVersion: FRAME_CHECKPOINT_EVALUATOR_VERSION,
    seed: integer(root.seed, "Frame/checkpoint manifest request.seed", 0, 0xffff_ffff),
    rate,
    totalFrameCount,
    frameRange,
    inputs,
    checkpoints,
  });
}

/** Snapshot one contiguous output-hash append before it reaches manifest lineage logic. */
export function readFrameCheckpointOutputAppend(value: unknown): FrameCheckpointOutputAppend {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "entries"], [], "Frame/checkpoint output append");
  if (root.schema !== FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA) throw new Error(`Frame/checkpoint output append.schema must equal ${FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA}.`);
  const entries = exactArray(root.entries, "Frame/checkpoint output append.entries", FRAME_CHECKPOINT_MANIFEST_LIMITS.maxOutputHashes, 1).map((value, index) => {
    const label = `Frame/checkpoint output append.entries[${index}]`;
    const entry = exactRecord(value, ["frameIndex", "sha256"], [], label);
    return freeze({ frameIndex: integer(entry.frameIndex, `${label}.frameIndex`, 0, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxTotalFrames - 1), sha256: sha256(entry.sha256, `${label}.sha256`) });
  });
  if (entries.some((entry, index) => index > 0 && entry.frameIndex !== entries[index - 1]!.frameIndex + 1)) throw new Error("Frame/checkpoint output append entries must be contiguous and ascending.");
  return freeze({ schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: freeze(entries) });
}

export function frameTimeUs(frameIndex: number, rate: FrameCheckpointManifestRequest["rate"]): number {
  const value = BigInt(frameIndex) * BigInt(rate.denominator) * 1_000_000n / BigInt(rate.numerator);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Frame/checkpoint rational time exceeds safe-integer microseconds.");
  return result;
}

export function frameIndexAtUs(atUs: number, rate: FrameCheckpointManifestRequest["rate"], totalFrameCount: number): number {
  const value = BigInt(atUs) * BigInt(rate.numerator) / (BigInt(rate.denominator) * 1_000_000n);
  return Math.min(totalFrameCount - 1, Number(value));
}

function readRate(value: unknown): FrameCheckpointManifestRequest["rate"] {
  const record = exactRecord(value, ["numerator", "denominator"], [], "Frame/checkpoint manifest request.rate");
  const numerator = integer(record.numerator, "Frame/checkpoint manifest request.rate.numerator", 1, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxRateNumerator);
  const denominator = integer(record.denominator, "Frame/checkpoint manifest request.rate.denominator", 1, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxRateDenominator);
  if (numerator < denominator || numerator > denominator * FRAME_CHECKPOINT_MANIFEST_LIMITS.maxFramesPerSecond) throw new Error("Frame/checkpoint manifest rate must be in 1..240 frames per second.");
  if (gcd(numerator, denominator) !== 1) throw new Error("Frame/checkpoint manifest rate must be a reduced rational.");
  return freeze({ numerator, denominator });
}

function readFrameRange(value: unknown, totalFrameCount: number): FrameCheckpointManifestRequest["frameRange"] {
  const record = exactRecord(value, ["startFrameIndex", "frameCount"], [], "Frame/checkpoint manifest request.frameRange");
  const startFrameIndex = integer(record.startFrameIndex, "Frame/checkpoint manifest request.frameRange.startFrameIndex", 0, totalFrameCount - 1);
  const frameCount = integer(record.frameCount, "Frame/checkpoint manifest request.frameRange.frameCount", 1, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxWindowFrames);
  if (startFrameIndex + frameCount > totalFrameCount) throw new Error("Frame/checkpoint manifest frame range exceeds totalFrameCount.");
  return freeze({ startFrameIndex, frameCount });
}

function readInputs(value: unknown): FrameCheckpointManifestRequest["inputs"] {
  const inputs = exactArray(value, "Frame/checkpoint manifest request.inputs", FRAME_CHECKPOINT_MANIFEST_LIMITS.maxInputs, 1).map((value, index) => {
    const label = `Frame/checkpoint manifest request.inputs[${index}]`, record = exactRecord(value, ["inputId", "sha256"], [], label);
    return freeze({ inputId: safeId(record.inputId, `${label}.inputId`), sha256: sha256(record.sha256, `${label}.sha256`) });
  });
  strictIds(inputs.map((input) => input.inputId), "Frame/checkpoint manifest input ids");
  return freeze(inputs);
}

function readCheckpoints(value: unknown, maximumAtUs: number): FrameCheckpointManifestRequest["checkpoints"] {
  const checkpoints = exactArray(value, "Frame/checkpoint manifest request.checkpoints", FRAME_CHECKPOINT_MANIFEST_LIMITS.maxCheckpoints, 1).map((value, index) => {
    const label = `Frame/checkpoint manifest request.checkpoints[${index}]`, record = exactRecord(value, ["checkpointId", "atUs", "sha256"], [], label);
    const rawAtUs = safeUs(record.atUs, `${label}.atUs`), atUs = Object.is(rawAtUs, -0) ? 0 : rawAtUs;
    if (atUs > maximumAtUs) throw new Error(`${label}.atUs exceeds the final scheduled frame time.`);
    return freeze({ checkpointId: safeId(record.checkpointId, `${label}.checkpointId`), atUs, sha256: sha256(record.sha256, `${label}.sha256`) });
  });
  if (checkpoints[0]!.atUs !== 0) throw new Error("Frame/checkpoint manifest checkpoints must begin at zero microseconds.");
  if (new Set(checkpoints.map((checkpoint) => checkpoint.checkpointId)).size !== checkpoints.length) throw new Error("Frame/checkpoint manifest checkpoint ids must be unique.");
  if (checkpoints.some((checkpoint, index) => index > 0 && compareCheckpoint(checkpoints[index - 1]!, checkpoint) >= 0)) throw new Error("Frame/checkpoint manifest checkpoints must be ordered by atUs then checkpointId.");
  return freeze(checkpoints);
}

function compareCheckpoint(left: { atUs: number; checkpointId: string }, right: { atUs: number; checkpointId: string }): number {
  return left.atUs === right.atUs ? compareCodeUnits(left.checkpointId, right.checkpointId) : left.atUs - right.atUs;
}
function gcd(left: number, right: number): number { while (right !== 0) [left, right] = [right, left % right]; return left; }
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}
