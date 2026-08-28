/** Private C6B4b closed-inventory COW adapter. It registers no Debug command or public surface and stays shipping-unreachable until C6C-B4a resolver integration. */
import { join } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  compileMotionDocumentCompositing,
  hashBuffer,
  loadSchema,
  validateDocument,
  validateMotionProceduralGraph,
  validateMotionRelationActions,
  validateMotionRelations,
  type MotionDocument,
} from "@shellx-motion/core";
import {
  compileCheckpointStoryboardRelationActionProfilePlan,
  readCheckpointStoryboardRelationActionProfileRequest,
} from "@shellx-motion/core/internal/checkpoint-storyboard-relation-action-profile";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  C6B4B_RECEIPT_PATH,
  bindC6B4bExactBase,
  createC6B4bReceipt,
  readC6B4bExactBase,
  readC6B4bReceipt,
  writeC6B4bReceipt,
  type C6B4bExactBase,
  type C6B4bPlanEvidence,
  type CheckpointStoryboardRelationActionMaterializationReceipt,
} from "./checkpoint-storyboard-relation-action-materialize-receipt-private.js";
import {
  c6B4bPreservedLeaves,
  c6B4bSame,
  closedC6B4bInventory,
  observeC6B4bPackage,
  type C6B4bPackageFacts,
  type CheckpointStoryboardRelationActionMaterializationHost,
} from "./checkpoint-storyboard-relation-action-materialize-facts-private.js";
import { reopenCheckpointStoryboardRelationActionMaterializationOutput } from "./checkpoint-storyboard-relation-action-materialize-output-private.js";
import { canonicalC6B4bHost, withC6B4bWorkspaceAuthority, type C6B4bCanonicalRoots } from "./checkpoint-storyboard-relation-action-materialize-authority-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-request@1" as const;
const HASH = /^[a-f0-9]{64}$/;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-relation-action-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardRelationActionMaterializationApproval, ApprovedFacts>();

export type { CheckpointStoryboardRelationActionMaterializationHost } from "./checkpoint-storyboard-relation-action-materialize-facts-private.js";
export type { CheckpointStoryboardRelationActionMaterializationReceipt } from "./checkpoint-storyboard-relation-action-materialize-receipt-private.js";
export { reopenCheckpointStoryboardRelationActionMaterializationOutput } from "./checkpoint-storyboard-relation-action-materialize-output-private.js";
export type { CheckpointStoryboardRelationActionMaterializationInstalledOutput, CheckpointStoryboardRelationActionMaterializationOutputHost } from "./checkpoint-storyboard-relation-action-materialize-output-private.js";

export interface CheckpointStoryboardRelationActionMaterializationApproval { readonly [approvalBrand]: "c6b4b-approved"; }
export interface CheckpointStoryboardRelationActionMaterializationPreparation {
  readonly approval: CheckpointStoryboardRelationActionMaterializationApproval;
  readonly expected: C6B4bExactBase;
  readonly plan: C6B4bPlanEvidence;
}
export interface CheckpointStoryboardRelationActionMaterializationResult {
  readonly packageRoot: string;
  readonly receipt: CheckpointStoryboardRelationActionMaterializationReceipt;
  readonly workspaceCleanup: "completed";
}

interface ApprovedFacts {
  readonly storyboard: unknown;
  readonly bindings: unknown;
  readonly plan: C6B4bPlanEvidence;
  readonly expected: C6B4bExactBase;
}
interface Staged {
  readonly source: C6B4bExactBase;
  readonly output: C6B4bExactBase;
  readonly receipt: CheckpointStoryboardRelationActionMaterializationReceipt;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
}

/** Host-only preflight mints unforgeable approval only after an exact source reopen. */
export async function prepareCheckpointStoryboardRelationActionMaterialization(
  host: CheckpointStoryboardRelationActionMaterializationHost,
  storyboard: unknown,
  objectLayerBindings: unknown,
): Promise<CheckpointStoryboardRelationActionMaterializationPreparation> {
  return await withC6B4bWorkspaceAuthority(host, async (roots) => {
    const source = await observeC6B4bPackage(roots.sourceRoot, canonicalC6B4bHost(host, roots));
    const accepted = readCheckpointStoryboardRelationActionProfileRequest(requestFor(source, storyboard, objectLayerBindings));
    const plan = compileCheckpointStoryboardRelationActionProfilePlan(requestFor(source, accepted.storyboard, accepted.objectLayerBindings));
    const expected = exactBase(source.base, plan);
    assertPlanBase(plan, expected);
    const approval = Object.freeze({ [approvalBrand]: "c6b4b-approved" as const });
    approvals.set(approval, Object.freeze({ storyboard: accepted.storyboard, bindings: accepted.objectLayerBindings, plan, expected }));
    return Object.freeze({ approval, expected, plan });
  });
}

/** COW materializes only a host-minted plan with an exact caller echo of its source binding. */
export async function materializeCheckpointStoryboardRelationAction(
  host: CheckpointStoryboardRelationActionMaterializationHost,
  approval: CheckpointStoryboardRelationActionMaterializationApproval,
  value: unknown,
): Promise<CheckpointStoryboardRelationActionMaterializationResult> {
  return await withC6B4bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B4bHost(host, roots);
    const expected = readRequest(value), approved = readApproval(approval), source = await observeC6B4bPackage(roots.sourceRoot, canonical);
    const plan = await rederive(approved, source), exact = exactBase(source.base, plan);
    assertExact(expected, exact); assertExact(approved.expected, exact);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot,
      outputRoot: roots.outputRoot,
      requireAbsentOutput: true,
      closedInventory: "finalize-after-edit",
      edit: async (stagedRoot) => await editStaged(stagedRoot, canonical, source, approved, plan, exact),
      validate: async (stagedRoot, staged) => await assertStaged(stagedRoot, canonical, staged),
      beforeCommit: async () => {
        const current = await observeC6B4bPackage(roots.sourceRoot, canonical);
        assertExact(exact, exactBase(current.base, await rederive(approved, current)));
      },
      afterCommit: async (outputRoot, staged) => await assertStaged(outputRoot, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "completed" as const });
  });
}

async function editStaged(
  root: string,
  host: CheckpointStoryboardRelationActionMaterializationHost,
  source: C6B4bPackageFacts,
  approved: ApprovedFacts,
  plan: C6B4bPlanEvidence,
  exact: C6B4bExactBase,
): Promise<Staged> {
  const staged = await observeC6B4bPackage(root, host), stagedPlan = await rederive(approved, staged);
  assertExact(exact, exactBase(staged.base, stagedPlan));
  if (!c6B4bSame(plan, stagedPlan)) throw new PackageEditTransactionError("source_changed", "C6B4b staged plan changed after source planning.");
  if (staged.snapshot.entries.has(C6B4B_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B4b fixed materialization receipt already exists.");
  const persisted = await preparePersistedMotion(staged.pkg.motion, stagedPlan);
  await writeJson(join(root, staged.pkg.manifest.motion), persisted);
  const edited = await observeC6B4bPackage(root, host);
  if (edited.base.packageId !== exact.packageId
    || edited.base.manifestRawSha256 !== exact.manifestRawSha256
    || edited.base.motionRawSha256 !== serializedMotionSha256(persisted)
    || edited.base.motionCanonicalSha256 !== canonicalJsonSha256(persisted)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b staged package identity differs from the validated write.");
  }
  if (edited.base.motionCanonicalSha256 !== plan.projection.action.outputCanonicalMotionSha256) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b persisted Motion does not equal the C6B4a action output identity.");
  }
  await assertCompleteMotion(edited.pkg.motion);
  const output = exactBase(edited.base, plan), preReceiptInventory = await closedC6B4bInventory(root, host);
  const receipt = createC6B4bReceipt(plan, exact, output, edited.pkg.manifest.motion, preReceiptInventory, c6B4bPreservedLeaves(source.snapshot, edited.pkg.manifest.motion));
  await writeC6B4bReceipt(root, receipt);
  const snapshot = await snapshotPackageEditTree(root);
  assertPreservedLeaves(source.snapshot, snapshot, edited.pkg.manifest.motion);
  return { source: exact, output, receipt, snapshot };
}

async function rederive(approved: ApprovedFacts, facts: C6B4bPackageFacts): Promise<C6B4bPlanEvidence> {
  try {
    const plan = compileCheckpointStoryboardRelationActionProfilePlan(requestFor(facts, approved.storyboard, approved.bindings));
    if (!c6B4bSame(plan, approved.plan)) throw new Error("plan differs from host-minted approval");
    return plan;
  } catch (error) {
    throw new PackageEditTransactionError("source_changed", `C6B4b source no longer rederives the approved plan: ${message(error)}`);
  }
}

function requestFor(facts: C6B4bPackageFacts, storyboard: unknown, objectLayerBindings: unknown) {
  return {
    schema: "shellx-motion/private-checkpoint-storyboard-relation-action-profile-request@1",
    storyboard,
    objectLayerBindings,
    base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 },
  };
}

function exactBase(base: C6B4bExactBase, plan: C6B4bPlanEvidence): C6B4bExactBase {
  return bindC6B4bExactBase(base, plan);
}

function assertPlanBase(plan: C6B4bPlanEvidence, base: C6B4bExactBase): void {
  const action = plan.projection.action;
  if (plan.base?.package?.id !== base.packageId
    || plan.base?.manifest?.sha256 !== base.manifestCanonicalSha256
    || plan.base?.canonicalMotion?.sha256 !== base.motionCanonicalSha256
    || plan.base?.persistedMotion?.sha256 !== base.motionRawSha256
    || plan.fingerprint !== base.planFingerprint
    || plan.lowererProfile.fingerprint !== base.profileFingerprint
    || action.store.schema !== base.actionStoreSchema || action.store.sha256 !== base.actionStoreSha256
    || action.definition.id !== base.actionDefinitionId || action.definition.sha256 !== base.actionDefinitionSha256
    || action.request.instanceId !== base.actionRequestInstanceId || action.request.sha256 !== base.actionRequestSha256
    || action.applyPlan.fingerprint !== base.actionApplyPlanFingerprint
    || action.applyPlan.counts.objects !== base.actionObjects || action.applyPlan.counts.relations !== base.actionRelations || action.applyPlan.counts.keyframeWrites !== base.actionKeyframeWrites
    || action.changedPaths[0] !== base.actionChangedPath
    || action.outputCanonicalMotionSha256 !== base.actionOutputCanonicalMotionSha256
    || action.applyPlan.counts.objects !== 0 || action.applyPlan.counts.relations !== 1 || action.applyPlan.counts.keyframeWrites !== 0
    || action.relationIds.length !== 1 || action.relationIds[0] !== base.relationId
    || action.changedPaths.length !== 1 || action.changedPaths[0] !== `/relations/bindings/${base.relationId}`
    || plan.projection.storeSha256 !== base.storeSha256
    || plan.projection.staticFingerprint !== base.staticFingerprint
    || plan.projection.gpuPreviewStaticPlan.fingerprint !== base.gpuStaticFingerprint
    || plan.endpointFramePlans.start.fingerprint !== base.startFramePlanFingerprint
    || plan.endpointFramePlans.end.fingerprint !== base.endFramePlanFingerprint) {
    throw new PackageEditTransactionError("source_changed", "C6B4b exact base or relation-action projection identity differs from its plan.");
  }
}

function assertExact(expected: C6B4bExactBase, observed: C6B4bExactBase): void {
  if (!c6B4bSame(expected, observed)) throw new PackageEditTransactionError("source_changed", "C6B4b exact base, raw bytes, canonical identities, inventory, or approved action projection changed.");
}

async function preparePersistedMotion(source: MotionDocument, plan: C6B4bPlanEvidence): Promise<MotionDocument> {
  if (canonicalJsonSha256(compileMotionDocumentCompositing(source)) !== canonicalJsonSha256(source)) {
    throw new PackageEditTransactionError("source_changed", "C6B4b source compositing compilation is not idempotent.");
  }
  if (Object.hasOwn(source, "relations")) throw new PackageEditTransactionError("source_changed", "C6B4b source relation authority changed after planning.");
  const sourceActions = canonicalJsonSha256(source.relationActions);
  const next = structuredClone(source) as MotionDocument;
  next.relations = structuredClone(plan.projection.store);
  if (!sameWithoutRelations(source, next) || canonicalJsonSha256(next.relationActions) !== sourceActions) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b materialization changed a Motion field outside /relations or altered relationActions.");
  }
  await assertCompleteMotion(next);
  const persisted = compileMotionDocumentCompositing(next);
  if (!sameWithoutRelations(source, persisted) || canonicalJsonSha256(persisted.relationActions) !== sourceActions
    || canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)
    || canonicalJsonSha256(persisted) !== plan.projection.action.outputCanonicalMotionSha256) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b compositing compilation changed a field outside /relations or no longer matches C6B4a output.");
  }
  await assertCompleteMotion(persisted);
  return persisted;
}

async function assertCompleteMotion(motion: MotionDocument): Promise<void> {
  const validation = await validateDocument(await loadSchema("motion"), motion);
  const procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true };
  const behaviors = validateMotionBehaviors(motion.behaviors, motion);
  const relations = validateMotionRelations(motion.relations, motion);
  const actions = validateMotionRelationActions(motion.relationActions);
  if (!validation.ok || !procedural.ok || !behaviors.ok || !relations.ok || !actions.ok) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b materialization produced an invalid Motion authority graph.");
  }
}

function sameWithoutRelations(left: MotionDocument, right: MotionDocument): boolean {
  const { relations: _left, ...leftRest } = left, { relations: _right, ...rightRest } = right;
  return c6B4bSame(leftRest, rightRest);
}

async function assertStaged(root: string, host: CheckpointStoryboardRelationActionMaterializationHost, staged: Staged): Promise<void> {
  const reopened = await observeC6B4bPackage(root, host);
  if (reopened.base.packageId !== staged.output.packageId
    || reopened.base.manifestRawSha256 !== staged.output.manifestRawSha256
    || reopened.base.motionRawSha256 !== staged.output.motionRawSha256
    || reopened.base.motionCanonicalSha256 !== staged.output.motionCanonicalSha256
    || reopened.base.motionCanonicalSha256 !== staged.output.actionOutputCanonicalMotionSha256
    || !samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened output differs from its staged exact inventory.");
  }
  await assertCompleteMotion(reopened.pkg.motion);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.pkg.motion)) !== canonicalJsonSha256(reopened.pkg.motion)
    || canonicalJsonSha256(reopened.pkg.motion.relationActions) === "") {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened compositing or retained action evidence is invalid.");
  }
  if (!c6B4bSame(await readC6B4bReceipt(root), staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt differs after reopen.");
  const output = await reopenCheckpointStoryboardRelationActionMaterializationOutput({
    outputPackageRoot: root,
    packageWorkspaceRoot: host.packageWorkspaceRoot,
    packageWorkspaceAuthority: host.packageWorkspaceAuthority,
  });
  if (output.plan.fingerprint !== staged.output.planFingerprint || output.profile.fingerprint !== staged.output.profileFingerprint
    || output.relationAction.store.schema !== staged.output.actionStoreSchema || output.relationAction.store.sha256 !== staged.output.actionStoreSha256
    || output.relationAction.definition.id !== staged.output.actionDefinitionId || output.relationAction.definition.sha256 !== staged.output.actionDefinitionSha256
    || output.relationAction.request.instanceId !== staged.output.actionRequestInstanceId || output.relationAction.request.sha256 !== staged.output.actionRequestSha256
    || output.relationAction.apply.planFingerprint !== staged.output.actionApplyPlanFingerprint || output.relationAction.apply.changedPath !== staged.output.actionChangedPath
    || output.relationAction.apply.outputCanonicalMotionSha256 !== staged.output.actionOutputCanonicalMotionSha256
    || output.relationStore.sha256 !== staged.output.storeSha256 || output.relationStatic.fingerprint !== staged.output.staticFingerprint
    || output.gpuRelationStatic.fingerprint !== staged.output.gpuStaticFingerprint || output.endpointFramePlans.startFingerprint !== staged.output.startFramePlanFingerprint || output.endpointFramePlans.endFingerprint !== staged.output.endFramePlanFingerprint) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b reopened output does not reprove its accepted action plan.");
  }
}

function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string): void {
  const entries = (snapshot: typeof source) => [...snapshot.entries]
    .filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B4B_RECEIPT_PATH)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  if (!c6B4bSame(entries(source), entries(output))) throw new PackageEditTransactionError("copy_mismatch", "C6B4b output changed a preserved package leaf.");
}

function readApproval(value: unknown): ApprovedFacts {
  if (!value || typeof value !== "object" || (value as CheckpointStoryboardRelationActionMaterializationApproval)[approvalBrand] !== "c6b4b-approved") throw new Error("C6B4b materialization approval is invalid.");
  const facts = approvals.get(value as CheckpointStoryboardRelationActionMaterializationApproval);
  if (!facts) throw new Error("C6B4b materialization approval is not host-minted.");
  return facts;
}

function readRequest(value: unknown): C6B4bExactBase {
  const root = object(value, "C6B4b materialization request");
  keys(root, ["schema", "expected"], "C6B4b materialization request");
  if (data(root, "schema", "C6B4b materialization request") !== REQUEST_SCHEMA) throw new Error("C6B4b materialization request schema is invalid.");
  return readC6B4bExactBase(data(root, "expected", "C6B4b materialization request"));
}

function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function data(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function keys(value: object, expected: readonly string[], label: string): void { const actual = Reflect.ownKeys(value); if (actual.length !== expected.length || actual.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !actual.includes(key))) throw new Error(`${label} has unsupported fields.`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
