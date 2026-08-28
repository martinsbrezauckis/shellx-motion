import { canonicalJsonSha256 } from "../../canonical-json";
import { evaluateMotionBeatTiming } from "../beat-timing/motion-beat-timing";
import { snapshotMotionBehaviorData } from "../../motion-behavior-read";
import { MAX_MOTION_BEHAVIOR_DURATION_US } from "../../motion-behavior-types";

export interface MotionBehaviorPhysicalTiming { startUs: number; durationUs: number; sourceSha256: string }

/**
 * Reviewed pre-adoption seam: converts an optional authoring-only beat request once. The returned
 * object is the complete
 * persistent representation: beat positions, tempo segments, and rounding inputs never enter
 * behaviors@1 or its static/frame identities.
 */
export function resolveMotionBehaviorTiming(value: unknown): MotionBehaviorPhysicalTiming {
  const record = exactRecord(snapshotMotionBehaviorData(value), ["startUs", "durationUs", "beat"], "Motion behavior timing");
  const physical = Object.hasOwn(record, "startUs") || Object.hasOwn(record, "durationUs");
  const beat = Object.hasOwn(record, "beat");
  if (physical === beat) throw new Error("Motion behavior timing requires exactly physical startUs/durationUs or one beat request.");
  if (physical) {
    if (!Object.hasOwn(record, "startUs") || !Object.hasOwn(record, "durationUs")) throw new Error("Motion behavior timing physical request requires startUs and durationUs.");
    const startUs = safeUs(record.startUs, "Motion behavior timing startUs"), durationUs = duration(record.durationUs);
    return Object.freeze({ startUs, durationUs, sourceSha256: canonicalJsonSha256({ startUs, durationUs }) });
  }
  const request = exactRecord(record.beat, ["startTick", "durationTicks", "ticksPerBeat", "tempoSegments"], "Motion behavior timing beat");
  const startTick = tick(request.startTick, "Motion behavior timing beat.startTick"), durationTicks = tick(request.durationTicks, "Motion behavior timing beat.durationTicks");
  if (durationTicks === 0 || !Number.isSafeInteger(startTick + durationTicks)) throw new Error("Motion behavior timing beat durationTicks must be positive without overflow.");
  const common = { schema: "shellx-motion/beat-timing@1", ticksPerBeat: request.ticksPerBeat, tempoSegments: request.tempoSegments };
  const start = evaluateMotionBeatTiming({ ...common, atTick: startTick });
  const end = evaluateMotionBeatTiming({ ...common, atTick: startTick + durationTicks });
  if (!start.ok) throw new Error(`Motion behavior timing beat request refused: ${start.message}`);
  if (!end.ok) throw new Error(`Motion behavior timing beat request refused: ${end.message}`);
  const startUs = start.evaluation.atUs, durationUs = duration(end.evaluation.atUs - startUs);
  return Object.freeze({ startUs, durationUs, sourceSha256: canonicalJsonSha256({ startUs, durationUs }) });
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const record = value as Record<string, unknown>, unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  return record;
}
function safeUs(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`); return value; }
function tick(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer tick.`); return value; }
function duration(value: unknown): number { const result = safeUs(value, "Motion behavior timing durationUs"); if (result === 0 || result > MAX_MOTION_BEHAVIOR_DURATION_US) throw new Error(`Motion behavior timing durationUs must be in 1..${MAX_MOTION_BEHAVIOR_DURATION_US}.`); return result; }
