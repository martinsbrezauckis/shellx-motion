/**
 * GPU shape spellings that have an exact fixed-primitive lowering. `rectangle` and
 * `rounded-rect` share rectangle geometry; radius, stroke, and shadow remain style
 * data and select the fixed styled-rectangle pipeline when present.
 */
export type GpuScenePrimitiveShape = "rect" | "ellipse" | "triangle" | "star";

export function canonicalGpuScenePrimitiveShape(value: unknown): GpuScenePrimitiveShape | null {
  if (value === "rect" || value === "rectangle" || value === "rounded-rect") return "rect";
  if (value === "ellipse" || value === "triangle" || value === "star") return value;
  return null;
}

export function isGpuSceneTriangleShape(value: unknown): value is "triangle" | "star" {
  return value === "triangle" || value === "star";
}

/**
 * This remains a refusal rather than a tessellation promise. Motion's browser path
 * contract carries SVG text in `x-*` extension fields, not typed bounded GPU
 * contours, closure/fill-rule, or a versioned tessellation contract.
 */
export function gpuSceneUnsupportedShapeMessage(layerId: string, value: unknown): string {
  const shape = typeof value === "string" && value.length > 0 ? value : "unspecified";
  if (shape === "path" || shape === "freeform") {
    return `GPU scene refuses ${shape} shape ${layerId}: browser SVG path text has no typed bounded GPU contour and tessellation contract.`;
  }
  return `GPU scene supports rect (including rectangle and rounded-rect aliases), ellipse, triangle and star shapes; layer ${layerId} uses '${shape}'.`;
}

export function shapeTriangleVertices(
  shape: "triangle" | "star",
  box: { x: number; y: number; width: number; height: number }
): Array<{ x: number; y: number }> {
  if (shape === "triangle") return [
    { x: box.x + box.width / 2, y: box.y },
    { x: box.x, y: box.y + box.height },
    { x: box.x + box.width, y: box.y + box.height }
  ];
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const boundary = Array.from({ length: 10 }, (_value, index) => {
    const angle = (-Math.PI / 2) + (index * Math.PI / 5);
    const radius = index % 2 === 0 ? 0.5 : 0.225;
    return { x: center.x + Math.cos(angle) * box.width * radius, y: center.y + Math.sin(angle) * box.height * radius };
  });
  return boundary.flatMap((point, index) => [center, point, boundary[(index + 1) % boundary.length]]);
}
