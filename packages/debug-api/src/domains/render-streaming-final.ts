/** Bounded streamed-final execution, adopted by the Debug API's existing final-video entry point. */
import { dirname } from "node:path";
import { packageAudioEncodeInput, resolvePackageAudioInputs } from "@shellx-motion/connectors";
import {
  acquireDerivedOutputPublication,
  activeScriptLayers,
  bindFinalRenderReceiptLineage,
  isPublicationCommitUncertain,
  type MotionPackage,
  type OperationReceipt,
  type PackageRenderLineage,
  type PublicationCommitUncertainEvidence,
  type ReceiptActor
} from "@shellx-motion/core";
import {
  resolveGpuEffectModuleStaticPlanForUse,
  type GpuEffectModuleUseAuthority,
  type MotionBrowserRenderSessionFactory
} from "@shellx-motion/renderer-browser";
import {
  checkFfmpeg,
  planLinearSrgbSdrFinalRender,
  planStreamingFinalCommand,
  preflightLinearSrgbSdrFinalRender,
  preliminaryGpuAudio,
  renderStreamingFinal,
  type FfmpegExportPreset,
  type FfmpegRunner,
  type FinalVideoFrameTransportPlan,
  type RenderStreamingFinalInput,
  type RenderStreamingFinalResult,
  type StreamingFinalToolPolicy
} from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugResult } from "../command-registry.js";
import { normalizePublicationUncertainty } from "../publication-uncertainty.js";

export interface StreamedFinalDebugContext {
  ffmpegRunner?: FfmpegRunner;
  scratchRoot?: string;
  callerId?: string;
  actor?: ReceiptActor;
  /** Coordinator-owned cancellation reaches the actual frame producer and FFmpeg process tree. */
  executionSignal?: AbortSignal;
  /** Host-only test seam for image2pipe transport. Browser-frame injection remains materialized. */
  streamingFinalRenderer?: (input: RenderStreamingFinalInput) => Promise<RenderStreamingFinalResult>;
  /** Host-owned browser snapshot/session binding; never sourced from command arguments. */
  browserSessionFactory?: MotionBrowserRenderSessionFactory;
  activeScriptSessionAvailable?: boolean;
  /** Opaque server-owned GPU module authority; Debug arguments cannot provide or replace it. */
  gpuEffectModuleUseAuthority?: GpuEffectModuleUseAuthority;
}

/**
 * Execute or dry-run the already-selected streamed route. The caller must have selected transport
 * through `planFinalVideoFrameTransport`; passing it back to the public adapter proves no later
 * layer can silently change the materialization facts.
 */
export async function runStreamedFinalDebugRender(input: {
  pkg: MotionPackage;
  lineage: PackageRenderLineage;
  outputPath: string;
  frameLane: "browser" | "native" | "gpu";
  preset: FfmpegExportPreset;
  quality?: { minUniqueFrameHashes: number };
  receiptsRoot?: string;
  warnings: string[];
  transport: Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }>;
  context: StreamedFinalDebugContext;
  dryRun: boolean;
  /** Batch-only delivered-media quality gate. It mutates the receipt before any success receipt is persisted. */
  evaluateDeliveredQuality?: (receipt: OperationReceipt) => Promise<{ qualityCheck: MotionDebugResult; failure?: MotionDebugResult }>;
  persistReceipt(receiptsRoot: string, receipt: OperationReceipt, actor?: ReceiptActor): Promise<string>;
}): Promise<MotionDebugResult> {
  const { pkg, lineage, outputPath, frameLane, preset, quality, receiptsRoot, warnings, transport, context, dryRun, evaluateDeliveredQuality, persistReceipt } = input;
  const audioTracks = resolvePackageAudioInputs(pkg);
  const audioMaster = packageAudioEncodeInput(pkg).audioMaster;
  const packageAudio = {
    ...(audioTracks.length === 1 ? { audio: audioTracks[0] } : {}),
    ...(audioTracks.length > 1 ? { audioTracks } : {}),
    ...(audioMaster ? { audioMaster } : {})
  };
  const plannedAudio = frameLane === "gpu" ? preliminaryGpuAudio({ pkg, ...packageAudio }) : packageAudio;
  const planned = planStreamingFinalCommand({
    fps: pkg.motion.fps,
    width: pkg.motion.width,
    height: pkg.motion.height,
    durationMs: pkg.motion.durationMs,
    ...(frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
    outputPath,
    preset,
    ...plannedAudio,
    inputRoots: [pkg.root],
    outputRoots: [dirname(outputPath)],
    ...(quality ? { quality } : {}),
    transport
  });
  if (!planned.ok) return { ok: false, error: planned.error, warnings };
  const strictColorPlan = planLinearSrgbSdrFinalRender({
    pkg, frameLane, outputPath, preset, ...packageAudio, ...(quality ? { quality } : {}), transport,
    ...(context.streamingFinalRenderer ? { toolPolicy: { injectedFrameRenderer: true } } : {})
  });
  if (strictColorPlan.kind === "refused") return { ok: false, error: strictColorPlan.error, warnings: [] };
  if (dryRun) {
    return {
      ok: true,
      visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: "planned" },
      result: {
        ok: true,
        lane: "ffmpeg",
        frameLane,
        preset,
        packageId: pkg.manifest.id,
        outputPath,
        ...(quality ? { quality } : {}),
        ...(warnings.length ? { warnings } : {}),
        dryRun: true,
        frameTransport: planned.transport,
        ffmpeg: strictColorPlan.kind === "strict" ? strictColorPlan.command : planned.command,
        ...(strictColorPlan.kind === "strict" ? { colorPipeline: { intent: "linear-srgb-sdr@1", routeFingerprint: strictColorPlan.route.fingerprint, preflight: "not_run" } } : {})
      },
      warnings
    };
  }

  const missingGpuModuleAuthority = await missingGpuModuleAuthorityFailure(pkg, frameLane, context.gpuEffectModuleUseAuthority);
  if (missingGpuModuleAuthority) return { ok: false, error: missingGpuModuleAuthority, warnings: [] };

  if (frameLane === "browser" && activeScriptLayers(pkg.motion).length > 0
    && (context.streamingFinalRenderer || context.activeScriptSessionAvailable !== true)) {
    return {
      ok: false,
      error: {
        code: "script_provenance_unresolved",
        message: context.streamingFinalRenderer
          ? "Active package scripts cannot use an injected streamed-final renderer; the fixed host session path is required."
          : "Active package scripts require a host-bound streamed browser session with approved-agent-entry authority."
      },
      warnings: []
    };
  }

  const streamingInput: RenderStreamingFinalInput = {
    pkg,
    frameLane,
    outputPath,
    preset,
    ...(audioTracks.length === 1 ? { audio: audioTracks[0] } : {}),
    ...(audioTracks.length > 1 ? { audioTracks } : {}),
    ...(audioMaster ? { audioMaster } : {}),
    inputRoots: [pkg.root],
    outputRoots: [dirname(outputPath)],
    ...(quality ? { quality } : {}),
    transport: planned.transport,
    ...(context.executionSignal ? { signal: context.executionSignal } : {}),
    ...(context.scratchRoot ? { scratchRoot: context.scratchRoot } : {}),
    ...(context.callerId ? { callerId: context.callerId } : {}),
    ...(strictColorPlan.kind === "strict" ? {} : { toolPolicy: streamedFinalToolPolicy(context, frameLane) })
  };
  const strictColorPreflight = await preflightLinearSrgbSdrFinalRender(streamingInput);
  if (strictColorPreflight.kind === "refused") return { ok: false, error: strictColorPreflight.error, warnings: [] };
  if (strictColorPreflight.kind === "strict" && context.streamingFinalRenderer) {
    return { ok: false, error: { code: "linear_srgb_sdr_final_unsupported", message: "linear-srgb-sdr@1 requires Motion's fixed WebGPU and FFmpeg executor; an injected streamed-final renderer is refused before output publication." }, warnings: [] };
  }
  const preparedStreamingInput: RenderStreamingFinalInput = {
    ...streamingInput,
    ...(strictColorPreflight.kind === "strict" ? { linearSrgbSdrFinalPreparation: strictColorPreflight.preparation } : {})
  };
  const streamed = context.streamingFinalRenderer
    ? await runInjectedStreamingFinal(context.streamingFinalRenderer, preparedStreamingInput, transport, context.ffmpegRunner)
    : await runDefaultStreamingFinal(preparedStreamingInput, transport, context.ffmpegRunner);
  if (!streamed.ok) {
    const uncertainty = normalizePublicationUncertainty(streamed.error);
    return {
      ok: false,
      error: uncertainty ? { ...streamed.error, detail: uncertainty } : streamed.error,
      result: {
        lane: "ffmpeg", frameLane, preset, packageId: pkg.manifest.id, outputPath, frameTransport: planned.transport,
        ...(uncertainty ?? {})
      },
      warnings
    };
  }

  const receipt = streamed.receipt;
  await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
  const qualityEvaluation = evaluateDeliveredQuality ? await evaluateDeliveredQuality(receipt) : undefined;
  if (qualityEvaluation?.failure) {
    await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
    return qualityEvaluation.failure;
  }
  await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
  const receiptPath = receiptsRoot ? await persistReceipt(receiptsRoot, receipt, context.actor) : undefined;
  return {
    ok: true,
    receiptId: receipt.id,
    visibleState: {
      panel: "receipts",
      operation: "render.final",
      packageId: pkg.manifest.id,
      outputPath,
      status: receipt.status
    },
    result: {
      ok: true,
      lane: "ffmpeg",
      frameLane,
      preset,
      packageId: pkg.manifest.id,
      outputPath,
      output: receipt.output,
      receipt,
      ...(receiptPath ? { receiptPath } : {}),
      frameTransport: planned.transport,
      ...(quality ? { quality } : {}),
      ...(qualityEvaluation ? { qualityCheck: qualityEvaluation.qualityCheck } : {}),
      warnings: receipt.warnings,
      ffmpeg: streamed.command
    },
    warnings: receipt.warnings
  };
}

/**
 * Central host projection for the direct-final adapter. This receives only Debug's server-owned
 * context, never request data, so a caller cannot replace its opaque module-use authority.
 */
export function streamedFinalToolPolicy(
  context: StreamedFinalDebugContext,
  frameLane: "browser" | "native" | "gpu"
): StreamingFinalToolPolicy {
  return {
    ...(context.ffmpegRunner ? { runner: context.ffmpegRunner } : {}),
    ...(context.browserSessionFactory ? { browser: { sessionFactory: context.browserSessionFactory } } : {}),
    ...(frameLane === "gpu" && context.gpuEffectModuleUseAuthority
      ? { gpu: { effectModuleUseAuthority: context.gpuEffectModuleUseAuthority } }
      : {})
  };
}

/**
 * A module-bearing GPU final must not start FFmpeg or a Chromium-backed producer merely to learn
 * that this host has no registry-use authority. Installed authorities remain opaque and are
 * resolved by the renderer at its normal final-admission boundary.
 */
async function missingGpuModuleAuthorityFailure(
  pkg: MotionPackage,
  frameLane: "browser" | "native" | "gpu",
  authority: GpuEffectModuleUseAuthority | undefined
): Promise<{ code: string; message: string } | undefined> {
  if (frameLane !== "gpu" || authority) return undefined;
  const preflight = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, undefined);
  return !preflight.ok && preflight.failure.code === "gpu_resource_refused"
    ? preflight.failure
    : undefined;
}

async function runDefaultStreamingFinal(
  input: RenderStreamingFinalInput,
  transport: Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }>,
  runner: FfmpegRunner | undefined
): Promise<RenderStreamingFinalResult> {
  if (input.linearSrgbSdrFinalPreparation) return await renderStreamingFinal(input);
  const health = await checkFfmpeg({ runner });
  if (!health.ok) return { ok: false, transport, error: health.error };
  return await renderStreamingFinal({
    ...input,
    toolPolicy: {
      ...input.toolPolicy,
      ...(health.version ? { ffmpegVersion: health.version } : {})
    }
  });
}

/** Host renderer seams write only to the same private publication stage as the default adapter. */
async function runInjectedStreamingFinal(
  renderer: NonNullable<StreamedFinalDebugContext["streamingFinalRenderer"]>,
  input: RenderStreamingFinalInput,
  transport: Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }>,
  runner: FfmpegRunner | undefined
): Promise<RenderStreamingFinalResult> {
  let publication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>>;
  try {
    publication = await acquireDerivedOutputPublication({ outputPath: input.outputPath, kind: "file" });
  } catch (error) {
    return { ok: false, transport, error: publicationFailure(error) };
  }
  let published = false;
  try {
    const health = await checkFfmpeg({ runner });
    if (!health.ok) return { ok: false, transport, error: health.error };
    const staged = await renderer({
      ...input,
      outputPath: publication.stagingPath,
      outputRoots: [publication.rootPath],
      toolPolicy: {
        ...input.toolPolicy,
        ...(health.version ? { ffmpegVersion: health.version } : {})
      }
    });
    if (!staged.ok) return staged;
    await publication.publishFile(await publication.verifyFile());
    published = true;
    return {
      ...staged,
      command: { ...staged.command, args: staged.command.args.map((arg) => arg === publication.stagingPath ? input.outputPath : arg) },
      receipt: remapPublicationReceipt(staged.receipt, publication.stagingPath, input.outputPath)
    };
  } catch (error) {
    return { ok: false, transport, error: publicationFailure(error) };
  } finally {
    if (!published) await publication.abort();
  }
}

function publicationFailure(error: unknown): {
  code: string;
  message: string;
  possiblyCommitted?: true;
  publicPaths?: readonly string[];
  expectedPublication?: PublicationCommitUncertainEvidence;
} {
  if (isPublicationCommitUncertain(error)) {
    return {
      code: error.code,
      message: error.message,
      possiblyCommitted: true,
      publicPaths: [error.evidence.publicPath],
      expectedPublication: error.evidence
    };
  }
  return { code: (error as { code?: string }).code ?? "derived_output_publish_failed", message: error instanceof Error ? error.message : String(error) };
}

function remapPublicationReceipt(receipt: OperationReceipt, stagingPath: string, outputPath: string): OperationReceipt {
  const output = receipt.output && typeof receipt.output === "object" && !Array.isArray(receipt.output)
    ? { ...(receipt.output as Record<string, unknown>), path: outputPath }
    : receipt.output;
  return {
    ...receipt,
    output,
    ...(receipt.artifacts ? { artifacts: receipt.artifacts.map((artifact) => artifact.path === stagingPath ? { ...artifact, path: outputPath } : artifact) } : {})
  };
}
