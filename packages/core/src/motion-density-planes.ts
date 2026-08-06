/**
 * motion-density-planes.ts — the pixel half of the freeze measurement.
 *
 * Split out of motion-density.ts so the measurement state machine, the pixel arithmetic, and the
 * author-facing text each stay inside the repository's strict per-module size cap. Nothing here
 * knows about runs, spans or warnings: it converts a decoded RGBA frame into the Y/Cb/Cr planes
 * `vf_freezedetect` compares, and computes the mean absolute frame difference between two of them.
 *
 * See the header of motion-density.ts for why this metric mirrors ffmpeg's and where it differs.
 */

/** A decoded frame: straight-alpha 8-bit RGBA, row-major, `width * height * 4` bytes. */
export interface MotionDensityFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Y at full resolution plus 2x2-subsampled Cb/Cr — the yuv420p sample layout freezedetect sees. */
export interface MotionPlanes {
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
  width: number;
  height: number;
  /** Y samples + both chroma planes' samples — the divisor in the mafd definition. */
  sampleCount: number;
}

/**
 * mafd, as `vf_freezedetect.c` defines it: total absolute difference across the Y/Cb/Cr planes,
 * divided by the sample count and by the 8-bit range. Integer accumulation, one division.
 */
export function meanAbsoluteFrameDifference(current: MotionPlanes, reference: MotionPlanes): number {
  let sad = 0;
  for (let index = 0; index < current.y.length; index += 1) sad += Math.abs(current.y[index] - reference.y[index]);
  for (let index = 0; index < current.cb.length; index += 1) sad += Math.abs(current.cb[index] - reference.cb[index]);
  for (let index = 0; index < current.cr.length; index += 1) sad += Math.abs(current.cr[index] - reference.cr[index]);
  return sad / current.sampleCount / 256;
}

// BT.709 luma coefficients scaled by 256 and summing to exactly 256, so luma is integer maths with
// a shift instead of three float multiplies per pixel. Integer accumulation also removes any
// float-ordering question from the plane values themselves.
const LUMA_R = 54;
const LUMA_G = 183;
const LUMA_B = 19;
// Chroma scale factors, pre-divided so the per-block conversion multiplies instead of divides.
const CB_SCALE = 1 / 1.8556;
const CR_SCALE = 1 / 1.5748;
// Reciprocals for 2x2 block sizes 1, 2 and 4 (edge blocks on odd dimensions are smaller).
const BLOCK_RECIPROCAL = [0, 1, 0.5, 1 / 3, 0.25];

export function allocatePlanes(width: number, height: number): MotionPlanes {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const y = new Uint8Array(width * height);
  const cb = new Uint8Array(chromaWidth * chromaHeight);
  const cr = new Uint8Array(chromaWidth * chromaHeight);
  return { y, cb, cr, width, height, sampleCount: y.length + cb.length + cr.length };
}

/**
 * Convert straight-alpha RGBA into Y (full resolution) and Cb/Cr (2x2 box-averaged, as yuv420p
 * subsamples). Alpha is composited over black first, matching what an encoder flattens transparent
 * renderer output to — otherwise a fully transparent frame and a black frame would compare as
 * different pictures when the delivered video shows both as black. Fully opaque pixels take a fast
 * path that skips the composite entirely, which is the overwhelmingly common case for delivered
 * renders.
 *
 * @param target A plane set to fill in place, or null to allocate a fresh one.
 */
export function fillPlanesFromRgba(frame: MotionDensityFrame, target: MotionPlanes | null): MotionPlanes {
  const { width, height, rgba } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Motion analysis needs positive integer frame dimensions, received ${width}x${height}.`);
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`Motion analysis expected ${width * height * 4} RGBA bytes, received ${rgba.length}.`);
  }
  const planes = target && target.width === width && target.height === height ? target : allocatePlanes(width, height);
  const { y, cb, cr } = planes;
  const chromaWidth = Math.ceil(width / 2);

  for (let row = 0; row < height; row += 2) {
    const rowPairHeight = row + 1 < height ? 2 : 1;
    for (let column = 0; column < width; column += 2) {
      const columnPairWidth = column + 1 < width ? 2 : 1;
      let blockR = 0;
      let blockG = 0;
      let blockB = 0;
      for (let dy = 0; dy < rowPairHeight; dy += 1) {
        const pixelRow = row + dy;
        const rowOffset = pixelRow * width;
        for (let dx = 0; dx < columnPairWidth; dx += 1) {
          const pixelIndex = rowOffset + column + dx;
          const offset = pixelIndex * 4;
          const alpha = rgba[offset + 3];
          let r = rgba[offset];
          let g = rgba[offset + 1];
          let b = rgba[offset + 2];
          if (alpha !== 255) {
            r = (r * alpha) / 255;
            g = (g * alpha) / 255;
            b = (b * alpha) / 255;
          }
          y[pixelIndex] = (LUMA_R * r + LUMA_G * g + LUMA_B * b) >> 8;
          blockR += r;
          blockG += g;
          blockB += b;
        }
      }
      const reciprocal = BLOCK_RECIPROCAL[rowPairHeight * columnPairWidth];
      const meanR = blockR * reciprocal;
      const meanG = blockG * reciprocal;
      const meanB = blockB * reciprocal;
      const meanY = (LUMA_R * meanR + LUMA_G * meanG + LUMA_B * meanB) / 256;
      const chromaOffset = (row >> 1) * chromaWidth + (column >> 1);
      cb[chromaOffset] = clampByte(128 + (meanB - meanY) * CB_SCALE);
      cr[chromaOffset] = clampByte(128 + (meanR - meanY) * CR_SCALE);
    }
  }

  return planes;
}

function clampByte(value: number): number {
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 255) return 255;
  return rounded;
}
