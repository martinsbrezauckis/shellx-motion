/** Opaque host authority for C6C B4a relation-action resolution. Command data selects no paths. */
import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-relation-action-resolution-authority");
const authorityFacts = new WeakMap<CheckpointStoryboardRelationActionResolutionAuthority, RelationActionResolutionAuthorityFacts>();

export interface CheckpointStoryboardRelationActionResolutionAuthority { readonly [authorityBrand]: "host-configured-c6c-b4a-relation-action-resolution"; }
export interface CheckpointStoryboardRelationActionResolutionBinding { readonly objectId: string; readonly layerId: string; }
export interface RelationActionResolutionAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  /** Exactly two catalog-order same-ID object/layer bindings, selected only by the host. */
  readonly objectLayerBindings: readonly [CheckpointStoryboardRelationActionResolutionBinding, CheckpointStoryboardRelationActionResolutionBinding];
}

export async function configureCheckpointStoryboardRelationActionResolutionAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly objectLayerBindings: readonly [CheckpointStoryboardRelationActionResolutionBinding, CheckpointStoryboardRelationActionResolutionBinding];
}): Promise<CheckpointStoryboardRelationActionResolutionAuthority> {
  checkedAuthority(input.recordStore);
  if (!input || typeof input.sourcePackageRoot !== "string" || typeof input.outputPackageRoot !== "string" || typeof input.packageWorkspaceRoot !== "string") throw new Error("Checkpoint storyboard relation-action resolution requires host-selected package paths.");
  if (!Array.isArray(input.objectLayerBindings) || input.objectLayerBindings.length !== 2 || !input.objectLayerBindings.every(validBinding) || input.objectLayerBindings[0]!.objectId === input.objectLayerBindings[1]!.objectId || input.objectLayerBindings[0]!.layerId === input.objectLayerBindings[1]!.layerId) throw new Error("Checkpoint storyboard relation-action resolution requires exactly two distinct host-owned object/layer bindings.");
  const workspace = resolve(input.packageWorkspaceRoot), source = resolve(input.sourcePackageRoot), output = resolve(input.outputPackageRoot);
  if (!strictDescendant(workspace, source) || !strictDescendant(workspace, output)) throw new Error("Checkpoint storyboard relation-action resolution source and output must be strict workspace descendants.");
  await assertTrustedWorkspaceAnchorPath(input.packageWorkspaceAuthority, workspace);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Checkpoint storyboard relation-action resolution source package root must be a non-symlink directory.");
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-b4a-relation-action-resolution" as const });
  authorityFacts.set(authority, Object.freeze({ store: input.recordStore, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: input.packageWorkspaceAuthority, objectLayerBindings: Object.freeze(input.objectLayerBindings.map((binding) => Object.freeze({ ...binding })) as [CheckpointStoryboardRelationActionResolutionBinding, CheckpointStoryboardRelationActionResolutionBinding]) }));
  return authority;
}

export function checkedCheckpointStoryboardRelationActionResolutionAuthority(authority: CheckpointStoryboardRelationActionResolutionAuthority): RelationActionResolutionAuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-b4a-relation-action-resolution") throw new Error("Checkpoint storyboard relation-action resolution authority is not host-minted.");
  return facts;
}
export function assertCheckpointStoryboardRelationActionResolutionAuthorityStore(authority: CheckpointStoryboardRelationActionResolutionAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardRelationActionResolutionAuthority(authority).store !== store) throw storeError("materialization_authority_refused", "Checkpoint storyboard relation-action resolution authority is not bound to this lifecycle record store.");
}
export async function withCheckpointStoryboardRelationActionResolutionAuthority<T>(authority: CheckpointStoryboardRelationActionResolutionAuthority, run: (facts: RelationActionResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardRelationActionResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store)); await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    const source = await lstat(facts.sourcePackageRoot); if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("source changed");
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard relation-action resolution authority or selected paths changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** Recovery/replay/detach reopens only output, so source drift cannot hide a committed COW. */
export async function withCheckpointStoryboardRelationActionResolutionOutputAuthority<T>(authority: CheckpointStoryboardRelationActionResolutionAuthority, run: (facts: RelationActionResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardRelationActionResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store)); await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard relation-action resolution output authority or selected workspace changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** B4-domain HMAC handles cannot collide with B1, B2, or B3 host handles. */
export function checkpointStoryboardRelationActionResolutionOutputHandle(authority: CheckpointStoryboardRelationActionResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): string {
  const facts = checkedCheckpointStoryboardRelationActionResolutionAuthority(authority), store = checkedAuthority(facts.store);
  const digest = createHmac("sha256", store.integrityKey).update(canonicalJson({ schema: "shellx-motion/private-checkpoint-storyboard-relation-action-resolution-output-handle@1", storeBinding: store.storeBinding, identity, output: facts.outputPackageRoot, bindings: facts.objectLayerBindings })).digest("hex");
  return `checkpoint_storyboard_relation_action_output_${digest.slice(0, 32)}`;
}
function validBinding(value: unknown): value is CheckpointStoryboardRelationActionResolutionBinding { return !!value && typeof value === "object" && typeof (value as CheckpointStoryboardRelationActionResolutionBinding).objectId === "string" && typeof (value as CheckpointStoryboardRelationActionResolutionBinding).layerId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test((value as CheckpointStoryboardRelationActionResolutionBinding).objectId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test((value as CheckpointStoryboardRelationActionResolutionBinding).layerId); }
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
