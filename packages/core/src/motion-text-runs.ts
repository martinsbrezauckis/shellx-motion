import { canonicalJsonSha256 } from "./canonical-json";
import { isSupportedMotionColorString } from "./color";
import { readMotionTextRunsInput } from "./motion-text-runs-input";
import type { MotionFontAsset, MotionLayer, MotionTextRun, MotionTextRuns } from "./types";

export const MOTION_TEXT_RUNS_SCHEMA = "shellx-motion/text-runs@1" as const;
export const MAX_MOTION_TEXT_RUNS = 32;
export const MAX_MOTION_TEXT_RUN_FONT_ASSETS = 16;
export const MAX_MOTION_TEXT_RUNS_UTF8_BYTES = 16 * 1024;
export const MAX_MOTION_TEXT_RUN_FONT_SIZE_PX = 4096;
export const MAX_MOTION_TEXT_RUN_LETTER_SPACING_PX = 2048;

/**
 * Descriptor-first data admission shared by direct Core authoring and Debug
 * layer-create. It validates the closed record without assuming a particular
 * document, so only the document validator resolves `fontAssetId` references.
 */
export function readMotionTextRuns(value: unknown, label = "textRuns"): MotionTextRuns {
  const input = readMotionTextRunsInput(value, label);
  if (input.schema !== MOTION_TEXT_RUNS_SCHEMA) throw new Error(`${label}.schema must equal ${MOTION_TEXT_RUNS_SCHEMA}.`);
  const runs: MotionTextRun[] = [];
  let byteLength = 0;
  for (let index = 0; index < input.runs.length; index += 1) {
    const run = readRun(input.runs[index]!, `${label}.runs[${index}]`);
    byteLength += utf8Bytes(run.text);
    if (byteLength > MAX_MOTION_TEXT_RUNS_UTF8_BYTES) {
      throw new Error(`${label}.runs concatenated UTF-8 text exceeds ${MAX_MOTION_TEXT_RUNS_UTF8_BYTES} bytes.`);
    }
    runs.push(run);
  }
  const fontIds = new Set(runs.map((run) => run.fontAssetId));
  if (fontIds.size > MAX_MOTION_TEXT_RUN_FONT_ASSETS) {
    throw new Error(`${label}.runs references more than ${MAX_MOTION_TEXT_RUN_FONT_ASSETS} distinct font assets.`);
  }
  return { schema: MOTION_TEXT_RUNS_SCHEMA, runs };
}

export function cloneMotionTextRuns(value: MotionTextRuns): MotionTextRuns {
  return { schema: MOTION_TEXT_RUNS_SCHEMA, runs: value.runs.map((run) => ({ ...run })) };
}

export function motionTextRunsPlainText(value: MotionTextRuns): string {
  return value.runs.map((run) => run.text).join("");
}

export function fingerprintMotionTextRuns(value: MotionTextRuns): string {
  return canonicalJsonSha256(readMotionTextRuns(value));
}

/** Complete semantic validation for document-owned styled text records. */
export function validateMotionTextRunsLayers(
  layers: unknown[],
  assets: unknown[],
  errors: Array<{ path: string; message: string }>,
): void {
  const fonts = new Map<string, MotionFontAsset>();
  for (const asset of assets) {
    const font = motionFontAsset(asset);
    if (font) fonts.set(font.id, font);
  }
  layers.forEach((value, index) => {
    const layer = record(value);
    if (!layer || !Object.hasOwn(layer, "textRuns")) return;
    const path = `/layers/${index}`;
    if (layer.type !== "text" && layer.type !== "caption") {
      errors.push({ path: `${path}/textRuns`, message: "is supported only on text and caption layers" });
      return;
    }
    if (Object.hasOwn(layer, "text")) errors.push({ path: `${path}/text`, message: "must be absent when textRuns owns text content" });
    let textRuns: MotionTextRuns;
    try { textRuns = readMotionTextRuns(layer.textRuns, `${path}/textRuns`); }
    catch (error) {
      errors.push({ path: `${path}/textRuns`, message: error instanceof Error ? error.message : "must be a closed text-runs@1 record" });
      return;
    }
    for (const field of ["fontFamily", "fontWeight", "fontStyle"]) {
      if (Object.hasOwn(record(layer.style), field)) {
        errors.push({ path: `${path}/style/${field}`, message: "must be absent when textRuns uses manifest font assets as its sole face authority" });
      }
    }
    if (Object.hasOwn(record(layer.keyframes), "style.fontWeight")) {
      errors.push({ path: `${path}/keyframes/style.fontWeight`, message: "must be absent when textRuns uses manifest font assets as its sole face authority" });
    }
    textRuns.runs.forEach((run, runIndex) => {
      if (!fonts.has(run.fontAssetId)) {
        errors.push({ path: `${path}/textRuns/runs/${runIndex}/fontAssetId`, message: "must reference a declared Motion font asset" });
      }
    });
  });
}

function readRun(record: Record<string, unknown>, label: string): MotionTextRun {
  if (typeof record.text !== "string" || utf8Bytes(record.text) === 0) throw new Error(`${label}.text must be non-empty.`);
  if (typeof record.fontAssetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.fontAssetId)) {
    throw new Error(`${label}.fontAssetId must be a safe declared font asset id.`);
  }
  if (record.color !== undefined && (typeof record.color !== "string" || !isSupportedMotionColorString(record.color))) {
    throw new Error(`${label}.color must be a supported static Motion color string.`);
  }
  if (record.fontSizePx !== undefined && (!finite(record.fontSizePx) || record.fontSizePx <= 0 || record.fontSizePx > MAX_MOTION_TEXT_RUN_FONT_SIZE_PX)) {
    throw new Error(`${label}.fontSizePx must be a finite number greater than 0 and at most ${MAX_MOTION_TEXT_RUN_FONT_SIZE_PX}.`);
  }
  if (record.letterSpacingPx !== undefined && (!finite(record.letterSpacingPx) || Math.abs(record.letterSpacingPx) > MAX_MOTION_TEXT_RUN_LETTER_SPACING_PX)) {
    throw new Error(`${label}.letterSpacingPx must be a finite number within ±${MAX_MOTION_TEXT_RUN_LETTER_SPACING_PX}.`);
  }
  return {
    text: record.text,
    fontAssetId: record.fontAssetId,
    ...(record.color === undefined ? {} : { color: record.color as string }),
    ...(record.fontSizePx === undefined ? {} : { fontSizePx: record.fontSizePx as number }),
    ...(record.letterSpacingPx === undefined ? {} : { letterSpacingPx: record.letterSpacingPx as number }),
  };
}

function motionFontAsset(value: unknown): MotionFontAsset | null {
  const asset = record(value); const source = record(asset?.source);
  if (!asset || asset.type !== "font" || !source || typeof asset.id !== "string" || typeof asset.family !== "string" || typeof source.path !== "string") return null;
  if (source.mimeType !== "font/woff2" && source.mimeType !== "font/woff" && source.mimeType !== "font/ttf" && source.mimeType !== "font/otf") return null;
  const weight = asset.weight === undefined ? undefined : asset.weight;
  const style = asset.style === undefined ? undefined : asset.style;
  if (weight !== undefined && (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > 1000)) return null;
  if (style !== undefined && style !== "normal" && style !== "italic" && style !== "oblique") return null;
  return { id: asset.id, type: "font", family: asset.family, source: { path: source.path, mimeType: source.mimeType }, ...(weight === undefined ? {} : { weight }), ...(style === undefined ? {} : { style }) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function utf8Bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
