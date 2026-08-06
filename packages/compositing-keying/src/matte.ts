import type { MotionMatteCleanup } from "@shellx-motion/core";

export const MAX_KEYING_PIXELS = 8_847_360;

export interface MatteCleanupEvidence {
  pixels: number;
  denoiseRadiusPx: number;
  growShrinkPx: number;
  chokePx: number;
  featherPx: number;
  blackClip: number;
  whiteClip: number;
}

export function cleanupMatte(
  source: Uint8Array,
  width: number,
  height: number,
  settings: Required<MotionMatteCleanup>,
): { alpha: Uint8Array; evidence: MatteCleanupEvidence } {
  assertMatteInput(source, width, height, settings);
  let alpha: Uint8Array = new Uint8Array(source);
  if (settings.denoiseRadiusPx > 0) alpha = denoiseAlpha(alpha, width, height, settings.denoiseRadiusPx);
  if (settings.growShrinkPx !== 0) {
    alpha = morphology(alpha, width, height, Math.abs(settings.growShrinkPx), settings.growShrinkPx > 0 ? "grow" : "shrink");
  }
  if (settings.chokePx > 0) alpha = morphology(alpha, width, height, settings.chokePx, "shrink");
  if (settings.featherPx > 0) alpha = boxBlurAlpha(alpha, width, height, settings.featherPx);
  alpha = clipAlpha(alpha, settings.blackClip, settings.whiteClip);
  return {
    alpha,
    evidence: {
      pixels: width * height,
      denoiseRadiusPx: settings.denoiseRadiusPx,
      growShrinkPx: settings.growShrinkPx,
      chokePx: settings.chokePx,
      featherPx: settings.featherPx,
      blackClip: settings.blackClip,
      whiteClip: settings.whiteClip,
    },
  };
}

function assertMatteInput(
  source: Uint8Array,
  width: number,
  height: number,
  settings: Required<MotionMatteCleanup>,
): void {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || pixels > MAX_KEYING_PIXELS) {
    throw new Error(`Keying matte dimensions must contain 1..${MAX_KEYING_PIXELS} pixels.`);
  }
  if (source.length !== pixels) throw new Error("Keying matte byte length does not match its dimensions.");
  if (!Number.isInteger(settings.denoiseRadiusPx) || settings.denoiseRadiusPx < 0 || settings.denoiseRadiusPx > 4) throw new Error("Matte denoiseRadiusPx must be an integer from 0 to 4.");
  if (!Number.isInteger(settings.growShrinkPx) || settings.growShrinkPx < -16 || settings.growShrinkPx > 16) throw new Error("Matte growShrinkPx must be an integer from -16 to 16.");
  if (!Number.isInteger(settings.chokePx) || settings.chokePx < 0 || settings.chokePx > 16) throw new Error("Matte chokePx must be an integer from 0 to 16.");
  if (!Number.isInteger(settings.featherPx) || settings.featherPx < 0 || settings.featherPx > 32) throw new Error("Matte featherPx must be an integer from 0 to 32.");
  if (!unit(settings.blackClip) || !unit(settings.whiteClip) || settings.blackClip >= settings.whiteClip) throw new Error("Matte clips must satisfy 0 <= blackClip < whiteClip <= 1.");
}

function denoiseAlpha(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const blurred = boxBlurAlpha(source, width, height, radius);
  const output = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const difference = Math.abs(source[index] - blurred[index]);
    output[index] = difference >= 48 ? blurred[index] : Math.round(source[index] * 0.75 + blurred[index] * 0.25);
  }
  return output;
}

function morphology(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  mode: "grow" | "shrink",
): Uint8Array {
  const horizontal = new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  const queueIndices = new Int32Array(Math.max(width, height) + radius * 2);
  const queueValues = new Uint8Array(queueIndices.length);
  for (let y = 0; y < height; y += 1) {
    extremaLine(
      width,
      radius,
      mode,
      (x) => source[y * width + x],
      (x, value) => { horizontal[y * width + x] = value; },
      queueIndices,
      queueValues,
    );
  }
  for (let x = 0; x < width; x += 1) {
    extremaLine(
      height,
      radius,
      mode,
      (y) => horizontal[y * width + x],
      (y, value) => { output[y * width + x] = value; },
      queueIndices,
      queueValues,
    );
  }
  return output;
}

function extremaLine(
  length: number,
  radius: number,
  mode: "grow" | "shrink",
  read: (index: number) => number,
  write: (index: number, value: number) => void,
  queueIndices: Int32Array,
  queueValues: Uint8Array,
): void {
  let head = 0;
  let tail = 0;
  for (let sample = -radius; sample < length + radius; sample += 1) {
    const value = read(clamp(sample, 0, length - 1));
    while (tail > head && (mode === "grow" ? value >= queueValues[tail - 1] : value <= queueValues[tail - 1])) tail -= 1;
    queueIndices[tail] = sample;
    queueValues[tail] = value;
    tail += 1;
    const windowStart = sample - radius * 2;
    while (tail > head && queueIndices[head] < windowStart) head += 1;
    const outputIndex = sample - radius;
    if (outputIndex >= 0 && outputIndex < length) write(outputIndex, queueValues[head]);
  }
}

function boxBlurAlpha(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Float64Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += source[y * width + clamp(x, 0, width - 1)];
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      sum += source[y * width + clamp(x + radius + 1, 0, width - 1)] - source[y * width + clamp(x - radius, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += horizontal[clamp(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = clamp(Math.round(sum / (radius * 2 + 1)), 0, 255);
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x] - horizontal[clamp(y - radius, 0, height - 1) * width + x];
    }
  }
  return output;
}

function clipAlpha(source: Uint8Array, blackClip: number, whiteClip: number): Uint8Array {
  const output = new Uint8Array(source.length);
  const span = whiteClip - blackClip;
  for (let index = 0; index < source.length; index += 1) {
    const normalized = source[index] / 255;
    output[index] = clamp(Math.round(((normalized - blackClip) / span) * 255), 0, 255);
  }
  return output;
}

function unit(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
