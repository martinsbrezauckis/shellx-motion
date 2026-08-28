import { isSupportedEasing } from "./timeline";

const MAX_NODES = 16;
const MAX_POSES_PER_NODE = 32;
const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MIN_SCALE = 0.001;
const MAX_SCALE = 100;

export interface CutoutRigPose {
  atMs: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  easing?: string;
}

export interface CutoutRigNode {
  layerId: string;
  parentId?: string;
  stackIndex: number;
  crop: { x: number; y: number; width: number; height: number };
  origin: { x: number; y: number };
  poses: CutoutRigPose[];
}

export interface CutoutRig {
  schema: "shellx-motion/cutout-rig@1";
  sampleEveryFrames: number;
  nodes: CutoutRigNode[];
}

/** Parse a JSON-only rig request without invoking user getters or accepting extension fields. */
export function parseCutoutRig(value: unknown): CutoutRig {
  const input = dataRecord(value, "rig");
  exactKeys(input, ["schema", "sampleEveryFrames", "nodes"], "rig");
  if (input.schema !== "shellx-motion/cutout-rig@1") throw new Error("Cutout rig schema must be shellx-motion/cutout-rig@1.");
  const sampleEveryFrames = positiveInteger(input.sampleEveryFrames, "rig.sampleEveryFrames");
  if (sampleEveryFrames > 16) throw new Error("Cutout rig sampleEveryFrames must be at most 16.");
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > MAX_NODES) {
    throw new Error(`Cutout rig nodes must contain between 1 and ${MAX_NODES} entries.`);
  }
  const nodes = input.nodes.map((node, index) => parseNode(node, `rig.nodes[${index}]`));
  const ids = new Set<string>();
  const stacks = new Set<number>();
  for (const node of nodes) {
    if (ids.has(node.layerId)) throw new Error(`Cutout rig repeats output layerId ${node.layerId}.`);
    if (stacks.has(node.stackIndex)) throw new Error(`Cutout rig repeats stackIndex ${node.stackIndex}.`);
    ids.add(node.layerId);
    stacks.add(node.stackIndex);
    if (node.parentId && !nodes.some((candidate) => candidate.layerId === node.parentId)) {
      throw new Error(`Cutout rig node ${node.layerId} names an unknown parentId ${node.parentId}.`);
    }
  }
  for (let index = 0; index < nodes.length; index += 1) if (!stacks.has(index)) {
    throw new Error("Cutout rig stackIndex values must form the explicit 0..nodes.length-1 output order.");
  }
  assertAcyclic(nodes);
  return { schema: "shellx-motion/cutout-rig@1", sampleEveryFrames, nodes };
}

function assertAcyclic(nodes: CutoutRigNode[]): void {
  const byId = new Map(nodes.map((node) => [node.layerId, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: CutoutRigNode, depth: number): void => {
    if (visited.has(node.layerId)) return;
    if (visiting.has(node.layerId)) throw new Error("Cutout rig parent graph contains a cycle.");
    if (depth > 8) throw new Error("Cutout rig parent graph exceeds depth 8.");
    visiting.add(node.layerId);
    if (node.parentId) visit(byId.get(node.parentId)!, depth + 1);
    visiting.delete(node.layerId);
    visited.add(node.layerId);
  };
  for (const node of nodes) visit(node, 1);
}

function parseNode(value: unknown, path: string): CutoutRigNode {
  const node = dataRecord(value, path);
  exactKeys(node, ["layerId", "parentId", "stackIndex", "crop", "origin", "poses"], path);
  const layerId = safeId(node.layerId, `${path}.layerId`);
  const parentId = node.parentId === undefined ? undefined : safeId(node.parentId, `${path}.parentId`);
  if (parentId === layerId) throw new Error(`${path}.parentId may not equal layerId.`);
  const stackIndex = nonNegativeInteger(node.stackIndex, `${path}.stackIndex`);
  const crop = rectangle(node.crop, `${path}.crop`);
  const origin = point(node.origin, `${path}.origin`);
  if (origin.x > crop.width || origin.y > crop.height) throw new Error(`${path}.origin must be inside the cropped output box.`);
  if (!Array.isArray(node.poses) || node.poses.length === 0 || node.poses.length > MAX_POSES_PER_NODE) {
    throw new Error(`${path}.poses must contain between 1 and ${MAX_POSES_PER_NODE} entries.`);
  }
  let previousAtMs = -1;
  const poses = node.poses.map((pose, index) => {
    const parsed = parsePose(pose, `${path}.poses[${index}]`);
    if (parsed.atMs <= previousAtMs) throw new Error(`${path}.poses must be strictly increasing by atMs.`);
    previousAtMs = parsed.atMs;
    return parsed;
  });
  return { layerId, ...(parentId ? { parentId } : {}), stackIndex, crop, origin, poses };
}

function parsePose(value: unknown, path: string): CutoutRigPose {
  const pose = dataRecord(value, path);
  exactKeys(pose, ["atMs", "x", "y", "scale", "rotation", "easing"], path);
  const easing = pose.easing === undefined ? undefined : pose.easing;
  if (easing !== undefined && (typeof easing !== "string" || !isSupportedEasing(easing))) throw new Error(`${path}.easing is unsupported.`);
  const scale = finite(pose.scale, `${path}.scale`);
  if (scale < MIN_SCALE || scale > MAX_SCALE) throw new Error(`${path}.scale must be between ${MIN_SCALE} and ${MAX_SCALE}.`);
  return {
    atMs: nonNegativeInteger(pose.atMs, `${path}.atMs`),
    x: boundedCoordinate(pose.x, `${path}.x`), y: boundedCoordinate(pose.y, `${path}.y`), scale,
    rotation: boundedCoordinate(pose.rotation, `${path}.rotation`), ...(typeof easing === "string" ? { easing } : {})
  };
}

function dataRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`${path} may not contain symbol fields.`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor) || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${path} must contain enumerable data properties only.`);
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function exactKeys(record: Record<string, unknown>, keys: string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${path} has unsupported field ${key}.`);
}

function safeId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`${path} must be a safe identifier.`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
  return value;
}

function boundedCoordinate(value: unknown, path: string): number {
  const number = finite(value, path);
  if (Math.abs(number) > MAX_ABSOLUTE_COORDINATE) throw new Error(`${path} exceeds the ${MAX_ABSOLUTE_COORDINATE} coordinate bound.`);
  return number;
}

function positiveInteger(value: unknown, path: string): number {
  const number = finite(value, path);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${path} must be a positive integer.`);
  return number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const number = finite(value, path);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${path} must be a non-negative integer.`);
  return number;
}

function point(value: unknown, path: string): { x: number; y: number } {
  const pointValue = dataRecord(value, path);
  exactKeys(pointValue, ["x", "y"], path);
  const x = finite(pointValue.x, `${path}.x`);
  const y = finite(pointValue.y, `${path}.y`);
  if (x < 0 || y < 0 || x > MAX_ABSOLUTE_COORDINATE || y > MAX_ABSOLUTE_COORDINATE) throw new Error(`${path} must be non-negative and bounded.`);
  return { x, y };
}

function rectangle(value: unknown, path: string): { x: number; y: number; width: number; height: number } {
  const rectangleValue = dataRecord(value, path);
  exactKeys(rectangleValue, ["x", "y", "width", "height"], path);
  return {
    x: nonNegativeInteger(rectangleValue.x, `${path}.x`),
    y: nonNegativeInteger(rectangleValue.y, `${path}.y`),
    width: positiveInteger(rectangleValue.width, `${path}.width`),
    height: positiveInteger(rectangleValue.height, `${path}.height`)
  };
}
