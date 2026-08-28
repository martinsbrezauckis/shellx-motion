import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export class GpuStreamingProducerBusyError extends Error {
  readonly code = "gpu_streaming_producer_busy";

  constructor() {
    super("GPU streamed frame producer is already active.");
    this.name = "GpuStreamingProducerBusyError";
    Object.setPrototypeOf(this, GpuStreamingProducerBusyError.prototype);
  }
}

export class GpuStreamingProducerCapabilityError extends Error {
  readonly code: string;
  readonly layerId?: string;

  constructor(failure: { code: string; message: string; layerId?: string }) {
    super(failure.message);
    this.name = "GpuStreamingProducerCapabilityError";
    this.code = failure.code;
    this.layerId = failure.layerId;
    Object.setPrototypeOf(this, GpuStreamingProducerCapabilityError.prototype);
  }
}

export class GpuStreamingProducerRuntimeError extends Error {
  readonly code: string;

  constructor(readonly failure: GpuRuntimeFailure) {
    super(failure.message);
    this.name = "GpuStreamingProducerRuntimeError";
    this.code = failure.code;
    Object.setPrototypeOf(this, GpuStreamingProducerRuntimeError.prototype);
  }
}

export class GpuStreamingProducerCleanupError extends Error {
  constructor(readonly primaryCause: unknown | undefined, readonly closeCause: unknown) {
    super("GPU streamed producer cleanup failed.", { cause: primaryCause ?? closeCause });
    this.name = "GpuStreamingProducerCleanupError";
    Object.setPrototypeOf(this, GpuStreamingProducerCleanupError.prototype);
  }
}

/** Strict final-delivery refusal: an observed PID is not a contained browser tree. */
export class GpuStreamingProducerContainmentError extends Error {
  readonly code = "gpu_process_containment_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "GpuStreamingProducerContainmentError";
    Object.setPrototypeOf(this, GpuStreamingProducerContainmentError.prototype);
  }
}
