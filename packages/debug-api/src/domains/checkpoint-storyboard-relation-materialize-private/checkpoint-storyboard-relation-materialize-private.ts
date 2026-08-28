/** Private C6B3b closed-inventory COW adapter. It registers no Debug command or public surface. */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  compileMotionDocumentCompositing,
  hashBuffer,
  loadSchema,
  validateDocument,
  validateMotionProceduralGraph,
  validateMotionRelations,
  type MotionDocument,
} from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import {
  compileCheckpointStoryboardRelationProfilePlan,
  readCheckpointStoryboardRelationProfileRequest,
  type CheckpointStoryboardRelationProfilePlan,
} from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  C6B3B_RECEIPT_PATH,
  bindC6B3bExactBase,
  createC6B3bReceipt,
  readC6B3bReceipt,
  writeC6B3bReceipt,
  type C6B3bExactBase,
  type CheckpointStoryboardRelationMaterializationReceipt,
} from "./checkpoint-storyboard-relation-materialize-receipt-private.js";
import {
  c6B3bPreservedLeaves,
  c6B3bSame,
  closedC6B3bInventory,
  observeC6B3bPackage,
  type C6B3bPackageFacts,
  type CheckpointStoryboardRelationMaterializationHost,
} from "./checkpoint-storyboard-relation-materialize-facts-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-relation-materialization-request@1" as const;
const HASH = /^[a-f0-9]{64}$/;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-relation-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardRelationMaterializationApproval, ApprovedFacts>();

export type { CheckpointStoryboardRelationMaterializationHost } from "./checkpoint-storyboard-relation-materialize-facts-private.js";
export type { CheckpointStoryboardRelationMaterializationReceipt } from "./checkpoint-storyboard-relation-materialize-receipt-private.js";
export { reopenCheckpointStoryboardRelationMaterializationOutput } from "./checkpoint-storyboard-relation-materialize-output-private.js";
export type { CheckpointStoryboardRelationMaterializationInstalledOutput, CheckpointStoryboardRelationMaterializationOutputHost } from "./checkpoint-storyboard-relation-materialize-output-private.js";
export interface CheckpointStoryboardRelationMaterializationApproval { readonly [approvalBrand]: "c6b3b-approved"; }
export interface CheckpointStoryboardRelationMaterializationPreparation {
  readonly approval: CheckpointStoryboardRelationMaterializationApproval;
  readonly expected: C6B3bExactBase;
  readonly plan: CheckpointStoryboardRelationProfilePlan;
}
export interface CheckpointStoryboardRelationMaterializationResult {
  readonly packageRoot: string;
  readonly receipt: CheckpointStoryboardRelationMaterializationReceipt;
  readonly workspaceCleanup: "completed";
}
interface ApprovedFacts {
  readonly storyboard: ReturnType<typeof readCheckpointStoryboardRelationProfileRequest>["storyboard"];
  readonly bindings: ReturnType<typeof readCheckpointStoryboardRelationProfileRequest>["objectLayerBindings"];
  readonly plan: CheckpointStoryboardRelationProfilePlan;
  readonly expected: C6B3bExactBase;
}
interface Staged {
  readonly source: C6B3bExactBase;
  readonly output: C6B3bExactBase;
  readonly receipt: CheckpointStoryboardRelationMaterializationReceipt;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
}
interface C6B3bCanonicalRoots { readonly workspaceRoot: string; readonly sourceRoot: string; readonly outputRoot: string; }

/** Host-only preflight mints unforgeable approval only after an actual exact-source reopen. */
export async function prepareCheckpointStoryboardRelationMaterialization(
  host: CheckpointStoryboardRelationMaterializationHost,
  storyboard: unknown,
  objectLayerBindings: unknown,
): Promise<CheckpointStoryboardRelationMaterializationPreparation> {
  return await withC6B3bWorkspaceAuthority(host, async (roots) => {
    const source = await observeC6B3bPackage(roots.sourceRoot, canonicalHost(host, roots));
    const accepted = readCheckpointStoryboardRelationProfileRequest(requestFor(source, storyboard, objectLayerBindings));
    const plan = compileCheckpointStoryboardRelationProfilePlan(accepted);
    const expected = exactBase(source.base, plan);
    assertPlanBase(plan, expected);
    const approval = Object.freeze({ [approvalBrand]: "c6b3b-approved" as const });
    approvals.set(approval, Object.freeze({ storyboard: accepted.storyboard, bindings: accepted.objectLayerBindings, plan, expected }));
    return Object.freeze({ approval, expected, plan });
  });
}

/** COW materializes only a host-minted plan with an exact caller echo of its source binding. */
export async function materializeCheckpointStoryboardRelation(
  host: CheckpointStoryboardRelationMaterializationHost,
  approval: CheckpointStoryboardRelationMaterializationApproval,
  value: unknown,
): Promise<CheckpointStoryboardRelationMaterializationResult> {
  return await withC6B3bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalHost(host, roots);
    const expected = readRequest(value), approved = readApproval(approval), source = await observeC6B3bPackage(roots.sourceRoot, canonical);
    const plan = rederive(approved, source), exact = exactBase(source.base, plan);
    assertExact(expected, exact); assertExact(approved.expected, exact);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot,
      outputRoot: roots.outputRoot,
      requireAbsentOutput: true,
      closedInventory: "finalize-after-edit",
      edit: async (stagedRoot) => await editStaged(stagedRoot, canonical, source, approved, plan, exact),
      validate: async (stagedRoot, staged) => await assertStaged(stagedRoot, canonical, staged),
      beforeCommit: async () => {
        const current = await observeC6B3bPackage(roots.sourceRoot, canonical);
        assertExact(exact, exactBase(current.base, rederive(approved, current)));
      },
      afterCommit: async (outputRoot, staged) => await assertStaged(outputRoot, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "completed" as const });
  });
}

async function editStaged(
  root: string,
  host: CheckpointStoryboardRelationMaterializationHost,
  source: C6B3bPackageFacts,
  approved: ApprovedFacts,
  plan: CheckpointStoryboardRelationProfilePlan,
  exact: C6B3bExactBase,
): Promise<Staged> {
  const staged = await observeC6B3bPackage(root, host), stagedPlan = rederive(approved, staged);
  assertExact(exact, exactBase(staged.base, stagedPlan));
  if (!c6B3bSame(plan, stagedPlan)) throw new PackageEditTransactionError("source_changed", "C6B3b staged plan changed after source planning.");
  if (staged.snapshot.entries.has(C6B3B_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B3b fixed materialization receipt already exists.");
  const persisted = await preparePersistedMotion(staged.pkg.motion, stagedPlan);
  await writeJson(join(root, staged.pkg.manifest.motion), persisted);
  const edited = await observeC6B3bPackage(root, host);
  if (edited.base.packageId !== exact.packageId
    || edited.base.manifestRawSha256 !== exact.manifestRawSha256
    || edited.base.motionRawSha256 !== serializedMotionSha256(persisted)
    || edited.base.motionCanonicalSha256 !== canonicalJsonSha256(persisted)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b staged package identity differs from the validated write.");
  }
  await assertCompleteMotion(edited.pkg.motion);
  const output = exactBase(edited.base, plan), preReceiptInventory = await closedC6B3bInventory(root, host);
  const receipt = createC6B3bReceipt(plan, exact, output, edited.pkg.manifest.motion, preReceiptInventory, c6B3bPreservedLeaves(source.snapshot, edited.pkg.manifest.motion));
  await writeC6B3bReceipt(root, receipt);
  const snapshot = await snapshotPackageEditTree(root);
  assertPreservedLeaves(source.snapshot, snapshot, edited.pkg.manifest.motion);
  return { source: exact, output, receipt, snapshot };
}

function rederive(approved: ApprovedFacts, facts: C6B3bPackageFacts): CheckpointStoryboardRelationProfilePlan {
  try {
    const plan = compileCheckpointStoryboardRelationProfilePlan(requestFor(facts, approved.storyboard, approved.bindings));
    if (!c6B3bSame(plan, approved.plan)) throw new Error("plan differs from host-minted approval");
    return plan;
  } catch (error) {
    throw new PackageEditTransactionError("source_changed", `C6B3b source no longer rederives the approved plan: ${message(error)}`);
  }
}
function requestFor(facts: C6B3bPackageFacts, storyboard: unknown, objectLayerBindings: unknown) {
  return {
    schema: "shellx-motion/private-checkpoint-storyboard-relation-profile-request@1",
    storyboard,
    objectLayerBindings,
    base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 },
  };
}
function exactBase(base: C6B3bExactBase, plan: CheckpointStoryboardRelationProfilePlan): C6B3bExactBase {
  return bindC6B3bExactBase(base, plan);
}
function assertPlanBase(plan: CheckpointStoryboardRelationProfilePlan, base: C6B3bExactBase): void {
  if (plan.base.package.id !== base.packageId
    || plan.base.manifest.sha256 !== base.manifestCanonicalSha256
    || plan.base.canonicalMotion.sha256 !== base.motionCanonicalSha256
    || plan.base.persistedMotion.sha256 !== base.motionRawSha256
    || plan.fingerprint !== base.planFingerprint
    || plan.lowererProfile.fingerprint !== base.profileFingerprint
    || plan.projection.storeSha256 !== base.storeSha256
    || plan.projection.staticFingerprint !== base.staticFingerprint
    || plan.projection.gpuPreviewStaticPlan.fingerprint !== base.gpuStaticFingerprint
    || plan.endpointFramePlans.start.fingerprint !== base.startFramePlanFingerprint
    || plan.endpointFramePlans.end.fingerprint !== base.endFramePlanFingerprint) {
    throw new PackageEditTransactionError("source_changed", "C6B3b exact base or relation-plan identity differs from its projection.");
  }
}
function assertExact(expected: C6B3bExactBase, observed: C6B3bExactBase): void {
  if (!c6B3bSame(expected, observed)) throw new PackageEditTransactionError("source_changed", "C6B3b exact base, raw bytes, canonical identities, inventory, or approved relation projection changed.");
}

async function preparePersistedMotion(source: MotionDocument, plan: CheckpointStoryboardRelationProfilePlan): Promise<MotionDocument> {
  if (canonicalJsonSha256(compileMotionDocumentCompositing(source)) !== canonicalJsonSha256(source)) {
    throw new PackageEditTransactionError("source_changed", "C6B3b source compositing compilation is not idempotent.");
  }
  if (Object.hasOwn(source, "relations")) throw new PackageEditTransactionError("source_changed", "C6B3b source relation authority changed after planning.");
  const next = structuredClone(source) as MotionDocument;
  next.relations = structuredClone(plan.projection.store);
  if (!sameWithoutRelations(source, next)) throw new PackageEditTransactionError("copy_mismatch", "C6B3b materialization changed a Motion field outside /relations.");
  await assertCompleteMotion(next);
  const persisted = compileMotionDocumentCompositing(next);
  if (!sameWithoutRelations(source, persisted) || canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b compositing compilation changed a field outside /relations or is not idempotent.");
  }
  await assertCompleteMotion(persisted);
  return persisted;
}
async function assertCompleteMotion(motion: MotionDocument): Promise<void> {
  const validation = await validateDocument(await loadSchema("motion"), motion);
  const procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true };
  const behaviors = validateMotionBehaviors(motion.behaviors, motion);
  const relations = validateMotionRelations(motion.relations, motion);
  if (!validation.ok || !procedural.ok || !behaviors.ok || !relations.ok) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b materialization produced an invalid Motion authority graph.");
  }
}
function sameWithoutRelations(left: MotionDocument, right: MotionDocument): boolean {
  const { relations: _left, ...leftRest } = left, { relations: _right, ...rightRest } = right;
  return c6B3bSame(leftRest, rightRest);
}
async function assertStaged(root: string, host: CheckpointStoryboardRelationMaterializationHost, staged: Staged): Promise<void> {
  const reopened = await observeC6B3bPackage(root, host);
  if (reopened.base.packageId !== staged.output.packageId
    || reopened.base.manifestRawSha256 !== staged.output.manifestRawSha256
    || reopened.base.motionRawSha256 !== staged.output.motionRawSha256
    || reopened.base.motionCanonicalSha256 !== staged.output.motionCanonicalSha256
    || !samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened output differs from its staged exact inventory.");
  }
  await assertCompleteMotion(reopened.pkg.motion);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.pkg.motion)) !== canonicalJsonSha256(reopened.pkg.motion)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened compositing compilation is not idempotent.");
  }
  if (!c6B3bSame(await readC6B3bReceipt(root), staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt differs after reopen.");
}
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string): void {
  const entries = (snapshot: typeof source) => [...snapshot.entries]
    .filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B3B_RECEIPT_PATH)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  if (!c6B3bSame(entries(source), entries(output))) throw new PackageEditTransactionError("copy_mismatch", "C6B3b output changed a preserved package leaf.");
}

function readApproval(value: unknown): ApprovedFacts {
  if (!value || typeof value !== "object" || (value as CheckpointStoryboardRelationMaterializationApproval)[approvalBrand] !== "c6b3b-approved") throw new Error("C6B3b materialization approval is invalid.");
  const facts = approvals.get(value as CheckpointStoryboardRelationMaterializationApproval);
  if (!facts) throw new Error("C6B3b materialization approval is not host-minted.");
  return facts;
}
function readRequest(value: unknown): C6B3bExactBase {
  const root = object(value, "C6B3b materialization request");
  keys(root, ["schema", "expected"], "C6B3b materialization request");
  if (data(root, "schema", "C6B3b materialization request") !== REQUEST_SCHEMA) throw new Error("C6B3b materialization request schema is invalid.");
  const expected = object(data(root, "expected", "C6B3b materialization request"), "C6B3b expected base");
  keys(expected, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"], "C6B3b expected base");
  const inventory = object(data(expected, "inventory", "C6B3b expected base"), "C6B3b expected inventory");
  keys(inventory, ["sha256", "entryCount", "leafCount"], "C6B3b expected inventory");
  const hash = (key: string) => { const result = data(expected, key, "C6B3b expected base"); if (typeof result !== "string" || !HASH.test(result)) throw new Error(`C6B3b expected base.${key} is invalid.`); return result; };
  const packageId = data(expected, "packageId", "C6B3b expected base");
  if (typeof packageId !== "string" || packageId.length < 1 || packageId.length > 128) throw new Error("C6B3b expected base.packageId is invalid.");
  const count = (key: "entryCount" | "leafCount") => { const result = data(inventory, key, "C6B3b expected inventory"); if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > 1_024) throw new Error(`C6B3b expected inventory.${key} is invalid.`); return result as number; };
  const inventorySha = data(inventory, "sha256", "C6B3b expected inventory");
  if (typeof inventorySha !== "string" || !HASH.test(inventorySha)) throw new Error("C6B3b expected inventory.sha256 is invalid.");
  return Object.freeze({
    packageId,
    manifestRawSha256: hash("manifestRawSha256"), motionRawSha256: hash("motionRawSha256"),
    manifestCanonicalSha256: hash("manifestCanonicalSha256"), motionCanonicalSha256: hash("motionCanonicalSha256"),
    inventory: Object.freeze({ sha256: inventorySha, entryCount: count("entryCount"), leafCount: count("leafCount") }),
    planFingerprint: hash("planFingerprint"), profileFingerprint: hash("profileFingerprint"), storeSha256: hash("storeSha256"),
    staticFingerprint: hash("staticFingerprint"), gpuStaticFingerprint: hash("gpuStaticFingerprint"),
    startFramePlanFingerprint: hash("startFramePlanFingerprint"), endFramePlanFingerprint: hash("endFramePlanFingerprint"),
  });
}

async function withC6B3bWorkspaceAuthority<T>(host: CheckpointStoryboardRelationMaterializationHost, operation: (roots: C6B3bCanonicalRoots) => Promise<T>): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), sourceSpelling = resolve(host.sourcePackageRoot), outputRoot = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspaceRoot, sourceSpelling) || !strictDescendant(workspaceRoot, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B3b source and output must be strict descendants of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B3b host workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const sourceBefore = await lstat(sourceSpelling);
    if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B3b source package root must be a non-symlink directory.");
    const sourceRoot = await realpath(sourceSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B3b source package root cannot be canonicalized: ${message(error)}`); });
    if (sourceRoot !== sourceSpelling || !strictDescendant(workspaceRoot, sourceRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B3b source package root must be the canonical strict workspace descendant without intermediate symlinks.");
    const sourceAfter = await lstat(sourceRoot);
    if (!sourceAfter.isDirectory() || sourceAfter.isSymbolicLink() || sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino) throw new PackageEditTransactionError("unsafe_output", "C6B3b source package root changed while canonicalizing.");
    // Resolve an absent output through its deepest existing ancestor before approval, COW, or output intent.
    const canonicalOutput = await canonicalPathForSafety(outputRoot).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B3b output package root cannot be canonicalized: ${message(error)}`); });
    if (canonicalOutput !== outputRoot || !strictDescendant(workspaceRoot, canonicalOutput)) throw new PackageEditTransactionError("unsafe_output", "C6B3b output package root must be the canonical strict workspace descendant without intermediate symbolic links.");
    try {
      const output = await lstat(outputRoot);
      if (output.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B3b output package root must not be a symbolic link.");
    } catch (error) { if (!missing(error)) throw error; }
    return await operation(Object.freeze({ workspaceRoot, sourceRoot, outputRoot }));
  });
}
async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try { return await realpath(resolved); }
  catch { const parent = dirname(resolved); if (parent === resolved) return resolved; return join(await canonicalPathForSafety(parent), basename(resolved)); }
}
function canonicalHost(host: CheckpointStoryboardRelationMaterializationHost, roots: C6B3bCanonicalRoots): CheckpointStoryboardRelationMaterializationHost {
  return Object.freeze({ ...host, packageWorkspaceRoot: roots.workspaceRoot, sourcePackageRoot: roots.sourceRoot, outputPackageRoot: roots.outputRoot });
}
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function data(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function keys(value: object, expected: readonly string[], label: string): void { const actual = Reflect.ownKeys(value); if (actual.length !== expected.length || actual.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !actual.includes(key))) throw new Error(`${label} has unsupported fields.`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
