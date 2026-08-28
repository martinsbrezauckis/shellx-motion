import type { MotionDocument } from "./types";

/** Public bounded data ABI. Every current render lane refuses this root store until a lowerer joins it. */
export const MOTION_RELATIONS_SCHEMA = "shellx-motion/relations@1" as const;
export const MOTION_RELATION_STATIC_PLAN_SCHEMA = "shellx-motion/relation-static-plan@1" as const;
export const MOTION_RELATION_FRAME_PLAN_SCHEMA = "shellx-motion/relation-frame-plan@1" as const;

export const MAX_MOTION_RELATION_BINDINGS = 32;
export const MAX_MOTION_RELATION_BINDING_BYTES = 16 * 1024;
export const MAX_MOTION_RELATION_STORE_BYTES = 512 * 1024;
export const MAX_MOTION_RELATION_DURATION_US = 3_600_000_000;
export const MAX_MOTION_RELATION_DEPTH = 16;
export const MAX_MOTION_RELATION_FRAME_WORK_UNITS = 4_096;
export const MAX_MOTION_RELATION_COORDINATE = 1_000_000;
export const MAX_MOTION_RELATION_ROTATION_DEGREES = 360_000;
export const MIN_MOTION_RELATION_SCALE = 0.001;
export const MAX_MOTION_RELATION_SCALE = 64;

export type MotionRelationWriteMask = "transform.x" | "transform.y" | "transform.rotation" | "transform.scale";
export type MotionRelationAttachmentMode = "follow" | "similarity";

/** A resolved local pixel point. Named/bounds-derived anchors are authoring sugar and never persist here. */
export interface MotionRelationAnchor { x: number; y: number }
export interface MotionRelationEndpoint { layerId: string; anchor: MotionRelationAnchor }
export interface MotionRelationOffset {
  /** Source offsets are transformed by the source similarity; world offsets are document-pixel values. */
  space: "source" | "world";
  x: number;
  y: number;
  rotationDeg: number;
  scale: number;
}

interface MotionRelationCommon {
  id: string;
  enabled: boolean;
  source: MotionRelationEndpoint;
  target: MotionRelationEndpoint;
  startUs: number;
  durationUs: number;
}

/** `follow` reserves translation. `similarity` is the normalized attach/parent form and reserves all 2D similarity channels. */
export interface MotionRelationAttach extends MotionRelationCommon {
  kind: "attach";
  mode: MotionRelationAttachmentMode;
  offset: MotionRelationOffset;
}

/** Rotate `target` so its persisted pivot faces the `source` endpoint. */
export interface MotionRelationAim extends MotionRelationCommon {
  kind: "aim";
  rotationOffsetDeg: number;
}

export type MotionRelationBinding = MotionRelationAttach | MotionRelationAim;
export interface MotionRelationStore {
  schema: typeof MOTION_RELATIONS_SCHEMA;
  bindings: MotionRelationBinding[];
}

/** Compatibility alias retained for direct-import Core callers; public `MotionDocument` owns `relations`. */
export type MotionRelationDocument = MotionDocument;

export function motionRelationWriteMask(binding: MotionRelationBinding): readonly MotionRelationWriteMask[] {
  if (binding.kind === "aim") return ["transform.rotation"];
  return binding.mode === "follow"
    ? ["transform.x", "transform.y"]
    : ["transform.x", "transform.y", "transform.rotation", "transform.scale"];
}
