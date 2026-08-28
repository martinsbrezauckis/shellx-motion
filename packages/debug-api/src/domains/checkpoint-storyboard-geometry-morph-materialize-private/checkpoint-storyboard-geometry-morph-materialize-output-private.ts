/** Output-only C6B6b reopen. It accepts no source, approval, plan, or writer authority. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJsonSha256, type MotionDocument } from "@shellx-motion/core";
import { compileCheckpointStoryboardGeometryMorphProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-geometry-morph-profile";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  c6B6bCurrentInventory,
  c6B6bNonReceiptInventory,
  c6B6bPreservedLeaves,
  c6B6bSame,
  closedC6B6bInventory,
  observeC6B6bPackage,
  type CheckpointStoryboardGeometryMorphMaterializationOutputHost,
} from "./checkpoint-storyboard-geometry-morph-materialize-facts-private.js";
import {
  C6B6B_RECEIPT_PATH,
  readC6B6bReceipt,
  type C6B6bPlanEvidence,
  type CheckpointStoryboardGeometryMorphMaterializationReceipt,
} from "./checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";

export type { CheckpointStoryboardGeometryMorphMaterializationOutputHost } from "./checkpoint-storyboard-geometry-morph-materialize-facts-private.js";

export interface CheckpointStoryboardGeometryMorphMaterializationInstalledOutput {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-installed-output@1";
  readonly receipt: {
    readonly schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-receipt@1";
    readonly fingerprint: string;
  };
  readonly package: {
    readonly id: string;
    readonly manifest: { readonly rawSha256: string; readonly canonicalSha256: string };
    readonly motion: { readonly rawSha256: string; readonly canonicalSha256: string };
    readonly currentInventory: { readonly sha256: string; readonly entryCount: number; readonly leafCount: number };
    readonly nonReceiptInventory: { readonly sha256: string; readonly entryCount: number; readonly leafCount: number };
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
  };
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
  readonly plan: { readonly fingerprint: string };
  readonly profile: { readonly fingerprint: string };
  readonly geometry: {
    readonly layerId: string;
    readonly layerIndex: number;
    readonly staticGeometrySha256: string;
    readonly geometryKeyframesSha256: string;
    readonly endpointSha256: readonly [string, string];
  };
  readonly materialization: {
    readonly changedMotionRoot: "layers";
    readonly changedLeafCount: 2;
    readonly renderer: { readonly invoked: false; readonly pixels: false };
  };
}

/**
 * Reopens an installed C6B6b output through output/workspace authority alone.
 * Receipt data is integrity evidence only: it never restores source-path or writer authority.
 */
export async function reopenCheckpointStoryboardGeometryMorphMaterializationOutput(
  host: CheckpointStoryboardGeometryMorphMaterializationOutputHost,
): Promise<CheckpointStoryboardGeometryMorphMaterializationInstalledOutput> {
  return await withOutputWorkspaceAuthority(host, async (outputRoot, canonicalHost) => {
    const before = await readC6B6bReceipt(outputRoot);
    const output = await observeC6B6bPackage(outputRoot, canonicalHost);
    assertReceiptBinding(before, output);

    const source = reconstructSource(output.pkg.motion, before);
    const plan = await recompile(before, output.pkg.manifest, source);
    assertRecompiledPlan(before, plan, output.pkg.motion);

    const snapshot = await snapshotPackageEditTree(outputRoot);
    const nonReceiptInventory = c6B6bNonReceiptInventory(snapshot);
    const currentInventory = await closedC6B6bInventory(outputRoot, canonicalHost);
    const preservedLeaves = c6B6bPreservedLeaves(snapshot, output.pkg.manifest.motion);
    const expectedPaths = [output.pkg.manifest.motion, C6B6B_RECEIPT_PATH].sort();
    const receiptEntryDelta = currentInventory.entryCount - nonReceiptInventory.entryCount;
    if (
      !c6B6bSame(nonReceiptInventory, before.output.nonReceiptInventory)
      || !c6B6bSame(currentInventory, c6B6bCurrentInventory(snapshot))
      || (receiptEntryDelta !== 0 && receiptEntryDelta !== 1)
      || currentInventory.leafCount !== nonReceiptInventory.leafCount + 1
      || !c6B6bSame(preservedLeaves, before.output.preservedLeaves)
      || !c6B6bSame(before.output.changed.paths, expectedPaths)
      || before.output.changed.count !== 2
      || before.output.changed.motionPropertyPaths.length !== 1
      || before.output.changed.motionPropertyPaths[0] !== "/layers/0/geometryKeyframes"
      || before.output.changed.motionPropertyPathCount !== 1
    ) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B6b output inventory or preserved leaves differ from the fixed receipt.");
    }

    const afterOutput = await observeC6B6bPackage(outputRoot, canonicalHost);
    const afterSnapshot = await snapshotPackageEditTree(outputRoot);
    const afterInventory = await closedC6B6bInventory(outputRoot, canonicalHost);
    const after = await readC6B6bReceipt(outputRoot);
    if (
      afterOutput.base.packageId !== output.base.packageId
      || afterOutput.base.manifestRawSha256 !== output.base.manifestRawSha256
      || afterOutput.base.motionRawSha256 !== output.base.motionRawSha256
      || afterOutput.base.motionCanonicalSha256 !== output.base.motionCanonicalSha256
      || !c6B6bSame(c6B6bCurrentInventory(afterSnapshot), currentInventory)
      || !c6B6bSame(afterInventory, currentInventory)
      || !c6B6bSame(after, before)
    ) {
      throw new PackageEditTransactionError("copy_mismatch", "C6B6b receipt, inventory, or package changed during installed-output reopen.");
    }

    const expected = before.base.expected;
    const endpoints = plan.projection.endpoints;
    return freeze({
      schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-installed-output@1",
      receipt: freeze({ schema: before.schema, fingerprint: before.fingerprint }),
      package: freeze({
        id: output.base.packageId,
        manifest: freeze({ rawSha256: output.base.manifestRawSha256, canonicalSha256: output.base.manifestCanonicalSha256 }),
        motion: freeze({ rawSha256: output.base.motionRawSha256, canonicalSha256: output.base.motionCanonicalSha256 }),
        currentInventory,
        nonReceiptInventory,
        preservedLeaves,
      }),
      storyboard: freeze({ id: before.approval.storyboard.id, sha256: before.approval.storyboard.sha256, revision: before.approval.storyboard.revision }),
      plan: freeze({ fingerprint: plan.fingerprint }),
      profile: freeze({ fingerprint: plan.lowererProfile.fingerprint }),
      geometry: freeze({
        layerId: expected.sourceLayerId,
        layerIndex: expected.sourceLayerIndex,
        staticGeometrySha256: expected.sourceGeometrySha256,
        geometryKeyframesSha256: expected.materializedGeometryKeyframesSha256,
        endpointSha256: freeze([endpoints[0].sha256, endpoints[1].sha256]) as readonly [string, string],
      }),
      materialization: freeze({
        changedMotionRoot: "layers" as const,
        changedLeafCount: 2 as const,
        renderer: freeze({ invoked: false as const, pixels: false as const }),
      }),
    });
  });
}

function assertReceiptBinding(
  receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt,
  output: Awaited<ReturnType<typeof observeC6B6bPackage>>,
): void {
  const expected = receipt.base.expected;
  if (
    !c6B6bSame(expected, receipt.base.reopened)
    || output.base.packageId !== receipt.output.packageId
    || output.base.packageId !== expected.packageId
    || output.base.manifestRawSha256 !== receipt.output.manifestRawSha256
    || receipt.output.manifestRawSha256 !== expected.manifestRawSha256
    || output.base.manifestCanonicalSha256 !== expected.manifestCanonicalSha256
    || output.base.motionRawSha256 !== receipt.output.motionRawSha256
    || output.base.motionCanonicalSha256 !== receipt.output.canonicalMotionSha256
    || output.base.motionCanonicalSha256 !== expected.outputCanonicalMotionSha256
    || expected.sourceGeometryKeyframes !== "absent"
    || receipt.approval.plan.fingerprint !== expected.planFingerprint
    || receipt.approval.plan.lowererProfile.fingerprint !== expected.profileFingerprint
    || receipt.approval.storyboard.id !== expected.storyboardId
    || receipt.approval.storyboard.sha256 !== expected.storyboardSha256
    || receipt.approval.storyboard.revision !== expected.storyboardRevision
    || receipt.renderer.invoked !== false
    || receipt.renderer.pixels !== false
  ) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B6b reopened package identity differs from its fixed receipt.");
  }
}

function reconstructSource(
  output: MotionDocument,
  receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt,
): MotionDocument {
  const expected = receipt.base.expected;
  const layer = output.layers[expected.sourceLayerIndex] as (MotionDocument["layers"][number] & { readonly geometry?: unknown; readonly geometryKeyframes?: unknown }) | undefined;
  if (
    !layer
    || layer.id !== expected.sourceLayerId
    || !Object.hasOwn(layer, "geometryKeyframes")
    || !Object.hasOwn(layer, "geometry")
    || canonicalJsonSha256(layer.geometry) !== expected.sourceGeometrySha256
    || canonicalJsonSha256(layer.geometryKeyframes) !== expected.materializedGeometryKeyframesSha256
  ) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B6b output cannot reconstruct its sealed static geometry and installed keyframes.");
  }
  const source = structuredClone(output) as MotionDocument;
  const sourceLayer = source.layers[expected.sourceLayerIndex] as MotionDocument["layers"][number] & { geometryKeyframes?: unknown };
  const { geometryKeyframes: _geometryKeyframes, ...withoutKeyframes } = sourceLayer;
  source.layers[expected.sourceLayerIndex] = withoutKeyframes;
  if (
    Object.hasOwn(source.layers[expected.sourceLayerIndex] as object, "geometryKeyframes")
    || canonicalJsonSha256(source) !== expected.motionCanonicalSha256
  ) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B6b reconstructed source Motion identity differs from its receipt.");
  }
  return source;
}

async function recompile(
  receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt,
  manifest: unknown,
  motion: MotionDocument,
): Promise<C6B6bPlanEvidence> {
  try {
    const expected = receipt.base.expected;
    return compileCheckpointStoryboardGeometryMorphProfilePlan({
      schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-request@1",
      storyboard: receipt.approval.storyboard.record,
      base: {
        packageId: expected.packageId,
        manifest,
        motion,
        persistedMotionSha256: expected.motionRawSha256,
      },
      objectLayerBindings: [{ objectId: expected.sourceLayerId, layerId: expected.sourceLayerId }],
    });
  } catch (error) {
    throw new PackageEditTransactionError("copy_mismatch", `C6B6b output cannot recompile its sealed geometry-morph plan: ${message(error)}`);
  }
}

function assertRecompiledPlan(
  receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt,
  plan: C6B6bPlanEvidence,
  output: MotionDocument,
): void {
  const expected = receipt.base.expected;
  const layer = output.layers[expected.sourceLayerIndex] as (MotionDocument["layers"][number] & { readonly geometryKeyframes?: unknown }) | undefined;
  const endpoints = plan.projection.endpoints;
  if (
    !c6B6bSame(plan, receipt.approval.plan)
    || plan.fingerprint !== expected.planFingerprint
    || plan.lowererProfile.fingerprint !== expected.profileFingerprint
    || plan.storyboard.id !== expected.storyboardId
    || plan.storyboard.sha256 !== expected.storyboardSha256
    || plan.storyboard.revision !== expected.storyboardRevision
    || plan.objectLayerBinding.layerId !== expected.sourceLayerId
    || plan.objectLayerBinding.objectId !== expected.sourceLayerId
    || plan.objectLayerBinding.layerIndex !== expected.sourceLayerIndex
    || plan.projection.path !== "/layers/0/geometryKeyframes"
    || plan.projection.staticGeometry.sha256 !== expected.sourceGeometrySha256
    || canonicalJsonSha256(plan.projection.geometryKeyframes) !== expected.materializedGeometryKeyframesSha256
    || !layer
    || !Object.hasOwn(layer, "geometryKeyframes")
    || !c6B6bSame(layer.geometryKeyframes, plan.projection.geometryKeyframes)
    || plan.projection.geometryKeyframes.keyframes.length !== 2
    || endpoints.length !== 2
    || endpoints[0].atUs !== 0
    || endpoints[1].atUs !== output.durationMs * 1_000
    || plan.projection.geometryKeyframes.keyframes[0]?.atUs !== endpoints[0].atUs
    || plan.projection.geometryKeyframes.keyframes[1]?.atUs !== endpoints[1].atUs
    || !c6B6bSame(plan.projection.geometryKeyframes.keyframes[0]?.geometry, endpoints[0].geometry)
    || !c6B6bSame(plan.projection.geometryKeyframes.keyframes[1]?.geometry, endpoints[1].geometry)
  ) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B6b output geometry projection, endpoint sequence, or retained plan differs from the receipt.");
  }
}

async function withOutputWorkspaceAuthority<T>(
  host: CheckpointStoryboardGeometryMorphMaterializationOutputHost,
  operation: (outputRoot: string, canonicalHost: CheckpointStoryboardGeometryMorphMaterializationOutputHost) => Promise<T>,
): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot);
  const outputSpelling = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspaceRoot, outputSpelling)) {
    throw new PackageEditTransactionError("unsafe_output", "C6B6b output must be a strict descendant of the host workspace.");
  }
  try {
    await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot);
  } catch (error) {
    throw new PackageEditTransactionError("unsafe_output", `C6B6b output workspace authority is invalid: ${message(error)}`);
  }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(outputSpelling);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new PackageEditTransactionError("unsafe_output", "C6B6b output package root is not a trusted directory.");
    }
    const outputRoot = await realpath(outputSpelling).catch((error) => {
      throw new PackageEditTransactionError("unsafe_output", `C6B6b output package root cannot be canonicalized: ${message(error)}`);
    });
    if (outputRoot !== outputSpelling || !strictDescendant(workspaceRoot, outputRoot)) {
      throw new PackageEditTransactionError("unsafe_output", "C6B6b output package root must be a canonical strict workspace descendant without intermediate symlinks.");
    }
    const after = await lstat(outputRoot);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new PackageEditTransactionError("unsafe_output", "C6B6b output package root changed while canonicalizing.");
    }
    return await operation(outputRoot, freeze({
      outputPackageRoot: outputRoot,
      packageWorkspaceRoot: workspaceRoot,
      packageWorkspaceAuthority: host.packageWorkspaceAuthority,
    }));
  });
}

function strictDescendant(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as object)) freeze(child);
  return Object.freeze(value);
}
