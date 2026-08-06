import { tierRefusal, type MotionPermissionTier } from "@shellx-motion/actions";
import { analyzeTrackingMedia } from "@shellx-motion/analysis-tracking";
import { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "@shellx-motion/adapters-html";
import { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "@shellx-motion/adapters-otio";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import { resolvePackageAudioInputs } from "@shellx-motion/connectors";
import type { AgentRuntime } from "@shellx-motion/agent-runtime";
import {
	  comparePngFiles,
  audioQualityMeasurementRequired,
  evaluateAudioQuality,
  extractMotionPackageArchive,
	  expandMotionPackageRows,
  filterMotionDataRows,
	  applyReceiptActor,
	  readReceiptActor,
	  compareCodeUnits,
	  hashBuffer,
	  hashFile,
	  hashFramePaths,
	  hashPackageFile,
		  inspectPngFile,
	  inspectPngFileRegion,
  inspectFrameSequence,
  inspectMotionTimeline,
  isSupportedEasing,
  easingToken,
  fetchSourceDocument,
  listRendererCapabilityCards,
  matchRendererCapabilityCards,
  resolveRendererCapabilityPipeline,
  writeMotionPackageArchive,
  readSupportedKeyframeTarget,
  loadDataRowsFile,
  loadSchema,
  loadPackageDataRows,
  listMotionEasingPresets,
  listTemplateControls,
  loadMotionPackage,
  parseCubicBezierEasing,
  prepareFramesDir,
  upsertBrowserWorkflowCatalog,
  resolveEasing,
  resolvePackageAsset,
  summarizeFrameQuality,
  type NetworkAddressResolver,
  type SourceImportFetcher,
  listMotionAnimationPresets,
  readMotionAnimationPreset,
  validateDocument,
  writeReviewBundle,
  escalateReceiptStatusForWarnings,
  jobOutcomeForReceiptStatus,
  type ExpandedMotionJob,
  type AudioQualityThresholds,
  type MotionPackage,
  type MotionDocument,
  type MotionDataRow,
  type MotionAudioDucking,
  type MotionCrop,
  type MotionEasing,
  type MotionKeyframe,
  type MotionLayer,
  // One readability rule for every surface: the panels below, the timeline evaluator and
  // motion.package.validate all ask core the same question about a keyframe.
  isReadableMotionKeyframe,
  readNumericKeyframes,
  unreadableKeyframesRefusal,
  type RendererCapabilityCard,
  type RendererCapabilityCardMatch,
  type RendererCapabilityMatchOptions,
  type RendererCapabilityPipeline,
  type MotionTransition,
  type MotionTrack,
  JOB_STATES,
  createMotionPackage,
  motionCallerId,
  MotionHostJob,
  runInMotionHostJob,
  MotionJobView,
  JOB_STATUS_CONTRACT,
  type JobErrorCode,
  type JobState,
  type OperationReceipt,
  type ReceiptActor,
  type ReceiptArtifact,
  type AgentAuthoringJob,
  type AgentRevisionContactSheetEvidence,
  type TemplateLicense,
  type TemplatePerformance,
  type TemplateValue
} from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import {
  audioWarningsForExportPreset,
  buildEncodeImageSequenceCommand,
  checkFfmpeg,
  createImageSequenceReceipt,
  createGovernedFfmpegRunner,
  createStillFrameReceipt,
  encodeImageSequenceWithPolicy,
  ffmpegPresetOutputPathError,
  frameExtractionInputArgs,
  frameExtractionPngOutputArgs,
  readFfmpegExportPreset,
  readImageSequenceExportPreset,
  readMotionExportPreset,
  readStillFrameExportPreset,
  listMotionExportPresets,
  measureAudioLevels,
  probeMedia,
  resolveMotionExportPreset,
  resolveFfmpegExecutable,
  stillFrameOutputPathError,
  type FfmpegCommand,
  type FfmpegAudioInput,
  type MotionExportPreset,
  type MotionExportPresetSpec,
  type FfmpegProcessResult,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { type MotionPromptRuntime } from "@shellx-motion/prompt";
import { enforceRawPromptExpiry } from "./receipt-raw-prompt-purge.js";
import {
  MAX_DEBUG_RECEIPT_BYTES,
  discoverJsonFiles,
  readPlatformReceiptEntries,
  type PlatformReceiptEntry
} from "./receipt-store-discovery.js";
import { constants as fsConstants, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  debugCommandDefinition,
  DEBUG_COMMANDS,
  type MotionDebugArgsSchema,
  type MotionDebugCommand,
  type MotionDebugResult
} from "./command-registry.js";
import { writeStaticGltfPackage } from "./domains/authoring-gltf-package.js";
import { writeStaticLottiePackage } from "./domains/authoring-lottie-package.js";
import { writeStaticDotLottiePackage } from "./domains/authoring-dotlottie-package.js";
import { dispatchDomainCommand } from "./domains/router.js";
import { callerSuppliedReceiptsRoot, refuseCallerReceiptsRoot } from "./caller-boundary.js";
import { matchRendererCapabilityCardsForRequest } from "./domains/capabilities.js";
import { parseBrowserWorkflow, readBrowserWorkflowArg, type BrowserFrameRenderer } from "./domains/integration-browser-workflow.js";
import type { FinalRenderRequest } from "./domains/render-final.js";
import type { BatchRenderRequest } from "./domains/render-batch.js";
import { commitMotionDocumentEdit } from "./domains/package-edit-transaction.js";
export * from "./authoring-package-api.js";
export { annotatePlanWithArgumentContracts } from "./domains/agent-plan-arguments.js";
// Canonical engine version constant, re-exported so every engine surface reports one value.
export { MOTION_ENGINE_VERSION } from "./version.js";
// The one receipt tool-provenance rule, re-exported so the CLI and SDK render paths stamp FFprobe
// through the same helper this package's own render handler uses (the tool-provenance invariant).
import { recordReceiptFfprobeProvenance } from "./receipt-tool-provenance.js";
export {
  applyReceiptToolIdentity,
  recordReceiptFfprobeProvenance,
  type ReceiptFfprobeProvenanceInput,
  type ReceiptToolProvenanceOutcome,
  type ReceiptToolProvenanceSkipReason
} from "./receipt-tool-provenance.js";
import {
  readTimelineControlState,
  visibleTimelineControlState,
  writeTimelineControlState,
  type TimelineControlState,
  type TimelineRangeState
} from "./domains/timeline-controls.js";
import { readMotionDurationPolicy, type DurationPolicy } from "./domains/timeline-duration-policy.js";

export {
  DEBUG_COMMANDS,
  debugCommandDefinition,
  debugCommandsByDomain,
  type MotionDebugArgPropertySchema,
  type MotionDebugArgsSchema,
  type MotionDebugCommand,
  type MotionDebugCommandContract,
  type MotionDebugDomain,
  type MotionDebugExpectedReceipt,
  type MotionDebugResult
} from "./command-registry.js";

type MotionDebugError = Extract<MotionDebugResult, { ok: false }>["error"];

export type { BrowserFrameRenderer } from "./domains/integration-browser-workflow.js";

// Re-export the receipt actor-attribution types so transport hosts (debug-server) that only depend
// on debug-api can build the `MotionDebugContext.actor` they pass into dispatch.
export type { ReceiptActor, ReceiptActorKind, ReceiptActorTransport } from "@shellx-motion/core";

export interface MotionDebugContext {
  tier: MotionPermissionTier;
  /**
   * Transport-observed actor attribution for this dispatch (see {@link ReceiptActor}). Populated by
   * the transport choke points — debug-server HTTP/WS/MCP dispatch, the CLI, and the local SDK — and
   * stamped onto every receipt this dispatch persists so the engine-room History can answer "BY WHO".
   * Optional: direct/legacy callers that observed no transport leave receipts unattributed. The
   * caller's `createdBy` claim still wins for the label; the transport facts here cannot be spoofed.
   */
  actor?: ReceiptActor;
  /**
   * Stable owner identity for the jobs this dispatch starts.
   *
   * Defaults to `${transport}:${label}` derived from {@link actor} when the host does not supply
   * one, which is stable across a host's processes in a way a pid or per-connection session id is
   * not. A host that runs several independent workspaces should set it explicitly
   * (`"cut:workspace-7"`), because that is the granularity at which its agents see each other's
   * work. See docs/public/host-integration.md.
   */
  callerId?: string;
  /**
   * Whether this host allows a caller to read jobs it does not own (`scope: "all"`).
   *
   * Defaults to false, and is a host decision rather than a permission tier because the tiers
   * describe what a caller may *do* to a package, while this describes whose evidence it may see.
   * An operator console is started with it; an agent embedded in a host is not, which is what stops
   * a Cut agent enumerating Design Studio's work.
   */
  crossCallerJobScope?: boolean;
  /**
   * Reads live leases and terminal job records as one. Defaults to the per-user stores, so
   * `motion.job.get` works without host configuration; pass null to disable job tracking.
   */
  jobView?: MotionJobView | null;
  agentRuntime?: Pick<AgentRuntime, "health">;
  promptRuntime?: MotionPromptRuntime;
  promptCwdRoots?: string[];
  ffmpegRunner?: FfmpegRunner;
  browserFrameRenderer?: BrowserFrameRenderer;
  sourceFetcher?: SourceImportFetcher;
  sourceResolver?: NetworkAddressResolver;
  scratchRoot?: string;
  qualityInputRoots?: string[];
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  receiptsRoot?: string;
  /**
   * Receipt roots a human granted during this server session through the Workbench's native folder
   * chooser. Set by the host, never by a caller — see `domains/receipts-root-policy.ts`.
   */
  operatorReceiptRoots?: string[];
  /**
   * Directories whose artifacts the host will let a receipt pull into a portable review bundle.
   *
   * Host-nominated on purpose. The bundle writer refuses receipt-referenced paths outside an approved
   * root, because a crafted receipt could otherwise name any readable file and have it copied into a
   * bundle someone then shares. Letting a CALLER pass the approval list would restore exactly that,
   * one level up, so this arrives only from host configuration.
   */
  artifactRoots?: string[];
}

interface PromptDebugCommandProposal {
  command: MotionDebugCommand;
  args: unknown;
}

interface PromptDebugCommandExecutionRecord {
  command: MotionDebugCommand;
  ok: boolean;
  receiptId?: string;
  error?: { code: string; message: string; suggestedAction?: string; detail?: unknown };
  warnings: string[];
}

interface PromptDebugCommandExecutionSummary {
  commandCount: number;
  receiptIds: string[];
  commands: PromptDebugCommandExecutionRecord[];
}

/**
 * The assembled command contracts live in ./command-metadata.ts so that domain modules can read
 * argument contracts without importing this dispatcher (which would be an import cycle).
 */
export { DEBUG_COMMAND_CONTRACTS, DEBUG_COMMAND_METADATA, debugCommandArgumentContract, debugCommandContract } from "./command-metadata.js";

/**
 * Re-exported for transport hosts that build tool listings.
 *
 * The MCP tool description is the only text most clients ever show, and it carried no statement of
 * what a command is FOR. debug-server needs this one line and otherwise has no reason to depend on
 * the actions package.
 */
export { purposeForCall } from "@shellx-motion/actions";

/**
 * Tier-refusal wording, re-exported for the same reason as `purposeForCall`.
 *
 * The transports refuse callers before dispatch ever runs — a `requestedTier` above the server
 * grant, an SDK operation above it — and those refusals must say the same thing the dispatch gate
 * says: the caller cannot elevate itself, and here is the host operator's change. Routing them
 * through one builder is what makes that a property of the product rather than of one code path.
 */
export { requestedTierRefusal, tierRefusal, type MotionTierRefusal } from "@shellx-motion/actions";

/**
 * The published enum dictionary, re-exported for transports that must RESOLVE `enumRef` before
 * advertising a schema.
 *
 * `enumRef` keeps a large shared value set in one place instead of duplicating it across dozens of
 * command schemas. That is right for the internal contract and wrong on the wire: a client sees a
 * non-standard keyword and NO values, so it cannot know what `preset` or a keyframe `target`
 * accepts. Resolving it at publish time is what makes the advertised schema honest.
 */
export { MOTION_DEBUG_ARG_ENUMS, debugArgEnum } from "./command-metadata-enums.js";

const TIER_ORDER: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

/** The owner identity for a dispatch: the host's explicit value, else derived from the actor. */
export function dispatchCallerId(context: Pick<MotionDebugContext, "callerId" | "actor">): string {
  return motionCallerId({ ...(context.callerId ? { callerId: context.callerId } : {}), ...(context.actor ?? {}) });
}

/**
 * The commands that are a *host's* unit of work rather than Motion's.
 *
 * Each of these takes minutes and is something a caller waits on, so each becomes one observable
 * job. The governed operations underneath — frame passes, capability probes, encodes — hold leases
 * for capacity but are never reported: one render is six of them, and listing "ffmpeg.version" as a
 * job answers a question nobody asked.
 */
const HOST_JOB_OPERATIONS: Partial<Record<MotionDebugCommand, { lane: string; operation: string }>> = {
  "motion.render.final": { lane: "ffmpeg", operation: "render.final" },
  "motion.render.batch": { lane: "batch", operation: "render.batch" }
};

/**
 * Refuse a caller-named `receiptsRoot` that falls outside the roots the host declared.
 *
 * Call this at a PRIVILEGE BOUNDARY, passing the value read from wherever THAT transport carries it
 * — top-level args on `POST /debug`, MCP and JSON-RPC; nested under `input` on `POST /sdk`. See
 * `caller-boundary.ts` for who counts as a caller and why the value is a parameter rather than
 * something this function digs out of `args` on its own.
 *
 * @param subject the command id or transport-and-operation label to name in the refusal.
 * @param requestedReceiptsRoot the caller's value, or undefined when it named none.
 * @returns the refusal to return to the caller, or null when the request may proceed.
 */
export async function refuseUntrustedCallerReceiptsRoot(
  subject: string,
  requestedReceiptsRoot: string | undefined,
  context: MotionDebugContext
): Promise<MotionDebugResult | null> {
  return refuseCallerReceiptsRoot(subject, requestedReceiptsRoot, context, isPathInsideTrustedRoot);
}

/**
 * Dispatch a command whose ARGUMENTS a caller steered, applying the boundary fence first.
 *
 * The counterpart to `dispatchDebugCommand`, which is for re-entry with host-derived paths. Picking
 * between the two is a statement about where the arguments came from, not about which command is
 * being run — see `caller-boundary.ts`.
 */
export async function dispatchCallerSteeredCommand(
  command: MotionDebugCommand,
  args: unknown,
  context: MotionDebugContext
): Promise<MotionDebugResult> {
  const refusal = await refuseUntrustedCallerReceiptsRoot(command, callerSuppliedReceiptsRoot(args), context);
  return refusal ?? dispatchDebugCommand(command, args, context);
}

export { callerSuppliedReceiptsRoot } from "./caller-boundary.js";

export async function dispatchDebugCommand(command: MotionDebugCommand, args: unknown, context: MotionDebugContext): Promise<MotionDebugResult> {
  const hostJobScope = HOST_JOB_OPERATIONS[command];
  // Only long host-level work is tracked. Wrapping every dispatch would put a lease and a record
  // behind `motion.state`, which is a read.
  if (!hostJobScope || context.jobView === null) {
    try {
      return await dispatchDebugCommandUnsafe(command, args, context);
    } catch (error) {
      return unhandledDebugCommandError(command, error);
    }
  }
  // Read directly rather than through a domain arg helper: this runs before dispatch, above the
  // layer those helpers belong to.
  const argsRecord = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const suppliedJobId = typeof argsRecord.jobId === "string" ? argsRecord.jobId : undefined;
  const job = await MotionHostJob.begin({
    ...(suppliedJobId ? { jobId: suppliedJobId } : {}),
    callerId: dispatchCallerId(context),
    lane: hostJobScope.lane,
    operation: hostJobScope.operation
  });
  try {
    const result = await runInMotionHostJob(job, () => dispatchDebugCommandUnsafe(command, args, context));
    if (result.ok) {
      await job.succeeded({ ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) });
    } else {
      await job.failed({ error: { code: hostJobErrorCode(result.error.code), message: result.error.message } });
    }
    // Echoed so a caller that did not name its own job still learns the handle it can query.
    return { ...result, jobId: job.jobId } as unknown as MotionDebugResult;
  } catch (error) {
    await job.failed({ error: { code: "invalid_args", message: error instanceof Error ? error.message : "Motion command threw." } });
    return { ...unhandledDebugCommandError(command, error), jobId: job.jobId } as unknown as MotionDebugResult;
  }
}

/**
 * The contract's error codes are a closed set; anything outside it is an argument problem.
 *
 * Derived from the authored contract rather than restated, so a code added to
 * schemas/job-status.json cannot silently fail to be recognised here.
 */
const JOB_ERROR_CODES: ReadonlySet<string> = new Set(JOB_STATUS_CONTRACT.errorCodes.map((entry) => entry.code));
function hostJobErrorCode(code: string): JobErrorCode {
  return JOB_ERROR_CODES.has(code) ? code as JobErrorCode : "invalid_args";
}

async function dispatchDebugCommandUnsafe(command: MotionDebugCommand, args: unknown, context: MotionDebugContext): Promise<MotionDebugResult> {
  const definition = debugCommandDefinition(command);
  if (!definition) {
    return unknownCommand(command);
  }

  const requiredTier = definition.permission;
  if (!hasTier(context.tier, requiredTier)) {
    // Worded by @shellx-motion/actions' tierRefusal, not here. The old suggestedAction was
    // "Retry with <tier> permission." — an instruction the receiving agent cannot carry out, since
    // Motion has no elevation command and requestedTier is capped at the host's startup grant. A
    // suggestedAction has to name something its reader can actually do, which for a tier refusal
    // means naming the host operator's change. See packages/actions/src/permission-refusal.ts.
    return {
      ok: false,
      error: tierRefusal({
        subject: command,
        requiredTier,
        ...(context.tier ? { grantedTier: context.tier } : {})
      }),
      warnings: []
    };
  }

  const domainResult = await dispatchDomainCommand(definition.domain, command, args, {
    agentRuntime: context.agentRuntime,
    tier: context.tier,
    promptRuntime: context.promptRuntime,
    promptCwdRoots: (context.promptCwdRoots ?? [resolve(".")]).map((root) => resolve(root)),
    executePromptCommands: (proposals, receiptsRoot) => executePromptDebugCommands(proposals, {
      ...context,
      ...(receiptsRoot ? { receiptsRoot } : {})
    }),
    isAgentReceiptPathInsideRoot: isReceiptPathInsideRoot,
    readAgentTranscript: async (input) => {
      const entries = await readReceiptEntries(input.receiptsRoot);
      let targetEntry: ReceiptEntry | undefined;
      if (input.receiptPath) {
        const normalizedReceiptPath = resolve(input.receiptPath);
        const receipt = await readReceiptFile(normalizedReceiptPath);
        targetEntry = receipt ? { path: normalizedReceiptPath, receipt } : undefined;
      } else if (input.receiptId) {
        targetEntry = findReceiptEntryById(entries, input.receiptId);
      }
      return {
        targetFound: !(input.receiptId || input.receiptPath) || Boolean(targetEntry),
        sessions: agentTranscriptSessions(entries, targetEntry)
      };
    },
    readAgentRevisionEvidence: async (input) => {
      const evidenceArgs = {
        ...(input.qualityReceipt !== undefined ? { qualityReceipt: input.qualityReceipt } : {}),
        ...(input.qualityReceipts ? { qualityReceipts: input.qualityReceipts } : {}),
        ...(input.qualityReceiptPaths[0] ? { qualityReceiptPath: input.qualityReceiptPaths[0] } : {}),
        ...(input.qualityReceiptPaths.length > 1 ? { qualityReceiptPaths: input.qualityReceiptPaths.slice(1) } : {}),
        ...(input.qualityReceiptIds[0] ? { qualityReceiptId: input.qualityReceiptIds[0] } : {}),
        ...(input.qualityReceiptIds.length > 1 ? { qualityReceiptIds: input.qualityReceiptIds.slice(1) } : {}),
        ...(input.contactSheet !== undefined ? { contactSheet: input.contactSheet } : {}),
        ...(input.contactSheetPath ? { contactSheetPath: input.contactSheetPath } : {})
      };
      const quality = await readAgentRevisionQualityReceipts(evidenceArgs, input.receiptsRoot);
      if (!quality.ok) return quality;
      const contactSheet = await readAgentRevisionContactSheet(evidenceArgs, input.contactSheetRoots);
      if (!contactSheet.ok) return contactSheet;
      return {
        ok: true as const,
        evidence: {
          qualityReceipts: quality.receipts,
          ...(contactSheet.contactSheet ? { contactSheet: contactSheet.contactSheet } : {})
        }
      };
    },
    readPromptLifecycleState: async (root) => {
      const entries = await readReceiptEntries(root);
      const controls = promptControlIndex(entries);
      const jobs = entries
        .filter((entry) => isPromptJobReceipt(entry.receipt))
        .map((entry) => promptQueueJob(promptStatusJob(entry, controls)));
      return { jobs, stateCounts: promptStateCounts(jobs) };
    },
    readPromptControlTarget: async (root, receiptId) => {
      const entries = await readReceiptEntries(root);
      const entry = findReceiptEntryById(entries, receiptId);
      if (!entry) return { kind: "missing" as const };
      if (!isPromptJobReceipt(entry.receipt)) return { kind: "not_prompt" as const };
      const controls = promptControlIndex(entries);
      const job = promptStatusJob(entry, controls);
      return {
        kind: "prompt" as const,
        receipt: entry.receipt,
        path: entry.path,
        state: job.state,
        request: job.request,
        ...(job.agentId ? { agentId: job.agentId } : {}),
        sha256: await hashFile(entry.path),
        retryCount: controls.retriesBySource.get(entry.receipt.id)?.length ?? 0
      };
    },
    ffmpegRunner: context.ffmpegRunner,
    browserFrameRenderer: context.browserFrameRenderer ?? renderMotionBrowserFrame,
    packageLoader: loadMotionPackage,
    trackingAnalyzer: analyzeTrackingMedia,
    ensureDirectory: async (path) => { await mkdir(path, { recursive: true }); },
    workflowCatalogUpserter: upsertBrowserWorkflowCatalog,
    browsePackages: buildPackageBrowser,
    listReceiptEntries: readReceiptEntries,
    readReceiptEntryInsideRoot,
    summarizeReceipt: receiptSummary,
    summarizeReceiptsPanel: receiptsPanelSummary,
    listPlatformReceiptEntries: readPlatformReceiptEntries,
    summarizePlatformReceipt: platformReceiptSummary,
    isPathInsideTrustedRoot,
    archivePackage: writeMotionPackageArchive,
    extractPackage: extractMotionPackageArchive,
    writeReviewBundle,
    ...(context.artifactRoots ? { artifactRoots: context.artifactRoots } : {}),
    scriptedPackageWriter: writeScriptedMotionPackage,
    htmlSnippetExporter: writeHtmlSnippetExport,
    htmlSnippetImporter: importHtmlSnippetToMotionPackage,
    otioExporter: exportMotionPackageToOtio,
    otioImporter: importOtioTimelineToMotionPackage,
    gltfPackageWriter: writeStaticGltfPackage,
    lottiePackageWriter: writeStaticLottiePackage,
    dotLottiePackageWriter: writeStaticDotLottiePackage,
    authoringInputRoots: context.authoringInputRoots,
    authoringOutputRoots: context.authoringOutputRoots,
    fetchSource: (url) => fetchSourceDocument(url, { fetcher: context.sourceFetcher, resolver: context.sourceResolver }),
    isEmptyOrAbsentDirectory: isEmptyOrAbsentDir,
    isUnsafePackageOutputDirectory: isUnsafePackageOutputDir,
    readText: (path) => readFile(path, "utf8"),
    hashInputFile: hashPackageFile,
    writeText: async (path, value) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value, "utf8");
    },
    readTimelinePanel: async (pkg) => {
      const loaded = await readTimelineControlState(pkg);
      const controls = visibleTimelineControlState(loaded.state, loaded.statePath);
      const durationPolicy = readMotionDurationPolicy(pkg.motion);
      return {
        panel: buildTimelinePanel(pkg, controls, loaded.state.playheadMs, durationPolicy.policy),
        playheadMs: loaded.state.playheadMs,
        warnings: [...loaded.warnings, ...durationPolicy.warnings, ...timelinePanelKeyframeWarnings(pkg.motion)]
      };
    },
    templateCatalogBuilder: buildTemplateCatalog,
    templatePlanBuilder: (request, catalog, values) => buildTemplatePlan(request, catalog as TemplateCatalog, values),
    templatePanelBuilder: buildTemplatePanel,
    buildAssetsPanel: assetsPanelSummary,
    buildBrandPanel: brandPanelSummary,
    buildMediaPanel,
    buildAudioPanel,
    summarizePlatformVerification: (entries, requiredHosts) => platformVerificationPanelSummary(entries as PlatformReceiptEntry[], requiredHosts),
    buildExportPanel: (verification) => buildExportPresetPanel(verification as ExportPresetPlatformVerification | undefined),
    buildExportPlan: (input) => buildExportPlan(input as Parameters<typeof buildExportPlan>[0]),
    chooseExportPreset: chooseExportPlanPreset,
    missingPlatformVerification: exportPlanMissingPlatformVerification,
    buildStoryboardPanel,
    buildStoryboardGraph,
    hashPackageIdentity: async (pkg) => ({
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion))
    }),
    readTimelineState: async (pkg) => {
      const loaded = await readTimelineControlState(pkg);
      return {
        timeline: {
          ...inspectMotionTimeline(pkg.motion),
          controls: visibleTimelineControlState(loaded.state, loaded.statePath)
        },
        warnings: loaded.warnings
      };
    },
    readReceiptRenderState: async (root) => {
      const entries = root ? await readReceiptEntries(root) : [];
      const controls = renderControlIndex(entries);
      const receipts = entries.map((entry) => receiptSummary(entry));
      const jobs = entries
        .filter((entry) => isRenderJobReceipt(entry.receipt))
        .map((entry) => renderStatusJob(entry, controls));
      return {
        receipts,
        jobs,
        failedCount: jobs.filter((job) => job.status === "failed").length,
        stateCounts: renderStateCounts(jobs),
        warnings: receipts.flatMap((receipt) => Array.isArray(receipt.warnings) ? receipt.warnings as string[] : [])
      };
    },
    // Live job queries answer as the dispatch's caller, never as whoever asks. Resolving the owner
    // here rather than reading it from the arguments is what makes the boundary real: a caller
    // cannot name someone else's callerId to see their work.
    // Constructed per dispatch rather than cached: a view holds no handles, and resolving its roots
    // from the environment each time is what lets a host relocate its runtime directory.
    jobView: context.jobView === null ? undefined : context.jobView ?? new MotionJobView(),
    // The runner `motion.render.final` and the quality probe encode and read media with. Handed to
    // the requirements surface so an embedded host with a bundled or injected FFmpeg is told about
    // THAT executable, not about whatever happens to be on PATH — a readiness answer describing a
    // different binary than the one that would render is worse than no answer (the readiness-parity invariant).
    // Injected here, at the dispatcher, where every other host capability is supplied from; the
    // previous FFmpeg-only `checkFfmpegHealth` probe was deleted rather than deprecated in place,
    // because a second, differently-shaped readiness path is the defect itself.
    ...(context.ffmpegRunner ? { ffmpegRunner: context.ffmpegRunner } : {}),
    createPackage: async (input) => await createMotionPackage(input) as unknown as Record<string, unknown>,
    validatePackage: async (packageRoot) => {
      const pkg = await loadMotionPackage(packageRoot);
      return {
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        name: pkg.manifest.name,
        layers: pkg.motion.layers.length,
        width: pkg.motion.width,
        height: pkg.motion.height,
        fps: pkg.motion.fps,
        durationMs: pkg.motion.durationMs,
        hosts: pkg.manifest.compatibility.hosts,
        lanes: pkg.manifest.compatibility.lanes
      };
    },
    jobCallerId: dispatchCallerId(context),
    jobCrossCallerScopeGranted: context.crossCallerJobScope === true,
    readRenderLifecycleState: async (root) => {
      const entries = root ? await readReceiptEntries(root) : [];
      const controls = renderControlIndex(entries);
      const statusJobs = entries
        .filter((entry) => isRenderJobReceipt(entry.receipt))
        .map((entry) => renderStatusJob(entry, controls));
      return {
        statusJobs,
        queueJobs: statusJobs.map((job) => renderQueueJob(job)),
        stateCounts: renderStateCounts(statusJobs)
      };
    },
    readRenderControlTarget: async (root, receiptId) => {
      const entries = await readReceiptEntries(root);
      const entry = findReceiptEntryById(entries, receiptId);
      if (!entry) return { kind: "missing" as const };
      if (!isRenderJobReceipt(entry.receipt)) return { kind: "not_render" as const };
      const controls = renderControlIndex(entries);
      const job = renderStatusJob(entry, controls);
      return {
        kind: "render" as const,
        receipt: entry.receipt,
        path: entry.path,
        state: job.state,
        sha256: await hashFile(entry.path),
        retryCount: controls.retriesBySource.get(entry.receipt.id)?.length ?? 0,
        ...(readReceiptOutputPath(entry.receipt) ? { outputPath: readReceiptOutputPath(entry.receipt) } : {})
      };
    },
    readPreviewPanel: async (pkg) => {
      const loaded = await readTimelineControlState(pkg);
      return {
        panel: buildPreviewPanel(pkg, visibleTimelineControlState(loaded.state, loaded.statePath), loaded.state),
        playheadMs: loaded.state.playheadMs,
        hasSelectedRange: Boolean(loaded.state.selectedRange),
        warnings: [...loaded.warnings, ...timelinePanelKeyframeWarnings(pkg.motion)]
      };
    },
    readPreviewTimelineState: async (pkg) => {
      const loaded = await readTimelineControlState(pkg);
      return {
        playheadMs: loaded.state.playheadMs,
        visibleState: visibleTimelineControlState(loaded.state, loaded.statePath),
        warnings: loaded.warnings
      };
    },
    readQualityPanel: async (input) => {
      const manifest = readDebugQualityManifest(
        JSON.parse(await readFile(input.manifestPath, "utf8")),
        dirname(input.manifestPath),
        {
          minBrightPixels: 0,
          minEdgePixels: 0,
          minTransparentPixels: 0,
          minNonTransparentPixels: 0,
          maxChangedPixels: 0,
          maxMeanDiff: 0
        }
      );
      const pkg = input.packageRoot ? await loadMotionPackage(input.packageRoot) : undefined;
      return {
        panel: buildDebugQualityPanel({
          manifestPath: input.manifestPath,
          manifest,
          ...(input.inputPath ? { inputPath: input.inputPath } : {}),
          ...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
          ...(pkg ? { pkg } : {}),
          ...(input.preset ? { preset: input.preset } : {})
        }),
        ...(pkg ? { packageId: pkg.manifest.id, motionId: pkg.motion.id } : {})
      };
    },
    qualityInputRoots: qualityCheckInputRoots(context),
    qualityOutputRoots: [context.scratchRoot ?? ".scratch", ...(context.receiptsRoot ? [context.receiptsRoot] : [])].map((root) => resolve(root)),
    isQualityPathInsideRoots: async (path, roots) => {
      for (const root of roots) {
        if (await isPathInsideTrustedRoot(root, path)) return true;
      }
      return false;
    },
    probeQualityMedia: (inputPath, inputRoots) => probeMedia(inputPath, { runner: context.ffmpegRunner, inputRoots }),
    measureQualityAudio: (inputPath, inputRoots) => measureAudioLevels(inputPath, { runner: context.ffmpegRunner, inputRoots }),
    runQualityManifest: (input) => runDebugQualityManifest({
      ...input,
      media: input.media as Awaited<ReturnType<typeof probeMedia>>,
      runner: context.ffmpegRunner,
      // Domain-driven quality manifests (e.g. quality.panel) inherit this dispatch's actor.
      actor: context.actor
    }),
    extractQualityFrame: async (input) => {
      await mkdir(dirname(input.framePath), { recursive: true });
      const seekArgs = input.atMs > 0 ? ["-ss", formatSeconds(input.atMs / 1000)] : [];
      const media = input.media as Awaited<ReturnType<typeof probeMedia>>;
      const extractCommand: FfmpegCommand = {
        executable: resolveFfmpegExecutable(),
        args: ["-y", ...seekArgs, ...frameExtractionInputArgs(media, input.inputPath), ...frameExtractionPngOutputArgs(media, input.framePath)],
        shell: false
      };
      const extracted = await runFfmpegCommand(extractCommand, context.ffmpegRunner);
      if (extracted.exitCode === 0) return { ok: true as const };
      return {
        ok: false as const,
        code: extracted.exitCode === 127 ? "ffmpeg_not_configured" : "ffmpeg_failed",
        message: summarizeProcessOutput(extracted) || `ffmpeg exited with code ${extracted.exitCode}`
      };
    },
    analyzeQualityFrame: async (framePath) => {
      const inspected = await inspectPngFile(framePath);
      return inspected.ok
        ? { ok: true as const, quality: summarizeFrameQuality([inspected]) }
        : { ok: false as const, message: inspected.message };
    },
    compareQualityFrames: (framePath, baselinePath) => comparePngFiles(framePath, baselinePath),
    createQualityReceipt: createDebugQualityReceipt,
    executeStillFinalRender: (renderArgs) => runDebugStillFinalRender(renderArgs, context),
    executeSequenceFinalRender: (renderArgs) => runDebugSequenceFinalRender(renderArgs, context),
    executeFfmpegFinalRender: (renderArgs) => runDebugFfmpegFinalRender(renderArgs, context),
    executeBatchPlan: (renderArgs) => runDebugBatchPlan(renderArgs, context),
    executeBatchRun: (renderArgs) => runDebugBatchExecution(renderArgs, context),
    readTimelineControls: readTimelineControlState,
    writeTimelineControls: writeTimelineControlState,
    buildKeyframesPanel: buildTimelineKeyframesPanel,
    buildTransitionsPanel: buildTimelineTransitionsPanel,
    buildEasingPanel: buildTimelineEasingPanel,
    scratchRoot: context.scratchRoot,
    receiptsRoot: context.receiptsRoot,
    readReceipt: readReceiptFile,
    readJson: async (path) => JSON.parse(await readFile(path, "utf8")),
    // The single receipt-persistence choke point for every domain (template.apply, timeline.edit,
    // keying, tracking, procedural, script, preview, render-lifecycle, prompt, timeline-controls…):
    // stamp the transport-observed actor onto each host receipt just before it lands in the receipts
    // root the engine-room History reads. Wrapping the service here attributes all domains without
    // threading actor context through any domain module. applyReceiptActor mutates in place, so the
    // inline result.receipt (same object) carries identical attribution.
    writeReceipt: (root, receipt) => writeReceiptFile(root, applyReceiptActor(receipt, context.actor)),
    writeJson: writeJsonFile
  });
  if (domainResult) return domainResult;


  async function runDebugStillFinalRender(request: FinalRenderRequest, context: MotionDebugContext): Promise<MotionDebugResult> {
    const { packageRoot, outputPath, frameLane, preset, workflow, workflowPath, qualityManifestPath, dryRun } = request;
    const receiptsRoot = request.receiptsRoot ?? context.receiptsRoot;
    const atMs = request.atMs;
    try {
      const pkg = await loadMotionPackage(packageRoot);
      const stillFramePreset = readStillFrameExportPreset(preset);
      if (!stillFramePreset) return invalidArgs(`Unsupported still-frame export preset: ${preset}.`);
      const spec = resolveMotionExportPreset(stillFramePreset);
      const outputPathError = stillFrameOutputPathError(stillFramePreset, outputPath);
      if (outputPathError) return invalidArgs(outputPathError);
      const audioTracks = resolvePackageAudioInputs(pkg);
      const stillFrameWarnings = audioTracks.length > 0
        ? [`Export preset ${stillFramePreset} does not support audio; ${audioTracks.length} requested audio ${audioTracks.length === 1 ? "track" : "tracks"} will be ignored.`]
        : [];
      const stillFrame = {
        outputPath,
        atMs: atMs ?? 0,
        width: pkg.motion.width,
        height: pkg.motion.height,
        codec: spec.codec,
        container: spec.container,
        preset: stillFramePreset
      };
      if (dryRun) {
        return {
          ok: true,
          visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: "planned" },
          result: {
            ok: true,
            lane: "image",
            frameLane,
            preset: stillFramePreset,
            packageId: pkg.manifest.id,
            outputPath,
            ...(qualityManifestPath ? { qualityManifestPath } : {}),
            ...(stillFrameWarnings.length ? { warnings: stillFrameWarnings } : {}),
            dryRun: true,
            stillFrame
          },
          warnings: stillFrameWarnings
        };
      }

      await mkdir(dirname(outputPath), { recursive: true });
      const renderer = context.browserFrameRenderer ?? renderMotionBrowserFrame;
      const frame = await renderer(pkg, {
        outDir: dirname(outputPath), outputPath, atMs: atMs ?? 0,
        ...(workflow ? { workflow } : {}),
        format: stillFramePreset === "jpeg-frame" ? "jpeg" : "png"
      });
      const workflowEvidence = browserWorkflowEvidenceFromFrame(frame);
      const receipt = await createStillFrameReceipt({
        packageId: pkg.manifest.id, outputPath, preset: stillFramePreset,
        width: pkg.motion.width, height: pkg.motion.height, atMs: atMs ?? 0,
        warnings: stillFrameWarnings
      });
      enrichRenderReceiptWithBrowserWorkflow(receipt, workflowEvidence);
      const qualityCheck = qualityManifestPath
        ? await runDebugRenderQualityManifest({
            inputPath: outputPath, manifestPath: qualityManifestPath, preset: stillFramePreset,
            packageRoot, packageId: pkg.manifest.id, durationMs: pkg.motion.durationMs,
            fps: pkg.motion.fps, outDir: join(context.scratchRoot ?? dirname(outputPath), "quality"),
            receiptsRoot, context
          })
        : undefined;
      if (qualityManifestPath && qualityCheck) {
        await enrichDebugRenderReceiptWithQualityManifest(receipt, qualityManifestPath, qualityCheck);
        if (!qualityCheck.ok) {
          return debugRenderQualityManifestFailure({
            lane: "image", frameLane, preset: stillFramePreset, outputPath, receipt,
            frameReceipt: frame.receipt, qualityManifestPath, qualityCheck, extra: { stillFrame }
          });
        }
      }
      // Stamp the transport-observed actor before persisting the primary render receipt (still
      // frame + image sequence handlers both share this line). See applyReceiptActor precedence.
      const receiptPath = receiptsRoot ? await writeReceiptFile(receiptsRoot, applyReceiptActor(receipt, context.actor)) : undefined;
      return {
        ok: true,
        receiptId: receipt.id,
        visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: receipt.status },
        result: {
          ok: true, lane: "image", frameLane, preset: stillFramePreset,
          packageId: pkg.manifest.id, outputPath,
          ...(workflowPath ? { workflowPath } : {}),
          ...browserWorkflowResultFields(workflowEvidence),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          output: receipt.output, receipt,
          ...(receiptPath ? { receiptPath } : {}),
          frameReceipt: frame.receipt,
          ...(qualityCheck ? { qualityCheck } : {}),
          warnings: receipt.warnings,
          stillFrame
        },
        warnings: receipt.warnings
      };
    } catch (error) {
      return { ok: false, error: { code: "render_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
    }
  }

  async function runDebugSequenceFinalRender(request: FinalRenderRequest, context: MotionDebugContext): Promise<MotionDebugResult> {
    const { packageRoot, outputPath, frameLane, preset, workflow, workflowPath, qualityManifestPath, dryRun } = request;
    const receiptsRoot = request.receiptsRoot ?? context.receiptsRoot;
    const quality = request.minUniqueFrameHashes ? { minUniqueFrameHashes: request.minUniqueFrameHashes } : undefined;
    try {
      const pkg = await loadMotionPackage(packageRoot);
      const imageSequencePreset = readImageSequenceExportPreset(preset);
      if (!imageSequencePreset) return invalidArgs(`Unsupported image-sequence export preset: ${preset}.`);
      const audioTracks = resolvePackageAudioInputs(pkg);
      const frameCount = frameCountFor(pkg.motion.durationMs, pkg.motion.fps);
      const sequenceWarnings = audioTracks.length > 0
        ? [`Export preset ${imageSequencePreset} does not support audio; ${audioTracks.length} requested audio ${audioTracks.length === 1 ? "track" : "tracks"} will be ignored.`]
        : [];
      const sequence = {
        outputDir: outputPath, framePattern: "%06d.png", frameCount,
        width: pkg.motion.width, height: pkg.motion.height,
        durationMs: pkg.motion.durationMs, fps: pkg.motion.fps
      };
      if (dryRun) {
        return {
          ok: true,
          visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: "planned" },
          result: {
            ok: true, lane: "image-sequence", frameLane, preset: imageSequencePreset,
            packageId: pkg.manifest.id, outputPath,
            ...(quality ? { quality } : {}),
            ...(qualityManifestPath ? { qualityManifestPath } : {}),
            ...(sequenceWarnings.length ? { warnings: sequenceWarnings } : {}),
            dryRun: true, sequence
          },
          warnings: sequenceWarnings
        };
      }
      if (await isUnsafePackageOutputDir(pkg.root, outputPath)) return invalidArgs("motion.render.final image sequence outputPath must be outside packageRoot.");
      if (!await isEmptyOrAbsentDir(outputPath)) return invalidArgs("motion.render.final image sequence outputPath must be empty or absent before render.");
      await rm(outputPath, { recursive: true, force: true });
      await mkdir(outputPath, { recursive: true });
      let lastFrameReceipt: unknown = null;
      let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
      const framePaths: string[] = [];
      const renderer = context.browserFrameRenderer ?? renderMotionBrowserFrame;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const framePath = join(outputPath, frameFileName(frameIndex));
        framePaths.push(framePath);
        const atMs = frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs);
        const frame = await renderer(pkg, { outDir: outputPath, outputPath: framePath, atMs, ...(workflow ? { workflow } : {}) });
        lastFrameReceipt = frame.receipt;
        workflowEvidence = browserWorkflowEvidenceFromFrame(frame);
      }
      const sequenceQuality = await inspectFrameSequence({
        framePaths, durationMs: pkg.motion.durationMs, fps: pkg.motion.fps,
        ...(quality ? { minUniqueFrameHashes: quality.minUniqueFrameHashes } : {})
      });
      if (!sequenceQuality.ok) {
        return { ok: false, error: { code: "frame_quality_failed", message: sequenceQuality.message }, warnings: [...sequenceWarnings, ...sequenceQuality.warnings] };
      }
      const receipt = await createImageSequenceReceipt({
        packageId: pkg.manifest.id, framesDir: outputPath, fps: pkg.motion.fps,
        width: pkg.motion.width, height: pkg.motion.height, durationMs: pkg.motion.durationMs,
        frameCount, warnings: [...sequenceWarnings, ...sequenceQuality.warnings]
      });
      enrichRenderReceiptWithBrowserWorkflow(receipt, workflowEvidence);
      const qualityCheck = qualityManifestPath
        ? await runDebugRenderQualityManifest({
            inputPath: outputPath, manifestPath: qualityManifestPath, preset: imageSequencePreset,
            packageRoot, packageId: pkg.manifest.id, durationMs: pkg.motion.durationMs,
            fps: pkg.motion.fps, outDir: join(context.scratchRoot ?? dirname(outputPath), "quality"),
            receiptsRoot, context
          })
        : undefined;
      if (qualityManifestPath && qualityCheck) {
        await enrichDebugRenderReceiptWithQualityManifest(receipt, qualityManifestPath, qualityCheck);
        if (!qualityCheck.ok) {
          return debugRenderQualityManifestFailure({
            lane: "image-sequence", frameLane, preset: imageSequencePreset, outputPath, receipt,
            frameReceipt: lastFrameReceipt, frames: { dir: outputPath, count: frameCount },
            qualityManifestPath, qualityCheck, extra: { sequence }
          });
        }
      }
      // Stamp the transport-observed actor before persisting the primary render receipt (still
      // frame + image sequence handlers both share this line). See applyReceiptActor precedence.
      const receiptPath = receiptsRoot ? await writeReceiptFile(receiptsRoot, applyReceiptActor(receipt, context.actor)) : undefined;
      return {
        ok: true, receiptId: receipt.id,
        visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: receipt.status },
        result: {
          ok: true, lane: "image-sequence", frameLane, preset: imageSequencePreset,
          packageId: pkg.manifest.id, outputPath,
          ...(workflowPath ? { workflowPath } : {}),
          ...browserWorkflowResultFields(workflowEvidence),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          output: receipt.output, receipt,
          ...(receiptPath ? { receiptPath } : {}),
          frameReceipt: lastFrameReceipt, frames: { dir: outputPath, count: frameCount },
          ...(quality ? { quality } : {}),
          ...(qualityCheck ? { qualityCheck } : {}),
          warnings: receipt.warnings, sequence
        },
        warnings: receipt.warnings
      };
    } catch (error) {
      return { ok: false, error: { code: "render_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
    }
  }

  async function runDebugFfmpegFinalRender(request: FinalRenderRequest, renderContext: MotionDebugContext): Promise<MotionDebugResult> {
    const context = renderContext;
    const { packageRoot, outputPath, frameLane, preset, workflow, workflowPath, qualityManifestPath, dryRun } = request;
    const framesDirArg = request.framesDir;
    const framesRoot = framesDirArg ?? context.scratchRoot ?? ".scratch/debug-render-frames";
    const receiptsRoot = request.receiptsRoot ?? context.receiptsRoot;
    const minUniqueFrameHashes = request.minUniqueFrameHashes;

    try {
      const pkg = await loadMotionPackage(packageRoot);
      const framesDir = framesDirArg ?? join(framesRoot, pkg.manifest.id);
      const quality = minUniqueFrameHashes ? { minUniqueFrameHashes } : undefined;
      const audioTracks = resolvePackageAudioInputs(pkg);
      const frameCount = frameCountFor(pkg.motion.durationMs, pkg.motion.fps);
      const ffmpegPreset = readFfmpegExportPreset(preset);
      if (!ffmpegPreset) return invalidArgs(`Unsupported export preset: ${preset}.`);
      const outputPathError = ffmpegPresetOutputPathError(ffmpegPreset, outputPath);
      if (outputPathError) return invalidArgs(outputPathError);
      const warnings = audioWarningsForExportPreset(ffmpegPreset, audioTracks.length);
      const ffmpegInputRoots = [framesDir, pkg.root];
      const planned = buildEncodeImageSequenceCommand({
        framesDir,
        fps: pkg.motion.fps,
        durationMs: pkg.motion.durationMs,
        outputPath,
        preset: ffmpegPreset,
        ...(audioTracks.length === 1 ? { audio: audioTracks[0] } : {}),
        ...(audioTracks.length > 1 ? { audioTracks } : {}),
        inputRoots: ffmpegInputRoots,
        outputRoots: [dirname(outputPath)]
      });
      if (dryRun) {
        return {
          ok: true,
          visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: "planned" },
          result: {
            ok: true,
            lane: "ffmpeg",
            frameLane,
            preset: ffmpegPreset,
            packageId: pkg.manifest.id,
            outputPath,
            ...(quality ? { quality } : {}),
            ...(qualityManifestPath ? { qualityManifestPath } : {}),
            ...(warnings.length ? { warnings } : {}),
            dryRun: true,
            ffmpeg: planned
          },
          warnings
        };
      }

      if (framesDirArg && await isUnsafePackageOutputDir(pkg.root, framesDir)) {
        return invalidArgs("motion.render.final framesDir must be outside packageRoot.");
      }
      const health = await checkFfmpeg({ runner: context.ffmpegRunner });
      if (!health.ok) {
        return { ok: false, error: health.error, warnings: [] };
      }
      // Share the CLI's frames-directory guard instead of keeping a second, stricter copy of the
      // policy. The old check here was `readdir(path).length === 0` and nothing else, which refused
      // the exact directory state MOTION ITSELF produces: a render killed by the RSS ceiling leaves
      // its own `000001.png…` behind, so every retry at the same framesDir was refused — precisely
      // when an agent most needs to retry with a cheaper package. A stray `.DS_Store` or
      // `desktop.ini` had the same effect, and there was no `force` escape.
      //
      // It also bought no safety: the next two lines recursively deleted that directory anyway, so
      // the check only decided WHETHER Motion would proceed to delete it, never protected it.
      // `prepareFramesDir` allows reuse when every entry is evidence Motion wrote it, refuses and
      // NAMES anything else, and handles the exists-but-not-a-directory case the old check missed.
      const framesGuard = await prepareFramesDir(framesDir, {
        force: false,
        callerSupplied: Boolean(framesDirArg),
        // Same reason as the CLI: framesDir carries a package-supplied identifier.
        withinRoot: framesRoot
      });
      if (!framesGuard.ok) {
        // The shared guard's message ends by suggesting `--force`, which is a CLI flag. This surface
        // has no such argument, and telling an agent to pass an option that does not exist is the
        // same defect as documenting a binary that is not shipped. State the remedy that is real
        // here: choose another directory, or clear this one outside Motion.
        return {
          ok: false,
          error: {
            code: "invalid_args",
            message: `motion.render.final ${framesGuard.error.message.replace(/,? or pass --force to (?:overwrite|replace) it\.$/, ".")}`,
            suggestedAction: "Pass a different framesDir, or remove the listed entries yourself. motion.render.final has no force argument, deliberately: it will not delete files it cannot prove Motion wrote."
          },
          warnings: []
        };
      }
      await mkdir(dirname(outputPath), { recursive: true });
      let lastFrameReceipt: unknown = null;
      let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
      const renderer = context.browserFrameRenderer ?? renderMotionBrowserFrame;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const framePath = join(framesDir, frameFileName(frameIndex));
        const atMs = frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs);
        const frame = await renderer(pkg, { outDir: framesDir, outputPath: framePath, atMs, ...(workflow ? { workflow } : {}) });
        lastFrameReceipt = frame.receipt;
        workflowEvidence = browserWorkflowEvidenceFromFrame(frame);
      }

      const encoded = await encodeImageSequenceWithPolicy({
        packageId: pkg.manifest.id,
        framesDir,
        fps: pkg.motion.fps,
        width: pkg.motion.width,
        height: pkg.motion.height,
        durationMs: pkg.motion.durationMs,
        outputPath,
        preset: ffmpegPreset,
        ...(audioTracks.length === 1 ? { audio: audioTracks[0] } : {}),
        ...(audioTracks.length > 1 ? { audioTracks } : {}),
        inputRoots: ffmpegInputRoots,
        outputRoots: [dirname(outputPath)],
        ...(quality ? { quality } : {}),
        // Hardware (GPU) encoding is the default for final renders, resolved through the shared encode
        // policy so CLI, Debug API, and connectors agree on the encoder and cache the probe across
        // renders. SHELLX_MOTION_FORCE_SOFTWARE_ENCODE still forces software for reproducibility.
        ...(health.version ? { ffmpegVersion: health.version } : {}),
        runner: context.ffmpegRunner
      });
      if (!encoded.ok) {
        return {
          ok: false,
          error: encoded.error,
          warnings
        };
      }
      enrichRenderReceiptWithBrowserWorkflow(encoded.receipt, workflowEvidence);
      const qualityCheck = qualityManifestPath
        ? await runDebugRenderQualityManifest({
            inputPath: outputPath,
            manifestPath: qualityManifestPath,
            preset: ffmpegPreset,
            packageRoot,
            packageId: pkg.manifest.id,
            durationMs: pkg.motion.durationMs,
            fps: pkg.motion.fps,
            outDir: join(context.scratchRoot ?? dirname(outputPath), "quality"),
            receiptsRoot,
            context
          })
        : undefined;
      if (qualityManifestPath && qualityCheck) {
        await enrichDebugRenderReceiptWithQualityManifest(encoded.receipt, qualityManifestPath, qualityCheck);
        // FFprobe read this media back to produce the quality evidence above, so it belongs in the
        // receipt's tool provenance alongside the encoder that wrote it — through the SAME helper
        // the CLI uses, so an agent's receipt carries the evidence a human's does (the tool-provenance invariant). Passed
        // `contributed` from the readback path itself: `png-frame`/`png-sequence` manifests are
        // answered by a pure PNG reader, and a receipt must not name a tool that never ran.
        await recordReceiptFfprobeProvenance(encoded.receipt, {
          contributed: debugQualityReadbackUsedFfprobe(ffmpegPreset),
          ...(context.ffmpegRunner ? { runner: context.ffmpegRunner } : {})
        });
        if (!qualityCheck.ok) {
          return debugRenderQualityManifestFailure({
            lane: "ffmpeg",
            frameLane,
            preset: ffmpegPreset,
            outputPath,
            receipt: encoded.receipt,
            frameReceipt: lastFrameReceipt,
            frames: { dir: framesDir, count: frameCount },
            qualityManifestPath,
            qualityCheck,
            extra: { ffmpeg: encoded.command }
          });
        }
      }
      // Stamp the transport-observed actor before persisting the ffmpeg render receipt (this handler
      // names its context `renderContext`). See applyReceiptActor precedence.
      const receiptPath = receiptsRoot ? await writeReceiptFile(receiptsRoot, applyReceiptActor(encoded.receipt, renderContext.actor)) : undefined;

      return {
        ok: true,
        receiptId: encoded.receipt.id,
        visibleState: {
          panel: "receipts",
          operation: "render.final",
          packageId: pkg.manifest.id,
          outputPath,
          status: encoded.receipt.status
        },
        result: {
          ok: true,
          lane: "ffmpeg",
          frameLane,
          preset: ffmpegPreset,
          packageId: pkg.manifest.id,
          outputPath,
          ...(workflowPath ? { workflowPath } : {}),
          ...browserWorkflowResultFields(workflowEvidence),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          output: encoded.receipt.output,
          receipt: encoded.receipt,
          ...(receiptPath ? { receiptPath } : {}),
          frameReceipt: lastFrameReceipt,
          frames: { dir: framesDir, count: frameCount },
          ...(quality ? { quality } : {}),
          ...(qualityCheck ? { qualityCheck } : {}),
          warnings: encoded.receipt.warnings,
          ffmpeg: encoded.command
        },
        warnings: encoded.receipt.warnings
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "render_failed",
          message: error instanceof Error ? error.message : String(error)
        },
        warnings: []
      };
    }
  }

  function renderBatchFailure(error: unknown): MotionDebugResult {
    return {
      ok: false,
      error: { code: "render_batch_failed", message: error instanceof Error ? error.message : String(error) },
      warnings: []
    };
  }

  async function prepareDebugBatchRender(request: BatchRenderRequest) {
    try {
      const quality = request.minUniqueFrameHashes ? { minUniqueFrameHashes: request.minUniqueFrameHashes } : undefined;
      const workflowIdempotencyHash = await debugBatchWorkflowIdempotencyHash({ workflow: request.workflow, workflowPath: request.workflowPath });
      const pkg = await loadMotionPackage(request.packageRoot);
      const allRows = request.rowsPath
        ? await loadDataRowsFile(request.rowsPath)
        : await loadPackageDataRows(pkg);
      const rowFilter = filterMotionDataRows(allRows, request.rowIds);
      if (!rowFilter.ok) return { ok: false as const, result: invalidArgs(rowFilter.message) };
      const rows = rowFilter.rows;
      const expanded = expandMotionPackageRows(pkg, rows);
      const presetPlan = planDebugBatchRenderPresets(expanded, request.preset, request.forcePreset);
      if (!presetPlan.ok) {
        return { ok: false as const, result: invalidArgs(`Unsupported export preset for row ${presetPlan.rowId}: ${presetPlan.preset}.`) };
      }
      const presetSummary = debugBatchPresetSummary(request.preset, presetPlan.uniquePresets);
      if (request.qualityManifestPath) {
        const unsupportedQualityPreset = presetPlan.presets.find((candidate) => !supportsDebugBatchQualityManifestPreset(candidate));
        if (unsupportedQualityPreset) {
          return { ok: false as const, result: invalidArgs(`Batch quality manifest checks for preset ${unsupportedQualityPreset} currently require a video, GIF, png-frame, or png-sequence export preset.`) };
        }
      }
      const jobs = expanded.map((job, index) => {
        const jobPreset = presetPlan.presets[index];
        const idempotencyKey = debugBatchJobIdempotencyKey({
          packageId: job.manifest.id,
          rowId: job.row.id,
          rowHash: job.row.hash,
          manifest: job.manifest,
          motion: job.motion,
          preset: jobPreset,
          quality,
          qualityManifestPath: request.qualityManifestPath,
          workflowIdempotencyHash
        });
        const audioWarnings = debugAudioWarningsForMotionExportPreset(
          jobPreset,
          resolvePackageAudioInputs({ root: pkg.root, manifest: job.manifest, motion: job.motion }).length
        );
        return {
          rowId: job.row.id,
          rowHash: job.row.hash,
          rowKey: job.row.key,
          idempotencyKey,
          packageId: job.manifest.id,
          packageDir: join(request.outDir, "packages", job.manifest.id),
	          outputPath: debugBatchOutputPath(join(request.outDir, "render"), job.manifest.id, jobPreset),
	          preset: jobPreset,
	          ...(quality ? { quality } : {}),
	          ...(request.qualityManifestPath ? { qualityManifestPath: request.qualityManifestPath } : {}),
	          status: "not_run",
	          ...(audioWarnings.length > 0 ? { warnings: audioWarnings } : {})
	        };
	      });
      return { ok: true as const, value: { request, pkg, rows, expanded, presetPlan, presetSummary, quality, jobs } };
    } catch (error) {
      return { ok: false as const, result: renderBatchFailure(error) };
    }
  }

  async function runDebugBatchPlan(request: BatchRenderRequest, context: MotionDebugContext): Promise<MotionDebugResult> {
    const prepared = await prepareDebugBatchRender(request);
    if (!prepared.ok) return prepared.result;
    const { pkg, rows, expanded, presetSummary, quality, jobs } = prepared.value;
    const { outDir, qualityManifestPath } = request;
    try {
      if (await isUnsafePackageOutputDir(pkg.root, outDir)) return invalidArgs("motion.render.batch outDir must be outside packageRoot.");
      if (!await isEmptyOrAbsentDir(outDir)) return invalidArgs("motion.render.batch outDir must be empty or absent before render.");
      const packagesRoot = join(outDir, "packages");
      const renderRoot = join(outDir, "render");
      // A caller-named `outDir` becomes a receipt store here, and that was reviewed rather than
      // fenced. It grants no authority the command does not already have: `outDir` IS the batch's
      // declared output, so writing `receipts/` beside `render/` and `packages/` is the same write
      // the caller asked for, bounded by the two checks above (outside packageRoot, empty or
      // absent). What would make it a disclosure primitive is READING the store back, and that is
      // refused: `receiptsRoot` at the transport boundary must be inside a host-declared root, and
      // a caller's outDir is not one. Pinned by a live-server case in
      // `packages/debug-server/src/sdk-transport-fence.test.ts`. Constraining where renders may
      // land at all is a host-declared output-root decision (`authoringOutputRoots`), not something
      // to bolt onto this one command.
      const receiptsRoot = join(outDir, "receipts");
      await mkdir(packagesRoot, { recursive: true });
      await mkdir(renderRoot, { recursive: true });
      await mkdir(receiptsRoot, { recursive: true });
      for (let index = 0; index < expanded.length; index += 1) {
        await writeExpandedMotionPackage(expanded[index], pkg, jobs[index].packageDir);
        const planReceiptPath = await writeDebugBatchRowPlanReceipt({
          receiptsRoot, dryRun: true, packageId: expanded[index].manifest.id,
          row: expanded[index].row, manifest: expanded[index].manifest, motion: expanded[index].motion,
          packageDir: jobs[index].packageDir, outputPath: jobs[index].outputPath,
          preset: jobs[index].preset, status: "not_run", idempotencyKey: jobs[index].idempotencyKey,
          quality, qualityManifestPath, warnings: debugResultWarnings(jobs[index]), actor: context.actor
        });
        Object.assign(jobs[index], { planReceiptPath, receiptPath: planReceiptPath });
      }
      const receipt = await writeDebugBatchReceipt({
        receiptsRoot, pkg, rows, dryRun: true, preset: request.preset, ...presetSummary,
        quality, qualityManifestPath, jobs, status: "not_run", actor: context.actor
      });
      const receiptPath = join(receiptsRoot, "batch-render.receipt.json");
      return {
        ok: true, receiptId: receipt.id,
        visibleState: {
          panel: "receipts", operation: "render.batch", preset: request.preset, ...presetSummary,
          ...(quality ? { quality } : {}), ...(qualityManifestPath ? { qualityManifestPath } : {}),
          rows: rows.length, status: receipt.status, receiptPath
        },
        result: {
          ok: true, packageId: pkg.manifest.id, dryRun: true, preset: request.preset, ...presetSummary,
          ...(quality ? { quality } : {}), ...(qualityManifestPath ? { qualityManifestPath } : {}),
          rows: rows.length, jobs, receipt, receiptPath,
          ...(receipt.warnings.length > 0 ? { warnings: receipt.warnings } : {})
        },
        warnings: receipt.warnings
      };
    } catch (error) {
      return renderBatchFailure(error);
    }
  }

	  async function runDebugBatchExecution(request: BatchRenderRequest, renderContext: MotionDebugContext): Promise<MotionDebugResult> {
	    const context = renderContext;
    const prepared = await prepareDebugBatchRender(request);
    if (!prepared.ok) return prepared.result;
    const { pkg, rows, expanded, presetPlan, presetSummary, quality, jobs } = prepared.value;
    const { outDir, qualityManifestPath, resume, workflowPath } = request;
    const workflowArg = request.workflow;
    const dryRun = false;
    const motionPreset = request.preset;
    try {

      if (await isUnsafePackageOutputDir(pkg.root, outDir)) {
        return invalidArgs("motion.render.batch outDir must be outside packageRoot.");
      }
      if (!resume && !await isEmptyOrAbsentDir(outDir)) {
        return invalidArgs("motion.render.batch outDir must be empty or absent before render.");
      }

      const packagesRoot = join(outDir, "packages");
      const renderRoot = join(outDir, "render");
      const receiptsRoot = join(outDir, "receipts");
      const framesRoot = join(outDir, "frames");
      const previousBatchJobs = resume ? await readDebugBatchResumeJobs(join(receiptsRoot, "batch-render.receipt.json")) : new Map<string, Record<string, unknown>>();
      await mkdir(packagesRoot, { recursive: true });
      await mkdir(renderRoot, { recursive: true });
      await mkdir(receiptsRoot, { recursive: true });
      await mkdir(framesRoot, { recursive: true });

      const renderedJobs: Array<Record<string, unknown>> = [];
      for (let index = 0; index < expanded.length; index += 1) {
        const expandedJob = expanded[index];
        const planJob = jobs[index];
        const jobPreset = presetPlan.presets[index];
        await writeExpandedMotionPackage(expandedJob, pkg, planJob.packageDir);
        const planReceiptPath = await writeDebugBatchRowPlanReceipt({
          receiptsRoot,
          dryRun,
          packageId: expandedJob.manifest.id,
          row: expandedJob.row,
          manifest: expandedJob.manifest,
          motion: expandedJob.motion,
          packageDir: planJob.packageDir,
          outputPath: planJob.outputPath,
          preset: jobPreset,
          status: "not_run",
          idempotencyKey: planJob.idempotencyKey,
          quality,
          qualityManifestPath,
          warnings: debugResultWarnings(planJob),
          actor: context.actor
        });
        Object.assign(planJob, { planReceiptPath });

        const resumeMatch = resume ? readDebugBatchResumeMatch(previousBatchJobs, planJob.idempotencyKey, planJob.outputPath) : null;
        if (resumeMatch) {
          const sourceReceiptPath = debugBatchResumeSourceReceiptPath(resumeMatch);
          renderedJobs.push({
            ...planJob,
            status: "skipped",
            receiptPath: sourceReceiptPath,
            resume: { matched: true, sourceReceiptPath }
          });
          continue;
        }

        const renderResult = await dispatchDebugCommand(
          "motion.render.final",
          {
            packageRoot: planJob.packageDir,
            outputPath: planJob.outputPath,
            framesDir: debugBatchFramesDir(framesRoot, expandedJob.manifest.id, planJob.idempotencyKey),
            receiptsRoot,
            preset: jobPreset,
            ...(workflowArg ? { workflow: workflowArg } : {}),
            ...(workflowPath ? { workflowPath } : {}),
            ...(quality ? { minUniqueFrameHashes: quality.minUniqueFrameHashes } : {}),
            dryRun: false
          },
          context
        );
	        const warnings = debugResultWarnings(renderResult);
	        const renderPayload = renderResult.ok ? objectRecord(renderResult.result) : null;
	        const receiptPath = typeof renderPayload?.receiptPath === "string" ? renderPayload.receiptPath : undefined;
	        let qualityCheck: MotionDebugResult | undefined;
	        let qualityManifestAppliedPath: string | undefined;
	        if (renderResult.ok && qualityManifestPath) {
	          const materialized = await materializeDebugBatchQualityManifest({
	            sourcePath: qualityManifestPath,
	            targetPath: join(receiptsRoot, "quality-manifests", `${expandedJob.manifest.id}.quality-manifest.json`),
	            row: expandedJob.row,
	            packageId: expandedJob.manifest.id,
	            packageDir: planJob.packageDir,
	            outputPath: planJob.outputPath
	          });
	          qualityManifestAppliedPath = materialized.appliedPath;
	          qualityCheck = jobPreset === "png-frame"
	            ? await runDebugPngStillFrameQualityManifest({
	                inputPath: planJob.outputPath,
	                manifestPath: materialized.path,
	                outDir: join(receiptsRoot, "quality", expandedJob.manifest.id),
	                receiptsRoot,
	                packageId: expandedJob.manifest.id,
	                actor: context.actor
	              })
	            : jobPreset === "png-sequence"
	              ? await runDebugPngSequenceQualityManifest({
	                  inputPath: planJob.outputPath,
	                  manifestPath: materialized.path,
	                  outDir: join(receiptsRoot, "quality", expandedJob.manifest.id),
	                  receiptsRoot,
	                  packageId: expandedJob.manifest.id,
	                  durationMs: expandedJob.motion.durationMs,
	                  fps: expandedJob.motion.fps,
	                  actor: context.actor
	                })
	            : await dispatchDebugCommand(
	                "motion.quality.check",
	                {
	                  inputPath: planJob.outputPath,
	                  manifestPath: materialized.path,
	                  outDir: join(receiptsRoot, "quality", expandedJob.manifest.id)
	                },
	                {
	                  ...context,
	                  scratchRoot: context.scratchRoot ?? outDir,
	                  qualityInputRoots: [...(context.qualityInputRoots ?? []), outDir, renderRoot]
	                }
	              );
	        }
	        const qualityOk = qualityCheck ? qualityCheck.ok : true;
	        const rowWarnings = dedupeWarnings([
	          ...warnings,
	          ...(qualityCheck ? debugResultWarnings(qualityCheck) : [])
	        ]);
	        const renderedJob = {
	          ...planJob,
	          // Same rule as the CLI batch (`packages/cli/src/main.ts`) and as the row's own render
	          // receipt. This field is typed in RECEIPT vocabulary, so it answers the same question
	          // that receipt answers and must answer it the same way. measured during cross-host verification before this
	          // line escalated: rendering fixtures/packages/batch-card at mp4-h264 through BOTH batch
	          // surfaces produced the identical `Rendered motion is static for 100.0%` advisory, and
	          // the CLI reported `warning` on every row while this surface reported `passed` while
	          // carrying it — the receipt must not claim success while reporting frozen output.
	          // the cross-surface sweep fixed the CLI, the connectors and core but not this one.
	          status: escalateReceiptStatusForWarnings(renderResult.ok && qualityOk ? "passed" : "failed", rowWarnings),
	          ...(renderResult.ok && renderResult.receiptId ? { receiptId: renderResult.receiptId } : {}),
	          ...(receiptPath ? { receiptPath } : {}),
	          ...(qualityManifestAppliedPath ? { qualityManifestAppliedPath } : {}),
	          ...(qualityCheck ? { qualityCheck: qualityCheck.ok ? qualityCheck.result : { ok: false, error: qualityCheck.error, warnings: qualityCheck.warnings } } : {}),
	          ...(rowWarnings.length > 0 ? { warnings: rowWarnings } : {}),
	          render: renderResult.ok ? renderResult.result : { ok: false, error: renderResult.error, warnings: renderResult.warnings }
	        };
        renderedJobs.push(renderedJob);

	        if (!renderResult.ok) {
	          const batchCounts = debugBatchRenderCounts(renderedJobs, dryRun);
	          const receipt = await writeDebugBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, ...batchCounts, preset: motionPreset, ...presetSummary, quality, qualityManifestPath, jobs: renderedJobs, status: "failed", actor: context.actor });
	          return {
	            ok: false,
	            error: debugBatchRenderError(expandedJob, renderResult),
	            warnings: receipt.warnings
	          };
	        }
	        if (!qualityOk && qualityCheck) {
	          const batchCounts = debugBatchRenderCounts(renderedJobs, dryRun);
	          const receipt = await writeDebugBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, ...batchCounts, preset: motionPreset, ...presetSummary, quality, qualityManifestPath, jobs: renderedJobs, status: "failed", actor: context.actor });
	          return {
	            ok: false,
	            error: debugBatchQualityError(expandedJob, qualityCheck),
	            warnings: receipt.warnings
	          };
	        }
	      }

	      const batchCounts = debugBatchRenderCounts(renderedJobs, dryRun);
	      const receipt = await writeDebugBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, ...batchCounts, preset: motionPreset, ...presetSummary, quality, qualityManifestPath, jobs: renderedJobs, status: "passed", actor: context.actor });
	      const receiptPath = join(receiptsRoot, "batch-render.receipt.json");
	      return {
	        ok: true,
        receiptId: receipt.id,
        visibleState: {
          panel: "receipts",
          operation: "render.batch",
	          packageId: pkg.manifest.id,
	          preset: motionPreset,
	          ...presetSummary,
	          ...(quality ? { quality } : {}),
	          ...(qualityManifestPath ? { qualityManifestPath } : {}),
	          rows: rows.length,
	          status: receipt.status
	        },
        result: {
          ok: true,
          packageId: pkg.manifest.id,
	          dryRun,
	          ...(resume ? { resume, ...batchCounts } : {}),
	          preset: motionPreset,
	          ...presetSummary,
	          ...(quality ? { quality } : {}),
	          ...(qualityManifestPath ? { qualityManifestPath } : {}),
	          rows: rows.length,
          jobs: renderedJobs,
          receipt,
          receiptPath
        },
        warnings: receipt.warnings
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "render_batch_failed",
          message: error instanceof Error ? error.message : String(error)
        },
        warnings: []
      };
    }
  }


  return {
    ok: false,
    error: {
      code: "unhandled_command",
      message: `Debug command is registered but not implemented: ${command}.`
    },
    warnings: []
  };
}

function unknownCommand(command: unknown): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "unknown_command",
      message: `Unknown debug command: ${String(command)}.`
    },
    warnings: []
  };
}

function unhandledDebugCommandError(command: unknown, error: unknown): MotionDebugResult {
  const commandName = typeof command === "string" ? command : String(command);
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: "debug_command_failed",
      message: `${commandName} failed: ${message}`
    },
    warnings: []
  };
}

/**
 * Run the debug commands an agent proposed during `motion.prompt.run`.
 *
 * `dispatchCallerSteeredCommand`, not `dispatchDebugCommand`: `parsePromptCommandProposals` accepts
 * any registered command with `args` passed through UNVALIDATED, so these arguments carry a caller's
 * provenance even though the dispatch is internal. Without the fence, a foreign `receiptsRoot` that
 * a direct call would be refused was admitted here, and the child receipt was then copied into
 * `context.receiptsRoot` — landing the stolen evidence inside the root the caller may read
 * legitimately. `motion.render.batch` re-enters the same dispatcher and stays unfenced because its
 * per-row paths are Motion's own; the difference is argument provenance, not the command name.
 */
async function executePromptDebugCommands(
  proposals: PromptDebugCommandProposal[],
  context: MotionDebugContext
): Promise<PromptDebugCommandExecutionSummary> {
  const commands: PromptDebugCommandExecutionRecord[] = [];
  const receiptIds: string[] = [];

  for (const proposal of proposals) {
    const result = await dispatchCallerSteeredCommand(proposal.command, proposal.args, context);
    const childReceipt = result.ok ? operationReceiptFromDebugResult(result.result) : null;
    if (childReceipt && context.receiptsRoot) {
      // Prompt-driven child operations inherit the prompt's actor context: stamp the copied child
      // receipt so an agent's sub-commands are attributed in History exactly like direct commands.
      await writeReceiptFile(context.receiptsRoot, applyReceiptActor(childReceipt, context.actor));
    }
    const receiptId = result.ok ? result.receiptId ?? childReceipt?.id : undefined;
    const record: PromptDebugCommandExecutionRecord = result.ok
      ? {
          command: proposal.command,
          ok: true,
          ...(receiptId ? { receiptId } : {}),
          warnings: result.warnings
        }
      : {
          command: proposal.command,
          ok: false,
          error: result.error,
          warnings: result.warnings
        };
    commands.push(record);
    if (record.receiptId) receiptIds.push(record.receiptId);
    if (!record.ok) break;
  }

  return {
    commandCount: commands.length,
    receiptIds,
    commands
  };
}

function operationReceiptFromDebugResult(result: unknown): OperationReceipt | null {
  const record = objectRecord(result);
  if (!record) return null;
  return readOperationReceipt(record.receipt);
}

function hasTier(actual: MotionPermissionTier, required: MotionPermissionTier): boolean {
  return TIER_ORDER.indexOf(actual) >= TIER_ORDER.indexOf(required);
}

function readStringArg(args: unknown, key: string): string | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readStringArrayArg(args: unknown, key: string): string[] | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  return readStringArray(record[key]);
}

function readRecordArg(args: unknown, key: string): Record<string, unknown> | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  return objectRecord(record[key]);
}

interface BrowserWorkflowRenderEvidence {
  workflow?: unknown;
  workflowTrace?: unknown;
  workflowHash?: string;
}

function browserWorkflowEvidenceFromFrame(frame: { output?: unknown; receipt?: unknown }): BrowserWorkflowRenderEvidence | undefined {
  const output = objectRecord(frame.output);
  const receipt = objectRecord(frame.receipt);
  const inputHashes = objectRecord(receipt?.inputHashes);
  const workflow = output?.workflow;
  const workflowTrace = output?.workflowTrace;
  const workflowHash = typeof inputHashes?.workflow === "string"
    ? inputHashes.workflow
    : workflowHashFromTrace(workflowTrace);
  if (workflow === undefined && workflowTrace === undefined && !workflowHash) return undefined;
  return {
    ...(workflow !== undefined ? { workflow } : {}),
    ...(workflowTrace !== undefined ? { workflowTrace } : {}),
    ...(workflowHash ? { workflowHash } : {})
  };
}

function workflowHashFromTrace(value: unknown): string | undefined {
  const trace = objectRecord(value);
  return typeof trace?.workflowHash === "string" ? trace.workflowHash : undefined;
}

function enrichRenderReceiptWithBrowserWorkflow(
  receipt: OperationReceipt,
  evidence: BrowserWorkflowRenderEvidence | undefined
): void {
  if (!evidence) return;
  if (evidence.workflowHash) {
    receipt.inputHashes = { ...receipt.inputHashes, workflow: evidence.workflowHash };
  }
  const output = objectRecord(receipt.output) ?? {};
  receipt.output = {
    ...output,
    ...(evidence.workflow !== undefined ? { workflow: evidence.workflow } : {}),
    ...(evidence.workflowTrace !== undefined ? { workflowTrace: evidence.workflowTrace } : {})
  };
}

function browserWorkflowResultFields(evidence: BrowserWorkflowRenderEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  return {
    ...(evidence.workflow !== undefined ? { workflow: evidence.workflow } : {}),
    ...(evidence.workflowTrace !== undefined ? { workflowTrace: evidence.workflowTrace } : {})
  };
}

function readNonEmptyRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = readRecordString(record, key);
  return value && value.trim().length > 0 ? value : null;
}

function readRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readFiniteRecordNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecordBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readOptionalFiniteRecordNumber(record: Record<string, unknown>, key: string): number | false | null {
  if (!(key in record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

function readOptionalRecordString(record: Record<string, unknown>, key: string): string | false | null {
  if (!(key in record)) return null;
  const value = record[key];
  return typeof value === "string" ? value : false;
}

function jsonPointerTokens(path: string): string[] {
  if (!path.startsWith("/")) throw new Error(`Patch path must be a JSON pointer: ${path}`);
  const tokens = path.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const unsafeToken = tokens.find(isUnsafeJsonPointerToken);
  if (unsafeToken) throw new Error(`Patch path contains unsafe segment: ${unsafeToken}`);
  return tokens;
}

function numericPointerToken(token: string): boolean {
  return token === "0" || /^[1-9]\d*$/.test(token);
}

function isUnsafeJsonPointerToken(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

function readBooleanArg(args: unknown, key: string): boolean | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readOptionalBooleanArg(args: unknown, key: string): boolean | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "boolean" ? value : false;
}

function readFiniteNumberArg(args: unknown, key: string): number | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

function readKeyframeValueArg(args: unknown, key: string): string | number | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return false;
}

function readNonNegativeNumberArg(args: unknown, key: string): number | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : false;
}

function readNonNegativeIntegerArg(args: unknown, key: string): number | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : false;
}

function readPositiveNumberArg(args: unknown, key: string): number | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : false;
}

function readPositiveIntegerArg(args: unknown, key: string): number | false | null {
  const record = objectRecord(args);
  if (!record || !(key in record)) return null;
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return false;
  return value;
}

function qualityCheckInputRoots(context: MotionDebugContext): string[] {
  return [
    ...(context.qualityInputRoots ?? []),
    context.scratchRoot ?? ".scratch"
  ].map((root) => resolve(root));
}

/**
 * Does a quality manifest over this preset read the delivered media back through FFprobe?
 *
 * ONE source of truth for two questions that must never disagree: which reader
 * {@link runDebugRenderQualityManifest} dispatches to, and whether the render receipt may name
 * FFprobe in its tool provenance (the tool-provenance invariant). `png-frame` and `png-sequence` manifests are
 * answered by an in-process PNG reader that spawns nothing, so a receipt from those lanes must not
 * claim FFprobe evidence. Deriving both from this predicate means a new pure-reader preset cannot
 * quietly inherit a provenance claim it did not earn.
 */
function debugQualityReadbackUsedFfprobe(preset: MotionExportPreset): boolean {
  return preset !== "png-frame" && preset !== "png-sequence";
}

async function runDebugRenderQualityManifest(input: {
  inputPath: string;
  manifestPath: string;
  preset: MotionExportPreset;
  packageRoot: string;
  packageId: string;
  durationMs: number;
  fps: number;
  outDir: string;
  receiptsRoot?: string;
  context: MotionDebugContext;
}): Promise<MotionDebugResult> {
  // The two pure-reader lanes. `debugQualityReadbackUsedFfprobe` must stay false for exactly these
  // presets — `debugQualityReadbackUsedFfprobe agrees with the readback dispatch` in
  // receipt-tool-provenance.test.ts asserts that over the whole preset list.
  if (input.preset === "png-frame") {
    return runDebugPngStillFrameQualityManifest({
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      outDir: input.outDir,
      receiptsRoot: input.receiptsRoot,
      packageId: input.packageId,
      actor: input.context.actor
    });
  }
  if (input.preset === "png-sequence") {
    return runDebugPngSequenceQualityManifest({
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      outDir: input.outDir,
      receiptsRoot: input.receiptsRoot,
      packageId: input.packageId,
      durationMs: input.durationMs,
      fps: input.fps,
      actor: input.context.actor
    });
  }

  const inputRoots = [...qualityCheckInputRoots(input.context), dirname(input.inputPath), input.packageRoot];
  let media: Awaited<ReturnType<typeof probeMedia>>;
  try {
    media = await probeMedia(input.inputPath, { runner: input.context.ffmpegRunner, inputRoots });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "ffmpeg_failed",
        message: error instanceof Error ? error.message : String(error)
      },
      warnings: []
    };
  }

  return runDebugQualityManifest({
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    media,
    outDir: input.outDir,
    runner: input.context.ffmpegRunner,
    inputRoots,
    receiptsRoot: input.receiptsRoot,
    actor: input.context.actor,
    packageId: input.packageId,
    defaults: {
      minBrightPixels: 0,
      minEdgePixels: 0,
      minTransparentPixels: 0,
      minNonTransparentPixels: 0,
      maxChangedPixels: 0,
      maxMeanDiff: 0
    }
  });
}

async function enrichDebugRenderReceiptWithQualityManifest(
  receipt: OperationReceipt,
  qualityManifestPath: string,
  qualityCheck: MotionDebugResult
): Promise<void> {
  receipt.inputHashes = {
    ...receipt.inputHashes,
    qualityManifest: await hashFile(qualityManifestPath)
  };
  const output = objectRecord(receipt.output) ?? {};
  receipt.output = {
    ...output,
    qualityManifestPath,
    qualityCheck: {
      status: qualityCheck.ok ? "passed" : "failed"
    }
  };
  receipt.status = qualityCheck.ok ? receipt.status : "failed";
  receipt.warnings = dedupeWarnings([...receipt.warnings, ...debugResultWarnings(qualityCheck)]);
}

function debugRenderQualityManifestFailure(input: {
  lane: "ffmpeg" | "image-sequence" | "image";
  frameLane: string;
  preset: MotionExportPreset;
  outputPath: string;
  receipt: OperationReceipt;
  frameReceipt: unknown;
  frames?: { dir: string; count: number };
  qualityManifestPath: string;
  qualityCheck: MotionDebugResult;
  extra?: Record<string, unknown>;
}): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: input.qualityCheck.ok ? "quality_check_failed" : input.qualityCheck.error.code,
      message: input.qualityCheck.ok ? "Final render quality manifest check failed." : input.qualityCheck.error.message,
      detail: {
        lane: input.lane,
        frameLane: input.frameLane,
        preset: input.preset,
        outputPath: input.outputPath,
        receipt: input.receipt,
        frameReceipt: input.frameReceipt,
        ...(input.frames ? { frames: input.frames } : {}),
        qualityManifestPath: input.qualityManifestPath,
        qualityCheck: input.qualityCheck,
        ...(input.extra ?? {})
      }
    },
    warnings: input.receipt.warnings
  };
}

interface DebugQualityManifestSample {
  id: string;
  atMs: number;
  baselinePath?: string;
  minBrightPixels: number;
  minEdgePixels: number;
  minLumaRange: number;
  minChromaPixels: number;
  minTransparentPixels: number;
  minNonTransparentPixels: number;
  maxChangedPixels: number;
  maxMeanDiff: number;
  minPsnrDb?: number;
  minSsim?: number;
  minChangedPixelsFromPrevious: number;
  minMeanDiffFromPrevious: number;
  compareAlpha: boolean;
  regions: DebugQualityManifestRegion[];
}

interface DebugQualityManifest {
  samples: DebugQualityManifestSample[];
  audio?: DebugQualityAudioPolicy;
}

interface DebugQualityAudioPolicy extends AudioQualityThresholds {
  expectAudio: boolean;
}

interface DebugQualityManifestRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minDarkPixels: number;
  minBrightPixels: number;
  minEdgePixels: number;
  minTransparentPixels: number;
  minNonTransparentPixels: number;
}

interface DebugQualityPanelSuggestedAction {
  id: "qualityCheck" | "renderFinal" | "exportPlan" | "reviewBundle";
  command: MotionDebugCommand;
  args: Record<string, string>;
}

interface DebugQualityPanelSample {
  id: string;
  atMs: number;
  baselinePath?: string;
  baselineExists?: boolean;
  compareAlpha?: boolean;
  thresholded: boolean;
  thresholds: Record<string, number>;
  regionCount: number;
  regions: DebugQualityManifestRegion[];
}

interface DebugQualityPanelResult {
  ok: true;
  manifestPath: string;
  inputPath?: string;
  packageRoot?: string;
  packageId?: string;
  packageName?: string;
  motionId?: string;
  preset?: string;
  counts: {
    samples: number;
    regions: number;
    baselines: number;
    audioPolicies: number;
    thresholdedSamples: number;
  };
  audio?: DebugQualityAudioPolicy;
  samples: DebugQualityPanelSample[];
  suggestedActions: DebugQualityPanelSuggestedAction[];
  warnings: string[];
}

interface DebugQualitySampleResult {
  ok: boolean;
  id: string;
  atMs: number;
  framePath?: string;
  baselinePath?: string;
  compareAlpha?: boolean;
  quality?: ReturnType<typeof summarizeFrameQuality>;
  regions?: DebugQualityRegionResult[];
  visualDiff?: Awaited<ReturnType<typeof comparePngFiles>>;
  previousSampleId?: string;
  motionDiff?: Awaited<ReturnType<typeof comparePngFiles>>;
  warnings?: string[];
  error?: { code: string; message: string };
}

interface DebugQualityRegionResult {
  ok: boolean;
  id: string;
  region: { x: number; y: number; width: number; height: number };
  quality?: ReturnType<typeof summarizeFrameQuality>;
  error?: { code: string; message: string };
}

async function runDebugQualityManifest(input: {
  inputPath: string;
  manifestPath: string;
  media: Awaited<ReturnType<typeof probeMedia>>;
	  outDir: string;
	  runner?: FfmpegRunner;
	  inputRoots: string[];
	  receiptsRoot?: string;
	  /** Transport-observed actor to stamp onto the quality-check receipt (threaded from the render context). */
	  actor?: ReceiptActor;
	  packageId: string;
	  receiptInputHashes?: Record<string, string>;
	  sourceFramePath?: string;
	  sourceFrameForSample?: (sample: DebugQualityManifestSample) => { path: string; requiresAtMsZero?: boolean };
	  defaults: {
    minBrightPixels: number;
    minEdgePixels: number;
    minTransparentPixels: number;
    minNonTransparentPixels: number;
    maxChangedPixels: number;
    maxMeanDiff: number;
    minPsnrDb?: number;
    minSsim?: number;
  };
}): Promise<MotionDebugResult> {
  let manifest: DebugQualityManifest;
  try {
    manifest = readDebugQualityManifest(
      JSON.parse(await readFile(input.manifestPath, "utf8")),
      dirname(input.manifestPath),
      input.defaults
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : String(error)
      },
      warnings: []
    };
	  }

  for (const sample of manifest.samples) {
    if (!sample.baselinePath) continue;
    let trusted = false;
    for (const root of input.inputRoots) {
      if (await isPathInsideTrustedRoot(root, sample.baselinePath)) {
        trusted = true;
        break;
      }
    }
    if (!trusted) {
      return invalidArgs(`Quality manifest sample ${sample.id} baseline must be inside a trusted quality input root.`);
    }
  }

	  let audioLevels: Awaited<ReturnType<typeof measureAudioLevels>> | undefined;
	  if (manifest.audio) {
	    const audioCheck = await debugQualityCheckAudioPolicy({
	      inputPath: input.inputPath,
	      manifestPath: input.manifestPath,
	      media: input.media,
	      runner: input.runner,
	      inputRoots: input.inputRoots,
	      expectAudio: manifest.audio.expectAudio,
	      maxPeakDb: manifest.audio.maxPeakDb,
	      minPeakDb: manifest.audio.minPeakDb,
	      minMeanDb: manifest.audio.minMeanDb,
	      minIntegratedLoudnessLufs: manifest.audio.minIntegratedLoudnessLufs,
	      maxIntegratedLoudnessLufs: manifest.audio.maxIntegratedLoudnessLufs,
	      maxTruePeakDbtp: manifest.audio.maxTruePeakDbtp,
	      maxLoudnessRangeLu: manifest.audio.maxLoudnessRangeLu
	    });
	    if (!audioCheck.ok) return audioCheck.result;
	    audioLevels = audioCheck.audioLevels;
	  }

	  const sampleResults: DebugQualitySampleResult[] = [];
  const mediaName = basename(input.inputPath).replace(/\.[^.]+$/, "") || "media";
  for (const sample of manifest.samples) {
    const framePath = join(input.outDir, `${mediaName}-${safeFileToken(sample.id)}-frame.png`);
    const resolvedSourceFrame = input.sourceFrameForSample?.(sample);
    let result = await runDebugQualityManifestSample({
      inputPath: input.inputPath,
      media: input.media,
      runner: input.runner,
      sample,
      framePath,
      sourceFramePath: resolvedSourceFrame?.path ?? input.sourceFramePath,
      sourceFrameRequiresAtMsZero: resolvedSourceFrame
        ? resolvedSourceFrame.requiresAtMsZero ?? false
        : Boolean(input.sourceFramePath)
    });
    const previous = sampleResults.at(-1);
    if (result.ok && result.framePath && previous?.ok && previous.framePath
      && (sample.minChangedPixelsFromPrevious > 0 || sample.minMeanDiffFromPrevious > 0)) {
      const motionDiff = await comparePngFiles(result.framePath, previous.framePath, { compareAlpha: sample.compareAlpha });
      const motionEvidence = { previousSampleId: previous.id, motionDiff };
      if (!motionDiff.ok) {
        result = { ...result, ok: false, ...motionEvidence, error: { code: "motion_quality_failed", message: motionDiff.message } };
      } else if (motionDiff.changedPixels < sample.minChangedPixelsFromPrevious) {
        result = {
          ...result, ok: false, ...motionEvidence,
          error: { code: "motion_quality_failed", message: `Frame changed ${motionDiff.changedPixels} pixels from sample ${previous.id}; expected at least ${sample.minChangedPixelsFromPrevious}.` }
        };
      } else if (motionDiff.meanAbsoluteError < sample.minMeanDiffFromPrevious) {
        result = {
          ...result, ok: false, ...motionEvidence,
          error: { code: "motion_quality_failed", message: `Frame mean diff from sample ${previous.id} is ${formatMetric(motionDiff.meanAbsoluteError)}; expected at least ${formatMetric(sample.minMeanDiffFromPrevious)}.` }
        };
      } else {
        result = { ...result, ...motionEvidence };
      }
    }
	    sampleResults.push(result);
	    if (!result.ok) {
	      const code = result.error?.code ?? "visual_quality_failed";
	      const message = `Quality manifest sample ${sample.id} failed: ${result.error?.message ?? "unknown failure"}`;
	      return qualityFailureWithReceipt({
	        code,
	        message,
	        packageId: input.packageId,
	        inputPath: input.inputPath,
	        manifestPath: input.manifestPath,
	        receiptsRoot: input.receiptsRoot,
	        inputHashes: input.receiptInputHashes,
	        output: {
	          inputPath: input.inputPath,
	          manifestPath: input.manifestPath,
	          media: input.media,
	          ...(manifest.audio ? { audio: manifest.audio } : {}),
	          ...(audioLevels ? { audioLevels } : {}),
	          sampleCount: sampleResults.length,
	          samples: sampleResults
	        }
	      });
	    }
	  }

  const warnings = sampleResults.flatMap((entry) => entry.warnings ?? []);
  const receiptId = `quality-check-${hashBuffer(Buffer.from(JSON.stringify({
		    inputPath: input.inputPath,
	    manifestPath: input.manifestPath,
	    media: input.media,
	    audio: manifest.audio,
	    audioLevels,
		    samples: sampleResults
		  }), "utf8")).slice(0, 16)}`;
	  const output = {
	    inputPath: input.inputPath,
	    manifestPath: input.manifestPath,
	    media: input.media,
	    ...(manifest.audio ? { audio: manifest.audio } : {}),
	    ...(audioLevels ? { audioLevels } : {}),
	    sampleCount: sampleResults.length,
	    samples: sampleResults
	  };
	  const receipt = await createDebugQualityReceipt({
	    id: receiptId,
	    packageId: input.packageId,
	    inputPath: input.inputPath,
	    manifestPath: input.manifestPath,
	    output,
	    inputHashes: input.receiptInputHashes,
	    warnings
	  });
	  // Attribute the quality-check receipt with the same transport actor as its sibling render receipt.
	  const hostReceiptPath = input.receiptsRoot ? await writeReceiptFile(input.receiptsRoot, applyReceiptActor(receipt, input.actor)) : undefined;
	  return {
	    ok: true,
	    receiptId,
	    visibleState: {
	      panel: "receipts",
	      operation: "quality.check",
		      inputPath: input.inputPath,
		      manifestPath: input.manifestPath,
		      ...(manifest.audio ? { audio: manifest.audio } : {}),
		      ok: true,
		      status: receipt.status,
		      ...(hostReceiptPath ? { hostReceiptPath } : {}),
		      sampleCount: sampleResults.length
		    },
	    result: {
	      ok: true,
		      ...output,
		      receipt,
		      ...(hostReceiptPath ? { hostReceiptPath } : {})
		    },
	    warnings
		  };
		}

async function runDebugPngStillFrameQualityManifest(input: {
  inputPath: string;
  manifestPath: string;
  outDir: string;
  receiptsRoot?: string;
  packageId: string;
  /** Transport-observed actor, threaded from the render context onto the quality receipt. */
  actor?: ReceiptActor;
}): Promise<MotionDebugResult> {
  const inspected = await inspectPngFile(input.inputPath);
  if (!inspected.ok) {
    return qualityFailureWithReceipt({
      code: "visual_quality_failed",
      message: inspected.message,
      packageId: input.packageId,
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      receiptsRoot: input.receiptsRoot,
      actor: input.actor,
      output: {
        inputPath: input.inputPath,
        manifestPath: input.manifestPath
      }
    });
  }
  return runDebugQualityManifest({
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    media: debugPngStillFrameMedia(input.inputPath, inspected),
    outDir: input.outDir,
    inputRoots: [dirname(input.inputPath)],
    receiptsRoot: input.receiptsRoot,
    actor: input.actor,
    packageId: input.packageId,
    sourceFramePath: input.inputPath,
    defaults: {
      minBrightPixels: 0,
      minEdgePixels: 0,
      minTransparentPixels: 0,
      minNonTransparentPixels: 0,
      maxChangedPixels: 0,
      maxMeanDiff: 0
    }
  });
}

function debugPngStillFrameMedia(path: string, png: { width: number; height: number }): Awaited<ReturnType<typeof probeMedia>> {
  return {
    ok: true,
    path,
    codec: "png",
    width: png.width,
    height: png.height,
    durationMs: 0,
    fps: 0,
    container: "image",
    color: { pixelFormat: null, space: null, transfer: null, primaries: null, range: null },
    alpha: { present: false, mode: null, pixelFormat: null, decoder: null },
    audio: { present: false, streamCount: 0, streams: [] }
  };
}

async function runDebugPngSequenceQualityManifest(input: {
  inputPath: string;
  manifestPath: string;
  outDir: string;
  receiptsRoot?: string;
  packageId: string;
  durationMs: number;
  fps: number;
  /** Transport-observed actor, threaded from the render context onto the quality receipt. */
  actor?: ReceiptActor;
}): Promise<MotionDebugResult> {
  const firstFramePath = join(input.inputPath, frameFileName(0));
  const inspected = await inspectPngFile(firstFramePath);
  if (!inspected.ok) {
    return qualityFailureWithReceipt({
      code: "visual_quality_failed",
      message: inspected.message,
      packageId: input.packageId,
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      receiptsRoot: input.receiptsRoot,
      actor: input.actor,
      output: {
        inputPath: input.inputPath,
        manifestPath: input.manifestPath
      }
    });
  }
  const frameCount = frameCountFor(input.durationMs, input.fps);
  const sequenceHash = await hashDebugPngSequence({
    framesDir: input.inputPath,
    framePattern: "%06d.png",
    frameCount,
    width: inspected.width,
    height: inspected.height,
    durationMs: input.durationMs,
    fps: input.fps
  });
  return runDebugQualityManifest({
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    media: debugPngSequenceMedia(input.inputPath, inspected, { durationMs: input.durationMs, fps: input.fps }),
    outDir: input.outDir,
    inputRoots: [input.inputPath],
    receiptsRoot: input.receiptsRoot,
    actor: input.actor,
    packageId: input.packageId,
    receiptInputHashes: { frames: sequenceHash },
    sourceFrameForSample: (sample) => ({
      path: join(input.inputPath, frameFileName(sequenceFrameIndexForAtMs(sample.atMs, input.durationMs, input.fps)))
    }),
    defaults: {
      minBrightPixels: 0,
      minEdgePixels: 0,
      minTransparentPixels: 0,
      minNonTransparentPixels: 0,
      maxChangedPixels: 0,
      maxMeanDiff: 0
    }
  });
}

function debugPngSequenceMedia(path: string, png: { width: number; height: number }, input: { durationMs: number; fps: number }): Awaited<ReturnType<typeof probeMedia>> {
  return {
    ok: true,
    path,
    codec: "png",
    width: png.width,
    height: png.height,
    durationMs: input.durationMs,
    fps: input.fps,
    container: "image-sequence",
    color: { pixelFormat: null, space: null, transfer: null, primaries: null, range: null },
    alpha: { present: false, mode: null, pixelFormat: null, decoder: null },
    audio: { present: false, streamCount: 0, streams: [] }
  };
}

async function hashDebugPngSequence(input: {
  framesDir: string;
  framePattern: string;
  frameCount: number;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
}): Promise<string> {
  const framePaths = Array.from({ length: input.frameCount }, (_, index) =>
    join(input.framesDir, input.framePattern.replace("%06d", String(index + 1).padStart(6, "0")))
  );
  // Bounded rather than `Promise.all(framePaths.map(hashFile))`: the fan-out scales with the LENGTH
  // OF THE RENDER (the local render guard admits up to 36,000 frames), so the naive form holds one
  // descriptor and one 64 KiB read stream per frame and dies with EMFILE after all the expensive
  // work is already paid for. `hashFramePaths` keeps the concurrency fixed and preserves input
  // order, which this sequence hash depends on.
  const frameHashes = await hashFramePaths(framePaths);
  return hashBuffer(Buffer.from(JSON.stringify({
    framesDir: input.framesDir,
    framePattern: input.framePattern,
    frameCount: input.frameCount,
    frameHashes,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  }), "utf8"));
}

async function createDebugQualityReceipt(input: {
  id: string;
  packageId: string;
  inputPath: string;
  manifestPath?: string;
  inputHashes?: Record<string, string>;
  output: Record<string, unknown>;
  warnings: string[];
  status?: OperationReceipt["status"];
}): Promise<OperationReceipt> {
  const inputHashes: Record<string, string> = input.inputHashes
    ? { ...input.inputHashes }
    : { [input.inputPath]: await hashReceiptInputPath(input.inputPath) };
  if (input.manifestPath) {
    inputHashes[input.manifestPath] = await hashFile(input.manifestPath);
  }
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: "quality.check",
    status: input.status ?? (input.warnings.length > 0 ? "warning" : "passed"),
    packageId: input.packageId,
    inputHashes,
    createdAt: new Date().toISOString(),
    lane: "quality",
    output: input.output,
    warnings: input.warnings
  };
}

async function hashReceiptInputPath(path: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return hashFile(path);
  return hashDirectoryTree(path);
}

async function hashDirectoryTree(root: string): Promise<string> {
  const entries = await collectDirectoryHashEntries(root, root);
  return hashBuffer(Buffer.from(JSON.stringify(entries), "utf8"));
}

async function collectDirectoryHashEntries(root: string, dir: string): Promise<Array<{ path: string; type: "dir" | "file"; sha256?: string }>> {
  const dirents = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  const entries: Array<{ path: string; type: "dir" | "file"; sha256?: string }> = [];
  // Code-unit order, not localeCompare: this walk order IS the hashed payload of
  // hashDirectoryTree, which becomes a quality receipt inputHash. Under a locale-sensitive
  // comparator the same unchanged directory hashed differently per machine.
  for (const dirent of [...dirents].sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const path = join(dir, dirent.name);
    const relativePath = relative(root, path).split(/[\\/]+/).join("/");
    if (dirent.isDirectory()) {
      entries.push({ path: relativePath, type: "dir" });
      entries.push(...await collectDirectoryHashEntries(root, path));
    } else if (dirent.isFile()) {
      entries.push({ path: relativePath, type: "file", sha256: await hashFile(path) });
    }
  }
  return entries;
}

async function debugQualityCheckAudioPolicy(input: {
  inputPath: string;
  manifestPath: string;
  media: Awaited<ReturnType<typeof probeMedia>>;
  runner?: FfmpegRunner;
  inputRoots: string[];
  expectAudio: boolean;
  maxPeakDb?: number;
  minPeakDb?: number;
  minMeanDb?: number;
  minIntegratedLoudnessLufs?: number;
  maxIntegratedLoudnessLufs?: number;
  maxTruePeakDbtp?: number;
  maxLoudnessRangeLu?: number;
}): Promise<{ ok: true; audioLevels?: Awaited<ReturnType<typeof measureAudioLevels>> } | { ok: false; result: MotionDebugResult }> {
  if (input.expectAudio && !input.media.audio.present) {
    return debugAudioPolicyFailure(input, "audio_quality_failed", "Expected at least one audio stream, but media has none.");
  }

  const policy = pickDebugAudioQualityThresholds(input);
  if (!audioQualityMeasurementRequired(policy)) return { ok: true };

  if (!input.media.audio.present) {
    return debugAudioPolicyFailure(input, "audio_quality_failed", "Expected at least one audio stream for audio peak check, but media has none.");
  }

  let audioLevels: Awaited<ReturnType<typeof measureAudioLevels>>;
  try {
    audioLevels = await measureAudioLevels(input.inputPath, { runner: input.runner, inputRoots: input.inputRoots });
  } catch (error) {
    return debugAudioPolicyFailure(input, "ffmpeg_failed", error instanceof Error ? error.message : String(error));
  }

  const evaluation = evaluateAudioQuality(audioLevels, policy);
  if (!evaluation.ok) return debugAudioPolicyFailure(input, "audio_quality_failed", evaluation.message, audioLevels);

  return { ok: true, audioLevels };
}

function pickDebugAudioQualityThresholds(input: AudioQualityThresholds): AudioQualityThresholds {
  return {
    maxPeakDb: input.maxPeakDb,
    minPeakDb: input.minPeakDb,
    minMeanDb: input.minMeanDb,
    minIntegratedLoudnessLufs: input.minIntegratedLoudnessLufs,
    maxIntegratedLoudnessLufs: input.maxIntegratedLoudnessLufs,
    maxTruePeakDbtp: input.maxTruePeakDbtp,
    maxLoudnessRangeLu: input.maxLoudnessRangeLu
  };
}

function debugAudioPolicyFailure(
  input: { inputPath: string; manifestPath: string; media: Awaited<ReturnType<typeof probeMedia>> },
  code: string,
  message: string,
  audioLevels?: Awaited<ReturnType<typeof measureAudioLevels>>
): { ok: false; result: MotionDebugResult } {
  return {
    ok: false,
    result: {
      ok: false,
      error: {
        code,
        message,
        detail: {
          inputPath: input.inputPath,
          manifestPath: input.manifestPath,
          media: input.media,
          ...(audioLevels ? { audioLevels } : {})
        }
      },
      warnings: []
    }
  };
}

	async function runDebugQualityManifestSample(input: {
  inputPath: string;
  media: Awaited<ReturnType<typeof probeMedia>>;
  runner?: FfmpegRunner;
  sample: DebugQualityManifestSample;
  framePath: string;
  sourceFramePath?: string;
  sourceFrameRequiresAtMsZero?: boolean;
}): Promise<DebugQualitySampleResult> {
  const framePath = input.sourceFramePath ?? input.framePath;
  if (input.sourceFramePath && input.sourceFrameRequiresAtMsZero && input.sample.atMs !== 0) {
    return {
      ok: false,
      id: input.sample.id,
      atMs: input.sample.atMs,
      framePath,
      error: {
        code: "invalid_args",
        message: "Still-frame image quality manifest samples must use atMs 0."
      }
    };
  }
  if (!input.sourceFramePath) {
    await mkdir(dirname(framePath), { recursive: true });
    const seekArgs = input.sample.atMs > 0 ? ["-ss", formatSeconds(input.sample.atMs / 1000)] : [];
    const extractCommand: FfmpegCommand = {
      executable: resolveFfmpegExecutable(),
      args: ["-y", ...seekArgs, ...frameExtractionInputArgs(input.media, input.inputPath), ...frameExtractionPngOutputArgs(input.media, framePath)],
      shell: false
    };
    const extracted = await runFfmpegCommand(extractCommand, input.runner);
    if (extracted.exitCode !== 0) {
      return {
        ok: false,
        id: input.sample.id,
        atMs: input.sample.atMs,
        framePath,
        error: {
          code: extracted.exitCode === 127 ? "ffmpeg_not_configured" : "ffmpeg_failed",
          message: summarizeProcessOutput(extracted) || `ffmpeg exited with code ${extracted.exitCode}`
        }
      };
    }
  }

  const inspected = await inspectPngFile(framePath);
  if (!inspected.ok) {
    return {
      ok: false,
      id: input.sample.id,
      atMs: input.sample.atMs,
      framePath,
      error: { code: "visual_quality_failed", message: inspected.message }
    };
  }

  const quality = summarizeFrameQuality([inspected]);
	  const base = {
	    id: input.sample.id,
	    atMs: input.sample.atMs,
	    framePath,
	    quality,
	    ...(input.sample.baselinePath ? { baselinePath: input.sample.baselinePath } : {}),
	    ...(input.sample.compareAlpha === false ? { compareAlpha: false } : {})
	  };
	  const regionResults = await inspectDebugQualityRegions(framePath, input.sample.regions);
	  const failedRegion = regionResults.find((region) => !region.ok);
	  if (failedRegion) {
	    return {
	      ok: false,
	      ...base,
	      ...(regionResults.length > 0 ? { regions: regionResults } : {}),
	      error: {
	        code: failedRegion.error?.code ?? "visual_quality_failed",
	        message: failedRegion.error?.message ?? `Region ${failedRegion.id} failed visual quality checks.`
	      }
	    };
	  }
	  if (!input.sample.baselinePath && (input.sample.minPsnrDb !== undefined || input.sample.minSsim !== undefined)) {
	    return {
	      ok: false,
	      ...base,
	      ...(regionResults.length > 0 ? { regions: regionResults } : {}),
	      error: {
	        code: "invalid_args",
	        message: "minPsnrDb and minSsim require a baseline."
	      }
	    };
	  }
	  if (quality.minBrightPixels < input.sample.minBrightPixels) {
	    return {
	      ok: false,
      ...base,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minBrightPixels} bright pixels; expected at least ${input.sample.minBrightPixels}.`
      }
    };
  }
	  if (quality.minEdgePixels < input.sample.minEdgePixels) {
    return {
      ok: false,
      ...base,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minEdgePixels} edge pixels; expected at least ${input.sample.minEdgePixels}.`
      }
    };
  }
  if (quality.minLumaRange < input.sample.minLumaRange) {
    return {
      ok: false,
      ...base,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has luma range ${quality.minLumaRange}; expected at least ${input.sample.minLumaRange}.`
      }
    };
  }
  if (quality.minChromaPixels < input.sample.minChromaPixels) {
    return {
      ok: false,
      ...base,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minChromaPixels} chroma-rich pixels; expected at least ${input.sample.minChromaPixels}.`
      }
    };
  }
  if (quality.minTransparentPixels < input.sample.minTransparentPixels) {
    return {
      ok: false,
      ...base,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minTransparentPixels} transparent pixels; expected at least ${input.sample.minTransparentPixels}.`
      }
    };
  }
  if (quality.minNonTransparentPixels < input.sample.minNonTransparentPixels) {
    return {
      ok: false,
      ...base,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minNonTransparentPixels} non-transparent pixels; expected at least ${input.sample.minNonTransparentPixels}.`
      }
    };
  }

  if (input.sample.baselinePath) {
    const visualDiff = await comparePngFiles(framePath, input.sample.baselinePath, { compareAlpha: input.sample.compareAlpha });
    if (!visualDiff.ok) {
      return {
        ok: false,
        ...base,
        visualDiff,
        error: { code: "visual_regression_failed", message: visualDiff.message }
      };
    }
    if (visualDiff.changedPixels > input.sample.maxChangedPixels || visualDiff.meanAbsoluteError > input.sample.maxMeanDiff) {
      return {
        ok: false,
        ...base,
        visualDiff,
        error: {
          code: "visual_regression_failed",
          message: `Visual regression failed: ${visualDiff.changedPixels} changed pixels (max ${input.sample.maxChangedPixels}), mean diff ${formatMetric(visualDiff.meanAbsoluteError)} (max ${formatMetric(input.sample.maxMeanDiff)}).`
        }
      };
    }
    if (input.sample.minPsnrDb !== undefined && visualDiff.psnrDb !== null && visualDiff.psnrDb < input.sample.minPsnrDb) {
      return {
        ok: false,
        ...base,
        visualDiff,
        error: {
          code: "visual_regression_failed",
          message: `Visual regression failed: PSNR is ${formatMetric(visualDiff.psnrDb)} dB; expected at least ${formatMetric(input.sample.minPsnrDb)} dB.`
        }
      };
    }
    if (input.sample.minSsim !== undefined && visualDiff.ssim < input.sample.minSsim) {
      return {
        ok: false,
        ...base,
        visualDiff,
        error: {
          code: "visual_regression_failed",
          message: `Visual regression failed: SSIM is ${formatMetric(visualDiff.ssim)}; expected at least ${formatMetric(input.sample.minSsim)}.`
        }
      };
    }
	    return {
	      ok: true,
	      ...base,
	      visualDiff,
	      ...(regionResults.length > 0 ? { regions: regionResults } : {}),
	      warnings: quality.blankFrames > 0 ? ["Extracted frame is blank or visually empty."] : []
	    };
	  }

	  return {
	    ok: true,
	    ...base,
	    ...(regionResults.length > 0 ? { regions: regionResults } : {}),
	    warnings: quality.blankFrames > 0 ? ["Extracted frame is blank or visually empty."] : []
	  };
	}

async function inspectDebugQualityRegions(framePath: string, regions: DebugQualityManifestRegion[]): Promise<DebugQualityRegionResult[]> {
  const results: DebugQualityRegionResult[] = [];
  for (const region of regions) {
    const inspected = await inspectPngFileRegion(framePath, region);
    const base = {
      id: region.id,
      region: { x: region.x, y: region.y, width: region.width, height: region.height }
    };
    if (!inspected.ok) {
      results.push({
        ok: false,
        ...base,
        error: { code: inspected.code, message: inspected.message }
      });
      continue;
    }
    const quality = summarizeFrameQuality([inspected]);
    if (quality.minDarkPixels < region.minDarkPixels) {
      results.push({
        ok: false,
        ...base,
        quality,
        error: {
          code: "visual_quality_failed",
          message: `Region ${region.id} has ${quality.minDarkPixels} dark pixels; expected at least ${region.minDarkPixels}.`
        }
      });
      continue;
    }
    if (quality.minBrightPixels < region.minBrightPixels) {
      results.push({
        ok: false,
        ...base,
        quality,
        error: {
          code: "visual_quality_failed",
          message: `Region ${region.id} has ${quality.minBrightPixels} bright pixels; expected at least ${region.minBrightPixels}.`
        }
      });
      continue;
    }
    if (quality.minEdgePixels < region.minEdgePixels) {
      results.push({
        ok: false,
        ...base,
        quality,
        error: {
          code: "visual_quality_failed",
          message: `Region ${region.id} has ${quality.minEdgePixels} edge pixels; expected at least ${region.minEdgePixels}.`
        }
      });
      continue;
    }
    if (quality.minTransparentPixels < region.minTransparentPixels) {
      results.push({
        ok: false,
        ...base,
        quality,
        error: {
          code: "visual_quality_failed",
          message: `Region ${region.id} has ${quality.minTransparentPixels} transparent pixels; expected at least ${region.minTransparentPixels}.`
        }
      });
      continue;
    }
    if (quality.minNonTransparentPixels < region.minNonTransparentPixels) {
      results.push({
        ok: false,
        ...base,
        quality,
        error: {
          code: "visual_quality_failed",
          message: `Region ${region.id} has ${quality.minNonTransparentPixels} non-transparent pixels; expected at least ${region.minNonTransparentPixels}.`
        }
      });
      continue;
    }
    results.push({ ok: true, ...base, quality });
  }
  return results;
}

function readDebugQualityManifest(
  value: unknown,
  manifestDir: string,
  defaults: {
    minBrightPixels: number;
    minEdgePixels: number;
    minTransparentPixels: number;
    minNonTransparentPixels: number;
    maxChangedPixels: number;
    maxMeanDiff: number;
    minPsnrDb?: number;
    minSsim?: number;
  }
): DebugQualityManifest {
  const record = objectRecord(value);
  if (!record) throw new Error("Quality manifest must be an object.");
  if (record.schema !== "shellx-motion/quality-manifest@1") {
    throw new Error("Quality manifest schema must be shellx-motion/quality-manifest@1.");
  }
	  if (!Array.isArray(record.samples) || record.samples.length === 0) {
	    throw new Error("Quality manifest samples must be a non-empty array.");
	  }
	  const audio = readDebugQualityManifestAudio(record.audio);
	  return {
	    ...(audio ? { audio } : {}),
	    samples: record.samples.map((sample, index) => {
	      const sampleRecord = objectRecord(sample);
	      if (!sampleRecord) throw new Error(`Quality manifest sample ${index + 1} must be an object.`);
      const id = typeof sampleRecord.id === "string" && sampleRecord.id.trim()
        ? sampleRecord.id.trim()
        : `sample_${index + 1}`;
      const baselinePath = typeof sampleRecord.baseline === "string" && sampleRecord.baseline.trim()
        ? resolveManifestPath(manifestDir, sampleRecord.baseline.trim())
        : undefined;
	      const minChangedPixelsFromPrevious = readManifestNonNegativeNumber(sampleRecord.minChangedPixelsFromPrevious, `samples/${index}/minChangedPixelsFromPrevious`, 0);
	      const minMeanDiffFromPrevious = readManifestNonNegativeNumber(sampleRecord.minMeanDiffFromPrevious, `samples/${index}/minMeanDiffFromPrevious`, 0);
	      if (index === 0 && (minChangedPixelsFromPrevious > 0 || minMeanDiffFromPrevious > 0)) {
	        throw new Error("Quality manifest first sample cannot require motion from a previous sample.");
	      }
	      const minPsnrDb = readManifestOptionalNonNegativeNumber(sampleRecord.minPsnrDb, `samples/${index}/minPsnrDb`, defaults.minPsnrDb);
	      const minSsim = readManifestOptionalUnitIntervalNumber(sampleRecord.minSsim, `samples/${index}/minSsim`, defaults.minSsim);
	      return {
	        id,
	        atMs: readManifestNonNegativeNumber(sampleRecord.atMs, `samples/${index}/atMs`, 0),
	        ...(baselinePath ? { baselinePath } : {}),
	        minBrightPixels: readManifestNonNegativeNumber(sampleRecord.minBrightPixels, `samples/${index}/minBrightPixels`, defaults.minBrightPixels),
	        minEdgePixels: readManifestNonNegativeNumber(sampleRecord.minEdgePixels, `samples/${index}/minEdgePixels`, defaults.minEdgePixels),
	        minLumaRange: readManifestNonNegativeNumber(sampleRecord.minLumaRange, `samples/${index}/minLumaRange`, 0),
	        minChromaPixels: readManifestNonNegativeNumber(sampleRecord.minChromaPixels, `samples/${index}/minChromaPixels`, 0),
	        minTransparentPixels: readManifestNonNegativeNumber(sampleRecord.minTransparentPixels, `samples/${index}/minTransparentPixels`, defaults.minTransparentPixels),
	        minNonTransparentPixels: readManifestNonNegativeNumber(sampleRecord.minNonTransparentPixels, `samples/${index}/minNonTransparentPixels`, defaults.minNonTransparentPixels),
	        maxChangedPixels: readManifestNonNegativeNumber(sampleRecord.maxChangedPixels, `samples/${index}/maxChangedPixels`, defaults.maxChangedPixels),
	        maxMeanDiff: readManifestNonNegativeNumber(sampleRecord.maxMeanDiff, `samples/${index}/maxMeanDiff`, defaults.maxMeanDiff),
	        compareAlpha: readManifestOptionalBoolean(sampleRecord.compareAlpha, `samples/${index}/compareAlpha`, true),
	        minChangedPixelsFromPrevious,
	        minMeanDiffFromPrevious,
	        ...(minPsnrDb !== undefined ? { minPsnrDb } : {}),
	        ...(minSsim !== undefined ? { minSsim } : {}),
	        regions: readDebugQualityManifestRegions(sampleRecord.regions, index)
	      };
	    })
		  };
		}

function buildDebugQualityPanel(input: {
  manifestPath: string;
  manifest: DebugQualityManifest;
  inputPath?: string;
  packageRoot?: string;
  pkg?: MotionPackage;
  preset?: string;
}): DebugQualityPanelResult {
  const samples = input.manifest.samples.map(debugQualityPanelSample);
  const regionCount = samples.reduce((total, sample) => total + sample.regionCount, 0);
  const baselineCount = samples.filter((sample) => sample.baselinePath).length;
  const warnings = [
    ...(!input.inputPath ? ["Quality check follow-up requires inputPath."] : []),
    ...(!input.packageRoot ? ["Render/export follow-up requires packageRoot."] : [])
  ];
  return {
    ok: true,
    manifestPath: input.manifestPath,
    ...(input.inputPath ? { inputPath: input.inputPath } : {}),
    ...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
    ...(input.pkg ? {
      packageId: input.pkg.manifest.id,
      packageName: input.pkg.manifest.name,
      motionId: input.pkg.motion.id
    } : {}),
    ...(input.preset ? { preset: input.preset } : {}),
    counts: {
      samples: samples.length,
      regions: regionCount,
      baselines: baselineCount,
      audioPolicies: input.manifest.audio ? 1 : 0,
      thresholdedSamples: samples.filter((sample) => sample.thresholded).length
    },
    ...(input.manifest.audio ? { audio: input.manifest.audio } : {}),
    samples,
    suggestedActions: debugQualityPanelSuggestedActions(input),
    warnings
  };
}

function debugQualityPanelSample(sample: DebugQualityManifestSample): DebugQualityPanelSample {
  const thresholds = debugQualityPanelSampleThresholds(sample);
  return {
    id: sample.id,
    atMs: sample.atMs,
    ...(sample.baselinePath ? { baselinePath: sample.baselinePath, baselineExists: existsSync(sample.baselinePath) } : {}),
    ...(sample.compareAlpha === false ? { compareAlpha: false } : {}),
    thresholded: Object.keys(thresholds).length > 0 || sample.regions.length > 0,
    thresholds,
    regionCount: sample.regions.length,
    regions: sample.regions
  };
}

function debugQualityPanelSampleThresholds(sample: DebugQualityManifestSample): Record<string, number> {
  const thresholds: Record<string, number> = {};
  if (sample.minBrightPixels > 0) thresholds.minBrightPixels = sample.minBrightPixels;
  if (sample.minEdgePixels > 0) thresholds.minEdgePixels = sample.minEdgePixels;
  if (sample.minLumaRange > 0) thresholds.minLumaRange = sample.minLumaRange;
  if (sample.minChromaPixels > 0) thresholds.minChromaPixels = sample.minChromaPixels;
  if (sample.minTransparentPixels > 0) thresholds.minTransparentPixels = sample.minTransparentPixels;
  if (sample.minNonTransparentPixels > 0) thresholds.minNonTransparentPixels = sample.minNonTransparentPixels;
  if (sample.baselinePath || sample.maxChangedPixels > 0) thresholds.maxChangedPixels = sample.maxChangedPixels;
  if (sample.baselinePath || sample.maxMeanDiff > 0) thresholds.maxMeanDiff = sample.maxMeanDiff;
  if (sample.minPsnrDb !== undefined) thresholds.minPsnrDb = sample.minPsnrDb;
  if (sample.minSsim !== undefined) thresholds.minSsim = sample.minSsim;
  if (sample.minChangedPixelsFromPrevious > 0) thresholds.minChangedPixelsFromPrevious = sample.minChangedPixelsFromPrevious;
  if (sample.minMeanDiffFromPrevious > 0) thresholds.minMeanDiffFromPrevious = sample.minMeanDiffFromPrevious;
  return thresholds;
}

function debugQualityPanelSuggestedActions(input: {
  manifestPath: string;
  inputPath?: string;
  packageRoot?: string;
  preset?: string;
}): DebugQualityPanelSuggestedAction[] {
  const actions: DebugQualityPanelSuggestedAction[] = [];
  if (input.inputPath) {
    actions.push({
      id: "qualityCheck",
      command: "motion.quality.check",
      args: { inputPath: input.inputPath, manifestPath: input.manifestPath }
    });
  }
  if (input.packageRoot) {
    actions.push({
      id: "renderFinal",
      command: "motion.render.final",
      args: {
        packageRoot: input.packageRoot,
        qualityManifestPath: input.manifestPath,
        ...(input.preset ? { preset: input.preset } : {})
      }
    });
    actions.push({
      id: "exportPlan",
      command: "motion.export.plan",
      args: {
        packageRoot: input.packageRoot,
        qualityManifestPath: input.manifestPath,
        ...(input.preset ? { preset: input.preset } : {})
      }
    });
  }
  actions.push({ id: "reviewBundle", command: "motion.review.html.bundle", args: {} });
  return actions;
}

function readDebugQualityManifestAudio(value: unknown): DebugQualityAudioPolicy | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value);
  if (!record) throw new Error("audio must be an object.");
  const maxPeakDb = readManifestOptionalFiniteNumber(record.maxPeakDb, "audio/maxPeakDb");
  const minPeakDb = readManifestOptionalFiniteNumber(record.minPeakDb, "audio/minPeakDb");
  const minMeanDb = readManifestOptionalFiniteNumber(record.minMeanDb, "audio/minMeanDb");
  const minIntegratedLoudnessLufs = readManifestOptionalFiniteNumber(record.minIntegratedLoudnessLufs, "audio/minIntegratedLoudnessLufs");
  const maxIntegratedLoudnessLufs = readManifestOptionalFiniteNumber(record.maxIntegratedLoudnessLufs, "audio/maxIntegratedLoudnessLufs");
  const maxTruePeakDbtp = readManifestOptionalFiniteNumber(record.maxTruePeakDbtp, "audio/maxTruePeakDbtp");
  const maxLoudnessRangeLu = readManifestOptionalNonNegativeNumber(record.maxLoudnessRangeLu, "audio/maxLoudnessRangeLu");
  if (minIntegratedLoudnessLufs !== undefined
    && maxIntegratedLoudnessLufs !== undefined
    && minIntegratedLoudnessLufs > maxIntegratedLoudnessLufs) {
    throw new Error("audio/maxIntegratedLoudnessLufs must be greater than or equal to audio/minIntegratedLoudnessLufs.");
  }
  const hasThreshold = [
    maxPeakDb,
    minPeakDb,
    minMeanDb,
    minIntegratedLoudnessLufs,
    maxIntegratedLoudnessLufs,
    maxTruePeakDbtp,
    maxLoudnessRangeLu
  ].some((entry) => entry !== undefined);
  const expectAudio = readManifestOptionalBoolean(
    record.expect,
    "audio/expect",
    hasThreshold
  );
  return {
    expectAudio,
    maxPeakDb,
    minPeakDb,
    minMeanDb,
    minIntegratedLoudnessLufs,
    maxIntegratedLoudnessLufs,
    maxTruePeakDbtp,
    maxLoudnessRangeLu
  };
}

function readDebugQualityManifestRegions(value: unknown, sampleIndex: number): DebugQualityManifestRegion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`samples/${sampleIndex}/regions must be an array.`);
  return value.map((region, regionIndex) => {
    const record = objectRecord(region);
    if (!record) throw new Error(`samples/${sampleIndex}/regions/${regionIndex} must be an object.`);
    const id = typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `region_${regionIndex + 1}`;
    return {
      id,
      x: readManifestNonNegativeInteger(record.x, `samples/${sampleIndex}/regions/${regionIndex}/x`),
      y: readManifestNonNegativeInteger(record.y, `samples/${sampleIndex}/regions/${regionIndex}/y`),
      width: readManifestPositiveInteger(record.width, `samples/${sampleIndex}/regions/${regionIndex}/width`),
      height: readManifestPositiveInteger(record.height, `samples/${sampleIndex}/regions/${regionIndex}/height`),
      minDarkPixels: readManifestNonNegativeNumber(record.minDarkPixels, `samples/${sampleIndex}/regions/${regionIndex}/minDarkPixels`, 0),
      minBrightPixels: readManifestNonNegativeNumber(record.minBrightPixels, `samples/${sampleIndex}/regions/${regionIndex}/minBrightPixels`, 0),
      minEdgePixels: readManifestNonNegativeNumber(record.minEdgePixels, `samples/${sampleIndex}/regions/${regionIndex}/minEdgePixels`, 0),
      minTransparentPixels: readManifestNonNegativeNumber(record.minTransparentPixels, `samples/${sampleIndex}/regions/${regionIndex}/minTransparentPixels`, 0),
      minNonTransparentPixels: readManifestNonNegativeNumber(record.minNonTransparentPixels, `samples/${sampleIndex}/regions/${regionIndex}/minNonTransparentPixels`, 0)
    };
  });
}

function resolveManifestPath(manifestDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(manifestDir, path);
}

function readManifestNonNegativeNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${path} must be a non-negative finite number.`);
}

function readManifestOptionalNonNegativeNumber(value: unknown, path: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${path} must be a non-negative finite number.`);
}

function readManifestOptionalUnitIntervalNumber(value: unknown, path: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw new Error(`${path} must be a finite number between 0 and 1.`);
}

function readManifestOptionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} must be a finite number.`);
}

function readManifestOptionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${path} must be a boolean.`);
}

function readManifestNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`${path} must be a non-negative integer.`);
}

function readManifestPositiveInteger(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${path} must be a positive integer.`);
}

async function qualityFailureWithReceipt(input: {
  code: string;
  message: string;
  packageId: string;
  inputPath: string;
  manifestPath?: string;
  receiptsRoot?: string;
  /** Transport-observed actor to stamp onto the quality-failure receipt (threaded from the render context). */
  actor?: ReceiptActor;
  inputHashes?: Record<string, string>;
  output: Record<string, unknown>;
}): Promise<MotionDebugResult> {
  const output = {
    ...input.output,
    error: { code: input.code, message: input.message }
  };
  const receiptId = `quality-check-${hashBuffer(Buffer.from(JSON.stringify({
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    output,
    status: "failed"
  }), "utf8")).slice(0, 16)}`;
  const receipt = await createDebugQualityReceipt({
    id: receiptId,
    packageId: input.packageId,
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    inputHashes: input.inputHashes,
    output,
    warnings: [input.message],
    status: "failed"
  });
  const hostReceiptPath = input.receiptsRoot ? await writeReceiptFile(input.receiptsRoot, applyReceiptActor(receipt, input.actor)) : undefined;
  return {
    ok: false,
    error: {
      code: input.code,
      message: input.message,
      detail: {
        receiptId,
        receipt,
        ...(hostReceiptPath ? { hostReceiptPath } : {})
      }
    },
    warnings: [input.message]
  };
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

async function runFfmpegCommand(command: FfmpegCommand, runner?: FfmpegRunner, callerId?: string): Promise<FfmpegProcessResult> {
  if (runner) return runner(command);
  return createGovernedFfmpegRunner(callerId ? { callerId } : {})(command);
}

function summarizeProcessOutput(result: FfmpegProcessResult): string {
  return (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join("\n").trim();
}

interface ReceiptEntry {
  path: string;
  receipt: OperationReceipt;
}

interface PlatformVerificationPanelSummary {
  status: "missing" | "partial" | "passed" | "failed";
  platformReceiptCount: number;
  hostReceiptCount: number;
  aggregateReceiptCount: number;
  requiredHosts: string[];
  satisfiedHosts: string[];
  missingHosts: string[];
  failedHosts: string[];
  invalidReceiptCount: number;
  hostReceipts: Array<Record<string, unknown>>;
  aggregateReceipts: Array<Record<string, unknown>>;
}

interface AgentTranscriptSession {
  promptReceiptId?: string;
  promptReceiptPath?: string;
  agentReceiptId?: string;
  agentReceiptPath?: string;
  packageId: string;
  status: OperationReceipt["status"];
  createdAt: string;
  planTopic?: string;
  debugCommands: string[];
  agent?: {
    agentId?: string;
    label?: string;
    transport?: string;
    billing?: string;
    permission?: string;
    command?: unknown;
  };
  transcript: {
    messageCount: number;
    roles: Record<"user" | "agent" | "stderr", number>;
    messages: AgentTranscriptMessage[];
  };
}

type AgentTranscriptMessage =
  | { role: "user"; contentSha256: string }
  | { role: "agent" | "stderr"; content: string; charCount: number; truncated?: boolean };

interface PromptStatusJob {
  receiptId: string;
  operation: string;
  status: OperationReceipt["status"];
  state: RenderJobState;
  progress: RenderJobProgress;
  packageId: string;
  lane: string;
  createdAt: string;
  receiptPath: string;
  request: string;
  agentId?: string;
  agentReceiptId?: string;
  authoringJob?: AgentAuthoringJob;
  transcript?: AgentTranscriptSession["transcript"];
  handoff?: PromptJobHandoff;
  eventReplay?: JobEventReplay;
  control?: PromptJobControl;
  warnings: string[];
}

interface PromptQueueJob extends PromptStatusJob {
  availableActions: PromptQueueAction[];
}

interface PromptQueueAction {
  id: "cancel" | "retry";
  command: "motion.prompt.cancel" | "motion.prompt.retry";
  receiptId: string;
}

interface PromptJobControl {
  cancelReceiptId?: string;
  cancelReceiptPath?: string;
  retryOfReceiptId?: string;
  retryAttempt?: number;
  reason?: string;
}

interface PromptJobHandoff {
  schema: "shellx-motion/prompt-job-handoff@1";
  jobId: string;
  receiptId: string;
  receiptPath: string;
  operation: string;
  packageId: string;
  lane: string;
  state: Extract<JobState, "pending" | "running">;
  createdAt: string;
  inputHashes: OperationReceipt["inputHashes"];
  request: string;
  agentId?: string;
  authoringJob?: AgentAuthoringJob;
  sourceReceiptId?: string;
  sourceReceiptPath?: string;
  eventReplay?: JobEventReplay;
  retryAttempt?: number;
}

interface JobEventReplay {
  schema: "shellx-motion/job-event-replay@1";
  eventLogPath?: string;
  eventCount: number;
  lastSeq: number;
  lastEventAt?: string;
  reconnectCursor: {
    receiptId: string;
    sinceSeq: number;
  };
}

interface PromptCancelControl {
  cancelReceiptId: string;
  cancelReceiptPath: string;
  reason?: string;
}

interface PromptRetryControl {
  retryReceiptId: string;
  retryReceiptPath: string;
  sourceReceiptId: string;
  retryAttempt: number;
  reason?: string;
}

interface PromptControlIndex {
  cancellationsByTarget: Map<string, PromptCancelControl>;
  retriesBySource: Map<string, PromptRetryControl[]>;
}

interface RenderStatusJob {
  receiptId: string;
  operation: string;
  status: OperationReceipt["status"];
  state: RenderJobState;
  progress: RenderJobProgress;
  packageId: string;
  lane: string;
  createdAt: string;
  receiptPath: string;
  outputPath?: string;
  handoff?: RenderJobHandoff;
  eventReplay?: JobEventReplay;
  qualityManifest?: RenderQualityManifestSummary;
  control?: RenderJobControl;
  warnings: string[];
}

interface RenderQueueJob extends RenderStatusJob {
  availableActions: RenderQueueAction[];
}

interface RenderQueueAction {
  id: "cancel" | "retry";
  command: "motion.render.cancel" | "motion.render.retry";
  receiptId: string;
}

interface RenderJobControl {
  cancelReceiptId?: string;
  cancelReceiptPath?: string;
  retryOfReceiptId?: string;
  retryAttempt?: number;
  reason?: string;
}

interface RenderJobHandoff {
  schema: "shellx-motion/render-job-handoff@1";
  jobId: string;
  receiptId: string;
  receiptPath: string;
  operation: string;
  packageId: string;
  lane: string;
  state: Extract<JobState, "pending" | "running">;
  createdAt: string;
  inputHashes: OperationReceipt["inputHashes"];
  outputPath?: string;
  sourceReceiptId?: string;
  sourceReceiptPath?: string;
  eventReplay?: JobEventReplay;
  retryAttempt?: number;
}

interface RenderQualityManifestSummary {
  path?: string;
  status?: string;
  receiptId?: string;
  hostReceiptPath?: string;
  code?: string;
  message?: string;
  rows?: RenderQualityManifestRowSummary[];
}

interface RenderQualityManifestRowSummary {
  rowId?: string;
  packageId?: string;
  path?: string;
  status?: string;
  receiptId?: string;
  hostReceiptPath?: string;
  code?: string;
  message?: string;
}

interface RenderCancelControl {
  cancelReceiptId: string;
  cancelReceiptPath: string;
  reason?: string;
}

interface RenderRetryControl {
  retryReceiptId: string;
  retryReceiptPath: string;
  sourceReceiptId: string;
  retryAttempt: number;
  reason?: string;
}

interface RenderControlIndex {
  cancellationsByTarget: Map<string, RenderCancelControl>;
  retriesBySource: Map<string, RenderRetryControl[]>;
}

// Re-pointed at the single authored contract (schemas/job-status.json). "queued" became
// "pending" there because a caller in that state is waiting for a slot, not being worked on.
type RenderJobState = JobState;

interface RenderJobProgress {
  completed: number;
  total: number;
  percent: number;
}

type RenderStateCounts = Record<RenderJobState, number>;

type ExportPresetGroupId = "delivery" | "transparent" | "animation" | "image";
type ExportPresetOutputKind = "video" | "image_sequence" | "still_frame";

interface ExportPresetPanelGroup {
  id: ExportPresetGroupId;
  label: string;
  presetIds: MotionExportPreset[];
}

interface ExportPresetPanelCard {
  preset: MotionExportPreset;
  label: string;
  codec: string;
  container: string;
  extension: string;
  mimeType: string;
  outputArgs: string[];
  audioCodec: string | null;
  supportsAudio: boolean;
  supportsAlpha: boolean;
  groupId: ExportPresetGroupId;
  outputKind: ExportPresetOutputKind;
  badges: string[];
  recommendedFor: string[];
  suggestedArgs: {
    render: string[];
    debugRender: string[];
  };
  verification?: ExportPresetVerification;
}

interface ExportPresetPanel {
  defaultPreset: MotionExportPreset;
  recommendedPresets: {
    delivery: MotionExportPreset;
    transparent: MotionExportPreset;
    imageSequence: MotionExportPreset;
    stillFrame: MotionExportPreset;
  };
  groups: ExportPresetPanelGroup[];
  cards: ExportPresetPanelCard[];
  platformVerification?: ExportPresetPlatformVerification;
}

type ExportPlanPreflightStatus = "passed" | "warning" | "required" | "planned" | "missing" | "partial" | "failed" | "not_checked";

interface ExportPlanPreflightItem {
  id: string;
  label: string;
  status: ExportPlanPreflightStatus;
  command?: MotionDebugCommand;
  details: string[];
}

interface ExportPlanCapturePlan {
  mode: "deterministic-browser-capture";
  requirements: string[];
  command: "motion.browser.workflow.capture";
}

interface ExportPlanFeatureImpact {
  audio: {
    requested: boolean;
    supported: boolean;
    packageTrackCount: number;
    willMux: boolean;
    willDrop: boolean;
  };
  alpha: {
    requested: boolean;
    supported: boolean;
    willPreserve: boolean;
    willFlatten: boolean;
  };
}

interface ExportPlanSuggestedAction {
  id: "render" | "browserCapture" | "qualityCheck" | "platformVerification";
  command: MotionDebugCommand;
  args: Record<string, unknown>;
}

interface ExportPlan {
  ok: true;
  target: string;
  preset: MotionExportPreset;
  presetSpec: MotionExportPresetSpec;
  outputKind: ExportPresetOutputKind;
  recommendedLane: string | null;
  recommendedPipeline?: RendererCapabilityPipeline;
  outputPath?: string;
  packageRoot?: string;
  packageId?: string;
  packageName?: string;
  motionId?: string;
  durationMs?: number;
  fps?: number;
  size?: { width: number; height: number };
  warningCount: number;
  warnings: string[];
  reasoning: string[];
  featureImpact: ExportPlanFeatureImpact;
  capturePlan: ExportPlanCapturePlan;
  preflight: ExportPlanPreflightItem[];
  platformVerification?: ExportPresetPlatformVerification;
  qualityManifestPath?: string;
  suggestedArgs: {
    render: string[];
    debugRender: string[];
  };
  suggestedActions: ExportPlanSuggestedAction[];
}

type ExportPresetVerificationStatus = "not_checked" | "missing" | "partial" | "passed" | "failed";

interface ExportPresetVerification {
  status: ExportPresetVerificationStatus;
  requiredCommands: string[];
  satisfiedHosts: string[];
  missingHosts: string[];
  failedHosts: string[];
  failedCommandIds: string[];
  missingCommandHosts: string[];
}

interface ExportPresetPlatformVerification extends PlatformVerificationPanelSummary {
  receiptsRoot: string;
}

type TimelinePanelCommand =
  | "motion.timeline.inspect"
  | "motion.timeline.playhead.set"
  | "motion.timeline.range.select"
  | "motion.timeline.viewport.set"
  | "motion.preview.playhead"
  | "motion.preview.strip";

interface TimelinePanelSuggestedAction {
  id: "inspect" | "setPlayhead" | "selectRange" | "setViewport" | "preview" | "previewStrip";
  command: TimelinePanelCommand;
  args: { packageRoot: string };
}

interface TimelinePanelLayerRow {
  index: number;
  id: string;
  type: string;
  trackId?: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  activeAtPlayhead: boolean;
  textPreview?: string;
  source?: string;
  src?: string;
  assetId?: string;
  assetRef?: string;
  sceneIds: string[];
  markerIds: string[];
  /** Every keyframe target STORED on the layer, animating or not. */
  keyframeTargets: string[];
  /**
   * Keyframes on this layer the timeline evaluator cannot read, and will therefore not animate.
   * Present only when non-zero, so a healthy package's panel is byte-for-byte unchanged. Without it
   * this row said only "this layer has keyframe targets", which is exactly the sentence that misled
   * the author of the 309-keyframe package (ca8ee4c) into believing the piece animated.
   */
  unreadableKeyframeCount?: number;
  transitionKinds: string[];
}

interface TimelinePanelSafeAreaRow {
  id: string;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

interface TimelinePanelProtectedRegionRow {
  id: string;
  label?: string;
  role?: string;
  startMs: number;
  durationMs: number;
  endMs: number;
}

interface TimelinePanelDurationPolicy {
  schema: "shellx-motion/duration-policy@1";
  minDurationMs?: number;
  maxDurationMs?: number;
  resizeMode?: DurationPolicy["resizeMode"];
  protectedRegions: TimelinePanelProtectedRegionRow[];
}

interface TimelinePanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  controls: Record<string, unknown>;
  counts: {
    layers: number;
    tracks: number;
    scenes: number;
    markers: number;
    /** Layers that actually animate: at least one keyframe the timeline evaluator can read. */
    keyframedLayers: number;
    /** Stored keyframes the evaluator cannot read. Omitted when there are none. */
    unreadableKeyframes?: number;
    audioLayers: number;
    videoLayers: number;
    webLayers: number;
    safeAreas: number;
    protectedRegions: number;
  };
  layers: TimelinePanelLayerRow[];
  safeAreas: TimelinePanelSafeAreaRow[];
  durationPolicy: TimelinePanelDurationPolicy | null;
  tracks: ReturnType<typeof inspectMotionTimeline>["tracks"];
  scenes: ReturnType<typeof inspectMotionTimeline>["scenes"];
  markers: ReturnType<typeof inspectMotionTimeline>["markers"];
  layerTrackRefs: ReturnType<typeof inspectMotionTimeline>["layerTrackRefs"];
  suggestedActions: TimelinePanelSuggestedAction[];
}

type TimelineKeyframesPanelCommand =
  | "motion.timeline.panel"
  | "motion.timeline.keyframe.upsert"
  | "motion.timeline.keyframe.easing.apply"
  | "motion.timeline.keyframe.shift"
  | "motion.timeline.keyframe.scale"
  | "motion.timeline.keyframe.duplicate"
  | "motion.timeline.keyframe.distribute"
  | "motion.timeline.keyframe.reverse"
  | "motion.timeline.keyframe.snap"
  | "motion.timeline.easing.presets"
  | "motion.timeline.animation.presets"
  | "motion.timeline.animation.preset.apply";

interface TimelineKeyframesPanelSuggestedAction {
  id:
    | "timeline"
    | "upsert"
    | "applyEasing"
    | "shift"
    | "scale"
    | "duplicate"
    | "distribute"
    | "reverse"
    | "snap"
    | "easingPresets"
    | "animationPresets"
    | "applyAnimationPreset";
  command: TimelineKeyframesPanelCommand;
  args: Record<string, unknown>;
}

interface TimelineKeyframeTargetRow {
  layerId: string;
  target: string;
  /** Every keyframe stored on this target, readable or not. */
  keyframeCount: number;
  /** Absent when no keyframe on this target is readable — there is then no real first/last time. */
  firstMs?: number;
  lastMs?: number;
  easings: string[];
  /** Value types of the READABLE keyframes. Empty when none are readable. */
  valueTypes: string[];
  /**
   * Keyframes the engine cannot read, and will therefore not animate: `atMs` or `value` missing or
   * not finite. Present only when non-zero, so a healthy package's panel is unchanged. This exists
   * because the panel previously reported such keyframes as ordinary ones and emitted
   * `valueTypes: ["undefined"]` — a confident-looking panel for animation that could never run.
   */
  malformedKeyframes?: number;
  /** The readable keyframes, in time order — what the renderer will actually interpolate. */
  keyframes: MotionKeyframe[];
}

interface TimelineKeyframeLayerRow {
  index: number;
  id: string;
  type: string;
  name?: string;
  trackId?: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  locked: boolean;
  visible: boolean;
  keyframeTargetCount: number;
  keyframeCount: number;
  targets: TimelineKeyframeTargetRow[];
}

interface TimelineKeyframesPanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  filter?: { layerId?: string; target?: string };
  counts: {
    layers: number;
    animatedLayers: number;
    targets: number;
    keyframes: number;
    /** Keyframes the renderer cannot read. See {@link TimelineKeyframeTargetRow.malformedKeyframes}. */
    malformedKeyframes: number;
    easingPresets: number;
    animationPresets: number;
  };
  layers: TimelineKeyframeLayerRow[];
  targets: TimelineKeyframeTargetRow[];
  easingPresets: ReturnType<typeof listMotionEasingPresets>;
  animationPresets: ReturnType<typeof listMotionAnimationPresets>;
  suggestedActions: TimelineKeyframesPanelSuggestedAction[];
  /** Carried up to the command result so unreadable keyframes reach the author, not just the panel. */
  warnings: string[];
}

type TimelineTransitionsPanelCommand =
  | "motion.timeline.panel"
  | "motion.timeline.transition.upsert"
  | "motion.timeline.transition.delete"
  | "motion.timeline.easing.presets"
  | "motion.preview.playhead";

interface TimelineTransitionsPanelSuggestedAction {
  id: "timeline" | "upsert" | "delete" | "easingPresets" | "preview";
  command: TimelineTransitionsPanelCommand;
  args: Record<string, unknown>;
}

interface TimelineTransitionRow {
  key: string;
  layerId: string;
  edge: "in" | "out";
  type: MotionTransition["type"];
  durationMs: number;
  fromMs: number;
  toMs: number;
  easing?: MotionTransition["easing"];
  direction?: MotionTransition["direction"];
  distance?: number;
  transition: MotionTransition;
}

interface TimelineTransitionLayerRow {
  index: number;
  id: string;
  type: string;
  name?: string;
  trackId?: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  locked: boolean;
  visible: boolean;
  transitionCount: number;
  transitions: TimelineTransitionRow[];
}

interface TimelineTransitionsPanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  filter?: { layerId?: string; edge?: "in" | "out" };
  counts: {
    layers: number;
    transitionLayers: number;
    transitions: number;
    enterTransitions: number;
    exitTransitions: number;
    transitionTypes: number;
    easingPresets: number;
  };
  transitionTypes: string[];
  layers: TimelineTransitionLayerRow[];
  transitions: TimelineTransitionRow[];
  easingPresets: ReturnType<typeof listMotionEasingPresets>;
  suggestedActions: TimelineTransitionsPanelSuggestedAction[];
}

type TimelineEasingPanelCommand =
  | "motion.timeline.keyframes.panel"
  | "motion.timeline.transitions.panel"
  | "motion.timeline.keyframe.easing.apply"
  | "motion.timeline.easing.presets"
  | "motion.timeline.animation.presets"
  | "motion.timeline.animation.preset.apply";

interface TimelineEasingPanelSuggestedAction {
  id: "keyframes" | "transitions" | "applyEasing" | "presets" | "animationPresets" | "applyAnimationPreset";
  command: TimelineEasingPanelCommand;
  args: Record<string, unknown>;
}

interface TimelineEasingSample {
  t: number;
  value: number;
}

interface TimelineEasingUsageRef {
  layerId: string;
  target: string;
  kind: "keyframe" | "transition";
  atMs?: number;
  edge?: "in" | "out";
  type?: MotionTransition["type"];
}

interface TimelineEasingUsageEntry extends TimelineEasingUsageRef {
  easing: string;
}

interface TimelineEasingPresetRow {
  id: string;
  name: string;
  easing: MotionEasing;
  kind: "named" | "cubic-bezier" | "steps" | "spring";
  description: string;
  curve?: [number, number, number, number];
  sampleCount: number;
  samples: TimelineEasingSample[];
  usageCount: number;
  usedBy: TimelineEasingUsageRef[];
  recommendedFor: string[];
}

interface TimelineCustomEasingRow {
  easing: string;
  supported: boolean;
  curve?: [number, number, number, number];
  sampleCount: number;
  samples: TimelineEasingSample[];
  usageCount: number;
  usedBy: TimelineEasingUsageRef[];
}

interface TimelineEasingPanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  counts: {
    presets: number;
    usedPresets: number;
    customEasings: number;
    usage: number;
    keyframeUsage: number;
    transitionUsage: number;
    /** Keyframes excluded from every count above because the evaluator cannot read them. */
    unreadableKeyframes: number;
  };
  usage: {
    total: number;
    byEasing: Record<string, number>;
    custom: TimelineCustomEasingRow[];
  };
  presets: TimelineEasingPresetRow[];
  /** Non-empty only when unreadable keyframes were excluded. See `timelineEasingPanelWarnings`. */
  warnings: string[];
  suggestedActions: TimelineEasingPanelSuggestedAction[];
}

type AudioPanelCommand =
  | "motion.export.plan"
  | "motion.render.final"
  | "motion.timeline.panel"
  | "motion.timeline.inspect"
  | "motion.timeline.track.volume"
  | "motion.timeline.track.fade"
  | "motion.timeline.track.pan"
  | "motion.timeline.layer.ducking.set";

interface AudioPanelSuggestedAction {
  id: "exportPlan" | "render" | "timeline" | "inspect" | "trackVolume" | "trackFade" | "trackPan" | "ducking";
  command: AudioPanelCommand;
  args: Record<string, unknown>;
}

interface AudioPanelTrack {
  id: string;
  type: string;
  name?: string;
  muted: boolean;
  solo: boolean;
  layerIds: string[];
  volume?: number;
  pan?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

interface AudioPanelInput {
  index: number;
  path: string;
  layerId?: string;
  layerType?: string;
  trackId?: string;
  source?: string;
  startMs?: number;
  durationMs?: number;
  trimStartMs?: number;
  trimDurationMs?: number;
  loop?: boolean;
  volume?: number;
  pan?: number;
  muted?: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
  normalizeLoudness?: boolean;
  playbackRate?: number;
  ducking?: MotionAudioDucking;
  /**
   * Volume-automation keyframes the encoder will actually apply.
   *
   * NOT the length of the stored track. `audioVolumeAutomationFilter` reads the track through the
   * shared `readNumericKeyframes`, which is all-or-nothing: one unreadable entry and the ENTIRE
   * envelope is dropped and the input encodes at a flat volume. Reporting the stored length here
   * therefore told the author "your fade is set up" about audio that will not fade at all — the
   * same defect as the frozen video in ca8ee4c, one medium over.
   */
  volumeAutomationKeyframeCount: number;
  /** Pan-automation keyframes the encoder will apply. Same all-or-nothing rule; also refused when a value falls outside -1..1. */
  panAutomationKeyframeCount: number;
  /** Stored automation keyframes the encoder will NOT apply. Omitted when there are none. */
  unreadableAutomationKeyframeCount?: number;
}

interface AudioPanelPreset {
  preset: MotionExportPreset;
  label: string;
  supportsAudio: boolean;
  audioCodec?: string;
  willMuxAudio: boolean;
  willDropAudio: boolean;
  warnings: string[];
}

interface AudioPanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  counts: {
    layers: number;
    resolvedInputs: number;
    ducking: number;
    /** Automation keyframes the encoder will apply. See {@link AudioPanelInput.volumeAutomationKeyframeCount}. */
    volumeAutomationKeyframes: number;
    panAutomationKeyframes: number;
    /** Stored automation keyframes the encoder will drop. Omitted when there are none. */
    unreadableAutomationKeyframes?: number;
    playbackRateControls: number;
    audioTracks: number;
    mutedTracks: number;
    soloTracks: number;
    trackVolumeControls: number;
    trackPanControls: number;
    trackFadeControls: number;
  };
  tracks: AudioPanelTrack[];
  inputs: AudioPanelInput[];
  preset?: AudioPanelPreset;
  suggestedActions: AudioPanelSuggestedAction[];
  warnings: string[];
}

type MediaPanelCommand =
  | "motion.assets.panel"
  | "motion.audio.panel"
  | "motion.export.plan"
  | "motion.preview.panel"
  | "motion.timeline.layer.media.set";

interface MediaPanelSuggestedAction {
  id: "assets" | "audio" | "exportPlan" | "preview" | "setMedia";
  command: MediaPanelCommand;
  args: Record<string, unknown>;
}

type MediaPanelSourceKind = "package" | "remote" | "missing" | "no-source" | "inline";
type MediaPanelReadiness = "ready" | "warning" | "missing";
type MediaPanelSourceField = "assetRef" | "source" | "src" | "assetId";

interface MediaPanelLayer {
  id: string;
  type: string;
  startMs: number;
  durationMs: number;
  sourceKind: MediaPanelSourceKind;
  readiness: MediaPanelReadiness;
  warnings: string[];
  name?: string;
  trackId?: string;
  source?: string;
  sourceField?: MediaPanelSourceField;
  sourcePath?: string;
  exists?: boolean;
  declaredAsset?: boolean;
  assetId?: string;
  assetRef?: string;
  trim?: { startMs?: number; durationMs?: number };
  loop?: boolean;
  playbackRate?: number;
  includeAudio?: boolean;
  volume?: number;
  pan?: number;
  muted?: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
  fit?: string;
  crop?: MotionCrop;
  web?: { allowedOriginCount: number; allowedOrigins?: string[] };
}

interface MediaPanelPreset {
  preset: MotionExportPreset;
  label: string;
  supportsAudio: boolean;
  supportsAlpha: boolean;
  warnings: string[];
}

interface MediaPanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  counts: {
    mediaLayers: number;
    imageLayers: number;
    videoLayers: number;
    audioLayers: number;
    webLayers: number;
    packageSources: number;
    missingSources: number;
    localSources: number;
    remoteSources: number;
    noSourceLayers: number;
    trimmedLayers: number;
    loopedLayers: number;
    playbackRateLayers: number;
    includeAudioLayers: number;
  };
  layers: MediaPanelLayer[];
  preset?: MediaPanelPreset;
  suggestedActions: MediaPanelSuggestedAction[];
  warnings: string[];
}

interface StoryboardPanelFrame {
  index: number;
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  bodyPreview?: string;
  caption?: string;
  sourceRefCount: number;
  sourceRefs: StoryboardPanelSourceRef[];
  assetRefCount: number;
  templateId?: string;
  engineId?: string;
  reviewStatus?: string;
  reviewNote?: string;
  tags: string[];
}

interface StoryboardPanelSourceRef {
  frameId: string;
  type: string;
  title?: string;
  url?: string;
  path?: string;
}

interface StoryboardPanelSuggestedAction {
  id: "compile" | "send-to-cut";
  command: "motion.script.compile" | "motion.connector.script_to_cut";
  args: Record<string, unknown>;
}

type StoryboardReadinessStatus = "ready" | "needs-review" | "blocked";
type StoryboardReadinessSeverity = "error" | "warning" | "info";

interface StoryboardReadinessDiagnostic {
  id: string;
  severity: StoryboardReadinessSeverity;
  code: string;
  message: string;
  frameId?: string;
  fix?: string;
}

interface StoryboardReadiness {
  status: StoryboardReadinessStatus;
  canCompile: boolean;
  canSendToCut: boolean;
  reviewRequired: boolean;
  counts: { errors: number; warnings: number; infos: number };
  diagnostics: StoryboardReadinessDiagnostic[];
}

interface StoryboardPanel {
  scriptPath?: string;
  scriptId: string;
  name: string;
  sourceApp: string;
  workflow: string;
  intent?: string;
  synopsis?: string;
  review?: Record<string, unknown>;
  dimensions: { width: number; height: number; fps: number };
  counts: {
    frames: number;
    sourceRefs: number;
    assetRefs: number;
    templateHints: number;
    engineHints: number;
    needsReviewFrames: number;
  };
  totalDurationMs: number;
  frames: StoryboardPanelFrame[];
  sourceRefs: StoryboardPanelSourceRef[];
  readiness: StoryboardReadiness;
  suggestedActions: StoryboardPanelSuggestedAction[];
  warnings: string[];
}

type StoryboardGraphNodeType = "storyboard" | "frame" | "source" | "asset" | "template" | "engine" | "review";
type StoryboardGraphEdgeType = "contains_frame" | "sequence" | "references" | "uses_asset" | "uses_template" | "uses_engine" | "needs_review";

interface StoryboardGraphNode {
  id: string;
  type: StoryboardGraphNodeType;
  label: string;
  frameId?: string;
  index?: number;
  startMs?: number;
  durationMs?: number;
  status?: string;
  url?: string;
  path?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

interface StoryboardGraphEdge {
  id: string;
  type: StoryboardGraphEdgeType;
  from: string;
  to: string;
  label?: string;
}

interface StoryboardGraphSuggestedAction {
  id: "review" | "compile" | "send-to-cut";
  command: "motion.storyboard.panel" | "motion.script.compile" | "motion.connector.script_to_cut";
  args: Record<string, unknown>;
}

interface StoryboardGraph {
  scriptPath?: string;
  scriptId: string;
  name: string;
  workflow: string;
  counts: {
    nodes: number;
    edges: number;
    frames: number;
    sourceRefs: number;
    assetRefs: number;
    templateHints: number;
    engineHints: number;
    reviewNodes: number;
  };
  nodes: StoryboardGraphNode[];
  edges: StoryboardGraphEdge[];
  readiness: StoryboardReadiness;
  suggestedActions: StoryboardGraphSuggestedAction[];
  warnings: string[];
}

type PreviewPanelCommand =
  | "motion.timeline.panel"
  | "motion.preview.frame"
  | "motion.preview.playhead"
  | "motion.preview.strip"
  | "motion.render.final"
  | "motion.export.panel"
  | "motion.render.queue";

interface PreviewPanelMode {
  id: "frame" | "playhead" | "strip";
  label: string;
  command: "motion.preview.frame" | "motion.preview.playhead" | "motion.preview.strip";
  args: { packageRoot: string; atMs?: number };
}

interface PreviewPanelPlayerState {
  playheadMs: number;
  normalizedProgress: number;
  activeLayerIds: string[];
  activeSceneIds: string[];
  activeMarkerIds: string[];
  selectedRange?: TimelineRangeState;
}

interface PreviewPanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  background?: string;
  controls: Record<string, unknown>;
  player: PreviewPanelPlayerState;
  counts: TimelinePanel["counts"];
  previewModes: PreviewPanelMode[];
  suggestedActions: Array<{
    id: "timeline" | "previewFrame" | "previewPlayhead" | "previewStrip" | "render" | "exportPanel" | "queue";
    command: PreviewPanelCommand;
    args: { packageRoot?: string; atMs?: number };
  }>;
}

interface TemplateCatalogCard {
  packageRoot: string;
  packageId: string;
  packageName: string;
  templateId: string;
  templateName: string;
  compatibleHosts: string[];
  compatibleLanes: string[];
  metadata?: ReturnType<typeof listTemplateControls>["metadata"];
  preview?: ReturnType<typeof listTemplateControls>["metadata"] extends infer M ? M extends { preview?: infer P } ? P : never : never;
  outputTypes: string[];
  requirements: TemplateRequirementSummary;
  designFamilies: string[];
  /**
   * Subset of `designFamilies` whose membership is an EXACT name/declaration
   * match: the template name or one of its suitability `bestFor` hints literally
   * spells out the family id as a phrase (e.g. "ShellX Tutorial Overlay" is an
   * exact member of "tutorial-overlay"). Families that the keyword regex merely
   * derived from an incidental token (e.g. "tracked-callout-overlay" landing in
   * "tutorial-overlay" only because its name contains "overlay") are NOT listed
   * here even though they remain in `designFamilies` for browsing. This drives
   * the recommendation tiebreak in buildTemplateCatalog -- see
   * templateDesignFamilyMembership for how the exact/derived split is computed.
   */
  designFamiliesExact: string[];
  rights: TemplateRightsSummary;
  performance: TemplatePerformanceSummary;
  groupCount: number;
  paramCount: number;
  controlCount: number;
  bindingCount: number;
  controlTypes: Record<string, number>;
  targetFit?: TemplateTargetFit;
  filterFit?: TemplateFilterFit;
  requestFit?: TemplateRequestFit;
  suggestedActions: Array<{
    id: "controls" | "apply" | "sendToCut";
    command: "motion.template.controls" | "motion.template.apply" | "motion.connector.template_to_cut";
    args: { packageRoot: string; outDir?: string; values?: Record<string, TemplateValue> };
  }>;
}

interface TemplateCatalogTarget {
  host?: string;
  lane?: string;
  aspectRatio?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  commercialUse?: boolean;
}

interface TemplateCatalogFilters {
  host?: string;
  aspectRatio?: string;
  outputType?: string;
  requiresMedia?: boolean;
  requiresAudio?: boolean;
  commercialUse?: boolean;
  renderCost?: "low" | "medium" | "high";
  designFamily?: string;
}

interface TemplateTargetFit {
  ok: boolean;
  score: number;
  matched: string[];
  unmatched: string[];
  reasons: string[];
}

type TemplateFilterFit = TemplateTargetFit;

interface TemplateRequirementSummary {
  media: boolean;
  audio: boolean;
  generatedAssets: boolean;
  mediaSlotCount: number;
  audioLayerCount: number;
}

interface TemplateRightsSummary {
  status: "ready" | "warning" | "blocked" | "unknown";
  licenseId?: string;
  licenseLabel?: string;
  licenseUrl?: string;
  spdxId?: string;
  attribution?: string;
  attributionRequired?: boolean;
  redistributionAllowed?: boolean;
  commercialUse?: boolean;
  notes?: string;
  reasons: string[];
}

interface TemplatePerformanceSummary {
  status: "known" | "unknown";
  recommendedLane?: string;
  renderCost?: "low" | "medium" | "high";
  previewFps?: number;
  notes?: string[];
  targetLaneMatchesRecommendation?: boolean;
  reasons: string[];
}

interface TemplateRequestFit {
  ok: boolean;
  score: number;
  matchedBestFor: string[];
  matchedNotFor: string[];
  reasons: string[];
}

interface TemplateCatalog {
  roots: string[];
  packageCount: number;
  templateCount: number;
  compatibleTemplateCount?: number;
  filteredTemplateCount?: number;
  controlCount: number;
  target?: TemplateCatalogTarget;
  filters?: TemplateCatalogFilters;
  recommendedTemplate?: TemplateCatalogCard;
  templates: TemplateCatalogCard[];
  warnings: string[];
}

interface TemplatePlanSuggestedAction {
  id: "reviewControls" | "apply" | "sendToCut";
  command: "motion.template.controls" | "motion.template.apply" | "motion.connector.template_to_cut";
  args: { packageRoot: string; outDir?: string; values?: Record<string, TemplateValue> };
}

interface TemplatePlan {
  request: string;
  target?: TemplateCatalogTarget;
  catalog: {
    templateCount: number;
    compatibleTemplateCount?: number;
  };
  selectedTemplate: TemplateCatalogCard;
  values: Record<string, TemplateValue>;
  providedValues: Record<string, TemplateValue>;
  defaultedValues: Record<string, TemplateValue>;
  requiredParams: string[];
  missingRequiredParams: string[];
  inputReadiness: TemplatePlanInputReadiness;
  authoringLoop: TemplatePlanAuthoringLoop;
  suggestedActions: TemplatePlanSuggestedAction[];
}

interface TemplatePlanReviewFrame {
  atMs: number;
  beatIds: string[];
  label: string;
  command: "motion.preview.frame";
  args: { packageRoot: string; atMs: number };
}

interface TemplatePlanAuthoringLoop {
  story: NonNullable<ReturnType<typeof listTemplateControls>["metadata"]>["story"] | null;
  mediaSlots: NonNullable<ReturnType<typeof listTemplateControls>["metadata"]>["mediaSlots"];
  qualityTargets: NonNullable<ReturnType<typeof listTemplateControls>["metadata"]>["qualityTargets"] | null;
  qualityManifestPath?: string;
  representativeFrames: TemplatePlanReviewFrame[];
  gates: Array<{
    id: "distinctFrames" | "blankFrames" | "edgePixels" | "lumaRange" | "textFit" | "safeAreas";
    required: boolean;
    threshold?: number;
  }>;
  sequence: Array<{
    id: "apply" | "reviewFrames" | "render" | "quality" | "reviseOnFailure" | "handoffCut";
    command: "motion.template.apply" | "motion.preview.frame" | "motion.render.final" | "motion.quality.check" | "motion.agent.revision.plan" | "motion.connector.template_to_cut";
    after?: string[];
    repeatAtMs?: number[];
    inputArtifactRole?: "rendered_media" | "quality_receipt";
  }>;
}

type TemplatePlanInputSource = "provided" | "default" | "missing";

interface TemplatePlanInputReadinessParam {
  paramId: string;
  label?: string;
  type: string;
  required: boolean;
  source: TemplatePlanInputSource;
  value?: TemplateValue;
}

interface TemplatePlanInputReadiness {
  status: "ready" | "ready-with-defaults" | "blocked";
  reviewRequired: boolean;
  counts: {
    totalParams: number;
    requiredParams: number;
    provided: number;
    defaulted: number;
    missingRequired: number;
    optionalMissing: number;
  };
  params: TemplatePlanInputReadinessParam[];
}

interface TemplatePanelGroup {
  id: string;
  label: string;
  order?: number;
  paramIds: string[];
  controlCount: number;
}

interface TemplatePanelControl {
  paramId: string;
  label?: string;
  type: string;
  widget: string;
  groupId?: string;
  order?: number;
  defaultValue: unknown;
  currentValue?: unknown;
  currentValueFound: boolean;
  bindingCount: number;
  bindingPaths: string[];
  layerIds: string[];
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  media: boolean;
}

interface TemplatePanelMediaSlot {
  paramId: string;
  label?: string;
  required: boolean;
  defaultValue?: unknown;
  currentValue?: unknown;
  acceptedAssetRoot: "assets/";
  role?: string;
  description?: string;
  acceptedKinds?: Array<"image" | "video">;
  fit?: "cover" | "contain" | "fill";
  minWidth?: number;
  minHeight?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  rightsRequired?: boolean;
}

interface TemplatePanelValidationMessage {
  paramId: string;
  severity: "info" | "warning" | "error";
  message: string;
}

interface TemplatePanelValidation {
  status: "ready" | "ready-with-defaults" | "blocked";
  requiredParams: string[];
  missingRequiredParams: string[];
  messages: TemplatePanelValidationMessage[];
}

interface TemplatePanelHostCompatibilityNote {
  host: "shellx-motion" | "shellx-cut" | "shellx-canvas" | string;
  status: "compatible" | "not_advertised";
  message: string;
}

interface TemplatePanel {
  packageRoot: string;
  packageId: string;
  packageName: string;
  templateId: string;
  templateName: string;
  motionId: string;
  compatibleHosts: string[];
  compatibleLanes: string[];
  metadata?: ReturnType<typeof listTemplateControls>["metadata"];
  preview?: ReturnType<typeof listTemplateControls>["metadata"] extends infer M ? M extends { preview?: infer P } ? P : never : never;
  recommendedLane?: string;
  mediaSlots: TemplatePanelMediaSlot[];
  validation: TemplatePanelValidation;
  hostCompatibilityNotes: TemplatePanelHostCompatibilityNote[];
  groupCount: number;
  paramCount: number;
  controlCount: number;
  bindingCount: number;
  mediaParamCount: number;
  controlTypes: Record<string, number>;
  groups: TemplatePanelGroup[];
  controls: TemplatePanelControl[];
  bindings: ReturnType<typeof listTemplateControls>["bindings"];
  warnings: string[];
  suggestedActions: Array<{
    id: "controls" | "apply" | "mediaReplace" | "sendToCut";
    command: "motion.template.controls" | "motion.template.apply" | "motion.template.media.replace" | "motion.connector.template_to_cut";
    args: { packageRoot: string; outDir?: string; values?: Record<string, TemplateValue> };
  }>;
}

type TemplateBindingRead = { found: true; value: unknown } | { found: false; message: string };

type PackageBrowserCommand =
  | "motion.timeline.inspect"
  | "motion.preview.playhead"
  | "motion.render.final"
  | "motion.assets.panel"
  | "motion.brand.panel"
  | "motion.template.controls";

interface PackageBrowserSuggestedAction {
  id: "inspect" | "preview" | "render" | "assets" | "brand" | "templateControls";
  command: PackageBrowserCommand;
  args: { packageRoot: string };
}

interface PackageBrowserCard {
  packageRoot: string;
  packageId: string;
  packageName: string;
  sourceApp: string;
  compatibleHosts: string[];
  compatibleLanes: string[];
  motionId: string;
  durationMs: number;
  fps: number;
  size: { width: number; height: number };
  layerCount: number;
  assetCount: number;
  motionAssetCount: number;
  sceneCount: number;
  trackCount: number;
  markerCount: number;
  designTokenGroupCount: number;
  hasTemplate: boolean;
  templateId?: string;
  templateName?: string;
  controlCount?: number;
  provenance: Record<string, unknown> & { sourceApp: string };
  suggestedActions: PackageBrowserSuggestedAction[];
}

interface PackageBrowser {
  roots: string[];
  packageCount: number;
  templateCount: number;
  assetCount: number;
  packages: PackageBrowserCard[];
  warnings: string[];
}

function buildExportPlan(input: {
  pkg?: MotionPackage;
  target: string;
  preset: MotionExportPreset;
  outputPath?: string;
  qualityManifestPath?: string;
  needsAlpha: boolean;
  needsAudio: boolean;
  platformVerification?: ExportPresetPlatformVerification;
}): ExportPlan {
  const spec = resolveMotionExportPreset(input.preset);
  const outputKind = exportPresetOutputKind(spec);
  const packageTrackCount = input.pkg
    ? resolvePackageAudioInputs({ root: input.pkg.root, manifest: input.pkg.manifest, motion: input.pkg.motion }).length
    : 0;
  const audioRequested = input.needsAudio || packageTrackCount > 0;
  const alphaRequested = input.needsAlpha || exportPlanTargetNeedsAlpha(input.target);
  const warnings = [
    ...exportPlanAudioWarnings(input.preset, audioRequested, packageTrackCount),
    ...exportPlanAlphaWarnings(input.preset, alphaRequested)
  ];
  if (input.qualityManifestPath && !supportsDebugBatchQualityManifestPreset(input.preset)) {
    warnings.push(`Quality manifests are not supported for export preset ${input.preset}; use a video, GIF, png-frame, or png-sequence preset.`);
  }
  const capabilityMatch = exportPlanCapabilityMatch({
    pkg: input.pkg,
    preset: input.preset,
    outputKind,
    needsAlpha: alphaRequested,
    needsAudio: audioRequested
  });
  const frameLaneArgs = capabilityMatch.recommendedPipeline?.frameLane ? ["--frame-lane", capabilityMatch.recommendedPipeline.frameLane] : [];
  const frameLaneActionArg = capabilityMatch.recommendedPipeline?.frameLane ? { frameLane: capabilityMatch.recommendedPipeline.frameLane } : {};

  const debugRender = [
    ...(input.pkg ? ["--package", input.pkg.root] : []),
    "--preset",
    input.preset,
    ...frameLaneArgs,
    ...(input.outputPath ? ["--out", input.outputPath] : []),
    ...(input.qualityManifestPath ? ["--quality-manifest", input.qualityManifestPath] : [])
  ];
  const renderArgs = [
    ...(input.pkg ? [input.pkg.root] : []),
    "--preset",
    input.preset,
    ...frameLaneArgs,
    ...(input.outputPath ? ["--out", input.outputPath] : []),
    ...(input.qualityManifestPath ? ["--quality-manifest", input.qualityManifestPath] : [])
  ];

  const suggestedActions: ExportPlanSuggestedAction[] = [
    {
      id: "render",
      command: "motion.render.final",
      args: {
        ...(input.pkg ? { packageRoot: input.pkg.root } : {}),
        preset: input.preset,
        ...frameLaneActionArg,
        ...(input.outputPath ? { outputPath: input.outputPath } : {}),
        ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {})
      }
    },
    {
      id: "browserCapture",
      command: "motion.browser.workflow.capture",
      args: {
        ...(input.pkg ? { packageRoot: input.pkg.root } : {})
      }
    }
  ];
  if (input.qualityManifestPath) {
    suggestedActions.push({
      id: "qualityCheck",
      command: "motion.quality.check",
      args: {
        ...(input.outputPath ? { inputPath: input.outputPath } : {}),
        manifestPath: input.qualityManifestPath
      }
    });
  }
  if (input.platformVerification) {
    suggestedActions.push({
      id: "platformVerification",
      command: "motion.platform.verification.panel",
      args: {
        receiptsRoot: input.platformVerification.receiptsRoot,
        requiredHosts: input.platformVerification.requiredHosts
      }
    });
  }

  const plan: ExportPlan = {
    ok: true,
    target: input.target,
    preset: input.preset,
    presetSpec: spec,
    outputKind,
    recommendedLane: capabilityMatch.recommendedLane,
    ...(capabilityMatch.recommendedPipeline ? { recommendedPipeline: capabilityMatch.recommendedPipeline } : {}),
    ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    ...(input.pkg ? {
      packageRoot: input.pkg.root,
      packageId: input.pkg.manifest.id,
      packageName: input.pkg.manifest.name,
      motionId: input.pkg.motion.id,
      durationMs: input.pkg.motion.durationMs,
      fps: input.pkg.motion.fps,
      size: { width: input.pkg.motion.width, height: input.pkg.motion.height }
    } : {}),
    warningCount: warnings.length,
    warnings,
    reasoning: exportPlanReasoning({ target: input.target, preset: input.preset, spec, needsAlpha: alphaRequested, needsAudio: audioRequested }),
    featureImpact: {
      audio: {
        requested: audioRequested,
        supported: spec.supportsAudio,
        packageTrackCount,
        willMux: audioRequested && spec.supportsAudio,
        willDrop: audioRequested && !spec.supportsAudio
      },
      alpha: {
        requested: alphaRequested,
        supported: spec.supportsAlpha,
        willPreserve: alphaRequested && spec.supportsAlpha,
        willFlatten: alphaRequested && !spec.supportsAlpha
      }
    },
    capturePlan: exportPlanCapturePlan(),
    preflight: exportPlanPreflight({
      pkg: input.pkg,
      preset: input.preset,
      spec,
      needsAudio: audioRequested,
      needsAlpha: alphaRequested,
      qualityManifestPath: input.qualityManifestPath,
      platformVerification: input.platformVerification
    }),
    ...(input.platformVerification ? { platformVerification: input.platformVerification } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
    suggestedArgs: { render: renderArgs, debugRender },
    suggestedActions
  };
  return plan;
}

function exportPlanCapabilityMatch(input: {
  pkg?: MotionPackage;
  preset: MotionExportPreset;
  outputKind: ExportPresetOutputKind;
  needsAlpha: boolean;
  needsAudio: boolean;
}): {
  recommendedLane: string | null;
  recommendedPipeline?: RendererCapabilityPipeline;
} {
  const options: RendererCapabilityMatchOptions = {
    output: input.preset,
    target: exportPlanRendererTarget(input.outputKind),
    needsAlpha: input.needsAlpha,
    needsAudio: input.needsAudio
  };
  const matched = input.pkg
    ? matchRendererCapabilityCards(input.pkg.motion, options)
    : matchRendererCapabilityCardsForRequest(listRendererCapabilityCards(), options);
  return {
    recommendedLane: matched.recommendedLane,
    ...(matched.recommendedPipeline ? { recommendedPipeline: matched.recommendedPipeline } : {})
  };
}

function exportPlanRendererTarget(outputKind: ExportPresetOutputKind): string {
  if (outputKind === "image_sequence") return "frame-sequence";
  if (outputKind === "still_frame") return "still-frame";
  return "final";
}

function chooseExportPlanPreset(input: { target: string; needsAlpha: boolean }): MotionExportPreset {
  const target = input.target.toLowerCase();
  if (input.needsAlpha || target.includes("transparent") || target.includes("overlay") || target.includes("alpha")) return "webm-vp9-alpha";
  if (target.includes("gif")) return "gif";
  if (target.includes("png sequence") || target.includes("image sequence") || target.includes("frame sequence") || target.includes("visual regression")) return "png-sequence";
  if (target.includes("jpeg") || target.includes("jpg")) return "jpeg-frame";
  if (target.includes("thumbnail") || target.includes("still") || target.includes("poster")) return "png-frame";
  if (target.includes("webm") || target.includes("web delivery") || target.includes("compact preview")) return "webm-vp9";
  return "mp4-h264";
}

function exportPlanTargetNeedsAlpha(target: string): boolean {
  const normalized = target.toLowerCase();
  return normalized.includes("transparent") || normalized.includes("alpha") || normalized.includes("overlay");
}

function exportPlanAudioWarnings(preset: MotionExportPreset, requested: boolean, packageTrackCount: number): string[] {
  if (!requested || resolveMotionExportPreset(preset).supportsAudio) return [];
  if (packageTrackCount > 0) return debugAudioWarningsForMotionExportPreset(preset, packageTrackCount);
  return [`Export preset ${preset} does not support audio; requested audio will be ignored.`];
}

function exportPlanAlphaWarnings(preset: MotionExportPreset, requested: boolean): string[] {
  if (!requested || resolveMotionExportPreset(preset).supportsAlpha) return [];
  return [`Export preset ${preset} does not preserve alpha; requested transparency will be flattened.`];
}

function exportPlanReasoning(input: {
  target: string;
  preset: MotionExportPreset;
  spec: MotionExportPresetSpec;
  needsAlpha: boolean;
  needsAudio: boolean;
}): string[] {
  const reasons = [`Selected ${input.preset} for ${input.target || "delivery"} output.`];
  if (input.needsAlpha) reasons.push(input.spec.supportsAlpha ? "Preset preserves alpha for transparent overlays." : "Preset does not preserve alpha; review warnings before render.");
  if (input.needsAudio) reasons.push(input.spec.supportsAudio ? "Preset can carry muxed audio." : "Preset is silent; review audio warning before render.");
  if (input.preset === "mp4-h264") reasons.push("MP4 H.264 remains the default Cut and Canvas delivery preset.");
  if (input.preset === "webm-vp9-alpha") reasons.push("WebM VP9 alpha is the default transparent overlay preset for browser and Cut handoff review.");
  if (input.preset === "png-sequence") reasons.push("PNG sequence is suitable for batch frame output and visual regression baselines.");
  return reasons;
}

function exportPlanCapturePlan(): ExportPlanCapturePlan {
  return {
    mode: "deterministic-browser-capture",
    command: "motion.browser.workflow.capture",
    requirements: [
      "fixed-viewport-and-device-scale",
      "stylesheets-and-fonts-ready-before-animation-start",
      "network-blocked-unless-declared",
      "timeline-driven-animation-start",
      "trim-dead-lead-in-before-ffmpeg-encode"
    ]
  };
}

function exportPlanPreflight(input: {
  pkg?: MotionPackage;
  preset: MotionExportPreset;
  spec: MotionExportPresetSpec;
  needsAudio: boolean;
  needsAlpha: boolean;
  qualityManifestPath?: string;
  platformVerification?: ExportPresetPlatformVerification;
}): ExportPlanPreflightItem[] {
  const items: ExportPlanPreflightItem[] = [
    {
      id: "package.load",
      label: "Package Load",
      status: input.pkg ? "passed" : "not_checked",
      command: "motion.open",
      details: input.pkg ? [`Loaded ${input.pkg.manifest.id}.`] : ["No packageRoot was provided; plan is preset-only."]
    },
    {
      id: "capture.deterministic_readiness",
      label: "Deterministic Capture Readiness",
      status: "required",
      command: "motion.browser.workflow.capture",
      details: exportPlanCapturePlan().requirements
    }
  ];
  if (input.platformVerification) {
    items.push({
      id: "platform.verification",
      label: "Platform Verification",
      status: exportPlanPlatformStatus(input.platformVerification),
      command: "motion.platform.verification.panel",
      details: [
        `required=${input.platformVerification.requiredHosts.join(",") || "none"}`,
        `satisfied=${input.platformVerification.satisfiedHosts.join(",") || "none"}`,
        `missing=${input.platformVerification.missingHosts.join(",") || "none"}`
      ]
    });
  }
  if (input.qualityManifestPath) {
    items.push({
      id: "quality.manifest",
      label: "Quality Manifest",
      status: supportsDebugBatchQualityManifestPreset(input.preset) ? "planned" : "failed",
      command: "motion.quality.check",
      details: [`manifest=${input.qualityManifestPath}`, `preset=${input.preset}`]
    });
  }
  items.push({
    id: "preset.compatibility",
    label: "Preset Compatibility",
    status: exportPlanPresetCompatibilityStatus(input),
    command: "motion.export.presets",
    details: [
      `outputKind=${exportPresetOutputKind(input.spec)}`,
      `audio=${exportPlanFeatureCompatibilityLabel(input.needsAudio, input.spec.supportsAudio)}`,
      `alpha=${exportPlanFeatureCompatibilityLabel(input.needsAlpha, input.spec.supportsAlpha)}`
    ]
  });
  return items;
}

function exportPlanPresetCompatibilityStatus(input: {
  spec: MotionExportPresetSpec;
  needsAudio: boolean;
  needsAlpha: boolean;
}): ExportPlanPreflightStatus {
  return (input.needsAudio && !input.spec.supportsAudio) || (input.needsAlpha && !input.spec.supportsAlpha)
    ? "warning"
    : "passed";
}

function exportPlanFeatureCompatibilityLabel(requested: boolean, supported: boolean): string {
  if (requested) return supported ? "requested_supported" : "requested_not_supported";
  return supported ? "supported" : "not_supported";
}

function exportPlanPlatformStatus(platform: ExportPresetPlatformVerification): ExportPlanPreflightStatus {
  if (platform.status === "passed") return "passed";
  if (platform.status === "failed") return "failed";
  if (platform.status === "partial") return "partial";
  return "missing";
}

function exportPlanMissingPlatformVerification(requiredHosts: string[] | null): ExportPresetPlatformVerification | undefined {
  if (!requiredHosts || requiredHosts.length === 0) return undefined;
  return {
    receiptsRoot: "",
    status: "missing",
    requiredHosts,
    satisfiedHosts: [],
    missingHosts: requiredHosts,
    failedHosts: [],
    platformReceiptCount: 0,
    hostReceiptCount: 0,
    aggregateReceiptCount: 0,
    invalidReceiptCount: 0,
    hostReceipts: [],
    aggregateReceipts: []
  };
}

function buildExportPresetPanel(platformVerification?: ExportPresetPlatformVerification): ExportPresetPanel {
  const groups: ExportPresetPanelGroup[] = [
    { id: "delivery", label: "Delivery Video", presetIds: ["mp4-h264", "mp4-hevc", "webm-av1", "webm-vp9"] },
    { id: "transparent", label: "Transparent Overlays", presetIds: ["webm-vp9-alpha", "mov-prores"] },
    { id: "animation", label: "Lightweight Animation", presetIds: ["gif"] },
    { id: "image", label: "Frames And Sequences", presetIds: ["png-sequence", "png-frame", "jpeg-frame"] }
  ];
  const groupByPreset = new Map<MotionExportPreset, ExportPresetGroupId>();
  for (const group of groups) {
    for (const preset of group.presetIds) groupByPreset.set(preset, group.id);
  }
  const cards = listMotionExportPresets().map((preset): ExportPresetPanelCard => {
    const verification = platformVerification ? exportPresetVerification(preset.preset, platformVerification) : undefined;
    return {
      ...preset,
      groupId: groupByPreset.get(preset.preset) ?? "delivery",
      outputKind: exportPresetOutputKind(preset),
      badges: exportPresetBadges(preset),
      recommendedFor: exportPresetRecommendations(preset.preset),
      suggestedArgs: {
        render: ["--preset", preset.preset],
        debugRender: ["--preset", preset.preset]
      },
      ...(verification ? { verification } : {})
    };
  });
  return {
    defaultPreset: "mp4-h264",
    recommendedPresets: {
      delivery: "mp4-h264",
      transparent: "webm-vp9-alpha",
      imageSequence: "png-sequence",
      stillFrame: "png-frame"
    },
    groups,
    cards,
    ...(platformVerification ? { platformVerification } : {})
  };
}

function buildTimelinePanel(
  pkg: MotionPackage,
  controls: Record<string, unknown>,
  playheadMs: number,
  policy: DurationPolicy | null
): TimelinePanel {
  const timeline = inspectMotionTimeline(pkg.motion);
  const layers = timelinePanelLayerRows(pkg.motion, playheadMs);
  const safeAreas = timelinePanelSafeAreaRows(pkg.motion);
  const durationPolicy = timelinePanelDurationPolicy(policy);
  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    controls,
    counts: {
      layers: pkg.motion.layers.length,
      tracks: timeline.trackCount,
      scenes: timeline.sceneCount,
      markers: timeline.markerCount,
      ...timelinePanelKeyframeCounts(pkg.motion),
      audioLayers: pkg.motion.layers.filter((layer) => layer.type === "audio").length,
      videoLayers: pkg.motion.layers.filter((layer) => layer.type === "video").length,
      webLayers: pkg.motion.layers.filter((layer) => layer.type === "web").length,
      safeAreas: safeAreas.length,
      protectedRegions: durationPolicy?.protectedRegions.length ?? 0
    },
    layers,
    safeAreas,
    durationPolicy,
    tracks: timeline.tracks,
    scenes: timeline.scenes,
    markers: timeline.markers,
    layerTrackRefs: timeline.layerTrackRefs,
    suggestedActions: [
      { id: "inspect", command: "motion.timeline.inspect", args: { packageRoot: pkg.root } },
      { id: "setPlayhead", command: "motion.timeline.playhead.set", args: { packageRoot: pkg.root } },
      { id: "selectRange", command: "motion.timeline.range.select", args: { packageRoot: pkg.root } },
      { id: "setViewport", command: "motion.timeline.viewport.set", args: { packageRoot: pkg.root } },
      { id: "preview", command: "motion.preview.playhead", args: { packageRoot: pkg.root } },
      { id: "previewStrip", command: "motion.preview.strip", args: { packageRoot: pkg.root } }
    ]
  };
}

function buildTimelineKeyframesPanel(
  pkg: MotionPackage,
  options: { layerId?: string; target?: string; includeEmpty?: boolean }
): TimelineKeyframesPanel {
  const easingPresets = listMotionEasingPresets();
  const animationPresets = listMotionAnimationPresets();
  const layers = timelineKeyframeLayerRows(pkg.motion, options);
  const targets = layers.flatMap((layer) => layer.targets);
  const filter = {
    ...(options.layerId ? { layerId: options.layerId } : {}),
    ...(options.target ? { target: options.target } : {})
  };
  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    counts: {
      layers: layers.length,
      animatedLayers: layers.filter((layer) => layer.keyframeTargetCount > 0).length,
      targets: targets.length,
      keyframes: targets.reduce((total, target) => total + target.keyframeCount, 0),
      malformedKeyframes: targets.reduce((total, target) => total + (target.malformedKeyframes ?? 0), 0),
      easingPresets: easingPresets.length,
      animationPresets: animationPresets.length
    },
    layers,
    targets,
    easingPresets,
    animationPresets,
    warnings: timelineKeyframePanelWarnings(targets),
    suggestedActions: [
      { id: "timeline", command: "motion.timeline.panel", args: { packageRoot: pkg.root } },
      { id: "upsert", command: "motion.timeline.keyframe.upsert", args: { packageRoot: pkg.root } },
      { id: "applyEasing", command: "motion.timeline.keyframe.easing.apply", args: { packageRoot: pkg.root } },
      { id: "shift", command: "motion.timeline.keyframe.shift", args: { packageRoot: pkg.root } },
      { id: "scale", command: "motion.timeline.keyframe.scale", args: { packageRoot: pkg.root } },
      { id: "duplicate", command: "motion.timeline.keyframe.duplicate", args: { packageRoot: pkg.root } },
      { id: "distribute", command: "motion.timeline.keyframe.distribute", args: { packageRoot: pkg.root } },
      { id: "reverse", command: "motion.timeline.keyframe.reverse", args: { packageRoot: pkg.root } },
      { id: "snap", command: "motion.timeline.keyframe.snap", args: { packageRoot: pkg.root } },
      { id: "easingPresets", command: "motion.timeline.easing.presets", args: {} },
      { id: "animationPresets", command: "motion.timeline.animation.presets", args: {} },
      { id: "applyAnimationPreset", command: "motion.timeline.animation.preset.apply", args: { packageRoot: pkg.root } }
    ]
  };
}

function buildTimelineTransitionsPanel(
  pkg: MotionPackage,
  options: { layerId?: string; edge?: "in" | "out"; includeEmpty?: boolean }
): TimelineTransitionsPanel {
  const easingPresets = listMotionEasingPresets();
  const layers = timelineTransitionLayerRows(pkg.motion, options);
  const transitions = layers.flatMap((layer) => layer.transitions);
  const transitionTypes = sortedUniqueStrings(transitions.map((transition) => transition.type));
  const filter = {
    ...(options.layerId ? { layerId: options.layerId } : {}),
    ...(options.edge ? { edge: options.edge } : {})
  };
  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    counts: {
      layers: layers.length,
      transitionLayers: layers.filter((layer) => layer.transitionCount > 0).length,
      transitions: transitions.length,
      enterTransitions: transitions.filter((transition) => transition.edge === "in").length,
      exitTransitions: transitions.filter((transition) => transition.edge === "out").length,
      transitionTypes: transitionTypes.length,
      easingPresets: easingPresets.length
    },
    transitionTypes,
    layers,
    transitions,
    easingPresets,
    suggestedActions: [
      { id: "timeline", command: "motion.timeline.panel", args: { packageRoot: pkg.root } },
      { id: "upsert", command: "motion.timeline.transition.upsert", args: { packageRoot: pkg.root } },
      { id: "delete", command: "motion.timeline.transition.delete", args: { packageRoot: pkg.root } },
      { id: "easingPresets", command: "motion.timeline.easing.presets", args: {} },
      { id: "preview", command: "motion.preview.playhead", args: { packageRoot: pkg.root } }
    ]
  };
}

function buildTimelineEasingPanel(pkg: MotionPackage, sampleCount: number): TimelineEasingPanel {
  const presets = listMotionEasingPresets();
  const { refs: usageRefs, unreadableKeyframes, unreadableTargets } = timelineEasingUsageRefs(pkg.motion);
  const usageByEasing = timelineEasingUsageByEasing(usageRefs);
  const easingValues = collectTimelineEasingValues(pkg.motion);
  const presetEasings = new Set(presets.map((preset) => easingToken(preset.easing)));
  const customEasings = sortedUniqueStrings(usageRefs.map((ref) => ref.easing).filter((easing) => !presetEasings.has(easing)));
  const customRows = customEasings.map((easing): TimelineCustomEasingRow => {
    const usedBy = usageRefsForEasing(usageRefs, easing);
    // Sample and validate against the real easing value (object-form springs are
    // keyed by a `spring(...)` token that is not itself a resolvable easing).
    const value = easingValues.get(easing) ?? easing;
    return {
      easing,
      supported: isSupportedEasing(value),
      ...(cubicCurveOfEasing(value) ? { curve: cubicCurveOfEasing(value)! } : {}),
      sampleCount,
      samples: sampleTimelineEasing(value, sampleCount),
      usageCount: usedBy.length,
      usedBy
    };
  });
  const presetRows = presets.map((preset): TimelineEasingPresetRow => {
    const usedBy = usageRefsForEasing(usageRefs, easingToken(preset.easing));
    return {
      ...preset,
      ...(cubicCurveOfEasing(preset.easing) ? { curve: cubicCurveOfEasing(preset.easing)! } : {}),
      sampleCount,
      samples: sampleTimelineEasing(preset.easing, sampleCount),
      usageCount: usedBy.length,
      usedBy,
      recommendedFor: timelineEasingRecommendations(preset.id)
    };
  });
  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    counts: {
      presets: presetRows.length,
      usedPresets: presetRows.filter((preset) => preset.usageCount > 0).length,
      customEasings: customRows.length,
      usage: usageRefs.length,
      keyframeUsage: usageRefs.filter((ref) => ref.kind === "keyframe").length,
      transitionUsage: usageRefs.filter((ref) => ref.kind === "transition").length,
      unreadableKeyframes
    },
    usage: {
      total: usageRefs.length,
      byEasing: usageByEasing,
      custom: customRows
    },
    presets: presetRows,
    warnings: timelineEasingPanelWarnings(unreadableKeyframes, unreadableTargets),
    suggestedActions: [
      { id: "keyframes", command: "motion.timeline.keyframes.panel", args: { packageRoot: pkg.root } },
      { id: "transitions", command: "motion.timeline.transitions.panel", args: { packageRoot: pkg.root } },
      { id: "applyEasing", command: "motion.timeline.keyframe.easing.apply", args: { packageRoot: pkg.root } },
      { id: "presets", command: "motion.timeline.easing.presets", args: {} },
      { id: "animationPresets", command: "motion.timeline.animation.presets", args: {} },
      { id: "applyAnimationPreset", command: "motion.timeline.animation.preset.apply", args: { packageRoot: pkg.root } }
    ]
  };
}

function buildMediaPanel(pkg: MotionPackage, preset: MotionExportPreset | undefined): MediaPanel {
  const layers = pkg.motion.layers.filter(isMediaPanelLayer).map((layer) => mediaPanelLayerRow(pkg, layer));
  const counts = {
    mediaLayers: layers.length,
    imageLayers: layers.filter((layer) => layer.type === "image").length,
    videoLayers: layers.filter((layer) => layer.type === "video").length,
    audioLayers: layers.filter((layer) => layer.type === "audio").length,
    webLayers: layers.filter((layer) => layer.type === "web").length,
    packageSources: layers.filter((layer) => layer.sourceKind === "package").length,
    missingSources: layers.filter((layer) => layer.sourceKind === "missing").length,
    localSources: layers.filter((layer) => layer.sourceKind === "package").length,
    remoteSources: layers.filter((layer) => layer.sourceKind === "remote").length,
    noSourceLayers: layers.filter((layer) => layer.sourceKind === "no-source").length,
    trimmedLayers: layers.filter((layer) => Boolean(layer.trim)).length,
    loopedLayers: layers.filter((layer) => layer.loop === true).length,
    playbackRateLayers: layers.filter((layer) => typeof layer.playbackRate === "number" && layer.playbackRate !== 1).length,
    includeAudioLayers: layers.filter((layer) => layer.type === "video" && layer.includeAudio === true).length
  };
  const presetWarnings = preset ? mediaPanelPresetWarnings(preset, counts.audioLayers, counts.includeAudioLayers) : [];
  const warnings = dedupeWarnings([
    ...layers.flatMap((layer) => layer.warnings),
    ...presetWarnings
  ]);

  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    counts,
    layers,
    ...(preset ? { preset: mediaPanelPreset(preset, presetWarnings) } : {}),
    suggestedActions: mediaPanelSuggestedActions(pkg.root, preset),
    warnings
  };
}

function buildAudioPanel(pkg: MotionPackage, preset: MotionExportPreset | undefined): AudioPanel {
  const audioInputs = resolvePackageAudioInputs(pkg);
  const audioLayers = pkg.motion.layers.filter(isAudioPanelLayer);
  const audioTracks = (pkg.motion.tracks ?? []).filter((track) => track.type === "audio");
  const usedLayerIds = new Set<string>();
  const inputs = audioInputs.map((input, index) => audioPanelInputRow(pkg, audioLayers, input, index, usedLayerIds));
  const unreadableAutomationKeyframes = inputs.reduce((total, input) => total + (input.unreadableAutomationKeyframeCount ?? 0), 0);
  const warnings = [
    ...(preset ? debugAudioWarningsForMotionExportPreset(preset, audioInputs.length) : []),
    ...audioPanelAutomationWarnings(inputs, unreadableAutomationKeyframes)
  ];
  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    counts: {
      layers: audioLayers.length,
      resolvedInputs: audioInputs.length,
      ducking: inputs.filter((input) => Boolean(input.ducking)).length,
      volumeAutomationKeyframes: inputs.reduce((total, input) => total + input.volumeAutomationKeyframeCount, 0),
      panAutomationKeyframes: inputs.reduce((total, input) => total + input.panAutomationKeyframeCount, 0),
      ...(unreadableAutomationKeyframes > 0 ? { unreadableAutomationKeyframes } : {}),
      playbackRateControls: inputs.filter((input) => typeof input.playbackRate === "number" && input.playbackRate !== 1).length,
      audioTracks: audioTracks.length,
      mutedTracks: audioTracks.filter((track) => track.muted === true).length,
      soloTracks: audioTracks.filter((track) => track.solo === true).length,
      trackVolumeControls: audioTracks.filter((track) => typeof track.volume === "number").length,
      trackPanControls: audioTracks.filter((track) => typeof track.pan === "number").length,
      trackFadeControls: audioTracks.filter((track) => typeof track.fadeInMs === "number" || typeof track.fadeOutMs === "number").length
    },
    tracks: audioTracks.map(audioPanelTrackRow),
    inputs,
    ...(preset ? { preset: audioPanelPreset(preset, audioInputs.length, warnings) } : {}),
    suggestedActions: audioPanelSuggestedActions(pkg.root, preset, audioInputs.length, audioTracks, inputs),
    warnings
  };
}

function buildStoryboardPanel(script: Record<string, unknown>, scriptPath: string | undefined): StoryboardPanel {
  const frames = storyboardFrameRecords(script);
  const panelFrames: StoryboardPanelFrame[] = [];
  const sourceRefs: StoryboardPanelSourceRef[] = [];
  const uniqueAssetRefs = new Set<string>();
  let cursorMs = 0;

  for (const [index, frame] of frames.entries()) {
    const frameId = storyboardString(frame, "id") ?? `frame-${index + 1}`;
    const frameSourceRefs = storyboardSourceRefs(frame, frameId);
    const frameAssetRefs = storyboardStringArray(frame.assetRefs);
    for (const ref of frameSourceRefs) sourceRefs.push(ref);
    for (const ref of frameAssetRefs) uniqueAssetRefs.add(ref);
    const durationMs = storyboardNumber(frame, "durationMs") ?? 0;
    const startMs = cursorMs;
    const endMs = startMs + durationMs;
    const reviewNote = storyboardString(frame, "reviewNote") ?? storyboardString(frame, "agentNote");
    cursorMs = endMs;
    panelFrames.push({
      index,
      id: frameId,
      title: storyboardString(frame, "title") ?? frameId,
      startMs,
      endMs,
      durationMs,
      ...(storyboardBodyPreview(frame.body) ? { bodyPreview: storyboardBodyPreview(frame.body) } : {}),
      ...(storyboardString(frame, "caption") ? { caption: storyboardString(frame, "caption") } : {}),
      sourceRefCount: frameSourceRefs.length,
      sourceRefs: frameSourceRefs,
      assetRefCount: frameAssetRefs.length,
      ...(storyboardHintId(frame, "template") ? { templateId: storyboardHintId(frame, "template") } : {}),
      ...(storyboardHintId(frame, "engine") ? { engineId: storyboardHintId(frame, "engine") } : {}),
      ...(storyboardString(frame, "reviewStatus") ? { reviewStatus: storyboardString(frame, "reviewStatus") } : {}),
      ...(reviewNote ? { reviewNote } : {}),
      tags: storyboardStringArray(frame.tags)
    });
  }

  const review = objectRecord(script.review) ?? undefined;
  const readiness = buildStoryboardReadiness(script, review, panelFrames, sourceRefs.length);
  const warnings = storyboardPanelWarnings(script, review, sourceRefs.length, readiness);
  const followupArgs = scriptPath ? { scriptPath } : { script };

  return {
    ...(scriptPath ? { scriptPath } : {}),
    scriptId: storyboardString(script, "id") ?? "scripted-video",
    name: storyboardString(script, "name") ?? "Scripted Video",
    sourceApp: storyboardString(script, "sourceApp") ?? "unknown",
    workflow: storyboardString(script, "workflow") ?? "unknown",
    ...(storyboardString(script, "intent") ? { intent: storyboardString(script, "intent") } : {}),
    ...(storyboardString(script, "synopsis") ? { synopsis: storyboardString(script, "synopsis") } : {}),
    ...(review ? { review } : {}),
    dimensions: {
      width: storyboardNumber(script, "width") ?? 0,
      height: storyboardNumber(script, "height") ?? 0,
      fps: storyboardNumber(script, "fps") ?? 0
    },
    counts: {
      frames: panelFrames.length,
      sourceRefs: sourceRefs.length,
      assetRefs: uniqueAssetRefs.size,
      templateHints: frames.filter((frame) => objectRecord(frame.template)).length,
      engineHints: frames.filter((frame) => objectRecord(frame.engine)).length,
      needsReviewFrames: frames.filter((frame) => storyboardString(frame, "reviewStatus") === "needs-review").length
    },
    totalDurationMs: cursorMs,
    frames: panelFrames,
    sourceRefs,
    readiness,
    suggestedActions: [
      { id: "compile", command: "motion.script.compile", args: followupArgs },
      { id: "send-to-cut", command: "motion.connector.script_to_cut", args: followupArgs }
    ],
    warnings
  };
}

function buildStoryboardGraph(script: Record<string, unknown>, scriptPath: string | undefined): StoryboardGraph {
  const panel = buildStoryboardPanel(script, scriptPath);
  const frames = storyboardFrameRecords(script);
  const scriptToken = storyboardGraphToken(panel.scriptId);
  const scriptNodeId = `storyboard:${scriptToken}`;
  const usedNodeIds = new Set<string>([scriptNodeId]);
  const usedEdgeIds = new Set<string>();
  const nodes: StoryboardGraphNode[] = [
    {
      id: scriptNodeId,
      type: "storyboard",
      label: panel.name,
      metadata: {
        sourceApp: panel.sourceApp,
        workflow: panel.workflow,
        ...(panel.intent ? { intent: panel.intent } : {}),
        dimensions: panel.dimensions,
        totalDurationMs: panel.totalDurationMs
      }
    }
  ];
  const edges: StoryboardGraphEdge[] = [];
  const assetNodeIds = new Map<string, string>();
  const templateNodeIds = new Map<string, string>();
  const engineNodeIds = new Map<string, string>();
  let previousFrameNodeId: string | undefined;
  let previousFrameToken: string | undefined;

  for (const frame of panel.frames) {
    const rawFrame = frames[frame.index] ?? {};
    const frameToken = storyboardGraphToken(frame.id);
    const frameNodeId = storyboardGraphUniqueId("frame", frameToken, frame.id, usedNodeIds);
    const uniqueFrameToken = storyboardGraphNodeToken(frameNodeId);
    nodes.push({
      id: frameNodeId,
      type: "frame",
      label: frame.title,
      frameId: frame.id,
      index: frame.index,
      startMs: frame.startMs,
      durationMs: frame.durationMs,
      ...(frame.reviewStatus ? { status: frame.reviewStatus } : {}),
      metadata: {
        endMs: frame.endMs,
        sourceRefCount: frame.sourceRefCount,
        assetRefCount: frame.assetRefCount,
        ...(frame.caption ? { caption: frame.caption } : {}),
        ...(frame.tags.length > 0 ? { tags: frame.tags } : {})
      }
    });
    edges.push({
      id: storyboardGraphUniqueEdgeId(`contains:${scriptToken}:${uniqueFrameToken}`, usedEdgeIds),
      type: "contains_frame",
      from: scriptNodeId,
      to: frameNodeId
    });
    if (previousFrameNodeId && previousFrameToken) {
      edges.push({
        id: storyboardGraphUniqueEdgeId(`sequence:${previousFrameToken}:${uniqueFrameToken}`, usedEdgeIds),
        type: "sequence",
        from: previousFrameNodeId,
        to: frameNodeId
      });
    }
    previousFrameNodeId = frameNodeId;
    previousFrameToken = uniqueFrameToken;

    for (const [index, sourceRef] of storyboardSourceRefs(rawFrame, frame.id).entries()) {
      const sourceNodeId = storyboardGraphUniqueId("source", `${uniqueFrameToken}:${index}`, `${frame.id}:${index}:${sourceRef.type}:${sourceRef.url ?? sourceRef.path ?? sourceRef.title ?? ""}`, usedNodeIds);
      nodes.push({
        id: sourceNodeId,
        type: "source",
        label: sourceRef.title ?? sourceRef.url ?? sourceRef.path ?? sourceRef.type,
        frameId: frame.id,
        ...(sourceRef.url ? { url: sourceRef.url } : {}),
        ...(sourceRef.path ? { path: sourceRef.path } : {}),
        metadata: { sourceType: sourceRef.type }
      });
      edges.push({
        id: storyboardGraphUniqueEdgeId(`references:${uniqueFrameToken}:${index}`, usedEdgeIds),
        type: "references",
        from: frameNodeId,
        to: sourceNodeId
      });
    }

    for (const assetRef of storyboardStringArray(rawFrame.assetRefs)) {
      const assetToken = storyboardGraphToken(assetRef);
      let assetNodeId = assetNodeIds.get(assetRef);
      if (!assetNodeId) {
        assetNodeId = storyboardGraphUniqueId("asset", assetToken, assetRef, usedNodeIds);
        assetNodeIds.set(assetRef, assetNodeId);
        nodes.push({
          id: assetNodeId,
          type: "asset",
          label: assetRef,
          frameId: frame.id,
          ref: assetRef
        });
      }
      const assetNodeToken = storyboardGraphNodeToken(assetNodeId);
      edges.push({
        id: storyboardGraphUniqueEdgeId(`uses-asset:${uniqueFrameToken}:${assetNodeToken}`, usedEdgeIds),
        type: "uses_asset",
        from: frameNodeId,
        to: assetNodeId
      });
    }

    if (frame.templateId) {
      const templateToken = storyboardGraphToken(frame.templateId);
      const templateMetadata = objectRecord(rawFrame.template);
      let templateNodeId = templateNodeIds.get(frame.templateId);
      if (!templateNodeId) {
        templateNodeId = storyboardGraphUniqueId("template", templateToken, frame.templateId, usedNodeIds);
        templateNodeIds.set(frame.templateId, templateNodeId);
        nodes.push({
          id: templateNodeId,
          type: "template",
          label: frame.templateId,
          frameId: frame.id,
          ...(templateMetadata ? { metadata: templateMetadata } : {})
        });
      }
      const templateNodeToken = storyboardGraphNodeToken(templateNodeId);
      edges.push({
        id: storyboardGraphUniqueEdgeId(`uses-template:${uniqueFrameToken}:${templateNodeToken}`, usedEdgeIds),
        type: "uses_template",
        from: frameNodeId,
        to: templateNodeId
      });
    }

    if (frame.engineId) {
      const engineToken = storyboardGraphToken(frame.engineId);
      const engineMetadata = objectRecord(rawFrame.engine);
      let engineNodeId = engineNodeIds.get(frame.engineId);
      if (!engineNodeId) {
        engineNodeId = storyboardGraphUniqueId("engine", engineToken, frame.engineId, usedNodeIds);
        engineNodeIds.set(frame.engineId, engineNodeId);
        nodes.push({
          id: engineNodeId,
          type: "engine",
          label: frame.engineId,
          frameId: frame.id,
          ...(engineMetadata ? { metadata: engineMetadata } : {})
        });
      }
      const engineNodeToken = storyboardGraphNodeToken(engineNodeId);
      edges.push({
        id: storyboardGraphUniqueEdgeId(`uses-engine:${uniqueFrameToken}:${engineNodeToken}`, usedEdgeIds),
        type: "uses_engine",
        from: frameNodeId,
        to: engineNodeId
      });
    }
  }

  if (panel.review) {
    const reviewStatus = storyboardString(panel.review, "status") ?? (panel.review.required === true ? "needs-review" : "unknown");
    const reviewNodeId = storyboardGraphUniqueId("review", scriptToken, panel.scriptId, usedNodeIds);
    nodes.push({
      id: reviewNodeId,
      type: "review",
      label: "Storyboard Review",
      status: reviewStatus,
      metadata: panel.review
    });
    edges.push({
      id: storyboardGraphUniqueEdgeId(`needs-review:${scriptToken}`, usedEdgeIds),
      type: "needs_review",
      from: scriptNodeId,
      to: reviewNodeId
    });
  }

  const followupArgs = scriptPath ? { scriptPath } : { script };
  const reviewNodes = nodes.filter((node) => node.type === "review").length;
  return {
    ...(scriptPath ? { scriptPath } : {}),
    scriptId: panel.scriptId,
    name: panel.name,
    workflow: panel.workflow,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      frames: panel.counts.frames,
      sourceRefs: panel.counts.sourceRefs,
      assetRefs: panel.counts.assetRefs,
      templateHints: panel.counts.templateHints,
      engineHints: panel.counts.engineHints,
      reviewNodes
    },
    nodes,
    edges,
    readiness: panel.readiness,
    suggestedActions: [
      { id: "review", command: "motion.storyboard.panel", args: followupArgs },
      { id: "compile", command: "motion.script.compile", args: followupArgs },
      { id: "send-to-cut", command: "motion.connector.script_to_cut", args: followupArgs }
    ],
    warnings: panel.warnings
  };
}

function storyboardFrameRecords(script: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(script.frames)
    ? script.frames.map(objectRecord).filter((frame): frame is Record<string, unknown> => frame !== null)
    : [];
}

function storyboardSourceRefs(frame: Record<string, unknown>, frameId: string): StoryboardPanelSourceRef[] {
  if (!Array.isArray(frame.sourceRefs)) return [];
  return frame.sourceRefs.flatMap((value): StoryboardPanelSourceRef[] => {
    const ref = objectRecord(value);
    const type = typeof ref?.type === "string" && ref.type.trim() ? ref.type.trim() : "";
    if (!ref || !type) return [];
    return [{
      frameId,
      type,
      ...(typeof ref.title === "string" && ref.title.trim() ? { title: ref.title.trim() } : {}),
      ...(typeof ref.url === "string" && ref.url.trim() ? { url: ref.url.trim() } : {}),
      ...(typeof ref.path === "string" && ref.path.trim() ? { path: ref.path.trim() } : {})
    }];
  });
}

function buildStoryboardReadiness(
  _script: Record<string, unknown>,
  review: Record<string, unknown> | undefined,
  frames: StoryboardPanelFrame[],
  _sourceRefCount: number
): StoryboardReadiness {
  const diagnostics: StoryboardReadinessDiagnostic[] = [];

  if (review?.required === true) {
    diagnostics.push({
      id: "storyboard:review-required",
      severity: "warning",
      code: "review-required",
      message: "Storyboard review is required before compile or Cut handoff.",
      fix: "Open motion.storyboard.panel, review source-backed frame copy and timing, then mark the storyboard approved in the source script."
    });
  }

  for (const frame of frames) {
    if (frame.reviewStatus !== "needs-review") continue;
    if (!frame.templateId) {
      diagnostics.push({
        id: `frame:${storyboardGraphToken(frame.id)}:missing-template-hint`,
        severity: "warning",
        code: "missing-template-hint",
        frameId: frame.id,
        message: `Frame "${frame.id}" is marked needs-review but has no template hint.`,
        fix: "Choose a template through motion.template.plan or add a frame.template hint before compile or Cut handoff."
      });
    }
    if (!frame.engineId) {
      diagnostics.push({
        id: `frame:${storyboardGraphToken(frame.id)}:missing-engine-hint`,
        severity: "warning",
        code: "missing-engine-hint",
        frameId: frame.id,
        message: `Frame "${frame.id}" is marked needs-review but has no engine hint.`,
        fix: "Add a frame.engine hint that records the intended Motion renderer lane."
      });
    }
  }

  const counts = {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    infos: diagnostics.filter((diagnostic) => diagnostic.severity === "info").length
  };
  const status: StoryboardReadinessStatus = counts.errors > 0
    ? "blocked"
    : diagnostics.length > 0
      ? "needs-review"
      : "ready";

  return {
    status,
    canCompile: status === "ready",
    canSendToCut: status === "ready",
    reviewRequired: review?.required === true,
    counts,
    diagnostics
  };
}

function storyboardPanelWarnings(script: Record<string, unknown>, review: Record<string, unknown> | undefined, sourceRefCount: number, readiness: StoryboardReadiness): string[] {
  const warnings: string[] = [];
  if (review?.required === true) warnings.push("Storyboard review is required before compile or Cut handoff.");
  const workflow = storyboardString(script, "workflow");
  const intent = storyboardString(script, "intent");
  if ((workflow === "source-to-scripted-video" || intent === "source_to_storyboard") && sourceRefCount === 0) {
    warnings.push("Source-derived storyboard has no source references.");
  }
  const nonReviewCodes = readiness.diagnostics
    .map((diagnostic) => diagnostic.code)
    .filter((code) => code !== "review-required");
  if (readiness.status === "blocked") {
    const errorCodes = readiness.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.code);
    warnings.push(`Storyboard readiness blocked: ${uniqueStrings(errorCodes).join(", ")}.`);
  } else if (nonReviewCodes.length > 0) {
    warnings.push(`Storyboard readiness requires review: ${uniqueStrings(readiness.diagnostics.map((diagnostic) => diagnostic.code)).join(", ")}.`);
  }
  return warnings;
}

function storyboardString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function storyboardNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function storyboardStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function storyboardHintId(frame: Record<string, unknown>, key: "template" | "engine"): string | undefined {
  const hint = objectRecord(frame[key]);
  return typeof hint?.id === "string" && hint.id.trim().length > 0 ? hint.id.trim() : undefined;
}

function storyboardBodyPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function storyboardGraphToken(value: string): string {
  return safeFileToken(value).replace(/[._]+/g, "-") || "node";
}

function storyboardGraphUniqueId(namespace: string, token: string, originalValue: string, usedIds: Set<string>): string {
  const baseId = `${namespace}:${token}`;
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  const hash = hashBuffer(Buffer.from(originalValue, "utf8")).slice(0, 8);
  let candidate = `${baseId}-${hash}`;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${hash}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function storyboardGraphUniqueEdgeId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  const hash = hashBuffer(Buffer.from(baseId, "utf8")).slice(0, 8);
  let candidate = `${baseId}-${hash}`;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${hash}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function storyboardGraphNodeToken(nodeId: string): string {
  const marker = nodeId.indexOf(":");
  return marker >= 0 ? nodeId.slice(marker + 1) : nodeId;
}

function isMediaPanelLayer(layer: MotionLayer): boolean {
  return layer.type === "image" || layer.type === "video" || layer.type === "audio" || layer.type === "web";
}

function mediaPanelLayerRow(pkg: MotionPackage, layer: MotionLayer): MediaPanelLayer {
  const source = mediaPanelLayerSource(pkg, layer);
  const warnings = mediaPanelLayerWarnings(source);
  const readiness: MediaPanelReadiness = source.sourceKind === "missing" || source.sourceKind === "no-source"
    ? "missing"
    : warnings.length > 0
      ? "warning"
      : "ready";
  const allowedOrigins = readStringArray(layer.allowedOrigins);
  return {
    id: layer.id,
    type: layer.type,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    sourceKind: source.sourceKind,
    readiness,
    warnings,
    ...(typeof layer.name === "string" ? { name: layer.name } : {}),
    ...(typeof layer.trackId === "string" ? { trackId: layer.trackId } : {}),
    ...(source.source ? { source: source.source } : {}),
    ...(source.sourceField ? { sourceField: source.sourceField } : {}),
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
    ...(typeof source.exists === "boolean" ? { exists: source.exists } : {}),
    ...(typeof source.declaredAsset === "boolean" ? { declaredAsset: source.declaredAsset } : {}),
    ...(typeof layer.assetId === "string" ? { assetId: layer.assetId } : {}),
    ...(typeof layer.assetRef === "string" ? { assetRef: layer.assetRef } : {}),
    ...(mediaPanelLayerTrim(layer) ? { trim: mediaPanelLayerTrim(layer) } : {}),
    ...(typeof layer.loop === "boolean" ? { loop: layer.loop } : {}),
    ...(typeof layer.playbackRate === "number" ? { playbackRate: layer.playbackRate } : {}),
    ...(typeof layer.includeAudio === "boolean" ? { includeAudio: layer.includeAudio } : {}),
    ...(typeof layer.volume === "number" ? { volume: layer.volume } : {}),
    ...(typeof layer.pan === "number" ? { pan: layer.pan } : {}),
    ...(typeof layer.muted === "boolean" ? { muted: layer.muted } : {}),
    ...(typeof layer.fadeInMs === "number" ? { fadeInMs: layer.fadeInMs } : {}),
    ...(typeof layer.fadeOutMs === "number" ? { fadeOutMs: layer.fadeOutMs } : {}),
    ...(typeof layer.fit === "string" ? { fit: layer.fit } : {}),
    ...(layer.crop ? { crop: layer.crop } : {}),
    ...(layer.type === "web" ? {
      web: {
        allowedOriginCount: allowedOrigins?.length ?? 0,
        ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {})
      }
    } : {})
  };
}

function mediaPanelLayerTrim(layer: MotionLayer): { startMs?: number; durationMs?: number } | undefined {
  if (typeof layer.trimStartMs !== "number" && typeof layer.trimDurationMs !== "number") return undefined;
  return {
    ...(typeof layer.trimStartMs === "number" ? { startMs: layer.trimStartMs } : {}),
    ...(typeof layer.trimDurationMs === "number" ? { durationMs: layer.trimDurationMs } : {})
  };
}

function mediaPanelLayerWarnings(source: ReturnType<typeof mediaPanelLayerSource>): string[] {
  if (source.sourceKind === "no-source") return ["Media layer has no source reference."];
  if (source.sourceKind === "remote" && source.source) return [`Remote media source cannot be locally verified: ${source.source}`];
  if (source.sourceKind === "missing" && source.source) return [`Local media source is missing: ${source.source}`];
  return [];
}

function mediaPanelLayerSource(pkg: MotionPackage, layer: MotionLayer): {
  sourceKind: MediaPanelSourceKind;
  source?: string;
  sourceField?: MediaPanelSourceField;
  sourcePath?: string;
  exists?: boolean;
  declaredAsset?: boolean;
} {
  const ref = mediaPanelLayerSourceRef(pkg, layer);
  if (!ref) return { sourceKind: "no-source" };
  const declaredAsset = mediaPanelDeclaredAsset(pkg, ref.source);
  if (isExternalAssetRef(ref.source)) {
    return {
      sourceKind: "remote",
      source: ref.source,
      sourceField: ref.field,
      declaredAsset
    };
  }
  try {
    const sourcePath = resolvePackageAsset(pkg, ref.source);
    const exists = existsSync(sourcePath);
    return {
      sourceKind: exists ? "package" : "missing",
      source: ref.source,
      sourceField: ref.field,
      sourcePath,
      exists,
      declaredAsset
    };
  } catch {
    return {
      sourceKind: "missing",
      source: ref.source,
      sourceField: ref.field,
      exists: false,
      declaredAsset
    };
  }
}

function mediaPanelLayerSourceRef(pkg: MotionPackage, layer: MotionLayer): { source: string; field: MediaPanelSourceField } | null {
  for (const field of ["assetRef", "source", "src"] as const) {
    const value = layer[field];
    if (typeof value === "string" && value.trim().length > 0) return { source: value.trim(), field };
  }
  if (typeof layer.assetId !== "string" || layer.assetId.trim().length === 0) return null;
  const assetId = layer.assetId.trim();
  for (const asset of pkg.motion.assets) {
    const record = objectRecord(asset);
    if (!record || record.id !== assetId) continue;
    const ref = motionAssetRef(record);
    if (ref) return { source: ref, field: "assetId" };
  }
  return { source: assetId, field: "assetId" };
}

function mediaPanelDeclaredAsset(pkg: MotionPackage, ref: string): boolean {
  if (pkg.manifest.assets.includes(ref)) return true;
  return pkg.motion.assets.some((asset) => {
    const record = objectRecord(asset);
    return record ? motionAssetRef(record) === ref : false;
  });
}

function mediaPanelPreset(preset: MotionExportPreset, warnings: string[]): MediaPanelPreset {
  const spec = resolveMotionExportPreset(preset);
  return {
    preset,
    label: spec.label,
    supportsAudio: spec.supportsAudio,
    supportsAlpha: spec.supportsAlpha,
    warnings
  };
}

function mediaPanelPresetWarnings(preset: MotionExportPreset, audioLayers: number, includeAudioLayers: number): string[] {
  const spec = resolveMotionExportPreset(preset);
  if (spec.supportsAudio || (audioLayers === 0 && includeAudioLayers === 0)) return [];
  return [`Export preset ${preset} does not support audio; video layer audio and audio layers will be dropped.`];
}

function mediaPanelSuggestedActions(packageRoot: string, preset: MotionExportPreset | undefined): MediaPanelSuggestedAction[] {
  const presetArg = preset ? { preset } : {};
  return [
    { id: "assets", command: "motion.assets.panel", args: { packageRoot } },
    { id: "audio", command: "motion.audio.panel", args: { packageRoot, ...presetArg } },
    { id: "exportPlan", command: "motion.export.plan", args: { packageRoot, ...presetArg } },
    { id: "preview", command: "motion.preview.panel", args: { packageRoot } },
    { id: "setMedia", command: "motion.timeline.layer.media.set", args: { packageRoot } }
  ];
}

function isAudioPanelLayer(layer: MotionLayer): boolean {
  return layer.type === "audio" || (layer.type === "video" && layer.includeAudio === true);
}

function audioPanelTrackRow(track: MotionTrack): AudioPanelTrack {
  return {
    id: track.id,
    type: track.type,
    ...(typeof track.name === "string" ? { name: track.name } : {}),
    muted: track.muted === true,
    solo: track.solo === true,
    layerIds: Array.isArray(track.layerIds) ? [...track.layerIds] : [],
    ...(typeof track.volume === "number" ? { volume: track.volume } : {}),
    ...(typeof track.pan === "number" ? { pan: track.pan } : {}),
    ...(typeof track.fadeInMs === "number" ? { fadeInMs: track.fadeInMs } : {}),
    ...(typeof track.fadeOutMs === "number" ? { fadeOutMs: track.fadeOutMs } : {})
  };
}

function audioPanelInputRow(
  pkg: MotionPackage,
  layers: MotionLayer[],
  input: FfmpegAudioInput,
  index: number,
  usedLayerIds: Set<string>
): AudioPanelInput {
  const layer = audioPanelLayerForInput(pkg, layers, input, usedLayerIds);
  if (layer) usedLayerIds.add(layer.id);
  return {
    index,
    path: input.path,
    ...(layer ? {
      layerId: layer.id,
      layerType: layer.type,
      ...(typeof layer.trackId === "string" ? { trackId: layer.trackId } : {}),
      ...(audioPanelLayerSourceRef(pkg, layer) ? { source: audioPanelLayerSourceRef(pkg, layer) } : {})
    } : {}),
    ...(typeof input.startMs === "number" ? { startMs: input.startMs } : layer ? { startMs: layer.startMs } : {}),
    ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : layer ? { durationMs: layer.durationMs } : {}),
    ...(typeof input.trimStartMs === "number" ? { trimStartMs: input.trimStartMs } : {}),
    ...(typeof input.trimDurationMs === "number" ? { trimDurationMs: input.trimDurationMs } : {}),
    ...(typeof input.loop === "boolean" ? { loop: input.loop } : {}),
    ...(typeof input.volume === "number" ? { volume: input.volume } : {}),
    ...(typeof input.pan === "number" ? { pan: input.pan } : {}),
    ...(typeof input.muted === "boolean" ? { muted: input.muted } : {}),
    ...(typeof input.fadeInMs === "number" ? { fadeInMs: input.fadeInMs } : {}),
    ...(typeof input.fadeOutMs === "number" ? { fadeOutMs: input.fadeOutMs } : {}),
    ...(typeof input.normalizeLoudness === "boolean" ? { normalizeLoudness: input.normalizeLoudness } : {}),
    ...(typeof input.playbackRate === "number" ? { playbackRate: input.playbackRate } : {}),
    ...(input.ducking ? { ducking: input.ducking } : {}),
    ...audioPanelAutomationCounts(input)
  };
}

/**
 * What the encoder will actually apply from this input's automation tracks, and what it will drop.
 *
 * The panel used to report `volumeKeyframes.length` — the STORED count. The encoder's readers
 * (`audioVolumeAutomationFilter`, `audioPanAutomationFilter`) run the shared
 * `readNumericKeyframes` and refuse the whole track when any entry fails it, so the stored count and
 * the applied count are 0-or-all, never in between. An author looking at this panel to find out why
 * their fade did nothing was told the fade was there.
 *
 * Pan has one extra refusal the panel must respect: a value outside -1..1 makes the encoder drop the
 * whole pan envelope too, so those keyframes are counted as not-applied here for the same reason.
 *
 * @param input one resolved audio input, as the encoder will receive it.
 * @returns the applied counts plus `unreadableAutomationKeyframeCount` when anything is dropped.
 */
function audioPanelAutomationCounts(input: FfmpegAudioInput): {
  volumeAutomationKeyframeCount: number;
  panAutomationKeyframeCount: number;
  unreadableAutomationKeyframeCount?: number;
} {
  const volumeStored = input.volumeKeyframes?.length ?? 0;
  const panStored = input.panKeyframes?.length ?? 0;
  const volumeApplied = readNumericKeyframes(input.volumeKeyframes ?? []) ? volumeStored : 0;
  const panNumeric = readNumericKeyframes(input.panKeyframes ?? []);
  const panApplied = panNumeric && panNumeric.every((keyframe) => keyframe.value >= -1 && keyframe.value <= 1) ? panStored : 0;
  const dropped = (volumeStored - volumeApplied) + (panStored - panApplied);
  return {
    volumeAutomationKeyframeCount: volumeApplied,
    panAutomationKeyframeCount: panApplied,
    ...(dropped > 0 ? { unreadableAutomationKeyframeCount: dropped } : {})
  };
}

/**
 * One warning naming the automation envelopes the encoder will drop.
 *
 * Empty for every package whose automation reads, which is the property that matters: a check that
 * fires on good input is worse than no check.
 *
 * @param inputs the panel's input rows.
 * @param unreadable total automation keyframes across all inputs the encoder will not apply.
 * @returns a single warning, or an empty array.
 */
function audioPanelAutomationWarnings(inputs: AudioPanelInput[], unreadable: number): string[] {
  if (unreadable === 0) return [];
  const affected = inputs.filter((input) => (input.unreadableAutomationKeyframeCount ?? 0) > 0);
  const first = affected[0]!;
  return [
    `${unreadable} audio automation ${unreadable === 1 ? "keyframe" : "keyframes"} on`
    + ` ${affected.length} ${affected.length === 1 ? "input" : "inputs"} cannot be read by the encoder,`
    + ` which drops the WHOLE envelope for a track when any one of its keyframes fails`
    + ` (first: ${first.layerId ? `layer "${first.layerId}"` : `input ${first.index}`}).`
    + " Those inputs encode at a flat volume and pan. A keyframe must be { atMs, value } with a"
    + " finite atMs in milliseconds, and pan values must sit between -1 and 1."
  ];
}

function audioPanelLayerForInput(pkg: MotionPackage, layers: MotionLayer[], input: FfmpegAudioInput, usedLayerIds: Set<string>): MotionLayer | undefined {
  const exact = layers.find((layer) => {
    if (usedLayerIds.has(layer.id)) return false;
    const ref = audioPanelLayerSourceRef(pkg, layer);
    if (!ref) return false;
    if (resolvePackageAsset(pkg, ref) !== input.path) return false;
    return (input.startMs ?? 0) === layer.startMs && (input.durationMs ?? layer.durationMs) === layer.durationMs;
  });
  if (exact) return exact;
  return layers.find((layer) => {
    if (usedLayerIds.has(layer.id)) return false;
    const ref = audioPanelLayerSourceRef(pkg, layer);
    return ref ? resolvePackageAsset(pkg, ref) === input.path : false;
  });
}

function audioPanelLayerSourceRef(pkg: MotionPackage, layer: MotionLayer): string | undefined {
  for (const value of [layer.assetRef, layer.source, layer.src]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (typeof layer.assetId !== "string" || !layer.assetId.trim()) return undefined;
  for (const asset of pkg.motion.assets) {
    const record = objectRecord(asset);
    if (!record || record.id !== layer.assetId.trim()) continue;
    if (typeof record.ref === "string" && record.ref.trim()) return record.ref.trim();
    const source = objectRecord(record.source);
    if (typeof source?.path === "string" && source.path.trim()) return source.path.trim();
  }
  return undefined;
}

function audioPanelPreset(preset: MotionExportPreset, audioInputCount: number, warnings: string[]): AudioPanelPreset {
  const spec = resolveMotionExportPreset(preset);
  return {
    preset,
    label: spec.label,
    supportsAudio: spec.supportsAudio,
    ...(spec.audioCodec ? { audioCodec: spec.audioCodec } : {}),
    willMuxAudio: audioInputCount > 0 && spec.supportsAudio,
    willDropAudio: audioInputCount > 0 && !spec.supportsAudio,
    warnings
  };
}

function audioPanelSuggestedActions(
  packageRoot: string,
  preset: MotionExportPreset | undefined,
  audioInputCount: number,
  audioTracks: MotionTrack[],
  inputs: AudioPanelInput[]
): AudioPanelSuggestedAction[] {
  const firstTrack = audioTracks[0];
  const duckedInput = inputs.find((input) => input.ducking && input.layerId);
  return [
    {
      id: "exportPlan",
      command: "motion.export.plan",
      args: { packageRoot, ...(preset ? { preset } : {}), ...(audioInputCount > 0 ? { needsAudio: true } : {}) }
    },
    { id: "render", command: "motion.render.final", args: { packageRoot, ...(preset ? { preset } : {}) } },
    { id: "timeline", command: "motion.timeline.panel", args: { packageRoot } },
    { id: "inspect", command: "motion.timeline.inspect", args: { packageRoot } },
    ...(firstTrack ? [
      { id: "trackVolume" as const, command: "motion.timeline.track.volume" as const, args: { packageRoot, trackId: firstTrack.id } },
      { id: "trackFade" as const, command: "motion.timeline.track.fade" as const, args: { packageRoot, trackId: firstTrack.id } },
      { id: "trackPan" as const, command: "motion.timeline.track.pan" as const, args: { packageRoot, trackId: firstTrack.id } }
    ] : []),
    ...(duckedInput?.layerId ? [
      { id: "ducking" as const, command: "motion.timeline.layer.ducking.set" as const, args: { packageRoot, layerId: duckedInput.layerId } }
    ] : [])
  ];
}

function buildPreviewPanel(pkg: MotionPackage, controls: Record<string, unknown>, state: TimelineControlState): PreviewPanel {
  const timeline = inspectMotionTimeline(pkg.motion);
  const playheadMs = state.playheadMs;
  const layers = timelinePanelLayerRows(pkg.motion, playheadMs);
  const durationPolicy = readMotionDurationPolicy(pkg.motion).policy;
  const activeLayerIds = layers.filter((layer) => layer.activeAtPlayhead).map((layer) => layer.id);
  const activeSceneIds = previewPanelActiveSceneIds(pkg.motion, playheadMs);
  const activeMarkerIds = previewPanelActiveMarkerIds(pkg.motion, playheadMs);
  return {
    packageRoot: pkg.root,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    ...(typeof pkg.motion.background === "string" ? { background: pkg.motion.background } : {}),
    controls,
    player: {
      playheadMs,
      normalizedProgress: pkg.motion.durationMs > 0 ? Number((playheadMs / pkg.motion.durationMs).toFixed(6)) : 0,
      activeLayerIds,
      activeSceneIds,
      activeMarkerIds,
      ...(state.selectedRange ? { selectedRange: state.selectedRange } : {})
    },
    counts: {
      layers: pkg.motion.layers.length,
      tracks: timeline.trackCount,
      scenes: timeline.sceneCount,
      markers: timeline.markerCount,
      ...timelinePanelKeyframeCounts(pkg.motion),
      audioLayers: pkg.motion.layers.filter((layer) => layer.type === "audio").length,
      videoLayers: pkg.motion.layers.filter((layer) => layer.type === "video").length,
      webLayers: pkg.motion.layers.filter((layer) => layer.type === "web").length,
      safeAreas: Object.keys(pkg.motion.safeAreas ?? {}).length,
      protectedRegions: durationPolicy?.protectedRegions.length ?? 0
    },
    previewModes: [
      { id: "frame", label: "Frame", command: "motion.preview.frame", args: { packageRoot: pkg.root, atMs: playheadMs } },
      { id: "playhead", label: "Playhead", command: "motion.preview.playhead", args: { packageRoot: pkg.root } },
      { id: "strip", label: "Strip", command: "motion.preview.strip", args: { packageRoot: pkg.root } }
    ],
    suggestedActions: [
      { id: "timeline", command: "motion.timeline.panel", args: { packageRoot: pkg.root } },
      { id: "previewFrame", command: "motion.preview.frame", args: { packageRoot: pkg.root, atMs: playheadMs } },
      { id: "previewPlayhead", command: "motion.preview.playhead", args: { packageRoot: pkg.root } },
      { id: "previewStrip", command: "motion.preview.strip", args: { packageRoot: pkg.root } },
      { id: "render", command: "motion.render.final", args: { packageRoot: pkg.root } },
      { id: "exportPanel", command: "motion.export.panel", args: {} },
      { id: "queue", command: "motion.render.queue", args: {} }
    ]
  };
}

function timelinePanelLayerRows(motion: MotionDocument, playheadMs: number): TimelinePanelLayerRow[] {
  return motion.layers.map((layer, index) => {
    const startMs = layer.startMs;
    const durationMs = layer.durationMs;
    const endMs = startMs + durationMs;
    const keyframeTargets = Object.keys(layer.keyframes ?? {}).sort();
    const tally = timelinePanelLayerKeyframeTally(layer);
    return {
      index,
      id: layer.id,
      type: layer.type,
      ...(typeof layer.trackId === "string" ? { trackId: layer.trackId } : {}),
      startMs,
      durationMs,
      endMs,
      activeAtPlayhead: playheadMs >= startMs && playheadMs < endMs,
      ...timelinePanelLayerPreviewRefs(layer),
      sceneIds: timelinePanelLayerSceneIds(motion, layer, startMs, endMs),
      markerIds: timelinePanelLayerMarkerIds(motion, startMs, endMs),
      keyframeTargets,
      ...(tally.unreadable > 0 ? { unreadableKeyframeCount: tally.unreadable } : {}),
      transitionKinds: timelinePanelLayerTransitionKinds(layer)
    };
  });
}

/**
 * How many of a layer's stored keyframes the timeline evaluator will actually read.
 *
 * The timeline and preview panels counted a layer as animated whenever it had any keyframe TARGET,
 * which is a statement about the document's shape, not about whether anything moves. A package whose
 * keyframes are written `{ t, v }` has targets and animates nothing: it reported
 * `keyframedLayers: 5` for a piece frozen end to end. After ca8ee4c a shipped package cannot carry
 * such keyframes, but an in-progress one being authored can — and these panels are precisely what an
 * author opens to find out why nothing moves, so they must count what animates.
 *
 * Same shared predicate as the evaluator, the keyframe panel and the validate refusal, so no two
 * surfaces can disagree about a keyframe.
 *
 * @param layer the layer to tally.
 * @returns readable and unreadable keyframe counts across every stored target.
 */
function timelinePanelLayerKeyframeTally(layer: MotionLayer): { readable: number; unreadable: number } {
  let readable = 0;
  let unreadable = 0;
  for (const frames of Object.values(layer.keyframes ?? {})) {
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (isReadableMotionKeyframe(frame)) readable += 1;
      else unreadable += 1;
    }
  }
  return { readable, unreadable };
}

/**
 * The `counts` fragment both the timeline and the preview panel share for keyframes.
 *
 * One function so the two panels cannot report different numbers for the same package — the drift
 * this repo's one-check pattern exists to remove.
 *
 * @param motion document to inspect.
 * @returns `keyframedLayers` (layers that actually animate) plus `unreadableKeyframes` when any
 *          keyframe is unreadable, omitted entirely otherwise.
 */
function timelinePanelKeyframeCounts(motion: MotionDocument): { keyframedLayers: number; unreadableKeyframes?: number } {
  const tallies = motion.layers.map(timelinePanelLayerKeyframeTally);
  const unreadableKeyframes = tallies.reduce((total, tally) => total + tally.unreadable, 0);
  return {
    keyframedLayers: tallies.filter((tally) => tally.readable > 0).length,
    ...(unreadableKeyframes > 0 ? { unreadableKeyframes } : {})
  };
}

/**
 * One warning naming the keyframes the timeline and preview panels are NOT counting as animation.
 *
 * Aggregated into a single line, and naming the first affected layer, for the reason
 * `timelineKeyframePanelWarnings` gives: the package that exposed this defect had 309 unreadable
 * keyframes and one warning delivers that where 74 would bury it.
 *
 * @param motion document to inspect.
 * @returns a single warning, or an empty array for a package whose every keyframe reads.
 */
function timelinePanelKeyframeWarnings(motion: MotionDocument): string[] {
  const affected = motion.layers
    .map((layer) => ({ layer, tally: timelinePanelLayerKeyframeTally(layer) }))
    .filter((entry) => entry.tally.unreadable > 0);
  if (affected.length === 0) return [];
  const unreadable = affected.reduce((total, entry) => total + entry.tally.unreadable, 0);
  const first = affected[0]!;
  return [
    `${unreadable} ${unreadable === 1 ? "keyframe" : "keyframes"} on`
    + ` ${affected.length} ${affected.length === 1 ? "layer" : "layers"} cannot be read by the timeline`
    + ` evaluator and are not counted as animation here (first: layer "${first.layer.id}").`
    + " A keyframe must be { atMs, value } with a finite atMs in milliseconds."
    + " motion.timeline.keyframes.panel lists every offender by layer and target."
  ];
}

function timelinePanelSafeAreaRows(motion: MotionDocument): TimelinePanelSafeAreaRow[] {
  return Object.entries(motion.safeAreas ?? {})
    .map(([id, area]) => ({
      id,
      ...(typeof area.top === "number" ? { top: area.top } : {}),
      ...(typeof area.right === "number" ? { right: area.right } : {}),
      ...(typeof area.bottom === "number" ? { bottom: area.bottom } : {}),
      ...(typeof area.left === "number" ? { left: area.left } : {})
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function timelinePanelDurationPolicy(policy: DurationPolicy | null): TimelinePanelDurationPolicy | null {
  if (!policy) return null;
  return {
    schema: policy.schema,
    ...(policy.minDurationMs !== undefined ? { minDurationMs: policy.minDurationMs } : {}),
    ...(policy.maxDurationMs !== undefined ? { maxDurationMs: policy.maxDurationMs } : {}),
    ...(policy.resizeMode !== undefined ? { resizeMode: policy.resizeMode } : {}),
    protectedRegions: policy.protectedRegions
      .map((region) => ({
        id: region.id,
        ...(region.label !== undefined ? { label: region.label } : {}),
        ...(region.role !== undefined ? { role: region.role } : {}),
        startMs: region.startMs,
        durationMs: region.durationMs,
        endMs: region.startMs + region.durationMs
      }))
      .sort((left, right) => left.startMs - right.startMs || compareCodeUnits(left.id, right.id))
  };
}

function timelineKeyframeLayerRows(
  motion: MotionDocument,
  options: { layerId?: string; target?: string; includeEmpty?: boolean }
): TimelineKeyframeLayerRow[] {
  return motion.layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => !options.layerId || layer.id === options.layerId)
    .map(({ layer, index }) => {
      const targets = timelineKeyframeTargetRows(layer, options.target);
      const keyframeCount = targets.reduce((total, target) => total + target.keyframeCount, 0);
      return {
        index,
        id: layer.id,
        type: layer.type,
        ...(typeof layer.name === "string" ? { name: layer.name } : {}),
        ...(typeof layer.trackId === "string" ? { trackId: layer.trackId } : {}),
        startMs: layer.startMs,
        durationMs: layer.durationMs,
        endMs: layer.startMs + layer.durationMs,
        locked: layer.locked === true,
        visible: layer.visible !== false,
        keyframeTargetCount: targets.length,
        keyframeCount,
        targets
      };
    })
    .filter((row) => options.includeEmpty || row.keyframeTargetCount > 0);
}

function timelineKeyframeTargetRows(layer: MotionLayer, targetFilter?: string): TimelineKeyframeTargetRow[] {
  const entries = Object.entries(layer.keyframes ?? {})
    .filter(([target]) => !targetFilter || target === targetFilter)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const rows: TimelineKeyframeTargetRow[] = [];
  for (const [target, frames] of entries) {
    if (!Array.isArray(frames) || frames.length === 0) continue;
    // Split readable keyframes from ones the engine will silently ignore BEFORE deriving anything.
    // The previous code mapped every stored entry straight through, which meant a keyframe written
    // with the wrong field names produced `atMs: undefined` — a comparator returning NaN (so the
    // sort became a no-op), non-null assertions on undefined for firstMs/lastMs, and
    // `valueTypes: ["undefined"]`. The panel looked authoritative while describing animation the
    // renderer could never run, which is precisely how an author is misled into believing a piece
    // animates when it does not.
    const readable = frames.filter(isReadableMotionKeyframe);
    const keyframes = readable
      .map((frame) => ({
        atMs: frame.atMs,
        value: frame.value,
        ...(frame.easing ? { easing: frame.easing } : {})
      }))
      .sort((left, right) => left.atMs - right.atMs);
    const malformedKeyframes = frames.length - readable.length;
    rows.push({
      layerId: layer.id,
      target,
      keyframeCount: frames.length,
      ...(keyframes.length > 0
        ? { firstMs: keyframes[0]!.atMs, lastMs: keyframes[keyframes.length - 1]!.atMs }
        : {}),
      easings: sortedUniqueStrings(keyframes.map((frame) => frame.easing).filter((value): value is MotionEasing => value !== undefined).map((value) => easingToken(value))),
      valueTypes: sortedUniqueStrings(keyframes.map((frame) => typeof frame.value)),
      ...(malformedKeyframes > 0 ? { malformedKeyframes } : {}),
      keyframes
    });
  }
  return rows;
}

/**
 * Panel-level warnings. Aggregated into a single line rather than one per target: the package that
 * exposed this defect had 309 unreadable keyframes across 74 targets, and 74 warnings would bury
 * the finding instead of delivering it. The first offender is named so the author has somewhere
 * concrete to look.
 */
function timelineKeyframePanelWarnings(targets: TimelineKeyframeTargetRow[]): string[] {
  const affected = targets.filter((row) => (row.malformedKeyframes ?? 0) > 0);
  if (affected.length === 0) return [];
  const malformed = affected.reduce((total, row) => total + (row.malformedKeyframes ?? 0), 0);
  const total = targets.reduce((count, row) => count + row.keyframeCount, 0);
  const first = affected[0]!;
  return [
    `${malformed} of ${total} keyframes cannot be read by the renderer and will not animate,`
    + ` across ${affected.length} of ${targets.length} ${targets.length === 1 ? "target" : "targets"}`
    + ` (first: layer "${first.layerId}" target "${first.target}").`
    + " A keyframe must be { atMs, value } with finite numbers — entries using other field names are"
    + " dropped by the timeline evaluator. Run motion.package.validate for the exact paths."
  ];
}

function timelineTransitionLayerRows(
  motion: MotionDocument,
  options: { layerId?: string; edge?: "in" | "out"; includeEmpty?: boolean }
): TimelineTransitionLayerRow[] {
  return motion.layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => !options.layerId || layer.id === options.layerId)
    .map(({ layer, index }) => {
      const transitions = timelineTransitionRows(layer, options.edge);
      return {
        index,
        id: layer.id,
        type: layer.type,
        ...(typeof layer.name === "string" ? { name: layer.name } : {}),
        ...(typeof layer.trackId === "string" ? { trackId: layer.trackId } : {}),
        startMs: layer.startMs,
        durationMs: layer.durationMs,
        endMs: layer.startMs + layer.durationMs,
        locked: layer.locked === true,
        visible: layer.visible !== false,
        transitionCount: transitions.length,
        transitions
      };
    })
    .filter((row) => options.includeEmpty || row.transitionCount > 0);
}

function timelineTransitionRows(layer: MotionLayer, edgeFilter?: "in" | "out"): TimelineTransitionRow[] {
  const rows: TimelineTransitionRow[] = [];
  for (const edge of ["in", "out"] as const) {
    if (edgeFilter && edge !== edgeFilter) continue;
    const transition = layer.transitions?.[edge];
    if (!transition) continue;
    const endMs = layer.startMs + layer.durationMs;
    const fromMs = edge === "in" ? layer.startMs : Math.max(layer.startMs, endMs - transition.durationMs);
    const toMs = edge === "in" ? Math.min(endMs, layer.startMs + transition.durationMs) : endMs;
    rows.push({
      key: `${layer.id}:${edge}`,
      layerId: layer.id,
      edge,
      type: transition.type,
      durationMs: transition.durationMs,
      fromMs,
      toMs,
      ...(transition.easing ? { easing: transition.easing } : {}),
      ...(transition.direction ? { direction: transition.direction } : {}),
      ...(typeof transition.distance === "number" ? { distance: transition.distance } : {}),
      transition
    });
  }
  return rows;
}

/**
 * Easing usage across the package — and, separately, the keyframes whose easing will never run.
 *
 * The keyframe panel's twin defect, fixed the same way (fcd41d8 did the panel; this is the other
 * half). This function used to map every stored entry straight through: an entry written with the
 * wrong field names produced `atMs: undefined`, so the comparator returned NaN (leaving the sort
 * order unspecified) and the row advertised an easing on a keyframe the evaluator drops. The easing
 * panel then reported `keyframeUsage: 309` for a package whose 309 keyframes animate nothing —
 * confident-looking introspection describing animation that cannot happen.
 *
 * Unreadable entries are counted, not silently skipped: dropping them from the refs without saying
 * so would swap one misleading number for another.
 *
 * @param motion document to inspect.
 * @returns readable usage refs in target then time order, plus the unreadable count for the warning.
 */
function timelineEasingUsageRefs(motion: MotionDocument): { refs: TimelineEasingUsageEntry[]; unreadableKeyframes: number; unreadableTargets: number } {
  const refs: TimelineEasingUsageEntry[] = [];
  let unreadableKeyframes = 0;
  let unreadableTargets = 0;
  for (const layer of motion.layers) {
    for (const [target, frames] of Object.entries(layer.keyframes ?? {}).sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!Array.isArray(frames)) continue;
      const readable = frames.filter(isReadableMotionKeyframe);
      if (readable.length < frames.length) {
        unreadableKeyframes += frames.length - readable.length;
        unreadableTargets += 1;
      }
      for (const frame of [...readable].sort((left, right) => left.atMs - right.atMs)) {
        refs.push({
          layerId: layer.id,
          target,
          kind: "keyframe",
          atMs: frame.atMs,
          easing: normalizeTimelineEasing(frame.easing)
        });
      }
    }
    for (const edge of ["in", "out"] as const) {
      const transition = layer.transitions?.[edge];
      if (!transition) continue;
      refs.push({
        layerId: layer.id,
        target: edge,
        kind: "transition",
        edge,
        type: transition.type,
        easing: normalizeTimelineEasing(transition.easing)
      });
    }
  }
  return { refs, unreadableKeyframes, unreadableTargets };
}

/**
 * The easing panel's warning, shaped like the keyframe panel's: one aggregated line with the totals
 * and a pointer to where the exact paths are, rather than one warning per offending target.
 */
function timelineEasingPanelWarnings(unreadableKeyframes: number, unreadableTargets: number): string[] {
  if (unreadableKeyframes === 0) return [];
  return [
    `${unreadableKeyframes} keyframes across ${unreadableTargets} ${unreadableTargets === 1 ? "target" : "targets"}`
    + " are excluded from this panel: the timeline evaluator cannot read them, so their easing never runs."
    + " A keyframe must be { atMs, value } with a finite atMs in milliseconds."
    + " Run motion.package.validate for the exact paths."
  ];
}

function normalizeTimelineEasing(easing: MotionEasing | undefined): string {
  return easingToken(easing);
}

/**
 * Map each easing string token used in the package back to a representative
 * easing value, so custom object-form spring easings can be sampled through the
 * real resolver (a `spring(...)` token alone is not a resolvable easing input).
 */
function collectTimelineEasingValues(motion: MotionDocument): Map<string, MotionEasing> {
  const values = new Map<string, MotionEasing>();
  const record = (easing: MotionEasing | undefined): void => {
    if (easing === undefined) return;
    const token = easingToken(easing);
    if (!values.has(token)) values.set(token, easing);
  };
  for (const layer of motion.layers) {
    for (const frames of Object.values(layer.keyframes ?? {})) {
      if (!Array.isArray(frames)) continue;
      for (const frame of frames) record(frame.easing);
    }
    for (const edge of ["in", "out"] as const) record(layer.transitions?.[edge]?.easing);
  }
  return values;
}

function timelineEasingUsageByEasing(refs: TimelineEasingUsageEntry[]): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const ref of refs) usage[ref.easing] = (usage[ref.easing] ?? 0) + 1;
  return usage;
}

function usageRefsForEasing(refs: TimelineEasingUsageEntry[], easing: string): TimelineEasingUsageRef[] {
  return refs
    .filter((ref) => ref.easing === easing)
    .map(({ easing: _easing, ...ref }) => ref);
}

/** Cubic-bezier control points for a string easing, or undefined for spring/other. */
function cubicCurveOfEasing(easing: MotionEasing): [number, number, number, number] | undefined {
  return typeof easing === "string" ? (parseCubicBezierEasing(easing) ?? undefined) : undefined;
}

function sampleTimelineEasing(easing: MotionEasing, sampleCount: number): TimelineEasingSample[] {
  const resolve = resolveEasing(easing);
  return Array.from({ length: sampleCount }, (_, index) => {
    const t = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    return {
      t: roundTimelineSample(t),
      value: roundTimelineSample(resolve(t))
    };
  });
}

function roundTimelineSample(value: number): number {
  return Number(value.toFixed(6));
}

function timelineEasingRecommendations(id: string): string[] {
  if (id === "hold") return ["step changes", "caption swaps", "instant style switches"];
  if (id === "linear") return ["constant speed", "technical movement", "data visualizations"];
  if (id === "ease-in") return ["exits", "fade-outs", "pull-away motion"];
  if (id === "ease-out") return ["entrances", "lower thirds", "UI-style settles"];
  if (id === "ease-in-out") return ["camera moves", "scene pacing", "balanced emphasis"];
  if (id === "back-out") return ["playful entrances", "callouts", "badge pops"];
  if (id === "bounce-out") return ["impact beats", "landing motion", "attention accents"];
  if (id === "smooth") return ["premium UI motion", "soft lower thirds", "slow reveals"];
  if (id === "snappy") return ["fast UI motion", "button-like moves", "quick emphasis"];
  if (id === "step-start" || id === "step-end" || id === "steps-4-end") return ["typewriter beats", "sprite swaps", "discrete state changes"];
  return ["custom animation"];
}

function timelinePanelLayerPreviewRefs(layer: MotionLayer): Partial<TimelinePanelLayerRow> {
  return {
    ...(typeof layer.text === "string" ? { textPreview: layer.text.slice(0, 80) } : {}),
    ...(typeof layer.source === "string" ? { source: layer.source } : {}),
    ...(typeof layer.src === "string" ? { src: layer.src } : {}),
    ...(typeof layer.assetId === "string" ? { assetId: layer.assetId } : {}),
    ...(typeof layer.assetRef === "string" ? { assetRef: layer.assetRef } : {})
  };
}

function timelinePanelLayerSceneIds(motion: MotionDocument, layer: MotionLayer, startMs: number, endMs: number): string[] {
  const trackId = typeof layer.trackId === "string" ? layer.trackId : null;
  return (motion.scenes ?? [])
    .filter((scene) => {
      if (!rangesOverlap(startMs, endMs, scene.startMs, scene.startMs + scene.durationMs)) return false;
      if (!scene.trackIds || scene.trackIds.length === 0) return true;
      return trackId !== null && scene.trackIds.includes(trackId);
    })
    .map((scene) => scene.id);
}

function timelinePanelLayerMarkerIds(motion: MotionDocument, startMs: number, endMs: number): string[] {
  return (motion.markers ?? [])
    .filter((marker) => markerOverlapsTimelineRange(marker.atMs, marker.durationMs, startMs, endMs))
    .map((marker) => marker.id);
}

function previewPanelActiveSceneIds(motion: MotionDocument, playheadMs: number): string[] {
  return (motion.scenes ?? [])
    .filter((scene) => playheadMs >= scene.startMs && playheadMs < scene.startMs + scene.durationMs)
    .map((scene) => scene.id);
}

function previewPanelActiveMarkerIds(motion: MotionDocument, playheadMs: number): string[] {
  return (motion.markers ?? [])
    .filter((marker) => markerOverlapsTimelineRange(marker.atMs, marker.durationMs, playheadMs, playheadMs + 1))
    .map((marker) => marker.id);
}

function markerOverlapsTimelineRange(markerAtMs: number, markerDurationMs: number | undefined, startMs: number, endMs: number): boolean {
  if (typeof markerDurationMs !== "number" || markerDurationMs <= 0) {
    return markerAtMs >= startMs && markerAtMs < endMs;
  }
  return rangesOverlap(markerAtMs, markerAtMs + markerDurationMs, startMs, endMs);
}

function timelinePanelLayerTransitionKinds(layer: MotionLayer): string[] {
  return [
    ...(layer.transitions?.in ? [`in:${layer.transitions.in.type}`] : []),
    ...(layer.transitions?.out ? [`out:${layer.transitions.out.type}`] : [])
  ];
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function sortedUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function exportPresetOutputKind(preset: MotionExportPresetSpec): ExportPresetOutputKind {
  if ("outputKind" in preset) return preset.outputKind;
  return "video";
}

function exportPresetBadges(preset: MotionExportPresetSpec): string[] {
  const badges: string[] = [];
  badges.push(preset.supportsAudio ? "audio" : "no-audio");
  if (preset.supportsAlpha) badges.push("alpha");
  return badges;
}

function exportPresetRecommendations(preset: MotionExportPreset): string[] {
  const recommendations: Record<MotionExportPreset, string[]> = {
    "mp4-h264": ["default", "Canvas MP4", "Cut timeline media"],
    "mp4-hevc": ["high-efficiency delivery", "Apple-compatible HEVC"],
    "webm-av1": ["next-generation web delivery", "high compression efficiency"],
    "webm-vp9": ["web delivery", "compact preview"],
    "webm-vp9-alpha": ["transparent overlay", "web overlay"],
    "gif": ["lightweight animation", "no-audio social preview"],
    "mov-prores": ["transparent mezzanine", "editing interchange"],
    "png-sequence": ["batch frames", "visual regression baseline"],
    "png-frame": ["still preview", "thumbnail"],
    "jpeg-frame": ["compressed thumbnail", "sharing preview"]
  };
  return recommendations[preset];
}

function exportPresetVerification(preset: MotionExportPreset, platform: ExportPresetPlatformVerification): ExportPresetVerification | undefined {
  const requiredCommands = exportPresetRequiredVerificationCommands(preset);
  if (requiredCommands.length === 0) return undefined;

  const requiredHosts = platform.requiredHosts.length > 0 ? platform.requiredHosts : platform.satisfiedHosts;
  const hostReceipts = platform.hostReceipts.map(objectRecord).filter((receipt): receipt is Record<string, unknown> => receipt !== null);
  const failedCommandIds = uniqueStrings(hostReceipts
    .flatMap((receipt) => readLooseStringArray(receipt.failedCommandIds))
    .filter((id) => requiredCommands.includes(id)));
  const missingHosts = uniqueStrings(platform.missingHosts);
  const failedHosts = uniqueStrings(platform.failedHosts);
  const missingCommandHosts = uniqueStrings(requiredHosts.filter((hostId) => {
    if (missingHosts.includes(hostId)) return false;
    const receipt = hostReceipts.find((candidate) => candidate.hostId === hostId);
    if (!receipt) return true;
    const passedCommandIds = readLooseStringArray(receipt.passedCommandIds);
    return requiredCommands.some((commandId) => !passedCommandIds.includes(commandId));
  }));
  const satisfiedHosts = uniqueStrings(hostReceipts
    .filter((receipt) => {
      const hostId = typeof receipt.hostId === "string" ? receipt.hostId : null;
      if (!hostId || missingHosts.includes(hostId) || failedHosts.includes(hostId)) return false;
      const passedCommandIds = readLooseStringArray(receipt.passedCommandIds);
      return requiredCommands.every((commandId) => passedCommandIds.includes(commandId));
    })
    .map((receipt) => receipt.hostId)
    .filter((hostId): hostId is string => typeof hostId === "string"));

  const status: ExportPresetVerificationStatus = platform.status === "missing" || platform.platformReceiptCount === 0
    ? "missing"
    : failedHosts.length > 0 || failedCommandIds.length > 0 || platform.status === "failed"
      ? "failed"
      : missingHosts.length > 0 || missingCommandHosts.length > 0 || platform.status === "partial"
        ? "partial"
        : "passed";

  return {
    status,
    requiredCommands,
    satisfiedHosts,
    missingHosts,
    failedHosts,
    failedCommandIds,
    missingCommandHosts
  };
}

function exportPresetRequiredVerificationCommands(preset: MotionExportPreset): string[] {
  switch (preset) {
    case "mp4-h264":
      return ["render-mp4:smoke"];
    case "mp4-hevc":
      return ["render-hevc:smoke"];
    case "webm-av1":
      return ["render-av1:smoke"];
    case "webm-vp9":
      return ["render-webm:smoke"];
    case "webm-vp9-alpha":
    case "mov-prores":
      return ["render-alpha:smoke"];
    case "gif":
      return ["render-gif:smoke"];
    case "jpeg-frame":
      return ["render-jpeg:smoke"];
    case "png-sequence":
    case "png-frame":
      return [];
    default:
      return unreachableMotionExportPreset(preset);
  }
}

function unreachableMotionExportPreset(preset: never): never {
  throw new Error(`Unhandled export preset: ${String(preset)}.`);
}

function buildTemplatePanel(pkg: MotionPackage): TemplatePanel {
  const controls = listTemplateControls(pkg);
  const controlsByParam = new Map(controls.controls.map((control) => [control.paramId, control]));
  const bindingsByParam = new Map<string, typeof controls.bindings>();
  const warnings: string[] = [];
  for (const binding of controls.bindings) {
    const list = bindingsByParam.get(binding.paramId) ?? [];
    list.push(binding);
    bindingsByParam.set(binding.paramId, list);
  }

  const panelControls = controls.params.map((param): TemplatePanelControl => {
    const control = controlsByParam.get(param.id);
    const bindings = bindingsByParam.get(param.id) ?? [];
    const read = readTemplateBindingValues(pkg.motion, bindings);
    warnings.push(...read.warnings);
    const current = read.current;
    if (bindings.length > 0 && !current.found) {
      warnings.push(`Template param ${param.id} has no readable bound current value.`);
    }
    return {
      paramId: param.id,
      ...(param.label ?? control?.label ? { label: param.label ?? control?.label } : {}),
      type: param.type,
      widget: control?.widget ?? param.type,
      ...(param.group ? { groupId: param.group } : {}),
      ...(typeof param.order === "number" ? { order: param.order } : {}),
      defaultValue: param.defaultValue,
      ...(current.found ? { currentValue: current.value } : {}),
      currentValueFound: current.found,
      bindingCount: bindings.length,
      bindingPaths: bindings.map((binding) => binding.target.path),
      layerIds: [...new Set(bindings.map((binding) => binding.target.layerId).filter((layerId): layerId is string => typeof layerId === "string"))],
      ...(typeof param.min === "number" ? { min: param.min } : {}),
      ...(typeof param.max === "number" ? { max: param.max } : {}),
      ...(typeof param.step === "number" ? { step: param.step } : {}),
      ...(param.options ? { options: param.options } : {}),
      media: param.type === "media" || control?.widget === "media"
    };
  });

  const groups = templatePanelGroups(controls.groups, panelControls);
  const mediaParamCount = panelControls.filter((control) => control.media).length;
  const requiredParams = templateRequiredParams(controls);
  const validation = templatePanelValidation(panelControls, requiredParams);
  const mediaSlots = templatePanelMediaSlots(panelControls, requiredParams, controls.metadata?.mediaSlots ?? []);
  const hostCompatibilityNotes = templateHostCompatibilityNotes(controls.compatibleHosts);
  const suggestedActions: TemplatePanel["suggestedActions"] = [
    { id: "controls", command: "motion.template.controls", args: { packageRoot: pkg.root } },
    { id: "apply", command: "motion.template.apply", args: { packageRoot: pkg.root } },
    ...(mediaParamCount > 0
      ? [{ id: "mediaReplace" as const, command: "motion.template.media.replace" as const, args: { packageRoot: pkg.root } }]
      : []),
    { id: "sendToCut", command: "motion.connector.template_to_cut", args: templateToCutActionArgs(pkg) }
  ];

  return {
    packageRoot: pkg.root,
    packageId: controls.packageId,
    packageName: pkg.manifest.name,
    templateId: controls.templateId,
    templateName: controls.templateName,
    motionId: pkg.motion.id,
    compatibleHosts: controls.compatibleHosts,
    compatibleLanes: controls.compatibleLanes,
    ...(controls.metadata ? { metadata: controls.metadata } : {}),
    ...(controls.metadata?.preview ? { preview: controls.metadata.preview } : {}),
    ...(controls.metadata?.performance?.recommendedLane ? { recommendedLane: controls.metadata.performance.recommendedLane } : {}),
    mediaSlots,
    validation,
    hostCompatibilityNotes,
    groupCount: groups.length,
    paramCount: controls.params.length,
    controlCount: controls.controls.length,
    bindingCount: controls.bindings.length,
    mediaParamCount,
    controlTypes: templateControlTypes(panelControls),
    groups,
    controls: panelControls,
    bindings: controls.bindings,
    warnings,
    suggestedActions
  };
}

function templatePanelMediaSlots(
  controls: TemplatePanelControl[],
  requiredParams: string[],
  guidance: NonNullable<ReturnType<typeof listTemplateControls>["metadata"]>["mediaSlots"]
): TemplatePanelMediaSlot[] {
  const required = new Set(requiredParams);
  return controls
    .filter((control) => control.media)
    .map((control) => {
      const slot = guidance?.find((candidate) => candidate.paramId === control.paramId);
      return {
        paramId: control.paramId,
        ...(control.label ? { label: control.label } : {}),
        required: required.has(control.paramId),
        ...(control.defaultValue !== undefined ? { defaultValue: control.defaultValue } : {}),
        ...(control.currentValue !== undefined ? { currentValue: control.currentValue } : {}),
        acceptedAssetRoot: "assets/",
        ...(slot?.role ? { role: slot.role } : {}),
        ...(slot?.description ? { description: slot.description } : {}),
        ...(slot?.acceptedKinds ? { acceptedKinds: slot.acceptedKinds } : {}),
        ...(slot?.fit ? { fit: slot.fit } : {}),
        ...(slot?.minWidth !== undefined ? { minWidth: slot.minWidth } : {}),
        ...(slot?.minHeight !== undefined ? { minHeight: slot.minHeight } : {}),
        ...(slot?.minDurationMs !== undefined ? { minDurationMs: slot.minDurationMs } : {}),
        ...(slot?.maxDurationMs !== undefined ? { maxDurationMs: slot.maxDurationMs } : {}),
        ...(slot?.rightsRequired !== undefined ? { rightsRequired: slot.rightsRequired } : {})
      };
    });
}

function templatePanelValidation(controls: TemplatePanelControl[], requiredParams: string[]): TemplatePanelValidation {
  const required = new Set(requiredParams);
  const messages: TemplatePanelValidationMessage[] = [];
  const missingRequiredParams: string[] = [];
  let usedDefault = false;
  for (const control of controls) {
    if (!required.has(control.paramId)) continue;
    const hasCurrent = control.currentValueFound && isUsableTemplatePanelValue(control.currentValue);
    const hasDefault = control.defaultValue !== undefined && control.defaultValue !== null && control.defaultValue !== "";
    if (hasCurrent && !isTemplateTokenValue(control.currentValue)) {
      messages.push({ paramId: control.paramId, severity: "info", message: "required value is available from current binding" });
      continue;
    }
    if (hasDefault) {
      usedDefault = true;
      messages.push({ paramId: control.paramId, severity: "info", message: "required value will use template default until user edits it" });
      continue;
    }
    missingRequiredParams.push(control.paramId);
    messages.push({ paramId: control.paramId, severity: "error", message: "required value is missing" });
  }
  return {
    status: missingRequiredParams.length > 0 ? "blocked" : usedDefault ? "ready-with-defaults" : "ready",
    requiredParams,
    missingRequiredParams,
    messages
  };
}

function isUsableTemplatePanelValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function isTemplateTokenValue(value: unknown): boolean {
  return typeof value === "string" && /\{\{[^}]+\}\}/.test(value);
}

function templateHostCompatibilityNotes(hosts: string[]): TemplatePanelHostCompatibilityNote[] {
  return ["shellx-motion", "shellx-cut", "shellx-canvas"].map((host) => {
    const compatible = hosts.length === 0 || hosts.includes(host);
    return {
      host,
      status: compatible ? "compatible" : "not_advertised",
      message: compatible
        ? `Template declares ${host} compatibility.`
        : `Template does not advertise ${host} compatibility yet.`
    };
  });
}

function templateToCutActionArgs(pkg: MotionPackage): { packageRoot: string; outDir: string; values: Record<string, TemplateValue> } {
  const controls = listTemplateControls(pkg);
  const values: Record<string, TemplateValue> = {};
  for (const param of controls.params) {
    const bindings = controls.bindings.filter((binding) => binding.paramId === param.id);
    const read = readTemplateBindingValues(pkg.motion, bindings);
    const value = read.current.found ? read.current.value : param.defaultValue;
    const connectorValue = readTemplateConnectorValue(value);
    if (connectorValue !== undefined) {
      values[param.id] = connectorValue;
    }
  }
  return {
    packageRoot: pkg.root,
    outDir: defaultTemplateToCutOutDir(pkg),
    values
  };
}

function defaultTemplateToCutOutDir(pkg: MotionPackage): string {
  const packageRoot = resolve(pkg.root);
  const idSlug = pkg.manifest.id
    .replace(/^pkg[_-]/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return join(dirname(packageRoot), `${idSlug || basename(packageRoot)}-template-to-cut`);
}

function readTemplateConnectorValue(value: unknown): TemplateValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
    ? value
    : undefined;
}

function templatePanelGroups(groups: ReturnType<typeof listTemplateControls>["groups"], controls: TemplatePanelControl[]): TemplatePanelGroup[] {
  const groupedControls = new Map<string, TemplatePanelControl[]>();
  for (const control of controls) {
    const groupId = control.groupId ?? "ungrouped";
    const list = groupedControls.get(groupId) ?? [];
    list.push(control);
    groupedControls.set(groupId, list);
  }
  const knownGroups = groups.map((group): TemplatePanelGroup => {
    const groupControls = groupedControls.get(group.id) ?? [];
    return {
      id: group.id,
      label: group.label,
      ...(typeof group.order === "number" ? { order: group.order } : {}),
      paramIds: groupControls.map((control) => control.paramId),
      controlCount: groupControls.length
    };
  });
  const unknownGroups = [...groupedControls.entries()]
    .filter(([groupId]) => !groups.some((group) => group.id === groupId))
    .map(([groupId, groupControls]): TemplatePanelGroup => ({
      id: groupId,
      label: groupId === "ungrouped" ? "Ungrouped" : groupId,
      paramIds: groupControls.map((control) => control.paramId),
      controlCount: groupControls.length
    }));
  return [...knownGroups, ...unknownGroups].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || compareCodeUnits(a.label, b.label));
}

function templateControlTypes(controls: TemplatePanelControl[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const control of controls) {
    counts[control.type] = (counts[control.type] ?? 0) + 1;
  }
  return counts;
}

function readTemplateBindingValues(
  motion: MotionDocument,
  bindings: ReturnType<typeof listTemplateControls>["bindings"]
): { current: { found: boolean; value?: unknown }; warnings: string[] } {
  const warnings: string[] = [];
  let current: { found: boolean; value?: unknown } = { found: false };
  for (const binding of bindings) {
    if (binding.target.kind !== "motion_path") {
      warnings.push(`Template binding ${binding.paramId} target kind ${binding.target.kind} was not read by panel.`);
      continue;
    }
    const read = readTemplateBindingValue(motion, binding.target.path);
    if (read.found) {
      if (!current.found) current = { found: true, value: read.value };
      continue;
    }
    warnings.push(`Template binding ${binding.paramId} target ${binding.target.path} was not read: ${read.message}`);
  }
  return { current, warnings };
}

function readTemplateBindingValue(root: unknown, path: string): TemplateBindingRead {
  try {
    const current = readJsonPointerValue(root, path);
    if (current.found) return { found: true, value: current.value };
    return { found: false, message: "path is missing" };
  } catch (error) {
    return { found: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonPointerValue(root: unknown, path: string): { found: boolean; value?: unknown } {
  const tokens = jsonPointerTokens(path);
  let cursor = root;
  for (const token of tokens) {
    if (Array.isArray(cursor)) {
      if (!numericPointerToken(token)) return { found: false };
      const index = Number(token);
      if (index >= cursor.length) return { found: false };
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor) || !Reflect.has(cursor, token)) {
      return { found: false };
    }
    cursor = Reflect.get(cursor, token);
  }
  return { found: true, value: cloneJsonValue(cursor) };
}

async function buildPackageBrowser(roots: string[]): Promise<PackageBrowser> {
  const packageRoots = await discoverMotionPackageRoots(roots);
  const packages: PackageBrowserCard[] = [];
  const warnings: string[] = [];
  for (const packageRoot of packageRoots) {
    try {
      packages.push(packageBrowserCard(await loadMotionPackage(packageRoot), packageRoot));
    } catch (error) {
      warnings.push(`Broken package was skipped at ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  packages.sort((a, b) => compareCodeUnits(a.packageName, b.packageName) || compareCodeUnits(a.packageRoot, b.packageRoot));
  return {
    roots,
    packageCount: packages.length,
    templateCount: packages.filter((pkg) => pkg.hasTemplate).length,
    assetCount: packages.reduce((sum, pkg) => sum + pkg.assetCount, 0),
    packages,
    warnings
  };
}

function packageBrowserCard(pkg: MotionPackage, packageRoot: string): PackageBrowserCard {
  const controls = pkg.template ? listTemplateControls(pkg) : null;
  const designTokens = objectRecord(pkg.motion.designTokens);
  const suggestedActions: PackageBrowserSuggestedAction[] = [
    { id: "inspect", command: "motion.timeline.inspect", args: { packageRoot } },
    { id: "preview", command: "motion.preview.playhead", args: { packageRoot } },
    { id: "render", command: "motion.render.final", args: { packageRoot } },
    { id: "assets", command: "motion.assets.panel", args: { packageRoot } },
    { id: "brand", command: "motion.brand.panel", args: { packageRoot } }
  ];
  if (controls) {
    suggestedActions.push({ id: "templateControls", command: "motion.template.controls", args: { packageRoot } });
  }
  return {
    packageRoot,
    packageId: pkg.manifest.id,
    packageName: pkg.manifest.name,
    sourceApp: pkg.manifest.sourceApp,
    compatibleHosts: pkg.manifest.compatibility.hosts,
    compatibleLanes: pkg.manifest.compatibility.lanes,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    layerCount: pkg.motion.layers.length,
    assetCount: pkg.manifest.assets.length,
    motionAssetCount: pkg.motion.assets.length,
    sceneCount: pkg.motion.scenes?.length ?? 0,
    trackCount: pkg.motion.tracks?.length ?? 0,
    markerCount: pkg.motion.markers?.length ?? 0,
    designTokenGroupCount: designTokens ? Object.keys(designTokens).length : 0,
    hasTemplate: controls !== null,
    ...(controls ? {
      templateId: controls.templateId,
      templateName: controls.templateName,
      controlCount: controls.controls.length
    } : {}),
    provenance: {
      ...pkg.motion.provenance,
      ...(pkg.motion.provenance.selectedFrameId === undefined && pkg.manifest.selectedFrameId !== undefined
        ? { selectedFrameId: pkg.manifest.selectedFrameId }
        : {})
    },
    suggestedActions
  };
}

async function buildTemplateCatalog(roots: string[], target?: TemplateCatalogTarget, filters?: TemplateCatalogFilters): Promise<TemplateCatalog> {
  const packageRoots = await discoverMotionPackageRoots(roots);
  const templates: TemplateCatalogCard[] = [];
  const warnings: string[] = [];
  for (const packageRoot of packageRoots) {
    try {
      const pkg = await loadMotionPackage(packageRoot);
      if (!pkg.template) continue;
      const controls = listTemplateControls(pkg);
      const rights = templateRightsSummary(controls.metadata?.license);
      const performance = templatePerformanceSummary(controls.metadata?.performance, target);
      const targetFit = target ? scoreTemplateTargetFit(controls, target) : undefined;
      const requirements = templateRequirementSummary(pkg, controls);
      const outputTypes = templateOutputTypes(controls);
      const { families: designFamilies, exact: designFamiliesExact } = templateDesignFamilyMembership(controls);
      const filterFit = filters ? scoreTemplateFilterFit({
        controls,
        rights,
        performance,
        requirements,
        outputTypes,
        designFamilies,
        filters
      }) : undefined;
      templates.push({
        packageRoot,
        packageId: pkg.manifest.id,
        packageName: pkg.manifest.name,
        templateId: controls.templateId,
        templateName: controls.templateName,
        compatibleHosts: controls.compatibleHosts,
        compatibleLanes: controls.compatibleLanes,
        ...(controls.metadata ? { metadata: controls.metadata } : {}),
        ...(controls.metadata?.preview ? { preview: controls.metadata.preview } : {}),
        outputTypes,
        requirements,
        designFamilies,
        designFamiliesExact,
        rights,
        performance,
        groupCount: controls.groups.length,
        paramCount: controls.params.length,
        controlCount: controls.controls.length,
        bindingCount: controls.bindings.length,
        controlTypes: countTemplateParamTypes(controls.params),
        ...(targetFit ? { targetFit } : {}),
        ...(filterFit ? { filterFit } : {}),
        suggestedActions: [
          { id: "controls", command: "motion.template.controls", args: { packageRoot } },
          { id: "apply", command: "motion.template.apply", args: { packageRoot } },
          { id: "sendToCut", command: "motion.connector.template_to_cut", args: templateToCutActionArgs(pkg) }
        ]
      });
    } catch (error) {
      warnings.push(`Template package was skipped at ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  templates.sort((a, b) => {
    const filterDelta = filters ? (b.filterFit?.score ?? 0) - (a.filterFit?.score ?? 0) : 0;
    const scoreDelta = target ? (b.targetFit?.score ?? 0) - (a.targetFit?.score ?? 0) : 0;
    // Family-ranking tiebreak (the template-family ranking rule): when a
    // designFamily filter is active and two templates are otherwise tied on
    // filter/target score, a template that is an EXACT member of the requested
    // family (its name or a bestFor hint literally spells out the family id) must
    // outrank one that only joined the family via the name-pattern regex in
    // templateDesignFamilyMembership. Placement is deliberate: this comparison
    // sits AFTER the score deltas -- so a genuinely better-scoring regex-derived
    // template still wins, exactness never rescues a worse candidate -- and
    // BEFORE the alphabetical templateName tiebreak, so exact-vs-derived is
    // settled by relevance rather than by name order. Regex-derived membership is
    // preserved in `designFamilies`; only the recommendation ranking changes.
    const exactFamilyDelta = filters?.designFamily
      ? designFamilyExactRank(b, filters.designFamily) - designFamilyExactRank(a, filters.designFamily)
      : 0;
    // Code-unit order, not localeCompare: this tie-break decides which template the catalog
    // RECOMMENDS, so under a locale-sensitive comparator two hosts with the same packages could
    // hand an agent different templates. That is behaviour drift, not just hash drift.
    return filterDelta || scoreDelta || exactFamilyDelta || compareCodeUnits(a.templateName, b.templateName) || compareCodeUnits(a.packageRoot, b.packageRoot);
  });
  const recommendedTemplate = target || filters
    ? templates.find((template) => template.targetFit?.ok !== false && template.filterFit?.ok !== false)
    : undefined;
  return {
    roots,
    packageCount: new Set(templates.map((template) => template.packageId)).size,
    templateCount: templates.length,
    ...(target ? { target, compatibleTemplateCount: templates.filter((template) => template.targetFit?.ok).length } : {}),
    ...(filters ? { filters, filteredTemplateCount: templates.filter((template) => template.filterFit?.ok).length } : {}),
    controlCount: templates.reduce((sum, template) => sum + template.controlCount, 0),
    ...(recommendedTemplate ? { recommendedTemplate } : {}),
    templates,
    warnings
  };
}

async function buildTemplatePlan(request: string, catalog: TemplateCatalog, providedValues: Record<string, TemplateValue> = {}): Promise<TemplatePlan | null> {
  const candidates = await Promise.all(catalog.templates.map(async (template) => {
    const pkg = await loadMotionPackage(template.packageRoot);
    const controls = listTemplateControls(pkg);
    return {
      template,
      pkg,
      controls,
      requestFit: scoreTemplateRequestFit(controls, request)
    };
  }));
  const selectedCandidate = selectTemplatePlanCandidate(candidates, catalog.recommendedTemplate);
  if (!selectedCandidate) return null;
  const selectedTemplate: TemplateCatalogCard = {
    ...selectedCandidate.template,
    requestFit: selectedCandidate.requestFit
  };
  const pkg = selectedCandidate.pkg;
  const controls = selectedCandidate.controls;
  const requiredParams = templateRequiredParams(controls);
  const inputPlan = templatePlanInputReadiness(controls, requiredParams, providedValues);
  const cutArgs = templateToCutActionArgs(pkg);
  return {
    request,
    ...(catalog.target ? { target: catalog.target } : {}),
    catalog: {
      templateCount: catalog.templateCount,
      ...(catalog.compatibleTemplateCount !== undefined ? { compatibleTemplateCount: catalog.compatibleTemplateCount } : {})
    },
    selectedTemplate,
    values: inputPlan.values,
    providedValues: inputPlan.providedValues,
    defaultedValues: inputPlan.defaultedValues,
    requiredParams,
    missingRequiredParams: inputPlan.missingRequiredParams,
    inputReadiness: inputPlan.inputReadiness,
    authoringLoop: buildTemplateAuthoringLoop(pkg, controls),
    suggestedActions: [
      { id: "reviewControls", command: "motion.template.controls", args: { packageRoot: selectedTemplate.packageRoot } },
      { id: "apply", command: "motion.template.apply", args: { packageRoot: selectedTemplate.packageRoot, values: inputPlan.values } },
      { id: "sendToCut", command: "motion.connector.template_to_cut", args: { ...cutArgs, values: inputPlan.values } }
    ]
  };
}

function buildTemplateAuthoringLoop(
  pkg: MotionPackage,
  controls: ReturnType<typeof listTemplateControls>
): TemplatePlanAuthoringLoop {
  const story = controls.metadata?.story ?? null;
  const mediaSlots = controls.metadata?.mediaSlots ?? [];
  const qualityTargets = controls.metadata?.qualityTargets ?? null;
  const fallbackTimes = [0, Math.floor(pkg.motion.durationMs / 2), Math.max(0, pkg.motion.durationMs - 1)];
  const representativeTimes = [...new Set(qualityTargets?.representativeFramesMs ?? fallbackTimes)]
    .filter((atMs) => Number.isFinite(atMs) && atMs >= 0 && atMs <= pkg.motion.durationMs)
    .sort((a, b) => a - b);
  const representativeFrames = representativeTimes.map((atMs): TemplatePlanReviewFrame => {
    const activeBeats = (story?.beats ?? []).filter((beat) => atMs >= beat.startMs && atMs < beat.startMs + beat.durationMs);
    return {
      atMs,
      beatIds: activeBeats.map((beat) => beat.id),
      label: activeBeats.map((beat) => beat.label ?? beat.id).join(" + ") || "Composition review",
      command: "motion.preview.frame",
      args: { packageRoot: pkg.root, atMs }
    };
  });
  return {
    story,
    mediaSlots,
    qualityTargets,
    ...(qualityTargets?.manifest ? { qualityManifestPath: resolvePackageAsset(pkg, qualityTargets.manifest) } : {}),
    representativeFrames,
    gates: [
      { id: "distinctFrames", required: qualityTargets?.minDistinctFrames !== undefined, ...(qualityTargets?.minDistinctFrames !== undefined ? { threshold: qualityTargets.minDistinctFrames } : {}) },
      { id: "blankFrames", required: qualityTargets?.maxBlankFrames !== undefined, ...(qualityTargets?.maxBlankFrames !== undefined ? { threshold: qualityTargets.maxBlankFrames } : {}) },
      { id: "edgePixels", required: qualityTargets?.minEdgePixels !== undefined, ...(qualityTargets?.minEdgePixels !== undefined ? { threshold: qualityTargets.minEdgePixels } : {}) },
      { id: "lumaRange", required: qualityTargets?.minLumaRange !== undefined, ...(qualityTargets?.minLumaRange !== undefined ? { threshold: qualityTargets.minLumaRange } : {}) },
      { id: "textFit", required: qualityTargets?.requireTextFit === true },
      { id: "safeAreas", required: qualityTargets?.requireSafeAreas === true }
    ],
    sequence: [
      { id: "apply", command: "motion.template.apply" },
      { id: "reviewFrames", command: "motion.preview.frame", after: ["apply"], repeatAtMs: representativeTimes },
      { id: "render", command: "motion.render.final", after: ["reviewFrames"] },
      { id: "quality", command: "motion.quality.check", after: ["render"], inputArtifactRole: "rendered_media" },
      { id: "reviseOnFailure", command: "motion.agent.revision.plan", after: ["quality"], inputArtifactRole: "quality_receipt" },
      { id: "handoffCut", command: "motion.connector.template_to_cut", after: ["quality"] }
    ]
  };
}

function selectTemplatePlanCandidate(
  candidates: Array<{
    template: TemplateCatalogCard;
    pkg: MotionPackage;
    controls: ReturnType<typeof listTemplateControls>;
    requestFit: TemplateRequestFit;
  }>,
  recommendedTemplate?: TemplateCatalogCard
): {
  template: TemplateCatalogCard;
  pkg: MotionPackage;
  controls: ReturnType<typeof listTemplateControls>;
  requestFit: TemplateRequestFit;
} | undefined {
  const targetCompatibleCandidates = candidates.filter((candidate) => candidate.template.targetFit?.ok !== false);
  const compatibleRequestMatches = targetCompatibleCandidates
    .filter((candidate) => candidate.requestFit.ok && candidate.requestFit.score > 0)
    .sort(compareTemplatePlanCandidates);
  if (compatibleRequestMatches.length > 0) return compatibleRequestMatches[0];

  const requestMatches = candidates
    .filter((candidate) => candidate.requestFit.ok && candidate.requestFit.score > 0)
    .sort(compareTemplatePlanCandidates);
  if (requestMatches.length > 0) return requestMatches[0];

  if (recommendedTemplate) {
    const recommended = targetCompatibleCandidates.find((candidate) => candidate.template.packageRoot === recommendedTemplate.packageRoot)
      ?? candidates.find((candidate) => candidate.template.packageRoot === recommendedTemplate.packageRoot);
    if (recommended) return recommended;
  }
  if (targetCompatibleCandidates.length > 0) return targetCompatibleCandidates.sort(compareTemplatePlanCandidates)[0];
  return candidates[0];
}

function compareTemplatePlanCandidates(
  a: {
    template: TemplateCatalogCard;
    requestFit: TemplateRequestFit;
  },
  b: {
    template: TemplateCatalogCard;
    requestFit: TemplateRequestFit;
  }
): number {
  const requestScoreDelta = b.requestFit.score - a.requestFit.score;
  const targetScoreDelta = (b.template.targetFit?.score ?? 0) - (a.template.targetFit?.score ?? 0);
  const performanceScoreDelta = templatePerformanceSelectionScore(b.template) - templatePerformanceSelectionScore(a.template);
  // Code-unit order, not localeCompare: same contract as the catalog sort — this comparator
  // picks the auto-selected template for a plan, so locale must not change which one wins.
  return requestScoreDelta || targetScoreDelta || performanceScoreDelta || compareCodeUnits(a.template.templateName, b.template.templateName) || compareCodeUnits(a.template.packageRoot, b.template.packageRoot);
}

function templatePerformanceSelectionScore(template: TemplateCatalogCard): number {
  const performance = template.performance;
  let score = 0;
  if (performance.targetLaneMatchesRecommendation === true) score += 20;
  if (performance.targetLaneMatchesRecommendation === false) score -= 20;
  if (performance.renderCost === "low") score += 3;
  if (performance.renderCost === "medium") score += 1;
  if (performance.renderCost === "high") score -= 1;
  return score;
}

function templatePlanDefaultValues(controls: ReturnType<typeof listTemplateControls>): Record<string, TemplateValue> {
  const values: Record<string, TemplateValue> = {};
  for (const param of controls.params) {
    const value = readTemplateConnectorValue(param.defaultValue);
    if (value !== undefined) values[param.id] = value;
  }
  return values;
}

function templatePlanInputReadiness(
  controls: ReturnType<typeof listTemplateControls>,
  requiredParams: string[],
  providedValues: Record<string, TemplateValue>
): {
  values: Record<string, TemplateValue>;
  providedValues: Record<string, TemplateValue>;
  defaultedValues: Record<string, TemplateValue>;
  missingRequiredParams: string[];
  inputReadiness: TemplatePlanInputReadiness;
} {
  const defaultValues = templatePlanDefaultValues(controls);
  const knownParamIds = new Set(controls.params.map((param) => param.id));
  const requiredParamIds = new Set(requiredParams);
  const acceptedProvidedValues: Record<string, TemplateValue> = {};
  for (const [paramId, value] of Object.entries(providedValues)) {
    if (knownParamIds.has(paramId)) acceptedProvidedValues[paramId] = value;
  }
  const values: Record<string, TemplateValue> = {
    ...defaultValues,
    ...acceptedProvidedValues
  };
  const defaultedValues: Record<string, TemplateValue> = {};
  const params: TemplatePlanInputReadinessParam[] = [];
  for (const param of controls.params) {
    const required = requiredParamIds.has(param.id);
    const hasProvidedValue = hasOwnKey(acceptedProvidedValues, param.id);
    const hasDefaultValue = hasOwnKey(defaultValues, param.id);
    const value = hasProvidedValue ? acceptedProvidedValues[param.id] : hasDefaultValue ? defaultValues[param.id] : undefined;
    const missing = value === undefined || value === null || value === "";
    const source: TemplatePlanInputSource = missing ? "missing" : hasProvidedValue ? "provided" : "default";
    if (source === "default" && value !== undefined) defaultedValues[param.id] = value;
    params.push({
      paramId: param.id,
      ...(param.label ? { label: param.label } : {}),
      type: param.type,
      required,
      source,
      ...(value !== undefined ? { value } : {})
    });
  }
  const missingRequiredParams = params
    .filter((param) => param.required && param.source === "missing")
    .map((param) => param.paramId);
  const requiredDefaulted = params.some((param) => param.required && param.source === "default");
  const status: TemplatePlanInputReadiness["status"] = missingRequiredParams.length > 0
    ? "blocked"
    : requiredDefaulted
      ? "ready-with-defaults"
      : "ready";
  return {
    values,
    providedValues: acceptedProvidedValues,
    defaultedValues,
    missingRequiredParams,
    inputReadiness: {
      status,
      reviewRequired: status !== "ready",
      counts: {
        totalParams: params.length,
        requiredParams: requiredParams.length,
        provided: params.filter((param) => param.source === "provided").length,
        defaulted: params.filter((param) => param.source === "default").length,
        missingRequired: missingRequiredParams.length,
        optionalMissing: params.filter((param) => !param.required && param.source === "missing").length
      },
      params
    }
  };
}

function templateRequiredParams(controls: ReturnType<typeof listTemplateControls>): string[] {
  const inputSchema = objectRecord(controls.metadata?.inputSchema);
  const required = inputSchema?.required;
  return Array.isArray(required)
    ? required.filter((paramId): paramId is string => typeof paramId === "string" && paramId.length > 0)
    : [];
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function scoreTemplateRequestFit(controls: ReturnType<typeof listTemplateControls>, request: string): TemplateRequestFit {
  const requestTokens = normalizedTemplateRequestTokens(request);
  const bestFor = controls.metadata?.suitability?.bestFor ?? [];
  const notFor = controls.metadata?.suitability?.notFor ?? [];
  const matchedBestFor = bestFor.filter((hint) => templateSuitabilityHintMatchesRequest(hint, requestTokens));
  const matchedNotFor = notFor.filter((hint) => templateSuitabilityHintMatchesRequest(hint, requestTokens));
  const reasons = [
    ...matchedBestFor.map((hint) => `request matches best-for ${hint}`),
    ...matchedNotFor.map((hint) => `request matches not-for ${hint}`)
  ];
  return {
    ok: matchedNotFor.length === 0,
    score: Math.max(0, Math.min(100, (matchedBestFor.length * 50) - (matchedNotFor.length * 100))),
    matchedBestFor,
    matchedNotFor,
    reasons
  };
}

function templateSuitabilityHintMatchesRequest(hint: string, requestTokens: Set<string>): boolean {
  const hintTokens = [...normalizedTemplateRequestTokens(hint)];
  return hintTokens.length > 0 && hintTokens.every((token) => requestTokens.has(token));
}

function normalizedTemplateRequestTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(normalizeTemplateRequestToken).filter((token) => token.length > 0));
}

function normalizeTemplateRequestToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 2) return token.slice(0, -1);
  return token;
}

function scoreTemplateTargetFit(controls: ReturnType<typeof listTemplateControls>, target: TemplateCatalogTarget): TemplateTargetFit {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const reasons: string[] = [];
  const outputBounds = controls.metadata?.outputBounds;

  if (target.host) {
    const hostSupported = controls.compatibleHosts.length === 0 || controls.compatibleHosts.includes(target.host);
    recordTemplateFitCheck({
      kind: "host",
      ok: hostSupported,
      matched,
      unmatched,
      reasons,
      passReason: `host ${target.host} supported`,
      failReason: `host ${target.host} unsupported`
    });
  }

  if (target.lane) {
    const laneSupported = controls.compatibleLanes.includes(target.lane);
    recordTemplateFitCheck({
      kind: "lane",
      ok: laneSupported,
      matched,
      unmatched,
      reasons,
      passReason: `lane ${target.lane} supported`,
      failReason: `lane ${target.lane} unsupported`
    });
  }

  if (target.aspectRatio) {
    const aspectRatios = outputBounds?.aspectRatios ?? [];
    const aspectRatioSupported = aspectRatios.length === 0 || aspectRatios.includes(target.aspectRatio);
    recordTemplateFitCheck({
      kind: "aspectRatio",
      ok: aspectRatioSupported,
      matched,
      unmatched,
      reasons,
      passReason: `aspect ratio ${target.aspectRatio} supported`,
      failReason: `aspect ratio ${target.aspectRatio} unsupported`
    });
  }

  if (target.durationMs !== undefined) {
    const durationSupported = isWithinOptionalBounds(target.durationMs, outputBounds?.minDurationMs, outputBounds?.maxDurationMs);
    recordTemplateFitCheck({
      kind: "duration",
      ok: durationSupported,
      matched,
      unmatched,
      reasons,
      passReason: `duration ${target.durationMs}ms within bounds`,
      failReason: `duration ${target.durationMs}ms outside bounds`
    });
  }

  if (target.width !== undefined || target.height !== undefined) {
    const widthSupported = target.width === undefined || isWithinOptionalBounds(target.width, outputBounds?.minWidth, outputBounds?.maxWidth);
    const heightSupported = target.height === undefined || isWithinOptionalBounds(target.height, outputBounds?.minHeight, outputBounds?.maxHeight);
    recordTemplateFitCheck({
      kind: "size",
      ok: widthSupported && heightSupported,
      matched,
      unmatched,
      reasons,
      passReason: `size ${target.width ?? "*"}x${target.height ?? "*"} within bounds`,
      failReason: `size ${target.width ?? "*"}x${target.height ?? "*"} outside bounds`
    });
  }

  if (target.commercialUse === true) {
    const rights = templateRightsSummary(controls.metadata?.license);
    const commercialSupported = rights.commercialUse === true;
    recordTemplateFitCheck({
      kind: "commercialUse",
      ok: commercialSupported,
      matched,
      unmatched,
      reasons,
      passReason: "commercial use declared by template license",
      failReason: rights.commercialUse === false
        ? "commercial use disallowed by template license"
        : "commercial use not declared by template license"
    });
  }

  const requestedCheckCount = matched.length + unmatched.length;
  return {
    ok: unmatched.length === 0,
    score: requestedCheckCount === 0 ? 100 : Math.round((matched.length / requestedCheckCount) * 100),
    matched,
    unmatched,
    reasons
  };
}

function scoreTemplateFilterFit(input: {
  controls: ReturnType<typeof listTemplateControls>;
  rights: TemplateRightsSummary;
  performance: TemplatePerformanceSummary;
  requirements: TemplateRequirementSummary;
  outputTypes: string[];
  designFamilies: string[];
  filters: TemplateCatalogFilters;
}): TemplateFilterFit {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const reasons: string[] = [];
  const filters = input.filters;

  if (filters.host) {
    const ok = input.controls.compatibleHosts.length === 0 || input.controls.compatibleHosts.includes(filters.host);
    recordTemplateFitCheck({
      kind: "host",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: `host ${filters.host} supported`,
      failReason: `host ${filters.host} unsupported`
    });
  }
  if (filters.aspectRatio) {
    const aspectRatios = input.controls.metadata?.outputBounds?.aspectRatios ?? [];
    const ok = aspectRatios.length === 0 || aspectRatios.includes(filters.aspectRatio);
    recordTemplateFitCheck({
      kind: "aspectRatio",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: `aspect ratio ${filters.aspectRatio} supported`,
      failReason: `aspect ratio ${filters.aspectRatio} unsupported`
    });
  }
  if (filters.outputType) {
    const ok = input.outputTypes.includes(filters.outputType);
    recordTemplateFitCheck({
      kind: "outputType",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: `output type ${filters.outputType} supported`,
      failReason: `output type ${filters.outputType} unsupported`
    });
  }
  if (filters.requiresMedia !== undefined) {
    const ok = input.requirements.media === filters.requiresMedia;
    recordTemplateFitCheck({
      kind: "requiresMedia",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: filters.requiresMedia ? "media slot required" : "media slot not required",
      failReason: filters.requiresMedia ? "media slot not required" : "media slot required"
    });
  }
  if (filters.requiresAudio !== undefined) {
    const ok = input.requirements.audio === filters.requiresAudio;
    recordTemplateFitCheck({
      kind: "requiresAudio",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: filters.requiresAudio ? "audio layer required" : "audio layer not required",
      failReason: filters.requiresAudio ? "audio layer not required" : "audio layer required"
    });
  }
  if (filters.commercialUse !== undefined) {
    const ok = filters.commercialUse ? input.rights.commercialUse === true : input.rights.commercialUse !== true;
    recordTemplateFitCheck({
      kind: "commercialUse",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: filters.commercialUse ? "commercial use declared" : "commercial use not required",
      failReason: filters.commercialUse ? "commercial use not declared" : "commercial use declared"
    });
  }
  if (filters.renderCost) {
    const ok = input.performance.renderCost === filters.renderCost;
    recordTemplateFitCheck({
      kind: "renderCost",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: `render cost ${filters.renderCost} matched`,
      failReason: `render cost ${filters.renderCost} not matched`
    });
  }
  if (filters.designFamily) {
    const ok = input.designFamilies.includes(filters.designFamily);
    recordTemplateFitCheck({
      kind: "designFamily",
      ok,
      matched,
      unmatched,
      reasons,
      passReason: `design family ${filters.designFamily} matched`,
      failReason: `design family ${filters.designFamily} not matched`
    });
  }

  const requestedCheckCount = matched.length + unmatched.length;
  return {
    ok: unmatched.length === 0,
    score: requestedCheckCount === 0 ? 100 : Math.round((matched.length / requestedCheckCount) * 100),
    matched,
    unmatched,
    reasons
  };
}

function templateRequirementSummary(pkg: MotionPackage, controls: ReturnType<typeof listTemplateControls>): TemplateRequirementSummary {
  const mediaSlotCount = controls.params.filter((param) => param.type === "media").length;
  const audioLayerCount = pkg.motion.layers.filter((layer) => layer.type === "audio").length;
  return {
    media: mediaSlotCount > 0,
    audio: audioLayerCount > 0,
    generatedAssets: templateUsesGeneratedAssets(pkg, controls),
    mediaSlotCount,
    audioLayerCount
  };
}

function templateUsesGeneratedAssets(pkg: MotionPackage, controls: ReturnType<typeof listTemplateControls>): boolean {
  const generatedBy = controls.metadata?.provenance?.generatedBy;
  if (typeof generatedBy === "string" && generatedBy.length > 0 && generatedBy !== "codex-subscription-cli") return true;
  if ((controls.metadata?.assetsAttribution ?? []).some((asset) => asset.path?.includes("assets/generated/"))) return true;
  return pkg.manifest.assets.some((assetRef) => assetRef.includes("assets/generated/"));
}

function templateOutputTypes(controls: ReturnType<typeof listTemplateControls>): string[] {
  const outputTypes: string[] = [];
  if (controls.compatibleLanes.includes("ffmpeg")) outputTypes.push("video/mp4");
  if (controls.compatibleLanes.includes("browser") || controls.compatibleLanes.includes("native")) outputTypes.push("image/png");
  return [...new Set(outputTypes)];
}

/**
 * Catalog design families for a template, split by HOW each family was matched.
 *
 * Families are inferred from the template's display name plus its suitability
 * `bestFor` hints via the keyword regexes below. That inference is deliberately
 * broad so browsing and filtering surface a useful "related" set -- but it
 * conflates two very different signals:
 *   - EXACT: the name or a bestFor hint literally spells out the family id as a
 *     phrase (hyphens treated as word separators). Example: the name
 *     "ShellX Tutorial Overlay" and the bestFor hint "tutorial overlay" are both
 *     exact members of "tutorial-overlay".
 *   - DERIVED: the family regex only matched an individual keyword that happens
 *     to appear in the name/hints. Example: "ShellX Tracked Callout Overlay"
 *     lands in "tutorial-overlay" solely because its name contains "overlay".
 *
 * `families` returns BOTH kinds (unchanged behaviour -- regex-derived membership
 * stays useful for browsing/filtering). `exact` is the exact-match subset and is
 * always a subset of `families` (a phrase match implies the keyword regex also
 * matched). Recommendation ranking (buildTemplateCatalog) treats exact membership
 * as strictly stronger than derived membership on an otherwise-equal score --
 * the template-family ranking rule.
 */
function templateDesignFamilyMembership(controls: ReturnType<typeof listTemplateControls>): { families: string[]; exact: string[] } {
  const bestFor = controls.metadata?.suitability?.bestFor ?? [];
  const hints = [...bestFor, controls.templateName].join(" ").toLowerCase();
  const families: string[] = [];
  if (/\b(metric|data|report|batch|stat|table|chart)\b/.test(hints)) families.push("data-report");
  if (/\blaunch|saas|release|announcement|bumper\b/.test(hints)) families.push("saas-launch");
  if (/\bmedia|asset|image|hero\b/.test(hints)) families.push("media-rich");
  if (/\baudio|music|narration|sound\b/.test(hints)) families.push("audio-backed");
  if (/\blower third|speaker|caption\b/.test(hints)) families.push("lower-third");
  if (/\btutorial|overlay|walkthrough\b/.test(hints)) families.push("tutorial-overlay");
  if (/\bkinetic|typography|type\b/.test(hints)) families.push("kinetic-type");
  if (/\bsocial|square|vertical\b/.test(hints)) families.push("social");
  const derived = families.length > 0 ? [...new Set(families)] : ["general"];
  // Exactness pass: normalise the name + hints into a single space-delimited
  // token stream and keep only families whose id (its hyphen-separated words)
  // appears verbatim as a phrase. The leading/trailing space padding turns
  // `includes` into a word-boundary phrase test, so "overlay" alone never
  // satisfies the "tutorial overlay" phrase.
  const phraseSource = ` ${normaliseDesignFamilyText([...bestFor, controls.templateName].join(" "))} `;
  const exact = derived.filter((family) => phraseSource.includes(` ${family.replace(/-/g, " ")} `));
  return { families: derived, exact };
}

/** Lowercase and collapse every non-alphanumeric run to a single space, for design-family phrase matching. */
function normaliseDesignFamilyText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** 1 when the card is an EXACT member of `family`, 0 otherwise -- see templateDesignFamilyMembership. */
function designFamilyExactRank(card: TemplateCatalogCard, family: string): number {
  return card.designFamiliesExact.includes(family) ? 1 : 0;
}

function templateRightsSummary(license: TemplateLicense | undefined): TemplateRightsSummary {
  if (!license) {
    return {
      status: "unknown",
      reasons: ["license metadata not declared"]
    };
  }

  const reasons: string[] = [];
  if (license.commercialUse === true) reasons.push("commercial use declared");
  if (license.commercialUse === false) reasons.push("commercial use disallowed");
  if (license.attributionRequired === true) reasons.push("attribution required");
  if (license.redistributionAllowed === true) reasons.push("redistribution allowed");
  if (license.redistributionAllowed === false) reasons.push("redistribution disallowed");

  const status: TemplateRightsSummary["status"] = license.commercialUse === false || license.redistributionAllowed === false
    ? "blocked"
    : license.commercialUse === true && license.redistributionAllowed === true && license.attributionRequired !== true
      ? "ready"
      : license.commercialUse === undefined && license.redistributionAllowed === undefined && license.attributionRequired === undefined
        ? "unknown"
        : "warning";

  return {
    status,
    licenseId: license.id,
    ...(license.label ? { licenseLabel: license.label } : {}),
    ...(license.url ? { licenseUrl: license.url } : {}),
    ...(license.spdxId ? { spdxId: license.spdxId } : {}),
    ...(license.attribution ? { attribution: license.attribution } : {}),
    ...(license.attributionRequired !== undefined ? { attributionRequired: license.attributionRequired } : {}),
    ...(license.redistributionAllowed !== undefined ? { redistributionAllowed: license.redistributionAllowed } : {}),
    ...(license.commercialUse !== undefined ? { commercialUse: license.commercialUse } : {}),
    ...(license.notes ? { notes: license.notes } : {}),
    reasons: reasons.length > 0 ? reasons : ["license rights not declared"]
  };
}

function templatePerformanceSummary(
  performance: TemplatePerformance | undefined,
  target?: TemplateCatalogTarget
): TemplatePerformanceSummary {
  if (!performance) {
    return {
      status: "unknown",
      reasons: ["performance metadata not declared"]
    };
  }

  const reasons: string[] = [];
  const summary: TemplatePerformanceSummary = {
    status: "known",
    ...(performance.recommendedLane ? { recommendedLane: performance.recommendedLane } : {}),
    ...(performance.renderCost ? { renderCost: performance.renderCost } : {}),
    ...(performance.previewFps !== undefined ? { previewFps: performance.previewFps } : {}),
    ...(performance.notes && performance.notes.length > 0 ? { notes: performance.notes } : {}),
    reasons
  };

  if (performance.recommendedLane) reasons.push(`recommended lane ${performance.recommendedLane}`);
  if (performance.renderCost) reasons.push(`render cost ${performance.renderCost}`);
  if (performance.previewFps !== undefined) reasons.push(`preview fps ${performance.previewFps}`);
  if (target?.lane && performance.recommendedLane) {
    const targetLaneMatchesRecommendation = target.lane === performance.recommendedLane;
    summary.targetLaneMatchesRecommendation = targetLaneMatchesRecommendation;
    reasons.push(targetLaneMatchesRecommendation
      ? `target lane ${target.lane} matches recommended lane`
      : `target lane ${target.lane} differs from recommended lane ${performance.recommendedLane}`);
  }

  if (
    summary.recommendedLane === undefined
    && summary.renderCost === undefined
    && summary.previewFps === undefined
    && summary.notes === undefined
  ) {
    summary.status = "unknown";
    reasons.push("performance metadata not declared");
  } else if (reasons.length === 0) {
    reasons.push("performance notes declared");
  }

  return summary;
}

function recordTemplateFitCheck(input: {
  kind: string;
  ok: boolean;
  matched: string[];
  unmatched: string[];
  reasons: string[];
  passReason: string;
  failReason: string;
}): void {
  if (input.ok) {
    input.matched.push(input.kind);
    input.reasons.push(input.passReason);
    return;
  }
  input.unmatched.push(input.kind);
  input.reasons.push(input.failReason);
}

function isWithinOptionalBounds(value: number, min?: number, max?: number): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

function aspectRatioFromDimensions(width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.trunc(Math.abs(left));
  let b = Math.trunc(Math.abs(right));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

async function discoverMotionPackageRoots(roots: string[]): Promise<string[]> {
  const packageRoots = new Set<string>();
  for (const root of roots) {
    if (existsSync(join(root, "manifest.json"))) packageRoots.add(root);
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(root, dirent.name);
      if (existsSync(join(candidate, "manifest.json"))) packageRoots.add(candidate);
    }
  }
  return [...packageRoots].sort();
}

function countTemplateParamTypes(params: Array<{ type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const param of params) {
    counts[param.type] = (counts[param.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Write a receipt to the store, atomically.
 *
 * Same-directory temp write then rename, matching the raw-prompt purge. A plain `writeFile` is
 * observable half-written, and the hardened reader's size/mtime re-checks reject a torn read by
 * returning null — so a concurrent read of a receipt being rewritten made that receipt momentarily
 * *invisible* rather than merely stale. The rename makes every reader see one whole version or the
 * other. It does not make same-id writers order themselves: last rename wins, which is the same
 * semantics `writeFile` had.
 */
async function writeReceiptFile(receiptsRoot: string, receipt: OperationReceipt): Promise<string> {
  await mkdir(receiptsRoot, { recursive: true });
  const receiptPath = join(receiptsRoot, `${safeFileToken(receipt.id)}.receipt.json`);
  const pendingPath = `${receiptPath}.writing-${randomUUID()}`;
  try {
    await writeFile(pendingPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await rename(pendingPath, receiptPath);
  } catch (error) {
    await rm(pendingPath, { force: true }).catch(() => {});
    throw error;
  }
  return receiptPath;
}

interface AssetsPanelAsset {
  ref: string;
  exists: boolean;
  usedByLayerIds: string[];
  sha256?: string;
  sizeBytes?: number;
}

interface AssetsPanelMotionAsset {
  id?: string;
  ref?: string;
  declared: boolean;
  usedByLayerIds: string[];
}

interface AssetsPanelLayerRef {
  layerId: string;
  layerType: string;
  field: "assetRef" | "source" | "src" | "assetId";
  ref: string;
  declared: boolean;
  exists?: boolean;
  external?: boolean;
}

interface AssetsPanelSummary {
  assets: AssetsPanelAsset[];
  motionAssets: AssetsPanelMotionAsset[];
  layerRefs: AssetsPanelLayerRef[];
  missingAssets: string[];
  unusedDeclaredAssets: string[];
}

async function assetsPanelSummary(pkg: MotionPackage): Promise<AssetsPanelSummary> {
  const declaredRefs = [...new Set(pkg.manifest.assets)];
  const declaredSet = new Set(declaredRefs);
  const usageByRef = new Map<string, string[]>();
  const motionAssets = motionAssetPanelSummaries(pkg.motion.assets, declaredSet);
  const motionAssetRefById = new Map(motionAssets.flatMap((asset) => (
    asset.id && asset.ref ? [[asset.id, asset.ref] as const] : []
  )));
  const layerRefs: AssetsPanelLayerRef[] = [];

  for (const layer of pkg.motion.layers) {
    for (const layerRef of readLayerAssetRefs(layer, declaredSet, motionAssetRefById)) {
      layerRefs.push({
        ...layerRef,
        ...await layerAssetRefAvailability(pkg, layerRef.ref)
      });
      addAssetUsage(usageByRef, layerRef.ref, layer.id);
    }
  }

  const assets: AssetsPanelAsset[] = [];
  for (const ref of declaredRefs) {
    assets.push({
      ref,
      ...await packageAssetFacts(pkg, ref),
      usedByLayerIds: usageByRef.get(ref) ?? []
    });
  }

  return {
    assets,
    motionAssets: motionAssets.map((asset) => ({
      ...asset,
      usedByLayerIds: asset.ref && asset.declared ? usageByRef.get(asset.ref) ?? [] : []
    })),
    layerRefs,
    missingAssets: assets.filter((asset) => !asset.exists).map((asset) => asset.ref),
    unusedDeclaredAssets: assets.filter((asset) => asset.usedByLayerIds.length === 0).map((asset) => asset.ref)
  };
}

function motionAssetPanelSummaries(assets: unknown[], declaredSet: Set<string>): AssetsPanelMotionAsset[] {
  return assets.flatMap((asset) => {
    const record = objectRecord(asset);
    if (!record) return [];
    const id = typeof record.id === "string" ? record.id : undefined;
    const ref = motionAssetRef(record);
    return [{
      ...(id ? { id } : {}),
      ...(ref ? { ref } : {}),
      declared: ref ? declaredSet.has(ref) : false,
      usedByLayerIds: []
    }];
  });
}

function motionAssetRef(record: Record<string, unknown>): string | undefined {
  for (const key of ["ref", "assetRef", "source", "src"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    const source = key === "source" ? objectRecord(value) : null;
    if (typeof source?.path === "string" && source.path.length > 0) return source.path;
  }
  return undefined;
}

function readLayerAssetRefs(
  layer: MotionLayer,
  declaredSet: Set<string>,
  motionAssetRefById: Map<string, string>
): AssetsPanelLayerRef[] {
  const refs: AssetsPanelLayerRef[] = [];
  for (const field of ["assetRef", "source", "src"] as const) {
    const ref = layer[field];
    if (typeof ref !== "string" || ref.length === 0) continue;
    refs.push({
      layerId: layer.id,
      layerType: layer.type,
      field,
      ref,
      declared: declaredSet.has(ref),
      ...(isExternalAssetRef(ref) ? { external: true } : {})
    });
  }
  if (typeof layer.assetId === "string" && layer.assetId.length > 0) {
    const ref = motionAssetRefById.get(layer.assetId) ?? layer.assetId;
    refs.push({
      layerId: layer.id,
      layerType: layer.type,
      field: "assetId",
      ref,
      declared: declaredSet.has(ref),
      ...(isExternalAssetRef(ref) ? { external: true } : {})
    });
  }
  return refs;
}

async function layerAssetRefAvailability(pkg: MotionPackage, ref: string): Promise<Pick<AssetsPanelLayerRef, "exists">> {
  if (isExternalAssetRef(ref)) return {};
  return { exists: (await packageAssetFacts(pkg, ref)).exists };
}

async function packageAssetFacts(pkg: MotionPackage, ref: string): Promise<Omit<AssetsPanelAsset, "ref" | "usedByLayerIds">> {
  if (isExternalAssetRef(ref)) return { exists: false };
  try {
    const path = resolvePackageAsset(pkg, ref);
    const stat = await lstat(path);
    if (!stat.isFile()) return { exists: false };
    return {
      exists: true,
      sizeBytes: stat.size,
      sha256: await hashPackageFile(path)
    };
  } catch {
    return { exists: false };
  }
}

function addAssetUsage(usageByRef: Map<string, string[]>, ref: string, layerId: string): void {
  const layerIds = usageByRef.get(ref) ?? [];
  if (!layerIds.includes(layerId)) layerIds.push(layerId);
  usageByRef.set(ref, layerIds);
}

function isExternalAssetRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

interface BrandPanelSummary {
  designTokens: Record<string, unknown> | null;
  tokenGroups: string[];
  colorTokens: Array<{ path: string; value: string }>;
  typographyTokens: Array<{ path: string; value: unknown }>;
  logoTokens: Array<{ path: string; value: unknown }>;
  provenance: Record<string, unknown> & { sourceApp: string };
}

function brandPanelSummary(pkg: MotionPackage): BrandPanelSummary {
  const designTokens = objectRecord(pkg.motion.designTokens);
  const colorTokens = tokenGroupStringEntries(designTokens, "color");
  const typographyTokens = tokenGroupEntries(designTokens, "typography");
  const logoTokens = tokenGroupEntries(designTokens, "logo");
  const provenance = {
    ...pkg.motion.provenance,
    ...(pkg.motion.provenance.selectedFrameId === undefined && pkg.manifest.selectedFrameId !== undefined
      ? { selectedFrameId: pkg.manifest.selectedFrameId }
      : {})
  };
  return {
    designTokens,
    tokenGroups: designTokens ? Object.keys(designTokens) : [],
    colorTokens: colorTokens.map(([key, value]) => ({ path: `color.${key}`, value })),
    typographyTokens: typographyTokens.map(([key, value]) => ({ path: `typography.${key}`, value })),
    logoTokens: logoTokens.map(([key, value]) => ({ path: `logo.${key}`, value })),
    provenance
  };
}

function tokenGroupStringEntries(tokens: Record<string, unknown> | null, group: string): Array<[string, string]> {
  return tokenGroupEntries(tokens, group).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function tokenGroupEntries(tokens: Record<string, unknown> | null, group: string): Array<[string, unknown]> {
  const record = objectRecord(tokens?.[group]);
  return record ? Object.entries(record) : [];
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeExpandedMotionPackage(job: ExpandedMotionJob, sourcePkg: MotionPackage, packageDir: string): Promise<void> {
  await mkdir(packageDir, { recursive: true });
  await writeJsonFile(join(packageDir, "manifest.json"), job.manifest);
  await writeJsonFile(join(packageDir, "motion.json"), job.motion);
  for (const assetRef of job.manifest.assets ?? []) {
    const targetPath = join(packageDir, assetRef);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(resolvePackageAsset(sourcePkg, assetRef), targetPath);
  }
}

async function materializeDebugBatchQualityManifest(input: {
  sourcePath: string;
  targetPath: string;
  row: MotionDataRow;
  packageId: string;
  packageDir: string;
  outputPath: string;
}): Promise<{ path: string; appliedPath?: string }> {
  const sourceText = await readFile(input.sourcePath, "utf8");
  if (!sourceText.includes("{{")) return { path: input.sourcePath };
  const context: Record<string, unknown> = {
    ...input.row.values,
    rowId: input.row.id,
    rowIndex: input.row.index,
    rowHash: input.row.hash,
    rowKey: input.row.key,
    packageId: input.packageId,
    packageDir: input.packageDir,
    outputPath: input.outputPath
  };
  const materialized = resolveDebugQualityManifestBaselinePaths(
    interpolateDebugQualityManifestValue(JSON.parse(sourceText), context),
    dirname(input.sourcePath)
  );
  await writeJsonFile(input.targetPath, materialized);
  return { path: input.targetPath, appliedPath: input.targetPath };
}

function interpolateDebugQualityManifestValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolateDebugQualityManifestString(value, context);
  if (Array.isArray(value)) return value.map((entry) => interpolateDebugQualityManifestValue(entry, context));
  const record = objectRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, interpolateDebugQualityManifestValue(entry, context)])
  );
}

function interpolateDebugQualityManifestString(value: string, context: Record<string, unknown>): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const replacement = context[key];
    if (replacement === undefined || replacement === null) return "";
    return typeof replacement === "string" ? replacement : JSON.stringify(replacement);
  });
}

function resolveDebugQualityManifestBaselinePaths(value: unknown, sourceDir: string): unknown {
  const record = objectRecord(value);
  if (!record || !Array.isArray(record.samples)) return value;
  return {
    ...record,
    samples: record.samples.map((sample) => {
      const sampleRecord = objectRecord(sample);
      if (!sampleRecord || typeof sampleRecord.baseline !== "string" || !sampleRecord.baseline.trim()) return sample;
      return {
        ...sampleRecord,
        baseline: isAbsolute(sampleRecord.baseline) ? sampleRecord.baseline : resolve(sourceDir, sampleRecord.baseline)
      };
    })
  };
}

async function writeDebugBatchReceipt(input: {
  receiptsRoot: string;
  pkg: MotionPackage;
  rows: MotionDataRow[];
  dryRun: boolean;
  resume?: boolean;
  resumedRows?: number;
  renderedRows?: number;
  preset: MotionExportPreset;
  presets?: MotionExportPreset[];
  quality?: { minUniqueFrameHashes: number };
  qualityManifestPath?: string;
  jobs: Array<Record<string, unknown>>;
  status: OperationReceipt["status"];
  /** Transport-observed actor for by-whom attribution; no-op when absent. */
  actor?: ReceiptActor;
}): Promise<OperationReceipt> {
  const rowHash = hashBuffer(Buffer.from(JSON.stringify({
    rows: input.rows.map((row) => ({ id: row.id, hash: row.hash })),
    preset: input.preset,
    presets: input.presets,
    quality: input.quality,
    qualityManifestPath: input.qualityManifestPath
  }), "utf8"));
  // Every warning this batch is about to publish, in one place, because the aggregate status is
  // derived from exactly the set it ships.
  const warnings = dedupeWarnings(input.jobs.flatMap((job) => debugResultWarnings(job)));
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `batch-render-${input.pkg.manifest.id}-${rowHash.slice(0, 16)}`,
    operation: "render.batch",
    // Derived AT THE DOOR rather than at each call site: three callers reach this writer (two on a
    // failure path, one on success), and a rule applied per-caller is a rule that drifts the moment
    // a fourth is added. Escalate-only, so the two `failed` callers pass through untouched — a count
    // of warnings can soften nothing.
    //
    // Without this the aggregate contradicted the rows it aggregates: measured during cross-host verification, this
    // receipt said `passed` while carrying the same motion-density advisory that made every row
    // report `warning` under the CLI. The Debug API must apply the same status rule.
    status: escalateReceiptStatusForWarnings(input.status, warnings),
    packageId: input.pkg.manifest.id,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")),
      rows: rowHash
    },
    createdAt: new Date().toISOString(),
    lane: "batch",
    output: {
	      dryRun: input.dryRun,
	      ...(input.resume ? { resume: true, resumedRows: input.resumedRows ?? 0, renderedRows: input.renderedRows ?? 0 } : {}),
	      preset: input.preset,
	      ...(input.presets ? { presets: input.presets } : {}),
	      ...(input.quality ? { quality: input.quality } : {}),
	      ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
	      rows: input.rows.length,
	      jobs: input.jobs.map((job) => ({
	        rowId: job.rowId,
        rowHash: job.rowHash,
        rowKey: job.rowKey,
        ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
        packageId: job.packageId,
        outputPath: job.outputPath,
	        preset: job.preset,
	        status: job.status,
	        ...(job.planReceiptPath ? { planReceiptPath: job.planReceiptPath } : {}),
	        ...(job.receiptPath ? { receiptPath: job.receiptPath } : {}),
	        ...(job.resume ? { resume: job.resume } : {}),
	        ...(job.quality ? { quality: job.quality } : {}),
	        ...(job.qualityManifestPath ? { qualityManifestPath: job.qualityManifestPath } : {}),
	        ...(job.qualityManifestAppliedPath ? { qualityManifestAppliedPath: job.qualityManifestAppliedPath } : {}),
	        ...debugBatchJobWorkflowReceiptOutput(job),
	        ...debugQualityCheckReceiptOutput(job),
	        ...(debugResultWarnings(job).length > 0 ? { warnings: debugResultWarnings(job) } : {})
	      }))
	    },
    warnings
  };
  // Stamp the transport-observed actor onto the aggregate batch receipt so the
  // engine-room History attributes it to the same actor as the per-row final-render
  // receipts. This is the batch-orchestration analogue of the writeReceipt
  // choke closure that covers every domain service; applyReceiptActor mutates in
  // place and is a no-op when no actor was observed (direct/legacy callers).
  applyReceiptActor(receipt, input.actor);
  await writeJsonFile(join(input.receiptsRoot, "batch-render.receipt.json"), receipt);
  return receipt;
}

function debugBatchJobWorkflowReceiptOutput(job: Record<string, unknown>): Record<string, unknown> {
  const render = objectRecord(job.render);
  if (!render) return {};
  const workflowPath = typeof render.workflowPath === "string" ? render.workflowPath : undefined;
  const workflow = render.workflow;
  const workflowTrace = render.workflowTrace;
  if (!workflowPath && workflow === undefined && workflowTrace === undefined) return {};
  return {
    render: {
      ...(workflowPath ? { workflowPath } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
      ...(workflowTrace !== undefined ? { workflowTrace } : {})
    }
  };
}

function planDebugBatchRenderPresets(jobs: ExpandedMotionJob[], fallbackPreset: MotionExportPreset, forcePreset: boolean): {
  ok: true;
  presets: MotionExportPreset[];
  uniquePresets: MotionExportPreset[];
} | {
  ok: false;
  rowId: string;
  preset: string;
} {
  const presets: MotionExportPreset[] = [];
  for (const job of jobs) {
    const rowPresetValue = forcePreset ? undefined : readDebugBatchRowRenderPreset(job.row);
    if (!rowPresetValue) {
      presets.push(fallbackPreset);
      continue;
    }
    const rowPreset = readMotionExportPreset(rowPresetValue);
    if (!rowPreset) {
      return { ok: false, rowId: job.row.id, preset: rowPresetValue };
    }
    presets.push(rowPreset);
  }
  return { ok: true, presets, uniquePresets: uniqueDebugMotionExportPresets(presets) };
}

function readDebugBatchRowRenderPreset(row: MotionDataRow): string | undefined {
  const flatPreset = row.values["render.preset"];
  if (typeof flatPreset === "string" && flatPreset.trim()) return flatPreset.trim();
  const render = objectRecord(row.values.render);
  const preset = render?.preset;
  return typeof preset === "string" && preset.trim() ? preset.trim() : undefined;
}

function uniqueDebugMotionExportPresets(presets: MotionExportPreset[]): MotionExportPreset[] {
  return presets.filter((preset, index) => presets.indexOf(preset) === index);
}

function debugBatchPresetSummary(basePreset: MotionExportPreset, actualPresets: MotionExportPreset[]): { presets?: MotionExportPreset[] } {
  return actualPresets.length === 1 && actualPresets[0] === basePreset ? {} : { presets: actualPresets };
}

function debugBatchJobIdempotencyKey(input: {
  packageId: string;
  rowId: string;
  rowHash: string;
  manifest: unknown;
  motion: unknown;
  preset: MotionExportPreset;
  quality?: { minUniqueFrameHashes: number };
  qualityManifestPath?: string;
  workflowIdempotencyHash?: string;
}): string {
  const digest = hashBuffer(Buffer.from(JSON.stringify({
    packageId: input.packageId,
    rowId: input.rowId,
    rowHash: input.rowHash,
    manifest: input.manifest,
    motion: input.motion,
    preset: input.preset,
    quality: input.quality,
    qualityManifestPath: input.qualityManifestPath,
    workflowIdempotencyHash: input.workflowIdempotencyHash
  }), "utf8")).slice(0, 24);
  return `${input.packageId}:${input.rowId}:${input.preset}:${digest}`;
}

function debugBatchFramesDir(framesRoot: string, packageId: string, idempotencyKey: unknown): string {
  const key = typeof idempotencyKey === "string" ? idempotencyKey : packageId;
  return join(framesRoot, `${packageId}-${hashBuffer(Buffer.from(key, "utf8")).slice(0, 12)}`);
}

async function debugBatchWorkflowIdempotencyHash(input: { workflow?: unknown; workflowPath?: string }): Promise<string | undefined> {
  if (input.workflow === undefined && !input.workflowPath) return undefined;
  const workflowFileHash = input.workflowPath ? hashBuffer(await readFile(input.workflowPath)) : undefined;
  return hashBuffer(Buffer.from(JSON.stringify({
    ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
    ...(workflowFileHash ? { workflowFileHash } : {})
  }), "utf8"));
}

async function readDebugBatchResumeJobs(receiptPath: string): Promise<Map<string, Record<string, unknown>>> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath, "utf8"));
    const output = objectRecord(objectRecord(parsed)?.output);
    const jobs = output?.jobs;
    if (!Array.isArray(jobs)) return new Map();
    const byKey = new Map<string, Record<string, unknown>>();
    for (const job of jobs) {
      const record = objectRecord(job);
      const idempotencyKey = record?.idempotencyKey;
      if (record && typeof idempotencyKey === "string") byKey.set(idempotencyKey, record);
    }
    return byKey;
  } catch (error) {
    if (objectRecord(error)?.code === "ENOENT") return new Map();
    throw error;
  }
}

function readDebugBatchResumeMatch(previousJobs: Map<string, Record<string, unknown>>, idempotencyKey: unknown, outputPath: unknown): Record<string, unknown> | null {
  if (typeof idempotencyKey !== "string" || typeof outputPath !== "string") return null;
  const previous = previousJobs.get(idempotencyKey);
  if (!previous) return null;
  if (previous.outputPath !== outputPath) return null;
  // MUST move with the two escalations above, and did not in the CLI: when a successful row began
  // reporting `warning`, the old literal `!== "passed"` test stopped matching it and resume silently
  // re-rendered every row it should have reused — no error, just the work done twice. Ask the
  // generated receipt-status -> job-outcome mapping instead of naming statuses here, so a status
  // added to `schemas/job-status.json` cannot quietly fall out of this predicate.
  const previousStatus = typeof previous.status === "string" ? previous.status : "";
  if (previousStatus !== "skipped" && jobOutcomeForReceiptStatus(previousStatus) !== "succeeded") return null;
  const sourceReceiptPath = debugBatchResumeSourceReceiptPath(previous);
  if (!sourceReceiptPath || !existsSync(sourceReceiptPath)) return null;
  if (!existsSync(outputPath)) return null;
  return previous;
}

function debugBatchResumeSourceReceiptPath(job: Record<string, unknown>): string | undefined {
  if (typeof job.receiptPath === "string") return job.receiptPath;
  const resume = objectRecord(job.resume);
  return typeof resume?.sourceReceiptPath === "string" ? resume.sourceReceiptPath : undefined;
}

function debugBatchRenderCounts(jobs: Array<Record<string, unknown>>, dryRun: boolean): { resumedRows: number; renderedRows: number } {
  const resumedRows = jobs.filter((job) => job.status === "skipped").length;
  return { resumedRows, renderedRows: dryRun ? 0 : jobs.length - resumedRows };
}

async function writeDebugBatchRowPlanReceipt(input: {
  receiptsRoot: string;
  dryRun: boolean;
  packageId: string;
  row: { id: string; hash: string; key?: string };
  manifest: unknown;
  motion: unknown;
  packageDir: string;
  outputPath: string;
  preset: MotionExportPreset;
  status: OperationReceipt["status"];
  idempotencyKey: string;
  quality?: { minUniqueFrameHashes: number };
  qualityManifestPath?: string;
  warnings?: string[];
  /** Transport-observed actor for by-whom attribution; no-op when absent. */
  actor?: ReceiptActor;
}): Promise<string> {
  const receiptPath = join(input.receiptsRoot, `${input.packageId}.batch-row.receipt.json`);
  const warnings = dedupeWarnings(input.warnings ?? []);
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `batch-row-${input.packageId}-${hashBuffer(Buffer.from(input.idempotencyKey, "utf8")).slice(0, 16)}`,
    operation: "render.batch.row",
    status: input.status,
    packageId: input.packageId,
    inputHashes: {
      row: input.row.hash,
      manifest: hashBuffer(Buffer.from(JSON.stringify(input.manifest), "utf8")),
      motion: hashBuffer(Buffer.from(JSON.stringify(input.motion), "utf8")),
      idempotencyKey: hashBuffer(Buffer.from(input.idempotencyKey, "utf8"))
    },
    createdAt: new Date().toISOString(),
    lane: "batch",
    output: {
      dryRun: input.dryRun,
      rowId: input.row.id,
      rowHash: input.row.hash,
      rowKey: input.row.key,
      idempotencyKey: input.idempotencyKey,
      packageId: input.packageId,
      packageDir: input.packageDir,
      outputPath: input.outputPath,
      preset: input.preset,
      status: input.status,
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {})
    },
    artifacts: [
      { role: "row_package", path: input.packageDir, status: "available", mediaType: "application/vnd.shellx-motion.package+directory" },
      { role: "planned_output", path: input.outputPath, status: "planned" }
    ],
    warnings
  };
  // Attribute the per-row plan receipt to the transport-observed actor, matching
  // the aggregate and per-row final-render receipts. No-op when no actor was observed.
  applyReceiptActor(receipt, input.actor);
  await writeJsonFile(receiptPath, receipt);
  return receiptPath;
}

function debugBatchOutputPath(renderRoot: string, packageId: string, preset: MotionExportPreset): string {
  const spec = resolveMotionExportPreset(preset);
  if (readImageSequenceExportPreset(preset)) return join(renderRoot, packageId);
  return join(renderRoot, `${packageId}.${spec.extension}`);
}

function supportsDebugBatchQualityManifestPreset(preset: MotionExportPreset): boolean {
  return Boolean(readFfmpegExportPreset(preset)) || preset === "png-frame" || preset === "png-sequence";
}

function debugAudioWarningsForMotionExportPreset(preset: MotionExportPreset, audioInputCount: number): string[] {
  const ffmpegPreset = readFfmpegExportPreset(preset);
  if (ffmpegPreset) return audioWarningsForExportPreset(ffmpegPreset, audioInputCount);
  if (audioInputCount <= 0) return [];
  const noun = audioInputCount === 1 ? "track" : "tracks";
  return [`Export preset ${preset} does not support audio; ${audioInputCount} requested audio ${noun} will be ignored.`];
}

function debugQualityCheckReceiptOutput(job: Record<string, unknown>): { qualityCheck?: { status: "passed" | "failed" } } {
  const qualityCheck = objectRecord(job.qualityCheck);
  if (!qualityCheck) return {};
  return {
    qualityCheck: {
      status: qualityCheck.ok === true ? "passed" : "failed"
    }
  };
}

function debugBatchRenderError(job: ExpandedMotionJob, renderResult: MotionDebugResult): { code: string; message: string; suggestedAction?: string } {
  if (renderResult.ok) {
    return {
      code: "render_batch_failed",
      message: `Batch row ${job.row.id} did not return a failed render result.`
    };
  }
  return {
    ...renderResult.error,
    message: `Batch row ${job.row.id} (${job.manifest.id}) failed: ${renderResult.error.message}`
  };
}

function debugBatchQualityError(job: ExpandedMotionJob, qualityResult: MotionDebugResult): { code: string; message: string; suggestedAction?: string; detail?: unknown } {
  if (qualityResult.ok) {
    return {
      code: "quality_check_failed",
      message: `Batch row ${job.row.id} did not return a failed quality result.`
    };
  }
  return {
    ...qualityResult.error,
    message: `Batch row ${job.row.id} (${job.manifest.id}) failed quality check: ${qualityResult.error.message}`
  };
}

function debugResultWarnings(result: unknown): string[] {
  const record = objectRecord(result);
  if (!record) return [];
  if (Array.isArray(record.warnings)) {
    return record.warnings.filter((warning): warning is string => typeof warning === "string");
  }
  const receipt = objectRecord(record.receipt);
  if (receipt && Array.isArray(receipt.warnings)) {
    return receipt.warnings.filter((warning): warning is string => typeof warning === "string");
  }
  return [];
}

function connectorDebugFailureError(command: MotionDebugCommand, result: unknown): MotionDebugError {
  const resultRecord = objectRecord(result);
  const receiptPath = typeof resultRecord?.receiptPath === "string" ? resultRecord.receiptPath : undefined;
  return {
    code: "connector_failed",
    message: `${command} returned a failed connector receipt.`,
    ...(receiptPath ? { detail: { receiptPath } } : {})
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

async function readReceiptEntries(receiptsRoot: string): Promise<ReceiptEntry[]> {
  const files = await discoverJsonFiles(receiptsRoot);
  const entries: ReceiptEntry[] = [];
  for (const path of files) {
    const receipt = await readReceiptFile(path);
    if (receipt) entries.push({ path, receipt });
  }
  return entries.sort((a, b) => compareCodeUnits(a.path, b.path));
}

async function readAgentRevisionQualityReceipts(
  args: unknown,
  receiptsRoot: string | undefined
): Promise<{ ok: true; receipts: OperationReceipt[] } | { ok: false; message: string }> {
  const receipts: OperationReceipt[] = [];
  const inlineReceipt = readRecordArg(args, "qualityReceipt");
  if (inlineReceipt) {
    const receipt = readOperationReceipt(inlineReceipt);
    if (!receipt) return { ok: false, message: "qualityReceipt must be a shellx-motion receipt@1 object." };
    receipts.push(receipt);
  }

  const record = objectRecord(args);
  const inlineReceipts = Array.isArray(record?.qualityReceipts) ? record.qualityReceipts : undefined;
  if (inlineReceipts) {
    for (const entry of inlineReceipts) {
      const receipt = readOperationReceipt(entry);
      if (!receipt) return { ok: false, message: "qualityReceipts must contain shellx-motion receipt@1 objects." };
      receipts.push(receipt);
    }
  }

  const qualityReceiptPaths = [
    readStringArg(args, "qualityReceiptPath"),
    ...(readStringArrayArg(args, "qualityReceiptPaths") ?? [])
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  for (const path of qualityReceiptPaths) {
    if (receiptsRoot && !await isReceiptPathInsideRoot(receiptsRoot, path)) {
      return { ok: false, message: "qualityReceiptPath must be inside receiptsRoot." };
    }
    const receipt = await readReceiptFile(resolve(path));
    if (!receipt) return { ok: false, message: `Quality receipt not found at path: ${path}.` };
    receipts.push(receipt);
  }

  const qualityReceiptIds = [
    readStringArg(args, "qualityReceiptId"),
    ...(readStringArrayArg(args, "qualityReceiptIds") ?? [])
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (qualityReceiptIds.length > 0) {
    if (!receiptsRoot) return { ok: false, message: "qualityReceiptId requires receiptsRoot." };
    const entries = await readReceiptEntries(receiptsRoot);
    for (const id of qualityReceiptIds) {
      const entry = findReceiptEntryById(entries, id);
      if (!entry) return { ok: false, message: `Quality receipt not found: ${id}.` };
      receipts.push(entry.receipt);
    }
  }

  const deduped = new Map<string, OperationReceipt>();
  for (const receipt of receipts) {
    if (receipt.operation !== "quality.check") {
      return { ok: false, message: `Revision plan quality evidence must use quality.check receipts; got ${receipt.operation}.` };
    }
    deduped.set(receipt.id, receipt);
  }
  return { ok: true, receipts: [...deduped.values()] };
}

/**
 * Read the contact-sheet evidence for `motion.agent.revision.plan`, from a path or inline.
 *
 * The path is fenced HERE as well as at the domain gate that computed `trustedRoots`. It was fenced
 * only there, and the helper itself did a plain readFile plus JSON.parse on whatever it was handed:
 * distinguishable answers ("not found at path" versus a shape complaint) make an unfenced version a
 * filesystem existence-and-JSON-shape oracle over anything the process can read, and the only thing
 * standing between that and a `write_local` caller was a check twenty lines up the call stack in a
 * different file.
 *
 * The trusted set is the caller-supplied `trustedRoots` — the domain's input roots — and not
 * `receiptsRoot` the way the sibling `qualityReceiptPath` is fenced. A contact sheet is a render
 * artifact; it normally lives in the scratch root, and narrowing this to the receipt store would
 * refuse the ordinary case. Refusing when the list is empty is the fail-closed half: a caller
 * cannot name a path when the host declared nowhere to name it from.
 *
 * The refusal is deliberately the SAME message for an out-of-root path whether or not it exists.
 */
async function readAgentRevisionContactSheet(
  args: unknown,
  trustedRoots: string[] | undefined
): Promise<{ ok: true; contactSheet?: AgentRevisionContactSheetEvidence } | { ok: false; message: string }> {
  const contactSheetPath = readStringArg(args, "contactSheetPath") ?? readStringArg(args, "contactSheetFile");
  const inline = readRecordArg(args, "contactSheet");
  let source: unknown = inline;
  if (contactSheetPath) {
    const roots = trustedRoots ?? [];
    let admitted = false;
    for (const root of roots) if (await isPathInsideTrustedRoot(root, contactSheetPath)) { admitted = true; break; }
    if (!admitted) return { ok: false, message: "contactSheetPath must be inside a trusted debug input root." };
    try {
      source = JSON.parse(await readFile(resolve(contactSheetPath), "utf8"));
    } catch {
      return { ok: false, message: `Contact-sheet evidence not found at path: ${contactSheetPath}.` };
    }
  }
  if (source === null || source === undefined) return { ok: true };
  const contactSheet = normalizeAgentRevisionContactSheet(source, contactSheetPath ?? undefined);
  return typeof contactSheet === "string" ? { ok: false, message: contactSheet } : { ok: true, contactSheet };
}

function normalizeAgentRevisionContactSheet(value: unknown, fallbackPath?: string): AgentRevisionContactSheetEvidence | string {
  const record = objectRecord(value);
  if (!record) return "contactSheet must be an object.";
  const status = record.status;
  if (status !== "approved" && status !== "needs_revision" && status !== "missing") {
    return "contactSheet.status must be approved, needs_revision, or missing.";
  }
  const path = typeof record.path === "string" && record.path.length > 0
    ? record.path
    : fallbackPath;
  if (!path) return "contactSheet.path is required.";
  const notes = record.notes;
  if (notes !== undefined && (!Array.isArray(notes) || !notes.every((note) => typeof note === "string"))) {
    return "contactSheet.notes must be an array of strings.";
  }
  return {
    path,
    status,
    ...(Array.isArray(notes) && notes.length > 0 ? { notes } : {})
  };
}

async function readReceiptFile(path: string): Promise<OperationReceipt | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DEBUG_RECEIPT_BYTES) return null;
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DEBUG_RECEIPT_BYTES) return null;
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) return null;
    const content = await handle.readFile({ encoding: "utf8" });
    const final = await handle.stat();
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) return null;
    // The parsed original travels alongside the projection: the purge rewrites those bytes, not the
    // normalizer's view of them. See receipt-raw-prompt-purge.ts.
    const parsed: unknown = JSON.parse(content);
    return await enforceRawPromptExpiry(path, readOperationReceipt(parsed), parsed, { dev: opened.dev, ino: opened.ino });
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readReceiptEntryInsideRoot(receiptsRoot: string, receiptPath: string): Promise<{
  insideRoot: boolean;
  entry: ReceiptEntry | null;
}> {
  const requestedPath = resolve(receiptPath);
  if (!isPathInsideOrEqual(receiptsRoot, requestedPath)) return { insideRoot: false, entry: null };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const [canonicalRoot, canonicalReceiptPath, before] = await Promise.all([
      realpath(receiptsRoot),
      realpath(requestedPath),
      lstat(requestedPath)
    ]);
    if (!isPathInsideOrEqual(canonicalRoot, canonicalReceiptPath)) return { insideRoot: false, entry: null };
    if (!before.isFile() || before.isSymbolicLink()) return { insideRoot: true, entry: null };
    handle = await open(requestedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DEBUG_RECEIPT_BYTES) return { insideRoot: true, entry: null };
    const [canonicalAfter, after] = await Promise.all([realpath(requestedPath), lstat(requestedPath)]);
    if (canonicalAfter !== canonicalReceiptPath
      || after.isSymbolicLink()
      || !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino) return { insideRoot: true, entry: null };
    const content = await handle.readFile({ encoding: "utf8" });
    const final = await handle.stat();
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
      return { insideRoot: true, entry: null };
    }
    const parsed: unknown = JSON.parse(content);
    const receipt = await enforceRawPromptExpiry(requestedPath, readOperationReceipt(parsed), parsed, { dev: opened.dev, ino: opened.ino });
    return { insideRoot: true, entry: receipt ? { path: requestedPath, receipt } : null };
  } catch {
    return { insideRoot: true, entry: null };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function isReceiptPathInsideRoot(receiptsRoot: string, receiptPath: string): Promise<boolean> {
  const requestedPath = resolve(receiptPath);
  if (!isPathInsideOrEqual(receiptsRoot, requestedPath)) return false;
  const [rootPath, canonicalReceiptPath] = await Promise.all([
    canonicalPathForSafety(receiptsRoot),
    canonicalPathForSafety(requestedPath)
  ]);
  return isPathInsideOrEqual(rootPath, canonicalReceiptPath);
}

function readOperationReceipt(value: unknown): OperationReceipt | null {
  const record = objectRecord(value);
  if (!record) return null;
  if (record.schema !== "shellx-motion/receipt@1") return null;
  if (typeof record.id !== "string") return null;
  if (typeof record.operation !== "string") return null;
  const status = readReceiptStatus(record.status);
  if (!status) return null;
  if (typeof record.packageId !== "string") return null;
  const inputHashes = readStringRecord(record.inputHashes);
  if (!inputHashes) return null;
  if (typeof record.createdAt !== "string") return null;
  if (typeof record.lane !== "string") return null;
  const warnings = readStringArray(record.warnings);
  if (!warnings) return null;
  const artifacts = readReceiptArtifacts(record.artifacts);
  if (record.artifacts !== undefined && !artifacts) return null;
  const output = objectRecord(record.output);
  const outputArtifacts = output ? readReceiptArtifacts(output.artifacts) : undefined;
  if (output?.artifacts !== undefined && !outputArtifacts) return null;
  const allArtifacts = mergeReceiptArtifacts(artifacts ?? [], outputArtifacts ?? []);
  return {
    schema: "shellx-motion/receipt@1",
    id: record.id,
    operation: record.operation,
    status,
    packageId: record.packageId,
    inputHashes,
    createdAt: record.createdAt,
    lane: record.lane,
    output: record.output,
    ...(allArtifacts.length > 0 ? { artifacts: allArtifacts } : {}),
    warnings,
    // Pass through persisted actor attribution so the engine-room History (which reads receipts
    // back through this validator) can answer "BY WHO". Dropping it here would make every stamped
    // actor invisible to the very view that motivated the field.
    ...(readReceiptActor(record.actor) ? { actor: readReceiptActor(record.actor) } : {})
  };
}

function mergeReceiptArtifacts(...groups: ReceiptArtifact[][]): ReceiptArtifact[] {
  const merged: ReceiptArtifact[] = [];
  const seen = new Set<string>();
  for (const artifact of groups.flat()) {
    const key = `${artifact.role}\0${artifact.path}\0${artifact.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

function readReceiptStatus(value: unknown): OperationReceipt["status"] | null {
  if (value === "passed" || value === "failed" || value === "warning" || value === "not_run") return value;
  return null;
}

function readStringRecord(value: unknown): Record<string, string> | null {
  const record = objectRecord(value);
  if (!record) return null;
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") return null;
    strings[key] = entry;
  }
  return strings;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    strings.push(entry);
  }
  return strings;
}

function readReceiptArtifacts(value: unknown): ReceiptArtifact[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const artifacts: ReceiptArtifact[] = [];
  for (const item of value) {
    const record = objectRecord(item);
    if (!record) return null;
    if (typeof record.role !== "string" || typeof record.path !== "string") return null;
    if (record.status !== "available" && record.status !== "planned" && record.status !== "not_required" && record.status !== "failed") return null;
    if (record.label !== undefined && typeof record.label !== "string") return null;
    if (record.mediaType !== undefined && typeof record.mediaType !== "string") return null;
    if (record.primary !== undefined && typeof record.primary !== "boolean") return null;
    artifacts.push({
      role: record.role,
      path: record.path,
      status: record.status,
      ...(typeof record.label === "string" ? { label: record.label } : {}),
      ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
      ...(typeof record.primary === "boolean" ? { primary: record.primary } : {})
    });
  }
  return artifacts;
}

function receiptSummary(entry: ReceiptEntry): Record<string, unknown> {
  const qualityManifest = renderQualityManifestSummary(entry.receipt);
  return {
    id: entry.receipt.id,
    operation: entry.receipt.operation,
    status: entry.receipt.status,
    packageId: entry.receipt.packageId,
    lane: entry.receipt.lane,
    createdAt: entry.receipt.createdAt,
    path: entry.path,
    ...(readReceiptOutputPath(entry.receipt) ? { outputPath: readReceiptOutputPath(entry.receipt) } : {}),
    ...(qualityManifest ? { qualityManifest } : {}),
    warnings: entry.receipt.warnings
  };
}

/**
 * What one platform-verification command status MEANS for the host's claim.
 *
 * `scripts/platform-verify.mjs` writes six statuses -- `passed`, `skipped`, `planned`, `failed`,
 * `missing`, `unreadable` -- and this panel used to treat everything that was not `passed` as a
 * failure. A host whose FFmpeg does not advertise HEVC records that
 * command as `status: "skipped"`, `skipKind: "capability-absent"` and the host receipt stays
 * `passed`, deliberately, because the host never claimed the codec (`--require-modern-codecs`
 * upgrades it to a real failure). The panel read that intentional skip as a required failure and
 * turned a valid passing host into `failed`, with empty `satisfiedHosts`.
 *
 * That is the same `!== "passed"` shape as the batch-resume and receipt-status defects in this
 * release: a binary test applied to a vocabulary that is not binary.
 *
 * Unknown statuses classify as `failed` on purpose. Enumerating only the failures would make any
 * status added later silently count as success, which is the more dangerous direction for a gate
 * that decides whether a platform is verified.
 *
 * @param status A command's `status` field from a platform-verification receipt.
 * @returns `passed` for success, `skipped` for a deliberate non-run, `failed` for everything else.
 */
function platformCommandOutcome(status: unknown): "passed" | "skipped" | "failed" {
  if (status === "passed") return "passed";
  // `planned` is a dry-run artifact: the command was never meant to run in this pass.
  if (status === "skipped" || status === "planned") return "skipped";
  return "failed";
}

function platformReceiptSummary(entry: PlatformReceiptEntry): Record<string, unknown> {
  const schema = typeof entry.receipt.schema === "string" ? entry.receipt.schema : "unknown";
  if (schema === "shellx-motion/platform-verification-aggregate@1") {
    const summary = objectRecord(entry.receipt.summary);
    return {
      schema,
      path: entry.path,
      status: typeof entry.receipt.status === "string" ? entry.receipt.status : "unknown",
      dryRun: entry.receipt.dryRun === true,
      requiredHosts: readLooseStringArray(entry.receipt.requiredHosts),
      receiptCount: Array.isArray(entry.receipt.receipts) ? entry.receipt.receipts.length : 0,
      ...(summary ? {
        missingHosts: readLooseStringArray(summary.missingHosts),
        failedHosts: readLooseStringArray(summary.failedHosts),
        satisfiedHostCount: typeof summary.satisfiedHostCount === "number" ? summary.satisfiedHostCount : undefined,
        requiredHostCount: typeof summary.requiredHostCount === "number" ? summary.requiredHostCount : undefined,
        invalidReceiptCount: typeof summary.invalidReceiptCount === "number" ? summary.invalidReceiptCount : undefined
      } : {})
    };
  }

  const host = objectRecord(entry.receipt.host);
  const hostMatrix = objectRecord(entry.receipt.hostMatrix);
  const commands = Array.isArray(entry.receipt.commands) ? entry.receipt.commands.map(objectRecord).filter((command): command is Record<string, unknown> => command !== null) : [];
  const passedCommands = commands.filter((command) => command.status === "passed");
  const skippedCommands = commands.filter((command) => platformCommandOutcome(command.status) === "skipped");
  const failedCommands = commands.filter((command) => platformCommandOutcome(command.status) === "failed");
  const requiredFailedCommands = failedCommands.filter((command) => command.required === true);
  return {
    schema,
    path: entry.path,
    hostId: typeof host?.id === "string" ? host.id : undefined,
    hostPlatform: typeof host?.platform === "string" ? host.platform : undefined,
    hostArch: typeof host?.arch === "string" ? host.arch : undefined,
    status: typeof entry.receipt.status === "string" ? entry.receipt.status : "unknown",
    dryRun: entry.receipt.dryRun === true,
    hostMatrixStatus: typeof hostMatrix?.status === "string" ? hostMatrix.status : undefined,
    requiredHosts: readLooseStringArray(hostMatrix?.required),
    satisfiedHosts: readLooseStringArray(hostMatrix?.satisfied),
    missingHosts: readLooseStringArray(hostMatrix?.missing),
    commandCount: commands.length,
    passedCommandIds: passedCommands.map((command) => command.id).filter((id): id is string => typeof id === "string"),
    // Surfaced rather than folded into either bucket: a skipped codec gate is a real fact about the
    // host and the operator should see it, but it is not a failure and must not sink the host.
    skippedCommandCount: skippedCommands.length,
    skippedCommandIds: skippedCommands.map((command) => command.id).filter((id): id is string => typeof id === "string"),
    failedCommandCount: failedCommands.length,
    requiredFailedCommandCount: requiredFailedCommands.length,
    failedCommandIds: failedCommands.map((command) => command.id).filter((id): id is string => typeof id === "string")
  };
}

function platformVerificationPanelSummary(entries: PlatformReceiptEntry[], explicitRequiredHosts?: string[]): PlatformVerificationPanelSummary {
  const summaries = entries.map((entry) => platformReceiptSummary(entry));
  const hostReceipts = summaries.filter((summary) => summary.schema === "shellx-motion/platform-verification@1");
  const aggregateReceipts = summaries.filter((summary) => summary.schema === "shellx-motion/platform-verification-aggregate@1");
  const aggregateRequiredHosts = entries.flatMap((entry) => entry.receipt.schema === "shellx-motion/platform-verification-aggregate@1" ? readLooseStringArray(entry.receipt.requiredHosts) : []);
  const hostMatrixRequiredHosts = entries.flatMap((entry) => {
    if (entry.receipt.schema !== "shellx-motion/platform-verification@1") return [];
    return readLooseStringArray(objectRecord(entry.receipt.hostMatrix)?.required);
  });
  const requiredHosts = uniqueStrings([
    ...(explicitRequiredHosts ?? []),
    ...aggregateRequiredHosts,
    ...hostMatrixRequiredHosts
  ]);
  const satisfiedHosts = uniqueStrings(hostReceipts
    .filter((summary) => summary.status === "passed" && summary.dryRun === false && (typeof summary.requiredFailedCommandCount !== "number" || summary.requiredFailedCommandCount === 0))
    .map((summary) => summary.hostId)
    .filter((hostId): hostId is string => typeof hostId === "string"));
  const aggregateMissingHosts = aggregateReceipts.flatMap((summary) => readLooseStringArray(summary.missingHosts));
  const aggregateFailedHosts = aggregateReceipts.flatMap((summary) => readLooseStringArray(summary.failedHosts));
  const missingHosts = uniqueStrings([
    ...aggregateMissingHosts,
    ...requiredHosts.filter((hostId) => !satisfiedHosts.includes(hostId))
  ]);
  const failedHostReceipts = hostReceipts
    .filter((summary) => {
      if (typeof summary.hostId !== "string") return false;
      if (summary.status !== "passed") return true;
      if (summary.dryRun === true) return true;
      return typeof summary.requiredFailedCommandCount === "number" && summary.requiredFailedCommandCount > 0;
    })
    .map((summary) => summary.hostId)
    .filter((hostId): hostId is string => typeof hostId === "string");
  const failedHosts = uniqueStrings([...aggregateFailedHosts, ...failedHostReceipts]);
  const invalidReceiptCount = aggregateReceipts
    .map((summary) => objectRecord(summary))
    .reduce((total, summary) => total + (typeof summary?.invalidReceiptCount === "number" ? summary.invalidReceiptCount : 0), 0);
  const hasFailedAggregate = aggregateReceipts.some((summary) => summary.status === "failed");
  const hasPassedAggregate = aggregateReceipts.some((summary) => summary.status === "passed");
  const status = hasFailedAggregate || failedHosts.length > 0
    ? "failed"
    : missingHosts.length > 0
      ? "partial"
      : hasPassedAggregate || hostReceipts.length > 0
        ? "passed"
        : "missing";

  return {
    status,
    platformReceiptCount: entries.length,
    hostReceiptCount: hostReceipts.length,
    aggregateReceiptCount: aggregateReceipts.length,
    requiredHosts,
    satisfiedHosts,
    missingHosts,
    failedHosts,
    invalidReceiptCount,
    hostReceipts,
    aggregateReceipts
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function readLooseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function receiptsPanelSummary(entries: ReceiptEntry[], recentLimit: number): Record<string, unknown> {
  const statusCounts: Record<OperationReceipt["status"], number> = { passed: 0, warning: 0, failed: 0, not_run: 0 };
  const operationCounts: Record<string, number> = {};
  const warnings: Array<{ receiptId: string; operation: string; warning: string }> = [];
  const artifacts: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    statusCounts[entry.receipt.status] += 1;
    operationCounts[entry.receipt.operation] = (operationCounts[entry.receipt.operation] ?? 0) + 1;
    for (const warning of entry.receipt.warnings) {
      warnings.push({ receiptId: entry.receipt.id, operation: entry.receipt.operation, warning });
    }
    for (const artifact of entry.receipt.artifacts ?? []) {
      artifacts.push({
        receiptId: entry.receipt.id,
        operation: entry.receipt.operation,
        role: artifact.role,
        path: artifact.path,
        status: artifact.status,
        ...(artifact.label ? { label: artifact.label } : {}),
        ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
        ...(artifact.primary !== undefined ? { primary: artifact.primary } : {})
      });
    }
  }
  const recentReceipts = [...entries]
    .sort((left, right) => compareCodeUnits(right.receipt.createdAt, left.receipt.createdAt) || compareCodeUnits(left.path, right.path))
    .slice(0, recentLimit)
    .map((entry) => receiptSummary(entry));
  return {
    receiptCount: entries.length,
    failedCount: statusCounts.failed,
    warningCount: statusCounts.warning,
    artifactCount: artifacts.length,
    statusCounts,
    operationCounts,
    failedReceipts: entries.filter((entry) => entry.receipt.status === "failed").map((entry) => receiptSummary(entry)),
    warningReceipts: entries.filter((entry) => entry.receipt.status === "warning").map((entry) => receiptSummary(entry)),
    warnings,
    artifacts,
    recentReceipts
  };
}

function agentTranscriptSessions(entries: ReceiptEntry[], targetEntry?: ReceiptEntry): AgentTranscriptSession[] {
  const entriesById = new Map(entries.map((entry) => [entry.receipt.id, entry]));
  if (targetEntry) {
    const session = agentTranscriptSessionForTarget(targetEntry, entries);
    return session ? [session] : [];
  }

  const linkedAgentReceiptIds = new Set<string>();
  const sessions: AgentTranscriptSession[] = [];
  for (const entry of entries) {
    if (entry.receipt.operation !== "prompt.run") continue;
    const agentReceiptId = readPromptAgentReceiptId(entry.receipt);
    const agentEntry = agentReceiptId ? entriesById.get(agentReceiptId) : undefined;
    if (agentEntry) linkedAgentReceiptIds.add(agentEntry.receipt.id);
    sessions.push(agentTranscriptSession(entry, agentEntry));
  }
  for (const entry of entries) {
    if (entry.receipt.operation !== "agent.prompt") continue;
    if (linkedAgentReceiptIds.has(entry.receipt.id)) continue;
    sessions.push(agentTranscriptSession(undefined, entry));
  }
  return sessions.sort((left, right) => compareCodeUnits(right.createdAt, left.createdAt));
}

function agentTranscriptSessionForTarget(targetEntry: ReceiptEntry, entries: ReceiptEntry[]): AgentTranscriptSession | null {
  if (targetEntry.receipt.operation === "prompt.run") {
    const agentReceiptId = readPromptAgentReceiptId(targetEntry.receipt);
    const agentEntry = agentReceiptId ? findReceiptEntryById(entries, agentReceiptId) : undefined;
    return agentTranscriptSession(targetEntry, agentEntry);
  }
  if (targetEntry.receipt.operation === "agent.prompt") {
    const promptEntry = entries.find((entry) => readPromptAgentReceiptId(entry.receipt) === targetEntry.receipt.id);
    return agentTranscriptSession(promptEntry, targetEntry);
  }
  return null;
}

function agentTranscriptSession(promptEntry: ReceiptEntry | undefined, agentEntry: ReceiptEntry | undefined): AgentTranscriptSession {
  const promptOutput = promptEntry ? objectRecord(promptEntry.receipt.output) : null;
  const agentOutput = agentEntry ? objectRecord(agentEntry.receipt.output) : null;
  const transcript = agentTranscriptDigest(agentOutput?.transcript);
  const session: AgentTranscriptSession = {
    packageId: promptEntry?.receipt.packageId ?? agentEntry?.receipt.packageId ?? "unknown",
    status: promptEntry?.receipt.status ?? agentEntry?.receipt.status ?? "not_run",
    createdAt: promptEntry?.receipt.createdAt ?? agentEntry?.receipt.createdAt ?? "",
    debugCommands: readStringArray(promptOutput?.debugCommands) ?? [],
    transcript
  };
  if (promptEntry) {
    session.promptReceiptId = promptEntry.receipt.id;
    session.promptReceiptPath = promptEntry.path;
  }
  if (agentEntry) {
    session.agentReceiptId = agentEntry.receipt.id;
    session.agentReceiptPath = agentEntry.path;
  } else {
    const linkedAgentReceiptId = promptEntry ? readPromptAgentReceiptId(promptEntry.receipt) : undefined;
    if (linkedAgentReceiptId) session.agentReceiptId = linkedAgentReceiptId;
  }
  const planTopic = typeof promptOutput?.planTopic === "string" ? promptOutput.planTopic : undefined;
  if (planTopic) session.planTopic = planTopic;
  const agent = agentTranscriptAgent(agentOutput);
  if (agent) session.agent = agent;
  return session;
}

function readPromptAgentReceiptId(receipt: OperationReceipt): string | undefined {
  if (receipt.operation !== "prompt.run") return undefined;
  const agentReceiptId = objectRecord(receipt.output)?.agentReceiptId;
  return typeof agentReceiptId === "string" ? agentReceiptId : undefined;
}

function agentTranscriptAgent(output: Record<string, unknown> | null): AgentTranscriptSession["agent"] | undefined {
  if (!output) return undefined;
  const agent: NonNullable<AgentTranscriptSession["agent"]> = {};
  if (typeof output.agentId === "string") agent.agentId = output.agentId;
  if (typeof output.label === "string") agent.label = output.label;
  if (typeof output.transport === "string") agent.transport = output.transport;
  if (typeof output.billing === "string") agent.billing = output.billing;
  if (typeof output.permission === "string") agent.permission = output.permission;
  if (objectRecord(output.command)) agent.command = output.command;
  return Object.keys(agent).length > 0 ? agent : undefined;
}

function agentTranscriptDigest(value: unknown): AgentTranscriptSession["transcript"] {
  const roles: Record<"user" | "agent" | "stderr", number> = { user: 0, agent: 0, stderr: 0 };
  const messages: AgentTranscriptMessage[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = objectRecord(item);
      if (!record) continue;
      if (record.role === "user" && typeof record.contentSha256 === "string") {
        roles.user += 1;
        messages.push({ role: "user", contentSha256: record.contentSha256 });
        continue;
      }
      if ((record.role === "agent" || record.role === "stderr") && typeof record.content === "string") {
        const content = redactTranscriptContent(record.content);
        const truncated = content.length > MAX_TRANSCRIPT_MESSAGE_CHARS;
        roles[record.role] += 1;
        messages.push({
          role: record.role,
          content: truncated ? content.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS) : content,
          charCount: content.length,
          ...(truncated ? { truncated: true } : {})
        });
      }
    }
  }
  return {
    messageCount: messages.length,
    roles,
    messages
  };
}

const MAX_TRANSCRIPT_MESSAGE_CHARS = 4000;
const TRANSCRIPT_SECRET_PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g,
  /\bnpm_[A-Za-z0-9_]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
];

function redactTranscriptContent(value: string): string {
  return TRANSCRIPT_SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted-secret]"), value);
}

function findReceiptEntryById(entries: ReceiptEntry[], receiptId: string): ReceiptEntry | undefined {
  return entries.find((entry) => entry.receipt.id === receiptId);
}

function isPromptJobReceipt(receipt: OperationReceipt): boolean {
  return receipt.operation === "prompt.run" || receipt.operation === "prompt.retry";
}

function promptControlIndex(entries: ReceiptEntry[]): PromptControlIndex {
  const cancellationsByTarget = new Map<string, PromptCancelControl>();
  const retriesBySource = new Map<string, PromptRetryControl[]>();
  for (const entry of entries) {
    const output = objectRecord(entry.receipt.output);
    if (!output) continue;
    if (entry.receipt.operation === "prompt.cancel" && entry.receipt.status === "passed") {
      const targetReceiptId = output.targetReceiptId;
      if (typeof targetReceiptId !== "string") continue;
      const reason = typeof output.reason === "string" ? output.reason : undefined;
      cancellationsByTarget.set(targetReceiptId, {
        cancelReceiptId: entry.receipt.id,
        cancelReceiptPath: entry.path,
        ...(reason ? { reason } : {})
      });
      continue;
    }
    if (entry.receipt.operation === "prompt.retry") {
      const sourceReceiptId = output.sourceReceiptId;
      if (typeof sourceReceiptId !== "string") continue;
      const retryAttempt = typeof output.retryAttempt === "number" && Number.isInteger(output.retryAttempt) && output.retryAttempt > 0
        ? output.retryAttempt
        : 1;
      const reason = typeof output.reason === "string" ? output.reason : undefined;
      const retries = retriesBySource.get(sourceReceiptId) ?? [];
      retries.push({
        retryReceiptId: entry.receipt.id,
        retryReceiptPath: entry.path,
        sourceReceiptId,
        retryAttempt,
        ...(reason ? { reason } : {})
      });
      retriesBySource.set(sourceReceiptId, retries);
    }
  }
  return { cancellationsByTarget, retriesBySource };
}

function promptStatusJob(entry: ReceiptEntry, controls: PromptControlIndex = promptControlIndex([])): PromptStatusJob {
  const output = objectRecord(entry.receipt.output);
  const cancellation = controls.cancellationsByTarget.get(entry.receipt.id);
  const retryControl = promptRetryJobControl(entry.receipt);
  const state = cancellation ? "cancelled" : promptJobState(entry.receipt);
  const request = promptJobRequest(entry.receipt);
  const agentId = readStringRecordField(output, "agentId");
  const agentReceiptId = readStringRecordField(output, "agentReceiptId");
  const authoringJob = readAgentAuthoringJob(output?.authoringJob);
  const eventReplay = jobEventReplay(entry.receipt);
  const handoff = promptJobHandoff(entry, state, request, agentId, authoringJob, retryControl, eventReplay);
  const control: PromptJobControl | undefined = cancellation
    ? {
        cancelReceiptId: cancellation.cancelReceiptId,
        cancelReceiptPath: cancellation.cancelReceiptPath,
        ...(cancellation.reason ? { reason: cancellation.reason } : {})
      }
    : retryControl;
  const session = agentTranscriptSessionForTarget(entry, []);
  return {
    receiptId: entry.receipt.id,
    operation: entry.receipt.operation,
    status: entry.receipt.status,
    state,
    progress: renderProgress(entry.receipt.status === "not_run" ? 0 : 1, 1),
    packageId: entry.receipt.packageId,
    lane: entry.receipt.lane,
    createdAt: entry.receipt.createdAt,
    receiptPath: entry.path,
    request,
    ...(agentId ? { agentId } : {}),
    ...(agentReceiptId ? { agentReceiptId } : {}),
    ...(authoringJob ? { authoringJob } : {}),
    ...(session?.transcript ? { transcript: session.transcript } : {}),
    ...(handoff ? { handoff } : {}),
    ...(eventReplay ? { eventReplay } : {}),
    ...(control ? { control } : {}),
    warnings: entry.receipt.warnings
  };
}

function promptQueueJob(job: PromptStatusJob): PromptQueueJob {
  const availableActions: PromptQueueAction[] = [];
  if (job.state === "pending" || job.state === "running") {
    availableActions.push({ id: "cancel", command: "motion.prompt.cancel", receiptId: job.receiptId });
  }
  if (job.state === "failed" || job.state === "cancelled") {
    availableActions.push({ id: "retry", command: "motion.prompt.retry", receiptId: job.receiptId });
  }
  return { ...job, availableActions };
}

function promptRetryJobControl(receipt: OperationReceipt): PromptJobControl | undefined {
  if (receipt.operation !== "prompt.retry") return undefined;
  const output = objectRecord(receipt.output);
  if (!output) return undefined;
  const retryOfReceiptId = output.sourceReceiptId;
  if (typeof retryOfReceiptId !== "string") return undefined;
  const retryAttempt = typeof output.retryAttempt === "number" && Number.isInteger(output.retryAttempt) && output.retryAttempt > 0
    ? output.retryAttempt
    : undefined;
  const reason = typeof output.reason === "string" ? output.reason : undefined;
  return {
    retryOfReceiptId,
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(reason ? { reason } : {})
  };
}

function promptJobHandoff(
  entry: ReceiptEntry,
  state: RenderJobState,
  request: string,
  agentId: string | undefined,
  authoringJob: AgentAuthoringJob | undefined,
  retryControl: PromptJobControl | undefined,
  eventReplay: JobEventReplay | undefined
): PromptJobHandoff | undefined {
  if (state !== "pending" && state !== "running") return undefined;
  const output = objectRecord(entry.receipt.output);
  const sourceReceiptPath = readStringRecordField(output, "sourceReceiptPath");
  return {
    schema: "shellx-motion/prompt-job-handoff@1",
    jobId: entry.receipt.id,
    receiptId: entry.receipt.id,
    receiptPath: entry.path,
    operation: entry.receipt.operation,
    packageId: entry.receipt.packageId,
    lane: entry.receipt.lane,
    state,
    createdAt: entry.receipt.createdAt,
    inputHashes: entry.receipt.inputHashes,
    request,
    ...(agentId ? { agentId } : {}),
    ...(authoringJob ? { authoringJob } : {}),
    ...(retryControl?.retryOfReceiptId ? { sourceReceiptId: retryControl.retryOfReceiptId } : {}),
    ...(sourceReceiptPath ? { sourceReceiptPath } : {}),
    ...(eventReplay ? { eventReplay } : {}),
    ...(retryControl?.retryAttempt !== undefined ? { retryAttempt: retryControl.retryAttempt } : {})
  };
}

function promptJobRequest(receipt: OperationReceipt): string {
  const output = objectRecord(receipt.output);
  const requestSummary = readStringRecordField(output, "requestSummary");
  if (requestSummary) return requestSummary;
  // Explicit legacy adapter for pre-retention prompt receipts.
  const request = readStringRecordField(output, "request");
  if (request) return request;
  const planTopic = readStringRecordField(output, "planTopic");
  if (planTopic) return planTopic;
  return "unknown prompt request";
}

function promptJobState(receipt: OperationReceipt): RenderJobState {
  const output = objectRecord(receipt.output);
  const outputState = readStringRecordField(output, "state");
  if (outputState === "running") return "running";
  if (receipt.status === "not_run") return "pending";
  if (receipt.status === "failed") return "failed";
  if (receipt.status === "passed" || receipt.status === "warning") return "succeeded";
  return "failed";
}

function readAgentAuthoringJob(value: unknown): AgentAuthoringJob | undefined {
  const record = objectRecord(value);
  return record?.schema === "shellx-motion/agent-authoring-job@1" ? value as AgentAuthoringJob : undefined;
}

function promptStateCounts(jobs: PromptStatusJob[]): RenderStateCounts {
  const counts = emptyRenderStateCounts();
  for (const job of jobs) {
    counts[job.state] += 1;
  }
  return counts;
}

function isRenderJobReceipt(receipt: OperationReceipt): boolean {
  return receipt.operation === "render.final" || receipt.operation === "render.batch" || receipt.operation === "render.retry";
}

function renderControlIndex(entries: ReceiptEntry[]): RenderControlIndex {
  const cancellationsByTarget = new Map<string, RenderCancelControl>();
  const retriesBySource = new Map<string, RenderRetryControl[]>();
  for (const entry of entries) {
    const output = objectRecord(entry.receipt.output);
    if (!output) continue;
    if (entry.receipt.operation === "render.cancel" && entry.receipt.status === "passed") {
      const targetReceiptId = output.targetReceiptId;
      if (typeof targetReceiptId !== "string") continue;
      const reason = typeof output.reason === "string" ? output.reason : undefined;
      cancellationsByTarget.set(targetReceiptId, {
        cancelReceiptId: entry.receipt.id,
        cancelReceiptPath: entry.path,
        ...(reason ? { reason } : {})
      });
      continue;
    }
    if (entry.receipt.operation === "render.retry") {
      const sourceReceiptId = output.sourceReceiptId;
      if (typeof sourceReceiptId !== "string") continue;
      const retryAttempt = typeof output.retryAttempt === "number" && Number.isInteger(output.retryAttempt) && output.retryAttempt > 0
        ? output.retryAttempt
        : 1;
      const reason = typeof output.reason === "string" ? output.reason : undefined;
      const retries = retriesBySource.get(sourceReceiptId) ?? [];
      retries.push({
        retryReceiptId: entry.receipt.id,
        retryReceiptPath: entry.path,
        sourceReceiptId,
        retryAttempt,
        ...(reason ? { reason } : {})
      });
      retriesBySource.set(sourceReceiptId, retries);
    }
  }
  return { cancellationsByTarget, retriesBySource };
}

function renderStatusJob(entry: ReceiptEntry, controls: RenderControlIndex = renderControlIndex([])): RenderStatusJob {
  const progress = renderJobProgress(entry.receipt);
  const cancellation = controls.cancellationsByTarget.get(entry.receipt.id);
  const retryControl = renderRetryJobControl(entry.receipt);
  const qualityManifest = renderQualityManifestSummary(entry.receipt);
  const state = cancellation ? "cancelled" : renderJobState(entry.receipt, progress);
  const outputPath = readReceiptOutputPath(entry.receipt);
  const eventReplay = jobEventReplay(entry.receipt);
  const handoff = renderJobHandoff(entry, state, outputPath, retryControl, eventReplay);
  const control: RenderJobControl | undefined = cancellation
    ? {
        cancelReceiptId: cancellation.cancelReceiptId,
        cancelReceiptPath: cancellation.cancelReceiptPath,
        ...(cancellation.reason ? { reason: cancellation.reason } : {})
      }
    : retryControl;
  return {
    receiptId: entry.receipt.id,
    operation: entry.receipt.operation,
    status: entry.receipt.status,
    state,
    progress,
    packageId: entry.receipt.packageId,
    lane: entry.receipt.lane,
    createdAt: entry.receipt.createdAt,
    receiptPath: entry.path,
    ...(outputPath ? { outputPath } : {}),
    ...(handoff ? { handoff } : {}),
    ...(eventReplay ? { eventReplay } : {}),
    ...(qualityManifest ? { qualityManifest } : {}),
    ...(control ? { control } : {}),
    warnings: entry.receipt.warnings
  };
}

function renderQueueJob(job: RenderStatusJob): RenderQueueJob {
  const availableActions: RenderQueueAction[] = [];
  if (job.state === "pending" || job.state === "running") {
    availableActions.push({ id: "cancel", command: "motion.render.cancel", receiptId: job.receiptId });
  }
  if (job.state === "failed" || job.state === "cancelled") {
    availableActions.push({ id: "retry", command: "motion.render.retry", receiptId: job.receiptId });
  }
  return { ...job, availableActions };
}

function renderRetryJobControl(receipt: OperationReceipt): RenderJobControl | undefined {
  if (receipt.operation !== "render.retry") return undefined;
  const output = objectRecord(receipt.output);
  if (!output) return undefined;
  const retryOfReceiptId = output.sourceReceiptId;
  if (typeof retryOfReceiptId !== "string") return undefined;
  const retryAttempt = typeof output.retryAttempt === "number" && Number.isInteger(output.retryAttempt) && output.retryAttempt > 0
    ? output.retryAttempt
    : undefined;
  const reason = typeof output.reason === "string" ? output.reason : undefined;
  return {
    retryOfReceiptId,
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(reason ? { reason } : {})
  };
}

function renderJobHandoff(
  entry: ReceiptEntry,
  state: RenderJobState,
  outputPath: string | undefined,
  retryControl: RenderJobControl | undefined,
  eventReplay: JobEventReplay | undefined
): RenderJobHandoff | undefined {
  if (state !== "pending" && state !== "running") return undefined;
  const output = objectRecord(entry.receipt.output);
  const sourceReceiptPath = readStringRecordField(output, "sourceReceiptPath");
  return {
    schema: "shellx-motion/render-job-handoff@1",
    jobId: entry.receipt.id,
    receiptId: entry.receipt.id,
    receiptPath: entry.path,
    operation: entry.receipt.operation,
    packageId: entry.receipt.packageId,
    lane: entry.receipt.lane,
    state,
    createdAt: entry.receipt.createdAt,
    inputHashes: entry.receipt.inputHashes,
    ...(outputPath ? { outputPath } : {}),
    ...(retryControl?.retryOfReceiptId ? { sourceReceiptId: retryControl.retryOfReceiptId } : {}),
    ...(sourceReceiptPath ? { sourceReceiptPath } : {}),
    ...(eventReplay ? { eventReplay } : {}),
    ...(retryControl?.retryAttempt !== undefined ? { retryAttempt: retryControl.retryAttempt } : {})
  };
}

function renderJobProgress(receipt: OperationReceipt): RenderJobProgress {
  const childJobs = readRenderChildJobs(receipt);
  if (childJobs.length > 0) {
    const completed = childJobs.filter((job) => isCompletedRenderChildStatus(job.status)).length;
    return renderProgress(completed, childJobs.length);
  }
  return renderProgress(receipt.status === "not_run" ? 0 : 1, 1);
}

function renderJobState(receipt: OperationReceipt, progress: RenderJobProgress): RenderJobState {
  const childStatuses = readRenderChildJobs(receipt).map((job) => job.status);
  if (receipt.status === "failed" || childStatuses.some((status) => status === "failed")) return "failed";
  if (childStatuses.some((status) => status === "cancelled")) return "cancelled";
  if (receipt.status === "passed" || receipt.status === "warning") return "succeeded";
  if (childStatuses.some((status) => status === "running")) return "running";
  if (progress.completed > 0 && progress.completed < progress.total) return "running";
  return "pending";
}

function readRenderChildJobs(receipt: OperationReceipt): Array<{ status: string }> {
  const jobs = objectRecord(receipt.output)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const childJobs: Array<{ status: string }> = [];
  for (const job of jobs) {
    const status = objectRecord(job)?.status;
    if (typeof status === "string") childJobs.push({ status });
  }
  return childJobs;
}

function renderQualityManifestSummary(receipt: OperationReceipt): RenderQualityManifestSummary | undefined {
  const output = objectRecord(receipt.output);
  if (!output) return undefined;
  const summary: RenderQualityManifestSummary = {};
  const path = readStringRecordField(output, "qualityManifestPath") ?? readStringRecordField(output, "qualityManifestAppliedPath");
  if (path) summary.path = path;
  assignQualityCheckSummary(summary, objectRecord(output.qualityCheck));

  if (Array.isArray(output.jobs)) {
    const rows = output.jobs
      .map((job) => renderQualityManifestRowSummary(objectRecord(job)))
      .filter((row): row is RenderQualityManifestRowSummary => row !== undefined);
    if (rows.length > 0) summary.rows = rows;
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function renderQualityManifestRowSummary(job: Record<string, unknown> | null): RenderQualityManifestRowSummary | undefined {
  if (!job) return undefined;
  const summary: RenderQualityManifestRowSummary = {};
  const rowId = readStringRecordField(job, "rowId");
  const packageId = readStringRecordField(job, "packageId");
  const path = readStringRecordField(job, "qualityManifestAppliedPath") ?? readStringRecordField(job, "qualityManifestPath");
  if (rowId) summary.rowId = rowId;
  if (packageId) summary.packageId = packageId;
  if (path) summary.path = path;
  assignQualityCheckSummary(summary, objectRecord(job.qualityCheck));
  return Object.keys(summary).length > 0 && (summary.path || summary.status || summary.receiptId || summary.hostReceiptPath || summary.code || summary.message)
    ? summary
    : undefined;
}

function assignQualityCheckSummary(
  target: RenderQualityManifestSummary | RenderQualityManifestRowSummary,
  qualityCheck: Record<string, unknown> | null
): void {
  if (!qualityCheck) return;
  const error = objectRecord(qualityCheck.error);
  const status = readStringRecordField(qualityCheck, "status");
  const receiptId = readStringRecordField(qualityCheck, "receiptId");
  const hostReceiptPath = readStringRecordField(qualityCheck, "hostReceiptPath");
  const code = readStringRecordField(qualityCheck, "code") ?? readStringRecordField(error, "code");
  const message = readStringRecordField(qualityCheck, "message") ?? readStringRecordField(error, "message");
  if (status) target.status = status;
  if (receiptId) target.receiptId = receiptId;
  if (hostReceiptPath) target.hostReceiptPath = hostReceiptPath;
  if (code) target.code = code;
  if (message) target.message = message;
}

function jobEventReplay(receipt: OperationReceipt): JobEventReplay | undefined {
  const output = objectRecord(receipt.output);
  if (!output) return undefined;
  const eventLogPath = readStringRecordField(output, "eventLogPath") ?? readStringRecordField(output, "eventsPath");
  const events = Array.isArray(output.events)
    ? output.events
        .map((event) => objectRecord(event))
        .filter((event): event is Record<string, unknown> => event !== null)
    : [];
  const inferredLastSeq = events.reduce<number | undefined>((maxSeq, event) => {
    const seq = readNonNegativeIntegerRecordField(event, "seq");
    if (seq === undefined) return maxSeq;
    return maxSeq === undefined ? seq : Math.max(maxSeq, seq);
  }, undefined);
  const eventCount = readNonNegativeIntegerRecordField(output, "eventCount") ?? (events.length > 0 ? events.length : undefined);
  const lastSeq = readNonNegativeIntegerRecordField(output, "lastEventSeq")
    ?? readNonNegativeIntegerRecordField(output, "lastSeq")
    ?? inferredLastSeq;
  const lastEventAt = readStringRecordField(output, "lastEventAt");
  if (!eventLogPath && eventCount === undefined && lastSeq === undefined && !lastEventAt) return undefined;
  const replayLastSeq = lastSeq ?? 0;
  return {
    schema: "shellx-motion/job-event-replay@1",
    ...(eventLogPath ? { eventLogPath } : {}),
    eventCount: eventCount ?? 0,
    lastSeq: replayLastSeq,
    ...(lastEventAt ? { lastEventAt } : {}),
    reconnectCursor: {
      receiptId: receipt.id,
      sinceSeq: replayLastSeq
    }
  };
}

function readStringRecordField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNonNegativeIntegerRecordField(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isCompletedRenderChildStatus(status: string): boolean {
  return status === "passed"
    || status === "warning"
    || status === "succeeded"
    || status === "failed"
    || status === "skipped"
    || status === "cancelled";
}

function renderProgress(completed: number, total: number): RenderJobProgress {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeCompleted = Math.min(safeTotal, Math.max(0, Math.trunc(completed)));
  return {
    completed: safeCompleted,
    total: safeTotal,
    percent: safeTotal === 0 ? 0 : Math.round((safeCompleted / safeTotal) * 100)
  };
}

function renderStateCounts(jobs: RenderStatusJob[]): RenderStateCounts {
  const counts = emptyRenderStateCounts();
  for (const job of jobs) {
    counts[job.state] += 1;
  }
  return counts;
}

function emptyRenderStateCounts(): RenderStateCounts {
  // Built from the contract rather than by hand: a hand-written literal is exactly how the
  // counts drifted out of step with the state union in the first place.
  return Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as RenderStateCounts;
}

function readReceiptOutputPath(receipt: OperationReceipt): string | undefined {
  const path = objectRecord(receipt.output)?.path;
  return typeof path === "string" ? path : undefined;
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "receipt";
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}


async function isUnsafePackageOutputDir(packageRoot: string, outputDir: string): Promise<boolean> {
  const [packagePath, outputPath] = await Promise.all([
    canonicalPathForSafety(packageRoot),
    canonicalPathForSafety(outputDir)
  ]);
  return isPathInsideOrEqual(packagePath, outputPath) || isPathInsideOrEqual(outputPath, packagePath);
}

async function isPathInsideTrustedRoot(root: string, candidate: string): Promise<boolean> {
  const [rootPath, candidatePath] = await Promise.all([
    canonicalPathForSafety(root),
    canonicalPathForSafety(candidate)
  ]);
  return isPathInsideOrEqual(rootPath, candidatePath);
}

async function isEmptyOrAbsentDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT") return true;
    if (code === "ENOTDIR") return false;
    throw error;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !Reflect.has(error, "code")) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(await canonicalPathForSafety(parent), basename(resolved));
  }
}

function frameCountFor(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

function frameTimestampMs(frameIndex: number, fps: number, durationMs: number): number {
  const atMs = Math.round((frameIndex * 1000) / fps);
  return Math.max(0, Math.min(atMs, Math.max(0, durationMs - 1)));
}

function stripFrameTimestampMs(frameIndex: number, frameCount: number, startMs: number, endMs: number): number {
  if (frameCount <= 1) return Math.round(startMs);
  return Math.round(startMs + ((endMs - startMs) * frameIndex) / (frameCount - 1));
}

function sequenceFrameIndexForAtMs(atMs: number, durationMs: number, fps: number): number {
  const frameCount = frameCountFor(durationMs, fps);
  if (!Number.isFinite(atMs) || atMs <= 0) return 0;
  const clampedAtMs = Math.min(atMs, Math.max(0, durationMs - 1));
  const frameIndex = Math.round((clampedAtMs / 1000) * fps);
  return Math.max(0, Math.min(frameIndex, frameCount - 1));
}

function frameFileName(frameIndex: number): string {
  return `${String(frameIndex + 1).padStart(6, "0")}.png`;
}

function invalidArgs(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "invalid_args", message },
    warnings: []
  };
}
