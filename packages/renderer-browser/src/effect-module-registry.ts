/** Host-owned immutable registry for the one C1 local Motion effect intrinsic. */
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { gpuEffectModuleInstallationProvenanceFingerprint, readBoundedStableFile } from "@shellx-motion/core";
import { parseEffectModuleManifest, safeEffectModuleId, safeEffectModuleVersion, MAX_EFFECT_MODULE_MANIFEST_BYTES } from "./effect-module-manifest.js";
import {
  EFFECT_MODULE_REGISTRY_SCHEMA,
  EffectModuleRegistryError,
  type EffectModuleManifest,
  type EffectModuleRegistryAuthority,
  type EffectModuleRegistrySnapshot
} from "./effect-module-registry-types.js";
import {
  assertCurrentEffectModuleBlob,
  createEffectModuleInstallationProvenance,
  createEffectModuleUseLease,
  effectModuleBlobName,
  effectModuleDigest,
  effectModuleEntriesBytes,
  effectModuleRegistrySummary,
  finalizeEffectModuleRegistryEntry,
  findEffectModuleRegistryEntry,
  publishEffectModuleRegistry,
  readEffectModuleRegistry,
  sortEffectModuleEntries
} from "./effect-module-registry-state.js";
import {
  MAX_EFFECT_MODULE_ENTRIES,
  MAX_EFFECT_MODULE_GENERATIONS,
  MAX_EFFECT_MODULE_PENDING,
  MAX_EFFECT_MODULE_TOTAL_BYTES
} from "./effect-module-registry-limits.js";
import {
  ensureEffectModuleRegistryDirectories,
  publishPrivateEffectModuleBlob,
  readPrivateEffectModuleFile,
  removePrivateEffectModuleCandidate,
  stagePrivateEffectModuleCandidate,
  withEffectModuleRegistryLock
} from "./effect-module-private-fs.js";
import { mintGpuEffectModuleUseAuthority, type GpuEffectModuleUseAuthority } from "./gpu-effect-module-use-authority.js";

export * from "./effect-module-registry-types.js";
export { parseEffectModuleManifest, safeEffectModuleId, safeEffectModuleVersion } from "./effect-module-manifest.js";
export { MAX_EFFECT_MODULE_ENTRIES, MAX_EFFECT_MODULE_GENERATIONS, MAX_EFFECT_MODULE_PENDING, MAX_EFFECT_MODULE_TOTAL_BYTES } from "./effect-module-registry-limits.js";

export interface EffectModuleRegistryOptions {
  stateRoot: string;
  now?: () => Date;
  /** Pending Workbench confirmation is short lived and never survives a process restart. */
  pendingTtlMs?: number;
  /** Test-only fault point; production never supplies it. */
  faults?: Partial<Record<"afterBlobPublished" | "beforeRegistryPublish" | "afterRegistryPublish" | "afterBlobTargetAbsenceCheck" | "afterGenerationTargetAbsenceCheck", () => Promise<void> | void>>;
  /** Test seam only; production always uses the no-follow stable file reader below. */
  readManifestFileForTest?: (path: string) => Promise<{ bytes: Buffer; sha256: string }>;
}

type PendingInstall = {
  readonly path: string;
  readonly manifest: EffectModuleManifest;
  readonly sha256: string;
  readonly bytes: number;
  readonly expiresAtMs: number;
};

export function createEffectModuleRegistryAuthority(options: EffectModuleRegistryOptions): EffectModuleRegistryAuthority {
  if (!isAbsolute(options.stateRoot)) throw new EffectModuleRegistryError("Effect-module registry root must be an absolute host path.", "private_state_invalid");
  const stateRoot = resolve(options.stateRoot);
  const now = options.now ?? (() => new Date());
  const pendingTtlMs = options.pendingTtlMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(pendingTtlMs) || pendingTtlMs < 1 || pendingTtlMs > 60 * 60 * 1000) {
    throw new EffectModuleRegistryError("Effect-module pending confirmation lifetime must be bounded.", "private_state_invalid");
  }
  const faults = options.faults ?? {};
  const readManifest = options.readManifestFileForTest ?? readSelectedManifest;
  /** Deliberately process-local: a crash leaves staging bytes orphaned and never confirmable. */
  const pending = new Map<string, PendingInstall>();
  let closed = false;
  let startupRecovery: Promise<void> | null = null;
  const retainedPendingPaths = (extra: readonly string[] = []): string[] => [...pending.values()].map((candidate) => candidate.path).concat(extra);
  const locked = async <T>(operation: (root: string) => Promise<T>, extra: readonly string[] = []): Promise<T> =>
    await withEffectModuleRegistryLock(stateRoot, operation, retainedPendingPaths(extra), false);
  const recoverStaging = async (): Promise<void> => {
    // A second live authority may share this root; only expired staging can be cleaned safely.
    startupRecovery ??= withEffectModuleRegistryLock(stateRoot, async () => undefined, [], true, pendingTtlMs);
    await startupRecovery;
  };
  const ensureOpen = (): void => {
    if (closed) throw new EffectModuleRegistryError("Effect-module registry authority is closed.", "closed");
  };
  return {
    prepareInstallFromManifestFile: async (sourcePath) => {
      ensureOpen();
      await recoverStaging();
      await discardExpiredPending(pending, now().getTime());
      if (pending.size >= MAX_EFFECT_MODULE_PENDING) {
        throw new EffectModuleRegistryError("Too many effect-module confirmations are pending; finish or cancel one first.", "pending_full");
      }
      await assertSelectedManifestLeaf(sourcePath);
      const source = await readManifest(sourcePath);
      const manifest = parseEffectModuleManifest(source.bytes);
      return await locked(async (root) => {
        const paths = await ensureEffectModuleRegistryDirectories(root);
        const confirmationId = randomUUID();
        const path = await stagePrivateEffectModuleCandidate(root, paths.stagingRoot, source.bytes);
        pending.set(confirmationId, { path, manifest, sha256: source.sha256, bytes: source.bytes.byteLength, expiresAtMs: now().getTime() + pendingTtlMs });
        return {
          confirmationId,
          moduleId: manifest.moduleId,
          version: manifest.version,
          displayName: manifest.displayName,
          manifestSha256: source.sha256,
          manifestByteLength: source.bytes.byteLength,
          intrinsic: manifest.intrinsic,
          rendererAbi: manifest.rendererAbi,
          parameterSchema: manifest.parameterSchema
        };
      });
    },
    confirmInstall: async (confirmationId) => {
      ensureOpen();
      await recoverStaging();
      if (!safeConfirmationId(confirmationId)) throw new EffectModuleRegistryError("Effect-module confirmation id is invalid.", "pending_not_found");
      const candidate = pending.get(confirmationId);
      /* Delete before touching state: a replay cannot race a successful or failed confirm. */
      pending.delete(confirmationId);
      if (!candidate) throw new EffectModuleRegistryError("Effect-module confirmation is missing, expired, or already used.", "pending_not_found");
      if (candidate.expiresAtMs <= now().getTime()) {
        await removePrivateEffectModuleCandidate(candidate.path);
        throw new EffectModuleRegistryError("Effect-module confirmation is missing, expired, or already used.", "pending_not_found");
      }
      try {
        return await locked(async (root) => {
          const frozen = await readPrivateEffectModuleFile(candidate.path, MAX_EFFECT_MODULE_MANIFEST_BYTES, root);
          if (frozen.byteLength !== candidate.bytes || effectModuleDigest(frozen) !== candidate.sha256) {
            throw new EffectModuleRegistryError("Effect-module pending bytes changed before confirmation.", "private_state_changed");
          }
          const manifest = parseEffectModuleManifest(frozen);
          if (!sameManifest(manifest, candidate.manifest)) {
            throw new EffectModuleRegistryError("Effect-module pending manifest changed before confirmation.", "private_state_changed");
          }
          const store = await readEffectModuleRegistry(root);
          const existing = findEffectModuleRegistryEntry(store, manifest.moduleId, manifest.version);
          if (existing) {
            if (existing.manifestSha256 !== candidate.sha256 || existing.manifestByteLength !== frozen.byteLength) {
              throw new EffectModuleRegistryError("Effect-module id/version is immutable; install a new version for different bytes.", "immutable_conflict");
            }
            await assertCurrentEffectModuleBlob(root, existing);
            return { entry: effectModuleRegistrySummary(existing), generation: store.generation, idempotent: true };
          }
          if (store.entries.length >= MAX_EFFECT_MODULE_ENTRIES || effectModuleEntriesBytes(store.entries) + frozen.byteLength > MAX_EFFECT_MODULE_TOTAL_BYTES) {
            throw new EffectModuleRegistryError("Effect-module registry capacity is exhausted; installed versions remain counted after revocation.", "capacity_exceeded");
          }
          const paths = await ensureEffectModuleRegistryDirectories(root);
          await publishPrivateEffectModuleBlob(root, paths.blobsRoot, paths.stagingRoot, effectModuleBlobName(candidate.sha256), frozen, candidate.sha256, faults.afterBlobTargetAbsenceCheck);
          await faults.afterBlobPublished?.();
          const installedAt = now().toISOString();
          const installationProvenance = createEffectModuleInstallationProvenance(manifest.moduleId, manifest.version, candidate.sha256, frozen.byteLength, installedAt);
          const entry = finalizeEffectModuleRegistryEntry({
            moduleId: manifest.moduleId, version: manifest.version, manifestSha256: candidate.sha256,
            manifestByteLength: frozen.byteLength, displayName: manifest.displayName, intrinsic: manifest.intrinsic, rendererAbi: manifest.rendererAbi, parameterSchema: manifest.parameterSchema, installedAt,
            installationProvenance,
            installationProvenanceSha256: gpuEffectModuleInstallationProvenanceFingerprint(installationProvenance)
          });
          const next = { schema: EFFECT_MODULE_REGISTRY_SCHEMA, generation: store.generation + 1, entries: sortEffectModuleEntries([...store.entries, entry]) } satisfies EffectModuleRegistrySnapshot;
          if (next.generation > MAX_EFFECT_MODULE_GENERATIONS) {
            throw new EffectModuleRegistryError("Effect-module registry generation capacity is exhausted; operator recovery is required.", "capacity_exceeded");
          }
          await faults.beforeRegistryPublish?.();
          await publishEffectModuleRegistry(root, paths.generationsRoot, paths.stagingRoot, next, faults.afterGenerationTargetAbsenceCheck);
          await faults.afterRegistryPublish?.();
          return { entry: effectModuleRegistrySummary(entry), generation: next.generation, idempotent: false };
        }, [candidate.path]);
      } finally {
        await removePrivateEffectModuleCandidate(candidate.path);
      }
    },
    cancelInstall: async (confirmationId) => {
      await recoverStaging();
      if (!safeConfirmationId(confirmationId)) return { cancelled: false };
      const candidate = pending.get(confirmationId);
      pending.delete(confirmationId);
      if (!candidate) return { cancelled: false };
      await removePrivateEffectModuleCandidate(candidate.path);
      return { cancelled: true };
    },
    close: async () => {
      if (closed) return { closed: false, cancelledPending: 0 };
      closed = true;
      const abandoned = [...pending.values()];
      pending.clear();
      await recoverStaging();
      await withEffectModuleRegistryLock(stateRoot, async () => {
        await Promise.all(abandoned.map(async (candidate) => await removePrivateEffectModuleCandidate(candidate.path)));
      }, abandoned.map((candidate) => candidate.path), false);
      return { closed: true, cancelledPending: abandoned.length };
    },
    list: async () => { ensureOpen(); await recoverStaging(); return await locked(async (root) => (await readEffectModuleRegistry(root)).entries.map(effectModuleRegistrySummary)); },
    inspect: async (moduleId, version) => {
      ensureOpen(); await recoverStaging();
      return await locked(async (root) => {
        assertIdentity(moduleId, version); const entry = findEffectModuleRegistryEntry(await readEffectModuleRegistry(root), moduleId, version); return entry ? effectModuleRegistrySummary(entry) : null;
      });
    },
    revoke: async (moduleId, version) => {
      ensureOpen(); await recoverStaging();
      return await locked(async (root) => {
      assertIdentity(moduleId, version); const store = await readEffectModuleRegistry(root); const existing = findEffectModuleRegistryEntry(store, moduleId, version);
      if (!existing) throw new EffectModuleRegistryError("Effect-module id/version is not installed.", "not_installed");
      if (existing.revokedAt) return { entry: effectModuleRegistrySummary(existing), generation: store.generation, changed: false };
      const { registryEntrySha256: _previousHash, ...existingWithoutHash } = existing;
      const entry = finalizeEffectModuleRegistryEntry({ ...existingWithoutHash, revokedAt: now().toISOString() });
      const next = { schema: EFFECT_MODULE_REGISTRY_SCHEMA, generation: store.generation + 1, entries: sortEffectModuleEntries(store.entries.map((candidate) => candidate === existing ? entry : candidate)) } satisfies EffectModuleRegistrySnapshot;
      const paths = await ensureEffectModuleRegistryDirectories(root);
      if (next.generation > MAX_EFFECT_MODULE_GENERATIONS) throw new EffectModuleRegistryError("Effect-module registry generation capacity is exhausted; operator recovery is required.", "capacity_exceeded");
      await faults.beforeRegistryPublish?.();
      await publishEffectModuleRegistry(root, paths.generationsRoot, paths.stagingRoot, next, faults.afterGenerationTargetAbsenceCheck);
      await faults.afterRegistryPublish?.();
      return { entry: effectModuleRegistrySummary(entry), generation: next.generation, changed: true };
      });
    },
    beginUse: async (moduleId, version) => {
      ensureOpen(); await recoverStaging();
      return await locked(async (root) => {
      assertIdentity(moduleId, version); const store = await readEffectModuleRegistry(root); const entry = findEffectModuleRegistryEntry(store, moduleId, version);
      if (!entry) throw new EffectModuleRegistryError("Effect-module id/version is not installed.", "not_installed");
      if (entry.revokedAt) throw new EffectModuleRegistryError("Effect-module id/version is revoked and cannot begin a new use.", "revoked");
      await assertCurrentEffectModuleBlob(root, entry);
      return createEffectModuleUseLease(entry, store.generation);
      });
    }
  };
}

/**
 * Internal host bridge only. The public renderer entry exports the resulting
 * read/use token type, never the private registry manager or this minting API.
 */
export function createEffectModuleRegistryUseAuthority(authority: EffectModuleRegistryAuthority): GpuEffectModuleUseAuthority {
  return mintGpuEffectModuleUseAuthority(authority);
}

async function readSelectedManifest(path: string): Promise<{ bytes: Buffer; sha256: string }> {
  await assertSelectedManifestLeaf(path);
  const root = dirname(resolve(path));
  const file = await readBoundedStableFile(path, { label: "Effect-module manifest", maxBytes: MAX_EFFECT_MODULE_MANIFEST_BYTES, withinRoot: root });
  return { bytes: file.bytes, sha256: file.sha256 };
}

/** Preserve the no-follow leaf gate even for the host-only test reader seam. */
async function assertSelectedManifestLeaf(path: string): Promise<void> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new EffectModuleRegistryError("Effect-module installation requires a host-selected absolute manifest path.", "invalid_manifest");
  const facts = await lstat(path).catch(() => null);
  if (!facts || !facts.isFile() || facts.isSymbolicLink() || facts.size < 1 || facts.size > MAX_EFFECT_MODULE_MANIFEST_BYTES) {
    throw new EffectModuleRegistryError("Effect-module installation requires a bounded regular manifest file, not a link.", "invalid_manifest");
  }
}

function assertIdentity(moduleId: string, version: string): void { if (!safeEffectModuleId(moduleId) || !safeEffectModuleVersion(version)) throw new EffectModuleRegistryError("Effect-module id/version is invalid.", "invalid_manifest"); }
function safeDisplayName(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 96 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }
function safeManifestByteLength(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_EFFECT_MODULE_MANIFEST_BYTES; }
function safeConfirmationId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function sameManifest(left: EffectModuleManifest, right: EffectModuleManifest): boolean {
  return left.moduleId === right.moduleId && left.version === right.version && left.displayName === right.displayName
    && left.intrinsic === right.intrinsic && left.rendererAbi === right.rendererAbi && left.parameterSchema === right.parameterSchema;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function discardExpiredPending(pending: Map<string, PendingInstall>, nowMs: number): Promise<void> {
  const expired = [...pending.entries()].filter(([, candidate]) => candidate.expiresAtMs <= nowMs);
  for (const [confirmationId, candidate] of expired) {
    pending.delete(confirmationId);
    await removePrivateEffectModuleCandidate(candidate.path);
  }
}
