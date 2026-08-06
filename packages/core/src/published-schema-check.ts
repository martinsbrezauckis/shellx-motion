/**
 * Minimal, dependency-free JSON Schema (2020-12 subset) checker used to verify that the repo's
 * PUBLISHED `schemas/*.schema.json` files actually accept/reject the documents their code-side
 * authorities (the hand-written validators in `validate.ts` and the connector parsers) accept/reject.
 *
 * Why this exists: the runtime validation in this codebase is deliberately hand-written rather than
 * ajv-based, so no JSON Schema evaluator is available to test the published schemas against. Rather
 * than add a dependency, this module implements exactly the keyword subset the published schemas use.
 * It is intentionally NOT a general-purpose validator: it throws on any keyword it does not
 * understand, so a schema can never silently rely on an unimplemented constraint (which would give
 * false confidence). It is used by the schema drift tests and by scripts/generate-public-contracts.ts
 * in --check mode. It is not part of the render/validation hot path.
 *
 * Supported keywords: type, const, enum, required, properties, additionalProperties (boolean or
 * schema), items (single schema), minLength, minItems, minimum, maximum, exclusiveMinimum,
 * exclusiveMaximum, pattern, allOf, anyOf, oneOf, if/then/else, and `$ref` to local `#/$defs/<name>`.
 * Ignored (metadata): $schema, $id, $comment, title, description, examples, default, $defs.
 */

/** A JSON Schema document (subset) as a plain JSON object. */
export type JsonSchemaDocument = Record<string, unknown>;

const METADATA_KEYWORDS = new Set(["$schema", "$id", "$comment", "title", "description", "examples", "default", "$defs"]);
const SUPPORTED_KEYWORDS = new Set([
  "type", "const", "enum", "required", "properties", "additionalProperties", "items",
  "minLength", "minItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "allOf", "anyOf", "oneOf", "if", "then", "else"
]);

/**
 * Validate `value` against `schema`, returning a list of human-readable error paths/messages.
 * An empty array means the document is valid under the supported keyword subset.
 *
 * @param schema The JSON Schema (subset) document. Its `$defs` are used to resolve local `$ref`s.
 * @param value The document to validate.
 * @returns Array of `{ path, message }` errors; empty when valid.
 * @throws If the schema uses a keyword this checker does not implement.
 */
export function validateAgainstPublishedSchema(
  schema: JsonSchemaDocument,
  value: unknown
): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  checkNode(schema, value, "", schema, errors);
  return errors;
}

/** Convenience wrapper: true when the value is valid under the schema. */
export function isValidAgainstPublishedSchema(schema: JsonSchemaDocument, value: unknown): boolean {
  return validateAgainstPublishedSchema(schema, value).length === 0;
}

function checkNode(
  node: JsonSchemaDocument,
  value: unknown,
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>
): void {
  if ("$ref" in node) {
    const ref = node.$ref;
    if (typeof ref !== "string") throw new Error(`Unsupported $ref at ${path}: must be a string.`);
    checkNode(resolveRef(ref, root), value, path, root, errors);
    return;
  }
  assertSupportedKeywords(node, path);

  if ("const" in node && !deepEqual(value, node.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(node.const)}` });
  }
  if (Array.isArray(node.enum) && !node.enum.some((option) => deepEqual(option, value))) {
    errors.push({ path, message: `must be one of ${JSON.stringify(node.enum)}` });
  }
  if ("type" in node && !matchesType(node.type, value)) {
    errors.push({ path, message: `must be of type ${JSON.stringify(node.type)}` });
    // If the fundamental type is wrong, deeper structural checks would only add noise.
    return;
  }

  if (typeof value === "string") checkString(node, value, path, errors);
  if (typeof value === "number") checkNumber(node, value, path, errors);
  if (Array.isArray(value)) checkArray(node, value, path, root, errors);
  if (isPlainObject(value)) checkObject(node, value, path, root, errors);

  checkCombinators(node, value, path, root, errors);
}

/**
 * Longest `pattern` this checker will compile.
 *
 * Every pattern in the repository's own schemas is well under this (the longest is
 * `^quality/(?!.*\.\.)[^/].*$`). The bound exists for the case this module cannot see: it is exported
 * from `@shellx-motion/core`, so a consumer can hand it a schema it did not author.
 */
const MAX_SCHEMA_PATTERN_LENGTH = 200;

/**
 * Constructs that make backtracking super-linear, in the two shapes that actually cause it:
 *
 *   1. a quantified group that already contains a quantifier — `(a+)+`, `(\w+\s?)*`;
 *   2. a quantified group containing an alternation — `(a|a)*`, the ambiguous-alternation case.
 *
 * Unbounded `*`/`+` only. A `?` or a bounded `{n,m}` on such a group cannot blow up, which matters
 * because the repository's own patterns do use `(\.d)?` and `(ts|tsx|js)` under `?` — refusing those
 * would break real validation to prevent an impossible attack.
 */
const NESTED_QUANTIFIER = /\([^)]*[*+][^)]*\)\s*[*+]|\([^)]*\|[^)]*\)\s*[*+]/;

function checkString(node: JsonSchemaDocument, value: string, path: string, errors: Array<{ path: string; message: string }>): void {
  if (typeof node.minLength === "number" && value.length < node.minLength) {
    errors.push({ path, message: `must be at least ${node.minLength} character(s)` });
  }
  if (typeof node.pattern === "string") {
    // Refuse a pattern this checker cannot evaluate safely, exactly as it refuses a keyword it does
    // not implement. `new RegExp(node.pattern)` compiles and runs schema-supplied source: in-repo the
    // schemas are ours, but this module is exported, and running an arbitrary caller-supplied regex
    // over caller-supplied input is a denial-of-service primitive. Throwing keeps this module's one
    // promise — that it never reports "valid" for something it did not actually check.
    if (node.pattern.length > MAX_SCHEMA_PATTERN_LENGTH) {
      throw new Error(`published-schema-check: pattern at ${path} exceeds ${MAX_SCHEMA_PATTERN_LENGTH} characters and was not evaluated.`);
    }
    if (NESTED_QUANTIFIER.test(node.pattern)) {
      throw new Error(`published-schema-check: pattern at ${path} nests quantifiers and was not evaluated; rewrite it without a quantified group inside a quantifier.`);
    }
    if (!new RegExp(node.pattern).test(value)) {
      errors.push({ path, message: `must match pattern ${node.pattern}` });
    }
  }
}

function checkNumber(node: JsonSchemaDocument, value: number, path: string, errors: Array<{ path: string; message: string }>): void {
  if (typeof node.minimum === "number" && value < node.minimum) {
    errors.push({ path, message: `must be >= ${node.minimum}` });
  }
  if (typeof node.maximum === "number" && value > node.maximum) {
    errors.push({ path, message: `must be <= ${node.maximum}` });
  }
  if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) {
    errors.push({ path, message: `must be > ${node.exclusiveMinimum}` });
  }
  if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) {
    errors.push({ path, message: `must be < ${node.exclusiveMaximum}` });
  }
}

function checkArray(
  node: JsonSchemaDocument,
  value: unknown[],
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>
): void {
  if (typeof node.minItems === "number" && value.length < node.minItems) {
    errors.push({ path, message: `must contain at least ${node.minItems} item(s)` });
  }
  if (isPlainObject(node.items)) {
    value.forEach((item, index) => checkNode(node.items as JsonSchemaDocument, item, `${path}/${index}`, root, errors));
  }
}

function checkObject(
  node: JsonSchemaDocument,
  value: Record<string, unknown>,
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>
): void {
  const properties = isPlainObject(node.properties) ? node.properties as Record<string, JsonSchemaDocument> : {};
  if (Array.isArray(node.required)) {
    for (const key of node.required) {
      if (typeof key === "string" && !(key in value)) {
        errors.push({ path: `${path}/${key}`, message: "required" });
      }
    }
  }
  for (const [key, propValue] of Object.entries(value)) {
    const propSchema = properties[key];
    if (propSchema) {
      checkNode(propSchema, propValue, `${path}/${key}`, root, errors);
      continue;
    }
    if (node.additionalProperties === false) {
      errors.push({ path: `${path}/${key}`, message: "unexpected property" });
    } else if (isPlainObject(node.additionalProperties)) {
      checkNode(node.additionalProperties as JsonSchemaDocument, propValue, `${path}/${key}`, root, errors);
    }
  }
}

function checkCombinators(
  node: JsonSchemaDocument,
  value: unknown,
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>
): void {
  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf) checkNode(sub as JsonSchemaDocument, value, path, root, errors);
  }
  if (Array.isArray(node.anyOf)) {
    const anyOk = node.anyOf.some((sub) => validateSubtree(sub as JsonSchemaDocument, value, root).length === 0);
    if (!anyOk) errors.push({ path, message: "must match at least one anyOf schema" });
  }
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((sub) => validateSubtree(sub as JsonSchemaDocument, value, root).length === 0).length;
    if (matches !== 1) errors.push({ path, message: `must match exactly one oneOf schema (matched ${matches})` });
  }
  if (isPlainObject(node.if)) {
    const ifPasses = validateSubtree(node.if as JsonSchemaDocument, value, root).length === 0;
    const branch = ifPasses ? node.then : node.else;
    if (isPlainObject(branch)) checkNode(branch as JsonSchemaDocument, value, path, root, errors);
  }
}

function validateSubtree(node: JsonSchemaDocument, value: unknown, root: JsonSchemaDocument): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  checkNode(node, value, "", root, errors);
  return errors;
}

function resolveRef(ref: string, root: JsonSchemaDocument): JsonSchemaDocument {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported $ref '${ref}': only local #/$defs/<name> references are supported.`);
  const name = ref.slice(prefix.length);
  const defs = isPlainObject(root.$defs) ? root.$defs as Record<string, unknown> : {};
  const target = defs[name];
  if (!isPlainObject(target)) throw new Error(`Unresolved $ref '${ref}'.`);
  return target as JsonSchemaDocument;
}

function assertSupportedKeywords(node: JsonSchemaDocument, path: string): void {
  for (const key of Object.keys(node)) {
    if (METADATA_KEYWORDS.has(key) || SUPPORTED_KEYWORDS.has(key)) continue;
    throw new Error(`Unsupported JSON Schema keyword '${key}' at ${path || "<root>"}.`);
  }
}

function matchesType(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesSingleType(candidate, value));
}

function matchesSingleType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: throw new Error(`Unsupported JSON Schema type '${String(type)}'.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}
