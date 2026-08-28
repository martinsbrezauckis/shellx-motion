import { canonicalJsonSha256 } from "./canonical-json";

/** Private HDR10/PQ overlay for the authenticated static glTF PBR final route. */
export const SCENE3D_GLTF_PBR_HDR10_ADMISSION_SCHEMA = "shellx-motion/scene3d-gltf-pbr-hdr10-admission@1" as const;
export const SCENE3D_GLTF_PBR_HDR10_STATIC_PLAN_SCHEMA = "shellx-motion/scene3d-gltf-pbr-hdr10-static@1" as const;
export const SCENE3D_GLTF_PBR_HDR10_ABI = "shellx-motion/browser-scene3d-gltf-pbr-hdr10@1" as const;

export const HDR10_VIEWPORT = Object.freeze({ width: 1280, height: 720, fps: 30, durationMs: 3_000 } as const);
export const HDR10_REFERENCE_WHITE_NITS = 203;
export const HDR10_CLAMP_NITS = 1_000;
export const HDR10_PQ_REFERENCE_NITS = 10_000;
export const HDR10_RGBA16FLOAT_BYTES_PER_PIXEL = 8;
export const HDR10_RGBA16FLOAT_BYTES_PER_ROW = HDR10_VIEWPORT.width * HDR10_RGBA16FLOAT_BYTES_PER_PIXEL;
export const HDR10_RGBA16FLOAT_BYTES = HDR10_RGBA16FLOAT_BYTES_PER_ROW * HDR10_VIEWPORT.height;
export const HDR10_DEPTH_BYTES = HDR10_VIEWPORT.width * HDR10_VIEWPORT.height * 4;
export const HDR10_YUV420P10LE_BYTES = HDR10_VIEWPORT.width * HDR10_VIEWPORT.height * 3;
export const HDR10_MAX_STATIC_GPU_BYTES = 48 * 1024 * 1024;
export const HDR10_MAX_PEAK_GPU_BYTES = 72 * 1024 * 1024;
export const HDR10_MAX_READBACK_CHUNK_BYTES = 64 * 1024;

/** Linear-light matrix derived from the D65 sRGB/BT.709 and BT.2020 primaries. */
export const LINEAR_SRGB_D65_TO_REC2020_D65 = Object.freeze([
  Object.freeze([0.627403896, 0.329283038, 0.043313066]),
  Object.freeze([0.069097289, 0.919540395, 0.011362316]),
  Object.freeze([0.016391439, 0.088013308, 0.895595253]),
] as const);

/** SMPTE ST 2084 / BT.2100 PQ constants, applied to nits divided by 10,000. */
export const HDR10_PQ = Object.freeze({
  m1: 0.1593017578125,
  m2: 78.84375,
  c1: 0.8359375,
  c2: 18.8515625,
  c3: 18.6875,
  referenceNits: HDR10_PQ_REFERENCE_NITS,
} as const);

export const SCENE3D_GLTF_PBR_HDR10_ADMISSION = Object.freeze({
  schema: SCENE3D_GLTF_PBR_HDR10_ADMISSION_SCHEMA,
  inheritedRoute: "shellx-motion/scene3d-gltf-pbr-final-route@1",
  abi: SCENE3D_GLTF_PBR_HDR10_ABI,
  viewport: HDR10_VIEWPORT,
  eligibility: Object.freeze({ scene: "static-immutable-canonical-source-projection", alpha: "decoded-rgba-alpha-255" }),
  source: Object.freeze({ primaries: "srgb-d65", transfer: "linear", textureFormat: "rgba8unorm-srgb", toWorkingMatrix: LINEAR_SRGB_D65_TO_REC2020_D65 }),
  working: Object.freeze({ primaries: "rec2020-d65", transfer: "linear", unit: "nits", referenceWhiteNits: HDR10_REFERENCE_WHITE_NITS, clampNits: HDR10_CLAMP_NITS, targetFormat: "rgba16float" }),
  readback: Object.freeze({ format: "rgba16float-le", bytesPerPixel: HDR10_RGBA16FLOAT_BYTES_PER_PIXEL, bytesPerRow: HDR10_RGBA16FLOAT_BYTES_PER_ROW, byteLength: HDR10_RGBA16FLOAT_BYTES, maxChunkBytes: HDR10_MAX_READBACK_CHUNK_BYTES }),
  output: Object.freeze({ transfer: "smpte2084", pq: HDR10_PQ, primaries: "bt2020", matrix: "bt2020nc", range: "tv", pixelFormat: "yuv420p10le", frameByteLength: HDR10_YUV420P10LE_BYTES, encoder: "libx265", encoderClass: "software-only", profile: "main10", container: "mp4", codecTag: "hvc1", masteringDisplay: "G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)", contentLight: "not-signaled", ffmpegSignal: Object.freeze({ colorPrimaries: "bt2020", colorTransfer: "smpte2084", colorSpace: "bt2020nc", colorRange: "tv", x265Params: "hdr10=1:repeat-headers=1:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)" }) }),
  resources: Object.freeze({ maxStaticGpuBytes: HDR10_MAX_STATIC_GPU_BYTES, rgba16floatTargetBytes: HDR10_RGBA16FLOAT_BYTES, depthTargetBytes: HDR10_DEPTH_BYTES, rgba16floatReadbackBytes: HDR10_RGBA16FLOAT_BYTES, maxPeakGpuBytes: HDR10_MAX_PEAK_GPU_BYTES, noRetainedRawFrames: true }),
  refusals: Object.freeze(["no-hdr-marker", "non-opaque-base-color", "browser-preview", "native", "segmented-or-resume-final", "hardware-encoding", "generic-color-path", "ocio", "icc", "tone-map-selection"]),
} as const);

export type Scene3dGltfPbrHdr10Admission = typeof SCENE3D_GLTF_PBR_HDR10_ADMISSION;
export const SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT = canonicalJsonSha256(SCENE3D_GLTF_PBR_HDR10_ADMISSION);

/** Converts non-negative linear sRGB values to clamped Rec.2020 linear nits. */
export function linearSrgbD65ToRec2020Nits(value: readonly [number, number, number]): readonly [number, number, number] {
  if (value.some((channel) => !Number.isFinite(channel) || channel < 0)) throw new Error("HDR10 source RGB must contain finite non-negative linear values.");
  return Object.freeze(LINEAR_SRGB_D65_TO_REC2020_D65.map((row) => Math.min(HDR10_CLAMP_NITS, HDR10_REFERENCE_WHITE_NITS * (row[0] * value[0] + row[1] * value[1] + row[2] * value[2]))) as [number, number, number]);
}

/** Encodes a finite Rec.2020 linear-nits channel after the fixed 1,000-nit clamp. */
export function rec2020NitsToPq(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > HDR10_CLAMP_NITS) throw new Error("HDR10 PQ input must be finite and within the fixed 0..1000-nit range.");
  if (value === 0) return 0;
  const normalized = value / HDR10_PQ.referenceNits;
  const power = normalized ** HDR10_PQ.m1;
  return ((HDR10_PQ.c1 + HDR10_PQ.c2 * power) / (1 + HDR10_PQ.c3 * power)) ** HDR10_PQ.m2;
}
