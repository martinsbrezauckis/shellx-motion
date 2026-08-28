/**
 * Cancellation checkpoints for connector-owned work.
 *
 * P2 connectors keep all delivery bytes in a private transaction until the one final commit.
 * A renderer may finish after the coordinator has cancelled its job, so callers must make an
 * explicit checkpoint before any later receipt, handle, plan, or public-tree publication.
 */
export function throwIfConnectorAborted(signal: AbortSignal | undefined, stage: string): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const detail = signal.reason === undefined ? "" : `: ${String(signal.reason)}`;
  throw new Error(`Connector delivery was cancelled ${stage}${detail}`);
}
