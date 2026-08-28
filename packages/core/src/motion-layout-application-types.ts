import type { MotionLayout, MotionLayoutRepeater } from "./motion-layout";
import type { MotionTransform } from "./types";

export const MOTION_LAYOUT_APPLICATION_SCHEMA = "shellx-motion/layout-application@1" as const;

export interface MotionLayoutApplicationSnapshot {
  transform: MotionTransform;
  timing: { startMs: number; durationMs: number };
}

export interface MotionLayoutApplicationPatch {
  layerId: string;
  before: MotionLayoutApplicationSnapshot;
  after: MotionLayoutApplicationSnapshot;
}

export interface MotionLayoutApplicationTrackPatch {
  trackId: string;
  beforeLayerIds: string[];
  afterLayerIds: string[];
}

/** A materialized repeated layer is deleted only when its exact stored hash still matches. */
export interface MotionLayoutApplicationGeneratedLayer {
  id: string;
  sourceLayerId: string;
  instanceIndex: number;
  layerSha256: string;
}

/**
 * Declarative state for one reversible layout application. `fingerprint`
 * binds exact record data within the current Motion document, but never grants
 * removal authority; hosts must also verify the persisted apply receipt.
 */
export interface MotionLayoutApplicationRecord {
  schema: typeof MOTION_LAYOUT_APPLICATION_SCHEMA;
  id: string;
  fingerprint: string;
  groupId: string;
  layoutFingerprint: string;
  childLayerIds: string[];
  materializedChildLayerIds: string[];
  layout: MotionLayout;
  repeaters: MotionLayoutRepeater[];
  patches: MotionLayoutApplicationPatch[];
  trackPatches: MotionLayoutApplicationTrackPatch[];
  generatedLayers: MotionLayoutApplicationGeneratedLayer[];
}
