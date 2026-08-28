/** Closed Debug/MCP schema for the code-owned C6D named data-recipe catalog. */
import type { MotionDebugArgPropertySchema } from "./command-registry.js";
import {
  DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
  DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
  DATA_RECIPE_CHOREOGRAPHY_LIMITS,
  DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
  DATA_RECIPE_CHECKPOINT_ACTION_ID,
  DATA_RECIPE_CHECKPOINT_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_LIMITS,
  DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_SCHEMA,
} from "@shellx-motion/core/internal/checkpoint-storyboard-data-recipe";

const ID: MotionDebugArgPropertySchema = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", description: "Safe stable C6 identifier; runtime requires `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`." };
const UINT32: MotionDebugArgPropertySchema = { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1, description: "Exact uint32 deterministic seed." };
const OPACITY: MotionDebugArgPropertySchema = { type: "number", minimum: 0, maximum: 1, description: "Finite opacity in [0,1]; Core requires the two endpoint values to be exactly equal." };
const CHECKPOINT: MotionDebugArgPropertySchema = { type: "object", required: ["atUs", "state", "opacity"], additionalProperties: false, properties: {
  atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1, description: "Exact safe-integer microseconds. The first checkpoint is exactly 0; the second is positive duration D, and Core requires D divisible by sampleCount - 1." },
  state: { type: "string", enum: ["present"], description: "The sole data-recipe target is explicitly present at both endpoints." },
  opacity: OPACITY,
} };
const LINE_PARAMETERS = {
  centerX: { type: "number", minimum: -1_000_000, maximum: 1_000_000, description: "Finite formula X centre; Core also bounds the complete radial extent." },
  centerY: { type: "number", minimum: -1_000_000, maximum: 1_000_000, description: "Finite formula Y centre; Core also bounds the complete radial extent." },
  sampleCount: { type: "number", minimum: 2, maximum: 64, multipleOf: 1, description: "Exact retained full-clip line sample count." },
  strokeWidth: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000, description: "Finite positive fixed line width." },
  strokeOpacity: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Finite positive fixed line opacity." },
  luma: { type: "number", minimum: 0, maximum: 1, description: "Finite fixed grayscale luma." },
  speedLimit: { type: "number", exclusiveMinimum: 0, maximum: 100_000, description: "Finite positive parametric speed limit." },
} satisfies Record<string, MotionDebugArgPropertySchema>;
const LISSAJOUS_PARAMETERS: MotionDebugArgPropertySchema = { type: "object", required: ["centerX", "centerY", "amplitudeX", "amplitudeY", "frequencyX", "frequencyY", "phaseTurnsQ1024", "sampleCount", "strokeWidth", "strokeOpacity", "luma", "speedLimit"], additionalProperties: false, properties: {
  ...LINE_PARAMETERS,
  amplitudeX: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000, description: "Finite positive Lissajous X amplitude." },
  amplitudeY: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000, description: "Finite positive Lissajous Y amplitude." },
  frequencyX: { type: "number", minimum: 1, maximum: 16, multipleOf: 1, description: "Integer Lissajous X frequency." },
  frequencyY: { type: "number", minimum: 1, maximum: 16, multipleOf: 1, description: "Integer Lissajous Y frequency." },
  phaseTurnsQ1024: { type: "number", minimum: 0, maximum: 1_023, multipleOf: 1, description: "Integer phase in 1/1024 turns." },
} };
const ROSE_PARAMETERS: MotionDebugArgPropertySchema = { type: "object", required: ["centerX", "centerY", "radius", "petals", "rotationTurnsQ1024", "sampleCount", "strokeWidth", "strokeOpacity", "luma", "speedLimit"], additionalProperties: false, properties: {
  ...LINE_PARAMETERS,
  radius: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000, description: "Finite positive rose-curve radius; Core requires each centre plus radius to remain in bounds." },
  petals: { type: "number", minimum: 2, maximum: 16, multipleOf: 1, description: "Integer rose-curve radial frequency." },
  rotationTurnsQ1024: { type: "number", minimum: 0, maximum: 1_023, multipleOf: 1, description: "Integer rose-curve rotation in 1/1024 turns." },
} };
const LIMITS: MotionDebugArgPropertySchema = { type: "object", required: ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"], additionalProperties: false, properties: {
  maxSamples: { type: "number", minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxSamples, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxSamples, multipleOf: 1, description: "Fixed C6B7 maximum sample limit." },
  maxVertices: { type: "number", minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxVertices, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxVertices, multipleOf: 1, description: "Fixed C6B7 maximum vertex limit." },
  maxWorkUnits: { type: "number", minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxWorkUnits, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxWorkUnits, multipleOf: 1, description: "Fixed C6B7 maximum work-unit limit." },
  maxBytes: { type: "number", minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxBytes, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxBytes, multipleOf: 1, description: "Fixed C6B7 maximum byte limit." },
} };
function recipe(formulaId: string, description: string, parameters: MotionDebugArgPropertySchema): MotionDebugArgPropertySchema {
  return { type: "object", required: ["seed", "formulaId", "actionId", "parameters", "limits"], additionalProperties: false, properties: {
    seed: UINT32,
    formulaId: { type: "string", enum: [formulaId], description },
    actionId: { type: "string", enum: [DATA_RECIPE_CHECKPOINT_ACTION_ID], description: "Literal bounded full-clip line action identifier." },
    parameters,
    limits: LIMITS,
  } };
}

export const DATA_RECIPE_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["schema", "storyboardSeed", "requiredCapability", "target", "checkpoints", "recipe"], additionalProperties: false, properties: {
  schema: { type: "string", enum: [DATA_RECIPE_CHECKPOINT_SCHEMA], description: "Exact closed data-recipe checkpoint schema." },
  storyboardSeed: UINT32,
  requiredCapability: { type: "string", enum: ["renderer.gpu"], description: "The sole required renderer capability." },
  target: { type: "object", required: ["objectId", "rootShapeKind"], additionalProperties: false, properties: { objectId: ID, rootShapeKind: { type: "string", enum: ["rect"], description: "The sole retained-trace target is a rect." } } },
  checkpoints: { type: "array", minItems: 2, maxItems: 2, items: CHECKPOINT, description: "Exactly two explicit present endpoint states at 0 and D. Core requires ordered endpoints and equal opacity." },
  recipe: { type: "object", oneOf: [
    recipe(DATA_RECIPE_CHECKPOINT_FORMULA_ID, "Literal bounded Lissajous formula identifier.", LISSAJOUS_PARAMETERS),
    recipe(DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID, "Literal bounded rose-curve formula identifier.", ROSE_PARAMETERS),
  ], description: "Exactly one closed formula-specific recipe object." },
}, description: "Closed C6D data-recipe descriptor. Core lowers one literal Lissajous or rose-curve full-clip line recipe to a normal sealed C6B7 retained-trace storyboard; expressions, graphs, nodes, scripts, callbacks, paths, URLs, assets, renderers, packages, stores, and outputs are not accepted." };

const CHOREOGRAPHY_OBJECT: MotionDebugArgPropertySchema = { type: "object", required: ["objectId", "rootShapeKind", "orbitRadius", "phaseTurnsQ1024"], additionalProperties: false, properties: {
  objectId: ID,
  rootShapeKind: { type: "string", enum: ["rect", "ellipse"], description: "Closed existing root-shape choice." },
  orbitRadius: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000, description: "Finite positive base orbit radius; Core also bounds every checkpoint extent." },
  phaseTurnsQ1024: { type: "number", minimum: 0, maximum: 1_023, multipleOf: 1, description: "Integer object phase in 1/1024 turns." },
} };
const CHOREOGRAPHY_CHECKPOINT: MotionDebugArgPropertySchema = { type: "object", required: ["atUs", "orbitTurnsQ1024", "radiusScaleQ1024", "scaleQ1024", "opacityQ1024"], additionalProperties: false, properties: {
  atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1_000, description: "Whole-millisecond microseconds; Core requires zero first and strict increasing order." },
  orbitTurnsQ1024: { type: "number", minimum: -16_384, maximum: 16_384, multipleOf: 1, description: "Signed integer orbit progression in 1/1024 turns." },
  radiusScaleQ1024: { type: "number", minimum: 1, maximum: 4_096, multipleOf: 1, description: "Positive integer orbit-radius scale in Q1024." },
  scaleQ1024: { type: "number", minimum: 2, maximum: 4_096, multipleOf: 1, description: "Positive integer object scale in Q1024." },
  opacityQ1024: { type: "number", minimum: 0, maximum: 1_024, multipleOf: 1, description: "Integer opacity in Q1024." },
} };
const CHOREOGRAPHY_LIMITS: MotionDebugArgPropertySchema = { type: "object", required: ["maxObjects", "maxCheckpoints", "maxRecipes", "maxWorkUnits", "maxBytes"], additionalProperties: false, properties: {
  maxObjects: { type: "number", minimum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxObjects, maximum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxObjects, multipleOf: 1 },
  maxCheckpoints: { type: "number", minimum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxCheckpoints, maximum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxCheckpoints, multipleOf: 1 },
  maxRecipes: { type: "number", minimum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxRecipes, maximum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxRecipes, multipleOf: 1 },
  maxWorkUnits: { type: "number", minimum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxWorkUnits, maximum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxWorkUnits, multipleOf: 1 },
  maxBytes: { type: "number", minimum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxBytes, maximum: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxBytes, multipleOf: 1 },
} };
const CHOREOGRAPHY_RECIPE: MotionDebugArgPropertySchema = { type: "object", required: ["seed", "formulaId", "actionId", "parameters", "limits"], additionalProperties: false, properties: {
  seed: UINT32,
  formulaId: { type: "string", enum: [DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID], description: "Literal bounded checkpoint-orbit formula identifier." },
  actionId: { type: "string", enum: [DATA_RECIPE_CHOREOGRAPHY_ACTION_ID], description: "Literal deterministic checkpoint-orbit action identifier." },
  parameters: { type: "object", required: ["centerX", "centerY", "spatialTangentMode", "scalarEasing"], additionalProperties: false, properties: {
    centerX: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
    centerY: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
    spatialTangentMode: { type: "string", enum: ["linear", "auto"] },
    scalarEasing: { type: "string", enum: ["linear", "ease-in", "ease-out", "ease-in-out"] },
  } },
  limits: CHOREOGRAPHY_LIMITS,
} };

export const DATA_RECIPE_CHOREOGRAPHY_DESCRIPTOR: MotionDebugArgPropertySchema = { type: "object", required: ["schema", "storyboardSeed", "requiredCapability", "objects", "checkpoints", "recipe"], additionalProperties: false, properties: {
  schema: { type: "string", enum: [DATA_RECIPE_CHOREOGRAPHY_SCHEMA], description: "Exact closed multi-object checkpoint choreography schema." },
  storyboardSeed: UINT32,
  requiredCapability: { type: "string", enum: ["renderer.browser"], description: "The sole required renderer capability." },
  objects: { type: "array", minItems: 2, maxItems: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxObjects, items: CHOREOGRAPHY_OBJECT, description: "Strict id-ordered orbit object catalog." },
  checkpoints: { type: "array", minItems: 3, maxItems: DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxCheckpoints, items: CHOREOGRAPHY_CHECKPOINT, description: "Three to eight explicit whole-millisecond choreography checkpoints." },
  recipe: CHOREOGRAPHY_RECIPE,
}, description: "Closed C6D multi-object/multi-checkpoint data recipe. Core deterministically lowers the literal orbit checkpoints into normal sealed C6B1 scalar/spatial data; expressions, graphs, scripts, callbacks, paths, URLs, assets, renderers, packages, stores, and outputs are not accepted." };
