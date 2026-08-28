import { hashBuffer } from "./receipts";
import { scanMarkupAttributes, scanMarkupOpenTags, scanMarkupTagPairs } from "./bounded-markup";
import { parseBoundedLottieJson } from "./lottie-json";
import {
  motionAffineMatrix,
  multiplyMotionAffineMatrices,
  transformMotionAffinePoint,
  transformMotionAffineVector,
  type MotionAffineMatrix
} from "./motion-transform-matrix";
import type { MotionBlendMode, MotionDocument, MotionGradient, MotionLayer, OperationReceipt } from "./types";
import {
  prepareLottieLoweringAssets,
  type LottieBundledFontAsset,
  type LottieBundledImageAsset
} from "./lottie-lowering-assets";
import { tryLowerStaticLottieGpuPrecomps } from "./lottie-precomp-adapter-lowering";
import {
  lottieColor,
  lottieStrokeLinecap,
  staticLottieScalar,
  staticLottieStrokeWidth,
  staticLottieVector,
  staticPositiveLottieScalar
} from "./lottie-static-values";

export type { LottieBundledFontAsset, LottieBundledImageAsset } from "./lottie-lowering-assets";

export type AdapterDiagnosticFormat = "svg" | "lottie" | "dotlottie" | "rive" | "gltf";
export type AdapterDiagnosticFeatureStatus = "supported" | "unsupported" | "warning";
export type AdapterDiagnosticLossinessLevel = "none" | "low" | "medium" | "high";

export interface AdapterDiagnosticFeature {
  path: string;
  feature: string;
  status: AdapterDiagnosticFeatureStatus;
  reason: string;
}

export interface AdapterDiagnosticLossiness {
  level: AdapterDiagnosticLossinessLevel;
  budget: string;
  unsupportedCount: number;
  warningCount: number;
  supportedCount: number;
}

export interface AdapterDiagnosticInput {
  adapterId: "adapter.svg" | "adapter.lottie" | "adapter.rive" | string;
  sourcePath: string;
  sourceText: string;
  normalizedPackagePath: string;
  createdAt?: string;
}

export interface AdapterDiagnosticResult {
  schema: "shellx-motion/adapter-diagnostics@1";
  adapterId: string;
  format: AdapterDiagnosticFormat;
  source: {
    path: string;
    sha256: string;
  };
  normalizedPackagePath: string;
  supportedFeatures: AdapterDiagnosticFeature[];
  warningFeatures: AdapterDiagnosticFeature[];
  unsupportedFeatures: AdapterDiagnosticFeature[];
  recommendedFallbackLane: "browser" | "none";
  lossiness: AdapterDiagnosticLossiness;
  suggestedNextAction: string;
  receipt: OperationReceipt;
}

export interface LottieLoweringResult {
  schema: "shellx-motion/adapter-lowering@1";
  adapterId: "adapter.lottie";
  source: { path: string; sha256: string };
  motion: MotionDocument;
  diagnostics: AdapterDiagnosticResult;
  receipt: OperationReceipt;
}

export function lowerStaticLottieToMotion(input: AdapterDiagnosticInput & {
  createdBy?: string;
  sourceApp?: "lottie" | "dotlottie";
  bundledImages?: LottieBundledImageAsset[];
  bundledFonts?: LottieBundledFontAsset[];
}): LottieLoweringResult {
  const gpuPrecomp = tryLowerStaticLottieGpuPrecomps(input, (context) => lowerStaticLottieLayer(context));
  if (gpuPrecomp) return gpuPrecomp;
  const diagnostics = diagnoseAdapterImport({ ...input, adapterId: "adapter.lottie" });
  if (diagnostics.unsupportedFeatures.length > 0) {
    throw new Error(`Lottie lowering refused unsupported features: ${summarizeAdapterFeatures(diagnostics.unsupportedFeatures)}.`);
  }
  const acceptedWarnings = new Set([
    "lottie.text.shaping",
    "lottie.text.layout",
    "lottie.effect.gaussianBlur.approximation",
    "lottie.effect.brightnessContrast.approximation",
    "lottie.trackMatte.luma.approximation",
    "lottie.shape.gradient.linear.approximation"
  ]);
  const unacceptedWarnings = diagnostics.warningFeatures.filter((item) => !acceptedWarnings.has(item.feature));
  if (unacceptedWarnings.length > 0) {
    throw new Error(`Lottie lowering refused unproven features: ${summarizeAdapterFeatures(unacceptedWarnings)}.`);
  }
  const source = parseBoundedLottieJson(input.sourceText);
  const width = positiveLottieNumber(source.w, "w");
  const height = positiveLottieNumber(source.h, "h");
  const fps = positiveLottieNumber(source.fr, "fr");
  const inFrame = finiteLottieNumber(source.ip, "ip");
  const outFrame = finiteLottieNumber(source.op, "op");
  if (outFrame <= inFrame) throw new Error("Lottie lowering requires op greater than ip.");
  const durationMs = Math.round(((outFrame - inFrame) / fps) * 1000);
  const preparedAssets = prepareLottieLoweringAssets(input.bundledImages, input.bundledFonts);
  const bundledImages = preparedAssets.images;
  const sourceLayers = source.layers as unknown[];
  const loweredBySource = sourceLayers.map((value, index) => lowerStaticLottieLayer({
    layer: readJsonRecord(value),
    index,
    fps,
    compositionInFrame: inFrame,
    compositionDurationMs: durationMs,
    width,
    height,
    bundledImages
  }));
  applyFixtureBackedLottieMattes(sourceLayers, loweredBySource);
  const layers = loweredBySource.reverse().flat();
  if (layers.length === 0) throw new Error("Lottie lowering produced no visible Motion layers.");
  const layerIds = new Set<string>();
  for (const layer of layers) {
    if (layerIds.has(layer.id)) throw new Error(`Lottie lowering produced duplicate Motion layer id ${layer.id}.`);
    layerIds.add(layer.id);
  }
  const sourceName = readJsonString(source.nm) ?? "Lottie Import";
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: `motion_lottie_${diagnostics.source.sha256.slice(0, 16)}`,
    name: sourceName,
    durationMs,
    fps,
    width,
    height,
    background: "#00000000",
    layers,
    assets: preparedAssets.motionAssets,
    provenance: {
      sourceApp: input.sourceApp ?? "lottie",
      createdBy: boundedCreatedBy(input.createdBy),
      sourceSchema: readJsonString(source.v) ?? "lottie-json"
    }
  };
  const motionSha256 = hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8"));
  const warnings = diagnostics.warningFeatures.map((item) => item.reason);
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `adapter-lowering-lottie-${motionSha256.slice(0, 16)}`,
    operation: "adapter.lower",
    status: warnings.length > 0 ? "warning" : "passed",
    packageId: input.normalizedPackagePath,
    inputHashes: { source: diagnostics.source.sha256 },
    createdAt: input.createdAt ?? new Date().toISOString(),
    lane: "adapter",
    output: {
      adapterId: "adapter.lottie",
      format: "lottie",
      motionId: motion.id,
      motionSha256,
      layerCount: motion.layers.length,
      bundledImageCount: bundledImages.size,
      bundledFontCount: input.bundledFonts?.length ?? 0,
      lossiness: diagnostics.lossiness,
      acceptedWarningFeatures: diagnostics.warningFeatures.map((item) => ({ path: item.path, feature: item.feature }))
    },
    warnings
  };
  return {
    schema: "shellx-motion/adapter-lowering@1",
    adapterId: "adapter.lottie",
    source: diagnostics.source,
    motion,
    diagnostics,
    receipt
  };
}

export function diagnoseAdapterImport(input: AdapterDiagnosticInput): AdapterDiagnosticResult {
  const format = inferAdapterDiagnosticFormat(input.adapterId, input.sourcePath);
  if (format === "svg") return diagnoseSvgAdapterImport(input);
  if (format === "lottie") return diagnoseLottieAdapterImport(input);
  return unsupportedAdapterDiagnostic(input, format);
}

function diagnoseLottieAdapterImport(input: AdapterDiagnosticInput): AdapterDiagnosticResult {
  const sourceSha256 = hashBuffer(Buffer.from(input.sourceText, "utf8"));
  const document = parseBoundedLottieJson(input.sourceText);
  const supportedFeatures: AdapterDiagnosticFeature[] = [{
    path: "lottie",
    feature: "lottie.composition",
    status: "supported",
    reason: "Composition dimensions, frame rate, and frame bounds can map to a Motion document."
  }];
  const warningFeatures: AdapterDiagnosticFeature[] = [];
  const unsupportedFeatures: AdapterDiagnosticFeature[] = [];
  const layers = Array.isArray(document.layers) ? document.layers : [];
  const assets = Array.isArray(document.assets) ? document.assets : [];
  // Preserve first-match semantics while keeping large image-layer and asset inventories linear.
  const assetsById = new Map<string, Record<string, unknown>>();
  for (const value of assets) {
    const asset = readJsonRecord(value);
    const assetId = readJsonString(asset.id);
    if (assetId && !assetsById.has(assetId)) assetsById.set(assetId, asset);
  }
  layers.forEach((value, index) => {
    const layer = readJsonRecord(value);
    const path = `lottie.layers[${index}]#${lottieLayerId(layer, index)}`;
    const type = readJsonNumber(layer.ty);
    if (type === 4) {
      supportedFeatures.push(feature(path, "lottie.shape.layer", "supported", "Shape layers can be inventoried for bounded static path lowering."));
      diagnoseLottieShapeItems(
        layer.shapes,
        `${path}.shapes`,
        supportedFeatures,
        warningFeatures,
        unsupportedFeatures,
        staticDiagnosticLottieTransform(layer.ks)
      );
    } else if (type === 2) {
      const assetId = readJsonString(layer.refId);
      const asset = assetId ? assetsById.get(assetId) : undefined;
      if (assetId && asset && readJsonString(asset.p)) {
        supportedFeatures.push(feature(path, "lottie.image.asset", "supported", "Image asset references can map to Motion image assets after package staging."));
      } else {
        unsupportedFeatures.push(feature(path, "lottie.image.asset", "unsupported", "Image layers require a resolvable bounded local asset reference."));
      }
    } else if (type === 5) {
      const text = lottieTextValue(layer);
      if (text !== null) {
        supportedFeatures.push(feature(path, "lottie.text.basic", "supported", "Static basic text can map to a Motion text layer."));
      } else {
        unsupportedFeatures.push(feature(path, "lottie.text.basic", "unsupported", "Text layers require one static document-data text value."));
      }
      const textRecord = readJsonRecord(layer.t);
      if (Array.isArray(textRecord.a) && textRecord.a.length > 0) {
        unsupportedFeatures.push(feature(path, "lottie.text.animator", "unsupported", "Per-character Lottie text animators are not lowered by the current Motion contract."));
      }
      if (text && containsComplexText(text)) {
        warningFeatures.push(feature(path, "lottie.text.shaping", "warning", "Complex-script text must render through the Chromium shaping lane and requires font evidence."));
      }
      warningFeatures.push(feature(path, "lottie.text.layout", "warning", "Lottie and browser font metrics can differ; representative-frame text layout QA is required."));
    } else if (type === 1) {
      supportedFeatures.push(feature(path, "lottie.solid", "supported", "Solid layers can map to Motion rectangle shapes."));
    } else if (type === 3) {
      warningFeatures.push(feature(path, "lottie.null", "warning", "Null layers carry transform hierarchy only and require parent-transform flattening before lowering."));
    } else {
      unsupportedFeatures.push(feature(path, `lottie.layer.type:${type ?? "unknown"}`, "unsupported", "This Lottie layer type has no fixture-backed Motion lowering contract."));
    }
    diagnoseLottieTransform(layer.ks, `${path}.ks`, supportedFeatures, warningFeatures, unsupportedFeatures);
    diagnoseLottieLayerBlendMode(layer, path, supportedFeatures, unsupportedFeatures);
    if (Array.isArray(layer.masksProperties) && layer.masksProperties.length > 0) {
      unsupportedFeatures.push(feature(path, "lottie.mask", "unsupported", "Lottie bezier masks require a path-mask renderer contract before editable lowering."));
    }
    const matteMode = readJsonNumber(layer.tt);
    if (matteMode !== null) {
      const source = index > 0 ? readJsonRecord(layers[index - 1]) : {};
      if ([1, 2, 3, 4].includes(matteMode) && readJsonNumber(source.td) === 1 && readJsonNumber(source.ty) === 4) {
        const matteFeatures = ["", "lottie.trackMatte.alpha", "lottie.trackMatte.alphaInverted", "lottie.trackMatte.luma", "lottie.trackMatte.lumaInverted"];
        supportedFeatures.push(feature(path, matteFeatures[matteMode], "supported", "An adjacent static shape matte pair maps to Motion's explicit matte source binding."));
        if (matteMode === 3 || matteMode === 4) {
          warningFeatures.push(feature(path, "lottie.trackMatte.luma.approximation", "warning", "SVG/CSS mask luminance and After Effects color pipelines can differ; representative-frame QA is required."));
        }
      } else {
        unsupportedFeatures.push(feature(path, "lottie.trackMatte", "unsupported", "Only adjacent td=1 static-shape sources with alpha, inverted-alpha, luma, or inverted-luma tt modes have fixture-backed Motion lowering."));
      }
    }
    if (Array.isArray(layer.ef) && layer.ef.length > 0) {
      diagnoseFixtureBackedLottieEffects(layer.ef, `${path}.ef`, supportedFeatures, warningFeatures, unsupportedFeatures);
    }
  });
  if (containsLottieExpression(document)) {
    unsupportedFeatures.push(feature("lottie", "lottie.expression", "unsupported", "Lottie expressions are executable behavior and are refused by deterministic lowering."));
  }
  const supported = dedupeFeatures(supportedFeatures);
  const warnings = dedupeFeatures(warningFeatures);
  const unsupported = dedupeFeatures(unsupportedFeatures);
  const lossiness = adapterLossiness({
    supportedCount: supported.length,
    warningCount: warnings.length,
    unsupportedCount: unsupported.length,
    hasScript: unsupported.some((item) => item.feature === "lottie.expression")
  });
  const resultBase = {
    schema: "shellx-motion/adapter-diagnostics@1" as const,
    adapterId: input.adapterId,
    format: "lottie" as const,
    source: { path: input.sourcePath, sha256: sourceSha256 },
    normalizedPackagePath: input.normalizedPackagePath,
    supportedFeatures: supported,
    warningFeatures: warnings,
    unsupportedFeatures: unsupported,
    recommendedFallbackLane: unsupported.length > 0 ? "browser" as const : "none" as const,
    lossiness,
    suggestedNextAction: unsupported.length > 0
      ? "Use a trusted browser Lottie runtime or remove the reported unsupported features before editable Motion lowering."
      : "Lower the fixture-backed static Lottie subset, then verify rendered frames and the lossiness receipt."
  };
  return {
    ...resultBase,
    receipt: adapterDiagnosticReceipt({ ...resultBase, createdAt: input.createdAt ?? new Date().toISOString() })
  };
}

function diagnoseSvgAdapterImport(input: AdapterDiagnosticInput): AdapterDiagnosticResult {
  const sourceSha256 = hashBuffer(Buffer.from(input.sourceText, "utf8"));
  const supportedFeatures = svgSupportedFeatures(input.sourceText);
  const warningFeatures = svgWarningFeatures(input.sourceText);
  const unsupportedFeatures = svgUnsupportedFeatures(input.sourceText);
  const lossiness = adapterLossiness({
    supportedCount: supportedFeatures.length,
    warningCount: warningFeatures.length,
    unsupportedCount: unsupportedFeatures.length,
    hasScript: unsupportedFeatures.some((feature) => feature.feature === "svg.script")
  });
  const suggestedNextAction = unsupportedFeatures.length > 0
    ? "Use browser capture for this SVG, or remove every reported unsupported feature before lowering to Motion shapes."
    : "Lower supported SVG path geometry to Motion shapes, then run preview and quality checks.";
  const resultBase = {
    schema: "shellx-motion/adapter-diagnostics@1" as const,
    adapterId: input.adapterId,
    format: "svg" as const,
    source: {
      path: input.sourcePath,
      sha256: sourceSha256
    },
    normalizedPackagePath: input.normalizedPackagePath,
    supportedFeatures,
    warningFeatures,
    unsupportedFeatures,
    recommendedFallbackLane: unsupportedFeatures.length > 0 ? "browser" as const : "none" as const,
    lossiness,
    suggestedNextAction
  };
  return {
    ...resultBase,
    receipt: adapterDiagnosticReceipt({
      ...resultBase,
      createdAt: input.createdAt ?? new Date().toISOString()
    })
  };
}

function unsupportedAdapterDiagnostic(input: AdapterDiagnosticInput, format: AdapterDiagnosticFormat): AdapterDiagnosticResult {
  const sourceSha256 = hashBuffer(Buffer.from(input.sourceText, "utf8"));
  const unsupportedFeatures: AdapterDiagnosticFeature[] = [{
    path: input.sourcePath,
    feature: `${format}.diagnostics`,
    status: "unsupported",
    reason: `Fixture-backed lowering is not supported for ${format}.`
  }];
  const resultBase = {
    schema: "shellx-motion/adapter-diagnostics@1" as const,
    adapterId: input.adapterId,
    format,
    source: { path: input.sourcePath, sha256: sourceSha256 },
    normalizedPackagePath: input.normalizedPackagePath,
    supportedFeatures: [],
    warningFeatures: [],
    unsupportedFeatures,
    recommendedFallbackLane: "browser" as const,
    lossiness: {
      level: "high" as const,
      budget: "No lowering budget is approved until a fixture-specific diagnostic is added.",
      unsupportedCount: unsupportedFeatures.length,
      warningCount: 0,
      supportedCount: 0
    },
    suggestedNextAction: `Use browser capture for this source, or convert it to a supported adapter format before importing.`
  };
  return {
    ...resultBase,
    receipt: adapterDiagnosticReceipt({
      ...resultBase,
      createdAt: input.createdAt ?? new Date().toISOString()
    })
  };
}

function lowerStaticLottieLayer(input: {
  layer: Record<string, unknown>;
  index: number;
  fps: number;
  compositionInFrame: number;
  compositionDurationMs: number;
  width: number;
  height: number;
  bundledImages: Map<string, LottieBundledImageAsset>;
  exactTiming?: true;
}): MotionLayer[] {
  const type = readJsonNumber(input.layer.ty);
  const layerId = safeMotionId(lottieLayerId(input.layer, input.index), `layer-${input.index + 1}`);
  const suppliedInFrame = readJsonNumber(input.layer.ip);
  const suppliedOutFrame = readJsonNumber(input.layer.op);
  if (input.exactTiming === true && ((input.layer.ip !== undefined && suppliedInFrame === null) || (input.layer.op !== undefined && suppliedOutFrame === null))) {
    throw new Error(`Lottie lowering requires finite exact layer timing on ${layerId}.`);
  }
  const inFrame = suppliedInFrame ?? input.compositionInFrame;
  const outFrame = suppliedOutFrame ?? input.compositionInFrame + ((input.compositionDurationMs / 1000) * input.fps);
  const compositionOutFrame = input.compositionInFrame + ((input.compositionDurationMs / 1000) * input.fps);
  const visibleInFrame = Math.max(input.compositionInFrame, inFrame);
  const visibleOutFrame = Math.min(compositionOutFrame, outFrame);
  if (visibleOutFrame <= visibleInFrame) return [];
  const startMs = input.exactTiming ? exactLottieFrameMs(visibleInFrame - input.compositionInFrame, input.fps) : Math.max(0, Math.round(((visibleInFrame - input.compositionInFrame) / input.fps) * 1000));
  const durationMs = input.exactTiming ? exactLottieFrameMs(visibleOutFrame - visibleInFrame, input.fps) : Math.max(1, Math.round(((visibleOutFrame - visibleInFrame) / input.fps) * 1000));
  const transform = lottieStaticTransform(input.layer.ks, input.exactTiming === true);
  if (type === 2) {
    const assetId = readJsonString(input.layer.refId);
    const asset = assetId ? input.bundledImages.get(assetId) : undefined;
    if (!asset) throw new Error(`Lottie lowering image layer ${layerId} requires a verified bundled image asset.`);
    if (transform.rotation !== 0 || Math.abs(transform.scaleX - transform.scaleY) > 1e-9) {
      throw new Error(`Lottie lowering image layer ${layerId} requires zero rotation and uniform static scale.`);
    }
    return applyFixtureBackedLottieEffects(input.layer, [{
      id: layerId,
      name: readJsonString(input.layer.nm) ?? layerId,
      type: "image",
      assetId: asset.assetId,
      startMs,
      durationMs,
      fit: "fill",
      transform: {
        x: transform.matrix[4],
        y: transform.matrix[5],
        width: asset.width * transform.scaleX,
        height: asset.height * transform.scaleY,
        opacity: transform.opacity,
        scale: 1,
        rotation: 0
      }
    }]);
  }
  if (type === 5) {
    const text = lottieTextValue(input.layer);
    if (text === null) throw new Error(`Lottie lowering requires static text on ${layerId}.`);
    if (input.exactTiming === true && Math.abs(transform.scaleX - transform.scaleY) > 1e-9) {
      throw new Error(`Lottie lowering text layer ${layerId} requires uniform static scale.`);
    }
    const documentData = readJsonRecord(readJsonRecord(input.layer.t).d);
    const keys = Array.isArray(documentData.k) ? documentData.k : [];
    const textStyle = readJsonRecord(readJsonRecord(keys[0]).s);
    const fontSize = staticPositiveLottieScalar(textStyle.s, 32, "text font size", input.exactTiming === true);
    return applyFixtureBackedLottieEffects(input.layer, [{
      id: layerId,
      name: readJsonString(input.layer.nm) ?? layerId,
      type: "text",
      text,
      startMs,
      durationMs,
      transform: {
        x: transform.x,
        y: transform.y - fontSize,
        width: Math.max(1, input.width - transform.x),
        height: Math.max(fontSize * 1.5, 1),
        opacity: transform.opacity,
        scale: transform.scale,
        rotation: transform.rotation
      },
      style: {
        fontSize,
        fontFamily: readJsonString(textStyle.f) ?? "sans-serif",
        color: lottieColor(textStyle.fc, "#ffffff", input.exactTiming === true),
        ...(containsComplexText(text) ? { direction: "auto", textAlign: "start" } : {})
      }
    }]);
  }
  if (type === 1) {
    const solidWidth = positiveLottieNumber(input.layer.sw, `${layerId}.sw`);
    const solidHeight = positiveLottieNumber(input.layer.sh, `${layerId}.sh`);
    const fill = readJsonString(input.layer.sc);
    if (!fill || !/^#[0-9a-f]{6}$/i.test(fill)) throw new Error(`Lottie lowering solid layer ${layerId} requires a six-digit hex sc color.`);
    return applyFixtureBackedLottieEffects(input.layer, [{
      id: layerId,
      name: readJsonString(input.layer.nm) ?? layerId,
      type: "shape",
      shape: "rect",
      startMs,
      durationMs,
      transform: {
        x: transform.matrix[4],
        y: transform.matrix[5],
        width: solidWidth * transform.scaleX,
        height: solidHeight * transform.scaleY,
        opacity: transform.opacity,
        scale: 1,
        rotation: transform.rotation
      },
      style: { fill }
    }]);
  }
  if (type !== 4) throw new Error(`Lottie lowering does not support layer type ${type ?? "unknown"} on ${layerId}.`);
  const paths = collectStaticLottiePaths(input.layer.shapes, layerId, transform, input.exactTiming === true);
  return applyFixtureBackedLottieEffects(input.layer, paths.map((path, pathIndex) => {
    const transformedPath = transformLottiePath(path);
    const boundsPoints = transformedPath.vertices.flatMap((point, index) => [
      point,
      [point[0] + transformedPath.inTangents[index][0], point[1] + transformedPath.inTangents[index][1]] as [number, number],
      [point[0] + transformedPath.outTangents[index][0], point[1] + transformedPath.outTangents[index][1]] as [number, number]
    ]);
    const minX = Math.min(...boundsPoints.map((point) => point[0]));
    const maxX = Math.max(...boundsPoints.map((point) => point[0]));
    const minY = Math.min(...boundsPoints.map((point) => point[1]));
    const maxY = Math.max(...boundsPoints.map((point) => point[1]));
    const rawSourceWidth = maxX - minX;
    const rawSourceHeight = maxY - minY;
    if (input.exactTiming === true && (rawSourceWidth <= 0 || rawSourceHeight <= 0)) {
      throw new Error(`Lottie lowering requires non-degenerate path bounds on ${layerId}.`);
    }
    const sourceWidth = Math.max(1, rawSourceWidth);
    const sourceHeight = Math.max(1, rawSourceHeight);
    const baseLayer = {
      id: paths.length === 1 ? layerId : `${layerId}-path-${pathIndex + 1}`,
      name: path.name,
      type: "shape",
      startMs,
      durationMs,
      transform: {
        x: minX,
        y: minY,
        width: sourceWidth,
        height: sourceHeight,
        opacity: path.transform.opacity,
        scale: 1,
        rotation: 0
      },
      style: {
        fill: path.fill,
        stroke: path.stroke,
        strokeWidth: path.strokeWidth,
        strokeLinecap: path.strokeLinecap
      }
    } satisfies MotionLayer;
    if (path.primitive === "rectangle" && path.gradient) {
      return {
        ...baseLayer,
        shape: "rect",
        gradient: path.gradient
      } satisfies MotionLayer;
    }
    return {
      ...baseLayer,
      shape: "path",
      "x-path": lottieBezierPath(transformedPath),
      "x-path-viewBox": `${formatLottieNumber(minX)} ${formatLottieNumber(minY)} ${formatLottieNumber(sourceWidth)} ${formatLottieNumber(sourceHeight)}`
    } satisfies MotionLayer;
  }));
}

function applyFixtureBackedLottieMattes(sourceLayers: unknown[], loweredBySource: MotionLayer[][]): void {
  sourceLayers.forEach((value, index) => {
    const consumerSource = readJsonRecord(value);
    const mode = readJsonNumber(consumerSource.tt);
    if (mode === null) return;
    if (![1, 2, 3, 4].includes(mode) || index === 0) throw new Error(`Lottie lowering supports only alpha, inverted-alpha, luma, and inverted-luma adjacent matte pairs at layer ${index}.`);
    const matteSource = readJsonRecord(sourceLayers[index - 1]);
    if (readJsonNumber(matteSource.td) !== 1) throw new Error(`Lottie lowering matte consumer at layer ${index} requires the preceding layer to declare td=1.`);
    const sourceLayersForPair = loweredBySource[index - 1];
    const consumerLayersForPair = loweredBySource[index];
    if (sourceLayersForPair.length !== 1 || sourceLayersForPair[0].type !== "shape") {
      throw new Error(`Lottie lowering matte source at layer ${index - 1} must lower to exactly one static shape.`);
    }
    const source = sourceLayersForPair[0];
    const sourceTransform = readJsonRecord(source.transform);
    if ((readJsonNumber(sourceTransform.opacity) ?? 1) !== 1 || (readJsonNumber(sourceTransform.rotation) ?? 0) !== 0 || (readJsonNumber(sourceTransform.scale) ?? 1) !== 1) {
      throw new Error(`Lottie lowering matte source ${source.id} requires opaque, unrotated, unit-scale geometry.`);
    }
    // Alpha mattes consume geometry only. Luma mattes retain one opaque source
    // fill so the browser mask can preserve its brightness contribution.
    if (mode === 1 || mode === 2) {
      source.style = { fill: "#ffffff" };
    } else {
      const rawFill = readJsonString(readJsonRecord(source.style).fill);
      const fill = rawFill && /^#[0-9a-f]{8}$/i.test(rawFill) && rawFill.slice(7).toLowerCase() === "ff"
        ? rawFill.slice(0, 7)
        : rawFill;
      if (!fill || !/^#[0-9a-f]{6}$/i.test(fill)) {
        throw new Error(`Lottie lowering luma matte source ${source.id} requires one opaque six-digit hex fill.`);
      }
      source.style = { fill };
    }
    for (const consumer of consumerLayersForPair) {
      const transform = readJsonRecord(consumer.transform);
      if ((readJsonNumber(transform.rotation) ?? 0) !== 0 || (readJsonNumber(transform.scale) ?? 1) !== 1) {
        throw new Error(`Lottie lowering matte consumer ${consumer.id} requires unrotated, unit-scale geometry.`);
      }
      const matteTypes = ["", "alpha", "alpha-inverted", "luma", "luma-inverted"] as const;
      consumer.matte = { type: matteTypes[mode], sourceLayerId: source.id };
    }
  });
}

function diagnoseFixtureBackedLottieEffects(
  value: unknown,
  basePath: string,
  supported: AdapterDiagnosticFeature[],
  warnings: AdapterDiagnosticFeature[],
  unsupported: AdapterDiagnosticFeature[]
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const effect = readJsonRecord(entry);
    const path = `${basePath}[${index}]`;
    const matchName = readJsonString(effect.mn);
    if (effect.en === 0) {
      supported.push(feature(path, "lottie.effect.disabled", "supported", "Disabled effects do not alter the lowered Motion layer."));
      return;
    }
    if (matchName === "ADBE Gaussian Blur 2" && staticLottieEffectScalar(effect, "ADBE Gaussian Blur 2-0001") !== null) {
      supported.push(feature(path, "lottie.effect.gaussianBlur", "supported", "Static Gaussian Blur maps to Motion's bounded browser blur effect."));
      warnings.push(feature(path, "lottie.effect.gaussianBlur.approximation", "warning", "CSS and After Effects blur kernels differ; representative-frame QA is required."));
      return;
    }
    if (matchName === "ADBE Brightness & Contrast 2"
      && staticLottieEffectScalar(effect, "ADBE Brightness & Contrast 2-0001") !== null
      && staticLottieEffectScalar(effect, "ADBE Brightness & Contrast 2-0002") !== null) {
      supported.push(feature(path, "lottie.effect.brightnessContrast", "supported", "Static Brightness & Contrast maps to Motion browser filter factors."));
      warnings.push(feature(path, "lottie.effect.brightnessContrast.approximation", "warning", "CSS and After Effects brightness/contrast transfer functions differ; representative-frame QA is required."));
      return;
    }
    unsupported.push(feature(path, `lottie.effect:${matchName ?? "unknown"}`, "unsupported", "Only fixture-backed static Gaussian Blur and Brightness & Contrast effects are lowered."));
  });
}

function applyFixtureBackedLottieEffects(sourceLayer: Record<string, unknown>, layers: MotionLayer[]): MotionLayer[] {
  const effects: NonNullable<MotionLayer["effects"]> = {};
  const effectEntries = Array.isArray(sourceLayer.ef) ? sourceLayer.ef : [];
  for (const entry of effectEntries) {
    const effect = readJsonRecord(entry);
    if (effect.en === 0) continue;
    const matchName = readJsonString(effect.mn);
    if (matchName === "ADBE Gaussian Blur 2") {
      const blur = staticLottieEffectScalar(effect, "ADBE Gaussian Blur 2-0001");
      if (blur === null || blur < 0 || blur > 1000) throw new Error("Lottie Gaussian Blur requires one static value from 0 to 1000.");
      effects.blur = blur;
      continue;
    }
    if (matchName === "ADBE Brightness & Contrast 2") {
      const brightness = staticLottieEffectScalar(effect, "ADBE Brightness & Contrast 2-0001");
      const contrast = staticLottieEffectScalar(effect, "ADBE Brightness & Contrast 2-0002");
      if (brightness === null || contrast === null || brightness < -100 || brightness > 100 || contrast < -100 || contrast > 100) {
        throw new Error("Lottie Brightness & Contrast requires static values from -100 to 100.");
      }
      effects.brightness = Math.max(0, 1 + (brightness / 100));
      effects.contrast = Math.max(0, 1 + (contrast / 100));
      continue;
    }
    throw new Error(`Lottie lowering does not support effect ${matchName ?? "unknown"}.`);
  }
  const blendMode = lottieLayerBlendMode(sourceLayer);
  if (!blendMode) throw new Error(`Lottie lowering does not support blend mode ${String(sourceLayer.bm)}.`);
  const hasEffects = Object.keys(effects).length > 0;
  if (!hasEffects && blendMode === "normal") return layers;
  return layers.map((layer) => ({
    ...layer,
    ...(hasEffects ? { effects: { ...effects } } : {}),
    ...(blendMode !== "normal" ? { blendMode } : {})
  }));
}

const LOTTIE_BLEND_MODES: Readonly<Record<number, MotionBlendMode>> = Object.freeze({
  0: "normal",
  1: "multiply",
  2: "screen",
  3: "overlay",
  4: "darken",
  5: "lighten",
  6: "color-dodge",
  7: "color-burn",
  8: "hard-light",
  9: "soft-light",
  10: "difference",
  11: "exclusion",
  12: "hue",
  13: "saturation",
  14: "color",
  15: "luminosity",
  16: "plus-lighter"
});

function lottieLayerBlendMode(layer: Record<string, unknown>): MotionBlendMode | null {
  if (!("bm" in layer)) return "normal";
  const value = readJsonNumber(layer.bm);
  if (value === null || !Number.isInteger(value)) return null;
  return LOTTIE_BLEND_MODES[value] ?? null;
}

function diagnoseLottieLayerBlendMode(
  layer: Record<string, unknown>,
  path: string,
  supported: AdapterDiagnosticFeature[],
  unsupported: AdapterDiagnosticFeature[]
): void {
  if (!("bm" in layer) || layer.bm === 0) return;
  const blendMode = lottieLayerBlendMode(layer);
  if (!blendMode) {
    unsupported.push(feature(`${path}.bm`, "lottie.blendMode", "unsupported", "Only Lottie blend modes with exact Motion/CSS compositing equivalents are lowered."));
    return;
  }
  supported.push(feature(`${path}.bm`, `lottie.blendMode.${blendMode}`, "supported", `Static Lottie ${blendMode} compositing maps exactly to Motion's declared blend mode.`));
}

function staticLottieEffectScalar(effect: Record<string, unknown>, parameterMatchName: string): number | null {
  const parameters = Array.isArray(effect.ef) ? effect.ef : [];
  const parameter = parameters.map(readJsonRecord).find((candidate) => readJsonString(candidate.mn) === parameterMatchName);
  if (!parameter) return null;
  const value = readJsonRecord(parameter.v);
  if (readJsonNumber(value.a) === 1) return null;
  return readJsonNumber(value.k);
}

interface StaticLottieTransform {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  matrix: MotionAffineMatrix;
}

interface StaticLottiePath {
  name: string;
  primitive: "path" | "rectangle" | "ellipse";
  vertices: Array<[number, number]>;
  inTangents: Array<[number, number]>;
  outTangents: Array<[number, number]>;
  closed: boolean;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "butt" | "round" | "square";
  transform: StaticLottieTransform;
  gradient?: MotionGradient;
}

function collectStaticLottiePaths(value: unknown, layerId: string, initialTransform: StaticLottieTransform, strict = false): StaticLottiePath[] {
  if (!Array.isArray(value)) throw new Error(`Lottie lowering requires a shapes array on ${layerId}.`);
  const paths: StaticLottiePath[] = [];
  const visit = (items: unknown[], inheritedTransform: StaticLottieTransform): void => {
    const records = items.map(readJsonRecord);
    const localTransform = records.find((item) => readJsonString(item.ty) === "tr");
    const transform = combineLottieTransforms(inheritedTransform, lottieStaticTransform(localTransform, strict));
    const fillItem = records.find((item) => readJsonString(item.ty) === "fl");
    const gradientItem = records.find((item) => readJsonString(item.ty) === "gf");
    const strokeItem = records.find((item) => readJsonString(item.ty) === "st");
    if (fillItem && gradientItem) throw new Error(`Lottie lowering does not combine solid and gradient fills on ${layerId}.`);
    for (const item of records) {
      const type = readJsonString(item.ty);
      if (type === "gr") {
        if (!Array.isArray(item.it)) throw new Error(`Lottie lowering requires group items on ${layerId}.`);
        visit(item.it, transform);
      } else if (type === "sh") {
        const shape = readJsonRecord(readJsonRecord(item.ks).k);
        const vertices = lottiePointList(shape.v, `${layerId}.vertices`);
        const inTangents = lottiePointList(shape.i, `${layerId}.inTangents`);
        const outTangents = lottiePointList(shape.o, `${layerId}.outTangents`);
        if (vertices.length < 2 || inTangents.length !== vertices.length || outTangents.length !== vertices.length) {
          throw new Error(`Lottie lowering requires matching path vertex and tangent arrays on ${layerId}.`);
        }
        paths.push({
          name: readJsonString(item.nm) ?? layerId,
          primitive: "path",
          vertices,
          inTangents,
          outTangents,
          closed: shape.c === true,
          fill: fillItem ? lottieColor(readJsonRecord(fillItem.c).k, "transparent", strict) : "transparent",
          stroke: strokeItem ? lottieColor(readJsonRecord(strokeItem.c).k, "transparent", strict) : "transparent",
          strokeWidth: staticLottieStrokeWidth(strokeItem, strict),
          strokeLinecap: lottieStrokeLinecap(readJsonNumber(strokeItem?.lc), strict),
          transform
        });
      } else if (type === "rc" || type === "el") {
        const primitive = staticLottiePrimitivePath(item, type, layerId, strict);
        if (gradientItem && type !== "rc") throw new Error(`Lottie lowering supports gradient fills only on one static zero-radius rectangle on ${layerId}.`);
        paths.push({
          name: readJsonString(item.nm) ?? layerId,
          primitive: type === "rc" ? "rectangle" : "ellipse",
          ...primitive,
          fill: fillItem ? lottieColor(readJsonRecord(fillItem.c).k, "transparent", strict) : "transparent",
          stroke: strokeItem ? lottieColor(readJsonRecord(strokeItem.c).k, "transparent", strict) : "transparent",
          strokeWidth: staticLottieStrokeWidth(strokeItem, strict),
          strokeLinecap: lottieStrokeLinecap(readJsonNumber(strokeItem?.lc), strict),
          transform,
          ...(gradientItem ? { gradient: lottieStaticLinearGradient(gradientItem, transform, layerId, item, strict) } : {})
        });
      } else if (type && !["tr", "fl", "gf", "st"].includes(type)) {
        throw new Error(`Lottie lowering does not implement shape operator ${type} on ${layerId}.`);
      }
    }
  };
  visit(value, initialTransform);
  if (paths.length === 0) throw new Error(`Lottie lowering found no path geometry on ${layerId}.`);
  return paths;
}

function lottieStaticLinearGradient(
  item: Record<string, unknown>,
  transform: StaticLottieTransform,
  layerId: string,
  rectangle: Record<string, unknown>,
  strict = false,
): MotionGradient {
  if (readJsonNumber(item.t) !== 1) throw new Error(`Lottie lowering requires a linear gradient fill on ${layerId}.`);
  if (!lottiePropertyIsStatic(item.o) || !lottiePropertyIsStatic(item.s) || !lottiePropertyIsStatic(item.e)) {
    throw new Error(`Lottie lowering requires static gradient opacity and endpoints on ${layerId}.`);
  }
  if (staticLottieScalar(item.o, 100, strict) !== 100) {
    throw new Error(`Lottie lowering requires 100 percent gradient fill opacity on ${layerId}.`);
  }
  const gradient = readJsonRecord(item.g);
  const pointCount = readJsonNumber(gradient.p);
  if (pointCount === null || !Number.isInteger(pointCount) || pointCount < 2 || pointCount > 16) {
    throw new Error(`Lottie lowering requires between 2 and 16 gradient color stops on ${layerId}.`);
  }
  if (!lottiePropertyIsStatic(gradient.k)) throw new Error(`Lottie lowering requires static gradient colors on ${layerId}.`);
  const colorProperty = readJsonRecord(gradient.k);
  const rawColors = colorProperty.k ?? gradient.k;
  if (!Array.isArray(rawColors) || rawColors.length !== pointCount * 4) {
    throw new Error(`Lottie lowering requires color-only gradient stops without separate opacity stops on ${layerId}.`);
  }
  const stops = Array.from({ length: pointCount }, (_, index) => {
    const values = rawColors.slice(index * 4, index * 4 + 4).map(readJsonNumber);
    if (values.some((value) => value === null)) throw new Error(`Lottie lowering requires finite gradient stop values on ${layerId}.`);
    const [offset, red, green, blue] = values as number[];
    if (offset < 0 || offset > 1 || red < 0 || red > 1 || green < 0 || green > 1 || blue < 0 || blue > 1) {
      throw new Error(`Lottie lowering requires normalized gradient stop values on ${layerId}.`);
    }
    return { offset, color: lottieColor([red, green, blue, 1], "#000000ff") };
  });
  if (stops.some((stop, index) => index > 0 && stop.offset < stops[index - 1].offset)) {
    throw new Error(`Lottie lowering requires ordered gradient color stops on ${layerId}.`);
  }
  const start = staticLottieVector(item.s, [0, 0], strict);
  const end = staticLottieVector(item.e, [0, 0], strict);
  const localX = end[0] - start[0];
  const localY = end[1] - start[1];
  if (!lottieTransformPreservesAxisAlignedRectangle(transform)) {
    throw new Error(`Lottie lowering requires gradient rectangle transforms in 90-degree increments on ${layerId}.`);
  }
  assertLottieGradientSpansRectangle(start, end, rectangle, transform, layerId, strict);
  const deltaX = (transform.matrix[0] * localX) + (transform.matrix[2] * localY);
  const deltaY = (transform.matrix[1] * localX) + (transform.matrix[3] * localY);
  if (Math.hypot(deltaX, deltaY) <= 1e-9) throw new Error(`Lottie lowering requires distinct gradient endpoints on ${layerId}.`);
  return {
    type: "linear",
    angle: formatLottieAngle((Math.atan2(deltaY, deltaX) * 180 / Math.PI) + 90),
    stops
  };
}

function assertLottieGradientSpansRectangle(
  start: number[],
  end: number[],
  rectangle: Record<string, unknown>,
  transform: StaticLottieTransform,
  layerId: string,
  strict = false,
): void {
  const [centerX, centerY] = staticLottieVector(rectangle.p, [0, 0], strict);
  const [width, height] = staticLottieVector(rectangle.s, [0, 0], strict);
  const point = (value: number[]): [number, number] => [
    (transform.matrix[0] * value[0]) + (transform.matrix[2] * value[1]) + transform.matrix[4],
    (transform.matrix[1] * value[0]) + (transform.matrix[3] * value[1]) + transform.matrix[5]
  ];
  const corners = [
    point([centerX - (width / 2), centerY - (height / 2)]),
    point([centerX + (width / 2), centerY - (height / 2)]),
    point([centerX + (width / 2), centerY + (height / 2)]),
    point([centerX - (width / 2), centerY + (height / 2)])
  ];
  const transformedStart = point(start);
  const transformedEnd = point(end);
  const minX = Math.min(...corners.map((corner) => corner[0]));
  const maxX = Math.max(...corners.map((corner) => corner[0]));
  const minY = Math.min(...corners.map((corner) => corner[1]));
  const maxY = Math.max(...corners.map((corner) => corner[1]));
  const middleX = (minX + maxX) / 2;
  const middleY = (minY + maxY) / 2;
  const epsilon = 1e-4;
  const close = (left: number, right: number): boolean => Math.abs(left - right) <= epsilon;
  const horizontal = close(transformedStart[1], middleY)
    && close(transformedEnd[1], middleY)
    && close(Math.min(transformedStart[0], transformedEnd[0]), minX)
    && close(Math.max(transformedStart[0], transformedEnd[0]), maxX);
  const vertical = close(transformedStart[0], middleX)
    && close(transformedEnd[0], middleX)
    && close(Math.min(transformedStart[1], transformedEnd[1]), minY)
    && close(Math.max(transformedStart[1], transformedEnd[1]), maxY);
  if (!horizontal && !vertical) {
    throw new Error(`Lottie lowering requires edge-to-edge horizontal or vertical gradient endpoints on ${layerId}.`);
  }
}

function formatLottieAngle(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Number(normalized.toFixed(4));
}

function lottieTransformPreservesAxisAlignedRectangle(transform: StaticLottieTransform): boolean {
  const [a, b, c, d] = transform.matrix;
  const epsilon = 1e-9;
  return (Math.abs(b) <= epsilon && Math.abs(c) <= epsilon)
    || (Math.abs(a) <= epsilon && Math.abs(d) <= epsilon);
}

function staticLottiePrimitivePath(
  item: Record<string, unknown>,
  type: "rc" | "el",
  layerId: string,
  strict = false,
): Pick<StaticLottiePath, "vertices" | "inTangents" | "outTangents" | "closed"> {
  if (!lottiePropertyIsStatic(item.p) || !lottiePropertyIsStatic(item.s)) {
    throw new Error(`Lottie lowering requires static ${type === "rc" ? "rectangle" : "ellipse"} position and size on ${layerId}.`);
  }
  const [cx, cy] = staticLottieVector(item.p, [0, 0], strict);
  const [width, height] = staticLottieVector(item.s, [0, 0], strict);
  if (width <= 0 || height <= 0) throw new Error(`Lottie lowering requires positive primitive size on ${layerId}.`);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  if (type === "rc") {
    if (!lottiePropertyIsStatic(item.r) || staticLottieScalar(item.r, 0, strict) !== 0) {
      throw new Error(`Lottie lowering requires a static zero-radius rectangle on ${layerId}.`);
    }
    return {
      vertices: [[cx - halfWidth, cy - halfHeight], [cx + halfWidth, cy - halfHeight], [cx + halfWidth, cy + halfHeight], [cx - halfWidth, cy + halfHeight]],
      inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
      outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
      closed: true
    };
  }
  const kappa = 0.5522847498307936;
  return {
    vertices: [[cx, cy - halfHeight], [cx + halfWidth, cy], [cx, cy + halfHeight], [cx - halfWidth, cy]],
    inTangents: [[-kappa * halfWidth, 0], [0, -kappa * halfHeight], [kappa * halfWidth, 0], [0, kappa * halfHeight]],
    outTangents: [[kappa * halfWidth, 0], [0, kappa * halfHeight], [-kappa * halfWidth, 0], [0, -kappa * halfHeight]],
    closed: true
  };
}

function identityLottieTransform(): StaticLottieTransform {
  return { x: 0, y: 0, anchorX: 0, anchorY: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, matrix: [1, 0, 0, 1, 0, 0] };
}

function lottieStaticTransform(value: unknown, strict = false): StaticLottieTransform {
  const transform = readJsonRecord(value);
  if (Object.keys(transform).length === 0) return identityLottieTransform();
  if (strict && transform.r !== undefined && transform.rz !== undefined) {
    throw new Error("Lottie lowering requires at most one static transform rotation property.");
  }
  for (const key of ["p", "s", "r", "rz", "a", "o"]) {
    if (transform[key] !== undefined && !lottiePropertyIsStatic(transform[key])) {
      throw new Error(`Lottie lowering requires static transform property ${key}.`);
    }
  }
  for (const key of ["sk", "sa"]) {
    if (transform[key] !== undefined && (!lottiePropertyIsStatic(transform[key]) || staticLottieScalar(transform[key], 0, strict) !== 0)) {
      throw new Error(`Lottie lowering does not support transform skew property ${key}.`);
    }
  }
  const position = staticLottieVector(transform.p, [0, 0], strict);
  const anchor = staticLottieVector(transform.a, [0, 0], strict);
  const scale = staticLottieVector(transform.s, [100, 100], strict);
  if (strict && (scale[0] <= 0 || scale[1] <= 0)) {
    throw new Error("Lottie lowering requires positive static transform scale values.");
  }
  const scaleX = strict ? scale[0] / 100 : positiveOr(scale[0], 100) / 100;
  const scaleY = strict ? scale[1] / 100 : positiveOr(scale[1], 100) / 100;
  const rotation = staticLottieScalar(transform.r ?? transform.rz, 0, strict);
  const opacityPercent = staticLottieScalar(transform.o, 100, strict);
  if (strict && (opacityPercent < 0 || opacityPercent > 100)) {
    throw new Error("Lottie lowering requires static transform opacity from 0 through 100 percent.");
  }
  return {
    x: position[0],
    y: position[1],
    anchorX: anchor[0],
    anchorY: anchor[1],
    scale: Math.sqrt(scaleX * scaleY),
    scaleX,
    scaleY,
    rotation,
    opacity: strict ? opacityPercent / 100 : Math.max(0, Math.min(1, opacityPercent / 100)),
    matrix: motionAffineMatrix({
      // Lottie position denotes the transformed anchor, whereas Motion x/y denotes the box's
      // untransformed top-left. Convert before using the shared Motion affine authority.
      x: position[0] - anchor[0], y: position[1] - anchor[1], originX: anchor[0], originY: anchor[1], scaleX, scaleY, rotation
    })
  };
}

function combineLottieTransforms(parent: StaticLottieTransform, child: StaticLottieTransform): StaticLottieTransform {
  return {
    x: parent.x + child.x,
    y: parent.y + child.y,
    anchorX: parent.anchorX + child.anchorX,
    anchorY: parent.anchorY + child.anchorY,
    scale: parent.scale * child.scale,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
    rotation: parent.rotation + child.rotation,
    opacity: parent.opacity * child.opacity,
    matrix: multiplyMotionAffineMatrices(parent.matrix, child.matrix)
  };
}

function transformLottiePath(path: StaticLottiePath): StaticLottiePath {
  const matrix = path.transform.matrix;
  const point = (value: [number, number]): [number, number] => transformMotionAffinePoint(matrix, value);
  const vector = (value: [number, number]): [number, number] => transformMotionAffineVector(matrix, value);
  return {
    ...path,
    vertices: path.vertices.map(point),
    inTangents: path.inTangents.map(vector),
    outTangents: path.outTangents.map(vector),
    strokeWidth: path.strokeWidth * Math.sqrt(Math.abs((matrix[0] * matrix[3]) - (matrix[1] * matrix[2]))),
    transform: { ...identityLottieTransform(), opacity: path.transform.opacity }
  };
}

function lottiePointList(value: unknown, label: string): Array<[number, number]> {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error(`Lottie lowering requires a bounded ${label} array.`);
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) throw new Error(`Lottie lowering requires 2D points in ${label}.`);
    const x = readJsonNumber(entry[0]);
    const y = readJsonNumber(entry[1]);
    if (x === null || y === null) throw new Error(`Lottie lowering requires finite points in ${label}.`);
    return [x, y];
  });
}

function lottieBezierPath(path: StaticLottiePath): string {
  const segments = [`M ${formatLottieNumber(path.vertices[0][0])} ${formatLottieNumber(path.vertices[0][1])}`];
  const edgeCount = path.closed ? path.vertices.length : path.vertices.length - 1;
  for (let index = 0; index < edgeCount; index += 1) {
    const next = (index + 1) % path.vertices.length;
    const from = path.vertices[index];
    const to = path.vertices[next];
    const out = path.outTangents[index];
    const incoming = path.inTangents[next];
    segments.push(`C ${formatLottieNumber(from[0] + out[0])} ${formatLottieNumber(from[1] + out[1])} ${formatLottieNumber(to[0] + incoming[0])} ${formatLottieNumber(to[1] + incoming[1])} ${formatLottieNumber(to[0])} ${formatLottieNumber(to[1])}`);
  }
  if (path.closed) segments.push("Z");
  return segments.join(" ");
}

function safeMotionId(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return normalized || fallback;
}

function boundedCreatedBy(value: string | undefined): string {
  const createdBy = value?.trim() || "lottie-adapter";
  if (createdBy.length > 128 || /[\u0000-\u001f\u007f]/.test(createdBy)) {
    throw new Error("Lottie lowering createdBy must be at most 128 printable characters.");
  }
  return createdBy;
}

function summarizeAdapterFeatures(features: AdapterDiagnosticFeature[]): string {
  const shown = features.slice(0, 25).map((item) => `${item.path}:${item.feature}`);
  return `${shown.join(", ")}${features.length > shown.length ? `, plus ${features.length - shown.length} more` : ""}`;
}

function formatLottieNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function finiteLottieNumber(value: unknown, key: string): number {
  const number = readJsonNumber(value);
  if (number === null) throw new Error(`Lottie lowering requires finite ${key}.`);
  return number;
}
function exactLottieFrameMs(frames: number, fps: number): number { const microseconds = frames * 1_000_000 / fps; if (!Number.isSafeInteger(microseconds) || microseconds < 0) throw new Error("Lottie GPU precomposition frame time cannot map losslessly to a safe integer microsecond."); return microseconds / 1_000; }

function positiveLottieNumber(value: unknown, key: string): number {
  const number = finiteLottieNumber(value, key);
  if (number <= 0) throw new Error(`Lottie lowering requires positive ${key}.`);
  return number;
}

function positiveOr(value: number | null, fallback: number): number {
  return value !== null && value > 0 ? value : fallback;
}

function feature(path: string, name: string, status: AdapterDiagnosticFeatureStatus, reason: string): AdapterDiagnosticFeature {
  return { path, feature: name, status, reason };
}

function lottieLayerId(layer: Record<string, unknown>, index: number): string {
  const name = readJsonString(layer.nm)?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128);
  return name || String(readJsonNumber(layer.ind) ?? index + 1);
}

function diagnoseLottieShapeItems(
  value: unknown,
  basePath: string,
  supported: AdapterDiagnosticFeature[],
  warnings: AdapterDiagnosticFeature[],
  unsupported: AdapterDiagnosticFeature[],
  inheritedTransform: StaticLottieTransform | null = identityLottieTransform()
): void {
  if (!Array.isArray(value)) {
    unsupported.push(feature(basePath, "lottie.shape.items", "unsupported", "Shape layers require a bounded shapes array."));
    return;
  }
  const records = value.map(readJsonRecord);
  const localTransform = records.find((candidate) => readJsonString(candidate.ty) === "tr");
  const transform = inheritedTransform && staticDiagnosticLottieTransform(localTransform)
    ? combineLottieTransforms(inheritedTransform, lottieStaticTransform(localTransform))
    : null;
  value.forEach((entry, index) => {
    const item = readJsonRecord(entry);
    const path = `${basePath}[${index}]`;
    const type = readJsonString(item.ty);
    if (type === "gr") {
      supported.push(feature(path, "lottie.shape.group", "supported", "Shape groups can be recursively inventoried."));
      diagnoseLottieShapeItems(item.it, `${path}.it`, supported, warnings, unsupported, transform);
      return;
    }
    if (type === "sh") {
      if (lottiePropertyIsStatic(item.ks) && Object.keys(readJsonRecord(readJsonRecord(item.ks).k)).length > 0) {
        supported.push(feature(path, "lottie.shape.path", "supported", "Static bezier vertices can lower to Motion path data."));
      } else {
        unsupported.push(feature(path, "lottie.shape.path.animated", "unsupported", "Animated Lottie path geometry requires a path-keyframe renderer contract."));
      }
      return;
    }
    if (type === "rc" || type === "el") {
      const label = type === "rc" ? "rectangle" : "ellipse";
      if (!lottiePropertyIsStatic(item.p) || !lottiePropertyIsStatic(item.s)) {
        unsupported.push(feature(path, `lottie.shape.${label}.animated`, "unsupported", `Animated ${label} position or size requires keyframe lowering.`));
      } else if (type === "rc" && (!lottiePropertyIsStatic(item.r) || staticLottieScalar(item.r, 0) !== 0)) {
        unsupported.push(feature(path, "lottie.shape.rectangle.rounded", "unsupported", "Rounded Lottie rectangles need a fixture-proven radius-to-path mapping."));
      } else {
        supported.push(feature(path, `lottie.shape.${label}`, "supported", `Static ${label} primitives lower deterministically to Motion path geometry.`));
      }
      return;
    }
    if (type === "fl") {
      supported.push(feature(path, "lottie.shape.fill", "supported", "Static fill color maps to Motion shape style."));
      if (!lottiePropertyIsStatic(item.c) || !lottiePropertyIsStatic(item.o)) warnings.push(feature(path, "lottie.shape.fill.animated", "warning", "Animated fill/opacity requires keyframe lowering and frame QA."));
      return;
    }
    if (type === "gf") {
      const geometry = records.filter((candidate) => ["sh", "rc", "el"].includes(readJsonString(candidate.ty) ?? ""));
      const gradientFillCount = records.filter((candidate) => readJsonString(candidate.ty) === "gf").length;
      const solidFillCount = records.filter((candidate) => readJsonString(candidate.ty) === "fl").length;
      if (geometry.length !== 1 || readJsonString(geometry[0]?.ty) !== "rc" || gradientFillCount !== 1 || solidFillCount > 0) {
        unsupported.push(feature(path, "lottie.shape.gradient.linear", "unsupported", "Editable gradient lowering requires exactly one static zero-radius rectangle, one gradient fill, and no solid fill in the same group."));
        return;
      }
      try {
        if (!transform) throw new Error(`Lottie lowering requires static gradient rectangle transforms on ${path}.`);
        staticLottiePrimitivePath(geometry[0], "rc", path);
        lottieStaticLinearGradient(item, transform, path, geometry[0]);
        supported.push(feature(path, "lottie.shape.gradient.linear", "supported", "A bounded static linear gradient fill maps to Motion's editable rectangle gradient."));
        warnings.push(feature(path, "lottie.shape.gradient.linear.approximation", "warning", "Lottie and CSS gradient interpolation/color-space behavior can differ; representative-frame QA is required."));
      } catch (error) {
        unsupported.push(feature(path, "lottie.shape.gradient.linear", "unsupported", error instanceof Error ? error.message : "The gradient fill is outside the fixture-backed static subset."));
      }
      return;
    }
    if (type === "st") {
      supported.push(feature(path, "lottie.shape.stroke", "supported", "Static stroke color and width map to Motion shape style."));
      if (!lottiePropertyIsStatic(item.c) || !lottiePropertyIsStatic(item.w) || !lottiePropertyIsStatic(item.o)) warnings.push(feature(path, "lottie.shape.stroke.animated", "warning", "Animated stroke properties require keyframe lowering and frame QA."));
      return;
    }
    if (type === "tr") {
      diagnoseLottieTransform(item, path, supported, warnings, unsupported);
      return;
    }
    const names: Record<string, string> = { tm: "trimPath", mm: "mergePath", rp: "repeater", gs: "gradientStroke", rc: "rectangle", el: "ellipse", sr: "star" };
    unsupported.push(feature(path, `lottie.shape.${names[type ?? ""] ?? type ?? "unknown"}`, "unsupported", "This Lottie shape operator has no fixture-backed editable lowering and is not silently approximated."));
  });
}

function diagnoseLottieTransform(
  value: unknown,
  path: string,
  supported: AdapterDiagnosticFeature[],
  warnings: AdapterDiagnosticFeature[],
  unsupported: AdapterDiagnosticFeature[]
): void {
  const transform = readJsonRecord(value);
  if (Object.keys(transform).length === 0) return;
  supported.push(feature(path, "lottie.transform", "supported", "Static position, scale, rotation, anchor, and opacity can map to Motion transforms."));
  for (const key of ["p", "s", "r", "rz", "a", "o"]) {
    if (transform[key] !== undefined && !lottiePropertyIsStatic(transform[key])) {
      warnings.push(feature(`${path}.${key}`, "lottie.transform.animated", "warning", "Animated transforms require keyframe interpolation and representative-frame QA."));
    }
  }
  for (const key of ["sk", "sa"]) {
    if (transform[key] !== undefined && (!lottiePropertyIsStatic(transform[key]) || staticLottieScalar(transform[key], 0) !== 0)) {
      unsupported.push(feature(`${path}.${key}`, "lottie.transform.skew", "unsupported", "Lottie transform skew is not represented by Motion's editable 2D transform and is not silently discarded."));
    }
  }
}

function staticDiagnosticLottieTransform(value: unknown): StaticLottieTransform | null {
  const transform = readJsonRecord(value);
  for (const key of ["p", "s", "r", "rz", "a", "o", "sk", "sa"]) {
    if (transform[key] !== undefined && !lottiePropertyIsStatic(transform[key])) return null;
  }
  try {
    return lottieStaticTransform(transform);
  } catch {
    return null;
  }
}

function lottiePropertyIsStatic(value: unknown): boolean {
  const property = readJsonRecord(value);
  if (readJsonNumber(property.a) === 1) return false;
  if (!Array.isArray(property.k)) return true;
  return !property.k.some((entry) => {
    const keyframe = readJsonRecord(entry);
    return readJsonNumber(keyframe.t) !== null || keyframe.s !== undefined || keyframe.e !== undefined;
  });
}

function lottieTextValue(layer: Record<string, unknown>): string | null {
  const text = readJsonRecord(layer.t);
  const documentData = readJsonRecord(text.d);
  const keys = Array.isArray(documentData.k) ? documentData.k : [];
  if (keys.length !== 1) return null;
  return readJsonString(readJsonRecord(readJsonRecord(keys[0]).s).t);
}

function containsLottieExpression(value: unknown): boolean {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = readJsonRecord(current);
    for (const [key, entry] of Object.entries(record)) {
      if (key === "x" && typeof entry === "string" && entry.trim()) return true;
      stack.push(entry);
    }
  }
  return false;
}

function containsComplexText(value: string): boolean {
  return /[\u0300-\u036f\u0590-\u0fff\u1000-\u109f\u1780-\u17ff\u200c\u200d\ufb1d-\ufdff\ufe70-\ufefc]/u.test(value);
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readJsonString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readJsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function svgSupportedFeatures(sourceText: string): AdapterDiagnosticFeature[] {
  const features: AdapterDiagnosticFeature[] = [];
  if (/\bviewBox\s*=/.test(sourceText)) {
    features.push({
      path: "svg",
      feature: "svg.viewBox",
      status: "supported",
      reason: "SVG viewBox can define the Motion package canvas bounds."
    });
  }
  for (const pathElement of svgPathElements(sourceText)) {
    const path = `svg.path#${pathElement.id}`;
    if (pathElement.attrs.d) {
      features.push({
        path,
        feature: "svg.path.d",
        status: "supported",
        reason: "Path geometry can be lowered to Motion shape path data."
      });
    }
    if (pathElement.attrs.stroke) {
      features.push({
        path,
        feature: "svg.path.stroke",
        status: "supported",
        reason: "Stroke color maps to Motion shape style."
      });
    }
    if (pathElement.attrs["stroke-width"]) {
      features.push({
        path,
        feature: "svg.path.strokeWidth",
        status: "supported",
        reason: "Stroke width maps to Motion shape style."
      });
    }
    if (pathElement.attrs["stroke-linecap"]) {
      features.push({
        path,
        feature: "svg.path.strokeLinecap",
        status: "supported",
        reason: "Stroke line caps map to Motion stroke style metadata."
      });
    }
  }
  return dedupeFeatures(features);
}

function svgWarningFeatures(sourceText: string): AdapterDiagnosticFeature[] {
  return svgPathElements(sourceText)
    .filter((pathElement) => /[CQSTAcqsta]/.test(pathElement.attrs.d ?? ""))
    .map((pathElement) => ({
      path: `svg.path#${pathElement.id}`,
      feature: "svg.path.curve",
      status: "warning" as const,
      reason: "Curved path geometry is recognized, but exact curve interpolation still needs fixture-level visual QA."
    }));
}

function svgUnsupportedFeatures(sourceText: string): AdapterDiagnosticFeature[] {
  const features: AdapterDiagnosticFeature[] = [];
  for (const animate of svgAnimateElements(sourceText)) {
    if (animate.attrs.attributeName === "d") {
      features.push({
        path: `svg.path#${animate.parentPathId}`,
        feature: "svg.animate.attributeName:d",
        status: "unsupported",
        reason: "SVG path morphing requires a path-keyframe renderer contract and is not lowered as a static path."
      });
    }
  }
  for (const id of svgElementIds(sourceText, "filter")) {
    features.push({
      path: `svg.defs.filter#${id}`,
      feature: "svg.filter",
      status: "unsupported",
      reason: "SVG filters are not lowered to Motion effects in this adapter slice."
    });
  }
  for (const id of svgElementIds(sourceText, "mask")) {
    features.push({
      path: `svg.mask#${id}`,
      feature: "svg.mask",
      status: "unsupported",
      reason: "SVG masks require browser fallback until mask path lowering is implemented."
    });
  }
  if (/<script\b/i.test(sourceText)) {
    features.push({
      path: "svg.script",
      feature: "svg.script",
      status: "unsupported",
      reason: "Scripts are refused for deterministic local adapter imports."
    });
  }
  if (/<foreignObject\b/i.test(sourceText)) {
    features.push({
      path: "svg.foreignObject",
      feature: "svg.foreignObject",
      status: "unsupported",
      reason: "foreignObject content requires browser fallback and is not lowered to Motion layers."
    });
  }
  return dedupeFeatures(features);
}

function adapterLossiness(input: {
  supportedCount: number;
  warningCount: number;
  unsupportedCount: number;
  hasScript: boolean;
}): AdapterDiagnosticLossiness {
  const level: AdapterDiagnosticLossinessLevel = input.unsupportedCount === 0
    ? input.warningCount > 0 ? "low" : "none"
    : input.hasScript || input.unsupportedCount >= 3 ? "high" : "medium";
  const budget = level === "none"
    ? "No unsupported feature loss detected by the current diagnostic parser."
    : level === "low"
      ? "Visual QA is required for recognized but not fully proven features."
      : level === "medium"
        ? "Lossy lowering may be acceptable only after removing or replacing unsupported SVG features."
        : "Use browser capture unless unsupported SVG features are removed before Motion lowering.";
  return {
    level,
    budget,
    unsupportedCount: input.unsupportedCount,
    warningCount: input.warningCount,
    supportedCount: input.supportedCount
  };
}

function adapterDiagnosticReceipt(input: Omit<AdapterDiagnosticResult, "receipt"> & { createdAt: string }): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `adapter-diagnostics-${input.format}-${input.source.sha256.slice(0, 16)}`,
    operation: "adapter.diagnostics",
    status: input.unsupportedFeatures.length > 0 || input.warningFeatures.length > 0 ? "warning" : "passed",
    packageId: input.normalizedPackagePath,
    inputHashes: {
      source: input.source.sha256
    },
    createdAt: input.createdAt,
    lane: "adapter",
    output: {
      adapterId: input.adapterId,
      format: input.format,
      source: input.source,
      normalizedPackagePath: input.normalizedPackagePath,
      supportedFeatures: input.supportedFeatures,
      warningFeatures: input.warningFeatures,
      unsupportedFeatures: input.unsupportedFeatures,
      recommendedFallbackLane: input.recommendedFallbackLane,
      lossiness: input.lossiness,
      suggestedNextAction: input.suggestedNextAction
    },
    warnings: [...input.warningFeatures, ...input.unsupportedFeatures].map((feature) => feature.reason)
  };
}

function inferAdapterDiagnosticFormat(adapterId: string, sourcePath: string): AdapterDiagnosticFormat {
  const lower = `${adapterId} ${sourcePath}`.toLowerCase();
  if (lower.includes("dotlottie")) return "dotlottie";
  if (lower.includes("lottie")) return "lottie";
  if (lower.includes("rive") || lower.endsWith(".riv")) return "rive";
  return "svg";
}

// SVG element inventory. The lazy nested regexes these replaced went cubic on an unclosed <path>
// (22.9 s on 40 KB); `bounded-markup.ts` documents the measurements and the semantics preserved.

/** Inventory `<path …>` openings, keeping the old positional fallback id. */
function svgPathElements(sourceText: string): Array<{ id: string; attrs: Record<string, string> }> {
  return svgTagAttrs(sourceText, "path").map((attrs, index) => ({ id: attrs.id ?? `path-${index + 1}`, attrs }));
}

/** Inventory `<animate>` children of `<path>…</path>` pairs. */
function svgAnimateElements(sourceText: string): Array<{ parentPathId: string; attrs: Record<string, string> }> {
  const animations: Array<{ parentPathId: string; attrs: Record<string, string> }> = [];
  for (const pair of scanMarkupTagPairs(sourceText, "path")) {
    const pathAttrs = svgAttrs(pair.attrText);
    const parentPathId = pathAttrs.id ?? `path-${animations.length + 1}`;
    for (const animate of scanMarkupOpenTags(pair.innerText, "animate")) {
      animations.push({ parentPathId, attrs: svgAttrs(animate.attrText) });
    }
  }
  return animations;
}

/** Inventory ids of a named element (`filter`, `mask`), with the same fallback naming as before. */
function svgElementIds(sourceText: string, elementName: string): string[] {
  return svgTagAttrs(sourceText, elementName).map((attrs, index) => attrs.id ?? `${elementName}-${index + 1}`);
}

/** Attribute maps for every opening tag with the given name, in document order. */
function svgTagAttrs(sourceText: string, elementName: string): Array<Record<string, string>> {
  return scanMarkupOpenTags(sourceText, elementName).map((tag) => svgAttrs(tag.attrText));
}

/** Read quoted attributes from an opening tag's attribute text; duplicates keep the last value. */
function svgAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attribute of scanMarkupAttributes(text)) attrs[attribute.name] = attribute.value;
  return attrs;
}

function dedupeFeatures(features: AdapterDiagnosticFeature[]): AdapterDiagnosticFeature[] {
  if (features.length > 4_096) throw new Error("Adapter diagnostics exceed the 4096-feature output limit.");
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = `${feature.status}:${feature.path}:${feature.feature}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
