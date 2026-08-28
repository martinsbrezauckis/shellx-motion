/**
 * Security-sensitive, adapter-neutral authoring for immutable vector sources.
 *
 * Adapter wrappers supply only format identity and lowering behavior. This
 * module owns stable source reads, root confinement, private staging,
 * provenance convergence, atomic installation, and rollback behavior so those
 * guarantees cannot drift between Lottie, SVG, and future vector adapters.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hashBuffer,
  hashPackageFile,
  loadSchema,
  loadMotionPackage,
  validateDocument,
  type AdapterDiagnosticInput,
  type AdapterDiagnosticResult,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt,
  type PackageManifest
} from "@shellx-motion/core";
import { commitNewPackage } from "./package-edit-transaction.js";
import { assertPreparedStaticVectorSource, staticVectorPreparedFiles, type PreparedStaticVectorSource } from "./authoring-vector-prepared.js";

const MAX_VECTOR_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_BINARY_VECTOR_SOURCE_BYTES = 32 * 1024 * 1024;

export interface StaticVectorPackageOptions {
  sourcePath: string;
  outputRoot: string;
  inputRoots: string[];
  outputRoots: string[];
  createdBy?: string;
  createdAt?: string;
  /** Test/host seam used to prove an in-place source mutation is detected. */
  beforeSourceStabilityCheck?: () => Promise<void>;
  /** Optional host receipt step; failures roll the installed package back. */
  afterCommit?: (outputRoot: string, loweringReceipt: OperationReceipt) => Promise<string | undefined>;
}

export interface WrittenStaticVectorPackage {
  packageRoot: string;
  manifestPath: string;
  motionPath: string;
  sourcePath: string;
  diagnosticsReceiptPath: string;
  loweringReceiptPath: string;
  package: MotionPackage;
  sourceSha256: string;
  manifestSha256: string;
  motionSha256: string;
  hostReceiptPath?: string;
}

export interface StaticVectorLoweringResult {
  schema: "shellx-motion/adapter-lowering@1";
  adapterId: string;
  source: { path: string; sha256: string };
  motion: MotionDocument;
  diagnostics: AdapterDiagnosticResult;
  receipt: OperationReceipt;
}
export interface StaticVectorPackageDefinition {
  adapterId: string;
  formatLabel: string;
  sourceApp: string;
  sourceFileName: string;
  packagePrefix: string;
  lower: (input: AdapterDiagnosticInput & { createdBy?: string }) => StaticVectorLoweringResult;
  prepareSource?: (bytes: Buffer) => PreparedStaticVectorSource;
  maxSourceBytes?: number;
  packageCompatibility?: (lowering: StaticVectorLoweringResult) => PackageManifest["compatibility"];
  augmentPrepared?: (input: { packageId: string; prepared: PreparedStaticVectorSource; lowering: StaticVectorLoweringResult }) => void;
  validateAugmentedPackage?: (packageRoot: string) => Promise<void>;
}
export type { PreparedStaticVectorSource } from "./authoring-vector-prepared.js";
interface StagedVectorPackage {
  manifest: PackageManifest;
  lowering: StaticVectorLoweringResult;
  prepared: PreparedStaticVectorSource;
}

interface ApprovedRoot {
  lexical: string;
  canonical: string;
}

function lottieGpuPrecompositionCompatibility(lowering: StaticVectorLoweringResult): PackageManifest["compatibility"] | undefined {
  const output = lowering.receipt.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const gpuPrecomposition = (output as Record<string, unknown>).lottieGpuPrecomposition;
  if (typeof gpuPrecomposition !== "object" || gpuPrecomposition === null || Array.isArray(gpuPrecomposition)) return undefined;
  return { lanes: ["gpu"], hosts: ["shellx-motion"] };
}

/**
 * Installs a source-preserving Motion package without exposing a partially
 * written destination or accepting provenance that differs from staged bytes.
 */
export async function writeStaticVectorPackage(
  definition: StaticVectorPackageDefinition,
  options: StaticVectorPackageOptions
): Promise<WrittenStaticVectorPackage> {
  assertDefinition(definition);
  const sourcePath = resolve(options.sourcePath);
  const outputRoot = resolve(options.outputRoot);
  const [inputRoots, outputRoots] = await Promise.all([
    canonicalizeApprovedRoots(options.inputRoots, `${definition.formatLabel} source roots are required.`),
    canonicalizeApprovedRoots(options.outputRoots, `${definition.formatLabel} output roots are required.`)
  ]);
  await assertExistingPathInsideRoots(sourcePath, inputRoots, `${definition.formatLabel} source`);
  await assertOutputInsideRoots(outputRoot, outputRoots, definition.formatLabel);

  const source = await readStableFile(
    sourcePath,
    `${definition.formatLabel} source`,
    options.beforeSourceStabilityCheck,
    definition.maxSourceBytes ?? MAX_VECTOR_SOURCE_BYTES,
    definition.prepareSource !== undefined
  );
  // Pin approval to the canonical roots captured before opening the source.
  await assertExistingPathInsideRoots(sourcePath, inputRoots, `${definition.formatLabel} source`);
  const portableSourcePath = `source/${definition.sourceFileName}`;
  const prepared = definition.prepareSource
    ? definition.prepareSource(source.bytes)
    : defaultPreparedSource(source.bytes, portableSourcePath, definition.formatLabel);
  assertPreparedStaticVectorSource(prepared, definition.formatLabel);
  const packageId = `${definition.packagePrefix}_${prepared.primarySha256.slice(0, 16)}`;
  const lowering = definition.lower({
    adapterId: definition.adapterId,
    sourcePath: prepared.loweringPath,
    sourceText: prepared.loweringText,
    normalizedPackagePath: packageId,
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
    ...(options.createdAt ? { createdAt: options.createdAt } : {})
  });
  const loweringFile = prepared.files.find((file) => file.path === prepared.loweringPath);
  if (lowering.adapterId !== definition.adapterId
    || lowering.source.path !== prepared.loweringPath
    || lowering.source.sha256 !== loweringFile?.sha256) {
    throw new Error(`${definition.formatLabel} lowering provenance does not match the stable source bytes.`);
  }
  definition.augmentPrepared?.({ packageId, prepared, lowering }); assertPreparedStaticVectorSource(prepared, definition.formatLabel);

  const diagnosticsReceiptPath = "receipts/adapter-diagnostics.receipt.json";
  const loweringReceiptPath = "receipts/adapter-lowering.receipt.json";
  const manifest: PackageManifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name: lowering.motion.name,
    motion: "motion.json",
    assets: prepared.manifestAssets ?? [],
    sourceApp: definition.sourceApp,
    // A `ty:0` Lottie precomposition uses the persistent GPU group compositor.
    // Browser deliberately refuses group layers, so the lowering receipt is
    // authoritative over the generic vector compatibility default.
    compatibility: lottieGpuPrecompositionCompatibility(lowering)
      ?? definition.packageCompatibility?.(lowering)
      ?? {
        lanes: ["browser", "ffmpeg", "cut"],
        hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
      },
    data: {
      adapter: {
        ...(prepared.manifestData ?? {}),
        schema: "shellx-motion/adapter-source@1",
        id: definition.adapterId,
        source: prepared.primaryPath,
        sourceSha256: prepared.primarySha256,
        loweringSource: prepared.loweringPath,
        loweringSourceSha256: lowering.source.sha256,
        diagnosticsReceipt: diagnosticsReceiptPath,
        loweringReceipt: loweringReceiptPath
      }
    }
  };

  await assertCanonicalVectorPackage(manifest, lowering.motion, definition.formatLabel);

  // Recheck after lowering so a swapped parent cannot receive staging files.
  await assertOutputInsideRoots(outputRoot, outputRoots, definition.formatLabel);
  const transaction = await commitNewPackage({
    outputRoot,
    build: async (stagedRoot): Promise<StagedVectorPackage> => {
      await mkdir(join(stagedRoot, "source"), { recursive: true, mode: 0o700 });
      await mkdir(join(stagedRoot, "receipts"), { recursive: true, mode: 0o700 });
      await writePrivateJson(join(stagedRoot, "manifest.json"), manifest);
      await writePrivateJson(join(stagedRoot, "motion.json"), lowering.motion);
      // Preserve every prepared input byte-for-byte under validated package paths.
      for (const file of staticVectorPreparedFiles(prepared)) {
        await mkdir(dirname(join(stagedRoot, file.path)), { recursive: true, mode: 0o700 });
        await writePrivateBytes(join(stagedRoot, file.path), file.bytes);
      }
      await writePrivateJson(join(stagedRoot, diagnosticsReceiptPath), lowering.diagnostics.receipt);
      await writePrivateJson(join(stagedRoot, loweringReceiptPath), lowering.receipt);
      return { manifest, lowering, prepared };
    },
    validate: async (stagedRoot, staged) => validateStagedVectorPackage(stagedRoot, staged, definition),
    beforeCommit: async (stagedRoot) => {
      await assertExistingPathInsideRoots(stagedRoot, outputRoots, `${definition.formatLabel} package staging directory`);
      await assertOutputInsideRoots(outputRoot, outputRoots, definition.formatLabel);
    },
    afterCommit: async (installedRoot, staged) => {
      await assertExistingPathInsideRoots(installedRoot, outputRoots, `${definition.formatLabel} package output`);
      await validateStagedVectorPackage(installedRoot, staged, definition);
      const hostReceiptPath = options.afterCommit
        ? await options.afterCommit(installedRoot, staged.lowering.receipt)
        : undefined;
      // A host callback is not trusted to leave installed package bytes alone.
      await assertExistingPathInsideRoots(installedRoot, outputRoots, `${definition.formatLabel} package output`);
      await validateStagedVectorPackage(installedRoot, staged, definition);
      return hostReceiptPath;
    }
  });

  await assertExistingPathInsideRoots(outputRoot, outputRoots, `${definition.formatLabel} package output`);
  const pkg = await loadMotionPackage(outputRoot);
  const [manifestSha256, motionSha256, installedSourceSha256] = await Promise.all([
    hashPackageFile(join(outputRoot, "manifest.json")),
    hashPackageFile(join(outputRoot, pkg.manifest.motion)),
    hashPackageFile(join(outputRoot, prepared.primaryPath))
  ]);
  if (installedSourceSha256 !== prepared.primarySha256 || motionSha256 !== loweringMotionSha256(lowering, definition.formatLabel)) {
    throw new Error(`Installed ${definition.formatLabel} package identity drifted after atomic commit.`);
  }
  return {
    packageRoot: outputRoot,
    manifestPath: join(outputRoot, "manifest.json"),
    motionPath: join(outputRoot, pkg.manifest.motion),
    sourcePath: join(outputRoot, prepared.primaryPath),
    diagnosticsReceiptPath: join(outputRoot, diagnosticsReceiptPath),
    loweringReceiptPath: join(outputRoot, loweringReceiptPath),
    package: pkg,
    sourceSha256: prepared.primarySha256,
    manifestSha256,
    motionSha256,
    ...(transaction.afterCommitResult !== undefined ? { hostReceiptPath: transaction.afterCommitResult } : {})
  };
}

async function assertCanonicalVectorPackage(
  manifest: PackageManifest,
  motion: MotionDocument,
  formatLabel: string
): Promise<void> {
  const [motionValidation, manifestValidation] = await Promise.all([
    validateDocument(await loadSchema("motion"), motion),
    validateDocument(await loadSchema("packageManifest"), manifest)
  ]);
  if (!motionValidation.ok) {
    throw new Error(`Canonical Motion validation rejected the lowered ${formatLabel} document before package commit: ${validationSummary(motionValidation.errors)}`);
  }
  if (!manifestValidation.ok) {
    throw new Error(`Canonical Motion validation rejected the lowered ${formatLabel} package manifest before package commit: ${validationSummary(manifestValidation.errors)}`);
  }
}

function validationSummary(errors: Array<{ path: string; message: string }>): string {
  return errors.slice(0, 4).map((error) => `${error.path || "/"} ${error.message}`).join("; ");
}

async function validateStagedVectorPackage(
  stagedRoot: string,
  staged: StagedVectorPackage,
  definition: StaticVectorPackageDefinition
): Promise<void> {
  const pkg = await loadMotionPackage(stagedRoot);
  const diagnosticsReceiptPath = "receipts/adapter-diagnostics.receipt.json";
  const loweringReceiptPath = "receipts/adapter-lowering.receipt.json";
  const [fileHashes, motionHash, diagnosticsReceipt, loweringReceipt] = await Promise.all([
    Promise.all(staticVectorPreparedFiles(staged.prepared).map(async (file) => ({ file, hash: await hashPackageFile(join(stagedRoot, file.path)) }))),
    hashPackageFile(join(stagedRoot, pkg.manifest.motion)),
    readStableReceipt(join(stagedRoot, diagnosticsReceiptPath)),
    readStableReceipt(join(stagedRoot, loweringReceiptPath))
  ]);
  if (pkg.manifest.id !== staged.manifest.id || pkg.motion.id !== staged.lowering.motion.id) {
    throw new Error(`Staged ${definition.formatLabel} package identity does not match the lowering result.`);
  }
  if (JSON.stringify(pkg.manifest.assets) !== JSON.stringify(staged.prepared.manifestAssets ?? [])) {
    throw new Error(`Staged ${definition.formatLabel} manifest asset list does not match prepared bytes.`);
  }
  const adapterData = readRecord(readRecord(pkg.manifest.data).adapter);
  if (adapterData.id !== definition.adapterId
    || adapterData.source !== staged.prepared.primaryPath
    || adapterData.sourceSha256 !== staged.prepared.primarySha256
    || adapterData.loweringSource !== staged.prepared.loweringPath
    || adapterData.loweringSourceSha256 !== staged.lowering.source.sha256
    || adapterData.diagnosticsReceipt !== diagnosticsReceiptPath
    || adapterData.loweringReceipt !== loweringReceiptPath) {
    throw new Error(`Staged ${definition.formatLabel} manifest adapter provenance does not match the preserved source.`);
  }
  for (const [key, value] of Object.entries(staged.prepared.manifestData ?? {})) {
    if (hashBuffer(Buffer.from(JSON.stringify(adapterData[key]) ?? "undefined", "utf8")) !== hashBuffer(Buffer.from(JSON.stringify(value) ?? "undefined", "utf8"))) {
      throw new Error(`Staged ${definition.formatLabel} manifest adapter metadata does not match prepared provenance.`);
    }
  }
  if (fileHashes.some(({ file, hash }) => hash !== file.sha256)) {
    throw new Error(`Staged ${definition.formatLabel} preserved source hash does not match prepared bytes.`);
  }
  const loweringFile = fileHashes.find(({ file }) => file.path === staged.prepared.loweringPath);
  if (!loweringFile || loweringFile.hash !== staged.lowering.source.sha256) {
    throw new Error(`Staged ${definition.formatLabel} lowering source hash does not match the lowering input.`);
  }
  if (motionHash !== loweringMotionSha256(staged.lowering, definition.formatLabel)) {
    throw new Error("Staged Motion bytes do not match the lowering receipt.");
  }
  assertReceiptIdentity(diagnosticsReceipt, staged.lowering.diagnostics, staged.lowering.source.sha256, definition.formatLabel);
  assertReceiptIdentity(loweringReceipt, staged.lowering, staged.lowering.source.sha256, definition.formatLabel); await definition.validateAugmentedPackage?.(stagedRoot);
}

function assertReceiptIdentity(
  receipt: OperationReceipt,
  expected: { receipt: OperationReceipt },
  sourceSha256: string,
  formatLabel: string
): void {
  if (receipt.id !== expected.receipt.id
    || receipt.operation !== expected.receipt.operation
    || receipt.status !== expected.receipt.status
    || receipt.packageId !== expected.receipt.packageId
    || receipt.inputHashes.source !== sourceSha256
    || hashBuffer(Buffer.from(JSON.stringify(receipt), "utf8")) !== hashBuffer(Buffer.from(JSON.stringify(expected.receipt), "utf8"))) {
    throw new Error(`Staged ${formatLabel} receipt identity does not match the lowering result.`);
  }
}

function loweringMotionSha256(lowering: StaticVectorLoweringResult, formatLabel: string): string {
  const output = lowering.receipt.output as { motionSha256?: unknown };
  if (typeof output.motionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(output.motionSha256)) {
    throw new Error(`${formatLabel} lowering receipt is missing a valid Motion SHA-256.`);
  }
  return output.motionSha256;
}

async function readStableFile(
  path: string,
  label: string,
  beforeStabilityCheck?: () => Promise<void>,
  maxBytes = MAX_VECTOR_SOURCE_BYTES,
  allowNul = false
): Promise<{ bytes: Buffer }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      throw new Error(`${label} must be a regular file no larger than ${maxBytes} bytes.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || (!allowNul && bytes.includes(0))) throw new Error(`${label} bytes are incomplete or contain forbidden NUL data.`);
    if (beforeStabilityCheck) await beforeStabilityCheck();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (!after.isFile()
      || pathAfter.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return { bytes };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readStableReceipt(path: string): Promise<OperationReceipt> {
  const source = await readStableFile(path, "Vector package receipt");
  return JSON.parse(decodeStableUtf8(source.bytes, "Vector package receipt")) as OperationReceipt;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function writePrivateBytes(path: string, value: Uint8Array): Promise<void> {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
}

async function canonicalizeApprovedRoots(roots: string[], emptyMessage: string): Promise<ApprovedRoot[]> {
  if (roots.length === 0) throw new Error(emptyMessage);
  return Promise.all(roots.map(async (root) => ({ lexical: resolve(root), canonical: await realpath(resolve(root)) })));
}

async function assertExistingPathInsideRoots(path: string, roots: ApprovedRoot[], label: string): Promise<void> {
  const canonicalPath = await realpath(path);
  if (!roots.some((root) => isPathInsideOrEqual(root.canonical, canonicalPath))) {
    throw new Error(`${label} must be inside an approved root.`);
  }
}

async function assertOutputInsideRoots(path: string, roots: ApprovedRoot[], formatLabel: string): Promise<void> {
  const lexical = roots.some((root) => isPathInsideOrEqual(root.lexical, path));
  const canonicalParent = await canonicalPathForSafety(dirname(path));
  if (!lexical || !roots.some((root) => isPathInsideOrEqual(root.canonical, canonicalParent))) {
    throw new Error(`${formatLabel} package output must be inside an approved output root.`);
  }
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
    const parent = dirname(resolved);
    return parent === resolved ? resolved : join(await canonicalPathForSafety(parent), resolved.slice(parent.length + 1));
  }
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertDefinition(definition: StaticVectorPackageDefinition): void {
  if (!/^adapter\.[a-z0-9-]+$/.test(definition.adapterId)
    || !/^[a-z0-9][a-z0-9._-]*$/.test(definition.sourceFileName)
    || !/^pkg_[a-z0-9_]+$/.test(definition.packagePrefix)
    || (definition.maxSourceBytes !== undefined && (!Number.isSafeInteger(definition.maxSourceBytes) || definition.maxSourceBytes <= 0 || definition.maxSourceBytes > MAX_BINARY_VECTOR_SOURCE_BYTES))) {
    throw new Error("Static vector package definition contains unsafe identity fields.");
  }
}

function defaultPreparedSource(bytes: Buffer, path: string, formatLabel: string): PreparedStaticVectorSource {
  const text = decodeStableUtf8(bytes, `${formatLabel} source`);
  const sha256 = hashBuffer(bytes);
  return {
    primaryPath: path,
    primarySha256: sha256,
    loweringPath: path,
    loweringText: text,
    files: [{ path, bytes, sha256 }]
  };
}

function decodeStableUtf8(bytes: Uint8Array, label: string): string {
  try {
    // Keeping the BOM as U+FEFF makes re-encoding hash-identical to the source.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}
