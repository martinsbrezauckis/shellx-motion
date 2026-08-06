/**
 * Enforcement of the argument schema that `tools/list` advertises, for every MCP `tools/call`.
 *
 * Role: the tool listing publishes one JSON Schema per debug command, and until this module existed
 * nothing ever executed it — `tools/call` read `arguments.args` and handed it straight to dispatch.
 * Two failure modes were live on the wire:
 *
 *  - `motion_state` accepted an undeclared property (`unexpected`) and answered `ok: true`, so an
 *    agent that misspelled an argument was told its call had worked.
 *  - `motion_render_final` with NUMERIC `packageRoot`/`outputPath` answered
 *    "motion.render.final requires packageRoot." — the *same* sentence a genuinely missing argument
 *    produces. An agent cannot tell "you forgot it" from "you sent the wrong type", so it re-sends
 *    the same wrong value and loops.
 *
 * The rule this module follows: the published contract and the enforcement are the SAME object.
 * Everything here reads `publishedArgsSchema(contract)` — literally the function `mcp-tool-shape.ts`
 * calls to build the tool listing — so the two can never drift. There is no second copy of the
 * argument rules anywhere in this file.
 *
 * That last point was not true at first, and the gap it left is instructive: resolution of
 * `enumRef` lived only on the publishing side, so 34 properties across ~30 commands advertised a
 * value list to the client and enforced nothing. Reading the same resolved object closes it by
 * construction rather than by remembering to update two places.
 *
 * Dependencies: `@shellx-motion/debug-api` for the contract types, and `mcp-tool-shape.ts` for the
 * published-schema function. Primary caller: the `tools/call` handler in index.ts, which runs this
 * after the permission gate and before dispatch.
 */
import type {
  MotionDebugArgPropertySchema,
  MotionDebugArgsSchema,
  MotionDebugCommandContract,
  MotionDebugResult
} from "@shellx-motion/debug-api";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { publishedArgsSchema, tierAllows } from "./mcp-tool-shape.js";

/** The failing half of a debug result — what this module returns when a call does not match. */
type MotionDebugFailure = Extract<MotionDebugResult, { ok: false }>;

/** The declared JSON type of a property, normalised to a list (a schema may declare a real union). */
type DeclaredType = MotionDebugArgPropertySchema["type"];

/** What an agent got wrong. Kept as a stable machine code so a client can branch on it. */
export type McpArgViolationKind =
  | "missing_required"
  | "wrong_type"
  | "unknown_property"
  | "bad_enum_value"
  | "below_minimum"
  | "malformed_envelope";

/** One field-specific problem: which argument, what was expected, what actually arrived. */
export interface McpArgViolation {
  /** The argument as the caller named it (or the envelope field, for `malformed_envelope`). */
  argument: string;
  kind: McpArgViolationKind;
  /** Declared type(s) for a type mismatch, as published. */
  expectedType?: DeclaredType;
  /** JSON type actually received. Always present when a value arrived. */
  receivedType?: string;
  /** Scalar value echoed back so the caller sees what the server read. Omitted for large values. */
  receivedValue?: string | number | boolean;
  /** Every accepted value, for an enum rejection. */
  allowedValues?: string[];
  /** Declared lower bound, for a range rejection. */
  minimum?: number;
  /** Closest declared argument name, when an unknown property looks like a typo. */
  didYouMean?: string;
}

/**
 * The envelope keys `tools/call` accepts on `params.arguments`.
 *
 * `tier` is the legacy synonym for `requestedTier` that index.ts has always honoured; it is listed
 * here AND published by `mcp-tool-shape.ts` so that what the server accepts and what it advertises
 * stay the same set. Adding a key here without publishing it would re-create the original defect in
 * miniature.
 */
export const MCP_CALL_ENVELOPE_KEYS = ["args", "requestedTier", "tier"] as const;

/**
 * Validate one `tools/call` against the schema its tool advertises.
 *
 * @param input.toolName - the MCP tool name the caller used (`motion_render_final`), echoed in the
 *   message because that is the identifier the agent knows; the dotted command is given alongside.
 * @param input.contract - the published contract; `contract.argsSchema` is the enforced schema.
 * @param input.toolArguments - `params.arguments` exactly as it arrived, unnormalised, so a
 *   non-object envelope is caught rather than silently coerced to `{}`.
 * @returns `null` when the call matches the advertised schema, otherwise a failing
 *   `MotionDebugResult` with code `invalid_args`, a field-specific message, a `suggestedAction`
 *   that says what to change, and `detail.violations` for programmatic handling.
 *
 * Edge cases: `undefined`/`null` argument values are treated as ABSENT, matching every domain arg
 * helper (`stringArg` and friends return null for them) — so this validator never rejects a call
 * the dispatcher would have accepted. A command with no published `argsSchema` is not shape-checked
 * (its advertised schema is the open fallback in `mcp-tool-shape.ts`).
 */
export function validateMcpToolCall(input: {
  toolName: string;
  contract: MotionDebugCommandContract;
  toolArguments: unknown;
}): MotionDebugFailure | null {
  const envelopeViolations = envelopeProblems(input.toolArguments);
  if (envelopeViolations.length > 0) {
    return failure(input.toolName, input.contract.command, envelopeViolations);
  }

  // The PUBLISHED schema, not the raw contract: `publishedArgsSchema` resolves every `enumRef` into
  // real values, and enforcing anything else would re-open the gap this module exists to close.
  const schema = publishedArgsSchema(input.contract);
  if (!schema) return null;
  const envelope = plainObject(input.toolArguments) ?? {};
  const args = plainObject(envelope.args) ?? {};

  const violations = argumentProblems(schema, args);
  return violations.length > 0 ? failure(input.toolName, input.contract.command, violations) : null;
}

/**
 * Check the `tools/call` envelope itself: `{ args?, requestedTier?, tier? }`.
 *
 * This catches the call shape an agent most often gets wrong — putting the command's arguments at
 * the top level instead of under `args`. That used to run with an empty argument set and report the
 * first required argument as missing, which points the agent at the wrong problem entirely.
 */
function envelopeProblems(toolArguments: unknown): McpArgViolation[] {
  if (toolArguments === undefined || toolArguments === null) return [];
  const envelope = plainObject(toolArguments);
  if (!envelope) {
    return [{
      argument: "arguments",
      kind: "malformed_envelope",
      expectedType: "object",
      receivedType: jsonTypeOf(toolArguments),
      ...scalarEcho(toolArguments)
    }];
  }

  const violations: McpArgViolation[] = [];
  for (const key of Object.keys(envelope)) {
    if ((MCP_CALL_ENVELOPE_KEYS as readonly string[]).includes(key)) continue;
    // A stray envelope key is almost always the command's own argument put one level too high, so
    // the default hint points at `args` rather than at nothing.
    const suggestion = nearestName(key, MCP_CALL_ENVELOPE_KEYS) ?? "args";
    violations.push({ argument: key, kind: "malformed_envelope", didYouMean: suggestion });
  }
  const args = envelope.args;
  if (args !== undefined && args !== null && !plainObject(args)) {
    violations.push({
      argument: "args",
      kind: "malformed_envelope",
      expectedType: "object",
      receivedType: jsonTypeOf(args),
      ...scalarEcho(args)
    });
  }
  return violations;
}

/** Every way the supplied arguments can disagree with the advertised schema, in a stable order. */
function argumentProblems(schema: MotionDebugArgsSchema, args: Record<string, unknown>): McpArgViolation[] {
  const properties = schema.properties ?? {};
  const violations: McpArgViolation[] = [];

  // Required first: a missing argument is the caller's most actionable problem, so it leads.
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
    // Absent-by-value: every domain arg helper reads undefined/null as "not supplied", so rejecting
    // them here would fail calls the dispatcher accepts. Presence is judged by value, not by key.
    if (value === undefined) continue;
    const property = resolvers.get(name);
    if (!property) {
      // Unknown properties are rejected only where the schema closes the object. Five commands
      // (render.final, render.batch, preview.frame, canvas.bridge_export, browser.workflow.capture)
      // set `additionalProperties: true` on purpose and must keep accepting extras.
      if (schema.additionalProperties === false) {
        const suggestion = nearestName(name, [...resolvers.keys()]);
        violations.push({
          argument: name,
          kind: "unknown_property",
          receivedType: jsonTypeOf(value),
          ...(suggestion ? { didYouMean: suggestion } : {})
        });
      }
      continue;
    }

    if (!matchesDeclaredType(value, property.type)) {
      violations.push({
        argument: name,
        kind: "wrong_type",
        expectedType: property.type,
        receivedType: jsonTypeOf(value),
        ...scalarEcho(value)
      });
      continue;
    }

    const allowed = allowedValuesFor(property);
    if (allowed && typeof value === "string" && !allowed.includes(value)) {
      violations.push({
        argument: name,
        kind: "bad_enum_value",
        receivedType: "string",
        receivedValue: value,
        allowedValues: allowed
      });
      continue;
    }

    if (typeof property.minimum === "number" && typeof value === "number" && value < property.minimum) {
      violations.push({
        argument: name,
        kind: "below_minimum",
        receivedType: "number",
        receivedValue: value,
        minimum: property.minimum
      });
    }
  }

  return violations;
}

/**
 * Map every accepted argument name to the property schema that governs it.
 *
 * Aliases are not decoration: the handlers really do read `stringArg(args, "layerId") ?? stringArg(args, "layer")`,
 * and the published schemas declare those synonyms. A validator that ignored them would reject
 * working calls.
 */
function propertyResolvers(properties: Record<string, MotionDebugArgPropertySchema>): Map<string, MotionDebugArgPropertySchema> {
  const resolvers = new Map<string, MotionDebugArgPropertySchema>();
  for (const [name, property] of Object.entries(properties)) resolvers.set(name, property);
  for (const [, property] of Object.entries(properties)) {
    for (const alias of property.aliases ?? []) if (!resolvers.has(alias)) resolvers.set(alias, property);
  }
  return resolvers;
}

/**
 * Every argument name that satisfies one required property.
 *
 * Two synonym mechanisms are in play and both are load-bearing:
 *  1. the structured `aliases` list (`outDir` also answers to `packageDir`), and
 *  2. a separately declared property whose published description reads "Alias for <name>" —
 *     `motion.quality.panel.manifestPath`, `motion.template.plan.prompt` and
 *     `motion.canvas.bridge_export.path` are declared that way, each satisfying a REQUIRED
 *     property, and each really is honoured by its handler.
 *
 * The prose form is read here so the validator can never contradict the description the agent was
 * given. Migrating those three to the structured `aliases` field would let this second branch go;
 * that edit lives in the debug-api metadata modules.
 */
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

/** The property a description declares itself a synonym of, e.g. "Alias for qualityManifestPath." */
function proseAliasTarget(description: string | undefined): string | null {
  if (!description) return null;
  const match = /^alias for ([A-Za-z0-9_]+)/i.exec(description.trim());
  return match ? match[1] : null;
}

/**
 * The value a caller actually supplied under `name`, or `undefined` when it counts as absent.
 * `null` counts as absent because every domain arg helper reads it that way.
 */
function suppliedValue(args: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(args, name)) return undefined;
  const value = args[name];
  return value === null ? undefined : value;
}

/**
 * The accepted values for an enumerated property.
 *
 * There is no `enumRef` branch here on purpose: the schema this module validates against has
 * already been through `publishedArgsSchema`, which replaces every reference with the real values.
 * So `property.enum` is exactly the list the client was shown in `tools/list`, and the rejection
 * message can quote it.
 */
function allowedValuesFor(property: MotionDebugArgPropertySchema | undefined): string[] | null {
  return property?.enum ? [...property.enum] : null;
}

/** Whether a value matches a declared type, honouring a declared union such as ["number","string"]. */
function matchesDeclaredType(value: unknown, declared: DeclaredType): boolean {
  const accepted = Array.isArray(declared) ? declared : [declared];
  return accepted.some((type) => {
    switch (type) {
      case "string": return typeof value === "string";
      // Finite is part of "number" here: NaN/Infinity cannot survive JSON, and every numeric arg
      // helper requires finiteness, so a non-finite value would be rejected downstream anyway.
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "array": return Array.isArray(value);
      case "object": return plainObject(value) !== null;
      default: return false;
    }
  });
}

/** JSON type name of a value, as an agent would describe what it sent. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Echo a scalar back so the caller can see what the server read. Large/structured values are not echoed. */
function scalarEcho(value: unknown): { receivedValue?: string | number | boolean } {
  if (typeof value === "number" || typeof value === "boolean") return { receivedValue: value };
  if (typeof value === "string") return { receivedValue: value.length <= 120 ? value : `${value.slice(0, 117)}...` };
  return {};
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Build the failing result: one sentence per violation, plus the fix for each.
 *
 * `toolName` is null for a raw dispatch, which has no MCP tool name — the caller there knows the
 * command, and pointing it at `tools/list` would name a surface it is not using.
 */
function failure(toolName: string | null, command: string, violations: McpArgViolation[]): MotionDebugFailure {
  const subject = toolName ? `MCP tool ${toolName} (${command})` : command;
  const contractHint = toolName
    ? "The accepted arguments are published as this tool's inputSchema.args in tools/list."
    : "The accepted arguments are published as this command's argsSchema in motion.debug.contracts.";
  return {
    ok: false,
    error: {
      code: "invalid_args",
      message: `Invalid arguments for ${subject}: ${violations.map(violationSentence).join(" ")}`,
      suggestedAction: `${violations.map(violationFix).join(" ")} ${contractHint}`,
      detail: { ...(toolName ? { tool: toolName } : {}), command, violations }
    },
    warnings: []
  };
}

/**
 * Validate a RAW dispatch — JSON-RPC `motion.debug.dispatch` and `POST /debug` — against the SAME
 * published schema `tools/call` enforces.
 *
 * `rpc.discover` advertises `motion.debug.dispatch` next to `tools/call`, so an agent may pick
 * either; while only one of them executed the schema, the published contract was whatever transport
 * you happened to choose. `{ command: "motion.state", args: { unexpected: 1, packageRoot: 5 } }`
 * answered `ok: true` here and `invalid_args` there, for the same server and the same arguments.
 *
 * Only the ARGUMENTS are checked. The raw envelope stays open: unlike `tools/call`, whose envelope
 * is a fixed three-key shape this server defines, `POST /debug` is a plain HTTP body that hosts
 * extend, and closing it is a separate decision from enforcing the argument contract.
 *
 * @param command the dotted command id, exactly as the caller sent it.
 * @param args the caller's argument object; a non-object is treated as no arguments, matching dispatch.
 * @param grantedTier the tier resolved for this call — permission still wins, as it does for MCP.
 * @returns null when the call matches the published schema, otherwise the `invalid_args` failure.
 */
export function validateRawDispatchArgs(command: string, args: unknown, grantedTier: string): MotionDebugFailure | null {
  const contract = DEBUG_COMMAND_CONTRACTS.find((entry) => entry.command === command);
  // An unknown command, an under-privileged caller, and a command with no published schema are all
  // dispatch's verdict to give, not this function's.
  if (!contract || !tierAllows(grantedTier, contract.permission)) return null;
  const schema = publishedArgsSchema(contract);
  if (!schema) return null;
  const violations = argumentProblems(schema, plainObject(args) ?? {});
  return violations.length > 0 ? failure(null, contract.command, violations) : null;
}

/** One sentence naming the field, what was expected, and what arrived. */
function violationSentence(violation: McpArgViolation): string {
  const received = describeReceived(violation);
  switch (violation.kind) {
    case "missing_required":
      return `required argument ${violation.argument} is missing.`;
    case "wrong_type":
      return `argument ${violation.argument} must be ${formatDeclaredType(violation.expectedType)}, received ${received}.`;
    case "bad_enum_value":
      return `argument ${violation.argument} must be ${quotedList(violation.allowedValues ?? [])}, received ${received}.`;
    case "below_minimum":
      return `argument ${violation.argument} must be >= ${violation.minimum}, received ${received}.`;
    case "unknown_property":
      return `argument ${violation.argument} is not declared by this command.`;
    case "malformed_envelope":
      return violation.expectedType
        ? `tools/call ${violation.argument} must be ${formatDeclaredType(violation.expectedType)}, received ${received}.`
        : `tools/call arguments.${violation.argument} is not part of the call envelope.`;
  }
}

/** The corresponding "do this instead" clause, so the message and the fix arrive together. */
function violationFix(violation: McpArgViolation): string {
  switch (violation.kind) {
    case "missing_required":
      return violation.allowedValues
        ? `Supply ${violation.argument} as one of ${quotedList(violation.allowedValues)}.`
        : `Supply ${violation.argument}${violation.expectedType ? ` as ${formatDeclaredType(violation.expectedType)}` : ""}.`;
    case "wrong_type":
      return `Send ${violation.argument} as ${formatDeclaredType(violation.expectedType)}, not ${violation.receivedType}.`;
    case "bad_enum_value":
      return `Set ${violation.argument} to one of ${quotedList(violation.allowedValues ?? [])}.`;
    case "below_minimum":
      return `Set ${violation.argument} to a number >= ${violation.minimum}.`;
    case "unknown_property":
      return violation.didYouMean
        ? `Remove ${violation.argument} (did you mean ${violation.didYouMean}?).`
        : `Remove ${violation.argument}.`;
    case "malformed_envelope":
      return violation.expectedType
        ? `Send ${violation.argument} as ${formatDeclaredType(violation.expectedType)}; the command's own arguments go inside arguments.args.`
        : `Move ${violation.argument} inside arguments.args; the envelope accepts only ${MCP_CALL_ENVELOPE_KEYS.join(", ")}.`;
  }
}

/** "number" received, with the value when it is a short scalar: `number (5)`, `string ("everything")`. */
function describeReceived(violation: McpArgViolation): string {
  const type = violation.receivedType ?? "nothing";
  if (violation.receivedValue === undefined) return type;
  const rendered = typeof violation.receivedValue === "string" ? JSON.stringify(violation.receivedValue) : String(violation.receivedValue);
  return `${type} (${rendered})`;
}

/** A declared type or union, in prose: "string", "number or string". */
function formatDeclaredType(declared: DeclaredType | undefined): string {
  if (!declared) return "a supported type";
  return Array.isArray(declared) ? declared.join(" or ") : declared;
}

/** Quote every accepted value: `"own" or "all"`, `"a", "b", or "c"`. */
function quotedList(values: readonly string[]): string {
  const quoted = values.map((value) => JSON.stringify(value));
  if (quoted.length === 0) return "a published value";
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

/**
 * Closest declared name to a rejected one, so a typo gets pointed at its target instead of only
 * being refused. Case-insensitive edit distance, capped so unrelated names never "match".
 */
function nearestName(supplied: string, candidates: readonly string[]): string | null {
  const limit = supplied.length <= 4 ? 1 : 2;
  let best: { name: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(supplied.toLowerCase(), candidate.toLowerCase());
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best ? best.name : null;
}

/** Levenshtein distance, two-row form. Inputs are argument names, so the size is trivially bounded. */
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
