/** Safe, bounded inspection of internal cleanup wrappers for the coordinator-only launch sentinel. */
import { SegmentedFinalAdapterFailure } from "./segmented-final-internal/segmented-final-adapter-types.js";
import { SegmentSpoolOperationError } from "./segmented-final-internal/render-segment-spool-helpers.js";
import { RenderSegmentSpoolFailure } from "./segmented-final-internal/render-segment-spool-types.js";
import { PreAdmittedSegmentReadbackCleanupError } from "./segmented-final-internal/segment-ffprobe-readback.js";
import { isStreamingFinalLineageRevalidationFailure } from "./streaming-final-lineage-revalidation.js";

/** Cleanup wrappers preserve frozen causes; inspect only their bounded, own-data causal graph. */
export function nestedLineageRevalidationFailure(
  error: unknown,
  state: { readonly seen: Set<object>; visited: number } = { seen: new Set<object>(), visited: 0 },
  depth = 0,
): Error | undefined {
  if (safeLineageRevalidationFailure(error)) return error;
  if (!safeInstanceOf(error, Error) || depth >= 12 || state.visited >= 64 || state.seen.has(error)) return undefined;
  state.seen.add(error);
  state.visited += 1;
  const causes: unknown[] = [ownDataValue(error, "cause")];
  if (safeInstanceOf(error, AggregateError)) causes.push(...ownDataArrayValues(ownDataValue(error, "errors")));
  if (safeInstanceOf(error, SegmentedFinalAdapterFailure) || safeInstanceOf(error, RenderSegmentSpoolFailure) || safeInstanceOf(error, SegmentSpoolOperationError)) {
    causes.push(ownDataValue(error, "primaryCause"), ownDataValue(error, "cleanupCause"));
    causes.push(...ownDataArrayValues(ownDataValue(error, "cleanupCauses")));
  }
  if (safeInstanceOf(error, PreAdmittedSegmentReadbackCleanupError)) causes.push(ownDataValue(error, "primaryCause"), ownDataValue(error, "cleanupCause"));
  for (const cause of causes) {
    const found = nestedLineageRevalidationFailure(cause, state, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Never invoke a user-defined getter while normalizing a renderer failure. */
function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** AggregateError stores a normal own array; read own data entries only, never an iterable or getter. */
function ownDataArrayValues(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const entries: unknown[] = [];
    for (let index = 0; index < Math.min(value.length, 32); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor && "value" in descriptor) entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return [];
  }
}

function safeLineageRevalidationFailure(error: unknown): error is Error {
  try { return isStreamingFinalLineageRevalidationFailure(error); } catch { return false; }
}

function safeInstanceOf(value: unknown, constructor: Function): value is object {
  try { return value instanceof constructor; } catch { return false; }
}
