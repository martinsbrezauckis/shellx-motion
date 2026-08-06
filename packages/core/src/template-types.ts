/**
 * Template authoring type family for ShellX Motion.
 *
 * Role: declaration-only module defining the `Template*` types — params, controls, bindings, metadata
 * (license/provenance/story/media-slots/quality-targets), and the top-level `TemplateDocument`. Extracted
 * verbatim from `types.ts` so the core type barrel no longer carries the full template surface
 * for the module-size architecture gate. Types only; no runtime code, no behavior change.
 *
 * Dependencies: none (self-contained — every `Template*` type references only other types in this file).
 *
 * Primary callers: re-exported by `packages/core/src/types.ts` (and thus `@shellx-motion/core`); consumed
 * by the actions catalog, template loaders/validators, connectors, and the CLI/debug template commands.
 */
export type TemplateParamType = "text" | "number" | "color" | "boolean" | "select" | "media";

export interface TemplateSelectOption {
  label: string;
  value: string | number | boolean;
}

export interface TemplateParam {
  id: string;
  label?: string;
  description?: string;
  type: TemplateParamType;
  defaultValue: string | number | boolean | null;
  group?: string;
  order?: number;
  min?: number;
  max?: number;
  step?: number;
  options?: TemplateSelectOption[];
  unit?: string;
}

export interface TemplateControl {
  paramId: string;
  widget: "text" | "textarea" | "slider" | "stepper" | "color" | "toggle" | "select" | "media" | string;
  label?: string;
  description?: string;
}

export interface TemplateBinding {
  paramId: string;
  target: {
    kind: "motion_path" | "design_token" | "asset_slot" | "cut_payload" | string;
    path: string;
    layerId?: string;
  };
}

export interface TemplateControlGroup {
  id: string;
  label: string;
  order?: number;
}

export type TemplateInputSchema = Record<string, unknown>;

export interface TemplateOutputBounds {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  aspectRatios?: string[];
}

export interface TemplateSuitability {
  bestFor?: string[];
  notFor?: string[];
}

export interface TemplateLicense {
  id: string;
  label?: string;
  url?: string;
  attribution?: string;
  spdxId?: string;
  attributionRequired?: boolean;
  redistributionAllowed?: boolean;
  commercialUse?: boolean;
  notes?: string;
}

export interface TemplateProvenance {
  source?: string;
  sourceUrl?: string;
  sourceHash?: string;
  generatedBy?: string;
}

export interface TemplateAssetAttribution {
  name: string;
  license?: string;
  author?: string;
  url?: string;
  path?: string;
}

export interface TemplatePreviewAssets {
  poster?: string;
  loop?: string;
  thumbnail?: string;
}

export interface TemplatePerformance {
  recommendedLane?: string;
  renderCost?: "low" | "medium" | "high";
  previewFps?: number;
  notes?: string[];
}

/** A bounded editorial beat that tells agents what should be visible and why. */
export interface TemplateStoryBeat {
  id: string;
  label?: string;
  intent: string;
  startMs: number;
  durationMs: number;
  layerIds?: string[];
  mediaParamIds?: string[];
  cameraIntent?: string;
}

/** Machine-readable story structure for template selection and representative-frame review. */
export interface TemplateStory {
  kind?: string;
  beats: TemplateStoryBeat[];
}

export type TemplateMediaKind = "image" | "video";

/** Semantic requirements for a host-editable media param. */
export interface TemplateMediaSlot {
  paramId: string;
  role: string;
  description?: string;
  acceptedKinds: TemplateMediaKind[];
  fit?: "cover" | "contain" | "fill";
  minWidth?: number;
  minHeight?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  rightsRequired?: boolean;
}

/** Deterministic visual thresholds and timestamps used by agent review loops. */
export interface TemplateQualityTargets {
  /** Package-local shellx-motion/quality-manifest@1 used by final-render and review commands. */
  manifest?: string;
  representativeFramesMs: number[];
  minDistinctFrames?: number;
  maxBlankFrames?: number;
  minEdgePixels?: number;
  minLumaRange?: number;
  requireTextFit?: boolean;
  requireSafeAreas?: boolean;
}

export interface TemplateMetadata {
  inputSchema?: TemplateInputSchema;
  inputExamples?: Record<string, unknown>[];
  outputBounds?: TemplateOutputBounds;
  suitability?: TemplateSuitability;
  license?: TemplateLicense;
  assetsAttribution?: TemplateAssetAttribution[];
  preview?: TemplatePreviewAssets;
  provenance?: TemplateProvenance;
  performance?: TemplatePerformance;
  story?: TemplateStory;
  mediaSlots?: TemplateMediaSlot[];
  qualityTargets?: TemplateQualityTargets;
}

export interface TemplateDocument {
  schema: "shellx-motion/template@1";
  id: string;
  name: string;
  motion: string;
  compatibleLanes: string[];
  compatibleHosts?: string[];
  metadata?: TemplateMetadata;
  groups?: TemplateControlGroup[];
  params: TemplateParam[];
  controls: TemplateControl[];
  bindings: TemplateBinding[];
}
