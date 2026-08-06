/** Package-derived Assets, Brand, Media, and Audio read surfaces. */
import { hashBuffer, type MotionPackage } from "@shellx-motion/core";
import { readMotionExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";

interface AssetsPanel {
  assets: unknown[];
  motionAssets: unknown[];
  layerRefs: unknown[];
  missingAssets: unknown[];
  unusedDeclaredAssets: unknown[];
}

interface BrandPanel {
  designTokens: unknown;
  tokenGroups: unknown[];
  colorTokens: unknown[];
  typographyTokens: unknown[];
  logoTokens: unknown[];
  provenance: { sourceApp: unknown; projectId?: unknown; selectedFrameId?: unknown };
}

interface MediaPanel {
  counts: {
    mediaLayers: number; imageLayers: number; videoLayers: number; audioLayers: number;
    webLayers: number; missingSources: number; noSourceLayers: number;
  };
  warnings: string[];
}

interface AudioPanel {
  counts: {
    layers: number; resolvedInputs: number; ducking: number; volumeAutomationKeyframes: number;
    panAutomationKeyframes: number; playbackRateControls: number; audioTracks: number;
    mutedTracks: number; soloTracks: number;
  };
  warnings: string[];
}

export interface SurfacePackagePanelServices {
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  buildAssetsPanel?: (pkg: MotionPackage) => Promise<AssetsPanel>;
  buildBrandPanel?: (pkg: MotionPackage) => BrandPanel;
  buildMediaPanel?: (pkg: MotionPackage, preset?: MotionExportPreset) => MediaPanel;
  buildAudioPanel?: (pkg: MotionPackage, preset?: MotionExportPreset) => AudioPanel;
}

export async function dispatchSurfacePackagePanelCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: SurfacePackagePanelServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.assets.panel") return assets(args, services);
  if (command === "motion.brand.panel") return brand(args, services);
  if (command === "motion.media.panel") return media(args, services);
  if (command === "motion.audio.panel") return audio(args, services);
  return null;
}

async function assets(args: unknown, services: SurfacePackagePanelServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.assets.panel requires packageRoot.");
  if (!services.packageLoader || !services.buildAssetsPanel) return capabilityUnavailable("Assets panel reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const panel = await services.buildAssetsPanel(pkg);
  const receiptId = panelReceiptId("assets", pkg.manifest.id, panel);
  return {
    ok: true, receiptId,
    visibleState: {
      panel: "assets", operation: "assets.panel", packageId: pkg.manifest.id, motionId: pkg.motion.id,
      declaredAssetCount: panel.assets.length, motionAssetCount: panel.motionAssets.length,
      referencedAssetCount: panel.layerRefs.length, missingAssetCount: panel.missingAssets.length,
      unusedDeclaredAssetCount: panel.unusedDeclaredAssets.length
    },
    result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, ...panel },
    warnings: []
  };
}

async function brand(args: unknown, services: SurfacePackagePanelServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.brand.panel requires packageRoot.");
  if (!services.packageLoader || !services.buildBrandPanel) return capabilityUnavailable("Brand panel reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const panel = services.buildBrandPanel(pkg);
  const receiptId = panelReceiptId("brand", pkg.manifest.id, panel);
  return {
    ok: true, receiptId,
    visibleState: {
      panel: "brand", operation: "brand.panel", packageId: pkg.manifest.id, motionId: pkg.motion.id,
      hasDesignTokens: panel.designTokens !== null, tokenGroupCount: panel.tokenGroups.length,
      colorTokenCount: panel.colorTokens.length, typographyTokenCount: panel.typographyTokens.length,
      logoTokenCount: panel.logoTokens.length, sourceApp: panel.provenance.sourceApp,
      ...(typeof panel.provenance.projectId === "string" ? { projectId: panel.provenance.projectId } : {}),
      ...(typeof panel.provenance.selectedFrameId === "string" ? { selectedFrameId: panel.provenance.selectedFrameId } : {})
    },
    result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, ...panel },
    warnings: []
  };
}

async function media(args: unknown, services: SurfacePackagePanelServices): Promise<MotionDebugResult> {
  const base = await mediaBase("motion.media.panel", args, services, "Media");
  if ("ok" in base) return base;
  const panel = services.buildMediaPanel!(base.pkg, base.preset);
  return {
    ok: true,
    receiptId: panelReceiptId("media", base.pkg.manifest.id, panel),
    visibleState: {
      panel: "media", operation: "media.panel", packageId: base.pkg.manifest.id, motionId: base.pkg.motion.id,
      mediaLayerCount: panel.counts.mediaLayers, imageLayerCount: panel.counts.imageLayers,
      videoLayerCount: panel.counts.videoLayers, audioLayerCount: panel.counts.audioLayers,
      webLayerCount: panel.counts.webLayers, missingSourceCount: panel.counts.missingSources,
      noSourceLayerCount: panel.counts.noSourceLayers, warningCount: panel.warnings.length,
      ...(base.preset ? { preset: base.preset } : {})
    },
    result: { ok: true, ...panel }, warnings: panel.warnings
  };
}

async function audio(args: unknown, services: SurfacePackagePanelServices): Promise<MotionDebugResult> {
  const base = await mediaBase("motion.audio.panel", args, services, "Audio");
  if ("ok" in base) return base;
  const panel = services.buildAudioPanel!(base.pkg, base.preset);
  return {
    ok: true,
    receiptId: panelReceiptId("audio", base.pkg.manifest.id, panel),
    visibleState: {
      panel: "audio", operation: "audio.panel", packageId: base.pkg.manifest.id, motionId: base.pkg.motion.id,
      audioLayerCount: panel.counts.layers, resolvedInputCount: panel.counts.resolvedInputs,
      duckingCount: panel.counts.ducking, volumeAutomationKeyframeCount: panel.counts.volumeAutomationKeyframes,
      panAutomationKeyframeCount: panel.counts.panAutomationKeyframes,
      playbackRateControlCount: panel.counts.playbackRateControls, audioTrackCount: panel.counts.audioTracks,
      mutedTrackCount: panel.counts.mutedTracks, soloTrackCount: panel.counts.soloTracks,
      warningCount: panel.warnings.length, ...(base.preset ? { preset: base.preset } : {})
    },
    result: { ok: true, ...panel }, warnings: panel.warnings
  };
}

async function mediaBase(
  command: "motion.media.panel" | "motion.audio.panel",
  args: unknown,
  services: SurfacePackagePanelServices,
  label: "Media" | "Audio"
): Promise<{ pkg: MotionPackage; preset?: MotionExportPreset } | MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const presetValue = stringArg(args, "preset") ?? stringArg(args, "exportPreset");
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  const preset = presetValue ? readMotionExportPreset(presetValue) : null;
  if (presetValue && !preset) return invalidArgs(`Unsupported export preset: ${presetValue}.`);
  const builder = command === "motion.media.panel" ? services.buildMediaPanel : services.buildAudioPanel;
  if (!services.packageLoader || !builder) return capabilityUnavailable(`${label} panel reading is unavailable.`);
  return { pkg: await services.packageLoader(packageRoot), ...(preset ? { preset } : {}) };
}

function panelReceiptId(kind: string, packageId: string, panel: unknown): string {
  return `${kind}-panel-${packageId}-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
