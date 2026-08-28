/** Opaque host authority for C6C B6 geometry-morph resolution. Command data selects no paths. */
import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-geometry-morph-resolution-authority");
const authorityFacts = new WeakMap<CheckpointStoryboardGeometryMorphResolutionAuthority, GeometryMorphResolutionAuthorityFacts>();

export interface CheckpointStoryboardGeometryMorphResolutionAuthority { readonly [authorityBrand]: "host-configured-c6c-b6-geometry-morph-resolution"; }
export interface GeometryMorphResolutionAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  /** Host-selected canonical lexical output root; command inputs can never select it. */
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export async function configureCheckpointStoryboardGeometryMorphResolutionAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}): Promise<CheckpointStoryboardGeometryMorphResolutionAuthority> {
  checkedAuthority(input.recordStore);
  if (!input || typeof input.sourcePackageRoot !== "string" || typeof input.outputPackageRoot !== "string" || typeof input.packageWorkspaceRoot !== "string") throw new Error("Checkpoint storyboard geometry-morph resolution requires host-selected package paths.");
  const workspace = resolve(input.packageWorkspaceRoot), source = resolve(input.sourcePackageRoot), output = resolve(input.outputPackageRoot);
  if (!strictDescendant(workspace, source) || !strictDescendant(workspace, output) || overlaps(source, output)) throw new Error("Checkpoint storyboard geometry-morph resolution source and output must be non-overlapping strict workspace descendants.");
  await assertTrustedWorkspaceAnchorPath(input.packageWorkspaceAuthority, workspace);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Checkpoint storyboard geometry-morph resolution source package root must be a non-symlink directory.");
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-b6-geometry-morph-resolution" as const });
  authorityFacts.set(authority, Object.freeze({ store: input.recordStore, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: input.packageWorkspaceAuthority }));
  return authority;
}

export function checkedCheckpointStoryboardGeometryMorphResolutionAuthority(authority: CheckpointStoryboardGeometryMorphResolutionAuthority): GeometryMorphResolutionAuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-b6-geometry-morph-resolution") throw new Error("Checkpoint storyboard geometry-morph resolution authority is not host-minted.");
  return facts;
}

export function assertCheckpointStoryboardGeometryMorphResolutionAuthorityStore(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardGeometryMorphResolutionAuthority(authority).store !== store) throw storeError("materialization_authority_refused", "Checkpoint storyboard geometry-morph resolution authority is not bound to this geometry-morph record store.");
}

export async function withCheckpointStoryboardGeometryMorphResolutionAuthority<T>(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, run: (facts: GeometryMorphResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardGeometryMorphResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    const source = await lstat(facts.sourcePackageRoot);
    if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("source changed");
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch {
    throw storeError("materialization_authority_refused", "Checkpoint storyboard geometry-morph resolution authority or selected paths changed.");
  }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}

/** Recovery, replay, and detach reopen only output, so source loss cannot hide a committed COW. */
export async function withCheckpointStoryboardGeometryMorphResolutionOutputAuthority<T>(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, run: (facts: GeometryMorphResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardGeometryMorphResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch {
    throw storeError("materialization_authority_refused", "Checkpoint storyboard geometry-morph resolution output authority or selected workspace changed.");
  }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}

/** B6-domain HMAC handle binds only the store, record identity, and host-owned output target. */
export function checkpointStoryboardGeometryMorphResolutionOutputHandle(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): string {
  const facts = checkedCheckpointStoryboardGeometryMorphResolutionAuthority(authority), store = checkedAuthority(facts.store);
  const digest = createHmac("sha256", store.integrityKey).update(canonicalJson({ schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-resolution-output-handle@1", storeBinding: store.storeBinding, identity, output: facts.outputPackageRoot })).digest("hex");
  return `checkpoint_storyboard_geometry_morph_output_${digest.slice(0, 32)}`;
}

function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || strictDescendant(left, right) || strictDescendant(right, left); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
