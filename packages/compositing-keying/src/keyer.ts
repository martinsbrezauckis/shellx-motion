import {
  resolvedMotionChromaKey,
  validateLayerKeyingAndRoto,
  type MotionChromaKey,
} from "@shellx-motion/core";
import { cleanupMatte, MAX_KEYING_PIXELS, type MatteCleanupEvidence } from "./matte";

export interface ChromaKeyFrameInput {
  rgba: Uint8Array;
  width: number;
  height: number;
  keying: MotionChromaKey;
}

export interface ChromaKeyEvidence {
  schema: "shellx-motion/chroma-key-evidence@1";
  pixels: number;
  transparentPixels: number;
  edgePixels: number;
  opaquePixels: number;
  spillAdjustedPixels: number;
  matte: MatteCleanupEvidence;
}

export interface ChromaKeyFrameResult {
  rgba: Uint8Array;
  matte: Uint8Array;
  evidence: ChromaKeyEvidence;
}

export function applyChromaKeyFrame(input: ChromaKeyFrameInput): ChromaKeyFrameResult {
  assertFrame(input);
  const contractIssues = validateLayerKeyingAndRoto(
    { type: "video", keying: input.keying },
    "/frame",
  );
  if (contractIssues.length > 0) {
    const first = contractIssues[0];
    throw new Error(`Invalid chroma key at ${first.path}: ${first.message}.`);
  }
  const settings = resolvedMotionChromaKey(input.keying);
  const key = parseHex(settings.keyColor);
  const keyChroma = chroma(key.r, key.g, key.b);
  const matte = new Uint8Array(input.width * input.height);
  const corrected = new Uint8Array(input.rgba);
  let spillAdjustedPixels = 0;
  for (let pixel = 0; pixel < matte.length; pixel += 1) {
    const offset = pixel * 4;
    const r = input.rgba[offset];
    const g = input.rgba[offset + 1];
    const b = input.rgba[offset + 2];
    const sourceAlpha = input.rgba[offset + 3] / 255;
    const pixelChroma = chroma(r, g, b);
    const distance = Math.hypot(pixelChroma.cb - keyChroma.cb, pixelChroma.cr - keyChroma.cr) / 1.5;
    const threshold = settings.similarity * (0.75 + settings.shadow * 0.25 * luminance(r, g, b));
    const foreground = smoothstep(threshold, threshold + Math.max(0.0001, settings.smoothness), distance);
    matte[pixel] = clampByte(foreground * sourceAlpha * 255);
    const spillWeight = 1 - foreground;
    const spill = suppressSpill(
      { r, g, b },
      key,
      settings.spillSuppression * spillWeight,
      settings.spillBalance,
      settings.edgeColorCorrection * spillWeight,
    );
    corrected[offset] = spill.r;
    corrected[offset + 1] = spill.g;
    corrected[offset + 2] = spill.b;
    if (spill.changed) spillAdjustedPixels += 1;
  }
  const cleaned = cleanupMatte(matte, input.width, input.height, settings.matte);
  const finalMatte = new Uint8Array(cleaned.alpha.length);
  let transparentPixels = 0;
  let edgePixels = 0;
  let opaquePixels = 0;
  for (let pixel = 0; pixel < cleaned.alpha.length; pixel += 1) {
    // Matte cleanup may grow an edge, but it must never resurrect source-transparent pixels.
    const alpha = Math.min(cleaned.alpha[pixel], input.rgba[pixel * 4 + 3]);
    finalMatte[pixel] = alpha;
    corrected[pixel * 4 + 3] = alpha;
    if (alpha === 0) transparentPixels += 1;
    else if (alpha === 255) opaquePixels += 1;
    else edgePixels += 1;
  }
  return {
    rgba: corrected,
    matte: finalMatte,
    evidence: {
      schema: "shellx-motion/chroma-key-evidence@1",
      pixels: cleaned.alpha.length,
      transparentPixels,
      edgePixels,
      opaquePixels,
      spillAdjustedPixels,
      matte: cleaned.evidence,
    },
  };
}

function assertFrame(input: ChromaKeyFrameInput): void {
  const pixels = input.width * input.height;
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1 || pixels > MAX_KEYING_PIXELS) {
    throw new Error(`Chroma key dimensions must contain 1..${MAX_KEYING_PIXELS} pixels.`);
  }
  if (input.rgba.length !== pixels * 4) throw new Error("Chroma key RGBA byte length does not match its dimensions.");
}

function suppressSpill(
  color: { r: number; g: number; b: number },
  key: { r: number; g: number; b: number },
  amount: number,
  balance: number,
  edgeCorrection: number,
): { r: number; g: number; b: number; changed: boolean } {
  const channels = [color.r, color.g, color.b];
  const keyChannels = [key.r, key.g, key.b];
  const dominant = keyChannels.indexOf(Math.max(...keyChannels));
  const others = [0, 1, 2].filter((index) => index !== dominant);
  const neutral = lerp(channels[others[0]], channels[others[1]], (balance + 1) / 2);
  const excess = Math.max(0, channels[dominant] - neutral);
  const reduction = excess * clamp(amount + edgeCorrection, 0, 1);
  channels[dominant] -= reduction;
  if (edgeCorrection > 0) {
    const correction = reduction * edgeCorrection * 0.35;
    channels[others[0]] += correction * (1 - balance) / 2;
    channels[others[1]] += correction * (1 + balance) / 2;
  }
  return {
    r: clampByte(channels[0]),
    g: clampByte(channels[1]),
    b: clampByte(channels[2]),
    changed: reduction >= 0.5,
  };
}

function chroma(r: number, g: number, b: number): { cb: number; cr: number } {
  return {
    cb: (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255,
    cr: (0.5 * r - 0.418688 * g - 0.081312 * b) / 255,
  };
}

function parseHex(value: string): { r: number; g: number; b: number } {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Chroma key color must be a six-digit hex color.");
  return { r: Number.parseInt(value.slice(1, 3), 16), g: Number.parseInt(value.slice(3, 5), 16), b: Number.parseInt(value.slice(5, 7), 16) };
}

function luminance(r: number, g: number, b: number): number { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function smoothstep(edge0: number, edge1: number, value: number): number { const x = clamp((value - edge0) / (edge1 - edge0), 0, 1); return x * x * (3 - 2 * x); }
function lerp(left: number, right: number, amount: number): number { return left + (right - left) * amount; }
function clampByte(value: number): number { return Math.round(clamp(value, 0, 255)); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
