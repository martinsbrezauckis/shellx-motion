import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { OutputPathTopologyError } from "./output-path-topology-error";

export type TrustedWorkspaceAnchorIdentity = { dev: number; ino: number };

declare const trustedWorkspaceAnchorBrand: unique symbol;

/** Opaque host authority; package data and request arguments cannot manufacture it. */
export interface TrustedWorkspaceAnchor {
  readonly [trustedWorkspaceAnchorBrand]: never;
}

/** Internal route retained by OutputPathTopology while a host scope is active. */
export interface TrustedWorkspaceAnchorRoute {
  readonly path: string;
  readonly identity: TrustedWorkspaceAnchorIdentity;
  assertCurrent(): Promise<void>;
}

class TrustedWorkspaceAnchorHandle implements TrustedWorkspaceAnchor, TrustedWorkspaceAnchorRoute {
  declare readonly [trustedWorkspaceAnchorBrand]: never;

  private constructor(
    readonly path: string,
    readonly identity: TrustedWorkspaceAnchorIdentity
  ) {}

  static async create(path: string): Promise<TrustedWorkspaceAnchorHandle> {
    const anchorPath = resolve(path);
    const anchor = new TrustedWorkspaceAnchorHandle(anchorPath, await captureAnchorIdentity(anchorPath));
    trustedWorkspaceAnchors.add(anchor);
    return anchor;
  }

  async assertCurrent(): Promise<void> {
    const actual = await captureAnchorIdentity(this.path);
    if (actual.dev !== this.identity.dev || actual.ino !== this.identity.ino) {
      throw new OutputPathTopologyError("Trusted workspace anchor changed after host admission; Motion left the target untouched.", this.path);
    }
  }

  containsStrictDescendant(path: string): boolean {
    const suffix = relative(this.path, path);
    return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  }

  toJSON(): never {
    throw new TypeError("Trusted workspace anchors are host-only and cannot be serialized.");
  }
}

const trustedWorkspaceAnchors = new WeakSet<object>();
const trustedWorkspaceAnchorScope = new AsyncLocalStorage<TrustedWorkspaceAnchorHandle>();

/** Host-only POSIX factory. Windows always retains the existing full-route ACL behavior. */
export async function createTrustedWorkspaceAnchor(path: string): Promise<TrustedWorkspaceAnchor> {
  return await TrustedWorkspaceAnchorHandle.create(path);
}

/** Scope one host-owned async operation without leaking authority to concurrent work. */
export async function withTrustedWorkspaceAnchor<T>(
  anchor: TrustedWorkspaceAnchor,
  operation: () => Promise<T> | T
): Promise<T> {
  if (!trustedWorkspaceAnchors.has(anchor as object)) {
    throw new TypeError("Trusted workspace anchor was not created by the Motion host factory.");
  }
  return await trustedWorkspaceAnchorScope.run(anchor as TrustedWorkspaceAnchorHandle, operation);
}

/** Prove that a host-supplied opaque authority names this exact selected root, not merely an ancestor. */
export async function assertTrustedWorkspaceAnchorPath(anchor: TrustedWorkspaceAnchor, path: string): Promise<void> {
  if (!trustedWorkspaceAnchors.has(anchor as object)) {
    throw new TypeError("Trusted workspace anchor was not created by the Motion host factory.");
  }
  const handle = anchor as TrustedWorkspaceAnchorHandle;
  await handle.assertCurrent();
  if (handle.path !== resolve(path)) {
    throw new OutputPathTopologyError("Trusted workspace anchor does not match the host-selected root.", resolve(path));
  }
}

export async function activeTrustedWorkspaceAnchorForTarget(path: string): Promise<TrustedWorkspaceAnchorRoute | undefined> {
  const anchor = trustedWorkspaceAnchorScope.getStore();
  if (!anchor) return undefined;
  await anchor.assertCurrent();
  if (!anchor.containsStrictDescendant(path)) {
    throw new OutputPathTopologyError("Output target is outside the host-approved trusted workspace anchor.", path);
  }
  return anchor;
}

async function captureAnchorIdentity(path: string): Promise<TrustedWorkspaceAnchorIdentity> {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new OutputPathTopologyError("Trusted workspace anchors are available only to POSIX hosts.", path);
  }
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    throw new OutputPathTopologyError(`Trusted workspace anchor could not be inspected safely (${error.code ?? "unknown error"}).`, path);
  });
  assertAnchorFacts(before, path);
  if (await realpath(path).catch(() => null) !== path) {
    throw new OutputPathTopologyError("Trusted workspace anchor must be a canonical non-symlink directory.", path);
  }
  const after = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    throw new OutputPathTopologyError(`Trusted workspace anchor changed while it was inspected (${error.code ?? "unknown error"}).`, path);
  });
  assertAnchorFacts(after, path);
  if (Number(after.dev) !== Number(before.dev) || Number(after.ino) !== Number(before.ino)) {
    throw new OutputPathTopologyError("Trusted workspace anchor changed while it was inspected.", path);
  }
  return { dev: Number(after.dev), ino: Number(after.ino) };
}

function assertAnchorFacts(facts: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    throw new OutputPathTopologyError("Trusted workspace anchor must be a canonical non-symlink directory.", path);
  }
  const uid = process.getuid?.();
  if (uid === undefined || facts.uid !== uid) {
    throw new OutputPathTopologyError("Trusted workspace anchor is not owned by the active POSIX principal.", path);
  }
  const mode = Number(facts.mode);
  if ((mode & 0o300) !== 0o300) {
    throw new OutputPathTopologyError("Trusted workspace anchor does not grant the active POSIX principal write and search authority.", path);
  }
  if ((mode & 0o022) !== 0) {
    throw new OutputPathTopologyError("Trusted workspace anchor is group- or world-writable.", path);
  }
}
