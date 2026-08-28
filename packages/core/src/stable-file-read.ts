import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { assertExpectedStableFileIdentity, stableFileIdentity, type StableFileIdentity } from "./stable-file-identity";
import { StableFileRootTopology } from "./stable-file-topology";

const MAX_STABLE_FILE_BYTES = 512 * 1024 * 1024;

/**
 * One conservative admission policy for file-based host interchange.  It is intentionally shared
 * by Canvas, Cut connectors, scripts, source markdown and OTIO: a new connector must opt in to
 * these limits instead of quietly making a new unbounded read path.
 */
export interface BoundedResourceLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxPathDepth: number;
  maxAggregateBytes: number;
  maxConcurrentReads: number;
}

export const DEFAULT_HOST_INTERCHANGE_LIMITS: Readonly<BoundedResourceLimits> = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxFiles: 256,
  maxPathDepth: 16,
  maxAggregateBytes: 64 * 1024 * 1024,
  maxConcurrentReads: 4
});

export const DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS: Readonly<BoundedResourceLimits> = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 1_024,
  maxPathDepth: 16,
  maxAggregateBytes: 256 * 1024 * 1024,
  maxConcurrentReads: 4
});

/** A stateful pre-admission budget.  Reserve before opening a file, not after buffering it. */
export class BoundedResourceBudget {
  private fileCount = 0;
  private aggregateBytes = 0;
  private activeReads = 0;

  constructor(readonly limits: Readonly<BoundedResourceLimits>, readonly label: string) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} ${name} must be a positive safe integer.`);
    }
  }

  reserve(path: string, size: number, withinRoot?: string): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.maxFileBytes) {
      throw new Error(`${this.label} file exceeds the ${this.limits.maxFileBytes}-byte per-file limit: ${path}`);
    }
    const depth = pathDepth(path, withinRoot);
    if (depth > this.limits.maxPathDepth) {
      throw new Error(`${this.label} path exceeds the ${this.limits.maxPathDepth}-component depth limit: ${path}`);
    }
    if (this.fileCount + 1 > this.limits.maxFiles) {
      throw new Error(`${this.label} exceeds the ${this.limits.maxFiles}-file limit.`);
    }
    if (this.aggregateBytes + size > this.limits.maxAggregateBytes) {
      throw new Error(`${this.label} exceeds the ${this.limits.maxAggregateBytes}-byte aggregate limit.`);
    }
    this.fileCount += 1;
    this.aggregateBytes += size;
  }

  beginRead(): void {
    if (this.activeReads + 1 > this.limits.maxConcurrentReads) {
      throw new Error(`${this.label} exceeds the ${this.limits.maxConcurrentReads}-read concurrency limit.`);
    }
    this.activeReads += 1;
  }

  endRead(): void {
    this.activeReads = Math.max(0, this.activeReads - 1);
  }

  snapshot(): Readonly<{ fileCount: number; aggregateBytes: number; activeReads: number }> {
    return { fileCount: this.fileCount, aggregateBytes: this.aggregateBytes, activeReads: this.activeReads };
  }
}

export interface StableFileReadResult {
  bytes: Buffer;
  byteLength: number;
  canonicalPath: string;
  sha256: string;
  /** Present for native reads; test-only file services may omit it. */
  identity?: StableFileIdentity;
}

export type { StableFileIdentity } from "./stable-file-identity";

/** Metadata-only route proof used to reserve aggregate input budgets before any file bytes read. */
export interface StableFilePreflightResult {
  readonly byteLength: number;
  /** Present only when the caller must bind its later opened read to this metadata reservation. */
  readonly identity?: StableFileIdentity;
}

/** Read one bounded regular file without following a symlink or accepting an in-read replacement. */
export async function readBoundedStableFile(
  path: string,
  options: { label: string; maxBytes: number; withinRoot?: string; allowRootAlias?: boolean; requireSingleLink?: boolean; captureIdentity?: boolean; expectedIdentity?: StableFileIdentity },
): Promise<StableFileReadResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > MAX_STABLE_FILE_BYTES) {
    throw new Error(`${options.label} byte limit is invalid`);
  }
  const lexical = assertLexicalPathInsideRoot(path, options.withinRoot, options.label);
  const topology = await StableFileRootTopology.acquire(lexical, options.withinRoot, options.label, {
    createParents: false,
    allowRootAlias: options.allowRootAlias
  });
  // Establish the retained parent/root topology before inspecting the leaf: a lexical child under
  // a symlinked intermediate directory must fail before this metadata operation can follow it.
  const lexicalPreflight = await lstat(lexical);
  assertBoundedRegular(lexicalPreflight, options);
  const lexicalBefore = lexicalPreflight;
  const canonicalPath = await realpath(lexical);
  const canonicalRoot = await realpath(topology.rootPath);
  if (!inside(canonicalRoot, canonicalPath)) throw new Error(`${options.label} escapes its approved root`);
  const canonicalBefore = await lstat(canonicalPath);
  assertBoundedRegular(canonicalBefore, options);
  if (!sameFile(lexicalBefore, canonicalBefore)) throw new Error(`${options.label} changed before it was opened`);

  await topology.assertCurrent();
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await topology.assertCurrent();
    const before = await handle.stat();
    assertBoundedRegular(before, options);
    if (!sameFile(canonicalBefore, before)) throw new Error(`${options.label} changed before it was read`);
    assertExpectedStableFileIdentity(before, options.expectedIdentity, options.label);
    const bytes = await readBoundedHandle(handle, before.size);
    const after = await handle.stat();
    const canonicalAfter = await lstat(canonicalPath);
    const lexicalAfter = await lstat(lexical);
    if (bytes.byteLength !== before.size || !stable(before, after, options.requireSingleLink) || !stable(after, canonicalAfter, options.requireSingleLink)
      || !stable(canonicalAfter, lexicalAfter, options.requireSingleLink) || canonicalAfter.isSymbolicLink() || lexicalAfter.isSymbolicLink()) {
      throw new Error(`${options.label} changed while it was read`);
    }
    assertBoundedRegular(after, options);
    assertBoundedRegular(canonicalAfter, options);
    assertBoundedRegular(lexicalAfter, options);
    await topology.assertCurrent();
    return {
      bytes,
      byteLength: bytes.byteLength,
      canonicalPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(options.captureIdentity ? { identity: stableFileIdentity(after) } : {}),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Prove a source leaf is inside its retained stable route and return only its bounded byte count.
 * Callers use this before opening any sequence bytes, then call `readBoundedStableFile` for the
 * actual no-follow stable read; the second operation intentionally repeats all identity checks.
 */
export async function preflightBoundedStableFile(
  path: string,
  options: { label: string; maxBytes: number; withinRoot?: string; allowRootAlias?: boolean; requireSingleLink?: boolean; captureIdentity?: boolean },
): Promise<StableFilePreflightResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > MAX_STABLE_FILE_BYTES) {
    throw new Error(`${options.label} byte limit is invalid`);
  }
  const lexical = assertLexicalPathInsideRoot(path, options.withinRoot, options.label);
  const topology = await StableFileRootTopology.acquire(lexical, options.withinRoot, options.label, {
    createParents: false,
    allowRootAlias: options.allowRootAlias,
  });
  const lexicalBefore = await lstat(lexical);
  assertBoundedRegular(lexicalBefore, options);
  const canonicalPath = await realpath(lexical);
  const canonicalRoot = await realpath(topology.rootPath);
  if (!inside(canonicalRoot, canonicalPath)) throw new Error(`${options.label} escapes its approved root`);
  const canonicalBefore = await lstat(canonicalPath);
  assertBoundedRegular(canonicalBefore, options);
  if (!sameFile(lexicalBefore, canonicalBefore)) throw new Error(`${options.label} changed before it was preflighted`);
  await topology.assertCurrent();
  return {
    byteLength: canonicalBefore.size,
    ...(options.captureIdentity ? { identity: stableFileIdentity(canonicalBefore) } : {}),
  };
}

/**
 * Reserve then read one host-owned input.  The initial lstat makes aggregate/file-count refusal
 * happen before any bytes are allocated; readBoundedStableFile then proves the opened identity.
 */
export async function readBudgetedStableFile(
  path: string,
  options: {
    label: string;
    budget: BoundedResourceBudget;
    withinRoot?: string;
    requireSingleLink?: boolean;
    captureIdentity?: boolean;
    /** Test-only interruption seam after metadata reservation and before the first byte read. */
    afterPreflight?: () => Promise<void>;
  }
): Promise<StableFileReadResult> {
  const lexical = assertLexicalPathInsideRoot(path, options.withinRoot, options.label);
  const preflight = await preflightBoundedStableFile(lexical, {
    label: options.label,
    maxBytes: options.budget.limits.maxFileBytes,
    ...(options.withinRoot ? { withinRoot: options.withinRoot } : {}),
    ...(options.requireSingleLink ? { requireSingleLink: true } : {}),
    captureIdentity: true,
  });
  if (!preflight.identity) throw new Error(`${options.label} did not retain its metadata identity`);
  options.budget.reserve(lexical, preflight.byteLength, options.withinRoot);
  await options.afterPreflight?.();
  options.budget.beginRead();
  try {
    return await readBoundedStableFile(lexical, {
      label: options.label,
      maxBytes: options.budget.limits.maxFileBytes,
      ...(options.withinRoot ? { withinRoot: options.withinRoot } : {}),
      ...(options.requireSingleLink ? { requireSingleLink: true } : {}),
      ...(options.captureIdentity ? { captureIdentity: true } : {}),
      expectedIdentity: preflight.identity,
    });
  } finally {
    options.budget.endRead();
  }
}

/**
 * Publish already-verified bytes only through a no-follow, exclusive destination, then re-open the
 * staged result with the same stable-identity reader.  This is the copy-side proof paired with a
 * source read; no later pathname-based copy may substitute a different file.
 */
export async function writeVerifiedBoundedFile(
  path: string,
  bytes: Buffer,
  options: { label: string; maxBytes: number; withinRoot: string; expectedSha256?: string }
): Promise<StableFileReadResult> {
  if (bytes.byteLength > options.maxBytes) throw new Error(`${options.label} exceeds the ${options.maxBytes}-byte per-file limit.`);
  const destination = resolve(path);
  const root = resolve(options.withinRoot);
  if (!inside(root, destination)) throw new Error(`${options.label} escapes its approved root`);
  const topology = await StableFileRootTopology.acquire(destination, root, options.label, { createParents: true });
  await topology.assertCurrent();
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await topology.assertCurrent();
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesWritten === 0) throw new Error(`${options.label} could not be written.`);
      offset += bytesWritten;
    }
  } finally {
    await handle.close();
  }
  await topology.assertCurrent();
  const published = await readBoundedStableFile(destination, { label: options.label, maxBytes: options.maxBytes, withinRoot: root });
  await topology.assertCurrent();
  const expected = options.expectedSha256 ?? createHash("sha256").update(bytes).digest("hex");
  if (published.sha256 !== expected || published.byteLength !== bytes.byteLength) {
    throw new Error(`${options.label} changed during staged publication.`);
  }
  return published;
}

function assertBoundedRegular(stats: Stats, options: { label: string; maxBytes: number; requireSingleLink?: boolean }): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${options.label} must be a bounded regular non-symlink file`);
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > options.maxBytes) {
    throw new Error(`${options.label} exceeds its byte limit and must be a bounded regular non-symlink file`);
  }
  if (options.requireSingleLink && stats.nlink !== 1) {
    throw new Error(`${options.label} must be a single-link regular file`);
  }
}

/** Read at most the observed size plus one byte, so concurrent growth cannot allocate unboundedly. */
async function readBoundedHandle(handle: FileHandle, expectedSize: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Reject lexical root escapes before even leaf metadata is queried. */
function assertLexicalPathInsideRoot(path: string, withinRoot: string | undefined, label: string): string {
  const lexical = resolve(path);
  const root = resolve(withinRoot ?? parse(lexical).root);
  if (!inside(root, lexical)) throw new Error(`${label} escapes its approved root`);
  return lexical;
}

function pathDepth(path: string, withinRoot?: string): number {
  const resolved = resolve(path);
  const relation = withinRoot ? relative(resolve(withinRoot), resolved) : relative(parse(resolved).root, resolved);
  if (relation === "") return 0;
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error(`Bounded resource path escapes its root: ${path}`);
  return relation.split(sep).filter(Boolean).length;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stable(left: Stats, right: Stats, requireSingleLink = false): boolean {
  return sameFile(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && (!requireSingleLink || (left.nlink === 1 && right.nlink === 1));
}
