import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { renderableLayerTypes } from "./capabilities";
import { assertEditableLayers, readMotionGroupGraph } from "./motion-group-structural-support";
import {
  MAX_MOTION_LAYOUT_DIMENSION,
  MAX_MOTION_LAYOUT_ROTATION,
  MAX_MOTION_LAYOUT_SCALE,
  MOTION_LAYOUT_COMPILE_SCHEMA,
  MOTION_LAYOUT_OWNERSHIP_SCHEMA,
  compileMotionLayout,
  type MotionLayoutChild,
  type MotionLayoutIssue,
} from "./motion-layout";
import {
  MOTION_GROUP_LAYOUT_COMPILE_SCHEMA,
  MOTION_GROUP_LAYOUT_PLAN_SCHEMA,
  MOTION_GROUP_LAYOUT_SOURCE_SCHEMA,
  type MotionGroupLayoutCompileRequest,
  type MotionGroupLayoutCompileResult,
  type MotionGroupLayoutIssue,
  type MotionGroupLayoutSource,
} from "./motion-group-layout-types";
import type { MotionLayer } from "./types";

export * from "./motion-group-layout-types";

/**
 * Layout starts from the renderer-card union instead of a copied layer list.
 * The excluded records have no exact static 2D box contract for this direct
 * child compiler; groups are rejected separately for their local timelines.
 */
const LAYOUTABLE_DIRECT_LAYER_TYPES = new Set(renderableLayerTypes().filter(supportsDirectLayoutBox));
const DYNAMIC_BOX_TARGETS = new Set([
  "transform.x", "transform.y", "transform.width", "transform.height", "transform.scale", "transform.rotation", "transform.originX", "transform.originY", "opacity",
]);

function supportsDirectLayoutBox(type: string): boolean {
  return type !== "audio"
    && type !== "adjustment"
    && type !== "camera"
    && type !== "points"
    && type !== "scene3d"
    && type !== "environment"
    && type !== "group";
}

/**
 * Read exactly one validated group's direct local children into the pure layout compiler. It emits
 * property intent only; a later owner applies that intent to the document and renderer.
 */
export function compileMotionGroupLayout(value: unknown): MotionGroupLayoutCompileResult {
  const input = readRequest(value);
  if (!input.ok) return { status: "refused", issues: input.issues };
  let graph;
  try {
    graph = readMotionGroupGraph(input.request.motion);
  } catch (error) {
    return refusal("/motion", "group.graph", errorMessage(error));
  }
  const group = graph.byId.get(input.request.groupId);
  if (!group) return refusal("/groupId", "group.missing", `Motion group not found: ${input.request.groupId}.`);
  if (group.type !== "group") return refusal("/groupId", "group.type", `Layer ${input.request.groupId} is not a group.`);
  const childLayerIds = graph.childrenByGroupId.get(group.id);
  if (!childLayerIds) return refusal("/groupId", "group.ownership", `Group ${group.id} has no validated direct child ownership.`);
  try {
    assertEditableLayers(input.request.motion, graph, [group.id, ...childLayerIds]);
  } catch (error) {
    return refusal("/groupId", "group.locked", errorMessage(error));
  }

  const children: MotionLayoutChild[] = [];
  for (const [index, childId] of childLayerIds.entries()) {
    const child = graph.byId.get(childId);
    if (!child) return refusal(`/motion/layers/${index}`, "group.stale_child", `Group ${group.id} references missing child ${childId}.`);
    if (graph.parentByChildId.get(childId) !== group.id) return refusal(`/motion/layers/${index}`, "group.ownership", `Child ${childId} is not directly owned by group ${group.id}.`);
    const derived = deriveDirectChild(child, `/motion/layers/${graph.layerIndexById.get(childId) ?? index}`);
    if (!derived.ok) return { status: "refused", issues: derived.issues };
    children.push(derived.child);
  }
  const ownership = { schema: MOTION_LAYOUT_OWNERSHIP_SCHEMA, ownerId: group.id, childIds: [...childLayerIds] } as const;
  const layout = compileMotionLayout({
    schema: MOTION_LAYOUT_COMPILE_SCHEMA,
    ownership,
    layout: input.request.layout,
    children,
    repeaters: input.request.repeaters,
  });
  if (layout.status !== "ok") return { status: "refused", issues: layout.issues.map(fromLayoutIssue) };
  for (const [index, instance] of layout.plan.instances.entries()) {
    if (instance.timing.startMs + instance.timing.durationMs > group.durationMs) {
      return refusal(`/instances/${index}/timing`, "group.local_timing", `Layout instance ${instance.sourceId} must remain within group ${group.id}'s ${group.durationMs}ms local timeline.`);
    }
  }

  const source: MotionGroupLayoutSource = {
    schema: MOTION_GROUP_LAYOUT_SOURCE_SCHEMA,
    motionId: input.request.motion.id,
    groupId: group.id,
    groupStartMs: group.startMs,
    groupDurationMs: group.durationMs,
    childLayerIds: [...childLayerIds],
  };
  const fingerprintValue = {
    schema: "shellx-motion/group-layout-fingerprint@1",
    source,
    layoutFingerprintInput: layout.plan.fingerprintInput,
  };
  const fingerprintInput = canonicalJson(fingerprintValue);
  return {
    status: "ok",
    plan: {
      schema: MOTION_GROUP_LAYOUT_PLAN_SCHEMA,
      source,
      ownership: { schema: ownership.schema, ownerId: ownership.ownerId, childIds: [...ownership.childIds] },
      instances: layout.plan.instances,
      budget: layout.plan.budget,
      layoutFingerprintInput: layout.plan.fingerprintInput,
      layoutFingerprint: layout.plan.fingerprint,
      fingerprintInput,
      fingerprint: canonicalJsonSha256(fingerprintValue),
    },
  };
}

function readRequest(value: unknown): { ok: true; request: MotionGroupLayoutCompileRequest } | { ok: false; issues: MotionGroupLayoutIssue[] } {
  const record = plainRecord(value);
  if (!record) return { ok: false, issues: [issue("/", "request.object", "must be a plain object")] };
  const issues: MotionGroupLayoutIssue[] = [];
  exactKeys(record, ["schema", "motion", "groupId", "layout", "repeaters"], issues);
  if (record.schema !== MOTION_GROUP_LAYOUT_COMPILE_SCHEMA) issues.push(issue("/schema", "request.schema", `must equal ${MOTION_GROUP_LAYOUT_COMPILE_SCHEMA}`));
  if (!plainRecord(record.motion) || !Array.isArray((record.motion as { layers?: unknown }).layers)) issues.push(issue("/motion", "request.motion", "must be a Motion document with layers"));
  if (typeof record.groupId !== "string" || record.groupId.trim().length === 0) issues.push(issue("/groupId", "request.group_id", "must be a non-empty string"));
  if (!plainRecord(record.layout)) issues.push(issue("/layout", "request.layout", "must be a layout record"));
  if (!Array.isArray(record.repeaters)) issues.push(issue("/repeaters", "request.repeaters", "must be an array"));
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    request: {
      schema: MOTION_GROUP_LAYOUT_COMPILE_SCHEMA,
      motion: record.motion as MotionGroupLayoutCompileRequest["motion"],
      groupId: record.groupId as string,
      layout: record.layout as MotionGroupLayoutCompileRequest["layout"],
      repeaters: record.repeaters as MotionGroupLayoutCompileRequest["repeaters"],
    },
  };
}

function deriveDirectChild(layer: MotionLayer, path: string): { ok: true; child: MotionLayoutChild } | { ok: false; issues: MotionGroupLayoutIssue[] } {
  if (layer.type === "group") return { ok: false, issues: [issue(path, "child.nested_group", `Nested group child ${layer.id} requires a separate local-layout join.`)] };
  if (!LAYOUTABLE_DIRECT_LAYER_TYPES.has(layer.type)) return { ok: false, issues: [issue(path, "child.type", `Layer ${layer.id} does not have a supported direct 2D layout box.`)] };
  if (layer.opacity !== undefined) return { ok: false, issues: [issue(path, "child.opacity", `Layer ${layer.id} must use transform.opacity; layer-level opacity is not an exact layout input.`)] };
  if (hasDynamicBox(layer)) return { ok: false, issues: [issue(path, "child.animated_box", `Layer ${layer.id} animates a layout-owned transform or opacity field.`)] };
  const transform = plainRecord(layer.transform);
  if (!transform) return { ok: false, issues: [issue(`${path}/transform`, "child.box", `Layer ${layer.id} requires explicit transform.width and transform.height.`)] };
  if (transform.originX !== undefined || transform.originY !== undefined) return { ok: false, issues: [issue(`${path}/transform`, "child.box_origin", `Layer ${layer.id} has an explicit transform origin without a layout box-origin contract.`)] };
  const width = positive(transform.width); const height = positive(transform.height);
  if (width === null || height === null) return { ok: false, issues: [issue(`${path}/transform`, "child.box", `Layer ${layer.id} requires finite positive transform.width and transform.height.`)] };
  const x = optionalNumber(transform.x, 0, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION);
  const y = optionalNumber(transform.y, 0, -MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_DIMENSION);
  const scale = optionalNumber(transform.scale, 1, 0.000001, MAX_MOTION_LAYOUT_SCALE);
  const rotation = optionalNumber(transform.rotation, 0, -MAX_MOTION_LAYOUT_ROTATION, MAX_MOTION_LAYOUT_ROTATION);
  const opacity = optionalNumber(transform.opacity, 1, 0, 1);
  if (x === null || y === null || scale === null || rotation === null || opacity === null) {
    return { ok: false, issues: [issue(`${path}/transform`, "child.transform", `Layer ${layer.id} has an invalid static local transform.`)] };
  }
  return {
    ok: true,
    child: {
      id: layer.id,
      sizing: { width: { mode: "fixed", value: width }, height: { mode: "fixed", value: height } },
      transform: { x, y, scale, rotation, opacity },
      timing: { startMs: layer.startMs, durationMs: layer.durationMs },
    },
  };
}

function hasDynamicBox(layer: MotionLayer): boolean {
  const keyframes = layer.keyframes;
  if (!keyframes) return false;
  return [...DYNAMIC_BOX_TARGETS].some((target) => Array.isArray(keyframes[target as keyof typeof keyframes]) && keyframes[target as keyof typeof keyframes]!.length > 0);
}

function fromLayoutIssue(issue: MotionLayoutIssue): MotionGroupLayoutIssue {
  return { path: `/layout-compiler${issue.path}`, code: issue.code, message: issue.message };
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_MOTION_LAYOUT_DIMENSION ? value : null;
}
function optionalNumber(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  const result = value === undefined ? fallback : value;
  return typeof result === "number" && Number.isFinite(result) && result >= minimum && result <= maximum ? result : null;
}
function issue(path: string, code: string, message: string): MotionGroupLayoutIssue { return { path, code, message }; }
function refusal(path: string, code: string, message: string): MotionGroupLayoutCompileResult { return { status: "refused", issues: [issue(path, code, message)] }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function plainRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function exactKeys(record: Record<string, unknown>, allowed: string[], issues: MotionGroupLayoutIssue[]): void {
  const allowedKeys = new Set(allowed);
  Object.keys(record).sort().forEach((key) => { if (!allowedKeys.has(key)) issues.push(issue(`/${key}`, "field.unknown", "is not allowed")); });
  allowed.forEach((key) => { if (!Object.hasOwn(record, key)) issues.push(issue(`/${key}`, "field.required", "is required")); });
}
