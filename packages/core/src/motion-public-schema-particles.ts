import { GPU_COMPUTE_PARTICLE_MAX_COUNT, GPU_COMPUTE_PARTICLE_MIN_COUNT } from "./gpu-particle-compute";
import {
  MAX_PARTICLE_EMITTER_ORIGINS,
  MAX_PARTICLE_FIELD_SOURCES,
  MAX_PARTICLE_FIELD_V2_SOURCES,
  PARTICLE_FIELD_MAX_SOFTENING,
  PARTICLE_FIELD_MAX_STRENGTH,
  PARTICLE_FIELD_MIN_SOFTENING,
  PARTICLE_FIELD_MIN_STRENGTH,
  PARTICLE_FIELD_SCHEMA,
  PARTICLE_FIELD_V2_SCHEMA
} from "./particle-field-types";
import { PUBLIC_SCHEMA_EXTENSION_COMMENT, PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER } from "./motion-public-schema-environments";
import { MAX_MOTION_COLOR_STRING_LENGTH } from "./color";

const COLOR = { type: "string", minLength: 1, maxLength: MAX_MOTION_COLOR_STRING_LENGTH };
const UNIT = { type: "number", minimum: 0, maximum: 1 };
const STRENGTH = { type: "number", minimum: PARTICLE_FIELD_MIN_STRENGTH, maximum: PARTICLE_FIELD_MAX_STRENGTH };
const V1_RADIAL_SOURCE = { type: "object", required: ["kind", "centerX", "centerY", "strength", "softening"], properties: { kind: { enum: ["radial", "vortex"] }, centerX: UNIT, centerY: UNIT, strength: STRENGTH, softening: { type: "number", minimum: PARTICLE_FIELD_MIN_SOFTENING, maximum: PARTICLE_FIELD_MAX_SOFTENING } } };
const V2_RADIAL_SOURCE = { ...V1_RADIAL_SOURCE, additionalProperties: false };

/** Source-owned public schema metadata. Generated schema files are intentionally not edited here. */
export function buildParticleDefinitions(): Record<string, unknown> {
  return {
    emitter: {
      type: "object", required: ["seed", "count", "lifetimeMs", "color"],
      properties: {
        seed: PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER, count: { type: "integer", minimum: 1, maximum: GPU_COMPUTE_PARTICLE_MAX_COUNT }, lifetimeMs: { type: "number", exclusiveMinimum: 0, maximum: 60_000 },
        shape: { enum: ["circle", "square"] }, color: COLOR, secondaryColor: COLOR, minSize: { type: "number", exclusiveMinimum: 0, maximum: 256 }, maxSize: { type: "number", exclusiveMinimum: 0, maximum: 256 }, minSpeed: { type: "number", minimum: 0, maximum: 2_000 }, maxSpeed: { type: "number", minimum: 0, maximum: 2_000 }, direction: { type: "number" }, spread: { type: "number", minimum: 0, maximum: 360 }, gravity: { type: "number", minimum: -5_000, maximum: 5_000 }, fadeOut: { type: "boolean" },
        field: { $ref: "#/$defs/particleField" }, origins: { type: "array", minItems: 1, maxItems: MAX_PARTICLE_EMITTER_ORIGINS, items: { $ref: "#/$defs/particleOrigin" } }, trail: { $ref: "#/$defs/particleAnalyticTrail" }, shading: { $ref: "#/$defs/particleShading" }
      },
      allOf: [
        { anyOf: [
          { required: ["count"], properties: { count: { maximum: 1_000 } } },
          { required: ["count", "shape", "field"], properties: { count: { minimum: GPU_COMPUTE_PARTICLE_MIN_COUNT, maximum: GPU_COMPUTE_PARTICLE_MAX_COUNT }, shape: { const: "circle" }, field: { $ref: "#/$defs/particleField" } } }
        ] },
        { if: { required: ["field"], properties: { field: { $ref: "#/$defs/particleFieldV2" } } }, then: { required: ["count", "shape"], properties: { count: { minimum: GPU_COMPUTE_PARTICLE_MIN_COUNT, maximum: GPU_COMPUTE_PARTICLE_MAX_COUNT }, shape: { const: "circle" } } } },
        { if: { anyOf: [{ required: ["origins"] }, { required: ["trail"] }, { required: ["shading"] }] }, then: { required: ["field", "count", "shape"], properties: { field: { $ref: "#/$defs/particleFieldV2" }, count: { minimum: GPU_COMPUTE_PARTICLE_MIN_COUNT, maximum: GPU_COMPUTE_PARTICLE_MAX_COUNT }, shape: { const: "circle" } } } }
      ],
      $comment: `Counts above 1000 require the fixed data-only analytic particle field route: circle heads and ${GPU_COMPUTE_PARTICLE_MIN_COUNT}..${GPU_COMPUTE_PARTICLE_MAX_COUNT}. ${PARTICLE_FIELD_V2_SCHEMA} adds only fixed sources, weighted origins, analytic lookback, and fixed shading; it never accepts shader or compute code. ${PUBLIC_SCHEMA_EXTENSION_COMMENT}`
    },
    particleField: { oneOf: [{ $ref: "#/$defs/particleFieldV1" }, { $ref: "#/$defs/particleFieldV2" }] },
    particleFieldV1: { type: "object", required: ["schema", "sources"], properties: { schema: { const: PARTICLE_FIELD_SCHEMA }, sources: { type: "array", minItems: 1, maxItems: MAX_PARTICLE_FIELD_SOURCES, items: { $ref: "#/$defs/particleFieldSource" } } }, $comment: "v1 analytic kinematic visual deflection remains byte and semantic compatible. " + PUBLIC_SCHEMA_EXTENSION_COMMENT },
    particleFieldV2: { type: "object", additionalProperties: false, required: ["schema", "sources"], properties: { schema: { const: PARTICLE_FIELD_V2_SCHEMA }, sources: { type: "array", minItems: 1, maxItems: MAX_PARTICLE_FIELD_V2_SOURCES, items: { $ref: "#/$defs/particleFieldV2Source" } } }, $comment: "v2 is a closed bounded fixed-mechanics ABI, not a general physics graph, code surface, or simulation-clock selector." },
    particleFieldSource: { ...V1_RADIAL_SOURCE, $comment: "v1 radial/vortex source; signed strength reverses direction and softening prevents a singular centre. " + PUBLIC_SCHEMA_EXTENSION_COMMENT },
    particleFieldV2Source: { oneOf: [
      V2_RADIAL_SOURCE,
      { type: "object", additionalProperties: false, required: ["kind", "angleDeg", "strength"], properties: { kind: { const: "flow" }, angleDeg: { type: "number", minimum: -360, maximum: 360 }, strength: STRENGTH } },
      { type: "object", additionalProperties: false, required: ["kind", "scale", "strength"], properties: { kind: { const: "turbulence" }, scale: { type: "number", minimum: 0.01, maximum: 4 }, strength: STRENGTH } },
      { type: "object", additionalProperties: false, required: ["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], properties: { kind: { const: "impact" }, centerX: UNIT, centerY: UNIT, radius: { type: "number", minimum: 0.01, maximum: 1 }, strength: STRENGTH, startProgress: UNIT, durationProgress: { type: "number", minimum: 0.01, maximum: 1 } }, $comment: "Impact timing is canonical layer progress (atMs - layerStartMs) / lifetimeMs, not randomized particle age." },
      { type: "object", additionalProperties: false, required: ["kind", "axis", "position", "restitution"], properties: { kind: { const: "collision" }, axis: { enum: ["x", "y"] }, position: UNIT, restitution: UNIT } }
    ], $comment: "Closed v2 sources include an axis-aligned fixed-plane collision subset; mesh, particle-particle, and continuous collision are refused." },
    particleOrigin: { type: "object", additionalProperties: false, required: ["x", "y", "weight"], properties: { x: UNIT, y: UNIT, weight: { type: "number", minimum: 0.01, maximum: 1 }, directionOffsetDeg: { type: "number", minimum: -360, maximum: 360 }, speedScale: { type: "number", minimum: 0.25, maximum: 4 } }, $comment: "Closed v2 weighted origin record; no selector, callback, or state exists." },
    particleAnalyticTrail: { type: "object", additionalProperties: false, required: ["durationMs", "samples"], properties: { durationMs: { type: "number", minimum: 1, maximum: 1_000 }, samples: { type: "integer", minimum: 2, maximum: 4 }, opacity: { type: "number", minimum: 0.05, maximum: 1 } }, $comment: "Closed v2 fixed-shader analytic lookback only; no history buffer or package-selected pass exists." },
    particleShading: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { enum: ["flat", "soft", "glow"] }, sizeJitter: UNIT, opacityJitter: UNIT, glow: UNIT }, $comment: "Closed v2 fixed renderer head shading; package data cannot provide shader source or uniforms." }
  };
}
