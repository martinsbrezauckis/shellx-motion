import { compileChartTemplate } from "./chart-template";
import { readChartCompositionRecipe } from "./chart-composition-recipe-read";
import type { ChartCompositionChromePatch, ChartCompositionRecipe, ChartCompositionTypographyRule } from "./chart-composition-recipe-types";
import { applyTypographyPresetToLayer, getTypographyPreset } from "./typography-presets";
import type { MotionDocument, MotionKeyframe, MotionLayer, MotionSafeArea, MotionTextFit } from "./types";

/** Apply a sealed data-row chart composition after ordinary interpolation and layer patches. */
export function applyChartCompositionRecipe(motion: MotionDocument, row: Record<string, unknown>, rowId: string): MotionDocument {
  if (row.chartComposition === undefined) return motion;
  const recipe = readChartCompositionRecipe(row.chartComposition, rowId);
  assertReplacementTargets(motion, recipe, rowId);
  const chartLayers = recipe.charts.flatMap((chart) => compileChart(motion, chart, rowId));
  assertGeneratedIds(chartLayers, motion, recipe, rowId);
  const enhanced = enhanceChartLayers(chartLayers, recipe, motion, rowId);
  const retained = applyChromePatches(motion.layers.filter((layer) => !recipe.replaceLayerIds.includes(layer.id)), recipe.chromePatches, rowId);
  return { ...motion, layers: [...retained, ...enhanced] };
}

function compileChart(motion: MotionDocument, chart: ChartCompositionRecipe["charts"][number], rowId: string): MotionLayer[] {
  if (chart.startMs + chart.durationMs > motion.durationMs) throw new Error(`Motion data row ${rowId} chartComposition chart ${chart.id} exceeds the document duration.`);
  if (chart.bounds.x + chart.bounds.width > motion.width || chart.bounds.y + chart.bounds.height > motion.height) {
    throw new Error(`Motion data row ${rowId} chartComposition chart ${chart.id} exceeds document bounds.`);
  }
  const compiled = compileChartTemplate(chart);
  if (!compiled.ok) throw new Error(`Motion data row ${rowId} chartComposition chart ${chart.id} failed: ${compiled.errors.map((error) => `${error.path} ${error.message}`).join("; ")}`);
  return compiled.layers;
}

function assertReplacementTargets(motion: MotionDocument, recipe: ChartCompositionRecipe, rowId: string): void {
  const layerIds = new Set(motion.layers.map((layer) => layer.id));
  for (const id of recipe.replaceLayerIds) {
    if (!layerIds.has(id)) throw new Error(`Motion data row ${rowId} chartComposition.replaceLayerIds references unknown layer ${id}.`);
  }
  for (const patch of recipe.chromePatches) {
    if (recipe.replaceLayerIds.includes(patch.layerId)) throw new Error(`Motion data row ${rowId} chartComposition chrome patch ${patch.layerId} targets a replaced layer.`);
    if (!layerIds.has(patch.layerId)) throw new Error(`Motion data row ${rowId} chartComposition chrome patch references unknown layer ${patch.layerId}.`);
  }
}

function assertGeneratedIds(layers: MotionLayer[], motion: MotionDocument, recipe: ChartCompositionRecipe, rowId: string): void {
  const sourceIds = new Set(motion.layers.filter((layer) => !recipe.replaceLayerIds.includes(layer.id)).map((layer) => layer.id));
  const generatedIds = layers.map((layer) => layer.id);
  if (new Set(generatedIds).size !== generatedIds.length) throw new Error(`Motion data row ${rowId} chartComposition generates duplicate layer ids.`);
  for (const id of generatedIds) {
    if (sourceIds.has(id)) throw new Error(`Motion data row ${rowId} chartComposition generated layer ${id} collides with a retained layer.`);
  }
}

function enhanceChartLayers(layers: MotionLayer[], recipe: ChartCompositionRecipe, motion: MotionDocument, rowId: string): MotionLayer[] {
  let barIndex = 0;
  const matchedBarIds = new Set<string>();
  const matchedTypographyOverrides = new Set<string>();
  const enhanced = layers.map((layer) => {
    const animated = matchesBar(layer, recipe) ? animateBar(layer, recipe, barIndex++, rowId) : layer;
    if (animated !== layer) matchedBarIds.add(animated.id);
    const override = animated.type === "text" && typeof animated.text === "string"
      ? recipe.typography.overrides.find((candidate) => animated.id.endsWith(`_${candidate.layerIdSuffix}`))
      : undefined;
    if (override) matchedTypographyOverrides.add(override.layerIdSuffix);
    return animated.type === "text" && typeof animated.text === "string"
      ? applyTypography(animated, recipe, motion, rowId)
      : animated;
  });
  if (matchedBarIds.size === 0) throw new Error(`Motion data row ${rowId} chartComposition.barAnimation matches no generated shape layers.`);
  for (const override of recipe.typography.overrides) {
    if (!matchedTypographyOverrides.has(override.layerIdSuffix)) throw new Error(`Motion data row ${rowId} chartComposition typography override ${override.layerIdSuffix} matches no generated text layer.`);
  }
  return enhanced;
}

function matchesBar(layer: MotionLayer, recipe: ChartCompositionRecipe): boolean {
  return layer.type === "shape" && recipe.barAnimation.layerIdSuffixes.some((suffix) => layer.id.endsWith(`_${suffix}`));
}

function animateBar(layer: MotionLayer, recipe: ChartCompositionRecipe, index: number, rowId: string): MotionLayer {
  if (typeof layer.width !== "number" || layer.width < 0) throw new Error(`Motion data row ${rowId} chartComposition bar ${layer.id} needs a non-negative width.`);
  const startAtMs = layer.startMs + recipe.barAnimation.delayMs + index * recipe.barAnimation.staggerMs;
  const endAtMs = startAtMs + recipe.barAnimation.durationMs;
  if (endAtMs > layer.startMs + layer.durationMs) throw new Error(`Motion data row ${rowId} chartComposition bar ${layer.id} animation exceeds its layer duration.`);
  return {
    ...layer,
    transform: { ...(layer.transform ?? {}), width: 0 },
    keyframes: {
      ...(layer.keyframes ?? {}),
      "transform.width": [
        { atMs: startAtMs, value: 0, easing: recipe.barAnimation.easing },
        { atMs: endAtMs, value: layer.width, easing: recipe.barAnimation.easing }
      ]
    }
  };
}

function applyTypography(layer: MotionLayer, recipe: ChartCompositionRecipe, motion: MotionDocument, rowId: string): MotionLayer {
  const rule = recipe.typography.overrides.find((candidate) => layer.id.endsWith(`_${candidate.layerIdSuffix}`)) ?? recipe.typography.default;
  const preset = getTypographyPreset(rule.preset);
  if (!preset) throw new Error(`Motion data row ${rowId} chartComposition typography preset ${rule.preset} is unavailable.`);
  if (layer.text!.length > preset.textFit.maxChars) throw new Error(`Motion data row ${rowId} chartComposition layer ${layer.id} exceeds ${rule.preset} text limit of ${preset.textFit.maxChars}.`);
  const safeArea = motion.safeAreas?.[rule.safeAreaId];
  if (!safeArea) throw new Error(`Motion data row ${rowId} chartComposition typography references missing safe area ${rule.safeAreaId}.`);
  const applied = applyTypographyPresetToLayer(layer, rule.preset, { durationMs: Math.min(preset.defaultDurationMs, layer.durationMs), totalDurationMs: layer.durationMs });
  if (!applied.ok) throw new Error(`Motion data row ${rowId} chartComposition could not apply ${rule.preset} to ${layer.id}: ${applied.error}`);
  const shifted = reserveIntegralTextLineBox(shiftKeyframes(applied.layer, layer.startMs), preset.textFit.maxLines ?? 1, rowId);
  const fontSize = readPositiveStyleNumber(shifted, "fontSize", rowId);
  const textFit: MotionTextFit = { policy: "auto-fit", safeAreaId: rule.safeAreaId, minFontSize: Math.min(fontSize, preset.textFit.minFontSize ?? fontSize) };
  assertTextFitsSafeArea(shifted, textFit, safeArea, motion, rowId);
  return { ...shifted, textFit };
}

function shiftKeyframes(layer: MotionLayer, offsetMs: number): MotionLayer {
  if (!layer.keyframes) return layer;
  const keyframes: NonNullable<MotionLayer["keyframes"]> = {};
  for (const [target, track] of Object.entries(layer.keyframes)) {
    if (track) keyframes[target as keyof NonNullable<MotionLayer["keyframes"]>] = track.map((frame) => ({ ...frame, atMs: frame.atMs + offsetMs })) as MotionKeyframe[];
  }
  return { ...layer, keyframes };
}

function applyChromePatches(layers: MotionLayer[], patches: ChartCompositionChromePatch[], rowId: string): MotionLayer[] {
  if (patches.length === 0) return layers;
  const byId = new Map(patches.map((patch) => [patch.layerId, patch]));
  return layers.map((layer) => {
    const patch = byId.get(layer.id);
    if (!patch) return layer;
    assertChromePatchCompatibility(layer, patch, rowId);
    return { ...layer, ...(patch.text === undefined ? {} : { text: patch.text }), ...(patch.fill === undefined ? {} : { fill: patch.fill }), ...(patch.styleColor === undefined ? {} : { style: { ...(layer.style ?? {}), color: patch.styleColor } }) };
  });
}

function assertChromePatchCompatibility(layer: MotionLayer, patch: ChartCompositionChromePatch, rowId: string): void {
  if (patch.text !== undefined && layer.type !== "text" && layer.type !== "caption") throw new Error(`Motion data row ${rowId} chartComposition chrome text patch ${layer.id} requires a text layer.`);
  if (patch.fill !== undefined && layer.type !== "shape") throw new Error(`Motion data row ${rowId} chartComposition chrome fill patch ${layer.id} requires a shape layer.`);
  if (patch.styleColor !== undefined && layer.type !== "text" && layer.type !== "caption") throw new Error(`Motion data row ${rowId} chartComposition chrome styleColor patch ${layer.id} requires a text layer.`);
}

function assertTextFitsSafeArea(layer: MotionLayer, textFit: MotionTextFit, safeArea: MotionSafeArea, motion: MotionDocument, rowId: string): void {
  const x = readTransformNumber(layer, "x", rowId), y = readTransformNumber(layer, "y", rowId), width = readPositiveStyleNumber(layer, "width", rowId), height = readPositiveStyleNumber(layer, "height", rowId);
  const left = safeArea.left ?? 0, top = safeArea.top ?? 0, right = motion.width - (safeArea.right ?? 0), bottom = motion.height - (safeArea.bottom ?? 0);
  if (x < left || y < top || x + width > right || y + height > bottom) throw new Error(`Motion data row ${rowId} chartComposition layer ${layer.id} exceeds ${textFit.safeAreaId} safe area.`);
}

/**
 * Browser scroll/client dimensions are integer pixels, while CSS line boxes may be fractional.
 * Reserve a whole-pixel box for the typography preset's allowed lines so generated auto-fit
 * observes the same geometry that the compiler validated.
 */
function reserveIntegralTextLineBox(layer: MotionLayer, maxLines: number, rowId: string): MotionLayer {
  const fontSize = readPositiveStyleNumber(layer, "fontSize", rowId);
  const lineHeight = readPositiveStyleNumber(layer, "lineHeight", rowId);
  const existingHeight = typeof layer.style?.height === "number" && Number.isFinite(layer.style.height) && layer.style.height > 0
    ? Math.ceil(layer.style.height)
    : 0;
  const height = Math.max(existingHeight, Math.ceil(fontSize * lineHeight * maxLines));
  return { ...layer, style: { ...(layer.style ?? {}), height } };
}

function readTransformNumber(layer: MotionLayer, field: "x" | "y", rowId: string): number {
  const value = layer.transform?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Motion data row ${rowId} chartComposition layer ${layer.id} needs finite transform.${field}.`);
  return value;
}

function readPositiveStyleNumber(layer: MotionLayer, field: "fontSize" | "lineHeight" | "width" | "height", rowId: string): number {
  const value = layer.style?.[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Motion data row ${rowId} chartComposition layer ${layer.id} needs positive style.${field}.`);
  return value;
}
