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
 * false confidence). It is the stage-one structural validator in Motion's runtime two-stage
 * validation path, and is also used by schema drift tests and by
 * scripts/generate-public-contracts.ts in --check mode. It is not part of the render hot path.
 *
 * Supported keywords: type, const, enum, required, properties, additionalProperties (boolean or
 * schema), items (single schema), minLength, maxLength, minItems, maxItems, uniqueItems, minimum, maximum, exclusiveMinimum,
 * exclusiveMaximum, pattern, allOf, anyOf, oneOf, if/then/else, and `$ref` to local
 * `#/$defs/<name>` definitions or an explicit caller-supplied published-schema resolver.
 * Ignored (metadata): $schema, $id, $comment, title, description, examples, default, $defs.
 */
import { isCanonicalMotionEffectModuleVersion, MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN } from "./effect-module";
import { checkUniqueJsonItems } from "./published-schema-unique-items";
import { isSupportedFunctionalEasing, MOTION_FUNCTIONAL_EASING_PATTERN } from "./functional-easing";
import { isMotionPublishedSchema } from "./motion-scene3d-animation-root-preflight";
import { motionDocumentRootPreflight } from "./motion-document-root-preflight";
/** A JSON Schema document (subset) as a plain JSON object. */
export type JsonSchemaDocument = Record<string, unknown>;
/** Resolve a non-local JSON Schema reference for a composed published contract. */
export type PublishedSchemaResolver = (ref: string) => JsonSchemaDocument | undefined;

const METADATA_KEYWORDS = new Set(["$schema", "$id", "$comment", "title", "description", "examples", "default", "$defs"]);
const SUPPORTED_KEYWORDS = new Set([
  "type", "const", "enum", "required", "properties", "additionalProperties", "items",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "allOf", "anyOf", "oneOf", "if", "then", "else"
]);

/**
 * Validate `value` against `schema`, returning a list of human-readable error paths/messages.
 * An empty array means the document is valid under the supported keyword subset.
 *
 * @param schema The JSON Schema (subset) document. Its `$defs` resolve local `$ref`s.
 * @param value The document to validate.
 * @param resolveExternalRef Optional resolver for relative references to other published schemas.
 * @returns Array of `{ path, message }` errors; empty when valid.
 * @throws If the schema uses a keyword this checker does not implement.
 */
export function validateAgainstPublishedSchema(
  schema: JsonSchemaDocument,
  value: unknown,
  resolveExternalRef?: PublishedSchemaResolver
): Array<{ path: string; message: string }> {
  if (isMotionPublishedSchema(schema)) { const rootProblem = motionDocumentRootPreflight(value); if (rootProblem) return [rootProblem]; }
  const errors: Array<{ path: string; message: string }> = [];
  checkNode(schema, value, "", schema, errors, resolveExternalRef);
  return errors;
}

/** Convenience wrapper: true when the value is valid under the schema. */
export function isValidAgainstPublishedSchema(
  schema: JsonSchemaDocument,
  value: unknown,
  resolveExternalRef?: PublishedSchemaResolver
): boolean {
  return validateAgainstPublishedSchema(schema, value, resolveExternalRef).length === 0;
}

function checkNode(
  node: JsonSchemaDocument,
  value: unknown,
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>,
  resolveExternalRef?: PublishedSchemaResolver
): void {
  if ("$ref" in node) {
    const ref = node.$ref;
    if (typeof ref !== "string") throw new Error(`Unsupported $ref at ${path}: must be a string.`);
    const resolved = resolveRef(ref, root, resolveExternalRef);
    checkNode(resolved.node, value, path, resolved.root, errors, resolveExternalRef);
    return;
  }
  assertSupportedKeywords(node, path);
  if ("maxItems" in node && (!Number.isSafeInteger(node.maxItems) || (node.maxItems as number) < 0)) {
    throw new Error(`published-schema-check: maxItems at ${path} must be a non-negative safe integer.`);
  }
  if ("maxLength" in node && (!Number.isSafeInteger(node.maxLength) || (node.maxLength as number) < 0)) {
    throw new Error(`published-schema-check: maxLength at ${path} must be a non-negative safe integer.`);
  }
  if ("uniqueItems" in node && typeof node.uniqueItems !== "boolean") {
    throw new Error(`published-schema-check: uniqueItems at ${path} must be a boolean.`);
  }

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
  if (Array.isArray(value)) checkArray(node, value, path, root, errors, resolveExternalRef);
  if (isPlainObject(value)) checkObject(node, value, path, root, errors, resolveExternalRef);

  checkCombinators(node, value, path, root, errors, resolveExternalRef);
}

/**
 * Exact precompiled patterns used by Motion's published schemas.
 *
 * This checker is intentionally not a general JSON Schema evaluator. Keeping the closed set as
 * regex literals means a caller can never make this exported helper compile caller-selected regex
 * source. A new published-schema pattern therefore needs an explicit source review and code change,
 * just like a new supported JSON Schema keyword.
 */
const PUBLISHED_SCHEMA_PATTERNS = new Map<string, RegExp | typeof isSupportedFunctionalEasing>([
  ["^#[0-9A-F]{8}$", /^#[0-9A-F]{8}$/],
  ["^#[0-9A-Fa-f]{6}$", /^#[0-9A-Fa-f]{6}$/],
  ["^#[0-9a-fA-F]{6}$", /^#[0-9a-fA-F]{6}$/],
  ["^#[0-9a-f]{6}$", /^#[0-9a-f]{6}$/],
  ["^(?!/)(?!.*(?:^|/)\\.\\.?/)[a-zA-Z0-9._/-]+$", /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9._\/-]+$/],
  ["^/", /^\//],
  ["^/[A-Za-z0-9_~./-]+$", /^\/[A-Za-z0-9_~.\/-]+$/],
  ["^[1-9][0-9]*:[1-9][0-9]*$", /^[1-9][0-9]*:[1-9][0-9]*$/],
  ["^[A-Fa-f0-9]{64}$", /^[A-Fa-f0-9]{64}$/],
  ["^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$", /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/],
  ["^[A-Za-z0-9][A-Za-z0-9._-]*$", /^[A-Za-z0-9][A-Za-z0-9._-]*$/],
  ["^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/],
  ["^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/],
  ["^[a-f0-9]{64}$", /^[a-f0-9]{64}$/],
  ["^[a-fA-F0-9]{64}$", /^[a-fA-F0-9]{64}$/],
  ["^[a-z0-9-]{1,100}$", /^[a-z0-9-]{1,100}$/],
  ["^[a-z]+/[a-z0-9.+-]+$", /^[a-z]+\/[a-z0-9.+-]+$/],
  ["^[a-z][a-z0-9-]{0,127}$", /^[a-z][a-z0-9-]{0,127}$/],
  ["^[a-z][a-z0-9.-]{0,63}/[a-z][a-z0-9._/-]{0,95}@[0-9]{1,8}$", /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9._\/-]{0,95}@[0-9]{1,8}$/],
  ["^[a-z][a-z0-9.-]{0,79}@[1-9][0-9]*$", /^[a-z][a-z0-9.-]{0,79}@[1-9][0-9]*$/],
  ["^[a-z][a-z0-9.-]{0,99}@[1-9][0-9]*$", /^[a-z][a-z0-9.-]{0,99}@[1-9][0-9]*$/],
  ["^[a-z][a-z0-9.-]{1,120}$", /^[a-z][a-z0-9.-]{1,120}$/],
  ["^[a-z][a-z0-9._:-]{0,119}@[0-9]{1,8}$", /^[a-z][a-z0-9._:-]{0,119}@[0-9]{1,8}$/],
  ["^[a-z][a-z0-9._:-]{0,127}$", /^[a-z][a-z0-9._:-]{0,127}$/],
  ["^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$", /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$/],
  ["^[a-z][a-z0-9_.:-]{0,95}$", /^[a-z][a-z0-9_.:-]{0,95}$/],
  ["^\\.[a-z0-9]{1,16}$", /^\.[a-z0-9]{1,16}$/],
  ["^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$", /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/],
  ["^artifact-[a-f0-9]{24}$", /^artifact-[a-f0-9]{24}$/],
  ["^checkpoint_storyboard_[a-f0-9]{32}$", /^checkpoint_storyboard_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$", /^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_endpoint_witness_handle_[a-f0-9]{32}$", /^checkpoint_storyboard_endpoint_witness_handle_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_preview_[a-f0-9]{32}$", /^checkpoint_storyboard_preview_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$", /^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$", /^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$", /^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$/],
  ["^checkpoint_storyboard_retained_trace_review_handle_[a-f0-9]{32}$", /^checkpoint_storyboard_retained_trace_review_handle_[a-f0-9]{32}$/],
  [MOTION_FUNCTIONAL_EASING_PATTERN, isSupportedFunctionalEasing],
  ["^cubic-bezier\\(", /^cubic-bezier\(/],
  ["^https?://", /^https?:\/\//],
  ["^quality/(?!.*\\.\\.)[^/].*$", /^quality\/(?!.*\.\.)[^\/].*$/],
  ["^segments/segment-[0-9]{6}\\.[a-z0-9]{1,16}$", /^segments\/segment-[0-9]{6}\.[a-z0-9]{1,16}$/],
  ["^steps\\(", /^steps\(/],
]);

function checkString(node: JsonSchemaDocument, value: string, path: string, errors: Array<{ path: string; message: string }>): void {
  const scalarLength = Array.from(value).length;
  if (typeof node.minLength === "number" && scalarLength < node.minLength) {
    errors.push({ path, message: `must be at least ${node.minLength} character(s)` });
  }
  if (typeof node.maxLength === "number" && scalarLength > node.maxLength) { errors.push({ path, message: `must contain at most ${node.maxLength} character(s)` }); return; }
  if (typeof node.pattern === "string") {
    if (node.pattern === MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN) {
      if (!isCanonicalMotionEffectModuleVersion(value)) errors.push({ path, message: `must match pattern ${node.pattern}` });
      return;
    }
    const pattern = PUBLISHED_SCHEMA_PATTERNS.get(node.pattern);
    if (!pattern) {
      throw new Error(`published-schema-check: pattern at ${path} is not one of Motion's reviewed published-schema patterns and was not evaluated.`);
    }
    const matches = pattern instanceof RegExp ? pattern.test(value) : pattern(value);
    if (!matches) {
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
  errors: Array<{ path: string; message: string }>,
  resolveExternalRef?: PublishedSchemaResolver
): void {
  if (typeof node.minItems === "number" && value.length < node.minItems) {
    errors.push({ path, message: `must contain at least ${node.minItems} item(s)` });
  }
  if (typeof node.maxItems === "number" && value.length > node.maxItems) {
    errors.push({ path, message: `must contain at most ${node.maxItems} item(s)` });
  }
  if (node.uniqueItems === true) checkUniqueJsonItems(value, path, errors);
  if (isPlainObject(node.items)) {
    value.forEach((item, index) => checkNode(node.items as JsonSchemaDocument, item, `${path}/${index}`, root, errors, resolveExternalRef));
  }
}

function checkObject(
  node: JsonSchemaDocument,
  value: Record<string, unknown>,
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>,
  resolveExternalRef?: PublishedSchemaResolver
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
      checkNode(propSchema, propValue, `${path}/${key}`, root, errors, resolveExternalRef);
      continue;
    }
    if (node.additionalProperties === false) {
      errors.push({ path: `${path}/${key}`, message: "unexpected property" });
    } else if (isPlainObject(node.additionalProperties)) {
      checkNode(node.additionalProperties as JsonSchemaDocument, propValue, `${path}/${key}`, root, errors, resolveExternalRef);
    }
  }
}

function checkCombinators(
  node: JsonSchemaDocument,
  value: unknown,
  path: string,
  root: JsonSchemaDocument,
  errors: Array<{ path: string; message: string }>,
  resolveExternalRef?: PublishedSchemaResolver
): void {
  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf) checkNode(sub as JsonSchemaDocument, value, path, root, errors, resolveExternalRef);
  }
  if (Array.isArray(node.anyOf)) {
    const anyOk = node.anyOf.some((sub) => validateSubtree(sub as JsonSchemaDocument, value, root, resolveExternalRef).length === 0);
    if (!anyOk) errors.push({ path, message: "must match at least one anyOf schema" });
  }
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((sub) => validateSubtree(sub as JsonSchemaDocument, value, root, resolveExternalRef).length === 0).length;
    if (matches !== 1) errors.push({ path, message: `must match exactly one oneOf schema (matched ${matches})` });
  }
  if (isPlainObject(node.if)) {
    const ifPasses = validateSubtree(node.if as JsonSchemaDocument, value, root, resolveExternalRef).length === 0;
    const branch = ifPasses ? node.then : node.else;
    if (isPlainObject(branch)) checkNode(branch as JsonSchemaDocument, value, path, root, errors, resolveExternalRef);
  }
}

function validateSubtree(
  node: JsonSchemaDocument,
  value: unknown,
  root: JsonSchemaDocument,
  resolveExternalRef?: PublishedSchemaResolver
): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  checkNode(node, value, "", root, errors, resolveExternalRef);
  return errors;
}

function resolveRef(
  ref: string,
  root: JsonSchemaDocument,
  resolveExternalRef?: PublishedSchemaResolver
): { node: JsonSchemaDocument; root: JsonSchemaDocument } {
  const prefix = "#/$defs/";
  if (ref.startsWith(prefix)) {
    const name = ref.slice(prefix.length);
    const defs = isPlainObject(root.$defs) ? root.$defs as Record<string, unknown> : {};
    const target = defs[name];
    if (!isPlainObject(target)) throw new Error(`Unresolved $ref '${ref}'.`);
    return { node: target as JsonSchemaDocument, root };
  }
  const external = resolveExternalRef?.(ref);
  if (!external) throw new Error(`Unsupported $ref '${ref}': provide a published-schema resolver for non-local references.`);
  return { node: external, root: external };
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
