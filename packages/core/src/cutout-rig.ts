import {
  decomposeMotionSimilarityMatrix,
  motionAffineMatrix,
  multiplyMotionAffineMatrices,
  type MotionAffineMatrix,
  type MotionSimilarityTransform
} from "./motion-transform-matrix";
import {
  assertCutoutRigSource,
  staticCutoutRigSourceTransform,
  type CutoutRigSourceIdentity,
  type CutoutRigSourceStaticTransform
} from "./cutout-rig-source";
import { streamingFrameTimestampMs } from "./streaming-frame-quality";
import { resolveEasing } from "./timeline";
import type { MotionDocument, MotionLayer } from "./types";
import {
  parseCutoutRig,
  type CutoutRigNode,
  type CutoutRigPose
} from "./cutout-rig-schema";

export { parseCutoutRig, type CutoutRig, type CutoutRigNode, type CutoutRigPose } from "./cutout-rig-schema";
export {
  assertCutoutRigSource,
  staticCutoutRigSourceTransform,
  type CutoutRigSourceIdentity,
  type CutoutRigSourceStaticTransform
} from "./cutout-rig-source";

const MAX_DEPTH = 8;
const MAX_SAMPLES = 256;
const MAX_OUTPUT_KEYFRAMES = 16_384;
const MIN_SCALE = 0.001;
const MAX_SCALE = 100;

export interface CutoutRigBakeResult {
  motion: MotionDocument;
  changedPaths: string[];
  sourceStaticTransform: CutoutRigSourceStaticTransform;
  outputLayerIds: string[];
  cadence: {
    sampleEveryFrames: number;
    observedFrameCount: number;
    bakedSampleCount: number;
    firstSampleMs: number;
    lastSampleMs: number;
    activeWindow: { startMs: number; endMsExclusive: number };
    approximation: "ordinary linear transform tracks between sampled renderer frames";
  };
}


/**
 * Replace one simple static PNG image layer with ordinary cropped image layers and transform tracks.
 * Crop values and origins are image pixels; each pose x/y is the cropped child box's top-left in
 * its parent's untransformed crop-local pixel space. The virtual root is the source PNG itself.
 */
export function bakeCutoutRig(
  document: MotionDocument,
  sourceLayerId: string,
  rigInput: unknown,
  sourceIdentity: CutoutRigSourceIdentity
): CutoutRigBakeResult {
  const rig = parseCutoutRig(rigInput);
  const source = assertCutoutRigSource(document, sourceLayerId, sourceIdentity);
  const sourceIndex = document.layers.indexOf(source);
  const existingIds = new Set(document.layers.map((layer) => layer.id));
  for (const node of rig.nodes) {
    if (existingIds.has(node.layerId)) throw new Error(`Cutout rig output layerId ${node.layerId} already exists.`);
    assertCropInsideSource(node.crop, sourceIdentity, node.layerId);
    assertPoseWindow(node, source);
  }
  const topological = topologicalNodes(rig.nodes);
  const sampling = sampleObservableFrameTimes(document, source, rig.sampleEveryFrames, rig.nodes.length);
  const sourceStaticTransform = staticCutoutRigSourceTransform(source, sourceIdentity);
  const samples = sampleNodeTransforms(topological, sampling.sampleTimes, sourceStaticTransform);
  const outputLayers = [...rig.nodes]
    .sort((left, right) => left.stackIndex - right.stackIndex)
    .map((node) => outputLayer(source, sourceIdentity.assetRef, node, samples.get(node.layerId)!));
  const layers = [...document.layers.slice(0, sourceIndex), ...outputLayers, ...document.layers.slice(sourceIndex + 1)];
  const outputLayerIds = outputLayers.map((layer) => layer.id);
  return {
    motion: {
      ...document,
      layers,
      ...(document.tracks ? { tracks: replaceTrackedLayer(document.tracks, sourceLayerId, outputLayerIds) } : {})
    },
    changedPaths: ["/layers", ...(document.tracks ? ["/tracks"] : [])],
    sourceStaticTransform,
    outputLayerIds,
    cadence: {
      sampleEveryFrames: rig.sampleEveryFrames,
      observedFrameCount: sampling.observedFrameCount,
      bakedSampleCount: sampling.sampleTimes.length,
      firstSampleMs: sampling.sampleTimes[0],
      lastSampleMs: sampling.sampleTimes[sampling.sampleTimes.length - 1],
      activeWindow: { startMs: source.startMs, endMsExclusive: source.startMs + source.durationMs },
      approximation: "ordinary linear transform tracks between sampled renderer frames"
    }
  };
}

function assertCropInsideSource(crop: CutoutRigNode["crop"], source: CutoutRigSourceIdentity, layerId: string): void {
  if (crop.x + crop.width > source.width || crop.y + crop.height > source.height) {
    throw new Error(`Cutout rig crop for ${layerId} must fit inside the source PNG.`);
  }
}

function assertPoseWindow(node: CutoutRigNode, source: MotionLayer): void {
  const endMs = source.startMs + source.durationMs;
  for (const pose of node.poses) {
    if (pose.atMs < source.startMs || pose.atMs >= endMs) {
      throw new Error(`Cutout rig pose ${node.layerId}@${pose.atMs}ms must be inside the source active interval [${source.startMs}, ${endMs}).`);
    }
  }
}

function topologicalNodes(nodes: CutoutRigNode[]): CutoutRigNode[] {
  const byId = new Map(nodes.map((node) => [node.layerId, node]));
  const result: CutoutRigNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: CutoutRigNode, depth: number): void => {
    if (visited.has(node.layerId)) return;
    if (visiting.has(node.layerId)) throw new Error("Cutout rig parent graph contains a cycle.");
    if (depth > MAX_DEPTH) throw new Error(`Cutout rig parent graph exceeds depth ${MAX_DEPTH}.`);
    visiting.add(node.layerId);
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (!parent) throw new Error(`Cutout rig node ${node.layerId} names an unknown parentId ${node.parentId}.`);
      visit(parent, depth + 1);
    }
    visiting.delete(node.layerId);
    visited.add(node.layerId);
    result.push(node);
  };
  // Do not let host locale settings change an otherwise data-only bake. Stack order is
  // separately explicit; this order exists only to make independent root traversals stable.
  for (const node of [...nodes].sort(compareLayerId)) visit(node, 1);
  return result;
}

function compareLayerId(left: CutoutRigNode, right: CutoutRigNode): number {
  return left.layerId < right.layerId ? -1 : left.layerId > right.layerId ? 1 : 0;
}

function sampleObservableFrameTimes(
  document: MotionDocument,
  source: MotionLayer,
  sampleEveryFrames: number,
  nodeCount: number
): { observedFrameCount: number; sampleTimes: number[] } {
  // Renderer activation is half-open. An endMs key can be structurally legal but has no painted
  // frame, so only real streamed timestamps in [startMs, endMs) enter the bake. Keep only bounded
  // selected timestamps; observed frame count is scalar evidence, never hidden history.
  const frameCount = Math.max(1, Math.ceil((document.durationMs * document.fps) / 1000));
  const endMs = source.startMs + source.durationMs;
  const maxSamples = Math.min(MAX_SAMPLES, Math.floor(MAX_OUTPUT_KEYFRAMES / (nodeCount * 4)));
  const sampleTimes: number[] = [];
  let observedFrameCount = 0;
  let lastObserved: number | null = null;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const atMs = streamingFrameTimestampMs(frame, document.fps, document.durationMs);
    if (atMs < source.startMs || atMs >= endMs || lastObserved === atMs) continue;
    lastObserved = atMs;
    if (observedFrameCount % sampleEveryFrames === 0) {
      if (sampleTimes.length >= maxSamples) throw sampleBudgetError(maxSamples);
      sampleTimes.push(atMs);
    }
    observedFrameCount += 1;
  }
  if (lastObserved === null) throw new Error("Cutout rig source has no renderer-observable active frame.");
  if (sampleTimes[sampleTimes.length - 1] !== lastObserved) {
    if (sampleTimes.length >= maxSamples) throw sampleBudgetError(maxSamples);
    sampleTimes.push(lastObserved);
  }
  return { observedFrameCount, sampleTimes };
}

function sampleBudgetError(maxSamples: number): Error {
  return new Error(`Cutout rig exceeds its ${maxSamples}-sample or ${MAX_OUTPUT_KEYFRAMES}-keyframe budget.`);
}

function sampleNodeTransforms(
  topological: CutoutRigNode[],
  sampleTimes: number[],
  source: CutoutRigSourceStaticTransform
): Map<string, Array<{ atMs: number; transform: MotionSimilarityTransform }>> {
  const output = new Map(topological.map((node) => [node.layerId, [] as Array<{ atMs: number; transform: MotionSimilarityTransform }> ]));
  const sourceMatrix = motionAffineMatrix({
    x: source.x, y: source.y, originX: source.originX, originY: source.originY,
    scaleX: source.scale, scaleY: source.scale, rotation: source.rotation
  });
  for (const atMs of sampleTimes) {
    const world = new Map<string, MotionAffineMatrix>();
    for (const node of topological) {
      const pose = poseAt(node.poses, atMs);
      const local = motionAffineMatrix({
        x: pose.x, y: pose.y, originX: node.origin.x, originY: node.origin.y,
        scaleX: pose.scale, scaleY: pose.scale, rotation: pose.rotation
      });
      const parentMatrix = node.parentId ? world.get(node.parentId) : sourceMatrix;
      if (!parentMatrix) throw new Error(`Cutout rig parent ${node.parentId} was not resolved before ${node.layerId}.`);
      const transform = decomposeMotionSimilarityMatrix(multiplyMotionAffineMatrices(parentMatrix, local), node.origin);
      if (!transform || transform.scale < MIN_SCALE || transform.scale > MAX_SCALE) {
        throw new Error(`Cutout rig ${node.layerId}@${atMs}ms produces a non-decomposable, reflected, skewed, or out-of-range transform.`);
      }
      world.set(node.layerId, motionAffineMatrix({
        x: transform.x, y: transform.y, originX: node.origin.x, originY: node.origin.y,
        scaleX: transform.scale, scaleY: transform.scale, rotation: transform.rotation
      }));
      output.get(node.layerId)!.push({ atMs, transform });
    }
  }
  for (const entries of output.values()) unwrapRotations(entries);
  return output;
}

/** Poses clamp to the first value before its first key and the last value after its final key. */
function poseAt(poses: CutoutRigPose[], atMs: number): CutoutRigPose {
  if (atMs <= poses[0].atMs) return poses[0];
  const last = poses[poses.length - 1];
  if (atMs >= last.atMs) return last;
  for (let index = 0; index < poses.length - 1; index += 1) {
    const left = poses[index];
    const right = poses[index + 1];
    if (atMs < left.atMs || atMs > right.atMs) continue;
    const progress = resolveEasing(left.easing)((atMs - left.atMs) / (right.atMs - left.atMs));
    return {
      atMs,
      x: interpolate(left.x, right.x, progress),
      y: interpolate(left.y, right.y, progress),
      scale: interpolate(left.scale, right.scale, progress),
      rotation: interpolate(left.rotation, right.rotation, progress)
    };
  }
  return last;
}

function unwrapRotations(entries: Array<{ atMs: number; transform: MotionSimilarityTransform }>): void {
  for (let index = 1; index < entries.length; index += 1) {
    const prior = entries[index - 1].transform.rotation;
    let next = entries[index].transform.rotation;
    while (next - prior > 180) next -= 360;
    while (next - prior <= -180) next += 360;
    entries[index].transform.rotation = next;
  }
}

function outputLayer(
  source: MotionLayer,
  assetRef: string,
  node: CutoutRigNode,
  samples: Array<{ atMs: number; transform: MotionSimilarityTransform }>
): MotionLayer {
  const first = samples[0].transform;
  return {
    id: node.layerId,
    name: `Cutout ${node.layerId}`,
    type: "image",
    assetRef,
    startMs: source.startMs,
    durationMs: source.durationMs,
    ...(source.trackId !== undefined ? { trackId: source.trackId } : {}),
    fit: "fill",
    crop: { ...node.crop },
    transform: {
      x: first.x, y: first.y, width: node.crop.width, height: node.crop.height,
      scale: first.scale, rotation: first.rotation, originX: node.origin.x, originY: node.origin.y
    },
    keyframes: {
      "transform.x": samples.map((entry) => ({ atMs: entry.atMs, value: entry.transform.x })),
      "transform.y": samples.map((entry) => ({ atMs: entry.atMs, value: entry.transform.y })),
      "transform.scale": samples.map((entry) => ({ atMs: entry.atMs, value: entry.transform.scale })),
      "transform.rotation": samples.map((entry) => ({ atMs: entry.atMs, value: entry.transform.rotation }))
    }
  };
}

function replaceTrackedLayer(
  tracks: MotionDocument["tracks"], sourceLayerId: string, outputLayerIds: string[]
): MotionDocument["tracks"] {
  if (!tracks) return undefined;
  return tracks.map((track) => !track.layerIds?.includes(sourceLayerId)
    ? { ...track }
    : { ...track, layerIds: track.layerIds.flatMap((layerId) => layerId === sourceLayerId ? outputLayerIds : [layerId]) });
}


function interpolate(left: number, right: number, progress: number): number {
  return left + ((right - left) * Math.max(0, Math.min(1, progress)));
}
