import { buildEnvironmentDefinitions, PUBLIC_SCHEMA_EXTENSION_COMMENT, PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER } from "./motion-public-schema-environments";
import { GENERATED_VISUAL_LAYER_TYPES } from "./generated-visual-layer-types";
import { RESTRICTED_SHADER_LANGUAGE, RESTRICTED_SHADER_SCHEMA } from "./shader-plugin";
import { buildGpuMaterialPublicSchema } from "./gpu-material-contract";
import { MAX_MOTION_EASING_CODE_UNITS, MOTION_FUNCTIONAL_EASING_PATTERN, NAMED_EASINGS_LIST } from "./timeline";
import { MAX_POINT_SAMPLES_PER_LAYER, MAX_POINTS_PER_LAYER } from "./motion-points";
import { MAX_TRAIL_DURATION_MS, MAX_TRAIL_SAMPLES, MIN_TRAIL_SAMPLES } from "./motion-trail";
import { PATH_REVEAL_SCHEMA } from "./motion-public-schema-path-reveal";
import { buildParticleDefinitions } from "./motion-public-schema-particles";
import { buildEffectModuleDefinitions } from "./motion-public-schema-effect-module";
import { buildShapeGeometryDefinitions } from "./motion-public-schema-shape-geometry";
import { buildTextRunsDefinitions, TEXT_RUNS_LAYER_PROPERTY, textRunsLayerTypeConstraint } from "./motion-public-schema-text-runs";
import { MAX_MOTION_COLOR_STRING_LENGTH } from "./color"; const COLOR = { type: "string", minLength: 1, maxLength: MAX_MOTION_COLOR_STRING_LENGTH }; const DIRECTION = { enum: ["left", "right", "up", "down"] };
/** Definitions for the portable layer, animation, effect, and environment payload shapes. */
export function buildLayerDefinitions(): Record<string, unknown> {
  return {
    layer: {
      type: "object",
      required: ["id", "type", "startMs", "durationMs"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: {
          type: "string",
          minLength: 1,
          $comment: "Deliberately not an enum: validate.ts accepts non-empty host layer types so extension producers can carry their data through a Motion document. Type-specific branches below apply only to built-in discriminants."
        },
        name: { type: "string" },
        childLayerIds: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: { type: "string", minLength: 1 } },
        trackId: { type: "string", minLength: 1 },
        startMs: { type: "number", minimum: 0 },
        durationMs: { type: "number", exclusiveMinimum: 0 },
        text: { type: "string" },
        textRuns: TEXT_RUNS_LAYER_PROPERTY,
        shape: { type: "string" },
        geometry: { $ref: "#/$defs/shapeGeometry" },
        geometryKeyframes: { $ref: "#/$defs/shapeGeometryKeyframes" },
        fill: COLOR,
        color: COLOR,
        width: { type: "number", minimum: 0 },
        height: { type: "number", minimum: 0 },
        opacity: { type: "number", minimum: 0, maximum: 1 },
        visible: { type: "boolean" },
        locked: { type: "boolean" },
        source: { type: "string", minLength: 1 },
        src: { type: "string", minLength: 1 },
        assetId: { type: "string", minLength: 1 },
        assetRef: { type: "string", minLength: 1 },
        trimStartMs: { type: "number", minimum: 0 },
        trimDurationMs: { type: "number", exclusiveMinimum: 0 },
        loop: { type: "boolean" },
        playbackRate: { type: "number", exclusiveMinimum: 0 },
        includeAudio: { type: "boolean" },
        volume: { type: "number", minimum: 0 },
        pan: { type: "number", minimum: -1, maximum: 1 },
        muted: { type: "boolean" },
        fadeInMs: { type: "number", minimum: 0 },
        fadeOutMs: { type: "number", minimum: 0 },
        fadeCurve: { enum: ["linear", "equal-power"] },
        normalizeLoudness: { type: "boolean" },
        fit: { type: "string", minLength: 1 },
        allowedOrigins: { type: "array" },
        transform: { $ref: "#/$defs/transform" },
        style: { $ref: "#/$defs/layerStyle" },
        textFit: { $ref: "#/$defs/textFit" },
        crop: { $ref: "#/$defs/crop" },
        keyframes: { $ref: "#/$defs/keyframes" },
        transitions: { $ref: "#/$defs/transitions" },
        mask: { $ref: "#/$defs/mask" },
        matte: { $ref: "#/$defs/matte" },
        effects: { $ref: "#/$defs/effects" },
        effectModule: { $ref: "#/$defs/effectModule" },
        gradient: { $ref: "#/$defs/gradient" },
        pathReveal: { $ref: "#/$defs/pathReveal" },
        emitter: { $ref: "#/$defs/emitter" },
        pointCloud: { $ref: "#/$defs/pointCloud" },
        shader: { $ref: "#/$defs/shader" },
        scene3d: { $ref: "#/$defs/scene3d" },
        environment: { $ref: "#/$defs/environment" },
        depth: { type: "number", minimum: -0.9, maximum: 3 },
        blendMode: {
          enum: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"]
        }
      },
      allOf: [
        layerTypeRequires("particles", "emitter"),
        layerTypeRequires("points", "pointCloud"),
        layerTypeRequires("shader", "shader"),
        layerTypeRequires("scene3d", "scene3d"),
        layerTypeRequires("environment", "environment"),
        layerTypeRequires("group", "childLayerIds"),
        propertyRequiresLayerType("crop", ["image", "video"]),
        propertyRequiresLayerType("textFit", ["text", "caption"]),
        textRunsLayerTypeConstraint(),
        propertyRequiresLayerType("gradient", ["shape"]),
        propertyRequiresLayerType("geometry", ["shape"]),
        propertyRequiresLayerType("geometryKeyframes", ["shape"]),
        propertyRequiresProperty("geometryKeyframes", "geometry"),
        propertyRequiresLayerType("pathReveal", ["shape"]),
        propertyRequiresLayerType("emitter", ["particles"]),
        propertyRequiresLayerType("pointCloud", ["points"]),
        propertyRequiresLayerType("shader", ["shader"]),
        propertyRequiresLayerType("scene3d", ["scene3d"]),
        propertyRequiresLayerType("environment", ["environment"]),
        propertyRequiresLayerType("childLayerIds", ["group"]),
        propertyRequiresLayerType("depth", GENERATED_VISUAL_LAYER_TYPES)
      ],
      $comment: "textRuns is closed and text/caption-only here. The deliberately small public-schema dialect cannot express absent-property xor while retaining legacy empty text layers; validate.ts enforces text/textRuns and face-authority exclusivity. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    transform: {
      type: "object",
      properties: {
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number", minimum: 0 }, height: { type: "number", minimum: 0 },
        opacity: { type: "number", minimum: 0, maximum: 1 }, scale: { type: "number", exclusiveMinimum: 0 },
        rotation: { type: "number" }, originX: { type: "number" }, originY: { type: "number" }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    layerStyle: { type: "object", properties: { strokeDasharray: { type: "array", minItems: 1, maxItems: 32, items: { type: "number", exclusiveMinimum: 0, maximum: 4096 } }, strokeDashoffset: { type: "number", minimum: -1000000, maximum: 1000000 } }, allOf: [{ if: { required: ["strokeDashoffset"] }, then: { required: ["strokeDasharray"] } }], $comment: "Known v1 dash fields are numeric; other legacy and extension style fields remain open. " + PUBLIC_SCHEMA_EXTENSION_COMMENT },
    textFit: {
      type: "object",
      required: ["policy"],
      properties: {
        policy: { enum: ["safe", "allow-crop", "auto-fit"] },
        safeAreaId: { type: "string", minLength: 1 },
        minFontSize: { type: "number", exclusiveMinimum: 0 }
      },
      allOf: [{
        if: { properties: { policy: { enum: ["safe", "auto-fit"] } }, required: ["policy"] },
        then: { required: ["safeAreaId"] }
      }, {
        if: { properties: { policy: { const: "auto-fit" } }, required: ["policy"] },
        then: { properties: { minFontSize: { type: "number", exclusiveMinimum: 0 } } }
      }],
      $comment: "The runtime additionally verifies safeAreaId against the enclosing document. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    crop: {
      type: "object",
      required: ["x", "y", "width", "height"],
      properties: {
        x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 },
        width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    pathReveal: PATH_REVEAL_SCHEMA,
    ...buildShapeGeometryDefinitions(),
    ...buildTextRunsDefinitions(),
    keyframes: {
      type: "object",
      additionalProperties: { type: "array", items: { $ref: "#/$defs/keyframe" } },
      $comment: "The runtime further checks target vocabulary, target-specific value ranges, shader uniform declarations, and temporal ordering. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    keyframe: {
      type: "object",
      required: ["atMs", "value"],
      properties: {
        atMs: { type: "number" },
        value: { type: ["number", "string"] },
        easing: { $ref: "#/$defs/easing" }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    easing: {
      anyOf: [
        { enum: [...NAMED_EASINGS_LIST] },
        { enum: ["spring-gentle", "spring-snappy", "spring-bouncy"] },
        { type: "string", maxLength: MAX_MOTION_EASING_CODE_UNITS, pattern: MOTION_FUNCTIONAL_EASING_PATTERN },
        { $ref: "#/$defs/springEasing" }
      ],
      $comment: `Functional easing strings are capped at ${MAX_MOTION_EASING_CODE_UNITS} UTF-16 code units and use the same bounded grammar as Core; spring parameter ranges remain runtime-validated.`
    },
    springEasing: {
      type: "object",
      required: ["type", "stiffness", "damping"],
      properties: {
        type: { const: "spring" }, stiffness: { type: "number", exclusiveMinimum: 0 }, damping: { type: "number", exclusiveMinimum: 0 },
        mass: { type: "number", exclusiveMinimum: 0 }, initialVelocity: { type: "number" }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    transitions: {
      type: "object",
      properties: { in: { $ref: "#/$defs/transition" }, out: { $ref: "#/$defs/transition" } },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    transition: {
      type: "object",
      required: ["type", "durationMs"],
      properties: {
        type: { enum: ["fade", "slide", "wipe"] }, durationMs: { type: "number", exclusiveMinimum: 0 },
        easing: { $ref: "#/$defs/easing" }, direction: DIRECTION, distance: { type: "number", minimum: 0 }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    mask: {
      type: "object",
      required: ["type"],
      properties: {
        type: { enum: ["rect", "rounded-rect", "path", "roto"] },
        inset: { $ref: "#/$defs/inset" }, path: { type: "string", minLength: 1 }, viewBox: { type: "string", minLength: 1 },
        fillRule: { enum: ["nonzero", "evenodd"] }
      },
      $comment: "Roto fields and path geometry are validated by their specialist runtime validators. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    inset: {
      type: "object",
      properties: {
        top: { type: "number", minimum: 0 }, right: { type: "number", minimum: 0 },
        bottom: { type: "number", minimum: 0 }, left: { type: "number", minimum: 0 }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    matte: {
      type: "object",
      required: ["type", "sourceLayerId"],
      properties: {
        type: { enum: ["alpha", "alpha-inverted", "luma", "luma-inverted"] }, sourceLayerId: { type: "string", minLength: 1 }
      },
      $comment: "The runtime verifies the source layer, timing, ordering, and depth compatibility. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    effects: {
      type: "object",
      properties: {
        blur: { type: "number", minimum: 0 }, brightness: { type: "number", minimum: 0 }, contrast: { type: "number", minimum: 0 },
        saturate: { type: "number", minimum: 0 }, grayscale: { type: "number", minimum: 0 },
        glow: {
          type: "object", required: ["radius", "color"],
          properties: { radius: { type: "number", minimum: 0, maximum: 128 }, color: COLOR }, $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
        },
        motionBlur: {
          type: "object", required: ["samples", "shutterAngle"],
          properties: { samples: { type: "integer", minimum: 2, maximum: 8 }, shutterAngle: { type: "number", exclusiveMinimum: 0, maximum: 360 } }, $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
        },
        vignette: {
          type: "object", required: ["amount", "softness", "color"],
          properties: { amount: { type: "number", minimum: 0, maximum: 1 }, softness: { type: "number", minimum: 0, maximum: 1 }, color: COLOR }, $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
        },
        filmGrain: {
          type: "object", required: ["amount", "size", "seed"],
          properties: { amount: { type: "number", minimum: 0, maximum: 1 }, size: { type: "integer", minimum: 1, maximum: 8 }, seed: PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER }, $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
        },
        trail: {
          type: "object", required: ["durationMs", "samples"],
          properties: { durationMs: { type: "number", minimum: 1, maximum: MAX_TRAIL_DURATION_MS }, samples: { type: "integer", minimum: MIN_TRAIL_SAMPLES, maximum: MAX_TRAIL_SAMPLES } },
          $comment: "Static, bounded lookback strokes for particles and points only. Runtime rejects other owners, unknown fields, and concurrent vertex budgets. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
        }
      },
      $comment: "The runtime additionally applies layer-family restrictions and concurrent motion-blur budgets. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    gradient: {
      type: "object",
      required: ["type", "stops"],
      properties: {
        type: { enum: ["linear", "radial"] }, angle: { type: "number" },
        centerX: { type: "number", minimum: 0, maximum: 1 }, centerY: { type: "number", minimum: 0, maximum: 1 },
        stops: { type: "array", minItems: 2, items: { $ref: "#/$defs/gradientStop" } }
      },
      $comment: "The runtime also caps stops at 16, requires ordering, and applies type-specific fields. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    gradientStop: {
      type: "object", required: ["offset", "color"],
      properties: { offset: { type: "number", minimum: 0, maximum: 1 }, color: COLOR }, $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    ...buildParticleDefinitions(), ...buildEffectModuleDefinitions(),
    pointCloud: {
      type: "object",
      required: ["points"],
      properties: {
        points: { type: "array", minItems: 1, maxItems: MAX_POINTS_PER_LAYER, items: { $ref: "#/$defs/point" } },
        samples: { type: "array", maxItems: MAX_POINT_SAMPLES_PER_LAYER, items: { $ref: "#/$defs/pointSample" } }
      },
      $comment: "Point order is identity. Runtime validation enforces finite values, exact sample cardinality, strict sample timing, aggregate state-record budgets, and canonical UTF-8 payload limits. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    point: {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: { type: "number" }, y: { type: "number" }, color: COLOR,
        size: { type: "number", exclusiveMinimum: 0, maximum: 256 }, opacity: { type: "number", minimum: 0, maximum: 1 }
      },
      $comment: "Point colors are static; sampled colour interpolation is intentionally not part of motion@1. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    pointSample: {
      type: "object",
      required: ["atMs", "positions"],
      properties: {
        atMs: { type: "number", minimum: 0 },
        positions: { type: "array", minItems: 1, maxItems: MAX_POINTS_PER_LAYER, items: { $ref: "#/$defs/pointSamplePosition" } }
      },
      $comment: "Runtime validation requires strictly increasing times inside the owning layer and a position for every base point. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    pointSamplePosition: {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: { type: "number" }, y: { type: "number" },
        size: { type: "number", exclusiveMinimum: 0, maximum: 256 }, opacity: { type: "number", minimum: 0, maximum: 1 }
      },
      $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    shader: {
      type: "object",
      required: ["schema", "language", "fragmentAssetId", "seed", "fallbackColor"],
      properties: {
        schema: { const: RESTRICTED_SHADER_SCHEMA }, language: { const: RESTRICTED_SHADER_LANGUAGE },
        fragmentAssetId: { type: "string", minLength: 1 }, seed: PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER, fallbackColor: COLOR,
        uniforms: { type: "object", additionalProperties: { type: "number", minimum: -1000000, maximum: 1000000 }, $comment: "The runtime validates safe uniform names and the 16-uniform maximum." },
        gpuMaterial: buildGpuMaterialPublicSchema()
      },
      $comment: "The runtime verifies fragmentAssetId against the document asset table. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    scene3d: {
      type: "object",
      properties: {
        objects: { type: "array", items: { $ref: "#/$defs/scene3dObject" } }
      },
      $comment: "The runtime validates scene schema, camera, lighting, geometry budgets, and source-geometry identity. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    scene3dObject: {
      type: "object",
      properties: {
        primitive: { type: "string" },
        source: { $ref: "#/$defs/scene3dMeshSource" }
      },
      allOf: [{
        if: { properties: { primitive: { const: "mesh" } }, required: ["primitive"] },
        then: { required: ["source"] }
      }],
      $comment: "Only mesh objects carry glTF source provenance; fixed primitives remain schema-compatible without it. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    scene3dMeshSource: {
      type: "object",
      required: ["format", "meshIndex", "primitiveIndex", "geometrySha256"],
      properties: {
        format: { enum: ["gltf", "glb"] },
        meshIndex: { type: "integer", minimum: 0 },
        primitiveIndex: { type: "integer", minimum: 0 },
        materialIndex: { type: "integer", minimum: 0 },
        geometrySha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
      },
      $comment: "geometrySha256 is the lowercase SHA-256 of the canonical bounded mesh vertex/index payload; the semantic validator recomputes it. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
    },
    ...buildEnvironmentDefinitions()
  };
}
function layerTypeRequires(type: string, property: string): Record<string, unknown> { return { if: { properties: { type: { const: type } }, required: ["type"] }, then: { required: [property] } }; }
function propertyRequiresLayerType(property: string, types: readonly string[]): Record<string, unknown> { return { if: { required: [property] }, then: { properties: { type: types.length === 1 ? { const: types[0] } : { enum: types } } } }; }
function propertyRequiresProperty(property: string, requiredProperty: string): Record<string, unknown> { return { if: { required: [property] }, then: { required: [requiredProperty] } }; }
