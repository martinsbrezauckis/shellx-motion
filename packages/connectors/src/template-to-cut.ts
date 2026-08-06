import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { attachRenderedMediaToCutPlan, placeRenderedMediaInCutPlan, planCutImport, type CutRenderedMediaPlacement } from "@shellx-motion/adapters-cut";
import {
  applyTemplateValues,
  escalateReceiptStatusForWarnings,
  hashBuffer,
  loadMotionPackage,
  type MotionPackage,
  type OperationReceipt,
  type TemplateChangedBinding,
  type TemplateValue,
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
import { packageAudioEncodeInput } from "./package-audio";

export interface TemplateToCutConnectorInput {
  /**
   * Overwrite a non-empty output directory. Off by default: `--out` is caller-supplied, and
   * inferring ownership of an existing `package/` from its name destroyed a caller's files.
   */
  force?: boolean;
  packageRoot: string;
  values: Record<string, TemplateValue>;
  outDir: string;
  previewLane?: "auto" | "native" | "browser";
  renderLane?: "ffmpeg";
  dryRunRender?: boolean;
  cutImportMode?: CutImportModeRequest;
  cutPlacement?: CutRenderedMediaPlacement;
  ffmpegRunner?: FfmpegRunner;
  now?: () => string;
}

export interface TemplateToCutConnectorResult {
  ok: boolean;
  packageDir: string;
  template: {
    changedParams: string[];
    changedBindings: TemplateChangedBinding[];
    receiptPath: string;
  };
  preview: { ok: boolean; lane: "native" | "browser"; atMs: number; failureFatal: boolean; receiptPath: string; outputPath: string | null };
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

export async function runTemplateToCutConnector(input: TemplateToCutConnectorInput): Promise<TemplateToCutConnectorResult> {
  const requestedPreviewLane = input.previewLane ?? "native";
  const renderLane = input.renderLane ?? "ffmpeg";
  const dryRunRender = input.dryRunRender ?? true;
  const createdAt = input.now?.() ?? new Date().toISOString();
  if (!(["auto", "native", "browser"] as const).includes(requestedPreviewLane)) {
    throw new Error(`Unsupported connector preview lane: ${requestedPreviewLane}`);
  }
  if (renderLane !== "ffmpeg") {
    throw new Error(`Unsupported connector render lane: ${renderLane}`);
  }

  const sourcePackageRoot = resolve(input.packageRoot);
  const outDir = resolve(input.outDir);
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const templateApplyReceiptPath = join(packageDir, "receipts", "template-apply.receipt.json");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const connectorReceiptPath = join(outDir, "connector-run.receipt.json");

  const sourcePackage = await loadMotionPackage(sourcePackageRoot);
  const applied = applyTemplateValues(sourcePackage, input.values);
  if (!applied.ok) {
    const message = applied.errors.map((error) => `${error.paramId || "(package)"}: ${error.message}`).join("; ");
    throw new Error(`Template apply failed: ${message}`);
  }

  await mkdir(outDir, { recursive: true });
  // `outDir` is caller-supplied, so `<outDir>/package` is NOT ours to delete on the strength of its
  // name. This removed a caller's existing package/ and still reported ok:true — a sentinel file
  // placed there was destroyed by a successful dry run. the output-ownership invariant widened the check from `package/`
  // alone to every directory this connector recreates: a non-empty `--out` WITHOUT a `package/`
  // subdirectory used to walk straight past the guard.
  await assertConnectorOutputOwnership({
    packageDir,
    ownedDirs: [receiptDir, join(outDir, "preview"), join(outDir, "render"), join(outDir, "artifacts")],
    ownedFiles: [cutPlanPath, connectorReceiptPath],
    force: input.force === true
  });
  await cp(sourcePackageRoot, packageDir, { recursive: true });
  await writeJson(join(packageDir, sourcePackage.manifest.motion), applied.motion);

  const templateReceipt = createTemplateApplyReceipt({
    packageId: sourcePackage.manifest.id,
    sourcePackage,
    values: input.values,
    packageDir,
    receiptPath: templateApplyReceiptPath,
    changedParams: applied.changedParams,
    changedBindings: applied.changedBindings,
    warnings: applied.warnings,
    createdAt
  });
  await writeJson(templateApplyReceiptPath, templateReceipt);

  const pkg = await loadMotionPackage(packageDir);
  const baseCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({
    targetId: "shellx-cut",
    mode: input.cutImportMode ?? "auto"
  }));
  const plannedCutImport = input.cutPlacement
    ? placeRenderedMediaInCutPlan(baseCutImport, input.cutPlacement)
    : baseCutImport;
  const renderRequired = plannedCutImport.mode === "rendered_media";
  const previewLane: "native" | "browser" = requestedPreviewLane === "auto"
    ? renderRequired ? "browser" : "native"
    : requestedPreviewLane;
  const previewAtMs = previewLane === "browser"
    ? pkg.template?.metadata?.qualityTargets?.representativeFramesMs[0] ?? 0
    : 0;
  const previewPath = join(outDir, "preview", `${previewLane}-${previewAtMs}.png`);
  const previewReceiptPath = join(receiptDir, `${previewLane}-preview.receipt.json`);

  await mkdir(receiptDir, { recursive: true });
  await mkdir(join(outDir, "preview"), { recursive: true });
  const preview = previewLane === "native"
    ? await renderNativePreviewFrame({
        packageRoot: packageDir,
        outputPath: previewPath,
        outputRoots: [outDir],
        atMs: previewAtMs,
        now: () => createdAt
      })
    : await renderTemplateBrowserPreview({ pkg, previewPath, atMs: previewAtMs, createdAt });
  await writeJson(previewReceiptPath, preview.receipt);

  const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.mp4`);
  const framesDir = join(outDir, "frames", pkg.manifest.id);
  const operationHash = connectorArtifactOperationHash({ packageId: pkg.manifest.id, motionId: pkg.motion.id, preset: "mp4-h264", plan: plannedCutImport });
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
        packageId: pkg.manifest.id,
        durationMs: pkg.motion.durationMs,
        fps: pkg.motion.fps,
        width: pkg.motion.width,
        height: pkg.motion.height,
        framesDir,
        outputPath: renderOutputPath,
        createdAt,
        // the explicit-force invariant: `force` was declared on the render input and set by nobody, so `--force` never
        // reached the frames guard even on the one connector that read the flag.
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

  const warnings = [...applied.warnings, ...preview.warnings, ...renderReceipt.warnings, ...cutPlan.receipt.warnings];
  const previewFailureFatal = renderRequired && dryRunRender && !preview.ok;
  const artifacts = templateToCutArtifacts({
    sourcePackageRoot,
    packageDir,
    templateApplyReceiptPath,
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
    sourcePackageRoot,
    sourcePackage,
    values: input.values,
    packageDir,
    changedParams: applied.changedParams,
    changedBindings: applied.changedBindings,
    templateApplyReceiptPath,
    previewOk: preview.ok,
    previewFailureFatal,
    previewLane,
    previewAtMs,
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
    operationHash
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
    cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, { dryRun: false, handle: finalized.reference });
  }
  await writeJson(cutPlanPath, cutPlan);

  return {
    ok: !previewFailureFatal && cutPlan.ok && renderOk,
    packageDir,
    template: {
      changedParams: applied.changedParams,
      changedBindings: applied.changedBindings,
      receiptPath: templateApplyReceiptPath
    },
    preview: {
      ok: preview.ok,
      lane: previewLane,
      atMs: previewAtMs,
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

async function renderTemplateBrowserPreview(input: {
  pkg: MotionPackage;
  previewPath: string;
  atMs: number;
  createdAt: string;
}): Promise<{
  ok: boolean;
  frame: { path: string };
  receipt: OperationReceipt;
  warnings: string[];
}> {
  try {
    const result = await renderMotionBrowserFrame(input.pkg, {
      outDir: dirname(input.previewPath),
      outputPath: input.previewPath,
      atMs: input.atMs,
      now: () => input.createdAt
    });
    return {
      ok: true,
      frame: { path: result.output.path },
      receipt: result.receipt,
      warnings: result.receipt.warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      frame: { path: input.previewPath },
      receipt: {
        schema: "shellx-motion/receipt@1",
        id: `browser-preview-failed-${hashBuffer(Buffer.from(`${input.pkg.manifest.id}:${input.atMs}:${message}`)).slice(0, 16)}`,
        operation: "preview.frame",
        status: "failed",
        packageId: input.pkg.manifest.id,
        inputHashes: { motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")) },
        createdAt: input.createdAt,
        lane: "browser",
        output: { path: input.previewPath, atMs: input.atMs, error: message },
        warnings: [message]
      },
      warnings: [message]
    };
  }
}

function createTemplateApplyReceipt(input: {
  packageId: string;
  sourcePackage: MotionPackage;
  values: Record<string, TemplateValue>;
  packageDir: string;
  receiptPath: string;
  changedParams: string[];
  changedBindings: TemplateChangedBinding[];
  warnings: string[];
  createdAt: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `template-apply-${hashBuffer(Buffer.from(`${input.packageId}:${JSON.stringify(input.changedBindings)}`, "utf8")).slice(0, 16)}`,
    operation: "template.apply",
    // The connector's copy of the CLI's template-apply receipt, and it has to answer the same way:
    // a binding the engine declined to apply is an ignored declaration, not a pass.
    status: escalateReceiptStatusForWarnings("passed", input.warnings),
    packageId: input.packageId,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.motion), "utf8")),
      template: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.template ?? null), "utf8")),
      updates: hashBuffer(Buffer.from(JSON.stringify(input.values), "utf8"))
    },
    createdAt: input.createdAt,
    lane: "template",
    output: {
      packageDir: input.packageDir,
      changedParams: input.changedParams,
      changedBindings: input.changedBindings
    },
    artifacts: [
      { role: "motion_package", path: input.packageDir, status: "available", primary: true },
      { role: "template_apply_receipt", path: input.receiptPath, status: "available", mediaType: "application/json" }
    ],
    warnings: input.warnings
  };
}

function templateToCutArtifacts(input: {
  sourcePackageRoot: string;
  packageDir: string;
  templateApplyReceiptPath: string;
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
    { role: "template_source", path: input.sourcePackageRoot, status: "available" },
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "template_apply_receipt", path: input.templateApplyReceiptPath, status: "available", mediaType: "application/json" },
    { role: "preview_frame", path: input.previewPath, status: input.previewOk ? "available" : "planned", mediaType: "image/png" },
    { role: "preview_receipt", path: input.previewReceiptPath, status: "available" },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "cut_plan", path: input.cutPlanPath, status: "available", primary: !input.renderRequired },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
  if (input.renderRequired) {
    artifacts.splice(5, 0, {
      role: "rendered_media",
      path: input.renderOutputPath,
      status: !input.renderOk ? "failed" : input.renderDryRun ? "planned" : "available",
      mediaType: "video/mp4",
      primary: true
    });
  }
  if (input.artifactHandlePath) {
    artifacts.push({ role: "artifact_handle", path: input.artifactHandlePath, status: "available", mediaType: "application/vnd.shellx-motion.artifact-handle+json" });
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
    ...packageAudioEncodeInput(input.pkg),
    inputRoots: [input.framesDir, input.pkg.root],
    outputRoots: [dirname(input.outputPath)],
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

function createConnectorReceipt(input: {
  packageId: string;
  createdAt: string;
  sourcePackageRoot: string;
  sourcePackage: MotionPackage;
  values: Record<string, TemplateValue>;
  packageDir: string;
  changedParams: string[];
  changedBindings: TemplateChangedBinding[];
  templateApplyReceiptPath: string;
  previewOk: boolean;
  previewFailureFatal: boolean;
  previewLane: "native" | "browser";
  previewAtMs: number;
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
    id: `connector-template-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.template_to_cut",
    status: connectorReceiptStatus({ failed: input.previewFailureFatal || !input.cutOk || !input.renderOk, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.motion), "utf8")),
      template: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.template ?? null), "utf8")),
      updates: hashBuffer(Buffer.from(JSON.stringify(input.values), "utf8")),
      operation: input.operationHash
    },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      artifacts: input.artifacts,
      template: {
        sourcePackageRoot: input.sourcePackageRoot,
        changedParams: input.changedParams,
        changedBindings: input.changedBindings,
        receiptPath: input.templateApplyReceiptPath
      },
      packageDir: input.packageDir,
      preview: { ok: input.previewOk, lane: input.previewLane, atMs: input.previewAtMs, failureFatal: input.previewFailureFatal, receiptPath: input.previewReceiptPath },
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
