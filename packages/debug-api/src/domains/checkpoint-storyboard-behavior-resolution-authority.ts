/** Opaque host authority for C6C B2 behavior resolution. Command data never selects paths. */
import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-behavior-resolution-authority");
const authorityFacts = new WeakMap<CheckpointStoryboardBehaviorResolutionAuthority, BehaviorResolutionAuthorityFacts>();

export interface CheckpointStoryboardBehaviorResolutionAuthority {
  readonly [authorityBrand]: "host-configured-c6c-b2-behavior-resolution";
}
export interface CheckpointStoryboardBehaviorResolutionBinding { readonly objectId: string; readonly layerId: string; }
export interface BehaviorResolutionAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly objectLayerBinding: CheckpointStoryboardBehaviorResolutionBinding;
}

export async function configureCheckpointStoryboardBehaviorResolutionAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly objectLayerBinding: CheckpointStoryboardBehaviorResolutionBinding;
}): Promise<CheckpointStoryboardBehaviorResolutionAuthority> {
  checkedAuthority(input.recordStore);
  if (!input || typeof input.sourcePackageRoot !== "string" || typeof input.outputPackageRoot !== "string" || typeof input.packageWorkspaceRoot !== "string") throw new Error("Checkpoint storyboard behavior resolution requires host-selected package paths.");
  if (!validBinding(input.objectLayerBinding)) throw new Error("Checkpoint storyboard behavior resolution requires one host-owned exact object/layer binding.");
  const workspace = resolve(input.packageWorkspaceRoot), source = resolve(input.sourcePackageRoot), output = resolve(input.outputPackageRoot);
  if (!strictDescendant(workspace, source) || !strictDescendant(workspace, output)) throw new Error("Checkpoint storyboard behavior resolution source and output must be strict workspace descendants.");
  await assertTrustedWorkspaceAnchorPath(input.packageWorkspaceAuthority, workspace);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Checkpoint storyboard behavior resolution source package root must be a non-symlink directory.");
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-b2-behavior-resolution" as const });
  authorityFacts.set(authority, Object.freeze({ store: input.recordStore, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: input.packageWorkspaceAuthority, objectLayerBinding: Object.freeze({ ...input.objectLayerBinding }) }));
  return authority;
}

export function checkedCheckpointStoryboardBehaviorResolutionAuthority(authority: CheckpointStoryboardBehaviorResolutionAuthority): BehaviorResolutionAuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-b2-behavior-resolution") throw new Error("Checkpoint storyboard behavior resolution authority is not host-minted.");
  return facts;
}
export function assertCheckpointStoryboardBehaviorResolutionAuthorityStore(authority: CheckpointStoryboardBehaviorResolutionAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardBehaviorResolutionAuthority(authority).store !== store) throw storeError("materialization_authority_refused", "Checkpoint storyboard behavior resolution authority is not bound to this lifecycle record store.");
}
/** COW uses source and output; replay/recovery uses output only so a changed source cannot hide an installed result. */
export async function withCheckpointStoryboardBehaviorResolutionAuthority<T>(authority: CheckpointStoryboardBehaviorResolutionAuthority, run: (facts: BehaviorResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardBehaviorResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    const source = await lstat(facts.sourcePackageRoot); if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("source changed");
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard behavior resolution authority or selected paths changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
export async function withCheckpointStoryboardBehaviorResolutionOutputAuthority<T>(authority: CheckpointStoryboardBehaviorResolutionAuthority, run: (facts: BehaviorResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardBehaviorResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard behavior resolution output authority or selected workspace changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** A B2-domain-separated HMAC handle cannot collide with legacy B1 output handles. */
export function checkpointStoryboardBehaviorResolutionOutputHandle(authority: CheckpointStoryboardBehaviorResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): string {
  const facts = checkedCheckpointStoryboardBehaviorResolutionAuthority(authority), store = checkedAuthority(facts.store);
  const digest = createHmac("sha256", store.integrityKey).update(canonicalJson({ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-output-handle@1", storeBinding: store.storeBinding, identity, output: facts.outputPackageRoot })).digest("hex");
  return `checkpoint_storyboard_behavior_output_${digest.slice(0, 32)}`;
}
function validBinding(value: unknown): value is CheckpointStoryboardBehaviorResolutionBinding { return !!value && typeof value === "object" && typeof (value as CheckpointStoryboardBehaviorResolutionBinding).objectId === "string" && typeof (value as CheckpointStoryboardBehaviorResolutionBinding).layerId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test((value as CheckpointStoryboardBehaviorResolutionBinding).objectId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test((value as CheckpointStoryboardBehaviorResolutionBinding).layerId); }
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
