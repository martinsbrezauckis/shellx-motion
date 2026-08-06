import type {
  CapabilityMatch,
  MotionDocument,
  RendererCapability,
  RendererCapabilityCard,
  RendererCapabilityCardMatch,
  RendererCapabilityMatchOptions,
  RendererCapabilityMatchResult,
  RendererCapabilityPipeline
} from "./types";
import { compareCodeUnits } from "./canonical-json";
import { requiredLayerFeatures } from "./layer-capability-features";
// The static renderer capability-card catalog lives in ./capability-cards to satisfy the module-size gate.
import { RENDERER_CAPABILITY_CARDS } from "./capability-cards";

export { requiredLayerFeatures } from "./layer-capability-features";

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
      ...(card.runtime.probe ? { probe: { ...card.runtime.probe, args: [...card.runtime.probe.args] } } : {})
    },
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

export function matchRendererCapabilityCards(motion: MotionDocument, options: RendererCapabilityMatchOptions = {}): RendererCapabilityMatchResult {
  const cards = listRendererCapabilityCards();
  const matches = cards
    .map((card) => matchRendererCapabilityCard(motion, card, options))
    .sort((a, b) => b.score - a.score || cards.findIndex((card) => card.lane === a.lane) - cards.findIndex((card) => card.lane === b.lane));
  const recommendedLane = matches.find((match) => match.ok)?.lane ?? null;
  const recommendedPipeline = resolveRendererCapabilityPipeline(matches, recommendedLane);
  return {
    cards,
    matches,
    recommendedLane,
    ...(recommendedPipeline ? { recommendedPipeline } : {})
  };
}

export function resolveRendererCapabilityPipeline(
  matches: RendererCapabilityCardMatch[],
  recommendedLane: string | null
): RendererCapabilityPipeline | undefined {
  if (!recommendedLane) return undefined;
  const recommended = matches.find((match) => match.lane === recommendedLane);
  if (!recommended?.card.requiresFrameLane) return undefined;
  const frameLane = matches.find((match) => isCompatibleFrameLane(match, recommended.lane) && match.lane === "browser")
    ?? matches.find((match) => isCompatibleFrameLane(match, recommended.lane));
  return {
    lanes: frameLane ? [frameLane.lane, recommended.lane] : [recommended.lane],
    ...(frameLane ? { frameLane: frameLane.lane } : {}),
    finalLane: recommended.lane,
    reason: frameLane
      ? `Lane ${recommended.lane} requires ${frameLane.lane} frame capture before final encode.`
      : `Lane ${recommended.lane} requires a compatible frame capture lane before final encode.`
  };
}

function isCompatibleFrameLane(match: RendererCapabilityCardMatch, finalLane: string): boolean {
  return match.lane !== finalLane
    && match.card.outputs.includes("png-frame")
    && match.unsupported.every((item) => isAudioOnlyFrameLaneUnsupported(item.feature));
}

/**
 * Whether a capability-unsupported feature is an audio-only concern that a visual frame lane
 * (native/browser) may legitimately ignore because the final ffmpeg lane muxes audio downstream.
 *
 * Used both by the pipeline resolver (to accept a frame lane whose only gaps are audio) and by the
 * browser runtime gate (to tolerate audio layers instead of failing a delivery frame render).
 */
export function isAudioOnlyFrameLaneUnsupported(feature: string): boolean {
  return feature === "layer.type:audio" || feature === "volume" || feature === "pan" || feature.startsWith("audio.");
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
  const { matches } = matchRendererCapabilityCards(motion);
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
  const unsupported = motion.layers.flatMap((layer) => {
    if (layer.visible === false) return [];
    if (!capability.layerTypes.includes(layer.type)) {
      return [{
        layerId: layer.id,
        feature: `layer.type:${layer.type}`,
        reason: `Lane ${capability.lane} does not support ${layer.type} layers.`
      }];
    }

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
  const baseCapabilityMatch = matchRendererCapability(motion, card);
  const customFontUnsupported = card.lane === "native"
    ? motion.layers.flatMap((layer) => {
        if (layer.visible === false || (layer.type !== "text" && layer.type !== "caption")) return [];
        return readString(readRecord(layer.style).fontFamily)?.trim()
          ? [{
              layerId: layer.id,
              feature: "text.font.family",
              reason: `Lane native does not support text.font.family on layer ${layer.id}.`
            }]
          : [];
      })
    : [];
  const capabilityMatch = customFontUnsupported.length > 0
    ? { ...baseCapabilityMatch, ok: false, unsupported: [...baseCapabilityMatch.unsupported, ...customFontUnsupported] }
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

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
