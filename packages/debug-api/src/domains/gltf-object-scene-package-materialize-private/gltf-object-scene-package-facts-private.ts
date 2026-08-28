/** Shared C7A3f package observations, recipe recompilation and trusted-root authority. */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  hashBuffer,
  loadMotionPackage,
  MAX_GLTF_SOURCE_BYTES,
  parseGltfContainer,
  readBoundedStableFile,
  requiredLoadedPackageDocumentHashes,
  resolvePackageAsset,
  type MotionPackage,
  type ParsedGltfContainer,
} from "@shellx-motion/core";
import {
  compileGltfObjectPlan,
  compileGltfObjectRetainedRenderStaticPlan,
  compileGltfObjectSceneEvaluationPlan,
  compileGltfObjectScenePlan,
  compileGltfObjectStoryPlan,
} from "@shellx-motion/core/internal/scene-recipe";
import { snapshotCheckpointStoryboardData } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories } from "@shellx-motion/core/internal/closed-directory-inventory";
import {
  assertTrustedWorkspaceAnchorPath,
  withTrustedWorkspaceAnchor,
  type TrustedWorkspaceAnchor,
} from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";

export const C7A3F_SIDECAR_PATH = "analysis/scene-recipe/imported-object.recipe.json" as const;
export const C7A3F_RECEIPT_PATH = "receipts/imported-object-scene.materialize.receipt.json" as const;

export interface GltfObjectScenePackageMaterializationHost {
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly requireAbsentOutput: true;
}

export interface GltfObjectScenePackageOutputHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export type C7A3fWorkspaceHost = Pick<GltfObjectScenePackageMaterializationHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">;
export interface C7A3fInventory { readonly sha256: string; readonly entryCount: number; readonly leafCount: number }
export interface C7A3fPackageIdentity {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionRawSha256: string;
  readonly motionCanonicalSha256: string;
  readonly inventory: C7A3fInventory;
}
export interface C7A3fSourceIdentity {
  readonly assetRef: string;
  readonly format: "gltf" | "glb";
  readonly sha256: string;
  readonly jsonSha256: string;
  readonly bufferSha256: readonly string[];
  readonly byteLength: number;
}
export interface C7A3fRecipeBundle {
  readonly declaration: unknown;
  readonly story: unknown;
  readonly scene: unknown;
  readonly evaluation: unknown;
  readonly retainedRender: unknown;
}
export interface C7A3fPlanIdentities {
  readonly objectFingerprint: string;
  readonly storyFingerprint: string;
  readonly sceneFingerprint: string;
  readonly evaluationFingerprint: string;
  readonly retainedRenderFingerprint: string;
}
export interface C7A3fPackageFacts {
  readonly pkg: MotionPackage;
  readonly base: C7A3fPackageIdentity;
  readonly source: C7A3fSourceIdentity;
  readonly container: ParsedGltfContainer;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
}
export interface CompiledC7A3fRecipeBundle {
  readonly recipes: C7A3fRecipeBundle;
  readonly plans: C7A3fPlanIdentities;
  readonly recipeBundleFingerprint: string;
  readonly objectPlan: ReturnType<typeof compileGltfObjectPlan>;
  readonly storyPlan: ReturnType<typeof compileGltfObjectStoryPlan>;
  readonly scenePlan: ReturnType<typeof compileGltfObjectScenePlan>;
  readonly evaluationPlan: ReturnType<typeof compileGltfObjectSceneEvaluationPlan>;
  readonly retainedRenderPlan: ReturnType<typeof compileGltfObjectRetainedRenderStaticPlan>;
}

export async function observeC7A3fPackage(root: string, host: C7A3fWorkspaceHost): Promise<C7A3fPackageFacts> {
  const pkg = await loadMotionPackage(root);
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "C7A3f imported-object recipe materialization");
  const adapter = readGltfAdapter(pkg);
  const sourcePath = resolvePackageAsset(pkg, adapter.assetRef);
  const [manifest, motion, sourceFile, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), { label: "C7A3f manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true }),
    readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), { label: "C7A3f Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true }),
    readBoundedStableFile(sourcePath, { label: "C7A3f package glTF source", maxBytes: MAX_GLTF_SOURCE_BYTES, withinRoot: pkg.root, requireSingleLink: true }),
    snapshotPackageEditTree(pkg.root),
    closedC7A3fInventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) throw new PackageEditTransactionError("source_changed", "C7A3f package documents changed while reopened.");
  if (sourceFile.sha256 !== adapter.sourceSha256) throw new PackageEditTransactionError("source_changed", "C7A3f package glTF source does not match its manifest identity.");
  let container: ParsedGltfContainer;
  try { container = parseGltfContainer(sourceFile.bytes, adapter.format); }
  catch (error) { throw new PackageEditTransactionError("source_changed", `C7A3f package glTF source is not admitted: ${message(error)}`); }
  if (container.sourceSha256 !== sourceFile.sha256) throw new PackageEditTransactionError("source_changed", "C7A3f parsed glTF identity changed after its bounded read.");
  const source = freeze({ assetRef: adapter.assetRef, format: adapter.format, sha256: container.sourceSha256, jsonSha256: canonicalJsonSha256(container.json), bufferSha256: freeze([...container.bufferSha256]), byteLength: container.byteLength });
  const base = freeze({ packageId: pkg.manifest.id, manifestRawSha256: manifest.sha256, manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest), motionRawSha256: motion.sha256, motionCanonicalSha256: canonicalJsonSha256(pkg.motion), inventory });
  return freeze({ pkg, base, source, container, snapshot });
}

export function compileC7A3fRecipeBundle(facts: C7A3fPackageFacts, value: unknown): CompiledC7A3fRecipeBundle {
  const input = readRecipeBundle(value);
  try {
    const objectPlan = compileGltfObjectPlan(facts.container, input.declaration);
    const storyPlan = compileGltfObjectStoryPlan(objectPlan, input.story);
    const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, input.scene);
    const evaluationPlan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, input.evaluation);
    const retainedRenderPlan = compileGltfObjectRetainedRenderStaticPlan(evaluationPlan, input.retainedRender);
    const recipes = freeze({ declaration: objectPlan.declaration, story: storyPlan.story, scene: scenePlan.assembly, evaluation: evaluationPlan.evaluation, retainedRender: retainedRenderPlan.recipe });
    const plans = freeze({ objectFingerprint: objectPlan.fingerprint, storyFingerprint: storyPlan.fingerprint, sceneFingerprint: scenePlan.fingerprint, evaluationFingerprint: evaluationPlan.fingerprint, retainedRenderFingerprint: retainedRenderPlan.fingerprint });
    return freeze({ recipes, plans, recipeBundleFingerprint: canonicalJsonSha256(recipes), objectPlan, storyPlan, scenePlan, evaluationPlan, retainedRenderPlan });
  } catch (error) {
    throw new PackageEditTransactionError("source_changed", `C7A3f recipe chain cannot be compiled from the package glTF source: ${message(error)}`);
  }
}

export async function closedC7A3fInventory(root: string, host: C7A3fWorkspaceHost): Promise<C7A3fInventory> {
  const entry = await lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PackageEditTransactionError("unsupported_source_entry", "C7A3f package root is not a regular directory.");
  try {
    const inventory = await captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories({ workspaceRoot: host.packageWorkspaceRoot, workspaceAuthority: host.packageWorkspaceAuthority, directory: root, identity: { dev: Number(entry.dev), ino: Number(entry.ino) }, label: "C7A3f package inventory" });
    return freeze({ sha256: inventory.evidence.sha256, entryCount: inventory.evidence.entryCount, leafCount: inventory.evidence.leafCount });
  } catch {
    throw new PackageEditTransactionError("unsupported_source_entry", "C7A3f package does not satisfy closed-inventory limits.");
  }
}

export function c7A3fInventoryForSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, omit: readonly string[] = []): C7A3fInventory {
  const entries = [...snapshot.entries].filter(([path]) => !omit.includes(path));
  const files = entries.filter(([, value]) => value.startsWith("file:")).map(([path, value]) => {
    const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value);
    if (!match) throw new PackageEditTransactionError("copy_mismatch", "C7A3f inventory contains an invalid file leaf.");
    return { path, byteLength: Number(match[1]), sha256: match[2]! };
  });
  const empties = entries.filter(([path, value]) => value === "dir" && !entries.some(([other]) => other.startsWith(`${path}/`))).map(([path]) => ({ path, kind: "empty-directory" as const }));
  const all = [...files, ...empties].sort((left, right) => compareCodeUnits(left.path, right.path));
  const digest = all.map((entry) => "kind" in entry ? `${entry.path}\u0000empty-directory\n` : `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
  return freeze({ sha256: hashBuffer(Buffer.from(digest, "utf8")), entryCount: all.length, leafCount: files.length });
}

export function c7A3fPreservedLeaves(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): { readonly sha256: string; readonly count: number } {
  const leaves = [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== C7A3F_SIDECAR_PATH && path !== C7A3F_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right));
  return freeze({ sha256: canonicalJsonSha256(leaves), count: leaves.length });
}

export function c7A3fSame(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }

export interface C7A3fCanonicalRoots { readonly workspaceRoot: string; readonly sourceRoot: string; readonly outputRoot: string }
export async function withC7A3fWorkspaceAuthority<T>(host: GltfObjectScenePackageMaterializationHost, operation: (roots: C7A3fCanonicalRoots) => Promise<T>): Promise<T> {
  if (host.requireAbsentOutput !== true) throw new PackageEditTransactionError("unsafe_output", "C7A3f requires an absent-output host contract.");
  const workspaceRoot = resolve(host.packageWorkspaceRoot), sourceSpelling = resolve(host.sourcePackageRoot), outputRoot = resolve(host.outputPackageRoot);
  if (!descendant(workspaceRoot, sourceSpelling) || !descendant(workspaceRoot, outputRoot) || overlaps(sourceSpelling, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C7A3f source and absent output must be non-overlapping strict descendants of the host workspace.");
  await assertWorkspaceAuthority(host.packageWorkspaceAuthority, workspaceRoot);
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(sourceSpelling);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C7A3f source package root must be a non-symlink directory.");
    const sourceRoot = await realpath(sourceSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C7A3f source package root cannot be canonicalized: ${message(error)}`); });
    const after = await lstat(sourceRoot);
    if (sourceRoot !== sourceSpelling || !descendant(workspaceRoot, sourceRoot) || !after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C7A3f source package root changed while canonicalizing.");
    const canonicalOutput = await canonicalPath(outputRoot).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C7A3f output package root cannot be canonicalized: ${message(error)}`); });
    if (canonicalOutput !== outputRoot || !descendant(workspaceRoot, canonicalOutput) || overlaps(sourceRoot, canonicalOutput)) throw new PackageEditTransactionError("unsafe_output", "C7A3f output package root must be a canonical non-overlapping strict workspace descendant.");
    try { await lstat(outputRoot); throw new PackageEditTransactionError("output_not_empty", "C7A3f output package root must be absent."); } catch (error) { if (!missing(error)) throw error; }
    return await operation(freeze({ workspaceRoot, sourceRoot, outputRoot }));
  });
}

export async function withC7A3fOutputAuthority<T>(host: GltfObjectScenePackageOutputHost, operation: (root: string, canonical: GltfObjectScenePackageOutputHost) => Promise<T>): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), spelling = resolve(host.outputPackageRoot);
  if (!descendant(workspaceRoot, spelling)) throw new PackageEditTransactionError("unsafe_output", "C7A3f output must be a strict workspace descendant.");
  await assertWorkspaceAuthority(host.packageWorkspaceAuthority, workspaceRoot);
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(spelling);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C7A3f output is not a trusted directory.");
    const root = await realpath(spelling), after = await lstat(root);
    if (root !== spelling || !descendant(workspaceRoot, root) || !after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C7A3f output changed while canonicalizing.");
    return await operation(root, freeze({ outputPackageRoot: root, packageWorkspaceRoot: workspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }));
  });
}

export function canonicalC7A3fHost(host: GltfObjectScenePackageMaterializationHost, roots: C7A3fCanonicalRoots): GltfObjectScenePackageMaterializationHost {
  return freeze({ ...host, packageWorkspaceRoot: roots.workspaceRoot, sourcePackageRoot: roots.sourceRoot, outputPackageRoot: roots.outputRoot, requireAbsentOutput: true as const });
}

function readRecipeBundle(value: unknown): C7A3fRecipeBundle {
  const root = exactObject(snapshotCheckpointStoryboardData(value), "C7A3f recipe bundle");
  const keys = ["declaration", "story", "scene", "evaluation", "retainedRender"] as const;
  if (!sameKeys(root, keys)) throw new Error("C7A3f recipe bundle has unsupported or missing fields.");
  return freeze({ declaration: root.declaration, story: root.story, scene: root.scene, evaluation: root.evaluation, retainedRender: root.retainedRender });
}

function readGltfAdapter(pkg: MotionPackage): { readonly assetRef: string; readonly sourceSha256: string; readonly format: "gltf" | "glb" } {
  const manifest = pkg.manifest as unknown as Record<string, unknown>, data = exactObject(manifest.data, "C7A3f manifest.data"), adapter = exactObject(data.adapter, "C7A3f manifest adapter"), container = exactObject(adapter.container, "C7A3f manifest glTF container");
  if (adapter.id !== "adapter.gltf" || typeof adapter.source !== "string" || adapter.source.length < 1 || adapter.source.length > 512 || typeof adapter.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(adapter.sourceSha256) || container.schema !== "shellx-motion/gltf-source@1" || (container.format !== "gltf" && container.format !== "glb")) throw new PackageEditTransactionError("source_changed", "C7A3f requires one package-owned adapter.gltf source identity.");
  return freeze({ assetRef: adapter.source, sourceSha256: adapter.sourceSha256, format: container.format });
}

async function assertWorkspaceAuthority(authority: TrustedWorkspaceAnchor, workspaceRoot: string): Promise<void> {
  try { await assertTrustedWorkspaceAnchorPath(authority, workspaceRoot); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C7A3f host workspace authority is invalid: ${message(error)}`); }
}
function exactObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key)); }
function descendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || descendant(left, right) || descendant(right, left); }
async function canonicalPath(path: string): Promise<string> { const resolved = resolve(path); try { return await realpath(resolved); } catch { const parent = dirname(resolved); return parent === resolved ? resolved : join(await canonicalPath(parent), basename(resolved)); } }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
