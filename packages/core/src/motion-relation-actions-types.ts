import type { MotionKeyframeTarget, MotionLayerType } from "./types";
import type { TransitionPresetId } from "./transition-presets";
import type { MotionRelationBinding } from "./motion-relation-types";

/**
 * Private direct-import ABI only. It describes authoring-time recipes, never a persisted Motion
 * document root, renderer command, package mutation, or live instance relationship.
 */
export const MOTION_RELATION_ACTIONS_SCHEMA = "shellx-motion/relation-actions@1" as const;
export const MOTION_RELATION_ACTION_MATERIALIZATION_PLAN_SCHEMA = "shellx-motion/relation-action-materialization-plan@1" as const;

export const MAX_MOTION_RELATION_ACTION_DEFINITIONS = 16;
export const MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS = 32;
export const MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES = 16;
export const MAX_MOTION_RELATION_ACTION_ROLES = 16;
export const MAX_MOTION_RELATION_ACTION_PARAMETERS = 16;
export const MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS = 32;
export const MAX_MOTION_RELATION_ACTION_STORE_BYTES = 128 * 1024;
export const MAX_MOTION_RELATION_ACTION_LOCAL_US = 3_600_000_000;

export type MotionRelationActionLayerRef =
  | { source: "role"; roleId: string }
  | { source: "template"; templateLayerId: string };

export interface MotionRelationActionLayerRole {
  id: string;
  kind: "layer";
  /** Closed Motion layer vocabulary expected when the action is materialized. */
  layerTypes: MotionLayerType[];
}
export interface MotionRelationActionGroupRole { id: string; kind: "group" }
export type MotionRelationActionRole = MotionRelationActionLayerRole | MotionRelationActionGroupRole;

export interface MotionRelationActionNumberParameter {
  id: string;
  type: "number";
  minimum: number;
  maximum: number;
  defaultValue: number;
}
export interface MotionRelationActionColorParameter { id: string; type: "color"; defaultValue: string }
export type MotionRelationActionParameter = MotionRelationActionNumberParameter | MotionRelationActionColorParameter;

export type MotionRelationActionNumberValue =
  | { source: "literal"; value: number }
  | { source: "parameter"; parameterId: string };
export type MotionRelationActionColorValue =
  | { source: "literal"; value: string }
  | { source: "parameter"; parameterId: string };

/** A bare typed layer recipe; visual data is supplied only through ordinary typed steps. */
export interface MotionRelationActionTemplateLayer {
  id: string;
  layerType: MotionLayerType;
  parent?: MotionRelationActionLayerRef;
}

export interface MotionRelationActionEndpointTemplate {
  layer: MotionRelationActionLayerRef;
  anchorX: MotionRelationActionNumberValue;
  anchorY: MotionRelationActionNumberValue;
}
interface MotionRelationActionRelationCommon {
  id: string;
  enabled: boolean;
  source: MotionRelationActionEndpointTemplate;
  target: MotionRelationActionEndpointTemplate;
  startUs: number;
  durationUs: MotionRelationActionNumberValue;
}
export interface MotionRelationActionAttachTemplate extends MotionRelationActionRelationCommon {
  kind: "attach";
  mode: "follow" | "similarity";
  offset: {
    space: "source" | "world";
    x: MotionRelationActionNumberValue;
    y: MotionRelationActionNumberValue;
    rotationDeg: MotionRelationActionNumberValue;
    scale: MotionRelationActionNumberValue;
  };
}
export interface MotionRelationActionAimTemplate extends MotionRelationActionRelationCommon {
  kind: "aim";
  rotationOffsetDeg: MotionRelationActionNumberValue;
}
export type MotionRelationActionRelationTemplate = MotionRelationActionAttachTemplate | MotionRelationActionAimTemplate;

export interface MotionRelationActionKeyframeStep {
  id: string;
  kind: "keyframe";
  atUs: number;
  target: MotionRelationActionLayerRef;
  property: MotionKeyframeTarget;
  value: MotionRelationActionNumberValue | MotionRelationActionColorValue;
  easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}
export interface MotionRelationActionTransitionStep {
  id: string;
  kind: "transition";
  atUs: number;
  target: MotionRelationActionLayerRef;
  presetId: TransitionPresetId;
  durationUs: MotionRelationActionNumberValue;
}
export interface MotionRelationActionRelationStep {
  id: string;
  kind: "relation";
  atUs: number;
  relationTemplateId: string;
}
export type MotionRelationActionSequenceStep = MotionRelationActionKeyframeStep | MotionRelationActionTransitionStep | MotionRelationActionRelationStep;

export interface MotionRelationActionDefinition {
  id: string;
  roles: MotionRelationActionRole[];
  parameters: MotionRelationActionParameter[];
  templateLayers: MotionRelationActionTemplateLayer[];
  relationTemplates: MotionRelationActionRelationTemplate[];
  sequence: MotionRelationActionSequenceStep[];
}
export interface MotionRelationActionStore {
  schema: typeof MOTION_RELATION_ACTIONS_SCHEMA;
  definitions: MotionRelationActionDefinition[];
}

export interface MotionRelationActionMaterializationInput {
  definitionId: string;
  expectedDefinitionSha256: string;
  instanceId: string;
  startAtUs: number;
  roleBindings: Record<string, string>;
  parameterValues: Record<string, number | string>;
}
export interface MotionRelationActionMaterializationContext {
  /** Existing document facts captured by the caller; this contract never dereferences a live document. */
  existingLayers: readonly { id: string; type: MotionLayerType }[];
}

export type MotionRelationActionOperation =
  | { operationId: string; kind: "group.create"; layerId: string; templateLayerId: string; parentLayerId?: string }
  | { operationId: string; kind: "layer.create"; layerId: string; templateLayerId: string; layerType: MotionLayerType; parentLayerId?: string }
  | { operationId: string; kind: "keyframe.upsert"; atUs: number; layerId: string; property: MotionKeyframeTarget; value: number | string; easing?: string }
  | { operationId: string; kind: "transition.apply"; atUs: number; layerId: string; presetId: TransitionPresetId; durationUs: number }
  | { operationId: string; kind: "relation.upsert"; atUs: number; relationId: string; relationTemplateId: string; binding: MotionRelationBinding };

export interface MotionRelationActionMaterializationPlan {
  schema: typeof MOTION_RELATION_ACTION_MATERIALIZATION_PLAN_SCHEMA;
  actionSourceSha256: string;
  definition: { id: string; sha256: string };
  instance: { id: string; startAtUs: number; roleBindings: Readonly<Record<string, string>>; parameterValues: Readonly<Record<string, number | string>> };
  operations: readonly MotionRelationActionOperation[];
  fingerprint: string;
}
