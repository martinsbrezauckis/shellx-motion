import type {
  MotionCompositingGraphContext,
  MotionCompositingIssue,
} from "./compositing-graph-types";
import { graphIssue, plainRecord } from "./compositing-graph-safety";
import type {
  CompositingIncomingMap,
  CompositingNodeMap,
  CompositingNodeTypeMap,
} from "./compositing-graph-topology";

export function validateCompositingMatteBranches(
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  incoming: CompositingIncomingMap,
  context: MotionCompositingGraphContext,
  issues: MotionCompositingIssue[],
): void {
  for (const [id, type] of types) {
    if (type !== "matte") continue;
    validateMatteBranch("matte", id, nodes, types, incoming, context, issues);
    validateMatteBranch("input", id, nodes, types, incoming, context, issues);
  }
}

function validateMatteBranch(
  port: "matte" | "input",
  matteNodeId: string,
  nodes: CompositingNodeMap,
  types: CompositingNodeTypeMap,
  incoming: CompositingIncomingMap,
  context: MotionCompositingGraphContext,
  issues: MotionCompositingIssue[],
): void {
  let current = incoming.get(matteNodeId)?.get(port);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const currentType = types.get(current);
    const node = nodes.get(current);
    if (currentType === "source") {
      validateMatteSource(port, current, node, context, issues);
      break;
    }
    if (currentType !== "transform" && (port === "matte" || currentType === "blend")) {
      issues.push(graphIssue(
        `/compositing/nodes/${current}`,
        "matte.branch_type",
        `${port} branch contains an unsupported node`,
      ));
      break;
    }
    if (currentType === "transform") {
      validateMatteTransform(port, current, node, issues);
    }
    current = incoming.get(current)?.get("input");
  }
}

function validateMatteSource(
  port: "matte" | "input",
  nodeId: string,
  node: Record<string, unknown> | undefined,
  context: MotionCompositingGraphContext,
  issues: MotionCompositingIssue[],
): void {
  const layer = context.layers.find((candidate) => candidate.id === node?.layerId);
  if (port === "matte" && layer?.type !== "shape") {
    issues.push(graphIssue(
      `/compositing/nodes/${nodeId}`,
      "matte.source_type",
      "matte input must originate from a shape layer",
    ));
  }
  const unsupported = layer && [
    layer.mask,
    layer.matte,
    layer.effects,
    layer.blendMode,
    layer.transitions,
    layer.keyframes,
    layer.label,
  ].some((value) => value !== undefined);
  if (port === "matte" && unsupported) {
    issues.push(graphIssue(
      `/compositing/nodes/${nodeId}`,
      "matte.source_semantics",
      "matte source cannot carry masks, mattes, effects, blends, transitions, keyframes, or labels",
    ));
  }
  if (port === "input" && layer?.effects?.motionBlur) {
    issues.push(graphIssue(
      `/compositing/nodes/${nodeId}`,
      "matte.consumer_motion_blur",
      "matte consumer cannot carry motion blur",
    ));
  }
}

function validateMatteTransform(
  port: "matte" | "input",
  nodeId: string,
  node: Record<string, unknown> | undefined,
  issues: MotionCompositingIssue[],
): void {
  const transform = plainRecord(node?.transform);
  const unsupported = (transform?.rotation !== undefined && transform.rotation !== 0)
    || (transform?.scale !== undefined && transform.scale !== 1)
    || (port === "matte" && transform?.opacity !== undefined && transform.opacity !== 1);
  if (unsupported) {
    issues.push(graphIssue(
      `/compositing/nodes/${nodeId}/transform`,
      "matte.transform",
      "matte branches do not support rotation, scale, or source opacity changes",
    ));
  }
}
