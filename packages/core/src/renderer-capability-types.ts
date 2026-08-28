import type { RendererColorAlphaCapability } from "./color-alpha-types";
import type { RendererTypographyCapability } from "./renderer-typography-capability";

export interface RendererCapability {
  lane: "native" | "browser" | "ffmpeg" | "cut" | "canvas" | "hosted" | string;
  layerTypes: string[];
  outputs: string[];
  /** Whether `features` are direct visual support or delivery work supplied by a frame producer. */
  visualFeatureSupport?: "direct" | "inherited-from-frame-lane";
  features: string[];
}

export type RendererCapabilityAudio = "none" | "passthrough" | "mux" | "mix";
export type RendererRuntimeAvailability = "bundled" | "external-binary" | "host-connector" | "hosted";

/** Dynamic readiness through Motion's resolver, never an independently guessed binary command. */
export interface RendererRuntimeReadiness { command: "motion.platform.requirements"; tools: string[]; }

export interface RendererRuntimeRequirement {
  availability: RendererRuntimeAvailability;
  requirement: string;
  cost: "local-cpu" | "host-dependent" | "hosted-metered";
  readiness?: RendererRuntimeReadiness;
  setupHint: string;
}

export interface RendererAdapterCapability {
  formats: string[];
  unsupportedFeatureClasses: string[];
  expectedLossiness: string;
  previewLaneRequirement: string;
  finalLaneRequirement: string;
  hostCompatibility: string[];
}

export interface RendererCapabilityCard extends RendererCapability {
  id: string;
  label: string;
  category: "preview" | "final" | "connector" | "adapter";
  role: "frame-producer" | "encoder" | "connector" | "adapter";
  visualFeatureSupport: NonNullable<RendererCapability["visualFeatureSupport"]>;
  paradigms: string[];
  alpha: boolean;
  audio: RendererCapabilityAudio;
  subtitles: boolean;
  renderTargets: string[];
  license: string;
  speed: "fast" | "medium" | "slow";
  stability: "stable" | "experimental" | "degraded";
  strengths: string[];
  weaknesses: string[];
  runtime: RendererRuntimeRequirement;
  colorAlpha?: RendererColorAlphaCapability;
  typography?: RendererTypographyCapability;
  /** Artifacts an encoder consumes from a frame producer; undefined for lanes that make pixels. */
  frameInputs?: string[];
  requiresFrameLane?: boolean;
  adapter?: RendererAdapterCapability;
}

export interface CapabilityMatch {
  ok: boolean;
  lane: string;
  unsupported: Array<{ layerId: string; feature: string; reason: string }>;
}

export interface RendererCapabilityMatchOptions {
  output?: string;
  target?: string;
  needsAlpha?: boolean;
  needsAudio?: boolean;
  needsSubtitles?: boolean;
  preferLane?: string;
}

export interface RendererCapabilityCardMatch extends CapabilityMatch {
  id: string;
  label: string;
  category: RendererCapabilityCard["category"];
  outputOk: boolean;
  targetOk: boolean;
  alphaOk: boolean;
  audioOk: boolean;
  subtitlesOk: boolean;
  score: number;
  reasons: string[];
  card: RendererCapabilityCard;
}

export interface RendererCapabilityPipeline {
  lanes: string[];
  frameLane?: string;
  finalLane: string;
  reason: string;
}

export interface RendererCapabilityMatchResult {
  cards: RendererCapabilityCard[];
  matches: RendererCapabilityCardMatch[];
  recommendedLane: string | null;
  recommendedPipeline?: RendererCapabilityPipeline;
}
