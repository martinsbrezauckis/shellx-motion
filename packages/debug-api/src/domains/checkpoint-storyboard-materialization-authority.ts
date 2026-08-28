/** Host-only, path-owning authority for C6C B1a.  Commands receive identities, never locations. */
import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { authorityBrand, storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const materializationAuthorityBrand: unique symbol = Symbol("checkpoint-storyboard-materialization-authority");
const materializationFacts = new WeakMap<CheckpointStoryboardMaterializationAuthority, MaterializationAuthorityFacts>();

export interface CheckpointStoryboardMaterializationAuthority {
  readonly [materializationAuthorityBrand]: "host-configured-c6c-b1a-materialization";
}
export interface CheckpointStoryboardMaterializationBinding {
  readonly objectId: string;
  readonly layerId: string;
}
interface MaterializationAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly objectLayerBindings?: readonly CheckpointStoryboardMaterializationBinding[];
}

/** Configure from a host integration; paths and binding maps are retained only in this WeakMap. */
export async function configureCheckpointStoryboardMaterializationAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly objectLayerBindings?: readonly CheckpointStoryboardMaterializationBinding[];
}): Promise<CheckpointStoryboardMaterializationAuthority> {
  checkedAuthority(input.recordStore);
  if (!input || typeof input.sourcePackageRoot !== "string" || typeof input.outputPackageRoot !== "string" || typeof input.packageWorkspaceRoot !== "string") throw new Error("Checkpoint storyboard materialization requires host-selected package paths.");
  const workspace = resolve(input.packageWorkspaceRoot), source = resolve(input.sourcePackageRoot), output = resolve(input.outputPackageRoot);
  if (!strictDescendant(workspace, source) || !strictDescendant(workspace, output)) throw new Error("Checkpoint storyboard materialization source and output must be strict descendants of the host workspace.");
  await assertTrustedWorkspaceAnchorPath(input.packageWorkspaceAuthority, workspace);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Checkpoint storyboard materialization source package root must be a non-symlink directory.");
  const bindings = input.objectLayerBindings ? Object.freeze(input.objectLayerBindings.map((binding) => {
    if (!binding || typeof binding.objectId !== "string" || typeof binding.layerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(binding.objectId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(binding.layerId)) throw new Error("Checkpoint storyboard materialization binding is invalid.");
    return Object.freeze({ objectId: binding.objectId, layerId: binding.layerId });
  })) : undefined;
  if (bindings && (new Set(bindings.map((binding) => binding.objectId)).size !== bindings.length || new Set(bindings.map((binding) => binding.layerId)).size !== bindings.length)) throw new Error("Checkpoint storyboard materialization bindings must have unique object and layer ids.");
  const authority = Object.freeze({ [materializationAuthorityBrand]: "host-configured-c6c-b1a-materialization" as const });
  materializationFacts.set(authority, Object.freeze({ store: input.recordStore, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: input.packageWorkspaceAuthority, ...(bindings ? { objectLayerBindings: bindings } : {}) }));
  // Ensure a structurally copied store authority was not accepted merely because paths look valid.
  if (input.recordStore[authorityBrand] !== "host-configured-c6c-record-store") throw new Error("Checkpoint storyboard materialization record store authority is invalid.");
  return authority;
}

export function checkedCheckpointStoryboardMaterializationAuthority(authority: CheckpointStoryboardMaterializationAuthority): MaterializationAuthorityFacts {
  const facts = materializationFacts.get(authority);
  if (!facts || authority[materializationAuthorityBrand] !== "host-configured-c6c-b1a-materialization") throw new Error("Checkpoint storyboard materialization authority is not host-minted.");
  return facts;
}
/** Opaque identity comparison: lifecycle and materialization must name the same host store. */
export function assertCheckpointStoryboardMaterializationAuthorityStore(authority: CheckpointStoryboardMaterializationAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardMaterializationAuthority(authority).store !== store) {
    throw storeError("materialization_authority_refused", "Checkpoint storyboard materialization authority is not bound to this lifecycle record store.");
  }
}
export async function withCheckpointStoryboardMaterializationAuthority<T>(authority: CheckpointStoryboardMaterializationAuthority, run: (facts: MaterializationAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardMaterializationAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    const source = await lstat(facts.sourcePackageRoot);
    if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("source changed");
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw new Error("Checkpoint storyboard materialization host authority or selected paths changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** Recovery/replay authority validates the opaque store, workspace, and output only. */
export async function withCheckpointStoryboardMaterializationOutputAuthority<T>(authority: CheckpointStoryboardMaterializationAuthority, run: (facts: MaterializationAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardMaterializationAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch { throw storeError("materialization_authority_refused", "Checkpoint storyboard materialization output authority or selected workspace changed."); }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}
/** Deterministic, safe opaque output handle; it cannot be turned back into a filesystem path. */
export function checkpointStoryboardOutputHandle(authority: CheckpointStoryboardMaterializationAuthority, identity: CheckpointStoryboardRecordIdentity): string {
  const facts = checkedCheckpointStoryboardMaterializationAuthority(authority);
  const store = checkedAuthority(facts.store);
  const digest = createHmac("sha256", store.integrityKey).update(canonicalJson({ schema: "shellx-motion/private-checkpoint-storyboard-output-handle@1", storeBinding: store.storeBinding, identity, output: facts.outputPackageRoot })).digest("hex");
  return `checkpoint_storyboard_output_${digest.slice(0, 32)}`;
}
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
export type { MaterializationAuthorityFacts };
