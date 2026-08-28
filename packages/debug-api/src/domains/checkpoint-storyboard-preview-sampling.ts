/** C6C B1d: Debug-owned sampling facts and terminal-boundary evidence validation. */
import { canonicalJson, compareCodeUnits, hashBuffer } from "@shellx-motion/core";
import type { CheckpointStoryboardTerminalBoundaryEvidence } from "@shellx-motion/renderer-browser/internal/checkpoint-storyboard-terminal-boundary";
import type { CheckpointStoryboardPreviewSampling, CheckpointStoryboardPreviewTarget } from "./checkpoint-storyboard-preview-state.js";
import { storeError } from "./checkpoint-storyboard-record-store-types.js";

export function previewSampling(target: CheckpointStoryboardPreviewTarget, durationMs: number): CheckpointStoryboardPreviewSampling {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || !Number.isSafeInteger(target.resolvedAtMs) || target.resolvedAtMs < 0 || target.resolvedAtMs > durationMs) {
    throw storeError("preview_target_invalid", "Checkpoint storyboard Browser preview sampling range is invalid.");
  }
  if (target.resolvedAtMs === durationMs) {
    return Object.freeze({ mode: "terminal-boundary", renderedAtMs: durationMs, documentDurationMs: durationMs, interval: "[0,D)", layerContent: "excluded-no-hold" });
  }
  return Object.freeze({ mode: "interior", renderedAtMs: target.resolvedAtMs, documentDurationMs: durationMs, interval: "[0,D)", layerContent: "included" });
}

export function checkpointStoryboardPreviewSamplingSha256(state: Readonly<{ schema: string; sampling?: CheckpointStoryboardPreviewSampling }>): string {
  const evidence = state.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@1"
    ? Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-preview-legacy-interior@1" as const })
    : state.sampling;
  if (!evidence) throw storeError("store_integrity_failed", "Checkpoint storyboard preview sampling evidence is missing.");
  return hashBuffer(Buffer.from(canonicalJson(evidence), "utf8"));
}

/**
 * The renderer capability is opaque, so Debug treats its endpoint facts as untrusted until this
 * exact structural check succeeds. This is intentionally before receipt-first publication.
 */
export function assertSamplingFrameEvidence(
  output: Readonly<{ atMs: number; width: number; height: number; terminalBoundary?: unknown }>,
  sampling: CheckpointStoryboardPreviewSampling,
  width: number,
  height: number,
  background: string | undefined,
): CheckpointStoryboardTerminalBoundaryEvidence | undefined {
  if (sampling.mode === "interior") {
    if (output.terminalBoundary !== undefined) throw storeError("preview_publication_uncertain", "Checkpoint storyboard interior Browser preview returned terminal-boundary evidence.");
    return undefined;
  }
  if (background === undefined || output.atMs !== sampling.renderedAtMs || output.width !== width || output.height !== height) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard terminal Browser preview did not retain exact background-only endpoint evidence.");
  }
  return readCheckpointStoryboardTerminalBoundaryEvidence(output.terminalBoundary, sampling, width, height, background);
}

/** Strictly reopens the exact terminal facts retained in the signed B1b v2 receipt. */
export function readCheckpointStoryboardTerminalBoundaryEvidence(
  value: unknown,
  sampling: Extract<CheckpointStoryboardPreviewSampling, { mode: "terminal-boundary" }>,
  width: number,
  height: number,
  expectedBackground?: string,
): CheckpointStoryboardTerminalBoundaryEvidence {
  const background = expectedBackground ?? terminalEvidenceBackground(value);
  if (background === undefined || !isExactTerminalBoundaryEvidence(value, sampling, width, height, background)) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard terminal Browser preview did not retain exact background-only endpoint evidence.");
  }
  return value;
}

export function normalizedTerminalBackground(value: unknown): string {
  const background = value ?? "#00000000";
  if (typeof background !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(background)) {
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard terminal Browser preview package did not retain a static background.");
  }
  return background.toLowerCase();
}

function isExactTerminalBoundaryEvidence(
  value: unknown,
  sampling: Extract<CheckpointStoryboardPreviewSampling, { mode: "terminal-boundary" }>,
  width: number,
  height: number,
  background: string,
): value is CheckpointStoryboardTerminalBoundaryEvidence {
  if (!exactRecord(value, ["schema", "mode", "endpoint", "execution", "document", "network"])) return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== "shellx-motion/checkpoint-storyboard-terminal-boundary@1" || record.mode !== "exact-duration-static-background") return false;
  if (!exactRecord(record.endpoint, ["requestedAtMs", "durationMs", "exactDuration"]) || !exactRecord(record.execution, ["renderFramesCalls", "requestedFrames", "capturedFrames", "maxConcurrency", "maxFrameAttempts", "retries", "cacheHits", "reused"]) || !exactRecord(record.document, ["width", "height", "background", "layersLoaded", "sourceLoads", "fontLoads", "assetLoads", "scriptLoads", "mediaLoads", "webglContexts"]) || !exactRecord(record.network, ["policy", "approvedOrigins", "requestsAllowed", "webSocketsAllowed"])) return false;
  const endpoint = record.endpoint as Record<string, unknown>;
  const execution = record.execution as Record<string, unknown>;
  const document = record.document as Record<string, unknown>;
  const network = record.network as Record<string, unknown>;
  return endpoint.requestedAtMs === sampling.renderedAtMs && endpoint.durationMs === sampling.documentDurationMs && endpoint.exactDuration === true
    && execution.renderFramesCalls === 1 && execution.requestedFrames === 1 && execution.capturedFrames === 1 && execution.maxConcurrency === 1 && execution.maxFrameAttempts === 1 && execution.retries === 0 && execution.cacheHits === 0 && execution.reused === false
    && document.width === width && document.height === height && document.background === background && document.layersLoaded === 0 && document.sourceLoads === 0 && document.fontLoads === 0 && document.assetLoads === 0 && document.scriptLoads === 0 && document.mediaLoads === 0 && document.webglContexts === 0
    && network.policy === "deny-all" && Array.isArray(network.approvedOrigins) && network.approvedOrigins.length === 0 && network.requestsAllowed === 0 && network.webSocketsAllowed === 0;
}

function terminalEvidenceBackground(value: unknown): string | undefined {
  if (!exactRecord(value, ["schema", "mode", "endpoint", "execution", "document", "network"])) return undefined;
  const document = (value as Record<string, unknown>).document;
  if (!exactRecord(document, ["width", "height", "background", "layersLoaded", "sourceLoads", "fontLoads", "assetLoads", "scriptLoads", "mediaLoads", "webglContexts"])) return undefined;
  const background = (document as Record<string, unknown>).background;
  return typeof background === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(background) ? background : undefined;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
