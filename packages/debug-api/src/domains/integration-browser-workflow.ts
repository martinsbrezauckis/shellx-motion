import {
  buildBrowserRecordingManifest,
  browserRecordingSampleTimes,
  hashBuffer,
  MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS,
  MAX_BROWSER_WORKFLOW_WAIT_MS,
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
import { dirname, join } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, nonNegativeNumberArg, objectArg, positiveIntegerArg, stringArg } from "./args.js";

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
  ensureDirectory?: (path: string) => Promise<void>;
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
  readJson?: (path: string) => Promise<unknown>;
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
  if (!services.ensureDirectory) return capabilityUnavailable("Browser capture directory creation is unavailable.");
  if (!services.writeJson) return capabilityUnavailable("Browser capture receipt persistence is unavailable.");
  if (catalogPath && !services.workflowCatalogUpserter) return capabilityUnavailable("Browser workflow catalog persistence is unavailable.");

  const workflowArg = readBrowserWorkflowArg(args, "workflow");
  if (workflowArg === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
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

  let pkg: MotionPackage | undefined;
  try {
    pkg = await services.packageLoader(packageRoot);
    await services.ensureDirectory(outDir);
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
      await services.writeJson(workflowTracePath, capture.output.workflowTrace);
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
        writeJson: services.writeJson,
        ensureDirectory: services.ensureDirectory,
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
    await services.writeJson(receiptPath, capture.receipt);
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
    if (error instanceof BrowserWorkflowReplayError && pkg) {
      return writeDebugBrowserWorkflowReplayFailure({ pkg, outDir, error, writeJson: services.writeJson });
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

export function readBrowserWorkflowArg(args: unknown, key: string): BrowserCaptureWorkflow | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  return parseBrowserWorkflow(record[key]);
}

async function writeDebugBrowserWorkflowReplayFailure(input: {
  pkg: MotionPackage;
  outDir: string;
  error: BrowserWorkflowReplayError;
  writeJson: (path: string, value: unknown) => Promise<void>;
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
  await input.writeJson(workflowTracePath, input.error.trace);
  await input.writeJson(receiptPath, receipt);
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
  writeJson: (path: string, value: unknown) => Promise<void>;
  ensureDirectory: (path: string) => Promise<void>;
  workflowTracePath?: string;
  workflowCatalogPath?: string;
}): Promise<BrowserRecordingManifest> {
  await input.ensureDirectory(input.framesDir);
  const sampleTimes = browserRecordingSampleTimes({ durationMs: input.pkg.motion.durationMs, sampleCount: input.sampleCount });
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
  await input.ensureDirectory(dirname(input.manifestPath));
  await input.writeJson(input.manifestPath, manifest);
  return manifest;
}

function browserWorkflowDriftWarning(drift: BrowserWorkflowDriftSummary): string {
  return `Browser workflow drift detected for ${drift.key}: baseline ${drift.baselineOutputSha256} != current ${drift.currentOutputSha256}.`;
}

export function parseBrowserWorkflow(value: unknown): BrowserCaptureWorkflow | false {
  const record = objectArg(value);
  if (!record
    || !Object.hasOwn(record, "schema")
    || !Object.hasOwn(record, "steps")
    || record.schema !== "shellx-motion/browser-workflow@1"
    || !Array.isArray(record.steps)) return false;
  const steps = readBrowserWorkflowSteps(record.steps);
  if (!steps) return false;
  const viewportValue = Object.hasOwn(record, "viewport") ? record.viewport : undefined;
  const viewport = readBrowserWorkflowViewport(viewportValue);
  if (viewportValue !== undefined && !viewport) return false;
  const networkPolicyValue = Object.hasOwn(record, "networkPolicy") ? record.networkPolicy : undefined;
  const networkPolicy = readBrowserWorkflowNetworkPolicy(networkPolicyValue);
  if (networkPolicyValue !== undefined && !networkPolicy) return false;
  const cursorValue = Object.hasOwn(record, "cursor") ? record.cursor : undefined;
  const cursor = readBrowserWorkflowCursor(cursorValue);
  if (cursorValue !== undefined && !cursor) return false;
  return {
    schema: "shellx-motion/browser-workflow@1",
    steps,
    ...(viewport ? { viewport } : {}),
    ...(networkPolicy ? { networkPolicy } : {}),
    ...(cursor ? { cursor } : {})
  };
}

function readBrowserWorkflowSteps(value: unknown[]): BrowserCaptureWorkflow["steps"] | null {
  const steps: BrowserCaptureWorkflow["steps"] = [];
  let totalWaitMs = 0;
  for (const step of value) {
    const record = objectArg(step);
    if (!record || !Object.hasOwn(record, "action") || typeof record.action !== "string") return null;
    if (record.action === "wait") {
      if (!Object.hasOwn(record, "ms") || typeof record.ms !== "number" || !Number.isFinite(record.ms) || record.ms < 0) return null;
      if (record.ms > MAX_BROWSER_WORKFLOW_WAIT_MS) return null;
      totalWaitMs += record.ms;
      if (totalWaitMs > MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS) return null;
      steps.push({ action: "wait", ms: record.ms });
      continue;
    }
    if (record.action === "click") {
      if (!Object.hasOwn(record, "selector") || typeof record.selector !== "string") return null;
      steps.push({ action: "click", selector: record.selector });
      continue;
    }
    if (record.action === "type") {
      if (!Object.hasOwn(record, "selector") || !Object.hasOwn(record, "text") || typeof record.selector !== "string" || typeof record.text !== "string") return null;
      steps.push({ action: "type", selector: record.selector, text: record.text });
      continue;
    }
    if (record.action === "press") {
      if (!Object.hasOwn(record, "selector") || !Object.hasOwn(record, "key") || typeof record.selector !== "string" || typeof record.key !== "string") return null;
      steps.push({ action: "press", selector: record.selector, key: record.key });
      continue;
    }
    if (record.action === "scroll") {
      const x = Object.hasOwn(record, "x") ? record.x : undefined;
      const y = Object.hasOwn(record, "y") ? record.y : undefined;
      if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x))) return null;
      if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) return null;
      steps.push({
        action: "scroll",
        ...(typeof x === "number" ? { x } : {}),
        ...(typeof y === "number" ? { y } : {})
      });
      continue;
    }
    if (record.action === "verify") {
      const text = Object.hasOwn(record, "text") ? record.text : undefined;
      if (!Object.hasOwn(record, "selector") || typeof record.selector !== "string" || (text !== undefined && typeof text !== "string")) return null;
      steps.push({ action: "verify", selector: record.selector, ...(typeof text === "string" ? { text } : {}) });
      continue;
    }
    return null;
  }
  return steps;
}

function readBrowserWorkflowViewport(value: unknown): BrowserCaptureWorkflow["viewport"] | null {
  const record = objectArg(value);
  if (!record) return null;
  if (!Object.hasOwn(record, "width") || typeof record.width !== "number" || !Number.isFinite(record.width) || record.width <= 0) return null;
  if (!Object.hasOwn(record, "height") || typeof record.height !== "number" || !Number.isFinite(record.height) || record.height <= 0) return null;
  const deviceScaleFactor = Object.hasOwn(record, "deviceScaleFactor") ? record.deviceScaleFactor : undefined;
  if (deviceScaleFactor !== undefined
    && (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0)) return null;
  return {
    width: record.width,
    height: record.height,
    ...(typeof deviceScaleFactor === "number" ? { deviceScaleFactor } : {})
  };
}

function readBrowserWorkflowNetworkPolicy(value: unknown): BrowserCaptureWorkflow["networkPolicy"] | null {
  return value === "blocked-unless-declared" || value === "allow" ? value : null;
}

function readBrowserWorkflowCursor(value: unknown): BrowserCaptureWorkflow["cursor"] | null {
  const record = objectArg(value);
  if (!record) return null;
  const visible = Object.hasOwn(record, "visible") ? record.visible : undefined;
  if (visible !== undefined && typeof visible !== "boolean") return null;
  const cursor: NonNullable<BrowserCaptureWorkflow["cursor"]> = {
    ...(typeof visible === "boolean" ? { visible } : {})
  };
  const cursorPath = Object.hasOwn(record, "path") ? record.path : undefined;
  if (cursorPath !== undefined) {
    if (!Array.isArray(cursorPath)) return null;
    const path: Array<{ x: number; y: number; atMs: number }> = [];
    for (const item of cursorPath) {
      const point = objectArg(item);
      if (!point
        || !Object.hasOwn(point, "x") || !Object.hasOwn(point, "y") || !Object.hasOwn(point, "atMs")
        || typeof point.x !== "number" || !Number.isFinite(point.x)
        || typeof point.y !== "number" || !Number.isFinite(point.y)
        || typeof point.atMs !== "number" || !Number.isFinite(point.atMs) || point.atMs < 0) return null;
      path.push({ x: point.x, y: point.y, atMs: point.atMs });
    }
    cursor.path = path;
  }
  return cursor;
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
