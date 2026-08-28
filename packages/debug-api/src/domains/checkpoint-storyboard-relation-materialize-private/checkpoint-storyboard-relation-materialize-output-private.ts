/** Output-only C6B3b diagnostic reopen. It accepts no source, approval, plan, or writer authority. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  compileGpuSceneRelationsStaticPlan,
  compileMotionRelationAuthoringFramePlanFromEvaluation,
  compileMotionRelationStaticPlan,
  evaluateMotionRelationAuthoringFrame,
  type MotionRelationStore,
  validateMotionRelations,
} from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { C6B3B_RECEIPT_PATH, readC6B3bReceipt, type C6B3bInventory } from "./checkpoint-storyboard-relation-materialize-receipt-private.js";
import {
  c6B3bCurrentInventory,
  c6B3bNonReceiptInventory,
  c6B3bPreservedLeaves,
  c6B3bSame,
  closedC6B3bInventory,
  observeC6B3bPackage,
  type CheckpointStoryboardRelationMaterializationOutputHost,
} from "./checkpoint-storyboard-relation-materialize-facts-private.js";

export type { CheckpointStoryboardRelationMaterializationOutputHost } from "./checkpoint-storyboard-relation-materialize-facts-private.js";
export interface CheckpointStoryboardRelationMaterializationInstalledOutput {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-installed-output@1";
  readonly receipt: { readonly schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-receipt@1"; readonly fingerprint: string };
  readonly package: {
    readonly id: string;
    readonly manifest: { readonly rawSha256: string; readonly canonicalSha256: string };
    readonly motion: { readonly rawSha256: string; readonly canonicalSha256: string };
    readonly currentInventory: C6B3bInventory;
    readonly nonReceiptInventory: C6B3bInventory;
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
  };
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
  readonly plan: { readonly fingerprint: string };
  readonly profile: { readonly fingerprint: string };
  readonly relationStore: { readonly schema: "shellx-motion/relations@1"; readonly sha256: string; readonly bindings: readonly MotionRelationStore["bindings"][number][] };
  readonly relationStatic: { readonly fingerprint: string };
  readonly gpuRelationStatic: { readonly fingerprint: string; readonly relationStaticFingerprint: string };
  readonly endpointFramePlans: { readonly startFingerprint: string; readonly endFingerprint: string };
  readonly materialization: { readonly changedMotionRoot: "relations"; readonly changedLeafCount: 2; readonly renderer: { readonly invoked: false; readonly pixels: false } };
}

/** Reopens an installed C6B3b COW package solely through host authority and its fixed receipt. */
export async function reopenCheckpointStoryboardRelationMaterializationOutput(
  host: CheckpointStoryboardRelationMaterializationOutputHost,
): Promise<CheckpointStoryboardRelationMaterializationInstalledOutput> {
  return await withOutputWorkspaceAuthority(host, async (outputRoot, canonicalHost) => {
    const before = await readC6B3bReceipt(outputRoot), output = await observeC6B3bPackage(outputRoot, canonicalHost);
    assertReceiptBinding(before, output);
    const relations = validateMotionRelations(output.pkg.motion.relations, output.pkg.motion);
    if (!relations.ok || !relations.store || relations.store.bindings.length !== 1 || relations.bindings.length !== 1) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened output does not contain one valid relations@1 binding.");
    }
    const binding = relations.store.bindings[0]!, resolved = relations.bindings[0]!;
    const durationUs = output.pkg.motion.durationMs * 1_000;
    if (binding.enabled !== true || binding.kind !== "attach" || binding.mode !== "follow"
      || binding.offset.space !== "world" || binding.offset.rotationDeg !== 0 || binding.offset.scale !== 1
      || binding.source.layerId === binding.target.layerId || binding.startUs !== 0 || binding.durationUs !== durationUs
      || resolved.binding.id !== binding.id || resolved.binding.target.layerId !== binding.target.layerId
      || !sameMask(resolved.writeMask, ["transform.x", "transform.y"])) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened output does not contain the closed target-only world-follow relation.");
    }
    const staticPlan = compileMotionRelationStaticPlan(output.pkg.motion);
    if (!staticPlan.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened static relation plan is invalid.");
    const gpuStatic = compileGpuSceneRelationsStaticPlan(output.pkg.motion);
    if (!gpuStatic.ok || gpuStatic.plan.relationStaticFingerprint !== staticPlan.plan.fingerprint) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened GPU static relation plan is invalid.");
    }
    const start = compileMotionRelationAuthoringFramePlanFromEvaluation(output.pkg.motion, evaluateMotionRelationAuthoringFrame(output.pkg.motion, 0));
    const end = compileMotionRelationAuthoringFramePlanFromEvaluation(output.pkg.motion, evaluateMotionRelationAuthoringFrame(output.pkg.motion, durationUs));
    if (!start.ok || !end.ok || start.plan.staticFingerprint !== staticPlan.plan.fingerprint || end.plan.staticFingerprint !== staticPlan.plan.fingerprint) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened endpoint relation-frame plans are invalid.");
    }
    const storeSha256 = canonicalJsonSha256(relations.store);
    if (storeSha256 !== before.approval.storeSha256
      || staticPlan.plan.fingerprint !== before.approval.staticFingerprint
      || gpuStatic.plan.fingerprint !== before.approval.gpuStaticFingerprint
      || start.plan.fingerprint !== before.approval.startFramePlanFingerprint
      || end.plan.fingerprint !== before.approval.endFramePlanFingerprint) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b relation plan evidence differs from the installed relation store.");
    }
    const snapshot = await snapshotPackageEditTree(outputRoot);
    const nonReceiptInventory = c6B3bNonReceiptInventory(snapshot), currentInventory = await closedC6B3bInventory(outputRoot, canonicalHost);
    const expectedPaths = [output.pkg.manifest.motion, C6B3B_RECEIPT_PATH].sort(compareCodeUnits);
    if (!c6B3bSame(nonReceiptInventory, before.output.nonReceiptInventory)
      || !c6B3bSame(currentInventory, c6B3bCurrentInventory(snapshot))
      || currentInventory.entryCount !== nonReceiptInventory.entryCount + 1
      || currentInventory.leafCount !== nonReceiptInventory.leafCount + 1
      || !c6B3bSame(c6B3bPreservedLeaves(snapshot, output.pkg.manifest.motion), before.output.preservedLeaves)
      || !c6B3bSame(before.output.changed.paths, expectedPaths)
      || before.output.changed.count !== 2
      || before.output.changed.motionPropertyPaths[0] !== "relations"
      || before.output.changed.motionPropertyPathCount !== 1) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened output tree differs from its fixed receipt evidence.");
    }
    const afterOutput = await observeC6B3bPackage(outputRoot, canonicalHost), after = await readC6B3bReceipt(outputRoot);
    if (afterOutput.base.packageId !== output.base.packageId
      || afterOutput.base.manifestRawSha256 !== output.base.manifestRawSha256
      || afterOutput.base.motionRawSha256 !== output.base.motionRawSha256
      || afterOutput.base.motionCanonicalSha256 !== output.base.motionCanonicalSha256
      || !c6B3bSame(after, before)) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt or package changed during installed-output reopen.");
    }
    return Object.freeze({
      schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-installed-output@1",
      receipt: Object.freeze({ schema: before.schema, fingerprint: before.fingerprint }),
      package: Object.freeze({
        id: output.base.packageId,
        manifest: Object.freeze({ rawSha256: output.base.manifestRawSha256, canonicalSha256: output.base.manifestCanonicalSha256 }),
        motion: Object.freeze({ rawSha256: output.base.motionRawSha256, canonicalSha256: output.base.motionCanonicalSha256 }),
        currentInventory,
        nonReceiptInventory,
        preservedLeaves: Object.freeze({ ...before.output.preservedLeaves }),
      }),
      storyboard: Object.freeze({ ...before.approval.storyboard }),
      plan: Object.freeze({ fingerprint: before.approval.planFingerprint }),
      profile: Object.freeze({ fingerprint: before.approval.profileFingerprint }),
      relationStore: Object.freeze({ schema: relations.store.schema, sha256: storeSha256, bindings: frozen(structuredClone(relations.store.bindings)) }),
      relationStatic: Object.freeze({ fingerprint: staticPlan.plan.fingerprint }),
      gpuRelationStatic: Object.freeze({ fingerprint: gpuStatic.plan.fingerprint, relationStaticFingerprint: gpuStatic.plan.relationStaticFingerprint }),
      endpointFramePlans: Object.freeze({ startFingerprint: start.plan.fingerprint, endFingerprint: end.plan.fingerprint }),
      materialization: Object.freeze({ changedMotionRoot: "relations" as const, changedLeafCount: 2 as const, renderer: Object.freeze({ invoked: false as const, pixels: false as const }) }),
    });
  });
}

function assertReceiptBinding(
  receipt: Awaited<ReturnType<typeof readC6B3bReceipt>>,
  output: Awaited<ReturnType<typeof observeC6B3bPackage>>,
): void {
  const expected = receipt.base.expected;
  if (!c6B3bSame(expected, receipt.base.reopened)
    || expected.packageId !== output.base.packageId
    || expected.manifestRawSha256 !== output.base.manifestRawSha256
    || expected.manifestCanonicalSha256 !== output.base.manifestCanonicalSha256
    || receipt.output.packageId !== output.base.packageId
    || receipt.output.manifestRawSha256 !== output.base.manifestRawSha256
    || receipt.output.motionRawSha256 !== output.base.motionRawSha256
    || receipt.output.canonicalMotionSha256 !== output.base.motionCanonicalSha256
    || receipt.approval.planFingerprint !== expected.planFingerprint
    || receipt.approval.profileFingerprint !== expected.profileFingerprint
    || receipt.approval.storeSha256 !== expected.storeSha256
    || receipt.approval.staticFingerprint !== expected.staticFingerprint
    || receipt.approval.gpuStaticFingerprint !== expected.gpuStaticFingerprint
    || receipt.approval.startFramePlanFingerprint !== expected.startFramePlanFingerprint
    || receipt.approval.endFramePlanFingerprint !== expected.endFramePlanFingerprint
    || receipt.renderer.invoked !== false || receipt.renderer.pixels !== false) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b reopened package identity differs from its fixed receipt.");
  }
}
async function withOutputWorkspaceAuthority<T>(
  host: CheckpointStoryboardRelationMaterializationOutputHost,
  operation: (outputRoot: string, canonicalHost: CheckpointStoryboardRelationMaterializationOutputHost) => Promise<T>,
): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), outputSpelling = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspaceRoot, outputSpelling)) throw new PackageEditTransactionError("unsafe_output", "C6B3b output must be a strict descendant of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B3b output workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(outputSpelling);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B3b output package root is not a trusted directory.");
    const outputRoot = await realpath(outputSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B3b output package root cannot be canonicalized: ${message(error)}`); });
    if (outputRoot !== outputSpelling || !strictDescendant(workspaceRoot, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B3b output package root must be the canonical strict workspace descendant without intermediate symlinks.");
    const after = await lstat(outputRoot);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C6B3b output package root changed while canonicalizing.");
    return await operation(outputRoot, Object.freeze({ outputPackageRoot: outputRoot, packageWorkspaceRoot: workspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }));
  });
}
function sameMask(actual: readonly string[], expected: readonly string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }
function frozen<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) frozen(child); Object.freeze(value); } return value; }
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
