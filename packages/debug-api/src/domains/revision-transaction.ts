/** Bounded, typed, hidden-copy revision transaction command. */
import {
  compileMotionDocumentCompositing, hashPackageFile, loadSchema, resolvePackageAsset, validateDocument,
  type MotionPackage, type OperationReceipt
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot, assertConfiguredAuthoringOutputRoot } from "./authoring-root-policy.js";
import { commitMotionDocumentTransaction, motionDocumentFileSha256 } from "./revision-transaction-commit.js";
import { parseRevisionTransaction, type RevisionBase } from "./revision-transaction-parser.js";
import { applyRevisionTransactionSteps, RevisionStepError } from "./revision-transaction-replay.js";
import type { TimelinePackageEditServices } from "./timeline-package-edit.js";

const COMMAND = "motion.revision.transaction" as const;
const RECEIPT_FILE = "revision-transaction.receipt.json";

export interface RevisionTransactionServices extends Pick<TimelinePackageEditServices, "packageLoader" | "isUnsafePackageOutputDirectory" | "isEmptyOrAbsentDirectory"> {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
}

export async function dispatchRevisionTransactionCommand(command: MotionDebugCommand, args: unknown, services: RevisionTransactionServices): Promise<MotionDebugResult | null> {
  if (command !== COMMAND) return null;
  const parsed = parseRevisionTransaction(args);
  if (!parsed.ok) return invalid(parsed.message);
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return failure("capability_unavailable", "Atomic revision transactions are unavailable on this host.", "Configure package loading and copy-on-write output safety before retrying.");
  }
  try {
    await assertTransactionInputRoot(parsed.value.packageRoot, services);
    await assertTransactionOutputRoot(parsed.value.outDir, services);
    const pkg = await services.packageLoader(parsed.value.packageRoot);
    const outDir = resolve(parsed.value.outDir);
    await assertTransactionInputRoot(pkg.root, services);
    await assertTransactionOutputRoot(outDir, services);
    if (await services.isUnsafePackageOutputDirectory(pkg.root, outDir)) return invalid("motion.revision.transaction outDir must be outside packageRoot.");
    if (!await services.isEmptyOrAbsentDirectory(outDir)) return invalid("motion.revision.transaction outDir must be empty or absent before package copy.");
    const [manifestSha256, motionSha256] = await Promise.all([
      hashPackageFile(resolvePackageAsset(pkg, "manifest.json")), hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion))
    ]);
    if (!sameBase(parsed.value.base, pkg, manifestSha256, motionSha256)) {
      return failure("revision_base_mismatch", "The source package does not match the requested base identity and hashes.", "Re-read the package identity and authored-document hashes, then retry against that exact revision.");
    }
    const schema = await loadSchema("motion");
    const preflight = await applyRevisionTransactionSteps(pkg.motion, parsed.value.steps, schema);
    const persistedMotion = compileMotionDocumentCompositing(preflight.motion);
    const validation = await validateDocument(schema, persistedMotion);
    if (!validation.ok) return invalidStep(parsed.value.steps.length - 1, "final", "The final Motion document failed validation.", validation);
    const finalMotionSha256 = motionDocumentFileSha256(persistedMotion);
    const output = {
      packageDir: outDir, manifestPath: join(outDir, "manifest.json"), motionPath: join(outDir, pkg.manifest.motion),
      packageId: pkg.manifest.id, motionId: pkg.motion.id, source: { ...parsed.value.base },
      final: { manifestSha256, motionSha256: finalMotionSha256 }, transactionSha256: parsed.value.transactionSha256,
      stepCount: preflight.steps.length, steps: preflight.steps, validation, ...(parsed.value.createdBy ? { createdBy: parsed.value.createdBy } : {})
    };
    const receiptPath = join(outDir, "receipts", RECEIPT_FILE);
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1", id: `revision-transaction-${pkg.manifest.id}-${parsed.value.transactionSha256.slice(0, 16)}`,
      operation: "revision.transaction", status: "passed", packageId: pkg.manifest.id,
      inputHashes: { "manifest.json": manifestSha256, [pkg.manifest.motion]: motionSha256, "revision.transaction": parsed.value.transactionSha256 },
      createdAt: new Date().toISOString(), lane: "debug-api", output,
      artifacts: [
        { role: "motion_package", path: outDir, status: "available", primary: true },
        { role: "revision_transaction_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
      ], warnings: []
    };
    await commitMotionDocumentTransaction({
      sourcePackage: pkg, outputRoot: outDir, receipt, receiptFileName: RECEIPT_FILE, expectedPersistedMotionSha256: finalMotionSha256,
      apply: async (stagedMotion) => {
        const replay = await applyRevisionTransactionSteps(stagedMotion, parsed.value.steps, schema);
        return { motion: replay.motion, steps: replay.steps, validation: replay.validation };
      }
    });
    return {
      ok: true, receiptId: receipt.id,
      visibleState: { panel: "timeline", operation: receipt.operation, packageId: pkg.manifest.id, motionId: pkg.motion.id, packageDir: outDir, stepCount: preflight.steps.length, receiptPath },
      result: {
        ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, packageDir: outDir, manifestPath: output.manifestPath, motionPath: output.motionPath,
        receiptPath, base: parsed.value.base, final: output.final, transactionSha256: parsed.value.transactionSha256, steps: preflight.steps, validation, receipt
      }, warnings: []
    };
  } catch (error) {
    if (error instanceof RevisionStepError) return invalidStep(error.index, error.command, error.message);
    if (error instanceof RevisionTransactionRootError) return invalid(error.message);
    return failure("revision_transaction_failed", "motion.revision.transaction could not complete.");
  }
}

class RevisionTransactionRootError extends Error {}
async function assertTransactionInputRoot(packageRoot: string, services: RevisionTransactionServices): Promise<void> {
  try { await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots); }
  catch { throw new RevisionTransactionRootError("motion.revision.transaction packageRoot is outside the configured authoring input roots."); }
}
async function assertTransactionOutputRoot(outDir: string, services: RevisionTransactionServices): Promise<void> {
  try { await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots); }
  catch { throw new RevisionTransactionRootError("motion.revision.transaction outDir is outside the configured authoring output roots."); }
}

function sameBase(base: RevisionBase, pkg: MotionPackage, manifestSha256: string, motionSha256: string): boolean {
  return base.packageId === pkg.manifest.id && base.motionId === pkg.motion.id && base.manifestSha256 === manifestSha256 && base.motionSha256 === motionSha256;
}
function invalid(message: string): MotionDebugResult { return failure("invalid_args", message); }
function invalidStep(index: number, command: string, message: string, validation?: unknown): MotionDebugResult {
  return failure("revision_step_invalid", `Revision step ${index} (${command}) failed: ${message}`, undefined, { index, command, ...(validation ? { validation } : {}) });
}
function failure(code: string, message: string, suggestedAction?: string, detail?: Record<string, unknown>): MotionDebugResult {
  return { ok: false, error: { code, message, ...(suggestedAction ? { suggestedAction } : {}), ...(detail ? { detail } : {}) }, warnings: [] };
}
