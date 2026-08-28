/**
 * How a Motion debug command is presented to an MCP client.
 *
 * Role: the tool listing is the entire surface an external agent binds to. It decides what the
 * agent believes exists, what it believes each tool is for, and what arguments it will attempt —
 * so the shaping is its own module rather than a detail of the HTTP server.
 *
 * The name mapping is a contract, not a convenience: `motion.render.final` becomes
 * `motion_render_final` because MCP tool names cannot contain dots. Two commands must never
 * collapse onto one tool name; `mcp-tool-surface.test.ts` asserts that for every registered
 * command.
 *
 * Dependencies: `@shellx-motion/debug-api` for the published contracts and each command's purpose.
 * Primary caller: the MCP `tools/list` and `tools/call` handlers in index.ts.
 */
import {
  DEBUG_COMMAND_CONTRACTS,
  debugArgEnum,
  purposeForCall,
  type MotionDebugArgPropertySchema,
  type MotionDebugCommand,
  type MotionDebugCommandContract
} from "@shellx-motion/debug-api";

/** Every permission tier, in ascending order, as advertised on each tool's requestedTier. */
export const PERMISSION_TIERS = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"] as const;

/**
 * Whether a granted tier reaches a required one, ordered by {@link PERMISSION_TIERS}.
 *
 * Exported so the argument validators can apply the same "permission wins" ordering the
 * `tools/call` handler uses: an under-privileged caller must hear `permission_denied`, because no
 * argument fix would let its call through.
 */
export function tierAllows(granted: string, required: string): boolean {
  const order = PERMISSION_TIERS as readonly string[];
  return order.indexOf(granted) >= order.indexOf(required);
}

export function mcpToolForDebugContract(contract: MotionDebugCommandContract): Record<string, unknown> {
  const readOnly = !contract.mutates;
  return {
    name: mcpToolName(contract.command),
    title: contract.command,
    // Purpose first, mechanics after: the one text every MCP client shows was the one text that
    // said nothing about when to reach for the tool.
    description: [
      contract.purpose ?? purposeForCall(contract.command),
      `ShellX Motion debug command ${contract.command}.`,
      `permission=${contract.permission}.`,
      `mutates=${String(contract.mutates)}.`
    ].filter((part) => part.length > 0).join(" "),
    annotations: {
      title: contract.command,
      readOnlyHint: readOnly,
      // A mutating Motion command may alter or replace local package state. Keep
      // the advisory conservative; the typed tier gate remains authoritative.
      destructiveHint: contract.mutates,
      idempotentHint: readOnly,
      openWorldHint: toolMayReachOpenWorld(contract.command)
    },
    inputSchema: {
      type: "object",
      properties: {
        args: publishedArgsSchema(contract) ?? {
          type: "object",
          description: "Debug command arguments.",
          additionalProperties: true
        },
        requestedTier: {
          type: "string",
          enum: [...PERMISSION_TIERS],
          description: "Optional lower/equal tier requested for this call. The authenticated server grant is the maximum."
        },
        // The server has always honoured `tier` as a synonym for `requestedTier`. It is published
        // here because `mcp-args-validation.ts` enforces this schema literally: an accepted key that
        // the listing hid would be rejected as undeclared, which is the same class of contract/
        // behaviour disagreement that made the argument schemas unenforceable in the first place.
        tier: {
          type: "string",
          enum: [...PERMISSION_TIERS],
          description: "Deprecated synonym for requestedTier; prefer requestedTier."
        }
      },
      additionalProperties: false
    }
  };
}

function toolMayReachOpenWorld(command: MotionDebugCommand): boolean {
  return command === "motion.prompt.run"
    || command === "motion.agent.health"
    || command.startsWith("motion.source.")
    || command.startsWith("motion.connector.")
    || command.startsWith("motion.browser.workflow.")
    || command.startsWith("motion.integration.")
    || command.includes("push");
}

export function debugContractForMcpToolName(name: string): MotionDebugCommandContract | null {
  return DEBUG_COMMAND_CONTRACTS.find((contract) => mcpToolName(contract.command) === name) ?? null;
}

export function mcpToolName(command: MotionDebugCommand): string {
  return command.replace(/\./g, "_");
}


/**
 * The argument schema exactly as this tool publishes it, with every `enumRef` replaced by the real
 * `enum` values.
 *
 * `enumRef` is an internal indirection that keeps a shared value set in one place. Published raw it
 * becomes a non-standard keyword carrying no values, so an MCP client cannot discover what
 * `preset` or a keyframe `target` accepts and has to guess or call actions.guide.
 *
 * THIS FUNCTION IS THE ONLY DEFINITION OF THE PUBLISHED SCHEMA, and `mcp-args-validation.ts`
 * enforces the object it returns. That is deliberate: while resolution happened only here, the
 * validator read the UNRESOLVED contract and saw `enum: undefined` for all 34 `enumRef` properties.
 * `motion.timeline.keyframe.upsert` advertised 113 values for `target` and checked none of them,
 * and a bad `preset` came back from the handler as a different error class with no
 * `detail.violations` — the exact advertised-but-unenforced split that made the argument schemas
 * decorative in the first place. Resolve in one place, enforce that place.
 */
export function publishedArgsSchema(contract: MotionDebugCommandContract): MotionDebugCommandContract["argsSchema"] {
  const schema = contract.argsSchema;
  if (!schema?.properties) return schema;
  const properties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties)) properties[name] = publishedPropertySchema(property);
  return { ...schema, properties } as MotionDebugCommandContract["argsSchema"];
}

/** Resolve enum indirections recursively so a nested data-only record is published verbatim. */
function publishedPropertySchema(property: MotionDebugArgPropertySchema): Record<string, unknown> {
  const { enumRef, properties, items, oneOf, ...rest } = property;
  const resolved = typeof enumRef === "string" ? debugArgEnum(enumRef) : undefined;
  const nested = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.fromEntries(Object.entries(properties)
      .map(([name, child]) => [name, publishedPropertySchema(child)]))
    : undefined;
  return {
    ...rest,
    ...(resolved ? { enum: [...resolved.values] } : {}),
    ...(nested ? { properties: nested } : {}),
    ...(items ? { items: publishedPropertySchema(items) } : {}),
    ...(oneOf ? { oneOf: oneOf.map((alternative) => publishedPropertySchema(alternative)) } : {})
  };
}
