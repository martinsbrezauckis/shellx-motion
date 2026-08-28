import {
  hashBuffer,
  inspectMotionTimeline,
  listMotionAnimationPresets,
  listMotionEasingPresets,
  type MotionPackage
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { booleanArg, positiveIntegerArg, stringArg } from "./args.js";
import {
  dispatchTimelineDurationPolicyCommand,
  readMotionDurationPolicy,
  visibleDurationPolicyState,
  type TimelineDurationPolicyServices
} from "./timeline-duration-policy.js";
import { dispatchTimelineControlCommand, type TimelineControlServices } from "./timeline-controls.js";
import {
  dispatchTimelineScenesMarkersCommand,
  type TimelineScenesMarkersServices
} from "./timeline-scenes-markers.js";
import {
  dispatchTimelineKeyframesBasicCommand,
  type TimelineKeyframesBasicServices
} from "./timeline-keyframes-basic.js";
import {
  dispatchTimelineKeyframesBulkCommand,
  type TimelineKeyframesBulkServices
} from "./timeline-keyframes-bulk.js";
import { dispatchTimelineSpatialPathCommand, type TimelineSpatialPathServices } from "./timeline-spatial-path.js";
import {
  dispatchTimelineStructuralCommand,
  type TimelineStructuralDispatchServices
} from "./timeline-structural-dispatch.js";
import {
  dispatchTimelineLayerPropertiesCommand,
  type TimelineLayerPropertiesServices
} from "./timeline-layer-properties.js";
import { dispatchTimelineCleanupCommand, type TimelineCleanupServices } from "./timeline-cleanup.js";
import { dispatchTimelineTracksCommand, type TimelineTracksServices } from "./timeline-tracks.js";
import { dispatchTimelineAudioMasterCommand, type TimelineAudioMasterServices } from "./timeline-audio-master.js";
import { dispatchTimelineLayerRelationsCommand, type TimelineLayerRelationsServices } from "./timeline-layer-relations.js";
import { dispatchTimelineTransitionsCommand, type TimelineTransitionsServices } from "./timeline-transitions.js";
import { dispatchTimelineCaptionsCommand, type TimelineCaptionsServices } from "./timeline-captions.js";
import { dispatchRevisionTransactionCommands } from "./revision-transaction-dispatch.js";
import { dispatchCheckpointStoryboardRecordLifecycleCommand, type CheckpointStoryboardRecordLifecycleServices } from "./checkpoint-storyboard-record-lifecycle.js";
/**
 * `warnings` is optional because most panels have nothing to say; when a panel builder produces
 * them they must reach the caller rather than dying inside the result body — a panel that knows
 * something is wrong and only whispers it in a nested field is the same silence this surface has
 * already been caught in once.
 */
type PanelRecord = { counts: object; warnings?: string[] };

export interface TimelineDomainServices extends TimelineDurationPolicyServices, TimelineControlServices, TimelineScenesMarkersServices, TimelineKeyframesBasicServices, TimelineKeyframesBulkServices, TimelineSpatialPathServices, TimelineStructuralDispatchServices, TimelineLayerPropertiesServices, TimelineCleanupServices, TimelineTracksServices, TimelineAudioMasterServices, TimelineLayerRelationsServices, TimelineTransitionsServices, TimelineCaptionsServices, CheckpointStoryboardRecordLifecycleServices {
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  readTimelinePanel?: (pkg: MotionPackage) => Promise<{ panel: PanelRecord; playheadMs: number; warnings: string[] }>;
  buildKeyframesPanel?: (pkg: MotionPackage, options: { layerId?: string; target?: string; includeEmpty: boolean }) => PanelRecord;
  buildTransitionsPanel?: (pkg: MotionPackage, options: { layerId?: string; edge?: "in" | "out"; includeEmpty: boolean }) => PanelRecord;
  buildEasingPanel?: (pkg: MotionPackage, sampleCount: number) => PanelRecord;
}

export async function dispatchTimelineCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineDomainServices = {}
): Promise<MotionDebugResult | null> {
  const checkpointStoryboardResult = await dispatchCheckpointStoryboardRecordLifecycleCommand(command, args, services);
  if (checkpointStoryboardResult) return checkpointStoryboardResult;
  const revisionTransaction = await dispatchRevisionTransactionCommands(command, args, services);
  if (revisionTransaction) return revisionTransaction;
  const durationPolicyMutation = await dispatchTimelineDurationPolicyCommand(command, args, services);
  if (durationPolicyMutation) return durationPolicyMutation;
  const controlMutation = await dispatchTimelineControlCommand(command, args, services);
  if (controlMutation) return controlMutation;
  const structuralMutation = await dispatchTimelineScenesMarkersCommand(command, args, services);
  if (structuralMutation) return structuralMutation;
  const keyframeMutation = await dispatchTimelineKeyframesBasicCommand(command, args, services);
  if (keyframeMutation) return keyframeMutation;
  const bulkKeyframeMutation = await dispatchTimelineKeyframesBulkCommand(command, args, services);
  if (bulkKeyframeMutation) return bulkKeyframeMutation;
  const spatialPathMutation = await dispatchTimelineSpatialPathCommand(command, args, services);
  if (spatialPathMutation) return spatialPathMutation;
  const structuralLayerOrGroupMutation = await dispatchTimelineStructuralCommand(command, args, services);
  if (structuralLayerOrGroupMutation) return structuralLayerOrGroupMutation;
  const layerPropertyMutation = await dispatchTimelineLayerPropertiesCommand(command, args, services);
  if (layerPropertyMutation) return layerPropertyMutation;
  const cleanupMutation = await dispatchTimelineCleanupCommand(command, args, services);
  if (cleanupMutation) return cleanupMutation;
  const trackMutation = await dispatchTimelineTracksCommand(command, args, services);
  if (trackMutation) return trackMutation;
  const audioMasterMutation = await dispatchTimelineAudioMasterCommand(command, args, services);
  if (audioMasterMutation) return audioMasterMutation;
  const layerRelationMutation = await dispatchTimelineLayerRelationsCommand(command, args, services);
  if (layerRelationMutation) return layerRelationMutation;
  const transitionMutation = await dispatchTimelineTransitionsCommand(command, args, services);
  if (transitionMutation) return transitionMutation;
  const captionMutation = await dispatchTimelineCaptionsCommand(command, args, services);
  if (captionMutation) return captionMutation;
  if (command === "motion.timeline.easing.presets") return easingPresets();
  if (command === "motion.timeline.animation.presets") return animationPresets();
  if (command === "motion.timeline.panel") return timelinePanel(args, services);
  if (command === "motion.timeline.keyframes.panel") return keyframesPanel(args, services);
  if (command === "motion.timeline.transitions.panel") return transitionsPanel(args, services);
  if (command === "motion.timeline.easing.panel") return easingPanel(args, services);
  if (command === "motion.timeline.duration.policy") return durationPolicy(args, services);
  if (command !== "motion.timeline.inspect") return null;

  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.timeline.inspect requires packageRoot.");
  if (!services.packageLoader) return capabilityUnavailable("Motion package loading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const timeline = inspectMotionTimeline(pkg.motion);
  const receiptId = `timeline-inspect-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({
    motionId: pkg.motion.id,
    timeline
  }), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: {
      panel: "timeline",
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      trackCount: timeline.trackCount,
      sceneCount: timeline.sceneCount,
      markerCount: timeline.markerCount
    },
    result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, timeline },
    warnings: []
  };
}

async function timelinePanel(args: unknown, services: TimelineDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.timeline.panel requires packageRoot.");
  if (!services.packageLoader || !services.readTimelinePanel) return capabilityUnavailable("Timeline panel reading is unavailable.");
  try {
    const pkg = await services.packageLoader(packageRoot);
    const { panel, playheadMs, warnings } = await services.readTimelinePanel(pkg);
    const receiptId = `timeline-panel-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
    return {
      ok: true,
      receiptId,
      visibleState: {
        panel: "timeline",
        operation: "timeline.panel",
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        durationMs: pkg.motion.durationMs,
        playheadMs,
        layerCount: count(panel, "layers"),
        trackCount: count(panel, "tracks"),
        sceneCount: count(panel, "scenes"),
        markerCount: count(panel, "markers"),
        safeAreaCount: count(panel, "safeAreas"),
        protectedRegionCount: count(panel, "protectedRegions")
      },
      result: { ok: true, ...panel },
      warnings
    };
  } catch (error) {
    return commandFailure("timeline_panel_failed", error);
  }
}

async function keyframesPanel(args: unknown, services: TimelineDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer") ?? undefined;
  const target = stringArg(args, "target") ?? undefined;
  const includeEmpty = booleanArg(args, "includeEmpty") ?? false;
  if (!packageRoot) return invalidArgs("motion.timeline.keyframes.panel requires packageRoot.");
  if (!services.packageLoader || !services.buildKeyframesPanel) return capabilityUnavailable("Timeline keyframe panel reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const panel = services.buildKeyframesPanel(pkg, { layerId, target, includeEmpty });
  const receiptId = `timeline-keyframes-panel-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: {
      panel: "keyframes",
      operation: "timeline.keyframes.panel",
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      layerCount: count(panel, "layers"),
      animatedLayerCount: count(panel, "animatedLayers"),
      targetCount: count(panel, "targets"),
      keyframeCount: count(panel, "keyframes"),
      malformedKeyframeCount: count(panel, "malformedKeyframes"),
      easingPresetCount: count(panel, "easingPresets"),
      animationPresetCount: count(panel, "animationPresets")
    },
    result: { ok: true, ...panel },
    warnings: panel.warnings ?? []
  };
}

async function transitionsPanel(args: unknown, services: TimelineDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer") ?? undefined;
  const edgeArg = stringArg(args, "edge");
  const includeEmpty = booleanArg(args, "includeEmpty") ?? false;
  if (!packageRoot) return invalidArgs("motion.timeline.transitions.panel requires packageRoot.");
  if (edgeArg !== null && edgeArg !== "in" && edgeArg !== "out") return unsupportedEnumValue("edge", edgeArg, "transitionEdge");
  if (!services.packageLoader || !services.buildTransitionsPanel) return capabilityUnavailable("Timeline transition panel reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const panel = services.buildTransitionsPanel(pkg, { layerId, edge: edgeArg ?? undefined, includeEmpty });
  const receiptId = `timeline-transitions-panel-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: {
      panel: "transitions",
      operation: "timeline.transitions.panel",
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      layerCount: count(panel, "layers"),
      transitionLayerCount: count(panel, "transitionLayers"),
      transitionCount: count(panel, "transitions"),
      enterTransitionCount: count(panel, "enterTransitions"),
      exitTransitionCount: count(panel, "exitTransitions"),
      transitionTypeCount: count(panel, "transitionTypes"),
      easingPresetCount: count(panel, "easingPresets")
    },
    result: { ok: true, ...panel },
    warnings: []
  };
}

/**
 * Ceiling on `motion.timeline.easing.panel`'s caller-supplied `sampleCount`.
 *
 * The panel samples EVERY easing row -- each preset plus each custom easing the package uses -- so
 * one compact `read_motion` request costs `rowCount * sampleCount` evaluations and array slots. The
 * argument previously had a floor of 2 and no ceiling, which let a request far smaller than its own
 * effect drive arbitrary allocation from the lowest tier.
 *
 * 512 is chosen as far past what plotting a curve needs (the default is 7) while keeping the request
 * cost proportionate to the request. Note what this bound does and does not do: it removes the
 * caller's ability to amplify without limit, but total work still scales with how many easings the
 * package contains. That factor is governed by package validation, not here, and this cap is not a
 * substitute for it.
 */
const MAX_EASING_SAMPLE_COUNT = 512;

async function easingPanel(args: unknown, services: TimelineDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const sampleCountArg = positiveIntegerArg(args, "sampleCount");
  if (!packageRoot) return invalidArgs("motion.timeline.easing.panel requires packageRoot.");
  if (sampleCountArg === false || (typeof sampleCountArg === "number" && sampleCountArg < 2)) {
    return invalidArgs("motion.timeline.easing.panel sampleCount must be an integer greater than or equal to 2.");
  }
  if (typeof sampleCountArg === "number" && sampleCountArg > MAX_EASING_SAMPLE_COUNT) {
    return invalidArgs(`motion.timeline.easing.panel sampleCount must be ${MAX_EASING_SAMPLE_COUNT} or fewer.`);
  }
  if (!services.packageLoader || !services.buildEasingPanel) return capabilityUnavailable("Timeline easing panel reading is unavailable.");
  const sampleCount = sampleCountArg ?? 7;
  const pkg = await services.packageLoader(packageRoot);
  const panel = services.buildEasingPanel(pkg, sampleCount);
  const receiptId = `timeline-easing-panel-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: {
      panel: "easing",
      operation: "timeline.easing.panel",
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      presetCount: count(panel, "presets"),
      usedPresetCount: count(panel, "usedPresets"),
      customEasingCount: count(panel, "customEasings"),
      usageCount: count(panel, "usage"),
      // The keyframe panel's twin: a package whose keyframes the evaluator cannot read used to show
      // a full easing usage count here with nothing said about it.
      unreadableKeyframeCount: count(panel, "unreadableKeyframes"),
      sampleCount
    },
    result: { ok: true, ...panel },
    warnings: panel.warnings ?? []
  };
}

async function durationPolicy(args: unknown, services: TimelineDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.timeline.duration.policy requires packageRoot.");
  if (!services.packageLoader) return capabilityUnavailable("Timeline duration policy reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const loaded = readMotionDurationPolicy(pkg.motion);
  const receiptId = `timeline-duration-policy-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({
    motionId: pkg.motion.id,
    policy: loaded.policy
  }), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: visibleDurationPolicyState(pkg, loaded.policy),
    result: {
      ok: true,
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      durationMs: pkg.motion.durationMs,
      policy: loaded.policy,
      protectedRegions: loaded.policy?.protectedRegions ?? []
    },
    warnings: loaded.warnings
  };
}

function count(panel: PanelRecord, key: string): number {
  const value = (panel.counts as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Timeline panel returned invalid ${key} count.`);
  return value;
}

function easingPresets(): MotionDebugResult {
  const presets = listMotionEasingPresets();
  const receiptId = `timeline-easing-presets-${hashBuffer(Buffer.from(JSON.stringify(presets), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: { panel: "timeline", operation: "timeline.easing.presets", presetCount: presets.length },
    result: { ok: true, defaultPreset: "linear", presets },
    warnings: []
  };
}

function animationPresets(): MotionDebugResult {
  const presets = listMotionAnimationPresets();
  const receiptId = `timeline-animation-presets-${hashBuffer(Buffer.from(JSON.stringify(presets), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: { panel: "timeline", operation: "timeline.animation.presets", presetCount: presets.length },
    result: { ok: true, defaultPreset: "fade-in", presets },
    warnings: []
  };
}

function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}

function commandFailure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
