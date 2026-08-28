/** Exact data-only intents for root adjustment layers with fixed vignette and film-grain effects. */
import { isSupportedMotionColorString, type MotionFixedAdjustmentDefinition } from "@shellx-motion/core";
import { readStrictDataRecord } from "./timeline-strict-data.js";

export const TIMELINE_FIXED_ADJUSTMENT_COMMANDS = {
  inspect: "motion.timeline.adjustment.fixed.inspect",
  set: "motion.timeline.adjustment.fixed.set",
  remove: "motion.timeline.adjustment.fixed.remove",
} as const;

export type TimelineFixedAdjustmentCommand = typeof TIMELINE_FIXED_ADJUSTMENT_COMMANDS[keyof typeof TIMELINE_FIXED_ADJUSTMENT_COMMANDS];
export type TimelineFixedAdjustmentIntent =
  | { kind: "inspect"; layerId: string }
  | { kind: "set"; adjustment: MotionFixedAdjustmentDefinition }
  | { kind: "remove"; layerId: string };
export type TimelineFixedAdjustmentIntentParseResult = { ok: true; intent: TimelineFixedAdjustmentIntent } | { ok: false; problem: string };

/**
 * Fixed adjustment receipts are selected only by the trusted Debug host.  This
 * deliberately differs from generic package edits, whose caller-supplied
 * receipt mirror is part of their published contract.
 */
const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"];
const ADJUSTMENT_KEYS = ["id", "name", "startMs", "durationMs", "visible", "effects"];

export function isTimelineFixedAdjustmentCommand(command: string): command is TimelineFixedAdjustmentCommand {
  return Object.values(TIMELINE_FIXED_ADJUSTMENT_COMMANDS).includes(command as TimelineFixedAdjustmentCommand);
}

/** Parses a complete adjustment record before package I/O; Core repeats the exact closure at its public boundary. */
export function readTimelineFixedAdjustmentIntent(command: string, args: unknown): TimelineFixedAdjustmentIntentParseResult | null {
  if (!isTimelineFixedAdjustmentCommand(command)) return null;
  const input = strictRecord(args, "Arguments");
  if (!input.ok) return input;
  const allowed = command === TIMELINE_FIXED_ADJUSTMENT_COMMANDS.inspect
    ? ["packageRoot", "layerId"]
    : command === TIMELINE_FIXED_ADJUSTMENT_COMMANDS.set ? [...EDIT_KEYS, "adjustment"] : [...EDIT_KEYS, "layerId"];
  const unknown = unknownKey(input.value, allowed);
  if (unknown) return fail(`Unknown argument: ${unknown}.`);
  if (command === TIMELINE_FIXED_ADJUSTMENT_COMMANDS.set) {
    const adjustment = readAdjustment(input.value.adjustment);
    return adjustment.ok ? parsedIntent({ kind: "set", adjustment: adjustment.value }) : adjustment;
  }
  const layerId = nonEmptyString(input.value.layerId, "layerId");
  return layerId.ok ? parsedIntent({ kind: command === TIMELINE_FIXED_ADJUSTMENT_COMMANDS.inspect ? "inspect" : "remove", layerId: layerId.value }) : layerId;
}

function readAdjustment(value: unknown): Parsed<MotionFixedAdjustmentDefinition> {
  const adjustment = strictRecord(value, "adjustment");
  if (!adjustment.ok) return adjustment;
  const exact = exactKeys(adjustment.value, ADJUSTMENT_KEYS, "adjustment", ["name", "visible"]);
  if (!exact.ok) return exact;
  const id = nonEmptyString(adjustment.value.id, "adjustment.id");
  const startMs = nonNegativeFinite(adjustment.value.startMs, "adjustment.startMs");
  const durationMs = positiveFinite(adjustment.value.durationMs, "adjustment.durationMs");
  if (!id.ok || !startMs.ok || !durationMs.ok) return firstProblem(id, startMs, durationMs);
  if (Object.hasOwn(adjustment.value, "name") && typeof adjustment.value.name !== "string") return fail("adjustment.name must be a string when present.");
  if (Object.hasOwn(adjustment.value, "visible") && typeof adjustment.value.visible !== "boolean") return fail("adjustment.visible must be a boolean when present.");
  const effects = readEffects(adjustment.value.effects);
  if (!effects.ok) return effects;
  return ok({
    id: id.value, startMs: startMs.value, durationMs: durationMs.value,
    ...(Object.hasOwn(adjustment.value, "name") ? { name: adjustment.value.name as string } : {}),
    ...(Object.hasOwn(adjustment.value, "visible") ? { visible: adjustment.value.visible as boolean } : {}),
    effects: effects.value,
  });
}

function readEffects(value: unknown): Parsed<MotionFixedAdjustmentDefinition["effects"]> {
  const effects = strictRecord(value, "adjustment.effects");
  if (!effects.ok) return effects;
  const exact = exactKeys(effects.value, ["vignette", "filmGrain"], "adjustment.effects", ["vignette", "filmGrain"]);
  if (!exact.ok) return exact;
  if (!Object.hasOwn(effects.value, "vignette") && !Object.hasOwn(effects.value, "filmGrain")) return fail("adjustment.effects requires vignette and/or filmGrain.");
  const vignette = Object.hasOwn(effects.value, "vignette") ? readVignette(effects.value.vignette) : ok(undefined);
  const filmGrain = Object.hasOwn(effects.value, "filmGrain") ? readFilmGrain(effects.value.filmGrain) : ok(undefined);
  if (!vignette.ok || !filmGrain.ok) return firstProblem(vignette, filmGrain);
  return ok({ ...(vignette.value ? { vignette: vignette.value } : {}), ...(filmGrain.value ? { filmGrain: filmGrain.value } : {}) });
}

function readVignette(value: unknown): Parsed<NonNullable<MotionFixedAdjustmentDefinition["effects"]["vignette"]>> {
  const vignette = strictRecord(value, "adjustment.effects.vignette");
  if (!vignette.ok) return vignette;
  const exact = exactKeys(vignette.value, ["amount", "softness", "color"], "adjustment.effects.vignette");
  if (!exact.ok) return exact;
  const amount = unit(vignette.value.amount, "adjustment.effects.vignette.amount");
  const softness = unit(vignette.value.softness, "adjustment.effects.vignette.softness");
  const color = typeof vignette.value.color === "string" && isSupportedMotionColorString(vignette.value.color) ? ok(vignette.value.color) : fail("adjustment.effects.vignette.color must be a supported static color string.");
  return amount.ok && softness.ok && color.ok ? ok({ amount: amount.value, softness: softness.value, color: color.value }) : firstProblem(amount, softness, color);
}

function readFilmGrain(value: unknown): Parsed<NonNullable<MotionFixedAdjustmentDefinition["effects"]["filmGrain"]>> {
  const filmGrain = strictRecord(value, "adjustment.effects.filmGrain");
  if (!filmGrain.ok) return filmGrain;
  const exact = exactKeys(filmGrain.value, ["amount", "size", "seed"], "adjustment.effects.filmGrain");
  if (!exact.ok) return exact;
  const amount = unit(filmGrain.value.amount, "adjustment.effects.filmGrain.amount");
  const size = integer(filmGrain.value.size, 1, 8, "adjustment.effects.filmGrain.size");
  const seed = integer(filmGrain.value.seed, 0, 0xffff_ffff, "adjustment.effects.filmGrain.seed");
  return amount.ok && size.ok && seed.ok ? ok({ amount: amount.value, size: size.value, seed: seed.value }) : firstProblem(amount, size, seed);
}

function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> { return readStrictDataRecord(value, label); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, optional: readonly string[] = []): Parsed<void> {
  const unknown = unknownKey(value, keys);
  if (unknown) return fail(`${label} has unknown field ${unknown}.`);
  const missing = keys.find((key) => !optional.includes(key) && !Object.hasOwn(value, key));
  return missing ? fail(`${label} requires ${missing}.`) : ok(undefined);
}
function unknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | null { return Object.getOwnPropertyNames(value).find((key) => !allowed.includes(key)) ?? null; }
function nonEmptyString(value: unknown, label: string): Parsed<string> { return typeof value === "string" && value.trim() ? ok(value.trim()) : fail(`${label} must be a non-empty string.`); }
function nonNegativeFinite(value: unknown, label: string): Parsed<number> { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? ok(value) : fail(`${label} must be a finite number at least 0.`); }
function positiveFinite(value: unknown, label: string): Parsed<number> { return typeof value === "number" && Number.isFinite(value) && value > 0 ? ok(value) : fail(`${label} must be a finite number greater than 0.`); }
function unit(value: unknown, label: string): Parsed<number> { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? ok(value) : fail(`${label} must be a finite number between 0 and 1.`); }
function integer(value: unknown, minimum: number, maximum: number, label: string): Parsed<number> { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? ok(value) : fail(`${label} must be a safe integer in ${minimum}..${maximum}.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsedIntent(intent: TimelineFixedAdjustmentIntent): { ok: true; intent: TimelineFixedAdjustmentIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid fixed adjustment intent."); }
