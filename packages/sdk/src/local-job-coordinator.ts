/** Local SDK handle over the persistent Debug API job coordinator. */
import { resolve } from "node:path";
import type { MotionJobCoordinatorEvent, MotionJobStatus } from "@shellx-motion/core";
import { dispatchDebugCommand, type MotionDebugResult } from "@shellx-motion/debug-api";
import { localDebugContext } from "./local-debug-context";
import type { LocalMotionSdkOptions } from "./local";
import { LocalMotionSdkError } from "./local-result";
import type { MotionSdkCoordinatedRenderRequest } from "./types";

export interface LocalMotionSdkJobClient {
  /** Submit a streamed final render and return its durable handle before expensive work starts. */
  submitRender(input: MotionSdkCoordinatedRenderRequest): Promise<LocalMotionSdkRenderJob>;
}

/** A submitted render; status stays live until the coordinator writes a terminal record. */
export interface LocalMotionSdkRenderJob {
  readonly id: string;
  status(): Promise<MotionJobStatus>;
  events(after?: number): Promise<MotionJobCoordinatorEvent[]>;
  cancel(reason?: string): Promise<MotionJobStatus>;
  retry(newJobId?: string): Promise<LocalMotionSdkRenderJob>;
}

export async function submitLocalRender(input: MotionSdkCoordinatedRenderRequest, options: LocalMotionSdkOptions): Promise<LocalMotionSdkRenderJob> {
  const debug = await dispatchDebugCommand("motion.job.submit", {
    ...(input.jobId ? { jobId: input.jobId } : {}),
    packageRoot: resolve(input.packageRoot), outputPath: resolve(input.outputPath), preset: input.preset,
    ...(input.receiptsRoot ? { receiptsRoot: resolve(input.receiptsRoot) } : {}),
    ...(input.frameLane ? { frameLane: input.frameLane } : {}),
    ...(input.segmented ? { segmented: input.segmented } : {})
  }, localDebugContext("render_motion", options));
  return localRenderJob(stringField(successfulDebugResult(debug, "render submit"), "jobId"), options);
}

function localRenderJob(jobId: string, options: LocalMotionSdkOptions): LocalMotionSdkRenderJob {
  return {
    id: jobId,
    status: async () => {
      const debug = await dispatchDebugCommand("motion.job.get", { jobId }, localDebugContext("read_motion", options));
      return record(successfulDebugResult(debug, "job status").job, "job status") as unknown as MotionJobStatus;
    },
    events: async (after) => {
      const debug = await dispatchDebugCommand("motion.job.events", { jobId, ...(after === undefined ? {} : { after }) }, localDebugContext("read_motion", options));
      const events = successfulDebugResult(debug, "job events").events;
      if (!Array.isArray(events)) throw new Error("job events must be an array.");
      return events as MotionJobCoordinatorEvent[];
    },
    cancel: async (reason) => {
      const debug = await dispatchDebugCommand("motion.job.cancel", { jobId, ...(reason ? { reason } : {}) }, localDebugContext("render_motion", options));
      return record(successfulDebugResult(debug, "job cancel").job, "job cancel") as unknown as MotionJobStatus;
    },
    retry: async (newJobId) => {
      const debug = await dispatchDebugCommand("motion.job.retry", { jobId, ...(newJobId ? { newJobId } : {}) }, localDebugContext("render_motion", options));
      return localRenderJob(stringField(successfulDebugResult(debug, "job retry"), "jobId"), options);
    }
  };
}

function successfulDebugResult(debug: MotionDebugResult, label: string): Record<string, unknown> {
  if (!debug.ok) throw new LocalMotionSdkError(debug.error.code, `${label} failed: ${debug.error.message}`, false, debug.error.detail);
  return record(debug.result, `${label} result`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a string.`);
  return value;
}
