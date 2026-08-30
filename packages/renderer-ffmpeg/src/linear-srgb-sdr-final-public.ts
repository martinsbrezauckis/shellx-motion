import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  createRenderReceipt,
  defaultLocalMotionJobGovernor,
  LocalMotionJobError,
  resolveMotionColorPipeline,
  type DerivedOutputPublication,
} from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  executeLinearSrgbSdrFinal,
  prepareLinearSrgbSdrFinal,
  validateLinearSrgbSdrFinalPreparation,
  type LinearSrgbSdrFinalExecutionResult,
  type LinearSrgbSdrFinalPreparation,
} from "./linear-srgb-sdr-final-adapter.js";
import { LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256 } from "./linear-srgb-sdr-final-compare.js";
import {
  LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES,
  linearSrgbSdrFinalEncodeCommand,
} from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import { assertSafeFfmpegOutputPath } from "./ffmpeg-path-safety.js";
import type {
  LinearSrgbSdrFinalFrameTransportEvidence,
  RenderStreamingFinalInput,
  RenderStreamingFinalResult,
} from "./streaming-final-adapter-types.js";
import type { FinalVideoFrameTransportPlan } from "./final-video-frame-transport.js";
import type { FfmpegCommand } from "./index.js";

export type LinearSrgbSdrFinalRenderPreflight =
  | Readonly<{ readonly kind: "legacy" }>
  | Readonly<{ readonly kind: "strict"; readonly preparation: LinearSrgbSdrFinalPreparation }>
  | Readonly<{ readonly kind: "refused"; readonly error: { readonly code: "linear_srgb_sdr_final_unsupported"; readonly message: string } }>;

export type LinearSrgbSdrFinalRenderPlan =
  | Readonly<{ readonly kind: "legacy" }>
  | Readonly<{ readonly kind: "strict"; readonly route: LinearSrgbSdrFinalRoute; readonly command: FfmpegCommand }>
  | Readonly<{ readonly kind: "refused"; readonly error: { readonly code: "linear_srgb_sdr_final_unsupported"; readonly message: string } }>;

type ExecutionService = typeof executeLinearSrgbSdrFinal;
type PreparationService = (motion: unknown) => Promise<LinearSrgbSdrFinalPreparation>;

/**
 * Public route selection and exact output-free tool exercise. A strict result is the only
 * authority that may cross the later output-publication boundary; every incompatible strict
 * request is refused here, before a GPU, job, scratch child, output, or receipt exists.
 */
export async function preflightLinearSrgbSdrFinalRender(input: RenderStreamingFinalInput): Promise<LinearSrgbSdrFinalRenderPreflight> {
  return await preflightLinearSrgbSdrFinalRenderWith(input, async (motion) => await prepareLinearSrgbSdrFinal(motion));
}

/** Relative-module test seam; production always uses Motion's governed FFmpeg/FFprobe runner. */
export async function preflightLinearSrgbSdrFinalRenderForTest(input: RenderStreamingFinalInput, prepare: PreparationService): Promise<LinearSrgbSdrFinalRenderPreflight> {
  return await preflightLinearSrgbSdrFinalRenderWith(input, prepare);
}

async function preflightLinearSrgbSdrFinalRenderWith(input: RenderStreamingFinalInput, prepare: PreparationService): Promise<LinearSrgbSdrFinalRenderPreflight> {
  const plan = planLinearSrgbSdrFinalRender(input);
  if (plan.kind !== "strict") return plan;
  try {
    const preparation = input.linearSrgbSdrFinalPreparation;
    if (preparation) validateLinearSrgbSdrFinalPreparation(input.pkg.motion, preparation);
    const validated = preparation ?? await prepare(input.pkg.motion);
    return Object.freeze({ kind: "strict", preparation: validated });
  } catch (error) {
    return refused(safeMessage(error));
  }
}

/** Pure public discovery/dry-run projection; it opens no tool, job, GPU, scratch, or output. */
export function planLinearSrgbSdrFinalRender(input: RenderStreamingFinalInput): LinearSrgbSdrFinalRenderPlan {
  const contract = resolveMotionColorPipeline(input.pkg.motion);
  if (contract.intent !== "linear-srgb-sdr@1") {
    return input.linearSrgbSdrFinalPreparation
      ? refused("A strict linear-sRGB SDR preparation cannot be attached to a legacy color-pipeline render.")
      : Object.freeze({ kind: "legacy" });
  }
  const refusal = strictInputRefusal(input);
  if (refusal) return refused(refusal);
  const resolution = resolveLinearSrgbSdrFinalRoute(input.pkg.motion, {
    target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264",
  });
  if (!resolution.ok) return refused(resolution.refusal.message);
  return Object.freeze({
    kind: "strict",
    route: resolution.route,
    command: linearSrgbSdrFinalEncodeCommand({
      width: resolution.route.canvas.width,
      height: resolution.route.canvas.height,
      fps: resolution.route.canvas.fps,
      frameCount: Math.ceil((resolution.route.canvas.durationMs / 1_000) * resolution.route.canvas.fps),
    }, input.outputPath),
  });
}

/** Execute one already-preflighted strict render into an already-reserved private publication. */
export async function renderLinearSrgbSdrFinalUnpublished(input: RenderStreamingFinalInput & {
  readonly outputPublication: DerivedOutputPublication;
  readonly linearSrgbSdrFinalPreparation: LinearSrgbSdrFinalPreparation;
}): Promise<RenderStreamingFinalResult> {
  return await renderLinearSrgbSdrFinalUnpublishedWith(input, executeLinearSrgbSdrFinal, true);
}

/** Relative-module test seam; production cannot replace the executor or skip Core publication authenticity. */
export async function renderLinearSrgbSdrFinalUnpublishedForTest(input: Parameters<typeof renderLinearSrgbSdrFinalUnpublished>[0], execute: ExecutionService): Promise<RenderStreamingFinalResult> {
  return await renderLinearSrgbSdrFinalUnpublishedWith(input, execute, false);
}

async function renderLinearSrgbSdrFinalUnpublishedWith(input: Parameters<typeof renderLinearSrgbSdrFinalUnpublished>[0], execute: ExecutionService, authenticatePublication: boolean): Promise<RenderStreamingFinalResult> {
  const transport = strictTransport(input.transport);
  const refusal = strictInputRefusal(input, authenticatePublication);
  if (refusal) return failure(transport, "linear_srgb_sdr_final_unsupported", refusal);
  const governor = input.governor ?? defaultLocalMotionJobGovernor;
  try {
    const governed = await governor.run({
      lane: "ffmpeg",
      operation: input.operation ?? "ffmpeg.linear-srgb-sdr-final",
      scratchRoot: input.scratchRoot ?? (process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || ".scratch"),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.callerId ? { callerId: input.callerId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
    }, async (job) => {
      const privateRoot = await mkdtemp(join(job.scratchRoot, "linear-srgb-sdr-final-"));
      try {
        const verifiedOutputPath = join(privateRoot, "verified.mp4");
        const result = await execute({
          preparation: input.linearSrgbSdrFinalPreparation,
          outputPath: verifiedOutputPath,
          decodedPath: join(privateRoot, "decoded.rgba"),
          job: {
            admission: "pre-acquired",
            signal: job.signal,
            scratchRoot: privateRoot,
            maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes,
            watchProcess: job.watchProcess,
            reportProcessContainment: job.reportProcessContainment,
          },
        });
        if (!result.ok) return result;
        if (result.privateOutputPath !== verifiedOutputPath) {
          return { ok: false, code: "linear_srgb_sdr_final_failed", message: "Strict linear-sRGB SDR executor returned an unexpected private artifact identity." } as const;
        }
        const bytes = await readFile(verifiedOutputPath);
        if (bytes.byteLength !== result.evidence.output.byteLength
          || bytes.byteLength < 1 || bytes.byteLength > LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES
          || canonicalBytesSha256(bytes) !== result.evidence.output.sha256) {
          return { ok: false, code: "linear_srgb_sdr_final_failed", message: "Strict linear-sRGB SDR verified output changed before private publication adoption." } as const;
        }
        const adopted = await input.outputPublication.writePrivateFile(bytes, {
          label: "Strict linear-sRGB SDR final output",
          maxBytes: LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES,
        });
        if (adopted.sha256 !== result.evidence.output.sha256 || adopted.byteLength !== result.evidence.output.byteLength) {
          return { ok: false, code: "linear_srgb_sdr_final_failed", message: "Strict linear-sRGB SDR publication stage did not preserve the verified output identity." } as const;
        }
        return result;
      } finally {
        await rm(privateRoot, { recursive: true, force: true });
      }
    });
    if (!governed.value.ok) return failure(transport, governed.value.code, governed.value.message, governed.evidence);
    return success(input, governed.value, governed.evidence);
  } catch (error) {
    if (error instanceof LocalMotionJobError) return failure(transport, error.code, error.message, error.evidence);
    return failure(transport, "linear_srgb_sdr_final_failed", safeMessage(error));
  }
}

function success(
  input: Parameters<typeof renderLinearSrgbSdrFinalUnpublished>[0],
  result: Extract<LinearSrgbSdrFinalExecutionResult, { ok: true }>,
  resources: import("@shellx-motion/core").LocalMotionJobEvidence,
): Extract<RenderStreamingFinalResult, { ok: true }> {
  const { route, ffmpeg } = input.linearSrgbSdrFinalPreparation;
  const evidence = result.evidence;
  const frameTransport: LinearSrgbSdrFinalFrameTransportEvidence = {
    schema: "shellx-motion/linear-srgb-sdr-final-transport@1",
    delivery: "streamed",
    frameLane: "gpu",
    frameCount: evidence.retainedFrame.repeatedFrames,
    retainedFrameCount: 0,
    producer: { frameLane: "gpu-linear-srgb-sdr", evidence: evidence.producer },
    colorPipeline: {
      requested: route.contract,
      actual: {
        routeFingerprint: route.fingerprint,
        preparationFingerprint: input.linearSrgbSdrFinalPreparation.fingerprint,
        ffmpegContractSha256: evidence.ffmpegContractSha256,
        comparisonPolicySha256: LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256,
        retainedProducerFrame: evidence.retainedFrame,
        commands: evidence.commands,
        media: evidence.media,
        comparison: evidence.comparison,
        cleanup: evidence.cleanup,
        fingerprint: evidence.fingerprint,
      },
    },
    resources,
  };
  const receipt = createRenderReceipt<LinearSrgbSdrFinalFrameTransportEvidence>({
    id: `linear-srgb-sdr-final-${evidence.output.sha256.slice(0, 16)}`,
    packageId: input.pkg.manifest.id,
    lane: "ffmpeg",
    status: "passed",
    inputHashes: {
      motion: route.documentFingerprint,
      "linear-srgb-sdr-route": route.fingerprint,
      "linear-srgb-sdr-preparation": input.linearSrgbSdrFinalPreparation.fingerprint,
      "linear-srgb-sdr-ffmpeg-contract": evidence.ffmpegContractSha256,
      "linear-srgb-sdr-webgpu-producer": evidence.producerEvidenceSha256,
      "linear-srgb-sdr-producer-frame": evidence.retainedFrame.sha256,
      "linear-srgb-sdr-comparison-policy": LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256,
      "linear-srgb-sdr-execution": evidence.fingerprint,
    },
    output: {
      path: input.outputPublication.stagingPath,
      sha256: evidence.output.sha256,
      width: route.canvas.width,
      height: route.canvas.height,
      durationMs: route.canvas.durationMs,
      codec: "h264",
      container: "mp4",
      preset: "mp4-h264",
      encoder: "libx264",
      encoderSource: "software",
      encoderReason: "forced-software",
      color: {
        profile: "sdr-bt709-limited",
        primaries: evidence.media.color.primaries,
        transfer: evidence.media.color.transfer,
        matrix: evidence.media.color.space,
        range: evidence.media.color.range,
        conversion: "linear-srgb-sdr-zscale@1",
      },
      resources,
      frameTransport,
      tools: ffmpeg.tools,
    },
    warnings: [],
  });
  receipt.artifacts = [{ role: "rendered_media", path: input.outputPublication.stagingPath, status: "available", mediaType: "video/mp4", primary: true }];
  const command = linearSrgbSdrFinalEncodeCommand({
    width: route.canvas.width,
    height: route.canvas.height,
    fps: route.canvas.fps,
    frameCount: evidence.retainedFrame.repeatedFrames,
  }, input.outputPath);
  return { ok: true, command, receipt, transport: frameTransport };
}

function strictInputRefusal(input: RenderStreamingFinalInput, authenticatePublication = true): string | undefined {
  if (input.frameLane !== "gpu" || (input.preset ?? "mp4-h264") !== "mp4-h264") return "linear-srgb-sdr@1 requires the exact streamed GPU to FFmpeg mp4-h264 final route.";
  if (extname(input.outputPath).toLowerCase() !== ".mp4") return "linear-srgb-sdr@1 requires an .mp4 final output path.";
  if (input.transport && (input.transport.delivery !== "streamed" || input.transport.reason !== "stream_default")) return "linear-srgb-sdr@1 refuses every materialized frame transport.";
  if (input.audioPath || input.audio || (input.audioTracks?.length ?? 0) > 0 || input.audioMaster) return "linear-srgb-sdr@1 strict delivery refuses audio and audio muxing.";
  if (input.keepFrames === true || input.quality || input.qualityManifest) return "linear-srgb-sdr@1 strict delivery refuses frame retention and generic quality policies; it performs its own mandatory decoded comparison.";
  try {
    assertSafeFfmpegOutputPath(input.outputPath, input.outputRoots);
  } catch (error) {
    return safeMessage(error);
  }
  if (authenticatePublication && input.outputPublication && (!isCoreDerivedOutputPublication(input.outputPublication) || input.outputPublication.kind !== "file" || input.outputPublication.outputPath !== resolve(input.outputPath))) return "linear-srgb-sdr@1 requires an identity-bound Motion file publication for the exact requested output.";
  if (input.toolPolicy) return "linear-srgb-sdr@1 strict delivery uses Motion's fixed governed tools and refuses every generic tool-policy override.";
  if (input.now) return "linear-srgb-sdr@1 strict delivery refuses generic clock overrides.";
  return undefined;
}

function strictTransport(value: FinalVideoFrameTransportPlan | undefined): Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }> {
  return value?.delivery === "streamed" && value.reason === "stream_default" ? value : { delivery: "streamed", reason: "stream_default" };
}

function failure(transport: Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }>, code: string, message: string, resources?: import("@shellx-motion/core").LocalMotionJobEvidence): Extract<RenderStreamingFinalResult, { ok: false }> {
  return { ok: false, transport, error: { code, message, ...(resources ? { resources } : {}) } };
}

function refused(message: string): Extract<LinearSrgbSdrFinalRenderPreflight, { kind: "refused" }> {
  return Object.freeze({ kind: "refused", error: Object.freeze({ code: "linear_srgb_sdr_final_unsupported", message }) });
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Strict linear-sRGB SDR final preflight failed.";
  return message.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/gu, "<path>").slice(0, 360);
}

function canonicalBytesSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
