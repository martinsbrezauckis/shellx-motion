/** Package-backed Debug commands for the closed Core group-layout compiler. */
import {
  canonicalJsonSha256,
  compileMotionDocumentCompositing,
  motionLayoutGapAnimationStorePresent,
  runMotionLayoutDebug,
  type MotionPackage,
  type MotionDocument,
  type OperationReceipt,
  type MotionLayoutDebugResult,
  type MotionLayoutDebugRemoval,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  type TimelineCommonEditArgs,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";
import {
  isTimelineLayoutCommand,
  readTimelineLayoutIntent,
  type TimelineLayoutIntent,
} from "./timeline-layout.js";
import {
  authorizeLayoutApplicationRemoval,
  abortPreparedLayoutApplicationAuthority,
  finalizePreparedLayoutApplicationAuthority,
  layoutApplyHostReceiptId,
  prepareLayoutApplicationAuthority,
} from "./timeline-layout-application-authority.js";
import type { LayoutApplicationFacts, LayoutMutation } from "./timeline-layout-authoring-types.js";
/** Never user supplied; the Core receipt is intentionally discarded in favour of the outer package receipt. */
const INNER_RECEIPT_CREATED_AT = "1970-01-01T00:00:00.000Z";

export interface TimelineLayoutAuthoringServices extends TimelinePackageEditServices {}

export async function dispatchTimelineLayoutAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineLayoutAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineLayoutCommand(command)) return null;
  const parsed = readTimelineLayoutIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect" || parsed.intent.kind === "compile") return readOnly(command, parsed.intent, services);
  const common = readHostConfiguredTimelineCommonEditArgs(command, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const receiptsRoot = configuredLayoutReceiptsRoot(services);
  if (typeof receiptsRoot !== "string") return receiptsRoot;
  return commitLayoutMutation(command, parsed.intent, { ...common, receiptsRoot }, services);
}

async function readOnly(
  command: MotionDebugCommand,
  intent: Extract<TimelineLayoutIntent, { kind: "inspect" | "compile" }>,
  services: TimelineLayoutAuthoringServices,
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return capabilityUnavailable("Timeline layout inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(intent.packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(intent.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const result = runCoreLayout(pkg.motion, intent);
    if (result.status !== "ok" || (result.operation !== "inspect" && result.operation !== "compile")) throw new Error(layoutRefusal(result));
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, compilation: result.compilation },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, compilation: result.compilation },
      warnings: [...result.receipt.warnings],
    };
  } catch (error) {
    return commandFailure("timeline_layout_read_failed", error);
  }
}

function commitLayoutMutation(
  command: MotionDebugCommand,
  intent: Extract<TimelineLayoutIntent, { kind: "apply" | "remove" }>,
  common: TimelineCommonEditArgs,
  services: TimelineLayoutAuthoringServices,
): Promise<MotionDebugResult> {
  const receiptStem = `timeline-layout-${intent.kind}`;
  return commitAtomicTimelineMutation<LayoutMutation>({
    ...common,
    command,
    receiptPrefix: receiptStem,
    receiptFileName: `${receiptStem}.receipt.json`,
    invalidCode: "timeline_layout_invalid",
    failureCode: "timeline_layout_failed",
    services,
    mutate: async (pkg) => await mutationFromCore(pkg, intent, common.receiptsRoot!),
    ...(intent.kind === "apply" ? {
      receiptId: ({ pkg, mutation }: { pkg: MotionPackage; mutation: LayoutMutation }) => layoutApplyHostReceiptId(pkg.manifest.id, mutation.application.id),
      hostAuthorityPair: ({ pkg, mutation, receipt }: { pkg: MotionPackage; mutation: LayoutMutation; receipt: OperationReceipt }) => ({
        prepare: async (preparation) => {
          if (mutation.operation !== "apply") throw new Error("Only a layout apply may prepare a layout removal authority.");
          return await prepareLayoutApplicationAuthority({
            receiptsRoot: preparation.receiptsRoot,
            packageRoot: preparation.expectedPackageRoot,
            manifestPath: preparation.manifestPath,
            motionPath: preparation.motionPath,
            stagedPackageRoot: preparation.stagedPackageRoot,
            expectedPackageRoot: preparation.expectedPackageRoot,
            stagedManifestPath: preparation.manifestPath,
            stagedMotionPath: preparation.motionPath,
            persistedMotionSha256: preparation.persistedMotionSha256,
            packageId: pkg.manifest.id,
            applicationId: mutation.application.id,
            applicationFingerprint: mutation.application.fingerprint,
            receipt,
          });
        },
        finalize: async (prepared, commit) => await finalizePreparedLayoutApplicationAuthority({
          prepared,
          commit: { ...commit, packageId: pkg.manifest.id },
        }),
        abort: async (prepared) => await abortPreparedLayoutApplicationAuthority(prepared),
      }),
    } : {}),
    outputFacts: layoutFacts,
    resultFacts: layoutFacts,
    receiptWarnings: (mutation) => mutation.receiptWarnings,
    visibleFacts: (mutation) => ({
      operation: mutation.operation,
      removal: mutation.removal,
      application: mutation.application,
      layoutFingerprint: mutation.compilation.layoutFingerprint,
      budget: mutation.compilation.budget,
      overflow: mutation.compilation.overflow,
      repeaters: mutation.compilation.repeaters,
      changedLayerIds: mutation.changedLayerIds,
      outputMotionSha256: mutation.outputMotionSha256,
      ...(mutation.revertedAppliedFingerprint ? { revertedAppliedFingerprint: mutation.revertedAppliedFingerprint } : {}),
    }),
  });
}

async function mutationFromCore(
  pkg: MotionPackage,
  intent: Extract<TimelineLayoutIntent, { kind: "apply" | "remove" }>,
  receiptsRoot: string,
): Promise<LayoutMutation> {
  if (intent.kind === "remove" && motionLayoutGapAnimationStorePresent(pkg.motion)) {
    throw new Error("remove layout gap track first");
  }
  const removalAuthorization = intent.kind === "remove"
    ? await authorizeLayoutApplicationRemoval({
      receiptsRoot,
      pkg,
      applicationId: intent.removal.applicationId,
      applicationFingerprint: intent.removal.applicationFingerprint,
    })
    : undefined;
  const result = runCoreLayout(pkg.motion, intent, removalAuthorization
    ? { packageId: pkg.manifest.id, removalAuthorization }
    : undefined);
  if (result.status !== "ok" || (result.operation !== "apply" && result.operation !== "remove")) throw new Error(layoutRefusal(result));
  const coreFacts = mutationReceiptFacts(result);
  let removal: MotionLayoutDebugRemoval;
  if (result.operation === "apply") {
    if (intent.kind !== "apply") throw new Error("Layout Core operation did not match the requested remove intent.");
    removal = result.applied.removal;
  } else {
    if (intent.kind !== "remove") throw new Error("Layout Core operation did not match the requested apply intent.");
    removal = intent.removal;
  }
  if (coreFacts.application.id !== removal.applicationId || coreFacts.application.fingerprint !== removal.applicationFingerprint) {
    throw new Error("Layout Core application evidence does not match the removal marker.");
  }
  const persistedMotion = compileMotionDocumentCompositing(result.motion);
  const outputMotionSha256 = canonicalJsonSha256(persistedMotion);
  return {
    motion: persistedMotion,
    operation: result.operation,
    compilation: result.compilation,
    removal,
    application: coreFacts.application,
    changedLayerIds: coreFacts.changedLayerIds,
    receiptWarnings: [...result.receipt.warnings],
    outputMotionSha256,
    ...(coreFacts.revertedAppliedFingerprint ? { revertedAppliedFingerprint: coreFacts.revertedAppliedFingerprint } : {}),
  };
}

/** Core owns both ordinary and materialized changes; Debug mirrors only its bounded receipt facts. */
function mutationReceiptFacts(result: Extract<MotionLayoutDebugResult, { status: "ok"; operation: "apply" | "remove" }>): {
  changedLayerIds: string[];
  application: LayoutApplicationFacts;
  outputMotionSha256: string;
  revertedAppliedFingerprint?: string;
} {
  const output = result.receipt.output;
  if (!isRecord(output)) throw new Error("Layout Core mutation receipt has no readable output facts.");
  const changedLayerIds = output.changedLayerIds;
  if (!Array.isArray(changedLayerIds) || changedLayerIds.some((layerId) => typeof layerId !== "string" || !layerId)) {
    throw new Error("Layout Core mutation receipt changedLayerIds is malformed.");
  }
  const outputMotionSha256 = output.outputMotionSha256;
  if (typeof outputMotionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(outputMotionSha256)) {
    throw new Error("Layout Core mutation receipt outputMotionSha256 is malformed.");
  }
  if (outputMotionSha256 !== canonicalJsonSha256(result.motion)) {
    throw new Error("Layout Core mutation receipt outputMotionSha256 does not match its returned Motion document.");
  }
  const revertedAppliedFingerprint = output.revertedAppliedFingerprint;
  if (revertedAppliedFingerprint !== undefined && (typeof revertedAppliedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(revertedAppliedFingerprint))) {
    throw new Error("Layout Core mutation receipt revertedAppliedFingerprint is malformed.");
  }
  if (result.operation === "remove" && revertedAppliedFingerprint === undefined) {
    throw new Error("Layout Core removal receipt is missing revertedAppliedFingerprint.");
  }
  const application = readApplicationFacts(output.application, result.operation);
  return {
    changedLayerIds: [...changedLayerIds],
    application,
    outputMotionSha256,
    ...(revertedAppliedFingerprint === undefined ? {} : { revertedAppliedFingerprint }),
  };
}

function runCoreLayout(
  motion: MotionDocument,
  intent: TimelineLayoutIntent,
  options?: Parameters<typeof runMotionLayoutDebug>[1],
): MotionLayoutDebugResult {
  const base = { schema: "shellx-motion/debug-layout-intent@1", motion, createdAt: INNER_RECEIPT_CREATED_AT } as const;
  if (intent.kind === "remove") return runMotionLayoutDebug({ ...base, operation: "remove", removal: intent.removal }, options);
  return runMotionLayoutDebug({ ...base, operation: intent.kind, groupId: intent.groupId, layout: intent.layout, repeaters: intent.repeaters });
}

function configuredLayoutReceiptsRoot(services: TimelineLayoutAuthoringServices): string | MotionDebugResult {
  if (!services.receiptsRoot) return capabilityUnavailable("Timeline layout apply and remove require a host-configured receiptsRoot.");
  return services.receiptsRoot;
}

function layoutFacts(mutation: LayoutMutation): Record<string, unknown> {
  return {
    operation: mutation.operation,
    compilation: mutation.compilation,
    removal: mutation.removal,
    application: mutation.application,
    layoutFingerprint: mutation.compilation.layoutFingerprint,
    layoutFingerprintInput: mutation.compilation.layoutFingerprintInput,
    budget: mutation.compilation.budget,
    overflow: mutation.compilation.overflow,
    repeaters: mutation.compilation.repeaters,
    changedLayerIds: mutation.changedLayerIds,
    outputMotionSha256: mutation.outputMotionSha256,
    ...(mutation.revertedAppliedFingerprint ? { revertedAppliedFingerprint: mutation.revertedAppliedFingerprint } : {}),
  };
}

function readApplicationFacts(value: unknown, operation: "apply" | "remove"): LayoutApplicationFacts {
  const record = exactReceiptRecord(value, ["disposition", "id", "fingerprint", "groupId", "sourceChildLayerIds", "materializedChildLayerIds", "generatedLayerIds", "trackOrders"], "application");
  const disposition = record.disposition;
  if (disposition !== "applied" && disposition !== "removed") throw new Error("Layout Core application evidence disposition is malformed.");
  if (disposition !== (operation === "apply" ? "applied" : "removed")) throw new Error("Layout Core application evidence disposition does not match its operation.");
  const id = readReceiptIdentifier(record.id, "application.id");
  const fingerprint = readReceiptSha256(record.fingerprint, "application.fingerprint");
  const groupId = readReceiptIdentifier(record.groupId, "application.groupId");
  const sourceChildLayerIds = readReceiptIdentifiers(record.sourceChildLayerIds, "application.sourceChildLayerIds", 1, 256);
  const materializedChildLayerIds = readReceiptIdentifiers(record.materializedChildLayerIds, "application.materializedChildLayerIds", 1, 256);
  const generatedLayerIds = readReceiptIdentifiers(record.generatedLayerIds, "application.generatedLayerIds", 0, 256);
  const sourceIds = new Set(sourceChildLayerIds);
  const expectedMaterialized = materializedChildLayerIds.filter((layerId) => sourceIds.has(layerId));
  const expectedGenerated = materializedChildLayerIds.filter((layerId) => !sourceIds.has(layerId));
  if (!sameStrings(expectedMaterialized, sourceChildLayerIds) || !sameStrings(expectedGenerated, generatedLayerIds)) {
    throw new Error("Layout Core application evidence does not preserve the exact source-plus-generated child order.");
  }
  return {
    disposition,
    id,
    fingerprint,
    groupId,
    sourceChildLayerIds,
    materializedChildLayerIds,
    generatedLayerIds,
    trackOrders: readTrackOrders(record.trackOrders),
  };
}

function readTrackOrders(value: unknown): LayoutApplicationFacts["trackOrders"] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Layout Core application evidence trackOrders is malformed.");
  const trackIds = new Set<string>();
  return value.map((entry, index) => {
    const record = exactReceiptRecord(entry, ["trackId", "beforeLayerIds", "afterLayerIds"], `application.trackOrders[${index}]`);
    const trackId = readReceiptIdentifier(record.trackId, `application.trackOrders[${index}].trackId`);
    if (trackIds.has(trackId)) throw new Error("Layout Core application evidence trackOrders must have unique track ids.");
    trackIds.add(trackId);
    return {
      trackId,
      beforeLayerIds: readReceiptIdentifiers(record.beforeLayerIds, `application.trackOrders[${index}].beforeLayerIds`, 0, 512),
      afterLayerIds: readReceiptIdentifiers(record.afterLayerIds, `application.trackOrders[${index}].afterLayerIds`, 0, 512),
    };
  });
}

function exactReceiptRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length > 0) throw new Error(`Layout Core ${label} is malformed.`);
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`Layout Core ${label} must contain exact fields.`);
  }
  for (const key of keys) if (!("value" in Object.getOwnPropertyDescriptor(value, key)!)) throw new Error(`Layout Core ${label}.${key} must be a data property.`);
  return value;
}

function readReceiptIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new Error(`Layout Core ${label} is malformed.`);
  return value;
}
function readReceiptSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Layout Core ${label} is malformed.`);
  return value;
}

function readReceiptIdentifiers(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Layout Core ${label} is malformed.`);
  const identifiers = value.map((entry, index) => readReceiptIdentifier(entry, `${label}[${index}]`));
  if (new Set(identifiers).size !== identifiers.length) throw new Error(`Layout Core ${label} must have unique ids.`);
  return identifiers;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function layoutRefusal(result: MotionLayoutDebugResult): string {
  return result.status === "refused" ? result.issues.map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`).join("; ") : "Layout operation returned an unexpected result.";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function capabilityUnavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function commandFailure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
