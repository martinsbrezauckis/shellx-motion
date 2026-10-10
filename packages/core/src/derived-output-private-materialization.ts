/** Core-only descriptor-pinned renderer materialization for a file publication. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { captureOutputDirectoryIdentity, assertOutputDirectoryIdentity, type OutputPathIdentity } from "./output-path-topology";
import { stableRegularFile } from "./derived-output-publication-private";
import { DerivedOutputPublicationError, type DerivedFilePublicationEvidence } from "./derived-output-publication-types";
import { publicationError } from "./derived-output-publication-admission";
import { writeVerifiedBoundedFile } from "./stable-file-read";
import { DerivedOutputPrivateChunkWriterState, verifyIncrementalChunkWriterEvidence, type DerivedOutputPrivateVerification } from "./derived-output-private-chunk-writer";
type PrivateCompanionDirectory = { purpose: "browser-capture-html"; path: string; identity: OutputPathIdentity; writing?: boolean; file?: { path: string; identity: OutputPathIdentity } };
export interface DerivedOutputPrivateChunkWriter { writeChunk(bytes: Uint8Array): Promise<void>; close(): Promise<void>; }
type VerifiedPrivateFile = DerivedOutputPrivateVerification;
/** Core-owned callbacks retain the private topology, lock, and stage identity. */
export class DerivedOutputPrivateMaterialization {
  #privateCompanionDirectory: PrivateCompanionDirectory | undefined;
  #chunkWriter: DerivedOutputPrivateChunkWriterState | undefined;
  #openingChunkWriter: Promise<DerivedOutputPrivateChunkWriter> | undefined;
  #verifiedPrivateFile: VerifiedPrivateFile | undefined;
  constructor(private readonly input: {
    stagingPath: string;
    lockPath: string;
    stageIdentity: OutputPathIdentity;
    stageLinkCount: number | undefined;
    /** Cheap descriptor/topology check used by streamed writes; it must not hash the whole file. */
    assertWriterCurrent: () => Promise<void>;
    assertCurrent: () => Promise<void>;
  }) {}
  async writeFile(bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || bytes.byteLength > options.maxBytes) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} exceeds the ${options.maxBytes}-byte per-file limit.`, this.input.stagingPath);
    }
    this.#verifiedPrivateFile = undefined; await this.input.assertWriterCurrent();
    const handle = await open(this.input.stagingPath, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await this.assertOpenedStage(handle);
      // A descriptor-held recheck refuses replacement before its write can be trusted.
      await this.input.assertWriterCurrent();
      await this.assertOpenedStage(handle);
      if ((await handle.stat()).size !== 0) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} staging must be empty before renderer materialization.`, this.input.stagingPath);
      }
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesWritten === 0) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} could not be written.`, this.input.stagingPath);
        offset += bytesWritten;
      }
      await this.assertOpenedStage(handle);
    } finally {
      await handle.close();
    }
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const verified = await this.verifyBoundedFile({ ...options, requireNonEmpty: false });
    if (verified.byteLength !== bytes.byteLength || verified.sha256 !== expectedSha256) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its staged bytes were verified.`, this.input.stagingPath);
    }
    return verified;
  }
  /** Open one private writer; chunks never become a media-sized Core Buffer. */
  async createChunkWriter(options: { label: string; maxBytes: number }): Promise<DerivedOutputPrivateChunkWriter> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} has an invalid stream byte limit.`, this.input.stagingPath);
    }
    if (this.#chunkWriter || this.#openingChunkWriter) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} private stream writer is already open or closed.`, this.input.stagingPath);
    const opening = this.openChunkWriter(options);
    this.#openingChunkWriter = opening;
    try { return await opening; } finally { if (this.#openingChunkWriter === opening) this.#openingChunkWriter = undefined; }
  }
  private async openChunkWriter(options: { label: string; maxBytes: number }): Promise<DerivedOutputPrivateChunkWriter> {
    this.#verifiedPrivateFile = undefined;
    const state = await DerivedOutputPrivateChunkWriterState.open({
      stagingPath: this.input.stagingPath, label: options.label, maxBytes: options.maxBytes,
      assertWriterCurrent: this.input.assertWriterCurrent,
      assertOpenedStage: async (handle) => await this.assertOpenedStage(handle)
    });
    this.#chunkWriter = state;
    return Object.freeze({
      writeChunk: async (bytes: Uint8Array): Promise<void> => {
        if (this.#chunkWriter !== state) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} stream writer is no longer active.`, this.input.stagingPath);
        this.#verifiedPrivateFile = undefined;
        await state.writeChunk(bytes);
      },
      close: async (): Promise<void> => {
        if (this.#chunkWriter !== state) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} stream writer is no longer active.`, this.input.stagingPath);
        await state.close();
      }
    });
  }
  async assertChunkWriterClosed(): Promise<void> {
    const writer = this.#chunkWriter;
    if (!writer || !writer.closed || writer.abandoned || !writer.digest || writer.byteLength < 2) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output private stream must be closed with at least two bytes before verification.", this.input.stagingPath);
    }
  }
  async abandonChunkWriter(): Promise<void> {
    // Wait before lock release so an opened descriptor cannot become untracked.
    await this.#openingChunkWriter?.catch(() => undefined);
    const writer = this.#chunkWriter;
    if (!writer || writer.closed) return;
    await writer.abandon();
  }
  async syncBoundedFile(options: { label: string; maxBytes: number }): Promise<void> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} has an invalid byte limit.`, this.input.stagingPath);
    }
    await this.assertChunkWriterClosedIfPresent();
    await this.input.assertWriterCurrent();
    const handle = await open(this.input.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.assertOpenedStage(handle);
      const facts = await handle.stat();
      if (!Number.isSafeInteger(facts.size) || facts.size < 2 || facts.size > options.maxBytes) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} exceeds the ${options.maxBytes}-byte per-file limit.`, this.input.stagingPath);
      }
      await handle.sync();
      await this.assertOpenedStage(handle);
      await this.input.assertWriterCurrent();
    } finally {
      await handle.close();
    }
  }
  async readFile(options: { label: string; maxBytes: number }): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} has an invalid byte limit.`, this.input.stagingPath);
    }
    await this.input.assertWriterCurrent();
    const handle = await open(this.input.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      await this.assertOpenedStage(handle);
      const before = await handle.stat();
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > options.maxBytes) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} exceeds the ${options.maxBytes}-byte per-file limit.`, this.input.stagingPath);
      }
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesRead === 0) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} ended before its stable size.`, this.input.stagingPath);
        offset += bytesRead;
      }
      await this.assertOpenedStage(handle);
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its private bytes were read.`, this.input.stagingPath);
      }
      await this.input.assertWriterCurrent();
      await this.assertOpenedStage(handle);
    } finally {
      await handle.close();
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const verified = await this.verifyBoundedFile({ label: options.label, maxBytes: options.maxBytes, requireNonEmpty: false });
    if (verified.byteLength !== bytes.byteLength || verified.sha256 !== sha256) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its private bytes were verified.`, this.input.stagingPath);
    }
    return Object.freeze({ bytes, sha256, byteLength: bytes.byteLength });
  }
  /** Verify large private media through a no-follow descriptor with a fixed-size hash buffer. */
  async verifyBoundedFile(options: { label: string; maxBytes: number; requireNonEmpty?: boolean; additionalLinks?: number }): Promise<DerivedFilePublicationEvidence> {
    const minimumBytes = options.requireNonEmpty === false ? 0 : 2;
    const additionalLinks = options.additionalLinks ?? 0;
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < minimumBytes || !Number.isSafeInteger(additionalLinks) || additionalLinks < 0) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} has an invalid byte limit.`, this.input.stagingPath);
    }
    await this.assertChunkWriterClosedIfPresent();
    await this.input.assertWriterCurrent();
    const handle = await open(this.input.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let digest: string;
    let byteLength: number;
    try {
      await this.assertOpenedStage(handle, additionalLinks);
      const before = await handle.stat();
      if (!Number.isSafeInteger(before.size) || before.size < minimumBytes || before.size > options.maxBytes) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} exceeds the ${options.maxBytes}-byte per-file limit.`, this.input.stagingPath);
      }
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset);
        if (bytesRead === 0) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} ended before its stable size.`, this.input.stagingPath);
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      await this.assertOpenedStage(handle, additionalLinks);
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its private bytes were verified.`, this.input.stagingPath);
      }
      await this.input.assertWriterCurrent();
      await this.assertOpenedStage(handle, additionalLinks);
      digest = hash.digest("hex");
      byteLength = offset;
      this.#verifiedPrivateFile = Object.freeze({ sha256: digest, byteLength, dev: Number(after.dev), ino: Number(after.ino), mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, nlink: after.nlink });
    } finally {
      await handle.close();
    }
    if (this.#chunkWriter && (this.#chunkWriter.abandoned || !this.#chunkWriter.digest || this.#chunkWriter.digest !== digest)) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} was not successfully finalized with its incremental stream digest.`, this.input.stagingPath);
    return Object.freeze({ sha256: digest!, byteLength: byteLength! });
  }
  /** Admit closed stream evidence; V1 takes its one full descriptor pass at link time. */
  async verifyIncrementalChunkWriterEvidence(options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> {
    await this.assertChunkWriterClosed();
    const writer = this.#chunkWriter!;
    const verified = await verifyIncrementalChunkWriterEvidence({
      stagingPath: this.input.stagingPath, label: options.label, maxBytes: options.maxBytes,
      assertWriterCurrent: this.input.assertWriterCurrent,
      assertOpenedStage: async (handle) => await this.assertOpenedStage(handle)
    }, writer);
    this.#verifiedPrivateFile = verified;
    return Object.freeze({ sha256: verified.sha256, byteLength: verified.byteLength });
  }
  /** Recheck immutable bounded evidence by descriptor facts without rehashing large media. */
  async withVerifiedFile<T>(expected: DerivedFilePublicationEvidence, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    const cached = this.#verifiedPrivateFile;
    if (!cached || cached.sha256 !== expected.sha256 || cached.byteLength !== expected.byteLength) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output has no matching bounded private verification.", this.input.stagingPath);
    await this.input.assertWriterCurrent();
    const handle = await open(this.input.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.assertVerifiedHandle(handle, cached);
      const value = await operation(handle);
      await this.assertVerifiedHandle(handle, cached);
      await this.input.assertWriterCurrent();
      return value;
    } finally { await handle.close(); }
  }
  /** Recheck cached bounded evidence by descriptor facts only; no second whole-file hash. */
  async assertVerifiedFileIdentity(expected: DerivedFilePublicationEvidence, additionalLinks = 0): Promise<DerivedOutputPrivateVerification> {
    const cached = this.#verifiedPrivateFile;
    if (!cached || cached.sha256 !== expected.sha256 || cached.byteLength !== expected.byteLength || !Number.isSafeInteger(additionalLinks) || additionalLinks < 0) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output has no matching bounded private verification.", this.input.stagingPath);
    }
    await this.input.assertWriterCurrent();
    const handle = await open(this.input.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await this.assertVerifiedHandle(handle, cached, additionalLinks, additionalLinks > 0);
      // link(2) changes ctime; retain its exact new descriptor identity thereafter.
      if (current.nlink !== cached.nlink || current.ctimeMs !== cached.ctimeMs) {
        this.#verifiedPrivateFile = Object.freeze({
          sha256: cached.sha256, byteLength: cached.byteLength,
          dev: Number(current.dev), ino: Number(current.ino),
          mtimeMs: Number(current.mtimeMs), ctimeMs: Number(current.ctimeMs), nlink: Number(current.nlink)
        });
      }
      await this.input.assertWriterCurrent();
      return this.#verifiedPrivateFile!;
    } finally { await handle.close(); }
  }
  async createCompanionDirectory(purpose: "browser-capture-html"): Promise<string> {
    if (this.#privateCompanionDirectory) {
      if (this.#privateCompanionDirectory.purpose !== purpose) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output publication already owns a different private companion root.", this.input.stagingPath);
      }
      await this.assertCompanionDirectory(this.#privateCompanionDirectory);
      return this.#privateCompanionDirectory.path;
    }
    await this.input.assertWriterCurrent();
    const path = join(this.input.lockPath, `.shellx-motion-${purpose}-${randomUUID()}`);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      throw publicationError("derived_output_stage_invalid", path, error);
    }
    const companion: PrivateCompanionDirectory = {
      purpose,
      path,
      identity: await captureOutputDirectoryIdentity(path, "Final output private companion root", { private: true })
    };
    try {
      await this.assertCompanionDirectory(companion);
      this.#privateCompanionDirectory = companion;
      return path;
    } catch (error) {
      await assertOutputDirectoryIdentity(path, companion.identity, "Final output private companion root", { private: true })
        .then(async () => await rmdir(path))
        .catch(() => undefined);
      throw error;
    }
  }
  async writeCompanionFile(path: string, bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> {
    const companion = this.#privateCompanionDirectory;
    const destination = resolve(path);
    if (!companion || dirname(destination) !== resolve(companion.path)) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Browser private file companion must be a direct child of its Core-created companion root.", destination);
    }
    if (companion.file || companion.writing) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output publication already materialized its private companion evidence leaf.", destination);
    }
    await this.assertCompanionDirectory(companion);
    companion.writing = true;
    try {
      const written = await writeVerifiedBoundedFile(destination, bytes, {
        label: options.label,
        maxBytes: options.maxBytes,
        withinRoot: companion.path
      });
      const facts = await stableRegularFile(destination, options.label);
      await this.assertCompanionDirectory(companion);
      if (written.sha256 !== facts.sha256 || written.byteLength !== facts.size) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its private companion bytes were verified.`, destination);
      }
      companion.file = { path: destination, identity: { dev: facts.dev, ino: facts.ino } };
      return { sha256: facts.sha256, byteLength: facts.size };
    } finally {
      companion.writing = false;
    }
  }
  async removeCompanionDirectory(): Promise<void> {
    const companion = this.#privateCompanionDirectory;
    if (!companion) return;
    await this.assertCompanionDirectory(companion);
    if (companion.file) {
      await stableRegularFile(companion.file.path, "Final output private companion evidence", companion.file.identity);
      await unlink(companion.file.path);
    }
    await this.assertCompanionDirectory(companion);
    await rmdir(companion.path);
    this.#privateCompanionDirectory = undefined;
  }
  private async assertOpenedStage(handle: FileHandle, additionalLinks = 0): Promise<void> {
    const facts = await handle.stat();
    if (!facts.isFile()
      || Number(facts.dev) !== this.input.stageIdentity.dev
      || Number(facts.ino) !== this.input.stageIdentity.ino
      || (this.input.stageLinkCount !== undefined && facts.nlink !== this.input.stageLinkCount + additionalLinks)) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output staging descriptor no longer names Core's identity-bound private file.", this.input.stagingPath);
    }
  }
  private async assertChunkWriterClosedIfPresent(): Promise<void> {
    if (this.#chunkWriter) await this.assertChunkWriterClosed();
  }
  private async assertVerifiedHandle(handle: FileHandle, expected: VerifiedPrivateFile, additionalLinks = 0, allowExpectedLinkTransition = false): Promise<Awaited<ReturnType<FileHandle["stat"]>>> {
    await this.assertOpenedStage(handle, additionalLinks);
    const facts = await handle.stat();
    const linkedExactlyOnce = allowExpectedLinkTransition && facts.nlink === expected.nlink + 1;
    if (facts.size !== expected.byteLength || facts.mtimeMs !== expected.mtimeMs || (!linkedExactlyOnce && facts.ctimeMs !== expected.ctimeMs) || Number(facts.dev) !== expected.dev || Number(facts.ino) !== expected.ino || (!linkedExactlyOnce && facts.nlink !== expected.nlink)) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output changed after bounded private verification.", this.input.stagingPath);
    }
    return facts;
  }
  private async assertCompanionDirectory(companion: PrivateCompanionDirectory): Promise<void> {
    await this.input.assertCurrent();
    await assertOutputDirectoryIdentity(companion.path, companion.identity, "Final output private companion root", { private: true });
  }
}
