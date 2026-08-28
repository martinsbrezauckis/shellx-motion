/** Range-local GPU proof for one already-admitted durable segmented-final host. */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonSha256,
  compileGpuHybridTextureRequests,
  hashFile,
  motionBrowserExecutableVerificationProblem,
  resolveMotionBrowserExecutable,
  streamingFrameTimestampMs,
  type MotionBrowserExecutableLocation,
  type GpuSceneBehaviorStaticPlan,
  type MotionPackage
} from "@shellx-motion/core";
import {
  createGpuStreamingFrameProducer,
  gpuSessionDynamicImageMetricsProblem,
  type GpuSegmentedHybridAdmission,
  type GpuSegmentedHybridRangeScheduleEntry,
  type GpuStreamingFrameProducer,
  type GpuStreamingStaticPlan
} from "@shellx-motion/renderer-browser";
import type { PreparedAdmittedGpuDelivery } from "./streaming-final-gpu.js";
import { gpuEnvironmentArenaEvidence } from "./gpu-final-receipt-provenance.js";
import { exactGpuBehaviorEvidence } from "./gpu-final-behavior-evidence.js";
import type { SegmentedGpuHostPolicy } from "./segmented-final-gpu-host-types.js";
import { gpuReadbackTransportIdentity } from "./gpu-readback-transport-evidence.js";
import { gpuRangeFramePlanSequenceSha256, gpuRangeFrameSequenceSha256 } from "./segmented-final-internal/render-segment-store-identity.js";
import type { RenderSegmentGpuContainmentProfile, RenderSegmentGpuHybridCapturePlan, RenderSegmentGpuHybridIdentity, RenderSegmentGpuIdentity, RenderSegmentGpuStandardIdentity, RenderSegmentGpuRangeProducerEvidence, RenderSegmentRange } from "./segmented-final-internal/render-segment-store-types.js";
import type {
  RenderSegmentGpuEffectModuleIdentity,
  RenderSegmentGpuEffectModuleRangeProducerEvidence,
  RenderSegmentGpuEffectModuleRangeUseEvidence
} from "./segmented-final-internal/render-segment-gpu-effect-module-types.js";
import { gpuBehaviorRangeEvidence, gpuBehaviorRangeHashes, gpuBehaviorRangeProblem } from "./segmented-final-gpu-behavior-range.js";
import type { RenderSegmentRangeProducer, RenderSegmentRangeProducerFactory, RenderSegmentSpoolFrame, RenderSegmentSpoolFrameSink, RenderSegmentSpoolTimelineFacts } from "./segmented-final-internal/render-segment-spool-types.js";
import type { SegmentedGpuStaticPreflight } from "./segmented-final-gpu-host-types.js";
import {
  abortGpuEffectModuleRangeLease,
  beginGpuEffectModuleRangeLease,
  produceReleasedGpuEffectModuleRange,
  releaseGpuEffectModuleRangeSetupLease
} from "./segmented-final-gpu-effect-module-range.js";

const GPU_SEGMENT_RANGE_PRODUCER_SCHEMA = "shellx-motion/gpu-segment-range-producer@1" as const;

export function createGpuRangeProducerFactory(input: {
  pkg: MotionPackage;
  timeline: RenderSegmentSpoolTimelineFacts;
  staticPlan: GpuStreamingStaticPlan;
  behaviorStaticPlan?: GpuSceneBehaviorStaticPlan;
  delivery: PreparedAdmittedGpuDelivery;
  identity: RenderSegmentGpuIdentity;
  location: MotionBrowserExecutableLocation;
  executableSha256: string;
  policy?: SegmentedGpuHostPolicy;
  /** Opaque pure resolution; every range must take its own current live lease. */
  effectModuleUse?: SegmentedGpuStaticPreflight["effectModuleUse"];
  hybrid?: { admission: GpuSegmentedHybridAdmission; capturePlan: RenderSegmentGpuHybridCapturePlan };
}): RenderSegmentRangeProducerFactory {
  return async ({ range, timeline, frameLane }): Promise<RenderSegmentRangeProducer> => {
    if (frameLane !== "gpu" || !sameTimeline(timeline, input.timeline) || !validRange(range, input.timeline.frameCount)) {
      throw new Error("GPU segmented range factory received a range or timeline outside its immutable admitted plan.");
    }
    const requiresEffectModuleLease = input.identity.schema === "shellx-motion/gpu-effect-module-segmented-identity@1";
    let effectModuleLease: import("@shellx-motion/renderer-browser").GpuEffectModuleBeginUseLease | undefined;
    try {
      effectModuleLease = await beginGpuEffectModuleRangeLease(requiresEffectModuleLease, input.effectModuleUse);
      await assertCurrentBrowserIdentity(input.location, input.executableSha256);
    const hybridIdentity = input.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1"
      ? input.identity
      : undefined;
    if (input.hybrid && !hybridIdentity) {
      throw new Error("GPU segmented hybrid range factory lost its immutable hybrid identity.");
    }
    let evidence: RenderSegmentGpuRangeProducerEvidence | undefined;
      return {
      get evidence() { return evidence; },
      async abort() { await abortGpuEffectModuleRangeLease(effectModuleLease); effectModuleLease = undefined; },
      async produce(sink, job) {
        const maxProcessTreeRssBytes = job.maxProcessTreeRssBytes;
        if (typeof maxProcessTreeRssBytes !== "number" || !Number.isSafeInteger(maxProcessTreeRssBytes) || maxProcessTreeRssBytes < 64 * 1024 * 1024) {
          throw new Error("GPU segmented range requires the exact admitted process-tree memory limit.");
        }
        const producer = createGpuStreamingFrameProducer({
          pkg: input.pkg,
          staticPlan: input.staticPlan,
          ...(input.behaviorStaticPlan ? { behaviorStaticPlan: input.behaviorStaticPlan } : {}),
          resources: input.delivery.resources,
          ...(input.delivery.video ? { openVideoProvider: input.delivery.video.openProvider } : {}),
          ...(input.policy?.openRuntime ? { openRuntime: input.policy.openRuntime } : {}),
          ...(input.policy?.frameTimeoutMs === undefined ? {} : { frameTimeoutMs: input.policy.frameTimeoutMs }),
          browserLocation: input.location,
          range,
          ...(effectModuleLease ? { effectModuleLease } : {}),
          ...(input.hybrid ? { segmentedHybrid: {
            admission: input.hybrid.admission,
            schedule: hybridSchedule(input.pkg, input.hybrid.capturePlan, hybridIdentity!, range)
          } } : {})
        });
        const observed = new RangeEvidenceSink(sink, range, timeline);
        const lease = effectModuleLease;
        effectModuleLease = undefined;
        const rangeUse = lease
          ? await produceReleasedGpuEffectModuleRange({ producer, sink: observed, job: { ...job, maxProcessTreeRssBytes }, lease })
          : (await producer.produce(observed, { ...job, maxProcessTreeRssBytes }), undefined);
        await assertCurrentBrowserIdentity(input.location, input.executableSha256);
        evidence = rangeEvidence({ producer, range, timeline, identity: input.identity, ...(rangeUse ? { effectModules: rangeUse } : {}) });
      }
      };
    } catch (error) { return await releaseGpuEffectModuleRangeSetupLease(effectModuleLease, error); }
  };
}

export function rangeEvidence(input: {
  producer: GpuStreamingFrameProducer;
  range: { index: number; startFrameIndex: number; endFrameIndexExclusive: number };
  timeline: RenderSegmentSpoolTimelineFacts;
  identity: RenderSegmentGpuIdentity;
  effectModules?: RenderSegmentGpuEffectModuleRangeUseEvidence;
}): RenderSegmentGpuRangeProducerEvidence {
  const evidence = input.producer.evidence;
  const range: RenderSegmentRange = {
    index: input.range.index,
    startFrame: input.range.startFrameIndex,
    endFrameExclusive: input.range.endFrameIndexExclusive,
    frameCount: input.range.endFrameIndexExclusive - input.range.startFrameIndex
  };
  const frameHashes = input.producer.rangeEvidence?.frameHashes ?? [];
  const framePlanFingerprints = input.producer.rangeEvidence?.framePlanFingerprints ?? [];
  const behavior = input.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1" ? exactGpuBehaviorEvidence(evidence.behaviors) : undefined;
  const behaviorProblem = input.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1" ? gpuBehaviorRangeProblem(input.identity, behavior, range) : undefined;
  if (behaviorProblem) throw new Error(behaviorProblem);
  const readbackTransport = gpuReadbackTransportIdentity(evidence.readback, range.frameCount);
  const environmentArena = evidence.provenance.staticPlan && evidence.provenance.resourceBudget && evidence.sessionResources
    ? gpuEnvironmentArenaEvidence({
      staticPlan: evidence.provenance.staticPlan,
      resourceBudget: evidence.provenance.resourceBudget,
      sessionResources: evidence.sessionResources,
      range
    })
    : undefined;
  if (frameHashes.length !== range.frameCount || framePlanFingerprints.length !== range.frameCount
    || evidence.session.state !== "closed" || evidence.session.cleanup !== "complete"
    || !evidence.gpu || !evidence.browserVersion || !evidence.provenance.staticPlan || !evidence.provenance.staticScene
    || !evidence.provenance.resourceBudget || !evidence.sessionResources || !readbackTransport
    || environmentArena === undefined
    || evidence.gpu.adapterFingerprint !== input.identity.hostVerdict.adapterFingerprint
    || sha256Canonical(evidence.gpu) !== input.identity.hostVerdict.runtimeEvidenceSha256
    || evidence.browserVersion !== input.identity.hostVerdict.browser.version
    || evidence.gpu.browserSource !== input.identity.hostVerdict.browser.source
    || !sameContainment(evidence.processMonitoring.containment, input.identity.hostVerdict.containment)
    || evidence.provenance.staticPlan.fingerprint !== input.identity.staticPlan.fingerprint
    || evidence.provenance.staticPlan.documentFingerprint !== input.identity.staticPlan.documentFingerprint
    || evidence.provenance.staticPlan.resourceReferencesSha256 !== input.identity.staticPlan.resourceReferencesSha256
    || evidence.provenance.staticPlan.maxima.maxEnvironmentCount !== input.identity.staticPlan.maxEnvironmentCount
    || evidence.provenance.staticScene.sha256 !== input.identity.staticScene.sha256
    || evidence.provenance.staticScene.inputHashesSha256 !== input.identity.staticScene.inputHashesSha256) {
    throw new Error("GPU segmented range did not match the immutable browser, adapter, containment, scene, and complete range evidence closure.");
  }
  if (evidence.provenance.resourceBudget.sha256 !== sha256Canonical({
    schema: evidence.provenance.resourceBudget.schema,
    expectedFrames: evidence.provenance.resourceBudget.expectedFrames,
    observedFrames: evidence.provenance.resourceBudget.observedFrames,
    maxima: evidence.provenance.resourceBudget.maxima
  })) {
    throw new Error("GPU segmented range resource budget hash does not bind its observed local allocation maxima.");
  }
  const segmentedHybrid = input.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1"
    ? input.producer.rangeEvidence?.segmentedHybrid
    : undefined;
  const dynamicTextureProblem = gpuSessionDynamicImageMetricsProblem(
    evidence.sessionResources,
    input.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1" && segmentedHybrid
      ? { slots: 1, bytes: input.identity.hybrid.admission.dynamicTexture.bytes, writes: segmentedHybrid.ledger.captureCount }
      : null
  );
  if (dynamicTextureProblem) {
    throw new Error(`GPU segmented range ${dynamicTextureProblem}.`);
  }
  const frameSequenceSha256 = gpuRangeFrameSequenceSha256({ range, timeline: input.timeline, frameHashes });
  const framePlanSequenceSha256 = gpuRangeFramePlanSequenceSha256({ range, timeline: input.timeline, framePlanFingerprints });
  const finalReceiptInputHashes = Object.freeze({
    "gpu-pipeline-catalog": input.identity.pipelineCatalogSha256,
    "gpu-static-plan": input.identity.staticPlan.fingerprint,
    "gpu-static-plan-document": input.identity.staticPlan.documentFingerprint,
    "gpu-static-plan-resources": input.identity.staticPlan.resourceReferencesSha256,
    "gpu-static-scene": input.identity.staticScene.sha256,
    "gpu-static-inputs": input.identity.staticScene.inputHashesSha256,
    "gpu-resource-budget": evidence.provenance.resourceBudget.sha256,
    "gpu-adapter": input.identity.hostVerdict.adapterFingerprint,
    "gpu-runtime": input.identity.hostVerdict.runtimeEvidenceSha256,
    "gpu-session-resources": sha256Canonical(evidence.sessionResources),
    "gpu-readback-transport": sha256Canonical(readbackTransport),
    "gpu-containment": sha256Canonical(evidence.processMonitoring),
    "gpu-frame-sequence": frameSequenceSha256,
    "gpu-frame-plan-sequence": framePlanSequenceSha256,
    ...(input.identity.schema === "shellx-motion/gpu-effect-module-segmented-identity@1" && input.effectModules ? {
      "gpu-effect-module-descriptors": input.identity.effectModules.descriptorSequenceSha256,
      "gpu-effect-module-range-use": canonicalJsonSha256(input.effectModules)
    } : {}),
    ...(behavior ? gpuBehaviorRangeHashes(behavior) : {}),
    ...(environmentArena ? { "gpu-environment-arena": sha256Canonical(environmentArena) } : {}),
    ...(input.identity.videoStaging ? {
      "gpu-video-staging-ledger": input.identity.videoStaging.ledgerSha256,
      "gpu-video-pcm": input.identity.videoStaging.pcmSha256
    } : {})
  });
  if (input.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1") {
    const hybrid = segmentedHybrid;
    if (!hybrid || canonicalJson(hybrid.identity) !== canonicalJson(input.identity.hybrid.admission)) {
      throw new Error("GPU segmented hybrid range did not retain its immutable Browser admission identity.");
    }
    return Object.freeze({
      schema: "shellx-motion/gpu-hybrid-segment-range-producer@1" as const,
      frameLane: "gpu" as const,
      identity: input.identity,
      frameSequenceSha256,
      framePlanSequenceSha256,
      framePlanFingerprints: Object.freeze([...framePlanFingerprints]),
      ...(environmentArena ? { environmentArena } : {}),
      hybrid: Object.freeze({ ledger: hybrid.ledger, cleanup: hybrid.cleanup }),
      finalReceiptInputHashes: Object.freeze({
        ...finalReceiptInputHashes,
        "gpu-hybrid-admission": sha256Canonical(input.identity.hybrid.admission),
        "gpu-hybrid-capture-plan": input.identity.hybrid.capturePlan.sha256,
        "gpu-hybrid-range-ledger": hybrid.ledger.sequenceSha256
      }),
      warningUnion: [],
      warningsOmitted: 0
    });
  }
  if (input.identity.schema === "shellx-motion/gpu-effect-module-segmented-identity@1") {
    if (!input.effectModules) throw new Error("GPU segmented module range did not produce released module-use evidence.");
    return Object.freeze({
      schema: "shellx-motion/gpu-effect-module-segment-range-producer@1" as const,
      frameLane: "gpu" as const,
      identity: input.identity as RenderSegmentGpuEffectModuleIdentity,
      frameSequenceSha256,
      framePlanSequenceSha256,
      framePlanFingerprints: Object.freeze([...framePlanFingerprints]),
      ...(environmentArena ? { environmentArena } : {}),
      effectModules: input.effectModules,
      finalReceiptInputHashes: Object.freeze(finalReceiptInputHashes),
      warningUnion: [],
      warningsOmitted: 0
    } satisfies RenderSegmentGpuEffectModuleRangeProducerEvidence);
  }
  if (input.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1") return gpuBehaviorRangeEvidence({ identity: input.identity, range, frameSequenceSha256, framePlanSequenceSha256, framePlanFingerprints, ...(environmentArena ? { environmentArena } : {}), behavior: behavior!, finalReceiptInputHashes });
  return Object.freeze({
    schema: GPU_SEGMENT_RANGE_PRODUCER_SCHEMA,
    frameLane: "gpu",
    identity: input.identity as RenderSegmentGpuStandardIdentity,
    frameSequenceSha256,
    framePlanSequenceSha256,
    framePlanFingerprints: Object.freeze([...framePlanFingerprints]),
    ...(environmentArena ? { environmentArena } : {}),
    finalReceiptInputHashes,
    warningUnion: [],
    warningsOmitted: 0
  });
}

function hybridSchedule(
  pkg: MotionPackage,
  plan: RenderSegmentGpuHybridCapturePlan,
  identity: RenderSegmentGpuHybridIdentity,
  range: { startFrameIndex: number; endFrameIndexExclusive: number }
): GpuSegmentedHybridRangeScheduleEntry[] {
  const snapshots = new Map([[identity.hybrid.admission.sourceSnapshot.layerId, identity.hybrid.admission.sourceSnapshot]]);
  return plan.entries
    .filter((entry) => entry.index >= range.startFrameIndex && entry.index < range.endFrameIndexExclusive)
    .map((entry) => {
      const compiled = compileGpuHybridTextureRequests({ motion: pkg.motion, atUs: entry.atUs, snapshots });
      if (!compiled.ok || compiled.requests.length !== 1) {
        throw new Error(`GPU segmented hybrid range schedule no longer has one exact Core request at frame ${entry.index}.`);
      }
      const request = compiled.requests[0]!;
      if (request.requestFingerprint !== entry.requestFingerprint
        || request.atUs !== entry.atUs) {
        throw new Error(`GPU segmented hybrid range schedule no longer matches its immutable Core request plan at frame ${entry.index}.`);
      }
      return { index: entry.index, atMs: entry.atMs, request };
    });
}

class RangeEvidenceSink implements RenderSegmentSpoolFrameSink {
  readonly frameHashes: string[] = [];
  constructor(
    private readonly sink: RenderSegmentSpoolFrameSink,
    private readonly range: { startFrameIndex: number; endFrameIndexExclusive: number },
    private readonly timeline: RenderSegmentSpoolTimelineFacts
  ) {}
  async write(frame: RenderSegmentSpoolFrame): Promise<void> {
    if (frame.index !== this.range.startFrameIndex + this.frameHashes.length
      || frame.index >= this.range.endFrameIndexExclusive
      || frame.atMs !== streamingFrameTimestampMs(frame.index, this.timeline.fps, this.timeline.durationMs)) {
      throw new Error("GPU segmented range producer emitted a non-canonical frame index or timestamp.");
    }
    if (!("rgba" in frame)) throw new Error("GPU segmented delivery accepts only raw RGBA range frames.");
    this.frameHashes.push(createHash("sha256").update(frame.rgba).digest("hex"));
    await this.sink.write(frame);
  }
}

async function assertCurrentBrowserIdentity(expected: MotionBrowserExecutableLocation, expectedSha256: string): Promise<void> {
  const current = resolveMotionBrowserExecutable();
  if (current.executable !== expected.executable || current.source !== expected.source
    || motionBrowserExecutableVerificationProblem(current)
    || await hashFile(current.executable) !== expectedSha256) {
    throw new Error("GPU segmented delivery refused because its trusted Chromium identity changed after durable host admission.");
  }
}

function sameContainment(value: unknown, expected: RenderSegmentGpuContainmentProfile): boolean {
  if (!value || typeof value !== "object") return false;
  const actual = value as import("@shellx-motion/renderer-browser").GpuBrowserProcessTreeContainment;
  if (actual.mode !== expected.mode || actual.memoryLimit !== expected.memoryLimit
    || actual.maxProcessTreeRssBytes !== expected.maxProcessTreeRssBytes) return false;
  return actual.mode === "unix-process-group"
    ? expected.mode === "unix-process-group"
    : expected.mode === "windows-job-object"
      && actual.maxActiveProcesses === expected.maxActiveProcesses
      && actual.launcher.sha256 === expected.launcherSha256;
}

function validRange(value: { index: number; startFrameIndex: number; endFrameIndexExclusive: number }, frameCount: number): boolean {
  return Number.isSafeInteger(value.index) && value.index >= 0
    && Number.isSafeInteger(value.startFrameIndex) && Number.isSafeInteger(value.endFrameIndexExclusive)
    && value.startFrameIndex >= 0 && value.endFrameIndexExclusive > value.startFrameIndex
    && value.endFrameIndexExclusive <= frameCount;
}

function sameTimeline(left: RenderSegmentSpoolTimelineFacts, right: RenderSegmentSpoolTimelineFacts): boolean {
  return left.motionSha256 === right.motionSha256 && left.frameCount === right.frameCount
    && left.durationMs === right.durationMs && left.fps === right.fps
    && left.width === right.width && left.height === right.height;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
