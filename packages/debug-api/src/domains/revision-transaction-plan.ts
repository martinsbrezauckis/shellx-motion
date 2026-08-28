/** Read-only deterministic preflight for a bounded atomic revision transaction. */
import {
  canonicalJson, compileMotionDocumentCompositing, hashPackageFile, loadSchema, resolvePackageAsset,
  validateDocument, type MotionPackage
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import { motionDocumentFileSha256 } from "./revision-transaction-commit.js";
import { parseRevisionTransactionPlan, type RevisionBase } from "./revision-transaction-parser.js";
import { applyRevisionTransactionSteps, RevisionStepError, type AppliedRevisionStep } from "./revision-transaction-replay.js";
import type { TimelinePackageEditServices } from "./timeline-package-edit.js";

const COMMAND = "motion.revision.transaction.plan" as const;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_CHANGED_PATHS_PER_STEP = 4;
const MAX_CHANGED_PATH_BYTES = 512;

export interface RevisionTransactionPlanServices extends Pick<TimelinePackageEditServices, "packageLoader"> {
  authoringInputRoots?: string[];
}

export async function dispatchRevisionTransactionPlanCommand(command: MotionDebugCommand, args: unknown, services: RevisionTransactionPlanServices): Promise<MotionDebugResult | null> {
  if (command !== COMMAND) return null;
  const parsed = parseRevisionTransactionPlan(args);
  if (!parsed.ok) return invalid(parsed.message);
  if (!services.packageLoader || !services.authoringInputRoots?.length) {
    return failure("capability_unavailable", "Revision transaction planning is unavailable on this host.", "Configure package loading and approved authoring input roots before retrying.");
  }
  try {
    await assertPlanInputRoot(parsed.value.packageRoot, services);
    const pkg = await services.packageLoader(parsed.value.packageRoot);
    await assertPlanInputRoot(pkg.root, services);
    const [manifestSha256, motionSha256] = await Promise.all([
      hashPackageFile(resolvePackageAsset(pkg, "manifest.json")), hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion))
    ]);
    if (!sameBase(parsed.value.base, pkg, manifestSha256, motionSha256)) {
      return failure("revision_base_mismatch", "The source package does not match the requested base identity and hashes.", "Re-read the package identity and authored-document hashes, then retry against that exact revision.");
    }
    const schema = await loadSchema("motion");
    const replay = await applyRevisionTransactionSteps(pkg.motion, parsed.value.steps, schema);
    const persistedMotion = compileMotionDocumentCompositing(replay.motion);
    const validation = await validateDocument(schema, persistedMotion);
    if (!validation.ok) return invalidStep(parsed.value.steps.length - 1, "final", "The final Motion document failed validation.");
    const steps = boundedStepSummaries(replay.steps);
    if (!steps) return failure("revision_plan_too_large", "The revision transaction plan exceeded its fixed output budget.");
    const result = {
      packageId: pkg.manifest.id, motionId: pkg.motion.id, base: parsed.value.base,
      transactionSha256: parsed.value.transactionSha256, steps,
      final: { manifestSha256, motionSha256: motionDocumentFileSha256(persistedMotion) },
      validation: { ok: true, errorCount: 0 }, warnings: [] as string[]
    };
    if (Buffer.byteLength(canonicalJson(result), "utf8") > MAX_PLAN_BYTES) {
      return failure("revision_plan_too_large", "The revision transaction plan exceeded its fixed output budget.");
    }
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: COMMAND, packageId: pkg.manifest.id, motionId: pkg.motion.id, stepCount: steps.length },
      result, warnings: []
    };
  } catch (error) {
    if (error instanceof RevisionStepError) return invalidStep(error.index, error.command, error.message);
    if (error instanceof RevisionTransactionPlanRootError) return invalid(error.message);
    return failure("revision_transaction_failed", "motion.revision.transaction.plan could not complete.");
  }
}

class RevisionTransactionPlanRootError extends Error {}
async function assertPlanInputRoot(packageRoot: string, services: RevisionTransactionPlanServices): Promise<void> {
  try { await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots); }
  catch { throw new RevisionTransactionPlanRootError("motion.revision.transaction.plan packageRoot is outside the configured authoring input roots."); }
}
function sameBase(base: RevisionBase, pkg: MotionPackage, manifestSha256: string, motionSha256: string): boolean {
  return base.packageId === pkg.manifest.id && base.motionId === pkg.motion.id && base.manifestSha256 === manifestSha256 && base.motionSha256 === motionSha256;
}
function boundedStepSummaries(steps: AppliedRevisionStep[]): Array<Pick<AppliedRevisionStep, "index" | "command" | "stepSha256" | "changedPaths">> | null {
  if (steps.some((step) => step.changedPaths.length > MAX_CHANGED_PATHS_PER_STEP || step.changedPaths.some((path) => Buffer.byteLength(path, "utf8") > MAX_CHANGED_PATH_BYTES))) return null;
  return steps.map(({ index, command, stepSha256, changedPaths }) => ({ index, command, stepSha256, changedPaths }));
}
function invalid(message: string): MotionDebugResult { return failure("invalid_args", message); }
function invalidStep(index: number, command: string, message: string): MotionDebugResult {
  return failure("revision_step_invalid", `Revision step ${index} (${command}) failed: ${message}`, undefined, { index, command });
}
function failure(code: string, message: string, suggestedAction?: string, detail?: Record<string, unknown>): MotionDebugResult {
  return { ok: false, error: { code, message, ...(suggestedAction ? { suggestedAction } : {}), ...(detail ? { detail } : {}) }, warnings: [] };
}
