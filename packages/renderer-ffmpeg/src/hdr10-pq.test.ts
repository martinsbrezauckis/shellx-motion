import { canonicalJsonSha256 } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HDR10_PQ_CONVERSION_CONTRACT, type Hdr10PqConversionReceipt, type Hdr10PqConversionSequence } from "./hdr10-pq-conversion-contract.js";
import { convertHdr10PqReadback, convertHdr10PqReadbackAsync, createHdr10PqConversionSequence, isHdr10PqConversionReceipt, isHdr10PqConversionSequence } from "./hdr10-pq-conversion.js";
import { createHdr10PqFfmpegCommand, HDR10_PQ_FFMPEG_OUTPUT_TOKEN } from "./hdr10-pq-ffmpeg-command.js";
import { HDR10_PQ_FFPROBE_QUERY, verifyHdr10PqFfprobeReadback } from "./hdr10-pq-ffprobe.js";

const HASH = "a".repeat(64);

describe("private HDR10 PQ FFmpeg C1 leaves", () => {
  it("verifies an opaque binary16 Rec.2020-nits frame and emits bounded deterministic yuv420p10le", () => {
    const output: Buffer[] = [], receipt = convertHdr10PqReadback(readback(0x63d0), (chunk) => { output.push(Buffer.from(chunk)); }), yuv = Buffer.concat(output);
    expect(receipt).toMatchObject({ generatedFrame: { pixelFormat: "yuv420p10le", width: 1280, height: 720, byteLength: 2_764_800, persistence: "not-established-in-c1" }, processing: { verifiedInputPixels: 921_600, conversionWorkUnits: 3_686_400, generatedChunks: 43, maxChunkBytes: 65_536, transientSnapshotBytes: 7_372_800, maxTransientBridgeBytes: 7_503_872, retainedRawBytes: 0, retainedYuvBytes: 0 } });
    expect(Object.isFrozen(receipt)).toBe(true); expect(isHdr10PqConversionReceipt(receipt)).toBe(true);
    expect(output.slice(0, -1).every((chunk) => chunk.byteLength === 65_536 && chunk.byteLength % 2 === 0)).toBe(true); expect(output.at(-1)!.byteLength).toBe(12_288); expect(yuv.byteLength).toBe(2_764_800);
    expect(yuv.readUInt16LE(0)).toBe(723); expect(yuv.readUInt16LE(1280 * 720 * 2)).toBe(512); expect(yuv.readUInt16LE(1280 * 720 * 2 + 640 * 360 * 2)).toBe(512);
    expect(receipt.generatedYuv420p10leSha256).toBe(hash(yuv));
    const mixed: Buffer[] = [], mixedInput = mutate(readback(0), (bytes) => bytes.writeUInt16LE(0x63d0, 0));
    convertHdr10PqReadback(mixedInput, (chunk) => { mixed.push(Buffer.from(chunk)); });
    const mixedYuv = Buffer.concat(mixed), chroma = 1280 * 720 * 2;
    expect(mixedYuv.readUInt16LE(0)).toBe(237); expect(mixedYuv.readUInt16LE(chroma)).toBe(488); expect(mixedYuv.readUInt16LE(chroma + 640 * 360 * 2)).toBe(596);

    const mutableSource = readback(0), sourceSha256 = mutableSource.rawRgba16floatSha256, snapshotOutput: Buffer[] = [];
    const snapshotReceipt = convertHdr10PqReadback(mutableSource, (chunk) => { snapshotOutput.push(Buffer.from(chunk)); mutableSource.rgba16float.fill(0xff); });
    const snapshotYuv = Buffer.concat(snapshotOutput);
    expect(snapshotReceipt.inputRgba16floatSha256).toBe(sourceSha256); expect(snapshotYuv.readUInt16LE((1280 * 720 - 1) * 2)).toBe(64); expect(snapshotYuv.readUInt16LE(chroma)).toBe(512);
  });

  it("refuses stale hashes, non-opaque/invalid half floats, odd dimensions, and non-HDR schemas before emitting any chunk", () => {
    for (const invalid of [
      { ...readback(0), rawRgba16floatSha256: "b".repeat(64) },
      mutate(readback(0), (bytes) => bytes.writeUInt16LE(0, 6)),
      mutate(readback(0), (bytes) => bytes.writeUInt16LE(0x7c00, 0)),
      { ...readback(0), width: 1279 },
      { ...readback(0), schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-sdr-readback@1" },
    ]) {
      let chunks = 0;
      expect(() => convertHdr10PqReadback(invalid, () => { chunks += 1; })).toThrow(); expect(chunks).toBe(0);
    }
  });

  it("treats observed chunks as non-durable and fails only when observation throws", () => {
    let calls = 0;
    const dropped = convertHdr10PqReadback(readback(0), () => { calls += 1; });
    expect(calls).toBe(43); expect(dropped.generatedFrame.persistence).toBe("not-established-in-c1");
    expect(() => convertHdr10PqReadback(readback(0), () => { throw new Error("observer unavailable"); })).toThrow("observer unavailable");
    const admitted = receipt(0);
    expect(isHdr10PqConversionReceipt({ ...admitted, generatedYuv420p10leSha256: "f".repeat(64) })).toBe(false);
    expect(isHdr10PqConversionReceipt({ ...admitted, processing: { ...admitted.processing, generatedChunks: 42 } })).toBe(false);
  });

  it("awaits every async observation without upgrading it to persistence evidence", async () => {
    const chunks: Buffer[] = [], receipt = await convertHdr10PqReadbackAsync(readback(0), async (chunk) => { chunks.push(Buffer.from(chunk)); });
    expect(chunks).toHaveLength(43); expect(Buffer.concat(chunks)).toHaveLength(2_764_800);
    expect(receipt.generatedFrame.persistence).toBe("not-established-in-c1");
    await expect(convertHdr10PqReadbackAsync(readback(0), async () => { throw new Error("pipe closed"); })).rejects.toThrow("pipe closed");
  }, 120_000);

  it("refuses caller-minted receipt/sequence evidence as inert-plan computation proof", () => {
    const mintedReceipts = Array.from({ length: 90 }, (_, index) => receipt(index));
    expect(isHdr10PqConversionReceipt(mintedReceipts[0])).toBe(true);
    expect(() => createHdr10PqConversionSequence(mintedReceipts)).toThrow("lacks private deterministic-computation proof");
    const mintedSequence = receiptSequence(mintedReceipts);
    expect(isHdr10PqConversionSequence(mintedSequence)).toBe(true);
    expect(() => createHdr10PqFfmpegCommand(mintedSequence)).toThrow("private proof");
  });

  it("requires the exact 90-frame computation proof and produces an inert software-only plan", () => {
    const sequence = admittedSequence();
    const command = createHdr10PqFfmpegCommand(sequence);
    expect(sequence).toMatchObject({ frameCount: 90, generatedYuvFrameByteLength: 2_764_800 });
    expect(() => createHdr10PqConversionSequence([receipt(0)])).toThrow();
    expect(command.command).toEqual(expect.objectContaining({ executable: "ffmpeg", shell: false, deferredOutputToken: HDR10_PQ_FFMPEG_OUTPUT_TOKEN, launch: "forbidden-no-c2-durable-pipe" }));
    expect(command.command.args).toEqual(expect.arrayContaining(["-c:v", "libx265", "-profile:v", "main10", "-tag:v", "hvc1", "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv", "-chroma_sample_location", "topleft", HDR10_PQ_FFMPEG_OUTPUT_TOKEN]));
    expect(command.command.args[command.command.args.indexOf("-x265-params") + 1]).toBe("hdr10=1:repeat-headers=1:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)");
    expect(command.receipt).toMatchObject({ durablePipe: "not-established-in-c1", launchAuthority: "absent", plannedOutput: { hardware: "refused", segmentedOrResume: "refused", color: { chromaLocation: "topleft" }, masteringDisplay: "G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)" } });
  }, 120_000);

  it("strictly verifies only the queried Main 10 hvc1 limited-range BT.2020 PQ ffprobe response", () => {
    const command = createHdr10PqFfmpegCommand(admittedSequence());
    const probe = ffprobe();
    expect(verifyHdr10PqFfprobeReadback(command, probe)).toMatchObject({ commandFingerprint: command.fingerprint, conversionSequenceFingerprint: command.receipt.generatedInput.fingerprint, querySha256: canonicalJsonSha256(HDR10_PQ_FFPROBE_QUERY), fileExistence: "not-established-in-c1", launchAuthority: "absent" });
    expect(verifyHdr10PqFfprobeReadback(command, { ...probe, streams: [{ ...probe.streams[0]!, color_range: "pc" }] })).toBeUndefined();
    expect(verifyHdr10PqFfprobeReadback(command, { ...probe, streams: [{ ...probe.streams[0]!, chroma_location: "left" }] })).toBeUndefined();
    expect(verifyHdr10PqFfprobeReadback(command, { ...probe, streams: [{ ...probe.streams[0]!, side_data_list: [{ ...probe.streams[0]!.side_data_list[0], max_luminance: "1000/1" }] }] })).toBeUndefined();
    expect(verifyHdr10PqFfprobeReadback(command, { ...probe, streams: [{ ...probe.streams[0]!, unexpected: "field" }] })).toBeUndefined();
  });

  it("keeps raw frame bytes and process launch outside receipts and pure C1 source", () => {
    const receiptValue = receipt(0), command = createHdr10PqFfmpegCommand(admittedSequence());
    expect(Object.keys(receiptValue)).not.toContain("rgba16float"); expect(JSON.stringify(command)).not.toContain("spawn");
    expect([convertHdr10PqReadback, createHdr10PqFfmpegCommand, verifyHdr10PqFfprobeReadback].map(String).join("\n")).not.toMatch(/console\.(?:debug|error|info|log|warn)|child_process|spawn\(/);
  });
});

let admitted: Hdr10PqConversionSequence | undefined;
function readback(rgb: number, frameIndex = 0) { const bytes = Buffer.alloc(7_372_800); for (let offset = 0; offset < bytes.length; offset += 8) { bytes.writeUInt16LE(rgb, offset); bytes.writeUInt16LE(rgb, offset + 2); bytes.writeUInt16LE(rgb, offset + 4); bytes.writeUInt16LE(0x3c00, offset + 6); } return { schema: "shellx-motion/browser-scene3d-gltf-pbr-hdr10-readback@1" as const, staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), frameIndex, rawRgba16floatSha256: hash(bytes), width: 1280 as const, height: 720 as const, bytesPerRow: 10240 as const, byteOrder: "ieee754-binary16-le" as const, rgba16float: bytes }; }
function mutate(value: ReturnType<typeof readback>, mutateBytes: (bytes: Buffer) => void) { const bytes = Buffer.from(value.rgba16float); mutateBytes(bytes); return { ...value, rgba16float: bytes, rawRgba16floatSha256: hash(bytes) }; }
function receipt(frameIndex: number): Hdr10PqConversionReceipt { const base = { schema: "shellx-motion/ffmpeg-hdr10-pq-conversion-receipt@2" as const, contractSha256: canonicalJsonSha256(HDR10_PQ_CONVERSION_CONTRACT), staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), frameIndex, inputRgba16floatSha256: "d".repeat(64), generatedYuv420p10leSha256: "e".repeat(64), generatedFrame: { pixelFormat: "yuv420p10le" as const, width: 1280 as const, height: 720 as const, byteLength: 2_764_800 as const, persistence: "not-established-in-c1" as const }, processing: { verifiedInputPixels: 921_600, conversionWorkUnits: 3_686_400, generatedChunks: 43 as const, maxChunkBytes: 65_536, transientSnapshotBytes: 7_372_800 as const, maxTransientBridgeBytes: 7_503_872 as const, retainedRawBytes: 0 as const, retainedYuvBytes: 0 as const } }; return { ...base, fingerprint: canonicalJsonSha256(base) }; }
function receiptSequence(receipts: readonly Hdr10PqConversionReceipt[]): Hdr10PqConversionSequence { const base = { schema: "shellx-motion/ffmpeg-hdr10-pq-conversion-sequence@2" as const, contractSha256: canonicalJsonSha256(HDR10_PQ_CONVERSION_CONTRACT), staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), frameCount: 90 as const, generatedYuvFrameByteLength: 2_764_800 as const, generatedReceiptSha256: canonicalJsonSha256(receipts.map((entry) => entry.fingerprint)), generatedFrameSequenceSha256: canonicalJsonSha256(receipts.map((entry) => entry.generatedYuv420p10leSha256)) }; return { ...base, fingerprint: canonicalJsonSha256(base) }; }
function admittedSequence(): Hdr10PqConversionSequence { if (admitted) return admitted; const source = readback(0); admitted = createHdr10PqConversionSequence(Array.from({ length: 90 }, (_, frameIndex) => convertHdr10PqReadback({ ...source, frameIndex }, () => {}))); return admitted; }
function ffprobe() { return { streams: [{ codec_name: "hevc", profile: "Main 10", codec_tag_string: "hvc1", pix_fmt: "yuv420p10le", width: 1280, height: 720, color_range: "tv", color_space: "bt2020nc", color_transfer: "smpte2084", color_primaries: "bt2020", chroma_location: "topleft", r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "90", nb_frames: "90", side_data_list: [{ side_data_type: "Mastering display metadata", red_x: "35400/50000", red_y: "14600/50000", green_x: "8500/50000", green_y: "39850/50000", blue_x: "6550/50000", blue_y: "2300/50000", white_point_x: "15635/50000", white_point_y: "16450/50000", min_luminance: "1/10000", max_luminance: "10000000/10000" }] }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }; }
function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
