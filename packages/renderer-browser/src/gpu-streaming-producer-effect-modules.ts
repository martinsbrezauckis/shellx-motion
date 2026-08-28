import {
  canonicalJson,
  createGpuEffectModuleBinding,
  gpuVideoTimelineAtUs,
  type GpuScene2dCompileResources
} from "@shellx-motion/core";
import {
  gpuEffectModuleApplicationLedger,
  gpuEffectModuleBeginUseFrameResources,
  recordGpuEffectModuleApplication,
  type GpuEffectModuleApplicationLedger,
  type GpuEffectModuleApplicationLedgerEntry,
  type GpuEffectModuleBeginUseLease
} from "./gpu-effect-module-use-authority";
import type {
  GpuStreamingEffectModuleEvidence,
  GpuStreamingEffectModuleLiveResources,
  GpuStreamingEffectModuleTerminalResources,
  GpuStreamingFrameProducerInput,
  GpuStreamingStaticPlan
} from "./gpu-streaming-producer-types";

type FrameResources = Pick<GpuScene2dCompileResources, "effectModuleDescriptors" | "effectModuleBindings">;

/** Per-producer use evidence; the outer final/range owner still releases. */
export interface GpuStreamingEffectModuleRun {
  readonly resources: FrameResources;
  recordSuccessfulFrame(index: number, atMs: number, frame: unknown): void;
  attestLive(metrics: unknown): void;
  attestTerminal(metrics: unknown): void;
  evidence(runtimeCleanup: "complete" | "failed"): GpuStreamingEffectModuleEvidence;
}

/** Refuses a structural/released lease before any package or Browser resource work. */
export function openGpuStreamingEffectModuleRun(
  staticPlan: GpuStreamingStaticPlan,
  lease: GpuStreamingFrameProducerInput["effectModuleLease"],
  segmentedHybrid: GpuStreamingFrameProducerInput["segmentedHybrid"]
): GpuStreamingEffectModuleRun | null {
  const descriptors = staticPlan.effectModules;
  if (!descriptors) {
    if (lease) throw new Error("GPU final delivery refuses an unused effect-module lease on a module-free static plan.");
    return null;
  }
  if (staticPlan.hybridTextures?.length || segmentedHybrid) throw new Error("GPU final delivery does not combine governed effect modules with B2 hybrid surfaces.");
  if (!lease) throw new Error("GPU final delivery requires a current trusted effect-module use lease before package resources or Chromium open.");
  let resources: FrameResources;
  try { resources = gpuEffectModuleBeginUseFrameResources(lease); } catch (error) {
    throw new Error(error instanceof Error ? `GPU final delivery refused its effect-module lease: ${error.message}` : "GPU final delivery refused its effect-module lease.");
  }
  const boundDescriptors = resources.effectModuleDescriptors, bindings = resources.effectModuleBindings;
  if (!boundDescriptors || !bindings || boundDescriptors.size !== descriptors.length || bindings.size !== descriptors.length) {
    throw new Error("GPU final delivery effect-module lease does not cover the exact static descriptor set.");
  }
  for (const descriptor of descriptors) {
    const bound = boundDescriptors.get(descriptor.layerId), binding = bindings.get(descriptor.layerId);
    let expectedBinding;
    try { expectedBinding = createGpuEffectModuleBinding(descriptor); } catch {
      throw new Error("GPU final delivery effect-module static descriptor cannot create its closed renderer binding.");
    }
    if (!bound || !binding || canonicalJson(bound) !== canonicalJson(descriptor) || canonicalJson(binding) !== canonicalJson(expectedBinding)) {
      throw new Error("GPU final delivery effect-module lease does not exactly bind its static descriptor.");
    }
  }
  const applications: GpuEffectModuleApplicationLedgerEntry[] = [];
  let live: GpuStreamingEffectModuleLiveResources | null = null;
  let terminal: GpuStreamingEffectModuleTerminalResources | null = null;
  let ledger: GpuEffectModuleApplicationLedger | undefined;
  return Object.freeze({
    resources,
    recordSuccessfulFrame(index: number, atMs: number, frame: unknown) {
      const draw = (frame as { draws?: readonly { kind?: unknown; layerId?: unknown }[] }).draws?.find((candidate) => candidate.kind === "effectModule");
      if (!draw || typeof draw.layerId !== "string") return;
      const atUs = gpuVideoTimelineAtUs(atMs);
      const fingerprint = (frame as { fingerprint?: unknown }).fingerprint;
      if (atUs === null || typeof fingerprint !== "string") throw new Error("GPU effect-module final delivery could not derive its exact canonical application record.");
      const entry = Object.freeze({ index, atUs, framePlanFingerprint: fingerprint, layerId: draw.layerId });
      recordGpuEffectModuleApplication(lease, entry, frame);
      applications.push(entry);
    },
    attestLive(metrics: unknown) {
      const problem = liveResourcesProblem(metrics, applications.length);
      if (problem) throw new Error(problem);
      if (applications.length) live = liveResources(metrics);
      ledger = gpuEffectModuleApplicationLedger(lease, applications);
    },
    attestTerminal(metrics: unknown) {
      const problem = terminalResourcesProblem(metrics, applications.length);
      if (problem) throw new Error(problem);
      if (applications.length) terminal = terminalResources();
    },
    evidence(runtimeCleanup: "complete" | "failed") {
      ledger ??= gpuEffectModuleApplicationLedger(lease, applications);
      return Object.freeze({ schema: "shellx-motion/gpu-effect-module-streaming-use@1", ledger,
        resources: Object.freeze({ live, terminal }), runtimeCleanup, leaseRelease: "outer-host-owned-pending" });
    }
  });
}

function liveResourcesProblem(value: unknown, applications: number): string | null {
  if (!value || typeof value !== "object") return "GPU effect-module final delivery lacks live fixed-pass resource evidence.";
  const metrics = value as Record<string, unknown>;
  if (!applications) return afterimageFields.every((field) => metrics[field] === undefined) ? null : "GPU effect-module final delivery retained fixed-pass resources for a range with no module application.";
  return metrics.afterimageStackUniformBufferSlots === 1 && metrics.afterimageStackUniformBytes === 160 && metrics.afterimageStackBindGroupSlots === 1
    && metrics.afterimageStackPasses === applications && metrics.afterimageStackFrames === applications
    && metrics.afterimageStackLateAllocationRefusals === 0 && metrics.afterimageStackPersistentTextureCount === 0
    && metrics.afterimageStackPipelineReleases === undefined && metrics.afterimageStackPreparedBindGroupReleases === undefined && metrics.afterimageStackArenaUniformBufferDestructions === undefined
    ? null : "GPU effect-module live fixed-pass resource evidence is incomplete or changed after admission.";
}

function liveResources(value: unknown): GpuStreamingEffectModuleLiveResources {
  const metrics = value as Record<string, number>;
  return Object.freeze({ uniformBufferSlots: 1, uniformBytes: 160, bindGroupSlots: 1, passes: metrics.afterimageStackPasses!, frames: metrics.afterimageStackFrames!, lateAllocationRefusals: 0, persistentTextureCount: 0 });
}

function terminalResourcesProblem(value: unknown, applications: number): string | null {
  if (!value || typeof value !== "object") return "GPU effect-module final delivery lacks terminal fixed-pass cleanup evidence.";
  const metrics = value as Record<string, unknown>;
  if (!applications) return afterimageFields.every((field) => metrics[field] === undefined) ? null : "GPU effect-module final delivery retained fixed-pass cleanup evidence for a range with no module application.";
  return metrics.afterimageStackUniformBufferSlots === 0 && metrics.afterimageStackUniformBytes === 0 && metrics.afterimageStackBindGroupSlots === 0
    && metrics.afterimageStackPipelineReleases === 1 && metrics.afterimageStackPreparedBindGroupReleases === 1 && metrics.afterimageStackArenaUniformBufferDestructions === 1
    ? null : "GPU effect-module final delivery did not prove complete fixed-pass resource cleanup.";
}

function terminalResources(): GpuStreamingEffectModuleTerminalResources {
  return Object.freeze({ uniformBufferSlots: 0, uniformBytes: 0, bindGroupSlots: 0, pipelineReleases: 1, preparedBindGroupReleases: 1, arenaUniformBufferDestructions: 1 });
}

const afterimageFields = ["afterimageStackUniformBufferSlots", "afterimageStackUniformBytes", "afterimageStackBindGroupSlots", "afterimageStackPasses", "afterimageStackFrames", "afterimageStackLateAllocationRefusals", "afterimageStackPersistentTextureCount", "afterimageStackPipelineReleases", "afterimageStackPreparedBindGroupReleases", "afterimageStackArenaUniformBufferDestructions"] as const;
