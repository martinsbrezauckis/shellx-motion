import type {
  MotionRelationActionColorParameter,
  MotionRelationActionLayerRef,
  MotionRelationActionNumberParameter,
  MotionRelationActionRelationTemplate,
  MotionRelationActionRole,
  MotionRelationActionSequenceStep,
} from "./motion-relation-actions-types";
import type { MotionTransform } from "./types";

/**
 * Persisted C4B authoring metadata. It is deliberately not a renderer authority: applying a
 * definition lowers it to ordinary layers, tracks, transitions, and relations@1 instead.
 */
export const MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA = "shellx-motion/relation-actions@2" as const;
export const MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA = "shellx-motion/relation-action-layer-prototype@1" as const;
export const MOTION_RELATION_ACTION_APPLY_PLAN_SCHEMA = "shellx-motion/relation-action-apply-plan@1" as const;

export const MAX_MOTION_RELATION_ACTION_DEFINITIONS = 16;
export const MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS = 32;
export const MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES = 16;
export const MAX_MOTION_RELATION_ACTION_ROLES = 16;
export const MAX_MOTION_RELATION_ACTION_PARAMETERS = 16;
export const MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS = 32;
export const MAX_MOTION_RELATION_ACTION_STORE_BYTES = 128 * 1024;
export const MAX_MOTION_RELATION_ACTION_LOCAL_US = 3_600_000_000;
export const MAX_MOTION_RELATION_ACTION_APPLY_OBJECTS = 32;
export const MAX_MOTION_RELATION_ACTION_APPLY_RELATIONS = 16;
export const MAX_MOTION_RELATION_ACTION_APPLY_KEYFRAME_WRITES = 128;

export type MotionRelationActionClosedTransform = Pick<MotionTransform,
  "x" | "y" | "width" | "height" | "opacity" | "scale" | "rotation" | "originX" | "originY">;

interface MotionRelationActionLayerPrototypeCommon {
  schema: typeof MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA;
  /** Local to the direct group owner, or document time for a root template. */
  startUs: number;
  durationUs: number;
  name?: string;
  visible?: boolean;
  transform?: MotionRelationActionClosedTransform;
}

/** Initial C4B creation subset: a closed, ordinary shape layer. */
export interface MotionRelationActionShapePrototype extends MotionRelationActionLayerPrototypeCommon {
  type: "shape";
  shape: "rect" | "rounded-rect" | "ellipse" | "triangle" | "star";
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

/** Initial C4B creation subset: a group whose children are explicit template layers. */
export interface MotionRelationActionGroupPrototype extends MotionRelationActionLayerPrototypeCommon {
  type: "group";
}

export type MotionRelationActionLayerPrototype = MotionRelationActionShapePrototype | MotionRelationActionGroupPrototype;

export interface MotionRelationActionTemplateLayer {
  id: string;
  /** Closed authored layer definition; this is data for materialization, never renderer authority. */
  layer: MotionRelationActionLayerPrototype;
  parent?: MotionRelationActionLayerRef;
}

export interface MotionRelationActionDefinition {
  id: string;
  roles: MotionRelationActionRole[];
  parameters: Array<MotionRelationActionNumberParameter | MotionRelationActionColorParameter>;
  templateLayers: MotionRelationActionTemplateLayer[];
  relationTemplates: MotionRelationActionRelationTemplate[];
  sequence: MotionRelationActionSequenceStep[];
}

export interface MotionRelationActionStore {
  schema: typeof MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA;
  definitions: MotionRelationActionDefinition[];
}

/** Ephemeral, exact-base apply request. It is receipt-bound but is never persisted in motion.json. */
export interface MotionRelationActionApplyRequest {
  definitionId: string;
  expectedMotionSha256: string;
  expectedStoreSha256: string;
  expectedDefinitionSha256: string;
  instanceId: string;
  startAtUs: number;
  roleBindings: Record<string, string>;
  parameterValues: Record<string, number | string>;
}

export interface MotionRelationActionApplyPlan {
  schema: typeof MOTION_RELATION_ACTION_APPLY_PLAN_SCHEMA;
  sourceMotionSha256: string;
  storeSha256: string;
  definition: { id: string; sha256: string };
  requestSha256: string;
  instance: {
    id: string;
    startAtUs: number;
    roleBindings: Readonly<Record<string, string>>;
    parameterValues: Readonly<Record<string, number | string>>;
  };
  counts: { objects: number; relations: number; keyframeWrites: number };
  fingerprint: string;
}
