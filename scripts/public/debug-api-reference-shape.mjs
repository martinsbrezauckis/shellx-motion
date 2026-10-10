/**
 * Bounded, non-executable summaries of canonical Debug API argument metadata.
 *
 * Input is deliberately limited to `JSON.parse` output from the repository-owned
 * `schemas/debug.json`; this module does not accept or claim to defend arbitrary objects, getters,
 * or proxies. The generator bounds that file before parsing. Summaries are descriptive only: the
 * source contract remains authoritative for normalization and dispatch behaviour.
 */

export const NESTED_SHAPE_LIMITS = Object.freeze({
  maxAliases: 32,
  maxBranches: 16,
  maxDepth: 14,
  maxEnumValues: 128,
  maxKeywords: 24,
  maxNodes: 768,
  maxProperties: 96,
  maxRequiredFields: 128,
  maxStringBytes: 512,
  maxSummaryBytes: 8 * 1024,
  maxSummaryDepth: 5,
  maxSummaryLines: 96,
  maxSummaryLineBytes: 480
});

/** Counts every emitted nested-doc line, including headings, prose, links, summaries, and fallbacks. */
export const NESTED_SHAPE_DOCUMENT_LIMITS = Object.freeze({
  maxBytes: 60 * 1024,
  maxNodes: 4_096
});

/** Reserve a fallback for every candidate before any richer block is selected. */
export function reserveNestedFallbackBudget(costs, limits = NESTED_SHAPE_DOCUMENT_LIMITS) {
  let bytes = 0;
  let nodes = 0;
  for (const cost of costs) {
    if (!cost || !Number.isSafeInteger(cost.bytes) || !Number.isSafeInteger(cost.nodes)
      || cost.bytes < 0 || cost.nodes < 0) {
      throw new Error("Nested documentation fallback reservation contains an invalid cost.");
    }
    bytes += cost.bytes;
    nodes += cost.nodes;
    if (bytes > limits.maxBytes || nodes > limits.maxNodes) {
      throw new Error(
        `Nested documentation fallback reservation (${costs.length} candidates, ${nodes} nodes, ${bytes} bytes) exceeds `
        + `the declared global cap (${limits.maxNodes} nodes, ${limits.maxBytes} bytes).`
      );
    }
  }
  return { bytes, nodes };
}

const PROPERTY_KEYWORDS = new Set([
  "additionalProperties",
  "aliases",
  "default",
  "description",
  "enum",
  "enumRef",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type"
]);
const ROOT_KEYWORDS = new Set(["additionalProperties", "anyOf", "oneOf", "properties", "required", "type"]);
const NUMERIC_KEYWORDS = [
  "exclusiveMinimum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf"
];
const PRODUCTION_TYPES = new Set(["array", "boolean", "number", "object", "string"]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function fallback(reason) {
  return { kind: "fallback", reason };
}

function isCanonicalRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value, limit, capReason) {
  if (!isCanonicalRecord(value)) return fallback("noncanonical_metadata");
  const names = Object.keys(value);
  if (names.length > limit) return fallback(capReason);
  return { kind: "complete", names, value };
}

/** The caller supplies canonical parsed arrays, so length is bounded before any element is copied. */
function readArray(value, limit, capReason) {
  if (!Array.isArray(value)) return fallback("invalid_array");
  if (value.length > limit) return fallback(capReason);
  const copied = [];
  for (let index = 0; index < value.length; index += 1) copied.push(value[index]);
  return { kind: "complete", value: copied };
}

function boundedString(value, limits) {
  return typeof value === "string" && byteLength(value) <= limits.maxStringBytes ? value : undefined;
}

function copyStrings(value, state, limit, capReason) {
  const array = readArray(value, limit, capReason);
  if (array.kind === "fallback") return array;
  const copied = [];
  for (const item of array.value) {
    const string = boundedString(item, state.limits);
    if (string === undefined) return fallback("invalid_string");
    copied.push(string);
  }
  return { kind: "complete", value: copied };
}

function hasDuplicate(values) {
  return new Set(values).size !== values.length;
}

function snapshotType(value, state) {
  const types = typeof value === "string"
    ? { kind: "complete", value: [value] }
    : copyStrings(value, state, state.limits.maxEnumValues, "type_cap");
  if (types.kind === "fallback") return types;
  if (types.value.length === 0 || hasDuplicate(types.value)) return fallback("invalid_type");
  for (const type of types.value) {
    if (type === "null") return fallback("unsupported_null_type");
    if (!PRODUCTION_TYPES.has(type)) return fallback("unsupported_type");
  }
  return { kind: "complete", value: typeof value === "string" ? types.value[0] : types.value };
}

function proseAliasTarget(description) {
  if (typeof description !== "string") return null;
  const match = /^alias for ([A-Za-z0-9_]+)/i.exec(description.trim());
  return match ? match[1] : null;
}

function snapshotProperty(value, state, depth) {
  if (!isCanonicalRecord(value)) return fallback("unsupported_boolean_or_noncanonical_schema");
  if (depth > state.limits.maxDepth) return fallback("depth_cap");
  if (state.active.has(value)) return fallback("cyclic_schema");
  const cached = state.properties.get(value);
  if (cached) return { kind: "complete", value: cached };
  if (state.nodes === state.limits.maxNodes) return fallback("node_cap");

  const record = readRecord(value, state.limits.maxKeywords, "keyword_cap");
  if (record.kind === "fallback") return record;
  for (const name of record.names) if (!PROPERTY_KEYWORDS.has(name)) return fallback("unsupported_keyword");
  if (!Object.hasOwn(record.value, "type")) return fallback("missing_property_type");

  state.nodes += 1;
  state.active.add(value);
  try {
    const raw = record.value;
    const node = Object.create(null);
    const type = snapshotType(raw.type, state);
    if (type.kind === "fallback") return type;
    node.type = type.value;

    if (Object.hasOwn(raw, "description") && typeof raw.description !== "string") return fallback("invalid_description");
    const proseAlias = proseAliasTarget(raw.description);
    if (proseAlias !== null) node.proseAlias = proseAlias;
    if (Object.hasOwn(raw, "default") && !["string", "number", "boolean"].includes(typeof raw.default)) return fallback("invalid_default");

    if (Object.hasOwn(raw, "aliases")) {
      const aliases = copyStrings(raw.aliases, state, state.limits.maxAliases, "alias_cap");
      if (aliases.kind === "fallback") return aliases;
      if (hasDuplicate(aliases.value)) return fallback("duplicate_alias");
      node.aliases = aliases.value;
    }
    if (Object.hasOwn(raw, "required")) {
      const required = copyStrings(raw.required, state, state.limits.maxRequiredFields, "required_cap");
      if (required.kind === "fallback") return required;
      if (hasDuplicate(required.value)) return fallback("duplicate_required");
      node.required = required.value;
    }
    if (Object.hasOwn(raw, "enum") && Object.hasOwn(raw, "enumRef")) return fallback("ambiguous_enum");
    if (Object.hasOwn(raw, "enum")) {
      const enumeration = copyStrings(raw.enum, state, state.limits.maxEnumValues, "enum_cap");
      if (enumeration.kind === "fallback") return enumeration;
      if (hasDuplicate(enumeration.value)) return fallback("duplicate_enum");
      node.enum = enumeration.value;
    }
    if (Object.hasOwn(raw, "enumRef")) {
      const enumRef = boundedString(raw.enumRef, state.limits);
      if (enumRef === undefined || !isCanonicalRecord(state.argEnums) || !Object.hasOwn(state.argEnums, enumRef)) {
        return fallback("unknown_enum_ref");
      }
      node.enumRef = enumRef;
    }
    if (Object.hasOwn(raw, "pattern")) {
      const pattern = boundedString(raw.pattern, state.limits);
      if (pattern === undefined) return fallback("invalid_pattern");
      node.pattern = pattern;
    }
    for (const keyword of NUMERIC_KEYWORDS) {
      if (!Object.hasOwn(raw, keyword)) continue;
      if (typeof raw[keyword] !== "number" || !Number.isFinite(raw[keyword])) return fallback("invalid_numeric_keyword");
      node[keyword] = raw[keyword];
    }
    if (Object.hasOwn(raw, "additionalProperties")) {
      if (typeof raw.additionalProperties !== "boolean") return fallback("invalid_additional_properties");
      node.additionalProperties = raw.additionalProperties;
    }
    if (Object.hasOwn(raw, "properties")) {
      const properties = snapshotProperties(raw.properties, state, depth + 1);
      if (properties.kind === "fallback") return properties;
      node.properties = properties.value.properties;
      node.requiredSatisfiers = properties.value.requiredSatisfiers;
      if (node.additionalProperties === false && node.required) {
        for (const name of node.required) if (!Object.hasOwn(node.properties, name)) return fallback("inconsistent_closed_object");
      }
    }
    if (Object.hasOwn(raw, "items")) {
      const items = snapshotProperty(raw.items, state, depth + 1);
      if (items.kind === "fallback") return items;
      node.items = items.value;
    }
    if (Object.hasOwn(raw, "oneOf")) {
      const branches = readArray(raw.oneOf, state.limits.maxBranches, "branch_cap");
      if (branches.kind === "fallback") return branches;
      if (branches.value.length === 0) return fallback("empty_property_oneOf");
      const copied = [];
      for (const branch of branches.value) {
        const child = snapshotProperty(branch, state, depth + 1);
        if (child.kind === "fallback") return child;
        copied.push(child.value);
      }
      node.oneOf = copied;
    }
    state.properties.set(value, node);
    return { kind: "complete", value: node };
  } finally {
    state.active.delete(value);
  }
}

function snapshotProperties(value, state, depth) {
  const record = readRecord(value, state.limits.maxProperties, "property_cap");
  if (record.kind === "fallback") return record;
  const properties = Object.create(null);
  for (const name of record.names) {
    if (boundedString(name, state.limits) === undefined) return fallback("invalid_property_name");
    const child = snapshotProperty(record.value[name], state, depth);
    if (child.kind === "fallback") return child;
    properties[name] = child.value;
  }

  const seen = new Set(record.names);
  for (const name of record.names) {
    for (const alias of properties[name].aliases ?? []) {
      if (seen.has(alias)) return fallback("alias_collision");
      seen.add(alias);
    }
  }
  const requiredSatisfiers = Object.create(null);
  for (const name of record.names) {
    const target = properties[name].proseAlias;
    if (target === undefined) continue;
    // Production treats this phrase as a required-field satisfier only when the target is a
    // sibling property. A phrase inside a root-union branch can name a root-level input that is
    // intentionally outside the branch's tiny `properties` map; it is then descriptive prose,
    // not an alias in this object. Do not invent a relationship or reject that branch.
    if (target === name || !Object.hasOwn(properties, target)) continue;
    const existing = requiredSatisfiers[target] ?? [];
    if (existing.includes(name)) return fallback("duplicate_prose_alias");
    existing.push(name);
    requiredSatisfiers[target] = existing;
  }
  return { kind: "complete", value: { properties, requiredSatisfiers } };
}

function snapshotRoot(value, state, depth) {
  if (!isCanonicalRecord(value)) return fallback("noncanonical_metadata");
  if (depth > state.limits.maxDepth) return fallback("depth_cap");
  if (state.active.has(value)) return fallback("cyclic_schema");
  if (state.nodes === state.limits.maxNodes) return fallback("node_cap");
  const record = readRecord(value, state.limits.maxKeywords, "keyword_cap");
  if (record.kind === "fallback") return record;
  for (const name of record.names) if (!ROOT_KEYWORDS.has(name)) return fallback("unsupported_root_keyword");
  if (record.value.type !== "object") return fallback("invalid_root_type");
  if (!Object.hasOwn(record.value, "properties")) return fallback("missing_root_properties");
  if (Object.hasOwn(record.value, "oneOf") && Object.hasOwn(record.value, "anyOf")) return fallback("ambiguous_root_union");

  state.nodes += 1;
  state.active.add(value);
  try {
    const root = Object.create(null);
    root.type = "object";
    if (Object.hasOwn(record.value, "required")) {
      const required = copyStrings(record.value.required, state, state.limits.maxRequiredFields, "required_cap");
      if (required.kind === "fallback") return required;
      if (hasDuplicate(required.value)) return fallback("duplicate_required");
      root.required = required.value;
    }
    if (Object.hasOwn(record.value, "additionalProperties")) {
      if (typeof record.value.additionalProperties !== "boolean") return fallback("invalid_additional_properties");
      root.additionalProperties = record.value.additionalProperties;
    }
    const properties = snapshotProperties(record.value.properties, state, depth + 1);
    if (properties.kind === "fallback") return properties;
    root.properties = properties.value.properties;
    root.requiredSatisfiers = properties.value.requiredSatisfiers;
    if (root.additionalProperties === false && root.required) {
      for (const name of root.required) if (!Object.hasOwn(root.properties, name)) return fallback("inconsistent_closed_object");
    }
    for (const keyword of ["oneOf", "anyOf"]) {
      if (!Object.hasOwn(record.value, keyword)) continue;
      const branches = readArray(record.value[keyword], state.limits.maxBranches, "branch_cap");
      if (branches.kind === "fallback") return branches;
      if (branches.value.length === 0) return fallback(`empty_root_${keyword}`);
      const copied = [];
      for (const branch of branches.value) {
        const child = snapshotRoot(branch, state, depth + 1);
        if (child.kind === "fallback") return child;
        copied.push(child.value);
      }
      root[keyword] = copied;
    }
    return { kind: "complete", value: root };
  } finally {
    state.active.delete(value);
  }
}

function hasNestedStructure(node, root = true) {
  if (node.oneOf || node.anyOf || node.items) return true;
  if (!node.properties) return false;
  if (!root) return true;
  for (const name of Object.keys(node.properties)) {
    if (hasNestedStructure(node.properties[name], false)) return true;
  }
  return false;
}

/**
 * Select the stable nested-documentation slice before attempting a semantic snapshot. This is
 * deliberately structural: it preserves one block for every current closed object, array, or
 * union candidate even when the complete snapshot below has to fall back. The source file has
 * already been size-bounded and parsed as JSON by the generator; the local caps prevent a future
 * malformed candidate from turning selection into an unbounded traversal.
 */
export function isNestedContractCandidate(value, { limits = NESTED_SHAPE_LIMITS } = {}) {
  const active = new WeakSet();
  function visit(node, root, depth) {
    if (!isCanonicalRecord(node)) return false;
    if (depth > limits.maxDepth) return true;
    if (active.has(node)) return true;
    const record = readRecord(node, root ? limits.maxKeywords : limits.maxKeywords, "keyword_cap");
    if (record.kind === "fallback") return true;
    const allowed = root ? ROOT_KEYWORDS : PROPERTY_KEYWORDS;
    // Selection must not skip a future validation keyword merely because the node happens not to
    // contain an otherwise familiar array/object/union marker. The snapshot will turn this into an
    // explicit non-executable fallback.
    for (const name of record.names) if (!allowed.has(name)) return true;
    if (Object.hasOwn(record.value, "oneOf") || (root && Object.hasOwn(record.value, "anyOf"))) return true;
    if (!root && (Object.hasOwn(record.value, "properties") || Object.hasOwn(record.value, "items"))) return true;
    if (!root || !Object.hasOwn(record.value, "properties")) return false;
    const properties = readRecord(record.value.properties, limits.maxProperties, "property_cap");
    if (properties.kind === "fallback") return true;
    active.add(node);
    try {
      for (const name of properties.names) if (visit(properties.value[name], false, depth + 1)) return true;
    } finally {
      active.delete(node);
    }
    return false;
  }
  return visit(value, true, 0);
}

/** JSON string literals make backticks, newlines, and control characters inert inside the text fence. */
function atom(value) {
  return JSON.stringify(value);
}

function stringList(values) {
  return values.map(atom).join(", ");
}

function scalarConstraints(node) {
  const terms = [];
  if (node.type !== undefined) terms.push(`type ${Array.isArray(node.type) ? node.type.map(atom).join(" | ") : atom(node.type)}`);
  if (node.additionalProperties === false) terms.push("closed");
  if (node.additionalProperties === true) terms.push("additional properties allowed");
  if (node.enum !== undefined) terms.push(`enum [${stringList(node.enum)}]`);
  if (node.enumRef !== undefined) terms.push(`enumRef ${atom(node.enumRef)}`);
  if (node.aliases?.length) terms.push(`accepted aliases [${stringList(node.aliases)}]`);
  if (node.pattern !== undefined) terms.push(`pattern ${atom(node.pattern)}`);
  for (const keyword of NUMERIC_KEYWORDS) if (node[keyword] !== undefined) terms.push(`${keyword}=${atom(node[keyword])}`);
  return terms.length > 0 ? terms.join("; ") : "production metadata node";
}

function shortNode(node) {
  const summary = scalarConstraints(node);
  return summary.length <= 180 ? summary : `${summary.slice(0, 177)}…`;
}

function appendLine(state, line) {
  const bytes = byteLength(`${line}\n`);
  if (bytes > state.limits.maxSummaryLineBytes
    || state.lines.length === state.limits.maxSummaryLines
    || state.bytes + bytes > state.limits.maxSummaryBytes) {
    state.truncated = true;
    return false;
  }
  state.lines.push(line);
  state.bytes += bytes;
  return true;
}

function appendWrapped(state, prefix, values) {
  let line = prefix;
  for (const value of values) {
    const suffix = line === prefix ? value : `; ${value}`;
    if (byteLength(line + suffix) > state.limits.maxSummaryLineBytes) {
      if (!appendLine(state, line)) return false;
      line = `  ${value}`;
    } else {
      line += suffix;
    }
  }
  return line === prefix || appendLine(state, line);
}

function requiredTokens(node) {
  return (node.required ?? []).map((name) => {
    const direct = node.properties?.[name]?.aliases ?? [];
    const prose = node.requiredSatisfiers?.[name] ?? [];
    const notes = [];
    if (direct.length) notes.push(`accepted aliases ${stringList(direct)}`);
    if (prose.length) notes.push(`also satisfied by production prose alias ${stringList(prose)}`);
    return notes.length ? `${atom(name)} (${notes.join("; ")})` : atom(name);
  });
}

function propertyPath(path, name) {
  // Dot notation is easier to read for ordinary contract keys. Everything else stays a JSON
  // literal inside brackets, so a backtick, newline, or control character cannot change Markdown
  // structure or create an ambiguous path.
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? `${path}.${name}` : `${path}[${atom(name)}]`;
}

function renderRoot(node, path, depth, state) {
  if (state.truncated) return;
  if (!appendLine(state, `- ${path}: ${shortNode(node)}`)) return;
  if (depth === state.limits.maxSummaryDepth && hasNestedStructure(node, false)) {
    appendLine(state, "  deeper known constraints are omitted from this descriptive summary; inspect the canonical pointer.");
    state.truncated = true;
    return;
  }
  if (node.required?.length && !appendWrapped(state, "  required: ", requiredTokens(node))) return;
  const fields = [];
  for (const name of Object.keys(node.properties)) fields.push(`${atom(name)}: ${shortNode(node.properties[name])}`);
  if (!appendWrapped(state, "  fields: ", fields)) return;
  if (node.oneOf) {
    if (!appendLine(state, `  root oneOf: ${node.oneOf.length} top-level alternative(s); exactly one declared input alternative is required (exact input-count semantics).`)) return;
    for (let index = 0; index < node.oneOf.length; index += 1) {
      renderRoot(node.oneOf[index], `${path}.oneOf[${index}]`, depth + 1, state);
      if (state.truncated) return;
    }
  }
  if (node.anyOf) {
    if (!appendLine(state, `  root anyOf: ${node.anyOf.length} top-level alternative(s); at least one declared input alternative is required.`)) return;
    for (let index = 0; index < node.anyOf.length; index += 1) {
      renderRoot(node.anyOf[index], `${path}.anyOf[${index}]`, depth + 1, state);
      if (state.truncated) return;
    }
  }
  for (const name of Object.keys(node.properties)) {
    const child = node.properties[name];
    if (hasNestedStructure(child, false)) renderProperty(child, propertyPath(path, name), depth + 1, state);
    if (state.truncated) return;
  }
}

function renderProperty(node, path, depth, state) {
  if (state.truncated) return;
  if (!appendLine(state, `- ${path}: ${shortNode(node)}`)) return;
  const structural = node.items || node.properties || node.oneOf;
  if (depth === state.limits.maxSummaryDepth && structural) {
    appendLine(state, "  deeper known constraints are omitted from this descriptive summary; inspect the canonical pointer.");
    state.truncated = true;
    return;
  }
  if (node.required?.length && !appendWrapped(state, "  required: ", requiredTokens(node))) return;
  if (node.properties) {
    const fields = [];
    for (const name of Object.keys(node.properties)) fields.push(`${atom(name)}: ${shortNode(node.properties[name])}`);
    if (!appendWrapped(state, "  fields: ", fields)) return;
  }
  if (node.items) {
    if (!appendLine(state, `  items: ${shortNode(node.items)}`)) return;
    if (hasNestedStructure(node.items, false)) renderProperty(node.items, `${path}[]`, depth + 1, state);
  }
  if (node.oneOf) {
    if (!appendLine(state, `  nested oneOf: ${node.oneOf.length} branch(es); production accepts any candidate-success branch.`)) return;
    for (let index = 0; index < node.oneOf.length; index += 1) {
      renderProperty(node.oneOf[index], `${path}.oneOf[${index}]`, depth + 1, state);
      if (state.truncated) return;
    }
  }
  if (node.properties) {
    for (const name of Object.keys(node.properties)) {
      const child = node.properties[name];
      if (hasNestedStructure(child, false)) renderProperty(child, propertyPath(path, name), depth + 1, state);
      if (state.truncated) return;
    }
  }
}

/**
 * Produce a bounded summary only for a canonical parsed `MotionDebugArgsSchema`. Any keyword not
 * in the production root/property vocabulary produces a non-executable fallback.
 */
export function describeNestedContractShape(schema, { argEnums = {}, limits = NESTED_SHAPE_LIMITS } = {}) {
  const state = { active: new WeakSet(), argEnums, limits, nodes: 0, properties: new WeakMap() };
  const snapshot = snapshotRoot(schema, state, 0);
  if (snapshot.kind === "fallback") return snapshot;
  if (!hasNestedStructure(snapshot.value)) return { kind: "none", nodes: state.nodes };
  const summary = { bytes: 0, lines: [], limits, truncated: false };
  renderRoot(snapshot.value, "args", 0, summary);
  return { bytes: summary.bytes, kind: "summary", lines: summary.lines, nodes: state.nodes, truncated: summary.truncated };
}
