import { canonicalJsonSha256 } from "./canonical-json";
import { requireMotionScene3DAnimationPlanAuthority } from "./motion-scene3d-animation-authority";
import { interpolateGradientColorSegment, resolveEasing } from "./timeline";
import {
  MAX_MOTION_SCENE3D_ANIMATION_TIME_US,
  MOTION_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA,
  motionScene3DAnimationNumericBounds,
  type MotionScene3DAnimationFramePlan,
  type MotionScene3DAnimationFramePlanResult,
  type MotionScene3DAnimationPlan,
  type MotionScene3DAnimationPlanTrack,
  type MotionScene3DAnimationValue,
} from "./motion-scene3d-animation-types";

/** Exact-time sampling for a compiler-minted plan. Renderer joins remain opt-in wrappers. */
export function evaluateMotionScene3DAnimationPlan(plan: MotionScene3DAnimationPlan, atUs: number): MotionScene3DAnimationFramePlanResult {
  try {
    const minted = requireMotionScene3DAnimationPlanAuthority(plan);
    if (!Number.isSafeInteger(atUs) || atUs < 0 || atUs > MAX_MOTION_SCENE3D_ANIMATION_TIME_US) throw new Error(`Scene3d animation atUs must be a safe integer in 0..${MAX_MOTION_SCENE3D_ANIMATION_TIME_US} microseconds.`);
    if (minted.plan.schema !== "shellx-motion/private-scene3d-animation-plan@1") throw new Error("Scene3d animation evaluation requires the current compiler plan schema.");
    const samples = minted.plan.tracks.map((track) => Object.freeze({ id: track.id, locator: Object.freeze({ ...track.locator }), value: sampleTrack(track, atUs), sourceSha256: track.sourceSha256 }));
    validateCombinedCameras(minted.authority.cameras, samples);
    const activeTrackCount = minted.plan.tracks.filter((track) => atUs >= track.keyframes[0]!.atUs).length;
    const payload = { schema: MOTION_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA, staticFingerprint: minted.plan.fingerprint, atUs, samples: Object.freeze(samples), budget: Object.freeze({ activeTrackCount, frameWorkUnits: minted.plan.budget.frameWorkUnits }) };
    return { ok: true, plan: deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Scene3d animation evaluation refused." };
  }
}

function validateCombinedCameras(cameras: readonly { layerId: string; position: readonly number[]; target: readonly number[] }[], samples: readonly { locator: MotionScene3DAnimationPlanTrack["locator"]; value: MotionScene3DAnimationValue }[]): void {
  const resolved = new Map(cameras.map((camera) => [camera.layerId, { position: [...camera.position], target: [...camera.target] }]));
  for (const sample of samples) {
    if (sample.locator.scope !== "camera" || (sample.locator.property !== "position" && sample.locator.property !== "target")) continue;
    const camera = resolved.get(sample.locator.layerId);
    if (!camera) throw new Error(`Scene3d animation sample targets an unknown compiler-minted camera ${sample.locator.layerId}.`);
    camera[sample.locator.property] = [...sample.value as number[]];
  }
  for (const [layerId, camera] of resolved) {
    const view = camera.position.map((entry, index) => entry - camera.target[index]!);
    if (Math.hypot(...view) < 0.000_001 || Math.hypot(view[0]!, view[2]!) < 0.000_001) throw new Error(`Scene3d animation layer ${layerId} evaluated to an invalid camera position/target view.`);
  }
}

function sampleTrack(track: MotionScene3DAnimationPlanTrack, atUs: number): MotionScene3DAnimationValue {
  const first = track.keyframes[0]!, last = track.keyframes.at(-1)!;
  if (atUs < first.atUs) return cloneValue(track.baseValue);
  if (atUs >= last.atUs) return cloneValue(last.value);
  for (let index = 0; index < track.keyframes.length - 1; index += 1) {
    const left = track.keyframes[index]!, right = track.keyframes[index + 1]!;
    if (atUs < left.atUs || atUs > right.atUs) continue;
    const progress = resolveEasing(left.easing)((atUs - left.atUs) / (right.atUs - left.atUs));
    if (!Number.isFinite(progress)) throw new Error(`Scene3d animation track ${track.id} easing produced a non-finite value.`);
    return validateSample(track, interpolate(track, left.value, right.value, progress));
  }
  throw new Error(`Scene3d animation track ${track.id} has no active segment.`);
}

function interpolate(track: MotionScene3DAnimationPlanTrack, left: MotionScene3DAnimationValue, right: MotionScene3DAnimationValue, progress: number): MotionScene3DAnimationValue {
  if (track.kind === "number") return Number(left) + ((Number(right) - Number(left)) * progress);
  if (track.kind === "vec3") {
    const first = left as number[], second = right as number[];
    return Object.freeze(first.map((entry, index) => entry + ((second[index]! - entry) * progress))) as unknown as MotionScene3DAnimationValue;
  }
  const color = interpolateGradientColorSegment(String(left), String(right), progress);
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Scene3d animation track ${track.id} could not produce an opaque scene3d color.`);
  return color;
}

function validateSample(track: MotionScene3DAnimationPlanTrack, value: MotionScene3DAnimationValue): MotionScene3DAnimationValue {
  if (track.kind === "color") return value;
  const bounds = motionScene3DAnimationNumericBounds(track.locator);
  if (!bounds) throw new Error(`Scene3d animation track ${track.id} has no numeric bounds.`);
  const entries = track.kind === "number" ? [value] : value as number[];
  if (entries.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < bounds[0] || entry > bounds[1])) throw new Error(`Scene3d animation track ${track.id} evaluated outside its existing scene3d bounds.`);
  if (track.locator.scope === "lighting" && track.locator.property === "direction" && entries.every((entry) => entry === 0)) throw new Error(`Scene3d animation track ${track.id} evaluated to the zero lighting direction.`);
  return cloneValue(value);
}

function cloneValue(value: MotionScene3DAnimationValue): MotionScene3DAnimationValue { return Array.isArray(value) ? Object.freeze([...value]) as unknown as MotionScene3DAnimationValue : value; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); if (!Object.isFrozen(value)) Object.freeze(value); } return value; }
