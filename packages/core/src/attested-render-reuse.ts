/**
 * Bounded, content-addressed descriptors for reusing an already attested final render.
 *
 * This intentionally sits beside (rather than inside) the generic artifact-handle contract. A
 * handle proves a media file and its source receipt. Reuse additionally has to bind the exact
 * render request and every bounded source byte that was current when that media was produced.
 * Keeping that policy in its own versioned descriptor prevents an old SDK handle from silently
 * acquiring stronger meaning than it actually has.
 */
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import {
  verifyAttestedArtifactHandle,
  type ArtifactReceiptAttestation,
  type AttestedArtifactHandle,
  type VerifiedAttestedArtifact,
} from "./artifact-handle";
import { hashFile } from "./receipts";
import {
  attestedRenderReuseDescriptorId,
  validateAttestedRenderReuseDescriptor,
  validateAttestedRenderReuseInputs,
  validateAttestedRenderReusePlan,
  validateAttestedRenderReuseReceipt,
} from "./attested-render-reuse-validation";
import {
  attestedReusePathInside,
  canonicalAttestedReuseDirectory,
  canonicalAttestedReusePathInsideRoot,
} from "./attested-render-reuse-path";

export const ATTESTED_RENDER_REUSE_SCHEMA = "shellx-motion/attested-render-reuse@2" as const;
export const ATTESTED_RENDER_REUSE_MAX_PACKAGE_FILES = 4_096;
export const ATTESTED_RENDER_REUSE_MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 4 * 1024 * 1024;

export {
  ATTESTED_RENDER_REUSE_MAX_EXTERNAL_INPUT_BYTES,
  hashAttestedRenderReuseExternalInput,
  hashAttestedRenderReuseExternalInputInsideRoot,
  readAttestedRenderReuseExternalInput,
} from "./attested-render-reuse-input";

export interface AttestedRenderReuseInputs {
  schema: "shellx-motion/attested-render-inputs@2";
  packageSha256: string;
  /** Canonical browser workflow values actually handed to the renderer, if any. */
  workflowSha256?: string;
  /** Original bounded workflow file bytes, retained separately from its resolved runtime values. */
  workflowPathSha256?: string;
  qualityManifestSha256?: string;
  /** Ordered, bounded quality-baseline bytes resolved from the current quality manifest. */
  qualityBaselinesSha256?: string;
}

/** The resolved plan fields whose change must never reuse a different render. */
export interface AttestedRenderReusePlan {
  schema: "shellx-motion/attested-render-plan@2";
  outputRootRelativePath: string;
  preset: string;
  frameLane: "browser" | "native";
  engineVersion: string;
  atMs?: number;
  minUniqueFrameHashes?: number;
  workflow: "none" | "inline" | "path";
  qualityManifest: boolean;
}

/**
 * Immutable cache entry. Its id hashes all of its security-relevant fields, including the generic
 * artifact handle and its source receipt attestation; `qualityEvidence` is deliberately not used.
 */
export interface AttestedRenderReuseDescriptor {
  schema: typeof ATTESTED_RENDER_REUSE_SCHEMA;
  id: string;
  cacheKey: string;
  plan: AttestedRenderReusePlan;
  inputs: AttestedRenderReuseInputs;
  artifact: AttestedArtifactHandle;
  sourceReceipt: ArtifactReceiptAttestation;
  createdAt: string;
}

export interface VerifiedAttestedRenderReuse {
  descriptor: AttestedRenderReuseDescriptor;
  artifact: VerifiedAttestedArtifact;
}

/** Hash every regular package byte in a bounded, deterministic order. */
export async function deriveAttestedRenderPackageFingerprint(rootInput: string): Promise<string> {
  const root = await canonicalAttestedReuseDirectory(rootInput, "render package root");
  const records: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const canonicalDirectoryPath = await realpath(directory);
    const directoryEntry = await lstat(canonicalDirectoryPath);
    if (canonicalDirectoryPath !== directory || !attestedReusePathInside(root, canonicalDirectoryPath) || !directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new Error("render package directory changed or escaped while fingerprinting");
    }
    const entries = await readdir(canonicalDirectoryPath, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rootRelativePath = relative(root, path).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw new Error(`render package contains a symbolic link: ${rootRelativePath}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`render package contains an unsupported non-regular entry: ${rootRelativePath}`);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error(`render package entry changed while fingerprinting: ${rootRelativePath}`);
      }
      fileCount += 1;
      totalBytes += before.size;
      if (fileCount > ATTESTED_RENDER_REUSE_MAX_PACKAGE_FILES || totalBytes > ATTESTED_RENDER_REUSE_MAX_PACKAGE_BYTES) {
        throw new Error("render package exceeds the attested-reuse fingerprint budget");
      }
      const sha256 = await hashFile(path);
      const after = await lstat(path);
      if (!sameFile(before, after)) throw new Error(`render package entry changed while fingerprinting: ${rootRelativePath}`);
      records.push(`${rootRelativePath}\0${before.size}\0${sha256}`);
    }
  };

  await walk(root);
  return sha256(records.join("\n"));
}

export function attestedRenderReuseCacheKey(plan: AttestedRenderReusePlan, inputs: AttestedRenderReuseInputs): string {
  validateAttestedRenderReusePlan(plan);
  validateAttestedRenderReuseInputs(inputs);
  return canonicalJsonSha256({ schema: ATTESTED_RENDER_REUSE_SCHEMA, plan, inputs });
}

export function createAttestedRenderReuseDescriptor(input: Omit<AttestedRenderReuseDescriptor, "schema" | "id" | "cacheKey">): AttestedRenderReuseDescriptor {
  validateAttestedRenderReusePlan(input.plan);
  validateAttestedRenderReuseInputs(input.inputs);
  validateAttestedRenderReuseReceipt(input.sourceReceipt);
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("attested-reuse descriptor createdAt must be ISO-compatible");
  const cacheKey = attestedRenderReuseCacheKey(input.plan, input.inputs);
  const descriptor: Omit<AttestedRenderReuseDescriptor, "id"> = {
    schema: ATTESTED_RENDER_REUSE_SCHEMA,
    cacheKey,
    plan: clonePlan(input.plan),
    inputs: cloneInputs(input.inputs),
    artifact: structuredClone(input.artifact),
    sourceReceipt: { ...input.sourceReceipt },
    createdAt: input.createdAt,
  };
  return { ...descriptor, id: attestedRenderReuseDescriptorId(descriptor) };
}

/** Exclusive publication; callers must serialize the render fill before reaching this point. */
export async function writeAttestedRenderReuseDescriptor(input: {
  root: string;
  descriptorPath: string;
  descriptor: AttestedRenderReuseDescriptor;
}): Promise<void> {
  validateAttestedRenderReuseDescriptor(input.descriptor);
  const root = await canonicalAttestedReuseDirectory(input.root, "attested-reuse root");
  const requestedTarget = canonicalAttestedReusePathInsideRoot({
    requestedRoot: input.root,
    canonicalRoot: root,
    path: input.descriptorPath,
    label: "attested-reuse descriptor",
  });
  const parent = await createCanonicalDirectoryInside(root, dirname(requestedTarget), "attested-reuse descriptor directory");
  const target = join(parent, basename(requestedTarget));
  if (target !== requestedTarget) throw new Error("attested-reuse descriptor directory is not canonical");
  const staging = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(input.descriptor, null, 2)}\n`, "utf8");
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

export async function readAttestedRenderReuseDescriptor(pathInput: string): Promise<AttestedRenderReuseDescriptor> {
  const bytes = await readDescriptorFile(resolve(pathInput));
  let descriptor: AttestedRenderReuseDescriptor;
  try {
    descriptor = JSON.parse(bytes.toString("utf8")) as AttestedRenderReuseDescriptor;
  } catch {
    throw new Error("attested-reuse descriptor contains invalid JSON");
  }
  validateAttestedRenderReuseDescriptor(descriptor);
  return descriptor;
}

export async function verifyAttestedRenderReuse(input: {
  root: string;
  descriptorPath: string;
  plan: AttestedRenderReusePlan;
  inputs: AttestedRenderReuseInputs;
}): Promise<VerifiedAttestedRenderReuse> {
  const root = await canonicalAttestedReuseDirectory(input.root, "attested-reuse root");
  const requestedDescriptorPath = canonicalAttestedReusePathInsideRoot({
    requestedRoot: input.root,
    canonicalRoot: root,
    path: input.descriptorPath,
    label: "attested-reuse descriptor",
  });
  const descriptorPath = await canonicalExistingPathInside(root, requestedDescriptorPath, "attested-reuse descriptor");
  const descriptor = await readAttestedRenderReuseDescriptor(descriptorPath);
  const cacheKey = attestedRenderReuseCacheKey(input.plan, input.inputs);
  if (descriptor.cacheKey !== cacheKey || !sameJson(descriptor.plan, input.plan) || !sameJson(descriptor.inputs, input.inputs)) {
    throw new Error("attested-reuse descriptor does not bind the current render request and inputs");
  }
  if (descriptor.artifact.operationHash !== cacheKey) throw new Error("attested-reuse artifact operationHash does not match descriptor key");
  if (descriptor.artifact.rootRelativePath !== descriptor.plan.outputRootRelativePath) {
    throw new Error("attested-reuse artifact output path does not match descriptor plan");
  }
  const source = descriptor.artifact.receipts.find((entry) => entry.role === "render");
  if (!source || !sameJson(source, descriptor.sourceReceipt)) {
    throw new Error("attested-reuse source render receipt is not bound to artifact handle");
  }
  const artifact = await verifyAttestedArtifactHandle(root, descriptor.artifact, {
    expected: { operationHash: cacheKey }, requiredReceiptRoles: ["render"], probe: false,
  });
  if (artifact.path !== resolve(root, descriptor.plan.outputRootRelativePath)) {
    throw new Error("attested-reuse artifact resolved outside its planned output identity");
  }
  return { descriptor, artifact };
}

function clonePlan(value: AttestedRenderReusePlan): AttestedRenderReusePlan {
  return { ...value };
}

function cloneInputs(value: AttestedRenderReuseInputs): AttestedRenderReuseInputs {
  return { ...value };
}

async function canonicalExistingPathInside(root: string, pathInput: string, label: string): Promise<string> {
  const requested = resolve(pathInput);
  if (!attestedReusePathInside(root, requested)) throw new Error(`${label} escapes its root`);
  const parent = await realpath(dirname(requested));
  if (!attestedReusePathInside(root, parent) || join(parent, basename(requested)) !== requested) {
    throw new Error(`${label} directory is not canonical inside its root`);
  }
  return requested;
}

async function createCanonicalDirectoryInside(root: string, pathInput: string, label: string): Promise<string> {
  const requested = resolve(pathInput);
  if (!attestedReusePathInside(root, requested)) throw new Error(`${label} escapes its root`);
  const relativePath = relative(root, requested);
  let current = root;
  for (const part of relativePath ? relativePath.split(sep) : []) {
    current = join(current, part);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (createError) {
        if (errno(createError) !== "EEXIST") throw createError;
      }
      entry = await lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or non-directory`);
    const canonical = await realpath(current);
    if (!attestedReusePathInside(root, canonical) || canonical !== current) throw new Error(`${label} escapes its root`);
  }
  return current;
}

async function readDescriptorFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DESCRIPTOR_BYTES) throw new Error("attested-reuse descriptor must be a bounded regular non-symlink file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_DESCRIPTOR_BYTES) throw new Error("attested-reuse descriptor changed before it could be read");
    const bytes = await file.readFile();
    const after = await file.stat();
    const pathAfter = await lstat(path);
    if (bytes.byteLength !== opened.size || !sameFile(opened, after) || !sameFile(after, pathAfter)) throw new Error("attested-reuse descriptor changed while it was read");
    return bytes;
  } finally {
    await file.close();
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return !right.isSymbolicLink() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
