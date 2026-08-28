/** Private C7B4D renderer-neutral physics-visual package COW. It registers no command. */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compilePhysicsBakeAdmissionPlan, snapshotSceneRecipeData } from "@shellx-motion/core/internal/scene-recipe";
import { commitPackageEdit, PackageEditTransactionError } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { copyPhysicsBakeDurableArtifactIntoPrivateStage, reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import { compilePhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { requirePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-authority-private.js";
import {
  createPhysicsVisualPackageReceipt,
  createPhysicsVisualPackageSidecar,
  durableArtifactIdentity,
  exactPhysicsVisualPackageBase,
  physicsVisualPackagePlanIdentities,
  readPhysicsVisualPackageExactBase,
  readPhysicsVisualPackageRecipeBundle,
  readPhysicsVisualPackageReceipt,
  readPhysicsVisualPackageSidecar,
  writePhysicsVisualPackageReceipt,
  writePhysicsVisualPackageSidecar,
  type PhysicsVisualPackageExactBase,
  type PhysicsVisualPackageMaterializationReceipt,
  type PhysicsVisualPackagePlanIdentities,
  type PhysicsVisualPackageRecipeBundle,
  type PhysicsVisualPackageSidecar,
} from "./physics-visual-package-materialize-artifacts-private.js";
import {
  C7B4D_ARTIFACT_ROOT,
  C7B4D_RECEIPT_PATH,
  C7B4D_SIDECAR_PATH,
  assertC7B4dArtifactsAbsent,
  c7B4dPreservedSourceLeaves,
  c7B4dSame,
  canonicalC7B4dHost,
  observeC7B4dPackage,
  sameC7B4dDocuments,
  withC7B4dMaterializationAuthority,
  type C7B4dCanonicalRoots,
  type C7B4dPackageFacts,
  type PhysicsVisualPackageMaterializationHost,
} from "./physics-visual-package-materialize-facts-private.js";
import { reopenPhysicsVisualPackageMaterializationOutput } from "./physics-visual-package-materialize-output-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-physics-visual-package-materialization-request@1" as const;
const approvalBrand: unique symbol = Symbol("physics-visual-package-materialization-approval");
const approvals = new WeakMap<PhysicsVisualPackageMaterializationApproval, ApprovedFacts>();
const consumed = new WeakSet<PhysicsVisualPackageMaterializationApproval>();

export type { PhysicsVisualPackageMaterializationHost } from "./physics-visual-package-materialize-facts-private.js";
export type { PhysicsVisualPackageMaterializationReceipt } from "./physics-visual-package-materialize-artifacts-private.js";
export { reopenPhysicsVisualPackageMaterializationOutput, reopenPhysicsVisualPackagePreviewInput } from "./physics-visual-package-materialize-output-private.js";

export interface PhysicsVisualPackageMaterializationApproval { readonly [approvalBrand]: "c7b4d-approved" }
export interface PhysicsVisualPackageMaterializationPreparation {
  readonly approval: PhysicsVisualPackageMaterializationApproval;
  readonly expected: PhysicsVisualPackageExactBase;
  readonly sidecar: PhysicsVisualPackageSidecar;
}
export interface PhysicsVisualPackageMaterializationResult {
  readonly packageRoot: string;
  readonly receipt: PhysicsVisualPackageMaterializationReceipt;
  readonly workspaceCleanup: "not-attested";
}
interface ApprovedFacts {
  readonly roots: C7B4dCanonicalRoots;
  readonly packageWorkspaceAuthority: PhysicsVisualPackageMaterializationHost["packageWorkspaceAuthority"];
  readonly physicsWorkspaceAuthority: PhysicsVisualPackageMaterializationHost["physicsWorkspaceAuthority"];
  readonly expected: PhysicsVisualPackageExactBase;
  readonly sidecar: PhysicsVisualPackageSidecar;
}
interface CompiledChain {
  readonly recipes: PhysicsVisualPackageRecipeBundle;
  readonly artifact: ReturnType<typeof durableArtifactIdentity>;
  readonly plans: PhysicsVisualPackagePlanIdentities;
  readonly presentation: ReturnType<typeof compilePhysicsVisualPresentationStaticPlan>;
}
interface Staged {
  readonly receipt: PhysicsVisualPackageMaterializationReceipt;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
  readonly expected: PhysicsVisualPackageExactBase;
}

/** Reopens both source roots, rederives C7B1-A-B-C, and mints one in-process approval. */
export async function preparePhysicsVisualPackageMaterialization(host: PhysicsVisualPackageMaterializationHost, staticPlan: unknown, recipes: unknown): Promise<PhysicsVisualPackageMaterializationPreparation> {
  return await withC7B4dMaterializationAuthority(host, async (roots) => {
    const canonical = canonicalC7B4dHost(host, roots), source = await observeC7B4dPackage(roots.sourcePackageRoot, canonical);
    assertC7B4dArtifactsAbsent(source);
    const chain = await compileChain(roots.physicsHost, recipes, staticPlan);
    const sidecar = createPhysicsVisualPackageSidecar({ package: source.base, artifact: chain.artifact, recipes: chain.recipes, plans: chain.plans });
    const expected = exactPhysicsVisualPackageBase(source.base, chain.artifact, sidecar), approval = Object.freeze({ [approvalBrand]: "c7b4d-approved" as const });
    approvals.set(approval, Object.freeze({ roots, packageWorkspaceAuthority: host.packageWorkspaceAuthority, physicsWorkspaceAuthority: host.physicsWorkspaceAuthority, expected, sidecar }));
    return Object.freeze({ approval, expected, sidecar });
  });
}

/** Installs only fixed C7B3 bytes plus canonical recipe data and an identity-only receipt. */
export async function materializePhysicsVisualPackage(host: PhysicsVisualPackageMaterializationHost, approval: PhysicsVisualPackageMaterializationApproval, value: unknown): Promise<PhysicsVisualPackageMaterializationResult> {
  const requested = readRequest(value), approved = readApproval(approval);
  return await withC7B4dMaterializationAuthority(host, async (roots) => {
    if (!sameApprovedRoots(roots, approved.roots) || host.packageWorkspaceAuthority !== approved.packageWorkspaceAuthority || host.physicsWorkspaceAuthority !== approved.physicsWorkspaceAuthority) throw new PackageEditTransactionError("unsafe_output", "C7B4D approval is bound to different package or C7B3 workspace authority.");
    const canonical = canonicalC7B4dHost(host, roots), source = await observeC7B4dPackage(roots.sourcePackageRoot, canonical);
    assertC7B4dArtifactsAbsent(source);
    const chain = await compileChain(roots.physicsHost, approved.sidecar.recipes);
    const sidecar = createPhysicsVisualPackageSidecar({ package: source.base, artifact: chain.artifact, recipes: chain.recipes, plans: chain.plans });
    const exact = exactPhysicsVisualPackageBase(source.base, chain.artifact, sidecar);
    if (!c7B4dSame(sidecar, approved.sidecar) || !c7B4dSame(exact, approved.expected) || !c7B4dSame(exact, requested)) throw new PackageEditTransactionError("source_changed", "C7B4D source no longer rederives the host-minted C7B1-A-B-C identity chain.");
    if (consumed.has(approval)) throw new PackageEditTransactionError("source_changed", "C7B4D materialization approval has already been consumed.");
    consumed.add(approval);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourcePackageRoot,
      outputRoot: roots.outputPackageRoot,
      requireAbsentOutput: true,
      closedInventory: "finalize-after-edit-with-empty-directories",
      edit: async (root) => await editStaged(root, canonical, source, approved, exact),
      validate: async (root, staged) => await assertStaged(root, canonical, staged),
      beforeCommit: async () => {
        const current = await observeC7B4dPackage(roots.sourcePackageRoot, canonical);
        assertC7B4dArtifactsAbsent(current);
        const currentChain = await compileChain(roots.physicsHost, approved.sidecar.recipes), currentSidecar = createPhysicsVisualPackageSidecar({ package: current.base, artifact: currentChain.artifact, recipes: currentChain.recipes, plans: currentChain.plans }), currentExact = exactPhysicsVisualPackageBase(current.base, currentChain.artifact, currentSidecar);
        if (!c7B4dSame(currentExact, exact)) throw new PackageEditTransactionError("source_changed", "C7B4D source package or external C7B3 artifact changed before output claim.");
      },
      afterCommit: async (root, staged) => {
        const output = await reopenPhysicsVisualPackageMaterializationOutput({ outputPackageRoot: root, packageWorkspaceRoot: canonical.packageWorkspaceRoot, packageWorkspaceAuthority: canonical.packageWorkspaceAuthority });
        if (output.presentationStaticFingerprint !== staged.expected.plans.presentationStaticFingerprint) throw new PackageEditTransactionError("copy_mismatch", "C7B4D installed output did not rederive the approved C7B4C plan.");
      },
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "not-attested" as const });
  });
}

async function editStaged(root: string, host: PhysicsVisualPackageMaterializationHost, source: C7B4dPackageFacts, approved: ApprovedFacts, expected: PhysicsVisualPackageExactBase): Promise<Staged> {
  const staged = await observeC7B4dPackage(root, host);
  assertC7B4dArtifactsAbsent(staged);
  assertDocumentsUnchanged(source, staged);
  const artifactRoot = await privateEmbeddedArtifactRoot(root);
  await mkdir(join(root, "analysis"), { recursive: true, mode: 0o700 });
  await assertPrivateStageDirectory(root, join(root, "analysis"));
  await mkdir(artifactRoot, { mode: 0o700 });
  await assertPrivateStageDirectory(root, artifactRoot);
  const embedded = await copyPhysicsBakeDurableArtifactIntoPrivateStage(approved.roots.physicsHost, {
    outputRoot: artifactRoot,
    workspaceRoot: host.packageWorkspaceRoot,
    workspaceAuthority: host.packageWorkspaceAuthority,
  });
  if (!c7B4dSame(durableArtifactIdentity(embedded), approved.expected.externalArtifact)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D embedded C7B3 artifact differs from the approved external artifact.");
  await mkdir(join(root, "analysis", "scene-recipe"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "receipts"), { recursive: true, mode: 0o700 });
  const reserved = await observeC7B4dPackage(root, host);
  assertDocumentsUnchanged(source, reserved);
  const embeddedHost = { outputRoot: artifactRoot, workspaceRoot: host.packageWorkspaceRoot, workspaceAuthority: host.packageWorkspaceAuthority };
  const chain = await compileChain(embeddedHost, approved.sidecar.recipes), sidecar = createPhysicsVisualPackageSidecar({ package: source.base, artifact: chain.artifact, recipes: chain.recipes, plans: chain.plans });
  if (!c7B4dSame(sidecar, approved.sidecar) || !c7B4dSame(expected.externalArtifact, chain.artifact)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D staged embedded artifact did not rederive the approved canonical recipe chain.");
  const createdDirectories = [...reserved.snapshot.entries].filter(([path, kind]) => kind === "dir" && !source.snapshot.entries.has(path)).map(([path]) => path).sort();
  const nonMaterializationInventory = reserved.base.inventory, sidecarIdentity = await writePhysicsVisualPackageSidecar(root, sidecar), sidecarRead = await readPhysicsVisualPackageSidecar(root);
  if (!c7B4dSame(sidecarRead, sidecar)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D staged sidecar differs from the exact canonical recipe chain.");
  const preReceipt = await observeC7B4dPackage(root, host);
  assertDocumentsUnchanged(source, preReceipt);
  const receipt = createPhysicsVisualPackageReceipt({
    approval: { base: expected },
    output: {
      package: preReceipt.base,
      virtualSourceInventory: source.base.inventory,
      nonMaterializationInventory,
      preservedSourceLeaves: c7B4dPreservedSourceLeaves(source.snapshot),
      createdDirectories,
      changed: { physicsBake: C7B4D_ARTIFACT_ROOT, sidecar: C7B4D_SIDECAR_PATH, receipt: C7B4D_RECEIPT_PATH, manifestAndMotion: "unchanged" },
      sidecar: sidecarIdentity,
      embeddedArtifact: chain.artifact,
    },
    transaction: { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveArtifacts: true, workspaceCleanup: "not-attested" },
    evidence: { rendererInvoked: false, pixels: false, providerInvoked: false, videoInvoked: false },
  });
  await writePhysicsVisualPackageReceipt(root, receipt);
  const snapshot = await snapshotPackageEditTree(root);
  assertPreservedSourceLeaves(source.snapshot, snapshot);
  return { receipt, snapshot, expected };
}

async function assertStaged(root: string, host: PhysicsVisualPackageMaterializationHost, staged: Staged): Promise<void> {
  const snapshot = await snapshotPackageEditTree(root);
  if (!samePackageEditTreeSnapshot(snapshot, staged.snapshot)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D staged tree changed after receipt publication.");
  const receipt = await readPhysicsVisualPackageReceipt(root);
  if (!c7B4dSame(receipt, staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D receipt differs after reopen.");
  const output = await reopenPhysicsVisualPackageMaterializationOutput({ outputPackageRoot: root, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority });
  if (output.presentationStaticFingerprint !== staged.expected.plans.presentationStaticFingerprint || output.receiptFingerprint !== receipt.fingerprint) throw new PackageEditTransactionError("copy_mismatch", "C7B4D output-only reopen did not reprove the sealed C7B1-A-B-C chain.");
}

async function compileChain(artifactHost: { readonly outputRoot: string; readonly workspaceRoot: string; readonly workspaceAuthority: PhysicsVisualPackageMaterializationHost["packageWorkspaceAuthority"] }, value: unknown, suppliedStaticPlan?: unknown): Promise<CompiledChain> {
  const input = readPhysicsVisualPackageRecipeBundle(snapshotSceneRecipeData(value));
  try {
    const physics = compilePhysicsBakeAdmissionPlan(input.physicsBake);
    const artifactBefore = await reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(artifactHost);
    const visual = await compilePhysicsVisualBindingPlan(physics, artifactHost, input.visualBinding);
    const retained = compilePhysicsVisualRetainedStaticPlan(visual, input.retainedRender);
    const presentation = compilePhysicsVisualPresentationStaticPlan(retained, physics, input.presentation);
    const artifactAfter = await reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(artifactHost), artifact = durableArtifactIdentity(artifactAfter);
    if (!c7B4dSame(artifactBefore.manifest, artifactAfter.manifest) || !c7B4dSame(artifactBefore.receipt, artifactAfter.receipt) || visual.source.durableManifestFingerprint !== artifact.manifestFingerprint || visual.source.durableReceiptFingerprint !== artifact.receiptFingerprint || physics.fingerprint !== artifact.planFingerprint || physics.recipeSha256 !== artifact.recipeSha256) throw new Error("C7B4D external C7B3 artifact changed or does not match C7B1.");
    if (suppliedStaticPlan !== undefined) {
      const supplied = requirePhysicsVisualPresentationStaticPlan(suppliedStaticPlan);
      if (!c7B4dSame(supplied.plan, presentation) || supplied.physics.fingerprint !== physics.fingerprint) throw new Error("C7B4D requires the exact terminal compiler-minted C7B4C static plan.");
    }
    const recipes = Object.freeze({ physicsBake: physics.recipe, visualBinding: visual.recipe, retainedRender: retained.recipe, presentation: presentation.recipe });
    const plans = physicsVisualPackagePlanIdentities(physics, visual, retained, presentation);
    return Object.freeze({ recipes, artifact, plans, presentation });
  } catch (error) {
    throw new PackageEditTransactionError("source_changed", `C7B4D recipe chain cannot be compiled from the exact C7B3 artifact: ${message(error)}`);
  }
}

async function privateEmbeddedArtifactRoot(stageRoot: string): Promise<string> {
  const stage = resolve(stageRoot), artifact = resolve(stage, C7B4D_ARTIFACT_ROOT), suffix = relative(stage, artifact);
  const before = await lstat(stage);
  if (!before.isDirectory() || before.isSymbolicLink() || suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || await realpath(stage) !== stage) throw new PackageEditTransactionError("unsafe_output", "C7B4D private embedded artifact destination is outside the canonical package stage.");
  return artifact;
}
async function assertPrivateStageDirectory(stageRoot: string, directory: string): Promise<void> {
  const stage = await lstat(stageRoot), entry = await lstat(directory), canonical = await realpath(directory), suffix = relative(stageRoot, directory);
  if (!stage.isDirectory() || stage.isSymbolicLink() || !entry.isDirectory() || entry.isSymbolicLink() || canonical !== directory || suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || entry.dev !== stage.dev) throw new PackageEditTransactionError("unsafe_output", "C7B4D embedded artifact destination escaped the private package stage.");
}
function assertDocumentsUnchanged(source: C7B4dPackageFacts, current: C7B4dPackageFacts): void { if (!sameC7B4dDocuments(source.documents, current.documents)) throw new PackageEditTransactionError("copy_mismatch", "C7B4D changed manifest or Motion bytes."); }
function assertPreservedSourceLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>): void { if (!c7B4dSame(c7B4dPreservedSourceLeaves(source), c7B4dPreservedSourceLeaves(output))) throw new PackageEditTransactionError("copy_mismatch", "C7B4D changed a preserved source package leaf."); }
function sameApprovedRoots(left: C7B4dCanonicalRoots, right: C7B4dCanonicalRoots): boolean {
  return left.packageWorkspaceRoot === right.packageWorkspaceRoot
    && left.sourcePackageRoot === right.sourcePackageRoot
    && left.outputPackageRoot === right.outputPackageRoot
    && left.physicsHost.outputRoot === right.physicsHost.outputRoot
    && left.physicsHost.workspaceRoot === right.physicsHost.workspaceRoot
    && left.physicsHost.workspaceAuthority === right.physicsHost.workspaceAuthority;
}
function readApproval(value: unknown): ApprovedFacts { const approval = value && typeof value === "object" ? value as PhysicsVisualPackageMaterializationApproval : undefined, facts = approval ? approvals.get(approval) : undefined; if (!facts) throw new Error("C7B4D materialization approval is not host-minted."); return facts; }
function readRequest(value: unknown): PhysicsVisualPackageExactBase { const root = exactObject(snapshotSceneRecipeData(value), "C7B4D materialization request"); if (!sameKeys(root, ["schema", "expected"]) || root.schema !== REQUEST_SCHEMA) throw new Error("C7B4D materialization request schema is invalid."); return readPhysicsVisualPackageExactBase(root.expected); }
function exactObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
