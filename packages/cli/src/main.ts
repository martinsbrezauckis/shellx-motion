import { existsSync, readFileSync } from "node:fs";
import { isDirectEntry } from "./entry-point.js";
import { SIGINT_EXIT_CODE, withInterruptSignal } from "./interrupt";
import { throwIfCancelled, withRenderCancellation } from "./render-cancelled";
import { nativeDeliveryRefusal, unsupportedFrameLaneMessage, unsupportedPreviewLaneMessage, unsupportedRenderLaneMessage } from "./lane-errors";
import { resolveCallerId } from "./caller-identity";
import { doctorCommand } from "./doctor-command";
import { jobCommand } from "./job-command";
import { retiredSimulationRefusal } from "./retired-options";
import { batchResumeSourceReceiptPath, readBatchResumeJobs, readBatchResumeMatch } from "./batch-resume";
import { unhandledFailure } from "./unhandled-failure";
import { packageValidationResult } from "./package-refusals";
import { withHostJob } from "./render-host-job";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findAction, guideAction, planAction, type MotionPermissionTier } from "@shellx-motion/actions";
import { planCutImport } from "@shellx-motion/adapters-cut";
import { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "@shellx-motion/adapters-html";
import { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "@shellx-motion/adapters-otio";
import { buildAgentRuntime, type AgentRuntime } from "@shellx-motion/agent-runtime";
import {
  runCanvasBridgeFrameSelectionExport,
  runCanvasToCutConnector,
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
  MotionOutputGuardError,
  createPreviewReceipt,
  audioQualityMeasurementRequired,
  evaluateAudioQuality,
  buildVisualDiffPng,
  comparePngFiles,
  expandMotionPackageRows,
  filterMotionDataRows,
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
  loadPackageDataRows,
  negotiateIntegrationCapabilities,
  parseIntegrationCapabilities,
  buildBrowserRecordingManifest,
  browserRecordingSampleTimes,
  replaceTemplateMedia,
  resolvePackageAsset,
  summarizeFrameQuality,
  applyTemplateValues,
  listTemplateControls,
  timelineLayerMutedTrackId,
  timelineLayerSoloedTrackId,
  upsertBrowserWorkflowCatalog,
  extractMotionPackageArchive,
  writeMotionPackageArchive,
  writeReviewBundle,
  type BrowserWorkflowDriftSummary,
  type AudioQualityThresholds,
  type BrowserRecordingManifest,
  type BrowserRecordingManifestFrame,
  type ExpandedMotionJob,
  type MotionDataRow,
  type NetworkAddressResolver,
  type OperationReceipt,
  type ReceiptArtifact,
  type SourceImportFetcher
} from "@shellx-motion/core";
import { annotatePlanWithArgumentContracts, dispatchDebugCommand, recordReceiptFfprobeProvenance, type BrowserFrameRenderer, type MotionDebugCommand, type ReceiptActor } from "@shellx-motion/debug-api";
import { MODULAR_DEBUG_COMMANDS, modularDebugArgs, modularDebugAuthoringRoots } from "./modular-debug-cli";
import { debugCommandName } from "./debug-subcommands";
import { debugScratchRoot } from "./debug-context-cli";
// The static `help` command catalog lives in ./help-command to satisfy the module-size gate.
import { helpCommand } from "./help-command";
// Browser-capture workflow decoding lives in ./browser-workflow-decode to satisfy the module-size gate.
import { readBrowserCaptureWorkflow } from "./browser-workflow-decode";
// Shared non-destructive output policy: `--out` directories (the output-directory ownership invariant), the encode lane's `--out` file
// (the file-output ownership invariant) and the encoder's frame scratch (the frame-output ownership invariant).
import { framesDirRefusal, outputFileRefusal, prepareOutputDir } from "./output-dir-guard";
import { FrameLaneWarnings } from "./frame-lane-warnings";
import {
  browserWorkflowDriftWarning,
  dedupeReceiptArtifacts,
  finalizeRenderReceipt,
  renderReceiptPathForOutput,
  writeRenderReceiptFile,
  type BrowserWorkflowRenderEvidence,
  type RenderReceiptFinalizeResult
} from "./render-receipt-file";
import {
  runMotionPrompt,
  type MotionPromptRuntime,
  type PromptRawRetentionPurpose,
  type PromptRetentionInput
} from "@shellx-motion/prompt";
import {
  BrowserWorkflowReplayError,
  createMotionBrowserRenderSession,
  type MotionBrowserRenderSession,
  renderMotionBrowserFrame,
  type BrowserCaptureWorkflow
} from "@shellx-motion/renderer-browser";
import {
  audioWarningsForExportPreset,
  checkFfmpeg,
  buildEncodeImageSequenceCommand,
  createImageSequenceReceipt,
  createGovernedFfmpegRunner,
  createStillFrameReceipt,
  encodeImageSequenceWithPolicy,
  ffmpegPresetOutputPathError,
  frameExtractionArgs,
  frameExtractionInputArgs,
  frameExtractionPngOutputArgs,
  readFfmpegExportPreset,
  readImageSequenceExportPreset,
  readMotionExportPreset,
  readStillFrameExportPreset,
  listMotionExportPresets,
  measureAudioLevels,
  probeMedia,
  resolveExportPreset,
  resolveMotionExportPreset,
  resolveFfmpegExecutable,
  stillFrameOutputPathError,
  type MotionExportPreset,
  type FfmpegExportPreset,
  type FfmpegCommand,
  type FfmpegProcessResult,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { createNativeRenderSession, INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL, renderNativePreviewFrame } from "@shellx-motion/renderer-native";
export type CliResult = Record<string, unknown> & { ok: boolean; command?: string };
export interface RunCliOptions {
  ffmpegRunner?: FfmpegRunner;
  promptRuntime?: MotionPromptRuntime;
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
    return previewCommand(rest);
  }
  if (command === "capture-browser") {
    return captureBrowserCommand(rest, options);
  }
  if (command === "render") {
    // One invocation, one observable job — see render-host-job.ts for why this wraps the whole
    // command rather than tagging one of the governed operations underneath it.
    return withHostJob({
      ...(optionValue(rest, "--job-id") ? { jobId: optionValue(rest, "--job-id")! } : {}),
      ...(resolveCallerId(rest, options) ? { callerId: resolveCallerId(rest, options)! } : {}),
      lane: optionValue(rest, "--lane") ?? "ffmpeg",
      operation: "render.final"
    }, () => withRenderCancellation(() => renderCommand(rest, options), {
      signal: options.signal,
      lane: optionValue(rest, "--lane") ?? "ffmpeg",
      frameLane: optionValue(rest, "--frame-lane"),
      outputPath: optionValue(rest, "--out")
    }) as Promise<CliResult>) as Promise<CliResult>;
  }
  if (command === "doctor") {
    // Answers "why does nothing work" before a render is ever attempted.
    return doctorCommand(rest) as Promise<CliResult>;
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
    return htmlSnippetImportCommand(rest);
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
    // The path ShellX Cut actually drives. `render`/`render-batch` were wrapped first and the
    // connectors were not, so --job-id and --caller-id were accepted here and bound to nothing:
    // a 50-second `connector template-to-cut` polled 60 times reported jobCount 0 every time.
    // One connector invocation is one observable job; its browser and ffmpeg work stays internal.
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

function isHelpCommand(command: string | undefined): boolean {
  return command === undefined || command === "help" || command === "--help" || command === "-h";
}

/**
 * Whether the token requests the CLI version banner. Kept as its own predicate (not folded into
 * isHelpCommand) so `--version`/`-v`/`version` return a machine-readable version payload rather than
 * the full help listing. This is the verb the Design Studio host probes with (probeMotionCli invokes
 * the resolved launcher with `--version`); without it a valid, render-capable Motion root would be
 * reported as "not found" in the Canvas Settings Motion status pill.
 */
function isVersionCommand(command: string | undefined): boolean {
  return command === "--version" || command === "-v" || command === "version";
}

/**
 * Resolve this CLI package's own version from its package.json, next to the compiled/executed entry
 * (src/main.ts → ../package.json). Read lazily + defensively: a read/parse failure degrades to
 * "0.0.0" rather than throwing, so `--version` never crashes the probe path. No side effects.
 */
function cliVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * `--version` / `-v` / `version` — emit a stable, machine-readable version banner. The `version`
 * field carries a semver-ish token (extractable by the Canvas probe's version regex) so the Canvas
 * Settings pill can render "found · <version>". ok:true so the probe (and main()'s exit code) treat
 * a version query as success, never a spurious failure.
 */
function versionCommand(): CliResult {
  return {
    ok: true,
    command: "version",
    name: "@shellx-motion/cli",
    version: cliVersion()
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
  const root = argv[0];
  if (!root) return missingArgument("validate", "package root");

  const pkg = await loadMotionPackage(resolveInputPath(root));
  // Same verdicts and warnings the Debug API and SDK answer with; see ./package-refusals.ts.
  return packageValidationResult(pkg, "validate");
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
    return { ok: true, command: "actions.find", action: findAction(request) };
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
    cautions: plan.cautions
  };
}

async function debugCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const subcommand = argv[0];
  const debugName = debugCommandName(subcommand);
  if (!debugName) {
    return {
      ok: false,
      command: "debug",
      error: { code: "unknown_subcommand", message: `Unknown debug subcommand: ${subcommand ?? "(missing)"}.` }
    };
  }
  const tier = readCliTier(argv, "read_motion", options);
  if (!tier.ok) return { ok: false, command: `debug.${subcommand}`, error: tier.error, warnings: [] };

  let args: unknown;
  try {
    args = await debugArgs(debugName, argv);
  } catch (error) {
    return {
      ok: false,
      command: `debug.${subcommand}`,
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  const scratchRoot = debugScratchRoot(debugName, args, options.scratchRoot);
  const authoringRoots = modularDebugAuthoringRoots(debugName, args);
  // Runtimes are supplied by the embedding host, never selected by a command-line flag. `--fake`
  // used to construct a stubbed agent here, so `debug motion.prompt.run --fake` returned a receipt
  // pair no consumer could tell from a real agent run.
  const promptRuntime = debugName === "motion.prompt.run" ? options.promptRuntime : undefined;
  const agentRuntime = debugName === "motion.agent.health" ? options.agentRuntime : undefined;
  const debugArgumentRecord = readRecord(args);
  const cliReceiptsRoot = typeof debugArgumentRecord?.receiptsRoot === "string"
    ? debugArgumentRecord.receiptsRoot
    : undefined;
  const result = await dispatchDebugCommand(debugName, args, {
    tier: tier.tier,
    // The CLI is the observed transport; stamp cli + tier (+ optional --actor/env label) so History
    // attributes command-line operations. A per-command createdBy still wins for the label.
    actor: readCliActor(argv, tier.tier),
    // A receipts root the OPERATOR typed on the command line is nominated by the host, because on
    // this surface the operator IS the host. The receipts fence exists to stop a Debug API caller --
    // which reaches Motion across a privilege boundary -- naming somewhere Motion then writes to.
    // Someone at a shell has no such boundary to cross: they could create the file directly, so
    // refusing their own `--receipts-root` would be configuration without a boundary.
    //
    // Same reasoning the Cut-root policy already encodes, where `undefined` trusted roots means "this
    // caller has no privilege boundary to defend" and is documented as being for the CLI.
    ...(scratchRoot
      ? { scratchRoot }
      : cliReceiptsRoot
        ? { scratchRoot: cliReceiptsRoot }
        : {}),
    ...(authoringRoots ? { authoringInputRoots: authoringRoots.inputRoots } : {}),
    ...(authoringRoots ? { authoringOutputRoots: authoringRoots.outputRoots } : {}),
    ...(promptRuntime ? { promptRuntime } : {}),
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(options.ffmpegRunner ? { ffmpegRunner: options.ffmpegRunner } : {}),
    ...(options.browserFrameRenderer ? { browserFrameRenderer: options.browserFrameRenderer } : {}),
    ...(options.sourceFetcher ? { sourceFetcher: options.sourceFetcher } : {}),
    ...(options.sourceResolver ? { sourceResolver: options.sourceResolver } : {})
  });
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
    await cp(packageRoot, outDir, { recursive: true });
    const copiedAssetPath = resolvePackageAsset({ root: outDir }, replaced.assetRef);
    await mkdir(dirname(copiedAssetPath), { recursive: true });
    await copyFile(sourceAssetPath, copiedAssetPath);
    await writeJson(join(outDir, "manifest.json"), replaced.manifest);
    await writeJson(join(outDir, pkg.manifest.motion), replaced.motion);
    const receiptsRoot = join(outDir, "receipts");
    await mkdir(receiptsRoot, { recursive: true });
    const receiptPath = join(receiptsRoot, "template-media-replace.receipt.json");
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
    await writeJson(receiptPath, receipt);

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
  await cp(packageRoot, outDir, { recursive: true });
  await writeJson(join(outDir, pkg.manifest.motion), applied.motion);
  const receiptsRoot = join(outDir, "receipts");
  await mkdir(receiptsRoot, { recursive: true });
  const receiptPath = join(receiptsRoot, "template-apply.receipt.json");
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
  await writeJson(receiptPath, receipt);

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
  const promptRuntime = options.promptRuntime;
  const retention = promptRetentionFromCli(argv);
  if (!retention.ok) return { ok: false, command: "prompt.run", error: retention.error, warnings: [] };

  if (executeAgentCommands) {
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
      ...(promptRuntime ? { promptRuntime } : {}),
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

  const result = await runMotionPrompt({
    request,
    tier: tier.tier,
    agentId,
    packageId,
    cwd,
    runtime: promptRuntime,
    retention: retention.value
  });

  const receiptPaths = result.ok && receiptsRoot
    ? [
        await writeHostReceiptFile(receiptsRoot, result.agent.receipt),
        await writeHostReceiptFile(receiptsRoot, result.receipt)
      ]
    : result.receipt && receiptsRoot
      ? [await writeHostReceiptFile(receiptsRoot, result.receipt)]
      : [];

  return result.ok
    ? {
        ok: true,
        command: "prompt.run",
        actionId: result.plan.action?.id ?? null,
        receipts: [result.agent.receipt.id, result.receipt.id],
        ...(receiptPaths.length > 0 ? { receiptPaths } : {}),
        debugCommands: result.receipt.output.debugCommands,
        promptRetention: result.receipt.output.promptRetention
      }
    : {
        ok: false,
        command: "prompt.run",
        error: result.error,
        receipts: result.receipt ? [result.receipt.id] : [],
        ...(receiptPaths.length > 0 ? { receiptPaths } : {})
      };
}

async function previewCommand(argv: string[]): Promise<CliResult> {
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
  if (lane !== "native" && lane !== "browser") {
    return { ok: false, command: "preview", error: { code: "unsupported_lane", message: unsupportedPreviewLaneMessage(lane) } };
  }
  const atMs = Number(optionValue(argv, "--at-ms") ?? 0);
  if (!Number.isFinite(atMs) || atMs < 0) {
    return { ok: false, command: "preview", error: { code: "invalid_args", message: "--at-ms must be a non-negative finite number." } };
  }
  const pkg = await loadMotionPackage(resolveInputPath(root));
  const outputDir = resolveOutputPath(outDir);
  await mkdir(outputDir, { recursive: true });

  if (lane === "browser") {
    const result = await renderMotionBrowserFrame(pkg, { atMs, outDir: outputDir });
    const receiptPath = join(outputDir, `${pkg.manifest.id}-browser-preview.receipt.json`);
    await writeJson(receiptPath, result.receipt);
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

  const previewPath = join(outputDir, `${pkg.manifest.id}-native-${atMs}.png`);
  const receiptPath = join(outputDir, `${pkg.manifest.id}-native-preview.receipt.json`);
  const result = await renderNativePreviewFrame({
    packageRoot: resolveInputPath(root),
    outputPath: previewPath,
    outputRoots: [outputDir],
    atMs
  });
  await writeJson(receiptPath, result.receipt);
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
      path: result.frame.path,
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

async function captureBrowserCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const callerIdForRun = resolveCallerId(argv, options);
  const root = argv[0];
  if (!root) return missingArgument("capture-browser", "package root");
  const outDir = optionValue(argv, "--out");
  if (!outDir) return missingArgument("capture-browser", "--out");

  const pkg = await loadMotionPackage(resolveInputPath(root));
  const outputDir = resolveOutputPath(outDir);
  const workflowPath = optionValue(argv, "--workflow");
  const workflow = workflowPath ? await readBrowserCaptureWorkflow(resolveInputPath(workflowPath)) : undefined;
  const workflowCatalogPath = optionValue(argv, "--catalog") ?? optionValue(argv, "--workflow-catalog") ?? optionValue(argv, "--workflow-catalog-path");
  const failOnDrift = hasFlag(argv, "--fail-on-drift");
  const recordingManifestRef = optionValue(argv, "--recording-manifest") ?? optionValue(argv, "--recording-manifest-path");
  const recordingManifestPath = recordingManifestRef ? resolveOutputPath(recordingManifestRef) : undefined;
  const recordingFramesDir = recordingManifestPath
    ? resolveOutputPath(optionValue(argv, "--recording-frames-dir") ?? join(outputDir, "browser-recording-frames"))
    : undefined;
  const recordingSampleCountOption = readPositiveIntegerOption(
    optionValue(argv, "--recording-samples") ?? optionValue(argv, "--recording-sample-count"),
    "--recording-samples",
    3
  );
  if (!recordingSampleCountOption.ok) return recordingSampleCountOption.result;
  await mkdir(outputDir, { recursive: true });
  const session = options.browserFrameRenderer ? undefined : await createMotionBrowserRenderSession(pkg, callerIdForRun ? { callerId: callerIdForRun } : {});
  const renderer: BrowserFrameRenderer = options.browserFrameRenderer
    ?? ((_pkg, frameOptions) => session!.renderFrame(frameOptions));
  try {
    let result: Awaited<ReturnType<typeof renderMotionBrowserFrame>>;
    try {
      result = await renderer(pkg, {
        atMs: Number(optionValue(argv, "--at-ms") ?? 0),
        outDir: outputDir,
        workflow
      });
    } catch (error) {
      if (error instanceof BrowserWorkflowReplayError) {
        return writeBrowserWorkflowReplayFailureResult({
          pkg,
          outputDir,
          workflowPath: workflowPath ? resolveInputPath(workflowPath) : undefined,
          error
        });
      }
      throw error;
    }
    result.receipt.operation = "browser.workflow.capture";
  const workflowTracePath = result.output.workflowTrace
    ? join(outputDir, `${pkg.manifest.id}-browser-workflow.trace.json`)
    : undefined;
  if (workflowTracePath && result.output.workflowTrace) {
    await writeJson(workflowTracePath, result.output.workflowTrace);
    result.output.workflowTracePath = workflowTracePath;
  }
  const receiptPath = join(outputDir, `${pkg.manifest.id}-browser-capture.receipt.json`);
  const workflowCatalog = workflowCatalogPath
    ? await upsertBrowserWorkflowCatalog({
        catalogPath: resolveOutputPath(workflowCatalogPath),
        capture: {
          packageId: pkg.manifest.id,
          workflowHash: result.output.workflowTrace?.workflowHash ?? String(result.receipt.inputHashes.workflow ?? ""),
          atMs: result.output.atMs,
          outputSha256: result.output.sha256,
          outputPath: result.output.path,
          receiptPath,
          ...(workflowTracePath ? { tracePath: workflowTracePath } : {}),
          createdAt: result.receipt.createdAt,
          browser: result.output.browser,
          viewport: result.output.viewport,
          workflow: {
            stepCount: result.output.workflow?.stepCount ?? 0,
            networkPolicy: result.output.workflow?.networkPolicy ?? workflow?.networkPolicy ?? "blocked-unless-declared"
          }
        }
      })
    : undefined;
  if (workflowCatalog) {
    result.output.workflowCatalogPath = workflowCatalog.catalogPath;
    result.output.workflowDrift = workflowCatalog.drift;
    if (workflowCatalog.drift.status === "changed") {
      result.receipt.warnings.push(browserWorkflowDriftWarning(workflowCatalog.drift));
    }
  }
  let recordingManifest: BrowserRecordingManifest | undefined;
  if (recordingManifestPath && recordingFramesDir) {
    recordingManifest = await writeBrowserRecordingManifest({
      pkg,
      renderer,
      workflow,
      framesDir: recordingFramesDir,
      manifestPath: recordingManifestPath,
      sampleCount: recordingSampleCountOption.value ?? 3,
      primaryCapture: result,
      ...(workflowTracePath ? { workflowTracePath } : {}),
      ...(workflowCatalog ? { workflowCatalogPath: workflowCatalog.catalogPath } : {})
    });
    const output = result.output as typeof result.output & {
      recordingManifestPath?: string;
      recordingManifest?: BrowserRecordingManifest;
    };
    output.recordingManifestPath = recordingManifestPath;
    output.recordingManifest = recordingManifest;
  }
  const artifacts: ReceiptArtifact[] = [
    { role: "preview_frame", path: result.output.path, status: "available", mediaType: "image/png", primary: true }
  ];
  if (workflowTracePath) {
    artifacts.push({ role: "browser_workflow_trace", path: workflowTracePath, status: "available", mediaType: "application/json" });
  }
  if (workflowCatalog) {
    artifacts.push({ role: "browser_workflow_catalog", path: workflowCatalog.catalogPath, status: "available", mediaType: "application/json" });
  }
  if (recordingManifestPath) {
    artifacts.push({ role: "browser_recording_manifest", path: recordingManifestPath, status: "available", mediaType: "application/json" });
  }
  artifacts.push({ role: "preview_receipt", path: receiptPath, status: "available" });
  result.output.artifacts = artifacts;
  result.receipt.artifacts = artifacts;
  result.receipt.output = result.output;
  await writeJson(receiptPath, result.receipt);
  if (workflowCatalog?.drift.status === "changed" && failOnDrift) {
    return {
      ok: false,
      command: "capture-browser",
      lane: "browser",
      workflowCatalogPath: workflowCatalog.catalogPath,
      workflowDrift: workflowCatalog.drift,
      output: result.output,
      outputPath: result.output.path,
      receiptId: result.receipt.id,
      receiptPath,
      artifacts,
      warnings: result.receipt.warnings,
      error: {
        code: "browser_workflow_drift_detected",
        message: browserWorkflowDriftWarning(workflowCatalog.drift)
      }
    };
  }
    return {
      ok: true,
      command: "capture-browser",
      lane: "browser",
      deterministic: {
        network: workflow?.networkPolicy ?? "blocked-unless-declared",
        animations: "disabled",
        caret: "hide",
        deviceScaleFactor: result.output.viewport.deviceScaleFactor
      },
      ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}),
      ...(result.output.workflow ? { workflow: result.output.workflow } : {}),
      ...(workflowTracePath ? { workflowTracePath } : {}),
      ...(workflowCatalog ? { workflowCatalogPath: workflowCatalog.catalogPath, workflowDrift: workflowCatalog.drift } : {}),
      ...(recordingManifest ? { recordingManifestPath, recordingManifest } : {}),
      artifacts,
      output: result.output,
      outputPath: result.output.path,
      receiptId: result.receipt.id,
      receiptPath,
      warnings: result.receipt.warnings
    };
  } finally {
    await session?.close();
  }
}

async function writeBrowserWorkflowReplayFailureResult(input: {
  pkg: Awaited<ReturnType<typeof loadMotionPackage>>;
  outputDir: string;
  workflowPath?: string;
  error: BrowserWorkflowReplayError;
}): Promise<CliResult> {
  const workflowTracePath = join(input.outputDir, `${input.pkg.manifest.id}-browser-workflow.trace.json`);
  const receiptPath = join(input.outputDir, `${input.pkg.manifest.id}-browser-capture.receipt.json`);
  const artifacts: ReceiptArtifact[] = [
    { role: "browser_workflow_trace", path: workflowTracePath, status: "failed", mediaType: "application/json" },
    { role: "preview_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `browser-workflow-failed-${hashBuffer(Buffer.from(JSON.stringify(input.error.trace), "utf8")).slice(0, 16)}`,
    operation: "browser.workflow.capture",
    status: "failed",
    packageId: input.pkg.manifest.id,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")),
      workflow: input.error.trace.workflowHash
    },
    createdAt: new Date().toISOString(),
    lane: "browser",
    output: {
      workflowTracePath,
      workflowTrace: input.error.trace
    },
    artifacts,
    warnings: [input.error.message]
  };

  await writeJson(workflowTracePath, input.error.trace);
  await writeJson(receiptPath, receipt);

  return {
    ok: false,
    command: "capture-browser",
    lane: "browser",
    ...(input.workflowPath ? { workflowPath: input.workflowPath } : {}),
    workflowTracePath,
    workflowTrace: input.error.trace,
    receiptId: receipt.id,
    receiptPath,
    artifacts,
    warnings: receipt.warnings,
    error: {
      code: input.error.code,
      message: input.error.message
    }
  };
}

function readPositiveIntegerOption(
  raw: string | undefined,
  option: string,
  defaultValue: number
): { ok: true; value: number } | { ok: false; result: CliResult } {
  if (raw === undefined) return { ok: true, value: defaultValue };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "capture-browser",
        error: {
          code: "invalid_args",
          message: `${option} must be a positive integer.`
        }
      }
    };
  }
  return { ok: true, value };
}

async function writeBrowserRecordingManifest(input: {
  pkg: Awaited<ReturnType<typeof loadMotionPackage>>;
  renderer: BrowserFrameRenderer;
  workflow?: BrowserCaptureWorkflow;
  framesDir: string;
  manifestPath: string;
  sampleCount: number;
  primaryCapture: Awaited<ReturnType<BrowserFrameRenderer>>;
  workflowTracePath?: string;
  workflowCatalogPath?: string;
}): Promise<BrowserRecordingManifest> {
  await mkdir(input.framesDir, { recursive: true });
  const sampleTimes = browserRecordingSampleTimes({
    durationMs: input.pkg.motion.durationMs,
    sampleCount: input.sampleCount
  });
  const frames: BrowserRecordingManifestFrame[] = [];
  for (const [index, atMs] of sampleTimes.entries()) {
    const outputPath = join(input.framesDir, `${String(index).padStart(6, "0")}.png`);
    const frame = await input.renderer(input.pkg, {
      atMs,
      outDir: input.framesDir,
      outputPath,
      ...(input.workflow ? { workflow: input.workflow } : {})
    });
    frames.push({
      index,
      atMs: frame.output.atMs,
      path: frame.output.path,
      sha256: frame.output.sha256,
      width: frame.output.width,
      height: frame.output.height,
      format: frame.output.format ?? "png"
    });
  }
  const workflowHash = typeof input.primaryCapture.output.workflowTrace?.workflowHash === "string"
    ? input.primaryCapture.output.workflowTrace.workflowHash
    : typeof input.primaryCapture.receipt.inputHashes.workflow === "string"
      ? input.primaryCapture.receipt.inputHashes.workflow
      : undefined;
  const workflow = workflowHash || input.workflowTracePath || input.workflowCatalogPath
    ? {
        ...(workflowHash ? { hash: workflowHash } : {}),
        ...(input.workflowTracePath ? { tracePath: input.workflowTracePath } : {}),
        ...(input.workflowCatalogPath ? { catalogPath: input.workflowCatalogPath } : {})
      }
    : undefined;
  const manifest = buildBrowserRecordingManifest({
    packageId: input.pkg.manifest.id,
    motionId: input.pkg.motion.id,
    width: input.pkg.motion.width,
    height: input.pkg.motion.height,
    durationMs: input.pkg.motion.durationMs,
    fps: input.pkg.motion.fps,
    frames,
    browser: input.primaryCapture.output.browser,
    viewport: input.primaryCapture.output.viewport,
    deterministic: {
      network: input.workflow?.networkPolicy ?? "blocked-unless-declared",
      animations: "disabled",
      caret: "hide",
      deviceScaleFactor: input.primaryCapture.output.viewport.deviceScaleFactor
    },
    ...(workflow ? { workflow } : {})
  });
  await mkdir(dirname(input.manifestPath), { recursive: true });
  await writeJson(input.manifestPath, manifest);
  return manifest;
}

async function exportPresetsCommand(): Promise<CliResult> {
  return {
    ok: true,
    command: "export-presets",
    defaultPreset: "mp4-h264",
    presets: listMotionExportPresets()
  };
}

async function renderCommand(argv: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const callerIdForRun = resolveCallerId(argv, options);
  const root = argv[0];
  if (!root) return missingArgument("render", "package root");

  const packageRoot = resolveInputPath(root);
  const lane = optionValue(argv, "--lane") ?? "ffmpeg";
  const outputPath = optionValue(argv, "--out");
  if (!outputPath) return missingArgument("render", "--out");

  if (lane === "native") {
    const resolvedOutputPath = resolveOutputPath(outputPath);
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    const result = await renderNativePreviewFrame({
      packageRoot,
      outputPath: resolvedOutputPath,
      outputRoots: [dirname(resolvedOutputPath)],
      atMs: Number(optionValue(argv, "--at-ms") ?? 0)
    });
    return result.ok
      ? {
          ok: true,
          command: "render",
          lane: "native",
          outputPath: resolvedOutputPath,
          output: {
            path: result.frame.path,
            sha256: result.frame.sha256,
            width: result.frame.width,
            height: result.frame.height,
            atMs: result.frame.atMs
          },
          receipt: result.receipt
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

  const pkg = await loadMotionPackage(packageRoot);
  const frameLane = optionValue(argv, "--frame-lane") ?? "browser";
  if (!["browser", "native"].includes(frameLane)) {
    return {
      ok: false,
      command: "render",
      error: { code: "unsupported_frame_lane", message: unsupportedFrameLaneMessage(frameLane) }
    };
  }
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
  if (stillFramePreset) {
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
    let frameReceipt: unknown = null;
    // A still frame is one frame, but it warns the same way a sequence frame does.
    const frameLaneWarnings = new FrameLaneWarnings();
    let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
    if (frameLane === "native") {
      if (stillFramePreset !== "png-frame") {
        return {
          ok: false,
          command: "render",
          error: {
            code: "unsupported_frame_lane",
            message: "Native still-frame renders currently support png-frame only."
          }
        };
      }
      const frame = await renderNativePreviewFrame({ packageRoot, outputPath: resolvedOutputPath, outputRoots: [dirname(resolvedOutputPath)], atMs });
      frameReceipt = frame.receipt;
      frameLaneWarnings.observe(frame.receipt);
      if (!frame.ok) {
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
      const frame = await renderMotionBrowserFrame(pkg, {
        outDir: dirname(resolvedOutputPath),
        outputPath: resolvedOutputPath,
        atMs,
        ...(workflow ? { workflow } : {}),
        format: stillFramePreset === "jpeg-frame" ? "jpeg" : "png"
      });
      frameReceipt = frame.receipt;
      frameLaneWarnings.observe(frame.receipt);
      workflowEvidence = browserWorkflowEvidenceFromFrame(frame);
    }

    const receipt = await createStillFrameReceipt({
      packageId: pkg.manifest.id,
      outputPath: resolvedOutputPath,
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
    const qualityCheck = qualityManifestPath
      ? await qualityCheckRenderManifest({
          inputPath: resolvedOutputPath,
          manifestPath: qualityManifestPath,
          preset: stillFramePreset,
          packageRoot,
          ...(frameLane === "browser" ? { previewPackageRoot: packageRoot } : {}),
          durationMs: pkg.motion.durationMs,
          fps: pkg.motion.fps,
          options
        })
      : undefined;
    if (qualityManifestPath && qualityCheck) {
      await enrichRenderReceiptWithQualityManifest(receipt, qualityManifestPath, qualityCheck);
      if (!qualityCheck.ok) {
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
          extra: { stillFrame }
        });
      }
    }
    const workflowCatalog = await finalizeRenderReceipt({
      packageId: pkg.manifest.id,
      receipt,
      outputPath: resolvedOutputPath,
      receiptPath: renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "image"),
      atMs,
      workflowEvidence,
      workflowCatalogPath,
      failOnDrift
    });
    if (workflowCatalog.error) {
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

    return {
      ok: true,
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
      stillFrame
    };
  }
  const frameBudgetError = renderFrameSequenceBudgetError(
    frameCount,
    pkg.motion.width,
    pkg.motion.height
  );
  if (frameBudgetError) {
    return {
      ok: false,
      command: "render",
      lane: "ffmpeg",
      frameLane,
      error: { code: "render_budget_exceeded", message: frameBudgetError }
    };
  }
  const imageSequencePreset = readImageSequenceExportPreset(preset);
  if (imageSequencePreset) {
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
        sequence
      };
    }

    // the output-directory ownership invariant: the PNG sequence lands directly in the caller-supplied `--out` directory. Refuse a
    // non-empty target instead of wiping it; `--force` restores the previous behavior. Placed after
    // the `--dry-run` return above so planning still never touches the filesystem.
    const outputDirGuard = await prepareOutputDir(resolvedOutputPath, { force: hasFlag(argv, "--force") });
    if (!outputDirGuard.ok) {
      return {
        ok: false,
        command: "render",
        lane: "image-sequence",
        frameLane,
        preset: imageSequencePreset,
        outputPath: resolvedOutputPath,
        error: outputDirGuard.error
      };
    }
    let lastFrameReceipt: unknown = null;
    // Every frame contributes its warnings, not just the last one: keeping only the final frame's
    // receipt silently dropped a warning raised on frame 1 of 270.
    const frameLaneWarnings = new FrameLaneWarnings();
    let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
    const framePaths = Array.from({ length: frameCount }, (_, frameIndex) =>
      join(resolvedOutputPath, frameFileName(frameIndex))
    );
    if (frameLane === "native") {
      // Load the native render session once: the PNG sequence is a user-facing
      // deliverable, so frames keep the default (max) PNG compression; only the load/decode work is
      // shared via a single session.
      const nativeSession = await createNativeRenderSession({ packageRoot, outputRoots: [resolvedOutputPath], renderTarget: "delivery" });
      try {
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
          const framePath = framePaths[frameIndex];
          const atMs = frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs);
          throwIfCancelled(options.signal, "native frame rendering");
          const frame = await nativeSession.renderFrameAtMs(atMs, framePath);
          lastFrameReceipt = frame.receipt;
          frameLaneWarnings.observe(frame.receipt);
          if (!frame.ok) {
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
          outDir: resolvedOutputPath,
          outputPath,
          atMs: frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs),
          ...(workflow ? { workflow } : {})
        }));
        const frames = await renderBrowserFrameBatch(pkg, frameRequests, browserSession, options.browserFrameRenderer, options.signal);
        const lastFrame = frames.at(-1);
        lastFrameReceipt = lastFrame?.receipt ?? null;
        for (const frame of frames) frameLaneWarnings.observe(frame.receipt);
        if (lastFrame) workflowEvidence = browserWorkflowEvidenceFromFrame(lastFrame);
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
      framesDir: resolvedOutputPath,
      fps: pkg.motion.fps,
      width: pkg.motion.width,
      height: pkg.motion.height,
      durationMs: pkg.motion.durationMs,
      frameCount,
      warnings: [...sequenceWarnings, ...sequenceQuality.warnings]
    });
    // Fold what the frame lane reported into the receipt an agent actually reads. Without this
    // a font-fallback warning raised while drawing is invisible once the frames are encoded away.
    frameLaneWarnings.applyTo(receipt);
    enrichRenderReceiptWithBrowserWorkflow(receipt, workflowEvidence);
    const qualityCheck = qualityManifestPath
      ? await qualityCheckRenderManifest({
          inputPath: resolvedOutputPath,
          manifestPath: qualityManifestPath,
          preset: imageSequencePreset,
          packageRoot,
          ...(frameLane === "browser" ? { previewPackageRoot: packageRoot } : {}),
          durationMs: pkg.motion.durationMs,
          fps: pkg.motion.fps,
          options
        })
      : undefined;
    if (qualityManifestPath && qualityCheck) {
      await enrichRenderReceiptWithQualityManifest(receipt, qualityManifestPath, qualityCheck);
      if (!qualityCheck.ok) {
        return await renderQualityManifestFailure({
          packageId: pkg.manifest.id,
          lane: "image-sequence",
          frameLane,
          preset: imageSequencePreset,
          outputPath: resolvedOutputPath,
          receipt,
          frameReceipt: lastFrameReceipt,
          frames: { dir: resolvedOutputPath, count: frameCount },
          qualityManifestPath,
          qualityCheck,
          extra: { sequence }
        });
      }
    }
    const workflowCatalog = await finalizeRenderReceipt({
      packageId: pkg.manifest.id,
      receipt,
      outputPath: resolvedOutputPath,
      receiptPath: renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "image-sequence"),
      atMs: 0,
      workflowEvidence,
      workflowCatalogPath,
      failOnDrift
    });
    if (workflowCatalog.error) {
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

    return {
      ok: true,
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
      sequence
    };
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
  const planned = buildEncodeImageSequenceCommand({
    framesDir,
    fps: pkg.motion.fps,
    durationMs: pkg.motion.durationMs,
    outputPath: resolvedOutputPath,
    preset: ffmpegPreset,
    audio,
    audioTracks,
    inputRoots: ffmpegInputRoots,
    outputRoots: [dirname(resolvedOutputPath)]
  });
  // A dry run must refuse what execution would refuse.
  const dryRunRefusal = nativeDeliveryRefusal(pkg, frameLane);
  if (dryRunRefusal && argv.includes("--dry-run")) return dryRunRefusal;
  if (argv.includes("--dry-run")) {
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
      ffmpeg: planned
    };
  }

  const health = await checkFfmpeg({ runner: options.ffmpegRunner });
  if (!health.ok) {
    return { ok: false, command: "render", lane: "ffmpeg", error: health.error };
  }

  // the file-output ownership invariant: `--out` as a DIRECTORY was guarded while `--out` as a FILE was handed to FFmpeg's `-y`.
  // Checked before any frame is drawn so a refusal costs no render.
  const outputFileGuard = await outputFileRefusal(resolvedOutputPath, { force: hasFlag(argv, "--force") });
  if (outputFileGuard) return { ok: false, command: "render", lane: "ffmpeg", frameLane, error: outputFileGuard };
  // the frame-output ownership invariant: this was an unguarded `rm(framesDir, { recursive: true })` justified by a comment claiming
  // Motion owns the path — but `--frames-dir` is caller-supplied, and pointing it at a directory of
  // the caller's own files deleted them while the run reported success. The scratch must still start
  // clean (a stale frame from a longer previous render would be encoded), so ownership is now proven
  // per policy in core rather than assumed: Motion's DEFAULT root wipes, a caller-named path must
  // hold only Motion's own frames or be empty, and `--force` covers the rest.
  const framesGuard = await framesDirRefusal(framesDir, {
    force: hasFlag(argv, "--force"),
    callerSupplied: framesDirCallerSupplied,
    // framesDir is `join(framesRoot, pkg.manifest.id)`, so the id is a path component supplied by
    // the PACKAGE. Even with the id now charset-validated at the loader, the sink states its own
    // containment independently at the filesystem sink.
    withinRoot: framesRoot
  });
  if (framesGuard) return { ok: false, command: "render", lane: "ffmpeg", frameLane, error: framesGuard };
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  let lastFrameReceipt: unknown = null;
  // Every frame contributes its warnings, not just the last one: keeping only the final frame's
  // receipt silently dropped a warning raised on frame 1 of 270.
  const frameLaneWarnings = new FrameLaneWarnings();
  let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
  if (frameLane === "native") {
    // Open one native render session so the package,
    // structural hashes and image assets are loaded/decoded once, then render every frame from that
    // in-memory snapshot instead of reloading + re-decoding per frame. These frames are transient
    // FFmpeg encoder input (re-decoded away by the encode step), so encode them at a fast PNG
    // compression level — it remains lossless, so the encoded video is unchanged.
    const nativeSession = await createNativeRenderSession({
      packageRoot,
      outputRoots: [framesDir],
      pngCompressionLevel: INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
      // These frames are encoded into the delivered video, so the native lane's text gate applies
      // (the text-delivery invariant): refuse rather than ship case-folded / noise-boxed text inside an MP4.
      renderTarget: "delivery"
    });
    try {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const outputPath = join(framesDir, frameFileName(frameIndex));
        const atMs = frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs);
        throwIfCancelled(options.signal, "native frame rendering");
        const frame = await nativeSession.renderFrameAtMs(atMs, outputPath);
        lastFrameReceipt = frame.receipt;
        frameLaneWarnings.observe(frame.receipt);
        if (!frame.ok) {
          return {
            ok: false,
            command: "render",
            lane: "ffmpeg",
            frameLane,
            error: frame.error,
            frameReceipt: frame.receipt,
            frames: { dir: framesDir, count: frameIndex }
          };
        }
      }
    } finally {
      nativeSession.close();
    }
  } else {
    const browserSession = options.browserFrameRenderer ? undefined : await createMotionBrowserRenderSession(pkg, callerIdForRun ? { callerId: callerIdForRun } : {});
    try {
      const frameRequests = Array.from({ length: frameCount }, (_, frameIndex) => ({
        outDir: framesDir,
        outputPath: join(framesDir, frameFileName(frameIndex)),
        atMs: frameTimestampMs(frameIndex, pkg.motion.fps, pkg.motion.durationMs),
        ...(workflow ? { workflow } : {})
      }));
      const frames = await renderBrowserFrameBatch(pkg, frameRequests, browserSession, options.browserFrameRenderer, options.signal);
      const lastFrame = frames.at(-1);
      lastFrameReceipt = lastFrame?.receipt ?? null;
      for (const frame of frames) frameLaneWarnings.observe(frame.receipt);
      if (lastFrame) workflowEvidence = browserWorkflowEvidenceFromFrame(lastFrame);
    } finally {
      await browserSession?.close();
    }
  }

  const encoded = await encodeImageSequenceWithPolicy({
    packageId: pkg.manifest.id,
    framesDir,
    fps: pkg.motion.fps,
    width: pkg.motion.width,
    height: pkg.motion.height,
    durationMs: pkg.motion.durationMs,
    outputPath: resolvedOutputPath,
    preset: ffmpegPreset,
    audio,
    audioTracks,
    inputRoots: ffmpegInputRoots,
    outputRoots: [dirname(resolvedOutputPath)],
    quality,
    // Hardware-encode by default through the shared encode policy: the probe is cached across
    // renders on this host, and the software override is honored. Bind the checkFfmpeg version to the
    // cache/receipt provenance.
    ...(forceSoftwareEncode ? { forceSoftwareEncode: true } : {}),
    ...(health.version ? { ffmpegVersion: health.version } : {}),
    runner: options.ffmpegRunner
  });
  if (!encoded.ok) {
    return {
      ok: false,
      command: "render",
      lane: "ffmpeg",
      frameLane,
      error: encoded.error,
      ffmpeg: encoded.command,
      frameReceipt: lastFrameReceipt,
      frames: { dir: framesDir, count: frameCount }
    };
  }
  // Fold what the frame lane reported into the receipt an agent actually reads. Without this
  // a font-fallback warning raised while drawing is invisible once the frames are encoded away.
  frameLaneWarnings.applyTo(encoded.receipt);
  enrichRenderReceiptWithBrowserWorkflow(encoded.receipt, workflowEvidence);
  const qualityCheck = qualityManifestPath
    ? await qualityCheckRenderManifest({
        inputPath: resolvedOutputPath,
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
      return await renderQualityManifestFailure({
        packageId: pkg.manifest.id,
        lane: "ffmpeg",
        frameLane,
        preset: ffmpegPreset,
        outputPath: resolvedOutputPath,
        receipt: encoded.receipt,
        frameReceipt: lastFrameReceipt,
        frames: { dir: framesDir, count: frameCount },
        qualityManifestPath,
        qualityCheck,
        extra: { ffmpeg: encoded.command }
      });
    }
  }
  const workflowCatalog = await finalizeRenderReceipt({
    packageId: pkg.manifest.id,
    receipt: encoded.receipt,
    outputPath: resolvedOutputPath,
    receiptPath: renderReceiptPathForOutput(pkg.manifest.id, resolvedOutputPath, "ffmpeg"),
    atMs: 0,
    workflowEvidence,
    workflowCatalogPath,
    failOnDrift
  });
  if (workflowCatalog.error) {
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
      frameReceipt: lastFrameReceipt,
      frames: { dir: framesDir, count: frameCount },
      ...(qualityCheck ? { qualityCheck } : {}),
      warnings: encoded.receipt.warnings,
      ffmpeg: encoded.command,
      error: workflowCatalog.error
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
    ...workflowCatalogFields(workflowCatalog),
    ...(resolvedAudioPath ? { audioPath: resolvedAudioPath } : {}),
    ...(audio ? { audio } : {}),
    ...(audioTracks ? { audioTracks } : {}),
    ...(qualityManifestPath ? { qualityManifestPath } : {}),
    outputPath: resolvedOutputPath,
    output: encoded.receipt.output,
    receipt: encoded.receipt,
    frameReceipt: lastFrameReceipt,
    frames: { dir: framesDir, count: frameCount },
    ...(qualityCheck ? { qualityCheck } : {}),
    warnings: encoded.receipt.warnings,
    ffmpeg: encoded.command
  };
}

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
  if (input.preset === "png-frame") {
    return qualityCheckPngStillFrameManifest({
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      qualityRoot,
      runner,
      ...(input.previewPackageRoot ? { previewPackageRoot: input.previewPackageRoot } : {}),
      previewLane: "browser"
    });
  }
  if (input.preset === "png-sequence") {
    return qualityCheckPngSequenceManifest({
      inputPath: input.inputPath,
      manifestPath: input.manifestPath,
      qualityRoot,
      runner,
      durationMs: input.durationMs,
      fps: input.fps,
      ...(input.previewPackageRoot ? { previewPackageRoot: input.previewPackageRoot } : {}),
      previewLane: "browser"
    });
  }
  const args = [
    input.inputPath,
    "--manifest",
    input.manifestPath
  ];
  // Prefer the deterministic pre-encode renderer baseline (video lane). Fall back to a re-rendered
  // browser preview only when the pre-encode frames are unavailable.
  if (input.sourceFramesDir) {
    args.push("--source-frames-dir", input.sourceFramesDir);
  } else if (input.previewPackageRoot) {
    args.push("--preview-package", input.previewPackageRoot, "--preview-lane", "browser");
  }
  return qualityCheckCommand(args, input.options);
}

async function enrichRenderReceiptWithQualityManifest(
  receipt: OperationReceipt,
  qualityManifestPath: string,
  qualityCheck: CliResult
): Promise<void> {
  receipt.inputHashes = {
    ...receipt.inputHashes,
    qualityManifest: await hashFile(qualityManifestPath)
  };
  const output = readRecord(receipt.output) ?? {};
  receipt.output = {
    ...output,
    qualityManifestPath,
    qualityCheck: {
      status: qualityCheck.ok ? "passed" : "failed",
      // On failure, persist the metric breakdown and diff-image path of the offending sample so the
      // receipt distinguishes a colour/range offset from a content/timing regression without a rerun.
      ...(qualityCheck.ok ? {} : { failedSample: summarizeFailedQualitySample(qualityCheck) })
    }
  };
  receipt.status = qualityCheck.ok ? receipt.status : "failed";
  receipt.warnings = dedupeWarnings([...receipt.warnings, ...resultWarnings(qualityCheck)]);
}

/**
 * Extract a compact, receipt-safe breakdown of the first failing quality-manifest sample: its id,
 * delivered-frame identity, the full visual-diff metrics, and the on-disk frame/baseline/diff image
 * paths. Returns undefined when no sample-level detail is available (e.g. a manifest-parse failure).
 */
function summarizeFailedQualitySample(qualityCheck: CliResult): Record<string, unknown> | undefined {
  const samples = Array.isArray(qualityCheck.samples) ? qualityCheck.samples : [];
  const failed = samples.map((sample) => readRecord(sample)).find((sample) => sample && sample.ok === false);
  if (!failed) return undefined;
  const error = readRecord(failed.error);
  const visualDiff = readRecord(failed.visualDiff);
  return {
    id: failed.id,
    ...(typeof failed.atMs === "number" ? { atMs: failed.atMs } : {}),
    ...(typeof failed.deliveryFrameIndex === "number" ? { deliveryFrameIndex: failed.deliveryFrameIndex } : {}),
    ...(error ? { code: error.code, message: error.message } : {}),
    ...(typeof failed.framePath === "string" ? { framePath: failed.framePath } : {}),
    ...(typeof failed.baselinePath === "string" ? { baselinePath: failed.baselinePath } : {}),
    ...(typeof failed.diffPath === "string" ? { diffPath: failed.diffPath } : {}),
    ...(visualDiff
      ? {
          metrics: {
            changedPixels: visualDiff.changedPixels,
            meanAbsoluteError: visualDiff.meanAbsoluteError,
            rootMeanSquaredError: visualDiff.rootMeanSquaredError,
            psnrDb: visualDiff.psnrDb,
            ssim: visualDiff.ssim,
            maxChannelDelta: visualDiff.maxChannelDelta
          }
        }
      : {})
  };
}

/**
 * A render that produced media but failed its quality manifest.
 *
 * The receipt is still written to disk: a failed quality gate is precisely when an agent needs
 * durable evidence of what was produced and why it was rejected. `packageId` is required so the
 * receipt lands on the same path a successful render would have used.
 */
async function renderQualityManifestFailure(input: {
  packageId: string;
  lane: "ffmpeg" | "image-sequence" | "image";
  frameLane: string;
  preset: MotionExportPreset;
  outputPath: string;
  receipt: OperationReceipt;
  frameReceipt: unknown;
  frames?: { dir: string; count: number };
  qualityManifestPath: string;
  qualityCheck: CliResult;
  extra?: Record<string, unknown>;
}): Promise<CliResult> {
  const qualityError = readRecord(input.qualityCheck.error);
  const receiptPath = await writeRenderReceiptFile(
    input.receipt,
    renderReceiptPathForOutput(input.packageId, input.outputPath, input.lane)
  );
  return {
    ok: false,
    command: "render",
    receiptPath,
    lane: input.lane,
    frameLane: input.frameLane,
    preset: input.preset,
    outputPath: input.outputPath,
    receipt: input.receipt,
    frameReceipt: input.frameReceipt,
    ...(input.frames ? { frames: input.frames } : {}),
    qualityManifestPath: input.qualityManifestPath,
    qualityCheck: input.qualityCheck,
    error: {
      code: typeof qualityError?.code === "string" ? qualityError.code : "quality_check_failed",
      message: typeof qualityError?.message === "string"
        ? qualityError.message
        : "Final render quality manifest check failed."
    },
    warnings: input.receipt.warnings,
    ...(input.extra ?? {})
  };
}

function readMinUniqueFrameHashes(raw: string): { minUniqueFrameHashes: number } | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return { minUniqueFrameHashes: value };
}


/**
 * Render a batch of browser frames through whichever renderer is in play.
 *
 * A real session renders the whole batch in one call so the page is loaded once. An injected
 * renderer (tests, hosts supplying their own browser) has no batch entry point, so frames go
 * through it one at a time — same results, no shared page to reuse.
 */
async function renderBrowserFrameBatch(
  pkg: Awaited<ReturnType<typeof loadMotionPackage>>,
  frames: Array<{ outDir: string; outputPath: string; atMs: number; workflow?: unknown }>,
  session: MotionBrowserRenderSession | undefined,
  injected: BrowserFrameRenderer | undefined,
  signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<typeof renderMotionBrowserFrame>>[]> {
  if (!injected) {
    return session!.renderFrames(
      frames as Parameters<MotionBrowserRenderSession["renderFrames"]>[0],
      signal ? { signal } : {}
    );
  }
  const results: Awaited<ReturnType<typeof renderMotionBrowserFrame>>[] = [];
  for (const frame of frames) {
    // A real session checks the signal itself; an injected renderer has no such contract, so the
    // loop has to. Without this a cancelled render drew every remaining frame and reported success.
    throwIfCancelled(signal, "browser frame rendering");
    results.push(await injected(pkg, frame as Parameters<BrowserFrameRenderer>[1]));
  }
  return results;
}

function browserWorkflowEvidenceFromFrame(frame: { output?: unknown; receipt?: unknown }): BrowserWorkflowRenderEvidence | undefined {
  const output = readRecord(frame.output);
  const receipt = readRecord(frame.receipt);
  const inputHashes = readRecord(receipt?.inputHashes);
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
  const trace = readRecord(value);
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
  const output = readRecord(receipt.output) ?? {};
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

function workflowCatalogFields(result: RenderReceiptFinalizeResult): Record<string, unknown> {
  return {
    ...(result.workflowCatalogPath ? { workflowCatalogPath: result.workflowCatalogPath } : {}),
    ...(result.workflowDrift ? { workflowDrift: result.workflowDrift } : {}),
    ...(result.receiptPath ? { receiptPath: result.receiptPath } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {})
  };
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

  let media: Awaited<ReturnType<typeof probeMedia>>;
  try {
    media = await probeMedia(inputPath, { runner });
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
    return qualityCheckManifest({
      inputPath,
      manifestPath,
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
  }

  await mkdir(dirname(framePath), { recursive: true });
  const seekArgs = (atMs.value ?? 0) > 0 ? ["-ss", formatSeconds((atMs.value ?? 0) / 1000)] : [];
  const extractCommand: FfmpegCommand = {
    executable: resolveFfmpegExecutable(),
    args: ["-y", ...seekArgs, ...frameExtractionInputArgs(media, inputPath), ...frameExtractionPngOutputArgs(media, framePath)],
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
  await mkdir(dirname(input.framePath), { recursive: true });
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
    await mkdir(dirname(framePath), { recursive: true });
    // Frame-accurate + colour-normalized extraction when a delivered-frame index is known (the
    // representative-frame manifest path); otherwise fall back to the wall-clock seek used by the
    // standalone single-frame quality-check.
    const extractArgs = input.deliveryFrameIndex !== undefined
      ? ["-y", ...frameExtractionArgs(input.media, input.inputPath, framePath, { frameIndex: input.deliveryFrameIndex })]
      : ["-y", ...(input.atMs > 0 ? ["-ss", formatSeconds(input.atMs / 1000)] : []),
        ...frameExtractionInputArgs(input.media, input.inputPath), ...frameExtractionPngOutputArgs(input.media, framePath)];
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
    audioLevels = await measureAudioLevels(input.inputPath, { runner: input.runner });
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
    ? await loadDataRowsFile(resolveInputPath(rowsRef))
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
  const packagesRoot = join(outDir, "packages");
  const renderRoot = join(outDir, "render");
  const receiptsRoot = join(outDir, "receipts");
  const previousBatchJobs = resume ? await readBatchResumeJobs(join(receiptsRoot, "batch-render.receipt.json")) : new Map<string, Record<string, unknown>>();
  await mkdir(packagesRoot, { recursive: true });
  await mkdir(renderRoot, { recursive: true });
  await mkdir(receiptsRoot, { recursive: true });

  const jobs: Array<Record<string, unknown>> = [];
  for (let index = 0; index < expanded.length; index += 1) {
    const job = expanded[index];
    const jobPreset = presetPlan.presets[index];
    const packageDir = join(packagesRoot, job.manifest.id);
    const outputPath = batchRenderOutputPath(renderRoot, job.manifest.id, jobPreset);
    const idempotencyKey = batchJobIdempotencyKey({
      packageId: job.manifest.id,
      rowId: job.row.id,
      rowHash: job.row.hash,
      manifest: job.manifest,
      motion: job.motion,
      preset: jobPreset,
      quality,
      qualityManifestPath,
      workflowIdempotencyHash
    });
    await writeExpandedPackage(job, pkg, packageDir);
    const audioPresetWarnings = audioWarningsForMotionExportPreset(jobPreset, audioInputCountForMotion(job.motion));
    const planReceiptPath = await writeBatchRowPlanReceipt({
      receiptsRoot,
      dryRun,
      packageId: job.manifest.id,
      row: job.row,
      manifest: job.manifest,
      motion: job.motion,
      packageDir,
      outputPath,
      preset: jobPreset,
      status: "not_run",
      idempotencyKey,
      quality,
      qualityManifestPath,
      warnings: audioPresetWarnings
    });
    if (dryRun) {
      jobs.push({
        rowId: job.row.id,
        rowHash: job.row.hash,
        rowKey: job.row.key,
        idempotencyKey,
        packageId: job.manifest.id,
        packageDir,
        outputPath,
        preset: jobPreset,
        status: "not_run",
        planReceiptPath,
        receiptPath: planReceiptPath,
        ...(quality ? { quality } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
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
        preset: jobPreset,
        status: "skipped",
        planReceiptPath,
        receiptPath: sourceReceiptPath,
        resume: { matched: true, sourceReceiptPath },
        ...(quality ? { quality } : {}),
        ...(qualityManifestPath ? { qualityManifestPath } : {}),
        ...(audioPresetWarnings.length > 0 ? { warnings: audioPresetWarnings } : {})
      });
      continue;
    }

    // `outputPath` is `<out>/render/<packageId>`, a path this batch derives and owns — not a
    // caller-chosen directory — so it explicitly opts into guarded replacement to keep re-running a batch
    // into the same `--out` working. The batch's own `--out` is only mkdir'd, never wiped.
    const renderArgs = [packageDir, "--lane", "ffmpeg", "--out", outputPath, "--preset", jobPreset, "--force"];
    if (quality) renderArgs.push("--min-unique-frames", String(quality.minUniqueFrameHashes));
    if (workflowPath) renderArgs.push("--workflow", workflowPath);
    const renderResult = await renderCommand(renderArgs, options);
    let qualityCheck: CliResult | undefined;
    const warnings = resultWarnings(renderResult);
    const receiptPath = join(receiptsRoot, `${job.manifest.id}.render.receipt.json`);
    await writeJson(receiptPath, renderResult.receipt ?? {
      schema: "shellx-motion/receipt@1",
      id: `render-failed-${job.manifest.id}`,
      operation: "render.final",
      status: "failed",
      packageId: job.manifest.id,
      inputHashes: { row: job.row.hash },
      createdAt: new Date().toISOString(),
      lane: "ffmpeg",
      output: { preset: jobPreset },
      warnings: []
    });
    let qualityManifestForCheckPath = qualityManifestPath;
    let qualityManifestAppliedPath: string | undefined;
    if (renderResult.ok && qualityManifestPath) {
      const materialized = await materializeBatchQualityManifest({
        sourcePath: qualityManifestPath,
        targetPath: join(receiptsRoot, "quality-manifests", `${job.manifest.id}.quality-manifest.json`),
        row: job.row,
        packageId: job.manifest.id,
        packageDir,
        outputPath
      });
      qualityManifestForCheckPath = materialized.path;
      qualityManifestAppliedPath = materialized.appliedPath;
      qualityCheck = jobPreset === "png-frame"
        ? await qualityCheckPngStillFrameManifest({
            inputPath: outputPath,
            manifestPath: qualityManifestForCheckPath,
            qualityRoot: resolveOutputPath(options.scratchRoot ? join(options.scratchRoot, "quality") : ".scratch/quality"),
            runner: options.ffmpegRunner ?? defaultFfmpegRunner(options.signal, resolveCallerId(argv, options)),
            previewPackageRoot: packageDir,
            previewLane: "browser"
          })
        : jobPreset === "png-sequence"
          ? await qualityCheckPngSequenceManifest({
              inputPath: outputPath,
              manifestPath: qualityManifestForCheckPath,
              qualityRoot: resolveOutputPath(options.scratchRoot ? join(options.scratchRoot, "quality") : ".scratch/quality"),
              runner: options.ffmpegRunner ?? defaultFfmpegRunner(options.signal, resolveCallerId(argv, options)),
              durationMs: job.motion.durationMs,
              fps: job.motion.fps,
              previewPackageRoot: packageDir,
              previewLane: "browser"
            })
        : await qualityCheckCommand([
            outputPath,
            "--manifest",
            qualityManifestForCheckPath,
            "--preview-package",
            packageDir,
            "--preview-lane",
            "browser"
          ], options);
    }
    const qualityOk = qualityCheck ? qualityCheck.ok : true;
    const rowWarnings = dedupeWarnings([
      ...warnings,
      ...(qualityCheck ? resultWarnings(qualityCheck) : [])
    ]);
    // Same rule as the row's own receipt. This field is computed independently of that receipt but
    // is typed in RECEIPT vocabulary (passed/failed/not_run, not the job outcomes succeeded/failed/
    // cancelled/skipped), so it answers the same question and must answer it the same way. Without
    // this, one batch receipt contradicted itself: output.jobs[].status said `passed` for a row
    // whose own render receipt said `warning` on the identical advisory.
    const rowStatus = escalateReceiptStatusForWarnings(
      renderResult.ok && qualityOk ? "passed" : "failed",
      rowWarnings
    );
    jobs.push({
      rowId: job.row.id,
      rowHash: job.row.hash,
      rowKey: job.row.key,
      idempotencyKey,
      packageId: job.manifest.id,
      packageDir,
      outputPath,
      preset: jobPreset,
      status: rowStatus,
      planReceiptPath,
      receiptPath,
      ...(quality ? { quality } : {}),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      ...(qualityManifestAppliedPath ? { qualityManifestAppliedPath } : {}),
      ...(qualityCheck ? { qualityCheck } : {}),
      ...(rowWarnings.length > 0 ? { warnings: rowWarnings } : {}),
      render: renderResult
    });
    if (!renderResult.ok) {
      const batchCounts = batchRenderCounts(jobs, dryRun);
      const receipt = await writeBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, ...batchCounts, preset, ...presetSummary, quality, qualityManifestPath, jobs, status: "failed" });
      const warnings = receiptWarnings(receipt);
      const error = batchRenderError(job, renderResult);
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
    if (!qualityOk && qualityCheck) {
      const batchCounts = batchRenderCounts(jobs, dryRun);
      const receipt = await writeBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, ...batchCounts, preset, ...presetSummary, quality, qualityManifestPath, jobs, status: "failed" });
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

  const batchCounts = batchRenderCounts(jobs, dryRun);
  const receipt = await writeBatchReceipt({ receiptsRoot, pkg, rows, dryRun, resume, ...batchCounts, preset, ...presetSummary, quality, qualityManifestPath, jobs, status: dryRun ? "not_run" : "passed" });
  const warnings = receiptWarnings(receipt);
  return {
    ok: true,
    command: "render-batch",
    dryRun,
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

function planBatchRenderPresets(jobs: ExpandedMotionJob[], fallbackPreset: MotionExportPreset, forcePreset: boolean): {
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
    const rowPresetValue = forcePreset ? undefined : readBatchRowRenderPreset(job.row);
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
  return { ok: true, presets, uniquePresets: uniqueMotionExportPresets(presets) };
}

function readBatchRowRenderPreset(row: MotionDataRow): string | undefined {
  const flatPreset = row.values["render.preset"];
  if (typeof flatPreset === "string" && flatPreset.trim()) return flatPreset.trim();
  const render = readRecord(row.values.render);
  const preset = render?.preset;
  return typeof preset === "string" && preset.trim() ? preset.trim() : undefined;
}

function uniqueMotionExportPresets(presets: MotionExportPreset[]): MotionExportPreset[] {
  return presets.filter((preset, index) => presets.indexOf(preset) === index);
}

function batchPresetSummary(basePreset: MotionExportPreset, actualPresets: MotionExportPreset[]): { presets?: MotionExportPreset[] } {
  return actualPresets.length === 1 && actualPresets[0] === basePreset ? {} : { presets: actualPresets };
}

function batchJobIdempotencyKey(input: {
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

async function batchWorkflowIdempotencyHash(workflowPath: string): Promise<string> {
  const workflowBytes = await readFile(workflowPath);
  return hashBuffer(workflowBytes);
}


function batchRenderCounts(jobs: Array<Record<string, unknown>>, dryRun: boolean): { resumedRows: number; renderedRows: number } {
  const resumedRows = jobs.filter((job) => job.status === "skipped").length;
  return { resumedRows, renderedRows: dryRun ? 0 : jobs.length - resumedRows };
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
  await writeJson(receiptPath, receipt);
  return receiptPath;
}

async function writeExpandedPackage(job: ExpandedMotionJob, sourcePkg: Awaited<ReturnType<typeof loadMotionPackage>>, packageDir: string): Promise<void> {
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(packageDir, "manifest.json"), job.manifest);
  await writeJson(join(packageDir, "motion.json"), job.motion);
  if (job.manifest.template) {
    const targetPath = join(packageDir, job.manifest.template);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(resolvePackageAsset(sourcePkg, job.manifest.template), targetPath);
  }
  for (const assetRef of job.manifest.assets ?? []) {
    const targetPath = join(packageDir, assetRef);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(resolvePackageAsset(sourcePkg, assetRef), targetPath);
  }
  // Template sidecars referenced from template.metadata are part of the package contract:
  // assertTemplatePackageSemantics() rejects a package whose declared quality manifest is
  // missing. They are NOT listed in manifest.assets, so copying manifest/motion/template
  // alone produced an expanded package that could not be loaded back. Every promoted family
  // declares qualityTargets.manifest, so this broke render-batch for the whole product pack.
  const qualityManifestRef = readTemplateQualityManifestRef(sourcePkg);
  if (qualityManifestRef) {
    const targetPath = join(packageDir, qualityManifestRef);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(resolvePackageAsset(sourcePkg, qualityManifestRef), targetPath);
  }
}

/**
 * Reads `template.metadata.qualityTargets.manifest` from a loaded package, if declared.
 * Returns a package-relative ref, or null when the package declares no quality manifest.
 */
function readTemplateQualityManifestRef(pkg: Awaited<ReturnType<typeof loadMotionPackage>>): string | null {
  const template = (pkg as { template?: unknown }).template;
  if (!template || typeof template !== "object") return null;
  const metadata = (template as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const qualityTargets = (metadata as { qualityTargets?: unknown }).qualityTargets;
  if (!qualityTargets || typeof qualityTargets !== "object") return null;
  const manifestRef = (qualityTargets as { manifest?: unknown }).manifest;
  return typeof manifestRef === "string" && manifestRef.length > 0 ? manifestRef : null;
}

async function writeBatchReceipt(input: {
  receiptsRoot: string;
  pkg: Awaited<ReturnType<typeof loadMotionPackage>>;
  rows: Array<{ id: string; hash: string; key?: string }>;
  dryRun: boolean;
  resume?: boolean;
  resumedRows?: number;
  renderedRows?: number;
  preset: MotionExportPreset;
  presets?: MotionExportPreset[];
  quality?: { minUniqueFrameHashes: number };
  qualityManifestPath?: string;
  jobs: Array<Record<string, unknown>>;
  status: "passed" | "failed" | "not_run";
}): Promise<Record<string, unknown>> {
  // The batch receipt goes through the same door as every other receipt. Without this it reported
  // `passed` while the ROW receipts it aggregates reported `warning` on that identical warning --
  // The aggregate batch receipt must use the same warning-derived status as each row.
  // carrying the same motion-density advisory that made pkg_batch_card_grace.render.receipt.json say
  // `warning`.
  //
  // Only the batch's own top-level verdict is derived here. `output.jobs[].status` is a per-row
  // MIRROR of each row's own receipt and is not touched: those rows are built by the render door,
  // which already applies this rule, so they arrive correct. Deriving both here would compute the
  // same answer twice from two sources and let them drift.
  const batchStatus = escalateReceiptStatusForWarnings(
    input.status,
    dedupeWarnings(input.jobs.flatMap((job) => resultWarnings(job)))
  );
  const rowHash = hashBuffer(Buffer.from(JSON.stringify({
    rows: input.rows.map((row) => ({ id: row.id, hash: row.hash })),
    preset: input.preset,
    presets: input.presets,
    quality: input.quality,
    qualityManifestPath: input.qualityManifestPath
  }), "utf8"));
  const receipt = {
    schema: "shellx-motion/receipt@1",
    id: `batch-render-${input.pkg.manifest.id}-${rowHash.slice(0, 16)}`,
    operation: "render.batch",
    status: batchStatus,
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
        receiptPath: job.receiptPath,
        ...(job.resume ? { resume: job.resume } : {}),
        ...(job.quality ? { quality: job.quality } : {}),
        ...(job.qualityManifestPath ? { qualityManifestPath: job.qualityManifestPath } : {}),
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

async function materializeBatchQualityManifest(input: {
  sourcePath: string;
  targetPath: string;
  row: ExpandedMotionJob["row"];
  packageId: string;
  packageDir: string;
  outputPath: string;
}): Promise<{ path: string; appliedPath?: string }> {
  const sourceText = await readFile(input.sourcePath, "utf8");
  if (!sourceText.includes("{{")) return { path: input.sourcePath };
  const source = JSON.parse(sourceText);
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
  const materialized = resolveQualityManifestBaselinePaths(
    interpolateQualityManifestValue(source, context),
    dirname(input.sourcePath)
  );
  await mkdir(dirname(input.targetPath), { recursive: true });
  await writeJson(input.targetPath, materialized);
  return { path: input.targetPath, appliedPath: input.targetPath };
}

function interpolateQualityManifestValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolateQualityManifestString(value, context);
  if (Array.isArray(value)) return value.map((entry) => interpolateQualityManifestValue(entry, context));
  const record = readRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, interpolateQualityManifestValue(entry, context)])
    );
  }
  return value;
}

function interpolateQualityManifestString(value: string, context: Record<string, unknown>): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const replacement = context[key];
    if (replacement === undefined || replacement === null) return "";
    return typeof replacement === "string" ? replacement : JSON.stringify(replacement);
  });
}

function resolveQualityManifestBaselinePaths(value: unknown, sourceDir: string): unknown {
  const record = readRecord(value);
  if (!record) return value;
  if (!Array.isArray(record.samples)) return value;
  return {
    ...record,
    samples: record.samples.map((sample) => {
      const sampleRecord = readRecord(sample);
      if (!sampleRecord || typeof sampleRecord.baseline !== "string" || !sampleRecord.baseline.trim()) return sample;
      return {
        ...sampleRecord,
        baseline: isAbsolute(sampleRecord.baseline) ? sampleRecord.baseline : resolve(sourceDir, sampleRecord.baseline)
      };
    })
  };
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

function batchRenderError(job: ExpandedMotionJob, renderResult: unknown): Record<string, unknown> {
  const renderRecord = readRecord(renderResult);
  const error = readRecord(renderRecord?.error) ?? { code: "render_failed", message: "Batch row render failed." };
  return {
    ...error,
    rowId: job.row.id,
    packageId: job.manifest.id
  };
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
  // Opt-in overwrite, same convention as `render --force`. Without it a caller cannot proceed past
  // a guard refusal, which would make the guard a wall rather than a safety rail.
  const forceOverwrite = argv.includes("--force");
  const command = `connector.${subcommand}`;
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
  let canvasToCutPreset: FfmpegExportPreset | undefined;
  if (subcommand === "canvas-to-cut") {
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
    canvasToCutPreset = preset;
  }
  let result:
    | Awaited<ReturnType<typeof runCanvasToCutConnector>>
    | Awaited<ReturnType<typeof runScriptToCutConnector>>
    | Awaited<ReturnType<typeof runSourceToCutConnector>>
    | Awaited<ReturnType<typeof runTemplateToCutConnector>>;
  try {
    result = subcommand === "canvas-to-cut"
      ? await runCanvasToCutConnector({
          canvasSelectionPath: resolveInputPath(inputPath),
          outDir: resolveOutputPath(outDir),
          force: forceOverwrite,
          previewLane: "native",
          renderLane: "ffmpeg",
          preset: canvasToCutPreset,
          dryRunRender,
          cutImportMode,
          ffmpegRunner: options.ffmpegRunner
        })
      : subcommand === "source-to-cut"
      ? await runSourceToCutConnector({
          sourcePath: resolveInputPath(inputPath),
          outDir: resolveOutputPath(outDir),
          force: forceOverwrite,
          maxFrames: numberOption(argv, "--max-frames") ?? numberOption(argv, "--maxFrames"),
          frameDurationMs: numberOption(argv, "--frame-duration-ms") ?? numberOption(argv, "--frameDurationMs"),
          width: numberOption(argv, "--width"),
          height: numberOption(argv, "--height"),
          fps: numberOption(argv, "--fps"),
          previewLane: "native",
          renderLane: "ffmpeg",
          dryRunRender,
          cutImportMode,
          ffmpegRunner: options.ffmpegRunner
        })
      : subcommand === "template-to-cut"
      ? await runTemplateToCutConnector({
          packageRoot: resolveInputPath(inputPath),
          values: parseTemplateSetOptions(argv),
          outDir: resolveOutputPath(outDir),
          previewLane: "auto",
          renderLane: "ffmpeg",
          dryRunRender,
          force: forceOverwrite,
          cutImportMode,
          ...(Object.keys(cutPlacement).length > 0 ? { cutPlacement } : {}),
          ffmpegRunner: options.ffmpegRunner
        })
      : await runScriptToCutConnector({
          scriptPath: resolveInputPath(inputPath),
          outDir: resolveOutputPath(outDir),
          force: forceOverwrite,
          previewLane: "native",
          renderLane: "ffmpeg",
          dryRunRender,
          cutImportMode,
          ...(Object.keys(cutPlacement).length > 0 ? { cutPlacement } : {}),
          ...(subcommand === "cut-generate-to-cut" ? { receiptOperation: "connector.cut_generate_to_cut" as const } : {}),
          ffmpegRunner: options.ffmpegRunner
        });
  } catch (error) {
    return {
      ok: false,
      command,
      error: {
        code: error instanceof MotionOutputGuardError ? error.code : "connector_failed",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof MotionOutputGuardError
          ? { suggestedAction: "Choose an empty --out directory, or pass --force to overwrite it." }
          : {})
      }
    };
  }

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
    warnings: result.warnings
  };

  // Motion's connector boundary ends at artifacts, receipts, and the Cut import plan. The caller
  // owns plan validation and application inside Cut.
  return response;
}

function normalizeArgv(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
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
const VALUELESS_FLAGS = new Set(["--expect-audio", "--fail-on-drift", "--needs-alpha", "--needs-audio", "--needs-subtitles", "--dry-run", "--dry-run-render", "--resume", "--trusted-local-tier", "--commercial-use", "--retain-raw-prompt"]);
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

function promptRetentionFromCli(
  argv: string[]
): { ok: true; value: PromptRetentionInput } | { ok: false; error: { code: string; message: string } } {
  const retainRawRequest = hasFlag(argv, "--retain-raw-prompt");
  const deleteAfter = optionValue(argv, "--raw-prompt-delete-after");
  const purpose = optionValue(argv, "--raw-prompt-purpose");
  if (!retainRawRequest) {
    if (deleteAfter || purpose) {
      return {
        ok: false,
        error: {
          code: "invalid_prompt_retention",
          message: "--raw-prompt-delete-after and --raw-prompt-purpose require --retain-raw-prompt."
        }
      };
    }
    return { ok: true, value: { mode: "summary_only" } };
  }
  if (!deleteAfter) {
    return { ok: false, error: { code: "invalid_prompt_retention", message: "--retain-raw-prompt requires --raw-prompt-delete-after." } };
  }
  if (!isPromptRawRetentionPurpose(purpose)) {
    return {
      ok: false,
      error: {
        code: "invalid_prompt_retention",
        message: "--retain-raw-prompt requires --raw-prompt-purpose debugging or user_requested_replay."
      }
    };
  }
  return { ok: true, value: { mode: "raw_request", deleteAfter, purpose } };
}

function isPromptRawRetentionPurpose(value: unknown): value is PromptRawRetentionPurpose {
  return value === "debugging" || value === "user_requested_replay";
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

const MAX_RENDER_FRAME_COUNT = 36_000;
const MAX_RENDER_PIXEL_FRAMES = 80_000_000_000;

export function renderFrameSequenceBudgetError(
  frameCount: number,
  width: number,
  height: number
): string | undefined {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    return "Frame sequence size is invalid.";
  }
  if (frameCount > MAX_RENDER_FRAME_COUNT) {
    return `Frame sequence requires ${frameCount} frames; the local safety limit is ${MAX_RENDER_FRAME_COUNT}. Split the motion or lower its duration/FPS.`;
  }
  const pixelFrames = frameCount * width * height;
  if (!Number.isSafeInteger(pixelFrames) || pixelFrames > MAX_RENDER_PIXEL_FRAMES) {
    return `Frame sequence requires ${pixelFrames} pixel-frames; the local safety limit is ${MAX_RENDER_PIXEL_FRAMES}. Split the motion or lower its resolution/duration/FPS.`;
  }
  return undefined;
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
  if (command === "motion.render.final") {
    const atMs = optionValue(argv, "--at-ms");
    const minUniqueFrameHashes = optionValue(argv, "--min-unique-frames") ?? optionValue(argv, "--min-unique-frame-hashes");
    const workflowPath = optionValue(argv, "--workflow") ?? optionValue(argv, "--workflow-path");
    const qualityManifestPath = optionValue(argv, "--quality-manifest") ?? optionValue(argv, "--quality-manifest-path") ?? optionValue(argv, "--manifest");
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
      ...(hasFlag(argv, "--dry-run") ? { dryRun: true } : {})
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
      cutImportMode: optionValue(argv, "--cut-import-mode"),
      ...(hasFlag(argv, "--dry-run-render") ? { dryRunRender: true } : {})
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
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      triggerLayerIds: layerDuckingTriggerOptions(argv),
      ...(duckToVolume !== undefined ? { duckToVolume: Number(duckToVolume) } : {}),
      ...(attackMs !== undefined ? { attackMs: Number(attackMs) } : {}),
      ...(releaseMs !== undefined ? { releaseMs: Number(releaseMs) } : {})
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
  if (command === "motion.timeline.transition.upsert") {
    const durationMs = optionValue(argv, "--duration-ms");
    const distance = optionValue(argv, "--distance");
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      edge: optionValue(argv, "--edge"),
      type: optionValue(argv, "--type"),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      easing: optionValue(argv, "--easing"),
      direction: optionValue(argv, "--direction"),
      ...(distance !== undefined ? { distance: Number(distance) } : {})
    };
  }
  if (command === "motion.timeline.transition.delete") {
    return {
      packageRoot: debugPackageRoot(argv),
      outDir: optionValue(argv, "--out") ?? optionValue(argv, "--package-dir"),
      receiptsRoot: optionValue(argv, "--receipts-root"),
      createdBy: optionValue(argv, "--created-by"),
      layerId: optionValue(argv, "--layer") ?? optionValue(argv, "--layer-id"),
      edge: optionValue(argv, "--edge")
    };
  }
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

function parseBooleanOption(value: string): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function parseStrictBooleanOption(value: string): boolean | undefined {
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return undefined;
}

// `debugAgentRuntime`, `fakeAgentRuntime` and `fakeAdapter` used to live here: a stubbed
// `shellx-motion-fake-agent` selected by `--adapter fake`, reporting itself ready in the same JSON a
// real probe produces. Removed with the tool-provenance invariant — scripted adapters now come from
// `packages/cli/src/main.test-support.ts` through `RunCliOptions.agentRuntime`, so the shipped
// binary cannot manufacture an agent, and a caller that wants one has to say so in code. The
// refusal for the removed flags lives in `./retired-options`.

export function normalizeWindowsExtendedPath(path: string): string {
  return path
    .replace(/^\\+\?\\+UNC\\+/i, "\\\\")
    .replace(/^\\+\?\\+/, "");
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

function resolveInputPath(path: string): string {
  const normalizedPath = normalizeWindowsExtendedPath(path);
  if (isAbsolute(normalizedPath) || isWindowsAbsolutePath(normalizedPath)) return normalizedPath;

  const cwdPath = resolve(normalizedPath);
  if (existsSync(cwdPath)) return cwdPath;

  return process.env.INIT_CWD ? resolve(process.env.INIT_CWD, normalizedPath) : cwdPath;
}

function resolveOutputPath(path: string): string {
  const normalizedPath = normalizeWindowsExtendedPath(path);
  if (isAbsolute(normalizedPath) || isWindowsAbsolutePath(normalizedPath)) return normalizedPath;
  return process.env.INIT_CWD ? resolve(process.env.INIT_CWD, normalizedPath) : resolve(normalizedPath);
}

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeHostReceiptFile(receiptsRoot: string, receipt: OperationReceipt): Promise<string> {
  await mkdir(receiptsRoot, { recursive: true });
  const receiptPath = join(receiptsRoot, `${safeFileToken(receipt.id)}.receipt.json`);
  await writeJson(receiptPath, receipt);
  return receiptPath;
}

function mediaTypeForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return undefined;
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

if (isDirectEntry(import.meta.url, process.argv[1])) {
  await main();
}
