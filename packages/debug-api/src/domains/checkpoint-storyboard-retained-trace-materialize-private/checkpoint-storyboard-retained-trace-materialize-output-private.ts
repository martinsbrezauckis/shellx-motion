/** Output-only C6B7b verifier. It has no source, approval, writer, renderer, or GPU authority. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { compileCheckpointStoryboardRetainedTraceProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-retained-trace-profile";
import type { MotionPackage } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B7B_RECEIPT_PATH, C6B7B_SIDECAR_PATH, c6B7bInventoryForSnapshot, c6B7bPreservedLeaves, c6B7bSame, closedC6B7bInventory, observeC6B7bPackage, type CheckpointStoryboardRetainedTraceMaterializationOutputHost } from "./checkpoint-storyboard-retained-trace-materialize-facts-private.js";
import { readC6B7bReceipt, readC6B7bSidecar, sidecarIdentity, type C6B7bArtifactIdentity } from "./checkpoint-storyboard-retained-trace-materialize-receipt-private.js";
export type { CheckpointStoryboardRetainedTraceMaterializationOutputHost } from "./checkpoint-storyboard-retained-trace-materialize-facts-private.js";
export interface CheckpointStoryboardRetainedTraceMaterializationInstalledOutput { readonly schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-materialization-installed-output@1"; readonly planFingerprint: string; readonly profileFingerprint: string; readonly tracePlanFingerprint: string; readonly package: { readonly id: string; readonly manifestRawSha256: string; readonly manifestCanonicalSha256: string; readonly motionRawSha256: string; readonly motionCanonicalSha256: string; readonly inventory: { readonly sha256: string; readonly entryCount: number; readonly leafCount: number }; }; readonly sidecar: C6B7bArtifactIdentity; readonly renderer: { readonly invoked: false; readonly pixels: false; readonly gpuAbi: "none"; readonly upload: "none"; }; }
export interface CheckpointStoryboardRetainedTracePreviewInput {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-input@1";
  readonly installed: CheckpointStoryboardRetainedTraceMaterializationInstalledOutput;
  readonly plan: ReturnType<typeof compileCheckpointStoryboardRetainedTraceProfilePlan>;
  readonly package: MotionPackage;
  readonly receiptFingerprint: string;
}

export async function reopenCheckpointStoryboardRetainedTraceMaterializationOutput(host: CheckpointStoryboardRetainedTraceMaterializationOutputHost): Promise<CheckpointStoryboardRetainedTraceMaterializationInstalledOutput> {
  return await withOutputAuthority(host, async (root, canonical) => {
    const before = await readC6B7bReceipt(root), output = await observeC6B7bPackage(root, canonical), sidecar = await readC6B7bSidecar(root), plan = rederive(before.approval.storyboard, output);
    if (!c6B7bSame(plan, before.approval.plan) || !c6B7bSame(plan, sidecar) || plan.fingerprint !== before.approval.base.planFingerprint || plan.lowererProfile.fingerprint !== before.approval.base.profileFingerprint || plan.objectLayerBinding.layerId !== before.approval.base.sourceLayerId || plan.objectLayerBinding.layerIndex !== before.approval.base.sourceLayerIndex || plan.objectLayerBinding.staticOpacity !== before.approval.base.staticOpacity || plan.projection.trace.sourceSha256 !== before.approval.base.traceSourceSha256 || plan.projection.trace.fingerprint !== before.approval.base.tracePlanFingerprint || plan.projection.trace.evidence.scheduleSha256 !== before.approval.base.scheduleSha256 || !c6B7bSame(before.approval.base.sourceArtifacts, { sidecar: "absent", receipt: "absent" })) throw new PackageEditTransactionError("copy_mismatch", "C6B7b sidecar does not rederive the sealed C6B7a plan.");
    const source = before.approval.base.source;
    if (output.base.packageId !== source.packageId || output.base.manifestRawSha256 !== source.manifestRawSha256 || output.base.manifestCanonicalSha256 !== source.manifestCanonicalSha256 || output.base.motionRawSha256 !== source.motionRawSha256 || output.base.motionCanonicalSha256 !== source.motionCanonicalSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B7b manifest or Motion identity changed after materialization.");
    const snapshot = await snapshotPackageEditTree(root), fullInventory = await closedC6B7bInventory(root, canonical), withoutReceipt = c6B7bInventoryForSnapshot(snapshot, [C6B7B_RECEIPT_PATH]), withoutArtifacts = c6B7bInventoryForSnapshot(snapshot, [C6B7B_SIDECAR_PATH, C6B7B_RECEIPT_PATH]), virtual = virtualSourceInventory(snapshot, before.output.createdDirectories);
    const sidecarFacts = sidecarIdentity(sidecar);
    if (!c6B7bSame(fullInventory, c6B7bInventoryForSnapshot(snapshot)) || !c6B7bSame(withoutReceipt, before.output.package.inventory) || !c6B7bSame(withoutArtifacts, before.output.nonMaterializationInventory) || !c6B7bSame(virtual, before.output.virtualSourceInventory) || !c6B7bSame(c6B7bPreservedLeaves(snapshot), before.output.preservedLeaves) || !c6B7bSame(sidecarFacts, before.output.sidecar)) throw new PackageEditTransactionError("copy_mismatch", "C6B7b output sidecar, receipt, leaves, or complete inventory differs from its fixed receipt.");
    const [after, afterOutput, afterSidecar, afterSnapshot, afterInventory] = await Promise.all([readC6B7bReceipt(root), observeC6B7bPackage(root, canonical), readC6B7bSidecar(root), snapshotPackageEditTree(root), closedC6B7bInventory(root, canonical)]);
    if (!c6B7bSame(after, before) || !sameDocuments(afterOutput, output) || !c6B7bSame(afterSidecar, sidecar) || !sameSnapshot(afterSnapshot, snapshot) || !c6B7bSame(afterInventory, fullInventory)) throw new PackageEditTransactionError("copy_mismatch", "C6B7b output changed while reopening.");
    return freeze({ schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-materialization-installed-output@1", planFingerprint: plan.fingerprint, profileFingerprint: plan.lowererProfile.fingerprint, tracePlanFingerprint: plan.projection.trace.fingerprint, package: freeze({ id: output.base.packageId, manifestRawSha256: output.base.manifestRawSha256, manifestCanonicalSha256: output.base.manifestCanonicalSha256, motionRawSha256: output.base.motionRawSha256, motionCanonicalSha256: output.base.motionCanonicalSha256, inventory: fullInventory }), sidecar: sidecarFacts, renderer: freeze({ invoked: false as const, pixels: false as const, gpuAbi: "none" as const, upload: "none" as const }) });
  });
}

/**
 * Preview-only output reopen. It returns detached in-memory data after a second complete output
 * verification; no source path, writer, renderer, GPU, or publication authority crosses this seam.
 */
export async function reopenCheckpointStoryboardRetainedTracePreviewInput(host: CheckpointStoryboardRetainedTraceMaterializationOutputHost): Promise<CheckpointStoryboardRetainedTracePreviewInput> {
  const installed = await reopenCheckpointStoryboardRetainedTraceMaterializationOutput(host);
  return await withOutputAuthority(host, async (root, canonical) => {
    const before = await snapshotPackageEditTree(root);
    const [receipt, observed, sidecar, inventory] = await Promise.all([
      readC6B7bReceipt(root),
      observeC6B7bPackage(root, canonical),
      readC6B7bSidecar(root),
      closedC6B7bInventory(root, canonical),
    ]);
    const plan = rederive(receipt.approval.storyboard, observed);
    const after = await snapshotPackageEditTree(root);
    if (!sameSnapshot(before, after)
      || !c6B7bSame(inventory, installed.package.inventory)
      || !c6B7bSame(sidecar, plan)
      || !c6B7bSame(receipt.approval.plan, plan)
      || receipt.fingerprint.length !== 64
      || plan.fingerprint !== installed.planFingerprint
      || plan.lowererProfile.fingerprint !== installed.profileFingerprint
      || plan.projection.trace.fingerprint !== installed.tracePlanFingerprint
      || observed.base.packageId !== installed.package.id
      || observed.base.manifestRawSha256 !== installed.package.manifestRawSha256
      || observed.base.manifestCanonicalSha256 !== installed.package.manifestCanonicalSha256
      || observed.base.motionRawSha256 !== installed.package.motionRawSha256
      || observed.base.motionCanonicalSha256 !== installed.package.motionCanonicalSha256) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B7b preview input changed after its exact installed-output reopen.");
    }
    const admittedPackage = freeze({
      root: `/shellx-motion-c6c-b7-admitted/${installed.planFingerprint}`,
      manifest: structuredClone(observed.pkg.manifest),
      motion: structuredClone(observed.pkg.motion),
    }) as MotionPackage;
    return freeze({
      schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-input@1" as const,
      installed,
      plan,
      package: admittedPackage,
      receiptFingerprint: receipt.fingerprint,
    });
  });
}

function rederive(storyboard: unknown, facts: Awaited<ReturnType<typeof observeC6B7bPackage>>): ReturnType<typeof compileCheckpointStoryboardRetainedTraceProfilePlan> { try { const catalog = (storyboard as { readonly objectCatalog?: unknown }).objectCatalog; if (!Array.isArray(catalog) || catalog.length !== 1 || !catalog[0] || typeof catalog[0] !== "object" || typeof (catalog[0] as { readonly objectId?: unknown }).objectId !== "string") throw new Error("missing exact object binding"); const objectId = (catalog[0] as { readonly objectId: string }).objectId; return compileCheckpointStoryboardRetainedTraceProfilePlan({ schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-request@1", storyboard, base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 }, objectLayerBindings: [{ objectId, layerId: objectId }] }); } catch (error) { throw new PackageEditTransactionError("copy_mismatch", `C6B7b output cannot rederive its sealed C6B7a plan: ${message(error)}`); } }
function virtualSourceInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, created: readonly string[]) { const entries = new Map(snapshot.entries); entries.delete(C6B7B_SIDECAR_PATH); entries.delete(C6B7B_RECEIPT_PATH); for (const path of [...created].reverse()) { if (entries.get(path) !== "dir" || [...entries.keys()].some((other) => other.startsWith(`${path}/`))) throw new PackageEditTransactionError("copy_mismatch", "C6B7b created-directory virtual removal is not exact."); entries.delete(path); } return c6B7bInventoryForSnapshot({ ...snapshot, entries }); }
async function withOutputAuthority<T>(host: CheckpointStoryboardRetainedTraceMaterializationOutputHost, operation: (root: string, canonical: CheckpointStoryboardRetainedTraceMaterializationOutputHost) => Promise<T>): Promise<T> { const workspace = resolve(host.packageWorkspaceRoot), spelling = resolve(host.outputPackageRoot); if (!descendant(workspace, spelling)) throw new PackageEditTransactionError("unsafe_output", "C6B7b output must be a strict workspace descendant."); try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspace); } catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B7b output workspace authority is invalid: ${message(error)}`); } return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => { const before = await lstat(spelling); if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B7b output is not a trusted directory."); const root = await realpath(spelling); const after = await lstat(root); if (root !== spelling || !descendant(workspace, root) || !after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C6B7b output changed while canonicalizing."); return await operation(root, Object.freeze({ outputPackageRoot: root, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: host.packageWorkspaceAuthority })); }); }
function sameDocuments(left: Awaited<ReturnType<typeof observeC6B7bPackage>>, right: Awaited<ReturnType<typeof observeC6B7bPackage>>): boolean { return left.base.packageId === right.base.packageId && left.base.manifestRawSha256 === right.base.manifestRawSha256 && left.base.motionRawSha256 === right.base.motionRawSha256 && left.base.manifestCanonicalSha256 === right.base.manifestCanonicalSha256 && left.base.motionCanonicalSha256 === right.base.motionCanonicalSha256; }
function sameSnapshot(left: Awaited<ReturnType<typeof snapshotPackageEditTree>>, right: Awaited<ReturnType<typeof snapshotPackageEditTree>>): boolean { return left.files === right.files && left.bytes === right.bytes && left.entries.size === right.entries.size && [...left.entries].every(([path, value]) => right.entries.get(path) === value); }
function descendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
