/** Closed direct-call parser for the atomic revision transaction. */
import { canonicalJson, canonicalJsonSha256, isSupportedEasing, readSupportedKeyframeTarget } from "@shellx-motion/core";
import { debugArgEnum } from "../command-metadata-enums.js";

const MAX_TRANSACTION_BYTES = 128 * 1024;
const MAX_STEPS = 32;
const SHA256 = /^[0-9a-f]{64}$/;
const NAMED_EASINGS = new Set(debugArgEnum("easing")?.values ?? []);

export type RevisionTransactionStep =
  | { command: "motion.timeline.layer.text.set"; layerId: string; text: string }
  | { command: "motion.timeline.layer.name.set"; layerId: string; name: string }
  | { command: "motion.timeline.layer.visibility.set"; layerId: string; visible: boolean }
  | { command: "motion.timeline.layer.lock"; layerId: string; locked: boolean }
  | { command: "motion.timeline.keyframe.upsert"; layerId: string; target: NonNullable<ReturnType<typeof readSupportedKeyframeTarget>>; targetArg: string; atMs: number; value: string | number; easing?: string }
  | { command: "motion.timeline.keyframe.delete"; layerId: string; target: NonNullable<ReturnType<typeof readSupportedKeyframeTarget>>; targetArg: string; atMs: number }
  | { command: "motion.timeline.keyframe.move"; layerId: string; target: NonNullable<ReturnType<typeof readSupportedKeyframeTarget>>; targetArg: string; fromMs: number; toMs: number }
  | { command: "motion.timeline.spatial.position.upsert"; layerId: string; atMs: number; x: number; y: number; easing?: string }
  | { command: "motion.timeline.spatial.position.move"; layerId: string; fromMs: number; toMs: number }
  | { command: "motion.timeline.spatial.position.delete"; layerId: string; atMs: number };

export interface RevisionBase {
  packageId: string;
  motionId: string;
  manifestSha256: string;
  motionSha256: string;
}

export interface ParsedRevisionTransactionInput {
  packageRoot: string;
  base: RevisionBase;
  steps: RevisionTransactionStep[];
  transactionSha256: string;
}

export interface ParsedRevisionTransaction extends ParsedRevisionTransactionInput {
  outDir: string;
  createdBy?: string;
}

export function parseRevisionTransaction(args: unknown): { ok: true; value: ParsedRevisionTransaction } | { ok: false; message: string } {
  const record = dataRecord(args);
  if (!record) return { ok: false, message: "motion.revision.transaction requires an object argument payload." };
  const unknown = Object.keys(record).filter((key) => !["packageRoot", "outDir", "base", "steps", "createdBy"].includes(key));
  if (unknown.length) return { ok: false, message: `motion.revision.transaction does not accept ${unknown.join(", ")}.` };
  const packageRoot = packagePath(valueOf(record, "packageRoot"));
  const outDir = packagePath(valueOf(record, "outDir"));
  if (!packageRoot || !outDir) return { ok: false, message: "motion.revision.transaction requires packageRoot and outDir as strings up to 4096 UTF-8 bytes without NUL bytes." };
  const createdBy = !Object.hasOwn(record, "createdBy") ? undefined : boundedString(valueOf(record, "createdBy"), 256);
  if (createdBy === false) return { ok: false, message: "createdBy must be a string no longer than 256 characters." };
  const normalized = parseNormalizedTransaction(record);
  if (!normalized.ok) return normalized;
  return { ok: true, value: { packageRoot, outDir, ...normalized.value, ...(createdBy ? { createdBy } : {}) } };
}

export function parseRevisionTransactionPlan(args: unknown): { ok: true; value: ParsedRevisionTransactionInput } | { ok: false; message: string } {
  const record = dataRecord(args);
  if (!record) return { ok: false, message: "motion.revision.transaction.plan requires an object argument payload." };
  const unknown = Object.keys(record).filter((key) => !["packageRoot", "base", "steps"].includes(key));
  if (unknown.length) return { ok: false, message: `motion.revision.transaction.plan does not accept ${unknown.join(", ")}.` };
  const packageRoot = packagePath(valueOf(record, "packageRoot"));
  if (!packageRoot) return { ok: false, message: "motion.revision.transaction.plan requires packageRoot as a string up to 4096 UTF-8 bytes without NUL bytes." };
  const normalized = parseNormalizedTransaction(record);
  return normalized.ok ? { ok: true, value: { packageRoot, ...normalized.value } } : normalized;
}

function parseNormalizedTransaction(record: Record<string, unknown>): { ok: true; value: Omit<ParsedRevisionTransactionInput, "packageRoot"> } | { ok: false; message: string } {
  const base = parseBase(valueOf(record, "base"));
  if (!base.ok) return base;
  const sourceSteps = dataArray(valueOf(record, "steps"));
  if (!sourceSteps || sourceSteps.length < 1 || sourceSteps.length > MAX_STEPS) {
    return { ok: false, message: `steps must be an array of 1..${MAX_STEPS} typed revision operations.` };
  }
  const steps: RevisionTransactionStep[] = [];
  for (const [index, value] of sourceSteps.entries()) {
    const parsed = parseStep(value);
    if (!parsed.ok) return { ok: false, message: `steps[${index}]: ${parsed.message}` };
    steps.push(parsed.value);
  }
  // Raw caller objects are never canonicalized: only the inert, normalized projection is hashed.
  const transaction = { base: base.value, steps };
  if (Buffer.byteLength(canonicalJson(transaction), "utf8") > MAX_TRANSACTION_BYTES) {
    return { ok: false, message: `Canonical transaction data exceeds the ${MAX_TRANSACTION_BYTES} byte limit.` };
  }
  return { ok: true, value: { base: base.value, steps, transactionSha256: canonicalJsonSha256(transaction) } };
}

function parseBase(value: unknown): { ok: true; value: RevisionBase } | { ok: false; message: string } {
  const record = dataRecord(value);
  if (!record || !only(record, ["packageId", "motionId", "manifestSha256", "motionSha256"])) return { ok: false, message: "base must be a closed identity record." };
  const packageId = boundedString(valueOf(record, "packageId"), 96);
  const motionId = boundedString(valueOf(record, "motionId"), 96);
  const manifestSha256 = string(valueOf(record, "manifestSha256"));
  const motionSha256 = string(valueOf(record, "motionSha256"));
  if (!packageId || !motionId || !manifestSha256 || !motionSha256 || !SHA256.test(manifestSha256) || !SHA256.test(motionSha256)) {
    return { ok: false, message: "base requires non-empty packageId/motionId and lowercase manifestSha256/motionSha256 values." };
  }
  return { ok: true, value: { packageId, motionId, manifestSha256, motionSha256 } };
}

function parseStep(value: unknown): { ok: true; value: RevisionTransactionStep } | { ok: false; message: string } {
  const record = dataRecord(value);
  const command = record ? string(valueOf(record, "command")) : null;
  if (!record || !command) return { ok: false, message: "each step requires a literal allowlisted command." };
  const layer = () => {
    const layerId = boundedString(valueOf(record, "layerId"), 256);
    return layerId === false ? null : layerId;
  };
  const target = () => {
    const targetArg = string(valueOf(record, "target")); const normalized = targetArg ? readSupportedKeyframeTarget(targetArg) : null;
    return normalized && targetArg ? { target: normalized, targetArg } : null;
  };
  const keyframeBase = () => {
    const layerId = layer(); const targetValue = target(); const atMs = nonNegative(valueOf(record, "atMs"));
    return layerId && targetValue && atMs !== false ? { layerId, ...targetValue, atMs } : null;
  };
  const optionalEasing = () => !Object.hasOwn(record, "easing") ? null : readEasing(valueOf(record, "easing"));
  switch (command) {
    case "motion.timeline.layer.text.set": {
      if (!only(record, ["command", "layerId", "text"])) return badFields(command);
      const layerId = layer(); const text = boundedString(valueOf(record, "text"), 16_384, true);
      return layerId && text !== false ? { ok: true, value: { command, layerId, text } } : badInput(command);
    }
    case "motion.timeline.layer.name.set": {
      if (!only(record, ["command", "layerId", "name"])) return badFields(command);
      const layerId = layer(); const name = boundedString(valueOf(record, "name"), 256);
      return layerId && name ? { ok: true, value: { command, layerId, name } } : badInput(command);
    }
    case "motion.timeline.layer.visibility.set": {
      if (!only(record, ["command", "layerId", "visible"])) return badFields(command);
      const layerId = layer(); const visible = valueOf(record, "visible");
      return layerId && typeof visible === "boolean" ? { ok: true, value: { command, layerId, visible } } : badInput(command);
    }
    case "motion.timeline.layer.lock": {
      if (!only(record, ["command", "layerId", "locked"])) return badFields(command);
      const layerId = layer(); const locked = valueOf(record, "locked");
      return layerId && typeof locked === "boolean" ? { ok: true, value: { command, layerId, locked } } : badInput(command);
    }
    case "motion.timeline.keyframe.upsert": {
      if (!only(record, ["command", "layerId", "target", "atMs", "value", "easing"])) return badFields(command);
      const base = keyframeBase(); const keyframe = keyframeValue(valueOf(record, "value")); const easing = optionalEasing();
      return base && keyframe !== false && easing !== false ? { ok: true, value: { command, ...base, value: keyframe, ...(easing ? { easing } : {}) } } : badInput(command);
    }
    case "motion.timeline.keyframe.delete": {
      if (!only(record, ["command", "layerId", "target", "atMs"])) return badFields(command);
      const base = keyframeBase(); return base ? { ok: true, value: { command, ...base } } : badInput(command);
    }
    case "motion.timeline.keyframe.move": {
      if (!only(record, ["command", "layerId", "target", "fromMs", "toMs"])) return badFields(command);
      const layerId = layer(); const targetValue = target(); const fromMs = nonNegative(valueOf(record, "fromMs")); const toMs = nonNegative(valueOf(record, "toMs"));
      return layerId && targetValue && fromMs !== false && toMs !== false ? { ok: true, value: { command, layerId, ...targetValue, fromMs, toMs } } : badInput(command);
    }
    case "motion.timeline.spatial.position.upsert": {
      if (!only(record, ["command", "layerId", "atMs", "x", "y", "easing"])) return badFields(command);
      const layerId = layer(); const atMs = nonNegative(valueOf(record, "atMs")); const x = finite(valueOf(record, "x")); const y = finite(valueOf(record, "y")); const easing = optionalEasing();
      return layerId && atMs !== false && x !== false && y !== false && easing !== false ? { ok: true, value: { command, layerId, atMs, x, y, ...(easing ? { easing } : {}) } } : badInput(command);
    }
    case "motion.timeline.spatial.position.move": {
      if (!only(record, ["command", "layerId", "fromMs", "toMs"])) return badFields(command);
      const layerId = layer(); const fromMs = nonNegative(valueOf(record, "fromMs")); const toMs = nonNegative(valueOf(record, "toMs"));
      return layerId && fromMs !== false && toMs !== false ? { ok: true, value: { command, layerId, fromMs, toMs } } : badInput(command);
    }
    case "motion.timeline.spatial.position.delete": {
      if (!only(record, ["command", "layerId", "atMs"])) return badFields(command);
      const layerId = layer(); const atMs = nonNegative(valueOf(record, "atMs"));
      return layerId && atMs !== false ? { ok: true, value: { command, layerId, atMs } } : badInput(command);
    }
    default: return { ok: false, message: `${command} is not an allowlisted revision operation.` };
  }
}

function readEasing(value: unknown): string | false {
  const easing = string(value);
  return easing && NAMED_EASINGS.has(easing) && isSupportedEasing(easing) ? easing : false;
}
function keyframeValue(value: unknown): string | number | false { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() ? value.trim() : false; }
function nonNegative(value: unknown): number | false { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : false; }
function finite(value: unknown): number | false { return typeof value === "number" && Number.isFinite(value) ? value : false; }
function boundedString(value: unknown, max: number, allowEmpty = false): string | false { return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) ? value : false; }
function packagePath(value: unknown): string | null { return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 4096 ? value : null; }
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) return null;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor) ? value as Record<string, unknown> : null;
}
function dataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return null;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) if (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || !("value" in descriptor))) return null;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return null;
  return value;
}
function valueOf(record: Record<string, unknown>, key: string): unknown { return Object.hasOwn(record, key) ? record[key] : undefined; }
function only(record: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(record).every((key) => allowed.includes(key)); }
function badFields(command: string): { ok: false; message: string } { return { ok: false, message: `${command} has an undeclared field.` }; }
function badInput(command: string): { ok: false; message: string } { return { ok: false, message: `${command} has an invalid typed input.` }; }
