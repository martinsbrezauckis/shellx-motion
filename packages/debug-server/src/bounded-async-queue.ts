export interface BoundedAsyncQueue {
  enqueue(task: () => Promise<void>): boolean;
}

/**
 * Serializes asynchronous work while bounding everything accepted but not yet settled.
 * When the bound is crossed, queued work is abandoned; only a task already running may finish.
 */
export function createBoundedAsyncQueue(
  maxOutstanding: number,
  onError: () => void
): BoundedAsyncQueue {
  if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding < 1) {
    throw new Error("Bounded async queue capacity must be a positive safe integer.");
  }
  let outstanding = 0;
  let aborted = false;
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(task): boolean {
      if (aborted || outstanding >= maxOutstanding) {
        aborted = true;
        return false;
      }
      outstanding += 1;
      tail = tail
        .then(async () => {
          if (!aborted) await task();
        })
        .catch(onError)
        .finally(() => {
          outstanding -= 1;
        });
      return true;
    }
  };
}
