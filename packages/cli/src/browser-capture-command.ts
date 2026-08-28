import { lstat, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  acquireDerivedOutputPublication,
  activeScriptLayers,
  hashFile,
  loadMotionPackage,
  prepareBrowserWorkflowCatalogUpsert,
  type BrowserRecordingManifest,
  type MotionPackage,
  type ReceiptArtifact
} from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import { BrowserWorkflowReplayError, createMotionBrowserRenderSession, type BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import { browserWorkflowDriftWarning } from "./render-receipt-file";
import { resolveCallerId } from "./caller-identity";
import { activeScriptCliRefusal } from "./agent-script-cli-refusal";
import { readBrowserCaptureWorkflow } from "./browser-workflow-decode";
import { captureBundleRelativePath, captureCatalogIsExternal, capturePathsOverlap, closedCaptureBundleInventory, mapCaptureBundleArtifacts } from "./browser-capture-bundle-paths";
import {
  assertCaptureBundleOutput,
  captureBrowserRecording,
  publishAfterBrowserCaptureSessionClose,
  publishBrowserCaptureFailureBundle,
  readPositiveCaptureInteger,
  replayFailureReceipt,
  type CaptureCliResult
} from "./browser-capture-recording";
import { throwIfCancelled } from "./render-cancelled";
import { DirectoryBundleCommitUncertainError, publishGovernedDirectoryBundle } from "./governed-directory-delivery";
import { resolveCliInputPath as resolveInputPath, resolveCliOutputPath as resolveOutputPath } from "./cli-path-resolution";

export interface BrowserCaptureCommandOptions {
  browserFrameRenderer?: BrowserFrameRenderer;
  signal?: AbortSignal;
  callerId?: string;
}

export async function captureBrowserCommand(argv: string[], options: BrowserCaptureCommandOptions = {}): Promise<CaptureCliResult> {
  const callerIdForRun = resolveCallerId(argv, options);
  const root = argv[0];
  if (!root) return missingArgument("capture-browser", "package root");
  const outDir = optionValue(argv, "--out");
  if (!outDir) return missingArgument("capture-browser", "--out");
  const pkg = await loadMotionPackage(resolveInputPath(root));
  if (activeScriptLayers(pkg.motion).length > 0) return activeScriptCliRefusal("capture-browser");
  const outputDir = resolveOutputPath(outDir);
  const workflowPath = optionValue(argv, "--workflow");
  const workflow = workflowPath ? await readBrowserCaptureWorkflow(resolveInputPath(workflowPath)) : undefined;
  const workflowCatalogRef = optionValue(argv, "--catalog") ?? optionValue(argv, "--workflow-catalog") ?? optionValue(argv, "--workflow-catalog-path");
  const workflowCatalogPath = workflowCatalogRef ? resolveOutputPath(workflowCatalogRef) : undefined;
  if (workflowCatalogPath && !captureCatalogIsExternal(outputDir, workflowCatalogPath)) {
    return { ok: false, command: "capture-browser", error: { code: "invalid_args", message: "--catalog must be an external post-commit observer, not a leaf inside --out." } };
  }
  const failOnDrift = hasFlag(argv, "--fail-on-drift");
  const recordingManifestRef = optionValue(argv, "--recording-manifest") ?? optionValue(argv, "--recording-manifest-path");
  const recordingManifestPath = recordingManifestRef ? resolveOutputPath(recordingManifestRef) : undefined;
  const recordingFramesDir = recordingManifestPath ? resolveOutputPath(optionValue(argv, "--recording-frames-dir") ?? join(outputDir, "browser-recording-frames")) : undefined;
  const sampleCount = readPositiveCaptureInteger(optionValue(argv, "--recording-samples") ?? optionValue(argv, "--recording-sample-count"), "--recording-samples", 3);
  if (!sampleCount.ok) return sampleCount.result;
  const atMs = Number(optionValue(argv, "--at-ms") ?? 0);
  if (!Number.isFinite(atMs) || atMs < 0) return { ok: false, command: "capture-browser", error: { code: "invalid_args", message: "--at-ms must be a non-negative finite number." } };

  const primaryRelativePath = `${pkg.manifest.id}-browser-${atMs}.png`;
  const traceRelativePath = `${pkg.manifest.id}-browser-workflow.trace.json`;
  const receiptRelativePath = `${pkg.manifest.id}-browser-capture.receipt.json`;
  const manifestRelativePath = recordingManifestPath ? captureBundleRelativePath(outputDir, recordingManifestPath) : undefined;
  const framesRelativePath = recordingFramesDir ? captureBundleRelativePath(outputDir, recordingFramesDir) : undefined;
  if ((recordingManifestPath && !manifestRelativePath) || (recordingFramesDir && !framesRelativePath)
    || (manifestRelativePath && framesRelativePath && capturePathsOverlap(manifestRelativePath, framesRelativePath))
    || (framesRelativePath && capturePathsOverlap(framesRelativePath, "browser-capture-html"))
    || (manifestRelativePath && capturePathsOverlap(manifestRelativePath, "browser-capture-html"))
    || (framesRelativePath && [primaryRelativePath, traceRelativePath, receiptRelativePath].some((path) => capturePathsOverlap(framesRelativePath, path)))
    || (manifestRelativePath && [primaryRelativePath, traceRelativePath, receiptRelativePath].some((path) => capturePathsOverlap(manifestRelativePath, path)))) {
    return { ok: false, command: "capture-browser", error: { code: "invalid_args", message: "Recording manifest and frames must be distinct paths strictly below --out and cannot overlap capture bundle leaves." } };
  }

  const publication = await acquireDerivedOutputPublication({ outputPath: outputDir, kind: "directory" });
  let preparedCatalog: Awaited<ReturnType<typeof prepareBrowserWorkflowCatalogUpsert>> | undefined;
  let session: Awaited<ReturnType<typeof createMotionBrowserRenderSession>> | undefined;
  const closeSession = async () => {
    const current = session;
    session = undefined;
    await current?.close();
  };
  try {
    session = options.browserFrameRenderer ? undefined : await createMotionBrowserRenderSession(pkg, callerIdForRun ? { callerId: callerIdForRun } : {});
    const renderer: BrowserFrameRenderer = options.browserFrameRenderer ?? ((_pkg, frameOptions) => session!.renderFrame(frameOptions));
    let result: Awaited<ReturnType<BrowserFrameRenderer>>;
    try {
      throwIfCancelled(options.signal, "browser capture before primary frame");
      result = await renderer(pkg, withRendererPrivateOutputPublication({
        atMs,
        outDir: publication.stagingPath,
        outputPath: join(publication.stagingPath, primaryRelativePath),
        ...(workflow ? { workflow } : {})
      }, publication));
    } catch (error) {
      if (!(error instanceof BrowserWorkflowReplayError)) throw error;
      const tracePath = join(outputDir, traceRelativePath);
      const receipt = replayFailureReceipt({ pkg, trace: error.trace, message: error.message });
      receipt.output = { workflowTracePath: tracePath, workflowTrace: error.trace };
      return await publishAfterBrowserCaptureSessionClose(closeSession, async () => await publishBrowserCaptureFailureBundle({ publication, pkg, ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}), trace: error.trace, workflowTracePath: tracePath, receipt, error: { code: error.code, message: error.message } }));
    }
    const primaryStagePath = join(publication.stagingPath, primaryRelativePath);
    await assertCaptureBundleOutput(result.output.path, primaryStagePath, "primary capture");
    result.output.path = join(outputDir, primaryRelativePath);
    result.output.sha256 = await hashFile(primaryStagePath);
    throwIfCancelled(options.signal, "browser capture after primary frame");
    result.receipt.operation = "browser.workflow.capture";
    const workflowTracePath = result.output.workflowTrace ? join(outputDir, traceRelativePath) : undefined;
    if (workflowTracePath && result.output.workflowTrace) {
      await writeFile(join(publication.stagingPath, traceRelativePath), `${JSON.stringify(result.output.workflowTrace, null, 2)}\n`, "utf8");
      result.output.workflowTracePath = workflowTracePath;
    }
    const receiptPath = join(outputDir, receiptRelativePath);
    const workflowHash = result.output.workflowTrace?.workflowHash ?? result.receipt.inputHashes.workflow;
    if (workflowCatalogPath) {
      if (typeof workflowHash !== "string" || !/^[a-f0-9]{64}$/.test(workflowHash)) {
        await publication.abort();
        return { ok: false, command: "capture-browser", lane: "browser", error: { code: "browser_workflow_catalog_hash_required", message: "--catalog requires a non-empty canonical browser workflow SHA-256." } };
      }
      preparedCatalog = await prepareBrowserWorkflowCatalogUpsert({
        catalogPath: workflowCatalogPath,
        capture: {
          packageId: pkg.manifest.id, workflowHash, atMs: result.output.atMs, outputSha256: result.output.sha256, outputPath: result.output.path, receiptPath,
          ...(workflowTracePath ? { tracePath: workflowTracePath } : {}), createdAt: result.receipt.createdAt, browser: result.output.browser, viewport: result.output.viewport,
          workflow: { stepCount: result.output.workflow?.stepCount ?? 0, networkPolicy: result.output.workflow?.networkPolicy ?? workflow?.networkPolicy ?? "blocked-unless-declared" }
        }
      });
    }
    if (preparedCatalog?.result.drift.status === "changed") result.receipt.warnings.push(browserWorkflowDriftWarning(preparedCatalog.result.drift));
    const changedCatalog = preparedCatalog?.result.drift.status === "changed" ? preparedCatalog : undefined;
    if (changedCatalog && failOnDrift) {
      const drift = changedCatalog.result.drift;
      await changedCatalog.abort();
      await rm(primaryStagePath, { force: true });
      return await publishAfterBrowserCaptureSessionClose(closeSession, async () => await publishBrowserCaptureFailureBundle({
        publication, pkg, ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}), trace: result.output.workflowTrace, workflowTracePath,
        receipt: { ...result.receipt, status: "failed", output: { ...(workflowTracePath ? { workflowTracePath } : {}), ...(result.output.workflowTrace ? { workflowTrace: result.output.workflowTrace } : {}), workflowDrift: drift }, warnings: result.receipt.warnings },
        error: { code: "browser_workflow_drift_detected", message: browserWorkflowDriftWarning(drift) },
        ...(workflowCatalogPath ? { workflowCatalogPath, workflowDrift: drift } : {})
      }));
    }
    let recordingManifest: BrowserRecordingManifest | undefined;
    const rendererArtifacts: ReceiptArtifact[] = collectRendererArtifacts(result);
    if (recordingManifestPath && recordingFramesDir) {
      throwIfCancelled(options.signal, "browser capture before recording samples");
      let recording: Awaited<ReturnType<typeof captureBrowserRecording>>;
      try {
        recording = await captureBrowserRecording({ pkg, renderer, ...(workflow ? { workflow } : {}), framesDir: join(publication.stagingPath, framesRelativePath!), publicFramesDir: recordingFramesDir, manifestPath: join(publication.stagingPath, manifestRelativePath!), sampleCount: sampleCount.value, primaryCapture: result, privateArtifactPublication: publication, ...(workflowTracePath ? { workflowTracePath } : {}), signal: options.signal });
      } catch (error) {
        if (!(error instanceof BrowserWorkflowReplayError)) throw error;
        await preparedCatalog?.abort().catch(() => undefined);
        await publication.abort();
        const failurePublication = await acquireDerivedOutputPublication({ outputPath: outputDir, kind: "directory" });
        const tracePath = join(outputDir, traceRelativePath);
        const receipt = replayFailureReceipt({ pkg, trace: error.trace, message: error.message });
        receipt.output = { workflowTracePath: tracePath, workflowTrace: error.trace };
        return await publishAfterBrowserCaptureSessionClose(closeSession, async () => await publishBrowserCaptureFailureBundle({ publication: failurePublication, pkg, ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}), trace: error.trace, workflowTracePath: tracePath, receipt, error: { code: error.code, message: error.message } }));
      }
      recordingManifest = recording.manifest;
      rendererArtifacts.push(...recording.rendererArtifacts);
      const captureOutput = result.output as typeof result.output & { recordingManifestPath?: string; recordingManifest?: BrowserRecordingManifest };
      captureOutput.recordingManifestPath = recordingManifestPath;
      captureOutput.recordingManifest = recordingManifest;
    }
    const mappedRendererArtifacts = mapCaptureBundleArtifacts(publication.stagingPath, outputDir, dedupeRendererArtifacts(rendererArtifacts));
    const rendererArtifactHashes: Record<string, string> = {};
    for (const mapped of mappedRendererArtifacts) {
      const facts = await lstat(mapped.stagePath);
      if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("Browser renderer companion artifact must remain a regular non-symlink file in the private capture bundle.");
      const hash = await hashFile(mapped.stagePath);
      rendererArtifactHashes[mapped.publicPath] = hash;
      result.receipt.inputHashes[`capture-artifact:${mapped.relativePath}`] = hash;
      if (mapped.artifact.role === "browser_capture_html" && result.receipt.inputHashes["browser-capture-html"] !== undefined && result.receipt.inputHashes["browser-capture-html"] !== hash) {
        throw new Error("Browser capture HTML receipt hash did not match the verified private evidence.");
      }
    }
    const artifacts: ReceiptArtifact[] = dedupeRendererArtifacts([
      { role: "preview_frame", path: result.output.path, status: "available", mediaType: "image/png", primary: true },
      ...mappedRendererArtifacts.map((mapped) => mapped.artifact),
      ...(workflowTracePath ? [{ role: "browser_workflow_trace" as const, path: workflowTracePath, status: "available" as const, mediaType: "application/json" }] : []),
      ...(recordingManifestPath ? [{ role: "browser_recording_manifest" as const, path: recordingManifestPath, status: "available" as const, mediaType: "application/json" }] : []),
      { role: "preview_receipt", path: receiptPath, status: "available" }
    ]);
    result.output.artifacts = artifacts;
    result.receipt.artifacts = artifacts;
    result.receipt.output = { ...result.output, ...(Object.keys(rendererArtifactHashes).length > 0 ? { captureArtifactHashes: rendererArtifactHashes } : {}) };
    await writeFile(join(publication.stagingPath, receiptRelativePath), `${JSON.stringify(result.receipt, null, 2)}\n`, "utf8");
    const inventory = closedCaptureBundleInventory(outputDir, [result.output.path, ...mappedRendererArtifacts.map((mapped) => mapped.publicPath), ...(workflowTracePath ? [workflowTracePath] : []), ...(recordingManifestPath ? [recordingManifestPath] : []), ...(recordingManifest ? recordingManifest.frames.map((frame) => frame.path) : []), receiptPath]);
    throwIfCancelled(options.signal, "browser capture before bundle publication");
    await publishAfterBrowserCaptureSessionClose(closeSession, async () => await publishGovernedDirectoryBundle(publication, inventory));
    let workflowCatalog = preparedCatalog?.result;
    if (preparedCatalog) try { workflowCatalog = await preparedCatalog.commit(); } catch (error) {
      return { ok: false, command: "capture-browser", lane: "browser", captureCommitted: true, ...(workflowCatalogPath ? { workflowCatalogPath } : {}), ...(workflowCatalog ? { workflowDrift: workflowCatalog.drift } : {}), output: result.output, outputPath: result.output.path, receiptId: result.receipt.id, receiptPath, artifacts, warnings: result.receipt.warnings, error: { code: "capture_catalog_update_failed", message: error instanceof Error ? error.message : String(error) } };
    }
    if (workflowCatalog) { result.output.workflowCatalogPath = workflowCatalog.catalogPath; result.output.workflowDrift = workflowCatalog.drift; }
    return {
      ok: true, command: "capture-browser", lane: "browser",
      deterministic: { network: workflow?.networkPolicy ?? "blocked-unless-declared", animations: "disabled", caret: "hide", deviceScaleFactor: result.output.viewport.deviceScaleFactor },
      ...(workflowPath ? { workflowPath: resolveInputPath(workflowPath) } : {}), ...(result.output.workflow ? { workflow: result.output.workflow } : {}), ...(workflowTracePath ? { workflowTracePath } : {}),
      ...(workflowCatalog ? { workflowCatalogPath: workflowCatalog.catalogPath, workflowDrift: workflowCatalog.drift } : {}), ...(recordingManifest ? { recordingManifestPath, recordingManifest } : {}),
      artifacts, output: result.output, outputPath: result.output.path, receiptId: result.receipt.id, receiptPath, warnings: result.receipt.warnings
    };
  } catch (error) {
    await preparedCatalog?.abort().catch(() => undefined);
    await publication.abort().catch(() => undefined);
    if (error instanceof DirectoryBundleCommitUncertainError) {
      return {
        ok: false,
        command: "capture-browser",
        lane: "browser",
        captureCommitUncertain: true,
        possiblyCommitted: true,
        publicationCommitPhase: "output",
        publicPaths: [error.outputPath],
        expectedPublications: [error.expectedPublication],
        outputPath: outputDir,
        receiptPath: join(outputDir, receiptRelativePath),
        error: { code: error.code, message: error.message }
      };
    }
    throw error;
  } finally {
    await closeSession();
  }
}

function collectRendererArtifacts(result: Awaited<ReturnType<BrowserFrameRenderer>>): ReceiptArtifact[] {
  const artifacts = [...(result.output.artifacts ?? []), ...(result.receipt.artifacts ?? [])];
  if (artifacts.some((artifact) => artifact.status !== "available")) {
    throw new Error("Browser capture renderer returned a non-available companion artifact for a successful capture.");
  }
  return artifacts;
}

function dedupeRendererArtifacts(artifacts: readonly ReceiptArtifact[]): ReceiptArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.role}\0${resolve(artifact.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionValue(argv: string[], option: string): string | undefined { const index = argv.indexOf(option); return index >= 0 ? argv[index + 1] : undefined; }
function hasFlag(argv: string[], option: string): boolean { return argv.includes(option); }
function missingArgument(command: string, argument: string): CaptureCliResult { return { ok: false, command, error: { code: "missing_argument", message: `${command} requires ${argument}.` } }; }
