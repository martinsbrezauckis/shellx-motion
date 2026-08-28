/** Exact data-only Debug intents for bounded particle-emitter structure, never scalar rich controls. */
import type { MotionParticleAnalyticTrail, MotionParticleEmitterOrigin, MotionParticleFieldV2Source, MotionParticleShading } from "@shellx-motion/core";
import { readStrictDataRecord } from "./timeline-strict-data.js";

export const TIMELINE_PARTICLE_STRUCTURAL_COMMANDS = {
  inspect: "motion.timeline.particles.structural.inspect",
  sourceInsert: "motion.timeline.particles.field.source.insert",
  sourceReplace: "motion.timeline.particles.field.source.replace",
  sourceMove: "motion.timeline.particles.field.source.move",
  sourceDelete: "motion.timeline.particles.field.source.delete",
  originInsert: "motion.timeline.particles.emitter.origin.insert",
  originReplace: "motion.timeline.particles.emitter.origin.replace",
  originMove: "motion.timeline.particles.emitter.origin.move",
  originDelete: "motion.timeline.particles.emitter.origin.delete",
  collisionAxisUpdate: "motion.timeline.particles.field.collision.axis.update",
  trailAdd: "motion.timeline.particles.emitter.trail.add",
  trailReplace: "motion.timeline.particles.emitter.trail.replace",
  trailRemove: "motion.timeline.particles.emitter.trail.remove",
  shadingAdd: "motion.timeline.particles.emitter.shading.add",
  shadingReplace: "motion.timeline.particles.emitter.shading.replace",
  shadingRemove: "motion.timeline.particles.emitter.shading.remove",
} as const;

export type TimelineParticleStructuralCommand = typeof TIMELINE_PARTICLE_STRUCTURAL_COMMANDS[keyof typeof TIMELINE_PARTICLE_STRUCTURAL_COMMANDS];
export type TimelineParticleStructuralIntent =
  | { kind: "inspect"; layerId: string }
  | { kind: "source-insert" | "source-replace"; layerId: string; index: number; source: MotionParticleFieldV2Source }
  | { kind: "source-move"; layerId: string; fromIndex: number; toIndex: number }
  | { kind: "source-delete"; layerId: string; index: number }
  | { kind: "origin-insert" | "origin-replace"; layerId: string; index: number; origin: MotionParticleEmitterOrigin }
  | { kind: "origin-move"; layerId: string; fromIndex: number; toIndex: number }
  | { kind: "origin-delete"; layerId: string; index: number }
  | { kind: "collision-axis-update"; layerId: string; index: number; axis: "x" | "y" }
  | { kind: "trail-add" | "trail-replace"; layerId: string; trail: MotionParticleAnalyticTrail }
  | { kind: "trail-remove"; layerId: string }
  | { kind: "shading-add" | "shading-replace"; layerId: string; shading: MotionParticleShading }
  | { kind: "shading-remove"; layerId: string };

export type TimelineParticleStructuralIntentParseResult = { ok: true; intent: TimelineParticleStructuralIntent } | { ok: false; problem: string };

const MUTATION_COMMON_KEYS = ["packageRoot", "outDir", "packageDir", "receiptsRoot", "createdBy"];

export function isTimelineParticleStructuralCommand(command: string): command is TimelineParticleStructuralCommand {
  return Object.values(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS).includes(command as TimelineParticleStructuralCommand);
}

/** Parses full closed records before package loading; schema kind/cap and renderer bounds remain Core-owned. */
export function readTimelineParticleStructuralIntent(command: string, args: unknown): TimelineParticleStructuralIntentParseResult | null {
  if (!isTimelineParticleStructuralCommand(command)) return null;
  try {
    const input = strictRecord(args, "Arguments");
    if (!input.ok) return input;
    const unknown = unknownKey(input.value, allowedArgumentKeys(command));
    if (unknown) return fail(`Unknown argument: ${unknown}.`);
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect) return withLayer(input.value, (layerId) => ({ kind: "inspect", layerId }));
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceReplace) return sourceIntent(input.value, command.endsWith(".insert") ? "source-insert" : "source-replace");
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceMove || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originMove) return moveIntent(input.value, command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceMove ? "source-move" : "origin-move");
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceDelete || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originDelete) return indexIntent(input.value, command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceDelete ? "source-delete" : "origin-delete");
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originInsert || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originReplace) return originIntent(input.value, command.endsWith(".insert") ? "origin-insert" : "origin-replace");
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.collisionAxisUpdate) return collisionIntent(input.value);
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailAdd || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailReplace) return trailIntent(input.value, command.endsWith(".add") ? "trail-add" : "trail-replace");
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailRemove) return withLayer(input.value, (layerId) => ({ kind: "trail-remove", layerId }));
    if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingAdd || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingReplace) return shadingIntent(input.value, command.endsWith(".add") ? "shading-add" : "shading-replace");
    return withLayer(input.value, (layerId) => ({ kind: "shading-remove", layerId }));
  } catch {
    return fail("Arguments must be plain JSON data.");
  }
}

function sourceIntent(input: Record<string, unknown>, kind: "source-insert" | "source-replace"): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index"), source = readSource(input.source);
    return index.ok && source.ok ? { kind, layerId, index: index.value, source: source.value } : firstProblem(index, source);
  });
}

function originIntent(input: Record<string, unknown>, kind: "origin-insert" | "origin-replace"): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index"), origin = readOrigin(input.origin);
    return index.ok && origin.ok ? { kind, layerId, index: index.value, origin: origin.value } : firstProblem(index, origin);
  });
}

function moveIntent(input: Record<string, unknown>, kind: "source-move" | "origin-move"): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const fromIndex = nonNegativeInteger(input.fromIndex, "fromIndex"), toIndex = nonNegativeInteger(input.toIndex, "toIndex");
    if (!fromIndex.ok || !toIndex.ok) return firstProblem(fromIndex, toIndex);
    if (fromIndex.value === toIndex.value) return fail("fromIndex and toIndex must differ for an ordered structural move.");
    return { kind, layerId, fromIndex: fromIndex.value, toIndex: toIndex.value };
  });
}

function indexIntent(input: Record<string, unknown>, kind: "source-delete" | "origin-delete"): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index");
    return index.ok ? { kind, layerId, index: index.value } : index;
  });
}

function collisionIntent(input: Record<string, unknown>): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index");
    if (!index.ok) return index;
    if (input.axis !== "x" && input.axis !== "y") return fail("axis must be x or y.");
    return { kind: "collision-axis-update", layerId, index: index.value, axis: input.axis };
  });
}

function trailIntent(input: Record<string, unknown>, kind: "trail-add" | "trail-replace"): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const trail = readTrail(input.trail);
    return trail.ok ? { kind, layerId, trail: trail.value } : trail;
  });
}

function shadingIntent(input: Record<string, unknown>, kind: "shading-add" | "shading-replace"): TimelineParticleStructuralIntentParseResult {
  return withLayer(input, (layerId) => {
    const shading = readShading(input.shading);
    return shading.ok ? { kind, layerId, shading: shading.value } : shading;
  });
}

function readSource(value: unknown): Parsed<MotionParticleFieldV2Source> {
  const source = strictRecord(value, "source");
  if (!source.ok) return source;
  if (source.value.kind === "radial" || source.value.kind === "vortex") return sourceWithNumbers(source.value, ["kind", "centerX", "centerY", "strength", "softening"], ["centerX", "centerY", "strength", "softening"]);
  if (source.value.kind === "flow") return sourceWithNumbers(source.value, ["kind", "angleDeg", "strength"], ["angleDeg", "strength"]);
  if (source.value.kind === "turbulence") return sourceWithNumbers(source.value, ["kind", "scale", "strength"], ["scale", "strength"]);
  if (source.value.kind === "impact") return sourceWithNumbers(source.value, ["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], ["centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"]);
  if (source.value.kind === "collision") return sourceWithNumbers(source.value, ["kind", "axis", "position", "restitution"], ["position", "restitution"], ["axis"]);
  return fail("source.kind must be radial, vortex, flow, turbulence, impact, or collision.");
}

function sourceWithNumbers(value: Record<string, unknown>, keys: string[], numeric: string[], enumKeys: string[] = []): Parsed<MotionParticleFieldV2Source> {
  const exact = exactKeys(value, keys, "source");
  if (!exact.ok) return exact;
  for (const key of numeric) if (!finiteNumber(value[key])) return fail(`source.${key} must be a finite number.`);
  if (enumKeys.includes("axis") && value.axis !== "x" && value.axis !== "y") return fail("source.axis must be x or y.");
  return ok(structuredClone(value) as unknown as MotionParticleFieldV2Source);
}

function readOrigin(value: unknown): Parsed<MotionParticleEmitterOrigin> {
  const origin = strictRecord(value, "origin");
  if (!origin.ok) return origin;
  const exact = exactKeys(origin.value, ["x", "y", "weight", "directionOffsetDeg", "speedScale"], "origin", ["directionOffsetDeg", "speedScale"]);
  if (!exact.ok) return exact;
  for (const key of ["x", "y", "weight", "directionOffsetDeg", "speedScale"] as const) if (Object.hasOwn(origin.value, key) && !finiteNumber(origin.value[key])) return fail(`origin.${key} must be a finite number.`);
  return ok(structuredClone(origin.value) as unknown as MotionParticleEmitterOrigin);
}

function readTrail(value: unknown): Parsed<MotionParticleAnalyticTrail> {
  const trail = strictRecord(value, "trail");
  if (!trail.ok) return trail;
  const exact = exactKeys(trail.value, ["durationMs", "samples", "opacity"], "trail", ["opacity"]);
  if (!exact.ok) return exact;
  for (const key of ["durationMs", "samples", "opacity"] as const) if (Object.hasOwn(trail.value, key) && !finiteNumber(trail.value[key])) return fail(`trail.${key} must be a finite number.`);
  return ok(structuredClone(trail.value) as unknown as MotionParticleAnalyticTrail);
}

function readShading(value: unknown): Parsed<MotionParticleShading> {
  const shading = strictRecord(value, "shading");
  if (!shading.ok) return shading;
  const exact = exactKeys(shading.value, ["mode", "sizeJitter", "opacityJitter", "glow"], "shading", ["sizeJitter", "opacityJitter", "glow"]);
  if (!exact.ok) return exact;
  if (shading.value.mode !== "flat" && shading.value.mode !== "soft" && shading.value.mode !== "glow") return fail("shading.mode must be flat, soft, or glow.");
  for (const key of ["sizeJitter", "opacityJitter", "glow"] as const) if (Object.hasOwn(shading.value, key) && !finiteNumber(shading.value[key])) return fail(`shading.${key} must be a finite number.`);
  return ok(structuredClone(shading.value) as unknown as MotionParticleShading);
}

function withLayer(input: Record<string, unknown>, next: (layerId: string) => TimelineParticleStructuralIntent | TimelineParticleStructuralIntentParseResult): TimelineParticleStructuralIntentParseResult {
  if (typeof input.layerId !== "string" || input.layerId.trim().length === 0) return fail("layerId must be a non-empty string.");
  const result = next(input.layerId);
  return "ok" in result ? result : { ok: true, intent: result };
}

function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> { return readStrictDataRecord(value, label); }

function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []): Parsed<void> {
  const unknown = unknownKey(value, keys);
  if (unknown) return fail(`${label} has unknown field ${unknown}.`);
  const missing = keys.find((key) => !optional.includes(key) && !Object.hasOwn(value, key));
  return missing ? fail(`${label} requires ${missing}.`) : ok(undefined);
}

function allowedArgumentKeys(command: TimelineParticleStructuralCommand): string[] {
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect) return ["packageRoot", "layerId"];
  const common = [...MUTATION_COMMON_KEYS, "layerId"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceReplace) return [...common, "index", "source"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceMove || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originMove) return [...common, "fromIndex", "toIndex"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceDelete || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originDelete) return [...common, "index"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originInsert || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originReplace) return [...common, "index", "origin"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.collisionAxisUpdate) return [...common, "index", "axis"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailAdd || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailReplace) return [...common, "trail"];
  if (command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingAdd || command === TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingReplace) return [...common, "shading"];
  return common;
}

function unknownKey(input: Record<string, unknown>, allowed: readonly string[]): string | null { return Object.getOwnPropertyNames(input).find((key) => !allowed.includes(key)) ?? null; }
function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nonNegativeInteger(value: unknown, label: string): Parsed<number> { return finiteNumber(value) && Number.isInteger(value) && value >= 0 ? ok(value) : fail(`${label} must be a non-negative integer.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid particle structural intent."); }
