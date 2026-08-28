import {
  listRendererCapabilityCards,
  loadMotionPackage,
  matchRendererCapabilityCards,
  resolveRendererCapabilityPipeline,
  type MotionPackage,
  type RendererCapabilityCard,
  type RendererCapabilityCardMatch,
  type RendererCapabilityMatchOptions,
  type RendererCapabilityPipeline
} from "@shellx-motion/core";
import { readMotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, stringArg } from "./args.js";
import { hostCapacityView } from "./host-capacity-view.js";

interface CapabilitiesPanelRequest {
  output?: string;
  target?: string;
  needsAlpha: boolean;
  needsAudio: boolean;
  needsSubtitles: boolean;
  preferLane?: string;
}
interface CapabilitiesPanelSuggestedAction {
  id: "match" | "exportPlan";
  command: MotionDebugCommand;
  args: Record<string, string | boolean>;
}
interface CapabilitiesPanelCard {
  id: string;
  lane: string;
  category: string; role: RendererCapabilityCard["role"];
  label: string;
  paradigms: string[];
  layerTypes: string[];
  outputs: string[];
  features: string[];
  renderTargets: string[];
  license: string;
  speed: string;
  stability: string;
  strengths: string[];
  weaknesses: string[];
  runtime: RendererCapabilityCard["runtime"]; adapter?: RendererCapabilityCard["adapter"]; colorAlpha?: RendererCapabilityCard["colorAlpha"];
  visualFeatureSupport: NonNullable<RendererCapabilityCard["visualFeatureSupport"]>; frameInputs?: string[];
  requiresFrameLane: boolean;
  support: {
    alpha: boolean;
    audio: string;
    subtitles: boolean;
  };
  supported: boolean;
  recommended: boolean;
  score: number | null;
  outputOk: boolean | null;
  targetOk: boolean | null;
  alphaOk: boolean | null;
  audioOk: boolean | null;
  subtitlesOk: boolean | null;
  unsupportedCount: number;
  reasons: string[];
  badges: string[];
  suggestedActions: CapabilitiesPanelSuggestedAction[];
}
interface CapabilitiesPanelCategory {
  id: string;
  label: string;
  cardCount: number;
  supportedCount: number;
  lanes: string[];
}

interface CapabilitiesPanelSummary {
  cardCount: number;
  laneCount: number;
  categoryCount: number;
  supportedCount: number;
  recommendedLane: string | null;
  recommendedPipeline?: RendererCapabilityPipeline;
}

interface CapabilitiesPanelResult {
  ok: true;
  packageRoot?: string;
  packageId?: string;
  packageName?: string;
  motionId?: string;
  request: CapabilitiesPanelRequest;
  summary: CapabilitiesPanelSummary;
  categories: CapabilitiesPanelCategory[];
  cards: CapabilitiesPanelCard[];
  matches: RendererCapabilityCardMatch[];
  warnings: string[];
}

function buildCapabilitiesPanel(input: {
  packageRoot?: string;
  pkg?: MotionPackage;
  options: RendererCapabilityMatchOptions;
}): CapabilitiesPanelResult {
  const cards = listRendererCapabilityCards();
  const request = capabilitiesPanelRequest(input.options);
  const matched = input.pkg
    ? matchRendererCapabilityCards(input.pkg.motion, input.options)
    : matchRendererCapabilityCardsForRequest(cards, input.options);
  const matchByLane = new Map(matched.matches.map((match) => [match.lane, match]));
  const panelCards = matched.cards.map((card) => buildCapabilitiesPanelCard({
    card,
    match: matchByLane.get(card.lane),
    recommendedLane: matched.recommendedLane,
    packageRoot: input.packageRoot,
    request
  }));
  const categories = buildCapabilitiesPanelCategories(panelCards);
  const summary: CapabilitiesPanelSummary = {
    cardCount: panelCards.length,
    laneCount: new Set(panelCards.map((card) => card.lane)).size,
    categoryCount: categories.length,
    supportedCount: panelCards.filter((card) => card.supported).length,
    recommendedLane: matched.recommendedLane,
    ...(matched.recommendedPipeline ? { recommendedPipeline: matched.recommendedPipeline } : {})
  };

  return {
    ok: true,
    ...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
    ...(input.pkg ? {
      packageId: input.pkg.manifest.id,
      packageName: input.pkg.manifest.name,
      motionId: input.pkg.motion.id
    } : {}),
    request,
    summary,
    categories,
    cards: panelCards,
    matches: matched.matches,
    warnings: []
  };
}

export function matchRendererCapabilityCardsForRequest(cards: RendererCapabilityCard[], options: RendererCapabilityMatchOptions): {
  cards: RendererCapabilityCard[];
  matches: RendererCapabilityCardMatch[];
  recommendedLane: string | null;
  recommendedPipeline?: RendererCapabilityPipeline;
} {
  const matches = cards
    .map((card) => matchRendererCapabilityCardForRequest(card, options))
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

function matchRendererCapabilityCardForRequest(card: RendererCapabilityCard, options: RendererCapabilityMatchOptions): RendererCapabilityCardMatch {
  const outputOk = !options.output || card.outputs.includes(options.output);
  const targetOk = !options.target || card.renderTargets.includes(options.target);
  const alphaOk = options.needsAlpha !== true || card.alpha;
  const audioOk = options.needsAudio !== true || card.audio !== "none";
  const subtitlesOk = options.needsSubtitles !== true || card.subtitles;
  const reasons = [
    ...(outputOk ? [] : [`Lane ${card.lane} does not output ${options.output}.`]),
    ...(targetOk ? [] : [`Lane ${card.lane} is not intended for ${options.target} targets.`]),
    ...(alphaOk ? [] : [`Lane ${card.lane} does not preserve alpha.`]),
    ...(audioOk ? [] : [`Lane ${card.lane} does not handle audio.`]),
    ...(subtitlesOk ? [] : [`Lane ${card.lane} does not handle subtitles.`])
  ];
  const ok = outputOk && targetOk && alphaOk && audioOk && subtitlesOk;
  const score = (ok ? 100 : 0)
    + (options.preferLane && options.preferLane === card.lane ? 20 : 0)
    + (outputOk ? 8 : 0)
    + (targetOk ? 8 : 0)
    + (alphaOk ? 3 : 0)
    + (audioOk ? 3 : 0)
    + (subtitlesOk ? 3 : 0)
    - reasons.length * 2;
  return {
    ok,
    lane: card.lane,
    unsupported: [],
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

function capabilitiesPanelRequest(options: RendererCapabilityMatchOptions): CapabilitiesPanelRequest {
  return {
    ...(options.output ? { output: options.output } : {}),
    ...(options.target ? { target: options.target } : {}),
    needsAlpha: options.needsAlpha === true,
    needsAudio: options.needsAudio === true,
    needsSubtitles: options.needsSubtitles === true,
    ...(options.preferLane ? { preferLane: options.preferLane } : {})
  };
}

function buildCapabilitiesPanelCard(input: {
  card: RendererCapabilityCard;
  match?: RendererCapabilityCardMatch;
  recommendedLane: string | null;
  packageRoot?: string;
  request: CapabilitiesPanelRequest;
}): CapabilitiesPanelCard {
  const reasons = input.match?.reasons ?? [];
  return {
    id: input.card.id,
    lane: input.card.lane,
    category: input.card.category, role: input.card.role, label: input.card.label,
    paradigms: [...input.card.paradigms],
    layerTypes: [...input.card.layerTypes],
    outputs: [...input.card.outputs],
    features: [...input.card.features],
    renderTargets: [...input.card.renderTargets],
    license: input.card.license,
    speed: input.card.speed,
    stability: input.card.stability,
    strengths: [...input.card.strengths],
    weaknesses: [...input.card.weaknesses],
    runtime: {
      ...input.card.runtime,
      ...(input.card.runtime.readiness ? { readiness: { ...input.card.runtime.readiness, tools: [...input.card.runtime.readiness.tools] } } : {})
    }, ...(input.card.colorAlpha ? { colorAlpha: input.card.colorAlpha } : {}),
    visualFeatureSupport: input.card.visualFeatureSupport ?? "direct", ...(input.card.frameInputs ? { frameInputs: [...input.card.frameInputs] } : {}),
    ...(input.card.adapter ? {
      adapter: {
        ...input.card.adapter,
        formats: [...input.card.adapter.formats],
        unsupportedFeatureClasses: [...input.card.adapter.unsupportedFeatureClasses],
        hostCompatibility: [...input.card.adapter.hostCompatibility]
      }
    } : {}),
    requiresFrameLane: input.card.requiresFrameLane === true,
    support: {
      alpha: input.card.alpha,
      audio: input.card.audio,
      subtitles: input.card.subtitles
    },
    supported: input.match?.ok === true,
    recommended: input.card.lane === input.recommendedLane,
    score: input.match?.score ?? null,
    outputOk: input.match?.outputOk ?? null,
    targetOk: input.match?.targetOk ?? null,
    alphaOk: input.match?.alphaOk ?? null,
    audioOk: input.match?.audioOk ?? null,
    subtitlesOk: input.match?.subtitlesOk ?? null,
    unsupportedCount: reasons.length,
    reasons,
    badges: capabilityBadges(input.card),
    suggestedActions: capabilitySuggestedActions(input.packageRoot, input.request)
  };
}

function buildCapabilitiesPanelCategories(cards: CapabilitiesPanelCard[]): CapabilitiesPanelCategory[] {
  const categories = new Map<string, CapabilitiesPanelCategory>();
  for (const card of cards) {
    const existing = categories.get(card.category) ?? {
      id: card.category,
      label: capabilityCategoryLabel(card.category),
      cardCount: 0,
      supportedCount: 0,
      lanes: []
    };
    existing.cardCount += 1;
    existing.supportedCount += card.supported ? 1 : 0;
    existing.lanes.push(card.lane);
    categories.set(card.category, existing);
  }
  return [...categories.values()];
}

function capabilityBadges(card: RendererCapabilityCard): string[] {
  return [
    ...(card.alpha ? ["alpha"] : []),
    ...(card.audio === "none" ? [] : [`audio:${card.audio}`]),
    ...(card.subtitles ? ["subtitles"] : []),
    card.stability,
    card.speed,
    ...(card.requiresFrameLane ? ["requires-frame-lane"] : [])
  ];
}

function capabilitySuggestedActions(packageRoot: string | undefined, request: CapabilitiesPanelRequest): CapabilitiesPanelSuggestedAction[] {
  return [
    { id: "match", command: "motion.capabilities.match", args: capabilityMatchActionArgs(packageRoot, request) },
    { id: "exportPlan", command: "motion.export.plan", args: capabilityExportPlanActionArgs(packageRoot, request) }
  ];
}

function capabilityMatchActionArgs(packageRoot: string | undefined, request: CapabilitiesPanelRequest): Record<string, string | boolean> {
  return compactCapabilityArgs({
    packageRoot,
    output: request.output,
    target: request.target,
    needsAlpha: request.needsAlpha,
    needsAudio: request.needsAudio,
    needsSubtitles: request.needsSubtitles,
    preferLane: request.preferLane
  });
}

function capabilityExportPlanActionArgs(packageRoot: string | undefined, request: CapabilitiesPanelRequest): Record<string, string | boolean> {
  const preset = request.output ? readMotionExportPreset(request.output) ?? undefined : undefined;
  return compactCapabilityArgs({
    packageRoot,
    preset,
    target: request.target,
    needsAlpha: request.needsAlpha,
    needsAudio: request.needsAudio
  });
}

function compactCapabilityArgs(values: Record<string, string | boolean | undefined>): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    args[key] = value;
  }
  return args;
}

function capabilityCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    preview: "Preview",
    final: "Final",
    connector: "Connector",
    adapter: "Adapter"
  };
  return labels[category] ?? category;
}

export async function dispatchCapabilitiesCommand(command: MotionDebugCommand, args: unknown): Promise<MotionDebugResult | null> {
  if (command === "motion.capabilities.match") {
    const packageRoot = stringArg(args, "packageRoot");
    const output = stringArg(args, "output") ?? undefined;
    const target = stringArg(args, "target") ?? undefined;
    const needsAlpha = booleanArg(args, "needsAlpha") ?? false;
    const needsAudio = booleanArg(args, "needsAudio") ?? false;
    const needsSubtitles = booleanArg(args, "needsSubtitles") ?? false;
    const preferLane = stringArg(args, "preferLane") ?? undefined;
    const cards = listRendererCapabilityCards();
    if (!packageRoot) {
      return {
        ok: true,
        visibleState: {
          panel: "capabilities",
          operation: "capabilities.match",
          cardCount: cards.length,
          recommendedLane: null,
          ...(output ? { output } : {}),
          ...(target ? { target } : {})
        },
        result: {
          ok: true,
          ...hostCapacityView(),
          cards,
          matches: [],
          recommendedLane: null,
          ...(output ? { output } : {}),
          ...(target ? { target } : {})
        },
        warnings: []
      };
    }

    try {
      const pkg = await loadMotionPackage(packageRoot);
      const matched = matchRendererCapabilityCards(pkg.motion, {
        output,
        target,
        needsAlpha,
        needsAudio,
        needsSubtitles,
        preferLane
      });
      return {
        ok: true,
        visibleState: {
          panel: "capabilities",
          operation: "capabilities.match",
          packageId: pkg.manifest.id,
          motionId: pkg.motion.id,
          recommendedLane: matched.recommendedLane,
          ...(matched.recommendedPipeline ? { recommendedPipeline: matched.recommendedPipeline.lanes } : {}),
          cardCount: matched.cards.length,
          matchCount: matched.matches.length,
          ...(output ? { output } : {}),
          ...(target ? { target } : {})
        },
        result: {
          ok: true,
          packageId: pkg.manifest.id,
          motionId: pkg.motion.id,
          ...hostCapacityView(pkg.motion.layers),
          ...matched,
          ...(output ? { output } : {}),
          ...(target ? { target } : {})
        },
        warnings: []
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "capabilities_match_failed",
          message: error instanceof Error ? error.message : String(error)
        },
        warnings: []
      };
    }
  }

  if (command === "motion.capabilities.panel") {
    const packageRoot = stringArg(args, "packageRoot") ?? undefined;
    const output = stringArg(args, "output") ?? undefined;
    const target = stringArg(args, "target") ?? undefined;
    const needsAlpha = booleanArg(args, "needsAlpha") ?? false;
    const needsAudio = booleanArg(args, "needsAudio") ?? false;
    const needsSubtitles = booleanArg(args, "needsSubtitles") ?? false;
    const preferLane = stringArg(args, "preferLane") ?? undefined;
    const options: RendererCapabilityMatchOptions = {
      output,
      target,
      needsAlpha,
      needsAudio,
      needsSubtitles,
      preferLane
    };

    try {
      const pkg = packageRoot ? await loadMotionPackage(packageRoot) : undefined;
      const panel = buildCapabilitiesPanel({
        packageRoot,
        pkg,
        options
      });
      return {
        ok: true,
        visibleState: {
          panel: "capabilities",
          operation: "capabilities.panel",
          cardCount: panel.summary.cardCount,
          categoryCount: panel.summary.categoryCount,
          laneCount: panel.summary.laneCount,
          ...(panel.packageId ? { packageId: panel.packageId } : {}),
          recommendedLane: panel.summary.recommendedLane,
          ...(panel.summary.recommendedPipeline ? { recommendedPipeline: panel.summary.recommendedPipeline.lanes } : {}),
          ...(output ? { output } : {}),
          ...(target ? { target } : {})
        },
        result: panel,
        warnings: panel.warnings
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "capabilities_panel_failed",
          message: error instanceof Error ? error.message : String(error)
        },
        warnings: []
      };
    }
  }

  return null;
}
