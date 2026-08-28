/** Private output-only C6B4b diagnostic reopen. It accepts no source, approval, plan, or writer authority. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  applyMotionRelationAction,
  canonicalJsonSha256,
  compareCodeUnits,
  compileGpuSceneRelationsStaticPlan,
  compileMotionRelationAuthoringFramePlanFromEvaluation,
  compileMotionRelationStaticPlan,
  evaluateMotionRelationAuthoringFrame,
  inspectMotionRelationActions,
  validateMotionRelationActions,
  validateMotionRelations,
  type MotionDocument,
  type MotionRelationActionDefinition,
  type MotionRelationStore,
} from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { C6B4B_RECEIPT_PATH, readC6B4bReceipt, type C6B4bInventory, type CheckpointStoryboardRelationActionMaterializationReceipt } from "./checkpoint-storyboard-relation-action-materialize-receipt-private.js";
import {
  c6B4bCurrentInventory,
  c6B4bNonReceiptInventory,
  c6B4bPreservedLeaves,
  c6B4bSame,
  closedC6B4bInventory,
  observeC6B4bPackage,
  type CheckpointStoryboardRelationActionMaterializationOutputHost,
} from "./checkpoint-storyboard-relation-action-materialize-facts-private.js";

export type { CheckpointStoryboardRelationActionMaterializationOutputHost } from "./checkpoint-storyboard-relation-action-materialize-facts-private.js";

export interface CheckpointStoryboardRelationActionMaterializationInstalledOutput {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-installed-output@1";
  readonly receipt: { readonly schema: "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-receipt@1"; readonly fingerprint: string };
  readonly package: {
    readonly id: string;
    readonly manifest: { readonly rawSha256: string; readonly canonicalSha256: string };
    readonly motion: { readonly rawSha256: string; readonly canonicalSha256: string };
    readonly currentInventory: C6B4bInventory;
    readonly nonReceiptInventory: C6B4bInventory;
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
  };
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
  readonly plan: { readonly fingerprint: string };
  readonly profile: { readonly fingerprint: string };
  readonly relationAction: {
    readonly store: { readonly schema: "shellx-motion/relation-actions@2"; readonly sha256: string };
    readonly definition: { readonly id: string; readonly sha256: string };
    readonly request: { readonly instanceId: string; readonly sha256: string };
    readonly apply: { readonly planFingerprint: string; readonly objectCount: 0; readonly relationCount: 1; readonly keyframeWriteCount: 0; readonly changedPath: string; readonly outputCanonicalMotionSha256: string };
  };
  readonly relationStore: { readonly schema: "shellx-motion/relations@1"; readonly sha256: string; readonly bindings: readonly MotionRelationStore["bindings"][number][] };
  readonly relationStatic: { readonly fingerprint: string };
  readonly gpuRelationStatic: { readonly fingerprint: string; readonly relationStaticFingerprint: string };
  readonly endpointFramePlans: { readonly startFingerprint: string; readonly endFingerprint: string };
  readonly materialization: { readonly changedMotionRoot: "relations"; readonly changedLeafCount: 2; readonly renderer: { readonly invoked: false; readonly pixels: false } };
}

/** Reopens an installed C6B4b COW package solely through host authority and its fixed receipt. */
export async function reopenCheckpointStoryboardRelationActionMaterializationOutput(
  host: CheckpointStoryboardRelationActionMaterializationOutputHost,
): Promise<CheckpointStoryboardRelationActionMaterializationInstalledOutput> {
  return await withOutputWorkspaceAuthority(host, async (outputRoot, canonicalHost) => {
    const before = await readC6B4bReceipt(outputRoot), output = await observeC6B4bPackage(outputRoot, canonicalHost);
    assertReceiptBinding(before, output);
    const action = inspectAndReapplyAction(output.pkg.motion, before);
    const relations = validateMotionRelations(output.pkg.motion.relations, output.pkg.motion);
    if (!relations.ok || !relations.store || relations.store.bindings.length !== 1 || relations.bindings.length !== 1) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened output does not contain one valid relations@1 binding.");
    }
    const binding = relations.store.bindings[0]!, resolved = relations.bindings[0]!, durationUs = output.pkg.motion.durationMs * 1_000;
    if (binding.id !== before.approval.action.relationId || binding.enabled !== true || binding.kind !== "attach" || binding.mode !== "follow"
      || binding.offset.space !== "world" || binding.offset.rotationDeg !== 0 || binding.offset.scale !== 1
      || binding.source.layerId === binding.target.layerId || binding.startUs !== 0 || binding.durationUs !== durationUs
      || resolved.binding.id !== binding.id || resolved.binding.target.layerId !== binding.target.layerId
      || !sameMask(resolved.writeMask, ["transform.x", "transform.y"])) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened output does not contain the receipted target-only world-follow relation.");
    }
    assertRootRoles(output.pkg.motion, binding.source.layerId, binding.target.layerId);
    const staticPlan = compileMotionRelationStaticPlan(output.pkg.motion);
    if (!staticPlan.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened static relation plan is invalid.");
    const gpuStatic = compileGpuSceneRelationsStaticPlan(output.pkg.motion);
    if (!gpuStatic.ok || gpuStatic.plan.relationStaticFingerprint !== staticPlan.plan.fingerprint) throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened GPU static relation plan is invalid.");
    const start = compileMotionRelationAuthoringFramePlanFromEvaluation(output.pkg.motion, evaluateMotionRelationAuthoringFrame(output.pkg.motion, 0));
    const end = compileMotionRelationAuthoringFramePlanFromEvaluation(output.pkg.motion, evaluateMotionRelationAuthoringFrame(output.pkg.motion, durationUs));
    if (!start.ok || !end.ok || start.plan.staticFingerprint !== staticPlan.plan.fingerprint || end.plan.staticFingerprint !== staticPlan.plan.fingerprint) throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened endpoint relation-frame plans are invalid.");
    const storeSha256 = canonicalJsonSha256(relations.store);
    if (storeSha256 !== before.approval.relation.storeSha256
      || staticPlan.plan.fingerprint !== before.approval.relation.staticFingerprint
      || gpuStatic.plan.fingerprint !== before.approval.relation.gpuStaticFingerprint
      || start.plan.fingerprint !== before.approval.relation.startFramePlanFingerprint
      || end.plan.fingerprint !== before.approval.relation.endFramePlanFingerprint) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B4b relation plan evidence differs from the installed action projection.");
    }
    const snapshot = await snapshotPackageEditTree(outputRoot);
    const nonReceiptInventory = c6B4bNonReceiptInventory(snapshot), currentInventory = await closedC6B4bInventory(outputRoot, canonicalHost);
    const expectedPaths = [output.pkg.manifest.motion, C6B4B_RECEIPT_PATH].sort(compareCodeUnits);
    if (!c6B4bSame(nonReceiptInventory, before.output.nonReceiptInventory)
      || !c6B4bSame(currentInventory, c6B4bCurrentInventory(snapshot))
      || currentInventory.entryCount !== nonReceiptInventory.entryCount + 1
      || currentInventory.leafCount !== nonReceiptInventory.leafCount + 1
      || !c6B4bSame(c6B4bPreservedLeaves(snapshot, output.pkg.manifest.motion), before.output.preservedLeaves)
      || !c6B4bSame(before.output.changed.paths, expectedPaths)
      || before.output.changed.count !== 2 || before.output.changed.motionPropertyPaths[0] !== "relations" || before.output.changed.motionPropertyPathCount !== 1) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened output tree differs from its fixed receipt evidence.");
    }
    const afterOutput = await observeC6B4bPackage(outputRoot, canonicalHost), after = await readC6B4bReceipt(outputRoot);
    if (afterOutput.base.packageId !== output.base.packageId
      || afterOutput.base.manifestRawSha256 !== output.base.manifestRawSha256
      || afterOutput.base.motionRawSha256 !== output.base.motionRawSha256
      || afterOutput.base.motionCanonicalSha256 !== output.base.motionCanonicalSha256
      || !c6B4bSame(after, before)) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt or package changed during installed-output reopen.");
    return Object.freeze({
      schema: "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-installed-output@1",
      receipt: Object.freeze({ schema: before.schema, fingerprint: before.fingerprint }),
      package: Object.freeze({
        id: output.base.packageId,
        manifest: Object.freeze({ rawSha256: output.base.manifestRawSha256, canonicalSha256: output.base.manifestCanonicalSha256 }),
        motion: Object.freeze({ rawSha256: output.base.motionRawSha256, canonicalSha256: output.base.motionCanonicalSha256 }),
        currentInventory, nonReceiptInventory, preservedLeaves: Object.freeze({ ...before.output.preservedLeaves }),
      }),
      storyboard: Object.freeze({ ...before.approval.storyboard }),
      plan: Object.freeze({ fingerprint: before.approval.planFingerprint }),
      profile: Object.freeze({ fingerprint: before.approval.profileFingerprint }),
      relationAction: Object.freeze({
        store: Object.freeze({ ...before.approval.action.store }),
        definition: Object.freeze({ ...before.approval.action.definition }),
        request: Object.freeze({ ...before.approval.action.request }),
        apply: Object.freeze({ planFingerprint: before.approval.action.applyPlanFingerprint, objectCount: 0 as const, relationCount: 1 as const, keyframeWriteCount: 0 as const, changedPath: before.approval.action.changedPath, outputCanonicalMotionSha256: before.approval.action.outputCanonicalMotionSha256 }),
      }),
      relationStore: Object.freeze({ schema: relations.store.schema, sha256: storeSha256, bindings: frozen(structuredClone(relations.store.bindings)) }),
      relationStatic: Object.freeze({ fingerprint: staticPlan.plan.fingerprint }),
      gpuRelationStatic: Object.freeze({ fingerprint: gpuStatic.plan.fingerprint, relationStaticFingerprint: gpuStatic.plan.relationStaticFingerprint }),
      endpointFramePlans: Object.freeze({ startFingerprint: start.plan.fingerprint, endFingerprint: end.plan.fingerprint }),
      materialization: Object.freeze({ changedMotionRoot: "relations" as const, changedLeafCount: 2 as const, renderer: Object.freeze({ invoked: false as const, pixels: false as const }) }),
    });
  });
}

function inspectAndReapplyAction(motion: MotionDocument, receipt: CheckpointStoryboardRelationActionMaterializationReceipt) {
  const admitted = validateMotionRelationActions(motion.relationActions);
  const inspection = inspectMotionRelationActions(motion);
  if (!admitted.ok || !inspection.store || !inspection.storeSha256 || inspection.store.schema !== receipt.approval.action.store.schema || inspection.storeSha256 !== receipt.approval.action.store.sha256 || inspection.store.definitions.length !== 1) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action store is invalid or differs from its receipt.");
  }
  const definition = inspection.store.definitions[0]!;
  if (definition.id !== receipt.approval.action.definition.id || canonicalJsonSha256(definition) !== receipt.approval.action.definition.sha256) throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action definition differs from its receipt.");
  const roleMap = assertSealedDefinition(definition, motion.durationMs * 1_000);
  const relations = validateMotionRelations(motion.relations, motion);
  if (!relations.ok || !relations.store || relations.store.bindings.length !== 1) throw new PackageEditTransactionError("copy_mismatch", "C6B4b cannot derive action roles without its sole relation.");
  const binding = relations.store.bindings[0]!;
  const roleBindings = Object.freeze({ [roleMap.sourceRoleId]: binding.source.layerId, [roleMap.targetRoleId]: binding.target.layerId });
  const source = structuredClone(motion) as MotionDocument;
  delete source.relations;
  const request = {
    definitionId: definition.id,
    expectedMotionSha256: canonicalJsonSha256(source),
    expectedStoreSha256: inspection.storeSha256,
    expectedDefinitionSha256: canonicalJsonSha256(definition),
    instanceId: receipt.approval.action.request.instanceId,
    startAtUs: 0,
    roleBindings,
    parameterValues: {},
  };
  if (canonicalJsonSha256(request) !== receipt.approval.action.request.sha256) throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action request identity differs from its receipt.");
  let applied: ReturnType<typeof applyMotionRelationAction>;
  try { applied = applyMotionRelationAction(source, request); }
  catch (error) { throw new PackageEditTransactionError("copy_mismatch", `C6B4b reopened action cannot be reapplied: ${message(error)}`); }
  if (applied.plan.fingerprint !== receipt.approval.action.applyPlanFingerprint || applied.plan.counts.objects !== 0 || applied.plan.counts.relations !== 1 || applied.plan.counts.keyframeWrites !== 0
    || applied.relationIds.length !== 1 || applied.relationIds[0] !== receipt.approval.action.relationId
    || applied.changedPaths.length !== 1 || applied.changedPaths[0] !== receipt.approval.action.changedPath
    || applied.outputMotionSha256 !== receipt.approval.action.outputCanonicalMotionSha256
    || canonicalJsonSha256(applied.motion) !== canonicalJsonSha256(motion)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action projection differs from the installed Motion package.");
  }
  return { definition, roleMap };
}

function assertSealedDefinition(definition: MotionRelationActionDefinition, durationUs: number) {
  if (definition.roles.length !== 2 || definition.roles.some((role) => role.kind !== "layer" || role.layerTypes.length !== 1 || role.layerTypes[0] !== "shape")
    || definition.parameters.length !== 0 || definition.templateLayers.length !== 0 || definition.relationTemplates.length !== 1 || definition.sequence.length !== 1) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action definition is not the sealed relation-only profile.");
  }
  const template = definition.relationTemplates[0]!, step = definition.sequence[0]!;
  if (template.kind !== "attach" || template.enabled !== true || template.mode !== "follow" || template.offset.space !== "world" || template.startUs !== 0
    || !literal(template.durationUs) || template.durationUs.value !== durationUs || template.source.layer.source !== "role" || template.target.layer.source !== "role"
    || template.source.layer.roleId === template.target.layer.roleId || !literal(template.source.anchorX) || !literal(template.source.anchorY)
    || !literal(template.target.anchorX) || !literal(template.target.anchorY) || !literal(template.offset.x) || !literal(template.offset.y)
    || !literal(template.offset.rotationDeg) || !literal(template.offset.scale) || template.offset.rotationDeg.value !== 0 || template.offset.scale.value !== 1
    || step.kind !== "relation" || step.atUs !== 0 || step.relationTemplateId !== template.id) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action definition widened its relation-only authority.");
  }
  return Object.freeze({ sourceRoleId: template.source.layer.roleId, targetRoleId: template.target.layer.roleId });
}

function assertRootRoles(motion: MotionDocument, sourceId: string, targetId: string): void {
  if (motion.layers.length !== 2 || sourceId === targetId) throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action roots are invalid.");
  const ids = new Set([sourceId, targetId]);
  if (ids.size !== 2 || !motion.layers.every((layer) => ids.has(layer.id) && layer.type === "shape" && (layer.shape === "rect" || layer.shape === "ellipse") && layer.visible !== false && layer.locked !== true && layer.startMs === 0 && layer.durationMs === motion.durationMs && !Object.hasOwn(layer as object, "childLayerIds") && !Object.hasOwn(layer as object, "keyframes") && !Object.hasOwn(layer as object, "transitions") && !Object.hasOwn(layer as object, "depth") && !Object.hasOwn(layer as object, "geometry") && !Object.hasOwn(layer as object, "morph"))) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened action roots widened beyond two preserved rect/ellipse layers.");
  }
}

function assertReceiptBinding(receipt: CheckpointStoryboardRelationActionMaterializationReceipt, output: Awaited<ReturnType<typeof observeC6B4bPackage>>): void {
  const expected = receipt.base.expected;
  if (!c6B4bSame(expected, receipt.base.reopened)
    || expected.packageId !== output.base.packageId
    || expected.manifestRawSha256 !== output.base.manifestRawSha256
    || expected.manifestCanonicalSha256 !== output.base.manifestCanonicalSha256
    || receipt.output.packageId !== output.base.packageId
    || receipt.output.manifestRawSha256 !== output.base.manifestRawSha256
    || receipt.output.motionRawSha256 !== output.base.motionRawSha256
    || receipt.output.canonicalMotionSha256 !== output.base.motionCanonicalSha256
    || receipt.approval.planFingerprint !== expected.planFingerprint
    || receipt.approval.profileFingerprint !== expected.profileFingerprint
    || receipt.approval.action.store.schema !== expected.actionStoreSchema || receipt.approval.action.store.sha256 !== expected.actionStoreSha256
    || receipt.approval.action.definition.id !== expected.actionDefinitionId || receipt.approval.action.definition.sha256 !== expected.actionDefinitionSha256
    || receipt.approval.action.request.instanceId !== expected.actionRequestInstanceId || receipt.approval.action.request.sha256 !== expected.actionRequestSha256
    || receipt.approval.action.applyPlanFingerprint !== expected.actionApplyPlanFingerprint
    || receipt.approval.action.outputCanonicalMotionSha256 !== expected.actionOutputCanonicalMotionSha256
    || receipt.approval.action.relationId !== expected.relationId || receipt.approval.action.changedPath !== expected.actionChangedPath
    || receipt.approval.action.counts.objects !== expected.actionObjects || receipt.approval.action.counts.relations !== expected.actionRelations || receipt.approval.action.counts.keyframeWrites !== expected.actionKeyframeWrites
    || receipt.approval.relation.storeSha256 !== expected.storeSha256 || receipt.approval.relation.staticFingerprint !== expected.staticFingerprint
    || receipt.approval.relation.gpuStaticFingerprint !== expected.gpuStaticFingerprint || receipt.approval.relation.startFramePlanFingerprint !== expected.startFramePlanFingerprint || receipt.approval.relation.endFramePlanFingerprint !== expected.endFramePlanFingerprint
    || receipt.renderer.invoked !== false || receipt.renderer.pixels !== false) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened package identity differs from its fixed receipt.");
  }
}

async function withOutputWorkspaceAuthority<T>(host: CheckpointStoryboardRelationActionMaterializationOutputHost, operation: (outputRoot: string, canonicalHost: CheckpointStoryboardRelationActionMaterializationOutputHost) => Promise<T>): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), outputSpelling = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspaceRoot, outputSpelling)) throw new PackageEditTransactionError("unsafe_output", "C6B4b output must be a strict descendant of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B4b output workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(outputSpelling);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B4b output package root is not a trusted directory.");
    const outputRoot = await realpath(outputSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B4b output package root cannot be canonicalized: ${message(error)}`); });
    if (outputRoot !== outputSpelling || !strictDescendant(workspaceRoot, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B4b output package root must be the canonical strict workspace descendant without intermediate symlinks.");
    const after = await lstat(outputRoot);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C6B4b output package root changed while canonicalizing.");
    return await operation(outputRoot, Object.freeze({ outputPackageRoot: outputRoot, packageWorkspaceRoot: workspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }));
  });
}

function literal(value: unknown): value is { readonly source: "literal"; readonly value: number } { return !!value && typeof value === "object" && (value as { source?: unknown }).source === "literal" && typeof (value as { value?: unknown }).value === "number" && Number.isFinite((value as { value: number }).value); }
function sameMask(actual: readonly string[], expected: readonly string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }
function frozen<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) frozen(child); Object.freeze(value); } return value; }
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
