/** Private C6B5b closed-inventory COW adapter. It registers no Debug command or public surface. */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { canonicalJsonSha256, compareCodeUnits, compileMotionDocumentCompositing, hashBuffer, loadSchema, validateDocument, validateMotionProceduralGraph, validateMotionRelationActions, validateMotionRelations, type MotionDocument } from "@shellx-motion/core";
import { compileCheckpointStoryboardLifecycleProfilePlan, readCheckpointStoryboardLifecycleProfileRequest } from "@shellx-motion/core/internal/checkpoint-storyboard-lifecycle-profile";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { canonicalC6B5bHost, withC6B5bWorkspaceAuthority } from "./checkpoint-storyboard-lifecycle-materialize-authority-private.js";
import { c6B5bPrefixFacts, c6B5bPreservedLeaves, c6B5bSame, closedC6B5bInventory, observeC6B5bPackage, type C6B5bPackageFacts, type CheckpointStoryboardLifecycleMaterializationHost } from "./checkpoint-storyboard-lifecycle-materialize-facts-private.js";
import { reopenCheckpointStoryboardLifecycleMaterializationOutput } from "./checkpoint-storyboard-lifecycle-materialize-output-private.js";
import { C6B5B_RECEIPT_PATH, bindC6B5bExactBase, createC6B5bReceipt, readC6B5bExactBase, readC6B5bReceipt, writeC6B5bReceipt, type C6B5bExactBase, type C6B5bPlanEvidence, type CheckpointStoryboardLifecycleMaterializationReceipt } from "./checkpoint-storyboard-lifecycle-materialize-receipt-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-lifecycle-materialization-request@1" as const;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-lifecycle-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardLifecycleMaterializationApproval, ApprovedFacts>();
export type { CheckpointStoryboardLifecycleMaterializationHost } from "./checkpoint-storyboard-lifecycle-materialize-facts-private.js";
export type { CheckpointStoryboardLifecycleMaterializationReceipt } from "./checkpoint-storyboard-lifecycle-materialize-receipt-private.js";
export { reopenCheckpointStoryboardLifecycleMaterializationOutput } from "./checkpoint-storyboard-lifecycle-materialize-output-private.js";
export type { CheckpointStoryboardLifecycleMaterializationInstalledOutput, CheckpointStoryboardLifecycleMaterializationOutputHost } from "./checkpoint-storyboard-lifecycle-materialize-output-private.js";
export interface CheckpointStoryboardLifecycleMaterializationApproval { readonly [approvalBrand]: "c6b5b-approved"; }
export interface CheckpointStoryboardLifecycleMaterializationPreparation { readonly approval: CheckpointStoryboardLifecycleMaterializationApproval; readonly expected: C6B5bExactBase; readonly plan: C6B5bPlanEvidence; }
export interface CheckpointStoryboardLifecycleMaterializationResult { readonly packageRoot: string; readonly receipt: CheckpointStoryboardLifecycleMaterializationReceipt; readonly workspaceCleanup: "not-attested"; }
interface ApprovedFacts { readonly storyboard: unknown; readonly plan: C6B5bPlanEvidence; readonly expected: C6B5bExactBase; }
interface Staged { readonly source: C6B5bExactBase; readonly output: C6B5bExactBase; readonly receipt: CheckpointStoryboardLifecycleMaterializationReceipt; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }

/** Host-only preflight mints an opaque approval after reopening and compiling an exact detached base. */
export async function prepareCheckpointStoryboardLifecycleMaterialization(host: CheckpointStoryboardLifecycleMaterializationHost, storyboard: unknown): Promise<CheckpointStoryboardLifecycleMaterializationPreparation> {
  return await withC6B5bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B5bHost(host, roots), source = await observeC6B5bPackage(roots.sourceRoot, canonical); await assertSourceMotion(source.pkg.motion);
    const accepted = readCheckpointStoryboardLifecycleProfileRequest(requestFor(source, storyboard));
    const plan = compileCheckpointStoryboardLifecycleProfilePlan(requestFor(source, accepted.storyboard));
    const expected = exactBase(source, plan); assertPlanBase(plan, expected);
    const approval = Object.freeze({ [approvalBrand]: "c6b5b-approved" as const });
    approvals.set(approval, Object.freeze({ storyboard: accepted.storyboard, plan, expected }));
    return Object.freeze({ approval, expected, plan });
  });
}

/** COW appends precisely the host-minted B5a ordinary layers; requests can only echo exact base facts. */
export async function materializeCheckpointStoryboardLifecycle(host: CheckpointStoryboardLifecycleMaterializationHost, approval: CheckpointStoryboardLifecycleMaterializationApproval, value: unknown): Promise<CheckpointStoryboardLifecycleMaterializationResult> {
  const expected = readRequest(value), approved = readApproval(approval);
  return await withC6B5bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B5bHost(host, roots), source = await observeC6B5bPackage(roots.sourceRoot, canonical);
    const plan = await rederive(approved, source), exact = exactBase(source, plan); assertExact(expected, exact); assertExact(approved.expected, exact);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot, outputRoot: roots.outputRoot, requireAbsentOutput: true, closedInventory: "finalize-after-edit-with-empty-directories",
      edit: async (stagedRoot) => await editStaged(stagedRoot, canonical, source, approved, plan, exact),
      validate: async (stagedRoot, staged) => await assertStaged(stagedRoot, canonical, staged),
      beforeCommit: async () => { const current = await observeC6B5bPackage(roots.sourceRoot, canonical); assertExact(exact, exactBase(current, await rederive(approved, current))); },
      afterCommit: async (outputRoot, staged) => await assertStaged(outputRoot, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "not-attested" as const });
  });
}

async function editStaged(root: string, host: CheckpointStoryboardLifecycleMaterializationHost, source: C6B5bPackageFacts, approved: ApprovedFacts, plan: C6B5bPlanEvidence, exact: C6B5bExactBase): Promise<Staged> {
  const staged = await observeC6B5bPackage(root, host), stagedPlan = await rederive(approved, staged);
  assertExact(exact, exactBase(staged, stagedPlan)); if (!c6B5bSame(plan, stagedPlan)) throw new PackageEditTransactionError("source_changed", "C6B5b staged plan changed after source planning.");
  if (staged.snapshot.entries.has(C6B5B_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B5b fixed materialization receipt already exists.");
  const persisted = await preparePersistedMotion(staged.pkg.motion, stagedPlan);
  await writeJson(join(root, staged.pkg.manifest.motion), persisted);
  const edited = await observeC6B5bPackage(root, host), output = outputExactBase(edited, plan, exact);
  if (edited.base.packageId !== exact.packageId || edited.base.manifestRawSha256 !== exact.manifestRawSha256 || edited.base.motionRawSha256 !== serializedMotionSha256(persisted) || edited.base.motionCanonicalSha256 !== canonicalJsonSha256(persisted) || edited.base.motionCanonicalSha256 !== exact.outputCanonicalMotionSha256 || output.outputCanonicalMotionSha256 !== exact.outputCanonicalMotionSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B5b staged package identity differs from the validated lifecycle append.");
  await assertCompleteMotion(edited.pkg.motion); assertAppend(edited.pkg.motion, exact);
  // The non-receipt inventory models the fixed receipt as absent.  Reserve its parent before
  // capture so an otherwise fresh package has the same explicit empty-directory marker.
  await mkdir(join(root, "receipts"), { recursive: true, mode: 0o700 });
  const preReceiptInventory = await closedC6B5bInventory(root, host), receipt = createC6B5bReceipt(plan, approved.storyboard, exact, output, edited.pkg.manifest.motion, preReceiptInventory, c6B5bPreservedLeaves(source.snapshot, edited.pkg.manifest.motion));
  await writeC6B5bReceipt(root, receipt); const snapshot = await snapshotPackageEditTree(root); assertPreservedLeaves(source.snapshot, snapshot, edited.pkg.manifest.motion);
  return { source: exact, output, receipt, snapshot };
}

async function rederive(approved: ApprovedFacts, facts: C6B5bPackageFacts): Promise<C6B5bPlanEvidence> {
  try { await assertSourceMotion(facts.pkg.motion); const plan = compileCheckpointStoryboardLifecycleProfilePlan(requestFor(facts, approved.storyboard)); if (!c6B5bSame(plan, approved.plan)) throw new Error("plan differs from host-minted approval"); return plan; }
  catch (error) { throw new PackageEditTransactionError("source_changed", `C6B5b source no longer rederives the approved plan: ${message(error)}`); }
}
function requestFor(facts: C6B5bPackageFacts, storyboard: unknown) { return { schema: "shellx-motion/private-checkpoint-storyboard-lifecycle-profile-request@1", storyboard, base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 } }; }
function exactBase(facts: C6B5bPackageFacts, plan: C6B5bPlanEvidence): C6B5bExactBase { return bindC6B5bExactBase(facts.base, plan, c6B5bPrefixFacts(facts.pkg.motion.layers), canonicalJsonSha256(appendedMotion(facts.pkg.motion, plan))); }
function outputExactBase(facts: C6B5bPackageFacts, plan: C6B5bPlanEvidence, source: C6B5bExactBase): C6B5bExactBase { return bindC6B5bExactBase(facts.base, plan, { count: source.sourceLayerPrefixCount, sha256: source.sourceLayerPrefixSha256 }, source.outputCanonicalMotionSha256); }
function appendedMotion(source: MotionDocument, plan: C6B5bPlanEvidence): MotionDocument { const next = structuredClone(source) as MotionDocument; next.layers = [...source.layers, ...plan.layers] as MotionDocument["layers"]; return next; }
function assertPlanBase(plan: C6B5bPlanEvidence, base: C6B5bExactBase): void {
  if (plan.base.package.id !== base.packageId || plan.base.manifest.sha256 !== base.manifestCanonicalSha256 || plan.base.canonicalMotion.sha256 !== base.motionCanonicalSha256 || plan.base.persistedMotion.sha256 !== base.motionRawSha256 || plan.fingerprint !== base.planFingerprint || plan.lowererProfile.fingerprint !== base.profileFingerprint || plan.storyboard.id !== base.storyboardId || plan.storyboard.sha256 !== base.storyboardSha256 || plan.storyboard.revision !== base.storyboardRevision || plan.intendedChanges.layers.sourceLayerCount !== base.sourceLayerPrefixCount || !c6B5bSame(plan.intendedChanges.layers.appendLayerIds, base.generatedLayerIds) || plan.layers.length !== base.generatedLayerIds.length) throw new PackageEditTransactionError("source_changed", "C6B5b exact base or lifecycle append projection differs from its plan.");
}
function assertExact(expected: C6B5bExactBase, observed: C6B5bExactBase): void { if (!c6B5bSame(expected, observed)) throw new PackageEditTransactionError("source_changed", "C6B5b exact base, raw bytes, canonical identities, inventory, or approved lifecycle projection changed."); }
async function preparePersistedMotion(source: MotionDocument, plan: C6B5bPlanEvidence): Promise<MotionDocument> {
  await assertSourceMotion(source);
  const prefix = c6B5bPrefixFacts(source.layers); if (prefix.count !== plan.intendedChanges.layers.sourceLayerCount) throw new PackageEditTransactionError("source_changed", "C6B5b source layer prefix count changed after planning.");
  const ids = new Set<string>(); for (const layer of source.layers) { if (ids.has(layer.id)) throw new PackageEditTransactionError("source_changed", "C6B5b source has duplicate layer ids."); ids.add(layer.id); }
  for (const id of plan.intendedChanges.layers.appendLayerIds) { if (ids.has(id)) throw new PackageEditTransactionError("source_changed", "C6B5b target layer id collides with the source prefix."); ids.add(id); }
  const next = appendedMotion(source, plan); if (!sameWithoutLayers(source, next)) throw new PackageEditTransactionError("copy_mismatch", "C6B5b materialization changed a Motion field outside /layers.");
  assertAppend(next, appendBase(plan, prefix, canonicalJsonSha256(next)));
  await assertCompleteMotion(next);
  const persisted = compileMotionDocumentCompositing(next);
  if (!sameWithoutLayers(source, persisted) || canonicalJsonSha256(persisted) !== canonicalJsonSha256(next) || canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)) throw new PackageEditTransactionError("copy_mismatch", "C6B5b candidate compositing changed a field outside /layers or is not idempotent.");
  await assertCompleteMotion(persisted); return persisted;
}
async function assertCompleteMotion(motion: MotionDocument): Promise<void> { const validation = await validateDocument(await loadSchema("motion"), motion), procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true }, behaviors = validateMotionBehaviors(motion.behaviors, motion), relations = validateMotionRelations(motion.relations, motion), actions = Object.hasOwn(motion, "relationActions") ? validateMotionRelationActions(motion.relationActions) : { ok: true }; if (!validation.ok || !procedural.ok || !behaviors.ok || !relations.ok || !actions.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B5b materialization produced an invalid Motion authority graph."); }
async function assertSourceMotion(motion: MotionDocument): Promise<void> { await assertCompleteMotion(motion); if (canonicalJsonSha256(compileMotionDocumentCompositing(motion)) !== canonicalJsonSha256(motion)) throw new PackageEditTransactionError("source_changed", "C6B5b source compositing compilation is not idempotent."); }
function assertAppend(motion: MotionDocument, base: C6B5bExactBase): void {
  const prefix = motion.layers.slice(0, base.sourceLayerPrefixCount), suffix = motion.layers.slice(base.sourceLayerPrefixCount);
  if (c6B5bPrefixFacts(prefix).sha256 !== base.sourceLayerPrefixSha256 || suffix.length !== base.generatedLayerIds.length || !c6B5bSame(suffix.map((layer) => layer.id), base.generatedLayerIds) || canonicalJsonSha256(suffix) !== base.generatedLayersSha256 || canonicalJsonSha256(suffix.map((layer) => ({ id: layer.id, startMs: layer.startMs, durationMs: layer.durationMs }))) !== base.timingSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B5b output does not preserve its exact prefix and catalog-order suffix.");
  for (const layer of suffix) { const raw = layer as unknown as Record<string, unknown>; if (layer.type !== "shape" || (layer.shape !== "rect" && layer.shape !== "ellipse") || Object.hasOwn(raw, "visible") || Object.hasOwn(raw, "keyframes") || Object.hasOwn(raw, "transitions") || Object.hasOwn(raw, "childLayerIds") || Object.hasOwn(raw, "depth") || Object.hasOwn(raw, "geometry") || Object.hasOwn(raw, "morph")) throw new PackageEditTransactionError("copy_mismatch", "C6B5b generated layers widened visible or dynamic authority."); }
}
async function assertStaged(root: string, host: CheckpointStoryboardLifecycleMaterializationHost, staged: Staged): Promise<void> {
  const reopened = await observeC6B5bPackage(root, host); if (reopened.base.packageId !== staged.output.packageId || reopened.base.manifestRawSha256 !== staged.output.manifestRawSha256 || reopened.base.motionRawSha256 !== staged.output.motionRawSha256 || reopened.base.motionCanonicalSha256 !== staged.output.motionCanonicalSha256 || reopened.base.motionCanonicalSha256 !== staged.output.outputCanonicalMotionSha256 || !samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) throw new PackageEditTransactionError("copy_mismatch", "C6B5b reopened output differs from its staged exact inventory.");
  await assertCompleteMotion(reopened.pkg.motion); if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.pkg.motion)) !== canonicalJsonSha256(reopened.pkg.motion)) throw new PackageEditTransactionError("copy_mismatch", "C6B5b reopened compositing compilation is not idempotent."); assertAppend(reopened.pkg.motion, staged.output); if (!c6B5bSame(await readC6B5bReceipt(root), staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B5b receipt differs after reopen.");
  const output = await reopenCheckpointStoryboardLifecycleMaterializationOutput({ outputPackageRoot: root, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority });
  if (output.plan.fingerprint !== staged.output.planFingerprint || output.profile.fingerprint !== staged.output.profileFingerprint || output.layers.generatedSha256 !== staged.output.generatedLayersSha256 || !c6B5bSame(output.layers.ids, staged.output.generatedLayerIds) || output.layers.timingSha256 !== staged.output.timingSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B5b reopened output does not reprove its accepted lifecycle plan.");
}
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string): void { const entries = (snapshot: typeof source) => [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B5B_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); if (!c6B5bSame(entries(source), entries(output))) throw new PackageEditTransactionError("copy_mismatch", "C6B5b output changed a preserved package leaf."); }
function readApproval(value: unknown): ApprovedFacts { if (!value || typeof value !== "object") throw new Error("C6B5b materialization approval is invalid."); const facts = approvals.get(value as CheckpointStoryboardLifecycleMaterializationApproval); if (!facts) throw new Error("C6B5b materialization approval is not host-minted."); return facts; }
function readRequest(value: unknown): C6B5bExactBase { const root = object(value, "C6B5b materialization request"); keys(root, ["schema", "expected"], "C6B5b materialization request"); if (data(root, "schema", "C6B5b materialization request") !== REQUEST_SCHEMA) throw new Error("C6B5b materialization request schema is invalid."); return readC6B5bExactBase(data(root, "expected", "C6B5b materialization request")); }
function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }
function appendBase(plan: C6B5bPlanEvidence, prefix: { readonly count: number; readonly sha256: string }, outputCanonicalMotionSha256: string): C6B5bExactBase { return bindC6B5bExactBase({ packageId: "unused", manifestRawSha256: "0".repeat(64), motionRawSha256: "0".repeat(64), manifestCanonicalSha256: "0".repeat(64), motionCanonicalSha256: "0".repeat(64), inventory: { sha256: "0".repeat(64), entryCount: 1, leafCount: 1 } }, plan, prefix, outputCanonicalMotionSha256); }
function sameWithoutLayers(left: MotionDocument, right: MotionDocument): boolean { const { layers: _left, ...leftRest } = left, { layers: _right, ...rightRest } = right; return c6B5bSame(leftRest, rightRest); }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function data(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function keys(value: object, expected: readonly string[], label: string): void { const actual = Reflect.ownKeys(value); if (actual.length !== expected.length || actual.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !actual.includes(key))) throw new Error(`${label} has unsupported fields.`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
