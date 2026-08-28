/** Private C7A3f exact-source COW recipe installer. It registers no Debug command. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "@shellx-motion/core";
import { snapshotCheckpointStoryboardData } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { commitPackageEdit, PackageEditTransactionError } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  createC7A3fReceipt,
  createC7A3fSidecar,
  exactC7A3fBase,
  readC7A3fExactBase,
  readC7A3fReceipt,
  readC7A3fSidecar,
  writeC7A3fReceipt,
  writeC7A3fSidecar,
  type C7A3fExactBase,
  type C7A3fSidecar,
  type GltfObjectScenePackageMaterializationReceipt,
} from "./gltf-object-scene-package-artifacts-private.js";
import {
  C7A3F_RECEIPT_PATH,
  C7A3F_SIDECAR_PATH,
  c7A3fPreservedLeaves,
  c7A3fSame,
  canonicalC7A3fHost,
  closedC7A3fInventory,
  compileC7A3fRecipeBundle,
  observeC7A3fPackage,
  withC7A3fWorkspaceAuthority,
  type C7A3fCanonicalRoots,
  type C7A3fPackageFacts,
  type GltfObjectScenePackageMaterializationHost,
} from "./gltf-object-scene-package-facts-private.js";
import { reopenGltfObjectScenePackageMaterializationOutput } from "./gltf-object-scene-package-output-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-gltf-object-scene-package-materialization-request@1" as const;
const approvalBrand: unique symbol = Symbol("gltf-object-scene-package-materialization-approval");
const approvals = new WeakMap<GltfObjectScenePackageMaterializationApproval, ApprovedFacts>();
const consumed = new WeakSet<GltfObjectScenePackageMaterializationApproval>();

export type { GltfObjectScenePackageMaterializationHost } from "./gltf-object-scene-package-facts-private.js";
export type { GltfObjectScenePackageMaterializationReceipt } from "./gltf-object-scene-package-artifacts-private.js";
export { reopenGltfObjectScenePackageMaterializationOutput, reopenGltfObjectScenePackagePreviewInput } from "./gltf-object-scene-package-output-private.js";

export interface GltfObjectScenePackageMaterializationApproval { readonly [approvalBrand]: "c7a3f-approved" }
export interface GltfObjectScenePackageMaterializationPreparation {
  readonly approval: GltfObjectScenePackageMaterializationApproval;
  readonly expected: C7A3fExactBase;
  readonly sidecar: C7A3fSidecar;
}
export interface GltfObjectScenePackageMaterializationResult {
  readonly packageRoot: string;
  readonly receipt: GltfObjectScenePackageMaterializationReceipt;
  readonly workspaceCleanup: "not-attested";
}
interface ApprovedFacts { readonly roots: C7A3fCanonicalRoots; readonly expected: C7A3fExactBase; readonly sidecar: C7A3fSidecar }
interface Staged { readonly receipt: GltfObjectScenePackageMaterializationReceipt; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; readonly expected: C7A3fExactBase }

/** Reopens package-owned glTF bytes and seals the exact canonical five-recipe chain. */
export async function prepareGltfObjectScenePackageMaterialization(host: GltfObjectScenePackageMaterializationHost, recipes: unknown): Promise<GltfObjectScenePackageMaterializationPreparation> {
  return await withC7A3fWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC7A3fHost(host, roots), source = await observeC7A3fPackage(roots.sourceRoot, canonical);
    assertArtifactsAbsent(source);
    const compiled = compileC7A3fRecipeBundle(source, recipes), sidecar = createC7A3fSidecar(source, compiled), expected = exactC7A3fBase(source, compiled), approval = Object.freeze({ [approvalBrand]: "c7a3f-approved" as const });
    approvals.set(approval, Object.freeze({ roots, expected, sidecar }));
    return Object.freeze({ approval, expected, sidecar });
  });
}

/** Installs only the canonical recipe sidecar and receipt; package documents and glTF bytes stay unchanged. */
export async function materializeGltfObjectScenePackage(host: GltfObjectScenePackageMaterializationHost, approval: GltfObjectScenePackageMaterializationApproval, value: unknown): Promise<GltfObjectScenePackageMaterializationResult> {
  const expected = readRequest(value), approved = readApproval(approval);
  return await withC7A3fWorkspaceAuthority(host, async (roots) => {
    if (!c7A3fSame(roots, approved.roots)) throw new PackageEditTransactionError("unsafe_output", "C7A3f approval is bound to different source, output or workspace roots.");
    const canonical = canonicalC7A3fHost(host, roots), source = await observeC7A3fPackage(roots.sourceRoot, canonical);
    assertArtifactsAbsent(source);
    const compiled = compileC7A3fRecipeBundle(source, approved.sidecar.recipes), sidecar = createC7A3fSidecar(source, compiled), exact = exactC7A3fBase(source, compiled);
    if (!c7A3fSame(sidecar, approved.sidecar) || !c7A3fSame(exact, approved.expected) || !c7A3fSame(exact, expected)) throw new PackageEditTransactionError("source_changed", "C7A3f source no longer rederives the host-minted exact recipe chain.");
    if (consumed.has(approval)) throw new PackageEditTransactionError("source_changed", "C7A3f materialization approval has already been consumed.");
    consumed.add(approval);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot,
      outputRoot: roots.outputRoot,
      requireAbsentOutput: true,
      closedInventory: "finalize-after-edit-with-empty-directories",
      edit: async (root) => await editStaged(root, canonical, source, approved, exact),
      validate: async (root, staged) => await assertStaged(root, canonical, staged),
      beforeCommit: async () => {
        const current = await observeC7A3fPackage(roots.sourceRoot, canonical); assertArtifactsAbsent(current);
        const currentCompiled = compileC7A3fRecipeBundle(current, approved.sidecar.recipes), currentExact = exactC7A3fBase(current, currentCompiled);
        if (!c7A3fSame(exact, currentExact)) throw new PackageEditTransactionError("source_changed", "C7A3f source changed before output claim.");
      },
      afterCommit: async (root, staged) => await assertStaged(root, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "not-attested" as const });
  });
}

async function editStaged(root: string, host: GltfObjectScenePackageMaterializationHost, source: C7A3fPackageFacts, approved: ApprovedFacts, expected: C7A3fExactBase): Promise<Staged> {
  const staged = await observeC7A3fPackage(root, host); assertArtifactsAbsent(staged);
  const compiled = compileC7A3fRecipeBundle(staged, approved.sidecar.recipes), sidecar = createC7A3fSidecar(staged, compiled);
  if (!c7A3fSame(sidecar, approved.sidecar) || !c7A3fSame(expected, exactC7A3fBase(staged, compiled))) throw new PackageEditTransactionError("source_changed", "C7A3f staged package changed after recipe planning.");
  await mkdir(join(root, "analysis", "scene-recipe"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "receipts"), { recursive: true, mode: 0o700 });
  const reserved = await observeC7A3fPackage(root, host); assertDocumentsAndSourceUnchanged(staged, reserved);
  const createdDirectories = [...reserved.snapshot.entries].filter(([path, kind]) => kind === "dir" && !staged.snapshot.entries.has(path)).map(([path]) => path).sort(compareCodeUnits);
  const nonMaterializationInventory = await closedC7A3fInventory(root, host), sidecarIdentity = await writeC7A3fSidecar(root, sidecar), sidecarRead = await readC7A3fSidecar(root);
  if (!c7A3fSame(sidecarRead, sidecar)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f staged sidecar differs from the exact canonical recipe chain.");
  const preReceipt = await observeC7A3fPackage(root, host); assertDocumentsAndSourceUnchanged(staged, preReceipt);
  const receipt = createC7A3fReceipt({
    approval: { base: expected },
    output: {
      package: preReceipt.base,
      virtualSourceInventory: source.base.inventory,
      nonMaterializationInventory,
      preservedLeaves: c7A3fPreservedLeaves(source.snapshot),
      createdDirectories,
      changed: { paths: [C7A3F_SIDECAR_PATH, C7A3F_RECEIPT_PATH], count: 2, motionAndManifest: "unchanged", gltfSource: "unchanged" },
      sidecar: sidecarIdentity,
    },
    transaction: { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveArtifacts: true, workspaceCleanup: "not-attested" },
    renderer: { invoked: false, pixels: false, gpuAbi: "none", upload: "none" },
  });
  await writeC7A3fReceipt(root, receipt);
  const snapshot = await snapshotPackageEditTree(root); assertPreservedLeaves(source.snapshot, snapshot);
  return { receipt, snapshot, expected };
}

async function assertStaged(root: string, host: GltfObjectScenePackageMaterializationHost, staged: Staged): Promise<void> {
  const reopened = await observeC7A3fPackage(root, host);
  if (!samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f staged tree changed after receipt publication.");
  const receipt = await readC7A3fReceipt(root);
  if (!c7A3fSame(receipt, staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f receipt differs after reopen.");
  const output = await reopenGltfObjectScenePackageMaterializationOutput({ outputPackageRoot: root, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority });
  if (output.recipeBundleFingerprint !== staged.expected.recipeBundleFingerprint || !c7A3fSame(output.plans, staged.expected.plans)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f output-only reopen did not reprove the sealed recipe chain.");
}

function assertArtifactsAbsent(facts: C7A3fPackageFacts): void { if (facts.snapshot.entries.has(C7A3F_SIDECAR_PATH) || facts.snapshot.entries.has(C7A3F_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C7A3f fixed sidecar or receipt already exists."); }
function assertDocumentsAndSourceUnchanged(left: C7A3fPackageFacts, right: C7A3fPackageFacts): void { if (left.base.packageId !== right.base.packageId || left.base.manifestRawSha256 !== right.base.manifestRawSha256 || left.base.manifestCanonicalSha256 !== right.base.manifestCanonicalSha256 || left.base.motionRawSha256 !== right.base.motionRawSha256 || left.base.motionCanonicalSha256 !== right.base.motionCanonicalSha256 || !c7A3fSame(left.source, right.source)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f changed manifest, Motion or package glTF source bytes."); }
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>): void { const leaves = (snapshot: typeof source) => [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== C7A3F_SIDECAR_PATH && path !== C7A3F_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); if (!c7A3fSame(leaves(source), leaves(output))) throw new PackageEditTransactionError("copy_mismatch", "C7A3f changed a preserved package leaf."); }
function readApproval(value: unknown): ApprovedFacts { const approval = value && typeof value === "object" ? value as GltfObjectScenePackageMaterializationApproval : undefined, facts = approval ? approvals.get(approval) : undefined; if (!facts) throw new Error("C7A3f materialization approval is not host-minted."); return facts; }
function readRequest(value: unknown): C7A3fExactBase { const root = exactObject(snapshotCheckpointStoryboardData(value), "C7A3f materialization request"); if (!sameKeys(root, ["schema", "expected"]) || root.schema !== REQUEST_SCHEMA) throw new Error("C7A3f materialization request schema is invalid."); return readC7A3fExactBase(root.expected); }
function exactObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key)); }
