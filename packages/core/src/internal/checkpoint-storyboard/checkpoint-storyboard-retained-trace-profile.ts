/** Private C6B7a admission and pure retained-trace plan over one narrow C4C subset. */

import { canonicalJsonSha256 } from "../../canonical-json";
import { compileMotionParametricTracePlan } from "../../motion-parametric-trace-plan";
import type { MotionParametricTraceDescriptor, MotionParametricTracePlan } from "../../motion-parametric-trace-types";
import { readMotionDocument, readPackageManifest } from "../../package";
import type { MotionDocument, PackageManifest } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records";
import { exactArray, exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-data";
import type { CheckpointObjectState, CheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-types";
import {
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_SCHEMA,
  type CheckpointStoryboardRetainedTraceProfilePlan,
  type CheckpointStoryboardRetainedTraceProfileRequest,
} from "./checkpoint-storyboard-retained-trace-profile-types";

type RetainedTraceStoryboard = CheckpointStoryboard & {
  readonly objectCatalog: readonly { readonly objectId: string; readonly rootShapeKind: "rect"; readonly propertyMask: readonly ["opacity"]; readonly creation?: never }[];
  readonly checkpoints: readonly { readonly id: string; readonly atUs: number; readonly objects: readonly [CheckpointObjectState] }[];
  readonly edges: readonly { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string; readonly lifecycle: readonly [{ readonly kind: "preserve"; readonly objectId: string }]; readonly recipeIds: readonly [string] }[];
  readonly recipes: readonly {
    readonly id: string;
    readonly sha256: string;
    readonly revision: number;
    readonly recipeId: string;
    readonly exactBaseRequirements: readonly [];
    readonly intent: { readonly kind: "parametric-trace"; readonly outputObjectId: string; readonly trace: MotionParametricTraceDescriptor };
  }[];
};

const FORBIDDEN_MOTION_AUTHORITIES = [
  "tracks", "relationships", "behaviors", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation", "audio",
] as const;
const FORBIDDEN_LAYER_AUTHORITIES = [
  "childLayerIds", "trackId", "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority",
  "timeRemap", "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization", "depth", "matte", "mask", "keying",
  "effects", "effectModule", "geometry", "geometryKeyframes", "morph", "source", "src", "assetId", "assetRef", "includeAudio",
  "volume", "pan", "muted", "fadeInMs", "fadeOutMs", "fadeCurve", "normalizeLoudness", "ducking", "fit", "crop", "allowedOrigins",
  "gradient", "pathReveal", "emitter", "pointCloud", "shader", "scene3d", "environment",
] as const;
const PROFILE_PAYLOAD = freeze({
  schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_SCHEMA,
  requiredCapability: "renderer.gpu" as const,
  rootShapeKind: "rect" as const,
  checkpointPropertyMask: ["opacity"] as ["opacity"],
  lifecycle: "preserve" as const,
  drawerCount: 1 as const,
  driverKind: "parametric-graph" as const,
  retention: "full-clip" as const,
  outputMode: "line" as const,
  signals: "constant" as const,
  caps: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS,
});

/** Base-independent C6B7 admission used by the dedicated retained-trace resolver partition. */
export function admitCheckpointStoryboardRetainedTraceRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value) as RetainedTraceStoryboard;
  assertStaticProfile(storyboard);
  return storyboard;
}

/** Shared C6 snapshotting rejects accessors before the profile reads semantic data. */
export function readCheckpointStoryboardRetainedTraceProfileRequest(value: unknown): CheckpointStoryboardRetainedTraceProfileRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base", "objectLayerBindings"], [], "CheckpointStoryboard retained-trace profile request");
  if (root.schema !== CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA) throw new Error(`CheckpointStoryboard retained-trace profile request.schema must equal ${CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA}.`);
  const storyboard = readCheckpointStoryboard(root.storyboard) as RetainedTraceStoryboard;
  const base = readBase(root.base);
  const entries = exactArray(root.objectLayerBindings, "CheckpointStoryboard retained-trace profile objectLayerBindings", 1, 1);
  const entry = exactRecord(entries[0], ["objectId", "layerId"], [], "CheckpointStoryboard retained-trace profile objectLayerBindings[0]");
  const objectId = safeId(entry.objectId, "CheckpointStoryboard retained-trace profile objectLayerBindings[0].objectId");
  const layerId = safeId(entry.layerId, "CheckpointStoryboard retained-trace profile objectLayerBindings[0].layerId");
  if (objectId !== storyboard.objectCatalog[0]?.objectId || objectId !== layerId) throw new Error("CheckpointStoryboard retained-trace profile requires one exact same-ID object/layer binding.");
  return freeze({ schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA, storyboard, base, objectLayerBindings: freeze([freeze({ objectId, layerId })]) as CheckpointStoryboardRetainedTraceProfileRequest["objectLayerBindings"] });
}

/** Compiles one immutable C4C retained-window plan. It neither materializes nor renders the trace. */
export function compileCheckpointStoryboardRetainedTraceProfilePlan(value: unknown): CheckpointStoryboardRetainedTraceProfilePlan {
  const request = readCheckpointStoryboardRetainedTraceProfileRequest(value);
  const storyboard = request.storyboard as RetainedTraceStoryboard;
  const profile = assertStaticProfile(storyboard);
  const [from, to] = storyboard.checkpoints;
  const durationUs = request.base.motion.durationMs * 1_000;
  if (!Number.isSafeInteger(durationUs) || to!.atUs !== durationUs) throw new Error("CheckpointStoryboard retained-trace profile requires its final checkpoint at the exact document end.");
  const layer = assertBase(request.base.motion, request.objectLayerBindings[0]!.layerId);
  const staticOpacity = assertStaticOpacity(layer, from!.objects[0]!, to!.objects[0]!);
  const trace = profile.recipe.intent.trace;
  assertTraceScope(trace, durationUs);
  const compiled = compileMotionParametricTracePlan(trace);
  if (!compiled.ok) throw new Error(`CheckpointStoryboard retained-trace profile C4C planning refused: ${compiled.message}`);
  assertTracePlan(compiled.plan);
  const c6a = compileCheckpointStoryboardPlan(storyboard);
  const lowererProfile = freeze({ ...PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_PLAN_SCHEMA,
    storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, fingerprint: c6a.fingerprint }),
    base: freeze({
      package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }),
      manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }),
      canonicalMotion: freeze({ id: request.base.motion.id, sha256: canonicalJsonSha256(request.base.motion) }),
      persistedMotion: freeze({ id: request.base.motion.id, sha256: request.base.persistedMotionSha256 }),
    }),
    lowererProfile,
    objectLayerBinding: freeze({ objectId: profile.objectId, layerId: profile.objectId, layerIndex: 0 as const, rootShapeKind: "rect" as const, staticOpacity }),
    projection: freeze({
      edge: freeze({ id: profile.edge.id, fromCheckpointId: profile.edge.fromCheckpointId, toCheckpointId: profile.edge.toCheckpointId }),
      recipe: freeze({ id: profile.recipe.id, sha256: profile.recipe.sha256, revision: profile.recipe.revision, recipeId: profile.recipe.recipeId }),
      outputObjectId: profile.objectId,
      trace: compiled.plan,
    }),
    budget: freeze({
      objects: 1 as const,
      checkpoints: 2 as const,
      edges: 1 as const,
      recipes: 1 as const,
      scheduleSamples: compiled.plan.schedule.length,
      vertices: compiled.plan.budget.maxVertices,
      compileWorkUnits: compiled.plan.budget.compileWorkUnits,
      storageBytes: compiled.plan.budget.storageBytes,
      peakBytes: compiled.plan.budget.peakBytes,
    }),
    evidence: freeze({
      noPackageIO: true as const,
      noPackageWrites: true as const,
      noCOW: true as const,
      noReceipt: true as const,
      noPublicSurface: true as const,
      noRenderer: true as const,
      noGpuExecutionWrapper: true as const,
    }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function readBase(value: unknown): CheckpointStoryboardRetainedTraceProfileRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard retained-trace profile base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard retained-trace profile base.packageId");
  assertDocument("manifest", "packageManifest", record.manifest);
  assertDocument("Motion document", "motion", record.motion);
  const manifest = readPackageManifest(record.manifest), motion = readMotionDocument(record.motion);
  if (manifest.id !== packageId || !cleanMotionPath(manifest.motion)) throw new Error("CheckpointStoryboard retained-trace profile base must use an exact package-relative Motion manifest.");
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000) throw new Error("CheckpointStoryboard retained-trace profile base.motion.durationMs must be a bounded positive safe integer.");
  return freeze({ packageId, manifest: freeze(manifest) as PackageManifest, motion: freeze(motion), persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard retained-trace profile base.persistedMotionSha256") });
}

function assertStaticProfile(storyboard: RetainedTraceStoryboard) {
  if (storyboard.capabilityRequirements.length !== 1 || storyboard.capabilityRequirements[0] !== "renderer.gpu") throw new Error("CheckpointStoryboard retained-trace profile requires exactly renderer.gpu.");
  if (storyboard.objectCatalog.length !== 1 || storyboard.checkpoints.length !== 2 || storyboard.edges.length !== 1 || storyboard.recipes.length !== 1) throw new Error("CheckpointStoryboard retained-trace profile requires exactly one object, two checkpoints, one edge, and one recipe.");
  const catalog = storyboard.objectCatalog[0]!, [from, to] = storyboard.checkpoints, edge = storyboard.edges[0]!, recipe = storyboard.recipes[0]!;
  if (catalog.rootShapeKind !== "rect" || catalog.creation || catalog.propertyMask.length !== 1 || catalog.propertyMask[0] !== "opacity" || from!.atUs !== 0 || edge.fromCheckpointId !== from!.id || edge.toCheckpointId !== to!.id || edge.lifecycle.length !== 1 || edge.lifecycle[0]!.kind !== "preserve" || edge.lifecycle[0]!.objectId !== catalog.objectId || edge.recipeIds.length !== 1 || edge.recipeIds[0] !== recipe.recipeId || recipe.exactBaseRequirements.length !== 0) throw new Error("CheckpointStoryboard retained-trace profile requires one opacity-only rect object preserved from document zero through one closed trace edge.");
  if (from!.objects.length !== 1 || to!.objects.length !== 1 || from!.objects[0]!.state !== "present" || to!.objects[0]!.state !== "present" || from!.objects[0]!.objectId !== catalog.objectId || to!.objects[0]!.objectId !== catalog.objectId || recipe.intent.kind !== "parametric-trace" || recipe.intent.outputObjectId !== catalog.objectId) throw new Error("CheckpointStoryboard retained-trace profile requires one present rect state and one same-object parametric-trace recipe.");
  if (checkpointOpacity(from!.objects[0]!, "start") !== checkpointOpacity(to!.objects[0]!, "end")) throw new Error("CheckpointStoryboard retained-trace profile requires constant checkpoint opacity.");
  assertTraceProfile(recipe.intent.trace);
  return { objectId: catalog.objectId, edge, recipe };
}

function assertBase(motion: MotionDocument, layerId: string): Record<string, unknown> {
  if (motion.assets.length !== 0 || motion.layers.length !== 1) throw new Error("CheckpointStoryboard retained-trace profile requires an asset-free one-layer base.");
  for (const field of FORBIDDEN_MOTION_AUTHORITIES) if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard retained-trace profile refuses existing ${field} authority.`);
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) throw new Error("CheckpointStoryboard retained-trace profile refuses trace authority.");
  const layer = motion.layers[0]! as unknown as Record<string, unknown>;
  if (layer.id !== layerId || layer.type !== "shape" || layer.shape !== "rect" || layer.visible === false || layer.locked === true || layer.startMs !== 0 || layer.durationMs !== motion.durationMs) throw new Error("CheckpointStoryboard retained-trace profile requires one visible unlocked root-owned rect layer spanning the document.");
  if (FORBIDDEN_LAYER_AUTHORITIES.some((field) => Object.hasOwn(layer, field))) throw new Error("CheckpointStoryboard retained-trace profile refuses existing transform, timing, geometry, resource, or effect authority.");
  return layer;
}

function assertStaticOpacity(layer: Record<string, unknown>, from: CheckpointObjectState, to: CheckpointObjectState): number {
  const opacity = layer.opacity;
  const transform = layer.transform;
  if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || (typeof transform === "object" && transform !== null && Object.hasOwn(transform, "opacity"))) throw new Error("CheckpointStoryboard retained-trace profile requires one explicit static layer opacity without transform opacity.");
  const start = checkpointOpacity(from, "start"), end = checkpointOpacity(to, "end");
  if (start !== end || opacity !== start) throw new Error("CheckpointStoryboard retained-trace profile requires equal checkpoint and static base opacity.");
  return opacity;
}

function checkpointOpacity(state: CheckpointObjectState, label: string): number {
  if (state.state !== "present" || state.properties.length !== 1 || state.properties[0]?.property !== "opacity") throw new Error(`CheckpointStoryboard retained-trace profile requires one present ${label} opacity state.`);
  return state.properties[0]!.value;
}

function assertTraceScope(trace: MotionParametricTraceDescriptor, durationUs: number): void {
  if (trace.clip.durationUs !== durationUs) throw new Error("CheckpointStoryboard retained-trace profile requires the C4C clip to equal the exact document duration.");
}

function assertTraceProfile(trace: MotionParametricTraceDescriptor): void {
  const caps = CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS;
  const sampleCount = traceSampleCount(trace);
  if (sampleCount < 2 || sampleCount > caps.maxSamples) throw new Error(`CheckpointStoryboard retained-trace profile requires 2..${caps.maxSamples} schedule samples.`);
  if (trace.drawers.length !== 1) throw new Error("CheckpointStoryboard retained-trace profile requires exactly one drawer.");
  const drawer = trace.drawers[0]!;
  if (drawer.driver.kind !== "parametric-graph") throw new Error("CheckpointStoryboard retained-trace profile requires a self-contained parametric-graph driver.");
  if (drawer.retention.kind !== "full-clip" || drawer.retention.maxSamples !== sampleCount) throw new Error("CheckpointStoryboard retained-trace profile requires full-clip retention with its exact schedule sample count.");
  if (drawer.output.mode !== "line" || !constant(drawer.output.width) || !constant(drawer.output.colour) || !constant(drawer.output.opacity) || drawer.output.width.from <= 0 || drawer.output.opacity.from <= 0) throw new Error("CheckpointStoryboard retained-trace profile requires positive constant line width/opacity and constant grayscale output.");
  if (!sameCaps(trace.caps.perDrawer, caps) || !sameCaps(trace.caps.aggregate, caps)) throw new Error("CheckpointStoryboard retained-trace profile requires its fixed per-drawer and aggregate C4C caps.");
}

function assertTracePlan(plan: MotionParametricTracePlan): void {
  const caps = CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS;
  if (plan.schedule.length < 2 || plan.schedule.length > caps.maxSamples || plan.drawers.length !== 1 || plan.budget.samples !== plan.schedule.length || !sameCaps(plan.budget.limits.perDrawer, caps) || !sameCaps(plan.budget.limits.aggregate, caps) || plan.budget.maxVertices > caps.maxVertices || plan.budget.maxWorkUnits > caps.maxWorkUnits || plan.budget.compileWorkUnits > caps.maxWorkUnits || plan.budget.maxFrameBytes > caps.maxBytes || plan.budget.storageBytes > caps.maxBytes || plan.budget.peakBytes > caps.maxBytes) throw new Error("CheckpointStoryboard retained-trace profile C4C plan exceeds its fixed B7a budget.");
  const drawer = plan.drawers[0]!;
  if (drawer.driver.kind !== "parametric-graph" || drawer.retention.kind !== "full-clip" || drawer.retention.maxSamples !== plan.schedule.length || drawer.output.mode !== "line" || !constant(drawer.output.width) || !constant(drawer.output.colour) || !constant(drawer.output.opacity) || drawer.output.width.from <= 0 || drawer.output.opacity.from <= 0 || drawer.samples.length !== plan.schedule.length || drawer.windows.length !== plan.schedule.length || drawer.windows.some((window, index) => window.firstSampleIndex !== 0 || window.sampleCount !== index + 1 || window.vertexCount !== index + 1) || drawer.budget.samples !== plan.schedule.length || drawer.budget.maxVertices > caps.maxVertices || drawer.budget.maxWorkUnits > caps.maxWorkUnits || drawer.budget.compileWorkUnits > caps.maxWorkUnits || drawer.budget.maxFrameBytes > caps.maxBytes || drawer.budget.dataBytes > caps.maxBytes || drawer.budget.peakBytes > caps.maxBytes) throw new Error("CheckpointStoryboard retained-trace profile C4C drawer plan is widened or exceeds its fixed B7a budget.");
}

function traceSampleCount(trace: MotionParametricTraceDescriptor): number {
  const { durationUs, sampleIntervalUs } = trace.clip;
  return Math.floor(durationUs / sampleIntervalUs) + 1 + (durationUs % sampleIntervalUs === 0 ? 0 : 1);
}

function constant(value: { readonly source: string; readonly from: number; readonly to: number }): boolean {
  return value.source === "constant" && value.from === value.to;
}

function sameCaps(value: { readonly maxSamples: number; readonly maxVertices: number; readonly maxWorkUnits: number; readonly maxBytes: number }, expected: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS): boolean {
  return value.maxSamples === expected.maxSamples && value.maxVertices === expected.maxVertices && value.maxWorkUnits === expected.maxWorkUnits && value.maxBytes === expected.maxBytes;
}

function assertDocument(label: string, schema: "packageManifest" | "motion", value: unknown): void {
  const result = validateDocumentSync(loadSchemaSync(schema), value);
  if (!result.ok) throw new Error(`CheckpointStoryboard retained-trace profile ${label} is invalid at ${result.errors[0]!.path || "/"}: ${result.errors[0]!.message}`);
}

function cleanMotionPath(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.normalize("NFC") && !/[\u0000-\u001F\u007F-\u009F]/u.test(value) && !value.split("/").some((part) => part === "." || part === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}
