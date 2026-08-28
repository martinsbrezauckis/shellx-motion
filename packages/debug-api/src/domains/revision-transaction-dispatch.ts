/** Keep plan-before-commit ordering out of the cap-bound timeline router. */
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { dispatchRevisionTransactionPlanCommand, type RevisionTransactionPlanServices } from "./revision-transaction-plan.js";
import { dispatchRevisionTransactionCommand, type RevisionTransactionServices } from "./revision-transaction.js";

export async function dispatchRevisionTransactionCommands(
  command: MotionDebugCommand,
  args: unknown,
  services: RevisionTransactionPlanServices & RevisionTransactionServices
): Promise<MotionDebugResult | null> {
  return await dispatchRevisionTransactionPlanCommand(command, args, services)
    ?? await dispatchRevisionTransactionCommand(command, args, services);
}
