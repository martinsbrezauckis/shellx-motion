import type { MotionBlendMode } from "./types";
import type {
  MotionCompositingGraphContext,
  MotionCompositingIssue,
  MotionCompositingNodeType,
} from "./compositing-graph-types";
import {
  allowOnlyFields,
  graphIssue,
  isBoundedNumber,
  plainRecord,
  safeGraphId,
} from "./compositing-graph-safety";

const NODE_TYPES = new Set<MotionCompositingNodeType>([
  "source", "transform", "mask", "matte", "blend", "color", "blur", "output",
]);
const BLEND_MODES = new Set<MotionBlendMode>([
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter",
]);
const MATTE_TYPES = new Set(["alpha", "alpha-inverted", "luma", "luma-inverted"]);
const NODE_FIELDS: Record<MotionCompositingNodeType, readonly string[]> = {
  source: ["id", "type", "layerId"],
  transform: ["id", "type", "transform"],
  mask: ["id", "type", "mask"],
  matte: ["id", "type", "matteType"],
  blend: ["id", "type", "mode"],
  color: ["id", "type", "brightness", "contrast", "saturate", "grayscale"],
  blur: ["id", "type", "radius"],
  output: ["id", "type"],
};

export function validateCompositingNode(
  value: unknown,
  index: number,
  context: MotionCompositingGraphContext,
  byId: Map<string, Record<string, unknown>>,
  types: Map<string, MotionCompositingNodeType>,
  issues: MotionCompositingIssue[],
): void {
  const path = `/compositing/nodes/${index}`;
  const node = plainRecord(value);
  if (!node) {
    issues.push(graphIssue(path, "node.object", "must be a plain object"));
    return;
  }

  const id = safeGraphId(node.id, `${path}/id`, issues);
  const type = NODE_TYPES.has(node.type as MotionCompositingNodeType)
    ? node.type as MotionCompositingNodeType
    : null;
  if (!type) {
    issues.push(graphIssue(
      `${path}/type`,
      "node.type",
      "must be source, transform, mask, matte, blend, color, blur, or output",
    ));
  }
  if (id && byId.has(id)) {
    issues.push(graphIssue(`${path}/id`, "node.id_duplicate", "must be unique"));
  } else if (id) {
    byId.set(id, node);
    if (type) types.set(id, type);
  }
  if (!type) return;

  allowOnlyFields(node, NODE_FIELDS[type], path, issues);
  validateNodeConfiguration(node, type, path, context, issues);
}

function validateNodeConfiguration(
  node: Record<string, unknown>,
  type: MotionCompositingNodeType,
  path: string,
  context: MotionCompositingGraphContext,
  issues: MotionCompositingIssue[],
): void {
  if (type === "source") {
    const layerId = safeGraphId(node.layerId, `${path}/layerId`, issues);
    if (layerId && !context.layers.some((layer) => layer.id === layerId)) {
      issues.push(graphIssue(
        `${path}/layerId`,
        "source.missing",
        "must reference an existing Motion layer",
      ));
    }
  } else if (type === "transform") {
    validateTransform(node.transform, `${path}/transform`, issues);
  } else if (type === "mask") {
    validateMask(node.mask, `${path}/mask`, issues);
  } else if (type === "matte" && !MATTE_TYPES.has(String(node.matteType))) {
    issues.push(graphIssue(
      `${path}/matteType`,
      "matte.type",
      "must be alpha, alpha-inverted, luma, or luma-inverted",
    ));
  } else if (type === "blend" && !BLEND_MODES.has(node.mode as MotionBlendMode)) {
    issues.push(graphIssue(`${path}/mode`, "blend.mode", "is unsupported"));
  } else if (type === "color") {
    validateColor(node, path, issues);
  } else if (type === "blur" && !isBoundedNumber(node.radius, 0, 128)) {
    issues.push(graphIssue(`${path}/radius`, "blur.radius", "must be between 0 and 128"));
  }
}

function validateTransform(
  value: unknown,
  path: string,
  issues: MotionCompositingIssue[],
): void {
  const transform = plainRecord(value);
  if (!transform) {
    issues.push(graphIssue(path, "transform.object", "must be a plain object"));
    return;
  }
  const fields = ["x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"];
  allowOnlyFields(transform, fields, path, issues);
  if (!Object.keys(transform).length) {
    issues.push(graphIssue(path, "transform.empty", "must change at least one field"));
  }
  for (const field of fields) {
    if (!(field in transform)) continue;
    const min = field === "opacity" ? 0
      : field === "scale" || field === "width" || field === "height" ? 0.001
        : -1_000_000;
    const max = field === "opacity" ? 1
      : field === "scale" ? 1_000
        : field === "rotation" ? 36_000
          : 1_000_000;
    if (!isBoundedNumber(transform[field], min, max)) {
      issues.push(graphIssue(
        `${path}/${field}`,
        "transform.value",
        "is outside the supported finite range",
      ));
    }
  }
}

function validateColor(
  node: Record<string, unknown>,
  path: string,
  issues: MotionCompositingIssue[],
): void {
  const fields = ["brightness", "contrast", "saturate", "grayscale"];
  if (!fields.some((field) => field in node)) {
    issues.push(graphIssue(path, "color.empty", "must set at least one color control"));
  }
  for (const field of fields) {
    if (!(field in node)) continue;
    const max = field === "grayscale" ? 1 : 4;
    if (!isBoundedNumber(node[field], 0, max)) {
      issues.push(graphIssue(`${path}/${field}`, "color.value", `must be between 0 and ${max}`));
    }
  }
}

function validateMask(
  value: unknown,
  path: string,
  issues: MotionCompositingIssue[],
): void {
  const mask = plainRecord(value);
  if (!mask) {
    issues.push(graphIssue(path, "mask.object", "must be a plain object"));
    return;
  }
  allowOnlyFields(
    mask,
    ["type", "inset", "radius", "path", "viewBox", "fillRule", "inverted"],
    path,
    issues,
  );
  if (mask.type !== "rect" && mask.type !== "rounded-rect" && mask.type !== "path") {
    issues.push(graphIssue(`${path}/type`, "mask.type", "must be rect, rounded-rect, or path"));
  }
  if (mask.inverted !== undefined && typeof mask.inverted !== "boolean") {
    issues.push(graphIssue(`${path}/inverted`, "mask.inverted", "must be boolean"));
  }
  validateMaskShapeFields(mask, path, issues);
  validateMaskInset(mask.inset, path, issues);
}

function validateMaskShapeFields(
  mask: Record<string, unknown>,
  path: string,
  issues: MotionCompositingIssue[],
): void {
  if (mask.radius !== undefined && !isBoundedNumber(mask.radius, 0, 1_000_000)) {
    issues.push(graphIssue(`${path}/radius`, "mask.radius", "must be bounded and non-negative"));
  }
  if (mask.fillRule !== undefined && mask.fillRule !== "nonzero" && mask.fillRule !== "evenodd") {
    issues.push(graphIssue(`${path}/fillRule`, "mask.fill_rule", "must be nonzero or evenodd"));
  }
  if (mask.path !== undefined
    && (typeof mask.path !== "string" || mask.path.length < 1 || mask.path.length > 65_536)) {
    issues.push(graphIssue(`${path}/path`, "mask.path", "must be a bounded path string"));
  }
  if (mask.viewBox !== undefined
    && (typeof mask.viewBox !== "string" || mask.viewBox.length < 1 || mask.viewBox.length > 128)) {
    issues.push(graphIssue(`${path}/viewBox`, "mask.view_box", "must be a bounded string"));
  }
  if (mask.type === "path" && (typeof mask.path !== "string" || typeof mask.viewBox !== "string")) {
    issues.push(graphIssue(path, "mask.path_fields", "path masks require path and viewBox"));
  }
  if (mask.type !== "path"
    && (mask.path !== undefined || mask.viewBox !== undefined || mask.fillRule !== undefined)) {
    issues.push(graphIssue(
      path,
      "mask.shape_fields",
      "path, viewBox, and fillRule are only valid for path masks",
    ));
  }
  if (mask.type !== "rounded-rect" && mask.radius !== undefined) {
    issues.push(graphIssue(path, "mask.radius_shape", "radius is only valid for rounded-rect masks"));
  }
  if (mask.type === "path" && mask.inset !== undefined) {
    issues.push(graphIssue(path, "mask.inset_shape", "inset is not valid for path masks"));
  }
}

function validateMaskInset(
  value: unknown,
  path: string,
  issues: MotionCompositingIssue[],
): void {
  if (value === undefined) return;
  const inset = plainRecord(value);
  if (!inset) {
    issues.push(graphIssue(`${path}/inset`, "mask.inset", "must be a plain object"));
    return;
  }
  allowOnlyFields(inset, ["top", "right", "bottom", "left"], `${path}/inset`, issues);
  for (const side of Object.keys(inset)) {
    if (!isBoundedNumber(inset[side], 0, 1_000_000)) {
      issues.push(graphIssue(
        `${path}/inset/${side}`,
        "mask.inset_value",
        "must be bounded and non-negative",
      ));
    }
  }
}
