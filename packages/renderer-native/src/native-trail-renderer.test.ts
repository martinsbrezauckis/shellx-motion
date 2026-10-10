import { describe, expect, it, vi } from "vitest";
import { drawNativeTrail } from "./native-trail-renderer";

describe("native trail work admission before layer rotation", () => {
  const dimensions = { width: 1280, height: 720 };
  const transform = { x: 0, y: 0, scale: 1, originX: 0, originY: 0, rotation: 180 };

  it("refuses excessive pre-rotation strokes before painting any segment", () => {
    const strokeLine = vi.fn();
    const segments = Array.from({ length: 300 }, () => ({
      x0: 200, y0: 200, x1: 400, y1: 200, width: 32, opacity: 1,
    }));

    expect(() => drawNativeTrail({
      canvas: { strokeLine }, segments, transform, dimensions, viewport: dimensions,
      colorFor: () => "#ffffff",
    })).toThrow(/trail.*(work|budget|stroke)/i);
    expect(strokeLine).not.toHaveBeenCalled();
  });

  it("charges and draws ordinary strokes in the coordinates painted before rotation", () => {
    const strokeLine = vi.fn();
    const result = drawNativeTrail({
      canvas: { strokeLine },
      segments: [{ x0: 10, y0: 10, x1: 20, y1: 10, width: 2, opacity: 1 }],
      transform, dimensions, viewport: dimensions, colorFor: () => "#ffffff",
    });

    expect(strokeLine).toHaveBeenCalledExactlyOnceWith(10, 10, 20, 10, 2, "#ffffff");
    expect(result.segments).toBe(1);
    expect(result.strokePixels).toBe(24);
  });
});
