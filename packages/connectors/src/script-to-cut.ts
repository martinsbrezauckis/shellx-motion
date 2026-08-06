import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import { attachRenderedMediaToCutPlan, placeRenderedMediaInCutPlan, planCutImport, type CutRenderedMediaPlacement } from "@shellx-motion/adapters-cut";
import { hashBuffer, loadMotionPackage, type MotionPackage, type OperationReceipt,
  assertOutputDirGuard,
  prepareFramesDir,
} from "@shellx-motion/core";
import { encodeImageSequenceWithPolicy, type FfmpegCommand, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { renderNativePreviewFrame } from "@shellx-motion/renderer-native";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, connectorArtifactStagingPath, finalizeConnectorArtifactHandle, publishConnectorArtifact } from "./artifact-handle";
import { cutTargetCapabilitiesForMode, type CutImportModeRequest } from "./cut-import-mode";
import { assertConnectorOutputOwnership } from "./output-ownership";
import { resolveConnectorPath } from "./path-utils";

export interface ScriptToCutConnectorInput {
  scriptPath: string;
  outDir: string;
  /**
   * Overwrite the directories this connector owns under a non-empty `--out`. Off by default:
   * `outDir` is caller-supplied, so a `package/` there is NOT evidence that Motion created it.
   */
  force?: boolean;
  previewLane?: "native";
  renderLane?: "ffmpeg";
  dryRunRender?: boolean;
  cutImportMode?: CutImportModeRequest;
  cutPlacement?: CutRenderedMediaPlacement;
  receiptOperation?: "connector.script_to_cut" | "connector.cut_generate_to_cut";
  ffmpegRunner?: FfmpegRunner;
  now?: () => string;
}

export interface ScriptToCutConnectorResult {
  ok: boolean;
  packageDir: string;
  preview: { ok: boolean; lane: "native"; failureFatal: boolean; receiptPath: string; outputPath: string | null };
  render: {
    ok: boolean;
    required: boolean;
    dryRun: boolean;
    lane: "ffmpeg";
    frameLane?: "browser";
    receiptPath: string;
    outputPath?: string;
  };
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

export async function runScriptToCutConnector(input: ScriptToCutConnectorInput): Promise<ScriptToCutConnectorResult> {
  const previewLane = input.previewLane ?? "native";
  const renderLane = input.renderLane ?? "ffmpeg";
  const dryRunRender = input.dryRunRender ?? true;
  const createdAt = input.now?.() ?? new Date().toISOString();
  if (previewLane !== "native") {
    throw new Error(`Unsupported connector preview lane: ${previewLane}`);
  }
  if (renderLane !== "ffmpeg") {
    throw new Error(`Unsupported connector render lane: ${renderLane}`);
  }

  const outDir = resolveConnectorPath(input.outDir);
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const previewPath = join(outDir, "preview", "native-0.png");
  const previewReceiptPath = join(receiptDir, "native-preview.receipt.json");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const connectorReceiptPath = join(outDir, "connector-run.receipt.json");
  const scriptPath = resolveConnectorPath(input.scriptPath);
  const scriptBytes = await readFile(scriptPath);
  const script: unknown = JSON.parse(scriptBytes.toString("utf8"));

  // the output-ownership invariant: this connector wrote a whole Motion package into `<out>/package` with no guard at all,
  // replacing a caller's own manifest.json and still reporting ok:true. Same rule as every other
  // connector now, checked before anything is created.
  await assertConnectorOutputOwnership({
    packageDir,
    ownedDirs: [receiptDir, join(outDir, "preview"), join(outDir, "render"), join(outDir, "artifacts")],
    ownedFiles: [cutPlanPath, connectorReceiptPath],
    force: input.force === true
  });
  await mkdir(receiptDir, { recursive: true });
  await mkdir(join(outDir, "preview"), { recursive: true });

  const scriptedExport = convertScriptedFramesToMotionPackage(script, {
    createdAt,
    inputPath: scriptPath
  });
  await writeScriptedMotionPackage(scriptedExport, { packageDir });

  const preview = await renderNativePreviewFrame({
    packageRoot: packageDir,
    outputPath: previewPath,
    outputRoots: [outDir],
    atMs: 0,
    now: () => createdAt
  });
  await writeJson(previewReceiptPath, preview.receipt);

  const pkg = await loadMotionPackage(packageDir);
  const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.mp4`);
  const framesDir = join(outDir, "frames", pkg.manifest.id);
  const baseCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({
    targetId: "shellx-cut",
    mode: input.cutImportMode ?? "rendered_media"
  }));
  const plannedCutImport = input.cutPlacement
    ? placeRenderedMediaInCutPlan(baseCutImport, input.cutPlacement)
    : baseCutImport;
  const renderRequired = plannedCutImport.mode === "rendered_media";
  const operationHash = connectorArtifactOperationHash({
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    preset: "mp4-h264",
    plan: plannedCutImport
  });
  const renderResult = !renderRequired
    ? {
        required: false,
        frameLane: undefined,
        receipt: createRenderNotRequiredReceipt({
          packageId: pkg.manifest.id,
          motionHash: hashBuffer(Buffer.from(JSON.stringify(pkg.motion), "utf8")),
          createdAt,
          mode: plannedCutImport.mode
        })
      }
    : dryRunRender
    ? {
        required: true,
        frameLane: undefined,
        receipt: createDryRunRenderReceipt({
          packageId: pkg.manifest.id,
          motionHash: hashBuffer(Buffer.from(JSON.stringify(pkg.motion), "utf8")),
          createdAt,
          framesDir,
          fps: pkg.motion.fps,
          durationMs: pkg.motion.durationMs,
          outputPath: renderOutputPath
        })
      }
    : await renderRealBrowserFfmpegArtifact({
        pkg,
        packageDir,
        packageId: pkg.manifest.id,
        durationMs: pkg.motion.durationMs,
        fps: pkg.motion.fps,
        width: pkg.motion.width,
        height: pkg.motion.height,
        framesDir,
        outputPath: renderOutputPath,
        createdAt,
        // the explicit-force invariant: `force` was declared on this input and never set by any caller, so the refusal told
        // agents to "pass --force" for a flag that could not reach the guard.
        force: input.force === true,
        runner: input.ffmpegRunner
      });
  const renderReceipt = renderResult.receipt;
  renderReceipt.inputHashes = { ...renderReceipt.inputHashes, operation: operationHash };
  const renderOk = renderReceipt.status !== "failed";
  await writeJson(renderReceiptPath, renderReceipt);

  let cutPlan = renderRequired && dryRunRender
    ? attachRenderedMediaToCutPlan(plannedCutImport, {
      plannedPath: renderOutputPath,
      receiptPath: renderReceiptPath,
      dryRun: true
    })
    : plannedCutImport;

  const warnings = [...preview.warnings, ...renderReceipt.warnings, ...cutPlan.receipt.warnings];
  const previewFailureFatal = renderRequired && dryRunRender && !preview.ok;
  const artifacts = scriptToCutArtifacts({
    scriptPath,
    packageDir,
    previewPath,
    previewOk: preview.ok,
    previewReceiptPath,
    renderRequired,
    renderDryRun: dryRunRender,
    renderOk,
    renderOutputPath,
    renderReceiptPath,
    cutPlanPath,
    connectorReceiptPath,
    artifactHandlePath: renderRequired && !dryRunRender && renderOk ? artifactHandlePath : undefined
  });
  const connectorReceipt = createConnectorReceipt({
    packageId: pkg.manifest.id,
    createdAt,
    inputPath: scriptPath,
    inputHash: hashBuffer(scriptBytes),
    packageDir,
    previewOk: preview.ok,
    previewFailureFatal,
    previewReceiptPath,
    renderOk,
    renderReceiptPath,
    renderRequired,
    renderDryRun: dryRunRender,
    renderFrameLane: renderResult.frameLane,
    renderOutputPath: renderRequired ? renderOutputPath : undefined,
    cutOk: cutPlan.ok,
    cutMode: cutPlan.mode,
    cutPlanPath,
    artifacts,
    warnings,
    operationHash,
    operation: input.receiptOperation ?? "connector.script_to_cut"
  });
  await writeJson(connectorReceiptPath, connectorReceipt);

  if (renderRequired && !dryRunRender && renderOk) {
    const finalized = await finalizeConnectorArtifactHandle({
      root: outDir,
      descriptorPath: artifactHandlePath,
      artifactPath: renderOutputPath,
      renderReceiptPath,
      connectorReceiptPath,
      pkg,
      operationHash,
      preset: "mp4-h264",
      mediaType: "video/mp4",
      createdAt
    });
    cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, {
      dryRun: false,
      handle: finalized.reference
    });
  }
  await writeJson(cutPlanPath, cutPlan);

  return {
    ok: !previewFailureFatal && cutPlan.ok && renderOk,
    packageDir,
    preview: {
      ok: preview.ok,
      lane: "native",
      failureFatal: previewFailureFatal,
      receiptPath: previewReceiptPath,
      outputPath: preview.ok ? preview.frame.path : null
    },
    render: {
      ok: renderOk,
      required: renderRequired,
      dryRun: renderRequired ? dryRunRender : true,
      lane: "ffmpeg",
      frameLane: renderResult.frameLane,
      receiptPath: renderReceiptPath,
      ...(renderRequired ? { outputPath: renderOutputPath } : {})
    },
    cutPlanPath,
    artifacts,
    receiptPath: connectorReceiptPath,
    warnings
  };
}

function scriptToCutArtifacts(input: {
  scriptPath: string;
  packageDir: string;
  previewPath: string;
  previewOk: boolean;
  previewReceiptPath: string;
  renderRequired: boolean;
  renderDryRun: boolean;
  renderOk: boolean;
  renderOutputPath: string;
  renderReceiptPath: string;
  cutPlanPath: string;
  connectorReceiptPath: string;
  artifactHandlePath?: string;
}): ConnectorArtifact[] {
  const artifacts: ConnectorArtifact[] = [
    { role: "scripted_video", path: input.scriptPath, status: "available" },
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "preview_frame", path: input.previewPath, status: input.previewOk ? "available" : "planned", mediaType: "image/png" },
    { role: "preview_receipt", path: input.previewReceiptPath, status: "available" },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "cut_plan", path: input.cutPlanPath, status: "available", primary: !input.renderRequired },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
  if (input.renderRequired) {
    artifacts.splice(4, 0, {
      role: "rendered_media",
      path: input.renderOutputPath,
      status: !input.renderOk ? "failed" : input.renderDryRun ? "planned" : "available",
      mediaType: "video/mp4",
      primary: true
    });
  }
  if (input.artifactHandlePath) {
    artifacts.push({
      role: "artifact_handle",
      path: input.artifactHandlePath,
      status: "available",
      mediaType: "application/vnd.shellx-motion.artifact-handle+json"
    });
  }
  return artifacts;
}

function createDryRunRenderReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  framesDir: string;
  fps: number;
  durationMs: number;
  outputPath: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `render-dry-run-${hashBuffer(Buffer.from(`${input.packageId}:${input.outputPath}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "not_run",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      dryRun: true,
      command: {
        executable: "ffmpeg",
        args: [
          "-y",
          "-framerate",
          String(input.fps),
          "-start_number",
          "1",
          "-i",
          join(input.framesDir, "%06d.png"),
          "-frames:v",
          String(frameCountFor(input.durationMs, input.fps)),
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          input.outputPath
        ],
        shell: false
      }
    },
    warnings: []
  };
}

function createRenderNotRequiredReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  mode: string | null;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `render-not-required-${hashBuffer(Buffer.from(`${input.packageId}:${input.mode ?? "none"}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "not_run",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      required: false,
      reason: input.mode
        ? `Cut import mode ${input.mode} does not require rendered media.`
        : "Cut import planning found no applicable mode; rendered media was not run for the failed explicit handoff."
    },
    warnings: []
  };
}

async function renderRealBrowserFfmpegArtifact(input: {
  pkg: MotionPackage;
  packageDir: string;
  packageId: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  framesDir: string;
  /** Overwrite a frames directory holding files Motion did not write. */
  force?: boolean;
  outputPath: string;
  createdAt: string;
  runner?: FfmpegRunner;
}): Promise<{ receipt: OperationReceipt; frameLane: "browser" }> {
  if (!nativeRenderable(input.pkg)) {
    throw new Error("Script-to-Cut connector can only render native scripted text, shape, and caption layers.");
  }

  // Wiping a frames directory is correct — a stale frame from a longer previous render would be
  // encoded into this one — but this one lives under a caller-supplied `--out`, so ownership is
  // proven from the CONTENT (only Motion's own PNG frames), never from the path's name.
  assertOutputDirGuard(await prepareFramesDir(input.framesDir, { force: input.force === true, callerSupplied: true }));
  await mkdir(input.framesDir, { recursive: true });
  await mkdir(dirname(input.outputPath), { recursive: true });
  const frameCount = frameCountFor(input.durationMs, input.fps);
  for (let index = 0; index < frameCount; index += 1) {
    await renderMotionBrowserFrame(input.pkg, {
      outDir: input.framesDir,
      outputPath: join(input.framesDir, frameFileName(index)),
      atMs: frameTimestampMs(index, input.fps, input.durationMs),
      now: () => input.createdAt
    });
  }

  const stagingOutputPath = connectorArtifactStagingPath(input.outputPath);
  // Final encode through the shared encode policy: hardware GPU encoding by default with a cached
  // per-host probe, honoring SHELLX_MOTION_FORCE_SOFTWARE_ENCODE; the same host selects the same encoder
  // as the CLI and debug-api render paths.
  const encoded = await encodeImageSequenceWithPolicy({
    packageId: input.packageId,
    framesDir: input.framesDir,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    outputPath: stagingOutputPath,
    inputRoots: [input.framesDir],
    outputRoots: [dirname(input.outputPath)],
    quality: frameCount > 1 ? { minUniqueFrameHashes: 2 } : undefined,
    runner: input.runner,
    now: () => input.createdAt
  });
  if (!encoded.ok) {
    await rm(stagingOutputPath, { force: true });
    return {
      receipt: createFailedRenderReceipt({
        packageId: input.packageId,
        motionHash: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")),
        createdAt: input.createdAt,
        outputPath: input.outputPath,
        command: encoded.command,
        error: encoded.error
      }),
      frameLane: "browser"
    };
  }
  await publishConnectorArtifact(stagingOutputPath, input.outputPath);
  encoded.receipt.output = {
    ...(readRecord(encoded.receipt.output) ?? {}),
    path: input.outputPath,
    frameLane: "browser"
  };
  encoded.receipt.artifacts = encoded.receipt.artifacts?.map((artifact) => artifact.role === "rendered_media"
    ? { ...artifact, path: input.outputPath }
    : artifact);
  return { receipt: encoded.receipt, frameLane: "browser" };
}

function createFailedRenderReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  outputPath: string;
  command: FfmpegCommand;
  error: { code: string; message: string };
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `ffmpeg-render-failed-${hashBuffer(Buffer.from(`${input.packageId}:${input.outputPath}:${input.error.code}:${input.error.message}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "failed",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      path: input.outputPath,
      frameLane: "browser",
      command: input.command,
      error: input.error
    },
    warnings: [input.error.message]
  };
}

function nativeRenderable(pkg: MotionPackage): boolean {
  return pkg.motion.layers.every((layer) => layer.type === "text" || layer.type === "shape" || layer.type === "caption");
}

function createConnectorReceipt(input: {
  operation: "connector.script_to_cut" | "connector.cut_generate_to_cut";
  packageId: string;
  createdAt: string;
  inputPath: string;
  inputHash: string;
  packageDir: string;
  previewOk: boolean;
  previewFailureFatal: boolean;
  previewReceiptPath: string;
  renderOk: boolean;
  renderReceiptPath: string;
  renderRequired: boolean;
  renderDryRun: boolean;
  renderFrameLane?: "browser";
  renderOutputPath?: string;
  cutOk: boolean;
  cutMode: string | null;
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  warnings: string[];
  operationHash: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `${receiptIdPrefix(input.operation)}-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: input.operation,
    status: connectorReceiptStatus({ failed: input.previewFailureFatal || !input.cutOk || !input.renderOk, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: { script: input.inputHash, operation: input.operationHash },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      artifacts: input.artifacts,
      script: { path: input.inputPath },
      packageDir: input.packageDir,
      preview: { ok: input.previewOk, lane: "native", failureFatal: input.previewFailureFatal, receiptPath: input.previewReceiptPath },
      render: {
        ok: input.renderOk,
        required: input.renderRequired,
        dryRun: input.renderRequired ? input.renderDryRun : true,
        lane: "ffmpeg",
        frameLane: input.renderFrameLane,
        receiptPath: input.renderReceiptPath,
        ...(input.renderOutputPath ? { outputPath: input.renderOutputPath } : {})
      },
      cut: { ok: input.cutOk, mode: input.cutMode, planPath: input.cutPlanPath }
    },
    warnings: input.warnings
  };
}

function receiptIdPrefix(operation: "connector.script_to_cut" | "connector.cut_generate_to_cut"): string {
  return operation === "connector.cut_generate_to_cut" ? "connector-cut-generate-cut" : "connector-script-cut";
}

function frameCountFor(durationMs: number, fps: number): number {
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

function frameTimestampMs(index: number, fps: number, durationMs: number): number {
  return Math.min(durationMs - 1, Math.round((index / fps) * 1000));
}

function frameFileName(index: number): string {
  return `${String(index + 1).padStart(6, "0")}.png`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
