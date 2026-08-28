import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  createGpuHybridTextureResourceBinding,
  compileGpuHybridTextureRequests,
  decodePngRgba,
  gpuHybridTextureRequestProblem,
  gpuHybridTextureResourceBindingFailure,
  streamingFrameTimestampMs,
  type GpuHybridTextureRequest,
  type GpuHybridTextureResourceBinding,
  type GpuHybridTextureStaticDescriptor,
  type MotionLayer,
  type MotionPackage,
} from "@shellx-motion/core";
import { markBrowserStreamingSessionOptions, renderBrowserStreamingFrame } from "./browser-streaming-session-registry";
import { gpuSegmentedHybridPrivateState } from "./gpu-segmented-hybrid-admission";
import { acquireGpuHybridCaptureScratch, releaseGpuHybridCaptureScratch, type GpuHybridCaptureScratch } from "./gpu-hybrid-capture-scratch";
import { assertRestrictedShaderCaptureEvidence } from "./gpu-restricted-shader-hybrid";
import { createGpuHybridCaptureLedger } from "./gpu-segmented-hybrid-ledger";
import type { MotionBrowserRenderSession } from "./index";
import {
  type GpuSegmentedHybridRangeCapture,
  type GpuSegmentedHybridRangeCaptureInput,
  type GpuSegmentedHybridRangeCleanupEvidence,
} from "./gpu-segmented-hybrid-types";

/**
 * Opens no Chromium at construction. The first active exact Core request
 * creates one borrowed-browser context for this range; close aborts it before
 * releasing the exact private scratch child.
 */
export function openGpuSegmentedHybridRangeCapture(
  input: GpuSegmentedHybridRangeCaptureInput
): GpuSegmentedHybridRangeCapture {
  if (!input.runtime.borrowGpuBrowser || !input.runtime.replaceDynamicImages) {
    throw new Error("GPU segmented hybrid capture requires a pre-reserved dynamic texture and a borrowed GPU browser.");
  }
  if (input.runtime.browserVersion?.trim() !== input.admission.identity.browser.version) {
    throw new Error("GPU segmented hybrid capture runtime browser version does not match its pre-store identity.");
  }
  const state = gpuSegmentedHybridPrivateState(input.admission);
  validateSchedule(input, state.layer, state.packageTemplate);
  const ledger = createGpuHybridCaptureLedger({ range: input.range, expectedCaptureCount: input.schedule.length });
  const aborter = new AbortController();
  let scratch: GpuHybridCaptureScratch | undefined;
  let session: MotionBrowserRenderSession | undefined;
  let active: Promise<unknown> | undefined;
  let captureOrdinal = 0;
  let closed = false;
  let cleanup: Promise<GpuSegmentedHybridRangeCleanupEvidence> | undefined;

  const closeResources = (): Promise<GpuSegmentedHybridRangeCleanupEvidence> => {
    closed = true;
    if (!aborter.signal.aborted) aborter.abort(new Error("GPU segmented hybrid range capture closed."));
    cleanup ??= (async () => {
      const closingSession = session?.close();
      const closingScratch = scratch
        ? releaseGpuHybridCaptureScratch(scratch.authority, [scratch.pngPath, `${scratch.root}/${state.sourceFileName}`])
        : undefined;
      const outcomes = await Promise.allSettled([closingSession, closingScratch]);
      const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "GPU segmented hybrid range cleanup failed.");
      return Object.freeze({
        captureContext: session ? "closed" as const : "not-opened" as const,
        scratch: scratch ? "released" as const : "not-opened" as const,
        dynamicTexture: Object.freeze({ ...input.admission.dynamicTexture })
      });
    })();
    return cleanup;
  };

  const ensureSession = async (): Promise<MotionBrowserRenderSession> => {
    if (session) return session;
    scratch = await acquireGpuHybridCaptureScratch({ scratchRoot: input.job.scratchRoot, prefix: "gpu-segmented-hybrid", rangeIndex: input.range.index });
    try {
      await scratch.authority.assertCurrent();
      await writeFile(`${scratch.root}/${state.sourceFileName}`, state.sourceBytes, { flag: "wx", mode: 0o600 });
      await scratch.authority.assertCurrent();
      const { createMotionBrowserRenderSession } = await import("./index");
      const options = {
        borrowedGpuBrowser: input.runtime.borrowGpuBrowser!(),
        ...(input.admission.identity.descriptor.producer === "strict-data-only-html" ? { hybridDataOnlySource: state.sourceFileName } : {})
      };
      markBrowserStreamingSessionOptions(options);
      await scratch.authority.assertCurrent();
      session = await createMotionBrowserRenderSession(capturePackage(input.admission.identity.descriptor, state.packageTemplate, state.layer, state.sourceFileName, scratch.root), options);
      return session;
    } catch (error) {
      try {
        await closeResources();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "GPU segmented hybrid setup and cleanup both failed.");
      }
      throw error;
    }
  };

  return Object.freeze({
    identity: input.admission.identity,
    async capture({ index, atMs, request, signal }: {
      readonly index: number;
      readonly atMs: number;
      readonly request: GpuHybridTextureRequest;
      readonly signal?: AbortSignal;
    }) {
      if (closed || active) throw new Error("GPU segmented hybrid range capture is closed or already processing an exact request.");
      validateRequest(input, state.layer, state.packageTemplate, input.schedule[captureOrdinal], index, atMs, request);
      const operation = (async () => {
        const combined = mergeSignals(input.job.signal, aborter.signal, signal);
        try {
          const opened = await ensureSession();
          const captured = await renderBrowserStreamingFrame(opened, {
            atMs,
            outDir: scratch!.root,
            outputPath: scratch!.pngPath
          }, {
            admission: "pre-acquired",
            jobId: "gpu-segmented-hybrid-source",
            scratchRoot: scratch!.root,
            signal: combined.signal,
            watchProcess() {}
          });
          const decoded = decodePngRgba(captured.png);
          if (decoded.width !== request.width || decoded.height !== request.height || decoded.rgba.byteLength !== request.width * request.height * 4) {
            throw new Error("GPU segmented hybrid capture dimensions do not match its exact Core request.");
          }
          assertCaptureEvidence(input, state.layer, state.sourceFileName, captured.result, state.sourceBytes.byteLength);
          const pngSha256 = createHash("sha256").update(captured.png).digest("hex");
          const decodedRgbaSha256 = createHash("sha256").update(decoded.rgba).digest("hex");
          const replaced = await input.runtime.replaceDynamicImages!([{
            id: input.admission.dynamicTexture.id,
            width: request.width,
            height: request.height,
            rgba: decoded.rgba,
            sha256: input.admission.dynamicTexture.sourceSha256,
            decodedSha256: decodedRgbaSha256
          }], { signal: combined.signal });
          if (!replaced.ok || replaced.replaced !== 1) throw new Error(replaced.ok ? "GPU segmented hybrid dynamic texture replacement count changed." : replaced.failure.message);
          const resource = createGpuHybridTextureResourceBinding({ request, resourceId: input.admission.dynamicTexture.id, decodedRgbaSha256 });
          const bindingFailure = gpuHybridTextureResourceBindingFailure({ motion: state.packageTemplate.motion, layer: state.layer, atUs: request.atUs, request, resource });
          if (bindingFailure) throw new Error(bindingFailure);
          ledger.observe({ index, atMs, atUs: request.atUs, requestFingerprint: request.requestFingerprint, resourceId: resource.resourceId, width: resource.width, height: resource.height, pngSha256, decodedRgbaSha256 });
          captureOrdinal += 1;
          return resource;
        } finally {
          combined.dispose();
        }
      })();
      active = operation;
      try {
        return await operation;
      } catch (error) {
        try {
          await closeResources();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "GPU segmented hybrid capture and cleanup both failed.");
        }
        throw error;
      } finally {
        active = undefined;
      }
    },
    finish() {
      if (active) throw new Error("GPU segmented hybrid range ledger cannot finish while a capture is active.");
      return ledger.finish();
    },
    async close() {
      if (active) await active.catch(() => undefined);
      return await closeResources();
    }
  });
}

function validateRequest(
  input: GpuSegmentedHybridRangeCaptureInput,
  layer: MotionLayer,
  pkg: MotionPackage,
  expected: GpuSegmentedHybridRangeCaptureInput["schedule"][number] | undefined,
  index: number,
  atMs: number,
  request: GpuHybridTextureRequest
): void {
  const problem = gpuHybridTextureRequestProblem(request);
  if (problem || !expected || expected.index !== index || expected.atMs !== atMs || expected.request.requestFingerprint !== request.requestFingerprint || !Number.isSafeInteger(index) || index < input.range.startFrameIndex || index >= input.range.endFrameIndexExclusive || !Number.isFinite(atMs) || atMs !== streamingFrameTimestampMs(index, pkg.motion.fps, pkg.motion.durationMs) || Math.round(atMs * 1_000) !== request.atUs || request.layerId !== layer.id || request.producer !== input.admission.identity.descriptor.producer || request.staticDescriptorFingerprint !== input.admission.identity.descriptor.descriptorFingerprint || request.sourceSnapshotSha256 !== input.admission.identity.sourceSnapshot.sourceSnapshotSha256 || request.sourceByteLength !== input.admission.identity.sourceSnapshot.sourceByteLength || request.captureContractSha256 !== input.admission.identity.captureContractSha256 || request.snapshotFingerprint !== input.admission.identity.sourceSnapshot.snapshotFingerprint || request.width !== input.admission.dynamicTexture.width || request.height !== input.admission.dynamicTexture.height) {
    throw new Error(`GPU segmented hybrid range received a forged or non-canonical Core request${problem ? `: ${problem}` : "."}`);
  }
}

function validateSchedule(input: GpuSegmentedHybridRangeCaptureInput, layer: MotionLayer, pkg: MotionPackage): void {
  const range = input.range;
  if (!Number.isSafeInteger(range.index) || range.index < 0 || !Number.isSafeInteger(range.startFrameIndex) || !Number.isSafeInteger(range.endFrameIndexExclusive) || range.startFrameIndex < 0 || range.endFrameIndexExclusive <= range.startFrameIndex) {
    throw new Error("GPU segmented hybrid range has invalid canonical frame bounds.");
  }
  const expected: GpuSegmentedHybridRangeCaptureInput["schedule"][number][] = [];
  for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
    const atMs = streamingFrameTimestampMs(index, pkg.motion.fps, pkg.motion.durationMs);
    const atUs = Math.round(atMs * 1_000);
    const inactiveProbe = compileGpuHybridTextureRequests({
      motion: pkg.motion,
      atUs,
      snapshots: new Map()
    });
    const planned = inactiveProbe.ok
      ? inactiveProbe
      : compileGpuHybridTextureRequests({
        motion: pkg.motion,
        atUs,
        snapshots: new Map([[input.admission.identity.sourceSnapshot.layerId, input.admission.identity.sourceSnapshot]])
      });
    if (!planned.ok) throw new Error(`GPU segmented hybrid range Core request planning failed: ${planned.failure.message}`);
    for (const request of planned.requests) expected.push({ index, atMs, request });
  }
  if (expected.length !== input.schedule.length || expected.some((entry, index) => {
    const supplied = input.schedule[index];
    return supplied?.index !== entry.index || supplied.atMs !== entry.atMs || supplied.request.requestFingerprint !== entry.request.requestFingerprint;
  })) {
    throw new Error("GPU segmented hybrid range schedule omitted, shifted, or changed an exact Core request.");
  }
  let previous = range.startFrameIndex - 1;
  for (const entry of input.schedule) {
    if (!entry || !Number.isSafeInteger(entry.index) || entry.index <= previous || entry.index < range.startFrameIndex || entry.index >= range.endFrameIndexExclusive || !Number.isFinite(entry.atMs) || Math.round(entry.atMs * 1_000) !== entry.request.atUs) {
      throw new Error("GPU segmented hybrid range schedule is not canonical global frame order.");
    }
    validateRequest(input, layer, pkg, entry, entry.index, entry.atMs, entry.request);
    previous = entry.index;
  }
}


function assertCaptureEvidence(
  input: GpuSegmentedHybridRangeCaptureInput,
  layer: MotionLayer,
  sourceFileName: string,
  captured: Awaited<ReturnType<typeof renderBrowserStreamingFrame>>["result"],
  sourceBytes: number
): void {
  const output = captured.output;
  if (!output.network || !output.scriptExecution || output.network.approvedOrigins.length !== 0 || output.network.pins.length !== 0 || output.network.allowPrivateNetwork || output.scriptExecution.activeMode !== "data-only" || output.scriptExecution.sources.length !== 0) {
    throw new Error("GPU segmented hybrid capture did not retain its exact no-network data-only browser policy.");
  }
  const sourceHash = input.admission.identity.sourceSnapshot.sourceSnapshotSha256;
  const sourceReceiptKey = input.admission.identity.descriptor.producer === "isolated-restricted-glsl"
    ? sourceFileName
    : `browser-package/${sourceFileName}`;
  if (captured.receipt.inputHashes[sourceReceiptKey] !== sourceHash) {
    throw new Error("GPU segmented hybrid capture receipt does not bind the frozen source snapshot.");
  }
  if (input.admission.identity.descriptor.producer === "isolated-restricted-glsl") {
    assertRestrictedShaderCaptureEvidence({ output, inputHashes: captured.receipt.inputHashes, layer, assetRef: sourceFileName, sourceSha256: sourceHash, sourceBytes });
  } else if (output.typography?.attestation !== "unverified") {
    throw new Error("GPU segmented strict HTML capture lost its required unverified browser typography boundary.");
  }
}

function capturePackage(
  descriptor: GpuHybridTextureStaticDescriptor,
  template: MotionPackage,
  sourceLayer: MotionLayer,
  sourceFileName: "source.html" | "source.glsl",
  root: string
): MotionPackage {
  const layer = structuredClone(sourceLayer) as MotionLayer & { assetRef?: string; src?: string };
  layer.source = sourceFileName;
  layer.assetRef = undefined;
  layer.src = undefined;
  let assets: MotionPackage["motion"]["assets"] = [];
  let motion = structuredClone(template.motion);
  if (descriptor.producer === "isolated-restricted-glsl") {
    const asset = template.motion.assets.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as { id?: unknown }).id === layer.shader?.fragmentAssetId);
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new Error("GPU segmented restricted shader snapshot lost its declared asset.");
    const cloned = structuredClone(asset) as { source?: { path?: string } };
    if (!cloned.source) throw new Error("GPU segmented restricted shader snapshot asset has no local source.");
    cloned.source.path = sourceFileName;
    assets = [cloned];
    const keyframes = Object.fromEntries(Object.entries(layer.keyframes ?? {}).filter(([key]) => key.startsWith("shader.uniforms.")));
    Object.assign(layer, {
      transform: { width: descriptor.width, height: descriptor.height },
      width: descriptor.width,
      height: descriptor.height,
      opacity: 1,
      blendMode: "normal",
      keyframes: Object.keys(keyframes).length ? keyframes : undefined,
      style: undefined,
      effects: undefined,
      mask: undefined,
      matte: undefined,
      keying: undefined,
      crop: undefined,
      transitions: undefined,
      depth: undefined,
    });
    motion = {
      ...motion,
      id: `${motion.id}-gpu-restricted-shader`,
      width: descriptor.width,
      height: descriptor.height,
      background: "transparent",
    };
  }
  return {
    root,
    manifest: {
      ...structuredClone(template.manifest),
      ...(descriptor.producer === "isolated-restricted-glsl" ? { id: `${template.manifest.id}-gpu-restricted-shader` } : {}),
      assets: [sourceFileName]
    },
    motion: { ...motion, assets, layers: [layer] }
  };
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { abort(signal); break; }
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return { signal: controller.signal, dispose() { for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener); } };
}
