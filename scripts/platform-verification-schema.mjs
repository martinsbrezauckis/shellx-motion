import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("../schemas/platform-verification.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const metadataKeywords = new Set(["$schema", "$id", "$comment", "title", "description", "examples", "default"]);
const supportedKeywords = new Set([
  "type", "const", "enum", "required", "properties", "additionalProperties", "items",
  "minLength", "minItems", "minimum"
]);

/** Validate one platform receipt against the complete published schema subset used by that contract. */
export function validatePlatformVerificationReceipt(value) {
  const errors = [];
  checkNode(schema, value, "", errors);
  return errors;
}

function checkNode(node, value, path, errors) {
  assertSupportedKeywords(node, path);
  if (Object.hasOwn(node, "const") && !deepEqual(value, node.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(node.const)}` });
  }
  if (Array.isArray(node.enum) && !node.enum.some((candidate) => deepEqual(value, candidate))) {
    errors.push({ path, message: `must be one of ${JSON.stringify(node.enum)}` });
  }
  if (Object.hasOwn(node, "type") && !matchesType(node.type, value)) {
    errors.push({ path, message: `must be of type ${JSON.stringify(node.type)}` });
    return;
  }
  if (typeof value === "string" && typeof node.minLength === "number" && [...value].length < node.minLength) {
    errors.push({ path, message: `must be at least ${node.minLength} character(s)` });
  }
  if (typeof value === "number" && typeof node.minimum === "number" && value < node.minimum) {
    errors.push({ path, message: `must be >= ${node.minimum}` });
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      errors.push({ path, message: `must contain at least ${node.minItems} item(s)` });
    }
    if (isRecord(node.items)) value.forEach((entry, index) => checkNode(node.items, entry, `${path}/${index}`, errors));
  }
  if (isRecord(value)) checkObject(node, value, path, errors);
}

function checkObject(node, value, path, errors) {
  const properties = isRecord(node.properties) ? node.properties : {};
  if (Array.isArray(node.required)) {
    for (const key of node.required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) errors.push({ path: `${path}/${key}`, message: "required" });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (isRecord(properties[key])) {
      checkNode(properties[key], child, `${path}/${key}`, errors);
    } else if (node.additionalProperties === false) {
      errors.push({ path: `${path}/${key}`, message: "unexpected property" });
    } else if (isRecord(node.additionalProperties)) {
      checkNode(node.additionalProperties, child, `${path}/${key}`, errors);
    }
  }
}

function assertSupportedKeywords(node, path) {
  for (const key of Object.keys(node)) {
    if (!metadataKeywords.has(key) && !supportedKeywords.has(key)) {
      throw new Error(`Unsupported platform receipt schema keyword '${key}' at ${path || "<root>"}.`);
    }
  }
}

function matchesType(type, value) {
  if (Array.isArray(type)) return type.some((candidate) => matchesType(candidate, value));
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  throw new Error(`Unsupported platform receipt schema type '${String(type)}'.`);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
