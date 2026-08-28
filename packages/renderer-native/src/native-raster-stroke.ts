import { clamp, type Rgba } from "./native-raster-primitives";

/** Narrow raster surface used by the CPU round-cap line primitive. */
export interface NativeRasterStrokeSurface {
  readonly width: number;
  readonly height: number;
  strokePixel(x: number, y: number, color: Rgba): void;
}

/** Bounded round-cap line rasterization; callers run transformed work admission first. */
export function strokeNativeRgbaLine(
  surface: NativeRasterStrokeSurface,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: Rgba
): void {
  if (![x0, y0, x1, y1, width].every(Number.isFinite) || width <= 0) return;
  const radius = width / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  const xMajor = Math.abs(dx) >= Math.abs(dy);
  const majorStart = Math.max(0, Math.floor((xMajor ? Math.min(x0, x1) : Math.min(y0, y1)) - radius));
  const majorEnd = Math.min((xMajor ? surface.width : surface.height) - 1, Math.ceil((xMajor ? Math.max(x0, x1) : Math.max(y0, y1)) + radius));
  for (let major = majorStart; major <= majorEnd; major += 1) {
    const projection = xMajor
      ? (dx === 0 ? 0 : clamp((major + 0.5 - x0) / dx, 0, 1))
      : (dy === 0 ? 0 : clamp((major + 0.5 - y0) / dy, 0, 1));
    const center = xMajor ? y0 + projection * dy : x0 + projection * dx;
    const minorStart = Math.max(0, Math.floor(center - radius));
    const minorEnd = Math.min((xMajor ? surface.height : surface.width) - 1, Math.ceil(center + radius));
    for (let minor = minorStart; minor <= minorEnd; minor += 1) {
      const px = xMajor ? major : minor;
      const py = xMajor ? minor : major;
      const t = lengthSquared === 0 ? 0 : clamp((((px + 0.5 - x0) * dx) + ((py + 0.5 - y0) * dy)) / lengthSquared, 0, 1);
      const nearestX = x0 + t * dx;
      const nearestY = y0 + t * dy;
      if ((px + 0.5 - nearestX) ** 2 + (py + 0.5 - nearestY) ** 2 <= radius ** 2) surface.strokePixel(px, py, color);
    }
  }
}
