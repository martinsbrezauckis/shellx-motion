/** Recursive, closed-object validation shared by top-level and nested MCP tool arguments. */
import type { MotionDebugArgPropertySchema, MotionDebugArgsSchema } from "@shellx-motion/debug-api";
import type { McpArgViolation } from "./mcp-args-validation.js";

type DeclaredType = MotionDebugArgPropertySchema["type"];

/** Every supplied argument that disagrees with the published schema, in stable order. */
export function argumentProblems(schema: MotionDebugArgsSchema, args: Record<string, unknown>): McpArgViolation[] {
  const properties = schema.properties ?? {};
  const violations: McpArgViolation[] = [];
  for (const required of schema.required ?? []) {
    const accepted = namesSatisfying(required, properties);
    if (accepted.some((name) => suppliedValue(args, name) !== undefined)) continue;
    violations.push({
      argument: required,
      kind: "missing_required",
      ...(properties[required]?.type ? { expectedType: properties[required].type } : {}),
      ...(allowedValuesFor(properties[required]) ? { allowedValues: allowedValuesFor(properties[required]) as string[] } : {})
    });
  }
  const resolvers = propertyResolvers(properties);
  for (const name of Object.keys(args)) {
    const value = suppliedValue(args, name);
    if (value === undefined) continue;
    const property = resolvers.get(name);
    if (!property) {
      if (schema.additionalProperties === false) {
        const suggestion = nearestName(name, [...resolvers.keys()]);
        violations.push({ argument: name, kind: "unknown_property", receivedType: jsonTypeOf(value), ...(suggestion ? { didYouMean: suggestion } : {}) });
      }
      continue;
    }
    violations.push(...valueProblems(property, value, name));
  }
  return violations;
}

/** Validate one declared value, including recursively closed nested data records. */
function valueProblems(property: MotionDebugArgPropertySchema, value: unknown, argument: string): McpArgViolation[] {
  if (!matchesDeclaredType(value, property.type)) {
    return [{ argument, kind: "wrong_type", expectedType: property.type, receivedType: jsonTypeOf(value), ...scalarEcho(value) }];
  }
  const allowed = allowedValuesFor(property);
  if (allowed && typeof value === "string" && !allowed.includes(value)) {
    return [{ argument, kind: "bad_enum_value", receivedType: "string", receivedValue: value, allowedValues: allowed }];
  }
  if (typeof property.minimum === "number" && typeof value === "number" && value < property.minimum) {
    return [{ argument, kind: "below_minimum", receivedType: "number", receivedValue: value, minimum: property.minimum }];
  }
  if (typeof property.maximum === "number" && typeof value === "number" && value > property.maximum) {
    return [{ argument, kind: "above_maximum", receivedType: "number", receivedValue: value, maximum: property.maximum }];
  }
  if (typeof property.maxLength === "number" && typeof value === "string" && Array.from(value).length > property.maxLength) {
    return [{ argument, kind: "above_max_length", receivedType: "string", ...scalarEcho(value), maxLength: property.maxLength }];
  }
  if (typeof property.minLength === "number" && typeof value === "string" && Array.from(value).length < property.minLength) {
    return [{ argument, kind: "below_min_length", receivedType: "string", ...scalarEcho(value), minLength: property.minLength }];
  }
  if (typeof property.pattern === "string" && typeof value === "string" && !new RegExp(property.pattern, "u").test(value)) {
    return [{ argument, kind: "bad_pattern", receivedType: "string", ...scalarEcho(value), pattern: property.pattern }];
  }
  if (typeof property.multipleOf === "number" && typeof value === "number" && value % property.multipleOf !== 0) {
    return [{ argument, kind: "not_multiple_of", receivedType: "number", receivedValue: value, multipleOf: property.multipleOf }];
  }
  if (typeof property.exclusiveMinimum === "number" && typeof value === "number" && value <= property.exclusiveMinimum) {
    return [{ argument, kind: "not_above_exclusive_minimum", receivedType: "number", receivedValue: value, minimum: property.exclusiveMinimum }];
  }
  if (Array.isArray(value)) {
    if (typeof property.minItems === "number" && value.length < property.minItems) {
      return [{ argument, kind: "below_minimum", receivedType: "array", receivedValue: value.length, minimum: property.minItems }];
    }
    if (typeof property.maxItems === "number" && value.length > property.maxItems) {
      return [{ argument, kind: "above_maximum", receivedType: "array", receivedValue: value.length, maximum: property.maxItems }];
    }
    if (!property.items) return [];
    return value.flatMap((entry, index) => valueProblems(property.items!, entry, `${argument}[${index}]`));
  }
  if (property.oneOf?.length) {
    const alternatives = property.oneOf.map((candidate) => valueProblems(candidate, value, argument));
    if (alternatives.some((problems) => problems.length === 0)) return [];
    // Every alternative is closed and typed. Returning the shortest deterministic failure gives
    // callers a concrete repair without allowing an unknown shape through the transport gate.
    return alternatives.reduce((best, candidate) => candidate.length < best.length ? candidate : best);
  }
  if (!declaresType(property.type, "object") || !property.properties) return [];
  const object = plainObject(value);
  if (!object) return [];
  const properties = property.properties;
  const violations: McpArgViolation[] = [];
  for (const required of property.required ?? []) {
    const accepted = namesSatisfying(required, properties);
    if (accepted.some((name) => suppliedValue(object, name) !== undefined)) continue;
    violations.push({
      argument: `${argument}.${required}`,
      kind: "missing_required",
      ...(properties[required]?.type ? { expectedType: properties[required].type } : {}),
      ...(allowedValuesFor(properties[required]) ? { allowedValues: allowedValuesFor(properties[required]) as string[] } : {})
    });
  }
  const resolvers = propertyResolvers(properties);
  for (const name of Object.keys(object)) {
    const nestedValue = suppliedValue(object, name);
    if (nestedValue === undefined) continue;
    const nested = resolvers.get(name);
    const nestedArgument = `${argument}.${name}`;
    if (!nested) {
      if (property.additionalProperties === false) {
        const suggestion = nearestName(name, [...resolvers.keys()]);
        violations.push({ argument: nestedArgument, kind: "unknown_property", receivedType: jsonTypeOf(nestedValue), ...(suggestion ? { didYouMean: suggestion } : {}) });
      }
      continue;
    }
    violations.push(...valueProblems(nested, nestedValue, nestedArgument));
  }
  return violations;
}

function declaresType(declared: DeclaredType, type: "object"): boolean {
  return (Array.isArray(declared) ? declared : [declared]).includes(type);
}

function propertyResolvers(properties: Record<string, MotionDebugArgPropertySchema>): Map<string, MotionDebugArgPropertySchema> {
  const resolvers = new Map<string, MotionDebugArgPropertySchema>();
  for (const [name, property] of Object.entries(properties)) resolvers.set(name, property);
  for (const [, property] of Object.entries(properties)) {
    for (const alias of property.aliases ?? []) if (!resolvers.has(alias)) resolvers.set(alias, property);
  }
  return resolvers;
}

function namesSatisfying(required: string, properties: Record<string, MotionDebugArgPropertySchema>): string[] {
  const names = new Set<string>([required]);
  for (const alias of properties[required]?.aliases ?? []) names.add(alias);
  for (const [name, property] of Object.entries(properties)) {
    if (proseAliasTarget(property.description) !== required) continue;
    names.add(name);
    for (const alias of property.aliases ?? []) names.add(alias);
  }
  return [...names];
}

function proseAliasTarget(description: string | undefined): string | null {
  const match = description ? /^alias for ([A-Za-z0-9_]+)/i.exec(description.trim()) : null;
  return match ? match[1] : null;
}

function suppliedValue(args: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(args, name)) return undefined;
  const value = args[name];
  return value === null ? undefined : value;
}

function allowedValuesFor(property: MotionDebugArgPropertySchema | undefined): string[] | null {
  return property?.enum ? [...property.enum] : null;
}

function matchesDeclaredType(value: unknown, declared: DeclaredType): boolean {
  const accepted = Array.isArray(declared) ? declared : [declared];
  return accepted.some((type) => {
    switch (type) {
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "array": return Array.isArray(value);
      case "object": return plainObject(value) !== null;
      default: return false;
    }
  });
}

export function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function scalarEcho(value: unknown): { receivedValue?: string | number | boolean } {
  if (typeof value === "number" || typeof value === "boolean") return { receivedValue: value };
  if (typeof value === "string") return { receivedValue: value.length <= 120 ? value : `${value.slice(0, 117)}...` };
  return {};
}

export function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function nearestName(supplied: string, candidates: readonly string[]): string | null {
  const limit = supplied.length <= 4 ? 1 : 2;
  let best: { name: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(supplied.toLowerCase(), candidate.toLowerCase());
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best ? best.name : null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length];
}
