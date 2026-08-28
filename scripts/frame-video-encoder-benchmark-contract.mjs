import { createHash } from "node:crypto";

export const FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/frame-video-encoder-benchmark-contract@1",
  width: 320,
  height: 180,
  frameCount: 60,
  rate: Object.freeze({ numerator: 30, denominator: 1 }),
  codec: "vp9",
  container: "webm",
  quality: Object.freeze({ mode: "constant-quantizer", quantizer: 32, fallbackBitrate: 1_000_000 }),
  cases: Object.freeze([
    Object.freeze({ id: "opaque", alpha: "discard", preset: "webm-vp9", pixelFormat: "yuv420p" }),
    Object.freeze({ id: "alpha", alpha: "keep", preset: "webm-vp9-alpha", pixelFormat: "yuva420p" }),
  ]),
  candidate: Object.freeze({
    name: "mediabunny",
    version: "1.55.2",
    license: "MPL-2.0",
    packageIntegrity: "sha512-EEx4O6qYddAdCyWPMZNDwI7uc5hewNHrPAf9jLcVhIbXoPsiqNQ+D9i1pfadmGkjN2V318jSrZljkpoziYm6Lg==",
    packageShasum: "878a623407abed1860f92f1ba7376e60dbecbd37",
  }),
  maxCandidateOutputBytes: 64 * 1024 * 1024,
  maxTimestampDriftUs: 1_000,
});

const SDR_BT709_OUTPUT_ARGS = Object.freeze([
  "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-color_range", "tv",
]);

export function frameTimestampUs(frameIndex, contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  assertFrameIndex(frameIndex, contract);
  return Number(BigInt(frameIndex) * BigInt(contract.rate.denominator) * 1_000_000n / BigInt(contract.rate.numerator));
}

export function frameDurationUs(frameIndex, contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  assertFrameIndex(frameIndex, contract);
  const current = frameTimestampUs(frameIndex, contract);
  const next = Number(BigInt(frameIndex + 1) * BigInt(contract.rate.denominator) * 1_000_000n / BigInt(contract.rate.numerator));
  return next - current;
}

export function createSyntheticFrameSet(caseId, contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  const benchmarkCase = contract.cases.find((entry) => entry.id === caseId);
  if (!benchmarkCase) throw new Error(`Unknown frame-video encoder benchmark case: ${caseId}.`);
  const frameBytes = contract.width * contract.height * 4;
  const bytes = Buffer.allocUnsafe(frameBytes * contract.frameCount);
  const frameSha256 = [];
  for (let frameIndex = 0; frameIndex < contract.frameCount; frameIndex += 1) {
    const frame = bytes.subarray(frameIndex * frameBytes, (frameIndex + 1) * frameBytes);
    fillFrame(frame, frameIndex, benchmarkCase.alpha === "keep", contract.width, contract.height);
    frameSha256.push(sha256(frame));
  }
  return Object.freeze({
    caseId,
    alpha: benchmarkCase.alpha,
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    frameSha256: Object.freeze(frameSha256),
    timestampUs: Object.freeze(Array.from({ length: contract.frameCount }, (_entry, index) => frameTimestampUs(index, contract))),
    durationUs: Object.freeze(Array.from({ length: contract.frameCount }, (_entry, index) => frameDurationUs(index, contract))),
  });
}

export function existingFfmpegInputArgs(contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  return [
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${contract.width}x${contract.height}`,
    "-framerate", String(contract.rate.numerator / contract.rate.denominator),
    "-i", "pipe:0",
  ];
}

export function existingFfmpegOutputArgs(caseId, contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  const benchmarkCase = contract.cases.find((entry) => entry.id === caseId);
  if (!benchmarkCase) throw new Error(`Unknown frame-video encoder benchmark case: ${caseId}.`);
  return [
    "-c:v", "libvpx-vp9",
    "-b:v", "0",
    "-crf", String(contract.quality.quantizer),
    "-pix_fmt", benchmarkCase.pixelFormat,
    ...(benchmarkCase.alpha === "keep" ? ["-auto-alt-ref", "0"] : []),
    ...SDR_BT709_OUTPUT_ARGS,
  ];
}

export function decodedFrameEvidence(source, decoded, contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  const frameBytes = contract.width * contract.height * 4;
  if (!Buffer.isBuffer(source) || !Buffer.isBuffer(decoded)) throw new Error("Decoded-frame evidence requires Buffer inputs.");
  if (source.byteLength !== frameBytes * contract.frameCount) throw new Error("Source RGBA byte length does not match the benchmark contract.");
  if (decoded.byteLength % frameBytes !== 0) throw new Error("Decoded RGBA byte length is not frame-aligned.");
  const decodedFrameCount = decoded.byteLength / frameBytes;
  const comparedFrameCount = Math.min(decodedFrameCount, contract.frameCount);
  const decodedFrameSha256 = [];
  let rgbAbsoluteError = 0;
  let rgbSquaredError = 0;
  let rgbMaximumError = 0;
  let alphaAbsoluteError = 0;
  let alphaMaximumError = 0;
  let alphaNonOpaquePixels = 0;
  let alphaExactPixels = 0;
  for (let frameIndex = 0; frameIndex < decodedFrameCount; frameIndex += 1) {
    decodedFrameSha256.push(sha256(decoded.subarray(frameIndex * frameBytes, (frameIndex + 1) * frameBytes)));
  }
  for (let offset = 0; offset < comparedFrameCount * frameBytes; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(source[offset + channel] - decoded[offset + channel]);
      rgbAbsoluteError += error;
      rgbSquaredError += error * error;
      rgbMaximumError = Math.max(rgbMaximumError, error);
    }
    const alphaError = Math.abs(source[offset + 3] - decoded[offset + 3]);
    alphaAbsoluteError += alphaError;
    alphaMaximumError = Math.max(alphaMaximumError, alphaError);
    if (decoded[offset + 3] !== 255) alphaNonOpaquePixels += 1;
    if (alphaError === 0) alphaExactPixels += 1;
  }
  const pixelCount = comparedFrameCount * contract.width * contract.height;
  const rgbChannelCount = pixelCount * 3;
  const rgbMse = rgbChannelCount === 0 ? null : rgbSquaredError / rgbChannelCount;
  return Object.freeze({
    decodedByteLength: decoded.byteLength,
    decodedFrameCount,
    expectedFrameCount: contract.frameCount,
    frameCountExact: decodedFrameCount === contract.frameCount,
    decodedFrameSha256: Object.freeze(decodedFrameSha256),
    rgb: Object.freeze({
      meanAbsoluteError: rounded(rgbChannelCount === 0 ? 0 : rgbAbsoluteError / rgbChannelCount, 6),
      maximumAbsoluteError: rgbMaximumError,
      meanSquaredError: rgbMse === null ? null : rounded(rgbMse, 6),
      psnrDb: rgbMse === null ? null : rgbMse === 0 ? "infinity" : rounded(10 * Math.log10((255 * 255) / rgbMse), 6),
    }),
    alpha: Object.freeze({
      meanAbsoluteError: rounded(pixelCount === 0 ? 0 : alphaAbsoluteError / pixelCount, 6),
      maximumAbsoluteError: alphaMaximumError,
      exactPixelRatio: rounded(pixelCount === 0 ? 0 : alphaExactPixels / pixelCount, 9),
      nonOpaqueDecodedPixels: alphaNonOpaquePixels,
      hasDecodedTransparency: alphaNonOpaquePixels > 0,
    }),
  });
}

export function timestampEvidence(expectedUs, probedFrames, contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT) {
  if (!Array.isArray(expectedUs) || !Array.isArray(probedFrames)) throw new Error("Timestamp evidence requires arrays.");
  const actualUs = probedFrames.map((frame, index) => {
    const value = Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(value)) throw new Error(`Frame ${index} has no finite best-effort timestamp.`);
    return Math.round(value * 1_000_000);
  });
  const compared = Math.min(expectedUs.length, actualUs.length);
  const driftUs = Array.from({ length: compared }, (_entry, index) => actualUs[index] - expectedUs[index]);
  const maximumAbsoluteDriftUs = driftUs.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const monotonic = actualUs.every((value, index) => index === 0 || value > actualUs[index - 1]);
  return Object.freeze({
    expectedUs: Object.freeze([...expectedUs]),
    actualUs: Object.freeze(actualUs),
    driftUs: Object.freeze(driftUs),
    maximumAbsoluteDriftUs,
    withinContainerTolerance: actualUs.length === expectedUs.length && monotonic && maximumAbsoluteDriftUs <= contract.maxTimestampDriftUs,
    monotonic,
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fillFrame(target, frameIndex, transparent, width, height) {
  const centreX = (frameIndex * 7) % (width + 80) - 40;
  const centreY = height / 2 + Math.sin(frameIndex * 0.31) * height * 0.28;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inside = (x - centreX) ** 2 + (y - centreY) ** 2 <= 34 ** 2;
      target[offset] = inside ? 248 : (Math.floor(x * 255 / (width - 1)) + frameIndex * 3) & 0xff;
      target[offset + 1] = inside ? 62 : (Math.floor(y * 255 / (height - 1)) + frameIndex * 5) & 0xff;
      target[offset + 2] = inside ? 186 : (x + y * 2 + frameIndex * 11) & 0xff;
      target[offset + 3] = transparent ? (inside ? 224 : ((x + frameIndex * 4) % width < 24 ? 0 : Math.floor(x * 255 / (width - 1)))) : 255;
    }
  }
}

function assertFrameIndex(frameIndex, contract) {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= contract.frameCount) throw new Error("Frame index is outside the benchmark contract.");
}

function rounded(value, digits) {
  return Number(value.toFixed(digits));
}
