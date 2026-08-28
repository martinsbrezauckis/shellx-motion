import { createHash } from "node:crypto";
import { normalizeGpuReadback } from "./gpu-readback";
import { InternalGpuFrameError, type GpuRenderedFrame, type GpuRuntimeEvidence, type GpuTextFitEvidence } from "./gpu-runtime-types";
import { gpuStraightRgbaInPlace } from "./gpu-straight-rgba";

/** Finish one owned raw-RGBA readback without adding a row or alpha copy. */
export function finalizeGpuFrameReadback(input: {
  paddedBase64: unknown;
  width: number;
  height: number;
  bytesPerRow: number;
  evidence: GpuRuntimeEvidence;
  textFit: readonly GpuTextFitEvidence[];
  frameStartedAtNs: bigint;
}): GpuRenderedFrame {
  const readback = normalizeGpuReadback({
    paddedBase64: input.paddedBase64,
    width: input.width,
    height: input.height,
    bytesPerRow: input.bytesPerRow
  });
  const rgba = gpuStraightRgbaInPlace({ rgba: readback.rgba, width: input.width, height: input.height });
  const hostFrameElapsedNanoseconds = Number(process.hrtime.bigint() - input.frameStartedAtNs);
  if (!Number.isSafeInteger(hostFrameElapsedNanoseconds) || hostFrameElapsedNanoseconds < 0) {
    throw new InternalGpuFrameError("GPU frame host timing is outside the bounded observation range.");
  }
  return {
    rgba,
    sha256: createHash("sha256").update(rgba).digest("hex"),
    width: input.width,
    height: input.height,
    evidence: input.evidence,
    readback: {
      ...readback.metrics,
      hostFrameElapsedNanoseconds,
      hostClock: "node-process-hrtime",
      hostTimingScope: "admitted-frame-render-and-readback"
    },
    textFit: input.textFit
  };
}
