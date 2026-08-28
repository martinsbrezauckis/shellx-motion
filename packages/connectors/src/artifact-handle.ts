import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import {
  attestArtifactReceipt,
  canonicalJsonSha256,
  createAttestedArtifactHandle,
  createAttestedArtifactHandleReference,
  hashFile,
  verifyAttestedArtifactHandle,
  writeAttestedArtifactHandle,
  type AttestedArtifactHandle,
  type AttestedArtifactHandleReference,
  type MotionPackage
} from "@shellx-motion/core";

export interface FinalizedConnectorArtifactHandle {
  handle: AttestedArtifactHandle;
  reference: AttestedArtifactHandleReference;
  path: string;
}

export function connectorArtifactStagingPath(outputPath: string): string {
  const extension = extname(outputPath);
  return join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.stage${extension}`);
}

export interface ConnectorArtifactPublicationOptions {
  /** Canvas may stage beneath its private sibling reservation instead of directly beside output. */
  privateStagingRoot?: string;
  /** Canvas pins the reservation stage it created, rejecting a retarget before a public link. */
  expectedPrivateStagingRoot?: ConnectorArtifactPathIdentity;
  /** Bounded fault seam for pathname-retarget regression coverage. Production callers omit it. */
  afterOutputLinked?: () => Promise<void>;
}

export interface ConnectorArtifactPathIdentity {
  dev: number;
  ino: number;
}

/**
 * Snapshot the only parent identity a later staging cleanup may trust. Streaming renderers call
 * this before handing a random stage path to the producer, so a retarget during rendering causes
 * cleanup to leave the replacement alone.
 */
export async function captureConnectorArtifactStagingTopology(
  stagingPath: string,
  outputPath: string,
  options: Pick<ConnectorArtifactPublicationOptions, "privateStagingRoot" | "expectedPrivateStagingRoot"> = {}
): Promise<{ stagingParent: ConnectorArtifactPathIdentity }> {
  const staging = resolve(stagingPath);
  const output = resolve(outputPath);
  const outputParent = dirname(output);
  const privateStagingRoot = options.privateStagingRoot ? resolve(options.privateStagingRoot) : undefined;
  const usesPrivateSiblingStage = privateStagingRoot !== undefined
    && isPathInsideOrEqual(outputParent, privateStagingRoot)
    && isPathInsideOrEqual(privateStagingRoot, staging);
  if (dirname(staging) !== outputParent && !usesPrivateSiblingStage) {
    throw new Error("connector artifact staging must share the output directory or its declared private sibling reservation");
  }
  // Publication is deliberately not a security boundary against the account that owns this
  // directory. It does, however, reject a caller-selected topology in which another POSIX
  // principal could rename the stage, public output, or a Canvas reservation directory between
  // pathname operations. The matching Canvas admission happens earlier, before bridge intake.
  await assertSafeConnectorArtifactDirectory(outputParent, "connector artifact output parent");
  if (options.expectedPrivateStagingRoot) {
    if (!privateStagingRoot) throw new Error("connector artifact expected private staging identity requires a private sibling reservation");
    const actualPrivateStagingRoot = await assertSafeConnectorArtifactDirectory(privateStagingRoot, "connector artifact private staging reservation");
    if (actualPrivateStagingRoot.dev !== options.expectedPrivateStagingRoot.dev
      || actualPrivateStagingRoot.ino !== options.expectedPrivateStagingRoot.ino) {
      throw new Error("connector artifact private staging reservation changed before publication");
    }
  }
  return { stagingParent: await assertSafeConnectorArtifactDirectory(dirname(staging), "connector artifact staging parent") };
}

export async function publishConnectorArtifact(
  stagingPath: string,
  outputPath: string,
  options: ConnectorArtifactPublicationOptions = {}
): Promise<void> {
  const staging = resolve(stagingPath);
  const output = resolve(outputPath);
  const topology = await captureConnectorArtifactStagingTopology(staging, output, options);
  const before = await lstat(staging);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("connector artifact staging path must be a regular non-symlink file");
  const file = await openConnectorStagingNoFollow(staging);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("connector artifact staging file changed before publication");
    await file.sync();
    await link(staging, output);
    await options.afterOutputLinked?.();
    const published = await lstat(output);
    if (!published.isFile() || published.isSymbolicLink() || published.dev !== opened.dev || published.ino !== opened.ino) {
      throw new Error("connector artifact publication did not preserve the staged file identity");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`connector artifact output already exists: ${output}`);
    throw error;
  } finally {
    await file.close();
    // Node has no atomic "unlink only this inode" operation. The safe-parent admission above
    // excludes a different principal from retargeting this topology; these identity checks also
    // refuse cleanup after an observed in-process/test retarget. A mismatch intentionally leaves
    // an owned stage orphan rather than deleting a host replacement by pathname.
    await removeOwnedConnectorStaging(staging, before, topology.stagingParent);
  }
}

/**
 * Retire a failed producer stage only when the parent observed before producer handoff remains
 * the same and the current leaf is a regular file. An absent leaf under that unchanged parent is
 * already clean; false means an uncertain or residual pathname that must be retained.
 */
export async function discardConnectorArtifactStaging(
  stagingPath: string,
  topology: { stagingParent: ConnectorArtifactPathIdentity }
): Promise<boolean> {
  const staging = resolve(stagingPath);
  if (!await connectorArtifactParentMatches(dirname(staging), topology.stagingParent)) return false;
  const before = await lstat(staging).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!before) return true;
  if (!before.isFile() || before.isSymbolicLink()) return false;
  await removeOwnedConnectorStaging(staging, before, topology.stagingParent);
  return await lstat(staging).then(() => false).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

/**
 * Require a canonical directory topology in which a non-owner cannot rename entries underneath
 * a caller-selected output path. POSIX ACLs, Windows ACLs, a privileged administrator, and the
 * current account remain the host trust boundary; there is no portable Node primitive that can
 * atomically link and conditionally unlink in a directory controlled by such a principal.
 */
async function assertSafeConnectorArtifactDirectory(path: string, label: string): Promise<ConnectorArtifactPathIdentity> {
  const directory = resolve(path);
  const root = parse(directory).root;
  let current = root;
  let finalFacts: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const part of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const facts = await lstat(current);
    if (!facts.isDirectory() || facts.isSymbolicLink() || await realpath(current) !== current || hasUnsafeConnectorArtifactParentAuthority(facts)) {
      throw new Error(`${label} must be canonical, non-symlink, and protected from unrelated rename authority`);
    }
    finalFacts = facts;
  }
  if (!finalFacts) {
    const facts = await lstat(root);
    if (!facts.isDirectory() || facts.isSymbolicLink() || await realpath(root) !== root || hasUnsafeConnectorArtifactParentAuthority(facts)) {
      throw new Error(`${label} must be canonical, non-symlink, and protected from unrelated rename authority`);
    }
    finalFacts = facts;
  }
  return { dev: Number(finalFacts.dev), ino: Number(finalFacts.ino) };
}

function hasUnsafeConnectorArtifactParentAuthority(facts: Awaited<ReturnType<typeof lstat>>): boolean {
  // Node does not expose a comparable owner/mode authority model on Windows; native ACLs there
  // are the host boundary. POSIX rejects another directory owner and non-sticky shared writable
  // directories, while retaining standard sticky roots such as /tmp for per-user temp children.
  if (typeof process.getuid !== "function") return false;
  const currentUid = process.getuid();
  if (facts.uid !== currentUid && facts.uid !== 0) return true;
  const isGroupOrWorldWritable = (Number(facts.mode) & 0o022) !== 0;
  const isSticky = (Number(facts.mode) & 0o1000) !== 0;
  return isGroupOrWorldWritable && !isSticky;
}

async function removeOwnedConnectorStaging(
  staging: string,
  expectedStaging: ConnectorArtifactPathIdentity,
  expectedParent: ConnectorArtifactPathIdentity
): Promise<void> {
  if (!await connectorArtifactParentMatches(dirname(staging), expectedParent)) return;
  const currentStaging = await lstat(staging).catch(() => null);
  if (!currentStaging
    || !currentStaging.isFile()
    || currentStaging.isSymbolicLink()
    || Number(currentStaging.dev) !== expectedStaging.dev
    || Number(currentStaging.ino) !== expectedStaging.ino) return;
  await unlink(staging).catch(() => undefined);
}

async function connectorArtifactParentMatches(path: string, expected: ConnectorArtifactPathIdentity): Promise<boolean> {
  const current = await lstat(path).catch(() => null);
  return !!current
    && current.isDirectory()
    && !current.isSymbolicLink()
    && Number(current.dev) === expected.dev
    && Number(current.ino) === expected.ino;
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsoluteRelative(relativePath));
}

function isAbsoluteRelative(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

async function openConnectorStagingNoFollow(path: string) {
  try {
    // Windows rejects fsync on a read-only handle with EPERM. Reopen the closed
    // renderer output read/write so the durability barrier remains real on every
    // supported desktop platform; the no-follow and inode identity checks below
    // still guard the publication boundary.
    return await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    return open(path, constants.O_RDWR);
  }
}

/**
 * Identity of the connector operation that produced an artifact, stamped into every attested
 * artifact handle.
 *
 * Serialization goes through `canonicalJsonSha256` (core). The local `canonicalJson` this
 * replaced sorted object keys with `String.prototype.localeCompare` and then rebuilt the object
 * with `Object.fromEntries`, which made the stamped identity depend on two things it must not:
 * the host's ambient locale, and JS's insertion re-ordering of integer-like keys. A live probe
 * on one machine, same input, gave `ea2aaf72…` under `LC_ALL=en_US.UTF-8` and `baf8aca2…` under
 * `LC_ALL=sv_SE.UTF-8` — the plan carries `inputHashes` keyed by package-relative FILE NAMES,
 * which are unconstrained and routinely non-ASCII.
 *
 * `assertPlainJsonOperationValue` keeps the strictness the local copy had: canonical JSON would
 * quietly drop an `undefined` or coerce a `Date`, and an identity must refuse those, not paper
 * over them.
 *
 * @param input package id, motion id, preset, and the connector plan evidence.
 * @returns lowercase hex SHA-256 of the canonical JSON encoding.
 * @throws {Error} when the operation contains a value canonical JSON cannot carry losslessly.
 */
export function connectorArtifactOperationHash(input: {
  packageId: string;
  motionId: string;
  preset: string;
  plan: unknown;
}): string {
  const operation = { ...input, plan: operationPlanEvidence(input.plan) };
  assertPlainJsonOperationValue(operation);
  return canonicalJsonSha256(operation);
}

export async function finalizeConnectorArtifactHandle(input: {
  root: string;
  descriptorPath: string;
  artifactPath: string;
  renderReceiptPath: string;
  connectorReceiptPath: string;
  pkg: Pick<MotionPackage, "manifest" | "motion">;
  operationHash: string;
  preset: string;
  mediaType: string;
  createdAt: string;
  /** Route-specific ceiling; accepted delivery may tighten Core's general artifact limit. */
  maxBytes?: number;
  qualityEvidence?: Record<string, unknown>;
}): Promise<FinalizedConnectorArtifactHandle> {
  const receipts = await Promise.all([
    attestArtifactReceipt(input.root, input.renderReceiptPath, "render"),
    attestArtifactReceipt(input.root, input.connectorReceiptPath, "connector")
  ]);
  const handle = await createAttestedArtifactHandle({
    root: input.root,
    artifactPath: input.artifactPath,
    packageId: input.pkg.manifest.id,
    motionId: input.pkg.motion.id,
    operationHash: input.operationHash,
    preset: input.preset,
    mediaType: input.mediaType,
    receipts,
    createdAt: input.createdAt,
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    probe: false,
    ...(input.qualityEvidence ? { qualityEvidence: input.qualityEvidence } : {})
  });
  await verifyAttestedArtifactHandle(input.root, handle, {
    requiredReceiptRoles: ["render", "connector"],
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    probe: false
  });
  await writeAttestedArtifactHandle(input.descriptorPath, handle);
  const rootRelativePath = relative(resolve(input.root), resolve(input.descriptorPath)).split(sep).join("/");
  const reference = createAttestedArtifactHandleReference(handle, rootRelativePath, await hashFile(input.descriptorPath));
  return { handle, reference, path: input.descriptorPath };
}

function operationPlanEvidence(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.schema !== "shellx-motion/cut-import-plan@1") return value;
  const { receipt, ...plan } = record;
  const receiptRecord = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : null;
  return {
    ...plan,
    ...(receiptRecord?.inputHashes ? { inputHashes: receiptRecord.inputHashes } : {})
  };
}

/**
 * Reject anything the artifact identity must not silently absorb.
 *
 * This is validation only — it builds no JSON text, so there is exactly one canonical serializer
 * in the repo. `undefined` object entries are allowed and are dropped by canonical JSON, matching
 * the behaviour the previous local serializer had; everything else that is not plain JSON data
 * (a `Date`, a class instance, a function, a non-finite number) is an authoring mistake and is
 * refused rather than coerced into an identity that no longer describes the operation.
 *
 * @param value the operation record about to be hashed.
 * @throws {Error} naming the unsupported value's type.
 */
function assertPlainJsonOperationValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertPlainJsonOperationValue(entry);
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      assertPlainJsonOperationValue(entry);
    }
    return;
  }
  throw new Error(`artifact operation contains unsupported ${typeof value} value`);
}
