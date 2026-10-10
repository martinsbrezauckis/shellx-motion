import type { FileHandle } from "node:fs/promises";
import type { DerivedOutputPublication } from "@shellx-motion/core";
import { LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES } from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import {
  LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA,
  type LinearSrgbSdrFinalPrivateOutputAdoption,
} from "./streaming-final-adapter-types.js";
import {
  assertPinnedHeldLeaf,
  hashHeldLeaf,
  sameHeldFacts,
  type HeldFileFacts,
  type HeldLeaf,
} from "./linear-srgb-sdr-final-held-media-files.js";

type HeldMediaCloser = Readonly<{ close(): Promise<void> }>;
const CHUNK_BYTES = 64 * 1024;

type HeldMediaPublicationInput = Readonly<{
  root: FileHandle;
  rootIdentity: HeldFileFacts;
  source: HeldLeaf;
  sourceFacts: Readonly<{ sha256: string; byteLength: number; identity: HeldFileFacts }>;
  publication: DerivedOutputPublication;
}>;

/** Copies the held verified source through the only Core publication writer authority. */
export async function copyHeldMediaToPublication(input: HeldMediaPublicationInput): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const { root, rootIdentity, source, sourceFacts: expected, publication } = input;
  await assertPinnedHeldLeaf(root, rootIdentity, source, "Strict SDR held-media source before Core staging");
  const writer = await publication.createPrivateFileChunkWriter({ label: "Strict linear-sRGB SDR held-media output", maxBytes: LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES });
  let writerClosed = false;
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let offset = 0; offset < expected.byteLength;) {
      const wanted = Math.min(buffer.byteLength, expected.byteLength - offset);
      const { bytesRead } = await source.handle.read(buffer, 0, wanted, offset);
      if (bytesRead !== wanted) throw new Error("Strict SDR held-media source shortened during Core staging.");
      await writer.writeChunk(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await writer.close();
    writerClosed = true;
    const staged = await publication.verifyIncrementalPrivateFile({ label: "Strict linear-sRGB SDR held-media output", maxBytes: LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES });
    const after = await hashHeldLeaf(root, rootIdentity, source, LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES, "Strict SDR held-media source after Core staging");
    if (staged.sha256 !== expected.sha256 || staged.byteLength !== expected.byteLength
      || after.sha256 !== expected.sha256 || after.byteLength !== expected.byteLength || !sameHeldFacts(after.identity, expected.identity)) {
      throw new Error("Strict SDR held-media source and Core private stage did not preserve one exact identity.");
    }
    return Object.freeze({ sha256: staged.sha256, byteLength: staged.byteLength });
  } catch (error) {
    return await rethrowHeldMediaPublicationFailure(error, writerClosed, async () => await publication.abandonPrivateFileChunkWriter());
  }
}

/** Closes held private media after Core publication without discarding a primary failure. */
export async function closeHeldMediaAfterPublication<T>(
  heldMedia: HeldMediaCloser,
  operation: () => Promise<T>,
): Promise<T> {
  let primary: unknown;
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    primary = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      await heldMedia.close();
    } catch (cleanupError) {
      if (operationFailed) {
        throw new AggregateError(
          [primary, cleanupError],
          `Strict SDR held-media publication failed (${errorText(primary)}) and its private cleanup retained uncertainty (${errorText(cleanupError)}).`,
        );
      }
      throw cleanupError;
    }
  }
}

/** Bind the verified held source to the exact Core publication stage. */
export function privateHeldMediaOutputAdoption(
  verifiedOutput: { readonly sha256: string; readonly byteLength: number },
  privatePublicationStage: { readonly sha256: string; readonly byteLength: number },
): LinearSrgbSdrFinalPrivateOutputAdoption {
  if (verifiedOutput.sha256 !== privatePublicationStage.sha256 || verifiedOutput.byteLength !== privatePublicationStage.byteLength) {
    throw new Error("Strict linear-sRGB SDR private publication stage did not preserve the verified output identity.");
  }
  return Object.freeze({
    schema: LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA,
    verifiedOutput: Object.freeze({ sha256: verifiedOutput.sha256, byteLength: verifiedOutput.byteLength }),
    privatePublicationStage: Object.freeze({ sha256: privatePublicationStage.sha256, byteLength: privatePublicationStage.byteLength }),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Relative-module test seam for Core chunk-writer failure and cleanup propagation. */
export async function rethrowHeldMediaPublicationFailureForTest(
  primary: unknown,
  writerClosed: boolean,
  abandon: () => Promise<void>,
): Promise<never> {
  return await rethrowHeldMediaPublicationFailure(primary, writerClosed, abandon);
}

async function rethrowHeldMediaPublicationFailure(
  primary: unknown,
  writerClosed: boolean,
  abandon: () => Promise<void>,
): Promise<never> {
  if (!writerClosed) {
    try {
      await abandon();
    } catch (cleanupError) {
      throw new AggregateError([primary, cleanupError], "Strict SDR held-media Core staging failed and its writer cleanup retained uncertainty.");
    }
  }
  throw primary;
}
