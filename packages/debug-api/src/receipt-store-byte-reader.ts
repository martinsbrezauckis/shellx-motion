/** Byte-exact, bounded receipt reads shared by stable and direct no-follow readers. */
import type { FileHandle } from "node:fs/promises";
import { MAX_DEBUG_RECEIPT_BYTES } from "./receipt-store-limits.js";

/**
 * Decode evidence only when the text round-trips to the exact admitted bytes. String-mode reads can
 * silently replace malformed sequences, which makes a later hash describe a different file.
 */
export function decodeCanonicalReceiptUtf8(bytes: Buffer): string | null {
  try {
    // Keep a BOM as U+FEFF, so re-encoding cannot silently omit it before JSON rejects the text.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return Buffer.from(text, "utf8").equals(bytes) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Read only the size admitted from the opened inode, then prove no byte appeared beyond it. This
 * avoids an unbounded whole-file read if a same-inode writer appends after the size check.
 */
export async function readCappedReceiptBytes(handle: FileHandle, admittedSize: number): Promise<Buffer | null> {
  if (!Number.isSafeInteger(admittedSize) || admittedSize < 0 || admittedSize > MAX_DEBUG_RECEIPT_BYTES) return null;
  const bytes = Buffer.allocUnsafe(admittedSize);
  for (let offset = 0; offset < bytes.byteLength;) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (read.bytesRead === 0) return null;
    offset += read.bytesRead;
  }
  // A bounded one-byte probe distinguishes the admitted file from a same-inode append without
  // allocating or consuming the appended payload.
  const probe = Buffer.alloc(1);
  return (await handle.read(probe, 0, probe.byteLength, admittedSize)).bytesRead === 0 ? bytes : null;
}
