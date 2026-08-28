import {
  MAX_MOTION_RELATION_ACTION_DEFINITIONS,
  MAX_MOTION_RELATION_ACTION_LOCAL_US,
  MAX_MOTION_RELATION_ACTION_PARAMETERS,
  MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES,
  MAX_MOTION_RELATION_ACTION_ROLES,
  MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS,
  MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS,
  MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA,
  MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA,
} from "./motion-relation-actions-public-types";
import { MOTION_RELATION_ACTION_ROLE_LAYER_TYPES } from "./motion-relation-action-layer-types";

/** Exact portable shape for persisted C4B authoring metadata; renderers do not consume this root. */
export function buildMotionRelationActionDefinitions(): Record<string, unknown> {
  const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" };
  const color = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
  const us = { type: "integer", minimum: 0, maximum: MAX_MOTION_RELATION_ACTION_LOCAL_US };
  const positiveUs = { type: "integer", minimum: 1, maximum: MAX_MOTION_RELATION_ACTION_LOCAL_US };
  const numberValue = {
    oneOf: [
      { type: "object", required: ["source", "value"], additionalProperties: false, properties: { source: { const: "literal" }, value: { type: "number", minimum: -MAX_MOTION_RELATION_ACTION_LOCAL_US, maximum: MAX_MOTION_RELATION_ACTION_LOCAL_US } } },
      { type: "object", required: ["source", "parameterId"], additionalProperties: false, properties: { source: { const: "parameter" }, parameterId: id } },
    ],
  };
  const colorValue = {
    oneOf: [
      { type: "object", required: ["source", "value"], additionalProperties: false, properties: { source: { const: "literal" }, value: color } },
      { type: "object", required: ["source", "parameterId"], additionalProperties: false, properties: { source: { const: "parameter" }, parameterId: id } },
    ],
  };
  const layerRef = {
    oneOf: [
      { type: "object", required: ["source", "roleId"], additionalProperties: false, properties: { source: { const: "role" }, roleId: id } },
      { type: "object", required: ["source", "templateLayerId"], additionalProperties: false, properties: { source: { const: "template" }, templateLayerId: id } },
    ],
  };
  const transform = {
    type: "object", minProperties: 1, additionalProperties: false,
    properties: {
      x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
      width: { type: "number", minimum: 0, maximum: 1_000_000 }, height: { type: "number", minimum: 0, maximum: 1_000_000 },
      opacity: { type: "number", minimum: 0, maximum: 1 }, scale: { type: "number", minimum: 0.001, maximum: 64 },
      rotation: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, originX: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, originY: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
    },
  };
  const commonPrototype = { schema: { const: MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA }, startUs: us, durationUs: positiveUs, name: { type: "string", minLength: 1, maxLength: 256 }, visible: { type: "boolean" }, transform };
  const endpoint = { type: "object", required: ["layer", "anchorX", "anchorY"], additionalProperties: false, properties: { layer: layerRef, anchorX: numberValue, anchorY: numberValue } };
  const relationCommon = { id, enabled: { type: "boolean" }, source: endpoint, target: endpoint, startUs: us, durationUs: numberValue };
  return {
    motionRelationActions: {
      type: "object", required: ["schema", "definitions"], additionalProperties: false,
      properties: { schema: { const: MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA }, definitions: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_DEFINITIONS, items: { $ref: "#/$defs/motionRelationActionDefinition" } } },
      $comment: "Persisted authoring metadata only. Runtime validation additionally enforces descriptor safety, strict code-unit order, relation topology and materialization caps. Renderers ignore this root; only ordinary materialized data carries runtime authority.",
    },
    motionRelationActionDefinition: {
      type: "object", required: ["id", "roles", "parameters", "templateLayers", "relationTemplates", "sequence"], additionalProperties: false,
      properties: {
        id, roles: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_ROLES, items: { $ref: "#/$defs/motionRelationActionRole" } },
        parameters: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_PARAMETERS, items: { $ref: "#/$defs/motionRelationActionParameter" } },
        templateLayers: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS, items: { $ref: "#/$defs/motionRelationActionTemplateLayer" } },
        relationTemplates: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES, items: { $ref: "#/$defs/motionRelationActionRelationTemplate" } },
        sequence: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS, items: { $ref: "#/$defs/motionRelationActionSequenceStep" } },
      },
    },
    motionRelationActionRole: {
      oneOf: [
        { type: "object", required: ["id", "kind"], additionalProperties: false, properties: { id, kind: { const: "group" } } },
        { type: "object", required: ["id", "kind", "layerTypes"], additionalProperties: false, properties: { id, kind: { const: "layer" }, layerTypes: { type: "array", minItems: 1, maxItems: MOTION_RELATION_ACTION_ROLE_LAYER_TYPES.length, uniqueItems: true, items: { enum: MOTION_RELATION_ACTION_ROLE_LAYER_TYPES } } } },
      ],
    },
    motionRelationActionParameter: {
      oneOf: [
        { type: "object", required: ["id", "type", "minimum", "maximum", "defaultValue"], additionalProperties: false, properties: { id, type: { const: "number" }, minimum: { type: "number", minimum: -MAX_MOTION_RELATION_ACTION_LOCAL_US, maximum: MAX_MOTION_RELATION_ACTION_LOCAL_US }, maximum: { type: "number", minimum: -MAX_MOTION_RELATION_ACTION_LOCAL_US, maximum: MAX_MOTION_RELATION_ACTION_LOCAL_US }, defaultValue: { type: "number", minimum: -MAX_MOTION_RELATION_ACTION_LOCAL_US, maximum: MAX_MOTION_RELATION_ACTION_LOCAL_US } } },
        { type: "object", required: ["id", "type", "defaultValue"], additionalProperties: false, properties: { id, type: { const: "color" }, defaultValue: color } },
      ],
    },
    motionRelationActionTemplateLayer: {
      type: "object", required: ["id", "layer"], additionalProperties: false,
      properties: { id, parent: layerRef, layer: { $ref: "#/$defs/motionRelationActionLayerPrototype" } },
    },
    motionRelationActionLayerPrototype: {
      oneOf: [
        { type: "object", required: ["schema", "type", "startUs", "durationUs", "shape", "fill"], additionalProperties: false, properties: { ...commonPrototype, type: { const: "shape" }, shape: { enum: ["rect", "rounded-rect", "ellipse", "triangle", "star"] }, fill: color, stroke: color, strokeWidth: { type: "number", minimum: 0, maximum: 4096 } } },
        { type: "object", required: ["schema", "type", "startUs", "durationUs"], additionalProperties: false, properties: { ...commonPrototype, type: { const: "group" } } },
      ],
    },
    motionRelationActionRelationTemplate: {
      oneOf: [
        { type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], additionalProperties: false, properties: { ...relationCommon, kind: { const: "attach" }, mode: { enum: ["follow", "similarity"] }, offset: { type: "object", required: ["space", "x", "y", "rotationDeg", "scale"], additionalProperties: false, properties: { space: { enum: ["source", "world"] }, x: numberValue, y: numberValue, rotationDeg: numberValue, scale: numberValue } } } },
        { type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], additionalProperties: false, properties: { ...relationCommon, kind: { const: "aim" }, rotationOffsetDeg: numberValue } },
      ],
    },
    motionRelationActionSequenceStep: {
      oneOf: [
        { type: "object", required: ["id", "kind", "atUs", "target", "property", "value"], additionalProperties: false, properties: { id, kind: { const: "keyframe" }, atUs: us, target: layerRef, property: { enum: ["transform.x", "transform.y", "transform.width", "transform.height", "transform.originX", "transform.originY", "transform.scale", "transform.rotation", "opacity", "pathReveal.start", "pathReveal.end", "gradient.angle", "fill", "style.fill", "style.color", "style.stroke", "style.borderColor", "style.backgroundColor", "style.background", "style.shadow.color", "style.textShadow.color", "effects.glow.color"] }, value: { oneOf: [numberValue, colorValue] }, easing: { enum: ["linear", "ease-in", "ease-out", "ease-in-out"] } } },
        { type: "object", required: ["id", "kind", "atUs", "target", "presetId", "durationUs"], additionalProperties: false, properties: { id, kind: { const: "transition" }, atUs: us, target: layerRef, presetId: { enum: ["soft-fade", "slide-cover", "wipe-accent", "card-stack", "push-zoom", "scan-sweep", "split-reveal"] }, durationUs: numberValue } },
        { type: "object", required: ["id", "kind", "atUs", "relationTemplateId"], additionalProperties: false, properties: { id, kind: { const: "relation" }, atUs: us, relationTemplateId: id } },
      ],
    },
  };
}
