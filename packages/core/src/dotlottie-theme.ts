import { parseBoundedJsonObject } from "./dotlottie-json";
import { parseBoundedLottieJson } from "./lottie-json";
import type { DotLottieBundledJsonResource } from "./dotlottie-types";

type StaticThemeType = "Color" | "Scalar" | "Position" | "Vector";

export interface AppliedDotLottieTheme {
  schema: "shellx-motion/dotlottie-theme-application@1";
  themeId: string;
  themeSha256: string;
  animationId: string;
  animationText: string;
  appliedRuleCount: number;
  appliedTargetCount: number;
  skippedScopedRuleCount: number;
  slotIds: string[];
}

/** Materializes the deterministic static theme subset into Lottie property values. */
export function applyStaticDotLottieTheme(input: {
  animationText: string;
  animationId: string;
  theme: DotLottieBundledJsonResource;
}): AppliedDotLottieTheme {
  if (input.theme.kind !== "theme") throw new Error("dotLottie theme application requires a theme resource.");
  const animation = parseBoundedLottieJson(input.animationText);
  const theme = parseBoundedJsonObject(input.theme.text, `dotLottie theme ${input.theme.id}`);
  if (!Array.isArray(theme.rules) || theme.rules.length > 256) {
    throw new Error(`dotLottie theme ${input.theme.id} requires an array of at most 256 rules.`);
  }
  const slots = mutableRecord(animation.slots);
  const seenRuleIds = new Set<string>();
  const appliedSlotIds: string[] = [];
  let appliedTargetCount = 0;
  let skippedScopedRuleCount = 0;
  for (const [index, value] of theme.rules.entries()) {
    const rule = mutableRecord(value);
    if (!rule) throw new Error(`dotLottie theme ${input.theme.id} rule ${index} must be an object.`);
    const id = safeThemeId(rule.id, input.theme.id, index);
    if (seenRuleIds.has(id)) throw new Error(`dotLottie theme ${input.theme.id} contains duplicate rule id ${id}.`);
    seenRuleIds.add(id);
    if (!ruleAppliesToAnimation(rule.animations, input.animationId, input.theme.id, id)) {
      skippedScopedRuleCount += 1;
      continue;
    }
    if (rule.expression !== undefined) throw new Error(`dotLottie theme ${input.theme.id} rule ${id} expressions are not executable.`);
    if (rule.keyframes !== undefined) throw new Error(`dotLottie theme ${input.theme.id} rule ${id} requires unsupported animated keyframes.`);
    if (!("value" in rule)) throw new Error(`dotLottie theme ${input.theme.id} rule ${id} requires a static value.`);
    const type = staticThemeType(rule.type, input.theme.id, id);
    const targets = collectSlotTargets(animation, id);
    if (targets.length === 0) throw new Error(`dotLottie theme ${input.theme.id} rule ${id} does not target a selected-animation slot.`);
    const slotProperty = mutableRecord(mutableRecord(slots?.[id])?.p);
    for (const target of targets) {
      const normalized = normalizeThemeValue(type, rule.value, target, slotProperty, input.theme.id, id);
      materializeStaticProperty(target, normalized);
      appliedTargetCount += 1;
    }
    if (slots) {
      const normalized = normalizeThemeValue(type, rule.value, targets[0], slotProperty, input.theme.id, id);
      slots[id] = { p: { a: 0, k: normalized } };
    }
    appliedSlotIds.push(id);
  }
  return {
    schema: "shellx-motion/dotlottie-theme-application@1",
    themeId: input.theme.id,
    themeSha256: input.theme.sha256,
    animationId: input.animationId,
    animationText: JSON.stringify(animation),
    appliedRuleCount: appliedSlotIds.length,
    appliedTargetCount,
    skippedScopedRuleCount,
    slotIds: appliedSlotIds.sort()
  };
}

function collectSlotTargets(root: Record<string, unknown>, slotId: string): Record<string, unknown>[] {
  const targets: Record<string, unknown>[] = [];
  const stack: unknown[] = [];
  for (const [key, value] of Object.entries(root)) if (key !== "slots") stack.push(value);
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = mutableRecord(value);
    if (!record) continue;
    if (record.sid === slotId) targets.push(record);
    stack.push(...Object.values(record));
  }
  return targets;
}

function normalizeThemeValue(
  type: StaticThemeType,
  value: unknown,
  target: Record<string, unknown>,
  slotProperty: Record<string, unknown> | null,
  themeId: string,
  ruleId: string
): number | number[] {
  const baseline = target.k ?? slotProperty?.k;
  if (type === "Scalar") {
    if (typeof baseline !== "number" || typeof value !== "number" || !boundedNumber(value)) {
      throw incompatibleThemeRule(themeId, ruleId, type);
    }
    return value;
  }
  const numbers = finiteNumberArray(value);
  const existing = finiteNumberArray(baseline);
  if (type === "Color") {
    if (!numbers || numbers.length !== 3 || numbers.some((item) => item < 0 || item > 1)
      || !existing || (existing.length !== 3 && existing.length !== 4)) {
      throw incompatibleThemeRule(themeId, ruleId, type);
    }
    return existing.length === 4 ? [...numbers, existing[3]] : numbers;
  }
  if (type === "Position") {
    if (!numbers || (numbers.length !== 2 && numbers.length !== 3) || !existing || existing.length !== numbers.length) {
      throw incompatibleThemeRule(themeId, ruleId, type);
    }
    return numbers;
  }
  if (!numbers || numbers.length !== 2 || !existing || existing.length !== 2) {
    throw incompatibleThemeRule(themeId, ruleId, type);
  }
  return numbers;
}

function materializeStaticProperty(target: Record<string, unknown>, value: number | number[]): void {
  target.a = 0;
  target.k = value;
  delete target.x;
  delete target.s;
  delete target.e;
}

function ruleAppliesToAnimation(value: unknown, animationId: string, themeId: string, ruleId: string): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string")) {
    throw new Error(`dotLottie theme ${themeId} rule ${ruleId} animations must be a bounded string array.`);
  }
  return value.includes(animationId);
}

function staticThemeType(value: unknown, themeId: string, ruleId: string): StaticThemeType {
  if (value === "Color" || value === "Scalar" || value === "Position" || value === "Vector") return value;
  throw new Error(`dotLottie theme ${themeId} rule ${ruleId} type ${String(value)} is outside the static editable subset.`);
}

function safeThemeId(value: unknown, themeId: string, index: number): string {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(value)
    || value === "__proto__"
    || value === "prototype"
    || value === "constructor") {
    throw new Error(`dotLottie theme ${themeId} rule ${index} has an unsafe slot id.`);
  }
  return value;
}

function finiteNumberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.length <= 4 && value.every(boundedNumber) ? value : null;
}

function boundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
}

function incompatibleThemeRule(themeId: string, ruleId: string, type: StaticThemeType): Error {
  return new Error(`dotLottie theme ${themeId} rule ${ruleId} is not compatible with its ${type} slot property.`);
}

function mutableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
