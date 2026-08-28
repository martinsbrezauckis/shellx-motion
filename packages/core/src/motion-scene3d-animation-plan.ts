import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { mintMotionScene3DAnimationPlan } from "./motion-scene3d-animation-authority";
import { interpolateGradientColorSegment } from "./timeline";
import {
  MAX_MOTION_SCENE3D_ANIMATION_FRAME_WORK_UNITS,
  MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES,
  MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS,
  MAX_MOTION_SCENE3D_ANIMATION_TRACK_BYTES,
  MOTION_SCENE3D_ANIMATION_PLAN_SCHEMA,
  motionScene3DAnimationValueKind,
  type MotionScene3DAnimationDescriptor,
  type MotionScene3DAnimationLocator,
  type MotionScene3DAnimationPlan,
  type MotionScene3DAnimationPlanResult,
  type MotionScene3DAnimationPlanTrack,
  type MotionScene3DAnimationSource,
  type MotionScene3DAnimationValue,
} from "./motion-scene3d-animation-types";
import { readMotionScene3DAnimationRequest, readMotionScene3DAnimationSource } from "./motion-scene3d-animation-source";

/** Compiles immutable C5C1A scene authority only. It performs no document write, render, or package I/O. */
export function compileMotionScene3DAnimationPlan(value: unknown): MotionScene3DAnimationPlanResult {
  try {
    const request = readMotionScene3DAnimationRequest(value);
    const descriptorBudget = preflightDescriptor(request.animation);
    const admitted = readMotionScene3DAnimationSource(request.sourceValue);
    const tracks = request.animation.tracks.map((track) => compileTrack(track, admitted.source, admitted.sourceSha256));
    const payload = {
      schema: MOTION_SCENE3D_ANIMATION_PLAN_SCHEMA,
      sourceSha256: admitted.sourceSha256,
      tracks: Object.freeze(tracks),
      budget: Object.freeze({ sourceLayerCount: admitted.source.layers.length, sourceObjectCount: admitted.objectCount, ...descriptorBudget }),
      evidence: Object.freeze({ noRenderer: true as const, noPixelClaim: true as const, staticTopology: true as const }),
    };
    const plan = deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
    mintMotionScene3DAnimationPlan(plan, admitted.source);
    return { ok: true, plan };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Scene3d animation planning refused." };
  }
}

function preflightDescriptor(animation: MotionScene3DAnimationDescriptor): { trackCount: number; keyframeCount: number; inputBytes: number; planWorkUnits: number; frameWorkUnits: number } {
  const inputBytes = Buffer.byteLength(canonicalJson(animation), "utf8");
  if (inputBytes > MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES) throw new Error(`Scene3d animation descriptor exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES}-byte input limit.`);
  let keyframeCount = 0, planWorkUnits = 0, frameWorkUnits = 0;
  for (const track of animation.tracks) {
    const bytes = Buffer.byteLength(canonicalJson(track), "utf8");
    if (bytes > MAX_MOTION_SCENE3D_ANIMATION_TRACK_BYTES) throw new Error(`Scene3d animation track ${track.id} exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_TRACK_BYTES}-byte input limit.`);
    const channels = channelCount(motionScene3DAnimationValueKind(track.locator));
    keyframeCount += track.keyframes.length;
    planWorkUnits += track.keyframes.length * channels;
    frameWorkUnits += channels;
  }
  if (planWorkUnits > MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS) throw new Error(`Scene3d animation keyframe work exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS}-unit aggregate limit.`);
  if (frameWorkUnits > MAX_MOTION_SCENE3D_ANIMATION_FRAME_WORK_UNITS) throw new Error(`Scene3d animation frame work exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_FRAME_WORK_UNITS}-unit aggregate limit.`);
  return { trackCount: animation.tracks.length, keyframeCount, inputBytes, planWorkUnits, frameWorkUnits };
}

function compileTrack(track: MotionScene3DAnimationDescriptor["tracks"][number], source: MotionScene3DAnimationSource, sourceSha256: string): MotionScene3DAnimationPlanTrack {
  const layer = source.layers.find((candidate) => candidate.id === track.locator.layerId);
  if (!layer) throw new Error(`Scene3d animation track ${track.id} targets unknown scene layer ${track.locator.layerId}.`);
  const kind = motionScene3DAnimationValueKind(track.locator);
  const baseValue = canonicalizeValue(readBaseValue(layer.scene3d, track.locator, track.id), kind, track.id);
  return deepFreeze({ id: track.id, locator: { ...track.locator }, kind, baseValue, keyframes: track.keyframes.map((keyframe) => ({ atUs: keyframe.atUs, value: cloneValue(keyframe.value), ...(keyframe.easing === undefined ? {} : { easing: typeof keyframe.easing === "string" ? keyframe.easing : { ...keyframe.easing } }) })), sourceSha256 });
}

function readBaseValue(scene: MotionScene3DAnimationSource["layers"][number]["scene3d"], locator: MotionScene3DAnimationLocator, trackId: string): MotionScene3DAnimationValue {
  if (locator.scope === "camera") return cloneValue(scene.camera[locator.property]);
  if (locator.scope === "lighting") return cloneValue(scene.lighting[locator.property]);
  if (locator.scope === "background") return scene.backgroundColor;
  const object = scene.objects.find((candidate) => candidate.id === locator.objectId);
  if (!object) throw new Error(`Scene3d animation track ${trackId} targets unknown object ${locator.layerId}/${locator.objectId}.`);
  const value = object[locator.property];
  if (value === undefined) throw new Error(`Scene3d animation track ${trackId} requires an explicit existing object.${locator.property} base value.`);
  return cloneValue(value);
}

function cloneValue(value: MotionScene3DAnimationValue): MotionScene3DAnimationValue {
  return Array.isArray(value) ? Object.freeze([...value]) as unknown as MotionScene3DAnimationValue : value;
}

function canonicalizeValue(value: MotionScene3DAnimationValue, kind: ReturnType<typeof motionScene3DAnimationValueKind>, trackId: string): MotionScene3DAnimationValue {
  if (kind !== "color") return cloneValue(value);
  const color = interpolateGradientColorSegment(String(value), String(value), 0);
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Scene3d animation track ${trackId} base color could not be canonicalized.`);
  return color;
}

function channelCount(kind: ReturnType<typeof motionScene3DAnimationValueKind>): number { return kind === "vec3" ? 3 : kind === "color" ? 4 : 1; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); if (!Object.isFrozen(value)) Object.freeze(value); } return value; }
