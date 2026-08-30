/**
 * Wrapping one CLI invocation in one host job.
 *
 * Role: a host that spawns `shellx-motion render` asked for exactly one thing. Underneath, Motion takes
 * six governed resource admissions to deliver it — a browser frame pass, two ffmpeg capability
 * probes and three encodes. Reporting those as jobs answers a question nobody asked and shows an
 * operator "ffmpeg.version" as work in progress.
 *
 * So the host job is declared here, around the whole command, rather than by tagging one of the
 * internal admissions. That also removes a trap: the host job and an internal admission sharing one
 * id would share one lease file, and whichever finished first would delete the other's.
 *
 * Wrapping at the dispatch site rather than inside `renderCommand` is deliberate — that function
 * has around fifteen return points, and a wrapper that has to be remembered at each of them is a
 * wrapper that will eventually be forgotten at one.
 *
 * Dependencies: `@shellx-motion/core` (MotionHostJob). Primary caller: the command dispatch in
 * `main.ts`.
 */
import { JOB_STATUS_CONTRACT, MotionHostJob, runInMotionHostJob, type JobErrorCode } from "@shellx-motion/core";
import {
  isPairedOutputReceiptDestinationError,
  pairedOutputReceiptDestinationErrorFields
} from "./paired-output-receipt-publication.js";

type CliResultLike = Record<string, unknown> & { ok: boolean };

export interface HostJobScope {
  jobId?: string;
  callerId?: string;
  lane: string;
  /** The receipt operation vocabulary — what the host asked for, not how it was done. */
  operation: string;
}

/**
 * Run a command as one observable host job.
 *
 * The job's outcome is read from the result the command returns, not guessed from whether it threw:
 * a Motion CLI command reports a failed render as `{ ok: false, error }` and exits normally, so
 * "did not throw" is not the same as "succeeded".
 */
export async function withHostJob(
  scope: HostJobScope,
  run: () => Promise<CliResultLike>
): Promise<CliResultLike> {
  // Validate the ids HERE, at the boundary that accepted them. `MotionHostJob.begin` rejects a
  // malformed job id by throwing, which would leave the CLI crashing with a stack trace instead of
  // reporting a bad argument — the one thing a host integrating against these flags must not see.
  let job: MotionHostJob;
  try {
    job = await beginHostJob(scope);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : "Motion job could not be started.",
        suggestedAction: "Use 1..128 characters of letters, digits, dot, underscore, colon or hyphen for --job-id, for example cut:render-42."
      }
    };
  }
  return await runWithHostJob(job, scope, run);
}

function beginHostJob(scope: HostJobScope): Promise<MotionHostJob> {
  return MotionHostJob.begin({
    ...(scope.jobId ? { jobId: scope.jobId } : {}),
    ...(scope.callerId ? { callerId: scope.callerId } : {}),
    lane: scope.lane,
    operation: scope.operation
  });
}

async function runWithHostJob(
  job: MotionHostJob,
  scope: HostJobScope,
  run: () => Promise<CliResultLike>
): Promise<CliResultLike> {
  try {
    // Inside the job's async context, so the governor can promote it from pending to running when
    // the first governed operation is admitted.
    const result = await runInMotionHostJob(job, run);
    if (result.ok) {
      await job.succeeded({
        ...(typeof result.receiptPath === "string" ? { receiptPath: result.receiptPath } : {}),
        ...(Array.isArray(result.warnings) ? { warnings: result.warnings.filter((entry): entry is string => typeof entry === "string") } : {})
      });
    } else {
      const error = asError(result.error);
      // A cancelled render is reported as cancelled, never as failed: the contract keeps `error`
      // absent on cancellation precisely so an agent's retry policy cannot restart it.
      if (error?.code === "render_cancelled" || error?.code === "job_cancelled") {
        await job.cancelled({ ...(scope.callerId ? { cancellation: { requestedBy: scope.callerId } } : {}) });
      } else {
        await job.failed({ error: { code: jobErrorCode(error?.code), message: error?.message ?? "Motion render failed." } });
      }
    }
    // The id is echoed so a caller that did not name its own job still learns the handle it can
    // use afterwards, without having to dig it out of the resource evidence.
    return { ...result, jobId: job.jobId };
  } catch (error) {
    if (isPairedOutputReceiptDestinationError(error)) {
      const failure = pairedOutputReceiptDestinationErrorFields(error);
      await job.failed({ error: { code: jobErrorCode(failure.code), message: failure.message } });
      return {
        ok: false,
        command: "render",
        lane: scope.lane,
        outputPath: error.outputPath,
        receiptPath: error.receiptPath,
        error: failure,
        jobId: job.jobId
      };
    }
    await job.failed({
      error: { code: jobErrorCode(undefined), message: error instanceof Error ? error.message : "Motion render threw." }
    });
    throw error;
  }
}

function asError(value: unknown): { code?: string; message?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {})
  };
}

/**
 * The contract's error codes are a closed set; anything outside it is an argument problem.
 *
 * Derived from the authored contract rather than restated here, so a code added to
 * schemas/job-status.json cannot silently fail to be recognised.
 */
const JOB_ERROR_CODES: ReadonlySet<string> = new Set(JOB_STATUS_CONTRACT.errorCodes.map((entry) => entry.code));

function jobErrorCode(code: string | undefined): JobErrorCode {
  return code && JOB_ERROR_CODES.has(code) ? code as JobErrorCode : "invalid_args";
}
