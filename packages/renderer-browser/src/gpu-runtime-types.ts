export type GpuRuntimeFailureCode =
  | "gpu_browser_unavailable"
  | "gpu_browser_launch_failed"
  | "gpu_browser_pid_unavailable"
  | "gpu_secure_context_unavailable"
  | "gpu_api_unavailable"
  | "gpu_hardware_unavailable"
  | "gpu_adapter_unavailable"
  | "gpu_adapter_identity_unavailable"
  | "gpu_device_unavailable"
  | "gpu_resource_refused"
  | "gpu_limits_exceeded"
  | "gpu_device_lost"
  | "gpu_cancelled"
  | "gpu_render_timeout"
  | "gpu_render_failed";

export interface GpuRuntimeFailure {
  code: GpuRuntimeFailureCode;
  message: string;
}

export function gpuDeviceLostFailure(): GpuRuntimeFailure {
  return { code: "gpu_device_lost", message: "WebGPU device was lost during frame rendering." };
}

export function gpuCancellationFailure(message: string = "GPU frame rendering was cancelled."): GpuRuntimeFailure {
  return { code: "gpu_cancelled", message };
}

export interface GpuRuntimeEvidence {
  schema: "shellx-motion/gpu-runtime-evidence@1";
  backend: "webgpu-browser";
  browserSource: string;
  webgpuFeatureStatus: string | null;
  adapterFingerprint: string;
  adapter: {
    cdpVendorId: number;
    cdpDeviceId: number;
    cdpVendor: string;
    cdpDevice: string;
    vendor: string;
    device: string;
    architecture: string | null;
    description: string | null;
  };
  limits: {
    maxTextureDimension2D: number;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  };
}

/**
 * Browser-side view of Core's bounded GPU frame-plan authority. This stays a
 * structural type so the renderer independently admits untrusted boundaries.
 * The browser rechecks its execution boundary before allocating resources.
 */
export interface InternalGpuRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type InternalGpuBlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity" | "plus-lighter";
export interface InternalGpuGlowEffect { radius: number; color: InternalGpuRgba }
export interface InternalGpuLayerEffects { blur: number; brightness: number; contrast: number; saturate: number; grayscale: number; glow: InternalGpuGlowEffect | null }
export interface InternalGpuLayerMask { shape: "rect" | "ellipse" | "triangle"; x: number; y: number; width: number; height: number; radius: number; rotationDeg: number; pivotX: number; pivotY: number; inverted: boolean; opacity: number; featherPx: number }
export interface InternalGpuChromaMatteCleanup { denoiseRadiusPx: number; growShrinkPx: number; chokePx: number; featherPx: number; blackClip: number; whiteClip: number }
export interface InternalGpuChromaKey { keyColor: InternalGpuRgba; similarity: number; smoothness: number; shadow: number; spillSuppression: number; spillBalance: number; edgeColorCorrection: number; matte: InternalGpuChromaMatteCleanup }

interface InternalGpuComposite { blendMode: InternalGpuBlendMode; effects: InternalGpuLayerEffects | null; mask?: InternalGpuLayerMask }

export interface InternalGpuEffectModuleBinding {
  layerId: string;
  drawId: string;
  scopeGroupId: string;
  scopeGroupDrawId: string;
  moduleId: string;
  version: string;
  manifestSha256: string;
  manifestByteLength: number;
  registryEntrySha256: string;
  installationProvenanceSha256: string;
  pipelineImplementationSha256: string;
  resourceCeilingSha256: string;
  intrinsic: "motion.afterimage-stack.v1";
  rendererAbi: "shellx-motion/gpu-effect-module@1";
  parameterSchema: "motion.afterimage-stack.parameters@1";
  referenceFingerprint: string;
  echoes: Array<{ dxPx: number; dyPx: number; rgba8: [number, number, number, number]; opacityQ16: number }>;
  amountQ16: number;
  uniformBytes: 160;
  textureLoadCount: number;
  passCount: 1;
  retainedTextureCount: 0;
  descriptorFingerprint: string;
  bindingFingerprint: string;
}

export type InternalGpuFrameDraw =
  | ({ kind: "rect"; id: string; x: number; y: number; width: number; height: number; rotationDeg: number; pivotX: number; pivotY: number; color: InternalGpuRgba } & InternalGpuComposite)
  | ({ kind: "ellipse"; id: string; x: number; y: number; width: number; height: number; rotationDeg: number; pivotX: number; pivotY: number; color: InternalGpuRgba; strokeWidth: number; stroke: InternalGpuRgba } & InternalGpuComposite)
  | ({ kind: "triangles"; id: string; vertices: Array<{ x: number; y: number }>; rotationDeg: number; pivotX: number; pivotY: number; color: InternalGpuRgba } & InternalGpuComposite)
  | ({ kind: "coloredTriangles"; id: string; vertices: Array<{ x: number; y: number; color: InternalGpuRgba }>; rotationDeg: number; pivotX: number; pivotY: number } & InternalGpuComposite)
  | ({ kind: "image"; id: string; resourceId: string; x: number; y: number; width: number; height: number; rotationDeg: number; pivotX: number; pivotY: number; u0: number; v0: number; u1: number; v1: number; opacity: number; chromaKey?: InternalGpuChromaKey } & InternalGpuComposite)
  | ({ kind: "text"; id: string; surfaceId: string; fontResourceIds: string[]; fontFamily: string; text: string; x: number; y: number; width: number; height: number; rotationDeg: number; pivotX: number; pivotY: number; opacity: number; color: InternalGpuRgba; fontSize: number; fontWeight: number; fontStyle: "normal" | "italic" | "oblique"; letterSpacing: number; lineHeight: number; textAlign: "left" | "center" | "right"; verticalAlign: "top" | "middle" | "bottom"; direction: "ltr" | "rtl"; textShadow: { offsetX: number; offsetY: number; blur: number; color: InternalGpuRgba } | null; textFit: { policy: "safe" | "allow-crop" | "auto-fit"; safeArea: { top: number; right: number; bottom: number; left: number } | null; minFontSize: number | null } | null } & InternalGpuComposite)
  | ({ kind: "gradientRect"; id: string; x: number; y: number; width: number; height: number; rotationDeg: number; pivotX: number; pivotY: number; gradientType: "linear" | "radial"; angleDeg: number; centerX: number; centerY: number; stops: Array<{ offset: number; color: InternalGpuRgba }> } & InternalGpuComposite)
  | ({ kind: "styledRect"; id: string; x: number; y: number; width: number; height: number; rotationDeg: number; pivotX: number; pivotY: number; radius: number; fill: InternalGpuRgba; strokeWidth: number; stroke: InternalGpuRgba; shadow: { offsetX: number; offsetY: number; blur: number; spread: number; color: InternalGpuRgba } | null } & InternalGpuComposite)
  | ({ kind: "scene3d"; id: string; background: InternalGpuRgba; opacity: number; viewProjection: number[]; lightDirection: [number,number,number]; lightColor: InternalGpuRgba; ambient: number; intensity: number; objects: Array<{ id:string; vertices:number[]; indices:number[]; model:number[]; color:InternalGpuRgba; emissive:number }> } & InternalGpuComposite)
  | ({ kind: "environment"; id:string; environmentKind:"rain"|"water"|"snow"|"fog"; mode:"scene"|"overlay"; seed:number; timeSeconds:number; x:number;y:number;width:number;height:number;rotationDeg:number;pivotX:number;pivotY:number;opacity:number;sceneResourceId?:string;effectMaskResourceId?:string;colors:[InternalGpuRgba,InternalGpuRgba,InternalGpuRgba,InternalGpuRgba,InternalGpuRgba];parameters:[number,number,number,number,number,number,number,number,number,number,number,number,number,number,number,number] } & InternalGpuComposite)
  | ({ kind: "material"; id:string; preset:"plasma"|"hologram"|"energy"|"noise"; seed:number; timeSeconds:number; x:number;y:number;width:number;height:number;rotationDeg:number;pivotX:number;pivotY:number;opacity:number;colors:[InternalGpuRgba,InternalGpuRgba,InternalGpuRgba];parameters:[number,number,number,number,number,number,number,number] } & InternalGpuComposite)
  | ({ kind: "points"; id: string; seed: number; instanceBufferMode?: "static" | "dynamic"; points: Array<{ x: number; y: number; size: number; color: InternalGpuRgba }> } & InternalGpuComposite)
  | ({ kind: "particleCompute"; id: string; schema: "shellx-motion/gpu-compute-particle-field@1"; seed: number; count: number; atMs: number; startMs: number; lifetimeMs: number; width: number; height: number; x: number; y: number; scale: number; originX: number; originY: number; rotationDeg: number; opacity: number; color: InternalGpuRgba; secondaryColor: InternalGpuRgba; minSize: number; maxSize: number; minSpeed: number; maxSpeed: number; direction: number; spread: number; gravity: number; fadeOut: boolean; sources: Array<{kind:"radial"|"vortex";centerX:number;centerY:number;strength:number;softening:number}> } & InternalGpuComposite)
  | ({ kind: "particleCompute"; id: string; schema: "shellx-motion/gpu-compute-particle-field@2"; seed: number; count: number; atMs: number; startMs: number; lifetimeMs: number; width: number; height: number; x: number; y: number; scale: number; originX: number; originY: number; rotationDeg: number; opacity: number; color: InternalGpuRgba; secondaryColor: InternalGpuRgba; minSize: number; maxSize: number; minSpeed: number; maxSpeed: number; direction: number; spread: number; gravity: number; fadeOut: boolean; sources: ReadonlyArray<{kind:"radial"|"vortex";centerX:number;centerY:number;strength:number;softening:number}|{kind:"flow";angleDeg:number;strength:number}|{kind:"turbulence";scale:number;strength:number}|{kind:"impact";centerX:number;centerY:number;radius:number;strength:number;startProgress:number;durationProgress:number}|{kind:"collision";axis:"x"|"y";position:number;restitution:number}>; origins: ReadonlyArray<{x:number;y:number;weight:number;directionOffsetDeg:number;speedScale:number}>; trail: {durationMs:number;samples:number;opacity:number}|null; shading: {mode:"flat"|"soft"|"glow";sizeJitter:number;opacityJitter:number;glow:number}; computeDispatchCount: 1; rasterPassCount: 1|2; instanceBytes: 64; retainedBufferCount: 2; retainedInstanceBytes: number } & InternalGpuComposite)
  | ({ kind: "effectModule"; id: string; blendMode: "normal"; effects: null; mask?: never } & InternalGpuEffectModuleBinding)
  | ({ kind: "motionBlurStart"; id: string; sampleCount: number; drawCount: number; shutterAngle: number; shutterDurationMs: number } & InternalGpuComposite)
  | { kind: "motionBlurEnd"; id: string; groupId: string }
  | ({ kind: "groupStart"; id: string; drawCount: number; x: number; y: number; scale: number; rotationDeg: number; pivotX: number; pivotY: number; opacity: number } & InternalGpuComposite)
  | { kind: "groupEnd"; id: string; groupId: string }
  | { kind: "adjustment"; id: string; vignette: { amount: number; softness: number; color: InternalGpuRgba } | null; filmGrain: { amount: number; size: number; frameSeed: number } | null };

export interface InternalGpuFramePlan {
  schema: "shellx-motion/gpu-frame-intent@1";
  width: number;
  height: number;
  clear: InternalGpuRgba;
  draws: InternalGpuFrameDraw[];
  fingerprint: string;
  budget: {
    rectangleCount: number;
    pointCount: number;
    computeParticleFieldCount: number;
    computeParticleCount: number;
    triangleVertexCount: number;
    imageCount: number;
    chromaKeyCount: number;
    chromaMatteCleanupCount: number;
    chromaMatteCleanupPassCount: number;
    textCount: number;
    textUtf8Bytes: number;
    textSurfacePixels: number;
    scene3dCount: number;
    scene3dObjectCount: number;
    scene3dVertexCount: number;
    scene3dIndexCount: number;
    environmentCount: number;
    materialCount: number;
    gradientStopCount: number;
    pointBufferBytes: number;
    computeParticleBufferBytes: number;
    computeParticleComputeDispatchCount?: number;
    computeParticleRasterPassCount?: number;
    triangleBufferBytes: number;
    imageVertexBufferBytes: number;
    chromaKeyUniformBytes: number;
    chromaMatteCleanupUniformBytes: number;
    textVertexBufferBytes: number;
    scene3dVertexBufferBytes: number;
    scene3dIndexBufferBytes: number;
    scene3dUniformBytes: number;
    environmentUniformBytes: number;
    materialUniformBytes: number;
    gradientUniformBytes: number;
    styledRectangleUniformBytes: number;
    blendModeCount: number;
    colorEffectCount: number;
    blurEffectCount: number;
    glowEffectCount: number;
    maskCount: number;
    blurPassCount: number;
    adjustmentCount: number;
    /** Omitted for legacy/no-module plans so their serialized budget remains byte-identical. */
    effectModuleCount?: number;
    effectModuleUniformBytes?: number;
    effectModuleTextureLoadCount?: number;
    effectModulePassCount?: number;
    motionBlurGroupCount: number;
    motionBlurSampleCount: number;
    groupCount: number;
    groupMaxDepth: number;
    compositeCount: number;
    compositeUniformBytes: number;
    blurUniformBytes: number;
    glowUniformBytes: number;
    maskUniformBytes: number;
    adjustmentUniformBytes: number;
    chromaMatteCleanupIntermediateTextureBytes: number;
    compositeIntermediateTextureBytes: number;
    estimatedPlanBytes: number;
  };
}

interface GpuSessionImageResourceBase {
  id: string;
  width: number;
  height: number;
  sha256: string;
}

/** Existing trusted parser or video-provider RGBA path. The raw pixel identity is mandatory. */
export interface GpuSessionRgbaImageResource extends GpuSessionImageResourceBase {
  rgba: Buffer;
  bytes?: never;
  mimeType?: never;
  staticSvg?: never;
  /** SHA-256 of the exact decoded RGBA bytes handed to the retained GPU page. */
  decodedSha256: string;
}

/** Exact JPEG/WebP/static-SVG snapshot; decoded only by the retained GPU page. */
export interface GpuSessionEncodedImageResource extends GpuSessionImageResourceBase {
  rgba?: never;
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/webp" | "image/svg+xml";
  /** Required for SVG encoded bytes after Core's static no-script/no-reference gate. */
  staticSvg?: true;
  decodedSha256?: never;
}

export type GpuSessionImageResource = GpuSessionRgbaImageResource | GpuSessionEncodedImageResource;

/**
 * A stable, page-owned texture slot for preview-only dynamic pixels.  This is
 * deliberately not a media decoder contract: the host must replace it with a
 * separately verified RGBA frame before Core can reference the slot.
 */
export interface GpuSessionDynamicImageReservation {
  id: string;
  width: number;
  height: number;
  /** Immutable source snapshot identity; replacements may not change it. */
  sourceSha256: string;
}

/** Exact page-raster identity retained as scalar evidence, never as a browser/GPU handle. */
export interface GpuSessionImageIdentity {
  id: string;
  sourceSha256: string;
  decodedSha256: string;
  width: number;
  height: number;
}

export interface GpuSessionFontResource {
  id: string;
  resourceId: string;
  assetRef: string;
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf";
  bytes: Buffer;
  sha256: string;
}

export class InternalGpuFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalGpuFrameError";
  }
}

/**
 * Exact per-frame host-side facts for the portable WebGPU readback transport.
 * These counters describe copies and allocations after the GPU readback buffer
 * is mapped; they are not a claim of GPU-resident encoding.
 */
export interface GpuReadbackFrameMetrics {
  readonly schema: "shellx-motion/gpu-readback-frame@1";
  readonly width: number;
  readonly height: number;
  /** Tight raw-RGBA stride handed to FFmpeg after normalization. */
  readonly tightBytesPerRow: number;
  /** WebGPU's 256-byte-aligned mapped readback stride. */
  readonly mappedBytesPerRow: number;
  /** Texture-to-MAP_READ buffer bytes, including any required row padding. */
  readonly gpuTextureToMappedReadbackBytes: number;
  /** ASCII base64 payload length returned by the browser/CDP page evaluation. */
  readonly cdpBase64PayloadBytes: number;
  /** Bytes allocated by Node's canonical Buffer.from(base64) decode. */
  readonly hostBase64DecodedBytes: number;
  readonly allocations: {
    readonly hostBase64Decode: 1;
    readonly rowCompaction: 0 | 1;
    readonly straightAlpha: 0;
  };
  readonly copiedBytes: {
    /** Zero for a tight WebGPU row; otherwise one compact RGBA-row copy. */
    readonly rowCompaction: number;
    /** Straight-alpha conversion mutates an owned buffer and performs no copy. */
    readonly straightAlpha: 0;
  };
  readonly rowCompaction: "bypassed-tight-stride" | "copied-padded-rows";
  readonly straightAlpha: "in-place-owned-buffer";
}

/** Observational timing is receipt evidence for host qualification, not transport identity. */
export interface GpuReadbackFrameObservation extends GpuReadbackFrameMetrics {
  readonly hostFrameElapsedNanoseconds: number;
  readonly hostClock: "node-process-hrtime";
  readonly hostTimingScope: "admitted-frame-render-and-readback";
}

/** Bounded browser glyph-layout result for one GPU text surface. */
export interface GpuTextFitEvidence {
  layerId: string;
  surfaceId: string;
  policy: "safe" | "allow-crop" | "auto-fit";
  status: "passed" | "allowed-crop" | "auto-fitted";
  requestedFontSize: number;
  appliedFontSize: number;
  minFontSize: number | null;
  internalOverflowPx: { horizontal: number; vertical: number };
  safeAreaOverflowPx: { top: number; right: number; bottom: number; left: number };
}

export interface GpuRenderedFrame {
  /** Tightly packed straight-alpha sRGB (`width * height * 4` bytes). */
  rgba: Buffer;
  sha256: string;
  width: number;
  height: number;
  evidence: GpuRuntimeEvidence;
  /**
   * Exact bounded copy/allocation facts for this raw-RGBA host handoff.
   * Legacy/test session seams may omit it; final streaming rejects omissions.
   */
  readback?: GpuReadbackFrameObservation;
  /** Evidence is retained from the page text preparation that fed this frame. */
  textFit?: readonly GpuTextFitEvidence[];
}
