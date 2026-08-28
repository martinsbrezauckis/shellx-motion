import { MAX_MOTION_PARAMETRIC_TRACE_DRAWERS, MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES, MAX_MOTION_PARAMETRIC_TRACE_NODES } from "./motion-parametric-trace-types";

const MAX_DEPTH = 8;
const MAX_TOTAL_NODES = 1_536;
const MAX_TOTAL_KEYS = 2_048;

interface State { active: WeakSet<object>; nodes: number; keys: number; bytes: number }
interface RecordScan { value: object; keys: readonly PropertyKey[]; label: string }

/**
 * Shape-aware snapshot for the private C4C descriptor. Every collection cap is checked before
 * its ownKeys/element reflection, and every branch checks exact keys before reading non-kind data.
 */
export function snapshotMotionParametricTraceData(value: unknown): unknown {
  const state: State = { active: new WeakSet<object>(), nodes: 0, keys: 0, bytes: 0 };
  return trace(value, state, 0);
}

function trace(value: unknown, state: State, depth: number): Record<string, unknown> {
  const record = exact(value, state, depth, "Parametric trace", ["schema", "clip", "drawers", "caps"]);
  return object({ schema: scalar(field(record, "schema", state), state), clip: clip(field(record, "clip", state), state, depth + 1), drawers: array(field(record, "drawers", state), state, depth + 1, "Parametric trace drawers", MAX_MOTION_PARAMETRIC_TRACE_DRAWERS, drawer), caps: caps(field(record, "caps", state), state, depth + 1) });
}

function clip(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace clip", ["durationUs", "sampleIntervalUs"]); return object({ durationUs: scalar(field(record, "durationUs", state), state), sampleIntervalUs: scalar(field(record, "sampleIntervalUs", state), state) }); }
function caps(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace caps", ["perDrawer", "aggregate"]); return object({ perDrawer: limit(field(record, "perDrawer", state), state, depth + 1, "perDrawer"), aggregate: limit(field(record, "aggregate", state), state, depth + 1, "aggregate") }); }
function limit(value: unknown, state: State, depth: number, label: string): Record<string, unknown> { const record = exact(value, state, depth, `Parametric trace caps.${label}`, ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"]); return object({ maxSamples: scalar(field(record, "maxSamples", state), state), maxVertices: scalar(field(record, "maxVertices", state), state), maxWorkUnits: scalar(field(record, "maxWorkUnits", state), state), maxBytes: scalar(field(record, "maxBytes", state), state) }); }

function drawer(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace drawer", ["id", "driver", "retention", "output"]); return object({ id: scalar(field(record, "id", state), state), driver: driver(field(record, "driver", state), state, depth + 1), retention: retention(field(record, "retention", state), state, depth + 1), output: output(field(record, "output", state), state, depth + 1) }); }

function driver(value: unknown, state: State, depth: number): Record<string, unknown> {
  const scan = record(value, state, depth, "Parametric trace driver", 8), kind = kindOf(scan, state);
  if (kind === "parametric-graph") { exactScan(scan, ["kind", "graph"]); return object({ kind, graph: graph(field(scan, "graph", state), state, depth + 1) }); }
  if (kind === "path-follow") { exactScan(scan, ["kind", "startUs", "durationUs", "geometry"], ["offsetUs", "direction", "orientToPath", "easing"]); return object({ kind, startUs: scalar(field(scan, "startUs", state), state), durationUs: scalar(field(scan, "durationUs", state), state), geometry: pathGeometry(field(scan, "geometry", state), state, depth + 1), ...optionalScalar(scan, "offsetUs", state), ...optionalScalar(scan, "direction", state), ...optionalScalar(scan, "orientToPath", state), ...optionalEasing(scan, state, depth) }); }
  if (kind === "behavior" || kind === "relation") { exactScan(scan, ["kind", "targetLayerId"]); return object({ kind, targetLayerId: scalar(field(scan, "targetLayerId", state), state) }); }
  if (kind === "bounded-bounce") { exactScan(scan, ["kind", "initial", "velocity", "collision", "maxCollisions"]); return object({ kind, initial: vector(field(scan, "initial", state), state, depth + 1, "initial"), velocity: vector(field(scan, "velocity", state), state, depth + 1, "velocity"), collision: collision(field(scan, "collision", state), state, depth + 1), maxCollisions: scalar(field(scan, "maxCollisions", state), state) }); }
  throw new Error("Parametric trace driver.kind is not admitted.");
}

function graph(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace graph", ["nodes", "output"]); return object({ nodes: array(field(record, "nodes", state), state, depth + 1, "Parametric trace graph nodes", MAX_MOTION_PARAMETRIC_TRACE_NODES, node), output: graphOutput(field(record, "output", state), state, depth + 1) }); }
function graphOutput(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace graph output", ["x", "y", "z"]); return object({ x: scalar(field(record, "x", state), state), y: scalar(field(record, "y", state), state), z: scalar(field(record, "z", state), state) }); }
function pathGeometry(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace path-follow geometry", ["schema", "kind", "viewBox", "data"]); return object({ schema: scalar(field(record, "schema", state), state), kind: scalar(field(record, "kind", state), state), viewBox: viewBox(field(record, "viewBox", state), state, depth + 1), data: scalar(field(record, "data", state), state) }); }
function viewBox(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace path-follow geometry viewBox", ["x", "y", "width", "height"]); return object({ x: scalar(field(record, "x", state), state), y: scalar(field(record, "y", state), state), width: scalar(field(record, "width", state), state), height: scalar(field(record, "height", state), state) }); }
function easing(value: unknown, state: State, depth: number): unknown {
  if (typeof value === "string") return scalar(value, state);
  const scan = record(value, state, depth, "Parametric trace path-follow easing", 5), type = typeOf(scan, state);
  if (type !== "spring") throw new Error("Parametric trace path-follow easing.type is not admitted.");
  exactScan(scan, ["type", "stiffness", "damping"], ["mass", "initialVelocity"]);
  return object({ type, stiffness: scalar(field(scan, "stiffness", state), state), damping: scalar(field(scan, "damping", state), state), ...optionalScalar(scan, "mass", state), ...optionalScalar(scan, "initialVelocity", state) });
}
function node(value: unknown, state: State, depth: number): Record<string, unknown> {
  const scan = record(value, state, depth, "Parametric trace graph node", 8), kind = kindOf(scan, state);
  if (kind === "time-us") { exactScan(scan, ["id", "kind"]); return object({ id: scalar(field(scan, "id", state), state), kind }); }
  if (kind === "constant") { exactScan(scan, ["id", "kind", "value"]); return object({ id: scalar(field(scan, "id", state), state), kind, value: scalar(field(scan, "value", state), state) }); }
  if (kind === "add" || kind === "multiply") { exactScan(scan, ["id", "kind", "left", "right"]); return object({ id: scalar(field(scan, "id", state), state), kind, left: scalar(field(scan, "left", state), state), right: scalar(field(scan, "right", state), state) }); }
  if (kind === "sin" || kind === "cos") { exactScan(scan, ["id", "kind", "input"]); return object({ id: scalar(field(scan, "id", state), state), kind, input: scalar(field(scan, "input", state), state) }); }
  if (kind === "clamp") { exactScan(scan, ["id", "kind", "input", "min", "max"]); return object({ id: scalar(field(scan, "id", state), state), kind, input: scalar(field(scan, "input", state), state), min: scalar(field(scan, "min", state), state), max: scalar(field(scan, "max", state), state) }); }
  if (kind === "lissajous-axis-q1024") { exactScan(scan, ["id", "kind", "time", "durationUs", "frequency", "phaseTurnsQ1024", "center", "amplitude"]); return object({ id: scalar(field(scan, "id", state), state), kind, time: scalar(field(scan, "time", state), state), durationUs: scalar(field(scan, "durationUs", state), state), frequency: scalar(field(scan, "frequency", state), state), phaseTurnsQ1024: scalar(field(scan, "phaseTurnsQ1024", state), state), center: scalar(field(scan, "center", state), state), amplitude: scalar(field(scan, "amplitude", state), state) }); }
  throw new Error("Parametric trace graph node.kind is not admitted.");
}

function retention(value: unknown, state: State, depth: number): Record<string, unknown> {
  const scan = record(value, state, depth, "Parametric trace retention", 2), kind = kindOf(scan, state);
  if (kind === "full-clip") { exactScan(scan, ["kind", "maxSamples"]); return object({ kind, maxSamples: scalar(field(scan, "maxSamples", state), state) }); }
  if (kind === "last-samples") { exactScan(scan, ["kind", "samples"]); return object({ kind, samples: scalar(field(scan, "samples", state), state) }); }
  if (kind === "last-us" || kind === "age-fade") { exactScan(scan, ["kind", "durationUs"]); return object({ kind, durationUs: scalar(field(scan, "durationUs", state), state) }); }
  if (kind === "distance") { exactScan(scan, ["kind", "distance"]); return object({ kind, distance: scalar(field(scan, "distance", state), state) }); }
  throw new Error("Parametric trace retention.kind is not admitted.");
}

function output(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace output", ["mode", "width", "colour", "opacity", "speedLimit"]); return object({ mode: scalar(field(record, "mode", state), state), width: signal(field(record, "width", state), state, depth + 1), colour: signal(field(record, "colour", state), state, depth + 1), opacity: signal(field(record, "opacity", state), state, depth + 1), speedLimit: scalar(field(record, "speedLimit", state), state) }); }
function signal(value: unknown, state: State, depth: number): Record<string, unknown> { const record = exact(value, state, depth, "Parametric trace signal", ["source", "from", "to"]); return object({ source: scalar(field(record, "source", state), state), from: scalar(field(record, "from", state), state), to: scalar(field(record, "to", state), state) }); }
function collision(value: unknown, state: State, depth: number): Record<string, unknown> {
  const scan = record(value, state, depth, "Parametric trace collision", 3), kind = kindOf(scan, state);
  if (kind === "box") { exactScan(scan, ["kind", "min", "max"]); return object({ kind, min: vector(field(scan, "min", state), state, depth + 1, "box min"), max: vector(field(scan, "max", state), state, depth + 1, "box max") }); }
  if (kind === "sphere") { exactScan(scan, ["kind", "center", "radius"]); return object({ kind, center: vector(field(scan, "center", state), state, depth + 1, "sphere center"), radius: scalar(field(scan, "radius", state), state) }); }
  if (kind === "plane") { exactScan(scan, ["kind", "normal", "offset"]); return object({ kind, normal: vector(field(scan, "normal", state), state, depth + 1, "plane normal"), offset: scalar(field(scan, "offset", state), state) }); }
  throw new Error("Parametric trace collision.kind is not admitted.");
}
function vector(value: unknown, state: State, depth: number, label: string): Record<string, unknown> { const record = exact(value, state, depth, `Parametric trace ${label}`, ["x", "y", "z"]); return object({ x: scalar(field(record, "x", state), state), y: scalar(field(record, "y", state), state), z: scalar(field(record, "z", state), state) }); }

function optionalScalar(scan: RecordScan, key: string, state: State): Record<string, unknown> { return scan.keys.includes(key) ? { [key]: scalar(field(scan, key, state), state) } : {}; }
function optionalEasing(scan: RecordScan, state: State, depth: number): Record<string, unknown> { return scan.keys.includes("easing") ? { easing: easing(field(scan, "easing", state), state, depth + 1) } : {}; }

function scalar(value: unknown, state: State): unknown { if (value === null) return charge(state, 4), null; if (typeof value === "boolean") return charge(state, value ? 4 : 5), value; if (typeof value === "number") return charge(state, 32), value; if (typeof value === "string") return charge(state, Buffer.byteLength(value, "utf8") + 2), value; throw new Error("Parametric trace must contain only JSON data."); }
function array(value: unknown, state: State, depth: number, label: string, maximum: number, item: (value: unknown, state: State, depth: number) => unknown): unknown[] {
  if (depth > MAX_DEPTH) throw new Error("Parametric trace exceeds its nesting limit.");
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const length = descriptor(value, "length", label), count = "value" in length ? length.value : undefined;
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) throw new Error(`${label} must contain at most ${maximum} dense entries.`);
  charge(state, 2 + Math.max(0, count - 1)); const scan = scanArray(value, state, label, count), result: unknown[] = [];
  for (let index = 0; index < count; index += 1) { const key = String(index); if (!scan.includes(key)) throw new Error(`${label} must contain no holes.`); result.push(item(field({ value, keys: scan, label }, key, state), state, depth + 1)); }
  return result;
}
function exact(value: unknown, state: State, depth: number, label: string, required: readonly string[], optional: readonly string[] = []): RecordScan { const scan = record(value, state, depth, label, Math.max(required.length + optional.length, 1)); exactScan(scan, required, optional); return scan; }
function record(value: unknown, state: State, depth: number, label: string, maximum: number): RecordScan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`); if (depth > MAX_DEPTH) throw new Error("Parametric trace exceeds its nesting limit."); if (state.active.has(value)) throw new Error("Parametric trace must not contain cycles."); if (state.nodes >= MAX_TOTAL_NODES) throw new Error(`Parametric trace exceeds the ${MAX_TOTAL_NODES}-node limit.`);
  let prototype: object | null, keys: readonly PropertyKey[]; try { prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) throw new Error("prototype"); keys = Reflect.ownKeys(value); } catch { throw new Error("Parametric trace data reflection failed."); }
  if (keys.length > maximum || state.keys + keys.length > MAX_TOTAL_KEYS || keys.some((key) => typeof key !== "string")) throw new Error(`${label} field limit exceeded.`);
  state.active.add(value); state.nodes += 1; state.keys += keys.length; charge(state, 2 + keys.reduce<number>((total, key) => total + Buffer.byteLength(String(key), "utf8") + 3, 0)); return { value, keys, label };
}
function exactScan(scan: RecordScan, required: readonly string[], optional: readonly string[] = []): void { const allowed = new Set([...required, ...optional]); if (scan.keys.some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error(`${scan.label} has an unknown field.`); if (required.some((key) => !scan.keys.includes(key))) throw new Error(`${scan.label} is missing a required field.`); }
function kindOf(scan: RecordScan, state: State): string { const value = field(scan, "kind", state); if (typeof value !== "string") throw new Error(`${scan.label}.kind must be a string.`); return value; }
function typeOf(scan: RecordScan, state: State): string { const value = field(scan, "type", state); if (typeof value !== "string") throw new Error(`${scan.label}.type must be a string.`); return value; }
function field(scan: RecordScan, key: PropertyKey, state: State): unknown { if (!scan.keys.includes(key)) throw new Error(`${scan.label} requires ${String(key)}.`); const value = descriptor(scan.value, key, scan.label); if (!("value" in value) || !value.enumerable) throw new Error(`${scan.label}.${String(key)} must be an enumerable data field.`); charge(state, 1); return value.value; }
function scanArray(value: object, state: State, label: string, length: number): readonly PropertyKey[] { let keys: readonly PropertyKey[]; try { keys = Reflect.ownKeys(value); } catch { throw new Error("Parametric trace data reflection failed."); } if (keys.length !== length + 1 || !keys.includes("length") || state.keys + keys.length > MAX_TOTAL_KEYS) throw new Error(`${label} must be dense with no extension fields.`); state.keys += keys.length; return keys; }
function descriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor { try { const result = Object.getOwnPropertyDescriptor(value, key); if (!result) throw new Error("missing"); return result; } catch { throw new Error(`${label} reflection failed.`); } }
function charge(state: State, bytes: number): void { state.bytes += bytes; if (state.bytes > MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES) throw new Error(`Parametric trace exceeds the ${MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES}-byte input limit.`); }
function object<T extends Record<string, unknown>>(value: T): T { return value; }
