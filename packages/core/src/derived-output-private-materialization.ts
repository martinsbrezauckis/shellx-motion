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

type PrivateCompanionDirectory = {
  purpose: "browser-capture-html";
  path: string;
  identity: OutputPathIdentity;
  writing?: boolean;
  file?: { path: string; identity: OutputPathIdentity };
};

/**
 * This state object is allocated only by DerivedOutputPublication. Its callbacks retain the
 * publication's private topology, lock, and stage-identity checks; no caller can manufacture an
 * equivalent structural capability or choose a companion root.
 */
export class DerivedOutputPrivateMaterialization {
  #privateCompanionDirectory: PrivateCompanionDirectory | undefined;

  constructor(private readonly input: {
    stagingPath: string;
    lockPath: string;
    stageIdentity: OutputPathIdentity;
    stageLinkCount: number | undefined;
    assertCurrent: () => Promise<void>;
    verifyFile: () => Promise<DerivedFilePublicationEvidence>;
  }) {}

  async writeFile(bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || bytes.byteLength > options.maxBytes) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} exceeds the ${options.maxBytes}-byte per-file limit.`, this.input.stagingPath);
    }
    await this.input.assertCurrent();
    const handle = await open(this.input.stagingPath, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await this.assertOpenedStage(handle);
      // Reverify the pathname while the descriptor is held. A replacement cannot be truncated:
      // it either fails this identity check or is no longer the descriptor's original inode.
      await this.input.assertCurrent();
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
    const verified = await this.input.verifyFile();
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (verified.byteLength !== bytes.byteLength || verified.sha256 !== expectedSha256) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its staged bytes were verified.`, this.input.stagingPath);
    }
    return verified;
  }

  async readFile(options: { label: string; maxBytes: number }): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} has an invalid byte limit.`, this.input.stagingPath);
    }
    await this.input.assertCurrent();
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
      await this.input.assertCurrent();
      await this.assertOpenedStage(handle);
    } finally {
      await handle.close();
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const verified = await this.input.verifyFile();
    if (verified.byteLength !== bytes.byteLength || verified.sha256 !== sha256) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${options.label} changed while its private bytes were verified.`, this.input.stagingPath);
    }
    return Object.freeze({ bytes, sha256, byteLength: bytes.byteLength });
  }

  async createCompanionDirectory(purpose: "browser-capture-html"): Promise<string> {
    if (this.#privateCompanionDirectory) {
      if (this.#privateCompanionDirectory.purpose !== purpose) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output publication already owns a different private companion root.", this.input.stagingPath);
      }
      await this.assertCompanionDirectory(this.#privateCompanionDirectory);
      return this.#privateCompanionDirectory.path;
    }
    await this.input.assertCurrent();
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

  /** Delete only the Core-recorded leaf and exact private root; unknown content retains the lock. */
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

  private async assertOpenedStage(handle: FileHandle): Promise<void> {
    const facts = await handle.stat();
    if (!facts.isFile()
      || Number(facts.dev) !== this.input.stageIdentity.dev
      || Number(facts.ino) !== this.input.stageIdentity.ino
      || (this.input.stageLinkCount !== undefined && facts.nlink !== this.input.stageLinkCount)) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output staging descriptor no longer names Core's identity-bound private file.", this.input.stagingPath);
    }
  }

  private async assertCompanionDirectory(companion: PrivateCompanionDirectory): Promise<void> {
    await this.input.assertCurrent();
    await assertOutputDirectoryIdentity(companion.path, companion.identity, "Final output private companion root", { private: true });
  }
}
