/** Private C6B7b exact-base COW sidecar installer. It registers no Debug command or public surface. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "@shellx-motion/core";
import { admitCheckpointStoryboardRetainedTraceRecordProfile, compileCheckpointStoryboardRetainedTraceProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-retained-trace-profile";
import { snapshotCheckpointStoryboardData } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { commitPackageEdit, PackageEditTransactionError } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { canonicalC6B7bHost, withC6B7bWorkspaceAuthority } from "./checkpoint-storyboard-retained-trace-materialize-authority-private.js";
import { C6B7B_RECEIPT_PATH, C6B7B_SIDECAR_PATH, c6B7bPreservedLeaves, c6B7bSame, closedC6B7bInventory, observeC6B7bPackage, type C6B7bPackageFacts, type CheckpointStoryboardRetainedTraceMaterializationHost } from "./checkpoint-storyboard-retained-trace-materialize-facts-private.js";
import { reopenCheckpointStoryboardRetainedTraceMaterializationOutput } from "./checkpoint-storyboard-retained-trace-materialize-output-private.js";
import { createC6B7bReceipt, readC6B7bExactBase, readC6B7bReceipt, readC6B7bSidecar, writeC6B7bReceipt, writeC6B7bSidecar, type C6B7bExactBase, type CheckpointStoryboardRetainedTraceMaterializationReceipt } from "./checkpoint-storyboard-retained-trace-materialize-receipt-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-retained-trace-materialization-request@1" as const;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-retained-trace-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardRetainedTraceMaterializationApproval, ApprovedFacts>();
export type { CheckpointStoryboardRetainedTraceMaterializationHost } from "./checkpoint-storyboard-retained-trace-materialize-facts-private.js";
export type { CheckpointStoryboardRetainedTraceMaterializationReceipt } from "./checkpoint-storyboard-retained-trace-materialize-receipt-private.js";
export { reopenCheckpointStoryboardRetainedTraceMaterializationOutput } from "./checkpoint-storyboard-retained-trace-materialize-output-private.js";
export interface CheckpointStoryboardRetainedTraceMaterializationApproval { readonly [approvalBrand]: "c6b7b-approved"; }
export interface CheckpointStoryboardRetainedTraceMaterializationPreparation { readonly approval: CheckpointStoryboardRetainedTraceMaterializationApproval; readonly expected: C6B7bExactBase; readonly plan: unknown; }
export interface CheckpointStoryboardRetainedTraceMaterializationResult { readonly packageRoot: string; readonly receipt: CheckpointStoryboardRetainedTraceMaterializationReceipt; readonly workspaceCleanup: "not-attested"; }
interface ApprovedFacts { readonly storyboard: ReturnType<typeof admitCheckpointStoryboardRetainedTraceRecordProfile>; readonly plan: any; readonly expected: C6B7bExactBase; }
interface Staged { readonly receipt: CheckpointStoryboardRetainedTraceMaterializationReceipt; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; readonly expected: C6B7bExactBase; }

/** Reopens host-authorized facts and seals a fresh C6B7a plan; callers never supply a plan authority. */
export async function prepareCheckpointStoryboardRetainedTraceMaterialization(host: CheckpointStoryboardRetainedTraceMaterializationHost, storyboard: unknown): Promise<CheckpointStoryboardRetainedTraceMaterializationPreparation> {
  return await withC6B7bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B7bHost(host, roots), source = await observeC6B7bPackage(roots.sourceRoot, canonical); assertArtifactsAbsent(source);
    const admitted = admitCheckpointStoryboardRetainedTraceRecordProfile(storyboard), plan = await rederive(admitted, source), expected = exactBase(source, plan); const approval = Object.freeze({ [approvalBrand]: "c6b7b-approved" as const }); approvals.set(approval, Object.freeze({ storyboard: admitted, plan, expected }));
    return Object.freeze({ approval, expected, plan });
  });
}

/** Installs exactly the immutable C6B7a plan sidecar and receipt; manifest and Motion bytes never change. */
export async function materializeCheckpointStoryboardRetainedTrace(host: CheckpointStoryboardRetainedTraceMaterializationHost, approval: CheckpointStoryboardRetainedTraceMaterializationApproval, value: unknown): Promise<CheckpointStoryboardRetainedTraceMaterializationResult> {
  const expected = readRequest(value), approved = readApproval(approval);
  return await withC6B7bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B7bHost(host, roots), source = await observeC6B7bPackage(roots.sourceRoot, canonical), plan = await rederive(approved.storyboard, source), exact = exactBase(source, plan);
    if (!c6B7bSame(plan, approved.plan) || !c6B7bSame(exact, approved.expected) || !c6B7bSame(exact, expected)) throw new PackageEditTransactionError("source_changed", "C6B7b source no longer rederives the host-minted exact C6B7a plan.");
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot, outputRoot: roots.outputRoot, requireAbsentOutput: true, closedInventory: "finalize-after-edit-with-empty-directories",
      edit: async (root) => await editStaged(root, canonical, source, approved, exact),
      validate: async (root, staged) => await assertStaged(root, canonical, staged),
      beforeCommit: async () => { const current = await observeC6B7bPackage(roots.sourceRoot, canonical); const currentPlan = await rederive(approved.storyboard, current); if (!c6B7bSame(exact, exactBase(current, currentPlan))) throw new PackageEditTransactionError("source_changed", "C6B7b source changed before output claim."); },
      afterCommit: async (root, staged) => await assertStaged(root, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "not-attested" as const });
  });
}

async function editStaged(root: string, host: CheckpointStoryboardRetainedTraceMaterializationHost, source: C6B7bPackageFacts, approved: ApprovedFacts, expected: C6B7bExactBase): Promise<Staged> {
  const staged = await observeC6B7bPackage(root, host); assertArtifactsAbsent(staged); const plan = await rederive(approved.storyboard, staged);
  if (!c6B7bSame(plan, approved.plan) || !c6B7bSame(expected, exactBase(staged, plan))) throw new PackageEditTransactionError("source_changed", "C6B7b staged package changed after C6B7a planning.");
  await mkdir(join(root, "analysis", "checkpoint-storyboard"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "receipts"), { recursive: true, mode: 0o700 });
  const reserved = await observeC6B7bPackage(root, host); assertDocumentsUnchanged(staged, reserved); const createdDirectories = [...reserved.snapshot.entries].filter(([path, value]) => value === "dir" && !staged.snapshot.entries.has(path)).map(([path]) => path).sort(compareCodeUnits);
  const nonMaterializationInventory = await closedC6B7bInventory(root, host), sidecar = await writeC6B7bSidecar(root, plan), sidecarRead = await readC6B7bSidecar(root);
  if (!c6B7bSame(sidecarRead, plan)) throw new PackageEditTransactionError("copy_mismatch", "C6B7b staged sidecar differs from the exact C6B7a plan.");
  const preReceipt = await observeC6B7bPackage(root, host); assertDocumentsUnchanged(staged, preReceipt);
  const receipt = createC6B7bReceipt({ approval: { storyboard: approved.storyboard, plan, base: expected }, output: { package: preReceipt.base, virtualSourceInventory: source.base.inventory, nonMaterializationInventory, preservedLeaves: c6B7bPreservedLeaves(source.snapshot), createdDirectories, changed: { paths: [C6B7B_SIDECAR_PATH, C6B7B_RECEIPT_PATH], count: 2, motionAndManifest: "unchanged" }, sidecar }, transaction: { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveArtifacts: true, workspaceCleanup: "not-attested" }, renderer: { invoked: false, pixels: false, gpuAbi: "none", upload: "none" } });
  await writeC6B7bReceipt(root, receipt); const snapshot = await snapshotPackageEditTree(root); assertPreservedLeaves(source.snapshot, snapshot); return { receipt, snapshot, expected };
}
async function rederive(storyboard: unknown, facts: C6B7bPackageFacts): Promise<any> { try { assertArtifactsAbsent(facts); return compileCheckpointStoryboardRetainedTraceProfilePlan(requestFor(facts, storyboard)); } catch (error) { throw new PackageEditTransactionError("source_changed", `C6B7b source cannot rederive the sealed C6B7a plan: ${message(error)}`); } }
function requestFor(facts: C6B7bPackageFacts, storyboard: unknown) { const catalog = (storyboard as { readonly objectCatalog?: unknown }).objectCatalog; if (!Array.isArray(catalog) || catalog.length !== 1 || !catalog[0] || typeof catalog[0] !== "object" || typeof (catalog[0] as { readonly objectId?: unknown }).objectId !== "string") throw new PackageEditTransactionError("source_changed", "C6B7b storyboard lacks one exact object binding."); const objectId = (catalog[0] as { readonly objectId: string }).objectId; return { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-request@1", storyboard, base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 }, objectLayerBindings: [{ objectId, layerId: objectId }] }; }
function exactBase(source: C6B7bPackageFacts, plan: any): C6B7bExactBase { const trace = plan?.projection?.trace, binding = plan?.objectLayerBinding; if (!trace || !binding || typeof trace.sourceSha256 !== "string" || typeof trace.fingerprint !== "string" || typeof trace.evidence?.scheduleSha256 !== "string" || binding.layerIndex !== 0 || typeof binding.layerId !== "string" || typeof binding.staticOpacity !== "number") throw new PackageEditTransactionError("source_changed", "C6B7b C6B7a plan lacks exact C4C/source binding identities."); return Object.freeze({ source: source.base, planFingerprint: plan.fingerprint, profileFingerprint: plan.lowererProfile.fingerprint, storyboardId: plan.storyboard.id, storyboardSha256: plan.storyboard.sha256, storyboardRevision: plan.storyboard.revision, sourceLayerId: binding.layerId, sourceLayerIndex: 0, staticOpacity: binding.staticOpacity, traceSourceSha256: trace.sourceSha256, tracePlanFingerprint: trace.fingerprint, scheduleSha256: trace.evidence.scheduleSha256, sourceArtifacts: Object.freeze({ sidecar: "absent" as const, receipt: "absent" as const }) }); }
function assertDocumentsUnchanged(left: C6B7bPackageFacts, right: C6B7bPackageFacts): void { if (left.base.packageId !== right.base.packageId || left.base.manifestRawSha256 !== right.base.manifestRawSha256 || left.base.manifestCanonicalSha256 !== right.base.manifestCanonicalSha256 || left.base.motionRawSha256 !== right.base.motionRawSha256 || left.base.motionCanonicalSha256 !== right.base.motionCanonicalSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B7b changed manifest or Motion bytes."); }
async function assertStaged(root: string, host: CheckpointStoryboardRetainedTraceMaterializationHost, staged: Staged): Promise<void> { const reopened = await observeC6B7bPackage(root, host); if (!samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) throw new PackageEditTransactionError("copy_mismatch", "C6B7b staged tree changed after receipt publication."); const receipt = await readC6B7bReceipt(root); if (!c6B7bSame(receipt, staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B7b receipt differs after reopen."); const output = await reopenCheckpointStoryboardRetainedTraceMaterializationOutput({ outputPackageRoot: root, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }); if (output.planFingerprint !== staged.expected.planFingerprint || output.tracePlanFingerprint !== staged.expected.tracePlanFingerprint) throw new PackageEditTransactionError("copy_mismatch", "C6B7b output-only reopen did not reprove the sealed plan."); }
function assertArtifactsAbsent(facts: C6B7bPackageFacts): void { if (facts.snapshot.entries.has(C6B7B_SIDECAR_PATH) || facts.snapshot.entries.has(C6B7B_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B7b fixed sidecar or receipt already exists."); }
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>): void { const leaves = (snapshot: typeof source) => [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== C6B7B_SIDECAR_PATH && path !== C6B7B_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); if (!c6B7bSame(leaves(source), leaves(output))) throw new PackageEditTransactionError("copy_mismatch", "C6B7b changed a preserved package leaf."); }
function readApproval(value: unknown): ApprovedFacts { const facts = value && typeof value === "object" ? approvals.get(value as CheckpointStoryboardRetainedTraceMaterializationApproval) : undefined; if (!facts) throw new Error("C6B7b materialization approval is not host-minted."); return facts; }
function readRequest(value: unknown): C6B7bExactBase { const root = exactObject(snapshotCheckpointStoryboardData(value), "C6B7b materialization request"); if (!sameKeys(root, ["schema", "expected"]) || root.schema !== REQUEST_SCHEMA) throw new Error("C6B7b materialization request schema is invalid."); return readC6B7bExactBase(root.expected); }
function exactObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
