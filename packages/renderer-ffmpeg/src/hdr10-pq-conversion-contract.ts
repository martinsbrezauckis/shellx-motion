import { SCENE3D_GLTF_PBR_HDR10_ADMISSION } from "@shellx-motion/core/internal/scene3d-gltf-pbr-hdr10-final";

const admission = SCENE3D_GLTF_PBR_HDR10_ADMISSION;
const width = admission.viewport.width, height = admission.viewport.height;

/** Private CPU bridge for the accepted HDR PBR route; it is not an FFmpeg dispatch. */
export const HDR10_PQ_CONVERSION_CONTRACT = Object.freeze({
  schema: "shellx-motion/ffmpeg-hdr10-pq-conversion@2",
  source: Object.freeze({ schema: "shellx-motion/browser-scene3d-gltf-pbr-hdr10-readback@1", width, height, byteOrder: "ieee754-binary16-le", bytesPerRow: admission.readback.bytesPerRow, byteLength: admission.readback.byteLength, working: admission.working }),
  output: Object.freeze({ pixelFormat: admission.output.pixelFormat, width, height, byteLength: admission.output.frameByteLength, primaries: admission.output.primaries, transfer: admission.output.transfer, matrix: admission.output.matrix, range: admission.output.range }),
  pq: admission.output.pq,
  // BT.2100 locates the 4:2:0 lattice at the first luma sample. This bridge averages each 2x2
  // nonlinear Cb/Cr footprint, then records that top-left lattice rather than claiming point sampling.
  ycbcr: Object.freeze({ kr: 0.2627, kg: 0.678, kb: 0.0593, cbDenominator: 1.8814, crDenominator: 1.4746, quantization: "itu-bt2100-narrow-10bit-round-half-up@1", chromaSampling: "420-top-left-co-sited-grid-2x2-box-average@1" }),
  signaling: Object.freeze({ chromaLocation: "topleft", masteringDisplay: admission.output.masteringDisplay, masteringDisplayFfprobe: Object.freeze({ side_data_type: "Mastering display metadata", red_x: "35400/50000", red_y: "14600/50000", green_x: "8500/50000", green_y: "39850/50000", blue_x: "6550/50000", blue_y: "2300/50000", white_point_x: "15635/50000", white_point_y: "16450/50000", min_luminance: "1/10000", max_luminance: "10000000/10000" }) }),
  frame: Object.freeze({ frameCount: admission.viewport.fps * admission.viewport.durationMs / 1000, maxInputBytes: admission.readback.byteLength, maxOutputBytes: admission.output.frameByteLength, maxWorkUnits: width * height * 4, maxChunkBytes: admission.readback.maxChunkBytes, exactChunks: Math.ceil(admission.output.frameByteLength / admission.readback.maxChunkBytes), transientSnapshotBytes: admission.readback.byteLength, maxTransientBridgeBytes: admission.readback.byteLength + admission.readback.maxChunkBytes * 2, retainedRawBytes: 0, retainedYuvBytes: 0 }),
} as const);

export const HDR10_PQ_CONVERSION_SCHEMA = HDR10_PQ_CONVERSION_CONTRACT.schema;
export const HDR10_PQ_CONVERSION_RECEIPT_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-conversion-receipt@2" as const;
export const HDR10_PQ_CONVERSION_SEQUENCE_SCHEMA = "shellx-motion/ffmpeg-hdr10-pq-conversion-sequence@2" as const;

export interface Hdr10PqReadback {
  readonly schema: typeof HDR10_PQ_CONVERSION_CONTRACT.source.schema;
  readonly staticFingerprint: string;
  readonly sdrStaticFingerprint: string;
  readonly frameFingerprint: string;
  readonly frameIndex: number;
  readonly rawRgba16floatSha256: string;
  readonly width: typeof HDR10_PQ_CONVERSION_CONTRACT.source.width;
  readonly height: typeof HDR10_PQ_CONVERSION_CONTRACT.source.height;
  readonly bytesPerRow: typeof HDR10_PQ_CONVERSION_CONTRACT.source.bytesPerRow;
  readonly byteOrder: typeof HDR10_PQ_CONVERSION_CONTRACT.source.byteOrder;
  readonly rgba16float: Uint8Array;
}

export interface Hdr10PqConversionReceipt {
  readonly schema: typeof HDR10_PQ_CONVERSION_RECEIPT_SCHEMA;
  readonly contractSha256: string;
  readonly staticFingerprint: string;
  readonly sdrStaticFingerprint: string;
  readonly frameFingerprint: string;
  readonly frameIndex: number;
  readonly inputRgba16floatSha256: string;
  readonly generatedYuv420p10leSha256: string;
  readonly generatedFrame: { readonly pixelFormat: "yuv420p10le"; readonly width: typeof width; readonly height: typeof height; readonly byteLength: typeof admission.output.frameByteLength; readonly persistence: "not-established-in-c1"; };
  readonly processing: { readonly verifiedInputPixels: number; readonly conversionWorkUnits: number; readonly generatedChunks: typeof HDR10_PQ_CONVERSION_CONTRACT.frame.exactChunks; readonly maxChunkBytes: number; readonly transientSnapshotBytes: typeof HDR10_PQ_CONVERSION_CONTRACT.frame.transientSnapshotBytes; readonly maxTransientBridgeBytes: typeof HDR10_PQ_CONVERSION_CONTRACT.frame.maxTransientBridgeBytes; readonly retainedRawBytes: 0; readonly retainedYuvBytes: 0; };
  readonly fingerprint: string;
}

export interface Hdr10PqConversionSequence {
  readonly schema: typeof HDR10_PQ_CONVERSION_SEQUENCE_SCHEMA;
  readonly contractSha256: string;
  readonly staticFingerprint: string;
  readonly sdrStaticFingerprint: string;
  readonly frameFingerprint: string;
  readonly frameCount: typeof HDR10_PQ_CONVERSION_CONTRACT.frame.frameCount;
  readonly generatedYuvFrameByteLength: typeof admission.output.frameByteLength;
  readonly generatedReceiptSha256: string;
  readonly generatedFrameSequenceSha256: string;
  readonly fingerprint: string;
}

/**
 * Computation-only observation point. The observer may drop every generated chunk; neither this
 * callback nor its receipt proves persistence, a process pipe, or launch authority. C2 owns that
 * durable host boundary.
 */
export type Hdr10PqGeneratedChunkObserver = (chunk: Uint8Array) => void;

/**
 * C2 may await a host-owned pipe handoff one bounded chunk at a time. This is
 * still computation-only: resolving this callback never establishes durable
 * storage or grants process-launch authority.
 */
export type Hdr10PqAsyncGeneratedChunkObserver = (chunk: Uint8Array) => Promise<void>;
