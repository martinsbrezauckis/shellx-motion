export class GpuFrameIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuFrameIntentError";
  }
}
