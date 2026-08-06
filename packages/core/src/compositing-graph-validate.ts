import {
  MAX_COMPOSITING_GRAPH_DEPTH,
  MAX_COMPOSITING_GRAPH_EDGES,
  MAX_COMPOSITING_GRAPH_NODES,
  MAX_COMPOSITING_PIXEL_OPERATIONS,
  MAX_COMPOSITING_WORKING_BYTES,
  MOTION_COMPOSITING_GRAPH_SCHEMA,
  type MotionCompositingGraphContext,
  type MotionCompositingIssue,
  type MotionCompositingNodeType,
  type MotionCompositingResourceEstimate,
  type MotionCompositingValidationResult,
} from "./compositing-graph-types";
import { validateCompositingNode } from "./compositing-graph-node-validate";
import { validateCompositingMatteBranches } from "./compositing-graph-matte-validate";
import { allowOnlyFields, graphIssue, plainRecord, safeGraphId } from "./compositing-graph-safety";
import {
  buildCompositingTopology,
  compositingTopologicalOrder,
  estimateCompositingGraph,
  validateCompositingReachability,
  validateCompositingSources,
} from "./compositing-graph-topology";

export function validateMotionCompositingGraph(
  value: unknown,
  context: MotionCompositingGraphContext,
): MotionCompositingValidationResult {
  const issues: MotionCompositingIssue[] = [];
  const graph = plainRecord(value);
  if (!graph) {
    return result(
      [graphIssue("/compositing", "graph.object", "must be a plain object")],
      [],
      emptyEstimate(),
    );
  }
  allowOnlyFields(graph, ["schema", "id", "nodes", "edges"], "/compositing", issues);
  if (graph.schema !== MOTION_COMPOSITING_GRAPH_SCHEMA) {
    issues.push(graphIssue(
      "/compositing/schema",
      "graph.schema",
      `must equal ${MOTION_COMPOSITING_GRAPH_SCHEMA}`,
    ));
  }
  safeGraphId(graph.id, "/compositing/id", issues);

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  validateCollectionShapes(graph, nodes, edges, issues);

  const nodeById = new Map<string, Record<string, unknown>>();
  const nodeTypes = new Map<string, MotionCompositingNodeType>();
  nodes.forEach((candidate, index) => {
    validateCompositingNode(candidate, index, context, nodeById, nodeTypes, issues);
  });
  const topology = buildCompositingTopology(edges, nodeById, nodeTypes, issues);
  validateCompositingMatteBranches(
    nodeById,
    nodeTypes,
    topology.incoming,
    context,
    issues,
  );

  const outputs = [...nodeTypes]
    .filter(([, type]) => type === "output")
    .map(([id]) => id);
  if (outputs.length !== 1) {
    issues.push(graphIssue(
      "/compositing/nodes",
      "graph.output_count",
      "must contain exactly one output node",
    ));
  }
  const order = compositingTopologicalOrder(
    nodeById,
    topology.incoming,
    topology.outgoing,
  );
  if (order.length !== nodeById.size) {
    issues.push(graphIssue("/compositing/edges", "graph.cycle", "must be acyclic"));
  }
  if (outputs[0]) {
    validateCompositingReachability(outputs[0], nodeById, topology.incoming, issues);
  }

  const estimate = estimateCompositingGraph(
    order,
    nodeById,
    nodeTypes,
    topology.incoming,
    topology.outgoing,
    context,
  );
  validateResourceBudgets(estimate, issues);
  validateCompositingSources(nodeById, nodeTypes, context, issues);
  return result(issues, order, estimate);
}

function validateCollectionShapes(
  graph: Record<string, unknown>,
  nodes: unknown[],
  edges: unknown[],
  issues: MotionCompositingIssue[],
): void {
  if (!Array.isArray(graph.nodes)) {
    issues.push(graphIssue("/compositing/nodes", "graph.nodes", "must be an array"));
  }
  if (!Array.isArray(graph.edges)) {
    issues.push(graphIssue("/compositing/edges", "graph.edges", "must be an array"));
  }
  if (nodes.length < 2 || nodes.length > MAX_COMPOSITING_GRAPH_NODES) {
    issues.push(graphIssue(
      "/compositing/nodes",
      "graph.node_budget",
      `must contain 2..${MAX_COMPOSITING_GRAPH_NODES} nodes`,
    ));
  }
  if (edges.length < 1 || edges.length > MAX_COMPOSITING_GRAPH_EDGES) {
    issues.push(graphIssue(
      "/compositing/edges",
      "graph.edge_budget",
      `must contain 1..${MAX_COMPOSITING_GRAPH_EDGES} edges`,
    ));
  }
}

function validateResourceBudgets(
  estimate: MotionCompositingResourceEstimate,
  issues: MotionCompositingIssue[],
): void {
  if (estimate.maxDepth > MAX_COMPOSITING_GRAPH_DEPTH) {
    issues.push(graphIssue(
      "/compositing",
      "graph.depth_budget",
      `depth exceeds ${MAX_COMPOSITING_GRAPH_DEPTH}`,
    ));
  }
  if (estimate.pixelOperations > MAX_COMPOSITING_PIXEL_OPERATIONS) {
    issues.push(graphIssue(
      "/compositing",
      "graph.pixel_budget",
      `estimated pixel operations exceed ${MAX_COMPOSITING_PIXEL_OPERATIONS}`,
    ));
  }
  if (estimate.workingBytes > MAX_COMPOSITING_WORKING_BYTES) {
    issues.push(graphIssue(
      "/compositing",
      "graph.memory_budget",
      `estimated working bytes exceed ${MAX_COMPOSITING_WORKING_BYTES}`,
    ));
  }
}

function emptyEstimate(): MotionCompositingResourceEstimate {
  return {
    nodeCount: 0,
    edgeCount: 0,
    sourceCount: 0,
    maxDepth: 0,
    maxFanOut: 0,
    pixelOperations: 0,
    workingBytes: 0,
  };
}

function result(
  issues: MotionCompositingIssue[],
  order: string[],
  estimate: MotionCompositingResourceEstimate,
): MotionCompositingValidationResult {
  return { ok: issues.length === 0, issues, order, estimate };
}
