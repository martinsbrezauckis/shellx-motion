import { canonicalJson } from "./canonical-json";
import {
  defaultMotionHostRenderCapacity,
  type MotionHostRenderCapacity,
} from "./host-render-capacity";
import { LocalMotionJobError } from "./job-governor";

export interface MotionPointCapacityUsage {
  layerCount: number;
  maxPointsInLayer: number;
  maxStateRecordsInLayer: number;
  maxPayloadBytesInLayer: number;
  totalPoints: number;
  totalStateRecords: number;
  totalPayloadBytes: number;
}

export interface MotionPointCapacityEvidence {
  schema: "shellx-motion/point-capacity@1";
  status: "fit" | "refused";
  tier: MotionHostRenderCapacity["points"]["tier"];
  usage: MotionPointCapacityUsage;
  limits: {
    maxPointsPerLayer: number;
    maxStateRecordsPerLayer: number;
    maxPayloadBytesPerLayer: number;
    maxLayersPerDocument: number;
    maxStateRecordsPerDocument: number;
    maxPayloadBytesPerDocument: number;
  };
}

export class MotionPointCapacityError extends LocalMotionJobError {
  readonly capacityCode = "point_capacity_exceeded";

  constructor(readonly pointCapacity: MotionPointCapacityEvidence) {
    super("job_input_budget_exceeded",
      `This document's point payload exceeds the ${pointCapacity.tier} host tier `
      + `(points ${pointCapacity.usage.maxPointsInLayer}/${pointCapacity.limits.maxPointsPerLayer}, state records `
      + `${pointCapacity.usage.maxStateRecordsInLayer}/${pointCapacity.limits.maxStateRecordsPerLayer}, payload bytes `
      + `${pointCapacity.usage.maxPayloadBytesInLayer}/${pointCapacity.limits.maxPayloadBytesPerLayer}). Use a machine `
      + "with more available memory/CPU, reduce point density or samples, or render in segments.",
    );
    this.name = "MotionPointCapacityError";
    Object.setPrototypeOf(this, MotionPointCapacityError.prototype);
  }
}

/** Measure the bounded point payload without creating resolved per-frame point arrays. */
export function inspectMotionPointCapacityUsage(layers: readonly unknown[]): MotionPointCapacityUsage {
  const usage: MotionPointCapacityUsage = {
    layerCount: 0,
    maxPointsInLayer: 0,
    maxStateRecordsInLayer: 0,
    maxPayloadBytesInLayer: 0,
    totalPoints: 0,
    totalStateRecords: 0,
    totalPayloadBytes: 0,
  };
  for (const candidate of layers) {
    const layer = record(candidate);
    if (!layer || layer.type !== "points") continue;
    const cloud = record(layer.pointCloud);
    if (!cloud) continue;
    const points = Array.isArray(cloud.points) ? cloud.points.length : 0;
    const samples = Array.isArray(cloud.samples) ? cloud.samples : [];
    const stateRecords = points + samples.reduce((sum, sample) => {
      const positions = record(sample)?.positions;
      return sum + (Array.isArray(positions) ? positions.length : 0);
    }, 0);
    const payloadBytes = canonicalBytes(cloud);
    usage.layerCount += 1;
    usage.maxPointsInLayer = Math.max(usage.maxPointsInLayer, points);
    usage.maxStateRecordsInLayer = Math.max(usage.maxStateRecordsInLayer, stateRecords);
    usage.maxPayloadBytesInLayer = Math.max(usage.maxPayloadBytesInLayer, payloadBytes);
    usage.totalPoints += points;
    usage.totalStateRecords += stateRecords;
    usage.totalPayloadBytes += payloadBytes;
  }
  return usage;
}

export function motionPointCapacityEvidence(
  layers: readonly unknown[],
  capacity: MotionHostRenderCapacity = defaultMotionHostRenderCapacity,
): MotionPointCapacityEvidence {
  const usage = inspectMotionPointCapacityUsage(layers);
  const limits = {
    maxPointsPerLayer: capacity.points.maxPointsPerLayer,
    maxStateRecordsPerLayer: capacity.points.maxStateRecordsPerLayer,
    maxPayloadBytesPerLayer: capacity.points.maxPayloadBytesPerLayer,
    maxLayersPerDocument: capacity.points.maxLayersPerDocument,
    maxStateRecordsPerDocument: capacity.points.maxStateRecordsPerLayer * capacity.points.maxLayersPerDocument,
    maxPayloadBytesPerDocument: capacity.points.maxPayloadBytesPerLayer * capacity.points.maxLayersPerDocument,
  };
  const fit = usage.layerCount <= limits.maxLayersPerDocument
    && usage.maxPointsInLayer <= limits.maxPointsPerLayer
    && usage.maxStateRecordsInLayer <= limits.maxStateRecordsPerLayer
    && usage.maxPayloadBytesInLayer <= limits.maxPayloadBytesPerLayer
    && usage.totalStateRecords <= limits.maxStateRecordsPerDocument
    && usage.totalPayloadBytes <= limits.maxPayloadBytesPerDocument;
  return {
    schema: "shellx-motion/point-capacity@1",
    status: fit ? "fit" : "refused",
    tier: capacity.points.tier,
    usage,
    limits,
  };
}

/** Fail before browser launch/native allocation when a portable package exceeds this host. */
export function assertMotionPointCapacity(
  layers: readonly unknown[],
  capacity: MotionHostRenderCapacity = defaultMotionHostRenderCapacity,
): MotionPointCapacityEvidence {
  const evidence = motionPointCapacityEvidence(layers, capacity);
  if (evidence.status === "refused") throw new MotionPointCapacityError(evidence);
  return evidence;
}

function canonicalBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(canonicalJson(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
