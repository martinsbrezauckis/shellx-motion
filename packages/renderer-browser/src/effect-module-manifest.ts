/** Closed parser for the only V25-C1 installable local-effect manifest. */
import {
  EFFECT_MODULE_INTRINSIC,
  EFFECT_MODULE_MANIFEST_SCHEMA,
  EFFECT_MODULE_PARAMETER_SCHEMA,
  EFFECT_MODULE_RENDERER_ABI,
  EffectModuleRegistryError,
  type EffectModuleManifest
} from "./effect-module-registry-types.js";
import { motionEffectModuleManifestProblem } from "@shellx-motion/core";

export const MAX_EFFECT_MODULE_MANIFEST_BYTES = 16 * 1024;

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$/;
// Canonical SemVer without build metadata; ranges/latest/leading zeroes are deliberately absent.
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9][0-9]*)|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export function parseEffectModuleManifest(bytes: Buffer): EffectModuleManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EFFECT_MODULE_MANIFEST_BYTES) {
    throw invalid("Effect-module manifest must be a non-empty bounded JSON file.");
  }
  let value: unknown;
  try {
    // Keep a leading BOM visible to JSON.parse, which rejects it as non-JSON rather than silently
    // normalizing the exact manifest bytes before validation.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assertJsonHasNoDuplicateObjectKeys(text);
    value = JSON.parse(text);
  }
  catch { throw invalid("Effect-module manifest must be valid UTF-8 JSON with no duplicate object keys."); }
  if (!isRecord(value) || motionEffectModuleManifestProblem(value)) throw invalid("Effect-module manifest has unsupported closed C1 fields.");
  const manifest = value as unknown as EffectModuleManifest;
  return Object.freeze({
    schema: EFFECT_MODULE_MANIFEST_SCHEMA,
    moduleId: manifest.moduleId,
    version: manifest.version,
    displayName: manifest.displayName,
    intrinsic: EFFECT_MODULE_INTRINSIC,
    rendererAbi: EFFECT_MODULE_RENDERER_ABI,
    parameterSchema: EFFECT_MODULE_PARAMETER_SCHEMA
  });
}

export function safeEffectModuleId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && MODULE_ID.test(value); }
export function safeEffectModuleVersion(value: unknown): value is string { return typeof value === "string" && VERSION.test(value); }
export function safeEffectModuleDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 96
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeModuleId(value: unknown): value is string { return safeEffectModuleId(value); }
function safeVersion(value: unknown): value is string { return safeEffectModuleVersion(value); }
function safeDisplayName(value: unknown): value is string { return safeEffectModuleDisplayName(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid(message: string): EffectModuleRegistryError { return new EffectModuleRegistryError(message, "invalid_manifest"); }

/**
 * JSON.parse keeps only the last repeated object key. That is not acceptable for a manifest whose
 * exact bytes are pinned: a duplicated declaration must fail rather than silently select a value.
 * This bounded grammar walk checks all objects before JSON.parse creates the manifest value.
 */
function assertJsonHasNoDuplicateObjectKeys(text: string): void {
  let index = 0;
  const fail = (): never => { throw new Error("invalid JSON"); };
  const whitespace = (): void => { while (/\s/.test(text[index] ?? "")) index += 1; };
  const expect = (value: string): void => { if (text[index] !== value) fail(); index += 1; };

  function string(): string {
    const start = index;
    expect("\"");
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code <= 0x1f) fail();
      if (text[index] === "\"") {
        index += 1;
        try { return JSON.parse(text.slice(start, index)) as string; }
        catch { fail(); }
      }
      if (text[index] === "\\") {
        index += 1;
        const escape = text[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail();
          index += 5;
          continue;
        }
        if (!escape || !"\"\\/bfnrt".includes(escape)) fail();
      }
      index += 1;
    }
    return fail();
  }

  function number(): void {
    if (text[index] === "-") index += 1;
    if (text[index] === "0") index += 1;
    else {
      if (!/[1-9]/.test(text[index] ?? "")) fail();
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (!/[0-9]/.test(text[index] ?? "")) fail();
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!/[0-9]/.test(text[index] ?? "")) fail();
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
  }

  function literal(value: string): void {
    if (!text.startsWith(value, index)) fail();
    index += value.length;
  }

  function value(): void {
    whitespace();
    switch (text[index]) {
      case "{": object(); return;
      case "[": array(); return;
      case "\"": string(); return;
      case "t": literal("true"); return;
      case "f": literal("false"); return;
      case "n": literal("null"); return;
      default: number(); return;
    }
  }

  function object(): void {
    expect("{"); whitespace();
    const keys = new Set<string>();
    if (text[index] === "}") { index += 1; return; }
    while (true) {
      whitespace();
      if (text[index] !== "\"") fail();
      const key = string();
      if (keys.has(key)) fail();
      keys.add(key);
      whitespace(); expect(":"); value(); whitespace();
      if (text[index] === "}") { index += 1; return; }
      expect(","); whitespace();
    }
  }

  function array(): void {
    expect("["); whitespace();
    if (text[index] === "]") { index += 1; return; }
    while (true) {
      value(); whitespace();
      if (text[index] === "]") { index += 1; return; }
      expect(","); whitespace();
    }
  }

  value(); whitespace();
  if (index !== text.length) fail();
}
