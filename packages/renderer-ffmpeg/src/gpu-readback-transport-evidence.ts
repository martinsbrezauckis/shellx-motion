import type { GpuReadbackTransportEvidence } from "@shellx-motion/renderer-browser";

/**
 * Validate path-free GPU readback evidence before it is admitted into a final
 * receipt. The returned transport facts are deterministic; observational host
 * timing is validated here but deliberately excluded from receipt identity.
 */
export function gpuReadbackTransportIdentity(
  evidence: GpuReadbackTransportEvidence | null,
  expectedFrames: number
): GpuReadbackTransportEvidence["transport"] | undefined {
  if (!isRecord(evidence) || !hasExactKeys(evidence, ["schema", "transport", "timing"])
    || evidence.schema !== "shellx-motion/gpu-readback-transport@1" || !isSafePositiveInteger(expectedFrames)) return undefined;
  const transport = evidence.transport;
  const timing = evidence.timing;
  if (!isRecord(transport) || !isRecord(timing)
    || !hasExactKeys(transport, ["path", "framesObserved", "width", "height", "tightBytesPerRow", "mappedBytesPerRow", "bytes", "allocations", "rowCompaction", "straightAlpha", "output"])
    || !hasExactKeys(timing, ["observational", "clock", "scope", "framesObserved", "totalNanoseconds", "minNanoseconds", "maxNanoseconds"])
    || transport.path !== "webgpu-texture-map-read-cdp-base64-owned-rgba" || transport.framesObserved !== expectedFrames
    || timing.observational !== true || timing.clock !== "node-process-hrtime" || timing.scope !== "admitted-frame-render-and-readback" || timing.framesObserved !== expectedFrames) return undefined;
  if (!isRecord(transport.bytes) || !hasExactKeys(transport.bytes, ["gpuTextureToMappedReadback", "cdpBase64Payload", "hostBase64Decoded"])
    || !isRecord(transport.allocations) || !hasExactKeys(transport.allocations, ["hostBase64Decode", "rowCompaction", "straightAlpha"])
    || !isRecord(transport.rowCompaction) || !hasExactKeys(transport.rowCompaction, ["tightRowFrames", "paddedRowFrames", "copiedBytes", "allocationCount"])
    || !isRecord(transport.straightAlpha) || !hasExactKeys(transport.straightAlpha, ["inPlaceOwnedBufferFrames", "copiedBytes", "allocationCount"])
    || !isRecord(transport.output) || !hasExactKeys(transport.output, ["format", "colorSpace", "alphaMode", "strideBytes", "hashing"])) return undefined;
  const scalars = [
    transport.width, transport.height, transport.tightBytesPerRow, transport.mappedBytesPerRow,
    transport.bytes.gpuTextureToMappedReadback, transport.bytes.cdpBase64Payload, transport.bytes.hostBase64Decoded,
    transport.allocations.hostBase64Decode, transport.allocations.rowCompaction, transport.allocations.straightAlpha,
    transport.rowCompaction.tightRowFrames, transport.rowCompaction.paddedRowFrames, transport.rowCompaction.copiedBytes, transport.rowCompaction.allocationCount,
    transport.straightAlpha.inPlaceOwnedBufferFrames, transport.straightAlpha.copiedBytes, transport.straightAlpha.allocationCount,
    timing.totalNanoseconds, timing.minNanoseconds, timing.maxNanoseconds
  ];
  if (!scalars.every(isSafeNonNegativeInteger) || transport.width < 1 || transport.height < 1) return undefined;
  const tightBytesPerRow = transport.width * 4;
  const mappedFrameBytes = transport.mappedBytesPerRow * transport.height;
  const tightFrameBytes = tightBytesPerRow * transport.height;
  const expectedBase64PayloadBytes = Math.ceil(mappedFrameBytes / 3) * 4;
  const expectedMappedBytes = mappedFrameBytes * expectedFrames;
  const expectedBase64Bytes = expectedBase64PayloadBytes * expectedFrames;
  if (![tightBytesPerRow, mappedFrameBytes, tightFrameBytes, expectedBase64PayloadBytes, expectedMappedBytes, expectedBase64Bytes].every(isSafeNonNegativeInteger)
    || transport.tightBytesPerRow !== tightBytesPerRow || transport.mappedBytesPerRow < tightBytesPerRow || transport.mappedBytesPerRow % 256 !== 0
    || transport.bytes.gpuTextureToMappedReadback !== expectedMappedBytes || transport.bytes.hostBase64Decoded !== expectedMappedBytes || transport.bytes.cdpBase64Payload !== expectedBase64Bytes
    || transport.allocations.hostBase64Decode !== expectedFrames || transport.allocations.straightAlpha !== 0
    || transport.straightAlpha.inPlaceOwnedBufferFrames !== expectedFrames || transport.straightAlpha.copiedBytes !== 0 || transport.straightAlpha.allocationCount !== 0
    || transport.output.format !== "rgba" || transport.output.colorSpace !== "srgb" || transport.output.alphaMode !== "straight" || transport.output.strideBytes !== tightBytesPerRow || transport.output.hashing !== "sha256-tight-straight-rgba") return undefined;
  const tightRows = transport.mappedBytesPerRow === tightBytesPerRow;
  if ((tightRows && (transport.rowCompaction.tightRowFrames !== expectedFrames || transport.rowCompaction.paddedRowFrames !== 0 || transport.rowCompaction.copiedBytes !== 0 || transport.rowCompaction.allocationCount !== 0 || transport.allocations.rowCompaction !== 0))
    || (!tightRows && (transport.rowCompaction.tightRowFrames !== 0 || transport.rowCompaction.paddedRowFrames !== expectedFrames || transport.rowCompaction.copiedBytes !== tightFrameBytes * expectedFrames || transport.rowCompaction.allocationCount !== expectedFrames || transport.allocations.rowCompaction !== expectedFrames))) return undefined;
  if (timing.minNanoseconds > timing.maxNanoseconds || timing.totalNanoseconds < timing.minNanoseconds * expectedFrames || timing.totalNanoseconds > timing.maxNanoseconds * expectedFrames) return undefined;
  return transport as GpuReadbackTransportEvidence["transport"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}
