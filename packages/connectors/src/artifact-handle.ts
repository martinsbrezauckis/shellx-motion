import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
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

export async function publishConnectorArtifact(stagingPath: string, outputPath: string): Promise<void> {
  const staging = resolve(stagingPath);
  const output = resolve(outputPath);
  if (dirname(staging) !== dirname(output)) throw new Error("connector artifact staging and output paths must share a directory");
  const before = await lstat(staging);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("connector artifact staging path must be a regular non-symlink file");
  const file = await openConnectorStagingNoFollow(staging);
  let createdOutput = false;
  let publishedOk = false;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("connector artifact staging file changed before publication");
    await file.sync();
    await link(staging, output);
    createdOutput = true;
    const published = await lstat(output);
    if (!published.isFile() || published.isSymbolicLink() || published.dev !== opened.dev || published.ino !== opened.ino) {
      await unlink(output).catch(() => undefined);
      createdOutput = false;
      throw new Error("connector artifact publication did not preserve the staged file identity");
    }
    publishedOk = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`connector artifact output already exists: ${output}`);
    throw error;
  } finally {
    await file.close();
    await unlink(staging).catch(() => undefined);
    if (createdOutput && !publishedOk) await unlink(output).catch(() => undefined);
  }
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
    probe: false,
    ...(input.qualityEvidence ? { qualityEvidence: input.qualityEvidence } : {})
  });
  await verifyAttestedArtifactHandle(input.root, handle, {
    requiredReceiptRoles: ["render", "connector"],
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
