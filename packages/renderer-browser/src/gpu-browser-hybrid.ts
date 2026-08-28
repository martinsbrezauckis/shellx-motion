import { createHash } from "node:crypto";
import {
  decodePngRgba,
  type AgentScriptExecutionEvidence,
  type MotionPackage,
} from "@shellx-motion/core";
import {
  markBrowserStreamingSessionOptions,
  renderBrowserStreamingFrame,
} from "./browser-streaming-session-registry";
import type { BrowserNetworkAccessOptions, BrowserFrameResult, MotionBrowserRenderSession } from "./index";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuSessionRgbaImageResource } from "./gpu-runtime-types";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import type { GpuHybridDataOnlyDocumentEvidence } from "./gpu-browser-hybrid-html-policy";
import { acquireGpuHybridCaptureScratch, type GpuHybridCaptureScratch } from "./gpu-hybrid-capture-scratch";

const MAX_GPU_HYBRID_CAPTURE_PNG_BYTES = 64 * 1024 * 1024;

export interface GpuHybridCaptureBinding {
  readonly schema: "shellx-motion/gpu-hybrid-capture@1";
  readonly classification: "gpu-hybrid";
  readonly producer: "governed-browser-surface";
  readonly browserOwnership: "borrowed-gpu-runtime";
  /** The governed browser branch loads only this declared source document. */
  readonly captureScope: "declared-browser-source-document";
  readonly layerId: string;
  readonly source: string;
  /** Cached UTF-8 source bytes admitted before the shared session opens Chromium. */
  readonly sourceDocument: GpuHybridDataOnlyDocumentEvidence;
  readonly browser: { readonly name: "chromium"; readonly version: string };
  /** Existing package/script authority evidence, retained without a new script claim. */
  readonly scriptExecution: AgentScriptExecutionEvidence;
  /** Existing host-approved network policy and response limits. */
  readonly network: BrowserFrameResult["output"]["network"];
  /** Exact package and capture-preparation identities from the governed browser receipt. */
  readonly inputHashes: Readonly<Record<string, string>>;
  /** Arbitrary HTML/canvas typography is deliberately unverified; no host-font claim exists. */
  readonly typography: "browser-html-canvas-unverified";
}

export interface GpuHybridCaptureFrame {
  readonly atMs: number;
  readonly texture: GpuSessionRgbaImageResource;
  readonly pngSha256: string;
  readonly binding: GpuHybridCaptureBinding;
}

export interface GpuHybridBrowserCapture {
  readonly binding: GpuHybridCaptureBinding;
  /** Stable source facts available before the first temporal capture. */
  readonly sourceSnapshot: { readonly sourceSnapshotSha256: string; readonly sourceByteLength: number };
  capture(atMs: number): Promise<GpuHybridCaptureFrame>;
  close(): Promise<void>;
}

export class GpuHybridCaptureError extends Error {
  readonly code: "gpu_hybrid_capture_refused" | "gpu_hybrid_capture_failed";

  constructor(code: GpuHybridCaptureError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "GpuHybridCaptureError";
    Object.setPrototypeOf(this, GpuHybridCaptureError.prototype);
  }
}

/**
 * Opens a deterministic browser producer on the exact Browser owned by the
 * persistent GPU runtime. It intentionally delegates page/package/script and
 * network enforcement to createMotionBrowserRenderSession instead of building
 * a second, weaker policy implementation.
 */
export async function openGpuHybridBrowserCapture(input: {
  readonly pkg: MotionPackage;
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
  readonly networkAccess?: BrowserNetworkAccessOptions;
  /** Internal direct-GPU selector: must be the one Core static descriptor layer. */
  readonly layerId?: string;
}): Promise<GpuHybridBrowserCapture> {
  const layer = input.layerId
    ? input.pkg.motion.layers.find((candidate) => candidate.id === input.layerId)
    : input.pkg.motion.layers.find((candidate) => candidate.visible !== false && isBrowserSurface(candidate.type));
  if (!layer || typeof layer.source !== "string" || !layer.source) {
    throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid rendering requires one admitted browser surface layer.");
  }
  if (!isBrowserSurface(layer.type)) {
    throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid rendering Core selection did not identify a browser surface layer.");
  }
  const firstBrowserSurface = input.layerId ? undefined : input.pkg.motion.layers.find((candidate) => isBrowserSurface(candidate.type));
  if (firstBrowserSurface && firstBrowserSurface.id !== layer.id) {
    throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid rendering requires its admitted visible browser surface to be the first browser surface in document order.");
  }
  const source = layer.source;
  const borrowGpuBrowser = input.runtime.borrowGpuBrowser;
  if (!borrowGpuBrowser) {
    throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid rendering requires the existing GPU runtime browser capability; it will not launch a second Chromium process.");
  }
  let scratch: GpuHybridCaptureScratch | undefined;
  let session: MotionBrowserRenderSession | undefined;
  try {
    scratch = await acquireGpuHybridCaptureScratch({ scratchRoot: input.job.scratchRoot, prefix: "gpu-hybrid" });
    // Dynamic import avoids a module-initialization cycle with the renderer
    // barrel, while the factory itself remains the one existing governed path.
    const { createMotionBrowserRenderSession } = await import("./index");
    const options = {
      borrowedGpuBrowser: borrowGpuBrowser(),
      hybridDataOnlySource: source,
      ...(input.networkAccess ? { networkAccess: input.networkAccess } : {})
    };
    markBrowserStreamingSessionOptions(options);
    session = await createMotionBrowserRenderSession(input.pkg, options);
    const sourceDocument = session.hybridDataOnlyDocument;
    if (!sourceDocument || sourceDocument.source !== source) {
      throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "Governed GPU hybrid session did not retain its strict data-only source admission.");
    }
    let active = false;
    let closed = false;
    let binding: GpuHybridCaptureBinding | undefined;
    const capture = async (atMs: number): Promise<GpuHybridCaptureFrame> => {
      if (closed) throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "GPU hybrid browser capture is closed.");
      if (active) throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid capture accepts exactly one frame at a time.");
      if (!Number.isFinite(atMs) || atMs < 0 || atMs > input.pkg.motion.durationMs) throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid capture timestamp is outside the retained Motion timeline.");
      active = true;
      try {
        const captured = await renderBrowserStreamingFrame(session!, {
          atMs,
          outDir: scratch!.root,
          outputPath: scratch!.pngPath
        }, {
          admission: "pre-acquired",
          jobId: "gpu-hybrid-source",
          scratchRoot: scratch!.root,
          signal: input.job.signal,
          // The GPU producer already watches and attests the one precontained
          // Chromium root. This inner source session must not report its Node
          // process as a second monitored browser or duplicate containment.
          watchProcess() {}
        });
        if (captured.png.byteLength < 1 || captured.png.byteLength > MAX_GPU_HYBRID_CAPTURE_PNG_BYTES) {
          throw new GpuHybridCaptureError("gpu_hybrid_capture_refused", "GPU hybrid browser capture exceeds its 64 MiB encoded-frame limit.");
        }
        const decoded = decodePngRgba(captured.png);
        if (decoded.width !== input.pkg.motion.width || decoded.height !== input.pkg.motion.height) {
          throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "GPU hybrid browser capture dimensions differ from the admitted GPU frame dimensions.");
        }
        const output = captured.result.output;
        if (!output.network || !output.scriptExecution || !output.typography || output.typography.attestation !== "unverified") {
          throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "Governed GPU hybrid capture did not retain required network, script, and unverified-HTML typography evidence.");
        }
        if (captured.result.receipt.inputHashes[`browser-package/${source}`] !== sourceDocument.sourceSha256) {
          throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "GPU hybrid capture receipt does not bind the exact strict data-only source bytes.");
        }
        const nextBinding: GpuHybridCaptureBinding = Object.freeze({
          schema: "shellx-motion/gpu-hybrid-capture@1",
          classification: "gpu-hybrid",
          producer: "governed-browser-surface",
          browserOwnership: "borrowed-gpu-runtime",
          captureScope: "declared-browser-source-document",
          layerId: layer.id,
          source,
          sourceDocument: Object.freeze({ ...sourceDocument }),
          browser: Object.freeze({ name: "chromium", version: output.browser.version }),
          scriptExecution: Object.freeze(structuredClone(output.scriptExecution)),
          network: Object.freeze(structuredClone(output.network)),
          inputHashes: Object.freeze({ ...captured.result.receipt.inputHashes }),
          typography: "browser-html-canvas-unverified"
        });
        if (binding && JSON.stringify(binding) !== JSON.stringify(nextBinding)) {
          throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "GPU hybrid capture provenance changed within one retained render session.");
        }
        binding = nextBinding;
        const pngSha256 = createHash("sha256").update(captured.png).digest("hex");
        const rgbaSha256 = createHash("sha256").update(decoded.rgba).digest("hex");
        return {
          atMs,
          pngSha256,
          binding,
          texture: {
            id: `browser-surface-${createHash("sha256").update(layer.id).digest("hex").slice(0, 24)}`,
            width: decoded.width,
            height: decoded.height,
            rgba: decoded.rgba,
            // The screenshot source and decoded pixels are distinct identities.
            // The persistent GPU uploader rechecks decodedSha256 before upload.
            sha256: pngSha256,
            decodedSha256: rgbaSha256
          }
        };
      } catch (error) {
        if (error instanceof GpuHybridCaptureError) throw error;
        throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", error instanceof Error ? error.message : "GPU hybrid browser capture failed.");
      } finally {
        active = false;
      }
    };
    // Force source/script/network admission before reporting a usable producer.
    // The first exact timestamp is still captured in the canonical loop; this
    // object only describes the session until then.
    return {
      sourceSnapshot: Object.freeze({ sourceSnapshotSha256: sourceDocument.sourceSha256, sourceByteLength: sourceDocument.byteLength }),
      get binding() {
        if (!binding) throw new GpuHybridCaptureError("gpu_hybrid_capture_failed", "GPU hybrid capture has no exact frame evidence yet.");
        return binding;
      },
      capture,
      async close() {
        if (closed) return;
        closed = true;
        const outcomes = await Promise.allSettled([session?.close(), scratch?.release()]);
        const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "GPU hybrid browser cleanup failed.");
      }
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([session?.close(), scratch?.release()]);
    const failures = cleanup.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "GPU hybrid browser setup and cleanup both failed.");
    throw error;
  }
}

export function isGpuHybridBrowserPackage(pkg: MotionPackage): boolean {
  return pkg.motion.layers.some((layer) => layer.visible !== false && isBrowserSurface(layer.type));
}

function isBrowserSurface(type: unknown): boolean {
  return type === "web" || type === "html" || type === "canvas";
}
