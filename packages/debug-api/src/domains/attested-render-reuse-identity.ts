/** Exact v2 render-reuse identity derivation shared by execution and read-only planning. */
import {
  attestedRenderReuseCacheKey,
  canonicalJsonSha256,
  deriveAttestedRenderPackageFingerprint,
  hashAttestedRenderReuseExternalInput,
  type AttestedRenderReuseInputs,
  type AttestedRenderReusePlan,
} from "@shellx-motion/core";
import { readFfmpegExportPreset, readStillFrameExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import { deriveAttestedRenderReuseQualityInputs } from "./attested-render-reuse-quality-inputs.js";

/** The exact resolved render fields that v2 binds into its content-addressed cache key. */
export interface AttestedRenderReuseIdentityRequest {
  packageRoot: string;
  outputPath: string;
  /** GPU is deliberately excluded: its post-render identity is evidence only and never authorizes cache planning or reuse. */
  frameLane: "browser" | "native";
  preset: string;
  atMs?: number;
  minUniqueFrameHashes?: number;
  workflow?: BrowserCaptureWorkflow;
  workflowPath?: string;
  qualityManifestPath?: string;
}

export interface AttestedRenderReuseIdentity {
  inputs: AttestedRenderReuseInputs;
  plan: AttestedRenderReusePlan;
  cacheKey: string;
}

/**
 * Derive the one v2 identity. This deliberately owns neither an output root nor any descriptor
 * path: callers must apply their separate read-only or materialising root policy first.
 */
export async function deriveAttestedRenderReuseIdentity(input: {
  request: AttestedRenderReuseIdentityRequest;
  packageRoot: string;
  outputRootRelativePath: string;
  engineVersion: string;
}): Promise<AttestedRenderReuseIdentity> {
  const inputs = await deriveAttestedRenderReuseInputs(input.request, input.packageRoot);
  const plan = deriveAttestedRenderReusePlan(input.request, input.outputRootRelativePath, input.engineVersion);
  return { inputs, plan, cacheKey: attestedRenderReuseCacheKey(plan, inputs) };
}

export async function deriveAttestedRenderReuseInputs(
  request: AttestedRenderReuseIdentityRequest,
  packageRoot: string,
): Promise<AttestedRenderReuseInputs> {
  const qualityInputs = request.qualityManifestPath
    ? await deriveAttestedRenderReuseQualityInputs(request.qualityManifestPath)
    : {};
  return {
    schema: "shellx-motion/attested-render-inputs@2",
    packageSha256: await deriveAttestedRenderPackageFingerprint(packageRoot),
    ...(request.workflow ? { workflowSha256: canonicalJsonSha256(request.workflow) } : {}),
    ...(request.workflowPath ? { workflowPathSha256: await hashAttestedRenderReuseExternalInput(request.workflowPath) } : {}),
    ...qualityInputs,
  };
}

export function deriveAttestedRenderReusePlan(
  request: AttestedRenderReuseIdentityRequest,
  outputRootRelativePath: string,
  engineVersion: string,
): AttestedRenderReusePlan {
  const isStillFrame = Boolean(readStillFrameExportPreset(request.preset));
  const isFfmpeg = Boolean(readFfmpegExportPreset(request.preset));
  return {
    schema: "shellx-motion/attested-render-plan@2",
    outputRootRelativePath,
    preset: request.preset,
    frameLane: request.frameLane,
    engineVersion,
    // Bind resolved values, not surface spelling: omitted and explicit `atMs: 0` mean the same
    // still frame, while both fields are irrelevant to the other final-render lanes.
    ...(isStillFrame ? { atMs: request.atMs ?? 0 } : {}),
    ...(isFfmpeg && request.minUniqueFrameHashes !== undefined ? { minUniqueFrameHashes: request.minUniqueFrameHashes } : {}),
    workflow: request.workflowPath ? "path" : request.workflow ? "inline" : "none",
    qualityManifest: Boolean(request.qualityManifestPath),
  };
}
