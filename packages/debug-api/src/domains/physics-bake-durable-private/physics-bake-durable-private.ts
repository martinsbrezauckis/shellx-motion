/** Private C7B3 provider-to-durable-artifact host. It registers no public or Debug command. */
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, hashBuffer, isPublicationCommitUncertain, readBoundedStableFile, writeVerifiedBoundedFile } from "@shellx-motion/core";
import { readPhysicsBakeAdmissionPlan } from "@shellx-motion/core/internal/scene-recipe";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction-error.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { PackageEditWorkspace } from "../package-edit-transaction-workspace.js";
import { bakePhysicsWithPinnedRapier } from "../physics-bake-rapier-private/physics-bake-rapier-private.js";
import { compilePhysicsBakeDurableArtifact } from "./physics-bake-durable-codec-private.js";
import { decodePhysicsBakeDurableSegments } from "./physics-bake-durable-decode-private.js";
import {
  createPhysicsBakeDurableReceipt,
  readPhysicsBakeDurableManifest,
  readPhysicsBakeDurableReceipt,
  serializedPhysicsBakeDurableManifest,
  serializedPhysicsBakeDurableReceipt,
} from "./physics-bake-durable-manifest-private.js";
import {
  PHYSICS_BAKE_DURABLE_CAPS,
  type PhysicsBakeDurableHost,
  type PhysicsBakeDurableOptions,
  type PhysicsBakeDurablePrepared,
  type PhysicsBakeDurableReopenHost,
  type PhysicsBakeDurableReopenResult,
  type PhysicsBakeDurableResult,
} from "./physics-bake-durable-types-private.js";

/** Runs C7B2 internally and atomically installs one closed, lossless artifact directory. */
export async function bakePhysicsToDurableArtifact(planValue: unknown, host: PhysicsBakeDurableHost, options: PhysicsBakeDurableOptions = {}): Promise<PhysicsBakeDurableResult> {
  if (process.platform !== "linux") throw new PackageEditTransactionError("unsafe_output", "C7B3 closed-inventory publication currently requires the Linux descriptor-relative primitive.");
  throwIfAborted(options.signal); const plan = readPhysicsBakeAdmissionPlan(planValue);
  return await withOutputAuthority(host, true, async (outputRoot, canonicalHost) => {
    const result = await bakePhysicsWithPinnedRapier(plan, { signal: options.signal }); throwIfAborted(options.signal);
    return await publishPrepared(outputRoot, canonicalHost, compilePhysicsBakeDurableArtifact(plan, result), options.signal);
  });
}

/** Reopens only a complete exact C7B3 output; partial or altered directories fail closed. */
export async function reopenPhysicsBakeDurableArtifact(host: PhysicsBakeDurableReopenHost): Promise<PhysicsBakeDurableReopenResult> {
  return await withOutputAuthority(host, false, async (outputRoot) => await reopenAt(outputRoot));
}

/** Narrow C7B4D reader: C7B3 reopen plus a one-link invariant for every copied leaf. */
export async function reopenPhysicsBakeDurableArtifactWithSingleLinkedLeaves(host: PhysicsBakeDurableReopenHost): Promise<PhysicsBakeDurableReopenResult> {
  return await withOutputAuthority(host, false, async (outputRoot) => await reopenAt(outputRoot, true));
}

/**
 * Copies one strictly reopened C7B3 artifact into an already-private, empty package stage.
 *
 * This intentionally exposes neither a recursive-copy primitive nor a caller-defined leaf
 * inventory: the source manifest is reopened by C7B3, each fixed leaf is no-follow read, every
 * destination leaf is exclusively created, and the embedded result is immediately reopened.
 */
export async function copyPhysicsBakeDurableArtifactIntoPrivateStage(
  host: PhysicsBakeDurableReopenHost,
  destinationHost: PhysicsBakeDurableReopenHost,
): Promise<PhysicsBakeDurableReopenResult> {
  if (process.platform !== "linux") {
    throw new PackageEditTransactionError("unsafe_output", "C7B3 private artifact copying requires the Linux no-follow primitive.");
  }
  // The two trusted workspaces deliberately cannot be active together.  First capture every
  // fixed C7B3 source leaf under the external-artifact authority, then leave that scope before
  // publishing through the independently anchored package-stage route.
  const captured = await withOutputAuthority(host, false, async (sourceRoot) => {
    const source = await reopenAt(sourceRoot, true);
    const leaves = [
      { path: "manifest.json", cap: PHYSICS_BAKE_DURABLE_CAPS.manifestBytes },
      { path: "receipt.json", cap: PHYSICS_BAKE_DURABLE_CAPS.receiptBytes },
      ...source.manifest.segments.map((segment) => ({ path: segment.path, cap: segment.byteLength })),
    ];
    const bytes = new Map<string, Buffer>();
    for (const leaf of leaves) {
      // C7B4D may never follow a swapped `segments/` route between C7B3's inventory reopen and
      // the byte capture. Core retains and rechecks every source-directory edge under sourceRoot.
      bytes.set(leaf.path, (await readBoundedStableFile(join(sourceRoot, leaf.path), {
        label: `C7B4D C7B3 copied leaf '${leaf.path}'`,
        maxBytes: leaf.cap,
        withinRoot: sourceRoot,
        requireSingleLink: true,
      })).bytes);
    }
    return Object.freeze({ sourceRoot, source, leaves: Object.freeze(leaves), bytes });
  });

  const embedded = await withOutputAuthority(destinationHost, false, async (destination) => {
    if (destination === captured.sourceRoot) {
      throw new PackageEditTransactionError("unsafe_output", "C7B3 private artifact copy source and destination must differ.");
    }
    const destinationEntry = await lstat(destination);
    if (!destinationEntry.isDirectory() || destinationEntry.isSymbolicLink() || (await readdir(destination)).length !== 0) {
      throw new PackageEditTransactionError("unsafe_output", "C7B3 private artifact destination must be one empty non-symlink directory.");
    }
    await mkdir(join(destination, "segments"), { mode: 0o700 });
    for (const leaf of captured.leaves) {
      const bytes = captured.bytes.get(leaf.path);
      if (!bytes) throw new PackageEditTransactionError("copy_mismatch", "C7B4D C7B3 source capture is incomplete.");
      const destinationPath = join(destination, leaf.path), expectedSha256 = hashBuffer(bytes);
      // The destination is just as hostile as the external C7B3 source: retain every directory
      // edge through publication, then explicitly re-open the resulting one-link leaf.
      const published = await writeVerifiedBoundedFile(destinationPath, bytes, {
        label: `C7B4D embedded C7B3 leaf '${leaf.path}'`,
        maxBytes: leaf.cap,
        withinRoot: destination,
        expectedSha256,
      });
      const reopened = await readBoundedStableFile(destinationPath, {
        label: `C7B4D embedded C7B3 leaf '${leaf.path}'`,
        maxBytes: leaf.cap,
        withinRoot: destination,
        requireSingleLink: true,
      });
      if (published.sha256 !== expectedSha256 || published.byteLength !== bytes.byteLength
        || reopened.sha256 !== expectedSha256 || reopened.byteLength !== bytes.byteLength
        || !reopened.bytes.equals(bytes)) {
        throw new PackageEditTransactionError("copy_mismatch", "C7B4D embedded C7B3 destination did not retain exact copied bytes.");
      }
    }
    return await reopenAt(destination, true);
  });

  // Re-enter only the source authority after destination publication. The fresh C7B3 reopen
  // validates segment bytes against its manifest and proves the captured source remained exact.
  const current = await withOutputAuthority(host, false, async (sourceRoot) => await reopenAt(sourceRoot, true));
  if (canonicalJson(captured.source.manifest) !== canonicalJson(current.manifest)
    || canonicalJson(captured.source.receipt) !== canonicalJson(current.receipt)
    || canonicalJson(captured.source.manifest) !== canonicalJson(embedded.manifest)
    || canonicalJson(captured.source.receipt) !== canonicalJson(embedded.receipt)) {
    throw new PackageEditTransactionError("source_changed", "C7B3 artifact changed while it was copied into the private package stage.");
  }
  return embedded;
}

async function publishPrepared(outputRoot: string, host: PhysicsBakeDurableReopenHost, prepared: PhysicsBakeDurablePrepared, signal: AbortSignal | undefined): Promise<PhysicsBakeDurableResult> {
  const workspace = await PackageEditWorkspace.create(outputRoot, "new", { closedInventory: "finalize-after-edit-with-empty-directories" });
  let initial: Awaited<ReturnType<typeof workspace.inspectOutput>> | undefined, installed: Awaited<ReturnType<typeof workspace.install>> | undefined, cleanup = true, publicationVerified = false;
  try {
    initial = await workspace.inspectOutput();
    if (initial.exists) throw new PackageEditTransactionError("output_not_empty", "C7B3 output must be absent.");
    await mkdir(workspace.stagedPackageRoot, { mode: 0o700 }); await mkdir(join(workspace.stagedPackageRoot, "segments"), { mode: 0o700 });
    for (const segment of prepared.segments) { throwIfAborted(signal); await writeFile(join(workspace.stagedPackageRoot, segment.descriptor.path), segment.bytes, { flag: "wx", mode: 0o600 }); }
    const manifestBytes = serializedPhysicsBakeDurableManifest(prepared.manifest); if (manifestBytes.byteLength > PHYSICS_BAKE_DURABLE_CAPS.manifestBytes) throw new Error("C7B3 manifest exceeds its byte cap.");
    const receipt = createPhysicsBakeDurableReceipt(prepared.manifest, manifestBytes), receiptBytes = serializedPhysicsBakeDurableReceipt(receipt); if (receiptBytes.byteLength > PHYSICS_BAKE_DURABLE_CAPS.receiptBytes) throw new Error("C7B3 receipt exceeds its byte cap.");
    await writeFile(join(workspace.stagedPackageRoot, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 }); await writeFile(join(workspace.stagedPackageRoot, "receipt.json"), receiptBytes, { flag: "wx", mode: 0o600 });
    const staged = await reopenAt(workspace.stagedPackageRoot); assertPrepared(prepared, staged, receipt); throwIfAborted(signal);
    await workspace.pinCompleteStagedInventory(); await workspace.assertPinnedStagedInventoryCurrent(); await workspace.claimOutput(initial); await workspace.assertPinnedStagedInventoryCurrent(); installed = await workspace.install();
    let reopened: PhysicsBakeDurableReopenResult;
    try { reopened = await reopenPhysicsBakeDurableArtifact({ ...host, outputRoot }); }
    catch (error) { throw workspace.postInstallObservationUncertain(error); }
    assertPrepared(prepared, reopened, receipt);
    publicationVerified = true;
    return Object.freeze({ outputRoot, manifest: reopened.manifest, receipt: reopened.receipt, workspaceCleanup: "not-attested" as const });
  } catch (error) {
    if (isPublicationCommitUncertain(error)) { cleanup = false; throw error; }
    try { await workspace.rollback(installed, initial); } catch (rollbackError) { cleanup = false; throw rollbackError; }
    throw error;
  } finally { if (cleanup) { const pending = workspace.cleanup(); if (publicationVerified) await pending.catch(() => undefined); else await pending; } }
}

async function reopenAt(root: string, requireSingleLink = false): Promise<PhysicsBakeDurableReopenResult> {
  const before = await snapshotPackageEditTree(root), manifestBytes = await readStable(root, join(root, "manifest.json"), PHYSICS_BAKE_DURABLE_CAPS.manifestBytes, requireSingleLink), manifest = readPhysicsBakeDurableManifest(parseJson(manifestBytes, "manifest"));
  if (!manifestBytes.equals(serializedPhysicsBakeDurableManifest(manifest))) throw new Error("C7B3 manifest bytes are not canonical.");
  const expected = new Map<string, string>([["segments", "dir"], ["manifest.json", "file"], ["receipt.json", "file"], ...manifest.segments.map((entry) => [entry.path, "file"] as const)]);
  if (before.entries.size !== expected.size) throw new Error("C7B3 artifact inventory contains missing or extra entries.");
  for (const [path, kind] of expected) { const observed = before.entries.get(path); if (!observed || (kind === "dir" ? observed !== "dir" : !observed.startsWith("file:"))) throw new Error(`C7B3 artifact entry '${path}' is missing or has the wrong type.`); }
  const bytesByPath = new Map<string, Buffer>(); let segmentBytes = 0;
  for (const segment of manifest.segments) { const bytes = await readStable(root, join(root, segment.path), segment.byteLength, requireSingleLink); segmentBytes += bytes.byteLength; if (segmentBytes > PHYSICS_BAKE_DURABLE_CAPS.segmentBytes) throw new Error("C7B3 aggregate segment bytes exceed the cap."); bytesByPath.set(segment.path, bytes); }
  const decoded = decodePhysicsBakeDurableSegments(manifest, bytesByPath), expectedReceipt = createPhysicsBakeDurableReceipt(manifest, manifestBytes), receiptBytes = await readStable(root, join(root, "receipt.json"), PHYSICS_BAKE_DURABLE_CAPS.receiptBytes, requireSingleLink), receipt = readPhysicsBakeDurableReceipt(parseJson(receiptBytes, "receipt"), expectedReceipt);
  if (!receiptBytes.equals(serializedPhysicsBakeDurableReceipt(receipt))) throw new Error("C7B3 receipt bytes are not canonical.");
  const after = await snapshotPackageEditTree(root); if (!samePackageEditTreeSnapshot(before, after)) throw new Error("C7B3 artifact changed while reopening.");
  return Object.freeze({ manifest, receipt, ...decoded });
}

async function withOutputAuthority<T>(host: PhysicsBakeDurableReopenHost, requireAbsent: boolean, operation: (outputRoot: string, host: PhysicsBakeDurableReopenHost) => Promise<T>): Promise<T> {
  if (requireAbsent && (host as Partial<PhysicsBakeDurableHost>).requireAbsentOutput !== true) throw new PackageEditTransactionError("unsafe_output", "C7B3 requires an absent-output host contract.");
  const workspaceRoot = resolve(host.workspaceRoot), spelling = resolve(host.outputRoot);
  if (!descendant(workspaceRoot, spelling)) throw new PackageEditTransactionError("unsafe_output", "C7B3 output must be a strict workspace descendant.");
  await assertTrustedWorkspaceAnchorPath(host.workspaceAuthority, workspaceRoot);
  return await withTrustedWorkspaceAnchor(host.workspaceAuthority, async () => {
    if (requireAbsent) {
      const canonical = await canonicalPath(spelling); if (canonical !== spelling || !descendant(workspaceRoot, canonical)) throw new PackageEditTransactionError("unsafe_output", "C7B3 output spelling is not a canonical workspace path.");
      try { await lstat(spelling); throw new PackageEditTransactionError("output_not_empty", "C7B3 output must be absent."); } catch (error) { if (!missing(error)) throw error; }
      return await operation(canonical, Object.freeze({ outputRoot: canonical, workspaceRoot, workspaceAuthority: host.workspaceAuthority }));
    }
    const before = await lstat(spelling), canonical = await realpath(spelling), after = await lstat(canonical);
    if (canonical !== spelling || !descendant(workspaceRoot, canonical) || !before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new PackageEditTransactionError("unsafe_output", "C7B3 artifact root is not one stable canonical workspace directory.");
    return await operation(canonical, Object.freeze({ outputRoot: canonical, workspaceRoot, workspaceAuthority: host.workspaceAuthority }));
  });
}

async function readStable(root: string, path: string, cap: number, requireSingleLink = false): Promise<Buffer> {
  return (await readBoundedStableFile(path, {
    label: `C7B3 artifact file '${relative(root, path)}'`,
    maxBytes: cap,
    withinRoot: root,
    requireSingleLink,
  })).bytes;
}
function assertPrepared(prepared: PhysicsBakeDurablePrepared, reopened: PhysicsBakeDurableReopenResult, receipt: PhysicsBakeDurableResult["receipt"]): void { if (canonicalJson(prepared.manifest) !== canonicalJson(reopened.manifest) || canonicalJson(receipt) !== canonicalJson(reopened.receipt) || canonicalJson(prepared.bodyStateObservations) !== canonicalJson(reopened.bodyStateObservations) || canonicalJson(prepared.contactObservations) !== canonicalJson(reopened.contactObservations)) throw new PackageEditTransactionError("copy_mismatch", "C7B3 reopened artifact differs from its provider result."); }
function parseJson(bytes: Buffer, label: string): unknown { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`C7B3 ${label} is not valid JSON.`); } }
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new PackageEditTransactionError("cancelled", "C7B3 physics bake was cancelled."); }
function descendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
async function canonicalPath(path: string): Promise<string> { try { return await realpath(path); } catch { const parent = dirname(path); return parent === path ? path : join(await canonicalPath(parent), basename(path)); } }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
