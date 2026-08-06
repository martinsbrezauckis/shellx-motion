import { compareCodeUnits } from "./canonical-json";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hashBuffer } from "./receipts";
import { loadMotionPackage, resolvePackageAsset } from "./package";
import { loadSchema, validateDocument, type SchemaName } from "./validate";
import type { OperationReceipt, ReceiptArtifact } from "./types";

export interface MotionPackageArchiveEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface MotionPackageArchiveResult {
  ok: true;
  packageId: string;
  archivePath: string;
  receiptPath: string;
  archiveSha256: string;
  byteLength: number;
  fileCount: number;
  entries: MotionPackageArchiveEntry[];
  receipt: OperationReceipt;
}

export interface WriteMotionPackageArchiveInput {
  packageRoot: string;
  archivePath: string;
  receiptPath?: string;
  createdAt?: string;
}

export interface ExtractMotionPackageArchiveInput {
  archivePath: string;
  packageRoot: string;
  receiptPath?: string;
  createdAt?: string;
  limits?: Partial<MotionPackageArchiveExtractionLimits>;
}

export interface MotionPackageArchiveExtractionLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxPathDepth: number;
  maxPathBytes: number;
  maxJsonBytes: number;
}

const TAR_BLOCK_SIZE = 512;
const PACKAGE_ARCHIVE_EXTENSION = ".shellxmotion";
const MOTION_PACKAGE_MEDIA_TYPE = "application/vnd.shellx.motion.package";
const TAR_IO_CHUNK_SIZE = 64 * 1024;
export const DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS: MotionPackageArchiveExtractionLimits = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxFiles: 10_000,
  maxPathDepth: 32,
  maxPathBytes: 1024,
  maxJsonBytes: 16 * 1024 * 1024
});

export async function writeMotionPackageArchive(input: WriteMotionPackageArchiveInput): Promise<MotionPackageArchiveResult> {
  const pkg = await loadMotionPackage(input.packageRoot);
  const archivePath = resolve(input.archivePath);
  const receiptPath = resolve(input.receiptPath ?? `${archivePath}.receipt.json`);
  await assertArchiveOutputsOutsidePackage(pkg.root, [archivePath, receiptPath]);

  const files = await collectPackageFiles(pkg.root);
  const entries = await Promise.all(files.map(async (path): Promise<MotionPackageArchiveEntry & { absolutePath: string; data: Buffer }> => {
    const data = await readFile(path);
    const archiveEntry = packageRelativePath(pkg.root, path);
    return {
      absolutePath: path,
      path: archiveEntry,
      size: data.byteLength,
      sha256: hashBuffer(data),
      data
    };
  }));
  // Entry order decides the archive's bytes, so a locale-sensitive sort made the archive
  // hash depend on the machine that built it. Code-unit order is the same everywhere.
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));

  const archiveBuffer = createTarArchive(entries);
  const archiveSha256 = hashBuffer(archiveBuffer);
  const inputHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.sha256]));
  const createdAt = input.createdAt ?? new Date().toISOString();
  const artifacts: ReceiptArtifact[] = [
    { role: "motion_package_archive", path: archivePath, status: "available", mediaType: "application/x-tar", primary: true },
    { role: "package_archive_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `package-archive-${pkg.manifest.id}-${archiveSha256.slice(0, 16)}`,
    operation: "package.archive",
    status: "passed",
    packageId: pkg.manifest.id,
    inputHashes,
    createdAt,
    lane: "package",
    output: {
      archivePath,
      receiptPath,
      archiveFormat: "tar",
      packageExtension: PACKAGE_ARCHIVE_EXTENSION,
      sha256: archiveSha256,
      byteLength: archiveBuffer.byteLength,
      fileCount: entries.length,
      entries: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    },
    artifacts,
    warnings: []
  };

  await mkdir(dirname(archivePath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(archivePath, archiveBuffer);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return {
    ok: true,
    packageId: pkg.manifest.id,
    archivePath,
    receiptPath,
    archiveSha256,
    byteLength: archiveBuffer.byteLength,
    fileCount: entries.length,
    entries: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    receipt
  };
}

export async function extractMotionPackageArchive(input: ExtractMotionPackageArchiveInput): Promise<MotionPackageArchiveExtractResult> {
  const archivePath = resolve(input.archivePath);
  const packageRoot = resolve(input.packageRoot);
  const receiptPath = resolve(input.receiptPath ?? `${packageRoot}.package-extract.receipt.json`);
  const limits = resolveArchiveExtractionLimits(input.limits);
  await assertArchiveOutputsOutsidePackage(packageRoot, [receiptPath]);
  await assertEmptyPackageDestination(packageRoot);
  await mkdir(dirname(packageRoot), { recursive: true });

  const stagingRoot = await mkdtemp(join(dirname(packageRoot), ".shellx-motion-extract-"));
  let installed = false;
  try {
    const archive = await open(archivePath, "r");
    let extracted: StreamedArchiveExtraction;
    try {
      const archiveInfo = await archive.stat();
      if (!archiveInfo.isFile()) throw new Error("Package archive must be a regular file.");
      if (archiveInfo.size > limits.maxArchiveBytes) {
        throw new Error(`Package archive exceeds the ${limits.maxArchiveBytes}-byte archive limit.`);
      }
      extracted = await extractTarArchiveToStaging(archive, archiveInfo.size, stagingRoot, limits);
      const finalArchiveInfo = await archive.stat();
      if (
        finalArchiveInfo.size !== archiveInfo.size
        || finalArchiveInfo.mtimeMs !== archiveInfo.mtimeMs
        || finalArchiveInfo.ctimeMs !== archiveInfo.ctimeMs
      ) {
        throw new Error("Package archive changed while it was being extracted.");
      }
    } finally {
      await archive.close();
    }
    if (extracted.entries.length === 0) throw new Error("Package archive is empty.");

    await verifyStagedEntryHashes(stagingRoot, extracted.entries, limits.maxFileBytes);
    const pkg = await validateExtractedPackage(stagingRoot, limits.maxJsonBytes);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: packageRoot, status: "available", mediaType: MOTION_PACKAGE_MEDIA_TYPE, primary: true },
      { role: "motion_package_archive", path: archivePath, status: "available", mediaType: "application/x-tar" },
      { role: "package_archive_extract_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `package-extract-${pkg.manifest.id}-${extracted.archiveSha256.slice(0, 16)}`,
      operation: "package.archive.extract",
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes: {
        archive: extracted.archiveSha256,
        ...Object.fromEntries(extracted.entries.map((entry) => [entry.path, entry.sha256]))
      },
      createdAt,
      lane: "package",
      output: {
        archivePath,
        packageRoot,
        receiptPath,
        archiveFormat: "tar",
        packageExtension: PACKAGE_ARCHIVE_EXTENSION,
        sha256: extracted.archiveSha256,
        byteLength: extracted.archiveBytes,
        expandedByteLength: extracted.expandedBytes,
        fileCount: extracted.entries.length,
        limits,
        entries: extracted.entries
      },
      artifacts,
      warnings: []
    };

    await installStagedPackage(stagingRoot, packageRoot);
    installed = true;
    try {
      await writeJsonAtomic(receiptPath, receipt);
    } catch (error) {
      await rm(packageRoot, { recursive: true, force: true });
      installed = false;
      throw error;
    }

    return {
      ok: true,
      packageId: pkg.manifest.id,
      archivePath,
      packageRoot,
      receiptPath,
      archiveSha256: extracted.archiveSha256,
      byteLength: extracted.archiveBytes,
      expandedByteLength: extracted.expandedBytes,
      fileCount: extracted.entries.length,
      entries: extracted.entries,
      receipt
    };
  } finally {
    if (!installed) await rm(stagingRoot, { recursive: true, force: true });
  }
}

export interface MotionPackageArchiveExtractResult {
  ok: true;
  packageId: string;
  archivePath: string;
  packageRoot: string;
  receiptPath: string;
  archiveSha256: string;
  byteLength: number;
  expandedByteLength: number;
  fileCount: number;
  entries: MotionPackageArchiveEntry[];
  receipt: OperationReceipt;
}

async function collectPackageFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Package archive does not support symbolic links: ${packageRelativePath(root, path)}`);
    }
    if (info.isDirectory()) return collectPackageFiles(path);
    return info.isFile() ? [path] : [];
  }));
  return files.flat().sort((left, right) => compareCodeUnits(packageRelativePath(root, left), packageRelativePath(root, right)));
}

interface StreamedArchiveExtraction {
  archiveSha256: string;
  archiveBytes: number;
  expandedBytes: number;
  entries: MotionPackageArchiveEntry[];
}

async function extractTarArchiveToStaging(
  archive: FileHandle,
  archiveBytes: number,
  stagingRoot: string,
  limits: MotionPackageArchiveExtractionLimits
): Promise<StreamedArchiveExtraction> {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 0) throw new Error("Package archive size is invalid.");
  const archiveHash = createHash("sha256");
  const entries: MotionPackageArchiveEntry[] = [];
  const seenPaths = new Set<string>();
  let expandedBytes = 0;
  let offset = 0;

  while (offset < archiveBytes) {
    if (archiveBytes - offset < TAR_BLOCK_SIZE) throw new Error("Package archive tar header is truncated.");
    const header = await readFileRange(archive, offset, TAR_BLOCK_SIZE, "tar header");
    archiveHash.update(header);
    offset += TAR_BLOCK_SIZE;

    if (header.every((byte) => byte === 0)) {
      if (archiveBytes - offset < TAR_BLOCK_SIZE) throw new Error("Package archive is missing the second tar end marker.");
      while (offset < archiveBytes) {
        const length = Math.min(TAR_IO_CHUNK_SIZE, archiveBytes - offset);
        const tail = await readFileRange(archive, offset, length, "tar trailer");
        if (!tail.every((byte) => byte === 0)) throw new Error("Package archive contains non-zero data after the tar end marker.");
        archiveHash.update(tail);
        offset += length;
      }
      return {
        archiveSha256: archiveHash.digest("hex"),
        archiveBytes,
        expandedBytes,
        entries
      };
    }

    assertTarChecksum(header);
    const name = readNullTerminated(header.subarray(0, 100));
    const prefix = readNullTerminated(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    validateArchiveEntryPath(stagingRoot, path, limits);
    const duplicateKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (seenPaths.has(duplicateKey)) throw new Error(`Package archive contains duplicate file: ${path}`);
    seenPaths.add(duplicateKey);

    const size = readOctal(header.subarray(124, 136));
    if (size > limits.maxFileBytes) {
      throw new Error(`Package archive entry ${path} exceeds the ${limits.maxFileBytes}-byte per-file limit.`);
    }
    if (entries.length + 1 > limits.maxFiles) {
      throw new Error(`Package archive exceeds the ${limits.maxFiles}-file limit.`);
    }
    if (expandedBytes + size > limits.maxExpandedBytes) {
      throw new Error(`Package archive exceeds the ${limits.maxExpandedBytes}-byte expanded-data limit.`);
    }
    const typeFlag = readNullTerminated(header.subarray(156, 157)) || "0";
    if (typeFlag !== "0") {
      throw new Error(`Package archive supports regular files only, got type ${typeFlag} for ${path}.`);
    }
    if (size > archiveBytes - offset) throw new Error(`Package archive entry is truncated: ${path}`);

    const outputPath = packageExtractPath(stagingRoot, path);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const output = await open(outputPath, "wx", 0o600);
    const entryHash = createHash("sha256");
    try {
      let remaining = size;
      while (remaining > 0) {
        const length = Math.min(TAR_IO_CHUNK_SIZE, remaining);
        const chunk = await readFileRange(archive, offset, length, `entry ${path}`);
        archiveHash.update(chunk);
        entryHash.update(chunk);
        await writeFileHandle(output, chunk);
        offset += length;
        remaining -= length;
      }
    } finally {
      await output.close();
    }

    const padding = paddingForSize(size);
    if (padding > archiveBytes - offset) throw new Error(`Package archive entry padding is truncated: ${path}`);
    if (padding > 0) {
      const paddingBytes = await readFileRange(archive, offset, padding, `entry padding ${path}`);
      if (!paddingBytes.every((byte) => byte === 0)) throw new Error(`Package archive entry has non-zero padding: ${path}`);
      archiveHash.update(paddingBytes);
      offset += padding;
    }

    expandedBytes += size;
    entries.push({ path, size, sha256: entryHash.digest("hex") });
  }

  throw new Error("Package archive is missing tar end markers.");
}

async function readFileRange(handle: FileHandle, position: number, length: number, label: string): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`Package archive ${label} is truncated.`);
    offset += bytesRead;
  }
  return buffer;
}

async function writeFileHandle(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Package archive extraction could not write staged file data.");
    offset += bytesWritten;
  }
}

function validateArchiveEntryPath(root: string, path: string, limits: MotionPackageArchiveExtractionLimits): void {
  packageExtractPath(root, path);
  if (path !== path.normalize("NFC")) throw new Error(`Package archive entry path must use NFC normalization: ${path}`);
  for (const part of path.split("/")) {
    if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`Package archive entry is not a portable package path: ${path}`);
    }
  }
  if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) {
    throw new Error(`Package archive entry path exceeds the ${limits.maxPathBytes}-byte path limit: ${path}`);
  }
  if (path.split("/").length > limits.maxPathDepth) {
    throw new Error(`Package archive entry path exceeds the ${limits.maxPathDepth}-component depth limit: ${path}`);
  }
}

async function verifyStagedEntryHashes(
  stagingRoot: string,
  entries: MotionPackageArchiveEntry[],
  maxFileBytes: number
): Promise<void> {
  for (const entry of entries) {
    const path = packageExtractPath(stagingRoot, entry.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Extracted package entry is not a regular file: ${entry.path}`);
    if (info.size !== entry.size) {
      throw new Error(`Extracted package entry size mismatch for ${entry.path}: expected ${entry.size}, got ${info.size}.`);
    }
    if (info.size > maxFileBytes) throw new Error(`Extracted package entry exceeds the ${maxFileBytes}-byte per-file limit: ${entry.path}`);
    const hash = createHash("sha256");
    const file = await open(path, "r");
    try {
      let offset = 0;
      while (offset < info.size) {
        const length = Math.min(TAR_IO_CHUNK_SIZE, info.size - offset);
        const chunk = await readFileRange(file, offset, length, `staged entry ${entry.path}`);
        hash.update(chunk);
        offset += length;
      }
    } finally {
      await file.close();
    }
    const actual = hash.digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`Extracted package entry sha256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual}.`);
    }
  }
}

async function validateExtractedPackage(stagingRoot: string, maxJsonBytes: number) {
  const manifestPath = join(stagingRoot, "manifest.json");
  const manifestDocument = await readBoundedJson(manifestPath, maxJsonBytes, "package manifest");
  await assertValidSchema("packageManifest", manifestDocument, "package manifest");

  const pkg = await loadMotionPackage(stagingRoot);
  const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
  const motionDocument = await readBoundedJson(motionPath, maxJsonBytes, "motion document");
  await assertValidSchema("motion", motionDocument, "motion document");
  if (pkg.manifest.template) {
    const templatePath = resolvePackageAsset(pkg, pkg.manifest.template);
    const templateDocument = await readBoundedJson(templatePath, maxJsonBytes, "template document");
    await assertValidSchema("template", templateDocument, "template document");
  }
  for (const assetRef of pkg.manifest.assets) {
    const assetPath = resolvePackageAsset(pkg, assetRef);
    const info = await lstat(assetPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Package asset is not a regular file: ${assetRef}`);
  }
  return pkg;
}

async function readBoundedJson(path: string, maxBytes: number, label: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte JSON limit.`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertValidSchema(schemaName: SchemaName, document: unknown, label: string): Promise<void> {
  const result = await validateDocument(await loadSchema(schemaName), document);
  if (!result.ok) {
    const detail = result.errors.slice(0, 10).map((error) => `${error.path || "/"} ${error.message}`).join("; ");
    throw new Error(`${label} failed schema validation: ${detail}`);
  }
}

function resolveArchiveExtractionLimits(
  overrides: Partial<MotionPackageArchiveExtractionLimits> | undefined
): MotionPackageArchiveExtractionLimits {
  return {
    maxArchiveBytes: positiveLimit(overrides?.maxArchiveBytes, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxArchiveBytes, "maxArchiveBytes"),
    maxExpandedBytes: positiveLimit(overrides?.maxExpandedBytes, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxExpandedBytes, "maxExpandedBytes"),
    maxFileBytes: positiveLimit(overrides?.maxFileBytes, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxFileBytes, "maxFileBytes"),
    maxFiles: positiveLimit(overrides?.maxFiles, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxFiles, "maxFiles"),
    maxPathDepth: positiveLimit(overrides?.maxPathDepth, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxPathDepth, "maxPathDepth"),
    maxPathBytes: positiveLimit(overrides?.maxPathBytes, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxPathBytes, "maxPathBytes"),
    maxJsonBytes: positiveLimit(overrides?.maxJsonBytes, DEFAULT_PACKAGE_ARCHIVE_EXTRACTION_LIMITS.maxJsonBytes, "maxJsonBytes")
  };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`Package archive ${name} must be a positive safe integer.`);
  return resolved;
}

async function assertEmptyPackageDestination(packageRoot: string): Promise<void> {
  try {
    const info = await lstat(packageRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Package extraction destination must be nonexistent or an empty directory.");
    }
    if ((await readdir(packageRoot)).length > 0) {
      throw new Error("Package extraction destination must be nonexistent or an empty directory.");
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

async function installStagedPackage(stagingRoot: string, packageRoot: string): Promise<void> {
  await assertEmptyPackageDestination(packageRoot);
  try {
    await rmdir(packageRoot);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await rename(stagingRoot, packageRoot);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function assertTarChecksum(header: Buffer): void {
  const expected = readOctal(header.subarray(148, 156));
  const checkHeader = Buffer.from(header);
  checkHeader.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of checkHeader) actual += byte;
  if (expected !== actual) {
    throw new Error("Package archive tar header checksum mismatch.");
  }
}

function readNullTerminated(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  const value = buffer.subarray(0, end === -1 ? buffer.byteLength : end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("Package archive tar header contains invalid UTF-8.");
  }
}

function readOctal(buffer: Buffer): number {
  const value = readNullTerminated(buffer).trim();
  if (value.length === 0) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Package archive tar header contains an invalid octal value: ${value}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Package archive tar value is out of range: ${value}`);
  return parsed;
}

function createTarArchive(entries: Array<MotionPackageArchiveEntry & { data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(createTarHeader(entry));
    chunks.push(entry.data);
    const padding = paddingForSize(entry.data.byteLength);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function createTarHeader(entry: MotionPackageArchiveEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(entry.path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  if (prefix) writeString(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeChecksum(header, checksum);
  return header;
}

function splitTarPath(path: string): { name: string; prefix?: string } {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= 100) return { name: path };
  const parts = path.split("/");
  for (let splitIndex = 1; splitIndex < parts.length; splitIndex += 1) {
    const prefix = parts.slice(0, splitIndex).join("/");
    const name = parts.slice(splitIndex).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Package archive path is too long for portable tar format: ${path}`);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error(`Tar header value is too long: ${value}`);
  bytes.copy(buffer, offset, 0, bytes.byteLength);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error(`Tar header octal value is too large: ${value}`);
  buffer.write(text, offset, length - 1, "ascii");
}

function writeChecksum(buffer: Buffer, value: number): void {
  const text = value.toString(8).padStart(6, "0");
  if (text.length > 6) throw new Error(`Tar checksum value is too large: ${value}`);
  buffer.write(text, 148, 6, "ascii");
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function paddingForSize(size: number): number {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder;
}

function packageRelativePath(root: string, path: string): string {
  const normalized = relative(root, path).split(/[/\\]+/).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Package archive file escapes package root: ${path}`);
  }
  return normalized;
}

function packageExtractPath(packageRoot: string, archivePath: string): string {
  if (!archivePath || archivePath.startsWith("/") || archivePath.includes("\0") || archivePath.includes("\\")) {
    throw new Error(`Package archive entry escapes package root: ${archivePath}`);
  }
  const parts = archivePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Package archive entry escapes package root: ${archivePath}`);
  }
  const outputPath = resolve(packageRoot, ...parts);
  if (!isPathInsideOrEqual(packageRoot, outputPath)) {
    throw new Error(`Package archive entry escapes package root: ${archivePath}`);
  }
  return outputPath;
}

async function assertArchiveOutputsOutsidePackage(packageRoot: string, outputPaths: string[]): Promise<void> {
  const canonicalPackageRoot = await canonicalPathForSafety(packageRoot);
  for (const outputPath of outputPaths) {
    const canonicalOutputPath = await canonicalPathForSafety(outputPath);
    if (isPathInsideOrEqual(canonicalPackageRoot, canonicalOutputPath)) {
      throw new Error("Package archive output paths must be outside packageRoot.");
    }
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && relation !== ".." && !isAbsolute(relation));
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(await canonicalPathForSafety(parent), basename(resolved));
  }
}
