import { canonicalJsonSha256 } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import {
  HDR10_PQ_CONVERSION_CONTRACT,
  HDR10_PQ_CONVERSION_RECEIPT_SCHEMA,
  HDR10_PQ_CONVERSION_SEQUENCE_SCHEMA,
  type Hdr10PqConversionReceipt,
  type Hdr10PqConversionSequence,
  type Hdr10PqAsyncGeneratedChunkObserver,
  type Hdr10PqGeneratedChunkObserver,
  type Hdr10PqReadback,
} from "./hdr10-pq-conversion-contract.js";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTRACT_SHA256 = canonicalJsonSha256(HDR10_PQ_CONVERSION_CONTRACT);
const { width: WIDTH, height: HEIGHT, byteLength: INPUT_BYTES, bytesPerRow: INPUT_ROW } = HDR10_PQ_CONVERSION_CONTRACT.source;
const { byteLength: OUTPUT_BYTES } = HDR10_PQ_CONVERSION_CONTRACT.output;
const PIXELS = WIDTH * HEIGHT, CHUNK = HDR10_PQ_CONVERSION_CONTRACT.frame.maxChunkBytes;
const COMPUTED_RECEIPTS = new WeakSet<object>();
const COMPUTED_SEQUENCES = new WeakSet<object>();

/** Computes a snapshot of one Browser-owned float frame and non-durably observes its bounded chunks. */
export function convertHdr10PqReadback(value: unknown, observer: Hdr10PqGeneratedChunkObserver): Hdr10PqConversionReceipt {
  if (typeof observer !== "function") throw new Error("HDR10 conversion requires a generated-chunk observer.");
  const { input, bytes, inputRgba16floatSha256 } = snapshot(value);
  const writer = new ChunkWriter(observer);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) writer.u16(luma(bytes, y * INPUT_ROW + x * 8));
  for (let y = 0; y < HEIGHT; y += 2) for (let x = 0; x < WIDTH; x += 2) writer.u16(chroma(bytes, x, y, false));
  for (let y = 0; y < HEIGHT; y += 2) for (let x = 0; x < WIDTH; x += 2) writer.u16(chroma(bytes, x, y, true));
  return receipt(input, inputRgba16floatSha256, writer.finish(), writer.chunks);
}

/**
 * Computes the same C1 bytes while awaiting each bounded observation in order.
 * The observer is deliberately not a durability acknowledgement; C2 verifies
 * the encoder output independently after process completion.
 */
export async function convertHdr10PqReadbackAsync(value: unknown, observer: Hdr10PqAsyncGeneratedChunkObserver): Promise<Hdr10PqConversionReceipt> {
  if (typeof observer !== "function") throw new Error("HDR10 conversion requires an async generated-chunk observer.");
  const { input, bytes, inputRgba16floatSha256 } = snapshot(value);
  const writer = new AsyncChunkWriter(observer);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) await writer.u16(luma(bytes, y * INPUT_ROW + x * 8));
  for (let y = 0; y < HEIGHT; y += 2) for (let x = 0; x < WIDTH; x += 2) await writer.u16(chroma(bytes, x, y, false));
  for (let y = 0; y < HEIGHT; y += 2) for (let x = 0; x < WIDTH; x += 2) await writer.u16(chroma(bytes, x, y, true));
  return receipt(input, inputRgba16floatSha256, await writer.finish(), writer.chunks);
}

function snapshot(value: unknown) {
  const input = readback(value), bytes = Uint8Array.from(input.rgba16float), inputRgba16floatSha256 = sha(bytes);
  if (inputRgba16floatSha256 !== input.rawRgba16floatSha256) throw new Error("HDR10 readback bytes do not match their claimed SHA-256.");
  verifyPixels(bytes);
  return { input, bytes, inputRgba16floatSha256 };
}

function receipt(input: Hdr10PqReadback, inputRgba16floatSha256: string, generatedYuv420p10leSha256: string, chunks: number): Hdr10PqConversionReceipt {
  const base = {
    schema: HDR10_PQ_CONVERSION_RECEIPT_SCHEMA, contractSha256: CONTRACT_SHA256,
    staticFingerprint: input.staticFingerprint, sdrStaticFingerprint: input.sdrStaticFingerprint,
    frameFingerprint: input.frameFingerprint, frameIndex: input.frameIndex,
    inputRgba16floatSha256, generatedYuv420p10leSha256,
    generatedFrame: { pixelFormat: "yuv420p10le" as const, width: WIDTH, height: HEIGHT, byteLength: OUTPUT_BYTES, persistence: "not-established-in-c1" as const },
    processing: { verifiedInputPixels: PIXELS, conversionWorkUnits: PIXELS * 4, generatedChunks: chunks, maxChunkBytes: CHUNK, transientSnapshotBytes: INPUT_BYTES, maxTransientBridgeBytes: INPUT_BYTES + CHUNK * 2, retainedRawBytes: 0 as const, retainedYuvBytes: 0 as const },
  };
  const receipt = freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Hdr10PqConversionReceipt;
  COMPUTED_RECEIPTS.add(receipt);
  return receipt;
}

/** Aggregates only small immutable conversion receipts; source or converted frame bytes are never retained. */
export function createHdr10PqConversionSequence(value: unknown): Hdr10PqConversionSequence {
  if (!Array.isArray(value) || value.length !== HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount) throw new Error("HDR10 final requires exactly the fixed static frame count.");
  const receipts = value.map((entry) => { if (!isHdr10PqConversionReceipt(entry) || !COMPUTED_RECEIPTS.has(entry)) throw new Error("HDR10 conversion receipt lacks private deterministic-computation proof."); return entry; });
  const first = receipts[0]!;
  if (receipts.some((entry, index) => entry.frameIndex !== index || entry.staticFingerprint !== first.staticFingerprint || entry.sdrStaticFingerprint !== first.sdrStaticFingerprint || entry.frameFingerprint !== first.frameFingerprint)) throw new Error("HDR10 conversion receipts do not form one ordered immutable frame sequence.");
  const generatedReceiptSha256 = canonicalJsonSha256(receipts.map((entry) => entry.fingerprint));
  const generatedFrameSequenceSha256 = canonicalJsonSha256(receipts.map((entry) => entry.generatedYuv420p10leSha256));
  const base = { schema: HDR10_PQ_CONVERSION_SEQUENCE_SCHEMA, contractSha256: CONTRACT_SHA256, staticFingerprint: first.staticFingerprint, sdrStaticFingerprint: first.sdrStaticFingerprint, frameFingerprint: first.frameFingerprint, frameCount: HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount, generatedYuvFrameByteLength: OUTPUT_BYTES, generatedReceiptSha256, generatedFrameSequenceSha256 };
  const sequence = freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Hdr10PqConversionSequence;
  COMPUTED_SEQUENCES.add(sequence);
  return sequence;
}

/** Internal non-serializable proof that deterministic conversion actually ran; it does not prove persistence. */
export function hasHdr10PqConversionExecutionProof(value: unknown): value is Hdr10PqConversionSequence {
  return isHdr10PqConversionSequence(value) && COMPUTED_SEQUENCES.has(value);
}

export function isHdr10PqConversionSequence(value: unknown): value is Hdr10PqConversionSequence {
  if (!record(value) || !keys(value, ["schema", "contractSha256", "staticFingerprint", "sdrStaticFingerprint", "frameFingerprint", "frameCount", "generatedYuvFrameByteLength", "generatedReceiptSha256", "generatedFrameSequenceSha256", "fingerprint"])) return false;
  const sequence = value as unknown as Hdr10PqConversionSequence, { fingerprint: _fingerprint, ...base } = sequence;
  return sequence.schema === HDR10_PQ_CONVERSION_SEQUENCE_SCHEMA && sequence.contractSha256 === CONTRACT_SHA256 && hashes(sequence.staticFingerprint, sequence.sdrStaticFingerprint, sequence.frameFingerprint, sequence.generatedReceiptSha256, sequence.generatedFrameSequenceSha256, sequence.fingerprint) && sequence.frameCount === HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount && sequence.generatedYuvFrameByteLength === OUTPUT_BYTES && sequence.fingerprint === canonicalJsonSha256(base);
}

export function isHdr10PqConversionReceipt(value: unknown): value is Hdr10PqConversionReceipt {
  if (!record(value) || !keys(value, ["schema", "contractSha256", "staticFingerprint", "sdrStaticFingerprint", "frameFingerprint", "frameIndex", "inputRgba16floatSha256", "generatedYuv420p10leSha256", "generatedFrame", "processing", "fingerprint"])) return false;
  const receipt = value as unknown as Hdr10PqConversionReceipt, generatedFrame = receipt.generatedFrame, processing = receipt.processing;
  const { fingerprint: _fingerprint, ...base } = receipt;
  return receipt.schema === HDR10_PQ_CONVERSION_RECEIPT_SCHEMA && receipt.contractSha256 === CONTRACT_SHA256 && hashes(receipt.staticFingerprint, receipt.sdrStaticFingerprint, receipt.frameFingerprint, receipt.inputRgba16floatSha256, receipt.generatedYuv420p10leSha256, receipt.fingerprint) && integer(receipt.frameIndex, 0, HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount - 1) && !!generatedFrame && keys(generatedFrame, ["pixelFormat", "width", "height", "byteLength", "persistence"]) && generatedFrame.pixelFormat === "yuv420p10le" && generatedFrame.width === WIDTH && generatedFrame.height === HEIGHT && generatedFrame.byteLength === OUTPUT_BYTES && generatedFrame.persistence === "not-established-in-c1" && !!processing && keys(processing, ["verifiedInputPixels", "conversionWorkUnits", "generatedChunks", "maxChunkBytes", "transientSnapshotBytes", "maxTransientBridgeBytes", "retainedRawBytes", "retainedYuvBytes"]) && processing.verifiedInputPixels === PIXELS && processing.conversionWorkUnits === PIXELS * 4 && processing.generatedChunks === HDR10_PQ_CONVERSION_CONTRACT.frame.exactChunks && processing.maxChunkBytes === CHUNK && processing.transientSnapshotBytes === INPUT_BYTES && processing.maxTransientBridgeBytes === INPUT_BYTES + CHUNK * 2 && processing.retainedRawBytes === 0 && processing.retainedYuvBytes === 0 && receipt.fingerprint === canonicalJsonSha256(base);
}

function readback(value: unknown): Hdr10PqReadback {
  if (!record(value) || !keys(value, ["schema", "staticFingerprint", "sdrStaticFingerprint", "frameFingerprint", "frameIndex", "rawRgba16floatSha256", "width", "height", "bytesPerRow", "byteOrder", "rgba16float"])) throw new Error("HDR10 readback schema is invalid.");
  const input = value as unknown as Hdr10PqReadback;
  if (input.schema !== HDR10_PQ_CONVERSION_CONTRACT.source.schema || !hashes(input.staticFingerprint, input.sdrStaticFingerprint, input.frameFingerprint, input.rawRgba16floatSha256) || !integer(input.frameIndex, 0, HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount - 1) || input.width !== WIDTH || input.height !== HEIGHT || input.bytesPerRow !== INPUT_ROW || input.byteOrder !== "ieee754-binary16-le" || !(input.rgba16float instanceof Uint8Array) || input.rgba16float.byteLength !== INPUT_BYTES) throw new Error("HDR10 readback does not match the fixed admitted float-frame contract.");
  return input;
}

function verifyPixels(bytes: Uint8Array): void {
  for (let offset = 0; offset < INPUT_BYTES; offset += 8) {
    if (u16(bytes, offset + 6) !== 0x3c00) throw new Error("HDR10 readback alpha must be exactly opaque binary16 one.");
    for (let channel = 0; channel < 3; channel += 1) { const value = half(bytes, offset + channel * 2); if (!Number.isFinite(value) || value < 0 || value > HDR10_PQ_CONVERSION_CONTRACT.source.working.clampNits) throw new Error("HDR10 readback contains non-finite or out-of-range linear nits."); }
  }
}

function luma(bytes: Uint8Array, offset: number): number { const r = pq(half(bytes, offset)), g = pq(half(bytes, offset + 2)), b = pq(half(bytes, offset + 4)), y = HDR10_PQ_CONVERSION_CONTRACT.ycbcr.kr * r + HDR10_PQ_CONVERSION_CONTRACT.ycbcr.kg * g + HDR10_PQ_CONVERSION_CONTRACT.ycbcr.kb * b; return code(64 + 876 * y, 64, 940); }
function chroma(bytes: Uint8Array, x: number, y: number, red: boolean): number { let sum = 0; for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) { const offset = (y + dy) * INPUT_ROW + (x + dx) * 8, r = pq(half(bytes, offset)), g = pq(half(bytes, offset + 2)), b = pq(half(bytes, offset + 4)), yy = HDR10_PQ_CONVERSION_CONTRACT.ycbcr.kr * r + HDR10_PQ_CONVERSION_CONTRACT.ycbcr.kg * g + HDR10_PQ_CONVERSION_CONTRACT.ycbcr.kb * b; sum += (red ? r - yy : b - yy) / (red ? HDR10_PQ_CONVERSION_CONTRACT.ycbcr.crDenominator : HDR10_PQ_CONVERSION_CONTRACT.ycbcr.cbDenominator); } return code(512 + 896 * sum / 4, 64, 960); }
function pq(nits: number): number { if (nits === 0) return 0; const p = (nits / HDR10_PQ_CONVERSION_CONTRACT.pq.referenceNits) ** HDR10_PQ_CONVERSION_CONTRACT.pq.m1; return ((HDR10_PQ_CONVERSION_CONTRACT.pq.c1 + HDR10_PQ_CONVERSION_CONTRACT.pq.c2 * p) / (1 + HDR10_PQ_CONVERSION_CONTRACT.pq.c3 * p)) ** HDR10_PQ_CONVERSION_CONTRACT.pq.m2; }
function code(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.floor(value + 0.5))); }
function u16(bytes: Uint8Array, offset: number): number { return bytes[offset]! | bytes[offset + 1]! << 8; }
function half(bytes: Uint8Array, offset: number): number { const bits = u16(bytes, offset), sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 0x1f, fraction = bits & 0x3ff; if (exponent === 0x1f) return Number.NaN; return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15)); }
function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function hashes(...values: readonly unknown[]): boolean { return values.every((value) => typeof value === "string" && SHA256.test(value)); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }

class ChunkWriter {
  readonly hash = createHash("sha256"); buffer = new Uint8Array(CHUNK); offset = 0; bytes = 0; chunks = 0;
  constructor(readonly observer: Hdr10PqGeneratedChunkObserver) {}
  u16(value: number): void { if (this.offset === CHUNK) this.flush(true); this.buffer[this.offset] = value & 0xff; this.buffer[this.offset + 1] = value >> 8; this.offset += 2; this.bytes += 2; }
  finish(): string { this.flush(false); if (this.bytes !== OUTPUT_BYTES || this.chunks !== HDR10_PQ_CONVERSION_CONTRACT.frame.exactChunks) throw new Error("HDR10 conversion output exceeded its fixed frame ceiling."); return this.hash.digest("hex"); }
  private flush(replenish: boolean): void { if (this.offset === 0) return; const chunk = this.offset === CHUNK ? this.buffer : this.buffer.slice(0, this.offset); this.hash.update(chunk); this.buffer = replenish ? new Uint8Array(CHUNK) : new Uint8Array(0); this.offset = 0; this.observer(chunk); this.chunks += 1; }
}

class AsyncChunkWriter {
  readonly hash = createHash("sha256"); buffer = new Uint8Array(CHUNK); offset = 0; bytes = 0; chunks = 0;
  constructor(readonly observer: Hdr10PqAsyncGeneratedChunkObserver) {}
  async u16(value: number): Promise<void> { if (this.offset === CHUNK) await this.flush(true); this.buffer[this.offset] = value & 0xff; this.buffer[this.offset + 1] = value >> 8; this.offset += 2; this.bytes += 2; }
  async finish(): Promise<string> { await this.flush(false); if (this.bytes !== OUTPUT_BYTES || this.chunks !== HDR10_PQ_CONVERSION_CONTRACT.frame.exactChunks) throw new Error("HDR10 conversion output exceeded its fixed frame ceiling."); return this.hash.digest("hex"); }
  private async flush(replenish: boolean): Promise<void> { if (this.offset === 0) return; const chunk = this.offset === CHUNK ? this.buffer : this.buffer.slice(0, this.offset); this.hash.update(chunk); this.buffer = replenish ? new Uint8Array(CHUNK) : new Uint8Array(0); this.offset = 0; await this.observer(chunk); this.chunks += 1; }
}
