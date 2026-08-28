/** Closed B7 plan and Motion admission for the shipping-private retained-trace preview facade. */
import { canonicalJsonSha256 } from "../../canonical-json";
import { MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_SPEED, type MotionParametricTracePlan } from "../../motion-parametric-trace-types";
import { readMotionDocument } from "../../package";
import type { MotionDocument } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { exactArray, exactRecord, finite, freeze, safeId, safeUs, sha256, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import {
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_SCHEMA,
} from "./checkpoint-storyboard-retained-trace-profile-types";

export function readAdmittedInput(motionValue: unknown, planValue: unknown): { motion: MotionDocument; trace: MotionParametricTracePlan; documentFingerprint: string; retainedTracePlanFingerprint: string } {
  const motion = readExactMotionDocument(motionValue);
  const root = exactRecord(snapshotCheckpointStoryboardData(planValue), ["schema", "storyboard", "base", "lowererProfile", "objectLayerBinding", "projection", "budget", "evidence", "fingerprint"], [], "CheckpointStoryboard retained-trace preview plan");
  if (root.schema !== CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_PLAN_SCHEMA) throw new Error("CheckpointStoryboard retained-trace preview requires the exact C6B7a profile plan schema.");
  const retainedTracePlanFingerprint = sha256(root.fingerprint, "CheckpointStoryboard retained-trace preview plan.fingerprint");
  assertFingerprint(root, retainedTracePlanFingerprint, "CheckpointStoryboard retained-trace preview plan");
  assertStoryboard(root.storyboard);
  const base = assertBase(root.base, motion);
  assertLowererProfile(root.lowererProfile);
  const binding = assertBinding(root.objectLayerBinding, motion);
  const trace = assertProjection(root.projection, binding.objectId, motion.durationMs * 1_000);
  assertBudget(root.budget, trace);
  assertEvidence(root.evidence);
  if (base.documentFingerprint !== fingerprintMotion(motion)) throw new Error("CheckpointStoryboard retained-trace preview requires the exact canonical Motion document bound by the C6B7a plan.");
  return { motion, trace, documentFingerprint: base.documentFingerprint, retainedTracePlanFingerprint };
}

export function fingerprintMotion(motion: MotionDocument): string { return canonicalJsonSha256(snapshotCheckpointStoryboardData(motion)); }

function readExactMotionDocument(value: unknown): MotionDocument {
  const snapshot = snapshotCheckpointStoryboardData(value);
  const result = validateDocumentSync(loadSchemaSync("motion"), snapshot);
  if (!result.ok) throw new Error(`CheckpointStoryboard retained-trace preview Motion document is invalid at ${result.errors[0]!.path || "/"}: ${result.errors[0]!.message}`);
  const motion = freeze(readMotionDocument(snapshot));
  const durationUs = motion.durationMs * 1_000;
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000 || !Number.isSafeInteger(durationUs) || motion.assets.length !== 0 || motion.layers.length !== 1) throw new Error("CheckpointStoryboard retained-trace preview requires an asset-free one-layer Motion document with a bounded integer duration.");
  const layer = motion.layers[0] as unknown as Record<string, unknown>;
  if (typeof layer.id !== "string" || layer.type !== "shape" || layer.shape !== "rect" || layer.visible === false || layer.locked === true || layer.startMs !== 0 || layer.durationMs !== motion.durationMs) {
    throw new Error("CheckpointStoryboard retained-trace preview requires one visible unlocked root rect layer spanning the document.");
  }
  for (const key of ["tracks", "relationships", "behaviors", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation", "audio", "traces", "parametricTrace", "parametricTraces"] as const) {
    if (Object.hasOwn(motion, key)) throw new Error(`CheckpointStoryboard retained-trace preview refuses existing ${key} authority.`);
  }
  for (const key of ["childLayerIds", "trackId", "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority", "timeRemap", "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization", "depth", "matte", "mask", "keying", "effects", "effectModule", "geometry", "geometryKeyframes", "morph", "source", "src", "assetId", "assetRef", "includeAudio", "volume", "pan", "muted", "fadeInMs", "fadeOutMs", "fadeCurve", "normalizeLoudness", "ducking", "fit", "crop", "allowedOrigins", "gradient", "pathReveal", "emitter", "pointCloud", "shader", "scene3d", "environment"] as const) {
    if (Object.hasOwn(layer, key)) throw new Error(`CheckpointStoryboard retained-trace preview refuses existing layer ${key} authority.`);
  }
  return motion;
}

function assertStoryboard(value: unknown): void {
  const record = exactRecord(value, ["id", "sha256", "revision", "fingerprint"], [], "CheckpointStoryboard retained-trace preview plan.storyboard");
  safeId(record.id, "CheckpointStoryboard retained-trace preview plan.storyboard.id");
  sha256(record.sha256, "CheckpointStoryboard retained-trace preview plan.storyboard.sha256");
  sha256(record.fingerprint, "CheckpointStoryboard retained-trace preview plan.storyboard.fingerprint");
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error("CheckpointStoryboard retained-trace preview plan.storyboard.revision must be a positive safe integer.");
}

function assertBase(value: unknown, motion: MotionDocument): { documentFingerprint: string } {
  const base = exactRecord(value, ["package", "manifest", "canonicalMotion", "persistedMotion"], [], "CheckpointStoryboard retained-trace preview plan.base");
  const pkg = exactRecord(base.package, ["id", "motionPath"], [], "CheckpointStoryboard retained-trace preview plan.base.package");
  const manifest = exactRecord(base.manifest, ["id", "sha256"], [], "CheckpointStoryboard retained-trace preview plan.base.manifest");
  const canonicalMotion = exactRecord(base.canonicalMotion, ["id", "sha256"], [], "CheckpointStoryboard retained-trace preview plan.base.canonicalMotion");
  const persistedMotion = exactRecord(base.persistedMotion, ["id", "sha256"], [], "CheckpointStoryboard retained-trace preview plan.base.persistedMotion");
  const packageId = safeId(pkg.id, "CheckpointStoryboard retained-trace preview plan.base.package.id");
  if (typeof pkg.motionPath !== "string" || pkg.motionPath.length === 0) throw new Error("CheckpointStoryboard retained-trace preview plan.base.package.motionPath must be present.");
  if (safeId(manifest.id, "CheckpointStoryboard retained-trace preview plan.base.manifest.id") !== packageId) throw new Error("CheckpointStoryboard retained-trace preview plan base package and manifest identities must agree.");
  sha256(manifest.sha256, "CheckpointStoryboard retained-trace preview plan.base.manifest.sha256");
  if (safeId(canonicalMotion.id, "CheckpointStoryboard retained-trace preview plan.base.canonicalMotion.id") !== motion.id || safeId(persistedMotion.id, "CheckpointStoryboard retained-trace preview plan.base.persistedMotion.id") !== motion.id) throw new Error("CheckpointStoryboard retained-trace preview plan base Motion identity must match the supplied Motion document.");
  const documentFingerprint = sha256(canonicalMotion.sha256, "CheckpointStoryboard retained-trace preview plan.base.canonicalMotion.sha256");
  sha256(persistedMotion.sha256, "CheckpointStoryboard retained-trace preview plan.base.persistedMotion.sha256");
  return { documentFingerprint };
}

function assertLowererProfile(value: unknown): void {
  const profile = exactRecord(value, ["schema", "requiredCapability", "rootShapeKind", "checkpointPropertyMask", "lifecycle", "drawerCount", "driverKind", "retention", "outputMode", "signals", "caps", "fingerprint"], [], "CheckpointStoryboard retained-trace preview plan.lowererProfile");
  if (profile.schema !== CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_SCHEMA || profile.requiredCapability !== "renderer.gpu" || profile.rootShapeKind !== "rect" || profile.lifecycle !== "preserve" || profile.drawerCount !== 1 || profile.driverKind !== "parametric-graph" || profile.retention !== "full-clip" || profile.outputMode !== "line" || profile.signals !== "constant") {
    throw new Error("CheckpointStoryboard retained-trace preview requires the closed B7 renderer.gpu full-clip line profile.");
  }
  const mask = exactArray(profile.checkpointPropertyMask, "CheckpointStoryboard retained-trace preview plan.lowererProfile.checkpointPropertyMask", 1, 1);
  if (mask[0] !== "opacity") throw new Error("CheckpointStoryboard retained-trace preview requires the opacity-only B7 profile.");
  assertExactCaps(profile.caps, "CheckpointStoryboard retained-trace preview plan.lowererProfile.caps");
  const fingerprint = sha256(profile.fingerprint, "CheckpointStoryboard retained-trace preview plan.lowererProfile.fingerprint");
  assertFingerprint(profile, fingerprint, "CheckpointStoryboard retained-trace preview plan.lowererProfile");
}

function assertBinding(value: unknown, motion: MotionDocument): { objectId: string } {
  const binding = exactRecord(value, ["objectId", "layerId", "layerIndex", "rootShapeKind", "staticOpacity"], [], "CheckpointStoryboard retained-trace preview plan.objectLayerBinding");
  const objectId = safeId(binding.objectId, "CheckpointStoryboard retained-trace preview plan.objectLayerBinding.objectId");
  if (safeId(binding.layerId, "CheckpointStoryboard retained-trace preview plan.objectLayerBinding.layerId") !== objectId || binding.layerIndex !== 0 || binding.rootShapeKind !== "rect") throw new Error("CheckpointStoryboard retained-trace preview requires one same-ID root rect object/layer binding.");
  const opacity = finite(binding.staticOpacity, "CheckpointStoryboard retained-trace preview plan.objectLayerBinding.staticOpacity", 0, 1);
  const layer = motion.layers[0] as unknown as Record<string, unknown>;
  if (layer.id !== objectId || layer.opacity !== opacity || (typeof layer.transform === "object" && layer.transform !== null && Object.hasOwn(layer.transform, "opacity"))) throw new Error("CheckpointStoryboard retained-trace preview requires the exact bound static layer opacity.");
  return { objectId };
}

function assertProjection(value: unknown, objectId: string, durationUs: number): MotionParametricTracePlan {
  const projection = exactRecord(value, ["edge", "recipe", "outputObjectId", "trace"], [], "CheckpointStoryboard retained-trace preview plan.projection");
  const edge = exactRecord(projection.edge, ["id", "fromCheckpointId", "toCheckpointId"], [], "CheckpointStoryboard retained-trace preview plan.projection.edge");
  safeId(edge.id, "CheckpointStoryboard retained-trace preview plan.projection.edge.id"); safeId(edge.fromCheckpointId, "CheckpointStoryboard retained-trace preview plan.projection.edge.fromCheckpointId"); safeId(edge.toCheckpointId, "CheckpointStoryboard retained-trace preview plan.projection.edge.toCheckpointId");
  const recipe = exactRecord(projection.recipe, ["id", "sha256", "revision", "recipeId"], [], "CheckpointStoryboard retained-trace preview plan.projection.recipe");
  safeId(recipe.id, "CheckpointStoryboard retained-trace preview plan.projection.recipe.id"); safeId(recipe.recipeId, "CheckpointStoryboard retained-trace preview plan.projection.recipe.recipeId"); sha256(recipe.sha256, "CheckpointStoryboard retained-trace preview plan.projection.recipe.sha256");
  const revision = recipe.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || safeId(projection.outputObjectId, "CheckpointStoryboard retained-trace preview plan.projection.outputObjectId") !== objectId) throw new Error("CheckpointStoryboard retained-trace preview projection identity is invalid.");
  return readClosedTracePlan(projection.trace, durationUs);
}

function readClosedTracePlan(value: unknown, durationUs: number): MotionParametricTracePlan {
  const trace = exactRecord(value, ["schema", "sourceSha256", "schedule", "drawers", "budget", "evidence", "fingerprint"], [], "CheckpointStoryboard retained-trace preview plan.projection.trace");
  if (trace.schema !== "shellx-motion/private-parametric-trace-plan@1") throw new Error("CheckpointStoryboard retained-trace preview requires the exact compiled C4C plan schema.");
  sha256(trace.sourceSha256, "CheckpointStoryboard retained-trace preview trace.sourceSha256");
  const fingerprint = sha256(trace.fingerprint, "CheckpointStoryboard retained-trace preview trace.fingerprint");
  assertFingerprint(trace, fingerprint, "CheckpointStoryboard retained-trace preview trace");
  const schedule = exactArray(trace.schedule, "CheckpointStoryboard retained-trace preview trace.schedule", CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxSamples, 2)
    .map((atUs, index) => safeUs(atUs, `CheckpointStoryboard retained-trace preview trace.schedule[${index}]`));
  for (let index = 1; index < schedule.length; index += 1) {
    if (schedule[index]! <= schedule[index - 1]!) throw new Error("CheckpointStoryboard retained-trace preview trace.schedule must be strict ascending.");
  }
  if (schedule[0] !== 0 || schedule.at(-1) !== durationUs) throw new Error("CheckpointStoryboard retained-trace preview trace.schedule must include zero and the exact document endpoint.");
  const evidence = exactRecord(trace.evidence, ["scheduleSha256", "trigonometry", "noRenderer", "noPixelClaim"], [], "CheckpointStoryboard retained-trace preview trace.evidence");
  if (sha256(evidence.scheduleSha256, "CheckpointStoryboard retained-trace preview trace.evidence.scheduleSha256") !== canonicalJsonSha256(schedule) || !isTrigonometryEvidence(evidence.trigonometry) || evidence.noRenderer !== true || evidence.noPixelClaim !== true) throw new Error("CheckpointStoryboard retained-trace preview trace evidence is invalid.");
  const drawers = exactArray(trace.drawers, "CheckpointStoryboard retained-trace preview trace.drawers", 1, 1);
  const drawer = assertLineDrawer(drawers[0], schedule);
  assertTraceBudget(trace.budget, schedule.length, drawer);
  return freeze(trace) as unknown as MotionParametricTracePlan;
}

function isTrigonometryEvidence(value: unknown): boolean {
  return value === "none" || value === "quantized-radians@1" || value === "exact-modular-turns@1" || value === "mixed-quantized-radians-and-exact-modular-turns@1";
}

function assertLineDrawer(value: unknown, schedule: readonly number[]): { maxWorkUnits: number; maxFrameBytes: number; compileWorkUnits: number; dataBytes: number } {
  const drawer = exactRecord(value, ["id", "driver", "output", "retention", "signalDomain", "samples", "windows", "budget"], [], "CheckpointStoryboard retained-trace preview trace.drawer");
  safeId(drawer.id, "CheckpointStoryboard retained-trace preview trace.drawer.id");
  const driver = exactRecord(drawer.driver, ["kind", "sourceSha256"], [], "CheckpointStoryboard retained-trace preview trace.drawer.driver");
  if (driver.kind !== "parametric-graph") throw new Error("CheckpointStoryboard retained-trace preview requires a self-contained parametric-graph trace driver.");
  sha256(driver.sourceSha256, "CheckpointStoryboard retained-trace preview trace.drawer.driver.sourceSha256");
  const output = exactRecord(drawer.output, ["mode", "width", "colour", "opacity", "speedLimit"], [], "CheckpointStoryboard retained-trace preview trace.drawer.output");
  if (output.mode !== "line") throw new Error("CheckpointStoryboard retained-trace preview requires line-strip topology only.");
  assertConstantSignal(output.width, "width", 0, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, true);
  assertConstantSignal(output.colour, "colour", 0, 1, false);
  assertConstantSignal(output.opacity, "opacity", 0, 1, true);
  finite(output.speedLimit, "CheckpointStoryboard retained-trace preview trace.drawer.output.speedLimit", 0, MAX_MOTION_PARAMETRIC_TRACE_SPEED);
  const retention = exactRecord(drawer.retention, ["kind", "maxSamples"], [], "CheckpointStoryboard retained-trace preview trace.drawer.retention");
  if (retention.kind !== "full-clip" || retention.maxSamples !== schedule.length) throw new Error("CheckpointStoryboard retained-trace preview requires exact full-clip retention.");
  const domain = exactRecord(drawer.signalDomain, ["age", "speed", "drawer"], [], "CheckpointStoryboard retained-trace preview trace.drawer.signalDomain");
  if (!tuple01(domain.age) || !tuple01(domain.speed) || domain.drawer !== 0) throw new Error("CheckpointStoryboard retained-trace preview requires the one-drawer fixed signal domain.");
  const samples = exactArray(drawer.samples, "CheckpointStoryboard retained-trace preview trace.drawer.samples", schedule.length, schedule.length);
  const windows = exactArray(drawer.windows, "CheckpointStoryboard retained-trace preview trace.drawer.windows", schedule.length, schedule.length);
  let maxWorkUnits = 0, maxFrameBytes = 0, compileWindowWork = 0;
  for (let index = 0; index < schedule.length; index += 1) {
    const sample = exactRecord(samples[index], ["atUs", "position", "speed"], [], `CheckpointStoryboard retained-trace preview trace.drawer.samples[${index}]`);
    if (sample.atUs !== schedule[index]) throw new Error("CheckpointStoryboard retained-trace preview samples must match the exact schedule.");
    const position = exactRecord(sample.position, ["x", "y", "z"], [], `CheckpointStoryboard retained-trace preview trace.drawer.samples[${index}].position`);
    finite(position.x, "CheckpointStoryboard retained-trace preview trace sample x", -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE);
    finite(position.y, "CheckpointStoryboard retained-trace preview trace sample y", -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE);
    finite(position.z, "CheckpointStoryboard retained-trace preview trace sample z", -MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE);
    finite(sample.speed, "CheckpointStoryboard retained-trace preview trace sample speed", 0, 1);
    const window = exactRecord(windows[index], ["atUs", "firstSampleIndex", "sampleCount", "vertexCount", "workUnits", "bytes"], [], `CheckpointStoryboard retained-trace preview trace.drawer.windows[${index}]`);
    const count = index + 1;
    const workUnits = positiveSafeInteger(window.workUnits, `CheckpointStoryboard retained-trace preview trace.drawer.windows[${index}].workUnits`);
    const bytes = positiveSafeInteger(window.bytes, `CheckpointStoryboard retained-trace preview trace.drawer.windows[${index}].bytes`);
    if (window.atUs !== schedule[index] || window.firstSampleIndex !== 0 || window.sampleCount !== count || window.vertexCount !== count || bytes !== count * 56) throw new Error("CheckpointStoryboard retained-trace preview retained windows are widened or inconsistent.");
    maxWorkUnits = Math.max(maxWorkUnits, workUnits); maxFrameBytes = Math.max(maxFrameBytes, bytes); compileWindowWork += workUnits;
  }
  const budget = exactRecord(drawer.budget, ["samples", "maxVertices", "maxWorkUnits", "compileWorkUnits", "maxFrameBytes", "dataBytes", "peakBytes"], [], "CheckpointStoryboard retained-trace preview trace.drawer.budget");
  const budgetMaxWorkUnits = positiveSafeInteger(budget.maxWorkUnits, "CheckpointStoryboard retained-trace preview trace.drawer.budget.maxWorkUnits");
  const compileWorkUnits = positiveSafeInteger(budget.compileWorkUnits, "CheckpointStoryboard retained-trace preview trace.drawer.budget.compileWorkUnits");
  const budgetMaxFrameBytes = positiveSafeInteger(budget.maxFrameBytes, "CheckpointStoryboard retained-trace preview trace.drawer.budget.maxFrameBytes");
  const dataBytes = positiveSafeInteger(budget.dataBytes, "CheckpointStoryboard retained-trace preview trace.drawer.budget.dataBytes");
  const peakBytes = positiveSafeInteger(budget.peakBytes, "CheckpointStoryboard retained-trace preview trace.drawer.budget.peakBytes");
  if (budget.samples !== schedule.length || budget.maxVertices !== schedule.length || budgetMaxWorkUnits !== maxWorkUnits || budgetMaxFrameBytes !== maxFrameBytes || compileWorkUnits !== compileWindowWork + schedule.length || peakBytes !== dataBytes + maxFrameBytes) throw new Error("CheckpointStoryboard retained-trace preview trace drawer budget is inconsistent.");
  if (budgetMaxWorkUnits > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxWorkUnits || compileWorkUnits > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxWorkUnits || budgetMaxFrameBytes > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxBytes || dataBytes > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxBytes || peakBytes > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxBytes) throw new Error("CheckpointStoryboard retained-trace preview trace drawer exceeds its fixed B7 caps.");
  return { maxWorkUnits, maxFrameBytes, compileWorkUnits, dataBytes };
}

function assertTraceBudget(value: unknown, samples: number, drawer: { maxWorkUnits: number; maxFrameBytes: number; compileWorkUnits: number; dataBytes: number }): void {
  const budget = exactRecord(value, ["samples", "maxVertices", "maxWorkUnits", "compileWorkUnits", "maxFrameBytes", "storageBytes", "peakBytes", "limits"], [], "CheckpointStoryboard retained-trace preview trace.budget");
  const maxWorkUnits = positiveSafeInteger(budget.maxWorkUnits, "CheckpointStoryboard retained-trace preview trace.budget.maxWorkUnits");
  const compileWorkUnits = positiveSafeInteger(budget.compileWorkUnits, "CheckpointStoryboard retained-trace preview trace.budget.compileWorkUnits");
  const maxFrameBytes = positiveSafeInteger(budget.maxFrameBytes, "CheckpointStoryboard retained-trace preview trace.budget.maxFrameBytes");
  const storageBytes = positiveSafeInteger(budget.storageBytes, "CheckpointStoryboard retained-trace preview trace.budget.storageBytes");
  const peakBytes = positiveSafeInteger(budget.peakBytes, "CheckpointStoryboard retained-trace preview trace.budget.peakBytes");
  if (budget.samples !== samples || budget.maxVertices !== samples || maxWorkUnits !== drawer.maxWorkUnits || compileWorkUnits !== drawer.compileWorkUnits || maxFrameBytes !== drawer.maxFrameBytes || peakBytes !== storageBytes + drawer.maxFrameBytes) throw new Error("CheckpointStoryboard retained-trace preview trace aggregate budget is inconsistent.");
  const limits = exactRecord(budget.limits, ["perDrawer", "aggregate"], [], "CheckpointStoryboard retained-trace preview trace.budget.limits");
  assertExactCaps(limits.perDrawer, "CheckpointStoryboard retained-trace preview trace.budget.limits.perDrawer");
  assertExactCaps(limits.aggregate, "CheckpointStoryboard retained-trace preview trace.budget.limits.aggregate");
  if (storageBytes > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxBytes || peakBytes > CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxBytes) throw new Error("CheckpointStoryboard retained-trace preview trace aggregate budget exceeds fixed B7 caps.");
}

function assertBudget(value: unknown, trace: MotionParametricTracePlan): void {
  const budget = exactRecord(value, ["objects", "checkpoints", "edges", "recipes", "scheduleSamples", "vertices", "compileWorkUnits", "storageBytes", "peakBytes"], [], "CheckpointStoryboard retained-trace preview plan.budget");
  if (budget.objects !== 1 || budget.checkpoints !== 2 || budget.edges !== 1 || budget.recipes !== 1 || budget.scheduleSamples !== trace.schedule.length || budget.vertices !== trace.budget.maxVertices || budget.compileWorkUnits !== trace.budget.compileWorkUnits || budget.storageBytes !== trace.budget.storageBytes || budget.peakBytes !== trace.budget.peakBytes) throw new Error("CheckpointStoryboard retained-trace preview plan budget must exactly bind its compiled C4C plan.");
}

function assertEvidence(value: unknown): void {
  const evidence = exactRecord(value, ["noPackageIO", "noPackageWrites", "noCOW", "noReceipt", "noPublicSurface", "noRenderer", "noGpuExecutionWrapper"], [], "CheckpointStoryboard retained-trace preview plan.evidence");
  if (Object.values(evidence).some((item) => item !== true)) throw new Error("CheckpointStoryboard retained-trace preview requires the C6B7a no-renderer evidence partition.");
}

function assertExactCaps(value: unknown, label: string): void {
  const caps = exactRecord(value, ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"], [], label);
  for (const [field, expected] of Object.entries(CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS)) if (caps[field] !== expected) throw new Error(`${label}.${field} must equal the fixed B7 cap.`);
}
function assertConstantSignal(value: unknown, label: string, minimum: number, maximum: number, positive: boolean): void {
  const signal = exactRecord(value, ["source", "from", "to"], [], `CheckpointStoryboard retained-trace preview trace.drawer.output.${label}`);
  if (signal.source !== "constant") throw new Error(`CheckpointStoryboard retained-trace preview ${label} signal must be constant.`);
  const amount = finite(signal.from, `CheckpointStoryboard retained-trace preview ${label} signal`, minimum, maximum);
  if (signal.to !== amount || (positive && amount <= 0)) throw new Error(`CheckpointStoryboard retained-trace preview ${label} signal must be positive and constant.`);
}
function tuple01(value: unknown): boolean { return Array.isArray(value) && value.length === 2 && value[0] === 0 && value[1] === 1; }
function positiveSafeInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`); return value; }
function assertFingerprint(record: Record<string, unknown>, fingerprint: string, label: string): void { const { fingerprint: _ignored, ...payload } = record; if (canonicalJsonSha256(payload) !== fingerprint) throw new Error(`${label} fingerprint is stale or forged.`); }
