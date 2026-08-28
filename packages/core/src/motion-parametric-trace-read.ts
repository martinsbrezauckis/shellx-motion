import { canonicalJson } from "./canonical-json";
import { snapshotMotionParametricTraceData } from "./motion-parametric-trace-snapshot";
import {
  MAX_MOTION_PARAMETRIC_TRACE_AGGREGATE_SAMPLES,
  MAX_MOTION_PARAMETRIC_TRACE_BYTES,
  MAX_MOTION_PARAMETRIC_TRACE_COLLISIONS,
  MAX_MOTION_PARAMETRIC_TRACE_COORDINATE,
  MAX_MOTION_PARAMETRIC_TRACE_DRAWERS,
  MAX_MOTION_PARAMETRIC_TRACE_DURATION_US,
  MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES,
  MAX_MOTION_PARAMETRIC_TRACE_NODES,
  MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES,
  MAX_MOTION_PARAMETRIC_TRACE_SPEED,
  MAX_MOTION_PARAMETRIC_TRACE_VERTICES,
  MAX_MOTION_PARAMETRIC_TRACE_WORK_UNITS,
  MOTION_PARAMETRIC_TRACE_SCHEMA,
  type MotionParametricTraceCollision,
  type MotionParametricTraceDescriptor,
  type MotionParametricTraceDriver,
  type MotionParametricTraceGraph,
  type MotionParametricTraceGraphNode,
  type MotionParametricTraceLimit,
  type MotionParametricTraceOutput,
  type MotionParametricTracePathFollowDriver,
  type MotionParametricTraceRetention,
  type MotionParametricTraceSignal,
  type MotionParametricTraceVector,
} from "./motion-parametric-trace-types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export { snapshotMotionParametricTraceData } from "./motion-parametric-trace-snapshot";

/** Reads only the private C4C descriptor; it neither owns nor mutates a Motion document. */
export function readMotionParametricTraceDescriptor(value: unknown): MotionParametricTraceDescriptor {
  const record = exactRecord(snapshotMotionParametricTraceData(value), ["schema", "clip", "drawers", "caps"], [], "Parametric trace");
  if (record.schema !== MOTION_PARAMETRIC_TRACE_SCHEMA) throw new Error(`Parametric trace schema must equal ${MOTION_PARAMETRIC_TRACE_SCHEMA}.`);
  const clip = readClip(record.clip);
  const drawers = exactArray(record.drawers, "Parametric trace drawers", MAX_MOTION_PARAMETRIC_TRACE_DRAWERS).map((item, index) => readDrawer(item, index));
  if (!drawers.length) throw new Error("Parametric trace requires at least one drawer.");
  for (let index = 1; index < drawers.length; index += 1) if (drawers[index - 1]!.id >= drawers[index]!.id) throw new Error("Parametric trace drawer ids must be strictly UTF-16 ascending.");
  const capsRecord = exactRecord(record.caps, ["perDrawer", "aggregate"], [], "Parametric trace caps");
  const caps = { perDrawer: readLimit(capsRecord.perDrawer, "perDrawer", MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES), aggregate: readLimit(capsRecord.aggregate, "aggregate", MAX_MOTION_PARAMETRIC_TRACE_AGGREGATE_SAMPLES) };
  if (Buffer.byteLength(canonicalJson({ schema: MOTION_PARAMETRIC_TRACE_SCHEMA, clip, drawers, caps }), "utf8") > MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES) {
    throw new Error(`Parametric trace exceeds the ${MAX_MOTION_PARAMETRIC_TRACE_INPUT_BYTES}-byte input limit.`);
  }
  return { schema: MOTION_PARAMETRIC_TRACE_SCHEMA, clip, drawers, caps };
}

function readClip(value: unknown): MotionParametricTraceDescriptor["clip"] {
  const record = exactRecord(value, ["durationUs", "sampleIntervalUs"], [], "Parametric trace clip");
  const durationUs = positiveUs(record.durationUs, "Parametric trace clip.durationUs", MAX_MOTION_PARAMETRIC_TRACE_DURATION_US);
  const sampleIntervalUs = positiveUs(record.sampleIntervalUs, "Parametric trace clip.sampleIntervalUs", durationUs);
  const samples = Math.floor(durationUs / sampleIntervalUs) + 1 + (durationUs % sampleIntervalUs === 0 ? 0 : 1);
  if (samples > MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES) throw new Error(`Parametric trace clip exceeds ${MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES} schedule samples.`);
  return { durationUs, sampleIntervalUs };
}

function readDrawer(value: unknown, index: number): MotionParametricTraceDescriptor["drawers"][number] {
  const label = `Parametric trace drawers[${index}]`;
  const record = exactRecord(value, ["id", "driver", "retention", "output"], [], label);
  if (typeof record.id !== "string" || !SAFE_ID.test(record.id)) throw new Error(`${label}.id must be a stable safe id.`);
  const retention = readRetention(record.retention, `${label}.retention`), output = readOutput(record.output, `${label}.output`);
  if (retention.kind === "age-fade" && (output.opacity.source !== "age" || output.opacity.from <= output.opacity.to)) {
    throw new Error(`${label} age-fade requires a strictly decreasing age-driven opacity signal.`);
  }
  return { id: record.id, driver: readDriver(record.driver, `${label}.driver`), retention, output };
}

function readDriver(value: unknown, label: string): MotionParametricTraceDriver {
  const record = dataRecord(value, label);
  if (record.kind === "parametric-graph") return { kind: "parametric-graph", graph: readGraph(exactRecord(record, ["kind", "graph"], [], label).graph, `${label}.graph`) };
  if (record.kind === "path-follow") {
    const item = exactRecord(record, ["kind", "startUs", "durationUs", "geometry"], ["offsetUs", "direction", "orientToPath", "easing"], label);
    const startUs = safeUs(item.startUs, `${label}.startUs`), durationUs = positiveUs(item.durationUs, `${label}.durationUs`, MAX_MOTION_PARAMETRIC_TRACE_DURATION_US);
    const offsetUs = Object.hasOwn(item, "offsetUs") ? safeUs(item.offsetUs, `${label}.offsetUs`) : undefined;
    const direction = Object.hasOwn(item, "direction") ? item.direction : undefined;
    if (direction !== undefined && direction !== "forward" && direction !== "reverse") throw new Error(`${label}.direction must be forward or reverse.`);
    const orientToPath = Object.hasOwn(item, "orientToPath") ? item.orientToPath : undefined;
    if (orientToPath !== undefined && typeof orientToPath !== "boolean") throw new Error(`${label}.orientToPath must be boolean.`);
    return {
      kind: "path-follow",
      startUs,
      durationUs,
      geometry: item.geometry as MotionParametricTracePathFollowDriver["geometry"],
      ...(offsetUs === undefined ? {} : { offsetUs }),
      ...(direction === undefined ? {} : { direction }),
      ...(orientToPath === undefined ? {} : { orientToPath }),
      ...(Object.hasOwn(item, "easing") ? { easing: item.easing as MotionParametricTracePathFollowDriver["easing"] } : {}),
    };
  }
  if (record.kind === "behavior" || record.kind === "relation") {
    const item = exactRecord(record, ["kind", "targetLayerId"], [], label);
    if (typeof item.targetLayerId !== "string" || !SAFE_ID.test(item.targetLayerId)) throw new Error(`${label}.targetLayerId must be a stable safe id.`);
    return record.kind === "behavior"
      ? { kind: "behavior", targetLayerId: item.targetLayerId }
      : { kind: "relation", targetLayerId: item.targetLayerId };
  }
  if (record.kind === "bounded-bounce") {
    const item = exactRecord(record, ["kind", "initial", "velocity", "collision", "maxCollisions"], [], label);
    return { kind: "bounded-bounce", initial: readVector(item.initial, `${label}.initial`), velocity: readVelocity(item.velocity, `${label}.velocity`), collision: readCollision(item.collision, `${label}.collision`), maxCollisions: integer(item.maxCollisions, `${label}.maxCollisions`, 0, MAX_MOTION_PARAMETRIC_TRACE_COLLISIONS) };
  }
  throw new Error(`${label}.kind must be parametric-graph, path-follow, behavior, relation, or bounded-bounce.`);
}

function readGraph(value: unknown, label: string): MotionParametricTraceGraph {
  const record = exactRecord(value, ["nodes", "output"], [], label);
  const nodes = exactArray(record.nodes, `${label}.nodes`, MAX_MOTION_PARAMETRIC_TRACE_NODES).map((item, index) => readNode(item, `${label}.nodes[${index}]`));
  if (!nodes.length) throw new Error(`${label}.nodes must not be empty.`);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!SAFE_ID.test(node.id) || ids.has(node.id)) throw new Error(`${label}.nodes must have unique stable ids.`);
    const inputs = node.kind === "add" || node.kind === "multiply" ? [node.left, node.right] : node.kind === "sin" || node.kind === "cos" ? [node.input] : node.kind === "clamp" ? [node.input, node.min, node.max] : node.kind === "lissajous-axis-q1024" ? [node.time] : [];
    if (inputs.some((input) => !ids.has(input))) throw new Error(`${label}.nodes must be topologically ordered without cycles.`);
    ids.add(node.id);
  }
  const output = exactRecord(record.output, ["x", "y", "z"], [], `${label}.output`);
  if ([output.x, output.y, output.z].some((id) => typeof id !== "string" || !ids.has(id))) throw new Error(`${label}.output must reference graph nodes.`);
  return { nodes, output: { x: output.x as string, y: output.y as string, z: output.z as string } };
}

function readNode(value: unknown, label: string): MotionParametricTraceGraphNode {
  const record = dataRecord(value, label);
  if (record.kind === "time-us") return readGraphRecord(record, ["id", "kind"], label) as MotionParametricTraceGraphNode;
  if (record.kind === "constant") { const item = readGraphRecord(record, ["id", "kind", "value"], label); return { id: id(item.id, `${label}.id`), kind: "constant", value: bounded(item.value, `${label}.value`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) }; }
  if (record.kind === "add" || record.kind === "multiply") { const item = readGraphRecord(record, ["id", "kind", "left", "right"], label); return { id: id(item.id, `${label}.id`), kind: record.kind, left: id(item.left, `${label}.left`), right: id(item.right, `${label}.right`) }; }
  if (record.kind === "sin" || record.kind === "cos") { const item = readGraphRecord(record, ["id", "kind", "input"], label); return { id: id(item.id, `${label}.id`), kind: record.kind, input: id(item.input, `${label}.input`) }; }
  if (record.kind === "clamp") { const item = readGraphRecord(record, ["id", "kind", "input", "min", "max"], label); return { id: id(item.id, `${label}.id`), kind: "clamp", input: id(item.input, `${label}.input`), min: id(item.min, `${label}.min`), max: id(item.max, `${label}.max`) }; }
  if (record.kind === "lissajous-axis-q1024") {
    const item = readGraphRecord(record, ["id", "kind", "time", "durationUs", "frequency", "phaseTurnsQ1024", "center", "amplitude"], label);
    const center = canonicalZero(bounded(item.center, `${label}.center`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE));
    const amplitude = bounded(item.amplitude, `${label}.amplitude`, Number.MIN_VALUE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE);
    if (Math.abs(center) + amplitude > MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) throw new Error(`${label} center plus amplitude exceeds the coordinate limit.`);
    return { id: id(item.id, `${label}.id`), kind: "lissajous-axis-q1024", time: id(item.time, `${label}.time`), durationUs: positiveUs(item.durationUs, `${label}.durationUs`, MAX_MOTION_PARAMETRIC_TRACE_DURATION_US), frequency: integer(item.frequency, `${label}.frequency`, 1, 16), phaseTurnsQ1024: canonicalZero(integer(item.phaseTurnsQ1024, `${label}.phaseTurnsQ1024`, 0, 1_023)), center, amplitude };
  }
  throw new Error(`${label}.kind is not an admitted parametric node.`);
}

function readRetention(value: unknown, label: string): MotionParametricTraceRetention {
  const record = dataRecord(value, label);
  if (record.kind === "full-clip") return { kind: "full-clip", maxSamples: integer(exactRecord(record, ["kind", "maxSamples"], [], label).maxSamples, `${label}.maxSamples`, 2, MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES) };
  if (record.kind === "last-samples") return { kind: "last-samples", samples: integer(exactRecord(record, ["kind", "samples"], [], label).samples, `${label}.samples`, 1, MAX_MOTION_PARAMETRIC_TRACE_SCHEDULE_SAMPLES) };
  if (record.kind === "last-us" || record.kind === "age-fade") { const item = exactRecord(record, ["kind", "durationUs"], [], label); return { kind: record.kind, durationUs: positiveUs(item.durationUs, `${label}.durationUs`, MAX_MOTION_PARAMETRIC_TRACE_DURATION_US) }; }
  if (record.kind === "distance") return { kind: "distance", distance: bounded(exactRecord(record, ["kind", "distance"], [], label).distance, `${label}.distance`, Number.MIN_VALUE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) };
  throw new Error(`${label}.kind is not an admitted retention mode.`);
}

function readOutput(value: unknown, label: string): MotionParametricTraceOutput {
  const record = exactRecord(value, ["mode", "width", "colour", "opacity", "speedLimit"], [], label);
  if (record.mode !== "line" && record.mode !== "ribbon" && record.mode !== "tube" && record.mode !== "points") throw new Error(`${label}.mode must be line, ribbon, tube, or points.`);
  const width = readSignal(record.width, `${label}.width`), colour = readSignal(record.colour, `${label}.colour`), opacity = readSignal(record.opacity, `${label}.opacity`);
  signalRange(width, `${label}.width`, 0, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE);
  signalRange(colour, `${label}.colour`, 0, 1);
  signalRange(opacity, `${label}.opacity`, 0, 1);
  return { mode: record.mode, width, colour, opacity, speedLimit: bounded(record.speedLimit, `${label}.speedLimit`, Number.MIN_VALUE, MAX_MOTION_PARAMETRIC_TRACE_SPEED) };
}

function readSignal(value: unknown, label: string): MotionParametricTraceSignal {
  const record = exactRecord(value, ["source", "from", "to"], [], label);
  if (record.source !== "constant" && record.source !== "age" && record.source !== "speed" && record.source !== "drawer") throw new Error(`${label}.source is not an admitted bounded signal.`);
  const signal = { source: record.source, from: bounded(record.from, `${label}.from`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE), to: bounded(record.to, `${label}.to`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) } as MotionParametricTraceSignal;
  if (signal.source === "constant" && signal.from !== signal.to) throw new Error(`${label}.constant requires identical from and to values.`);
  return signal;
}

function readCollision(value: unknown, label: string): MotionParametricTraceCollision {
  const record = dataRecord(value, label);
  if (record.kind === "box") { const item = exactRecord(record, ["kind", "min", "max"], [], label), min = readVector(item.min, `${label}.min`), max = readVector(item.max, `${label}.max`); if (min.x >= max.x || min.y >= max.y || min.z >= max.z) throw new Error(`${label} box min must be strictly below max.`); return { kind: "box", min, max }; }
  if (record.kind === "sphere") { const item = exactRecord(record, ["kind", "center", "radius"], [], label); return { kind: "sphere", center: readVector(item.center, `${label}.center`), radius: bounded(item.radius, `${label}.radius`, Number.MIN_VALUE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) }; }
  if (record.kind === "plane") { const item = exactRecord(record, ["kind", "normal", "offset"], [], label), normal = readVector(item.normal, `${label}.normal`); if (length(normal) === 0) throw new Error(`${label}.normal must not be zero.`); return { kind: "plane", normal, offset: bounded(item.offset, `${label}.offset`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) }; }
  throw new Error(`${label}.kind must be box, sphere, or plane.`);
}

function readVector(value: unknown, label: string): MotionParametricTraceVector { const record = exactRecord(value, ["x", "y", "z"], [], label); return { x: bounded(record.x, `${label}.x`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE), y: bounded(record.y, `${label}.y`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE), z: bounded(record.z, `${label}.z`, -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) }; }
function readVelocity(value: unknown, label: string): MotionParametricTraceVector { const record = exactRecord(value, ["x", "y", "z"], [], label); return { x: bounded(record.x, `${label}.x`, -MAX_MOTION_PARAMETRIC_TRACE_SPEED, MAX_MOTION_PARAMETRIC_TRACE_SPEED), y: bounded(record.y, `${label}.y`, -MAX_MOTION_PARAMETRIC_TRACE_SPEED, MAX_MOTION_PARAMETRIC_TRACE_SPEED), z: bounded(record.z, `${label}.z`, -MAX_MOTION_PARAMETRIC_TRACE_SPEED, MAX_MOTION_PARAMETRIC_TRACE_SPEED) }; }
function readLimit(value: unknown, label: string, sampleMaximum: number): MotionParametricTraceLimit { const record = exactRecord(value, ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"], [], `Parametric trace caps.${label}`); return { maxSamples: integer(record.maxSamples, `${label}.maxSamples`, 2, sampleMaximum), maxVertices: integer(record.maxVertices, `${label}.maxVertices`, 2, MAX_MOTION_PARAMETRIC_TRACE_VERTICES), maxWorkUnits: integer(record.maxWorkUnits, `${label}.maxWorkUnits`, 1, MAX_MOTION_PARAMETRIC_TRACE_WORK_UNITS), maxBytes: integer(record.maxBytes, `${label}.maxBytes`, 1, MAX_MOTION_PARAMETRIC_TRACE_BYTES) }; }
function readGraphRecord(value: Record<string, unknown>, required: readonly string[], label: string): Record<string, unknown> { return exactRecord(value, required, [], label); }
function dataRecord(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> { const record = dataRecord(value, label), allowed = [...required, ...optional]; const unknown = Object.keys(record).find((key) => !allowed.includes(key)); if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`); for (const key of required) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`); return record; }
function exactArray(value: unknown, label: string, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a dense array with at most ${maximum} entries.`); return value; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a stable safe id.`); return value; }
function safeUs(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`); return value; }
function positiveUs(value: unknown, label: string, maximum: number): number { const result = safeUs(value, label); if (result === 0 || result > maximum) throw new Error(`${label} must be in 1..${maximum}.`); return result; }
function integer(value: unknown, label: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in ${min}..${max}.`); return value; }
function bounded(value: unknown, label: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be finite and in ${min}..${max}.`); return value; }
function canonicalZero(value: number): number { return Object.is(value, -0) ? 0 : value; }
function signalRange(signal: MotionParametricTraceSignal, label: string, min: number, max: number): void { if (signal.from < min || signal.from > max || signal.to < min || signal.to > max) throw new Error(`${label} must remain in the closed ${min}..${max} signal domain.`); }
function length(value: MotionParametricTraceVector): number { return Math.hypot(value.x, value.y, value.z); }
