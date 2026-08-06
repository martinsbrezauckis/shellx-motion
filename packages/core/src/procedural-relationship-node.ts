import { allowOnlyFields, graphIssue, isBoundedNumber, plainRecord, safeGraphId } from "./compositing-graph-safety";
import { isSafeShaderUniformName } from "./shader-plugin";
import { isSupportedEasing } from "./timeline";
import {
  MAX_PROCEDURAL_ABS_VALUE,
  MOTION_PROCEDURAL_PROPERTIES,
  type MotionProceduralIssue,
  type MotionProceduralProperty,
} from "./procedural-relationship-types";

const PROPERTY_SET = new Set<string>(MOTION_PROCEDURAL_PROPERTIES);
const NODE_TYPES = new Set([
  "constant", "property", "time", "frame", "audio-envelope", "abs", "negate",
  "add", "subtract", "multiply", "divide", "min", "max", "clamp", "map",
  "ease", "distance", "noise",
]);

export interface ProceduralNodeValidationContext {
  layerIds: Set<string>;
  layers: Map<string, Record<string, unknown>>;
  envelopeIds: Set<string>;
  nodeIds: Set<string>;
  issues: MotionProceduralIssue[];
}

export function isMotionProceduralProperty(value: unknown): value is MotionProceduralProperty {
  if (typeof value !== "string") return false;
  if (PROPERTY_SET.has(value)) return true;
  return value.startsWith("shader.uniforms.") && isSafeShaderUniformName(value.slice("shader.uniforms.".length));
}

export function validateProceduralNode(value: unknown, path: string, context: ProceduralNodeValidationContext): string | null {
  const node = plainRecord(value);
  if (!node) { context.issues.push(issue(path, "node.object", "must be a plain object")); return null; }
  const id = safeGraphId(node.id, `${path}/id`, context.issues);
  if (id && context.nodeIds.has(id)) context.issues.push(issue(`${path}/id`, "node.id_duplicate", "must be unique"));
  else if (id) context.nodeIds.add(id);
  const type = typeof node.type === "string" ? node.type : "";
  if (!NODE_TYPES.has(type)) context.issues.push(issue(`${path}/type`, "node.type", "is not an allow-listed procedural node"));
  allowOnlyFields(node, fieldsFor(type), path, context.issues);
  validateNodeData(node, type, path, context);
  return id;
}

export function proceduralNodeInputs(value: unknown): string[] {
  const node = plainRecord(value);
  if (!node) return [];
  if (node.type === "abs" || node.type === "negate" || node.type === "ease" || node.type === "noise") return strings(node.input);
  if (["add", "subtract", "multiply", "divide", "min", "max"].includes(String(node.type))) return strings(node.left, node.right);
  if (node.type === "clamp") return strings(node.input, node.min, node.max);
  if (node.type === "map") return strings(node.input, node.inMin, node.inMax, node.outMin, node.outMax);
  if (node.type === "distance") return strings(node.x1, node.y1, node.x2, node.y2);
  return [];
}

export function proceduralPropertyKey(ref: unknown): string | null {
  const item = plainRecord(ref);
  return item && typeof item.layerId === "string" && isMotionProceduralProperty(item.property)
    ? `${item.layerId}/${item.property}` : null;
}

function validateNodeData(node: Record<string, unknown>, type: string, path: string, context: ProceduralNodeValidationContext): void {
  if (type === "constant" && !isBoundedNumber(node.value, -MAX_PROCEDURAL_ABS_VALUE, MAX_PROCEDURAL_ABS_VALUE)) {
    context.issues.push(issue(`${path}/value`, "node.value", "must be a bounded finite number"));
  }
  if (type === "property") validateRef(node.ref, `${path}/ref`, context);
  if (type === "time" && node.unit !== "seconds" && node.unit !== "milliseconds") {
    context.issues.push(issue(`${path}/unit`, "node.time_unit", "must be seconds or milliseconds"));
  }
  if (type === "audio-envelope" && (typeof node.envelopeId !== "string" || !context.envelopeIds.has(node.envelopeId))) {
    context.issues.push(issue(`${path}/envelopeId`, "node.envelope_missing", "must reference an existing audio envelope"));
  }
  if (type === "ease" && (typeof node.easing !== "string" || !isSupportedEasing(node.easing))) {
    context.issues.push(issue(`${path}/easing`, "node.easing", "must be a supported deterministic easing"));
  }
  if (type === "map" && typeof node.clamp !== "boolean") {
    context.issues.push(issue(`${path}/clamp`, "node.map_clamp", "must be boolean"));
  }
  if (type === "noise") {
    if (!Number.isInteger(node.seed) || Number(node.seed) < -2_147_483_648 || Number(node.seed) > 2_147_483_647) {
      context.issues.push(issue(`${path}/seed`, "node.noise_seed", "must be a signed 32-bit integer"));
    }
    if (!isBoundedNumber(node.frequency, 0.000001, 10_000)) {
      context.issues.push(issue(`${path}/frequency`, "node.noise_frequency", "must be finite and between 0.000001 and 10000"));
    }
  }
}

export function validateRef(value: unknown, path: string, context: Pick<ProceduralNodeValidationContext, "layerIds" | "layers" | "issues">): void {
  const ref = plainRecord(value);
  if (!ref) { context.issues.push(issue(path, "property.object", "must be a plain object")); return; }
  allowOnlyFields(ref, ["layerId", "property"], path, context.issues);
  if (typeof ref.layerId !== "string" || !context.layerIds.has(ref.layerId)) {
    context.issues.push(issue(`${path}/layerId`, "property.layer_missing", "must reference an existing layer"));
  }
  if (!isMotionProceduralProperty(ref.property)) {
    context.issues.push(issue(`${path}/property`, "property.unsupported", "must be an allow-listed numeric property"));
  } else if (typeof ref.layerId === "string" && context.layers.has(ref.layerId)
    && !proceduralPropertyAvailable(context.layers.get(ref.layerId)!, ref.property)) {
    context.issues.push(issue(`${path}/property`, "property.unavailable", "is not available on the referenced layer"));
  }
}

function proceduralPropertyAvailable(layer: Record<string, unknown>, property: MotionProceduralProperty): boolean {
  if (property.startsWith("gradient.")) return plainRecord(layer.gradient) !== null;
  if (property === "effects.glow.radius") return plainRecord(plainRecord(layer.effects)?.glow) !== null;
  if (property.startsWith("environment.")) return readPath(layer, property) !== null;
  if (property.startsWith("shader.uniforms.")) return readPath(layer, property) !== null;
  return true;
}

function readPath(layer: Record<string, unknown>, property: string): number | null {
  let value: unknown = layer;
  for (const part of property.split(".")) value = plainRecord(value)?.[part];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fieldsFor(type: string): string[] {
  if (type === "constant") return ["id", "type", "value"];
  if (type === "property") return ["id", "type", "ref"];
  if (type === "time") return ["id", "type", "unit"];
  if (type === "frame") return ["id", "type"];
  if (type === "audio-envelope") return ["id", "type", "envelopeId"];
  if (type === "abs" || type === "negate") return ["id", "type", "input"];
  if (["add", "subtract", "multiply", "divide", "min", "max"].includes(type)) return ["id", "type", "left", "right"];
  if (type === "clamp") return ["id", "type", "input", "min", "max"];
  if (type === "map") return ["id", "type", "input", "inMin", "inMax", "outMin", "outMax", "clamp"];
  if (type === "ease") return ["id", "type", "input", "easing"];
  if (type === "distance") return ["id", "type", "x1", "y1", "x2", "y2"];
  if (type === "noise") return ["id", "type", "input", "seed", "frequency"];
  return ["id", "type"];
}

function strings(...values: unknown[]): string[] { return values.filter((value): value is string => typeof value === "string"); }
function issue(path: string, code: string, message: string): MotionProceduralIssue { return graphIssue(path, code, message); }
