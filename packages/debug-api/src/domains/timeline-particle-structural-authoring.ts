/** Bounded particle-structure inspection and COW adapter; scalar emitter values remain rich-control-owned. */
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionLayer, MotionParticleAnalyticTrail, MotionParticleEmitterOrigin, MotionParticleFieldV2Source, MotionParticleShading } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineParticleStructuralCommand,
  readTimelineParticleStructuralIntent,
  type TimelineParticleStructuralIntent,
} from "./timeline-particle-structural.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

interface ParticleStructuralInspection {
  layerId: string;
  field: unknown;
  origins: unknown;
  trail: unknown;
  shading: unknown;
  limits: unknown;
}

interface ParticleStructuralMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: string;
  changedPaths: string[];
  index?: number;
}

/** Test seam for leaf-level operation routing; production resolves the Core barrel export. */
export interface TimelineParticleStructuralCore {
  inspectMotionParticleStructure(motion: MotionDocument, input: { layerId: string }): ParticleStructuralInspection;
  insertMotionParticleFieldSource(motion: MotionDocument, input: { layerId: string; index: number; source: MotionParticleFieldV2Source }): ParticleStructuralMutation;
  replaceMotionParticleFieldSource(motion: MotionDocument, input: { layerId: string; index: number; source: MotionParticleFieldV2Source }): ParticleStructuralMutation;
  moveMotionParticleFieldSource(motion: MotionDocument, input: { layerId: string; fromIndex: number; toIndex: number }): ParticleStructuralMutation;
  deleteMotionParticleFieldSource(motion: MotionDocument, input: { layerId: string; index: number }): ParticleStructuralMutation;
  insertMotionParticleOrigin(motion: MotionDocument, input: { layerId: string; index: number; origin: MotionParticleEmitterOrigin }): ParticleStructuralMutation;
  replaceMotionParticleOrigin(motion: MotionDocument, input: { layerId: string; index: number; origin: MotionParticleEmitterOrigin }): ParticleStructuralMutation;
  moveMotionParticleOrigin(motion: MotionDocument, input: { layerId: string; fromIndex: number; toIndex: number }): ParticleStructuralMutation;
  deleteMotionParticleOrigin(motion: MotionDocument, input: { layerId: string; index: number }): ParticleStructuralMutation;
  updateMotionParticleCollisionAxis(motion: MotionDocument, input: { layerId: string; index: number; axis: "x" | "y" }): ParticleStructuralMutation;
  addMotionParticleAnalyticTrail(motion: MotionDocument, input: { layerId: string; trail: MotionParticleAnalyticTrail }): ParticleStructuralMutation;
  replaceMotionParticleAnalyticTrail(motion: MotionDocument, input: { layerId: string; trail: MotionParticleAnalyticTrail }): ParticleStructuralMutation;
  removeMotionParticleAnalyticTrail(motion: MotionDocument, input: { layerId: string }): ParticleStructuralMutation;
  addMotionParticleShading(motion: MotionDocument, input: { layerId: string; shading: MotionParticleShading }): ParticleStructuralMutation;
  replaceMotionParticleShading(motion: MotionDocument, input: { layerId: string; shading: MotionParticleShading }): ParticleStructuralMutation;
  removeMotionParticleShading(motion: MotionDocument, input: { layerId: string }): ParticleStructuralMutation;
}

export interface TimelineParticleStructuralAuthoringServices extends TimelinePackageEditServices {
  particleStructural?: TimelineParticleStructuralCore;
}

export async function dispatchTimelineParticleStructuralAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineParticleStructuralAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineParticleStructuralCommand(command)) return null;
  const parsed = readTimelineParticleStructuralIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, args, services);
  const common = readTimelineCommonEditArgs(command as MotionDebugCommand, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitMutation(command, parsed.intent, common, services);
}

/** Exposed only for leaf tests: maps strict intent to the one canonical Core structural operation. */
export function applyTimelineParticleStructuralIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineParticleStructuralIntent, { kind: "inspect" }>,
  services: TimelineParticleStructuralAuthoringServices,
): ParticleStructuralMutation {
  const core = particleCore(services);
  if (intent.kind === "source-insert") { const { kind: _kind, ...input } = intent; return core.insertMotionParticleFieldSource(motion, input); }
  if (intent.kind === "source-replace") { const { kind: _kind, ...input } = intent; return core.replaceMotionParticleFieldSource(motion, input); }
  if (intent.kind === "source-move") { const { kind: _kind, ...input } = intent; return core.moveMotionParticleFieldSource(motion, input); }
  if (intent.kind === "source-delete") { const { kind: _kind, ...input } = intent; return core.deleteMotionParticleFieldSource(motion, input); }
  if (intent.kind === "origin-insert") { const { kind: _kind, ...input } = intent; return core.insertMotionParticleOrigin(motion, input); }
  if (intent.kind === "origin-replace") { const { kind: _kind, ...input } = intent; return core.replaceMotionParticleOrigin(motion, input); }
  if (intent.kind === "origin-move") { const { kind: _kind, ...input } = intent; return core.moveMotionParticleOrigin(motion, input); }
  if (intent.kind === "origin-delete") { const { kind: _kind, ...input } = intent; return core.deleteMotionParticleOrigin(motion, input); }
  if (intent.kind === "collision-axis-update") { const { kind: _kind, ...input } = intent; return core.updateMotionParticleCollisionAxis(motion, input); }
  if (intent.kind === "trail-add") { const { kind: _kind, ...input } = intent; return core.addMotionParticleAnalyticTrail(motion, input); }
  if (intent.kind === "trail-replace") { const { kind: _kind, ...input } = intent; return core.replaceMotionParticleAnalyticTrail(motion, input); }
  if (intent.kind === "trail-remove") { const { kind: _kind, ...input } = intent; return core.removeMotionParticleAnalyticTrail(motion, input); }
  if (intent.kind === "shading-add") { const { kind: _kind, ...input } = intent; return core.addMotionParticleShading(motion, input); }
  if (intent.kind === "shading-replace") { const { kind: _kind, ...input } = intent; return core.replaceMotionParticleShading(motion, input); }
  const { kind: _kind, ...input } = intent;
  return core.removeMotionParticleShading(motion, input);
}

async function inspect(
  command: string,
  intent: Extract<TimelineParticleStructuralIntent, { kind: "inspect" }>,
  args: unknown,
  services: TimelineParticleStructuralAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = readPackageRoot(args);
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!services.packageLoader) return capabilityUnavailable("Timeline particle structural inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = particleCore(services).inspectMotionParticleStructure(pkg.motion, { layerId: intent.layerId });
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) {
    return commandFailure("timeline_particle_structural_inspect_failed", error);
  }
}

function commitMutation(
  command: string,
  intent: Exclude<TimelineParticleStructuralIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineParticleStructuralAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-particle-structural-${intent.kind}`;
  return commitAtomicTimelineMutation<ParticleStructuralMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_particle_structural_invalid",
    failureCode: "timeline_particle_structural_failed",
    services,
    mutate: (pkg) => applyTimelineParticleStructuralIntent(pkg.motion, intent, services),
    outputFacts: particleMutationFacts,
    resultFacts: particleMutationFacts,
    visibleFacts: particleMutationFacts,
  });
}

function particleMutationFacts(mutation: ParticleStructuralMutation): Record<string, unknown> {
  return { ...timelineMutationFacts(mutation), ...orderFacts(mutation) };
}

function orderFacts(mutation: ParticleStructuralMutation): Record<string, unknown> {
  if (mutation.action === "source-moved" || mutation.action === "origin-moved") {
    return { orderSemantics: "toIndex is the final ordered position after removal and reinsertion." };
  }
  if (mutation.action === "source-inserted" || mutation.action === "origin-inserted") {
    return { orderSemantics: "index is the insertion position in the current ordered record list." };
  }
  return {};
}

function particleCore(services: TimelineParticleStructuralAuthoringServices): TimelineParticleStructuralCore {
  const candidate = (services.particleStructural ?? Core as unknown as TimelineParticleStructuralCore);
  if (typeof candidate.inspectMotionParticleStructure !== "function") throw new Error("Core particle structural export inspectMotionParticleStructure is unavailable.");
  return candidate;
}

function readPackageRoot(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, "packageRoot");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.trim().length > 0 ? descriptor.value : null;
}

function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function capabilityUnavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function commandFailure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
