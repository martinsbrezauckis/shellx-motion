import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { exactArray, exactRecord, freeze, sha256, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import { frameIndexAtUs, frameTimeUs, readFrameCheckpointManifestRequest, readFrameCheckpointOutputAppend } from "./checkpoint-storyboard-frame-manifest-read";
import {
  FRAME_CHECKPOINT_EVALUATOR_VERSION,
  FRAME_CHECKPOINT_MANIFEST_LIMITS,
  FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA,
  FRAME_CHECKPOINT_MANIFEST_SCHEMA,
  type FrameCheckpointManifest,
  type FrameCheckpointManifestRequest,
} from "./checkpoint-storyboard-frame-manifest-types";

/** Compile one bounded, renderer-neutral deterministic frame/checkpoint manifest window. */
export function createFrameCheckpointManifest(value: unknown): FrameCheckpointManifest {
  return build(readFrameCheckpointManifestRequest(value), [], 1);
}

/** Append one exact contiguous output-hash range and return a new immutable manifest revision. */
export function appendFrameCheckpointOutputHashes(manifestValue: unknown, appendValue: unknown): FrameCheckpointManifest {
  const parent = readFrameCheckpointManifest(manifestValue);
  const append = readFrameCheckpointOutputAppend(appendValue);
  if (parent.resume.windowComplete || parent.resume.nextFrameIndex === null) throw new Error("Frame/checkpoint manifest window is already complete.");
  if (append.entries[0]!.frameIndex !== parent.resume.nextFrameIndex) throw new Error("Frame/checkpoint output append must begin at the exact next resumable frame index.");
  const entries = [...parent.outputHashRange.entries, ...append.entries];
  if (entries.length > parent.frameRange.frameCount || entries.length > FRAME_CHECKPOINT_MANIFEST_LIMITS.maxOutputHashes) throw new Error("Frame/checkpoint output append exceeds the bounded manifest window.");
  const request = requestFromManifest(parent);
  return build(request, entries, parent.revision + 1, parent.fingerprint);
}

/** Re-admit and rederive every redundant fact and fingerprint from untrusted manifest data. */
export function readFrameCheckpointManifest(value: unknown): FrameCheckpointManifest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "evaluatorVersion", "seed", "rate", "totalFrameCount", "frameRange", "inputs", "inputsSha256", "checkpoints", "frames", "outputHashRange", "resume", "requestSha256", "revision", "evidence", "fingerprint"], ["parentFingerprint"], "Frame/checkpoint manifest");
  if (root.schema !== FRAME_CHECKPOINT_MANIFEST_SCHEMA) throw new Error(`Frame/checkpoint manifest.schema must equal ${FRAME_CHECKPOINT_MANIFEST_SCHEMA}.`);
  const checkpoints = exactArray(root.checkpoints, "Frame/checkpoint manifest.checkpoints", FRAME_CHECKPOINT_MANIFEST_LIMITS.maxCheckpoints, 1).map((value, index) => {
    const label = `Frame/checkpoint manifest.checkpoints[${index}]`, record = exactRecord(value, ["checkpointId", "atUs", "sha256", "frameIndex", "frameAtUs", "offsetUs"], [], label);
    return { checkpointId: record.checkpointId, atUs: record.atUs, sha256: record.sha256 };
  });
  const request = readFrameCheckpointManifestRequest({ schema: FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA, evaluatorVersion: root.evaluatorVersion, seed: root.seed, rate: root.rate, totalFrameCount: root.totalFrameCount, frameRange: root.frameRange, inputs: root.inputs, checkpoints });
  const output = readOutputRange(root.outputHashRange);
  const revision = integer(root.revision, "Frame/checkpoint manifest.revision", 1, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxOutputHashes + 1);
  const parentFingerprint = root.parentFingerprint === undefined ? undefined : sha256(root.parentFingerprint, "Frame/checkpoint manifest.parentFingerprint");
  if ((revision === 1) !== (parentFingerprint === undefined)) throw new Error("Frame/checkpoint manifest parentFingerprint must exist exactly after revision one.");
  const expected = build(request, output, revision, parentFingerprint);
  if (canonicalJson(root) !== canonicalJson(expected)) throw new Error("Frame/checkpoint manifest derived facts or fingerprint are stale.");
  return expected;
}

function build(request: FrameCheckpointManifestRequest, entries: readonly { readonly frameIndex: number; readonly sha256: string }[], revision: number, parentFingerprint?: string): FrameCheckpointManifest {
  if (entries.length > request.frameRange.frameCount || entries.length > FRAME_CHECKPOINT_MANIFEST_LIMITS.maxOutputHashes || entries.some((entry, index) => entry.frameIndex !== request.frameRange.startFrameIndex + index)) throw new Error("Frame/checkpoint output hashes must be one contiguous prefix of the bounded manifest window.");
  if ((revision === 1 && (entries.length !== 0 || parentFingerprint !== undefined)) || (revision > 1 && (!parentFingerprint || revision > entries.length + 1))) throw new Error("Frame/checkpoint manifest revision lineage does not match its output-hash history.");
  const checkpoints = request.checkpoints.map((checkpoint) => {
    const frameIndex = frameIndexAtUs(checkpoint.atUs, request.rate, request.totalFrameCount), frameAtUs = frameTimeUs(frameIndex, request.rate);
    return freeze({ ...checkpoint, frameIndex, frameAtUs, offsetUs: checkpoint.atUs - frameAtUs });
  });
  const checkpointIds = new Map<number, string[]>();
  for (const checkpoint of checkpoints) {
    const ids = checkpointIds.get(checkpoint.frameIndex) ?? [];
    ids.push(checkpoint.checkpointId); checkpointIds.set(checkpoint.frameIndex, ids);
  }
  const frames = Array.from({ length: request.frameRange.frameCount }, (_entry, offset) => {
    const frameIndex = request.frameRange.startFrameIndex + offset;
    return freeze({ frameIndex, atUs: frameTimeUs(frameIndex, request.rate), checkpointIds: freeze(checkpointIds.get(frameIndex) ?? []) });
  });
  const completedFrameCount = entries.length, windowComplete = completedFrameCount === request.frameRange.frameCount;
  const payload = {
    schema: FRAME_CHECKPOINT_MANIFEST_SCHEMA,
    evaluatorVersion: FRAME_CHECKPOINT_EVALUATOR_VERSION,
    seed: request.seed,
    rate: request.rate,
    totalFrameCount: request.totalFrameCount,
    frameRange: request.frameRange,
    inputs: request.inputs,
    inputsSha256: canonicalJsonSha256({ inputs: request.inputs }),
    checkpoints: freeze(checkpoints),
    frames: freeze(frames),
    outputHashRange: freeze({ startFrameIndex: request.frameRange.startFrameIndex, entries: freeze(entries.map((entry) => freeze({ ...entry }))) }),
    resume: freeze({ completedFrameCount, nextFrameIndex: windowComplete ? null : request.frameRange.startFrameIndex + completedFrameCount, windowComplete }),
    requestSha256: canonicalJsonSha256(request),
    revision,
    ...(parentFingerprint ? { parentFingerprint } : {}),
    evidence: freeze({
      timeMapping: "floor-rational-frame-time-to-microseconds" as const,
      reducedRationalRate: true as const,
      exactInputHashes: true as const,
      contiguousOutputHashRange: true as const,
      noIO: true as const,
      noStore: true as const,
      noRenderer: true as const,
      noFinalMedia: true as const,
      noPublicCoreRoot: true as const,
    }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function requestFromManifest(manifest: FrameCheckpointManifest): FrameCheckpointManifestRequest {
  return readFrameCheckpointManifestRequest({
    schema: FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA,
    evaluatorVersion: manifest.evaluatorVersion,
    seed: manifest.seed,
    rate: manifest.rate,
    totalFrameCount: manifest.totalFrameCount,
    frameRange: manifest.frameRange,
    inputs: manifest.inputs,
    checkpoints: manifest.checkpoints.map(({ checkpointId, atUs, sha256 }) => ({ checkpointId, atUs, sha256 })),
  });
}

function readOutputRange(value: unknown): readonly { readonly frameIndex: number; readonly sha256: string }[] {
  const range = exactRecord(value, ["startFrameIndex", "entries"], [], "Frame/checkpoint manifest.outputHashRange");
  integer(range.startFrameIndex, "Frame/checkpoint manifest.outputHashRange.startFrameIndex", 0, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxTotalFrames - 1);
  return freeze(exactArray(range.entries, "Frame/checkpoint manifest.outputHashRange.entries", FRAME_CHECKPOINT_MANIFEST_LIMITS.maxOutputHashes).map((value, index) => {
    const label = `Frame/checkpoint manifest.outputHashRange.entries[${index}]`, record = exactRecord(value, ["frameIndex", "sha256"], [], label);
    return freeze({ frameIndex: integer(record.frameIndex, `${label}.frameIndex`, 0, FRAME_CHECKPOINT_MANIFEST_LIMITS.maxTotalFrames - 1), sha256: sha256(record.sha256, `${label}.sha256`) });
  }));
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}
