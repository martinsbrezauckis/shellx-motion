import { debugCommandDefinition, type MotionDebugCommand, type MotionDebugResult } from "./command-registry.js";
import {
  assertConfiguredAuthoringInputFile,
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringPackageCreateRoot,
  assertConfiguredAuthoringPackageEditRoots,
  assertConfiguredAuthoringOutputFile,
  assertConfiguredAuthoringOutputRoot,
  AuthoringRootPolicyError
} from "./domains/authoring-root-policy.js";
import type { MotionPermissionTier } from "@shellx-motion/actions";
import { resolve } from "node:path";

interface AuthoringRootContext {
  tier: MotionPermissionTier;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  /** Host-owned receipt publication root; a caller cannot nominate it. */
  receiptsRoot?: string;
}

const TIER_ORDER: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

/** Refuse caller-steered package creation and copy-on-write edits outside host-approved roots. */
export async function refuseUntrustedCallerPackageAuthoring(
  command: MotionDebugCommand,
  args: unknown,
  context: AuthoringRootContext
): Promise<MotionDebugResult | null> {
  const definition = debugCommandDefinition(command);
  if (!definition?.mutates) return null;
  if (TIER_ORDER.indexOf(context.tier) < TIER_ORDER.indexOf(definition.permission)) return null;
  const record = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : null;
  try {
    if (command === "motion.package.create") {
      const packageRoot = stringField(record, "packageRoot");
      await assertConfiguredAuthoringPackageCreateRoot(
        packageRoot, context.authoringInputRoots, context.authoringOutputRoots, command
      );
      return null;
    }
    if (definition.permission === "edit_motion") {
      await assertConfiguredAuthoringPackageEditRoots(
        stringField(record, "packageRoot"), firstStringField(record, ["outDir", "packageDir"]),
        context.authoringInputRoots, context.authoringOutputRoots, command
      );
      if (command === "motion.template.media.replace") {
        await assertConfiguredAuthoringInputFile(
          stringField(record, "assetPath"),
          context.authoringInputRoots,
          `${command} assetPath`,
        );
      }
      return null;
    }
    await assertCallerWriteLocalPathRoles(command, record, context);
    return null;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof AuthoringRootPolicyError ? error.code : "authoring_path_not_approved",
        message: error instanceof Error ? error.message : "Motion package authoring path is not approved."
      },
      warnings: []
    };
  }
}

/**
 * Caller-steered write_local commands that cross an authoring filesystem boundary.
 *
 * Keep this list at the caller boundary rather than the domain handlers. The handlers also serve
 * direct CLI/in-process dispatch where the embedding host owns every path, whereas prompt re-entry
 * and authenticated transports do not. `motion.support.bundle` deliberately keeps its existing
 * scratch-output policy; only its optional package inspection is an authoring input read. We use
 * authoringInputRoots for that package read because it is the existing host-owned package/input
 * class for write-local authoring, rather than silently promoting render roots to authoring roots.
 */
async function assertCallerWriteLocalPathRoles(
  command: MotionDebugCommand,
  record: Record<string, unknown> | null,
  context: AuthoringRootContext
): Promise<void> {
  switch (command) {
    case "motion.package.archive": {
      await assertConfiguredAuthoringInputRoot(stringField(record, "packageRoot"), context.authoringInputRoots, `${command} packageRoot`);
      await assertConfiguredAuthoringOutputFile(firstStringField(record, ["archivePath", "outPath", "out"]), context.authoringOutputRoots, `${command} archivePath`);
      await assertOptionalReceiptOutput(record, context, command);
      return;
    }
    case "motion.package.extract": {
      await assertConfiguredAuthoringInputFile(firstStringField(record, ["archivePath", "inPath", "archive"]), context.authoringInputRoots, `${command} archivePath`);
      const packageRoot = firstStringField(record, ["packageRoot", "outDir", "out"]);
      await assertConfiguredAuthoringOutputRoot(packageRoot, context.authoringOutputRoots, `${command} packageRoot`);
      await assertEffectiveExtractReceiptOutput(record, packageRoot, context, command);
      return;
    }
    case "motion.review.html.bundle": {
      const packageRoot = optionalStringField(record, "packageRoot");
      if (packageRoot) await assertConfiguredAuthoringInputRoot(packageRoot, context.authoringInputRoots, `${command} packageRoot`);
      await assertConfiguredAuthoringOutputRoot(stringField(record, "outDir"), context.authoringOutputRoots, `${command} outDir`);
      return;
    }
    case "motion.support.bundle": {
      const packageRoot = optionalStringField(record, "packageRoot");
      if (packageRoot) await assertConfiguredAuthoringInputRoot(packageRoot, context.authoringInputRoots, `${command} packageRoot`);
      return;
    }
    case "motion.analysis.tracking.request":
      await assertConfiguredAuthoringInputRoot(stringField(record, "packageRoot"), context.authoringInputRoots, `${command} packageRoot`);
      await assertConfiguredAuthoringOutputRoot(firstStringField(record, ["outDir", "packageDir"]), context.authoringOutputRoots, `${command} outDir`);
      return;
    default:
      return;
  }
}

/**
 * Archive receipts are caller-selected output files. An explicitly configured host receipt root is
 * also a receipt publication authority; chooser-granted receipt roots intentionally are not.
 */
async function assertOptionalReceiptOutput(
  record: Record<string, unknown> | null,
  context: AuthoringRootContext,
  command: MotionDebugCommand
): Promise<void> {
  const receiptPath = optionalStringField(record, "receiptPath");
  if (!receiptPath) return;
  const receiptOutputRoots = [...(context.authoringOutputRoots ?? []), ...(context.receiptsRoot ? [context.receiptsRoot] : [])];
  await assertConfiguredAuthoringOutputFile(receiptPath, receiptOutputRoots, `${command} receiptPath`);
}

/**
 * Extraction writes a receipt even when the caller omits receiptPath. Match Core's effective
 * default exactly so the caller fence authorizes that sibling before the extraction sink runs.
 */
async function assertEffectiveExtractReceiptOutput(
  record: Record<string, unknown> | null,
  packageRoot: string,
  context: AuthoringRootContext,
  command: MotionDebugCommand
): Promise<void> {
  // Core resolves packageRoot before deriving its default sibling. Keep the caller boundary in
  // exactly that order so spelling aliases such as a trailing slash or `child/..` cannot make the
  // fence authorize a different path from the publication sink.
  const receiptPath = optionalStringField(record, "receiptPath") || `${resolve(packageRoot)}.package-extract.receipt.json`;
  const receiptOutputRoots = [...(context.authoringOutputRoots ?? []), ...(context.receiptsRoot ? [context.receiptsRoot] : [])];
  await assertConfiguredAuthoringOutputFile(resolve(receiptPath), receiptOutputRoots, `${command} receiptPath`);
}

function firstStringField(record: Record<string, unknown> | null, fields: readonly string[]): string {
  for (const field of fields) {
    const value = optionalStringField(record, field);
    if (value !== undefined) return value;
  }
  return "";
}

function stringField(record: Record<string, unknown> | null, field: string): string {
  return optionalStringField(record, field) ?? "";
}

function optionalStringField(record: Record<string, unknown> | null, field: string): string | undefined {
  return typeof record?.[field] === "string" ? record[field] as string : undefined;
}
