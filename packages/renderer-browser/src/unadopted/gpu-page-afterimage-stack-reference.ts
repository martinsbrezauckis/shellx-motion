import { admitGpuPageAfterimageStackDescriptor, type GpuPageAfterimageStackDescriptor } from "./gpu-page-afterimage-stack-admission";

export type GpuPageAfterimageStackPremultipliedPixel = readonly [number, number, number, number];

/**
 * Independent scalar test oracle for the fixed WGSL compositing contract.
 * It is not used to render frames: Chromium always executes the fixed WGSL.
 */
export function evaluateGpuPageAfterimageStackPixel(
  descriptorValue: GpuPageAfterimageStackDescriptor,
  x: number,
  y: number,
  sourceAt: (x: number, y: number) => GpuPageAfterimageStackPremultipliedPixel
): GpuPageAfterimageStackPremultipliedPixel {
  const descriptor = admitGpuPageAfterimageStackDescriptor(descriptorValue);
  if (!descriptor || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= descriptor.width || y >= descriptor.height) throw new Error("GPU afterimage reference requires an admitted in-bounds pixel.");
  const current = checkedPixel(sourceAt(x, y));
  let echoes: GpuPageAfterimageStackPremultipliedPixel = [0, 0, 0, 0];
  for (let index = descriptor.echoes.length - 1; index >= 0; index -= 1) {
    const echo = descriptor.echoes[index];
    const sourceX = x - echo.dxPx;
    const sourceY = y - echo.dyPx;
    const sourceAlpha = sourceX < 0 || sourceY < 0 || sourceX >= descriptor.width || sourceY >= descriptor.height ? 0 : checkedPixel(sourceAt(sourceX, sourceY))[3];
    const alpha = clamp(sourceAlpha * (echo.rgba8[3] / 255) * (echo.opacityQ16 / 65_535) * (descriptor.amountQ16 / 65_535));
    const colored: GpuPageAfterimageStackPremultipliedPixel = [echo.rgba8[0] / 255 * alpha, echo.rgba8[1] / 255 * alpha, echo.rgba8[2] / 255 * alpha, alpha];
    echoes = over(colored, echoes);
  }
  const output = over(current, echoes);
  return [clamp(output[0]), clamp(output[1]), clamp(output[2]), clamp(output[3])];
}

function over(front: GpuPageAfterimageStackPremultipliedPixel, back: GpuPageAfterimageStackPremultipliedPixel): GpuPageAfterimageStackPremultipliedPixel {
  return [front[0] + back[0] * (1 - front[3]), front[1] + back[1] * (1 - front[3]), front[2] + back[2] * (1 - front[3]), front[3] + back[3] * (1 - front[3])];
}

function checkedPixel(value: GpuPageAfterimageStackPremultipliedPixel): GpuPageAfterimageStackPremultipliedPixel {
  if (!Array.isArray(value) || value.length !== 4 || value.some((channel) => typeof channel !== "number" || !Number.isFinite(channel) || channel < 0 || channel > 1)) throw new Error("GPU afterimage reference source returned an invalid premultiplied pixel.");
  return value;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
