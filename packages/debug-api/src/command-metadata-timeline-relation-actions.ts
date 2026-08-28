/** Closed Debug contracts for persisted relation-actions@2 authoring and exact-base materialization. */
import {
  MAX_MOTION_RELATION_ACTION_DEFINITIONS,
  MAX_MOTION_RELATION_ACTION_PARAMETERS,
  MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES,
  MAX_MOTION_RELATION_ACTION_ROLES,
  MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS,
  MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS,
  MOTION_RELATION_ACTION_ROLE_LAYER_TYPES,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_ROOT } from "./command-metadata-shared.js";

const ID = { type: "string" as const, maxLength: 64, description: "Safe stable identifier." };
const SHA256 = { type: "string" as const, maxLength: 64, description: "Lowercase SHA-256 identity." };
const US = { type: "number" as const, minimum: 0, maximum: 3_600_000_000, description: "Safe-integer microseconds; Core requires exact whole-millisecond bridges where ordinary Motion is emitted." };
const COLOR = { type: "string" as const, maxLength: 7, description: "#RRGGBB color." };
const EDIT = {
  packageRoot: { type: "string" as const, description: "Source package root. The source is never edited in place." },
  outDir: { type: "string" as const, aliases: ["packageDir"], description: "Empty or absent copy-on-write destination outside packageRoot." },
  createdBy: { type: "string" as const, description: "Optional attribution for the one mutation receipt." },
};

const NUMBER_VALUE: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["source", "value"], additionalProperties: false, properties: { source: { type: "string", enum: ["literal"] }, value: { type: "number", minimum: -3_600_000_000, maximum: 3_600_000_000 } } },
  { type: "object", required: ["source", "parameterId"], additionalProperties: false, properties: { source: { type: "string", enum: ["parameter"] }, parameterId: ID } },
] };
const COLOR_VALUE: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["source", "value"], additionalProperties: false, properties: { source: { type: "string", enum: ["literal"] }, value: COLOR } },
  { type: "object", required: ["source", "parameterId"], additionalProperties: false, properties: { source: { type: "string", enum: ["parameter"] }, parameterId: ID } },
] };
const LAYER_REF: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["source", "roleId"], additionalProperties: false, properties: { source: { type: "string", enum: ["role"] }, roleId: ID } },
  { type: "object", required: ["source", "templateLayerId"], additionalProperties: false, properties: { source: { type: "string", enum: ["template"] }, templateLayerId: ID } },
] };
const TRANSFORM: MotionDebugArgPropertySchema = { type: "object", additionalProperties: false, properties: {
  x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
  width: { type: "number", minimum: 0, maximum: 1_000_000 }, height: { type: "number", minimum: 0, maximum: 1_000_000 }, opacity: { type: "number", minimum: 0, maximum: 1 },
  scale: { type: "number", minimum: 0.001, maximum: 64 }, rotation: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, originX: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, originY: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
} };
const LAYER: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["schema", "type", "startUs", "durationUs", "shape", "fill"], additionalProperties: false, properties: { schema: { type: "string", enum: ["shellx-motion/relation-action-layer-prototype@1"] }, type: { type: "string", enum: ["shape"] }, startUs: US, durationUs: { ...US, minimum: 1 }, shape: { type: "string", enum: ["rect", "rounded-rect", "ellipse", "triangle", "star"] }, fill: COLOR, name: { type: "string", maxLength: 256 }, visible: { type: "boolean" }, transform: TRANSFORM, stroke: COLOR, strokeWidth: { type: "number", minimum: 0, maximum: 4096 } } },
  { type: "object", required: ["schema", "type", "startUs", "durationUs"], additionalProperties: false, properties: { schema: { type: "string", enum: ["shellx-motion/relation-action-layer-prototype@1"] }, type: { type: "string", enum: ["group"] }, startUs: US, durationUs: { ...US, minimum: 1 }, name: { type: "string", maxLength: 256 }, visible: { type: "boolean" }, transform: TRANSFORM } },
] };
const ENDPOINT: MotionDebugArgPropertySchema = { type: "object", required: ["layer", "anchorX", "anchorY"], additionalProperties: false, properties: { layer: LAYER_REF, anchorX: NUMBER_VALUE, anchorY: NUMBER_VALUE } };
const RELATION: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], additionalProperties: false, properties: { id: ID, enabled: { type: "boolean" }, kind: { type: "string", enum: ["attach"] }, source: ENDPOINT, target: ENDPOINT, startUs: US, durationUs: NUMBER_VALUE, mode: { type: "string", enum: ["follow", "similarity"] }, offset: { type: "object", required: ["space", "x", "y", "rotationDeg", "scale"], additionalProperties: false, properties: { space: { type: "string", enum: ["source", "world"] }, x: NUMBER_VALUE, y: NUMBER_VALUE, rotationDeg: NUMBER_VALUE, scale: NUMBER_VALUE } } } },
  { type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], additionalProperties: false, properties: { id: ID, enabled: { type: "boolean" }, kind: { type: "string", enum: ["aim"] }, source: ENDPOINT, target: ENDPOINT, startUs: US, durationUs: NUMBER_VALUE, rotationOffsetDeg: NUMBER_VALUE } },
] };
const DEFINITION: MotionDebugArgPropertySchema = { type: "object", description: "One closed persisted relation-actions@2 definition; Core validates all exact branch and aggregate caps.", required: ["id", "roles", "parameters", "templateLayers", "relationTemplates", "sequence"], additionalProperties: false, properties: {
  id: ID,
  roles: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_ROLES, items: { type: "object", oneOf: [
    { type: "object", required: ["id", "kind"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["group"] } } },
    { type: "object", required: ["id", "kind", "layerTypes"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["layer"] }, layerTypes: { type: "array", minItems: 1, maxItems: MOTION_RELATION_ACTION_ROLE_LAYER_TYPES.length, items: { type: "string", enum: [...MOTION_RELATION_ACTION_ROLE_LAYER_TYPES] } } } },
  ] } },
  parameters: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_PARAMETERS, items: { type: "object", oneOf: [
    { type: "object", required: ["id", "type", "minimum", "maximum", "defaultValue"], additionalProperties: false, properties: { id: ID, type: { type: "string", enum: ["number"] }, minimum: { type: "number", minimum: -3_600_000_000, maximum: 3_600_000_000 }, maximum: { type: "number", minimum: -3_600_000_000, maximum: 3_600_000_000 }, defaultValue: { type: "number", minimum: -3_600_000_000, maximum: 3_600_000_000 } } },
    { type: "object", required: ["id", "type", "defaultValue"], additionalProperties: false, properties: { id: ID, type: { type: "string", enum: ["color"] }, defaultValue: COLOR } },
  ] } },
  templateLayers: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS, items: { type: "object", required: ["id", "layer"], additionalProperties: false, properties: { id: ID, layer: LAYER, parent: LAYER_REF } } },
  relationTemplates: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES, items: RELATION },
  sequence: { type: "array", maxItems: MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS, items: { type: "object", oneOf: [
    { type: "object", required: ["id", "kind", "atUs", "target", "property", "value"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["keyframe"] }, atUs: US, target: LAYER_REF, property: { type: "string", enum: ["transform.x", "transform.y", "transform.width", "transform.height", "transform.originX", "transform.originY", "transform.scale", "transform.rotation", "opacity", "pathReveal.start", "pathReveal.end", "gradient.angle", "fill", "style.fill", "style.color", "style.stroke", "style.borderColor", "style.backgroundColor", "style.background", "style.shadow.color", "style.textShadow.color", "effects.glow.color"] }, value: { type: "object", oneOf: [NUMBER_VALUE, COLOR_VALUE] }, easing: { type: "string", enum: ["linear", "ease-in", "ease-out", "ease-in-out"] } } },
    { type: "object", required: ["id", "kind", "atUs", "target", "presetId", "durationUs"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["transition"] }, atUs: US, target: LAYER_REF, presetId: { type: "string", enum: ["soft-fade", "slide-cover", "wipe-accent", "card-stack", "push-zoom", "scan-sweep", "split-reveal"] }, durationUs: NUMBER_VALUE } },
    { type: "object", required: ["id", "kind", "atUs", "relationTemplateId"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["relation"] }, atUs: US, relationTemplateId: ID } },
  ] } },
} };
const APPLY_REQUEST: MotionDebugArgPropertySchema = { type: "object", description: "Ephemeral exact-base Core materialization request; never persisted as instance data.", required: ["definitionId", "expectedMotionSha256", "expectedStoreSha256", "expectedDefinitionSha256", "instanceId", "startAtUs", "roleBindings"], additionalProperties: false, properties: {
  definitionId: ID, expectedMotionSha256: SHA256, expectedStoreSha256: SHA256, expectedDefinitionSha256: SHA256, instanceId: ID, startAtUs: US,
  roleBindings: { type: "object", additionalProperties: true, maxProperties: MAX_MOTION_RELATION_ACTION_ROLES, description: "Closed by the selected persisted definition; at most 16 role ids." },
  parameterValues: { type: "object", additionalProperties: true, maxProperties: MAX_MOTION_RELATION_ACTION_PARAMETERS, description: "Closed by the selected persisted definition; at most 16 parameter ids." },
} };

export const TIMELINE_RELATION_ACTION_COMMAND_METADATA = {
  "motion.timeline.relation-actions.inspect": { argsSchema: argsSchema(["packageRoot"], PACKAGE_ROOT) },
  "motion.timeline.relation-actions.upsert": mutation("timeline.relation-actions.upsert", ["definition"], { definition: DEFINITION }),
  "motion.timeline.relation-actions.remove": mutation("timeline.relation-actions.remove", ["id"], { id: ID }),
  "motion.timeline.relation-actions.apply": mutation("timeline.relation-actions.apply", ["expectedPackageId", "expectedPackageManifestSha256", "request"], { expectedPackageId: ID, expectedPackageManifestSha256: SHA256, request: APPLY_REQUEST }),
} satisfies MotionDebugCommandMetadata;

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(["packageRoot", "outDir", ...required], { ...EDIT, ...properties }), expectedReceipts: editReceipt(operation) };
}
