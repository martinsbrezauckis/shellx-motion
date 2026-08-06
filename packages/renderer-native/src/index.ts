import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  assertLocalMotionFrameBudget,
  assertReadableMotionKeyframes,
  evaluateMotionProceduralLayers,
  hashFile,
  hashPackageFile,
  loadMotionPackage,
  matchRendererCapability,
  NATIVE_CAPABILITY,
  previewReceiptStatus,
  resolveEasing,
  resolvePackageAsset,
  type MotionLayer,
  type MotionTransition,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import {
  decodeNativePngRgba,
  encodePng,
  hashBuffer,
  INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
  MAX_PNG_COMPRESSION_LEVEL,
  type NativeImage
} from "./native-png";
// The lane's whole "font" plus its coverage classifiers (the text-delivery invariant extraction).
import { caseFoldedCharacters, fallbackGlyphCharacters, glyphRows } from "./native-glyphs";
import {
  nativeTextDeliveryIssues,
  nativeTextDeliveryMessage,
  requestedFontFamily,
  type NativeTextDeliveryIssue
} from "./text-delivery-gate";

// Re-export the single-source native capability (owned by @shellx-motion/core) so existing
// consumers can keep importing it from this package. The runtime gate below consumes it directly.
export { NATIVE_CAPABILITY } from "@shellx-motion/core";
// Re-export the PNG deflate-level constants (public API) from their new codec home so external
// consumers can keep importing them from this package entry point after the module-size extraction.
export { INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL, MAX_PNG_COMPRESSION_LEVEL } from "./native-png";
// Delivery-target text gate (the text-delivery invariant) — exported so callers can pre-flight a lane choice without
// opening a session, and so the CLI/tests can assert on the exact issue set.
export { nativeTextDeliveryIssues, nativeTextDeliveryMessage, type NativeTextDeliveryIssue } from "./text-delivery-gate";
export { caseFoldedCharacters, fallbackGlyphCharacters, nativeGlyphRepertoire } from "./native-glyphs";

export interface NativePreviewFrameInput {
  packageRoot: string;
  outputPath?: string;
  outputRoots?: string[];
  atMs?: number;
  now?: () => string;
}

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
  /** package-relative asset ref -> sha256; each asset content-hashed at most once per session. */
  assetHashCache: Map<string, string>;
  /** zlib deflate level applied to every frame PNG this session encodes. */
  pngCompressionLevel: number;
  /**
   * Delivery-target text refusals, computed once at session open. Empty for preview sessions and for
   * delivery sessions whose text the block-glyph set draws faithfully (the text-delivery invariant).
   */
  textDeliveryIssues: NativeTextDeliveryIssue[];
}

/**
 * Open a native render session for `packageRoot`. Loads and structurally hashes the package once (and
 * asserts its canvas fits the local frame budget); image assets are decoded lazily and cached on first
 * use. See {@link NativeRenderSession} for the snapshot/mutation-safety contract. Single-frame callers
 * can use {@link renderNativePreviewFrame} instead; multi-frame callers (final-render / image-sequence
 * loops) should open one session and render N frames to realize the load-once win.
 */
export async function createNativeRenderSession(input: CreateNativeRenderSessionInput): Promise<NativeRenderSession> {
  const pkg = await loadMotionPackage(input.packageRoot);
  assertLocalMotionFrameBudget({ width: pkg.motion.width, height: pkg.motion.height });
  // Same gate the browser lane applies at session open: a document whose keyframes the evaluator
  // cannot read renders motionless and reports success, so it is refused before any frame is drawn.
  assertReadableMotionKeyframes(pkg.motion);
  const capability = matchRendererCapability(pkg.motion, NATIVE_CAPABILITY);
  // Structural evidence hashed once at session open; reused for every frame's receipt (and for the
  // failure receipts, where no image assets are or can be decoded). Uses the package-reader hash, as
  // the per-frame path did, so values are identical for unmutated inputs.
  const structuralHashes = new Map<string, string>();
  structuralHashes.set("manifest.json", await hashPackageFile(resolve(pkg.root, "manifest.json")));
  structuralHashes.set(pkg.manifest.motion, await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)));
  const state: NativeRenderSessionState = {
    pkg,
    outputRoots: input.outputRoots ?? [],
    now: input.now ?? (() => new Date().toISOString()),
    capability,
    structuralHashes,
    imageCache: new Map(),
    assetHashCache: new Map(),
    pngCompressionLevel: input.pngCompressionLevel ?? MAX_PNG_COMPRESSION_LEVEL,
    textDeliveryIssues: input.renderTarget === "delivery" ? nativeTextDeliveryIssues(pkg.motion) : []
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
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, png);
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

/**
 * Render a single native preview frame. Thin wrapper over {@link createNativeRenderSession}: it opens a
 * session, renders one frame, and closes it, so every single-frame caller (preview, still-frame and
 * one-off render commands, connectors) keeps an unchanged public contract — identical frame bytes and
 * byte-identical receipts. Multi-frame callers should open one session via {@link createNativeRenderSession}
 * and render N frames to get the load-once benefit.
 */
export async function renderNativePreviewFrame(input: NativePreviewFrameInput): Promise<NativePreviewFrameResult> {
  const session = await createNativeRenderSession({
    packageRoot: input.packageRoot,
    ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}),
    ...(input.now ? { now: input.now } : {})
  });
  try {
    return await session.renderFrameAtMs(input.atMs ?? 0, input.outputPath);
  } finally {
    session.close();
  }
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
 * actual pixels. Asset content hashes use the TOCTOU-hardened `hashFile` receipts helper
 * (symlinks and mid-read mutation are rejected) and are computed at most once per asset per session,
 * then reused — identical values to the per-frame path's re-hash for unmutated inputs.
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
    let assetHash = state.assetHashCache.get(assetRef);
    if (assetHash === undefined) {
      assetHash = await hashFile(resolvePackageAsset(state.pkg, assetRef));
      state.assetHashCache.set(assetRef, assetHash);
    }
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
      state.imageCache.set(assetRef, decodeNativePngRgba(await readFile(resolvePackageAsset(state.pkg, assetRef))));
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
  if (layer.type === "text" || layer.type === "caption") drawTextLayer(canvas, layer, pkg, atMs);
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

interface NativeColorEffects {
  brightness: number;
  contrast: number;
  saturate: number;
  grayscale: number;
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

type NativeBlendMode =
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "plus-lighter";

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
  const lines = layoutTextLines(text, null, glyphWidth, spacing);
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
  return {
    x: box.x + ((box.width - sourceRect.width) / 2),
    y: box.y + ((box.height - sourceRect.height) / 2),
    width: sourceRect.width,
    height: sourceRect.height
  };
}

function drawShapeLayer(canvas: RgbaCanvas, layer: MotionLayer, pkg: MotionPackage, atMs: number): void {
  const transform = readTransform(layer);
  const style = readRecord(layer.style);
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

function drawTextLayer(canvas: RgbaCanvas, layer: MotionLayer, pkg: MotionPackage, atMs: number): void {
  const text = readString(layer.text) ?? "";
  if (text.length === 0) return;

  const transform = readTransform(layer);
  const style = readRecord(layer.style);
  const fontSize = readNumber(style.fontSize) ?? 32;
  const baseTextColor = parseColor(resolveTokenString(readString(style.color) ?? readString(layer.color) ?? "#111827", pkg));
  const color = applyLayerOpacity(baseTextColor, layer);
  const pixelSize = Math.max(1, Math.round((fontSize * transform.scale) / 7));
  const glyphWidth = pixelSize * 5;
  const glyphHeight = pixelSize * 7;
  const spacing = Math.max(1, Math.round(pixelSize * 0.8)) + letterSpacingPixels(style.letterSpacing, transform.scale);
  const fontWeightExtra = fontWeightExtraPixels(style.fontWeight, pixelSize);
  const lineHeight = lineHeightPixels(style.lineHeight, fontSize, transform.scale, glyphHeight);
  const baseLineWidth = textBoxBaseWidth(layer, style, transform);
  const maxLineWidth = textBoxWidthPixels(layer, style, transform);
  const textAlign = nativeTextAlign(style.textAlign);
  const baseBoxHeight = textBoxBaseHeight(layer, style, transform);
  const maxBoxHeight = textBoxHeightPixels(layer, style, transform);
  const verticalAlign = nativeVerticalAlign(style.verticalAlign ?? style.alignY);
  const padding = textBoxPaddingPixels(style, transform.scale);
  const border = textBoxBorder(style, transform.scale);
  const shadow = textShadow(style, pkg, transform.scale, layer, baseTextColor);
  const contentLineWidth = insetDimension(maxLineWidth, (border.width * 2) + padding.left + padding.right);
  const contentBoxHeight = insetDimension(maxBoxHeight, (border.width * 2) + padding.top + padding.bottom);
  const lines = layoutTextLines(text, contentLineWidth, glyphWidth, spacing);
  const visualBox = textVisualBox(transform, baseLineWidth, baseBoxHeight, maxLineWidth, maxBoxHeight, lines, glyphWidth, spacing, lineHeight, glyphHeight, border, padding);
  const contentX = visualBox.x + border.width + padding.left;
  const contentY = visualBox.y + border.width + padding.top;
  const mask = layerPaintClip(layer, visualBox, transform.scale, atMs);

  canvas.withClip(mask, () => {
    drawTextBoxDecoration(canvas, layer, pkg, style, transform, visualBox, maxLineWidth, maxBoxHeight, border, baseTextColor);
    const startY = alignedTextStartY(contentY, lines.length, contentBoxHeight, lineHeight, glyphHeight, verticalAlign);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      let cursorX = alignedTextStartX(contentX, lines[lineIndex], contentLineWidth, glyphWidth, spacing, textAlign);
      const cursorY = startY + lineIndex * lineHeight;
      if (shadow) {
        drawTextLineShadow(canvas, lines[lineIndex], cursorX, cursorY, pixelSize, glyphWidth, spacing, fontWeightExtra, shadow);
      }
      drawTextLineGlyphs(canvas, lines[lineIndex], cursorX, cursorY, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    }
  });
}

interface NativeTextShadow {
  x: number;
  y: number;
  blur: number;
  color: Rgba;
}

function textShadow(style: Record<string, unknown>, pkg: MotionPackage, scale: number, layer: MotionLayer, currentColor: Rgba): NativeTextShadow | null {
  const shadow = readRecord(style.textShadow ?? style.shadow);
  if (Object.keys(shadow).length === 0) return null;
  const color = applyLayerOpacity(parseColor(resolveTokenString(readString(shadow.color) ?? "rgba(0,0,0,0.35)", pkg), { currentColor }), layer);
  if (color.a <= 0) return null;
  return {
    x: shadowLengthPixels(shadow, ["x", "offsetX"], scale),
    y: shadowLengthPixels(shadow, ["y", "offsetY"], scale),
    blur: Math.max(0, shadowLengthPixels(shadow, ["blur", "blurRadius"], scale)),
    color
  };
}

function drawTextBoxDecoration(
  canvas: RgbaCanvas,
  layer: MotionLayer,
  pkg: MotionPackage,
  style: Record<string, unknown>,
  transform: ReturnType<typeof readTransform>,
  box: NativeClip,
  width: number | null,
  height: number | null,
  border: { color: string | null; width: number },
  currentColor: Rgba
): void {
  if (width === null || height === null) return;
  const radius = textBoxRadiusPixels(style, transform.scale, width, height);
  const background = readString(style.backgroundColor) ?? readString(style.background);
  if (background) {
    canvas.fillRoundedRect(box.x, box.y, width, height, radius, applyLayerOpacity(parseColor(resolveTokenString(background, pkg), { currentColor }), layer));
  }
  if (border.color && border.width > 0) {
    canvas.strokeRoundedRect(box.x, box.y, width, height, border.width, radius, applyLayerOpacity(parseColor(resolveTokenString(border.color, pkg), { currentColor }), layer));
  }
}

function insetDimension(value: number | null, inset: number): number | null {
  return value === null ? null : Math.max(0, value - inset);
}

function textBoxPaddingPixels(style: Record<string, unknown>, scale: number): { top: number; right: number; bottom: number; left: number } {
  const all = readCssPixelValue(style.padding) ?? 0;
  const horizontal = readCssPixelValue(style.paddingX) ?? all;
  const vertical = readCssPixelValue(style.paddingY) ?? all;
  return {
    top: Math.max(0, (readCssPixelValue(style.paddingTop) ?? vertical) * scale),
    right: Math.max(0, (readCssPixelValue(style.paddingRight) ?? horizontal) * scale),
    bottom: Math.max(0, (readCssPixelValue(style.paddingBottom) ?? vertical) * scale),
    left: Math.max(0, (readCssPixelValue(style.paddingLeft) ?? horizontal) * scale)
  };
}

function textBoxBorder(style: Record<string, unknown>, scale: number): { color: string | null; width: number } {
  const color = readString(style.borderColor) ?? readString(style.stroke);
  const widthFallback = color ? readCssPixelValue(style.width) ?? 0 : 0;
  const width = readCssPixelValue(style.borderWidth) ?? readCssPixelValue(style.strokeWidth) ?? widthFallback;
  return { color, width: Math.max(0, width * scale) };
}

function textBoxRadiusPixels(style: Record<string, unknown>, scale: number, width: number, height: number): number {
  const radius = readCssPixelValue(style.borderRadius) ?? readCssPixelValue(style.radius) ?? 0;
  return Math.max(0, Math.min((radius * scale), width / 2, height / 2));
}

type NativeTextAlign = "left" | "center" | "right";
type NativeVerticalAlign = "top" | "middle" | "bottom";

function nativeTextAlign(value: unknown): NativeTextAlign {
  const align = readString(value)?.trim().toLowerCase();
  if (align === "center" || align === "right") return align;
  return "left";
}

function nativeVerticalAlign(value: unknown): NativeVerticalAlign {
  const align = readString(value)?.trim().toLowerCase();
  if (align === "bottom") return "bottom";
  if (align === "middle" || align === "center") return "middle";
  return "top";
}

function alignedTextStartX(
  x: number,
  line: string,
  maxLineWidth: number | null,
  glyphWidth: number,
  spacing: number,
  textAlign: NativeTextAlign
): number {
  if (maxLineWidth === null || textAlign === "left") return x;
  const lineWidth = measureNativeText(line, glyphWidth, spacing);
  const remaining = Math.max(0, maxLineWidth - lineWidth);
  if (textAlign === "right") return x + remaining;
  return x + remaining / 2;
}

function alignedTextStartY(
  y: number,
  lineCount: number,
  maxBoxHeight: number | null,
  lineHeight: number,
  glyphHeight: number,
  verticalAlign: NativeVerticalAlign
): number {
  if (maxBoxHeight === null || verticalAlign === "top") return y;
  const textHeight = lineCount <= 1 ? glyphHeight : ((lineCount - 1) * lineHeight) + glyphHeight;
  const remaining = Math.max(0, maxBoxHeight - textHeight);
  if (verticalAlign === "bottom") return y + remaining;
  return y + remaining / 2;
}

function textBoxWidthPixels(layer: MotionLayer, style: Record<string, unknown>, transform: ReturnType<typeof readTransform>): number | null {
  const value = textBoxBaseWidth(layer, style, transform);
  return value === null ? null : value * transform.scale;
}

function textBoxHeightPixels(layer: MotionLayer, style: Record<string, unknown>, transform: ReturnType<typeof readTransform>): number | null {
  const value = textBoxBaseHeight(layer, style, transform);
  return value === null ? null : value * transform.scale;
}

function textBoxBaseWidth(layer: MotionLayer, style: Record<string, unknown>, transform: ReturnType<typeof readTransform>): number | null {
  const value = transform.width ?? readCssPixelValue(layer.width) ?? readCssPixelValue(style.width);
  return value !== null && value > 0 ? value : null;
}

function textBoxBaseHeight(layer: MotionLayer, style: Record<string, unknown>, transform: ReturnType<typeof readTransform>): number | null {
  const value = transform.height ?? readCssPixelValue(layer.height) ?? readCssPixelValue(style.height);
  return value !== null && value > 0 ? value : null;
}

function textVisualBox(
  transform: ReturnType<typeof readTransform>,
  baseWidth: number | null,
  baseHeight: number | null,
  width: number | null,
  height: number | null,
  lines: string[],
  glyphWidth: number,
  spacing: number,
  lineHeight: number,
  glyphHeight: number,
  border: { width: number },
  padding: { top: number; right: number; bottom: number; left: number }
): NativeClip {
  const naturalTextWidth = lines.reduce((max, line) => Math.max(max, measureNativeText(line, glyphWidth, spacing)), 0);
  const naturalTextHeight = lines.length <= 1 ? glyphHeight : ((lines.length - 1) * lineHeight) + glyphHeight;
  const scaledWidth = width ?? naturalTextWidth + (border.width * 2) + padding.left + padding.right;
  const scaledHeight = height ?? naturalTextHeight + (border.width * 2) + padding.top + padding.bottom;
  const baseVisualWidth = baseWidth ?? scaledDimensionBase(scaledWidth, transform.scale);
  const baseVisualHeight = baseHeight ?? scaledDimensionBase(scaledHeight, transform.scale);
  const box = scaleBoxAroundOrigin(transform.x, transform.y, baseVisualWidth, baseVisualHeight, transform.scale, transform.originX, transform.originY);
  return {
    x: box.x,
    y: box.y,
    width: scaledWidth,
    height: scaledHeight
  };
}

function scaledDimensionBase(value: number, scale: number): number {
  return scale === 0 ? 0 : value / scale;
}

interface NativeClip {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
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

function layoutTextLines(text: string, maxLineWidth: number | null, glyphWidth: number, spacing: number): string[] {
  const hardLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (maxLineWidth === null) return hardLines;
  return hardLines.flatMap((line) => wrapTextLine(line, maxLineWidth, glyphWidth, spacing));
}

function wrapTextLine(line: string, maxLineWidth: number, glyphWidth: number, spacing: number): string[] {
  const words = line.split(/[ \t]+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      const wrapped = wrapLongWord(word, maxLineWidth, glyphWidth, spacing);
      lines.push(...wrapped.slice(0, -1));
      current = wrapped.at(-1) ?? "";
      continue;
    }

    const candidate = `${current} ${word}`;
    if (measureNativeText(candidate, glyphWidth, spacing) <= maxLineWidth) {
      current = candidate;
      continue;
    }

    lines.push(current);
    const wrapped = wrapLongWord(word, maxLineWidth, glyphWidth, spacing);
    lines.push(...wrapped.slice(0, -1));
    current = wrapped.at(-1) ?? "";
  }
  if (current) lines.push(current);
  return lines;
}

function wrapLongWord(word: string, maxLineWidth: number, glyphWidth: number, spacing: number): string[] {
  if (measureNativeText(word, glyphWidth, spacing) <= maxLineWidth) return [word];
  const lines: string[] = [];
  let current = "";
  for (const char of word) {
    const candidate = `${current}${char}`;
    if (current && measureNativeText(candidate, glyphWidth, spacing) > maxLineWidth) {
      lines.push(current);
      current = char;
      continue;
    }
    current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

function measureNativeText(text: string, glyphWidth: number, spacing: number): number {
  let width = 0;
  for (const char of text) {
    if (char === "\t") {
      width += (glyphWidth + spacing) * 4;
      continue;
    }
    width += glyphWidth + spacing;
  }
  return width === 0 ? 0 : width - spacing;
}

function lineHeightPixels(value: unknown, fontSize: number, scale: number, glyphHeight: number): number {
  const numeric = readNumber(value);
  if (numeric !== null) return normalizedLineHeightPixels(numeric, fontSize, scale, glyphHeight);

  const text = readString(value)?.trim();
  if (!text) return normalizedLineHeightPixels(1.15, fontSize, scale, glyphHeight);
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    if (Number.isFinite(percent)) return normalizedLineHeightPixels(percent / 100, fontSize, scale, glyphHeight);
  }
  if (text.endsWith("px")) {
    const px = Number(text.slice(0, -2));
    if (Number.isFinite(px)) return normalizedLineHeightPixels(px, fontSize, scale, glyphHeight);
  }
  const parsed = Number(text);
  return Number.isFinite(parsed)
    ? normalizedLineHeightPixels(parsed, fontSize, scale, glyphHeight)
    : normalizedLineHeightPixels(1.15, fontSize, scale, glyphHeight);
}

function letterSpacingPixels(value: unknown, scale: number): number {
  return (readCssPixelValue(value) ?? 0) * scale;
}

function normalizedLineHeightPixels(value: number, fontSize: number, scale: number, glyphHeight: number): number {
  const cssPixels = value <= 4 ? fontSize * value : value;
  return Math.max(glyphHeight + 1, Math.round(cssPixels * scale));
}

function fontWeightExtraPixels(value: unknown, pixelSize: number): number {
  const weight = normalizedFontWeight(value);
  if (weight >= 800) return Math.max(1, Math.round(pixelSize * 1.25));
  if (weight >= 700) return Math.max(1, Math.round(pixelSize * 0.8));
  if (weight >= 600) return Math.max(1, Math.round(pixelSize * 0.4));
  return 0;
}

function normalizedFontWeight(value: unknown): number {
  const numeric = readNumber(value);
  if (numeric !== null) return numeric;
  const text = readString(value)?.trim().toLowerCase();
  if (!text || text === "normal") return 400;
  if (text === "bold" || text === "bolder") return 700;
  if (text === "lighter") return 300;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 400;
}

function drawTextLineShadow(
  canvas: RgbaCanvas,
  line: string,
  x: number,
  y: number,
  pixelSize: number,
  glyphWidth: number,
  spacing: number,
  fontWeightExtra: number,
  shadow: NativeTextShadow
): void {
  drawTextLineGlyphs(canvas, line, x + shadow.x, y + shadow.y, pixelSize, glyphWidth, spacing, fontWeightExtra, shadow.color);
  if (shadow.blur <= 0) return;

  const steps = Math.min(12, Math.max(1, Math.ceil(shadow.blur)));
  for (let step = steps; step >= 1; step -= 1) {
    const alpha = Math.round(shadow.color.a * ((steps - step + 1) / (steps + 1)) * 0.25);
    if (alpha <= 0) continue;
    const expansion = (shadow.blur * step) / steps;
    const color = { ...shadow.color, a: alpha };
    drawTextLineGlyphs(canvas, line, x + shadow.x - expansion, y + shadow.y, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    drawTextLineGlyphs(canvas, line, x + shadow.x + expansion, y + shadow.y, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    drawTextLineGlyphs(canvas, line, x + shadow.x, y + shadow.y - expansion, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    drawTextLineGlyphs(canvas, line, x + shadow.x, y + shadow.y + expansion, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
  }
}

function drawTextLineGlyphs(
  canvas: RgbaCanvas,
  line: string,
  x: number,
  y: number,
  pixelSize: number,
  glyphWidth: number,
  spacing: number,
  fontWeightExtra: number,
  color: Rgba
): void {
  let cursorX = x;
  for (const char of line) {
    if (char === " ") {
      cursorX += glyphWidth + spacing;
      continue;
    }
    if (char === "\t") {
      cursorX += (glyphWidth + spacing) * 4;
      continue;
    }
    drawGlyph(canvas, char, cursorX, y, pixelSize, fontWeightExtra, color);
    cursorX += glyphWidth + spacing;
  }
}

function drawGlyph(canvas: RgbaCanvas, char: string, x: number, y: number, pixelSize: number, fontWeightExtra: number, color: Rgba): void {
  const rows = glyphRows(char);
  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < rows[row].length; col += 1) {
      if (rows[row][col] === "1") {
        canvas.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize + fontWeightExtra, pixelSize, color);
      }
    }
  }
}

/**
 * Per-layer warnings for text the native block-glyph lane cannot draw faithfully.
 *
 * the text-delivery invariant: the lane used to case-fold lowercase text with NO signal at all ("Sveiks" was drawn
 * "SVEIKS"), which is exactly the silent lowering the product forbids. Every unfaithful property is
 * now named per layer, and because these land in the receipt's `warnings` the preview receipt drops
 * to `warning` status. Delivery renders do not warn — they refuse (see `./text-delivery-gate`).
 */
function nativeTextLayerWarnings(layer: MotionLayer): string[] {
  const text = readString(layer.text) ?? "";
  const warnings: string[] = [];
  const caseFolded = caseFoldedCharacters(text);
  if (caseFolded.length > 0) {
    warnings.push(`Native renderer case-folded lowercase text to uppercase block glyphs on layer ${layer.id}: ${caseFolded.join("")}.`);
  }
  const fallbackChars = fallbackGlyphCharacters(text);
  if (fallbackChars.length > 0) {
    warnings.push(`Native renderer used fallback block glyphs for unsupported text characters on layer ${layer.id}: ${fallbackChars.join("")}.`);
  }
  const fontFamily = requestedFontFamily(layer);
  if (fontFamily) {
    warnings.push(`Native renderer ignored the requested font family '${fontFamily}' on layer ${layer.id} and drew block glyphs instead.`);
  }
  return warnings;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

class RgbaCanvas {
  readonly data: Buffer;
  private readonly clipStack: NativeClip[] = [];

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = Buffer.alloc(width * height * 4);
  }

  fill(color: Rgba): void {
    this.fillRect(0, 0, this.width, this.height, color);
  }

  composite(source: RgbaCanvas, blendMode: NativeBlendMode | null = null): void {
    for (let sy = 0; sy < source.height; sy += 1) {
      for (let sx = 0; sx < source.width; sx += 1) {
        const sourceOffset = (sy * source.width + sx) * 4;
        const alpha = source.data[sourceOffset + 3];
        if (alpha <= 0) continue;
        this.compositePixel(sx, sy, {
          r: source.data[sourceOffset],
          g: source.data[sourceOffset + 1],
          b: source.data[sourceOffset + 2],
          a: alpha
        }, blendMode);
      }
    }
  }

  compositeRotated(source: RgbaCanvas, anchorX: number, anchorY: number, rotationDegrees: number, blendMode: NativeBlendMode | null = null): void {
    const radians = (rotationDegrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    for (let sy = 0; sy < source.height; sy += 1) {
      for (let sx = 0; sx < source.width; sx += 1) {
        const sourceOffset = (sy * source.width + sx) * 4;
        const alpha = source.data[sourceOffset + 3];
        if (alpha <= 0) continue;
        const dx = sx + 0.5 - anchorX;
        const dy = sy + 0.5 - anchorY;
        const targetX = Math.round(anchorX + (dx * cos) - (dy * sin) - 0.5);
        const targetY = Math.round(anchorY + (dx * sin) + (dy * cos) - 0.5);
        if (targetX < 0 || targetY < 0 || targetX >= this.width || targetY >= this.height) continue;
        this.compositePixel(targetX, targetY, {
          r: source.data[sourceOffset],
          g: source.data[sourceOffset + 1],
          b: source.data[sourceOffset + 2],
          a: alpha
        }, blendMode);
      }
    }
  }

  withClip(clip: NativeClip | null, paint: () => void): void {
    if (!clip) {
      paint();
      return;
    }
    const normalized = normalizeClip(clip);
    const bounded = intersectClips(this.currentClipBounds(), normalized);
    if (bounded.width <= 0 || bounded.height <= 0) return;
    this.clipStack.push(normalized);
    try {
      paint();
    } finally {
      this.clipStack.pop();
    }
  }

  fillRect(x: number, y: number, width: number, height: number, color: Rgba): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        this.setPixel(px, py, color);
      }
    }
  }

  strokeRect(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    this.fillRect(x, y, width, size, color);
    this.fillRect(x, y + height - size, width, size, color);
    this.fillRect(x, y, size, height, color);
    this.fillRect(x + width - size, y, size, height, color);
  }

  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number, color: Rgba): void {
    if (radius <= 0) {
      this.fillRect(x, y, width, height, color);
      return;
    }
    this.paintRoundedRect(x, y, width, height, radius, color, () => true);
  }

  strokeRoundedRect(x: number, y: number, width: number, height: number, strokeWidth: number, radius: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width / 2, height / 2));
    if (size <= 0) return;
    if (radius <= 0) {
      this.strokeRect(x, y, width, height, size, color);
      return;
    }
    const innerX = x + size;
    const innerY = y + size;
    const innerWidth = Math.max(0, width - size * 2);
    const innerHeight = Math.max(0, height - size * 2);
    const innerRadius = Math.max(0, radius - size);
    this.paintRoundedRect(x, y, width, height, radius, color, (px, py) => {
      return !roundedRectContains(px, py, innerX, innerY, innerWidth, innerHeight, innerRadius);
    });
  }

  fillEllipse(x: number, y: number, width: number, height: number, color: Rgba): void {
    this.paintEllipse(x, y, width, height, color, () => true);
  }

  strokeEllipse(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width / 2, height / 2));
    if (size <= 0) return;
    const innerX = x + size;
    const innerY = y + size;
    const innerWidth = Math.max(0, width - size * 2);
    const innerHeight = Math.max(0, height - size * 2);
    this.paintEllipse(x, y, width, height, color, (px, py) => {
      return !ellipseContains(px, py, innerX, innerY, innerWidth, innerHeight);
    });
  }

  fillTriangle(x: number, y: number, width: number, height: number, color: Rgba): void {
    this.paintTriangle(x, y, width, height, color, () => true);
  }

  strokeTriangle(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    const points = trianglePoints(x, y, width, height);
    this.paintTriangle(x, y, width, height, color, (px, py) => triangleEdgeDistance(px, py, points) <= size);
  }

  fillStar(x: number, y: number, width: number, height: number, color: Rgba): void {
    this.paintStar(x, y, width, height, color, () => true);
  }

  strokeStar(x: number, y: number, width: number, height: number, strokeWidth: number, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    const points = starPoints(x, y, width, height);
    this.paintStar(x, y, width, height, color, (px, py) => polygonEdgeDistance(px, py, points) <= size);
  }

  fillPathShape(x: number, y: number, width: number, height: number, pathData: string, color: Rgba): void {
    const points = pathPolygonPoints(pathData, x, y, width, height);
    this.paintPolygon(x, y, width, height, points, color, () => true);
  }

  strokePathShape(x: number, y: number, width: number, height: number, strokeWidth: number, pathData: string, color: Rgba): void {
    const size = Math.max(0, Math.min(strokeWidth, width, height));
    if (size <= 0) return;
    const points = pathPolygonPoints(pathData, x, y, width, height);
    this.paintPolygon(x, y, width, height, points, color, (px, py) => polygonEdgeDistance(px, py, points) <= size);
  }

  drawImage(
    image: NativeImage,
    placement: NativeClip,
    opacity: number,
    roundedClip: { box: NativeClip; radius: number } | null = null,
    sourceRect: NativeClip = { x: 0, y: 0, width: image.width, height: image.height }
  ): void {
    if (placement.width <= 0 || placement.height <= 0 || opacity <= 0) return;
    const minX = Math.max(0, Math.floor(placement.x));
    const minY = Math.max(0, Math.floor(placement.y));
    const maxX = Math.min(this.width, Math.ceil(placement.x + placement.width));
    const maxY = Math.min(this.height, Math.ceil(placement.y + placement.height));
    for (let py = minY; py < maxY; py += 1) {
      const v = clamp((py + 0.5 - placement.y) / placement.height, 0, 1);
      const sourceY = clamp(Math.floor(sourceRect.y + (v * sourceRect.height)), 0, image.height - 1);
      for (let px = minX; px < maxX; px += 1) {
        if (roundedClip && !roundedRectContains(px + 0.5, py + 0.5, roundedClip.box.x, roundedClip.box.y, roundedClip.box.width, roundedClip.box.height, roundedClip.radius)) {
          continue;
        }
        const u = clamp((px + 0.5 - placement.x) / placement.width, 0, 1);
        const sourceX = clamp(Math.floor(sourceRect.x + (u * sourceRect.width)), 0, image.width - 1);
        const sourceOffset = (sourceY * image.width + sourceX) * 4;
        const alpha = Math.round(image.rgba[sourceOffset + 3] * opacity);
        if (alpha <= 0) continue;
        this.setPixel(px, py, {
          r: image.rgba[sourceOffset],
          g: image.rgba[sourceOffset + 1],
          b: image.rgba[sourceOffset + 2],
          a: alpha
        });
      }
    }
  }

  private paintEllipse(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (ellipseContains(sampleX, sampleY, x, y, width, height) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }

  private paintTriangle(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    const points = trianglePoints(x, y, width, height);
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (triangleContains(sampleX, sampleY, points) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }

  private paintStar(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    const points = starPoints(x, y, width, height);
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (polygonContains(sampleX, sampleY, points) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }

  private paintPolygon(
    x: number,
    y: number,
    width: number,
    height: number,
    points: PolygonPoint[],
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (polygonContains(sampleX, sampleY, points) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }

  private paintRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: Rgba,
    predicate: (px: number, py: number) => boolean
  ): void {
    const minX = Math.max(0, Math.round(x));
    const minY = Math.max(0, Math.round(y));
    const maxX = Math.min(this.width, Math.round(x + width));
    const maxY = Math.min(this.height, Math.round(y + height));
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        if (roundedRectContains(sampleX, sampleY, x, y, width, height, radius) && predicate(sampleX, sampleY)) {
          this.setPixel(px, py, color);
        }
      }
    }
  }

  private setPixel(x: number, y: number, color: Rgba): void {
    if (!this.clipStack.every((clip) => clipContains(clip, x, y))) return;
    const offset = (y * this.width + x) * 4;
    if (color.a === 255) {
      this.data[offset] = color.r;
      this.data[offset + 1] = color.g;
      this.data[offset + 2] = color.b;
      this.data[offset + 3] = color.a;
      return;
    }

    const sourceAlpha = color.a / 255;
    const targetAlpha = this.data[offset + 3] / 255;
    const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
    if (outAlpha === 0) {
      this.data[offset] = 0;
      this.data[offset + 1] = 0;
      this.data[offset + 2] = 0;
      this.data[offset + 3] = 0;
      return;
    }

    this.data[offset] = Math.round((color.r * sourceAlpha + this.data[offset] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    this.data[offset + 1] = Math.round((color.g * sourceAlpha + this.data[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    this.data[offset + 2] = Math.round((color.b * sourceAlpha + this.data[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    this.data[offset + 3] = Math.round(outAlpha * 255);
  }

  private compositePixel(x: number, y: number, source: Rgba, blendMode: NativeBlendMode | null): void {
    if (blendMode === null) {
      this.setPixel(x, y, source);
      return;
    }
    const offset = (y * this.width + x) * 4;
    const backdrop: Rgba = {
      r: this.data[offset],
      g: this.data[offset + 1],
      b: this.data[offset + 2],
      a: this.data[offset + 3]
    };
    if (backdrop.a <= 0) {
      this.setPixel(x, y, source);
      return;
    }
    this.setPixel(x, y, {
      ...blendRgb(blendMode, backdrop, source),
      a: source.a
    });
  }

  private currentClipBounds(): NativeClip | null {
    return this.clipStack.reduce<NativeClip | null>((bounds, clip) => intersectClips(bounds, clip), null);
  }
}

function blendRgb(mode: NativeBlendMode, backdrop: Rgba, source: Rgba): Rgba {
  if (mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity") {
    return blendHsl(mode, backdrop, source);
  }
  return {
    r: blendChannel(mode, backdrop.r, source.r),
    g: blendChannel(mode, backdrop.g, source.g),
    b: blendChannel(mode, backdrop.b, source.b),
    a: source.a
  };
}

function blendChannel(mode: NativeBlendMode, backdropChannel: number, sourceChannel: number): number {
  const backdrop = backdropChannel / 255;
  const source = sourceChannel / 255;
  let value: number;

  if (mode === "multiply") value = backdrop * source;
  else if (mode === "screen") value = backdrop + source - backdrop * source;
  else if (mode === "overlay") value = backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  else if (mode === "darken") value = Math.min(backdrop, source);
  else if (mode === "lighten") value = Math.max(backdrop, source);
  else if (mode === "color-dodge") value = backdrop <= 0 ? 0 : source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
  else if (mode === "color-burn") value = backdrop >= 1 ? 1 : source <= 0 ? 0 : 1 - Math.min(1, (1 - backdrop) / source);
  else if (mode === "hard-light") value = source <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  else if (mode === "soft-light") value = softLightChannel(backdrop, source);
  else if (mode === "difference") value = Math.abs(backdrop - source);
  else if (mode === "exclusion") value = backdrop + source - 2 * backdrop * source;
  else if (mode === "plus-lighter") value = Math.min(1, backdrop + source);
  else value = source;

  return clamp(Math.round(value * 255), 0, 255);
}

function softLightChannel(backdrop: number, source: number): number {
  if (source <= 0.5) return backdrop - (1 - 2 * source) * backdrop * (1 - backdrop);
  const d = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
  return backdrop + (2 * source - 1) * (d - backdrop);
}

function blendHsl(mode: NativeBlendMode, backdrop: Rgba, source: Rgba): Rgba {
  const backdropHsl = rgbToHsl(backdrop);
  const sourceHsl = rgbToHsl(source);
  if (mode === "hue") return hslToRgb({ h: sourceHsl.h, s: backdropHsl.s, l: backdropHsl.l, a: source.a });
  if (mode === "saturation") return hslToRgb({ h: backdropHsl.h, s: sourceHsl.s, l: backdropHsl.l, a: source.a });
  if (mode === "color") return hslToRgb({ h: sourceHsl.h, s: sourceHsl.s, l: backdropHsl.l, a: source.a });
  return hslToRgb({ h: backdropHsl.h, s: backdropHsl.s, l: sourceHsl.l, a: source.a });
}

function rgbToHsl(color: Rgba): { h: number; s: number; l: number; a: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, a: color.a };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l, a: color.a };
}

function hslToRgb(color: { h: number; s: number; l: number; a: number }): Rgba {
  if (color.s === 0) {
    const channel = clamp(Math.round(color.l * 255), 0, 255);
    return { r: channel, g: channel, b: channel, a: color.a };
  }
  const q = color.l < 0.5 ? color.l * (1 + color.s) : color.l + color.s - color.l * color.s;
  const p = 2 * color.l - q;
  return {
    r: clamp(Math.round(hueToRgb(p, q, color.h + 1 / 3) * 255), 0, 255),
    g: clamp(Math.round(hueToRgb(p, q, color.h) * 255), 0, 255),
    b: clamp(Math.round(hueToRgb(p, q, color.h - 1 / 3) * 255), 0, 255),
    a: color.a
  };
}

function hueToRgb(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

function blurCanvas(source: RgbaCanvas, radius: number): RgbaCanvas {
  const pixelRadius = Math.min(32, Math.max(1, Math.ceil(radius)));
  const premultiplied = new Float64Array(source.width * source.height * 4);
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const alpha = source.data[offset + 3] / 255;
    premultiplied[offset] = source.data[offset] * alpha;
    premultiplied[offset + 1] = source.data[offset + 1] * alpha;
    premultiplied[offset + 2] = source.data[offset + 2] * alpha;
    premultiplied[offset + 3] = source.data[offset + 3];
  }

  const horizontal = blurFloatRgba(premultiplied, source.width, source.height, pixelRadius, "horizontal");
  const vertical = blurFloatRgba(horizontal, source.width, source.height, pixelRadius, "vertical");
  const blurred = new RgbaCanvas(source.width, source.height);
  for (let offset = 0; offset < vertical.length; offset += 4) {
    const alpha = clamp(Math.round(vertical[offset + 3]), 0, 255);
    if (alpha <= 0) continue;
    const alphaRatio = alpha / 255;
    blurred.data[offset] = clamp(Math.round(vertical[offset] / alphaRatio), 0, 255);
    blurred.data[offset + 1] = clamp(Math.round(vertical[offset + 1] / alphaRatio), 0, 255);
    blurred.data[offset + 2] = clamp(Math.round(vertical[offset + 2] / alphaRatio), 0, 255);
    blurred.data[offset + 3] = alpha;
  }
  return blurred;
}

function applyColorEffects(source: RgbaCanvas, effects: NativeColorEffects): RgbaCanvas {
  const output = new RgbaCanvas(source.width, source.height);
  const grayscaleAmount = clamp(effects.grayscale, 0, 1);

  for (let offset = 0; offset < source.data.length; offset += 4) {
    const alpha = source.data[offset + 3];
    if (alpha <= 0) continue;

    let r = source.data[offset] * effects.brightness;
    let g = source.data[offset + 1] * effects.brightness;
    let b = source.data[offset + 2] * effects.brightness;

    r = (((r / 255) - 0.5) * effects.contrast + 0.5) * 255;
    g = (((g / 255) - 0.5) * effects.contrast + 0.5) * 255;
    b = (((b / 255) - 0.5) * effects.contrast + 0.5) * 255;

    const saturatedLuma = luminance(r, g, b);
    r = saturatedLuma + (r - saturatedLuma) * effects.saturate;
    g = saturatedLuma + (g - saturatedLuma) * effects.saturate;
    b = saturatedLuma + (b - saturatedLuma) * effects.saturate;

    if (grayscaleAmount > 0) {
      const grayscaleLuma = luminance(r, g, b);
      r += (grayscaleLuma - r) * grayscaleAmount;
      g += (grayscaleLuma - g) * grayscaleAmount;
      b += (grayscaleLuma - b) * grayscaleAmount;
    }

    output.data[offset] = clamp(Math.round(r), 0, 255);
    output.data[offset + 1] = clamp(Math.round(g), 0, 255);
    output.data[offset + 2] = clamp(Math.round(b), 0, 255);
    output.data[offset + 3] = alpha;
  }

  return output;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function blurFloatRgba(
  input: Float64Array,
  width: number,
  height: number,
  radius: number,
  direction: "horizontal" | "vertical"
): Float64Array {
  const output = new Float64Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = direction === "horizontal" ? Math.max(0, x - radius) : Math.max(0, y - radius);
      const to = direction === "horizontal" ? Math.min(width - 1, x + radius) : Math.min(height - 1, y + radius);
      const count = to - from + 1;
      const outputOffset = (y * width + x) * 4;
      for (let sample = from; sample <= to; sample += 1) {
        const sampleX = direction === "horizontal" ? sample : x;
        const sampleY = direction === "horizontal" ? y : sample;
        const sampleOffset = (sampleY * width + sampleX) * 4;
        output[outputOffset] += input[sampleOffset] / count;
        output[outputOffset + 1] += input[sampleOffset + 1] / count;
        output[outputOffset + 2] += input[sampleOffset + 2] / count;
        output[outputOffset + 3] += input[sampleOffset + 3] / count;
      }
    }
  }
  return output;
}

function normalizeClip(clip: NativeClip): NativeClip {
  return {
    x: Math.round(clip.x),
    y: Math.round(clip.y),
    width: Math.round(clip.width),
    height: Math.round(clip.height),
    ...(clip.radius !== undefined ? { radius: Math.max(0, clip.radius) } : {})
  };
}

function intersectClips(existing: NativeClip | null, next: NativeClip): NativeClip {
  if (!existing) return next;
  const x = Math.max(existing.x, next.x);
  const y = Math.max(existing.y, next.y);
  const right = Math.min(existing.x + existing.width, next.x + next.width);
  const bottom = Math.min(existing.y + existing.height, next.y + next.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
    ...(existing.radius !== undefined || next.radius !== undefined
      ? { radius: Math.max(existing.radius ?? 0, next.radius ?? 0) }
      : {})
  };
}

function clipContains(clip: NativeClip, x: number, y: number): boolean {
  if (clip.radius !== undefined && clip.radius > 0) {
    return roundedRectContains(x + 0.5, y + 0.5, clip.x, clip.y, clip.width, clip.height, clip.radius);
  }
  return x >= clip.x && y >= clip.y && x < clip.x + clip.width && y < clip.y + clip.height;
}

function roundedRectContains(px: number, py: number, x: number, y: number, width: number, height: number, radius: number): boolean {
  if (px < x || py < y || px >= x + width || py >= y + height || width <= 0 || height <= 0) return false;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r <= 0) return true;
  if (px >= x + r && px < x + width - r) return true;
  if (py >= y + r && py < y + height - r) return true;
  const cx = px < x + r ? x + r : x + width - r;
  const cy = py < y + r ? y + r : y + height - r;
  const dx = px - cx;
  const dy = py - cy;
  return (dx * dx) + (dy * dy) <= r * r;
}

function ellipseContains(px: number, py: number, x: number, y: number, width: number, height: number): boolean {
  if (px < x || py < y || px >= x + width || py >= y + height || width <= 0 || height <= 0) return false;
  const rx = width / 2;
  const ry = height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (px - (x + rx)) / rx;
  const dy = (py - (y + ry)) / ry;
  return (dx * dx) + (dy * dy) <= 1;
}

interface TrianglePoints {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}

function trianglePoints(x: number, y: number, width: number, height: number): TrianglePoints {
  return {
    ax: x + (width / 2),
    ay: y,
    bx: x,
    by: y + height,
    cx: x + width,
    cy: y + height
  };
}

function triangleContains(px: number, py: number, points: TrianglePoints): boolean {
  const d1 = triangleSign(px, py, points.ax, points.ay, points.bx, points.by);
  const d2 = triangleSign(px, py, points.bx, points.by, points.cx, points.cy);
  const d3 = triangleSign(px, py, points.cx, points.cy, points.ax, points.ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function triangleEdgeDistance(px: number, py: number, points: TrianglePoints): number {
  return Math.min(
    distanceToSegment(px, py, points.ax, points.ay, points.bx, points.by),
    distanceToSegment(px, py, points.bx, points.by, points.cx, points.cy),
    distanceToSegment(px, py, points.cx, points.cy, points.ax, points.ay)
  );
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  const nearestX = ax + (t * dx);
  const nearestY = ay + (t * dy);
  return Math.hypot(px - nearestX, py - nearestY);
}

interface PolygonPoint {
  x: number;
  y: number;
}

function starPoints(x: number, y: number, width: number, height: number): PolygonPoint[] {
  const centerX = x + (width / 2);
  const centerY = y + (height / 2);
  const outerRadiusX = width / 2;
  const outerRadiusY = height / 2;
  const innerRadiusX = outerRadiusX * 0.45;
  const innerRadiusY = outerRadiusY * 0.45;
  const points: PolygonPoint[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = (-Math.PI / 2) + (index * Math.PI / 5);
    const radiusX = index % 2 === 0 ? outerRadiusX : innerRadiusX;
    const radiusY = index % 2 === 0 ? outerRadiusY : innerRadiusY;
    points.push({
      x: centerX + (Math.cos(angle) * radiusX),
      y: centerY + (Math.sin(angle) * radiusY)
    });
  }
  return points;
}

function pathPolygonPoints(pathData: string, x: number, y: number, width: number, height: number): PolygonPoint[] {
  const localPoints = parsePathPolygon(pathData);
  if (localPoints.length < 3) throw new Error("Native path shapes require at least three path points.");
  const bounds = polygonBounds(localPoints);
  const minX = Math.min(0, bounds.minX);
  const minY = Math.min(0, bounds.minY);
  const sourceWidth = Math.max(1, Math.max(100, bounds.maxX) - minX);
  const sourceHeight = Math.max(1, Math.max(100, bounds.maxY) - minY);
  return localPoints.map((point) => ({
    x: x + ((point.x - minX) / sourceWidth) * width,
    y: y + ((point.y - minY) / sourceHeight) * height
  }));
}

function parsePathPolygon(pathData: string): PolygonPoint[] {
  const tokens = pathData.match(/[MLHVZmlhvz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const points: PolygonPoint[] = [];
  let index = 0;
  let command = "";
  let current: PolygonPoint = { x: 0, y: 0 };
  let start: PolygonPoint | null = null;

  while (index < tokens.length) {
    const token = tokens[index];
    if (isPathCommand(token)) {
      command = token;
      index += 1;
      if (command === "Z" || command === "z") {
        if (start && (current.x !== start.x || current.y !== start.y)) points.push({ ...start });
        current = start ? { ...start } : current;
      }
      continue;
    }
    if (!command) throw new Error("Native path shapes must start with a path command.");

    if (command === "M" || command === "m" || command === "L" || command === "l") {
      const xValue = readPathNumber(tokens[index]);
      const yValue = readPathNumber(tokens[index + 1]);
      index += 2;
      current = command === command.toLowerCase()
        ? { x: current.x + xValue, y: current.y + yValue }
        : { x: xValue, y: yValue };
      points.push({ ...current });
      if (!start) start = { ...current };
      if (command === "M") command = "L";
      if (command === "m") command = "l";
      continue;
    }

    if (command === "H" || command === "h") {
      const xValue = readPathNumber(tokens[index]);
      index += 1;
      current = command === "h" ? { x: current.x + xValue, y: current.y } : { x: xValue, y: current.y };
      points.push({ ...current });
      continue;
    }

    if (command === "V" || command === "v") {
      const yValue = readPathNumber(tokens[index]);
      index += 1;
      current = command === "v" ? { x: current.x, y: current.y + yValue } : { x: current.x, y: yValue };
      points.push({ ...current });
      continue;
    }

    throw new Error(`Native path shapes do not support path command ${command}.`);
  }

  const last = points.at(-1);
  if (start && last && last.x === start.x && last.y === start.y) points.pop();
  return points;
}

function isPathCommand(token: string): boolean {
  return /^[MLHVZmlhvz]$/.test(token);
}

function readPathNumber(token: string | undefined): number {
  if (token === undefined || isPathCommand(token)) throw new Error("Native path shapes contain an incomplete command.");
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error(`Native path shapes contain an invalid number: ${token}`);
  return value;
}

function polygonBounds(points: PolygonPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y)
  }), { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY });
}

function polygonContains(px: number, py: number, points: PolygonPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const currentPoint = points[current];
    const previousPoint = points[previous];
    if ((currentPoint.y > py) === (previousPoint.y > py)) continue;
    const intersectionX = ((previousPoint.x - currentPoint.x) * (py - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (px < intersectionX) inside = !inside;
  }
  return inside;
}

function polygonEdgeDistance(px: number, py: number, points: PolygonPoint[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    distance = Math.min(distance, distanceToSegment(px, py, current.x, current.y, next.x, next.y));
  }
  return distance;
}

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
