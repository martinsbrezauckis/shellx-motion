import { DerivedOutputPublicationError, type MaterializedFrameSequencePreflight } from "@shellx-motion/core";
import type { MotionDebugResult } from "./command-registry.js";
import { corePublicationUncertainty } from "./publication-uncertainty.js";

export function stripFrameTimestampMs(frameIndex: number, frameCount: number, startMs: number, endMs: number): number {
  if (frameCount <= 1) return Math.round(startMs);
  return Math.round(startMs + ((endMs - startMs) * frameIndex) / (frameCount - 1));
}

export function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

export function debugFinalOutputFailure(error: unknown): MotionDebugResult {
  const uncertainty = corePublicationUncertainty(error);
  if (uncertainty) {
    return {
      ok: false,
      error: {
        code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "publication_commit_uncertain",
        message: error instanceof Error ? error.message : "Publication commit may have completed.",
        detail: uncertainty
      },
      result: uncertainty,
      warnings: []
    };
  }
  if (error instanceof DerivedOutputPublicationError) {
    return { ok: false, error: { code: error.code, message: error.message }, warnings: [] };
  }
  return { ok: false, error: { code: "render_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}

export function materializedPreflightFailure(resourcePreflight: MaterializedFrameSequencePreflight): MotionDebugResult {
  const refusal = resourcePreflight.refusal;
  return {
    ok: false,
    error: {
      code: refusal?.code ?? "render_resource_preflight_exceeded",
      message: refusal?.message ?? "Materialized frame sequence was refused before render allocation.",
      ...(refusal?.suggestedAction ? { suggestedAction: refusal.suggestedAction } : {}),
      detail: { resourcePreflight }
    },
    result: { resourcePreflight },
    warnings: []
  };
}
