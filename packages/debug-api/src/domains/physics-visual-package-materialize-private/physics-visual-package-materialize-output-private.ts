/** Output-only C7B4D verifier. It recompiles detached C7B4C authority without rendering. */
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { compilePhysicsBakeAdmissionPlan } from "@shellx-motion/core/internal/scene-recipe";
import { join } from "node:path";
import { reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import { compilePhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  C7B4D_ARTIFACT_ROOT,
  C7B4D_RECEIPT_PATH,
  C7B4D_SIDECAR_PATH,
  c7B4dInventoryForSnapshot,
  c7B4dPreservedSourceLeaves,
  c7B4dSame,
  closedC7B4dInventory,
  isMaterializationPath,
  observeC7B4dPackage,
  sameC7B4dDocuments,
  withC7B4dOutputAuthority,
  type PhysicsVisualPackageOutputHost,
} from "./physics-visual-package-materialize-facts-private.js";
import {
  durableArtifactIdentity,
  physicsVisualPackagePlanIdentities,
  physicsVisualPackageSidecarIdentity,
  readPhysicsVisualPackageReceipt,
  readPhysicsVisualPackageSidecar,
  type PhysicsVisualPackageArtifactFileIdentity,
  type PhysicsVisualPackageArtifactIdentity,
  type PhysicsVisualPackagePlanIdentities,
} from "./physics-visual-package-materialize-artifacts-private.js";

export type { PhysicsVisualPackageOutputHost } from "./physics-visual-package-materialize-facts-private.js";

export interface PhysicsVisualPackageInstalledOutput {
  readonly schema: "shellx-motion/private-physics-visual-package-installed-output@1";
  readonly recipeBundleFingerprint: string;
  readonly presentationStaticFingerprint: string;
  readonly plans: PhysicsVisualPackagePlanIdentities;
  readonly package: {
    readonly id: string;
    readonly manifestRawSha256: string;
    readonly manifestCanonicalSha256: string;
    readonly motionRawSha256: string;
    readonly motionCanonicalSha256: string;
    readonly inventory: { readonly sha256: string; readonly entryCount: number; readonly leafCount: number };
  };
  readonly artifact: PhysicsVisualPackageArtifactIdentity;
  readonly sidecar: PhysicsVisualPackageArtifactFileIdentity;
  readonly receiptFingerprint: string;
  readonly renderer: { readonly invoked: false; readonly pixels: false; readonly providerInvoked: false; readonly videoInvoked: false };
}
export interface PhysicsVisualPackagePreviewInput {
  readonly schema: "shellx-motion/private-physics-visual-package-preview-input@1";
  readonly installed: PhysicsVisualPackageInstalledOutput;
  readonly presentationStaticPlan: ReturnType<typeof compilePhysicsVisualPresentationStaticPlan>;
  readonly receiptFingerprint: string;
}

export async function reopenPhysicsVisualPackageMaterializationOutput(host: PhysicsVisualPackageOutputHost): Promise<PhysicsVisualPackageInstalledOutput> {
  return await withC7B4dOutputAuthority(host, async (root, canonical) => {
    const beforeReceipt = await readPhysicsVisualPackageReceipt(root), facts = await observeC7B4dPackage(root, canonical), sidecar = await readPhysicsVisualPackageSidecar(root), artifactHost = { outputRoot: join(root, C7B4D_ARTIFACT_ROOT), workspaceRoot: canonical.packageWorkspaceRoot, workspaceAuthority: canonical.packageWorkspaceAuthority }, artifact = await reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(artifactHost);
    const chain = await rederive(artifactHost, sidecar.recipes), snapshot = await snapshotPackageEditTree(root), fullInventory = await closedC7B4dInventory(root, canonical), sidecarIdentity = physicsVisualPackageSidecarIdentity(sidecar);
    assertLineage(facts, sidecar, beforeReceipt, durableArtifactIdentity(artifact), chain);
    const withoutReceipt = c7B4dInventoryForSnapshot(snapshot, [C7B4D_RECEIPT_PATH]), withoutSidecarAndReceipt = c7B4dInventoryForSnapshot(snapshot, [C7B4D_SIDECAR_PATH, C7B4D_RECEIPT_PATH]), virtualSource = sourceInventory(snapshot, beforeReceipt.output.createdDirectories);
    if (!c7B4dSame(fullInventory, c7B4dInventoryForSnapshot(snapshot)) || !c7B4dSame(withoutReceipt, beforeReceipt.output.package.inventory) || !c7B4dSame(withoutSidecarAndReceipt, beforeReceipt.output.nonMaterializationInventory) || !c7B4dSame(virtualSource, beforeReceipt.output.virtualSourceInventory) || !c7B4dSame(c7B4dPreservedSourceLeaves(snapshot), beforeReceipt.output.preservedSourceLeaves) || !c7B4dSame(sidecarIdentity, beforeReceipt.output.sidecar)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D output sidecar, receipt, leaves or complete inventory differs from its fixed receipt.");
    const [afterReceipt, afterFacts, afterSidecar, afterSnapshot, afterInventory, afterArtifact] = await Promise.all([
      readPhysicsVisualPackageReceipt(root), observeC7B4dPackage(root, canonical), readPhysicsVisualPackageSidecar(root), snapshotPackageEditTree(root), closedC7B4dInventory(root, canonical), reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(artifactHost),
    ]);
    if (!c7B4dSame(afterReceipt, beforeReceipt) || !sameC7B4dDocuments(afterFacts.documents, facts.documents) || !c7B4dSame(afterSidecar, sidecar) || !sameSnapshot(afterSnapshot, snapshot) || !c7B4dSame(afterInventory, fullInventory) || !c7B4dSame(durableArtifactIdentity(afterArtifact), durableArtifactIdentity(artifact))) throw new PackageEditTransactionError("copy_mismatch", "C7B4D output changed while reopening.");
    return freeze({ schema: "shellx-motion/private-physics-visual-package-installed-output@1" as const, recipeBundleFingerprint: chain.recipeBundleFingerprint, presentationStaticFingerprint: chain.presentation.fingerprint, plans: chain.plans, package: freeze({ id: facts.documents.packageId, manifestRawSha256: facts.documents.manifestRawSha256, manifestCanonicalSha256: facts.documents.manifestCanonicalSha256, motionRawSha256: facts.documents.motionRawSha256, motionCanonicalSha256: facts.documents.motionCanonicalSha256, inventory: fullInventory }), artifact: chain.artifact, sidecar: sidecarIdentity, receiptFingerprint: beforeReceipt.fingerprint, renderer: freeze({ invoked: false as const, pixels: false as const, providerInvoked: false as const, videoInvoked: false as const }) });
  });
}

/** Returns only freshly compiler-minted C7B4C authority and installed identities. */
export async function reopenPhysicsVisualPackagePreviewInput(host: PhysicsVisualPackageOutputHost): Promise<PhysicsVisualPackagePreviewInput> {
  const installed = await reopenPhysicsVisualPackageMaterializationOutput(host);
  return await withC7B4dOutputAuthority(host, async (root, canonical) => {
    const receipt = await readPhysicsVisualPackageReceipt(root), sidecar = await readPhysicsVisualPackageSidecar(root), artifactHost = { outputRoot: join(root, C7B4D_ARTIFACT_ROOT), workspaceRoot: canonical.packageWorkspaceRoot, workspaceAuthority: canonical.packageWorkspaceAuthority }, chain = await rederive(artifactHost, sidecar.recipes), after = await snapshotPackageEditTree(root);
    if (receipt.fingerprint !== installed.receiptFingerprint || chain.presentation.fingerprint !== installed.presentationStaticFingerprint || !c7B4dSame(chain.plans, installed.plans) || chain.recipeBundleFingerprint !== installed.recipeBundleFingerprint || !c7B4dSame(physicsVisualPackageSidecarIdentity(sidecar), installed.sidecar) || !c7B4dSame(c7B4dInventoryForSnapshot(after), installed.package.inventory)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D preview authority changed after installed-output reopen.");
    return freeze({ schema: "shellx-motion/private-physics-visual-package-preview-input@1" as const, installed, presentationStaticPlan: chain.presentation, receiptFingerprint: receipt.fingerprint });
  });
}

async function rederive(artifactHost: { readonly outputRoot: string; readonly workspaceRoot: string; readonly workspaceAuthority: PhysicsVisualPackageOutputHost["packageWorkspaceAuthority"] }, recipes: unknown) {
  try {
    const physics = compilePhysicsBakeAdmissionPlan((recipes as { readonly physicsBake: unknown }).physicsBake), artifactBefore = await reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(artifactHost), visual = await compilePhysicsVisualBindingPlan(physics, artifactHost, (recipes as { readonly visualBinding: unknown }).visualBinding), retained = compilePhysicsVisualRetainedStaticPlan(visual, (recipes as { readonly retainedRender: unknown }).retainedRender), presentation = compilePhysicsVisualPresentationStaticPlan(retained, physics, (recipes as { readonly presentation: unknown }).presentation), artifactAfter = await reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(artifactHost), artifact = durableArtifactIdentity(artifactAfter);
    if (!c7B4dSame(artifactBefore.manifest, artifactAfter.manifest) || !c7B4dSame(artifactBefore.receipt, artifactAfter.receipt) || physics.fingerprint !== artifact.planFingerprint || physics.recipeSha256 !== artifact.recipeSha256 || visual.source.durableManifestFingerprint !== artifact.manifestFingerprint || visual.source.durableReceiptFingerprint !== artifact.receiptFingerprint) throw new Error("embedded C7B3 artifact does not match C7B1 or changed during C7B4D rederivation");
    const canonicalRecipes = { physicsBake: physics.recipe, visualBinding: visual.recipe, retainedRender: retained.recipe, presentation: presentation.recipe };
    return Object.freeze({ recipeBundleFingerprint: canonicalJsonSha256(canonicalRecipes), artifact, plans: physicsVisualPackagePlanIdentities(physics, visual, retained, presentation), presentation });
  } catch (error) {
    throw new PackageEditTransactionError("copy_mismatch", `C7B4D installed recipe chain cannot be recompiled: ${message(error)}`);
  }
}

function assertLineage(facts: Awaited<ReturnType<typeof observeC7B4dPackage>>, sidecar: Awaited<ReturnType<typeof readPhysicsVisualPackageSidecar>>, receipt: Awaited<ReturnType<typeof readPhysicsVisualPackageReceipt>>, artifact: PhysicsVisualPackageArtifactIdentity, chain: Awaited<ReturnType<typeof rederive>>): void {
  if (!c7B4dSame(sidecar.package, receipt.approval.base.sourcePackage) || !sameC7B4dDocuments(facts.documents, sidecar.package) || !sameC7B4dDocuments(facts.documents, receipt.output.package) || !c7B4dSame(sidecar.artifact, artifact) || !c7B4dSame(receipt.approval.base.externalArtifact, artifact) || !c7B4dSame(receipt.output.embeddedArtifact, artifact) || sidecar.recipeBundleFingerprint !== chain.recipeBundleFingerprint || sidecar.recipeBundleFingerprint !== receipt.approval.base.recipeBundleFingerprint || !c7B4dSame(sidecar.plans, chain.plans) || !c7B4dSame(sidecar.plans, receipt.approval.base.plans) || !c7B4dSame(receipt.approval.base.sourceArtifacts, { physicsBake: "absent", sidecar: "absent", receipt: "absent" })) throw new PackageEditTransactionError("copy_mismatch", "C7B4D output cannot rederive its exact source package, C7B3 artifact and recipe chain.");
}
function sourceInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, created: readonly string[]) {
  const entries = new Map(snapshot.entries);
  for (const [path, value] of entries) if (isMaterializationPath(path) && value.startsWith("file:")) entries.delete(path);
  for (const path of [...created].reverse()) {
    if (entries.get(path) !== "dir" || [...entries.keys()].some((other) => other.startsWith(`${path}/`))) throw new PackageEditTransactionError("copy_mismatch", "C7B4D created-directory virtual removal is not exact.");
    entries.delete(path);
  }
  return c7B4dInventoryForSnapshot({ ...snapshot, entries });
}
function sameSnapshot(left: Awaited<ReturnType<typeof snapshotPackageEditTree>>, right: Awaited<ReturnType<typeof snapshotPackageEditTree>>): boolean { return left.files === right.files && left.bytes === right.bytes && left.entries.size === right.entries.size && [...left.entries].every(([path, value]) => right.entries.get(path) === value); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
