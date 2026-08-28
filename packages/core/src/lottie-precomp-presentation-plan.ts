import { parseBoundedLottieJson } from "./lottie-json";

const MAX_ASSETS = 64;
const MAX_LAYERS_PER_COMPOSITION = 128;
const MAX_PRECOMP_DEPTH = 4;
const MAX_PRECOMP_PRESENTATIONS = 64;
const MAX_TRANSFORM_KEYFRAMES = 16;
const MAX_INPUT_WORK = 4_096;
const FRAME_BOUND = 1_000_000;

export interface LottiePrecompPresentationDiagnostic {
  path: string;
  status: "exact" | "lossy" | "refused";
  code: string;
  message: string;
}

export interface LottiePrecompPresentationPlan {
  schema: "shellx-motion/lottie-precomp-presentation-plan@2";
  source: { width: number; height: number; frameRate: number; inFrame: number; outFrame: number };
  limits: { maxAssets: number; maxDepth: number; maxPresentations: number; maxTransformKeyframes: number; maxInputWork: number };
  presentations: Array<{
    id: string;
    parentId?: string;
    assetId: string;
    layerIndex: number;
    name: string;
    inFrame: number;
    outFrame: number;
    clipRect: { x: 0; y: 0; width: number; height: number };
    transforms: Array<{
      frame: number;
      atUs: number;
      x: number;
      y: number;
      originX: number;
      originY: number;
      scale: number;
      rotationDeg: number;
      matrix: [number, number, number, number, number, number];
      opacity: number;
    }>;
  }>;
}

export type LottiePrecompPresentationResult =
  | { status: "ok"; plan: LottiePrecompPresentationPlan; diagnostics: LottiePrecompPresentationDiagnostic[] }
  | { status: "refused"; diagnostics: LottiePrecompPresentationDiagnostic[] };

/**
 * Extracts the exact static/hold presentation boundary of transformed Lottie
 * precompositions. It is deliberately a future-lowering plan: it never edits
 * the source, calls a renderer, or changes today's importer output.
 */
export function planLottiePrecompPresentations(sourceText: string): LottiePrecompPresentationResult {
  try {
    const source = parseBoundedLottieJson(sourceText);
    const planner = new PresentationPlanner(source);
    return { status: "ok", plan: planner.plan(), diagnostics: planner.diagnostics };
  } catch (error) {
    return { status: "refused", diagnostics: [{
      path: "/",
      status: "refused",
      code: "lottie.precomp.presentation.refused",
      message: error instanceof Error ? error.message : "Lottie precomposition presentation plan is invalid."
    }] };
  }
}

class PresentationPlanner {
  readonly diagnostics: LottiePrecompPresentationDiagnostic[] = [];
  readonly assets = new Map<string, PrecompAsset>();
  readonly presentations: LottiePrecompPresentationPlan["presentations"] = [];
  readonly presentationIds = new Set<string>();
  work = 0;
  source!: LottiePrecompPresentationPlan["source"];

  constructor(private readonly document: Record<string, unknown>) {}

  plan(): LottiePrecompPresentationPlan {
    assertNoExecutableOrExtensionData(this.document, () => this.countWork());
    const layers = this.readDocument();
    this.indexAssets();
    this.visitLayers(layers, undefined, [], 0, "layers");
    return {
      schema: "shellx-motion/lottie-precomp-presentation-plan@2",
      source: this.source,
      limits: { maxAssets: MAX_ASSETS, maxDepth: MAX_PRECOMP_DEPTH, maxPresentations: MAX_PRECOMP_PRESENTATIONS, maxTransformKeyframes: MAX_TRANSFORM_KEYFRAMES, maxInputWork: MAX_INPUT_WORK },
      presentations: this.presentations
    };
  }

  private readDocument(): unknown[] {
    // These standard root records do not affect a precomposition's isolated
    // geometry. Keep them inert so this inspection leaf can coexist with the
    // established image/font handling rather than rejecting a valid source.
    exactKeys(this.document, ["v", "nm", "fr", "ip", "op", "w", "h", "layers", "assets", "fonts", "chars", "markers", "slots", "ddd"], ["v", "fr", "ip", "op", "w", "h", "layers"], "Lottie document");
    if (this.document.nm !== undefined && (typeof this.document.nm !== "string" || this.document.nm.length > 128)) {
      throw new Error("Lottie document nm must be a bounded string.");
    }
    // `ddd: 0` is standard 2D document metadata. It has no rendering effect
    // in this deliberately 2D lowering boundary; any 3D declaration is
    // refused before a lowering plan or receipt can be produced.
    if (this.document.ddd !== undefined && this.document.ddd !== 0) {
      throw new Error("Lottie document ddd must be 0 for 2D precomposition lowering.");
    }
    const width = positiveInteger(this.document.w, "Lottie w", 32_768);
    const height = positiveInteger(this.document.h, "Lottie h", 32_768);
    const frameRate = boundedNumber(this.document.fr, "Lottie fr", 0.001, 1_000);
    const inFrame = boundedNumber(this.document.ip, "Lottie ip", -FRAME_BOUND, FRAME_BOUND);
    const outFrame = boundedNumber(this.document.op, "Lottie op", -FRAME_BOUND, FRAME_BOUND);
    if (outFrame <= inFrame) throw new Error("Lottie composition requires op greater than ip.");
    const layers = boundedArray(this.document.layers, "Lottie layers", MAX_LAYERS_PER_COMPOSITION);
    this.source = { width, height, frameRate, inFrame, outFrame };
    return layers;
  }

  private indexAssets(): void {
    if (this.document.assets === undefined) return;
    const assets = boundedArray(this.document.assets, "Lottie assets", MAX_ASSETS);
    for (const [index, value] of assets.entries()) {
      const asset = record(value, `Lottie asset ${index}`);
      // Image assets and source-font records are already handled by the
      // established adapter staging path. Only an asset with a resolvable
      // `layers` array participates in this precomposition plan.
      if (asset.layers === undefined) continue;
      exactKeys(asset, ["id", "w", "h", "layers"], ["id", "w", "h", "layers"], `Lottie asset ${index}`);
      const id = identifier(asset.id, `Lottie asset ${index} id`);
      if (this.assets.has(id)) throw new Error(`Lottie precomposition asset id is duplicated: ${id}.`);
      this.assets.set(id, {
        id,
        width: positiveInteger(asset.w, `Lottie precomposition ${id} w`, 32_768),
        height: positiveInteger(asset.h, `Lottie precomposition ${id} h`, 32_768),
        layers: boundedArray(asset.layers, `Lottie precomposition ${id} layers`, MAX_LAYERS_PER_COMPOSITION)
      });
    }
  }

  private visitLayers(values: unknown[], parentId: string | undefined, ancestry: string[], depth: number, path: string): void {
    for (const [index, value] of values.entries()) {
      this.countWork();
      const layer = record(value, `Lottie ${path}[${index}]`);
      if (layer.ty !== 0) continue;
      if (depth >= MAX_PRECOMP_DEPTH) throw new Error(`Lottie precomposition nesting exceeds the depth-${MAX_PRECOMP_DEPTH} limit.`);
      const presentation = this.readPresentation(layer, index, path, parentId);
      if (ancestry.includes(presentation.asset.id)) throw new Error(`Lottie precomposition cycle detected at ${presentation.asset.id}.`);
      if (this.presentations.length >= MAX_PRECOMP_PRESENTATIONS) throw new Error(`Lottie precomposition plan exceeds the ${MAX_PRECOMP_PRESENTATIONS}-presentation limit.`);
      if (this.presentationIds.has(presentation.entry.id)) throw new Error(`Lottie precomposition presentation id is duplicated: ${presentation.entry.id}.`);
      this.presentationIds.add(presentation.entry.id);
      this.presentations.push(presentation.entry);
      this.diagnostics.push({ path: `${path}[${index}]`, status: "exact", code: "lottie.precomp.presentation.hold_affine_clip", message: "Static/hold affine transform and declared precomposition clip rectangle are represented exactly in the independent lowering plan." });
      this.visitLayers(presentation.asset.layers, presentation.entry.id, [...ancestry, presentation.asset.id], depth + 1, `assets.${presentation.asset.id}.layers`);
    }
  }

  private readPresentation(layer: Record<string, unknown>, layerIndex: number, path: string, parentId?: string): { asset: PrecompAsset; entry: LottiePrecompPresentationPlan["presentations"][number] } {
    for (const key of ["tm", "parent", "tt", "td", "ef", "masksProperties"]) {
      if (layer[key] !== undefined) throw new Error(`Lottie precomposition ${path}[${layerIndex}] uses unsupported ${key} semantics.`);
    }
    exactKeys(layer, ["ind", "ty", "nm", "refId", "ip", "op", "st", "sr", "bm", "ks", "ddd"], ["ind", "ty", "refId", "ip", "op"], `Lottie precomposition ${path}[${layerIndex}]`);
    const assetId = identifier(layer.refId, `Lottie precomposition ${path}[${layerIndex}] refId`);
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`Lottie precomposition ${path}[${layerIndex}] requires a resolvable precomposition asset.`);
    if (layer.st !== undefined && layer.st !== 0) throw new Error(`Lottie precomposition ${assetId} requires zero start offset.`);
    if (layer.sr !== undefined && layer.sr !== 1) throw new Error(`Lottie precomposition ${assetId} requires unit time stretch.`);
    if (layer.bm !== undefined && layer.bm !== 0) throw new Error(`Lottie precomposition ${assetId} requires normal blend mode.`);
    if (layer.ddd !== undefined && layer.ddd !== 0) throw new Error(`Lottie precomposition ${assetId} requires ddd=0 for 2D lowering.`);
    if (layer.nm !== undefined && (typeof layer.nm !== "string" || layer.nm.length > 128)) throw new Error(`Lottie precomposition ${assetId} name must be a bounded string.`);
    const inFrame = boundedNumber(layer.ip, `Lottie precomposition ${assetId} ip`, -FRAME_BOUND, FRAME_BOUND);
    const outFrame = boundedNumber(layer.op, `Lottie precomposition ${assetId} op`, -FRAME_BOUND, FRAME_BOUND);
    if (outFrame <= inFrame) throw new Error(`Lottie precomposition ${assetId} requires op greater than ip.`);
    const ordinal = positiveInteger(layer.ind, `Lottie precomposition ${assetId} ind`, 65_535);
    const id = `${parentId ?? "root"}/${assetId}:${ordinal}`;
    return {
      asset,
      entry: {
        id,
        ...(parentId ? { parentId } : {}),
        assetId,
        layerIndex,
        name: typeof layer.nm === "string" && layer.nm.length > 0 ? layer.nm.slice(0, 128) : assetId,
        inFrame,
        outFrame,
        clipRect: { x: 0, y: 0, width: asset.width, height: asset.height },
        transforms: transformTrajectory(layer.ks, inFrame, outFrame, this.source.frameRate)
      }
    };
  }

  private countWork(): void {
    this.work += 1;
    if (this.work > MAX_INPUT_WORK) throw new Error(`Lottie precomposition plan exceeds the ${MAX_INPUT_WORK}-work limit.`);
  }
}

interface PrecompAsset { id: string; width: number; height: number; layers: unknown[] }
interface TransformTrack { values: Array<{ frame: number; value: number[] }> }

function transformTrajectory(value: unknown, inFrame: number, outFrame: number, frameRate: number): LottiePrecompPresentationPlan["presentations"][number]["transforms"] {
  if (value === undefined) return [affine(inFrame, 0, [0, 0], [0, 0], [100, 100], 0, 100)];
  const transform = record(value, "Lottie precomposition transform");
  exactKeys(transform, ["a", "p", "s", "r", "rz", "o", "sk", "sa"], [], "Lottie precomposition transform");
  if (transform.r !== undefined && transform.rz !== undefined) throw new Error("Lottie precomposition transform cannot contain both r and rz.");
  for (const key of ["sk", "sa"]) if (transform[key] !== undefined && !zeroProperty(transform[key], `Lottie precomposition ${key}`)) throw new Error(`Lottie precomposition transform ${key} is unsupported.`);
  const anchor = propertyTrack(transform.a, [0, 0], 2, "anchor");
  const position = propertyTrack(transform.p, [0, 0], 2, "position");
  const scale = propertyTrack(transform.s, [100, 100], 2, "scale");
  const rotation = propertyTrack(transform.r ?? transform.rz, [0], 1, "rotation");
  const opacity = propertyTrack(transform.o, [100], 1, "opacity");
  const frames = new Set<number>([inFrame]);
  for (const track of [anchor, position, scale, rotation, opacity]) {
    if (track.values[0]!.frame > inFrame) throw new Error("Lottie precomposition transform has no value at its in frame.");
    for (const point of track.values) if (point.frame > inFrame && point.frame < outFrame) frames.add(point.frame);
  }
  if (frames.size > MAX_TRANSFORM_KEYFRAMES) throw new Error(`Lottie precomposition transform exceeds the ${MAX_TRANSFORM_KEYFRAMES}-keyframe limit.`);
  return [...frames].sort((left, right) => left - right).map((frame) => affine(
    frame,
    frameOffsetToUs(frame - inFrame, frameRate),
    sample(anchor, frame), sample(position, frame), sample(scale, frame), sample(rotation, frame)[0], sample(opacity, frame)[0]
  ));
}

function propertyTrack(value: unknown, fallback: number[], dimensions: number, label: string): TransformTrack {
  if (value === undefined) return { values: [{ frame: -FRAME_BOUND, value: fallback }] };
  const property = record(value, `Lottie precomposition ${label}`);
  exactKeys(property, ["a", "k"], ["a", "k"], `Lottie precomposition ${label}`);
  if (property.a === 0) return { values: [{ frame: -FRAME_BOUND, value: propertyValue(property.k, dimensions, label) }] };
  if (property.a !== 1) throw new Error(`Lottie precomposition ${label} animation flag must be 0 or 1.`);
  const keyframes = boundedArray(property.k, `Lottie precomposition ${label} keyframes`, MAX_TRANSFORM_KEYFRAMES);
  if (keyframes.length === 0) throw new Error(`Lottie precomposition ${label} requires at least one keyframe.`);
  let previous = -Infinity;
  return { values: keyframes.map((value, index) => {
    const keyframe = record(value, `Lottie precomposition ${label} keyframe ${index}`);
    exactKeys(keyframe, ["t", "s", "h"], ["t", "s"], `Lottie precomposition ${label} keyframe ${index}`);
    const frame = boundedNumber(keyframe.t, `Lottie precomposition ${label} keyframe ${index} t`, -FRAME_BOUND, FRAME_BOUND);
    if (frame <= previous) throw new Error(`Lottie precomposition ${label} keyframes must be strictly increasing.`);
    previous = frame;
    if (index < keyframes.length - 1 && keyframe.h !== 1) throw new Error(`Lottie precomposition ${label} supports hold keyframes only.`);
    if (keyframe.h !== undefined && keyframe.h !== 1) throw new Error(`Lottie precomposition ${label} supports hold keyframes only.`);
    return { frame, value: propertyValue(keyframe.s, dimensions, label) };
  }) };
}

function affine(frame: number, atUs: number, anchor: number[], position: number[], scale: number[], rotation: number, opacity: number) {
  if (Math.abs(anchor[0]) > FRAME_BOUND || Math.abs(anchor[1]) > FRAME_BOUND || Math.abs(position[0]) > FRAME_BOUND || Math.abs(position[1]) > FRAME_BOUND) throw new Error("Lottie precomposition transform position or anchor exceeds the bounded range.");
  if (Math.abs(scale[0]) > 10_000 || Math.abs(scale[1]) > 10_000 || Math.abs(rotation) > 360_000 || opacity < 0 || opacity > 100) throw new Error("Lottie precomposition transform scale, rotation, or opacity exceeds the bounded range.");
  if (Math.abs(scale[0] - scale[1]) > 1e-9 || scale[0] <= 0 || scale[0] > 6_400) throw new Error("Lottie precomposition transform requires positive uniform scale within 0..6400 percent.");
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians), sx = scale[0] / 100, sy = scale[1] / 100;
  const a = normalizeAffineZero(cos * sx), b = normalizeAffineZero(sin * sx), c = normalizeAffineZero(-sin * sy), d = normalizeAffineZero(cos * sy);
  return {
    frame, atUs,
    x: normalizeAffineZero(position[0] - anchor[0]), y: normalizeAffineZero(position[1] - anchor[1]),
    originX: anchor[0], originY: anchor[1], scale: sx, rotationDeg: rotation,
    matrix: [a, b, c, d, normalizeAffineZero(position[0] - (a * anchor[0]) - (c * anchor[1])), normalizeAffineZero(position[1] - (b * anchor[0]) - (d * anchor[1]))] as [number, number, number, number, number, number], opacity: opacity / 100
  };
}

function sample(track: TransformTrack, frame: number): number[] { return [...track.values.filter((entry) => entry.frame <= frame).at(-1)!.value]; }
function frameOffsetToUs(frameOffset: number, frameRate: number): number {
  const value = (frameOffset * 1_000_000) / frameRate;
  if (!Number.isSafeInteger(value)) throw new Error("Lottie precomposition frame time cannot map losslessly to a safe integer microsecond.");
  return value;
}
function zeroProperty(value: unknown, label: string): boolean { return propertyTrack(value, [0], 1, label).values.every((entry) => entry.value[0] === 0); }
function propertyValue(value: unknown, dimensions: number, label: string): number[] {
  const values = dimensions === 1 && typeof value === "number" ? [value] : Array.isArray(value) ? value : [];
  if (values.length !== dimensions || values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) throw new Error(`Lottie precomposition ${label} requires ${dimensions} finite value${dimensions === 1 ? "" : "s"}.`);
  return values as number[];
}
function normalizeAffineZero(value: number): number { return Math.abs(value) < 1e-12 ? 0 : value; }
function assertNoExecutableOrExtensionData(value: unknown, count: () => void): void {
  const stack = [value];
  while (stack.length > 0) {
    count();
    const current = stack.pop();
    if (Array.isArray(current)) { stack.push(...current); continue; }
    if (!current || typeof current !== "object") continue;
    for (const [key, entry] of Object.entries(current)) {
      if ((key === "x" && typeof entry === "string" && entry.trim()) || key.startsWith("x-") || ["expression", "script", "stateMachine", "stateMachines", "extensions", "extension", "plugin", "plugins", "pluginData"].includes(key)) {
        throw new Error(`Lottie precomposition plan refuses executable or unknown extension field ${key}.`);
      }
      stack.push(entry);
    }
  }
}
function exactKeys(record: Record<string, unknown>, allowed: string[], required: string[], label: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${label} has unsupported or unknown field ${key}.`);
  for (const key of required) if (!(key in record)) throw new Error(`${label} requires ${key}.`);
}
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function boundedArray(value: unknown, label: string, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} entries.`); return value; }
function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be a finite number within ${minimum}..${maximum}.`); return value; }
function positiveInteger(value: unknown, label: string, maximum: number): number { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${label} must be an integer within 1..${maximum}.`); return value as number; }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(value)) throw new Error(`${label} must be a safe 1..128-character identifier.`); return value; }
