/** Shared C7B4D package observations and the two independently anchored workspaces. */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  hashBuffer,
  loadMotionPackage,
  readBoundedStableFile,
  requiredLoadedPackageDocumentHashes,
  type MotionPackage,
} from "@shellx-motion/core";
import { captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories } from "@shellx-motion/core/internal/closed-directory-inventory";
import {
  assertTrustedWorkspaceAnchorPath,
  withTrustedWorkspaceAnchor,
  type TrustedWorkspaceAnchor,
} from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import type { PhysicsBakeDurableReopenHost } from "../physics-bake-durable-private/physics-bake-durable-types-private.js";

export const C7B4D_ARTIFACT_ROOT = "analysis/physics-bake" as const;
export const C7B4D_SIDECAR_PATH = "analysis/scene-recipe/physics-visual.recipe.json" as const;
export const C7B4D_RECEIPT_PATH = "receipts/physics-visual.materialize.receipt.json" as const;

export interface PhysicsVisualPackageMaterializationHost {
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly physicsBakeArtifactRoot: string;
  readonly physicsWorkspaceRoot: string;
  readonly physicsWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly requireAbsentOutput: true;
}

export interface PhysicsVisualPackageOutputHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export interface C7B4dInventory { readonly sha256: string; readonly entryCount: number; readonly leafCount: number }
export interface C7B4dPackageDocuments {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionRawSha256: string;
  readonly motionCanonicalSha256: string;
}
export interface C7B4dPackageIdentity extends C7B4dPackageDocuments { readonly inventory: C7B4dInventory }
export interface C7B4dPackageFacts {
  readonly pkg: MotionPackage;
  readonly documents: C7B4dPackageDocuments;
  readonly base: C7B4dPackageIdentity;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
}
export interface C7B4dCanonicalRoots {
  readonly packageWorkspaceRoot: string;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly physicsHost: PhysicsBakeDurableReopenHost;
}

export async function observeC7B4dPackage(root: string, host: Pick<PhysicsVisualPackageOutputHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">): Promise<C7B4dPackageFacts> {
  const pkg = await loadMotionPackage(root);
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "C7B4D physics-visual package materialization");
  const [manifest, motion, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), { label: "C7B4D manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true }),
    readBoundedStableFile(join(pkg.root, pkg.manifest.motion), { label: "C7B4D Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true }),
    snapshotPackageEditTree(pkg.root),
    closedC7B4dInventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) {
    throw new PackageEditTransactionError("source_changed", "C7B4D package documents changed while reopened.");
  }
  const documents = freeze({ packageId: pkg.manifest.id, manifestRawSha256: manifest.sha256, manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest), motionRawSha256: motion.sha256, motionCanonicalSha256: canonicalJsonSha256(pkg.motion) });
  return freeze({ pkg, documents, base: freeze({ ...documents, inventory }), snapshot });
}

export async function closedC7B4dInventory(root: string, host: Pick<PhysicsVisualPackageOutputHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">): Promise<C7B4dInventory> {
  const entry = await lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PackageEditTransactionError("unsupported_source_entry", "C7B4D package root is not a regular directory.");
  try {
    // Native mutation remains Linux descriptor-pinned. Portable output-only reopen instead uses
    // the bounded no-follow snapshot, including a strict single-link policy, and pins the package
    // root identity around that full traversal. Critical C7B4D leaves are independently reopened
    // with their own stable no-follow readers before and after this semantic inventory proof.
    if (process.platform !== "linux") {
      const snapshot = await snapshotPackageEditTree(root, { requireSingleLink: true });
      const after = await lstat(root, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== entry.dev || after.ino !== entry.ino) throw new Error("C7B4D package root changed during portable inventory capture.");
      return c7B4dInventoryForSnapshot(snapshot);
    }
    const inventory = await captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories({
      workspaceRoot: host.packageWorkspaceRoot,
      workspaceAuthority: host.packageWorkspaceAuthority,
      directory: root,
      identity: { dev: Number(entry.dev), ino: Number(entry.ino) },
      label: "C7B4D package inventory",
    });
    return freeze({ sha256: inventory.evidence.sha256, entryCount: inventory.evidence.entryCount, leafCount: inventory.evidence.leafCount });
  } catch {
    throw new PackageEditTransactionError("unsupported_source_entry", "C7B4D package does not satisfy closed-inventory limits.");
  }
}

export function c7B4dInventoryForSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, omit: readonly string[] = []): C7B4dInventory {
  const entries = [...snapshot.entries].filter(([path]) => !omit.includes(path));
  const files = entries.filter(([, value]) => value.startsWith("file:")).map(([path, value]) => {
    const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value);
    if (!match) throw new PackageEditTransactionError("copy_mismatch", "C7B4D inventory contains an invalid file leaf.");
    return { path, byteLength: Number(match[1]), sha256: match[2]! };
  });
  const empties = entries.filter(([path, value]) => value === "dir" && !entries.some(([other]) => other.startsWith(`${path}/`))).map(([path]) => ({ path, kind: "empty-directory" as const }));
  const all = [...files, ...empties].sort((left, right) => compareCodeUnits(left.path, right.path));
  const digest = all.map((entry) => "kind" in entry ? `${entry.path}\u0000empty-directory\n` : `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
  return freeze({ sha256: hashBuffer(Buffer.from(digest, "utf8")), entryCount: all.length, leafCount: files.length });
}

export function c7B4dPreservedSourceLeaves(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): { readonly sha256: string; readonly count: number } {
  const leaves = [...snapshot.entries]
    .filter(([path, value]) => value.startsWith("file:") && !isMaterializationPath(path))
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return freeze({ sha256: canonicalJsonSha256(leaves), count: leaves.length });
}

export function isMaterializationPath(path: string): boolean {
  return path === C7B4D_ARTIFACT_ROOT || path.startsWith(`${C7B4D_ARTIFACT_ROOT}/`) || path === C7B4D_SIDECAR_PATH || path === C7B4D_RECEIPT_PATH;
}

export function assertC7B4dArtifactsAbsent(facts: C7B4dPackageFacts): void {
  if ([C7B4D_ARTIFACT_ROOT, C7B4D_SIDECAR_PATH, C7B4D_RECEIPT_PATH].some((path) => facts.snapshot.entries.has(path))) {
    throw new PackageEditTransactionError("source_changed", "C7B4D fixed embedded artifact, sidecar or receipt already exists.");
  }
}

export function c7B4dSame(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
export function sameC7B4dDocuments(left: C7B4dPackageDocuments, right: C7B4dPackageDocuments): boolean {
  return left.packageId === right.packageId && left.manifestRawSha256 === right.manifestRawSha256 && left.manifestCanonicalSha256 === right.manifestCanonicalSha256 && left.motionRawSha256 === right.motionRawSha256 && left.motionCanonicalSha256 === right.motionCanonicalSha256;
}

export async function withC7B4dMaterializationAuthority<T>(host: PhysicsVisualPackageMaterializationHost, operation: (roots: C7B4dCanonicalRoots) => Promise<T>): Promise<T> {
  if (process.platform !== "linux") throw new PackageEditTransactionError("unsafe_output", "C7B4D package copy-on-write requires the Linux descriptor-relative primitive.");
  if (host.requireAbsentOutput !== true) throw new PackageEditTransactionError("unsafe_output", "C7B4D requires an absent-output host contract.");
  if (host.packageWorkspaceAuthority === host.physicsWorkspaceAuthority) throw new PackageEditTransactionError("unsafe_output", "C7B4D requires independently minted package and C7B3 workspace authorities.");
  const packageWorkspaceRoot = resolve(host.packageWorkspaceRoot), sourceSpelling = resolve(host.sourcePackageRoot), outputSpelling = resolve(host.outputPackageRoot);
  if (!descendant(packageWorkspaceRoot, sourceSpelling) || !descendant(packageWorkspaceRoot, outputSpelling) || overlaps(sourceSpelling, outputSpelling)) {
    throw new PackageEditTransactionError("unsafe_output", "C7B4D source and absent output must be non-overlapping strict package-workspace descendants.");
  }
  await assertWorkspace(host.packageWorkspaceAuthority, packageWorkspaceRoot, "package");
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const sourcePackageRoot = await canonicalExistingDirectory(sourceSpelling, packageWorkspaceRoot, "C7B4D source package root");
    const outputPackageRoot = await canonicalAbsentPath(outputSpelling, packageWorkspaceRoot, "C7B4D output package root");
    if (overlaps(sourcePackageRoot, outputPackageRoot)) throw new PackageEditTransactionError("unsafe_output", "C7B4D source and output overlap after canonicalization.");
    const physicsHost = await canonicalPhysicsHost(host, sourcePackageRoot, outputPackageRoot);
    return await operation(freeze({ packageWorkspaceRoot, sourcePackageRoot, outputPackageRoot, physicsHost }));
  });
}

export async function withC7B4dOutputAuthority<T>(host: PhysicsVisualPackageOutputHost, operation: (root: string, canonical: PhysicsVisualPackageOutputHost) => Promise<T>): Promise<T> {
  const packageWorkspaceRoot = resolve(host.packageWorkspaceRoot), spelling = resolve(host.outputPackageRoot);
  if (!descendant(packageWorkspaceRoot, spelling)) throw new PackageEditTransactionError("unsafe_output", "C7B4D output must be a strict package-workspace descendant.");
  await assertWorkspace(host.packageWorkspaceAuthority, packageWorkspaceRoot, "package");
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const root = await canonicalExistingDirectory(spelling, packageWorkspaceRoot, "C7B4D output package root");
    return await operation(root, freeze({ outputPackageRoot: root, packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }));
  });
}

export function canonicalC7B4dHost(host: PhysicsVisualPackageMaterializationHost, roots: C7B4dCanonicalRoots): PhysicsVisualPackageMaterializationHost {
  return freeze({ ...host, sourcePackageRoot: roots.sourcePackageRoot, outputPackageRoot: roots.outputPackageRoot, packageWorkspaceRoot: roots.packageWorkspaceRoot, physicsBakeArtifactRoot: roots.physicsHost.outputRoot, physicsWorkspaceRoot: roots.physicsHost.workspaceRoot, requireAbsentOutput: true as const });
}

async function canonicalPhysicsHost(host: PhysicsVisualPackageMaterializationHost, sourceRoot: string, outputRoot: string): Promise<PhysicsBakeDurableReopenHost> {
  const workspaceRoot = resolve(host.physicsWorkspaceRoot), spelling = resolve(host.physicsBakeArtifactRoot);
  if (!descendant(workspaceRoot, spelling)) throw new PackageEditTransactionError("unsafe_output", "C7B4D external C7B3 artifact must be a strict physics-workspace descendant.");
  await assertWorkspace(host.physicsWorkspaceAuthority, workspaceRoot, "C7B3");
  return await withTrustedWorkspaceAnchor(host.physicsWorkspaceAuthority, async () => {
    const outputRootCanonical = await canonicalExistingDirectory(spelling, workspaceRoot, "C7B4D external C7B3 artifact");
    if (overlaps(outputRootCanonical, sourceRoot) || overlaps(outputRootCanonical, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C7B4D external C7B3 artifact must not overlap the package source or output.");
    return freeze({ outputRoot: outputRootCanonical, workspaceRoot, workspaceAuthority: host.physicsWorkspaceAuthority });
  });
}

async function assertWorkspace(authority: TrustedWorkspaceAnchor, workspaceRoot: string, label: string): Promise<void> {
  try { await assertTrustedWorkspaceAnchorPath(authority, workspaceRoot); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C7B4D ${label} workspace authority is invalid: ${message(error)}`); }
}
async function canonicalExistingDirectory(spelling: string, workspaceRoot: string, label: string): Promise<string> {
  const before = await lstat(spelling);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", `${label} must be a non-symlink directory.`);
  const canonical = await realpath(spelling), after = await lstat(canonical);
  if (canonical !== spelling || !descendant(workspaceRoot, canonical) || !after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", `${label} changed while canonicalizing.`);
  return canonical;
}
async function canonicalAbsentPath(spelling: string, workspaceRoot: string, label: string): Promise<string> {
  const canonical = await canonicalPath(spelling);
  if (canonical !== spelling || !descendant(workspaceRoot, canonical)) throw new PackageEditTransactionError("unsafe_output", `${label} must be a canonical strict workspace descendant.`);
  try { await lstat(spelling); throw new PackageEditTransactionError("output_not_empty", `${label} must be absent.`); }
  catch (error) { if (!missing(error)) throw error; }
  return canonical;
}
function descendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || descendant(left, right) || descendant(right, left); }
async function canonicalPath(path: string): Promise<string> { const resolved = resolve(path); try { return await realpath(resolved); } catch { const parent = dirname(resolved); return parent === resolved ? resolved : join(await canonicalPath(parent), basename(resolved)); } }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
