/** Convert WebGPU's premultiplied rgba8unorm readback into tightly packed straight-alpha sRGB. */
export function gpuStraightRgba(input: { rgba: Uint8Array; width: number; height: number }): Buffer {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error("GPU RGBA dimensions must be positive integers.");
  }
  if (input.rgba.byteLength !== input.width * input.height * 4) {
    throw new Error("GPU RGBA byte length does not match its dimensions.");
  }
  const straight = Buffer.from(input.rgba);
  return gpuStraightRgbaInPlace({ rgba: straight, width: input.width, height: input.height });
}

/**
 * Normalize an exclusively owned tight RGBA buffer without another allocation
 * or byte-for-byte copy. Callers must not pass a shared buffer: this function
 * intentionally mutates its input. The GPU readback path supplies either the
 * fresh canonical base64 decode or its fresh padded-row compaction result.
 */
export function gpuStraightRgbaInPlace(input: { rgba: Buffer; width: number; height: number }): Buffer {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error("GPU RGBA dimensions must be positive integers.");
  }
  if (input.rgba.byteLength !== input.width * input.height * 4) {
    throw new Error("GPU RGBA byte length does not match its dimensions.");
  }
  for (let offset = 0; offset < input.rgba.byteLength; offset += 4) {
    const alpha = input.rgba[offset + 3];
    if (alpha === 0) {
      input.rgba[offset] = 0;
      input.rgba[offset + 1] = 0;
      input.rgba[offset + 2] = 0;
    } else {
      input.rgba[offset] = unpremultiply(input.rgba[offset], alpha);
      input.rgba[offset + 1] = unpremultiply(input.rgba[offset + 1], alpha);
      input.rgba[offset + 2] = unpremultiply(input.rgba[offset + 2], alpha);
    }
  }
  return input.rgba;
}

function unpremultiply(channel: number, alpha: number): number {
  return Math.max(0, Math.min(255, Math.round((channel * 255) / alpha)));
}
