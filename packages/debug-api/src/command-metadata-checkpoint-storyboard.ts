/** Generated Debug/MCP contracts for host-owned C6C B1 immutable records. */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema } from "./command-metadata-shared.js";
import { DATA_RECIPE_CHOREOGRAPHY_DESCRIPTOR, DATA_RECIPE_DESCRIPTOR } from "./command-metadata-checkpoint-storyboard-data-recipe.js";
import { CHECKPOINT_STORYBOARD_RETAINED_TRACE_REVIEW_COMMAND_METADATA } from "./command-metadata-checkpoint-storyboard-retained-trace-review.js";
const ID = { type: "string" as const, minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", description: "Safe stable C6 identifier; runtime requires `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`." };
const PROPERTY = { type: "string" as const, enum: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"], description: "C6 property in fixed canonical order." };
const SCALAR_PROPERTY = { type: "string" as const, enum: ["transform.rotation", "transform.scale", "opacity"], description: "B1 scalar property in fixed canonical order." };
const IDENTITY: MotionDebugArgPropertySchema = {
  type: "object", required: ["id", "sha256", "revision"], additionalProperties: false,
  description: "Closed exact host-sealed checkpoint storyboard record identity; loose ids and names are refused.",
  properties: {
    id: { type: "string", minLength: 54, maxLength: 54, pattern: "^checkpoint_storyboard_[a-f0-9]{32}$", description: "Exact host-sealed checkpoint storyboard record id." },
    sha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$", description: "Exact host-sealed checkpoint storyboard content hash." },
    revision: { type: "number", minimum: 1, maximum: 1_000_000, multipleOf: 1, description: "Exact host-sealed record revision." },
  },
};
const PREVIEW_TARGET: MotionDebugArgPropertySchema = {
  type: "object", oneOf: [
    { type: "object", required: ["kind", "checkpointId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["checkpoint"] }, checkpointId: ID } },
    { type: "object", required: ["kind", "atMs"], additionalProperties: false, properties: { kind: { type: "string", enum: ["time"] }, atMs: { type: "number", minimum: 0, maximum: 9_007_199_254_740_991, multipleOf: 1, description: "Safe-integer milliseconds; runtime also requires it fall inside the reopened materialized package duration." } } },
  ],
  description: "Closed target union. Checkpoint times must seal to whole milliseconds. B1d accepts whole-millisecond checkpoint and time targets in [0, duration]. The exact terminal duration D is a background-only terminal-boundary sample: all layers remain excluded with no hold or final-state claim. This command accepts no package, output, workflow, network, lane, or playhead fields.",
};
const CREATIVE_REVIEW_HANDLE: MotionDebugArgPropertySchema = { type: "string", minLength: 77, maxLength: 77, pattern: "^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$", description: "Exact opaque host-minted creative-review handle. It selects no caller-supplied brief, plan, ledger, run, approval, reviewer, shot, or authentication data." };
const ENDPOINT_WITNESS_HANDLE: MotionDebugArgPropertySchema = { type: "string", minLength: 78, maxLength: 78, pattern: "^checkpoint_storyboard_endpoint_witness_handle_[a-f0-9]{32}$", description: "Exact opaque host-minted terminal endpoint witness. It selects no caller-supplied endpoint, record, creative record, preview, renderer, or pixel data." };
const PREVIEW_PAIR: MotionDebugArgPropertySchema = { type: "object", description: "Exact paired opaque handles for one complete B1b v2 receipt-first PNG preview.", required: ["previewHandle", "receiptHandle"], additionalProperties: false, properties: { previewHandle: { type: "string", minLength: 62, maxLength: 62, pattern: "^checkpoint_storyboard_preview_[a-f0-9]{32}$", description: "Exact opaque complete B1b PNG handle." }, receiptHandle: { type: "string", minLength: 70, maxLength: 70, pattern: "^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$", description: "Exact opaque complete B1b receipt handle." } } };
const QUALITY_REVIEW: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["kind", "creativeReviewHandle"], additionalProperties: false, properties: { kind: { type: "string", enum: ["interior"] }, creativeReviewHandle: CREATIVE_REVIEW_HANDLE } },
  { type: "object", required: ["kind", "endpointWitnessHandle"], additionalProperties: false, properties: { kind: { type: "string", enum: ["terminal-endpoint"] }, endpointWitnessHandle: ENDPOINT_WITNESS_HANDLE } },
], description: "Closed quality-association union. `interior` reopens one durable end-exclusive B1c association. `terminal-endpoint` requires a separate host-only witness at exact D and carries no visible-final-state, held-content, human pixel review, final-media, or final-acceptance claim." };
const B1_DESCRIPTOR: MotionDebugArgPropertySchema = {
  type: "object",
  required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false,
  properties: {
    seed: { type: "number", minimum: 0, maximum: 4_294_967_295, description: "Safe-integer deterministic C6A seed." },
    capabilityRequirements: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["renderer.browser", "renderer.native"] }, description: "Strict code-unit ascending B1 renderer capability requirements." },
    objectCatalog: { type: "array", minItems: 1, maxItems: 64, items: objectCatalog() },
    checkpoints: { type: "array", minItems: 2, maxItems: 16, items: checkpoint() },
    edges: { type: "array", minItems: 1, maxItems: 64, items: edge() },
    recipes: { type: "array", maxItems: 64, items: recipe() },
  },
  description: "Closed unsealed C6A B1 descriptor. It excludes id, sha256, revision, and parent; the host seals identity only after shared C6B1 static-profile admission.",
};

function objectCatalog(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["objectId", "rootShapeKind", "propertyMask"], additionalProperties: false, properties: {
    objectId: ID,
    rootShapeKind: { type: "string", enum: ["rect", "ellipse"], description: "B1 accepts existing root rect or ellipse only." },
    propertyMask: { type: "array", minItems: 1, maxItems: 5, items: PROPERTY, description: "Strict canonical property mask; runtime validates correspondence and order." },
  } };
}
function checkpoint(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["id", "atUs", "objects"], additionalProperties: false, properties: {
    id: ID,
    atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, description: "Safe-integer exact microseconds. B1 requires whole milliseconds, begins at zero, and binds final duration only during later exact-base materialization." },
    objects: { type: "array", minItems: 1, maxItems: 64, items: objectState() },
  } };
}
function objectState(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["objectId", "state", "properties"], additionalProperties: false, properties: {
    objectId: ID,
    state: { type: "string", enum: ["present"], description: "B1 excludes absent/create/remove lifecycle." },
    properties: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", required: ["property", "value"], additionalProperties: false, properties: {
      property: PROPERTY,
      value: { type: "number", description: "Finite C6 property value; Core owns per-property bounds." },
    } } },
  } };
}
function edge(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], additionalProperties: false, properties: {
    id: ID,
    fromCheckpointId: ID,
    toCheckpointId: ID,
    lifecycle: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", required: ["kind", "objectId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["preserve"] }, objectId: ID } }, description: "Complete B1 preserve-only lifecycle map in catalog order." },
    recipeIds: { type: "array", maxItems: 64, items: ID, description: "Strict ascending, edge-unique recipe ids." },
  } };
}
function recipe(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["recipeId", "seed", "intent", "exactBaseRequirements"], additionalProperties: false, properties: {
    recipeId: ID,
    seed: { type: "number", minimum: 0, maximum: 4_294_967_295, description: "Safe-integer deterministic recipe seed." },
    exactBaseRequirements: { type: "array", maxItems: 0, items: { type: "object", properties: {}, additionalProperties: false }, description: "B1 rejects deferred relation-action dependencies." },
    intent: { type: "object", oneOf: [keyframeIntent(), spatialIntent()] },
  } };
}
function keyframeIntent(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["kind", "targets", "easing"], additionalProperties: false, properties: {
    kind: { type: "string", enum: ["checkpoint-keyframe"] },
    easing: { type: "string", enum: ["linear", "ease-in", "ease-out", "ease-in-out"] },
    targets: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", required: ["objectId", "propertyMask"], additionalProperties: false, properties: { objectId: ID, propertyMask: { type: "array", minItems: 1, maxItems: 3, items: SCALAR_PROPERTY } } } },
  } };
}
function spatialIntent(): MotionDebugArgPropertySchema {
  return { type: "object", required: ["kind", "targets"], additionalProperties: false, properties: {
    kind: { type: "string", enum: ["checkpoint-spatial-path"] },
    targets: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", required: ["objectId", "tangentMode"], additionalProperties: false, properties: { objectId: ID, tangentMode: { type: "string", enum: ["linear", "auto"] } } } },
  } };
}
const B2_PROPERTY: MotionDebugArgPropertySchema = { type: "string", enum: ["transform.x", "transform.y"] };
const B2_STATE: MotionDebugArgPropertySchema = { type: "object", required: ["objectId", "state", "properties"], additionalProperties: false, properties: {
  objectId: ID, state: { type: "string", enum: ["present"] }, properties: { type: "array", minItems: 1, maxItems: 2, items: { type: "object", required: ["property", "value"], additionalProperties: false, properties: { property: B2_PROPERTY, value: { type: "number" } } } },
} };
const B2_CHECKPOINT: MotionDebugArgPropertySchema = { type: "object", required: ["id", "atUs", "objects"], additionalProperties: false, properties: {
  id: ID, atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1 }, objects: { type: "array", minItems: 1, maxItems: 1, items: B2_STATE },
} };
const B2_BEHAVIOR: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["kind", "velocityX", "velocityY", "gravityY"], additionalProperties: false, properties: { kind: { type: "string", enum: ["gravity"] }, velocityX: { type: "number" }, velocityY: { type: "number" }, gravityY: { type: "number" } } },
  { type: "object", required: ["kind", "floorY", "velocityY", "gravityY", "restitution"], additionalProperties: false, properties: { kind: { type: "string", enum: ["bounce"] }, floorY: { type: "number" }, velocityY: { type: "number" }, gravityY: { type: "number" }, restitution: { type: "number" } } },
] };
const B2_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false, properties: {
  seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 }, capabilityRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["renderer.gpu"] }, description: "C6B2 accepts exactly renderer.gpu." },
  objectCatalog: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["objectId", "rootShapeKind", "propertyMask"], additionalProperties: false, properties: { objectId: ID, rootShapeKind: { type: "string", enum: ["rect", "ellipse"] }, propertyMask: { type: "array", minItems: 1, maxItems: 2, items: B2_PROPERTY } } } },
  checkpoints: { type: "array", minItems: 2, maxItems: 2, items: B2_CHECKPOINT },
  edges: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], additionalProperties: false, properties: { id: ID, fromCheckpointId: ID, toCheckpointId: ID, lifecycle: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["kind", "objectId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["preserve"] }, objectId: ID } } }, recipeIds: { type: "array", minItems: 1, maxItems: 1, items: ID } } } },
  recipes: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["recipeId", "seed", "intent", "exactBaseRequirements"], additionalProperties: false, properties: { recipeId: ID, seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 }, exactBaseRequirements: { type: "array", maxItems: 0 }, intent: { type: "object", required: ["kind", "targetObjectId", "behavior"], additionalProperties: false, properties: { kind: { type: "string", enum: ["transform-behavior"] }, targetObjectId: ID, behavior: B2_BEHAVIOR } } } } },
}, description: "Closed C6B2 behavior descriptor. It has one GPU rect/ellipse root, two present checkpoints, one preserve edge, and one gravity or bounce transform-behavior recipe. Package/document endpoint facts are resolver-only." };
const B3_PROPERTY: MotionDebugArgPropertySchema = { type: "string", enum: ["transform.x", "transform.y"] };
const B3_STATE: MotionDebugArgPropertySchema = { type: "object", required: ["objectId", "state", "properties"], additionalProperties: false, properties: { objectId: ID, state: { type: "string", enum: ["present"] }, properties: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["property", "value"], additionalProperties: false, properties: { property: B3_PROPERTY, value: { type: "number" } } } } } };
const B3_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false, properties: {
  seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
  capabilityRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["renderer.gpu"] } },
  objectCatalog: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["objectId", "rootShapeKind", "propertyMask"], additionalProperties: false, properties: { objectId: ID, rootShapeKind: { type: "string", enum: ["rect", "ellipse"] }, propertyMask: { type: "array", minItems: 2, maxItems: 2, items: B3_PROPERTY } } } },
  checkpoints: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["id", "atUs", "objects"], additionalProperties: false, properties: { id: ID, atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1 }, objects: { type: "array", minItems: 2, maxItems: 2, items: B3_STATE } } } },
  edges: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], additionalProperties: false, properties: { id: ID, fromCheckpointId: ID, toCheckpointId: ID, lifecycle: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["kind", "objectId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["preserve"] }, objectId: ID } } }, recipeIds: { type: "array", minItems: 1, maxItems: 1, items: ID } } } },
  recipes: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["recipeId", "seed", "intent", "exactBaseRequirements"], additionalProperties: false, properties: {
    recipeId: ID, seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 }, exactBaseRequirements: { type: "array", maxItems: 0 },
    intent: { type: "object", required: ["kind", "relationKind", "sourceObjectId", "targetObjectId", "sourceAnchor", "targetAnchor", "offset"], additionalProperties: false, properties: {
      kind: { type: "string", enum: ["relation"] }, relationKind: { type: "string", enum: ["follow"] }, sourceObjectId: ID, targetObjectId: ID,
      sourceAnchor: { type: "object", required: ["x", "y"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" } } },
      targetAnchor: { type: "object", required: ["x", "y"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" } } },
      offset: { type: "object", required: ["space", "x", "y", "rotationDeg", "scale"], additionalProperties: false, properties: { space: { type: "string", enum: ["world"] }, x: { type: "number" }, y: { type: "number" }, rotationDeg: { type: "number", minimum: 0, maximum: 0 }, scale: { type: "number", minimum: 1, maximum: 1 } } },
    } },
  } } },
}, description: "Closed C6B3 relation descriptor. It seals two GPU rect/ellipse roots, catalog-order preserve lifecycle, and one world-space target-only follow relation. Exact package duration, layers, output, receipt, and renderer facts are resolver-only." };
const B4_ACTION_INTENT: MotionDebugArgPropertySchema = { type: "object", required: ["kind", "roleBindings", "parameterValues", "declaredWrites"], additionalProperties: false, properties: {
  kind: { type: "string", enum: ["relation-action"] },
  roleBindings: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["roleId", "objectId"], additionalProperties: false, properties: { roleId: ID, objectId: ID } } },
  parameterValues: { type: "array", maxItems: 0 },
  declaredWrites: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["objectId", "propertyMask"], additionalProperties: false, properties: { objectId: ID, propertyMask: { type: "array", minItems: 2, maxItems: 2, items: B3_PROPERTY } } } },
} };
const B4_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false, properties: {
  seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
  capabilityRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["renderer.gpu"] } },
  objectCatalog: B3_DESCRIPTOR.properties!.objectCatalog!, checkpoints: B3_DESCRIPTOR.properties!.checkpoints!, edges: B3_DESCRIPTOR.properties!.edges!,
  recipes: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["recipeId", "seed", "intent", "exactBaseRequirements"], additionalProperties: false, properties: {
    recipeId: ID, seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 }, intent: B4_ACTION_INTENT,
    exactBaseRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["resolution", "definitionId", "definitionSha256"], additionalProperties: false, properties: { resolution: { type: "string", enum: ["deferred-exact-base"] }, definitionId: ID, definitionSha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" } } } },
  } } },
}, description: "Closed C6B4 relation-action descriptor. It seals two GPU rect/ellipse roots, catalog-order preserve lifecycle, one exact deferred action definition, and two x/y relation-action role bindings. Exact package, action store, output, receipt, and renderer facts are resolver-only." };
const B5_PROPERTY: MotionDebugArgPropertySchema = { type: "string", enum: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] };
const B5_CREATION: MotionDebugArgPropertySchema = { type: "object", required: ["schema", "fill", "width", "height"], additionalProperties: false, properties: {
  schema: { type: "string", enum: ["shellx-motion/private-checkpoint-storyboard-shape-creation@1"] },
  fill: { type: "string", minLength: 7, maxLength: 7, pattern: "^#[0-9a-f]{6}$" },
  width: { type: "number", minimum: 1, maximum: 1_000_000 },
  height: { type: "number", minimum: 1, maximum: 1_000_000 },
} };
const B5_PRESENT_STATE: MotionDebugArgPropertySchema = { type: "object", required: ["objectId", "state", "properties"], additionalProperties: false, properties: {
  objectId: ID,
  state: { type: "string", enum: ["present"] },
  properties: { type: "array", minItems: 5, maxItems: 5, items: { type: "object", required: ["property", "value"], additionalProperties: false, properties: { property: B5_PROPERTY, value: { type: "number" } } } },
} };
const B5_ABSENT_STATE: MotionDebugArgPropertySchema = { type: "object", required: ["objectId", "state", "properties"], additionalProperties: false, properties: {
  objectId: ID,
  state: { type: "string", enum: ["absent"] },
  properties: { type: "array", maxItems: 0 },
} };
const B5_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false, properties: {
  seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
  capabilityRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["renderer.browser", "renderer.native"] } },
  objectCatalog: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", required: ["objectId", "rootShapeKind", "propertyMask", "creation"], additionalProperties: false, properties: { objectId: ID, rootShapeKind: { type: "string", enum: ["rect", "ellipse"] }, propertyMask: { type: "array", minItems: 5, maxItems: 5, items: B5_PROPERTY }, creation: B5_CREATION } } },
  checkpoints: { type: "array", minItems: 2, maxItems: 16, items: { type: "object", required: ["id", "atUs", "objects"], additionalProperties: false, properties: { id: ID, atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1_000 }, objects: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", oneOf: [B5_ABSENT_STATE, B5_PRESENT_STATE] } } } } },
  edges: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", required: ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], additionalProperties: false, properties: { id: ID, fromCheckpointId: ID, toCheckpointId: ID, lifecycle: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", required: ["kind", "objectId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["preserve", "create", "remove"] }, objectId: ID } } }, recipeIds: { type: "array", maxItems: 0 } } } },
  recipes: { type: "array", maxItems: 0 },
}, description: "Closed C6B5 lifecycle descriptor. It seals browser/native rect or ellipse creation roots, whole-millisecond absent-create-present-optional-remove lifecycle, exact canonical property masks, and no recipes. Exact package, workspace, output, receipt, and authority facts are resolver-only." };
const B6_POINT: MotionDebugArgPropertySchema = { type: "object", required: ["x", "y"], additionalProperties: false, properties: {
  x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
} };
const B6_GEOMETRY: MotionDebugArgPropertySchema = { type: "object", required: ["schema", "kind", "viewBox", "points"], additionalProperties: false, properties: {
  schema: { type: "string", enum: ["shellx-motion/shape-geometry@1"] }, kind: { type: "string", enum: ["polygon"] },
  viewBox: { type: "object", required: ["x", "y", "width", "height"], additionalProperties: false, properties: {
    x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }, y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
    width: { type: "number", exclusiveMinimum: 0, maximum: 2_000_000 }, height: { type: "number", exclusiveMinimum: 0, maximum: 2_000_000 },
  } },
  points: { type: "array", minItems: 3, maxItems: 3, items: B6_POINT },
}, description: "Exact v1 three-point polygon snapshot; Core additionally requires identical endpoint view boxes, ordinal topology, positive area, and invariant orientation." };
const B6_STATE: MotionDebugArgPropertySchema = { type: "object", required: ["objectId", "state", "properties", "geometry"], additionalProperties: false, properties: {
  objectId: ID, state: { type: "string", enum: ["present"] }, properties: { type: "array", maxItems: 0 }, geometry: B6_GEOMETRY,
} };
const B6_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false, properties: {
  seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
  capabilityRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["renderer.gpu"] } },
  objectCatalog: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["objectId", "rootShapeKind", "propertyMask"], additionalProperties: false, properties: { objectId: ID, rootShapeKind: { type: "string", enum: ["geometry"] }, propertyMask: { type: "array", maxItems: 0 } } } },
  checkpoints: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["id", "atUs", "objects"], additionalProperties: false, properties: { id: ID, atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1_000 }, objects: { type: "array", minItems: 1, maxItems: 1, items: B6_STATE } } } },
  edges: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], additionalProperties: false, properties: { id: ID, fromCheckpointId: ID, toCheckpointId: ID, lifecycle: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["kind", "objectId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["preserve"] }, objectId: ID } } }, recipeIds: { type: "array", minItems: 1, maxItems: 1, items: ID } } } },
  recipes: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["recipeId", "seed", "intent", "exactBaseRequirements"], additionalProperties: false, properties: {
    recipeId: ID, seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 }, exactBaseRequirements: { type: "array", maxItems: 0 },
    intent: { type: "object", required: ["kind", "targets"], additionalProperties: false, properties: { kind: { type: "string", enum: ["checkpoint-geometry-morph"] }, targets: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["objectId", "easing"], additionalProperties: false, properties: { objectId: ID, easing: { type: "string", enum: ["linear"] } } } } } },
  } } },
}, description: "Closed C6B6 geometry-morph descriptor. It seals one GPU geometry root, two whole-millisecond present triangle snapshots, one preserve edge, and one linear same-object morph recipe. Exact package, output, receipt, topology, area-proof, and renderer facts are resolver-only." };
const B7_GRAPH_NODE: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["id", "kind"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["time-us"] } } },
  { type: "object", required: ["id", "kind", "value"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["constant"] }, value: { type: "number", minimum: -1_000_000, maximum: 1_000_000 } } },
  { type: "object", required: ["id", "kind", "left", "right"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["add", "multiply"] }, left: ID, right: ID } },
  { type: "object", required: ["id", "kind", "input"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["sin", "cos"] }, input: ID } },
  { type: "object", required: ["id", "kind", "input", "min", "max"], additionalProperties: false, properties: { id: ID, kind: { type: "string", enum: ["clamp"] }, input: ID, min: ID, max: ID } },
] };
function b7ConstantSignal(minimum: number, maximum: number, positive = false): MotionDebugArgPropertySchema {
  const value = positive ? { type: "number" as const, exclusiveMinimum: minimum, maximum } : { type: "number" as const, minimum, maximum };
  return { type: "object", required: ["source", "from", "to"], additionalProperties: false, properties: {
    source: { type: "string", enum: ["constant"] }, from: value, to: value,
  }, description: "Closed constant signal; runtime additionally requires identical from and to values." };
}
const B7_CAP: MotionDebugArgPropertySchema = { type: "object", required: ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"], additionalProperties: false, properties: {
  maxSamples: { type: "number", minimum: 64, maximum: 64, multipleOf: 1 }, maxVertices: { type: "number", minimum: 64, maximum: 64, multipleOf: 1 }, maxWorkUnits: { type: "number", minimum: 16_384, maximum: 16_384, multipleOf: 1 }, maxBytes: { type: "number", minimum: 131_072, maximum: 131_072, multipleOf: 1 },
} };
const B7_TRACE: MotionDebugArgPropertySchema = { type: "object", required: ["schema", "clip", "drawers", "caps"], additionalProperties: false, properties: {
  schema: { type: "string", enum: ["shellx-motion/private-parametric-trace@1"] },
  clip: { type: "object", required: ["durationUs", "sampleIntervalUs"], additionalProperties: false, properties: {
    durationUs: { type: "number", minimum: 1, maximum: 3_600_000_000, multipleOf: 1 }, sampleIntervalUs: { type: "number", minimum: 1, maximum: 3_600_000_000, multipleOf: 1 },
  } },
  drawers: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["id", "driver", "retention", "output"], additionalProperties: false, properties: {
    id: ID,
    driver: { type: "object", required: ["kind", "graph"], additionalProperties: false, properties: {
      kind: { type: "string", enum: ["parametric-graph"] }, graph: { type: "object", required: ["nodes", "output"], additionalProperties: false, properties: {
        nodes: { type: "array", minItems: 1, maxItems: 64, items: B7_GRAPH_NODE }, output: { type: "object", required: ["x", "y", "z"], additionalProperties: false, properties: { x: ID, y: ID, z: ID } },
      } },
    } },
    retention: { type: "object", required: ["kind", "maxSamples"], additionalProperties: false, properties: { kind: { type: "string", enum: ["full-clip"] }, maxSamples: { type: "number", minimum: 2, maximum: 64, multipleOf: 1 } } },
    output: { type: "object", required: ["mode", "width", "colour", "opacity", "speedLimit"], additionalProperties: false, properties: {
      mode: { type: "string", enum: ["line"] }, width: b7ConstantSignal(0, 1_000_000, true), colour: b7ConstantSignal(0, 1), opacity: b7ConstantSignal(0, 1, true), speedLimit: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
    } },
  } } },
  caps: { type: "object", required: ["perDrawer", "aggregate"], additionalProperties: false, properties: { perDrawer: B7_CAP, aggregate: B7_CAP } },
} };
const B7_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], additionalProperties: false, properties: {
  seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
  capabilityRequirements: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["renderer.gpu"] } },
  objectCatalog: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["objectId", "rootShapeKind", "propertyMask"], additionalProperties: false, properties: { objectId: ID, rootShapeKind: { type: "string", enum: ["rect"] }, propertyMask: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["opacity"] } } } } },
  checkpoints: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["id", "atUs", "objects"], additionalProperties: false, properties: {
    id: ID, atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1 }, objects: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["objectId", "state", "properties"], additionalProperties: false, properties: {
      objectId: ID, state: { type: "string", enum: ["present"] }, properties: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["property", "value"], additionalProperties: false, properties: { property: { type: "string", enum: ["opacity"] }, value: { type: "number", minimum: 0, maximum: 1 } } } },
    } } },
  } } },
  edges: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], additionalProperties: false, properties: {
    id: ID, fromCheckpointId: ID, toCheckpointId: ID, lifecycle: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["kind", "objectId"], additionalProperties: false, properties: { kind: { type: "string", enum: ["preserve"] }, objectId: ID } } }, recipeIds: { type: "array", minItems: 1, maxItems: 1, items: ID },
  } } },
  recipes: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["recipeId", "seed", "intent", "exactBaseRequirements"], additionalProperties: false, properties: {
    recipeId: ID, seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 }, exactBaseRequirements: { type: "array", maxItems: 0 }, intent: { type: "object", required: ["kind", "outputObjectId", "trace"], additionalProperties: false, properties: { kind: { type: "string", enum: ["parametric-trace"] }, outputObjectId: ID, trace: B7_TRACE } },
  } } },
}, description: "Closed C6B7 retained-trace descriptor. Core seals one GPU rect/opacity object, two present endpoints, one preserve edge, and one bounded parametric-trace recipe; package, COW, sidecar, receipt, renderer, and GPU execution authority remain resolver-only." };
const DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", oneOf: [B1_DESCRIPTOR, B2_DESCRIPTOR, B3_DESCRIPTOR, B4_DESCRIPTOR, B5_DESCRIPTOR, B6_DESCRIPTOR, B7_DESCRIPTOR, DATA_RECIPE_DESCRIPTOR, DATA_RECIPE_CHOREOGRAPHY_DESCRIPTOR], description: "Closed C6C record profile union through retained-trace B7 plus the C6D trace and choreography data-recipe lowerers. A lineage cannot switch profile on revision." };
export const CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA = {
  "motion.timeline.checkpoint-storyboard.create": {
    argsSchema: argsSchema(["descriptor"], { descriptor: DESCRIPTOR }),
    expectedReceipts: mutationEvidence("timeline.checkpoint-storyboard.create"),
  },
  "motion.timeline.checkpoint-storyboard.inspect": {
    argsSchema: argsSchema(["identity"], { identity: IDENTITY }),
  },
  "motion.timeline.checkpoint-storyboard.revise": {
    argsSchema: argsSchema(["parent", "descriptor"], { parent: { ...IDENTITY, description: "Exact active host-sealed parent identity to reopen; the host injects it into the new sealed revision." }, descriptor: DESCRIPTOR }),
    expectedReceipts: mutationEvidence("timeline.checkpoint-storyboard.revise"),
  },
  "motion.timeline.checkpoint-storyboard.remove": {
    argsSchema: argsSchema(["identity"], { identity: IDENTITY }),
    expectedReceipts: mutationEvidence("timeline.checkpoint-storyboard.remove"),
  },
  "motion.timeline.checkpoint-storyboard.archive": {
    argsSchema: argsSchema(["identity"], { identity: IDENTITY }),
    expectedReceipts: mutationEvidence("timeline.checkpoint-storyboard.archive"),
  },
  "motion.timeline.checkpoint-storyboard.materialize": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact host-sealed storyboard identity. The host alone selects source, workspace, output, and private C6B bindings." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.materialize", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_materialization_binding", "checkpoint_storyboard_c6b_receipt", "checkpoint_storyboard_materialized_package_identity"] }],
  },
  "motion.timeline.checkpoint-storyboard.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact host-sealed storyboard identity. Detach only retires a verified durable binding; it never deletes its package." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_materialization_detach", "checkpoint_storyboard_materialization_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.behavior.resolve": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B2 behavior-record identity. This Debug/MCP-only command accepts no package, workspace, output, receipt, approval, renderer, object, layer, or authority field." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.behavior.resolve", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_behavior_resolution_binding", "checkpoint_storyboard_behavior_output_handle", "checkpoint_storyboard_behavior_receipt_fingerprint"] }],
  },
  "motion.timeline.checkpoint-storyboard.behavior.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B2 behavior-record identity. Detach retires only the durable behavior-resolution link; it never deletes the installed output and accepts no host authority data." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.behavior.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_behavior_resolution_detach", "checkpoint_storyboard_behavior_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.relation.resolve": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B3 relation-record identity. This Debug/MCP-only command accepts no package, workspace, output, receipt, approval, renderer, object, layer, or authority field." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.relation.resolve", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_relation_resolution_binding", "checkpoint_storyboard_relation_output_handle", "checkpoint_storyboard_relation_receipt_fingerprint"] }],
  },
  "motion.timeline.checkpoint-storyboard.relation.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B3 relation-record identity. Detach retires only the durable relation-resolution link; it never deletes the installed output and accepts no host authority data." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.relation.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_relation_resolution_detach", "checkpoint_storyboard_relation_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.relation-action.resolve": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B4 relation-action record identity. This Debug/MCP-only command accepts no package, workspace, output, receipt, approval, renderer, object, layer, action, or authority field." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.relation-action.resolve", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_relation_action_resolution_binding", "checkpoint_storyboard_relation_action_output_handle", "checkpoint_storyboard_relation_action_receipt_fingerprint"] }],
  },
  "motion.timeline.checkpoint-storyboard.relation-action.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B4 relation-action record identity. Detach retires only the durable relation-action-resolution link; it never deletes the installed output and accepts no host authority data." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.relation-action.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_relation_action_resolution_detach", "checkpoint_storyboard_relation_action_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.lifecycle.resolve": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B5 lifecycle-record identity. This Debug/MCP-only command accepts no package, workspace, output, receipt, approval, renderer, object, layer, or authority field." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.lifecycle.resolve", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_lifecycle_resolution_binding", "checkpoint_storyboard_lifecycle_output_handle", "checkpoint_storyboard_lifecycle_receipt_fingerprint"] }],
  },
  "motion.timeline.checkpoint-storyboard.lifecycle.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B5 lifecycle-record identity. Detach retires only the durable lifecycle-resolution link; it never deletes the installed output and accepts no host authority data." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.lifecycle.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_lifecycle_resolution_detach", "checkpoint_storyboard_lifecycle_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.geometry-morph.resolve": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B6 geometry-morph record identity. This Debug/MCP-only command accepts no package, workspace, output, receipt, approval, renderer, object, layer, geometry, or authority field." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.geometry-morph.resolve", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_geometry_morph_resolution_binding", "checkpoint_storyboard_geometry_morph_output_handle", "checkpoint_storyboard_geometry_morph_receipt_fingerprint"] }],
  },
  "motion.timeline.checkpoint-storyboard.geometry-morph.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B6 geometry-morph record identity. Detach retires only the durable geometry-morph-resolution link; it never deletes the installed output and accepts no host authority data." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.geometry-morph.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_geometry_morph_resolution_detach", "checkpoint_storyboard_geometry_morph_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.retained-trace.resolve": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B7 retained-trace record identity. This Debug/MCP-only command accepts no package, workspace, output, sidecar, receipt, approval, renderer, GPU, trace, or authority field." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.retained-trace.resolve", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_retained_trace_resolution_binding", "checkpoint_storyboard_retained_trace_output_handle", "checkpoint_storyboard_retained_trace_receipt_fingerprint"] }],
  },
  "motion.timeline.checkpoint-storyboard.retained-trace.detach": {
    argsSchema: argsSchema(["identity"], { identity: { ...IDENTITY, description: "Exact sealed C6B7 retained-trace record identity. Debug/MCP-only: detach retires only the durable retained-trace-resolution link; it never deletes the installed output and accepts no host authority data." } }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.retained-trace.detach", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_retained_trace_resolution_detach", "checkpoint_storyboard_retained_trace_binding_audit"] }],
  },
  "motion.timeline.checkpoint-storyboard.retained-trace.preview": {
    argsSchema: argsSchema(["identity", "atUs"], {
      identity: { ...IDENTITY, description: "Exact sealed C6B7 retained-trace record identity with one active host-resolved output binding." },
      atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1, description: "Exact integer microsecond in the sealed retained-trace schedule, including the final document sample. This Debug/MCP-only command accepts no path, package, output, sidecar, receipt, plan, trace, lane, renderer, GPU, session, or authority field." },
    }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.retained-trace.preview", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_retained_trace_preview_handle", "checkpoint_storyboard_retained_trace_private_preview_receipt", "checkpoint_storyboard_retained_trace_gpu_png_evidence"] }],
  },
  ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_REVIEW_COMMAND_METADATA,
  "motion.timeline.checkpoint-storyboard.preview": {
    argsSchema: argsSchema(["identity", "target"], { identity: { ...IDENTITY, description: "Exact active host-sealed storyboard identity bound through B1a to the C6B output." }, target: PREVIEW_TARGET }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.preview", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_browser_preview_handle", "checkpoint_storyboard_private_preview_receipt", "checkpoint_storyboard_browser_png_evidence"] }],
  },
  "motion.timeline.checkpoint-storyboard.creative-review.bind": {
    argsSchema: argsSchema(["identity", "preview", "creativeReviewHandle"], { identity: { ...IDENTITY, description: "Exact active nonarchived host-sealed storyboard identity." }, preview: { type: "object", description: "Exact paired opaque handles for one complete B1b receipt-first PNG preview.", required: ["previewHandle", "receiptHandle"], additionalProperties: false, properties: { previewHandle: { type: "string", minLength: 62, maxLength: 62, pattern: "^checkpoint_storyboard_preview_[a-f0-9]{32}$", description: "Exact opaque complete B1b PNG handle." }, receiptHandle: { type: "string", minLength: 70, maxLength: 70, pattern: "^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$", description: "Exact opaque complete B1b receipt handle." } } }, creativeReviewHandle: CREATIVE_REVIEW_HANDLE }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.creative-review.bind", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_private_creative_review_binding", "checkpoint_storyboard_creative_review_association"] }],
  },
  "motion.timeline.checkpoint-storyboard.preview-quality.review": {
    argsSchema: argsSchema(["identity", "preview", "review"], { identity: { ...IDENTITY, description: "Exact active nonarchived host-sealed storyboard identity." }, preview: PREVIEW_PAIR, review: QUALITY_REVIEW }),
    expectedReceipts: [{ operation: "timeline.checkpoint-storyboard.preview-quality.review", mode: "emits", required: true, artifactRoles: ["checkpoint_storyboard_private_preview_quality_receipt", "checkpoint_storyboard_preview_quality_association"] }],
  },
} satisfies MotionDebugCommandMetadata;
function mutationEvidence(operation: string) { return [{ operation, mode: "emits" as const, required: true, artifactRoles: ["checkpoint_storyboard_record", "checkpoint_storyboard_host_operation_evidence"] }]; }
