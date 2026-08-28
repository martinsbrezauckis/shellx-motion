/** Bounded, deterministic JSON-value equality for the published-schema `uniqueItems` subset. */
const MAX_UNIQUE_ITEMS = 4_096;
const MAX_CANONICAL_NODES = 16_384;
const MAX_CANONICAL_CHARACTERS = 1_048_576;
const MAX_JSON_DEPTH = 64;

type ErrorEntry = { path: string; message: string };
type Budget = { nodes: number; characters: number };

export function checkUniqueJsonItems(value: unknown[], path: string, errors: ErrorEntry[]): void {
  if (value.length > MAX_UNIQUE_ITEMS) throw uniqueItemsLimit(path, `has more than ${MAX_UNIQUE_ITEMS} items`);
  const seen = new Set<string>();
  const budget: Budget = { nodes: 0, characters: 0 };
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}/${index}`;
    const fingerprint = canonicalJsonValue(value[index], itemPath, budget, new Set(), 0);
    if (seen.has(fingerprint)) errors.push({ path: itemPath, message: "must contain unique items" });
    else seen.add(fingerprint);
  }
}

function canonicalJsonValue(value: unknown, path: string, budget: Budget, active: Set<object>, depth: number): string {
  if (depth > MAX_JSON_DEPTH) throw uniqueItemsLimit(path, `exceeds JSON nesting depth ${MAX_JSON_DEPTH}`);
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) throw uniqueItemsLimit(path, `exceeds ${MAX_CANONICAL_NODES} JSON value nodes`);
  const parts: string[] = [];
  encodeJsonValue(value, path, budget, active, depth, parts);
  return parts.join("");
}

function encodeJsonValue(value: unknown, path: string, budget: Budget, active: Set<object>, depth: number, parts: string[]): void {
  if (value === null) return append("null", path, budget, parts);
  if (typeof value === "string") return append(JSON.stringify(value), path, budget, parts);
  if (typeof value === "boolean") return append(value ? "true" : "false", path, budget, parts);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw nonJsonValue(path);
    return append(value === 0 ? "0" : String(value), path, budget, parts);
  }
  if (Array.isArray(value)) {
    if (active.has(value)) throw nonJsonValue(path, "cyclic arrays are not JSON values");
    active.add(value);
    try {
      append("[", path, budget, parts);
      for (let index = 0; index < value.length; index += 1) {
        if (index) append(",", path, budget, parts);
        canonicalJsonValueInto(value[index], `${path}/${index}`, budget, active, depth + 1, parts);
      }
      append("]", path, budget, parts);
    } finally { active.delete(value); }
    return;
  }
  if (!isJsonObject(value)) throw nonJsonValue(path);
  if (active.has(value)) throw nonJsonValue(path, "cyclic objects are not JSON values");
  active.add(value);
  try {
    const keys = ownEnumerableKeys(value, path).sort();
    append("{", path, budget, parts);
    keys.forEach((key, index) => {
      if (index) append(",", path, budget, parts);
      append(JSON.stringify(key), path, budget, parts); append(":", path, budget, parts);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw nonJsonValue(`${path}/${key}`, "accessor properties are not JSON values");
      canonicalJsonValueInto(descriptor.value, `${path}/${key}`, budget, active, depth + 1, parts);
    });
    append("}", path, budget, parts);
  } finally { active.delete(value); }
}

function canonicalJsonValueInto(value: unknown, path: string, budget: Budget, active: Set<object>, depth: number, parts: string[]): void {
  if (depth > MAX_JSON_DEPTH) throw uniqueItemsLimit(path, `exceeds JSON nesting depth ${MAX_JSON_DEPTH}`);
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) throw uniqueItemsLimit(path, `exceeds ${MAX_CANONICAL_NODES} JSON value nodes`);
  encodeJsonValue(value, path, budget, active, depth, parts);
}

function ownEnumerableKeys(value: Record<string, unknown>, path: string): string[] {
  const keys: string[] = [];
  for (const key in value) if (Object.prototype.hasOwnProperty.call(value, key)) {
    keys.push(key);
    if (keys.length > MAX_CANONICAL_NODES) throw uniqueItemsLimit(path, `exceeds ${MAX_CANONICAL_NODES} object properties`);
  }
  return keys;
}

function append(part: string, path: string, budget: Budget, parts: string[]): void {
  if (budget.characters > MAX_CANONICAL_CHARACTERS - part.length) throw uniqueItemsLimit(path, `exceeds ${MAX_CANONICAL_CHARACTERS} canonical characters`);
  budget.characters += part.length; parts.push(part);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueItemsLimit(path: string, detail: string): Error {
  return new Error(`published-schema-check: uniqueItems at ${path || "<root>"} ${detail}.`);
}

function nonJsonValue(path: string, detail = "requires JSON values"): Error {
  return new Error(`published-schema-check: uniqueItems at ${path || "<root>"} ${detail}.`);
}
