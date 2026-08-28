/** Private Debug-host C6B1b COW materialization. No command, registry, or public SDK imports it. */
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  compileMotionDocumentCompositing,
  hashBuffer,
  loadSchema,
  upsertLayerKeyframe,
  upsertLayerSpatialPosition,
  validateDocument,
  validateMotionProceduralGraph,
  validateMotionRelations,
  type MotionDocument,
} from "@shellx-motion/core";
import {
  assertTrustedWorkspaceAnchorPath,
  withTrustedWorkspaceAnchor,
  type TrustedWorkspaceAnchor,
} from "@shellx-motion/core/internal/trusted-host-workspace";
import {
  approveCheckpointStoryboardScalarSpatialMaterialization,
  compileCheckpointStoryboardScalarSpatialPlan,
  readApprovedCheckpointStoryboardScalarSpatialMaterialization,
  revalidateCheckpointStoryboardScalarSpatialMaterialization,
  type CheckpointStoryboardScalarSpatialMaterializationApproval,
  type CheckpointStoryboardScalarSpatialMaterializationProjection,
  type CheckpointStoryboard,
} from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "./package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "./package-edit-tree-snapshot.js";
import {
  C6B1B_RECEIPT_PATH,
  approvedC6B1bBase,
  createC6B1bReceipt,
  readC6B1bReceipt,
  writeC6B1bReceipt,
  type C6B1bExactBase,
  type CheckpointStoryboardScalarSpatialMaterializationReceipt,
} from "./checkpoint-storyboard-scalar-spatial-materialize-receipt-private.js";
import { reopenCheckpointStoryboardScalarSpatialMaterializationOutput } from "./checkpoint-storyboard-scalar-spatial-materialize-output-private.js";
import { closedInventoryFor, observePackage, preservedLeaves, same, type CheckpointStoryboardScalarSpatialMaterializationHost, type PackageFacts } from "./checkpoint-storyboard-scalar-spatial-materialize-facts-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization-request@1" as const;
const HASH = /^[a-f0-9]{64}$/;
export type { CheckpointStoryboardScalarSpatialMaterializationHost, PackageFacts } from "./checkpoint-storyboard-scalar-spatial-materialize-facts-private.js";
export interface CheckpointStoryboardScalarSpatialMaterializationResult {
  readonly packageRoot: string;
  readonly receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt;
  readonly workspaceCleanup: "completed";
}
export type { CheckpointStoryboardScalarSpatialMaterializationReceipt } from "./checkpoint-storyboard-scalar-spatial-materialize-receipt-private.js";
interface MaterializationRequest { readonly expected: C6B1bExactBase; }
interface StagedResult { readonly receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt; readonly source: C6B1bExactBase; readonly output: C6B1bExactBase; readonly persisted: MotionDocument; readonly finalSnapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }
type ApprovedC6B1bFacts = ReturnType<typeof readApprovedCheckpointStoryboardScalarSpatialMaterialization>;
export type CheckpointStoryboardScalarSpatialMaterializationPreparation = Readonly<{ readonly approval: CheckpointStoryboardScalarSpatialMaterializationApproval; readonly expected: C6B1bExactBase; readonly plan: ApprovedC6B1bFacts["plan"]; readonly projection: CheckpointStoryboardScalarSpatialMaterializationProjection; readonly request: ApprovedC6B1bFacts["request"] }>;
/**
 * Host-only preparation seam used by C6C B1a. It reuses the accepted C6B evaluator/compiler and
 * approval mint; it exposes no command and does not mutate a package.
 */
export async function prepareCheckpointStoryboardScalarSpatialMaterialization(
  host: CheckpointStoryboardScalarSpatialMaterializationHost,
  storyboard: CheckpointStoryboard,
  objectLayerBindings: readonly { readonly objectId: string; readonly layerId: string }[],
): Promise<CheckpointStoryboardScalarSpatialMaterializationPreparation> {
  return await withC6B1bWorkspaceAuthority(host, async () => {
    const source = await observePackage(host.sourcePackageRoot, host);
    const request = Object.freeze({
      schema: "shellx-motion/private-checkpoint-storyboard-scalar-spatial-request@1" as const,
      storyboard,
      base: Object.freeze({ packageId: source.pkg.manifest.id, manifest: source.pkg.manifest, motion: source.pkg.motion, persistedMotionSha256: source.base.motionRawSha256 }),
      objectLayerBindings: Object.freeze(objectLayerBindings.map((binding) => Object.freeze({ objectId: binding.objectId, layerId: binding.layerId }))),
    });
    const plan = compileCheckpointStoryboardScalarSpatialPlan(request);
    const approval = approveCheckpointStoryboardScalarSpatialMaterialization(Object.freeze({ request, plan }));
    const approved = readApprovedCheckpointStoryboardScalarSpatialMaterialization(approval);
    const expected = approvedC6B1bBase(source.base, approved.plan, approved.projection);
    return Object.freeze({ approval, expected, plan: approved.plan, projection: approved.projection, request: approved.request });
  });
}

export { reopenCheckpointStoryboardScalarSpatialMaterializationOutput } from "./checkpoint-storyboard-scalar-spatial-materialize-output-private.js";
/**
 * Materializes only the projection held behind a host-minted approval. The caller supplies no
 * storyboard, lowering, stage, receipt route, output inventory, or production race hook.
 */
export async function materializeCheckpointStoryboardScalarSpatial(
  host: CheckpointStoryboardScalarSpatialMaterializationHost,
  approval: CheckpointStoryboardScalarSpatialMaterializationApproval,
  value: unknown,
): Promise<CheckpointStoryboardScalarSpatialMaterializationResult> {
  return await withC6B1bWorkspaceAuthority(host, async () => await materializeWithinWorkspace(host, approval, value));
}

async function materializeWithinWorkspace(
  host: CheckpointStoryboardScalarSpatialMaterializationHost,
  approval: CheckpointStoryboardScalarSpatialMaterializationApproval,
  value: unknown,
): Promise<CheckpointStoryboardScalarSpatialMaterializationResult> {
  const request = readMaterializationRequest(value);
  const approved = readApprovedCheckpointStoryboardScalarSpatialMaterialization(approval);
  const sourceRaw = await observePackage(host.sourcePackageRoot, host);
  const source = withApprovalFacts(sourceRaw, approved.plan, approved.projection);
  const sourceProjection = rederiveProjection(approved.request, approved.plan, approved.projection, source);
  assertExactBase(request.expected, source.base);
  assertApprovalBase(approved.plan, source.base, sourceProjection);
  const persisted = await preparePersistedMotion(source.pkg.motion, sourceProjection);

  const transaction = await commitPackageEdit<StagedResult, void>({
    sourceRoot: source.pkg.root,
    outputRoot: host.outputPackageRoot,
    requireAbsentOutput: host.requireAbsentOutput === true,
    closedInventory: "finalize-after-edit",
    edit: async (stagedRoot) => {
      const staged = withApprovalFacts(await observePackage(stagedRoot, host), approved.plan, approved.projection);
      assertExactBase(source.base, staged.base);
      const stagedProjection = rederiveProjection(approved.request, approved.plan, approved.projection, staged);
      assertProjection(sourceProjection, stagedProjection);
      assertReceiptAbsent(staged.snapshot);
      await writeJson(join(stagedRoot, staged.pkg.manifest.motion), persisted);
      const edited = await observePackage(stagedRoot, host);
      if (edited.base.packageId !== source.base.packageId || edited.base.manifestRawSha256 !== source.base.manifestRawSha256) {
        throw new PackageEditTransactionError("copy_mismatch", "C6B1b staged edit changed package or manifest identity.");
      }
      if (edited.base.motionRawSha256 !== serializedMotionSha256(persisted) || edited.base.motionCanonicalSha256 !== canonicalJsonSha256(persisted)) {
        throw new PackageEditTransactionError("copy_mismatch", "C6B1b staged Motion bytes differ from the validated document.");
      }
      await assertCompleteMotion(edited.pkg.motion);
      const preReceipt = await closedInventoryFor(stagedRoot, host);
      const receipt = createC6B1bReceipt(approved.plan, stagedProjection, source.base, edited.base, staged.pkg.manifest.motion, preReceipt, preservedLeaves(source.snapshot, staged.pkg.manifest.motion));
      await writeC6B1bReceipt(stagedRoot, receipt, message);
      const finalSnapshot = await snapshotPackageEditTree(stagedRoot);
      assertPreservedLeaves(source.snapshot, finalSnapshot, staged.pkg.manifest.motion);
      return { receipt, source: source.base, output: edited.base, persisted, finalSnapshot };
    },
    validate: async (stagedRoot, staged) => {
      await assertStaged(stagedRoot, host, staged);
    },
    beforeCommit: async () => {
      const current = withApprovalFacts(await observePackage(host.sourcePackageRoot, host), approved.plan, approved.projection);
      assertExactBase(source.base, current.base);
    },
    afterCommit: async (outputRoot, staged) => {
      await assertStaged(outputRoot, host, staged);
    },
  });
  return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "completed" as const });
}

function rederiveProjection(request: unknown, plan: unknown, projection: unknown, facts: PackageFacts): CheckpointStoryboardScalarSpatialMaterializationProjection {
  const baseRequest = readApprovedCheckpointStoryboardScalarSpatialMaterializationRequest(request, facts);
  try {
    return revalidateCheckpointStoryboardScalarSpatialMaterialization(baseRequest, plan, projection).projection;
  } catch (error) {
    throw new PackageEditTransactionError("source_changed", `C6B1b source no longer rederives the approved plan: ${message(error)}`);
  }
}

function readApprovedCheckpointStoryboardScalarSpatialMaterializationRequest(request: any, facts: PackageFacts) {
  return {
    schema: request.schema,
    storyboard: request.storyboard,
    objectLayerBindings: request.objectLayerBindings,
    base: {
      packageId: facts.pkg.manifest.id,
      manifest: facts.pkg.manifest,
      motion: facts.pkg.motion,
      persistedMotionSha256: facts.base.motionRawSha256,
    },
  };
}

async function preparePersistedMotion(source: MotionDocument, projection: CheckpointStoryboardScalarSpatialMaterializationProjection): Promise<MotionDocument> {
  if (canonicalJsonSha256(compileMotionDocumentCompositing(source)) !== canonicalJsonSha256(source)) {
    throw new PackageEditTransactionError("source_changed", "C6B1b source compositing compilation is not idempotent.");
  }
  const materialized = applyProjection(source, projection);
  await assertCompleteMotion(materialized);
  const persisted = compileMotionDocumentCompositing(materialized);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B1b compositing compilation is not idempotent.");
  }
  await assertCompleteMotion(persisted);
  return persisted;
}

function applyProjection(source: MotionDocument, projection: CheckpointStoryboardScalarSpatialMaterializationProjection): MotionDocument {
  const next = structuredClone(source);
  for (const scalar of projection.scalar) {
    let layer = exactLayer(next, scalar.layerIndex, scalar.layerId, scalar.objectId);
    if (Object.hasOwn(layer.keyframes ?? {}, scalar.property)) throw new PackageEditTransactionError("source_changed", "C6B1b scalar authority changed after planning.");
    for (const frame of scalar.keyframes) layer = upsertLayerKeyframe(layer, { target: scalar.property, atMs: frame.atMs, value: frame.value, ...(frame.easing ? { easing: frame.easing } : {}) }).layer;
    next.layers[scalar.layerIndex] = layer;
  }
  for (const spatial of projection.spatial) {
    let layer = exactLayer(next, spatial.layerIndex, spatial.layerId, spatial.objectId);
    if (Object.hasOwn(layer.keyframes ?? {}, "transform.x") || Object.hasOwn(layer.keyframes ?? {}, "transform.y")) throw new PackageEditTransactionError("source_changed", "C6B1b spatial authority changed after planning.");
    for (const frame of spatial.keyframes) layer = upsertLayerSpatialPosition(layer, {
      atMs: frame.atMs, x: frame.x, y: frame.y, spatial: frame.spatial, ...(frame.easing ? { easing: frame.easing } : {}),
    }).layer;
    next.layers[spatial.layerIndex] = layer;
  }
  return next;
}

function exactLayer(motion: MotionDocument, index: number, layerId: string, objectId: string) {
  const layer = motion.layers[index];
  if (!layer || layer.id !== layerId || layer.id !== objectId || (layer.shape !== "rect" && layer.shape !== "ellipse")) {
    throw new PackageEditTransactionError("source_changed", "C6B1b exact root binding changed after planning.");
  }
  return layer;
}

async function assertCompleteMotion(motion: MotionDocument): Promise<void> {
  const schema = await loadSchema("motion");
  const validation = await validateDocument(schema, motion);
  if (!validation.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B1b materialization produced an invalid Motion document.");
  const procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true };
  const behaviors = validateMotionBehaviors(motion.behaviors, motion);
  const relations = validateMotionRelations(motion.relations, motion);
  if (!procedural.ok || !behaviors.ok || !relations.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B1b materialization produced an invalid Motion authority graph.");
}

function withApprovalFacts(facts: PackageFacts, plan: any, projection: CheckpointStoryboardScalarSpatialMaterializationProjection): PackageFacts {
  return Object.freeze({ ...facts, base: approvedC6B1bBase(facts.base, plan, projection) });
}
function assertApprovalBase(plan: any, base: C6B1bExactBase, projection: CheckpointStoryboardScalarSpatialMaterializationProjection): void {
  const approved = approvedC6B1bBase(base, plan, projection);
  if (plan.base.package.id !== approved.packageId || plan.base.manifest.sha256 !== approved.manifestCanonicalSha256 || plan.base.canonicalMotion.sha256 !== approved.motionCanonicalSha256 || plan.base.persistedMotion.sha256 !== approved.motionRawSha256 || projection.c6b1a.planFingerprint !== plan.fingerprint || projection.materializerProfile.fingerprint !== approved.c6b1bProfileFingerprint) {
    throw new PackageEditTransactionError("source_changed", "C6B1b exact base or profile identity differs from approval.");
  }
}

function assertExactBase(expected: C6B1bExactBase, observed: C6B1bExactBase): void {
  const left = { ...expected }, right = { ...observed };
  if (!same(left, right)) throw new PackageEditTransactionError("source_changed", "C6B1b exact base, raw bytes, canonical identities, or closed inventory changed.");
}
function assertProjection(left: CheckpointStoryboardScalarSpatialMaterializationProjection, right: CheckpointStoryboardScalarSpatialMaterializationProjection): void { if (!same(left, right)) throw new PackageEditTransactionError("source_changed", "C6B1b staged projection changed after source planning."); }

async function assertStaged(root: string, host: CheckpointStoryboardScalarSpatialMaterializationHost, staged: StagedResult): Promise<void> {
  const reopened = await observePackage(root, host);
  if (reopened.base.packageId !== staged.output.packageId || reopened.base.manifestRawSha256 !== staged.output.manifestRawSha256 || reopened.base.motionRawSha256 !== staged.output.motionRawSha256 || reopened.base.motionCanonicalSha256 !== staged.output.motionCanonicalSha256 || !samePackageEditTreeSnapshot(reopened.snapshot, staged.finalSnapshot)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B1b reopened output differs from its staged exact inventory.");
  }
  await assertCompleteMotion(reopened.pkg.motion);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.pkg.motion)) !== canonicalJsonSha256(reopened.pkg.motion)) throw new PackageEditTransactionError("copy_mismatch", "C6B1b reopened compositing compilation is not idempotent.");
  const receipt = await readC6B1bReceipt(root);
  if (!same(receipt, staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt differs after reopen.");
}

function readMaterializationRequest(value: unknown): MaterializationRequest {
  const root = object(value, "C6B1b materialization request"); exactKeys(root, ["schema", "expected"], "C6B1b materialization request");
  if (data(root, "schema", "C6B1b materialization request") !== REQUEST_SCHEMA) throw new Error("C6B1b materialization request schema is invalid.");
  const expected = object(data(root, "expected", "C6B1b materialization request"), "C6B1b expected base");
  exactKeys(expected, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "c6aPlanFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"], "C6B1b expected base");
  const inventoryValue = object(data(expected, "inventory", "C6B1b expected base"), "C6B1b expected inventory"); exactKeys(inventoryValue, ["sha256", "entryCount", "leafCount"], "C6B1b expected inventory");
  const readHash = (key: string) => { const item = data(expected, key, "C6B1b expected base"); if (typeof item !== "string" || !HASH.test(item)) throw new Error(`C6B1b expected base.${key} is invalid.`); return item; };
  const packageId = data(expected, "packageId", "C6B1b expected base");
  if (typeof packageId !== "string" || packageId.length === 0 || packageId.length > 128) throw new Error("C6B1b expected base.packageId is invalid.");
  const counts = [data(inventoryValue, "entryCount", "C6B1b expected inventory"), data(inventoryValue, "leafCount", "C6B1b expected inventory")]; if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 1_024)) throw new Error("C6B1b expected inventory counts are invalid.");
  return { expected: Object.freeze({ packageId, manifestRawSha256: readHash("manifestRawSha256"), motionRawSha256: readHash("motionRawSha256"), manifestCanonicalSha256: readHash("manifestCanonicalSha256"), motionCanonicalSha256: readHash("motionCanonicalSha256"), inventory: Object.freeze({ sha256: readHashInventory(inventoryValue), entryCount: counts[0] as number, leafCount: counts[1] as number }), c6aPlanFingerprint: readHash("c6aPlanFingerprint"), c6b1bProfileFingerprint: readHash("c6b1bProfileFingerprint"), c6b1bProjectionFingerprint: readHash("c6b1bProjectionFingerprint") }) };
}
function readHashInventory(inventory: object): string { const value = data(inventory, "sha256", "C6B1b expected inventory"); if (typeof value !== "string" || !HASH.test(value)) throw new Error("C6B1b expected inventory.sha256 is invalid."); return value; }
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string): void { if (!same(preservedEntries(source, motionPath), preservedEntries(output, motionPath))) throw new PackageEditTransactionError("copy_mismatch", "C6B1b output changed a preserved package leaf."); }
function preservedEntries(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string) { return [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B1B_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); }
function assertReceiptAbsent(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): void { if (snapshot.entries.has(C6B1B_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B1b fixed materialization receipt already exists."); }
async function withC6B1bWorkspaceAuthority<T>(host: CheckpointStoryboardScalarSpatialMaterializationHost, operation: () => Promise<T>): Promise<T> {
  const workspace = resolve(host.packageWorkspaceRoot);
  if (!strictDescendant(workspace, resolve(host.sourcePackageRoot)) || !strictDescendant(workspace, resolve(host.outputPackageRoot))) throw new PackageEditTransactionError("unsafe_output", "C6B1b source and output must be strict descendants of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspace); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B1b host workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    await assertHostPackageRoots(host); return await operation();
  });
}
async function assertHostPackageRoots(host: CheckpointStoryboardScalarSpatialMaterializationHost): Promise<void> {
  const source = await lstat(host.sourcePackageRoot);
  if (!source.isDirectory() || source.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B1b source package root must be a non-symlink directory.");
  try {
    const output = await lstat(host.outputPackageRoot);
    if (output.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B1b output package root must not be a symbolic link.");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function data(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function exactKeys(value: object, expected: readonly string[], label: string): void { const keys = Reflect.ownKeys(value); if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !keys.includes(key))) throw new Error(`${label} has unsupported fields.`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
