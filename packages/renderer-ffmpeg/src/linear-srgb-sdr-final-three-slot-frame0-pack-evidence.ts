/** Immutable projection of inverse-job facts retained by a private frame-zero pack. */
import type { LocalMotionJobEvidence } from "@shellx-motion/core";

const SHA256 = /^[a-f0-9]{64}$/u;

export type StrictSdrCandidateFrame0PackInverseJob = Readonly<{
  schema: "shellx-motion/local-job-resources@1";
  jobId: string;
  lane: string;
  operation: string;
  state: string;
  queueWaitMs: number;
  durationMs: number;
  policy: Readonly<{
    maxConcurrentJobs: number;
    maxQueueDepth: number;
    maxQueueWaitMs: number;
    maxWallClockMs: number;
    minFreeScratchBytes: number;
    scratchReservationBytes: number;
    maxProcessTreeRssBytes: number;
    rssPollIntervalMs: number;
  }>;
  scratch: Readonly<{ pathSafety: "canonical-no-symlink"; freeBytesAtStart: number; reservedBytes: number; minFreeBytes: number }>;
  peakProcessTreeRssBytes: number;
  watchedProcessCount: number;
  rssScope: "process-tree" | "root-process" | "unavailable";
  processContainment?: Readonly<{
    schema: "shellx-motion/process-containment@1";
    mode: string;
    status: string;
    killTree: boolean;
    memoryLimit: string;
    maxJobMemoryBytes?: number;
    maxActiveProcesses?: number;
    launcher?: Readonly<{ kind: "powershell-csharp"; sha256: string }>;
    reasonCode?: string;
  }>;
}>;

export function snapshotStrictSdrCandidateFrame0PackInverseJob(
  value: LocalMotionJobEvidence | StrictSdrCandidateFrame0PackInverseJob,
): StrictSdrCandidateFrame0PackInverseJob {
  const record = dataRecord(value, "Strict-SDR frame-zero pack inverse job"), policy = exactDataRecord(record.policy, ["maxConcurrentJobs", "maxProcessTreeRssBytes", "maxQueueDepth", "maxQueueWaitMs", "maxWallClockMs", "minFreeScratchBytes", "rssPollIntervalMs", "scratchReservationBytes"], "Strict-SDR frame-zero pack inverse policy"), scratch = exactDataRecord(record.scratch, ["freeBytesAtStart", "minFreeBytes", "pathSafety", "reservedBytes"], "Strict-SDR frame-zero pack inverse scratch");
  const allowed = ["durationMs", "jobId", "lane", "operation", "peakProcessTreeRssBytes", "policy", "processContainment", "queueWaitMs", "rssScope", "sandbox", "schema", "scratch", "state", "watchedProcessCount"];
  if (Object.getOwnPropertyNames(record).some((name) => !allowed.includes(name))) {
    throw new Error("Strict-SDR frame-zero pack inverse job evidence has unsupported fields.");
  }
  if (Object.hasOwn(record, "sandbox")) {
    throw new Error("Strict-SDR frame-zero pack inverse job evidence does not support sandbox facts.");
  }
  if (record.schema !== "shellx-motion/local-job-resources@1" || typeof record.jobId !== "string" || typeof record.lane !== "string" || typeof record.operation !== "string" || typeof record.state !== "string" || scratch.pathSafety !== "canonical-no-symlink") {
    throw new Error("Strict-SDR frame-zero pack inverse job evidence is malformed.");
  }
  const base = Object.freeze({
    schema: "shellx-motion/local-job-resources@1" as const,
    jobId: boundedText(record.jobId, "Strict-SDR frame-zero pack inverse job id"),
    lane: boundedText(record.lane, "Strict-SDR frame-zero pack inverse lane"),
    operation: boundedText(record.operation, "Strict-SDR frame-zero pack inverse operation"),
    state: boundedText(record.state, "Strict-SDR frame-zero pack inverse state"),
    queueWaitMs: nonnegative(record.queueWaitMs),
    durationMs: nonnegative(record.durationMs),
    policy: Object.freeze({
      maxConcurrentJobs: positive(policy.maxConcurrentJobs), maxQueueDepth: nonnegative(policy.maxQueueDepth), maxQueueWaitMs: nonnegative(policy.maxQueueWaitMs), maxWallClockMs: nonnegative(policy.maxWallClockMs), minFreeScratchBytes: nonnegative(policy.minFreeScratchBytes), scratchReservationBytes: nonnegative(policy.scratchReservationBytes), maxProcessTreeRssBytes: positive(policy.maxProcessTreeRssBytes), rssPollIntervalMs: positive(policy.rssPollIntervalMs),
    }),
    scratch: Object.freeze({ pathSafety: "canonical-no-symlink" as const, freeBytesAtStart: nonnegative(scratch.freeBytesAtStart), reservedBytes: nonnegative(scratch.reservedBytes), minFreeBytes: nonnegative(scratch.minFreeBytes) }),
    peakProcessTreeRssBytes: nonnegative(record.peakProcessTreeRssBytes), watchedProcessCount: nonnegative(record.watchedProcessCount),
    rssScope: exactRssScope(record.rssScope),
  });
  return Object.freeze({ ...base, ...(record.processContainment === undefined ? {} : { processContainment: snapshotContainment(record.processContainment) }) });
}

function snapshotContainment(value: unknown): NonNullable<StrictSdrCandidateFrame0PackInverseJob["processContainment"]> {
  const record = dataRecord(value, "Strict-SDR frame-zero pack inverse containment");
  const allowed = ["killTree", "launcher", "maxActiveProcesses", "maxJobMemoryBytes", "memoryLimit", "mode", "reasonCode", "schema", "status"];
  const names = Object.getOwnPropertyNames(record).sort();
  if (names.some((name) => !allowed.includes(name))) throw new Error("Strict-SDR frame-zero pack inverse containment keys are unsupported.");
  if (record.schema !== "shellx-motion/process-containment@1" || typeof record.mode !== "string" || typeof record.status !== "string" || typeof record.killTree !== "boolean" || typeof record.memoryLimit !== "string") throw new Error("Strict-SDR frame-zero pack inverse containment is malformed.");
  const optional = {
    ...(record.maxJobMemoryBytes === undefined ? {} : { maxJobMemoryBytes: nonnegative(record.maxJobMemoryBytes) }),
    ...(record.maxActiveProcesses === undefined ? {} : { maxActiveProcesses: nonnegative(record.maxActiveProcesses) }),
    ...(record.reasonCode === undefined ? {} : { reasonCode: boundedText(record.reasonCode, "Strict-SDR frame-zero pack inverse containment reason") }),
    ...(record.launcher === undefined ? {} : { launcher: snapshotLauncher(record.launcher) }),
  };
  return Object.freeze({ schema: "shellx-motion/process-containment@1" as const, mode: boundedText(record.mode, "Strict-SDR frame-zero pack inverse containment mode"), status: boundedText(record.status, "Strict-SDR frame-zero pack inverse containment status"), killTree: record.killTree, memoryLimit: boundedText(record.memoryLimit, "Strict-SDR frame-zero pack inverse containment memory limit"), ...optional });
}
function snapshotLauncher(value: unknown): Readonly<{ kind: "powershell-csharp"; sha256: string }> {
  const record = exactDataRecord(value, ["kind", "sha256"], "Strict-SDR frame-zero pack inverse containment launcher");
  if (record.kind !== "powershell-csharp" || !SHA256.test(record.sha256 as string)) throw new Error("Strict-SDR frame-zero pack inverse containment launcher is malformed.");
  return Object.freeze({ kind: "powershell-csharp" as const, sha256: record.sha256 as string });
}
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} is not a plain data object.`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")) throw new Error(`${label}.${key} is not enumerable data.`);
  }
  return value as Record<string, unknown>;
}
function exactDataRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, label), names = Object.getOwnPropertyNames(record).sort(), expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error(`${label} keys are not exact.`);
  return record;
}
function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${label} is not bounded text.`);
  return value;
}
function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Strict-SDR frame-zero pack inverse numeric evidence is invalid.");
  return value;
}
function positive(value: unknown): number {
  const parsed = nonnegative(value);
  if (parsed < 1) throw new Error("Strict-SDR frame-zero pack inverse numeric evidence must be positive.");
  return parsed;
}
function exactRssScope(value: unknown): StrictSdrCandidateFrame0PackInverseJob["rssScope"] {
  if (value !== "process-tree" && value !== "root-process" && value !== "unavailable") throw new Error("Strict-SDR frame-zero pack inverse RSS scope is invalid.");
  return value;
}
