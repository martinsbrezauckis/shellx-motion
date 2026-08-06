import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, ConsoleMessage, Page } from "playwright-core";
import {
  captureDeterministicScreenshot,
  isTransientCaptureScreenshotError,
  type DeterministicScreenshotOptions,
} from "./browser-screenshot-integrity";
import {
  generatedKeyingRuntimeScript,
  motionKeyingDataAttribute,
  settleGeneratedMotionKeying,
  type BrowserKeyingEvidence,
} from "./generated-keying";
import { cssVectorMaskStyle, generatedVectorMaskDefinition } from "./generated-vector-masks";
import { browserPackageFingerprint, canonicalPathForBrowserSafety, isPathInsideOrEqual } from "./browser-package-safety";
import { attachBrowserRedirectGuard } from "./browser-redirect-guard";
import { remoteOrigin, type BrowserFrameNetworkState } from "./browser-network-state";
import { authorizeBrowserRouteRequest, createBrowserDocumentSchemeMemory, type BrowserDocumentSchemeMemory } from "./browser-route-policy";
import {
  renderGeneratedScene3D,
  scene3dEvidence,
  type BrowserScene3DEvidence,
} from "./generated-scene3d";
import {
  generatedHexColor as scene3dHexColor,
  generatedNumber as scene3dNumber,
} from "./generated-value-guards";
import { createFrameLaneNotes, frameLaneAudioHandoff, noteUnrenderedLayer, type FrameLaneAudioHandoff, type FrameLaneNotes } from "./frame-lane-handoff";
import { prepareCompositingRenderPackage } from "./render-compositing";
import { effectiveProceduralLayerAtMs, effectiveProceduralLayersAtMs } from "./procedural-layers";
import { fixedScene3DRuntimeScript } from "./scene3d-runtime-script";
import {
  assertLocalMotionFrameBudget,
  assertReadableMotionKeyframes,
  assertLocalMotionFrameCountBudget,
  BROWSER_CAPABILITY,
  browserExecutableCandidates,
  canonicalJson,
  compareCodeUnits,
  compileRestrictedFragmentShader,
  removeFirstMarkupAttribute,
  scanMarkupAttributeTagPairs,
  defaultLocalMotionJobGovernor,
  ENVIRONMENT_SCHEMA,
  hashFile,
  interpolateNumber,
  isAudioOnlyFrameLaneUnsupported,
  isSupportedMotionColorString,
  matchRendererCapability,
  MAX_RESTRICTED_SHADER_BYTES,
  MAX_ENVIRONMENT_LAYERS,
  MAX_FOG_DEPTH_LAYERS,
  MAX_RAIN_DEPTH_LAYERS,
  MAX_SNOW_DEPTH_LAYERS,
  MAX_WATER_WAVE_OCTAVES,
  findMotionBrowserExecutable,
  motionBrowserOverrideProblem,
  MOTION_BROWSER_OVERRIDE_ENV_VAR,
  parseMotionPathViewBox,
  previewReceiptStatus,
  resolveNetworkTarget,
  resolveEasing,
  resolvePackageAsset,
  validateMotionPathData,
  type NetworkAddressResolver,
  type MotionLayer,
  type MotionKeyframe,
  type LocalMotionJobEvidence,
  type LocalMotionJobGovernor,
  type MotionFontAsset,
  type MotionTransition,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact,
  childEnvironment
} from "@shellx-motion/core";

// Re-export the single-source browser capability (owned by @shellx-motion/core) so existing
// consumers can keep importing it from this package. The runtime gate in
// createMotionBrowserRenderSession consumes it directly.
export { BROWSER_CAPABILITY } from "@shellx-motion/core";
export { captureDeterministicScreenshot } from "./browser-screenshot-integrity";
export type { DeterministicScreenshotOptions, DeterministicScreenshotPage } from "./browser-screenshot-integrity";
// Network egress policy lives in its own module (see its header for the invariant reasoning);
// re-exported here so the package API surface is unchanged by the extraction.
export { authorizeBrowserRedirectHop } from "./browser-redirect-guard";
export { authorizeBrowserRouteRequest, createBrowserDocumentSchemeMemory } from "./browser-route-policy";
export type { BrowserDocumentSchemeMemory, BrowserRoutePolicy, RoutedBrowserRequest } from "./browser-route-policy";
export type { BrowserFrameNetworkState } from "./browser-network-state";

export interface BrowserPreflightResult {
  ok: boolean;
  htmlEntries: string[];
  blockedOrigins: string[];
  warnings: string[];
}

export interface BrowserNetworkAccessOptions {
  /** Host-approved origins. Browser-layer declarations are requests, not authority. */
  approvedOrigins?: string[];
  /** Trusted local development only. Untrusted packages must leave this false. */
  allowPrivateNetwork?: boolean;
  /** Per-origin DNS validation deadline. Defaults to 5 seconds; maximum 30 seconds. */
  resolutionTimeoutMs?: number;
  resolver?: NetworkAddressResolver;
}

export interface BrowserNetworkEvidence {
  policy: "host-approved-origins";
  allowPrivateNetwork: boolean;
  resolutionTimeoutMs: number;
  approvedOrigins: string[];
  pins: Array<{ hostname: string; address: string; family: 4 | 6 }>;
}

export interface HtmlComposition {
  compositionId: string;
  source: string;
  startMs: number;
  durationMs: number;
  layers: Array<{ id: string; startMs: number; durationMs: number }>;
}

interface BrowserCaptureHtmlPreparation {
  html?: string;
  artifactPath?: string;
  artifactSha256?: string;
  artifacts: ReceiptArtifact[];
}

export interface BrowserFrameResult {
  ok: true;
  output: {
    path: string;
    sha256: string;
    format?: BrowserFrameFormat;
    width: number;
    height: number;
    atMs: number;
    browser: { name: string; version: string };
    renderSession?: BrowserRenderSessionMetrics;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    workflow?: BrowserCaptureWorkflowSummary;
    workflowTrace?: BrowserCaptureWorkflowTrace;
    workflowTracePath?: string;
    workflowCatalogPath?: string;
    workflowDrift?: unknown;
    captureReadiness?: BrowserCaptureReadiness;
    network?: BrowserNetworkEvidence;
    typography?: BrowserTypographyEvidence;
    textFit?: BrowserTextFitEvidence;
    temporalSampling?: BrowserTemporalSamplingEvidence;
    shaders?: BrowserShaderEvidence;
    scenes3d?: BrowserScene3DEvidence;
    environments?: BrowserEnvironmentEvidence;
    keying?: BrowserKeyingEvidence;
    webglResources?: BrowserWebGLResourceEvidence;
    artifacts?: ReceiptArtifact[];
    resources?: LocalMotionJobEvidence;
  };
  receipt: OperationReceipt;
}

export interface BrowserShaderEvidence {
  policy: "restricted-package-glsl";
  maxLayers: number;
  maxSourceBytes: number;
  maxUniformsPerLayer: number;
  network: "denied";
  clock: "frame-time";
  random: "declared-seed";
  layers: Array<{
    layerId: string;
    assetRef: string;
    sha256: string;
    bytes: number;
    seed: number;
    uniformCount: number;
  }>;
}

export interface BrowserWebGLResourceEvidence {
  policy: "snapshot-then-explicit-context-release";
  surfaceCount: number;
  frozenSurfaceCount: number;
  contextReleaseRequestedCount: number;
  layerIds: string[];
}

export interface BrowserEnvironmentEvidence {
  policy: "fixed-data-environment-webgl";
  schema: typeof ENVIRONMENT_SCHEMA;
  maxLayers: number;
  maxRainDepthLayers: number;
  maxSnowDepthLayers: number;
  maxFogDepthLayers: number;
  maxWaterWaveOctaves: number;
  network: "denied";
  clock: "frame-time";
  random: "declared-seed";
  code: "host-fixed";
  layers: Array<{
    layerId: string;
    kind: "rain" | "water" | "snow" | "fog";
    seed: number;
    quality: "preview" | "balanced" | "cinematic";
    mode: "scene" | "overlay";
    sceneSourceLayerId?: string;
    sceneSourceAssetRef?: string;
    effectMaskLayerId?: string;
    effectMaskAssetRef?: string;
    depthLayers?: number;
    effectiveDepthLayers?: number;
    snowDepthLayers?: number;
    effectiveSnowDepthLayers?: number;
    fogDepthLayers?: number;
    effectiveFogDepthLayers?: number;
    waveOctaves?: number;
    effectiveWaveOctaves?: number;
  }>;
}

export interface BrowserTemporalSamplingEvidence {
  policy: "layer-temporal-supersampling";
  maxSamplesPerLayer: 8;
  maxVideoSamplesPerLayer: 4;
  maxTotalSamples: 64;
  maxTotalVideoSamples: 16;
  totalSamples: number;
  totalVideoSamples: number;
  layers: Array<{ layerId: string; layerType: string; samples: number; shutterAngle: number; shutterDurationMs: number }>;
}

export interface BrowserTypographyEvidence {
  fontProbe: "canvas-metric";
  layers: Array<{
    layerId: string;
    direction: "ltr" | "rtl";
    lang: string | null;
    requestedFontFamily: string | null;
    resolvedFontFamily: string;
    primaryFontAvailable: boolean | null;
  }>;
  fallbackLayerIds: string[];
}

export interface BrowserTextFitEvidence {
  policy: "rendered-glyph-bounds";
  atMs: number;
  visibilityThreshold: 0.5;
  checkedLayerCount: number;
  uncheckedLayerIds: string[];
  allowedCropLayerIds: string[];
  autoFittedLayerIds: string[];
  failedLayerIds: string[];
  layers: Array<{
    layerId: string;
    policy: "safe" | "allow-crop" | "auto-fit";
    safeAreaId: string | null;
    status: "passed" | "allowed-crop" | "auto-fitted" | "failed";
    requestedFontSize: number;
    appliedFontSize: number;
    minFontSize: number | null;
    sampleCount: number;
    visibleSampleCount: number;
    internalOverflowPx: { horizontal: number; vertical: number };
    safeAreaOverflowPx: { top: number; right: number; bottom: number; left: number };
  }>;
}

export class BrowserFontFallbackPolicyError extends Error {
  readonly code = "font_fallback_limit_exceeded";

  constructor(readonly fallbackLayerIds: string[], readonly maxFontFallbacks: number) {
    super(`Browser renderer detected ${fallbackLayerIds.length} font fallback(s); package quality allows at most ${maxFontFallbacks}. Layers: ${fallbackLayerIds.join(", ") || "<unknown>"}.`);
    this.name = "BrowserFontFallbackPolicyError";
  }
}

export class BrowserTextFitPolicyError extends Error {
  readonly code = "text_fit_failed";

  constructor(readonly evidence: BrowserTextFitEvidence) {
    const details = evidence.layers
      .filter((layer) => layer.status === "failed")
      .map((layer) => {
        const safe = layer.safeAreaOverflowPx;
        const internal = layer.internalOverflowPx;
        return `${layer.layerId} (safe t${safe.top}/r${safe.right}/b${safe.bottom}/l${safe.left}px, internal ${internal.horizontal}x${internal.vertical}px)`;
      })
      .join(", ");
    super(`Browser text-fit check failed at ${evidence.atMs}ms: ${details || evidence.failedLayerIds.join(", ")}.`);
  }
}

export interface BrowserFrameOptions {
  atMs: number;
  outDir: string;
  outputPath?: string;
  workflow?: BrowserCaptureWorkflow;
  networkAccess?: BrowserNetworkAccessOptions;
  format?: BrowserFrameFormat;
  now?: () => string;
}

export interface BrowserRenderSessionOptions {
  networkAccess?: BrowserNetworkAccessOptions;
  /** Trusted host/test override; packages cannot supply resource policy. */
  governor?: LocalMotionJobGovernor;
  /** Test/host seam for instrumenting the one browser launch owned by a session. */
  launchBrowser?: (options: { executablePath: string; headless: true; args: string[] }) => Promise<Browser>;
  /**
   * Stable owner identity for this session's jobs, used for visibility and never for scheduling.
   *
   * Supplied by the host. Without it the jobs are recorded as unattributed, which puts every
   * caller in one visibility bucket.
   */
  callerId?: string;
  /**
   * The id this job will be known by, so a host can query it while the render is still running.
   * Omitted, Motion mints one and returns it in the job evidence.
   */
  jobId?: string;
}

export interface BrowserRenderSessionMetrics {
  browserLaunches: number;
  framesRendered: number;
  contextsCreated: number;
  pagesCreated: number;
  activeFrames: number;
  peakConcurrentFrames: number;
  frameCacheHits: number;
  frameRetries: number;
}

export interface BrowserFrameBatchOptions {
  maxConcurrency?: number;
  perFrameTimeoutMs?: number;
  maxFrameAttempts?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number; index: number; atMs: number }) => void;
}

export interface MotionBrowserRenderSession {
  readonly browserVersion: string;
  readonly metrics: Readonly<BrowserRenderSessionMetrics>;
  renderFrame(options: Omit<BrowserFrameOptions, "networkAccess">): Promise<BrowserFrameResult>;
  renderFrames(
    frames: Array<Omit<BrowserFrameOptions, "networkAccess">>,
    options?: BrowserFrameBatchOptions
  ): Promise<BrowserFrameResult[]>;
  close(): Promise<void>;
}

export class BrowserFrameCancelledError extends Error {
  readonly code = "browser_frame_cancelled";

  constructor(message = "Browser frame render was cancelled.") {
    super(message);
    this.name = "BrowserFrameCancelledError";
    Object.setPrototypeOf(this, BrowserFrameCancelledError.prototype);
  }
}

export class BrowserFrameTimeoutError extends Error {
  readonly code = "browser_frame_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Browser frame render exceeded ${timeoutMs}ms.`);
    this.name = "BrowserFrameTimeoutError";
    Object.setPrototypeOf(this, BrowserFrameTimeoutError.prototype);
  }
}

export type BrowserFrameFailureClass = "cancelled" | "timeout" | "transient" | "deterministic";

export function classifyBrowserFrameFailure(error: unknown): BrowserFrameFailureClass {
  if (error instanceof BrowserFrameCancelledError) return "cancelled";
  if (error instanceof BrowserFrameTimeoutError) return "timeout";
  if (error instanceof BrowserWorkflowReplayError) return "deterministic";
  const message = error instanceof Error ? error.message : String(error);
  if (
    isTransientCaptureScreenshotError(error)
    || /\b(page|target)\s+(?:has\s+)?crashed\b/i.test(message)
    || /browser context closed unexpectedly/i.test(message)
  ) {
    return "transient";
  }
  return "deterministic";
}

export type BrowserFrameFormat = "png" | "jpeg";

export interface BrowserCaptureWorkflow {
  schema: "shellx-motion/browser-workflow@1";
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  networkPolicy?: "blocked-unless-declared" | "allow";
  steps: BrowserCaptureWorkflowStep[];
  cursor?: { visible?: boolean; path?: Array<{ x: number; y: number; atMs: number }> };
}

export type BrowserCaptureWorkflowStep =
  | { action: "wait"; ms: number }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "press"; selector: string; key: string }
  | { action: "scroll"; x?: number; y?: number }
  | { action: "verify"; selector: string; text?: string };

export interface BrowserCaptureWorkflowSummary {
  schema: "shellx-motion/browser-workflow@1";
  networkPolicy: "blocked-unless-declared" | "allow";
  stepCount: number;
  steps: Array<Record<string, unknown>>;
  cursor?: { visible?: boolean; pointCount: number };
}

export interface BrowserCaptureWorkflowTrace {
  schema: "shellx-motion/browser-workflow-trace@1";
  workflowHash: string;
  stepCount: number;
  steps: BrowserCaptureWorkflowTraceStep[];
  cursor?: { visible?: boolean; pointCount: number };
  captureReadiness?: BrowserCaptureReadiness;
}

export interface BrowserCaptureWorkflowTraceStep {
  index: number;
  action: Record<string, unknown>;
  status: "passed" | "failed";
  error?: BrowserCaptureWorkflowTraceError;
}

export interface BrowserCaptureWorkflowTraceError {
  code: "action_failed" | "text_mismatch";
  message: string;
  selector?: string;
  expectedTextLength?: number;
  actualTextLength?: number;
  actualTextSha256?: string;
}

export interface BrowserCaptureReadiness {
  schema: "shellx-motion/browser-capture-readiness@1";
  page: "loaded";
  stylesheets: "settled";
  fonts: "ready" | "unsupported" | "timeout" | "error";
  animationPolicy: "screenshot-disabled";
  media: "settled-after-time-seek";
  waitMs: number;
  diagnostics: BrowserCaptureReadinessDiagnostics;
}

export interface BrowserCaptureReadinessDiagnostics {
  stylesheetLinkCount: number;
  fontFaceCount: number;
  fontFaceLoadAttemptCount: number;
  fontFaceLoadedCount: number;
  finiteAnimationCount: number;
  finiteAnimationMaxMs: number;
  finiteTransitionCount: number;
  finiteTransitionMaxMs: number;
}

export class BrowserWorkflowReplayError extends Error {
  readonly code = "browser_workflow_replay_failed";

  constructor(
    readonly trace: BrowserCaptureWorkflowTrace,
    readonly failedStep: BrowserCaptureWorkflowTraceStep
  ) {
    super(`Browser workflow replay failed at step ${failedStep.index}.`);
    this.name = "BrowserWorkflowReplayError";
    Object.setPrototypeOf(this, BrowserWorkflowReplayError.prototype);
  }
}

interface PreparedBrowserNetworkPolicy {
  preflight: BrowserPreflightResult;
  allowedOrigins: Set<string>;
  evidence: BrowserNetworkEvidence;
  chromiumArgs: string[];
}

const DEFAULT_BROWSER_NETWORK_RESOLUTION_TIMEOUT_MS = 5_000;
const MAX_BROWSER_NETWORK_RESOLUTION_TIMEOUT_MS = 30_000;

export async function preflightBrowserPackage(
  pkg: MotionPackage,
  networkAccess: BrowserNetworkAccessOptions = {}
): Promise<BrowserPreflightResult> {
  return (await prepareBrowserNetworkPolicy(pkg, networkAccess)).preflight;
}

async function prepareBrowserNetworkPolicy(
  pkg: MotionPackage,
  networkAccess: BrowserNetworkAccessOptions
): Promise<PreparedBrowserNetworkPolicy> {
  const htmlEntries: string[] = [];
  const blockedOrigins: string[] = [];
  const warnings: string[] = [];
  const resolutionTimeoutMs = browserNetworkResolutionTimeout(networkAccess.resolutionTimeoutMs);
  const packageOrigins = requestedOriginsForBrowserLayers(pkg, warnings);
  const hostOrigins = normalizeBrowserOrigins(networkAccess.approvedOrigins ?? [], "host-approved", warnings);
  const hasBrowserLayers = browserLayers(pkg).length > 0;
  const candidateOrigins = hasBrowserLayers
    ? new Set([...packageOrigins].filter((origin) => hostOrigins.has(origin)))
    : hostOrigins;
  const actualOrigins = new Set<string>();

  for (const layer of browserLayers(pkg)) {
    const source = readString(layer.source);
    if (!source) {
      warnings.push(`Browser layer ${layer.id} has no source.`);
      continue;
    }

    const origin = remoteOrigin(source);
    if (origin) {
      actualOrigins.add(origin);
    } else {
      htmlEntries.push(source);
      const html = await readFile(resolvePackageAsset(pkg, source), "utf8");
      for (const htmlOrigin of remoteOriginsInHtml(html)) actualOrigins.add(htmlOrigin);
    }
  }

  for (const origin of actualOrigins) {
    if (!packageOrigins.has(origin)) {
      blockedOrigins.push(origin);
      warnings.push(`Blocked undeclared browser origin: ${origin}`);
    } else if (!hostOrigins.has(origin)) {
      blockedOrigins.push(origin);
      warnings.push(`Blocked host-unapproved browser origin: ${origin}`);
    }
  }

  const allowedOrigins = new Set<string>();
  const pins = new Map<string, { address: string; family: 4 | 6 }>();
  for (const origin of candidateOrigins) {
    try {
      const target = await resolveNetworkTarget(origin, {
        resolver: networkAccess.resolver,
        purpose: "browser render",
        signal: AbortSignal.timeout(resolutionTimeoutMs),
        allowPrivate: networkAccess.allowPrivateNetwork === true
      });
      const existing = pins.get(target.hostname);
      if (existing && (existing.address !== target.pinnedAddress.address || existing.family !== target.pinnedAddress.family)) {
        throw new Error(`browser render hostname resolved inconsistently during preflight: ${target.hostname}`);
      }
      pins.set(target.hostname, target.pinnedAddress);
      allowedOrigins.add(origin);
    } catch (error) {
      blockedOrigins.push(origin);
      warnings.push(`Blocked unsafe browser origin ${origin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const uniqueBlockedOrigins = [...new Set(blockedOrigins)].sort();
  const uniqueWarnings = [...new Set(warnings)];
  const evidence: BrowserNetworkEvidence = {
    policy: "host-approved-origins",
    allowPrivateNetwork: networkAccess.allowPrivateNetwork === true,
    resolutionTimeoutMs,
    approvedOrigins: [...allowedOrigins].sort(),
    pins: [...pins.entries()]
      .map(([hostname, address]) => ({ hostname, ...address }))
      // Code-unit order, not localeCompare: pin order is part of BrowserNetworkEvidence, which is
      // written into the render receipt and hashed with it.
      .sort((left, right) => compareCodeUnits(left.hostname, right.hostname))
  };
  return {
    preflight: {
      ok: uniqueBlockedOrigins.length === 0,
      htmlEntries,
      blockedOrigins: uniqueBlockedOrigins,
      warnings: uniqueWarnings
    },
    allowedOrigins,
    evidence,
    chromiumArgs: chromiumHostResolverArgs(pins)
  };
}

export async function loadHtmlComposition(pkg: MotionPackage): Promise<HtmlComposition> {
  const layer = browserLayers(pkg)[0];
  if (!layer) {
    throw new Error(`Package ${pkg.manifest.id} does not contain a browser layer.`);
  }

  const source = readString(layer.source);
  if (!source || remoteOrigin(source)) {
    throw new Error(`Browser layer ${layer.id} does not reference a local HTML source.`);
  }

  const html = await readFile(resolvePackageAsset(pkg, source), "utf8");
  return {
    compositionId: attr(html, "data-composition-id") ?? pkg.motion.id,
    source,
    startMs: Number(attr(html, "data-start") ?? layer.startMs),
    durationMs: Number(attr(html, "data-duration") ?? layer.durationMs),
    layers: htmlDataAttributeRecords(html)
      .map((attributes) => ({
        id: attributes["data-layer-id"],
        startMs: attributes["data-start"],
        durationMs: attributes["data-duration"]
      }))
      .filter((layer): layer is { id: string; startMs: string; durationMs: string } =>
        typeof layer.id === "string" && typeof layer.startMs === "string" && typeof layer.durationMs === "string"
      )
      .map((layer) => ({ id: layer.id, startMs: Number(layer.startMs), durationMs: Number(layer.durationMs) }))
  };
}

interface BrowserSessionExecution {
  browser: Browser;
  preparedNetwork: PreparedBrowserNetworkPolicy;
  metrics: BrowserRenderSessionMetrics;
  acquireContext(
    viewport: { width: number; height: number; deviceScaleFactor: number },
    networkState: BrowserFrameNetworkState
  ): Promise<BrowserContextLease>;
}

interface BrowserContextLease {
  context: BrowserContext;
  page: Page;
  release(): void;
  discard(): Promise<void>;
}

async function renderBrowserFrameInSession(
  pkg: MotionPackage,
  options: Omit<BrowserFrameOptions, "networkAccess">,
  execution: BrowserSessionExecution,
  signal?: AbortSignal
): Promise<BrowserFrameResult> {
  const preparedNetwork = execution.preparedNetwork;
  const preflight = preparedNetwork.preflight;
  if (!preflight.ok) {
    throw new Error(preflight.warnings.join("; "));
  }

  const createdAt = options.now?.() ?? new Date().toISOString();
  const outputPath = outputPathFor(pkg, options);
  const composition = await loadHtmlComposition(pkg);
  const captureHtml = await prepareBrowserCaptureHtml(pkg, composition.source, options.outDir);
  const warnings = [...preflight.warnings];
  if (options.workflow?.networkPolicy === "allow") {
    warnings.push("Workflow networkPolicy=allow is constrained by the host-approved origin policy.");
  }
  const networkState: BrowserFrameNetworkState = {
    blockedRequests: [],
    blockedWebSocketRequests: [],
    blockedExternalFileRequest: false,
    blockedDowngradeRedirects: [],
    blockedSecondaryPages: [],
    blockedForeignPageRequests: [],
    redirectGuardFailures: []
  };
  const viewport = viewportFor(pkg, options.workflow);
  const workflowHash = options.workflow ? hashBrowserCaptureWorkflow(options.workflow) : undefined;
  let workflowTrace: BrowserCaptureWorkflowTrace | undefined;
  let captureReadiness: BrowserCaptureReadiness | undefined;
  let typography: BrowserTypographyEvidence | undefined;
  let textFit: BrowserTextFitEvidence | undefined;
  const browser = execution.browser;
  const browserVersion = browser.version();
  let lease: BrowserContextLease | undefined;
  let page: Page | undefined;
  let consoleHandler: ((message: ConsoleMessage) => void) | undefined;
  let leaseDiscarded = false;
  try {
    lease = await execution.acquireContext(viewport, networkState);
    if (signal?.aborted) throw abortReason(signal);
    page = lease.page;
    consoleHandler = (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        warnings.push(`console.${message.type()}: ${message.text()}`);
      }
    };
    page.on("console", consoleHandler);
    if (captureHtml.html) {
      await page.setContent(captureHtml.html, { waitUntil: "load" });
    } else {
      await page.goto(pathToFileURL(resolvePackageAsset(pkg, composition.source)).href, { waitUntil: "load" });
    }
    await page.evaluate((atMs) => {
      document.documentElement.setAttribute("data-shellx-motion-time", String(atMs));
      (globalThis as Record<string, unknown>).__SHELLX_MOTION_TIME_MS__ = atMs;
    }, options.atMs);
    if (options.workflow && workflowHash) {
      workflowTrace = await replayBrowserWorkflow(page, options.workflow, workflowHash);
    }
    await settleGeneratedMotionMedia(page, options.atMs);
    await drawWorkflowCursor(page, options.workflow, options.atMs);
    captureReadiness = await waitForBrowserCaptureReadiness(page);
    textFit = await collectBrowserTextFitEvidence(page, pkg, options.atMs);
    enforceTextFitPolicy(textFit);
    typography = await collectBrowserTypographyEvidence(page);
    warnings.push(...fontFallbackWarnings(typography));
    enforceFontFallbackPolicy(pkg, typography);
    if (workflowTrace) workflowTrace.captureReadiness = captureReadiness;
    await mkdir(dirname(outputPath), { recursive: true });
    await captureDeterministicScreenshot(page, screenshotOptions(outputPath, options.format));
  } catch (error) {
    if ((classifyBrowserFrameFailure(error) === "transient" || page?.isClosed()) && lease) {
      leaseDiscarded = true;
      await lease.discard();
    }
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    if (page && consoleHandler) page.off("console", consoleHandler);
    if (!leaseDiscarded) lease?.release();
  }

  for (const origin of [...new Set(networkState.blockedRequests)]) {
    warnings.push(`Blocked undeclared browser request: ${origin}`);
  }
  for (const transition of [...new Set(networkState.blockedDowngradeRedirects)]) {
    warnings.push(`Blocked HTTPS-to-HTTP browser redirect downgrade: ${transition}`);
  }
  for (const url of [...new Set(networkState.blockedWebSocketRequests)]) {
    warnings.push(`Blocked browser WebSocket request: ${url}`);
  }
  for (const origin of [...new Set(networkState.blockedForeignPageRequests)]) {
    warnings.push(`Blocked browser request from a page other than the captured page: ${origin}`);
  }
  for (const origin of [...new Set(networkState.blockedSecondaryPages)]) {
    warnings.push(`Blocked browser popup or secondary page: ${origin}`);
  }
  for (const reason of [...new Set(networkState.redirectGuardFailures)]) {
    warnings.push(`Browser redirect guard stopped enforcing mid-render: ${reason}`);
  }
  if (networkState.blockedExternalFileRequest) {
    warnings.push("Blocked external browser file request.");
  }

  const outputHash = await hashFile(outputPath);
  const output = {
    path: outputPath,
    sha256: outputHash,
    format: options.format ?? "png",
    width: pkg.motion.width,
    height: pkg.motion.height,
    atMs: options.atMs,
    browser: { name: "chromium", version: browserVersion },
    viewport,
    network: preparedNetwork.evidence,
    ...(options.workflow ? { workflow: summarizeBrowserWorkflow(options.workflow) } : {}),
    ...(workflowTrace ? { workflowTrace } : {}),
    ...(captureReadiness ? { captureReadiness } : {}),
    ...(typography ? { typography } : {}),
    ...(textFit ? { textFit } : {}),
    ...(captureHtml.artifacts.length > 0 ? { artifacts: captureHtml.artifacts } : {})
  };

  return {
    ok: true,
    output,
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: `browser-preview-${outputHash.slice(0, 16)}`,
      operation: "preview.frame",
      status: previewReceiptStatus({ warnings }),
      packageId: pkg.manifest.id,
      inputHashes: {
        motion: sha256(JSON.stringify(pkg.motion)),
        html: sha256(JSON.stringify(composition)),
        ...(captureHtml.artifactSha256 ? { "browser-capture-html": captureHtml.artifactSha256 } : {}),
        ...(workflowHash ? { workflow: workflowHash } : {})
      },
      createdAt,
      lane: "browser",
      output,
      ...(captureHtml.artifacts.length > 0 ? { artifacts: captureHtml.artifacts } : {}),
      warnings
    }
  };
}

async function renderGeneratedMotionBrowserFrameInSession(
  pkg: MotionPackage,
  options: Omit<BrowserFrameOptions, "networkAccess">,
  execution: BrowserSessionExecution,
  signal?: AbortSignal
): Promise<BrowserFrameResult> {
  const createdAt = options.now?.() ?? new Date().toISOString();
  const outputPath = outputPathFor(pkg, options);
  const preparedNetwork = execution.preparedNetwork;
  if (!preparedNetwork.preflight.ok) {
    throw new Error(preparedNetwork.preflight.warnings.join("; "));
  }
  const warnings: string[] = [...preparedNetwork.preflight.warnings];
  if (options.workflow?.networkPolicy === "allow") {
    warnings.push("Workflow networkPolicy=allow is constrained by the host-approved origin policy.");
  }
  const networkState: BrowserFrameNetworkState = {
    blockedRequests: [],
    blockedWebSocketRequests: [],
    blockedExternalFileRequest: false,
    blockedDowngradeRedirects: [],
    blockedSecondaryPages: [],
    blockedForeignPageRequests: [],
    redirectGuardFailures: []
  };
  const generated = await buildGeneratedMotionHtml(pkg, options.atMs);
  warnings.push(...generated.warnings);
  const viewport = viewportFor(pkg, options.workflow);
  const workflowHash = options.workflow ? hashBrowserCaptureWorkflow(options.workflow) : undefined;
  let workflowTrace: BrowserCaptureWorkflowTrace | undefined;
  let captureReadiness: BrowserCaptureReadiness | undefined;
  let typography: BrowserTypographyEvidence | undefined;
  let textFit: BrowserTextFitEvidence | undefined;
  let webglResources: BrowserWebGLResourceEvidence | undefined;
  let keying: BrowserKeyingEvidence | undefined;
  const browser = execution.browser;
  const browserVersion = browser.version();
  let lease: BrowserContextLease | undefined;
  let page: Page | undefined;
  let consoleHandler: ((message: ConsoleMessage) => void) | undefined;
  let leaseDiscarded = false;
  try {
    lease = await execution.acquireContext(viewport, networkState);
    if (signal?.aborted) throw abortReason(signal);
    page = lease.page;
    consoleHandler = (message) => {
      if ((message.type() === "warning" || message.type() === "error") && !isIgnorableBrowserConsoleMessage(message)) {
        warnings.push(`console.${message.type()}: ${message.text()}`);
      }
    };
    page.on("console", consoleHandler);
    await page.setContent(generated.html, { waitUntil: "load" });
    await page.evaluate((atMs) => {
      document.documentElement.setAttribute("data-shellx-motion-time", String(atMs));
      (globalThis as Record<string, unknown>).__SHELLX_MOTION_TIME_MS__ = atMs;
    }, options.atMs);
    if (options.workflow && workflowHash) {
      workflowTrace = await replayBrowserWorkflow(page, options.workflow, workflowHash);
    }
    await settleGeneratedMotionShaders(page);
    await settleGeneratedMotionScenes3D(page);
    await settleGeneratedMotionEnvironments(page);
    webglResources = await freezeGeneratedMotionWebGLSurfaces(page);
    await settleGeneratedMotionMedia(page, options.atMs);
    keying = await settleGeneratedMotionKeying(page);
    await drawWorkflowCursor(page, options.workflow, options.atMs);
    captureReadiness = await waitForBrowserCaptureReadiness(page);
    textFit = await collectBrowserTextFitEvidence(page, pkg, options.atMs);
    enforceTextFitPolicy(textFit);
    typography = await collectBrowserTypographyEvidence(page);
    warnings.push(...fontFallbackWarnings(typography));
    enforceFontFallbackPolicy(pkg, typography);
    if (workflowTrace) workflowTrace.captureReadiness = captureReadiness;
    await mkdir(dirname(outputPath), { recursive: true });
    await captureDeterministicScreenshot(page, screenshotOptions(outputPath, options.format));
  } catch (error) {
    if ((classifyBrowserFrameFailure(error) === "transient" || page?.isClosed()) && lease) {
      leaseDiscarded = true;
      await lease.discard();
    }
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    if (page && consoleHandler) page.off("console", consoleHandler);
    if (!leaseDiscarded) lease?.release();
  }

  for (const origin of [...new Set(networkState.blockedRequests)]) {
    warnings.push(`Blocked undeclared browser request: ${origin}`);
  }
  for (const transition of [...new Set(networkState.blockedDowngradeRedirects)]) {
    warnings.push(`Blocked HTTPS-to-HTTP browser redirect downgrade: ${transition}`);
  }
  for (const url of [...new Set(networkState.blockedWebSocketRequests)]) {
    warnings.push(`Blocked browser WebSocket request: ${url}`);
  }
  for (const origin of [...new Set(networkState.blockedForeignPageRequests)]) {
    warnings.push(`Blocked browser request from a page other than the captured page: ${origin}`);
  }
  for (const origin of [...new Set(networkState.blockedSecondaryPages)]) {
    warnings.push(`Blocked browser popup or secondary page: ${origin}`);
  }
  for (const reason of [...new Set(networkState.redirectGuardFailures)]) {
    warnings.push(`Browser redirect guard stopped enforcing mid-render: ${reason}`);
  }
  if (networkState.blockedExternalFileRequest) {
    warnings.push("Blocked external browser file request.");
  }

  const inputHashes: Record<string, string> = {
    motion: sha256(JSON.stringify(pkg.motion)),
    ...(workflowHash ? { workflow: workflowHash } : {})
  };
  for (const assetRef of generated.assetRefs) {
    inputHashes[assetRef] = generated.assetHashes[assetRef] ?? await hashFile(resolvePackageAsset(pkg, assetRef));
  }
  const outputHash = await hashFile(outputPath);
  const output = {
    path: outputPath,
    sha256: outputHash,
    format: options.format ?? "png",
    width: pkg.motion.width,
    height: pkg.motion.height,
    atMs: options.atMs,
    browser: { name: "chromium", version: browserVersion },
    viewport,
    network: preparedNetwork.evidence,
    ...(options.workflow ? { workflow: summarizeBrowserWorkflow(options.workflow) } : {}),
    ...(workflowTrace ? { workflowTrace } : {}),
    ...(captureReadiness ? { captureReadiness } : {}),
    ...(typography ? { typography } : {}),
    ...(textFit ? { textFit } : {}),
    ...(generated.temporalSampling ? { temporalSampling: generated.temporalSampling } : {}),
    ...(generated.shaders ? { shaders: generated.shaders } : {}),
    ...(generated.scenes3d ? { scenes3d: generated.scenes3d } : {}),
    ...(generated.environments ? { environments: generated.environments } : {}),
    ...(keying ? { keying } : {}),
    ...(webglResources ? { webglResources } : {}),
    // Structured evidence, NOT a warning: audio layers this lane passed to ffmpeg (the success-status invariant).
    ...(generated.audioHandoff ? { audioHandoff: generated.audioHandoff } : {})
  };

  return {
    ok: true,
    output,
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: `browser-preview-${outputHash.slice(0, 16)}`,
      operation: "preview.frame",
      status: previewReceiptStatus({ warnings }),
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt,
      lane: "browser",
      output,
      warnings
    }
  };
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new BrowserFrameCancelledError();
}

function isIgnorableBrowserConsoleMessage(message: ConsoleMessage): boolean {
  const text = message.text();
  return message.type() === "warning"
    && text.includes("GL Driver Message")
    && text.includes("GPU stall due to ReadPixels");
}

function attachBrowserResourceEvidence(result: BrowserFrameResult, evidence: LocalMotionJobEvidence): BrowserFrameResult {
  result.output.resources = evidence;
  result.receipt.output = result.output;
  return result;
}

function boundedBrowserFrameConcurrency(value = 2): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error("Browser frame concurrency must be an integer from 1 to 8.");
  }
  return value;
}

function boundedBrowserFrameTimeout(value = 30_000): number {
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new Error("Browser per-frame timeout must be an integer from 100 to 120000ms.");
  }
  return value;
}

function boundedBrowserFrameAttempts(value = 2): number {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("Browser frame attempts must be an integer from 1 to 3.");
  }
  return value;
}

/**
 * Runtime capability gate for the browser lane, mirroring the native lane's `matchRendererCapability`
 * check at render entry (renderer-native applies the same gate before rasterizing a frame).
 *
 * The browser lane is the deterministic frame lane that feeds the final ffmpeg encode, so audio
 * layers/features are legitimately unsupported here and are muxed downstream — those are tolerated
 * (`isAudioOnlyFrameLaneUnsupported`). Any other unsupported layer type or feature is a genuine
 * mismatch: fail closed with a deterministic error rather than silently rendering a frame that
 * drops the requested content.
 *
 * @param pkg The (already compositing-prepared) package about to be rendered.
 * @throws Error when the motion document uses a non-audio layer type/feature the browser lane cannot render.
 */
function assertBrowserLaneCapability(pkg: MotionPackage): void {
  const capability = matchRendererCapability(pkg.motion, BROWSER_CAPABILITY);
  if (capability.ok) return;
  const blocking = capability.unsupported.filter((item) => !isAudioOnlyFrameLaneUnsupported(item.feature));
  if (blocking.length === 0) return;
  const unsupportedLayerCount = new Set(blocking.map((item) => item.layerId)).size;
  throw new Error(
    `Browser lane cannot render ${blocking.length} unsupported ${blocking.length === 1 ? "feature" : "features"} `
    + `across ${unsupportedLayerCount} ${unsupportedLayerCount === 1 ? "layer" : "layers"}: `
    + `${blocking.map((item) => item.reason).join("; ")}`
  );
}

export async function createMotionBrowserRenderSession(
  sourcePackage: MotionPackage,
  options: BrowserRenderSessionOptions = {}
): Promise<MotionBrowserRenderSession> {
  const pkg = prepareCompositingRenderPackage(sourcePackage);
  assertLocalMotionFrameBudget(viewportFor(pkg, undefined));
  assertBrowserLaneCapability(pkg);
  // Rendering a document whose keyframes the evaluator silently drops produces a motionless file and
  // a `passed` receipt — the defect this gate exists to make impossible. Core owns the verdict.
  assertReadableMotionKeyframes(pkg.motion);
  const preparedNetwork = await prepareBrowserNetworkPolicy(pkg, options.networkAccess ?? {});
  if (!preparedNetwork.preflight.ok) {
    throw new Error(preparedNetwork.preflight.warnings.join("; "));
  }
  const packageRootPath = await canonicalPathForBrowserSafety(pkg.root);
  const packageFingerprint = await browserPackageFingerprint(packageRootPath);
  const launchOptions = {
    executablePath: findBrowserExecutable(),
    headless: true as const,
    // Motion owns its own interrupt policy. Playwright's defaults install SIGINT/SIGTERM/SIGHUP
    // handlers that call process.exit(130) as soon as a signal arrives, which killed the host
    // before a cancelled render could finish tearing down and report what happened — observed as
    // Ctrl-C producing no output at all. Motion still closes the browser on abort; it just does
    // so on its own terms.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [...resolveChromiumLaunchArgs(), ...preparedNetwork.chromiumArgs],
    // Playwright passes the parent environment to the browser process when `env` is
    // omitted, so Chromium -- which renders package-controlled HTML and runs package-controlled
    // JavaScript -- was started holding SHELLX_MOTION_DEBUG_TOKEN. Redacted here.
    env: childEnvironment()
  };
  const browser = options.launchBrowser
    ? await options.launchBrowser(launchOptions)
    : await chromium.launch(launchOptions);
  const metrics: BrowserRenderSessionMetrics = {
    browserLaunches: 1,
    framesRendered: 0,
    contextsCreated: 0,
    pagesCreated: 0,
    activeFrames: 0,
    peakConcurrentFrames: 0,
    frameCacheHits: 0,
    frameRetries: 0
  };
  const contextPool: Array<{
    key: string;
    context: BrowserContext;
    page?: Page;
    busy: boolean;
    networkState?: BrowserFrameNetworkState;
    /**
     * Per-LEASE, not per-context: the route policy's memory of which frames have committed an
     * https document. Reset on every lease so a pooled page cannot carry one frame's document
     * scheme into the next frame's verdicts — renders must be independent of pool reuse.
     */
    documentScheme: BrowserDocumentSchemeMemory;
  }> = [];
  const acquireContext: BrowserSessionExecution["acquireContext"] = async (viewport, networkState) => {
    const key = `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`;
    let worker = contextPool.find((candidate) => !candidate.busy && candidate.key === key);
    if (!worker) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        serviceWorkers: "block"
      });
      worker = { key, context, busy: true, networkState, documentScheme: createBrowserDocumentSchemeMemory() };
      contextPool.push(worker);
      metrics.contextsCreated += 1;
      try {
        await context.routeWebSocket("**/*", async (webSocket) => {
          worker!.networkState?.blockedWebSocketRequests.push(webSocket.url());
          await webSocket.close({ code: 1008, reason: "Browser WebSocket egress is disabled." });
        });
        await disableBrowserPeerConnections(context);
        await context.route("**/*", async (route) => {
          const state = worker!.networkState;
          if (!state) {
            await route.abort("blockedbyclient");
            return;
          }
          // The verdict logic lives in authorizeBrowserRouteRequest so the origin, popup and
          // downgrade rules stay unit-testable: an HTTPS redirect hop cannot be staged against the
          // plain-HTTP local servers the test suite can run, but the decision function can be fed
          // a synthetic redirect chain directly. Redirect hops themselves never re-enter this
          // handler on current Playwright — their per-hop revalidation happens pre-egress in the
          // response-stage guard attached below.
          const verdict = await authorizeBrowserRouteRequest(
            route.request(),
            { allowedOrigins: preparedNetwork.allowedOrigins, packageRootPath, renderPage: worker!.page, documentScheme: worker!.documentScheme },
            state
          );
          if (verdict === "continue") {
            await route.continue();
          } else {
            // "blockedbyclient", not the default "failed": Chromium auto-reloads an error page
            // produced by a generic network failure, and the retry re-issued a refused cleartext
            // navigation from a chrome-error: frame — measured as a second attempt that reached
            // the wire. A policy block is not a network failure and must not be retried.
            await route.abort("blockedbyclient");
          }
        });
        worker.page = await context.newPage();
        // Registered AFTER the render page exists, so the render page's own "page" event has
        // already fired and everything this listener sees is a popup or new window. A frame render
        // captures exactly one page: a second page can contribute no pixels but can egress, so it
        // is recorded (making a silent `passed` receipt impossible) and closed. Its requests were
        // already refused at the route layer, which is the race-free half of the same rule.
        context.on("page", (popup) => {
          worker!.networkState?.blockedSecondaryPages.push(remoteOrigin(popup.url()) ?? popup.url());
          void popup.close().catch(() => undefined);
        });
        // Primary redirect enforcement: refuses HTTPS->HTTP downgrades and unapproved redirect
        // targets at the 3xx response, before the hop request exists. Attached inside this try
        // block so an attach failure discards the context — no page renders unguarded.
        await attachBrowserRedirectGuard(context, worker.page, preparedNetwork.allowedOrigins, () => worker!.networkState);
        metrics.pagesCreated += 1;
      } catch (error) {
        contextPool.splice(contextPool.indexOf(worker), 1);
        await context.close().catch(() => undefined);
        throw error;
      }
    } else {
      worker.busy = true;
      worker.networkState = networkState;
      worker.documentScheme = createBrowserDocumentSchemeMemory();
    }
    const leasedWorker = worker;
    if (!leasedWorker.page) throw new Error("Browser render worker has no page.");
    return {
      context: leasedWorker.context,
      page: leasedWorker.page,
      release() {
        leasedWorker.networkState = undefined;
        leasedWorker.busy = false;
      },
      async discard() {
        const index = contextPool.indexOf(leasedWorker);
        if (index >= 0) contextPool.splice(index, 1);
        leasedWorker.networkState = undefined;
        leasedWorker.busy = true;
        await leasedWorker.context.close().catch(() => undefined);
      }
    };
  };
  const execution: BrowserSessionExecution = { browser, preparedNetwork, metrics, acquireContext };
  const pending = new Set<Promise<BrowserFrameResult>>();
  const frameCache = new Map<string, { path: string; sha256: string; result: BrowserFrameResult }>();
  let closed = false;
  let browserClose: Promise<void> | undefined;
  const terminateBrowser = () => {
    browserClose ??= browser.close();
    return browserClose;
  };

  const renderOne = (
    frameOptions: Omit<BrowserFrameOptions, "networkAccess">,
    signal?: AbortSignal
  ): Promise<BrowserFrameResult> => {
    if (closed) {
      return Promise.reject(new Error("Motion browser render session is closed."));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    assertLocalMotionFrameBudget(viewportFor(pkg, frameOptions.workflow));
    const cacheKey = sha256(JSON.stringify({
      packageId: pkg.manifest.id,
      motion: pkg.motion,
      atMs: frameOptions.atMs,
      format: frameOptions.format ?? "png",
      viewport: viewportFor(pkg, frameOptions.workflow),
      workflow: frameOptions.workflow ? hashBrowserCaptureWorkflow(frameOptions.workflow) : null
    }));
    const cached = frameCache.get(cacheKey);
    if (cached) {
      const reuse = (async () => {
        if (await browserPackageFingerprint(packageRootPath) !== packageFingerprint) {
          throw new Error("Browser render package changed during the active session; create a new session.");
        }
        let cachedHash: string | undefined;
        try {
          cachedHash = await hashFile(cached.path);
        } catch {
          cachedHash = undefined;
        }
        if (cachedHash !== cached.sha256) {
          frameCache.delete(cacheKey);
          return renderOne(frameOptions, signal);
        }
        const outputPath = outputPathFor(pkg, frameOptions);
        await mkdir(dirname(outputPath), { recursive: true });
        if (resolve(outputPath) !== resolve(cached.path)) await copyFile(cached.path, outputPath);
        metrics.framesRendered += 1;
        metrics.frameCacheHits += 1;
        const result = structuredClone(cached.result);
        result.output.path = outputPath;
        result.output.renderSession = { ...metrics };
        result.receipt.createdAt = frameOptions.now?.() ?? new Date().toISOString();
        result.receipt.output = result.output;
        return result;
      })();
      pending.add(reuse);
      void reuse.then(
        () => pending.delete(reuse),
        () => pending.delete(reuse)
      );
      return reuse;
    }
    metrics.activeFrames += 1;
    metrics.peakConcurrentFrames = Math.max(metrics.peakConcurrentFrames, metrics.activeFrames);
    const render = (browserLayers(pkg).length > 0
      ? renderBrowserFrameInSession(pkg, frameOptions, execution, signal)
      : renderGeneratedMotionBrowserFrameInSession(pkg, frameOptions, execution, signal)
    ).then((result) => {
      metrics.framesRendered += 1;
      result.output.renderSession = { ...metrics, activeFrames: metrics.activeFrames - 1 };
      result.receipt.output = result.output;
      frameCache.set(cacheKey, {
        path: result.output.path,
        sha256: result.output.sha256,
        result: structuredClone(result)
      });
      return result;
    }).finally(() => {
      metrics.activeFrames -= 1;
    });
    pending.add(render);
    void render.then(
      () => pending.delete(render),
      () => pending.delete(render)
    );
    return render;
  };

  return {
    browserVersion: browser.version(),
    metrics,
    renderFrame(frameOptions) {
      return (options.governor ?? defaultLocalMotionJobGovernor).run({
        lane: "browser",
        operation: "browser.preview.frame",
        scratchRoot: frameOptions.outDir,
        ...(options.callerId ? { callerId: options.callerId } : {}),
        ...(options.jobId ? { jobId: options.jobId } : {}),
      }, async ({ signal, watchProcess, reportProcessContainment, reportSandbox }) => {
        // Playwright does not expose Chromium's PID; monitoring the Node process tree covers its
        // renderer descendants on Linux/macOS and the owning Node process on Windows.
        reportProcessContainment({
          schema: "shellx-motion/process-containment@1",
          mode: "cooperative-browser-session",
          status: "fallback",
          killTree: false,
          memoryLimit: "rss-monitor",
          reasonCode: "worker_process_unavailable",
        });
        reportSandbox(chromiumRuntimeSandboxEvidence(launchOptions.args));
        watchProcess(process.pid);
        const abortFrame = () => {
          closed = true;
          void terminateBrowser().catch(() => undefined);
        };
        signal.addEventListener("abort", abortFrame, { once: true });
        if (signal.aborted) abortFrame();
        try {
          return await renderOne(frameOptions, signal);
        } finally {
          signal.removeEventListener("abort", abortFrame);
        }
      }).then(({ value, evidence }) => attachBrowserResourceEvidence(value, evidence));
    },
    async renderFrames(frames, batchOptions = {}) {
      if (closed) throw new Error("Motion browser render session is closed.");
      assertLocalMotionFrameCountBudget(frames.length);
      if (frames.length === 0) return [];
      const governed = await (options.governor ?? defaultLocalMotionJobGovernor).run({
        lane: "browser",
        operation: "browser.preview.frames",
        scratchRoot: frames[0].outDir,
        signal: batchOptions.signal,
        ...(options.callerId ? { callerId: options.callerId } : {}),
        ...(options.jobId ? { jobId: options.jobId } : {}),
      }, async ({ signal, watchProcess, reportProcessContainment, reportSandbox }) => {
        reportProcessContainment({
          schema: "shellx-motion/process-containment@1",
          mode: "cooperative-browser-session",
          status: "fallback",
          killTree: false,
          memoryLimit: "rss-monitor",
          reasonCode: "worker_process_unavailable",
        });
        reportSandbox(chromiumRuntimeSandboxEvidence(launchOptions.args));
        watchProcess(process.pid);
        const maxConcurrency = boundedBrowserFrameConcurrency(batchOptions.maxConcurrency);
        const perFrameTimeoutMs = boundedBrowserFrameTimeout(batchOptions.perFrameTimeoutMs);
        const maxFrameAttempts = boundedBrowserFrameAttempts(batchOptions.maxFrameAttempts);
        const batchController = new AbortController();
        const failBatch = (error: unknown) => {
          if (!batchController.signal.aborted) batchController.abort(error);
          closed = true;
          void terminateBrowser().catch(() => undefined);
        };
        const abortBatch = () => failBatch(abortReason(signal));
        if (signal.aborted) abortBatch();
        signal.addEventListener("abort", abortBatch, { once: true });
        const results = new Array<BrowserFrameResult>(frames.length);
        let nextIndex = 0;
        let completed = 0;
        const worker = async () => {
          while (true) {
            if (batchController.signal.aborted) throw abortReason(batchController.signal);
            const index = nextIndex;
            nextIndex += 1;
            if (index >= frames.length) return;
            const timeoutController = new AbortController();
            const relayAbort = () => timeoutController.abort(abortReason(batchController.signal));
            batchController.signal.addEventListener("abort", relayAbort, { once: true });
            const timeout = setTimeout(() => {
              const error = new BrowserFrameTimeoutError(perFrameTimeoutMs);
              timeoutController.abort(error);
              failBatch(error);
            }, perFrameTimeoutMs);
            try {
              let result: BrowserFrameResult | undefined;
              for (let attempt = 1; attempt <= maxFrameAttempts; attempt += 1) {
                try {
                  result = await renderOne(frames[index], timeoutController.signal);
                  break;
                } catch (error) {
                  if (
                    attempt >= maxFrameAttempts
                    || classifyBrowserFrameFailure(error) !== "transient"
                    || timeoutController.signal.aborted
                  ) {
                    throw error;
                  }
                  metrics.frameRetries += 1;
                }
              }
              if (!result) throw new Error("Browser frame retry loop produced no result.");
              results[index] = result;
              completed += 1;
              batchOptions.onProgress?.({ completed, total: frames.length, index, atMs: frames[index].atMs });
            } catch (error) {
              failBatch(error);
              throw error;
            } finally {
              clearTimeout(timeout);
              batchController.signal.removeEventListener("abort", relayAbort);
            }
          }
        };
        try {
          await Promise.all(Array.from({ length: Math.min(maxConcurrency, frames.length) }, () => worker()));
          const finalMetrics = { ...metrics };
          for (const result of results) {
            result.output.renderSession = finalMetrics;
            result.receipt.output = result.output;
          }
          return results;
        } finally {
          signal.removeEventListener("abort", abortBatch);
        }
      });
      return governed.value.map((result) => attachBrowserResourceEvidence(result, governed.evidence));
    },
    async close() {
      closed = true;
      await terminateBrowser();
      await Promise.allSettled([...pending]);
    }
  };
}

export async function renderBrowserFrame(pkg: MotionPackage, options: BrowserFrameOptions): Promise<BrowserFrameResult> {
  if (browserLayers(pkg).length === 0) {
    throw new Error(`Package ${pkg.manifest.id} does not contain a browser layer.`);
  }
  return renderMotionBrowserFrame(pkg, options);
}

export async function renderMotionBrowserFrame(
  pkg: MotionPackage,
  options: BrowserFrameOptions
): Promise<BrowserFrameResult> {
  const session = await createMotionBrowserRenderSession(pkg, { networkAccess: options.networkAccess });
  try {
    return await session.renderFrame(options);
  } finally {
    await session.close();
  }
}

async function prepareBrowserCaptureHtml(
  pkg: MotionPackage,
  source: string,
  outDir: string
): Promise<BrowserCaptureHtmlPreparation> {
  const sourcePath = resolvePackageAsset(pkg, source);
  const html = await readFile(sourcePath, "utf8");
  const inlineResult = await inlineBrowserCompositionSources(pkg, sourcePath, html);
  if (inlineResult.sourceCount === 0) return { artifacts: [] };

  const preparedHtml = injectBrowserCaptureBase(inlineResult.html, packageRootBaseHref(pkg.root));
  const artifactSha256 = sha256(preparedHtml);
  const artifactDir = join(resolve(outDir), "browser-capture-html");
  const artifactPath = join(artifactDir, `${safeFileToken(pkg.manifest.id)}-${artifactSha256.slice(0, 16)}.html`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, preparedHtml, "utf8");
  const artifacts: ReceiptArtifact[] = [{
    role: "browser_capture_html",
    path: artifactPath,
    status: "available",
    mediaType: "text/html",
    primary: true
  }];
  return { html: preparedHtml, artifactPath, artifactSha256, artifacts };
}

async function inlineBrowserCompositionSources(
  pkg: MotionPackage,
  sourcePath: string,
  html: string
): Promise<{ html: string; sourceCount: number }> {
  // Bounded scan, not a regex. This used
  // `/<([A-Za-z][\w:-]*)\b([^>]*\bdata-composition-src\s*=\s*(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi`,
  // whose lazy body plus `\1` backreference re-scans the document once per candidate opening tag.
  // Measured on this repository: 36 KB of unclosed `<div data-composition-src="…">` blocked the
  // event loop for 3.7 ms, 288 KB for 217.7 ms — 4x per doubling, clean quadratic — and a long
  // attribute run that never reaches a `>` cost 6.1 ms at 25 KB and 390.8 ms at 199 KB. The input is
  // package-local HTML from an untrusted package and the sibling importer accepts 8 MiB, so the
  // reachable size is far past those. `scanMarkupAttributeTagPairs` reproduces the regex's match
  // set exactly (verified by 305 000 differential fuzz documents against the regex as oracle) in a
  // single forward pass.
  const matches = scanMarkupAttributeTagPairs(html, "data-composition-src");
  if (matches.length === 0) return { html, sourceCount: 0 };

  let output = "";
  let lastIndex = 0;
  let sourceCount = 0;
  for (const match of matches) {
    const compositionSource = match.value;
    const compositionPath = await resolveBrowserCompositionSource(pkg, sourcePath, compositionSource);
    const compositionHtml = await readFile(compositionPath, "utf8");
    const cleanAttrs = removeFirstMarkupAttribute(match.attrText, "data-composition-src");
    output += html.slice(lastIndex, match.start);
    output += `<${match.tagName}${cleanAttrs} data-shellx-motion-inlined-composition-src="${escapeAttr(compositionSource)}">${compositionHtml}</${match.tagName}>`;
    lastIndex = match.end;
    sourceCount += 1;
  }
  output += html.slice(lastIndex);
  return { html: output, sourceCount };
}


async function resolveBrowserCompositionSource(pkg: MotionPackage, sourcePath: string, compositionSource: string): Promise<string> {
  if (remoteOrigin(compositionSource)) {
    throw new Error(`Browser composition source must be package-local: ${compositionSource}`);
  }
  const targetPath = resolve(dirname(sourcePath), compositionSource);
  const packageRootPath = await canonicalPathForBrowserSafety(pkg.root);
  const canonicalTarget = await canonicalPathForBrowserSafety(targetPath);
  if (!isPathInsideOrEqual(packageRootPath, canonicalTarget)) {
    throw new Error(`Browser composition source escapes the Motion package root: ${compositionSource}`);
  }
  return canonicalTarget;
}

function injectBrowserCaptureBase(html: string, href: string): string {
  if (/<base\b/i.test(html)) return html;
  const base = `<base href="${escapeAttr(href)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${base}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (root) => `${root}\n<head>${base}</head>`);
  }
  return `<head>${base}</head>\n${html}`;
}

function packageRootBaseHref(packageRoot: string): string {
  const href = pathToFileURL(resolve(packageRoot)).href;
  return href.endsWith("/") ? href : `${href}/`;
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "capture";
}

async function waitForBrowserCaptureReadiness(page: Page): Promise<BrowserCaptureReadiness> {
  const started = Date.now();
  const stylesheetLinkCount = await page.evaluate(async () => {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet']"));
    await Promise.all(links.map((link) => new Promise<void>((resolveReady) => {
      try {
        if (link.sheet) {
          void link.sheet.cssRules;
          resolveReady();
          return;
        }
      } catch {
        resolveReady();
        return;
      }
      const done = () => resolveReady();
      link.addEventListener("load", done, { once: true });
      link.addEventListener("error", done, { once: true });
      setTimeout(done, 2000);
    })));
    return links.length;
  }).catch(() => 0);

  const fontReadiness = await page.evaluate(async () => {
    const fontSet = (document as Document & {
      fonts?: {
        ready?: Promise<unknown>;
        forEach?: (callback: (face: { load?: () => Promise<unknown>; status?: string }) => void) => void;
      };
    }).fonts;
    if (!fontSet || typeof fontSet.ready?.then !== "function") {
      return { status: "unsupported" as const, fontFaceCount: 0, fontFaceLoadAttemptCount: 0, fontFaceLoadedCount: 0 };
    }
    try {
      const faces: Array<{ load?: () => Promise<unknown>; status?: string }> = [];
      fontSet.forEach?.((face) => faces.push(face));
      const loads: Promise<boolean>[] = [];
      fontSet.forEach?.((face) => {
        if (typeof face.load === "function") loads.push(face.load().then(() => true).catch(() => false));
      });
      const status = await Promise.race([
        Promise.all(loads)
          .then(() => fontSet.ready)
          .then(() => "ready" as const)
          .catch(() => "error" as const),
        new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 3000))
      ]);
      return {
        status,
        fontFaceCount: faces.length,
        fontFaceLoadAttemptCount: loads.length,
        fontFaceLoadedCount: faces.filter((face) => face.status === "loaded").length
      };
    } catch {
      return { status: "error" as const, fontFaceCount: 0, fontFaceLoadAttemptCount: 0, fontFaceLoadedCount: 0 };
    }
  }).catch(() => ({ status: "error" as const, fontFaceCount: 0, fontFaceLoadAttemptCount: 0, fontFaceLoadedCount: 0 }));

  const animationProbe = await page.evaluate(() => {
    const parseTimeMs = (raw: string | undefined): number => {
      const value = String(raw ?? "0s").trim();
      if (!value || value === "initial" || value === "inherit" || value === "unset") return 0;
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed)) return 0;
      return value.endsWith("ms") ? parsed : parsed * 1000;
    };
    const valueAt = (values: string[], index: number): string | undefined => values[index] ?? values[values.length - 1];
    let finiteAnimationCount = 0;
    let finiteAnimationMaxMs = 0;
    let finiteTransitionCount = 0;
    let finiteTransitionMaxMs = 0;

    for (const element of Array.from(document.querySelectorAll("*"))) {
      const style = getComputedStyle(element);
      const animationDurations = style.animationDuration.split(",");
      const animationDelays = style.animationDelay.split(",");
      const animationIterations = style.animationIterationCount.split(",");
      for (let index = 0; index < animationDurations.length; index += 1) {
        const iterationValue = String(valueAt(animationIterations, index) ?? "1").trim();
        if (iterationValue === "infinite") continue;
        const iterations = Number.parseFloat(iterationValue);
        const multiplier = Number.isFinite(iterations) && iterations > 0 ? iterations : 1;
        const totalMs = parseTimeMs(valueAt(animationDelays, index)) + (parseTimeMs(valueAt(animationDurations, index)) * multiplier);
        if (totalMs > 0) {
          finiteAnimationCount += 1;
          finiteAnimationMaxMs = Math.max(finiteAnimationMaxMs, Math.round(totalMs));
        }
      }

      const transitionDurations = style.transitionDuration.split(",");
      const transitionDelays = style.transitionDelay.split(",");
      for (let index = 0; index < transitionDurations.length; index += 1) {
        const totalMs = parseTimeMs(valueAt(transitionDelays, index)) + parseTimeMs(valueAt(transitionDurations, index));
        if (totalMs > 0) {
          finiteTransitionCount += 1;
          finiteTransitionMaxMs = Math.max(finiteTransitionMaxMs, Math.round(totalMs));
        }
      }
    }

    return {
      finiteAnimationCount,
      finiteAnimationMaxMs,
      finiteTransitionCount,
      finiteTransitionMaxMs
    };
  }).catch(() => ({
    finiteAnimationCount: 0,
    finiteAnimationMaxMs: 0,
    finiteTransitionCount: 0,
    finiteTransitionMaxMs: 0
  }));

  await page.evaluate(() => new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  })).catch(() => {});

  return {
    schema: "shellx-motion/browser-capture-readiness@1",
    page: "loaded",
    stylesheets: "settled",
    fonts: fontReadiness.status,
    animationPolicy: "screenshot-disabled",
    media: "settled-after-time-seek",
    waitMs: Date.now() - started,
    diagnostics: {
      stylesheetLinkCount,
      fontFaceCount: fontReadiness.fontFaceCount,
      fontFaceLoadAttemptCount: fontReadiness.fontFaceLoadAttemptCount,
      fontFaceLoadedCount: fontReadiness.fontFaceLoadedCount,
      finiteAnimationCount: animationProbe.finiteAnimationCount,
      finiteAnimationMaxMs: animationProbe.finiteAnimationMaxMs,
      finiteTransitionCount: animationProbe.finiteTransitionCount,
      finiteTransitionMaxMs: animationProbe.finiteTransitionMaxMs
    }
  };
}

async function replayBrowserWorkflow(page: Page, workflow: BrowserCaptureWorkflow, workflowHash: string): Promise<BrowserCaptureWorkflowTrace> {
  const trace: BrowserCaptureWorkflowTrace = {
    schema: "shellx-motion/browser-workflow-trace@1",
    workflowHash,
    stepCount: workflow.steps.length,
    steps: [],
    ...(workflow.cursor ? { cursor: { visible: workflow.cursor.visible, pointCount: workflow.cursor.path?.length ?? 0 } } : {})
  };
  for (const [index, step] of workflow.steps.entries()) {
    try {
      if (step.action === "wait") {
        await page.waitForTimeout(step.ms);
        trace.steps.push(passedWorkflowTraceStep(index, step));
        continue;
      }
      if (step.action === "click") {
        await page.locator(step.selector).click();
        trace.steps.push(passedWorkflowTraceStep(index, step));
        continue;
      }
      if (step.action === "type") {
        await page.locator(step.selector).click();
        await page.keyboard.type(step.text);
        trace.steps.push(passedWorkflowTraceStep(index, step));
        continue;
      }
      if (step.action === "press") {
        await page.locator(step.selector).press(step.key);
        trace.steps.push(passedWorkflowTraceStep(index, step));
        continue;
      }
      if (step.action === "scroll") {
        await page.mouse.wheel(step.x ?? 0, step.y ?? 0);
        trace.steps.push(passedWorkflowTraceStep(index, step));
        continue;
      }
      if (step.action === "verify") {
        const locator = page.locator(step.selector);
        if (step.text !== undefined) {
          const text = await locator.textContent();
          if (!text?.includes(step.text)) {
            const failedStep = failedWorkflowTraceStep(index, step, textMismatchWorkflowTraceError(step, text ?? ""));
            trace.steps.push(failedStep);
            throw new BrowserWorkflowReplayError(trace, failedStep);
          }
        } else {
          await locator.waitFor({ state: "visible" });
        }
        trace.steps.push(passedWorkflowTraceStep(index, step));
      }
    } catch (error) {
      if (error instanceof BrowserWorkflowReplayError) throw error;
      const failedStep = failedWorkflowTraceStep(index, step, actionFailedWorkflowTraceError(index, step));
      trace.steps.push(failedStep);
      throw new BrowserWorkflowReplayError(trace, failedStep);
    }
  }
  return trace;
}

function passedWorkflowTraceStep(index: number, step: BrowserCaptureWorkflowStep): BrowserCaptureWorkflowTraceStep {
  return { index, action: redactWorkflowStep(step), status: "passed" };
}

function failedWorkflowTraceStep(
  index: number,
  step: BrowserCaptureWorkflowStep,
  error: BrowserCaptureWorkflowTraceError
): BrowserCaptureWorkflowTraceStep {
  return { index, action: redactWorkflowStep(step), status: "failed", error };
}

function textMismatchWorkflowTraceError(step: Extract<BrowserCaptureWorkflowStep, { action: "verify" }>, actualText: string): BrowserCaptureWorkflowTraceError {
  return {
    code: "text_mismatch",
    message: `Expected selector ${step.selector} text to contain requested workflow text.`,
    selector: step.selector,
    expectedTextLength: step.text?.length ?? 0,
    actualTextLength: actualText.length,
    actualTextSha256: sha256(actualText)
  };
}

function actionFailedWorkflowTraceError(index: number, step: BrowserCaptureWorkflowStep): BrowserCaptureWorkflowTraceError {
  return {
    code: "action_failed",
    message: `Browser workflow ${step.action} failed at step ${index}.`,
    ...("selector" in step ? { selector: step.selector } : {})
  };
}

async function drawWorkflowCursor(page: Page, workflow: BrowserCaptureWorkflow | undefined, atMs: number): Promise<void> {
  const point = workflowCursorPointAtMs(workflow, atMs);
  if (!point) return;
  await page.evaluate(({ x, y }) => {
    const previous = document.querySelector("[data-shellx-motion-cursor='true']");
    previous?.remove();
    const cursor = document.createElement("div");
    cursor.setAttribute("data-shellx-motion-cursor", "true");
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.cssText = [
      "position:fixed",
      `left:${x}px`,
      `top:${y}px`,
      "width:22px",
      "height:28px",
      "pointer-events:none",
      "z-index:2147483647",
      "transform:translate(-2px,-2px)",
      "background:#111827",
      "clip-path:polygon(0 0,0 22px,6px 17px,10px 27px,15px 25px,11px 15px,21px 15px)",
      "filter:drop-shadow(0 1px 1px rgba(255,255,255,0.85))"
    ].join(";");
    (document.body ?? document.documentElement).appendChild(cursor);
  }, point);
}

function workflowCursorPointAtMs(
  workflow: BrowserCaptureWorkflow | undefined,
  atMs: number
): { x: number; y: number } | null {
  if (!workflow?.cursor || workflow.cursor.visible === false) return null;
  const points = (workflow.cursor.path ?? [])
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.atMs))
    .sort((left, right) => left.atMs - right.atMs);
  if (points.length === 0) return null;
  if (atMs <= points[0].atMs) return { x: points[0].x, y: points[0].y };
  const last = points[points.length - 1];
  if (atMs >= last.atMs) return { x: last.x, y: last.y };

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (atMs < current.atMs || atMs > next.atMs) continue;
    const span = next.atMs - current.atMs;
    if (span <= 0) return { x: next.x, y: next.y };
    const progress = clamp((atMs - current.atMs) / span, 0, 1);
    return {
      x: current.x + (next.x - current.x) * progress,
      y: current.y + (next.y - current.y) * progress
    };
  }

  return { x: last.x, y: last.y };
}

function viewportFor(pkg: MotionPackage, workflow: BrowserCaptureWorkflow | undefined): { width: number; height: number; deviceScaleFactor: number } {
  return {
    width: workflow?.viewport?.width ?? pkg.motion.width,
    height: workflow?.viewport?.height ?? pkg.motion.height,
    deviceScaleFactor: workflow?.viewport?.deviceScaleFactor ?? 1
  };
}

function summarizeBrowserWorkflow(workflow: BrowserCaptureWorkflow): BrowserCaptureWorkflowSummary {
  return {
    schema: workflow.schema,
    networkPolicy: workflow.networkPolicy ?? "blocked-unless-declared",
    stepCount: workflow.steps.length,
    steps: workflow.steps.map(redactWorkflowStep),
    ...(workflow.cursor ? { cursor: { visible: workflow.cursor.visible, pointCount: workflow.cursor.path?.length ?? 0 } } : {})
  };
}

export function hashBrowserCaptureWorkflow(workflow: BrowserCaptureWorkflow): string {
  return sha256(canonicalJson(canonicalBrowserCaptureWorkflow(workflow)));
}

function canonicalBrowserCaptureWorkflow(workflow: BrowserCaptureWorkflow): Record<string, unknown> {
  return {
    schema: "shellx-motion/browser-workflow@1",
    networkPolicy: workflow.networkPolicy ?? "blocked-unless-declared",
    ...(workflow.viewport ? {
      viewport: {
        width: workflow.viewport.width,
        height: workflow.viewport.height,
        deviceScaleFactor: workflow.viewport.deviceScaleFactor ?? 1
      }
    } : {}),
    steps: workflow.steps.map(canonicalBrowserWorkflowStep),
    ...(workflow.cursor ? {
      cursor: {
        visible: workflow.cursor.visible,
        path: (workflow.cursor.path ?? [])
          .map((point) => ({ x: point.x, y: point.y, atMs: point.atMs }))
          .sort((left, right) => left.atMs - right.atMs || left.x - right.x || left.y - right.y)
      }
    } : {})
  };
}

function canonicalBrowserWorkflowStep(step: BrowserCaptureWorkflowStep): Record<string, unknown> {
  if (step.action === "wait") return { action: "wait", ms: step.ms };
  if (step.action === "click") return { action: "click", selector: step.selector };
  if (step.action === "type") return { action: "type", selector: step.selector, text: step.text };
  if (step.action === "press") return { action: "press", selector: step.selector, key: step.key };
  if (step.action === "scroll") return { action: "scroll", x: step.x ?? 0, y: step.y ?? 0 };
  return {
    action: "verify",
    selector: step.selector,
    ...(step.text !== undefined ? { text: step.text } : {})
  };
}

function redactWorkflowStep(step: BrowserCaptureWorkflowStep): Record<string, unknown> {
  if (step.action === "type") {
    return { action: step.action, selector: step.selector, textLength: step.text.length };
  }
  if (step.action === "press") {
    return { action: step.action, selector: step.selector, key: step.key };
  }
  if (step.action === "click") {
    return { action: step.action, selector: step.selector };
  }
  if (step.action === "verify") {
    return { action: step.action, selector: step.selector, hasText: step.text !== undefined };
  }
  if (step.action === "scroll") {
    return { action: step.action, x: step.x ?? 0, y: step.y ?? 0 };
  }
  return { action: step.action, ms: step.ms };
}

function browserLayers(pkg: MotionPackage): MotionLayer[] {
  return pkg.motion.layers.filter((layer) => layer.type === "web" || layer.type === "html" || layer.type === "canvas");
}

function screenshotOptions(path: string, format: BrowserFrameFormat | undefined): DeterministicScreenshotOptions {
  return {
    path,
    animations: "disabled",
    caret: "hide",
    ...(format ? { type: format } : {}),
    ...(format === "jpeg" ? { quality: 92 } : { omitBackground: true })
  };
}

function outputPathFor(pkg: MotionPackage, options: { atMs: number; outDir: string; outputPath?: string; format?: BrowserFrameFormat }): string {
  const extension = options.format === "jpeg" ? "jpg" : "png";
  const outputPath = resolve(options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-browser-${options.atMs}.${extension}`));
  if (!isPathInsideOrEqual(options.outDir, outputPath)) {
    throw new Error("Browser output path must be inside outDir.");
  }
  return outputPath;
}

async function buildGeneratedMotionHtml(pkg: MotionPackage, atMs: number): Promise<{ html: string; assetRefs: string[]; assetHashes: Record<string, string>; warnings: string[]; audioHandoff?: FrameLaneAudioHandoff; temporalSampling?: BrowserTemporalSamplingEvidence; shaders?: BrowserShaderEvidence; scenes3d?: BrowserScene3DEvidence; environments?: BrowserEnvironmentEvidence }> {
  const assetRefs = new Set<string>();
  const assetHashes = new Map<string, string>();
  // Two channels, not one: `notes.warnings` derives the frame receipt's status, `audioHandoff`
  // records work this lane deliberately leaves to ffmpeg. See frame-lane-handoff.ts (the success-status invariant).
  const notes = createFrameLaneNotes();
  const shaderLayers = new Map<string, BrowserShaderEvidence["layers"][number]>();
  const scene3dLayers = new Map<string, BrowserScene3DEvidence["layers"][number]>();
  const environmentLayers = new Map<string, BrowserEnvironmentEvidence["layers"][number]>();
  const fontFaceCss = await generatedFontFaceCss(pkg, assetRefs, assetHashes);
  const activeLayers = effectiveProceduralLayersAtMs(pkg.motion, atMs)
    .filter((layer) => isLayerActive(layer, atMs));
  const camera = activeLayers.find((layer) => layer.type === "camera");
  const matteSourceIds = new Set(pkg.motion.layers.map((layer) => readString(readRecord(layer.matte).sourceLayerId)).filter((id): id is string => !!id));
  const renderLayers = activeLayers.filter((layer) => layer.type !== "camera" && !matteSourceIds.has(layer.id));
  const vectorDefs = renderLayers.flatMap((layer, index) => [
    generatedVectorMaskDefinition(layer, index, atMs),
    generatedMatteDefinition(pkg, layer, index, atMs)
  ]).filter(Boolean).join("\n");
  const hasKeying = renderLayers.some((layer) => Boolean(layer.keying));
  const sourceLayers = new Map(pkg.motion.layers.map((layer) => [layer.id, layer]));
  const renderedLayers = await Promise.all(renderLayers.map(async (layer, index) => ({
    layer,
    index,
    html: await renderGeneratedLayerWithMotionBlur(
      pkg,
      sourceLayers.get(layer.id) ?? layer,
      layer,
      index,
      assetRefs,
      notes,
      atMs,
      shaderLayers,
      scene3dLayers,
      environmentLayers
    )
  })));
  const sceneLayers = renderedLayers.filter(({ layer }) => layer.type !== "adjustment");
  const hasDepthPlanes = sceneLayers.some(({ layer }) => readNumber(layer.depth) !== null);
  const sceneLayerHtml = sceneLayers.map(({ html }) => html).join("\n");
  const adjustmentHtml = renderedLayers.filter(({ layer }) => layer.type === "adjustment").map(({ html }) => html).join("\n");
  const temporalSampling = motionBlurEvidence(pkg, atMs);
  const audioHandoff = frameLaneAudioHandoff(notes);
  const shaders: BrowserShaderEvidence | undefined = shaderLayers.size > 0 ? {
    policy: "restricted-package-glsl",
    maxLayers: 4,
    maxSourceBytes: MAX_RESTRICTED_SHADER_BYTES,
    maxUniformsPerLayer: 16,
    network: "denied",
    clock: "frame-time",
    random: "declared-seed",
    // Code-unit order, not localeCompare: shader evidence is hashed into the browser render receipt.
    layers: [...shaderLayers.values()].sort((left, right) => compareCodeUnits(left.layerId, right.layerId))
  } : undefined;
  const scenes3d = scene3dEvidence(scene3dLayers);
  const environments: BrowserEnvironmentEvidence | undefined = environmentLayers.size > 0 ? {
    policy: "fixed-data-environment-webgl",
    schema: ENVIRONMENT_SCHEMA,
    maxLayers: MAX_ENVIRONMENT_LAYERS,
    maxRainDepthLayers: MAX_RAIN_DEPTH_LAYERS,
    maxSnowDepthLayers: MAX_SNOW_DEPTH_LAYERS,
    maxFogDepthLayers: MAX_FOG_DEPTH_LAYERS,
    maxWaterWaveOctaves: MAX_WATER_WAVE_OCTAVES,
    network: "denied",
    clock: "frame-time",
    random: "declared-seed",
    code: "host-fixed",
    // Code-unit order, not localeCompare: environment evidence is hashed into the render receipt.
    layers: [...environmentLayers.values()].sort((left, right) => compareCodeUnits(left.layerId, right.layerId))
  } : undefined;
  const sceneHtml = camera
    ? hasDepthPlanes
      ? sceneLayers.map(({ layer, html, index }) => `<section data-motion-depth-plane="true" data-layer-id="${escapeAttr(layer.id)}" data-motion-depth="${formatSvgTransformNumber(readNumber(layer.depth) ?? 0)}" style="${cameraDepthPlaneStyle(camera, layer, index)}">${html}</section>`).join("\n")
      : `<section data-motion-camera="true" data-layer-id="${escapeAttr(camera.id)}" style="${cameraCompositionStyle(camera)}">${sceneLayerHtml}</section>`
    : sceneLayerHtml;

  return {
    assetRefs: [...assetRefs].sort(),
    // Code-unit order, not localeCompare: asset refs are package-relative paths, so they are the
    // non-ASCII-prone strings locales disagree about, and this record is hashed into the receipt.
    assetHashes: Object.fromEntries([...assetHashes.entries()].sort(([left], [right]) => compareCodeUnits(left, right))),
    warnings: notes.warnings,
    ...(audioHandoff ? { audioHandoff } : {}),
    ...(temporalSampling ? { temporalSampling } : {}),
    ...(shaders ? { shaders } : {}),
    ...(scenes3d ? { scenes3d } : {}),
    ...(environments ? { environments } : {}),
    html: `<!doctype html>
<html data-shellx-motion-generated="true">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${pkg.motion.width}, initial-scale=1">
<style>
${fontFaceCss}
html,body{margin:0;width:${pkg.motion.width}px;height:${pkg.motion.height}px;overflow:hidden;background:${cssColor(pkg.motion.background ?? "#00000000", pkg, "#00000000")}}
*{box-sizing:border-box}
</style>
</head>
<body data-composition-id="${escapeAttr(pkg.motion.id)}" data-start="0" data-duration="${pkg.motion.durationMs}">
<main style="position:relative;width:${pkg.motion.width}px;height:${pkg.motion.height}px;overflow:hidden;background:${cssColor(pkg.motion.background ?? "#00000000", pkg, "#00000000")}">
${vectorDefs ? `<svg aria-hidden="true" width="0" height="0" style="position:absolute"><defs>${vectorDefs}</defs></svg>` : ""}
${sceneHtml}
${adjustmentHtml}
</main>
${shaders ? restrictedShaderRuntimeScript() : ""}
${scenes3d ? fixedScene3DRuntimeScript() : ""}
${environments ? fixedEnvironmentRuntimeScript() : ""}
${hasKeying ? generatedKeyingRuntimeScript() : ""}
</body>
</html>`
  };
}

function renderGeneratedLayerWithMotionBlur(
  pkg: MotionPackage,
  sourceLayer: MotionLayer,
  layer: MotionLayer,
  index: number,
  assetRefs: Set<string>,
  notes: FrameLaneNotes,
  atMs: number,
  shaderLayers: Map<string, BrowserShaderEvidence["layers"][number]>,
  scene3dLayers: Map<string, BrowserScene3DEvidence["layers"][number]>,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): Promise<string> | string {
  const motionBlur = readRecord(readRecord(layer.effects).motionBlur);
  const samples = readNumber(motionBlur.samples);
  const shutterAngle = readNumber(motionBlur.shutterAngle);
  if (samples === null || !Number.isInteger(samples) || shutterAngle === null || samples < 2 || samples > 8 || (sourceLayer.type === "video" && samples > 4) || shutterAngle <= 0 || shutterAngle > 360) {
    return renderGeneratedLayer(pkg, layer, index, assetRefs, notes, atMs, shaderLayers, scene3dLayers, environmentLayers);
  }
  const sampleCount = Math.floor(samples);
  const shutterDurationMs = (1000 / pkg.motion.fps) * (shutterAngle / 360);
  const sampleTimes = temporalSampleTimes(sourceLayer, atMs, sampleCount, shutterDurationMs);
  const blendMode = readString(layer.blendMode);
  const groupBlendStyle = blendMode && blendMode !== "normal" && CSS_BLEND_MODES.has(blendMode)
    ? `mix-blend-mode:${blendMode};`
    : "";
  const sampleOpacity = formatSvgTransformNumber(1 / sampleCount);
  const renderedSamples = sampleTimes.map((sampleAtMs) => {
    const sampleLayer: MotionLayer = { ...effectiveProceduralLayerAtMs(pkg.motion, sourceLayer.id, sampleAtMs), blendMode: "normal" };
    const html = renderGeneratedLayer(pkg, sampleLayer, index, assetRefs, notes, sampleAtMs, shaderLayers, scene3dLayers, environmentLayers);
    return Promise.resolve(html).then((sampleHtml) => `<div data-motion-blur-sample="${formatSvgTransformNumber(sampleAtMs)}" style="position:absolute;inset:0;opacity:${sampleOpacity};mix-blend-mode:plus-lighter">${sampleHtml}</div>`);
  });
  return Promise.all(renderedSamples).then((sampleHtml) => `<section data-motion-blur="true" data-motion-blur-samples="${sampleCount}" data-motion-blur-shutter-angle="${formatSvgTransformNumber(shutterAngle)}" style="position:absolute;inset:0;z-index:${index};isolation:isolate;${groupBlendStyle}">${sampleHtml.join("")}</section>`);
}

function temporalSampleTimes(layer: MotionLayer, atMs: number, samples: number, shutterDurationMs: number): number[] {
  const earliest = layer.startMs;
  const latest = Math.max(earliest, layer.startMs + layer.durationMs - 0.001);
  if (samples <= 1 || shutterDurationMs <= 0) return [clamp(atMs, earliest, latest)];
  return Array.from({ length: samples }, (_value, index) => {
    const ratio = index / (samples - 1);
    const offsetMs = (ratio - 0.5) * shutterDurationMs;
    return clamp(atMs + offsetMs, earliest, latest);
  });
}

function motionBlurEvidence(pkg: MotionPackage, atMs: number): BrowserTemporalSamplingEvidence | undefined {
  const layers = pkg.motion.layers.filter((layer) => isLayerActive(layer, atMs)).flatMap((layer) => {
    const motionBlur = readRecord(readRecord(layer.effects).motionBlur);
    const samples = readNumber(motionBlur.samples);
    const shutterAngle = readNumber(motionBlur.shutterAngle);
    if (samples === null || !Number.isInteger(samples) || shutterAngle === null || samples < 2 || samples > 8 || (layer.type === "video" && samples > 4) || shutterAngle <= 0 || shutterAngle > 360) return [];
    return [{
      layerId: layer.id,
      layerType: layer.type,
      samples: Math.floor(samples),
      shutterAngle,
      shutterDurationMs: (1000 / pkg.motion.fps) * (shutterAngle / 360)
    }];
  });
  if (layers.length === 0) return undefined;
  return {
    policy: "layer-temporal-supersampling",
    maxSamplesPerLayer: 8,
    maxVideoSamplesPerLayer: 4,
    maxTotalSamples: 64,
    maxTotalVideoSamples: 16,
    totalSamples: layers.reduce((total, layer) => total + layer.samples, 0),
    totalVideoSamples: layers.reduce((total, layer) => total + (layer.layerType === "video" ? layer.samples : 0), 0),
    layers
  };
}

const MAX_EMBEDDED_FONT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_EMBEDDED_FONT_BYTES = 64 * 1024 * 1024;

async function generatedFontFaceCss(pkg: MotionPackage, assetRefs: Set<string>, assetHashes: Map<string, string>): Promise<string> {
  const faces = pkg.motion.assets
    .map((asset) => readMotionFontAsset(asset))
    .filter((asset): asset is MotionFontAsset => asset !== null);
  if (faces.length > 32) throw new Error("Generated browser render supports at most 32 package font faces.");
  const seen = new Set<string>();
  const rules: string[] = [];
  let totalBytes = 0;
  for (const face of faces) {
    const faceKey = `${face.family.toLowerCase()}\u0000${face.weight ?? 400}\u0000${face.style ?? "normal"}`;
    if (seen.has(faceKey)) throw new Error(`Duplicate package font face: ${face.family} ${face.weight ?? 400} ${face.style ?? "normal"}.`);
    seen.add(faceKey);
    if (!pkg.manifest.assets.includes(face.source.path)) {
      throw new Error(`Package font asset ${face.id} is not declared in manifest.assets: ${face.source.path}`);
    }
    const format = fontFormatFor(face.source.path, face.source.mimeType);
    const assetPath = resolvePackageAsset(pkg, face.source.path);
    const before = await lstat(assetPath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Package font asset ${face.id} must be a regular non-symlink file.`);
    if (before.size <= 0 || before.size > MAX_EMBEDDED_FONT_BYTES) {
      throw new Error(`Package font asset ${face.id} must be between 1 and ${MAX_EMBEDDED_FONT_BYTES} bytes.`);
    }
    totalBytes += before.size;
    if (totalBytes > MAX_TOTAL_EMBEDDED_FONT_BYTES) {
      throw new Error(`Package font assets exceed the ${MAX_TOTAL_EMBEDDED_FONT_BYTES}-byte render limit.`);
    }
    const bytes = await readFile(assetPath);
    const after = await lstat(assetPath);
    if (!sameFileIdentity(before, after) || bytes.byteLength !== before.size) {
      throw new Error(`Package font asset ${face.id} changed while it was being prepared.`);
    }
    assetRefs.add(face.source.path);
    assetHashes.set(face.source.path, createHash("sha256").update(bytes).digest("hex"));
    rules.push(`@font-face{font-family:${JSON.stringify(face.family)};src:url(data:${face.source.mimeType};base64,${bytes.toString("base64")}) format(${JSON.stringify(format)});font-weight:${face.weight ?? 400};font-style:${face.style ?? "normal"};font-display:block}`);
  }
  return rules.join("\n");
}

function readMotionFontAsset(value: unknown): MotionFontAsset | null {
  const record = readRecord(value);
  if (record.type !== "font") return null;
  const source = readRecord(record.source);
  const id = readString(record.id);
  const family = readString(record.family);
  const path = readString(source.path);
  const mimeType = readString(source.mimeType);
  const parsedWeight = record.weight === undefined ? null : readNumber(record.weight);
  const weight = parsedWeight === null ? undefined : parsedWeight;
  const style = record.style === undefined ? undefined : readString(record.style);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("Package font asset id is invalid.");
  if (!family || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(family)) throw new Error(`Package font asset ${id} family alias is invalid.`);
  if (!path) throw new Error(`Package font asset ${id} path is missing.`);
  if (mimeType !== "font/woff2" && mimeType !== "font/woff" && mimeType !== "font/ttf" && mimeType !== "font/otf") {
    throw new Error(`Package font asset ${id} MIME type is unsupported.`);
  }
  if (weight !== undefined && (!Number.isInteger(weight) || weight < 1 || weight > 1000)) throw new Error(`Package font asset ${id} weight is invalid.`);
  if (style !== undefined && style !== "normal" && style !== "italic" && style !== "oblique") throw new Error(`Package font asset ${id} style is invalid.`);
  return {
    id,
    type: "font",
    family,
    source: { path, mimeType },
    ...(weight !== undefined ? { weight } : {}),
    ...(style !== undefined ? { style } : {})
  };
}

function fontFormatFor(path: string, mimeType: MotionFontAsset["source"]["mimeType"]): "woff2" | "woff" | "truetype" | "opentype" {
  const normalized = path.toLowerCase();
  if (mimeType === "font/woff2" && normalized.endsWith(".woff2")) return "woff2";
  if (mimeType === "font/woff" && normalized.endsWith(".woff")) return "woff";
  if (mimeType === "font/ttf" && normalized.endsWith(".ttf")) return "truetype";
  if (mimeType === "font/otf" && normalized.endsWith(".otf")) return "opentype";
  throw new Error(`Package font asset extension does not match ${mimeType}.`);
}

function sameFileIdentity(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
  return before.isFile()
    && after.isFile()
    && !before.isSymbolicLink()
    && !after.isSymbolicLink()
    && String(before.dev) === String(after.dev)
    && String(before.ino) === String(after.ino)
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function renderGeneratedLayer(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  assetRefs: Set<string>,
  notes: FrameLaneNotes,
  atMs: number,
  shaderLayers: Map<string, BrowserShaderEvidence["layers"][number]>,
  scene3dLayers: Map<string, BrowserScene3DEvidence["layers"][number]>,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): Promise<string> | string {
  if (layer.type === "shape") return renderGeneratedShape(pkg, layer, index, atMs);
  if (layer.type === "particles") return renderGeneratedParticles(layer, index, atMs);
  if (layer.type === "adjustment") return renderGeneratedAdjustment(pkg, layer, index, atMs);
  if (layer.type === "shader") return renderGeneratedShader(pkg, layer, index, assetRefs, atMs, shaderLayers);
  if (layer.type === "scene3d") {
    const metrics = layerBoxSize(layer, { defaultWidth: pkg.motion.width, defaultHeight: pkg.motion.height });
    return renderGeneratedScene3D({
      layer,
      atMs,
      width: metrics.width,
      height: metrics.height,
      style: boxStyle(layer, index, undefined, atMs),
      layers: scene3dLayers,
    });
  }
  if (layer.type === "environment") return renderGeneratedEnvironment(pkg, layer, index, atMs, environmentLayers);
  if (layer.type === "text" || layer.type === "caption") return renderGeneratedText(pkg, layer, index, atMs);
  if (layer.type === "image") return renderGeneratedImage(pkg, layer, index, assetRefs, atMs);
  if (layer.type === "video") return renderGeneratedVideo(pkg, layer, index, assetRefs, atMs);

  noteUnrenderedLayer(notes, layer);
  return "";
}

function renderGeneratedAdjustment(pkg: MotionPackage, layer: MotionLayer, index: number, atMs: number): string {
  const effects = readRecord(layer.effects);
  const vignette = readRecord(effects.vignette);
  const filmGrain = readRecord(effects.filmGrain);
  const overlays: string[] = [];
  const vignetteAmount = readNumber(vignette.amount);
  const vignetteSoftness = readNumber(vignette.softness);
  const vignetteColor = readString(vignette.color);
  if (vignetteAmount !== null && vignetteAmount > 0 && vignetteSoftness !== null && vignetteColor && isSupportedMotionColorString(vignetteColor)) {
    const startPercent = 70 - clamp(vignetteSoftness, 0, 1) * 50;
    overlays.push(`<div aria-hidden="true" data-motion-vignette="true" style="position:absolute;inset:0;background:radial-gradient(circle at center,transparent 0%,transparent ${formatSvgTransformNumber(startPercent)}%,${cssColor(vignetteColor, pkg, "#000000")} 100%);opacity:${formatSvgTransformNumber(clamp(vignetteAmount, 0, 1))}"></div>`);
  }
  const grainAmount = readNumber(filmGrain.amount);
  const grainSize = readNumber(filmGrain.size);
  const grainSeed = readNumber(filmGrain.seed);
  if (grainAmount !== null && grainAmount > 0 && grainSize !== null && grainSeed !== null) {
    const frameIndex = Math.floor(Math.max(0, atMs - layer.startMs) * pkg.motion.fps / 1000);
    const frameSeed = ((grainSeed >>> 0) ^ Math.imul(frameIndex + 1, 0x9e3779b1)) >>> 0;
    const tileSize = 32 * Math.floor(clamp(grainSize, 1, 8));
    overlays.push(`<div aria-hidden="true" data-motion-film-grain="true" data-motion-film-grain-seed="${frameSeed}" data-motion-film-grain-frame="${frameIndex}" style="position:absolute;inset:0;background-image:url('${filmGrainDataUrl(frameSeed)}');background-repeat:repeat;background-size:${tileSize}px ${tileSize}px;image-rendering:pixelated;mix-blend-mode:soft-light;opacity:${formatSvgTransformNumber(clamp(grainAmount, 0, 1))}"></div>`);
  }
  return `<section data-layer-id="${escapeAttr(layer.id)}" data-motion-adjustment="true" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="position:absolute;inset:0;z-index:${index};pointer-events:none;overflow:hidden">${overlays.join("")}</section>`;
}

function filmGrainDataUrl(seed: number): string {
  const pixels: string[] = [];
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const value = Math.floor(particleRandom(seed, y * 32 + x, 7) * 256);
      pixels.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${value} ${value} ${value})"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">${pixels.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function renderGeneratedShader(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  assetRefs: Set<string>,
  atMs: number,
  shaderLayers: Map<string, BrowserShaderEvidence["layers"][number]>
): Promise<string> {
  const shader = readRecord(layer.shader);
  const fragmentAssetId = readString(shader.fragmentAssetId);
  const asset = fragmentAssetId ? findMotionAssetRecord(pkg, fragmentAssetId) : null;
  if (!asset || asset.type !== "shader") {
    throw new Error(`Shader layer ${layer.id} references an unknown shader asset: ${fragmentAssetId ?? "(missing)"}`);
  }
  const source = readRecord(asset.source);
  const assetRef = readString(source.path);
  if (!assetRef || source.mimeType !== "text/x-shellx-motion-glsl") {
    throw new Error(`Shader layer ${layer.id} requires a text/x-shellx-motion-glsl package asset.`);
  }
  if (!pkg.manifest.assets.includes(assetRef)) {
    throw new Error(`Shader asset ${fragmentAssetId} is not declared in manifest.assets: ${assetRef}`);
  }
  const assetPath = resolvePackageAsset(pkg, assetRef);
  const before = await lstat(assetPath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Shader asset ${fragmentAssetId} must be a regular non-symlink file.`);
  if (before.size <= 0 || before.size > MAX_RESTRICTED_SHADER_BYTES) {
    throw new Error(`Shader asset ${fragmentAssetId} must be between 1 and ${MAX_RESTRICTED_SHADER_BYTES} bytes.`);
  }
  const bytes = await readFile(assetPath);
  const after = await lstat(assetPath);
  if (!sameFileIdentity(before, after) || bytes.byteLength !== before.size) {
    throw new Error(`Shader asset ${fragmentAssetId} changed while it was being prepared.`);
  }
  const uniforms = Object.fromEntries(Object.entries(readRecord(shader.uniforms))
    .filter((entry): entry is [string, number] => readNumber(entry[1]) !== null)
    // Code-unit order, not localeCompare: this order becomes the uniform declaration order in the
    // GENERATED GLSL and the key order of the base64 data-motion-shader-uniforms attribute, so a
    // locale-sensitive comparator changed the emitted shader text itself, not just a hash of it.
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  const fragmentSource = compileRestrictedFragmentShader(new TextDecoder("utf-8", { fatal: true }).decode(bytes), Object.keys(uniforms));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const seed = (readNumber(shader.seed) ?? 0) >>> 0;
  const metrics = layerBoxSize(layer, { defaultWidth: pkg.motion.width, defaultHeight: pkg.motion.height });
  const canvasWidth = Math.max(1, Math.round(metrics.width));
  const canvasHeight = Math.max(1, Math.round(metrics.height));
  assertLocalMotionFrameBudget({ width: canvasWidth, height: canvasHeight });
  const fallbackColor = cssColor(readString(shader.fallbackColor) ?? "#000000", pkg, "#000000");
  assetRefs.add(assetRef);
  shaderLayers.set(layer.id, { layerId: layer.id, assetRef, sha256, bytes: bytes.byteLength, seed, uniformCount: Object.keys(uniforms).length });
  return `<canvas data-layer-id="${escapeAttr(layer.id)}" data-motion-shader="true" data-motion-shader-state="pending" data-motion-shader-fragment="${Buffer.from(fragmentSource).toString("base64")}" data-motion-shader-uniforms="${Buffer.from(JSON.stringify(uniforms)).toString("base64")}" data-motion-shader-time="${formatSvgTransformNumber(atMs / 1000)}" data-motion-shader-seed="${seed}" width="${canvasWidth}" height="${canvasHeight}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}display:block;background:${fallbackColor}"></canvas>`;
}

/** Fixed host code; plugin bytes only enter through base64 data attributes. */
function restrictedShaderRuntimeScript(): string {
  return `<script data-shellx-motion-shader-runtime="true">(() => {
const vertexSource = "attribute vec2 a_position; void main(){ gl_Position=vec4(a_position,0.0,1.0); }";
const decode = (value) => atob(value || "");
const compile = (gl, type, source) => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL could not allocate a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error((gl.getShaderInfoLog(shader) || "Shader compilation failed.").slice(0, 512));
  return shader;
};
for (const canvas of document.querySelectorAll("canvas[data-motion-shader='true']")) {
  try {
    const gl = canvas.getContext("webgl", { alpha:true, antialias:false, depth:false, stencil:false, premultipliedAlpha:true, preserveDrawingBuffer:true, powerPreference:"low-power" });
    if (!gl) throw new Error("Deterministic WebGL is unavailable.");
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL could not allocate a program.");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, decode(canvas.dataset.motionShaderFragment)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error((gl.getProgramInfoLog(program) || "Shader link failed.").slice(0, 512));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const set1f = (name, value) => { const location=gl.getUniformLocation(program,name); if (location !== null) gl.uniform1f(location,value); };
    const resolution = gl.getUniformLocation(program, "u_resolution");
    if (resolution !== null) gl.uniform2f(resolution, canvas.width, canvas.height);
    set1f("u_time", Number(canvas.dataset.motionShaderTime || 0));
    set1f("u_seed", Number(canvas.dataset.motionShaderSeed || 0) / 4294967296);
    const uniforms = JSON.parse(decode(canvas.dataset.motionShaderUniforms) || "{}");
    for (const [name, value] of Object.entries(uniforms)) set1f(name, Number(value));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.finish();
    canvas.dataset.motionShaderState = "ready";
  } catch (error) {
    canvas.dataset.motionShaderState = "error";
    canvas.dataset.motionShaderError = String(error instanceof Error ? error.message : error).slice(0, 512);
  }
}
})();</script>`;
}

function renderGeneratedEnvironment(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  atMs: number,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): string {
  const environment = readRecord(layer.environment);
  if (environment.schema !== ENVIRONMENT_SCHEMA) throw new Error(`Environment layer ${layer.id} requires ${ENVIRONMENT_SCHEMA}.`);
  if (environmentLayers.size >= MAX_ENVIRONMENT_LAYERS && !environmentLayers.has(layer.id)) {
    throw new Error(`Generated browser render supports at most ${MAX_ENVIRONMENT_LAYERS} environment layers.`);
  }
  if (environment.kind === "rain") return renderGeneratedRainEnvironment(pkg, layer, index, atMs, environmentLayers);
  if (environment.kind === "water") return renderGeneratedWaterEnvironment(pkg, layer, index, atMs, environmentLayers);
  if (environment.kind === "snow") return renderGeneratedSnowEnvironment(pkg, layer, index, atMs, environmentLayers);
  if (environment.kind === "fog") return renderGeneratedFogEnvironment(pkg, layer, index, atMs, environmentLayers);
  throw new Error(`Environment layer ${layer.id} kind is unsupported.`);
}

function environmentSceneSource(
  pkg: MotionPackage,
  layer: MotionLayer,
  environment: Record<string, unknown>,
  mode: string
): { layerId: string; assetRef: string } | null {
  const layerId = readString(environment.sceneSourceLayerId);
  if (!layerId) return null;
  if (mode !== "scene") throw new Error(`Environment layer ${layer.id} sceneSourceLayerId requires scene mode.`);
  const environmentIndex = pkg.motion.layers.findIndex((candidate) => candidate.id === layer.id);
  const sourceIndex = pkg.motion.layers.findIndex((candidate) => candidate.id === layerId);
  const sourceLayer = sourceIndex >= 0 ? pkg.motion.layers[sourceIndex] : null;
  if (!sourceLayer || sourceLayer.type !== "image" || sourceIndex >= environmentIndex) {
    throw new Error(`Environment layer ${layer.id} sceneSourceLayerId must reference an earlier image layer.`);
  }
  const asset = assetForLayer(pkg, sourceLayer, "Image");
  const assetRef = readString(readRecord(asset.source).path);
  if (!assetRef) throw new Error(`Environment layer ${layer.id} scene source image has no package asset path.`);
  return { layerId, assetRef };
}

function environmentEffectMask(
  pkg: MotionPackage,
  layer: MotionLayer,
  environment: Record<string, unknown>
): { layerId: string; assetRef: string } | null {
  const layerId = readString(environment.effectMaskLayerId);
  if (!layerId) return null;
  const environmentIndex = pkg.motion.layers.findIndex((candidate) => candidate.id === layer.id);
  const maskIndex = pkg.motion.layers.findIndex((candidate) => candidate.id === layerId);
  const maskLayer = maskIndex >= 0 ? pkg.motion.layers[maskIndex] : null;
  if (!maskLayer || maskLayer.type !== "image" || maskIndex >= environmentIndex) {
    throw new Error(`Environment layer ${layer.id} effectMaskLayerId must reference an earlier image layer.`);
  }
  const asset = assetForLayer(pkg, maskLayer, "Image");
  const assetRef = readString(readRecord(asset.source).path);
  if (!assetRef) throw new Error(`Environment layer ${layer.id} effect mask image has no package asset path.`);
  return { layerId, assetRef };
}

function renderGeneratedRainEnvironment(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  atMs: number,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): string {
  const environment = readRecord(layer.environment);
  const seedValue = readNumber(environment.seed);
  if (seedValue === null || !Number.isInteger(seedValue) || seedValue < 0 || seedValue > 0xffff_ffff) {
    throw new Error(`Environment layer ${layer.id} seed must be an unsigned 32-bit integer.`);
  }
  const quality = readString(environment.quality);
  if (quality !== "preview" && quality !== "balanced" && quality !== "cinematic") {
    throw new Error(`Environment layer ${layer.id} quality is unsupported.`);
  }
  const mode = readString(environment.mode);
  if (mode !== "scene" && mode !== "overlay") throw new Error(`Environment layer ${layer.id} mode is unsupported.`);
  const sceneSource = environmentSceneSource(pkg, layer, environment, mode);
  const effectMask = environmentEffectMask(pkg, layer, environment);
  const depthLayers = scene3dNumber(environment.depthLayers, 1, MAX_RAIN_DEPTH_LAYERS, `Environment layer ${layer.id} depthLayers`);
  if (!Number.isInteger(depthLayers)) throw new Error(`Environment layer ${layer.id} depthLayers must be an integer.`);
  const effectiveDepthLayers = Math.min(depthLayers, quality === "preview" ? 2 : quality === "balanced" ? 3 : MAX_RAIN_DEPTH_LAYERS);
  const ground = readRecord(environment.ground);
  const atmosphere = readRecord(environment.atmosphere);
  const config = {
    kind: "rain" as const,
    seed: seedValue >>> 0,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId } : {}),
    intensity: scene3dNumber(environment.intensity, 0, 1, `Environment layer ${layer.id} intensity`),
    wind: scene3dNumber(environment.wind, -2, 2, `Environment layer ${layer.id} wind`),
    dropSpeed: scene3dNumber(environment.dropSpeed, 0.1, 5, `Environment layer ${layer.id} dropSpeed`),
    dropLength: scene3dNumber(environment.dropLength, 0.1, 2, `Environment layer ${layer.id} dropLength`),
    depthLayers: effectiveDepthLayers,
    color: scene3dHexColor(environment.color, `Environment layer ${layer.id} color`),
    backgroundColor: scene3dHexColor(environment.backgroundColor, `Environment layer ${layer.id} backgroundColor`),
    lightColor: scene3dHexColor(environment.lightColor, `Environment layer ${layer.id} lightColor`),
    accentColor: scene3dHexColor(environment.accentColor, `Environment layer ${layer.id} accentColor`),
    ground: {
      horizon: scene3dNumber(ground.horizon, 0.15, 0.9, `Environment layer ${layer.id} ground.horizon`),
      wetness: scene3dNumber(ground.wetness, 0, 1, `Environment layer ${layer.id} ground.wetness`),
      roughness: scene3dNumber(ground.roughness, 0, 1, `Environment layer ${layer.id} ground.roughness`),
      rippleAmount: scene3dNumber(ground.rippleAmount, 0, 1, `Environment layer ${layer.id} ground.rippleAmount`),
      splashAmount: scene3dNumber(ground.splashAmount, 0, 1, `Environment layer ${layer.id} ground.splashAmount`),
      reflectionStrength: scene3dNumber(ground.reflectionStrength, 0, 1, `Environment layer ${layer.id} ground.reflectionStrength`)
    },
    atmosphere: {
      mist: scene3dNumber(atmosphere.mist, 0, 1, `Environment layer ${layer.id} atmosphere.mist`),
      lensDroplets: scene3dNumber(atmosphere.lensDroplets, 0, 1, `Environment layer ${layer.id} atmosphere.lensDroplets`)
    }
  };
  const metrics = layerBoxSize(layer, { defaultWidth: pkg.motion.width, defaultHeight: pkg.motion.height });
  const canvasWidth = Math.max(1, Math.round(metrics.width));
  const canvasHeight = Math.max(1, Math.round(metrics.height));
  assertLocalMotionFrameBudget({ width: canvasWidth, height: canvasHeight });
  environmentLayers.set(layer.id, {
    layerId: layer.id,
    kind: "rain",
    seed: config.seed,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId, sceneSourceAssetRef: sceneSource.assetRef } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId, effectMaskAssetRef: effectMask.assetRef } : {}),
    depthLayers,
    effectiveDepthLayers
  });
  const fallback = mode === "scene" ? config.backgroundColor : "transparent";
  return `<canvas data-layer-id="${escapeAttr(layer.id)}" data-motion-environment="rain" data-motion-environment-state="pending" data-motion-environment-config="${Buffer.from(JSON.stringify(config)).toString("base64")}" data-motion-environment-time="${formatSvgTransformNumber(Math.max(0, atMs - layer.startMs) / 1000)}" width="${canvasWidth}" height="${canvasHeight}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}display:block;background:${escapeAttr(fallback)}"></canvas>`;
}

function renderGeneratedWaterEnvironment(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  atMs: number,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): string {
  const environment = readRecord(layer.environment);
  const seedValue = readNumber(environment.seed);
  if (seedValue === null || !Number.isInteger(seedValue) || seedValue < 0 || seedValue > 0xffff_ffff) {
    throw new Error(`Environment layer ${layer.id} seed must be an unsigned 32-bit integer.`);
  }
  const quality = readString(environment.quality);
  if (quality !== "preview" && quality !== "balanced" && quality !== "cinematic") throw new Error(`Environment layer ${layer.id} quality is unsupported.`);
  const mode = readString(environment.mode);
  if (mode !== "scene" && mode !== "overlay") throw new Error(`Environment layer ${layer.id} mode is unsupported.`);
  const sceneSource = environmentSceneSource(pkg, layer, environment, mode);
  const effectMask = environmentEffectMask(pkg, layer, environment);
  const surface = readRecord(environment.surface);
  const optics = readRecord(environment.optics);
  const waveOctaves = scene3dNumber(surface.waveOctaves, 1, MAX_WATER_WAVE_OCTAVES, `Environment layer ${layer.id} surface.waveOctaves`);
  if (!Number.isInteger(waveOctaves)) throw new Error(`Environment layer ${layer.id} surface.waveOctaves must be an integer.`);
  const effectiveWaveOctaves = Math.min(waveOctaves, quality === "preview" ? 2 : quality === "balanced" ? 3 : MAX_WATER_WAVE_OCTAVES);
  const config = {
    kind: "water" as const,
    seed: seedValue >>> 0,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId } : {}),
    backgroundColor: scene3dHexColor(environment.backgroundColor, `Environment layer ${layer.id} backgroundColor`),
    shallowColor: scene3dHexColor(environment.shallowColor, `Environment layer ${layer.id} shallowColor`),
    deepColor: scene3dHexColor(environment.deepColor, `Environment layer ${layer.id} deepColor`),
    reflectionColor: scene3dHexColor(environment.reflectionColor, `Environment layer ${layer.id} reflectionColor`),
    foamColor: scene3dHexColor(environment.foamColor, `Environment layer ${layer.id} foamColor`),
    surface: {
      horizon: scene3dNumber(surface.horizon, 0.1, 0.9, `Environment layer ${layer.id} surface.horizon`),
      waveScale: scene3dNumber(surface.waveScale, 0.1, 20, `Environment layer ${layer.id} surface.waveScale`),
      waveHeight: scene3dNumber(surface.waveHeight, 0, 1, `Environment layer ${layer.id} surface.waveHeight`),
      waveSpeed: scene3dNumber(surface.waveSpeed, 0.05, 5, `Environment layer ${layer.id} surface.waveSpeed`),
      direction: scene3dNumber(surface.direction, -180, 180, `Environment layer ${layer.id} surface.direction`),
      choppiness: scene3dNumber(surface.choppiness, 0, 1, `Environment layer ${layer.id} surface.choppiness`),
      waveOctaves: effectiveWaveOctaves
    },
    optics: {
      reflectionStrength: scene3dNumber(optics.reflectionStrength, 0, 1, `Environment layer ${layer.id} optics.reflectionStrength`),
      refractionStrength: scene3dNumber(optics.refractionStrength, 0, 1, `Environment layer ${layer.id} optics.refractionStrength`),
      fresnel: scene3dNumber(optics.fresnel, 0, 1, `Environment layer ${layer.id} optics.fresnel`),
      caustics: scene3dNumber(optics.caustics, 0, 1, `Environment layer ${layer.id} optics.caustics`),
      clarity: scene3dNumber(optics.clarity, 0, 1, `Environment layer ${layer.id} optics.clarity`),
      foam: scene3dNumber(optics.foam, 0, 1, `Environment layer ${layer.id} optics.foam`)
    }
  };
  const metrics = layerBoxSize(layer, { defaultWidth: pkg.motion.width, defaultHeight: pkg.motion.height });
  const canvasWidth = Math.max(1, Math.round(metrics.width));
  const canvasHeight = Math.max(1, Math.round(metrics.height));
  assertLocalMotionFrameBudget({ width: canvasWidth, height: canvasHeight });
  environmentLayers.set(layer.id, {
    layerId: layer.id,
    kind: "water",
    seed: config.seed,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId, sceneSourceAssetRef: sceneSource.assetRef } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId, effectMaskAssetRef: effectMask.assetRef } : {}),
    waveOctaves,
    effectiveWaveOctaves
  });
  const fallback = mode === "scene" ? config.backgroundColor : "transparent";
  return `<canvas data-layer-id="${escapeAttr(layer.id)}" data-motion-environment="water" data-motion-environment-state="pending" data-motion-environment-config="${Buffer.from(JSON.stringify(config)).toString("base64")}" data-motion-environment-time="${formatSvgTransformNumber(Math.max(0, atMs - layer.startMs) / 1000)}" width="${canvasWidth}" height="${canvasHeight}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}display:block;background:${escapeAttr(fallback)}"></canvas>`;
}

function renderGeneratedSnowEnvironment(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  atMs: number,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): string {
  const environment = readRecord(layer.environment);
  const seedValue = readNumber(environment.seed);
  if (seedValue === null || !Number.isInteger(seedValue) || seedValue < 0 || seedValue > 0xffff_ffff) {
    throw new Error(`Environment layer ${layer.id} seed must be an unsigned 32-bit integer.`);
  }
  const quality = readString(environment.quality);
  if (quality !== "preview" && quality !== "balanced" && quality !== "cinematic") throw new Error(`Environment layer ${layer.id} quality is unsupported.`);
  const mode = readString(environment.mode);
  if (mode !== "scene" && mode !== "overlay") throw new Error(`Environment layer ${layer.id} mode is unsupported.`);
  const sceneSource = environmentSceneSource(pkg, layer, environment, mode);
  const effectMask = environmentEffectMask(pkg, layer, environment);
  const fall = readRecord(environment.fall);
  const ground = readRecord(environment.ground);
  const atmosphere = readRecord(environment.atmosphere);
  const snowDepthLayers = scene3dNumber(fall.depthLayers, 1, MAX_SNOW_DEPTH_LAYERS, `Environment layer ${layer.id} fall.depthLayers`);
  if (!Number.isInteger(snowDepthLayers)) throw new Error(`Environment layer ${layer.id} fall.depthLayers must be an integer.`);
  const effectiveSnowDepthLayers = Math.min(snowDepthLayers, quality === "preview" ? 2 : quality === "balanced" ? 3 : MAX_SNOW_DEPTH_LAYERS);
  const config = {
    kind: "snow" as const,
    seed: seedValue >>> 0,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId } : {}),
    backgroundColor: scene3dHexColor(environment.backgroundColor, `Environment layer ${layer.id} backgroundColor`),
    snowColor: scene3dHexColor(environment.snowColor, `Environment layer ${layer.id} snowColor`),
    shadowColor: scene3dHexColor(environment.shadowColor, `Environment layer ${layer.id} shadowColor`),
    lightColor: scene3dHexColor(environment.lightColor, `Environment layer ${layer.id} lightColor`),
    fall: {
      intensity: scene3dNumber(fall.intensity, 0, 1, `Environment layer ${layer.id} fall.intensity`),
      speed: scene3dNumber(fall.speed, 0.05, 3, `Environment layer ${layer.id} fall.speed`),
      wind: scene3dNumber(fall.wind, -2, 2, `Environment layer ${layer.id} fall.wind`),
      turbulence: scene3dNumber(fall.turbulence, 0, 1, `Environment layer ${layer.id} fall.turbulence`),
      flakeSize: scene3dNumber(fall.flakeSize, 0.1, 3, `Environment layer ${layer.id} fall.flakeSize`),
      depthLayers: effectiveSnowDepthLayers,
      focusFalloff: scene3dNumber(fall.focusFalloff, 0, 1, `Environment layer ${layer.id} fall.focusFalloff`)
    },
    ground: {
      horizon: scene3dNumber(ground.horizon, 0.1, 0.9, `Environment layer ${layer.id} ground.horizon`),
      accumulation: scene3dNumber(ground.accumulation, 0, 1, `Environment layer ${layer.id} ground.accumulation`),
      drift: scene3dNumber(ground.drift, 0, 1, `Environment layer ${layer.id} ground.drift`),
      contactAmount: scene3dNumber(ground.contactAmount, 0, 1, `Environment layer ${layer.id} ground.contactAmount`)
    },
    atmosphere: {
      haze: scene3dNumber(atmosphere.haze, 0, 1, `Environment layer ${layer.id} atmosphere.haze`),
      depthFade: scene3dNumber(atmosphere.depthFade, 0, 1, `Environment layer ${layer.id} atmosphere.depthFade`)
    }
  };
  const metrics = layerBoxSize(layer, { defaultWidth: pkg.motion.width, defaultHeight: pkg.motion.height });
  const canvasWidth = Math.max(1, Math.round(metrics.width));
  const canvasHeight = Math.max(1, Math.round(metrics.height));
  assertLocalMotionFrameBudget({ width: canvasWidth, height: canvasHeight });
  environmentLayers.set(layer.id, {
    layerId: layer.id,
    kind: "snow",
    seed: config.seed,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId, sceneSourceAssetRef: sceneSource.assetRef } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId, effectMaskAssetRef: effectMask.assetRef } : {}),
    snowDepthLayers,
    effectiveSnowDepthLayers
  });
  const fallback = mode === "scene" ? config.backgroundColor : "transparent";
  return `<canvas data-layer-id="${escapeAttr(layer.id)}" data-motion-environment="snow" data-motion-environment-state="pending" data-motion-environment-config="${Buffer.from(JSON.stringify(config)).toString("base64")}" data-motion-environment-time="${formatSvgTransformNumber(Math.max(0, atMs - layer.startMs) / 1000)}" width="${canvasWidth}" height="${canvasHeight}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}display:block;background:${escapeAttr(fallback)}"></canvas>`;
}

function renderGeneratedFogEnvironment(
  pkg: MotionPackage,
  layer: MotionLayer,
  index: number,
  atMs: number,
  environmentLayers: Map<string, BrowserEnvironmentEvidence["layers"][number]>
): string {
  const environment = readRecord(layer.environment);
  const seedValue = readNumber(environment.seed);
  if (seedValue === null || !Number.isInteger(seedValue) || seedValue < 0 || seedValue > 0xffff_ffff) {
    throw new Error(`Environment layer ${layer.id} seed must be an unsigned 32-bit integer.`);
  }
  const quality = readString(environment.quality);
  if (quality !== "preview" && quality !== "balanced" && quality !== "cinematic") throw new Error(`Environment layer ${layer.id} quality is unsupported.`);
  const mode = readString(environment.mode);
  if (mode !== "scene" && mode !== "overlay") throw new Error(`Environment layer ${layer.id} mode is unsupported.`);
  const sceneSource = environmentSceneSource(pkg, layer, environment, mode);
  const effectMask = environmentEffectMask(pkg, layer, environment);
  const fog = readRecord(environment.fog);
  const fogDepthLayers = scene3dNumber(fog.depthLayers, 1, MAX_FOG_DEPTH_LAYERS, `Environment layer ${layer.id} fog.depthLayers`);
  if (!Number.isInteger(fogDepthLayers)) throw new Error(`Environment layer ${layer.id} fog.depthLayers must be an integer.`);
  const effectiveFogDepthLayers = Math.min(fogDepthLayers, quality === "preview" ? 2 : quality === "balanced" ? 3 : MAX_FOG_DEPTH_LAYERS);
  const config = {
    kind: "fog" as const,
    seed: seedValue >>> 0,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId } : {}),
    backgroundColor: scene3dHexColor(environment.backgroundColor, `Environment layer ${layer.id} backgroundColor`),
    fogColor: scene3dHexColor(environment.fogColor, `Environment layer ${layer.id} fogColor`),
    lightColor: scene3dHexColor(environment.lightColor, `Environment layer ${layer.id} lightColor`),
    fog: {
      density: scene3dNumber(fog.density, 0, 1, `Environment layer ${layer.id} fog.density`),
      speed: scene3dNumber(fog.speed, 0.01, 3, `Environment layer ${layer.id} fog.speed`),
      scale: scene3dNumber(fog.scale, 0.1, 12, `Environment layer ${layer.id} fog.scale`),
      turbulence: scene3dNumber(fog.turbulence, 0, 1, `Environment layer ${layer.id} fog.turbulence`),
      height: scene3dNumber(fog.height, 0, 1, `Environment layer ${layer.id} fog.height`),
      depthLayers: effectiveFogDepthLayers,
      lightStrength: scene3dNumber(fog.lightStrength, 0, 1, `Environment layer ${layer.id} fog.lightStrength`)
    }
  };
  const metrics = layerBoxSize(layer, { defaultWidth: pkg.motion.width, defaultHeight: pkg.motion.height });
  const canvasWidth = Math.max(1, Math.round(metrics.width));
  const canvasHeight = Math.max(1, Math.round(metrics.height));
  assertLocalMotionFrameBudget({ width: canvasWidth, height: canvasHeight });
  environmentLayers.set(layer.id, {
    layerId: layer.id,
    kind: "fog",
    seed: config.seed,
    quality,
    mode,
    ...(sceneSource ? { sceneSourceLayerId: sceneSource.layerId, sceneSourceAssetRef: sceneSource.assetRef } : {}),
    ...(effectMask ? { effectMaskLayerId: effectMask.layerId, effectMaskAssetRef: effectMask.assetRef } : {}),
    fogDepthLayers,
    effectiveFogDepthLayers
  });
  const fallback = mode === "scene" ? config.backgroundColor : "transparent";
  return `<canvas data-layer-id="${escapeAttr(layer.id)}" data-motion-environment="fog" data-motion-environment-state="pending" data-motion-environment-config="${Buffer.from(JSON.stringify(config)).toString("base64")}" data-motion-environment-time="${formatSvgTransformNumber(Math.max(0, atMs - layer.startMs) / 1000)}" width="${canvasWidth}" height="${canvasHeight}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}display:block;background:${escapeAttr(fallback)}"></canvas>`;
}

const FIXED_RAIN_FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed_lo;
uniform float u_seed_hi;
uniform float u_mode;
uniform float u_intensity;
uniform float u_wind;
uniform float u_drop_speed;
uniform float u_drop_length;
uniform float u_depth_layers;
uniform float u_horizon;
uniform float u_wetness;
uniform float u_roughness;
uniform float u_ripples;
uniform float u_splashes;
uniform float u_reflections;
uniform float u_mist;
uniform float u_lens_droplets;
uniform sampler2D u_scene;
uniform float u_has_scene;
uniform sampler2D u_effect_mask;
uniform float u_has_effect_mask;
uniform vec3 u_rain_color;
uniform vec3 u_background_color;
uniform vec3 u_light_color;
uniform vec3 u_accent_color;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + u_seed_lo * 37.17 + u_seed_hi * 91.53);
  return fract(p.x * p.y);
}

float noise21(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

float rainLayer(vec2 uv, float layer) {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  float scale = mix(18.0, 54.0, layer / 3.0);
  vec2 p = vec2(uv.x * aspect, uv.y);
  p.x += (uv.y + u_time * 0.18) * u_wind * mix(0.12, 0.32, layer / 3.0);
  p.y += u_time * u_drop_speed * mix(0.48, 1.25, layer / 3.0);
  vec2 grid = vec2(scale, scale * 0.38);
  vec2 id = floor(p * grid);
  vec2 cell = fract(p * grid) - 0.5;
  float random = hash21(id + layer * 31.7);
  cell.x += (random - 0.5) * 0.76;
  float width = mix(0.045, 0.012, layer / 3.0);
  float line = 1.0 - smoothstep(width, width * 2.4, abs(cell.x));
  float length = mix(0.08, 0.42, clamp(u_drop_length * 0.5, 0.0, 1.0));
  float segment = 1.0 - smoothstep(length, min(0.5, length + 0.11), abs(cell.y));
  float occupancy = step(1.0 - u_intensity * mix(0.18, 0.48, layer / 3.0), random);
  return line * segment * occupancy * mix(0.28, 1.0, layer / 3.0);
}

float rippleField(vec2 uv) {
  float distanceToHorizon = max(0.025, u_horizon - uv.y);
  vec2 groundUv = vec2((uv.x - 0.5) / distanceToHorizon, 1.0 / distanceToHorizon);
  vec2 cellId = floor(groundUv * vec2(2.2, 0.32));
  vec2 cell = fract(groundUv * vec2(2.2, 0.32)) - 0.5;
  float random = hash21(cellId + 71.0);
  float phase = fract(u_time * 0.62 + random);
  float radius = phase * 0.36;
  float ring = 1.0 - smoothstep(0.018, 0.048, abs(length(cell) - radius));
  return ring * (1.0 - phase) * step(0.48, random) * u_ripples;
}

float lensDropletField(vec2 uv) {
  vec2 grid = vec2(8.0, 13.0);
  vec2 id = floor(uv * grid);
  vec2 cell = fract(uv * grid) - 0.5;
  float random = hash21(id + 149.0);
  cell += vec2(hash21(id + 19.0) - 0.5, hash21(id + 37.0) - 0.5) * 0.44;
  cell.y *= mix(0.55, 1.0, random);
  float radius = mix(0.08, 0.27, hash21(id + 83.0));
  float ring = 1.0 - smoothstep(0.018, 0.055, abs(length(cell) - radius));
  float fill = 1.0 - smoothstep(radius * 0.3, radius, length(cell));
  return (ring * 0.14 + fill * 0.07) * step(1.0 - u_lens_droplets * 0.24, random);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float effectMask = mix(1.0, dot(texture2D(u_effect_mask, uv).rgb, vec3(0.2126, 0.7152, 0.0722)), u_has_effect_mask);
  float groundMask = 1.0 - smoothstep(u_horizon - 0.012, u_horizon + 0.012, uv.y);
  float skyNoise = noise21(uv * vec2(7.0, 4.0) + u_time * vec2(0.015, 0.008));
  vec3 sky = u_background_color * mix(0.34, 0.9, uv.y) + u_light_color * skyNoise * 0.035;
  float groundDepth = clamp((u_horizon - uv.y) / max(0.001, u_horizon), 0.0, 1.0);
  float groundNoise = noise21(vec2(uv.x * 26.0, groundDepth * 18.0));
  vec3 ground = u_background_color * mix(0.18, 0.52, groundNoise * u_roughness + groundDepth * 0.3);
  float lightA = exp(-abs(uv.x - 0.32) * mix(34.0, 12.0, groundDepth)) * pow(groundDepth, 0.65);
  float lightB = exp(-abs(uv.x - 0.68) * mix(30.0, 10.0, groundDepth)) * pow(groundDepth, 0.72);
  float reflectionBreakup = mix(0.32, 1.0, noise21(vec2(uv.x * 42.0, groundDepth * 31.0 + u_time * 0.08)));
  ground += (u_light_color * lightA + u_accent_color * lightB) * u_reflections * u_wetness * reflectionBreakup * 0.8;
  vec3 syntheticBase = mix(sky, ground, groundMask);
  vec3 sceneBase = texture2D(u_scene, uv).rgb;
  vec2 reflectedUv = vec2(
    clamp(uv.x + (groundNoise - 0.5) * 0.025 * u_roughness, 0.0, 1.0),
    clamp(2.0 * u_horizon - uv.y, 0.0, 1.0)
  );
  vec3 sourceReflection = texture2D(u_scene, reflectedUv).rgb;
  vec3 footageBase = mix(sceneBase, sourceReflection, groundMask * effectMask * u_reflections * u_wetness * 0.58);
  vec3 base = mix(syntheticBase, footageBase, u_has_scene);

  float rain = 0.0;
  for (int i = 0; i < 4; i += 1) {
    if (float(i) < u_depth_layers) rain += rainLayer(uv, float(i));
  }
  rain = clamp(rain, 0.0, 1.6) * effectMask;
  float ripple = groundMask * effectMask * rippleField(uv) * u_wetness;
  vec2 splashUv = vec2(uv.x * 72.0, (u_horizon - uv.y) * 42.0);
  vec2 splashId = floor(splashUv);
  vec2 splashCell = fract(splashUv) - 0.5;
  float impactNoise = hash21(splashId + floor(u_time * 2.6));
  float splashAge = fract(u_time * 2.6 + impactNoise);
  float splashArc = 1.0 - smoothstep(0.018, 0.055, abs(length(vec2(splashCell.x, splashCell.y * 1.8)) - splashAge * 0.34));
  float splash = groundMask * effectMask * step(1.0 - u_splashes * u_intensity * 0.16, impactNoise) * splashArc * (1.0 - splashAge);
  float horizonMist = exp(-abs(uv.y - u_horizon) * 18.0) * u_mist * (0.45 + skyNoise * 0.3);
  float lens = lensDropletField(uv);
  vec3 effectColor = u_rain_color * rain + u_light_color * (ripple * 0.52 + splash * 0.72 + horizonMist * 0.32) + mix(u_light_color, vec3(1.0), 0.65) * lens * 0.12;
  if (u_mode > 0.5) {
    float alpha = clamp(rain * 0.7 + ripple * 0.45 + splash * 0.6 + horizonMist * 0.28 + lens * 0.38, 0.0, 0.92);
    gl_FragColor = vec4(effectColor, alpha);
  } else {
    gl_FragColor = vec4(clamp(base + effectColor, 0.0, 1.0), 1.0);
  }
}`;

const FIXED_WATER_FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed_lo;
uniform float u_seed_hi;
uniform float u_mode;
uniform float u_horizon;
uniform float u_wave_scale;
uniform float u_wave_height;
uniform float u_wave_speed;
uniform float u_direction;
uniform float u_choppiness;
uniform float u_wave_octaves;
uniform float u_reflections;
uniform float u_refractions;
uniform float u_fresnel;
uniform float u_caustics;
uniform float u_clarity;
uniform float u_foam;
uniform sampler2D u_scene;
uniform float u_has_scene;
uniform sampler2D u_effect_mask;
uniform float u_has_effect_mask;
uniform vec3 u_background_color;
uniform vec3 u_shallow_color;
uniform vec3 u_deep_color;
uniform vec3 u_reflection_color;
uniform vec3 u_foam_color;

float seedPhase() { return u_seed_lo * 37.17 + u_seed_hi * 91.53; }

float waveField(vec2 point) {
  float angle = radians(u_direction);
  vec2 direction = vec2(cos(angle), sin(angle));
  float height = 0.0;
  float amplitude = 0.58;
  float frequency = 1.0;
  for (int i = 0; i < 4; i += 1) {
    if (float(i) < u_wave_octaves) {
      float fi = float(i);
      vec2 rotated = vec2(direction.x * cos(fi * 0.73) - direction.y * sin(fi * 0.73), direction.x * sin(fi * 0.73) + direction.y * cos(fi * 0.73));
      float phase = dot(point, rotated) * u_wave_scale * frequency + u_time * u_wave_speed * (1.0 + fi * 0.23) + seedPhase() * (0.17 + fi * 0.11);
      float wave = sin(phase + sin(phase * 0.47 + fi) * u_choppiness * 1.8);
      height += wave * amplitude;
      amplitude *= 0.54;
      frequency *= 1.87;
    }
  }
  return height * u_wave_height;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float effectMask = mix(1.0, dot(texture2D(u_effect_mask, uv).rgb, vec3(0.2126, 0.7152, 0.0722)), u_has_effect_mask);
  float waterMask = (1.0 - smoothstep(u_horizon - 0.008, u_horizon + 0.008, uv.y)) * effectMask;
  float depth = clamp((u_horizon - uv.y) / max(0.001, u_horizon), 0.0, 1.0);
  vec2 point = vec2((uv.x - 0.5) * mix(3.0, 10.0, depth), depth * 9.0);
  float wave = waveField(point);
  float epsilon = 0.018;
  float waveX = waveField(point + vec2(epsilon, 0.0));
  float waveY = waveField(point + vec2(0.0, epsilon));
  vec3 normal = normalize(vec3((wave - waveX) * 4.2, (wave - waveY) * 5.4, 1.0));
  float viewFresnel = pow(clamp(1.0 - normal.z, 0.0, 1.0), mix(4.5, 1.2, u_fresnel));

  vec3 sceneBase = texture2D(u_scene, uv).rgb;
  vec3 skyScene = mix(u_background_color * 0.62, u_reflection_color * 0.76, pow(uv.y, 1.55) * 0.58);
  float skyCloud = 0.5 + 0.5 * sin(uv.x * 4.2 + sin(uv.y * 5.1 + seedPhase()) * 0.7 + u_time * 0.025);
  skyScene *= mix(0.91, 1.035, skyCloud);
  skyScene = mix(skyScene, sceneBase, u_has_scene);
  vec3 reflectedSky = mix(u_background_color * 0.52, u_reflection_color, clamp(0.5 + normal.y * 0.38 + viewFresnel * 0.45, 0.0, 1.0));
  float reflectionCloud = 0.5 + 0.5 * sin((uv.x + normal.x * 0.07) * 8.0 + u_time * 0.06 + seedPhase());
  reflectedSky *= mix(0.8, 1.05, reflectionCloud);
  vec2 reflectedUv = vec2(
    clamp(uv.x + normal.x * 0.045, 0.0, 1.0),
    clamp(2.0 * u_horizon - uv.y + normal.y * 0.028, 0.0, 1.0)
  );
  vec3 sourceReflection = texture2D(u_scene, reflectedUv).rgb;
  reflectedSky = mix(reflectedSky, sourceReflection, u_has_scene);
  vec3 refracted = mix(u_shallow_color, u_deep_color, clamp(depth + wave * 0.16, 0.0, 1.0));
  refracted *= mix(0.72, 1.16, u_clarity);
  vec2 refractedUv = clamp(uv + normal.xy * 0.018 * u_refractions, vec2(0.0), vec2(1.0));
  vec3 sourceRefraction = texture2D(u_scene, refractedUv).rgb;
  refracted = mix(refracted, sourceRefraction * mix(u_shallow_color, vec3(1.0), 0.72), u_has_scene * 0.78);
  float causticA = abs(sin(point.x * 2.3 + wave * 3.2 + u_time * 0.52));
  float causticB = abs(cos(point.y * 2.8 - wave * 2.1 - u_time * 0.38));
  float caustic = pow(causticA * causticB, 5.0) * u_caustics * (1.0 - depth * 0.78);
  refracted += u_reflection_color * caustic * 0.58;

  vec3 lightDirection = normalize(vec3(-0.36, 0.42, 0.82));
  float specular = pow(max(dot(normal, lightDirection), 0.0), mix(96.0, 24.0, u_choppiness));
  float reflectionMix = clamp(u_reflections * (viewFresnel + 0.18) + specular * 0.76, 0.0, 1.0);
  vec3 water = mix(refracted * u_refractions, reflectedSky, reflectionMix);
  float foam = smoothstep(0.64, 1.08, abs(wave) + u_choppiness * abs(normal.x + normal.y) * 0.38) * u_foam;
  water = mix(water, u_foam_color, foam * 0.78);
  water += u_reflection_color * specular * 1.35;
  float horizonGlow = exp(-abs(uv.y - u_horizon) * 46.0) * u_reflection_color.r * 0.07;
  water += u_reflection_color * horizonGlow;

  if (u_mode > 0.5) {
    float alpha = waterMask * clamp(viewFresnel * u_reflections * 0.5 + specular + caustic * 0.5 + foam * 0.72, 0.0, 0.88);
    gl_FragColor = vec4(clamp(water, 0.0, 1.0), alpha);
  } else {
    gl_FragColor = vec4(clamp(mix(skyScene, water, waterMask), 0.0, 1.0), 1.0);
  }
}`;

const FIXED_SNOW_FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed_lo;
uniform float u_seed_hi;
uniform float u_mode;
uniform float u_intensity;
uniform float u_speed;
uniform float u_wind;
uniform float u_turbulence;
uniform float u_flake_size;
uniform float u_depth_layers;
uniform float u_focus_falloff;
uniform float u_horizon;
uniform float u_accumulation;
uniform float u_drift;
uniform float u_contact_amount;
uniform float u_haze;
uniform float u_depth_fade;
uniform sampler2D u_scene;
uniform float u_has_scene;
uniform sampler2D u_effect_mask;
uniform float u_has_effect_mask;
uniform vec3 u_background_color;
uniform vec3 u_snow_color;
uniform vec3 u_shadow_color;
uniform vec3 u_light_color;

float seedPhase() { return u_seed_lo * 37.17 + u_seed_hi * 91.53; }

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + seedPhase());
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  float n = hash21(p);
  return vec2(n, hash21(p + n + 19.19));
}

vec2 snowLayer(vec2 uv, float layerIndex) {
  float depth = (layerIndex + 0.5) / 4.0;
  float cells = mix(11.0, 39.0, depth);
  vec2 p = vec2(uv.x * u_resolution.x / u_resolution.y, uv.y) * cells;
  float fall = u_time * u_speed * mix(2.5, 5.8, depth);
  float gust = sin(u_time * 0.43 + uv.y * 5.0 + layerIndex * 1.7 + seedPhase()) * u_turbulence;
  p.x -= u_time * u_wind * mix(0.8, 2.4, depth) + gust * 0.85;
  p.y += fall;
  float radius = mix(0.13, 0.038, depth) * u_flake_size;
  float blur = mix(0.055, 0.012, depth) * mix(0.35, 1.0, u_focus_falloff);
  float depthOpacity = mix(1.0 - u_depth_fade * 0.58, 1.0, depth);
  vec2 result = vec2(0.0);
  vec2 baseCell = floor(p);
  vec2 local = fract(p) - 0.5;
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 cell = baseCell + neighbor;
      vec2 offset = hash22(cell + layerIndex * 43.7) - 0.5;
      offset.x += sin((cell.y + seedPhase()) * 1.7 + u_time * (0.5 + depth)) * u_turbulence * 0.34;
      float distanceToFlake = length(local - neighbor - offset * 0.72);
      float core = 1.0 - smoothstep(radius * 0.28, radius + blur, distanceToFlake);
      float halo = 1.0 - smoothstep(radius * 0.65, radius * 1.65 + blur, distanceToFlake);
      float variation = mix(0.44, 1.0, hash21(cell + layerIndex * 9.3));
      float active = step(mix(0.82, 0.48, u_intensity), hash21(cell + layerIndex * 31.1 + 7.7));
      result = max(result, vec2(core, halo * (1.0 - depth) * u_focus_falloff) * variation * active);
    }
  }
  return result * depthOpacity;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float effectMask = mix(1.0, dot(texture2D(u_effect_mask, uv).rgb, vec3(0.2126, 0.7152, 0.0722)), u_has_effect_mask);
  float driftA = sin(uv.x * 9.0 + seedPhase() * 0.17) * 0.5;
  float driftB = sin(uv.x * 23.0 - seedPhase() * 0.31) * 0.5;
  float snowLine = u_horizon + (driftA * 0.018 + driftB * 0.006) * u_drift;
  float groundMask = (1.0 - smoothstep(snowLine - 0.008, snowLine + 0.008, uv.y)) * effectMask;

  vec3 sky = mix(u_background_color * 0.6, u_light_color * 0.68, pow(uv.y, 1.35) * (0.28 + u_haze * 0.24));
  float cloud = 0.5 + 0.5 * sin(uv.x * 4.1 + sin(uv.y * 6.4 + seedPhase()) + u_time * 0.025);
  sky *= mix(0.86, 1.07, cloud * u_haze);
  float horizonGlow = exp(-abs(uv.y - snowLine) * 18.0) * u_haze;
  sky = mix(sky, u_light_color, horizonGlow * 0.22);

  float groundDepth = clamp((snowLine - uv.y) / max(0.01, snowLine), 0.0, 1.0);
  float driftTexture = 0.5 + 0.5 * sin((uv.x * 34.0 + groundDepth * 13.0) + driftA * 3.0);
  vec3 ground = mix(u_shadow_color * 0.48, u_snow_color, 0.34 + u_accumulation * 0.58);
  ground *= mix(0.83, 1.08, driftTexture * u_drift * (1.0 - groundDepth * 0.68));
  ground = mix(ground, u_shadow_color, groundDepth * 0.34);

  vec2 snowfall = vec2(0.0);
  for (int i = 0; i < 4; i += 1) {
    if (float(i) < u_depth_layers) snowfall += snowLayer(uv, float(i));
  }
  snowfall *= u_intensity * mix(0.38, 0.68, 4.0 / max(1.0, u_depth_layers)) * effectMask;
  float flakes = clamp(snowfall.x, 0.0, 1.0);
  float bokeh = clamp(snowfall.y, 0.0, 1.0);

  vec2 contactPoint = vec2(uv.x * 92.0, (uv.y - snowLine) * 180.0 + u_time * 2.2);
  vec2 contactCell = floor(contactPoint);
  vec2 contactOffset = hash22(contactCell + 81.7) - 0.5;
  float contactSpark = 1.0 - smoothstep(0.04, 0.22, length(fract(contactPoint) - 0.5 - contactOffset * 0.64));
  float contactBand = exp(-abs(uv.y - snowLine) * 105.0);
  float contact = contactSpark * step(0.88, hash21(contactCell + 12.4)) * contactBand * u_contact_amount * u_intensity;
  vec3 effectColor = u_snow_color * flakes + u_light_color * (bokeh * 0.42 + contact * 1.25);
  vec3 syntheticScene = mix(sky, ground, groundMask * u_accumulation);
  vec3 sceneBase = texture2D(u_scene, uv).rgb;
  vec3 snowCoverage = mix(sceneBase * 0.72, u_snow_color, 0.62 + u_accumulation * 0.28);
  vec3 footageScene = mix(sceneBase, snowCoverage, groundMask * u_accumulation * 0.78);
  vec3 scene = mix(syntheticScene, footageScene, u_has_scene);
  scene = mix(scene, u_light_color, u_haze * u_depth_fade * (1.0 - uv.y) * 0.08);

  if (u_mode > 0.5) {
    float alpha = clamp(flakes + bokeh * 0.32 + contact + groundMask * u_accumulation * 0.72, 0.0, 0.94);
    vec3 overlayColor = mix(effectColor, ground, groundMask * u_accumulation);
    gl_FragColor = vec4(clamp(overlayColor, 0.0, 1.0), alpha);
  } else {
    gl_FragColor = vec4(clamp(scene + effectColor, 0.0, 1.0), 1.0);
  }
}`;

const FIXED_FOG_FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed_lo;
uniform float u_seed_hi;
uniform float u_mode;
uniform float u_density;
uniform float u_speed;
uniform float u_scale;
uniform float u_turbulence;
uniform float u_height;
uniform float u_depth_layers;
uniform float u_light_strength;
uniform sampler2D u_scene;
uniform float u_has_scene;
uniform sampler2D u_effect_mask;
uniform float u_has_effect_mask;
uniform vec3 u_background_color;
uniform vec3 u_fog_color;
uniform vec3 u_light_color;

float seedPhase() { return u_seed_lo * 37.17 + u_seed_hi * 91.53; }

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + seedPhase());
  return fract(p.x * p.y);
}

float noise21(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fogLayer(vec2 uv, float layerIndex) {
  float depth = (layerIndex + 0.5) / 4.0;
  float scale = u_scale * mix(0.55, 1.85, depth);
  vec2 point = vec2(uv.x * u_resolution.x / max(1.0, u_resolution.y), uv.y) * scale;
  point.x += u_time * u_speed * mix(0.12, 0.42, depth);
  point.y += sin(point.x * 0.82 + u_time * 0.17 + seedPhase()) * u_turbulence * 0.34;
  float coarse = noise21(point + vec2(layerIndex * 19.7, seedPhase() * 0.13));
  float detail = noise21(point * 2.13 - vec2(u_time * u_speed * 0.08, layerIndex * 7.1));
  return smoothstep(0.24, 0.82, coarse * 0.72 + detail * 0.28) * mix(0.42, 1.0, depth);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float effectMask = mix(1.0, dot(texture2D(u_effect_mask, uv).rgb, vec3(0.2126, 0.7152, 0.0722)), u_has_effect_mask);
  float heightEnvelope = 1.0 - smoothstep(clamp(u_height, 0.02, 0.98), 1.0, uv.y);
  float volume = 0.0;
  for (int i = 0; i < 4; i += 1) {
    if (float(i) < u_depth_layers) volume += fogLayer(uv, float(i));
  }
  volume *= mix(0.52, 0.28, (u_depth_layers - 1.0) / 3.0);
  float fogAlpha = clamp(volume * u_density * heightEnvelope * effectMask, 0.0, 0.94);
  float shaftA = pow(max(0.0, sin(uv.x * 5.4 + seedPhase() * 0.03)), 8.0);
  float shaftB = pow(max(0.0, sin(uv.x * 9.1 - seedPhase() * 0.05 + 1.8)), 12.0);
  float shaft = (shaftA * 0.65 + shaftB * 0.35) * (0.35 + volume * 0.65) * u_light_strength * heightEnvelope;
  vec3 volumeColor = mix(u_fog_color, u_light_color, clamp(shaft, 0.0, 1.0));
  vec3 syntheticScene = mix(u_background_color * 0.58, u_background_color, pow(uv.y, 1.3));
  vec3 sceneBase = texture2D(u_scene, uv).rgb;
  vec3 base = mix(syntheticScene, sceneBase, u_has_scene);
  if (u_mode > 0.5) {
    gl_FragColor = vec4(clamp(volumeColor + u_light_color * shaft * 0.18, 0.0, 1.0), clamp(fogAlpha + shaft * 0.14 * effectMask, 0.0, 0.96));
  } else {
    vec3 scene = mix(base, volumeColor, fogAlpha);
    scene += u_light_color * shaft * 0.16 * effectMask;
    gl_FragColor = vec4(clamp(scene, 0.0, 1.0), 1.0);
  }
}`;

function fixedEnvironmentRuntimeScript(): string {
  const rainFragmentSource = Buffer.from(FIXED_RAIN_FRAGMENT_SHADER).toString("base64");
  const waterFragmentSource = Buffer.from(FIXED_WATER_FRAGMENT_SHADER).toString("base64");
  const snowFragmentSource = Buffer.from(FIXED_SNOW_FRAGMENT_SHADER).toString("base64");
  const fogFragmentSource = Buffer.from(FIXED_FOG_FRAGMENT_SHADER).toString("base64");
  return `<script data-shellx-motion-environment-runtime="true">(async() => {
const vertexSource = "attribute vec2 a_position; void main(){ gl_Position=vec4(a_position,0.0,1.0); }";
const rainFragmentSource = atob("${rainFragmentSource}");
const waterFragmentSource = atob("${waterFragmentSource}");
const snowFragmentSource = atob("${snowFragmentSource}");
const fogFragmentSource = atob("${fogFragmentSource}");
const decode = (value) => JSON.parse(atob(value || ""));
const compile = (gl,type,source) => { const shader=gl.createShader(type);if(!shader)throw new Error("WebGL could not allocate an environment shader.");gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error((gl.getShaderInfoLog(shader)||"Environment shader compilation failed.").slice(0,512));return shader; };
const hex = (value) => [parseInt(value.slice(1,3),16)/255,parseInt(value.slice(3,5),16)/255,parseInt(value.slice(5,7),16)/255];
const layerById = (id) => [...document.querySelectorAll("[data-layer-id]")].find((element) => element.dataset.layerId === id);
const readyImage = async (id) => {
 if(!id)return null;
 const host=layerById(id),image=host instanceof HTMLImageElement?host:host?.querySelector("img");
 if(!(image instanceof HTMLImageElement))throw new Error("Environment scene source image is unavailable.");
 if(!image.complete)await new Promise((resolve,reject)=>{image.addEventListener("load",resolve,{once:true});image.addEventListener("error",()=>reject(new Error("Environment scene source image failed to load.")),{once:true});});
 if(typeof image.decode==="function")await image.decode();
 if(!image.naturalWidth||!image.naturalHeight)throw new Error("Environment scene source image has no decodable pixels.");
 return image;
};
const bindTexture = (gl,unit,image,fallback) => { const texture=gl.createTexture();if(!texture)throw new Error("WebGL could not allocate an environment texture.");gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);if(image)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(fallback));return texture; };
for(const canvas of document.querySelectorAll("canvas[data-motion-environment]")){
 try{
  const config=decode(canvas.dataset.motionEnvironmentConfig),gl=canvas.getContext("webgl",{alpha:true,antialias:false,depth:false,stencil:false,premultipliedAlpha:true,preserveDrawingBuffer:true,powerPreference:"low-power"});
  if(!gl)throw new Error("Deterministic WebGL is unavailable.");
  const program=gl.createProgram();if(!program)throw new Error("WebGL could not allocate an environment program.");
  const fragmentSource=config.kind==="water"?waterFragmentSource:config.kind==="snow"?snowFragmentSource:config.kind==="fog"?fogFragmentSource:rainFragmentSource;gl.attachShader(program,compile(gl,gl.VERTEX_SHADER,vertexSource));gl.attachShader(program,compile(gl,gl.FRAGMENT_SHADER,fragmentSource));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error((gl.getProgramInfoLog(program)||"Environment shader link failed.").slice(0,512));gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,"a_position");gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const set1=(name,value) => { const location=gl.getUniformLocation(program,name);if(location!==null)gl.uniform1f(location,value); };
  const set3=(name,value) => { const location=gl.getUniformLocation(program,name);if(location!==null)gl.uniform3fv(location,new Float32Array(hex(value))); };
  const [sourceImage,effectMaskImage]=await Promise.all([readyImage(config.sceneSourceLayerId),readyImage(config.effectMaskLayerId)]);bindTexture(gl,0,sourceImage,[0,0,0,255]);bindTexture(gl,1,effectMaskImage,[255,255,255,255]);const sceneLocation=gl.getUniformLocation(program,"u_scene");if(sceneLocation!==null)gl.uniform1i(sceneLocation,0);const effectMaskLocation=gl.getUniformLocation(program,"u_effect_mask");if(effectMaskLocation!==null)gl.uniform1i(effectMaskLocation,1);set1("u_has_scene",sourceImage?1:0);set1("u_has_effect_mask",effectMaskImage?1:0);
  const resolution=gl.getUniformLocation(program,"u_resolution");if(resolution!==null)gl.uniform2f(resolution,canvas.width,canvas.height);
  set1("u_time",Number(canvas.dataset.motionEnvironmentTime||0));set1("u_seed_lo",(config.seed&65535)/65535);set1("u_seed_hi",((config.seed>>>16)&65535)/65535);set1("u_mode",config.mode==="overlay"?1:0);
  if(config.kind==="water"){set1("u_horizon",config.surface.horizon);set1("u_wave_scale",config.surface.waveScale);set1("u_wave_height",config.surface.waveHeight);set1("u_wave_speed",config.surface.waveSpeed);set1("u_direction",config.surface.direction);set1("u_choppiness",config.surface.choppiness);set1("u_wave_octaves",config.surface.waveOctaves);set1("u_reflections",config.optics.reflectionStrength);set1("u_refractions",config.optics.refractionStrength);set1("u_fresnel",config.optics.fresnel);set1("u_caustics",config.optics.caustics);set1("u_clarity",config.optics.clarity);set1("u_foam",config.optics.foam);set3("u_background_color",config.backgroundColor);set3("u_shallow_color",config.shallowColor);set3("u_deep_color",config.deepColor);set3("u_reflection_color",config.reflectionColor);set3("u_foam_color",config.foamColor);}else if(config.kind==="snow"){set1("u_intensity",config.fall.intensity);set1("u_speed",config.fall.speed);set1("u_wind",config.fall.wind);set1("u_turbulence",config.fall.turbulence);set1("u_flake_size",config.fall.flakeSize);set1("u_depth_layers",config.fall.depthLayers);set1("u_focus_falloff",config.fall.focusFalloff);set1("u_horizon",config.ground.horizon);set1("u_accumulation",config.ground.accumulation);set1("u_drift",config.ground.drift);set1("u_contact_amount",config.ground.contactAmount);set1("u_haze",config.atmosphere.haze);set1("u_depth_fade",config.atmosphere.depthFade);set3("u_background_color",config.backgroundColor);set3("u_snow_color",config.snowColor);set3("u_shadow_color",config.shadowColor);set3("u_light_color",config.lightColor);}else if(config.kind==="fog"){set1("u_density",config.fog.density);set1("u_speed",config.fog.speed);set1("u_scale",config.fog.scale);set1("u_turbulence",config.fog.turbulence);set1("u_height",config.fog.height);set1("u_depth_layers",config.fog.depthLayers);set1("u_light_strength",config.fog.lightStrength);set3("u_background_color",config.backgroundColor);set3("u_fog_color",config.fogColor);set3("u_light_color",config.lightColor);}else{set1("u_intensity",config.intensity);set1("u_wind",config.wind);set1("u_drop_speed",config.dropSpeed);set1("u_drop_length",config.dropLength);set1("u_depth_layers",config.depthLayers);set1("u_horizon",config.ground.horizon);set1("u_wetness",config.ground.wetness);set1("u_roughness",config.ground.roughness);set1("u_ripples",config.ground.rippleAmount);set1("u_splashes",config.ground.splashAmount);set1("u_reflections",config.ground.reflectionStrength);set1("u_mist",config.atmosphere.mist);set1("u_lens_droplets",config.atmosphere.lensDroplets);set3("u_rain_color",config.color);set3("u_background_color",config.backgroundColor);set3("u_light_color",config.lightColor);set3("u_accent_color",config.accentColor);}
  gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();canvas.dataset.motionEnvironmentState="ready";
 }catch(error){canvas.dataset.motionEnvironmentState="error";canvas.dataset.motionEnvironmentError=String(error instanceof Error?error.message:error).slice(0,512);}
}
})();</script>`;
}

function renderGeneratedShape(pkg: MotionPackage, layer: MotionLayer, index: number, atMs: number): string {
  const style = readRecord(layer.style);
  const label = readRecord(layer.label);
  const labelStyle = readRecord(label.style);
  const labelText = readString(label.text);
  const fill = cssColor(readString(layer.fill) ?? readString(style.fill) ?? readString(style.color) ?? "#ffffff", pkg, "#ffffff");
  const gradient = cssGradient(layer, pkg);
  const stroke = cssColor(readString(style.stroke) ?? "transparent", pkg, "transparent");
  const strokeWidth = cssLength(resolveToken(readString(style.strokeWidth) ?? style.strokeWidth ?? (readString(style.stroke) ? style.width : 0) ?? 0, pkg), "0px");
  const radius = cssBorderRadius(style, pkg);
  const shadow = cssBoxShadowStyle(style, pkg);
  const labelHtml = labelText
    ? `<span style="${textStyle(labelStyle, pkg)}">${escapeHtml(labelText)}</span>`
    : "";
  const align = labelText ? "display:flex;align-items:center;justify-content:center;" : "";
  const shapeKind = generatedShapeKind(layer);
  if (shapeKind === "ellipse" || shapeKind === "triangle" || shapeKind === "star" || shapeKind === "path") {
    return renderGeneratedSvgShape({
      shapeKind, layer, index, atMs, fill, stroke, strokeWidth, shadow, labelHtml, align,
      // These shapes are drawn as SVG, which cannot take a CSS gradient string. Pass the declared
      // gradient through so the SVG path can emit a real paint server for it; without this a
      // gradient on an ellipse was accepted, validated, and silently ignored.
      gradient: svgGradientDef(layer, pkg, `grad-${index}`)
    });
  }
  return `<div data-layer-id="${escapeAttr(layer.id)}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}background:${gradient ?? fill};border:${strokeWidth} solid ${stroke};border-radius:${radius};${align}${shadow ? `${shadow};` : ""}">${labelHtml}</div>`;
}

function renderGeneratedParticles(layer: MotionLayer, index: number, atMs: number): string {
  const emitter = readRecord(layer.emitter);
  const metrics = layerBoxMetrics(layer);
  const width = metrics.width ?? 100;
  const height = metrics.height ?? 100;
  const seed = (readNumber(emitter.seed) ?? 0) >>> 0;
  const count = Math.min(1000, Math.max(1, Math.floor(readNumber(emitter.count) ?? 1)));
  const lifetimeMs = Math.min(60_000, Math.max(1, readNumber(emitter.lifetimeMs) ?? 1000));
  const minSize = Math.min(256, Math.max(0.1, readNumber(emitter.minSize) ?? 2));
  const maxSize = Math.min(256, Math.max(minSize, readNumber(emitter.maxSize) ?? 8));
  const minSpeed = Math.min(2000, Math.max(0, readNumber(emitter.minSpeed) ?? 20));
  const maxSpeed = Math.min(2000, Math.max(minSpeed, readNumber(emitter.maxSpeed) ?? 80));
  const direction = readNumber(emitter.direction) ?? -90;
  const spread = Math.min(360, Math.max(0, readNumber(emitter.spread) ?? 45));
  const gravity = Math.min(5000, Math.max(-5000, readNumber(emitter.gravity) ?? 0));
  const color = readString(emitter.color) ?? "#ffffff";
  const secondaryColor = readString(emitter.secondaryColor) ?? color;
  const radius = emitter.shape === "square" ? "0" : "50%";
  const fadeOut = emitter.fadeOut !== false;
  const localMs = Math.max(0, atMs - layer.startMs);
  const particles: string[] = [];
  for (let particleIndex = 0; particleIndex < count; particleIndex += 1) {
    const phaseMs = particleRandom(seed, particleIndex, 0) * lifetimeMs;
    const ageMs = (localMs + phaseMs) % lifetimeMs;
    const ageRatio = ageMs / lifetimeMs;
    const angleDegrees = direction + (particleRandom(seed, particleIndex, 1) - 0.5) * spread;
    const angleRadians = angleDegrees * Math.PI / 180;
    const speed = minSpeed + particleRandom(seed, particleIndex, 2) * (maxSpeed - minSpeed);
    const size = minSize + particleRandom(seed, particleIndex, 3) * (maxSize - minSize);
    const ageSeconds = ageMs / 1000;
    const x = width / 2 + Math.cos(angleRadians) * speed * ageSeconds - size / 2;
    const y = height / 2 + Math.sin(angleRadians) * speed * ageSeconds + 0.5 * gravity * ageSeconds * ageSeconds - size / 2;
    const opacity = fadeOut ? Math.max(0, 1 - ageRatio) : 1;
    const particleColor = particleRandom(seed, particleIndex, 4) < 0.5 ? color : secondaryColor;
    particles.push(`<span aria-hidden="true" style="position:absolute;left:${formatSvgTransformNumber(x)}px;top:${formatSvgTransformNumber(y)}px;width:${formatSvgTransformNumber(size)}px;height:${formatSvgTransformNumber(size)}px;border-radius:${radius};background:${particleColor};opacity:${formatSvgTransformNumber(opacity)}"></span>`);
  }
  return `<div data-layer-id="${escapeAttr(layer.id)}" data-motion-particles="true" data-particle-count="${count}" data-particle-seed="${seed}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}">${particles.join("")}</div>`;
}

function particleRandom(seed: number, particleIndex: number, channel: number): number {
  let value = (seed ^ Math.imul(particleIndex + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function cssGradient(layer: MotionLayer, pkg: MotionPackage): string | null {
  const gradient = readRecord(layer.gradient);
  const stops = Array.isArray(gradient.stops) ? gradient.stops : [];
  if ((gradient.type !== "linear" && gradient.type !== "radial") || stops.length < 2 || stops.length > 16) return null;
  const cssStops = stops.map((value) => {
    const stop = readRecord(value);
    const offset = readNumber(stop.offset);
    if (offset === null || offset < 0 || offset > 1) return null;
    const color = cssColor(stop.color, pkg, "transparent");
    return `${color} ${formatSvgTransformNumber(offset * 100)}%`;
  });
  if (cssStops.some((stop) => stop === null)) return null;
  if (gradient.type === "radial") {
    const centerX = clamp(readNumber(gradient.centerX) ?? 0.5, 0, 1) * 100;
    const centerY = clamp(readNumber(gradient.centerY) ?? 0.5, 0, 1) * 100;
    return `radial-gradient(circle at ${formatSvgTransformNumber(centerX)}% ${formatSvgTransformNumber(centerY)}%, ${cssStops.join(", ")})`;
  }
  const angle = readNumber(gradient.angle) ?? 180;
  return `linear-gradient(${formatSvgTransformNumber(angle)}deg, ${cssStops.join(", ")})`;
}

/**
 * An SVG paint server for a layer's declared gradient, or null when it declares none.
 *
 * SVG shapes cannot take the CSS gradient string the rect path uses, so the same declaration is
 * emitted as `<linearGradient>` / `<radialGradient>`. `objectBoundingBox` units keep it aligned to
 * the shape regardless of the layer's size.
 *
 * The id must be unique per layer within a frame; the caller passes the layer index for that.
 */
function svgGradientDef(layer: MotionLayer, pkg: MotionPackage, id: string): { id: string; def: string } | null {
  const gradient = readRecord(layer.gradient);
  const rawStops = Array.isArray(gradient.stops) ? gradient.stops : [];
  if ((gradient.type !== "linear" && gradient.type !== "radial") || rawStops.length < 2 || rawStops.length > 16) return null;
  const stops: string[] = [];
  for (const value of rawStops) {
    const stop = readRecord(value);
    const offset = readNumber(stop.offset);
    if (offset === null || offset < 0 || offset > 1) return null;
    const color = cssColor(stop.color, pkg, "transparent");
    stops.push(`<stop offset="${escapeAttr(formatSvgTransformNumber(offset * 100))}%" stop-color="${escapeAttr(color)}"/>`);
  }
  if (gradient.type === "radial") {
    const cx = clamp(readNumber(gradient.centerX) ?? 0.5, 0, 1) * 100;
    const cy = clamp(readNumber(gradient.centerY) ?? 0.5, 0, 1) * 100;
    return {
      id,
      def: `<radialGradient id="${escapeAttr(id)}" cx="${escapeAttr(formatSvgTransformNumber(cx))}%" cy="${escapeAttr(formatSvgTransformNumber(cy))}%" r="50%">${stops.join("")}</radialGradient>`
    };
  }
  // CSS measures the angle clockwise from "to top"; SVG wants an explicit vector. Convert once
  // here so an author's `angle` means the same thing on every shape kind.
  const angle = readNumber(gradient.angle) ?? 180;
  const radians = ((angle - 90) * Math.PI) / 180;
  const x1 = 50 - Math.cos(radians) * 50, y1 = 50 - Math.sin(radians) * 50;
  const x2 = 50 + Math.cos(radians) * 50, y2 = 50 + Math.sin(radians) * 50;
  return {
    id,
    def: `<linearGradient id="${escapeAttr(id)}" x1="${escapeAttr(formatSvgTransformNumber(x1))}%" y1="${escapeAttr(formatSvgTransformNumber(y1))}%" x2="${escapeAttr(formatSvgTransformNumber(x2))}%" y2="${escapeAttr(formatSvgTransformNumber(y2))}%">${stops.join("")}</linearGradient>`
  };
}

type GeneratedSvgShapeKind = "ellipse" | "triangle" | "star" | "path";

function generatedShapeKind(layer: MotionLayer): string | null {
  const shape = readString(layer.shape);
  if (shape === "freeform" && generatedShapePath(layer)) return "path";
  return shape;
}

function renderGeneratedSvgShape(input: {
  shapeKind: GeneratedSvgShapeKind;
  layer: MotionLayer;
  index: number;
  atMs: number;
  fill: string;
  stroke: string;
  strokeWidth: string;
  shadow: string | null;
  labelHtml: string;
  align: string;
  gradient?: { id: string; def: string } | null;
}): string {
  const viewBox = generatedShapeViewBox(input.layer);
  const paint = input.gradient ? `url(#${input.gradient.id})` : input.fill;
  const svg = [
    `<svg aria-hidden="true" viewBox="${escapeAttr(viewBox)}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;">`,
    input.gradient ? `<defs>${input.gradient.def}</defs>` : "",
    generatedSvgShapeElement(input.shapeKind, input.layer, paint, input.stroke, input.strokeWidth),
    "</svg>"
  ].join("");

  return `<div data-layer-id="${escapeAttr(input.layer.id)}" data-start="${input.layer.startMs}" data-duration="${input.layer.durationMs}" style="${boxStyle(input.layer, input.index, undefined, input.atMs)}${input.align}${input.shadow ? `${input.shadow};` : ""}">${svg}${input.labelHtml}</div>`;
}

function generatedSvgShapeElement(
  shapeKind: GeneratedSvgShapeKind,
  layer: MotionLayer,
  fill: string,
  stroke: string,
  strokeWidth: string
): string {
  const linecap = cssSvgStrokeLinecap(readRecord(layer.style).strokeLinecap);
  const paintAttrs = `fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${escapeAttr(strokeWidth)}" stroke-linecap="${linecap}" vector-effect="non-scaling-stroke"`;
  if (shapeKind === "ellipse") return `<ellipse cx="50" cy="50" rx="50" ry="50" ${paintAttrs}></ellipse>`;
  if (shapeKind === "triangle") return `<polygon points="50,0 0,100 100,100" ${paintAttrs}></polygon>`;
  if (shapeKind === "star") return `<polygon points="${escapeAttr(generatedStarPoints())}" ${paintAttrs}></polygon>`;

  const pathData = generatedShapePath(layer);
  if (!pathData) {
    throw new Error(`Browser generated path shape ${layer.id} requires an x-path string.`);
  }
  return `<path d="${escapeAttr(pathData)}" ${paintAttrs}></path>`;
}

function cssSvgStrokeLinecap(value: unknown): "butt" | "round" | "square" {
  const linecap = readString(value)?.trim().toLowerCase();
  return linecap === "round" || linecap === "square" ? linecap : "butt";
}

function generatedStarPoints(): string {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = (-Math.PI / 2) + (index * Math.PI / 5);
    const radius = index % 2 === 0 ? 50 : 22.5;
    const x = 50 + (Math.cos(angle) * radius);
    const y = 50 + (Math.sin(angle) * radius);
    points.push(`${formatSvgPoint(x)},${formatSvgPoint(y)}`);
  }
  return points.join(" ");
}

function formatSvgPoint(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function generatedShapePath(layer: MotionLayer): string | null {
  return readString(layer["x-path"]) ?? readString(readRecord(layer.style).path);
}

function generatedShapeViewBox(layer: MotionLayer): string {
  const value = readString(layer["x-path-viewBox"]);
  if (!value) return "0 0 100 100";
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) {
    throw new Error(`Browser generated path shape ${layer.id} has an invalid x-path-viewBox.`);
  }
  return parts.map((part) => Number(part.toFixed(4)).toString()).join(" ");
}

function renderGeneratedText(pkg: MotionPackage, layer: MotionLayer, index: number, atMs: number): string {
  const style = readRecord(layer.style);
  const text = readString(layer.text) ?? "";
  const justifyContent = cssTextVerticalAlign(style.verticalAlign ?? style.alignY);
  const direction = htmlTextDirection(style.direction, text);
  const lang = htmlTextLanguage(style.lang ?? readRecord(layer).lang);
  const requestedFont = requestedFontFamily(style.fontFamily);
  const textFitAttrs = generatedTextFitAttributes(layer);
  return `<div data-layer-id="${escapeAttr(layer.id)}" data-motion-text="true"${textFitAttrs}${direction ? ` dir="${direction}"` : ""}${lang ? ` lang="${escapeAttr(lang)}"` : ""}${requestedFont ? ` data-requested-font-family="${escapeAttr(requestedFont)}"` : ""} data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, { defaultWidth: null, defaultHeight: null }, atMs)}${textStyle(style, pkg)}display:flex;flex-direction:column;justify-content:${justifyContent};white-space:pre-wrap;overflow:hidden;"><span style="display:block;width:100%">${escapeHtml(text)}</span></div>`;
}

function generatedTextFitAttributes(layer: MotionLayer): string {
  const textFit = readRecord(layer.textFit);
  const policy = readString(textFit.policy);
  if (policy !== "safe" && policy !== "allow-crop" && policy !== "auto-fit") {
    return ` data-text-fit-policy="unchecked"`;
  }
  const safeAreaId = readString(textFit.safeAreaId);
  const minFontSize = readNumber(textFit.minFontSize);
  return [
    ` data-text-fit-policy="${policy}"`,
    safeAreaId ? ` data-text-fit-safe-area="${escapeAttr(safeAreaId)}"` : "",
    minFontSize !== null ? ` data-text-fit-min-font-size="${formatSvgTransformNumber(minFontSize)}"` : ""
  ].join("");
}

async function renderGeneratedImage(pkg: MotionPackage, layer: MotionLayer, index: number, assetRefs: Set<string>, atMs: number): Promise<string> {
  const asset = assetForLayer(pkg, layer, "Image");
  const source = readRecord(asset.source);
  const assetRef = readString(source.path);
  if (!assetRef) {
    throw new Error(`Image layer ${layer.id} does not reference a package asset path.`);
  }
  const assetPath = resolvePackageAsset(pkg, assetRef);
  if (!existsSync(assetPath)) {
    throw new Error(`Image layer ${layer.id} references a missing package asset: ${assetRef}`);
  }
  assetRefs.add(assetRef);
  const mimeType = readString(source.mimeType) ?? mimeTypeForAsset(assetRef);
  const dataUrl = `data:${mimeType};base64,${(await readFile(assetPath)).toString("base64")}`;
  const objectFit = browserObjectFit(layer);
  const style = readRecord(layer.style);
  const radius = cssBorderRadius(style, pkg);
  const shadow = cssBoxShadowStyle(style, pkg);
  const crop = readMediaCrop(layer.crop);
  if (crop) {
    const box = layerBoxSize(layer, { defaultWidth: 100, defaultHeight: 100 });
    const placement = imagePlacementForBox({ x: 0, y: 0, width: box.width, height: box.height }, crop, browserImageFit(layer));
    const scaleX = placement.width / crop.width;
    const scaleY = placement.height / crop.height;
    const imageStyle = [
      "position:absolute",
      `left:${placement.x - (crop.x * scaleX)}px`,
      `top:${placement.y - (crop.y * scaleY)}px`,
      "width:auto",
      "height:auto",
      "max-width:none",
      "display:block",
      "transform-origin:top left",
      `transform:scale(${scaleX},${scaleY})`,
      "image-rendering:pixelated"
    ].join(";") + ";";
    return `<div data-layer-id="${escapeAttr(layer.id)}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}border-radius:${radius};${shadow ? `${shadow};` : ""}"><img data-layer-id="${escapeAttr(layer.id)}"${motionKeyingDataAttribute(layer)} src="${escapeAttr(dataUrl)}" alt="" style="${imageStyle}"></div>`;
  }
  return `<img data-layer-id="${escapeAttr(layer.id)}"${motionKeyingDataAttribute(layer)} data-start="${layer.startMs}" data-duration="${layer.durationMs}" src="${escapeAttr(dataUrl)}" alt="" style="${boxStyle(layer, index, undefined, atMs)}display:block;object-fit:${objectFit};border-radius:${radius};${shadow ? `${shadow};` : ""}">`;
}

async function renderGeneratedVideo(pkg: MotionPackage, layer: MotionLayer, index: number, assetRefs: Set<string>, atMs: number): Promise<string> {
  const asset = assetForLayer(pkg, layer, "Video");
  const source = readRecord(asset.source);
  const assetRef = readString(source.path);
  if (!assetRef) {
    throw new Error(`Video layer ${layer.id} does not reference a package asset path.`);
  }
  const assetPath = resolvePackageAsset(pkg, assetRef);
  if (!existsSync(assetPath)) {
    throw new Error(`Video layer ${layer.id} references a missing package asset: ${assetRef}`);
  }
  assetRefs.add(assetRef);
  const mimeType = readString(source.mimeType) ?? mimeTypeForAsset(assetRef);
  const dataUrl = `data:${mimeType};base64,${(await readFile(assetPath)).toString("base64")}`;
  const objectFit = browserObjectFit(layer);
  const style = readRecord(layer.style);
  const radius = cssBorderRadius(style, pkg);
  const shadow = cssBoxShadowStyle(style, pkg);
  const trimStartMs = typeof layer.trimStartMs === "number" ? layer.trimStartMs : 0;
  const trimDurationMs = typeof layer.trimDurationMs === "number" ? layer.trimDurationMs : "";
  const loop = layer.loop === true ? "true" : "false";
  const playbackRate = typeof layer.playbackRate === "number" && Number.isFinite(layer.playbackRate) && layer.playbackRate > 0
    ? layer.playbackRate
    : 1;
  const mediaTimeMs = videoMediaTimeMsForLayer(layer, atMs);
  const videoAttrs = `data-shellx-motion-video="true" data-layer-id="${escapeAttr(layer.id)}"${motionKeyingDataAttribute(layer)} data-start="${layer.startMs}" data-duration="${layer.durationMs}" data-trim-start-ms="${trimStartMs}" data-trim-duration-ms="${trimDurationMs}" data-loop="${loop}" data-playback-rate="${playbackRate}" data-media-time-ms="${formatSvgPoint(mediaTimeMs)}" src="${escapeAttr(dataUrl)}" muted playsinline preload="auto"`;
  const crop = readMediaCrop(layer.crop);
  if (crop) {
    const box = layerBoxSize(layer, { defaultWidth: 100, defaultHeight: 100 });
    const placement = imagePlacementForBox({ x: 0, y: 0, width: box.width, height: box.height }, crop, browserImageFit(layer));
    const scaleX = placement.width / crop.width;
    const scaleY = placement.height / crop.height;
    const sourceSize = mediaSourceSize(asset, crop);
    const videoStyle = [
      "position:absolute",
      `left:${placement.x - (crop.x * scaleX)}px`,
      `top:${placement.y - (crop.y * scaleY)}px`,
      `width:${sourceSize.width}px`,
      `height:${sourceSize.height}px`,
      "max-width:none",
      "display:block",
      "transform-origin:top left",
      `transform:scale(${scaleX},${scaleY})`
    ].join(";") + ";";
    return `<div data-layer-id="${escapeAttr(layer.id)}" data-start="${layer.startMs}" data-duration="${layer.durationMs}" style="${boxStyle(layer, index, undefined, atMs)}border-radius:${radius};${shadow ? `${shadow};` : ""}"><video ${videoAttrs} style="${videoStyle}"></video></div>`;
  }
  return `<video ${videoAttrs} style="${boxStyle(layer, index, undefined, atMs)}display:block;object-fit:${objectFit};border-radius:${radius};${shadow ? `${shadow};` : ""}"></video>`;
}

export function videoMediaTimeMsForLayer(layer: Pick<MotionLayer, "startMs" | "trimStartMs" | "trimDurationMs" | "loop" | "playbackRate" | "keyframes">, atMs: number): number {
  const trimStartMs = finiteNumberOr(layer.trimStartMs, 0);
  const trimDurationMs = finiteNumberOr(layer.trimDurationMs, 0);
  const sourceElapsedMs = integratedPlaybackElapsedMs(layer, atMs);
  const loopedSourceElapsedMs = layer.loop === true && trimDurationMs > 0
    ? sourceElapsedMs % trimDurationMs
    : sourceElapsedMs;
  return trimStartMs + loopedSourceElapsedMs;
}

function integratedPlaybackElapsedMs(
  layer: Pick<MotionLayer, "startMs" | "playbackRate" | "keyframes">,
  atMs: number
): number {
  const endMs = Math.max(layer.startMs, atMs);
  if (endMs === layer.startMs) return 0;
  const playbackKeyframes = layer.keyframes?.playbackRate;
  if (!playbackKeyframes || playbackKeyframes.length === 0) {
    return (endMs - layer.startMs) * finitePositiveNumberOr(layer.playbackRate, 1);
  }

  const boundaries = [...new Set([
    layer.startMs,
    ...playbackKeyframes
      .map((keyframe) => keyframe.atMs)
      .filter((timeMs) => timeMs > layer.startMs && timeMs < endMs),
    endMs
  ])].sort((left, right) => left - right);
  let elapsedMs = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    elapsedMs += integratePlaybackInterval(playbackKeyframes, boundaries[index], boundaries[index + 1]);
  }
  return elapsedMs;
}

function integratePlaybackInterval(keyframes: MotionKeyframe[], startMs: number, endMs: number): number {
  const subdivisions = 16;
  const stepMs = (endMs - startMs) / subdivisions;
  let weightedRate = playbackRateAtMs(keyframes, startMs) + playbackRateAtMs(keyframes, endMs);
  for (let index = 1; index < subdivisions; index += 1) {
    weightedRate += (index % 2 === 0 ? 2 : 4) * playbackRateAtMs(keyframes, startMs + index * stepMs);
  }
  return (stepMs / 3) * weightedRate;
}

function playbackRateAtMs(keyframes: MotionKeyframe[], atMs: number): number {
  return finitePositiveNumberOr(interpolateNumber(keyframes, atMs) ?? undefined, 1);
}

export function resolveChromiumLaunchArgs(env: Record<string, string | undefined> = process.env): string[] {
  const args = ["--disable-gpu"];
  const noSandbox = env.SHELLX_MOTION_CHROMIUM_NO_SANDBOX?.trim().toLowerCase();
  if (noSandbox === "1" || noSandbox === "true" || noSandbox === "yes") {
    args.push("--no-sandbox");
  }
  return args;
}

export function chromiumRuntimeSandboxEvidence(args: readonly string[]) {
  const disabled = args.includes("--no-sandbox");
  return {
    schema: "shellx-motion/runtime-sandbox@1" as const,
    provider: "chromium" as const,
    status: disabled ? "disabled" as const : "requested" as const,
    scope: "browser-process" as const,
    ...(disabled ? { reasonCode: "trusted_host_opt_out" as const } : {}),
  };
}

async function settleGeneratedMotionMedia(page: Page, atMs: number): Promise<void> {
  await page.evaluate(async (timeMs) => {
    const timeoutMs = 5000;
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-shellx-motion-video='true']"));
    await Promise.all(videos.map(async (video) => {
      const startMs = Number(video.dataset.start ?? 0);
      const trimStartMs = Number(video.dataset.trimStartMs ?? 0);
      const trimDurationMs = Number(video.dataset.trimDurationMs ?? 0);
      const playbackRate = Number(video.dataset.playbackRate ?? 1);
      const explicitMediaTimeMs = Number(video.dataset.mediaTimeMs);
      const elapsedMs = Math.max(0, timeMs - startMs);
      const sourceElapsedMs = elapsedMs * (Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1);
      const loopedSourceElapsedMs = video.dataset.loop === "true" && trimDurationMs > 0
        ? sourceElapsedMs % trimDurationMs
        : sourceElapsedMs;
      const targetSeconds = (Number.isFinite(explicitMediaTimeMs) ? explicitMediaTimeMs : trimStartMs + loopedSourceElapsedMs) / 1000;
      video.muted = true;
      video.pause();
      if (video.readyState < 1) {
        const metadataError = `Generated video layer ${video.dataset.layerId ?? "(unknown)"} failed to load metadata before deterministic capture.`;
        video.load();
        await Promise.race([
          new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true })),
          new Promise<void>((_resolve, reject) => video.addEventListener("error", () => reject(new Error(metadataError)), { once: true })),
          new Promise<void>((_resolve, reject) => window.setTimeout(() => reject(new Error(metadataError)), timeoutMs))
        ]);
        if (video.readyState < 1) throw new Error(metadataError);
      }
      try {
        video.currentTime = targetSeconds;
      } catch {
        throw new Error(`Generated video layer ${video.dataset.layerId ?? "(unknown)"} failed to seek before deterministic capture.`);
      }
      if (video.readyState < 2 || video.seeking) {
        const seekError = `Generated video layer ${video.dataset.layerId ?? "(unknown)"} failed to seek before deterministic capture.`;
        await Promise.race([
          new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true })),
          new Promise<void>((resolve) => video.addEventListener("canplay", () => resolve(), { once: true })),
          new Promise<void>((resolve) => video.addEventListener("canplaythrough", () => resolve(), { once: true })),
          new Promise<void>((_resolve, reject) => video.addEventListener("error", () => reject(new Error(seekError)), { once: true })),
          new Promise<void>((_resolve, reject) => window.setTimeout(() => reject(new Error(seekError)), timeoutMs))
        ]);
        if (video.readyState < 2 || video.seeking) throw new Error(seekError);
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, video.videoWidth);
      canvas.height = Math.max(1, video.videoHeight);
      canvas.style.cssText = video.style.cssText;
      canvas.dataset.shellxMotionFrozenVideo = "true";
      canvas.dataset.layerId = video.dataset.layerId ?? "";
      if (video.dataset.motionKeying) canvas.dataset.motionKeying = video.dataset.motionKeying;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error(`Generated video layer ${video.dataset.layerId ?? "(unknown)"} could not create a deterministic frame surface.`);
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      video.replaceWith(canvas);
    }));
  }, atMs);
}

async function settleGeneratedMotionShaders(page: Page): Promise<void> {
  const selector = "canvas[data-motion-shader='true']";
  await page.waitForFunction((shaderSelector) => {
    const shaders = Array.from(document.querySelectorAll<HTMLCanvasElement>(shaderSelector));
    return shaders.every((canvas) => canvas.dataset.motionShaderState === "ready" || canvas.dataset.motionShaderState === "error");
  }, selector, { timeout: 5_000 });
  const failures = await page.evaluate((shaderSelector) => Array.from(document.querySelectorAll<HTMLCanvasElement>(shaderSelector))
    .filter((canvas) => canvas.dataset.motionShaderState === "error")
    .map((canvas) => ({ layerId: canvas.dataset.layerId ?? "(unknown)", error: canvas.dataset.motionShaderError ?? "shader execution failed" })), selector);
  if (failures.length > 0) {
    throw new Error(`Restricted shader render failed: ${failures.map((failure) => `${failure.layerId}: ${failure.error}`).join("; ")}`);
  }
}

async function settleGeneratedMotionScenes3D(page: Page): Promise<void> {
  const selector = "canvas[data-motion-scene3d='true']";
  await page.waitForFunction((sceneSelector) => {
    const scenes = Array.from(document.querySelectorAll<HTMLCanvasElement>(sceneSelector));
    return scenes.every((canvas) => canvas.dataset.motionScene3dState === "ready" || canvas.dataset.motionScene3dState === "error");
  }, selector, { timeout: 5_000 });
  const failures = await page.evaluate((sceneSelector) => Array.from(document.querySelectorAll<HTMLCanvasElement>(sceneSelector))
    .filter((canvas) => canvas.dataset.motionScene3dState === "error")
    .map((canvas) => ({ layerId: canvas.dataset.layerId ?? "(unknown)", error: canvas.dataset.motionScene3dError ?? "scene3d execution failed" })), selector);
  if (failures.length > 0) {
    throw new Error(`Fixed scene3d render failed: ${failures.map((failure) => `${failure.layerId}: ${failure.error}`).join("; ")}`);
  }
}

async function settleGeneratedMotionEnvironments(page: Page): Promise<void> {
  const selector = "canvas[data-motion-environment]";
  await page.waitForFunction((environmentSelector) => {
    const environments = Array.from(document.querySelectorAll<HTMLCanvasElement>(environmentSelector));
    return environments.every((canvas) => canvas.dataset.motionEnvironmentState === "ready" || canvas.dataset.motionEnvironmentState === "error");
  }, selector, { timeout: 5_000 });
  const failures = await page.evaluate((environmentSelector) => Array.from(document.querySelectorAll<HTMLCanvasElement>(environmentSelector))
    .filter((canvas) => canvas.dataset.motionEnvironmentState === "error")
    .map((canvas) => ({ layerId: canvas.dataset.layerId ?? "(unknown)", error: canvas.dataset.motionEnvironmentError ?? "environment execution failed" })), selector);
  if (failures.length > 0) {
    throw new Error(`Fixed environment render failed: ${failures.map((failure) => `${failure.layerId}: ${failure.error}`).join("; ")}`);
  }
}

async function freezeGeneratedMotionWebGLSurfaces(page: Page): Promise<BrowserWebGLResourceEvidence | undefined> {
  const evidence = await page.evaluate(() => {
    const surfaces = Array.from(document.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-motion-shader='true'],canvas[data-motion-scene3d='true'],canvas[data-motion-environment]"
    ));
    let frozenSurfaceCount = 0;
    let contextReleaseRequestedCount = 0;
    const layerIds: string[] = [];
    for (const surface of surfaces) {
      const snapshot = document.createElement("canvas");
      for (const attribute of Array.from(surface.attributes)) {
        snapshot.setAttribute(attribute.name, attribute.value);
      }
      snapshot.width = surface.width;
      snapshot.height = surface.height;
      const context = snapshot.getContext("2d", { alpha: true });
      if (!context) throw new Error(`WebGL layer ${surface.dataset.layerId ?? "(unknown)"} could not allocate a release snapshot.`);
      context.drawImage(surface, 0, 0, surface.width, surface.height);
      const gl = surface.getContext("webgl");
      const release = gl?.getExtension("WEBGL_lose_context") ?? null;
      if (release) {
        release.loseContext();
        contextReleaseRequestedCount += 1;
      }
      snapshot.dataset.motionWebglFrozen = "true";
      snapshot.dataset.motionWebglContextReleaseRequested = release ? "true" : "false";
      const layerId = surface.dataset.layerId ?? "(unknown)";
      layerIds.push(layerId);
      surface.replaceWith(snapshot);
      frozenSurfaceCount += 1;
    }
    return {
      policy: "snapshot-then-explicit-context-release" as const,
      surfaceCount: surfaces.length,
      frozenSurfaceCount,
      contextReleaseRequestedCount,
      layerIds: [...new Set(layerIds)].sort()
    };
  });
  return evidence.surfaceCount > 0 ? evidence : undefined;
}

function assetForLayer(pkg: MotionPackage, layer: MotionLayer, label: "Image" | "Video"): Record<string, unknown> {
  const directRef = readString(layer.assetRef) ?? readString(layer.source) ?? readString(layer.src);
  if (directRef) {
    const directAsset = findMotionAssetRecord(pkg, directRef);
    if (directAsset) return directAsset;
    return { source: { path: directRef, mimeType: mimeTypeForAsset(directRef) } };
  }

  const assetId = readString(layer.assetId);
  const asset = assetId ? findMotionAssetRecord(pkg, assetId) : null;
  if (!asset) {
    throw new Error(`${label} layer ${layer.id} references an unknown Motion asset: ${assetId ?? "(missing)"}`);
  }
  return asset;
}

function findMotionAssetRecord(pkg: MotionPackage, ref: string): Record<string, unknown> | null {
  for (const asset of pkg.motion.assets) {
    const record = readRecord(asset);
    const source = readRecord(record.source);
    if (record.id === ref || readString(source.path) === ref) return record;
  }
  return null;
}

function boxStyle(
  layer: MotionLayer,
  index: number,
  defaults: { defaultWidth: number | null; defaultHeight: number | null } | undefined = { defaultWidth: 100, defaultHeight: 100 },
  atMs?: number
): string {
  const metrics = layerBoxMetrics(layer, defaults);
  const transform = metrics.transform;
  const x = metrics.x;
  const y = metrics.y;
  const width = metrics.width;
  const height = metrics.height;
  const opacity = clamp(readNumber(transform.opacity) ?? readNumber(layer.opacity) ?? 1, 0, 1);
  const rotation = readNumber(transform.rotation) ?? 0;
  const scale = readNumber(transform.scale) ?? 1;
  const transformOrigin = cssTransformOrigin(transform);
  const rules = [
    "position:absolute",
    `left:${x}px`,
    `top:${y}px`,
    `opacity:${opacity}`,
    `z-index:${index}`,
    `transform-origin:${transformOrigin}`,
    `transform:rotate(${rotation}deg) scale(${scale})`,
    "overflow:hidden"
  ];
  if (width !== null) rules.push(`width:${width}px`);
  if (height !== null) rules.push(`height:${height}px`);
  const blendModeStyle = cssBlendModeStyle(layer);
  if (blendModeStyle) rules.push(blendModeStyle);
  const clipPathStyle = cssClipPathStyle(layer, index, atMs);
  if (clipPathStyle) rules.push(clipPathStyle);
  const matteStyle = cssMatteStyle(layer, index);
  if (matteStyle) rules.push(matteStyle);
  const effectsStyle = cssEffectsStyle(layer);
  if (effectsStyle) rules.push(effectsStyle);
  return rules.join(";") + ";";
}

function layerBoxMetrics(
  layer: MotionLayer,
  defaults: { defaultWidth: number | null; defaultHeight: number | null } | undefined = { defaultWidth: 100, defaultHeight: 100 }
): { transform: Record<string, unknown>; x: number; y: number; width: number | null; height: number | null } {
  const transform = readRecord(layer.transform);
  const style = readRecord(layer.style);
  const resolvedDefaults = defaults ?? { defaultWidth: 100, defaultHeight: 100 };
  return {
    transform,
    x: readNumber(transform.x) ?? 0,
    y: readNumber(transform.y) ?? 0,
    width: readNumber(transform.width) ?? readNumber(layer.width) ?? readNumber(style.width) ?? resolvedDefaults.defaultWidth,
    height: readNumber(transform.height) ?? readNumber(layer.height) ?? readNumber(style.height) ?? resolvedDefaults.defaultHeight
  };
}

function layerBoxSize(layer: MotionLayer, defaults: { defaultWidth: number; defaultHeight: number }): { width: number; height: number } {
  const metrics = layerBoxMetrics(layer, defaults);
  return {
    width: metrics.width ?? defaults.defaultWidth,
    height: metrics.height ?? defaults.defaultHeight
  };
}

type BrowserObjectFit = "fill" | "contain" | "cover" | "none" | "scale-down";
type BrowserImageFit = "fill" | "contain" | "cover" | "none" | "scale-down";

function browserObjectFit(layer: MotionLayer): BrowserObjectFit {
  const style = readRecord(layer.style);
  const fit = (readString(layer.fit) ?? readString(style.objectFit) ?? readString(style.fit) ?? "cover").trim().toLowerCase();
  if (fit === "fill" || fit === "contain" || fit === "cover" || fit === "none" || fit === "scale-down") return fit;
  return "cover";
}

function browserImageFit(layer: MotionLayer): BrowserImageFit {
  const fit = browserObjectFit(layer);
  if (fit === "fill" || fit === "contain" || fit === "cover" || fit === "none" || fit === "scale-down") return fit;
  return "contain";
}

function imagePlacementForBox(
  box: { x: number; y: number; width: number; height: number },
  sourceRect: { width: number; height: number },
  fit: BrowserImageFit
): { x: number; y: number; width: number; height: number } {
  if (fit === "fill") return box;
  if (fit === "none") {
    return centerNaturalImagePlacement(box, sourceRect);
  }
  if (fit === "scale-down") {
    if (sourceRect.width <= box.width && sourceRect.height <= box.height) {
      return centerNaturalImagePlacement(box, sourceRect);
    }
    return scaledImagePlacement(box, sourceRect, "contain");
  }
  return scaledImagePlacement(box, sourceRect, fit);
}

function scaledImagePlacement(
  box: { x: number; y: number; width: number; height: number },
  sourceRect: { width: number; height: number },
  fit: "contain" | "cover"
): { x: number; y: number; width: number; height: number } {
  const scale = fit === "contain"
    ? Math.min(box.width / sourceRect.width, box.height / sourceRect.height)
    : Math.max(box.width / sourceRect.width, box.height / sourceRect.height);
  const width = sourceRect.width * scale;
  const height = sourceRect.height * scale;
  return {
    x: box.x + ((box.width - width) / 2),
    y: box.y + ((box.height - height) / 2),
    width,
    height
  };
}

function centerNaturalImagePlacement(
  box: { x: number; y: number; width: number; height: number },
  sourceRect: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  return {
    x: box.x + ((box.width - sourceRect.width) / 2),
    y: box.y + ((box.height - sourceRect.height) / 2),
    width: sourceRect.width,
    height: sourceRect.height
  };
}

function readMediaCrop(value: unknown): { x: number; y: number; width: number; height: number } | null {
  const crop = readRecord(value);
  const x = readNumber(crop.x);
  const y = readNumber(crop.y);
  const width = readNumber(crop.width);
  const height = readNumber(crop.height);
  if (x === null || y === null || width === null || height === null || x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function mediaSourceSize(
  asset: Record<string, unknown>,
  crop: { x: number; y: number; width: number; height: number }
): { width: number; height: number } {
  const size = readRecord(asset.size);
  const width = readNumber(size.width);
  const height = readNumber(size.height);
  return {
    width: width !== null && width > 0 ? width : crop.x + crop.width,
    height: height !== null && height > 0 ? height : crop.y + crop.height
  };
}

function cssTransformOrigin(transform: Record<string, unknown>): string {
  const originX = readNumber(transform.originX);
  const originY = readNumber(transform.originY);
  return `${originX === null ? "center" : `${originX}px`} ${originY === null ? "center" : `${originY}px`}`;
}

function cameraCompositionStyle(camera: MotionLayer): string {
  const transform = readRecord(camera.transform);
  const x = readNumber(transform.x) ?? 0;
  const y = readNumber(transform.y) ?? 0;
  const scale = clamp(readNumber(transform.scale) ?? 1, 0.001, 100);
  const rotation = readNumber(transform.rotation) ?? 0;
  return [
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    `transform-origin:${cssTransformOrigin(transform)}`,
    `transform:translate(${formatSvgTransformNumber(-x)}px,${formatSvgTransformNumber(-y)}px) scale(${formatSvgTransformNumber(scale)}) rotate(${formatSvgTransformNumber(-rotation)}deg)`
  ].join(";") + ";";
}

function cameraDepthPlaneStyle(camera: MotionLayer, layer: MotionLayer, index: number): string {
  const transform = readRecord(camera.transform);
  const factor = 1 + clamp(readNumber(layer.depth) ?? 0, -0.9, 3);
  const x = -(readNumber(transform.x) ?? 0) * factor;
  const y = -(readNumber(transform.y) ?? 0) * factor;
  const cameraScale = clamp(readNumber(transform.scale) ?? 1, 0.001, 100);
  const scale = clamp(cameraScale ** factor, 0.001, 100);
  const rotation = -(readNumber(transform.rotation) ?? 0) * factor;
  return [
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    `z-index:${index}`,
    `transform-origin:${cssTransformOrigin(transform)}`,
    `transform:translate(${formatSvgTransformNumber(x)}px,${formatSvgTransformNumber(y)}px) scale(${formatSvgTransformNumber(scale)}) rotate(${formatSvgTransformNumber(rotation)}deg)`
  ].join(";") + ";";
}

function cssBorderRadius(style: Record<string, unknown>, pkg: MotionPackage): string {
  return cssLength(resolveToken(style.borderRadius ?? style.radius ?? 0, pkg), "0px");
}

function cssBlendModeStyle(layer: MotionLayer): string | null {
  const blendMode = readString(layer.blendMode);
  if (!blendMode || blendMode === "normal") return null;
  return CSS_BLEND_MODES.has(blendMode) ? `mix-blend-mode:${blendMode}` : null;
}

function cssClipPathStyle(layer: MotionLayer, index: number, atMs?: number): string | null {
  const mask = readRecord(layer.mask);
  const type = readString(mask.type);
  const vectorMask = cssVectorMaskStyle(layer, index);
  if (vectorMask) return vectorMask;
  const hasMask = type === "rect" || type === "rounded-rect";
  const inset = readRecord(mask.inset);
  const maskInsets = hasMask
    ? {
        top: readNumber(inset.top) ?? 0,
        right: readNumber(inset.right) ?? 0,
        bottom: readNumber(inset.bottom) ?? 0,
        left: readNumber(inset.left) ?? 0
      }
    : { top: 0, right: 0, bottom: 0, left: 0 };
  const wipeInsets = typeof atMs === "number"
    ? transitionWipeInsets(layer, atMs)
    : { top: 0, right: 0, bottom: 0, left: 0 };
  const hasWipe = wipeInsets.top > 0 || wipeInsets.right > 0 || wipeInsets.bottom > 0 || wipeInsets.left > 0;
  if (!hasMask && !hasWipe) return null;

  const top = combineClipInset(maskInsets.top, wipeInsets.top);
  const right = combineClipInset(maskInsets.right, wipeInsets.right);
  const bottom = combineClipInset(maskInsets.bottom, wipeInsets.bottom);
  const left = combineClipInset(maskInsets.left, wipeInsets.left);
  const radius = hasMask ? readNumber(mask.radius) ?? 0 : 0;
  const round = radius > 0 || type === "rounded-rect" ? ` round ${radius}px` : "";
  return `clip-path:inset(${top} ${right} ${bottom} ${left}${round})`;
}

function formatSvgTransformNumber(value: number): string {
  return Number(value.toFixed(9)).toString();
}

function cssMatteStyle(layer: MotionLayer, index: number): string | null {
  const matte = readRecord(layer.matte);
  const type = readString(matte.type);
  if (type !== "alpha" && type !== "alpha-inverted" && type !== "luma" && type !== "luma-inverted") return null;
  const ref = `url(#${matteMaskId(index)})`;
  return `-webkit-mask:${ref};-webkit-mask-repeat:no-repeat;mask:${ref};mask-repeat:no-repeat`;
}

function generatedMatteDefinition(pkg: MotionPackage, consumer: MotionLayer, index: number, atMs: number): string {
  const matte = readRecord(consumer.matte);
  const type = readString(matte.type);
  const sourceLayerId = readString(matte.sourceLayerId);
  if ((type !== "alpha" && type !== "alpha-inverted" && type !== "luma" && type !== "luma-inverted") || !sourceLayerId) return "";
  const source = pkg.motion.layers.find((layer) => layer.id === sourceLayerId);
  if (!source) throw new Error(`Browser matte consumer ${consumer.id} references missing source ${sourceLayerId}.`);
  const consumerBox = layerBoxMetrics(consumer);
  const consumerWidth = consumerBox.width ?? 100;
  const consumerHeight = consumerBox.height ?? 100;
  const inverted = type === "alpha-inverted" || type === "luma-inverted";
  const luma = type === "luma" || type === "luma-inverted";
  const background = `<rect x="0" y="0" width="${formatSvgTransformNumber(consumerWidth)}" height="${formatSvgTransformNumber(consumerHeight)}" fill="${inverted ? "white" : "black"}"></rect>`;
  if (!isLayerActive(source, atMs)) {
    return `<mask id="${matteMaskId(index)}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${formatSvgTransformNumber(consumerWidth)}" height="${formatSvgTransformNumber(consumerHeight)}" style="mask-type:luminance">${background}</mask>`;
  }
  const effectiveSource = effectiveProceduralLayerAtMs(pkg.motion, source.id, atMs);
  const sourceBox = layerBoxMetrics(effectiveSource);
  const sourceWidth = sourceBox.width ?? 100;
  const sourceHeight = sourceBox.height ?? 100;
  const geometry = generatedMatteShapeGeometry(effectiveSource);
  const scaleX = sourceWidth / geometry.viewBox.width;
  const scaleY = sourceHeight / geometry.viewBox.height;
  const offsetX = sourceBox.x - consumerBox.x - (geometry.viewBox.x * scaleX);
  const offsetY = sourceBox.y - consumerBox.y - (geometry.viewBox.y * scaleY);
  const matrix = [scaleX, 0, 0, scaleY, offsetX, offsetY].map(formatSvgTransformNumber).join(" ");
  const sourceFill = readString(readRecord(effectiveSource.style).fill) ?? "#ffffff";
  const filter = type === "luma-inverted"
    ? `<filter id="${matteFilterId(index)}" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="-1" intercept="1"></feFuncR><feFuncG type="linear" slope="-1" intercept="1"></feFuncG><feFuncB type="linear" slope="-1" intercept="1"></feFuncB></feComponentTransfer></filter>`
    : "";
  const filterAttr = type === "luma-inverted" ? ` filter="url(#${matteFilterId(index)})"` : "";
  const fill = luma ? sourceFill : inverted ? "black" : "white";
  const shape = `<g transform="matrix(${matrix})"${filterAttr}>${geometry.element.replace("MATTE_FILL", fill)}</g>`;
  return `${filter}<mask id="${matteMaskId(index)}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${formatSvgTransformNumber(consumerWidth)}" height="${formatSvgTransformNumber(consumerHeight)}" style="mask-type:luminance">${background}${shape}</mask>`;
}

function generatedMatteShapeGeometry(layer: MotionLayer): { viewBox: { x: number; y: number; width: number; height: number }; element: string } {
  const shapeKind = generatedShapeKind(layer);
  const unitViewBox = { x: 0, y: 0, width: 100, height: 100 };
  if (shapeKind === "rect") return { viewBox: unitViewBox, element: "<rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" fill=\"MATTE_FILL\"></rect>" };
  if (shapeKind === "ellipse") return { viewBox: unitViewBox, element: "<ellipse cx=\"50\" cy=\"50\" rx=\"50\" ry=\"50\" fill=\"MATTE_FILL\"></ellipse>" };
  if (shapeKind === "triangle") return { viewBox: unitViewBox, element: "<polygon points=\"50,0 0,100 100,100\" fill=\"MATTE_FILL\"></polygon>" };
  if (shapeKind === "star") return { viewBox: unitViewBox, element: `<polygon points="${escapeAttr(generatedStarPoints())}" fill="MATTE_FILL"></polygon>` };
  if (shapeKind === "path") {
    const path = validateMotionPathData(generatedShapePath(layer), `Browser matte source ${layer.id}`);
    const viewBox = parseMotionPathViewBox(generatedShapeViewBox(layer), `Browser matte source ${layer.id} viewBox`);
    return { viewBox, element: `<path d="${escapeAttr(path)}" fill="MATTE_FILL"></path>` };
  }
  throw new Error(`Browser matte source ${layer.id} uses unsupported shape ${shapeKind ?? "missing"}.`);
}

function matteMaskId(index: number): string {
  return `shellx-motion-matte-${index}`;
}

function matteFilterId(index: number): string {
  return `shellx-motion-matte-filter-${index}`;
}

function combineClipInset(maskPixels: number, wipePercent: number): string {
  if (maskPixels > 0 && wipePercent > 0) return `max(${maskPixels}px,${formatPercent(wipePercent)})`;
  if (wipePercent > 0) return formatPercent(wipePercent);
  return `${maskPixels}px`;
}

function transitionWipeInsets(layer: MotionLayer, atMs: number): { top: number; right: number; bottom: number; left: number } {
  const localMs = atMs - layer.startMs;
  const remainingMs = Math.max(0, layer.durationMs) - localMs;
  const inInsets = wipeTransitionInsets(layer.transitions?.in, localMs, "in");
  const outInsets = wipeTransitionInsets(layer.transitions?.out, remainingMs, "out");
  return {
    top: Math.max(inInsets.top, outInsets.top),
    right: Math.max(inInsets.right, outInsets.right),
    bottom: Math.max(inInsets.bottom, outInsets.bottom),
    left: Math.max(inInsets.left, outInsets.left)
  };
}

function wipeTransitionInsets(
  transition: MotionTransition | undefined,
  elapsedMs: number,
  edge: "in" | "out"
): { top: number; right: number; bottom: number; left: number } {
  if (!transition || transition.type !== "wipe" || transition.durationMs <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const hiddenPercent = edge === "in"
    ? wipeInHiddenPercent(transition, elapsedMs)
    : wipeOutHiddenPercent(transition, elapsedMs);
  const direction = transition.direction ?? "left";
  if (edge === "in") {
    if (direction === "right") return { top: 0, right: 0, bottom: 0, left: hiddenPercent };
    if (direction === "up") return { top: 0, right: 0, bottom: hiddenPercent, left: 0 };
    if (direction === "down") return { top: hiddenPercent, right: 0, bottom: 0, left: 0 };
    return { top: 0, right: hiddenPercent, bottom: 0, left: 0 };
  }
  if (direction === "right") return { top: 0, right: hiddenPercent, bottom: 0, left: 0 };
  if (direction === "up") return { top: hiddenPercent, right: 0, bottom: 0, left: 0 };
  if (direction === "down") return { top: 0, right: 0, bottom: hiddenPercent, left: 0 };
  return { top: 0, right: 0, bottom: 0, left: hiddenPercent };
}

function wipeInHiddenPercent(transition: MotionTransition, elapsedMs: number): number {
  if (elapsedMs >= transition.durationMs) return 0;
  if (elapsedMs <= 0) return 100;
  return 100 * (1 - resolveEasing(transition.easing)(clamp(elapsedMs / transition.durationMs, 0, 1)));
}

function wipeOutHiddenPercent(transition: MotionTransition, remainingMs: number): number {
  if (remainingMs >= transition.durationMs) return 0;
  if (remainingMs <= 0) return 100;
  return 100 * resolveEasing(transition.easing)(clamp(1 - (remainingMs / transition.durationMs), 0, 1));
}

function formatPercent(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

function cssEffectsStyle(layer: MotionLayer): string | null {
  const effects = readRecord(layer.effects);
  const filters: string[] = [];
  const blur = readNumber(effects.blur);
  const brightness = readNumber(effects.brightness);
  const contrast = readNumber(effects.contrast);
  const saturate = readNumber(effects.saturate);
  const grayscale = readNumber(effects.grayscale);
  const glow = readRecord(effects.glow);
  if (blur !== null) filters.push(`blur(${blur}px)`);
  if (brightness !== null) filters.push(`brightness(${brightness})`);
  if (contrast !== null) filters.push(`contrast(${contrast})`);
  if (saturate !== null) filters.push(`saturate(${saturate})`);
  if (grayscale !== null) filters.push(`grayscale(${grayscale})`);
  const glowRadius = readNumber(glow.radius);
  const glowColor = readString(glow.color);
  if (glowRadius !== null && glowRadius >= 0 && glowRadius <= 128 && glowColor && isSupportedMotionColorString(glowColor)) {
    filters.push(`drop-shadow(0 0 ${formatSvgTransformNumber(glowRadius)}px ${glowColor})`);
  }
  return filters.length > 0 ? `filter:${filters.join(" ")}` : null;
}

function textStyle(style: Record<string, unknown>, pkg: MotionPackage): string {
  const fontFamily = cssFontFamily(resolveToken(readString(style.fontFamily) ?? "Inter, Arial, sans-serif", pkg));
  const fontSize = cssLength(resolveToken(readString(style.fontSize) ?? style.fontSize ?? 32, pkg), "32px");
  const fontWeight = cssFontWeight(resolveToken(readString(style.fontWeight) ?? style.fontWeight ?? 500, pkg));
  const letterSpacing = cssLength(resolveToken(style.letterSpacing ?? 0, pkg), "0px");
  const lineHeight = cssLineHeight(resolveToken(readString(style.lineHeight) ?? style.lineHeight ?? 1.15, pkg));
  const color = cssColor(readString(style.color) ?? "#111827", pkg, "#111827");
  const textAlign = cssTextAlign(style.textAlign);
  const unicodeBidi = cssUnicodeBidi(style.unicodeBidi ?? (style.direction ? "plaintext" : undefined));
  const background = cssTextBackground(style, pkg);
  const padding = cssTextPadding(style, pkg);
  const border = cssTextBorder(style, pkg);
  const radius = cssLength(resolveToken(style.borderRadius ?? style.radius ?? 0, pkg), "0px");
  const shadow = cssTextShadowStyle(style, pkg);
  return `font-family:${fontFamily};font-size:${fontSize};font-weight:${fontWeight};letter-spacing:${letterSpacing};line-height:${lineHeight};color:${color};text-align:${textAlign};unicode-bidi:${unicodeBidi};background-color:${background};padding:${padding};border:${border};border-radius:${radius};box-sizing:border-box;${shadow ? `${shadow};` : ""}`;
}

function cssTextAlign(value: unknown): string {
  const align = readString(value)?.trim().toLowerCase();
  return align === "center" || align === "right" || align === "start" || align === "end" ? align : "left";
}

function cssUnicodeBidi(value: unknown): string {
  const bidi = readString(value)?.trim().toLowerCase();
  return bidi === "isolate" || bidi === "plaintext" ? bidi : "normal";
}

function htmlTextDirection(value: unknown, text: string): "auto" | "ltr" | "rtl" | null {
  const direction = readString(value)?.trim().toLowerCase();
  if (direction === "auto" || direction === "ltr" || direction === "rtl") return direction;
  return containsRtlText(text) ? "auto" : null;
}

function htmlTextLanguage(value: unknown): string | null {
  const lang = readString(value)?.trim();
  return lang && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
}

function containsRtlText(text: string): boolean {
  return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u.test(text);
}

async function collectBrowserTypographyEvidence(page: Page): Promise<BrowserTypographyEvidence> {
  const layers = await page.evaluate(() => {
    const genericFamilies = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
    return [...document.querySelectorAll<HTMLElement>("[data-motion-text='true']")].map((element) => {
      const computed = getComputedStyle(element);
      const requestedFontFamily = element.dataset.requestedFontFamily?.trim() || null;
      const primaryFont = requestedFontFamily
        ?.split(",", 1)[0]
        ?.trim()
        .replace(/^['"]|['"]$/g, "") || null;
      let primaryFontAvailable: boolean | null = null;
      if (primaryFont) {
        try {
          if (genericFamilies.has(primaryFont.toLowerCase())) {
            primaryFontAvailable = true;
          } else {
            const context = document.createElement("canvas").getContext("2d");
            const sample = "mmmmmmmmmmlliWW 0123456789 مرحبا 漢字";
            const safeFont = primaryFont.replace(/["\\\n\r]/g, "");
            primaryFontAvailable = Boolean(context && safeFont && ["monospace", "sans-serif", "serif"].some((fallback) => {
              context.font = `72px ${fallback}`;
              const baseline = context.measureText(sample).width;
              context.font = `72px "${safeFont}", ${fallback}`;
              return Math.abs(context.measureText(sample).width - baseline) > 0.01;
            }));
          }
        } catch {
          primaryFontAvailable = false;
        }
      }
      return {
        layerId: element.dataset.layerId ?? "",
        direction: computed.direction === "rtl" ? "rtl" as const : "ltr" as const,
        lang: element.getAttribute("lang"),
        requestedFontFamily,
        resolvedFontFamily: computed.fontFamily,
        primaryFontAvailable
      };
    });
  });
  const seenLayerIds = new Set<string>();
  const uniqueLayers = layers.filter((layer) => {
    if (!layer.layerId) return true;
    if (seenLayerIds.has(layer.layerId)) return false;
    seenLayerIds.add(layer.layerId);
    return true;
  });
  return {
    fontProbe: "canvas-metric",
    layers: uniqueLayers,
    fallbackLayerIds: uniqueLayers
      .filter((layer) => layer.primaryFontAvailable === false)
      .map((layer) => layer.layerId)
  };
}

async function collectBrowserTextFitEvidence(
  page: Page,
  pkg: MotionPackage,
  atMs: number
): Promise<BrowserTextFitEvidence> {
  const safeAreas = Object.fromEntries(Object.entries(pkg.motion.safeAreas ?? {}).map(([id, area]) => [id, {
    top: typeof area.top === "number" ? area.top : 0,
    right: typeof area.right === "number" ? area.right : 0,
    bottom: typeof area.bottom === "number" ? area.bottom : 0,
    left: typeof area.left === "number" ? area.left : 0
  }]));
  // tsx/esbuild keepNames can reference this helper after Playwright serializes a
  // complex callback. Production bundles inline it, while source-driven CLI runs do not.
  await page.evaluate("globalThis.__name = function(target) { return target; }");
  const evidence = await page.evaluate(({ safeAreas, atMs }) => {
    type FitPolicy = "safe" | "allow-crop" | "auto-fit";
    type Overflow = { top: number; right: number; bottom: number; left: number };
    const round = (value: number) => Math.max(0, Number(value.toFixed(3)));
    const root = document.querySelector<HTMLElement>("main") ?? document.body;
    const rootRect = root.getBoundingClientRect();
    const elements = [...document.querySelectorAll<HTMLElement>("[data-motion-text='true']")];
    const uncheckedLayerIds = [...new Set(elements
      .filter((element) => element.dataset.textFitPolicy === "unchecked" || !element.dataset.textFitPolicy)
      .map((element) => element.dataset.layerId ?? "<unknown>"))].sort();
    const groups = new Map<string, HTMLElement[]>();
    for (const element of elements) {
      const policy = element.dataset.textFitPolicy;
      if (policy !== "safe" && policy !== "allow-crop" && policy !== "auto-fit") continue;
      const layerId = element.dataset.layerId ?? "<unknown>";
      const group = groups.get(layerId) ?? [];
      group.push(element);
      groups.set(layerId, group);
    }
    const ownVisible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") >= 0.5
        && element.getClientRects().length > 0;
    };
    const glyphRect = (element: HTMLElement): DOMRect => {
      const target = element.querySelector("span") ?? element;
      const range = document.createRange();
      range.selectNodeContents(target);
      const measured = range.getBoundingClientRect();
      return measured.width > 0 || measured.height > 0 ? measured : target.getBoundingClientRect();
    };
    const safeRect = (safeAreaId: string | null): { top: number; right: number; bottom: number; left: number } => {
      const area = safeAreaId ? safeAreas[safeAreaId] : undefined;
      return {
        top: rootRect.top + (area?.top ?? 0),
        right: rootRect.right - (area?.right ?? 0),
        bottom: rootRect.bottom - (area?.bottom ?? 0),
        left: rootRect.left + (area?.left ?? 0)
      };
    };
    const measureElement = (element: HTMLElement, area: ReturnType<typeof safeRect>) => {
      const rect = glyphRect(element);
      return {
        internalHorizontal: round(element.scrollWidth - element.clientWidth),
        internalVertical: round(element.scrollHeight - element.clientHeight),
        safe: {
          top: round(area.top - rect.top),
          right: round(rect.right - area.right),
          bottom: round(rect.bottom - area.bottom),
          left: round(area.left - rect.left)
        } satisfies Overflow
      };
    };
    const maxOverflow = (measurements: ReturnType<typeof measureElement>[]) => measurements.reduce((max, current) => ({
      internalHorizontal: Math.max(max.internalHorizontal, current.internalHorizontal),
      internalVertical: Math.max(max.internalVertical, current.internalVertical),
      safe: {
        top: Math.max(max.safe.top, current.safe.top),
        right: Math.max(max.safe.right, current.safe.right),
        bottom: Math.max(max.safe.bottom, current.safe.bottom),
        left: Math.max(max.safe.left, current.safe.left)
      }
    }), { internalHorizontal: 0, internalVertical: 0, safe: { top: 0, right: 0, bottom: 0, left: 0 } });
    const fits = (measurement: ReturnType<typeof maxOverflow>): boolean => measurement.internalHorizontal <= 0.5
      && measurement.internalVertical <= 0.5
      && measurement.safe.top <= 0.5
      && measurement.safe.right <= 0.5
      && measurement.safe.bottom <= 0.5
      && measurement.safe.left <= 0.5;
    // Code-unit order, not localeCompare: text-fit diagnostics are reported per layer and land in
    // receipt evidence, so their order must not follow whatever locale the browser process
    // inherited. The comparison is written out rather than calling `compareCodeUnits`: this
    // callback is serialized and executed INSIDE the page, where nothing from the Node module
    // scope exists — importing the shared helper here throws `compareCodeUnits is not defined`
    // at runtime, which no typecheck catches.
    const layers = [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([layerId, samples]) => {
      const first = samples[0];
      const policy = first.dataset.textFitPolicy as FitPolicy;
      const safeAreaId = first.dataset.textFitSafeArea || null;
      const area = safeRect(safeAreaId);
      const visibleSamples = samples.filter(ownVisible);
      const requestedFontSizes = new Map(samples.map((element) => [
        element,
        Number.parseFloat(getComputedStyle(element).fontSize) || 0
      ]));
      const requestedFontSize = Math.max(0, ...requestedFontSizes.values());
      const parsedMinFontSize = Number.parseFloat(first.dataset.textFitMinFontSize ?? "");
      const minFontSize = policy === "auto-fit" ? (Number.isFinite(parsedMinFontSize) ? parsedMinFontSize : 12) : null;
      let appliedFontSize = requestedFontSize;
      let measured = maxOverflow(visibleSamples.map((element) => measureElement(element, area)));
      if (policy === "auto-fit" && visibleSamples.length > 0 && !fits(measured)) {
        let shrinkBy = 0;
        while ([...requestedFontSizes.values()].some((size) => (
          size - shrinkBy > Math.min(size, minFontSize ?? 12)
        ))) {
          shrinkBy += 1;
          for (const element of samples) {
            const requested = requestedFontSizes.get(element) ?? requestedFontSize;
            element.style.fontSize = `${Math.max(Math.min(requested, minFontSize ?? 12), requested - shrinkBy)}px`;
          }
          appliedFontSize = Math.max(0, ...samples.map((element) => Number.parseFloat(getComputedStyle(element).fontSize) || 0));
          measured = maxOverflow(visibleSamples.map((element) => measureElement(element, area)));
          if (fits(measured)) break;
        }
      }
      const didFit = visibleSamples.length === 0 || policy === "allow-crop" || fits(measured);
      const autoFitted = policy === "auto-fit" && appliedFontSize < requestedFontSize && didFit;
      return {
        layerId,
        policy,
        safeAreaId,
        status: policy === "allow-crop"
          ? "allowed-crop" as const
          : didFit
            ? autoFitted ? "auto-fitted" as const : "passed" as const
            : "failed" as const,
        requestedFontSize: round(requestedFontSize),
        appliedFontSize: round(appliedFontSize),
        minFontSize: minFontSize === null ? null : round(minFontSize),
        sampleCount: samples.length,
        visibleSampleCount: visibleSamples.length,
        internalOverflowPx: {
          horizontal: measured.internalHorizontal,
          vertical: measured.internalVertical
        },
        safeAreaOverflowPx: measured.safe
      };
    });
    return {
      policy: "rendered-glyph-bounds" as const,
      atMs,
      visibilityThreshold: 0.5 as const,
      checkedLayerCount: layers.length,
      uncheckedLayerIds,
      allowedCropLayerIds: layers.filter((layer) => layer.status === "allowed-crop").map((layer) => layer.layerId),
      autoFittedLayerIds: layers.filter((layer) => layer.status === "auto-fitted").map((layer) => layer.layerId),
      failedLayerIds: layers.filter((layer) => layer.status === "failed").map((layer) => layer.layerId),
      layers
    };
  }, { safeAreas, atMs });
  return evidence;
}

function enforceTextFitPolicy(evidence: BrowserTextFitEvidence): void {
  if (evidence.failedLayerIds.length > 0) throw new BrowserTextFitPolicyError(evidence);
}

function fontFallbackWarnings(typography: BrowserTypographyEvidence): string[] {
  return typography.fallbackLayerIds.map((layerId) => (
    `Browser renderer used a font fallback for text layer ${layerId || "<unknown>"}.`
  ));
}

function enforceFontFallbackPolicy(pkg: MotionPackage, typography: BrowserTypographyEvidence): void {
  const maxFontFallbacks = pkg.manifest.quality?.maxFontFallbacks;
  if (maxFontFallbacks !== undefined && typography.fallbackLayerIds.length > maxFontFallbacks) {
    throw new BrowserFontFallbackPolicyError(typography.fallbackLayerIds, maxFontFallbacks);
  }
}

function cssTextVerticalAlign(value: unknown): string {
  const align = readString(value)?.trim().toLowerCase();
  if (align === "bottom") return "flex-end";
  if (align === "middle" || align === "center") return "center";
  return "flex-start";
}

function cssTextBackground(style: Record<string, unknown>, pkg: MotionPackage): string {
  return cssColor(readString(style.backgroundColor) ?? readString(style.background) ?? "transparent", pkg, "transparent");
}

function cssTextPadding(style: Record<string, unknown>, pkg: MotionPackage): string {
  const all = cssLength(resolveToken(style.padding ?? 0, pkg), "0px");
  const horizontal = cssLength(resolveToken(style.paddingX ?? all, pkg), all);
  const vertical = cssLength(resolveToken(style.paddingY ?? all, pkg), all);
  const top = cssLength(resolveToken(style.paddingTop ?? vertical, pkg), vertical);
  const right = cssLength(resolveToken(style.paddingRight ?? horizontal, pkg), horizontal);
  const bottom = cssLength(resolveToken(style.paddingBottom ?? vertical, pkg), vertical);
  const left = cssLength(resolveToken(style.paddingLeft ?? horizontal, pkg), horizontal);
  return `${top} ${right} ${bottom} ${left}`;
}

function cssTextBorder(style: Record<string, unknown>, pkg: MotionPackage): string {
  const color = cssColor(readString(style.borderColor) ?? readString(style.stroke) ?? "transparent", pkg, "transparent");
  const widthFallback = readString(style.borderColor) || readString(style.stroke) ? style.width ?? 0 : 0;
  const width = cssLength(resolveToken(style.borderWidth ?? style.strokeWidth ?? widthFallback, pkg), "0px");
  return `${width} solid ${color}`;
}

function cssBoxShadowStyle(style: Record<string, unknown>, pkg: MotionPackage): string | null {
  const shadow = cssShadowValue(style.boxShadow ?? style.shadow, pkg, { includeSpread: true });
  return shadow ? `box-shadow:${shadow}` : null;
}

function cssTextShadowStyle(style: Record<string, unknown>, pkg: MotionPackage): string | null {
  const shadow = cssShadowValue(style.textShadow ?? style.shadow, pkg, { includeSpread: false });
  return shadow ? `text-shadow:${shadow}` : null;
}

function cssShadowValue(value: unknown, pkg: MotionPackage, options: { includeSpread: boolean }): string | null {
  const shadow = readRecord(resolveToken(value, pkg));
  if (Object.keys(shadow).length === 0) return null;

  const x = cssLength(resolveToken(shadow.x ?? shadow.offsetX ?? 0, pkg), "0px");
  const y = cssLength(resolveToken(shadow.y ?? shadow.offsetY ?? 0, pkg), "0px");
  const blur = cssLength(resolveToken(shadow.blur ?? shadow.blurRadius ?? 0, pkg), "0px");
  const color = cssColor(shadow.color ?? "rgba(0,0,0,0.35)", pkg, "rgba(0,0,0,0.35)");
  if (!options.includeSpread) return `${x} ${y} ${blur} ${color}`;

  const spread = cssLength(resolveToken(shadow.spread ?? shadow.spreadRadius ?? 0, pkg), "0px");
  return `${x} ${y} ${blur} ${spread} ${color}`;
}

function cssColor(value: unknown, pkg: MotionPackage, fallback: string): string {
  const resolved = String(resolveToken(value, pkg)).trim();
  if (isSupportedMotionColorString(resolved)) return resolved;
  return fallback;
}

function cssLength(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}px`;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^-?(?:\d+|\d*\.\d+)(?:px|em|rem|%|vh|vw)$/i.test(trimmed) ? trimmed : fallback;
}

function cssLineHeight(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return String(value);
  if (typeof value !== "string") return "1.15";
  const trimmed = value.trim();
  if (/^(?:\d+|\d*\.\d+)$/.test(trimmed)) return trimmed;
  return cssLength(trimmed, "1.15");
}

function cssFontWeight(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded >= 1 && rounded <= 1000 ? String(rounded) : "500";
  }
  if (typeof value !== "string") return "500";
  const trimmed = value.trim();
  if (/^(?:normal|bold|bolder|lighter)$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^\d{1,4}$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return parsed >= 1 && parsed <= 1000 ? String(parsed) : "500";
  }
  return "500";
}

function cssFontFamily(value: unknown): string {
  const fallback = "'Inter','Arial',sans-serif";
  return requestedFontFamily(value) ?? fallback;
}

function requestedFontFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[;{}<>]/.test(trimmed) || /(?:url\s*\(|@import)/i.test(trimmed)) return null;
  const families = trimmed.split(",").map(formatFontFamilyPart);
  return families.every((family): family is string => Boolean(family)) ? families.join(",") : null;
}

function formatFontFamilyPart(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (CSS_GENERIC_FONT_FAMILIES.has(lower)) return lower;
  if (!/^-?[A-Za-z_][A-Za-z0-9 _-]*$/.test(trimmed)) return null;
  return `'${trimmed.replace(/['\\]/g, "\\$&")}'`;
}

function resolveToken(value: unknown, pkg: MotionPackage): unknown {
  if (typeof value !== "string") return value;
  const match = /^\{([^}]+)\}$/.exec(value.trim());
  if (!match) return value;
  let current: unknown = pkg.motion.designTokens;
  for (const key of match[1].split(".")) {
    current = readRecord(current)[key];
  }
  return current ?? value;
}

function isLayerActive(layer: MotionLayer, atMs: number): boolean {
  return layer.visible !== false && atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finitePositiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function mimeTypeForAsset(assetRef: string): string {
  const lower = assetRef.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return "image/png";
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
};

const CSS_GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong"
]);

const CSS_BLEND_MODES = new Set([
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function remoteOriginsInHtml(html: string): string[] {
  const origins = new Set<string>();
  const patterns = [
    /\b(?:src|href)=["'](https?:\/\/[^"']+)["']/gi,
    /url\(["']?(https?:\/\/[^"')]+)["']?\)/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const origin = remoteOrigin(match[1]);
      if (origin) origins.add(origin);
    }
  }
  return [...origins].sort();
}

function attr(html: string, name: string): string | null {
  for (const attributes of htmlDataAttributeRecords(html)) {
    const value = attributes[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function htmlDataAttributeRecords(html: string): Array<Record<string, string>> {
  return [...html.matchAll(/<[A-Za-z][^>]*>/g)]
    .map((tag) => parseHtmlAttributes(tag[0]))
    .filter((attributes) => Object.keys(attributes).some((name) => name.startsWith("data-")));
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/\s([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    if (typeof value === "string") attributes[name] = value;
  }
  return attributes;
}

function requestedOriginsForBrowserLayers(pkg: MotionPackage, warnings: string[]): Set<string> {
  return normalizeBrowserOrigins(
    browserLayers(pkg).flatMap((layer) =>
      Array.isArray(layer.allowedOrigins) ? layer.allowedOrigins.map(String) : []
    ),
    "package-declared",
    warnings
  );
}

function browserNetworkResolutionTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BROWSER_NETWORK_RESOLUTION_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_BROWSER_NETWORK_RESOLUTION_TIMEOUT_MS) {
    throw new Error(`browser network resolutionTimeoutMs must be an integer from 1 to ${MAX_BROWSER_NETWORK_RESOLUTION_TIMEOUT_MS}`);
  }
  return value;
}

function normalizeBrowserOrigins(origins: string[], source: string, warnings: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const raw of origins) {
    try {
      const url = new URL(raw);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.origin === "null") {
        throw new Error("origin must be an http(s) URL without credentials");
      }
      normalized.add(url.origin);
    } catch (error) {
      warnings.push(`Ignored invalid ${source} browser origin ${JSON.stringify(raw)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return normalized;
}

function chromiumHostResolverArgs(pins: Map<string, { address: string; family: 4 | 6 }>): string[] {
  const rules = [...pins.entries()]
    // Code-unit order, not localeCompare: these become --host-resolver-rules, so the browser
    // process is launched with a different command line depending on the ambient locale.
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([hostname, address]) => isIP(hostname) === 0
      ? `MAP ${hostname} ${address.family === 6 ? `[${address.address}]` : address.address}`
      : `EXCLUDE ${hostname}`);
  rules.push("MAP * ~NOTFOUND");
  return [
    "--no-proxy-server",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--host-resolver-rules=${rules.join(", ")}`
  ];
}

async function disableBrowserPeerConnections(context: BrowserContext): Promise<void> {
  await context.addInitScript({
    content: `for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
      try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
    }`
  });
}

/**
 * The Chrome/Chromium this renderer will launch.
 *
 * The candidate list and the existence test both live in `@shellx-motion/core` so that the
 * readiness probe behind `shellx-motion doctor` / `motion.platform.requirements` selects the
 * SAME binary this launcher does. A second copy of the search order here is precisely how a green
 * pre-flight and a failing render used to coexist.
 *
 * A `SHELLX_MOTION_BROWSER` pin that cannot be used stops the search rather than sliding to the
 * next candidate, so the error says which pin was rejected. "Set SHELLX_MOTION_BROWSER" would be
 * useless advice to someone who just did.
 */
function findBrowserExecutable(): string {
  const found = findMotionBrowserExecutable();
  if (!found) {
    throw new Error(motionBrowserOverrideProblem()
      ?? `No Chrome/Chromium executable found for browser renderer. Set ${MOTION_BROWSER_OVERRIDE_ENV_VAR}.`);
  }
  return found;
}

// Re-exported from core (which owns the search order) so existing importers of this package keep
// working, and so there is still exactly one list.
export { browserExecutableCandidates };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
