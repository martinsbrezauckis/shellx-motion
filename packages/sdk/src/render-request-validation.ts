/** Request-only invariants for materialized and v2 attested SDK renders. */
import { renderKeepFramesRequestError } from "./render-client-guards";

export function renderRequestValidationError(input: Record<string, unknown>): string {
  if (input.frameLane !== undefined && input.frameLane !== "browser" && input.frameLane !== "native" && input.frameLane !== "gpu") {
    return "SDK render frameLane must be browser, native, or gpu.";
  }
  if (input.frameLane === "gpu") {
    if (input.keepFrames === true) return "SDK GPU final rendering requires the strict streamed FFmpeg path and does not retain materialized frames.";
    if (input.workflowPath !== undefined) return "SDK GPU final rendering does not support browser workflows and never falls back to browser materialization.";
    if (input.qualityManifestPath !== undefined) return "SDK GPU final rendering does not support exact-source quality manifests because they require materialized frames.";
    if (input.reuseAttested === true) return "SDK GPU final rendering cannot use reuseAttested: its post-render identity is evidence only and never authorizes cache planning or reuse.";
    if (input.idempotencyKey !== undefined) return "SDK GPU final rendering cannot use idempotencyKey because it would claim pre-render cache reuse; GPU post-render identity is evidence only.";
  }
  if (input.cutHandoff !== undefined) {
    const cut = plainRecord(input.cutHandoff);
    if (!cut || Object.keys(cut).some((key) => key !== "target" && key !== "mode")
      || cut.target !== "shellx-cut" || cut.mode !== "rendered_media") {
      return "SDK render cutHandoff must request shellx-cut rendered_media.";
    }
  }
  const keepFramesError = renderKeepFramesRequestError(input);
  if (keepFramesError) return keepFramesError;
  const segmentedError = segmentedFinalRequestError(input);
  if (segmentedError) return segmentedError;
  if (input.reuseAttested !== undefined && typeof input.reuseAttested !== "boolean") return "SDK render reuseAttested must be boolean.";
  if (input.reuseAttested === true && input.idempotencyKey !== undefined) {
    return "SDK render reuseAttested derives its v2 key from current render inputs; omit legacy idempotencyKey.";
  }
  if (input.reuseAttested === true && input.artifactRoot !== undefined) {
    return "SDK render reuseAttested derives its root from outputPath; omit legacy artifactRoot.";
  }
  return "";
}

function segmentedFinalRequestError(input: Record<string, unknown>): string {
  if (input.segmented === undefined) return "";
  const segmented = plainRecord(input.segmented);
  if (!segmented || Object.keys(segmented).some((key) => key !== "segmentFrames" && key !== "resume")
    || !Number.isSafeInteger(segmented.segmentFrames) || (segmented.segmentFrames as number) < 1
    || (segmented.resume !== undefined && typeof segmented.resume !== "boolean")) {
    return "SDK render segmented must be { segmentFrames: positive safe integer, resume?: boolean } with no additional properties.";
  }
  if (input.keepFrames !== undefined) return "SDK segmented render does not accept keepFrames; its checkpoint store is derived from outputPath.";
  if (input.workflowPath !== undefined || input.qualityManifestPath !== undefined) return "SDK segmented render does not support browser workflows or exact-source quality manifests.";
  if (input.reuseAttested !== undefined) return "SDK segmented render cannot be combined with reuseAttested.";
  return "";
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => "value" in descriptor) ? value as Record<string, unknown> : null;
}
