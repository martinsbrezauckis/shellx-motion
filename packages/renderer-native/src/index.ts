import { isAbsolute, relative, resolve } from "node:path";
import {
  assertLocalMotionFrameBudget,
  assertMotionPointCapacity,
  assertReadableMotionKeyframes,
  evaluateMotionProceduralLayers,
  hasGpuScenePathGeometry,
  loadedPackageInputHashes,
  loadMotionPackage,
  matchRendererCapability,
  motionBehaviorLaneRefusal,
  motionRelationLaneRefusal, motionScene3DAnimationLaneRefusal, motionLayoutGapAnimationLaneRefusal,
  NATIVE_CAPABILITY,
  previewReceiptStatus,
  readVerifiedPackageAsset,
  resolveEasing,
  type MotionLayer,
  type MotionHostRenderCapacity,
  type MotionTransition,
  type MotionPackage,
  type OperationReceipt,
  type DerivedOutputPublication
} from "@shellx-motion/core";
import {
  decodeNativePngRgba,
  encodePng,
  hashBuffer,
  INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
  MAX_PNG_COMPRESSION_LEVEL,
  type NativeImage
} from "./native-png";
import { hslToRgb } from "./native-raster-blend";
import { publishNativeOutput } from "./native-output-publication";
import {
  assertNoStructuralNativePrivatePublication,
  resolveNativePrivateOutputPublication
} from "./private-output-publication";
import { RgbaCanvas } from "./native-raster-canvas";
import { applyColorEffects, blurCanvas } from "./native-raster-filters";
import { intersectClips, normalizeClip } from "./native-raster-geometry";
import { clamp, type NativeBlendMode, type NativeClip, type NativeColorEffects, type Rgba } from "./native-raster-primitives";
import { layoutNativeTextLines, lineHeightPixels, measureNativeText } from "./native-text-layout";
import { drawNativeTextLayer, nativeTextLayerWarnings } from "./native-text-renderer";
import { drawNativePointCloudLayer } from "./native-points-renderer";
import { drawNativeParticleLayer, nativeParticleLayerDimensions } from "./native-particles-renderer";
import { drawNativeAuthoredShapeGeometry } from "./native-authored-shape-geometry";
import { assertNativeGltfPbrFinalRefusal } from "./native-gltf-pbr-final-refusal";
import {
  nativeTextDeliveryIssues,
  nativeTextDeliveryMessage,
  type NativeTextDeliveryIssue
} from "./text-delivery-gate";
// Re-export the single-source native capability (owned by @shellx-motion/core) so existing
// consumers can keep importing it from this package. The runtime gate below consumes it directly.
export { NATIVE_CAPABILITY } from "@shellx-motion/core";
// Re-export the PNG deflate-level constants (public API) from their codec home so external
// consumers can keep importing them from this package entry point after the module-size extraction.
export { INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL, MAX_PNG_COMPRESSION_LEVEL } from "./native-png";
// Delivery-target text gate (the text-delivery invariant) — exported so callers can pre-flight a lane choice without
// opening a session, and so the CLI/tests can assert on the exact issue set.
export { nativeTextDeliveryIssues, nativeTextDeliveryMessage, type NativeTextDeliveryIssue } from "./text-delivery-gate";
export { caseFoldedCharacters, fallbackGlyphCharacters, nativeGlyphRepertoire } from "./native-glyphs";
/** One-frame-at-a-time native delivery producer for a pre-admitted final-video encoder job. */
export {
  getNativeFrameProducerFailureEvidence,
  NativeFrameProducerCleanupFailure,
  NativeFrameProducerFailure,
  produceNativeFrameStream
} from "./native-frame-producer";
export type {
  NativeFrameProducerContext,
  NativeFrameProducerEvidence,
  NativeFrameProducerInput,
  NativeFrameProducerRange,
  NativeFrameProducerRangeEvidence,
  NativeFrameProducerResult,
  NativeStreamingFrameSink,
  NativeStreamingJobContext
} from "./native-frame-producer";
export { renderNativePreviewFrame } from "./native-preview-frame";
export type { NativePreviewFrameInput } from "./native-preview-frame";
export interface NativePreviewFrame {
  png: Buffer;
  path: string | null;
  sha256: string;
  width: number;
  height: number;
  atMs: number;
}
export type NativePreviewFrameResult =
  | { ok: true; frame: NativePreviewFrame; receipt: OperationReceipt; warnings: string[] }
  | { ok: false; error: NativePreviewError; receipt: OperationReceipt; warnings: string[] };
export type NativePreviewError =
  | {
      code: "unsupported_layer";
      message: string;
      unsupported: Array<{ layerId: string; feature: string; reason: string }>;
    }
  | {
      code: "render_failed";
      message: string;
      unsupported: [];
    }
  | {
      /**
       * the text-delivery invariant: a DELIVERY render (encoded video / PNG sequence) was routed through the native
       * block-glyph lane with text the lane cannot draw faithfully. Refused rather than warned,
       * because the deliverable would otherwise ship case-folded, font-substituted or noise-boxed
       * text that is indistinguishable downstream from a correct render.
       */
      code: "native_text_not_deliverable";
      message: string;
      unsupported: NativeTextDeliveryIssue[];
    };

const DEFAULT_CURRENT_COLOR = { r: 0, g: 0, b: 0, a: 255 };

/**
 * A loaded native render session: the package is read, structurally hashed, and its referenced PNG
 * image assets are decoded ONCE, after which any number of frames are rendered from that in-memory
 * state. This is the load-once counterpart to {@link renderNativePreviewFrame}, which reloaded the
 * package, re-hashed the manifest + motion, and re-read/re-decoded every referenced PNG from disk on
 * every single frame — the dominant cost of a native final render. A 60s@30fps render would
 * otherwise perform 1,800 package loads and 1,800 full asset re-decodes.
 *
 * Snapshot semantics (mutation-safety): the structural inputs (manifest + motion) are hashed once at
 * {@link createNativeRenderSession} time, and every image asset is read / decoded / content-hashed at
 * most once — on the first frame that composites it — then reused for the session's lifetime. The
 * per-frame renderer this replaces re-read every input on every frame, so a package mutated mid-render
 * changed later frames; a session instead renders a consistent snapshot of the package as it existed
 * when the session opened. For identical, unmutated inputs the recorded fingerprint / hashes are
 * byte-for-byte the same as the per-frame path produced, so receipt `inputHashes` and ids are
 * unchanged.
 */
export interface NativeRenderSession {
  /**
   * Render one frame at `atMs`, optionally writing it to `outputPath`. Byte-for-byte equivalent to a
   * single {@link renderNativePreviewFrame} call for the same package / time / output — same frame
   * pixels and the same receipt `inputHashes` and id.
   *
   * @param atMs Timeline position in milliseconds.
   * @param outputPath Absolute or relative path to write the frame PNG to; omit to render in-memory
   *   only. Validated against the session's `outputRoots` when set.
   */
  renderFrameAtMs(atMs: number, outputPath?: string): Promise<NativePreviewFrameResult>;
  /** Release the decoded-asset and asset-hash caches held for the session's lifetime. */
  close(): void;
}
export interface CreateNativeRenderSessionInput {
  packageRoot: string;
  /** Output roots that any written frame path must resolve inside; enforced per rendered frame. */
  outputRoots?: string[];
  hostCapacity?: MotionHostRenderCapacity;
  /** Clock for receipt `createdAt`; invoked once per rendered frame. Defaults to wall-clock ISO time. */
  now?: () => string;
  /**
   * zlib deflate level (0-9) for encoded frame PNGs. Defaults to {@link MAX_PNG_COMPRESSION_LEVEL} so
   * single-frame / user-facing output is byte-identical to the historical renderer. The native
   * final-render loop, whose frames are transient FFmpeg encoder input, passes
   * {@link INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL} for a much faster encode. PNG is lossless at every
   * level, so decoded pixels are identical; only the compressed byte stream (and therefore the frame
   * sha256 / frame-sequence receipt hash) changes with the level.
   */
  pngCompressionLevel?: number;
  /**
   * What the rendered frames are for. `"preview"` (default) keeps the historical behavior: text the
   * block-glyph rasterizer cannot draw faithfully is approximated and warned about per layer.
   * `"delivery"` is for frames that become a user-facing artifact (encoded video, PNG sequence) and
   * refuses those documents outright with `native_text_not_deliverable` — the native capability card
   * declares `renderTargets: ["preview","still-frame","fixture-smoke"]`, and this is the code
   * honouring it (the text-delivery invariant).
   */
  renderTarget?: "preview" | "delivery";
}
interface NativeRenderSessionState {
  pkg: MotionPackage;
  outputRoots: string[];
  now: () => string;
  capability: ReturnType<typeof matchRendererCapability>;
  /** manifest.json + motion document hashes, computed once at session open (structural snapshot). */
  structuralHashes: Map<string, string>;
  /** package-relative asset ref -> decoded pixels; each asset decoded at most once per session. */
  imageCache: NativeImageAssets;
  /** package-relative asset ref -> hash of the exact decoded asset snapshot; populated with imageCache. */
  assetHashCache: Map<string, string>;
  /** zlib deflate level applied to every frame PNG this session encodes. */
  pngCompressionLevel: number;
  /**
   * Delivery-target text refusals, computed once at session open. Empty for preview sessions and for
   * delivery sessions whose text the block-glyph set draws faithfully (the text-delivery invariant).
   */
  textDeliveryIssues: NativeTextDeliveryIssue[];
  privateOutputPublication?: DerivedOutputPublication;
}
/**
 * Open a native render session for `packageRoot`. Loads and structurally hashes the package once (and
 * asserts its canvas fits the local frame budget); image assets are decoded lazily and cached on first
 * use. See {@link NativeRenderSession} for the snapshot/mutation-safety contract. Single-frame callers
 * can use {@link renderNativePreviewFrame} instead; multi-frame callers (final-render / image-sequence
 * loops) should open one session and render N frames to realize the load-once win.
 */
export async function createNativeRenderSession(input: CreateNativeRenderSessionInput): Promise<NativeRenderSession> {
  assertNoStructuralNativePrivatePublication(input);
  const privateOutputPublication = resolveNativePrivateOutputPublication(input);
  const pkg = await loadMotionPackage(input.packageRoot);
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(pkg.motion, "native"); if (layoutGapAnimationRefusal) throw new Error(layoutGapAnimationRefusal.message);
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(pkg.motion, "native"); if (scene3dAnimationRefusal) throw new Error(scene3dAnimationRefusal.message); const relationRefusal = motionRelationLaneRefusal(pkg.motion, "native"); if (relationRefusal) throw new Error(relationRefusal.message);
  const behaviorRefusal = motionBehaviorLaneRefusal(pkg.motion, "native"); if (behaviorRefusal) throw new Error(behaviorRefusal.message);
  assertNativeGltfPbrFinalRefusal(pkg);
  assertLocalMotionFrameBudget({ width: pkg.motion.width, height: pkg.motion.height });
  assertMotionPointCapacity(pkg.motion.layers, input.hostCapacity);
  // Same gate the browser lane applies at session open: a document whose keyframes the evaluator
  // cannot read renders motionless and reports success, so it is refused before any frame is drawn.
  assertReadableMotionKeyframes(pkg.motion);
  const capability = matchRendererCapability(pkg.motion, NATIVE_CAPABILITY);
  const loadedHashes = loadedPackageInputHashes(pkg);
  if (!loadedHashes?.["manifest.json"] || !loadedHashes[pkg.manifest.motion]) throw new Error("Native renderer requires loader-owned manifest and motion input hashes.");
  // Reopening these pathnames after load would let a supplier swap their bytes before receipt creation.
  const structuralHashes = new Map<string, string>([["manifest.json", loadedHashes["manifest.json"]], [pkg.manifest.motion, loadedHashes[pkg.manifest.motion]]]);
  const state: NativeRenderSessionState = {
    pkg,
    outputRoots: input.outputRoots ?? [],
    now: input.now ?? (() => new Date().toISOString()),
    capability,
    structuralHashes,
    imageCache: new Map(),
    assetHashCache: new Map(),
    pngCompressionLevel: input.pngCompressionLevel ?? MAX_PNG_COMPRESSION_LEVEL,
    textDeliveryIssues: input.renderTarget === "delivery" ? nativeTextDeliveryIssues(pkg.motion) : [],
    ...(privateOutputPublication ? { privateOutputPublication } : {})
  };
  return {
    renderFrameAtMs: (atMs, outputPath) => renderNativeSessionFrame(state, atMs, outputPath),
    close: () => {
      state.imageCache.clear();
      state.assetHashCache.clear();
    }
  };
}

/**
 * Render one frame from a loaded session. Mirrors the historical single-frame path exactly, differing
 * only in that structural hashes come from the session snapshot and image assets come from (or populate)
 * the session caches instead of being re-read per frame.
 */
async function renderNativeSessionFrame(
  state: NativeRenderSessionState,
  atMs: number,
  outputPath?: string
): Promise<NativePreviewFrameResult> {
  const resolvedOutputPath = outputPath ? resolve(outputPath) : null;
  if (resolvedOutputPath && state.outputRoots.length > 0 && !isPathInsideAnyRoot(resolvedOutputPath, state.outputRoots)) {
    throw new Error("Native output path must be inside a configured output root.");
  }
  const pkg = state.pkg;
  const createdAt = state.now();
  // Structural-only evidence (manifest + motion), used for the failure receipts below where no image
  // assets are decoded. Copied so callers cannot mutate the session's snapshot map.
  const baseInputHashes = sortHashRecord(new Map(state.structuralHashes));

  if (!state.capability.ok) {
    const warnings = state.capability.unsupported.map((unsupported) => unsupported.reason);
    const unsupportedLayerCount = new Set(state.capability.unsupported.map((unsupported) => unsupported.layerId)).size;
    const error: NativePreviewError = {
      code: "unsupported_layer",
      message: `Native renderer cannot render ${state.capability.unsupported.length} unsupported ${state.capability.unsupported.length === 1 ? "feature" : "features"} across ${unsupportedLayerCount} ${unsupportedLayerCount === 1 ? "layer" : "layers"}.`,
      unsupported: state.capability.unsupported
    };
    return {
      ok: false,
      error,
      receipt: createReceipt({ pkg, atMs, createdAt, inputHashes: baseInputHashes, status: "failed", output: null, warnings }),
      warnings
    };
  }

  // the text-delivery invariant: delivery sessions refuse text the block-glyph rasterizer cannot draw faithfully. A
  // warning was not enough — the encoded MP4 / PNG sequence is the artifact people ship, and a
  // case-folded or noise-boxed frame in it is indistinguishable from a correct one downstream.
  if (state.textDeliveryIssues.length > 0) {
    const deliveryWarnings = state.textDeliveryIssues.map((issue) => issue.reason);
    return {
      ok: false,
      error: {
        code: "native_text_not_deliverable",
        message: nativeTextDeliveryMessage(state.textDeliveryIssues),
        unsupported: state.textDeliveryIssues
      },
      receipt: createReceipt({ pkg, atMs, createdAt, inputHashes: baseInputHashes, status: "failed", output: null, warnings: deliveryWarnings }),
      warnings: deliveryWarnings
    };
  }

  const warnings: string[] = [];
  let canvas: RgbaCanvas;
  let activeAssetRefs: string[];
  try {
    // Evaluate procedural layers once and share the result between asset loading and drawing (the
    // per-frame path evaluated it twice); deterministic in atMs, so the frame is byte-identical.
    const evaluatedLayers = evaluateMotionProceduralLayers(pkg.motion, atMs).layers;
    activeAssetRefs = await ensureSessionImageAssets(state, evaluatedLayers, atMs);
    canvas = new RgbaCanvas(pkg.motion.width, pkg.motion.height);
    canvas.fill(parseColor(resolveTokenString(pkg.motion.background ?? "#00000000", pkg)));
    for (const layer of evaluatedLayers) {
      if (!isLayerActive(layer, atMs)) continue;
      warnings.push(...nativeLayerWarnings(layer));
      drawNativeLayer(canvas, layer, pkg, atMs, state.imageCache);
    }
  } catch (error) {
    const message = `Native renderer failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: { code: "render_failed", message, unsupported: [] },
      receipt: createReceipt({ pkg, atMs, createdAt, inputHashes: baseInputHashes, status: "failed", output: null, warnings: [message] }),
      warnings: [message]
    };
  }

  // Success: attest every pixel input actually composited into the frame. Asset hashes
  // are pulled from (or populate) the session cache — identical values to a per-frame re-hash.
  const inputHashes = await buildSessionInputHashes(state, activeAssetRefs);
  const png = encodePng(canvas.width, canvas.height, canvas.data, state.pngCompressionLevel);
  const sha256 = hashBuffer(png);
  if (resolvedOutputPath) {
    await publishNativeOutput(resolvedOutputPath, png, state.privateOutputPublication);
  }

  const frame: NativePreviewFrame = {
    png,
    path: resolvedOutputPath,
    sha256,
    width: canvas.width,
    height: canvas.height,
    atMs
  };

  return {
    ok: true,
    frame,
    receipt: createReceipt({
      pkg,
      atMs,
      createdAt,
      inputHashes,
      status: previewReceiptStatus({ warnings }),
      output: { path: resolvedOutputPath, sha256, width: canvas.width, height: canvas.height, atMs },
      warnings
    }),
    warnings
  };
}

function isPathInsideAnyRoot(path: string, roots: string[]): boolean {
  const resolvedPath = resolve(path);
  return roots.map((root) => root.trim()).filter(Boolean).map((root) => resolve(root)).some((root) => isPathInsideOrEqual(root, resolvedPath));
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * Assemble a native preview receipt's input evidence from session-cached hashes.
 *
 * The structural inputs (manifest + motion) come from the session snapshot hashed once at
 * {@link createNativeRenderSession} time. Each package-relative ref in `activeAssetRefs` — the image
 * assets actually decoded and composited into this frame, see {@link ensureSessionImageAssets} — is
 * also hashed and keyed by its ref; without this, swapping a decoded pixel input would leave
 * `inputHashes` unchanged, so the receipt would claim complete input evidence while excluding the
 * actual pixels. The hash comes from the exact verified bytes decoded into `imageCache`, never a
 * later pathname reopen, and is computed at most once per asset per session.
 *
 * Keys are emitted in sorted order so the receipt is byte-for-byte deterministic regardless of the
 * order in which layers reference their assets. Manifest / motion keys take precedence over any image
 * asset ref that happens to collide with them.
 *
 * @param state Loaded session (provides the structural snapshot, the asset-hash cache and the package).
 * @param activeAssetRefs Package-relative refs of the image assets composited into this frame.
 * @returns Map of input role / package-relative asset path -> sha256 hex, keys sorted ascending.
 */
async function buildSessionInputHashes(state: NativeRenderSessionState, activeAssetRefs: string[]): Promise<Record<string, string>> {
  const hashes = new Map(state.structuralHashes);
  for (const assetRef of activeAssetRefs) {
    if (hashes.has(assetRef)) continue; // manifest/motion win; dedupe repeated refs
    const assetHash = state.assetHashCache.get(assetRef);
    if (assetHash === undefined) throw new Error(`Native image asset was decoded without a verified hash: ${assetRef}`);
    hashes.set(assetRef, assetHash);
  }
  return sortHashRecord(hashes);
}

/**
 * Serialize a hash map into a plain record with keys in ascending sort order.
 *
 * Receipts are content evidence that get hashed and compared byte-for-byte downstream, so the key
 * ordering must not depend on insertion order (which follows non-deterministic layer/asset
 * iteration).
 */
function sortHashRecord(hashes: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function createReceipt(input: {
  pkg: MotionPackage;
  atMs: number;
  createdAt: string;
  inputHashes: Record<string, string>;
  status: OperationReceipt["status"];
  output: unknown;
  warnings: string[];
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: nativeReceiptId({
      atMs: input.atMs,
      status: input.status,
      output: input.output,
      inputHashes: input.inputHashes,
      warnings: input.warnings
    }),
    operation: "preview.frame",
    status: input.status,
    packageId: input.pkg.manifest.id,
    inputHashes: input.inputHashes,
    createdAt: input.createdAt,
    lane: "native",
    output: input.output,
    warnings: input.warnings
  };
}

/**
 * Derive a native preview receipt id with a content component so distinct renders never collide
 * The previous `receipt_native_preview_<pkgId>_<atMs>` form collided across runs whose
 * content differed, for example after a swapped image asset. This mirrors the output-hash-derived id
 * convention already used by the ffmpeg (`ffmpeg-render-<sha16>`) and browser
 * (`browser-preview-<sha16>`) lanes: a successful frame is content-addressed by its output PNG hash,
 * so identical content yields an identical id and any content change yields a different id.
 *
 * Failure receipts have no output frame to hash, so their component is derived from the render
 * inputs (atMs + status + inputHashes + warnings) — enough to distinguish different failing frames
 * while keeping the same failure of the same inputs deterministic.
 *
 * @returns `receipt_native_preview_<16 hex chars>`.
 */
function nativeReceiptId(input: {
  atMs: number;
  status: OperationReceipt["status"];
  output: unknown;
  inputHashes: Record<string, string>;
  warnings: string[];
}): string {
  const outputSha = nativeOutputSha(input.output);
  const component = outputSha ?? hashBuffer(Buffer.from(JSON.stringify({
    atMs: input.atMs,
    status: input.status,
    inputHashes: input.inputHashes,
    warnings: input.warnings
  }), "utf8"));
  return `receipt_native_preview_${component.slice(0, 16)}`;
}

/**
 * Extract the output frame sha256 from a receipt output payload, if present. Returns null for
 * failure receipts (`output: null`) or any payload lacking a string `sha256`.
 */
function nativeOutputSha(output: unknown): string | null {
  if (output && typeof output === "object" && "sha256" in output) {
    const sha = (output as { sha256?: unknown }).sha256;
    if (typeof sha === "string" && sha.length > 0) return sha;
  }
  return null;
}

function nativeLayerWarnings(layer: MotionLayer): string[] {
  return layer.type === "text" || layer.type === "caption" ? nativeTextLayerWarnings(layer) : [];
}

type NativeImageAssets = Map<string, NativeImage>;

/**
 * Decode (once) and cache the PNG image assets composited by the layers active at `atMs`, returning
 * the package-relative refs of those active assets (deduped, in first-seen order). Only assets belonging
 * to active image layers are touched — an image layer outside its time window is never read (regression:
 * inactive PNG layers, including deliberately missing ones, must not be loaded). On a cache hit the asset
 * is neither re-read nor re-decoded, which is where the load-once win is realized across a multi-frame
 * render. A decode error propagates to the caller's try/catch, yielding a `render_failed` receipt exactly
 * as the per-frame path did.
 *
 * @param state Loaded session (provides the package and the decoded-image cache).
 * @param evaluatedLayers Layers already evaluated for `atMs` (shared with the draw loop to avoid a
 *   second procedural evaluation).
 * @param atMs Timeline position in milliseconds.
 * @returns Package-relative refs of the image assets active at `atMs`.
 */
async function ensureSessionImageAssets(state: NativeRenderSessionState, evaluatedLayers: MotionLayer[], atMs: number): Promise<string[]> {
  const activeRefs: string[] = [];
  const seen = new Set<string>();
  for (const layer of evaluatedLayers) {
    if (!isLayerActive(layer, atMs)) continue;
    if (layer.type !== "image") continue;
    const assetRef = imageLayerAssetRef(layer, state.pkg);
    if (!assetRef || seen.has(assetRef)) continue;
    seen.add(assetRef);
    activeRefs.push(assetRef);
    if (!state.imageCache.has(assetRef)) {
      const asset = await readVerifiedPackageAsset(state.pkg, assetRef, {
        label: `Native image asset ${assetRef}`
      });
      const image = decodeNativePngRgba(asset.bytes);
      // Decoded pixels and receipt hash come from one opened, no-follow, in-root object.
      state.imageCache.set(assetRef, image);
      state.assetHashCache.set(assetRef, asset.sha256);
    }
  }
  return activeRefs;
}

function imageLayerAssetRef(layer: MotionLayer, pkg: MotionPackage): string | null {
  const directRef = readString(layer.assetRef) ?? readString(layer.source) ?? readString(layer.src);
  if (directRef) return directRef;
  const assetId = readString(layer.assetId);
  return assetId ? findMotionAssetPath(pkg, assetId) : null;
}

function findMotionAssetPath(pkg: MotionPackage, assetId: string): string | null {
  for (const asset of pkg.motion.assets) {
    const record = readRecord(asset);
    if (record.id !== assetId) continue;
    const source = readRecord(record.source);
    const path = readString(source.path);
    if (path) return path;
  }
  return null;
}

function requireNativeImageAsset(layer: MotionLayer, pkg: MotionPackage, imageAssets: NativeImageAssets): NativeImage {
  const assetRef = imageLayerAssetRef(layer, pkg);
  if (!assetRef) throw new Error(`Native image layer ${layer.id} requires assetRef, source, or src.`);
  const image = imageAssets.get(assetRef);
  if (!image) throw new Error(`Native image layer ${layer.id} could not load image asset: ${assetRef}`);
  return image;
}

function drawNativeLayer(canvas: RgbaCanvas, layer: MotionLayer, pkg: MotionPackage, atMs: number, imageAssets: NativeImageAssets): void {
  const rotation = normalizedRotation(readTransform(layer).rotation ?? 0);
  const blur = nativeBlurRadius(layer);
  const colorEffects = nativeColorEffects(layer);
  const needsColorEffects = hasNativeColorEffects(colorEffects);
  const blendMode = nativeBlendMode(layer);
  if (rotation === 0 && blur <= 0 && !needsColorEffects && blendMode === null) {
    paintNativeLayer(canvas, layer, pkg, atMs, imageAssets);
    return;
  }

  const layerCanvas = new RgbaCanvas(canvas.width, canvas.height);
  paintNativeLayer(layerCanvas, layer, pkg, atMs, imageAssets);
  let processedLayer = blur > 0 ? blurCanvas(layerCanvas, blur) : layerCanvas;
  if (needsColorEffects) {
    processedLayer = applyColorEffects(processedLayer, colorEffects);
  }
  const anchor = layerRotationAnchor(layer, pkg, imageAssets);
  if (rotation === 0) {
    canvas.composite(processedLayer, blendMode);
    return;
  }
  canvas.compositeRotated(processedLayer, anchor.x, anchor.y, rotation, blendMode);
}

function paintNativeLayer(canvas: RgbaCanvas, layer: MotionLayer, pkg: MotionPackage, atMs: number, imageAssets: NativeImageAssets): void {
  if (layer.type === "shape") drawShapeLayer(canvas, layer, pkg, atMs);
  if (layer.type === "points") drawNativePointCloudLayer({
    canvas, layer, atMs, viewport: { width: pkg.motion.width, height: pkg.motion.height }, services: nativeLayerServices,
    colorFor: (color, pointOpacity) => {
      const parsed = parseColor(resolveTokenString(color, pkg));
      return applyLayerOpacity({ ...parsed, a: Math.round(parsed.a * pointOpacity) }, layer);
    }
  });
  if (layer.type === "particles") drawNativeParticleLayer({
    canvas, layer, atMs, viewport: { width: pkg.motion.width, height: pkg.motion.height }, services: nativeLayerServices,
    colorFor: (color, particleOpacity) => {
      const parsed = parseColor(resolveTokenString(color, pkg));
      return applyLayerOpacity({ ...parsed, a: Math.round(parsed.a * particleOpacity) }, layer);
    }
  });
  if (layer.type === "text" || layer.type === "caption") drawNativeTextLayer(canvas, layer, pkg, atMs, nativeTextRenderingServices);
  if (layer.type === "image") drawImageLayer(canvas, layer, pkg, imageAssets, atMs);
}

function normalizedRotation(rotation: number): number {
  const normalized = ((rotation % 360) + 360) % 360;
  return Math.abs(normalized) < 0.0001 || Math.abs(normalized - 360) < 0.0001 ? 0 : normalized;
}

function nativeBlurRadius(layer: MotionLayer): number {
  const effects = readRecord(layer.effects);
  return Math.max(0, readNumber(effects.blur) ?? 0);
}

function nativeColorEffects(layer: MotionLayer): NativeColorEffects {
  const effects = readRecord(layer.effects);
  return {
    brightness: Math.max(0, readNumber(effects.brightness) ?? 1),
    contrast: Math.max(0, readNumber(effects.contrast) ?? 1),
    saturate: Math.max(0, readNumber(effects.saturate) ?? 1),
    grayscale: Math.max(0, readNumber(effects.grayscale) ?? 0)
  };
}

function hasNativeColorEffects(effects: NativeColorEffects): boolean {
  return effects.brightness !== 1 || effects.contrast !== 1 || effects.saturate !== 1 || effects.grayscale !== 0;
}

const NATIVE_BLEND_MODES = new Set<NativeBlendMode>([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-lighter"
]);

function nativeBlendMode(layer: MotionLayer): NativeBlendMode | null {
  const blendMode = readString(layer.blendMode);
  if (!blendMode || blendMode === "normal") return null;
  return NATIVE_BLEND_MODES.has(blendMode as NativeBlendMode) ? blendMode as NativeBlendMode : null;
}

function layerRotationAnchor(layer: MotionLayer, pkg: MotionPackage, imageAssets: NativeImageAssets): { x: number; y: number } {
  const transform = readTransform(layer);
  const dimensions = layerBaseDimensions(layer, transform, pkg, imageAssets);
  return {
    x: transform.x + (transform.originX ?? dimensions.width / 2),
    y: transform.y + (transform.originY ?? dimensions.height / 2)
  };
}

function layerBaseDimensions(layer: MotionLayer, transform: ReturnType<typeof readTransform>, pkg: MotionPackage, imageAssets: NativeImageAssets): { width: number; height: number } {
  const style = readRecord(layer.style);
  if (layer.type === "points") return { width: pkg.motion.width, height: pkg.motion.height };
  if (layer.type === "particles") return nativeParticleLayerDimensions(layer, transform);
  if (layer.type === "shape") {
    return {
      width: transform.width ?? readNumber(layer.width) ?? readNumber(style.width) ?? 100,
      height: transform.height ?? readNumber(layer.height) ?? readNumber(style.height) ?? 100
    };
  }
  if (layer.type === "image") {
    const image = requireNativeImageAsset(layer, pkg, imageAssets);
    return {
      width: transform.width ?? readCssPixelValue(layer.width) ?? readCssPixelValue(style.width) ?? image.width,
      height: transform.height ?? readCssPixelValue(layer.height) ?? readCssPixelValue(style.height) ?? image.height
    };
  }

  const explicitWidth = transform.width ?? readCssPixelValue(layer.width) ?? readCssPixelValue(style.width);
  const explicitHeight = transform.height ?? readCssPixelValue(layer.height) ?? readCssPixelValue(style.height);
  const estimated = estimateNativeTextBox(layer, style);
  return {
    width: explicitWidth ?? estimated.width,
    height: explicitHeight ?? estimated.height
  };
}

function estimateNativeTextBox(layer: MotionLayer, style: Record<string, unknown>): { width: number; height: number } {
  const text = readString(layer.text) ?? "";
  const fontSize = readNumber(style.fontSize) ?? 32;
  const pixelSize = Math.max(1, Math.round(fontSize / 7));
  const glyphWidth = pixelSize * 5;
  const glyphHeight = pixelSize * 7;
  const spacing = Math.max(1, Math.round(pixelSize * 0.8));
  const lineHeight = lineHeightPixels(style.lineHeight, fontSize, 1, glyphHeight);
  const lines = layoutNativeTextLines(text, null, glyphWidth, spacing);
  return {
    width: Math.max(1, lines.reduce((max, line) => Math.max(max, measureNativeText(line, glyphWidth, spacing)), 0)),
    height: Math.max(1, lines.length <= 1 ? glyphHeight : ((lines.length - 1) * lineHeight) + glyphHeight)
  };
}

function drawImageLayer(canvas: RgbaCanvas, layer: MotionLayer, pkg: MotionPackage, imageAssets: NativeImageAssets, atMs: number): void {
  const image = requireNativeImageAsset(layer, pkg, imageAssets);
  const transform = readTransform(layer);
  const style = readRecord(layer.style);
  const width = transform.width ?? readCssPixelValue(layer.width) ?? readCssPixelValue(style.width) ?? image.width;
  const height = transform.height ?? readCssPixelValue(layer.height) ?? readCssPixelValue(style.height) ?? image.height;
  const box = scaleBoxAroundOrigin(transform.x, transform.y, width, height, transform.scale, transform.originX, transform.originY);
  const mask = layerPaintClip(layer, box, transform.scale, atMs);
  const imageClip = intersectClips(mask ? normalizeClip(mask) : null, normalizeClip(box));
  const opacity = clamp(readNumber(layer.opacity) ?? 1, 0, 1);
  const radius = shapeRadiusPixels(style, pkg, transform.scale, box.width, box.height);
  const shadow = shapeShadow(style, pkg, transform.scale, layer);
  const sourceRect = imageSourceRectForLayer(layer, image);

  if (shadow) {
    canvas.withClip(mask, () => {
      drawShapeShadow(canvas, box, radius, shadow, "rect", null);
    });
  }
  canvas.withClip(imageClip, () => {
    canvas.drawImage(image, imagePlacementForBox(box, sourceRect, nativeImageFit(layer)), opacity, radius > 0 ? { box, radius } : null, sourceRect);
  });
}

type NativeImageFit = "fill" | "contain" | "cover" | "none" | "scale-down";

function nativeImageFit(layer: MotionLayer): NativeImageFit {
  const style = readRecord(layer.style);
  const fit = (readString(layer.fit) ?? readString(style.objectFit) ?? readString(style.fit) ?? "cover").trim().toLowerCase();
  if (fit === "contain" || fit === "cover" || fit === "none" || fit === "scale-down") return fit;
  return "fill";
}

function imageSourceRectForLayer(layer: MotionLayer, image: NativeImage): NativeClip {
  const crop = readRecord(layer.crop);
  const cropX = readNumber(crop.x);
  const cropY = readNumber(crop.y);
  const cropWidth = readNumber(crop.width);
  const cropHeight = readNumber(crop.height);
  if (cropX === null || cropY === null || cropWidth === null || cropHeight === null || cropWidth <= 0 || cropHeight <= 0) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }

  const x = clamp(cropX, 0, Math.max(0, image.width - 1));
  const y = clamp(cropY, 0, Math.max(0, image.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(cropWidth, image.width - x)),
    height: Math.max(1, Math.min(cropHeight, image.height - y))
  };
}

function imagePlacementForBox(box: NativeClip, sourceRect: Pick<NativeClip, "width" | "height">, fit: NativeImageFit): NativeClip {
  if (fit === "fill") return box;
  if (fit === "none") {
    return centerNaturalImagePlacement(box, sourceRect);
  }
  if (fit === "scale-down") {
    if (sourceRect.width <= box.width && sourceRect.height <= box.height) {
      return centerNaturalImagePlacement(box, sourceRect);
    }
    return scaledImagePlacement(box, sourceRect, "contain");
  }
  return scaledImagePlacement(box, sourceRect, fit);
}

function scaledImagePlacement(box: NativeClip, sourceRect: Pick<NativeClip, "width" | "height">, fit: "contain" | "cover"): NativeClip {
  const scale = fit === "contain"
    ? Math.min(box.width / sourceRect.width, box.height / sourceRect.height)
    : Math.max(box.width / sourceRect.width, box.height / sourceRect.height);
  const width = sourceRect.width * scale;
  const height = sourceRect.height * scale;
  return {
    x: box.x + ((box.width - width) / 2),
    y: box.y + ((box.height - height) / 2),
    width,
    height
  };
}

function centerNaturalImagePlacement(box: NativeClip, sourceRect: Pick<NativeClip, "width" | "height">): NativeClip {
  return { x: box.x + ((box.width - sourceRect.width) / 2), y: box.y + ((box.height - sourceRect.height) / 2), width: sourceRect.width, height: sourceRect.height };
}

function drawShapeLayer(canvas: RgbaCanvas, layer: MotionLayer, pkg: MotionPackage, atMs: number): void {
  const transform = readTransform(layer), style = readRecord(layer.style);
  if (hasGpuScenePathGeometry(layer)) {
    const width = transform.width ?? readNumber(layer.width) ?? readNumber(style.width) ?? 100, height = transform.height ?? readNumber(layer.height) ?? readNumber(style.height) ?? 100, box = scaleBoxAroundOrigin(transform.x, transform.y, width, height, transform.scale, transform.originX, transform.originY);
    canvas.withClip(layerPaintClip(layer, box, transform.scale, atMs), () => drawNativeAuthoredShapeGeometry(canvas, layer, pkg, transform, style, resolveTokenString)); return;
  }
  const scale = transform.scale;
  const width = transform.width ?? readNumber(layer.width) ?? readNumber(style.width) ?? 100;
  const height = transform.height ?? readNumber(layer.height) ?? readNumber(style.height) ?? 100;
  const fill = resolveTokenString(readString(layer.fill) ?? readString(style.fill) ?? readString(style.color) ?? "#ffffff", pkg);
  const box = scaleBoxAroundOrigin(transform.x, transform.y, width, height, scale, transform.originX, transform.originY);
  const shapeKind = nativeShapeKind(layer);
  const pathData = nativeShapePath(layer);
  const radius = shapeRadiusPixels(style, pkg, scale, box.width, box.height);
  const shadow = shapeShadow(style, pkg, scale, layer);
  const mask = layerPaintClip(layer, box, scale, atMs);

  canvas.withClip(mask, () => {
    if (shadow) {
      drawShapeShadow(canvas, box, radius, shadow, shapeKind, pathData);
    }
    fillNativeShape(canvas, shapeKind, box, radius, applyLayerOpacity(parseColor(fill), layer), pathData);
    const stroke = readString(style.stroke);
    const strokeWidth = strokeWidthForStyle(style) * scale;
    if (stroke && strokeWidth > 0) {
      strokeNativeShape(canvas, shapeKind, box, strokeWidth, radius, applyLayerOpacity(parseColor(resolveTokenString(stroke, pkg)), layer), pathData);
    }
  });
}

type NativeShapeKind = "rect" | "ellipse" | "triangle" | "star" | "path";

function nativeShapeKind(layer: MotionLayer): NativeShapeKind {
  const shape = readString(layer.shape);
  if (shape === "ellipse") return "ellipse";
  if (shape === "triangle") return "triangle";
  if (shape === "star") return "star";
  if (shape === "path") return "path";
  if (shape === "freeform" && nativeShapePath(layer)) return "path";
  return "rect";
}

function nativeShapePath(layer: MotionLayer): string | null {
  return readString(layer["x-path"]) ?? readString(readRecord(layer.style).path);
}

function fillNativeShape(
  canvas: RgbaCanvas,
  shapeKind: NativeShapeKind,
  box: { x: number; y: number; width: number; height: number },
  radius: number,
  color: Rgba,
  pathData: string | null = null
): void {
  if (shapeKind === "ellipse") {
    canvas.fillEllipse(box.x, box.y, box.width, box.height, color);
    return;
  }
  if (shapeKind === "triangle") {
    canvas.fillTriangle(box.x, box.y, box.width, box.height, color);
    return;
  }
  if (shapeKind === "star") {
    canvas.fillStar(box.x, box.y, box.width, box.height, color);
    return;
  }
  if (shapeKind === "path") {
    canvas.fillPathShape(box.x, box.y, box.width, box.height, requirePathData(pathData), color);
    return;
  }
  canvas.fillRoundedRect(box.x, box.y, box.width, box.height, radius, color);
}

function strokeNativeShape(
  canvas: RgbaCanvas,
  shapeKind: NativeShapeKind,
  box: { x: number; y: number; width: number; height: number },
  strokeWidth: number,
  radius: number,
  color: Rgba,
  pathData: string | null = null
): void {
  if (shapeKind === "ellipse") {
    canvas.strokeEllipse(box.x, box.y, box.width, box.height, strokeWidth, color);
    return;
  }
  if (shapeKind === "triangle") {
    canvas.strokeTriangle(box.x, box.y, box.width, box.height, strokeWidth, color);
    return;
  }
  if (shapeKind === "star") {
    canvas.strokeStar(box.x, box.y, box.width, box.height, strokeWidth, color);
    return;
  }
  if (shapeKind === "path") {
    canvas.strokePathShape(box.x, box.y, box.width, box.height, strokeWidth, requirePathData(pathData), color);
    return;
  }
  canvas.strokeRoundedRect(box.x, box.y, box.width, box.height, strokeWidth, radius, color);
}

function requirePathData(pathData: string | null): string {
  if (!pathData) throw new Error("Native path shapes require an x-path string.");
  return pathData;
}

function strokeWidthForStyle(style: Record<string, unknown>): number {
  const explicit = readNumber(style.strokeWidth);
  if (explicit !== null) return Math.max(0, explicit);
  return readString(style.stroke) ? Math.max(0, readNumber(style.width) ?? 0) : 0;
}

function shapeRadiusPixels(style: Record<string, unknown>, pkg: MotionPackage, scale: number, width: number, height: number): number {
  const radius = readCssPixelValue(resolveTokenValue(style.borderRadius, pkg)) ?? readCssPixelValue(resolveTokenValue(style.radius, pkg)) ?? 0;
  return Math.max(0, Math.min(radius * scale, width / 2, height / 2));
}

interface NativeShapeShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: Rgba;
}

function shapeShadow(style: Record<string, unknown>, pkg: MotionPackage, scale: number, layer: MotionLayer): NativeShapeShadow | null {
  const shadow = readRecord(style.boxShadow ?? style.shadow);
  if (Object.keys(shadow).length === 0) return null;
  const color = applyLayerOpacity(parseColor(resolveTokenString(readString(shadow.color) ?? "rgba(0,0,0,0.35)", pkg)), layer);
  if (color.a <= 0) return null;
  return {
    x: shadowLengthPixels(shadow, ["x", "offsetX"], scale),
    y: shadowLengthPixels(shadow, ["y", "offsetY"], scale),
    blur: Math.max(0, shadowLengthPixels(shadow, ["blur", "blurRadius"], scale)),
    spread: shadowLengthPixels(shadow, ["spread", "spreadRadius"], scale),
    color
  };
}

function shadowLengthPixels(shadow: Record<string, unknown>, keys: string[], scale: number): number {
  for (const key of keys) {
    const value = readCssPixelValue(shadow[key]);
    if (value !== null) return value * scale;
  }
  return 0;
}

function drawShapeShadow(
  canvas: RgbaCanvas,
  box: { x: number; y: number; width: number; height: number },
  radius: number,
  shadow: NativeShapeShadow,
  shapeKind: NativeShapeKind,
  pathData: string | null
): void {
  const baseX = box.x + shadow.x - shadow.spread;
  const baseY = box.y + shadow.y - shadow.spread;
  const baseWidth = box.width + shadow.spread * 2;
  const baseHeight = box.height + shadow.spread * 2;
  const baseRadius = Math.max(0, radius + shadow.spread);
  if (baseWidth <= 0 || baseHeight <= 0) return;

  if (shadow.blur > 0) {
    const steps = Math.min(24, Math.max(1, Math.ceil(shadow.blur)));
    for (let step = steps; step >= 1; step -= 1) {
      const expansion = (shadow.blur * step) / steps;
      const alpha = Math.round(shadow.color.a * ((steps - step + 1) / (steps + 1)) * 0.35);
      if (alpha <= 0) continue;
      fillNativeShape(
        canvas,
        shapeKind,
        { x: baseX - expansion, y: baseY - expansion, width: baseWidth + expansion * 2, height: baseHeight + expansion * 2 },
        baseRadius + expansion,
        { ...shadow.color, a: alpha },
        pathData
      );
    }
  }

  fillNativeShape(canvas, shapeKind, { x: baseX, y: baseY, width: baseWidth, height: baseHeight }, baseRadius, shadow.color, pathData);
}


function layerPaintClip(layer: MotionLayer, box: NativeClip, scale: number, atMs: number): NativeClip | null {
  const mask = readRecord(layer.mask);
  const maskType = readString(mask.type);
  const hasMask = maskType === "rect" || maskType === "rounded-rect";
  const maskInsets = maskInsetsForLayer(mask, hasMask, scale);
  const wipeInsets = transitionWipeInsets(layer, box, atMs);
  const top = Math.max(maskInsets.top, wipeInsets.top);
  const right = Math.max(maskInsets.right, wipeInsets.right);
  const bottom = Math.max(maskInsets.bottom, wipeInsets.bottom);
  const left = Math.max(maskInsets.left, wipeInsets.left);
  const radius = hasMask ? Math.max(0, (readNumber(mask.radius) ?? 0) * scale) : 0;
  if (top <= 0 && right <= 0 && bottom <= 0 && left <= 0 && radius <= 0) return null;
  return {
    x: box.x + left,
    y: box.y + top,
    width: Math.max(0, box.width - left - right),
    height: Math.max(0, box.height - top - bottom),
    ...(radius > 0 ? { radius } : {})
  };
}

function maskInsetsForLayer(mask: Record<string, unknown>, hasMask: boolean, scale: number): { top: number; right: number; bottom: number; left: number } {
  if (!hasMask) return { top: 0, right: 0, bottom: 0, left: 0 };
  const inset = readRecord(mask.inset);
  return {
    top: Math.max(0, (readNumber(inset.top) ?? 0) * scale),
    right: Math.max(0, (readNumber(inset.right) ?? 0) * scale),
    bottom: Math.max(0, (readNumber(inset.bottom) ?? 0) * scale),
    left: Math.max(0, (readNumber(inset.left) ?? 0) * scale)
  };
}

function transitionWipeInsets(layer: MotionLayer, box: NativeClip, atMs: number): { top: number; right: number; bottom: number; left: number } {
  const localMs = atMs - layer.startMs;
  const remainingMs = Math.max(0, layer.durationMs) - localMs;
  const inInsets = wipeTransitionInsets(layer.transitions?.in, localMs, "in", box);
  const outInsets = wipeTransitionInsets(layer.transitions?.out, remainingMs, "out", box);
  return {
    top: Math.max(inInsets.top, outInsets.top),
    right: Math.max(inInsets.right, outInsets.right),
    bottom: Math.max(inInsets.bottom, outInsets.bottom),
    left: Math.max(inInsets.left, outInsets.left)
  };
}

function wipeTransitionInsets(
  transition: MotionTransition | undefined,
  elapsedMs: number,
  edge: "in" | "out",
  box: NativeClip
): { top: number; right: number; bottom: number; left: number } {
  if (!transition || transition.type !== "wipe" || transition.durationMs <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const hidden = edge === "in"
    ? wipeInHiddenRatio(transition, elapsedMs)
    : wipeOutHiddenRatio(transition, elapsedMs);
  const direction = transition.direction ?? "left";
  if (edge === "in") {
    if (direction === "right") return { top: 0, right: 0, bottom: 0, left: box.width * hidden };
    if (direction === "up") return { top: 0, right: 0, bottom: box.height * hidden, left: 0 };
    if (direction === "down") return { top: box.height * hidden, right: 0, bottom: 0, left: 0 };
    return { top: 0, right: box.width * hidden, bottom: 0, left: 0 };
  }
  if (direction === "right") return { top: 0, right: box.width * hidden, bottom: 0, left: 0 };
  if (direction === "up") return { top: box.height * hidden, right: 0, bottom: 0, left: 0 };
  if (direction === "down") return { top: 0, right: 0, bottom: box.height * hidden, left: 0 };
  return { top: 0, right: 0, bottom: 0, left: box.width * hidden };
}

function wipeInHiddenRatio(transition: MotionTransition, elapsedMs: number): number {
  if (elapsedMs >= transition.durationMs) return 0;
  if (elapsedMs <= 0) return 1;
  return 1 - resolveEasing(transition.easing)(clamp(elapsedMs / transition.durationMs, 0, 1));
}

function wipeOutHiddenRatio(transition: MotionTransition, remainingMs: number): number {
  if (remainingMs >= transition.durationMs) return 0;
  if (remainingMs <= 0) return 1;
  return resolveEasing(transition.easing)(clamp(1 - (remainingMs / transition.durationMs), 0, 1));
}

function readCssPixelValue(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric !== null) return numeric;
  const text = readString(value)?.trim();
  if (!text) return null;
  if (text.endsWith("px")) {
    const pixels = Number(text.slice(0, -2));
    return Number.isFinite(pixels) ? pixels : null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function scaleBoxAroundOrigin(
  x: number,
  y: number,
  width: number,
  height: number,
  scale: number,
  originX: number | undefined,
  originY: number | undefined
): { x: number; y: number; width: number; height: number } {
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const anchorX = originX ?? width / 2;
  const anchorY = originY ?? height / 2;
  return {
    x: x + anchorX - (anchorX * scale),
    y: y + anchorY - (anchorY * scale),
    width: scaledWidth,
    height: scaledHeight
  };
}

function isLayerActive(layer: MotionLayer, atMs: number): boolean {
  return layer.visible !== false && atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs;
}

function readTransform(layer: MotionLayer): { x: number; y: number; scale: number; width?: number; height?: number; originX?: number; originY?: number; rotation?: number } {
  const transform = readRecord(layer.transform);
  const width = readNumber(transform.width);
  const height = readNumber(transform.height);
  const originX = readNumber(transform.originX);
  const originY = readNumber(transform.originY);
  const rotation = readNumber(transform.rotation);
  return {
    x: readNumber(transform.x) ?? 0,
    y: readNumber(transform.y) ?? 0,
    scale: readNumber(transform.scale) ?? 1,
    ...(width !== null ? { width } : {}),
    ...(height !== null ? { height } : {}),
    ...(originX !== null ? { originX } : {}),
    ...(originY !== null ? { originY } : {}),
    ...(rotation !== null ? { rotation } : {})
  };
}

function applyLayerOpacity(color: Rgba, layer: MotionLayer): Rgba {
  const opacity = clamp(readNumber(layer.opacity) ?? 1, 0, 1);
  return { ...color, a: Math.round(color.a * opacity) };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function resolveTokenString(value: unknown, pkg: MotionPackage): string {
  const resolved = resolveTokenValue(value, pkg);
  return typeof resolved === "string" || typeof resolved === "number" ? String(resolved) : String(value);
}

function resolveTokenValue(value: unknown, pkg: MotionPackage): unknown {
  if (typeof value !== "string") return value;
  const match = /^\{([^}]+)\}$/.exec(value.trim());
  if (!match) return value;
  let current: unknown = pkg.motion.designTokens;
  for (const key of match[1].split(".")) {
    current = readRecord(current)[key];
  }
  return current === undefined ? value : current;
}


const nativeTextRenderingServices = {
  applyLayerOpacity,
  layerPaintClip,
  parseColor,
  resolveTokenString
};

const nativeLayerServices = {
  readTransform,
  scaleBoxAroundOrigin,
  layerPaintClip
};

function parseColor(value: string, context: { currentColor?: Rgba } = {}): Rgba {
  const hex = value.trim();
  if (hex.toLowerCase() === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (hex.toLowerCase() === "currentcolor") {
    return { ...(context.currentColor ?? DEFAULT_CURRENT_COLOR) };
  }
  const named = NAMED_COLORS[hex.toLowerCase()];
  if (named) return parseColor(named, context);

  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(`${hex[1]}${hex[1]}`, 16),
      g: parseInt(`${hex[2]}${hex[2]}`, 16),
      b: parseInt(`${hex[3]}${hex[3]}`, 16),
      a: 255
    };
  }

  if (/^#[0-9a-fA-F]{4}$/.test(hex)) {
    return {
      r: parseInt(`${hex[1]}${hex[1]}`, 16),
      g: parseInt(`${hex[2]}${hex[2]}`, 16),
      b: parseInt(`${hex[3]}${hex[3]}`, 16),
      a: parseInt(`${hex[4]}${hex[4]}`, 16)
    };
  }

  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
      a: hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255
    };
  }

  const rgb = parseRgbColor(hex);
  if (rgb) return rgb;

  const hsl = parseHslColor(hex);
  if (hsl) return hsl;

  throw new Error(`Unsupported color format: ${value}`);
}

function parseRgbColor(value: string): Rgba | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) return null;
  const parts = match[1].replace(/\//g, " ").split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channels = parts.slice(0, 3).map(parseRgbChannel);
  if (channels.some((channel) => channel === null)) return null;
  const alpha = parts[3] === undefined ? 255 : parseAlpha(parts[3]);
  if (alpha === null) return null;
  return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0, a: alpha };
}

function parseRgbChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? clamp(Math.round((percent / 100) * 255), 0, 255) : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(Math.round(parsed), 0, 255) : null;
}

function parseAlpha(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? clamp(Math.round((percent / 100) * 255), 0, 255) : null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.round((parsed <= 1 ? parsed * 255 : parsed)), 0, 255);
}

function parseHslColor(value: string): Rgba | null {
  const match = /^hsla?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) return null;
  const parts = hslColorParts(match[1]);
  if (!parts) return null;
  const hue = parseHue(parts[0]);
  const saturation = parsePercentage(parts[1]);
  const lightness = parsePercentage(parts[2]);
  if (hue === null || saturation === null || lightness === null) return null;
  const alpha = parts[3] === undefined ? 255 : parseAlpha(parts[3]);
  if (alpha === null) return null;
  return hslToRgb({ h: hue / 360, s: saturation, l: lightness, a: alpha });
}

function hslColorParts(body: string): string[] | null {
  if (body.includes(",")) {
    const parts = body.split(",").map((part) => part.trim()).filter(Boolean);
    return parts.length === 3 || parts.length === 4 ? parts : null;
  }
  const slashParts = body.split("/");
  if (slashParts.length > 2) return null;
  const colorParts = slashParts[0]?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (colorParts.length !== 3) return null;
  const alpha = slashParts[1]?.trim();
  return alpha ? [...colorParts, alpha] : colorParts;
}

function parseHue(value: string): number | null {
  const text = value.trim().toLowerCase();
  const units: Array<[string, number]> = [
    ["deg", 1],
    ["turn", 360],
    ["rad", 180 / Math.PI],
    ["grad", 0.9]
  ];
  for (const [unit, multiplier] of units) {
    if (!text.endsWith(unit)) continue;
    const parsed = Number(text.slice(0, -unit.length));
    return Number.isFinite(parsed) ? normalizeHue(parsed * multiplier) : null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? normalizeHue(parsed) : null;
}

function parsePercentage(value: string): number | null {
  const text = value.trim();
  if (!text.endsWith("%")) return null;
  const parsed = Number(text.slice(0, -1));
  return Number.isFinite(parsed) ? clamp(parsed / 100, 0, 1) : null;
}

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  navy: "#000080",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  purple: "#800080",
  olive: "#808000",
  lime: "#00ff00",
  teal: "#008080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  brown: "#a52a2a"
};
