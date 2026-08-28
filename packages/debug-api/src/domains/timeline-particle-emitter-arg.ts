/** Preserve a typed particle emitter for Core's single validation authority. */
import type { MotionParticleEmitter } from "@shellx-motion/core";
import { objectArg } from "./args.js";

export function timelineParticleEmitterArg(value: unknown): MotionParticleEmitter | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const seed = optionalFiniteNumber(record, "seed");
  const count = optionalFiniteNumber(record, "count");
  const lifetimeMs = optionalFiniteNumber(record, "lifetimeMs");
  const color = optionalString(record, "color");
  if (seed === false || count === false || lifetimeMs === false || color === false || seed === null || count === null || lifetimeMs === null || color === null) return false;
  if (record.field !== undefined && !objectArg(record.field)) return false;
  return { ...structuredClone(record), seed, count, lifetimeMs, color } as MotionParticleEmitter;
}

/** Shared scalar readers keep layer-create's parser split without changing admission rules. */
export function optionalFiniteNumber(record: Record<string, unknown>, key: string): number | false | null {
  if (!Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

export function optionalString(record: Record<string, unknown>, key: string): string | false | null {
  if (!Object.hasOwn(record, key)) return null;
  return typeof record[key] === "string" ? record[key] : false;
}
