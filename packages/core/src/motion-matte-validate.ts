import { parseMotionPathViewBox, validateMotionPathData } from "./path-contract";

export interface MotionValidationIssue {
  path: string;
  message: string;
}

export function validateLayerMattes(
  layers: unknown[],
  layerIds: Set<string>,
  errors: MotionValidationIssue[],
): void {
  const byId = new Map<string, { layer: Record<string, unknown>; index: number }>();
  layers.forEach((value, index) => {
    const layer = readRecord(value);
    const id = readNonEmptyString(layer?.id);
    if (layer && id) byId.set(id, { layer, index });
  });
  layers.forEach((value, index) => {
    const consumer = readRecord(value);
    if (!consumer || !("matte" in consumer)) return;
    const path = `/layers/${index}/matte`;
    const matte = readRecord(consumer.matte);
    if (!matte) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    if (!isMatteType(matte.type)) {
      errors.push({
        path: `${path}/type`,
        message: "must be alpha, alpha-inverted, luma, or luma-inverted",
      });
    }
    const sourceLayerId = readNonEmptyString(matte.sourceLayerId);
    if (!sourceLayerId || !layerIds.has(sourceLayerId)) {
      errors.push({
        path: `${path}/sourceLayerId`,
        message: "must reference an existing layer id",
      });
      return;
    }
    if (sourceLayerId === consumer.id) {
      errors.push({
        path: `${path}/sourceLayerId`,
        message: "cannot reference the consumer layer",
      });
      return;
    }
    const source = byId.get(sourceLayerId);
    if (!source) return;
    validateStaticShapeMatteSource(source.layer, `/layers/${source.index}`, errors);
    validateMatteTransform(consumer, `/layers/${index}`, "consumer", errors);
  });
}

function validateStaticShapeMatteSource(
  source: Record<string, unknown>,
  path: string,
  errors: MotionValidationIssue[],
): void {
  if (source.type !== "shape") {
    errors.push({ path: `${path}/type`, message: "matte sources currently require a shape layer" });
    return;
  }
  const shape = source.shape === "rectangle" ? "rect" : source.shape;
  if (!["rect", "ellipse", "triangle", "star", "path", "freeform"].includes(String(shape))) {
    errors.push({ path: `${path}/shape`, message: "unsupported matte source shape" });
  }
  if (shape === "path" || shape === "freeform") validateMattePath(source, path, errors);
  for (const field of [
    "matte", "mask", "effects", "blendMode", "transitions", "keyframes", "label",
  ] as const) {
    if (field in source) {
      errors.push({ path: `${path}/${field}`, message: "not supported on matte source layers" });
    }
  }
  validateMatteStyle(source, path, errors);
  if (source.visible === false) {
    errors.push({ path: `${path}/visible`, message: "matte source layers must remain enabled" });
  }
  validateMatteTransform(source, path, "source", errors);
}

function validateMattePath(
  source: Record<string, unknown>,
  path: string,
  errors: MotionValidationIssue[],
): void {
  try {
    validateMotionPathData(
      source["x-path"] ?? readRecord(source.style)?.path,
      "Matte source path",
    );
  } catch (error) {
    errors.push({ path: `${path}/x-path`, message: validationErrorMessage(error) });
  }
  try {
    parseMotionPathViewBox(
      source["x-path-viewBox"] ?? "0 0 100 100",
      "Matte source path viewBox",
    );
  } catch (error) {
    errors.push({ path: `${path}/x-path-viewBox`, message: validationErrorMessage(error) });
  }
}

function validateMatteStyle(
  source: Record<string, unknown>,
  path: string,
  errors: MotionValidationIssue[],
): void {
  const style = readRecord(source.style);
  if (style && ["stroke", "shadow", "boxShadow", "borderRadius", "radius"]
    .some((field) => field in style)) {
    errors.push({
      path: `${path}/style`,
      message: "matte source strokes, shadows, and radii are not yet supported",
    });
  }
  if (style && "fill" in style
    && (typeof style.fill !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(style.fill))) {
    errors.push({
      path: `${path}/style/fill`,
      message: "matte source fill must be an opaque hex color",
    });
  }
  if (style && "opacity" in style) {
    errors.push({
      path: `${path}/style/opacity`,
      message: "matte source style opacity is not yet supported",
    });
  }
}

function validateMatteTransform(
  layer: Record<string, unknown>,
  path: string,
  role: "source" | "consumer",
  errors: MotionValidationIssue[],
): void {
  const transform = readRecord(layer.transform);
  if (transform?.rotation !== undefined && transform.rotation !== 0) {
    errors.push({
      path: `${path}/transform/rotation`,
      message: `${role} rotation is not yet supported with mattes`,
    });
  }
  if (transform?.scale !== undefined && transform.scale !== 1) {
    errors.push({
      path: `${path}/transform/scale`,
      message: `${role} scale is not yet supported with mattes`,
    });
  }
  const opacity = transform?.opacity ?? layer.opacity;
  if (role === "source" && opacity !== undefined && opacity !== 1) {
    errors.push({
      path: `${path}/transform/opacity`,
      message: "matte source opacity is not yet supported",
    });
  }
  const motionBlur = readRecord(readRecord(layer.effects)?.motionBlur);
  if (role === "consumer" && Object.keys(motionBlur ?? {}).length > 0) {
    errors.push({
      path: `${path}/effects/motionBlur`,
      message: `${role} motion blur is not yet supported with mattes`,
    });
  }
  const keyframes = readRecord(layer.keyframes);
  for (const target of ["transform.rotation", "transform.scale"]) {
    if (Array.isArray(keyframes?.[target]) && keyframes[target].length > 0) {
      errors.push({
        path: `${path}/keyframes/${target}`,
        message: `${role} ${target} keyframes are not yet supported with mattes`,
      });
    }
  }
}

function isMatteType(value: unknown): boolean {
  return value === "alpha"
    || value === "alpha-inverted"
    || value === "luma"
    || value === "luma-inverted";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid path geometry";
}
