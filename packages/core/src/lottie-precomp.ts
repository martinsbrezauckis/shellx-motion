import { parseBoundedLottieJson } from "./lottie-json";

const MAX_FLATTENED_PRECOMP_EXPANSION_BYTES = 16 * 1024 * 1024;

export interface FlattenedLottiePrecomps {
  schema: "shellx-motion/lottie-precomp-flattening@1";
  animationText: string;
  flattenedPrecompCount: number;
  flattenedLayerCount: number;
  maxDepth: number;
  changed: boolean;
  policy: "full-frame-identity-static";
}

/** Flattens only precomps whose clipping, transform, and timing are receiver-exact. */
export function flattenStaticLottiePrecomps(sourceText: string): FlattenedLottiePrecomps {
  const source = parseBoundedLottieJson(sourceText);
  const width = positiveDimension(source.w, "w");
  const height = positiveDimension(source.h, "h");
  const inFrame = finiteFrame(source.ip, 0, "composition ip");
  const outFrame = finiteFrame(source.op, inFrame, "composition op");
  if (outFrame <= inFrame) throw new Error("Lottie precomposition source requires op greater than ip.");
  const layers = source.layers;
  if (!Array.isArray(layers)) throw new Error("Lottie precomposition source requires a layers array.");
  const assets = indexPrecompAssets(source.assets);
  const stats = { precomps: 0, layers: 0, maxDepth: 0 };
  const planned = flattenLayers(layers, assets, { width, height, inFrame, outFrame, depth: 0, ancestry: [] }, stats);
  if (stats.precomps === 0) {
    return {
      schema: "shellx-motion/lottie-precomp-flattening@1",
      animationText: sourceText,
      flattenedPrecompCount: 0,
      flattenedLayerCount: 0,
      maxDepth: 0,
      changed: false,
      policy: "full-frame-identity-static"
    };
  }
  source.layers = materializeFlattenedLayers(planned);
  return {
    schema: "shellx-motion/lottie-precomp-flattening@1",
    animationText: JSON.stringify(source),
    flattenedPrecompCount: stats.precomps,
    flattenedLayerCount: stats.layers,
    maxDepth: stats.maxDepth,
    changed: true,
    policy: "full-frame-identity-static"
  };
}

interface PlannedFlattenedLottieLayer {
  layer: Record<string, unknown>;
  expanded: boolean;
}

function flattenLayers(
  values: unknown[],
  assets: Map<string, Record<string, unknown>>,
  context: { width: number; height: number; inFrame: number; outFrame: number; depth: number; ancestry: string[] },
  stats: { precomps: number; layers: number; maxDepth: number }
): PlannedFlattenedLottieLayer[] {
  const output: PlannedFlattenedLottieLayer[] = [];
  for (const [index, value] of values.entries()) {
    const layer = requiredRecord(value, `Lottie layer ${index}`);
    if (layer.ty !== 0) {
      if (context.depth > 0 && layer.parent !== undefined) {
        throw new Error("Lottie precomposition child parent hierarchies are outside the exact flattening subset.");
      }
      output.push({ layer, expanded: context.depth > 0 });
      continue;
    }
    if (context.depth >= 4) throw new Error("Lottie precomposition nesting exceeds the depth-4 limit.");
    const refId = typeof layer.refId === "string" ? layer.refId : "";
    const asset = assets.get(refId);
    if (!refId || !asset || !Array.isArray(asset.layers)) throw new Error(`Lottie precomposition layer ${index} requires a resolvable layer asset.`);
    if (context.ancestry.includes(refId)) throw new Error(`Lottie precomposition cycle detected at ${refId}.`);
    assertExactPrecompLayer(layer, refId);
    if (asset.w !== context.width || asset.h !== context.height) {
      throw new Error(`Lottie precomposition ${refId} must match the containing ${context.width}x${context.height} composition.`);
    }
    const parentIn = finiteFrame(layer.ip, context.inFrame, `precomposition ${refId} ip`);
    const parentOut = finiteFrame(layer.op, context.outFrame, `precomposition ${refId} op`);
    const nested = flattenLayers(asset.layers, assets, {
      width: context.width,
      height: context.height,
      inFrame: parentIn,
      outFrame: parentOut,
      depth: context.depth + 1,
      ancestry: [...context.ancestry, refId]
    }, stats);
    const parentName = typeof layer.nm === "string" && layer.nm ? layer.nm : refId;
    for (const child of nested) {
      const childIn = finiteFrame(child.layer.ip, parentIn, `precomposition ${refId} child ip`);
      const childOut = finiteFrame(child.layer.op, parentOut, `precomposition ${refId} child op`);
      const ip = Math.max(parentIn, childIn);
      const op = Math.min(parentOut, childOut);
      if (op <= ip) continue;
      const childName = typeof child.layer.nm === "string" && child.layer.nm ? child.layer.nm : `Layer ${output.length + 1}`;
      if (output.length >= 256) throw new Error("Lottie precomposition expansion exceeds the 256-layer limit.");
      output.push({ layer: { ...child.layer, nm: `${parentName}/${childName}`, ip, op }, expanded: true });
      stats.layers += 1;
    }
    stats.precomps += 1;
    stats.maxDepth = Math.max(stats.maxDepth, context.depth + 1);
  }
  return output;
}

/**
 * Measure every expanded final layer before cloning or retaining it. Parsed
 * Lottie is JSON data, so JSON serialization is the exact byte representation
 * this helper subsequently returns for each materialized record.
 */
function materializeFlattenedLayers(planned: PlannedFlattenedLottieLayer[]): Record<string, unknown>[] {
  let expandedBytes = 0;
  for (const [index, entry] of planned.entries()) {
    if (!entry.expanded) continue;
    const materialized = { ...entry.layer, ind: index + 1 };
    const bytes = Buffer.byteLength(JSON.stringify(materialized), "utf8");
    if (bytes > MAX_FLATTENED_PRECOMP_EXPANSION_BYTES - expandedBytes) {
      throw new Error("Lottie precomposition expansion exceeds the 16 MiB expanded-byte limit.");
    }
    expandedBytes += bytes;
  }
  return planned.map(({ layer }, index) => cloneRecord({ ...layer, ind: index + 1 }, `Lottie flattened layer ${index}`));
}

function assertExactPrecompLayer(layer: Record<string, unknown>, refId: string): void {
  for (const key of ["tm", "parent", "tt", "td", "ef", "masksProperties"]) {
    const value = layer[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      throw new Error(`Lottie precomposition ${refId} uses unsupported ${key} semantics.`);
    }
  }
  if (layer.bm !== undefined && layer.bm !== 0) throw new Error(`Lottie precomposition ${refId} requires normal blend mode.`);
  if (layer.st !== undefined && layer.st !== 0) throw new Error(`Lottie precomposition ${refId} requires zero start offset.`);
  if (layer.sr !== undefined && layer.sr !== 1) throw new Error(`Lottie precomposition ${refId} requires unit time stretch.`);
  const transform = mutableRecord(layer.ks);
  if (!transform) return;
  const position = staticVector(transform.p, [0, 0], `${refId} position`);
  const anchor = staticVector(transform.a, [0, 0], `${refId} anchor`);
  const scale = staticVector(transform.s, [100, 100], `${refId} scale`);
  const rotation = staticScalar(transform.r ?? transform.rz, 0, `${refId} rotation`);
  const opacity = staticScalar(transform.o, 100, `${refId} opacity`);
  if (Math.abs(position[0] - anchor[0]) > 1e-9 || Math.abs(position[1] - anchor[1]) > 1e-9
    || scale[0] !== 100 || scale[1] !== 100 || rotation !== 0 || opacity !== 100) {
    throw new Error(`Lottie precomposition ${refId} requires an identity static transform.`);
  }
  for (const key of ["sk", "sa"]) {
    if (transform[key] !== undefined && staticScalar(transform[key], 0, `${refId} ${key}`) !== 0) {
      throw new Error(`Lottie precomposition ${refId} does not support skew.`);
    }
  }
}

function indexPrecompAssets(value: unknown): Map<string, Record<string, unknown>> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > 256) throw new Error("Lottie precomposition assets must be a bounded array.");
  const assets = new Map<string, Record<string, unknown>>();
  for (const [index, item] of value.entries()) {
    const asset = mutableRecord(item);
    if (!asset || !Array.isArray(asset.layers)) continue;
    const id = typeof asset.id === "string" ? asset.id : "";
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(id)) throw new Error(`Lottie precomposition asset ${index} has an unsafe id.`);
    if (assets.has(id)) throw new Error(`Lottie precomposition asset id ${id} is duplicated.`);
    assets.set(id, asset);
  }
  return assets;
}

function staticVector(value: unknown, fallback: number[], label: string): number[] {
  if (value === undefined) return fallback;
  const record = mutableRecord(value);
  if (!record || (record.a !== undefined && record.a !== 0) || !Array.isArray(record.k)
    || record.k.length < 2 || record.k.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`Lottie precomposition ${label} must be static.`);
  }
  return record.k;
}

function staticScalar(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const record = mutableRecord(value);
  if (!record || (record.a !== undefined && record.a !== 0) || typeof record.k !== "number" || !Number.isFinite(record.k)) {
    throw new Error(`Lottie precomposition ${label} must be static.`);
  }
  return record.k;
}

function positiveDimension(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 32768) throw new Error(`Lottie ${label} must be a positive bounded dimension.`);
  return value;
}

function finiteFrame(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Lottie ${label} must be finite.`);
  return value;
}

function cloneRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requiredRecord(value, label);
  return structuredClone(record);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const record = mutableRecord(value);
  if (!record) throw new Error(`${label} must be an object.`);
  return record;
}

function mutableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
