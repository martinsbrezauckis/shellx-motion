/** Immutable generation parsing, publication, and entry identity verification for C1. */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  gpuEffectModuleInstallationProvenanceFingerprint,
  gpuEffectModuleInstallationProvenanceProblem,
  gpuEffectModuleRegistryEntryFingerprint
} from "@shellx-motion/core";
import { parseEffectModuleManifest, safeEffectModuleId, safeEffectModuleVersion, MAX_EFFECT_MODULE_MANIFEST_BYTES } from "./effect-module-manifest.js";
import {
  EFFECT_MODULE_INTRINSIC,
  EFFECT_MODULE_PARAMETER_SCHEMA,
  EFFECT_MODULE_REGISTRY_SCHEMA,
  EFFECT_MODULE_RENDERER_ABI,
  EffectModuleRegistryError,
  type EffectModuleManifest,
  type EffectModuleRegistryEntry,
  type EffectModuleRegistrySnapshot,
  type EffectModuleRegistrySummary,
  type EffectModuleUseLease
} from "./effect-module-registry-types.js";
import { MAX_EFFECT_MODULE_ENTRIES, MAX_EFFECT_MODULE_GENERATIONS, MAX_EFFECT_MODULE_TOTAL_BYTES } from "./effect-module-registry-limits.js";
import {
  assertEffectModuleRegistryRoot,
  isEffectModuleGenerationFileName,
  publishPrivateEffectModuleRegistry,
  readPrivateEffectModuleFile
} from "./effect-module-private-fs.js";

export async function readEffectModuleRegistry(root: string): Promise<EffectModuleRegistrySnapshot> {
  await assertEffectModuleRegistryRoot(root);
  const generationsRoot = join(root, "generations");
  const files = await readdir(generationsRoot, { withFileTypes: true });
  if (files.length > MAX_EFFECT_MODULE_GENERATIONS) {
    throw new EffectModuleRegistryError("Effect-module registry has too many immutable generations.", "private_state_invalid");
  }
  const recovered: EffectModuleRegistrySnapshot[] = [];
  for (const file of files) {
    if (!file.isFile() || file.isSymbolicLink() || !isEffectModuleGenerationFileName(file.name)) {
      throw new EffectModuleRegistryError("Effect-module registry generation store contains an unsafe entry.", "private_state_invalid");
    }
    const namedGeneration = Number(file.name.slice("generation-".length, -".json".length));
    recovered.push(await readEffectModuleRegistryGeneration(join(generationsRoot, file.name), root, namedGeneration));
  }
  if (recovered.length === 0) return { schema: EFFECT_MODULE_REGISTRY_SCHEMA, generation: 0, entries: [] };
  recovered.sort((left, right) => left.generation - right.generation);
  const selected = recovered.at(-1)!;
  // A generation is usable only when every referenced immutable manifest/blob still proves its
  // identity. Never accept an unrelated-looking registry snapshot with a missing or swapped blob.
  await Promise.all(selected.entries.map(async (entry) => await assertCurrentEffectModuleBlob(root, entry)));
  return selected;
}

/** A visible immutable generation must be complete and verifiable; malformed state fails closed. */
async function readEffectModuleRegistryGeneration(path: string, root: string, expectedGeneration: number): Promise<EffectModuleRegistrySnapshot> {
  let bytes: Buffer;
  try { bytes = await readPrivateEffectModuleFile(path, MAX_EFFECT_MODULE_TOTAL_BYTES, root); }
  catch { throw new EffectModuleRegistryError("Effect-module registry generation is unreadable.", "private_state_invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new EffectModuleRegistryError("Effect-module registry generation is not valid JSON.", "private_state_invalid"); }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["schema", "generation", "entries"])
    || parsed.schema !== EFFECT_MODULE_REGISTRY_SCHEMA || typeof parsed.generation !== "number" || !Number.isSafeInteger(parsed.generation)
    || parsed.generation !== expectedGeneration || parsed.generation < 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_EFFECT_MODULE_ENTRIES) {
    throw new EffectModuleRegistryError("Effect-module registry generation has an unsupported schema.", "private_state_invalid");
  }
  const generation = parsed.generation as number;
  try {
    const entries = parsed.entries.map(parseEntry);
    if (new Set(entries.map(effectModuleEntryKey)).size !== entries.length || effectModuleEntriesBytes(entries) > MAX_EFFECT_MODULE_TOTAL_BYTES) {
      throw new EffectModuleRegistryError("Effect-module registry generation has duplicate or oversized entries.", "private_state_invalid");
    }
    return { schema: EFFECT_MODULE_REGISTRY_SCHEMA, generation, entries: sortEffectModuleEntries(entries) };
  } catch (error) {
    if (error instanceof EffectModuleRegistryError) throw error;
    throw new EffectModuleRegistryError("Effect-module registry generation contains invalid entries.", "private_state_invalid");
  }
}

export async function publishEffectModuleRegistry(
  root: string,
  generationsRoot: string,
  stagingRoot: string,
  snapshot: EffectModuleRegistrySnapshot,
  afterTargetAbsenceCheckForTest?: () => Promise<void> | void
): Promise<void> {
  const text = Buffer.from(`${JSON.stringify({ ...snapshot, entries: sortEffectModuleEntries(snapshot.entries) })}\n`, "utf8");
  if (text.byteLength > MAX_EFFECT_MODULE_TOTAL_BYTES) throw new EffectModuleRegistryError("Effect-module registry exceeds its bounded state size.", "capacity_exceeded");
  await publishPrivateEffectModuleRegistry(root, generationsRoot, stagingRoot, snapshot.generation, text, afterTargetAbsenceCheckForTest);
}

export async function assertCurrentEffectModuleBlob(root: string, entry: EffectModuleRegistryEntry): Promise<void> {
  let bytes: Buffer;
  try { bytes = await readPrivateEffectModuleFile(join(root, "blobs", effectModuleBlobName(entry.manifestSha256)), entry.manifestByteLength, root); }
  catch { throw new EffectModuleRegistryError("Effect-module registry blob is missing or changed.", "private_state_changed"); }
  if (bytes.byteLength !== entry.manifestByteLength || effectModuleDigest(bytes) !== entry.manifestSha256) throw new EffectModuleRegistryError("Effect-module registry blob is missing or changed.", "private_state_changed");
  let manifest: EffectModuleManifest;
  try { manifest = parseEffectModuleManifest(bytes); }
  catch { throw new EffectModuleRegistryError("Effect-module registry blob no longer contains a valid immutable manifest.", "private_state_changed"); }
  if (manifest.moduleId !== entry.moduleId || manifest.version !== entry.version || manifest.displayName !== entry.displayName
    || manifest.intrinsic !== entry.intrinsic || manifest.rendererAbi !== entry.rendererAbi
    || manifest.parameterSchema !== entry.parameterSchema || entry.installationProvenanceSha256 !== gpuEffectModuleInstallationProvenanceFingerprint(entry.installationProvenance)
    || entry.registryEntrySha256 !== effectModuleRegistryEntryHash(entry)) {
    throw new EffectModuleRegistryError("Effect-module registry blob does not match its immutable entry.", "private_state_changed");
  }
}

function parseEntry(value: unknown): EffectModuleRegistryEntry {
  if (!isRecord(value)) throw new EffectModuleRegistryError("Effect-module registry contains an invalid entry.", "private_state_invalid");
  const manifestByteLength = value.manifestByteLength;
  if (!hasExactKeys(value, value.revokedAt === undefined
    ? ["moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "installationProvenance", "displayName", "intrinsic", "rendererAbi", "parameterSchema", "installedAt"]
    : ["moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "installationProvenance", "displayName", "intrinsic", "rendererAbi", "parameterSchema", "installedAt", "revokedAt"])
    || !safeEffectModuleId(value.moduleId) || !safeEffectModuleVersion(value.version) || !safeDisplayName(value.displayName)
    || !isSha256(value.manifestSha256) || !isSha256(value.registryEntrySha256) || !isSha256(value.installationProvenanceSha256) || !safeManifestByteLength(manifestByteLength)
    || value.intrinsic !== EFFECT_MODULE_INTRINSIC || value.rendererAbi !== EFFECT_MODULE_RENDERER_ABI
    || value.parameterSchema !== EFFECT_MODULE_PARAMETER_SCHEMA || !canonicalTimestamp(value.installedAt)
    || gpuEffectModuleInstallationProvenanceProblem(value.installationProvenance)
    || (value.revokedAt !== undefined && !canonicalTimestamp(value.revokedAt))) throw new EffectModuleRegistryError("Effect-module registry contains an invalid entry.", "private_state_invalid");
  const entry = { moduleId: value.moduleId, version: value.version, manifestSha256: value.manifestSha256, manifestByteLength,
    displayName: value.displayName, intrinsic: EFFECT_MODULE_INTRINSIC, rendererAbi: EFFECT_MODULE_RENDERER_ABI,
    parameterSchema: EFFECT_MODULE_PARAMETER_SCHEMA, installationProvenanceSha256: value.installationProvenanceSha256,
    installationProvenance: value.installationProvenance as EffectModuleRegistryEntry["installationProvenance"],
    registryEntrySha256: value.registryEntrySha256, installedAt: value.installedAt, ...(value.revokedAt ? { revokedAt: value.revokedAt } : {}) } satisfies EffectModuleRegistryEntry;
  if (entry.installationProvenance.moduleId !== entry.moduleId || entry.installationProvenance.version !== entry.version
    || entry.installationProvenance.manifestSha256 !== entry.manifestSha256 || entry.installationProvenance.manifestByteLength !== entry.manifestByteLength
    || entry.installationProvenance.installedAt !== entry.installedAt
    || entry.installationProvenanceSha256 !== gpuEffectModuleInstallationProvenanceFingerprint(entry.installationProvenance)
    || entry.registryEntrySha256 !== effectModuleRegistryEntryHash(entry)) {
    throw new EffectModuleRegistryError("Effect-module registry entry hashes do not bind its immutable facts.", "private_state_invalid");
  }
  return entry;
}

export function createEffectModuleInstallationProvenance(
  moduleId: string,
  version: string,
  manifestSha256: string,
  manifestByteLength: number,
  installedAt: string
): EffectModuleRegistryEntry["installationProvenance"] {
  return {
    schema: "shellx-motion/effect-module-installation-provenance@1",
    moduleId, version, manifestSha256, manifestByteLength, installedAt, authority: "workbench-operator"
  };
}

export function effectModuleRegistryEntryHash(entry: Omit<EffectModuleRegistryEntry, "registryEntrySha256">): string {
  return gpuEffectModuleRegistryEntryFingerprint({
    moduleId: entry.moduleId, version: entry.version, manifestSha256: entry.manifestSha256,
    manifestByteLength: entry.manifestByteLength, installationProvenanceSha256: entry.installationProvenanceSha256,
    installationProvenance: entry.installationProvenance,
    intrinsic: entry.intrinsic, rendererAbi: entry.rendererAbi, parameterSchema: entry.parameterSchema
  });
}

export function finalizeEffectModuleRegistryEntry(entry: Omit<EffectModuleRegistryEntry, "registryEntrySha256">): EffectModuleRegistryEntry {
  return { ...entry, registryEntrySha256: effectModuleRegistryEntryHash(entry) };
}

export function findEffectModuleRegistryEntry(snapshot: EffectModuleRegistrySnapshot, moduleId: string, version: string): EffectModuleRegistryEntry | undefined {
  return snapshot.entries.find((entry) => entry.moduleId === moduleId && entry.version === version);
}

export function sortEffectModuleEntries(entries: readonly EffectModuleRegistryEntry[]): EffectModuleRegistryEntry[] {
  return [...entries].sort((left, right) => effectModuleEntryKey(left) < effectModuleEntryKey(right) ? -1 : effectModuleEntryKey(left) > effectModuleEntryKey(right) ? 1 : 0);
}

export function effectModuleEntryKey(entry: Pick<EffectModuleRegistryEntry, "moduleId" | "version">): string { return `${entry.moduleId}\u0000${entry.version}`; }
export function effectModuleBlobName(sha256: string): string { return `${sha256}.json`; }
export function effectModuleEntriesBytes(entries: readonly EffectModuleRegistryEntry[]): number { return entries.reduce((total, entry) => total + entry.manifestByteLength, 0); }
export function effectModuleRegistrySummary(entry: EffectModuleRegistryEntry): EffectModuleRegistrySummary { return { ...entry }; }
export function effectModuleDigest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export function createEffectModuleUseLease(entry: EffectModuleRegistryEntry, generation: number): EffectModuleUseLease {
  let released = false;
  return Object.freeze({ moduleId: entry.moduleId, version: entry.version, manifestSha256: entry.manifestSha256,
    manifestByteLength: entry.manifestByteLength, registryEntrySha256: entry.registryEntrySha256,
    installationProvenanceSha256: entry.installationProvenanceSha256, intrinsic: entry.intrinsic, rendererAbi: entry.rendererAbi,
    parameterSchema: entry.parameterSchema,
    registryGeneration: generation, notRevokedAtBeginUse: true as const,
    async release() { if (released) return { released: false }; released = true; return { released: true }; }
  });
}

function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeDisplayName(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 96 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }
function safeManifestByteLength(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_EFFECT_MODULE_MANIFEST_BYTES; }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
