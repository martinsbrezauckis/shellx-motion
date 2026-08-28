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
import { argumentProblems, jsonTypeOf, nearestName, plainObject, scalarEcho } from "./mcp-args-property-validation.js";

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
  | "above_maximum"
  | "above_max_length"
  | "below_min_length"
  | "bad_pattern"
  | "not_multiple_of"
  | "not_above_exclusive_minimum"
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
  /** Declared upper bound, for a range rejection. */
  maximum?: number;
  /** Declared Unicode-scalar string ceiling, for a string-length rejection. */
  maxLength?: number;
  /** Declared Unicode-scalar string floor, for a string-length rejection. */
  minLength?: number;
  /** Declared exact string grammar, for a pattern rejection. */
  pattern?: string;
  /** Declared numeric step, for a multiple rejection. */
  multipleOf?: number;
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
    case "above_maximum":
      return `argument ${violation.argument} must be <= ${violation.maximum}, received ${received}.`;
    case "above_max_length":
      return `argument ${violation.argument} must contain at most ${violation.maxLength} Unicode scalars, received ${received}.`;
    case "below_min_length":
      return `argument ${violation.argument} must contain at least ${violation.minLength} Unicode scalars, received ${received}.`;
    case "bad_pattern":
      return `argument ${violation.argument} does not match its declared exact format, received ${received}.`;
    case "not_multiple_of":
      return `argument ${violation.argument} must be a multiple of ${violation.multipleOf}, received ${received}.`;
    case "not_above_exclusive_minimum":
      return `argument ${violation.argument} must be > ${violation.minimum}, received ${received}.`;
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
    case "above_maximum":
      return `Set ${violation.argument} to a number <= ${violation.maximum}.`;
    case "above_max_length":
      return `Shorten ${violation.argument} to at most ${violation.maxLength} Unicode scalars.`;
    case "below_min_length":
      return `Use at least ${violation.minLength} Unicode scalars for ${violation.argument}.`;
    case "bad_pattern":
      return `Use the exact published format for ${violation.argument}.`;
    case "not_multiple_of":
      return `Set ${violation.argument} to a multiple of ${violation.multipleOf}.`;
    case "not_above_exclusive_minimum":
      return `Set ${violation.argument} to a number > ${violation.minimum}.`;
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
