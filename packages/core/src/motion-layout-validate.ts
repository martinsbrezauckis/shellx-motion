import { canonicalJson } from "./canonical-json";
import { estimateMotionLayoutBudget, validateMotionLayoutBudget } from "./motion-layout-budget";
import {
  MAX_MOTION_LAYOUT_CHILDREN,
  MAX_MOTION_LAYOUT_DIMENSION,
  MAX_MOTION_LAYOUT_GRID_COLUMNS,
  MAX_MOTION_LAYOUT_REPEATER_INSTANCES,
  MAX_MOTION_LAYOUT_REPEATERS,
  MAX_MOTION_LAYOUT_ROTATION,
  MAX_MOTION_LAYOUT_SCALE,
  MAX_MOTION_LAYOUT_TIME_MS,
  MOTION_LAYOUT_COMPILE_SCHEMA,
  MOTION_LAYOUT_OWNERSHIP_SCHEMA,
  type MotionLayout,
  type MotionLayoutAlign,
  type MotionLayoutChild,
  type MotionLayoutChildSizing,
  type MotionLayoutChildTiming,
  type MotionLayoutChildTransform,
  type MotionLayoutCompileRequest,
  type MotionLayoutFillSize,
  type MotionLayoutIssue,
  type MotionLayoutOwnershipInput,
  type MotionLayoutPadding,
  type MotionLayoutRepeater,
  type MotionLayoutRepeaterTransformDelta,
  type MotionLayoutSize,
  type MotionLayoutValidationResult,
} from "./motion-layout-types";
import {
  boundedNumber,
  exactKeys,
  finite,
  finiteIn,
  finiteIntegerIn,
  integer,
  isAlignment,
  isDistribution,
  isLayoutKind,
  issue,
  issueAt,
  plainRecord,
  utf8Bytes,
  validateIdentifier,
  validateIdentifierList,
  validateSortedUniqueIdentifiers,
  validateUniqueIdentifiers,
} from "./motion-layout-safety";

/** Validate the closed data contract and all compile ceilings before any instances are created. */
export function validateMotionLayoutCompileRequest(value: unknown): MotionLayoutValidationResult {
  const issues: MotionLayoutIssue[] = [];
  const root = plainRecord(value);
  if (!root) return { ok: false, issues: [issue("/", "request.object", "must be a plain object")] };
  exactKeys(root, ["schema", "ownership", "layout", "children", "repeaters"], "/", issues);
  if (root.schema !== MOTION_LAYOUT_COMPILE_SCHEMA) issueAt(issues, "/schema", "request.schema", `must equal ${MOTION_LAYOUT_COMPILE_SCHEMA}`);
  const ownership = validateOwnership(root.ownership, "/ownership", issues);
  const layout = validateLayout(root.layout, "/layout", issues);
  const children = validateChildren(root.children, "/children", issues);
  const repeaters = validateRepeaters(root.repeaters, "/repeaters", issues);
  if (ownership && children) validateOwnershipChildren(ownership, children, issues);
  if (children && repeaters) validateRepeaterSources(children, repeaters, issues);
  if (children && repeaters && issues.length === 0) validateDerivedRepeaterValues(children, repeaters, issues);
  if (issues.length > 0 || !ownership || !layout || !children || !repeaters) return { ok: false, issues };

  const request: MotionLayoutCompileRequest = { schema: MOTION_LAYOUT_COMPILE_SCHEMA, ownership, layout, children, repeaters };
  let fingerprintInput: string;
  try { fingerprintInput = canonicalJson(request); }
  catch { return { ok: false, issues: [issue("/", "request.canonical", "must be canonically serializable")] }; }
  const budget = estimateMotionLayoutBudget(request, utf8Bytes(fingerprintInput));
  validateMotionLayoutBudget(budget, issues);
  return issues.length ? { ok: false, issues } : { ok: true, request, budget, fingerprintInput };
}

function validateOwnership(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutOwnershipInput | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "ownership.object", "must be a plain object"); return null; }
  exactKeys(record, ["schema", "ownerId", "childIds"], path, issues);
  if (record.schema !== MOTION_LAYOUT_OWNERSHIP_SCHEMA) issueAt(issues, `${path}/schema`, "ownership.schema", `must equal ${MOTION_LAYOUT_OWNERSHIP_SCHEMA}`);
  validateIdentifier(record.ownerId, `${path}/ownerId`, issues);
  const childIds = validateIdentifierList(record.childIds, `${path}/childIds`, issues, 1, MAX_MOTION_LAYOUT_CHILDREN);
  if (typeof record.ownerId === "string" && childIds?.includes(record.ownerId)) {
    issueAt(issues, `${path}/childIds`, "ownership.self", "must not contain ownerId; ownership is strictly parent-to-child");
  }
  return typeof record.ownerId === "string" && childIds ? { schema: MOTION_LAYOUT_OWNERSHIP_SCHEMA, ownerId: record.ownerId, childIds } : null;
}

function validateLayout(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayout | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "layout.object", "must be a plain object"); return null; }
  const kind = record.kind;
  const common = ["schema", "kind", "width", "height", "padding", "gap", "align", "distribution", "overflow"];
  const keys = kind === "grid" ? [...common, "columns"] : kind === "radial" ? [...common, "radius", "startAngleDeg", "sweepAngleDeg"] : common;
  exactKeys(record, keys, path, issues);
  if (record.schema !== "shellx-motion/layout@1") issueAt(issues, `${path}/schema`, "layout.schema", "must equal shellx-motion/layout@1");
  if (!isLayoutKind(kind)) issueAt(issues, `${path}/kind`, "layout.kind", "must be row, column, stack, grid, or radial");
  boundedNumber(record.width, `${path}/width`, 1, MAX_MOTION_LAYOUT_DIMENSION, issues);
  boundedNumber(record.height, `${path}/height`, 1, MAX_MOTION_LAYOUT_DIMENSION, issues);
  const padding = validatePadding(record.padding, `${path}/padding`, issues);
  boundedNumber(record.gap, `${path}/gap`, 0, MAX_MOTION_LAYOUT_DIMENSION, issues);
  const align = validateAlign(record.align, `${path}/align`, issues);
  if (!isDistribution(record.distribution)) issueAt(issues, `${path}/distribution`, "layout.distribution", "must be a supported distribution");
  if (record.overflow !== "clip" && record.overflow !== "allow") issueAt(issues, `${path}/overflow`, "layout.overflow", "must be clip or allow");
  if (kind === "stack" && finite(record.gap) !== null && Number(record.gap) !== 0) {
    issueAt(issues, `${path}/gap`, "layout.gap_unsupported", "must be 0 for stack; overlapping items have no main axis");
  }
  if (kind === "grid" && isDistribution(record.distribution) && record.distribution !== "start") {
    issueAt(issues, `${path}/distribution`, "layout.distribution_unsupported", "must be start for grid; track distribution is not part of this fixed-grid contract");
  }
  if (kind === "row" && align && align.x !== "start") {
    issueAt(issues, `${path}/align/x`, "layout.main_axis_align_unsupported", "must be start for row; distribution owns its horizontal main axis");
  }
  if (kind === "column" && align && align.y !== "start") {
    issueAt(issues, `${path}/align/y`, "layout.main_axis_align_unsupported", "must be start for column; distribution owns its vertical main axis");
  }
  if (kind === "radial" && isDistribution(record.distribution) && record.distribution.startsWith("space-")
    && finite(record.gap) !== null && Number(record.gap) !== 0) {
    issueAt(issues, `${path}/gap`, "layout.gap_unsupported", "must be 0 when radial space distribution owns angular spacing");
  }
  if (kind === "radial" && align && (align.x === "stretch" || align.y === "stretch")) {
    issueAt(issues, `${path}/align`, "layout.stretch_unsupported", "radial has no cross axis; stretch is not defined");
  }
  if (padding && finite(record.width) !== null && finite(record.height) !== null
    && (padding.left + padding.right >= Number(record.width) || padding.top + padding.bottom >= Number(record.height))) {
    issueAt(issues, `${path}/padding`, "layout.padding_bounds", "must leave a positive content box");
  }
  if (!isLayoutKind(kind) || !padding || !align || !finiteIn(record.width, 1, MAX_MOTION_LAYOUT_DIMENSION)
    || !finiteIn(record.height, 1, MAX_MOTION_LAYOUT_DIMENSION) || !finiteIn(record.gap, 0, MAX_MOTION_LAYOUT_DIMENSION)
    || !isDistribution(record.distribution) || (record.overflow !== "clip" && record.overflow !== "allow")
    || (kind === "stack" && Number(record.gap) !== 0)
    || (kind === "grid" && record.distribution !== "start")
    || (kind === "row" && align.x !== "start")
    || (kind === "column" && align.y !== "start")
    || (kind === "radial" && record.distribution.startsWith("space-") && Number(record.gap) !== 0)
    || (kind === "radial" && (align.x === "stretch" || align.y === "stretch"))) return null;
  const base = {
    schema: "shellx-motion/layout@1" as const, kind, width: Number(record.width), height: Number(record.height), padding,
    gap: Number(record.gap), align, distribution: record.distribution, overflow: record.overflow === "clip" ? "clip" as const : "allow" as const,
  };
  if (kind === "grid") {
    integer(record.columns, `${path}/columns`, 1, MAX_MOTION_LAYOUT_GRID_COLUMNS, issues);
    return finiteIntegerIn(record.columns, 1, MAX_MOTION_LAYOUT_GRID_COLUMNS) ? { ...base, kind, columns: Number(record.columns) } : null;
  }
  if (kind === "radial") {
    boundedNumber(record.radius, `${path}/radius`, 0, MAX_MOTION_LAYOUT_DIMENSION, issues);
    boundedNumber(record.startAngleDeg, `${path}/startAngleDeg`, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION, issues);
    boundedNumber(record.sweepAngleDeg, `${path}/sweepAngleDeg`, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION, issues);
    return finiteIn(record.radius, 0, MAX_MOTION_LAYOUT_DIMENSION)
      && finiteIn(record.startAngleDeg, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION)
      && finiteIn(record.sweepAngleDeg, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION)
      ? { ...base, kind, radius: Number(record.radius), startAngleDeg: Number(record.startAngleDeg), sweepAngleDeg: Number(record.sweepAngleDeg) }
      : null;
  }
  if (kind === "row") return { ...base, kind };
  if (kind === "column") return { ...base, kind };
  return { ...base, kind: "stack" };
}

function validatePadding(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutPadding | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "padding.object", "must be a plain object"); return null; }
  exactKeys(record, ["top", "right", "bottom", "left"], path, issues);
  for (const key of ["top", "right", "bottom", "left"] as const) boundedNumber(record[key], `${path}/${key}`, 0, MAX_MOTION_LAYOUT_DIMENSION, issues);
  return (["top", "right", "bottom", "left"] as const).every((key) => finiteIn(record[key], 0, MAX_MOTION_LAYOUT_DIMENSION))
    ? { top: Number(record.top), right: Number(record.right), bottom: Number(record.bottom), left: Number(record.left) } : null;
}

function validateAlign(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutAlign | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "align.object", "must be a plain object"); return null; }
  exactKeys(record, ["x", "y"], path, issues);
  for (const key of ["x", "y"] as const) if (!isAlignment(record[key])) issueAt(issues, `${path}/${key}`, "align.value", "must be start, center, end, or stretch");
  return isAlignment(record.x) && isAlignment(record.y) ? { x: record.x, y: record.y } : null;
}

function validateChildren(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutChild[] | null {
  if (!Array.isArray(value)) { issueAt(issues, path, "children.collection", "must be an array"); return null; }
  if (value.length < 1 || value.length > MAX_MOTION_LAYOUT_CHILDREN) {
    issueAt(issues, path, "children.budget", `must contain 1..${MAX_MOTION_LAYOUT_CHILDREN} children`); return null;
  }
  const children: MotionLayoutChild[] = [];
  value.forEach((candidate, index) => { const child = validateChild(candidate, `${path}/${index}`, issues); if (child) children.push(child); });
  validateUniqueIdentifiers(value.map((child) => plainRecord(child)?.id), path, issues);
  return children.length === value.length ? children : null;
}

function validateChild(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutChild | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "child.object", "must be a plain object"); return null; }
  exactKeys(record, ["id", "sizing", "transform", "timing"], path, issues);
  validateIdentifier(record.id, `${path}/id`, issues);
  const sizing = validateSizing(record.sizing, `${path}/sizing`, issues);
  const transform = validateTransform(record.transform, `${path}/transform`, issues);
  const timing = validateTiming(record.timing, `${path}/timing`, issues);
  return typeof record.id === "string" && sizing && transform && timing ? { id: record.id, sizing, transform, timing } : null;
}

function validateSizing(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutChildSizing | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "sizing.object", "must be a plain object"); return null; }
  exactKeys(record, ["width", "height"], path, issues);
  const width = validateSize(record.width, `${path}/width`, issues);
  const height = validateSize(record.height, `${path}/height`, issues);
  return width && height ? { width, height } : null;
}

function validateSize(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutSize | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "size.object", "must be a plain object"); return null; }
  const mode = record.mode;
  exactKeys(record, mode === "fixed" ? ["mode", "value"] : mode === "fill" ? ["mode", "min", "max"] : ["mode"], path, issues);
  if (mode === "fixed") {
    boundedNumber(record.value, `${path}/value`, 0.000001, MAX_MOTION_LAYOUT_DIMENSION, issues);
    return finiteIn(record.value, 0.000001, MAX_MOTION_LAYOUT_DIMENSION) ? { mode, value: Number(record.value) } : null;
  }
  if (mode === "fill") {
    boundedNumber(record.min, `${path}/min`, 0.000001, MAX_MOTION_LAYOUT_DIMENSION, issues);
    boundedNumber(record.max, `${path}/max`, 0.000001, MAX_MOTION_LAYOUT_DIMENSION, issues);
    if (finite(record.min) !== null && finite(record.max) !== null && Number(record.min) > Number(record.max)) issueAt(issues, path, "size.range", "min must not exceed max");
    return finiteIn(record.min, 0.000001, MAX_MOTION_LAYOUT_DIMENSION)
      && finiteIn(record.max, 0.000001, MAX_MOTION_LAYOUT_DIMENSION) && Number(record.min) <= Number(record.max)
      ? { mode, min: Number(record.min), max: Number(record.max) } : null;
  }
  issueAt(issues, `${path}/mode`, "size.mode", "must be fixed or fill");
  return null;
}

function validateTransform(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutChildTransform | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "transform.object", "must be a plain object"); return null; }
  exactKeys(record, ["x", "y", "scale", "rotation", "opacity"], path, issues);
  boundedNumber(record.x, `${path}/x`, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION, issues);
  boundedNumber(record.y, `${path}/y`, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION, issues);
  boundedNumber(record.scale, `${path}/scale`, 0.000001, MAX_MOTION_LAYOUT_SCALE, issues);
  boundedNumber(record.rotation, `${path}/rotation`, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION, issues);
  boundedNumber(record.opacity, `${path}/opacity`, 0, 1, issues);
  return finiteIn(record.x, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION)
    && finiteIn(record.y, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION)
    && finiteIn(record.scale, 0.000001, MAX_MOTION_LAYOUT_SCALE)
    && finiteIn(record.rotation, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION) && finiteIn(record.opacity, 0, 1)
    ? { x: Number(record.x), y: Number(record.y), scale: Number(record.scale), rotation: Number(record.rotation), opacity: Number(record.opacity) } : null;
}

function validateTiming(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutChildTiming | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "timing.object", "must be a plain object"); return null; }
  exactKeys(record, ["startMs", "durationMs"], path, issues);
  integer(record.startMs, `${path}/startMs`, 0, MAX_MOTION_LAYOUT_TIME_MS, issues);
  integer(record.durationMs, `${path}/durationMs`, 1, MAX_MOTION_LAYOUT_TIME_MS, issues);
  if (finiteIntegerIn(record.startMs, 0, MAX_MOTION_LAYOUT_TIME_MS) && finiteIntegerIn(record.durationMs, 1, MAX_MOTION_LAYOUT_TIME_MS)
    && Number(record.startMs) + Number(record.durationMs) > MAX_MOTION_LAYOUT_TIME_MS) issueAt(issues, path, "timing.range", `must end at or before ${MAX_MOTION_LAYOUT_TIME_MS}ms`);
  return finiteIntegerIn(record.startMs, 0, MAX_MOTION_LAYOUT_TIME_MS)
    && finiteIntegerIn(record.durationMs, 1, MAX_MOTION_LAYOUT_TIME_MS) && Number(record.startMs) + Number(record.durationMs) <= MAX_MOTION_LAYOUT_TIME_MS
    ? { startMs: Number(record.startMs), durationMs: Number(record.durationMs) } : null;
}

function validateRepeaters(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutRepeater[] | null {
  if (!Array.isArray(value)) { issueAt(issues, path, "repeaters.collection", "must be an array"); return null; }
  if (value.length > MAX_MOTION_LAYOUT_REPEATERS) { issueAt(issues, path, "repeaters.budget", `must contain at most ${MAX_MOTION_LAYOUT_REPEATERS} repeaters`); return null; }
  const repeaters: MotionLayoutRepeater[] = [];
  value.forEach((candidate, index) => { const repeater = validateRepeater(candidate, `${path}/${index}`, issues); if (repeater) repeaters.push(repeater); });
  validateSortedUniqueIdentifiers(value.map((repeater) => plainRecord(repeater)?.sourceId), path, issues);
  return repeaters.length === value.length ? repeaters : null;
}

function validateRepeater(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutRepeater | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "repeater.object", "must be a plain object"); return null; }
  exactKeys(record, ["schema", "sourceId", "count", "transformDelta", "opacityDelta", "indexTimeStaggerMs"], path, issues);
  if (record.schema !== "shellx-motion/repeater@1") issueAt(issues, `${path}/schema`, "repeater.schema", "must equal shellx-motion/repeater@1");
  validateIdentifier(record.sourceId, `${path}/sourceId`, issues);
  integer(record.count, `${path}/count`, 1, MAX_MOTION_LAYOUT_REPEATER_INSTANCES, issues);
  const transformDelta = validateRepeaterTransformDelta(record.transformDelta, `${path}/transformDelta`, issues);
  boundedNumber(record.opacityDelta, `${path}/opacityDelta`, -1, 1, issues);
  integer(record.indexTimeStaggerMs, `${path}/indexTimeStaggerMs`, 0, MAX_MOTION_LAYOUT_TIME_MS, issues);
  return record.schema === "shellx-motion/repeater@1" && typeof record.sourceId === "string"
    && finiteIntegerIn(record.count, 1, MAX_MOTION_LAYOUT_REPEATER_INSTANCES) && transformDelta
    && finiteIn(record.opacityDelta, -1, 1) && finiteIntegerIn(record.indexTimeStaggerMs, 0, MAX_MOTION_LAYOUT_TIME_MS)
    ? { schema: "shellx-motion/repeater@1", sourceId: record.sourceId, count: Number(record.count), transformDelta, opacityDelta: Number(record.opacityDelta), indexTimeStaggerMs: Number(record.indexTimeStaggerMs) } : null;
}

function validateRepeaterTransformDelta(value: unknown, path: string, issues: MotionLayoutIssue[]): MotionLayoutRepeaterTransformDelta | null {
  const record = plainRecord(value);
  if (!record) { issueAt(issues, path, "repeater_delta.object", "must be a plain object"); return null; }
  exactKeys(record, ["x", "y", "scale", "rotation"], path, issues);
  boundedNumber(record.x, `${path}/x`, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION, issues);
  boundedNumber(record.y, `${path}/y`, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION, issues);
  boundedNumber(record.scale, `${path}/scale`, -MAX_MOTION_LAYOUT_SCALE, MAX_MOTION_LAYOUT_SCALE, issues);
  boundedNumber(record.rotation, `${path}/rotation`, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION, issues);
  return finiteIn(record.x, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION)
    && finiteIn(record.y, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION)
    && finiteIn(record.scale, -MAX_MOTION_LAYOUT_SCALE, MAX_MOTION_LAYOUT_SCALE)
    && finiteIn(record.rotation, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION)
    ? { x: Number(record.x), y: Number(record.y), scale: Number(record.scale), rotation: Number(record.rotation) } : null;
}

function validateOwnershipChildren(ownership: MotionLayoutOwnershipInput, children: MotionLayoutChild[], issues: MotionLayoutIssue[]): void {
  if (ownership.childIds.length !== children.length || ownership.childIds.some((id, index) => id !== children[index]?.id)) {
    issueAt(issues, "/ownership/childIds", "ownership.children", "must exactly equal the ordered child ids supplied to this compiler");
  }
}

function validateRepeaterSources(children: MotionLayoutChild[], repeaters: MotionLayoutRepeater[], issues: MotionLayoutIssue[]): void {
  const childIds = new Set(children.map((child) => child.id));
  repeaters.forEach((repeater, index) => { if (!childIds.has(repeater.sourceId)) issueAt(issues, `/repeaters/${index}/sourceId`, "repeater.source", "must reference a supplied child id"); });
}

function validateDerivedRepeaterValues(children: MotionLayoutChild[], repeaters: MotionLayoutRepeater[], issues: MotionLayoutIssue[]): void {
  const childById = new Map(children.map((child) => [child.id, child]));
  repeaters.forEach((repeater, index) => {
    const source = childById.get(repeater.sourceId);
    if (!source) return;
    const last = repeater.count - 1;
    const scale = source.transform.scale + repeater.transformDelta.scale * last;
    const x = source.transform.x + repeater.transformDelta.x * last;
    const y = source.transform.y + repeater.transformDelta.y * last;
    const rotation = source.transform.rotation + repeater.transformDelta.rotation * last;
    const opacity = source.transform.opacity + repeater.opacityDelta * last;
    const endMs = source.timing.startMs + source.timing.durationMs + repeater.indexTimeStaggerMs * last;
    if (!finiteIn(scale, 0.000001, MAX_MOTION_LAYOUT_SCALE)) issueAt(issues, `/repeaters/${index}/transformDelta/scale`, "repeater.derived_scale", "must keep every generated scale positive and bounded");
    if (!finiteIn(x, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION)
      || !finiteIn(y, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION)) {
      issueAt(issues, `/repeaters/${index}/transformDelta`, "repeater.derived_position", "must keep every generated x and y within layout coordinate bounds");
    }
    if (!finiteIn(rotation, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION)) {
      issueAt(issues, `/repeaters/${index}/transformDelta/rotation`, "repeater.derived_rotation", "must keep every generated rotation within layout rotation bounds");
    }
    if (!finiteIn(opacity, 0, 1)) issueAt(issues, `/repeaters/${index}/opacityDelta`, "repeater.derived_opacity", "must keep every generated opacity between 0 and 1");
    if (!Number.isSafeInteger(endMs) || endMs > MAX_MOTION_LAYOUT_TIME_MS) issueAt(issues, `/repeaters/${index}/indexTimeStaggerMs`, "repeater.derived_timing", `must keep every generated instance within ${MAX_MOTION_LAYOUT_TIME_MS}ms`);
  });
}
