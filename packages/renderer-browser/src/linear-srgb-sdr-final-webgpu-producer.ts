import { createHash } from "node:crypto";
import { canonicalJsonSha256, motionDocumentBudgetError } from "@shellx-motion/core";
import {
  composeLinearSrgbSourceOver,
  sampleLinearSrgbGradient,
  type LinearSrgbSdrFinalRoute,
  type LinearSrgbSdrStraightRgba,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { GPU_ADAPTER_REQUEST_OPTIONS, openGpuRuntime, type GpuRuntimeOpenResult } from "./gpu-browser-runtime";
import { isGpuBrowserProcess, isGpuFinalLaunchContext, isPrecontainedGpuBrowser, type GpuStreamingJobContext } from "./gpu-process-containment";
import {
  LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE_SCHEMA,
} from "./linear-srgb-sdr-final-webgpu-contract";
import {
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE,
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE_SCHEMA,
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
} from "./linear-srgb-sdr-final-f2a-gradient-webgpu-contract";
import {
  closeLinearSrgbSdrFinalWebGpuPage,
  openLinearSrgbSdrFinalWebGpuPage,
  prepareLinearSrgbSdrFinalWebGpuPage,
  readLinearSrgbSdrFinalWebGpuPage,
  releaseLinearSrgbSdrFinalWebGpuPage,
  renderLinearSrgbSdrFinalWebGpuPage,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_INPUT_SCHEMA,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_READBACK_SCHEMA,
  type LinearSrgbSdrFinalWebGpuPageInput,
} from "./linear-srgb-sdr-final-webgpu-page";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PRODUCER_SCHEMA = "shellx-motion/linear-srgb-sdr-final-webgpu-producer@1" as const;
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_FRAME_SCHEMA = "shellx-motion/linear-srgb-sdr-final-webgpu-frame@1" as const;

export interface LinearSrgbSdrFinalWebGpuFrame {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_WEBGPU_FRAME_SCHEMA;
  readonly routeFingerprint: string;
  readonly documentFingerprint: string;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly rgba8SrgbSha256: string;
  /** One retained tight, straight-sRGB RGBA8 frame for the route-specific delivery adapter. */
  readonly rgba8Srgb: Buffer;
}

export interface LinearSrgbSdrFinalWebGpuProducerEvidence {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_WEBGPU_PRODUCER_SCHEMA;
  readonly routeFingerprint: string;
  readonly documentFingerprint: string;
  readonly pipeline: {
    /** Always used for the canvas background, flat rectangles, and frame encoding. */
    readonly schema: typeof LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE_SCHEMA;
    readonly implementationSha256: string;
    readonly workingTarget: "rgba16float";
    readonly publicationTarget: "rgba8unorm";
    readonly publicationUsage: "COPY_SRC";
    readonly composition: "premultiplied-linear-srgb-normal-source-over";
    readonly frameBoundary: "straight-srgb-rgba8";
  };
  /** Present only when a F2a draw binds the separately hash-bound gradient shader. */
  readonly gradientPipeline?: {
    readonly schema: typeof LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE_SCHEMA;
    readonly implementationSha256: string;
    readonly workingTarget: "rgba16float";
    readonly publicationTarget: "rgba8unorm";
    readonly publicationUsage: "COPY_SRC";
    readonly composition: "premultiplied-linear-srgb-normal-source-over";
    readonly frameBoundary: "straight-srgb-rgba8";
  };
  readonly runtime: GpuRuntimeEvidence | null;
  readonly readback: {
    readonly bytesPerRow: number | null;
    readonly paddedByteLength: number | null;
    readonly tightByteLength: number | null;
    readonly mapOperations: number;
    readonly mappedBufferUnmapped: boolean;
    readonly mappedBufferDestroyed: boolean;
  };
  readonly retainedFrame: { readonly bytes: number; readonly sha256: string | null };
  readonly cleanup: { readonly state: "pending" | "complete" | "failed"; readonly resourcesReleased: boolean; readonly pageClosed: boolean; readonly runtimeClosed: boolean };
  readonly fingerprint: string | null;
}

export interface LinearSrgbSdrFinalWebGpuProducer {
  readonly evidence: LinearSrgbSdrFinalWebGpuProducerEvidence;
  produce(job: GpuStreamingJobContext): Promise<LinearSrgbSdrFinalWebGpuFrame>;
}

export type LinearSrgbSdrFinalWebGpuProducerResolution =
  | Readonly<{ readonly ok: true; readonly producer: LinearSrgbSdrFinalWebGpuProducer }>
  | Readonly<{ readonly ok: false; readonly refusal: { readonly code: "linear_srgb_sdr_final_producer_refused"; readonly message: string } }>;

interface ProducerOptions {
  /** Test seam; ordinary calls always open the pre-contained final Browser runtime. */
  readonly openRuntime?: (job: GpuStreamingJobContext) => Promise<GpuRuntimeOpenResult>;
}

/**
 * Accepts only one fully frozen Core route snapshot. It does not resolve package
 * data, create output files, write receipts, or enter a generic GPU pathway.
 */
export function createLinearSrgbSdrFinalWebGpuProducer(value: unknown, options: ProducerOptions = {}): LinearSrgbSdrFinalWebGpuProducerResolution {
  const route = validateRoute(value);
  if (!route) return refuse("The strict linear-sRGB SDR producer requires one deep-frozen, admitted Core route plan before Browser or GPU allocation.");
  const input = pageInput(route);
  let active = false;
  let evidence = initialEvidence(route);
  const openRuntime = options.openRuntime ?? ((job: GpuStreamingJobContext) => openGpuRuntime({ finalBrowser: { scratchRoot: job.scratchRoot, maxProcessTreeRssBytes: job.maxProcessTreeRssBytes, signal: job.signal } }));
  return Object.freeze({ ok: true, producer: Object.freeze({ get evidence() { return evidence; }, async produce(job: GpuStreamingJobContext) {
    if (active || !validJob(job)) throw new Error("The strict linear-sRGB SDR producer requires one pre-acquired contained final job.");
    active = true; evidence = initialEvidence(route);
    let runtime: Extract<GpuRuntimeOpenResult, { ok: true }>["session"] | undefined;
    let pageOpenAttempted = false, pageOpened = false, prepared = false, resourcesReleased = false, pageClosed = false, runtimeClosed = false, cleanupFailed = false;
    try {
      throwIfAborted(job.signal);
      const opened = await openRuntime(job);
      if (!opened.ok) throw new Error(opened.failure.message);
      runtime = opened.session;
      const browser = runtime.browserProcess;
      if (!isGpuBrowserProcess(browser) || !isPrecontainedGpuBrowser(browser.containment, browser.pid, job.maxProcessTreeRssBytes)) throw new Error("The strict linear-sRGB SDR producer refused an uncontained Browser runtime.");
      job.watchProcess(browser.pid);
      pageOpenAttempted = true;
      const initialized = await runtime.page.evaluate(openLinearSrgbSdrFinalWebGpuPage, GPU_ADAPTER_REQUEST_OPTIONS);
      if (!initialized.ok) throw new Error(initialized.failure.message);
      pageOpened = true;
      const assessment = await runtime.assessRender(initialized.runtime);
      if (!assessment.ok) throw new Error(assessment.failure.message);
      evidence = Object.freeze({ ...evidence, runtime: assessment.evidence });
      const preparedResult = await runtime.page.evaluate(prepareLinearSrgbSdrFinalWebGpuPage, input);
      if (!preparedResult.ok) throw new Error(preparedResult.failure.message);
      prepared = true;
      throwIfAborted(job.signal);
      const rendered = await runtime.page.evaluate(renderLinearSrgbSdrFinalWebGpuPage, readbackInput(route));
      if (!rendered.ok) throw new Error(rendered.failure.message);
      const readback = await runtime.page.evaluate(readLinearSrgbSdrFinalWebGpuPage, readbackInput(route));
      if (!readback.ok) throw new Error(readback.failure.message);
      const rgba8Srgb = unpackPaddedRgba8(readback.paddedBase64, route.canvas.width, route.canvas.height, readback.evidence.bytesPerRow, readback.evidence.paddedByteLength, readback.evidence.tightByteLength);
      const rgba8SrgbSha256 = sha256(rgba8Srgb);
      evidence = Object.freeze({ ...evidence, readback: { bytesPerRow: readback.evidence.bytesPerRow, paddedByteLength: readback.evidence.paddedByteLength, tightByteLength: readback.evidence.tightByteLength, mapOperations: 1, mappedBufferUnmapped: readback.evidence.mappedBufferUnmapped, mappedBufferDestroyed: readback.evidence.mappedBufferDestroyed }, retainedFrame: { bytes: rgba8Srgb.byteLength, sha256: rgba8SrgbSha256 } });
      return Object.freeze({ schema: LINEAR_SRGB_SDR_FINAL_WEBGPU_FRAME_SCHEMA, routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, width: route.canvas.width, height: route.canvas.height, bytesPerRow: route.canvas.width * 4, rgba8SrgbSha256, rgba8Srgb });
    } finally {
      if (runtime && prepared) {
        const release = await runtime.page.evaluate(releaseLinearSrgbSdrFinalWebGpuPage).catch(() => null);
        if (!release?.hadResources || release.releaseFailed || release.remainingGpuBytes !== 0 || release.releasedGpuBytes <= 0) cleanupFailed = true;
        else resourcesReleased = true;
      }
      if (runtime && pageOpenAttempted) {
        try {
          const close = await runtime.page.evaluate(closeLinearSrgbSdrFinalWebGpuPage);
          if (pageOpened && (!close.deviceDestroyed || close.forcedResourceRelease || close.releaseFailed)) cleanupFailed = true;
          else pageClosed = true;
        } catch { cleanupFailed = true; }
      }
      if (runtime) try { await runtime.close(); runtimeClosed = true; } catch { cleanupFailed = true; }
      evidence = finishEvidence(evidence, resourcesReleased, pageClosed, runtimeClosed, cleanupFailed);
      active = false;
      if (cleanupFailed) throw new Error("The strict linear-sRGB SDR producer could not prove terminal Browser/GPU cleanup.");
    }
  } }) });
}

/** CPU-only expected pixels for conformance vectors; this does not replace the isolated WebGPU producer. */
export function linearSrgbSdrFinalReferenceFrame(route: LinearSrgbSdrFinalRoute): Buffer {
  if (!validateRoute(route)) throw new Error("The linear-sRGB SDR reference requires an admitted frozen route plan.");
  const bytes = Buffer.alloc(route.canvas.width * route.canvas.height * 4);
  for (let y = 0; y < route.canvas.height; y += 1) for (let x = 0; x < route.canvas.width; x += 1) {
    const layers: LinearSrgbSdrStraightRgba[] = [{ ...route.canvas.background, a: 1 }];
    for (const rect of route.rects) if (x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height) {
      if ("fill" in rect) layers.push({ ...rect.fill, a: rect.opacity });
      else layers.push({ ...sampleLinearSrgbGradient(rect.gradient, (x - rect.x + 0.5) / rect.width, (y - rect.y + 0.5) / rect.height), a: rect.opacity });
    }
    const pixel = composeLinearSrgbSourceOver(layers), offset = (y * route.canvas.width + x) * 4;
    bytes[offset] = quantize(pixel.r); bytes[offset + 1] = quantize(pixel.g); bytes[offset + 2] = quantize(pixel.b); bytes[offset + 3] = quantize(pixel.a);
  }
  return bytes;
}

function pageInput(route: LinearSrgbSdrFinalRoute): LinearSrgbSdrFinalWebGpuPageInput {
  const base = { schema: LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_INPUT_SCHEMA, routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, pipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256, shaderSourceSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256, compositeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL, encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL, canvas: { width: route.canvas.width, height: route.canvas.height, background: { ...route.canvas.background } }, rects: route.rects.map((rect) => "fill" in rect ? { ...rect, fill: { ...rect.fill } } : { ...rect, gradient: { ...rect.gradient, stops: rect.gradient.stops.map((stop) => ({ offset: stop.offset, color: { ...stop.color } })) } }) };
  return Object.freeze(route.rects.some((rect) => "gradient" in rect)
    ? { ...base, gradientPipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256, gradientShaderSourceSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.shaderSourceSha256, gradientWgsl: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL }
    : base);
}

function readbackInput(route: LinearSrgbSdrFinalRoute) {
  return Object.freeze({ schema: LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_READBACK_SCHEMA, routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint });
}

function initialEvidence(route: LinearSrgbSdrFinalRoute): LinearSrgbSdrFinalWebGpuProducerEvidence {
  const gradients = route.rects.some((rect) => "gradient" in rect);
  const basePipeline = {
    schema: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE_SCHEMA,
    implementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256,
    workingTarget: "rgba16float" as const,
    publicationTarget: "rgba8unorm" as const,
    publicationUsage: "COPY_SRC" as const,
    composition: "premultiplied-linear-srgb-normal-source-over" as const,
    frameBoundary: "straight-srgb-rgba8" as const,
  };
  const gradientPipeline = gradients ? {
    schema: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE_SCHEMA,
    implementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256,
    workingTarget: "rgba16float" as const,
    publicationTarget: "rgba8unorm" as const,
    publicationUsage: "COPY_SRC" as const,
    composition: "premultiplied-linear-srgb-normal-source-over" as const,
    frameBoundary: "straight-srgb-rgba8" as const,
  } : undefined;
  return Object.freeze({ schema: LINEAR_SRGB_SDR_FINAL_WEBGPU_PRODUCER_SCHEMA, routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, pipeline: basePipeline, ...(gradientPipeline ? { gradientPipeline } : {}), runtime: null, readback: { bytesPerRow: null, paddedByteLength: null, tightByteLength: null, mapOperations: 0, mappedBufferUnmapped: false, mappedBufferDestroyed: false }, retainedFrame: { bytes: 0, sha256: null }, cleanup: { state: "pending" as const, resourcesReleased: false, pageClosed: false, runtimeClosed: false }, fingerprint: null });
}

function finishEvidence(evidence: LinearSrgbSdrFinalWebGpuProducerEvidence, resourcesReleased: boolean, pageClosed: boolean, runtimeClosed: boolean, failed: boolean): LinearSrgbSdrFinalWebGpuProducerEvidence {
  const cleanup = Object.freeze({ state: failed ? "failed" as const : "complete" as const, resourcesReleased, pageClosed, runtimeClosed });
  const base = { ...evidence, cleanup, fingerprint: undefined };
  return Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
}

function validJob(value: GpuStreamingJobContext): boolean {
  return value?.admission === "pre-acquired" && typeof value.watchProcess === "function" && !!value.signal && typeof value.signal.aborted === "boolean" && isGpuFinalLaunchContext(value);
}

function validateRoute(value: unknown): LinearSrgbSdrFinalRoute | null {
  if (!deepFrozenData(value) || !record(value) || !sameKeys(value, ["schema", "admission", "contract", "canvas", "rects", "documentFingerprint", "fingerprint"])) return null;
  const route = value as unknown as LinearSrgbSdrFinalRoute;
  if (route.schema !== "shellx-motion/linear-srgb-sdr-final-route@1" || !hash(route.documentFingerprint) || !hash(route.fingerprint) || !admission(route.admission) || !contract(route.contract) || !canvas(route.canvas) || !Array.isArray(route.rects) || route.rects.length > 64 || motionDocumentBudgetError(route.canvas)) return null;
  const ids = new Set<string>();
  if (!route.rects.every((rect) => rectangle(rect, route.canvas, ids) && !ids.has(rect.id) && (ids.add(rect.id), true))) return null;
  const base = { schema: route.schema, admission: route.admission, contract: route.contract, canvas: route.canvas, rects: route.rects, documentFingerprint: route.documentFingerprint };
  return route.fingerprint === canonicalJsonSha256(base) ? route : null;
}

function deepFrozenData(value: unknown, seen = new WeakSet<object>()): boolean {
  try {
    if (!value || typeof value !== "object") return true;
    if (seen.has(value)) return false;
    seen.add(value);
    if (!Object.isFrozen(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) { if (prototype !== Array.prototype) return false; }
    else if (prototype !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.configurable || (key !== "length" && (!descriptor.enumerable || descriptor.writable))) return false;
      if (!deepFrozenData(descriptor.value, seen)) return false;
    }
    return true;
  } catch { return false; }
}

function admission(value: unknown): boolean { return record(value) && sameKeys(value, ["schema", "target", "frameLane", "delivery", "finalLane", "preset", "composition", "working", "frameBoundary"]) && value.schema === "shellx-motion/linear-srgb-sdr-final-admission@1" && value.target === "final" && value.frameLane === "gpu" && value.delivery === "streamed" && value.finalLane === "ffmpeg" && value.preset === "mp4-h264" && value.composition === "normal-source-over-document-order" && value.working === "premultiplied-linear-srgb-rgba16float" && value.frameBoundary === "straight-srgb-rgba8"; }

function contract(value: unknown): boolean { return record(value) && sameKeys(value, ["schema", "intent", "package", "render"]) && value.schema === "shellx-motion/color-pipeline@1" && value.intent === "linear-srgb-sdr@1" && record(value.package) && sameKeys(value.package, ["input", "profileBearingImageVideo", "working"]) && value.package.input === "unprofiled-srgb-assumed" && value.package.profileBearingImageVideo === "refused" && value.package.working === "premultiplied-linear-srgb" && record(value.render) && sameKeys(value.render, ["delivery", "frameAlphaBoundary", "outputAlpha", "laneRequirement", "outputRequirement", "fallbackPolicy"]) && value.render.delivery === "sdr-bt709-limited" && value.render.frameAlphaBoundary === "straight-srgb-rgba" && value.render.outputAlpha === "not-applicable" && value.render.laneRequirement === "gpu-to-ffmpeg" && value.render.outputRequirement === "mp4-h264" && value.render.fallbackPolicy === "refuse"; }

function canvas(value: unknown): value is LinearSrgbSdrFinalRoute["canvas"] { return record(value) && sameKeys(value, ["width", "height", "durationMs", "fps", "background"]) && integer(value.width, 1, 1920) && integer(value.height, 1, 1080) && integer(value.durationMs, 1, Number.MAX_SAFE_INTEGER) && positiveFinite(value.fps) && color(value.background); }

function rectangle(value: unknown, current: LinearSrgbSdrFinalRoute["canvas"], ids: ReadonlySet<string>): value is LinearSrgbSdrFinalRoute["rects"][number] {
  if (!record(value) || typeof value.id !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/u.test(value.id) || ids.has(value.id) || !integer(value.x, 0, current.width - 1) || !integer(value.y, 0, current.height - 1) || !integer(value.width, 1, current.width) || !integer(value.height, 1, current.height) || value.x + value.width > current.width || value.y + value.height > current.height || !finite(value.opacity, 0, 1)) return false;
  return (sameKeys(value, ["id", "x", "y", "width", "height", "fill", "opacity"]) && color(value.fill))
    || (sameKeys(value, ["id", "x", "y", "width", "height", "gradient", "opacity"]) && gradient(value.gradient));
}

function gradient(value: unknown): boolean {
  if (!record(value) || !Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 16) return false;
  const linear = value.type === "linear" && sameKeys(value, ["type", "angleDeg", "stops"]) && finite(value.angleDeg, 0, 360);
  const radial = value.type === "radial" && sameKeys(value, ["type", "centerX", "centerY", "stops"]) && finite(value.centerX, 0, 1) && finite(value.centerY, 0, 1);
  if (!linear && !radial) return false;
  let prior = -1;
  for (const stop of value.stops) {
    if (!record(stop) || !sameKeys(stop, ["offset", "color"]) || !finite(stop.offset, 0, 1) || stop.offset <= prior || !color(stop.color)) return false;
    prior = stop.offset;
  }
  return value.stops[0]?.offset === 0 && value.stops.at(-1)?.offset === 1;
}

function color(value: unknown): value is { readonly hex: string; readonly r: number; readonly g: number; readonly b: number } { if (!record(value) || !sameKeys(value, ["hex", "r", "g", "b"]) || typeof value.hex !== "string" || !/^#[0-9a-f]{6}$/u.test(value.hex) || !finite(value.r, 0, 1) || !finite(value.g, 0, 1) || !finite(value.b, 0, 1)) return false; return value.r === Number.parseInt(value.hex.slice(1, 3), 16) / 255 && value.g === Number.parseInt(value.hex.slice(3, 5), 16) / 255 && value.b === Number.parseInt(value.hex.slice(5, 7), 16) / 255; }

function unpackPaddedRgba8(value: unknown, width: number, height: number, bytesPerRow: number, paddedByteLength: number, tightByteLength: number): Buffer {
  const rowBytes = width * 4, expectedPadded = Math.ceil(rowBytes / 256) * 256, expectedTight = rowBytes * height, expectedLength = Math.ceil(expectedPadded * height / 3) * 4;
  if (!hashes(value) || bytesPerRow !== expectedPadded || paddedByteLength !== expectedPadded * height || tightByteLength !== expectedTight || value.length !== expectedLength) throw new Error("The isolated linear-sRGB SDR producer returned malformed padded readback evidence.");
  const padded = Buffer.from(value, "base64");
  if (padded.byteLength !== paddedByteLength || padded.toString("base64") !== value) throw new Error("The isolated linear-sRGB SDR producer returned non-canonical padded readback bytes.");
  const tight = Buffer.alloc(tightByteLength);
  for (let row = 0; row < height; row += 1) padded.copy(tight, row * rowBytes, row * bytesPerRow, row * bytesPerRow + rowBytes);
  return tight;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function hashes(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/u.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function finite(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
function positiveFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function quantize(value: number): number { return Math.round(Math.min(1, Math.max(0, value)) * 255); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The strict linear-sRGB SDR producer was cancelled."); }
function refuse(message: string): LinearSrgbSdrFinalWebGpuProducerResolution { return Object.freeze({ ok: false, refusal: Object.freeze({ code: "linear_srgb_sdr_final_producer_refused", message }) }); }
