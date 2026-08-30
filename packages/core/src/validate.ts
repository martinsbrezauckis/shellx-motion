import { MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS, MAX_BROWSER_WORKFLOW_WAIT_MS } from "./browser-workflow";
import { isSupportedMotionColorString } from "./color";
import { validateMotionColorPipeline } from "./color-pipeline";
import { validateMotionDocumentAudioMaster } from "./motion-document-audio-validation";
import { GENERATED_VISUAL_LAYER_TYPE_SET } from "./generated-visual-layer-types";
import { validateMotionPointCloudLayers } from "./motion-points";
import { validateMotionShapeGeometryLayers } from "./motion-shape-geometry";
import { validateMotionGradientColorKeyframes } from "./motion-gradient-color-keyframes";
import { validateMotionTextRunsLayers } from "./motion-text-runs";
import { validateMotionTrailLayers } from "./motion-trail-validation";
import { validateMotionGroups } from "./motion-group-validation"; import { validateMotionEffectModuleLayers } from "./effect-module";
import { isJobInFlight } from "./generated/job-status";
// Keyframe wrong-field-name diagnosis is core's, shared with the evaluator's readability gate and
// with `unreadableKeyframesRefusal`, so validate and the refusal name the same mistake.
import { motionKeyframeTimeAlias, motionKeyframeValueAlias } from "./keyframe-readability";
import { ENVIRONMENT_KINDS, ENVIRONMENT_QUALITY_TIERS, ENVIRONMENT_SCHEMA, MAX_ENVIRONMENT_LAYERS, MAX_FOG_DEPTH_LAYERS, MAX_RAIN_DEPTH_LAYERS, MAX_SNOW_DEPTH_LAYERS, MAX_WATER_WAVE_OCTAVES } from "./environment";
import { parseMotionPathViewBox, validateMotionPathData } from "./path-contract";
import { assertMotionPathRevealLayer, isPathRevealKeyframeTarget } from "./path-reveal";
import { validateMotionDocumentGraphs } from "./motion-document-graphs";
import { motionDocumentRootPreflight } from "./motion-document-root-preflight";
import { validateMotionLayoutApplicationRecords } from "./motion-layout-application-validation";
import { validateLayerMattes } from "./motion-matte-validate";
import { isSafeShaderUniformName, MAX_RESTRICTED_SHADER_UNIFORMS, RESTRICTED_SHADER_LANGUAGE, RESTRICTED_SHADER_SCHEMA } from "./shader-plugin";
import { validateGpuMaterialExtension } from "./gpu-material-contract";
import { validateScene3DLayers } from "./scene-3d-validate";
import { validateSpatialKeyframes } from "./spatial-path";
import { readEasingValidationError } from "./timeline";
import { validateTrackingAnalysis, validateTrackingAnalysisLifecycle } from "./tracking-analysis";
import { validateLayerKeyingAndRoto } from "./keying";
import { validatePackageRenderLineage } from "./package-render-lineage";
import { validateParticleEmitterV2Extensions, validateParticleField } from "./particle-field-validate";
import { validateParticleComputeDensity } from "./particle-compute-validation";
// The schema registry data lives in ./validate-schemas to satisfy the module-size gate.
import { SCHEMAS } from "./validate-schemas";
import { validatePlatformVerificationEvidenceFields } from "./validate-platform-verification";
import { validateSupportBundleDocument } from "./support-bundle-validation";
export type SchemaName =
  | "motion"
  | "packageManifest"
  | "qualityManifest"
  | "expectedPreview"
  | "browserWorkflow"
  | "browserWorkflowTrace"
  | "browserWorkflowCatalog"
  | "resourceCatalog"
  | "cutImportPlan"
  | "supportBundle"
  | "scriptedVideo"
  | "dataRows"
  | "durationPolicy"
  | "timelineState"
  | "trackingAnalysis"
  | "trackingLifecycle"
  | "template"
  | "asset"
  | "receipt"
  | "actions"
  | "action"
  | "debugContracts"
  | "debug"
  | "renderJobHandoff"
  | "promptJobHandoff"
  | "platformVerification"
  | "platformVerificationAggregate";

export interface LoadedSchema {
  name: SchemaName;
  schema: string;
  required: string[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: Array<{ path: string; message: string }> };

const SUPPORTED_PERMISSION_TIERS = new Set(["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"]);
const SUPPORTED_KEYFRAME_TARGETS = new Set([
  "transform.x",
  "transform.y",
  "transform.width",
  "transform.height",
  "transform.originX",
  "transform.originY",
  "transform.scale",
  "transform.rotation",
  "opacity",
  "volume",
  "pan",
  "blendMode",
  "playbackRate",
  "fill",
  "style.fill",
  "style.color",
  "style.stroke",
  "style.borderColor",
  "style.backgroundColor",
  "style.background",
  "style.strokeWidth",
  "style.borderWidth",
  "style.fontSize",
  "style.fontWeight",
  "style.letterSpacing",
  "style.textAlign",
  "style.verticalAlign",
  "style.alignY",
  "style.lineHeight",
  "style.width",
  "style.height",
  "style.radius",
  "style.borderRadius",
  "style.padding",
  "style.paddingX",
  "style.paddingY",
  "style.paddingTop",
  "style.paddingRight",
  "style.paddingBottom",
  "style.paddingLeft",
  "mask.inset.top",
  "mask.inset.right",
  "mask.inset.bottom",
  "mask.inset.left",
  "crop.x",
  "crop.y",
  "crop.width",
  "crop.height",
  "style.shadow.x",
  "style.shadow.y",
  "style.shadow.offsetX",
  "style.shadow.offsetY",
  "style.shadow.blur",
  "style.shadow.spread",
  "style.shadow.blurRadius",
  "style.shadow.spreadRadius",
  "style.shadow.color",
  "style.textShadow.x",
  "style.textShadow.y",
  "style.textShadow.offsetX",
  "style.textShadow.offsetY",
  "style.textShadow.blur",
  "style.textShadow.blurRadius",
  "style.textShadow.color",
  "effects.blur",
  "effects.brightness",
  "effects.contrast",
  "effects.saturate",
  "effects.grayscale",
  "effects.glow.radius",
  "effects.glow.color",
  "pathReveal.start",
  "pathReveal.end",
  "gradient.angle",
  "environment.intensity",
  "environment.wind",
  "environment.dropSpeed",
  "environment.dropLength",
  "environment.ground.horizon",
  "environment.ground.wetness",
  "environment.ground.roughness",
  "environment.ground.rippleAmount",
  "environment.ground.splashAmount",
  "environment.ground.reflectionStrength",
  "environment.atmosphere.mist",
  "environment.atmosphere.lensDroplets",
  "environment.surface.horizon",
  "environment.surface.waveScale",
  "environment.surface.waveHeight",
  "environment.surface.waveSpeed",
  "environment.surface.direction",
  "environment.surface.choppiness",
  "environment.optics.reflectionStrength",
  "environment.optics.refractionStrength",
  "environment.optics.fresnel",
  "environment.optics.caustics",
  "environment.optics.clarity",
  "environment.optics.foam",
  "environment.fall.intensity",
  "environment.fall.speed",
  "environment.fall.wind",
  "environment.fall.turbulence",
  "environment.fall.flakeSize",
  "environment.fall.focusFalloff",
  "environment.ground.accumulation",
  "environment.ground.drift",
  "environment.ground.contactAmount",
  "environment.atmosphere.haze",
  "environment.atmosphere.depthFade",
  "environment.fog.density",
  "environment.fog.speed",
  "environment.fog.scale",
  "environment.fog.turbulence",
  "environment.fog.height",
  "environment.fog.lightStrength"
]);
const ENVIRONMENT_KEYFRAME_RANGES: Record<string, [number, number]> = {
  "environment.intensity": [0, 1],
  "environment.wind": [-2, 2],
  "environment.dropSpeed": [0.1, 5],
  "environment.dropLength": [0.1, 2],
  "environment.ground.horizon": [0.15, 0.9],
  "environment.ground.wetness": [0, 1],
  "environment.ground.roughness": [0, 1],
  "environment.ground.rippleAmount": [0, 1],
  "environment.ground.splashAmount": [0, 1],
  "environment.ground.reflectionStrength": [0, 1],
  "environment.atmosphere.mist": [0, 1],
  "environment.atmosphere.lensDroplets": [0, 1],
  "environment.surface.horizon": [0.1, 0.9],
  "environment.surface.waveScale": [0.1, 20],
  "environment.surface.waveHeight": [0, 1],
  "environment.surface.waveSpeed": [0.05, 5],
  "environment.surface.direction": [-180, 180],
  "environment.surface.choppiness": [0, 1],
  "environment.optics.reflectionStrength": [0, 1],
  "environment.optics.refractionStrength": [0, 1],
  "environment.optics.fresnel": [0, 1],
  "environment.optics.caustics": [0, 1],
  "environment.optics.clarity": [0, 1],
  "environment.optics.foam": [0, 1],
  "environment.fall.intensity": [0, 1],
  "environment.fall.speed": [0.05, 3],
  "environment.fall.wind": [-2, 2],
  "environment.fall.turbulence": [0, 1],
  "environment.fall.flakeSize": [0.1, 3],
  "environment.fall.focusFalloff": [0, 1],
  "environment.ground.accumulation": [0, 1],
  "environment.ground.drift": [0, 1],
  "environment.ground.contactAmount": [0, 1],
  "environment.atmosphere.haze": [0, 1],
  "environment.atmosphere.depthFade": [0, 1],
  "environment.fog.density": [0, 1],
  "environment.fog.speed": [0.01, 3],
  "environment.fog.scale": [0.1, 12],
  "environment.fog.turbulence": [0, 1],
  "environment.fog.height": [0, 1],
  "environment.fog.lightStrength": [0, 1]
};
const NON_NEGATIVE_KEYFRAME_TARGETS = new Set([
  "volume",
  "style.width",
  "style.height",
  "style.radius",
  "style.borderRadius",
  "style.padding",
  "style.paddingX",
  "style.paddingY",
  "style.paddingTop",
  "style.paddingRight",
  "style.paddingBottom",
  "style.paddingLeft",
  "mask.inset.top",
  "mask.inset.right",
  "mask.inset.bottom",
  "mask.inset.left",
  "crop.x",
  "crop.y",
  "style.strokeWidth",
  "style.borderWidth",
  "style.shadow.blur",
  "style.shadow.spread",
  "style.shadow.blurRadius",
  "style.shadow.spreadRadius",
  "style.textShadow.blur",
  "style.textShadow.blurRadius",
  "effects.blur",
  "effects.brightness",
  "effects.contrast",
  "effects.saturate",
  "effects.grayscale",
  "effects.glow.radius"
]);
const PAN_KEYFRAME_TARGETS = new Set(["pan"]);
const BLEND_MODE_KEYFRAME_TARGETS = new Set(["blendMode"]);
const POSITIVE_KEYFRAME_TARGETS = new Set(["playbackRate", "style.fontSize", "style.fontWeight", "style.lineHeight", "crop.width", "crop.height"]);
const COLOR_KEYFRAME_TARGETS = new Set(["fill", "style.fill", "style.color", "style.stroke", "style.borderColor", "style.backgroundColor", "style.background", "style.shadow.color", "style.textShadow.color", "effects.glow.color"]);
const TEXT_ALIGN_KEYFRAME_VALUES = ["left", "center", "right"] as const;
const VERTICAL_ALIGN_KEYFRAME_VALUES = ["top", "middle", "center", "bottom"] as const;
const SUPPORTED_TRANSITIONS = new Set(["fade", "slide", "wipe"]);
const SUPPORTED_SLIDE_DIRECTIONS = new Set(["left", "right", "up", "down"]);
const SUPPORTED_WIPE_DIRECTIONS = new Set(["left", "right", "up", "down"]);
const SUPPORTED_EFFECTS = ["blur", "brightness", "contrast", "saturate", "grayscale"] as const;
const MAX_MOTION_BLUR_SAMPLES = 8;
const MAX_MOTION_BLUR_SAMPLE_BUDGET = 64;
const MAX_MOTION_BLUR_VIDEO_SAMPLES = 4;
const MAX_MOTION_BLUR_VIDEO_SAMPLE_BUDGET = 16;
const MAX_ADJUSTMENT_LAYERS = 8;
const MAX_PARTICLE_LIFETIME_MS = 60_000;
const SUPPORTED_BLEND_MODES = new Set([
  "normal",
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
const SUPPORTED_TEMPLATE_PARAM_TYPES = new Set(["text", "number", "color", "boolean", "select", "media"]);
const SUPPORTED_PLATFORM_VERIFICATION_STATUSES = new Set(["planned", "running", "passed", "failed"]);
const SUPPORTED_PLATFORM_COMMAND_STATUSES = new Set(["planned", "pending", "running", "passed", "failed", "skipped"]);
const SUPPORTED_PLATFORM_MATRIX_STATUSES = new Set(["complete", "partial"]);
const SUPPORTED_BROWSER_WORKFLOW_NETWORK_POLICIES = new Set(["blocked-unless-declared", "allow"]);
const SUPPORTED_BROWSER_WORKFLOW_ACTIONS = new Set(["wait", "click", "type", "press", "scroll", "verify"]);
const SUPPORTED_BROWSER_WORKFLOW_TRACE_STATUSES = new Set(["passed", "failed"]);
const SUPPORTED_BROWSER_WORKFLOW_TRACE_ERROR_CODES = new Set(["action_failed", "text_mismatch"]);
const SUPPORTED_BROWSER_CAPTURE_FONT_READINESS = new Set(["ready", "unsupported", "timeout", "error"]);
const SUPPORTED_BROWSER_WORKFLOW_DRIFT_STATUSES = new Set(["new", "matched", "changed"]);
const SUPPORTED_RECEIPT_STATUSES = new Set(["passed", "failed", "warning", "not_run"]);
const SUPPORTED_RECEIPT_ARTIFACT_STATUSES = new Set(["available", "planned", "not_required", "failed"]);
// Kept in lockstep with ReceiptActorKind/ReceiptActorTransport (types.ts) and receipt.schema.json.
const SUPPORTED_RECEIPT_ACTOR_KINDS = new Set(["agent", "human", "host", "unknown"]);
const SUPPORTED_RECEIPT_ACTOR_TRANSPORTS = new Set(["cli", "http", "ws", "mcp", "sdk", "connector"]);
const SUPPORTED_CUT_IMPORT_MODES = new Set(["rendered_media", "live_overlay", "editable_lowering"]);
const SUPPORTED_CUT_RENDER_STATES = new Set(["required", "dry_run", "artifact"]);
const SUPPORTED_DURATION_RESIZE_MODES = new Set(["stretch-middle", "ripple", "fixed"]);
const SUPPORTED_CUT_IMPORT_OPERATION_VERBS = new Set([
  "cut.title.create",
  "cut.shape.create",
  "cut.caption.create",
  "cut.media.create",
  "cut.timeline.track.create",
  "cut.timeline.scene.create",
  "cut.timeline.marker.create",
  "cut.media.import_rendered",
  "cut.motion_overlay.create"
]);
// These legacy primitives have a complete Browser paint implementation. Legacy path/freeform
// data remains outside this set until its closure can be established by the same typed contract as
// v1 geometry; accepting it here would turn an open contour into an implicit fill.
const BROWSER_GRADIENT_SHAPES = new Set(["rect", "rectangle", "rounded-rect", "ellipse", "triangle", "star"]);
const SCRIPTED_VIDEO_MAX_FRAME_COUNT = 120;
const SCRIPTED_VIDEO_MAX_TOTAL_DURATION_MS = 600_000;

export async function loadSchema(name: SchemaName): Promise<LoadedSchema> {
  return loadSchemaSync(name);
}

/** Synchronous form used by pure Core mutations before they return a new document value. */
export function loadSchemaSync(name: SchemaName): LoadedSchema { return SCHEMAS[name]; }

export async function validateDocument(schema: LoadedSchema, document: unknown): Promise<ValidationResult> {
  return validateDocumentSync(schema, document);
}

export function validateDocumentSync(schema: LoadedSchema, document: unknown): ValidationResult {
  if (schema.name === "motion") { const rootProblem = motionDocumentRootPreflight(document); if (rootProblem) return { ok: false, errors: [rootProblem] }; }
  const record = readRecord(document);
  if (!record) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  const errors: Array<{ path: string; message: string }> = [];
  validateSafeObjectKeys(document, "", errors);
  for (const field of schema.required) {
    if (!(field in record)) {
      errors.push({ path: `/${field}`, message: "required" });
    }
  }

  if ("schema" in record && record.schema !== schema.schema) {
    errors.push({ path: "/schema", message: `must equal ${schema.schema}` });
  }
  if (schema.name === "motion") {
    validateMotionDocumentScalars(record, errors);
    validateMotionColorPipeline(record.colorPipeline, "/colorPipeline", errors);
    validateMotionLayoutApplicationRecords(record, errors);
    if ("layers" in record && !Array.isArray(record.layers)) {
      errors.push({ path: "/layers", message: "must be an array" });
    }
    if ("assets" in record && !Array.isArray(record.assets)) {
      errors.push({ path: "/assets", message: "must be an array" });
    }
    if (Array.isArray(record.assets)) validateMotionAssets(record.assets, errors);
    const layerIds = Array.isArray(record.layers) ? validateMotionLayers(record.layers, errors) : new Set<string>();
    if (Array.isArray(record.layers)) validateMotionGroups(record.layers, errors);
    validateMotionDocumentGraphs(record, errors);
    if (Array.isArray(record.layers)) validateLayerMattes(record.layers, layerIds, errors);
    if (Array.isArray(record.layers)) validateCameraLayers(record.layers, errors);
    if (Array.isArray(record.layers)) validateShaderLayers(record.layers, Array.isArray(record.assets) ? record.assets : [], errors);
    if (Array.isArray(record.layers)) validateScene3DLayers(record.layers, errors);
    if (Array.isArray(record.layers)) {
      validateEnvironmentLayers(
        record.layers,
        readFiniteNumber(record.width),
        readFiniteNumber(record.height),
        errors
      );
    }
    if (Array.isArray(record.layers)) validateDepthLayers(record.layers, errors);
    if (Array.isArray(record.layers)) { validateMotionEffectModuleLayers(record.layers, errors); validateAdjustmentLayers(record.layers, errors); }
    if (Array.isArray(record.layers)) validateMotionBlurBudget(record.layers, errors);
    if (Array.isArray(record.layers)) validateMotionTrailLayers(record.layers, errors);
    if (Array.isArray(record.layers)) {
      validateMotionPointCloudLayers(record.layers, readPositiveFiniteNumber(record.durationMs) ?? undefined, errors);
    }
    if (Array.isArray(record.layers)) validateMotionShapeGeometryLayers(record.layers, errors);
    if (Array.isArray(record.layers)) validateMotionTextRunsLayers(record.layers, Array.isArray(record.assets) ? record.assets : [], errors);
    const durationMs = readPositiveFiniteNumber(record.durationMs) ?? undefined;
    const trackIds = validateTimelineTracks(record, layerIds, errors);
    const markerIds = collectTimelineMarkerIds(record);
    validateTimelineScenes(record, layerIds, trackIds, markerIds, durationMs, errors);
    validateTimelineMarkers(record, durationMs, errors);
    validateMotionSafeAreas(record, errors);
    if (Array.isArray(record.layers)) {
      record.layers.forEach((layer, layerIndex) => {
        validateLayerTimelineRefs(layer, `/layers/${layerIndex}`, trackIds, errors);
        validateLayerTransform(layer, `/layers/${layerIndex}`, errors);
        validateLayerTextFit(layer, `/layers/${layerIndex}`, record.safeAreas, errors);
        validateLayerCrop(layer, `/layers/${layerIndex}`, errors);
        validateLayerPathReveal(layer, `/layers/${layerIndex}`, errors);
        validateLayerKeyframes(layer, `/layers/${layerIndex}`, errors);
        validateLayerTransitions(layer, `/layers/${layerIndex}`, errors);
        validateLayerMask(layer, `/layers/${layerIndex}`, errors);
        errors.push(...validateLayerKeyingAndRoto(layer, `/layers/${layerIndex}`));
        validateLayerEffects(layer, `/layers/${layerIndex}`, errors);
        validateLayerGradient(layer, `/layers/${layerIndex}`, errors);
        validateParticleEmitter(layer, `/layers/${layerIndex}`, errors);
        validateLayerBlendMode(layer, `/layers/${layerIndex}`, errors);
        validateVideoLayerControls(layer, `/layers/${layerIndex}`, errors);
        validateAudioLayerControls(layer, `/layers/${layerIndex}`, layerIds, errors);
      });
    }
  }
  if (schema.name === "packageManifest") {
    validatePackageManifestDocument(record, errors);
  }
  if (schema.name === "qualityManifest") {
    validateQualityManifestDocument(record, errors);
  }
  if (schema.name === "expectedPreview") {
    validateExpectedPreviewDocument(record, errors);
  }
  if (schema.name === "browserWorkflow") {
    validateBrowserWorkflowDocument(record, errors);
  }
  if (schema.name === "browserWorkflowTrace") {
    validateBrowserWorkflowTraceDocument(record, errors);
  }
  if (schema.name === "browserWorkflowCatalog") {
    validateBrowserWorkflowCatalogDocument(record, errors);
  }
  if (schema.name === "resourceCatalog") {
    validateResourceCatalogDocument(record, errors);
  }
  if (schema.name === "cutImportPlan") {
    validateCutImportPlanDocument(record, errors);
  }
  if (schema.name === "supportBundle") {
    validateSupportBundleDocument(record, errors);
  }
  if (schema.name === "scriptedVideo") {
    validateScriptedVideoDocument(record, errors);
  }
  if (schema.name === "dataRows") {
    validateDataRowsDocument(record, errors);
  }
  if (schema.name === "durationPolicy") {
    validateDurationPolicyDocument(record, errors);
  }
  if (schema.name === "timelineState") {
    validateTimelineStateDocument(record, errors);
  }
  if (schema.name === "trackingAnalysis") {
    errors.push(...validateTrackingAnalysis(record).map((message) => ({ path: "", message })));
  }
  if (schema.name === "trackingLifecycle") {
    errors.push(...validateTrackingAnalysisLifecycle(record).map((message) => ({ path: "", message })));
  }
  if (schema.name === "receipt") {
    validateReceiptDocument(record, errors);
  }
  if (schema.name === "actions") {
    validateActionsRegistryDocument(record, errors);
  }
  if (schema.name === "template") {
    validateTemplateDocument(record, errors);
  }
  if (schema.name === "action") {
    validateActionDocument(record, errors);
  }
  if (schema.name === "debugContracts") {
    validateDebugContractsRegistryDocument(record, errors);
  }
  if (schema.name === "debug") {
    validateDebugCommandDocument(record, errors);
  }
  if (schema.name === "renderJobHandoff") {
    validateRenderJobHandoffDocument(record, errors);
  }
  if (schema.name === "promptJobHandoff") {
    validatePromptJobHandoffDocument(record, errors);
  }
  if (schema.name === "platformVerification") {
    validatePlatformVerificationDocument(record, errors);
  }
  if (schema.name === "platformVerificationAggregate") {
    validatePlatformVerificationAggregateDocument(record, errors);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function validateMotionAssets(
  assets: unknown[],
  errors: Array<{ path: string; message: string }>
): void {
  const fontIds = new Set<string>();
  const fontFaces = new Set<string>();
  let fontCount = 0;
  assets.forEach((asset, index) => {
    const record = readRecord(asset);
    if (!record || record.type !== "font") return;
    const path = `/assets/${index}`;
    fontCount += 1;
    if (fontCount > 32) errors.push({ path: "/assets", message: "must contain at most 32 font assets" });
    validateRequiredFields(record, path, ["id", "type", "family", "source"], errors);
    const id = readNonEmptyString(record.id);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      errors.push({ path: `${path}/id`, message: "must be a safe non-empty font asset id" });
    } else if (fontIds.has(id)) {
      errors.push({ path: `${path}/id`, message: "must be unique among font assets" });
    } else {
      fontIds.add(id);
    }
    const family = readNonEmptyString(record.family);
    if (!family || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(family)) {
      errors.push({ path: `${path}/family`, message: "must be a safe ASCII font-family alias" });
    }
    const source = readRecord(record.source);
    if (!source) {
      errors.push({ path: `${path}/source`, message: "must be an object" });
    } else {
      validateRequiredFields(source, `${path}/source`, ["path", "mimeType"], errors);
      if (!readNonEmptyString(source.path)) errors.push({ path: `${path}/source/path`, message: "must be a non-empty string" });
      if (!["font/woff2", "font/woff", "font/ttf", "font/otf"].includes(String(source.mimeType ?? ""))) {
        errors.push({ path: `${path}/source/mimeType`, message: "must be font/woff2, font/woff, font/ttf, or font/otf" });
      }
    }
    if (record.weight !== undefined && (!Number.isInteger(record.weight) || Number(record.weight) < 1 || Number(record.weight) > 1000)) {
      errors.push({ path: `${path}/weight`, message: "must be an integer from 1 to 1000" });
    }
    if (record.style !== undefined && !["normal", "italic", "oblique"].includes(String(record.style))) {
      errors.push({ path: `${path}/style`, message: "must be normal, italic, or oblique" });
    }
    if (family) {
      const face = `${family.toLowerCase()}\u0000${record.weight ?? 400}\u0000${record.style ?? "normal"}`;
      if (fontFaces.has(face)) errors.push({ path, message: "duplicates a font family, weight, and style face" });
      else fontFaces.add(face);
    }
  });
}

function validatePackageManifestDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  for (const field of ["id", "name", "motion", "sourceApp"]) {
    validateNonEmptyStringField(record, field, `/${field}`, errors);
  }
  for (const field of ["template", "workflow", "selectedFrameId"]) {
    if (field in record && !readNonEmptyString(record[field])) {
      errors.push({ path: `/${field}`, message: "must be a non-empty string" });
    }
  }
  if ("assets" in record) validateStandaloneStringArray(record.assets, "/assets", errors);

  if ("quality" in record) {
    const quality = readRecord(record.quality);
    if (!quality) {
      errors.push({ path: "/quality", message: "must be an object" });
    } else if ("maxFontFallbacks" in quality && !isNonNegativeInteger(quality.maxFontFallbacks)) {
      errors.push({ path: "/quality/maxFontFallbacks", message: "must be a non-negative integer" });
    }
  }

  const compatibility = readRecord(record.compatibility);
  if (!compatibility) {
    if (record.compatibility !== undefined) errors.push({ path: "/compatibility", message: "must be an object" });
    return;
  }
  validateRequiredFields(compatibility, "/compatibility", ["lanes", "hosts"], errors);
  if ("lanes" in compatibility) validateStandaloneStringArray(compatibility.lanes, "/compatibility/lanes", errors);
  if ("hosts" in compatibility) validateStandaloneStringArray(compatibility.hosts, "/compatibility/hosts", errors);
}

function validateRenderJobHandoffDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  for (const field of ["jobId", "receiptId", "receiptPath", "operation", "packageId", "lane", "createdAt"]) {
    validateNonEmptyStringField(record, field, `/${field}`, errors);
  }
  for (const field of ["outputPath", "sourceReceiptId", "sourceReceiptPath"]) {
    if (field in record && !readNonEmptyString(record[field])) {
      errors.push({ path: `/${field}`, message: "must be a non-empty string" });
    }
  }
  validateStringRecord(record.inputHashes, "/inputHashes", errors);
  // A handoff describes work still in flight, so only the non-terminal states are valid here.
  if ("state" in record && (typeof record.state !== "string" || !isJobInFlight(record.state))) {
    errors.push({ path: "/state", message: "must be pending or running" });
  }
  if ("retryAttempt" in record && !isPositiveInteger(record.retryAttempt)) {
    errors.push({ path: "/retryAttempt", message: "must be a positive integer" });
  }
  if ("eventReplay" in record) validateJobEventReplay(record.eventReplay, "/eventReplay", errors);
}

function validatePromptJobHandoffDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  for (const field of ["jobId", "receiptId", "receiptPath", "operation", "packageId", "lane", "createdAt", "request"]) {
    validateNonEmptyStringField(record, field, `/${field}`, errors);
  }
  for (const field of ["agentId", "sourceReceiptId", "sourceReceiptPath"]) {
    if (field in record && !readNonEmptyString(record[field])) {
      errors.push({ path: `/${field}`, message: "must be a non-empty string" });
    }
  }
  validateStringRecord(record.inputHashes, "/inputHashes", errors);
  // A handoff describes work still in flight, so only the non-terminal states are valid here.
  if ("state" in record && (typeof record.state !== "string" || !isJobInFlight(record.state))) {
    errors.push({ path: "/state", message: "must be pending or running" });
  }
  if ("retryAttempt" in record && !isPositiveInteger(record.retryAttempt)) {
    errors.push({ path: "/retryAttempt", message: "must be a positive integer" });
  }
  if ("eventReplay" in record) validateJobEventReplay(record.eventReplay, "/eventReplay", errors);
}

function validateJobEventReplay(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["schema", "eventCount", "lastSeq", "reconnectCursor"], errors);
  if ("schema" in record && record.schema !== "shellx-motion/job-event-replay@1") {
    errors.push({ path: `${path}/schema`, message: "must equal shellx-motion/job-event-replay@1" });
  }
  if ("eventLogPath" in record && !readNonEmptyString(record.eventLogPath)) {
    errors.push({ path: `${path}/eventLogPath`, message: "must be a non-empty string" });
  }
  if ("lastEventAt" in record && !readNonEmptyString(record.lastEventAt)) {
    errors.push({ path: `${path}/lastEventAt`, message: "must be a non-empty string" });
  }
  if ("eventCount" in record && !isNonNegativeInteger(record.eventCount)) {
    errors.push({ path: `${path}/eventCount`, message: "must be a non-negative integer" });
  }
  if ("lastSeq" in record && !isNonNegativeInteger(record.lastSeq)) {
    errors.push({ path: `${path}/lastSeq`, message: "must be a non-negative integer" });
  }
  const reconnectCursor = readRecord(record.reconnectCursor);
  if (!reconnectCursor) {
    if (record.reconnectCursor !== undefined) errors.push({ path: `${path}/reconnectCursor`, message: "must be an object" });
    return;
  }
  validateRequiredFields(reconnectCursor, `${path}/reconnectCursor`, ["receiptId", "sinceSeq"], errors);
  if ("receiptId" in reconnectCursor && !readNonEmptyString(reconnectCursor.receiptId)) {
    errors.push({ path: `${path}/reconnectCursor/receiptId`, message: "must be a non-empty string" });
  }
  if ("sinceSeq" in reconnectCursor && !isNonNegativeInteger(reconnectCursor.sinceSeq)) {
    errors.push({ path: `${path}/reconnectCursor/sinceSeq`, message: "must be a non-negative integer" });
  }
}

function validateQualityManifestDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("audio" in record) validateQualityManifestAudio(record.audio, "/audio", errors);
  validateQualityManifestSamples(record.samples, "/samples", errors);
}

function validateQualityManifestAudio(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("expect" in record && typeof record.expect !== "boolean") {
    errors.push({ path: `${path}/expect`, message: "must be a boolean" });
  }
  for (const field of [
    "maxPeakDb",
    "minPeakDb",
    "minMeanDb",
    "minIntegratedLoudnessLufs",
    "maxIntegratedLoudnessLufs",
    "maxTruePeakDbtp"
  ]) {
    if (field in record && !isFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a finite number" });
    }
  }
  const maxLoudnessRangeLu = record.maxLoudnessRangeLu;
  if ("maxLoudnessRangeLu" in record && (!isFiniteNumber(maxLoudnessRangeLu) || (typeof maxLoudnessRangeLu === "number" && maxLoudnessRangeLu < 0))) {
    errors.push({ path: `${path}/maxLoudnessRangeLu`, message: "must be a non-negative finite number" });
  }
  const minIntegratedLoudnessLufs = record.minIntegratedLoudnessLufs;
  const maxIntegratedLoudnessLufs = record.maxIntegratedLoudnessLufs;
  if (typeof minIntegratedLoudnessLufs === "number"
    && Number.isFinite(minIntegratedLoudnessLufs)
    && typeof maxIntegratedLoudnessLufs === "number"
    && Number.isFinite(maxIntegratedLoudnessLufs)
    && minIntegratedLoudnessLufs > maxIntegratedLoudnessLufs) {
    errors.push({
      path: `${path}/maxIntegratedLoudnessLufs`,
      message: "must be greater than or equal to minIntegratedLoudnessLufs"
    });
  }
}

function validateQualityManifestSamples(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  if (value.length === 0) {
    errors.push({ path, message: "must be a non-empty array" });
    return;
  }
  value.forEach((entry, index) => {
    const samplePath = `${path}/${index}`;
    const sample = readRecord(entry);
    if (!sample) {
      errors.push({ path: samplePath, message: "must be an object" });
      return;
    }
    if ("id" in sample && !readNonEmptyString(sample.id)) {
      errors.push({ path: `${samplePath}/id`, message: "must be a non-empty string" });
    }
    if ("baseline" in sample && !readNonEmptyString(sample.baseline)) {
      errors.push({ path: `${samplePath}/baseline`, message: "must be a non-empty string" });
    }
    for (const field of [
      "atMs",
      "minBrightPixels",
      "minEdgePixels",
      "minLumaRange",
      "minChromaPixels",
      "minTransparentPixels",
      "minNonTransparentPixels",
      "maxChangedPixels",
      "maxMeanDiff",
      "minChangedPixelsFromPrevious",
      "minMeanDiffFromPrevious",
      "minPsnrDb"
    ]) {
      if (field in sample && !isNonNegativeFiniteNumber(sample[field])) {
        errors.push({ path: `${samplePath}/${field}`, message: "must be a non-negative finite number" });
      }
    }
    if ("minSsim" in sample && (!isFiniteNumber(sample.minSsim) || (typeof sample.minSsim === "number" && (sample.minSsim < 0 || sample.minSsim > 1)))) {
      errors.push({ path: `${samplePath}/minSsim`, message: "must be a finite number between 0 and 1" });
    }
    if (index === 0) {
      for (const field of ["minChangedPixelsFromPrevious", "minMeanDiffFromPrevious"]) {
        if (typeof sample[field] === "number" && Number.isFinite(sample[field]) && sample[field] > 0) {
          errors.push({ path: `${samplePath}/${field}`, message: "cannot require motion before the first sample" });
        }
      }
    }
    if ("compareAlpha" in sample && typeof sample.compareAlpha !== "boolean") {
      errors.push({ path: `${samplePath}/compareAlpha`, message: "must be a boolean" });
    }
    if ("regions" in sample) validateQualityManifestRegions(sample.regions, `${samplePath}/regions`, errors);
  });
}

function validateQualityManifestRegions(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const regionPath = `${path}/${index}`;
    const region = readRecord(entry);
    if (!region) {
      errors.push({ path: regionPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(region, regionPath, ["x", "y", "width", "height"], errors);
    if ("id" in region && !readNonEmptyString(region.id)) {
      errors.push({ path: `${regionPath}/id`, message: "must be a non-empty string" });
    }
    for (const field of ["x", "y"]) {
      if (field in region && !isNonNegativeInteger(region[field])) {
        errors.push({ path: `${regionPath}/${field}`, message: "must be a non-negative integer" });
      }
    }
    for (const field of ["width", "height"]) {
      if (field in region && !isPositiveInteger(region[field])) {
        errors.push({ path: `${regionPath}/${field}`, message: "must be a positive integer" });
      }
    }
    for (const field of ["minDarkPixels", "minBrightPixels", "minEdgePixels", "minTransparentPixels", "minNonTransparentPixels"]) {
      if (field in region && !isNonNegativeFiniteNumber(region[field])) {
        errors.push({ path: `${regionPath}/${field}`, message: "must be a non-negative finite number" });
      }
    }
  });
}

function validateExpectedPreviewDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateNonEmptyStringField(record, "renderer", "/renderer", errors);
  validateNonEmptyStringField(record, "fixture", "/fixture", errors);
  validateOptionalNonNegativeFiniteNumber(record.atMs, "/atMs", errors);
  validateOptionalPositiveFiniteNumber(record.width, "/width", errors);
  validateOptionalPositiveFiniteNumber(record.height, "/height", errors);
  validateSha256StringField(record, "sha256", "/sha256", errors);
}

function validateBrowserWorkflowDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("viewport" in record) validateBrowserWorkflowViewport(record.viewport, "/viewport", errors);
  if ("networkPolicy" in record && !SUPPORTED_BROWSER_WORKFLOW_NETWORK_POLICIES.has(String(record.networkPolicy))) {
    errors.push({ path: "/networkPolicy", message: "must be blocked-unless-declared or allow" });
  }
  validateBrowserWorkflowSteps(record.steps, "/steps", errors);
  if ("cursor" in record) validateBrowserWorkflowCursor(record.cursor, "/cursor", errors);
}

function validateBrowserWorkflowViewport(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["width", "height"], errors);
  for (const field of ["width", "height", "deviceScaleFactor"]) {
    if (field in record && !isPositiveFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a positive finite number" });
    }
  }
}

function validateBrowserWorkflowSteps(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  let totalWaitMs = 0;
  value.forEach((entry, index) => {
    const stepPath = `${path}/${index}`;
    const step = readRecord(entry);
    if (!step) {
      errors.push({ path: stepPath, message: "must be an object" });
      return;
    }
    if (!("action" in step)) {
      errors.push({ path: `${stepPath}/action`, message: "required" });
      return;
    }
    if (!SUPPORTED_BROWSER_WORKFLOW_ACTIONS.has(String(step.action))) {
      errors.push({ path: `${stepPath}/action`, message: "unsupported browser workflow action" });
      return;
    }
    if (step.action === "wait") {
      validateRequiredFields(step, stepPath, ["ms"], errors);
      if ("ms" in step && !isNonNegativeFiniteNumber(step.ms)) {
        errors.push({ path: `${stepPath}/ms`, message: "must be a non-negative finite number" });
      } else if (typeof step.ms === "number") {
        totalWaitMs += step.ms;
        if (step.ms > MAX_BROWSER_WORKFLOW_WAIT_MS) {
          errors.push({ path: `${stepPath}/ms`, message: `must be no more than ${MAX_BROWSER_WORKFLOW_WAIT_MS} milliseconds` });
        }
      }
      return;
    }
    if (step.action === "click") {
      validateRequiredFields(step, stepPath, ["selector"], errors);
      validateNonEmptyStringField(step, "selector", `${stepPath}/selector`, errors);
      return;
    }
    if (step.action === "type") {
      validateRequiredFields(step, stepPath, ["selector", "text"], errors);
      validateNonEmptyStringField(step, "selector", `${stepPath}/selector`, errors);
      if ("text" in step && typeof step.text !== "string") {
        errors.push({ path: `${stepPath}/text`, message: "must be a string" });
      }
      return;
    }
    if (step.action === "press") {
      validateRequiredFields(step, stepPath, ["selector", "key"], errors);
      validateNonEmptyStringField(step, "selector", `${stepPath}/selector`, errors);
      validateNonEmptyStringField(step, "key", `${stepPath}/key`, errors);
      return;
    }
    if (step.action === "scroll") {
      for (const field of ["x", "y"]) {
        if (field in step && !isFiniteNumber(step[field])) {
          errors.push({ path: `${stepPath}/${field}`, message: "must be a finite number" });
        }
      }
      return;
    }
    validateRequiredFields(step, stepPath, ["selector"], errors);
    validateNonEmptyStringField(step, "selector", `${stepPath}/selector`, errors);
    if ("text" in step && typeof step.text !== "string") {
      errors.push({ path: `${stepPath}/text`, message: "must be a string" });
    }
  });
  if (totalWaitMs > MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS) {
    errors.push({ path, message: `total wait time must be no more than ${MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS} milliseconds` });
  }
}

function validateBrowserWorkflowCursor(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("visible" in record && typeof record.visible !== "boolean") {
    errors.push({ path: `${path}/visible`, message: "must be a boolean" });
  }
  if (!("path" in record)) return;
  if (!Array.isArray(record.path)) {
    errors.push({ path: `${path}/path`, message: "must be an array" });
    return;
  }
  record.path.forEach((entry, index) => {
    const pointPath = `${path}/path/${index}`;
    const point = readRecord(entry);
    if (!point) {
      errors.push({ path: pointPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(point, pointPath, ["x", "y", "atMs"], errors);
    for (const field of ["x", "y"]) {
      if (field in point && !isFiniteNumber(point[field])) {
        errors.push({ path: `${pointPath}/${field}`, message: "must be a finite number" });
      }
    }
    if ("atMs" in point && !isNonNegativeFiniteNumber(point.atMs)) {
      errors.push({ path: `${pointPath}/atMs`, message: "must be a non-negative finite number" });
    }
  });
}

function validateBrowserWorkflowTraceDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateNonEmptyStringField(record, "workflowHash", "/workflowHash", errors);
  if ("stepCount" in record && !isNonNegativeInteger(record.stepCount)) {
    errors.push({ path: "/stepCount", message: "must be a non-negative integer" });
  }
  validateBrowserWorkflowTraceSteps(record.steps, "/steps", errors);
  if ("cursor" in record) validateBrowserWorkflowTraceCursor(record.cursor, "/cursor", errors);
  if ("captureReadiness" in record) validateBrowserCaptureReadiness(record.captureReadiness, "/captureReadiness", errors);
}

function validateBrowserWorkflowTraceSteps(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const stepPath = `${path}/${index}`;
    const step = readRecord(entry);
    if (!step) {
      errors.push({ path: stepPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(step, stepPath, ["index", "action", "status"], errors);
    if ("index" in step && !isNonNegativeInteger(step.index)) {
      errors.push({ path: `${stepPath}/index`, message: "must be a non-negative integer" });
    }
    if ("action" in step && !readRecord(step.action)) {
      errors.push({ path: `${stepPath}/action`, message: "must be an object" });
    } else if ("action" in step) {
      validateBrowserWorkflowTraceAction(step.action, `${stepPath}/action`, errors);
    }
    if ("status" in step && !SUPPORTED_BROWSER_WORKFLOW_TRACE_STATUSES.has(String(step.status))) {
      errors.push({ path: `${stepPath}/status`, message: "must be passed or failed" });
    }
    if ("error" in step) validateBrowserWorkflowTraceError(step.error, `${stepPath}/error`, errors);
  });
}

function validateBrowserWorkflowTraceAction(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) return;
  if ("text" in record) {
    errors.push({ path: `${path}/text`, message: "must be redacted from workflow traces" });
  }
}

function validateBrowserWorkflowTraceError(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["code", "message"], errors);
  if ("code" in record && !SUPPORTED_BROWSER_WORKFLOW_TRACE_ERROR_CODES.has(String(record.code))) {
    errors.push({ path: `${path}/code`, message: "must be action_failed or text_mismatch" });
  }
  validateNonEmptyStringField(record, "message", `${path}/message`, errors);
  if ("selector" in record && !readNonEmptyString(record.selector)) {
    errors.push({ path: `${path}/selector`, message: "must be a non-empty string" });
  }
  for (const field of ["expectedTextLength", "actualTextLength"]) {
    if (field in record && !isNonNegativeInteger(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative integer" });
    }
  }
  if ("actualTextSha256" in record && !readNonEmptyString(record.actualTextSha256)) {
    errors.push({ path: `${path}/actualTextSha256`, message: "must be a non-empty string" });
  }
}

function validateBrowserCaptureReadiness(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["schema", "page", "stylesheets", "fonts", "animationPolicy", "media", "waitMs", "diagnostics"], errors);
  if ("schema" in record && record.schema !== "shellx-motion/browser-capture-readiness@1") {
    errors.push({ path: `${path}/schema`, message: "must equal shellx-motion/browser-capture-readiness@1" });
  }
  if ("page" in record && record.page !== "loaded") {
    errors.push({ path: `${path}/page`, message: "must be loaded" });
  }
  if ("stylesheets" in record && record.stylesheets !== "settled") {
    errors.push({ path: `${path}/stylesheets`, message: "must be settled" });
  }
  if ("fonts" in record && !SUPPORTED_BROWSER_CAPTURE_FONT_READINESS.has(String(record.fonts))) {
    errors.push({ path: `${path}/fonts`, message: "must be ready, unsupported, timeout, or error" });
  }
  if ("animationPolicy" in record && record.animationPolicy !== "screenshot-disabled") {
    errors.push({ path: `${path}/animationPolicy`, message: "must be screenshot-disabled" });
  }
  if ("media" in record && record.media !== "settled-after-time-seek") {
    errors.push({ path: `${path}/media`, message: "must be settled-after-time-seek" });
  }
  if ("waitMs" in record && !isNonNegativeFiniteNumber(record.waitMs)) {
    errors.push({ path: `${path}/waitMs`, message: "must be a non-negative finite number" });
  }
  if ("diagnostics" in record) validateBrowserCaptureReadinessDiagnostics(record.diagnostics, `${path}/diagnostics`, errors);
}

function validateBrowserCaptureReadinessDiagnostics(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const integerFields = [
    "stylesheetLinkCount",
    "fontFaceCount",
    "fontFaceLoadAttemptCount",
    "fontFaceLoadedCount",
    "finiteAnimationCount",
    "finiteTransitionCount"
  ];
  const finiteFields = ["finiteAnimationMaxMs", "finiteTransitionMaxMs"];
  validateRequiredFields(record, path, [...integerFields, ...finiteFields], errors);
  for (const field of integerFields) {
    if (field in record && !isNonNegativeInteger(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative integer" });
    }
  }
  for (const field of finiteFields) {
    if (field in record && !isNonNegativeFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative finite number" });
    }
  }
}

function validateBrowserWorkflowTraceCursor(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("visible" in record && typeof record.visible !== "boolean") {
    errors.push({ path: `${path}/visible`, message: "must be a boolean" });
  }
  if ("pointCount" in record && !isNonNegativeInteger(record.pointCount)) {
    errors.push({ path: `${path}/pointCount`, message: "must be a non-negative integer" });
  }
}

function validateBrowserWorkflowCatalogDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateBrowserWorkflowCatalogEntries(record.entries, "/entries", errors);
}

function validateBrowserWorkflowCatalogEntries(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    const record = readRecord(entry);
    if (!record) {
      errors.push({ path: entryPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(record, entryPath, [
      "key",
      "packageId",
      "workflowHash",
      "atMs",
      "firstSeenAt",
      "updatedAt",
      "baseline",
      "latest",
      "drift",
      "history"
    ], errors);
    validateNonEmptyStringField(record, "key", `${entryPath}/key`, errors);
    validateNonEmptyStringField(record, "packageId", `${entryPath}/packageId`, errors);
    validateSha256StringField(record, "workflowHash", `${entryPath}/workflowHash`, errors);
    validateOptionalNonNegativeFiniteNumber(record.atMs, `${entryPath}/atMs`, errors);
    validateNonEmptyStringField(record, "firstSeenAt", `${entryPath}/firstSeenAt`, errors);
    validateNonEmptyStringField(record, "updatedAt", `${entryPath}/updatedAt`, errors);
    validateBrowserWorkflowCatalogSnapshot(record.baseline, `${entryPath}/baseline`, errors);
    validateBrowserWorkflowCatalogSnapshot(record.latest, `${entryPath}/latest`, errors);
    validateBrowserWorkflowCatalogDrift(record.drift, `${entryPath}/drift`, typeof record.key === "string" ? record.key : "", errors);
    validateBrowserWorkflowCatalogHistory(record.history, `${entryPath}/history`, errors);
  });
}

function validateBrowserWorkflowCatalogSnapshot(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["capturedAt", "outputSha256", "outputPath", "receiptPath"], errors);
  validateNonEmptyStringField(record, "capturedAt", `${path}/capturedAt`, errors);
  validateSha256StringField(record, "outputSha256", `${path}/outputSha256`, errors);
  validateNonEmptyStringField(record, "outputPath", `${path}/outputPath`, errors);
  validateNonEmptyStringField(record, "receiptPath", `${path}/receiptPath`, errors);
  if ("tracePath" in record && typeof record.tracePath !== "string") {
    errors.push({ path: `${path}/tracePath`, message: "must be a string" });
  }
  validateBrowserWorkflowCatalogBrowser(record.browser, `${path}/browser`, errors);
  validateBrowserWorkflowCatalogViewport(record.viewport, `${path}/viewport`, errors);
  validateBrowserWorkflowCatalogWorkflow(record.workflow, `${path}/workflow`, errors);
}

function validateBrowserWorkflowCatalogBrowser(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["name", "version"]) {
    if (field in record && typeof record[field] !== "string") {
      errors.push({ path: `${path}/${field}`, message: "must be a string" });
    }
  }
}

function validateBrowserWorkflowCatalogViewport(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["width", "height", "deviceScaleFactor"]) {
    validateOptionalPositiveFiniteNumber(record[field], `${path}/${field}`, errors);
  }
}

function validateBrowserWorkflowCatalogWorkflow(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("stepCount" in record && !isNonNegativeInteger(record.stepCount)) {
    errors.push({ path: `${path}/stepCount`, message: "must be a non-negative integer" });
  }
  if ("networkPolicy" in record && typeof record.networkPolicy !== "string") {
    errors.push({ path: `${path}/networkPolicy`, message: "must be a string" });
  }
}

function validateBrowserWorkflowCatalogDrift(
  value: unknown,
  path: string,
  entryKey: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["status", "key", "baselineOutputSha256", "currentOutputSha256"], errors);
  if ("status" in record && !SUPPORTED_BROWSER_WORKFLOW_DRIFT_STATUSES.has(String(record.status))) {
    errors.push({ path: `${path}/status`, message: "must be new, matched, or changed" });
  }
  if ("key" in record && record.key !== entryKey) {
    errors.push({ path: `${path}/key`, message: "must equal entry key" });
  }
  validateSha256StringField(record, "baselineOutputSha256", `${path}/baselineOutputSha256`, errors);
  validateSha256StringField(record, "currentOutputSha256", `${path}/currentOutputSha256`, errors);
  validateSha256StringField(record, "previousOutputSha256", `${path}/previousOutputSha256`, errors);
}

function validateBrowserWorkflowCatalogHistory(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((snapshot, index) => validateBrowserWorkflowCatalogSnapshot(snapshot, `${path}/${index}`, errors));
}

function validateResourceCatalogDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateNonEmptyStringField(record, "packageId", "/packageId", errors);
  validateNonEmptyStringField(record, "sourceApp", "/sourceApp", errors);
  validateResourceCatalogResources(record.resources, "/resources", errors);
}

function validateResourceCatalogResources(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const resourcePath = `${path}/${index}`;
    const resource = readRecord(entry);
    if (!resource) {
      errors.push({ path: resourcePath, message: "must be an object" });
      return;
    }
    validateRequiredFields(resource, resourcePath, ["id", "ref", "kind", "source"], errors);
    validateNonEmptyStringField(resource, "id", `${resourcePath}/id`, errors);
    validateNonEmptyStringField(resource, "ref", `${resourcePath}/ref`, errors);
    validateNonEmptyStringField(resource, "kind", `${resourcePath}/kind`, errors);
    if ("mimeType" in resource && !readNonEmptyString(resource.mimeType)) {
      errors.push({ path: `${resourcePath}/mimeType`, message: "must be a non-empty string" });
    }
    if ("sha256" in resource && !isSha256HexString(resource.sha256)) {
      errors.push({ path: `${resourcePath}/sha256`, message: "must be a 64-character hex string" });
    }
    if ("source" in resource) validateResourceCatalogSource(resource.source, `${resourcePath}/source`, errors);
  });
}

function validateResourceCatalogSource(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["app"], errors);
  validateNonEmptyStringField(record, "app", `${path}/app`, errors);
  for (const field of ["sourceFrameId", "receiptId"]) {
    if (field in record && !readNonEmptyString(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-empty string" });
    }
  }
}

function validateCutImportPlanDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("ok" in record && typeof record.ok !== "boolean") {
    errors.push({ path: "/ok", message: "must be a boolean" });
  }
  for (const field of ["packageId", "motionId", "targetId"]) {
    validateNonEmptyStringField(record, field, `/${field}`, errors);
  }
  validateCutImportMode(record.mode, "/mode", errors);
  validateCutImportOperations(record.operations, "/operations", errors);
  validateCutUnsupportedFeatures(record.unsupported, "/unsupported", errors);
  validateCutDocumentMetadata(record.document, "/document", errors);
  if ("timeline" in record && !readRecord(record.timeline)) {
    errors.push({ path: "/timeline", message: "must be an object" });
  }
  const receipt = readRecord(record.receipt);
  if (!receipt) {
    if (record.receipt !== undefined) errors.push({ path: "/receipt", message: "must be an object" });
  } else {
    validateReceiptDocument(receipt, errors, "/receipt");
  }
}

function validateCutImportMode(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value !== null && !SUPPORTED_CUT_IMPORT_MODES.has(String(value))) {
    errors.push({ path, message: "must be rendered_media, live_overlay, editable_lowering, or null" });
  }
}

function validateCutImportOperations(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const operationPath = `${path}/${index}`;
    const operation = readRecord(entry);
    if (!operation) {
      errors.push({ path: operationPath, message: "must be an object" });
      return;
    }
    if (!("verb" in operation)) {
      errors.push({ path: `${operationPath}/verb`, message: "required" });
      return;
    }
    if (!SUPPORTED_CUT_IMPORT_OPERATION_VERBS.has(String(operation.verb))) {
      errors.push({ path: `${operationPath}/verb`, message: "unsupported cut import operation" });
      return;
    }
    if (operation.verb === "cut.media.import_rendered") {
      validateCutRenderedMediaOperation(operation, operationPath, errors);
      return;
    }
    if (operation.verb === "cut.motion_overlay.create") {
      validateCutOverlayOperation(operation, operationPath, errors);
      return;
    }
    if (operation.verb === "cut.timeline.track.create") {
      validateNonEmptyStringField(operation, "sourceTrackId", `${operationPath}/sourceTrackId`, errors);
      validateCutPayload(operation.payload, `${operationPath}/payload`, errors);
      return;
    }
    if (operation.verb === "cut.timeline.scene.create") {
      validateNonEmptyStringField(operation, "sourceSceneId", `${operationPath}/sourceSceneId`, errors);
      validateCutTiming(operation, operationPath, errors);
      validateCutPayload(operation.payload, `${operationPath}/payload`, errors);
      return;
    }
    if (operation.verb === "cut.timeline.marker.create") {
      validateNonEmptyStringField(operation, "sourceMarkerId", `${operationPath}/sourceMarkerId`, errors);
      if ("atMs" in operation && !isNonNegativeFiniteNumber(operation.atMs)) {
        errors.push({ path: `${operationPath}/atMs`, message: "must be a non-negative finite number" });
      }
      if ("durationMs" in operation && !isNonNegativeFiniteNumber(operation.durationMs)) {
        errors.push({ path: `${operationPath}/durationMs`, message: "must be a non-negative finite number" });
      }
      validateCutPayload(operation.payload, `${operationPath}/payload`, errors);
      return;
    }
    validateNonEmptyStringField(operation, "sourceLayerId", `${operationPath}/sourceLayerId`, errors);
    validateCutTiming(operation, operationPath, errors);
    validateCutPayload(operation.payload, `${operationPath}/payload`, errors);
  });
}

function validateCutRenderedMediaOperation(
  operation: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  validateCutRenderedSource(operation.source, `${path}/source`, errors);
  validateCutTiming(operation, path, errors);
  validateCutMediaMetadata(operation.media, `${path}/media`, errors);
  if ("renderedMedia" in operation) validateCutRenderedMediaArtifact(operation.renderedMedia, `${path}/renderedMedia`, errors);
}

function validateCutOverlayOperation(
  operation: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  validateCutSource(operation.source, `${path}/source`, errors);
  validateCutTiming(operation, path, errors);
  validateCutMediaMetadata(operation.overlay, `${path}/overlay`, errors);
}

function validateCutRenderedSource(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const source = readRecord(value);
  if (!source) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateCutSource(source, path, errors);
  if ("render" in source && !SUPPORTED_CUT_RENDER_STATES.has(String(source.render))) {
    errors.push({ path: `${path}/render`, message: "must be required, dry_run, or artifact" });
  }
}

function validateCutSource(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const source = readRecord(value);
  if (!source) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateNonEmptyStringField(source, "packageId", `${path}/packageId`, errors);
  validateNonEmptyStringField(source, "motionId", `${path}/motionId`, errors);
}

function validateCutTiming(
  record: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if ("startMs" in record && !isNonNegativeFiniteNumber(record.startMs)) {
    errors.push({ path: `${path}/startMs`, message: "must be a non-negative finite number" });
  }
  if ("durationMs" in record && !isPositiveFiniteNumber(record.durationMs)) {
    errors.push({ path: `${path}/durationMs`, message: "must be a positive finite number" });
  }
}

function validateCutMediaMetadata(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["width", "height", "fps"]) {
    if (field in record && !isPositiveFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a positive finite number" });
    }
  }
}

function validateCutRenderedMediaArtifact(value: unknown, path: string, errors: Array<{ path: string; message: string }>): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (typeof record.dryRun !== "boolean") {
    errors.push({ path: `${path}/dryRun`, message: "must be a boolean" });
    return;
  }
  if (record.dryRun) {
    if (!readNonEmptyString(record.plannedPath)) errors.push({ path: `${path}/plannedPath`, message: "must be a non-empty string" });
    if (!readNonEmptyString(record.receiptPath)) errors.push({ path: `${path}/receiptPath`, message: "must be a non-empty string" });
    return;
  }
  const handle = readRecord(record.handle);
  if (!handle) {
    errors.push({ path: `${path}/handle`, message: "must be an artifact handle reference object" });
    return;
  }
  if (handle.schema !== "shellx-motion/artifact-handle-ref@1") {
    errors.push({ path: `${path}/handle/schema`, message: "must be shellx-motion/artifact-handle-ref@1" });
  }
  if (typeof handle.id !== "string" || !/^artifact-[a-f0-9]{24}$/.test(handle.id)) errors.push({ path: `${path}/handle/id`, message: "must be an artifact handle id" });
  if (typeof handle.operationHash !== "string" || !/^[a-f0-9]{64}$/.test(handle.operationHash)) errors.push({ path: `${path}/handle/operationHash`, message: "must be a lowercase sha256 hash" });
  const rootRelativePath = readNonEmptyString(handle.rootRelativePath);
  if (!rootRelativePath || rootRelativePath.startsWith("/") || rootRelativePath.includes("\\") || rootRelativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    errors.push({ path: `${path}/handle/rootRelativePath`, message: "must be a canonical root-relative path" });
  }
  if (typeof handle.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(handle.sha256)) {
    errors.push({ path: `${path}/handle/sha256`, message: "must be a lowercase sha256 hash" });
  }
  if (handle.packageLineage !== undefined) try { validatePackageRenderLineage(handle.packageLineage); }
  catch { errors.push({ path: `${path}/handle/packageLineage`, message: "must be a valid package render lineage" }); }
}

function validateCutPayload(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!readRecord(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
  }
}

function validateCutUnsupportedFeatures(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const unsupportedPath = `${path}/${index}`;
    const unsupported = readRecord(entry);
    if (!unsupported) {
      errors.push({ path: unsupportedPath, message: "must be an object" });
      return;
    }
    for (const field of ["layerId", "feature", "reason"]) {
      validateNonEmptyStringField(unsupported, field, `${unsupportedPath}/${field}`, errors);
    }
  });
}

function validateCutDocumentMetadata(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["width", "height", "fps", "durationMs"]) {
    if (field in record && !isPositiveFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a positive finite number" });
    }
  }
  if ("background" in record && typeof record.background !== "string") {
    errors.push({ path: `${path}/background`, message: "must be a string" });
  }
  if ("safeAreas" in record && !readRecord(record.safeAreas)) {
    errors.push({ path: `${path}/safeAreas`, message: "must be an object" });
  }
}

function validateScriptedVideoDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  for (const field of ["id", "name", "sourceApp", "workflow"]) {
    validateNonEmptyStringField(record, field, `/${field}`, errors);
  }
  if ("intent" in record && typeof record.intent !== "string") {
    errors.push({ path: "/intent", message: "must be a string" });
  }
  if ("synopsis" in record && typeof record.synopsis !== "string") {
    errors.push({ path: "/synopsis", message: "must be a string" });
  }
  validateScriptedReview(record.review, "/review", errors);
  validateIntegerRange(record.width, "/width", 16, 7680, errors);
  validateIntegerRange(record.height, "/height", 16, 4320, errors);
  validateIntegerRange(record.fps, "/fps", 1, 120, errors);
  validateScriptedVideoFrames(record.frames, "/frames", errors);
}

function validateScriptedReview(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateNonEmptyStringField(record, "status", `${path}/status`, errors);
  if ("required" in record && typeof record.required !== "boolean") {
    errors.push({ path: `${path}/required`, message: "must be a boolean" });
  }
}

function validateScriptedVideoFrames(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  if (value.length === 0) {
    errors.push({ path, message: "must contain at least one frame" });
    return;
  }
  if (value.length > SCRIPTED_VIDEO_MAX_FRAME_COUNT) {
    errors.push({ path, message: "must contain at most 120 frames" });
    return;
  }
  let totalDurationMs = 0;
  const slugs = new Set<string>();
  value.forEach((entry, index) => {
    const framePath = `${path}/${index}`;
    const frame = readRecord(entry);
    if (!frame) {
      errors.push({ path: framePath, message: "must be an object" });
      return;
    }
    validateNonEmptyStringField(frame, "id", `${framePath}/id`, errors);
    validateNonEmptyStringField(frame, "title", `${framePath}/title`, errors);
    for (const field of ["body", "caption"]) {
      if (field in frame && typeof frame[field] !== "string") {
        errors.push({ path: `${framePath}/${field}`, message: "must be a string" });
      }
    }
    validateIntegerRange(frame.durationMs, `${framePath}/durationMs`, 100, 60000, errors);
    for (const field of ["background", "accent"]) {
      if (field in frame && typeof frame[field] !== "string") {
        errors.push({ path: `${framePath}/${field}`, message: "must be a string" });
      }
    }
    for (const field of ["reviewStatus", "agentNote"]) {
      if (field in frame && typeof frame[field] !== "string") {
        errors.push({ path: `${framePath}/${field}`, message: "must be a string" });
      }
    }
    if ("assetRefs" in frame) validateStandaloneStringArray(frame.assetRefs, `${framePath}/assetRefs`, errors);
    if ("sourceRefs" in frame) validateScriptedSourceRefs(frame.sourceRefs, `${framePath}/sourceRefs`, errors);
    if ("tags" in frame) validateStandaloneStringArray(frame.tags, `${framePath}/tags`, errors);
    if ("template" in frame) validateScriptedTemplateHint(frame.template, `${framePath}/template`, errors);
    if ("engine" in frame) validateScriptedEngineHint(frame.engine, `${framePath}/engine`, errors);
    if ("effects" in frame) validateScriptedFrameEffects(frame.effects, `${framePath}/effects`, errors);
    if (typeof frame.durationMs === "number" && Number.isInteger(frame.durationMs)) {
      totalDurationMs += frame.durationMs;
    }
    const id = readNonEmptyString(frame.id);
    if (!id) return;
    const slug = slugScriptedFrameId(id);
    if (slugs.has(slug)) {
      errors.push({ path: `${framePath}/id`, message: "must be unique after sanitization" });
      return;
    }
    slugs.add(slug);
  });
  if (totalDurationMs > SCRIPTED_VIDEO_MAX_TOTAL_DURATION_MS) {
    errors.push({ path, message: "total duration must be at most 600000ms" });
  }
}

function validateScriptedSourceRefs(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    const record = readRecord(entry);
    if (!record) {
      errors.push({ path: entryPath, message: "must be an object" });
      return;
    }
    validateNonEmptyStringField(record, "type", `${entryPath}/type`, errors);
    for (const field of ["title", "url", "path"]) {
      if (field in record && typeof record[field] !== "string") {
        errors.push({ path: `${entryPath}/${field}`, message: "must be a string" });
      }
    }
  });
}

function validateScriptedTemplateHint(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateNonEmptyStringField(record, "id", `${path}/id`, errors);
  validateNonEmptyStringField(record, "engine", `${path}/engine`, errors);
  if ("variables" in record && !readRecord(record.variables)) {
    errors.push({ path: `${path}/variables`, message: "must be an object" });
  }
}

function validateScriptedEngineHint(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateNonEmptyStringField(record, "id", `${path}/id`, errors);
  for (const field of ["mode", "capability"]) {
    if (field in record && typeof record[field] !== "string") {
      errors.push({ path: `${path}/${field}`, message: "must be a string" });
    }
  }
}

function validateScriptedFrameEffects(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const effectPath = `${path}/${index}`;
    const record = readRecord(entry);
    if (!record) {
      errors.push({ path: effectPath, message: "must be an object" });
      return;
    }
    if (!("type" in record)) {
      errors.push({ path: `${effectPath}/type`, message: "required" });
      return;
    }
    const type = typeof record.type === "string" ? record.type : "";
    if (type !== "rain" && type !== "signalPulse" && type !== "cameraPush" && type !== "particleField" && type !== "scanSweep") {
      errors.push({ path: `${effectPath}/type`, message: "must be rain, signalPulse, cameraPush, particleField, or scanSweep" });
    }
    if ("intensity" in record) {
      if (type === "rain" || type === "particleField") {
        validateIntegerRange(record.intensity, `${effectPath}/intensity`, 1, 48, errors);
      } else {
        validateFiniteNumberRange(record.intensity, `${effectPath}/intensity`, 0.1, 1, errors);
      }
    }
    if ("speed" in record) validateFiniteNumberRange(record.speed, `${effectPath}/speed`, 0.1, 8, errors);
    if ("opacity" in record) validateFiniteNumberRange(record.opacity, `${effectPath}/opacity`, 0, 1, errors);
    if ("angle" in record) validateFiniteNumberRange(record.angle, `${effectPath}/angle`, -45, 45, errors);
    if ("color" in record && typeof record.color !== "string") {
      errors.push({ path: `${effectPath}/color`, message: "must be a string" });
    }
    if ("seed" in record && typeof record.seed !== "string") {
      errors.push({ path: `${effectPath}/seed`, message: "must be a string" });
    }
    if ("shape" in record && record.shape !== "rect" && record.shape !== "ellipse" && record.shape !== "star") {
      errors.push({ path: `${effectPath}/shape`, message: "must be rect, ellipse, or star" });
    }
    if ("scale" in record) validateFiniteNumberRange(record.scale, `${effectPath}/scale`, 1, 1.2, errors);
    if ("x" in record) validateFiniteNumberRange(record.x, `${effectPath}/x`, -1000, 1000, errors);
    if ("y" in record) validateFiniteNumberRange(record.y, `${effectPath}/y`, -1000, 1000, errors);
  });
}

function validateIntegerRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    errors.push({ path, message: `must be an integer between ${min} and ${max}` });
  }
}

function validateFiniteNumberRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: Array<{ path: string; message: string }>
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    errors.push({ path, message: `must be a finite number between ${min} and ${max}` });
  }
}

function slugScriptedFrameId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "untitled";
}

function validateDataRowsDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateDataRows(record.rows, "/rows", errors);
}

function validateDataRows(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  if (value.length === 0) {
    errors.push({ path, message: "must include at least one row" });
    return;
  }
  const seenIds = new Set<string>();
  value.forEach((entry, index) => {
    const rowPath = `${path}/${index}`;
    const row = readRecord(entry);
    if (!row) {
      errors.push({ path: rowPath, message: "must be an object" });
      return;
    }
    const id = slugDataRowId(String(row.id ?? `row-${index + 1}`));
    if (seenIds.has(id)) {
      errors.push({ path: `${rowPath}/id`, message: "must be unique after sanitization" });
      return;
    }
    seenIds.add(id);
  });
}

function slugDataRowId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "row";
}

function validateDurationPolicyDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateOptionalNonNegativeFiniteNumber(record.minDurationMs, "/minDurationMs", errors);
  validateOptionalNonNegativeFiniteNumber(record.maxDurationMs, "/maxDurationMs", errors);
  if (
    typeof record.minDurationMs === "number" &&
    Number.isFinite(record.minDurationMs) &&
    record.minDurationMs >= 0 &&
    typeof record.maxDurationMs === "number" &&
    Number.isFinite(record.maxDurationMs) &&
    record.maxDurationMs >= 0 &&
    record.minDurationMs > record.maxDurationMs
  ) {
    errors.push({ path: "/minDurationMs", message: "must be less than or equal to maxDurationMs" });
  }
  if ("resizeMode" in record && !SUPPORTED_DURATION_RESIZE_MODES.has(String(record.resizeMode))) {
    errors.push({ path: "/resizeMode", message: "must be stretch-middle, ripple, or fixed" });
  }
  validateDurationProtectedRegions(record.protectedRegions, "/protectedRegions", errors);
}

function validateDurationProtectedRegions(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const regionPath = `${path}/${index}`;
    const region = readRecord(entry);
    if (!region) {
      errors.push({ path: regionPath, message: "must be an object" });
      return;
    }
    validateNonEmptyStringField(region, "id", `${regionPath}/id`, errors);
    const id = readNonEmptyString(region.id);
    if (id) {
      if (ids.has(id)) {
        errors.push({ path: `${regionPath}/id`, message: "must be unique" });
      }
      ids.add(id);
    }
    for (const field of ["label", "role"]) {
      if (field in region && typeof region[field] !== "string") {
        errors.push({ path: `${regionPath}/${field}`, message: "must be a string" });
      }
    }
    validateOptionalNonNegativeFiniteNumber(region.startMs, `${regionPath}/startMs`, errors);
    if (typeof region.durationMs !== "number" || !Number.isFinite(region.durationMs) || region.durationMs <= 0) {
      errors.push({ path: `${regionPath}/durationMs`, message: "must be a positive finite number" });
    }
  });
}

function validateOptionalNonNegativeFiniteNumber(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push({ path, message: "must be a non-negative finite number" });
  }
}

function validateOptionalPositiveFiniteNumber(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push({ path, message: "must be a positive finite number" });
  }
}

function validateSha256StringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (field in record && !isSha256HexString(record[field])) {
    errors.push({ path, message: "must be a 64-character hex string" });
  }
}

function validateTimelineStateDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  validateNonEmptyStringField(record, "packageId", "/packageId", errors);
  validateNonEmptyStringField(record, "motionId", "/motionId", errors);
  const durationMs = readPositiveFiniteNumber(record.durationMs);
  if ("durationMs" in record && durationMs === null) {
    errors.push({ path: "/durationMs", message: "must be a positive finite number" });
  }
  validateOptionalNonNegativeFiniteNumber(record.playheadMs, "/playheadMs", errors);
  const playheadMs = readNonNegativeFiniteNumber(record.playheadMs);
  if (durationMs !== null && playheadMs !== null && playheadMs > durationMs) {
    errors.push({ path: "/playheadMs", message: "must be less than or equal to durationMs" });
  }
  validateTimelineStateRange(record.selectedRange, "/selectedRange", durationMs, false, errors);
  validateTimelineStateRange(record.viewport, "/viewport", durationMs, true, errors);
  validateNonEmptyStringField(record, "updatedAt", "/updatedAt", errors);
}

function validateTimelineStateRange(
  value: unknown,
  path: string,
  durationMs: number | null,
  viewport: boolean,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["startMs", "endMs"], errors);
  validateOptionalNonNegativeFiniteNumber(record.startMs, `${path}/startMs`, errors);
  validateOptionalNonNegativeFiniteNumber(record.endMs, `${path}/endMs`, errors);
  const startMs = readNonNegativeFiniteNumber(record.startMs);
  const endMs = readNonNegativeFiniteNumber(record.endMs);
  if (startMs !== null && endMs !== null) {
    if (viewport && endMs <= startMs) {
      errors.push({ path: `${path}/endMs`, message: "must be greater than startMs" });
    } else if (!viewport && endMs < startMs) {
      errors.push({ path: `${path}/endMs`, message: "must be greater than or equal to startMs" });
    }
  }
  if (durationMs !== null && endMs !== null && endMs > durationMs) {
    errors.push({ path: `${path}/endMs`, message: "must be less than or equal to durationMs" });
  }
  if (viewport) {
    validateOptionalPositiveFiniteNumber(record.zoom, `${path}/zoom`, errors);
    validateOptionalPositiveFiniteNumber(record.pixelsPerSecond, `${path}/pixelsPerSecond`, errors);
  }
}

function validateReceiptDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>,
  basePath = ""
): void {
  validateNonEmptyStringField(record, "id", `${basePath}/id`, errors);
  validateNonEmptyStringField(record, "operation", `${basePath}/operation`, errors);
  if ("status" in record && !SUPPORTED_RECEIPT_STATUSES.has(String(record.status))) {
    errors.push({ path: `${basePath}/status`, message: "unsupported receipt status" });
  }
  validateNonEmptyStringField(record, "packageId", `${basePath}/packageId`, errors);
  validateStringRecord(record.inputHashes, `${basePath}/inputHashes`, errors);
  validateNonEmptyStringField(record, "createdAt", `${basePath}/createdAt`, errors);
  validateNonEmptyStringField(record, "lane", `${basePath}/lane`, errors);
  if ("artifacts" in record) validateReceiptArtifacts(record.artifacts, `${basePath}/artifacts`, errors);
  validateStandaloneStringArray(record.warnings, `${basePath}/warnings`, errors);
  if ("actor" in record) validateReceiptActor(record.actor, `${basePath}/actor`, errors);
}

/**
 * Validate an optional receipt actor-attribution block. Kept in lockstep with receipt.schema.json's
 * `actor` definition so the bespoke validator and the published schema agree. `kind` and `label` are
 * required; the observed-fact fields (transport/clientInfo/sessionId/grantedTier) are optional strings,
 * with `transport` constrained to the known wires. See ReceiptActor for the evidence-vs-claim split.
 */
function validateReceiptActor(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const actor = readRecord(value);
  if (!actor) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (!("kind" in actor) || !SUPPORTED_RECEIPT_ACTOR_KINDS.has(String(actor.kind))) {
    errors.push({ path: `${path}/kind`, message: "unsupported actor kind" });
  }
  validateNonEmptyStringField(actor, "label", `${path}/label`, errors);
  if ("transport" in actor && !SUPPORTED_RECEIPT_ACTOR_TRANSPORTS.has(String(actor.transport))) {
    errors.push({ path: `${path}/transport`, message: "unsupported actor transport" });
  }
  for (const field of ["clientInfo", "sessionId", "grantedTier"]) {
    if (field in actor && typeof actor[field] !== "string") {
      errors.push({ path: `${path}/${field}`, message: "must be a string" });
    }
  }
}

function validateReceiptArtifacts(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const artifactPath = `${path}/${index}`;
    const artifact = readRecord(entry);
    if (!artifact) {
      errors.push({ path: artifactPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(artifact, artifactPath, ["role", "path", "status"], errors);
    validateNonEmptyStringField(artifact, "role", `${artifactPath}/role`, errors);
    validateNonEmptyStringField(artifact, "path", `${artifactPath}/path`, errors);
    if ("status" in artifact && !SUPPORTED_RECEIPT_ARTIFACT_STATUSES.has(String(artifact.status))) {
      errors.push({ path: `${artifactPath}/status`, message: "unsupported artifact status" });
    }
    for (const field of ["label", "mediaType"]) {
      if (field in artifact && typeof artifact[field] !== "string") {
        errors.push({ path: `${artifactPath}/${field}`, message: "must be a string" });
      }
    }
    if ("primary" in artifact && typeof artifact.primary !== "boolean") {
      errors.push({ path: `${artifactPath}/primary`, message: "must be a boolean" });
    }
  });
}

function validateActionsRegistryDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("actionSchema" in record && record.actionSchema !== "shellx-motion/action@1") {
    errors.push({ path: "/actionSchema", message: "must equal shellx-motion/action@1" });
  }
  validateNonEmptyStringField(record, "generatedBy", "/generatedBy", errors);
  validateRegistryCount(record.actionCount, record.actions, "/actionCount", "actions length", errors);
  validatePermissionTierArray(record.permissions, "/permissions", errors);
  if ("surfaces" in record) validateStandaloneStringArray(record.surfaces, "/surfaces", errors);
  validateActionsRegistryActions(record.actions, "/actions", errors);
}

function validateActionsRegistryActions(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const actionPath = `${path}/${index}`;
    const action = readRecord(entry);
    if (!action) {
      errors.push({ path: actionPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(action, actionPath, SCHEMAS.action.required, errors);
    validateActionDocument(action, errors, actionPath);
  });
}

function validateActionDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>,
  basePath = ""
): void {
  if ("id" in record && !readNonEmptyString(record.id)) {
    errors.push({ path: `${basePath}/id`, message: "must be a non-empty string" });
  }
  validateStringArray(record, "aliases", errors, basePath);
  validatePermissionTier(record, `${basePath}/permission`, errors);
  if ("mutates" in record && typeof record.mutates !== "boolean") {
    errors.push({ path: `${basePath}/mutates`, message: "must be a boolean" });
  }
  validateStringArray(record, "calls", errors, basePath);
  validateStringArray(record, "verify", errors, basePath);
  validateStringArray(record, "surfaces", errors, basePath);
}

function validateDebugContractsRegistryDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("debugSchema" in record && record.debugSchema !== "shellx-motion/debug@1") {
    errors.push({ path: "/debugSchema", message: "must equal shellx-motion/debug@1" });
  }
  validateNonEmptyStringField(record, "generatedBy", "/generatedBy", errors);
  validateRegistryCount(record.commandCount, record.contracts, "/commandCount", "contracts length", errors);
  validatePermissionTierArray(record.permissions, "/permissions", errors);
  if ("commands" in record) validateStandaloneStringArray(record.commands, "/commands", errors);
  validateDebugContractsRegistryContracts(record.contracts, "/contracts", errors);
}

function validateDebugContractsRegistryContracts(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const contractPath = `${path}/${index}`;
    const contract = readRecord(entry);
    if (!contract) {
      errors.push({ path: contractPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(contract, contractPath, SCHEMAS.debug.required, errors);
    validateDebugCommandDocument(contract, errors, contractPath);
  });
}

function validateDebugCommandDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>,
  basePath = ""
): void {
  if ("command" in record && !readNonEmptyString(record.command)) {
    errors.push({ path: `${basePath}/command`, message: "must be a non-empty string" });
  }
  validatePermissionTier(record, `${basePath}/permission`, errors);
  if ("mutates" in record && typeof record.mutates !== "boolean") {
    errors.push({ path: `${basePath}/mutates`, message: "must be a boolean" });
  }
  validateDebugArgsSchema(record.argsSchema, `${basePath}/argsSchema`, errors);
  validateExpectedReceipts(record.expectedReceipts, `${basePath}/expectedReceipts`, errors);
}

function validateDebugArgsSchema(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (record.type !== "object") {
    errors.push({ path: `${path}/type`, message: "must equal object" });
  }
  if ("required" in record) {
    validateStandaloneStringArray(record.required, `${path}/required`, errors);
  }
  if ("properties" in record && !readRecord(record.properties)) {
    errors.push({ path: `${path}/properties`, message: "must be an object" });
  }
}

function validateExpectedReceipts(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    const record = readRecord(entry);
    if (!record) {
      errors.push({ path: entryPath, message: "must be an object" });
      return;
    }
    if (!readNonEmptyString(record.operation)) {
      errors.push({ path: `${entryPath}/operation`, message: "must be a non-empty string" });
    }
    if (record.mode !== "emits" && record.mode !== "reads") {
      errors.push({ path: `${entryPath}/mode`, message: "must be emits or reads" });
    }
    if (typeof record.required !== "boolean") {
      errors.push({ path: `${entryPath}/required`, message: "must be a boolean" });
    }
    if ("artifactRoles" in record) {
      validateStandaloneStringArray(record.artifactRoles, `${entryPath}/artifactRoles`, errors);
    }
  });
}

function validatePlatformVerificationDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("status" in record && !SUPPORTED_PLATFORM_VERIFICATION_STATUSES.has(String(record.status))) {
    errors.push({ path: "/status", message: "unsupported platform verification status" });
  }
  if ("dryRun" in record && typeof record.dryRun !== "boolean") {
    errors.push({ path: "/dryRun", message: "must be a boolean" });
  }
  validatePlatformHost(record.host, "/host", errors);
  validatePlatformVerificationEvidenceFields(record, errors);
  if ("hostMatrix" in record) validatePlatformHostMatrix(record.hostMatrix, "/hostMatrix", errors);
  validateNonEmptyStringField(record, "repoRoot", "/repoRoot", errors);
  validateNonEmptyStringField(record, "startedAt", "/startedAt", errors);
  if ("finishedAt" in record && !readNonEmptyString(record.finishedAt)) {
    errors.push({ path: "/finishedAt", message: "must be a non-empty string" });
  }
  validatePlatformCommands(record.commands, "/commands", errors);
}

function validatePlatformHost(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["id", "hostname", "platform", "arch", "release", "node"], errors);
  validateNonEmptyStringField(record, "id", `${path}/id`, errors);
  for (const field of ["hostname", "platform", "arch", "release", "node"]) {
    if (field in record && !readNonEmptyString(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-empty string" });
    }
  }
}

function validatePlatformHostMatrix(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("required" in record) validateStandaloneStringArray(record.required, `${path}/required`, errors);
  if ("satisfied" in record) validateStandaloneStringArray(record.satisfied, `${path}/satisfied`, errors);
  if ("missing" in record) validateStandaloneStringArray(record.missing, `${path}/missing`, errors);
  validateNonEmptyStringField(record, "current", `${path}/current`, errors);
  if ("currentRequired" in record && typeof record.currentRequired !== "boolean") {
    errors.push({ path: `${path}/currentRequired`, message: "must be a boolean" });
  }
  if ("complete" in record && typeof record.complete !== "boolean") {
    errors.push({ path: `${path}/complete`, message: "must be a boolean" });
  }
  if ("status" in record && !SUPPORTED_PLATFORM_MATRIX_STATUSES.has(String(record.status))) {
    errors.push({ path: `${path}/status`, message: "unsupported host matrix status" });
  }
}

function validatePlatformCommands(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const commandPath = `${path}/${index}`;
    const record = readRecord(entry);
    if (!record) {
      errors.push({ path: commandPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(record, commandPath, ["id", "command", "required", "status"], errors);
    validateNonEmptyStringField(record, "id", `${commandPath}/id`, errors);
    if ("command" in record) validateStandaloneStringArray(record.command, `${commandPath}/command`, errors);
    if ("required" in record && typeof record.required !== "boolean") {
      errors.push({ path: `${commandPath}/required`, message: "must be a boolean" });
    }
    if ("category" in record && !readNonEmptyString(record.category)) {
      errors.push({ path: `${commandPath}/category`, message: "must be a non-empty string" });
    }
    if ("status" in record && !SUPPORTED_PLATFORM_COMMAND_STATUSES.has(String(record.status))) {
      errors.push({ path: `${commandPath}/status`, message: "unsupported platform command status" });
    }
    if ("durationMs" in record && !isNonNegativeFiniteNumber(record.durationMs)) {
      errors.push({ path: `${commandPath}/durationMs`, message: "must be a non-negative finite number" });
    }
    if ("exitCode" in record && !Number.isInteger(record.exitCode)) {
      errors.push({ path: `${commandPath}/exitCode`, message: "must be an integer" });
    }
    if ("signal" in record && record.signal !== null && typeof record.signal !== "string") {
      errors.push({ path: `${commandPath}/signal`, message: "must be a string or null" });
    }
    if ("requiresEnv" in record) validateStandaloneStringArray(record.requiresEnv, `${commandPath}/requiresEnv`, errors);
    if ("skipReason" in record && !readNonEmptyString(record.skipReason)) {
      errors.push({ path: `${commandPath}/skipReason`, message: "must be a non-empty string" });
    }
    if ("stdoutTail" in record && typeof record.stdoutTail !== "string") {
      errors.push({ path: `${commandPath}/stdoutTail`, message: "must be a string" });
    }
    if ("stderrTail" in record && typeof record.stderrTail !== "string") {
      errors.push({ path: `${commandPath}/stderrTail`, message: "must be a string" });
    }
  });
}

function validatePlatformVerificationAggregateDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("status" in record && record.status !== "passed" && record.status !== "failed") {
    errors.push({ path: "/status", message: "unsupported platform aggregate status" });
  }
  if ("dryRun" in record && typeof record.dryRun !== "boolean") {
    errors.push({ path: "/dryRun", message: "must be a boolean" });
  }
  validateNonEmptyStringField(record, "repoRoot", "/repoRoot", errors);
  validateNonEmptyStringField(record, "startedAt", "/startedAt", errors);
  if ("finishedAt" in record && !readNonEmptyString(record.finishedAt)) {
    errors.push({ path: "/finishedAt", message: "must be a non-empty string" });
  }
  validateStandaloneStringArray(record.requiredHosts, "/requiredHosts", errors);
  validateStandaloneStringArray(record.requiredCommands, "/requiredCommands", errors);
  validatePlatformAggregateSummary(record, errors);
  validatePlatformAggregateReceiptSummaries(record, errors);
}

function validatePlatformAggregateSummary(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  const summary = readRecord(record.summary);
  if (!summary) {
    if (record.summary !== undefined) errors.push({ path: "/summary", message: "must be an object" });
    return;
  }
  validateRequiredFields(summary, "/summary", ["requiredHostCount", "satisfiedHostCount", "missingHosts", "failedHosts", "invalidReceiptCount"], errors);
  for (const field of ["requiredHostCount", "satisfiedHostCount", "invalidReceiptCount"]) {
    if (field in summary && !isNonNegativeInteger(summary[field])) {
      errors.push({ path: `/summary/${field}`, message: "must be a non-negative integer" });
    }
  }
  if ("missingHosts" in summary) validateStandaloneStringArray(summary.missingHosts, "/summary/missingHosts", errors);
  if ("failedHosts" in summary) validateStandaloneStringArray(summary.failedHosts, "/summary/failedHosts", errors);
  if (Array.isArray(record.requiredHosts) && typeof summary.requiredHostCount === "number" && summary.requiredHostCount !== record.requiredHosts.length) {
    errors.push({ path: "/summary/requiredHostCount", message: "must equal requiredHosts length" });
  }
  if (record.status === "passed") {
    const missingHosts = Array.isArray(summary.missingHosts) ? summary.missingHosts : [];
    const failedHosts = Array.isArray(summary.failedHosts) ? summary.failedHosts : [];
    const invalidReceiptCount = typeof summary.invalidReceiptCount === "number" ? summary.invalidReceiptCount : 0;
    if (missingHosts.length > 0 || failedHosts.length > 0 || invalidReceiptCount > 0) {
      errors.push({ path: "/status", message: "passed aggregate cannot have missing, failed, or invalid host evidence" });
    }
  }
}

function validatePlatformAggregateReceiptSummaries(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(record.receipts)) {
    if (record.receipts !== undefined) errors.push({ path: "/receipts", message: "must be an array" });
    return;
  }
  record.receipts.forEach((entry, index) => {
    const receiptPath = `/receipts/${index}`;
    const receipt = readRecord(entry);
    if (!receipt) {
      errors.push({ path: receiptPath, message: "must be an object" });
      return;
    }
    validateRequiredFields(receipt, receiptPath, ["path", "hostId", "schemaOk", "status", "dryRun", "ok", "failures", "requiredCommands"], errors);
    validateNonEmptyStringField(receipt, "path", `${receiptPath}/path`, errors);
    if ("hostId" in receipt && receipt.hostId !== null && !readNonEmptyString(receipt.hostId)) {
      errors.push({ path: `${receiptPath}/hostId`, message: "must be a non-empty string or null" });
    }
    if ("schemaOk" in receipt && typeof receipt.schemaOk !== "boolean") {
      errors.push({ path: `${receiptPath}/schemaOk`, message: "must be a boolean" });
    }
    if ("dryRun" in receipt && typeof receipt.dryRun !== "boolean") {
      errors.push({ path: `${receiptPath}/dryRun`, message: "must be a boolean" });
    }
    if ("ok" in receipt && typeof receipt.ok !== "boolean") {
      errors.push({ path: `${receiptPath}/ok`, message: "must be a boolean" });
    }
    if ("status" in receipt && !readNonEmptyString(receipt.status)) {
      errors.push({ path: `${receiptPath}/status`, message: "must be a non-empty string" });
    }
    if ("failures" in receipt) validateStandaloneStringArray(receipt.failures, `${receiptPath}/failures`, errors);
    if ("requiredCommands" in receipt) validatePlatformAggregateRequiredCommands(receipt.requiredCommands, `${receiptPath}/requiredCommands`, errors);
    if (record.status === "passed" && receipt.ok === false) {
      errors.push({ path: receiptPath, message: "passed aggregate cannot contain failed receipt summaries" });
    }
  });
}

function validatePlatformAggregateRequiredCommands(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["total", "passed", "missing", "failed"], errors);
  for (const field of ["total", "passed"]) {
    if (field in record && !isNonNegativeInteger(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative integer" });
    }
  }
  if ("missing" in record) validateStandaloneStringArray(record.missing, `${path}/missing`, errors);
  if ("failed" in record) validateStandaloneStringArray(record.failed, `${path}/failed`, errors);
}

function validateRequiredFields(
  record: Record<string, unknown>,
  path: string,
  fields: string[],
  errors: Array<{ path: string; message: string }>
): void {
  for (const field of fields) {
    if (!(field in record)) {
      errors.push({ path: `${path}/${field}`, message: "required" });
    }
  }
}

function validateNonEmptyStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (field in record && !readNonEmptyString(record[field])) {
    errors.push({ path, message: "must be a non-empty string" });
  }
}

function validateStringArray(
  record: Record<string, unknown>,
  field: string,
  errors: Array<{ path: string; message: string }>,
  basePath = ""
): void {
  if (!(field in record)) return;
  const path = `${basePath}/${field}`;
  const value = record[field];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({ path: `${path}/${index}`, message: "must be a string" });
    }
  });
}

function validateRegistryCount(
  value: unknown,
  entries: unknown,
  path: string,
  label: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!isNonNegativeInteger(value)) {
    if (value !== undefined) errors.push({ path, message: "must be a non-negative integer" });
    return;
  }
  if (Array.isArray(entries) && value !== entries.length) {
    errors.push({ path, message: `must equal ${label}` });
  }
}

function validatePermissionTierArray(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({ path: `${path}/${index}`, message: "must be a string" });
      return;
    }
    if (!SUPPORTED_PERMISSION_TIERS.has(entry)) {
      errors.push({ path: `${path}/${index}`, message: "unsupported permission tier" });
    }
  });
}

function validateStandaloneStringArray(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({ path: `${path}/${index}`, message: "must be a string" });
    }
  });
}

function validateStringRecord(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push({ path: `${path}/${key}`, message: "must be a non-empty string" });
    }
  }
}

function validatePermissionTier(
  record: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const pathParts = path.split("/");
  const field = pathParts[pathParts.length - 1] ?? "";
  const value = record[field];
  if (value !== undefined && !SUPPORTED_PERMISSION_TIERS.has(String(value))) {
    errors.push({ path, message: "unsupported permission tier" });
  }
}

function validateMotionDocumentScalars(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if ("id" in record && !readNonEmptyString(record.id)) {
    errors.push({ path: "/id", message: "must be a non-empty string" });
  }
  if ("name" in record && !readNonEmptyString(record.name)) {
    errors.push({ path: "/name", message: "must be a non-empty string" });
  }
  if ("durationMs" in record && !isPositiveFiniteNumber(record.durationMs)) {
    errors.push({ path: "/durationMs", message: "must be a positive finite number" });
  }
  if ("fps" in record && !isPositiveFiniteNumber(record.fps)) {
    errors.push({ path: "/fps", message: "must be a positive finite number" });
  }
  if ("width" in record && !isPositiveInteger(record.width)) {
    errors.push({ path: "/width", message: "must be a positive integer" });
  }
  if ("height" in record && !isPositiveInteger(record.height)) {
    errors.push({ path: "/height", message: "must be a positive integer" });
  }
  if ("provenance" in record && !readRecord(record.provenance)) {
    errors.push({ path: "/provenance", message: "must be an object" });
  }
  validateMotionDocumentAudioMaster(record.audio, errors, record.durationMs);
}

function validateMotionLayers(
  layers: unknown[],
  errors: Array<{ path: string; message: string }>
): Set<string> {
  const layerIds = new Set<string>();
  layers.forEach((layer, index) => {
    const path = `/layers/${index}`;
    const layerRecord = readRecord(layer);
    if (!layerRecord) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    const id = readNonEmptyString(layerRecord.id);
    if (!id) {
      errors.push({ path: `${path}/id`, message: "required" });
    } else if (layerIds.has(id)) {
      errors.push({ path: `${path}/id`, message: "duplicate layer id" });
    } else {
      layerIds.add(id);
    }
    if ("name" in layerRecord && typeof layerRecord.name !== "string") {
      errors.push({ path: `${path}/name`, message: "must be a string" });
    }
    if (!readNonEmptyString(layerRecord.type)) {
      errors.push({ path: `${path}/type`, message: "required" });
    }
    if (!isNonNegativeFiniteNumber(layerRecord.startMs)) {
      errors.push({ path: `${path}/startMs`, message: "must be a non-negative finite number" });
    }
    if (!isPositiveFiniteNumber(layerRecord.durationMs)) {
      errors.push({ path: `${path}/durationMs`, message: "must be a positive finite number" });
    }
    if ("visible" in layerRecord && typeof layerRecord.visible !== "boolean") {
      errors.push({ path: `${path}/visible`, message: "must be a boolean" });
    }
    if ("locked" in layerRecord && typeof layerRecord.locked !== "boolean") {
      errors.push({ path: `${path}/locked`, message: "must be a boolean" });
    }
  });
  return layerIds;
}

function validateMotionSafeAreas(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if (!("safeAreas" in record)) return;
  const safeAreas = readRecord(record.safeAreas);
  if (!safeAreas) {
    errors.push({ path: "/safeAreas", message: "must be an object" });
    return;
  }

  for (const [areaId, value] of Object.entries(safeAreas)) {
    const areaPath = `/safeAreas/${areaId}`;
    const area = readRecord(value);
    if (!area) {
      errors.push({ path: areaPath, message: "must be an object" });
      continue;
    }
    for (const edge of ["top", "right", "bottom", "left"]) {
      if (edge in area && !isNonNegativeFiniteNumber(area[edge])) {
        errors.push({ path: `${areaPath}/${edge}`, message: "must be a non-negative finite number" });
      }
    }
  }
}

function validateLayerTextFit(
  layer: unknown,
  path: string,
  safeAreaValue: unknown,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("textFit" in record)) return;
  const textFit = readRecord(record.textFit);
  if (!textFit) {
    errors.push({ path: `${path}/textFit`, message: "must be an object" });
    return;
  }
  if (record.type !== "text" && record.type !== "caption") {
    errors.push({ path: `${path}/textFit`, message: "is supported only on text and caption layers" });
    return;
  }
  const policy = readNonEmptyString(textFit.policy);
  if (policy !== "safe" && policy !== "allow-crop" && policy !== "auto-fit") {
    errors.push({ path: `${path}/textFit/policy`, message: "must be safe, allow-crop, or auto-fit" });
    return;
  }
  const safeAreaId = readNonEmptyString(textFit.safeAreaId);
  const safeAreas = readRecord(safeAreaValue);
  if (policy === "safe" || policy === "auto-fit") {
    if (!safeAreaId) {
      errors.push({ path: `${path}/textFit/safeAreaId`, message: "required for safe and auto-fit policies" });
    }
  } else if ("safeAreaId" in textFit && !safeAreaId) {
    errors.push({ path: `${path}/textFit/safeAreaId`, message: "must be a non-empty string" });
  }
  if (safeAreaId && (!safeAreas || !readRecord(safeAreas[safeAreaId]))) {
    errors.push({ path: `${path}/textFit/safeAreaId`, message: "must reference an existing motion.safeAreas entry" });
  }
  if ("minFontSize" in textFit) {
    if (!isPositiveFiniteNumber(textFit.minFontSize)) {
      errors.push({ path: `${path}/textFit/minFontSize`, message: "must be a positive finite number" });
    } else if (policy !== "auto-fit") {
      errors.push({ path: `${path}/textFit/minFontSize`, message: "is supported only with auto-fit policy" });
    }
  }
}

function validateTemplateDocument(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(record.compatibleLanes) || record.compatibleLanes.length === 0) {
    errors.push({ path: "/compatibleLanes", message: "must contain at least one lane" });
  }

  const paramIds = new Set<string>();
  const paramTypes = new Map<string, string>();
  if (Array.isArray(record.params)) {
    record.params.forEach((param, index) => {
      validateTemplateParam(param, index, errors, paramIds);
      const paramRecord = readRecord(param);
      if (typeof paramRecord?.id === "string" && typeof paramRecord.type === "string") {
        paramTypes.set(paramRecord.id, paramRecord.type);
      }
    });
  } else if ("params" in record) {
    errors.push({ path: "/params", message: "must be an array" });
  }

  if (Array.isArray(record.controls)) {
    record.controls.forEach((control, index) => {
      const controlRecord = readRecord(control);
      if (!controlRecord) {
        errors.push({ path: `/controls/${index}`, message: "must be an object" });
        return;
      }
      if (typeof controlRecord.paramId !== "string" || !paramIds.has(controlRecord.paramId)) {
        errors.push({ path: `/controls/${index}/paramId`, message: "must reference an existing param id" });
      }
    });
  } else if ("controls" in record) {
    errors.push({ path: "/controls", message: "must be an array" });
  }

  if (Array.isArray(record.bindings)) {
    record.bindings.forEach((binding, index) => {
      const bindingRecord = readRecord(binding);
      if (!bindingRecord) {
        errors.push({ path: `/bindings/${index}`, message: "must be an object" });
        return;
      }
      if (typeof bindingRecord.paramId !== "string" || !paramIds.has(bindingRecord.paramId)) {
        errors.push({ path: `/bindings/${index}/paramId`, message: "must reference an existing param id" });
      }
      const target = readRecord(bindingRecord.target);
      if (!target || !("path" in target)) {
        errors.push({ path: `/bindings/${index}/target/path`, message: "required" });
      } else if (typeof target.path !== "string" || !target.path.startsWith("/")) {
        errors.push({ path: `/bindings/${index}/target/path`, message: "must be a JSON pointer" });
      }
    });
  } else if ("bindings" in record) {
    errors.push({ path: "/bindings", message: "must be an array" });
  }

  if ("metadata" in record) {
    validateTemplateMetadata(record.metadata, "/metadata", errors, paramTypes);
  }
}

function validateTemplateMetadata(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
  paramTypes: Map<string, string>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }

  if ("inputSchema" in record && !readRecord(record.inputSchema)) {
    errors.push({ path: `${path}/inputSchema`, message: "must be an object" });
  }
  if ("inputExamples" in record) {
    validateTemplateInputExamples(record.inputExamples, `${path}/inputExamples`, errors);
  }
  if ("outputBounds" in record) {
    validateTemplateOutputBounds(record.outputBounds, `${path}/outputBounds`, errors);
  }
  if ("suitability" in record) {
    validateTemplateSuitability(record.suitability, `${path}/suitability`, errors);
  }
  if ("license" in record) {
    validateTemplateLicense(record.license, `${path}/license`, errors);
  }
  if ("provenance" in record) {
    validateTemplateProvenance(record.provenance, `${path}/provenance`, errors);
  }
  if ("assetsAttribution" in record) {
    validateTemplateAssetsAttribution(record.assetsAttribution, `${path}/assetsAttribution`, errors);
  }
  if ("preview" in record) {
    validateTemplatePreview(record.preview, `${path}/preview`, errors);
  }
  if ("performance" in record) {
    validateTemplatePerformance(record.performance, `${path}/performance`, errors);
  }
  if ("story" in record) {
    validateTemplateStory(record.story, `${path}/story`, errors, paramTypes);
  }
  if ("mediaSlots" in record) {
    validateTemplateMediaSlots(record.mediaSlots, `${path}/mediaSlots`, errors, paramTypes);
  }
  if ("qualityTargets" in record) {
    validateTemplateQualityTargets(record.qualityTargets, `${path}/qualityTargets`, errors);
  }
}

function validateTemplateStory(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
  paramTypes: Map<string, string>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("kind" in record && typeof record.kind !== "string") {
    errors.push({ path: `${path}/kind`, message: "must be a string" });
  }
  if (!Array.isArray(record.beats) || record.beats.length === 0 || record.beats.length > 32) {
    errors.push({ path: `${path}/beats`, message: "must contain between 1 and 32 beats" });
    return;
  }
  const ids = new Set<string>();
  record.beats.forEach((entry, index) => {
    const beatPath = `${path}/beats/${index}`;
    const beat = readRecord(entry);
    if (!beat) {
      errors.push({ path: beatPath, message: "must be an object" });
      return;
    }
    validateNonEmptyStringField(beat, "id", `${beatPath}/id`, errors);
    if (typeof beat.id === "string") {
      if (ids.has(beat.id)) errors.push({ path: `${beatPath}/id`, message: "duplicate beat id" });
      ids.add(beat.id);
    }
    validateNonEmptyStringField(beat, "intent", `${beatPath}/intent`, errors);
    if ("label" in beat && typeof beat.label !== "string") errors.push({ path: `${beatPath}/label`, message: "must be a string" });
    if ("cameraIntent" in beat && typeof beat.cameraIntent !== "string") errors.push({ path: `${beatPath}/cameraIntent`, message: "must be a string" });
    if (!isNonNegativeFiniteNumber(beat.startMs)) errors.push({ path: `${beatPath}/startMs`, message: "must be a non-negative finite number" });
    if (!isPositiveFiniteNumber(beat.durationMs)) errors.push({ path: `${beatPath}/durationMs`, message: "must be a positive finite number" });
    validateBoundedStringArray(beat.layerIds, `${beatPath}/layerIds`, errors, 64);
    validateBoundedStringArray(beat.mediaParamIds, `${beatPath}/mediaParamIds`, errors, 16, (paramId) => paramTypes.get(paramId) === "media", "must reference an existing media param id");
  });
}

function validateTemplateMediaSlots(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
  paramTypes: Map<string, string>
): void {
  if (!Array.isArray(value) || value.length > 16) {
    errors.push({ path, message: "must be an array with at most 16 slots" });
    return;
  }
  const paramIds = new Set<string>();
  value.forEach((entry, index) => {
    const slotPath = `${path}/${index}`;
    const slot = readRecord(entry);
    if (!slot) {
      errors.push({ path: slotPath, message: "must be an object" });
      return;
    }
    validateNonEmptyStringField(slot, "paramId", `${slotPath}/paramId`, errors);
    if (typeof slot.paramId === "string") {
      if (paramTypes.get(slot.paramId) !== "media") errors.push({ path: `${slotPath}/paramId`, message: "must reference an existing media param id" });
      if (paramIds.has(slot.paramId)) errors.push({ path: `${slotPath}/paramId`, message: "duplicate media slot param id" });
      paramIds.add(slot.paramId);
    }
    validateNonEmptyStringField(slot, "role", `${slotPath}/role`, errors);
    if ("description" in slot && typeof slot.description !== "string") errors.push({ path: `${slotPath}/description`, message: "must be a string" });
    if (!Array.isArray(slot.acceptedKinds) || slot.acceptedKinds.length === 0) {
      errors.push({ path: `${slotPath}/acceptedKinds`, message: "must contain at least one media kind" });
    } else {
      slot.acceptedKinds.forEach((kind, kindIndex) => {
        if (kind !== "image" && kind !== "video") errors.push({ path: `${slotPath}/acceptedKinds/${kindIndex}`, message: "must be image or video" });
      });
    }
    if ("fit" in slot && !["cover", "contain", "fill"].includes(String(slot.fit))) errors.push({ path: `${slotPath}/fit`, message: "must be cover, contain, or fill" });
    for (const field of ["minWidth", "minHeight", "minDurationMs", "maxDurationMs"]) {
      if (field in slot && !isPositiveFiniteNumber(slot[field])) errors.push({ path: `${slotPath}/${field}`, message: "must be a positive finite number" });
    }
    if ("rightsRequired" in slot && typeof slot.rightsRequired !== "boolean") errors.push({ path: `${slotPath}/rightsRequired`, message: "must be a boolean" });
  });
}

function validateTemplateQualityTargets(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const frames = record.representativeFramesMs;
  if ("manifest" in record && (typeof record.manifest !== "string" || !record.manifest.startsWith("quality/") || record.manifest.includes(".."))) {
    errors.push({ path: `${path}/manifest`, message: "must be a package-local quality/ path" });
  }
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 20) {
    errors.push({ path: `${path}/representativeFramesMs`, message: "must contain between 1 and 20 timestamps" });
  } else {
    let previous = -1;
    frames.forEach((frame, index) => {
      if (!isNonNegativeFiniteNumber(frame)) {
        errors.push({ path: `${path}/representativeFramesMs/${index}`, message: "must be a non-negative finite number" });
      } else if (frame <= previous) {
        errors.push({ path: `${path}/representativeFramesMs/${index}`, message: "must be strictly increasing" });
      }
      if (typeof frame === "number") previous = frame;
    });
  }
  if ("minDistinctFrames" in record && (!Number.isInteger(record.minDistinctFrames) || Number(record.minDistinctFrames) < 1)) {
    errors.push({ path: `${path}/minDistinctFrames`, message: "must be a positive integer" });
  } else if (Array.isArray(frames) && typeof record.minDistinctFrames === "number" && record.minDistinctFrames > frames.length) {
    errors.push({ path: `${path}/minDistinctFrames`, message: "cannot exceed representative frame count" });
  }
  if ("maxBlankFrames" in record && (!Number.isInteger(record.maxBlankFrames) || Number(record.maxBlankFrames) < 0)) errors.push({ path: `${path}/maxBlankFrames`, message: "must be a non-negative integer" });
  if ("minEdgePixels" in record && !isNonNegativeFiniteNumber(record.minEdgePixels)) errors.push({ path: `${path}/minEdgePixels`, message: "must be a non-negative finite number" });
  if ("minLumaRange" in record && !isNonNegativeFiniteNumber(record.minLumaRange)) errors.push({ path: `${path}/minLumaRange`, message: "must be a non-negative finite number" });
  for (const field of ["requireTextFit", "requireSafeAreas"]) {
    if (field in record && typeof record[field] !== "boolean") errors.push({ path: `${path}/${field}`, message: "must be a boolean" });
  }
}

function validateBoundedStringArray(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
  maxItems: number,
  predicate?: (value: string) => boolean,
  predicateMessage = "must be a valid value"
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maxItems) {
    errors.push({ path, message: `must be an array with at most ${maxItems} items` });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) errors.push({ path: `${path}/${index}`, message: "must be a non-empty string" });
    else if (predicate && !predicate(entry)) errors.push({ path: `${path}/${index}`, message: predicateMessage });
  });
}

function validateTemplateInputExamples(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (!readRecord(entry)) {
      errors.push({ path: `${path}/${index}`, message: "must be an object" });
    }
  });
}

function validateTemplateOutputBounds(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["minWidth", "maxWidth", "minHeight", "maxHeight", "minDurationMs", "maxDurationMs"]) {
    if (field in record && !isPositiveFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a positive finite number" });
    }
  }
  if ("aspectRatios" in record) {
    if (!Array.isArray(record.aspectRatios)) {
      errors.push({ path: `${path}/aspectRatios`, message: "must be an array" });
      return;
    }
    record.aspectRatios.forEach((aspectRatio, index) => {
      if (typeof aspectRatio !== "string" || !isTemplateAspectRatio(aspectRatio)) {
        errors.push({ path: `${path}/aspectRatios/${index}`, message: "must be WIDTH:HEIGHT" });
      }
    });
  }
}

function validateTemplateSuitability(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["bestFor", "notFor"]) {
    if (!(field in record)) continue;
    const entries = record[field];
    if (!Array.isArray(entries)) {
      errors.push({ path: `${path}/${field}`, message: "must be an array" });
      continue;
    }
    entries.forEach((entry, index) => {
      if (typeof entry !== "string") {
        errors.push({ path: `${path}/${field}/${index}`, message: "must be a string" });
      }
    });
  }
}

function validateTemplateLicense(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateRequiredFields(record, path, ["id"], errors);
  validateNonEmptyStringField(record, "id", `${path}/id`, errors);
  for (const field of ["label", "url", "attribution", "spdxId", "notes"]) {
    if (field in record && typeof record[field] !== "string") {
      errors.push({ path: `${path}/${field}`, message: "must be a string" });
    }
  }
  for (const field of ["attributionRequired", "redistributionAllowed", "commercialUse"]) {
    if (field in record && typeof record[field] !== "boolean") {
      errors.push({ path: `${path}/${field}`, message: "must be a boolean" });
    }
  }
}

function validateTemplateProvenance(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["source", "generatedBy"]) {
    if (field in record && typeof record[field] !== "string") {
      errors.push({ path: `${path}/${field}`, message: "must be a string" });
    }
  }
  if ("sourceUrl" in record && !isHttpUrl(record.sourceUrl)) {
    errors.push({ path: `${path}/sourceUrl`, message: "must be an http(s) URL" });
  }
  if ("sourceHash" in record && !isSha256HexString(record.sourceHash)) {
    errors.push({ path: `${path}/sourceHash`, message: "must be a sha256 hex string" });
  }
}

function validateTemplateAssetsAttribution(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const itemPath = `${path}/${index}`;
    const record = readRecord(entry);
    if (!record) {
      errors.push({ path: itemPath, message: "must be an object" });
      return;
    }
    validateNonEmptyStringField(record, "name", `${itemPath}/name`, errors);
    for (const field of ["license", "author", "path"]) {
      if (field in record && typeof record[field] !== "string") {
        errors.push({ path: `${itemPath}/${field}`, message: "must be a string" });
      }
    }
    if ("url" in record && !isHttpUrl(record.url)) {
      errors.push({ path: `${itemPath}/url`, message: "must be an http(s) URL" });
    }
  });
}

function validateTemplatePreview(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const field of ["poster", "loop", "thumbnail"]) {
    if (field in record && typeof record[field] !== "string") {
      errors.push({ path: `${path}/${field}`, message: "must be a string" });
    }
  }
}

function validateTemplatePerformance(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if ("recommendedLane" in record && typeof record.recommendedLane !== "string") {
    errors.push({ path: `${path}/recommendedLane`, message: "must be a string" });
  }
  if ("renderCost" in record && !["low", "medium", "high"].includes(String(record.renderCost))) {
    errors.push({ path: `${path}/renderCost`, message: "must be low, medium, or high" });
  }
  if ("previewFps" in record && !isPositiveFiniteNumber(record.previewFps)) {
    errors.push({ path: `${path}/previewFps`, message: "must be a positive finite number" });
  }
  if ("notes" in record) {
    if (!Array.isArray(record.notes)) {
      errors.push({ path: `${path}/notes`, message: "must be an array" });
      return;
    }
    record.notes.forEach((note, index) => {
      if (typeof note !== "string") {
        errors.push({ path: `${path}/notes/${index}`, message: "must be a string" });
      }
    });
  }
}

function isTemplateAspectRatio(value: string): boolean {
  return /^[1-9][0-9]*:[1-9][0-9]*$/.test(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateTemplateParam(
  param: unknown,
  index: number,
  errors: Array<{ path: string; message: string }>,
  paramIds: Set<string>
): void {
  const record = readRecord(param);
  if (!record) {
    errors.push({ path: `/params/${index}`, message: "must be an object" });
    return;
  }

  const id = typeof record.id === "string" ? record.id : "";
  if (!id) {
    errors.push({ path: `/params/${index}/id`, message: "required" });
  } else if (paramIds.has(id)) {
    errors.push({ path: `/params/${index}/id`, message: "duplicate param id" });
  } else {
    paramIds.add(id);
  }

  const type = typeof record.type === "string" ? record.type : "";
  if (!SUPPORTED_TEMPLATE_PARAM_TYPES.has(type)) {
    errors.push({ path: `/params/${index}/type`, message: "unsupported param type" });
    return;
  }

  validateTemplateDefault(record, type, `/params/${index}`, errors);
  if ("min" in record && !isFiniteNumber(record.min)) {
    errors.push({ path: `/params/${index}/min`, message: "must be a finite number" });
  }
  if ("max" in record && !isFiniteNumber(record.max)) {
    errors.push({ path: `/params/${index}/max`, message: "must be a finite number" });
  }
  if ("step" in record && !isPositiveFiniteNumber(record.step)) {
    errors.push({ path: `/params/${index}/step`, message: "must be a positive finite number" });
  }
}

function validateTemplateDefault(
  record: Record<string, unknown>,
  type: string,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (!("defaultValue" in record)) {
    errors.push({ path: `${path}/defaultValue`, message: "required" });
    return;
  }
  if (type === "number" && !isFiniteNumber(record.defaultValue)) {
    errors.push({ path: `${path}/defaultValue`, message: "must match param type number" });
  }
  if ((type === "text" || type === "color" || type === "media") && typeof record.defaultValue !== "string") {
    errors.push({ path: `${path}/defaultValue`, message: `must match param type ${type}` });
  }
  if (type === "boolean" && typeof record.defaultValue !== "boolean") {
    errors.push({ path: `${path}/defaultValue`, message: "must match param type boolean" });
  }
  if (type === "select") {
    const options = Array.isArray(record.options) ? record.options : [];
    const optionValues: unknown[] = [];
    options.forEach((option, optionIndex) => {
      const optionRecord = readRecord(option);
      if (!optionRecord || !("value" in optionRecord)) {
        errors.push({ path: `${path}/options/${optionIndex}/value`, message: "required" });
        return;
      }
      optionValues.push(optionRecord.value);
    });
    if (!optionValues.some((value) => value === record.defaultValue)) {
      errors.push({ path: `${path}/defaultValue`, message: "must match one select option value" });
    }
  }
}

function validateAudioLayerControls(
  layer: unknown,
  path: string,
  layerIds: Set<string>,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  const isAudioLayer = record?.type === "audio";
  const isVideoAudioLayer = record?.type === "video" && record.includeAudio === true;
  if (!record || (!isAudioLayer && !isVideoAudioLayer)) return;
  if (isAudioLayer) {
    if ("trimStartMs" in record && !isNonNegativeFiniteNumber(record.trimStartMs)) {
      errors.push({ path: `${path}/trimStartMs`, message: "must be a non-negative finite number" });
    }
    if ("trimDurationMs" in record && !isPositiveFiniteNumber(record.trimDurationMs)) {
      errors.push({ path: `${path}/trimDurationMs`, message: "must be a positive finite number" });
    }
    if ("loop" in record && typeof record.loop !== "boolean") {
      errors.push({ path: `${path}/loop`, message: "must be a boolean" });
    }
  }
  if ("volume" in record && !isNonNegativeFiniteNumber(record.volume)) {
    errors.push({ path: `${path}/volume`, message: "must be a non-negative finite number" });
  }
  if ("pan" in record && !isPanNumber(record.pan)) {
    errors.push({ path: `${path}/pan`, message: "must be a finite number between -1 and 1" });
  }
  if ("muted" in record && typeof record.muted !== "boolean") {
    errors.push({ path: `${path}/muted`, message: "must be a boolean" });
  }
  if ("fadeInMs" in record && !isNonNegativeFiniteNumber(record.fadeInMs)) {
    errors.push({ path: `${path}/fadeInMs`, message: "must be a non-negative finite number" });
  }
  if ("fadeOutMs" in record && !isNonNegativeFiniteNumber(record.fadeOutMs)) {
    errors.push({ path: `${path}/fadeOutMs`, message: "must be a non-negative finite number" });
  }
  if ("fadeCurve" in record && record.fadeCurve !== "linear" && record.fadeCurve !== "equal-power") {
    errors.push({ path: `${path}/fadeCurve`, message: 'must be "linear" or "equal-power"' });
  }
  if ("normalizeLoudness" in record && typeof record.normalizeLoudness !== "boolean") {
    errors.push({ path: `${path}/normalizeLoudness`, message: "must be a boolean" });
  }
  validateAudioDuckingControls(record, `${path}/ducking`, layerIds, errors);
}

function validateAudioDuckingControls(
  record: Record<string, unknown>,
  path: string,
  layerIds: Set<string>,
  errors: Array<{ path: string; message: string }>
): void {
  if (!("ducking" in record)) return;
  const ducking = readRecord(record.ducking);
  if (!ducking) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (!Array.isArray(ducking.triggerLayerIds) || ducking.triggerLayerIds.length === 0) {
    errors.push({ path: `${path}/triggerLayerIds`, message: "must be a non-empty array" });
  } else {
    ducking.triggerLayerIds.forEach((triggerLayerId, index) => {
      if (typeof triggerLayerId !== "string" || !layerIds.has(triggerLayerId)) {
        errors.push({ path: `${path}/triggerLayerIds/${index}`, message: "must reference an existing layer id" });
      }
    });
  }
  if ("mode" in ducking && ducking.mode !== "timed" && ducking.mode !== "sidechain") {
    errors.push({ path: `${path}/mode`, message: 'must be "timed" or "sidechain"' });
  }
  if ("duckToVolume" in ducking && !isNonNegativeFiniteNumber(ducking.duckToVolume)) {
    errors.push({ path: `${path}/duckToVolume`, message: "must be a non-negative finite number" });
  }
  if ("attackMs" in ducking && !isNonNegativeFiniteNumber(ducking.attackMs)) {
    errors.push({ path: `${path}/attackMs`, message: "must be a non-negative finite number" });
  }
  if ("releaseMs" in ducking && !isNonNegativeFiniteNumber(ducking.releaseMs)) {
    errors.push({ path: `${path}/releaseMs`, message: "must be a non-negative finite number" });
  }
  // Sidechain compressor threshold: FFmpeg sidechaincompress accepts a linear
  // amplitude in (0, 1]. Reject <= 0 or > 1 so the filter never receives an
  // out-of-range value.
  if ("threshold" in ducking && !(isFiniteNumber(ducking.threshold) && (ducking.threshold as number) > 0 && (ducking.threshold as number) <= 1)) {
    errors.push({ path: `${path}/threshold`, message: "must be a finite number in (0, 1]" });
  }
  // Compression ratio must be >= 1 (a ratio below 1 would expand rather than duck).
  if ("ratio" in ducking && !(isFiniteNumber(ducking.ratio) && (ducking.ratio as number) >= 1)) {
    errors.push({ path: `${path}/ratio`, message: "must be a finite number >= 1" });
  }
}

function validateVideoLayerControls(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || record.type !== "video") return;
  if ("trimStartMs" in record && !isNonNegativeFiniteNumber(record.trimStartMs)) {
    errors.push({ path: `${path}/trimStartMs`, message: "must be a non-negative finite number" });
  }
  if ("trimDurationMs" in record && !isPositiveFiniteNumber(record.trimDurationMs)) {
    errors.push({ path: `${path}/trimDurationMs`, message: "must be a positive finite number" });
  }
  if ("loop" in record && typeof record.loop !== "boolean") {
    errors.push({ path: `${path}/loop`, message: "must be a boolean" });
  }
  if ("playbackRate" in record && !isPositiveFiniteNumber(record.playbackRate)) {
    errors.push({ path: `${path}/playbackRate`, message: "must be a positive finite number" });
  }
  if ("includeAudio" in record && typeof record.includeAudio !== "boolean") {
    errors.push({ path: `${path}/includeAudio`, message: "must be a boolean" });
  }
}

function validateTimelineTracks(
  record: Record<string, unknown>,
  layerIds: Set<string>,
  errors: Array<{ path: string; message: string }>
): Set<string> {
  const trackIds = new Set<string>();
  if (!("tracks" in record)) return trackIds;
  if (!Array.isArray(record.tracks)) {
    errors.push({ path: "/tracks", message: "must be an array" });
    return trackIds;
  }

  record.tracks.forEach((track, index) => {
    const path = `/tracks/${index}`;
    const trackRecord = readRecord(track);
    if (!trackRecord) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    const id = readNonEmptyString(trackRecord.id);
    if (!id) {
      errors.push({ path: `${path}/id`, message: "required" });
    } else if (trackIds.has(id)) {
      errors.push({ path: `${path}/id`, message: "duplicate track id" });
    } else {
      trackIds.add(id);
    }
    if (!readNonEmptyString(trackRecord.type)) {
      errors.push({ path: `${path}/type`, message: "required" });
    }
    if ("name" in trackRecord && typeof trackRecord.name !== "string") {
      errors.push({ path: `${path}/name`, message: "must be a string" });
    }
    if ("order" in trackRecord && !isFiniteNumber(trackRecord.order)) {
      errors.push({ path: `${path}/order`, message: "must be a finite number" });
    }
    validateStringRefArray(trackRecord.layerIds, `${path}/layerIds`, layerIds, "must reference an existing layer id", errors);
    if ("locked" in trackRecord && typeof trackRecord.locked !== "boolean") {
      errors.push({ path: `${path}/locked`, message: "must be a boolean" });
    }
    if ("muted" in trackRecord && typeof trackRecord.muted !== "boolean") {
      errors.push({ path: `${path}/muted`, message: "must be a boolean" });
    }
    if ("solo" in trackRecord && typeof trackRecord.solo !== "boolean") {
      errors.push({ path: `${path}/solo`, message: "must be a boolean" });
    }
    if ("volume" in trackRecord && !isNonNegativeFiniteNumber(trackRecord.volume)) {
      errors.push({ path: `${path}/volume`, message: "must be a non-negative finite number" });
    }
    if ("pan" in trackRecord && !isPanNumber(trackRecord.pan)) {
      errors.push({ path: `${path}/pan`, message: "must be a finite number between -1 and 1" });
    }
    if ("fadeInMs" in trackRecord && !isNonNegativeFiniteNumber(trackRecord.fadeInMs)) {
      errors.push({ path: `${path}/fadeInMs`, message: "must be a non-negative finite number" });
    }
    if ("fadeOutMs" in trackRecord && !isNonNegativeFiniteNumber(trackRecord.fadeOutMs)) {
      errors.push({ path: `${path}/fadeOutMs`, message: "must be a non-negative finite number" });
    }
  });
  return trackIds;
}

function validateTimelineMarkers(
  record: Record<string, unknown>,
  durationMs: number | undefined,
  errors: Array<{ path: string; message: string }>
): Set<string> {
  const markerIds = new Set<string>();
  if (!("markers" in record)) return markerIds;
  if (!Array.isArray(record.markers)) {
    errors.push({ path: "/markers", message: "must be an array" });
    return markerIds;
  }

  record.markers.forEach((marker, index) => {
    const path = `/markers/${index}`;
    const markerRecord = readRecord(marker);
    if (!markerRecord) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    const id = readNonEmptyString(markerRecord.id);
    if (!id) {
      errors.push({ path: `${path}/id`, message: "required" });
    } else if (markerIds.has(id)) {
      errors.push({ path: `${path}/id`, message: "duplicate marker id" });
    } else {
      markerIds.add(id);
    }
    const atMs = readNonNegativeFiniteNumber(markerRecord.atMs);
    if (atMs === null) {
      errors.push({ path: `${path}/atMs`, message: "must be a non-negative finite number" });
    } else if (durationMs !== undefined && atMs > durationMs) {
      errors.push({ path: `${path}/atMs`, message: "must fit within document durationMs" });
    }
    if ("durationMs" in markerRecord && !isNonNegativeFiniteNumber(markerRecord.durationMs)) {
      errors.push({ path: `${path}/durationMs`, message: "must be a non-negative finite number" });
    }
    if ("label" in markerRecord && typeof markerRecord.label !== "string") {
      errors.push({ path: `${path}/label`, message: "must be a string" });
    }
    if ("type" in markerRecord && typeof markerRecord.type !== "string") {
      errors.push({ path: `${path}/type`, message: "must be a string" });
    }
    if ("color" in markerRecord && typeof markerRecord.color !== "string") {
      errors.push({ path: `${path}/color`, message: "must be a string" });
    }
  });
  return markerIds;
}

function collectTimelineMarkerIds(record: Record<string, unknown>): Set<string> {
  const markerIds = new Set<string>();
  if (!Array.isArray(record.markers)) return markerIds;
  record.markers.forEach((marker) => {
    const markerRecord = readRecord(marker);
    const id = readNonEmptyString(markerRecord?.id);
    if (id) markerIds.add(id);
  });
  return markerIds;
}

function validateTimelineScenes(
  record: Record<string, unknown>,
  layerIds: Set<string>,
  trackIds: Set<string>,
  markerIds: Set<string>,
  durationMs: number | undefined,
  errors: Array<{ path: string; message: string }>
): void {
  const sceneIds = new Set<string>();
  if (!("scenes" in record)) return;
  if (!Array.isArray(record.scenes)) {
    errors.push({ path: "/scenes", message: "must be an array" });
    return;
  }

  record.scenes.forEach((scene, index) => {
    const path = `/scenes/${index}`;
    const sceneRecord = readRecord(scene);
    if (!sceneRecord) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    const id = readNonEmptyString(sceneRecord.id);
    if (!id) {
      errors.push({ path: `${path}/id`, message: "required" });
    } else if (sceneIds.has(id)) {
      errors.push({ path: `${path}/id`, message: "duplicate scene id" });
    } else {
      sceneIds.add(id);
    }
    if ("name" in sceneRecord && typeof sceneRecord.name !== "string") {
      errors.push({ path: `${path}/name`, message: "must be a string" });
    }
    if (!isNonNegativeFiniteNumber(sceneRecord.startMs)) {
      errors.push({ path: `${path}/startMs`, message: "must be a non-negative finite number" });
    }
    if (!isPositiveFiniteNumber(sceneRecord.durationMs)) {
      errors.push({ path: `${path}/durationMs`, message: "must be a positive finite number" });
    }
    const startMs = readNonNegativeFiniteNumber(sceneRecord.startMs);
    const sceneDurationMs = readPositiveFiniteNumber(sceneRecord.durationMs);
    if (durationMs !== undefined && startMs !== null && sceneDurationMs !== null && startMs + sceneDurationMs > durationMs) {
      errors.push({ path, message: "must fit within document durationMs" });
    }
    validateStringRefArray(sceneRecord.trackIds, `${path}/trackIds`, trackIds, "must reference an existing track id", errors);
    validateStringRefArray(sceneRecord.markerIds, `${path}/markerIds`, markerIds, "must reference an existing marker id", errors);
    validateStringRefArray(sceneRecord.layerIds, `${path}/layerIds`, layerIds, "must reference an existing layer id", errors);
  });
}

function validateLayerTimelineRefs(
  layer: unknown,
  path: string,
  trackIds: Set<string>,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("trackId" in record)) return;
  if (typeof record.trackId !== "string" || !trackIds.has(record.trackId)) {
    errors.push({ path: `${path}/trackId`, message: "must reference an existing track id" });
  }
}

function validateLayerTransform(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("transform" in record)) return;
  const transform = readRecord(record.transform);
  if (!transform) {
    errors.push({ path: `${path}/transform`, message: "must be an object" });
    return;
  }
  for (const key of ["originX", "originY"] as const) {
    if (key in transform && !isFiniteNumber(transform[key])) {
      errors.push({ path: `${path}/transform/${key}`, message: "must be a finite number" });
    }
  }
}

function validateLayerCrop(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("crop" in record)) return;
  if (!supportsSourceCrop(record.type)) {
    errors.push({ path: `${path}/crop`, message: "supported only on image or video layers" });
  }
  const crop = readRecord(record.crop);
  if (!crop) {
    errors.push({ path: `${path}/crop`, message: "must be an object" });
    return;
  }
  if (crop.x === undefined || !isNonNegativeFiniteNumber(crop.x)) {
    errors.push({ path: `${path}/crop/x`, message: "must be a non-negative finite number" });
  }
  if (crop.y === undefined || !isNonNegativeFiniteNumber(crop.y)) {
    errors.push({ path: `${path}/crop/y`, message: "must be a non-negative finite number" });
  }
  if (crop.width === undefined || !isPositiveFiniteNumber(crop.width)) {
    errors.push({ path: `${path}/crop/width`, message: "must be a positive finite number" });
  }
  if (crop.height === undefined || !isPositiveFiniteNumber(crop.height)) {
    errors.push({ path: `${path}/crop/height`, message: "must be a positive finite number" });
  }
}

function validateStringRefArray(
  value: unknown,
  path: string,
  ids: Set<string>,
  message: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !ids.has(entry)) {
      errors.push({ path: `${path}/${index}`, message });
    }
  });
}

function validateLayerMask(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("mask" in record)) return;
  const mask = readRecord(record.mask);
  if (!mask) {
    errors.push({ path: `${path}/mask`, message: "must be an object" });
    return;
  }
  const maskType = mask.type;
  if (maskType !== "rect" && maskType !== "rounded-rect" && maskType !== "path" && maskType !== "roto") {
    errors.push({ path: `${path}/mask/type`, message: "unsupported mask type" });
  }
  if (maskType === "roto") return;
  if ("inset" in mask) {
    const inset = readRecord(mask.inset);
    if (!inset) {
      errors.push({ path: `${path}/mask/inset`, message: "must be an object" });
    } else {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        if (side in inset && !isNonNegativeFiniteNumber(inset[side])) {
          errors.push({ path: `${path}/mask/inset/${side}`, message: "must be a non-negative finite number" });
        }
      }
    }
  }
  if ("radius" in mask && !isNonNegativeFiniteNumber(mask.radius)) {
    errors.push({ path: `${path}/mask/radius`, message: "must be a non-negative finite number" });
  }
  if (maskType === "path") {
    if ("inset" in mask) errors.push({ path: `${path}/mask/inset`, message: "not supported on path masks" });
    if ("radius" in mask) errors.push({ path: `${path}/mask/radius`, message: "not supported on path masks" });
    try {
      validateMotionPathData(mask.path, "Path mask");
    } catch (error) {
      errors.push({ path: `${path}/mask/path`, message: validationErrorMessage(error) });
    }
    try {
      parseMotionPathViewBox(mask.viewBox, "Path mask viewBox");
    } catch (error) {
      errors.push({ path: `${path}/mask/viewBox`, message: validationErrorMessage(error) });
    }
    if ("fillRule" in mask && mask.fillRule !== "nonzero" && mask.fillRule !== "evenodd") {
      errors.push({ path: `${path}/mask/fillRule`, message: "must be nonzero or evenodd" });
    }
    const transitions = readRecord(record.transitions);
    for (const edge of ["in", "out"] as const) {
      if (readRecord(transitions?.[edge])?.type === "wipe") {
        errors.push({ path: `${path}/transitions/${edge}/type`, message: "wipe transitions cannot yet be combined with path masks" });
      }
    }
  } else if (maskType === "rect" || maskType === "rounded-rect") {
    for (const field of ["path", "viewBox", "fillRule"] as const) {
      if (field in mask) errors.push({ path: `${path}/mask/${field}`, message: "supported only on path masks" });
    }
  }
}

function validateCameraLayers(
  layers: unknown[],
  errors: Array<{ path: string; message: string }>
): void {
  const cameras = layers
    .map((value, index) => ({ layer: readRecord(value), index }))
    .filter((entry) => entry.layer?.type === "camera");
  if (cameras.length > 1) {
    cameras.slice(1).forEach(({ index }) => {
      errors.push({ path: `/layers/${index}/type`, message: "only one camera layer is supported" });
    });
  }
  for (const { layer, index } of cameras) {
    if (!layer) continue;
    const path = `/layers/${index}`;
    const unsupportedFields = [
      "text", "shape", "fill", "source", "src", "assetId", "assetRef", "style", "label",
      "mask", "matte", "effects", "gradient", "emitter", "blendMode", "transitions"
    ] as const;
    for (const field of unsupportedFields) {
      if (field in layer) errors.push({ path: `${path}/${field}`, message: "is not supported on camera layers" });
    }
    const transform = readRecord(layer.transform);
    if (transform && "scale" in transform) {
      const scale = readFiniteNumber(transform.scale);
      if (scale === null || scale <= 0) {
        errors.push({ path: `${path}/transform/scale`, message: "must be a positive finite number on camera layers" });
      } else if (scale < 0.001 || scale > 100) {
        errors.push({ path: `${path}/transform/scale`, message: "must be between 0.001 and 100 on camera layers" });
      }
    }
    const keyframes = readRecord(layer.keyframes);
    if (keyframes) {
      const supportedTargets = new Set(["transform.x", "transform.y", "transform.scale", "transform.rotation", "transform.originX", "transform.originY"]);
      for (const target of Object.keys(keyframes)) {
        if (!supportedTargets.has(target)) {
          errors.push({ path: `${path}/keyframes/${target}`, message: "unsupported camera transform keyframe" });
        } else if (target === "transform.scale" && Array.isArray(keyframes[target])) {
          keyframes[target].forEach((value, keyframeIndex) => {
            const scale = readFiniteNumber(readRecord(value)?.value);
            if (scale !== null && scale > 0 && (scale < 0.001 || scale > 100)) {
              errors.push({
                path: `${path}/keyframes/${target}/${keyframeIndex}/value`,
                message: "must be between 0.001 and 100 on camera layers"
              });
            }
          });
        }
      }
    }
  }
}

function validateDepthLayers(
  layers: unknown[],
  errors: Array<{ path: string; message: string }>
): void {
  const hasCamera = layers.some((value) => readRecord(value)?.type === "camera");
  const visualTypes = GENERATED_VISUAL_LAYER_TYPE_SET;
  const hasDepth = layers.some((value) => "depth" in (readRecord(value) ?? {}));
  layers.forEach((value, index) => {
    const layer = readRecord(value);
    if (!layer) return;
    if (hasDepth && visualTypes.has(String(layer.type)) && !("depth" in layer)) {
      errors.push({ path: `/layers/${index}/depth`, message: "is required on every generated visual layer in a depth composition" });
    }
    if (!("depth" in layer)) return;
    const path = `/layers/${index}/depth`;
    const depth = readFiniteNumber(layer.depth);
    if (depth === null || depth < -0.9 || depth > 3) {
      errors.push({ path, message: "must be a finite number between -0.9 and 3" });
    }
    if (!visualTypes.has(String(layer.type))) {
      errors.push({ path, message: "is supported only on generated visual layers" });
    }
    if (!hasCamera) {
      errors.push({ path, message: "requires a camera layer" });
    }
    if (layer.blendMode !== undefined && layer.blendMode !== "normal") {
      errors.push({ path: `/layers/${index}/blendMode`, message: "depth planes do not yet support layer blend modes" });
    }
    if ("matte" in layer) {
      errors.push({ path: `/layers/${index}/matte`, message: "depth planes do not yet support mattes" });
    }
  });
}

function validateShaderLayers(
  layers: unknown[],
  assets: unknown[],
  errors: Array<{ path: string; message: string }>
): void {
  const shaderAssets = new Map<string, number>();
  assets.forEach((value, index) => {
    const asset = readRecord(value);
    if (asset?.type !== "shader") return;
    const path = `/assets/${index}`;
    const id = readNonEmptyString(asset.id);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      errors.push({ path: `${path}/id`, message: "must be a safe shader asset id" });
    } else if (shaderAssets.has(id)) {
      errors.push({ path: `${path}/id`, message: "must be unique among shader assets" });
    } else {
      shaderAssets.set(id, index);
    }
    const source = readRecord(asset.source);
    if (!source) {
      errors.push({ path: `${path}/source`, message: "must be an object" });
    } else {
      if (!readNonEmptyString(source.path)) errors.push({ path: `${path}/source/path`, message: "must be a non-empty string" });
      if (source.mimeType !== "text/x-shellx-motion-glsl") {
        errors.push({ path: `${path}/source/mimeType`, message: "must be text/x-shellx-motion-glsl" });
      }
    }
  });
  if (shaderAssets.size > 4) errors.push({ path: "/assets", message: "must contain at most 4 shader assets" });

  const shaderLayers = layers
    .map((value, index) => ({ layer: readRecord(value), index }))
    .filter((entry) => entry.layer?.type === "shader");
  if (shaderLayers.length > 4) {
    shaderLayers.slice(4).forEach(({ index }) => errors.push({ path: `/layers/${index}/type`, message: "at most 4 shader layers are supported" }));
  }
  for (const { layer, index } of shaderLayers) {
    if (!layer) continue;
    const path = `/layers/${index}`;
    const shader = readRecord(layer.shader);
    if (!shader) {
      errors.push({ path: `${path}/shader`, message: "must be an object" });
      continue;
    }
    if (shader.schema !== RESTRICTED_SHADER_SCHEMA) errors.push({ path: `${path}/shader/schema`, message: `must be ${RESTRICTED_SHADER_SCHEMA}` });
    if (shader.language !== RESTRICTED_SHADER_LANGUAGE) errors.push({ path: `${path}/shader/language`, message: `must be ${RESTRICTED_SHADER_LANGUAGE}` });
    const fragmentAssetId = readNonEmptyString(shader.fragmentAssetId);
    if (!fragmentAssetId || !shaderAssets.has(fragmentAssetId)) {
      errors.push({ path: `${path}/shader/fragmentAssetId`, message: "must reference a shader asset" });
    }
    if (!Number.isInteger(shader.seed) || !isNonNegativeFiniteNumber(shader.seed) || Number(shader.seed) > 0xffff_ffff) {
      errors.push({ path: `${path}/shader/seed`, message: "must be an unsigned 32-bit integer" });
    }
    if (!isSupportedColorString(shader.fallbackColor)) {
      errors.push({ path: `${path}/shader/fallbackColor`, message: "must be a supported color string" });
    }
    if (shader.uniforms !== undefined) {
      const uniforms = readRecord(shader.uniforms);
      if (!uniforms) {
        errors.push({ path: `${path}/shader/uniforms`, message: "must be an object" });
      } else {
        const entries = Object.entries(uniforms);
        if (entries.length > MAX_RESTRICTED_SHADER_UNIFORMS) {
          errors.push({ path: `${path}/shader/uniforms`, message: `must contain at most ${MAX_RESTRICTED_SHADER_UNIFORMS} uniforms` });
        }
        for (const [name, value] of entries) {
          if (!isSafeShaderUniformName(name)) errors.push({ path: `${path}/shader/uniforms/${name}`, message: "has an unsafe or reserved uniform name" });
          const number = readFiniteNumber(value);
          if (number === null || Math.abs(number) > 1_000_000) {
            errors.push({ path: `${path}/shader/uniforms/${name}`, message: "must be a finite number between -1000000 and 1000000" });
          }
        }
      }
    }
    validateGpuMaterialExtension(shader,path,errors);
    const unsupportedFields = ["text", "shape", "fill", "source", "src", "assetId", "assetRef", "label", "gradient", "emitter"] as const;
    for (const field of unsupportedFields) {
      if (field in layer) errors.push({ path: `${path}/${field}`, message: "is not supported on shader layers" });
    }
  }
}

function validateEnvironmentLayers(
  layers: unknown[],
  documentWidth: number | null,
  documentHeight: number | null,
  errors: Array<{ path: string; message: string }>
): void {
  const environmentLayers = layers
    .map((value, index) => ({ layer: readRecord(value), index }))
    .filter((entry) => entry.layer?.type === "environment");
  if (environmentLayers.length > MAX_ENVIRONMENT_LAYERS) {
    environmentLayers.slice(MAX_ENVIRONMENT_LAYERS).forEach(({ index }) => errors.push({
      path: `/layers/${index}/type`,
      message: `at most ${MAX_ENVIRONMENT_LAYERS} environment layers are supported`
    }));
  }
  for (const { layer, index } of environmentLayers) {
    if (!layer) continue;
    const path = `/layers/${index}`;
    const environment = readRecord(layer.environment);
    if (!environment) {
      errors.push({ path: `${path}/environment`, message: "must be an object" });
      continue;
    }
    if (environment.schema !== ENVIRONMENT_SCHEMA) {
      errors.push({ path: `${path}/environment/schema`, message: `must be ${ENVIRONMENT_SCHEMA}` });
    }
    if (!(ENVIRONMENT_KINDS as readonly unknown[]).includes(environment.kind)) {
      errors.push({ path: `${path}/environment/kind`, message: `must be ${ENVIRONMENT_KINDS.join(", ")}` });
    }
    if (!Number.isInteger(environment.seed) || !isNonNegativeFiniteNumber(environment.seed) || Number(environment.seed) > 0xffff_ffff) {
      errors.push({ path: `${path}/environment/seed`, message: "must be an unsigned 32-bit integer" });
    }
    if (!(ENVIRONMENT_QUALITY_TIERS as readonly unknown[]).includes(environment.quality)) {
      errors.push({ path: `${path}/environment/quality`, message: `must be ${ENVIRONMENT_QUALITY_TIERS.join(", ")}` });
    }
    if (environment.mode !== "scene" && environment.mode !== "overlay") {
      errors.push({ path: `${path}/environment/mode`, message: "must be scene or overlay" });
    }
    validateEnvironmentSceneSource(
      layers,
      index,
      layer,
      environment,
      documentWidth,
      documentHeight,
      errors
    );
    validateEnvironmentEffectMask(
      layers,
      index,
      layer,
      environment,
      documentWidth,
      documentHeight,
      errors
    );
    for (const field of ["code", "script", "source", "fragment", "url"]) {
      if (field in environment) {
        errors.push({ path: `${path}/environment/${field}`, message: "executable or external source fields are not supported" });
      }
    }
    if (environment.kind === "rain") {
      validateEnvironmentNumber(environment, "intensity", 0, 1, `${path}/environment`, errors);
      validateEnvironmentNumber(environment, "wind", -2, 2, `${path}/environment`, errors);
      validateEnvironmentNumber(environment, "dropSpeed", 0.1, 5, `${path}/environment`, errors);
      validateEnvironmentNumber(environment, "dropLength", 0.1, 2, `${path}/environment`, errors);
      const depthLayers = readFiniteNumber(environment.depthLayers);
      if (depthLayers === null || !Number.isInteger(depthLayers) || depthLayers < 1 || depthLayers > MAX_RAIN_DEPTH_LAYERS) {
        errors.push({ path: `${path}/environment/depthLayers`, message: `must be an integer between 1 and ${MAX_RAIN_DEPTH_LAYERS}` });
      }
      validateEnvironmentColors(environment, ["color", "backgroundColor", "lightColor", "accentColor"], `${path}/environment`, errors);
      const ground = readRecord(environment.ground);
      if (!ground) {
        errors.push({ path: `${path}/environment/ground`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(ground, "horizon", 0.15, 0.9, `${path}/environment/ground`, errors);
        for (const field of ["wetness", "roughness", "rippleAmount", "splashAmount", "reflectionStrength"]) {
          validateEnvironmentNumber(ground, field, 0, 1, `${path}/environment/ground`, errors);
        }
      }
      const atmosphere = readRecord(environment.atmosphere);
      if (!atmosphere) {
        errors.push({ path: `${path}/environment/atmosphere`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(atmosphere, "mist", 0, 1, `${path}/environment/atmosphere`, errors);
        validateEnvironmentNumber(atmosphere, "lensDroplets", 0, 1, `${path}/environment/atmosphere`, errors);
      }
    }
    if (environment.kind === "water") {
      validateEnvironmentColors(environment, ["backgroundColor", "shallowColor", "deepColor", "reflectionColor", "foamColor"], `${path}/environment`, errors);
      const surface = readRecord(environment.surface);
      if (!surface) {
        errors.push({ path: `${path}/environment/surface`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(surface, "horizon", 0.1, 0.9, `${path}/environment/surface`, errors);
        validateEnvironmentNumber(surface, "waveScale", 0.1, 20, `${path}/environment/surface`, errors);
        validateEnvironmentNumber(surface, "waveHeight", 0, 1, `${path}/environment/surface`, errors);
        validateEnvironmentNumber(surface, "waveSpeed", 0.05, 5, `${path}/environment/surface`, errors);
        validateEnvironmentNumber(surface, "direction", -180, 180, `${path}/environment/surface`, errors);
        validateEnvironmentNumber(surface, "choppiness", 0, 1, `${path}/environment/surface`, errors);
        const waveOctaves = readFiniteNumber(surface.waveOctaves);
        if (waveOctaves === null || !Number.isInteger(waveOctaves) || waveOctaves < 1 || waveOctaves > MAX_WATER_WAVE_OCTAVES) {
          errors.push({ path: `${path}/environment/surface/waveOctaves`, message: `must be an integer between 1 and ${MAX_WATER_WAVE_OCTAVES}` });
        }
      }
      const optics = readRecord(environment.optics);
      if (!optics) {
        errors.push({ path: `${path}/environment/optics`, message: "must be an object" });
      } else {
        for (const field of ["reflectionStrength", "refractionStrength", "fresnel", "caustics", "clarity", "foam"]) {
          validateEnvironmentNumber(optics, field, 0, 1, `${path}/environment/optics`, errors);
        }
      }
    }
    if (environment.kind === "snow") {
      validateEnvironmentColors(environment, ["backgroundColor", "snowColor", "shadowColor", "lightColor"], `${path}/environment`, errors);
      const fall = readRecord(environment.fall);
      if (!fall) {
        errors.push({ path: `${path}/environment/fall`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(fall, "intensity", 0, 1, `${path}/environment/fall`, errors);
        validateEnvironmentNumber(fall, "speed", 0.05, 3, `${path}/environment/fall`, errors);
        validateEnvironmentNumber(fall, "wind", -2, 2, `${path}/environment/fall`, errors);
        validateEnvironmentNumber(fall, "turbulence", 0, 1, `${path}/environment/fall`, errors);
        validateEnvironmentNumber(fall, "flakeSize", 0.1, 3, `${path}/environment/fall`, errors);
        validateEnvironmentNumber(fall, "focusFalloff", 0, 1, `${path}/environment/fall`, errors);
        const depthLayers = readFiniteNumber(fall.depthLayers);
        if (depthLayers === null || !Number.isInteger(depthLayers) || depthLayers < 1 || depthLayers > MAX_SNOW_DEPTH_LAYERS) {
          errors.push({ path: `${path}/environment/fall/depthLayers`, message: `must be an integer between 1 and ${MAX_SNOW_DEPTH_LAYERS}` });
        }
      }
      const ground = readRecord(environment.ground);
      if (!ground) {
        errors.push({ path: `${path}/environment/ground`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(ground, "horizon", 0.1, 0.9, `${path}/environment/ground`, errors);
        for (const field of ["accumulation", "drift", "contactAmount"]) {
          validateEnvironmentNumber(ground, field, 0, 1, `${path}/environment/ground`, errors);
        }
      }
      const atmosphere = readRecord(environment.atmosphere);
      if (!atmosphere) {
        errors.push({ path: `${path}/environment/atmosphere`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(atmosphere, "haze", 0, 1, `${path}/environment/atmosphere`, errors);
        validateEnvironmentNumber(atmosphere, "depthFade", 0, 1, `${path}/environment/atmosphere`, errors);
      }
    }
    if (environment.kind === "fog") {
      validateEnvironmentColors(environment, ["backgroundColor", "fogColor", "lightColor"], `${path}/environment`, errors);
      const fog = readRecord(environment.fog);
      if (!fog) {
        errors.push({ path: `${path}/environment/fog`, message: "must be an object" });
      } else {
        validateEnvironmentNumber(fog, "density", 0, 1, `${path}/environment/fog`, errors);
        validateEnvironmentNumber(fog, "speed", 0.01, 3, `${path}/environment/fog`, errors);
        validateEnvironmentNumber(fog, "scale", 0.1, 12, `${path}/environment/fog`, errors);
        validateEnvironmentNumber(fog, "turbulence", 0, 1, `${path}/environment/fog`, errors);
        validateEnvironmentNumber(fog, "height", 0, 1, `${path}/environment/fog`, errors);
        validateEnvironmentNumber(fog, "lightStrength", 0, 1, `${path}/environment/fog`, errors);
        const depthLayers = readFiniteNumber(fog.depthLayers);
        if (depthLayers === null || !Number.isInteger(depthLayers) || depthLayers < 1 || depthLayers > MAX_FOG_DEPTH_LAYERS) {
          errors.push({ path: `${path}/environment/fog/depthLayers`, message: `must be an integer between 1 and ${MAX_FOG_DEPTH_LAYERS}` });
        }
      }
    }
    const unsupportedFields = ["text", "shape", "fill", "source", "src", "assetId", "assetRef", "label", "gradient", "emitter", "shader", "scene3d"] as const;
    for (const field of unsupportedFields) {
      if (field in layer) errors.push({ path: `${path}/${field}`, message: "is not supported on environment layers" });
    }
  }
}

function validateEnvironmentSceneSource(
  layers: unknown[],
  environmentIndex: number,
  environmentLayer: Record<string, unknown>,
  environment: Record<string, unknown>,
  documentWidth: number | null,
  documentHeight: number | null,
  errors: Array<{ path: string; message: string }>
): void {
  if (!("sceneSourceLayerId" in environment)) return;
  const path = `/layers/${environmentIndex}/environment/sceneSourceLayerId`;
  const sourceLayerId = readNonEmptyString(environment.sceneSourceLayerId);
  if (!sourceLayerId) {
    errors.push({ path, message: "must be a non-empty layer id" });
    return;
  }
  if (environment.mode !== "scene") {
    errors.push({ path, message: "requires environment.mode scene" });
  }
  const sourceIndex = layers.findIndex((candidate) => readRecord(candidate)?.id === sourceLayerId);
  if (sourceIndex < 0) {
    errors.push({ path, message: "must reference an existing layer" });
    return;
  }
  if (sourceIndex >= environmentIndex) {
    errors.push({ path, message: "must reference an earlier image layer" });
  }
  const sourceLayer = readRecord(layers[sourceIndex]);
  if (!sourceLayer) return;
  if (sourceLayer.type !== "image") {
    errors.push({ path, message: "must reference an image layer" });
  }
  if (sourceLayer.visible === false) {
    errors.push({ path, message: "must reference a visible image layer" });
  }
  const sourceStart = readFiniteNumber(sourceLayer.startMs);
  const sourceDuration = readFiniteNumber(sourceLayer.durationMs);
  const environmentStart = readFiniteNumber(environmentLayer.startMs);
  const environmentDuration = readFiniteNumber(environmentLayer.durationMs);
  if (sourceStart !== null && sourceDuration !== null && environmentStart !== null && environmentDuration !== null
    && (sourceStart > environmentStart || sourceStart + sourceDuration < environmentStart + environmentDuration)) {
    errors.push({ path, message: "source layer timing must cover the complete environment layer" });
  }
  const sourceStyle = readRecord(sourceLayer.style);
  const fit = readNonEmptyString(sourceLayer.fit)
    ?? readNonEmptyString(sourceStyle?.objectFit)
    ?? readNonEmptyString(sourceStyle?.fit);
  if (fit !== "fill") {
    errors.push({ path, message: "source image must use fit fill for exact texture mapping" });
  }
  if (["crop", "mask", "matte", "effects", "keyframes", "blendMode"].some((field) => {
    const value = sourceLayer[field];
    if (value === undefined || value === null) return false;
    const record = readRecord(value);
    return !record || Object.keys(record).length > 0;
  })) {
    errors.push({ path, message: "source image cannot use crop, mask, matte, effects, keyframes, or blend modes" });
  }
  if (readFiniteNumber(sourceLayer.opacity) !== null && readFiniteNumber(sourceLayer.opacity) !== 1) {
    errors.push({ path, message: "source image opacity must be 1" });
  }
  const sourceTransform = readRecord(sourceLayer.transform);
  if (readFiniteNumber(sourceTransform?.opacity) !== null && readFiniteNumber(sourceTransform?.opacity) !== 1) {
    errors.push({ path, message: "source image transform opacity must be 1" });
  }
  if (documentWidth !== null && documentHeight !== null) {
    if (!isFullFrameEnvironmentLayer(sourceLayer, documentWidth, documentHeight)) {
      errors.push({ path, message: "source image must use an identity full-document transform" });
    }
    if (!isFullFrameEnvironmentLayer(environmentLayer, documentWidth, documentHeight)) {
      errors.push({ path, message: "environment layer must use an identity full-document transform" });
    }
  }
}

function isFullFrameEnvironmentLayer(
  layer: Record<string, unknown>,
  documentWidth: number,
  documentHeight: number
): boolean {
  const transform = readRecord(layer.transform);
  if (!transform) return false;
  const width = readFiniteNumber(transform.width) ?? readFiniteNumber(layer.width);
  const height = readFiniteNumber(transform.height) ?? readFiniteNumber(layer.height);
  return (readFiniteNumber(transform.x) ?? 0) === 0
    && (readFiniteNumber(transform.y) ?? 0) === 0
    && width === documentWidth
    && height === documentHeight
    && (readFiniteNumber(transform.scale) ?? 1) === 1
    && (readFiniteNumber(transform.rotation) ?? 0) === 0;
}

function validateEnvironmentEffectMask(
  layers: unknown[],
  environmentIndex: number,
  environmentLayer: Record<string, unknown>,
  environment: Record<string, unknown>,
  documentWidth: number | null,
  documentHeight: number | null,
  errors: Array<{ path: string; message: string }>
): void {
  if (!("effectMaskLayerId" in environment)) return;
  const path = `/layers/${environmentIndex}/environment/effectMaskLayerId`;
  const maskLayerId = readNonEmptyString(environment.effectMaskLayerId);
  if (!maskLayerId) {
    errors.push({ path, message: "must be a non-empty layer id" });
    return;
  }
  const maskIndex = layers.findIndex((candidate) => readRecord(candidate)?.id === maskLayerId);
  if (maskIndex < 0) {
    errors.push({ path, message: "must reference an existing layer" });
    return;
  }
  if (maskIndex >= environmentIndex) {
    errors.push({ path, message: "must reference an earlier image layer" });
  }
  const maskLayer = readRecord(layers[maskIndex]);
  if (!maskLayer) return;
  if (maskLayer.type !== "image") {
    errors.push({ path, message: "must reference an image layer" });
  }
  if (maskLayer.visible === false) {
    errors.push({ path, message: "mask image must remain enabled for deterministic sampling" });
  }
  const maskStart = readFiniteNumber(maskLayer.startMs);
  const maskDuration = readFiniteNumber(maskLayer.durationMs);
  const environmentStart = readFiniteNumber(environmentLayer.startMs);
  const environmentDuration = readFiniteNumber(environmentLayer.durationMs);
  if (maskStart !== null && maskDuration !== null && environmentStart !== null && environmentDuration !== null
    && (maskStart > environmentStart || maskStart + maskDuration < environmentStart + environmentDuration)) {
    errors.push({ path, message: "mask layer timing must cover the complete environment layer" });
  }
  const maskStyle = readRecord(maskLayer.style);
  const fit = readNonEmptyString(maskLayer.fit)
    ?? readNonEmptyString(maskStyle?.objectFit)
    ?? readNonEmptyString(maskStyle?.fit);
  if (fit !== "fill") {
    errors.push({ path, message: "mask image must use fit fill for exact texture mapping" });
  }
  if (["crop", "mask", "matte", "effects", "keyframes", "blendMode"].some((field) => {
    const value = maskLayer[field];
    if (value === undefined || value === null) return false;
    const record = readRecord(value);
    return !record || Object.keys(record).length > 0;
  })) {
    errors.push({ path, message: "mask image cannot use crop, mask, matte, effects, keyframes, or blend modes" });
  }
  const maskTransform = readRecord(maskLayer.transform);
  const effectiveOpacity = readFiniteNumber(maskTransform?.opacity) ?? readFiniteNumber(maskLayer.opacity) ?? 1;
  if (effectiveOpacity !== 0) {
    errors.push({ path, message: "mask image must use effective opacity 0 so it is sampled but not composited" });
  }
  if (documentWidth !== null && documentHeight !== null) {
    if (!isFullFrameEnvironmentLayer(maskLayer, documentWidth, documentHeight)) {
      errors.push({ path, message: "mask image must use an identity full-document transform" });
    }
    if (!isFullFrameEnvironmentLayer(environmentLayer, documentWidth, documentHeight)) {
      errors.push({ path, message: "environment layer must use an identity full-document transform" });
    }
  }
}

function validateEnvironmentColors(
  record: Record<string, unknown>,
  fields: string[],
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  for (const field of fields) {
    if (typeof record[field] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(record[field])) errors.push({ path: `${path}/${field}`, message: "must be a #RRGGBB color" });
  }
}

function validateEnvironmentNumber(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const value = readFiniteNumber(record[field]);
  if (value === null || value < min || value > max) {
    errors.push({ path: `${path}/${field}`, message: `must be a finite number between ${min} and ${max}` });
  }
}

function validateLayerEffects(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("effects" in record)) return;
  const effects = readRecord(record.effects);
  if (!effects) {
    errors.push({ path: `${path}/effects`, message: "must be an object" });
    return;
  }

  for (const effect of SUPPORTED_EFFECTS) {
    if (effect in effects && !isNonNegativeFiniteNumber(effects[effect])) {
      errors.push({ path: `${path}/effects/${effect}`, message: "must be a non-negative finite number" });
    }
  }
  if ("glow" in effects) {
    const glow = readRecord(effects.glow);
    if (!glow) {
      errors.push({ path: `${path}/effects/glow`, message: "must be an object" });
    } else {
      if (!isNonNegativeFiniteNumber(glow.radius) || (typeof glow.radius === "number" && glow.radius > 128)) {
        errors.push({ path: `${path}/effects/glow/radius`, message: "must be a finite number between 0 and 128" });
      }
      if (!isSupportedColorString(glow.color)) {
        errors.push({ path: `${path}/effects/glow/color`, message: "must be a supported color string" });
      }
    }
  }
  if ("motionBlur" in effects) {
    const motionBlur = readRecord(effects.motionBlur);
    if (!motionBlur) {
      errors.push({ path: `${path}/effects/motionBlur`, message: "must be an object" });
    } else {
      if (!Number.isInteger(motionBlur.samples) || !isPositiveFiniteNumber(motionBlur.samples) || Number(motionBlur.samples) < 2 || Number(motionBlur.samples) > MAX_MOTION_BLUR_SAMPLES) {
        errors.push({ path: `${path}/effects/motionBlur/samples`, message: `must be an integer between 2 and ${MAX_MOTION_BLUR_SAMPLES}` });
      } else if (record.type === "video" && Number(motionBlur.samples) > MAX_MOTION_BLUR_VIDEO_SAMPLES) {
        errors.push({ path: `${path}/effects/motionBlur/samples`, message: `video layers support at most ${MAX_MOTION_BLUR_VIDEO_SAMPLES} samples` });
      }
      const shutterAngle = readFiniteNumber(motionBlur.shutterAngle);
      if (shutterAngle === null || shutterAngle <= 0 || shutterAngle > 360) {
        errors.push({ path: `${path}/effects/motionBlur/shutterAngle`, message: "must be a finite number greater than 0 and at most 360" });
      }
      if (!GENERATED_VISUAL_LAYER_TYPE_SET.has(String(record.type))) {
        errors.push({ path: `${path}/effects/motionBlur`, message: "is supported only on generated visual layers" });
      }
    }
  }
  if ("vignette" in effects) {
    const vignette = readRecord(effects.vignette);
    if (!vignette) {
      errors.push({ path: `${path}/effects/vignette`, message: "must be an object" });
    } else {
      if (!isUnitIntervalNumber(vignette.amount)) {
        errors.push({ path: `${path}/effects/vignette/amount`, message: "must be a finite number between 0 and 1" });
      }
      if (!isUnitIntervalNumber(vignette.softness)) {
        errors.push({ path: `${path}/effects/vignette/softness`, message: "must be a finite number between 0 and 1" });
      }
      if (!isSupportedColorString(vignette.color)) {
        errors.push({ path: `${path}/effects/vignette/color`, message: "must be a supported color string" });
      }
      if (record.type !== "adjustment") {
        errors.push({ path: `${path}/effects/vignette`, message: "is supported only on adjustment layers" });
      }
    }
  }
  if ("filmGrain" in effects) {
    const filmGrain = readRecord(effects.filmGrain);
    if (!filmGrain) {
      errors.push({ path: `${path}/effects/filmGrain`, message: "must be an object" });
    } else {
      if (!isUnitIntervalNumber(filmGrain.amount)) {
        errors.push({ path: `${path}/effects/filmGrain/amount`, message: "must be a finite number between 0 and 1" });
      }
      if (!Number.isInteger(filmGrain.size) || !isPositiveFiniteNumber(filmGrain.size) || Number(filmGrain.size) > 8) {
        errors.push({ path: `${path}/effects/filmGrain/size`, message: "must be an integer between 1 and 8" });
      }
      if (!Number.isInteger(filmGrain.seed) || !isNonNegativeFiniteNumber(filmGrain.seed) || Number(filmGrain.seed) > 0xffff_ffff) {
        errors.push({ path: `${path}/effects/filmGrain/seed`, message: "must be an unsigned 32-bit integer" });
      }
      if (record.type !== "adjustment") {
        errors.push({ path: `${path}/effects/filmGrain`, message: "is supported only on adjustment layers" });
      }
    }
  }
}

function validateAdjustmentLayers(
  layers: unknown[],
  errors: Array<{ path: string; message: string }>
): void {
  const adjustments = layers
    .map((value, index) => ({ layer: readRecord(value), index }))
    .filter((entry) => entry.layer?.type === "adjustment");
  const owned = new Set(layers.map(readRecord).filter((layer) => layer?.type === "group").flatMap((layer) => Array.isArray(layer?.childLayerIds) ? layer.childLayerIds : []).filter((id): id is string => typeof id === "string"));
  const firstAdjustmentIndex = layers.findIndex((value) => { const layer = readRecord(value); return layer?.type === "adjustment" && !owned.has(String(layer.id)); });
  if (firstAdjustmentIndex >= 0) {
    layers.slice(firstAdjustmentIndex + 1).forEach((value, offset) => {
      const layer = readRecord(value); if (!owned.has(String(layer?.id)) && layer?.type !== "adjustment") {
        errors.push({
          path: `/layers/${firstAdjustmentIndex + 1 + offset}/type`,
          message: "non-adjustment layers must precede adjustment layers"
        });
      }
    });
  }
  if (adjustments.length > MAX_ADJUSTMENT_LAYERS) {
    adjustments.slice(MAX_ADJUSTMENT_LAYERS).forEach(({ index }) => {
      errors.push({ path: `/layers/${index}/type`, message: `at most ${MAX_ADJUSTMENT_LAYERS} adjustment layers are supported` });
    });
  }
  for (const { layer, index } of adjustments) {
    if (!layer) continue;
    const path = `/layers/${index}`;
    const unsupportedFields = [
      "text", "shape", "fill", "source", "src", "assetId", "assetRef", "style", "label",
      "mask", "matte", "gradient", "emitter", "blendMode", "transitions", "transform", "keyframes"
    ] as const;
    for (const field of unsupportedFields) {
      if (field in layer) errors.push({ path: `${path}/${field}`, message: "is not supported on adjustment layers" });
    }
    if ("effectModule" in layer) continue;
    const effects = readRecord(layer.effects);
    if (!effects || (!("vignette" in effects) && !("filmGrain" in effects))) {
      errors.push({ path: `${path}/effects`, message: "adjustment layers require vignette or filmGrain" });
      continue;
    }
    const unsupportedEffects = Object.keys(effects).filter((name) => name !== "vignette" && name !== "filmGrain");
    for (const name of unsupportedEffects) {
      errors.push({ path: `${path}/effects/${name}`, message: "is not supported on adjustment layers" });
    }
  }
}

function validateMotionBlurBudget(
  layers: unknown[],
  errors: Array<{ path: string; message: string }>
): void {
  const events: Array<{ atMs: number; delta: number }> = [];
  const videoEvents: Array<{ atMs: number; delta: number }> = [];
  for (const layer of layers) {
    const record = readRecord(layer);
    const effects = readRecord(record?.effects);
    const motionBlur = readRecord(effects?.motionBlur);
    const samples = readFiniteNumber(motionBlur?.samples);
    if (samples !== null && Number.isInteger(samples) && samples >= 2 && samples <= MAX_MOTION_BLUR_SAMPLES) {
      const startMs = readFiniteNumber(record?.startMs);
      const durationMs = readFiniteNumber(record?.durationMs);
      if (startMs !== null && durationMs !== null && durationMs > 0) {
        events.push({ atMs: startMs, delta: samples }, { atMs: startMs + durationMs, delta: -samples });
        if (record?.type === "video" && samples <= MAX_MOTION_BLUR_VIDEO_SAMPLES) {
          videoEvents.push({ atMs: startMs, delta: samples }, { atMs: startMs + durationMs, delta: -samples });
        }
      }
    }
  }
  const maxConcurrentSamples = maxConcurrentMotionBlurSamples(events);
  if (maxConcurrentSamples > MAX_MOTION_BLUR_SAMPLE_BUDGET) {
    errors.push({
      path: "/layers",
      message: `concurrent motion blur sample budget ${maxConcurrentSamples} exceeds ${MAX_MOTION_BLUR_SAMPLE_BUDGET}`
    });
  }
  const maxConcurrentVideoSamples = maxConcurrentMotionBlurSamples(videoEvents);
  if (maxConcurrentVideoSamples > MAX_MOTION_BLUR_VIDEO_SAMPLE_BUDGET) {
    errors.push({
      path: "/layers",
      message: `concurrent video motion blur sample budget ${maxConcurrentVideoSamples} exceeds ${MAX_MOTION_BLUR_VIDEO_SAMPLE_BUDGET}`
    });
  }
}

function maxConcurrentMotionBlurSamples(events: Array<{ atMs: number; delta: number }>): number {
  events.sort((left, right) => left.atMs - right.atMs || left.delta - right.delta);
  let concurrentSamples = 0;
  let maximum = 0;
  for (const event of events) {
    concurrentSamples += event.delta;
    maximum = Math.max(maximum, concurrentSamples);
  }
  return maximum;
}

function validateLayerGradient(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("gradient" in record)) return;
  const gradient = readRecord(record.gradient);
  if (!gradient) {
    errors.push({ path: `${path}/gradient`, message: "must be an object" });
    return;
  }
  if (record.type !== "shape" || (record.shape !== undefined && !BROWSER_GRADIENT_SHAPES.has(record.shape as string))) {
    errors.push({ path: `${path}/gradient`, message: "is supported only on closed Browser shape primitives: rect, rounded-rect, ellipse, triangle, or star" });
  }
  if (gradient.type !== "linear" && gradient.type !== "radial") {
    errors.push({ path: `${path}/gradient/type`, message: "must be linear or radial" });
  }
  if ("angle" in gradient && !isFiniteNumber(gradient.angle)) {
    errors.push({ path: `${path}/gradient/angle`, message: "must be a finite number" });
  } else if (gradient.type === "radial" && "angle" in gradient) {
    errors.push({ path: `${path}/gradient/angle`, message: "is supported only for linear gradients" });
  }
  for (const field of ["centerX", "centerY"] as const) {
    const value = gradient[field];
    if (field in gradient && (!isFiniteNumber(value) || (typeof value === "number" && (value < 0 || value > 1)))) {
      errors.push({ path: `${path}/gradient/${field}`, message: "must be a finite number between 0 and 1" });
    } else if (gradient.type === "linear" && field in gradient) {
      errors.push({ path: `${path}/gradient/${field}`, message: "is supported only for radial gradients" });
    }
  }
  if (!Array.isArray(gradient.stops) || gradient.stops.length < 2 || gradient.stops.length > 16) {
    errors.push({ path: `${path}/gradient/stops`, message: "must contain between 2 and 16 stops" });
    return;
  }
  let priorOffset = -Infinity;
  gradient.stops.forEach((value, index) => {
    const stop = readRecord(value);
    const stopPath = `${path}/gradient/stops/${index}`;
    if (!stop) {
      errors.push({ path: stopPath, message: "must be an object" });
      return;
    }
    const offset = stop.offset;
    if (!isFiniteNumber(offset) || (typeof offset === "number" && (offset < 0 || offset > 1))) {
      errors.push({ path: `${stopPath}/offset`, message: "must be a finite number between 0 and 1" });
    } else if (typeof offset === "number" && offset < priorOffset) {
      errors.push({ path: `${stopPath}/offset`, message: "must be ordered by offset" });
    } else if (typeof offset === "number") {
      priorOffset = offset;
    }
    if (!isSupportedColorString(stop.color)) {
      errors.push({ path: `${stopPath}/color`, message: "must be a supported color string" });
    }
  });
  if ("colorKeyframes" in gradient) {
    const problem = validateMotionGradientColorKeyframes(gradient);
    if (problem) errors.push({ path: `${path}/gradient/colorKeyframes`, message: problem });
  }
}

/** Shared synchronous particle-emitter semantic authority for bounded authoring mutations. */
export function validateParticleEmitter(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record) return;
  if (record.type !== "particles") {
    if ("emitter" in record) errors.push({ path: `${path}/emitter`, message: "is supported only on particle layers" });
    return;
  }
  const emitter = readRecord(record.emitter);
  if (!emitter) {
    errors.push({ path: `${path}/emitter`, message: "must be an object on particle layers" });
    return;
  }
  if (!isNonNegativeInteger(emitter.seed) || (typeof emitter.seed === "number" && emitter.seed > 0xffff_ffff)) {
    errors.push({ path: `${path}/emitter/seed`, message: "must be an integer between 0 and 4294967295" });
  }
  validateParticleComputeDensity(emitter, path, errors);
  if (!isPositiveFiniteNumber(emitter.lifetimeMs) || (typeof emitter.lifetimeMs === "number" && emitter.lifetimeMs > MAX_PARTICLE_LIFETIME_MS)) {
    errors.push({ path: `${path}/emitter/lifetimeMs`, message: `must be a finite number between 0 and ${MAX_PARTICLE_LIFETIME_MS}` });
  }
  if ("shape" in emitter && emitter.shape !== "circle" && emitter.shape !== "square") {
    errors.push({ path: `${path}/emitter/shape`, message: "must be circle or square" });
  }
  for (const field of ["color", "secondaryColor"] as const) {
    if ((field === "color" || field in emitter) && !isSupportedColorString(emitter[field])) {
      errors.push({ path: `${path}/emitter/${field}`, message: "must be a supported color string" });
    }
  }
  for (const field of ["minSize", "maxSize"] as const) {
    const value = emitter[field];
    if (field in emitter && (!isPositiveFiniteNumber(value) || (typeof value === "number" && value > 256))) {
      errors.push({ path: `${path}/emitter/${field}`, message: "must be a finite number between 0 and 256" });
    }
  }
  const minSize = typeof emitter.minSize === "number" ? emitter.minSize : 2;
  const maxSize = typeof emitter.maxSize === "number" ? emitter.maxSize : 8;
  if (minSize > maxSize) errors.push({ path: `${path}/emitter/maxSize`, message: "must be greater than or equal to minSize" });
  for (const field of ["minSpeed", "maxSpeed"] as const) {
    const value = emitter[field];
    if (field in emitter && (!isNonNegativeFiniteNumber(value) || (typeof value === "number" && value > 2000))) {
      errors.push({ path: `${path}/emitter/${field}`, message: "must be a finite number between 0 and 2000" });
    }
  }
  const minSpeed = typeof emitter.minSpeed === "number" ? emitter.minSpeed : 20;
  const maxSpeed = typeof emitter.maxSpeed === "number" ? emitter.maxSpeed : 80;
  if (minSpeed > maxSpeed) errors.push({ path: `${path}/emitter/maxSpeed`, message: "must be greater than or equal to minSpeed" });
  if ("direction" in emitter && !isFiniteNumber(emitter.direction)) {
    errors.push({ path: `${path}/emitter/direction`, message: "must be a finite number" });
  }
  if ("spread" in emitter && (!isNonNegativeFiniteNumber(emitter.spread) || (typeof emitter.spread === "number" && emitter.spread > 360))) {
    errors.push({ path: `${path}/emitter/spread`, message: "must be a finite number between 0 and 360" });
  }
  if ("gravity" in emitter && (!isFiniteNumber(emitter.gravity) || (typeof emitter.gravity === "number" && Math.abs(emitter.gravity) > 5000))) {
    errors.push({ path: `${path}/emitter/gravity`, message: "must be a finite number between -5000 and 5000" });
  }
  if ("fadeOut" in emitter && typeof emitter.fadeOut !== "boolean") {
    errors.push({ path: `${path}/emitter/fadeOut`, message: "must be a boolean" });
  }
  if ("field" in emitter) validateParticleField(emitter.field, `${path}/emitter/field`, errors);
  validateParticleEmitterV2Extensions(emitter, `${path}/emitter`, errors);
}


function validateLayerBlendMode(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("blendMode" in record)) return;
  if (typeof record.blendMode !== "string" || !SUPPORTED_BLEND_MODES.has(record.blendMode)) {
    errors.push({ path: `${path}/blendMode`, message: "unsupported blend mode" });
  }
}

function validateLayerTransitions(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("transitions" in record)) return;
  const transitions = readRecord(record.transitions);
  if (!transitions) {
    errors.push({ path: `${path}/transitions`, message: "must be an object" });
    return;
  }

  for (const edge of ["in", "out"] as const) {
    if (!(edge in transitions)) continue;
    validateTransition(transitions[edge], `${path}/transitions/${edge}`, errors);
  }
}

function validateTransition(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (typeof record.type !== "string" || !SUPPORTED_TRANSITIONS.has(record.type)) {
    errors.push({ path: `${path}/type`, message: "unsupported transition type" });
  }
  if (!isPositiveFiniteNumber(record.durationMs)) {
    errors.push({ path: `${path}/durationMs`, message: "must be a positive finite number" });
  }
  if ("easing" in record) {
    const easingError = readEasingValidationError(record.easing);
    if (easingError) errors.push({ path: `${path}/easing`, message: easingError });
  }
  if (record.type === "slide") {
    if ("direction" in record && (typeof record.direction !== "string" || !SUPPORTED_SLIDE_DIRECTIONS.has(record.direction))) {
      errors.push({ path: `${path}/direction`, message: "unsupported slide direction" });
    }
    if ("distance" in record && !isNonNegativeFiniteNumber(record.distance)) {
      errors.push({ path: `${path}/distance`, message: "must be a non-negative finite number" });
    }
  }
  if (record.type === "wipe" && "direction" in record && (typeof record.direction !== "string" || !SUPPORTED_WIPE_DIRECTIONS.has(record.direction))) {
    errors.push({ path: `${path}/direction`, message: "unsupported wipe direction" });
  }
}
function validateLayerKeyframes(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("keyframes" in record)) return;
  const keyframes = readRecord(record.keyframes);
  if (!keyframes) {
    errors.push({ path: `${path}/keyframes`, message: "must be an object" });
    return;
  }

  validateSpatialKeyframes(layer, path, errors);
  for (const [target, entries] of Object.entries(keyframes)) {
    const targetPath = `${path}/keyframes/${target}`;
    const shaderUniformName = target.startsWith("shader.uniforms.") ? target.slice("shader.uniforms.".length) : null;
    const declaredShaderUniforms = readRecord(readRecord(record.shader)?.uniforms);
    const shaderUniformTarget = record.type === "shader"
      && shaderUniformName !== null
      && isSafeShaderUniformName(shaderUniformName)
      && declaredShaderUniforms !== null
      && shaderUniformName in declaredShaderUniforms;
    if (!SUPPORTED_KEYFRAME_TARGETS.has(target) && !shaderUniformTarget) {
      errors.push({ path: targetPath, message: "unsupported keyframe target" });
      continue;
    }
    if (isPathRevealKeyframeTarget(target)) {
      try {
        assertMotionPathRevealLayer(record as never, `Motion layer ${String(record.id ?? path)}`);
      } catch (error) {
        errors.push({ path: targetPath, message: validationErrorMessage(error) });
        continue;
      }
    }
    const environmentRange = ENVIRONMENT_KEYFRAME_RANGES[target];
    const declaredEnvironment = readRecord(record.environment);
    if (environmentRange && (record.type !== "environment" || !declaredEnvironment)) {
      errors.push({ path: targetPath, message: "requires an environment layer" });
      continue;
    }
    if (environmentRange && declaredEnvironment) {
      const targetKinds = target.startsWith("environment.fog.")
        ? ["fog"]
        : target.startsWith("environment.surface.") || target.startsWith("environment.optics.")
        ? ["water"]
        : target.startsWith("environment.fall.")
          || target === "environment.ground.accumulation"
          || target === "environment.ground.drift"
          || target === "environment.ground.contactAmount"
          || target.startsWith("environment.atmosphere.haze")
          || target.startsWith("environment.atmosphere.depthFade")
          ? ["snow"]
          : target === "environment.ground.horizon"
            ? ["rain", "snow"]
            : ["rain"];
      if (!targetKinds.includes(String(declaredEnvironment.kind))) {
        errors.push({ path: targetPath, message: `requires a ${targetKinds.join(" or ")} environment` });
        continue;
      }
    }
    if (isCropKeyframeTarget(target)) {
      if (!supportsSourceCrop(record.type)) {
        errors.push({ path: targetPath, message: "supported only on image or video layers" });
        continue;
      }
      if (!readRecord(record.crop)) {
        errors.push({ path: targetPath, message: `requires ${path}/crop` });
        continue;
      }
    }
    if (target === "gradient.angle") {
      const gradient = readRecord(record.gradient);
      if (!gradient || gradient.type !== "linear") {
        errors.push({ path: targetPath, message: "requires a linear layer gradient" });
        continue;
      }
    }
    if (target === "effects.glow.radius" || target === "effects.glow.color") {
      const glow = readRecord(readRecord(record.effects)?.glow);
      if (!glow) {
        errors.push({ path: targetPath, message: "requires a layer glow effect" });
        continue;
      }
    }
    if (!Array.isArray(entries)) {
      errors.push({ path: targetPath, message: "must be an array" });
      continue;
    }
    entries.forEach((entry, entryIndex) => {
      validateKeyframe(entry, `${targetPath}/${entryIndex}`, errors, {
        nonNegativeValue: NON_NEGATIVE_KEYFRAME_TARGETS.has(target),
        unitIntervalValue: isPathRevealKeyframeTarget(target),
        panValue: PAN_KEYFRAME_TARGETS.has(target),
        blendModeValue: BLEND_MODE_KEYFRAME_TARGETS.has(target),
        positiveValue: POSITIVE_KEYFRAME_TARGETS.has(target),
        colorValue: COLOR_KEYFRAME_TARGETS.has(target),
        allowedStringValues: alignmentKeyframeValues(target)
      });
      if (shaderUniformTarget) {
        const value = readFiniteNumber(readRecord(entry)?.value);
        if (value !== null && Math.abs(value) > 1_000_000) {
          errors.push({ path: `${targetPath}/${entryIndex}/value`, message: "must be between -1000000 and 1000000" });
        }
      }
      if (environmentRange) {
        const value = readFiniteNumber(readRecord(entry)?.value);
        if (value !== null && (value < environmentRange[0] || value > environmentRange[1])) {
          errors.push({
            path: `${targetPath}/${entryIndex}/value`,
            message: `must be between ${environmentRange[0]} and ${environmentRange[1]}`
          });
        }
      }
    });
  }
}

function isCropKeyframeTarget(target: string): boolean {
  return target === "crop.x" || target === "crop.y" || target === "crop.width" || target === "crop.height";
}

function supportsSourceCrop(layerType: unknown): boolean {
  return layerType === "image" || layerType === "video";
}

function validateKeyframe(
  entry: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
  options: { nonNegativeValue?: boolean; unitIntervalValue?: boolean; panValue?: boolean; blendModeValue?: boolean; positiveValue?: boolean; colorValue?: boolean; allowedStringValues?: readonly string[] } = {}
): void {
  const record = readRecord(entry);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (!isFiniteNumber(record.atMs)) {
    // When the entry carries a recognisable wrong name, say which one. "must be a finite number" is
    // true but unactionable for a keyframe written as `{ t, v }`: the field it names is not there at
    // all, so the author reads it as a value problem and looks in the wrong place. The alias list is
    // core's, shared with the refusal, so both surfaces name the same mistake.
    const alias = motionKeyframeTimeAlias(entry);
    errors.push({ path: `${path}/atMs`, message: alias ? `must be a finite number; this keyframe writes its time as "${alias}"` : "must be a finite number" });
  }
  if (options.colorValue) {
    if (!isSupportedColorString(record.value)) {
      errors.push({ path: `${path}/value`, message: "must be a supported color string" });
    }
  } else if (options.allowedStringValues) {
    if (typeof record.value !== "string" || !options.allowedStringValues.includes(record.value.trim().toLowerCase())) {
      errors.push({ path: `${path}/value`, message: `must be one of: ${options.allowedStringValues.join(", ")}` });
    }
  } else if (options.panValue) {
    if (!isPanNumber(record.value)) {
      errors.push({ path: `${path}/value`, message: "must be a finite number between -1 and 1" });
    }
  } else if (options.blendModeValue) {
    if (typeof record.value !== "string" || !SUPPORTED_BLEND_MODES.has(record.value)) {
      errors.push({ path: `${path}/value`, message: "unsupported blend mode" });
    }
  } else if (options.positiveValue) {
    if (!isPositiveFiniteNumber(record.value)) {
      errors.push({ path: `${path}/value`, message: "must be a positive finite number" });
    }
  } else if (options.nonNegativeValue) {
    if (!isNonNegativeFiniteNumber(record.value)) {
      errors.push({ path: `${path}/value`, message: "must be a non-negative finite number" });
    }
  } else if (options.unitIntervalValue) {
    const value = readFiniteNumber(record.value);
    if (value === null || value < 0 || value > 1) {
      errors.push({ path: `${path}/value`, message: "must be a finite number between 0 and 1" });
    }
  } else if (!isFiniteNumber(record.value)) {
    const alias = motionKeyframeValueAlias(entry);
    errors.push({ path: `${path}/value`, message: alias ? `must be a finite number; this keyframe writes its value as "${alias}"` : "must be a finite number" });
  }
  if ("easing" in record) {
    const easingError = readEasingValidationError(record.easing);
    if (easingError) errors.push({ path: `${path}/easing`, message: easingError });
  }
}

function validateLayerPathReveal(
  layer: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const record = readRecord(layer);
  if (!record || !("pathReveal" in record)) return;
  try {
    assertMotionPathRevealLayer(record as never, `Motion layer ${String(record.id ?? path)}`);
  } catch (error) {
    errors.push({ path: `${path}/pathReveal`, message: validationErrorMessage(error) });
  }
}

function alignmentKeyframeValues(target: string): readonly string[] | undefined {
  if (target === "style.textAlign") return TEXT_ALIGN_KEYFRAME_VALUES;
  if (target === "style.verticalAlign" || target === "style.alignY") return VERTICAL_ALIGN_KEYFRAME_VALUES;
  return undefined;
}

function isSupportedColorString(value: unknown): boolean {
  return isSupportedMotionColorString(value);
}

function validationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid path geometry";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function validateSafeObjectKeys(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateSafeObjectKeys(entry, `${path}/${index}`, errors));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = `${path}/${key}`;
    if (isUnsafeObjectKey(key)) {
      errors.push({ path: keyPath, message: "unsafe object key" });
      continue;
    }
    validateSafeObjectKeys(entry, keyPath, errors);
  }
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function collectStringIds(values: unknown[]): Set<string> {
  const ids = new Set<string>();
  values.forEach((value) => {
    const record = readRecord(value);
    const id = readNonEmptyString(record?.id);
    if (id) ids.add(id);
  });
  return ids;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isFiniteNumber(value: unknown): boolean {
  return readFiniteNumber(value) !== null;
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return readNonNegativeFiniteNumber(value) !== null;
}

function isPanNumber(value: unknown): boolean {
  const number = readFiniteNumber(value);
  return number !== null && number >= -1 && number <= 1;
}

function isUnitIntervalNumber(value: unknown): boolean {
  const number = readFiniteNumber(value);
  return number !== null && number >= 0 && number <= 1;
}

function isPositiveFiniteNumber(value: unknown): boolean {
  return readPositiveFiniteNumber(value) !== null;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && isPositiveFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && isNonNegativeFiniteNumber(value);
}

function isSha256HexString(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeFiniteNumber(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function readPositiveFiniteNumber(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}
