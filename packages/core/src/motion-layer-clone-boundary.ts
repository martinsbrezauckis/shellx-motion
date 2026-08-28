import { buildLayerDefinitions } from "./motion-public-schema-layers";
import { renderableLayerTypes } from "./capabilities";
import { parseMotionPathViewBox, validateMotionPathData } from "./path-contract";
import type { MotionLayer } from "./types";

type JsonSchema = Record<string, unknown>;
const RENDERABLE_LAYER_TYPES = new Set(renderableLayerTypes());

/**
 * Clone/split cannot retain opaque open-schema data: an extension could name a
 * layer id that the operation cannot rebind. This walks the published Core
 * shapes recursively, treating omitted additional-properties as refused here.
 */
export function findUnknownMotionLayerFieldPath(layer: MotionLayer, allowedPaths: ReadonlySet<string>): string | null {
  const definitions = buildLayerDefinitions();
  const layerSchema = withLayerSupplements(asSchema(definitions.layer));
  if (!layerSchema) throw new Error("Motion layer schema is unavailable.");
  return findUnknownPath(layer, [layerSchema], "", definitions, allowedPaths);
}

/** Shared fail-closed boundary for any structural operation that duplicates layer data. */
export function assertMotionLayerCloneBoundary(layer: MotionLayer, operation: string): void {
  assertMotionLayerConditionalShape(layer, operation);
  const extensionPath = findUnknownMotionLayerFieldPath(layer, validatedLegacyPathExtensions(layer, operation));
  if (extensionPath) throw new Error(`Cannot ${operation} layer ${layer.id}: extension field ${extensionPath} may contain a layer reference that cannot be rebound safely.`);
}

/**
 * The public layer schema carries a few property/type implications in `allOf`.
 * Structural operations must not regard a recognized property as safe when the
 * discriminator makes that property invalid: the host may otherwise give it
 * private layer-reference semantics that this operation cannot preserve.
 */
function assertMotionLayerConditionalShape(layer: MotionLayer, operation: string): void {
  const source = layer as unknown as Record<string, unknown>;
  const requiredByType: ReadonlyArray<readonly [string, string]> = [
    ["particles", "emitter"],
    ["points", "pointCloud"],
    ["shader", "shader"],
    ["scene3d", "scene3d"],
    ["environment", "environment"],
    ["group", "childLayerIds"]
  ];
  for (const [type, property] of requiredByType) {
    if (layer.type === type && !Object.hasOwn(source, property)) {
      throw new Error(`Cannot ${operation} layer ${layer.id}: ${type} layers require ${property}.`);
    }
  }
  const typesByProperty: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["crop", ["image", "video"]],
    ["textFit", ["text", "caption"]],
    ["gradient", ["shape"]],
    ["geometry", ["shape"]],
    ["pathReveal", ["shape"]],
    ["emitter", ["particles"]],
    ["pointCloud", ["points"]],
    ["shader", ["shader"]],
    ["scene3d", ["scene3d"]],
    ["environment", ["environment"]],
    ["childLayerIds", ["group"]],
  ];
  for (const [property, types] of typesByProperty) {
    if (Object.hasOwn(source, property) && !types.includes(layer.type)) {
      throw new Error(`Cannot ${operation} layer ${layer.id}: ${property} is only valid for ${types.join(", ")} layers.`);
    }
  }
  if (Object.hasOwn(source, "depth") && !supportsDepth(layer.type)) {
    throw new Error(`Cannot ${operation} layer ${layer.id}: depth is only valid for renderable non-audio, non-group layers.`);
  }
}

/** Depth membership follows the renderer-card universe, excluding non-visual audio and structural groups. */
function supportsDepth(type: string): boolean {
  return type !== "audio" && type !== "group" && RENDERABLE_LAYER_TYPES.has(type);
}

function validatedLegacyPathExtensions(layer: MotionLayer, operation: string): Set<string> {
  const record = layer as unknown as Record<string, unknown>;
  const keys = ["x-path", "x-path-viewBox", "x-path-fillRule"] as const;
  const present = keys.filter((key) => Object.hasOwn(record, key));
  if (present.length === 0) return new Set();
  if (layer.type !== "shape" || (layer.shape !== "path" && layer.shape !== "freeform")) {
    throw new Error(`Cannot ${operation} layer ${layer.id}: legacy path extensions require a shape path or freeform layer.`);
  }
  if (!Object.hasOwn(record, "x-path")) throw new Error(`Cannot ${operation} layer ${layer.id}: legacy path extensions require x-path.`);
  try {
    validateMotionPathData(record["x-path"], `Layer ${layer.id} x-path`);
    if (Object.hasOwn(record, "x-path-viewBox")) parseMotionPathViewBox(record["x-path-viewBox"], `Layer ${layer.id} x-path-viewBox`);
  } catch (error) {
    throw new Error(`Cannot ${operation} layer ${layer.id}: ${error instanceof Error ? error.message : "invalid legacy path extension"}`);
  }
  if (Object.hasOwn(record, "x-path-fillRule") && record["x-path-fillRule"] !== "nonzero" && record["x-path-fillRule"] !== "evenodd") {
    throw new Error(`Cannot ${operation} layer ${layer.id}: x-path-fillRule must be nonzero or evenodd.`);
  }
  return new Set(present.map((key) => `/${key}`));
}

function findUnknownPath(value: unknown, schemas: JsonSchema[], path: string, definitions: Record<string, unknown>, allowedPaths: ReadonlySet<string>): string | null {
  if (Array.isArray(value)) {
    const itemSchemas = expandedSchemas(schemas, definitions).flatMap((schema) => schemaValues(schema.items));
    if (itemSchemas.length === 0) return value.length === 0 ? null : `${path}/0`;
    for (let index = 0; index < value.length; index += 1) {
      const unknownPath = findUnknownPath(value[index], itemSchemas, `${path}/${index}`, definitions, allowedPaths);
      if (unknownPath) return unknownPath;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const propertySchemas = new Map<string, JsonSchema[]>();
  const additionalSchemas: JsonSchema[] = [];
  for (const schema of expandedSchemas(schemas, definitions)) {
    for (const [key, child] of Object.entries(asRecord(schema.properties) ?? {})) {
      const childSchema = asSchema(child);
      if (childSchema) propertySchemas.set(key, [...(propertySchemas.get(key) ?? []), childSchema]);
    }
    additionalSchemas.push(...schemaValues(schema.additionalProperties));
  }
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = `${path}/${key}`;
    if (allowedPaths.has(nextPath)) continue;
    const nestedSchemas = propertySchemas.get(key) ?? additionalSchemas;
    if (nestedSchemas.length === 0) return nextPath;
    const unknownPath = findUnknownPath(nested, nestedSchemas, nextPath, definitions, allowedPaths);
    if (unknownPath) return unknownPath;
  }
  return null;
}

function expandedSchemas(schemas: JsonSchema[], definitions: Record<string, unknown>): JsonSchema[] {
  const result: JsonSchema[] = [];
  const seen = new Set<JsonSchema>();
  const visit = (schema: JsonSchema): void => {
    const resolved = resolveRef(schema, definitions);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    result.push(resolved);
    for (const key of ["allOf", "anyOf", "oneOf", "then", "else"] as const) for (const branch of schemaValues(resolved[key])) visit(branch);
  };
  for (const schema of schemas) visit(schema);
  return result;
}

function resolveRef(schema: JsonSchema, definitions: Record<string, unknown>): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return schema;
  return asSchema(definitions[ref.slice("#/$defs/".length)]) ?? schema;
}

/** These declared Core fields are runtime-validated outside the public-schema leaf. */
function withLayerSupplements(schema: JsonSchema | null): JsonSchema | null {
  if (!schema) return null;
  return {
    ...schema,
    properties: {
      ...(asRecord(schema.properties) ?? {}),
      ducking: DUCKING_SCHEMA,
      keying: KEYING_SCHEMA,
      label: { type: "object", properties: {} },
      style: STYLE_SCHEMA
    }
  };
}

const SCALAR: JsonSchema = {};
const NUMBER_ARRAY: JsonSchema = { type: "array", items: SCALAR };
const DUCKING_SCHEMA: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(["triggerLayerIds", "mode", "duckToVolume", "attackMs", "releaseMs", "threshold", "ratio"].map((key) => [key, key === "triggerLayerIds" ? { type: "array", items: SCALAR } : SCALAR]))
};
const KEYING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schema: SCALAR, keyColor: SCALAR, similarity: SCALAR, smoothness: SCALAR, shadow: SCALAR,
    spillSuppression: SCALAR, spillBalance: SCALAR, edgeColorCorrection: SCALAR,
    matte: { type: "object", properties: Object.fromEntries(["denoiseRadiusPx", "growShrinkPx", "chokePx", "featherPx", "blackClip", "whiteClip"].map((key) => [key, SCALAR])) }
  }
};
const STYLE_SCALAR_FIELDS = [
  "fill", "color", "stroke", "borderColor", "backgroundColor", "background", "strokeWidth", "borderWidth", "fontSize", "fontWeight",
  "letterSpacing", "textAlign", "verticalAlign", "alignY", "lineHeight", "width", "height", "radius", "borderRadius", "padding",
  "paddingX", "paddingY", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"
] as const;
const SHADOW_SCHEMA: JsonSchema = { type: "object", properties: Object.fromEntries(["x", "y", "offsetX", "offsetY", "blur", "spread", "blurRadius", "spreadRadius", "color"].map((key) => [key, SCALAR])) };
const STYLE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ...Object.fromEntries(STYLE_SCALAR_FIELDS.map((key) => [key, SCALAR])),
    strokeDasharray: NUMBER_ARRAY, strokeDashoffset: SCALAR, shadow: SHADOW_SCHEMA, textShadow: SHADOW_SCHEMA
  }
};

function schemaValues(value: unknown): JsonSchema[] {
  if (Array.isArray(value)) return value.flatMap(schemaValues);
  const schema = asSchema(value);
  return schema ? [schema] : [];
}

function asSchema(value: unknown): JsonSchema | null { return isRecord(value) ? value : null; }
function asRecord(value: unknown): Record<string, unknown> | null { return isRecord(value) ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
