import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRenderReceipt,
  defaultLocalMotionJobGovernor,
  LocalMotionJobError,
  resolveMotionColorPipeline,
  type DerivedOutputPublication,
} from "@shellx-motion/core";
import {
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  type StrictSdrCandidateHeldPairRendererBinding,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  executeLinearSrgbSdrFinal,
  executeLinearSrgbSdrFinalHeldMedia,
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
import { safeLinearSrgbSdrFinalMessage, strictLinearSrgbSdrFinalInputRefusal } from "./linear-srgb-sdr-final-input-refusal.js";
import { closeHeldMediaAfterPublication, privateHeldMediaOutputAdoption } from "./linear-srgb-sdr-final-held-media-publication.js";
import { assertLinearSrgbSdrHeldMediaWitness } from "./linear-srgb-sdr-final-held-media.js";
import { claimStrictSdrCandidateHeldChromium, type StrictSdrCandidateHeldChromiumExecutor } from "./linear-srgb-sdr-final-held-chromium.js";
import type {
  LinearSrgbSdrFinalPrivateOutputAdoption,
  LinearSrgbSdrFinalFrameTransportEvidence,
  RenderStreamingFinalInput,
  RenderStreamingFinalResult,
} from "./streaming-final-adapter-types.js";
import {
  LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA,
} from "./streaming-final-adapter-types.js";
import type { FinalVideoFrameTransportPlan } from "./final-video-frame-transport.js";
import type { FfmpegCommand } from "./index.js";
import { isStreamingFinalLineageRevalidationFailure } from "./streaming-final-lineage-revalidation.js";

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
type AdoptedLinearSrgbSdrFinalExecutionResult = Exclude<LinearSrgbSdrFinalExecutionResult, { ok: true }>
  | (Extract<LinearSrgbSdrFinalExecutionResult, { ok: true }> & { readonly privateOutputAdoption: LinearSrgbSdrFinalPrivateOutputAdoption; readonly encodeCommand?: FfmpegCommand });

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
    if (isStreamingFinalLineageRevalidationFailure(error)) throw error;
    return refused(safeLinearSrgbSdrFinalMessage(error));
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
  const refusal = strictLinearSrgbSdrFinalInputRefusal(input);
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
  const refusal = strictLinearSrgbSdrFinalInputRefusal(input, authenticatePublication);
  if (refusal) return failure(transport, "linear_srgb_sdr_final_unsupported", refusal);
  const governor = input.governor ?? defaultLocalMotionJobGovernor;
  const callerScratchRoot = input.scratchRoot ?? (process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || ".scratch");
  try {
    let heldBinding: StrictSdrCandidateHeldPairRendererBinding | undefined;
    try {
      heldBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(input.outputPublication, input.linearSrgbSdrFinalPreparation.fingerprint, input.outputPath);
    } catch (error) {
      return failure(transport, "linear_srgb_sdr_final_unsupported", safeLinearSrgbSdrFinalMessage(error));
    }
    const governed = await governor.run({
      lane: "ffmpeg",
      operation: input.operation ?? "ffmpeg.linear-srgb-sdr-final",
      scratchRoot: callerScratchRoot,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.callerId ? { callerId: input.callerId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
    }, async (job): Promise<AdoptedLinearSrgbSdrFinalExecutionResult> => {
      const privateRoot = await mkdtemp(join(job.scratchRoot, "linear-srgb-sdr-final-"));
      let heldExecutorOwnsPrivateRoot = false;
      try {
        const verifiedOutputPath = join(privateRoot, "verified.mp4");
        const executionInput = {
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
        } as const;
        if (heldBinding) {
          let executor: StrictSdrCandidateHeldChromiumExecutor;
          try {
            executor = claimStrictSdrCandidateHeldChromium(heldBinding, input.linearSrgbSdrFinalPreparation.fingerprint, executionInput.job);
            consumeCurrentStrictSdrCandidateHeldPairRendererBinding(heldBinding);
          } catch (error) {
            return { ok: false, code: "linear_srgb_sdr_final_refused", message: safeLinearSrgbSdrFinalMessage(error) } as const;
          }
          heldExecutorOwnsPrivateRoot = true;
          const held = await executeLinearSrgbSdrFinalHeldMedia(executionInput, executor);
          if (!held.ok) return held;
          try {
            if (held.privateOutputPath !== verifiedOutputPath) {
              throw new Error("Strict linear-sRGB SDR held executor returned an unexpected private artifact identity.");
            }
            const adopted = await held.heldMedia.copyToPublication(input.outputPublication, heldBinding);
            assertLinearSrgbSdrHeldMediaWitness(held.heldMedia, adopted);
            if (adopted.byteLength !== held.evidence.output.byteLength || adopted.sha256 !== held.evidence.output.sha256) {
              throw new Error("Strict linear-sRGB SDR held-media publication stage did not preserve the verified source identity.");
            }
            const adoptedResult = {
              ok: true as const,
              privateOutputPath: held.privateOutputPath,
              evidence: held.evidence,
              encodeCommand: held.heldMedia.encodeCommand,
              privateOutputAdoption: privateHeldMediaOutputAdoption(held.evidence.output, adopted),
            };
            if (held.heldMedia.transferThreeSlotLease({ binding: heldBinding, preparation: input.linearSrgbSdrFinalPreparation.fingerprint, governor, scratchRoot: callerScratchRoot, signal: input.signal, callerId: input.callerId })) {
              return adoptedResult;
            }
            if (held.heldMedia.transferF2aLease({ binding: heldBinding, preparation: input.linearSrgbSdrFinalPreparation.fingerprint, governor, scratchRoot: callerScratchRoot, signal: input.signal, callerId: input.callerId })) {
              return adoptedResult;
            }
            return await closeHeldMediaAfterPublication(held.heldMedia, async () => adoptedResult);
          } catch (error) {
            return await closeHeldMediaAfterPublication(held.heldMedia, async () => { throw error; });
          }
        }
        const result = await execute(executionInput);
        if (!result.ok) return result;
        if (result.privateOutputPath !== verifiedOutputPath) {
          return { ok: false, code: "linear_srgb_sdr_final_failed", message: "Strict linear-sRGB SDR executor returned an unexpected private artifact identity." } as const;
        }
        const bytes = await readFile(verifiedOutputPath);
        const verifiedOutput = Object.freeze({ sha256: canonicalBytesSha256(bytes), byteLength: bytes.byteLength });
        if (verifiedOutput.byteLength !== result.evidence.output.byteLength
          || verifiedOutput.byteLength < 1 || verifiedOutput.byteLength > LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES
          || verifiedOutput.sha256 !== result.evidence.output.sha256) {
          return { ok: false, code: "linear_srgb_sdr_final_failed", message: "Strict linear-sRGB SDR verified output changed before private publication adoption." } as const;
        }
        const adopted = await input.outputPublication.writePrivateFile(bytes, {
          label: "Strict linear-sRGB SDR final output",
          maxBytes: LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES,
        });
        if (adopted.sha256 !== verifiedOutput.sha256 || adopted.byteLength !== verifiedOutput.byteLength) {
          return { ok: false, code: "linear_srgb_sdr_final_failed", message: "Strict linear-sRGB SDR publication stage did not preserve the verified output identity." } as const;
        }
        return {
          ...result,
          privateOutputAdoption: privateHeldMediaOutputAdoption(verifiedOutput, adopted),
        };
      } finally {
        if (!heldExecutorOwnsPrivateRoot) await rm(privateRoot, { recursive: true, force: true });
      }
    });
    if (!governed.value.ok) return failure(transport, governed.value.code, governed.value.message, governed.evidence);
    return success(input, governed.value, governed.evidence);
  } catch (error) {
    if (isStreamingFinalLineageRevalidationFailure(error)) return failure(transport, "render_failed", error.message);
    if (error instanceof LocalMotionJobError) return failure(transport, error.code, error.message, error.evidence);
    return failure(transport, "linear_srgb_sdr_final_failed", safeLinearSrgbSdrFinalMessage(error));
  }
}

function success(
  input: Parameters<typeof renderLinearSrgbSdrFinalUnpublished>[0],
  result: Extract<AdoptedLinearSrgbSdrFinalExecutionResult, { ok: true }>,
  resources: import("@shellx-motion/core").LocalMotionJobEvidence,
): Extract<RenderStreamingFinalResult, { ok: true }> {
  const { route, ffmpeg } = input.linearSrgbSdrFinalPreparation;
  const evidence = result.evidence;
  const adoptedOutput = result.privateOutputAdoption.verifiedOutput;
  const frameTransport: LinearSrgbSdrFinalFrameTransportEvidence = {
    schema: LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA,
    delivery: "streamed",
    frameLane: "gpu",
    frameCount: evidence.retainedFrame.repeatedFrames,
    retainedFrameCount: 0,
    privateOutputAdoption: result.privateOutputAdoption,
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
    id: `linear-srgb-sdr-final-${adoptedOutput.sha256.slice(0, 16)}`,
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
      sha256: adoptedOutput.sha256,
      byteLength: adoptedOutput.byteLength,
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
  const command = result.encodeCommand ?? linearSrgbSdrFinalEncodeCommand({
    width: route.canvas.width,
    height: route.canvas.height,
    fps: route.canvas.fps,
    frameCount: evidence.retainedFrame.repeatedFrames,
  }, input.outputPath);
  return { ok: true, command, receipt, transport: frameTransport };
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

function canonicalBytesSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
