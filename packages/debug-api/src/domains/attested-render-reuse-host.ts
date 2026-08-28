/** Debug host bindings and current-package admission for attested final-render reuse. */
import {
  loadMotionPackage,
  verifyGpuPostRenderReuseIdentity,
  type AttestedArtifactHandle,
  type GpuPostRenderReuseIdentity,
  type OperationReceipt,
} from "@shellx-motion/core";
import { browserTypographyAttestationRefusal } from "@shellx-motion/renderer-browser";
import {
  ffmpegPresetOutputPathError,
  readFfmpegExportPreset,
  readStillFrameExportPreset,
  stillFrameOutputPathError,
} from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugResult } from "../command-registry.js";
import { nativeFrameLaneRefusal } from "../render-final-frame-lane.js";
import { executeWithAttestedRenderReuse } from "./attested-render-reuse.js";
import type { FinalRenderRequest } from "./render-final.js";
import type { AttestedRenderReuseProducerAuthority } from "./attested-render-reuse-producer-authority.js";

export interface AttestedReuseHostServices {
  engineVersion: string;
  writeReceipt: (root: string, receipt: OperationReceipt) => Promise<string>;
  invalidArgs: (message: string) => MotionDebugResult;
  producerAuthority?: AttestedRenderReuseProducerAuthority;
}

/**
 * Validate only a host-retained GPU result after its successful render receipt and artifact have
 * both been persisted. This is intentionally not a Debug command or cache-plan input: callers
 * cannot supply adapter, frame, media, or containment evidence ahead of execution.
 */
export async function validateHostRetainedGpuPostRenderReuse(input: {
  root: string;
  artifact: AttestedArtifactHandle;
  expected?: GpuPostRenderReuseIdentity;
}): Promise<GpuPostRenderReuseIdentity> {
  const verified = await verifyGpuPostRenderReuseIdentity(input);
  return verified.identity;
}

/** Keep the large Debug host's dependency wiring outside its public entry module. */
export function createAttestedRenderReuseFinalExecutor(services: AttestedReuseHostServices) {
  return async (
    request: FinalRenderRequest,
    execute: (request: FinalRenderRequest) => Promise<MotionDebugResult>,
  ): Promise<MotionDebugResult> => await executeWithAttestedRenderReuse(request, {
    engineVersion: services.engineVersion,
    execute,
    writeReceipt: services.writeReceipt,
    ...(services.producerAuthority ? { producerAuthority: services.producerAuthority } : {}),
    staticAdmission: async (candidate) => await attestedRenderReuseStaticAdmission(candidate, services.invalidArgs),
  });
}

/** Shared no-write v2 static admission for execution and cache planning. */
export async function attestedRenderReuseStaticAdmission(
  request: FinalRenderRequest,
  invalidArgs: (message: string) => MotionDebugResult,
): Promise<MotionDebugResult | null> {
  try {
    if (request.frameLane === "gpu") {
      return invalidArgs("GPU final rendering cannot use reuseAttested: its post-render identity is evidence only and never authorizes cache planning or reuse.");
    }
    const pkg = await loadMotionPackage(request.packageRoot);
    const stillPreset = readStillFrameExportPreset(request.preset);
    const ffmpegPreset = readFfmpegExportPreset(request.preset);
    if (!stillPreset && !ffmpegPreset) return invalidArgs("motion.render.final reuseAttested supports file-producing still, GIF, and final-video presets only.");
    if (stillPreset) {
      if (request.frameLane === "native" && stillPreset !== "png-frame") {
        return { ok: false, error: { code: "unsupported_frame_lane", message: "Native still-frame renders currently support png-frame only." }, warnings: [] };
      }
      const nativeRefusal = nativeFrameLaneRefusal(pkg, request.frameLane, "still-frame");
      if (nativeRefusal) return { ok: false, ...nativeRefusal };
      const browserRefusal = request.frameLane === "browser" ? browserTypographyAttestationRefusal(pkg) : null;
      if (browserRefusal) return { ok: false, error: browserRefusal, warnings: [] };
      const outputPathError = stillFrameOutputPathError(stillPreset, request.outputPath);
      return outputPathError ? invalidArgs(outputPathError) : null;
    }
    const nativeRefusal = nativeFrameLaneRefusal(pkg, request.frameLane, "delivery");
    if (nativeRefusal) return { ok: false, ...nativeRefusal };
    const browserRefusal = request.frameLane === "browser" ? browserTypographyAttestationRefusal(pkg) : null;
    if (browserRefusal) return { ok: false, error: browserRefusal, warnings: [] };
    const outputPathError = ffmpegPresetOutputPathError(ffmpegPreset!, request.outputPath);
    return outputPathError ? invalidArgs(outputPathError) : null;
  } catch (error) {
    return { ok: false, error: { code: "render_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
  }
}
