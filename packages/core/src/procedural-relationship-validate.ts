import { allowOnlyFields, graphIssue, isBoundedNumber, plainRecord, safeGraphId } from "./compositing-graph-safety";
import { proceduralNodeInputs, proceduralPropertyKey, validateProceduralNode, validateRef } from "./procedural-relationship-node";
import { proceduralGraphDepth, proceduralTopologicalOrder } from "./procedural-relationship-topology";
import {
  MAX_PROCEDURAL_AUDIO_ENVELOPES,
  MAX_PROCEDURAL_DEPTH,
  MAX_PROCEDURAL_ENVELOPE_SAMPLES,
  MAX_PROCEDURAL_NODES,
  MAX_PROCEDURAL_NODES_PER_RELATIONSHIP,
  MAX_PROCEDURAL_RELATIONSHIPS,
  MOTION_PROCEDURAL_SCHEMA,
  type MotionProceduralEstimate,
  type MotionProceduralIssue,
  type MotionProceduralValidationResult,
} from "./procedural-relationship-types";

export interface MotionProceduralGraphContext {
  durationMs: number;
  fps: number;
  layers: Array<{ id: string; type?: string }>;
}

interface RelationshipRecord {
  id: string;
  enabled: boolean;
  value: Record<string, unknown>;
  nodes: unknown[];
}

export function validateMotionProceduralGraph(value: unknown, context: MotionProceduralGraphContext): MotionProceduralValidationResult {
  const issues: MotionProceduralIssue[] = [];
  const graph = plainRecord(value);
  if (!graph) return result([issue("/relationships", "graph.object", "must be a plain object")], [], {}, emptyEstimate());
  allowOnlyFields(graph, ["schema", "relationships", "audioEnvelopes"], "/relationships", issues);
  if (graph.schema !== MOTION_PROCEDURAL_SCHEMA) {
    issues.push(issue("/relationships/schema", "graph.schema", `must equal ${MOTION_PROCEDURAL_SCHEMA}`));
  }
  const layerIds = new Set(context.layers.map((layer) => layer.id));
  const layers = new Map(context.layers.map((layer) => [layer.id, layer as Record<string, unknown>]));
  const envelopes = validateEnvelopes(graph.audioEnvelopes, context, layerIds, issues);
  const values = Array.isArray(graph.relationships) ? graph.relationships : [];
  if (!Array.isArray(graph.relationships)) issues.push(issue("/relationships/relationships", "graph.relationships", "must be an array"));
  // An analyzed envelope can be authored before an agent connects it to a
  // relationship.  It is still bounded and inert until a relationship names
  // an audio-envelope node, so accepting that staging state does not make an
  // executable graph more permissive.
  if ((values.length < 1 && envelopes.ids.size === 0) || values.length > MAX_PROCEDURAL_RELATIONSHIPS) {
    issues.push(issue("/relationships/relationships", "graph.relationship_budget", `must contain 1..${MAX_PROCEDURAL_RELATIONSHIPS} relationships unless a bounded audio envelope is present`));
  }

  const records = new Map<string, RelationshipRecord>();
  const targetOwners = new Map<string, string>();
  const nodeOrders: Record<string, string[]> = {};
  let nodeCount = 0;
  let maxNodeDepth = 0;
  values.forEach((candidate, index) => {
    const path = `/relationships/relationships/${index}`;
    const relation = plainRecord(candidate);
    if (!relation) { issues.push(issue(path, "relationship.object", "must be a plain object")); return; }
    allowOnlyFields(relation, ["id", "enabled", "target", "nodes", "outputNodeId"], path, issues);
    const id = safeGraphId(relation.id, `${path}/id`, issues);
    if (id && records.has(id)) issues.push(issue(`${path}/id`, "relationship.id_duplicate", "must be unique"));
    if (typeof relation.enabled !== "boolean") issues.push(issue(`${path}/enabled`, "relationship.enabled", "must be boolean"));
    validateRef(relation.target, `${path}/target`, { layerIds, layers, issues });
    const targetKey = proceduralPropertyKey(relation.target);
    if (targetKey && targetOwners.has(targetKey)) issues.push(issue(`${path}/target`, "relationship.target_duplicate", "may be driven by only one relationship"));
    else if (targetKey && id) targetOwners.set(targetKey, id);
    const nodes = Array.isArray(relation.nodes) ? relation.nodes : [];
    if (!Array.isArray(relation.nodes)) issues.push(issue(`${path}/nodes`, "relationship.nodes", "must be an array"));
    if (nodes.length < 1 || nodes.length > MAX_PROCEDURAL_NODES_PER_RELATIONSHIP) {
      issues.push(issue(`${path}/nodes`, "relationship.node_budget", `must contain 1..${MAX_PROCEDURAL_NODES_PER_RELATIONSHIP} nodes`));
    }
    nodeCount += nodes.length;
    const topology = validateNodeGraph(nodes, `${path}/nodes`, layerIds, layers, envelopes.ids, issues);
    if (id) nodeOrders[id] = topology.order;
    maxNodeDepth = Math.max(maxNodeDepth, topology.depth);
    if (typeof relation.outputNodeId !== "string" || !topology.ids.has(relation.outputNodeId)) {
      issues.push(issue(`${path}/outputNodeId`, "relationship.output_missing", "must reference a node in this relationship"));
    }
    if (id && !records.has(id)) records.set(id, { id, enabled: relation.enabled === true, value: relation, nodes });
  });
  if (nodeCount > MAX_PROCEDURAL_NODES) {
    issues.push(issue("/relationships/relationships", "graph.node_budget", `total nodes exceed ${MAX_PROCEDURAL_NODES}`));
  }

  const dependencies = relationshipDependencies(records, targetOwners);
  const relationshipOrder = proceduralTopologicalOrder(records.keys(), dependencies);
  if (relationshipOrder.length !== records.size) {
    issues.push(issue("/relationships/relationships", "graph.cycle", "enabled property relationships must be acyclic"));
  }
  const maxDepth = maxNodeDepth + proceduralGraphDepth(relationshipOrder, dependencies);
  if (maxDepth > MAX_PROCEDURAL_DEPTH) {
    issues.push(issue("/relationships", "graph.depth_budget", `combined depth exceeds ${MAX_PROCEDURAL_DEPTH}`));
  }
  const estimate: MotionProceduralEstimate = {
    relationshipCount: records.size,
    nodeCount,
    envelopeSampleCount: envelopes.sampleCount,
    maxDepth,
    maxWorkPerFrame: nodeCount + records.size * 2,
  };
  return result(issues, relationshipOrder, nodeOrders, estimate);
}

function validateNodeGraph(
  nodes: unknown[], path: string, layerIds: Set<string>, layers: Map<string, Record<string, unknown>>,
  envelopeIds: Set<string>, issues: MotionProceduralIssue[],
): { ids: Set<string>; order: string[]; depth: number } {
  const ids = new Set<string>();
  nodes.forEach((node, index) => validateProceduralNode(node, `${path}/${index}`, { layerIds, layers, envelopeIds, nodeIds: ids, issues }));
  const dependencies = new Map<string, Set<string>>();
  nodes.forEach((candidate, index) => {
    const node = plainRecord(candidate);
    if (!node || typeof node.id !== "string" || !ids.has(node.id)) return;
    const refs = new Set(proceduralNodeInputs(node));
    for (const ref of refs) if (!ids.has(ref)) issues.push(issue(`${path}/${index}`, "node.input_missing", `references missing input node ${ref}`));
    dependencies.set(node.id, new Set([...refs].filter((ref) => ids.has(ref))));
  });
  const order = proceduralTopologicalOrder(ids, dependencies);
  if (order.length !== ids.size) issues.push(issue(path, "node.cycle", "node inputs must be acyclic"));
  return { ids, order, depth: proceduralGraphDepth(order, dependencies) };
}

function validateEnvelopes(
  value: unknown, context: MotionProceduralGraphContext, layerIds: Set<string>, issues: MotionProceduralIssue[],
): { ids: Set<string>; sampleCount: number } {
  if (value === undefined) return { ids: new Set(), sampleCount: 0 };
  const items = Array.isArray(value) ? value : [];
  if (!Array.isArray(value)) issues.push(issue("/relationships/audioEnvelopes", "envelope.collection", "must be an array"));
  if (items.length > MAX_PROCEDURAL_AUDIO_ENVELOPES) {
    issues.push(issue("/relationships/audioEnvelopes", "envelope.budget", `must contain at most ${MAX_PROCEDURAL_AUDIO_ENVELOPES} envelopes`));
  }
  const ids = new Set<string>();
  let sampleCount = 0;
  items.forEach((candidate, index) => {
    const path = `/relationships/audioEnvelopes/${index}`;
    const envelope = plainRecord(candidate);
    if (!envelope) { issues.push(issue(path, "envelope.object", "must be a plain object")); return; }
    allowOnlyFields(envelope, ["id", "sourceLayerId", "channel", "samples"], path, issues);
    const id = safeGraphId(envelope.id, `${path}/id`, issues);
    if (id && ids.has(id)) issues.push(issue(`${path}/id`, "envelope.id_duplicate", "must be unique"));
    else if (id) ids.add(id);
    if (typeof envelope.sourceLayerId !== "string" || !layerIds.has(envelope.sourceLayerId)) {
      issues.push(issue(`${path}/sourceLayerId`, "envelope.source_missing", "must reference an existing layer"));
    }
    if (envelope.channel !== "mix" && envelope.channel !== "left" && envelope.channel !== "right") {
      issues.push(issue(`${path}/channel`, "envelope.channel", "must be mix, left, or right"));
    }
    const samples = Array.isArray(envelope.samples) ? envelope.samples : [];
    if (!Array.isArray(envelope.samples) || samples.length < 1) issues.push(issue(`${path}/samples`, "envelope.samples", "must be a non-empty array"));
    sampleCount += samples.length;
    let previous = -1;
    samples.forEach((sampleValue, sampleIndex) => {
      const samplePath = `${path}/samples/${sampleIndex}`;
      const sample = plainRecord(sampleValue);
      if (!sample) { issues.push(issue(samplePath, "envelope.sample_object", "must be a plain object")); return; }
      allowOnlyFields(sample, ["atMs", "value"], samplePath, issues);
      if (!isBoundedNumber(sample.atMs, 0, context.durationMs) || Number(sample.atMs) <= previous) {
        issues.push(issue(`${samplePath}/atMs`, "envelope.sample_time", "must be finite, in duration, and strictly increasing"));
      } else previous = Number(sample.atMs);
      if (!isBoundedNumber(sample.value, 0, 1)) issues.push(issue(`${samplePath}/value`, "envelope.sample_value", "must be finite and between 0 and 1"));
    });
  });
  if (sampleCount > MAX_PROCEDURAL_ENVELOPE_SAMPLES) {
    issues.push(issue("/relationships/audioEnvelopes", "envelope.sample_budget", `total samples exceed ${MAX_PROCEDURAL_ENVELOPE_SAMPLES}`));
  }
  return { ids, sampleCount };
}

function relationshipDependencies(records: Map<string, RelationshipRecord>, owners: Map<string, string>): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  for (const record of records.values()) {
    const refs = new Set<string>();
    if (record.enabled) for (const node of record.nodes) {
      const item = plainRecord(node);
      const owner = item?.type === "property" ? owners.get(proceduralPropertyKey(item.ref) ?? "") : undefined;
      if (owner && records.get(owner)?.enabled) refs.add(owner);
    }
    dependencies.set(record.id, refs);
  }
  return dependencies;
}

function emptyEstimate(): MotionProceduralEstimate {
  return { relationshipCount: 0, nodeCount: 0, envelopeSampleCount: 0, maxDepth: 0, maxWorkPerFrame: 0 };
}
function result(
  issues: MotionProceduralIssue[], relationshipOrder: string[], nodeOrders: Record<string, string[]>, estimate: MotionProceduralEstimate,
): MotionProceduralValidationResult { return { ok: issues.length === 0, issues, relationshipOrder, nodeOrders, estimate }; }
function issue(path: string, code: string, message: string): MotionProceduralIssue { return graphIssue(path, code, message); }
