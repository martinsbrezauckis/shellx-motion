import { canonicalJsonSha256 } from "./canonical-json";
import { parseBoundedLottieJson } from "./lottie-json";
import { planLottiePrecompPresentations, type LottiePrecompPresentationPlan } from "./lottie-precomp-presentation-plan";
import { hashBuffer } from "./receipts";
import type { MotionDocument, MotionLayer } from "./types";
import { loadSchemaSync, validateDocumentSync } from "./validate";

export const LOTTIE_GPU_PRECOMP_LOWERING_SCHEMA = "shellx-motion/lottie-gpu-precomp-lowering@1" as const;
const MAX_OUTPUT_LEAVES = 512;
const MAX_OUTPUT_KEYFRAMES = 5_120;
const MAX_OUTPUT_DRAW_BATCHES = 2_048;

export interface LottieGpuPrecompLoweringBudget {
  limits: { groups: number; leaves: number; keyframes: number; drawBatches: number };
  usage: { groups: number; leaves: number; keyframes: number; drawBatches: number };
}

export interface LottieGpuPrecompLoweringResult {
  schema: typeof LOTTIE_GPU_PRECOMP_LOWERING_SCHEMA;
  sourceSha256: string;
  loweringFingerprint: string;
  outputMotionSha256: string;
  motion: MotionDocument;
  budget: LottieGpuPrecompLoweringBudget;
  diagnostics: Array<{ path: string; status: "exact" | "refused"; code: string; message: string }>;
}

export interface LottieGpuPrecompLeafContext {
  layer: Record<string, unknown>;
  index: number;
  fps: number;
  compositionInFrame: number;
  compositionDurationMs: number;
  width: number;
  height: number;
}

export interface LottieGpuPrecompLoweringInput {
  sourceText: string;
  baseMotion: Omit<MotionDocument, "layers">;
  lowerLeaf(context: LottieGpuPrecompLeafContext): MotionLayer[];
}

/** True only for the dedicated branch; callers leave all no-precomp behavior untouched. */
export function hasLottiePrecompLayers(source: Record<string, unknown>): boolean {
  return Array.isArray(source.layers) && source.layers.some((value) => record(value)?.ty === 0);
}

/**
 * Lowers the bounded static/hold Lottie precomp subset to existing Motion
 * groups. The generated group mask clips the local zero-origin asset surface
 * before the GPU group compositor applies its affine wrapper transform.
 */
export function lowerLottieGpuPrecomps(input: LottieGpuPrecompLoweringInput): LottieGpuPrecompLoweringResult | null {
  const source = parseBoundedLottieJson(input.sourceText);
  if (!hasLottiePrecompLayers(source)) return null;
  const planned = planLottiePrecompPresentations(input.sourceText);
  if (planned.status !== "ok") throw new Error(planned.diagnostics[0]?.message ?? "Lottie precomposition lowering was refused.");
  const planner = new GpuPrecompLowerer(source, planned.plan, input);
  return planner.lower();
}

class GpuPrecompLowerer {
  private readonly assets = new Map<string, PrecompAsset>();
  private readonly entries = new Map<string, LottiePrecompPresentationPlan["presentations"][number]>();
  private readonly layers: MotionLayer[] = [];
  private readonly ids = new Set<string>();
  private readonly budget = { groups: 0, leaves: 0, keyframes: 0, drawBatches: 0 };

  constructor(
    private readonly source: Record<string, unknown>,
    private readonly plan: LottiePrecompPresentationPlan,
    private readonly input: LottieGpuPrecompLoweringInput,
  ) {
    for (const entry of plan.presentations) this.entries.set(entry.id, entry);
    const sourceAssets = Array.isArray(source.assets) ? source.assets : [];
    for (const value of sourceAssets) {
      const asset = record(value);
      if (!asset || !Array.isArray(asset.layers) || typeof asset.id !== "string") continue;
      this.assets.set(asset.id, { width: number(asset.w, "precomposition asset width"), height: number(asset.h, "precomposition asset height"), layers: asset.layers });
    }
  }

  lower(): LottieGpuPrecompLoweringResult {
    const rootLayers = this.source.layers as unknown[];
    this.lowerComposition(rootLayers, undefined, this.plan.source.inFrame, this.plan.source.outFrame, this.plan.source.width, this.plan.source.height);
    if (this.budget.groups === 0) throw new Error("Lottie GPU precomposition lowering found no precomposition groups.");
    const motion: MotionDocument = { ...this.input.baseMotion, layers: this.layers };
    const validation = validateDocumentSync(loadSchemaSync("motion"), motion);
    if (!validation.ok) throw new Error(`Lottie GPU precomposition lowering produced invalid Motion at ${validation.errors[0]?.path ?? "/"}: ${validation.errors[0]?.message ?? "unknown validation error"}.`);
    const budget: LottieGpuPrecompLoweringBudget = {
      limits: { groups: 64, leaves: MAX_OUTPUT_LEAVES, keyframes: MAX_OUTPUT_KEYFRAMES, drawBatches: MAX_OUTPUT_DRAW_BATCHES },
      usage: { ...this.budget },
    };
    const sourceSha256 = hashBuffer(Buffer.from(this.input.sourceText, "utf8"));
    const loweringFingerprint = canonicalJsonSha256({ schema: LOTTIE_GPU_PRECOMP_LOWERING_SCHEMA, sourceSha256, plan: this.plan, budget });
    const outputMotionSha256 = hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8"));
    return {
      schema: LOTTIE_GPU_PRECOMP_LOWERING_SCHEMA,
      sourceSha256, loweringFingerprint, outputMotionSha256, motion, budget,
      diagnostics: this.plan.presentations.map((entry) => ({
        path: `lottie.precomps.${entry.id}`,
        status: "exact" as const,
        code: "lottie.precomp.gpu.hold_affine_clip",
        message: "Exact static/hold affine precomposition lowering is admitted only through the persistent GPU group compositor; no direct Browser or Native claim is made."
      }))
    };
  }

  private lowerComposition(values: unknown[], parentId: string | undefined, parentInFrame: number, parentOutFrame: number, width: number, height: number): string[] {
    const childIds: string[] = [];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const layer = record(values[index]);
      if (!layer) throw new Error(`Lottie precomposition layer ${index} must be an object.`);
      if (layer.ty === 0) {
        const entry = this.entryFor(layer, parentId);
        const groupId = this.lowerGroup(entry, parentInFrame, parentOutFrame);
        if (groupId) childIds.push(groupId);
        continue;
      }
      this.assertSupportedLeaf(layer, index);
      const { inFrame, outFrame, durationMs } = visibleTiming(layer, parentInFrame, parentOutFrame, this.plan.source.frameRate);
      if (outFrame <= inFrame) continue;
      const leaves = this.input.lowerLeaf({
        layer, index, fps: this.plan.source.frameRate, compositionInFrame: parentInFrame, compositionDurationMs: durationMs, width, height,
      });
      for (const leaf of leaves) {
        if (leaf.type === "group" || leaf.mask || leaf.matte || leaf.effects || leaf.keyframes) throw new Error(`Lottie precomposition leaf ${leaf.id} requires unsupported group, composite, or animated semantics.`);
        const id = this.claimId(`leaf:${parentId ?? "root"}:${leaf.id}`);
        this.layers.push({ ...leaf, id }); childIds.push(id); this.budget.leaves += 1;
        if (this.budget.leaves > MAX_OUTPUT_LEAVES) throw new Error(`Lottie GPU precomposition lowering exceeds the ${MAX_OUTPUT_LEAVES}-leaf limit.`);
      }
    }
    if (childIds.length > 256) throw new Error("Lottie GPU precomposition group exceeds the 256-child Motion ownership limit.");
    return childIds;
  }

  private lowerGroup(entry: LottiePrecompPresentationPlan["presentations"][number], parentInFrame: number, parentOutFrame: number): string | undefined {
    const asset = this.assets.get(entry.assetId);
    if (!asset) throw new Error(`Lottie precomposition ${entry.assetId} has no resolvable layers asset.`);
    if (asset.width > this.plan.source.width || asset.height > this.plan.source.height) throw new Error(`Lottie precomposition ${entry.assetId} clip exceeds the root GPU surface.`);
    // Nested asset layer clocks are local to their wrapper composition. Clip
    // the wrapper's active interval to its parent before rebasing it to the
    // parent-local Motion timeline. Without this intersection, a child [0,30]
    // under a parent [10,20] would incorrectly escape its owner.
    const activeInFrame = Math.max(parentInFrame, entry.inFrame);
    const activeOutFrame = Math.min(parentOutFrame, entry.outFrame);
    if (activeOutFrame <= activeInFrame) return undefined;
    const startUs = frameToUs(activeInFrame - parentInFrame, this.plan.source.frameRate);
    const durationUs = frameToUs(activeOutFrame - activeInFrame, this.plan.source.frameRate);
    const parentDurationUs = frameToUs(parentOutFrame - parentInFrame, this.plan.source.frameRate);
    if (startUs < 0 || durationUs <= 0 || startUs + durationUs > parentDurationUs) throw new Error(`Lottie precomposition ${entry.assetId} timing escapes its parent local timeline.`);
    const childIds = this.lowerComposition(asset.layers, entry.id, activeInFrame, activeOutFrame, asset.width, asset.height);
    if (childIds.length === 0) throw new Error(`Lottie precomposition ${entry.assetId} has no supported visible leaves.`);
    const activeTransforms = rebaseGroupTransforms(entry.transforms, activeInFrame, activeOutFrame, this.plan.source.frameRate);
    const first = activeTransforms[0]!;
    const keyframes = groupKeyframes(activeTransforms);
    this.budget.keyframes += Object.values(keyframes).reduce((count, values) => count + (values?.length ?? 0), 0);
    if (this.budget.keyframes > MAX_OUTPUT_KEYFRAMES) throw new Error(`Lottie GPU precomposition lowering exceeds the ${MAX_OUTPUT_KEYFRAMES}-keyframe limit.`);
    const id = this.claimId(`group:${entry.id}`);
    this.layers.push({
      id, name: entry.name, type: "group", startMs: startUs / 1_000, durationMs: durationUs / 1_000, childLayerIds: childIds,
      transform: { x: first.x, y: first.y, originX: first.originX, originY: first.originY, scale: first.scale, rotation: first.rotationDeg, opacity: first.opacity },
      mask: { type: "rect", inset: { right: this.plan.source.width - asset.width, bottom: this.plan.source.height - asset.height } },
      ...(Object.keys(keyframes).length > 0 ? { keyframes } : {})
    });
    this.budget.groups += 1; this.budget.drawBatches += 2;
    if (this.budget.groups > 64 || this.budget.drawBatches + this.budget.leaves > MAX_OUTPUT_DRAW_BATCHES) throw new Error("Lottie GPU precomposition lowering exceeds the existing GPU group or draw budget.");
    return id;
  }

  private entryFor(layer: Record<string, unknown>, parentId: string | undefined): LottiePrecompPresentationPlan["presentations"][number] {
    const refId = typeof layer.refId === "string" ? layer.refId : "";
    const ind = layer.ind;
    if (!refId || typeof ind !== "number" || !Number.isInteger(ind) || ind < 1) throw new Error("Lottie precomposition wrapper requires a safe refId and ind.");
    const entry = this.entries.get(`${parentId ?? "root"}/${refId}:${ind}`);
    if (!entry) throw new Error(`Lottie precomposition ${refId} is not in the validated lowering plan.`);
    return entry;
  }

  private assertSupportedLeaf(layer: Record<string, unknown>, index: number): void {
    if (![1, 2, 4, 5].includes(layer.ty as number)) throw new Error(`Lottie precomposition leaf ${index} has unsupported layer type ${String(layer.ty)}.`);
    if (layer.ddd !== undefined && layer.ddd !== 0) throw new Error(`Lottie precomposition leaf ${index} requires ddd=0 for 2D lowering.`);
    for (const key of ["parent", "tm", "tt", "td"]) if (layer[key] !== undefined) throw new Error(`Lottie precomposition leaf ${index} uses unsupported ${key} semantics.`);
    if (layer.masksProperties !== undefined || layer.ef !== undefined) throw new Error(`Lottie precomposition leaf ${index} uses unsupported mask or effect semantics.`);
    if (containsAnimation(layer)) throw new Error(`Lottie precomposition leaf ${index} requires static leaf properties.`);
  }

  private claimId(source: string): string {
    const id = `lottie-precomp-${canonicalJsonSha256(source).slice(0, 24)}`;
    if (this.ids.has(id)) throw new Error(`Lottie GPU precomposition lowering generated duplicate id ${id}.`);
    this.ids.add(id); return id;
  }
}

interface PrecompAsset { width: number; height: number; layers: unknown[] }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 32_768) throw new Error(`Lottie ${label} must be a positive bounded integer.`); return value; }
function frameToUs(frames: number, fps: number): number { const value = (frames * 1_000_000) / fps; if (!Number.isSafeInteger(value)) throw new Error("Lottie precomposition frame time cannot map losslessly to a safe integer microsecond."); return value; }
function visibleTiming(layer: Record<string, unknown>, parentIn: number, parentOut: number, fps: number): { inFrame: number; outFrame: number; durationMs: number } {
  const sourceIn = typeof layer.ip === "number" ? layer.ip : parentIn;
  const sourceOut = typeof layer.op === "number" ? layer.op : parentOut;
  if (!Number.isFinite(sourceIn) || !Number.isFinite(sourceOut)) throw new Error("Lottie precomposition leaf timing must be finite.");
  const inFrame = Math.max(parentIn, sourceIn), outFrame = Math.min(parentOut, sourceOut);
  // The callback receives milliseconds; never round a source-frame boundary
  // into an invented local time.
  frameToUs(inFrame - parentIn, fps);
  frameToUs(outFrame - inFrame, fps);
  return { inFrame, outFrame, durationMs: frameToUs(parentOut - parentIn, fps) / 1_000 };
}
function groupKeyframes(transforms: LottiePrecompPresentationPlan["presentations"][number]["transforms"]): NonNullable<MotionLayer["keyframes"]> {
  if (transforms.length < 2) return {};
  const track = (value: (entry: typeof transforms[number]) => number) => transforms.map((entry) => ({ atMs: entry.atUs / 1_000, value: value(entry), easing: "hold" as const }));
  return { "transform.x": track((entry) => entry.x), "transform.y": track((entry) => entry.y), "transform.scale": track((entry) => entry.scale), "transform.rotation": track((entry) => entry.rotationDeg), opacity: track((entry) => entry.opacity) };
}
function rebaseGroupTransforms(
  transforms: LottiePrecompPresentationPlan["presentations"][number]["transforms"],
  activeInFrame: number,
  activeOutFrame: number,
  fps: number,
): LottiePrecompPresentationPlan["presentations"][number]["transforms"] {
  const first = [...transforms].reverse().find((entry) => entry.frame <= activeInFrame);
  if (!first) throw new Error("Lottie precomposition transform has no value at its clipped in frame.");
  const at = (entry: typeof transforms[number], frame: number) => ({ ...entry, frame, atUs: frameToUs(frame - activeInFrame, fps) });
  return [at(first, activeInFrame), ...transforms.filter((entry) => entry.frame > activeInFrame && entry.frame < activeOutFrame).map((entry) => at(entry, entry.frame))];
}
function containsAnimation(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) { stack.push(...current); continue; }
    const item = record(current); if (!item) continue;
    if (item.a === 1) return true;
    stack.push(...Object.values(item));
  }
  return false;
}
