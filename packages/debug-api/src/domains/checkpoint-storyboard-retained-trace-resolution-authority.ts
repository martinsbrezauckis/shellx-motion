/** Opaque host authority for C6C B7 retained-trace resolution. Command data selects no paths. */
import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-retained-trace-resolution-authority");
const authorityFacts = new WeakMap<CheckpointStoryboardRetainedTraceResolutionAuthority, RetainedTraceResolutionAuthorityFacts>();
/** One host process must not mint conflicting C6C B7 authorities for one output target. */
const outputClaims = new Map<string, CheckpointStoryboardRetainedTraceResolutionAuthority>();

export interface CheckpointStoryboardRetainedTraceResolutionAuthority { readonly [authorityBrand]: "host-configured-c6c-b7-retained-trace-resolution"; }
export interface RetainedTraceResolutionAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  /** Host-selected canonical lexical output root; command inputs can never select it. */
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export async function configureCheckpointStoryboardRetainedTraceResolutionAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}): Promise<CheckpointStoryboardRetainedTraceResolutionAuthority> {
  checkedAuthority(input.recordStore);
  if (!input || typeof input.sourcePackageRoot !== "string" || typeof input.outputPackageRoot !== "string" || typeof input.packageWorkspaceRoot !== "string") throw new Error("Checkpoint storyboard retained-trace resolution requires host-selected package paths.");
  const workspace = resolve(input.packageWorkspaceRoot), source = resolve(input.sourcePackageRoot), output = resolve(input.outputPackageRoot);
  if (!strictDescendant(workspace, source) || !strictDescendant(workspace, output) || overlaps(source, output)) throw new Error("Checkpoint storyboard retained-trace resolution source and output must be non-overlapping strict workspace descendants.");
  await assertTrustedWorkspaceAnchorPath(input.packageWorkspaceAuthority, workspace);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Checkpoint storyboard retained-trace resolution source package root must be a non-symlink directory.");
  if (outputClaims.has(output)) throw new Error("Checkpoint storyboard retained-trace resolution output already has a process-local authority claim.");
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-b7-retained-trace-resolution" as const });
  authorityFacts.set(authority, Object.freeze({ store: input.recordStore, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: input.packageWorkspaceAuthority }));
  outputClaims.set(output, authority);
  return authority;
}

export function checkedCheckpointStoryboardRetainedTraceResolutionAuthority(authority: CheckpointStoryboardRetainedTraceResolutionAuthority): RetainedTraceResolutionAuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-b7-retained-trace-resolution") throw new Error("Checkpoint storyboard retained-trace resolution authority is not host-minted.");
  return facts;
}

export function assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardRetainedTraceResolutionAuthority(authority).store !== store) throw storeError("materialization_authority_refused", "Checkpoint storyboard retained-trace resolution authority is not bound to this retained-trace record store.");
}

export async function withCheckpointStoryboardRetainedTraceResolutionAuthority<T>(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, run: (facts: RetainedTraceResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardRetainedTraceResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    const source = await lstat(facts.sourcePackageRoot);
    if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("source changed");
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch {
    throw storeError("materialization_authority_refused", "Checkpoint storyboard retained-trace resolution authority or selected paths changed.");
  }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}

/** Recovery, replay, and detach reopen only output, so source loss cannot hide a committed COW. */
export async function withCheckpointStoryboardRetainedTraceResolutionOutputAuthority<T>(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, run: (facts: RetainedTraceResolutionAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardRetainedTraceResolutionAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    await assertTrustedWorkspaceAnchorPath(facts.packageWorkspaceAuthority, facts.packageWorkspaceRoot);
    try { const output = await lstat(facts.outputPackageRoot); if (output.isSymbolicLink()) throw new Error("output changed"); } catch (error) { if (!missing(error)) throw error; }
  } catch {
    throw storeError("materialization_authority_refused", "Checkpoint storyboard retained-trace resolution output authority or selected workspace changed.");
  }
  return await withTrustedWorkspaceAnchor(facts.packageWorkspaceAuthority, () => run(facts));
}

/** B7-domain HMAC handle binds only the store, record identity, and host-owned output target. */
export function checkpointStoryboardRetainedTraceResolutionOutputHandle(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): string {
  const facts = checkedCheckpointStoryboardRetainedTraceResolutionAuthority(authority), store = checkedAuthority(facts.store);
  const digest = createHmac("sha256", store.integrityKey).update(canonicalJson({ schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-resolution-output-handle@1", storeBinding: store.storeBinding, identity, output: facts.outputPackageRoot })).digest("hex");
  return `checkpoint_storyboard_retained_trace_output_${digest.slice(0, 32)}`;
}

function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || strictDescendant(left, right) || strictDescendant(right, left); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
