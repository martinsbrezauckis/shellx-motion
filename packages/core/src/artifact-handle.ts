import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { packageRenderLineageInputHashes, validatePackageRenderLineage, type PackageRenderLineage } from "./package-render-lineage";
import { childEnvironment } from "./child-environment";
import type { OperationReceipt } from "./types";

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

export type ArtifactReceiptRole = "render" | "connector";

export interface ArtifactReceiptAttestation {
  role: ArtifactReceiptRole;
  id: string;
  operation: string;
  status: Extract<OperationReceipt["status"], "passed" | "warning">;
  rootRelativePath: string;
  sha256: string;
}

export interface ArtifactMediaProbeSummary {
  formatName?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  streams: Array<{
    index: number;
    codecType?: string;
    codecName?: string;
    width?: number;
    height?: number;
    sampleRate?: number;
    channels?: number;
  }>;
}

export interface AttestedArtifactHandle {
  schema: "shellx-motion/artifact-handle@1";
  id: string;
  packageId: string;
  motionId: string;
  operationHash: string;
  preset: string;
  mediaType: string;
  rootRelativePath: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
  receipts: ArtifactReceiptAttestation[];
  packageLineage?: PackageRenderLineage;
  probe?: ArtifactMediaProbeSummary;
  qualityEvidence?: Record<string, unknown>;
}

export interface AttestedArtifactHandleReference {
  schema: "shellx-motion/artifact-handle-ref@1";
  id: string;
  operationHash: string;
  rootRelativePath: string;
  sha256: string;
  packageLineage?: PackageRenderLineage;
}

export interface CreateAttestedArtifactHandleInput {
  root: string;
  artifactPath: string;
  packageId: string;
  motionId: string;
  operationHash: string;
  preset: string;
  mediaType: string;
  receipts: ArtifactReceiptAttestation[];
  packageLineage?: PackageRenderLineage;
  createdAt?: string;
  maxBytes?: number;
  probe?: false | ArtifactMediaProbe;
  qualityEvidence?: Record<string, unknown>;
}

export interface VerifyAttestedArtifactHandleOptions {
  maxBytes?: number;
  expected?: Partial<Pick<AttestedArtifactHandle, "packageId" | "motionId" | "operationHash" | "preset" | "mediaType" | "packageLineage">>;
  requiredReceiptRoles?: ArtifactReceiptRole[];
  probe?: false | ArtifactMediaProbe;
}

export type ArtifactMediaProbe = (path: string) => Promise<ArtifactMediaProbeSummary>;

export interface VerifiedAttestedArtifact {
  handle: AttestedArtifactHandle;
  root: string;
  path: string;
  receipts: Array<{ attestation: ArtifactReceiptAttestation; receipt: OperationReceipt; path: string }>;
  probe?: ArtifactMediaProbeSummary;
}

export interface VerifiedAttestedArtifactReference extends VerifiedAttestedArtifact {
  reference: AttestedArtifactHandleReference;
  descriptorPath: string;
}

export async function attestArtifactReceipt(
  root: string,
  receiptPath: string,
  role: ArtifactReceiptRole
): Promise<ArtifactReceiptAttestation> {
  const canonical = await canonicalExistingRootFile(root, receiptPath, "receipt");
  const bytes = await readBoundedFile(canonical.path, 4 * 1024 * 1024, "receipt");
  const receipt = parseOperationReceipt(bytes.toString("utf8"), canonical.rootRelativePath);
  if (receipt.status !== "passed" && receipt.status !== "warning") {
    throw new Error(`artifact receipt ${receipt.id} is not successful (status ${receipt.status})`);
  }
  return {
    role,
    id: receipt.id,
    operation: receipt.operation,
    status: receipt.status,
    rootRelativePath: canonical.rootRelativePath,
    sha256: hashBytes(bytes)
  };
}

export async function createAttestedArtifactHandle(
  input: CreateAttestedArtifactHandleInput
): Promise<AttestedArtifactHandle> {
  validateArtifactIdentityFields(input);
  const maxBytes = readMaxBytes(input.maxBytes);
  const canonical = await canonicalExistingRootFile(input.root, input.artifactPath, "artifact");
  const measured = await hashBoundedFile(canonical.path, maxBytes, "artifact");
  assertArtifactMagic(measured.header, input.mediaType);
  validateReceiptAttestations(input.receipts);
  if (input.packageLineage) validatePackageRenderLineage(input.packageLineage);
  const probe = await maybeProbeArtifact(canonical.path, input.mediaType, input.probe);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("artifact createdAt must be an ISO-compatible timestamp");
  return {
    schema: "shellx-motion/artifact-handle@1",
    id: artifactHandleId({ ...input, sha256: measured.sha256 }),
    packageId: input.packageId,
    motionId: input.motionId,
    operationHash: input.operationHash,
    preset: input.preset,
    mediaType: input.mediaType,
    rootRelativePath: canonical.rootRelativePath,
    byteLength: measured.byteLength,
    sha256: measured.sha256,
    createdAt,
    receipts: input.receipts.map((receipt) => ({ ...receipt })),
    ...(input.packageLineage ? { packageLineage: canonicalPackageLineage(input.packageLineage) } : {}),
    ...(probe ? { probe } : {}),
    ...(input.qualityEvidence ? { qualityEvidence: input.qualityEvidence } : {})
  };
}

export async function verifyAttestedArtifactHandle(
  root: string,
  handle: AttestedArtifactHandle,
  options: VerifyAttestedArtifactHandleOptions = {}
): Promise<VerifiedAttestedArtifact> {
  validateArtifactHandle(handle);
  validateExpectedArtifactFields(handle, options.expected ?? {});
  validateReceiptAttestations(handle.receipts);
  for (const role of options.requiredReceiptRoles ?? ["render"]) {
    if (!handle.receipts.some((receipt) => receipt.role === role)) {
      throw new Error(`artifact handle is missing required ${role} receipt attestation`);
    }
  }

  const canonical = await canonicalExistingRootFile(root, handle.rootRelativePath, "artifact");
  if (canonical.rootRelativePath !== handle.rootRelativePath) {
    throw new Error(`artifact handle path is not canonical: ${handle.rootRelativePath}`);
  }
  const measured = await hashBoundedFile(canonical.path, readMaxBytes(options.maxBytes), "artifact");
  if (measured.byteLength !== handle.byteLength) {
    throw new Error(`artifact byte length mismatch: expected ${handle.byteLength}, got ${measured.byteLength}`);
  }
  if (measured.sha256 !== handle.sha256) {
    throw new Error(`artifact sha256 mismatch: expected ${handle.sha256}, got ${measured.sha256}`);
  }
  assertArtifactMagic(measured.header, handle.mediaType);

  const receipts = [];
  for (const attestation of handle.receipts) {
    const receiptFile = await canonicalExistingRootFile(root, attestation.rootRelativePath, `${attestation.role} receipt`);
    if (receiptFile.rootRelativePath !== attestation.rootRelativePath) {
      throw new Error(`${attestation.role} receipt path is not canonical: ${attestation.rootRelativePath}`);
    }
    const bytes = await readBoundedFile(receiptFile.path, 4 * 1024 * 1024, `${attestation.role} receipt`);
    const actualHash = hashBytes(bytes);
    if (actualHash !== attestation.sha256) {
      throw new Error(`${attestation.role} receipt sha256 mismatch: expected ${attestation.sha256}, got ${actualHash}`);
    }
    const receipt = parseOperationReceipt(bytes.toString("utf8"), attestation.rootRelativePath);
    if (receipt.id !== attestation.id || receipt.operation !== attestation.operation || receipt.status !== attestation.status) {
      throw new Error(`${attestation.role} receipt identity or status does not match its attestation`);
    }
    if (receipt.packageId !== handle.packageId) {
      throw new Error(`${attestation.role} receipt packageId does not match artifact handle`);
    }
    if (receipt.status !== "passed" && receipt.status !== "warning") {
      throw new Error(`${attestation.role} receipt is not successful (status ${receipt.status})`);
    }
    if (attestation.role === "render") await assertRenderReceiptBindsArtifact(receipt, handle, canonical.root, canonical.path);
    receipts.push({ attestation, receipt, path: receiptFile.path });
  }

  const probe = await maybeProbeArtifact(canonical.path, handle.mediaType, options.probe);
  if (handle.probe && probe && JSON.stringify(handle.probe) !== JSON.stringify(probe)) {
    throw new Error("artifact media probe no longer matches the attested probe summary");
  }
  return { handle, root: canonical.root, path: canonical.path, receipts, ...(probe ? { probe } : {}) };
}

export async function writeAttestedArtifactHandle(path: string, handle: AttestedArtifactHandle): Promise<void> {
  validateArtifactHandle(handle);
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const staging = resolve(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(handle, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(staging, target);
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

export async function readAttestedArtifactHandle(path: string): Promise<AttestedArtifactHandle> {
  const bytes = await readBoundedFile(resolve(path), 4 * 1024 * 1024, "artifact handle descriptor");
  let parsed: AttestedArtifactHandle;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as AttestedArtifactHandle;
  } catch {
    throw new Error("artifact handle descriptor contains invalid JSON");
  }
  validateArtifactHandle(parsed);
  return parsed;
}

export async function verifyAttestedArtifactHandleReference(
  root: string,
  reference: AttestedArtifactHandleReference,
  options: VerifyAttestedArtifactHandleOptions = {}
): Promise<VerifiedAttestedArtifactReference> {
  validateArtifactHandleReference(reference);
  const descriptor = await canonicalExistingRootFile(root, reference.rootRelativePath, "artifact handle descriptor");
  if (descriptor.rootRelativePath !== reference.rootRelativePath) {
    throw new Error(`artifact handle descriptor path is not canonical: ${reference.rootRelativePath}`);
  }
  const bytes = await readBoundedFile(descriptor.path, 4 * 1024 * 1024, "artifact handle descriptor");
  const descriptorHash = hashBytes(bytes);
  if (descriptorHash !== reference.sha256) {
    throw new Error(`artifact handle descriptor sha256 mismatch: expected ${reference.sha256}, got ${descriptorHash}`);
  }
  let handle: AttestedArtifactHandle;
  try {
    handle = JSON.parse(bytes.toString("utf8")) as AttestedArtifactHandle;
  } catch {
    throw new Error("artifact handle descriptor contains invalid JSON");
  }
  validateArtifactHandle(handle);
  if (handle.id !== reference.id) throw new Error("artifact handle reference id does not match the descriptor");
  if (handle.operationHash !== reference.operationHash) throw new Error("artifact handle reference operationHash does not match the descriptor");
  if (!sameJson(handle.packageLineage, reference.packageLineage)) throw new Error("artifact handle reference packageLineage does not match the descriptor");
  const verified = await verifyAttestedArtifactHandle(descriptor.root, handle, options);
  return { ...verified, reference, descriptorPath: descriptor.path };
}

export function createAttestedArtifactHandleReference(
  handle: AttestedArtifactHandle,
  rootRelativePath: string,
  descriptorSha256: string
): AttestedArtifactHandleReference {
  validateArtifactHandle(handle);
  assertCanonicalRootRelativePath(rootRelativePath, "artifact handle descriptor");
  assertSha256(descriptorSha256, "artifact handle descriptor sha256");
  return {
    schema: "shellx-motion/artifact-handle-ref@1",
    id: handle.id,
    operationHash: handle.operationHash,
    rootRelativePath,
    sha256: descriptorSha256,
    ...(handle.packageLineage ? { packageLineage: structuredClone(handle.packageLineage) } : {})
  };
}

export async function probeArtifactWithFfprobe(
  path: string,
  options: { ffprobePath?: string; timeoutMs?: number; maxBufferBytes?: number } = {}
): Promise<ArtifactMediaProbeSummary> {
  const timeoutMs = readPositiveBound(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 60_000, "ffprobe timeoutMs");
  const maxBuffer = readPositiveBound(options.maxBufferBytes, DEFAULT_PROBE_MAX_BUFFER_BYTES, 8 * 1024 * 1024, "ffprobe maxBufferBytes");
  let stdout: string;
  try {
    const result = await execFileAsync(resolveArtifactFfprobeExecutable({ ffprobePath: options.ffprobePath }), [
      "-v", "error",
      "-show_entries", "format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,sample_rate,channels",
      "-of", "json",
      path
    ], { encoding: "utf8", timeout: timeoutMs, maxBuffer, env: artifactProbeChildEnvironment() });
    stdout = result.stdout;
  } catch (error) {
    throw new Error(`artifact media probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeProbeSummary(JSON.parse(stdout) as unknown);
}

export function artifactProbeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnvironment({ source });
}

export function resolveArtifactFfprobeExecutable(
  options: { ffprobePath?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const configured = options.ffprobePath?.trim()
    || (options.env ?? process.env).SHELLX_MOTION_FFPROBE?.trim()
    || "ffprobe";
  if (configured.includes("\0")) throw new Error("artifact ffprobe executable path must not contain null bytes");
  return configured;
}

async function canonicalExistingRootFile(rootInput: string, fileInput: string, label: string): Promise<{ root: string; path: string; rootRelativePath: string }> {
  const root = await realpath(resolve(rootInput));
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) throw new Error(`artifact root is not a directory: ${rootInput}`);
  const candidate = isAbsolute(fileInput) || win32.isAbsolute(fileInput) ? resolve(fileInput) : resolve(root, fileInput);
  const path = await realpath(candidate);
  const pathStats = await stat(path);
  if (!pathStats.isFile()) throw new Error(`${label} is not a regular file: ${fileInput}`);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the trusted artifact root: ${fileInput}`);
  }
  const rootRelativePath = relativePath.split(sep).join("/");
  assertCanonicalRootRelativePath(rootRelativePath, label);
  return { root, path, rootRelativePath };
}

function assertCanonicalRootRelativePath(path: string, label: string): void {
  if (!path || isAbsolute(path) || win32.isAbsolute(path) || path.includes("\\")) {
    throw new Error(`${label} path must be canonical and root-relative: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} path must not contain empty, dot, or parent segments: ${path}`);
  }
}

async function hashBoundedFile(path: string, maxBytes: number, label: string): Promise<{ sha256: string; byteLength: number; header: Buffer }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must resolve to a regular non-symlink file`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
  const file = await openReadNoFollow(path);
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed before it could be verified`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
    const hash = createHash("sha256");
    const header = Buffer.alloc(16);
    let headerBytes = 0;
    let byteLength = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
      hash.update(buffer.subarray(0, bytesRead));
      if (headerBytes < header.length) {
        const copyLength = Math.min(bytesRead, header.length - headerBytes);
        buffer.copy(header, headerBytes, 0, copyLength);
        headerBytes += copyLength;
      }
    }
    const after = await file.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino || byteLength !== after.size) {
      throw new Error(`${label} changed while it was being verified`);
    }
    return { sha256: hash.digest("hex"), byteLength, header: header.subarray(0, headerBytes) };
  } finally {
    await file.close();
  }
}

async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must resolve to a regular non-symlink file`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
  const file = await openReadNoFollow(path);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed before it could be verified`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino) {
      throw new Error(`${label} changed while it was being verified`);
    }
    return bytes;
  } finally {
    await file.close();
  }
}

async function openReadNoFollow(path: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = readRecord(error)?.code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    return open(path, constants.O_RDONLY);
  }
}

function assertArtifactMagic(header: Buffer, mediaType: string): void {
  const checks: Record<string, () => boolean> = {
    "image/png": () => header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/jpeg": () => header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
    "image/gif": () => header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a",
    "video/mp4": () => header.subarray(4, 8).toString("ascii") === "ftyp",
    "video/quicktime": () => header.subarray(4, 8).toString("ascii") === "ftyp",
    "video/webm": () => header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    "audio/wav": () => header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE"
  };
  const check = checks[mediaType];
  if (!check) throw new Error(`unsupported attested artifact media type: ${mediaType}`);
  if (!check()) throw new Error(`artifact bytes do not match declared media type ${mediaType}`);
}

async function maybeProbeArtifact(path: string, mediaType: string, probe: false | ArtifactMediaProbe | undefined): Promise<ArtifactMediaProbeSummary | undefined> {
  if (probe === false) return undefined;
  if (!mediaType.startsWith("video/") && !mediaType.startsWith("audio/")) return undefined;
  return (probe ?? probeArtifactWithFfprobe)(path);
}

function validateArtifactHandle(handle: AttestedArtifactHandle): void {
  if (!handle || handle.schema !== "shellx-motion/artifact-handle@1") throw new Error("unsupported artifact handle schema");
  if (typeof handle.id !== "string" || !/^artifact-[a-f0-9]{24}$/.test(handle.id)) throw new Error("artifact handle id is invalid");
  validateArtifactIdentityFields(handle);
  assertCanonicalRootRelativePath(handle.rootRelativePath, "artifact");
  if (!Number.isSafeInteger(handle.byteLength) || handle.byteLength < 0) throw new Error("artifact byteLength must be a non-negative safe integer");
  assertSha256(handle.sha256, "artifact sha256");
  if (!Number.isFinite(Date.parse(handle.createdAt))) throw new Error("artifact createdAt must be an ISO-compatible timestamp");
  if (!Array.isArray(handle.receipts)) throw new Error("artifact receipts must be an array");
  if (handle.packageLineage) validatePackageRenderLineage(handle.packageLineage);
  if (handle.id !== artifactHandleId(handle)) throw new Error("artifact handle id does not bind its identity and packageLineage");
}

function validateArtifactHandleReference(reference: AttestedArtifactHandleReference): void {
  if (!reference || reference.schema !== "shellx-motion/artifact-handle-ref@1") throw new Error("unsupported artifact handle reference schema");
  if (typeof reference.id !== "string" || !/^artifact-[a-f0-9]{24}$/.test(reference.id)) throw new Error("artifact handle reference id is invalid");
  assertSha256(reference.operationHash, "artifact handle reference operationHash");
  assertCanonicalRootRelativePath(reference.rootRelativePath, "artifact handle descriptor");
  assertSha256(reference.sha256, "artifact handle descriptor sha256");
  if (reference.packageLineage) validatePackageRenderLineage(reference.packageLineage);
}

function validateArtifactIdentityFields(input: Pick<AttestedArtifactHandle, "packageId" | "motionId" | "operationHash" | "preset" | "mediaType">): void {
  for (const [name, value] of [["packageId", input.packageId], ["motionId", input.motionId], ["preset", input.preset], ["mediaType", input.mediaType]] as const) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`artifact ${name} must be a non-empty string`);
  }
  assertSha256(input.operationHash, "artifact operationHash");
}

function validateReceiptAttestations(receipts: ArtifactReceiptAttestation[]): void {
  if (!Array.isArray(receipts) || receipts.length === 0) throw new Error("artifact handle requires at least one receipt attestation");
  const roles = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.role !== "render" && receipt.role !== "connector") throw new Error(`unsupported artifact receipt role: ${String(receipt.role)}`);
    if (roles.has(receipt.role)) throw new Error(`artifact handle has duplicate ${receipt.role} receipt attestations`);
    roles.add(receipt.role);
    if (!receipt.id || !receipt.operation) throw new Error(`${receipt.role} receipt identity is incomplete`);
    if (receipt.status !== "passed" && receipt.status !== "warning") throw new Error(`${receipt.role} receipt status must be passed or warning`);
    assertCanonicalRootRelativePath(receipt.rootRelativePath, `${receipt.role} receipt`);
    assertSha256(receipt.sha256, `${receipt.role} receipt sha256`);
  }
}

function validateExpectedArtifactFields(handle: AttestedArtifactHandle, expected: VerifyAttestedArtifactHandleOptions["expected"]): void {
  for (const [name, value] of Object.entries(expected ?? {})) {
    const actual = handle[name as keyof AttestedArtifactHandle];
    if (value !== undefined && (name === "packageLineage" ? !sameJson(actual, value) : actual !== value)) {
      throw new Error(`artifact ${name} mismatch: expected ${String(value)}, got ${String(handle[name as keyof AttestedArtifactHandle])}`);
    }
  }
}

async function assertRenderReceiptBindsArtifact(
  receipt: OperationReceipt,
  handle: AttestedArtifactHandle,
  root: string,
  artifactPath: string
): Promise<void> {
  const output = readRecord(receipt.output);
  if (output?.sha256 !== handle.sha256) throw new Error("render receipt output sha256 does not bind the attested artifact");
  if (typeof output.path !== "string") throw new Error("render receipt output path is missing");
  let receiptOutputPath: string;
  try {
    receiptOutputPath = await realpath(isAbsolute(output.path) || win32.isAbsolute(output.path) ? resolve(output.path) : resolve(root, output.path));
  } catch {
    throw new Error("render receipt output path does not resolve to the attested artifact");
  }
  if (receiptOutputPath !== artifactPath) {
    throw new Error("render receipt output path does not bind the attested artifact");
  }
  if (typeof output.preset === "string" && output.preset !== handle.preset) {
    throw new Error("render receipt preset does not match the attested artifact");
  }
  if (handle.packageLineage) {
    const expected = { operationHash: handle.operationHash, ...packageRenderLineageInputHashes(handle.packageLineage) };
    if (!sameHashRecord(receipt.inputHashes, expected)) {
      throw new Error("render receipt inputHashes do not exactly bind the artifact operationHash and packageLineage");
    }
  } else if (!Object.values(receipt.inputHashes).includes(handle.operationHash)) {
    throw new Error("render receipt input hashes do not bind the artifact operationHash");
  }
}

function parseOperationReceipt(json: string, path: string): OperationReceipt {
  let receipt: unknown;
  try {
    receipt = JSON.parse(json);
  } catch {
    throw new Error(`invalid JSON in artifact receipt ${path}`);
  }
  const record = readRecord(receipt);
  if (!record || record.schema !== "shellx-motion/receipt@1" || typeof record.id !== "string" || typeof record.operation !== "string" || typeof record.packageId !== "string") {
    throw new Error(`invalid operation receipt at ${path}`);
  }
  if (!(["passed", "warning", "failed", "not_run"] as unknown[]).includes(record.status)) throw new Error(`invalid receipt status at ${path}`);
  if (!readRecord(record.inputHashes) || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.lane !== "string" || !Array.isArray(record.warnings)) {
    throw new Error(`invalid operation receipt evidence at ${path}`);
  }
  return receipt as OperationReceipt;
}

function normalizeProbeSummary(value: unknown): ArtifactMediaProbeSummary {
  const record = readRecord(value);
  const format = readRecord(record?.format);
  const rawStreams = Array.isArray(record?.streams) ? record.streams : [];
  const streams = rawStreams.map(readRecord).filter((stream): stream is Record<string, unknown> => Boolean(stream)).map((stream) => ({
    index: readFiniteNumber(stream.index) ?? 0,
    ...(typeof stream.codec_type === "string" ? { codecType: stream.codec_type } : {}),
    ...(typeof stream.codec_name === "string" ? { codecName: stream.codec_name } : {}),
    ...(readFiniteNumber(stream.width) !== undefined ? { width: readFiniteNumber(stream.width) } : {}),
    ...(readFiniteNumber(stream.height) !== undefined ? { height: readFiniteNumber(stream.height) } : {}),
    ...(readFiniteNumber(stream.sample_rate) !== undefined ? { sampleRate: readFiniteNumber(stream.sample_rate) } : {}),
    ...(readFiniteNumber(stream.channels) !== undefined ? { channels: readFiniteNumber(stream.channels) } : {})
  }));
  if (streams.length === 0) throw new Error("artifact media probe did not report any streams");
  return {
    ...(typeof format?.format_name === "string" ? { formatName: format.format_name } : {}),
    ...(readFiniteNumber(format?.duration) !== undefined ? { durationSeconds: readFiniteNumber(format?.duration) } : {}),
    ...(readFiniteNumber(format?.size) !== undefined ? { sizeBytes: readFiniteNumber(format?.size) } : {}),
    streams
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function readMaxBytes(value: number | undefined): number {
  return readPositiveBound(value, DEFAULT_MAX_ARTIFACT_BYTES, Number.MAX_SAFE_INTEGER, "artifact maxBytes");
}

function readPositiveBound(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  return value;
}

function assertSha256(value: string, label: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a 64-character lowercase sha256 hash`);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactHandleId(input: Pick<AttestedArtifactHandle, "packageId" | "motionId" | "operationHash" | "sha256" | "packageLineage">): string {
  const idHash = hashBytes(Buffer.from(JSON.stringify({
    packageId: input.packageId,
    motionId: input.motionId,
    operationHash: input.operationHash,
    sha256: input.sha256,
    ...(input.packageLineage ? { packageLineage: canonicalPackageLineage(input.packageLineage) } : {})
  }), "utf8"));
  return `artifact-${idHash.slice(0, 24)}`;
}

function sameHashRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function sameJson(left: unknown, right: unknown): boolean {
  const leftRecord = readRecord(left);
  const rightRecord = readRecord(right);
  if (!leftRecord || !rightRecord) return left === right;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && leftRecord[key] === rightRecord[key]);
}

function canonicalPackageLineage(lineage: PackageRenderLineage): PackageRenderLineage {
  return {
    schema: lineage.schema,
    manifestSha256: lineage.manifestSha256,
    motionSha256: lineage.motionSha256,
    ...(lineage.adapterId ? { adapterId: lineage.adapterId } : {}),
    ...(lineage.sourceSha256 ? { sourceSha256: lineage.sourceSha256 } : {}),
    ...(lineage.normalizedSourceSha256 ? { normalizedSourceSha256: lineage.normalizedSourceSha256 } : {}),
    ...(lineage.loweringReceiptSha256 ? { loweringReceiptSha256: lineage.loweringReceiptSha256 } : {}),
  };
}
