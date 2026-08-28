/** Private C6B2 closed-inventory COW adapter. It registers no Debug command or public surface. */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJsonSha256, compareCodeUnits, compileMotionDocumentCompositing, hashBuffer, loadSchema, validateDocument, validateMotionProceduralGraph, validateMotionRelations, type MotionDocument } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { compileCheckpointStoryboardBehaviorProfilePlan, readCheckpointStoryboardBehaviorProfileRequest, type CheckpointStoryboardBehaviorProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-behavior-profile";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B2_RECEIPT_PATH, bindC6B2ExactBase, createC6B2Receipt, readC6B2Receipt, writeC6B2Receipt, type C6B2ExactBase, type CheckpointStoryboardBehaviorMaterializationReceipt } from "./checkpoint-storyboard-behavior-materialize-receipt-private.js";
import { c6B2PreservedLeaves, c6B2Same, closedC6B2Inventory, observeC6B2Package, type C6B2PackageFacts, type CheckpointStoryboardBehaviorMaterializationHost } from "./checkpoint-storyboard-behavior-materialize-facts-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-behavior-materialization-request@1" as const;
const HASH = /^[a-f0-9]{64}$/;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-behavior-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardBehaviorMaterializationApproval, ApprovedFacts>();

export type { CheckpointStoryboardBehaviorMaterializationHost } from "./checkpoint-storyboard-behavior-materialize-facts-private.js";
export type { CheckpointStoryboardBehaviorMaterializationReceipt } from "./checkpoint-storyboard-behavior-materialize-receipt-private.js";
export { reopenCheckpointStoryboardBehaviorMaterializationOutput } from "./checkpoint-storyboard-behavior-materialize-output-private.js";
export type { CheckpointStoryboardBehaviorMaterializationInstalledOutput, CheckpointStoryboardBehaviorMaterializationOutputHost } from "./checkpoint-storyboard-behavior-materialize-output-private.js";
export interface CheckpointStoryboardBehaviorMaterializationApproval { readonly [approvalBrand]: "c6b2-approved"; }
export interface CheckpointStoryboardBehaviorMaterializationPreparation { readonly approval: CheckpointStoryboardBehaviorMaterializationApproval; readonly expected: C6B2ExactBase; readonly plan: CheckpointStoryboardBehaviorProfilePlan; }
export interface CheckpointStoryboardBehaviorMaterializationResult { readonly packageRoot: string; readonly receipt: CheckpointStoryboardBehaviorMaterializationReceipt; readonly workspaceCleanup: "completed"; }
interface ApprovedFacts { readonly storyboard: ReturnType<typeof readCheckpointStoryboardBehaviorProfileRequest>["storyboard"]; readonly bindings: ReturnType<typeof readCheckpointStoryboardBehaviorProfileRequest>["objectLayerBindings"]; readonly plan: CheckpointStoryboardBehaviorProfilePlan; readonly expected: C6B2ExactBase; }
interface Staged { readonly source: C6B2ExactBase; readonly output: C6B2ExactBase; readonly receipt: CheckpointStoryboardBehaviorMaterializationReceipt; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }
interface C6B2CanonicalRoots { readonly workspaceRoot: string; readonly sourceRoot: string; readonly outputRoot: string; }

/** Host-only preflight mints the unforgeable materialization approval from an actual source reopen. */
export async function prepareCheckpointStoryboardBehaviorMaterialization(host: CheckpointStoryboardBehaviorMaterializationHost, storyboard: unknown, objectLayerBindings: unknown): Promise<CheckpointStoryboardBehaviorMaterializationPreparation> {
  return await withC6B2WorkspaceAuthority(host, async (roots) => {
    const source = await observeC6B2Package(roots.sourceRoot, canonicalHost(host, roots)), accepted = readCheckpointStoryboardBehaviorProfileRequest(requestFor(source, storyboard, objectLayerBindings));
    const plan = compileCheckpointStoryboardBehaviorProfilePlan(accepted), expected = exactBase(source.base, plan);
    assertPlanBase(plan, expected);
    const approval = Object.freeze({ [approvalBrand]: "c6b2-approved" as const });
    approvals.set(approval, Object.freeze({ storyboard: accepted.storyboard, bindings: accepted.objectLayerBindings, plan, expected }));
    return Object.freeze({ approval, expected, plan });
  });
}

/** COW materializes only the host-minted plan and an exact caller echo of its source binding. */
export async function materializeCheckpointStoryboardBehavior(host: CheckpointStoryboardBehaviorMaterializationHost, approval: CheckpointStoryboardBehaviorMaterializationApproval, value: unknown): Promise<CheckpointStoryboardBehaviorMaterializationResult> {
  return await withC6B2WorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalHost(host, roots), expected = readRequest(value), approved = readApproval(approval), source = await observeC6B2Package(roots.sourceRoot, canonical);
    const plan = rederive(approved, source), exact = exactBase(source.base, plan); assertExact(expected, exact); assertExact(approved.expected, exact);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot, outputRoot: roots.outputRoot, requireAbsentOutput: true, closedInventory: "finalize-after-edit",
      edit: async (stagedRoot) => await editStaged(stagedRoot, canonical, source, approved, plan, exact),
      validate: async (stagedRoot, staged) => await assertStaged(stagedRoot, canonical, staged),
      beforeCommit: async () => { const current = await observeC6B2Package(roots.sourceRoot, canonical); assertExact(exact, exactBase(current.base, rederive(approved, current))); },
      afterCommit: async (outputRoot, staged) => await assertStaged(outputRoot, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "completed" as const });
  });
}

async function editStaged(root: string, host: CheckpointStoryboardBehaviorMaterializationHost, source: C6B2PackageFacts, approved: ApprovedFacts, plan: CheckpointStoryboardBehaviorProfilePlan, exact: C6B2ExactBase): Promise<Staged> {
  const staged = await observeC6B2Package(root, host), stagedPlan = rederive(approved, staged); assertExact(exact, exactBase(staged.base, stagedPlan)); if (!c6B2Same(plan, stagedPlan)) throw new PackageEditTransactionError("source_changed", "C6B2 staged plan changed after source planning.");
  if (staged.snapshot.entries.has(C6B2_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B2 fixed materialization receipt already exists.");
  const persisted = await preparePersistedMotion(staged.pkg.motion, stagedPlan);
  await writeJson(join(root, staged.pkg.manifest.motion), persisted);
  const edited = await observeC6B2Package(root, host);
  if (edited.base.packageId !== exact.packageId || edited.base.manifestRawSha256 !== exact.manifestRawSha256 || edited.base.motionRawSha256 !== serializedMotionSha256(persisted) || edited.base.motionCanonicalSha256 !== canonicalJsonSha256(persisted)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 staged package identity differs from the validated write.");
  await assertCompleteMotion(edited.pkg.motion);
  const output = exactBase(edited.base, plan), preReceiptInventory = await closedC6B2Inventory(root, host);
  const receipt = createC6B2Receipt(plan, exact, output, edited.pkg.manifest.motion, preReceiptInventory, c6B2PreservedLeaves(source.snapshot, edited.pkg.manifest.motion));
  await writeC6B2Receipt(root, receipt);
  const snapshot = await snapshotPackageEditTree(root); assertPreservedLeaves(source.snapshot, snapshot, edited.pkg.manifest.motion);
  return { source: exact, output, receipt, snapshot };
}

function rederive(approved: ApprovedFacts, facts: C6B2PackageFacts): CheckpointStoryboardBehaviorProfilePlan {
  try { const plan = compileCheckpointStoryboardBehaviorProfilePlan(requestFor(facts, approved.storyboard, approved.bindings)); if (!c6B2Same(plan, approved.plan)) throw new Error("plan differs from host-minted approval"); return plan; }
  catch (error) { throw new PackageEditTransactionError("source_changed", `C6B2 source no longer rederives the approved plan: ${message(error)}`); }
}
function requestFor(facts: C6B2PackageFacts, storyboard: unknown, objectLayerBindings: unknown) { return { schema: "shellx-motion/private-checkpoint-storyboard-behavior-profile-request@1", storyboard, objectLayerBindings, base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 } }; }
function exactBase(base: C6B2ExactBase, plan: CheckpointStoryboardBehaviorProfilePlan): C6B2ExactBase { return bindC6B2ExactBase(base, plan); }
function assertPlanBase(plan: CheckpointStoryboardBehaviorProfilePlan, base: C6B2ExactBase): void { if (plan.base.package.id !== base.packageId || plan.base.manifest.sha256 !== base.manifestCanonicalSha256 || plan.base.canonicalMotion.sha256 !== base.motionCanonicalSha256 || plan.base.persistedMotion.sha256 !== base.motionRawSha256 || plan.fingerprint !== base.planFingerprint || plan.lowererProfile.fingerprint !== base.profileFingerprint || plan.projection.storeSha256 !== base.storeSha256) throw new PackageEditTransactionError("source_changed", "C6B2 exact base or profile identity differs from the projection."); }
function assertExact(expected: C6B2ExactBase, observed: C6B2ExactBase): void { if (!c6B2Same(expected, observed)) throw new PackageEditTransactionError("source_changed", "C6B2 exact base, raw bytes, canonical identities, inventory, or approved projection changed."); }

async function preparePersistedMotion(source: MotionDocument, plan: CheckpointStoryboardBehaviorProfilePlan): Promise<MotionDocument> {
  if (canonicalJsonSha256(compileMotionDocumentCompositing(source)) !== canonicalJsonSha256(source)) throw new PackageEditTransactionError("source_changed", "C6B2 source compositing compilation is not idempotent.");
  if (Object.hasOwn(source, "behaviors")) throw new PackageEditTransactionError("source_changed", "C6B2 source behavior authority changed after planning.");
  const next = structuredClone(source) as MotionDocument; next.behaviors = structuredClone(plan.projection.store);
  if (!sameWithoutBehaviors(source, next)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 materialization changed a Motion field outside /behaviors.");
  await assertCompleteMotion(next);
  const persisted = compileMotionDocumentCompositing(next);
  if (!sameWithoutBehaviors(source, persisted) || canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 compositing compilation changed a field outside /behaviors or is not idempotent.");
  await assertCompleteMotion(persisted); return persisted;
}
async function assertCompleteMotion(motion: MotionDocument): Promise<void> {
  const validation = await validateDocument(await loadSchema("motion"), motion), procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true }, behaviors = validateMotionBehaviors(motion.behaviors, motion), relations = validateMotionRelations(motion.relations, motion);
  if (!validation.ok || !procedural.ok || !behaviors.ok || !relations.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B2 materialization produced an invalid Motion authority graph.");
}
function sameWithoutBehaviors(left: MotionDocument, right: MotionDocument): boolean { const { behaviors: _left, ...leftRest } = left, { behaviors: _right, ...rightRest } = right; return c6B2Same(leftRest, rightRest); }

async function assertStaged(root: string, host: CheckpointStoryboardBehaviorMaterializationHost, staged: Staged): Promise<void> {
  const reopened = await observeC6B2Package(root, host);
  if (reopened.base.packageId !== staged.output.packageId || reopened.base.manifestRawSha256 !== staged.output.manifestRawSha256 || reopened.base.motionRawSha256 !== staged.output.motionRawSha256 || reopened.base.motionCanonicalSha256 !== staged.output.motionCanonicalSha256 || !samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened output differs from its staged exact inventory.");
  await assertCompleteMotion(reopened.pkg.motion); if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.pkg.motion)) !== canonicalJsonSha256(reopened.pkg.motion)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened compositing compilation is not idempotent.");
  if (!c6B2Same(await readC6B2Receipt(root), staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 receipt differs after reopen.");
}
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string): void { const entries = (snapshot: typeof source) => [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B2_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); if (!c6B2Same(entries(source), entries(output))) throw new PackageEditTransactionError("copy_mismatch", "C6B2 output changed a preserved package leaf."); }

function readApproval(value: unknown): ApprovedFacts { if (!value || typeof value !== "object" || (value as CheckpointStoryboardBehaviorMaterializationApproval)[approvalBrand] !== "c6b2-approved") throw new Error("C6B2 materialization approval is invalid."); const facts = approvals.get(value as CheckpointStoryboardBehaviorMaterializationApproval); if (!facts) throw new Error("C6B2 materialization approval is not host-minted."); return facts; }
function readRequest(value: unknown): C6B2ExactBase { const root = object(value, "C6B2 materialization request"); keys(root, ["schema", "expected"], "C6B2 materialization request"); if (data(root, "schema", "C6B2 materialization request") !== REQUEST_SCHEMA) throw new Error("C6B2 materialization request schema is invalid."); const expected = object(data(root, "expected", "C6B2 materialization request"), "C6B2 expected base"); keys(expected, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "storeSha256"], "C6B2 expected base"); const inventory = object(data(expected, "inventory", "C6B2 expected base"), "C6B2 expected inventory"); keys(inventory, ["sha256", "entryCount", "leafCount"], "C6B2 expected inventory"); const hash = (key: string) => { const result = data(expected, key, "C6B2 expected base"); if (typeof result !== "string" || !HASH.test(result)) throw new Error(`C6B2 expected base.${key} is invalid.`); return result; }; const packageId = data(expected, "packageId", "C6B2 expected base"); if (typeof packageId !== "string" || packageId.length < 1 || packageId.length > 128) throw new Error("C6B2 expected base.packageId is invalid."); const count = (key: "entryCount" | "leafCount") => { const result = data(inventory, key, "C6B2 expected inventory"); if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > 1_024) throw new Error(`C6B2 expected inventory.${key} is invalid.`); return result as number; }; const inventorySha = data(inventory, "sha256", "C6B2 expected inventory"); if (typeof inventorySha !== "string" || !HASH.test(inventorySha)) throw new Error("C6B2 expected inventory.sha256 is invalid."); return Object.freeze({ packageId, manifestRawSha256: hash("manifestRawSha256"), motionRawSha256: hash("motionRawSha256"), manifestCanonicalSha256: hash("manifestCanonicalSha256"), motionCanonicalSha256: hash("motionCanonicalSha256"), inventory: Object.freeze({ sha256: inventorySha, entryCount: count("entryCount"), leafCount: count("leafCount") }), planFingerprint: hash("planFingerprint"), profileFingerprint: hash("profileFingerprint"), storeSha256: hash("storeSha256") }); }

async function withC6B2WorkspaceAuthority<T>(host: CheckpointStoryboardBehaviorMaterializationHost, operation: (roots: C6B2CanonicalRoots) => Promise<T>): Promise<T> { const workspaceRoot = resolve(host.packageWorkspaceRoot), sourceSpelling = resolve(host.sourcePackageRoot), outputRoot = resolve(host.outputPackageRoot); if (!strictDescendant(workspaceRoot, sourceSpelling) || !strictDescendant(workspaceRoot, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B2 source and output must be strict descendants of the host workspace."); try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); } catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B2 host workspace authority is invalid: ${message(error)}`); } return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => { const sourceBefore = await lstat(sourceSpelling); if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B2 source package root must be a non-symlink directory."); const sourceRoot = await realpath(sourceSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B2 source package root cannot be canonicalized: ${message(error)}`); }); if (sourceRoot !== sourceSpelling || !strictDescendant(workspaceRoot, sourceRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B2 source package root must be the canonical strict workspace descendant without intermediate symlinks."); const sourceAfter = await lstat(sourceRoot); if (!sourceAfter.isDirectory() || sourceAfter.isSymbolicLink() || sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino) throw new PackageEditTransactionError("unsafe_output", "C6B2 source package root changed while canonicalizing."); const canonicalOutput = await canonicalPathForSafety(outputRoot).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B2 output package root cannot be canonicalized: ${message(error)}`); }); if (canonicalOutput !== outputRoot || !strictDescendant(workspaceRoot, canonicalOutput)) throw new PackageEditTransactionError("unsafe_output", "C6B2 output package root must be the canonical strict workspace descendant without intermediate symbolic links."); try { const output = await lstat(outputRoot); if (output.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B2 output package root must not be a symbolic link."); } catch (error) { if (!missing(error)) throw error; } return await operation(Object.freeze({ workspaceRoot, sourceRoot, outputRoot })); }); }
/** Resolve an absent spelling through its deepest existing ancestor so aliases cannot be found only after intent/COW publication. */
async function canonicalPathForSafety(path: string): Promise<string> { const resolved = resolve(path); try { return await realpath(resolved); } catch { const parent = dirname(resolved); if (parent === resolved) return resolved; return join(await canonicalPathForSafety(parent), basename(resolved)); } }
function canonicalHost(host: CheckpointStoryboardBehaviorMaterializationHost, roots: C6B2CanonicalRoots): CheckpointStoryboardBehaviorMaterializationHost { return Object.freeze({ ...host, packageWorkspaceRoot: roots.workspaceRoot, sourcePackageRoot: roots.sourceRoot, outputPackageRoot: roots.outputRoot }); }
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function data(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function keys(value: object, expected: readonly string[], label: string): void { const actual = Reflect.ownKeys(value); if (actual.length !== expected.length || actual.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !actual.includes(key))) throw new Error(`${label} has unsupported fields.`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
