import type {
  MotionCompositingGraphContext,
  MotionCompositingInputPort,
  MotionCompositingIssue,
  MotionCompositingNodeType,
  MotionCompositingResourceEstimate,
} from "./compositing-graph-types";
import {
  allowOnlyFields,
  graphIssue,
  plainRecord,
  safeGraphId,
  validGraphDimension,
} from "./compositing-graph-safety";

export type CompositingNodeMap = Map<string, Record<string, unknown>>;
export type CompositingNodeTypeMap = Map<string, MotionCompositingNodeType>;
export type CompositingIncomingMap = Map<string, Map<string, string>>;
export type CompositingOutgoingMap = Map<string, string[]>;

export interface CompositingTopology {
  incoming: CompositingIncomingMap;
  outgoing: CompositingOutgoingMap;
}

export function buildCompositingTopology(
  edges: unknown[],
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  issues: MotionCompositingIssue[],
): CompositingTopology {
  const incoming: CompositingIncomingMap = new Map();
  const outgoing: CompositingOutgoingMap = new Map();
  const ids = new Set<string>();
  edges.forEach((edge, index) => {
    validateEdge(edge, index, nodes, types, incoming, outgoing, ids, issues);
  });
  validatePorts(types, incoming, outgoing, issues);
  return { incoming, outgoing };
}

export function validateCompositingReachability(
  outputId: string,
  nodes: CompositingNodeMap,
  incoming: CompositingIncomingMap,
  issues: MotionCompositingIssue[],
): void {
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const source of incoming.get(id)?.values() ?? []) visit(source);
  };
  visit(outputId);
  for (const id of nodes.keys()) {
    if (!reachable.has(id)) {
      issues.push(graphIssue(
        `/compositing/nodes/${id}`,
        "node.disconnected",
        "must reach the output node",
      ));
    }
  }
}

export function validateCompositingSources(
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  context: MotionCompositingGraphContext,
  issues: MotionCompositingIssue[],
): void {
  const ids = [...types]
    .filter(([, type]) => type === "source")
    .map(([id]) => String(nodes.get(id)?.layerId));
  if (new Set(ids).size !== ids.length) {
    issues.push(graphIssue(
      "/compositing/nodes",
      "source.duplicate_layer",
      "each source layer may appear once; use graph fan-out instead",
    ));
  }
  const indices = ids
    .map((id) => context.layers.findIndex((layer) => layer.id === id))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  if (indices.some((value, index) => index > 0 && value !== indices[index - 1] + 1)) {
    issues.push(graphIssue(
      "/compositing/nodes",
      "source.noncontiguous",
      "source layers must form one contiguous layer-stack block",
    ));
  }
}

export function compositingTopologicalOrder(
  nodes: CompositingNodeMap,
  incoming: CompositingIncomingMap,
  outgoing: CompositingOutgoingMap,
): string[] {
  const degree = new Map(
    [...nodes.keys()].map((id) => [id, incoming.get(id)?.size ?? 0]),
  );
  const ready = [...degree]
    .filter(([, value]) => value === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const next = (degree.get(target) ?? 1) - 1;
      degree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return order;
}

export function estimateCompositingGraph(
  order: string[],
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  incoming: CompositingIncomingMap,
  outgoing: CompositingOutgoingMap,
  context: MotionCompositingGraphContext,
): MotionCompositingResourceEstimate {
  const pixels = validGraphDimension(context.width) * validGraphDimension(context.height);
  const depth = new Map<string, number>();
  let cost = 0;
  for (const id of order) {
    const node = nodes.get(id)!;
    const parents = [...(incoming.get(id)?.values() ?? [])];
    depth.set(id, 1 + Math.max(0, ...parents.map((parent) => depth.get(parent) ?? 0)));
    cost += nodeCost(types.get(id), node);
  }
  const sourceCount = [...types.values()].filter((type) => type === "source").length;
  const maxFanOut = Math.max(0, ...[...outgoing.values()].map((list) => list.length));
  return {
    nodeCount: nodes.size,
    edgeCount: [...incoming.values()].reduce((sum, ports) => sum + ports.size, 0),
    sourceCount,
    maxDepth: Math.max(0, ...depth.values()),
    maxFanOut,
    pixelOperations: pixels * cost,
    workingBytes: pixels * 4 * Math.max(
      2,
      Math.min(nodes.size, sourceCount + maxFanOut + 3),
    ),
  };
}

function validateEdge(
  value: unknown,
  index: number,
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  incoming: CompositingIncomingMap,
  outgoing: CompositingOutgoingMap,
  ids: Set<string>,
  issues: MotionCompositingIssue[],
): void {
  const path = `/compositing/edges/${index}`;
  const edge = plainRecord(value);
  if (!edge) {
    issues.push(graphIssue(path, "edge.object", "must be a plain object"));
    return;
  }
  allowOnlyFields(edge, ["id", "from", "to"], path, issues);
  const id = safeGraphId(edge.id, `${path}/id`, issues);
  if (id && ids.has(id)) {
    issues.push(graphIssue(`${path}/id`, "edge.id_duplicate", "must be unique"));
  } else if (id) {
    ids.add(id);
  }

  const from = plainRecord(edge.from);
  const to = plainRecord(edge.to);
  if (!from) issues.push(graphIssue(`${path}/from`, "edge.from", "must be a plain object"));
  if (!to) issues.push(graphIssue(`${path}/to`, "edge.to", "must be a plain object"));
  if (!from || !to) return;
  allowOnlyFields(from, ["nodeId", "port"], `${path}/from`, issues);
  allowOnlyFields(to, ["nodeId", "port"], `${path}/to`, issues);
  connectEdge(path, from, to, nodes, types, incoming, outgoing, issues);
}

function connectEdge(
  path: string,
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  incoming: CompositingIncomingMap,
  outgoing: CompositingOutgoingMap,
  issues: MotionCompositingIssue[],
): void {
  const fromId = safeGraphId(from.nodeId, `${path}/from/nodeId`, issues);
  const toId = safeGraphId(to.nodeId, `${path}/to/nodeId`, issues);
  if (from.port !== "output") {
    issues.push(graphIssue(`${path}/from/port`, "edge.output_port", "must equal output"));
  }
  if (fromId && !nodes.has(fromId)) {
    issues.push(graphIssue(`${path}/from/nodeId`, "edge.source_missing", "must reference an existing node"));
  }
  if (toId && !nodes.has(toId)) {
    issues.push(graphIssue(`${path}/to/nodeId`, "edge.target_missing", "must reference an existing node"));
  }
  if (!fromId || !toId || !nodes.has(fromId) || !nodes.has(toId) || from.port !== "output") return;

  const port = typeof to.port === "string" ? to.port : "";
  if (!inputPorts(types.get(toId)).includes(port as MotionCompositingInputPort)) {
    issues.push(graphIssue(`${path}/to/port`, "edge.input_port", "is not valid for the target node"));
    return;
  }
  const nodeInputs = incoming.get(toId) ?? new Map<string, string>();
  if (nodeInputs.has(port)) {
    issues.push(graphIssue(`${path}/to/port`, "edge.input_occupied", "accepts exactly one edge"));
  } else {
    nodeInputs.set(port, fromId);
  }
  incoming.set(toId, nodeInputs);
  outgoing.set(fromId, [...(outgoing.get(fromId) ?? []), toId]);
  if (!portsAreCompatible(types.get(fromId), types.get(toId), port as MotionCompositingInputPort)) {
    issues.push(graphIssue(path, "edge.type_mismatch", "source output is incompatible with target port"));
  }
}

function validatePorts(
  types: CompositingNodeTypeMap,
  incoming: CompositingIncomingMap,
  outgoing: CompositingOutgoingMap,
  issues: MotionCompositingIssue[],
): void {
  for (const [id, type] of types) {
    for (const port of inputPorts(type)) {
      if (!incoming.get(id)?.has(port)) {
        issues.push(graphIssue(
          `/compositing/nodes/${id}`,
          "node.input_missing",
          `requires one ${port} input`,
        ));
      }
    }
    if (type === "source" && incoming.has(id)) {
      issues.push(graphIssue(`/compositing/nodes/${id}`, "source.input", "cannot have inputs"));
    }
    if (type === "output" && (outgoing.get(id)?.length ?? 0) > 0) {
      issues.push(graphIssue(`/compositing/nodes/${id}`, "output.edge", "cannot have outgoing edges"));
    }
    if (type !== "output" && (outgoing.get(id)?.length ?? 0) === 0) {
      issues.push(graphIssue(
        `/compositing/nodes/${id}`,
        "node.unused_output",
        "must feed another node",
      ));
    }
  }
}

function inputPorts(type: MotionCompositingNodeType | undefined): MotionCompositingInputPort[] {
  if (type === "blend") return ["background", "foreground"];
  if (type === "matte") return ["input", "matte"];
  if (type && type !== "source") return ["input"];
  return [];
}

function portsAreCompatible(
  sourceType: MotionCompositingNodeType | undefined,
  targetType: MotionCompositingNodeType | undefined,
  port: MotionCompositingInputPort,
): boolean {
  const source = sourceType === "blend" ? "composite"
    : sourceType && sourceType !== "output" ? "layer"
      : null;
  if (!source || !targetType) return false;
  if (targetType === "blend" || targetType === "output") return true;
  return source === "layer" && (port === "input" || port === "matte");
}

function nodeCost(
  type: MotionCompositingNodeType | undefined,
  node: Record<string, unknown>,
): number {
  if (type === "transform") return 0.25;
  if (type === "matte") return 2;
  if (type === "blur") return 1 + Number(node.radius ?? 0) / 8;
  return type === "output" ? 0 : 1;
}
