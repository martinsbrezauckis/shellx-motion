import { describe, expect, it } from "vitest";
import type { MotionLayer, MotionPackage } from "@shellx-motion/core";
import {
  generatedMatteShapeGeometry,
  generatedShapeKind,
  renderGeneratedSvgShape,
  svgGradientDef,
} from "./generated-svg-shapes";

const htmlFormatting = {
  escapeAttr: (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char),
  formatNumber: (value: number) => Number(value.toFixed(9)).toString(),
  cssColor: (value: unknown, _pkg: MotionPackage, fallback: string) => typeof value === "string" ? value : fallback
};

function shapeLayer(overrides: Record<string, unknown>): MotionLayer {
  return {
    id: "shape",
    type: "shape",
    startMs: 0,
    durationMs: 100,
    ...overrides
  } as MotionLayer;
}

describe("generated SVG shapes", () => {
  it("maps freeform geometry to a path and preserves the escaped SVG drawing markup", () => {
    const layer = shapeLayer({
      shape: "freeform",
      "x-path": "M 0 0 L 100 100 Z",
      style: { strokeLinecap: "round" }
    });

    expect(generatedShapeKind(layer)).toBe("path");
    expect(renderGeneratedSvgShape({
      shapeKind: "path",
      layer,
      index: 2,
      atMs: 50,
      fill: "#ffffff",
      stroke: "#000000",
      strokeWidth: "2px",
      shadow: null,
      labelHtml: "",
      align: ""
    }, {
      escapeAttr: htmlFormatting.escapeAttr,
      boxStyle: () => "position:absolute;"
    })).toContain('<path d="M 0 0 L 100 100 Z" fill="#ffffff" stroke="#000000" stroke-width="2px" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>');
  });

  it("uses the established formatters and escaping for SVG paint servers", () => {
    const layer = shapeLayer({
      gradient: {
        type: "radial",
        centerX: 0.5,
        centerY: 0.25,
        stops: [
          { offset: 0, color: "#fff" },
          { offset: 1, color: "red&blue" }
        ]
      }
    });

    expect(svgGradientDef(layer, {} as MotionPackage, "grad&shape", htmlFormatting)).toEqual({
      id: "grad&shape",
      def: '<radialGradient id="grad&amp;shape" cx="50%" cy="25%" r="50%"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="red&amp;blue"/></radialGradient>'
    });
  });

  it("uses a validated non-zero viewBox for path mattes", () => {
    const geometry = generatedMatteShapeGeometry(shapeLayer({
      shape: "path",
      "x-path": "M 10 20 L 170 20 L 90 120 Z",
      "x-path-viewBox": "10 20 160 100"
    }), htmlFormatting);

    expect(geometry).toMatchObject({
      viewBox: { x: 10, y: 20, width: 160, height: 100 },
      element: '<path d="M 10 20 L 170 20 L 90 120 Z" fill="MATTE_FILL"></path>'
    });
  });
});
