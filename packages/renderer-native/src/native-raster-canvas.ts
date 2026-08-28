import { blendRgb } from "./native-raster-blend";
import { clipContains, ellipseContains, intersectClips, normalizeClip, roundedRectContains, starPoints, triangleContains, triangleEdgeDistance, trianglePoints } from "./native-raster-geometry";
import { pathPolygonPoints, polygonContains, polygonEdgeDistance } from "./native-raster-path";
import { clamp, type NativeBlendMode, type NativeClip, type PolygonPoint, type Rgba } from "./native-raster-primitives";
import { strokeNativeRgbaLine } from "./native-raster-stroke"; import type { NativeImage } from "./native-png";
import { fillNativeFlatColoredTriangles } from "./native-raster-triangles";
export class RgbaCanvas {
  readonly data: Buffer;
  private readonly clipStack: NativeClip[] = [];
  constructor(readonly width: number, readonly height: number) {
    this.data = Buffer.alloc(width * height * 4);
  }
  fill(color: Rgba): void { this.fillRect(0, 0, this.width, this.height, color); }
  composite(source: RgbaCanvas, blendMode: NativeBlendMode | null = null): void {
    for (let sy = 0; sy < source.height; sy += 1) {
      for (let sx = 0; sx < source.width; sx += 1) {
        const sourceOffset = (sy * source.width + sx) * 4;
        const alpha = source.data[sourceOffset + 3];
        if (alpha <= 0) continue;
        this.compositePixel(sx, sy, {
          r: source.data[sourceOffset],
          g: source.data[sourceOffset + 1],
          b: source.data[sourceOffset + 2],
          a: alpha
        }, blendMode);
      }
    }
  }
  compositeRotated(source: RgbaCanvas, anchorX: number, anchorY: number, rotationDegrees: number, blendMode: NativeBlendMode | null = null): void {
    const radians = (rotationDegrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (let sy = 0; sy < source.height; sy += 1) {
      for (let sx = 0; sx < source.width; sx += 1) {
        const sourceOffset = (sy * source.width + sx) * 4;
        const alpha = source.data[sourceOffset + 3];
        if (alpha <= 0) continue;
        const dx = sx + 0.5 - anchorX;
        const dy = sy + 0.5 - anchorY;
        const targetX = Math.round(anchorX + (dx * cos) - (dy * sin) - 0.5);
        const targetY = Math.round(anchorY + (dx * sin) + (dy * cos) - 0.5);
        if (targetX < 0 || targetY < 0 || targetX >= this.width || targetY >= this.height) continue;
        this.compositePixel(targetX, targetY, {
          r: source.data[sourceOffset],
          g: source.data[sourceOffset + 1],
          b: source.data[sourceOffset + 2],
          a: alpha
        }, blendMode);
      }
    }
  }
  withClip(clip: NativeClip | null, paint: () => void): void {
    if (!clip) {
      paint();
      return;
    }
    const normalized = normalizeClip(clip);
    const bounded = intersectClips(this.currentClipBounds(), normalized);
    if (bounded.width <= 0 || bounded.height <= 0) return;
    this.clipStack.push(normalized);
    try {
      paint();
    } finally {
      this.clipStack.pop();
    }
  }
  fillRect(x: number, y: number, width: number, height: number, color: Rgba): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        this.setPixel(px, py, color);
      }
    }
  }
  strokeRect(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    this.fillRect(x, y, width, size, color);
    this.fillRect(x, y + height - size, width, size, color);
    this.fillRect(x, y, size, height, color);
    this.fillRect(x + width - size, y, size, height, color);
  }
  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number, color: Rgba): void {
    if (radius <= 0) {
      this.fillRect(x, y, width, height, color);
      return;
    }
    this.paintRoundedRect(x, y, width, height, radius, color, () => true);
  }
  strokeRoundedRect(x: number, y: number, width: number, height: number, strokeWidth: number, radius: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width / 2, height / 2));
    if (size <= 0) return;
    if (radius <= 0) {
      this.strokeRect(x, y, width, height, size, color);
      return;
    }
    const innerX = x + size;
    const innerY = y + size;
    const innerWidth = Math.max(0, width - size * 2);
    const innerHeight = Math.max(0, height - size * 2);
    const innerRadius = Math.max(0, radius - size);
    this.paintRoundedRect(x, y, width, height, radius, color, (px, py) => {
      return !roundedRectContains(px, py, innerX, innerY, innerWidth, innerHeight, innerRadius);
    });
  }
  fillEllipse(x: number, y: number, width: number, height: number, color: Rgba): void { this.paintEllipse(x, y, width, height, color, () => true); }
  strokeLine(x0: number, y0: number, x1: number, y1: number, width: number, color: Rgba): void { strokeNativeRgbaLine(this, x0, y0, x1, y1, width, color); }
  strokePixel(x: number, y: number, color: Rgba): void { this.setPixel(x, y, color); }
  strokeEllipse(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width / 2, height / 2));
    if (size <= 0) return;
    const innerX = x + size;
    const innerY = y + size;
    const innerWidth = Math.max(0, width - size * 2);
    const innerHeight = Math.max(0, height - size * 2);
    this.paintEllipse(x, y, width, height, color, (px, py) => {
      return !ellipseContains(px, py, innerX, innerY, innerWidth, innerHeight);
    });
  }
  fillTriangle(x: number, y: number, width: number, height: number, color: Rgba): void { this.paintTriangle(x, y, width, height, color, () => true); }
  fillFlatColoredTriangles(vertices: readonly { x: number; y: number; color: Rgba }[]): void {
    fillNativeFlatColoredTriangles(this, vertices);
  }
  paintTrianglePixel(x: number, y: number, color: Rgba): void { this.setPixel(x, y, color); }
  strokeTriangle(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    const points = trianglePoints(x, y, width, height);
    this.paintTriangle(x, y, width, height, color, (px, py) => triangleEdgeDistance(px, py, points) <= size);
  }
  fillStar(x: number, y: number, width: number, height: number, color: Rgba): void {
    this.paintStar(x, y, width, height, color, () => true);
  }
  strokeStar(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    const points = starPoints(x, y, width, height);
    this.paintStar(x, y, width, height, color, (px, py) => polygonEdgeDistance(px, py, points) <= size);
  }
  fillPathShape(x: number, y: number, width: number, height: number, pathData: string, color: Rgba): void {
    const points = pathPolygonPoints(pathData, x, y, width, height);
    this.paintPolygon(x, y, width, height, points, color, () => true);
  }
  strokePathShape(x: number, y: number, width: number, height: number, strokeWidth: number, pathData: string, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    const points = pathPolygonPoints(pathData, x, y, width, height);
    this.paintPolygon(x, y, width, height, points, color, (px, py) => polygonEdgeDistance(px, py, points) <= size);
  }
  drawImage(
    image: NativeImage,
    placement: NativeClip,
    opacity: number,
    roundedClip: { box: NativeClip; radius: number } | null = null,
    sourceRect: NativeClip = { x: 0, y: 0, width: image.width, height: image.height }
  ): void {
    if (placement.width <= 0 || placement.height <= 0 || opacity <= 0) return;
    const minX = Math.max(0, Math.floor(placement.x));
    const minY = Math.max(0, Math.floor(placement.y));
    const maxX = Math.min(this.width, Math.ceil(placement.x + placement.width));
    const maxY = Math.min(this.height, Math.ceil(placement.y + placement.height));
    for (let py = minY; py < maxY; py += 1) {
      const v = clamp((py + 0.5 - placement.y) / placement.height, 0, 1);
      const sourceY = clamp(Math.floor(sourceRect.y + (v * sourceRect.height)), 0, image.height - 1);
      for (let px = minX; px < maxX; px += 1) {
        if (roundedClip && !roundedRectContains(px + 0.5, py + 0.5, roundedClip.box.x, roundedClip.box.y, roundedClip.box.width, roundedClip.box.height, roundedClip.radius)) {
          continue;
        }
        const u = clamp((px + 0.5 - placement.x) / placement.width, 0, 1);
        const sourceX = clamp(Math.floor(sourceRect.x + (u * sourceRect.width)), 0, image.width - 1);
        const sourceOffset = (sourceY * image.width + sourceX) * 4;
        const alpha = Math.round(image.rgba[sourceOffset + 3] * opacity);
        if (alpha <= 0) continue;
        this.setPixel(px, py, {
          r: image.rgba[sourceOffset],
          g: image.rgba[sourceOffset + 1],
          b: image.rgba[sourceOffset + 2],
          a: alpha
        });
      }
    }
  }
  private paintEllipse(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (ellipseContains(sampleX, sampleY, x, y, width, height) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }
  private paintTriangle(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    const points = trianglePoints(x, y, width, height);
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (triangleContains(sampleX, sampleY, points) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }
  private paintStar(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    const points = starPoints(x, y, width, height);
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (polygonContains(sampleX, sampleY, points) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }
  private paintPolygon(
    x: number,
    y: number,
    width: number,
    height: number,
    points: PolygonPoint[],
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (polygonContains(sampleX, sampleY, points) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }
  private paintRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (roundedRectContains(sampleX, sampleY, x, y, width, height, radius) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }
  private setPixel(x: number, y: number, color: Rgba): void {
    if (!this.clipStack.every((clip) => clipContains(clip, x, y))) return;
    const offset = (y * this.width + x) * 4;
    if (color.a === 255) {
      this.data[offset] = color.r;
      this.data[offset + 1] = color.g;
      this.data[offset + 2] = color.b;
      this.data[offset + 3] = color.a;
      return;
    }
    const sourceAlpha = color.a / 255;
    const targetAlpha = this.data[offset + 3] / 255;
    const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
    if (outAlpha === 0) {
      this.data[offset] = 0;
      this.data[offset + 1] = 0;
      this.data[offset + 2] = 0;
      this.data[offset + 3] = 0;
      return;
    }
    this.data[offset] = Math.round((color.r * sourceAlpha + this.data[offset] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    this.data[offset + 1] = Math.round((color.g * sourceAlpha + this.data[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    this.data[offset + 2] = Math.round((color.b * sourceAlpha + this.data[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    this.data[offset + 3] = Math.round(outAlpha * 255);
  }
  private compositePixel(x: number, y: number, source: Rgba, blendMode: NativeBlendMode | null): void {
    if (blendMode === null) {
      this.setPixel(x, y, source);
      return;
    }
    const offset = (y * this.width + x) * 4;
    const backdrop: Rgba = {
      r: this.data[offset],
      g: this.data[offset + 1],
      b: this.data[offset + 2],
      a: this.data[offset + 3]
    };
    if (backdrop.a <= 0) {
      this.setPixel(x, y, source);
      return;
    }
    this.setPixel(x, y, {
      ...blendRgb(blendMode, backdrop, source),
      a: source.a
    });
  }
  private currentClipBounds(): NativeClip | null {
    return this.clipStack.reduce<NativeClip | null>((bounds, clip) => intersectClips(bounds, clip), null);
  }
}
