/** Private retained-directory and callback-scope state for the one-slot strict-SDR pair. */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DerivedFilePublicationEvidence, DerivedOutputPublication } from "./derived-output-publication";
import {
  createHeldOutputDirectoryAuthority,
  heldOutputDirectoryBindingPath,
  heldOutputDirectoryChildPath,
  type HeldOutputDirectoryAuthority,
} from "./output-path-held-directory-authority";
import { assertTrustedWorkspaceAnchorPath, type TrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { PairedOutputReceiptPublication, type PairedPublishedPairIdentity } from "./paired-output-receipt-publication";
import { registerStrictSdrCandidateHeldPair, type StrictSdrCandidateHeldPairStageEvidence } from "./strict-sdr-candidate-held-pair-registry";
import type { StrictSdrCandidateHeldPair, StrictSdrCandidateTerminalBinding } from "./strict-sdr-candidate-held-pair";
const PREPARATION_FINGERPRINT = /^[a-f0-9]{64}$/u;
export const STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES = 256 * 1024 * 1024;
export const STRICT_SDR_CANDIDATE_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
const OUTPUT_NAME = "output.mp4";
const RECEIPT_NAME = "output.mp4.receipt.json";
declare const workspaceBrand: unique symbol;
/** Opaque Core-held workspace; a lexical path cannot manufacture this value. */
export interface StrictSdrCandidateHeldWorkspace { readonly [workspaceBrand]: never; }
export type StrictSdrCandidateHeldWorkspaceState = {
  readonly anchor: TrustedWorkspaceAnchor;
  readonly scratchRoot: string;
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: Readonly<{ dev: number; ino: number }>;
  readonly authority: HeldOutputDirectoryAuthority;
  opened: boolean;
  closed: boolean;
};
export type StrictSdrCandidateHeldPairFinalizerKind = "F2a" | "three-slot F2a" | "F2b screen" | "F2b screen controls";
/** Pair lifecycle state remains private to this held-workspace state holder. */
export type StrictSdrCandidateHeldPairState = {
  readonly workspace: StrictSdrCandidateHeldWorkspace;
  readonly publication: PairedOutputReceiptPublication;
  readonly outputPublication: DerivedOutputPublication;
  readonly binding: StrictSdrCandidateTerminalBinding;
  stage: StrictSdrCandidateHeldPairStageEvidence | undefined; adoptedStage: DerivedFilePublicationEvidence | undefined;
  identity: PairedPublishedPairIdentity | undefined;
  committed: boolean;
  consuming: boolean;
  rendererClaimed: boolean;
  finalizerKind: StrictSdrCandidateHeldPairFinalizerKind | undefined;
  finalizer: (() => Promise<void>) | undefined;
  finalizerRan: boolean;
  closed: boolean;
};
type ScopeToken = { active: boolean };
type WorkspaceScope = Readonly<{
  workspace: StrictSdrCandidateHeldWorkspace;
  expectedPreparation: string;
  token: ScopeToken;
}>;
type RendererScope = Readonly<{ pair: StrictSdrCandidateHeldPair; expectedPreparation: string; token: ScopeToken }>;

const workspaces = new WeakMap<object, StrictSdrCandidateHeldWorkspaceState>();
const pairs = new WeakMap<object, StrictSdrCandidateHeldPairState>();
const workspaceScope = new AsyncLocalStorage<WorkspaceScope>();
const rendererScope = new AsyncLocalStorage<RendererScope>();

/** Create one fresh mode-0700 child beneath the exact host-approved scratch anchor. */
export async function createStrictSdrCandidateHeldWorkspace(
  anchor: TrustedWorkspaceAnchor,
  scratchRoot: string,
): Promise<StrictSdrCandidateHeldWorkspace> {
  requireLinux();
  const root = resolve(scratchRoot);
  await assertTrustedWorkspaceAnchorPath(anchor, root);
  const path = await mkdtemp(join(root, "strict-sdr-one-slot-"));
  let handle: FileHandle | undefined;
  try {
    await chmod(path, 0o700);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = identityOf(await handle.stat());
    await assertWorkspaceDirectory(path, identity);
    const state: StrictSdrCandidateHeldWorkspaceState = {
      anchor,
      scratchRoot: root,
      path,
      handle,
      identity,
      opened: false,
      closed: false,
      authority: createHeldOutputDirectoryAuthority({
        rootPath: `/proc/self/fd/${handle.fd}`,
        bindingRootPath: path,
        assertCurrent: async () => await assertStrictSdrCandidateHeldWorkspaceCurrent(state),
        readFacts: async () => await handle!.stat(),
        syncParent: async () => {
          await assertStrictSdrCandidateHeldWorkspaceCurrent(state);
          await handle!.sync();
          await assertStrictSdrCandidateHeldWorkspaceCurrent(state);
        },
      }),
    };
    const workspace = Object.freeze({}) as StrictSdrCandidateHeldWorkspace;
    workspaces.set(workspace as object, state);
    return workspace;
  } catch (error) {
    return await throwWithCleanup(error, async () => { if (handle) await handle.close(); });
  }
}

/** Scope a host-created workspace and child-admitted preparation to one callback. */
export async function withStrictSdrCandidateHeldWorkspace<T>(
  workspace: StrictSdrCandidateHeldWorkspace,
  expectedPreparation: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const state = strictSdrCandidateHeldWorkspaceState(workspace);
  assertStrictSdrCandidatePreparationFingerprint(expectedPreparation);
  await assertStrictSdrCandidateHeldWorkspaceCurrent(state);
  const token: ScopeToken = { active: true };
  try {
    return await workspaceScope.run(Object.freeze({ workspace, expectedPreparation, token }), operation);
  } finally {
    token.active = false;
  }
}

/** The ordinary terminal sees no scope and therefore keeps its existing paired-publication route. */
export function currentStrictSdrCandidateHeldWorkspace(): StrictSdrCandidateHeldWorkspace | undefined {
  return activeStrictSdrCandidateHeldWorkspaceScope()?.workspace;
}

/** Close an unused workspace after pair acquisition failed; retained pair workspaces must close through the pair. */
export async function closeStrictSdrCandidateHeldWorkspace(workspace: StrictSdrCandidateHeldWorkspace): Promise<void> {
  const state = strictSdrCandidateHeldWorkspaceState(workspace);
  if (state.opened && !state.closed) {
    throw new Error("Strict-SDR candidate held workspace has an opened pair and cannot be closed directly.");
  }
  await closeStrictSdrCandidateHeldWorkspaceState(state);
}

/** Open the one fixed-name publication pair from the active retained workspace scope. */
export async function openStrictSdrCandidateHeldPair(
  workspace: StrictSdrCandidateHeldWorkspace,
): Promise<StrictSdrCandidateHeldPair> {
  const state = strictSdrCandidateHeldWorkspaceState(workspace);
  const active = activeStrictSdrCandidateHeldWorkspaceScope();
  if (!active || active.workspace !== workspace) {
    throw new Error("Strict-SDR candidate held pair must be opened inside its Core workspace scope.");
  }
  if (state.opened || state.closed) throw new Error("Strict-SDR candidate held workspace cannot open another pair.");
  await assertStrictSdrCandidateHeldWorkspaceCurrent(state);
  state.opened = true;
  let publication: PairedOutputReceiptPublication | undefined;
  try {
    publication = await PairedOutputReceiptPublication.acquire({
      outputPath: heldOutputDirectoryChildPath(state.authority, OUTPUT_NAME),
      receiptPath: heldOutputDirectoryChildPath(state.authority, RECEIPT_NAME),
      outputArtifact: { role: "rendered_media", mediaType: "video/mp4", primary: true },
      receiptArtifact: { role: "render_receipt", mediaType: "application/json" },
      internalHeldDirectoryAuthority: state.authority,
      durablePublication: {
        outputMaxBytes: STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES,
        receiptMaxBytes: STRICT_SDR_CANDIDATE_RECEIPT_MAX_BYTES,
      },
      retainCommittedEvidenceOnFailure: true,
    });
    const pair = Object.freeze({}) as StrictSdrCandidateHeldPair;
    const pairState: StrictSdrCandidateHeldPairState = {
      workspace,
      publication,
      outputPublication: publication.outputPublication,
      binding: Object.freeze({
        outputPath: heldOutputDirectoryBindingPath(state.authority, OUTPUT_NAME),
        receiptPath: heldOutputDirectoryBindingPath(state.authority, RECEIPT_NAME),
      }),
      stage: undefined, adoptedStage: undefined,
      identity: undefined,
      committed: false,
      consuming: false,
      rendererClaimed: false,
      finalizerKind: undefined,
      finalizer: undefined,
      finalizerRan: false,
      closed: false,
    };
    pairs.set(pair as object, pairState);
    registerStrictSdrCandidateHeldPair(publication, {
      heldDirectoryAuthority: state.authority,
      outputPublication: publication.outputPublication,
      recordStage: (evidence) => recordCandidateStage(pairState, evidence),
    });
    return pair;
  } catch (error) {
    state.opened = false;
    return await throwWithCleanup(error, async () => { if (publication) await publication.abort(); });
  }
}

export function strictSdrCandidateHeldPairState(
  pair: StrictSdrCandidateHeldPair,
): StrictSdrCandidateHeldPairState {
  const state = pairs.get(pair as object);
  if (!state) throw new TypeError("Strict-SDR candidate pair was not created by Core.");
  return state;
}

export function strictSdrCandidateHeldWorkspaceState(
  workspace: StrictSdrCandidateHeldWorkspace,
): StrictSdrCandidateHeldWorkspaceState {
  const state = workspaces.get(workspace as object);
  if (!state) throw new TypeError("Strict-SDR candidate workspace was not created by Core.");
  return state;
}

export function assertStrictSdrCandidateHeldPairOpen(state: StrictSdrCandidateHeldPairState): void {
  if (state.closed || state.committed || state.consuming) throw new Error("Strict-SDR candidate held pair is no longer open for terminal publication.");
}

export function activeStrictSdrCandidateHeldWorkspaceScope(): Readonly<{
  workspace: StrictSdrCandidateHeldWorkspace;
  expectedPreparation: string;
}> | undefined {
  const scope = workspaceScope.getStore();
  return scope?.token.active ? scope : undefined;
}

export async function assertStrictSdrCandidateHeldWorkspaceCurrent(
  state: StrictSdrCandidateHeldWorkspaceState,
): Promise<void> {
  if (state.closed) throw new Error("Strict-SDR candidate held workspace descriptor is already closed.");
  await assertTrustedWorkspaceAnchorPath(state.anchor, state.scratchRoot);
  const opened = identityOf(await state.handle.stat());
  if (!sameIdentity(opened, state.identity)) {
    throw new Error("Strict-SDR candidate held workspace descriptor changed during its lifetime.");
  }
  await assertWorkspaceDirectory(state.path, state.identity);
}

export async function closeStrictSdrCandidateHeldWorkspaceState(
  state: StrictSdrCandidateHeldWorkspaceState,
): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  await state.handle.close();
}

/** Final named lease cleanup is optional and precedes the workspace handle close. */
export async function closeStrictSdrCandidateHeldPairAfterTerminal(state: StrictSdrCandidateHeldPairState, primary: unknown, hasPrimary: boolean): Promise<void> {
  const errors: unknown[] = hasPrimary ? [primary] : [];
  const label = state.finalizerKind ?? "named";
  if (state.finalizer) {
    if (state.finalizerRan) errors.push(new Error(`Strict-SDR candidate ${label} finalizer was invoked more than once.`));
    else {
      state.finalizerRan = true;
      try { await state.finalizer(); } catch (error) { errors.push(error); }
    }
  } else if (state.finalizerKind) {
    errors.push(new Error(`Strict-SDR candidate ${label} binding resolved without its required finalizer.`));
  }
  try { await closeStrictSdrCandidateHeldWorkspaceState(strictSdrCandidateHeldWorkspaceState(state.workspace)); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Strict-SDR candidate pair failed and its named finalizer/workspace cleanup was uncertain.");
}

export async function withStrictSdrCandidateHeldPairRendererScope<T>(pair: StrictSdrCandidateHeldPair, expectedPreparation: string, operation: () => Promise<T> | T): Promise<T> {
  const state = strictSdrCandidateHeldPairState(pair);
  const token: ScopeToken = { active: true };
  let primary: unknown;
  let hasPrimary = false;
  try {
    return await rendererScope.run(Object.freeze({ pair, expectedPreparation, token }), operation);
  } catch (error) {
    primary = error;
    hasPrimary = true;
    throw error;
  } finally {
    token.active = false;
    if (state.finalizerKind && !state.finalizer) {
      const missing = new Error(`Strict-SDR candidate ${state.finalizerKind} binding did not register its required finalizer before renderer scope expiry.`);
      if (hasPrimary) throw new AggregateError([primary, missing], "Strict-SDR candidate renderer transfer failed before F2a finalizer registration.");
      throw missing;
    }
  }
}

export function activeStrictSdrCandidateHeldPairRendererScope(): Readonly<{
  pair: StrictSdrCandidateHeldPair;
  expectedPreparation: string;
  token: Readonly<{ active: boolean }>;
}> | undefined {
  return rendererScope.getStore();
}

export function assertStrictSdrCandidatePreparationFingerprint(value: string): void {
  if (!PREPARATION_FINGERPRINT.test(value)) {
    throw new Error("Strict-SDR candidate preparation fingerprint must be an exact SHA-256 value.");
  }
}

function recordCandidateStage(state: StrictSdrCandidateHeldPairState, evidence: StrictSdrCandidateHeldPairStageEvidence): void {
  if (state.stage || state.closed || state.committed) {
    throw new Error("Strict-SDR candidate final receipt stage was duplicated or observed after pair closure.");
  }
  assertEvidence(evidence.output, STRICT_SDR_CANDIDATE_MEDIA_MAX_BYTES, "media");
  assertEvidence(evidence.receipt, STRICT_SDR_CANDIDATE_RECEIPT_MAX_BYTES, "receipt");
  state.stage = Object.freeze({ output: evidence.output, receipt: evidence.receipt });
}

function assertEvidence(evidence: DerivedFilePublicationEvidence, maximumBytes: number, label: string): void {
  if (!PREPARATION_FINGERPRINT.test(evidence.sha256) || !Number.isSafeInteger(evidence.byteLength) || evidence.byteLength < 2 || evidence.byteLength > maximumBytes) {
    throw new Error(`Strict-SDR candidate ${label} stage evidence is outside its bounded Core contract.`);
  }
}

async function assertWorkspaceDirectory(path: string, expected: Readonly<{ dev: number; ino: number }>): Promise<void> {
  const facts = await lstat(path);
  const uid = process.getuid?.();
  if (
    !facts.isDirectory()
    || facts.isSymbolicLink()
    || !sameIdentity(identityOf(facts), expected)
    || uid === undefined
    || facts.uid !== uid
    || (Number(facts.mode) & 0o077) !== 0
    || (Number(facts.mode) & 0o700) !== 0o700
  ) {
    throw new Error("Strict-SDR candidate workspace is not the retained private mode-0700 directory.");
  }
}

function identityOf(facts: Stats): Readonly<{ dev: number; ino: number }> {
  return Object.freeze({ dev: Number(facts.dev), ino: Number(facts.ino) });
}

function sameIdentity(left: Readonly<{ dev: number; ino: number }>, right: Readonly<{ dev: number; ino: number }>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireLinux(): void {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    throw new Error("Strict-SDR candidate held pairs require the Linux retained-descriptor route.");
  }
}

async function throwWithCleanup(primary: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError([primary, cleanupError], "Strict-SDR candidate acquisition failed and its Core cleanup also failed.");
  }
  throw primary;
}
