/** Opaque host authority for C6C B5 lifecycle resolution. Command data selects no paths. */
import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-lifecycle-resolution-authority");
const authorityFacts = new WeakMap<CheckpointStoryboardLifecycleResolutionAuthority, LifecycleResolutionAuthorityFacts>();

export interface CheckpointStoryboardLifecycleResolutionAuthority { readonly [authorityBrand]: "host-configured-c6c-b5-lifecycle-resolution"; }
export interface LifecycleResolutionAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  /** Host-selected canonical lexical output root; command inputs can never select it. */
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export async function configureCheckpointStoryboardLifecycleResolutionAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}): Promise<CheckpointStoryboardLifecycleResolutionAuthority> {
  checkedAuthority(input.recordStore);
  if (!input || typeof input.sourcePackageRoot !== "string" || typeof input.outputPackageRoot !== "string" || typeof input.packageWorkspaceRoot !== "string") throw new Error("Checkpoint storyboard lifecycle resolution requires host-selected package paths.");
  const workspace = resolve(input.packageWorkspaceRoot), source = resolve(input.sourcePackageRoot), output = resolve(input.outputPackageRoot);
  if (!strictDescendant(workspace, source) || !strictDescendant(workspace, output) || overlaps(source, output)) throw new Error("Checkpoint storyboard lifecycle resolution source and output must be non-overlapping strict workspace descendants.");
  await assertTrustedWorkspaceAnchorPath(input.packageWorkspaceAuthority, workspace);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Checkpoint storyboard lifecycle resolution source package root must be a non-symlink directory.");
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-b5-lifecycle-resolution" as const });
  authorityFacts.set(authority, Object.freeze({ store: input.recordStore, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: input.packageWorkspaceAuthority }));
  return authority;
}

export function checkedCheckpointStoryboardLifecycleResolutionAuthority(authority: CheckpointStoryboardLifecycleResolutionAuthority): LifecycleResolutionAuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-b5-lifecycle-resolution") throw new Error("Checkpoint storyboard lifecycle resolution authority is not host-minted.");
  return facts;
}
export function assertCheckpointStoryboardLifecycleResolutionAuthorityStore(authority: CheckpointStoryboardLifecycleResolutionAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardLifecycleResolutionAuthority(authority).store !== store) throw storeError("materialization_authority_refused", "Checkpoint storyboard lifecycle resolution authority is not bound to this lifecycle record store.");
}
export async function withCheckpointStoryboardLifecycleResolutionAuthority<T>(authority: CheckpointStoryboardLifecycleResolutionAuthority, run: (facts: LifecycleResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardLifecycleResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store)); await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    const source = await lstat(facts.sourcePackageRoot); if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("source changed");
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard lifecycle resolution authority or selected paths changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** Recovery/replay/detach reopens only output, so source drift cannot hide a committed COW. */
export async function withCheckpointStoryboardLifecycleResolutionOutputAuthority<T>(authority: CheckpointStoryboardLifecycleResolutionAuthority, run: (facts: LifecycleResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardLifecycleResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store)); await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard lifecycle resolution output authority or selected workspace changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** B5-domain HMAC handle excludes object/layer bindings by design. */
export function checkpointStoryboardLifecycleResolutionOutputHandle(authority: CheckpointStoryboardLifecycleResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): string {
  const facts = checkedCheckpointStoryboardLifecycleResolutionAuthority(authority), store = checkedAuthority(facts.store);
  const digest = createHmac("sha256", store.integrityKey).update(canonicalJson({ schema: "shellx-motion/private-checkpoint-storyboard-lifecycle-resolution-output-handle@1", storeBinding: store.storeBinding, identity, output: facts.outputPackageRoot })).digest("hex");
  return `checkpoint_storyboard_lifecycle_output_${digest.slice(0, 32)}`;
}
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || strictDescendant(left, right) || strictDescendant(right, left); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
