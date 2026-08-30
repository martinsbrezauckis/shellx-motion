import {
  GPU_EFFECT_MODULE_RENDERER_ABI,
  MOTION_AFTERIMAGE_STACK_INTRINSIC,
  MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA,
  MOTION_EFFECT_MODULE_REF_SCHEMA,
  MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH,
  MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN
} from "./effect-module";

/** Closed package-reference schema; host manifests deliberately remain private host authority. */
export function buildEffectModuleDefinitions(): Record<string, unknown> {
  return {
    effectModule: {
      type: "object", required: ["schema", "moduleId", "version", "parameters"], additionalProperties: false,
      properties: {
        schema: { const: MOTION_EFFECT_MODULE_REF_SCHEMA },
        moduleId: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$", maxLength: 128 },
        version: { type: "string", maxLength: MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH, pattern: MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN },
        parameters: { $ref: "#/$defs/effectModuleParameters" }
      }
    },
    effectModuleParameters: {
      type: "object", required: ["echoes", "amountQ16"], additionalProperties: false,
      properties: { echoes: { type: "array", minItems: 1, maxItems: 4, items: { $ref: "#/$defs/effectModuleEcho" } }, amountQ16: { type: "integer", minimum: 0, maximum: 65535 } }
    },
    effectModuleEcho: {
      type: "object", required: ["dxPx", "dyPx", "color", "opacityQ16"], additionalProperties: false,
      properties: { dxPx: { type: "integer", minimum: -256, maximum: 256 }, dyPx: { type: "integer", minimum: -256, maximum: 256 }, color: { type: "string", pattern: "^#[0-9A-F]{8}$" }, opacityQ16: { type: "integer", minimum: 0, maximum: 65535 } }
    },
    effectModuleBindingContract: { const: { intrinsic: MOTION_AFTERIMAGE_STACK_INTRINSIC, rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA } }
  };
}
