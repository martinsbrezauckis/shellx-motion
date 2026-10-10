import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";

export async function closeHeldMediaAfterFailure(operation: { close(): Promise<void> }, primary: unknown): Promise<void> {
  try {
    await operation.close();
  } catch (cleanupError) {
    throw new AggregateError([primary, cleanupError], "Strict SDR held-media operation failed and retained uncertain cleanup state.");
  }
}

export function heldMediaEncodeFrameCount(route: LinearSrgbSdrFinalRoute): number { return Math.ceil((route.canvas.durationMs / 1_000) * route.canvas.fps); }

export function assertHeldMediaWriteAcknowledgement(value: { readonly backpressured: boolean; readonly bufferedInputBytes: number; readonly inputHighWaterMarkBytes: number }): void {
  if (typeof value.backpressured !== "boolean" || !Number.isSafeInteger(value.bufferedInputBytes) || value.bufferedInputBytes < 0 || value.bufferedInputBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(value.inputHighWaterMarkBytes) || value.inputHighWaterMarkBytes < 1 || value.inputHighWaterMarkBytes > 64 * 1024 * 1024) {
    throw new Error("Strict SDR held-media encoder returned an invalid bounded write acknowledgement.");
  }
}
