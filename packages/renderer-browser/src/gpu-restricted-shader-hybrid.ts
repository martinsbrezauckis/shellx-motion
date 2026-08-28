import { createHash, randomUUID } from "node:crypto";
import { rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  decodePngRgba,
  gpuRestrictedShaderAssetRef,
  gpuRestrictedShaderTextureDimensions,
  isGpuRestrictedShaderHybridLayer,
  OutputDirectoryReservation,
  readVerifiedPackageAsset,
  validateRestrictedFragmentShader,
  type AgentScriptExecutionEvidence,
  type MotionLayer,
  type MotionPackage,
  type RetainedDirectoryAuthority,
} from "@shellx-motion/core";
import { markBrowserStreamingSessionOptions, renderBrowserStreamingFrame } from "./browser-streaming-session-registry";
import type { BrowserFrameResult, MotionBrowserRenderSession } from "./index";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import type { GpuSessionRgbaImageResource } from "./gpu-runtime-types";

const MAX_CAPTURE_PNG_BYTES = 64 * 1024 * 1024;

export interface GpuRestrictedShaderHybridBinding {
  readonly schema: "shellx-motion/gpu-restricted-shader-hybrid@1";
  readonly classification: "gpu-restricted-shader-hybrid";
  readonly producer: "governed-restricted-glsl-webgl";
  readonly browserOwnership: "borrowed-gpu-runtime";
  readonly captureScope: "isolated-shader-layer-texture";
  readonly layerId: string;
  readonly source: string;
  readonly shader: {
    readonly schema: "shellx-motion/shader-plugin@1";
    readonly language: "glsl-es-100-expression";
    readonly assetRef: string;
    readonly sourceSha256: string;
    readonly byteLength: number;
    readonly seed: number;
    readonly uniformNames: readonly string[];
    readonly validation: "restricted-expression-only";
  };
  readonly texture: { readonly width: number; readonly height: number; readonly encoding: "png"; readonly alpha: "straight-rgba" };
  readonly browser: { readonly name: "chromium"; readonly version: string };
  readonly scriptExecution: AgentScriptExecutionEvidence;
  readonly network: BrowserFrameResult["output"]["network"];
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly typography: "not-applicable-isolated-webgl";
}

export interface GpuRestrictedShaderHybridCaptureFrame {
  readonly atMs: number;
  readonly pngSha256: string;
  readonly texture: GpuSessionRgbaImageResource;
  readonly binding: GpuRestrictedShaderHybridBinding;
}

export interface GpuRestrictedShaderHybridCapture {
  readonly binding: GpuRestrictedShaderHybridBinding;
  /** Stable GLSL facts available before the first temporal capture. */
  readonly sourceSnapshot: { readonly sourceSnapshotSha256: string; readonly sourceByteLength: number };
  capture(atMs: number): Promise<GpuRestrictedShaderHybridCaptureFrame>;
  close(): Promise<void>;
}

export class GpuRestrictedShaderHybridError extends Error {
  readonly code: "gpu_restricted_shader_hybrid_refused" | "gpu_restricted_shader_hybrid_failed";
  constructor(code: GpuRestrictedShaderHybridError["code"], message: string) {
    super(message); this.code = code; Object.setPrototypeOf(this, GpuRestrictedShaderHybridError.prototype);
  }
}

export function isGpuRestrictedShaderHybridPackage(pkg: MotionPackage): boolean {
  return pkg.motion.layers.some((layer) => layer.visible !== false && isGpuRestrictedShaderHybridLayer(layer));
}

/**
 * Rasterizes one verified legacy GLSL layer inside the already-contained GPU
 * Chromium. The isolated package has a transparent raw texture canvas: GPU
 * subsequently owns the original layer transform, blend, mask, and composite.
 */
export async function openGpuRestrictedShaderHybridCapture(input: {
  readonly pkg: MotionPackage;
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
  /** Internal direct-GPU selector: must be the one Core static descriptor layer. */
  readonly layerId?: string;
}): Promise<GpuRestrictedShaderHybridCapture> {
  const layer = selectLayer(input.pkg, input.layerId);
  const assetRef = gpuRestrictedShaderAssetRef(input.pkg.motion, layer);
  const dimensions = gpuRestrictedShaderTextureDimensions(input.pkg.motion, layer);
  if (!assetRef || !dimensions) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid requires one declared bounded package GLSL source and texture size.");
  const stable = await readVerifiedPackageAsset(input.pkg, assetRef, { label: `GPU restricted shader ${layer.id}`, maxBytes: 16 * 1024 });
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(stable.bytes); }
  catch { throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid requires canonical UTF-8 GLSL source bytes."); }
  const uniformNames = Object.keys(layer.shader?.uniforms ?? {}).sort();
  const validation = validateRestrictedFragmentShader(source, uniformNames);
  if (!validation.ok) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", `GPU restricted-shader hybrid source was refused: ${validation.errors.join("; ")}`);
  const borrowed = input.runtime.borrowGpuBrowser;
  if (!borrowed) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid requires the existing GPU runtime browser; it will not launch a second Chromium process.");
  let reservation: OutputDirectoryReservation | undefined;
  let session: MotionBrowserRenderSession | undefined;
  try {
    reservation = await OutputDirectoryReservation.acquire(join(input.job.scratchRoot, `gpu-restricted-shader-${randomUUID()}`), { requireAbsent: true, requirePrivate: true });
    const root = reservation.path;
    const { createMotionBrowserRenderSession } = await import("./index");
    const options = { borrowedGpuBrowser: borrowed() };
    markBrowserStreamingSessionOptions(options);
    session = await createMotionBrowserRenderSession(isolatedShaderPackage(input.pkg, layer, assetRef, dimensions), options);
    let active = false, closed = false, binding: GpuRestrictedShaderHybridBinding | undefined;
    const capture = async (atMs: number): Promise<GpuRestrictedShaderHybridCaptureFrame> => {
      if (closed) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_failed", "GPU restricted-shader hybrid capture is closed.");
      if (active || !Number.isFinite(atMs) || atMs < 0 || atMs > input.pkg.motion.durationMs) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid accepts one in-range exact-time capture at a time.");
      active = true;
      try {
        const captured = await renderBrowserStreamingFrame(session!, { atMs, outDir: root!, outputPath: join(root!, "shader.png") }, { admission: "pre-acquired", jobId: "gpu-restricted-shader-source", scratchRoot: root!, signal: input.job.signal, watchProcess() {} });
        if (captured.png.byteLength < 1 || captured.png.byteLength > MAX_CAPTURE_PNG_BYTES) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid PNG exceeds its 64 MiB capture limit.");
        const decoded = decodePngRgba(captured.png);
        if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_failed", "GPU restricted-shader hybrid capture dimensions differ from its admitted isolated texture.");
        const output = captured.result.output;
        assertRestrictedShaderCaptureEvidence({ output, inputHashes: captured.result.receipt.inputHashes, layer, assetRef, sourceSha256: stable.sha256, sourceBytes: stable.byteLength });
        const next: GpuRestrictedShaderHybridBinding = Object.freeze({
          schema: "shellx-motion/gpu-restricted-shader-hybrid@1", classification: "gpu-restricted-shader-hybrid", producer: "governed-restricted-glsl-webgl", browserOwnership: "borrowed-gpu-runtime", captureScope: "isolated-shader-layer-texture", layerId: layer.id, source: assetRef,
          shader: Object.freeze({ schema: layer.shader!.schema, language: layer.shader!.language, assetRef, sourceSha256: stable.sha256, byteLength: stable.byteLength, seed: layer.shader!.seed, uniformNames: Object.freeze([...uniformNames]), validation: "restricted-expression-only" }),
          texture: Object.freeze({ width: dimensions.width, height: dimensions.height, encoding: "png", alpha: "straight-rgba" }), browser: Object.freeze({ name: "chromium", version: output.browser.version }), scriptExecution: Object.freeze(structuredClone(output.scriptExecution!)), network: Object.freeze(structuredClone(output.network)), inputHashes: Object.freeze({ ...captured.result.receipt.inputHashes }), typography: "not-applicable-isolated-webgl"
        });
        if (binding && JSON.stringify(binding) !== JSON.stringify(next)) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_failed", "GPU restricted-shader hybrid provenance changed within one retained render session.");
        binding = next;
        const pngSha256 = createHash("sha256").update(captured.png).digest("hex");
        return { atMs, pngSha256, binding, texture: { id: `restricted-shader-${createHash("sha256").update(layer.id).digest("hex").slice(0, 24)}`, width: decoded.width, height: decoded.height, rgba: decoded.rgba, sha256: pngSha256, decodedSha256: createHash("sha256").update(decoded.rgba).digest("hex") } };
      } catch (error) {
        if (error instanceof GpuRestrictedShaderHybridError) throw error;
        throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_failed", error instanceof Error ? error.message : "GPU restricted-shader hybrid capture failed.");
      } finally { active = false; }
    };
    return { sourceSnapshot: Object.freeze({ sourceSnapshotSha256: stable.sha256, sourceByteLength: stable.byteLength }), get binding() { if (!binding) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_failed", "GPU restricted-shader hybrid has no exact frame evidence yet."); return binding; }, capture, async close() { if (closed) return; closed = true; const results = await Promise.allSettled([session?.close(), reservation ? releasePrivateCaptureDirectory(reservation) : undefined]); const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason); if (errors.length === 1) throw errors[0]; if (errors.length > 1) throw new AggregateError(errors, "GPU restricted-shader hybrid cleanup failed."); } };
  } catch (error) {
    const cleanup = await Promise.allSettled([session?.close(), reservation ? releasePrivateCaptureDirectory(reservation) : undefined]);
    const failures = cleanup.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "GPU restricted-shader hybrid setup and cleanup both failed.");
    throw error;
  }
}

/**
 * The captured screenshot remains in memory. This can only remove the exact
 * empty reservation leaf after revalidating the retained route; it never
 * traverses or removes the caller-owned scratch root.
 */
export async function releasePrivateCaptureDirectory(reservation: RetainedDirectoryAuthority): Promise<void> {
  await reservation.assertCurrent();
  await rmdir(reservation.path);
}

/** Exported narrow seam: source mutation or receipt substitution must never produce a usable texture. */
export function assertRestrictedShaderCaptureEvidence(input: {
  readonly output: Pick<BrowserFrameResult["output"], "network" | "scriptExecution" | "shaders">;
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly layer: MotionLayer;
  readonly assetRef: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
}): void {
  const rendered = input.output.shaders?.layers.length === 1 ? input.output.shaders.layers[0] : undefined;
  if (!input.output.network || !input.output.scriptExecution || input.output.scriptExecution.activeMode !== "data-only" || input.output.scriptExecution.sources.length !== 0 || input.output.network.approvedOrigins.length !== 0 || input.inputHashes[input.assetRef] !== input.sourceSha256 || !rendered || rendered.layerId !== input.layer.id || rendered.assetRef !== input.assetRef || rendered.sha256 !== input.sourceSha256 || rendered.bytes !== input.sourceBytes) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_failed", "GPU restricted-shader hybrid receipt did not retain exact data-only, no-network, stable-source WebGL evidence.");
}

function selectLayer(pkg: MotionPackage, layerId?: string): MotionLayer {
  if (layerId) {
    const selected = pkg.motion.layers.find((layer) => layer.id === layerId);
    if (!selected || !isGpuRestrictedShaderHybridLayer(selected)) {
      throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid Core selection did not identify a restricted GLSL layer.");
    }
    return selected;
  }
  const layers = pkg.motion.layers.filter((layer) => layer.visible !== false && isGpuRestrictedShaderHybridLayer(layer));
  if (layers.length !== 1) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid accepts exactly one visible non-gpuMaterial shader layer.");
  return layers[0];
}

function isolatedShaderPackage(pkg: MotionPackage, layer: MotionLayer, assetRef: string, dimensions: { width: number; height: number }): MotionPackage {
  const asset = pkg.motion.assets.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === layer.shader!.fragmentAssetId);
  if (!asset) throw new GpuRestrictedShaderHybridError("gpu_restricted_shader_hybrid_refused", "GPU restricted-shader hybrid source asset disappeared before isolated capture.");
  const keyframes = Object.fromEntries(Object.entries(layer.keyframes ?? {}).filter(([key]) => key.startsWith("shader.uniforms.")));
  const isolatedLayer: MotionLayer = { ...structuredClone(layer), transform: { width: dimensions.width, height: dimensions.height }, width: dimensions.width, height: dimensions.height, opacity: 1, blendMode: "normal", ...(Object.keys(keyframes).length ? { keyframes } : { keyframes: undefined }), style: undefined, effects: undefined, mask: undefined, matte: undefined, keying: undefined, crop: undefined, transitions: undefined, depth: undefined };
  return { root: pkg.root, manifest: { ...pkg.manifest, id: `${pkg.manifest.id}-gpu-restricted-shader`, assets: [assetRef] }, motion: { ...pkg.motion, id: `${pkg.motion.id}-gpu-restricted-shader`, width: dimensions.width, height: dimensions.height, background: "transparent", assets: [structuredClone(asset)], layers: [isolatedLayer] } };
}
