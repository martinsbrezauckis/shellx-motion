import type { CapabilityMatch, MotionDocument } from "./types";

/**
 * Closed package colour authority introduced by F0. It is intentionally separate from the
 * observational `color-alpha@1` vocabulary: declaring a future working space must never make a
 * current encoded renderer look linear-light by implication.
 */
export const COLOR_PIPELINE_SCHEMA = "shellx-motion/color-pipeline@1" as const;
export const COLOR_PIPELINE_RENDER_PLAN_SCHEMA = "shellx-motion/color-pipeline-render-plan@1" as const;
export const COLOR_PIPELINE_CAPABILITY_SCHEMA = "shellx-motion/color-pipeline-capability@1" as const;
export const COLOR_PIPELINE_RECEIPT_EVIDENCE_SCHEMA = "shellx-motion/color-pipeline-receipt-evidence@1" as const;

export const COLOR_PIPELINE_INTENTS = Object.freeze(["legacy-encoded-sdr@0.2.65", "linear-srgb-sdr@1"] as const);
export type ColorPipelineIntentId = typeof COLOR_PIPELINE_INTENTS[number];

/** The only authored package field. All operational detail is selected from the closed table below. */
export interface MotionColorPipelineDeclaration {
  schema: typeof COLOR_PIPELINE_SCHEMA;
  intent: ColorPipelineIntentId;
}

export interface ColorPipelineContract {
  schema: typeof COLOR_PIPELINE_SCHEMA;
  intent: ColorPipelineIntentId;
  package: {
    input: "unprofiled-srgb-assumed" | "legacy-unprofiled-srgb-assumed";
    profileBearingImageVideo: "refused" | "legacy-unsupported-undefined";
    working: "premultiplied-linear-srgb" | "legacy-encoded-renderer-defined";
  };
  render: {
    delivery: "sdr-bt709-limited" | "legacy-renderer-defined";
    frameAlphaBoundary: "straight-srgb-rgba" | "legacy-lane-defined";
    outputAlpha: "not-applicable" | "legacy-renderer-defined";
    laneRequirement: "gpu-to-ffmpeg" | "legacy-renderer-selected";
    outputRequirement: "mp4-h264" | "legacy-renderer-selected";
    fallbackPolicy: "refuse" | "legacy-compatible";
  };
}

export interface ColorPipelineRenderPlan {
  schema: typeof COLOR_PIPELINE_RENDER_PLAN_SCHEMA;
  contract: ColorPipelineContract;
  admission: "legacy-compatible" | "strict-route-available";
  /** Exact narrow route required before a strict renderer can be admitted. */
  strictRequirements?: {
    frameLane: "gpu";
    finalLane: "ffmpeg";
    output: "mp4-h264";
    target: "final";
    features: readonly ["background.fill", "shape.rect", "shape.rect.gradient.linear-radial.static.linear-light", "blend.normal.source-over"];
  };
}

/** Colour-pipeline state displayed on every renderer card. It is an admission record, not a pixel claim. */
export interface RendererColorPipelineCapability {
  schema: typeof COLOR_PIPELINE_CAPABILITY_SCHEMA;
  lane: string;
  admittedPackageIntents: readonly ColorPipelineIntentId[];
  strictLinearSrgbSdr: {
    intent: "linear-srgb-sdr@1";
    status: "unsupported" | "conditional-route";
    reason: string;
    route?: typeof STRICT_REQUIREMENTS;
  };
}

export interface ColorPipelineReceiptEvidence {
  schema: typeof COLOR_PIPELINE_RECEIPT_EVIDENCE_SCHEMA;
  requested: ColorPipelineContract;
  actual: {
    status: "not-executed";
    laneImplementation: "not-observed";
    frameAlphaBoundary: "not-observed";
    deliveryTags: "not-observed";
    decodedPixels: "not-observed";
    runtimeAndToolIdentities: "not-observed";
    artifactHashes: "package-input-hashes-bound";
  };
}

export const LEGACY_ENCODED_SDR_COLOR_PIPELINE: ColorPipelineContract = Object.freeze({
  schema: COLOR_PIPELINE_SCHEMA,
  intent: "legacy-encoded-sdr@0.2.65",
  package: Object.freeze({
    input: "legacy-unprofiled-srgb-assumed",
    profileBearingImageVideo: "legacy-unsupported-undefined",
    working: "legacy-encoded-renderer-defined"
  }),
  render: Object.freeze({
    delivery: "legacy-renderer-defined",
    frameAlphaBoundary: "legacy-lane-defined",
    outputAlpha: "legacy-renderer-defined",
    laneRequirement: "legacy-renderer-selected",
    outputRequirement: "legacy-renderer-selected",
    fallbackPolicy: "legacy-compatible"
  })
});

export const LINEAR_SRGB_SDR_COLOR_PIPELINE: ColorPipelineContract = Object.freeze({
  schema: COLOR_PIPELINE_SCHEMA,
  intent: "linear-srgb-sdr@1",
  package: Object.freeze({
    input: "unprofiled-srgb-assumed",
    profileBearingImageVideo: "refused",
    working: "premultiplied-linear-srgb"
  }),
  render: Object.freeze({
    delivery: "sdr-bt709-limited",
    frameAlphaBoundary: "straight-srgb-rgba",
    outputAlpha: "not-applicable",
    laneRequirement: "gpu-to-ffmpeg",
    outputRequirement: "mp4-h264",
    fallbackPolicy: "refuse"
  })
});

const COLOR_PIPELINES: Readonly<Record<ColorPipelineIntentId, ColorPipelineContract>> = Object.freeze({
  "legacy-encoded-sdr@0.2.65": LEGACY_ENCODED_SDR_COLOR_PIPELINE,
  "linear-srgb-sdr@1": LINEAR_SRGB_SDR_COLOR_PIPELINE
});

const STRICT_REQUIREMENTS = Object.freeze({
  frameLane: "gpu" as const,
  finalLane: "ffmpeg" as const,
  output: "mp4-h264" as const,
  target: "final" as const,
  features: Object.freeze(["background.fill", "shape.rect", "shape.rect.gradient.linear-radial.static.linear-light", "blend.normal.source-over"] as const)
});

export function isColorPipelineIntentId(value: unknown): value is ColorPipelineIntentId {
  return typeof value === "string" && (COLOR_PIPELINE_INTENTS as readonly string[]).includes(value);
}

/**
 * Resolve omission deliberately. Existing 0.2.65 packages retain their encoded pixels and can
 * never inherit linear-light admission simply because a newer Motion binary opened them.
 */
export function resolveMotionColorPipeline(motion: Pick<MotionDocument, "colorPipeline">): ColorPipelineContract {
  const declaration = motion.colorPipeline;
  if (!declaration) return cloneColorPipelineContract(LEGACY_ENCODED_SDR_COLOR_PIPELINE);
  if (declaration.schema !== COLOR_PIPELINE_SCHEMA || !isColorPipelineIntentId(declaration.intent)) {
    throw new Error("Motion document has an invalid colorPipeline declaration.");
  }
  return cloneColorPipelineContract(COLOR_PIPELINES[declaration.intent]);
}

export function colorPipelineRenderPlan(motion: Pick<MotionDocument, "colorPipeline">): ColorPipelineRenderPlan {
  const contract = resolveMotionColorPipeline(motion);
  return {
    schema: COLOR_PIPELINE_RENDER_PLAN_SCHEMA,
    contract,
    admission: contract.intent === "linear-srgb-sdr@1" ? "strict-route-available" : "legacy-compatible",
    ...(contract.intent === "linear-srgb-sdr@1" ? { strictRequirements: cloneStrictRequirements() } : {})
  };
}

export function colorPipelineValidationReceiptEvidence(motion: Pick<MotionDocument, "colorPipeline">): ColorPipelineReceiptEvidence {
  return {
    schema: COLOR_PIPELINE_RECEIPT_EVIDENCE_SCHEMA,
    requested: resolveMotionColorPipeline(motion),
    actual: {
      status: "not-executed",
      laneImplementation: "not-observed",
      frameAlphaBoundary: "not-observed",
      deliveryTags: "not-observed",
      decodedPixels: "not-observed",
      runtimeAndToolIdentities: "not-observed",
      artifactHashes: "package-input-hashes-bound"
    }
  };
}

export function rendererColorPipelineCapability(lane: string): RendererColorPipelineCapability {
  const strictRouteLane = lane === "gpu" || lane === "ffmpeg";
  return {
    schema: COLOR_PIPELINE_CAPABILITY_SCHEMA,
    lane,
    admittedPackageIntents: strictRouteLane
      ? ["legacy-encoded-sdr@0.2.65", "linear-srgb-sdr@1"]
      : ["legacy-encoded-sdr@0.2.65"],
    strictLinearSrgbSdr: {
      intent: "linear-srgb-sdr@1",
      status: strictRouteLane ? "conditional-route" : "unsupported",
      reason: strictRouteLane
        ? `Lane ${lane} participates only in the exact bounded gpu-to-ffmpeg mp4-h264 strict route; every other strict target, feature, and fallback remains refused.`
        : `Lane ${lane} has no admitted strict linear-sRGB SDR renderer; strict allocation is unavailable.`,
      ...(strictRouteLane ? { route: STRICT_REQUIREMENTS } : {})
    }
  };
}

export function cloneRendererColorPipelineCapability(capability: RendererColorPipelineCapability): RendererColorPipelineCapability {
  return {
    ...capability,
    admittedPackageIntents: [...capability.admittedPackageIntents],
    strictLinearSrgbSdr: {
      ...capability.strictLinearSrgbSdr,
      ...(capability.strictLinearSrgbSdr.route ? { route: cloneStrictRequirements() } : {})
    }
  };
}

/**
 * The fail-closed gate shared by every capability matcher. It runs before renderer allocation.
 */
export function colorPipelineCapabilityUnsupported(
  motion: Pick<MotionDocument, "colorPipeline">,
  lane: string,
): CapabilityMatch["unsupported"] {
  const contract = resolveMotionColorPipeline(motion);
  if (contract.intent === "legacy-encoded-sdr@0.2.65") return [];
  return [{
    layerId: "__color_pipeline__",
    feature: `color-pipeline:${contract.intent}`,
    reason: `Lane ${lane} refuses generic or direct ${contract.intent} allocation. Only the exact bounded streamed gpu-to-ffmpeg mp4-h264 final route is admitted; Browser, Native, direct-frame, segmented, materialized, fallback, wide-gamut, HDR, ICC, and OCIO paths remain unsupported.`
  }];
}

/** Pure runtime entry guard for lanes that bypass the generic capability matcher. */
export function colorPipelinePreallocationRefusal(
  motion: Pick<MotionDocument, "colorPipeline">,
  lane: string,
): { code: "color_pipeline_unsupported"; message: string } | undefined {
  const unsupported = colorPipelineCapabilityUnsupported(motion, lane);
  if (unsupported.length === 0) return undefined;
  return { code: "color_pipeline_unsupported", message: unsupported[0]!.reason };
}

export function validateMotionColorPipeline(
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ path, message: "must be a color-pipeline@1 object" });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schema" && key !== "intent") errors.push({ path: `${path}/${key}`, message: "is not allowed by the closed color-pipeline@1 contract" });
  }
  if (record.schema !== COLOR_PIPELINE_SCHEMA) errors.push({ path: `${path}/schema`, message: `must equal ${COLOR_PIPELINE_SCHEMA}` });
  if (!isColorPipelineIntentId(record.intent)) errors.push({ path: `${path}/intent`, message: `must be ${COLOR_PIPELINE_INTENTS.join(" or ")}` });
}

/** Generated public guide; keep narrative claims coupled to the same closed contract table. */
export function renderColorPipelineGuide(): string {
  return `# Color pipeline contract

> Generated from \`packages/core/src/color-pipeline.ts\`. Do not edit by hand.

Motion packages may omit \`colorPipeline\`; omission resolves to \`${LEGACY_ENCODED_SDR_COLOR_PIPELINE.intent}\` and preserves the encoded-SDR compatibility behavior of v0.2.65. It never inherits strict linear-light admission.

## Package declaration

\`colorPipeline\`, when present, is closed data:

\`\`\`json
{
  "schema": "${COLOR_PIPELINE_SCHEMA}",
  "intent": "${LINEAR_SRGB_SDR_COLOR_PIPELINE.intent}"
}
\`\`\`

No open \`colorSpace\` selector, profile path, ICC/OCIO configuration, or HDR/wide-gamut declaration exists.

## Declared intents

| Intent | Package input/work | Delivery intent | Admission now |
| --- | --- | --- | --- |
| \`${LEGACY_ENCODED_SDR_COLOR_PIPELINE.intent}\` | legacy unprofiled SDR / renderer-defined encoded work | existing renderer-defined behavior | compatibility only |
| \`${LINEAR_SRGB_SDR_COLOR_PIPELINE.intent}\` | unprofiled sRGB decode / premultiplied linear-sRGB | straight-sRGB frame boundary, limited SDR BT.709 \`mp4-h264\` through GPU to FFmpeg | exact bounded final route |

The strict declaration selects one closed final-delivery implementation: an opaque background plus at most 64 canvas-contained static rectangles, normal source-over only, up to 1920x1080, through the exact streamed GPU to FFmpeg \`mp4-h264\` route. A rectangle has either a lower-case \`#rrggbb\` fill or an F2a static linear/radial gradient: 2–16 lower-case \`#rrggbb\` stops, strictly increasing offsets anchored at 0 and 1, a finite linear angle in 0..360 degrees, or a radial centre in 0..1. The strict producer decodes each gradient stop to linear-sRGB before interpolation; alpha remains the bounded top-level rectangle opacity. Motion preflights the route shape plus the exact FFmpeg \`zscale\` and \`libx264\` contract before reserving output, performs premultiplied linear-sRGB WebGPU composition, validates BT.709 limited delivery with FFprobe, inverse-decodes one retained producer frame for calibrated comparison, and binds the observed evidence into the final receipt. Browser, Native, direct-frame, segmented, materialized, image/video/effect/audio, gradient keyframes, non-rect shapes, HDR, ICC, OCIO, fallback, and every other strict route remain refused.

## Receipt boundary

A package-validation receipt records the requested pipeline and explicitly marks lane implementation, frame alpha, observed delivery tags, decoded pixels, and runtime/tool identities as \`not-observed\`. That is source/validation evidence only, not pixel, host, installed, HDR, or native qualification.
`;
}

function cloneColorPipelineContract(contract: ColorPipelineContract): ColorPipelineContract {
  return { ...contract, package: { ...contract.package }, render: { ...contract.render } };
}

function cloneStrictRequirements(): NonNullable<ColorPipelineRenderPlan["strictRequirements"]> {
  return { ...STRICT_REQUIREMENTS, features: [...STRICT_REQUIREMENTS.features] as ["background.fill", "shape.rect", "shape.rect.gradient.linear-radial.static.linear-light", "blend.normal.source-over"] };
}
