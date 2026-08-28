/** Output-only C7A3f verifier and detached preview-input reader. It has no package writer. */
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  c7A3fSidecarIdentity,
  readC7A3fReceipt,
  readC7A3fSidecar,
  type C7A3fArtifactIdentity,
} from "./gltf-object-scene-package-artifacts-private.js";
import {
  C7A3F_RECEIPT_PATH,
  C7A3F_SIDECAR_PATH,
  c7A3fInventoryForSnapshot,
  c7A3fPreservedLeaves,
  c7A3fSame,
  closedC7A3fInventory,
  compileC7A3fRecipeBundle,
  observeC7A3fPackage,
  withC7A3fOutputAuthority,
  type C7A3fPackageFacts,
  type C7A3fPlanIdentities,
  type C7A3fSourceIdentity,
  type GltfObjectScenePackageOutputHost,
} from "./gltf-object-scene-package-facts-private.js";

export type { GltfObjectScenePackageOutputHost } from "./gltf-object-scene-package-facts-private.js";

export interface GltfObjectScenePackageInstalledOutput {
  readonly schema: "shellx-motion/private-gltf-object-scene-package-installed-output@1";
  readonly recipeBundleFingerprint: string;
  readonly plans: C7A3fPlanIdentities;
  readonly package: {
    readonly id: string;
    readonly manifestRawSha256: string;
    readonly manifestCanonicalSha256: string;
    readonly motionRawSha256: string;
    readonly motionCanonicalSha256: string;
    readonly inventory: { readonly sha256: string; readonly entryCount: number; readonly leafCount: number };
  };
  readonly source: C7A3fSourceIdentity;
  readonly sidecar: C7A3fArtifactIdentity;
  readonly renderer: { readonly invoked: false; readonly pixels: false; readonly gpuAbi: "none"; readonly upload: "none" };
}

export interface GltfObjectScenePackagePreviewInput {
  readonly schema: "shellx-motion/private-gltf-object-scene-package-preview-input@1";
  readonly installed: GltfObjectScenePackageInstalledOutput;
  readonly evaluationPlan: ReturnType<typeof compileC7A3fRecipeBundle>["evaluationPlan"];
  readonly retainedRenderPlan: ReturnType<typeof compileC7A3fRecipeBundle>["retainedRenderPlan"];
  readonly receiptFingerprint: string;
}

export async function reopenGltfObjectScenePackageMaterializationOutput(host: GltfObjectScenePackageOutputHost): Promise<GltfObjectScenePackageInstalledOutput> {
  return await withC7A3fOutputAuthority(host, async (root, canonical) => {
    const before = await readC7A3fReceipt(root), facts = await observeC7A3fPackage(root, canonical), sidecar = await readC7A3fSidecar(root), compiled = compileC7A3fRecipeBundle(facts, sidecar.recipes);
    assertRecipeLineage(facts, sidecar, compiled, before.approval.base);
    const snapshot = await snapshotPackageEditTree(root), fullInventory = await closedC7A3fInventory(root, canonical), withoutReceipt = c7A3fInventoryForSnapshot(snapshot, [C7A3F_RECEIPT_PATH]), withoutArtifacts = c7A3fInventoryForSnapshot(snapshot, [C7A3F_SIDECAR_PATH, C7A3F_RECEIPT_PATH]), virtual = virtualSourceInventory(snapshot, before.output.createdDirectories), sidecarFacts = c7A3fSidecarIdentity(sidecar);
    if (!c7A3fSame(fullInventory, c7A3fInventoryForSnapshot(snapshot)) || !c7A3fSame(withoutReceipt, before.output.package.inventory) || !c7A3fSame(withoutArtifacts, before.output.nonMaterializationInventory) || !c7A3fSame(virtual, before.output.virtualSourceInventory) || !c7A3fSame(c7A3fPreservedLeaves(snapshot), before.output.preservedLeaves) || !c7A3fSame(sidecarFacts, before.output.sidecar)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f output sidecar, receipt, leaves or complete inventory differs from its fixed receipt.");
    assertPackageDocuments(facts, before.output.package);
    const [afterReceipt, afterFacts, afterSidecar, afterSnapshot, afterInventory] = await Promise.all([readC7A3fReceipt(root), observeC7A3fPackage(root, canonical), readC7A3fSidecar(root), snapshotPackageEditTree(root), closedC7A3fInventory(root, canonical)]);
    if (!c7A3fSame(afterReceipt, before) || !sameFacts(afterFacts, facts) || !c7A3fSame(afterSidecar, sidecar) || !sameSnapshot(afterSnapshot, snapshot) || !c7A3fSame(afterInventory, fullInventory)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f output changed while reopening.");
    return freeze({ schema: "shellx-motion/private-gltf-object-scene-package-installed-output@1" as const, recipeBundleFingerprint: compiled.recipeBundleFingerprint, plans: compiled.plans, package: freeze({ id: facts.base.packageId, manifestRawSha256: facts.base.manifestRawSha256, manifestCanonicalSha256: facts.base.manifestCanonicalSha256, motionRawSha256: facts.base.motionRawSha256, motionCanonicalSha256: facts.base.motionCanonicalSha256, inventory: fullInventory }), source: facts.source, sidecar: sidecarFacts, renderer: freeze({ invoked: false as const, pixels: false as const, gpuAbi: "none" as const, upload: "none" as const }) });
  });
}

/** Recompiles exact compiler-minted runtime authority only after a second complete output reopen. */
export async function reopenGltfObjectScenePackagePreviewInput(host: GltfObjectScenePackageOutputHost): Promise<GltfObjectScenePackagePreviewInput> {
  const installed = await reopenGltfObjectScenePackageMaterializationOutput(host);
  return await withC7A3fOutputAuthority(host, async (root, canonical) => {
    const before = await snapshotPackageEditTree(root), receipt = await readC7A3fReceipt(root), facts = await observeC7A3fPackage(root, canonical), sidecar = await readC7A3fSidecar(root), compiled = compileC7A3fRecipeBundle(facts, sidecar.recipes), inventory = await closedC7A3fInventory(root, canonical), after = await snapshotPackageEditTree(root);
    if (!sameSnapshot(before, after) || !c7A3fSame(inventory, installed.package.inventory) || !c7A3fSame(compiled.plans, installed.plans) || compiled.recipeBundleFingerprint !== installed.recipeBundleFingerprint || receipt.fingerprint.length !== 64 || facts.base.packageId !== installed.package.id || facts.source.sha256 !== installed.source.sha256 || !c7A3fSame(c7A3fSidecarIdentity(sidecar), installed.sidecar)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f preview input changed after its exact installed-output reopen.");
    return freeze({ schema: "shellx-motion/private-gltf-object-scene-package-preview-input@1" as const, installed, evaluationPlan: compiled.evaluationPlan, retainedRenderPlan: compiled.retainedRenderPlan, receiptFingerprint: receipt.fingerprint });
  });
}

function assertRecipeLineage(facts: C7A3fPackageFacts, sidecar: Awaited<ReturnType<typeof readC7A3fSidecar>>, compiled: ReturnType<typeof compileC7A3fRecipeBundle>, base: Awaited<ReturnType<typeof readC7A3fReceipt>>["approval"]["base"]): void {
  if (!c7A3fSame(sidecar.package, base.source) || !samePackageDocumentIdentity(facts.base, base.source) || !c7A3fSame(sidecar.source, base.sourceAsset) || !c7A3fSame(facts.source, base.sourceAsset) || sidecar.recipeBundleFingerprint !== compiled.recipeBundleFingerprint || sidecar.recipeBundleFingerprint !== base.recipeBundleFingerprint || !c7A3fSame(sidecar.plans, compiled.plans) || !c7A3fSame(sidecar.plans, base.plans) || !c7A3fSame(base.sourceArtifacts, { sidecar: "absent", receipt: "absent" })) throw new PackageEditTransactionError("copy_mismatch", "C7A3f output cannot rederive its exact source package and recipe chain.");
}
function assertPackageDocuments(facts: C7A3fPackageFacts, expected: Awaited<ReturnType<typeof readC7A3fReceipt>>["output"]["package"]): void { if (!samePackageDocumentIdentity(facts.base, expected)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f manifest or Motion identity changed after materialization."); }
function samePackageDocumentIdentity(left: C7A3fPackageFacts["base"], right: C7A3fPackageFacts["base"]): boolean { return left.packageId === right.packageId && left.manifestRawSha256 === right.manifestRawSha256 && left.manifestCanonicalSha256 === right.manifestCanonicalSha256 && left.motionRawSha256 === right.motionRawSha256 && left.motionCanonicalSha256 === right.motionCanonicalSha256; }
function virtualSourceInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, created: readonly string[]) { const entries = new Map(snapshot.entries); entries.delete(C7A3F_SIDECAR_PATH); entries.delete(C7A3F_RECEIPT_PATH); for (const path of [...created].reverse()) { if (entries.get(path) !== "dir" || [...entries.keys()].some((other) => other.startsWith(`${path}/`))) throw new PackageEditTransactionError("copy_mismatch", "C7A3f created-directory virtual removal is not exact."); entries.delete(path); } return c7A3fInventoryForSnapshot({ ...snapshot, entries }); }
function sameFacts(left: C7A3fPackageFacts, right: C7A3fPackageFacts): boolean { return samePackageDocumentIdentity(left.base, right.base) && c7A3fSame(left.source, right.source); }
function sameSnapshot(left: Awaited<ReturnType<typeof snapshotPackageEditTree>>, right: Awaited<ReturnType<typeof snapshotPackageEditTree>>): boolean { return left.files === right.files && left.bytes === right.bytes && left.entries.size === right.entries.size && [...left.entries].every(([path, value]) => right.entries.get(path) === value); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
