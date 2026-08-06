/**
 * Attach published argument contracts to an action plan's steps.
 *
 * Role: `motion.actions.guide` and `motion.actions.plan` return an ordered list of debug
 * commands to call. Before this module they returned only `call` and `purpose`, so an agent
 * knew the sequence but not a single argument name — the failure mode where a prompt run
 * reports `ok: true` with `executedCommands: []` and a byte-identical package.
 *
 * Dependencies: `../command-metadata.js` for the assembled contracts (imported there rather
 * than from `../index.js`, which imports the domain routers and would form a cycle) and
 * `../command-metadata-enums.js` to inline the referenced value lists so a caller does not
 * need a second lookup against `schemas/debug.json`.
 *
 * Primary caller: `domains/agent.ts`.
 */
import type { MotionActionPlan } from "@shellx-motion/actions";
import { debugArgEnum } from "../command-metadata-enums.js";
import { debugCommandContract } from "../command-metadata.js";
import type { MotionDebugArgPropertySchema } from "../command-registry.js";

/** One argument of one step, flattened into the shape an agent can act on directly. */
export interface MotionPlanStepArgument {
  name: string;
  type: MotionDebugArgPropertySchema["type"];
  required: boolean;
  description?: string;
  aliases?: string[];
  allowedValues?: string[];
  default?: string | number | boolean;
  minimum?: number;
}

/** A plan step plus everything needed to actually issue the call. */
export interface MotionAnnotatedPlanStep {
  order: number;
  call: string;
  purpose: string;
  mutates?: boolean;
  permission?: string;
  args?: MotionPlanStepArgument[];
  requiredArgs?: string[];
  /** True when the call accepts no arguments at all, so an empty args list is not a gap. */
  takesNoArguments?: boolean;
}

/** An action plan whose steps carry their argument contracts. */
export interface MotionAnnotatedActionPlan extends Omit<MotionActionPlan, "steps"> {
  steps: MotionAnnotatedPlanStep[];
  argumentContractsResolved: number;
}

/**
 * Flatten one command's published argument schema into an ordered argument list.
 *
 * @param call - debug command id from the plan step.
 * @returns null when the command id is not in the registry (a plan can name a CLI-level verb),
 *   otherwise the step annotation.
 *
 * Enum values are resolved here: a property carrying `enumRef` is expanded into
 * `allowedValues` so the caller sees the real values, not a reference it has to chase.
 */
function annotateCall(call: string): Omit<MotionAnnotatedPlanStep, "order" | "call" | "purpose"> | null {
  const contract = debugCommandContract(call);
  if (!contract) return null;
  const schema = contract.argsSchema;
  const base = { mutates: contract.mutates, permission: contract.permission };
  if (!schema) return base;
  const required = new Set(schema.required ?? []);
  const args = Object.entries(schema.properties).map(([name, property]) => {
    const allowedValues = property.enumRef ? debugArgEnum(property.enumRef)?.values : property.enum;
    return {
      name,
      type: property.type,
      required: required.has(name),
      ...(property.description ? { description: property.description } : {}),
      ...(property.aliases ? { aliases: property.aliases } : {}),
      ...(allowedValues ? { allowedValues } : {}),
      ...(property.default !== undefined ? { default: property.default } : {}),
      ...(property.minimum !== undefined ? { minimum: property.minimum } : {})
    } satisfies MotionPlanStepArgument;
  });
  return {
    ...base,
    args,
    requiredArgs: [...required],
    ...(args.length === 0 ? { takesNoArguments: true } : {})
  };
}

/**
 * Return the plan with every step annotated with its published argument contract.
 *
 * @param plan - the plan produced by `guideAction` / `planAction`.
 * @returns a new plan object; the input is not mutated.
 *
 * `argumentContractsResolved` counts the steps that resolved to a registry command, so a caller
 * can tell "this command takes no arguments" apart from "this step is not a debug command".
 */
export function annotatePlanWithArgumentContracts(plan: MotionActionPlan): MotionAnnotatedActionPlan {
  let resolved = 0;
  const steps = plan.steps.map((step) => {
    const annotation = annotateCall(step.call);
    if (annotation) resolved += 1;
    return { ...step, ...(annotation ?? {}) };
  });
  return { ...plan, steps, argumentContractsResolved: resolved };
}
