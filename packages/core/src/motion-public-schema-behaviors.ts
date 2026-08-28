import {
  MOTION_BEHAVIOR_MAX_COORDINATE,
  MOTION_BEHAVIOR_MAX_GRAVITY,
  MOTION_BEHAVIOR_MAX_RESTITUTION,
  MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MAX_VELOCITY,
  MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY,
  MOTION_BEHAVIOR_MIN_COORDINATE,
  MOTION_BEHAVIOR_MIN_GRAVITY,
  MOTION_BEHAVIOR_MIN_RESTITUTION,
  MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MIN_VELOCITY,
} from "./motion-behavior-types";

/** Exact portable shape for document-root behavior storage. Cross-record ownership stays in Core. */
export function buildMotionBehaviorDefinitions(): Record<string, unknown> {
  // Start positions may occur anywhere in an exactly representable document timeline. Duration
  // and path offset remain bounded work controls rather than a second document-duration cap.
  const startUs = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const boundedTime = { type: "integer", minimum: 0, maximum: 3_600_000_000 };
  const common = {
    targetLayerId: { type: "string", minLength: 1 }, enabled: { type: "boolean" },
    startUs, durationUs: { type: "integer", minimum: 1, maximum: 3_600_000_000 },
  };
  const pathGeometry = {
    type: "object", required: ["schema", "kind", "viewBox", "data"], additionalProperties: false,
    properties: { schema: { const: "shellx-motion/shape-geometry@1" }, kind: { const: "path" }, viewBox: { $ref: "#/$defs/shapeGeometryViewBox" }, data: { type: "string", minLength: 1, maxLength: 16_384 } }
  };
  return {
    motionBehaviors: {
      type: "object", required: ["schema", "bindings"], additionalProperties: false,
      properties: { schema: { const: "shellx-motion/behaviors@1" }, bindings: { type: "array", minItems: 1, maxItems: 32, items: { $ref: "#/$defs/motionBehavior" } } },
      $comment: "Runtime requires strict UTF-16/code-unit target order, root-owned shape targets, exact document-us bounds, and no competing transform authority."
    },
    motionBehavior: {
      oneOf: [
        { type: "object", required: ["targetLayerId", "enabled", "kind", "startUs", "durationUs", "geometry"], additionalProperties: false, properties: { ...common, kind: { const: "path-follow" }, geometry: pathGeometry, offsetUs: boundedTime, direction: { enum: ["forward", "reverse"] }, orientToPath: { type: "boolean" }, easing: { $ref: "#/$defs/easing" } } },
        { type: "object", required: ["targetLayerId", "enabled", "kind", "startUs", "durationUs"], anyOf: [{ required: ["motion"] }, { required: ["squash"] }], additionalProperties: false, properties: { ...common, kind: { const: "transform" }, motion: { oneOf: [{ $ref: "#/$defs/motionBehaviorGravity" }, { $ref: "#/$defs/motionBehaviorBounce" }] }, squash: { $ref: "#/$defs/motionBehaviorSquash" } } }
      ]
    },
    motionBehaviorGravity: { type: "object", required: ["kind", "velocityX", "velocityY", "gravityY"], additionalProperties: false, properties: { kind: { const: "gravity" }, velocityX: { type: "number", minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY }, velocityY: { type: "number", minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY }, gravityY: { type: "number", minimum: MOTION_BEHAVIOR_MIN_GRAVITY, maximum: MOTION_BEHAVIOR_MAX_GRAVITY } } },
    motionBehaviorBounce: { type: "object", required: ["kind", "floorY", "velocityY", "gravityY", "restitution"], additionalProperties: false, properties: { kind: { const: "bounce" }, floorY: { type: "number", minimum: MOTION_BEHAVIOR_MIN_COORDINATE, maximum: MOTION_BEHAVIOR_MAX_COORDINATE }, velocityY: { type: "number", minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY }, gravityY: { type: "number", minimum: MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY, maximum: MOTION_BEHAVIOR_MAX_GRAVITY }, restitution: { type: "number", minimum: MOTION_BEHAVIOR_MIN_RESTITUTION, maximum: MOTION_BEHAVIOR_MAX_RESTITUTION } } },
    motionBehaviorSquash: { type: "object", required: ["kind", "axis", "amount"], additionalProperties: false, properties: { kind: { const: "squash" }, axis: { enum: ["vertical", "horizontal"] }, amount: { type: "number", minimum: MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT, maximum: MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT } } },
  };
}
