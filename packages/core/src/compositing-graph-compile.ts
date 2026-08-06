import { canonicalJson } from "./canonical-json";
import type { MotionDocument, MotionEffects, MotionLayer } from "./types";
import {
  MOTION_COMPOSITING_COMPILE_SCHEMA,
  type CompiledMotionCompositingGraph, type MotionCompositingCompileMetadata,
  type MotionCompositingEdge, type MotionCompositingGraph,
  type MotionCompositingInputPort, type MotionCompositingIssue, type MotionCompositingNode,
} from "./compositing-graph-types";
import { plainRecord } from "./compositing-graph-safety";
import { validateMotionCompositingGraph } from "./compositing-graph-validate";

interface GraphValue { layers: MotionLayer[]; terminalId: string }
const COMPILE_METADATA_KEY = "x-compositing-compile" as const;
const SOURCE_VISIBLE_KEY = "x-compositing-source-visible" as const;
const GENERATED_LAYER_KEY = "x-compositing-generated" as const;

export class MotionCompositingGraphError extends Error {
  constructor(readonly issues: MotionCompositingIssue[]) {
    super(issues[0]?.message ?? "Motion compositing graph is invalid.");
    this.name = "MotionCompositingGraphError";
  }
}

/** Compile a validated data-only graph to the existing deterministic MotionIR layer stack. */
export function compileMotionCompositingGraph(document: MotionDocument, graph: MotionCompositingGraph): CompiledMotionCompositingGraph {
  const sourceDocument = restoreMotionDocumentCompositing(document);
  const validation = validateMotionCompositingGraph(graph, {
    width: sourceDocument.width,
    height: sourceDocument.height,
    layers: sourceDocument.layers,
  });
  if (!validation.ok) throw new MotionCompositingGraphError(validation.issues);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = incomingEdges(graph.edges); const values = new Map<string, GraphValue>();
  for (const nodeId of validation.order) {
    values.set(nodeId, compileNode(
      graph.id,
      nodes.get(nodeId)!,
      incoming.get(nodeId),
      values,
      sourceDocument.layers,
    ));
  }
  const output = graph.nodes.find((node) => node.type === "output")!;
  const compiled = values.get(output.id)!;
  const sourceLayerIds = graph.nodes.filter((node) => node.type === "source").map((node) => node.layerId);
  return {
    layers: compiled.layers.map(clone),
    sourceLayers: sourceDocument.layers
      .filter((layer) => sourceLayerIds.includes(layer.id))
      .map(clone),
    metadata: {
      schema: MOTION_COMPOSITING_COMPILE_SCHEMA,
      graphId: graph.id,
      fingerprint: compositingGraphFingerprint(graph),
      nodeOrder: [...validation.order],
      sourceLayerIds,
      outputLayerIds: compiled.layers.map((layer) => layer.id),
      estimate: validation.estimate,
    },
  };
}

/** Preserve the source layer block as hidden round-trip data and insert its compiled equivalent in-place. */
export function compileMotionDocumentCompositing(document: MotionDocument): MotionDocument {
  if (!document.compositing) return clone(document);
  const sourceDocument = restoreMotionDocumentCompositing(document);
  const result = compileMotionCompositingGraph(sourceDocument, document.compositing);
  const sources = new Set(result.metadata.sourceLayerIds);
  const lastSourceIndex = Math.max(
    ...sourceDocument.layers.map((layer, index) => sources.has(layer.id) ? index : -1),
  );
  const layers = sourceDocument.layers.flatMap((layer, index) => {
    const source = sources.has(layer.id)
      ? [{
        ...clone(layer),
        visible: false,
        [SOURCE_VISIBLE_KEY]: layer.visible === undefined ? "unset" : layer.visible,
      } as MotionLayer]
      : [clone(layer)];
    const generated = result.layers.map((output) => ({
      ...clone(output),
      [GENERATED_LAYER_KEY]: {
        schema: MOTION_COMPOSITING_COMPILE_SCHEMA,
        graphId: result.metadata.graphId,
        fingerprint: result.metadata.fingerprint,
      },
    } as MotionLayer));
    return index === lastSourceIndex ? [...source, ...generated] : source;
  });
  return { ...sourceDocument, layers, [COMPILE_METADATA_KEY]: result.metadata };
}

/** Remove generated graph output and restore the original editable source layer block. */
export function restoreMotionDocumentCompositing(document: MotionDocument): MotionDocument {
  const restored = clone(document);
  const metadata = readCompileMetadata(restored[COMPILE_METADATA_KEY]);
  if (!metadata) return restored;
  const graph = restored.compositing;
  if (!graph || graph.id !== metadata.graphId
    || compositingGraphFingerprint(graph) !== metadata.fingerprint) {
    throw new Error("Motion compositing compile metadata is not bound to the editable graph.");
  }
  const generated = new Set(metadata.outputLayerIds);
  const sources = new Set(metadata.sourceLayerIds);
  if (generated.size !== metadata.outputLayerIds.length || sources.size !== metadata.sourceLayerIds.length
    || metadata.outputLayerIds.some((id) => sources.has(id))) {
    throw new Error("Motion compositing compile metadata contains ambiguous layer identities.");
  }
  const counts = new Map<string, number>();
  for (const layer of restored.layers) counts.set(layer.id, (counts.get(layer.id) ?? 0) + 1);
  for (const id of [...sources, ...generated]) {
    if (counts.get(id) !== 1) throw new Error("Motion compositing compile metadata does not identify one package layer.");
  }
  for (const layer of restored.layers) {
    if (sources.has(layer.id)) assertCompiledSourceLayer(layer);
    if (generated.has(layer.id)) assertGeneratedLayer(layer, metadata);
    else if (layer[GENERATED_LAYER_KEY] !== undefined) {
      throw new Error("Motion compositing generated-layer marker is not declared by compile metadata.");
    }
  }
  restored.layers = restored.layers
    .filter((layer) => !generated.has(layer.id))
    .map((layer) => sources.has(layer.id) ? restoreSourceLayer(layer) : layer);
  delete restored[COMPILE_METADATA_KEY];
  const expected = compileMotionCompositingGraph(restored, graph).metadata;
  if (canonicalJson(metadata) !== canonicalJson(expected)) {
    throw new Error("Motion compositing compile metadata does not match deterministic graph compilation.");
  }
  return restored;
}

export function compositingGraphFingerprint(graph: MotionCompositingGraph): string {
  const text = canonicalJson(graph); let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) { hash ^= BigInt(text.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return hash.toString(16).padStart(16, "0");
}

function compileNode(graphId: string, node: MotionCompositingNode, edges: Map<MotionCompositingInputPort, MotionCompositingEdge> | undefined, values: Map<string, GraphValue>, sourceLayers: MotionLayer[]): GraphValue {
  if (node.type === "source") {
    const source = sourceLayers.find((layer) => layer.id === node.layerId)!;
    const layer = { ...clone(source), id: compiledLayerId(graphId, node.id) };
    return { layers: [layer], terminalId: layer.id };
  }
  const read = (port: MotionCompositingInputPort) => values.get(edges!.get(port)!.from.nodeId)!;
  if (node.type === "output") return cloneValue(read("input"));
  if (node.type === "blend") {
    const background = rekeyValue(read("background"), `${graphId}.${node.id}.background`);
    const foreground = rekeyValue(read("foreground"), `${graphId}.${node.id}.foreground`);
    const layers = foreground.layers.map((layer) => layer.id === foreground.terminalId ? { ...layer, blendMode: node.mode } : layer);
    return { layers: [...background.layers, ...layers], terminalId: foreground.terminalId };
  }
  if (node.type === "matte") {
    const matte = rekeyValue(read("matte"), `${graphId}.${node.id}.matte`);
    const input = rekeyValue(read("input"), `${graphId}.${node.id}.input`);
    const layers = input.layers.map((layer) => layer.id === input.terminalId
      ? { ...layer, matte: { type: node.matteType, sourceLayerId: matte.terminalId } } : layer);
    return { layers: [...matte.layers, ...layers], terminalId: input.terminalId };
  }
  const input = cloneValue(read("input")); const terminal = input.layers.find((layer) => layer.id === input.terminalId)!;
  const id = compiledLayerId(graphId, node.id);
  let changed: MotionLayer;
  if (node.type === "transform") changed = { ...terminal, id, transform: { ...(terminal.transform ?? {}), ...clone(node.transform) } };
  else if (node.type === "mask") changed = { ...terminal, id, mask: clone(node.mask) };
  else if (node.type === "color") changed = { ...terminal, id, effects: mergeEffects(terminal.effects, node) };
  else changed = { ...terminal, id, effects: { ...(terminal.effects ?? {}), blur: node.radius } };
  return { layers: replaceTerminal(input.layers, input.terminalId, changed), terminalId: id };
}

function mergeEffects(current: MotionEffects | undefined, node: Extract<MotionCompositingNode, { type: "color" }>): MotionEffects {
  return {
    ...(current ?? {}),
    ...(node.brightness !== undefined ? { brightness: node.brightness } : {}),
    ...(node.contrast !== undefined ? { contrast: node.contrast } : {}),
    ...(node.saturate !== undefined ? { saturate: node.saturate } : {}),
    ...(node.grayscale !== undefined ? { grayscale: node.grayscale } : {}),
  };
}

function replaceTerminal(layers: MotionLayer[], oldId: string, changed: MotionLayer): MotionLayer[] {
  return layers.map((layer) => {
    const next = layer.id === oldId ? changed : clone(layer);
    return next.matte?.sourceLayerId === oldId ? { ...next, matte: { ...next.matte, sourceLayerId: changed.id } } : next;
  });
}

function rekeyValue(value: GraphValue, prefix: string): GraphValue {
  const ids = new Map(value.layers.map((layer, index) => [layer.id, `cg.${prefix}.${index}`]));
  return {
    layers: value.layers.map((layer) => ({
      ...clone(layer), id: ids.get(layer.id)!,
      ...(layer.matte ? { matte: { ...layer.matte, sourceLayerId: ids.get(layer.matte.sourceLayerId) ?? layer.matte.sourceLayerId } } : {}),
    })),
    terminalId: ids.get(value.terminalId)!,
  };
}

function incomingEdges(edges: MotionCompositingEdge[]): Map<string, Map<MotionCompositingInputPort, MotionCompositingEdge>> {
  const result = new Map<string, Map<MotionCompositingInputPort, MotionCompositingEdge>>();
  for (const edge of edges) { const ports = result.get(edge.to.nodeId) ?? new Map(); ports.set(edge.to.port, edge); result.set(edge.to.nodeId, ports); }
  return result;
}

function restoreSourceLayer(layer: MotionLayer): MotionLayer {
  const restored = clone(layer);
  const previous = restored[SOURCE_VISIBLE_KEY];
  if (previous === "unset") delete restored.visible;
  else if (typeof previous === "boolean") restored.visible = previous;
  delete restored[SOURCE_VISIBLE_KEY];
  return restored;
}

function readCompileMetadata(value: unknown): MotionCompositingCompileMetadata | null {
  if (value === undefined) return null;
  const metadata = plainRecord(value);
  if (!metadata || metadata.schema !== MOTION_COMPOSITING_COMPILE_SCHEMA
    || typeof metadata.graphId !== "string" || !metadata.graphId
    || typeof metadata.fingerprint !== "string" || !/^[a-f0-9]{16}$/.test(metadata.fingerprint)
    || !isIdList(metadata.nodeOrder, 64) || !isIdList(metadata.sourceLayerIds, 64)
    || !isIdList(metadata.outputLayerIds, 128) || !plainRecord(metadata.estimate)) {
    throw new Error("Motion compositing compile metadata is invalid.");
  }
  return clone(metadata) as unknown as MotionCompositingCompileMetadata;
}

function isIdList(value: unknown, max: number): value is string[] {
  return Array.isArray(value)
    && value.length <= max
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256);
}

function assertCompiledSourceLayer(layer: MotionLayer): void {
  const previous = layer[SOURCE_VISIBLE_KEY];
  if (layer.visible !== false || (previous !== "unset" && typeof previous !== "boolean")) {
    throw new Error("Motion compositing source layer lacks a valid visibility restoration marker.");
  }
}

function assertGeneratedLayer(layer: MotionLayer, metadata: MotionCompositingCompileMetadata): void {
  const marker = plainRecord(layer[GENERATED_LAYER_KEY]);
  if (!marker || marker.schema !== MOTION_COMPOSITING_COMPILE_SCHEMA
    || marker.graphId !== metadata.graphId || marker.fingerprint !== metadata.fingerprint
    || Object.keys(marker).some((key) => !["schema", "graphId", "fingerprint"].includes(key))) {
    throw new Error("Motion compositing output layer lacks its graph-bound generated marker.");
  }
}

function compiledLayerId(graphId: string, nodeId: string): string { return `cg.${graphId}.${nodeId}`; }
function cloneValue(value: GraphValue): GraphValue { return { layers: value.layers.map(clone), terminalId: value.terminalId }; }
function clone<T>(value: T): T { return structuredClone(value); }
