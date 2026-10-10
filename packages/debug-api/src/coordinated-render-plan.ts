/** Path-free Core plan construction for an already-admitted coordinator final-video request. */
import { resolve } from "node:path";
import {
  canonicalJsonSha256,
  createMotionRenderPlan,
  type MotionRenderPlanV1,
  type StableRenderPackage,
} from "@shellx-motion/core";
import {
  planFinalVideoFrameTransport,
  readFfmpegExportPreset,
  resolveExportPreset,
  type FinalVideoFrameTransportPlan,
} from "@shellx-motion/renderer-ffmpeg";
import { canonicalAttestedReuseHostPath } from "./domains/attested-render-reuse-root.js";
import type { FinalRenderRequest } from "./domains/render-final.js";
import { MOTION_ENGINE_VERSION } from "./version.js";

/** Host facts admitted before a coordinator may accept this final-video job. */
export interface CoordinatedRenderPlanHostAdmission {
  /** An injected browser renderer selects a materialized direct browser route. */
  readonly injectedBrowserRenderer: boolean;
  /** Host-owned direct GPU final availability; this is a gate, never runtime provenance. */
  readonly gpuFinalExecutionAvailable: boolean;
  /** Effective host receipt root selected when the already-admitted request omits an override. */
  readonly effectiveReceiptsRoot?: string;
}

/**
 * Construct the immutable Core identity from a request that has already passed final-render and
 * coordinator admission. Paths affect only the output-intent digest and never enter the plan.
 */
export function createCoordinatedRenderPlan(
  request: FinalRenderRequest,
  stable: StableRenderPackage,
  admission: CoordinatedRenderPlanHostAdmission,
): MotionRenderPlanV1 {
  const preset = readFfmpegExportPreset(request.preset);
  if (!preset) throw new Error("Coordinated render plans require a final-video FFmpeg preset.");
  if (request.frameLane === "gpu" && !admission.gpuFinalExecutionAvailable) {
    throw new Error("Coordinated GPU render plans require the host direct GPU-final admission gate.");
  }
  if (request.frameLane === "gpu" && preset === "gif") {
    throw new Error("GPU final jobs require a strict streamed FFmpeg video preset (MP4, WebM, or MOV); GIF delivery is not a GPU final-video job.");
  }

  const segmented = request.segmented;
  const frameTransport = planFinalVideoFrameTransport({
    keepFrames: false,
    capturedBrowserWorkflow: false,
    exactSourceQuality: false,
    injectedFrameRenderer: request.frameLane === "browser" && admission.injectedBrowserRenderer,
  });
  if (!segmented && frameTransport.delivery !== "streamed") {
    throw new Error("Coordinated render plans require the streamed final-video frame transport.");
  }
  if (segmented && request.frameLane === "browser" && admission.injectedBrowserRenderer) {
    throw new Error("Coordinated segmented browser plans require the fixed host browser session.");
  }

  const requested = {
    lane: "ffmpeg" as const,
    frameLane: request.frameLane,
    delivery: segmented ? "segmented" as const : "streamed" as const,
    segmented: segmented
      ? { segmentFrames: segmented.segmentFrames, resume: segmented.resume === true }
      : null,
    fallback: "none" as const,
  };
  const effectiveReceiptsRoot = request.receiptsRoot ?? admission.effectiveReceiptsRoot;
  const outputIntent = {
    schema: "shellx-motion/final-output-intent@1",
    kind: "file",
    target: canonicalAttestedReuseHostPath(resolve(request.outputPath)),
    receiptTarget: effectiveReceiptsRoot === undefined
      ? null
      : canonicalAttestedReuseHostPath(resolve(effectiveReceiptsRoot)),
  };
  const route = {
    schema: "shellx-motion/coordinated-final-route@1",
    operation: "render.final",
    requested,
    transport: segmented
      ? { kind: "segmented-final", store: "derived-from-output" }
      : staticStreamedTransport(frameTransport),
  };
  const capabilityAdmission = {
    schema: "shellx-motion/coordinated-final-admission@1",
    frameLane: request.frameLane,
    browser: request.frameLane === "browser" ? "fixed-host-session-required" : "not-selected",
    gpu: request.frameLane === "gpu" ? "direct-host-gate-passed" : "not-selected",
    injectedFrameRenderer: request.frameLane === "browser" ? "forbidden" : "not-selected",
  };

  return createMotionRenderPlan({
    package: { id: stable.pkg.manifest.id, manifestSha256: stable.lineage.manifestSha256 },
    motion: { id: stable.pkg.motion.id, documentSha256: stable.lineage.motionSha256 },
    lineage: stable.lineage,
    output: {
      preset,
      mediaRole: "final-video",
      intentSha256: canonicalJsonSha256(outputIntent),
    },
    quality: { mode: "none" },
    requested,
    runtime: {
      engine: `shellx-motion@${MOTION_ENGINE_VERSION}`,
      routeFingerprint: canonicalJsonSha256(route),
      presetFingerprint: canonicalJsonSha256({
        schema: "shellx-motion/final-video-preset@1",
        preset: resolveExportPreset(preset),
      }),
      // This names only the selected static admission policy; actual host/tool evidence belongs
      // to execution receipts and is deliberately not claimed by a preflight plan.
      capabilityFingerprint: canonicalJsonSha256(capabilityAdmission),
    },
    compatibility: { version: 1, state: "current" },
  });
}

function staticStreamedTransport(transport: FinalVideoFrameTransportPlan): FinalVideoFrameTransportPlan {
  if (transport.delivery !== "streamed") {
    throw new Error("Coordinated render plans require the streamed final-video frame transport.");
  }
  return transport;
}
