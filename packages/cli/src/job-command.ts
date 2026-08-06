/**
 * `shellx-motion job` — asking what work is doing, from a process that did not start it.
 *
 * Role: a host such as ShellX Cut spawns Motion as a child process for a render that takes minutes.
 * It needs to answer "is it queued, running, or done" for a progress display, and it must be able
 * to ask from a *different* process than the one rendering. That is the whole reason job state
 * lives in a per-user directory rather than in the rendering process's memory.
 *
 * How a host uses this, end to end:
 *   1. Choose an id it can remember:      `shellx-motion render --job-id cut:render-42 --caller-id cut:workspace-7 …`
 *   2. Poll from anywhere, immediately:   `shellx-motion job get cut:render-42 --caller-id cut:workspace-7`
 *   3. Read the outcome after it exits:   the same command; terminal records outlive the render.
 *
 * Supplying the id is what makes this work without any asynchronous submission machinery: the host
 * knows the handle before the child process even starts, which is earlier than a non-blocking
 * submit could return one.
 *
 * `--caller-id` is not decoration. Visibility is per-owner, so a query with a different caller id
 * than the render used will correctly refuse to show it. Use one stable value per workspace.
 *
 * Dependencies: `@shellx-motion/core` (MotionJobView). Primary caller: `main.ts` command dispatch.
 */
import { MotionJobView, type MotionJobStatus } from "@shellx-motion/core";
import { resolveCallerId } from "./caller-identity";

export interface JobCommandOptions {
  callerId?: string;
  /** Test seam; production always reads the per-user lease and record directories. */
  jobView?: MotionJobView;
  /** Test seam for the cross-caller grant; production reads `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Operator grant for `--scope all`, the CLI's counterpart to the debug server's
 * `crossCallerJobScope`.
 *
 * Cross-caller visibility is one capability with two transports, and it was enforced on only one of
 * them: the debug API refused `scope: "all"` without a host grant while the CLI honoured it for
 * anyone who typed it. An agent embedded in one host could therefore enumerate every other host's
 * job ids, operations and receipt paths by shelling out — the exact boundary `job-lease.ts`
 * documents. It is an environment variable rather than a flag on purpose: a host that spawns Motion
 * controls the child's environment, so the grant is made by whoever launched the agent rather than
 * by the agent composing a longer command line.
 */
const CROSS_CALLER_SCOPE_ENV = "SHELLX_MOTION_JOB_CROSS_CALLER_SCOPE";

type JobCommandResult = Record<string, unknown> & { ok: boolean; command?: string };

/** `shellx-motion job <get|list>` */
export async function jobCommand(argv: string[], options: JobCommandOptions = {}): Promise<JobCommandResult> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "get" && subcommand !== "list") {
    return failure("invalid_args", "shellx-motion job requires a subcommand: get or list.", "Run `shellx-motion job list` to see this caller's jobs, or `shellx-motion job get <jobId>`.");
  }
  const scope = readScope(rest);
  if (scope === false) {
    return failure("invalid_args", "shellx-motion job --scope must be \"own\" or \"all\".", "Omit --scope to see this caller's jobs.");
  }
  if (scope === "all" && (options.env ?? process.env)[CROSS_CALLER_SCOPE_ENV] !== "1") {
    return failure(
      "permission_denied",
      "shellx-motion job --scope all requires a host that granted cross-caller job visibility.",
      `Omit --scope to see this caller's jobs, or ask the host operator to set ${CROSS_CALLER_SCOPE_ENV}=1.`
    );
  }
  // The same identity rule the render used. A mismatch here is the most likely reason a host sees
  // job_not_visible for a job it genuinely started, so it is named in the result on failure.
  const callerId = resolveCallerId(rest, options) ?? "unattributed";
  const view = options.jobView ?? new MotionJobView();

  if (subcommand === "list") {
    const limit = readLimit(rest);
    if (limit === false) return failure("invalid_args", "shellx-motion job list --limit must be a positive integer.", "Omit --limit for every retained job.");
    const jobs = await view.list({ callerId, scope, ...(limit === null ? {} : { limit }) });
    return {
      ok: true,
      command: "job.list",
      callerId,
      scope,
      jobCount: jobs.length,
      inFlightCount: jobs.filter((job) => job.lifecycle !== "ended").length,
      stateCounts: stateCounts(jobs),
      jobs
    };
  }

  const jobId = rest.find((entry) => !entry.startsWith("--") && !isFlagValue(rest, entry));
  if (!jobId) {
    return failure("invalid_args", "shellx-motion job get requires a jobId.", "Pass the id you gave `shellx-motion render --job-id`, or the jobId from the render result.");
  }
  const answer = await view.get({ jobId, callerId, scope });
  if (!answer.ok) {
    return {
      ...failure(answer.code, `Motion job ${jobId} could not be read: ${answer.code}.`, suggestionFor(answer.code, callerId)),
      command: "job.get",
      jobId,
      callerId
    };
  }
  return { ok: true, command: "job.get", jobId, callerId, job: answer.job };
}

/** Every contract state, always present, so a caller reads a zero rather than a missing key. */
function stateCounts(jobs: MotionJobStatus[]): Record<string, number> {
  const counts: Record<string, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  return counts;
}

function suggestionFor(code: string, callerId: string): string {
  if (code === "job_not_visible") {
    // Overwhelmingly the cause: the render ran under one caller id and the query used another.
    return `This job belongs to another caller. Re-run with the --caller-id the render used; this query used "${callerId}".`;
  }
  if (code === "job_expired") return "The job ran but its record has aged out of retention. Look for its receipt with `shellx-motion debug motion.receipts.list`.";
  return "Re-read the jobId from the render result, or list this caller's jobs with `shellx-motion job list`.";
}

/** `false` distinguishes a rejected value from an omitted one, so the error can say which. */
function readScope(argv: string[]): "own" | "all" | false {
  const index = argv.indexOf("--scope");
  if (index < 0) return "own";
  const value = argv[index + 1];
  return value === "own" || value === "all" ? value : false;
}

function readLimit(argv: string[]): number | null | false {
  const index = argv.indexOf("--limit");
  if (index < 0) return null;
  const value = Number(argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : false;
}

/** True when this token is the value of a preceding flag rather than a positional argument. */
function isFlagValue(argv: string[], token: string): boolean {
  const index = argv.indexOf(token);
  return index > 0 && argv[index - 1].startsWith("--");
}

function failure(code: string, message: string, suggestedAction: string): JobCommandResult {
  return { ok: false, error: { code, message, suggestedAction } };
}
