import {
  createIntegrationEnvelope,
  hashBuffer,
  packageRenderLineageInputHashes,
  requiredLayerFeatures,
  validatePackageRenderLineage,
  type MotionLayer,
  type MotionMarker,
  type MotionPackage,
  type MotionSafeArea,
  type MotionScene,
  type MotionTrack,
  type OperationReceipt,
  type AttestedArtifactHandleReference,
  type ShellXIntegrationEnvelope
} from "@shellx-motion/core";
import {
  CUT_EDITABLE_RECEIVER_SLICE,
  CUT_ACCEPTED_KEYFRAME_TRACKS,
  CUT_ACCEPTED_PAYLOAD_KEYS,
  CUT_ACCEPTED_STYLE_KEYS,
  CUT_ACCEPTED_TRANSFORM_KEYS,
  CUT_ACCEPTED_TRANSITION_KEYS,
  unacceptedKeys,
  violatesIdentityTransform
} from "./editable-receiver-allowlist.js";
import { cutRootStoreRefusalInput, cutRootStoreRefusalInputHashes, cutRootStoreUnsupported, type CutRootStoreRefusalInput } from "./scene3d-animation-admission.js";

export type CutImportMode = "rendered_media" | "live_overlay" | "editable_lowering";
export type CutLowerableLayerType = "text" | "shape" | "caption" | "image" | "video" | "audio";

export interface CutTargetCapabilities {
  targetId: string;
  modes: CutImportMode[];
  lowerableLayerTypes: CutLowerableLayerType[];
  lowerableFeatures?: string[];
  /**
   * Which editable receiver this target runs, if any.
   *
   * A receiver is an allow-list: it names the exact payload fields it will accept and rejects
   * everything else. Declaring it lets the planner check a lowering against that field set before
   * promising `editable_lowering`, instead of discovering the mismatch when the import fails.
   * Omit it for a target with no such constraint; see `editable-receiver-allowlist.ts`.
   */
  editableReceiver?: string;
}

export type RenderedMediaArtifact =
  | {
      dryRun: true;
      plannedPath: string;
      receiptPath: string;
    }
  | {
      dryRun: false;
      handle: AttestedArtifactHandleReference;
    };

export interface CutUnsupportedFeature {
  layerId: string;
  feature: string;
  reason: string;
}

export interface CutTimelineMetadata {
  tracks?: MotionTrack[];
  scenes?: MotionScene[];
  markers?: MotionMarker[];
}

export interface CutDocumentMetadata {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  background?: string;
  safeAreas?: Record<string, MotionSafeArea>;
}

export type CutImportOperation =
  | {
      verb: "cut.title.create" | "cut.shape.create" | "cut.caption.create" | "cut.media.create" | "cut.audio.create";
      sourceLayerId: string;
      startMs: number;
      durationMs: number;
      payload: Record<string, unknown>;
    }
  | {
      verb: "cut.timeline.track.create";
      sourceTrackId: string;
      payload: Record<string, unknown>;
    }
  | {
      verb: "cut.timeline.scene.create";
      sourceSceneId: string;
      startMs: number;
      durationMs: number;
      payload: Record<string, unknown>;
    }
  | {
      verb: "cut.timeline.marker.create";
      sourceMarkerId: string;
      atMs: number;
      durationMs?: number;
      payload: Record<string, unknown>;
    }
  | {
      verb: "cut.media.import_rendered";
      source: { packageId: string; motionId: string; render: "required" | "dry_run" | "artifact" };
      startMs: number;
      durationMs: number;
      track?: string;
      media: { width: number; height: number; fps: number };
      renderedMedia?: RenderedMediaArtifact;
    }
  | {
      verb: "cut.motion_overlay.create";
      source: { packageId: string; motionId: string };
      startMs: number;
      durationMs: number;
      overlay: { width: number; height: number; fps: number };
    };

export interface CutImportPlan {
  schema: "shellx-motion/cut-import-plan@1";
  integration: ShellXIntegrationEnvelope;
  ok: boolean;
  packageId: string;
  motionId: string;
  targetId: string;
  mode: CutImportMode | null;
  operations: CutImportOperation[];
  unsupported: CutUnsupportedFeature[];
  document: CutDocumentMetadata;
  timeline?: CutTimelineMetadata;
  receipt: OperationReceipt;
}
export interface CutRenderedMediaPlacement {
  startMs?: number;
  durationMs?: number;
  track?: string;
}

export function planCutImport(pkg: MotionPackage, targetCapabilities: CutTargetCapabilities): CutImportPlan {
  const rootStoreUnsupported = cutRootStoreUnsupported(pkg); if (rootStoreUnsupported) { const refusalInput = cutRootStoreRefusalInput(pkg); return buildPlan(refusalInput.pkg, targetCapabilities, null, [], rootStoreUnsupported, refusalInput); }
  if (hasWebLayer(pkg)) {
    const requirements = webLayerRequirements(pkg);
    return targetCapabilities.modes.includes("rendered_media")
      ? buildPlan(pkg, targetCapabilities, "rendered_media", [renderedMediaOperation(pkg)], requirements)
      : buildPlan(pkg, targetCapabilities, null, [], requirements);
  }

  let editableUnsupported: CutUnsupportedFeature[] = [];
  if (targetCapabilities.modes.includes("editable_lowering")) {
    editableUnsupported = editableUnsupportedFeatures(pkg, targetCapabilities);
    if (editableUnsupported.length === 0) {
      return buildPlan(pkg, targetCapabilities, "editable_lowering", editableOperations(pkg), []);
    }

    if (!targetCapabilities.modes.includes("live_overlay") && !targetCapabilities.modes.includes("rendered_media")) {
      return buildPlan(pkg, targetCapabilities, null, [], editableUnsupported);
    }
  }

  if (targetCapabilities.modes.includes("live_overlay")) {
    return buildPlan(pkg, targetCapabilities, "live_overlay", [liveOverlayOperation(pkg)], editableUnsupported);
  }

  if (targetCapabilities.modes.includes("rendered_media")) {
    return buildPlan(pkg, targetCapabilities, "rendered_media", [renderedMediaOperation(pkg)], editableUnsupported);
  }

  return buildPlan(pkg, targetCapabilities, null, [], [
    {
      layerId: "*",
      feature: "target.modes",
      reason: `Target ${targetCapabilities.targetId} does not support rendered_media, live_overlay, or editable_lowering import modes.`
    }
  ]);
}
export function attachRenderedMediaToCutPlan(plan: CutImportPlan, artifact: RenderedMediaArtifact): CutImportPlan {
  if (!artifact.dryRun && artifact.handle.packageLineage) validatePackageRenderLineage(artifact.handle.packageLineage);
  const operations = plan.operations.map((operation): CutImportOperation => {
    if (operation.verb !== "cut.media.import_rendered") return operation;
    return {
      ...operation,
      source: {
        ...operation.source,
        render: artifact.dryRun ? "dry_run" : "artifact"
      },
      renderedMedia: { ...artifact }
    };
  });
  const outputRecord = readRecord(plan.receipt.output);
  const output = outputRecord
    ? { ...outputRecord, renderedMedia: { ...artifact } }
    : { renderedMedia: { ...artifact } };

  return {
    ...plan,
    operations,
    receipt: {
      ...plan.receipt,
      ...(!artifact.dryRun ? {
        id: attachedRenderedMediaReceiptId(plan, artifact.handle),
        inputHashes: {
          ...plan.receipt.inputHashes,
          artifactDescriptorSha256: artifact.handle.sha256,
          artifactOperationHash: artifact.handle.operationHash,
          ...(artifact.handle.packageLineage ? packageRenderLineageInputHashes(artifact.handle.packageLineage) : {})
        }
      } : {}),
      output
    }
  };
}
function attachedRenderedMediaReceiptId(plan: CutImportPlan, handle: AttestedArtifactHandleReference): string {
  const lineage = handle.packageLineage;
  const commitment = {
    packageId: plan.packageId,
    motionId: plan.motionId,
    mode: plan.mode,
    artifactDescriptorSha256: handle.sha256,
    artifactOperationHash: handle.operationHash,
    ...(lineage ? {
      packageLineage: {
        schema: lineage.schema,
        ...(lineage.adapterId ? { adapterId: lineage.adapterId } : {}),
        ...packageRenderLineageInputHashes(lineage)
      }
    } : {})
  };
  return `cut-import-${hashBuffer(Buffer.from(JSON.stringify(commitment), "utf8")).slice(0, 16)}`;
}

export function placeRenderedMediaInCutPlan(
  plan: CutImportPlan,
  placement: CutRenderedMediaPlacement
): CutImportPlan {
  const startMs = placement.startMs;
  const durationMs = placement.durationMs;
  const track = placement.track?.trim();
  if (startMs !== undefined && (!Number.isSafeInteger(startMs) || startMs < 0)) {
    throw new Error("Cut rendered-media placement startMs must be a non-negative safe integer.");
  }
  if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs <= 0)) {
    throw new Error("Cut rendered-media placement durationMs must be a positive safe integer.");
  }
  if (placement.track !== undefined && !track) {
    throw new Error("Cut rendered-media placement track must be a non-empty string.");
  }
  const operations = plan.operations.map((operation): CutImportOperation => {
    if (operation.verb !== "cut.media.import_rendered") return operation;
    return {
      ...operation,
      ...(startMs !== undefined ? { startMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(track ? { track } : {})
    };
  });
  const normalizedPlacement = {
    ...(startMs !== undefined ? { startMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(track ? { track } : {})
  };
  const output = readRecord(plan.receipt.output);
  return {
    ...plan,
    operations,
    receipt: {
      ...plan.receipt,
      inputHashes: {
        ...plan.receipt.inputHashes,
        placement: hashBuffer(Buffer.from(JSON.stringify(normalizedPlacement), "utf8"))
      },
      output: {
        ...(output ?? {}),
        placement: normalizedPlacement
      }
    }
  };
}

function editableOperations(pkg: MotionPackage): CutImportOperation[] {
  const layerOperations = pkg.motion.layers.map((layer) => {
    if (layer.type === "text") {
      return lowerTextLayer(layer, pkg);
    }
    if (layer.type === "shape") {
      return lowerShapeLayer(layer, pkg);
    }
    if (layer.type === "caption") {
      return lowerCaptionLayer(layer, pkg);
    }
    if (layer.type === "image") {
      return lowerImageLayer(layer, pkg);
    }
    if (layer.type === "video") {
      return lowerVideoLayer(layer, pkg);
    }
    if (layer.type === "audio") {
      return lowerAudioLayer(layer, pkg);
    }
    throw new Error(`Unsupported editable layer type: ${layer.type}`);
  });
  return [...timelineOperations(pkg), ...layerOperations];
}

function timelineOperations(pkg: MotionPackage): CutImportOperation[] {
  return [
    ...(pkg.motion.tracks ?? []).map(lowerTrack),
    ...(pkg.motion.scenes ?? []).map(lowerScene),
    ...(pkg.motion.markers ?? []).map(lowerMarker)
  ];
}

function lowerTrack(track: MotionTrack): CutImportOperation {
  const { id, ...payload } = track as MotionTrack & Record<string, unknown>;
  return {
    verb: "cut.timeline.track.create",
    sourceTrackId: id,
    payload: compactRecord(payload)
  };
}

function lowerScene(scene: MotionScene): CutImportOperation {
  const { id, startMs, durationMs, ...payload } = scene as MotionScene & Record<string, unknown>;
  return {
    verb: "cut.timeline.scene.create",
    sourceSceneId: id,
    startMs,
    durationMs,
    payload: compactRecord(payload)
  };
}

function lowerMarker(marker: MotionMarker): CutImportOperation {
  const { id, atMs, durationMs, ...payload } = marker as MotionMarker & Record<string, unknown>;
  return {
    verb: "cut.timeline.marker.create",
    sourceMarkerId: id,
    atMs,
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    payload: compactRecord(payload)
  };
}

function lowerTextLayer(layer: MotionLayer, pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.title.create",
    sourceLayerId: layer.id,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    payload: {
      text: readString(layer.text) ?? "",
      ...trackPayload(layer),
      ...layerStatePayload(layer),
      ...transitionPayload(layer),
      ...maskPayload(layer),
      ...effectsPayload(layer),
      transform: loweredTransform(layer),
      style: resolveTokenValues(readRecord(layer.style), pkg.motion.designTokens)
    }
  };
}

function lowerShapeLayer(layer: MotionLayer, pkg: MotionPackage): CutImportOperation {
  const sourceShape = readString(layer.shape) ?? "rect";
  const shape = sourceShape === "rectangle"
    ? "rect"
    : sourceShape === "freeform" && shapePathPayload(layer).path
      ? "path"
      : sourceShape;
  const transform = loweredTransform(layer);
  return {
    verb: "cut.shape.create",
    sourceLayerId: layer.id,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    payload: {
      shape,
      ...trackPayload(layer),
      ...layerStatePayload(layer),
      ...(typeof layer.fill === "string" ? { fill: layer.fill } : {}),
      ...(typeof layer.color === "string" ? { color: layer.color } : {}),
      ...shapePathPayload(layer),
      ...transitionPayload(layer),
      ...maskPayload(layer),
      ...effectsPayload(layer),
      transform: {
        ...transform,
        ...(typeof transform.width !== "number" && typeof layer.width === "number" ? { width: layer.width } : {}),
        ...(typeof transform.height !== "number" && typeof layer.height === "number" ? { height: layer.height } : {})
      },
      style: resolveTokenValues(readRecord(layer.style), pkg.motion.designTokens)
    }
  };
}

function lowerCaptionLayer(layer: MotionLayer, pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.caption.create",
    sourceLayerId: layer.id,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    payload: {
      text: readString(layer.text) ?? "",
      ...trackPayload(layer),
      ...layerStatePayload(layer),
      ...transitionPayload(layer),
      ...maskPayload(layer),
      ...effectsPayload(layer),
      transform: loweredTransform(layer),
      style: resolveTokenValues(readRecord(layer.style), pkg.motion.designTokens)
    }
  };
}

function shapePathPayload(layer: MotionLayer): Record<string, unknown> {
  const path = readString(layer["x-path"]) ?? readString(readRecord(layer.style).path);
  return path ? { path } : {};
}

function mediaFit(layer: MotionLayer, fallback: string): string {
  const style = readRecord(layer.style);
  return readString(layer.fit) ?? readString(style.objectFit) ?? readString(style.fit) ?? fallback;
}

function lowerImageLayer(layer: MotionLayer, pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.media.create",
    sourceLayerId: layer.id,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    payload: {
      source: readImageSource(layer, pkg),
      ...trackPayload(layer),
      ...layerStatePayload(layer),
      fit: mediaFit(layer, "cover"),
      ...(typeof layer.width === "number" ? { width: layer.width } : {}),
      ...(typeof layer.height === "number" ? { height: layer.height } : {}),
      ...cropPayload(layer),
      ...transitionPayload(layer),
      ...maskPayload(layer),
      ...effectsPayload(layer),
      transform: normalizeImageTransform(loweredTransform(layer)),
      style: resolveTokenValues(readRecord(layer.style), pkg.motion.designTokens)
    }
  };
}

function lowerVideoLayer(layer: MotionLayer, pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.media.create",
    sourceLayerId: layer.id,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    payload: {
      kind: "video",
      source: readMediaSource(layer, pkg),
      ...trackPayload(layer),
      ...layerStatePayload(layer),
      fit: mediaFit(layer, "cover"),
      ...(typeof layer.width === "number" ? { width: layer.width } : {}),
      ...(typeof layer.height === "number" ? { height: layer.height } : {}),
      ...cropPayload(layer),
      ...(typeof layer.trimStartMs === "number" ? { trimStartMs: layer.trimStartMs } : {}),
      ...(typeof layer.trimDurationMs === "number" ? { trimDurationMs: layer.trimDurationMs } : {}),
      ...(typeof layer.loop === "boolean" ? { loop: layer.loop } : {}),
      ...(typeof layer.playbackRate === "number" ? { playbackRate: layer.playbackRate } : {}),
      ...(typeof layer.includeAudio === "boolean" ? { includeAudio: layer.includeAudio } : {}),
      ...audioControlPayload(layer),
      ...transitionPayload(layer),
      ...maskPayload(layer),
      ...effectsPayload(layer),
      transform: normalizeImageTransform(loweredTransform(layer)),
      style: resolveTokenValues(readRecord(layer.style), pkg.motion.designTokens)
    }
  };
}

function lowerAudioLayer(layer: MotionLayer, pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.audio.create",
    sourceLayerId: layer.id,
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    payload: {
      source: readMediaSource(layer, pkg),
      ...(typeof layer.trimStartMs === "number" ? { trimStartMs: layer.trimStartMs } : {}),
      ...(typeof layer.trimDurationMs === "number" ? { trimDurationMs: layer.trimDurationMs } : {}),
      ...(typeof layer.loop === "boolean" ? { loop: layer.loop } : {}),
      ...(typeof layer.playbackRate === "number" ? { playbackRate: layer.playbackRate } : {}),
      ...audioControlPayload(layer)
    }
  };
}

function trackPayload(layer: MotionLayer): { trackId?: string } {
  return typeof layer.trackId === "string" ? { trackId: layer.trackId } : {};
}

/**
 * The transform Cut is given, with `opacity` lifted out.
 *
 * Some sources (the Canvas adapter among them) carry opacity inside the transform record. Cut
 * reads opacity at the payload level and rejects it inside `transform`, so passing it through
 * verbatim cost editability for a value Cut was perfectly willing to accept one level up.
 */
function loweredTransform(layer: MotionLayer): Record<string, unknown> {
  const transform = readRecord(layer.transform);
  if (!("opacity" in transform)) return transform;
  const { opacity: _lifted, ...rest } = transform;
  return rest;
}

/** Layer opacity, preferring an explicit layer value over one carried inside the transform. */
function loweredOpacity(layer: MotionLayer): number | undefined {
  if (typeof layer.opacity === "number") return layer.opacity;
  const transformOpacity = readRecord(layer.transform).opacity;
  return typeof transformOpacity === "number" ? transformOpacity : undefined;
}

function layerStatePayload(layer: MotionLayer): { opacity?: number; keyframes?: Record<string, unknown>; blendMode?: string } {
  const keyframes = readRecord(layer.keyframes);
  return {
    ...(loweredOpacity(layer) !== undefined ? { opacity: loweredOpacity(layer) } : {}),
    // "normal" is the identity blend: emitting it changes nothing about the result but puts a
    // field in the payload that Cut's allow-list receiver rejects outright, costing editability
    // for no fidelity. Any other blend mode is emitted and correctly reported as unsupported.
    ...(typeof layer.blendMode === "string" && layer.blendMode !== "normal" ? { blendMode: layer.blendMode } : {}),
    ...(Object.keys(keyframes).length > 0 ? { keyframes } : {})
  };
}

function audioControlPayload(layer: MotionLayer): Record<string, unknown> {
  return {
    ...(typeof layer.volume === "number" ? { volume: layer.volume } : {}),
    ...(typeof layer.pan === "number" ? { pan: layer.pan } : {}),
    ...(typeof layer.muted === "boolean" ? { muted: layer.muted } : {}),
    ...(typeof layer.fadeInMs === "number" ? { fadeInMs: layer.fadeInMs } : {}),
    ...(typeof layer.fadeOutMs === "number" ? { fadeOutMs: layer.fadeOutMs } : {}),
    ...(typeof layer.normalizeLoudness === "boolean" ? { normalizeLoudness: layer.normalizeLoudness } : {})
  };
}

function transitionPayload(layer: MotionLayer): { transitions?: Record<string, unknown> } {
  const transitions = readRecord(layer.transitions);
  return Object.keys(transitions).length > 0 ? { transitions } : {};
}

function maskPayload(layer: MotionLayer): { mask?: Record<string, unknown> } {
  const mask = readRecord(layer.mask);
  return Object.keys(mask).length > 0 ? { mask } : {};
}

function cropPayload(layer: MotionLayer): { crop?: Record<string, unknown> } {
  const crop = readRecord(layer.crop);
  return Object.keys(crop).length > 0 ? { crop } : {};
}

function effectsPayload(layer: MotionLayer): { effects?: Record<string, unknown> } {
  const effects = readRecord(layer.effects);
  return Object.keys(effects).length > 0 ? { effects } : {};
}

function renderedMediaOperation(pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.media.import_rendered",
    source: { packageId: pkg.manifest.id, motionId: pkg.motion.id, render: "required" },
    startMs: 0,
    durationMs: pkg.motion.durationMs,
    media: { width: pkg.motion.width, height: pkg.motion.height, fps: pkg.motion.fps }
  };
}

function liveOverlayOperation(pkg: MotionPackage): CutImportOperation {
  return {
    verb: "cut.motion_overlay.create",
    source: { packageId: pkg.manifest.id, motionId: pkg.motion.id },
    startMs: 0,
    durationMs: pkg.motion.durationMs,
    overlay: { width: pkg.motion.width, height: pkg.motion.height, fps: pkg.motion.fps }
  };
}

function hasWebLayer(pkg: MotionPackage): boolean {
  return pkg.motion.layers.some((layer) => isBrowserLayer(layer));
}

function webLayerRequirements(pkg: MotionPackage): CutUnsupportedFeature[] {
  return pkg.motion.layers
    .filter((layer) => isBrowserLayer(layer))
    .map((layer) => ({
      layerId: layer.id,
      feature: `layer.type:${layer.type}`,
      reason: `Layer ${layer.id} uses browser-rendered ${layer.type} content; Cut import requires rendered_media mode.`
    }));
}

function isBrowserLayer(layer: MotionLayer): boolean {
  return layer.type === "web" || layer.type === "html" || layer.type === "canvas";
}

function editableUnsupportedFeatures(pkg: MotionPackage, targetCapabilities: CutTargetCapabilities): CutUnsupportedFeature[] {
  const supportedFeatures = targetCapabilities.lowerableFeatures;
  const documentUnsupported: CutUnsupportedFeature[] = [];
  if (supportedFeatures) {
    for (const [feature, present] of [
      ["timeline.tracks", (pkg.motion.tracks?.length ?? 0) > 0],
      ["timeline.scenes", (pkg.motion.scenes?.length ?? 0) > 0],
      ["timeline.markers", (pkg.motion.markers?.length ?? 0) > 0],
      ["document.safeAreas", Object.keys(pkg.motion.safeAreas ?? {}).length > 0]
    ] as const) {
      if (present && !featureSupportedByTarget(feature, supportedFeatures)) {
        documentUnsupported.push({
          layerId: "*",
          feature,
          reason: `Target ${targetCapabilities.targetId} cannot lower ${feature} to editable Cut operations.`
        });
      }
    }
    if (readString(pkg.motion.background) && !featureSupportedByTarget("document.background", supportedFeatures)) {
      documentUnsupported.push({
        layerId: "*",
        feature: "document.background",
        reason: `Target ${targetCapabilities.targetId} cannot preserve the Motion document background in editable Cut operations.`
      });
    }
    const background = readString(pkg.motion.background);
    if (background && !isHexRgb(background)) {
      documentUnsupported.push({
        layerId: "*",
        feature: "document.background.colorFormat",
        reason: `Target ${targetCapabilities.targetId} cannot preserve Motion document background color ${background} in editable Cut operations.`
      });
    }
    const nativeVideoLayers = pkg.motion.layers.filter((layer) => layer.type === "video");
    if (background && nativeVideoLayers.length > 0) {
      documentUnsupported.push({
        layerId: "*",
        feature: "document.background.videoConflict",
        reason: `Target ${targetCapabilities.targetId} cannot preserve a document background below a native Cut video layer yet.`
      });
    }
    if (nativeVideoLayers.length > 1) {
      documentUnsupported.push({
        layerId: "*",
        feature: "video.layerCount",
        reason: `Target ${targetCapabilities.targetId} currently lowers one Cut-origin video layer per editable plan.`
      });
    }
  }

  const layerUnsupported = pkg.motion.layers.flatMap((layer) => {
    const lowerableLayerType = readLowerableLayerType(layer.type);
    if (!lowerableLayerType || !targetCapabilities.lowerableLayerTypes.includes(lowerableLayerType)) {
      return [
        {
          layerId: layer.id,
          feature: `layer.type:${layer.type}`,
          reason: `Target ${targetCapabilities.targetId} cannot lower ${layer.type} layers to editable Cut operations.`
        }
      ];
    }

    const mediaSourceUnsupported = editableMediaSourceUnsupported(layer);
    if (mediaSourceUnsupported) return [mediaSourceUnsupported];

    if (!supportedFeatures) return [];

    return [...requiredLayerFeatures(layer), ...requiredCutPayloadFeatures(layer)]
      .filter((feature, index, features) => features.indexOf(feature) === index)
      .filter((feature) => !featureSupportedByTarget(feature, supportedFeatures))
      .map((feature) => ({
        layerId: layer.id,
        feature,
        reason: `Target ${targetCapabilities.targetId} cannot lower ${feature} on layer ${layer.id}.`
      }));
  });
  // The deny-list above only names features Motion already knows Cut refuses. Cut's receiver is
  // an allow-list, so anything Motion has not thought about would still be claimed supported and
  // then hard-rejected on arrival. This final pass inspects the operations Motion would actually
  // emit and reports every field the receiver would refuse.
  const declared = [...documentUnsupported, ...layerUnsupported];
  const receiverUnsupported = editableReceiverUnsupported(pkg, targetCapabilities)
    // The deny-list above and the receiver check can reach the same conclusion by different
    // routes (a target that cannot lower text.style.fontFamily also has a receiver that rejects
    // the field). Report the limitation once: two entries for one problem read as two problems.
    .filter((entry) => !declared.some((existing) =>
      existing.layerId === entry.layerId && featureTail(existing.feature) === featureTail(entry.feature)));
  return [...declared, ...receiverUnsupported];
}

/** The last two dot-segments of a feature id, which is the part naming the actual field. */
function featureTail(feature: string): string {
  return feature.split(".").slice(-2).join(".");
}

/**
 * Check the lowered operations against what Cut's editable receiver actually accepts.
 *
 * This is what turns Motion from a deny-list producer into an allow-list one. Every entry it
 * returns is a payload Cut would reject with "contains an unknown field", so reporting it here
 * degrades the plan to rendered_media instead of promising editability that fails on arrival.
 */
function editableReceiverUnsupported(
  pkg: MotionPackage,
  targetCapabilities: CutTargetCapabilities
): CutUnsupportedFeature[] {
  // Only meaningful for a target that declares which receiver it runs. The field sets below
  // describe ShellX Cut's receiver specifically; a different host has a different one.
  if (targetCapabilities.editableReceiver !== CUT_EDITABLE_RECEIVER_SLICE) return [];
  let operations: CutImportOperation[];
  try {
    operations = editableOperations(pkg);
  } catch {
    // A layer type with no lowering at all is already reported by the layer-type check above.
    return [];
  }
  const unsupported: CutUnsupportedFeature[] = [];
  for (const operation of operations) {
    const acceptedPayload = CUT_ACCEPTED_PAYLOAD_KEYS[operation.verb];
    if (!acceptedPayload) continue;
    // The operation union also carries timeline and rendered-media shapes with no payload; only
    // the layer-lowering verbs named in the allow-list reach here.
    const layerOperation = operation as { sourceLayerId?: string; payload?: unknown };
    const layerId = layerOperation.sourceLayerId ?? "*";
    const payload = readRecord(layerOperation.payload);
    const report = (feature: string, detail: string) => {
      unsupported.push({
        layerId,
        feature,
        reason: `Target ${targetCapabilities.targetId} rejects ${detail} on layer ${layerId}; its editable receiver accepts a fixed field set.`
      });
    };
    for (const key of unacceptedKeys(payload, acceptedPayload)) {
      report(`cut.payload.${key}`, `payload field "${key}"`);
    }
    for (const [nested, accepted] of [
      ["transform", CUT_ACCEPTED_TRANSFORM_KEYS[operation.verb]],
      ["style", CUT_ACCEPTED_STYLE_KEYS[operation.verb]]
    ] as const) {
      if (!accepted) continue;
      for (const key of unacceptedKeys(readRecord(payload[nested]), accepted)) {
        report(`cut.${nested}.${key}`, `${nested} field "${key}"`);
      }
    }
    for (const key of unacceptedKeys(readRecord(payload.keyframes), CUT_ACCEPTED_KEYFRAME_TRACKS)) {
      report(`cut.keyframes.${key}`, `keyframe track "${key}"`);
    }
    for (const key of unacceptedKeys(readRecord(payload.transitions), CUT_ACCEPTED_TRANSITION_KEYS)) {
      report(`cut.transitions.${key}`, `transition slot "${key}"`);
    }
    // scale and rotation are accepted keys but must hold identity values.
    const identity = violatesIdentityTransform(readRecord(payload.transform));
    if (identity) {
      report(`cut.transform.${identity}.identity`, `a non-identity transform.${identity}`);
    }
  }
  return unsupported;
}

function requiredCutPayloadFeatures(layer: MotionLayer): string[] {
  const features: string[] = [];
  const transform = readRecord(layer.transform);
  const scale = typeof transform.scale === "number" && Number.isFinite(transform.scale) ? transform.scale : null;
  if (scale !== null && scale !== 1) features.push("transform.scale");
  if (typeof layer.trackId === "string") features.push("timeline.track");
  if (typeof layer.opacity === "number") features.push("layer.opacity");

  if (layer.type === "text" || layer.type === "caption") {
    if (typeof transform.x !== "number" || typeof transform.y !== "number") {
      features.push("text.position.required");
    }
    if (typeof layer.width === "number" || typeof layer.height === "number"
      || typeof transform.width === "number" || typeof transform.height === "number") {
      features.push("text.box");
    }
    const style = readRecord(layer.style);
    if (typeof style.fontSize !== "number" || style.fontSize < 1 || style.fontSize > 512) {
      features.push("text.fontSize.requiredRange");
    }
    if (typeof style.color !== "string") {
      features.push("text.color.required");
    }
    const baseline = new Set(["color", "fontSize"]);
    for (const key of Object.keys(style)) {
      if (!baseline.has(key)) features.push(`text.style.${key}`);
    }
  }

  if (layer.type === "shape") {
    const style = readRecord(layer.style);
    const width = typeof transform.width === "number" ? transform.width : layer.width;
    const height = typeof transform.height === "number" ? transform.height : layer.height;
    if (typeof transform.x !== "number" || typeof transform.y !== "number"
      || typeof width !== "number" || typeof height !== "number") {
      features.push("shape.geometry.required");
    }
    const baseline = new Set(["fill", "stroke", "strokeWidth", "radius", "opacity"]);
    for (const key of Object.keys(style)) {
      if (!baseline.has(key)) features.push(`shape.style.${key}`);
    }
  }
  if (layer.type === "video") {
    const source = readString(layer.assetRef) ?? readString(layer.source) ?? readString(layer.src) ?? "";
    if (!/^cut-asset:[A-Za-z0-9_-]{1,128}$/.test(source)) features.push("video.source.cutAssetRef");
    const fit = (readString(layer.fit) ?? readString(readRecord(layer.style).objectFit) ?? "cover").trim().toLowerCase();
    if (fit !== "cover") features.push(`video.fit.${fit || "missing"}`);
    if (typeof layer.width === "number" || typeof layer.height === "number") features.push("video.explicitDimensions");
    const allowedTransform = new Set(["scale", "rotation"]);
    for (const key of Object.keys(transform)) {
      if (!allowedTransform.has(key)) features.push(`video.transform.${key}`);
    }
    for (const key of Object.keys(readRecord(layer.style))) features.push(`video.style.${key}`);
    if (typeof layer.trimDurationMs === "number" && layer.trimDurationMs !== layer.durationMs) {
      features.push("video.trimDuration.timelineMismatch");
    }
  }
  if (layer.type === "audio") {
    const source = readString(layer.assetRef) ?? readString(layer.source) ?? readString(layer.src) ?? "";
    if (!/^cut-asset:[A-Za-z0-9_-]{1,128}$/.test(source)) features.push("audio.source.cutAssetRef");
    if (typeof layer.trimDurationMs === "number" && layer.trimDurationMs !== layer.durationMs) {
      features.push("audio.trimDuration.timelineMismatch");
    }
  }
  const opacityFrames = readRecord(layer.keyframes).opacity;
  if (Array.isArray(opacityFrames) && opacityFrames.length > 1) {
    const interps = opacityFrames.slice(0, -1).map((frame) => cutKeyframeInterp(readRecord(frame).easing));
    if (interps.some((interp) => interp === null)
      || interps.some((interp) => interp !== interps[0])) {
      features.push("keyframe.opacity.uniformEasing");
    }
  }
  for (const target of ["transform.x", "transform.y"] as const) {
    const frames = readRecord(layer.keyframes)[target];
    if (!Array.isArray(frames) || frames.length <= 1) continue;
    const interps = frames.slice(0, -1).map((frame) => cutKeyframeInterp(readRecord(frame).easing));
    if (interps.some((interp) => interp === null)
      || interps.some((interp) => interp !== interps[0])) {
      features.push(`keyframe.${target}.uniformEasing`);
    }
  }
  features.push(...requiredCutFadeFeatures(layer, opacityFrames));
  for (const color of cutLayerColors(layer)) {
    if (!isHexRgb(color)) features.push("color.extendedFormat");
  }
  return features;
}

function requiredCutFadeFeatures(layer: MotionLayer, opacityFrames: unknown): string[] {
  const transitions = readRecord(layer.transitions);
  const fades = (["in", "out"] as const)
    .map((edge) => ({ edge, value: readRecord(transitions[edge]) }))
    .filter(({ value }) => readString(value.type) === "fade");
  if (fades.length === 0) return [];

  const features: string[] = [];
  if (Array.isArray(opacityFrames) && opacityFrames.length > 0) {
    features.push("transition.fade.opacityKeyframesConflict");
  }
  const durations = fades.map(({ value }) => readFiniteNumber(value.durationMs));
  if (durations.some((duration) => duration === null || duration <= 0 || !Number.isInteger(duration))) {
    features.push("transition.fade.timing");
  } else if ((durations as number[]).reduce((total, duration) => total + duration, 0) > layer.durationMs) {
    // Motion multiplies overlapping fades; one Cut opacity track cannot encode
    // that nonlinear overlap without baking or approximation.
    features.push("transition.fade.overlap");
  }
  const interps = fades.map(({ value }) => cutFadeInterp(value.easing));
  if (interps.some((interp) => interp === null)) {
    features.push("transition.fade.easing");
  } else if (interps.some((interp) => interp !== interps[0])) {
    features.push("transition.fade.uniformEasing");
  }
  return features;
}

function cutLayerColors(layer: MotionLayer): string[] {
  const style = readRecord(layer.style);
  return [layer.fill, layer.color, style.fill, style.stroke, style.color]
    .filter((value): value is string => typeof value === "string");
}

function isHexRgb(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function cutKeyframeInterp(value: unknown): string | null {
  if (value === undefined || value === "linear") return "linear";
  if (value === "hold") return "hold";
  if (value === "ease-in") return "ease_in_quad";
  if (value === "ease-out") return "ease_out_quad";
  if (value === "ease-in-out") return "ease_in_out_quad";
  if (value === "back-out") return "ease_out_back";
  if (value === "bounce-out") return "ease_out_bounce";
  return null;
}

function cutFadeInterp(value: unknown): string | null {
  const interp = cutKeyframeInterp(value);
  // Motion clamps a back-out fade multiplier before applying base opacity,
  // while Cut's track interpolation can overshoot the base value.
  return interp === "ease_out_back" ? null : interp;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function editableMediaSourceUnsupported(layer: MotionLayer): CutUnsupportedFeature | null {
  if (layer.type !== "image" && layer.type !== "video" && layer.type !== "audio") return null;
  if (readString(layer.assetRef) || readString(layer.source) || readString(layer.src) || readString(layer.assetId)) return null;
  return {
    layerId: layer.id,
    feature: "media.source",
    reason: `Layer ${layer.id} cannot lower to editable Cut media because it has no assetRef, source, src, or assetId.`
  };
}

function buildPlan(
  pkg: MotionPackage,
  targetCapabilities: CutTargetCapabilities,
  mode: CutImportMode | null,
  operations: CutImportOperation[],
  unsupported: CutUnsupportedFeature[],
  refusalInput?: CutRootStoreRefusalInput,
): CutImportPlan {
  // `unsupported` describes features that could not be represented by the preferred editable
  // lowering. A selected rendered-media/live-overlay operation still imports the whole package
  // faithfully, so those rows are diagnostic fallback reasons rather than plan blockers.
  const ok = mode !== null;
  const document = documentMetadata(pkg);
  const timeline = timelineMetadata(pkg);
  const timelineOutput = timeline ? timelineReceiptOutput(timeline) : undefined;
  const output = {
    mode,
    targetId: targetCapabilities.targetId,
    operationCount: operations.length,
    unsupportedCount: unsupported.length,
    document,
    ...(timelineOutput ? { timeline: timelineOutput } : {})
  };
  return {
    schema: "shellx-motion/cut-import-plan@1",
    integration: createIntegrationEnvelope({
      producer: "shellx-motion",
      consumer: "shellx-cut",
      mode: "cut.import.plan",
      payloadSchema: "shellx-motion/cut-import-plan@1",
      requiredFeatures: ["artifact.attestation"]
    }),
    ok,
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    targetId: targetCapabilities.targetId,
    mode,
    operations,
    unsupported,
    document,
    ...(timeline ? { timeline } : {}),
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: `cut-import-${hashBuffer(Buffer.from(JSON.stringify({ packageId: pkg.manifest.id, motionId: pkg.motion.id, mode, output }))).slice(0, 16)}`,
      operation: "cut.import.plan",
      status: ok ? "passed" : "failed",
      packageId: pkg.manifest.id,
      inputHashes: {
        ...(refusalInput?.rootDescriptorEvidence ? cutRootStoreRefusalInputHashes(refusalInput.rootDescriptorEvidence) : { motion: hashBuffer(Buffer.from(JSON.stringify(pkg.motion))) }),
        targetCapabilities: hashBuffer(Buffer.from(JSON.stringify(targetCapabilities)))
      },
      createdAt: new Date().toISOString(),
      lane: "cut",
      output,
      warnings: unsupported.map((item) => item.reason)
    }
  };
}

function documentMetadata(pkg: MotionPackage): CutDocumentMetadata {
  return {
    width: pkg.motion.width,
    height: pkg.motion.height,
    fps: pkg.motion.fps,
    durationMs: pkg.motion.durationMs,
    ...(typeof pkg.motion.background === "string" ? { background: pkg.motion.background } : {}),
    ...(pkg.motion.safeAreas ? { safeAreas: pkg.motion.safeAreas } : {})
  };
}

function timelineMetadata(pkg: MotionPackage): CutTimelineMetadata | null {
  const timeline: CutTimelineMetadata = {
    ...(pkg.motion.tracks && pkg.motion.tracks.length > 0 ? { tracks: pkg.motion.tracks } : {}),
    ...(pkg.motion.scenes && pkg.motion.scenes.length > 0 ? { scenes: pkg.motion.scenes } : {}),
    ...(pkg.motion.markers && pkg.motion.markers.length > 0 ? { markers: pkg.motion.markers } : {})
  };
  return timeline.tracks || timeline.scenes || timeline.markers ? timeline : null;
}

function timelineReceiptOutput(timeline: CutTimelineMetadata): Record<string, unknown> {
  return {
    trackCount: timeline.tracks?.length ?? 0,
    sceneCount: timeline.scenes?.length ?? 0,
    markerCount: timeline.markers?.length ?? 0,
    ...(timeline.tracks ? { tracks: timeline.tracks } : {}),
    ...(timeline.scenes ? { scenes: timeline.scenes } : {}),
    ...(timeline.markers ? { markers: timeline.markers } : {})
  };
}

function readLowerableLayerType(value: string): CutLowerableLayerType | null {
  return value === "text" || value === "shape" || value === "caption" || value === "image" || value === "video" || value === "audio" ? value : null;
}

function featureSupportedByTarget(feature: string, supportedFeatures: string[]): boolean {
  if (supportedFeatures.includes(feature) || supportedFeatures.includes("*")) return true;
  const segments = feature.split(".");
  while (segments.length > 1) {
    segments.pop();
    if (supportedFeatures.includes(`${segments.join(".")}.*`)) return true;
  }
  return false;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readImageSource(layer: MotionLayer, pkg: MotionPackage): string {
  return readMediaSource(layer, pkg);
}

function readMediaSource(layer: MotionLayer, pkg: MotionPackage): string {
  const directRef = readString(layer.assetRef) ?? readString(layer.source) ?? readString(layer.src);
  if (directRef) return directRef;
  const assetId = readString(layer.assetId);
  if (!assetId) return "";
  return findAssetPath(pkg, assetId) ?? assetId;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeImageTransform(transform: Record<string, unknown>): Record<string, unknown> {
  return {
    ...transform,
    scale: typeof transform.scale === "number" ? transform.scale : 1,
    rotation: typeof transform.rotation === "number" ? transform.rotation : 0
  };
}

function findAssetPath(pkg: MotionPackage, assetId: string): string | null {
  for (const asset of pkg.motion.assets) {
    const record = readRecord(asset);
    if (record.id !== assetId) continue;
    const source = readRecord(record.source);
    const path = readString(source.path);
    if (path) return path;
  }
  return null;
}

function resolveTokenValues(value: Record<string, unknown>, tokens: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveTokenValue(entry, tokens)]));
}

function resolveTokenValue(value: unknown, tokens: unknown): unknown {
  if (typeof value === "string") {
    const match = /^\{([A-Za-z0-9_.-]+)\}$/.exec(value);
    return match ? readTokenPath(tokens, match[1]) ?? value : value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return resolveTokenValues(readRecord(value), tokens);
  }
  return value;
}

function readTokenPath(tokens: unknown, path: string): unknown {
  let current = tokens;
  for (const part of path.split(".")) {
    const record = readRecord(current);
    if (!(part in record)) return undefined;
    current = record[part];
  }
  return current;
}

export * from "./editable-receiver-allowlist.js";
