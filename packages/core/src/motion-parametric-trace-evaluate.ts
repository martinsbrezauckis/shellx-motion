import { canonicalJsonSha256 } from "./canonical-json";
import { evaluateMotionBehaviorFrame } from "./motion-behavior-evaluate";
import { compileMotionBehaviorStaticPlan } from "./motion-behavior-plan";
import { evaluateMotionPathFollow } from "./motion-path-follow";
import { quantizeMotionProceduralValue } from "./procedural-relationship-evaluate";
import { MAX_PROCEDURAL_TRIG_INPUT_RADIANS } from "./procedural-relationship-types";
import { compileMotionRelationAuthoringFramePlanFromEvaluation, evaluateMotionRelationAuthoringFrame } from "./motion-relation-authoring-frame";
import { compileMotionRelationStaticPlan } from "./motion-relation-plan";
import {
  MAX_MOTION_PARAMETRIC_TRACE_COORDINATE,
  MAX_MOTION_PARAMETRIC_TRACE_DURATION_US,
  type MotionParametricTraceDrawer,
  type MotionParametricTraceGraph,
  type MotionParametricTraceSample,
  type MotionParametricTraceTrigonometry,
  type MotionParametricTraceVector,
} from "./motion-parametric-trace-types";
import type { MotionDocument } from "./types";

const MAX_GRAPH_VALUE = 1_000_000_000_000;
const TWO_PI = Math.PI * 2;

export interface MotionParametricTraceAuthority { motion?: MotionDocument }
export interface MotionParametricTraceDrawerEvaluation {
  samples: MotionParametricTraceSample[];
  sourceSha256: string;
  authorityFingerprint?: string;
  trigonometry: MotionParametricTraceTrigonometry;
  workUnits: number;
  sampleWorkUnits: number[];
}
interface TracePosition { position: MotionParametricTraceVector; workUnits: number }

/** Samples one admitted driver at exact schedule times; this is not a second transform evaluator. */
export function evaluateMotionParametricTraceDrawer(
  drawer: MotionParametricTraceDrawer,
  schedule: readonly number[],
  authority: MotionParametricTraceAuthority,
): MotionParametricTraceDrawerEvaluation {
  const resolved: TracePosition[] = [];
  let sourceSha256 = canonicalJsonSha256(drawer.driver), authorityFingerprint: string | undefined, trigonometry: MotionParametricTraceTrigonometry = "none";
  if (drawer.driver.kind === "behavior") {
    const motion = requireMotion(authority, "behavior");
    const staticPlan = compileMotionBehaviorStaticPlan(motion);
    if (!staticPlan.ok) throw new Error(staticPlan.message);
    authorityFingerprint = staticPlan.plan.fingerprint;
    for (const atUs of schedule) resolved.push(behaviorPosition(motion, drawer.driver.targetLayerId, atUs));
  } else if (drawer.driver.kind === "relation") {
    const motion = requireMotion(authority, "relation");
    const staticPlan = compileMotionRelationStaticPlan(motion);
    if (!staticPlan.ok) throw new Error(staticPlan.message);
    authorityFingerprint = staticPlan.plan.fingerprint;
    for (const atUs of schedule) resolved.push(relationPosition(motion, drawer.driver.targetLayerId, atUs));
  } else if (drawer.driver.kind === "path-follow") {
    for (const atUs of schedule) resolved.push(pathPosition(drawer, atUs));
  } else if (drawer.driver.kind === "parametric-graph") {
    sourceSha256 = canonicalJsonSha256(drawer.driver.graph);
    trigonometry = graphTrigonometry(drawer.driver.graph);
    for (const atUs of schedule) resolved.push(graphPosition(drawer.driver.graph, atUs));
  } else {
    for (const atUs of schedule) resolved.push(bouncePosition(drawer, atUs));
  }
  const positions = resolved.map((item) => item.position);
  return { samples: positions.map((position, index) => ({ atUs: schedule[index]!, position, speed: normalizedSpeed(positions, schedule, index, drawer.output.speedLimit) })), sourceSha256, ...(authorityFingerprint ? { authorityFingerprint } : {}), trigonometry, workUnits: resolved.reduce((total, item) => total + item.workUnits, 0), sampleWorkUnits: resolved.map((item) => item.workUnits) };
}

function graphTrigonometry(graph: MotionParametricTraceGraph): MotionParametricTraceTrigonometry {
  const radians = graph.nodes.some((node) => node.kind === "sin" || node.kind === "cos");
  const modularTurns = graph.nodes.some((node) => node.kind === "lissajous-axis-q1024");
  if (radians && modularTurns) return "mixed-quantized-radians-and-exact-modular-turns@1";
  if (radians) return "quantized-radians@1";
  return modularTurns ? "exact-modular-turns@1" : "none";
}

function requireMotion(authority: MotionParametricTraceAuthority, kind: string): MotionDocument {
  if (!authority.motion) throw new Error(`Parametric trace ${kind} driver requires an existing Motion document authority.`);
  if (!Number.isSafeInteger(authority.motion.durationMs * 1_000) || authority.motion.durationMs * 1_000 > Number.MAX_SAFE_INTEGER) throw new Error("Parametric trace Motion document duration cannot be represented in safe integer microseconds.");
  return authority.motion;
}

function behaviorPosition(motion: MotionDocument, targetLayerId: string, atUs: number): TracePosition {
  if (atUs > motion.durationMs * 1_000) throw new Error("Parametric trace behavior driver exceeds its Motion document duration.");
  const evaluation = evaluateMotionBehaviorFrame(motion, atUs), sample = evaluation.samples.find((item) => item.targetLayerId === targetLayerId);
  if (!sample) throw new Error(`Parametric trace behavior driver ${targetLayerId} has no active exact-time behavior sample.`);
  return { position: vector(sample.transform.x, sample.transform.y, 0, "behavior"), workUnits: evaluation.frameWorkUnits };
}

function relationPosition(motion: MotionDocument, targetLayerId: string, atUs: number): TracePosition {
  if (atUs > motion.durationMs * 1_000) throw new Error("Parametric trace relation driver exceeds its Motion document duration.");
  if (atUs % 1_000 !== 0) throw new Error("Parametric trace relation driver requires whole-millisecond exact samples until the shared all-microsecond transform rail exists.");
  const evaluation = evaluateMotionRelationAuthoringFrame(motion, atUs);
  const bound = evaluation.samples.find((item) => item.targetLayerId === targetLayerId);
  if (!bound) throw new Error(`Parametric trace relation driver ${targetLayerId} has no active exact-time relation sample.`);
  const receipt = compileMotionRelationAuthoringFramePlanFromEvaluation(motion, evaluation);
  if (!receipt.ok) throw new Error(receipt.message);
  const layer = evaluation.layers.find((item) => item.id === targetLayerId);
  if (!layer) throw new Error(`Parametric trace relation driver ${targetLayerId} has no resolved target layer.`);
  return { position: vector(layer.transform?.x ?? 0, layer.transform?.y ?? 0, 0, "relation"), workUnits: evaluation.frameWorkUnits };
}

function pathPosition(drawer: MotionParametricTraceDrawer, atUs: number): TracePosition {
  const driver = drawer.driver;
  if (driver.kind !== "path-follow") throw new Error("Internal path trace driver mismatch.");
  const result = evaluateMotionPathFollow({ schema: "shellx-motion/path-follow@1", atUs, startUs: driver.startUs, durationUs: driver.durationUs, geometry: driver.geometry, ...(driver.offsetUs === undefined ? {} : { offsetUs: driver.offsetUs }), ...(driver.direction === undefined ? {} : { direction: driver.direction }), ...(driver.orientToPath === undefined ? {} : { orientToPath: driver.orientToPath }), ...(driver.easing === undefined ? {} : { easing: driver.easing }) });
  if (!result.ok) throw new Error(`Parametric trace path-follow driver refused: ${result.message}`);
  return { position: vector(result.evaluation.transform.x, result.evaluation.transform.y, 0, "path-follow"), workUnits: result.evaluation.budget.workUnits };
}

function graphPosition(graph: MotionParametricTraceGraph, atUs: number): TracePosition {
  const values = new Map<string, number>();
  for (const node of graph.nodes) {
    let value: number;
    if (node.kind === "time-us") value = atUs;
    else if (node.kind === "constant") value = node.value;
    else if (node.kind === "add") value = need(values, node.left) + need(values, node.right);
    else if (node.kind === "multiply") value = need(values, node.left) * need(values, node.right);
    else if (node.kind === "clamp") { const min = need(values, node.min), max = need(values, node.max); if (min > max) throw new Error(`Parametric trace clamp node ${node.id} has min greater than max.`); value = Math.min(max, Math.max(min, need(values, node.input))); }
    else if (node.kind === "sin" || node.kind === "cos") value = trigonometric(node.kind, need(values, node.input), node.id);
    else if (node.kind === "lissajous-axis-q1024") value = lissajousAxis(node, need(values, node.time));
    else throw new Error("Parametric trace graph node is not admitted.");
    if (!Number.isFinite(value) || Math.abs(value) > MAX_GRAPH_VALUE) throw new Error(`Parametric trace graph node ${node.id} produced an out-of-range value.`);
    values.set(node.id, quantizeMotionProceduralValue(value));
  }
  return { position: vector(need(values, graph.output.x), need(values, graph.output.y), need(values, graph.output.z), "parametric graph"), workUnits: graph.nodes.length };
}

function trigonometric(kind: "sin" | "cos", input: number, id: string): number {
  if (!Number.isFinite(input) || Math.abs(input) > MAX_PROCEDURAL_TRIG_INPUT_RADIANS) throw new Error(`Parametric trace ${kind} node ${id} requires finite radians within +/-${MAX_PROCEDURAL_TRIG_INPUT_RADIANS}.`);
  const radians = quantizeMotionProceduralValue(input);
  return quantizeMotionProceduralValue(kind === "sin" ? Math.sin(radians) : Math.cos(radians));
}

function lissajousAxis(node: Extract<MotionParametricTraceGraph["nodes"][number], { kind: "lissajous-axis-q1024" }>, atUs: number): number {
  const denominator = node.durationUs * 1_024;
  const numerator = atUs * node.frequency * 1_024 + node.phaseTurnsQ1024 * node.durationUs;
  if (!Number.isSafeInteger(atUs) || !Number.isSafeInteger(denominator) || !Number.isSafeInteger(numerator)) throw new Error(`Parametric trace Lissajous node ${node.id} exceeds exact integer-turn arithmetic.`);
  const remainder = numerator % denominator;
  return node.center + node.amplitude * Math.sin(TWO_PI * remainder / denominator);
}

function bouncePosition(drawer: MotionParametricTraceDrawer, atUs: number): TracePosition {
  const driver = drawer.driver;
  if (driver.kind !== "bounded-bounce") throw new Error("Internal bounce trace driver mismatch.");
  const seconds = atUs / 1_000_000;
  if (seconds < 0 || atUs > MAX_MOTION_PARAMETRIC_TRACE_DURATION_US) throw new Error("Parametric trace bounce time is out of bounds.");
  if (driver.collision.kind === "box") return boxBounce(driver.initial, driver.velocity, driver.collision.min, driver.collision.max, seconds, driver.maxCollisions);
  if (driver.collision.kind === "plane") return planeBounce(driver.initial, driver.velocity, driver.collision.normal, driver.collision.offset, seconds, driver.maxCollisions);
  return sphereBounce(driver.initial, driver.velocity, driver.collision.center, driver.collision.radius, seconds, driver.maxCollisions);
}

function boxBounce(initial: MotionParametricTraceVector, velocity: MotionParametricTraceVector, min: MotionParametricTraceVector, max: MotionParametricTraceVector, seconds: number, maxCollisions: number): TracePosition {
  if (!insideBox(initial, min, max)) throw new Error("Parametric trace box bounce requires an initial point inside the fixed box.");
  const collisions = axisCollisions(initial.x, velocity.x, min.x, max.x, seconds) + axisCollisions(initial.y, velocity.y, min.y, max.y, seconds) + axisCollisions(initial.z, velocity.z, min.z, max.z, seconds);
  if (collisions > maxCollisions) throw new Error(`Parametric trace box bounce exceeds its explicit ${maxCollisions}-collision cap.`);
  return { position: vector(fold(initial.x + velocity.x * seconds, min.x, max.x), fold(initial.y + velocity.y * seconds, min.y, max.y), fold(initial.z + velocity.z * seconds, min.z, max.z), "box bounce"), workUnits: 3 + collisions };
}

function planeBounce(initial: MotionParametricTraceVector, velocity: MotionParametricTraceVector, normal: MotionParametricTraceVector, offset: number, seconds: number, maxCollisions: number): TracePosition {
  const unit = scale(normal, 1 / magnitude(normal));
  if (dot(initial, unit) < offset) throw new Error("Parametric trace plane bounce requires an initial point on the admitted plane side.");
  const raw = add(initial, scale(velocity, seconds)), distance = dot(raw, unit) - offset;
  const collisions = distance < 0 ? 1 : 0;
  if (collisions > maxCollisions) throw new Error(`Parametric trace plane bounce exceeds its explicit ${maxCollisions}-collision cap.`);
  return { position: distance < 0 ? vectorFrom(add(raw, scale(unit, -2 * distance)), "plane bounce") : vectorFrom(raw, "plane bounce"), workUnits: 2 + collisions };
}

function sphereBounce(initial: MotionParametricTraceVector, velocity: MotionParametricTraceVector, center: MotionParametricTraceVector, radius: number, seconds: number, maxCollisions: number): TracePosition {
  const initialRelative = add(initial, scale(center, -1));
  if (dot(initialRelative, initialRelative) >= radius * radius) throw new Error("Parametric trace sphere bounce requires an initial point strictly inside the fixed sphere.");
  let position = initial, direction = velocity, remaining = seconds, collisions = 0;
  while (remaining > 1e-12) {
    const speedSquared = dot(direction, direction); if (speedSquared === 0) return { position: vectorFrom(position, "sphere bounce"), workUnits: 2 + collisions };
    const relative = add(position, scale(center, -1)), b = dot(relative, direction), c = dot(relative, relative) - radius * radius, discriminant = b * b - speedSquared * c;
    const impact = discriminant < 0 ? Number.POSITIVE_INFINITY : (-b + Math.sqrt(discriminant)) / speedSquared;
    if (!Number.isFinite(impact) || impact <= 1e-12 || impact >= remaining) return { position: vectorFrom(add(position, scale(direction, remaining)), "sphere bounce"), workUnits: 4 + collisions * 6 };
    if (collisions >= maxCollisions) throw new Error(`Parametric trace sphere bounce exceeds its explicit ${maxCollisions}-collision cap.`);
    position = add(position, scale(direction, impact)); const normal = scale(add(position, scale(center, -1)), 1 / radius);
    direction = add(direction, scale(normal, -2 * dot(direction, normal))); remaining -= impact; collisions += 1;
  }
  return { position: vectorFrom(position, "sphere bounce"), workUnits: 4 + collisions * 6 };
}

function normalizedSpeed(positions: readonly MotionParametricTraceVector[], schedule: readonly number[], index: number, limit: number): number {
  if (index === 0) return 0;
  const elapsed = (schedule[index]! - schedule[index - 1]!) / 1_000_000;
  if (elapsed <= 0) throw new Error("Parametric trace schedule must be strictly ascending.");
  return quantizeMotionProceduralValue(Math.min(1, magnitude(add(positions[index]!, scale(positions[index - 1]!, -1))) / elapsed / limit));
}
function vector(x: number | undefined, y: number | undefined, z: number | undefined, label: string): MotionParametricTraceVector { return vectorFrom({ x: x ?? 0, y: y ?? 0, z: z ?? 0 }, label); }
function vectorFrom(value: MotionParametricTraceVector, label: string): MotionParametricTraceVector { const result = { x: quantizeMotionProceduralValue(value.x), y: quantizeMotionProceduralValue(value.y), z: quantizeMotionProceduralValue(value.z) }; if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || !Number.isFinite(result.z) || Math.max(Math.abs(result.x), Math.abs(result.y), Math.abs(result.z)) > MAX_MOTION_PARAMETRIC_TRACE_COORDINATE) throw new Error(`Parametric trace ${label} position exceeds the coordinate limit.`); return result; }
function need(values: Map<string, number>, id: string): number { const value = values.get(id); if (value === undefined) throw new Error(`Parametric trace graph node ${id} is unavailable.`); return value; }
function fold(value: number, min: number, max: number): number { const width = max - min, period = width * 2, phase = ((value - min) % period + period) % period; return phase <= width ? min + phase : max - (phase - width); }
function axisCollisions(initial: number, velocity: number, min: number, max: number, seconds: number): number { if (velocity === 0 || seconds === 0) return 0; const width = max - min, start = (initial - min) / width, end = start + (velocity * seconds) / width; let crossed = Math.max(0, Math.floor(Math.max(start, end)) - Math.floor(Math.min(start, end))); if (Number.isInteger(start) && velocity < 0) crossed -= 1; if ((start === 0 && velocity < 0) || (start === 1 && velocity > 0)) crossed += 1; return Math.max(0, crossed); }
function insideBox(value: MotionParametricTraceVector, min: MotionParametricTraceVector, max: MotionParametricTraceVector): boolean { return value.x >= min.x && value.x <= max.x && value.y >= min.y && value.y <= max.y && value.z >= min.z && value.z <= max.z; }
function add(left: MotionParametricTraceVector, right: MotionParametricTraceVector): MotionParametricTraceVector { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
function scale(value: MotionParametricTraceVector, amount: number): MotionParametricTraceVector { return { x: value.x * amount, y: value.y * amount, z: value.z * amount }; }
function dot(left: MotionParametricTraceVector, right: MotionParametricTraceVector): number { return left.x * right.x + left.y * right.y + left.z * right.z; }
function magnitude(value: MotionParametricTraceVector): number { return Math.hypot(value.x, value.y, value.z); }
