import {
  ENVIRONMENT_KINDS,
  ENVIRONMENT_QUALITY_TIERS,
  ENVIRONMENT_SCHEMA,
  MAX_FOG_DEPTH_LAYERS,
  MAX_RAIN_DEPTH_LAYERS,
  MAX_SNOW_DEPTH_LAYERS,
  MAX_WATER_WAVE_OCTAVES
} from "./environment";

export const PUBLIC_SCHEMA_EXTENSION_COMMENT = "Additional properties remain open for forward compatibility and x-* extension namespaces. The runtime validator remains the authority for cross-record references, ordering, budgets, and semantic relationships.";
export const PUBLIC_SCHEMA_ENVIRONMENT_COLOR = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" };
export const PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER = { type: "integer", minimum: 0, maximum: 0xffff_ffff };

/** Definitions for the discriminated environment layer payload. */
export function buildEnvironmentDefinitions(): Record<string, unknown> {
  return {
    environment: environmentSchema(),
    rainEnvironment: rainEnvironmentSchema(),
    waterEnvironment: waterEnvironmentSchema(),
    snowEnvironment: snowEnvironmentSchema(),
    fogEnvironment: fogEnvironmentSchema()
  };
}

function environmentSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["schema", "kind", "seed", "quality", "mode"],
    properties: {
      schema: { const: ENVIRONMENT_SCHEMA }, kind: { enum: [...ENVIRONMENT_KINDS] }, seed: PUBLIC_SCHEMA_UNSIGNED_32_BIT_INTEGER,
      quality: { enum: [...ENVIRONMENT_QUALITY_TIERS] }, mode: { enum: ["scene", "overlay"] },
      sceneSourceLayerId: { type: "string", minLength: 1 }, effectMaskLayerId: { type: "string", minLength: 1 }
    },
    allOf: [
      environmentKindRequires("rain", "#/$defs/rainEnvironment"),
      environmentKindRequires("water", "#/$defs/waterEnvironment"),
      environmentKindRequires("snow", "#/$defs/snowEnvironment"),
      environmentKindRequires("fog", "#/$defs/fogEnvironment")
    ],
    $comment: "The runtime additionally validates environment source/mask layer references, order, timing, fit and document-size transforms. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
  };
}

function environmentKindRequires(kind: string, ref: string): Record<string, unknown> {
  return {
    if: { properties: { kind: { const: kind } }, required: ["kind"] },
    then: { allOf: [{ $ref: ref }] }
  };
}

function rainEnvironmentSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["intensity", "wind", "dropSpeed", "dropLength", "depthLayers", "color", "backgroundColor", "lightColor", "accentColor", "ground", "atmosphere"],
    properties: {
      intensity: unitNumber(), wind: { type: "number", minimum: -2, maximum: 2 }, dropSpeed: { type: "number", minimum: 0.1, maximum: 5 }, dropLength: { type: "number", minimum: 0.1, maximum: 2 },
      depthLayers: { type: "integer", minimum: 1, maximum: MAX_RAIN_DEPTH_LAYERS }, color: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, backgroundColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, lightColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, accentColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR,
      ground: requiredObject(["horizon", "wetness", "roughness", "rippleAmount", "splashAmount", "reflectionStrength"], {
        horizon: { type: "number", minimum: 0.15, maximum: 0.9 }, wetness: unitNumber(), roughness: unitNumber(), rippleAmount: unitNumber(), splashAmount: unitNumber(), reflectionStrength: unitNumber()
      }),
      atmosphere: requiredObject(["mist", "lensDroplets"], { mist: unitNumber(), lensDroplets: unitNumber() })
    },
    $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
  };
}

function waterEnvironmentSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["backgroundColor", "shallowColor", "deepColor", "reflectionColor", "foamColor", "surface", "optics"],
    properties: {
      backgroundColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, shallowColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, deepColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, reflectionColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, foamColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR,
      surface: requiredObject(["horizon", "waveScale", "waveHeight", "waveSpeed", "direction", "choppiness", "waveOctaves"], {
        horizon: { type: "number", minimum: 0.1, maximum: 0.9 }, waveScale: { type: "number", minimum: 0.1, maximum: 20 }, waveHeight: unitNumber(), waveSpeed: { type: "number", minimum: 0.05, maximum: 5 }, direction: { type: "number", minimum: -180, maximum: 180 }, choppiness: unitNumber(), waveOctaves: { type: "integer", minimum: 1, maximum: MAX_WATER_WAVE_OCTAVES }
      }),
      optics: requiredObject(["reflectionStrength", "refractionStrength", "fresnel", "caustics", "clarity", "foam"], {
        reflectionStrength: unitNumber(), refractionStrength: unitNumber(), fresnel: unitNumber(), caustics: unitNumber(), clarity: unitNumber(), foam: unitNumber()
      })
    },
    $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
  };
}

function snowEnvironmentSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["backgroundColor", "snowColor", "shadowColor", "lightColor", "fall", "ground", "atmosphere"],
    properties: {
      backgroundColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, snowColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, shadowColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, lightColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR,
      fall: requiredObject(["intensity", "speed", "wind", "turbulence", "flakeSize", "depthLayers", "focusFalloff"], {
        intensity: unitNumber(), speed: { type: "number", minimum: 0.05, maximum: 3 }, wind: { type: "number", minimum: -2, maximum: 2 }, turbulence: unitNumber(), flakeSize: { type: "number", minimum: 0.1, maximum: 3 }, depthLayers: { type: "integer", minimum: 1, maximum: MAX_SNOW_DEPTH_LAYERS }, focusFalloff: unitNumber()
      }),
      ground: requiredObject(["horizon", "accumulation", "drift", "contactAmount"], { horizon: { type: "number", minimum: 0.1, maximum: 0.9 }, accumulation: unitNumber(), drift: unitNumber(), contactAmount: unitNumber() }),
      atmosphere: requiredObject(["haze", "depthFade"], { haze: unitNumber(), depthFade: unitNumber() })
    },
    $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
  };
}

function fogEnvironmentSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["backgroundColor", "fogColor", "lightColor", "fog"],
    properties: {
      backgroundColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, fogColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR, lightColor: PUBLIC_SCHEMA_ENVIRONMENT_COLOR,
      fog: requiredObject(["density", "speed", "scale", "turbulence", "height", "depthLayers", "lightStrength"], {
        density: unitNumber(), speed: { type: "number", minimum: 0.01, maximum: 3 }, scale: { type: "number", minimum: 0.1, maximum: 12 }, turbulence: unitNumber(), height: unitNumber(), depthLayers: { type: "integer", minimum: 1, maximum: MAX_FOG_DEPTH_LAYERS }, lightStrength: unitNumber()
      })
    },
    $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT
  };
}

function unitNumber(): Record<string, unknown> {
  return { type: "number", minimum: 0, maximum: 1 };
}

function requiredObject(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", required, properties, $comment: PUBLIC_SCHEMA_EXTENSION_COMMENT };
}
