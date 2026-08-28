import { canonicalJson, canonicalJsonSha256, type ActiveScriptSource, type AgentScriptExecutionEvidence } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import type {
  RenderSegmentGpuHybridIdentity,
  RenderSegmentGpuHybridAggregateProducerEvidence,
  RenderSegmentGpuHybridRangeProducerEvidence,
  RenderSegmentGpuStandardIdentity,
  RenderSegmentGpuStandardRangeProducerEvidence,
  RenderSegmentRangeProducerEvidence,
  RenderSegmentFinalProducerEvidence,
  RenderSegmentStoreManifest
} from "./render-segment-store-types.js";
import type {
  RenderSegmentGpuEffectModuleAggregateProducerEvidence,
  RenderSegmentGpuEffectModuleIdentity,
  RenderSegmentGpuEffectModuleRangeProducerEvidence
} from "./render-segment-gpu-effect-module-types.js";
import {
  renderSegmentGpuBehaviorRangeIdentity,
  type RenderSegmentGpuBehaviorAggregateProducerEvidence,
  type RenderSegmentGpuBehaviorRangeIdentity,
  type RenderSegmentGpuBehaviorRangeProducerEvidence
} from "./render-segment-gpu-behavior-types.js";
import { fullStreamedFrameSequenceSha256 } from "./render-segment-store-identity.js";
import { cloneGpuBehaviorRangeIdentity, cloneGpuEffectModuleRangeUse, cloneGpuIdentity } from "./render-segment-gpu-identity-clone.js";
import { SegmentSpoolOperationError } from "./render-segment-spool-helpers.js";
export function requireSegmentProducerEvidence(
  value: Readonly<RenderSegmentRangeProducerEvidence> | undefined,
  frameLane: "browser" | "native" | "gpu"
): RenderSegmentRangeProducerEvidence {
  const matchingSchema = frameLane === "gpu"
    ? value?.schema === "shellx-motion/gpu-segment-range-producer@1" || value?.schema === "shellx-motion/gpu-hybrid-segment-range-producer@1" || value?.schema === "shellx-motion/gpu-effect-module-segment-range-producer@1" || value?.schema === "shellx-motion/gpu-behavior-segment-range-producer@1"
    : value?.schema === "shellx-motion/segment-range-producer@1";
  if (!value || !matchingSchema || value.frameLane !== frameLane) {
    throw new SegmentSpoolOperationError("producer", "Segment producer completed without matching bounded evidence.");
  }
  if (frameLane === "browser" && !value.scriptExecution) {
    throw new SegmentSpoolOperationError("producer", "Browser segment producer completed without session-owned script evidence.");
  }
  return cloneSegmentProducerEvidence(value) as RenderSegmentRangeProducerEvidence;
}

function cloneActiveScriptSource(value: Readonly<ActiveScriptSource>): ActiveScriptSource {
  return {
    layerId: value.layerId,
    layerType: value.layerType,
    path: value.path,
    sha256: value.sha256,
    bytes: value.bytes
  };
}

export function cloneScriptExecutionEvidence(
  value: Readonly<AgentScriptExecutionEvidence>
): AgentScriptExecutionEvidence {
  return {
    schema: value.schema,
    detectedClass: value.detectedClass,
    requestedMode: value.requestedMode,
    activeMode: value.activeMode,
    resolverVersion: value.resolverVersion,
    ...(value.packageSnapshotSha256 !== undefined
      ? { packageSnapshotSha256: value.packageSnapshotSha256 }
      : {}),
    ...(value.attestationId !== undefined ? { attestationId: value.attestationId } : {}),
    sources: value.sources.map(cloneActiveScriptSource),
    ...(value.entry !== undefined ? { entry: cloneActiveScriptSource(value.entry) } : {})
  };
}

export function cloneSegmentProducerEvidence(
  value: Readonly<RenderSegmentFinalProducerEvidence>
): RenderSegmentFinalProducerEvidence {
  if (value.frameLane === "gpu") {
    if (value.schema === "shellx-motion/gpu-behavior-segment-aggregate-producer@1") {
      return {
        schema: value.schema, frameLane: "gpu", identity: cloneGpuBehaviorRangeIdentity(value.identity) as RenderSegmentGpuBehaviorRangeIdentity,
        frameSequenceSha256: value.frameSequenceSha256, framePlanSequenceSha256: value.framePlanSequenceSha256,
        framePlanFingerprints: [...value.framePlanFingerprints], behaviors: { ...value.behaviors },
        finalReceiptInputHashes: { ...value.finalReceiptInputHashes }, warningUnion: [...value.warningUnion], warningsOmitted: value.warningsOmitted
      } satisfies RenderSegmentGpuBehaviorAggregateProducerEvidence;
    }
    if (value.schema === "shellx-motion/gpu-effect-module-segment-aggregate-producer@1") {
      return {
        schema: value.schema, frameLane: "gpu", identity: cloneGpuIdentity(value.identity) as RenderSegmentGpuEffectModuleIdentity,
        frameSequenceSha256: value.frameSequenceSha256, framePlanSequenceSha256: value.framePlanSequenceSha256,
        framePlanFingerprints: [...value.framePlanFingerprints], effectModules: { ...value.effectModules },
        finalReceiptInputHashes: { ...value.finalReceiptInputHashes }, warningUnion: [...value.warningUnion], warningsOmitted: value.warningsOmitted
      } satisfies RenderSegmentGpuEffectModuleAggregateProducerEvidence;
    }
    if (value.schema === "shellx-motion/gpu-hybrid-segment-aggregate-producer@1") {
      return {
        schema: value.schema, frameLane: "gpu", identity: cloneGpuIdentity(value.identity) as RenderSegmentGpuHybridIdentity,
        frameSequenceSha256: value.frameSequenceSha256, framePlanSequenceSha256: value.framePlanSequenceSha256,
        framePlanFingerprints: [...value.framePlanFingerprints], hybrid: { ...value.hybrid },
        finalReceiptInputHashes: { ...value.finalReceiptInputHashes }, warningUnion: [...value.warningUnion], warningsOmitted: value.warningsOmitted
      } satisfies RenderSegmentGpuHybridAggregateProducerEvidence;
    }
    const shared = {
      frameLane: "gpu" as const,
      frameSequenceSha256: value.frameSequenceSha256,
      framePlanSequenceSha256: value.framePlanSequenceSha256,
      framePlanFingerprints: [...value.framePlanFingerprints],
      ...(value.environmentArena ? { environmentArena: cloneGpuEnvironmentArena(value.environmentArena) } : {}),
      finalReceiptInputHashes: Object.freeze({ ...value.finalReceiptInputHashes }),
      warningUnion: [...value.warningUnion],
      warningsOmitted: value.warningsOmitted
    };
    if (value.schema === "shellx-motion/gpu-hybrid-segment-range-producer@1") {
      return {
        ...shared,
        schema: value.schema,
        identity: cloneGpuIdentity(value.identity) as RenderSegmentGpuHybridIdentity,
        hybrid: {
          ledger: { ...value.hybrid.ledger, entries: value.hybrid.ledger.entries.map((entry) => ({ ...entry })) },
          cleanup: { ...value.hybrid.cleanup, dynamicTexture: { ...value.hybrid.cleanup.dynamicTexture } }
        }
      } satisfies RenderSegmentGpuHybridRangeProducerEvidence;
    }
    if (value.schema === "shellx-motion/gpu-effect-module-segment-range-producer@1") {
      return {
        ...shared,
        schema: value.schema,
        identity: cloneGpuIdentity(value.identity) as RenderSegmentGpuEffectModuleIdentity,
        effectModules: cloneGpuEffectModuleRangeUse(value.effectModules)
      } satisfies RenderSegmentGpuEffectModuleRangeProducerEvidence;
    }
    if (value.schema === "shellx-motion/gpu-behavior-segment-range-producer@1") {
      return {
        ...shared,
        schema: value.schema,
        identity: cloneGpuBehaviorRangeIdentity(value.identity) as RenderSegmentGpuBehaviorRangeIdentity,
        behaviors: { ...value.behaviors }
      } satisfies RenderSegmentGpuBehaviorRangeProducerEvidence;
    }
    return {
      ...shared,
      schema: value.schema,
      identity: cloneGpuIdentity(value.identity) as RenderSegmentGpuStandardIdentity
    } satisfies RenderSegmentGpuStandardRangeProducerEvidence;
  }
  return {
    schema: value.schema,
    frameLane: value.frameLane,
    ...(value.scriptExecution !== undefined
      ? { scriptExecution: cloneScriptExecutionEvidence(value.scriptExecution) }
      : {}),
    warningUnion: [...value.warningUnion],
    warningsOmitted: value.warningsOmitted
  };
}

function cloneGpuEnvironmentArena(value: NonNullable<Extract<RenderSegmentRangeProducerEvidence, { frameLane: "gpu" }> ["environmentArena"]>) {
  return {
    ...value,
    resourceBudget: { ...value.resourceBudget },
    frameArena: { ...value.frameArena },
    uniforms: { ...value.uniforms },
    ...(value.range ? { range: { ...value.range } } : {})
  };
}

export function assertSegmentProducerConsistency(
  expected: RenderSegmentStoreManifest["producer"],
  candidate: RenderSegmentRangeProducerEvidence
): void {
  if (expected.frameLane !== candidate.frameLane) {
    throw new SegmentSpoolOperationError("producer", "Segment producer evidence conflicts with the current host verdict and verified checkpoint prefix.");
  }
  if (expected.frameLane === "gpu") {
    const identity = expected.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1"
      ? renderSegmentGpuBehaviorRangeIdentity(expected.identity)
      : expected.identity;
    if (candidate.frameLane !== "gpu" || canonicalJson(identity) !== canonicalJson(candidate.identity)) {
      throw new SegmentSpoolOperationError("producer", "GPU segment producer evidence conflicts with the immutable GPU identity and verified checkpoint prefix.");
    }
    return;
  }
  if (canonicalJson(expected.frameLane === "browser" ? expected.scriptExecution : undefined)
    !== canonicalJson(candidate.scriptExecution)) {
    throw new SegmentSpoolOperationError("producer", "Segment producer evidence conflicts with the current host verdict and verified checkpoint prefix.");
  }
}

export function combinedSegmentProducerEvidence(manifest: RenderSegmentStoreManifest): RenderSegmentFinalProducerEvidence {
  const entries = manifest.completed.map((entry) => entry.producer);
  if (entries.length === 0) throw new SegmentSpoolOperationError("producer", "Segmented final has no producer evidence.");
  const first = entries[0]!;
  for (const entry of entries) assertSegmentProducerConsistency(manifest.producer, entry);
  const warnings: string[] = [];
  let warningsOmitted = entries.reduce((total, entry) => total + entry.warningsOmitted, 0);
  for (const entry of entries) {
    for (const warning of entry.warningUnion) {
      if (warnings.includes(warning)) continue;
      if (warnings.length < 64) warnings.push(warning);
      else warningsOmitted += 1;
    }
  }
  if (first.frameLane === "gpu") {
    const framePlanSequence = createHash("sha256");
    const dynamicLedgers = {
      containment: [] as string[],
      resourceBudget: [] as string[],
      sessionResources: [] as string[],
      readbackTransport: [] as string[],
      environmentArena: [] as string[],
      hybridEntries: [] as unknown[],
      hybridRanges: [] as unknown[],
      effectModuleRangeUses: [] as unknown[],
      effectModuleApplications: [] as unknown[],
      behaviorPlanRanges: [] as unknown[],
      behaviorBudgetRanges: [] as unknown[]
    };
    for (const entry of manifest.completed) {
      if (entry.producer.frameLane !== "gpu") throw new SegmentSpoolOperationError("producer", "GPU checkpoint producer evidence is inconsistent.");
      for (const [offset, fingerprint] of entry.producer.framePlanFingerprints.entries()) {
        const index = entry.range.startFrame + offset;
        const atMs = Math.round((index * 1000) / manifest.timeline.fps);
        framePlanSequence.update(canonicalJson({ index, atMs: Math.max(0, Math.min(atMs, Math.max(0, manifest.timeline.durationMs - 1))), fingerprint }));
      }
      dynamicLedgers.containment.push(entry.producer.finalReceiptInputHashes["gpu-containment"]!);
      dynamicLedgers.resourceBudget.push(entry.producer.finalReceiptInputHashes["gpu-resource-budget"]!);
      dynamicLedgers.sessionResources.push(entry.producer.finalReceiptInputHashes["gpu-session-resources"]!);
      dynamicLedgers.readbackTransport.push(entry.producer.finalReceiptInputHashes["gpu-readback-transport"]!);
      if (entry.producer.identity.staticPlan.maxEnvironmentCount > 0) {
        dynamicLedgers.environmentArena.push(entry.producer.finalReceiptInputHashes["gpu-environment-arena"]!);
      }
      if (first.schema === "shellx-motion/gpu-hybrid-segment-range-producer@1") {
        if (entry.producer.schema !== "shellx-motion/gpu-hybrid-segment-range-producer@1") {
          throw new SegmentSpoolOperationError("producer", "Hybrid GPU checkpoint ledger schema conflicts with the immutable hybrid store identity.");
        }
        dynamicLedgers.hybridEntries.push(...entry.producer.hybrid.ledger.entries);
        dynamicLedgers.hybridRanges.push({ range: entry.range, sequenceSha256: entry.producer.hybrid.ledger.sequenceSha256 });
      }
      if (first.schema === "shellx-motion/gpu-effect-module-segment-range-producer@1") {
        if (entry.producer.schema !== "shellx-motion/gpu-effect-module-segment-range-producer@1") {
          throw new SegmentSpoolOperationError("producer", "Module-bearing GPU checkpoint schema conflicts with immutable store identity.");
        }
        dynamicLedgers.effectModuleRangeUses.push(entry.producer.effectModules);
        dynamicLedgers.effectModuleApplications.push(...entry.producer.effectModules.released.applications);
      }
      if (first.schema === "shellx-motion/gpu-behavior-segment-range-producer@1") {
        if (entry.producer.schema !== "shellx-motion/gpu-behavior-segment-range-producer@1") {
          throw new SegmentSpoolOperationError("producer", "Behavior GPU checkpoint schema conflicts with immutable behavior store identity.");
        }
        dynamicLedgers.behaviorPlanRanges.push({ range: entry.range, sequenceSha256: entry.producer.behaviors.framePlanSequenceSha256 });
        dynamicLedgers.behaviorBudgetRanges.push({ range: entry.range, sequenceSha256: entry.producer.behaviors.frameBudgetSequenceSha256 });
      }
    }
    const finalReceiptInputHashes = {
      ...first.finalReceiptInputHashes,
      "gpu-containment": canonicalJsonSha256(dynamicLedgers.containment),
      "gpu-resource-budget": canonicalJsonSha256(dynamicLedgers.resourceBudget),
      "gpu-session-resources": canonicalJsonSha256(dynamicLedgers.sessionResources),
      "gpu-readback-transport": canonicalJsonSha256(dynamicLedgers.readbackTransport),
      ...(first.schema === "shellx-motion/gpu-hybrid-segment-range-producer@1"
        ? {
          "gpu-hybrid-range-ledger": canonicalJsonSha256(dynamicLedgers.hybridEntries),
          "gpu-hybrid-range-ledger-sequence": canonicalJsonSha256(dynamicLedgers.hybridRanges)
        }
        : {}),
      ...(first.schema === "shellx-motion/gpu-effect-module-segment-range-producer@1"
        ? {
          "gpu-effect-module-range-use": canonicalJsonSha256(dynamicLedgers.effectModuleRangeUses),
          "gpu-effect-module-applications": canonicalJsonSha256(dynamicLedgers.effectModuleApplications)
        }
        : {}),
      ...(first.schema === "shellx-motion/gpu-behavior-segment-range-producer@1"
        ? {
          "gpu-behavior-frame-plan-sequence": canonicalJsonSha256(dynamicLedgers.behaviorPlanRanges),
          "gpu-behavior-frame-budget-sequence": canonicalJsonSha256(dynamicLedgers.behaviorBudgetRanges)
        }
        : {}),
      ...(first.identity.staticPlan.maxEnvironmentCount > 0
        ? { "gpu-environment-arena": canonicalJsonSha256(dynamicLedgers.environmentArena) }
        : {}),
      "gpu-frame-sequence": fullStreamedFrameSequenceSha256(manifest),
      "gpu-frame-plan-sequence": framePlanSequence.digest("hex")
    };
    if (first.schema === "shellx-motion/gpu-hybrid-segment-range-producer@1") {
      return {
        schema: "shellx-motion/gpu-hybrid-segment-aggregate-producer@1",
        frameLane: "gpu",
        identity: cloneGpuIdentity(first.identity) as RenderSegmentGpuHybridIdentity,
        frameSequenceSha256: finalReceiptInputHashes["gpu-frame-sequence"],
        framePlanSequenceSha256: finalReceiptInputHashes["gpu-frame-plan-sequence"],
        framePlanFingerprints: manifest.completed.flatMap((entry) => entry.producer.frameLane === "gpu" ? entry.producer.framePlanFingerprints : []),
        hybrid: {
          rangeCount: manifest.completed.length,
          captureCount: dynamicLedgers.hybridEntries.length,
          captureSequenceSha256: finalReceiptInputHashes["gpu-hybrid-range-ledger"]!,
          rangeLedgerSequenceSha256: finalReceiptInputHashes["gpu-hybrid-range-ledger-sequence"]!
        },
        finalReceiptInputHashes,
        warningUnion: warnings,
        warningsOmitted
      } satisfies RenderSegmentGpuHybridAggregateProducerEvidence;
    }
    if (first.schema === "shellx-motion/gpu-effect-module-segment-range-producer@1") {
      return {
        schema: "shellx-motion/gpu-effect-module-segment-aggregate-producer@1",
        frameLane: "gpu",
        identity: cloneGpuIdentity(first.identity) as RenderSegmentGpuEffectModuleIdentity,
        frameSequenceSha256: finalReceiptInputHashes["gpu-frame-sequence"],
        framePlanSequenceSha256: finalReceiptInputHashes["gpu-frame-plan-sequence"],
        framePlanFingerprints: manifest.completed.flatMap((entry) => entry.producer.frameLane === "gpu" ? entry.producer.framePlanFingerprints : []),
        effectModules: {
          rangeCount: manifest.completed.length,
          applicationCount: dynamicLedgers.effectModuleApplications.length,
          applicationSequenceSha256: finalReceiptInputHashes["gpu-effect-module-applications"]!,
          rangeUseSequenceSha256: finalReceiptInputHashes["gpu-effect-module-range-use"]!,
          release: "all-ranges-released"
        },
        finalReceiptInputHashes,
        warningUnion: warnings,
        warningsOmitted
      } satisfies RenderSegmentGpuEffectModuleAggregateProducerEvidence;
    }
    if (first.schema === "shellx-motion/gpu-behavior-segment-range-producer@1") {
      return {
        schema: "shellx-motion/gpu-behavior-segment-aggregate-producer@1",
        frameLane: "gpu",
        identity: cloneGpuBehaviorRangeIdentity(first.identity) as RenderSegmentGpuBehaviorRangeIdentity,
        frameSequenceSha256: finalReceiptInputHashes["gpu-frame-sequence"],
        framePlanSequenceSha256: finalReceiptInputHashes["gpu-frame-plan-sequence"],
        framePlanFingerprints: manifest.completed.flatMap((entry) => entry.producer.frameLane === "gpu" ? entry.producer.framePlanFingerprints : []),
        behaviors: {
          rangeCount: manifest.completed.length,
          framePlanRangeSequenceSha256: finalReceiptInputHashes["gpu-behavior-frame-plan-sequence"]!,
          frameBudgetRangeSequenceSha256: finalReceiptInputHashes["gpu-behavior-frame-budget-sequence"]!
        },
        finalReceiptInputHashes,
        warningUnion: warnings,
        warningsOmitted
      } satisfies RenderSegmentGpuBehaviorAggregateProducerEvidence;
    }
    // Range-local reservation facts belong only to their durable checkpoint.
    const { environmentArena: _rangeEnvironmentArena, ...combinedFirst } = first;
    return {
      ...combinedFirst,
      frameSequenceSha256: finalReceiptInputHashes["gpu-frame-sequence"],
      framePlanSequenceSha256: finalReceiptInputHashes["gpu-frame-plan-sequence"],
      framePlanFingerprints: manifest.completed.flatMap((entry) => entry.producer.frameLane === "gpu" ? entry.producer.framePlanFingerprints : []),
      finalReceiptInputHashes,
      warningUnion: warnings,
      warningsOmitted
    };
  }
  return { ...first, warningUnion: warnings, warningsOmitted };
}
