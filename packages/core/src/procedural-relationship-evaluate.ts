import { effectiveLayerAtMs, resolveEasing } from "./timeline";
import { plainRecord } from "./compositing-graph-safety";
import { validateMotionProceduralGraph } from "./procedural-relationship-validate";
import {
  MAX_PROCEDURAL_ABS_VALUE,
  MAX_PROCEDURAL_TRIG_INPUT_RADIANS,
  PROCEDURAL_VALUE_DECIMALS,
  type MotionProceduralAudioEnvelope,
  type MotionProceduralGraph,
  type MotionProceduralNode,
  type MotionProceduralProperty,
} from "./procedural-relationship-types";
import type { MotionDocument, MotionLayer } from "./types";

export interface MotionProceduralEvaluation {
  atMs: number;
  layers: MotionLayer[];
  values: Record<string, number>;
}

/** Resolve base keyframes, then apply enabled relationships in deterministic dependency order. */
export function evaluateMotionProceduralLayers(motion: MotionDocument, atMs: number): MotionProceduralEvaluation {
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > motion.durationMs) {
    throw new Error(`Procedural evaluation time must be within 0..${motion.durationMs}ms.`);
  }
  const layers = motion.layers.map((layer) => effectiveLayerAtMs(layer, atMs));
  if (!motion.relationships) return { atMs, layers, values: {} };
  const validation = validateMotionProceduralGraph(motion.relationships, motion);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new Error(`Procedural graph invalid at ${first.path}: ${first.message}`);
  }
  const graph = motion.relationships as MotionProceduralGraph;
  const relationships = new Map(graph.relationships.map((relationship) => [relationship.id, relationship]));
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  const envelopes = new Map((graph.audioEnvelopes ?? []).map((envelope) => [envelope.id, envelope]));
  const values: Record<string, number> = {};
  for (const relationshipId of validation.relationshipOrder) {
    const relationship = relationships.get(relationshipId)!;
    if (!relationship.enabled) continue;
    const nodes = new Map(relationship.nodes.map((node) => [node.id, node]));
    const nodeValues = new Map<string, number>();
    for (const nodeId of validation.nodeOrders[relationshipId] ?? []) {
      const node = nodes.get(nodeId)!;
      nodeValues.set(nodeId, evaluateNode(node, nodeValues, layerById, envelopes, atMs, motion.fps));
    }
    const output = requireValue(nodeValues, relationship.outputNodeId);
    if (!Number.isFinite(output) || Math.abs(output) > MAX_PROCEDURAL_ABS_VALUE) {
      throw new Error(`Procedural relationship ${relationship.id} produced a non-finite or out-of-range value.`);
    }
    const layer = layerById.get(relationship.target.layerId)!;
    setMotionProceduralProperty(layer, relationship.target.property, output);
    values[relationship.id] = output;
  }
  return { atMs, layers, values };
}

export function readMotionProceduralProperty(layer: MotionLayer, property: MotionProceduralProperty): number {
  if (property === "opacity") return finite(layer.opacity) ?? finite(layer.transform?.opacity) ?? 1;
  if (property === "volume") return finite(layer.volume) ?? 1;
  if (property === "pan") return finite(layer.pan) ?? 0;
  if (property === "playbackRate") return finite(layer.playbackRate) ?? 1;
  const parts = property.split(".");
  let value: unknown = layer;
  for (const part of parts) value = plainRecord(value)?.[part];
  const number = finite(value);
  if (number !== null) return number;
  if (property === "transform.scale" || property === "effects.brightness"
    || property === "effects.contrast" || property === "effects.saturate") return 1;
  if (property.startsWith("transform.") || property.startsWith("style.")
    || property.startsWith("effects.")) return 0;
  throw new Error(`Procedural property ${property} is unavailable on layer ${layer.id}.`);
}

export function setMotionProceduralProperty(layer: MotionLayer, property: MotionProceduralProperty, value: number): void {
  const resolved = quantize(value);
  if (!Number.isFinite(resolved) || Math.abs(resolved) > MAX_PROCEDURAL_ABS_VALUE) {
    throw new Error(`Procedural property ${property} received an invalid value.`);
  }
  if (property === "opacity") {
    layer.opacity = resolved;
    layer.transform = { ...(layer.transform ?? {}), opacity: resolved };
    return;
  }
  if (property === "volume" || property === "pan" || property === "playbackRate") {
    (layer as unknown as Record<string, unknown>)[property] = resolved;
    return;
  }
  const parts = property.split(".");
  const root = parts.shift()!;
  const source = structuredClone(plainRecord((layer as unknown as Record<string, unknown>)[root]) ?? {});
  let cursor = source;
  while (parts.length > 1) {
    const part = parts.shift()!;
    const next = plainRecord(cursor[part]);
    if (!next) throw new Error(`Procedural property ${property} is unavailable on layer ${layer.id}.`);
    cursor[part] = structuredClone(next);
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[0]] = resolved;
  (layer as unknown as Record<string, unknown>)[root] = source;
}

function evaluateNode(
  node: MotionProceduralNode,
  values: Map<string, number>,
  layers: Map<string, MotionLayer>,
  envelopes: Map<string, MotionProceduralAudioEnvelope>,
  atMs: number,
  fps: number,
): number {
  let output: number;
  if (node.type === "constant") output = node.value;
  else if (node.type === "property") output = readMotionProceduralProperty(layers.get(node.ref.layerId)!, node.ref.property);
  else if (node.type === "time") output = node.unit === "seconds" ? atMs / 1000 : atMs;
  else if (node.type === "frame") output = Math.floor((atMs * fps) / 1000 + 1e-9);
  else if (node.type === "audio-envelope") output = sampleEnvelope(envelopes.get(node.envelopeId)!, atMs);
  else if (node.type === "abs") output = Math.abs(requireValue(values, node.input));
  else if (node.type === "negate") output = -requireValue(values, node.input);
  else if (node.type === "sin" || node.type === "cos") output = evaluateTrig(node.type, node.id, requireValue(values, node.input));
  else if (node.type === "add") output = requireValue(values, node.left) + requireValue(values, node.right);
  else if (node.type === "subtract") output = requireValue(values, node.left) - requireValue(values, node.right);
  else if (node.type === "multiply") output = requireValue(values, node.left) * requireValue(values, node.right);
  else if (node.type === "divide") output = divide(requireValue(values, node.left), requireValue(values, node.right), node.id);
  else if (node.type === "min") output = Math.min(requireValue(values, node.left), requireValue(values, node.right));
  else if (node.type === "max") output = Math.max(requireValue(values, node.left), requireValue(values, node.right));
  else if (node.type === "clamp") output = clampNode(node.id, requireValue(values, node.input), requireValue(values, node.min), requireValue(values, node.max));
  else if (node.type === "map") output = mapNode(node, values);
  else if (node.type === "ease") output = resolveEasing(node.easing)(clamp(requireValue(values, node.input), 0, 1));
  else if (node.type === "distance") {
    const dx = requireValue(values, node.x2) - requireValue(values, node.x1);
    const dy = requireValue(values, node.y2) - requireValue(values, node.y1);
    output = Math.sqrt(dx * dx + dy * dy);
  } else if (node.type === "noise") output = deterministicNoise(requireValue(values, node.input), node.seed, node.frequency);
  else throw new Error("Unsupported procedural node reached evaluation.");
  return quantize(output);
}

function mapNode(node: Extract<MotionProceduralNode, { type: "map" }>, values: Map<string, number>): number {
  const input = requireValue(values, node.input);
  const inMin = requireValue(values, node.inMin);
  const inMax = requireValue(values, node.inMax);
  const outMin = requireValue(values, node.outMin);
  const outMax = requireValue(values, node.outMax);
  if (inMin === inMax) throw new Error(`Procedural map node ${node.id} has a zero input range.`);
  const progress = (input - inMin) / (inMax - inMin);
  const t = node.clamp ? clamp(progress, 0, 1) : progress;
  return outMin + (outMax - outMin) * t;
}

function sampleEnvelope(envelope: MotionProceduralAudioEnvelope, atMs: number): number {
  const samples = envelope.samples;
  if (atMs <= samples[0].atMs) return samples[0].value;
  const last = samples.at(-1)!;
  if (atMs >= last.atMs) return last.value;
  let low = 0; let high = samples.length - 1;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (samples[mid].atMs <= atMs) low = mid; else high = mid; }
  const left = samples[low]; const right = samples[high];
  return left.value + (right.value - left.value) * ((atMs - left.atMs) / (right.atMs - left.atMs));
}

function deterministicNoise(input: number, seed: number, frequency: number): number {
  const position = input * frequency;
  const left = Math.floor(position);
  const t = position - left;
  const smooth = t * t * (3 - 2 * t);
  const a = hashNoise(left, seed); const b = hashNoise(left + 1, seed);
  return a + (b - a) * smooth;
}

function hashNoise(index: number, seed: number): number {
  let value = (index | 0) ^ (seed | 0);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return ((value >>> 0) / 0xffffffff) * 2 - 1;
}

function divide(left: number, right: number, id: string): number {
  if (right === 0) throw new Error(`Procedural divide node ${id} divides by zero.`);
  return left / right;
}
function clampNode(id: string, value: number, min: number, max: number): number {
  if (min > max) throw new Error(`Procedural clamp node ${id} has min greater than max.`);
  return clamp(value, min, max);
}
function requireValue(values: Map<string, number>, id: string): number {
  const value = values.get(id);
  if (value === undefined) throw new Error(`Procedural node input ${id} is unavailable.`);
  return value;
}
/** Stable observable/baked scalar rule: finite values are rounded to six decimals and -0 becomes 0. */
export function quantizeMotionProceduralValue(value: number): number {
  const result = Number(value.toFixed(PROCEDURAL_VALUE_DECIMALS));
  return Object.is(result, -0) ? 0 : result;
}
function quantize(value: number): number { return quantizeMotionProceduralValue(value); }
function evaluateTrig(type: "sin" | "cos", id: string, input: number): number {
  if (!Number.isFinite(input) || Math.abs(input) > MAX_PROCEDURAL_TRIG_INPUT_RADIANS) {
    throw new Error(`Procedural ${type} node ${id} requires finite radians within +/-${MAX_PROCEDURAL_TRIG_INPUT_RADIANS}.`);
  }
  const radians = quantizeMotionProceduralValue(input);
  return type === "sin" ? Math.sin(radians) : Math.cos(radians);
}
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
