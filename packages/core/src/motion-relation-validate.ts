import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { MAX_MOTION_RELATION_DEPTH, MAX_MOTION_RELATION_FRAME_WORK_UNITS, motionRelationWriteMask, type MotionRelationBinding, type MotionRelationStore, type MotionRelationWriteMask } from "./motion-relation-types";
import { readMotionRelationStore } from "./motion-relation-read";
import type { MotionLayer } from "./types";

export interface MotionRelationIssue { path: string; message: string }
export interface ResolvedMotionRelationBinding {
  binding: MotionRelationBinding;
  writeMask: readonly MotionRelationWriteMask[];
  sourceSha256: string;
  workUnits: number;
}
export interface MotionRelationBudget {
  inputBytes: number;
  bindingCount: number;
  enabledBindingCount: number;
  frameWorkUnits: number;
  limits: { maxBindings: 32; maxDependencyDepth: typeof MAX_MOTION_RELATION_DEPTH; maxFrameWorkUnits: typeof MAX_MOTION_RELATION_FRAME_WORK_UNITS };
}
export type MotionRelationValidationResult =
  | { ok: true; store: MotionRelationStore | undefined; bindings: readonly ResolvedMotionRelationBinding[]; relationOrder: readonly string[]; budget: MotionRelationBudget }
  | { ok: false; issues: MotionRelationIssue[] };

/**
 * Validates the private store against the document's current transform authorities. It intentionally
 * takes loose context fields so callers can use it before `MotionDocument` grows a public `relations` key.
 */
export function validateMotionRelations(value: unknown, context: {
  durationMs: unknown;
  layers: readonly unknown[];
  relationships?: unknown;
  behaviors?: unknown;
}): MotionRelationValidationResult {
  if (value === undefined) return { ok: true, store: undefined, bindings: [], relationOrder: [], budget: emptyBudget() };
  let store: MotionRelationStore;
  try { store = readMotionRelationStore(value); }
  catch (error) { return fail("/relations", error instanceof Error ? error.message : "must be a valid relation store"); }
  if (typeof context.durationMs !== "number") return fail("/relations", "requires a numeric document durationMs");
  const documentUs = context.durationMs * 1_000;
  if (!Number.isSafeInteger(documentUs) || documentUs <= 0) return fail("/relations", "requires an exactly representable positive document duration in microseconds");

  const layers = Array.from(context.layers).filter(isMotionLayer);
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  const groupChildren = new Set(layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? []));
  const issues: MotionRelationIssue[] = [];
  const targetMasks = new Map<string, { id: string; mask: MotionRelationWriteMask }[]>();
  const bindings: ResolvedMotionRelationBinding[] = [];
  let previousId: string | undefined;

  store.bindings.forEach((binding, index) => {
    const path = `/relations/bindings/${index}`;
    if (previousId !== undefined && compareCodeUnits(previousId, binding.id) >= 0) {
      issues.push({ path: `${path}/id`, message: "must be strict UTF-16/code-unit ascending unique id order" });
    }
    previousId = binding.id;
    if (binding.startUs + binding.durationUs > documentUs) issues.push({ path, message: "startUs plus durationUs must fit the document duration exactly in microseconds" });

    const source = validateEndpoint(binding.source.layerId, "source", layerById, groupChildren, path, issues);
    const target = validateEndpoint(binding.target.layerId, "target", layerById, groupChildren, path, issues);
    const writeMask = motionRelationWriteMask(binding);
    if (target) {
      for (const mask of writeMask) {
        const owners = targetMasks.get(target.id) ?? [];
        const prior = owners.find((owner) => owner.mask === mask);
        if (prior) issues.push({ path, message: `transform authority ${mask} overlaps relation '${prior.id}'; no priority or blending is available` });
        owners.push({ id: binding.id, mask });
        targetMasks.set(target.id, owners);
      }
      for (const mask of writeMask) {
        if (hasTransformKeyframe(target, mask)) issues.push({ path, message: `refuses target ordinary or spatial keyframes for ${mask}` });
        if (hasProceduralTransformAuthority(context.relationships, target.id, mask)) issues.push({ path, message: `refuses target procedural relationship authority for ${mask}` });
        if (hasBehaviorTransformAuthority(context.behaviors, target.id, mask)) issues.push({ path, message: `refuses target behavior authority for ${mask}` });
      }
    }
    if (source && target && source.id === target.id) issues.push({ path, message: "source and target must differ; self-relations form a dependency cycle" });
    const workUnits = relationWorkUnits(binding);
    bindings.push({ binding, writeMask: Object.freeze([...writeMask]), sourceSha256: canonicalJsonSha256({ binding, writeMask }), workUnits });
  });

  const dependencyResult = resolveDependencies(bindings);
  if (!dependencyResult.ok) issues.push({ path: "/relations/bindings", message: "relation dependencies must be acyclic" });
  else if (dependencyResult.depth > MAX_MOTION_RELATION_DEPTH) {
    issues.push({ path: "/relations/bindings", message: `relation dependency depth exceeds ${MAX_MOTION_RELATION_DEPTH}` });
  }
  const frameWorkUnits = bindings.reduce((total, binding) => total + binding.workUnits, 0);
  if (frameWorkUnits > MAX_MOTION_RELATION_FRAME_WORK_UNITS) {
    issues.push({ path: "/relations", message: `exceeds the ${MAX_MOTION_RELATION_FRAME_WORK_UNITS}-unit frame relation work limit` });
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    store,
    bindings: Object.freeze(bindings),
    relationOrder: Object.freeze(dependencyResult.ok ? dependencyResult.order : []),
    budget: {
      inputBytes: Buffer.byteLength(canonicalJson(store), "utf8"),
      bindingCount: store.bindings.length,
      enabledBindingCount: store.bindings.filter((binding) => binding.enabled).length,
      frameWorkUnits,
      limits: { maxBindings: 32, maxDependencyDepth: MAX_MOTION_RELATION_DEPTH, maxFrameWorkUnits: MAX_MOTION_RELATION_FRAME_WORK_UNITS },
    },
  };
}

/** Deterministic topological order with attach before aim only when their masks are already disjoint. */
function resolveDependencies(bindings: readonly ResolvedMotionRelationBinding[]): { ok: true; order: string[]; depth: number } | { ok: false } {
  const producerIdsByLayer = new Map<string, string[]>();
  const byId = new Map<string, ResolvedMotionRelationBinding>();
  for (const resolved of bindings) {
    byId.set(resolved.binding.id, resolved);
    producerIdsByLayer.set(resolved.binding.target.layerId, [...(producerIdsByLayer.get(resolved.binding.target.layerId) ?? []), resolved.binding.id]);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const resolved of bindings) {
    dependencies.set(resolved.binding.id, new Set(producerIdsByLayer.get(resolved.binding.source.layerId) ?? []));
  }
  const degree = new Map([...dependencies.entries()].map(([id, values]) => [id, values.size]));
  const outgoing = new Map<string, string[]>();
  for (const [id, values] of dependencies) for (const source of values) outgoing.set(source, [...(outgoing.get(source) ?? []), id]);
  const compare = (left: string, right: string): number => {
    const leftKind = byId.get(left)!.binding.kind === "attach" ? 0 : 1;
    const rightKind = byId.get(right)!.binding.kind === "attach" ? 0 : 1;
    return leftKind - rightKind || compareCodeUnits(left, right);
  };
  const ready = [...byId.keys()].filter((id) => degree.get(id) === 0).sort(compare);
  const order: string[] = [];
  const depth = new Map<string, number>();
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    depth.set(id, 1 + Math.max(0, ...[...(dependencies.get(id) ?? [])].map((source) => depth.get(source) ?? 0)));
    for (const target of (outgoing.get(id) ?? []).sort(compare)) {
      const next = (degree.get(target) ?? 1) - 1;
      degree.set(target, next);
      if (next === 0) { ready.push(target); ready.sort(compare); }
    }
  }
  return order.length === bindings.length ? { ok: true, order, depth: Math.max(0, ...depth.values()) } : { ok: false };
}

function validateEndpoint(
  layerId: string,
  role: "source" | "target",
  layerById: ReadonlyMap<string, MotionLayer>,
  groupChildren: ReadonlySet<string>,
  path: string,
  issues: MotionRelationIssue[],
): MotionLayer | null {
  const layer = layerById.get(layerId);
  if (!layer) { issues.push({ path: `${path}/${role}/layerId`, message: "must reference an existing root-owned 2D shape layer" }); return null; }
  if (layer.type !== "shape") { issues.push({ path: `${path}/${role}/layerId`, message: "must reference a shape layer; text, caption, group, camera, and scene3d endpoints are refused" }); return null; }
  if (groupChildren.has(layer.id)) { issues.push({ path: `${path}/${role}/layerId`, message: "must reference a root-owned shape layer, not a group child" }); return null; }
  if (layer.depth !== undefined) { issues.push({ path: `${path}/${role}/layerId`, message: "refuses depth/camera relationship endpoints" }); return null; }
  if (!hasUsableSimilarityTransform(layer)) { issues.push({ path: `${path}/${role}`, message: "requires a finite orientation-preserving uniform 2D transform" }); return null; }
  return layer;
}

function hasUsableSimilarityTransform(layer: MotionLayer): boolean {
  const transform = layer.transform;
  if (transform === undefined) return true;
  for (const key of ["x", "y", "originX", "originY", "rotation", "scale"] as const) {
    const value = transform[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) return false;
  }
  return transform.scale === undefined || transform.scale > 0;
}
function hasTransformKeyframe(layer: MotionLayer, mask: MotionRelationWriteMask): boolean { return Object.hasOwn(layer.keyframes ?? {}, mask); }
function hasProceduralTransformAuthority(value: unknown, layerId: string, mask: MotionRelationWriteMask): boolean {
  const graph = record(value); const relations = graph && Array.isArray(graph.relationships) ? graph.relationships : [];
  return relations.some((candidate) => {
    const relation = record(candidate), target = relation && record(relation.target);
    return target?.layerId === layerId && target.property === mask;
  });
}
function hasBehaviorTransformAuthority(value: unknown, layerId: string, mask: MotionRelationWriteMask): boolean {
  const store = record(value), bindings = store && Array.isArray(store.bindings) ? store.bindings : [];
  return bindings.some((candidate) => {
    const binding = record(candidate);
    if (binding?.targetLayerId !== layerId) return false;
    if (binding.kind === "transform") return true;
    if (binding.kind !== "path-follow") return true; // malformed competing data is never silently ignored.
    return mask === "transform.x" || mask === "transform.y" || (mask === "transform.rotation" && binding.orientToPath === true);
  });
}
function relationWorkUnits(binding: MotionRelationBinding): number { return binding.kind === "attach" ? 12 : 8; }
function isMotionLayer(value: unknown): value is MotionLayer {
  const candidate = record(value);
  return candidate !== null && typeof candidate.id === "string";
}
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)) return null;
    return value as Record<string, unknown>;
  } catch { return null; }
}
function emptyBudget(): MotionRelationBudget {
  return { inputBytes: 0, bindingCount: 0, enabledBindingCount: 0, frameWorkUnits: 0, limits: { maxBindings: 32, maxDependencyDepth: MAX_MOTION_RELATION_DEPTH, maxFrameWorkUnits: MAX_MOTION_RELATION_FRAME_WORK_UNITS } };
}
function fail(path: string, message: string): MotionRelationValidationResult { return { ok: false, issues: [{ path, message }] }; }
