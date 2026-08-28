import { isDirectEntry } from "./entry-point.js";
import { SIGINT_EXIT_CODE, withInterruptSignal } from "./interrupt";
import { throwIfCancelled, withRenderCancellation } from "./render-cancelled";
import { exportPresetsCommand, isHelpCommand, isVersionCommand, versionCommand } from "./cli-command-metadata";
import { connectorDiscoveryCommand, runtimeProbeCommand } from "./connector-discovery-cli";
import { parseBooleanOption, parseStrictBooleanOption } from "./cli-boolean-options";
import { receiptRootIsInsidePackage } from "./cli-receipt-root-safety";
import { nativeDeliveryRefusal, unsupportedFrameLaneMessage, unsupportedPreviewLaneMessage, unsupportedRenderLaneMessage } from "./lane-errors";
import { resolveCallerId } from "./caller-identity";
import { doctorCommand } from "./doctor-command";
import { jobCommand } from "./job-command";
import { retiredSimulationRefusal } from "./retired-options";
import { batchResumeSourceReceiptPath, readBatchResumeMatch } from "./batch-resume";
import { admitCliBatchOutput } from "./batch-output-admission";
import { batchTemplateQualityManifestRef } from "./batch-package-sidecar";
import {
  batchRenderErrorEnvelope,
  readRenderBatchChildDelivery,
  readRenderCommitUncertainDelivery,
  renderBatchBookkeepingDeliveryFields,
  renderBatchChildDeliveryJobFields,
  renderBatchFailureReceipt,
  renderCommitUncertainJobFields,
  renderCommitUncertainReceiptJobFields,
  renderCommitUncertainResponseFields,
  renderCommitUncertainWarnings
} from "./render-batch-delivery-uncertainty";
import { gpuBatchFrameTransport, gpuBatchPreflightRefusal, readBatchFrameLane, type BatchFrameLane } from "./gpu-batch-policy";
import { activeScriptCliRefusal } from "./agent-script-cli-refusal";
import { batchQualityInputEvidence, prepareBatchQualityManifestSnapshot, publishBatchQualityManifestSnapshot, type BatchQualityInputEvidence, type PublishedBatchQualityManifestSnapshot } from "./batch-quality-manifest";
import { enrichRenderReceiptWithQualityManifest, remapRetainedQualityInputPaths, retainQualityManifestForEvaluation } from "./quality-manifest-retention";
import { unhandledFailure } from "./unhandled-failure";
import { packageValidationResult } from "./package-refusals";
import { withHostJob } from "./render-host-job";
import { renderFpsArgumentRefusal } from "./render-cli-options";
import { templateToCutArgumentRefusal } from "./template-to-cut-cli-options";
import { p2bConnectorArgumentRefusal, redactP2bConnectorInputError } from "./p2b-connector-cli-options";
import { NamedConnectorRegistryError, runNamedP2ConnectorThroughRegistry } from "./named-p2-connector-registry";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { findActionMatch, guideAction, planAction, type MotionPermissionTier } from "@shellx-motion/actions";
import { planCutImport } from "@shellx-motion/adapters-cut";
import { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "@shellx-motion/adapters-html";
import { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "@shellx-motion/adapters-otio";
import { buildAgentRuntime, type AgentRuntime } from "@shellx-motion/agent-runtime";
import {
  runCanvasBridgeFrameSelectionExport,
  runCanvasToCutConnector,
  runCutGenerateToCutConnector,
  runCanvasMp4Export,
  runScriptToCutConnector,
  runSourceToCutConnector,
  runTemplateToCutConnector,
  readCutImportModeRequest,
  cutTargetCapabilitiesForMode,
  packageAudioEncodeInput
} from "@shellx-motion/connectors";
import {
  createMotionPackage,
  createPackageValidationReceipt,
  MotionOutputGuardError,
  createPreviewReceipt,
  audioQualityMeasurementRequired,
  evaluateAudioQuality,
  buildVisualDiffPng,
  comparePngFiles,
  expandMotionPackageRows,
  filterMotionDataRows,
  canonicalJsonSha256,
  acquireDerivedOutputPublication,
  hashBuffer,
  hashFile,
  hashPackageFile,
  inspectPngFile,
  inspectPngFileRegion,
  inspectFrameSequence,
  inspectMotionTimeline,
  integrationCapabilitiesForHost,
  loadDataRowsFile,
  escalateReceiptStatusForWarnings,
  jobOutcomeForReceiptStatus,
  loadMotionPackage,
  loadStableRenderPackage,
  bindFinalRenderReceiptLineage,
  loadPackageDataRows,
  negotiateIntegrationCapabilities,
  parseIntegrationCapabilities,
  buildBrowserRecordingManifest,
  browserRecordingSampleTimes,
  copyVerifiedPackageAssetSnapshots,
  replaceTemplateMedia,
  resolvePackageAsset,
  validatePackageAssetReferences,
  summarizeFrameQuality,
  applyTemplateValues,
  applyReceiptActor,
  activeScriptLayers,
  listTemplateControls,
  timelineLayerMutedTrackId,
  timelineLayerSoloedTrackId,
  materializedFrameSequenceStaticRefusal,
  preflightMaterializedFrameSequence,
  extractMotionPackageArchive,
  writeMotionPackageArchive,
  writeReviewBundle,
  type BrowserWorkflowDriftSummary,
  type AudioQualityThresholds,
  type ExpandedMotionJob,
  type MotionDataRow,
  type MaterializedFrameSequencePreflightOptions,
  type NetworkAddressResolver,
  type OperationReceipt,
  type ReceiptArtifact,
  type SourceImportFetcher
} from "@shellx-motion/core";
import { annotatePlanWithArgumentContracts, dispatchDebugCommand, hasStableReceiptStoreCapability, rawPromptRetentionAdmissionError, recordReceiptFfprobeProvenance, reserveStableReceiptRoot, type BrowserFrameRenderer, type MotionDebugCommand, type ReceiptActor } from "@shellx-motion/debug-api";
import { assertPackageEditSourceTree, commitPackageEdit } from "@shellx-motion/debug-api/internal/package-edit-transaction";
import { MODULAR_DEBUG_COMMANDS, hydrateModularDebugArgs, invalidModularDebugArgs, modularDebugArgs } from "./modular-debug-cli";
import { promptRetentionFromCli } from "./prompt-retention-cli";
import { revisionTransactionDebugArgs, revisionTransactionPlanDebugArgs } from "./revision-transaction-cli";
import { cliAuthoringRoots } from "./debug-authoring-roots";
import { debugCommandName } from "./debug-subcommands";
import { debugRenderCachePlanArgs } from "./debug-render-cache-plan-args"; import { debugPackageAssetImportArgs } from "./debug-package-asset-import-cli";
import { timelineTransitionDebugArgs } from "./timeline-transition-cli";
import { cliDebugDispatchContext, debugRenderRoots, debugScratchRoot, debugTrustedInputRoots, sourceWorkspaceOperationPaths, withCliSourceWorkspaceAnchor } from "./debug-context-cli"; import { createCliTimelineHostReceiptStore } from "./shape-geometry-keyframes-host-receipt";
import { helpCommand } from "./help-command";
import { renderGpuPointsPreviewCli } from "./gpu-preview-cli";
import { previewCommandAdmissionRefusal } from "./gpu-preview-scene3d-refusal";
import { mediaTypeForPath, publishJsonSidecar } from "./sidecar-publication";
import { PairedOutputReceiptCommitUncertainError, PairedOutputReceiptPublication } from "./paired-output-receipt-publication";
import {
  corePublicationUncertaintyFields,
  pairedPublicationUncertaintyError,
  pairedPublicationUncertaintyFields
} from "./cli-publication-uncertainty";
import { batchRenderCounts, renderBatchBookkeepingFailure } from "./render-batch-bookkeeping";
import { batchJobIdempotencyKey, batchPresetSummary, batchWorkflowIdempotencyHash, planBatchRenderPresets } from "./render-batch-plan";
import { DirectoryBundleCommitUncertainError, publishGovernedDirectoryBundle } from "./governed-directory-delivery";
import { captureBrowserCommand as captureBrowserCommandImpl } from "./browser-capture-command";
import { resolveCliInputPath as resolveInputPath, resolveCliOutputPath as resolveOutputPath } from "./cli-path-resolution";
// Browser-capture workflow decoding lives in ./browser-workflow-decode to satisfy the module-size gate.
import { readBrowserCaptureWorkflow } from "./browser-workflow-decode";
// Shared non-destructive output policy: `--out` directories (the output-directory ownership invariant), the encode lane's `--out` file
// (the file-output ownership invariant) and the encoder's frame scratch (the frame-output ownership invariant).
import { materializedDeliveryRefusal, outputFileRefusal, prepareOutputDir } from "./output-dir-guard";
import { FrameLaneWarnings } from "./frame-lane-warnings";
import {
  browserWorkflowEvidenceFromFrame,
  browserWorkflowResultFields,
  enrichRenderReceiptWithBrowserWorkflow,
  renderBrowserFrameBatch
} from "./render-browser-frame-batch";
import { renderMaterializedFinalVideo, withoutTransientFrameSourcePaths } from "./render-final-video-materialized";
import {
  abortPreparedRenderCatalog,
  commitPreparedRenderCatalog,
  dedupeReceiptArtifacts,
  prepareRenderReceipt,
  renderReceiptPathForOutput,
  writeRenderReceiptFile,
  type BrowserWorkflowRenderEvidence,
  type RenderReceiptFinalizeResult
} from "./render-receipt-file";
import {
  availableRendererArtifacts,
  bindDirectoryRendererArtifacts,
  closedDirectoryBundleInventory,
  prepareImageSequencePublication,
  publishFailedImageSequenceBundle,
  readMinUniqueFrameHashes,
  rebindDirectoryReceiptPaths,
  relativeBundleFilePath,
  remapFfmpegOutputPath,
  remapPrivatePublicationResultPaths,
  remapReceiptOutputPath,
  renderQualityManifestFailure,
  workflowCatalogFields
} from "./render-delivery-publication-support";
import {
  redactExpiredRawPrompt,
  runMotionPrompt,
  type MotionPromptRuntime,
  type PromptRunReceipt
} from "@shellx-motion/prompt";
import {
  browserTypographyAttestationRefusal,
  createMotionBrowserRenderSession,
  renderMotionBrowserFrame,
  type BrowserCaptureWorkflow
} from "@shellx-motion/renderer-browser";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import {
  audioWarningsForExportPreset,
  checkFfmpeg,
  createImageSequenceReceipt,
  createGovernedFfmpegRunner,
  createStillFrameReceipt,
  ffmpegPresetOutputPathError,
  frameExtractionArgs,
  frameExtractionInputArgs,
  frameExtractionPngOutputArgs,
  readFfmpegExportPreset,
  readImageSequenceExportPreset,
  readMotionExportPreset,
  readStillFrameExportPreset,
  measureAudioLevels,
  probeMedia,
  resolveExportPreset,
  resolveMotionExportPreset,
  resolveFfmpegExecutable,
  planFinalVideoFrameTransport,
  planStreamingFinalCommand,
  preliminaryGpuAudio,
  renderSegmentedFinal,
  renderStreamingFinal,
  stillFrameOutputPathError,
  type MotionExportPreset,
  type FfmpegExportPreset,
  type FfmpegCommand,
  type FfmpegProcessResult,
  type FfmpegRunner,
  type StreamingFinalToolPolicy
} from "@shellx-motion/renderer-ffmpeg";
import { withSegmentedFinalCliPublication } from "@shellx-motion/renderer-ffmpeg/internal/segmented-final-cli-publication";
import { createNativeRenderSession, renderNativePreviewFrame } from "@shellx-motion/renderer-native";
import { withNativePrivateOutputPublication } from "@shellx-motion/renderer-native/internal/private-output-publication";
export type CliResult = Record<string, unknown> & { ok: boolean; command?: string };
export interface RunCliOptions {
  ffmpegRunner?: FfmpegRunner;
  /**
   * Optional host override for prompt commands. The source CLI deliberately supplies its real local
   * runtime when this is absent; raw Debug API/MCP hosts must inject one themselves and fail closed.
   */
  promptRuntime?: MotionPromptRuntime;
  /**
   * Host-only raw-retention admission seam. The shell CLI always uses the descriptor-relative
   * receipt-store capability; callers cannot select this with a command-line argument.
   */
  hasStableReceiptPurgeCapability?: () => boolean;
  /** Host-only prompt clock seam for direct-CLI retention tests; the shell CLI uses wall time. */
  promptNow?: () => string;
  /** Test-only host hook before each direct raw-prompt receipt write; never CLI input. */
  promptReceiptWriteTestHook?: (receipt: OperationReceipt) => Promise<void> | void;
  /**
   * Agent runtime for `agent health` / `debug agent-health`.
   *
   * Exists so a suite can probe scripted adapters without a subscription CLI installed. It replaced
   * the `--adapter fake` flag, which let any caller of the shipped binary produce a "ready" agent
   * report for an agent that does not exist. An embedder passing this
   * has made a deliberate choice; a command-line flag hid the same choice from whoever read the
   * output.
   */
  agentRuntime?: AgentRuntime;
  browserFrameRenderer?: BrowserFrameRenderer;
  sourceFetcher?: SourceImportFetcher;
  sourceResolver?: NetworkAddressResolver;
  scratchRoot?: string;
  trustedLocalTier?: boolean;
  /**
   * Cancels in-flight work. Supplied by the CLI entry point from SIGINT/SIGTERM, and by hosts
   * that drive `runCli` directly. Without it a Ctrl-C left the encode and the browser running.
   */
  signal?: AbortSignal;
  /** Stable owner identity; `--caller-id` overrides. See docs/public/host-integration.md. */
  callerId?: string;
  /**
   * The id this invocation's job will be known by, so a host can query it while the render runs.
   *
   * `--job-id` on the command line wins, for the same reason `--caller-id` does: an operator
   * running one command is the most specific statement of intent.
   */
  jobId?: string;
  /** Host-owned resource evidence/override; CLI arguments and packages cannot set this. */
  materializedFrameSequencePreflight?: MaterializedFrameSequencePreflightOptions;
  /**
   * Programmatic test/host seam for the streamed FFmpeg stdin process. There is deliberately no
   * command-line flag: the shell CLI always uses the contained production process launcher.
   */
  streamingProcessFactory?: StreamingFinalToolPolicy["processFactory"];
  retainedBatchQualityManifest?: { published: PublishedBatchQualityManifestSnapshot; evidence: BatchQualityInputEvidence };
  /** Internal integration-test seams; the shell surface never admits fault injection. */
  batchTestHooks?: {
    beforePostRenderAssert?: () => Promise<void> | void;
    beforeRowReceiptWrite?: () => Promise<void> | void;
    beforeNextRow?: () => Promise<void> | void;
    beforeAggregateReceiptWrite?: () => Promise<void> | void;
  };
}
export async function runCli(rawArgv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const argv = normalizeArgv(rawArgv);
  const retiredSimulation = retiredSimulationRefusal(argv);
  if (retiredSimulation) return retiredSimulation;
  const [command, ...rest] = argv;
  if (isHelpCommand(command)) {
    return helpCommand();
  }

  if (isVersionCommand(command)) {
    return versionCommand();
  }

  if (command === "integration-capabilities") {
    return integrationCapabilitiesCommand(rest);
  }

  if (command === "runtime-probe") {
    return runtimeProbeCommand(rest);
  }

  if (command === "validate") {
    return validateCommand(rest);
  }
  if (command === "package-create") {
    return packageCreateCommand(rest);
  }
  if (command === "inspect") {
    return inspectCommand(rest);
  }
  if (command === "actions") {
    return actionsCommand(rest);
  }
  if (command === "debug") {
    return debugCommand(rest, options);
  }
  if (command === "template") {
    return templateCommand(rest);
  }
  if (command === "agent") {
    return agentCommand(rest, options);
  }
  if (command === "prompt") {
    return promptCommand(rest, options);
  }
  if (command === "preview") {
    return previewCommand(rest, options);
  }
  if (command === "capture-browser") {
    return captureBrowserCommandImpl(rest, options);
  }
  if (command === "render") {
    // One invocation is one observable job; internal governed operations do not become host jobs.
    return renderFpsArgumentRefusal(rest) ?? await (withHostJob({
      ...(optionValue(rest, "--job-id") ? { jobId: optionValue(rest, "--job-id")! } : {}),
      ...(resolveCallerId(rest, options) ? { callerId: resolveCallerId(rest, options)! } : {}),
      lane: optionValue(rest, "--lane") ?? "ffmpeg",
      operation: "render.final"
    }, () => withRenderCancellation(() => renderCommand(rest, options), {
      signal: options.signal,
      lane: optionValue(rest, "--lane") ?? "ffmpeg",
      frameLane: optionValue(rest, "--frame-lane"),
      outputPath: optionValue(rest, "--out")
    }) as Promise<CliResult>) as Promise<CliResult>);
  }
  if (command === "doctor") {
    // Answers "why does nothing work" before a render is ever attempted.
    return doctorCommand(rest, { ...(options.ffmpegRunner ? { ffmpegRunner: options.ffmpegRunner } : {}), ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}), ...(options.signal ? { signal: options.signal } : {}) }) as Promise<CliResult>;
  }
  if (command === "job") {
    // Answers from the per-user job stores, so a host can ask about a render started by a
    // different process — which is the only way a progress display can work at all.
    return jobCommand(rest, options) as Promise<CliResult>;
  }
  if (command === "export-presets") {
    return exportPresetsCommand();
  }
  if (command === "review-html-bundle") {
    return reviewHtmlBundleCommand(rest);
  }
  if (command === "html-snippet-export") {
    return htmlSnippetExportCommand(rest);
  }
  if (command === "html-snippet-import") {
    const htmlPath = rest[0];
    const packageDir = optionValue(rest, "--out") ?? optionValue(rest, "--package") ?? optionValue(rest, "--package-dir");
    return await withCliSourceWorkspaceAnchor(
      htmlPath && packageDir ? [resolveInputPath(htmlPath), resolveOutputPath(packageDir)] : undefined,
      async () => await htmlSnippetImportCommand(rest),
    );
  }
  if (command === "otio-export") {
    return otioExportCommand(rest);
  }
  if (command === "otio-import") {
    return otioImportCommand(rest);
  }
  if (command === "package-archive") {
    return packageArchiveCommand(rest);
  }
  if (command === "package-extract") {
    return packageExtractCommand(rest);
  }
  if (command === "quality-check") {
    return qualityCheckCommand(rest, options);
  }
  if (command === "render-batch") {
    return withHostJob({
      ...(optionValue(rest, "--job-id") ? { jobId: optionValue(rest, "--job-id")! } : {}),
      ...(resolveCallerId(rest, options) ? { callerId: resolveCallerId(rest, options)! } : {}),
      lane: "batch",
      operation: "render.batch"
    }, () => renderBatchCommand(rest, options)) as Promise<CliResult>;
  }
  if (command === "plan-import") {
    return planImportCommand(rest);
  }
  if (command === "connector") {
    const discovery = connectorDiscoveryCommand(rest);
    if (discovery) return discovery;
    // One connector invocation is one observable job; P2A/P2B invalid options are refused first so rejected flags never become polling artifacts. Browser/FFmpeg work stays internal.
    const p2bArgumentRefusal = p2bConnectorArgumentRefusal(rest);
    if (p2bArgumentRefusal) return p2bArgumentRefusal;
    const templateArgumentRefusal = templateToCutArgumentRefusal(rest);
    if (templateArgumentRefusal) return templateArgumentRefusal;
    const connectorOperation = CONNECTOR_HOST_JOB_OPERATIONS[rest[0] ?? ""];
    if (!connectorOperation) return connectorCommand(rest, options);
    return withHostJob({
      ...(optionValue(rest, "--job-id") ? { jobId: optionValue(rest, "--job-id")! } : {}),
      ...(resolveCallerId(rest, options) ? { callerId: resolveCallerId(rest, options)! } : {}),
      lane: "connector",
      operation: connectorOperation
    }, () => connectorCommand(rest, options)) as Promise<CliResult>;
  }

  return {
    ok: false,
    error: {
      code: "unknown_command",
      message: `Unknown command: ${command ?? "(missing)"}.`
    }
  };
}

async function integrationCapabilitiesCommand(argv: string[]): Promise<CliResult> {
  const capabilities = integrationCapabilitiesForHost("shellx-motion");
  const peerPath = optionValue(argv, "--peer");
  if (!peerPath) {
    return { ok: true, command: "integration-capabilities", capabilities };
  }
  try {
    const peer = parseIntegrationCapabilities(
      JSON.parse(await readFile(resolveInputPath(peerPath), "utf8"))
    );
    const requiredModes = optionValues(argv, "--require-mode");
    const negotiation = negotiateIntegrationCapabilities(capabilities, peer, requiredModes);
    return negotiation.ok
      ? { ok: true, command: "integration-capabilities", capabilities, peer, negotiation }
      : {
          ok: false,
          command: "integration-capabilities",
          capabilities,
          peer,
          negotiation,
          error: negotiation.error
        };
  } catch (error) {
    return {
      ok: false,
      command: "integration-capabilities",
      capabilities,
      error: {
        code: "invalid_integration_capabilities",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

/**
 * `package-create` — the cold start.
 *
 * Every other authoring command edits a package that already exists, and every route that made one
 * was an importer. An agent asked to build something original had no first step; this is it.
 */
async function packageCreateCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("package-create", "target directory");
  const width = optionValue(argv, "--width");
  const height = optionValue(argv, "--height");
  const fps = optionValue(argv, "--fps");
  const durationMs = optionValue(argv, "--duration-ms");
  try {
    const created = await createMotionPackage({
      packageRoot: resolveOutputPath(root),
      ...(optionValue(argv, "--name") ? { name: optionValue(argv, "--name")! } : {}),
      ...(width ? { width: Number(width) } : {}),
      ...(height ? { height: Number(height) } : {}),
      ...(fps ? { fps: Number(fps) } : {}),
      ...(durationMs ? { durationMs: Number(durationMs) } : {}),
      ...(optionValue(argv, "--background") ? { background: optionValue(argv, "--background")! } : {}),
      ...(argv.includes("--empty") ? { empty: true } : {})
    });
    return { ok: true, command: "package-create", ...created };
  } catch (error) {
    const uncertain = publicationCommitUncertainCliFailure("package-create", error);
    if (uncertain) return uncertain;
    return {
      ok: false,
      command: "package-create",
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : "Motion package could not be created.",
        suggestedAction: "Choose an empty directory, or edit the existing package instead of creating one over it."
      }
    };
  }
}

async function validateCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0]; if (!root) return missingArgument("validate", "package root");
  const packageRoot = resolveInputPath(root);
  const receiptsRoot = optionValue(argv, "--receipts-root");
  try {
    const governedReceiptsRoot = receiptsRoot ? resolveOutputPath(receiptsRoot) : undefined;
    if (governedReceiptsRoot && await receiptRootIsInsidePackage(packageRoot, governedReceiptsRoot)) {
      return {
        ok: false,
        command: "validate",
        error: {
          code: "invalid_args",
          message: "validate --receipts-root must be outside the package being inspected.",
          suggestedAction: "Choose a host-governed receipts directory outside the package; validate never creates receipts inside its source package."
        }
      };
    }
    const { pkg, result } = await withCliSourceWorkspaceAnchor([packageRoot], async () => {
      const pkg = await loadMotionPackage(packageRoot);
      return { pkg, result: await packageValidationResult(pkg, "validate") };
    });
    return await persistCliValidationReceipt(result, packageRoot, pkg, governedReceiptsRoot, argv);
  } catch (error) {
    const result: CliResult = {
      ok: false,
      command: "validate",
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : "Motion package is not valid.",
        suggestedAction: "Fix the named field in motion.json or manifest.json, then validate again."
      }
    };
    return await persistCliValidationReceipt(result, packageRoot, undefined, receiptsRoot ? resolveOutputPath(receiptsRoot) : undefined, argv);
  }
}

/** Persist validation evidence only in the explicit host store, never inside the inspected package. */
async function persistCliValidationReceipt(
  result: CliResult,
  packageRoot: string,
  pkg: Awaited<ReturnType<typeof loadMotionPackage>> | undefined,
  receiptsRoot: string | undefined,
  argv: string[]
): Promise<CliResult> {
  if (!receiptsRoot) return result;
  const resultError = result.error;
  const failure = result.ok || !resultError || typeof resultError !== "object"
    ? undefined
    : resultError as { code: string; message: string; suggestedAction?: string };
  try {
    const receipt = applyReceiptActor(await createPackageValidationReceipt({
      packageRoot,
      ...(pkg ? { package: pkg } : {}),
      valid: result.ok,
      validation: result,
      ...(failure ? { error: failure } : {}),
      warnings: Array.isArray(result.warnings) ? result.warnings.filter((warning): warning is string => typeof warning === "string") : []
    }), readCliActor(argv, "read_motion"));
    const receiptPath = await writeHostReceiptFile(receiptsRoot, receipt);
    return { ...result, receiptId: receipt.id, receiptPath, receipt };
  } catch (error) {
    return {
      ok: false,
      command: "validate",
      error: {
        code: "receipt_persistence_failed",
        message: error instanceof Error ? `Package validation finished but its receipt could not be persisted: ${error.message}` : "Package validation finished but its receipt could not be persisted.",
        suggestedAction: "Choose a writable --receipts-root outside the package and validate again."
      },
      validation: result
    };
  }
}

async function inspectCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("inspect", "package root");

  const pkg = await loadMotionPackage(resolveInputPath(root));
  return {
    ok: true,
    command: "inspect",
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    size: { width: pkg.motion.width, height: pkg.motion.height },
    layers: pkg.motion.layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      ...(typeof layer.trackId === "string" ? { trackId: layer.trackId } : {}),
      startMs: layer.startMs,
      durationMs: layer.durationMs
    })),
    timeline: inspectMotionTimeline(pkg.motion),
    assets: pkg.manifest.assets
  };
}

async function reviewHtmlBundleCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("review-html-bundle", "package root");
  const outDir = optionValue(argv, "--out") ?? optionValue(argv, "--bundle-dir");
  if (!outDir) return missingArgument("review-html-bundle", "output directory");
  const receiptsRoot = optionValue(argv, "--receipts") ?? optionValue(argv, "--receipts-root");
  // A receipt names where its artifacts live, and the bundle writer now refuses to copy anything
  // whose canonical path falls outside an approved root -- a crafted receipt could otherwise pull any
  // readable file into a bundle someone then shares. That leaves one legitimate layout needing an
  // explicit answer: `render --batch` writes receipts to `<outDir>/receipts` while the media sits in
  // `<outDir>` itself, so the media is a sibling of the receipt root rather than inside it. Naming
  // that directory here approves it, in the open, instead of the writer quietly trusting whatever
  // parent directory a receipt happens to point at.
  const artifactRoots = optionValues(argv, "--artifact-root").map(resolveInputPath);

  try {
    const result = await writeReviewBundle({
      packageRoot: resolveInputPath(root),
      ...(receiptsRoot ? { receiptsRoot: resolveInputPath(receiptsRoot) } : {}),
      ...(artifactRoots.length > 0 ? { artifactRoots } : {}),
      outDir: resolveOutputPath(outDir),
      title: optionValue(argv, "--title")
    });
    return {
      ok: true,
      command: "review-html-bundle",
      packageId: result.packageId,
      htmlPath: result.htmlPath,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      receiptCount: result.receiptCount,
      copiedArtifactCount: result.copiedArtifactCount,
      copiedArtifacts: result.copiedArtifacts,
      // Surfaced rather than buried: a bundle that silently dropped the very renders it was made to
      // show would look complete and be useless, so the omissions travel with the success result.
      omittedArtifactCount: result.omittedArtifactCount,
      ...(result.omittedArtifacts.length > 0 ? { omittedArtifacts: result.omittedArtifacts } : {})
    };
  } catch (error) {
    const uncertain = publicationCommitUncertainCliFailure("review-html-bundle", error);
    if (uncertain) return uncertain;
    return {
      ok: false,
      command: "review-html-bundle",
      error: {
        code: "review_html_bundle_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function htmlSnippetExportCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("html-snippet-export", "package root");
  const outDir = optionValue(argv, "--out") ?? optionValue(argv, "--out-dir");
  if (!outDir) return missingArgument("html-snippet-export", "--out");

  try {
    const result = await writeHtmlSnippetExport({
      packageRoot: resolveInputPath(root),
      outDir: resolveOutputPath(outDir),
      ...(optionValue(argv, "--created-at") ? { createdAt: optionValue(argv, "--created-at") } : {})
    });
    return {
      ok: true,
      command: "html-snippet-export",
      packageId: result.packageId,
      htmlPath: result.htmlPath,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      htmlSha256: result.htmlSha256,
      layerCount: result.layerCount,
      exportedLayerCount: result.exportedLayerCount,
      unsupportedFeatureCount: result.unsupportedFeatureCount,
      artifacts: result.artifacts,
      warnings: result.warnings
    };
  } catch (error) {
    return {
      ok: false,
      command: "html-snippet-export",
      error: {
        code: "html_snippet_export_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function htmlSnippetImportCommand(argv: string[]): Promise<CliResult> {
  const htmlPath = argv[0];
  if (!htmlPath) return missingArgument("html-snippet-import", "HTML snippet path");
  const packageDir = optionValue(argv, "--out") ?? optionValue(argv, "--package") ?? optionValue(argv, "--package-dir");
  if (!packageDir) return missingArgument("html-snippet-import", "--out");

  try {
    const result = await importHtmlSnippetToMotionPackage({
      htmlPath: resolveInputPath(htmlPath),
      packageDir: resolveOutputPath(packageDir),
      ...(optionValue(argv, "--created-at") ? { createdAt: optionValue(argv, "--created-at") } : {})
    });
    return {
      ok: true,
      command: "html-snippet-import",
      packageId: result.packageId,
      packageRoot: result.packageDir,
      motionPath: result.motionPath,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      layerCount: result.layerCount,
      warningCount: result.warningCount,
      stagedAssetCount: result.stagedAssetCount,
      stagedAssets: result.stagedAssets,
      artifacts: result.artifacts,
      warnings: result.warnings
    };
  } catch (error) {
    return {
      ok: false,
      command: "html-snippet-import",
      error: {
        code: "html_snippet_import_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function otioExportCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("otio-export", "package root");
  const outPath = optionValue(argv, "--out") ?? optionValue(argv, "--otio") ?? optionValue(argv, "--timeline");
  if (!outPath) return missingArgument("otio-export", "--out");

  try {
    const result = await exportMotionPackageToOtio({
      packageRoot: resolveInputPath(root),
      outPath: resolveOutputPath(outPath),
      ...(optionValue(argv, "--created-at") ? { createdAt: optionValue(argv, "--created-at") } : {})
    });
    return {
      ok: true,
      command: "otio-export",
      packageId: result.packageId,
      otioPath: result.otioPath,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      otioSha256: result.otioSha256,
      trackCount: result.trackCount,
      clipCount: result.clipCount,
      gapCount: result.gapCount,
      warningCount: result.warningCount,
      artifacts: result.artifacts,
      warnings: result.warnings
    };
  } catch (error) {
    return {
      ok: false,
      command: "otio-export",
      error: {
        code: "otio_export_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function otioImportCommand(argv: string[]): Promise<CliResult> {
  const otioPath = argv[0];
  if (!otioPath) return missingArgument("otio-import", "OTIO timeline path");
  const packageRoot = optionValue(argv, "--out") ?? optionValue(argv, "--package") ?? optionValue(argv, "--package-dir");
  if (!packageRoot) return missingArgument("otio-import", "--out");

  try {
    const result = await importOtioTimelineToMotionPackage({
      otioPath: resolveInputPath(otioPath),
      packageDir: resolveOutputPath(packageRoot),
      ...(optionValue(argv, "--created-at") ? { createdAt: optionValue(argv, "--created-at") } : {})
    });
    return {
      ok: true,
      command: "otio-import",
      packageId: result.packageId,
      packageRoot: result.packageDir,
      manifestPath: result.manifestPath,
      motionPath: result.motionPath,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      layerCount: result.layerCount,
      warningCount: result.warningCount,
      artifacts: result.artifacts,
      warnings: result.warnings
    };
  } catch (error) {
    return {
      ok: false,
      command: "otio-import",
      error: {
        code: "otio_import_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function packageArchiveCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("package-archive", "package root");
  const archivePath = optionValue(argv, "--out") ?? optionValue(argv, "--archive") ?? optionValue(argv, "--archive-path");
  if (!archivePath) return missingArgument("package-archive", "--out");
  const receiptPath = optionValue(argv, "--receipt") ?? optionValue(argv, "--receipt-path");

  try {
    const result = await writeMotionPackageArchive({
      packageRoot: resolveInputPath(root),
      archivePath: resolveOutputPath(archivePath),
      ...(receiptPath ? { receiptPath: resolveOutputPath(receiptPath) } : {})
    });
    return {
      ok: true,
      command: "package-archive",
      packageId: result.packageId,
      archivePath: result.archivePath,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      archiveSha256: result.archiveSha256,
      byteLength: result.byteLength,
      fileCount: result.fileCount,
      entries: result.entries
    };
  } catch (error) {
    const uncertain = publicationCommitUncertainCliFailure("package-archive", error);
    if (uncertain) return uncertain;
    return {
      ok: false,
      command: "package-archive",
      error: {
        code: "package_archive_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function packageExtractCommand(argv: string[]): Promise<CliResult> {
  const archivePath = argv[0];
  if (!archivePath) return missingArgument("package-extract", "archive path");
  const packageRoot = optionValue(argv, "--out") ?? optionValue(argv, "--package-root") ?? optionValue(argv, "--package-dir");
  if (!packageRoot) return missingArgument("package-extract", "--out");
  const receiptPath = optionValue(argv, "--receipt") ?? optionValue(argv, "--receipt-path");

  try {
    const result = await extractMotionPackageArchive({
      archivePath: resolveInputPath(archivePath),
      packageRoot: resolveOutputPath(packageRoot),
      ...(receiptPath ? { receiptPath: resolveOutputPath(receiptPath) } : {})
    });
    return {
      ok: true,
      command: "package-extract",
      packageId: result.packageId,
      archivePath: result.archivePath,
      packageRoot: result.packageRoot,
      receiptPath: result.receiptPath,
      receiptId: result.receipt.id,
      archiveSha256: result.archiveSha256,
      byteLength: result.byteLength,
      fileCount: result.fileCount,
      entries: result.entries
    };
  } catch (error) {
    const uncertain = publicationCommitUncertainCliFailure("package-extract", error);
    if (uncertain) return uncertain;
    return {
      ok: false,
      command: "package-extract",
      error: {
        code: "package_extract_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function actionsCommand(argv: string[]): Promise<CliResult> {
  const subcommand = argv[0];
  if (!["find", "guide", "plan"].includes(subcommand ?? "")) {
    return {
      ok: false,
      command: "actions",
      error: {
        code: "unknown_subcommand",
        message: `Unknown actions subcommand: ${subcommand ?? "(missing)"}.`
      }
    };
  }

  const request = argv.slice(1).join(" ").trim();
  if (!request) return missingArgument(`actions.${subcommand}`, "request");

  if (subcommand === "find") {
    const match = findActionMatch(request);
    return { ok: true, command: "actions.find", action: match.action, matched: match.matched, ...(match.message ? { message: match.message } : {}), related: match.nearest };
  }

  // Enrich the steps the same way `debug actions-guide` does. Without this the plain subcommand
  // forwarded plan.steps verbatim, so an agent using the CLI got bare command names while the
  // debug transport got the argument contracts — the same request answered two different ways.
  const plan = annotatePlanWithArgumentContracts(subcommand === "guide" ? guideAction(request) : planAction(request));
  return {
    ok: true,
    command: `actions.${subcommand}`,
    topic: plan.topic,
    actionId: plan.action?.id ?? null,
    steps: plan.steps,
    verify: plan.verify,
    cautions: plan.cautions, examples: plan.examples, related: plan.related
  };
}

async function debugCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  // pnpm runs a filtered source-checkout command from packages/cli. Preserve the caller's
  // output authority before the typed Debug adapters read --out, matching the package-root rule.
  const debugArgv = resolveDebugOutputOptions(argv);
  const subcommand = debugArgv[0];
  const debugName = debugCommandName(subcommand);
  if (!debugName) {
    return {
      ok: false,
      command: "debug",
      error: { code: "unknown_subcommand", message: `Unknown debug subcommand: ${subcommand ?? "(missing)"}.` }
    };
  }
  const tier = readCliTier(debugArgv, "read_motion", options);
  if (!tier.ok) return { ok: false, command: `debug.${subcommand}`, error: tier.error, warnings: [] };
  let args: unknown;
  try {
    args = await debugArgs(debugName, debugArgv);
  } catch (error) {
    return invalidModularDebugArgs(subcommand, error);
  }
  const scratchRoot = debugScratchRoot(debugName, args, options.scratchRoot);
  const trustedInputRoots = debugTrustedInputRoots(args);
  const renderRoots = debugRenderRoots(debugName, args);
  const authoringRoots = cliAuthoringRoots(debugName, args);
  try { args = await hydrateModularDebugArgs(debugName, args, authoringRoots?.inputRoots); } catch (error) {
    return invalidModularDebugArgs(subcommand, error);
  }
  // The CLI is the trusted local host for these commands. Debug API/MCP transports never construct
  // runtimes themselves: their embedding host must inject one and otherwise receives capability_unavailable.
  const promptRuntime = debugName === "motion.prompt.run" ? options.promptRuntime ?? buildAgentRuntime() : undefined;
  const agentRuntime = debugName === "motion.agent.health" ? options.agentRuntime ?? buildAgentRuntime() : undefined;
  const debugArgumentRecord = readRecord(args);
  const cliHostReceiptStore = createCliTimelineHostReceiptStore(debugName);
  const cliReceiptsRoot = typeof debugArgumentRecord?.receiptsRoot === "string" ? resolveInputPath(debugArgumentRecord.receiptsRoot) : undefined;
  if (cliReceiptsRoot && debugArgumentRecord) args = { ...debugArgumentRecord, receiptsRoot: cliReceiptsRoot };
  const cliDefaultPlatformReceiptsRoot = debugName === "motion.export.panel"
    || debugName === "motion.export.plan"
    || debugName === "motion.platform.verification.panel"
    ? resolveOutputPath(".scratch/receipts")
    : undefined;
  const context = cliDebugDispatchContext({
    debugName, tier: tier.tier, actor: readCliActor(debugArgv, tier.tier), scratchRoot,
    cliHostReceiptStore, cliReceiptsRoot, cliDefaultPlatformReceiptsRoot,
    authoringRoots, trustedInputRoots, renderRoots, promptRuntime, agentRuntime,
    ffmpegRunner: options.ffmpegRunner, browserFrameRenderer: options.browserFrameRenderer,
    sourceFetcher: options.sourceFetcher, sourceResolver: options.sourceResolver
  });
  const result = await withCliSourceWorkspaceAnchor(sourceWorkspaceOperationPaths(debugName, args, cliHostReceiptStore?.receiptsRoot), async () => await dispatchDebugCommand(debugName, args, context));
  return result.ok
    ? {
        ok: true,
        command: `debug.${subcommand}`,
        result: result.result,
        receiptId: result.receiptId,
        visibleState: result.visibleState,
        warnings: result.warnings
      }
    : {
        ok: false,
        command: `debug.${subcommand}`,
        error: result.error,
        ...(result.result ? { result: result.result } : {}),
        warnings: result.warnings
      };
}

async function templateCommand(argv: string[]): Promise<CliResult> {
  const subcommand = argv[0];
  if (!["controls", "apply", "media-replace"].includes(subcommand ?? "")) {
    return {
      ok: false,
      command: "template",
      error: { code: "unknown_subcommand", message: `Unknown template subcommand: ${subcommand ?? "(missing)"}.` }
    };
  }

  const root = argv[1];
  const command = `template.${subcommand}`;
  if (!root) return missingArgument(command, "package root");
  const packageRoot = resolveInputPath(root);
  if (subcommand !== "controls") await assertPackageEditSourceTree(packageRoot);
  const pkg = await loadMotionPackage(packageRoot);

  if (subcommand === "controls") {
    return {
      command,
      ...listTemplateControls(pkg)
    };
  }

  if (subcommand === "media-replace") {
    const outDirArg = optionValue(argv, "--out");
    if (!outDirArg) return missingArgument(command, "--out");
    const paramId = optionValue(argv, "--param") ?? optionValue(argv, "--param-id");
    if (!paramId) return missingArgument(command, "--param");
    const assetPathArg = optionValue(argv, "--asset") ?? optionValue(argv, "--asset-path");
    if (!assetPathArg) return missingArgument(command, "--asset");

    const sourceAssetPath = resolveInputPath(assetPathArg);
    const assetRef = optionValue(argv, "--asset-ref") ?? `assets/${basename(sourceAssetPath)}`;
    const replaced = replaceTemplateMedia(pkg, { paramId, assetRef });
    if (!replaced.ok) {
      return {
        ok: false,
        command,
        error: {
          code: "template_media_replace_failed",
          message: "Template media could not be replaced.",
          errors: replaced.errors
        }
      };
    }

    const outDir = resolveOutputPath(outDirArg);
    // the output-directory ownership invariant: `--out` receives a full package-tree copy, so refuse to wipe a directory that already
    // holds files unless the caller opted in with `--force` (policy in ./output-dir-guard).
    const outDirGuard = await prepareOutputDir(outDir, { force: hasFlag(argv, "--force") });
    if (!outDirGuard.ok) return { ok: false, command, packageDir: outDir, error: outDirGuard.error };
    const copiedAssetPath = resolvePackageAsset({ root: outDir }, replaced.assetRef);
    const receiptPath = join(outDir, "receipts", "template-media-replace.receipt.json");
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: outDir, status: "available", primary: true },
      { role: "template_media_asset", path: copiedAssetPath, status: "available", mediaType: mediaTypeForPath(copiedAssetPath) },
      { role: "template_media_replace_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const receipt = {
      schema: "shellx-motion/receipt@1",
      id: `template-media-replace-${hashBuffer(Buffer.from(`${pkg.manifest.id}:${paramId}:${assetRef}:${JSON.stringify(replaced.changedBindings)}`, "utf8")).slice(0, 16)}`,
      operation: "template.media.replace",
      // Same rule, same reason as `template.apply` below: a media slot whose binding did not apply
      // leaves the package pointing at the OLD asset while the caller believes it was swapped.
      status: escalateReceiptStatusForWarnings("passed", replaced.warnings),
      packageId: pkg.manifest.id,
      inputHashes: {
        motion: hashBuffer(Buffer.from(JSON.stringify(pkg.motion), "utf8")),
        manifest: hashBuffer(Buffer.from(JSON.stringify(pkg.manifest), "utf8")),
        template: hashBuffer(Buffer.from(JSON.stringify(pkg.template ?? null), "utf8")),
        asset: await hashFile(sourceAssetPath)
      },
      createdAt: new Date().toISOString(),
      lane: "template",
      output: {
        packageDir: outDir,
        paramId: replaced.paramId,
        assetRef: replaced.assetRef,
        copiedAssetPath,
        changedParams: replaced.changedParams,
        changedBindings: replaced.changedBindings,
        manifestAssets: replaced.manifestAssets
      },
      artifacts,
      warnings: replaced.warnings
    };
    await commitPackageEdit({
      sourceRoot: packageRoot,
      outputRoot: outDir,
      edit: async (stagedRoot) => {
        const stagedAssetPath = resolvePackageAsset({ root: stagedRoot }, replaced.assetRef);
        await mkdir(dirname(stagedAssetPath), { recursive: true });
        await copyFile(sourceAssetPath, stagedAssetPath);
        await writeJson(join(stagedRoot, "manifest.json"), replaced.manifest);
        await writeJson(join(stagedRoot, pkg.manifest.motion), replaced.motion);
        await mkdir(join(stagedRoot, "receipts"), { recursive: true });
        await writeJson(join(stagedRoot, "receipts", "template-media-replace.receipt.json"), receipt);
      },
      validate: async (stagedRoot) => await assertValidTemplatePackage(stagedRoot),
    });

    return {
      ok: true,
      command,
      packageDir: outDir,
      paramId: replaced.paramId,
      assetRef: replaced.assetRef,
      copiedAssetPath,
      changedParams: replaced.changedParams,
      changedBindings: replaced.changedBindings,
      manifestAssets: replaced.manifestAssets,
      receiptPath,
      artifacts,
      warnings: replaced.warnings
    };
  }

  const outDirArg = optionValue(argv, "--out");
  if (!outDirArg) return missingArgument(command, "--out");
  const updates = parseTemplateSetOptions(argv);
  const applied = applyTemplateValues(pkg, updates);
  if (!applied.ok) {
    return {
      ok: false,
      command,
      error: {
        code: "template_apply_failed",
        message: "Template values could not be applied.",
        errors: applied.errors
      }
    };
  }

  const outDir = resolveOutputPath(outDirArg);
  // the output-directory ownership invariant: same guard as `media-replace` — a non-empty `--out` is refused instead of wiped.
  const outDirGuard = await prepareOutputDir(outDir, { force: hasFlag(argv, "--force") });
  if (!outDirGuard.ok) return { ok: false, command, packageDir: outDir, error: outDirGuard.error };
  const receiptPath = join(outDir, "receipts", "template-apply.receipt.json");
  const artifacts: ReceiptArtifact[] = [
    { role: "motion_package", path: outDir, status: "available", primary: true },
    { role: "template_apply_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt = {
    schema: "shellx-motion/receipt@1",
    id: `template-apply-${hashBuffer(Buffer.from(`${pkg.manifest.id}:${JSON.stringify(applied.changedBindings)}`, "utf8")).slice(0, 16)}`,
    operation: "template.apply",
    // A template apply that dropped a binding is not a pass. `applied.warnings` carries lines like
    // "Template binding title target /layers/99/text was not applied" -- the engine saying it ignored
    // something the caller declared, which is the exact defect class this release exists to remove.
    // measured during cross-host verification before this escalated: `template apply --set title=...` against an
    // unresolvable binding wrote a receipt reading `passed` over a document still holding the old
    // text.
    status: escalateReceiptStatusForWarnings("passed", applied.warnings),
    packageId: pkg.manifest.id,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(pkg.motion), "utf8")),
      template: hashBuffer(Buffer.from(JSON.stringify(pkg.template ?? null), "utf8")),
      updates: hashBuffer(Buffer.from(JSON.stringify(updates), "utf8"))
    },
    createdAt: new Date().toISOString(),
    lane: "template",
    output: {
      packageDir: outDir,
      changedParams: applied.changedParams,
      changedBindings: applied.changedBindings
    },
    artifacts,
    warnings: applied.warnings
  };
  await commitPackageEdit({
    sourceRoot: packageRoot,
    outputRoot: outDir,
    edit: async (stagedRoot) => {
      await writeJson(join(stagedRoot, pkg.manifest.motion), applied.motion);
      await mkdir(join(stagedRoot, "receipts"), { recursive: true });
      await writeJson(join(stagedRoot, "receipts", "template-apply.receipt.json"), receipt);
    },
    validate: async (stagedRoot) => await assertValidTemplatePackage(stagedRoot),
  });

  return {
    ok: true,
    command,
    packageDir: outDir,
    changedParams: applied.changedParams,
    changedBindings: applied.changedBindings,
    receiptPath,
    artifacts,
    warnings: applied.warnings
  };
}

async function assertValidTemplatePackage(packageRoot: string): Promise<void> {
  const validation = await validatePackageAssetReferences(await loadMotionPackage(packageRoot));
  if (validation.ok) return;
  const problem = validation.problems[0]!;
  throw new Error(`Template output contains an invalid package asset reference at ${problem.path} (${problem.code}).`);
}

async function agentCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const subcommand = argv[0];
  if (subcommand !== "health") {
    return {
      ok: false,
      command: "agent",
      error: { code: "unknown_subcommand", message: `Unknown agent subcommand: ${subcommand ?? "(missing)"}.` }
    };
  }

  const adapter = optionValue(argv, "--adapter") ?? "auto";
  // `--adapter fake` used to build a stubbed runtime that reported a ready agent nobody could
  // install; a caller reading the JSON had no way to tell it from a real probe (the tool-provenance invariant). Health now
  // always probes the real adapters, and a suite that needs a scripted one injects it via options.
  const runtime = options.agentRuntime ?? buildAgentRuntime();
  const health = await runtime.health();
  return {
    ok: true,
    command: "agent.health",
    agents: adapter === "auto" ? health : health.filter((agent) => agent.agentId === adapter)
  };
}

async function promptCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const subcommand = argv[0];
  if (subcommand !== "run") {
    return {
      ok: false,
      command: "prompt",
      error: {
        code: "unknown_subcommand",
        message: `Unknown prompt subcommand: ${subcommand ?? "(missing)"}.`
      }
    };
  }

  const positional = collectPositionals(argv.slice(1));
  const request = positional.join(" ").trim();
  if (!request) return missingArgument("prompt.run", "request");

  const packageId = optionValue(argv, "--package-id") ?? "unknown";
  const tier = readCliTier(argv, "render_motion", options);
  if (!tier.ok) return { ok: false, command: "prompt.run", error: tier.error, warnings: [] };
  const agentId = optionValue(argv, "--agent");
  const cwd = optionValue(argv, "--cwd");
  const receiptsRoot = optionValue(argv, "--receipts-root");
  const executeAgentCommands = hasFlag(argv, "--execute-agent-commands") || hasFlag(argv, "--execute");
  // No flag can substitute a stubbed agent: `--fake` made `prompt run` emit an `ok: true` receipt
  // pair over an agent that never ran (the tool-provenance invariant). A host that wants one injects it deliberately.
  const retention = promptRetentionFromCli(argv);
  if (!retention.ok) return { ok: false, command: "prompt.run", error: retention.error, warnings: [] };

  if (executeAgentCommands) { const authoringRoots = cliAuthoringRoots("motion.prompt.run", { cwd });
    const promptRuntime = options.promptRuntime ?? buildAgentRuntime();
    const debugResult = await dispatchDebugCommand("motion.prompt.run", {
      request,
      packageId,
      agentId,
      cwd,
      receiptsRoot,
      executeAgentCommands: true,
      ...(retention.value.mode === "raw_request" ? {
        retainRawRequest: true,
        rawRequestDeleteAfter: retention.value.deleteAfter,
        rawRequestPurpose: retention.value.purpose
      } : {})
    }, {
      tier: tier.tier,
      // Prompt runs (and the child commands they execute) are agent-driven: prefer the --agent id as
      // the actor label, so History attributes each sub-operation to the agent behind the prompt.
      actor: agentId
        ? { kind: "agent", label: agentId, transport: "cli", sessionId: `cli-${process.pid}`, grantedTier: tier.tier }
        : readCliActor(argv, tier.tier),
      // Same nomination as the `debug` path above: a `--receipts-root` the operator typed IS the host
      // naming it, because at a shell there is no privilege boundary for the fence to defend.
      ...(options.scratchRoot
        ? { scratchRoot: options.scratchRoot }
        : receiptsRoot ? { scratchRoot: receiptsRoot } : {}),
      ...(authoringRoots ? { promptCwdRoots: authoringRoots.inputRoots, authoringInputRoots: authoringRoots.inputRoots, authoringOutputRoots: authoringRoots.outputRoots } : {}),
      ...(promptRuntime ? { promptRuntime } : {}),
      ...(options.promptNow ? { promptNow: options.promptNow } : {}),
      ...(options.promptReceiptWriteTestHook ? { rawPromptReceiptWriteTestHook: options.promptReceiptWriteTestHook } : {}),
      ...(options.browserFrameRenderer ? { browserFrameRenderer: options.browserFrameRenderer } : {})
    });
    return debugResult.ok
      ? {
          ok: true,
          command: "prompt.run",
          receiptId: debugResult.receiptId,
          visibleState: debugResult.visibleState,
          result: debugResult.result,
          warnings: debugResult.warnings
        }
      : {
          ok: false,
          command: "prompt.run",
          error: debugResult.error,
          warnings: debugResult.warnings
        };
  }

  // Keep the portable summary-only CLI path direct. Raw retention is different: its returned
  // receipt would carry literal request bytes, so refuse before runtime or write unless the
  // host can later read and purge the governed receipt through the stable store.
  const rawRetentionAdmission = rawPromptRetentionAdmissionError(retention.value, {
    receiptsRoot,
    receiptPersistenceAvailable: Boolean(receiptsRoot),
    hasStableReceiptPurgeCapability: options.hasStableReceiptPurgeCapability ?? hasStableReceiptStoreCapability
  });
  if (rawRetentionAdmission) return { ok: false, command: "prompt.run", error: rawRetentionAdmission, warnings: [] };
  const stableReceiptRoot = retention.value.mode === "raw_request" ? await reserveStableReceiptRoot(receiptsRoot!) : null;
  if (retention.value.mode === "raw_request" && !stableReceiptRoot) return { ok: false, command: "prompt.run", error: { code: "capability_unavailable", message: "Raw prompt retention requires a no-follow stable receipt root that can be retained for persistence.", suggestedAction: "Configure an existing non-symlink Linux receipt root and retry." }, warnings: [] };
  const promptRuntime = options.promptRuntime ?? buildAgentRuntime();
  try {
    const result = await runMotionPrompt({ request, tier: tier.tier, agentId, packageId, cwd, runtime: promptRuntime, retention: retention.value, ...(options.promptNow ? { now: options.promptNow } : {}) });
    const persist = async (receipt: OperationReceipt) => {
      if (retention.value.mode === "raw_request") await options.promptReceiptWriteTestHook?.(receipt);
      return stableReceiptRoot
        ? await stableReceiptRoot.writeJson(`${safeFileToken(receipt.id)}.receipt.json`, receipt)
        : await writeHostReceiptFile(receiptsRoot!, receipt);
    };

    if (result.ok) {
      const agentReceiptPath = receiptsRoot ? await persist(result.agent.receipt) : undefined;
      const promptReceipt = redactPromptReceiptForBoundary(result.receipt, options.promptNow);
      const receiptPath = receiptsRoot ? await persist(promptReceipt) : undefined;
      return {
        ok: true,
        command: "prompt.run",
        actionId: result.plan.action?.id ?? null,
        receipts: [result.agent.receipt.id, promptReceipt.id],
        ...(agentReceiptPath && receiptPath ? { receiptPaths: [agentReceiptPath, receiptPath] } : {}),
        debugCommands: promptReceipt.output.debugCommands,
        promptRetention: promptReceipt.output.promptRetention
      };
    }
    const promptReceipt = result.receipt && redactPromptReceiptForBoundary(result.receipt, options.promptNow);
    const receiptPath = promptReceipt && receiptsRoot ? await persist(promptReceipt) : undefined;
    return {
        ok: false,
        command: "prompt.run",
        error: result.error,
        receipts: promptReceipt ? [promptReceipt.id] : [],
        ...(receiptPath ? { receiptPaths: [receiptPath] } : {})
      };
  } finally {
    await stableReceiptRoot?.close();
  }
}

function redactPromptReceiptForBoundary(receipt: PromptRunReceipt, now: (() => string) | undefined): PromptRunReceipt {
  return redactExpiredRawPrompt(receipt, now?.()).receipt;
}

async function previewCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("preview", "package root");
  if (root === "--help") return helpCommand();
  const unsupportedOption = argv.slice(1).find((value) => value.startsWith("--") && !["--out", "--lane", "--at-ms"].includes(value));
  if (unsupportedOption) {
    return {
      ok: false,
      command: "preview",
      error: { code: "invalid_args", message: `Unsupported preview option: ${unsupportedOption}. Use --at-ms for the capture time.` }
    };
  }
  const outDir = optionValue(argv, "--out") ?? ".scratch/previews";
  const lane = optionValue(argv, "--lane") ?? "native";
  if (lane !== "native" && lane !== "browser" && lane !== "gpu") {
    return { ok: false, command: "preview", error: { code: "unsupported_lane", message: unsupportedPreviewLaneMessage(lane) } };
  }
  const atMs = Number(optionValue(argv, "--at-ms") ?? 0);
  if (!Number.isFinite(atMs) || atMs < 0) {
    return { ok: false, command: "preview", error: { code: "invalid_args", message: "--at-ms must be a non-negative finite number." } };
  }
  const pkg = await loadMotionPackage(resolveInputPath(root));
  const admissionRefusal = previewCommandAdmissionRefusal(pkg.motion, lane);
  if (admissionRefusal) return admissionRefusal;
  const outputDir = resolveOutputPath(outDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  if (lane === "browser") {
    const outputPath = join(outputDir, `${pkg.manifest.id}-browser-${atMs}.png`);
    const receiptPath = join(outputDir, `${pkg.manifest.id}-browser-preview.receipt.json`);
    const publication = await PairedOutputReceiptPublication.acquire({
      outputPath, receiptPath,
      outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
      receiptArtifact: { role: "preview_receipt", mediaType: "application/json" }
    });
    let result: Awaited<ReturnType<typeof renderMotionBrowserFrame>>;
    try {
      result = await renderMotionBrowserFrame(pkg, withRendererPrivateOutputPublication({
        // Browser composition HTML is renderer evidence, so keep its generated companion under
        // the output reservation until it has its own receipt-bound no-clobber publication.
        atMs, outDir: dirname(publication.outputPublication.stagingPath), outputPath: publication.outputPublication.stagingPath,
      }, publication.outputPublication));
      const rendererArtifacts = [...(result.output.artifacts ?? []), ...(result.receipt.artifacts ?? [])];
      const stagedArtifactPaths = new Set<string>();
      const remappedArtifacts: ReceiptArtifact[] = [];
      for (const artifact of rendererArtifacts) {
        if (artifact.status !== "available") throw new Error("Browser renderer returned a non-available companion artifact for a successful preview.");
        if (stagedArtifactPaths.has(resolve(artifact.path))) continue;
        stagedArtifactPaths.add(resolve(artifact.path));
        const remapped = await publication.stageSecondaryArtifact({
          stagedPath: artifact.path,
          outputPath: join(outputDir, `${pkg.manifest.id}-${artifact.role}-${basename(artifact.path)}`),
          artifact: { ...artifact, primary: false },
          inputHashKey: artifact.role === "browser_capture_html" ? "browser-capture-html" : `renderer-artifact:${artifact.role}:${basename(artifact.path)}`
        });
        remappedArtifacts.push(remapped);
      }
      if (remappedArtifacts.length > 0) {
        result.output.artifacts = remappedArtifacts;
        result.receipt.artifacts = remappedArtifacts;
      }
      result.output.path = outputPath;
      await publication.stageReceipt(result.receipt);
      await publication.commit({ cancelled: () => options.signal?.aborted === true });
    } catch (error) {
      await publication.abort().catch(() => undefined);
      if (error instanceof PairedOutputReceiptCommitUncertainError) {
        return { ok: false, command: "preview", lane: "browser", ...pairedPublicationUncertaintyFields(error, "previewCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
      }
      throw error;
    }
    return {
      ok: true,
      command: "preview",
      lane: "browser",
      output: result.output,
      outputPath: result.output.path,
      receiptId: result.receipt.id,
      receiptPath
    };
  }

  if (lane === "gpu") {
    const outputPath = join(outputDir, `${pkg.manifest.id}-gpu-${atMs}.png`);
    const receiptPath = join(outputDir, `${pkg.manifest.id}-gpu-preview.receipt.json`);
    const publication = await PairedOutputReceiptPublication.acquire({
      outputPath, receiptPath,
      outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
      receiptArtifact: { role: "preview_receipt", mediaType: "application/json" }
    });
    try {
      const result = await renderGpuPointsPreviewCli(pkg, atMs, outputDir, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(resolveCallerId(argv, options) ? { callerId: resolveCallerId(argv, options)! } : {}),
        ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
        ...(options.ffmpegRunner ? { ffmpegRunner: options.ffmpegRunner } : {}),
        outputPath: publication.outputPublication.stagingPath,
        privateOutputPublication: publication.outputPublication
      });
      if (!result.ok) {
        await publication.abort();
        return result;
      }
      await publication.stageReceipt(result.receipt as OperationReceipt);
      await publication.commit({ cancelled: () => options.signal?.aborted === true });
      return { ...result, output: { ...(result.output as Record<string, unknown>), path: outputPath }, outputPath, receiptPath };
    } catch (error) {
      await publication.abort().catch(() => undefined);
      if (error instanceof PairedOutputReceiptCommitUncertainError) {
        return { ok: false, command: "preview", lane: "gpu", ...pairedPublicationUncertaintyFields(error, "previewCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
      }
      throw error;
    }
  }

  const previewPath = join(outputDir, `${pkg.manifest.id}-native-${atMs}.png`);
  const receiptPath = join(outputDir, `${pkg.manifest.id}-native-preview.receipt.json`);
  const publication = await PairedOutputReceiptPublication.acquire({
    outputPath: previewPath, receiptPath,
    outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
    receiptArtifact: { role: "preview_receipt", mediaType: "application/json" }
  });
  let result: Awaited<ReturnType<typeof renderNativePreviewFrame>>;
  try {
    result = await renderNativePreviewFrame(withNativePrivateOutputPublication({
      packageRoot: resolveInputPath(root),
      outputPath: publication.outputPublication.stagingPath,
      outputRoots: [outputDir],
      atMs
    }, publication.outputPublication));
    if (result.ok) {
      await publication.stageReceipt(result.receipt);
      await publication.commit({ cancelled: () => options.signal?.aborted === true });
    } else {
      await publication.abort();
      await publishJsonSidecar(receiptPath, result.receipt);
    }
  } catch (error) {
    await publication.abort().catch(() => undefined);
    if (error instanceof PairedOutputReceiptCommitUncertainError) {
      return { ok: false, command: "preview", lane: "native", ...pairedPublicationUncertaintyFields(error, "previewCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      ok: false,
      command: "preview",
      lane: "native",
      error: result.error,
      receiptId: result.receipt.id,
      receiptPath,
      warnings: result.warnings
    };
  }

  return {
    ok: true,
    command: "preview",
    lane: "native",
    output: {
      path: previewPath,
      sha256: result.frame.sha256,
      width: result.frame.width,
      height: result.frame.height,
      atMs: result.frame.atMs
    },
    outputPath: previewPath,
    receiptId: result.receipt.id,
    receiptPath
  };
}

async function renderCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const callerIdForRun = resolveCallerId(argv, options);
  const root = argv[0];
  if (!root) return missingArgument("render", "package root");

  const packageRoot = resolveInputPath(root);
  const lane = optionValue(argv, "--lane") ?? "ffmpeg";
  const keepFrames = hasFlag(argv, "--keep-frames");
  const outputPath = optionValue(argv, "--out");
  if (!outputPath) return missingArgument("render", "--out");
  if (lane === "native") {
    if (keepFrames) return keepFramesFinalVideoOnlyRefusal();
    const resolvedOutputPath = resolveOutputPath(outputPath);
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    const receiptPath = renderReceiptPathForOutput((await loadMotionPackage(packageRoot)).manifest.id, resolvedOutputPath, "image");
    const publication = await PairedOutputReceiptPublication.acquire({
      outputPath: resolvedOutputPath,
      receiptPath,
      outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
      receiptArtifact: { role: "render_receipt", mediaType: "application/json" }
    });
    let result: Awaited<ReturnType<typeof renderNativePreviewFrame>>;
    try {
      result = await renderNativePreviewFrame(withNativePrivateOutputPublication({
        packageRoot,
        outputPath: publication.outputPublication.stagingPath,
        outputRoots: [dirname(resolvedOutputPath)],
        atMs: Number(optionValue(argv, "--at-ms") ?? 0)
      }, publication.outputPublication));
      if (result.ok) {
        await publication.stageReceipt(result.receipt);
        await publication.commit({ cancelled: () => options.signal?.aborted === true });
      } else {
        await publication.abort();
      }
    } catch (error) {
      await publication.abort().catch(() => undefined);
      if (error instanceof PairedOutputReceiptCommitUncertainError) {
        return { ok: false, command: "render", lane: "native", ...pairedPublicationUncertaintyFields(error, "renderCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
      }
      throw error;
    }
    return result.ok
      ? {
          ok: true,
          command: "render",
          lane: "native",
          outputPath: resolvedOutputPath,
          output: {
            path: resolvedOutputPath,
            sha256: result.frame.sha256,
            width: result.frame.width,
            height: result.frame.height,
            atMs: result.frame.atMs
          },
          receipt: result.receipt,
          receiptPath
        }
      : {
          ok: false,
          command: "render",
          lane: "native",
          error: result.error,
          receipt: result.receipt
        };
  }
  if (lane !== "ffmpeg") {
    // --lane selects the DELIVERY lane; browser is a FRAME lane. Naming the fix matters here
    // because "--lane browser" is the single most natural wrong guess an agent makes.
    return { ok: false, command: "render", error: { code: "unsupported_lane", message: unsupportedRenderLaneMessage(lane) } };
  }

  const { pkg, lineage } = await loadStableRenderPackage(packageRoot);
  const frameLaneValue = optionValue(argv, "--frame-lane") ?? "browser";
  if (frameLaneValue !== "browser" && frameLaneValue !== "native" && frameLaneValue !== "gpu") {
    return {
      ok: false,
      command: "render",
      error: { code: "unsupported_frame_lane", message: unsupportedFrameLaneMessage(frameLaneValue) }
    };
  }
  const frameLane: "browser" | "native" | "gpu" = frameLaneValue;
  const browserTypographyRefusal = frameLane === "browser" ? browserTypographyAttestationRefusal(pkg) : null;
  if (browserTypographyRefusal) {
    return { ok: false, command: "render", frameLane, error: browserTypographyRefusal };
  }
  if (frameLane === "browser" && activeScriptLayers(pkg.motion).length > 0) return activeScriptCliRefusal("render");
  const workflowPath = optionValue(argv, "--workflow");
  const resolvedWorkflowPath = workflowPath ? resolveInputPath(workflowPath) : undefined;
  if (resolvedWorkflowPath && frameLane !== "browser") {
    return {
      ok: false,
      command: "render",
      error: { code: "unsupported_frame_lane", message: "Browser workflows require browser frame lane." }
    };
  }
  const workflow = resolvedWorkflowPath ? await readBrowserCaptureWorkflow(resolvedWorkflowPath) : undefined;
  const workflowCatalogRef = optionValue(argv, "--catalog") ?? optionValue(argv, "--workflow-catalog") ?? optionValue(argv, "--workflow-catalog-path");
  const workflowCatalogPath = workflowCatalogRef ? resolveOutputPath(workflowCatalogRef) : undefined;
  const failOnDrift = hasFlag(argv, "--fail-on-drift");
  const forceOutput = hasFlag(argv, "--force");
  // Hardware encoding is preferred for the ffmpeg lane when a usable encoder is proved: the
  // encode probes for a usable hardware encoder and prefers it. `--force-software-encode` (or the
  // SHELLX_MOTION_FORCE_SOFTWARE_ENCODE env flag, read inside the encoder) forces the software path
  // for reproducibility-critical renders.
  const forceSoftwareEncode = hasFlag(argv, "--force-software-encode");
  const presetValue = optionValue(argv, "--preset") ?? "mp4-h264";
  const preset = readMotionExportPreset(presetValue);
  if (!preset) {
    return {
      ok: false,
      command: "render",
      error: {
        code: "unsupported_preset",
        message: `Unsupported export preset: ${presetValue}.`
      }
    };
  }
  const qualityManifestRef = optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest");
  const qualityManifestPath = qualityManifestRef ? resolveInputPath(qualityManifestRef) : undefined;
  if (qualityManifestPath && !supportsBatchQualityManifestPreset(preset)) {
    return {
      ok: false,
      command: "render",
      error: {
        code: "unsupported_quality_manifest",
        message: "Final render quality manifest checks currently require a video, GIF, png-frame, or png-sequence export preset."
      }
    };
  }
  const minUniqueFrameHashes = optionValue(argv, "--min-unique-frames");
  const quality = minUniqueFrameHashes === undefined
    ? undefined
    : readMinUniqueFrameHashes(minUniqueFrameHashes);
  if (quality === null) {
    return {
      ok: false,
      command: "render",
      error: {
        code: "invalid_args",
        message: "--min-unique-frames must be a positive integer."
      }
    };
  }
  const audioPath = optionValue(argv, "--audio");
  const packageAudio = audioPath ? {} : packageAudioEncodeInput(pkg);
  const audio = audioPath
    ? { path: resolveInputPath(audioPath) }
    : packageAudio.audio;
  const audioTracks = audioPath ? undefined : packageAudio.audioTracks;
  const audioMaster = packageAudio.audioMaster;
  const audioInputCount = audioTracks?.length ?? (audio ? 1 : 0);
  const resolvedAudioPath = audio?.path;
  const resolvedOutputPath = resolveOutputPath(outputPath);
  const framesRootOption = optionValue(argv, "--frames-dir") ?? options.scratchRoot;
  const framesRoot = resolveOutputPath(framesRootOption ?? ".scratch/frames");
  const framesDir = join(framesRoot, pkg.manifest.id);
  // The one fact that licenses a recursive delete without evidence: only the DEFAULT root below is
  // Motion's own. `--frames-dir` and an embedder's scratch root are both caller-chosen (the frame-output ownership invariant).
  const framesDirCallerSupplied = framesRootOption !== undefined;
  const ffmpegInputRoots = audioPath && resolvedAudioPath
    ? [framesDir, dirname(resolvedAudioPath)]
    : [framesDir, pkg.root];
  const frameCount = frameCountFor(pkg.motion.durationMs, pkg.motion.fps);
  const stillFramePreset = readStillFrameExportPreset(preset);
  const imageSequencePreset = readImageSequenceExportPreset(preset);
  if (keepFrames && (stillFramePreset || imageSequencePreset)) return keepFramesFinalVideoOnlyRefusal();
  if (stillFramePreset) {
    if (frameLane === "gpu") {
      return { ok: false, command: "render", frameLane, error: { code: "unsupported_frame_lane", message: "GPU final rendering supports streamed FFmpeg video only, not still-frame presets." } };
    }
    const atMs = Number(optionValue(argv, "--at-ms") ?? 0);
    if (!Number.isFinite(atMs) || atMs < 0) {
      return {
        ok: false,
        command: "render",
        error: {
          code: "invalid_args",
          message: "--at-ms must be a non-negative number."
        }
      };
    }
    const outputPathError = stillFrameOutputPathError(stillFramePreset, resolvedOutputPath);
    if (outputPathError) {
      return {
        ok: false,
        command: "render",
        error: {
          code: "invalid_args",
          message: outputPathError
        }
      };
    }
    const spec = resolveMotionExportPreset(stillFramePreset);
    const stillFrameWarnings = audioInputCount > 0
      ? [`Export preset ${stillFramePreset} does not support audio; ${audioInputCount} requested audio ${audioInputCount === 1 ? "track" : "tracks"} will be ignored.`]
      : [];
    const stillFrame = {
      outputPath: resolvedOutputPath,
      atMs,
      width: pkg.motion.width,
      height: pkg.motion.height,
      codec: spec.codec,
      container: spec.container,
      preset: stillFramePreset
    };
    // A dry run must refuse what execution would refuse.
    const dryRunRefusal = nativeDeliveryRefusal(pkg, frameLane);
    if (dryRunRefusal && argv.includes("--dry-run")) return dryRunRefusal;
    if (argv.includes("--dry-run")) {
      return {
        ok: true,
        command: "render",
        lane: "image",
        frameLane,
        preset: stillFramePreset,
        outputPath: resolvedOutputPath,
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        ...(stillFrameWarnings.length > 0 ? { warnings: stillFrameWarnings } : {}),
        dryRun: true,
        stillFrame
      };
    }

    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    const receiptPath = renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "image");
    const publication = await PairedOutputReceiptPublication.acquire({
      outputPath: resolvedOutputPath,
      receiptPath,
      outputArtifact: { role: "still_frame", mediaType: mediaTypeForPath(resolvedOutputPath), primary: true },
      receiptArtifact: { role: "render_receipt", mediaType: "application/json" },
      ...(forceOutput ? { forceOutput: true, forceReceipt: true } : {})
    });
    let preparedWorkflowCatalog: RenderReceiptFinalizeResult | undefined;
    try {
    let frameReceipt: unknown = null;
    // A still frame is one frame, but it warns the same way a sequence frame does.
    const frameLaneWarnings = new FrameLaneWarnings();
    let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
    let browserRendererArtifacts: ReceiptArtifact[] = [];
    if (frameLane === "native") {
      if (stillFramePreset !== "png-frame") {
        await publication.abort();
        return {
          ok: false,
          command: "render",
          error: {
            code: "unsupported_frame_lane",
            message: "Native still-frame renders currently support png-frame only."
          }
        };
      }
      const frame = await renderNativePreviewFrame(withNativePrivateOutputPublication({
        packageRoot,
        outputPath: publication.outputPublication.stagingPath,
        outputRoots: [dirname(resolvedOutputPath)],
        atMs
      }, publication.outputPublication));
      frameReceipt = frame.receipt;
      frameLaneWarnings.observe(frame.receipt);
      if (!frame.ok) {
        await publication.abort();
        return {
          ok: false,
          command: "render",
          lane: "image",
          frameLane,
          error: frame.error,
          frameReceipt: frame.receipt
        };
      }
    } else {
      const frame = await renderMotionBrowserFrame(pkg, withRendererPrivateOutputPublication({
        outDir: dirname(publication.outputPublication.stagingPath),
        outputPath: publication.outputPublication.stagingPath,
        atMs,
        ...(workflow ? { workflow } : {}),
        format: stillFramePreset === "jpeg-frame" ? "jpeg" : "png"
      }, publication.outputPublication));
      frameReceipt = frame.receipt;
      frameLaneWarnings.observe(frame.receipt);
      workflowEvidence = browserWorkflowEvidenceFromFrame(frame);
      browserRendererArtifacts = availableRendererArtifacts(frame, publication.outputPublication.stagingPath);
    }

    const receipt = await createStillFrameReceipt({
      packageId: pkg.manifest.id,
      outputPath: publication.outputPublication.stagingPath,
      preset: stillFramePreset,
      width: pkg.motion.width,
      height: pkg.motion.height,
      atMs,
      warnings: stillFrameWarnings
    });
    // Fold what the frame lane reported into the receipt an agent actually reads. Without this
    // a font-fallback warning raised while drawing is invisible once the frames are encoded away.
    frameLaneWarnings.applyTo(receipt);
    enrichRenderReceiptWithBrowserWorkflow(receipt, workflowEvidence);
    const rawQualityCheck = qualityManifestPath
      ? await qualityCheckRenderManifest({
          inputPath: publication.outputPublication.stagingPath,
          manifestPath: qualityManifestPath,
          preset: stillFramePreset,
          packageRoot,
          ...(frameLane === "browser" ? { previewPackageRoot: packageRoot } : {}),
          durationMs: pkg.motion.durationMs,
          fps: pkg.motion.fps,
          options
        })
      : undefined;
    const qualityCheck = rawQualityCheck ? remapPrivatePublicationResultPaths(rawQualityCheck, publication.outputPublication.stagingPath, resolvedOutputPath) : undefined;
    if (qualityManifestPath && qualityCheck) {
      await enrichRenderReceiptWithQualityManifest(receipt, qualityManifestPath, qualityCheck);
      if (!qualityCheck.ok) {
        await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
        remapReceiptOutputPath(receipt, publication.outputPublication.stagingPath, resolvedOutputPath);
        await publication.abort();
        return await renderQualityManifestFailure({
          packageId: pkg.manifest.id,
          lane: "image",
          frameLane,
          preset: stillFramePreset,
          outputPath: resolvedOutputPath,
          receipt,
          frameReceipt,
          qualityManifestPath,
          qualityCheck,
          force: forceOutput,
          extra: { stillFrame }
        });
      }
    }
    await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
    const workflowCatalog = preparedWorkflowCatalog = await prepareRenderReceipt({
      packageId: pkg.manifest.id,
      receipt,
      outputPath: resolvedOutputPath,
      receiptPath,
      atMs,
      workflowEvidence,
      workflowCatalogPath,
      failOnDrift, force: forceOutput
    });
    if (workflowCatalog.error) {
      await abortPreparedRenderCatalog(workflowCatalog);
      receipt.status = "failed";
      remapReceiptOutputPath(receipt, publication.outputPublication.stagingPath, resolvedOutputPath);
      await publication.abort();
      workflowCatalog.receiptPath = await writeRenderReceiptFile(receipt, receiptPath, { force: forceOutput });
      workflowCatalog.artifacts = receipt.artifacts;
      return {
        ok: false,
        command: "render",
        lane: "image",
        frameLane,
        preset: stillFramePreset,
        ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
        ...browserWorkflowResultFields(workflowEvidence),
        ...workflowCatalogFields(workflowCatalog),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: receipt.output,
        receipt,
        frameReceipt,
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: receipt.warnings,
        stillFrame,
        error: workflowCatalog.error
      };
    }

    try {
      for (const artifact of browserRendererArtifacts) {
        const remapped = await publication.stageSecondaryArtifact({
          stagedPath: artifact.path,
          outputPath: join(dirname(resolvedOutputPath), `${pkg.manifest.id}-${artifact.role}-${basename(artifact.path)}`),
          artifact: { role: artifact.role, ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}), primary: false },
          inputHashKey: artifact.role === "browser_capture_html" ? "browser-capture-html" : `renderer-artifact:${artifact.role}:${basename(artifact.path)}`
        });
        receipt.artifacts = dedupeReceiptArtifacts([...(receipt.artifacts ?? []), remapped]);
      }
      await publication.stageReceipt(receipt);
      await publication.commit({ cancelled: () => options.signal?.aborted === true });
    } catch (error) {
      await abortPreparedRenderCatalog(workflowCatalog).catch(() => undefined);
      await publication.abort().catch(() => undefined);
      if (error instanceof PairedOutputReceiptCommitUncertainError) {
        return { ok: false, command: "render", lane: "image", frameLane, preset: stillFramePreset, ...pairedPublicationUncertaintyFields(error, "renderCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
      }
      throw error;
    }

    let committedCatalog: RenderReceiptFinalizeResult;
    try {
      committedCatalog = await commitPreparedRenderCatalog(workflowCatalog, receipt);
    } catch (error) {
      return {
        ok: false,
        command: "render",
        lane: "image",
        frameLane,
        preset: stillFramePreset,
        renderCommitted: true,
        ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
        ...browserWorkflowResultFields(workflowEvidence),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: receipt.output,
        receipt,
        receiptPath,
        frameReceipt,
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: receipt.warnings,
        stillFrame,
        error: { code: "render_catalog_update_failed", message: error instanceof Error ? error.message : String(error) }
      };
    }

    return {
      ok: true,
      command: "render",
      lane: "image",
      frameLane,
      preset: stillFramePreset,
      ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
      ...browserWorkflowResultFields(workflowEvidence),
      ...workflowCatalogFields(committedCatalog),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      outputPath: resolvedOutputPath,
      output: receipt.output,
      receipt,
      receiptPath,
      frameReceipt,
      ...(qualityCheck ? { qualityCheck } : {}),
      warnings: receipt.warnings,
      stillFrame
    };
    } catch (error) {
      await abortPreparedRenderCatalog(preparedWorkflowCatalog).catch(() => undefined);
      await publication.abort().catch(() => undefined);
      throw error;
    }
  }
  if (imageSequencePreset) {
    if (frameLane === "gpu") {
      return { ok: false, command: "render", frameLane, error: { code: "unsupported_frame_lane", message: "GPU final rendering supports streamed FFmpeg video only, not image-sequence presets." } };
    }
    const resourcePreflight = preflightMaterializedFrameSequence({
      frameCount,
      width: pkg.motion.width,
      height: pkg.motion.height,
      frameLane,
      motion: pkg.motion
    }, options.materializedFrameSequencePreflight);
    if (resourcePreflight.status === "refused") {
      return materializedFrameSequencePreflightRefusal(resourcePreflight, frameLane);
    }
    const sequenceWarnings = audioInputCount > 0
      ? [`Export preset ${imageSequencePreset} does not support audio; ${audioInputCount} requested audio ${audioInputCount === 1 ? "track" : "tracks"} will be ignored.`]
      : [];
    const sequence = {
      outputDir: resolvedOutputPath,
      framePattern: "%06d.png",
      frameCount,
      width: pkg.motion.width,
      height: pkg.motion.height,
      durationMs: pkg.motion.durationMs,
      fps: pkg.motion.fps
    };
    // A dry run must refuse what execution would refuse.
    const dryRunRefusal = nativeDeliveryRefusal(pkg, frameLane);
    if (dryRunRefusal && argv.includes("--dry-run")) return dryRunRefusal;
    if (argv.includes("--dry-run")) {
      return {
        ok: true,
        command: "render",
        lane: "image-sequence",
        frameLane,
        preset: imageSequencePreset,
        outputPath: resolvedOutputPath,
        ...(quality ? { quality } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        ...(sequenceWarnings.length > 0 ? { warnings: sequenceWarnings } : {}),
        dryRun: true,
        resourcePreflight,
        sequence
      };
    }

    // Preserve the established CLI destination contract first: absent and existing-empty outputs
    // are valid, while --force may replace only the exact admitted caller-selected directory.
    const preparedSequence = await prepareImageSequencePublication(resolvedOutputPath, forceOutput);
    if (!preparedSequence.ok) {
      return {
        ok: false,
        command: "render",
        lane: "image-sequence",
        frameLane,
        preset: imageSequencePreset,
        outputPath: resolvedOutputPath,
        error: preparedSequence.error
      };
    }
    const sequencePublication = preparedSequence.publication;
    let preparedWorkflowCatalog: RenderReceiptFinalizeResult | undefined;
    try {
    let lastFrameReceipt: unknown = null;
    // Every frame contributes its warnings, not just the last one: keeping only the final frame's
    // receipt silently dropped a warning raised on frame 1 of 270.
    const frameLaneWarnings = new FrameLaneWarnings();
    let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
    const framePaths = Array.from({ length: frameCount }, (_, frameIndex) =>
      join(sequencePublication.stagingPath, frameFileName(frameIndex))
    );
    let browserRendererArtifacts: ReceiptArtifact[] = [];
    if (frameLane === "native") {
      // Load the native render session once: the PNG sequence is a user-facing
      // deliverable, so frames keep the default (max) PNG compression; only the load/decode work is
      // shared via a single session.
      const nativeSession = await createNativeRenderSession({ packageRoot, outputRoots: [sequencePublication.stagingPath], renderTarget: "delivery" });
      try {
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
          const framePath = framePaths[frameIndex];
          const atMs = frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs);
          throwIfCancelled(options.signal, "native frame rendering");
          const frame = await nativeSession.renderFrameAtMs(atMs, framePath);
          lastFrameReceipt = frame.receipt;
          frameLaneWarnings.observe(frame.receipt);
          if (!frame.ok) {
            await sequencePublication.abort();
            return {
              ok: false,
              command: "render",
              lane: "image-sequence",
              frameLane,
              error: frame.error,
              frameReceipt: frame.receipt,
              frames: { dir: resolvedOutputPath, count: frameIndex }
            };
          }
        }
      } finally {
        nativeSession.close();
      }
    } else {
      // Honour an injected frame renderer the way `preview` already does. Without this the render
      // command could only be exercised against a real Chromium, so browser-lane render behaviour
      // had no fast test surface at all.
      const browserSession = options.browserFrameRenderer ? undefined : await createMotionBrowserRenderSession(pkg, callerIdForRun ? { callerId: callerIdForRun } : {});
      try {
        const frameRequests = framePaths.map((outputPath, frameIndex) => ({
          outDir: join(sequencePublication.stagingPath, ".browser-render-evidence", String(frameIndex).padStart(6, "0")),
          outputPath,
          atMs: frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs),
          ...(workflow ? { workflow } : {})
        }));
        const frames = await renderBrowserFrameBatch(
          pkg,
          frameRequests.map((frame) => withRendererPrivateOutputPublication(frame, sequencePublication)),
          browserSession,
          options.browserFrameRenderer,
          options.signal
        );
        const lastFrame = frames.at(-1);
        lastFrameReceipt = lastFrame?.receipt ?? null;
        for (const frame of frames) frameLaneWarnings.observe(frame.receipt);
        if (lastFrame) workflowEvidence = browserWorkflowEvidenceFromFrame(lastFrame);
        browserRendererArtifacts = frames.flatMap((frame) => availableRendererArtifacts(frame, frame.output.path));
      } finally {
        await browserSession?.close();
      }
    }
    const sequenceQuality = await inspectFrameSequence({
      framePaths,
      durationMs: pkg.motion.durationMs,
      fps: pkg.motion.fps,
      ...quality
    });
    if (!sequenceQuality.ok) {
      await sequencePublication.abort();
      return {
        ok: false,
        command: "render",
        lane: "image-sequence",
        frameLane,
        preset: imageSequencePreset,
        outputPath: resolvedOutputPath,
        error: {
          code: "frame_quality_failed",
          message: sequenceQuality.message
        },
        frameReceipt: lastFrameReceipt,
        frames: { dir: resolvedOutputPath, count: frameCount },
        ...(quality ? { quality } : {}),
        warnings: [...sequenceWarnings, ...sequenceQuality.warnings],
        sequence
      };
    }

    const receipt = await createImageSequenceReceipt({
      packageId: pkg.manifest.id,
      framesDir: sequencePublication.stagingPath,
      fps: pkg.motion.fps,
      width: pkg.motion.width,
      height: pkg.motion.height,
      durationMs: pkg.motion.durationMs,
      frameCount,
      resourcePreflight,
      warnings: [...sequenceWarnings, ...sequenceQuality.warnings]
    });
    // Fold what the frame lane reported into the receipt an agent actually reads. Without this
    // a font-fallback warning raised while drawing is invisible once the frames are encoded away.
    frameLaneWarnings.applyTo(receipt);
    enrichRenderReceiptWithBrowserWorkflow(receipt, workflowEvidence);
    const rawQualityCheck = qualityManifestPath
      ? await qualityCheckRenderManifest({
          inputPath: sequencePublication.stagingPath,
          manifestPath: qualityManifestPath,
          preset: imageSequencePreset,
          packageRoot,
          ...(frameLane === "browser" ? { previewPackageRoot: packageRoot } : {}),
          durationMs: pkg.motion.durationMs,
          fps: pkg.motion.fps,
          options
        })
      : undefined;
    const qualityCheck = rawQualityCheck ? remapPrivatePublicationResultPaths(rawQualityCheck, sequencePublication.stagingPath, resolvedOutputPath) : undefined;
    if (qualityManifestPath && qualityCheck) {
      await enrichRenderReceiptWithQualityManifest(receipt, qualityManifestPath, qualityCheck);
      if (!qualityCheck.ok) {
        await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
        await sequencePublication.abort();
        const failedReceiptPath = await publishFailedImageSequenceBundle({
          outputPath: resolvedOutputPath,
          receiptPath: renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "image-sequence"),
          receipt
        });
        const qualityError = readRecord(qualityCheck.error);
        return {
          ok: false, command: "render", receiptPath: failedReceiptPath, lane: "image-sequence", frameLane, preset: imageSequencePreset,
          outputPath: resolvedOutputPath, receipt, frameReceipt: lastFrameReceipt, frames: { dir: resolvedOutputPath, count: frameCount },
          qualityManifestPath, qualityCheck,
          error: { code: typeof qualityError?.code === "string" ? qualityError.code : "quality_check_failed", message: typeof qualityError?.message === "string" ? qualityError.message : "Final render quality manifest check failed." },
          warnings: receipt.warnings, sequence
        };
      }
    }
    await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
    const receiptPath = renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "image-sequence");
    const workflowCatalog = preparedWorkflowCatalog = await prepareRenderReceipt({
      packageId: pkg.manifest.id,
      receipt,
      outputPath: resolvedOutputPath,
      receiptPath,
      atMs: 0,
      workflowEvidence,
      workflowCatalogPath,
      failOnDrift, force: forceOutput
    });
    if (workflowCatalog.error) {
      await abortPreparedRenderCatalog(workflowCatalog);
      receipt.status = "failed";
      await sequencePublication.abort();
      workflowCatalog.receiptPath = await publishFailedImageSequenceBundle({
        outputPath: resolvedOutputPath,
        receiptPath,
        receipt
      });
      workflowCatalog.artifacts = receipt.artifacts;
      return {
        ok: false,
        command: "render",
        lane: "image-sequence",
        frameLane,
        preset: imageSequencePreset,
        ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
        ...browserWorkflowResultFields(workflowEvidence),
        ...workflowCatalogFields(workflowCatalog),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: receipt.output,
        receipt,
        frameReceipt: lastFrameReceipt,
        frames: { dir: resolvedOutputPath, count: frameCount },
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: receipt.warnings,
        sequence,
        error: workflowCatalog.error
      };
    }

    const rendererEvidence = await bindDirectoryRendererArtifacts(receipt, browserRendererArtifacts, sequencePublication.stagingPath, resolvedOutputPath);
    receipt.artifacts = dedupeReceiptArtifacts([...(receipt.artifacts ?? []), ...rendererEvidence.artifacts]);
    rebindDirectoryReceiptPaths(receipt, sequencePublication.stagingPath, resolvedOutputPath);
    const receiptRelativePath = relativeBundleFilePath(resolvedOutputPath, receiptPath);
    if (!receiptRelativePath) throw new Error("Image-sequence receipt must remain inside the governed directory bundle.");
    receipt.artifacts = dedupeReceiptArtifacts([...(receipt.artifacts ?? []), { role: "render_receipt", path: receiptPath, status: "available", mediaType: "application/json" }]);
    await writeFile(join(sequencePublication.stagingPath, receiptRelativePath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const inventory = closedDirectoryBundleInventory([
      ...framePaths.map((path) => relativeBundleFilePath(sequencePublication.stagingPath, path)!),
      ...rendererEvidence.inventory,
      receiptRelativePath
    ]);
    await publishGovernedDirectoryBundle(sequencePublication, inventory);
    let committedCatalog: RenderReceiptFinalizeResult;
    try {
      committedCatalog = await commitPreparedRenderCatalog(workflowCatalog, receipt);
    } catch (error) {
      return {
        ok: false,
        command: "render",
        lane: "image-sequence",
        frameLane,
        preset: imageSequencePreset,
        renderCommitted: true,
        ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
        ...browserWorkflowResultFields(workflowEvidence),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: receipt.output,
        receipt,
        receiptPath,
        frameReceipt: lastFrameReceipt,
        frames: { dir: resolvedOutputPath, count: frameCount },
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: receipt.warnings,
        sequence,
        error: { code: "render_catalog_update_failed", message: error instanceof Error ? error.message : String(error) }
      };
    }

    return {
      ok: true,
      command: "render",
      lane: "image-sequence",
      frameLane,
      preset: imageSequencePreset,
      ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
      ...browserWorkflowResultFields(workflowEvidence),
      ...workflowCatalogFields(committedCatalog),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      outputPath: resolvedOutputPath,
      output: receipt.output,
      receipt,
      receiptPath,
      frameReceipt: lastFrameReceipt,
      frames: { dir: resolvedOutputPath, count: frameCount },
      ...(qualityCheck ? { qualityCheck } : {}),
      warnings: receipt.warnings,
      sequence
    };
    } catch (error) {
      await abortPreparedRenderCatalog(preparedWorkflowCatalog).catch(() => undefined);
      await sequencePublication.abort().catch(() => undefined);
      if (error instanceof DirectoryBundleCommitUncertainError) {
        return {
          ok: false,
          command: "render",
          lane: "image-sequence",
          frameLane,
          preset: imageSequencePreset,
          renderCommitUncertain: true,
          possiblyCommitted: true,
          publicationCommitPhase: "output",
          publicPaths: [error.outputPath],
          expectedPublications: [error.expectedPublication],
          outputPath: resolvedOutputPath,
          receiptPath: renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "image-sequence"),
          error: { code: error.code, message: error.message }
        };
      }
      throw error;
    }
  }

  const ffmpegPreset = readFfmpegExportPreset(preset);
  if (!ffmpegPreset) {
    return {
      ok: false,
      command: "render",
      error: {
        code: "unsupported_preset",
        message: `Unsupported export preset: ${preset}.`
      }
    };
  }
  const outputPathError = ffmpegPresetOutputPathError(ffmpegPreset, resolvedOutputPath);
  if (outputPathError) {
    return {
      ok: false,
      command: "render",
      error: {
        code: "invalid_args",
        message: outputPathError
      }
    };
  }
  const warnings = audioWarningsForExportPreset(ffmpegPreset, audioInputCount);
  const segmentFramesValue = optionValue(argv, "--segment-frames"), resumeSegments = hasFlag(argv, "--resume-segments");
  if (resumeSegments && segmentFramesValue === undefined) return { ok: false, command: "render", error: { code: "invalid_args", message: "--resume-segments requires --segment-frames <positive integer>." } };
  const segmented = segmentFramesValue === undefined ? undefined : Number(segmentFramesValue);
  if (segmented !== undefined && (!Number.isSafeInteger(segmented) || segmented <= 0)) return { ok: false, command: "render", error: { code: "invalid_args", message: "--segment-frames must be a positive safe integer." } };
  if (segmented !== undefined) {
    const segmentRequest = { segmentFrames: segmented, resume: resumeSegments, store: "derived-from-output" as const };
    if (keepFrames || optionValue(argv, "--frames-dir") !== undefined) return { ok: false, command: "render", error: { code: "invalid_args", message: "Segmented final delivery owns a derived durable checkpoint store; omit --keep-frames and --frames-dir." } };
    if (workflow || resolvedWorkflowPath) return { ok: false, command: "render", error: { code: "invalid_args", message: "Segmented final delivery does not support browser workflows." } };
    if (qualityManifestPath) return { ok: false, command: "render", error: { code: "invalid_args", message: "Segmented final delivery does not support exact-source quality manifests." } };
    if (forceOutput) return { ok: false, command: "render", error: { code: "invalid_args", message: "Segmented final delivery never overwrites an existing output; omit --force and choose a new output path." } };
    if (hasFlag(argv, "--dry-run")) return { ok: true, command: "render", lane: "ffmpeg", frameLane, preset: ffmpegPreset, ...(quality ? { quality } : {}), ...(warnings.length ? { warnings } : {}), dryRun: true, segmented: segmentRequest };
    const health = await checkFfmpeg({ ...(options.ffmpegRunner ? { runner: options.ffmpegRunner } : {}) });
    if (!health.ok) return { ok: false, command: "render", lane: "ffmpeg", frameLane, error: health.error };
    const outputFileGuard = await outputFileRefusal(resolvedOutputPath, { force: false });
    if (outputFileGuard) return { ok: false, command: "render", lane: "ffmpeg", frameLane, error: outputFileGuard };
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    const receiptPath = renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "ffmpeg");
    const publication = await PairedOutputReceiptPublication.acquire({
      outputPath: resolvedOutputPath, receiptPath,
      outputArtifact: { role: "rendered_media", mediaType: mediaTypeForPath(resolvedOutputPath), primary: true },
      receiptArtifact: { role: "render_receipt", mediaType: "application/json" }
    });
    try {
      const result = await renderSegmentedFinal(withSegmentedFinalCliPublication({ pkg, frameLane, outputPath: resolvedOutputPath, preset: ffmpegPreset, segmented: { segmentFrames: segmented, ...(resumeSegments ? { resume: true } : {}) }, ...(audio ? { audio } : {}), ...(audioTracks ? { audioTracks } : {}), ...(audioMaster ? { audioMaster } : {}), inputRoots: audioPath && resolvedAudioPath ? [dirname(resolvedAudioPath)] : [pkg.root], outputRoots: [dirname(resolvedOutputPath)], ...(quality ? { quality } : {}), signal: options.signal, ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
        ...(callerIdForRun ? { callerId: callerIdForRun } : {}), toolPolicy: { runner: options.ffmpegRunner ?? defaultFfmpegRunner(options.signal, callerIdForRun), ...(forceSoftwareEncode ? { forceSoftwareEncode: true } : {}), ...(health.version ? { ffmpegVersion: health.version } : {}), ...(options.streamingProcessFactory ? { processFactory: options.streamingProcessFactory } : {}) } }, publication.outputPublication));
      if (!result.ok) {
        await publication.abort();
        return { ok: false, command: "render", lane: "ffmpeg", frameLane, segmented: segmentRequest, error: result.error };
      }
      await bindFinalRenderReceiptLineage(result.receipt, pkg, lineage);
      await publication.stageReceipt(result.receipt);
      await publication.commit({ cancelled: () => options.signal?.aborted === true });
      return { ok: true, command: "render", lane: "ffmpeg", frameLane, preset: ffmpegPreset, outputPath: resolvedOutputPath, output: result.receipt.output, receipt: result.receipt, receiptPath, warnings: result.receipt.warnings, frameTransport: result.transport, segmented: segmentRequest };
    } catch (error) {
      await publication.abort().catch(() => undefined);
      if (error instanceof PairedOutputReceiptCommitUncertainError) {
        return { ok: false, command: "render", lane: "ffmpeg", frameLane, segmented: segmentRequest, ...pairedPublicationUncertaintyFields(error, "renderCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
      }
      throw error;
    }
  }
  const retainedBatchQualityManifest = retainedBatchQualityManifestFor(qualityManifestPath, options), gpuDeliveredQuality = frameLane === "gpu" && retainedBatchQualityManifest !== undefined;
  const frameTransport = planFinalVideoFrameTransport({ keepFrames, capturedBrowserWorkflow: Boolean(workflow),
    // Exact-source comparison retains the PNG sequence consumed by the encoder.
    exactSourceQuality: Boolean(qualityManifestPath) && !gpuDeliveredQuality,
    ...(quality ? { minUniqueFrameHashes: quality.minUniqueFrameHashes } : {}),
    injectedFrameRenderer: options.browserFrameRenderer !== undefined });
  const qualityManifest = qualityManifestPath && !gpuDeliveredQuality ? { exactSourceComparison: "required" as const } : undefined;
  const streamingInputRoots = audioPath && resolvedAudioPath ? [dirname(resolvedAudioPath)] : [pkg.root];
  const dryRun = hasFlag(argv, "--dry-run");
  // A dry run refuses the same native delivery incompatibility without touching output state.
  const dryRunRefusal = nativeDeliveryRefusal(pkg, frameLane);
  if (dryRunRefusal && dryRun) return dryRunRefusal;

  if (frameTransport.delivery === "streamed") {
    const plannedAudio = frameLane === "gpu"
      ? preliminaryGpuAudio({ pkg, ...(audio ? { audio } : {}), ...(audioTracks ? { audioTracks } : {}), ...(audioMaster ? { audioMaster } : {}) })
      : { ...(audio ? { audio } : {}), ...(audioTracks ? { audioTracks } : {}), ...(audioMaster ? { audioMaster } : {}) };
    const streamingPlan = planStreamingFinalCommand({
      fps: pkg.motion.fps,
      width: pkg.motion.width,
      height: pkg.motion.height,
      durationMs: pkg.motion.durationMs,
      ...(frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
      outputPath: resolvedOutputPath,
      preset: ffmpegPreset,
      ...plannedAudio,
      inputRoots: streamingInputRoots,
      outputRoots: [dirname(resolvedOutputPath)],
      ...(quality ? { quality } : {}),
      ...(qualityManifest ? { qualityManifest } : {}),
      keepFrames,
      transport: frameTransport,
      capturedBrowserWorkflow: Boolean(workflow),
      injectedFrameRenderer: options.browserFrameRenderer !== undefined
    });
    if (!streamingPlan.ok) {
      return {
        ok: false,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        frameTransport: streamingPlan.transport,
        error: streamingPlan.error
      };
    }
    if (dryRun) {
      return {
        ok: true,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        preset: ffmpegPreset,
        ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
        ...(audio ? { audio } : {}),
        ...(audioTracks ? { audioTracks } : {}),
        ...(quality ? { quality } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        dryRun: true,
        frameTransport: streamingPlan.transport,
        ffmpeg: streamingPlan.command
      };
    }
    const health = await checkFfmpeg({ ...(options.ffmpegRunner ? { runner: options.ffmpegRunner } : {}) });
    if (!health.ok) return { ok: false, command: "render", lane: "ffmpeg", frameTransport, error: health.error };
    const receiptPath = renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "ffmpeg");
    const publication = await PairedOutputReceiptPublication.acquire({
      outputPath: resolvedOutputPath, receiptPath,
      outputArtifact: { role: "rendered_media", mediaType: mediaTypeForPath(resolvedOutputPath), primary: true },
      receiptArtifact: { role: "render_receipt", mediaType: "application/json" },
      ...(forceOutput ? { forceOutput: true, forceReceipt: true } : {})
    });
    let streamed: Awaited<ReturnType<typeof renderStreamingFinal>>;
    try {
      streamed = await renderStreamingFinal({
      pkg,
      frameLane,
      outputPath: resolvedOutputPath,
      preset: ffmpegPreset,
      ...(audio ? { audio } : {}),
      ...(audioTracks ? { audioTracks } : {}),
      ...(audioMaster ? { audioMaster } : {}),
      inputRoots: streamingInputRoots,
      outputRoots: [dirname(resolvedOutputPath)],
      ...(quality ? { quality } : {}),
      ...(qualityManifest ? { qualityManifest } : {}),
      keepFrames,
      ...(forceOutput ? { force: true } : {}),
      outputPublication: publication.outputPublication,
      transport: frameTransport,
      signal: options.signal,
      toolPolicy: {
        runner: options.ffmpegRunner ?? defaultFfmpegRunner(options.signal, callerIdForRun),
        ...(forceSoftwareEncode ? { forceSoftwareEncode: true } : {}),
        ...(health.version ? { ffmpegVersion: health.version } : {}),
        ...(options.streamingProcessFactory ? { processFactory: options.streamingProcessFactory } : {})
      }
      });
    } catch (error) {
      await publication.abort().catch(() => undefined);
      throw error;
    }
    if (!streamed.ok) {
      await publication.abort().catch(() => undefined);
      return {
        ok: false,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        frameTransport,
        ffmpegPlan: streamingPlan.command,
        error: streamed.error
      };
    }
    const finalCommand = { ...streamed.command, args: streamed.command.args.map((arg) => arg === publication.outputPublication.stagingPath ? resolvedOutputPath : arg) };
    const rawQualityCheck = qualityManifestPath ? await qualityCheckRenderManifest({ inputPath: publication.outputPublication.stagingPath, manifestPath: qualityManifestPath, preset: ffmpegPreset, packageRoot, durationMs: pkg.motion.durationMs, fps: pkg.motion.fps, options }) : undefined;
    const qualityCheck = rawQualityCheck
      ? remapPrivatePublicationResultPaths(rawQualityCheck, publication.outputPublication.stagingPath, resolvedOutputPath)
      : undefined;
    if (qualityManifestPath && qualityCheck) {
      await enrichRenderReceiptWithQualityManifest(streamed.receipt, qualityManifestPath, qualityCheck);
      await recordReceiptFfprobeProvenance(streamed.receipt, { contributed: true, ...(options.ffmpegRunner ? { runner: options.ffmpegRunner } : {}) });
      if (!qualityCheck.ok) {
        await bindFinalRenderReceiptLineage(streamed.receipt, pkg, lineage);
        remapReceiptOutputPath(streamed.receipt, publication.outputPublication.stagingPath, resolvedOutputPath);
        await publication.abort();
        return await renderQualityManifestFailure({ packageId: pkg.manifest.id, lane: "ffmpeg", frameLane, preset: ffmpegPreset, outputPath: resolvedOutputPath, receipt: streamed.receipt, qualityManifestPath, qualityCheck, force: forceOutput, extra: { frameTransport, ffmpeg: finalCommand } });
      }
    }
    await bindFinalRenderReceiptLineage(streamed.receipt, pkg, lineage);
    let workflowCatalog: RenderReceiptFinalizeResult | undefined;
    try {
      const preparedCatalog = await prepareRenderReceipt({
        packageId: pkg.manifest.id,
        receipt: streamed.receipt,
        outputPath: resolvedOutputPath,
        receiptPath,
        atMs: 0,
        workflowCatalogPath,
        failOnDrift, force: forceOutput
      });
      workflowCatalog = preparedCatalog;
      if (preparedCatalog.error) {
        await abortPreparedRenderCatalog(preparedCatalog);
        streamed.receipt.status = "failed";
        remapReceiptOutputPath(streamed.receipt, publication.outputPublication.stagingPath, resolvedOutputPath);
        await publication.abort();
        preparedCatalog.receiptPath = await writeRenderReceiptFile(streamed.receipt, receiptPath, { force: forceOutput });
        preparedCatalog.artifacts = streamed.receipt.artifacts;
        return {
          ok: false,
          command: "render",
          lane: "ffmpeg",
          frameLane,
          preset: ffmpegPreset,
          ...workflowCatalogFields(preparedCatalog),
          ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
          ...(audio ? { audio } : {}),
          ...(audioTracks ? { audioTracks } : {}),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          outputPath: resolvedOutputPath,
          output: streamed.receipt.output,
          receipt: streamed.receipt,
          ...(qualityCheck ? { qualityCheck } : {}),
          warnings: streamed.receipt.warnings,
          frameTransport,
          ffmpeg: finalCommand,
          error: preparedCatalog.error
        };
      }
      await publication.stageReceipt(streamed.receipt);
      await publication.commit({ cancelled: () => options.signal?.aborted === true });
    } catch (error) {
      await abortPreparedRenderCatalog(workflowCatalog).catch(() => undefined);
      await publication.abort().catch(() => undefined);
      if (error instanceof PairedOutputReceiptCommitUncertainError) {
        return { ok: false, command: "render", lane: "ffmpeg", frameLane, preset: ffmpegPreset, ...pairedPublicationUncertaintyFields(error, "renderCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
      }
      throw error;
    }
    let committedCatalog: RenderReceiptFinalizeResult;
    try {
      committedCatalog = await commitPreparedRenderCatalog(workflowCatalog!, streamed.receipt);
    } catch (error) {
      return {
        ok: false,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        preset: ffmpegPreset,
        renderCommitted: true,
        ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
        ...(audio ? { audio } : {}),
        ...(audioTracks ? { audioTracks } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: streamed.receipt.output,
        receipt: streamed.receipt,
        receiptPath,
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: streamed.receipt.warnings,
        frameTransport,
        ffmpeg: finalCommand,
        error: { code: "render_catalog_update_failed", message: error instanceof Error ? error.message : String(error) }
      };
    }
    return {
      ok: true,
      command: "render",
      lane: "ffmpeg",
      frameLane,
      preset: ffmpegPreset,
      ...workflowCatalogFields(committedCatalog),
      ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
      ...(audio ? { audio } : {}),
      ...(audioTracks ? { audioTracks } : {}),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      outputPath: resolvedOutputPath,
      output: streamed.receipt.output,
      receipt: streamed.receipt,
      receiptPath,
      ...(qualityCheck ? { qualityCheck } : {}),
      warnings: streamed.receipt.warnings,
      frameTransport,
      ffmpeg: finalCommand
    };
  }

  if (frameLane === "gpu") {
    return {
      ok: false,
      command: "render",
      lane: "ffmpeg",
      frameLane,
      frameTransport,
      error: {
        code: "unsupported_frame_lane",
        message: `GPU final rendering requires the strict streamed FFmpeg path; ${frameTransport.reason} requires materialized frames and GPU never falls back.`
      }
    };
  }

  const receiptPath = renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "ffmpeg");
  let materializedPublication: PairedOutputReceiptPublication | undefined;
  if (!dryRun) {
    const framesRefusal = await materializedDeliveryRefusal(resolvedOutputPath, framesDir, {
      force: forceOutput,
      callerSupplied: framesDirCallerSupplied,
      withinRoot: framesRoot
    });
    if (framesRefusal) {
      return { ok: false, command: "render", lane: "ffmpeg", frameLane, frameTransport, error: framesRefusal };
    }
    try {
      materializedPublication = await PairedOutputReceiptPublication.acquire({
        outputPath: resolvedOutputPath,
        receiptPath,
        outputArtifact: { role: "rendered_media", mediaType: mediaTypeForPath(resolvedOutputPath), primary: true },
        receiptArtifact: { role: "render_receipt", mediaType: "application/json" },
        ...(forceOutput ? { forceOutput: true, forceReceipt: true } : {})
      });
    } catch (error) {
      return {
        ok: false,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        frameTransport,
        error: {
          code: (error as { code?: string }).code ?? "derived_output_publish_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
  const materialized = await renderMaterializedFinalVideo({
    pkg,
    packageRoot,
    frameLane,
    frameCount,
    framesDir,
    framesRoot,
    framesDirCallerSupplied,
    outputPath: resolvedOutputPath,
    preset: ffmpegPreset,
    ...(audio ? { audio } : {}),
    ...(audioTracks ? { audioTracks } : {}),
    ...(audioMaster ? { audioMaster } : {}),
    inputRoots: ffmpegInputRoots,
    outputRoots: [dirname(resolvedOutputPath)],
    ...(quality ? { quality } : {}),
    forceSoftwareEncode,
    force: forceOutput,
    keepFrames,
    dryRun,
    ...(materializedPublication ? { outputPublication: materializedPublication.outputPublication, deferOutputPublication: true } : {}),
    ...(workflow ? { workflow } : {}),
    ...(callerIdForRun ? { callerId: callerIdForRun } : {}),
    ...(options.browserFrameRenderer ? { browserFrameRenderer: options.browserFrameRenderer } : {}),
    ...(options.ffmpegRunner ? { ffmpegRunner: options.ffmpegRunner } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.materializedFrameSequencePreflight ? { preflight: options.materializedFrameSequencePreflight } : {})
  });
  if (materialized.kind === "refused") {
    await materializedPublication?.abort().catch(() => undefined);
    const failedReceipt = materialized.response.receipt;
    if (!failedReceipt) return { ...materialized.response, frameTransport };
    await bindFinalRenderReceiptLineage(failedReceipt, pkg, lineage);
    failedReceipt.output = { ...(readRecord(failedReceipt.output) ?? {}), frameTransportPlan: frameTransport };
    const failedReceiptPath = await writeRenderReceiptFile(
      failedReceipt,
      receiptPath,
      { force: forceOutput }
    );
    return { ...materialized.response, receipt: failedReceipt, receiptPath: failedReceiptPath, frameTransport, warnings: failedReceipt.warnings };
  }
  if (materialized.kind === "dry-run") {
    return {
      ok: true,
      command: "render",
      lane: "ffmpeg",
      frameLane,
      preset: ffmpegPreset,
      ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
      ...(audio ? { audio } : {}),
      ...(audioTracks ? { audioTracks } : {}),
      ...(quality ? { quality } : {}),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      dryRun: true,
      frameTransport,
      resourcePreflight: materialized.resourcePreflight,
      ffmpeg: materialized.command
    };
  }
  const { encoded, lastFrameReceipt, frames, workflowEvidence, cleanup } = materialized;
  const pairedOutput = materializedPublication;
  if (!dryRun && !pairedOutput) throw new Error("Materialized final render lost its paired output reservation.");
  let cleanedFrames = false;
  try {
    // Streaming receipts expose bounded execution evidence under `frameTransport`. The materialized
    // route has its existing source-frame / resource evidence, so it records only the planner result.
    encoded.receipt.output = { ...(readRecord(encoded.receipt.output) ?? {}), frameTransportPlan: frameTransport };
    enrichRenderReceiptWithBrowserWorkflow(encoded.receipt, workflowEvidence);
    const rawQualityCheck = qualityManifestPath
      ? await qualityCheckRenderManifest({
          inputPath: pairedOutput?.outputPublication.stagingPath ?? resolvedOutputPath,
          manifestPath: qualityManifestPath,
          preset: ffmpegPreset,
          packageRoot,
          // The pre-encode frames the encoder consumed are still on disk here (both native and browser
          // frame lanes write them to framesDir), so the manifest compares each delivered frame against
          // its exact source frame — deterministic pre-encode renderer identity, no re-render.
          sourceFramesDir: framesDir,
          durationMs: pkg.motion.durationMs,
          fps: pkg.motion.fps,
          options
        })
      : undefined;
    // A materialized planner route can use scratch PNGs without retaining them. Once those are
    // cleaned, receipt/result evidence must not point callers at a deleted source frame.
    const publicQualityCheck = rawQualityCheck && pairedOutput
      ? remapPrivatePublicationResultPaths(rawQualityCheck, pairedOutput.outputPublication.stagingPath, resolvedOutputPath)
      : rawQualityCheck;
    const qualityCheck = publicQualityCheck && !frames
      ? withoutTransientFrameSourcePaths(publicQualityCheck, framesDir)
      : publicQualityCheck;
    if (qualityManifestPath && qualityCheck) {
      await enrichRenderReceiptWithQualityManifest(encoded.receipt, qualityManifestPath, qualityCheck);
      // FFprobe read this media back to produce the quality evidence above, so it belongs in the
      // receipt's tool provenance alongside the encoder that wrote it (the tool-identity invariant, the tool-provenance invariant):
      // two FFmpeg builds pick different filters, muxers and defaults, so "libx264" alone cannot
      // reproduce or vouch for an encode. The rule (probe only where FFprobe contributed; record only
      // when the probe answered) lives in debug-api's `recordReceiptFfprobeProvenance` so this
      // receipt and the one an agent gets from `motion.render.final` carry the same evidence.
      await recordReceiptFfprobeProvenance(encoded.receipt, {
        // Reaching this line means the ffmpeg lane's manifest ran, which reads the delivered media
        // back through FFprobe.
        contributed: true,
        ...(options.ffmpegRunner ? { runner: options.ffmpegRunner } : {})
      });
      if (!qualityCheck.ok) {
        await bindFinalRenderReceiptLineage(encoded.receipt, pkg, lineage);
        if (pairedOutput) {
          remapReceiptOutputPath(encoded.receipt, pairedOutput.outputPublication.stagingPath, resolvedOutputPath);
          await pairedOutput.abort().catch(() => undefined);
        }
        return await renderQualityManifestFailure({
          packageId: pkg.manifest.id,
          lane: "ffmpeg",
          frameLane,
          preset: ffmpegPreset,
          outputPath: resolvedOutputPath,
          receipt: encoded.receipt,
          ...(frames ? { frameReceipt: lastFrameReceipt } : {}),
          ...(frames ? { frames } : {}),
          qualityManifestPath,
          qualityCheck,
          force: forceOutput,
          extra: { frameTransport, ffmpeg: encoded.command }
        });
      }
    }
    await bindFinalRenderReceiptLineage(encoded.receipt, pkg, lineage);
    const workflowCatalog = await prepareRenderReceipt({
      packageId: pkg.manifest.id,
      receipt: encoded.receipt,
      outputPath: resolvedOutputPath,
      receiptPath,
      atMs: 0,
      workflowEvidence,
      workflowCatalogPath,
      failOnDrift, force: forceOutput
    });
    if (workflowCatalog.error) {
      await abortPreparedRenderCatalog(workflowCatalog);
      encoded.receipt.status = "failed";
      if (pairedOutput) {
        remapReceiptOutputPath(encoded.receipt, pairedOutput.outputPublication.stagingPath, resolvedOutputPath);
        await pairedOutput.abort().catch(() => undefined);
        workflowCatalog.receiptPath = await writeRenderReceiptFile(encoded.receipt, receiptPath, { force: forceOutput });
        workflowCatalog.artifacts = encoded.receipt.artifacts;
      }
      return {
        ok: false,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        preset: ffmpegPreset,
        ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
        ...browserWorkflowResultFields(workflowEvidence),
        ...workflowCatalogFields(workflowCatalog),
        ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
        ...(audio ? { audio } : {}),
        ...(audioTracks ? { audioTracks } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: encoded.receipt.output,
        receipt: encoded.receipt,
        ...(frames ? { frameReceipt: lastFrameReceipt } : {}),
        ...(frames ? { frames } : {}),
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: encoded.receipt.warnings,
        frameTransport,
        ffmpeg: pairedOutput ? remapFfmpegOutputPath(encoded.command, pairedOutput.outputPublication.stagingPath, resolvedOutputPath) : encoded.command,
        error: workflowCatalog.error
      };
    }

    if (pairedOutput) {
      try {
        await pairedOutput.stageReceipt(encoded.receipt);
        // The output must be the final potentially-public I/O.  Cleanup can fail, so finish it
        // while the media is still private and the paired receipt can still be safely revoked.
        await cleanup();
        cleanedFrames = true;
        await pairedOutput.commit({ cancelled: () => options.signal?.aborted === true });
      } catch (error) {
        await abortPreparedRenderCatalog(workflowCatalog).catch(() => undefined);
        await pairedOutput.abort().catch(() => undefined);
        if (error instanceof PairedOutputReceiptCommitUncertainError) {
          return { ok: false, command: "render", lane: "ffmpeg", frameLane, preset: ffmpegPreset, ...pairedPublicationUncertaintyFields(error, "renderCommitUncertain"), error: pairedPublicationUncertaintyError(error) };
        }
        throw error;
      }
    }

    let committedCatalog: RenderReceiptFinalizeResult;
    try {
      committedCatalog = await commitPreparedRenderCatalog(workflowCatalog, encoded.receipt);
    } catch (error) {
      return {
        ok: false,
        command: "render",
        lane: "ffmpeg",
        frameLane,
        preset: ffmpegPreset,
        renderCommitted: true,
        ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
        ...browserWorkflowResultFields(workflowEvidence),
        ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
        ...(audio ? { audio } : {}),
        ...(audioTracks ? { audioTracks } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        outputPath: resolvedOutputPath,
        output: encoded.receipt.output,
        receipt: encoded.receipt,
        receiptPath,
        ...(frames ? { frameReceipt: lastFrameReceipt } : {}),
        ...(frames ? { frames } : {}),
        ...(qualityCheck ? { qualityCheck } : {}),
        warnings: encoded.receipt.warnings,
        frameTransport,
        ffmpeg: pairedOutput ? remapFfmpegOutputPath(encoded.command, pairedOutput.outputPublication.stagingPath, resolvedOutputPath) : encoded.command,
        error: { code: "render_catalog_update_failed", message: error instanceof Error ? error.message : String(error) }
      };
    }

    return {
      ok: true,
      command: "render",
      lane: "ffmpeg",
      frameLane,
      preset: ffmpegPreset,
      ...(resolvedWorkflowPath ? { workflowPath: resolvedWorkflowPath } : {}),
      ...browserWorkflowResultFields(workflowEvidence),
      ...workflowCatalogFields(committedCatalog),
      ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
      ...(audio ? { audio } : {}),
      ...(audioTracks ? { audioTracks } : {}),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      outputPath: resolvedOutputPath,
      output: encoded.receipt.output,
      receipt: encoded.receipt,
      receiptPath,
      ...(frames ? { frameReceipt: lastFrameReceipt } : {}),
      ...(frames ? { frames } : {}),
      ...(qualityCheck ? { qualityCheck } : {}),
      warnings: encoded.receipt.warnings,
      frameTransport,
      ffmpeg: pairedOutput ? remapFfmpegOutputPath(encoded.command, pairedOutput.outputPublication.stagingPath, resolvedOutputPath) : encoded.command
    };
  } finally {
    if (!cleanedFrames) await cleanup();
  }
}

function retainedBatchQualityManifestFor(manifestPath: string | undefined, options: RunCliOptions): RunCliOptions["retainedBatchQualityManifest"] | undefined { const retained = options.retainedBatchQualityManifest; return manifestPath && retained && resolve(manifestPath) === resolve(retained.published.appliedPath) ? retained : undefined; }

async function qualityCheckRenderManifest(input: {
  inputPath: string;
  manifestPath: string;
  preset: MotionExportPreset;
  packageRoot: string;
  previewPackageRoot?: string;
  /** Pre-encode renderer frames dir; when set, drives pre-encode identity baselines (mp4/video lane). */
  sourceFramesDir?: string;
  durationMs: number;
  fps: number;
  options: RunCliOptions;
}): Promise<CliResult> {
  const qualityRoot = resolveOutputPath(input.options.scratchRoot ? join(input.options.scratchRoot, "quality") : ".scratch/quality");
  const runner = input.options.ffmpegRunner ?? defaultFfmpegRunner(input.options.signal, input.options.callerId);
  const batchRetained = retainedBatchQualityManifestFor(input.manifestPath, input.options);
  let retained: Awaited<ReturnType<typeof retainQualityManifestForEvaluation>> | undefined;
  if (!batchRetained) try { retained = await retainQualityManifestForEvaluation(input.manifestPath, join(qualityRoot, "inputs"), { packageId: basename(input.packageRoot), packageDir: input.packageRoot, outputPath: input.inputPath }); } catch (error) { return invalidQualityArgs(error instanceof Error ? error.message : String(error)); }
  const appliedPath = batchRetained?.published.appliedPath ?? retained!.published.appliedPath;
  const qualityInputs = batchRetained?.evidence ?? retained!.evidence;
  const finish = (result: CliResult): CliResult => {
    if (retained) remapRetainedQualityInputPaths(result, retained, input.manifestPath);
    return {
      ...result,
      manifestPath: input.manifestPath,
      qualityManifestAppliedPath: appliedPath,
      qualityInputs,
    };
  };
  if (input.preset === "png-frame") {
    return finish(await qualityCheckPngStillFrameManifest({
      inputPath: input.inputPath,
      manifestPath: appliedPath,
      qualityRoot,
      runner,
      ...(input.previewPackageRoot ? { previewPackageRoot: input.previewPackageRoot } : {}),
      previewLane: "browser"
    }));
  }
  if (input.preset === "png-sequence") {
    return finish(await qualityCheckPngSequenceManifest({
      inputPath: input.inputPath,
      manifestPath: appliedPath,
      qualityRoot,
      runner,
      durationMs: input.durationMs,
      fps: input.fps,
      ...(input.previewPackageRoot ? { previewPackageRoot: input.previewPackageRoot } : {}),
      previewLane: "browser"
    }));
  }
  const args = [
    input.inputPath,
    "--manifest",
    appliedPath
  ];
  // Prefer the deterministic pre-encode renderer baseline (video lane). Fall back to a re-rendered
  // browser preview only when the pre-encode frames are unavailable.
  if (input.sourceFramesDir) {
    args.push("--source-frames-dir", input.sourceFramesDir);
  } else if (input.previewPackageRoot) {
    args.push("--preview-package", input.previewPackageRoot, "--preview-lane", "browser");
  }
  return finish(await qualityCheckCommand(args, input.options));
}

function audioLayerAssetRef(layer: Awaited<ReturnType<typeof loadMotionPackage>>["motion"]["layers"][number]): string | undefined {
  for (const value of [layer.assetRef, layer.source, layer.src, layer.assetId]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function hasSoloedTimelineTrack(motion: Pick<ExpandedMotionJob["motion"], "tracks">): boolean {
  return (motion.tracks ?? []).some((track) => track.solo === true);
}

function isLocalAssetRef(ref: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

async function qualityCheckCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const input = argv[0];
  if (!input) return missingArgument("quality-check", "input path");

  const expectWidth = numericOption(argv, "--expect-width");
  if (!expectWidth.ok) return expectWidth.result;
  const expectHeight = numericOption(argv, "--expect-height");
  if (!expectHeight.ok) return expectHeight.result;
  const minBrightPixels = numericOption(argv, "--min-bright-pixels", 0);
  if (!minBrightPixels.ok) return minBrightPixels.result;
  const minEdgePixels = numericOption(argv, "--min-edge-pixels", 0);
  if (!minEdgePixels.ok) return minEdgePixels.result;
  const minTransparentPixels = numericOption(argv, "--min-transparent-pixels", 0);
  if (!minTransparentPixels.ok) return minTransparentPixels.result;
  const minNonTransparentPixels = numericOption(argv, "--min-non-transparent-pixels", 0);
  if (!minNonTransparentPixels.ok) return minNonTransparentPixels.result;
  const atMs = numericOption(argv, "--at-ms", 0);
  if (!atMs.ok) return atMs.result;
  const maxChangedPixels = numericOption(argv, "--max-changed-pixels");
  if (!maxChangedPixels.ok) return maxChangedPixels.result;
  const maxMeanDiff = numericOption(argv, "--max-mean-diff");
  if (!maxMeanDiff.ok) return maxMeanDiff.result;
  const minPsnrDb = numericOption(argv, "--min-psnr-db");
  if (!minPsnrDb.ok) return minPsnrDb.result;
  const minSsim = unitIntervalOption(argv, "--min-ssim");
  if (!minSsim.ok) return minSsim.result;
  const compareAlpha = !hasFlag(argv, "--compare-rgb-only");
  const maxAudioPeakDb = finiteOption(argv, "--max-audio-peak-db");
  if (!maxAudioPeakDb.ok) return maxAudioPeakDb.result;
  const minAudioPeakDb = finiteOption(argv, "--min-audio-peak-db");
  if (!minAudioPeakDb.ok) return minAudioPeakDb.result;
  const minAudioMeanDb = finiteOption(argv, "--min-audio-mean-db");
  if (!minAudioMeanDb.ok) return minAudioMeanDb.result;
  const minAudioLoudnessLufs = finiteOption(argv, "--min-audio-lufs");
  if (!minAudioLoudnessLufs.ok) return minAudioLoudnessLufs.result;
  const maxAudioLoudnessLufs = finiteOption(argv, "--max-audio-lufs");
  if (!maxAudioLoudnessLufs.ok) return maxAudioLoudnessLufs.result;
  const maxAudioTruePeakDbtp = finiteOption(argv, "--max-audio-true-peak-dbtp");
  if (!maxAudioTruePeakDbtp.ok) return maxAudioTruePeakDbtp.result;
  const maxAudioLoudnessRangeLu = numericOption(argv, "--max-audio-lra-lu");
  if (!maxAudioLoudnessRangeLu.ok) return maxAudioLoudnessRangeLu.result;
  if (minAudioLoudnessLufs.value !== undefined
    && maxAudioLoudnessLufs.value !== undefined
    && minAudioLoudnessLufs.value > maxAudioLoudnessLufs.value) {
    return invalidQualityArgs("--min-audio-lufs must be less than or equal to --max-audio-lufs.");
  }
  const expectAudio = hasFlag(argv, "--expect-audio");
  const manifestRef = optionValue(argv, "--manifest");
  const manifestPath = manifestRef ? resolveInputPath(manifestRef) : undefined;
  const baselineRef = optionValue(argv, "--baseline");
  const baselinePath = baselineRef ? resolveInputPath(baselineRef) : undefined;
  const previewPackageRef = optionValue(argv, "--preview-package");
  const previewPackageRoot = previewPackageRef ? resolveInputPath(previewPackageRef) : undefined;
  const sourceFramesDirRef = optionValue(argv, "--source-frames-dir");
  const sourceFramesDir = sourceFramesDirRef ? resolveInputPath(sourceFramesDirRef) : undefined;
  const previewLane = optionValue(argv, "--preview-lane") ?? "browser";
  if (previewPackageRoot && previewLane !== "browser" && previewLane !== "native") {
    return {
      ok: false,
      command: "quality-check",
      error: {
        code: "invalid_args",
        message: `Unsupported preview lane: ${previewLane}.`
      }
    };
  }

  const inputPath = resolveInputPath(input);
  const runner = options.ffmpegRunner ?? defaultFfmpegRunner(options.signal, resolveCallerId(argv, options));
  const qualityRoot = resolveOutputPath(options.scratchRoot ? join(options.scratchRoot, "quality") : ".scratch/quality");
  const framePath = join(qualityRoot, `${basename(inputPath).replace(/\.[^.]+$/, "") || "media"}-frame.png`);
  const batchRetainedManifest = manifestPath ? retainedBatchQualityManifestFor(manifestPath, options) : undefined;
  let retainedManifest: Awaited<ReturnType<typeof retainQualityManifestForEvaluation>> | undefined;
  if (manifestPath && !batchRetainedManifest) try { retainedManifest = await retainQualityManifestForEvaluation(manifestPath, join(qualityRoot, "inputs"), { packageId: "quality_check", packageDir: qualityRoot, outputPath: inputPath }); } catch (error) { return invalidQualityArgs(error instanceof Error ? error.message : String(error)); }

  let media: Awaited<ReturnType<typeof probeMedia>>;
  try {
    media = await probeMedia(inputPath, { runner, inputRoots: [dirname(inputPath)], admittedQualityInput: true });
  } catch (error) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      error: {
        code: "ffmpeg_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }

  if (expectWidth.value !== undefined && media.width !== expectWidth.value) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      media,
      error: {
        code: "media_quality_failed",
        message: `Media width is ${media.width}; expected ${expectWidth.value}.`
      }
    };
  }
  if (expectHeight.value !== undefined && media.height !== expectHeight.value) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      media,
      error: {
        code: "media_quality_failed",
        message: `Media height is ${media.height}; expected ${expectHeight.value}.`
      }
    };
  }
  const audioCheck = await qualityCheckAudioPolicy({
    inputPath,
    media,
    runner,
    expectAudio,
    maxPeakDb: maxAudioPeakDb.value,
    minPeakDb: minAudioPeakDb.value,
    minMeanDb: minAudioMeanDb.value,
    minIntegratedLoudnessLufs: minAudioLoudnessLufs.value,
    maxIntegratedLoudnessLufs: maxAudioLoudnessLufs.value,
    maxTruePeakDbtp: maxAudioTruePeakDbtp.value,
    maxLoudnessRangeLu: maxAudioLoudnessRangeLu.value
  });
  if (!audioCheck.ok) return audioCheck.result;
  const audioLevels = audioCheck.audioLevels;

  if (manifestPath) {
    const appliedManifestPath = batchRetainedManifest?.published.appliedPath ?? retainedManifest!.published.appliedPath, qualityInputs = batchRetainedManifest?.evidence ?? retainedManifest!.evidence;
    const result = await qualityCheckManifest({
      inputPath,
      manifestPath: appliedManifestPath,
      media,
      qualityRoot,
      runner,
      previewPackageRoot,
      previewLane: previewLane as "browser" | "native",
      ...(sourceFramesDir ? { sourceFramesDir } : {}),
      defaultMinBrightPixels: minBrightPixels.value ?? 0,
      defaultMinEdgePixels: minEdgePixels.value ?? 0,
      defaultMinTransparentPixels: minTransparentPixels.value ?? 0,
      defaultMinNonTransparentPixels: minNonTransparentPixels.value ?? 0,
      defaultMaxChangedPixels: maxChangedPixels.value ?? 0,
      defaultMaxMeanDiff: maxMeanDiff.value ?? 0,
      defaultMinPsnrDb: minPsnrDb.value,
      defaultMinSsim: minSsim.value,
      cliAudioLevels: audioLevels
    });
    if (retainedManifest) remapRetainedQualityInputPaths(result, retainedManifest, manifestPath);
    return {
      ...result,
      manifestPath,
      qualityManifestAppliedPath: appliedManifestPath,
      qualityInputs,
    };
  }

  await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
  const seekArgs = (atMs.value ?? 0) > 0 ? ["-ss", formatSeconds((atMs.value ?? 0) / 1000)] : [];
  const extractCommand: FfmpegCommand = {
    executable: resolveFfmpegExecutable(),
    args: ["-y", ...seekArgs, ...frameExtractionInputArgs(media, inputPath, { admittedQualityInput: true }), ...frameExtractionPngOutputArgs(media, framePath)],
    shell: false
  };
  const extracted = await runner(extractCommand);
  if (extracted.exitCode !== 0) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      media,
      ffmpeg: extractCommand,
      error: {
        code: extracted.exitCode === 127 ? "ffmpeg_not_configured" : "ffmpeg_failed",
        message: summarizeProcessOutput(extracted) || `ffmpeg exited with code ${extracted.exitCode}`
      }
    };
  }

  const inspected = await inspectPngFile(framePath);
  if (!inspected.ok) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      framePath,
      media,
      error: {
        code: "visual_quality_failed",
        message: inspected.message
      }
    };
  }

  const quality = summarizeFrameQuality([inspected]);
  if (quality.minBrightPixels < (minBrightPixels.value ?? 0)) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      framePath,
      atMs: atMs.value ?? 0,
      media,
      quality,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minBrightPixels} bright pixels; expected at least ${minBrightPixels.value}.`
      }
    };
  }
  if (quality.minEdgePixels < (minEdgePixels.value ?? 0)) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      framePath,
      atMs: atMs.value ?? 0,
      media,
      quality,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minEdgePixels} edge pixels; expected at least ${minEdgePixels.value}.`
      }
    };
  }
  if (quality.minTransparentPixels < (minTransparentPixels.value ?? 0)) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      framePath,
      atMs: atMs.value ?? 0,
      media,
      quality,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minTransparentPixels} transparent pixels; expected at least ${minTransparentPixels.value}.`
      }
    };
  }
  if (quality.minNonTransparentPixels < (minNonTransparentPixels.value ?? 0)) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      framePath,
      atMs: atMs.value ?? 0,
      media,
      quality,
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minNonTransparentPixels} non-transparent pixels; expected at least ${minNonTransparentPixels.value}.`
      }
    };
  }

  let preview: QualityPreviewBaseline | undefined;
  let comparisonBaselinePath = baselinePath;
  if (!comparisonBaselinePath && previewPackageRoot) {
    try {
      preview = await renderQualityPreviewBaseline({
        packageRoot: previewPackageRoot,
        lane: previewLane as "browser" | "native",
        atMs: atMs.value ?? 0,
        framePath: join(qualityRoot, `${basename(inputPath).replace(/\.[^.]+$/, "") || "media"}-preview-${atMs.value ?? 0}.png`)
      });
      comparisonBaselinePath = preview.framePath;
    } catch (error) {
      return {
        ok: false,
        command: "quality-check",
        inputPath,
        framePath,
        atMs: atMs.value ?? 0,
        media,
        quality,
        error: {
          code: "preview_render_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  const visualDiff = comparisonBaselinePath ? await comparePngFiles(framePath, comparisonBaselinePath, { compareAlpha }) : undefined;
  if (!comparisonBaselinePath && (minPsnrDb.value !== undefined || minSsim.value !== undefined)) {
    return invalidQualityArgs("--min-psnr-db and --min-ssim require --baseline or --preview-package.");
  }
  if (visualDiff && !visualDiff.ok) {
    return {
      ok: false,
      command: "quality-check",
      inputPath,
      framePath,
      atMs: atMs.value ?? 0,
      media,
      quality,
      baselinePath: comparisonBaselinePath,
      ...(preview ? { preview } : {}),
      visualDiff,
      error: {
        code: "visual_regression_failed",
        message: visualDiff.message
      }
    };
  }
  if (visualDiff?.ok) {
    const changedLimit = maxChangedPixels.value ?? 0;
    const meanLimit = maxMeanDiff.value ?? 0;
    if (visualDiff.changedPixels > changedLimit || visualDiff.meanAbsoluteError > meanLimit) {
      return {
        ok: false,
        command: "quality-check",
        inputPath,
        framePath,
        atMs: atMs.value ?? 0,
        media,
        quality,
        baselinePath: comparisonBaselinePath,
        ...(preview ? { preview } : {}),
        visualDiff,
        error: {
          code: "visual_regression_failed",
          message: `Visual regression failed: ${visualDiff.changedPixels} changed pixels (max ${changedLimit}), mean diff ${formatMetric(visualDiff.meanAbsoluteError)} (max ${formatMetric(meanLimit)}).`
        }
      };
    }
    if (minPsnrDb.value !== undefined && visualDiff.psnrDb !== null && visualDiff.psnrDb < minPsnrDb.value) {
      return {
        ok: false,
        command: "quality-check",
        inputPath,
        framePath,
        atMs: atMs.value ?? 0,
        media,
        quality,
        baselinePath: comparisonBaselinePath,
        ...(preview ? { preview } : {}),
        visualDiff,
        error: {
          code: "visual_regression_failed",
          message: `Visual regression failed: PSNR is ${formatMetric(visualDiff.psnrDb)} dB; expected at least ${formatMetric(minPsnrDb.value)} dB.`
        }
      };
    }
    if (minSsim.value !== undefined && visualDiff.ssim < minSsim.value) {
      return {
        ok: false,
        command: "quality-check",
        inputPath,
        framePath,
        atMs: atMs.value ?? 0,
        media,
        quality,
        baselinePath: comparisonBaselinePath,
        ...(preview ? { preview } : {}),
        visualDiff,
        error: {
          code: "visual_regression_failed",
          message: `Visual regression failed: SSIM is ${formatMetric(visualDiff.ssim)}; expected at least ${formatMetric(minSsim.value)}.`
        }
      };
    }
  }

  return {
    ok: true,
    command: "quality-check",
    inputPath,
    framePath,
    atMs: atMs.value ?? 0,
    media,
    ...(audioLevels ? { audioLevels } : {}),
    quality,
    ...(comparisonBaselinePath ? { baselinePath: comparisonBaselinePath } : {}),
    ...(preview ? { preview } : {}),
    ...(visualDiff ? { visualDiff } : {}),
    warnings: quality.blankFrames > 0 ? ["Extracted frame is blank or visually empty."] : []
  };
}

interface QualityPreviewBaseline {
  packageRoot: string;
  lane: "browser" | "native";
  atMs: number;
  framePath: string;
  receiptId: string;
}

async function renderQualityPreviewBaseline(input: {
  packageRoot: string;
  lane: "browser" | "native";
  atMs: number;
  framePath: string;
}): Promise<QualityPreviewBaseline> {
  await mkdir(dirname(input.framePath), { recursive: true, mode: 0o700 });
  if (input.lane === "browser") {
    const pkg = await loadMotionPackage(input.packageRoot);
    const result = await renderMotionBrowserFrame(pkg, {
      atMs: input.atMs,
      outDir: dirname(input.framePath),
      outputPath: input.framePath
    });
    return {
      packageRoot: input.packageRoot,
      lane: input.lane,
      atMs: input.atMs,
      framePath: result.output.path,
      receiptId: result.receipt.id
    };
  }

  const result = await renderNativePreviewFrame({
    packageRoot: input.packageRoot,
    outputPath: input.framePath,
    outputRoots: [dirname(input.framePath)],
    atMs: input.atMs
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  if (!result.frame.path) {
    throw new Error("Native preview did not produce a frame path.");
  }
  return {
    packageRoot: input.packageRoot,
    lane: input.lane,
    atMs: input.atMs,
    framePath: result.frame.path,
    receiptId: result.receipt.id
  };
}

interface QualityManifestSample {
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
  regions: QualityManifestRegion[];
}

interface QualityManifestDefinition {
  samples: QualityManifestSample[];
  audio?: QualityAudioPolicy;
}

interface QualityAudioPolicy extends AudioQualityThresholds {
  expectAudio: boolean;
}

type QualityAudioLevels = Awaited<ReturnType<typeof measureAudioLevels>>;

interface QualityManifestRegion {
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

type QualitySampleResult = CliResult & {
  id: string;
  atMs: number;
  compareAlpha?: boolean;
  framePath?: string;
  /** 0-based delivered-frame index compared for this sample (frame-accurate manifest path). */
  deliveryFrameIndex?: number;
  /** Path to the persisted diff heat-map image, written on visual-regression failure. */
  diffPath?: string;
  preview?: QualityPreviewBaseline;
  previousSampleId?: string;
  motionDiff?: Awaited<ReturnType<typeof comparePngFiles>>;
  warnings?: string[];
  error?: { code: string; message: string };
};

async function qualityCheckManifest(input: {
  inputPath: string;
  manifestPath: string;
  media: Awaited<ReturnType<typeof probeMedia>>;
  qualityRoot: string;
  runner: FfmpegRunner;
  previewPackageRoot?: string;
  previewLane?: "browser" | "native";
  sourceFramePath?: string;
  sourceFrameForSample?: (sample: QualityManifestSample) => { path: string; requiresAtMsZero?: boolean };
  /**
   * Directory of the pre-encode renderer frames (named by {@link frameFileName}) that fed the
   * encoder. When present, each representative-frame sample is compared against the exact source
   * frame the encoder consumed for its delivered instant — the "pre-encode renderer identity"
   * baseline — instead of a freshly re-rendered browser/native preview. This makes the comparison
   * deterministic and confines it to encode fidelity (see the manifest schema doc for the semantics).
   */
  sourceFramesDir?: string;
  defaultMinBrightPixels: number;
  defaultMinEdgePixels: number;
  defaultMinTransparentPixels: number;
  defaultMinNonTransparentPixels: number;
  defaultMaxChangedPixels: number;
  defaultMaxMeanDiff: number;
  defaultMinPsnrDb?: number;
  defaultMinSsim?: number;
  cliAudioLevels?: QualityAudioLevels;
}): Promise<CliResult> {
  let manifest: QualityManifestDefinition;
  try {
    manifest = readQualityManifest(
      JSON.parse(await readFile(input.manifestPath, "utf8")),
      dirname(input.manifestPath),
      {
        minBrightPixels: input.defaultMinBrightPixels,
        minEdgePixels: input.defaultMinEdgePixels,
        minTransparentPixels: input.defaultMinTransparentPixels,
        minNonTransparentPixels: input.defaultMinNonTransparentPixels,
        maxChangedPixels: input.defaultMaxChangedPixels,
        maxMeanDiff: input.defaultMaxMeanDiff,
        minPsnrDb: input.defaultMinPsnrDb,
        minSsim: input.defaultMinSsim
      }
    );
  } catch (error) {
    return {
      ok: false,
      command: "quality-check",
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      media: input.media,
      ...(input.cliAudioLevels ? { audioLevels: input.cliAudioLevels } : {}),
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }

  const audioCheck = manifest.audio
    ? await qualityCheckAudioPolicy({
        inputPath: input.inputPath,
        manifestPath: input.manifestPath,
        media: input.media,
        runner: input.runner,
        expectAudio: manifest.audio.expectAudio,
        maxPeakDb: manifest.audio.maxPeakDb,
        minPeakDb: manifest.audio.minPeakDb,
        minMeanDb: manifest.audio.minMeanDb,
        minIntegratedLoudnessLufs: manifest.audio.minIntegratedLoudnessLufs,
        maxIntegratedLoudnessLufs: manifest.audio.maxIntegratedLoudnessLufs,
        maxTruePeakDbtp: manifest.audio.maxTruePeakDbtp,
        maxLoudnessRangeLu: manifest.audio.maxLoudnessRangeLu
      })
    : { ok: true as const, audioLevels: undefined };
  if (!audioCheck.ok) return audioCheck.result;
  const audioLevels = audioCheck.audioLevels ?? input.cliAudioLevels;

  const sampleResults: QualitySampleResult[] = [];
  const mediaName = basename(input.inputPath).replace(/\.[^.]+$/, "") || "media";
  for (const sample of manifest.samples) {
    let baselinePath = sample.baselinePath;
    let preview: QualityPreviewBaseline | undefined;
    // Pre-encode renderer identity: resolve the delivered-frame index for this sample from the
    // DELIVERED media's own timeline, then pin both the extracted frame and the baseline to that
    // index. Because the encoder preserves frame order 1:1, delivered frame N always decodes source
    // frame N, so the two sides are the same rendered frame regardless of the exact frame rate.
    let deliveryFrameIndex: number | undefined;
    if (input.sourceFramesDir && input.media.fps > 0 && input.media.durationMs > 0) {
      deliveryFrameIndex = sequenceFrameIndexForAtMs(sample.atMs, input.media.durationMs, input.media.fps);
      if (!baselinePath) {
        baselinePath = join(input.sourceFramesDir, frameFileName(deliveryFrameIndex));
      }
    }
    if (!baselinePath && input.previewPackageRoot) {
      try {
        preview = await renderQualityPreviewBaseline({
          packageRoot: input.previewPackageRoot,
          lane: input.previewLane ?? "browser",
          atMs: sample.atMs,
          framePath: join(input.qualityRoot, `${mediaName}-${safeFileToken(sample.id)}-preview.png`)
        });
        baselinePath = preview.framePath;
      } catch (error) {
        const failedPreview: QualitySampleResult = {
          ok: false,
          id: sample.id,
          atMs: sample.atMs,
          error: {
            code: "preview_render_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        };
        sampleResults.push(failedPreview);
        return {
          ok: false,
          command: "quality-check",
          inputPath: input.inputPath,
          manifestPath: input.manifestPath,
          media: input.media,
          ...(audioLevels ? { audioLevels } : {}),
          samples: sampleResults,
          error: {
            code: "preview_render_failed",
            message: `Quality manifest sample ${sample.id} failed: ${failedPreview.error?.message ?? "preview render failed"}`
          }
        };
      }
    }

    const resolvedSourceFrame = input.sourceFrameForSample?.(sample);
    let result = await qualityCheckSample({
      inputPath: input.inputPath,
      media: input.media,
      runner: input.runner,
      id: sample.id,
      atMs: sample.atMs,
      framePath: join(input.qualityRoot, `${mediaName}-${safeFileToken(sample.id)}-frame.png`),
      sourceFramePath: resolvedSourceFrame?.path ?? input.sourceFramePath,
      sourceFrameRequiresAtMsZero: resolvedSourceFrame
        ? resolvedSourceFrame.requiresAtMsZero ?? false
        : Boolean(input.sourceFramePath),
      ...(deliveryFrameIndex !== undefined ? { deliveryFrameIndex } : {}),
      minBrightPixels: sample.minBrightPixels,
      minEdgePixels: sample.minEdgePixels,
      minLumaRange: sample.minLumaRange,
      minChromaPixels: sample.minChromaPixels,
      minTransparentPixels: sample.minTransparentPixels,
      minNonTransparentPixels: sample.minNonTransparentPixels,
      baselinePath,
      preview,
      maxChangedPixels: sample.maxChangedPixels,
      maxMeanDiff: sample.maxMeanDiff,
      minPsnrDb: sample.minPsnrDb,
      minSsim: sample.minSsim,
      compareAlpha: sample.compareAlpha,
      regions: sample.regions
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
      return {
        ok: false,
        command: "quality-check",
        inputPath: input.inputPath,
        manifestPath: input.manifestPath,
        media: input.media,
        ...(audioLevels ? { audioLevels } : {}),
        samples: sampleResults,
        error: {
          code: result.error?.code ?? "visual_quality_failed",
          message: `Quality manifest sample ${result.id} failed: ${result.error?.message ?? "unknown failure"}`
        }
      };
    }
  }

  return {
    ok: true,
    command: "quality-check",
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    media: input.media,
    ...(audioLevels ? { audioLevels } : {}),
    samples: sampleResults,
    warnings: sampleResults.flatMap((sample) => sample.warnings ?? [])
  };
}

async function qualityCheckPngStillFrameManifest(input: {
  inputPath: string;
  manifestPath: string;
  qualityRoot: string;
  runner: FfmpegRunner;
  previewPackageRoot?: string;
  previewLane?: "browser" | "native";
}): Promise<CliResult> {
  const inspected = await inspectPngFile(input.inputPath);
  if (!inspected.ok) {
    return {
      ok: false,
      command: "quality-check",
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      error: {
        code: "visual_quality_failed",
        message: inspected.message
      }
    };
  }
  return qualityCheckManifest({
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    media: pngStillFrameMedia(input.inputPath, inspected),
    qualityRoot: input.qualityRoot,
    runner: input.runner,
    previewPackageRoot: input.previewPackageRoot,
    previewLane: input.previewLane,
    sourceFramePath: input.inputPath,
    defaultMinBrightPixels: 0,
    defaultMinEdgePixels: 0,
    defaultMinTransparentPixels: 0,
    defaultMinNonTransparentPixels: 0,
    defaultMaxChangedPixels: 0,
    defaultMaxMeanDiff: 0
  });
}

function pngStillFrameMedia(path: string, png: { width: number; height: number }): Awaited<ReturnType<typeof probeMedia>> {
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

async function qualityCheckPngSequenceManifest(input: {
  inputPath: string;
  manifestPath: string;
  qualityRoot: string;
  runner: FfmpegRunner;
  durationMs: number;
  fps: number;
  previewPackageRoot?: string;
  previewLane?: "browser" | "native";
}): Promise<CliResult> {
  const firstFramePath = join(input.inputPath, frameFileName(0));
  const inspected = await inspectPngFile(firstFramePath);
  if (!inspected.ok) {
    return {
      ok: false,
      command: "quality-check",
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      error: {
        code: "visual_quality_failed",
        message: inspected.message
      }
    };
  }
  return qualityCheckManifest({
    inputPath: input.inputPath,
    manifestPath: input.manifestPath,
    media: pngSequenceMedia(input.inputPath, inspected, { durationMs: input.durationMs, fps: input.fps }),
    qualityRoot: input.qualityRoot,
    runner: input.runner,
    previewPackageRoot: input.previewPackageRoot,
    previewLane: input.previewLane,
    sourceFrameForSample: (sample) => ({
      path: join(input.inputPath, frameFileName(sequenceFrameIndexForAtMs(sample.atMs, input.durationMs, input.fps)))
    }),
    defaultMinBrightPixels: 0,
    defaultMinEdgePixels: 0,
    defaultMinTransparentPixels: 0,
    defaultMinNonTransparentPixels: 0,
    defaultMaxChangedPixels: 0,
    defaultMaxMeanDiff: 0
  });
}

function pngSequenceMedia(path: string, png: { width: number; height: number }, input: { durationMs: number; fps: number }): Awaited<ReturnType<typeof probeMedia>> {
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

async function qualityCheckSample(input: {
  inputPath: string;
  media: Awaited<ReturnType<typeof probeMedia>>;
  runner: FfmpegRunner;
  id: string;
  atMs: number;
  framePath: string;
  sourceFramePath?: string;
  sourceFrameRequiresAtMsZero?: boolean;
  /**
   * 0-based delivered-frame index to extract for this sample. When set, the frame is selected by
   * index (frame-accurate) and colour-normalized to full range, so it aligns with an index-keyed
   * pre-encode baseline. When undefined, the legacy wall-clock `-ss` seek is used.
   */
  deliveryFrameIndex?: number;
  minBrightPixels: number;
  minEdgePixels: number;
  minLumaRange: number;
  minChromaPixels: number;
  minTransparentPixels: number;
  minNonTransparentPixels: number;
  baselinePath?: string;
  preview?: QualityPreviewBaseline;
  maxChangedPixels: number;
  maxMeanDiff: number;
  minPsnrDb?: number;
  minSsim?: number;
  compareAlpha: boolean;
  regions: QualityManifestRegion[];
}): Promise<QualitySampleResult> {
  const framePath = input.sourceFramePath ?? input.framePath;
  if (input.sourceFramePath && input.sourceFrameRequiresAtMsZero && input.atMs !== 0) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "invalid_args",
        message: "Still-frame image quality manifest samples must use atMs 0."
      }
    };
  }
  if (!input.sourceFramePath) {
    await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
    // Frame-accurate + colour-normalized extraction when a delivered-frame index is known (the
    // representative-frame manifest path); otherwise fall back to the wall-clock seek used by the
    // standalone single-frame quality-check.
    const extractArgs = input.deliveryFrameIndex !== undefined
      ? ["-y", ...frameExtractionArgs(input.media, input.inputPath, framePath, { frameIndex: input.deliveryFrameIndex, admittedQualityInput: true })]
      : ["-y", ...(input.atMs > 0 ? ["-ss", formatSeconds(input.atMs / 1000)] : []),
        ...frameExtractionInputArgs(input.media, input.inputPath, { admittedQualityInput: true }), ...frameExtractionPngOutputArgs(input.media, framePath)];
    const extractCommand: FfmpegCommand = {
      executable: resolveFfmpegExecutable(),
      args: extractArgs,
      shell: false
    };
    const extracted = await input.runner(extractCommand);
    if (extracted.exitCode !== 0) {
      return {
        ok: false,
        id: input.id,
        atMs: input.atMs,
        framePath,
        ffmpeg: extractCommand,
        ...(input.preview ? { preview: input.preview } : {}),
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
      id: input.id,
      atMs: input.atMs,
      framePath,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: inspected.message
      }
    };
  }

  const quality = summarizeFrameQuality([inspected]);
  if (quality.minBrightPixels < input.minBrightPixels) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minBrightPixels} bright pixels; expected at least ${input.minBrightPixels}.`
      }
    };
  }
  if (quality.minEdgePixels < input.minEdgePixels) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minEdgePixels} edge pixels; expected at least ${input.minEdgePixels}.`
      }
    };
  }
  if (quality.minLumaRange < input.minLumaRange) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has luma range ${quality.minLumaRange}; expected at least ${input.minLumaRange}.`
      }
    };
  }
  if (quality.minChromaPixels < input.minChromaPixels) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minChromaPixels} chroma-rich pixels; expected at least ${input.minChromaPixels}.`
      }
    };
  }
  if (quality.minTransparentPixels < input.minTransparentPixels) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minTransparentPixels} transparent pixels; expected at least ${input.minTransparentPixels}.`
      }
    };
  }
  if (quality.minNonTransparentPixels < input.minNonTransparentPixels) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "visual_quality_failed",
        message: `Extracted frame has ${quality.minNonTransparentPixels} non-transparent pixels; expected at least ${input.minNonTransparentPixels}.`
      }
    };
  }

  const regionResults = await inspectQualityRegions(framePath, input.regions);
  const failedRegion = regionResults.find((region) => !region.ok);
  if (failedRegion) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      regions: regionResults,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: failedRegion.error?.code ?? "visual_quality_failed",
        message: failedRegion.error?.message ?? `Region ${failedRegion.id} failed visual quality checks.`
      }
    };
  }

  const sampleEvidence = input.compareAlpha === false ? { compareAlpha: false } : {};
  if (!input.baselinePath && (input.minPsnrDb !== undefined || input.minSsim !== undefined)) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      ...sampleEvidence,
      ...(input.preview ? { preview: input.preview } : {}),
      error: {
        code: "invalid_args",
        message: "minPsnrDb and minSsim require a baseline or preview reference."
      }
    };
  }
  const visualDiff = input.baselinePath ? await comparePngFiles(framePath, input.baselinePath, { compareAlpha: input.compareAlpha }) : undefined;
  // Best-effort diff heat-map, written only when a comparison is about to fail. Memoized so the
  // encode-and-write cost is paid at most once per sample, and never on the passing path.
  const sampleDiffPath = `${framePath.replace(/\.[^.]+$/, "")}-diff.png`;
  let diffAttempted = false;
  let diffPath: string | undefined;
  const emitVisualDiff = async (): Promise<string | undefined> => {
    if (diffAttempted) return diffPath;
    diffAttempted = true;
    if (!input.baselinePath) return undefined;
    try {
      const [actualPng, baselinePng] = await Promise.all([readFile(framePath), readFile(input.baselinePath)]);
      const diff = buildVisualDiffPng(actualPng, baselinePng);
      if (diff.ok) {
        await writeFile(sampleDiffPath, diff.png);
        diffPath = sampleDiffPath;
      }
    } catch {
      // A missing/broken diff image must never mask the underlying metric failure it documents.
    }
    return diffPath;
  };
  const deliveryFrameEvidence = input.deliveryFrameIndex !== undefined
    ? { deliveryFrameIndex: input.deliveryFrameIndex }
    : {};
  if (visualDiff && !visualDiff.ok) {
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      baselinePath: input.baselinePath,
      ...deliveryFrameEvidence,
      ...sampleEvidence,
      ...(input.preview ? { preview: input.preview } : {}),
      visualDiff,
      error: {
        code: "visual_regression_failed",
        message: visualDiff.message
      }
    };
  }
  if (visualDiff?.ok && (visualDiff.changedPixels > input.maxChangedPixels || visualDiff.meanAbsoluteError > input.maxMeanDiff)) {
    const emittedDiffPath = await emitVisualDiff();
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      baselinePath: input.baselinePath,
      ...deliveryFrameEvidence,
      ...(emittedDiffPath ? { diffPath: emittedDiffPath } : {}),
      ...sampleEvidence,
      ...(input.preview ? { preview: input.preview } : {}),
      visualDiff,
      error: {
        code: "visual_regression_failed",
        message: `Visual regression failed: ${visualDiff.changedPixels} changed pixels (max ${input.maxChangedPixels}), mean diff ${formatMetric(visualDiff.meanAbsoluteError)} (max ${formatMetric(input.maxMeanDiff)}).`
      }
    };
  }
  if (visualDiff?.ok && input.minPsnrDb !== undefined && visualDiff.psnrDb !== null && visualDiff.psnrDb < input.minPsnrDb) {
    const emittedDiffPath = await emitVisualDiff();
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      baselinePath: input.baselinePath,
      ...deliveryFrameEvidence,
      ...(emittedDiffPath ? { diffPath: emittedDiffPath } : {}),
      ...sampleEvidence,
      ...(input.preview ? { preview: input.preview } : {}),
      visualDiff,
      error: {
        code: "visual_regression_failed",
        message: `Visual regression failed: PSNR is ${formatMetric(visualDiff.psnrDb)} dB; expected at least ${formatMetric(input.minPsnrDb)} dB.`
      }
    };
  }
  if (visualDiff?.ok && input.minSsim !== undefined && visualDiff.ssim < input.minSsim) {
    const emittedDiffPath = await emitVisualDiff();
    return {
      ok: false,
      id: input.id,
      atMs: input.atMs,
      framePath,
      quality,
      baselinePath: input.baselinePath,
      ...deliveryFrameEvidence,
      ...(emittedDiffPath ? { diffPath: emittedDiffPath } : {}),
      ...sampleEvidence,
      ...(input.preview ? { preview: input.preview } : {}),
      visualDiff,
      error: {
        code: "visual_regression_failed",
        message: `Visual regression failed: SSIM is ${formatMetric(visualDiff.ssim)}; expected at least ${formatMetric(input.minSsim)}.`
      }
    };
  }

  return {
    ok: true,
    id: input.id,
    atMs: input.atMs,
    framePath,
    quality,
    ...(regionResults.length > 0 ? { regions: regionResults } : {}),
    ...(input.baselinePath ? { baselinePath: input.baselinePath } : {}),
    ...deliveryFrameEvidence,
    ...sampleEvidence,
    ...(input.preview ? { preview: input.preview } : {}),
    ...(visualDiff ? { visualDiff } : {}),
    warnings: quality.blankFrames > 0 ? ["Extracted frame is blank or visually empty."] : []
  };
}

/**
 * Parse a `shellx-motion/quality-manifest@1` document.
 *
 * Visual-regression baseline semantics (see docs/public/TEMPLATE_QUALITY_BAR.md): for a video render the
 * per-sample `maxMeanDiff`/`minPsnrDb`/`minSsim` gate is measured as PRE-ENCODE RENDERER IDENTITY —
 * the delivered frame is extracted frame-accurately by index and compared to the exact source frame
 * the encoder consumed, in a shared full-range BT.709 colour domain. Thresholds are calibrated from
 * clean golden runs (worst-case encode loss ~41.5 dB PSNR / 0.978 SSIM / 1.39 MAE) with margin, not
 * widened to pass; a one-frame content shift still fails.
 */
function readQualityManifest(
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
): QualityManifestDefinition {
  const record = readRecord(value);
  if (!record) throw new Error("Quality manifest must be an object.");
  if (record.schema !== "shellx-motion/quality-manifest@1") {
    throw new Error("Quality manifest schema must be shellx-motion/quality-manifest@1.");
  }
  if (!Array.isArray(record.samples) || record.samples.length === 0) {
    throw new Error("Quality manifest samples must be a non-empty array.");
  }

  return {
    audio: readQualityManifestAudio(record.audio),
    samples: record.samples.map((sample, index) => {
      const sampleRecord = readRecord(sample);
      if (!sampleRecord) throw new Error(`Quality manifest sample ${index + 1} must be an object.`);
      const id = typeof sampleRecord.id === "string" && sampleRecord.id.trim()
        ? sampleRecord.id.trim()
        : `sample_${index + 1}`;
      const minChangedPixelsFromPrevious = readNonNegativeNumber(sampleRecord.minChangedPixelsFromPrevious, `samples/${index}/minChangedPixelsFromPrevious`, 0);
      const minMeanDiffFromPrevious = readNonNegativeNumber(sampleRecord.minMeanDiffFromPrevious, `samples/${index}/minMeanDiffFromPrevious`, 0);
      if (index === 0 && (minChangedPixelsFromPrevious > 0 || minMeanDiffFromPrevious > 0)) {
        throw new Error("Quality manifest first sample cannot require motion from a previous sample.");
      }
      return {
        id,
        atMs: readNonNegativeNumber(sampleRecord.atMs, `samples/${index}/atMs`, 0),
        baselinePath: typeof sampleRecord.baseline === "string" && sampleRecord.baseline.trim()
          ? resolve(manifestDir, sampleRecord.baseline.trim())
          : undefined,
        minBrightPixels: readNonNegativeNumber(sampleRecord.minBrightPixels, `samples/${index}/minBrightPixels`, defaults.minBrightPixels),
        minEdgePixels: readNonNegativeNumber(sampleRecord.minEdgePixels, `samples/${index}/minEdgePixels`, defaults.minEdgePixels),
        minLumaRange: readNonNegativeNumber(sampleRecord.minLumaRange, `samples/${index}/minLumaRange`, 0),
        minChromaPixels: readNonNegativeNumber(sampleRecord.minChromaPixels, `samples/${index}/minChromaPixels`, 0),
        minTransparentPixels: readNonNegativeNumber(sampleRecord.minTransparentPixels, `samples/${index}/minTransparentPixels`, defaults.minTransparentPixels),
        minNonTransparentPixels: readNonNegativeNumber(sampleRecord.minNonTransparentPixels, `samples/${index}/minNonTransparentPixels`, defaults.minNonTransparentPixels),
        maxChangedPixels: readNonNegativeNumber(sampleRecord.maxChangedPixels, `samples/${index}/maxChangedPixels`, defaults.maxChangedPixels),
        maxMeanDiff: readNonNegativeNumber(sampleRecord.maxMeanDiff, `samples/${index}/maxMeanDiff`, defaults.maxMeanDiff),
        minPsnrDb: readOptionalNonNegativeNumber(sampleRecord.minPsnrDb, `samples/${index}/minPsnrDb`, defaults.minPsnrDb),
        minSsim: readOptionalUnitIntervalNumber(sampleRecord.minSsim, `samples/${index}/minSsim`, defaults.minSsim),
        minChangedPixelsFromPrevious,
        minMeanDiffFromPrevious,
        compareAlpha: readOptionalBoolean(sampleRecord.compareAlpha, `samples/${index}/compareAlpha`, true),
        regions: readQualityManifestRegions(sampleRecord.regions, index)
      };
    })
  };
}

function readQualityManifestAudio(value: unknown): QualityAudioPolicy | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value);
  if (!record) throw new Error("audio must be an object.");
  const maxPeakDb = readOptionalFiniteNumber(record.maxPeakDb, "audio/maxPeakDb");
  const minPeakDb = readOptionalFiniteNumber(record.minPeakDb, "audio/minPeakDb");
  const minMeanDb = readOptionalFiniteNumber(record.minMeanDb, "audio/minMeanDb");
  const minIntegratedLoudnessLufs = readOptionalFiniteNumber(record.minIntegratedLoudnessLufs, "audio/minIntegratedLoudnessLufs");
  const maxIntegratedLoudnessLufs = readOptionalFiniteNumber(record.maxIntegratedLoudnessLufs, "audio/maxIntegratedLoudnessLufs");
  const maxTruePeakDbtp = readOptionalFiniteNumber(record.maxTruePeakDbtp, "audio/maxTruePeakDbtp");
  const maxLoudnessRangeLu = readOptionalNonNegativeNumber(record.maxLoudnessRangeLu, "audio/maxLoudnessRangeLu");
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
  const expectAudio = readOptionalBoolean(
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

async function qualityCheckAudioPolicy(input: {
  inputPath: string;
  manifestPath?: string;
  media: Awaited<ReturnType<typeof probeMedia>>;
  runner: FfmpegRunner;
  expectAudio: boolean;
  maxPeakDb?: number;
  minPeakDb?: number;
  minMeanDb?: number;
  minIntegratedLoudnessLufs?: number;
  maxIntegratedLoudnessLufs?: number;
  maxTruePeakDbtp?: number;
  maxLoudnessRangeLu?: number;
}): Promise<{ ok: true; audioLevels?: Awaited<ReturnType<typeof measureAudioLevels>> } | { ok: false; result: CliResult }> {
  if (input.expectAudio && !input.media.audio.present) {
    return audioPolicyFailure(input, "audio_quality_failed", "Expected at least one audio stream, but media has none.");
  }

  const policy = pickAudioQualityThresholds(input);
  if (!audioQualityMeasurementRequired(policy)) return { ok: true };

  if (!input.media.audio.present) {
    return audioPolicyFailure(input, "audio_quality_failed", "Expected at least one audio stream for audio peak check, but media has none.");
  }

  let audioLevels: Awaited<ReturnType<typeof measureAudioLevels>>;
  try {
    audioLevels = await measureAudioLevels(input.inputPath, { runner: input.runner, inputRoots: [dirname(input.inputPath)], admittedQualityInput: true });
  } catch (error) {
    return audioPolicyFailure(input, "ffmpeg_failed", error instanceof Error ? error.message : String(error));
  }

  const evaluation = evaluateAudioQuality(audioLevels, policy);
  if (!evaluation.ok) return audioPolicyFailure(input, "audio_quality_failed", evaluation.message, audioLevels);

  return { ok: true, audioLevels };
}

function pickAudioQualityThresholds(input: AudioQualityThresholds): AudioQualityThresholds {
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

function audioPolicyFailure(
  input: { inputPath: string; manifestPath?: string; media: Awaited<ReturnType<typeof probeMedia>> },
  code: string,
  message: string,
  audioLevels?: Awaited<ReturnType<typeof measureAudioLevels>>
): { ok: false; result: CliResult } {
  return {
    ok: false,
    result: {
      ok: false,
      command: "quality-check",
      inputPath: input.inputPath,
      ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
      media: input.media,
      ...(audioLevels ? { audioLevels } : {}),
      error: { code, message }
    }
  };
}

function invalidQualityArgs(message: string): CliResult {
  return {
    ok: false,
    command: "quality-check",
    error: { code: "invalid_args", message }
  };
}

type QualityRegionResult = CliResult & {
  id: string;
  region: { x: number; y: number; width: number; height: number };
  quality?: ReturnType<typeof summarizeFrameQuality>;
  error?: { code: string; message: string };
};

async function inspectQualityRegions(framePath: string, regions: QualityManifestRegion[]): Promise<QualityRegionResult[]> {
  const results: QualityRegionResult[] = [];
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

function readQualityManifestRegions(value: unknown, sampleIndex: number): QualityManifestRegion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`samples/${sampleIndex}/regions must be an array.`);
  return value.map((region, regionIndex) => {
    const record = readRecord(region);
    if (!record) throw new Error(`samples/${sampleIndex}/regions/${regionIndex} must be an object.`);
    const id = typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `region_${regionIndex + 1}`;
    return {
      id,
      x: readNonNegativeInteger(record.x, `samples/${sampleIndex}/regions/${regionIndex}/x`),
      y: readNonNegativeInteger(record.y, `samples/${sampleIndex}/regions/${regionIndex}/y`),
      width: readPositiveInteger(record.width, `samples/${sampleIndex}/regions/${regionIndex}/width`),
      height: readPositiveInteger(record.height, `samples/${sampleIndex}/regions/${regionIndex}/height`),
      minDarkPixels: readNonNegativeNumber(record.minDarkPixels, `samples/${sampleIndex}/regions/${regionIndex}/minDarkPixels`, 0),
      minBrightPixels: readNonNegativeNumber(record.minBrightPixels, `samples/${sampleIndex}/regions/${regionIndex}/minBrightPixels`, 0),
      minEdgePixels: readNonNegativeNumber(record.minEdgePixels, `samples/${sampleIndex}/regions/${regionIndex}/minEdgePixels`, 0),
      minTransparentPixels: readNonNegativeNumber(record.minTransparentPixels, `samples/${sampleIndex}/regions/${regionIndex}/minTransparentPixels`, 0),
      minNonTransparentPixels: readNonNegativeNumber(record.minNonTransparentPixels, `samples/${sampleIndex}/regions/${regionIndex}/minNonTransparentPixels`, 0)
    };
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function readCliResult(value: unknown): CliResult | undefined {
  const result = readRecord(value);
  return result && typeof result.ok === "boolean" ? result as CliResult : undefined;
}

function readNonNegativeNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number.`);
  }
  return value;
}

function readOptionalNonNegativeNumber(value: unknown, path: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number.`);
  }
  return value;
}

function readOptionalUnitIntervalNumber(value: unknown, path: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${path} must be a finite number between 0 and 1.`);
  }
  return value;
}

function readOptionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "sample";
}

async function renderBatchCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("render-batch", "package root");
  const outDirArg = optionValue(argv, "--out");
  if (!outDirArg) return missingArgument("render-batch", "--out");

  const packageRoot = resolveInputPath(root);
  const outDir = resolveOutputPath(outDirArg);
  const dryRun = argv.includes("--dry-run");
  const resume = argv.includes("--resume");
  const frameLaneValue = optionValue(argv, "--frame-lane") ?? "browser", frameLane = readBatchFrameLane(frameLaneValue);
  if (!frameLane) return { ok: false, command: "render-batch", error: { code: "unsupported_frame_lane", message: unsupportedFrameLaneMessage(frameLaneValue) } };
  const rowsRef = optionValue(argv, "--rows");
  const qualityManifestRef = optionValue(argv, "--quality-manifest");
  const qualityManifestPath = qualityManifestRef ? resolveInputPath(qualityManifestRef) : undefined;
  const workflowRef = optionValue(argv, "--workflow");
  const workflowPath = workflowRef ? resolveInputPath(workflowRef) : undefined;
  const requestedRowIds = batchRowIdOptions(argv);
  const presetArg = optionValue(argv, "--preset");
  const presetValue = presetArg ?? "mp4-h264";
  const preset = readMotionExportPreset(presetValue);
  if (!preset) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "unsupported_preset",
        message: `Unsupported export preset: ${presetValue}.`
      }
    };
  }
  if (qualityManifestPath && !supportsBatchQualityManifestPreset(preset)) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "unsupported_quality_manifest",
        message: "Batch quality manifest checks currently require a video, GIF, png-frame, or png-sequence export preset."
      }
    };
  }
  const minUniqueFrameHashes = optionValue(argv, "--min-unique-frames");
  const quality = minUniqueFrameHashes === undefined
    ? undefined
    : readMinUniqueFrameHashes(minUniqueFrameHashes);
  if (quality === null) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "invalid_args",
        message: "--min-unique-frames must be a positive integer."
      }
    };
  }
  const workflowIdempotencyHash = workflowPath ? await batchWorkflowIdempotencyHash(workflowPath) : undefined;
  const pkg = await loadMotionPackage(packageRoot);
  const allRows = rowsRef
    ? await loadDataRowsFile(resolveInputPath(rowsRef), { withinRoot: dirname(resolveInputPath(rowsRef)) })
    : await loadPackageDataRows(pkg);
  const rowFilter = filterMotionDataRows(allRows, requestedRowIds);
  if (!rowFilter.ok) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "invalid_args",
        message: rowFilter.message,
        detail: {
          requestedRowIds: rowFilter.requestedRowIds,
          missingRowIds: rowFilter.missingRowIds
        }
      }
    };
  }
  const rows = rowFilter.rows;
  const expanded = expandMotionPackageRows(pkg, rows);
  const activeJob = expanded.find((job) => activeScriptLayers(job.motion).length > 0); if (activeJob) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "script_provenance_unresolved",
        message: `render-batch refuses active-content row ${activeJob.row.id} before package copy; provenance does not transfer to a copied package.`
      }
    };
  }
  const presetPlan = planBatchRenderPresets(expanded, preset, Boolean(presetArg));
  if (!presetPlan.ok) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "unsupported_preset",
        message: `Unsupported export preset for row ${presetPlan.rowId}: ${presetPlan.preset}.`
      }
    };
  }
  const presetSummary = batchPresetSummary(preset, presetPlan.uniquePresets);
  const gpuRefusal = gpuBatchPreflightRefusal({ frameLane, resume, workflowPath, presets: presetPlan.presets, quality });
  if (gpuRefusal) return { ok: false, command: "render-batch", frameLane, error: { code: frameLane === "gpu" && resume ? "invalid_args" : "unsupported_frame_lane", message: gpuRefusal } };
  if (qualityManifestPath) {
    const unsupportedQualityPreset = presetPlan.presets.find((candidate) => !supportsBatchQualityManifestPreset(candidate));
    if (unsupportedQualityPreset) {
      return {
        ok: false,
        command: "render-batch",
        error: {
          code: "unsupported_quality_manifest",
          message: `Batch quality manifest checks for preset ${unsupportedQualityPreset} currently require a video, GIF, png-frame, or png-sequence export preset.`
        }
      };
    }
  }
  const admittedOutput = await admitCliBatchOutput(outDir, resume);
  if (!admittedOutput.ok) {
    return {
      ok: false,
      command: "render-batch",
      error: {
        code: "invalid_args",
        message: admittedOutput.message
      }
    };
  }
  const { batchOutput, packagesRoot, renderRoot, receiptsRoot, previousBatchJobs } = admittedOutput;

  const jobs: Array<Record<string, unknown>> = [];
  try {
    for (let index = 0; index < expanded.length; index += 1) {
      if (index > 0) await options.batchTestHooks?.beforeNextRow?.();
      await batchOutput.assertCurrent();
      const job = expanded[index];
      const jobPreset = presetPlan.presets[index];
      const packageDir = join(packagesRoot, job.manifest.id);
      const outputPath = batchRenderOutputPath(renderRoot, job.manifest.id, jobPreset);
      const qualitySnapshot = qualityManifestPath ? await prepareBatchQualityManifestSnapshot({
        sourcePath: qualityManifestPath,
        context: { values: job.row.values, rowId: job.row.id, rowIndex: job.row.index, rowHash: job.row.hash, rowKey: job.row.key, packageId: job.manifest.id, packageDir, outputPath }
      }) : undefined;
      const qualityInputs = qualitySnapshot ? batchQualityInputEvidence(qualitySnapshot) : undefined;
      const frameTransport = frameLane === "gpu" ? gpuBatchFrameTransport(quality) : undefined;
      const idempotencyKey = batchJobIdempotencyKey({ packageId: job.manifest.id, rowId: job.row.id, rowHash: job.row.hash, manifest: job.manifest, motion: job.motion, preset: jobPreset, quality, qualityInputs, frameLane, workflowIdempotencyHash });
      const packageAssetInputHashes = await writeExpandedPackage(job, pkg, packageDir);
      await batchOutput.assertCurrent();
      const audioPresetWarnings = audioWarningsForMotionExportPreset(jobPreset, audioInputCountForMotion(job.motion));
      const planReceiptPath = await writeBatchRowPlanReceipt({
        receiptsRoot, dryRun, packageId: job.manifest.id, row: job.row, manifest: job.manifest, motion: job.motion,
        packageDir, outputPath, preset: jobPreset,
        status: "not_run",
        idempotencyKey,
        quality,
        qualityManifestPath,
        qualityInputs, frameLane, frameTransport,
        packageAssetInputHashes,
        warnings: audioPresetWarnings
      });
      await batchOutput.assertCurrent();
      if (dryRun) {
        jobs.push({
          rowId: job.row.id,
          rowHash: job.row.hash,
          rowKey: job.row.key,
          idempotencyKey,
          packageId: job.manifest.id,
          packageDir,
          outputPath,
          preset: jobPreset, frameLane, ...(frameTransport ? { frameTransport } : {}),
          status: "not_run",
          planReceiptPath,
          receiptPath: planReceiptPath,
          ...(quality ? { quality } : {}),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          ...(qualityInputs ? { qualityInputs } : {}),
          ...(audioPresetWarnings.length > 0 ? { warnings: audioPresetWarnings } : {})
        });
        continue;
      }

      const resumeMatch = resume ? readBatchResumeMatch(previousBatchJobs, idempotencyKey, outputPath) : null;
      if (resumeMatch) {
        const sourceReceiptPath = batchResumeSourceReceiptPath(resumeMatch);
        jobs.push({
          rowId: job.row.id,
          rowHash: job.row.hash,
          rowKey: job.row.key,
          idempotencyKey,
          packageId: job.manifest.id,
          packageDir,
          outputPath,
          preset: jobPreset, frameLane, ...(frameTransport ? { frameTransport } : {}),
          status: "skipped",
          planReceiptPath,
          receiptPath: sourceReceiptPath,
          resume: { matched: true, sourceReceiptPath },
          ...(quality ? { quality } : {}),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          ...(qualityInputs ? { qualityInputs } : {}),
          ...(audioPresetWarnings.length > 0 ? { warnings: audioPresetWarnings } : {})
        });
        continue;
      }

      const materializedQualityManifest = qualitySnapshot ? await publishBatchQualityManifestSnapshot({ snapshot: qualitySnapshot, targetRoot: join(receiptsRoot, "quality-manifests", `${job.manifest.id}-${qualitySnapshot.closureSha256.slice(0, 24)}`) }) : undefined;
      const qualityManifestForCheckPath = materializedQualityManifest?.path;
      const qualityManifestAppliedPath = materializedQualityManifest?.appliedPath;
      const renderArgs = [packageDir, "--lane", "ffmpeg", "--frame-lane", frameLane, "--out", outputPath, "--preset", jobPreset, "--force"];
      if (quality) renderArgs.push("--min-unique-frames", String(quality.minUniqueFrameHashes));
      if (qualityManifestForCheckPath) renderArgs.push("--quality-manifest", qualityManifestForCheckPath);
      if (workflowPath) renderArgs.push("--workflow", workflowPath);
      const renderResult = await renderCommand(renderArgs, { ...options, ...(materializedQualityManifest && qualityInputs ? { retainedBatchQualityManifest: { published: materializedQualityManifest, evidence: qualityInputs } } : {}) });
      const uncertainDelivery = readRenderCommitUncertainDelivery(renderResult);
      const childDelivery = readRenderBatchChildDelivery(renderResult);
      const qualityCheck = readCliResult(renderResult.qualityCheck);
      const warnings = resultWarnings(renderResult);
      const receiptPath = join(receiptsRoot, `${job.manifest.id}.render.receipt.json`);
      const qualityOk = qualityCheck ? qualityCheck.ok : true;
      const rowWarnings = dedupeWarnings([
        ...warnings,
        ...renderCommitUncertainWarnings(uncertainDelivery),
        ...(childDelivery?.kind === "evidence_uncertain" ? ["Render receipt or secondary evidence may have committed; inspect the reported public evidence before retrying."] : []),
        ...(qualityCheck ? resultWarnings(qualityCheck) : [])
      ]);
      const rowStatus = escalateReceiptStatusForWarnings(
        childDelivery?.kind === "primary_uncertain" || childDelivery?.kind === "evidence_uncertain" ? "warning" : renderResult.ok && qualityOk ? "passed" : "failed",
        rowWarnings
      );
      // Record the child *before* the first post-render assertion or write.  The renderer may have
      // already committed its public pair, and batch bookkeeping must never erase that fact.
      jobs.push({
        rowId: job.row.id,
        rowHash: job.row.hash,
        rowKey: job.row.key,
        idempotencyKey,
        packageId: job.manifest.id,
        packageDir,
        outputPath,
        preset: jobPreset, frameLane, ...(frameTransport ? { frameTransport } : {}),
        status: rowStatus,
        planReceiptPath,
        receiptPath,
        ...renderBatchChildDeliveryJobFields(childDelivery),
        ...(quality ? { quality } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        ...(qualityInputs ? { qualityInputs } : {}),
        ...(qualityManifestAppliedPath ? { qualityManifestAppliedPath } : {}),
        ...(qualityCheck ? { qualityCheck } : {}),
        ...(rowWarnings.length > 0 ? { warnings: rowWarnings } : {}),
        render: renderResult
      });
      await options.batchTestHooks?.beforePostRenderAssert?.();
      await batchOutput.assertCurrent();
      await options.batchTestHooks?.beforeRowReceiptWrite?.();
      await writeJson(receiptPath, renderResult.receipt ?? renderBatchFailureReceipt({
        packageId: job.manifest.id, rowHash: job.row.hash, preset: jobPreset, delivery: childDelivery
      }));
      await batchOutput.assertCurrent();
      if (!renderResult.ok) {
        const batchCounts = batchRenderCounts(jobs, dryRun);
        await batchOutput.assertCurrent();
        const receipt = await writeBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, frameLane, ...batchCounts, preset, ...presetSummary, quality, qualityManifestPath, jobs, status: childDelivery?.kind === "primary_uncertain" || childDelivery?.kind === "evidence_uncertain" ? "warning" : "failed" });
        const warnings = receiptWarnings(receipt);
        const error = batchRenderErrorEnvelope({ result: renderResult, rowId: job.row.id, packageId: job.manifest.id });
        return {
          ok: false,
          command: "render-batch",
          dryRun,
          ...(resume ? { resume, ...batchCounts } : {}),
          preset,
          ...presetSummary,
          ...(quality ? { quality } : {}),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          error,
          packageId: pkg.manifest.id,
          rows: rows.length,
          jobs,
          receipt,
          receiptPath: join(receiptsRoot, "batch-render.receipt.json"),
          ...renderCommitUncertainResponseFields(uncertainDelivery),
          ...renderBatchBookkeepingDeliveryFields(jobs),
          ...(warnings.length > 0 ? { warnings } : {})
        };
      }
      if (!qualityOk && qualityCheck) {
        const batchCounts = batchRenderCounts(jobs, dryRun);
        await batchOutput.assertCurrent();
        const receipt = await writeBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, frameLane, ...batchCounts, preset, ...presetSummary, quality, qualityManifestPath, jobs, status: "failed" });
        const warnings = receiptWarnings(receipt);
        const error = batchQualityError(job, qualityCheck);
        return {
          ok: false,
          command: "render-batch",
          dryRun,
          ...(resume ? { resume, ...batchCounts } : {}),
          preset,
          ...presetSummary,
          ...(quality ? { quality } : {}),
          ...(qualityManifestPath ? { qualityManifestPath } : {}),
          error,
          packageId: pkg.manifest.id,
          rows: rows.length,
          jobs,
          receipt,
          receiptPath: join(receiptsRoot, "batch-render.receipt.json"),
          ...(warnings.length > 0 ? { warnings } : {})
        };
      }
    }
  } catch (error) {
    if (jobs.some((job) => job.renderCommitted === true || job.renderCommitUncertain === true || job.possiblyCommitted === true)) {
      return renderBatchBookkeepingFailure({
        error, jobs, dryRun, resume, preset, presetSummary, quality, qualityManifestPath,
        packageId: pkg.manifest.id, rows: rows.length, phase: "row_bookkeeping"
      });
    }
    throw error;
  }

  const batchCounts = batchRenderCounts(jobs, dryRun);
  let receipt: Record<string, unknown>;
  try {
    await options.batchTestHooks?.beforeAggregateReceiptWrite?.();
    await batchOutput.assertCurrent();
    receipt = await writeBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, frameLane, ...batchCounts, preset, ...presetSummary, quality, qualityManifestPath, jobs, status: dryRun ? "not_run" : "passed" });
  } catch (error) {
    return renderBatchBookkeepingFailure({
      error, jobs, dryRun, resume, preset, presetSummary, quality, qualityManifestPath,
      packageId: pkg.manifest.id, rows: rows.length, phase: "aggregate_receipt"
    });
  }
  const warnings = receiptWarnings(receipt);
  return {
    ok: true,
    command: "render-batch",
    dryRun,
    frameLane,
    ...(resume ? { resume, ...batchCounts } : {}),
    preset,
    ...presetSummary,
    ...(quality ? { quality } : {}),
    ...(qualityManifestPath ? { qualityManifestPath } : {}),
    packageId: pkg.manifest.id,
    rows: rows.length,
    jobs,
    receipt,
    receiptPath: join(receiptsRoot, "batch-render.receipt.json"),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

async function writeBatchRowPlanReceipt(input: {
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
  qualityInputs?: BatchQualityInputEvidence;
  frameLane: BatchFrameLane;
  frameTransport?: ReturnType<typeof planFinalVideoFrameTransport>;
  packageAssetInputHashes?: Readonly<Record<string, string>>;
  warnings?: string[];
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
      idempotencyKey: hashBuffer(Buffer.from(input.idempotencyKey, "utf8")),
      ...input.packageAssetInputHashes,
      ...(input.qualityInputs ? {
        qualityManifest: input.qualityInputs.manifestSha256,
        qualityMaterializedManifest: input.qualityInputs.materializedManifestSha256,
        qualityBaselines: input.qualityInputs.baselinesSha256,
        qualityClosure: input.qualityInputs.closureSha256
      } : {})
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
      frameLane: input.frameLane,
      ...(input.frameTransport ? { frameTransport: input.frameTransport } : {}),
      status: input.status,
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
      ...(input.qualityInputs ? { qualityInputs: input.qualityInputs } : {})
    },
    artifacts: [
      { role: "row_package", path: input.packageDir, status: "available", mediaType: "application/vnd.shellx-motion.package+directory" },
      { role: "planned_output", path: input.outputPath, status: "planned" }
    ],
    warnings
  };
  await writeJson(receiptPath, receipt);
  return receiptPath;
}

async function writeExpandedPackage(job: ExpandedMotionJob, sourcePkg: Awaited<ReturnType<typeof loadMotionPackage>>, packageDir: string): Promise<Readonly<Record<string, string>>> {
  await mkdir(packageDir, { recursive: true, mode: 0o700 });
  await writeJson(join(packageDir, "manifest.json"), job.manifest);
  await writeJson(join(packageDir, "motion.json"), job.motion);
  // Template sidecars referenced from template.metadata are part of the package contract:
  // assertTemplatePackageSemantics() rejects a package whose declared quality manifest is
  // missing. They are NOT listed in manifest.assets, so copying manifest/motion/template
  // alone produced an expanded package that could not be loaded back. Every promoted family
  // declares qualityTargets.manifest, so this broke render-batch for the whole product pack.
  const qualityManifestRef = batchTemplateQualityManifestRef(sourcePkg);
  return await copyVerifiedPackageAssetSnapshots(sourcePkg, packageDir, [
    ...(job.manifest.template ? [job.manifest.template] : []),
    ...(job.manifest.assets ?? []),
    ...(qualityManifestRef ? [qualityManifestRef] : [])
  ], "CLI batch package snapshot");
}

async function writeBatchReceipt(input: {
  receiptsRoot: string;
  pkg: Awaited<ReturnType<typeof loadMotionPackage>>;
  rows: Array<{ id: string; hash: string; key?: string }>;
  dryRun: boolean;
  resume?: boolean;
  resumedRows?: number;
  renderedRows?: number;
  frameLane: "browser" | "native" | "gpu";
  preset: MotionExportPreset;
  presets?: MotionExportPreset[];
  quality?: { minUniqueFrameHashes: number };
  qualityManifestPath?: string;
  jobs: Array<Record<string, unknown>>;
  status: OperationReceipt["status"];
}): Promise<Record<string, unknown>> {
  const batchStatus = escalateReceiptStatusForWarnings(
    input.status,
    dedupeWarnings(input.jobs.flatMap((job) => resultWarnings(job)))
  );
  const qualityInputs = input.jobs.map((job) => job.qualityInputs).filter(Boolean);
  const rowHash = canonicalJsonSha256({
    rows: input.rows.map((row) => ({ id: row.id, hash: row.hash })),
    preset: input.preset,
    presets: input.presets,
    quality: input.quality,
    frameLane: input.frameLane,
    qualityManifestPath: input.qualityManifestPath,
    ...(qualityInputs.length > 0 ? { qualityInputs } : {})
  });
  const receipt = {
    schema: "shellx-motion/receipt@1",
    id: `batch-render-${input.pkg.manifest.id}-${rowHash.slice(0, 16)}`,
    operation: "render.batch",
    status: batchStatus,
    packageId: input.pkg.manifest.id,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")),
      rows: rowHash,
      ...(qualityInputs.length > 0 ? { qualityInputs: canonicalJsonSha256(qualityInputs) } : {})
    },
    createdAt: new Date().toISOString(),
    lane: "batch",
    output: {
      dryRun: input.dryRun,
      ...(input.resume ? { resume: true, resumedRows: input.resumedRows ?? 0, renderedRows: input.renderedRows ?? 0 } : {}),
      preset: input.preset,
      frameLane: input.frameLane,
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
        ...(typeof job.frameLane === "string" ? { frameLane: job.frameLane } : {}),
        ...(job.frameTransport ? { frameTransport: job.frameTransport } : {}),
        status: job.status,
        ...(job.planReceiptPath ? { planReceiptPath: job.planReceiptPath } : {}),
        receiptPath: job.receiptPath,
        ...renderCommitUncertainReceiptJobFields(job),
        ...(job.resume ? { resume: job.resume } : {}),
        ...(job.quality ? { quality: job.quality } : {}),
        ...(job.qualityManifestPath ? { qualityManifestPath: job.qualityManifestPath } : {}),
        ...(job.qualityInputs ? { qualityInputs: job.qualityInputs } : {}),
        ...(job.qualityManifestAppliedPath ? { qualityManifestAppliedPath: job.qualityManifestAppliedPath } : {}),
        ...qualityCheckReceiptOutput(job),
        ...(resultWarnings(job).length > 0 ? { warnings: resultWarnings(job) } : {})
      }))
    },
    warnings: dedupeWarnings(input.jobs.flatMap((job) => resultWarnings(job)))
  };
  await writeJson(join(input.receiptsRoot, "batch-render.receipt.json"), receipt);
  return receipt;
}

function batchRenderOutputPath(renderRoot: string, packageId: string, preset: MotionExportPreset): string {
  const spec = resolveMotionExportPreset(preset);
  if (readImageSequenceExportPreset(preset)) return join(renderRoot, packageId);
  return join(renderRoot, `${packageId}.${spec.extension}`);
}

function supportsBatchQualityManifestPreset(preset: MotionExportPreset): boolean {
  return Boolean(readFfmpegExportPreset(preset)) || preset === "png-frame" || preset === "png-sequence";
}


function audioWarningsForMotionExportPreset(preset: MotionExportPreset, audioInputCount: number): string[] {
  const ffmpegPreset = readFfmpegExportPreset(preset);
  if (ffmpegPreset) return audioWarningsForExportPreset(ffmpegPreset, audioInputCount);
  if (audioInputCount <= 0) return [];
  const noun = audioInputCount === 1 ? "track" : "tracks";
  return [`Export preset ${preset} does not support audio; ${audioInputCount} requested audio ${noun} will be ignored.`];
}

function audioInputCountForMotion(motion: ExpandedMotionJob["motion"]): number {
  const hasSoloedTrack = hasSoloedTimelineTrack(motion);
  return motion.layers.filter((layer) =>
    layer.startMs < motion.durationMs &&
    layer.startMs + layer.durationMs > 0 &&
    (!hasSoloedTrack || Boolean(timelineLayerSoloedTrackId(motion, layer))) &&
    !timelineLayerMutedTrackId(motion, layer) &&
    layerHasLocalAudioInput(layer)
  ).length;
}

function layerHasLocalAudioInput(layer: ExpandedMotionJob["motion"]["layers"][number]): boolean {
  if (layer.type !== "audio" && !(layer.type === "video" && layer.includeAudio === true)) return false;
  const ref = audioLayerAssetRef(layer);
  return Boolean(ref && isLocalAssetRef(ref));
}

function receiptWarnings(receipt: unknown): string[] {
  const record = readRecord(receipt);
  return record ? stringArray(record.warnings) : [];
}

function resultWarnings(result: unknown): string[] {
  const record = readRecord(result);
  if (!record) return [];
  if (Array.isArray(record.warnings)) return stringArray(record.warnings);
  return receiptWarnings(record.receipt);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    if (typeof item === "string") values.push(item);
  }
  return values;
}

function batchQualityError(job: ExpandedMotionJob, qualityResult: unknown): Record<string, unknown> {
  const qualityRecord = readRecord(qualityResult);
  const error = readRecord(qualityRecord?.error) ?? { code: "quality_check_failed", message: "Batch row quality check failed." };
  return {
    ...error,
    rowId: job.row.id,
    packageId: job.manifest.id
  };
}

function qualityCheckReceiptOutput(job: Record<string, unknown>): { qualityCheck?: { status: "passed" | "failed" } } {
  const qualityCheck = readRecord(job.qualityCheck);
  if (!qualityCheck) return {};
  return {
    qualityCheck: {
      status: qualityCheck.ok === true ? "passed" : "failed"
    }
  };
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

async function planImportCommand(argv: string[]): Promise<CliResult> {
  const root = argv[0];
  if (!root) return missingArgument("plan-import", "package root");

  const target = optionValue(argv, "--target") ?? "cut";
  if (target !== "cut") {
    return { ok: false, command: "plan-import", error: { code: "unsupported_target", message: `Unsupported import target: ${target}.` } };
  }

  const pkg = await loadMotionPackage(resolveInputPath(root));
  const plan = planCutImport(pkg, cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "auto" }));

  return {
    ok: plan.ok,
    command: "plan-import",
    target,
    plan,
    receiptId: plan.receipt.id
  };
}

/**
 * Connector subcommands that do expensive work, and the receipt operation each reports as.
 *
 * Keyed by subcommand so an unknown or non-rendering one falls through unwrapped rather than
 * creating a job record for something trivial. The operation string matches the receipt vocabulary
 * so a host job and the evidence it produced name the same thing.
 */
const CONNECTOR_HOST_JOB_OPERATIONS: Record<string, string> = {
  "template-to-cut": "connector.template_to_cut",
  "script-to-cut": "connector.script_to_cut",
  "cut-generate-to-cut": "connector.cut_generate_to_cut",
  "source-to-cut": "connector.source_to_cut",
  "canvas-to-cut": "connector.canvas_to_cut",
  "canvas-to-mp4": "connector.canvas_to_mp4"
};

async function connectorCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const subcommand = argv[0];
  const isScriptedVideoConnector = subcommand === "script-to-cut" || subcommand === "cut-generate-to-cut";
  if (!["canvas-bridge-export", "canvas-to-cut", "canvas-to-mp4", "script-to-cut", "source-to-cut", "cut-generate-to-cut", "template-to-cut"].includes(subcommand ?? "")) {
    return {
      ok: false,
      command: "connector",
      error: { code: "unknown_subcommand", message: `Unknown connector subcommand: ${subcommand ?? "(missing)"}.` }
    };
  }

  const inputPath = argv[1];
  // Template-to-Cut P2A is a no-clobber whole-directory transaction; legacy routes may replace.
  const forceOverwrite = argv.includes("--force");
  const command = `connector.${subcommand}`;
  const p2bArgumentRefusal = p2bConnectorArgumentRefusal(argv);
  if (p2bArgumentRefusal) return p2bArgumentRefusal;
  const templateArgumentRefusal = templateToCutArgumentRefusal(argv);
  if (templateArgumentRefusal) return templateArgumentRefusal;
  if (!inputPath) {
    const inputLabel = isScriptedVideoConnector
      ? "scripted video JSON path"
      : subcommand === "source-to-cut"
      ? "source Markdown path"
      : subcommand === "template-to-cut"
      ? "template Motion package root"
      : subcommand === "canvas-bridge-export"
      ? "Canvas checkout root"
      : "Canvas frame-selection JSON path";
    return missingArgument(command, inputLabel);
  }

  const outDir = optionValue(argv, "--out");
  if (!outDir) return missingArgument(command, "--out");
  if (subcommand === "template-to-cut" && forceOverwrite) return { ok: false, command, error: { code: "invalid_args", message: "connector template-to-cut does not support --force; choose an absent or empty --out directory." } };

  const dryRunRender = argv.includes("--dry-run-render");
  const cutImportModeArg = optionValue(argv, "--cut-import-mode") ?? "rendered_media";
  const cutImportMode = readCutImportModeRequest(cutImportModeArg);
  if (!cutImportMode) {
    return {
      ok: false,
      command,
      error: {
        code: "invalid_args",
        message: `Unsupported Cut import mode: ${cutImportModeArg}.`
      }
    };
  }
  if (subcommand === "template-to-cut" && cutImportMode !== "rendered_media") {
    return { ok: false, command, error: { code: "invalid_args", message: "connector template-to-cut accepts only --cut-import-mode rendered_media in P2A." } };
  }
  const cutStartMsRaw = optionValue(argv, "--start-ms");
  const cutDurationMsRaw = optionValue(argv, "--duration-ms");
  const cutTrackRaw = optionValue(argv, "--track");
  const cutStartMs = cutStartMsRaw === undefined ? undefined : Number(cutStartMsRaw);
  const cutDurationMs = cutDurationMsRaw === undefined ? undefined : Number(cutDurationMsRaw);
  const cutTrack = cutTrackRaw?.trim();
  if (cutStartMs !== undefined && (!Number.isSafeInteger(cutStartMs) || cutStartMs < 0)) {
    return { ok: false, command, error: { code: "invalid_args", message: "--start-ms must be a non-negative safe integer." } };
  }
  if (cutDurationMs !== undefined && (!Number.isSafeInteger(cutDurationMs) || cutDurationMs <= 0)) {
    return { ok: false, command, error: { code: "invalid_args", message: "--duration-ms must be a positive safe integer." } };
  }
  if (cutTrackRaw !== undefined && !cutTrack) {
    return { ok: false, command, error: { code: "invalid_args", message: "--track must be a non-empty string." } };
  }
  const cutPlacement = {
    ...(cutStartMs !== undefined ? { startMs: cutStartMs } : {}),
    ...(cutDurationMs !== undefined ? { durationMs: cutDurationMs } : {}),
    ...(cutTrack ? { track: cutTrack } : {})
  };
  if (subcommand === "canvas-bridge-export") {
    const selectedIds = [
      ...commaListOption(argv, "--selected-id"),
      ...commaListOption(argv, "--selected-ids")
    ];
    try {
      const durationMs = numberOption(argv, "--duration-ms");
      const fps = numberOption(argv, "--fps");
      const result = await runCanvasBridgeFrameSelectionExport({
        canvasRoot: resolveInputPath(inputPath),
        outPath: resolveOutputPath(outDir),
        force: forceOverwrite,
        ...(optionValue(argv, "--target") ? { target: optionValue(argv, "--target") } : {}),
        ...(optionValue(argv, "--project-name") ? { projectName: optionValue(argv, "--project-name") } : {}),
        ...(optionValue(argv, "--frame-name") ? { frameName: optionValue(argv, "--frame-name") } : {}),
        ...(selectedIds.length > 0 ? { selectedIds } : {}),
        ...(optionValue(argv, "--generated-at") ? { generatedAt: optionValue(argv, "--generated-at") } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(fps !== undefined ? { fps } : {})
      });
      return result.ok
        ? {
            ok: true,
            command,
            canvasRoot: result.canvasRoot,
            bridgePath: result.bridgePath,
            path: result.path,
            receiptPath: result.receiptPath,
            schema: result.schema,
            selectedFrameId: result.selectedFrameId,
            layerIds: result.layerIds,
            artifacts: result.artifacts
          }
        : {
            ok: false,
            command,
            canvasRoot: result.canvasRoot,
            bridgePath: result.bridgePath,
            path: result.path,
            error: result.error
          };
    } catch (error) {
      return {
        ok: false,
        command,
        error: {
          // A guard refusal keeps its typed code: "connector_failed" tells an agent nothing, while
          // output_dir_not_empty names both the problem and the fix.
          code: error instanceof MotionOutputGuardError ? error.code : "connector_failed",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof MotionOutputGuardError
            ? { suggestedAction: "Choose an empty --out directory, or pass --force to overwrite it." }
            : {})
        }
      };
    }
  }
  if (subcommand === "canvas-to-mp4") {
    const presetValue = optionValue(argv, "--preset") ?? "mp4-h264";
    const preset = readFfmpegExportPreset(presetValue);
    if (!preset) {
      return {
        ok: false,
        command,
        error: {
          code: "unsupported_preset",
          message: `Unsupported export preset: ${presetValue}.`
        }
      };
    }
    try {
      const result = await runCanvasMp4Export({
        canvasSelectionPath: resolveInputPath(inputPath),
        outDir: resolveOutputPath(outDir),
        force: forceOverwrite,
        preset,
        dryRunRender,
        ffmpegRunner: options.ffmpegRunner
      });
      return {
        ok: result.ok,
        command,
        packageDir: result.packageDir,
        resourceCatalogPath: result.resourceCatalogPath,
        render: result.render,
        artifacts: result.artifacts,
        ...(result.artifactHandle ? { artifactHandle: result.artifactHandle } : {}),
        integration: result.integration,
        ...(result.cutPlanPath ? { cutPlanPath: result.cutPlanPath } : {}),
        receiptPath: result.receiptPath,
        warnings: result.warnings
      };
    } catch (error) {
      return {
        ok: false,
        command,
        error: {
          // A guard refusal keeps its typed code: "connector_failed" tells an agent nothing, while
          // output_dir_not_empty names both the problem and the fix.
          code: error instanceof MotionOutputGuardError ? error.code : "connector_failed",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof MotionOutputGuardError
            ? { suggestedAction: "Choose an empty --out directory, or pass --force to overwrite it." }
            : {})
        }
      };
    }
  }
  let result:
    | Awaited<ReturnType<typeof runCanvasToCutConnector>>
    | Awaited<ReturnType<typeof runScriptToCutConnector>>
    | Awaited<ReturnType<typeof runCutGenerateToCutConnector>>
    | Awaited<ReturnType<typeof runSourceToCutConnector>>
    | Awaited<ReturnType<typeof runTemplateToCutConnector>>;
  try {
    result = subcommand === "canvas-to-cut" || subcommand === "source-to-cut" || subcommand === "template-to-cut" || subcommand === "script-to-cut"
      ? await runNamedP2ConnectorThroughRegistry({
          subcommand,
          inputPath: resolveInputPath(inputPath),
          outputPath: resolveOutputPath(outDir),
          ...(resolveCallerId(argv, options) ? { callerId: resolveCallerId(argv, options)! } : {}),
          signal: options.signal ?? new AbortController().signal,
          namedCompatibilityOptions: {
            ...(Object.keys(cutPlacement).length > 0 ? { cutPlacement } : {}),
            ...(subcommand === "template-to-cut" ? { values: parseTemplateSetOptions(argv) } : {}),
            ...(subcommand === "source-to-cut" ? {
              maxFrames: numberOption(argv, "--max-frames") ?? numberOption(argv, "--maxFrames"),
              frameDurationMs: numberOption(argv, "--frame-duration-ms") ?? numberOption(argv, "--frameDurationMs"),
              width: numberOption(argv, "--width"),
              height: numberOption(argv, "--height"),
              fps: numberOption(argv, "--fps")
            } : {})
          }
        })
      : subcommand === "cut-generate-to-cut"
      ? await runCutGenerateToCutConnector({
          scriptPath: resolveInputPath(inputPath),
          outDir: resolveOutputPath(outDir),
          force: forceOverwrite,
          previewLane: "native",
          renderLane: "ffmpeg",
          dryRunRender,
          cutImportMode,
          ...(Object.keys(cutPlacement).length > 0 ? { cutPlacement } : {}),
          ffmpegRunner: options.ffmpegRunner
        })
      : (() => { throw new Error(`Unsupported connector subcommand: ${String(subcommand)}.`); })();
  } catch (error) {
    const uncertainty = corePublicationUncertaintyFields(error);
    if (uncertainty) {
      return { ok: false, command, ...uncertainty };
    }
    return {
      ok: false,
      command,
      error: {
        code: error instanceof MotionOutputGuardError || error instanceof NamedConnectorRegistryError
          ? error.code
          : "connector_failed",
        message: ["canvas-to-cut", "script-to-cut", "source-to-cut"].includes(subcommand ?? "")
          ? redactP2bConnectorInputError(error, inputPath)
          : error instanceof Error ? error.message : String(error),
        ...(error instanceof MotionOutputGuardError
          ? { suggestedAction: subcommand === "template-to-cut"
            ? "Choose an absent or empty --out directory; Template-to-Cut accepted delivery never overwrites it."
            : "Choose an empty --out directory, or pass --force to overwrite it." }
          : {})
      }
    };
  }

  const error = result.ok ? undefined : await connectorFailureEnvelope(result.render);
  const response = {
    ok: result.ok,
    command,
    packageDir: result.packageDir,
    ...("template" in result ? { template: result.template } : {}),
    ...("source" in result && "storyboard" in result ? { source: result.source, storyboard: result.storyboard } : {}),
    preview: result.preview,
    render: result.render,
    cutPlanPath: result.cutPlanPath,
    ...("artifacts" in result ? { artifacts: result.artifacts } : {}),
    receiptPath: result.receiptPath,
    warnings: result.warnings,
    ...(error ? { error } : {})
  };

  // Motion's connector boundary ends at artifacts, receipts, and the Cut import plan. The caller
  // owns plan validation and application inside Cut.
  return response;
}

/**
 * Promote a failed connector render receipt into the CLI's failure envelope.
 *
 * Connectors retain their detailed, typed streaming evidence in the owned render receipt. The CLI
 * must still give callers a stable command-level failure instead of returning only `ok: false`.
 */
async function connectorFailureEnvelope(render: unknown): Promise<{ code: "connector_failed"; message: string }> {
  const receiptPath = readRecord(render)?.receiptPath;
  if (typeof receiptPath === "string") {
    try {
      const receipt = readRecord(JSON.parse(await readFile(receiptPath, "utf8")));
      const failure = readRecord(readRecord(receipt?.output)?.error);
      if (typeof failure?.message === "string" && failure.message.trim()) {
        return { code: "connector_failed", message: failure.message };
      }
    } catch {
      // Preserve the connector result even if a caller or interrupted process removed its receipt.
    }
  }
  return { code: "connector_failed", message: "Connector rendering failed; inspect its render receipt for evidence." };
}

function normalizeArgv(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

/** Resolve Debug --out before its typed adapter receives the caller-supplied path. */
function resolveDebugOutputOptions(argv: string[]): string[] {
  return argv.map((value, index) => argv[index - 1] === "--out" ? resolveOutputPath(value) : value);
}

function collectPositionals(argv: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      if (!VALUELESS_FLAGS.has(value)) index += 1;
      continue;
    }
    positionals.push(value);
  }
  return positionals;
}

// `--fake` was removed from this set with the fake runtimes it used to enable (the tool-provenance invariant). It is not a
// flag at all now: `retiredSimulationRefusal` in `./retired-options` rejects it before dispatch, so
// it never reaches this scan.
const VALUELESS_FLAGS = new Set(["--expect-audio", "--fail-on-drift", "--needs-alpha", "--needs-audio", "--needs-subtitles", "--dry-run", "--dry-run-render", "--resume", "--resume-segments", "--trusted-local-tier", "--commercial-use", "--retain-raw-prompt", "--keep-frames"]);
const CLI_TIER_ORDER: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

function hasFlag(argv: string[], option: string): boolean {
  return argv.includes(option);
}

function optionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberOption(argv: string[], option: string): number | undefined {
  const value = optionValue(argv, option);
  if (value === undefined || value.startsWith("--")) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Build the receipt actor for a CLI-invoked operation. The observed transport is always "cli"; the
 * granted tier is recorded so History shows the permission the command ran under. An agent framework
 * wrapping the CLI can name itself with `--actor <label>` or the `SHELLX_MOTION_ACTOR` env, which
 * flips the kind to "agent"; a bare human invocation stays "human". The label is a claim — a
 * per-command `createdBy` still wins over it in applyReceiptActor — but "cli" + tier are observed.
 *
 * @param argv Raw CLI arguments (scanned for `--actor`).
 * @param tier The permission tier this invocation resolved to.
 * @returns The CLI actor to thread into the dispatch context.
 */
function readCliActor(argv: string[], tier: MotionPermissionTier): ReceiptActor {
  const flagLabel = optionValue(argv, "--actor");
  const envLabel = typeof process.env.SHELLX_MOTION_ACTOR === "string" ? process.env.SHELLX_MOTION_ACTOR.trim() : "";
  const label = (flagLabel && !flagLabel.startsWith("--") ? flagLabel : undefined) ?? (envLabel || undefined);
  return {
    kind: label ? "agent" : "human",
    label: label ?? "cli",
    transport: "cli",
    sessionId: `cli-${process.pid}`,
    grantedTier: tier
  };
}

function booleanOption(argv: string[], option: string): boolean | undefined {
  if (!hasFlag(argv, option)) return undefined;
  const value = optionValue(argv, option);
  if (value === undefined || value.startsWith("--")) return true;
  return parseStrictBooleanOption(value);
}

function optionValues(argv: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== option) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function readCliTier(
  argv: string[],
  defaultTier: MotionPermissionTier,
  options: RunCliOptions
): { ok: true; tier: MotionPermissionTier } | { ok: false; error: { code: string; message: string; suggestedAction?: string } } {
  const requested = optionValue(argv, "--tier");
  if (requested === undefined) return { ok: true, tier: defaultTier };
  const requestedTier = readCliPermissionTier(requested);
  if (requested.startsWith("--") || !requestedTier) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: `Unsupported CLI permission tier: ${requested}.`
      }
    };
  }
  const trustedLocalTier = options.trustedLocalTier === true || hasFlag(argv, "--trusted-local-tier");
  if (!trustedLocalTier && cliTierRank(requestedTier) > cliTierRank(defaultTier)) {
    return {
      ok: false,
      error: {
        code: "untrusted_tier",
        message: `CLI --tier elevation to ${requested} requires a trusted local assertion.`,
        suggestedAction: "Run from a trusted ShellX host context or pass --trusted-local-tier for local development."
      }
    };
  }
  return { ok: true, tier: requestedTier };
}

function readCliPermissionTier(value: string): MotionPermissionTier | null {
  for (const tier of CLI_TIER_ORDER) {
    if (tier === value) return tier;
  }
  return null;
}

function cliTierRank(tier: MotionPermissionTier): number {
  return CLI_TIER_ORDER.indexOf(tier);
}

function commaListOption(argv: string[], option: string): string[] {
  return optionValues(argv, option).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function batchRowIdOptions(argv: string[]): string[] {
  return [
    ...commaListOption(argv, "--row-id"),
    ...commaListOption(argv, "--row-ids"),
    ...commaListOption(argv, "--row")
  ];
}

function jsonOption(argv: string[], option: string): unknown {
  const raw = optionValue(argv, option);
  if (!raw || raw.startsWith("--")) return undefined;
  return JSON.parse(raw);
}

function layerDuckingTriggerOptions(argv: string[]): string[] {
  const rawValues = [
    ...optionValues(argv, "--trigger-layer"),
    ...optionValues(argv, "--trigger-layer-id"),
    ...optionValues(argv, "--trigger-layers"),
    ...optionValues(argv, "--trigger-layer-ids")
  ];
  return rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function trackCreateLayerOptions(argv: string[]): string[] {
  const rawValues = [
    ...optionValues(argv, "--layer"),
    ...optionValues(argv, "--layer-id"),
    ...optionValues(argv, "--layers"),
    ...optionValues(argv, "--layer-ids")
  ];
  return rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseKeyframeValueOption(value: string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

const STYLE_NUMBER_OPTIONS = new Set([
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "width",
  "height",
  "radius",
  "borderRadius",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "strokeWidth",
  "borderWidth"
]);

const TRANSFORM_NUMBER_OPTIONS = new Set([
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "scale",
  "rotation",
  "originX",
  "originY"
]);
const EFFECT_NUMBER_OPTIONS = new Set(["blur", "brightness", "contrast", "saturate", "grayscale"]);

function parseStyleValueOption(property: string | undefined, value: string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const normalizedProperty = property?.trim().replace(/^style\./, "");
  if (!normalizedProperty || !STYLE_NUMBER_OPTIONS.has(normalizedProperty)) return trimmed;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function parseTransformValueOption(property: string | undefined, value: string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const normalizedProperty = property?.trim().replace(/^transform\./, "");
  if (!normalizedProperty || !TRANSFORM_NUMBER_OPTIONS.has(normalizedProperty)) return trimmed;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function parseEffectValueOption(property: string | undefined, value: string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const normalizedProperty = property?.trim().replace(/^effects?\./, "");
  if (!normalizedProperty || !EFFECT_NUMBER_OPTIONS.has(normalizedProperty)) return trimmed;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function parseRichValueOption(value: string | undefined, jsonValue: unknown): unknown {
  if (jsonValue !== undefined) return jsonValue;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed);
  return trimmed.length > 0 && Number.isFinite(numeric) ? numeric : value;
}

function parseTemplateSetOptions(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--set") continue;
    const raw = argv[index + 1];
    if (!raw) continue;
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex <= 0) continue;
    values[raw.slice(0, equalsIndex)] = raw.slice(equalsIndex + 1);
    index += 1;
  }
  return values;
}

function numericOption(
  argv: string[],
  option: string,
  defaultValue?: number
): { ok: true; value: number | undefined } | { ok: false; result: CliResult } {
  const raw = optionValue(argv, option);
  if (raw === undefined) return { ok: true, value: defaultValue };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "quality-check",
        error: {
          code: "invalid_args",
          message: `${option} must be a non-negative number.`
        }
      }
    };
  }
  return { ok: true, value };
}

function unitIntervalOption(
  argv: string[],
  option: string
): { ok: true; value: number | undefined } | { ok: false; result: CliResult } {
  const raw = optionValue(argv, option);
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return {
      ok: false,
      result: invalidQualityArgs(`${option} must be a number between 0 and 1.`)
    };
  }
  return { ok: true, value };
}

function finiteOption(
  argv: string[],
  option: string
): { ok: true; value: number | undefined } | { ok: false; result: CliResult } {
  const raw = optionValue(argv, option);
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "quality-check",
        error: {
          code: "invalid_args",
          message: `${option} must be a finite number.`
        }
      }
    };
  }
  return { ok: true, value };
}

function defaultFfmpegRunner(signal: AbortSignal | undefined, callerId?: string): FfmpegRunner {
  // The governed runner has always accepted a signal; nothing ever supplied one, so the abort
  // plumbing beneath it was unreachable.
  return (command) => createGovernedFfmpegRunner({
    ...(signal ? { signal } : {}),
    ...(callerId ? { callerId } : {})
  })(command);
}

function summarizeProcessOutput(result: FfmpegProcessResult): string {
  return redactProcessOutput((result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" "));
}

function redactProcessOutput(value: string): string {
  return value.replace(/\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=([^\s]+)/g, (match) => {
    const [key] = match.split("=");
    return `${key}=[redacted]`;
  });
}

function formatSeconds(seconds: number): string {
  return String(Number(seconds.toFixed(3)));
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function frameCountFor(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

export function renderFrameSequenceBudgetError(
  frameCount: number,
  width: number,
  height: number
): string | undefined {
  return materializedFrameSequenceStaticRefusal({ frameCount, width, height })?.message;
}

function materializedFrameSequencePreflightRefusal(
  resourcePreflight: ReturnType<typeof preflightMaterializedFrameSequence>,
  frameLane: "browser" | "native"
): CliResult {
  return {
    ok: false,
    command: "render",
    lane: "ffmpeg",
    frameLane,
    error: {
      code: resourcePreflight.refusal?.code === "render_static_sequence_limit_exceeded"
        ? "render_budget_exceeded"
        : resourcePreflight.refusal?.code ?? "render_resource_preflight_exceeded",
      message: resourcePreflight.refusal?.message ?? "Materialized frame sequence was refused.",
      ...(resourcePreflight.refusal?.suggestedAction ? { suggestedAction: resourcePreflight.refusal.suggestedAction } : {}),
      resourcePreflight
    }
  };
}

function frameTimestampMs(frameIndex: number, fps: number, durationMs: number): number {
  const atMs = Math.round((frameIndex * 1000) / fps);
  return Math.max(0, Math.min(atMs, Math.max(0, durationMs - 1)));
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


function debugPackageRoot(argv: string[]): string | undefined {
  const value = optionValue(argv, "--package") ?? optionValue(argv, "--package-root");
  return value ? resolveInputPath(value) : undefined;
}

async function debugArgs(command: MotionDebugCommand, argv: string[]): Promise<unknown> {
  if (command === "motion.state") {
    return {
      packageRoot: debugPackageRoot(argv),
      receiptsRoot: optionValue(argv, "--receipts-root")
    };
  }
  if (command === "motion.open") {
    return { panel: optionValue(argv, "--panel") ?? "preview" };
  }
  if (command === "motion.preview.panel") {
    return { packageRoot: debugPackageRoot(argv) };
  }
  if (command === "motion.preview.frame") {
    const atMs = optionValue(argv, "--at-ms");
    const workflowPath = optionValue(argv, "--workflow") ?? optionValue(argv, "--workflow-path");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out"),
      outputPath: optionValue(argv, "--output"),
      ...(atMs !== undefined ? { atMs: Number(atMs) } : {}),
      ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.preview.playhead") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out"),
      outputPath: optionValue(argv, "--output"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.preview.strip") {
    const frameCount = optionValue(argv, "--frame-count") ?? optionValue(argv, "--frames");
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      ...(frameCount !== undefined ? { frameCount: Number(frameCount) } : {}),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {}),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.analysis.tracking.request") {
    const reference = readRecord(jsonOption(argv, "--reference-json"));
    const settings = readRecord(jsonOption(argv, "--settings-json"));
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      analysisId: optionValue(argv, "--analysis-id") ?? optionValue(argv, "--id"),
      assetId: optionValue(argv, "--asset-id") ?? optionValue(argv, "--asset"),
      mode: optionValue(argv, "--mode"),
      model: optionValue(argv, "--model"),
      ...(reference ? { reference } : {}),
      ...(settings ? { settings } : {}),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.analysis.tracking.inspect") {
    return {
      packageRoot: debugPackageRoot(argv),
      analysisId: optionValue(argv, "--analysis-id") ?? optionValue(argv, "--id")
    };
  }
  if (command === "motion.analysis.tracking.apply") {
    const segmentIndex = optionValue(argv, "--segment-index");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      analysisId: optionValue(argv, "--analysis-id") ?? optionValue(argv, "--id"),
      layerId: optionValue(argv, "--layer-id") ?? optionValue(argv, "--layer"),
      ...(segmentIndex !== undefined ? { segmentIndex: Number(segmentIndex) } : {}),
      ...(hasFlag(argv, "--include-low-confidence") ? { includeLowConfidence: true } : {}),
      receiptsRoot: optionValue(argv, "--receipts-root")
    };
  }
  if (command === "motion.analysis.tracking.detach") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      layerId: optionValue(argv, "--layer-id") ?? optionValue(argv, "--layer"),
      receiptsRoot: optionValue(argv, "--receipts-root")
    };
  }
  if (command === "motion.analysis.tracking.verify") {
    return {
      packageRoot: debugPackageRoot(argv),
      layerId: optionValue(argv, "--layer-id") ?? optionValue(argv, "--layer"),
      analysisId: optionValue(argv, "--analysis-id") ?? optionValue(argv, "--id")
    };
  }
  if (command === "motion.capabilities.match" || command === "motion.capabilities.panel") {
    return {
      packageRoot: debugPackageRoot(argv),
      output: optionValue(argv, "--output"),
      target: optionValue(argv, "--target"),
      ...(hasFlag(argv, "--needs-alpha") ? { needsAlpha: true } : {}),
      ...(hasFlag(argv, "--needs-audio") ? { needsAudio: true } : {}),
      ...(hasFlag(argv, "--needs-subtitles") ? { needsSubtitles: true } : {}),
      preferLane: optionValue(argv, "--prefer-lane") ?? optionValue(argv, "--prefer")
    };
  }
  if (command === "motion.export.presets" || command === "motion.export.panel") {
    if (command === "motion.export.panel") {
      const receiptsRoot = optionValue(argv, "--receipts-root");
      return {
        ...(receiptsRoot ? { receiptsRoot: resolveInputPath(receiptsRoot) } : {}),
        ...(optionValue(argv, "--required-hosts") ? { requiredHosts: commaListOption(argv, "--required-hosts") } : {})
      };
    }
    return {};
  }
  if (command === "motion.export.plan") {
    const receiptsRoot = optionValue(argv, "--receipts-root");
    const outputPath = optionValue(argv, "--out") ?? optionValue(argv, "--output") ?? optionValue(argv, "--output-path");
    const qualityManifestPath = optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest");
    return {
      packageRoot: debugPackageRoot(argv),
      target: optionValue(argv, "--target"),
      preset: optionValue(argv, "--preset"),
      ...(outputPath ? { outputPath: resolveOutputPath(outputPath) } : {}),
      ...(qualityManifestPath ? { qualityManifestPath: resolveInputPath(qualityManifestPath) } : {}),
      ...(receiptsRoot ? { receiptsRoot: resolveInputPath(receiptsRoot) } : {}),
      ...(optionValue(argv, "--required-hosts") ? { requiredHosts: commaListOption(argv, "--required-hosts") } : {}),
      ...(hasFlag(argv, "--needs-alpha") ? { needsAlpha: true } : {}),
      ...(hasFlag(argv, "--needs-audio") ? { needsAudio: true } : {})
    };
  }
  if (command === "motion.receipts.list") {
    return { receiptsRoot: optionValue(argv, "--receipts-root") };
  }
  if (command === "motion.receipts.read") {
    const receiptPath = optionValue(argv, "--receipt-path") ?? optionValue(argv, "--path");
    return {
      receiptsRoot: optionValue(argv, "--receipts-root"),
      receiptId: optionValue(argv, "--receipt-id") ?? optionValue(argv, "--id"),
      ...(receiptPath ? { receiptPath: resolveInputPath(receiptPath) } : {})
    };
  }
  if (command === "motion.receipts.panel") {
    const limit = optionValue(argv, "--limit");
    return {
      receiptsRoot: optionValue(argv, "--receipts-root"),
      ...(limit !== undefined ? { limit: Number(limit) } : {})
    };
  }
  if (command === "motion.platform.verification.panel") {
    return {
      receiptsRoot: optionValue(argv, "--receipts-root"),
      ...(optionValue(argv, "--required-hosts") ? { requiredHosts: commaListOption(argv, "--required-hosts") } : {})
    };
  }
  if (command === "motion.actions.find" || command === "motion.actions.guide" || command === "motion.actions.plan") {
    const request = optionValue(argv, "--request") ?? optionValue(argv, "--prompt") ?? collectPositionals(argv.slice(1)).join(" ").trim();
    return { request };
  }
  if (command === "motion.actions.panel") {
    return {};
  }
  if (command === "motion.assets.panel" || command === "motion.brand.panel") {
    return { packageRoot: debugPackageRoot(argv) };
  }
  if (command === "motion.audio.panel" || command === "motion.media.panel") {
    return {
      packageRoot: debugPackageRoot(argv),
      preset: optionValue(argv, "--preset") ?? optionValue(argv, "--export-preset")
    };
  }
  if (command === "motion.agent.transcript") {
    const receiptPath = optionValue(argv, "--receipt-path") ?? optionValue(argv, "--path");
    const limit = optionValue(argv, "--limit");
    return {
      receiptsRoot: optionValue(argv, "--receipts-root"),
      receiptId: optionValue(argv, "--receipt-id") ?? optionValue(argv, "--id"),
      ...(receiptPath ? { receiptPath: resolveInputPath(receiptPath) } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {})
    };
  }
  if (command === "motion.agent.revision.plan") {
    const qualityReceiptPath = optionValue(argv, "--quality-receipt-path") ?? optionValue(argv, "--receipt-path");
    const contactSheetPath = optionValue(argv, "--contact-sheet") ?? optionValue(argv, "--contact-sheet-path");
    const planPath = optionValue(argv, "--plan-output") ?? optionValue(argv, "--plan-path") ?? optionValue(argv, "--output");
    return {
      packageId: optionValue(argv, "--package-id") ?? optionValue(argv, "--packageId"),
      templateId: optionValue(argv, "--template-id") ?? optionValue(argv, "--templateId"),
      sourceJobId: optionValue(argv, "--source-job-id") ?? optionValue(argv, "--sourceJobId"),
      planId: optionValue(argv, "--plan-id") ?? optionValue(argv, "--planId"),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      qualityReceiptId: optionValue(argv, "--quality-receipt-id") ?? optionValue(argv, "--receipt-id"),
      ...(optionValue(argv, "--quality-receipt-ids") ? { qualityReceiptIds: commaListOption(argv, "--quality-receipt-ids") } : {}),
      ...(qualityReceiptPath ? { qualityReceiptPath: resolveInputPath(qualityReceiptPath) } : {}),
      ...(optionValues(argv, "--quality-receipt-path").length > 1 ? { qualityReceiptPaths: optionValues(argv, "--quality-receipt-path").map(resolveInputPath) } : {}),
      ...(contactSheetPath ? { contactSheetPath: resolveInputPath(contactSheetPath) } : {}),
      ...(planPath ? { planPath: resolveOutputPath(planPath) } : {})
    };
  }
  if (command === "motion.prompt.run") {
    return {
      request: optionValue(argv, "--request") ?? optionValue(argv, "--prompt"),
      packageId: optionValue(argv, "--package-id") ?? optionValue(argv, "--packageId"),
      agentId: optionValue(argv, "--agent") ?? optionValue(argv, "--agent-id"),
      cwd: optionValue(argv, "--cwd"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      ...(hasFlag(argv, "--retain-raw-prompt") ? { retainRawRequest: true } : {}),
      ...(optionValue(argv, "--raw-prompt-delete-after") ? { rawRequestDeleteAfter: optionValue(argv, "--raw-prompt-delete-after") } : {}),
      ...(optionValue(argv, "--raw-prompt-purpose") ? { rawRequestPurpose: optionValue(argv, "--raw-prompt-purpose") } : {}),
      ...(hasFlag(argv, "--execute-agent-commands") || hasFlag(argv, "--execute") ? { executeAgentCommands: true } : {})
    };
  }
  if (command === "motion.prompt.queue") {
    return { receiptsRoot: optionValue(argv, "--receipts-root") };
  }
  if (command === "motion.prompt.cancel" || command === "motion.prompt.retry") {
    return {
      receiptsRoot: optionValue(argv, "--receipts-root"),
      receiptId: optionValue(argv, "--receipt-id") ?? optionValue(argv, "--id"),
      reason: optionValue(argv, "--reason")
    };
  }
  if (command === "motion.browser.workflow.capture") {
    const atMs = optionValue(argv, "--at-ms");
    const workflowPath = optionValue(argv, "--workflow") ?? optionValue(argv, "--workflow-path");
    const catalogPath = optionValue(argv, "--catalog") ?? optionValue(argv, "--catalog-path") ?? optionValue(argv, "--workflow-catalog");
    const recordingManifestPath = optionValue(argv, "--recording-manifest") ?? optionValue(argv, "--recording-manifest-path");
    const recordingFramesDir = optionValue(argv, "--recording-frames-dir");
    const recordingSampleCount = optionValue(argv, "--recording-samples") ?? optionValue(argv, "--recording-sample-count");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out"),
      outputPath: optionValue(argv, "--output") ?? optionValue(argv, "--output-path"),
      ...(atMs !== undefined ? { atMs: Number(atMs) } : {}),
      ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}),
      ...(catalogPath ? { catalogPath: resolveOutputPath(catalogPath) } : {}),
      ...(recordingManifestPath ? { recordingManifestPath: resolveOutputPath(recordingManifestPath) } : {}),
      ...(recordingFramesDir ? { recordingFramesDir: resolveOutputPath(recordingFramesDir) } : {}),
      ...(recordingSampleCount !== undefined ? { recordingSampleCount: Number(recordingSampleCount) } : {}),
      ...(hasFlag(argv, "--fail-on-drift") ? { failOnDrift: true } : {})
    };
  }
  if (command === "motion.render.cache.plan") return debugRenderCachePlanArgs(argv, debugPackageRoot, optionValue, resolveInputPath);
  if (command === "motion.render.final") {
    const atMs = optionValue(argv, "--at-ms");
    const minUniqueFrameHashes = optionValue(argv, "--min-unique-frames") ?? optionValue(argv, "--min-unique-frame-hashes");
    const workflowPath = optionValue(argv, "--workflow") ?? optionValue(argv, "--workflow-path");
    const qualityManifestPath = optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest");
    const segmentFrames = optionValue(argv, "--segment-frames");
    return {
      packageRoot: debugPackageRoot(argv),
      outputPath: optionValue(argv, "--output") ?? optionValue(argv, "--output-path") ?? optionValue(argv, "--out"),
      framesDir: optionValue(argv, "--frames-dir") ?? optionValue(argv, "--frames"),
      frameLane: optionValue(argv, "--frame-lane"),
      preset: optionValue(argv, "--preset"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      ...(atMs !== undefined ? { atMs: Number(atMs) } : {}),
      ...(minUniqueFrameHashes !== undefined ? { minUniqueFrameHashes: Number(minUniqueFrameHashes) } : {}),
      ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}),
      ...(qualityManifestPath ? { qualityManifestPath: resolveInputPath(qualityManifestPath) } : {}),
      ...(segmentFrames !== undefined ? { segmented: { segmentFrames: Number(segmentFrames), ...(hasFlag(argv, "--resume-segments") ? { resume: true } : {}) } } : {}),
      ...(hasFlag(argv, "--dry-run") ? { dryRun: true } : {}),
      ...(hasFlag(argv, "--reuse-attested") ? { reuseAttested: true } : {})
    };
  }
  if (command === "motion.render.batch") {
    const rowsPath = optionValue(argv, "--rows") ?? optionValue(argv, "--rows-path");
    const rowIds = batchRowIdOptions(argv);
    const qualityManifestPath = optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest");
    const workflowPath = optionValue(argv, "--workflow") ?? optionValue(argv, "--workflow-path");
    const minUniqueFrameHashes = optionValue(argv, "--min-unique-frames") ?? optionValue(argv, "--min-unique-frame-hashes");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out"),
      ...(rowsPath ? { rowsPath: resolveInputPath(rowsPath) } : {}),
      ...(rowIds.length > 0 ? { rowIds } : {}),
      ...(qualityManifestPath ? { qualityManifestPath: resolveInputPath(qualityManifestPath) } : {}),
      preset: optionValue(argv, "--preset"),
      ...(hasFlag(argv, "--run") || hasFlag(argv, "--real-render") || hasFlag(argv, "--no-dry-run")
        ? { dryRun: false }
        : hasFlag(argv, "--dry-run")
          ? { dryRun: true }
          : {}),
      ...(hasFlag(argv, "--resume") ? { resume: true } : {}),
      ...(minUniqueFrameHashes !== undefined ? { minUniqueFrameHashes: Number(minUniqueFrameHashes) } : {}),
      ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {})
    };
  }
  if (command === "motion.connector.canvas_to_mp4") {
    const canvasSelectionPath = optionValue(argv, "--canvas-selection") ?? optionValue(argv, "--canvas-selection-path") ?? optionValue(argv, "--selection") ?? optionValue(argv, "--path");
    return {
      ...(canvasSelectionPath ? { canvasSelectionPath: resolveInputPath(canvasSelectionPath) } : {}),
      outDir: optionValue(argv, "--out"),
      ...(optionValue(argv, "--preset") ? { preset: optionValue(argv, "--preset") } : {}),
      ...(hasFlag(argv, "--dry-run-render") ? { dryRunRender: true } : {})
    };
  }
  if (command === "motion.canvas.package") {
    const canvasSelectionPath = optionValue(argv, "--canvas-selection") ?? optionValue(argv, "--canvas-selection-path") ?? optionValue(argv, "--selection") ?? optionValue(argv, "--path");
    const selection = readRecord(jsonOption(argv, "--selection-json")) ?? readRecord(jsonOption(argv, "--canvas-selection-json"));
    return {
      ...(canvasSelectionPath ? { canvasSelectionPath: resolveInputPath(canvasSelectionPath) } : {}),
      ...(selection ? { selection } : {}),
      packageDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      selectedFrameId: optionValue(argv, "--selected-frame-id") ?? optionValue(argv, "--frame-id"),
      sourceRoot: optionValue(argv, "--source-root"),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt"),
      createdBy: optionValue(argv, "--created-by"),
      receiptsRoot: optionValue(argv, "--receipts-root")
    };
  }
  if (command === "motion.canvas.bridge_export") {
    const selectedIds = [
      ...commaListOption(argv, "--selected-id"),
      ...commaListOption(argv, "--selected-ids")
    ];
    const durationMs = numberOption(argv, "--duration-ms");
    const fps = numberOption(argv, "--fps");
    return {
      canvasRoot: optionValue(argv, "--canvas-root") ?? optionValue(argv, "--canvasRoot") ?? optionValue(argv, "--root") ?? optionValue(argv, "--path"),
      outPath: optionValue(argv, "--out") ?? optionValue(argv, "--out-path"),
      target: optionValue(argv, "--target"),
      projectName: optionValue(argv, "--project-name"),
      frameName: optionValue(argv, "--frame-name"),
      ...(selectedIds.length > 0 ? { selectedIds } : {}),
      generatedAt: optionValue(argv, "--generated-at") ?? optionValue(argv, "--created-at"),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(fps !== undefined ? { fps } : {})
    };
  }
  if (command === "motion.connector.canvas_to_cut") {
    const canvasSelectionPath = optionValue(argv, "--canvas-selection") ?? optionValue(argv, "--canvas-selection-path") ?? optionValue(argv, "--selection") ?? optionValue(argv, "--path");
    return {
      ...(canvasSelectionPath ? { canvasSelectionPath: resolveInputPath(canvasSelectionPath) } : {}),
      outDir: optionValue(argv, "--out"),
      cutImportMode: optionValue(argv, "--cut-import-mode"),
      ...(hasFlag(argv, "--dry-run-render") ? { dryRunRender: true } : {}),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.script.compile") {
    const scriptPath = optionValue(argv, "--script") ?? optionValue(argv, "--script-path") ?? optionValue(argv, "--storyboard") ?? optionValue(argv, "--storyboard-path") ?? optionValue(argv, "--path");
    const script = readRecord(jsonOption(argv, "--script-json"));
    return {
      ...(scriptPath ? { scriptPath: resolveInputPath(scriptPath) } : {}),
      ...(script ? { script } : {}),
      packageDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.storyboard.panel" || command === "motion.storyboard.graph") {
    const scriptPath = optionValue(argv, "--script") ?? optionValue(argv, "--script-path") ?? optionValue(argv, "--storyboard") ?? optionValue(argv, "--storyboard-path") ?? optionValue(argv, "--path");
    const script = readRecord(jsonOption(argv, "--script-json"));
    const storyboard = readRecord(jsonOption(argv, "--storyboard-json"));
    return {
      ...(scriptPath ? { scriptPath: resolveInputPath(scriptPath) } : {}),
      ...(script ? { script } : {}),
      ...(storyboard ? { storyboard } : {})
    };
  }
  if (command === "motion.connector.script_to_cut" || command === "motion.connector.cut_generate_to_cut") {
    const scriptPath = optionValue(argv, "--script") ?? optionValue(argv, "--script-path") ?? optionValue(argv, "--storyboard") ?? optionValue(argv, "--storyboard-path");
    const script = readRecord(jsonOption(argv, "--script-json"));
    return {
      ...(scriptPath ? { scriptPath: resolveInputPath(scriptPath) } : {}),
      ...(script ? { script } : {}),
      outDir: optionValue(argv, "--out"),
      cutImportMode: optionValue(argv, "--cut-import-mode"),
      ...(hasFlag(argv, "--dry-run-render") ? { dryRunRender: true } : {}),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.connector.source_to_cut") {
    const sourcePath = optionValue(argv, "--source") ?? optionValue(argv, "--source-path") ?? optionValue(argv, "--sourcePath") ?? optionValue(argv, "--path") ?? optionValue(argv, "--in");
    const maxFrames = numberOption(argv, "--max-frames") ?? numberOption(argv, "--maxFrames");
    const frameDurationMs = numberOption(argv, "--frame-duration-ms") ?? numberOption(argv, "--frameDurationMs");
    const width = numberOption(argv, "--width");
    const height = numberOption(argv, "--height");
    const fps = numberOption(argv, "--fps");
    return {
      ...(sourcePath ? { sourcePath: resolveInputPath(sourcePath) } : {}),
      outDir: optionValue(argv, "--out"),
      ...(maxFrames !== undefined ? { maxFrames } : {}),
      ...(frameDurationMs !== undefined ? { frameDurationMs } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(fps !== undefined ? { fps } : {}),
      cutImportMode: optionValue(argv, "--cut-import-mode"),
      ...(hasFlag(argv, "--dry-run-render") ? { dryRunRender: true } : {}),
      createdAt: optionValue(argv, "--created-at") ?? optionValue(argv, "--createdAt")
    };
  }
  if (command === "motion.connector.template_to_cut") {
    const valuesJson = readRecord(jsonOption(argv, "--values-json"));
    const values = valuesJson ?? parseTemplateSetOptions(argv);
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out"),
      values,
      cutImportMode: optionValue(argv, "--cut-import-mode")
    };
  }
  if (command === "motion.quality.panel") {
    const manifestPath = optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest") ?? optionValue(argv, "--manifest-path");
    const inputPath = optionValue(argv, "--input") ?? optionValue(argv, "--input-path") ?? optionValue(argv, "--media") ?? optionValue(argv, "--path");
    return {
      ...(manifestPath ? { qualityManifestPath: resolveInputPath(manifestPath) } : {}),
      ...(inputPath ? { inputPath: resolveInputPath(inputPath) } : {}),
      packageRoot: debugPackageRoot(argv),
      preset: optionValue(argv, "--preset")
    };
  }
  if (command === "motion.quality.check") {
    const atMs = optionValue(argv, "--at-ms");
    const expectWidth = optionValue(argv, "--expect-width");
    const expectHeight = optionValue(argv, "--expect-height");
    const maxAudioPeakDb = optionValue(argv, "--max-audio-peak-db");
    const minAudioLoudnessLufs = optionValue(argv, "--min-audio-lufs");
    const maxAudioLoudnessLufs = optionValue(argv, "--max-audio-lufs");
    const maxAudioTruePeakDbtp = optionValue(argv, "--max-audio-true-peak-dbtp");
    const maxAudioLoudnessRangeLu = optionValue(argv, "--max-audio-lra-lu");
    const minBrightPixels = optionValue(argv, "--min-bright-pixels");
    const minEdgePixels = optionValue(argv, "--min-edge-pixels");
    const minTransparentPixels = optionValue(argv, "--min-transparent-pixels");
    const minNonTransparentPixels = optionValue(argv, "--min-non-transparent-pixels");
    const maxChangedPixels = optionValue(argv, "--max-changed-pixels");
    const maxMeanDiff = optionValue(argv, "--max-mean-diff");
    const minPsnrDb = optionValue(argv, "--min-psnr-db");
    const minSsim = optionValue(argv, "--min-ssim");
    return {
      inputPath: optionValue(argv, "--input") ?? optionValue(argv, "--input-path") ?? optionValue(argv, "--media") ?? optionValue(argv, "--path"),
      manifestPath: optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest"),
      framePath: optionValue(argv, "--frame") ?? optionValue(argv, "--frame-path"),
      baselinePath: optionValue(argv, "--baseline") ?? optionValue(argv, "--baseline-path"),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--out-dir"),
      packageId: optionValue(argv, "--package-id"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      ...(expectWidth !== undefined ? { expectWidth: Number(expectWidth) } : {}),
      ...(expectHeight !== undefined ? { expectHeight: Number(expectHeight) } : {}),
      ...(maxAudioPeakDb !== undefined ? { maxAudioPeakDb: Number(maxAudioPeakDb) } : {}),
      ...(minAudioLoudnessLufs !== undefined ? { minAudioLoudnessLufs: Number(minAudioLoudnessLufs) } : {}),
      ...(maxAudioLoudnessLufs !== undefined ? { maxAudioLoudnessLufs: Number(maxAudioLoudnessLufs) } : {}),
      ...(maxAudioTruePeakDbtp !== undefined ? { maxAudioTruePeakDbtp: Number(maxAudioTruePeakDbtp) } : {}),
      ...(maxAudioLoudnessRangeLu !== undefined ? { maxAudioLoudnessRangeLu: Number(maxAudioLoudnessRangeLu) } : {}),
      ...(minBrightPixels !== undefined ? { minBrightPixels: Number(minBrightPixels) } : {}),
      ...(minEdgePixels !== undefined ? { minEdgePixels: Number(minEdgePixels) } : {}),
      ...(minTransparentPixels !== undefined ? { minTransparentPixels: Number(minTransparentPixels) } : {}),
      ...(minNonTransparentPixels !== undefined ? { minNonTransparentPixels: Number(minNonTransparentPixels) } : {}),
      ...(atMs !== undefined ? { atMs: Number(atMs) } : {}),
      ...(maxChangedPixels !== undefined ? { maxChangedPixels: Number(maxChangedPixels) } : {}),
      ...(maxMeanDiff !== undefined ? { maxMeanDiff: Number(maxMeanDiff) } : {}),
      ...(minPsnrDb !== undefined ? { minPsnrDb: Number(minPsnrDb) } : {}),
      ...(minSsim !== undefined ? { minSsim: Number(minSsim) } : {}),
      ...(hasFlag(argv, "--expect-audio") ? { expectAudio: true } : {})
    };
  }
  if (command === "motion.render.status" || command === "motion.render.queue") {
    return { receiptsRoot: optionValue(argv, "--receipts-root") };
  }
  if (command === "motion.render.cancel" || command === "motion.render.retry") {
    return {
      receiptsRoot: optionValue(argv, "--receipts-root"),
      receiptId: optionValue(argv, "--receipt-id") ?? optionValue(argv, "--id"),
      reason: optionValue(argv, "--reason")
    };
  }
  if (command === "motion.packages.browse") {
    const packageRoots = [
      ...optionValues(argv, "--package-root"),
      ...optionValues(argv, "--package")
    ].map(resolveInputPath);
    const packagesRoot = optionValue(argv, "--packages-root") ?? optionValue(argv, "--package-browser-root") ?? optionValue(argv, "--root");
    return {
      ...(packageRoots.length > 0 ? { packageRoots } : {}),
      ...(packagesRoot ? { packagesRoot: resolveInputPath(packagesRoot) } : {})
    };
  }
  if (command === "motion.package.patch") {
    const patchJson = optionValue(argv, "--patch-json");
    const patchFile = optionValue(argv, "--patch-file");
    const patch = patchJson
      ? JSON.parse(patchJson)
      : patchFile
        ? JSON.parse(await readFile(resolveInputPath(patchFile), "utf8"))
        : undefined;
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      patch
    };
  }
  if (command === "motion.package.asset.import") return debugPackageAssetImportArgs(argv, debugPackageRoot, optionValue); if (command === "motion.revision.transaction") return revisionTransactionDebugArgs(argv, debugPackageRoot(argv), optionValue);
  if (command === "motion.revision.transaction.plan") return revisionTransactionPlanDebugArgs(argv, debugPackageRoot(argv), optionValue);
  if (command === "motion.timeline.playhead.set") {
    const atMs = optionValue(argv, "--at-ms") ?? optionValue(argv, "--playhead-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      atMs: Number(atMs)
    };
  }
  if (command === "motion.timeline.range.select") {
    return {
      packageRoot: debugPackageRoot(argv),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      startMs: Number(optionValue(argv, "--start-ms")),
      endMs: Number(optionValue(argv, "--end-ms"))
    };
  }
  if (command === "motion.timeline.viewport.set") {
    const zoom = optionValue(argv, "--zoom");
    const pixelsPerSecond = optionValue(argv, "--pixels-per-second") ?? optionValue(argv, "--pps");
    return {
      packageRoot: debugPackageRoot(argv),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      startMs: Number(optionValue(argv, "--start-ms")),
      endMs: Number(optionValue(argv, "--end-ms")),
      ...(zoom !== undefined ? { zoom: Number(zoom) } : {}),
      ...(pixelsPerSecond !== undefined ? { pixelsPerSecond: Number(pixelsPerSecond) } : {})
    };
  }
  if (command === "motion.timeline.panel" || command === "motion.timeline.duration.policy") {
    return {
      packageRoot: debugPackageRoot(argv)
    };
  }
  if (command === "motion.timeline.keyframes.panel") {
    return {
      packageRoot: debugPackageRoot(argv),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      ...(hasFlag(argv, "--include-empty") ? { includeEmpty: true } : {})
    };
  }
  if (command === "motion.timeline.transitions.panel") {
    return {
      packageRoot: debugPackageRoot(argv),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      edge: optionValue(argv, "--edge"),
      ...(hasFlag(argv, "--include-empty") ? { includeEmpty: true } : {})
    };
  }
  if (command === "motion.timeline.easing.panel") {
    const sampleCount = optionValue(argv, "--sample-count") ?? optionValue(argv, "--sampleCount");
    return {
      packageRoot: debugPackageRoot(argv),
      ...(sampleCount !== undefined ? { sampleCount: Number(sampleCount) } : {})
    };
  }
  if (command === "motion.timeline.inspect") {
    return {
      packageRoot: debugPackageRoot(argv)
    };
  }
  if (command === "motion.timeline.duration.policy.set") {
    const policyJson = optionValue(argv, "--policy-json");
    const policyFile = optionValue(argv, "--policy-file");
    const policy = policyJson
      ? JSON.parse(policyJson)
      : policyFile
        ? JSON.parse(await readFile(resolveInputPath(policyFile), "utf8"))
        : undefined;
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      policy
    };
  }
  if (command === "motion.timeline.keyframe.upsert") {
    const value = optionValue(argv, "--value");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      atMs: Number(optionValue(argv, "--at-ms")),
      value: parseKeyframeValueOption(value),
      easing: optionValue(argv, "--easing")
    };
  }
  const modularArgs = await modularDebugArgs(command, argv, debugPackageRoot(argv));
  if (modularArgs) return modularArgs;
  if (command === "motion.timeline.marker.upsert") {
    const durationMs = optionValue(argv, "--duration-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      id: optionValue(argv, "--id") ?? optionValue(argv, "--marker-id"),
      atMs: Number(optionValue(argv, "--at-ms")),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      label: optionValue(argv, "--label"),
      type: optionValue(argv, "--type"),
      color: optionValue(argv, "--color"),
      sceneId: optionValue(argv, "--scene") ?? optionValue(argv, "--scene-id")
    };
  }
  if (command === "motion.timeline.marker.delete") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      id: optionValue(argv, "--id") ?? optionValue(argv, "--marker-id")
    };
  }
  if (command === "motion.timeline.scene.resize") {
    const ripple = optionValue(argv, "--ripple");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      sceneId: optionValue(argv, "--scene") ?? optionValue(argv, "--scene-id"),
      durationMs: Number(optionValue(argv, "--duration-ms")),
      ...(ripple !== undefined ? { ripple: parseBooleanOption(ripple) } : {})
    };
  }
  if (command === "motion.timeline.scene.create") {
    const index = optionValue(argv, "--index");
    const layerIds = [
      ...optionValues(argv, "--layer"),
      ...optionValues(argv, "--layer-id")
    ];
    const trackIds = [
      ...optionValues(argv, "--track"),
      ...optionValues(argv, "--track-id")
    ];
    const markerIds = [
      ...optionValues(argv, "--marker"),
      ...optionValues(argv, "--marker-id")
    ];
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      sceneId: optionValue(argv, "--scene") ?? optionValue(argv, "--scene-id") ?? optionValue(argv, "--id"),
      name: optionValue(argv, "--name") ?? optionValue(argv, "--scene-name"),
      startMs: Number(optionValue(argv, "--start-ms")),
      durationMs: Number(optionValue(argv, "--duration-ms")),
      ...(index !== undefined ? { index: Number(index) } : {}),
      ...(layerIds.length > 0 ? { layerIds } : {}),
      ...(trackIds.length > 0 ? { trackIds } : {}),
      ...(markerIds.length > 0 ? { markerIds } : {})
    };
  }
  if (command === "motion.timeline.scene.delete") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      sceneId: optionValue(argv, "--scene") ?? optionValue(argv, "--scene-id") ?? optionValue(argv, "--id")
    };
  }
  if (command === "motion.timeline.scene.reorder") {
    const index = optionValue(argv, "--index");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      sceneId: optionValue(argv, "--scene") ?? optionValue(argv, "--scene-id") ?? optionValue(argv, "--id"),
      ...(index !== undefined ? { index: Number(index) } : {})
    };
  }
  if (command === "motion.timeline.scene.name.set") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      sceneId: optionValue(argv, "--scene") ?? optionValue(argv, "--scene-id"),
      name: optionValue(argv, "--name") ?? optionValue(argv, "--scene-name") ?? optionValue(argv, "--value")
    };
  }
  if (command === "motion.timeline.keyframe.delete") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      atMs: Number(optionValue(argv, "--at-ms"))
    };
  }
  if (command === "motion.timeline.keyframe.range.delete") {
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.keyframe.move") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      fromMs: Number(optionValue(argv, "--from-ms")),
      toMs: Number(optionValue(argv, "--to-ms"))
    };
  }
  if (command === "motion.timeline.keyframe.easing.apply") {
    const atMs = optionValue(argv, "--at-ms");
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      easing: optionValue(argv, "--easing"),
      ...(atMs !== undefined ? { atMs: Number(atMs) } : {}),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.keyframe.shift") {
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      deltaMs: Number(optionValue(argv, "--delta-ms")),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.keyframe.scale") {
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      scale: Number(optionValue(argv, "--scale")),
      originMs: Number(optionValue(argv, "--origin-ms")),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.keyframe.duplicate") {
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      deltaMs: Number(optionValue(argv, "--delta-ms")),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.keyframe.distribute" || command === "motion.timeline.keyframe.reverse") {
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.keyframe.snap") {
    const fps = optionValue(argv, "--fps");
    const startMs = optionValue(argv, "--start-ms");
    const endMs = optionValue(argv, "--end-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      target: optionValue(argv, "--target"),
      ...(fps !== undefined ? { fps: Number(fps) } : {}),
      mode: optionValue(argv, "--mode"),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(endMs !== undefined ? { endMs: Number(endMs) } : {})
    };
  }
  if (command === "motion.timeline.easing.presets") {
    return {};
  }
  if (command === "motion.timeline.animation.presets") {
    return {};
  }
  if (command === "motion.timeline.animation.preset.apply") {
    const startMs = optionValue(argv, "--start-ms");
    const durationMs = optionValue(argv, "--duration-ms");
    const distancePx = optionValue(argv, "--distance-px");
    const staggerMs = optionValue(argv, "--stagger-ms");
    const repeatedLayerIds = [
      ...optionValues(argv, "--layer"),
      ...optionValues(argv, "--layer-id")
    ];
    const explicitLayerIds = [
      ...commaListOption(argv, "--layers"),
      ...commaListOption(argv, "--layer-ids")
    ];
    const layerIds = explicitLayerIds.length > 0 || repeatedLayerIds.length > 1
      ? [...repeatedLayerIds, ...explicitLayerIds]
      : [];
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      ...(layerIds.length > 0 ? { layerIds } : { layerId: repeatedLayerIds[0] }),
      preset: optionValue(argv, "--preset"),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      ...(distancePx !== undefined ? { distancePx: Number(distancePx) } : {}),
      ...(staggerMs !== undefined ? { staggerMs: Number(staggerMs) } : {}),
      easing: optionValue(argv, "--easing")
    };
  }
  if (command === "motion.timeline.layer.trim") {
    const startMs = optionValue(argv, "--start-ms");
    const durationMs = optionValue(argv, "--duration-ms");
    const trimStartMs = optionValue(argv, "--trim-start-ms");
    const trimDurationMs = optionValue(argv, "--trim-duration-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      ...(trimStartMs !== undefined ? { trimStartMs: Number(trimStartMs) } : {}),
      ...(trimDurationMs !== undefined ? { trimDurationMs: Number(trimDurationMs) } : {})
    };
  }
  if (command === "motion.timeline.layer.create") {
    const startMs = optionValue(argv, "--start-ms");
    const durationMs = optionValue(argv, "--duration-ms");
    const index = optionValue(argv, "--index");
    const trackIndex = optionValue(argv, "--track-index");
    const fontSize = optionValue(argv, "--font-size");
    const width = optionValue(argv, "--width");
    const height = optionValue(argv, "--height");
    const layer = readRecord(jsonOption(argv, "--layer-json"));
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      ...(layer ? { layer } : {}),
      layerId: optionValue(argv, "--layer-id") ?? optionValue(argv, "--layer"),
      type: optionValue(argv, "--type"),
      text: optionValue(argv, "--text"),
      shape: optionValue(argv, "--shape"),
      fill: optionValue(argv, "--fill"),
      color: optionValue(argv, "--color"),
      source: optionValue(argv, "--source"),
      src: optionValue(argv, "--src"),
      assetId: optionValue(argv, "--asset-id"),
      assetRef: optionValue(argv, "--asset-ref"),
      trackId: optionValue(argv, "--track-id") ?? optionValue(argv, "--track"),
      ...(startMs !== undefined ? { startMs: Number(startMs) } : {}),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      ...(index !== undefined ? { index: Number(index) } : {}),
      ...(trackIndex !== undefined ? { trackIndex: Number(trackIndex) } : {}),
      ...(fontSize !== undefined ? { fontSize: Number(fontSize) } : {}),
      ...(width !== undefined ? { width: Number(width) } : {}),
      ...(height !== undefined ? { height: Number(height) } : {})
    };
  }
  if (command === "motion.timeline.layer.split") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      atMs: Number(optionValue(argv, "--at-ms")),
      newLayerId: optionValue(argv, "--new-layer-id") ?? optionValue(argv, "--new-layer")
    };
  }
  if (command === "motion.timeline.layer.text.set") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      text: optionValue(argv, "--text") ?? optionValue(argv, "--value")
    };
  }
  if (command === "motion.timeline.layer.style.set") {
    const property = optionValue(argv, "--property") ?? optionValue(argv, "--style-property") ?? optionValue(argv, "--style");
    const value = optionValue(argv, "--value") ?? optionValue(argv, "--style-value");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      property,
      value: parseStyleValueOption(property, value)
    };
  }
  if (command === "motion.timeline.layer.transform.set") {
    const property = optionValue(argv, "--property") ?? optionValue(argv, "--transform-property") ?? optionValue(argv, "--transform");
    const value = optionValue(argv, "--value") ?? optionValue(argv, "--transform-value");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      property,
      value: parseTransformValueOption(property, value)
    };
  }
  if (command === "motion.timeline.layer.effect.set") {
    const property = optionValue(argv, "--property") ?? optionValue(argv, "--effect-property") ?? optionValue(argv, "--effect");
    const value = optionValue(argv, "--value") ?? optionValue(argv, "--effect-value");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      property,
      value: parseEffectValueOption(property, value)
    };
  }
  if (command === "motion.timeline.layer.rich.set") {
    const property = optionValue(argv, "--property") ?? optionValue(argv, "--path") ?? optionValue(argv, "--rich-path");
    const value = optionValue(argv, "--value") ?? optionValue(argv, "--rich-value");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      property,
      value: parseRichValueOption(value, jsonOption(argv, "--value-json"))
    };
  }
  if (command === "motion.timeline.layer.blend.set") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      blendMode: optionValue(argv, "--blend-mode") ?? optionValue(argv, "--mode") ?? optionValue(argv, "--value")
    };
  }
  if (command === "motion.timeline.layer.crop.set") {
    const x = optionValue(argv, "--x") ?? optionValue(argv, "--crop-x");
    const y = optionValue(argv, "--y") ?? optionValue(argv, "--crop-y");
    const width = optionValue(argv, "--width") ?? optionValue(argv, "--crop-width");
    const height = optionValue(argv, "--height") ?? optionValue(argv, "--crop-height");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      x: x !== undefined ? Number(x) : undefined,
      y: y !== undefined ? Number(y) : undefined,
      width: width !== undefined ? Number(width) : undefined,
      height: height !== undefined ? Number(height) : undefined
    };
  }
  if (command === "motion.timeline.layer.mask.set") {
    const top = optionValue(argv, "--top") ?? optionValue(argv, "--inset-top");
    const right = optionValue(argv, "--right") ?? optionValue(argv, "--inset-right");
    const bottom = optionValue(argv, "--bottom") ?? optionValue(argv, "--inset-bottom");
    const left = optionValue(argv, "--left") ?? optionValue(argv, "--inset-left");
    const radius = optionValue(argv, "--radius") ?? optionValue(argv, "--mask-radius");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      type: optionValue(argv, "--type") ?? optionValue(argv, "--mask-type"),
      top: top !== undefined ? Number(top) : undefined,
      right: right !== undefined ? Number(right) : undefined,
      bottom: bottom !== undefined ? Number(bottom) : undefined,
      left: left !== undefined ? Number(left) : undefined,
      radius: radius !== undefined ? Number(radius) : undefined
    };
  }
  if (command === "motion.timeline.layer.fit.set") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      fit: optionValue(argv, "--fit") ?? optionValue(argv, "--value") ?? optionValue(argv, "--mode")
    };
  }
  if (command === "motion.timeline.layer.media.set") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      source: optionValue(argv, "--source") ?? optionValue(argv, "--asset-ref") ?? optionValue(argv, "--src") ?? optionValue(argv, "--ref")
    };
  }
  if (command === "motion.timeline.layer.name.set") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      name: optionValue(argv, "--name") ?? optionValue(argv, "--layer-name") ?? optionValue(argv, "--value")
    };
  }
  if (command === "motion.timeline.layer.visibility.set") {
    const visible = optionValue(argv, "--visible");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      ...(visible !== undefined ? { visible: parseStrictBooleanOption(visible) } : {})
    };
  }
  if (command === "motion.timeline.layer.lock") {
    const locked = optionValue(argv, "--locked");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      ...(locked !== undefined ? { locked: parseStrictBooleanOption(locked) } : {})
    };
  }
  if (command === "motion.timeline.layer.delete") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id")
    };
  }
  if (command === "motion.timeline.layer.duplicate") {
    const offsetMs = optionValue(argv, "--offset-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      newLayerId: optionValue(argv, "--new-layer-id") ?? optionValue(argv, "--new-layer"),
      ...(offsetMs !== undefined ? { offsetMs: Number(offsetMs) } : {})
    };
  }
  if (command === "motion.timeline.layer.reorder") {
    const index = optionValue(argv, "--index");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      ...(index !== undefined ? { index: Number(index) } : {})
    };
  }
  if (command === "motion.timeline.cleanup") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by")
    };
  }
  if (command === "motion.timeline.track.create") {
    const index = optionValue(argv, "--index");
    const order = optionValue(argv, "--order");
    const volume = optionValue(argv, "--volume");
    const pan = optionValue(argv, "--pan");
    const fadeInMs = optionValue(argv, "--fade-in-ms");
    const fadeOutMs = optionValue(argv, "--fade-out-ms");
    const layerIds = trackCreateLayerOptions(argv);
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      type: optionValue(argv, "--type"),
      name: optionValue(argv, "--name"),
      ...(layerIds.length > 0 ? { layerIds } : {}),
      ...(index !== undefined ? { index: Number(index) } : {}),
      ...(order !== undefined ? { order: Number(order) } : {}),
      ...(volume !== undefined ? { volume: Number(volume) } : {}),
      ...(pan !== undefined ? { pan: Number(pan) } : {}),
      ...(fadeInMs !== undefined ? { fadeInMs: Number(fadeInMs) } : {}),
      ...(fadeOutMs !== undefined ? { fadeOutMs: Number(fadeOutMs) } : {})
    };
  }
  if (command === "motion.timeline.track.reorder") {
    const index = optionValue(argv, "--index");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(index !== undefined ? { index: Number(index) } : {})
    };
  }
  if (command === "motion.timeline.track.delete") {
    const detachLayers = optionValue(argv, "--detach-layers") ?? optionValue(argv, "--detachLayers");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(detachLayers !== undefined ? { detachLayers: parseStrictBooleanOption(detachLayers) } : {})
    };
  }
  if (command === "motion.timeline.track.rename") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      name: optionValue(argv, "--name") ?? optionValue(argv, "--track-name")
    };
  }
  if (command === "motion.timeline.track.lock") {
    const locked = optionValue(argv, "--locked");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(locked !== undefined ? { locked: parseStrictBooleanOption(locked) } : {})
    };
  }
  if (command === "motion.timeline.track.mute") {
    const muted = optionValue(argv, "--muted");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(muted !== undefined ? { muted: parseStrictBooleanOption(muted) } : {})
    };
  }
  if (command === "motion.timeline.track.solo") {
    const solo = optionValue(argv, "--solo");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(solo !== undefined ? { solo: parseStrictBooleanOption(solo) } : {})
    };
  }
  if (command === "motion.timeline.track.volume") {
    const volume = optionValue(argv, "--volume");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(volume !== undefined ? { volume: Number(volume) } : {})
    };
  }
  if (command === "motion.timeline.track.fade") {
    const fadeInMs = optionValue(argv, "--fade-in-ms");
    const fadeOutMs = optionValue(argv, "--fade-out-ms");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(fadeInMs !== undefined ? { fadeInMs: Number(fadeInMs) } : {}),
      ...(fadeOutMs !== undefined ? { fadeOutMs: Number(fadeOutMs) } : {})
    };
  }
  if (command === "motion.timeline.track.pan") {
    const pan = optionValue(argv, "--pan");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(pan !== undefined ? { pan: Number(pan) } : {})
    };
  }
  if (command === "motion.timeline.layer.ducking.set") {
    const duckToVolume = optionValue(argv, "--duck-to-volume") ?? optionValue(argv, "--duckToVolume");
    const attackMs = optionValue(argv, "--attack-ms") ?? optionValue(argv, "--attackMs");
    const releaseMs = optionValue(argv, "--release-ms") ?? optionValue(argv, "--releaseMs");
    const threshold = optionValue(argv, "--threshold");
    const ratio = optionValue(argv, "--ratio");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      triggerLayerIds: layerDuckingTriggerOptions(argv),
      ...(duckToVolume !== undefined ? { duckToVolume: Number(duckToVolume) } : {}),
      ...(attackMs !== undefined ? { attackMs: Number(attackMs) } : {}),
      ...(releaseMs !== undefined ? { releaseMs: Number(releaseMs) } : {}),
      ...(optionValue(argv, "--mode") !== undefined ? { mode: optionValue(argv, "--mode") } : {}),
      ...(threshold !== undefined ? { threshold: Number(threshold) } : {}),
      ...(ratio !== undefined ? { ratio: Number(ratio) } : {})
    };
  }
  if (command === "motion.audio.master.set") {
    const master = readRecord(jsonOption(argv, "--master-json"));
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      ...(master ? { master } : {}),
      ...(hasFlag(argv, "--clear") ? { clear: true } : {})
    };
  }
  if (command === "motion.audio.crossfade.set") {
    const durationMs = optionValue(argv, "--duration-ms");
    const curve = optionValue(argv, "--curve");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      fromLayerId: optionValue(argv, "--from-layer") ?? optionValue(argv, "--from-layer-id"),
      toLayerId: optionValue(argv, "--to-layer") ?? optionValue(argv, "--to-layer-id"),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      ...(curve !== undefined ? { curve } : {})
    };
  }
  if (command === "motion.procedural.audio-envelope.produce") {
    const sampleEveryMs = optionValue(argv, "--sample-every-ms");
    const channel = optionValue(argv, "--channel");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      sourceLayerId: optionValue(argv, "--source-layer") ?? optionValue(argv, "--source-layer-id"),
      envelopeId: optionValue(argv, "--envelope-id") ?? optionValue(argv, "--id"),
      ...(sampleEveryMs !== undefined ? { sampleEveryMs: Number(sampleEveryMs) } : {}),
      ...(channel !== undefined ? { channel } : {})
    };
  }
  if (command === "motion.timeline.layer.track.assign") {
    const index = optionValue(argv, "--index");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      ...(index !== undefined ? { index: Number(index) } : {})
    };
  }
  if (command === "motion.timeline.caption.import") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      captionsPath: optionValue(argv, "--captions-file") ?? optionValue(argv, "--captions-path") ?? optionValue(argv, "--path"),
      format: optionValue(argv, "--format"),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      trackName: optionValue(argv, "--track-name"),
      layerPrefix: optionValue(argv, "--layer-prefix")
    };
  }
  if (command === "motion.timeline.caption.upsert") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      id: optionValue(argv, "--id") ?? optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      text: optionValue(argv, "--text"),
      startMs: Number(optionValue(argv, "--start-ms")),
      durationMs: Number(optionValue(argv, "--duration-ms")),
      trackId: optionValue(argv, "--track") ?? optionValue(argv, "--track-id"),
      trackName: optionValue(argv, "--track-name")
    };
  }
  const transitionArgs = timelineTransitionDebugArgs(command, argv, optionValue, debugPackageRoot);
  if (transitionArgs) return transitionArgs;
  if (command === "motion.support.bundle") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--bundle-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root")
    };
  }
  if (command === "motion.package.archive") {
    const archivePath = optionValue(argv, "--out") ?? optionValue(argv, "--archive") ?? optionValue(argv, "--archive-path");
    const receiptPath = optionValue(argv, "--receipt") ?? optionValue(argv, "--receipt-path");
    return {
      packageRoot: debugPackageRoot(argv),
      ...(archivePath ? { archivePath: resolveOutputPath(archivePath) } : {}),
      ...(receiptPath ? { receiptPath: resolveOutputPath(receiptPath) } : {})
    };
  }
  if (command === "motion.package.extract") {
    const archivePath = optionValue(argv, "--archive") ?? optionValue(argv, "--archive-path") ?? optionValue(argv, "--in");
    const packageRoot = optionValue(argv, "--out") ?? optionValue(argv, "--package-root") ?? optionValue(argv, "--package-dir");
    const receiptPath = optionValue(argv, "--receipt") ?? optionValue(argv, "--receipt-path");
    return {
      ...(archivePath ? { archivePath: resolveInputPath(archivePath) } : {}),
      ...(packageRoot ? { packageRoot: resolveOutputPath(packageRoot) } : {}),
      ...(receiptPath ? { receiptPath: resolveOutputPath(receiptPath) } : {})
    };
  }
  if (command === "motion.review.html.bundle") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--bundle-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root") ?? optionValue(argv, "--receipts"),
      title: optionValue(argv, "--title")
    };
  }
  if (command === "motion.source.import") {
    const maxChars = optionValue(argv, "--max-chars") ?? optionValue(argv, "--maxChars");
    return {
      url: optionValue(argv, "--url") ?? optionValue(argv, "--source-url"),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--out-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root") ?? optionValue(argv, "--receipts"),
      markdown: optionValue(argv, "--markdown"),
      title: optionValue(argv, "--title"),
      kind: optionValue(argv, "--kind"),
      ...(maxChars !== undefined ? { maxChars: Number(maxChars) } : {}),
      createdBy: optionValue(argv, "--created-by")
    };
  }
  if (command === "motion.source.to_scripted_video") {
    const maxFrames = optionValue(argv, "--max-frames") ?? optionValue(argv, "--maxFrames");
    const frameDurationMs = optionValue(argv, "--frame-duration-ms") ?? optionValue(argv, "--frameDurationMs");
    const width = optionValue(argv, "--width");
    const height = optionValue(argv, "--height");
    const fps = optionValue(argv, "--fps");
    return {
      sourcePath: optionValue(argv, "--source") ?? optionValue(argv, "--source-path") ?? optionValue(argv, "--sourcePath") ?? optionValue(argv, "--in"),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--out-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root") ?? optionValue(argv, "--receipts"),
      ...(maxFrames !== undefined ? { maxFrames: Number(maxFrames) } : {}),
      ...(frameDurationMs !== undefined ? { frameDurationMs: Number(frameDurationMs) } : {}),
      ...(width !== undefined ? { width: Number(width) } : {}),
      ...(height !== undefined ? { height: Number(height) } : {}),
      ...(fps !== undefined ? { fps: Number(fps) } : {}),
      createdBy: optionValue(argv, "--created-by")
    };
  }
  if (command === "motion.html.snippet.export") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--out-dir"),
      createdAt: optionValue(argv, "--created-at")
    };
  }
  if (command === "motion.html.snippet.import") {
    return {
      htmlPath: optionValue(argv, "--html") ?? optionValue(argv, "--html-path") ?? optionValue(argv, "--in"),
      packageDir: optionValue(argv, "--out") ?? optionValue(argv, "--package") ?? optionValue(argv, "--package-dir"),
      createdAt: optionValue(argv, "--created-at")
    };
  }
  if (command === "motion.otio.export") {
    return {
      packageRoot: debugPackageRoot(argv),
      outPath: optionValue(argv, "--out") ?? optionValue(argv, "--otio") ?? optionValue(argv, "--timeline"),
      createdAt: optionValue(argv, "--created-at")
    };
  }
  if (command === "motion.otio.import") {
    return {
      otioPath: optionValue(argv, "--otio") ?? optionValue(argv, "--timeline") ?? optionValue(argv, "--in"),
      packageDir: optionValue(argv, "--out") ?? optionValue(argv, "--package") ?? optionValue(argv, "--package-dir"),
      createdAt: optionValue(argv, "--created-at")
    };
  }
  if (command === "motion.template.panel") {
    return {
      packageRoot: debugPackageRoot(argv)
    };
  }
  if (command === "motion.template.controls") {
    return {
      packageRoot: debugPackageRoot(argv)
    };
  }
  if (command === "motion.template.apply") {
    const valuesJson = readRecord(jsonOption(argv, "--values-json"));
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      values: valuesJson ?? parseTemplateSetOptions(argv)
    };
  }
  if (command === "motion.template.catalog" || command === "motion.template.plan") {
    const packageRoots = [
      ...optionValues(argv, "--package-root"),
      ...optionValues(argv, "--package")
    ].map(resolveInputPath);
    const valuesJson = readRecord(jsonOption(argv, "--values-json"));
    const values = valuesJson ?? parseTemplateSetOptions(argv);
    const templateRoot = optionValue(argv, "--template-root") ?? optionValue(argv, "--templates-root") ?? optionValue(argv, "--root");
    const targetHost = optionValue(argv, "--host") ?? optionValue(argv, "--target-host");
    const targetLane = optionValue(argv, "--lane") ?? optionValue(argv, "--target-lane");
    const aspectRatio = optionValue(argv, "--aspect-ratio") ?? optionValue(argv, "--target-aspect-ratio");
    const durationMs = numberOption(argv, "--duration-ms") ?? numberOption(argv, "--target-duration-ms");
    const width = numberOption(argv, "--width") ?? numberOption(argv, "--target-width");
    const height = numberOption(argv, "--height") ?? numberOption(argv, "--target-height");
    const commercialUse = booleanOption(argv, "--commercial-use") ?? booleanOption(argv, "--target-commercial-use");
    const requiresMedia = booleanOption(argv, "--requires-media");
    const requiresAudio = booleanOption(argv, "--requires-audio");
    const outputType = optionValue(argv, "--output-type");
    const renderCost = optionValue(argv, "--render-cost");
    const designFamily = optionValue(argv, "--design-family");
    return {
      ...(packageRoots.length > 0 ? { packageRoots } : {}),
      ...(templateRoot ? { templateRoot: resolveInputPath(templateRoot) } : {}),
      ...(targetHost ? { targetHost } : {}),
      ...(targetLane ? { targetLane } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(commercialUse !== undefined ? { commercialUse } : {}),
      ...(requiresMedia !== undefined ? { requiresMedia } : {}),
      ...(requiresAudio !== undefined ? { requiresAudio } : {}),
      ...(outputType ? { outputType } : {}),
      ...(renderCost ? { renderCost } : {}),
      ...(designFamily ? { designFamily } : {}),
      ...(command === "motion.template.plan"
        ? { request: optionValue(argv, "--request") ?? optionValue(argv, "--prompt") }
        : {}),
      ...(command === "motion.template.plan" && Object.keys(values).length > 0 ? { values } : {})
    };
  }
  if (command === "motion.template.media.replace") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      paramId: optionValue(argv, "--param") ?? optionValue(argv, "--param-id"),
      assetPath: optionValue(argv, "--asset") ?? optionValue(argv, "--asset-path"),
      assetRef: optionValue(argv, "--asset-ref")
    };
  }
  return {};
}

// `debugAgentRuntime`, `fakeAgentRuntime` and `fakeAdapter` used to live here: a stubbed
// `shellx-motion-fake-agent` selected by `--adapter fake`, reporting itself ready in the same JSON a
// real probe produces. Removed with the tool-provenance invariant — scripted adapters now come from
// `packages/cli/src/main.test-support.ts` through `RunCliOptions.agentRuntime`, so the shipped
// binary cannot manufacture an agent, and a caller that wants one has to say so in code. The
// refusal for the removed flags lives in `./retired-options`.

export { normalizeWindowsExtendedPath } from "./cli-path-resolution";

function missingArgument(command: string, argument: string): CliResult {
  return {
    ok: false,
    command,
    error: {
      code: "missing_argument",
      message: `${command} requires ${argument}.`
    }
  };
}

function keepFramesFinalVideoOnlyRefusal(): CliResult {
  return {
    ok: false,
    command: "render",
    error: {
      code: "invalid_args",
      message: "--keep-frames is only supported for final-video FFmpeg renders."
    }
  };
}

async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

/**
 * Core authenticates uncertainty only after a final link or rename was attempted.  Preserve that
 * evidence for non-render delivery commands too, without assigning the render-specific primary
 * uncertainty flag to a receipt, archive, or package-directory publication.
 */
function publicationCommitUncertainCliFailure(command: string, error: unknown): CliResult | undefined {
  const fields = corePublicationUncertaintyFields(error);
  if (!fields) return undefined;
  return {
    ok: false,
    command,
    ...fields
  };
}

async function writeHostReceiptFile(receiptsRoot: string, receipt: OperationReceipt): Promise<string> {
  await mkdir(receiptsRoot, { recursive: true });
  const receiptPath = join(receiptsRoot, `${safeFileToken(receipt.id)}.receipt.json`);
  await writeJson(receiptPath, receipt);
  return receiptPath;
}

/** Entry point: run the requested command with Ctrl-C wired to real cancellation. */
async function main(): Promise<void> {
  await withInterruptSignal(async ({ signal, interrupted }) => {
    let result: CliResult;
    try {
      result = await runCli(process.argv.slice(2), { signal });
    } catch (error) {
      result = unhandledFailure(error);
    }
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    if (interrupted()) process.exitCode = SIGINT_EXIT_CODE;
  });
}

if (isDirectEntry(import.meta.url, process.argv[1])) await main();
