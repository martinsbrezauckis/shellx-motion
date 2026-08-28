/** Whether the caller or terminal session signal has already requested cancellation. */
export function gpuPreviewAbortRequested(left: AbortSignal | undefined, right: AbortSignal): boolean { return left?.aborted === true || right.aborted; }

/** Merge caller cancellation with the session terminal signal without leaking listeners. */
export function mergeGpuPreviewAbortSignals(left: AbortSignal | undefined, right: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  left?.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  if (gpuPreviewAbortRequested(left, right)) controller.abort();
  return {
    signal: controller.signal,
    dispose() { left?.removeEventListener("abort", abort); right.removeEventListener("abort", abort); }
  };
}
