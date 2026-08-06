/**
 * Regenerate docs/public/DEBUG_API_COMMANDS.md from schemas/debug.json.
 *
 * Role: the human-readable face of the published debug contract. It renders one argument
 * table per command (names, types, required flag, aliases, defaults, allowed values) plus the
 * shared `argEnums` dictionary, so a reader never has to open TypeScript source to learn what
 * a command takes.
 *
 * Run `pnpm docs:debug-api` to write it and `pnpm docs:check` to fail on drift.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(repoRoot, "schemas/debug.json");
const outputPath = resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md");
const checkOnly = process.argv.includes("--check");

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const commands = schema.commands;
const contracts = schema.contracts;
const argEnums = schema.argEnums ?? {};

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

const contractByCommand = new Map();
for (const contract of contracts) {
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
  for (const [name, property] of Object.entries(contract.argsSchema?.properties ?? {})) {
    if (property.enumRef && !Object.hasOwn(argEnums, property.enumRef)) {
      throw new Error(`Debug contract ${contract.command} argument ${name} references unknown argEnum ${property.enumRef}.`);
    }
  }
  contractByCommand.set(contract.command, contract);
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
const argumentless = withArguments.filter((contract) => Object.keys(contract.argsSchema.properties ?? {}).length === 0);

/** Escape a value for use inside a Markdown table cell. */
function cell(value) {
  return String(value).replaceAll("|", "\\|");
}

/** Render the allowed-value column for one argument property. */
function allowedValues(property) {
  if (property.enumRef) {
    const values = argEnums[property.enumRef].values;
    return values.length <= 6
      ? values.map((value) => `\`${value}\``).join(", ")
      : `[\`${property.enumRef}\`](#argument-value-enumerations) (${values.length} values)`;
  }
  if (Array.isArray(property.enum)) return property.enum.map((value) => `\`${value}\``).join(", ");
  return "";
}

/** Render the argument table for one command, or a one-line note when it takes none. */
function argumentLines(contract) {
  const schema = contract.argsSchema;
  if (!schema) return ["_No argument contract published for this command yet._", ""];
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return ["Takes no arguments.", ""];
  const required = new Set(schema.required ?? []);
  const lines = ["| Argument | Type | Required | Aliases | Allowed values | Description |", "|---|---|---|---|---|---|"];
  for (const [name, property] of entries) {
    const defaultNote = property.default === undefined ? "" : ` Defaults to \`${property.default}\`.`;
    lines.push(
      `| \`${name}\` | \`${property.type}\` | ${required.has(name) ? "yes" : "no"} | `
      + `${(property.aliases ?? []).map((alias) => `\`${alias}\``).join(", ")} | ${allowedValues(property)} | `
      + `${cell(property.description ?? "")}${cell(defaultNote)} |`
    );
  }
  lines.push("");
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

const lines = [
  "# ShellX Motion Debug API commands",
  "",
  "> Generated from `schemas/debug.json`. Do not edit this file by hand. Run",
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
  "`scripts/debug-arg-coverage.ts` reads every debug handler and fails the build if one reads an",
  "argument this table does not list. `Aliases` are additional accepted names for the same argument.",
  "Large or shared value sets are named in `Allowed values` and listed once under",
  "[Argument value enumerations](#argument-value-enumerations). Every allowed-value list here is",
  "enforced on the wire, not merely advertised.",
  "",
  "The same contract is available at runtime: `motion.actions.guide` and `motion.actions.plan`",
  "return each planned step with its arguments, required set, and allowed values attached.",
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
    lines.push(...argumentLines(contract));
  }
}

lines.push("## Argument value enumerations", "");
lines.push("Shared value sets referenced by the `Allowed values` column above. Published as `argEnums` in `schemas/debug.json`.", "");
for (const [name, entry] of Object.entries(argEnums)) {
  lines.push(`### \`${name}\``, "", entry.description, "", entry.values.map((value) => `\`${value}\``).join(", "), "");
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
