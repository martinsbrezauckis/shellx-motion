/** Read-only inspection and atomic COW receipt publication for typed shape geometry. */
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionLayer } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineShapeGeometryCommand,
  readTimelineShapeGeometryIntent,
  type TimelineShapeGeometryIntent,
} from "./timeline-shape-geometry.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

interface ShapeGeometryMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "replaced" | "updated" | "inserted" | "moved" | "deleted" | "migrated" | "dash-set" | "dash-removed";
  changedPaths: string[];
  index?: number;
  range?: { startIndex: number; endIndexExclusive: number };
  oldDash?: unknown;
  newDash?: unknown;
  migration?: {
    from: "legacy-path";
    legacyShape: "path" | "freeform";
    to: "path";
    resolvedContour: { viewBox: unknown; closed: boolean; vertices: unknown };
  };
}

interface ShapeGeometryInspection {
  layerId: string;
  source: "v1" | "legacy";
  geometry: unknown;
  strokeDash: unknown;
  resolved: unknown;
}

/** Public-Core functions, injected only by leaf tests until Core's owned export join lands. */
export interface TimelineShapeGeometryAuthoringCore {
  inspectMotionShapeGeometry(motion: MotionDocument, input: { layerId: string }): ShapeGeometryInspection;
  replaceMotionShapeGeometry(motion: MotionDocument, input: { layerId: string; geometry: unknown }): ShapeGeometryMutation;
  updateMotionShapeGeometryPoint(motion: MotionDocument, input: { layerId: string; index: number; point: { x: number; y: number } }): ShapeGeometryMutation;
  insertMotionShapeGeometryPoint(motion: MotionDocument, input: { layerId: string; index: number; point: { x: number; y: number } }): ShapeGeometryMutation;
  moveMotionShapeGeometryPoint(motion: MotionDocument, input: { layerId: string; fromIndex: number; toIndex: number }): ShapeGeometryMutation;
  deleteMotionShapeGeometryPointRange(motion: MotionDocument, input: { layerId: string; startIndex: number; endIndexExclusive: number }): ShapeGeometryMutation;
  updateMotionShapeGeometryArc(motion: MotionDocument, input: { layerId: string; center?: { x: number; y: number }; radius?: number; innerRadius?: number; startAngleDeg?: number; sweepAngleDeg?: number }): ShapeGeometryMutation;
  replaceMotionShapeGeometryPathData(motion: MotionDocument, input: { layerId: string; data: string }): ShapeGeometryMutation;
  migrateLegacyMotionShapeGeometry(motion: MotionDocument, input: { layerId: string }): ShapeGeometryMutation;
  setMotionShapeGeometryDash(motion: MotionDocument, input: { layerId: string; strokeDasharray: readonly number[]; strokeDashoffset?: number }): ShapeGeometryMutation;
  removeMotionShapeGeometryDash(motion: MotionDocument, input: { layerId: string }): ShapeGeometryMutation;
}

export interface TimelineShapeGeometryAuthoringServices extends TimelinePackageEditServices {
  /** Test-only seam; production reads the same named functions from the Core public barrel. */
  shapeGeometryAuthoring?: TimelineShapeGeometryAuthoringCore;
}

export async function dispatchTimelineShapeGeometryAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineShapeGeometryAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineShapeGeometryCommand(command)) return null;
  const parsed = readTimelineShapeGeometryIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, args, services);
  const common = readTimelineCommonEditArgs(command as MotionDebugCommand, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitMutation(command, parsed.intent, common, services);
}

async function inspect(
  command: string,
  intent: Extract<TimelineShapeGeometryIntent, { kind: "inspect" }>,
  args: unknown,
  services: TimelineShapeGeometryAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = readPackageRoot(args);
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!services.packageLoader) return capabilityUnavailable("Timeline shape geometry inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = geometryCore(services, "inspectMotionShapeGeometry")(pkg.motion, { layerId: intent.layerId });
    return {
      ok: true,
      visibleState: {
        panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id,
        layerId: inspection.layerId, source: inspection.source, geometry: inspection.geometry, resolved: inspection.resolved,
      },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) {
    return commandFailure("timeline_shape_geometry_inspect_failed", error);
  }
}

function commitMutation(
  command: string,
  intent: Exclude<TimelineShapeGeometryIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineShapeGeometryAuthoringServices,
): Promise<MotionDebugResult> {
  const receiptStem = `timeline-shape-geometry-${intent.kind}`;
  return commitAtomicTimelineMutation<ShapeGeometryMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: receiptStem,
    receiptFileName: `${receiptStem}.receipt.json`,
    invalidCode: "timeline_shape_geometry_invalid",
    failureCode: "timeline_shape_geometry_failed",
    services,
    mutate: (pkg) => mutateGeometry(pkg.motion, intent, services),
    outputFacts: mutationFacts,
    resultFacts: mutationFacts,
    visibleFacts: (mutation) => ({
      layerId: mutation.layerId,
      action: mutation.action,
      changedPaths: mutation.changedPaths,
      ...(mutation.range ? { range: mutation.range, rangeSemantics: "[startIndex, endIndexExclusive)" } : {}),
      ...(mutation.migration ? { migration: mutation.migration } : {}),
      ...(mutation.action === "dash-set" || mutation.action === "dash-removed" ? { oldDash: mutation.oldDash ?? null, newDash: mutation.newDash ?? null } : {}),
    }),
  });
}

function mutateGeometry(
  motion: MotionDocument,
  intent: Exclude<TimelineShapeGeometryIntent, { kind: "inspect" }>,
  services: TimelineShapeGeometryAuthoringServices,
): ShapeGeometryMutation {
  if (intent.kind === "replace") { const { kind: _kind, ...input } = intent; return geometryCore(services, "replaceMotionShapeGeometry")(motion, input); }
  if (intent.kind === "point-update") { const { kind: _kind, ...input } = intent; return geometryCore(services, "updateMotionShapeGeometryPoint")(motion, input); }
  if (intent.kind === "point-insert") { const { kind: _kind, ...input } = intent; return geometryCore(services, "insertMotionShapeGeometryPoint")(motion, input); }
  if (intent.kind === "point-move") { const { kind: _kind, ...input } = intent; return geometryCore(services, "moveMotionShapeGeometryPoint")(motion, input); }
  if (intent.kind === "point-range-delete") { const { kind: _kind, ...input } = intent; return geometryCore(services, "deleteMotionShapeGeometryPointRange")(motion, input); }
  if (intent.kind === "arc-update") { const { kind: _kind, ...input } = intent; return geometryCore(services, "updateMotionShapeGeometryArc")(motion, input); }
  if (intent.kind === "path-replace") { const { kind: _kind, ...input } = intent; return geometryCore(services, "replaceMotionShapeGeometryPathData")(motion, input); }
  if (intent.kind === "dash-set") { const { kind: _kind, ...input } = intent; return geometryCore(services, "setMotionShapeGeometryDash")(motion, input); }
  if (intent.kind === "dash-remove") { const { kind: _kind, ...input } = intent; return geometryCore(services, "removeMotionShapeGeometryDash")(motion, input); }
  const { kind: _kind, ...input } = intent;
  return geometryCore(services, "migrateLegacyMotionShapeGeometry")(motion, input);
}

function mutationFacts(mutation: ShapeGeometryMutation): Record<string, unknown> {
  return {
    ...timelineMutationFacts(mutation),
    ...(mutation.range ? { rangeSemantics: "[startIndex, endIndexExclusive)" } : {}),
  };
}

function geometryCore<K extends keyof TimelineShapeGeometryAuthoringCore>(
  services: TimelineShapeGeometryAuthoringServices,
  operation: K,
): TimelineShapeGeometryAuthoringCore[K] {
  const candidate = (services.shapeGeometryAuthoring ?? Core as unknown as TimelineShapeGeometryAuthoringCore)[operation];
  if (typeof candidate !== "function") throw new Error(`Core shape geometry authoring export ${operation} is unavailable.`);
  return candidate;
}

function readPackageRoot(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, "packageRoot");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.trim().length > 0 ? descriptor.value : null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
