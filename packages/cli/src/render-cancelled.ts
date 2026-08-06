/**
 * Recognising and reporting a cancelled render.
 *
 * Role: the governor and the FFmpeg child have always honoured an abort signal, but the CLI's own
 * frame loops did not — they drew every remaining frame regardless, so a cancelled render still
 * reported success. This module supplies the check the loops were missing and the one shape a
 * cancelled render reports.
 *
 * Why cancellation is not just another failure: an agent's retry policy is normally "retry if the
 * error is retryable". Auto-retrying something a human stopped overrides an explicit instruction.
 * So a cancelled result carries `cancelled: true` and a distinct error code, letting a caller
 * branch without parsing a message — the same separation the job status contract draws between
 * outcome `cancelled` and outcome `failed` (docs/public/JOB_STATUS.md).
 *
 * Dependencies: none. Primary caller: the render frame loops in `packages/cli/src/main.ts`.
 */

/** Thrown by {@link throwIfCancelled}; carried to the render result by {@link isRenderCancellation}. */
export class RenderCancelledError extends Error {
  readonly code = "render_cancelled";
  constructor(message = "Render was cancelled before it finished.") {
    super(message);
    this.name = "RenderCancelledError";
  }
}

/**
 * Stop the current render if the caller has asked for it.
 *
 * Called at frame boundaries: the cheapest place to notice, and the point at which stopping
 * leaves the least partial work behind.
 */
export function throwIfCancelled(signal: AbortSignal | undefined, stage: string): void {
  if (!signal?.aborted) return;
  throw new RenderCancelledError(`Render was cancelled during ${stage}.`);
}

/** True for anything that means "the caller asked to stop", whatever layer raised it. */
export function isRenderCancellation(error: unknown): boolean {
  if (error instanceof RenderCancelledError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  return name === "AbortError" || code === "ABORT_ERR" || code === "job_cancelled" || code === "render_cancelled";
}

/**
 * The envelope a cancelled render returns.
 *
 * `ok` is false because the requested artifact was not produced, while `cancelled: true` says
 * why — so a caller can distinguish "stopped on request" from "failed" without reading prose,
 * and can decline to retry.
 */
export function renderCancelledResult(input: {
  lane: string;
  frameLane?: string;
  outputPath?: string;
  framesDrawn?: number;
  stage: string;
}): Record<string, unknown> {
  return {
    ok: false,
    command: "render",
    lane: input.lane,
    ...(input.frameLane ? { frameLane: input.frameLane } : {}),
    ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    cancelled: true,
    ...(input.framesDrawn !== undefined ? { frames: { drawn: input.framesDrawn } } : {}),
    error: {
      code: "render_cancelled",
      message: `Render was cancelled during ${input.stage}. Nothing was delivered; re-run to start again.`
    }
  };
}

/**
 * Run a render, reporting a cancellation as a structured result rather than an exception.
 *
 * Lives here rather than at the call site so every lane's frame loop can simply throw and the
 * reported shape stays identical.
 *
 * The signal is consulted first, and the error shape only as a fallback: `abort(reason)`
 * propagates whatever reason the caller supplied — commonly a plain Error whose name is not
 * "AbortError" — so sniffing the error alone silently misses real cancellations.
 */
export async function withRenderCancellation<T extends Record<string, unknown>>(
  run: () => Promise<T>,
  context: { signal?: AbortSignal; lane: string; frameLane?: string; outputPath?: string }
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!context.signal?.aborted && !isRenderCancellation(error)) throw error;
    return renderCancelledResult({
      lane: context.lane,
      ...(context.frameLane ? { frameLane: context.frameLane } : {}),
      ...(context.outputPath ? { outputPath: context.outputPath } : {}),
      // Only a RenderCancelledError names a stage. Anything else (a governor abort, a browser
      // AbortError) gets the generic one rather than having its own sentence spliced into ours.
      stage: error instanceof RenderCancelledError
        ? error.message.replace(/^Render was cancelled during /, "").replace(/\.$/, "")
        : "rendering"
    }) as T;
  }
}
