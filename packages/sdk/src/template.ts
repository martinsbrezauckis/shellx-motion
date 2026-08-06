/** Converts canonical Motion template parameters to a portable JSON Schema. */
import type { TemplateParam } from "@shellx-motion/core";
import type { MotionSdkTemplateParameterSchema } from "./types";

export function createTemplateParameterSchema(templateId: string, params: readonly TemplateParam[]): MotionSdkTemplateParameterSchema {
  if (!templateId.trim()) throw new TypeError("templateId is required.");
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const seen = new Set<string>();
  for (const param of params) {
    if (!param.id.trim() || seen.has(param.id)) throw new TypeError(`Template parameter id is empty or duplicated: ${param.id}.`);
    seen.add(param.id);
    const property = parameterProperty(param);
    properties[param.id] = property;
    if (param.defaultValue === null) required.push(param.id);
  }
  return {
    schema: "shellx-motion/template-parameters@1",
    templateId,
    jsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  };
}

function parameterProperty(param: TemplateParam): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: param.label ?? param.id,
    ...(param.description ? { description: param.description } : {}),
    ...(param.defaultValue !== null ? { default: param.defaultValue } : {})
  };
  if (param.type === "number") {
    return { ...base, type: "number", ...(param.min !== undefined ? { minimum: param.min } : {}),
      ...(param.max !== undefined ? { maximum: param.max } : {}), ...(param.step !== undefined ? { multipleOf: param.step } : {}),
      ...(param.unit ? { "x-shellx-unit": param.unit } : {}) };
  }
  if (param.type === "boolean") return { ...base, type: "boolean" };
  if (param.type === "select") {
    if (!param.options?.length) throw new TypeError(`Select template parameter ${param.id} requires options.`);
    return { ...base, enum: param.options.map((option) => option.value), "x-shellx-option-labels": param.options.map((option) => option.label) };
  }
  if (param.type === "color") return { ...base, type: "string", pattern: "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$", format: "color" };
  if (param.type === "media") return { ...base, type: "string", format: "uri-reference", "x-shellx-media": true };
  return { ...base, type: "string" };
}
