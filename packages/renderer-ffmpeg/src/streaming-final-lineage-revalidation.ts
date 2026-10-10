/**
 * Coordinator-only launch fence for the existing streamed-final renderer.
 *
 * This module deliberately has no package-barrel export. The callback is an
 * in-process execution guard, not render request, plan, receipt, or caller
 * data. Direct renderer callers run with no store and retain their current
 * behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { FfmpegRunner } from "./index.js";

type CoordinatedLineageRevalidation = () => Promise<void>;

class StreamingFinalLineageRevalidationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingFinalLineageRevalidationFailure";
  }
}

const launchRevalidation = new AsyncLocalStorage<CoordinatedLineageRevalidation>();

/** Run one renderer execution with its coordinator-owned, non-serializable launch fence. */
export async function withStreamingFinalLaunchRevalidation<T>(
  revalidate: CoordinatedLineageRevalidation | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return revalidate
    ? await launchRevalidation.run(revalidate, operation)
    : await operation();
}

/** Fence the exact next external launch when a coordinated render installed a guard. */
export async function revalidateStreamingFinalLaunch(): Promise<void> {
  const revalidate = launchRevalidation.getStore();
  if (!revalidate) return;
  try {
    await revalidate();
  } catch (error) {
    throw new StreamingFinalLineageRevalidationFailure(
      error instanceof Error ? error.message : "Coordinated render package lineage could not be revalidated.",
    );
  }
}

/** Whether this call chain has the coordinator-owned fence; internal execution may preserve its direct identity otherwise. */
export function hasStreamingFinalLaunchRevalidation(): boolean {
  return launchRevalidation.getStore() !== undefined;
}

/** Preserve the supplied runner object exactly when no coordinated fence is active. */
export function revalidatingStreamingFinalRunner(runner: FfmpegRunner): FfmpegRunner {
  if (!launchRevalidation.getStore()) return runner;
  return async (command) => {
    await revalidateStreamingFinalLaunch();
    return await runner(command);
  };
}

export function isStreamingFinalLineageRevalidationFailure(error: unknown): error is Error {
  return error instanceof StreamingFinalLineageRevalidationFailure;
}
