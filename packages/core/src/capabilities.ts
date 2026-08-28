import type { CapabilityMatch, MotionDocument, RendererCapability, RendererCapabilityCard, RendererCapabilityCardMatch, RendererCapabilityMatchOptions, RendererCapabilityMatchResult, RendererCapabilityPipeline } from "./types";
import { compareCodeUnits } from "./canonical-json";
import { cloneRendererColorAlphaCapability } from "./color-alpha-contract";
import { isAudioOnlyFrameLaneUnsupported } from "./frame-lane-audio-feature";
import { matchGpuSceneCapability } from "./gpu-capability-eligibility";
import { geometryKeyframesLegacyCapabilityMatch, gpuGeometryKeyframesTargetUnsupported } from "./gpu-geometry-keyframes-capability-routing";
import { gpuRelationsStrictPreviewCapabilityMatch } from "./gpu-relations-capability-routing";
import { gpuScene3DAnimationStrictPreviewCapabilityMatch } from "./gpu-scene3d-animation-capability-routing";
import { requiredLayerFeatures } from "./layer-capability-features";
import { motionBehaviorCapabilityMatch, motionBehaviorPackageRefusal } from "./motion-behavior-lane-refusal"; import { motionRelationCapabilityMatch, motionRelationPackageRefusal, motionRelationStorePresent } from "./motion-relation-lane-refusal"; import { motionScene3DAnimationCapabilityMatch, motionScene3DAnimationPackageRefusal, motionScene3DAnimationStorePresent } from "./motion-scene3d-animation-lane-refusal"; import { motionLayoutGapAnimationCapabilityMatch, motionLayoutGapAnimationPackageRefusal } from "./motion-layout-gap-animation-lane-refusal";
import { nativeTextDeliveryIssues, requestedNativeTextFontFamily } from "./native-text-delivery";
// The static renderer capability-card catalog lives in ./capability-cards to satisfy the module-size gate.
import { RENDERER_CAPABILITY_CARDS } from "./capability-cards";
export { requiredLayerFeatures } from "./layer-capability-features";
export { isAudioOnlyFrameLaneUnsupported } from "./frame-lane-audio-feature";
const SHAPED_TEXT_FEATURES = ["text.direction", "text.shaping.complex", "text.charset.non-ascii", "text.font.family"];
/**
 * A frame producer that lists text/caption is making a production fidelity claim, not merely
 * saying that it can paint glyph-shaped pixels. Native is deliberately exempt as the one named
 * block-glyph preview lane. Any future GPU lane must otherwise bring manifest-font provenance,
 * runtime font loading, fallback observation, complex-shaping fixtures, and the exact capability
 * vocabulary before the catalog lets it advertise text. Browser is the one explicitly scoped
 * fallback-attestation exception; it may not lend that exception to a future GPU lane.
 */
export function assertRendererTypographyCapabilityRegistration(cards: readonly RendererCapabilityCard[]): void {
  for (const card of cards) {
    if (card.role !== "frame-producer" || !card.layerTypes.some((type) => type === "text" || type === "caption")) continue;
    const typography = card.typography;
    if (typography?.mode === "block-glyph-preview") {
      if (card.lane !== "native" || typography.conformanceFixtureIds.length === 0) {
        throw new Error(`Frame producer ${card.lane} may advertise block-glyph text only as the proven native preview lane.`);
      }
      continue;
    }
    if (card.lane === "browser" && typography?.mode === "manifest-bound-fallback-attested") {
      if (
        typography.fontProvenance !== "manifest-bound"
        || typography.fontLoading !== "runtime-verified"
        || typography.fallbackEvidence !== "metric-probe"
        || typography.conformanceFixtureIds.length === 0
        || !card.features.includes("text.font.family")
      ) {
        throw new Error("Browser fallback-attestation registration requires manifest-font provenance, loading, and fallback evidence.");
      }
      continue;
    }
    if (
      typography?.mode !== "manifest-bound-shaping"
      || typography.fontProvenance !== "manifest-bound"
      || typography.fontLoading !== "runtime-verified"
      || typography.fallbackEvidence !== "metric-probe"
      || typography.complexShaping !== "fixture-proven"
      || typography.conformanceFixtureIds.length === 0
      || SHAPED_TEXT_FEATURES.some((feature) => !card.features.includes(feature))
    ) {
      throw new Error(`Frame producer ${card.lane} cannot advertise text until manifest-font provenance, loading, fallback, and complex-shaping proof are registered.`);
    }
  }
}
assertRendererTypographyCapabilityRegistration(RENDERER_CAPABILITY_CARDS);

export function listRendererCapabilityCards(): RendererCapabilityCard[] {
  return RENDERER_CAPABILITY_CARDS.map((card) => ({
    ...card,
    layerTypes: [...card.layerTypes],
    outputs: [...card.outputs],
    features: [...card.features],
    paradigms: [...card.paradigms],
    renderTargets: [...card.renderTargets],
    strengths: [...card.strengths],
    weaknesses: [...card.weaknesses],
    runtime: {
      ...card.runtime,
      ...(card.runtime.readiness ? { readiness: { ...card.runtime.readiness, tools: [...card.runtime.readiness.tools] } } : {})
    },
    ...(card.colorAlpha ? { colorAlpha: cloneRendererColorAlphaCapability(card.colorAlpha) } : {}),
    ...(card.typography ? { typography: { ...card.typography, conformanceFixtureIds: [...card.typography.conformanceFixtureIds] } } : {}),
    ...(card.frameInputs ? { frameInputs: [...card.frameInputs] } : {}),
    ...(card.adapter ? {
      adapter: {
        ...card.adapter,
        formats: [...card.adapter.formats],
        unsupportedFeatureClasses: [...card.adapter.unsupportedFeatureClasses],
        hostCompatibility: [...card.adapter.hostCompatibility]
      }
    } : {})
  }));
}
/**
 * Project a renderer lane's capability card down to the `RendererCapability` shape
 * (`lane`/`layerTypes`/`outputs`/`features`) used by the runtime capability gate.
 *
 * This is the single source of truth for per-lane render capabilities: `capabilities.ts` cards
 * are authored once here, and each renderer package imports/re-exports the projected constant
 * (`NATIVE_CAPABILITY`, `BROWSER_CAPABILITY`) rather than declaring its own copy. The cross-lane
 * consistency test asserts that each renderer's exported capability equals this projection, so a
 * future edit that diverges from the card fails CI.
 *
 * @param lane Renderer lane id (e.g. "native", "browser", "ffmpeg", "connector").
 * @returns A cloned `RendererCapability` for the lane.
 * @throws If no capability card is registered for `lane`.
 */
export function rendererCapabilityForLane(lane: string): RendererCapability {
  const card = RENDERER_CAPABILITY_CARDS.find((candidate) => candidate.lane === lane);
  if (!card) throw new Error(`No renderer capability card registered for lane '${lane}'.`);
  return {
    lane: card.lane,
    layerTypes: [...card.layerTypes],
    outputs: [...card.outputs],
    ...(card.visualFeatureSupport ? { visualFeatureSupport: card.visualFeatureSupport } : {}),
    features: [...card.features]
  };
}
/**
 * Native-lane render capability (single source of truth, derived from the native card).
 * Consumed by renderer-native's runtime gate. Do not re-declare inside the renderer package.
 */
export const NATIVE_CAPABILITY: RendererCapability = rendererCapabilityForLane("native");

/**
 * Browser-lane render capability (single source of truth, derived from the browser card).
 * Consumed by renderer-browser's runtime gate. Do not re-declare inside the renderer package.
 */
export const BROWSER_CAPABILITY: RendererCapability = rendererCapabilityForLane("browser");

/** Strict hardware WebGPU scene capability for general preview and streamed final frame production. */
export const GPU_CAPABILITY: RendererCapability = rendererCapabilityForLane("gpu");

export function matchRendererCapabilityCards(motion: MotionDocument, options: RendererCapabilityMatchOptions = {}): RendererCapabilityMatchResult {
  const cards = listRendererCapabilityCards();
  const directMatches = cards.map((card) => matchRendererCapabilityCard(motion, card, options));
  const matches = directMatches
    .map((match) => applyFrameProducerConstraint(match, directMatches))
    .sort((a, b) => b.score - a.score || cards.findIndex((card) => card.lane === a.lane) - cards.findIndex((card) => card.lane === b.lane));
  const recommendedLane = matches.find((match) => match.ok)?.lane ?? null;
  const recommendedPipeline = resolveRendererCapabilityPipeline(matches, recommendedLane, options.preferLane);
  return {
    cards,
    matches,
    recommendedLane,
    ...(recommendedPipeline ? { recommendedPipeline } : {})
  };
}

export function resolveRendererCapabilityPipeline(
  matches: RendererCapabilityCardMatch[],
  recommendedLane: string | null,
  preferredFrameLane?: string
): RendererCapabilityPipeline | undefined {
  if (!recommendedLane) return undefined;
  const recommended = matches.find((match) => match.lane === recommendedLane);
  if (!recommended?.card.requiresFrameLane) return undefined;
  const frameLane = matches.find((match) => isCompatibleFrameLane(match, recommended.card) && match.lane === preferredFrameLane)
    ?? matches.find((match) => isCompatibleFrameLane(match, recommended.card) && match.lane === "browser")
    ?? matches.find((match) => isCompatibleFrameLane(match, recommended.card));
  return {
    lanes: frameLane ? [frameLane.lane, recommended.lane] : [recommended.lane],
    ...(frameLane ? { frameLane: frameLane.lane } : {}),
    finalLane: recommended.lane,
    reason: frameLane
      ? `Lane ${recommended.lane} requires ${frameLane.lane} frame capture before final encode.`
      : `Lane ${recommended.lane} requires a compatible frame capture lane before final encode.`
  };
}

function isCompatibleFrameLane(match: RendererCapabilityCardMatch, finalCard: RendererCapabilityCard): boolean {
  const acceptedFrameInputs = finalCard.frameInputs ?? ["png-frame"];
  return match.lane !== finalCard.lane
    && match.card.role === "frame-producer"
    && acceptedFrameInputs.some((input) => match.card.outputs.includes(input))
    && match.unsupported.every((item) => isAudioOnlyFrameLaneUnsupported(item.feature));
}

/**
 * An encoder is available for a document only when a real frame producer can supply the visual
 * features it inherits. This is deliberately applied after every direct lane has matched, so an
 * encoder never becomes a false-green just because its own encode/delivery feature list is valid.
 */
function applyFrameProducerConstraint(
  match: RendererCapabilityCardMatch,
  candidates: RendererCapabilityCardMatch[]
): RendererCapabilityCardMatch {
  if (!match.ok || !match.card.requiresFrameLane) return match;
  if (candidates.some((candidate) => isCompatibleFrameLane(candidate, match.card))) return match;
  const reason = `Lane ${match.lane} requires a compatible ${match.card.frameInputs?.join(" or ") ?? "frame"} producer for this package.`;
  return {
    ...match,
    ok: false,
    score: match.score - 20,
    reasons: [...match.reasons, reason]
  };
}

/**
 * Every layer `type` that at least one registered renderer lane can consume.
 *
 * Read straight off the capability-card catalog — the same `layerTypes` arrays that
 * `rendererCapabilityForLane` copies into each lane's runtime gate and that
 * `matchRendererCapability` then tests `layer.type` against. There is therefore no second list to
 * keep in sync: registering a lane, or widening a lane's `layerTypes`, widens this set in the same
 * edit, and a type absent here is a type no lane will render.
 *
 * @returns the sorted union of every card's `layerTypes`.
 */
export function renderableLayerTypes(): readonly string[] {
  return [...new Set(RENDERER_CAPABILITY_CARDS.flatMap((card) => card.layerTypes))].sort(compareCodeUnits);
}

/**
 * Layers in `motion` that no registered lane can render because of their `type`.
 *
 * This is the "no lane will take it" half of `matchRendererCapability`, hoisted so a package can be
 * rejected up front instead of by whichever lane happens to be asked first. Hidden layers are
 * skipped for the same reason the lane gate skips them: a lane never rasterizes them, so they
 * cannot make a render fail.
 *
 * Feature-level gaps (a supported type using an unsupported option) are deliberately NOT reported
 * here — those are per-lane and another lane may still accept the document. Only a layer type that
 * every lane rejects makes a document unrenderable everywhere.
 *
 * @param motion document to inspect.
 * @returns one entry per offending layer, in document order.
 */
export function unrenderableMotionLayers(motion: MotionDocument): Array<{ layerId: string; type: string }> {
  const renderable = new Set(renderableLayerTypes());
  return motion.layers
    .filter((layer) => layer.visible !== false && !renderable.has(layer.type))
    .map((layer) => ({ layerId: layer.id, type: layer.type }));
}

/**
 * The renderer lanes that will actually draw `motion`, in capability-card order.
 *
 * "Will actually draw" is the card matcher's own verdict — `matchRendererCapabilityCards`, the same
 * projection every lane's runtime gate is built from — rather than a second list of layer types
 * kept in step by hand. A lane is listed only when it accepts every visible layer *and* every
 * feature those layers require, so the answer is a claim the lane can be held to rather than a
 * hint: ask that lane to render and it will not refuse on capability grounds.
 *
 * Only `preview` and `final` cards are considered, because those are the lanes that produce pixels.
 * The `connector` card emits packages and plans and the `adapter` cards diagnose foreign formats on
 * the way in; neither renders a Motion document, so listing them as render lanes would be the same
 * class of untrue advertisement this function exists to remove.
 *
 * Conservative by construction: a lane whose only gap is audio (the browser lane tolerates audio
 * layers at render time because the ffmpeg lane muxes sound downstream) is *not* listed, because
 * the claim being made is "this lane renders the document", not "renders part of it".
 *
 * @param motion document to place.
 * @returns lane ids, ordered as the capability-card catalog orders them; empty when nothing renders it.
 */
export function renderLanesFor(motion: MotionDocument): string[] {
  const strictPreview = motionScene3DAnimationStorePresent(motion)
    || motionRelationStorePresent(motion) && !motionScene3DAnimationStorePresent(motion);
  const { matches } = matchRendererCapabilityCards(motion, strictPreview ? { target: "preview", output: "png-frame" } : {});
  return RENDERER_CAPABILITY_CARDS
    .filter((card) => card.category === "preview" || card.category === "final")
    .filter((card) => matches.some((match) => match.lane === card.lane && match.ok))
    .map((card) => card.lane);
}

/** A refusal describing why no render lane will take a package. See {@link unrenderablePackageRefusal}. */
export interface UnrenderablePackageRefusal {
  code: "package_unrenderable";
  message: string;
  suggestedAction: string;
  layers: Array<{ layerId: string; type: string }>;
}

/**
 * The one renderability verdict every product surface answers with.
 *
 * A package no lane can render is not a valid package: answering "valid" and then failing every
 * preview and render is the worst answer the engine can give, because the caller is told the
 * document is sound and is left with nothing to act on when it will not draw. Both the Debug
 * API/MCP `motion.package.validate` and the SDK's own `validate` call this function, so the two
 * surfaces cannot drift into contradicting each other about the same directory — there is one
 * check, not two copies of one.
 *
 * @param motion document to inspect.
 * @returns the refusal (code, caller-facing message, correction, offending layers) or `null` when
 *          at least one lane can render every visible layer type.
 */
export function unrenderablePackageRefusal(motion: MotionDocument): UnrenderablePackageRefusal | null {
  const layoutGapAnimationRefusal = motionLayoutGapAnimationPackageRefusal(motion);
  if (layoutGapAnimationRefusal) return layoutGapAnimationRefusal;
  const scene3dAnimationRefusal = motionScene3DAnimationPackageRefusal(motion);
  const scene3dAnimationPreviewRenderable = scene3dAnimationRefusal !== undefined && renderLanesFor(motion).includes("gpu");
  if (scene3dAnimationRefusal && !scene3dAnimationPreviewRenderable) return scene3dAnimationRefusal;
  const relationRefusal = motionRelationPackageRefusal(motion);
  const relationPreviewRenderable = relationRefusal !== undefined && renderLanesFor(motion).includes("gpu");
  if (relationRefusal && !relationPreviewRenderable) return relationRefusal;
  const behaviorRefusal = motionBehaviorPackageRefusal(motion);
  if (behaviorRefusal && !relationPreviewRenderable) return behaviorRefusal;
  const layers = unrenderableMotionLayers(motion);
  if (layers.length === 0) return null;
  return {
    code: "package_unrenderable",
    message: `No render lane supports ${layers.length} layer${layers.length === 1 ? "" : "s"}: ${layers
      .map((layer) => `${layer.layerId} (type "${layer.type}")`)
      .join(", ")}.`,
    suggestedAction: "Change each layer's type to one a lane renders; motion.capabilities.cards lists the "
      + "layer types every lane accepts.",
    layers
  };
}

export function matchRendererCapability(motion: MotionDocument, capability: RendererCapability): CapabilityMatch {
  const layoutGapAnimationMatch = motionLayoutGapAnimationCapabilityMatch(motion, capability); if (layoutGapAnimationMatch) return layoutGapAnimationMatch;
  const scene3dAnimationMatch = motionScene3DAnimationCapabilityMatch(motion, capability); if (scene3dAnimationMatch) return scene3dAnimationMatch;
  const relationMatch = motionRelationCapabilityMatch(motion, capability);
  if (relationMatch) return relationMatch;
  const behaviorMatch = motionBehaviorCapabilityMatch(motion, capability);
  if (behaviorMatch) return behaviorMatch;
  // GPU feature names describe fixed building blocks. Their valid combinations (for example,
  // rectangular gradients but not ellipse gradients, and adjustment-layer rather than ordinary
  // layer vignette) are owned by the shared static scene compiler.
  if (capability.lane === "gpu") return matchGpuSceneCapability(motion, capability);
  const geometryKeyframes = geometryKeyframesLegacyCapabilityMatch(motion, capability);
  if (geometryKeyframes) return geometryKeyframes;
  const unsupported = motion.layers.flatMap((layer) => {
    if (layer.visible === false) return [];
    if (!capability.layerTypes.includes(layer.type)) {
      return [{
        layerId: layer.id,
        feature: `layer.type:${layer.type}`,
        reason: `Lane ${capability.lane} does not support ${layer.type} layers.`
      }];
    }

    // An encoder's explicit `features` describe encode/delivery work, never visual raster support.
    // Its visual features come from a compatible frame producer, which the card pipeline resolves.
    // Matching them against Motion layer features here would either recreate the unsafe `*` claim or
    // incorrectly reject every visual package before that producer can be considered.
    if (capability.visualFeatureSupport === "inherited-from-frame-lane") return [];

    return requiredLayerFeatures(layer)
      .filter((feature) => !featureSupported(feature, capability.features))
      .map((feature) => ({
        layerId: layer.id,
        feature,
        reason: `Lane ${capability.lane} does not support ${feature} on layer ${layer.id}.`
      }));
  });

  return {
    ok: unsupported.length === 0,
    lane: capability.lane,
    unsupported
  };
}

function matchRendererCapabilityCard(motion: MotionDocument, card: RendererCapabilityCard, options: RendererCapabilityMatchOptions): RendererCapabilityCardMatch {
  const baseCapabilityMatch = gpuScene3DAnimationStrictPreviewCapabilityMatch(motion, card, options)
    ?? gpuRelationsStrictPreviewCapabilityMatch(motion, card, options)
    ?? matchRendererCapability(motion, card);
  // Static GPU planning intentionally admits a governed browser/restricted-shader source so the
  // final streaming producer can bind an exact-time capture. GPU PNG preview never opens that
  // producer, so advertising those layers for a preview would promise a frame it later refuses.
  const gpuPreviewHybridUnsupported = card.lane === "gpu" && options.target === "preview"
    ? motion.layers.flatMap((layer) => {
        if (layer.visible === false) return [];
        const browserSurface = layer.type === "web" || layer.type === "html" || layer.type === "canvas";
        const restrictedShaderSurface = layer.type === "shader" && !layer.shader?.gpuMaterial;
        return browserSurface || restrictedShaderSurface
          ? [{
              layerId: layer.id,
              feature: "gpu.hybrid.final-streaming-only",
              reason: "Lane gpu supports web, html, canvas, and restricted-shader hybrid layers only for governed final video rendering."
            }]
          : [];
      })
    : [];
  const geometryKeyframesTargetUnsupported = gpuGeometryKeyframesTargetUnsupported(motion, card, options);
  const nativeDeliveryTarget = card.lane === "native" && isNativeDeliveryTarget(options.target);
  const nativeDeliveryUnsupported = nativeDeliveryTarget
    ? nativeTextDeliveryIssues(motion).filter((issue) => !baseCapabilityMatch.unsupported.some((unsupported) =>
        unsupported.layerId === issue.layerId && unsupported.feature === "text.charset.non-ascii"))
    : [];
  const customFontUnsupported = card.lane === "native" && !nativeDeliveryTarget
    ? motion.layers.flatMap((layer) => {
        if (layer.visible === false || (layer.type !== "text" && layer.type !== "caption")) return [];
        return requestedNativeTextFontFamily(layer)
          ? [{
              layerId: layer.id,
              feature: "text.font.family",
              reason: `Lane native does not support text.font.family on layer ${layer.id}.`
            }]
          : [];
      })
    : [];
  const extraUnsupported = [...gpuPreviewHybridUnsupported, ...geometryKeyframesTargetUnsupported, ...nativeDeliveryUnsupported, ...customFontUnsupported];
  const capabilityMatch = extraUnsupported.length > 0
    ? { ...baseCapabilityMatch, ok: false, unsupported: [...baseCapabilityMatch.unsupported, ...extraUnsupported] }
    : baseCapabilityMatch;
  const outputOk = !options.output || card.outputs.includes(options.output);
  const targetOk = !options.target || card.renderTargets.includes(options.target);
  const alphaOk = options.needsAlpha !== true || card.alpha;
  const audioOk = options.needsAudio !== true || card.audio !== "none";
  const subtitlesOk = options.needsSubtitles !== true || card.subtitles;
  const reasons = [
    ...capabilityMatch.unsupported.map((item) => item.reason),
    ...(outputOk ? [] : [`Lane ${card.lane} does not output ${options.output}.`]),
    ...(targetOk ? [] : [`Lane ${card.lane} is not intended for ${options.target} targets.`]),
    ...(alphaOk ? [] : [`Lane ${card.lane} does not preserve alpha.`]),
    ...(audioOk ? [] : [`Lane ${card.lane} does not handle audio.`]),
    ...(subtitlesOk ? [] : [`Lane ${card.lane} does not handle subtitles.`])
  ];
  const ok = capabilityMatch.ok && outputOk && targetOk && alphaOk && audioOk && subtitlesOk;
  const score = (ok ? 100 : 0)
    + (options.preferLane && options.preferLane === card.lane ? 20 : 0)
    + (outputOk ? 8 : 0)
    + (targetOk ? 8 : 0)
    + (alphaOk ? 3 : 0)
    + (audioOk ? 3 : 0)
    + (subtitlesOk ? 3 : 0)
    - capabilityMatch.unsupported.length * 10
    - reasons.length * 2;
  return {
    ...capabilityMatch,
    ok,
    id: card.id,
    label: card.label,
    category: card.category,
    outputOk,
    targetOk,
    alphaOk,
    audioOk,
    subtitlesOk,
    score,
    reasons,
    card
  };
}

function featureSupported(feature: string, supportedFeatures: string[]): boolean {
  if (supportedFeatures.includes(feature)) return true;
  const segments = feature.split(".");
  while (segments.length > 1) {
    segments.pop();
    if (supportedFeatures.includes(`${segments.join(".")}.*`)) return true;
  }
  return supportedFeatures.includes("*");
}

function isNativeDeliveryTarget(target: string | undefined): boolean {
  return target === "delivery" || target === "final" || target === "frame-sequence";
}
