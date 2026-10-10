/**
 * Regenerate docs/public/DEBUG_API_COMMANDS.md from schemas/debug.json and the debug coverage fixture.
 *
 * Role: the human-readable face of the published debug contract. It renders one argument
 * table per command (names, types, required flag, aliases, defaults, allowed values), the shared
 * `argEnums` dictionary, and the deliberately limited debug-coverage gate scope, so a reader never
 * has to open TypeScript source to learn what a command takes or what that gate proves.
 *
 * Run `pnpm docs:debug-api` to write it and `pnpm docs:check` to fail on drift.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NESTED_SHAPE_DOCUMENT_LIMITS,
  NESTED_SHAPE_LIMITS,
  describeNestedContractShape,
  isNestedContractCandidate,
  reserveNestedFallbackBudget
} from "./debug-api-reference-shape.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemaPath = resolve(repoRoot, "schemas/debug.json");
const coverageFixturePath = resolve(repoRoot, "fixtures/debug/coverage.expected.json");
const outputPath = resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md");
const checkOnly = process.argv.includes("--check");
const MAX_DEBUG_SCHEMA_SOURCE_BYTES = 2 * 1024 * 1024;
const FLAT_DOCUMENT_LIMITS = Object.freeze({
  maxAliases: NESTED_SHAPE_LIMITS.maxProperties,
  maxArgumentProperties: NESTED_SHAPE_LIMITS.maxProperties,
  maxArgumentValues: NESTED_SHAPE_LIMITS.maxEnumValues,
  maxAlternativeBranches: NESTED_SHAPE_LIMITS.maxBranches,
  maxAlternativeRequired: NESTED_SHAPE_LIMITS.maxRequiredFields,
  maxArgEnums: NESTED_SHAPE_LIMITS.maxProperties
});

// Nested-shape handling is intentionally defined only for this repository-owned JSON artifact,
// not arbitrary objects with getters/proxies. Bound the entire source before JSON materialization.
const schemaSource = await readFile(schemaPath);
if (schemaSource.byteLength > MAX_DEBUG_SCHEMA_SOURCE_BYTES) {
  throw new Error(`schemas/debug.json exceeds the bounded generator source limit of ${MAX_DEBUG_SCHEMA_SOURCE_BYTES} bytes.`);
}
const schema = JSON.parse(schemaSource.toString("utf8"));
const commands = schema.commands;
const contracts = schema.contracts;
const argEnums = schema.argEnums ?? {};
const coverageFixture = JSON.parse(await readFile(coverageFixturePath, "utf8"));

/**
 * Copy at most `limit` own names. Flat tables have no safe shorthand for omitted entries, so fail
 * generation rather than silently rendering a partial contract. Nested projections use their
 * separate explicit non-schema fallback path below.
 */
function ownNamesWithin(record, limit, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} must be an object.`);
  }
  // `record` came from the bounded JSON source above, so its own enumerable values are plain data.
  const names = Object.keys(record);
  if (names.length > limit) throw new Error(`${label} exceeds its bounded document limit of ${limit}.`);
  return names;
}

/** Read a complete, bounded list before it is used in a table or prose summary. */
function valuesWithin(values, limit, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  if (values.length > limit) throw new Error(`${label} exceeds its bounded document limit of ${limit}.`);
  const copied = [];
  for (let index = 0; index < values.length; index += 1) copied.push(values[index]);
  return copied;
}

function markdownValues(values) {
  const rendered = [];
  for (const value of values) rendered.push(`\`${value}\``);
  return rendered.join(", ");
}

if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
  throw new Error("schemas/debug.json commands must be an array of strings.");
}
if (!Array.isArray(contracts)) {
  throw new Error("schemas/debug.json contracts must be an array.");
}
if (schema.commandCount !== commands.length) {
  throw new Error(`schemas/debug.json commandCount ${schema.commandCount} does not match ${commands.length} commands.`);
}
if (!argEnums || typeof argEnums !== "object" || Array.isArray(argEnums)) {
  throw new Error("schemas/debug.json argEnums must be an object keyed by enum name.");
}

const commandSet = new Set(commands);
if (commandSet.size !== commands.length) {
  throw new Error("schemas/debug.json contains duplicate command names.");
}

if (!coverageFixture || typeof coverageFixture !== "object" || Array.isArray(coverageFixture)
  || !Array.isArray(coverageFixture.visibleSurfaces)
  || coverageFixture.visibleSurfaces.length === 0
  || !coverageFixture.visibleSurfaces.every((surface) => typeof surface === "string" && surface.length > 0)
  || !Array.isArray(coverageFixture.requiredCommands)
  || coverageFixture.requiredCommands.length === 0
  || !coverageFixture.requiredCommands.every((command) => typeof command === "string" && command.length > 0)) {
  throw new Error("fixtures/debug/coverage.expected.json must declare non-empty string visibleSurfaces and requiredCommands arrays.");
}

const coverageVisibleSurfaces = coverageFixture.visibleSurfaces;
const coverageRequiredCommands = coverageFixture.requiredCommands;
if (new Set(coverageVisibleSurfaces).size !== coverageVisibleSurfaces.length) {
  throw new Error("fixtures/debug/coverage.expected.json contains duplicate visibleSurfaces.");
}
if (new Set(coverageRequiredCommands).size !== coverageRequiredCommands.length) {
  throw new Error("fixtures/debug/coverage.expected.json contains duplicate requiredCommands.");
}
const unregisteredCoverageCommands = coverageRequiredCommands.filter((command) => !commandSet.has(command));
if (unregisteredCoverageCommands.length > 0) {
  throw new Error(`Debug coverage fixture names commands absent from schemas/debug.json: ${unregisteredCoverageCommands.join(", ")}`);
}
const commandsOutsideCoverageScope = commands.length - coverageRequiredCommands.length;

const contractByCommand = new Map();
const contractIndexByCommand = new Map();
for (const [contractIndex, contract] of contracts.entries()) {
  if (!contract || typeof contract.command !== "string") {
    throw new Error("Every debug contract must declare a string command.");
  }
  if (contractByCommand.has(contract.command)) {
    throw new Error(`Duplicate debug contract for ${contract.command}.`);
  }
  if (!commandSet.has(contract.command)) {
    throw new Error(`Debug contract ${contract.command} is absent from commands.`);
  }
  if (typeof contract.domain !== "string" || typeof contract.permission !== "string" || typeof contract.mutates !== "boolean") {
    throw new Error(`Debug contract ${contract.command} is missing domain, permission, or mutates metadata.`);
  }
  if (contract.purpose !== undefined && (typeof contract.purpose !== "string" || contract.purpose.trim().length === 0)) {
    throw new Error(`Debug contract ${contract.command} has an empty agent purpose.`);
  }
  const propertyNames = contract.argsSchema?.properties === undefined
    ? []
    : ownNamesWithin(contract.argsSchema.properties, FLAT_DOCUMENT_LIMITS.maxArgumentProperties, `${contract.command} argsSchema.properties`);
  for (const name of propertyNames) {
    const property = contract.argsSchema.properties[name];
    if (property.enumRef && !Object.hasOwn(argEnums, property.enumRef)) {
      throw new Error(`Debug contract ${contract.command} argument ${name} references unknown argEnum ${property.enumRef}.`);
    }
  }
  contractByCommand.set(contract.command, contract);
  contractIndexByCommand.set(contract.command, contractIndex);
}

const missingContracts = commands.filter((command) => !contractByCommand.has(command));
if (missingContracts.length > 0) {
  throw new Error(`Debug commands without contracts: ${missingContracts.join(", ")}`);
}

const domains = new Map();
for (const command of commands) {
  const contract = contractByCommand.get(command);
  const domainCommands = domains.get(contract.domain) ?? [];
  domainCommands.push(contract);
  domains.set(contract.domain, domainCommands);
}

const withArguments = contracts.filter((contract) => contract.argsSchema);
const argumentless = withArguments.filter((contract) => {
  const properties = contract.argsSchema.properties;
  return properties === undefined || ownNamesWithin(
    properties,
    FLAT_DOCUMENT_LIMITS.maxArgumentProperties,
    `${contract.command} argsSchema.properties`
  ).length === 0;
});

/** Escape a value for use inside a Markdown table cell. */
function cell(value) {
  return String(value).replaceAll("|", "\\|");
}

/** Render the allowed-value column for one argument property. */
function allowedValues(property) {
  if (property.enumRef) {
    const values = valuesWithin(argEnums[property.enumRef].values, FLAT_DOCUMENT_LIMITS.maxArgumentValues, `argEnum ${property.enumRef}.values`);
    return values.length <= 6
      ? markdownValues(values)
      : `[\`${property.enumRef}\`](#argument-value-enumerations) (${values.length} values)`;
  }
  if (Array.isArray(property.enum)) {
    return markdownValues(valuesWithin(property.enum, FLAT_DOCUMENT_LIMITS.maxArgumentValues, "argument enum"));
  }
  return "";
}

/** Render the argument table for one command, or a one-line note when it takes none. */
function argumentLines(contract) {
  const schema = contract.argsSchema;
  if (!schema) return ["_No argument contract published for this command yet._", ""];
  const propertyNames = schema.properties === undefined
    ? []
    : ownNamesWithin(schema.properties, FLAT_DOCUMENT_LIMITS.maxArgumentProperties, `${contract.command} argsSchema.properties`);
  if (propertyNames.length === 0) return ["Takes no arguments.", ""];
  const required = new Set(schema.required === undefined
    ? []
    : valuesWithin(schema.required, FLAT_DOCUMENT_LIMITS.maxAlternativeRequired, `${contract.command} argsSchema.required`));
  const lines = ["| Argument | Type | Required | Aliases | Allowed values | Description |", "|---|---|---|---|---|---|"];
  for (const name of propertyNames) {
    const property = schema.properties[name];
    const defaultNote = property.default === undefined ? "" : ` Defaults to \`${property.default}\`.`;
    const aliases = property.aliases === undefined
      ? []
      : valuesWithin(property.aliases, FLAT_DOCUMENT_LIMITS.maxAliases, `${contract.command}.${name}.aliases`);
    lines.push(
      `| \`${name}\` | \`${property.type}\` | ${required.has(name) ? "yes" : "no"} | `
      + `${markdownValues(aliases)} | ${allowedValues(property)} | `
      + `${cell(property.description ?? "")}${cell(defaultNote)} |`
    );
  }
  lines.push("");
  for (const [keyword, wording] of [["anyOf", "At least one input shape is required"], ["oneOf", "Exactly one input shape is required"]]) {
    const variants = schema[keyword];
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const alternatives = [];
    for (const alternative of valuesWithin(variants, FLAT_DOCUMENT_LIMITS.maxAlternativeBranches, `${contract.command} argsSchema.${keyword}`)) {
      const names = alternative.required === undefined
        ? []
        : valuesWithin(alternative.required, FLAT_DOCUMENT_LIMITS.maxAlternativeRequired, `${contract.command} ${keyword}.required`);
      const rendered = markdownValues(names).replaceAll(", ", " + ");
      if (rendered) alternatives.push(rendered);
    }
    if (alternatives.length > 0) lines.push(`${wording}: ${alternatives.join("; ")}.`, "");
  }
  // `additionalProperties` is ENFORCED on every transport, so this sentence has to say what the
  // server actually does. It used to read "Any other argument is ignored." under
  // `additionalProperties: false` — the exact opposite of the behaviour, on the ~158 commands that
  // reject extras. Generator and document agreed with each other and not with the code, so
  // `pnpm docs:check` stayed green while the primary contract surface for agents was inverted.
  if (schema.additionalProperties === false) {
    lines.push("Any other argument is **rejected**: the call fails with `invalid_args` and the command does not run.", "");
  } else {
    lines.push("Other arguments are accepted and passed through unread; this command does not close its argument set.", "");
  }
  return lines;
}

function jsonPointerSegment(segment) {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function canonicalShapeSource(contract, segments) {
  const contractIndex = contractIndexByCommand.get(contract.command);
  if (!Number.isInteger(contractIndex)) throw new Error(`Missing contract index for ${contract.command}.`);
  if (Buffer.byteLength(contract.command, "utf8") > NESTED_SHAPE_LIMITS.maxStringBytes) {
    throw new Error(`Debug contract command name exceeds the bounded nested-reference limit: ${contract.command}.`);
  }
  const pointer = ["contracts", contractIndex, ...segments].map(jsonPointerSegment).join("/");
  const target = `../../schemas/debug.json#/${pointer}`;
  const source = {
    command: JSON.stringify(contract.command),
    href: target,
    pointer: `/${pointer}`,
    text: `schemas/debug.json#/${pointer}`
  };
  const sourceLine = `Canonical JSON Pointer: [${source.text}](${source.href}) (command ${source.command}).`;
  if (Buffer.byteLength(sourceLine, "utf8") > NESTED_SHAPE_LIMITS.maxSummaryLineBytes) {
    throw new Error(`Nested documentation source link exceeds its line limit for ${contract.command}.`);
  }
  return source;
}

function nestedBlockCost(block) {
  return {
    bytes: Buffer.byteLength(`${block.join("\n")}\n`, "utf8"),
    // A documentation node is an emitted line. This includes empty separators as well as headings,
    // prose, links, fences, and every summary line.
    nodes: block.length
  };
}

function fallbackNestedBlock(source, reason) {
  return [
    "#### Nested contract shape summary",
    "",
    "**Not executable — authoritative source required.** A bounded descriptive summary was not emitted.",
    "",
    `Canonical JSON Pointer: [${source.text}](${source.href}) (command ${source.command}).`,
    `Reason: ${JSON.stringify(reason)}.`,
    ""
  ];
}

function descriptiveNestedBlock(source, described) {
  const block = [
    "#### Nested contract shape summary",
    "",
    "**Descriptive only — not executable and not a request validator.** Production normalization, aliases, defaults, and branch semantics remain authoritative only at the canonical pointer.",
    "",
    `Canonical JSON Pointer: [${source.text}](${source.href}) (command ${source.command}).`,
    "",
    "```text",
    ...described.lines,
    "```"
  ];
  if (described.truncated) block.push("", "Summary bounds were reached; inspect the canonical pointer for the complete contract.");
  block.push("");
  return block;
}

/**
 * Pre-enumerate the complete nested slice and reserve every compact fallback before choosing any
 * detailed summaries. A global cap can therefore degrade a candidate to an explicit fallback but
 * cannot silently suppress it. If even the reserved fallbacks do not fit, generation fails.
 */
function planNestedArgumentBlocks() {
  const candidates = contracts.filter((contract) => contract.argsSchema && isNestedContractCandidate(contract.argsSchema));
  const plans = candidates.map((contract) => {
    const source = canonicalShapeSource(contract, ["argsSchema"]);
    const described = describeNestedContractShape(contract.argsSchema, { argEnums });
    const fallbackReason = described.kind === "fallback" ? described.reason : "candidate_snapshot_unavailable";
    const fallback = fallbackNestedBlock(source, fallbackReason);
    return {
      command: contract.command,
      described,
      fallback,
      fallbackCost: nestedBlockCost(fallback),
      source
    };
  });
  if (new Set(plans.map((plan) => plan.command)).size !== plans.length) {
    throw new Error("Nested documentation candidates contain duplicate command names.");
  }

  const reserved = reserveNestedFallbackBudget(
    plans.map((plan) => plan.fallbackCost),
    NESTED_SHAPE_DOCUMENT_LIMITS
  );

  const priority = new Map([
    ["motion.connector.script_to_cut", 0],
    ["motion.template.catalog", 0],
    ["motion.template.plan", 0],
    ["motion.timeline.checkpoint-storyboard.create", 0],
    ["motion.timeline.relations.upsert", 0],
    ["motion.timeline.relation-actions.upsert", 0],
    ["motion.timeline.relation-actions.apply", 0]
  ]);
  const selected = new Map();
  let used = { ...reserved };
  const selectionOrder = plans
    .map((plan, index) => ({ index, plan }))
    .sort((left, right) => ((priority.get(left.plan.command) ?? 1) - (priority.get(right.plan.command) ?? 1)) || left.index - right.index);
  for (const { plan } of selectionOrder) {
    if (plan.described.kind !== "summary") {
      selected.set(plan.command, plan.fallback);
      continue;
    }
    const summary = descriptiveNestedBlock(plan.source, plan.described);
    const summaryCost = nestedBlockCost(summary);
    const additionalBytes = summaryCost.bytes - plan.fallbackCost.bytes;
    const additionalNodes = summaryCost.nodes - plan.fallbackCost.nodes;
    if (used.bytes + additionalBytes <= NESTED_SHAPE_DOCUMENT_LIMITS.maxBytes
      && used.nodes + additionalNodes <= NESTED_SHAPE_DOCUMENT_LIMITS.maxNodes) {
      selected.set(plan.command, summary);
      used = { bytes: used.bytes + additionalBytes, nodes: used.nodes + additionalNodes };
    } else {
      selected.set(plan.command, fallbackNestedBlock(plan.source, "document_budget_cap"));
    }
  }
  if (selected.size !== plans.length) throw new Error("Nested documentation plan did not cover every candidate.");
  if (used.bytes > NESTED_SHAPE_DOCUMENT_LIMITS.maxBytes || used.nodes > NESTED_SHAPE_DOCUMENT_LIMITS.maxNodes) {
    throw new Error("Nested documentation plan exceeded its declared global cap.");
  }
  return { blocks: selected, candidates, used };
}

const nestedDocumentPlan = planNestedArgumentBlocks();

/** Render the pre-planned block without changing the existing flat table. */
function nestedArgumentShapeLines(contract) {
  const candidate = nestedDocumentPlan.blocks.get(contract.command);
  return candidate ?? [];
}

const lines = [
  "# ShellX Motion Debug API commands",
  "",
  "> Generated from `schemas/debug.json` and `fixtures/debug/coverage.expected.json`. Do not edit this file by hand. Run",
  "> `pnpm docs:debug-api` to regenerate it and `pnpm docs:check` to detect drift.",
  "",
  `Current contract: **${commands.length} commands** across **${domains.size} domains**.`,
  `**${withArguments.length}** of them publish an argument contract`
  + ` (${argumentless.length} of those take no arguments at all).`,
  "",
  "The required tier is the minimum permission contract for the command. `Mutates` is the",
  "schema's mutation classification; commands that render or write derived artifacts can therefore",
  "be classified as mutations even when the source package itself is unchanged. For transport and",
  "authentication examples, see [`DEBUG_API.md`](DEBUG_API.md).",
  "",
  "Arguments below are the exact keys each command reads, and that is checked mechanically:",
  "`scripts/public/debug-arg-coverage.ts` reads every debug handler and fails the build if one reads an",
  "argument this table does not list. `Aliases` are additional accepted names for the same argument.",
  "Large or shared value sets are named in `Allowed values` and listed once under",
  "[Argument value enumerations](#argument-value-enumerations). Every allowed-value list here is",
  "enforced on the wire, not merely advertised.",
  "",
  "Closed nested object, array, and union arguments additionally publish a compact descriptive",
  "shape summary below their existing table. These are not JSON Schema and do not validate requests:",
  "production normalization (including aliases and defaults) and branch behavior remain authoritative",
  "only in the linked JSON Pointer. A summary is emitted only after every bounded nested node has",
  "been checked for supported validation metadata. Unsupported metadata and bounds become an explicit",
  "non-executable fallback. Per-summary bounds are",
  `${NESTED_SHAPE_LIMITS.maxDepth} levels, ${NESTED_SHAPE_LIMITS.maxNodes} nodes, and ${NESTED_SHAPE_LIMITS.maxSummaryBytes} UTF-8 bytes; every nested block, fallback, heading, and source link shares a`,
  `global cap of ${NESTED_SHAPE_DOCUMENT_LIMITS.maxNodes} nodes and ${NESTED_SHAPE_DOCUMENT_LIMITS.maxBytes} UTF-8 bytes.`,
  "",
  "## Debug coverage gate scope",
  "",
  "`pnpm debug:coverage` is a static parity gate for the fixture-defined Workbench surface map, not a",
  "general test-coverage command. It requires each named surface to map at least one command and the",
  "map's unique command IDs to exactly equal the fixture's required-command list.",
  "",
  `Its exact command scope is **${coverageRequiredCommands.length} / ${commands.length} registered Debug API commands**: ${coverageRequiredCommands.length} fixture-required command IDs across ${coverageVisibleSurfaces.length} named surfaces (${markdownValues(coverageVisibleSurfaces)}). The other ${commandsOutsideCoverageScope} registered commands are outside this gate's scope.`,
  "",
  "It does not execute handlers, prove action-discovery completeness, validate receipts, or measure",
  "unit or line coverage. The gate's JSON output repeats its scope, numerator, denominator, and fixture",
  "parity so a passing result cannot be read as all-command execution coverage.",
  "",
  "The same contract is available at runtime: `motion.actions.guide` and `motion.actions.plan`",
  "return each planned step with its arguments, direct required set, alternative required groups, and allowed values attached.",
  "A reviewed `Purpose` appears only where an agent-facing semantic distinction has been audited;",
  "it is sourced from the same action-catalog wording used by action plans and MCP tool listings,",
  "not maintained as separate documentation prose.",
  ""
];

for (const [domain, domainContracts] of [...domains.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
  lines.push(`## ${domain} (${domainContracts.length})`, "", "| Command | Required tier | Mutates |", "|---|---|---:|");
  for (const contract of domainContracts) {
    lines.push(`| [\`${contract.command}\`](#${anchor(contract.command)}) | \`${contract.permission}\` | ${contract.mutates ? "yes" : "no"} |`);
  }
  lines.push("");
  for (const contract of domainContracts) {
    lines.push(`### \`${contract.command}\``, "", `Tier \`${contract.permission}\` · mutates: ${contract.mutates ? "yes" : "no"}`, "");
    if (contract.purpose) lines.push(`**Purpose:** ${contract.purpose}`, "");
    lines.push(...argumentLines(contract));
    lines.push(...nestedArgumentShapeLines(contract));
  }
}

lines.push("## Argument value enumerations", "");
lines.push("Shared value sets referenced by the `Allowed values` column above. Published as `argEnums` in `schemas/debug.json`.", "");
for (const name of ownNamesWithin(argEnums, FLAT_DOCUMENT_LIMITS.maxArgEnums, "argEnums")) {
  const entry = argEnums[name];
  const values = valuesWithin(entry.values, FLAT_DOCUMENT_LIMITS.maxArgumentValues, `argEnum ${name}.values`);
  lines.push(`### \`${name}\``, "", entry.description, "", markdownValues(values), "");
}

/** GitHub-flavoured heading anchor for a `### \`command\`` heading. */
function anchor(command) {
  return command.replaceAll(".", "").toLowerCase();
}

const generated = `${lines.join("\n").trimEnd()}\n`;
if (checkOnly) {
  let existing = "";
  try {
    existing = await readFile(outputPath, "utf8");
  } catch {
    throw new Error("docs/public/DEBUG_API_COMMANDS.md is missing. Run pnpm docs:debug-api.");
  }
  if (existing !== generated) {
    throw new Error("docs/public/DEBUG_API_COMMANDS.md is stale. Run pnpm docs:debug-api and commit the result.");
  }
} else {
  await writeFile(outputPath, generated, "utf8");
}
