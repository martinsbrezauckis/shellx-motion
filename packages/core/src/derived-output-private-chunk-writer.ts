/** Descriptor-owned bounded chunk writer used by private derived-output materialization. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { DerivedOutputPublicationError, type DerivedFilePublicationEvidence } from "./derived-output-publication-types";

const MAX_STREAM_CHUNK_BYTES = 1024 * 1024;

export type DerivedOutputPrivateVerification = Readonly<DerivedFilePublicationEvidence & {
  dev: number; ino: number; mtimeMs: number; ctimeMs: number; nlink: number;
}>;

export class DerivedOutputPrivateChunkWriterState {
  readonly hash = createHash("sha256");
  digest: string | undefined;
  byteLength = 0;
  closed = false;
  abandoned = false;

  private constructor(
    readonly handle: FileHandle,
    readonly label: string,
    readonly maxBytes: number,
    private readonly stagePath: string,
    private readonly assertWriterCurrent: () => Promise<void>,
    private readonly assertOpenedStage: (handle: FileHandle) => Promise<void>
  ) {}

  static async open(input: {
    stagingPath: string;
    label: string;
    maxBytes: number;
    assertWriterCurrent(): Promise<void>;
    assertOpenedStage(handle: FileHandle): Promise<void>;
  }): Promise<DerivedOutputPrivateChunkWriterState> {
    await input.assertWriterCurrent();
    const handle = await open(input.stagingPath, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await input.assertOpenedStage(handle);
      if ((await handle.stat()).size !== 0) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${input.label} staging must be empty before streamed materialization.`, input.stagingPath);
      }
      return new DerivedOutputPrivateChunkWriterState(handle, input.label, input.maxBytes, input.stagingPath, input.assertWriterCurrent, input.assertOpenedStage);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async writeChunk(bytes: Uint8Array): Promise<void> {
    if (this.closed || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_STREAM_CHUNK_BYTES
      || !Number.isSafeInteger(this.byteLength + bytes.byteLength) || this.byteLength + bytes.byteLength > this.maxBytes) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${this.label} stream chunk is invalid, exceeds its aggregate bound, or was written after closure.`, this.stagePath);
    }
    await this.assertWriterCurrent();
    await this.assertOpenedStage(this.handle);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await this.handle.write(bytes, offset, bytes.byteLength - offset, this.byteLength + offset);
      if (bytesWritten === 0) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${this.label} stream chunk could not be written.`, this.stagePath);
      offset += bytesWritten;
    }
    await this.assertOpenedStage(this.handle);
    this.hash.update(bytes);
    this.byteLength += bytes.byteLength;
  }

  async close(): Promise<void> {
    if (this.closed) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${this.label} stream writer is already closed.`, this.stagePath);
    try {
      await this.assertWriterCurrent();
      await this.assertOpenedStage(this.handle);
      if (this.byteLength < 2) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${this.label} stream must contain at least two bytes.`, this.stagePath);
      if ((await this.handle.stat()).size !== this.byteLength) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${this.label} stream changed while it was closed.`, this.stagePath);
      this.digest = this.hash.digest("hex");
    } finally {
      this.closed = true;
      await this.handle.close();
    }
  }

  async abandon(): Promise<void> {
    if (this.closed) return;
    this.abandoned = true;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
  }
}

/** Capture descriptor facts for an already-closed incremental stream without rereading media. */
export async function verifyIncrementalChunkWriterEvidence(input: {
  stagingPath: string;
  label: string;
  maxBytes: number;
  assertWriterCurrent(): Promise<void>;
  assertOpenedStage(handle: FileHandle): Promise<void>;
}, writer: DerivedOutputPrivateChunkWriterState): Promise<DerivedOutputPrivateVerification> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 2 || !writer.closed || writer.abandoned || !writer.digest || writer.byteLength < 2) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${input.label} changed after its incremental stream accounting.`, input.stagingPath);
  }
  await input.assertWriterCurrent();
  const handle = await open(input.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await input.assertOpenedStage(handle);
    const facts = await handle.stat();
    if (!Number.isSafeInteger(facts.size) || facts.size !== writer.byteLength || facts.size > input.maxBytes) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${input.label} changed after its incremental stream accounting.`, input.stagingPath);
    }
    await input.assertWriterCurrent();
    await input.assertOpenedStage(handle);
    return Object.freeze({ sha256: writer.digest, byteLength: writer.byteLength, dev: Number(facts.dev), ino: Number(facts.ino), mtimeMs: facts.mtimeMs, ctimeMs: facts.ctimeMs, nlink: facts.nlink });
  } finally { await handle.close(); }
}
