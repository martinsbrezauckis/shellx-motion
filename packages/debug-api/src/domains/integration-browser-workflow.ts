import {
  buildBrowserRecordingManifest,
  browserRecordingSampleTimes,
  hashBuffer,
  isPublicationCommitUncertain,
  OutputDirectoryReservation,
  type BrowserRecordingManifest,
  type BrowserRecordingManifestFrame,
  type BrowserWorkflowDriftSummary,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import {
  BrowserWorkflowReplayError,
  type BrowserCaptureWorkflow,
  type BrowserFrameFormat,
  type BrowserFrameResult
} from "@shellx-motion/renderer-browser";
import { join } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, nonNegativeNumberArg, objectArg, positiveIntegerArg, stringArg } from "./args.js";
import {
  AuthoringRootPolicyError,
  assertConfiguredAuthoringOutputFile,
  assertConfiguredAuthoringOutputRoot
} from "./authoring-root-policy.js";
import { isInsideAnyTrustedInputRoot } from "./trusted-input-path.js";
import { parseBrowserWorkflow, readBrowserWorkflowArg } from "./browser-workflow-parse.js";
export { parseBrowserWorkflow, readBrowserWorkflowArg } from "./browser-workflow-parse.js";

export type BrowserFrameRenderer = (
  pkg: MotionPackage,
  options: {
    atMs: number;
    outDir: string;
    outputPath?: string;
    workflow?: BrowserCaptureWorkflow;
    format?: BrowserFrameFormat;
    now?: () => string;
  }
) => Promise<BrowserFrameResult>;

export interface BrowserWorkflowServices {
  browserFrameRenderer?: BrowserFrameRenderer;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  workflowCatalogUpserter?: (input: {
    catalogPath: string;
    capture: {
      packageId: string;
      workflowHash: string;
      atMs: number;
      outputSha256: string;
      outputPath: string;
      receiptPath: string;
      tracePath?: string;
      createdAt: string;
      browser: BrowserFrameResult["output"]["browser"];
      viewport: BrowserFrameResult["output"]["viewport"];
      workflow: { stepCount: number; networkPolicy: "blocked-unless-declared" | "allow" };
      captureReadiness?: NonNullable<BrowserFrameResult["output"]["captureReadiness"]>;
    };
  }) => Promise<{ catalogPath: string; drift: BrowserWorkflowDriftSummary }>;
  scratchRoot?: string;
  qualityInputRoots?: string[];
  /** Host-configured output roots for caller-selected browser capture evidence. */
  authoringOutputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  readJson?: (path: string) => Promise<unknown>;
  /** Core-owned no-clobber publication for immutable browser workflow evidence. */
  publishJsonSidecar?: (path: string, value: unknown) => Promise<void>;
  writeJson?: (path: string, value: unknown) => Promise<void>;
}

/**
 * Ceiling on `motion.browser.workflow.capture`'s caller-supplied `recordingSampleCount`.
 *
 * Every sample is a real browser render plus a frame written to disk, so this argument does not just
 * size an array -- it sizes the work AND the disk the command consumes. It previously required only
 * "integer >= 1", which let one admitted `render_motion` request expand into arbitrarily many renders
 * and files, bypassing the practical request-size envelope rather than submitting a naturally large
 * job.
 *
 * 240 is a deliberately generous ceiling for a sampled recording (the default is 3) that still keeps
 * the cost of a request legible from the request itself.
 */
const MAX_RECORDING_SAMPLE_COUNT = 240;

export async function dispatchBrowserWorkflowCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: BrowserWorkflowServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.browser.workflow.capture") return null;

  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? services.scratchRoot ?? ".scratch/debug-browser-workflow";
  const outputPath = stringArg(args, "outputPath") ?? undefined;
  const atMs = nonNegativeNumberArg(args, "atMs") ?? 0;
  const catalogPath = stringArg(args, "catalogPath") ?? stringArg(args, "workflowCatalogPath") ?? undefined;
  const failOnDrift = booleanArg(args, "failOnDrift") ?? false;
  const recordingManifestPath = stringArg(args, "recordingManifestPath") ?? undefined;
  const recordingFramesDir = stringArg(args, "recordingFramesDir")
    ?? (recordingManifestPath ? join(outDir, "browser-recording-frames") : undefined);
  const recordingSampleCountArg = positiveIntegerArg(args, "recordingSampleCount");
  if (!packageRoot) return invalidArgs("motion.browser.workflow.capture requires packageRoot.");
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (recordingSampleCountArg === false) return invalidArgs("recordingSampleCount must be a positive integer.");
  if (typeof recordingSampleCountArg === "number" && recordingSampleCountArg > MAX_RECORDING_SAMPLE_COUNT) {
    return invalidArgs(`recordingSampleCount must be ${MAX_RECORDING_SAMPLE_COUNT} or fewer.`);
  }
  if (!services.browserFrameRenderer) return capabilityUnavailable("Browser frame rendering is unavailable.");
  if (!services.packageLoader) return capabilityUnavailable("Motion package loading is unavailable.");
  const publishSidecar = services.publishJsonSidecar;
  if (!publishSidecar) return capabilityUnavailable("Browser capture receipt persistence is unavailable.");
  if (catalogPath && !services.workflowCatalogUpserter) return capabilityUnavailable("Browser workflow catalog persistence is unavailable.");

  const workflowArg = readBrowserWorkflowArg(args, "workflow");
  if (workflowArg === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
  if (workflowPath) {
    if (!services.isPathInsideTrustedRoot) return capabilityUnavailable("Browser workflow trusted-path validation is unavailable.");
    const roots = [packageRoot, services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? [])];
    if (!await isInsideAnyTrustedInputRoot(workflowPath, roots, services.isPathInsideTrustedRoot)) {
      return invalidArgs("motion.browser.workflow.capture workflowPath must be inside packageRoot or a trusted debug input root.");
    }
  }
  if (workflowPath && !services.readJson) return capabilityUnavailable("Browser workflow file reading is unavailable.");
  let workflow = workflowArg ?? undefined;
  if (!workflow && workflowPath) {
    try {
      const parsedWorkflow = parseBrowserWorkflow(await services.readJson!(workflowPath));
      if (!parsedWorkflow) return invalidArgs("Invalid browser workflow: expected shellx-motion/browser-workflow@1.");
      workflow = parsedWorkflow;
    } catch (error) {
      return invalidArgs(`Invalid browser workflow: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const outputPolicyRefusal = await browserWorkflowOutputPolicy({
    outDir
  }, services);
  if (outputPolicyRefusal) return outputPolicyRefusal;

  let pkg: MotionPackage | undefined;
  try {
    pkg = await services.packageLoader(packageRoot);
    const captureOutput = await OutputDirectoryReservation.acquire(outDir, { allowExistingContents: true });
    const auxiliaryOutputRefusal = await browserWorkflowAuxiliaryOutputPolicy({
      outDir,
      ...(outputPath ? { outputPath } : {}),
      ...(catalogPath ? { catalogPath } : {}),
      ...(recordingManifestPath ? { recordingManifestPath } : {}),
      ...(recordingFramesDir ? { recordingFramesDir } : {})
    }, services);
    if (auxiliaryOutputRefusal) return auxiliaryOutputRefusal;
    const recordingFramesOutput = recordingFramesDir
      ? await OutputDirectoryReservation.acquire(recordingFramesDir, { allowExistingContents: true })
      : undefined;
    await captureOutput.assertCurrent();
    const capture = await services.browserFrameRenderer(pkg, {
      atMs,
      outDir,
      ...(outputPath ? { outputPath } : {}),
      ...(workflow ? { workflow } : {})
    });
    capture.receipt.operation = "browser.workflow.capture";
    const workflowTracePath = capture.output.workflowTrace
      ? join(outDir, `${pkg.manifest.id}-browser-workflow.trace.json`)
      : undefined;
    if (workflowTracePath && capture.output.workflowTrace) {
      await captureOutput.assertCurrent();
      await publishSidecar(workflowTracePath, capture.output.workflowTrace);
      capture.output.workflowTracePath = workflowTracePath;
    }
    const receiptPath = join(outDir, `${pkg.manifest.id}-browser-capture.receipt.json`);
    const captureReadiness = capture.output.workflowTrace?.captureReadiness ?? capture.output.captureReadiness;
    const workflowCatalog = catalogPath
      ? await services.workflowCatalogUpserter!({
          catalogPath,
          capture: {
            packageId: pkg.manifest.id,
            workflowHash: capture.output.workflowTrace?.workflowHash ?? String(capture.receipt.inputHashes.workflow ?? ""),
            atMs: capture.output.atMs,
            outputSha256: capture.output.sha256,
            outputPath: capture.output.path,
            receiptPath,
            ...(workflowTracePath ? { tracePath: workflowTracePath } : {}),
            createdAt: capture.receipt.createdAt,
            browser: capture.output.browser,
            viewport: capture.output.viewport,
            workflow: {
              stepCount: capture.output.workflow?.stepCount ?? 0,
              networkPolicy: capture.output.workflow?.networkPolicy ?? workflow?.networkPolicy ?? "blocked-unless-declared"
            },
            ...(captureReadiness ? { captureReadiness } : {})
          }
        })
      : undefined;
    if (workflowCatalog) {
      capture.output.workflowCatalogPath = workflowCatalog.catalogPath;
      capture.output.workflowDrift = workflowCatalog.drift;
      if (workflowCatalog.drift.status === "changed") {
        capture.receipt.warnings.push(browserWorkflowDriftWarning(workflowCatalog.drift));
      }
    }
    let recordingManifest: BrowserRecordingManifest | undefined;
    if (recordingManifestPath && recordingFramesDir) {
      recordingManifest = await writeDebugBrowserRecordingManifest({
        pkg,
        renderer: services.browserFrameRenderer,
        workflow,
        framesDir: recordingFramesDir,
        manifestPath: recordingManifestPath,
        sampleCount: recordingSampleCountArg ?? 3,
        primaryCapture: capture,
        publishJsonSidecar: publishSidecar,
        framesOutput: recordingFramesOutput!,
        ...(workflowTracePath ? { workflowTracePath } : {}),
        ...(workflowCatalog ? { workflowCatalogPath: workflowCatalog.catalogPath } : {})
      });
      const output = capture.output as typeof capture.output & {
        recordingManifestPath?: string;
        recordingManifest?: BrowserRecordingManifest;
      };
      output.recordingManifestPath = recordingManifestPath;
      output.recordingManifest = recordingManifest;
    }
    const artifacts: ReceiptArtifact[] = [
      { role: "preview_frame", path: capture.output.path, status: "available", mediaType: "image/png", primary: true }
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
    artifacts.push({ role: "preview_receipt", path: receiptPath, status: "available", mediaType: "application/json" });
    capture.output.artifacts = artifacts;
    capture.receipt.artifacts = artifacts;
    capture.receipt.output = {
      ...(objectArg(capture.receipt.output) ?? {}),
      ...capture.output
    };
    await captureOutput.assertCurrent();
    await publishSidecar(receiptPath, capture.receipt);
    const result = {
      ok: true,
      command: "browser.workflow.capture",
      lane: "browser",
      deterministic: {
        network: workflow?.networkPolicy ?? "blocked-unless-declared",
        animations: "disabled",
        caret: "hide",
        deviceScaleFactor: capture.output.viewport.deviceScaleFactor
      },
      ...(workflowPath ? { workflowPath } : {}),
      ...(capture.output.workflow ? { workflow: capture.output.workflow } : {}),
      ...(workflowTracePath ? { workflowTracePath } : {}),
      ...(workflowCatalog ? { workflowCatalogPath: workflowCatalog.catalogPath, workflowDrift: workflowCatalog.drift } : {}),
      ...(recordingManifest ? { recordingManifestPath, recordingManifest } : {}),
      artifacts,
      output: capture.output,
      outputPath: capture.output.path,
      receiptId: capture.receipt.id,
      receiptPath,
      warnings: capture.receipt.warnings
    };
    if (workflowCatalog?.drift.status === "changed" && failOnDrift) {
      return {
        ok: false,
        error: {
          code: "browser_workflow_drift_detected",
          message: browserWorkflowDriftWarning(workflowCatalog.drift),
          detail: {
            workflowCatalogPath: workflowCatalog.catalogPath,
            workflowDrift: workflowCatalog.drift,
            outputPath: capture.output.path,
            receiptId: capture.receipt.id,
            receiptPath,
            artifacts
          }
        },
        warnings: capture.receipt.warnings
      };
    }
    return {
      ok: true,
      receiptId: capture.receipt.id,
      visibleState: {
        panel: "preview",
        operation: "browser.workflow.capture",
        packageId: pkg.manifest.id,
        outputPath: capture.output.path,
        ...(workflowTracePath ? { workflowTracePath } : {}),
        ...(workflowCatalog ? { workflowCatalogPath: workflowCatalog.catalogPath, workflowDriftStatus: workflowCatalog.drift.status } : {}),
        ...(recordingManifestPath ? { recordingManifestPath } : {})
      },
      result,
      warnings: capture.receipt.warnings
    };
  } catch (error) {
    if (isPublicationCommitUncertain(error)) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          detail: { possiblyCommitted: true, publicPaths: [error.evidence.publicPath], expected: error.evidence }
        },
        result: { possiblyCommitted: true, publicPaths: [error.evidence.publicPath], expected: error.evidence },
        warnings: []
      };
    }
    if (error instanceof BrowserWorkflowReplayError && pkg) {
      return writeDebugBrowserWorkflowReplayFailure({ pkg, outDir, error, publishJsonSidecar: publishSidecar });
    }
    return {
      ok: false,
      error: {
        code: "browser_workflow_capture_failed",
        message: error instanceof Error ? error.message : String(error)
      },
      warnings: []
    };
  }
}

async function writeDebugBrowserWorkflowReplayFailure(input: {
  pkg: MotionPackage;
  outDir: string;
  error: BrowserWorkflowReplayError;
  publishJsonSidecar: (path: string, value: unknown) => Promise<void>;
}): Promise<MotionDebugResult> {
  const workflowTracePath = join(input.outDir, `${input.pkg.manifest.id}-browser-workflow.trace.json`);
  const receiptPath = join(input.outDir, `${input.pkg.manifest.id}-browser-capture.receipt.json`);
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
    output: { workflowTracePath, workflowTrace: input.error.trace },
    artifacts,
    warnings: [input.error.message]
  };
  await input.publishJsonSidecar(workflowTracePath, input.error.trace);
  await input.publishJsonSidecar(receiptPath, receipt);
  return {
    ok: false,
    error: {
      code: input.error.code,
      message: input.error.message,
      detail: { workflowTracePath, workflowTrace: input.error.trace, receiptId: receipt.id, receiptPath, artifacts }
    },
    warnings: receipt.warnings
  };
}

async function writeDebugBrowserRecordingManifest(input: {
  pkg: MotionPackage;
  renderer: BrowserFrameRenderer;
  workflow?: BrowserCaptureWorkflow;
  framesDir: string;
  manifestPath: string;
  sampleCount: number;
  primaryCapture: Awaited<ReturnType<BrowserFrameRenderer>>;
  publishJsonSidecar: (path: string, value: unknown) => Promise<void>;
  framesOutput: OutputDirectoryReservation;
  workflowTracePath?: string;
  workflowCatalogPath?: string;
}): Promise<BrowserRecordingManifest> {
  await input.framesOutput.assertCurrent();
  const sampleTimes = browserRecordingSampleTimes({ durationMs: input.pkg.motion.durationMs, sampleCount: input.sampleCount });
  const frames: BrowserRecordingManifestFrame[] = [];
  for (const [index, atMs] of sampleTimes.entries()) {
    const outputPath = join(input.framesDir, `${String(index).padStart(6, "0")}.png`);
    await input.framesOutput.assertCurrent();
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
  const captureReadiness = input.primaryCapture.output.workflowTrace?.captureReadiness
    ?? input.primaryCapture.output.captureReadiness;
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
    ...(captureReadiness ? { captureReadiness } : {}),
    ...(workflow ? { workflow } : {})
  });
  await input.publishJsonSidecar(input.manifestPath, manifest);
  return manifest;
}

async function browserWorkflowOutputPolicy(
  input: { outDir: string },
  services: BrowserWorkflowServices
): Promise<MotionDebugResult | null> {
  try {
    if (services.authoringOutputRoots !== undefined) {
      await assertConfiguredAuthoringOutputRoot(input.outDir, services.authoringOutputRoots, "Browser workflow output");
      return null;
    }

    // A render_motion host without authoring roots still has a host-owned capture root. Its
    // default capture directory remains usable, while optional evidence stays subordinate to the
    // admitted capture directory instead of becoming an arbitrary secondary write authority.
    if (!services.isPathInsideTrustedRoot) {
      return capabilityUnavailable("Browser workflow output path policy is unavailable.");
    }
    const captureRoot = services.scratchRoot ?? ".scratch/debug-browser-workflow";
    if (!await services.isPathInsideTrustedRoot(captureRoot, input.outDir)) {
      return invalidArgs("Browser workflow output must be inside the trusted debug capture root.");
    }
    return null;
  } catch (error) {
    if (error instanceof AuthoringRootPolicyError) return invalidArgs(error.message);
    throw error;
  }
}

async function browserWorkflowAuxiliaryOutputPolicy(
  input: {
    outDir: string;
    outputPath?: string;
    catalogPath?: string;
    recordingManifestPath?: string;
    recordingFramesDir?: string;
  },
  services: BrowserWorkflowServices
): Promise<MotionDebugResult | null> {
  try {
    // render_motion owns one admitted capture directory, not a generic write capability over the
    // wider host root. Traces, receipts, manifests, and frame samples stay co-located with their
    // capture. The mutable catalog is deliberately separate: it must stay under the dedicated
    // host-owned scratch root so an admitted capture directory never grants force-update access
    // to arbitrary pre-existing JSON within a broad authoring root.
    if (input.outputPath) await assertConfiguredAuthoringOutputFile(input.outputPath, [input.outDir], "Browser workflow output file");
    if (input.recordingManifestPath) await assertConfiguredAuthoringOutputFile(input.recordingManifestPath, [input.outDir], "Browser recording manifest");
    if (input.recordingFramesDir) await assertConfiguredAuthoringOutputRoot(input.recordingFramesDir, [input.outDir], "Browser recording frames");
    if (input.catalogPath) {
      const catalogRoot = services.scratchRoot ?? ".scratch/debug-browser-workflow";
      await assertConfiguredAuthoringOutputFile(input.catalogPath, [catalogRoot], "Browser workflow catalog");
    }
    return null;
  } catch (error) {
    if (error instanceof AuthoringRootPolicyError) {
      return invalidArgs("Browser workflow auxiliary output must be inside the admitted capture output directory or trusted debug scratch root.");
    }
    throw error;
  }
}

function browserWorkflowDriftWarning(drift: BrowserWorkflowDriftSummary): string {
  return `Browser workflow drift detected for ${drift.key}: baseline ${drift.baselineOutputSha256} != current ${drift.currentOutputSha256}.`;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}
