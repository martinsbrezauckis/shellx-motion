import { canonicalJsonSha256 } from "@shellx-motion/core";

export const HDR10_PQ_DIRECT_FINAL_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-direct-final@1" as const;
export const HDR10_PQ_DIRECT_FINAL_RECEIPT_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-direct-final-receipt@1" as const;
export const HDR10_PQ_DIRECT_FINAL_OUTPUT_FILE = "video.mp4" as const;
export const HDR10_PQ_DIRECT_FINAL_RECEIPT_FILE = "receipt.json" as const;
export const HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS = 180_000;
export const HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES = 64 * 1024;
export const HDR10_PQ_DIRECT_FINAL_MAX_PROCESS_TREE_RSS_BYTES = 2 * 1024 * 1024 * 1024;

export interface Hdr10PqDirectFinalReceipt {
  readonly schema: typeof HDR10_PQ_DIRECT_FINAL_RECEIPT_SCHEMA;
  readonly status: "passed";
  readonly lane: "private-browser-hdr10-to-software-libx265-direct-final@1";
  readonly packageId: string;
  readonly route: { readonly fingerprint: string; readonly sourceInputHashes: Readonly<Record<string, string>>; readonly sceneStateSha256: string; readonly staticFingerprint: string; readonly sdrStaticFingerprint: string; readonly frameFingerprint: string; };
  readonly browser: { readonly catalogSha256: string; readonly pipelineSha256: string; readonly producerEvidenceSha256: string; readonly rawFrameSequenceSha256: string; readonly framesRendered: 90; };
  readonly conversion: { readonly contractSha256: string; readonly sequenceFingerprint: string; readonly generatedReceiptSha256: string; readonly generatedFrameSequenceSha256: string; readonly frameCount: 90; readonly generatedYuvFrameByteLength: 2_764_800; };
  readonly command: { readonly c1InertPlanSha256: string; readonly c2TokenizedCommandSha256: string; readonly softwareEncoder: "libx265"; readonly hardware: "refused"; };
  readonly probe: { readonly querySha256: string; readonly observedJsonSha256: string; readonly observedStreamSha256: string; readonly validationFingerprint: string; };
  readonly output: { readonly file: typeof HDR10_PQ_DIRECT_FINAL_OUTPUT_FILE; readonly sha256: string; readonly byteLength: number; };
  readonly limits: { readonly maxOutputBytes: typeof HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES; readonly timeoutMs: typeof HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS; readonly maxFfprobeBytes: typeof HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES; readonly maximumProcessTreeRssBytes: typeof HDR10_PQ_DIRECT_FINAL_MAX_PROCESS_TREE_RSS_BYTES; readonly governedProcessTreeRssBytes: number; };
  readonly cleanup: { readonly browserTerminal: true; readonly encoderExitCode: 0; readonly ffprobeExitCode: 0; };
  readonly fingerprint: string;
}

export function createHdr10PqDirectFinalReceipt(value: Omit<Hdr10PqDirectFinalReceipt, "schema" | "status" | "lane" | "fingerprint">): Hdr10PqDirectFinalReceipt {
  const base = { schema: HDR10_PQ_DIRECT_FINAL_RECEIPT_SCHEMA, status: "passed" as const, lane: "private-browser-hdr10-to-software-libx265-direct-final@1" as const, ...value };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as Hdr10PqDirectFinalReceipt;
}

/** Structural parsing only: a self-consistent receipt is not package or output authority. */
export function verifyHdr10PqDirectFinalReceiptStructure(value: unknown): Hdr10PqDirectFinalReceipt {
  if (!record(value) || !keys(value, ["schema", "status", "lane", "packageId", "route", "browser", "conversion", "command", "probe", "output", "limits", "cleanup", "fingerprint"])) throw new Error("HDR10 direct-final receipt schema is invalid.");
  const receipt = value as unknown as Hdr10PqDirectFinalReceipt, { fingerprint: _fingerprint, ...base } = receipt;
  if (receipt.schema !== HDR10_PQ_DIRECT_FINAL_RECEIPT_SCHEMA || receipt.status !== "passed" || receipt.lane !== "private-browser-hdr10-to-software-libx265-direct-final@1" || !id(receipt.packageId) || !route(receipt.route) || !browser(receipt.browser) || !conversion(receipt.conversion) || !command(receipt.command) || !probe(receipt.probe) || !output(receipt.output) || !limits(receipt.limits) || !cleanup(receipt.cleanup) || !hash(receipt.fingerprint) || receipt.fingerprint !== canonicalJsonSha256(base)) throw new Error("HDR10 direct-final receipt facts are invalid.");
  return freeze(receipt);
}

function route(value: unknown): boolean { return record(value) && keys(value, ["fingerprint", "sourceInputHashes", "sceneStateSha256", "staticFingerprint", "sdrStaticFingerprint", "frameFingerprint"]) && hashes(value.fingerprint, value.sceneStateSha256, value.staticFingerprint, value.sdrStaticFingerprint, value.frameFingerprint) && record(value.sourceInputHashes) && Object.keys(value.sourceInputHashes).length >= 9 && Object.values(value.sourceInputHashes).every(hash); }
function browser(value: unknown): boolean { return record(value) && keys(value, ["catalogSha256", "pipelineSha256", "producerEvidenceSha256", "rawFrameSequenceSha256", "framesRendered"]) && hashes(value.catalogSha256, value.pipelineSha256, value.producerEvidenceSha256, value.rawFrameSequenceSha256) && value.framesRendered === 90; }
function conversion(value: unknown): boolean { return record(value) && keys(value, ["contractSha256", "sequenceFingerprint", "generatedReceiptSha256", "generatedFrameSequenceSha256", "frameCount", "generatedYuvFrameByteLength"]) && hashes(value.contractSha256, value.sequenceFingerprint, value.generatedReceiptSha256, value.generatedFrameSequenceSha256) && value.frameCount === 90 && value.generatedYuvFrameByteLength === 2_764_800; }
function command(value: unknown): boolean { return record(value) && keys(value, ["c1InertPlanSha256", "c2TokenizedCommandSha256", "softwareEncoder", "hardware"]) && hashes(value.c1InertPlanSha256, value.c2TokenizedCommandSha256) && value.softwareEncoder === "libx265" && value.hardware === "refused"; }
function probe(value: unknown): boolean { return record(value) && keys(value, ["querySha256", "observedJsonSha256", "observedStreamSha256", "validationFingerprint"]) && hashes(value.querySha256, value.observedJsonSha256, value.observedStreamSha256, value.validationFingerprint); }
function output(value: unknown): boolean { return record(value) && keys(value, ["file", "sha256", "byteLength"]) && value.file === HDR10_PQ_DIRECT_FINAL_OUTPUT_FILE && hash(value.sha256) && integer(value.byteLength, 1, HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES); }
function limits(value: unknown): boolean { return record(value) && keys(value, ["maxOutputBytes", "timeoutMs", "maxFfprobeBytes", "maximumProcessTreeRssBytes", "governedProcessTreeRssBytes"]) && value.maxOutputBytes === HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES && value.timeoutMs === HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS && value.maxFfprobeBytes === HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES && value.maximumProcessTreeRssBytes === HDR10_PQ_DIRECT_FINAL_MAX_PROCESS_TREE_RSS_BYTES && integer(value.governedProcessTreeRssBytes, 64 * 1024 * 1024, HDR10_PQ_DIRECT_FINAL_MAX_PROCESS_TREE_RSS_BYTES); }
function cleanup(value: unknown): boolean { return record(value) && keys(value, ["browserTerminal", "encoderExitCode", "ffprobeExitCode"]) && value.browserTerminal === true && value.encoderExitCode === 0 && value.ffprobeExitCode === 0; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function hashes(...values: readonly unknown[]): boolean { return values.every(hash); }
function id(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value); }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
