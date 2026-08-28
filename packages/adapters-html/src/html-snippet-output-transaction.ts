/**
 * Transactional publication for HTML adapter directory outputs.
 *
 * HTML import/export receives a caller-selected directory. It must never write into that mutable
 * directory directly: even an empty-directory check leaves a window for a symlink, replacement,
 * or competing artifact. Core owns the same-filesystem private reservation and atomic publish;
 * this adapter owns the closed nested-file inventory and no-follow descriptor writes inside it.
 */
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { acquireDerivedOutputPublication, type DerivedOutputPublication } from "@shellx-motion/core";

export class HtmlSnippetOutputTransaction {
  private readonly written = new Set<string>();

  private constructor(
    readonly stagePath: string,
    private readonly publication: DerivedOutputPublication
  ) {}

  static async acquire(outputPath: string): Promise<HtmlSnippetOutputTransaction> {
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "directory" });
    return new HtmlSnippetOutputTransaction(publication.stagingPath, publication);
  }

  async writeFile(relativePath: string, bytes: string | Buffer): Promise<void> {
    const destination = await this.privateDestination(relativePath);
    const handle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(bytes);
      await assertRegularHandle(handle, destination);
      this.written.add(relativePath);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Copy already-open validated source bytes without reopening either source or destination paths. */
  async copyFromDescriptor(relativePath: string, source: FileHandle, expectedSize: number, label: string): Promise<{ sha256: string; size: number }> {
    const destination = await this.privateDestination(relativePath);
    const target = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of source.createReadStream({ start: 0, autoClose: false })) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer;
        hash.update(bytes);
        size += bytes.byteLength;
        await writeAll(target, bytes);
      }
      if (size !== expectedSize) throw new Error(`HTML snippet import asset changed while it was being staged: ${label}.`);
      await assertRegularHandle(target, destination);
      this.written.add(relativePath);
      return { sha256: hash.digest("hex"), size };
    } finally {
      await target.close().catch(() => undefined);
    }
  }

  async publish(): Promise<void> {
    const inventory = [...this.written].sort();
    const evidence = await this.publication.verifyDirectory(inventory);
    await this.publication.publishDirectory(evidence, inventory);
  }

  /** Cleanup is intentionally limited to the private reservation; it never touches outputPath. */
  async abort(): Promise<void> {
    await this.publication.abort();
  }

  private async privateDestination(relativePath: string): Promise<string> {
    if (!safeRelativeFilePath(relativePath)) throw new Error(`HTML snippet output path must be a safe relative file path: ${relativePath}.`);
    const destination = resolve(this.stagePath, ...relativePath.split("/"));
    if (!isInside(this.stagePath, destination)) throw new Error(`HTML snippet output path escapes its private stage: ${relativePath}.`);
    await securePrivateParent(this.stagePath, dirname(destination));
    return destination;
  }
}

async function securePrivateParent(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!isInside(absoluteRoot, absoluteTarget) && absoluteTarget !== absoluteRoot) {
    throw new Error("HTML snippet output parent escapes its private stage.");
  }
  const rootFacts = await lstat(absoluteRoot);
  if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink()) {
    throw new Error("HTML snippet output private stage is not a safe directory.");
  }
  let current = absoluteRoot;
  for (const part of absoluteTarget.slice(absoluteRoot.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!existing) await mkdir(current, { mode: 0o700 });
    const facts = await lstat(current);
    if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("HTML snippet output private stage contains an unsafe directory.");
  }
}

async function assertRegularHandle(handle: FileHandle, path: string): Promise<void> {
  const facts = await handle.stat();
  if (!facts.isFile()) throw new Error(`HTML snippet output destination is not a regular file: ${path}.`);
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset);
    if (bytesWritten <= 0) throw new Error("HTML snippet output write made no progress.");
    offset += bytesWritten;
  }
}

function safeRelativeFilePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const path = resolve(candidate);
  return path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}
