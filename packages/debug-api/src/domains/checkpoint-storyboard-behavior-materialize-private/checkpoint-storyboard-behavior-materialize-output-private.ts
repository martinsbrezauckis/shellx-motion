/** Output-only C6B2 verification for later recovery; it neither accepts nor needs the source package. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJsonSha256, compareCodeUnits, compileMotionDocumentCompositing, type MotionBehaviorStore } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { C6B2_RECEIPT_PATH, readC6B2Receipt, type C6B2Inventory } from "./checkpoint-storyboard-behavior-materialize-receipt-private.js";
import { c6B2CurrentInventory, c6B2NonReceiptInventory, c6B2PreservedLeaves, c6B2Same, closedC6B2Inventory, observeC6B2Package, type CheckpointStoryboardBehaviorMaterializationOutputHost } from "./checkpoint-storyboard-behavior-materialize-facts-private.js";

export type { CheckpointStoryboardBehaviorMaterializationOutputHost } from "./checkpoint-storyboard-behavior-materialize-facts-private.js";
export interface CheckpointStoryboardBehaviorMaterializationInstalledOutput {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-behavior-materialization-installed-output@1";
  readonly receipt: { readonly schema: "shellx-motion/private-checkpoint-storyboard-behavior-materialization-receipt@1"; readonly fingerprint: string };
  readonly package: { readonly id: string; readonly manifest: { readonly rawSha256: string; readonly canonicalSha256: string }; readonly motion: { readonly rawSha256: string; readonly canonicalSha256: string }; readonly currentInventory: C6B2Inventory; readonly nonReceiptInventory: C6B2Inventory; readonly preservedLeaves: { readonly sha256: string; readonly count: number } };
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
  readonly plan: { readonly fingerprint: string };
  readonly profile: { readonly fingerprint: string };
  readonly behaviorStore: { readonly schema: "shellx-motion/behaviors@1"; readonly sha256: string; readonly bindings: readonly MotionBehaviorStore["bindings"][number][] };
  readonly materialization: { readonly changedMotionRoot: "behaviors"; readonly changedLeafCount: 2; readonly renderer: { readonly invoked: false; readonly pixels: false } };
}

/** Reopens one installed C6B2 COW package solely through host workspace authority and fixed receipt evidence. */
export async function reopenCheckpointStoryboardBehaviorMaterializationOutput(host: CheckpointStoryboardBehaviorMaterializationOutputHost): Promise<CheckpointStoryboardBehaviorMaterializationInstalledOutput> {
  return await withOutputWorkspaceAuthority(host, async (outputRoot, canonicalHost) => {
    const before = await readC6B2Receipt(outputRoot), output = await observeC6B2Package(outputRoot, canonicalHost);
    assertReceiptBinding(before, output);
    const behaviors = validateMotionBehaviors(output.pkg.motion.behaviors, output.pkg.motion);
    if (!behaviors.ok || !behaviors.store || behaviors.store.bindings.length !== 1) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened output does not contain one valid behaviors@1 binding.");
    const binding = behaviors.store.bindings[0]!;
    if (binding.kind !== "transform" || !binding.motion || binding.squash !== undefined || (binding.motion.kind !== "gravity" && binding.motion.kind !== "bounce")) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened output does not contain the closed transform behavior profile.");
    const storeSha256 = canonicalJsonSha256(behaviors.store);
    if (storeSha256 !== before.approval.storeSha256 || storeSha256 !== before.base.expected.storeSha256 || before.approval.planFingerprint !== before.base.expected.planFingerprint || before.approval.profileFingerprint !== before.base.expected.profileFingerprint) throw new PackageEditTransactionError("copy_mismatch", "C6B2 behavior-plan/profile receipt binding differs from the installed store.");
    if (canonicalJsonSha256(compileMotionDocumentCompositing(output.pkg.motion)) !== output.base.motionCanonicalSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened output compositing compilation is not idempotent.");
    const snapshot = await snapshotPackageEditTree(outputRoot), nonReceiptInventory = c6B2NonReceiptInventory(snapshot), currentInventory = await closedC6B2Inventory(outputRoot, canonicalHost), expectedPaths = [output.pkg.manifest.motion, C6B2_RECEIPT_PATH].sort(compareCodeUnits);
    if (!c6B2Same(nonReceiptInventory, before.output.nonReceiptInventory) || !c6B2Same(currentInventory, c6B2CurrentInventory(snapshot)) || currentInventory.entryCount !== nonReceiptInventory.entryCount + 1 || currentInventory.leafCount !== nonReceiptInventory.leafCount + 1 || !c6B2Same(c6B2PreservedLeaves(snapshot, output.pkg.manifest.motion), before.output.preservedLeaves) || !c6B2Same(before.output.changed.paths, expectedPaths) || before.output.changed.count !== 2 || before.output.changed.motionPropertyPaths[0] !== "behaviors" || before.output.changed.motionPropertyPathCount !== 1) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened output tree differs from its fixed receipt evidence.");
    const after = await readC6B2Receipt(outputRoot);
    if (!c6B2Same(after, before)) throw new PackageEditTransactionError("copy_mismatch", "C6B2 receipt changed during installed-output reopen.");
    return Object.freeze({
      schema: "shellx-motion/private-checkpoint-storyboard-behavior-materialization-installed-output@1",
      receipt: Object.freeze({ schema: before.schema, fingerprint: before.fingerprint }),
      package: Object.freeze({ id: output.base.packageId, manifest: Object.freeze({ rawSha256: output.base.manifestRawSha256, canonicalSha256: output.base.manifestCanonicalSha256 }), motion: Object.freeze({ rawSha256: output.base.motionRawSha256, canonicalSha256: output.base.motionCanonicalSha256 }), currentInventory, nonReceiptInventory, preservedLeaves: Object.freeze({ ...before.output.preservedLeaves }) }),
      storyboard: Object.freeze({ ...before.approval.storyboard }), plan: Object.freeze({ fingerprint: before.approval.planFingerprint }), profile: Object.freeze({ fingerprint: before.approval.profileFingerprint }),
      behaviorStore: Object.freeze({ schema: behaviors.store.schema, sha256: storeSha256, bindings: frozen(structuredClone(behaviors.store.bindings)) }),
      materialization: Object.freeze({ changedMotionRoot: "behaviors" as const, changedLeafCount: 2 as const, renderer: Object.freeze({ invoked: false as const, pixels: false as const }) }),
    });
  });
}

function assertReceiptBinding(receipt: Awaited<ReturnType<typeof readC6B2Receipt>>, output: Awaited<ReturnType<typeof observeC6B2Package>>): void {
  if (!c6B2Same(receipt.base.expected, receipt.base.reopened) || receipt.base.expected.packageId !== output.base.packageId || receipt.base.expected.manifestRawSha256 !== output.base.manifestRawSha256 || receipt.base.expected.manifestCanonicalSha256 !== output.base.manifestCanonicalSha256 || receipt.output.packageId !== output.base.packageId || receipt.output.manifestRawSha256 !== output.base.manifestRawSha256 || receipt.output.motionRawSha256 !== output.base.motionRawSha256 || receipt.output.canonicalMotionSha256 !== output.base.motionCanonicalSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B2 reopened package identity differs from its fixed receipt.");
  if (receipt.renderer.invoked !== false || receipt.renderer.pixels !== false) throw new PackageEditTransactionError("copy_mismatch", "C6B2 receipt renderer evidence is invalid.");
}
async function withOutputWorkspaceAuthority<T>(host: CheckpointStoryboardBehaviorMaterializationOutputHost, operation: (outputRoot: string, canonicalHost: CheckpointStoryboardBehaviorMaterializationOutputHost) => Promise<T>): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), outputSpelling = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspaceRoot, outputSpelling)) throw new PackageEditTransactionError("unsafe_output", "C6B2 output must be a strict descendant of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); } catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B2 output workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(outputSpelling); if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B2 output package root is not a trusted directory.");
    const outputRoot = await realpath(outputSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B2 output package root cannot be canonicalized: ${message(error)}`); });
    if (outputRoot !== outputSpelling || !strictDescendant(workspaceRoot, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B2 output package root must be the canonical strict workspace descendant without intermediate symlinks.");
    const after = await lstat(outputRoot); if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C6B2 output package root changed while canonicalizing.");
    return await operation(outputRoot, Object.freeze({ outputPackageRoot: outputRoot, packageWorkspaceRoot: workspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }));
  });
}
function frozen<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) frozen(child); Object.freeze(value); } return value; }
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
